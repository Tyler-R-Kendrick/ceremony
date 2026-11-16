import assert from "node:assert/strict";
import fc from "fast-check";
import {
  validate,
  type Ceremony,
  type CeremonyDecl,
  type FactDecl,
  type OperatorDecl,
  type OutcomeDecl,
} from "../../src/kernel/index.js";

export const options = {
  seed: Number(process.env.FUZZ_SEED ?? 20261116),
  numRuns: Number(process.env.FUZZ_RUNS ?? 200),
};
assert.ok(Number.isInteger(options.seed));
assert.ok(Number.isInteger(options.numRuns) && options.numRuns > 0);

/** Compile a declaration without refusing it, to show what each lint rule prevents. */
export function unchecked(decl: CeremonyDecl): Ceremony {
  const { compiled } = validate(decl);
  assert.ok(compiled !== null);
  return { ...decl, compiled, warnings: [] };
}

interface FactShape {
  readonly requires: readonly number[];
  readonly volatile: boolean;
  readonly observable: boolean;
  readonly discoverable: boolean;
}

interface OperatorShape {
  readonly establishes: number;
  readonly alsoEstablishes: number | null;
  readonly requires: readonly number[];
  readonly consumesFirst: boolean;
  readonly human: boolean;
  readonly idempotent: boolean;
  readonly cost: number;
  readonly attempts: number;
  readonly extras: readonly ("retry" | "unsure" | "blocked" | "terminal")[];
}

const factName = (index: number): string => `f${index}`;

function closure(
  facts: readonly FactShape[],
  seed: readonly number[],
): number[] {
  const out = new Set<number>();
  const visit = (f: number): void => {
    if (out.has(f)) return;
    out.add(f);
    for (const dep of (facts[f] as FactShape).requires) visit(dep);
  };
  for (const f of seed) visit(f);
  return [...out];
}

function dependents(facts: readonly FactShape[], f: number): number[] {
  return facts
    .map((_, index) => index)
    .filter((index) => closure(facts, [index]).includes(f));
}

function build(
  facts: readonly FactShape[],
  operators: readonly OperatorShape[],
  goal: readonly number[],
): CeremonyDecl {
  const factDecls: Record<string, FactDecl> = {};
  // What can be observed rests only on what can be observed.
  const visible: boolean[] = [];
  facts.forEach((shape, index) => {
    visible[index] =
      shape.observable && shape.requires.every((dep) => visible[dep] === true);
  });
  facts.forEach((shape, index) => {
    factDecls[factName(index)] = {
      description: factName(index),
      requires: shape.requires.map(factName),
      volatile: shape.volatile,
      observable: visible[index] === true,
      discoverable: visible[index] === true && shape.discoverable,
      secret: false,
      given: false,
      value: {},
    };
  });
  const operatorDecls: Record<string, OperatorDecl> = {};
  const shapes = operators.map((shape) => {
    const establishes = [
      ...new Set(
        shape.alsoEstablishes === null
          ? [shape.establishes]
          : [shape.establishes, shape.alsoEstablishes],
      ),
    ];
    const requires = shape.requires.filter((f) => !establishes.includes(f));
    const needed = closure(facts, [
      ...requires,
      ...closure(facts, establishes).filter((f) => !establishes.includes(f)),
    ]);
    return { shape, establishes, requires, needed };
  });
  const goalNeeds = closure(facts, goal);
  shapes.forEach(({ shape, establishes, requires, needed }, index) => {
    // A single-use fact is an input to exactly one step: not a goal, nothing
    // rests on it, and no other operator reads it.
    const first = requires[0];
    const consumes =
      shape.consumesFirst &&
      first !== undefined &&
      dependents(facts, first).length === 1 &&
      !goalNeeds.includes(first) &&
      shapes.every((other, at) => at === index || !other.needed.includes(first))
        ? [first]
        : [];
    const outcomes: Record<string, OutcomeDecl> = {
      ok: { effect: { kind: "established" }, description: "ok" },
    };
    for (const extra of new Set(shape.extras)) {
      outcomes[extra] =
        extra === "terminal"
          ? {
              effect: { kind: "terminal", reason: `stop-${index}` },
              description: extra,
            }
          : { effect: { kind: extra }, description: extra };
    }
    for (const f of needed) {
      if (
        consumes.includes(f) ||
        closure(facts, [f]).some((g) => (facts[g] as FactShape).volatile)
      ) {
        outcomes[`lost-${factName(f)}`] = {
          effect: { kind: "invalidates", facts: [factName(f)] },
          description: "stale",
        };
      }
    }
    operatorDecls[`op${index}`] = {
      description: `op${index}`,
      establishes: establishes.map(factName),
      requires: requires.map(factName),
      consumes: consumes.map(factName),
      actor: shape.human ? "human" : "machine",
      idempotent: shape.idempotent,
      cost: shape.cost,
      attempts: shape.attempts,
      outcomes,
      ...(shape.human
        ? {
            interface: {
              title: `op${index}`,
              body: "",
              actions: [
                { id: "go", label: "Go", outcome: "ok", emphasis: "primary" },
              ],
            },
          }
        : {}),
    };
  });
  return {
    id: "generated",
    title: "generated",
    facts: factDecls,
    operators: operatorDecls,
    goal: [...new Set(goal)].map(factName),
  };
}

/** Random declarations that pass every lint rule. */
export const wellFormedDecl: fc.Arbitrary<CeremonyDecl> = fc
  .integer({ min: 2, max: 5 })
  .chain((count) => {
    const fact = (index: number): fc.Arbitrary<FactShape> =>
      fc.record({
        requires:
          index === 0
            ? fc.constant([])
            : fc.uniqueArray(fc.integer({ min: 0, max: index - 1 }), {
                maxLength: 2,
              }),
        volatile: fc.boolean(),
        observable: fc.boolean(),
        discoverable: fc.boolean(),
      });
    const op = (establishes: number): fc.Arbitrary<OperatorShape> =>
      fc.record({
        establishes: fc.constant(establishes),
        alsoEstablishes: fc.option(fc.integer({ min: 0, max: count - 1 }), {
          freq: 5,
          nil: null,
        }),
        requires: fc.uniqueArray(fc.integer({ min: 0, max: count - 1 }), {
          maxLength: 2,
        }),
        consumesFirst: fc.boolean(),
        human: fc.boolean(),
        idempotent: fc.boolean(),
        cost: fc.integer({ min: 1, max: 5 }),
        attempts: fc.integer({ min: 1, max: 3 }),
        extras: fc.array(
          fc.constantFrom(
            "retry" as const,
            "unsure" as const,
            "blocked" as const,
            "terminal" as const,
          ),
          { maxLength: 3 },
        ),
      });
    return fc
      .record({
        facts: fc.tuple(
          ...Array.from({ length: count }, (_, index) => fact(index)),
        ),
        base: fc.tuple(
          ...Array.from({ length: count }, (_, index) => op(index)),
        ),
        spare: fc.array(
          fc.integer({ min: 0, max: count - 1 }).chain((index) => op(index)),
          { maxLength: 3 },
        ),
        goal: fc.uniqueArray(fc.integer({ min: 0, max: count - 1 }), {
          minLength: 1,
          maxLength: 2,
        }),
      })
      .map(({ facts, base, spare, goal }) =>
        build(facts, [...base, ...spare], goal),
      );
  })
  .filter(
    (decl) =>
      !validate(decl).issues.some((issue) => issue.severity === "error"),
  );

/**
 * Cheapest total cost to reach the goal, computed without the planner: a plain
 * relaxation over every set of facts, written against the declaration's names.
 */
export function cheapestCost(
  decl: CeremonyDecl,
  held: readonly string[],
): number {
  const names = Object.keys(decl.facts);
  const below = (seed: readonly string[]): Set<string> => {
    const out = new Set<string>();
    const visit = (name: string): void => {
      if (out.has(name)) return;
      out.add(name);
      for (const dep of (decl.facts[name] as FactDecl).requires) visit(dep);
    };
    for (const name of seed) visit(name);
    return out;
  };
  const above = (name: string): string[] =>
    names.filter((other) => below([other]).has(name));
  const encode = (set: ReadonlySet<string>): number =>
    names.reduce(
      (mask, name, i) => (set.has(name) ? mask | (1 << i) : mask),
      0,
    );
  const decode = (mask: number): Set<string> =>
    new Set(names.filter((_, i) => (mask & (1 << i)) !== 0));
  const size = 1 << names.length;
  const cost = new Array<number>(size).fill(Infinity);
  for (let mask = 0; mask < size; mask += 1) {
    if (decl.goal.every((name) => decode(mask).has(name))) cost[mask] = 0;
  }
  const moves = Object.values(decl.operators).map((op) => {
    const needs = below([
      ...op.requires,
      ...[...below(op.establishes)].filter(
        (name) => !op.establishes.includes(name),
      ),
    ]);
    const removes = new Set(op.consumes.flatMap((name) => above(name)));
    return { op, needs, removes };
  });
  for (let changed = true; changed;) {
    changed = false;
    for (let mask = 0; mask < size; mask += 1) {
      const state = decode(mask);
      for (const { op, needs, removes } of moves) {
        if ([...needs].some((name) => !state.has(name))) continue;
        const next = new Set([...state].filter((name) => !removes.has(name)));
        for (const name of op.establishes) next.add(name);
        const through = op.cost + (cost[encode(next)] as number);
        if (through < (cost[mask] as number)) {
          cost[mask] = through;
          changed = true;
        }
      }
    }
  }
  return cost[encode(below(held))] as number;
}

/**
 * What a starting controller can know of a world: all of it. Probes see what
 * can be observed, and the rest it already holds.
 */
export function knowable(
  decl: CeremonyDecl,
  world: readonly string[],
): string[] {
  const out = new Set<string>();
  const visit = (name: string): void => {
    if (out.has(name)) return;
    out.add(name);
    for (const dep of (decl.facts[name] as FactDecl).requires) visit(dep);
  };
  for (const name of world) visit(name);
  return [...out];
}
