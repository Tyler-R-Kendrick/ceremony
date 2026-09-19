import assert from "node:assert/strict";
import { test } from "node:test";
import {
  ARAZZO_LIMITS,
  ConditionSyntaxError,
  evaluateCondition,
  evaluateCriteria,
  isEvaluableReference,
  joinClassification,
  parseCondition,
  parseRuntimeExpression,
  resolveJsonPointer,
  validJsonPointer,
  type EvaluationContext,
} from "../../../src/server/connectors/formats/arazzo/index.js";

/*
 * WF-03: the bounded expression and criteria evaluator. Every case here is a
 * value the evaluator must handle without eval, without Function, without a
 * regular expression built from the condition, and without letting a private
 * value's influence be forgotten.
 */

const context: EvaluationContext = {
  statusCode: 200,
  url: "https://api.example.com/verify",
  method: "POST",
  responseHeaders: { "X-Verified": "true", "Retry-After": "30" },
  inputs: {
    region: { value: "eu", classification: "public" },
    password: { value: "hunter2", classification: "secret" },
    owner: { value: "ada@example.com", classification: "personal" },
    count: { value: 7, classification: "public" },
  },
  outputs: { account: { value: "acct_1", classification: "public" } },
  steps: {
    prepare: {
      outputs: {
        setup: {
          value: { id: "s1", nested: [1, 2, 3] },
          classification: "artifact",
        },
        ready: { value: true, classification: "public" },
      },
    },
  },
};

test("the evaluator implements exactly the documented expression forms", () => {
  for (const [text, kind] of [
    ["$url", "url"],
    ["$method", "method"],
    ["$statusCode", "statusCode"],
    ["$inputs.region", "inputs"],
    ["$outputs.account", "outputs"],
    ["$steps.prepare.outputs.setup", "steps"],
    ["$response.header.X-Verified", "response"],
  ] as const)
    assert.equal(parseRuntimeExpression(text)?.kind, kind, text);
  assert.equal(
    parseRuntimeExpression("$steps.prepare.outputs.setup#/nested/0")?.kind,
    "steps",
  );
  assert.equal(
    parseRuntimeExpression("$workflows.other.inputs.x")?.kind,
    "workflows",
  );
  assert.equal(parseRuntimeExpression("$self")?.kind, "self");
  for (const text of [
    "$",
    "$unknown",
    "$steps.prepare.setup",
    "$steps.pre pare.outputs.setup",
    "$inputs.",
    "$response.header.bad header",
    "$components.unknown.name",
    "$steps.a.outputs.b#bad-pointer",
    "$inputs.region#/~2",
    `$inputs.${"x".repeat(ARAZZO_LIMITS.expression)}`,
    `$statusCode${String.fromCharCode(0)}`,
  ])
    assert.equal(parseRuntimeExpression(text), undefined, text);
  // Only a subset is resolvable at runtime; the rest are description-only.
  assert.equal(
    isEvaluableReference(parseRuntimeExpression("$statusCode")!),
    true,
  );
  assert.equal(
    isEvaluableReference(
      parseRuntimeExpression("$response.header.X-Verified")!,
    ),
    true,
  );
  assert.equal(
    isEvaluableReference(parseRuntimeExpression("$response.body")!),
    false,
  );
  assert.equal(isEvaluableReference(parseRuntimeExpression("$self")!), false);
  assert.equal(validJsonPointer("/a/b~0c~1d"), true);
  assert.equal(validJsonPointer("/a/~2"), false);
  assert.equal(validJsonPointer("a"), false);
});

test("simple conditions evaluate with the documented literals, operators and coercions", () => {
  const pass = (condition: string) =>
    assert.equal(
      evaluateCondition(condition, context).satisfied,
      true,
      condition,
    );
  const fail = (condition: string) =>
    assert.equal(
      evaluateCondition(condition, context).satisfied,
      false,
      condition,
    );
  pass("$statusCode == 200");
  fail("$statusCode == 201");
  pass("$statusCode != 500");
  pass("$statusCode >= 200 && $statusCode < 300");
  pass("$statusCode > 199");
  pass("$statusCode <= 200");
  pass("$inputs.region == 'eu'");
  pass("$inputs.region == 'EU'"); // string comparisons are case insensitive
  pass("$response.header.x-verified == 'true'"); // header names are case insensitive
  pass("$response.header.X-Verified == true");
  pass("!($inputs.region == 'us')");
  pass("$inputs.region == 'us' || $statusCode == 200");
  fail("$inputs.region == 'us' && $statusCode == 200");
  pass("$steps.prepare.outputs.ready");
  pass("$steps.prepare.outputs.ready == true");
  pass("$outputs.account == 'acct_1'");
  pass("($statusCode == 200 || $statusCode == 201) && $inputs.count > 3");
  pass("$response.header.Retry-After == 30"); // numeric strings coerce
  pass("$inputs.count == '7'");
  pass("$statusCode == 200 && !($inputs.region != 'eu')");
  // Null equals only itself, and a null-valued condition fails.
  assert.equal(evaluateCondition("null == null", context).satisfied, true);
  assert.equal(evaluateCondition("null == 0", context).satisfied, false);
  assert.equal(evaluateCondition("null != 0", context).satisfied, true);
  assert.equal(evaluateCondition("null", context).satisfied, false);
  assert.equal(evaluateCondition("true", context).satisfied, true);
  assert.equal(evaluateCondition("false", context).satisfied, false);
  assert.equal(
    evaluateCondition("'it''s' == 'IT''S'", context).satisfied,
    true,
  );
  assert.equal(evaluateCondition("-2.5e1 < -24", context).satisfied, true);
});

test("evaluation fails closed for unresolved, unsupported and incomparable values", () => {
  for (const [condition, reason] of [
    ["$inputs.absent == 'eu'", "unresolved-reference"],
    ["$steps.absent.outputs.x == 1", "unresolved-reference"],
    ["$steps.prepare.outputs.absent == 1", "unresolved-reference"],
    ["$response.header.Absent == '1'", "unresolved-reference"],
    ["$statusCode < $url", "incomparable"],
    ["$steps.prepare.outputs.setup > 1", "incomparable"],
    ["$statusCode", "non-boolean"],
    ["$response.body == 1", "unsupported-reference"],
  ] as const) {
    const result = evaluateCondition(condition, context);
    assert.equal(result.satisfied, false, condition);
    assert.equal(result.reason, reason, condition);
    assert.equal(result.classification, "unclassified");
  }
  // A missing context resolves nothing rather than inventing a default.
  assert.equal(
    evaluateCondition("$statusCode == 200", {}).reason,
    "unresolved-reference",
  );
});

test("AC-IMP-08 a value derived from a private input stays private", () => {
  assert.equal(joinClassification("public", "artifact"), "artifact");
  assert.equal(
    joinClassification("public", "personal", "artifact"),
    "personal",
  );
  assert.equal(joinClassification("secret", "personal"), "secret");
  assert.equal(joinClassification("public", "unclassified"), "unclassified");
  assert.equal(joinClassification(), "public");
  assert.equal(
    evaluateCondition("$statusCode == 200", context).classification,
    "public",
  );
  assert.equal(
    evaluateCondition("$inputs.password == 'hunter2'", context).classification,
    "secret",
    "a comparison against a secret is itself secret",
  );
  assert.equal(
    evaluateCondition("$inputs.owner != 'x'", context).classification,
    "personal",
  );
  assert.equal(
    evaluateCondition("$steps.prepare.outputs.setup == 1", context)
      .classification,
    "artifact",
  );
  assert.equal(
    evaluateCondition("!($inputs.password == 'x')", context).classification,
    "secret",
    "negation does not launder a classification",
  );
  assert.equal(
    evaluateCondition(
      "$statusCode == 200 && $inputs.password == 'hunter2'",
      context,
    ).classification,
    "secret",
  );
  // Short-circuit keeps only what it actually read.
  assert.equal(
    evaluateCondition(
      "$statusCode == 999 && $inputs.password == 'hunter2'",
      context,
    ).classification,
    "public",
  );
  assert.equal(
    evaluateCondition(
      "$statusCode == 200 || $inputs.password == 'hunter2'",
      context,
    ).classification,
    "public",
  );
  const joint = evaluateCriteria(
    ["$statusCode == 200", "$inputs.owner == 'ada@example.com'"],
    context,
  );
  assert.equal(joint.satisfied, true);
  assert.equal(joint.classification, "personal");
  assert.equal(
    evaluateCriteria(["$statusCode == 200", "$statusCode == 404"], context)
      .satisfied,
    false,
    "every criterion must pass",
  );
});

test("the parser is bounded and rejects anything outside the simple grammar", () => {
  const rejects = (condition: string, code: string) => {
    assert.throws(
      () => parseCondition(condition),
      (error: unknown) =>
        error instanceof ConditionSyntaxError && error.code === code,
      `${condition} -> ${code}`,
    );
  };
  rejects("", "empty");
  rejects("   ", "empty");
  rejects("x".repeat(ARAZZO_LIMITS.condition + 1), "too-long");
  rejects("$statusCode == 'unterminated", "unterminated-string");
  rejects("$statusCode == 1..2", "invalid-number");
  rejects("$statusCode == 007", "invalid-number");
  rejects("$bogus == 1", "invalid-expression");
  rejects("$statusCode === 200", "unexpected-character");
  rejects("$statusCode = 200", "unexpected-character");
  rejects("$statusCode & 200", "unexpected-character");
  rejects("$statusCode == 200)", "unexpected-token");
  rejects("($statusCode == 200", "unexpected-end");
  rejects("$statusCode == ", "unexpected-end");
  rejects("1 < 2 < 3", "chained-comparison");
  rejects("undefinedWord", "unexpected-token");
  rejects("$statusCode == 200 @ 1", "unexpected-character");
  rejects("$response.body[0] == 1", "unexpected-character");
  rejects(
    `'${"x".repeat(ARAZZO_LIMITS.evaluator.literal + 1)}'`,
    "literal-too-long",
  );
  rejects("(".repeat(ARAZZO_LIMITS.evaluator.depth + 2) + "true", "too-deep");
  rejects("!".repeat(ARAZZO_LIMITS.evaluator.depth + 2) + "true", "too-deep");
  rejects(
    Array.from({ length: ARAZZO_LIMITS.evaluator.tokens }, () => "true").join(
      " && ",
    ),
    "too-many-tokens",
  );
  // Nothing that looks like code is a way in.
  for (const attempt of [
    "constructor.constructor('return 1')()",
    "$statusCode == 200; process.exit(1)",
    "${process.env.SECRET}",
    "$statusCode == 200 ? 1 : 2",
    "$inputs.region.replace('a','b') == 'x'",
    "__proto__ == 1",
    "$statusCode.toString() == '200'",
  ])
    assert.throws(() => parseCondition(attempt), ConditionSyntaxError, attempt);
});

test("a malformed condition fails closed rather than throwing at its caller", () => {
  /*
   * `parseCondition` throwing is the point of it: a host that pre-parses wants
   * the position and the code. `evaluateCondition` promises the opposite, and
   * the condition it is handed is document content like any other, so a
   * criterion nobody can parse is a criterion that does not pass — never an
   * exception a caller of the evaluator has to be ready for.
   */
  for (const condition of [
    "$statusCode ==",
    "$$$ &&&",
    "$statusCode == 200 == 300",
    "",
    "constructor.constructor('return 1')()",
  ]) {
    const result = evaluateCondition(condition, context);
    assert.equal(result.satisfied, false, condition);
    assert.equal(result.reason, "syntax", condition);
    assert.equal(result.classification, "unclassified", condition);
  }

  // One unparsable criterion must not cost the caller the ones that did
  // evaluate: the joint answer is still false, with every result reported.
  const joint = evaluateCriteria(
    ["$statusCode == 200", "$statusCode =="],
    context,
  );
  assert.equal(joint.satisfied, false);
  assert.equal(joint.results.length, 2);
  assert.equal(joint.results[0]?.satisfied, true);
  assert.equal(joint.results[1]?.reason, "syntax");

  // A condition parsed ahead of time still evaluates exactly as before.
  assert.equal(
    evaluateCondition(parseCondition("$statusCode == 200"), context).satisfied,
    true,
  );
});

test("the evaluator reads only own plain-data properties through JSON pointers", () => {
  assert.deepEqual(resolveJsonPointer({ a: { b: [1, 2] } }, "/a/b/1"), 2);
  assert.deepEqual(resolveJsonPointer({ "a/b": 1 }, "/a~1b"), 1);
  assert.equal(resolveJsonPointer({ a: 1 }, "/missing"), undefined);
  assert.equal(resolveJsonPointer({ a: 1 }, "/a/deeper"), undefined);
  assert.equal(resolveJsonPointer([1], "/x"), undefined);
  assert.equal(resolveJsonPointer({}, "/constructor"), undefined);
  assert.equal(resolveJsonPointer({}, "/toString"), undefined);
  assert.deepEqual(resolveJsonPointer({ a: 1 }, ""), { a: 1 });
  assert.equal(
    evaluateCondition("$steps.prepare.outputs.setup#/id == 's1'", context)
      .satisfied,
    true,
  );
  assert.equal(
    evaluateCondition("$steps.prepare.outputs.setup#/nested/2 == 3", context)
      .satisfied,
    true,
  );
  assert.equal(
    evaluateCondition("$steps.prepare.outputs.setup#/id == 's1'", context)
      .classification,
    "artifact",
    "a pointer into a private value keeps its classification",
  );
  assert.equal(
    evaluateCondition("$steps.prepare.outputs.setup#/absent == 1", context)
      .reason,
    "unresolved-reference",
  );
  const deep = "/a".repeat(ARAZZO_LIMITS.evaluator.pointerSegments + 1);
  assert.equal(
    evaluateCondition(`$inputs.region#${deep} == 1`, context).reason,
    "pointer-limit",
  );
});

test("a parsed condition can be reused and reports the references it reads", () => {
  const parsed = parseCondition("$statusCode == 200 && $inputs.region == 'eu'");
  assert.deepEqual(
    parsed.references.map((reference) => reference.text),
    ["$statusCode", "$inputs.region"],
  );
  assert.equal(evaluateCondition(parsed, context).satisfied, true);
  assert.equal(
    evaluateCondition(parsed, { ...context, statusCode: 500 }).satisfied,
    false,
  );
  assert.equal(parsed.source, "$statusCode == 200 && $inputs.region == 'eu'");
});
