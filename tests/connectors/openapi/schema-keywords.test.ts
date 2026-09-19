import assert from "node:assert/strict";
import { test } from "node:test";
import {
  compileSchema,
  validateValue,
  type CompiledSchema,
  type CompileSchemaContext,
  type OpenApiProfile,
  type SchemaDefinitions,
  type SchemaProblem,
} from "../../../src/server/connectors/formats/openapi/index.js";
import {
  DEFAULT_REFERENCE_LIMITS,
  ReferenceResolver,
} from "../../../src/server/connectors/formats/openapi/refs.js";
import { IssueCollector } from "../../../src/server/connectors/formats/openapi/issues.js";

/*
 * The schema compiler decides what a caller is allowed to send, so its answers
 * are a security boundary and not a convenience. Two properties matter more
 * than any individual keyword.
 *
 * A keyword this runtime cannot enforce must never be silently ignored. If a
 * description says `allOf` or `pattern` and the compiler drops it without
 * saying so, the exported and reviewed surface claims a constraint that
 * nothing checks, and a reviewer approves an operation on a promise the
 * runtime does not keep. Every such keyword must arrive as a problem a
 * reviewer can see.
 *
 * And version dispatch has to be real. `nullable` means something in
 * Swagger 2.0 and OpenAPI 3.0 and nothing in 3.1; a type array and `const`
 * are the reverse. Guessing in either direction changes what a caller may
 * send, so each is asserted against the profile that admits it AND against
 * one that does not.
 *
 * These call `compileSchema` directly rather than through a document, because
 * the keyword matrix is what is under test and a document would exercise one
 * cell of it at a time.
 */

function contextFor(
  profile: OpenApiProfile,
  root: unknown = {},
  maxDepth?: number,
): CompileSchemaContext & { problems: SchemaProblem[] } {
  const issues = new IssueCollector();
  return {
    resolver: new ReferenceResolver(
      root,
      new Map(),
      DEFAULT_REFERENCE_LIMITS,
      issues,
    ),
    profile,
    definitions: new Map(),
    problems: [],
    ...(maxDepth === undefined ? {} : { maxDepth }),
  };
}

function compile(
  raw: unknown,
  profile: OpenApiProfile = "openapi-3.1",
  options: { root?: unknown; maxDepth?: number } = {},
): { schema: CompiledSchema; problems: SchemaProblem[] } {
  const ctx = contextFor(profile, options.root ?? {}, options.maxDepth);
  const schema = compileSchema(
    raw,
    { documentKey: "", pointer: "#/schema" },
    ctx,
  );
  return { schema, problems: ctx.problems };
}

const codes = (problems: SchemaProblem[]) => problems.map((p) => p.code);
const keywords = (problems: SchemaProblem[]) =>
  problems.map((p) => p.keyword).filter(Boolean);

test("HTTP-SCHEMA-01: a boolean schema and a non-object are distinguished", () => {
  // `true` and an absent schema both mean "anything", `false` means "nothing".
  // Collapsing them would either admit everything or refuse everything.
  assert.deepEqual(compile(true).schema, { kind: "any" });
  assert.deepEqual(compile(undefined).schema, { kind: "any" });
  assert.deepEqual(compile(false).schema, { kind: "never" });

  // A schema that is neither is not "anything": a string or an array where a
  // schema belongs is a malformed description, and guessing would let a
  // caller send whatever the guess allowed.
  for (const invalid of ["string", 42, [], null]) {
    const { schema, problems } = compile(invalid);
    assert.deepEqual(schema, { kind: "never" }, JSON.stringify(invalid));
    assert.deepEqual(codes(problems), ["schema.invalid"]);
  }
});

test("HTTP-SCHEMA-02: a keyword this runtime cannot enforce is reported, never dropped", () => {
  // The whole point: a constraint the validator does not implement must reach
  // a reviewer as a problem. Silence here is the dangerous outcome, because
  // the description keeps claiming the constraint.
  for (const keyword of [
    "allOf",
    "anyOf",
    "oneOf",
    "not",
    "pattern",
    "patternProperties",
    "if",
    "dependentSchemas",
  ]) {
    const { problems } = compile({ type: "object", [keyword]: {} });
    assert.ok(
      problems.some(
        (p) => p.code === "schema.unsupported-keyword" && p.keyword === keyword,
      ),
      `${keyword} was accepted without a problem`,
    );
  }
});

test("HTTP-SCHEMA-03: a keyword nobody has heard of is reported separately", () => {
  // An unknown keyword and an unsupported one are different facts: one is a
  // gap in this runtime, the other is probably a typo or a private extension
  // that was not spelled `x-`. A reviewer needs to tell them apart.
  const { problems } = compile({ type: "string", nonsenseKeyword: 1 });
  assert.deepEqual(codes(problems), ["schema.unknown-keyword"]);
  assert.deepEqual(keywords(problems), ["nonsenseKeyword"]);

  // An `x-` extension is neither: it is the documented way to carry private
  // data and must not produce noise.
  assert.deepEqual(compile({ type: "string", "x-private": 1 }).problems, []);
});

test("HTTP-SCHEMA-04: nullable belongs to the old profiles and const to the new", () => {
  // Version dispatch decides what a caller may send, so it is asserted in
  // both directions rather than assumed.
  for (const profile of ["swagger-2.0", "openapi-3.0"] as const) {
    const { schema, problems } = compile(
      { type: "string", nullable: true },
      profile,
    );
    assert.deepEqual(problems, [], `${profile} understands nullable`);
    assert.ok(schema.kind === "node" && schema.types?.includes("null"));
  }
  // In 3.1 `nullable` was removed, so treating it as meaningful would admit
  // null where the description does not.
  const modern = compile({ type: "string", nullable: true }, "openapi-3.1");
  assert.deepEqual(codes(modern.problems), ["schema.unknown-keyword"]);
  assert.ok(
    !(modern.schema.kind === "node" && modern.schema.types?.includes("null")),
  );

  // `const` is the mirror image.
  assert.deepEqual(compile({ const: "x" }, "openapi-3.1").problems, []);
  assert.deepEqual(codes(compile({ const: "x" }, "openapi-3.0").problems), [
    "schema.unknown-keyword",
  ]);
});

test("HTTP-SCHEMA-05: a type array is a 3.1 spelling and a bad type is refused", () => {
  const modern = compile({ type: ["string", "null"] }, "openapi-3.1");
  assert.deepEqual(modern.problems, []);
  assert.deepEqual(
    modern.schema.kind === "node" ? modern.schema.types : undefined,
    ["string", "null"],
  );

  // Before 3.1 a type array is not valid, and reading it anyway would accept
  // a document this runtime cannot faithfully execute.
  const old = compile({ type: ["string", "null"] }, "openapi-3.0");
  assert.ok(
    old.problems.some((p) => p.keyword === "type[]"),
    "a type array must be refused before 3.1",
  );

  // A type that is not a JSON type at all is malformed, whatever the profile.
  const bogus = compile({ type: "integer-ish" }, "openapi-3.1");
  assert.ok(bogus.problems.some((p) => p.keyword === "type"));
});

test("HTTP-SCHEMA-06: an annotation is carried, bounded and stripped of control characters", () => {
  const { schema, problems } = compile({
    type: "string",
    title: "t".repeat(400),
    description: `line${String.fromCharCode(10)}two${String.fromCharCode(0)}`,
    deprecated: true,
    readOnly: true,
    example: "ignored",
  });
  assert.deepEqual(problems, [], "an annotation is not a constraint");
  assert.ok(schema.kind === "node");
  // Bounded, because a description is shown to a person and stored.
  assert.equal(schema.title?.length, 200);
  assert.equal(schema.deprecated, true);
  assert.equal(schema.readOnly, true);
  // A control character in a description would corrupt a log or a review
  // screen, so it becomes a space rather than travelling.
  assert.ok(!/\p{Cc}/u.test(schema.description ?? ""));
  assert.match(schema.description ?? "", /line two/);
});

test("HTTP-SCHEMA-07: a discriminator and a foreign dialect are reported", () => {
  // A discriminator selects a subschema, which this runtime does not execute;
  // accepting it silently would understate what the description requires.
  assert.ok(
    compile({
      type: "object",
      discriminator: { propertyName: "k" },
    }).problems.some((p) => p.keyword === "discriminator"),
  );
  // A `$schema` naming a dialect this compiler does not implement changes the
  // meaning of every keyword under it, so it cannot pass unremarked.
  assert.deepEqual(
    codes(
      compile({ $schema: "https://example.test/dialect", type: "string" })
        .problems,
    ),
    ["schema.dialect-unsupported"],
  );
});

test("HTTP-SCHEMA-08: depth is bounded and the bound is reported", () => {
  // An attacker-supplied description can nest arbitrarily. The compiler stops
  // and says so rather than recursing, and what it returns admits nothing.
  let deep: Record<string, unknown> = { type: "string" };
  for (let i = 0; i < 12; i++)
    deep = { type: "object", properties: { a: deep } };
  const { problems } = compile(deep, "openapi-3.1", { maxDepth: 4 });
  assert.ok(
    problems.some((p) => p.code === "schema.too-deep"),
    "the depth bound must be reported, not silently truncated",
  );
});

test("HTTP-SCHEMA-09: an enum is bounded and a malformed one is refused", () => {
  const ok = compile({ enum: ["a", "b"] });
  assert.deepEqual(ok.problems, []);
  assert.deepEqual(ok.schema.kind === "node" ? ok.schema.enum : undefined, [
    "a",
    "b",
  ]);
  // Not an array: a single value where a list belongs is malformed, and
  // guessing it means one value would decide what a caller may send.
  assert.ok(compile({ enum: "a" }).problems.some((p) => p.keyword === "enum"));
  // Beyond the bound, because an enum is compiled into a comparison list.
  const huge = Array.from({ length: 1025 }, (_, i) => i);
  assert.ok(compile({ enum: huge }).problems.some((p) => p.keyword === "enum"));
});

/*
 * `validateValue` answers with a list of failures, and an empty list is the
 * only thing that means "this value may be sent". These helpers name that so
 * a reader cannot mistake a truthy array for a refusal.
 */
const failures = (
  value: unknown,
  schema: CompiledSchema,
  definitions: SchemaDefinitions = {},
) => validateValue(value, schema, definitions).map((f) => f.code);
const admits = (
  value: unknown,
  schema: CompiledSchema,
  definitions: SchemaDefinitions = {},
) => failures(value, schema, definitions).length === 0;

test("HTTP-SCHEMA-10: the validator enforces what the compiler kept", () => {
  // `never` admits nothing, including `undefined`. It is the answer for a
  // schema the compiler could not read, so if it admitted anything it would
  // turn an unreadable description into an open door.
  assert.deepEqual(failures(1, { kind: "never" }), ["schema.never"]);
  assert.deepEqual(failures(undefined, { kind: "never" }), ["schema.never"]);

  // `any` admits anything, which is only honest because the compiler reports
  // every keyword it dropped on the way here.
  assert.ok(admits({ whatever: true }, { kind: "any" }));

  // The types are JSON's, not JavaScript's: an array is not an object and
  // null is not an object, however `typeof` describes them.
  const object: CompiledSchema = { kind: "node", types: ["object"] };
  assert.ok(admits({}, object));
  assert.deepEqual(failures([], object), ["schema.type"]);
  assert.deepEqual(failures(null, object), ["schema.type"]);
  assert.ok(admits(null, { kind: "node", types: ["null"] }));

  // An integer is not merely a number, so a fractional value is refused where
  // the description says integer.
  const integer: CompiledSchema = { kind: "node", types: ["integer"] };
  assert.ok(admits(2, integer));
  assert.deepEqual(failures(1.5, integer), ["schema.type"]);

  // A value of a type JSON has no name for cannot be validated at all, and is
  // refused rather than passed through.
  assert.deepEqual(
    failures(() => 1, { kind: "node", types: ["object"] }),
    ["schema.type"],
  );
});

test("HTTP-SCHEMA-11: a reference is followed, and a missing one refuses", () => {
  const definitions: SchemaDefinitions = {
    "#/Ok": { kind: "node", types: ["string"] },
  };
  assert.ok(admits("x", { kind: "ref", name: "#/Ok" }, definitions));
  assert.deepEqual(failures(1, { kind: "ref", name: "#/Ok" }, definitions), [
    "schema.type",
  ]);
  // A reference the definitions do not carry is a refusal, never a pass. A
  // compiled binding that lost a definition must not start admitting values.
  assert.deepEqual(
    failures("x", { kind: "ref", name: "#/Gone" }, definitions),
    ["schema.reference-missing"],
  );
});

test("HTTP-SCHEMA-12: an enum and a const compare by value, not by identity", () => {
  // A caller sends a fresh object every time, so identity comparison would
  // refuse every legitimate value.
  const enumerated: CompiledSchema = {
    kind: "node",
    enum: [{ a: [1, 2] }, "x"],
  };
  assert.ok(admits({ a: [1, 2] }, enumerated));
  assert.deepEqual(failures({ a: [1, 3] }, enumerated), ["schema.enum"]);
  assert.ok(admits("x", enumerated));

  // `const` is the same comparison with one permitted value, and key order
  // must not decide the answer.
  const fixed: CompiledSchema = { kind: "node", const: { b: 1, a: 2 } };
  assert.ok(admits({ a: 2, b: 1 }, fixed));
  assert.deepEqual(failures({ a: 2, b: 2 }, fixed), ["schema.const"]);
});

test("HTTP-SCHEMA-13: numeric bounds are enforced, inclusive and exclusive apart", () => {
  const bounded: CompiledSchema = { kind: "node", minimum: 1, maximum: 10 };
  assert.ok(admits(1, bounded));
  assert.ok(admits(10, bounded));
  assert.deepEqual(failures(0, bounded), ["schema.minimum"]);
  assert.deepEqual(failures(11, bounded), ["schema.maximum"]);

  // Exclusive is a different keyword with a different answer at the boundary,
  // and conflating them changes what a caller may send by exactly one value.
  const exclusive: CompiledSchema = {
    kind: "node",
    exclusiveMinimum: 1,
    exclusiveMaximum: 10,
  };
  assert.deepEqual(failures(1, exclusive), ["schema.exclusive-minimum"]);
  assert.deepEqual(failures(10, exclusive), ["schema.exclusive-maximum"]);
  assert.ok(admits(2, exclusive));

  // A multiple is compared with a tolerance, because binary floating point
  // cannot represent a decimal step exactly and a strict remainder would
  // refuse 0.3 against a step of 0.1.
  const step: CompiledSchema = { kind: "node", multipleOf: 0.1 };
  assert.ok(admits(0.3, step));
  assert.deepEqual(failures(0.35, step), ["schema.multiple-of"]);

  // An int32 is a range as well as an integer.
  const int32: CompiledSchema = { kind: "node", format: "int32" };
  assert.ok(admits(2147483647, int32));
  assert.deepEqual(failures(2147483648, int32), ["schema.format"]);
  assert.deepEqual(failures(1.5, int32), ["schema.format"]);
});

test("HTTP-SCHEMA-14: string length counts characters, not UTF-16 units", () => {
  // An emoji is one character and two UTF-16 units. Counting units would
  // refuse a legitimate value, or admit one past a maximum a reviewer set.
  const oneChar = String.fromCodePoint(0x1f600);
  const exactlyOne: CompiledSchema = {
    kind: "node",
    minLength: 1,
    maxLength: 1,
  };
  assert.ok(
    admits(oneChar, exactlyOne),
    "an astral character must count as one",
  );
  assert.deepEqual(failures("", exactlyOne), ["schema.min-length"]);
  assert.deepEqual(failures("ab", exactlyOne), ["schema.max-length"]);
});

test("HTTP-SCHEMA-15: array bounds and uniqueness are enforced and uniqueness is bounded", () => {
  const bounded: CompiledSchema = { kind: "node", minItems: 1, maxItems: 2 };
  assert.deepEqual(failures([], bounded), ["schema.min-items"]);
  assert.deepEqual(failures([1, 2, 3], bounded), ["schema.max-items"]);
  assert.ok(admits([1], bounded));

  const unique: CompiledSchema = { kind: "node", uniqueItems: true };
  assert.ok(admits([1, 2, { a: 1 }], unique));
  // By value again: two structurally equal objects are not unique.
  assert.deepEqual(failures([{ a: 1 }, { a: 1 }], unique), [
    "schema.unique-items",
  ]);
  // Past the bound the check itself is refused rather than run, because
  // canonicalising every entry of an unbounded array is the cost an attacker
  // would choose to impose.
  assert.deepEqual(
    failures(
      Array.from({ length: 1025 }, (_, i) => i),
      unique,
    ),
    ["schema.unique-items-bound"],
  );
});

test("HTTP-SCHEMA-16: the validator's own budgets refuse rather than recurse", () => {
  // A hostile value, not a hostile schema: one deep object against a
  // self-referential definition. The budget stops it and says which bound it
  // hit, so a caller cannot make validation the expensive part of a request.
  const definitions: SchemaDefinitions = {
    "#/Node": {
      kind: "node",
      types: ["object"],
      properties: { next: { kind: "ref", name: "#/Node" } },
    },
  };
  let deep: Record<string, unknown> = {};
  for (let i = 0; i < 40; i++) deep = { next: deep };
  const result = validateValue(
    deep,
    { kind: "ref", name: "#/Node" },
    definitions,
    { maxDepth: 6 },
  );
  assert.ok(
    result.some((f) => f.code === "schema.depth-exceeded"),
    "the depth bound must be reported",
  );

  const nodeBudget = validateValue(
    deep,
    { kind: "ref", name: "#/Node" },
    definitions,
    { maxNodes: 3 },
  );
  assert.deepEqual(
    nodeBudget.map((f) => f.code),
    ["schema.node-budget"],
  );
});
