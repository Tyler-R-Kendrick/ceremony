/**
 * Ceremony declarations.
 *
 * A ceremony is a set of facts to make true and operators that establish them.
 * Nothing here is a script: there is no program counter, only what holds and
 * what could make the rest hold. Every way an operator can end is declared as
 * data, so the planner, the interpreter and the model checker all read the
 * same contract.
 */

export type Actor = "machine" | "human";

/** Phantom carrier for a fact's value type. */
export interface ValueType<V> {
  readonly phantom?: (value: V) => V;
}

export function of<V>(): ValueType<V> {
  return {};
}

export interface FactDecl<V = unknown, Observable extends boolean = boolean> {
  readonly description: string;
  /** Facts this one cannot hold without. Losing one loses this fact too. */
  readonly requires: readonly string[];
  /** The environment can take this fact away (expiry, revocation, deletion). */
  readonly volatile: boolean;
  /** A read-only probe can tell whether this fact holds right now. */
  readonly observable: Observable;
  /**
   * A probe can find this fact and its value from nothing. Otherwise the value
   * exists only in the reply that established it: lose the reply and the fact
   * is not held, whatever was created on the other side.
   */
  readonly discoverable: boolean;
  /** The value must never reach an interface, an agent or the journal. */
  readonly secret: boolean;
  /** Supplied by the host (configuration); no operator is expected to make it. */
  readonly given: boolean;
  readonly value: ValueType<V>;
}

export function fact<V = true, const Observable extends boolean = false>(spec: {
  readonly description: string;
  readonly value?: ValueType<V>;
  readonly requires?: readonly string[];
  readonly volatile?: boolean;
  readonly observable?: Observable;
  readonly discoverable?: boolean;
  readonly secret?: boolean;
  readonly given?: boolean;
}): FactDecl<V, Observable> {
  return {
    description: spec.description,
    requires: spec.requires ?? [],
    volatile: spec.volatile ?? false,
    observable: (spec.observable ?? false) as Observable,
    discoverable: spec.discoverable ?? false,
    secret: spec.secret ?? false,
    given: spec.given ?? false,
    value: spec.value ?? {},
  };
}

/**
 * What an outcome means to the controller. This is the whole failure algebra:
 * an operator cannot end in a way that is not one of these.
 */
export type OutcomeEffect =
  /** The postcondition holds. */
  | { readonly kind: "established" }
  /** Nothing happened; trying again may work. Spends one attempt. */
  | { readonly kind: "retry" }
  /** The effect may or may not have happened (a timeout on a write). */
  | { readonly kind: "unsure" }
  /** This operator cannot work in this run; plan around it. */
  | { readonly kind: "blocked" }
  /** A fact the controller believed turned out not to hold. Costs the operator nothing. */
  | { readonly kind: "invalidates"; readonly facts: readonly string[] }
  /** The ceremony ends here with a named, expected failure. */
  | { readonly kind: "terminal"; readonly reason: string };

export interface OutcomeDecl<E extends OutcomeEffect = OutcomeEffect> {
  readonly effect: E;
  readonly description: string;
}

export const established = (
  description: string,
): OutcomeDecl<{ readonly kind: "established" }> => ({
  effect: { kind: "established" },
  description,
});

export const retry = (
  description: string,
): OutcomeDecl<{ readonly kind: "retry" }> => ({
  effect: { kind: "retry" },
  description,
});

export const unsure = (
  description: string,
): OutcomeDecl<{ readonly kind: "unsure" }> => ({
  effect: { kind: "unsure" },
  description,
});

export const blocked = (
  description: string,
): OutcomeDecl<{ readonly kind: "blocked" }> => ({
  effect: { kind: "blocked" },
  description,
});

export const invalidates = <const Facts extends readonly string[]>(
  facts: Facts,
  description: string,
): OutcomeDecl<{ readonly kind: "invalidates"; readonly facts: Facts }> => ({
  effect: { kind: "invalidates", facts },
  description,
});

export const terminal = <const Reason extends string>(
  reason: Reason,
  description: string,
): OutcomeDecl<{ readonly kind: "terminal"; readonly reason: Reason }> => ({
  effect: { kind: "terminal", reason },
  description,
});

export interface InterfaceField {
  readonly name: string;
  readonly label: string;
  readonly kind: "text" | "secret" | "choice";
  readonly options?: readonly string[];
}

export interface InterfaceAction<Outcome extends string = string> {
  readonly id: string;
  readonly label: string;
  readonly outcome: Outcome;
  readonly emphasis: "primary" | "secondary";
  /** The action leaves for the provider and comes back by callback. */
  readonly leavesPage?: boolean;
}

/** The component a human step needs. Derived per flow, never hand-listed. */
export interface InterfaceSpec<Outcome extends string = string> {
  readonly title: string;
  readonly body: string;
  /** Facts whose values the interface displays. Never secret ones. */
  readonly shows?: readonly string[];
  readonly fields?: readonly InterfaceField[];
  readonly actions: readonly InterfaceAction<Outcome>[];
}

export interface OperatorDecl<
  Est extends string = string,
  Req extends string = string,
  Out extends Record<string, OutcomeDecl> = Record<string, OutcomeDecl>,
  A extends Actor = Actor,
> {
  readonly description: string;
  readonly establishes: readonly Est[];
  readonly requires: readonly Req[];
  /** Single-use inputs: gone once the effect has happened. */
  readonly consumes: readonly Req[];
  readonly actor: A;
  /** Running the effect twice is the same as running it once. */
  readonly idempotent: boolean;
  readonly cost: number;
  readonly attempts: number;
  readonly outcomes: Out;
  /** Checked against `outcomes` by `operator()`; kept loose here so the type stays covariant. */
  readonly interface?: InterfaceSpec;
}

export const DEFAULT_ATTEMPTS = 3;
export const MACHINE_COST = 1;
export const HUMAN_COST = 100;

export function operator<
  const Est extends string,
  const Out extends Record<string, OutcomeDecl>,
  const A extends Actor,
  const Req extends string = never,
>(spec: {
  readonly description: string;
  readonly establishes: readonly Est[];
  readonly requires?: readonly Req[];
  readonly consumes?: readonly Req[];
  readonly actor: A;
  readonly idempotent: boolean;
  readonly cost?: number;
  readonly attempts?: number;
  readonly outcomes: Out;
  readonly interface?: InterfaceSpec<keyof Out & string>;
}): OperatorDecl<Est, NoInfer<Req>, Out, A> {
  return {
    description: spec.description,
    establishes: spec.establishes,
    requires: spec.requires ?? [],
    consumes: spec.consumes ?? [],
    actor: spec.actor,
    idempotent: spec.idempotent,
    cost: spec.cost ?? (spec.actor === "human" ? HUMAN_COST : MACHINE_COST),
    attempts: spec.attempts ?? DEFAULT_ATTEMPTS,
    outcomes: spec.outcomes,
    ...(spec.interface ? { interface: spec.interface } : {}),
  };
}

export type Facts = Record<string, FactDecl<any, boolean>>;
export type Operators = Record<
  string,
  OperatorDecl<string, string, Record<string, OutcomeDecl>, Actor>
>;

export interface CeremonyDecl<
  F extends Facts = Facts,
  O extends Operators = Operators,
> {
  readonly id: string;
  readonly title: string;
  readonly facts: F;
  readonly operators: O;
  readonly goal: readonly (keyof F & string)[];
  /** Failed probes tolerated in one run before it stops. */
  readonly probeAttempts?: number;
  /** Times a belief may be reported stale in one run before it stops. */
  readonly staleReports?: number;
}

export interface Issue {
  readonly severity: "error" | "warning";
  readonly rule: string;
  readonly subject: string;
  readonly message: string;
}

export const MAX_FACTS = 24;
export const MAX_OPERATORS = 24;
export const DEFAULT_PROBE_ATTEMPTS = 5;
export const DEFAULT_STALE_REPORTS = 8;

export interface CompiledOutcome {
  readonly tag: string;
  readonly kind: OutcomeEffect["kind"];
  /** `invalidates`: the suspected facts. */
  readonly facts: number;
  /** `terminal`: the reason. */
  readonly reason: string;
}

export interface CompiledOperator {
  readonly id: string;
  readonly index: number;
  readonly establishes: number;
  /** Declared requirements, their supports, and the supports of what it establishes. */
  readonly requires: number;
  /** Consumed facts and everything that cannot hold without them. */
  readonly consumes: number;
  readonly human: boolean;
  readonly idempotent: boolean;
  /**
   * A lost reply may leave something nobody holds: the effect is not
   * idempotent and part of what it establishes lives only in the reply.
   */
  readonly leavesResidue: boolean;
  readonly cost: number;
  readonly attempts: number;
  readonly outcomes: readonly CompiledOutcome[];
  readonly outcomeIndex: ReadonlyMap<string, number>;
}

export interface Compiled {
  readonly factNames: readonly string[];
  readonly factIndex: ReadonlyMap<string, number>;
  /** f and everything f cannot hold without. */
  readonly below: readonly number[];
  /** f and everything that cannot hold without f. */
  readonly above: readonly number[];
  readonly all: number;
  readonly observable: number;
  readonly discoverable: number;
  readonly volatile: number;
  readonly secret: number;
  readonly goal: number;
  readonly operators: readonly CompiledOperator[];
  readonly operatorIndex: ReadonlyMap<string, number>;
  readonly allOperators: number;
  readonly probeAttempts: number;
  readonly staleReports: number;
}

export interface Ceremony<
  F extends Facts = Facts,
  O extends Operators = Operators,
> extends CeremonyDecl<F, O> {
  readonly compiled: Compiled;
  readonly warnings: readonly Issue[];
}

export class CeremonyDefinitionError extends Error {
  constructor(
    readonly ceremonyId: string,
    readonly issues: readonly Issue[],
  ) {
    super(
      `Ceremony "${ceremonyId}" is not well formed:\n` +
        issues
          .filter((issue) => issue.severity === "error")
          .map(
            (issue) => `  [${issue.rule}] ${issue.subject}: ${issue.message}`,
          )
          .join("\n"),
    );
    this.name = "CeremonyDefinitionError";
  }
}

export function bits(mask: number): number[] {
  const out: number[] = [];
  for (let rest = mask; rest !== 0; rest &= rest - 1) {
    out.push(31 - Math.clz32(rest & -rest));
  }
  return out;
}

export function names(compiled: Compiled, mask: number): string[] {
  return bits(mask).map((index) => compiled.factNames[index] as string);
}

function compile(decl: CeremonyDecl, issues: Issue[]): Compiled | null {
  const error = (rule: string, subject: string, message: string): void => {
    issues.push({ severity: "error", rule, subject, message });
  };
  const factNames = Object.keys(decl.facts);
  const operatorIds = Object.keys(decl.operators);
  if (factNames.length > MAX_FACTS) {
    error("bounds", decl.id, `${factNames.length} facts; at most ${MAX_FACTS}`);
    return null;
  }
  if (operatorIds.length > MAX_OPERATORS) {
    error(
      "bounds",
      decl.id,
      `${operatorIds.length} operators; at most ${MAX_OPERATORS}`,
    );
    return null;
  }
  const factIndex = new Map(factNames.map((name, index) => [name, index]));
  const maskOf = (
    list: readonly string[],
    rule: string,
    subject: string,
  ): number => {
    let mask = 0;
    for (const name of list) {
      const index = factIndex.get(name);
      if (index === undefined) error(rule, subject, `unknown fact "${name}"`);
      else mask |= 1 << index;
    }
    return mask;
  };

  const direct = factNames.map((name) =>
    maskOf(
      (decl.facts[name] as FactDecl).requires,
      "fact-reference",
      `fact ${name}`,
    ),
  );
  const below = direct.map((mask, index) => mask | (1 << index));
  for (let changed = true; changed;) {
    changed = false;
    for (let f = 0; f < below.length; f += 1) {
      let next = below[f] as number;
      for (const dep of bits(next)) next |= below[dep] as number;
      if (next !== below[f]) {
        below[f] = next;
        changed = true;
      }
    }
  }
  for (let f = 0; f < factNames.length; f += 1) {
    for (const dep of bits((direct[f] as number) & ~(1 << f))) {
      if (((below[dep] as number) & (1 << f)) !== 0) {
        error(
          "support-cycle",
          `fact ${factNames[f]}`,
          `depends on "${factNames[dep]}", which depends on it`,
        );
      }
    }
    if (((direct[f] as number) & (1 << f)) !== 0) {
      error("support-cycle", `fact ${factNames[f]}`, "requires itself");
    }
  }
  const above = factNames.map((_, f) => {
    let mask = 0;
    for (let g = 0; g < factNames.length; g += 1) {
      if (((below[g] as number) & (1 << f)) !== 0) mask |= 1 << g;
    }
    return mask;
  });
  const flag = (pick: (declared: FactDecl) => boolean): number =>
    factNames.reduce(
      (mask, name, index) =>
        pick(decl.facts[name] as FactDecl) ? mask | (1 << index) : mask,
      0,
    );
  const discoverable = flag((declared) => declared.discoverable);
  const closeBelow = (mask: number): number =>
    bits(mask).reduce((acc, f) => acc | (below[f] as number), 0);
  const closeAbove = (mask: number): number =>
    bits(mask).reduce((acc, f) => acc | (above[f] as number), 0);

  const operators: CompiledOperator[] = operatorIds.map((id, index) => {
    const declared = decl.operators[id] as OperatorDecl;
    const subject = `operator ${id}`;
    const establishes = maskOf(
      declared.establishes,
      "operator-reference",
      subject,
    );
    const declaredRequires = maskOf(
      declared.requires,
      "operator-reference",
      subject,
    );
    const consumes = maskOf(declared.consumes, "operator-reference", subject);
    const outcomes: CompiledOutcome[] = Object.entries(declared.outcomes).map(
      ([tag, outcome]) => ({
        tag,
        kind: outcome.effect.kind,
        facts:
          outcome.effect.kind === "invalidates"
            ? maskOf(outcome.effect.facts, "outcome-reference", subject)
            : 0,
        reason: outcome.effect.kind === "terminal" ? outcome.effect.reason : "",
      }),
    );
    return {
      id,
      index,
      establishes,
      requires:
        closeBelow(declaredRequires) | (closeBelow(establishes) & ~establishes),
      consumes: closeAbove(consumes),
      human: declared.actor === "human",
      idempotent: declared.idempotent,
      leavesResidue:
        !declared.idempotent && (establishes & ~discoverable) !== 0,
      cost: declared.cost,
      attempts: declared.attempts,
      outcomes,
      outcomeIndex: new Map(outcomes.map((outcome, at) => [outcome.tag, at])),
    };
  });

  return {
    factNames,
    factIndex,
    below,
    above,
    all: factNames.length === 0 ? 0 : (2 ** factNames.length - 1) | 0,
    observable: flag((declared) => declared.observable),
    discoverable,
    volatile: flag((declared) => declared.volatile),
    secret: flag((declared) => declared.secret),
    goal: maskOf(decl.goal, "goal", decl.id),
    operators,
    operatorIndex: new Map(operatorIds.map((id, index) => [id, index])),
    allOperators:
      operatorIds.length === 0 ? 0 : (2 ** operatorIds.length - 1) | 0,
    probeAttempts: decl.probeAttempts ?? DEFAULT_PROBE_ATTEMPTS,
    staleReports: decl.staleReports ?? DEFAULT_STALE_REPORTS,
  };
}

/**
 * Static well-formedness. Each rule exists because the model checker can show
 * a concrete bad run when the rule is dropped; see tests/kernel/lint.test.ts.
 */
export function validate(decl: CeremonyDecl): {
  readonly issues: readonly Issue[];
  readonly compiled: Compiled | null;
} {
  const issues: Issue[] = [];
  const push = (
    severity: Issue["severity"],
    rule: string,
    subject: string,
    message: string,
  ): void => {
    issues.push({ severity, rule, subject, message });
  };
  const compiled = compile(decl, issues);
  if (compiled === null) return { issues, compiled };
  const name = (index: number): string => compiled.factNames[index] as string;

  if (compiled.goal === 0) {
    push("error", "goal", decl.id, "a ceremony needs at least one goal fact");
  }
  if (!Number.isInteger(compiled.probeAttempts) || compiled.probeAttempts < 1) {
    push(
      "error",
      "bounds",
      decl.id,
      "probeAttempts must be a positive integer",
    );
  }
  if (!Number.isInteger(compiled.staleReports) || compiled.staleReports < 1) {
    push("error", "bounds", decl.id, "staleReports must be a positive integer");
  }

  for (const op of compiled.operators) {
    const declared = decl.operators[op.id] as OperatorDecl;
    const subject = `operator ${op.id}`;
    if (op.establishes === 0) {
      push(
        "error",
        "operator-establishes",
        subject,
        "establishes no fact, so no plan could need it",
      );
    }
    if (!(op.cost > 0) || !Number.isFinite(op.cost)) {
      push("error", "bounds", subject, "cost must be a positive number");
    }
    if (!Number.isInteger(op.attempts) || op.attempts < 1) {
      push("error", "bounds", subject, "attempts must be a positive integer");
    }
    if (!op.outcomes.some((outcome) => outcome.kind === "established")) {
      push(
        "error",
        "operator-success",
        subject,
        "declares no outcome that establishes its facts",
      );
    }
    for (const tag of Object.keys(declared.outcomes)) {
      if (tag.startsWith("#")) {
        push(
          "error",
          "outcome-name",
          subject,
          `outcome "${tag}" uses the reserved "#" prefix`,
        );
      }
    }
    const declaredConsumes = bits(op.consumes).filter((f) =>
      declared.consumes.includes(name(f)),
    );
    for (const f of declaredConsumes) {
      if ((op.requires & (1 << f)) === 0) {
        push(
          "error",
          "consumes-required",
          subject,
          `consumes "${name(f)}" without requiring it`,
        );
      }
    }
    // A single-use fact is an input to exactly one step: nothing else may
    // rest on it or read it, or spending it would strand the rest of the plan.
    for (const f of declaredConsumes) {
      if ((compiled.above[f] as number) !== 1 << f) {
        push(
          "error",
          "single-use",
          subject,
          `consumes "${name(f)}", which other facts rest on`,
        );
      }
      for (const g of bits(compiled.goal)) {
        if (((compiled.below[g] as number) & (1 << f)) !== 0) {
          push(
            "error",
            "single-use",
            subject,
            `consumes "${name(f)}", which the goal needs`,
          );
        }
      }
      for (const other of compiled.operators) {
        if (other.index !== op.index && (other.requires & (1 << f)) !== 0) {
          push(
            "error",
            "single-use",
            subject,
            `consumes "${name(f)}", which operator ${other.id} also needs`,
          );
        }
      }
    }
    for (const f of declaredConsumes) {
      const noticed = op.outcomes.some(
        (outcome) =>
          outcome.kind === "invalidates" && (outcome.facts & (1 << f)) !== 0,
      );
      if (!noticed) {
        push(
          "error",
          "consumed-detectable",
          subject,
          `consumes "${name(f)}" but declares no outcome that invalidates it; after a lost reply it could not tell the input was already spent`,
        );
      }
    }
    if ((op.consumes & op.establishes) !== 0) {
      push(
        "error",
        "consumes-established",
        subject,
        "consumes a fact that what it establishes cannot hold without",
      );
    }

    // A belief can go stale. Every requirement that rests on something the
    // environment can remove needs a declared way to say it is gone. Naming
    // only the volatile fact underneath is not enough: that fact can be made
    // again while what rested on its old instance stays gone.
    for (const r of bits(op.requires)) {
      if (((compiled.below[r] as number) & compiled.volatile) === 0) continue;
      const goneWith = (compiled.above[r] as number) & op.requires;
      const covered = op.outcomes.some(
        (outcome) =>
          outcome.kind === "invalidates" && (outcome.facts & goneWith) !== 0,
      );
      if (!covered) {
        push(
          "error",
          "stale-precondition",
          subject,
          `requires "${name(r)}", which can be lost, but declares no outcome that invalidates it`,
        );
      }
    }
    for (const outcome of op.outcomes) {
      if (outcome.kind !== "invalidates") continue;
      if (outcome.facts === 0) {
        push(
          "error",
          "outcome-reference",
          subject,
          `outcome "${outcome.tag}" invalidates nothing`,
        );
      }
      if (
        bits(outcome.facts).length > 1 &&
        (outcome.facts & ~compiled.observable) !== 0
      ) {
        push(
          "error",
          "ambiguous-invalidation",
          subject,
          `outcome "${outcome.tag}" names several facts, and one of them no probe can check; the controller could not tell which is really gone`,
        );
      }
      for (const f of bits(outcome.facts & ~op.requires)) {
        push(
          "error",
          "invalidates-required",
          subject,
          `outcome "${outcome.tag}" invalidates "${name(f)}", which the operator does not depend on`,
        );
      }
    }

    if (op.human) {
      const spec = declared.interface;
      if (spec === undefined) {
        push(
          "error",
          "interface-required",
          subject,
          "a human step needs an interface",
        );
      } else {
        const seen = new Set<string>();
        for (const action of spec.actions) {
          if (!(action.outcome in declared.outcomes)) {
            push(
              "error",
              "interface-outcome",
              subject,
              `action "${action.id}" reports undeclared outcome "${action.outcome}"`,
            );
          }
          if (seen.has(action.id)) {
            push(
              "error",
              "interface-outcome",
              subject,
              `duplicate action id "${action.id}"`,
            );
          }
          seen.add(action.id);
        }
        if (spec.actions.length === 0) {
          push(
            "error",
            "interface-outcome",
            subject,
            "the interface offers no action, so the person could never answer",
          );
        }
        for (const shown of spec.shows ?? []) {
          const f = compiled.factIndex.get(shown);
          if (f === undefined) {
            push(
              "error",
              "interface-shows",
              subject,
              `shows unknown fact "${shown}"`,
            );
          } else if ((compiled.secret & (1 << f)) !== 0) {
            push(
              "error",
              "secret-exposure",
              subject,
              `interface shows secret fact "${shown}"`,
            );
          } else if ((op.requires & (1 << f)) === 0) {
            push(
              "error",
              "interface-shows",
              subject,
              `shows "${shown}", which is not guaranteed to hold when the step runs`,
            );
          }
        }
      }
    } else if (declared.interface !== undefined) {
      push(
        "error",
        "interface-required",
        subject,
        "a machine step cannot have an interface",
      );
    }
  }

  for (const f of bits(compiled.discoverable & ~compiled.observable)) {
    push(
      "error",
      "discoverable-observable",
      `fact ${name(f)}`,
      "a fact a probe can find is a fact a probe can observe",
    );
  }
  for (const f of bits(compiled.observable)) {
    for (const hidden of bits(
      (compiled.below[f] as number) & ~compiled.observable,
    )) {
      push(
        "error",
        "observable-support",
        `fact ${name(f)}`,
        `can be observed but rests on "${name(hidden)}", which cannot; seeing one would mean believing the other unchecked`,
      );
    }
  }
  for (const factName of compiled.factNames) {
    if (factName.startsWith("#")) {
      push(
        "error",
        "fact-name",
        `fact ${factName}`,
        'fact names cannot start with "#"',
      );
    }
  }
  for (const f of bits(compiled.goal & ~compiled.observable)) {
    push(
      "warning",
      "repeatable-goal",
      `fact ${name(f)}`,
      "goal fact is not observable, so a second run cannot tell it is already done",
    );
  }
  for (let f = 0; f < compiled.factNames.length; f += 1) {
    const producible = compiled.operators.some(
      (op) => (op.establishes & (1 << f)) !== 0,
    );
    if (!producible && !(decl.facts[name(f)] as FactDecl).given) {
      push(
        "warning",
        "given-fact",
        `fact ${name(f)}`,
        "no operator establishes this fact; the ceremony can only succeed where it already holds",
      );
    }
  }
  return { issues, compiled };
}

export function defineCeremony<
  const F extends Facts,
  const O extends Record<
    string,
    OperatorDecl<
      keyof F & string,
      keyof F & string,
      Record<string, OutcomeDecl>,
      Actor
    >
  >,
>(decl: CeremonyDecl<F, O>): Ceremony<F, O> {
  const { issues, compiled } = validate(decl as unknown as CeremonyDecl);
  if (compiled === null || issues.some((issue) => issue.severity === "error")) {
    throw new CeremonyDefinitionError(decl.id, issues);
  }
  return {
    ...decl,
    compiled,
    warnings: issues.filter((issue) => issue.severity === "warning"),
  };
}

/**
 * A part of a ceremony: facts and operators with no goal of its own. Its
 * operators may name facts another part declares; `compose` checks the whole.
 */
export function fragment<
  const F extends Facts,
  const O extends Record<
    string,
    OperatorDecl<string, string, Record<string, OutcomeDecl>, Actor>
  >,
>(part: {
  readonly id: string;
  readonly facts: F;
  readonly operators: O;
}): CeremonyDecl<F, O> {
  return { ...part, title: part.id, goal: [] };
}

/**
 * Flows compose by union: shared fact names are the seams. The result is
 * re-validated, because two well-formed halves can still disagree.
 */
export function compose<
  const FA extends Facts,
  const OA extends Operators,
  const FB extends Facts,
  const OB extends Operators,
>(
  spec: {
    readonly id: string;
    readonly title: string;
    readonly goal: readonly (keyof (FA & FB) & string)[];
  },
  a: CeremonyDecl<FA, OA>,
  b: CeremonyDecl<FB, OB>,
): Ceremony<FA & FB, OA & OB> {
  const issues: Issue[] = [];
  for (const [name, declared] of Object.entries(b.facts)) {
    const other = a.facts[name];
    if (other === undefined) continue;
    const same =
      other.volatile === declared.volatile &&
      other.observable === declared.observable &&
      other.discoverable === declared.discoverable &&
      other.secret === declared.secret &&
      other.requires.length === declared.requires.length &&
      other.requires.every((item) => declared.requires.includes(item));
    if (!same) {
      issues.push({
        severity: "error",
        rule: "compose-fact",
        subject: `fact ${name}`,
        message: `"${a.id}" and "${b.id}" declare it differently`,
      });
    }
  }
  for (const id of Object.keys(b.operators)) {
    if (id in a.operators && a.operators[id] !== b.operators[id]) {
      issues.push({
        severity: "error",
        rule: "compose-operator",
        subject: `operator ${id}`,
        message: `"${a.id}" and "${b.id}" both define it`,
      });
    }
  }
  if (issues.length > 0) throw new CeremonyDefinitionError(spec.id, issues);
  const probeAttempts = Math.max(
    a.probeAttempts ?? DEFAULT_PROBE_ATTEMPTS,
    b.probeAttempts ?? DEFAULT_PROBE_ATTEMPTS,
  );
  const merged = {
    id: spec.id,
    title: spec.title,
    facts: { ...a.facts, ...b.facts },
    operators: { ...a.operators, ...b.operators },
    goal: spec.goal,
    probeAttempts,
    staleReports: Math.max(
      a.staleReports ?? DEFAULT_STALE_REPORTS,
      b.staleReports ?? DEFAULT_STALE_REPORTS,
    ),
  };
  return defineCeremony(merged as never) as unknown as Ceremony<
    FA & FB,
    OA & OB
  >;
}
