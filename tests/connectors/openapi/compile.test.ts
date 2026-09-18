import assert from "node:assert/strict";
import { test } from "node:test";
import {
  compileOperations,
  isReadResult,
  readOpenApi,
  type CompileResult,
} from "../../../src/server/connectors/formats/openapi/index.js";
import { loopbackDestination, readFixture } from "./helpers.js";

/*
 * HTTP-03 / AC-IMP-05: the executable subset, and precise blocking for
 * everything outside it. The decisive property throughout is locality: one
 * unsupported feature blocks its own operation and leaves every other
 * operation of the same document compilable.
 */

const destination = loopbackDestination("https://example.test", "api");

const compileFixture = async (
  name: string,
  options: Partial<Parameters<typeof compileOperations>[2]> = {},
): Promise<CompileResult & { read: Awaited<ReturnType<typeof readFixture>> }> => {
  const read = await readFixture(name);
  const result = compileOperations(read.definition, read, {
    destinationId: destination.id,
    destination,
    ...options,
  });
  return { ...result, read };
};

const blockedCodes = (result: CompileResult, nativeId: string): string[] => {
  const entry = result.blocked.find((item) => item.nativeId === nativeId);
  assert.ok(entry, `${nativeId} was expected to be blocked but was not`);
  return entry.issues.filter((issue) => issue.severity === "blocking").map((issue) => issue.code);
};

test("an unsupported feature blocks only its own operation", async () => {
  const result = await compileFixture("openapi-3.0-billing.json");
  // Compilable: JSON bodies, form query, simple header and path parameters.
  assert.ok(result.executable.includes("listInvoices"));
  assert.ok(result.executable.includes("createInvoice"));
  assert.ok(result.executable.includes("getInvoice"));
  // Blocked, each for its own precise reason.
  assert.deepEqual(blockedCodes(result, "searchInvoices"), [
    "serialization.unsupported-style",
  ]);
  assert.deepEqual(blockedCodes(result, "readSession"), [
    "serialization.cookie-parameter-unsupported",
  ]);
  assert.deepEqual(blockedCodes(result, "downloadExport"), [
    "serialization.unsupported-response-media-type",
  ]);
  // The rest of the document stays discoverable: every operation is still a
  // capability of the definition, blocked or not.
  for (const id of ["searchInvoices", "readSession", "downloadExport"])
    assert.ok(result.read.definition.capabilities.some((item) => item.nativeId === id));
});

test("non-JSON request and response bodies are blocked with serialization codes", async () => {
  const result = await compileFixture("openapi-3.1-catalog.json");
  assert.deepEqual(blockedCodes(result, "bulkUpload"), [
    "serialization.unsupported-request-media-type",
  ]);
  const inventory = await compileFixture("swagger-2.0-inventory.json");
  assert.deepEqual(blockedCodes(inventory, "uploadPhoto"), [
    "serialization.unsupported-request-media-type",
  ]);
  for (const code of blockedCodes(result, "bulkUpload"))
    assert.ok(code.startsWith("serialization."));
});

test("an unsupported schema keyword blocks only the operation that uses it", async () => {
  const result = await compileFixture("openapi-3.1-catalog.json");
  assert.deepEqual(blockedCodes(result, "mergeProducts"), ["schema.unsupported-keyword"]);
  const entry = result.blocked.find((item) => item.nativeId === "mergeProducts");
  const issue = entry?.issues.find((item) => item.code === "schema.unsupported-keyword");
  assert.ok(issue?.message.includes("allOf"));
  assert.equal(issue?.category, "schema");
  assert.equal(issue?.executionImpact, "blocks-operation");
  // Operations whose schemas are inside the subset still compile.
  assert.ok(result.executable.includes("listProducts"));
  assert.ok(result.executable.includes("createProduct"));
});

test("3.2 constructs outside the subset block precisely", async () => {
  const result = await compileFixture("openapi-3.2-fleet.json");
  assert.deepEqual(blockedCodes(result, "searchRaw"), [
    "serialization.querystring-parameter-unsupported",
  ]);
  // QUERY and PURGE are not HTTP methods a bound operation can carry.
  assert.deepEqual(blockedCodes(result, "queryVehicles"), ["structure.unsupported-method"]);
  assert.deepEqual(blockedCodes(result, "purgeVehicles"), ["structure.unsupported-method"]);
  assert.ok(result.executable.includes("listVehicles"));
  assert.ok(result.executable.includes("updateVehicle"));
});

test("a compiled operation pins destination, method and path template", async () => {
  const result = await compileFixture("openapi-3.1-catalog.json");
  const bound = result.operations.find((item) => item.nativeId === "getProduct");
  assert.ok(bound);
  assert.equal(bound.destinationId, "api");
  assert.equal(bound.transport.kind, "http");
  assert.equal(bound.transport.kind === "http" && bound.transport.method, "GET");
  // The declared server's path becomes the prefix; the destination supplies the origin.
  assert.equal(
    bound.transport.kind === "http" && bound.transport.pathTemplate,
    "/v3/products/{productId}",
  );
});

test("policy defaults: GET is read with read-only replay, everything else is unknown and confirmed", async () => {
  const result = await compileFixture("openapi-3.1-catalog.json");
  const byId = new Map(result.operations.map((item) => [item.nativeId, item]));
  const list = byId.get("listProducts");
  assert.equal(list?.effect, "read");
  assert.equal(list?.replay, "read-only");
  // A GET is still policy-gated: it is not automatically consent-free, and its
  // output is not automatically public.
  assert.equal(list?.consent, "confirm");
  assert.equal(list?.outputClassification, "personal");

  const create = byId.get("createProduct");
  assert.equal(create?.effect, "unknown");
  assert.equal(create?.replay, "none");
  assert.equal(create?.consent, "confirm");
  const remove = byId.get("deleteProduct");
  assert.equal(remove?.effect, "unknown");
  assert.equal(remove?.replay, "none");
});

test("a host review may relax policy, and an inconsistent review is refused", async () => {
  const relaxed = await compileFixture("openapi-3.1-catalog.json", {
    review: {
      listProducts: { consent: "none", outputClassification: "public", cost: "free" },
    },
  });
  const list = relaxed.operations.find((item) => item.nativeId === "listProducts");
  assert.equal(list?.consent, "none");
  assert.equal(list?.outputClassification, "public");
  assert.equal(list?.cost, "free");

  // Claiming read-only replay for a write is refused by the binding contract.
  const bad = await compileFixture("openapi-3.1-catalog.json", {
    review: { createProduct: { replay: "read-only" } },
  });
  assert.deepEqual(blockedCodes(bad, "createProduct"), ["policy.invalid-review"]);

  // A review may declare a non-GET operation read-only, and it is recorded as
  // the host's decision rather than a fact the description established.
  const reviewed = await compileFixture("openapi-3.1-catalog.json", {
    review: { createProduct: { effect: "read", replay: "read-only" } },
  });
  const created = reviewed.operations.find((item) => item.nativeId === "createProduct");
  assert.equal(created?.effect, "read");
  assert.ok(reviewed.issues.some((issue) => issue.code === "policy.effect-overridden"));
});

test("a target parameter the operation does not declare is refused", async () => {
  const result = await compileFixture("openapi-3.1-catalog.json", {
    review: { getProduct: { targetParameters: ["tenantId"] } },
  });
  assert.deepEqual(blockedCodes(result, "getProduct"), ["policy.target-parameter-unknown"]);

  const good = await compileFixture("openapi-3.1-catalog.json", {
    review: { getProduct: { targetParameters: ["productId"] } },
  });
  assert.deepEqual(
    good.operations.find((item) => item.nativeId === "getProduct")?.targetParameters,
    ["productId"],
  );
});

test("an operation whose alternatives are all unexecutable is blocked, not silently anonymous", async () => {
  const read = await readOpenApi({
    openapi: "3.1.0",
    info: { title: "Locked", version: "1" },
    servers: [{ url: "https://locked.example.test" }],
    components: { securitySchemes: { mtls: { type: "mutualTLS" } } },
    security: [{ mtls: [] }],
    paths: { "/a": { get: { operationId: "a", responses: { "200": { description: "ok" } } } } },
  });
  assert.ok(isReadResult(read));
  const result = compileOperations(read.definition, read, {
    destinationId: destination.id,
    destination,
  });
  assert.deepEqual(blockedCodes(result, "a"), ["security.unsupported-requirement"]);
  assert.deepEqual(result.operations, []);
});

test("an operation compiles anonymously only when the source says an alternative is anonymous", async () => {
  const result = await compileFixture("openapi-3.1-catalog.json");
  const health = result.plans[
    result.operations.find((item) => item.nativeId === "health")!.operationRef
  ];
  assert.deepEqual(health?.security.profiles, []);
  // A secured operation carries its conjunction, in full.
  const list = result.plans[
    result.operations.find((item) => item.nativeId === "listProducts")!.operationRef
  ];
  assert.deepEqual(
    list?.security.profiles.map((entry) => entry.scheme).sort(),
    ["apiKey", "tenantHeader"],
  );
});

test("binding only some profiles selects an alternative those profiles satisfy", async () => {
  // With only the OAuth profile bound, the AND alternative cannot be chosen.
  const result = await compileFixture("openapi-3.1-catalog.json", { profiles: ["oauth"] });
  const list = result.plans[
    result.operations.find((item) => item.nativeId === "listProducts")!.operationRef
  ];
  assert.deepEqual(list?.security.profiles.map((entry) => entry.scheme), ["oauth"]);
  assert.deepEqual(list?.security.profiles[0]?.scopes, ["catalog:read"]);

  // With no profile bound at all, secured operations are blocked and the
  // anonymous one still compiles.
  const none = await compileFixture("openapi-3.1-catalog.json", { profiles: [] });
  assert.deepEqual(blockedCodes(none, "listProducts"), ["security.profile-not-bound"]);
  assert.ok(none.executable.includes("health"));
});

test("a path template and its parameters must agree", async () => {
  const read = await readOpenApi({
    openapi: "3.1.0",
    info: { title: "Mismatch", version: "1" },
    servers: [{ url: "https://mismatch.example.test" }],
    paths: {
      "/a/{missing}": { get: { operationId: "missing", responses: { "200": { description: "ok" } } } },
      "/b": {
        get: {
          operationId: "unused",
          parameters: [{ name: "extra", in: "path", required: true, schema: { type: "string" } }],
          responses: { "200": { description: "ok" } },
        },
      },
    },
  });
  assert.ok(isReadResult(read));
  const result = compileOperations(read.definition, read, {
    destinationId: destination.id,
    destination,
  });
  assert.deepEqual(blockedCodes(result, "missing"), ["structure.path-parameter-missing"]);
  assert.deepEqual(blockedCodes(result, "unused"), ["structure.path-parameter-unused"]);
});

test("a header parameter that is reserved, hop-by-hop or Authorization is refused", async () => {
  const read = await readOpenApi({
    openapi: "3.1.0",
    info: { title: "Headers", version: "1" },
    servers: [{ url: "https://headers.example.test" }],
    paths: {
      "/auth": {
        get: {
          operationId: "authHeader",
          parameters: [{ name: "Authorization", in: "header", schema: { type: "string" } }],
          responses: { "200": { description: "ok" } },
        },
      },
      "/hop": {
        get: {
          operationId: "hopHeader",
          parameters: [{ name: "Connection", in: "header", schema: { type: "string" } }],
          responses: { "200": { description: "ok" } },
        },
      },
      "/ignored": {
        get: {
          operationId: "ignoredHeader",
          parameters: [{ name: "Accept", in: "header", schema: { type: "string" } }],
          responses: { "200": { description: "ok" } },
        },
      },
    },
  });
  assert.ok(isReadResult(read));
  const result = compileOperations(read.definition, read, {
    destinationId: destination.id,
    destination,
  });
  assert.deepEqual(blockedCodes(result, "authHeader"), ["security.header-parameter-reserved"]);
  assert.deepEqual(blockedCodes(result, "hopHeader"), ["serialization.reserved-header-parameter"]);
  // Accept is ignored by the specification, not an error; the operation compiles.
  assert.ok(result.executable.includes("ignoredHeader"));
  const ignored = result.plans[
    result.operations.find((item) => item.nativeId === "ignoredHeader")!.operationRef
  ];
  assert.deepEqual(ignored?.parameters, []);
});

test("object-valued parameters are refused; arrays of primitives are kept", async () => {
  const read = await readOpenApi({
    openapi: "3.1.0",
    info: { title: "Shapes", version: "1" },
    servers: [{ url: "https://shapes.example.test" }],
    paths: {
      "/object": {
        get: {
          operationId: "objectParameter",
          parameters: [
            { name: "where", in: "query", schema: { type: "object", properties: { a: { type: "string" } } } },
          ],
          responses: { "200": { description: "ok" } },
        },
      },
      "/array": {
        get: {
          operationId: "arrayParameter",
          parameters: [
            { name: "ids", in: "query", schema: { type: "array", items: { type: "string" } } },
          ],
          responses: { "200": { description: "ok" } },
        },
      },
    },
  });
  assert.ok(isReadResult(read));
  const result = compileOperations(read.definition, read, {
    destinationId: destination.id,
    destination,
  });
  assert.deepEqual(blockedCodes(result, "objectParameter"), [
    "serialization.complex-parameter-unsupported",
  ]);
  assert.ok(result.executable.includes("arrayParameter"));
});

test("recursive schemas compile into a definitions table without expanding forever", async () => {
  const result = await compileFixture("openapi-3.1-recursive.json");
  assert.deepEqual(result.executable.sort(), ["getTree", "putPerson", "putTree"]);
  const plan = result.plans[
    result.operations.find((item) => item.nativeId === "putTree")!.operationRef
  ];
  assert.ok(plan);
  assert.equal(plan.requestBody?.schema.kind, "ref");
  // The self-reference is a named entry, not an inlined infinite tree.
  const node = plan.definitions[
    plan.requestBody?.schema.kind === "ref" ? plan.requestBody.schema.name : ""
  ];
  assert.equal(node?.kind, "node");
  const children = node?.kind === "node" ? node.properties?.children : undefined;
  assert.equal(children?.kind === "node" ? children.items?.kind : undefined, "ref");
});

test("settings carry a plan per bound operation and nothing else executable", async () => {
  const result = await compileFixture("openapi-3.1-catalog.json");
  const settings = result.settings["openapi-http"] as {
    version: number;
    plans: Record<string, unknown>;
  };
  assert.equal(settings.version, 1);
  assert.deepEqual(
    Object.keys(settings.plans).sort(),
    result.operations.map((item) => item.operationRef).sort(),
  );
});

test("a verifier must be an approved read operation", async () => {
  const bad = await compileFixture("openapi-3.1-catalog.json", {
    verifier: { nativeId: "createProduct" },
  });
  assert.ok(bad.issues.some((issue) => issue.code === "policy.verifier-not-read"));
  assert.equal((bad.settings["openapi-http"] as { verifier?: unknown }).verifier, undefined);

  const good = await compileFixture("openapi-3.1-catalog.json", {
    verifier: { nativeId: "health" },
  });
  const verifier = (good.settings["openapi-http"] as { verifier?: { operationRef: string } })
    .verifier;
  assert.ok(verifier);
  assert.equal(
    good.operations.find((item) => item.operationRef === verifier.operationRef)?.nativeId,
    "health",
  );
});

test("operation refs are deterministic and unique across a document", async () => {
  const first = await compileFixture("openapi-3.1-catalog.json");
  const second = await compileFixture("openapi-3.1-catalog.json");
  assert.deepEqual(
    first.operations.map((item) => item.operationRef),
    second.operations.map((item) => item.operationRef),
  );
  assert.equal(
    new Set(first.operations.map((item) => item.operationRef)).size,
    first.operations.length,
  );
});

test("a declared server that differs from the approved destination warns but does not block", async () => {
  const result = await compileFixture("openapi-3.1-catalog.json");
  const warning = result.issues.find(
    (issue) => issue.code === "network.destination-differs-from-declared",
  );
  assert.ok(warning);
  assert.equal(warning.severity, "warning");
  assert.equal(warning.executionImpact, "none");
  // Requests still go only to the approved destination.
  assert.ok(result.operations.every((item) => item.destinationId === "api"));
});

test("a server variable without a default or an approved value blocks the operation", async () => {
  const read = await readOpenApi({
    openapi: "3.1.0",
    info: { title: "Variable", version: "1" },
    servers: [{ url: "https://v.example.test/{tenant}", variables: { tenant: { default: "" } } }],
    paths: { "/a": { get: { operationId: "a", responses: { "200": { description: "ok" } } } } },
  });
  assert.ok(isReadResult(read));
  const blocked = compileOperations(read.definition, read, {
    destinationId: destination.id,
    destination,
  });
  assert.deepEqual(blockedCodes(blocked, "a"), ["network.server-variable-unresolved"]);

  // A reviewed value resolves it; the value comes from the host, not the document.
  const resolved = compileOperations(read.definition, read, {
    destinationId: destination.id,
    destination,
    server: { variables: { tenant: "acme" } },
  });
  assert.equal(
    resolved.operations[0]?.transport.kind === "http" &&
      resolved.operations[0].transport.pathTemplate,
    "/acme/a",
  );
});
