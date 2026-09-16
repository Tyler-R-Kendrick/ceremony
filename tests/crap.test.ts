import assert from "node:assert/strict";
import { test } from "node:test";
import { analyzeCrap, crapScore } from "../scripts/crap.js";

test("CRAP formula penalizes untested complexity and rejects invalid measurements", () => {
  assert.equal(crapScore(10, 0), 110);
  assert.equal(crapScore(10, 0.5), 22.5);
  assert.equal(crapScore(10, 1), 10);
  for (const [complexity, coverage] of [
    [0, 0],
    [1.5, 1],
    [1, -1],
    [1, 1.1],
    [1, NaN],
  ])
    assert.throws(() => crapScore(complexity!, coverage!), /Invalid/);
});

test("CRAP measures TypeScript decisions separately from nested functions", () => {
  const source =
    "function parent(a: boolean) {\n if (a) return 1;\n const child = () => {\n  if (a && true) return 2;\n  return 0;\n };\n return child();\n}";
  const coverage = {
    statementMap: Object.fromEntries(
      [1, 2, 3, 4, 5, 6, 7, 8].map((line) => [
        String(line),
        { start: { line, column: 0 }, end: { line, column: 50 } },
      ]),
    ),
    s: Object.fromEntries(
      [1, 2, 3, 4, 5, 6, 7, 8].map((line) => [
        String(line),
        line === 4 ? 0 : 1,
      ]),
    ),
  };
  const [parent, child] = analyzeCrap("example.ts", source, coverage);
  assert.equal(parent?.complexity, 2);
  assert.equal(parent?.coverage, 1);
  assert.equal(parent?.crap, 2);
  assert.equal(child?.complexity, 3);
  assert.equal(child?.coverage, 0.75);
  assert.equal(child?.crap, 3.140625);
  assert.equal(
    analyzeCrap("types.ts", "type Value = { id: string };", coverage).length,
    0,
  );
  assert.throws(
    () => analyzeCrap("example.ts", source, { ...coverage, s: {} }),
    /Missing statement/,
  );
});
