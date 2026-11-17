/**
 * The interface prover and the readings it rests on, case by case: what a
 * proof, a refutation and an undecided answer each say, and the arithmetic
 * of each reading at the points where it changes.
 */
import assert from "node:assert/strict";
import test from "node:test";
import {
  dual,
  exact,
  interval,
  nextDown,
  nextUp,
  point,
  slopes,
  soft,
  type Interval,
} from "../../src/kernel/interface/algebras.js";
import { prove } from "../../src/kernel/interface/prove.js";
import { run, Tape, type Ref } from "../../src/kernel/interface/tape.js";

/** `(x - 0.5)²`, never negative, but a range bound alone cannot see it near 0.5. */
function square(): { tape: Tape; out: Ref } {
  const tape = new Tape();
  const shifted = tape.affine(tape.input("x"), 1, -0.5);
  return { tape, out: tape.mul(shifted, shifted) };
}

test("a range out of order or not finite is refused", () => {
  const tape = new Tape();
  const out = tape.affine(tape.input("x"), 1, 0);
  for (const range of [
    [1, 0],
    [Number.NaN, 1],
    [0, Number.NaN],
    [0, Infinity],
    [-Infinity, 0],
  ] as const) {
    assert.throws(
      () => prove(tape, out, { x: range }),
      (error: unknown) =>
        error instanceof RangeError && /"x" must be finite/.test(error.message),
    );
  }
  // A range of one point is in order.
  assert.deepEqual(prove(tape, out, { x: [2, 2] }), {
    status: "proved",
    boxes: 1,
  });
});

test("a quantity that holds on its whole range by its bound alone is proved in one box", () => {
  const tape = new Tape();
  const out = tape.affine(tape.input("x"), 2, 1);
  assert.deepEqual(prove(tape, out, { x: [0, 10] }), {
    status: "proved",
    boxes: 1,
  });
});

test("a quantity negative at the middle, the low or the high end is refuted there", () => {
  const tape = new Tape();
  const x = tape.input("x");
  // Negative only near the middle of [0, 10].
  const middle = tape.sum([[1, tape.relu(tape.affine(x, 1, -6))]], 0);
  const dip = tape.add(middle, tape.relu(tape.affine(x, -1, 4)), -0.5);
  const atMiddle = prove(tape, dip, { x: [0, 10] });
  assert.equal(atMiddle.status, "refuted");
  assert.ok(atMiddle.status === "refuted");
  assert.deepEqual(atMiddle.at, { x: 5 });
  assert.equal(atMiddle.value, -0.5);
  assert.equal(atMiddle.quantity, 0);

  const rising = tape.affine(x, 1, -1);
  const low = prove(tape, rising, { x: [0, 10] });
  assert.ok(low.status === "refuted");
  // The middle is not negative, so the low end is the witness.
  assert.deepEqual(low.at, { x: 0 });
  assert.equal(low.value, -1);

  const falling = tape.affine(x, -1, 9);
  const high = prove(tape, falling, { x: [0, 10] });
  assert.ok(high.status === "refuted");
  assert.deepEqual(high.at, { x: 10 });
  assert.equal(high.value, -1);
});

test("of several quantities, the refutation names the one that went negative", () => {
  const tape = new Tape();
  const x = tape.input("x");
  const fine = tape.affine(x, 1, 1);
  const broken = tape.affine(x, 1, -3);
  const proof = prove(tape, [fine, broken], { x: [0, 2] });
  assert.ok(proof.status === "refuted");
  assert.equal(proof.quantity, 1);
  assert.equal(proof.value, -2);
  // Each quantity is checked: one that holds does not hide one that fails.
  const both = prove(tape, [broken, fine], { x: [0, 2] });
  assert.ok(both.status === "refuted");
  assert.equal(both.quantity, 0);
  assert.equal(prove(tape, [fine, fine], { x: [0, 2] }).status, "proved");
});

test("a bound that is not a number is open, not proved", () => {
  const tape = new Tape();
  const x = tape.input("x");
  // 0 * Infinity has no value; the quantity cannot be called non-negative.
  const out = tape.mul(x, tape.affine(x, 0, Infinity));
  const proof = prove(tape, out, { x: [0, 1] }, { maxBoxes: 20 });
  assert.notEqual(proof.status, "proved");
});

test("where the bound stays negative but no point is, the prover splits to its resolution and says so", () => {
  const { tape, out } = square();
  const proof = prove(tape, out, { x: [0, 1] }, { resolution: 1 / 64 });
  assert.equal(proof.status, "undecided");
  assert.ok(proof.status === "undecided");
  assert.equal(proof.quantity, 0);
  const [lo, hi] = proof.within.x as readonly [number, number];
  assert.ok(lo <= 0.5 && 0.5 <= hi, `[${lo}, ${hi}] does not hold 0.5`);
  assert.ok(hi - lo <= 1 / 64 && hi - lo > 0);
  // It halved its way there: each split adds two boxes along one path.
  assert.ok(proof.boxes > 6 && proof.boxes < 64, `${proof.boxes} boxes`);
});

test("the prover stops at its box budget with the range it was working on", () => {
  const { tape, out } = square();
  const proof = prove(tape, out, { x: [0, 1] }, { maxBoxes: 1 });
  assert.deepEqual(proof, {
    status: "undecided",
    quantity: 0,
    within: { x: [0, 1] },
    boxes: 1,
  });
  const more = prove(tape, out, { x: [0, 1] }, { maxBoxes: 5 });
  assert.ok(more.status === "undecided");
  // A box proved on the way does not split, so the budget can be passed by one.
  assert.ok(more.boxes >= 5 && more.boxes <= 6, `${more.boxes} boxes`);
});

test("by default the prover splits far finer than a test resolution", () => {
  const { tape, out } = square();
  const proof = prove(tape, out, { x: [0, 1] });
  assert.ok(proof.status === "undecided");
  const [lo, hi] = proof.within.x as readonly [number, number];
  assert.ok(hi - lo <= 1e-7 && hi - lo > 1e-9);
});

test("an input with an empty range is never split", () => {
  const { tape, out } = square();
  // A single point whose bound, rounded outward, dips below zero: there is
  // nothing to split, so the answer is undecided at once.
  assert.deepEqual(prove(tape, out, { x: [0.5, 0.5] }), {
    status: "undecided",
    quantity: 0,
    within: { x: [0.5, 0.5] },
    boxes: 1,
  });
  const tape2 = new Tape();
  const y = tape2.input("y");
  const z = tape2.input("z");
  const shifted = tape2.affine(y, 1, -0.5);
  const q = tape2.add(tape2.mul(shifted, shifted), z);
  const undecided = prove(
    tape2,
    q,
    { y: [0, 1], z: [0, 0] },
    {
      resolution: 1 / 16,
    },
  );
  assert.ok(undecided.status === "undecided");
  assert.deepEqual(undecided.within.z, [0, 0]);
});

test("the mean-value bound proves what the plain bound cannot, without splitting", () => {
  // x² - 2x + 1.01 = (x - 1)² + 0.01 on [0.99, 1.01]. The plain bound pairs
  // the smallest square with the largest 2x and goes negative; the bound from
  // the centre and the slope does not.
  const tape = new Tape();
  const x = tape.input("x");
  const q = tape.sum(
    [
      [1, tape.mul(x, x)],
      [-2, x],
    ],
    1.01,
  );
  const plain = run(tape, interval, { x: { lo: 0.99, hi: 1.01 } })[
    q
  ] as Interval;
  assert.ok(plain.lo < 0);
  assert.deepEqual(prove(tape, q, { x: [0.99, 1.01] }), {
    status: "proved",
    boxes: 1,
  });
});

test("a straddled breakpoint is settled by cases, and a case the range contradicts is dropped", () => {
  // Where x ≥ 0 the quantity is x + 1; elsewhere it is 1 - x. Never below 1.
  const tape = new Tape();
  const x = tape.input("x");
  const abs = tape.when(x, tape.affine(x, 1, 1), tape.affine(x, -1, 1));
  assert.equal(prove(tape, abs, { x: [-3, 5] }).status, "proved");
  // Wrong on one side: refuted, at a point on that side.
  const wrong = tape.when(x, tape.affine(x, -1, 1), tape.affine(x, 1, 1));
  const proof = prove(tape, wrong, { x: [-3, 5] });
  assert.ok(proof.status === "refuted");
  assert.ok(proof.value < 0);
});

test("more straddled breakpoints than the case limit are split by range instead", () => {
  const tape = new Tape();
  const x = tape.input("x");
  // Five gates all straddled on [-1, 1]; their count plus a half is positive.
  const gates = [0, 0.1, 0.2, 0.3, 0.4].map((at) =>
    tape.step(tape.affine(x, 1, -at)),
  );
  const count = tape.sum(
    gates.map((gate) => [1, gate] as const),
    0.5,
  );
  assert.equal(prove(tape, count, { x: [-1, 1] }).status, "proved");
  const short = tape.sum(
    gates.map((gate) => [1, gate] as const),
    -0.5,
  );
  const proof = prove(tape, short, { x: [-1, 1] });
  assert.ok(proof.status === "refuted");
  assert.ok((proof.at.x as number) < 0);
  assert.equal(proof.value, -0.5);
});

test("rounding outward never stays put and leaves infinity and NaN alone", () => {
  assert.equal(nextUp(Infinity), Infinity);
  assert.ok(Number.isNaN(nextUp(Number.NaN)));
  assert.equal(nextDown(-Infinity), -Infinity);
  assert.equal(nextUp(-1), -1 + Number.EPSILON / 2);
  assert.equal(nextDown(1), 1 - Number.EPSILON / 2);
  assert.equal(nextUp(-Number.MAX_VALUE) > -Number.MAX_VALUE, true);
  assert.equal(nextUp(Number.MAX_VALUE), Infinity);
});

test("the exact reading draws what each node means", () => {
  const tape = new Tape();
  const a = tape.input("a");
  const b = tape.input("b");
  const max = tape.max(a, b);
  const min = tape.min(a, b);
  const gate = tape.step(a);
  const blend = tape.blend(gate, b, tape.affine(b, 2, 0));
  const r = tape.relu(a);
  const prod = tape.mul(a, b);
  const values = (x: number, y: number): number[] =>
    run(tape, exact, { a: x, b: y });
  // The renderer takes the operand itself, so a max of 0.1 and 0.3 is 0.3.
  assert.equal(values(0.1, 0.3)[max], 0.3);
  assert.equal(values(0.3, 0.1)[max], 0.3);
  assert.equal(values(0.1, 0.3)[min], 0.1);
  assert.equal(values(0.3, 0.1)[min], 0.1);
  assert.equal(values(0, 7)[gate], 1);
  assert.equal(values(-1e-300, 7)[gate], 0);
  assert.equal(values(0, 7)[blend], 7);
  assert.equal(values(-1, 7)[blend], 14);
  assert.equal(values(0, 7)[r], 0);
  assert.equal(values(-2, 7)[r], 0);
  assert.equal(values(2, 7)[r], 2);
  assert.equal(values(-2, 7)[prod], -14);
  assert.equal(
    exact.sum(
      [
        [2, 3],
        [-1, 4],
      ],
      0.5,
    ),
    2.5,
  );
});

test("a blend whose gate is assumed between 0 and 1 is left as computed by every reading", () => {
  const tape = new Tape();
  const a = tape.input("a");
  const gate = tape.step(a);
  const blend = tape.blend(gate, tape.constant(10), tape.constant(20));
  const half = new Map([[gate, 0.5]]);
  assert.equal(run(tape, exact, { a: 1 }, half)[blend], 15);
  const d = dual(1);
  const halfDual = new Map([[gate, d.constant(0.5)]]);
  assert.equal(
    (
      run(tape, d, { a: d.variable(1, 0) }, halfDual)[blend] as {
        value: number;
      }
    ).value,
    15,
  );
  const wide = new Map([[gate, { lo: 0, hi: 1 }]]);
  const bound = run(tape, interval, { a: point(1) }, wide)[blend] as Interval;
  assert.ok(bound.lo <= 10 && bound.lo > 9.99);
  assert.ok(bound.hi >= 20 && bound.hi < 20.01);
  const outside = new Map([[gate, { lo: -1, hi: 2 }]]);
  const raw = run(tape, interval, { a: point(1) }, outside)[blend] as Interval;
  // Not a gate a step can produce: the computed bound is kept as it is.
  assert.ok(raw.lo <= 0 && raw.hi >= 30);
});

test("the softened reading is smooth through a breakpoint and hard away from it", () => {
  const s = soft(10);
  assert.equal(s.step(0), 0.5);
  assert.ok(Math.abs(s.relu(0) - Math.log(2) / 10) < 1e-12);
  // Far past the kink the ReLU is the identity, with no overflow.
  assert.equal(s.relu(100), 100);
  assert.equal(s.relu(3.0000001), 3.0000001);
  assert.ok(s.relu(2.9) > 2.9 && s.relu(2.9) < 2.9 + 1e-12);
  assert.ok(s.relu(-100) >= 0 && s.relu(-100) < 1e-12);
  assert.ok(s.step(1) > 0.9999 && s.step(-1) < 0.0001);
  assert.equal(s.sum([[2, 3]], 1), 7);
  assert.equal(s.mul(3, 4), 12);
  assert.equal(s.constant(5), 5);
});

test("the dual reading carries one partial derivative per input", () => {
  const d = dual(2);
  const x = d.variable(3, 0);
  const y = d.variable(5, 1);
  assert.deepEqual(x, { value: 3, gradient: [1, 0] });
  assert.deepEqual(d.constant(7), { value: 7, gradient: [0, 0] });
  assert.deepEqual(
    d.sum(
      [
        [2, x],
        [-1, y],
      ],
      4,
    ),
    { value: 5, gradient: [2, -1] },
  );
  assert.deepEqual(d.mul(x, y), { value: 15, gradient: [5, 3] });
  assert.deepEqual(d.relu(x), x);
  assert.deepEqual(d.relu(d.constant(0)), { value: 0, gradient: [0, 0] });
  assert.deepEqual(d.relu(d.sum([[-1, x]], 0)), {
    value: 0,
    gradient: [0, 0],
  });
  assert.deepEqual(d.step(x), { value: 1, gradient: [0, 0] });
  assert.deepEqual(d.step(d.constant(0)), { value: 1, gradient: [0, 0] });
  assert.deepEqual(d.step(d.sum([[-1, x]], 0)), {
    value: 0,
    gradient: [0, 0],
  });

  // Through a tape, max and min pass on the gradient of the operand they take.
  const tape = new Tape();
  const a = tape.input("a");
  const b = tape.input("b");
  const max = tape.max(a, b);
  const min = tape.min(a, b);
  const gate = tape.step(tape.sub(a, b));
  const blend = tape.blend(gate, a, b);
  const at = (va: number, vb: number) =>
    run(tape, d, { a: d.variable(va, 0), b: d.variable(vb, 1) });
  assert.deepEqual(at(1, 2)[max], { value: 2, gradient: [0, 1] });
  assert.deepEqual(at(2, 1)[max], { value: 2, gradient: [1, 0] });
  assert.deepEqual(at(1, 2)[min], { value: 1, gradient: [1, 0] });
  assert.deepEqual(at(2, 1)[min], { value: 1, gradient: [0, 1] });
  assert.deepEqual(at(2, 1)[blend], { value: 2, gradient: [1, 0] });
  assert.deepEqual(at(1, 2)[blend], { value: 2, gradient: [0, 1] });
});

test("the interval reading bounds each operation from both sides", () => {
  const sum = interval.sum(
    [
      [2, { lo: 1, hi: 3 }],
      [-1, { lo: 0, hi: 4 }],
    ],
    1,
  );
  // Exactly [2·1 - 4 + 1, 2·3 - 0 + 1], widened outward.
  assert.ok(sum.lo < -1 && sum.lo > -1 - 1e-12);
  assert.ok(sum.hi > 7 && sum.hi < 7 + 1e-12);
  const product = interval.mul({ lo: -2, hi: 3 }, { lo: -5, hi: 4 });
  assert.ok(product.lo < -15 && product.lo > -15 - 1e-12);
  assert.ok(product.hi > 12 && product.hi < 12 + 1e-12);
  assert.deepEqual(interval.relu({ lo: -2, hi: 3 }), { lo: 0, hi: 3 });
  assert.deepEqual(interval.relu({ lo: 1, hi: 3 }), { lo: 1, hi: 3 });
  assert.deepEqual(interval.relu({ lo: -3, hi: -1 }), { lo: 0, hi: 0 });
  assert.deepEqual(interval.relu({ lo: 0, hi: 0 }), { lo: 0, hi: 0 });
  assert.deepEqual(interval.step({ lo: -2, hi: 3 }), { lo: 0, hi: 1 });
  assert.deepEqual(interval.step({ lo: 0, hi: 3 }), { lo: 1, hi: 1 });
  assert.deepEqual(interval.step({ lo: -3, hi: -1 }), { lo: 0, hi: 0 });
  assert.deepEqual(interval.step({ lo: -3, hi: 0 }), { lo: 0, hi: 1 });
  assert.deepEqual(interval.constant(4), { lo: 4, hi: 4 });
});

test("the interval reading tightens a max, a min and a blend by what they mean", () => {
  const tape = new Tape();
  const a = tape.input("a");
  const b = tape.input("b");
  const max = tape.max(a, b);
  const min = tape.min(a, b);
  const gate = tape.step(a);
  const blend = tape.blend(gate, b, tape.affine(b, -1, 0));
  const bounds = (ra: Interval, rb: Interval): Interval[] =>
    run(tape, interval, { a: ra, b: rb });
  const near = (got: Interval, lo: number, hi: number): void => {
    assert.ok(got.lo <= lo && got.lo > lo - 1e-9, `lo ${got.lo} vs ${lo}`);
    assert.ok(got.hi >= hi && got.hi < hi + 1e-9, `hi ${got.hi} vs ${hi}`);
  };
  const values = bounds({ lo: 0, hi: 4 }, { lo: 1, hi: 2 });
  near(values[max] as Interval, 1, 4);
  near(values[min] as Interval, 0, 2);
  // Gate known to be 1: the blend is `then`.
  near(values[blend] as Interval, 1, 2);
  // Gate known to be 0: the blend is `otherwise`.
  near(bounds({ lo: -4, hi: -1 }, { lo: 1, hi: 2 })[blend] as Interval, -2, -1);
  // Gate either: the blend covers both and no more.
  near(bounds({ lo: -1, hi: 1 }, { lo: 1, hi: 2 })[blend] as Interval, -2, 2);
  near(bounds({ lo: 3, hi: 5 }, { lo: 1, hi: 2 })[max] as Interval, 3, 5);
  near(bounds({ lo: 3, hi: 5 }, { lo: 1, hi: 2 })[min] as Interval, 1, 2);
});

test("the slope reading bounds each partial derivative over a range", () => {
  const s = slopes(2);
  const x = s.variable({ lo: 1, hi: 2 }, 0);
  const y = s.variable({ lo: -1, hi: 3 }, 1);
  assert.deepEqual(x, {
    value: { lo: 1, hi: 2 },
    gradient: [point(1), point(0)],
  });
  assert.deepEqual(s.constant(3), {
    value: point(3),
    gradient: [point(0), point(0)],
  });
  const contains = (got: Interval, lo: number, hi: number): void => {
    assert.ok(got.lo <= lo && got.lo > lo - 1e-9, `lo ${got.lo} vs ${lo}`);
    assert.ok(got.hi >= hi && got.hi < hi + 1e-9, `hi ${got.hi} vs ${hi}`);
  };
  const sum = s.sum(
    [
      [2, x],
      [-1, y],
    ],
    1,
  );
  contains(sum.value, 2 - 3 + 1, 4 + 1 + 1);
  contains(sum.gradient[0] as Interval, 2, 2);
  contains(sum.gradient[1] as Interval, -1, -1);
  const product = s.mul(x, y);
  contains(product.value, -2, 6);
  // d(xy)/dx = y, d(xy)/dy = x.
  contains(product.gradient[0] as Interval, -1, 3);
  contains(product.gradient[1] as Interval, 1, 2);
  // A ReLU wholly above its kink is the identity, wholly below it is flat.
  assert.deepEqual(s.relu(x), x);
  assert.deepEqual(s.relu(s.sum([[-1, x]], 0)), {
    value: point(0),
    gradient: [point(0), point(0)],
  });
  assert.deepEqual(s.relu(s.sum([[1, x]], -1)).value.lo, 0);
  // Across its kink the slope runs from zero to the operand's.
  const across = s.relu(y);
  assert.deepEqual(across.value, { lo: 0, hi: 3 });
  assert.deepEqual(across.gradient, [point(0), { lo: 0, hi: 1 }]);
  const falling = s.relu(s.sum([[-1, y]], 0));
  contains(falling.gradient[1] as Interval, -1, 0);
  assert.equal((falling.gradient[1] as Interval).hi, 0);
  const step = s.step(y);
  assert.deepEqual(step, {
    value: { lo: 0, hi: 1 },
    gradient: [point(0), point(0)],
  });

  // Through a tape, a max is refined by its meaning and keeps its slope.
  const tape = new Tape();
  const a = tape.input("a");
  const b = tape.input("b");
  const max = tape.max(a, b);
  const values = run(tape, s, {
    a: s.variable({ lo: 3, hi: 5 }, 0),
    b: s.variable({ lo: 1, hi: 2 }, 1),
  });
  const refined = values[max] as { value: Interval; gradient: Interval[] };
  contains(refined.value, 3, 5);
  contains(refined.gradient[0] as Interval, 1, 1);
});

test("outward rounding is what keeps a bound around the rounded answer", () => {
  // 0.1 + 0.2 rounds up past 0.3; the bound must hold both.
  const sum = interval.sum(
    [
      [1, point(0.1)],
      [1, point(0.2)],
    ],
    0,
  );
  assert.ok(sum.lo <= 0.3 && sum.hi >= 0.1 + 0.2);
  assert.ok(sum.lo < sum.hi);
  const product = interval.mul(point(0.1), point(3));
  assert.ok(product.lo < 0.1 * 3 && product.hi > 0.1 * 3);
  assert.equal(product.hi, nextUp(0.1 * 3));
  assert.equal(product.lo, nextDown(0.1 * 3));
});

test("the drawn blend is exactly the side its gate chooses, even where their difference rounds or overflows", () => {
  const tape = new Tape();
  const a = tape.input("a");
  const then = tape.input("then");
  const otherwise = tape.input("otherwise");
  const blend = tape.blend(tape.step(a), then, otherwise);
  // 0.7 + (0.1 - 0.7) is not 0.1 in floating point; the blend still is.
  const chosen = { a: 1, then: 0.1, otherwise: 0.7 };
  assert.equal(run(tape, exact, chosen)[blend], 0.1);
  const d = dual(1);
  const dualOf = (values: Record<string, number>) =>
    run(tape, d, {
      a: d.constant(values.a as number),
      then: d.variable(values.then as number, 0),
      otherwise: d.constant(values.otherwise as number),
    })[blend] as { value: number; gradient: number[] };
  assert.deepEqual(dualOf(chosen), { value: 0.1, gradient: [1] });
  // Their difference overflows: 0 · ∞ has no value, the other side does.
  const far = { a: -1, then: 1e308, otherwise: -1e308 };
  assert.equal(run(tape, exact, far)[blend], -1e308);
  assert.deepEqual(dualOf(far), { value: -1e308, gradient: [0] });
});

test("the softened ReLU stays above the hard one up to where it switches to it", () => {
  const s = soft(1);
  // At 30 the curve is still in use and still above the line, by a hair.
  assert.ok(s.relu(30) > 30);
  assert.equal(s.relu(30.5), 30.5);
});

test("an assumed gate outside 0 to 1 on either side is not read as a choice", () => {
  const tape = new Tape();
  const a = tape.input("a");
  const gate = tape.step(a);
  const blend = tape.blend(gate, tape.constant(10), tape.constant(20));
  for (const assumed of [
    { lo: -1, hi: 1 },
    { lo: 0, hi: 2 },
  ]) {
    const raw = run(
      tape,
      interval,
      { a: point(1) },
      new Map([[gate, assumed]]),
    )[blend] as Interval;
    // 20 - 10·gate over the whole assumed range, not the hull of 10 and 20.
    assert.ok(
      raw.lo <= 20 - 10 * assumed.hi && raw.hi >= 20 - 10 * assumed.lo,
      `[${raw.lo}, ${raw.hi}] for gate [${assumed.lo}, ${assumed.hi}]`,
    );
  }
});

test("a ReLU wholly at or below its kink has no slope", () => {
  const s = slopes(1);
  const x = s.variable({ lo: -2, hi: 0 }, 0);
  assert.deepEqual(s.relu(x), { value: point(0), gradient: [point(0)] });
});

test("the resolution is a share of each input's own range, wherever that range lies", () => {
  const tape = new Tape();
  const shifted = tape.affine(tape.input("x"), 1, -10.5);
  const out = tape.mul(shifted, shifted);
  const proof = prove(tape, out, { x: [10, 11] }, { resolution: 1 / 64 });
  assert.ok(proof.status === "undecided");
  const [lo, hi] = proof.within.x as readonly [number, number];
  assert.ok(lo <= 10.5 && 10.5 <= hi);
  assert.ok(hi - lo <= 1 / 64, `${hi - lo} is wider than 1/64`);
});

/**
 * Below 5 a box sits at 5 and is 20 wide; from 5 on it sits at 30 and is 10
 * wide. Its right edge, 40 or less plus one, holds on both sides, but only
 * if each position is paired with its own size.
 */
function sides(extraGates: number, flip = false) {
  const tape = new Tape();
  const x = tape.input("x");
  const at = tape.affine(x, 1, -5);
  const gate = tape.step(at);
  // Each through a maximum, so the sum cannot cancel the gate away.
  const zero = tape.constant(0);
  const position = tape.max(
    tape.blend(gate, tape.constant(30), tape.constant(5)),
    zero,
  );
  const size = tape.max(
    tape.blend(gate, tape.constant(10), tape.constant(20)),
    zero,
  );
  for (let k = 0; k < extraGates; k += 1) tape.step(at);
  const room = tape.sum(
    [
      [-1, position],
      [-1, size],
    ],
    flip ? 39 : 41,
  );
  return { tape, room };
}

test("a breakpoint inside the range is settled by taking each side on its own", () => {
  const { tape, room } = sides(0);
  assert.equal(prove(tape, room, { x: [0, 9] }).status, "proved");
  // The same with every gate the case limit allows.
  const four = sides(3);
  assert.equal(prove(four.tape, four.room, { x: [0, 9] }).status, "proved");
  // One gate past the limit and the cases are not taken: the pairing of the
  // two sides is never ruled out, so the answer is not a proof.
  const five = sides(4);
  assert.notEqual(
    prove(five.tape, five.room, { x: [0, 9] }, { maxBoxes: 2_000 }).status,
    "proved",
  );
  // An edge one short on the right-hand side is found there.
  const short = sides(0, true);
  const proof = prove(short.tape, short.room, { x: [0, 9] });
  assert.ok(proof.status === "refuted");
  assert.ok((proof.at.x as number) >= 5);
});

test("a case the range rules out is dropped, and one it allows is searched to a witness", () => {
  // Negative only between -3.1 and -2.9, on the side where the gate is 0.
  // No first look lands there: it is found only by keeping the case where
  // the gate is 0 on a range lying wholly below the breakpoint.
  const below = new Tape();
  const x = below.input("x");
  const near = below.affine(x, 1, 3);
  const dip = below.when(
    x,
    below.constant(1),
    below.affine(below.mul(near, near), 1, -0.01),
  );
  const found = prove(below, dip, { x: [-4, 4.2] });
  assert.ok(found.status === "refuted", found.status);
  assert.ok(Math.abs((found.at.x as number) + 3) < 0.1);
  // The mirror image, on the side where the gate is 1.
  const above = new Tape();
  const y = above.input("x");
  const far = above.affine(y, 1, -3);
  const bump = above.when(
    y,
    above.affine(above.mul(far, far), 1, -0.01),
    above.constant(1),
  );
  const witness = prove(above, bump, { x: [-4.2, 4] });
  assert.ok(witness.status === "refuted", witness.status);
  assert.ok(Math.abs((witness.at.x as number) - 3) < 0.1);
});

/*
 * Mutants of algebras.ts and prove.ts no test can kill, because the mutated
 * program behaves the same:
 *
 * - algebras.ts `a > 0` as `a >= 0` in the exact and interval ReLU: at zero
 *   both branches give zero.
 * - algebras.ts `x > 0` as `x >= 0` in `nextUp`: zero is handled before.
 * - prove.ts `argument` returning `node.a` always, or without the `?.`: it
 *   is only called with step nodes.
 * - prove.ts `span(name) === 0` replaced by false: the share is then NaN,
 *   which is never wider than the resolution, as 0 is not.
 */
