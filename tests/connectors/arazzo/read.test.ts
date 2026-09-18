import assert from "node:assert/strict";
import { test } from "node:test";
import {
  ARAZZO_LIMITS,
  readArazzo,
} from "../../../src/server/connectors/formats/arazzo/index.js";
import { normalizedDefinitionSchema } from "../../../src/core/connectors/index.js";
import {
  ambiguousOperation101,
  cyclicSteps110,
  full110,
  storeWorkflow101,
  unknownVersions,
} from "../fixtures/arazzo/documents.ts";

/*
 * WF-01: bounded parse, validation and native preservation for Arazzo 1.0.1
 * and 1.1.0. The reader is the only thing under test here: no host catalog,
 * no registry, no execution.
 */

const codes = (issues: ReadonlyArray<{ code: string }>) =>
  issues.map((issue) => issue.code);
const find = (
  issues: ReadonlyArray<{ code: string; sourcePointer: string }>,
  code: string,
) => issues.filter((issue) => issue.code === code);

test("AC-IMP-08 the reader preserves a 1.0.1 description and projects one capability per workflow", () => {
  const source = storeWorkflow101();
  const read = readArazzo(source);
  assert.equal(read.version, "1.0.1");
  assert.equal(read.profile, "arazzo-1.0.1");
  assert.deepEqual(
    read.issues.filter((issue) => issue.severity === "blocking"),
    [],
  );
  const document = read.document!;
  assert.equal(document.arazzo, "1.0.1");
  assert.equal(document.info.title, "Store connection");
  assert.equal(document.info.summary, "Connect and verify a store account");
  assert.deepEqual(
    document.sourceDescriptions.map((item) => [item.name, item.url, item.type]),
    [["store", "https://api.example.com/openapi.json", "openapi"]],
  );
  const workflow = document.workflows[0]!;
  assert.equal(workflow.workflowId, "connect-store");
  assert.deepEqual(workflow.inputs, {
    type: "object",
    properties: { region: { type: "string" } },
    required: ["region"],
  });
  const [prepare, verify] = workflow.steps;
  assert.equal(prepare!.operationId, "prepareConnection");
  assert.deepEqual(prepare!.parameters, [
    { pointer: "/workflows/0/steps/0/parameters/0", name: "region", in: "query", value: "$inputs.region", extensions: {}, unknown: {} },
  ]);
  assert.deepEqual(prepare!.successCriteria?.map((item) => item.condition), [
    "$statusCode == 200",
  ]);
  assert.deepEqual(prepare!.outputs, { setup: "$response.body#/setup" });
  assert.deepEqual(
    verify!.onFailure?.map((item) => ("type" in item ? item.type : item.reference)),
    ["retry"],
  );
  assert.deepEqual(workflow.outputs, { account: "$steps.verify.outputs.account" });

  const definition = read.definition!;
  assert.deepEqual(normalizedDefinitionSchema.parse(definition), definition);
  assert.equal(definition.identity.ecosystem, "arazzo");
  assert.equal(definition.identity.nativeId, "Store connection");
  assert.equal(definition.identity.nativeVersion, "1.0.0");
  assert.deepEqual(definition.capabilities, [
    {
      kind: "custom",
      nativeId: "connect-store",
      label: "Connect the store account",
      summary: "Prepare a connection and verify the resulting account.",
      effect: "unknown",
      dataClassification: "unknown",
      cost: "unknown",
      inputSchemaRef: "/workflows/0/inputs",
    },
  ]);
  assert.deepEqual(definition.declaredServers, [
    {
      url: "https://api.example.com/openapi.json",
      description: "store OpenAPI source description",
      status: "declared",
    },
  ]);
  assert.equal(definition.compatibility.dimensions.import, "exact");
  assert.equal(definition.compatibility.dimensions.invoke, "requires-configuration");
  assert.deepEqual(definition.authentication, []);
});

test("AC-IMP-08 the reader preserves every 1.1.0 construct, including ones it cannot execute", () => {
  const read = readArazzo(full110());
  assert.equal(read.version, "1.1.0");
  assert.equal(read.profile, "arazzo-1.1.0");
  assert.deepEqual(
    read.issues.filter((issue) => issue.severity === "blocking"),
    [],
  );
  const document = read.document!;
  assert.equal(document.self, "https://api.example.com/workflows/store.arazzo.yaml");
  assert.deepEqual(document.extensions, { "x-generator": "fixture" });
  assert.deepEqual(document.info.extensions, { "x-owner": "platform" });
  const workflow = document.workflows[0]!;
  assert.deepEqual(workflow.extensions, { "x-team": "connections" });
  const [prepare, collect] = workflow.steps;
  assert.equal(prepare!.timeout, 6000);
  assert.deepEqual(prepare!.parameters?.[1], {
    reference: "$components.parameters.storeId",
  });
  assert.deepEqual(prepare!.requestBody?.replacements?.map((item) => item.target), [
    "/region",
  ]);
  assert.equal(collect!.channelPath, "{$sourceDescriptions.events.url}#/channels/orders");
  assert.equal(collect!.action, "receive");
  assert.deepEqual(collect!.dependsOn, ["prepare"]);
  assert.deepEqual(collect!.outputs, {
    detail: { context: "$message.payload", selector: "$.detail", type: "jsonpath" },
  });
  assert.deepEqual(Object.keys(document.components!.parameters!), ["storeId"]);
  assert.deepEqual(Object.keys(document.components!.failureActions!), ["again"]);
  assert.deepEqual(document.components!.inputs, { pagination: { type: "object" } });
  // Only the OpenAPI source becomes a declared server; asyncapi is described, not served.
  assert.deepEqual(
    read.definition!.declaredServers.map((server) => server.url),
    ["https://api.example.com/openapi.json"],
  );
});

test("AC-IMP-08 1.1.0-only constructs in a 1.0.1 document are preserved and blocked, never reinterpreted", () => {
  const document = full110();
  document.arazzo = "1.0.1";
  const read = readArazzo(document);
  assert.equal(read.version, "1.0.1");
  const blocking = read.issues.filter((issue) => issue.severity === "blocking");
  const unavailable = blocking.filter(
    (issue) => issue.code === "arazzo.version.field-unavailable",
  );
  for (const pointer of [
    "/$self",
    "/workflows/0/steps/0/timeout",
    "/workflows/0/steps/1/channelPath",
    "/workflows/0/steps/1/correlationId",
    "/workflows/0/steps/1/action",
    "/workflows/0/steps/1/dependsOn",
  ])
    assert.ok(
      unavailable.some((issue) => issue.sourcePointer === pointer),
      pointer,
    );
  const preserved = read.document!;
  assert.equal(preserved.self, undefined);
  assert.equal(preserved.workflows[0]!.steps[0]!.timeout, undefined);
  // Preserved, not interpreted: the value is still visible to a reviewer.
  assert.equal(preserved.workflows[0]!.steps[0]!.unknown.timeout, 6000);
  assert.equal(preserved.unknown.$self, "https://api.example.com/workflows/store.arazzo.yaml");
  // The asyncapi source type did not exist in 1.0.1 either.
  assert.ok(
    unavailable.some((issue) => issue.sourcePointer === "/sourceDescriptions/1/type"),
  );
});

test("AC-IMP-08 an unknown Arazzo version blocks with its version preserved verbatim", () => {
  for (const version of unknownVersions) {
    const document = storeWorkflow101();
    document.arazzo = version;
    const read = readArazzo(document);
    assert.equal(read.version, undefined);
    assert.equal(read.document, undefined);
    assert.equal(read.definition, undefined);
    assert.equal(read.declaredVersion, version);
    assert.deepEqual(codes(read.issues), ["arazzo.version.unsupported"]);
    assert.equal(read.issues[0]!.severity, "blocking");
    assert.equal(read.issues[0]!.executionImpact, "blocks-definition");
    // The reader never writes a version back into the document it was given.
    assert.equal(document.arazzo, version);
  }
  const missing = readArazzo({ info: {}, workflows: [] });
  assert.deepEqual(codes(missing.issues), ["arazzo.version.missing"]);
  assert.deepEqual(codes(readArazzo([]).issues), ["arazzo.structure.not-object"]);
  assert.deepEqual(codes(readArazzo("1.0.1").issues), ["arazzo.structure.not-object"]);
});

test("AC-IMP-09 bounds refuse hostile shape before interpretation and never mutate runtime objects", () => {
  let deep: unknown = { arazzo: "1.0.1" };
  for (let index = 0; index < ARAZZO_LIMITS.depth + 4; index++) deep = { nested: deep };
  assert.deepEqual(codes(readArazzo(deep).issues), ["arazzo.structure.limit-exceeded"]);

  const wide = storeWorkflow101();
  (wide.workflows as unknown[]) = Array.from(
    { length: ARAZZO_LIMITS.workflows + 1 },
    (_, index) => ({
      workflowId: `w${index}`,
      summary: "s",
      steps: [{ stepId: "a", description: "d", operationId: "o" }],
    }),
  );
  assert.ok(
    codes(readArazzo(wide).issues).includes("arazzo.structure.too-many"),
    "a workflow list beyond the bound is refused, not truncated",
  );

  const longString = storeWorkflow101();
  (longString.info as Record<string, unknown>).title = "x".repeat(
    ARAZZO_LIMITS.string + 1,
  );
  assert.ok(codes(readArazzo(longString).issues).includes("arazzo.structure.limit-exceeded"));

  const polluted = JSON.parse(
    '{"arazzo":"1.0.1","__proto__":{"polluted":true},"info":{"title":"t","version":"1"},"sourceDescriptions":[],"workflows":[]}',
  ) as Record<string, unknown>;
  assert.deepEqual(codes(readArazzo(polluted).issues), ["arazzo.structure.reserved-key"]);
  assert.equal(
    ({} as Record<string, unknown>).polluted,
    undefined,
    "no prototype was mutated",
  );

  const notJson = storeWorkflow101();
  (notJson.info as Record<string, unknown>).version = Number.POSITIVE_INFINITY;
  assert.deepEqual(codes(readArazzo(notJson).issues), ["arazzo.structure.unsupported-value"]);

  // A source document is never consulted; reading is a pure function of the value.
  const before = JSON.stringify(storeWorkflow101());
  const source = storeWorkflow101();
  readArazzo(source);
  assert.equal(JSON.stringify(source), before, "the input value is not modified");
});

test("AC-IMP-08 cross references, duplicate identifiers and cycles are reported with pointers", () => {
  const cyclic = readArazzo(cyclicSteps110());
  assert.ok(
    find(cyclic.issues, "arazzo.dependency.cycle").length >= 2,
    "each step in the cycle is named",
  );
  assert.deepEqual(
    find(cyclic.issues, "arazzo.dependency.cycle").map((issue) => issue.sourcePointer),
    ["/workflows/0/steps/0", "/workflows/0/steps/1"],
  );
  assert.ok(cyclic.document, "the cyclic document is still preserved");

  const duplicates = storeWorkflow101();
  const workflow = (duplicates.workflows as Record<string, unknown>[])[0]!;
  (workflow.steps as Record<string, unknown>[])[1]!.stepId = "prepare";
  assert.deepEqual(
    find(readArazzo(duplicates).issues, "arazzo.structure.duplicate-id").map(
      (issue) => issue.sourcePointer,
    ),
    ["/workflows/0/steps/1/stepId"],
  );

  const unknownStep = storeWorkflow101();
  (
    (duplicatesWorkflow(unknownStep).steps as Record<string, unknown>[])[1]!
      .parameters as Record<string, unknown>[]
  )[0]!.value = "$steps.missing.outputs.setup";
  assert.deepEqual(
    codes(find(readArazzo(unknownStep).issues, "arazzo.reference.unknown-step")).length,
    1,
  );

  const unknownOutput = storeWorkflow101();
  (
    (duplicatesWorkflow(unknownOutput).steps as Record<string, unknown>[])[1]!
      .parameters as Record<string, unknown>[]
  )[0]!.value = "$steps.prepare.outputs.absent";
  assert.equal(
    find(readArazzo(unknownOutput).issues, "arazzo.reference.unknown-step-output").length,
    1,
  );

  const forward = storeWorkflow101();
  (
    (duplicatesWorkflow(forward).steps as Record<string, unknown>[])[0]!
      .parameters as Record<string, unknown>[]
  )[0]!.value = "$steps.verify.outputs.account";
  assert.equal(
    find(readArazzo(forward).issues, "arazzo.reference.forward-step-output").length,
    1,
  );

  const danglingComponent = full110();
  (
    ((danglingComponent.workflows as Record<string, unknown>[])[0]!
      .steps as Record<string, unknown>[])[0]!.parameters as Record<string, unknown>[]
  )[1] = { reference: "$components.parameters.absent" };
  assert.equal(
    find(readArazzo(danglingComponent).issues, "arazzo.reference.unknown-component").length,
    1,
  );

  const wrongKind = full110();
  (
    ((wrongKind.workflows as Record<string, unknown>[])[0]!
      .steps as Record<string, unknown>[])[0]!.parameters as Record<string, unknown>[]
  )[1] = { reference: "$components.successActions.notify" };
  assert.equal(
    find(readArazzo(wrongKind).issues, "arazzo.reference.component-kind-mismatch").length,
    1,
  );

  const twoSources = readArazzo(ambiguousOperation101());
  assert.deepEqual(
    twoSources.issues.filter((issue) => issue.severity === "blocking"),
    [],
    "ambiguity is a binding question, not a reading one",
  );
});

function duplicatesWorkflow(document: Record<string, unknown>) {
  return (document.workflows as Record<string, unknown>[])[0]!;
}

test("AC-IMP-08 step reference counts, action targets and parameter rules are enforced", () => {
  const both = storeWorkflow101();
  (duplicatesWorkflow(both).steps as Record<string, unknown>[])[0]!.operationPath =
    "{$sourceDescriptions.store.url}#/paths/~1prepare/post";
  assert.equal(
    find(readArazzo(both).issues, "arazzo.step.operation-reference-count").length,
    1,
  );

  const neither = storeWorkflow101();
  delete (duplicatesWorkflow(neither).steps as Record<string, unknown>[])[0]!.operationId;
  assert.equal(
    find(readArazzo(neither).issues, "arazzo.step.operation-reference-count").length,
    1,
  );

  const noLocation = storeWorkflow101();
  delete (
    (duplicatesWorkflow(noLocation).steps as Record<string, unknown>[])[0]!
      .parameters as Record<string, unknown>[]
  )[0]!.in;
  assert.equal(
    find(readArazzo(noLocation).issues, "arazzo.step.parameter-location-missing").length,
    1,
  );

  const duplicateParameter = storeWorkflow101();
  const parameters = (duplicatesWorkflow(duplicateParameter).steps as Record<
    string,
    unknown
  >[])[0]!.parameters as Record<string, unknown>[];
  parameters.push({ ...parameters[0]! });
  assert.equal(
    find(readArazzo(duplicateParameter).issues, "arazzo.structure.duplicate-parameter")
      .length,
    1,
  );

  const badGoto = storeWorkflow101();
  (duplicatesWorkflow(badGoto).steps as Record<string, unknown>[])[0]!.onSuccess = [
    { name: "jump", type: "goto" },
  ];
  assert.equal(find(readArazzo(badGoto).issues, "arazzo.action.target-count").length, 1);

  const endWithTarget = storeWorkflow101();
  (duplicatesWorkflow(endWithTarget).steps as Record<string, unknown>[])[0]!.onSuccess = [
    { name: "stop", type: "end", stepId: "verify" },
  ];
  assert.equal(
    find(readArazzo(endWithTarget).issues, "arazzo.action.target-count").length,
    1,
  );

  const unknownTarget = storeWorkflow101();
  (duplicatesWorkflow(unknownTarget).steps as Record<string, unknown>[])[0]!.onSuccess = [
    { name: "jump", type: "goto", stepId: "absent" },
  ];
  assert.equal(
    find(readArazzo(unknownTarget).issues, "arazzo.reference.unknown-step").length,
    1,
  );
});

test("AC-IMP-13 source URLs with credentials are refused as declared servers and never echoed", () => {
  const credentials = storeWorkflow101();
  (credentials.sourceDescriptions as Record<string, unknown>[])[0]!.url =
    "https://user:s3cret-canary@api.example.com/openapi.json";
  const read = readArazzo(credentials);
  const issue = find(read.issues, "arazzo.source.url-credentials")[0]!;
  assert.equal(issue.severity, "blocking");
  assert.deepEqual(read.definition!.declaredServers, []);
  assert.equal(
    JSON.stringify(read.definition).includes("s3cret-canary"),
    false,
    "a credential in a source URL never reaches the normalized definition",
  );
  assert.equal(JSON.stringify(read.issues).includes("s3cret-canary"), false);
  // The raw description still holds what the author wrote, for review.
  assert.equal(
    read.document!.sourceDescriptions[0]!.url,
    "https://user:s3cret-canary@api.example.com/openapi.json",
  );

  const relative = storeWorkflow101();
  (relative.sourceDescriptions as Record<string, unknown>[])[0]!.url = "./openapi.json";
  const relativeRead = readArazzo(relative);
  assert.equal(find(relativeRead.issues, "arazzo.source.url-relative").length, 1);
  assert.deepEqual(relativeRead.definition!.declaredServers, []);
});

test("AC-IMP-10 a recursive workflow input schema is preserved inertly without expansion", () => {
  const document = storeWorkflow101();
  duplicatesWorkflow(document).inputs = {
    $id: "https://example.com/node",
    type: "object",
    properties: { child: { $ref: "https://example.com/node" } },
  };
  const read = readArazzo(document);
  assert.deepEqual(
    read.issues.filter((issue) => issue.severity === "blocking"),
    [],
  );
  assert.deepEqual(read.document!.workflows[0]!.inputs, {
    $id: "https://example.com/node",
    type: "object",
    properties: { child: { $ref: "https://example.com/node" } },
  });
  assert.equal(read.definition!.capabilities[0]!.inputSchemaRef, "/workflows/0/inputs");
});

test("display text is sanitized while identifiers keep their exact spelling", () => {
  const document = storeWorkflow101();
  (document.info as Record<string, unknown>).title = "Store  ‮connection";
  const read = readArazzo(document);
  assert.equal(read.definition!.display.name, "Store   connection");
  assert.equal(
    read.document!.info.title,
    "Store  ‮connection",
    "the preserved document keeps the exact bytes",
  );
});
