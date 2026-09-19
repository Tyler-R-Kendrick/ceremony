import assert from "node:assert/strict";
import { test } from "node:test";
import {
  applyOverlay,
  parseJsonPath,
  selectNodes,
} from "../../../src/server/connectors/formats/overlay/index.js";

/*
 * HTTP-05: versioned Overlay application with a bounded, documented selector
 * subset. Anything the selector grammar does not implement is refused with a
 * blocking `structure.unsupported-selector` diagnostic; approximating a filter
 * would silently change which endpoints an overlay rewrites.
 */

const base = () => ({
  openapi: "3.1.0",
  info: { title: "Base", version: "1.0.0" },
  servers: [{ url: "https://base.example.test" }],
  paths: {
    "/a": {
      get: {
        operationId: "a",
        tags: ["one", "dummy"],
        parameters: [
          { name: "keep", in: "query" },
          { name: "dummy", in: "query" },
        ],
        responses: { "200": { description: "ok" } },
      },
    },
    "/b": {
      get: { operationId: "b", responses: { "200": { description: "ok" } } },
    },
  },
});

const overlay = (version: string, actions: unknown[]) => ({
  overlay: version,
  info: { title: "Test overlay", version: "1.0.0" },
  actions,
});

test("the overlay version selects the profile and is never guessed", () => {
  const missing = applyOverlay(base(), {
    info: { title: "x", version: "1" },
    actions: [],
  });
  assert.equal(missing.applied, false);
  assert.equal(missing.issues[0]?.code, "version.missing");
  assert.equal(missing.issues[0]?.severity, "blocking");

  const future = applyOverlay(
    base(),
    overlay("2.0.0", [{ target: "$", update: {} }]),
  );
  assert.equal(future.applied, false);
  assert.equal(future.issues[0]?.code, "version.unsupported");

  // The patch component addresses errata, not the feature set.
  const patched = applyOverlay(
    base(),
    overlay("1.0.3", [{ target: "$.info", update: { title: "Patched" } }]),
  );
  assert.equal(patched.version, "1.0.0");
  assert.equal(patched.applied, true);
});

test("update merges into an object target recursively", () => {
  const result = applyOverlay(
    base(),
    overlay("1.0.0", [
      {
        target: "$.paths['/a'].get",
        update: {
          summary: "Added",
          responses: { "404": { description: "gone" } },
        },
      },
    ]),
  );
  assert.equal(result.applied, true);
  const document = result.document as ReturnType<typeof base>;
  const operation = document.paths["/a"].get as Record<string, unknown>;
  assert.equal(operation.summary, "Added");
  // A property only in the target is left alone; one only in the update is added.
  assert.deepEqual(operation.responses, {
    "200": { description: "ok" },
    "404": { description: "gone" },
  });
  assert.equal(operation.operationId, "a");
});

test("1.0.0 appends a single entry to an array target and refuses an array update", () => {
  const appended = applyOverlay(
    base(),
    overlay("1.0.0", [
      {
        target: "$.paths['/a'].get.parameters",
        update: { name: "newParam", in: "query" },
      },
    ]),
  );
  assert.equal(appended.applied, true);
  const parameters = (appended.document as ReturnType<typeof base>).paths["/a"]
    .get.parameters;
  assert.equal(parameters.length, 3);
  assert.deepEqual(parameters[2], { name: "newParam", in: "query" });

  const refused = applyOverlay(
    base(),
    overlay("1.0.0", [
      {
        target: "$.paths['/a'].get.parameters",
        update: [{ name: "x", in: "query" }],
      },
    ]),
  );
  assert.equal(refused.applied, false);
  assert.equal(refused.issues[0]?.code, "structure.array-update-not-an-entry");
});

test("1.1.0 concatenates an array update and appends anything else", () => {
  const concatenated = applyOverlay(
    base(),
    overlay("1.1.0", [
      {
        target: "$.paths['/a'].get.parameters",
        update: [
          { name: "top", in: "query" },
          { name: "skip", in: "query" },
        ],
      },
    ]),
  );
  assert.equal(concatenated.applied, true);
  const parameters = (concatenated.document as ReturnType<typeof base>).paths[
    "/a"
  ].get.parameters;
  assert.equal(parameters.length, 4);
  assert.deepEqual(parameters[3], { name: "skip", in: "query" });
});

test("1.1.0 replaces a primitive target; 1.0.0 refuses one", () => {
  const replaced = applyOverlay(
    base(),
    overlay("1.1.0", [{ target: "$.info.title", update: "Renamed" }]),
  );
  assert.equal(replaced.applied, true);
  assert.equal(
    (replaced.document as ReturnType<typeof base>).info.title,
    "Renamed",
  );

  const refused = applyOverlay(
    base(),
    overlay("1.0.0", [{ target: "$.info.title", update: "Renamed" }]),
  );
  assert.equal(refused.applied, false);
  assert.equal(
    refused.issues[0]?.code,
    "structure.primitive-target-unsupported",
  );
  // The document is returned unchanged when an action cannot be applied.
  assert.deepEqual(refused.document, base());
});

test("remove deletes the target from its container, and 1.1.0 removes primitives from arrays", () => {
  const removed = applyOverlay(
    base(),
    overlay("1.0.0", [{ target: "$.paths['/b']", remove: true }]),
  );
  assert.equal(removed.applied, true);
  assert.deepEqual(
    Object.keys((removed.document as ReturnType<typeof base>).paths),
    ["/a"],
  );

  const primitive = applyOverlay(
    base(),
    overlay("1.1.0", [{ target: "$.paths['/a'].get.tags[1]", remove: true }]),
  );
  assert.equal(primitive.applied, true);
  assert.deepEqual(
    (primitive.document as ReturnType<typeof base>).paths["/a"].get.tags,
    ["one"],
  );

  const refusedIn10 = applyOverlay(
    base(),
    overlay("1.0.0", [{ target: "$.paths['/a'].get.tags[1]", remove: true }]),
  );
  assert.equal(refusedIn10.applied, false);
  assert.equal(
    refusedIn10.issues[0]?.code,
    "structure.primitive-target-unsupported",
  );
});

test("removing several array items by index does not shift the wrong ones", () => {
  const document = { list: ["a", "b", "c", "d"] };
  const result = applyOverlay(
    document,
    overlay("1.1.0", [{ target: "$.list[*]", remove: true }]),
  );
  assert.equal(result.applied, true);
  assert.deepEqual((result.document as typeof document).list, []);

  const partial = applyOverlay(
    { list: ["a", "b", "c", "d"] },
    overlay("1.1.0", [{ target: "$.list[1]", remove: true }]),
  );
  assert.deepEqual((partial.document as typeof document).list, ["a", "c", "d"]);
});

test("actions apply in order, each to the result of the previous one", () => {
  const result = applyOverlay(
    base(),
    overlay("1.0.0", [
      { target: "$.paths['/b']", remove: true },
      {
        target: "$.paths",
        update: { "/b": { get: { operationId: "recreated" } } },
      },
      { target: "$.paths['/b'].get", update: { summary: "second pass" } },
    ]),
  );
  assert.equal(result.applied, true);
  const document = result.document as Record<
    string,
    Record<string, Record<string, Record<string, unknown>>>
  >;
  assert.equal(document.paths?.["/b"]?.get?.operationId, "recreated");
  assert.equal(document.paths?.["/b"]?.get?.summary, "second pass");
  assert.deepEqual(
    result.actions.map((action) => action.applied),
    [1, 1, 1],
  );
});

test("a target selecting zero nodes succeeds without changing the document", () => {
  const result = applyOverlay(
    base(),
    overlay("1.0.0", [
      { target: "$.paths['/nonexistent'].get", update: { summary: "x" } },
    ]),
  );
  assert.equal(result.applied, true);
  assert.deepEqual(result.document, base());
  assert.equal(result.actions[0]?.matched, 0);
  assert.equal(result.actions[0]?.applied, 0);
  assert.ok(!result.issues.some((issue) => issue.severity === "blocking"));
});

test("a wildcard and a recursive descent select every matching node", () => {
  const result = applyOverlay(
    base(),
    overlay("1.0.0", [
      { target: "$.paths.*.get", update: { "x-marked": true } },
    ]),
  );
  assert.equal(result.applied, true);
  const document = result.document as ReturnType<typeof base>;
  assert.equal(
    (document.paths["/a"].get as Record<string, unknown>)["x-marked"],
    true,
  );
  assert.equal(
    (document.paths["/b"].get as Record<string, unknown>)["x-marked"],
    true,
  );
  assert.equal(result.actions[0]?.matched, 2);

  const descent = applyOverlay(
    base(),
    overlay("1.0.0", [
      { target: "$..responses", update: { "500": { description: "boom" } } },
    ]),
  );
  assert.equal(descent.applied, true);
  assert.equal(descent.actions[0]?.matched, 2);
});

test("selectors outside the documented subset are refused, not approximated", () => {
  for (const [target, reason] of [
    [
      "$.paths.*.get.parameters[?@.name == 'dummy']",
      "filter-selector-unsupported",
    ],
    ["$.list[0:2]", "slice-selector-unsupported"],
    ["$.list[0,1]", "union-selector-unsupported"],
    ["$.list[-1]", "negative-index-unsupported"],
    ["$.paths[(@.length-1)]", "script-selector-unsupported"],
    ["paths.a", "must-start-at-root"],
  ] as const) {
    const parsed = parseJsonPath(target);
    assert.equal(parsed.ok, false, `${target} should not parse`);
    assert.equal(parsed.ok === false && parsed.reason, reason);

    const result = applyOverlay(
      base(),
      overlay("1.1.0", [{ target, update: {} }]),
    );
    assert.equal(result.applied, false);
    const issue = result.issues.find(
      (item) => item.code === "structure.unsupported-selector",
    );
    assert.ok(issue, `${target} produced no unsupported-selector issue`);
    assert.equal(issue.severity, "blocking");
    assert.equal(issue.executionImpact, "blocks-definition");
    assert.ok(issue.remediation?.includes("recursive descent"));
    // Nothing was changed by a refused overlay.
    assert.deepEqual(result.document, base());
  }
});

test("the documented selector grammar parses and selects exactly what it claims", () => {
  const document = {
    a: { b: { c: 1 } },
    "odd key": { x: 2 },
    list: [10, 20, 30],
    deep: { nested: { target: "found" } },
  };
  const cases: Array<[string, unknown[]]> = [
    ["$", [document]],
    ["$.a.b.c", [1]],
    ["$['odd key'].x", [2]],
    ['$["odd key"].x', [2]],
    ["$.list[1]", [20]],
    ["$.list[*]", [10, 20, 30]],
    ["$.a.*", [{ c: 1 }]],
    ["$..target", ["found"]],
    ["$.list[9]", []],
  ];
  for (const [expression, expected] of cases) {
    const parsed = parseJsonPath(expression);
    assert.equal(parsed.ok, true, `${expression} did not parse`);
    const matches = selectNodes(document, parsed.ok ? parsed.segments : [], {
      nodes: 0,
      limit: 10_000,
    });
    assert.deepEqual(
      matches.map((match) => match.value),
      expected,
      `${expression} selected the wrong nodes`,
    );
  }
});

test("a recursive descent is bounded by a node budget rather than running away", () => {
  const wide: Record<string, unknown> = {};
  for (let index = 0; index < 200; index++)
    wide[`branch${index}`] = { child: { leaf: index } };
  const result = applyOverlay(
    wide,
    overlay("1.1.0", [{ target: "$..leaf", update: 0 }]),
    {
      limits: { maxSelectionNodes: 50 },
    },
  );
  assert.equal(result.applied, false);
  assert.equal(result.issues[0]?.code, "structure.selection-budget");
  assert.deepEqual(result.document, wide);
});

test("a document that cannot be serialized within bounds is refused, not thrown", () => {
  // Shared references expand exponentially when serialized; the applier reports
  // it as a bounded diagnostic instead of letting the error escape.
  let shared: Record<string, unknown> = { leaf: true };
  for (let index = 0; index < 400; index++) shared = { a: shared, b: shared };
  const result = applyOverlay(
    shared,
    overlay("1.1.0", [{ target: "$.a", update: {} }]),
  );
  assert.equal(result.applied, false);
  assert.equal(result.issues[0]?.code, "structure.document-too-large");
  assert.equal(result.issues[0]?.severity, "blocking");
});

test("an update value the applier cannot clone is refused, not thrown", () => {
  // The document clone above is guarded; the clone of the value an action
  // applies is the other half of the same promise. A hostile overlay carries
  // either more than the budget allows or, from a YAML alias cycle, a
  // structure that cannot be serialized at all, and both must arrive as the
  // documented blocking diagnostic with the input document handed back
  // unchanged. Thrown out of `applyOverlay`, either one would reach a caller
  // that was told failure looks like a result.
  const oversized = applyOverlay(
    base(),
    overlay("1.1.0", [
      { target: "$.paths['/a']", update: { blob: "x".repeat(5000) } },
    ]),
    // 64 nodes buys a 4096-character budget: past the update, short of the
    // 364-character document, so the update is what exceeds it.
    { limits: { maxUpdateNodes: 64 } },
  );
  assert.equal(oversized.applied, false);
  assert.equal(oversized.issues[0]?.code, "structure.update-too-large");
  assert.equal(oversized.issues[0]?.severity, "blocking");
  assert.equal(oversized.issues[0]?.sourcePointer, "#/actions/0/update");
  assert.deepEqual(oversized.document, base());

  const cyclic: Record<string, unknown> = { name: "loop" };
  cyclic["self"] = cyclic;
  const circular = applyOverlay(
    base(),
    overlay("1.1.0", [{ target: "$.paths['/a']", update: cyclic }]),
  );
  assert.equal(circular.applied, false);
  assert.equal(circular.issues[0]?.code, "structure.update-too-large");
  assert.deepEqual(circular.document, base());
});

test("an update whose property types are incompatible is an error, not an overwrite", () => {
  const result = applyOverlay(
    base(),
    overlay("1.1.0", [
      {
        target: "$.paths['/a'].get",
        update: { parameters: { not: "an array" } },
      },
    ]),
  );
  assert.equal(result.applied, false);
  assert.equal(result.issues[0]?.code, "structure.incompatible-update");
  assert.deepEqual(result.document, base());
});

test("a target selecting nodes of different shapes is refused", () => {
  const document = { items: { one: { a: 1 }, two: [1, 2] } };
  const result = applyOverlay(
    document,
    overlay("1.1.0", [{ target: "$.items.*", update: { x: 1 } }]),
  );
  assert.equal(result.applied, false);
  assert.equal(result.issues[0]?.code, "structure.mixed-target-shapes");
});

test("copy is a 1.1.0 feature and must select exactly one node", () => {
  const document = {
    paths: { "/source": { get: { operationId: "s" } }, "/target": {} },
  };
  const copied = applyOverlay(
    document,
    overlay("1.1.0", [
      { target: "$.paths['/target']", copy: "$.paths['/source']" },
    ]),
  );
  assert.equal(copied.applied, true);
  assert.deepEqual((copied.document as typeof document).paths["/target"], {
    get: { operationId: "s" },
  });

  const inTenZero = applyOverlay(
    document,
    overlay("1.0.0", [
      { target: "$.paths['/target']", copy: "$.paths['/source']" },
    ]),
  );
  assert.equal(inTenZero.applied, false);
  assert.equal(inTenZero.issues[0]?.code, "structure.copy-unsupported");

  const ambiguous = applyOverlay(
    document,
    overlay("1.1.0", [{ target: "$.paths['/target']", copy: "$.paths.*" }]),
  );
  assert.equal(ambiguous.applied, false);
  assert.equal(ambiguous.issues[0]?.code, "structure.copy-not-single");
});

test("extends is pinned to the source by digest or identity", () => {
  const source = {
    digest: "a".repeat(64),
    identity: "https://base.example.test/openapi.json",
  };
  const byIdentity = applyOverlay(
    base(),
    {
      ...overlay("1.0.0", [{ target: "$.info", update: { title: "x" } }]),
      extends: source.identity,
    },
    { source },
  );
  assert.equal(byIdentity.extends?.match, "identity");
  assert.equal(byIdentity.applied, true);

  const byDigest = applyOverlay(
    base(),
    {
      ...overlay("1.0.0", [{ target: "$.info", update: { title: "x" } }]),
      extends: `urn:sha256:${source.digest}`,
    },
    { source },
  );
  assert.equal(byDigest.extends?.match, "digest");

  const mismatched = applyOverlay(
    base(),
    {
      ...overlay("1.0.0", [{ target: "$.info", update: { title: "x" } }]),
      extends: "https://other.example.test/openapi.json",
    },
    { source },
  );
  assert.equal(mismatched.extends?.match, "mismatch");
  // Applying anyway is the caller's decision, and it is warned about.
  assert.equal(mismatched.applied, true);
  assert.ok(
    mismatched.issues.some(
      (issue) => issue.code === "structure.extends-mismatch",
    ),
  );

  const required = applyOverlay(
    base(),
    {
      ...overlay("1.0.0", [{ target: "$.info", update: { title: "x" } }]),
      extends: "https://other.example.test/openapi.json",
    },
    { source, requireExtendsMatch: true },
  );
  assert.equal(required.applied, false);
  assert.deepEqual(required.document, base());
});

test("application records transformation provenance with input and output digests", () => {
  const result = applyOverlay(
    base(),
    overlay("1.1.0", [{ target: "$.info.title", update: "Renamed" }]),
  );
  assert.ok(result.adaptation);
  assert.equal(result.adaptation.step, "overlay-1.1.0");
  assert.match(result.adaptation.inputDigest, /^[a-f0-9]{64}$/);
  assert.match(result.adaptation.outputDigest, /^[a-f0-9]{64}$/);
  assert.notEqual(
    result.adaptation.inputDigest,
    result.adaptation.outputDigest,
  );

  // The same overlay over the same document yields the same digests.
  const again = applyOverlay(
    base(),
    overlay("1.1.0", [{ target: "$.info.title", update: "Renamed" }]),
  );
  assert.deepEqual(result.adaptation, again.adaptation);
});

test("the input document is never mutated", () => {
  const document = base();
  const snapshot = JSON.stringify(document);
  applyOverlay(
    document,
    overlay("1.0.0", [{ target: "$.paths['/a']", remove: true }]),
  );
  assert.equal(JSON.stringify(document), snapshot);
});

test("an overlay cannot inject a prototype through a target or an update", () => {
  const result = applyOverlay(
    { a: {} },
    overlay("1.1.0", [
      {
        target: "$.a",
        update: JSON.parse('{"__proto__": {"polluted": true}}'),
      },
    ]),
  );
  assert.equal(result.applied, true);
  assert.equal(({} as Record<string, unknown>).polluted, undefined);
  assert.equal(
    Object.getPrototypeOf(result.document as object),
    Object.prototype,
  );
  assert.equal(
    (Object.prototype as Record<string, unknown>).polluted,
    undefined,
  );
});

test("an overlay with no actions, or a non-object overlay, is refused", () => {
  assert.equal(
    applyOverlay(base(), overlay("1.0.0", [])).issues[0]?.code,
    "structure.actions-missing",
  );
  assert.equal(
    applyOverlay(base(), "not an overlay").issues[0]?.code,
    "structure.not-an-object",
  );
  const rootRemove = applyOverlay(
    base(),
    overlay("1.1.0", [{ target: "$", remove: true }]),
  );
  assert.equal(rootRemove.applied, false);
  assert.equal(rootRemove.issues[0]?.code, "structure.remove-root");
});
