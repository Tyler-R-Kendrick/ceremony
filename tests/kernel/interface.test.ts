import assert from "node:assert/strict";
import test from "node:test";
import fc from "fast-check";
import type { InterfaceSpec, OperatorDecl } from "../../src/kernel/index.js";
import {
  dual,
  exact,
  interval,
  nextDown,
  nextUp,
  soft,
  type Interval,
} from "../../src/kernel/interface/algebras.js";
import { prove } from "../../src/kernel/interface/prove.js";
import {
  measure,
  proveSheet,
  SHEET_DOMAIN,
  sheetLayout,
  TOLERANCE,
} from "../../src/kernel/interface/sheet.js";
import { run, Tape, type Ref } from "../../src/kernel/interface/tape.js";
import { catalog } from "../../src/kernel/flows/catalog.js";
import {
  githubAppAccess,
  githubUserAccess,
} from "../../src/kernel/flows/github-app.js";
import { options } from "./support.js";

type Build =
  | {
      readonly op: "sum";
      readonly terms: readonly [number, number][];
      readonly bias: number;
    }
  | {
      readonly op: "mul" | "max" | "min";
      readonly a: number;
      readonly b: number;
    }
  | { readonly op: "relu" | "step"; readonly a: number }
  | {
      readonly op: "blend";
      readonly gate: number;
      readonly a: number;
      readonly b: number;
    };

const weight = fc.integer({ min: -8, max: 8 }).map((n) => n / 4);
const pick = fc.nat({ max: 1_000 });

/** Random straight-line programs over two inputs, built from every operation. */
const program: fc.Arbitrary<Build[]> = fc.array(
  fc.oneof(
    fc.record({
      op: fc.constant("sum" as const),
      terms: fc.array(fc.tuple(weight, pick), { maxLength: 3 }),
      bias: weight,
    }),
    fc.record({
      op: fc.constantFrom("mul" as const, "max" as const, "min" as const),
      a: pick,
      b: pick,
    }),
    fc.record({
      op: fc.constantFrom("relu" as const, "step" as const),
      a: pick,
    }),
    fc.record({
      op: fc.constant("blend" as const),
      gate: pick,
      a: pick,
      b: pick,
    }),
  ),
  { minLength: 1, maxLength: 14 },
);

function build(steps: readonly Build[]): { tape: Tape; out: Ref } {
  const tape = new Tape();
  const refs: Ref[] = [tape.input("x"), tape.input("y")];
  const at = (index: number): Ref => refs[index % refs.length] as Ref;
  for (const step of steps) {
    switch (step.op) {
      case "sum":
        refs.push(
          tape.sum(
            step.terms.map(([w, index]) => [w, at(index)] as const),
            step.bias,
          ),
        );
        break;
      case "mul":
        refs.push(tape.mul(at(step.a), at(step.b)));
        break;
      case "max":
        refs.push(tape.max(at(step.a), at(step.b)));
        break;
      case "min":
        refs.push(tape.min(at(step.a), at(step.b)));
        break;
      case "relu":
        refs.push(tape.relu(at(step.a)));
        break;
      case "step":
        refs.push(tape.step(at(step.a)));
        break;
      case "blend":
        refs.push(tape.blend(tape.step(at(step.gate)), at(step.a), at(step.b)));
        break;
    }
  }
  return { tape, out: refs[refs.length - 1] as Ref };
}

const coordinate = fc.integer({ min: -64, max: 64 }).map((n) => n / 8);
const box = fc
  .tuple(coordinate, coordinate, coordinate, coordinate)
  .map(([a, b, c, d]) => ({
    x: { lo: Math.min(a, b), hi: Math.max(a, b) },
    y: { lo: Math.min(c, d), hi: Math.max(c, d) },
  }));
const share = fc.integer({ min: 0, max: 16 }).map((n) => n / 16);
const within = (side: Interval, part: number): number =>
  side.lo + (side.hi - side.lo) * part;

test("the bound of a range contains the exact value at every point of it, at every node", () => {
  fc.assert(
    fc.property(program, box, share, share, (steps, range, px, py) => {
      const { tape } = build(steps);
      const bounds = run(tape, interval, range);
      const values = run(tape, exact, {
        x: within(range.x, px),
        y: within(range.y, py),
      });
      values.forEach((value, index) => {
        const bound = bounds[index] as Interval;
        assert.ok(
          bound.lo <= value && value <= bound.hi,
          `node ${index}: ${value} outside [${bound.lo}, ${bound.hi}]`,
        );
      });
    }),
    { ...options, numRuns: options.numRuns * 10 },
  );
});

test("a proof is never contradicted by a sample, and a refutation is a real point", () => {
  fc.assert(
    fc.property(
      program,
      box,
      fc.array(fc.tuple(share, share), { minLength: 20, maxLength: 20 }),
      (steps, range, samples) => {
        const { tape, out } = build(steps);
        const domain = {
          x: [range.x.lo, range.x.hi] as const,
          y: [range.y.lo, range.y.hi] as const,
        };
        const proof = prove(tape, out, domain, { maxBoxes: 4_000 });
        if (proof.status === "proved") {
          for (const [px, py] of samples) {
            const value = run(tape, exact, {
              x: within(range.x, px),
              y: within(range.y, py),
            })[out] as number;
            assert.ok(value >= 0, `proved, yet ${value} at a sample`);
          }
        } else if (proof.status === "refuted") {
          assert.ok(domain.x[0] <= (proof.at.x as number));
          assert.ok((proof.at.x as number) <= domain.x[1]);
          assert.ok(domain.y[0] <= (proof.at.y as number));
          assert.ok((proof.at.y as number) <= domain.y[1]);
          assert.equal(run(tape, exact, proof.at)[out], proof.value);
          assert.ok(proof.value < 0);
        }
      },
    ),
    { ...options, numRuns: options.numRuns * 5 },
  );
});

test("the gradient agrees with a finite difference wherever the program is smooth", () => {
  const algebra = dual(2);
  fc.assert(
    fc.property(program, coordinate, coordinate, (steps, x, y) => {
      const { tape, out } = build(steps);
      const h = 1e-6;
      const here = { x, y };
      const smooth = [
        here,
        { x: x + h, y },
        { x: x - h, y },
        { x, y: y + h },
        { x, y: y - h },
      ]
        .map((at) => run(tape, exact, at))
        .every((values, _, all) =>
          tape.nodes.every((node, index) => {
            if (node.op !== "relu" && node.op !== "step") return true;
            const sign = (v: number): number =>
              node.op === "step" ? Number(v >= 0) : Number(v > 0);
            return (
              sign((all[0] as number[])[node.a] as number) ===
                sign(values[node.a] as number) &&
              Math.abs((all[0] as number[])[node.a] as number) > 1e-3
            );
          }),
        );
      fc.pre(smooth);
      const value = run(tape, algebra, {
        x: algebra.variable(x, 0),
        y: algebra.variable(y, 1),
      })[out];
      const f = (at: { x: number; y: number }): number =>
        run(tape, exact, at)[out] as number;
      const dx = (f({ x: x + h, y }) - f({ x: x - h, y })) / (2 * h);
      const dy = (f({ x, y: y + h }) - f({ x, y: y - h })) / (2 * h);
      const scale = 1 + Math.abs(dx) + Math.abs(dy);
      assert.ok(Math.abs((value?.gradient[0] as number) - dx) / scale < 1e-3);
      assert.ok(Math.abs((value?.gradient[1] as number) - dy) / scale < 1e-3);
    }),
    options,
  );
});

test("the softened program approaches the exact one as it hardens, away from breakpoints", () => {
  fc.assert(
    fc.property(program, coordinate, coordinate, (steps, x, y) => {
      const { tape, out } = build(steps);
      const values = run(tape, exact, { x, y });
      fc.pre(
        tape.nodes.every(
          (node, index) =>
            (node.op !== "relu" && node.op !== "step") ||
            Math.abs(values[node.a] as number) > 0.05 ||
            index < 0,
        ),
      );
      const hard = run(tape, soft(4_000), { x, y })[out] as number;
      const scale = 1 + Math.abs(values[out] as number);
      assert.ok(Math.abs(hard - (values[out] as number)) / scale < 1e-2);
    }),
    options,
  );
});

test("what cancels on paper cancels in the program", () => {
  const tape = new Tape();
  const width = tape.input("width");
  const pad = tape.affine(tape.step(tape.affine(width, 1, -480)), 8, 16);
  const content = tape.sum([
    [1, width],
    [-2, pad],
  ]);
  const rightGutter = tape.sum([
    [1, width],
    [-1, pad],
    [-1, content],
  ]);
  const bound = run(tape, interval, { width: { lo: 320, hi: 1280 } })[
    rightGutter
  ] as Interval;
  assert.ok(bound.lo > 15.99 && bound.hi < 24.01);
});

test("rounding outward moves by exactly one representable number", () => {
  assert.equal(nextUp(1), 1 + Number.EPSILON);
  assert.equal(nextDown(nextUp(1)), 1);
  assert.equal(nextUp(0), Number.MIN_VALUE);
  assert.equal(nextDown(0), -Number.MIN_VALUE);
  assert.equal(Math.abs(nextUp(-Number.MIN_VALUE)), 0);
});

/** Every interface any modelled flow can show. */
const interfaces = Object.entries({
  githubAppAccess,
  githubUserAccess,
  ...catalog,
}).flatMap(([flow, ceremony]) =>
  Object.entries(ceremony.operators as Record<string, OperatorDecl>).flatMap(
    ([id, operator]) =>
      operator.interface === undefined
        ? []
        : [[`${flow}.${id}`, operator.interface] as const],
  ),
);

for (const [id, spec] of interfaces) {
  test(`${id}: every layout rule holds for every width from 320 to 1280 and every scale from 1 to 2`, () => {
    const layout = sheetLayout(spec);
    assert.deepEqual(layout.domain, SHEET_DOMAIN);
    const proof = proveSheet(layout);
    assert.equal(
      proof.status,
      "proved",
      proof.status === "proved" ? "" : `${proof.rule.name}: ${proof.rule.harm}`,
    );
  });
}

test("without wrapping, the prover finds the phone and text size that cut a label off", () => {
  const spec = (githubAppAccess.operators as Record<string, OperatorDecl>)
    .registerApp?.interface as InterfaceSpec;
  const layout = sheetLayout(spec, { wrapActions: false });
  const proof = proveSheet(layout);
  assert.equal(proof.status, "refuted");
  assert.ok(proof.status === "refuted");
  assert.match(proof.rule.name, /holds its label/);
  assert.ok((proof.at.width as number) < 480);
  assert.ok(proof.value < 0);
  // The witness is a real layout: the label is wider than its button there.
  const drawn = measure(layout, {
    width: proof.at.width as number,
    scale: proof.at.scale as number,
  });
  const id = proof.rule.name.split(" ")[1] as string;
  const label = spec.actions.find((action) => action.id === id)?.label ?? "";
  const button = drawn.boxes[`action:${id}`];
  assert.ok(button);
  assert.ok(
    label.length * 0.6 * 16 * (proof.at.scale as number) > button.width - 32,
  );
});

test("measured boxes obey the rules at sampled widths and scales", () => {
  fc.assert(
    fc.property(
      fc.constantFrom(...interfaces),
      fc.double({ min: 320, max: 1280, noNaN: true }),
      fc.double({ min: 1, max: 2, noNaN: true }),
      ([, spec], width, scale) => {
        const layout = sheetLayout(spec);
        const drawn = measure(layout, { width, scale });
        const boxes = Object.entries(drawn.boxes);
        for (const [name, at] of boxes) {
          assert.ok(at.x >= 12 - TOLERANCE, name);
          assert.ok(at.x + at.width <= width - 12 + TOLERANCE, name);
          if (name.startsWith("action:")) {
            assert.ok(
              at.width >= 44 - TOLERANCE && at.height >= 44 - TOLERANCE,
            );
          }
        }
        for (const [a, first] of boxes) {
          for (const [b, second] of boxes) {
            if (a >= b) continue;
            const apart =
              first.x + first.width <= second.x ||
              second.x + second.width <= first.x ||
              first.y + first.height <= second.y ||
              second.y + second.height <= first.y;
            assert.ok(apart, `${a} overlaps ${b}`);
          }
        }
        assert.ok(
          drawn.height >= Math.max(...boxes.map(([, at]) => at.y + at.height)),
        );
      },
    ),
    options,
  );
});
