import assert from "node:assert/strict";
import { test } from "node:test";
import { validateRecipe } from "../../../src/server/recipes/index.js";
import {
  compileArazzoToRecipe,
  readArazzo,
  type ArazzoCompilation,
} from "../../../src/server/connectors/formats/arazzo/index.js";
import {
  ambiguousCatalog,
  storeActor,
  storeCatalog,
  storeRegistry,
} from "../fixtures/arazzo/host.ts";
import {
  ambiguousOperation101,
  cyclicSteps110,
  privateOutput101,
  storeWorkflow101,
  unsupportedFeatures101,
} from "../fixtures/arazzo/documents.ts";

/*
 * WF-02: the executable profile. A workflow becomes a recipe only when every
 * step resolves to an exact host-registered document identity and operation
 * version, and every construct is inside the supported subset. Anything else
 * is a blocked report over a preserved document.
 */

const registryOf = () => storeRegistry({ origin: "http://127.0.0.1:1" }).registry;
const noChildren = async () => {
  throw new Error("Unexpected child recipe");
};
const codes = (compilation: ArazzoCompilation) =>
  compilation.issues.map((issue) => issue.code);
const blocking = (compilation: ArazzoCompilation) =>
  compilation.issues.filter((issue) => issue.severity === "blocking");

function compile(
  document: unknown,
  options: {
    workflowId?: string;
    catalog?: Parameters<typeof compileArazzoToRecipe>[1];
    tenantId?: string;
  } = {},
) {
  const read = readArazzo(document);
  return compileArazzoToRecipe(
    read,
    options.catalog ?? storeCatalog(storeActor.tenantId),
    {
      workflowId: options.workflowId ?? "connect-store",
      registry: registryOf(),
      tenantId: options.tenantId ?? storeActor.tenantId,
    },
  );
}

test("a supported workflow compiles to a recipe the existing validator accepts", async () => {
  const compilation = compile(storeWorkflow101());
  assert.deepEqual(blocking(compilation), [], JSON.stringify(codes(compilation)));
  assert.equal(compilation.status, "executable");
  const recipe = compilation.recipe!;
  assert.equal(recipe.id, "connect-store");
  assert.equal(recipe.title, "Connect the store account");
  assert.deepEqual(recipe.inputs, {
    region: { contract: "region", required: true },
  });
  assert.deepEqual(
    recipe.invocations.map((node) => [node.id, node.use, node.dependsOn]),
    [
      ["prepare", { kind: "operation", id: "store.prepare", version: "1.0.0" }, []],
      ["verify", { kind: "operation", id: "store.verify", version: "1.0.0" }, ["prepare"]],
    ],
  );
  assert.deepEqual(recipe.invocations[0]!.bindings, {
    region: { from: "input", name: "region" },
  });
  assert.deepEqual(recipe.invocations[1]!.bindings, {
    setup: { from: "output", node: "prepare", name: "setup" },
  });
  assert.deepEqual(recipe.outputs, { account: { node: "verify", name: "account" } });
  // The compiled step keeps the exact identity the host reviewed.
  const [prepare, verify] = compilation.steps;
  assert.deepEqual(prepare!.binding, {
    sourceDescriptionName: "store",
    documentIdentity: { kind: "url", url: "https://api.example.com/openapi.json" },
    declaredUrl: "https://api.example.com/openapi.json",
    version: "2026-01-04",
    reference: { operationId: "prepareConnection" },
    operation: { id: "store.prepare", version: "1.0.0" },
  });
  assert.deepEqual(prepare!.outputs, {
    setup: { name: "setup", classification: "artifact" },
  });
  assert.deepEqual(verify!.retry, {
    limit: 2,
    afterMs: 1000,
    replay: "read-only",
    criteria: [],
  });
  assert.deepEqual(
    verify!.successCriteria.map((criterion) => criterion.condition.source),
    ["$statusCode == 200 && $response.header.X-Verified == 'true'"],
  );
  assert.deepEqual(compilation.outputs, {
    account: { node: "verify", name: "account", classification: "public" },
  });
  const validated = await validateRecipe(recipe, registryOf(), noChildren);
  assert.deepEqual(validated.diagnostics, []);
  assert.deepEqual(
    validated.leaves.map((leaf) => leaf.id),
    ["prepare", "verify"],
  );
});

test("AC-IMP-07 two documents with the same operation ID require exact document identity", async () => {
  const ambiguous = compile(ambiguousOperation101(), {
    workflowId: "place-order",
    catalog: ambiguousCatalog(storeActor.tenantId),
  });
  assert.equal(ambiguous.status, "blocked");
  assert.equal(ambiguous.recipe, undefined);
  const issue = ambiguous.issues.find(
    (item) => item.code === "arazzo.identity.ambiguous-operation",
  )!;
  assert.equal(issue.severity, "blocking");
  assert.equal(issue.category, "identity");
  assert.equal(issue.sourcePointer, "/workflows/0/steps/0/operationId");
  assert.equal(issue.executionImpact, "blocks-operation");
  assert.match(issue.remediation!, /sourceDescriptions/);

  // Naming the source description resolves it to exactly one document.
  const disambiguated = ambiguousOperation101();
  const step = (
    ((disambiguated.workflows as Record<string, unknown>[])[0]!.steps as Record<
      string,
      unknown
    >[])[0]!
  );
  step.operationId = "$sourceDescriptions.secondary.createOrder";
  const resolved = compile(disambiguated, {
    workflowId: "place-order",
    catalog: ambiguousCatalog(storeActor.tenantId),
  });
  assert.deepEqual(blocking(resolved), [], JSON.stringify(codes(resolved)));
  assert.equal(resolved.steps[0]!.binding!.sourceDescriptionName, "secondary");
  assert.deepEqual(resolved.steps[0]!.binding!.documentIdentity, {
    kind: "url",
    url: "https://secondary.example.com/openapi.json",
  });
  assert.deepEqual(
    (await validateRecipe(resolved.recipe!, registryOf(), noChildren)).diagnostics,
    [],
  );

  // An operationPath names its source description too, and pins the pointer.
  const byPath = ambiguousOperation101();
  const pathStep = (
    ((byPath.workflows as Record<string, unknown>[])[0]!.steps as Record<
      string,
      unknown
    >[])[0]!
  );
  delete pathStep.operationId;
  pathStep.operationPath = "{$sourceDescriptions.primary.url}#/paths/~1orders/post";
  const pathCatalog = ambiguousCatalog(storeActor.tenantId);
  pathCatalog.documents[0]!.operations = [
    {
      operationPath: "#/paths/~1orders/post",
      operation: { id: "store.prepare", version: "1.0.0" },
      parameters: { "query:region": "region" },
      outputs: { "$response.body#/order": "setup" },
      replay: "read-only",
    },
  ];
  const pathCompiled = compile(byPath, {
    workflowId: "place-order",
    catalog: pathCatalog,
  });
  assert.deepEqual(blocking(pathCompiled), [], JSON.stringify(codes(pathCompiled)));
  assert.deepEqual(pathCompiled.steps[0]!.binding!.reference, {
    operationPath: "#/paths/~1orders/post",
  });
});

test("AC-IMP-07 a malicious operation reference cannot bypass host registration", () => {
  const unregistered = storeWorkflow101();
  const workflow = (unregistered.workflows as Record<string, unknown>[])[0]!;
  (workflow.steps as Record<string, unknown>[])[0]!.operationId = "deleteEverything";
  const missing = compile(unregistered);
  assert.equal(missing.status, "blocked");
  assert.equal(missing.recipe, undefined);
  assert.ok(codes(missing).includes("arazzo.binding.unbound-operation"));

  // A catalog entry may only name an operation the registry actually holds.
  const phantom = storeCatalog(storeActor.tenantId);
  phantom.documents[0]!.operations[0]!.operation = {
    id: "store.absent",
    version: "9.9.9",
  };
  const unregisteredOperation = compile(storeWorkflow101(), { catalog: phantom });
  assert.ok(
    codes(unregisteredOperation).includes("arazzo.binding.unregistered-operation"),
  );
  assert.equal(unregisteredOperation.recipe, undefined);

  // An absolute or foreign operationPath is never followed.
  for (const operationPath of [
    "https://evil.example/openapi.json#/paths/~1x/get",
    "{$sourceDescriptions.store.url}",
    "{$sourceDescriptions.unknown.url}#/paths/~1x/get",
    "#/paths/~1x/get",
  ]) {
    const document = storeWorkflow101();
    const step = (
      (document.workflows as Record<string, unknown>[])[0]!.steps as Record<
        string,
        unknown
      >[]
    )[0]!;
    delete step.operationId;
    step.operationPath = operationPath;
    const compiled = compile(document);
    assert.equal(compiled.recipe, undefined, operationPath);
    assert.ok(
      blocking(compiled).length > 0 &&
        codes(compiled).some((code) =>
          [
            "arazzo.identity.operation-path-not-source-relative",
            "arazzo.reference.unknown-source-description",
            "arazzo.binding.unbound-operation",
            "arazzo.expression.invalid",
          ].includes(code),
        ),
      operationPath,
    );
  }

  // Another tenant's catalog cannot be used at all.
  const foreign = compile(storeWorkflow101(), {
    catalog: storeCatalog("tenant-other"),
  });
  assert.equal(foreign.status, "blocked");
  assert.deepEqual(codes(foreign), ["arazzo.binding.catalog-tenant-mismatch"]);
  assert.equal(foreign.recipe, undefined);

  // A document whose declared URL no longer matches the reviewed identity.
  const moved = storeWorkflow101();
  (moved.sourceDescriptions as Record<string, unknown>[])[0]!.url =
    "https://attacker.example/openapi.json";
  const mismatch = compile(moved);
  assert.ok(codes(mismatch).includes("arazzo.identity.source-mismatch"));
  assert.equal(mismatch.recipe, undefined);
});

test("AC-IMP-08 unsupported criteria and control flow block execution over a preserved document", () => {
  const read = readArazzo(unsupportedFeatures101());
  assert.deepEqual(
    read.issues.filter((issue) => issue.severity === "blocking"),
    [],
    "the description itself is valid Arazzo",
  );
  assert.equal(read.document!.workflows[0]!.steps.length, 2);
  const compilation = compileArazzoToRecipe(read, storeCatalog(storeActor.tenantId), {
    workflowId: "unsupported",
    registry: registryOf(),
    tenantId: storeActor.tenantId,
  });
  assert.equal(compilation.status, "blocked");
  assert.equal(compilation.recipe, undefined, "no truncated runnable workflow");
  const reported = codes(compilation);
  assert.ok(reported.includes("arazzo.criteria.type-unsupported"));
  assert.ok(reported.includes("arazzo.criteria.context-unsupported"));
  assert.ok(reported.includes("arazzo.criteria.response-body-unsupported"));
  assert.ok(reported.includes("arazzo.control.goto-cycle"));
  for (const issue of blocking(compilation))
    assert.match(issue.sourcePointer, /^\/workflows\/0\//);
  // The preserved criteria are still readable for review.
  assert.equal(
    read.document!.workflows[0]!.steps[0]!.successCriteria![0]!.condition,
    "$[?count(@.pets) > 0]",
  );
});

test("AC-IMP-08 a cyclic dependsOn graph is blocked and never partially ordered", () => {
  const compilation = compile(cyclicSteps110(), { workflowId: "cyclic" });
  assert.equal(compilation.status, "blocked");
  assert.equal(compilation.recipe, undefined);
  assert.ok(codes(compilation).includes("arazzo.dependency.cycle"));
  assert.deepEqual(compilation.steps, [], "no step from a cyclic graph is compiled");
});

test("AC-IMP-08 a private-derived workflow output is blocked, not published", () => {
  const compilation = compile(privateOutput101());
  assert.equal(compilation.status, "blocked");
  assert.equal(compilation.recipe, undefined);
  const issue = compilation.issues.find(
    (item) => item.code === "arazzo.policy.private-output",
  )!;
  assert.equal(issue.category, "policy");
  assert.equal(issue.severity, "blocking");
  assert.equal(issue.sourcePointer, "/workflows/0/outputs/token");
  assert.equal(compilation.outputs.token!.classification, "secret");
  // The public output is still classified correctly beside it.
  assert.equal(compilation.outputs.account!.classification, "public");

  // A personal-classified output is refused for the same reason.
  const personal = privateOutput101();
  const workflow = (personal.workflows as Record<string, unknown>[])[0]!;
  (workflow.steps as Record<string, unknown>[])[1]!.outputs = {
    account: "$response.body#/account",
    owner: "$response.body#/owner",
  };
  workflow.outputs = { owner: "$steps.verify.outputs.owner" };
  const compiledPersonal = compile(personal);
  assert.ok(
    codes(compiledPersonal).includes("arazzo.policy.private-output"),
    JSON.stringify(codes(compiledPersonal)),
  );
});

test("literals may only bind public registered contracts and must satisfy them", () => {
  const literal = storeWorkflow101();
  const step = (
    (literal.workflows as Record<string, unknown>[])[0]!.steps as Record<
      string,
      unknown
    >[]
  )[0]!;
  (step.parameters as Record<string, unknown>[])[0]!.value = "eu";
  const good = compile(literal);
  assert.deepEqual(blocking(good), [], JSON.stringify(codes(good)));
  assert.deepEqual(good.recipe!.invocations[0]!.bindings, {
    region: { from: "literal", value: "eu" },
  });
  assert.deepEqual(good.recipe!.inputs, {}, "a literal needs no workflow input");

  (step.parameters as Record<string, unknown>[])[0]!.value = "antarctica";
  assert.ok(codes(compile(literal)).includes("arazzo.binding.literal-rejected"));

  // A non-public contract cannot take a literal at all.
  const secret = storeWorkflow101();
  const verify = (
    (secret.workflows as Record<string, unknown>[])[0]!.steps as Record<
      string,
      unknown
    >[]
  )[1]!;
  (verify.parameters as Record<string, unknown>[])[0]!.value = "setup-token";
  assert.ok(codes(compile(secret)).includes("arazzo.policy.private-literal"));

  // Structured literals are outside the profile.
  (verify.parameters as Record<string, unknown>[])[0]!.value = { nested: true };
  assert.ok(codes(compile(secret)).includes("arazzo.binding.unsupported-literal"));
});

test("a retry is allowed only when the bound operation has replay evidence", () => {
  const catalog = storeCatalog(storeActor.tenantId);
  catalog.documents[0]!.operations[1]!.replay = "none";
  const compilation = compile(storeWorkflow101(), { catalog });
  assert.equal(compilation.status, "blocked");
  const issue = compilation.issues.find(
    (item) => item.code === "arazzo.policy.retry-not-replay-safe",
  )!;
  assert.equal(issue.severity, "blocking");
  assert.equal(issue.sourcePointer, "/workflows/0/steps/1/onFailure/0");

  for (const replay of [
    "upstream-idempotency-key",
    "reconciliation",
    "read-only",
  ] as const) {
    const allowed = storeCatalog(storeActor.tenantId);
    allowed.documents[0]!.operations[1]!.replay = replay;
    const compiled = compile(storeWorkflow101(), { catalog: allowed });
    assert.deepEqual(blocking(compiled), [], replay);
    assert.equal(compiled.steps[1]!.retry!.replay, replay);
  }

  // The retry limit itself stays bounded.
  const unbounded = storeWorkflow101();
  const verify = (
    (unbounded.workflows as Record<string, unknown>[])[0]!.steps as Record<
      string,
      unknown
    >[]
  )[1]!;
  (verify.onFailure as Record<string, unknown>[])[0]!.retryLimit = 500;
  assert.ok(codes(compile(unbounded)).includes("arazzo.policy.retry-limit-exceeded"));
});

test("unmapped parameters and outputs block rather than guess a registered name", () => {
  const document = storeWorkflow101();
  const step = (
    (document.workflows as Record<string, unknown>[])[0]!.steps as Record<
      string,
      unknown
    >[]
  )[0]!;
  (step.parameters as Record<string, unknown>[])[0]!.name = "locale";
  const unknownParameter = compile(document);
  assert.ok(codes(unknownParameter).includes("arazzo.binding.unknown-parameter"));
  assert.ok(codes(unknownParameter).includes("arazzo.binding.missing-required-input"));

  const unmappedOutput = storeWorkflow101();
  (
    (unmappedOutput.workflows as Record<string, unknown>[])[0]!.steps as Record<
      string,
      unknown
    >[]
  )[0]!.outputs = { setup: "$response.body#/different" };
  assert.ok(codes(compile(unmappedOutput)).includes("arazzo.binding.unmapped-output"));
});

test("compiling names a workflow that exists and reports issues only in its own scope", () => {
  const two = storeWorkflow101();
  const workflows = two.workflows as Record<string, unknown>[];
  const broken = structuredClone(workflows[0]!);
  broken.workflowId = "broken";
  (broken.steps as Record<string, unknown>[])[0]!.operationId = "absentOperation";
  workflows.push(broken);
  const compilation = compile(two);
  assert.deepEqual(
    blocking(compilation),
    [],
    "a sibling workflow's binding gap does not block this one",
  );
  assert.equal(compilation.status, "executable");
  const other = compile(two, { workflowId: "broken" });
  assert.equal(other.status, "blocked");
  assert.ok(codes(other).includes("arazzo.binding.unbound-operation"));

  const absent = compile(storeWorkflow101(), { workflowId: "nope" });
  assert.equal(absent.status, "blocked");
  assert.ok(codes(absent).includes("arazzo.reference.unknown-workflow"));
});
