/**
 * The interpreter: the same controller, against real adapters.
 *
 * Every piece of work is written to the journal before it starts and again
 * when it ends. The controller's knowledge is a fold over that journal, so a
 * process that dies anywhere resumes by reading it back. Work that was begun
 * and never ended is treated as "may have happened", which is the one honest
 * reading of a crash.
 */
import {
  bits,
  type Ceremony,
  type Compiled,
  type CompiledOperator,
  type FactDecl,
  type Facts,
  type InterfaceSpec,
  type OperatorDecl,
  type Operators,
  type OutcomeDecl,
} from "./ceremony.js";
import {
  absorb,
  begin,
  decide,
  DEFECT,
  DEFECT_TAG,
  freshMind,
  type Failure,
  type Mind,
} from "./policy.js";

export type FactValue<D> = D extends FactDecl<infer V, boolean> ? V : never;

export type ObservableFacts<F extends Facts> = {
  [K in keyof F]: F[K] extends FactDecl<any, true> ? K : never;
}[keyof F] &
  string;

export type OperatorsBy<O extends Operators, A extends "machine" | "human"> = {
  [K in keyof O]: O[K] extends OperatorDecl<
    string,
    string,
    Record<string, OutcomeDecl>,
    A
  >
    ? K
    : never;
}[keyof O] &
  string;

export type ValuesOf<F extends Facts, K extends string> = {
  readonly [P in K & keyof F]: FactValue<F[P]>;
};

export type ProbeResult<V> =
  { readonly held: true; readonly value: V } | { readonly held: false };

/** What an adapter may return: exactly the outcomes its operator declares. */
export type ActResult<F extends Facts, Op> =
  Op extends OperatorDecl<infer Est, string, infer Out, "machine" | "human">
    ? {
        [Tag in keyof Out & string]: Out[Tag] extends OutcomeDecl<{
          readonly kind: "established";
        }>
          ? { readonly outcome: Tag; readonly values: ValuesOf<F, Est> }
          : { readonly outcome: Tag };
      }[keyof Out & string]
    : never;

export interface ProbeContext {
  /** A stored value for any fact, unverified. */
  read(fact: string): Promise<unknown>;
}

export interface ActContext<F extends Facts, Op> {
  readonly values: Op extends OperatorDecl<string, infer Req, any, any>
    ? ValuesOf<F, Req>
    : never;
  readonly attempt: number;
  /** Stable across retries of one establishment, for upstream de-duplication. */
  readonly idempotencyKey: string;
}

export interface Adapters<F extends Facts, O extends Operators> {
  readonly probes: {
    readonly [K in ObservableFacts<F>]: (
      context: ProbeContext,
    ) => Promise<ProbeResult<FactValue<F[K]>>>;
  };
  readonly operators: {
    readonly [K in OperatorsBy<O, "machine">]: (
      context: ActContext<F, O[K]>,
    ) => Promise<ActResult<F, O[K]>>;
  };
}

export type JournalWork =
  | { readonly kind: "probe"; readonly fact: string }
  | {
      readonly kind: "act";
      readonly operator: string;
      readonly attempt: number;
    };

export type JournalResult =
  | {
      readonly kind: "probe";
      readonly fact: string;
      readonly result: "held" | "absent" | "error";
    }
  | {
      readonly kind: "act";
      readonly operator: string;
      readonly outcome: string;
    }
  /** A fact the controller believed it held, whose value is not in the vault. */
  | { readonly kind: "lost"; readonly fact: string };

/** Names and tags only. No fact value is ever written here. */
export type JournalEntry =
  | { readonly seq: number; readonly kind: "begin"; readonly work: JournalWork }
  | {
      readonly seq: number;
      readonly kind: "end";
      readonly result: JournalResult;
    };

export class JournalConflict extends Error {
  constructor(expected: number, actual: number) {
    super(`journal is at ${actual}, writer expected ${expected}`);
    this.name = "JournalConflict";
  }
}

export interface Journal {
  read(): Promise<readonly JournalEntry[]>;
  /** Must reject with JournalConflict unless `entry.seq` is the next index. */
  append(entry: JournalEntry): Promise<void>;
}

export interface Vault {
  get(fact: string): Promise<unknown>;
  put(fact: string, value: unknown): Promise<void>;
  delete(fact: string): Promise<void>;
}

export function memoryJournal(entries: JournalEntry[] = []): Journal {
  return {
    read: async () => entries.slice(),
    append: async (entry) => {
      if (entry.seq !== entries.length) {
        throw new JournalConflict(entry.seq, entries.length);
      }
      entries.push(entry);
    },
  };
}

export function memoryVault(values = new Map<string, unknown>()): Vault {
  return {
    get: async (fact) => values.get(fact),
    put: async (fact, value) => {
      values.set(fact, value);
    },
    delete: async (fact) => {
      values.delete(fact);
    },
  };
}

export interface InterfaceRequest {
  readonly requestId: string;
  readonly operator: string;
  readonly attempt: number;
  readonly interface: InterfaceSpec;
  /** Values of the non-secret facts the interface shows. */
  readonly shows: Readonly<Record<string, unknown>>;
}

export interface HumanAnswer {
  readonly requestId: string;
  readonly outcome: string;
  /** For an establishing outcome: one value per established fact. */
  readonly values?: Readonly<Record<string, unknown>>;
}

export type RunStatus =
  | { readonly status: "success"; readonly leftBehind: readonly string[] }
  | {
      readonly status: "failed";
      readonly failure: Failure;
      readonly leftBehind: readonly string[];
    }
  | { readonly status: "awaiting"; readonly request: InterfaceRequest };

export interface RunDeps<F extends Facts, O extends Operators> {
  readonly runId: string;
  readonly adapters: Adapters<F, O>;
  readonly journal: Journal;
  readonly vault: Vault;
}

function toObservation(
  compiled: Compiled,
  result: JournalResult,
): Parameters<typeof absorb>[2] {
  if (result.kind === "probe") {
    return {
      kind: "probe",
      fact: compiled.factIndex.get(result.fact) as number,
      result: result.result,
    };
  }
  if (result.kind === "lost") {
    return {
      kind: "lost",
      fact: compiled.factIndex.get(result.fact) as number,
    };
  }
  const op = compiled.operators[
    compiled.operatorIndex.get(result.operator) as number
  ] as CompiledOperator;
  return {
    kind: "act",
    op: op.index,
    outcome: op.outcomeIndex.get(result.outcome) ?? DEFECT,
  };
}

/** The controller's knowledge, rebuilt from the journal alone. */
export function replay(
  compiled: Compiled,
  entries: readonly JournalEntry[],
): Mind {
  let mind = freshMind(compiled);
  for (const entry of entries) {
    if (entry.kind === "end") {
      mind = absorb(compiled, mind, toObservation(compiled, entry.result));
    } else if (entry.work.kind === "probe") {
      mind = begin(mind, {
        kind: "probe",
        fact: compiled.factIndex.get(entry.work.fact) as number,
      });
    } else {
      mind = begin(mind, {
        kind: "act",
        op: compiled.operatorIndex.get(entry.work.operator) as number,
        attempt: entry.work.attempt,
      });
    }
  }
  return mind;
}

function leftBehind(compiled: Compiled, mind: Mind): string[] {
  return bits(mind.residue).map(
    (index) => (compiled.operators[index] as CompiledOperator).id,
  );
}

/**
 * Drive the ceremony until it ends or needs a person. Call again with the
 * person's answer, or with nothing after a crash; both are the same call.
 */
export async function advance<F extends Facts, O extends Operators>(
  ceremony: Ceremony<F, O>,
  deps: RunDeps<F, O>,
  answer?: HumanAnswer,
): Promise<RunStatus> {
  const compiled = ceremony.compiled;
  const entries = (await deps.journal.read()).slice();
  let mind = replay(compiled, entries);
  const factName = (index: number): string =>
    compiled.factNames[index] as string;
  const operatorAt = (index: number): CompiledOperator =>
    compiled.operators[index] as CompiledOperator;

  const write = async (
    entry:
      | { kind: "begin"; work: JournalWork }
      | { kind: "end"; result: JournalResult },
  ): Promise<void> => {
    const full = { seq: entries.length, ...entry } as JournalEntry;
    await deps.journal.append(full);
    entries.push(full);
    mind =
      full.kind === "end"
        ? absorb(compiled, mind, toObservation(compiled, full.result))
        : replay(compiled, entries);
  };

  /**
   * Values are staged under the attempt before the result is journaled and
   * promoted after it. The journal entry is the commit point: a crash on
   * either side of it leaves enough to finish the job on the next call.
   */
  const stageKey = (op: CompiledOperator, opened: number): string =>
    `#staged:${op.id}:${opened}`;

  const promote = async (
    op: CompiledOperator,
    opened: number,
  ): Promise<void> => {
    const staged = (await deps.vault.get(stageKey(op, opened))) as
      { readonly values: Readonly<Record<string, unknown>> } | undefined;
    if (staged === undefined) return;
    for (const f of bits(op.establishes)) {
      await deps.vault.put(factName(f), staged.values[factName(f)]);
    }
    for (const f of bits(op.consumes)) {
      await deps.vault.delete(factName(f));
    }
    await deps.vault.delete(stageKey(op, opened));
  };

  /** `opened` is the journal position of the work's begin entry. */
  const settle = async (
    op: CompiledOperator,
    opened: number,
    outcome: string,
    values: Readonly<Record<string, unknown>> | undefined,
  ): Promise<void> => {
    const index = op.outcomeIndex.get(outcome);
    let tag = index === undefined ? DEFECT_TAG : outcome;
    if (index !== undefined && op.outcomes[index]?.kind === "established") {
      const established = bits(op.establishes).map(factName);
      if (established.some((name) => values?.[name] === undefined)) {
        tag = DEFECT_TAG;
      } else {
        await deps.vault.put(stageKey(op, opened), { outcome: tag, values });
      }
    }
    await write({
      kind: "end",
      result: { kind: "act", operator: op.id, outcome: tag },
    });
    await promote(op, opened);
  };

  /**
   * A request is identified by where it was opened in the journal, so an
   * answer to an earlier asking of the same question can never be taken for
   * an answer to this one.
   */
  const request = async (
    op: CompiledOperator,
    attempt: number,
    opened: number,
  ): Promise<InterfaceRequest> => {
    const spec = (ceremony.operators[op.id] as OperatorDecl)
      .interface as InterfaceSpec;
    const shows: Record<string, unknown> = {};
    for (const name of spec.shows ?? []) {
      shows[name] = await deps.vault.get(name);
    }
    return {
      requestId: `${deps.runId}:${op.id}:${opened}`,
      operator: op.id,
      attempt,
      interface: spec,
      shows,
    };
  };

  const probe = async (fact: number): Promise<void> => {
    const name = factName(fact);
    await write({ kind: "begin", work: { kind: "probe", fact: name } });
    let result: "held" | "absent" | "error";
    try {
      const adapter = (
        deps.adapters.probes as Record<
          string,
          (context: ProbeContext) => Promise<ProbeResult<unknown>>
        >
      )[name];
      if (adapter === undefined) throw new Error(`no probe for "${name}"`);
      const seen = await adapter({ read: (other) => deps.vault.get(other) });
      if (seen.held) {
        await deps.vault.put(name, seen.value);
        result = "held";
      } else {
        for (const f of bits(compiled.above[fact] as number)) {
          await deps.vault.delete(factName(f));
        }
        result = "absent";
      }
    } catch {
      result = "error";
    }
    await write({ kind: "end", result: { kind: "probe", fact: name, result } });
  };

  /**
   * Believing a fact is not holding its value. Before anything reads values,
   * each one must be in the vault; a missing one is fetched by its probe or,
   * where no probe exists, recorded as lost. False means beliefs changed.
   */
  const inCustody = async (needed: readonly string[]): Promise<boolean> => {
    for (const name of needed) {
      if ((await deps.vault.get(name)) !== undefined) continue;
      const fact = compiled.factIndex.get(name) as number;
      if ((compiled.observable & (1 << fact)) === 0) {
        await write({ kind: "end", result: { kind: "lost", fact: name } });
        return false;
      }
      await probe(fact);
      if ((await deps.vault.get(name)) === undefined) return false;
    }
    return true;
  };

  // A crash after the commit point and before promotion: finish promoting.
  const last = entries[entries.length - 1];
  const opened = entries[entries.length - 2];
  if (
    last?.kind === "end" &&
    last.result.kind === "act" &&
    opened?.kind === "begin" &&
    opened.work.kind === "act"
  ) {
    await promote(
      operatorAt(compiled.operatorIndex.get(last.result.operator) as number),
      entries.length - 2,
    );
  }

  if (mind.pending !== null) {
    const pending = mind.pending;
    if (pending.kind === "probe") {
      await write({
        kind: "end",
        result: {
          kind: "probe",
          fact: factName(pending.fact),
          result: "error",
        },
      });
    } else {
      const op = operatorAt(pending.op);
      const at = entries.length - 1;
      const staged = (await deps.vault.get(stageKey(op, at))) as
        { readonly outcome: string } | undefined;
      if (staged !== undefined) {
        // The work finished and the process died before saying so.
        await write({
          kind: "end",
          result: { kind: "act", operator: op.id, outcome: staged.outcome },
        });
        await promote(op, at);
      } else if (op.human) {
        const open = await request(op, pending.attempt, at);
        if (answer === undefined || answer.requestId !== open.requestId) {
          return { status: "awaiting", request: open };
        }
        await settle(op, at, answer.outcome, answer.values);
      } else {
        await settle(op, at, DEFECT_TAG, undefined);
      }
    }
  }

  for (;;) {
    const command = decide(compiled, mind);
    if (command.kind === "succeed") {
      if (!(await inCustody(bits(compiled.goal).map(factName)))) continue;
      return { status: "success", leftBehind: leftBehind(compiled, mind) };
    }
    if (command.kind === "fail") {
      return {
        status: "failed",
        failure: command.failure,
        leftBehind: leftBehind(compiled, mind),
      };
    }
    if (command.kind === "probe") {
      await probe(command.fact);
      continue;
    }

    const op = operatorAt(command.op);
    const declared = ceremony.operators[op.id] as OperatorDecl;
    const reads = op.human
      ? (declared.interface?.shows ?? [])
      : declared.requires;
    if (!(await inCustody(reads))) continue;
    const at = entries.length;
    await write({
      kind: "begin",
      work: { kind: "act", operator: op.id, attempt: command.attempt },
    });
    if (op.human) {
      return {
        status: "awaiting",
        request: await request(op, command.attempt, at),
      };
    }
    let outcome = DEFECT_TAG;
    let values: Readonly<Record<string, unknown>> | undefined;
    try {
      const adapter = (
        deps.adapters.operators as Record<
          string,
          (context: unknown) => Promise<{
            outcome: string;
            values?: Readonly<Record<string, unknown>>;
          }>
        >
      )[op.id];
      if (adapter === undefined) throw new Error(`no adapter for "${op.id}"`);
      const held: Record<string, unknown> = {};
      for (const required of declared.requires) {
        held[required] = await deps.vault.get(required);
      }
      const successes = entries.filter(
        (entry) =>
          entry.kind === "end" &&
          entry.result.kind === "act" &&
          entry.result.operator === op.id &&
          op.outcomes[op.outcomeIndex.get(entry.result.outcome) ?? -1]?.kind ===
            "established",
      ).length;
      const returned = await adapter({
        values: held,
        attempt: command.attempt,
        idempotencyKey: `${deps.runId}:${op.id}:${successes}`,
      });
      outcome = returned.outcome;
      values = returned.values;
    } catch {
      outcome = DEFECT_TAG;
    }
    await settle(op, at, outcome, values);
  }
}
