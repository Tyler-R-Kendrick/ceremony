/**
 * Prove that a quantity of a layout never goes below zero, for every input in
 * a range.
 *
 * Bound the quantity over the whole range with interval arithmetic. If the
 * lower bound is zero or more, the rule holds there. If the exact value at
 * some point is negative, that point is a counterexample. Otherwise split the
 * range and repeat on each half.
 *
 * A range that straddles a breakpoint is handled by cases: once assuming the
 * step is 0 and once assuming it is 1. Every point of the range is in one of
 * the two cases, and a case the range contradicts is dropped. This is what
 * keeps a bound from pairing the size from one side of a breakpoint with the
 * position from the other.
 */
import {
  exact,
  interval,
  nextDown,
  point,
  slopes,
  type Interval,
  type Slope,
} from "./algebras.js";
import { run, type Ref, type Tape } from "./tape.js";

/** Straddled breakpoints a range may be split into cases on, at most. */
const CASES = 4;

export type Domain = Readonly<Record<string, readonly [number, number]>>;

export type Proof =
  | { readonly status: "proved"; readonly boxes: number }
  | {
      readonly status: "refuted";
      /** Which of the quantities went negative. */
      readonly quantity: number;
      /** Inputs at which the quantity is negative. */
      readonly at: Readonly<Record<string, number>>;
      readonly value: number;
      readonly boxes: number;
    }
  | {
      readonly status: "undecided";
      readonly quantity: number;
      /** A range too small to split further where the bound is still negative. */
      readonly within: Domain;
      readonly boxes: number;
    };

export interface ProveOptions {
  readonly maxBoxes?: number;
  /** Stop splitting an input below this fraction of its original range. */
  readonly resolution?: number;
}

/** Several quantities at once: each range is bounded once for all of them. */
export function prove(
  tape: Tape,
  quantities: Ref | readonly Ref[],
  domain: Domain,
  options: ProveOptions = {},
): Proof {
  const wanted = typeof quantities === "number" ? [quantities] : quantities;
  const maxBoxes = options.maxBoxes ?? 200_000;
  const resolution = options.resolution ?? 1e-7;
  const names = Object.keys(domain);
  const span = (name: string): number => {
    const [lo, hi] = domain[name] as readonly [number, number];
    return hi - lo;
  };

  const gates: Ref[] = [];
  tape.nodes.forEach((node, index) => {
    if (node.op === "step") gates.push(index as Ref);
  });
  const argument = (gate: Ref): Ref => {
    const node = tape.nodes[gate];
    return node?.op === "step" ? node.a : gate;
  };

  interface Task {
    readonly box: Record<string, Interval>;
    readonly assumed: ReadonlyMap<Ref, Interval>;
  }

  const slope = slopes(names.length);
  /** Lower bounds by the mean-value form: value at the centre plus slope times reach. */
  const centred = (
    box: Record<string, Interval>,
    assumed: ReadonlyMap<Ref, Interval>,
  ): number[] => {
    const centre: Record<string, Interval> = {};
    const ranged: Record<string, Slope> = {};
    names.forEach((name, index) => {
      const side = box[name] as Interval;
      centre[name] = point(side.lo + (side.hi - side.lo) / 2);
      ranged[name] = slope.variable(side, index);
    });
    const fixed = new Map<Ref, Slope>();
    for (const [gate, value] of assumed) {
      fixed.set(gate, { value, gradient: names.map(() => point(0)) });
    }
    const middle = run(tape, interval, centre, assumed);
    const across = run(tape, slope, ranged, fixed);
    return wanted.map((quantity) => {
      let lower = (middle[quantity] as Interval).lo;
      names.forEach((name, index) => {
        const side = box[name] as Interval;
        const at = (centre[name] as Interval).lo;
        const g = (across[quantity] as Slope).gradient[index] as Interval;
        const reach = interval.mul(g, { lo: side.lo - at, hi: side.hi - at });
        lower = nextDown(lower + reach.lo);
      });
      return lower;
    });
  };
  const stack: Task[] = [
    {
      box: Object.fromEntries(
        names.map((name) => {
          const [lo, hi] = domain[name] as readonly [number, number];
          return [name, { lo, hi }];
        }),
      ),
      assumed: new Map(),
    },
  ];
  let boxes = 0;
  while (stack.length > 0) {
    const { box, assumed } = stack.pop() as Task;
    boxes += 1;
    const bounds = run(tape, interval, box, assumed);
    // An assumption no point of the range satisfies leaves nothing to prove.
    let vacuous = false;
    for (const [gate, value] of assumed) {
      const reach = bounds[argument(gate)] as Interval;
      if (
        (value.lo === 1 && reach.hi < 0) ||
        (value.hi === 0 && reach.lo >= 0)
      ) {
        vacuous = true;
      }
    }
    if (vacuous) continue;
    let open = wanted.findIndex(
      (quantity) => (bounds[quantity] as Interval).lo < 0,
    );
    if (open < 0) continue;

    const straddled = gates.filter((gate) => {
      if (assumed.has(gate)) return false;
      const reach = bounds[argument(gate)] as Interval;
      return reach.lo < 0 && reach.hi >= 0;
    });
    if (straddled.length === 0) {
      const lower = centred(box, assumed);
      open = wanted.findIndex(
        (quantity, index) =>
          Math.max((bounds[quantity] as Interval).lo, lower[index] as number) <
          0,
      );
      if (open < 0) continue;
    }

    const corners: Record<string, number>[] = [
      Object.fromEntries(
        names.map((name) => {
          const side = box[name] as Interval;
          return [name, side.lo + (side.hi - side.lo) / 2];
        }),
      ),
      Object.fromEntries(
        names.map((name) => [name, (box[name] as Interval).lo]),
      ),
      Object.fromEntries(
        names.map((name) => [name, (box[name] as Interval).hi]),
      ),
    ];
    for (const at of corners) {
      const values = run(tape, exact, at);
      const broken = wanted.findIndex(
        (quantity) => (values[quantity] as number) < 0,
      );
      if (broken >= 0) {
        return {
          status: "refuted",
          quantity: broken,
          at,
          value: values[wanted[broken] as Ref] as number,
          boxes,
        };
      }
    }

    const first = straddled[0];
    if (first !== undefined && straddled.length <= CASES) {
      stack.push({ box, assumed: new Map(assumed).set(first, point(0)) });
      stack.push({ box, assumed: new Map(assumed).set(first, point(1)) });
      continue;
    }

    let widest = "";
    let widestShare = resolution;
    for (const name of names) {
      const side = box[name] as Interval;
      const share = span(name) === 0 ? 0 : (side.hi - side.lo) / span(name);
      if (share > widestShare) {
        widest = name;
        widestShare = share;
      }
    }
    if (widest === "" || boxes >= maxBoxes) {
      return {
        status: "undecided",
        quantity: open,
        within: Object.fromEntries(
          names.map((name) => {
            const side = box[name] as Interval;
            return [name, [side.lo, side.hi] as const];
          }),
        ),
        boxes,
      };
    }
    const side = box[widest] as Interval;
    const middle = side.lo + (side.hi - side.lo) / 2;
    stack.push({
      box: { ...box, [widest]: { lo: side.lo, hi: middle } },
      assumed,
    });
    stack.push({
      box: { ...box, [widest]: { lo: middle, hi: side.hi } },
      assumed,
    });
  }
  return { status: "proved", boxes };
}
