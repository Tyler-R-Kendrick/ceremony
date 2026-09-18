import { strict as assert } from "node:assert";
import test from "node:test";
import {
  RUBY_LIMITS,
  tokenizeRuby,
  parseRubySource,
  readRubyConnectorHash,
  hashEntry,
  hashValue,
  rubyString,
  rubyBoolean,
  rubyNumber,
  rubyArray,
  rubyEntries,
  toJsonValue,
  fromJsonValue,
} from "../../../src/server/connectors/formats/automation/ruby-literals.js";

/*
 * The Workato connector reader's counterpart to the JavaScript one, and the
 * same two obligations: read the literals, refuse the rest by name.
 *
 * Ruby gives it more ways to be asked to run something — a lambda, a block, a
 * heredoc, a backtick command, `#{}` interpolation, a percent literal — and
 * each has to arrive as `opaque` with its own reason rather than as a value
 * that happens to look harmless. A connector definition is read here to decide
 * what a deployment may reach, so "I could not read this" and "this is empty"
 * must never be the same answer.
 */

const hash = (source: string) => {
  const parse = parseRubySource(source);
  return readRubyConnectorHash(parse);
};

/** A hash with enough documented root keys to be recognized as the connector. */
const connector = (body: string) =>
  hash(`{\n  title: "Demo",\n  connection: { fields: [] },\n${body}\n}`);

test("AUTO-RB-01: the connector hash is found and its literals read", () => {
  const { value, truncated } = connector(
    `  test: "ok",\n  actions: { create: { title: "Create" } },`,
  );
  assert.equal(truncated, false);
  assert.equal(rubyString(hashValue(value, "title")), "Demo");
  assert.equal(rubyString(hashValue(value, "test")), "ok");
  assert.equal(
    rubyString(
      hashValue(hashValue(hashValue(value, "actions"), "create"), "title"),
    ),
    "Create",
  );
});

test("AUTO-RB-02: a symbol, a number, a boolean and nil each keep their kind", () => {
  const { value } = connector(
    `  mode: :fast,\n  retries: 3,\n  enabled: true,\n  disabled: false,\n  absent: nil,`,
  );
  // A symbol keeps its own kind, but reads as its name, so a caller comparing
  // text does not have to know which spelling the author used.
  assert.equal(hashValue(value, "mode")?.kind, "symbol");
  assert.equal(rubyString(hashValue(value, "mode")), "fast");
  assert.equal(toJsonValue(hashValue(value, "mode")), "fast");
  assert.equal(rubyNumber(hashValue(value, "retries")), 3);
  assert.equal(rubyBoolean(hashValue(value, "enabled")), true);
  assert.equal(rubyBoolean(hashValue(value, "disabled")), false);
  assert.equal(hashValue(value, "absent")?.kind, "nil");
  assert.equal(toJsonValue(hashValue(value, "absent")), null);
});

test("AUTO-RB-03: both hash rocket and colon keys are read", () => {
  const { value } = hash(
    `{ :title => "Rocket", "connection" => { fields: [] }, test: "colon" }`,
  );
  assert.equal(rubyString(hashValue(value, "title")), "Rocket");
  assert.equal(rubyString(hashValue(value, "test")), "colon");
  assert.ok(hashEntry(value, "connection"));
});

test("AUTO-RB-04: every way of asking Ruby to run something is opaque and named", () => {
  const cases: readonly [string, string][] = [
    ["lambda do |connection| 1 end", "lambda"],
    ["->(connection) { 1 }", "lambda"],
    ["compute_value", "reference"],
    ["Helper.compute(1)", "method-call"],
    ["`id`", "command"],
    /*
     * A Ruby regular expression is refused as an "expression" rather than as a
     * "regex", because a leading `/` cannot be told from division without
     * parsing the whole language. The refusal is what matters and it is
     * unconditional; only the label is coarser than the JavaScript reader's.
     * `RubyOpaqueReason` still declares "regex", which nothing here can
     * report -- recorded rather than asserted away.
     */
    ["/pattern/", "expression"],
    ["%w[a b]", "percent-literal"],
  ];
  for (const [source, reason] of cases) {
    const { value } = connector(`  field: ${source},`);
    const field = hashValue(value, "field");
    assert.equal(
      field?.kind,
      "opaque",
      `${source} must not be read as a value`,
    );
    assert.equal(
      field?.kind === "opaque" ? field.reason : undefined,
      reason,
      source,
    );
  }
});

test("AUTO-RB-05: an interpolated string is refused; a plain one is read", () => {
  const plain = connector(`  field: "literal",`);
  assert.equal(rubyString(hashValue(plain.value, "field")), "literal");

  const interpolated = connector('  field: "before #{name} after",');
  const field = hashValue(interpolated.value, "field");
  assert.equal(field?.kind, "opaque");
  assert.equal(
    field?.kind === "opaque" ? field.reason : undefined,
    "interpolation",
  );
});

test("AUTO-RB-06: a heredoc is refused rather than read as its delimiter", () => {
  const { value } = connector(
    `  field: <<~SQL,\n    select 1\n  SQL\n  after: "kept",`,
  );
  const field = hashValue(value, "field");
  assert.equal(field?.kind, "opaque");
  assert.equal(field?.kind === "opaque" ? field.reason : undefined, "heredoc");
  // The entries after it are still read: one refusal does not end the hash.
  assert.equal(rubyString(hashValue(value, "after")), "kept");
});

test("AUTO-RB-07: a splat is reported instead of silently contributing nothing", () => {
  const { value } = connector(`  fields: [*other, "kept"],`);
  const items = rubyArray(hashValue(value, "fields")) ?? [];
  assert.ok(
    items.some((item) => item.kind === "opaque" && item.reason === "splat"),
    "the splat must be visible in the tree",
  );
  assert.ok(items.some((item) => rubyString(item) === "kept"));
});

test("AUTO-RB-08: comments are skipped and do not swallow the entry after them", () => {
  const { value } = connector(
    `  # a comment with a colon: and a "quote"\n  after: "kept",`,
  );
  assert.equal(rubyString(hashValue(value, "after")), "kept");
});

test("AUTO-RB-09: a block argument is not mistaken for the connector hash", () => {
  // `items.map { … }` is a brace directly after a name. Reading it as the
  // connector would make the reader describe the wrong thing entirely.
  const { value } = hash(
    `items.map { |i| i }\n{ title: "Real", connection: { fields: [] }, test: "yes" }`,
  );
  assert.equal(rubyString(hashValue(value, "title")), "Real");
});

test("AUTO-RB-10: text before the connector is skipped, not executed or read", () => {
  const { value } = hash(
    [
      'require "net/http"',
      "CONSTANT = 42",
      'File.write("/tmp/x", "y")',
      "`rm -rf /`",
      '{ title: "After", connection: { fields: [] } }',
    ].join("\n"),
  );
  assert.equal(rubyString(hashValue(value, "title")), "After");
});

test("AUTO-RB-11: a source with no connector hash yields no value", () => {
  const { value } = hash(`CONSTANT = 42\n{ unrelated: 1 }`);
  assert.equal(value, undefined);
});

test("AUTO-RB-12: a nested hash is not mistaken for the connector itself", () => {
  // The connection hash appears first in the source but carries only one
  // documented root key; the real connector carries several.
  const { value } = hash(
    `{ title: "Outer", connection: { fields: [] }, actions: {}, triggers: {} }`,
  );
  assert.ok(hashValue(value, "actions"));
  assert.equal(rubyString(hashValue(value, "title")), "Outer");
});

test("AUTO-RB-13: a source past the byte ceiling yields no tokens", () => {
  const { tokens, truncated } = tokenizeRuby(
    `{ title: "${"x".repeat(200)}" }`,
    { ...RUBY_LIMITS, bytes: 32 },
  );
  assert.equal(truncated, true);
  assert.equal(tokens.length, 0);
});

test("AUTO-RB-14: the token ceiling truncates rather than running on", () => {
  const { tokens, truncated } = tokenizeRuby(
    `{ title: "a", connection: {}, test: "b", actions: {}, triggers: {} }`,
    { ...RUBY_LIMITS, tokens: 10 },
  );
  assert.equal(truncated, true);
  assert.ok(tokens.length <= 10);
});

test("AUTO-RB-15: depth beyond the ceiling is reported as truncation", () => {
  const depth = 8;
  const source = `{ title: "d", connection: {}, deep: ${"{ a: ".repeat(depth)}1${" }".repeat(depth)} }`;
  const { truncated } = readRubyConnectorHash(
    parseRubySource(source, { ...RUBY_LIMITS, depth: 3 }),
  );
  assert.equal(truncated, true);
});

test("AUTO-RB-16: the accessors refuse a value of the wrong kind", () => {
  const { value } = connector(`  text: "s",\n  count: 1,\n  flag: true,`);
  assert.equal(rubyString(hashValue(value, "count")), undefined);
  assert.equal(rubyNumber(hashValue(value, "text")), undefined);
  assert.equal(rubyBoolean(hashValue(value, "count")), undefined);
  assert.equal(rubyArray(hashValue(value, "text")), undefined);
  assert.equal(rubyEntries(hashValue(value, "text")), undefined);
  assert.equal(hashValue(value, "missing"), undefined);
  assert.equal(hashEntry(undefined, "anything"), undefined);
  assert.equal(rubyString(undefined), undefined);

  // One deliberate exception: Workato's own examples write `optional: "true"`,
  // so a quoted boolean is read as the boolean it plainly is. A quoted number
  // gets no such licence, because no example asks for one.
  const quoted = connector(`  optional: "true",\n  off: "false",\n  n: "3",`);
  assert.equal(rubyBoolean(hashValue(quoted.value, "optional")), true);
  assert.equal(rubyBoolean(hashValue(quoted.value, "off")), false);
  assert.equal(rubyNumber(hashValue(quoted.value, "n")), undefined);
});

test("AUTO-RB-17: opaque nodes disappear from converted JSON", () => {
  const { value } = connector(`  kept: 1,\n  computed: Helper.call(1),`);
  const json = toJsonValue(value) as Record<string, unknown>;
  assert.equal(json.kept, 1);
  assert.ok(!("computed" in json), "an unreadable entry has no JSON spelling");
  assert.equal(hashValue(value, "computed")?.kind, "opaque");
});

test("AUTO-RB-18: wrapping JSON refuses the prototype-polluting keys", () => {
  const wrapped = fromJsonValue(
    JSON.parse(`{"safe":1,"__proto__":{"bad":true},"constructor":2}`),
  );
  assert.deepEqual(
    (rubyEntries(wrapped) ?? []).map((entry) => entry.key),
    ["safe"],
  );
});

test("AUTO-RB-19: wrapping JSON is total and round trips", () => {
  const data = {
    string: "s",
    number: 1.5,
    yes: true,
    nothing: null,
    list: [1, "two", { three: false }],
  };
  assert.deepEqual(toJsonValue(fromJsonValue(data)), data);
  assert.equal(fromJsonValue(undefined).kind, "opaque");
  assert.equal(rubyNumber(fromJsonValue(Number.NaN)), 0);
  assert.equal(rubyNumber(fromJsonValue(Number.POSITIVE_INFINITY)), 0);
});
