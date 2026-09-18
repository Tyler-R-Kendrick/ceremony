import { strict as assert } from "node:assert";
import test from "node:test";
import {
  JS_LIMITS,
  tokenizeJs,
  parseJsSource,
  readValueAt,
  findExportedValueIndex,
  findMethodNames,
  objectEntry,
  objectValue,
  asString,
  asBoolean,
  asNumber,
  asArray,
  asObject,
  toJsonValue,
  fromJsonValue,
} from "../../../src/server/connectors/formats/automation/js-literals.js";

/*
 * This reader takes a stranger's JavaScript and returns data. It has one job
 * and one prohibition: read every literal it can prove, and refuse to guess at
 * anything else. Both halves need testing, and until now it had neither —
 * only a source scan proving it cannot execute what it reads, and whatever
 * coverage the Zapier and n8n readers happened to give it.
 *
 * The prohibition is the security-relevant half. A value the reader cannot
 * evaluate has to arrive as `opaque` carrying the reason it could not, because
 * a reviewer deciding what a connector may touch has to be able to tell "this
 * is the string admin" from "something here computes a string I did not read".
 * An `opaque` that silently became `undefined`, or a `call` that was reported
 * as the text of its own source, would both read as an absence of risk.
 */

const value = (source: string) => {
  const parse = parseJsSource(source);
  const index = findExportedValueIndex(parse);
  assert.notEqual(index, undefined, `no exported value found in: ${source}`);
  return readValueAt(parse, index!);
};

const exported = (literal: string) => value(`module.exports = ${literal};`);

test("AUTO-JS-01: literals of every static kind are read as data", () => {
  const { value: read, truncated } = exported(
    `{ name: "acme", count: 3, negative: -2.5, ok: true, off: false, nothing: null }`,
  );
  assert.equal(truncated, false);
  assert.equal(asString(objectValue(read, "name")), "acme");
  assert.equal(asNumber(objectValue(read, "count")), 3);
  assert.equal(asNumber(objectValue(read, "negative")), -2.5);
  assert.equal(asBoolean(objectValue(read, "ok")), true);
  assert.equal(asBoolean(objectValue(read, "off")), false);
  assert.equal(objectValue(read, "nothing")?.kind, "null");
});

test("AUTO-JS-02: nesting is preserved rather than flattened", () => {
  const { value: read } = exported(
    `{ outer: { inner: ["a", 1, { deep: true }] } }`,
  );
  const items = asArray(
    objectValue(asObject(read) && objectValue(read, "outer"), "inner"),
  );
  assert.equal(items?.length, 3);
  assert.equal(asString(items?.[0]), "a");
  assert.equal(asNumber(items?.[1]), 1);
  assert.equal(asBoolean(objectValue(items?.[2], "deep")), true);
  // The whole tree converts back to the plain data it describes.
  assert.deepEqual(toJsonValue(read), {
    outer: { inner: ["a", 1, { deep: true }] },
  });
});

test("AUTO-JS-03: a quoted key is distinguishable from an identifier key", () => {
  const { value: read } = exported(`{ plain: 1, "quoted-key": 2 }`);
  assert.equal(objectEntry(read, "plain")?.quoted, false);
  assert.equal(objectEntry(read, "quoted-key")?.quoted, true);
  // Both are still the same key to a reader that only wants the value.
  assert.equal(asNumber(objectValue(read, "quoted-key")), 2);
});

test("AUTO-JS-04: what cannot be evaluated is opaque and says why", () => {
  // Each of these is a thing the reader must not pretend to have read. The
  // reason is the point: it is what a reviewer is shown instead of a value.
  const cases: readonly [string, string][] = [
    ["() => 1", "function"],
    ["function () { return 1; }", "function"],
    ["lookup()", "call"],
    ["someIdentifier", "reference"],
    ["/pattern/g", "regex"],
  ];
  for (const [source, reason] of cases) {
    const { value: read } = exported(`{ field: ${source} }`);
    const field = objectValue(read, "field");
    assert.equal(field?.kind, "opaque", source);
    assert.equal(
      field?.kind === "opaque" ? field.reason : undefined,
      reason,
      source,
    );
  }
});

test("AUTO-JS-05: a template is a string only when nothing is interpolated", () => {
  const plain = exported("{ field: `literal text` }");
  assert.equal(asString(objectValue(plain.value, "field")), "literal text");

  const interpolated = exported("{ field: `before ${name} after` }");
  const field = objectValue(interpolated.value, "field");
  assert.equal(field?.kind, "opaque");
  assert.equal(
    field?.kind === "opaque" ? field.reason : undefined,
    "template-expression",
  );
});

test("AUTO-JS-06: a spread and a computed key are refused, not guessed", () => {
  const spread = exported(`{ ...other, kept: 1 }`);
  // The spread cannot be resolved, so it may not silently vanish: the value it
  // would have contributed is unknown, and the entry that is readable stays.
  assert.equal(asNumber(objectValue(spread.value, "kept")), 1);
  const entries = asObject(spread.value) ?? [];
  assert.ok(
    entries.some(
      (entry) =>
        entry.value.kind === "opaque" && entry.value.reason === "spread",
    ),
    "the spread must be reported as an opaque entry",
  );

  const computed = exported(`{ [dynamic]: 1 }`);
  const computedEntries = asObject(computed.value) ?? [];
  assert.ok(
    computedEntries.some(
      (entry) =>
        entry.value.kind === "opaque" && entry.value.reason === "computed-key",
    ),
    "a computed key must be reported rather than resolved",
  );
});

test("AUTO-JS-07: comments are skipped without shifting the values around them", () => {
  const { value: read } = exported(
    `{
      // a line comment mentioning "not a string"
      first: 1,
      /* a block comment mentioning { not: "an object" } */
      second: 2,
    }`,
  );
  assert.deepEqual(toJsonValue(read), { first: 1, second: 2 });
});

test("AUTO-JS-08: the export may be direct, defaulted, or named indirectly", () => {
  for (const source of [
    `module.exports = { found: true };`,
    `export default { found: true };`,
    `const definition = { found: true };\nmodule.exports = definition;`,
    `const definition = { found: true };\nexport default definition;`,
  ]) {
    const parse = parseJsSource(source);
    const index = findExportedValueIndex(parse);
    assert.notEqual(index, undefined, source);
    const { value: read } = readValueAt(parse, index!);
    assert.equal(asBoolean(objectValue(read, "found")), true, source);
  }
});

test("AUTO-JS-09: a source with no exported value reports none", () => {
  const parse = parseJsSource(`const unused = { never: "exported" };`);
  assert.equal(findExportedValueIndex(parse), undefined);
});

test("AUTO-JS-10: declared method names are reported", () => {
  // Class bodies only: this is how a declarative n8n node is told from a
  // programmatic one, and a programmatic one is code this runtime will not run.
  const parse = parseJsSource(
    `class Node {
       description = { displayName: "Node" };
       async execute(context) { return []; }
       webhook(context) { return {}; }
     }`,
  );
  const names = findMethodNames(parse);
  assert.ok(names.has("execute"), "execute must be reported");
  assert.ok(names.has("webhook"), "webhook must be reported");
  // A property initializer is not a method, even though it is a class member.
  assert.ok(!names.has("description"));
  // An object literal's shorthand methods are not class methods.
  assert.equal(
    findMethodNames(
      parseJsSource(`module.exports = { perform(z) { return 1; } };`),
    ).size,
    0,
  );
});

test("AUTO-JS-11: a source past the byte ceiling yields no tokens at all", () => {
  const limits = { ...JS_LIMITS, bytes: 32 };
  const { tokens, truncated } = tokenizeJs(
    `module.exports = { padding: "${"x".repeat(200)}" };`,
    limits,
  );
  assert.equal(truncated, true);
  assert.equal(tokens.length, 0, "nothing is read from an oversized source");
});

test("AUTO-JS-12: the token ceiling truncates rather than running on", () => {
  const limits = { ...JS_LIMITS, tokens: 12 };
  const { tokens, truncated } = tokenizeJs(
    `module.exports = { a: 1, b: 2, c: 3, d: 4, e: 5, f: 6 };`,
    limits,
  );
  assert.equal(truncated, true);
  assert.ok(
    tokens.length <= 12,
    `tokens ${tokens.length} exceeded the ceiling`,
  );
});

test("AUTO-JS-13: depth beyond the ceiling is truncated, not recursed", () => {
  const depth = 8;
  const limits = { ...JS_LIMITS, depth: 3 };
  const source = `module.exports = ${"{ a: ".repeat(depth)}1${" }".repeat(depth)};`;
  const parse = parseJsSource(source, limits);
  const index = findExportedValueIndex(parse);
  assert.notEqual(index, undefined);
  const { truncated } = readValueAt(parse, index!);
  assert.equal(truncated, true, "exceeding the depth ceiling must be reported");
});

test("AUTO-JS-14: the node ceiling is reported as truncation", () => {
  const limits = { ...JS_LIMITS, nodes: 4 };
  const parse = parseJsSource(
    `module.exports = { a: 1, b: 2, c: 3, d: 4, e: 5, f: 6, g: 7 };`,
    limits,
  );
  const index = findExportedValueIndex(parse);
  assert.notEqual(index, undefined);
  const { truncated } = readValueAt(parse, index!);
  assert.equal(truncated, true);
});

test("AUTO-JS-15: the accessors refuse a value of the wrong kind", () => {
  const { value: read } = exported(`{ text: "s", number: 1, flag: true }`);
  // Each accessor is a type guard, not a coercion: a number is not a string.
  assert.equal(asString(objectValue(read, "number")), undefined);
  assert.equal(asNumber(objectValue(read, "text")), undefined);
  assert.equal(asBoolean(objectValue(read, "number")), undefined);
  assert.equal(asArray(objectValue(read, "text")), undefined);
  assert.equal(asObject(objectValue(read, "text")), undefined);
  // And an absent key is undefined rather than a thrown error.
  assert.equal(objectValue(read, "missing"), undefined);
  assert.equal(objectEntry(undefined, "anything"), undefined);
  assert.equal(asString(undefined), undefined);
});

test("AUTO-JS-16: opaque nodes disappear from converted JSON", () => {
  const { value: read } = exported(`{ kept: 1, computed: compute() }`);
  // Dropping it is the right call -- there is no honest JSON for "a call" --
  // but it means converted JSON cannot be read as the whole of the source.
  // The literal tree is where the opaque entry is still visible.
  assert.deepEqual(toJsonValue(read), { kept: 1 });
  assert.equal(objectValue(read, "computed")?.kind, "opaque");
});

test("AUTO-JS-17: an opaque array item shortens the array it was in", () => {
  const { value: read } = exported(`{ items: ["a", compute(), "c"] }`);
  // Recorded because it is a trap for a caller who reads converted JSON and
  // trusts the index: the third item is now the second.
  assert.deepEqual(toJsonValue(read), { items: ["a", "c"] });
  assert.equal(asArray(objectValue(read, "items"))?.length, 3);
});

test("AUTO-JS-18: wrapping JSON refuses the prototype-polluting keys", () => {
  const wrapped = fromJsonValue(
    JSON.parse(
      `{"safe":1,"__proto__":{"bad":true},"constructor":2,"prototype":3}`,
    ),
  );
  const keys = (asObject(wrapped) ?? []).map((entry) => entry.key);
  assert.deepEqual(keys, ["safe"]);
  assert.deepEqual(toJsonValue(wrapped), { safe: 1 });
});

test("AUTO-JS-19: wrapping JSON is total and round trips through conversion", () => {
  const data = {
    string: "s",
    number: 1.5,
    yes: true,
    nothing: null,
    list: [1, "two", { three: false }],
  };
  assert.deepEqual(toJsonValue(fromJsonValue(data)), data);
  // A value with no JSON spelling becomes opaque rather than a wrong literal.
  assert.equal(fromJsonValue(undefined).kind, "opaque");
  assert.equal(fromJsonValue(() => 1).kind, "opaque");
  // A non-finite number has no JSON spelling either; it must not become NaN.
  assert.equal(asNumber(fromJsonValue(Number.POSITIVE_INFINITY)), 0);
  assert.equal(asNumber(fromJsonValue(Number.NaN)), 0);
  // An instance of something is not a plain record.
  assert.equal(fromJsonValue(new Map()).kind, "opaque");
});
