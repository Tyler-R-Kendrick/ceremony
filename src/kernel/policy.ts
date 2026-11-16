/**
 * The controller, as two pure functions.
 *
 * `decide` maps what the controller knows to the next thing to do. `absorb`
 * folds what happened back into what it knows. There is no step counter: the
 * controller's whole state is its knowledge, so resuming after a crash is the
 * same act as taking the next step. The interpreter and the model checker both
 * call these functions; only the world differs between them.
 */
import { bits, type Compiled, type CompiledOperator } from "./ceremony.js";
import { plan } from "./plan.js";

export type Failure =
  | {
      readonly kind: "terminal";
      readonly reason: string;
      readonly operator: string;
      readonly outcome: string;
    }
  | {
      readonly kind: "unreachable";
      readonly missing: readonly string[];
      readonly blocked: readonly {
        readonly operator: string;
        readonly because: string;
      }[];
    }
  | { readonly kind: "unobservable"; readonly fact: string }
  /** Probes and operators kept disagreeing about these facts. */
  | { readonly kind: "unstable"; readonly facts: readonly string[] };

export type Command =
  | { readonly kind: "probe"; readonly fact: number }
  | { readonly kind: "act"; readonly op: number; readonly attempt: number }
  | { readonly kind: "succeed" }
  | { readonly kind: "fail"; readonly failure: Failure };

export type Work = Extract<Command, { kind: "probe" | "act" }>;

/** An outcome index for an undeclared ending: a thrown error or a lost reply. */
export const DEFECT = -1;
export const DEFECT_TAG = "#defect";
const NOT_BLOCKED = -3;
const EXHAUSTED = -2;

export type Observation =
  | {
      readonly kind: "probe";
      readonly fact: number;
      readonly result: "held" | "absent" | "error";
    }
  | { readonly kind: "act"; readonly op: number; readonly outcome: number }
  /** A fact believed held whose value is no longer in custody. */
  | { readonly kind: "lost"; readonly fact: number }
  /**
   * What the vault already holds as the run starts. For facts no probe can
   * check, custody is the only knowledge there is, so it is taken as belief
   * and left to the operators that use it to report it stale.
   */
  | { readonly kind: "custody"; readonly facts: number };

export interface Mind {
  readonly held: number;
  readonly absent: number;
  /** Operators the plan may no longer use. */
  readonly blocked: number;
  /** Per operator: why it is blocked. */
  readonly why: readonly number[];
  /** Per operator: attempts spent. */
  readonly attempts: readonly number[];
  /** Failed probes so far in this run. */
  readonly probeFailures: number;
  /** Times a belief has been reported stale in this run. */
  readonly staleReports: number;
  /** Operators whose effect may have left something nobody holds. */
  readonly residue: number;
  /** Work written ahead of its result. */
  readonly pending: Work | null;
  readonly terminal: Failure | null;
}

export function freshMind(compiled: Compiled): Mind {
  return {
    held: 0,
    absent: 0,
    blocked: 0,
    why: compiled.operators.map(() => NOT_BLOCKED),
    attempts: compiled.operators.map(() => 0),
    probeFailures: 0,
    staleReports: 0,
    residue: 0,
    pending: null,
    terminal: null,
  };
}

function closeBelow(compiled: Compiled, mask: number): number {
  let out = 0;
  for (const f of bits(mask)) out |= compiled.below[f] as number;
  return out;
}

function closeAbove(compiled: Compiled, mask: number): number {
  let out = 0;
  for (const f of bits(mask)) out |= compiled.above[f] as number;
  return out;
}

function popcount(mask: number): number {
  let count = 0;
  for (let rest = mask; rest !== 0; rest &= rest - 1) count += 1;
  return count;
}

function explainBlock(op: CompiledOperator, why: number): string {
  if (why === EXHAUSTED) return `gave up after ${op.attempts} attempts`;
  return op.outcomes[why]?.tag ?? "unknown";
}

/**
 * The next thing to do.
 *
 * Unknown facts are assumed to hold while planning. If the cheapest plan under
 * that assumption leans on one of them, a fact that would settle it is probed
 * before anything is done (the one resting on most of what the plan leans on,
 * so one look can settle several); if it leans on none, the plan is already
 * the cheapest one for the real world and its first step runs. So no operator
 * runs whose facts all already hold, and a probe is only made where the plan
 * depends on its answer. An operator that establishes several facts does run
 * when only some are missing.
 */
export function decide(compiled: Compiled, mind: Mind): Command {
  if (mind.terminal !== null) return { kind: "fail", failure: mind.terminal };
  const usable = compiled.allOperators & ~mind.blocked;
  const unknown =
    compiled.all & ~mind.held & ~mind.absent & compiled.observable;
  const optimistic = mind.held | closeBelow(compiled, unknown);
  const best = plan(compiled, optimistic, usable);
  if (best === null) {
    return {
      kind: "fail",
      failure: {
        kind: "unreachable",
        missing: bits(compiled.goal & ~mind.held).map(
          (f) => compiled.factNames[f] as string,
        ),
        blocked: compiled.operators
          .filter((op) => (mind.blocked & (1 << op.index)) !== 0)
          .map((op) => ({
            operator: op.id,
            because: explainBlock(op, mind.why[op.index] as number),
          })),
      },
    };
  }

  let assumed = optimistic & ~mind.held;
  let relied = 0;
  for (const index of best.steps) {
    const op = compiled.operators[index] as CompiledOperator;
    relied |= op.requires & assumed;
    assumed &= ~(op.establishes | op.consumes);
  }
  relied |= compiled.goal & assumed;

  if (relied !== 0) {
    let pick = -1;
    let pickScore = -1;
    for (const f of bits(unknown)) {
      const reach = compiled.below[f] as number;
      const useful = popcount(reach & relied);
      if (useful === 0) continue;
      const score = useful * 64 + popcount(reach);
      if (score > pickScore) {
        pick = f;
        pickScore = score;
      }
    }
    return { kind: "probe", fact: pick };
  }
  const first = best.steps[0];
  if (first === undefined) return { kind: "succeed" };
  return {
    kind: "act",
    op: first,
    attempt: (mind.attempts[first] as number) + 1,
  };
}

export function begin(mind: Mind, work: Work): Mind {
  return { ...mind, pending: work };
}

function withHeld(compiled: Compiled, mind: Mind, mask: number): Mind {
  const gained = closeBelow(compiled, mask);
  return {
    ...mind,
    held: mind.held | gained,
    absent: mind.absent & ~gained,
  };
}

function withAbsent(compiled: Compiled, mind: Mind, mask: number): Mind {
  const lost = closeAbove(compiled, mask);
  return { ...mind, held: mind.held & ~lost, absent: mind.absent | lost };
}

/** Forget a belief: observable facts become unknown, the rest count as lost. */
function withDoubt(compiled: Compiled, mind: Mind, mask: number): Mind {
  const doubted = closeAbove(compiled, mask);
  return {
    ...mind,
    held: mind.held & ~doubted,
    absent:
      (mind.absent & ~(doubted & compiled.observable)) |
      (doubted & ~compiled.observable),
  };
}

function charge(mind: Mind, op: CompiledOperator): Mind {
  const attempts = mind.attempts.slice();
  attempts[op.index] = (attempts[op.index] as number) + 1;
  if ((attempts[op.index] as number) < op.attempts) {
    return { ...mind, attempts };
  }
  const why = mind.why.slice();
  if ((mind.blocked & (1 << op.index)) === 0) why[op.index] = EXHAUSTED;
  return { ...mind, attempts, why, blocked: mind.blocked | (1 << op.index) };
}

/** Count one stale belief; past the budget the run stops instead of looping. */
function reportStale(
  compiled: Compiled,
  mind: Mind,
  suspected: number,
  apply: (counted: Mind) => Mind,
): Mind {
  const staleReports = mind.staleReports + 1;
  if (staleReports < compiled.staleReports) {
    return apply({ ...mind, staleReports });
  }
  return {
    ...mind,
    staleReports,
    terminal: {
      kind: "unstable",
      facts: bits(suspected).map((f) => compiled.factNames[f] as string),
    },
  };
}

export function absorb(
  compiled: Compiled,
  before: Mind,
  observation: Observation,
): Mind {
  if (observation.kind === "custody") {
    const remembered = observation.facts & ~compiled.observable;
    return {
      ...before,
      held: before.held | remembered,
      absent: before.absent & ~remembered,
    };
  }
  if (observation.kind === "lost") {
    return reportStale(compiled, before, 1 << observation.fact, (counted) =>
      withAbsent(compiled, counted, 1 << observation.fact),
    );
  }
  const mind: Mind = { ...before, pending: null };
  if (observation.kind === "probe") {
    const bit = 1 << observation.fact;
    if (observation.result === "held") return withHeld(compiled, mind, bit);
    if (observation.result === "absent") {
      // Finding a believed fact gone is a stale belief like any other, and is
      // counted, so a world or a vault that keeps losing it ends the run.
      return (mind.held & bit) !== 0
        ? reportStale(compiled, mind, bit, (counted) =>
            withAbsent(compiled, counted, bit),
          )
        : withAbsent(compiled, mind, bit);
    }
    const probeFailures = mind.probeFailures + 1;
    const exhausted = probeFailures >= compiled.probeAttempts;
    return {
      ...mind,
      probeFailures,
      terminal: exhausted
        ? {
            kind: "unobservable",
            fact: compiled.factNames[observation.fact] as string,
          }
        : mind.terminal,
    };
  }

  const op = compiled.operators[observation.op] as CompiledOperator;
  const outcome =
    observation.outcome === DEFECT
      ? undefined
      : op.outcomes[observation.outcome];
  const kind = outcome?.kind ?? "unsure";
  switch (kind) {
    case "established":
      return withHeld(
        compiled,
        withAbsent(compiled, mind, op.consumes),
        op.establishes,
      );
    case "retry":
      return charge(mind, op);
    case "unsure": {
      // Look again at what a probe can see. What was consumed stays believed:
      // running the operator again is the cheap way to learn it is gone.
      const charged = charge(mind, op);
      const doubted = {
        ...charged,
        held: charged.held & ~(op.establishes & compiled.observable),
        absent: charged.absent & ~(op.establishes & compiled.observable),
      };
      return op.leavesResidue
        ? { ...doubted, residue: doubted.residue | (1 << op.index) }
        : doubted;
    }
    case "blocked": {
      const why = mind.why.slice();
      why[op.index] = observation.outcome;
      return { ...mind, why, blocked: mind.blocked | (1 << op.index) };
    }
    case "invalidates": {
      const suspected = outcome?.facts ?? 0;
      return reportStale(compiled, mind, suspected, (counted) => {
        // Whatever the suspected facts rest on is looked at again too, so the
        // next step is not built on a second stale belief.
        const recheck =
          closeBelow(compiled, suspected) & compiled.observable & counted.held;
        const doubted = withDoubt(compiled, counted, suspected);
        return { ...doubted, held: doubted.held & ~recheck };
      });
    }
    case "terminal":
      return {
        ...mind,
        terminal: {
          kind: "terminal",
          reason: outcome?.reason ?? "",
          operator: op.id,
          outcome: outcome?.tag ?? "",
        },
      };
  }
}

/**
 * A measure that strictly decreases on every controller step, in dictionary
 * order: whether the run is still open, the attempts left to spend, the facts
 * still unknown, and the cost of the plan still to run. The model checker
 * checks the decrease on every transition it visits, which is what makes "the
 * run always ends" a checked claim.
 */
export function rank(compiled: Compiled, mind: Mind): readonly number[] {
  let budget = 0;
  for (const op of compiled.operators) {
    if ((mind.blocked & (1 << op.index)) === 0) {
      budget += op.attempts - (mind.attempts[op.index] as number);
    }
  }
  budget += compiled.probeAttempts - mind.probeFailures;
  budget += compiled.staleReports - mind.staleReports;
  const unknown =
    compiled.all & ~mind.held & ~mind.absent & compiled.observable;
  const optimistic = mind.held | closeBelow(compiled, unknown);
  const toGo = plan(
    compiled,
    optimistic,
    compiled.allOperators & ~mind.blocked,
  );
  return [
    mind.terminal === null ? 1 : 0,
    budget,
    popcount(unknown),
    toGo === null ? 0 : toGo.cost,
  ];
}

/** Identity of a mind for the checker. The block reasons only explain, so they are left out. */
export function mindKey(mind: Mind): string {
  const terminal =
    mind.terminal === null
      ? ""
      : mind.terminal.kind === "terminal"
        ? `t:${mind.terminal.operator}:${mind.terminal.outcome}`
        : mind.terminal.kind === "unobservable"
          ? `u:${mind.terminal.fact}`
          : `s:${mind.terminal.kind === "unstable" ? mind.terminal.facts.join("+") : ""}`;
  return [
    mind.held,
    mind.absent,
    mind.blocked,
    mind.residue,
    mind.attempts.join("."),
    mind.probeFailures,
    mind.staleReports,
    terminal,
  ].join("|");
}
