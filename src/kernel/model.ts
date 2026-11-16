/**
 * Explicit-state model checker for a ceremony.
 *
 * The controller under test is the real one: `decide` and `absorb` from
 * policy.ts. Only the world is a model, and its contract is exactly what the
 * declarations say: which facts exist, which the environment can take away,
 * and which outcomes each operator can report. The checker plays every
 * environment that contract allows against the controller and checks the
 * properties below on every state it reaches.
 */
import {
  bits,
  names,
  type Ceremony,
  type Compiled,
  type CompiledOperator,
  type CompiledOutcome,
} from "./ceremony.js";
import { plan } from "./plan.js";
import {
  absorb,
  decide,
  DEFECT,
  DEFECT_TAG,
  freshMind,
  mindKey,
  rank,
  type Command,
  type Failure,
  type Mind,
} from "./policy.js";

export type Property =
  /** Every controller step lowers the ranking measure, so every run ends. */
  | "terminates"
  /** What the controller believes is true, or was until the world changed it. */
  | "belief-sound"
  /** An operator only runs when the controller holds all it requires. */
  | "precondition"
  /** Success is only declared with every goal fact held. */
  | "success-sound"
  /** A non-idempotent effect never lands on top of itself. */
  | "no-duplicate-effect"
  /** Anything the run may have left behind is reported. */
  | "residue-accounted"
  /** While probes alone could still find a way, a cooperating world reaches success. */
  | "recoverable";

export interface Violation {
  readonly property: Property;
  readonly message: string;
  /** Shortest run that shows it, one line per step. */
  readonly trace: readonly string[];
}

export interface Ending {
  readonly status: "success" | "failed";
  /** Stable identifier of the failure, or "success". */
  readonly key: string;
  readonly failure: Failure | null;
  readonly count: number;
  /** Shortest run that reaches this ending. */
  readonly trace: readonly string[];
}

export interface CheckOptions {
  /** Facts the environment may take away during one run. Default 1. */
  readonly invalidations?: number;
  /** Faults after which a cooperating world must still reach success. Default 1. */
  readonly faults?: number;
  /**
   * Cap on each operator's attempts and on the probe budget while checking.
   * The properties do not depend on the size of a budget, only on it running
   * out, so a small one covers the same branches in far fewer states. Default 2.
   */
  readonly attempts?: number;
  /**
   * Explore only runs in which at most this many things go wrong. Default:
   * no limit. A large ceremony that cannot be explored without one is checked
   * against every combination of up to this many faults instead, and the
   * result says so.
   */
  readonly faultDepth?: number;
  /** Stop after this many states and report an incomplete check. */
  readonly maxStates?: number;
  /** Starting worlds, as fact-name lists. Default: every world a run can start in. */
  readonly worlds?: readonly (readonly string[])[];
  /** The controller to check. Default: the kernel's own. */
  readonly controller?: Controller;
}

/** The two functions a controller is. Tests swap in broken ones to see each property fail. */
export interface Controller {
  readonly decide: typeof decide;
  readonly absorb: typeof absorb;
}

export const kernelController: Controller = { decide, absorb };

export interface CheckResult {
  readonly ceremony: string;
  /** False when `maxStates` was reached; nothing is proven then. */
  readonly complete: boolean;
  readonly states: number;
  readonly transitions: number;
  readonly initialWorlds: number;
  readonly bounds: {
    readonly invalidations: number;
    readonly faults: number;
    readonly attempts: number;
    /** Faults per run explored; null when every run was explored. */
    readonly faultDepth: number | null;
  };
  readonly violations: readonly Violation[];
  readonly endings: readonly Ending[];
  readonly operatorsUsed: readonly string[];
  readonly operatorsUnused: readonly string[];
  /** Declared outcomes no run produced: dead branches of the declaration. */
  readonly outcomesUnseen: readonly string[];
}

interface Config {
  readonly world: number;
  /** Facts the environment removed since the controller last saw them. */
  readonly stale: number;
  /** Operators whose effect left something nobody holds. */
  readonly residue: number;
  readonly invalidations: number;
  readonly mind: Mind;
}

interface Successor {
  readonly label: string;
  readonly config: Config;
  /** The step is something going wrong that a run should survive. */
  readonly fault: boolean;
  /** Declared outcome tag this step exercised, as "operator.tag". */
  readonly exercised?: string;
  readonly duplicate?: string;
}

function configKey(config: Config): string {
  return `${config.world},${config.stale},${config.residue},${config.invalidations}/${mindKey(config.mind)}`;
}

function show(compiled: Compiled, mask: number): string {
  return `{${names(compiled, mask).join(", ")}}`;
}

/**
 * Every world a run can start in: any set of facts in which nothing holds
 * without what it requires. Facts no probe can check exist only as custody,
 * so a run starts already believing the ones that hold.
 */
export function startingWorlds(compiled: Compiled): number[] {
  const order = compiled.factNames
    .map((_, index) => index)
    .sort(
      (a, b) =>
        bits(compiled.below[a] as number).length -
        bits(compiled.below[b] as number).length,
    );
  const out: number[] = [];
  const walk = (at: number, world: number): void => {
    if (at === order.length) {
      out.push(world);
      return;
    }
    const f = order[at] as number;
    walk(at + 1, world);
    const needs = (compiled.below[f] as number) & ~(1 << f);
    if ((world & needs) === needs) walk(at + 1, world | (1 << f));
  };
  walk(0, 0);
  return out;
}

function startingMind(
  ctl: Controller,
  compiled: Compiled,
  world: number,
): Mind {
  return ctl.absorb(compiled, freshMind(compiled), {
    kind: "custody",
    facts: world,
  });
}

function applyToWorld(
  compiled: Compiled,
  config: Config,
  op: CompiledOperator,
  replyLost: boolean,
): { readonly config: Config; readonly duplicate: boolean } {
  const duplicate =
    !op.idempotent && (config.world & op.establishes) === op.establishes;
  const withoutConsumed = config.world & ~op.consumes;
  // A value that lived only in the lost reply is held by nobody, and neither
  // is anything that rests on it.
  let gained = op.establishes;
  let residue = config.residue;
  // Inputs spent behind a lost reply were removed without the controller seeing it.
  let stale = config.stale;
  if (replyLost) {
    stale |= config.world & op.consumes;
    let gone = 0;
    for (const f of bits(op.establishes & ~compiled.discoverable)) {
      gone |= compiled.above[f] as number;
    }
    gained &= ~gone;
    if (op.leavesResidue) residue |= 1 << op.index;
  }
  return {
    duplicate,
    config: {
      ...config,
      world: withoutConsumed | gained,
      stale: stale & ~gained,
      residue,
    },
  };
}

function successors(
  ctl: Controller,
  compiled: Compiled,
  config: Config,
  command: Command,
): Successor[] {
  const out: Successor[] = [];
  if (config.invalidations > 0) {
    for (const v of bits(config.world & compiled.volatile)) {
      const lost = (compiled.above[v] as number) & config.world;
      out.push({
        label: `the environment removes ${compiled.factNames[v]}`,
        fault: true,
        config: {
          ...config,
          world: config.world & ~lost,
          stale: config.stale | lost,
          invalidations: config.invalidations - 1,
        },
      });
    }
  }
  if (command.kind === "probe") {
    const f = command.fact;
    const holds = (config.world & (1 << f)) !== 0;
    out.push({
      label: `probe ${compiled.factNames[f]}: ${holds ? "held" : "absent"}`,
      fault: false,
      config: {
        ...config,
        // Seeing a fact gone ends the excuse for believing what rests on it.
        stale: config.stale & ~(holds ? 1 << f : (compiled.above[f] as number)),
        mind: ctl.absorb(compiled, config.mind, {
          kind: "probe",
          fact: f,
          result: holds ? "held" : "absent",
        }),
      },
    });
    out.push({
      label: `probe ${compiled.factNames[f]}: error`,
      fault: true,
      config: {
        ...config,
        mind: ctl.absorb(compiled, config.mind, {
          kind: "probe",
          fact: f,
          result: "error",
        }),
      },
    });
    return out;
  }
  if (command.kind !== "act") return out;

  const op = compiled.operators[command.op] as CompiledOperator;
  const ready = (config.world & op.requires) === op.requires;
  const observe = (base: Config, outcome: number): Config => ({
    ...base,
    mind: ctl.absorb(compiled, base.mind, {
      kind: "act",
      op: op.index,
      outcome,
    }),
  });
  const lostReply = (tag: string, outcome: number): void => {
    out.push({
      label: `${op.id}: ${tag} (nothing happened)`,
      fault: true,
      config: observe(config, outcome),
      exercised: `${op.id}.${tag}`,
    });
    if (ready) {
      const applied = applyToWorld(compiled, config, op, true);
      out.push({
        label: `${op.id}: ${tag} (the effect happened)`,
        fault: true,
        config: observe(applied.config, outcome),
        exercised: `${op.id}.${tag}`,
        ...(applied.duplicate ? { duplicate: op.id } : {}),
      });
    }
  };
  op.outcomes.forEach((outcome, index) => {
    switch (outcome.kind) {
      case "established": {
        if (!ready) return;
        const applied = applyToWorld(compiled, config, op, false);
        out.push({
          label: `${op.id}: ${outcome.tag}`,
          fault: false,
          config: observe(applied.config, index),
          exercised: `${op.id}.${outcome.tag}`,
          ...(applied.duplicate ? { duplicate: op.id } : {}),
        });
        return;
      }
      case "invalidates":
        // Outcome reports are truthful: only when a named fact is really gone.
        if ((outcome.facts & ~config.world) === 0) return;
        out.push({
          label: `${op.id}: ${outcome.tag}`,
          fault: false,
          config: observe(config, index),
          exercised: `${op.id}.${outcome.tag}`,
        });
        return;
      case "unsure":
        lostReply(outcome.tag, index);
        return;
      default:
        out.push({
          label: `${op.id}: ${outcome.tag}`,
          fault: true,
          config: observe(config, index),
          exercised: `${op.id}.${outcome.tag}`,
        });
    }
  });
  lostReply(DEFECT_TAG, DEFECT);
  return out;
}

/** What a helpful world answers: success when it can, the truth when it cannot. */
function cooperativeSuccessor(
  ctl: Controller,
  compiled: Compiled,
  config: Config,
  command: Command,
): Successor | null {
  if (command.kind === "probe") {
    const holds = (config.world & (1 << command.fact)) !== 0;
    return {
      label: `probe ${compiled.factNames[command.fact]}: ${holds ? "held" : "absent"}`,
      fault: false,
      config: {
        ...config,
        stale:
          config.stale &
          ~(holds
            ? 1 << command.fact
            : (compiled.above[command.fact] as number)),
        mind: ctl.absorb(compiled, config.mind, {
          kind: "probe",
          fact: command.fact,
          result: holds ? "held" : "absent",
        }),
      },
    };
  }
  if (command.kind !== "act") return null;
  const op = compiled.operators[command.op] as CompiledOperator;
  const ready = (config.world & op.requires) === op.requires;
  const index = ready
    ? op.outcomes.findIndex((outcome) => outcome.kind === "established")
    : op.outcomes.findIndex(
        (outcome) =>
          outcome.kind === "invalidates" &&
          (outcome.facts & ~config.world) !== 0,
      );
  const applied = ready
    ? applyToWorld(compiled, config, op, false).config
    : config;
  return {
    label: `${op.id}: ${index < 0 ? DEFECT_TAG : (op.outcomes[index] as CompiledOutcome).tag}`,
    fault: false,
    config: {
      ...applied,
      mind: ctl.absorb(compiled, applied.mind, {
        kind: "act",
        op: op.index,
        outcome: index < 0 ? DEFECT : index,
      }),
    },
  };
}

function lower(next: readonly number[], prev: readonly number[]): boolean {
  for (let i = 0; i < prev.length; i += 1) {
    const a = next[i] as number;
    const b = prev[i] as number;
    if (a < b) return true;
    if (a > b) return false;
  }
  return false;
}

function endingKey(failure: Failure | null): string {
  if (failure === null) return "success";
  if (failure.kind === "terminal") return `terminal:${failure.reason}`;
  if (failure.kind === "unobservable") return `unobservable:${failure.fact}`;
  if (failure.kind === "unstable") return `unstable:${failure.facts.join("+")}`;
  return `unreachable:${failure.missing.join("+")}`;
}

/**
 * Whether success can still be had from what probes can find alone, even if
 * every single-use fact is spent first. Where this holds, no stale belief and
 * no spent input can have put success out of reach.
 */
function stillPossible(compiled: Compiled, config: Config): boolean {
  let findable = 0;
  for (const f of bits(config.world & compiled.observable)) {
    findable |= compiled.below[f] as number;
  }
  const usable = compiled.allOperators & ~config.mind.blocked;
  for (const op of compiled.operators) {
    if ((usable & (1 << op.index)) !== 0) findable &= ~op.consumes;
  }
  return plan(compiled, findable, usable) !== null;
}

export interface CooperativeRun {
  readonly status: "success" | "failed";
  readonly failure: Failure | null;
  /** Operators run, in order. */
  readonly acts: readonly string[];
  /** Facts probed, in order. */
  readonly probes: readonly string[];
  readonly cost: number;
  readonly trace: readonly string[];
  /** Facts true when the run ended. */
  readonly world: readonly string[];
}

function resolveWorld(compiled: Compiled, world: readonly string[]): number {
  let mask = 0;
  for (const name of world) {
    const index = compiled.factIndex.get(name);
    if (index === undefined) throw new Error(`unknown fact "${name}"`);
    mask |= compiled.below[index] as number;
  }
  return mask;
}

/** The run a fresh controller takes when nothing goes wrong. */
export function cooperate(
  ceremony: Ceremony,
  world: readonly string[],
  ctl: Controller = kernelController,
): CooperativeRun {
  const compiled = ceremony.compiled;
  let config: Config = {
    world: resolveWorld(compiled, world),
    stale: 0,
    residue: 0,
    invalidations: 0,
    mind: startingMind(ctl, compiled, resolveWorld(compiled, world)),
  };
  const acts: string[] = [];
  const probes: string[] = [];
  const trace: string[] = [];
  let cost = 0;
  for (;;) {
    const command = ctl.decide(compiled, config.mind);
    if (command.kind === "succeed") {
      return {
        status: "success",
        failure: null,
        acts,
        probes,
        cost,
        trace,
        world: names(compiled, config.world),
      };
    }
    if (command.kind === "fail") {
      return {
        status: "failed",
        failure: command.failure,
        acts,
        probes,
        cost,
        trace,
        world: names(compiled, config.world),
      };
    }
    if (command.kind === "probe") {
      probes.push(compiled.factNames[command.fact] as string);
    } else {
      const op = compiled.operators[command.op] as CompiledOperator;
      acts.push(op.id);
      cost += op.cost;
    }
    const next = cooperativeSuccessor(
      ctl,
      compiled,
      config,
      command,
    ) as Successor;
    trace.push(next.label);
    config = next.config;
  }
}

class Search {
  readonly ids = new Map<string, number>();
  readonly parents: number[] = [];
  readonly labels: string[] = [];
  readonly queue: Config[] = [];
  readonly extras: number[] = [];

  enqueue(
    config: Config,
    parent: number,
    label: string,
    extra: number,
  ): number {
    const key = `${extra}#${configKey(config)}`;
    const existing = this.ids.get(key);
    if (existing !== undefined) return existing;
    const id = this.parents.length;
    this.ids.set(key, id);
    this.parents.push(parent);
    this.labels.push(label);
    this.queue.push(config);
    this.extras.push(extra);
    return id;
  }

  trace(id: number, last?: string): string[] {
    const lines: string[] = [];
    for (let at = id; at >= 0; at = this.parents[at] as number) {
      lines.push(this.labels[at] as string);
    }
    lines.reverse();
    if (last !== undefined) lines.push(last);
    return lines;
  }
}

function capBudgets(compiled: Compiled, cap: number): Compiled {
  return {
    ...compiled,
    probeAttempts: Math.min(compiled.probeAttempts, cap),
    operators: compiled.operators.map((op) => ({
      ...op,
      attempts: Math.min(op.attempts, cap),
    })),
  };
}

export function check(
  ceremony: Ceremony,
  options: CheckOptions = {},
): CheckResult {
  const attempts = options.attempts ?? 2;
  const ctl = options.controller ?? kernelController;
  const compiled = capBudgets(ceremony.compiled, attempts);
  const invalidations = options.invalidations ?? 1;
  const faultBound = options.faults ?? 1;
  const faultDepth = options.faultDepth ?? null;
  const maxStates = options.maxStates ?? 1_000_000;
  const worlds =
    options.worlds === undefined
      ? startingWorlds(compiled)
      : options.worlds.map((world) => resolveWorld(compiled, world));
  const initial = (world: number): Config => ({
    world,
    stale: 0,
    residue: 0,
    invalidations,
    mind: startingMind(ctl, compiled, world),
  });

  const violations = new Map<Property, Violation>();
  const report = (
    search: Search,
    property: Property,
    message: string,
    id: number,
    last?: string,
  ): void => {
    if (!violations.has(property)) {
      violations.set(property, {
        property,
        message,
        trace: search.trace(id, last),
      });
    }
  };

  // Pass 1: every environment the declarations allow.
  const all = new Search();
  const endings = new Map<
    string,
    { failure: Failure | null; count: number; first: number }
  >();
  const used = new Set<number>();
  const seen = new Set<string>();
  let transitions = 0;
  let complete = true;
  for (const world of worlds) {
    all.enqueue(initial(world), -1, `start with ${show(compiled, world)}`, 0);
  }
  for (let id = 0; id < all.queue.length; id += 1) {
    if (all.ids.size > maxStates) {
      complete = false;
      break;
    }
    const config = all.queue[id] as Config;
    const mind = config.mind;
    const faultsSoFar = all.extras[id] as number;

    const falselyHeld = mind.held & ~config.world & ~config.stale;
    const falselyAbsent = mind.absent & compiled.observable & config.world;
    if (falselyHeld !== 0) {
      report(
        all,
        "belief-sound",
        `the controller believes ${show(compiled, falselyHeld)} with no reason to`,
        id,
      );
    }
    if (falselyAbsent !== 0) {
      report(
        all,
        "belief-sound",
        `the controller believes ${show(compiled, falselyAbsent)} is missing while it holds`,
        id,
      );
    }

    const command = ctl.decide(compiled, mind);
    if (command.kind === "succeed" || command.kind === "fail") {
      const failure = command.kind === "fail" ? command.failure : null;
      if (failure === null && (mind.held & compiled.goal) !== compiled.goal) {
        report(
          all,
          "success-sound",
          `success declared without ${show(compiled, compiled.goal & ~mind.held)}`,
          id,
        );
      }
      if ((config.residue & ~mind.residue) !== 0) {
        report(
          all,
          "residue-accounted",
          "the run may have left a resource behind and does not say so",
          id,
        );
      }
      const key = endingKey(failure);
      const ending = endings.get(key);
      if (ending === undefined) {
        endings.set(key, { failure, count: 1, first: id });
      } else {
        ending.count += 1;
      }
      continue;
    }

    if (command.kind === "act") {
      const op = compiled.operators[command.op] as CompiledOperator;
      used.add(op.index);
      if ((mind.held & op.requires) !== op.requires) {
        report(
          all,
          "precondition",
          `${op.id} runs without ${show(compiled, op.requires & ~mind.held)}`,
          id,
          `${op.id} is about to run`,
        );
      }
    }

    const before = rank(compiled, mind);
    for (const next of successors(ctl, compiled, config, command)) {
      transitions += 1;
      if (next.exercised !== undefined) seen.add(next.exercised);
      if (next.config.mind !== mind) {
        const after = rank(compiled, next.config.mind);
        if (!lower(after, before)) {
          report(
            all,
            "terminates",
            `this step does not lower the ranking measure (${before.join(",")} to ${after.join(",")})`,
            id,
            next.label,
          );
        }
      }
      if (next.duplicate !== undefined) {
        report(
          all,
          "no-duplicate-effect",
          `${next.duplicate} is not idempotent and its effect landed on top of itself`,
          id,
          next.label,
        );
      }
      if (faultDepth === null) {
        all.enqueue(next.config, id, next.label, 0);
      } else {
        const after = faultsSoFar + (next.fault ? 1 : 0);
        if (after <= faultDepth) {
          all.enqueue(next.config, id, next.label, after);
        }
      }
    }
  }

  // Pass 2: after at most `faults` things go wrong, a cooperating world must
  // still reach success wherever success is still possible.
  const few = new Search();
  const cooperation = new Map<string, boolean>();
  const cooperates = (start: Config): boolean => {
    const path: string[] = [];
    let config = start;
    let verdict: boolean;
    for (;;) {
      const key = configKey(config);
      const known = cooperation.get(key);
      if (known !== undefined) {
        verdict = known;
        break;
      }
      path.push(key);
      const command = ctl.decide(compiled, config.mind);
      if (command.kind === "succeed" || command.kind === "fail") {
        verdict = command.kind === "succeed";
        break;
      }
      config = (
        cooperativeSuccessor(ctl, compiled, config, command) as Successor
      ).config;
    }
    for (const key of path) cooperation.set(key, verdict);
    return verdict;
  };
  for (const world of worlds) {
    few.enqueue(initial(world), -1, `start with ${show(compiled, world)}`, 0);
  }
  for (let id = 0; id < few.queue.length; id += 1) {
    if (few.ids.size > maxStates) {
      complete = false;
      break;
    }
    const config = few.queue[id] as Config;
    const faults = few.extras[id] as number;
    const command = ctl.decide(compiled, config.mind);
    if (command.kind === "succeed" || command.kind === "fail") continue;
    if (stillPossible(compiled, config) && !cooperates(config)) {
      report(
        few,
        "recoverable",
        "success was still possible, yet a cooperating world does not reach it from here",
        id,
        "from here every step succeeds or reports the truth, and the run still fails",
      );
    }
    for (const next of successors(ctl, compiled, config, command)) {
      const after = faults + (next.fault ? 1 : 0);
      if (after > faultBound) continue;
      few.enqueue(next.config, id, next.label, after);
    }
  }

  const outcomesUnseen: string[] = [];
  for (const op of compiled.operators) {
    for (const outcome of op.outcomes) {
      if (!seen.has(`${op.id}.${outcome.tag}`)) {
        outcomesUnseen.push(`${op.id}.${outcome.tag}`);
      }
    }
  }
  return {
    ceremony: ceremony.id,
    complete,
    states: all.ids.size + few.ids.size,
    transitions,
    initialWorlds: worlds.length,
    bounds: { invalidations, faults: faultBound, attempts, faultDepth },
    violations: [...violations.values()],
    endings: [...endings.entries()]
      .map(([key, ending]) => ({
        status:
          ending.failure === null ? ("success" as const) : ("failed" as const),
        key,
        failure: ending.failure,
        count: ending.count,
        trace: all.trace(ending.first),
      }))
      .sort((a, b) => a.key.localeCompare(b.key)),
    operatorsUsed: compiled.operators
      .filter((op) => used.has(op.index))
      .map((op) => op.id),
    operatorsUnused: compiled.operators
      .filter((op) => !used.has(op.index))
      .map((op) => op.id),
    outcomesUnseen,
  };
}
