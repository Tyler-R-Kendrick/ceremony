/**
 * Four readings of the same layout program.
 *
 * `exact` is what the renderer draws. `soft` replaces every kink with a
 * smooth curve, so a layout can animate through its own breakpoints. `dual`
 * carries a gradient, so a design can be tuned against every device at once.
 * `interval` carries a lower and an upper bound, so a rule can be shown to
 * hold for every input in a range rather than for the ones someone tried.
 */
import type { Algebra } from "./tape.js";

export const exact: Algebra<number> = {
  constant: (value) => value,
  sum: (terms, bias) => {
    let total = bias;
    for (const [weight, value] of terms) total += weight * value;
    return total;
  },
  mul: (a, b) => a * b,
  relu: (a) => (a > 0 ? a : 0),
  step: (a) => (a >= 0 ? 1 : 0),
  // A maximum built from a ReLU rounds: `b + relu(a - b)` is not exactly
  // `a`. The renderer takes the operand itself, which is what the node means
  // and what the interval reading bounds.
  refine: (value, hint, at) => {
    if (hint.kind === "blend") {
      const gate = at(hint.gate);
      if (gate === 1) return at(hint.then);
      return gate === 0 ? at(hint.otherwise) : value;
    }
    return hint.kind === "max"
      ? Math.max(at(hint.a), at(hint.b))
      : Math.min(at(hint.a), at(hint.b));
  },
};

/** Every kink smoothed; `sharpness` goes to infinity as the layout hardens. */
export function soft(sharpness: number): Algebra<number> {
  return {
    constant: exact.constant,
    sum: exact.sum,
    mul: exact.mul,
    relu: (a) => {
      const scaled = sharpness * a;
      return scaled > 30 ? a : Math.log1p(Math.exp(scaled)) / sharpness;
    },
    step: (a) => 1 / (1 + Math.exp(-sharpness * a)),
  };
}

export interface Dual {
  readonly value: number;
  /** One partial derivative per input, in the order given to `dual`. */
  readonly gradient: readonly number[];
}

/** Forward-mode differentiation over `size` inputs. */
export function dual(size: number): Algebra<Dual> & {
  variable(value: number, index: number): Dual;
} {
  const zero = (): number[] => new Array<number>(size).fill(0);
  return {
    variable: (value, index) => {
      const gradient = zero();
      gradient[index] = 1;
      return { value, gradient };
    },
    constant: (value) => ({ value, gradient: zero() }),
    sum: (terms, bias) => {
      let value = bias;
      const gradient = zero();
      for (const [weight, term] of terms) {
        value += weight * term.value;
        for (let i = 0; i < size; i += 1) {
          gradient[i] =
            (gradient[i] as number) + weight * (term.gradient[i] as number);
        }
      }
      return { value, gradient };
    },
    mul: (a, b) => ({
      value: a.value * b.value,
      gradient: a.gradient.map(
        (da, i) => da * b.value + a.value * (b.gradient[i] as number),
      ),
    }),
    relu: (a) => (a.value > 0 ? a : { value: 0, gradient: zero() }),
    step: (a) => ({ value: a.value >= 0 ? 1 : 0, gradient: zero() }),
    refine: (value, hint, at) => {
      if (hint.kind === "blend") {
        const gate = at(hint.gate).value;
        if (gate === 1) return at(hint.then);
        return gate === 0 ? at(hint.otherwise) : value;
      }
      const a = at(hint.a);
      const b = at(hint.b);
      if (hint.kind === "max") return a.value >= b.value ? a : b;
      return a.value <= b.value ? a : b;
    },
  };
}

export interface Interval {
  readonly lo: number;
  readonly hi: number;
}

const float = new Float64Array(1);
const bitsOf = new BigInt64Array(float.buffer);

/** The next representable number above `x`. */
export function nextUp(x: number): number {
  if (Number.isNaN(x) || x === Infinity) return x;
  if (x === 0) return Number.MIN_VALUE;
  float[0] = x;
  bitsOf[0] = (bitsOf[0] as bigint) + (x > 0 ? 1n : -1n);
  return float[0] as number;
}

/** The next representable number below `x`. */
export function nextDown(x: number): number {
  return -nextUp(-x);
}

const widen = (lo: number, hi: number): Interval => ({
  lo: nextDown(lo),
  hi: nextUp(hi),
});

export const point = (x: number): Interval => ({ lo: x, hi: x });

/**
 * Bounds that hold for the arithmetic the renderer really does. Each result
 * is widened by one representable number on each side, so the bound contains
 * the real-number answer and the rounded floating-point one alike.
 */
export const interval: Algebra<Interval> = {
  constant: point,
  sum: (terms, bias) => {
    let lo = bias;
    let hi = bias;
    for (const [weight, term] of terms) {
      const a = weight * term.lo;
      const b = weight * term.hi;
      lo = nextDown(lo + nextDown(Math.min(a, b)));
      hi = nextUp(hi + nextUp(Math.max(a, b)));
    }
    return { lo, hi };
  },
  mul: (a, b) => {
    const products = [a.lo * b.lo, a.lo * b.hi, a.hi * b.lo, a.hi * b.hi];
    return widen(Math.min(...products), Math.max(...products));
  },
  relu: (a) => ({ lo: a.lo > 0 ? a.lo : 0, hi: a.hi > 0 ? a.hi : 0 }),
  step: (a) => ({ lo: a.lo >= 0 ? 1 : 0, hi: a.hi >= 0 ? 1 : 0 }),
  // Both the computed bound and the bound read off the intent contain the
  // value, so their overlap does too.
  refine: (value, hint, at) => {
    let tight: Interval;
    if (hint.kind === "blend") {
      const gate = at(hint.gate);
      const then = at(hint.then);
      const otherwise = at(hint.otherwise);
      if (gate.lo < 0 || gate.hi > 1) return value;
      tight =
        gate.lo >= 1
          ? then
          : gate.hi <= 0
            ? otherwise
            : {
                lo: Math.min(then.lo, otherwise.lo),
                hi: Math.max(then.hi, otherwise.hi),
              };
    } else {
      const a = at(hint.a);
      const b = at(hint.b);
      tight =
        hint.kind === "max"
          ? { lo: Math.max(a.lo, b.lo), hi: Math.max(a.hi, b.hi) }
          : { lo: Math.min(a.lo, b.lo), hi: Math.min(a.hi, b.hi) };
    }
    const lo = Math.max(value.lo, nextDown(tight.lo));
    const hi = Math.min(value.hi, nextUp(tight.hi));
    return lo <= hi ? { lo, hi } : value;
  },
};

/** A bound on a value together with a bound on each of its partial derivatives. */
export interface Slope {
  readonly value: Interval;
  readonly gradient: readonly Interval[];
}

const ZERO: Interval = { lo: 0, hi: 0 };

const plus = (a: Interval, b: Interval): Interval =>
  widen(a.lo + b.lo, a.hi + b.hi);

/**
 * Bounds on the derivatives over a whole range, for the mean-value bound in
 * prove.ts. A step contributes no slope, which is only right where the step
 * does not change inside the range; the prover uses this reading only there.
 */
export function slopes(size: number): Algebra<Slope> & {
  variable(range: Interval, index: number): Slope;
} {
  const flat = (): Interval[] => new Array<Interval>(size).fill(ZERO);
  return {
    variable: (range, index) => {
      const gradient = flat();
      gradient[index] = point(1);
      return { value: range, gradient };
    },
    constant: (value) => ({ value: point(value), gradient: flat() }),
    sum: (terms, bias) => ({
      value: interval.sum(
        terms.map(([weight, term]) => [weight, term.value]),
        bias,
      ),
      gradient: flat().map((_, i) =>
        interval.sum(
          terms.map(([weight, term]) => [weight, term.gradient[i] as Interval]),
          0,
        ),
      ),
    }),
    mul: (a, b) => ({
      value: interval.mul(a.value, b.value),
      gradient: a.gradient.map((da, i) =>
        plus(
          interval.mul(da, b.value),
          interval.mul(a.value, b.gradient[i] as Interval),
        ),
      ),
    }),
    relu: (a) => {
      if (a.value.lo > 0) return a;
      if (a.value.hi <= 0) return { value: ZERO, gradient: flat() };
      return {
        value: interval.relu(a.value),
        gradient: a.gradient.map((g) => ({
          lo: Math.min(0, g.lo),
          hi: Math.max(0, g.hi),
        })),
      };
    },
    step: (a) => ({ value: interval.step(a.value), gradient: flat() }),
    refine: (value, hint, at) => ({
      value: (interval.refine as NonNullable<typeof interval.refine>)(
        value.value,
        hint,
        (ref) => at(ref).value,
      ),
      gradient: value.gradient,
    }),
  };
}
