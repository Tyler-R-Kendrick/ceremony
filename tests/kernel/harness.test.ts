import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { check, derive, type Ceremony } from "../../src/kernel/index.js";
import { githubAppAccess } from "../../src/kernel/flows/github-app.js";
import {
  wrappedLines,
  wrapThresholds,
} from "../../src/kernel/interface/sheet.js";
import fc from "fast-check";
import { options } from "./support.js";

const model = JSON.parse(
  readFileSync(
    new URL("../../examples/kernel/model.json", import.meta.url),
    "utf8",
  ),
) as { ceremony: string; interfaces: string[]; endings: string[] };

test("the browser properties name exactly the interfaces the flow derives", () => {
  const ceremony = githubAppAccess as unknown as Ceremony;
  assert.equal(model.ceremony, ceremony.id);
  assert.deepEqual(
    model.interfaces,
    derive(ceremony)
      .components.filter((component) => component.need !== "unreachable")
      .map((component) => component.operator),
  );
});

test("the browser properties allow exactly the endings the model checker finds", () => {
  const found = new Set(
    check(githubAppAccess as unknown as Ceremony, {
      invalidations: 2,
    }).endings.map((ending) =>
      ending.failure === null
        ? "success"
        : ending.failure.kind === "terminal"
          ? ending.failure.reason
          : ending.failure.kind,
    ),
  );
  // "unstable" needs a probe and an operator to disagree, which the model's
  // truthful world never does; the interpreter can still end that way.
  found.add("unstable");
  assert.deepEqual([...found].sort(), [...model.endings].sort());
});

const copy = fc
  .array(
    fc.string({
      unit: fc.constantFrom("a", "b", "c"),
      minLength: 1,
      maxLength: 12,
    }),
    {
      minLength: 1,
      maxLength: 12,
    },
  )
  .map((words) => words.join(" "));

test("more room never needs more lines, and every line holds what it is given", () => {
  fc.assert(
    fc.property(copy, fc.integer({ min: 1, max: 40 }), (words, capacity) => {
      const lines = wrappedLines(words, capacity);
      assert.ok(lines >= 1);
      assert.ok(wrappedLines(words, capacity + 1) <= lines);
      // Enough lines for every character even if no space were wasted.
      const letters = words.replaceAll(" ", "").length;
      assert.ok(lines * capacity >= letters);
    }),
    options,
  );
});

test("each threshold is the least room at which the text fits that many lines", () => {
  fc.assert(
    fc.property(copy, (words) => {
      const most = wrappedLines(words, 1);
      wrapThresholds(words, most).forEach((capacity, index) => {
        const count = index + 1;
        assert.ok(wrappedLines(words, capacity) <= count);
        if (capacity > 1) assert.ok(wrappedLines(words, capacity - 1) > count);
      });
    }),
    options,
  );
});
