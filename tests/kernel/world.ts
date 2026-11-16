import assert from "node:assert/strict";
import {
  advance,
  bits,
  decide,
  memoryVault,
  replay,
  JournalConflict,
  type Ceremony,
  type CompiledOperator,
  type HumanAnswer,
  type Journal,
  type JournalEntry,
  type RunStatus,
} from "../../src/kernel/index.js";

class Crash extends Error {}

/**
 * A world that answers the interpreter the way the declarations allow, with
 * every choice taken from a script: which outcome an operator reports, whether
 * a reply is lost, when the environment removes a fact, when the process dies.
 */
export class World {
  readonly held = new Set<string>();
  /** Removed by the environment since the interpreter last saw it. */
  readonly stale = new Set<string>();
  readonly entries: JournalEntry[] = [];
  readonly values = new Map<string, unknown>();
  readonly vault = memoryVault(this.values);
  readonly orphans = new Set<string>();
  readonly problems: string[] = [];
  private cursor = 0;
  private removals = 2;
  private serial = 0;

  constructor(
    readonly ceremony: Ceremony,
    private readonly script: readonly number[],
    start: readonly string[],
  ) {
    for (const name of start) {
      this.held.add(name);
      this.values.set(name, this.value(name));
    }
  }

  private next(bound: number): number {
    const value = this.script[this.cursor % this.script.length] as number;
    this.cursor += 1;
    return value % bound;
  }

  private mask(): number {
    const compiled = this.ceremony.compiled;
    let mask = 0;
    for (const name of this.held) {
      mask |= 1 << (compiled.factIndex.get(name) as number);
    }
    return mask;
  }

  private remove(mask: number): string[] {
    const compiled = this.ceremony.compiled;
    const gone: string[] = [];
    for (const f of bits(mask)) {
      const name = compiled.factNames[f] as string;
      if (this.held.delete(name)) gone.push(name);
    }
    return gone;
  }

  private disturb(): void {
    const compiled = this.ceremony.compiled;
    if (this.removals === 0 || this.next(6) !== 0) return;
    const candidates = bits(this.mask() & compiled.volatile);
    if (candidates.length === 0) return;
    const victim = candidates[this.next(candidates.length)] as number;
    this.removals -= 1;
    for (const name of this.remove(compiled.above[victim] as number)) {
      this.stale.add(name);
    }
  }

  private value(name: string): string {
    this.serial += 1;
    return `value:${name}:${this.serial}`;
  }

  private effect(op: CompiledOperator, replyLost: boolean): void {
    const compiled = this.ceremony.compiled;
    const all = (this.mask() & op.establishes) === op.establishes;
    if (!op.idempotent && all) {
      this.problems.push(`${op.id} landed on top of itself`);
    }
    const spent = this.remove(op.consumes);
    let gained = op.establishes;
    if (replyLost) {
      // Spent behind a lost reply: gone without the interpreter seeing it.
      for (const name of spent) this.stale.add(name);
      // What lived only in the reply is held by nobody, nor is what rests on it.
      for (const f of bits(op.establishes & ~compiled.discoverable)) {
        gained &= ~(compiled.above[f] as number);
      }
      if (op.leavesResidue) this.orphans.add(op.id);
    }
    for (const f of bits(gained)) {
      const name = compiled.factNames[f] as string;
      this.held.add(name);
      this.stale.delete(name);
    }
  }

  /** One outcome the declarations allow in the current world. */
  private outcome(op: CompiledOperator): {
    readonly outcome: string;
    readonly values?: Record<string, unknown>;
    readonly lost?: boolean;
  } {
    const compiled = this.ceremony.compiled;
    this.disturb();
    const world = this.mask();
    const ready = (world & op.requires) === op.requires;
    const truthful = op.outcomes.filter((outcome) =>
      outcome.kind === "established"
        ? ready
        : outcome.kind === "invalidates"
          ? (outcome.facts & ~world) !== 0
          : false,
    );
    const others = op.outcomes.filter(
      (outcome) =>
        outcome.kind !== "established" && outcome.kind !== "invalidates",
    );
    const cooperate = truthful.length > 0 && this.next(4) !== 0;
    if (!cooperate && this.next(3) === 0) {
      const happened = ready && this.next(2) === 0;
      if (happened) this.effect(op, true);
      return { outcome: "", lost: true };
    }
    const pool = cooperate || others.length === 0 ? truthful : others;
    if (pool.length === 0) return { outcome: "", lost: true };
    const chosen = pool[this.next(pool.length)] as (typeof pool)[number];
    if (chosen.kind === "unsure" && ready && this.next(2) === 0) {
      this.effect(op, true);
    }
    if (chosen.kind !== "established") return { outcome: chosen.tag };
    this.effect(op, false);
    const values: Record<string, unknown> = {};
    for (const f of bits(op.establishes)) {
      const name = compiled.factNames[f] as string;
      values[name] = this.value(name);
    }
    return { outcome: chosen.tag, values };
  }

  readonly journal: Journal = {
    read: async () => this.entries.slice(),
    append: async (entry) => {
      if (entry.seq !== this.entries.length) {
        throw new JournalConflict(entry.seq, this.entries.length);
      }
      const dice = this.next(12);
      if (dice === 0) throw new Crash("died before the write");
      this.entries.push(entry);
      if (dice === 1) throw new Crash("died after the write");
    },
  };

  readonly adapters = {
    probes: new Proxy(
      {},
      {
        get:
          (_, name: string) =>
          async (context: { read(fact: string): Promise<unknown> }) => {
            const compiled = this.ceremony.compiled;
            this.disturb();
            if (this.next(8) === 0) throw new Error("probe failed");
            this.stale.delete(name);
            if (!this.held.has(name)) return { held: false };
            const fact = compiled.factIndex.get(name) as number;
            if ((compiled.discoverable & (1 << fact)) !== 0) {
              return { held: true, value: this.value(name) };
            }
            // Not findable from nothing: only what is stored can be confirmed.
            const stored = await context.read(name);
            if (stored === undefined) {
              this.problems.push(`${name} holds with no stored value`);
              return { held: false };
            }
            return { held: true, value: stored };
          },
      },
    ),
    operators: new Proxy(
      {},
      {
        get:
          (_, id: string) =>
          async (context: { values: Record<string, unknown> }) => {
            const compiled = this.ceremony.compiled;
            const op = compiled.operators[
              compiled.operatorIndex.get(id) as number
            ] as CompiledOperator;
            for (const [name, value] of Object.entries(context.values)) {
              if (value === undefined) {
                this.problems.push(`${id} ran without a value for ${name}`);
              }
            }
            const result = this.outcome(op);
            if (result.lost) throw new Error("reply lost");
            return result;
          },
      },
    ),
  };

  answer(status: Extract<RunStatus, { status: "awaiting" }>): HumanAnswer {
    const compiled = this.ceremony.compiled;
    const op = compiled.operators[
      compiled.operatorIndex.get(status.request.operator) as number
    ] as CompiledOperator;
    if (this.next(6) === 0) {
      return { requestId: "someone-else's", outcome: "ok" };
    }
    const result = this.outcome(op);
    return {
      requestId: status.request.requestId,
      outcome: result.lost ? "not-a-declared-outcome" : result.outcome,
      ...(result.values ? { values: result.values } : {}),
    };
  }
}

type Ended = Exclude<RunStatus, { status: "awaiting" }>;

export const tally = {
  success: 0,
  failed: 0,
  crashes: 0,
  orphans: 0,
  awaited: 0,
};

async function drive(world: World): Promise<Ended> {
  const deps = {
    runId: "run",
    adapters: world.adapters as never,
    journal: world.journal,
    vault: world.vault,
  };
  let answer: HumanAnswer | undefined;
  for (let turn = 0; turn < 2_000; turn += 1) {
    let status: RunStatus;
    try {
      status = await advance(world.ceremony, deps, answer);
    } catch (error) {
      if (!(error instanceof Crash)) throw error;
      tally.crashes += 1;
      continue;
    }
    if (status.status !== "awaiting") {
      tally[status.status] += 1;
      tally.orphans += world.orphans.size;
      return status;
    }
    tally.awaited += 1;
    answer = world.answer(status);
  }
  throw new Error("the run did not end");
}

export async function runAndCheck(
  ceremony: Ceremony,
  script: readonly number[],
  start: readonly string[],
): Promise<void> {
  const compiled = ceremony.compiled;
  const world = new World(ceremony, script, start);
  const status = await drive(world);

  assert.deepEqual(world.problems, []);
  if (status.status === "success") {
    for (const f of bits(compiled.goal)) {
      const name = compiled.factNames[f] as string;
      assert.ok(
        world.held.has(name) || world.stale.has(name),
        `success without ${name}`,
      );
      assert.notEqual(world.values.get(name), undefined);
    }
  }
  for (const orphan of world.orphans) {
    assert.ok(
      status.leftBehind.includes(orphan),
      `${orphan} may have left something behind and the run does not say so`,
    );
  }

  world.entries.forEach((entry, index) => assert.equal(entry.seq, index));
  for (let i = 1; i < world.entries.length; i += 1) {
    const previous = world.entries[i - 1] as JournalEntry;
    const current = world.entries[i] as JournalEntry;
    assert.ok(
      previous.kind !== "begin" ||
        (current.kind === "end" && current.result.kind !== "lost"),
      "work was begun and something else was written before it ended",
    );
  }
  assert.ok(
    !JSON.stringify(world.entries).includes("value:"),
    "a fact value reached the journal",
  );
  const ending = decide(compiled, replay(compiled, world.entries));
  assert.equal(
    ending.kind,
    status.status === "success" ? "succeed" : "fail",
    "the journal alone does not reproduce the ending",
  );
}
