import assert from "node:assert/strict";
import { test } from "node:test";
import {
  detectOpenApiVersion,
  isReadResult,
  readOpenApi,
  readOpenApi30,
  readOpenApi31,
  readOpenApi32,
  readSwagger2,
  securityRequirementsFor,
} from "../../../src/server/connectors/formats/openapi/index.js";
import { allStrings, fixture, readFixture } from "./helpers.js";

/*
 * HTTP-01: version-dispatched readers. Each reader is checked against its own
 * document for the constructs that version actually defines, and against
 * another version's document to prove the dispatch is on the declared version
 * and not on the shape of what happens to be present.
 */

const operation = (
  read: Awaited<ReturnType<typeof readFixture>>,
  id: string,
) => {
  const found = read.operations.find((item) => item.nativeId === id);
  assert.ok(found, `operation ${id} was not read`);
  return found;
};

test("the version field alone selects the reader", async () => {
  assert.deepEqual(
    detectOpenApiVersion(fixture("swagger-2.0-inventory.json")),
    {
      profile: "swagger-2.0",
      version: "2.0",
    },
  );
  assert.deepEqual(detectOpenApiVersion(fixture("openapi-3.0-billing.json")), {
    profile: "openapi-3.0",
    version: "3.0.3",
  });
  assert.deepEqual(detectOpenApiVersion(fixture("openapi-3.1-catalog.json")), {
    profile: "openapi-3.1",
    version: "3.1.0",
  });
  assert.deepEqual(detectOpenApiVersion(fixture("openapi-3.2-fleet.json")), {
    profile: "openapi-3.2",
    version: "3.2.0",
  });
});

test("a missing, unknown or ambiguous version is refused rather than guessed", async () => {
  const shapedLike31 = {
    info: { title: "No version", version: "1" },
    paths: {
      "/a": {
        get: { operationId: "a", responses: { "200": { description: "ok" } } },
      },
    },
    components: { securitySchemes: {} },
  };
  const missing = await readOpenApi(shapedLike31);
  assert.equal(missing.profile, undefined);
  assert.equal(missing.definition, undefined);
  assert.equal(missing.issues[0]?.code, "version.missing");
  assert.equal(missing.issues[0]?.severity, "blocking");
  assert.equal(missing.issues[0]?.executionImpact, "blocks-definition");

  const future = await readOpenApi({ ...shapedLike31, openapi: "4.0.0" });
  assert.equal(future.profile, undefined);
  assert.equal(future.issues[0]?.code, "version.unsupported");

  const old = await readOpenApi({ ...shapedLike31, swagger: "1.2" });
  assert.equal(old.profile, undefined);
  assert.equal(old.issues[0]?.code, "version.unsupported");

  const both = await readOpenApi({
    ...shapedLike31,
    swagger: "2.0",
    openapi: "3.1.0",
  });
  assert.equal(both.profile, undefined);
  assert.equal(both.issues[0]?.code, "version.ambiguous");

  // A version-shaped string that is not a version is not coerced.
  for (const value of ["3.1", "v3.1.0", "", 3.1, null])
    assert.equal(
      (await readOpenApi({ ...shapedLike31, openapi: value })).profile,
      undefined,
    );
});

test("an explicit reader refuses a document of another version", async () => {
  const mismatch = readOpenApi31(fixture("openapi-3.0-billing.json"));
  assert.equal(mismatch.profile, undefined);
  assert.equal(
    (mismatch as { issues: Array<{ code: string }> }).issues[0]?.code,
    "version.reader-mismatch",
  );
  assert.ok(isReadResult(readOpenApi30(fixture("openapi-3.0-billing.json"))));
  assert.ok(isReadResult(readSwagger2(fixture("swagger-2.0-inventory.json"))));
  assert.ok(isReadResult(readOpenApi32(fixture("openapi-3.2-fleet.json"))));
});

test("Swagger 2.0: host, basePath and schemes become declared servers", async () => {
  const read = await readFixture("swagger-2.0-inventory.json");
  assert.equal(read.profile, "swagger-2.0");
  assert.equal(read.version, "2.0");
  assert.deepEqual(
    read.servers.map((server) => server.url),
    ["https://inventory.example.test/v1"],
  );
  assert.deepEqual(
    read.definition.declaredServers.map((server) => server.url),
    ["https://inventory.example.test/v1"],
  );
  assert.ok(read.dialect.includes("swagger-2.0"));
});

test("Swagger 2.0: body, formData and collectionFormat are translated exactly", async () => {
  const read = await readFixture("swagger-2.0-inventory.json");
  const create = operation(read, "createItem");
  assert.equal(create.requestBody?.required, true);
  assert.deepEqual(
    create.requestBody?.content.map((item) => item.mediaType),
    ["application/json"],
  );
  const list = operation(read, "listItems");
  const tags = list.parameters.find((parameter) => parameter.name === "tags");
  // collectionFormat multi is form/explode=true; csv is form/explode=false.
  assert.equal(tags?.collectionFormat, "multi");
  assert.equal(tags?.style, "form");
  assert.equal(tags?.explode, true);

  const upload = operation(read, "uploadPhoto");
  assert.deepEqual(
    upload.requestBody?.content.map((item) => item.mediaType),
    ["multipart/form-data"],
  );
  // A path-item parameter is inherited by the operation.
  assert.ok(
    upload.parameters.some(
      (parameter) => parameter.name === "itemId" && parameter.in === "path",
    ),
  );
});

test("OpenAPI 3.0: requestBody, styles and server variables are preserved", async () => {
  const read = await readFixture("openapi-3.0-billing.json");
  assert.equal(read.profile, "openapi-3.0");
  assert.deepEqual(
    read.servers.map((server) => server.url),
    ["https://billing.example.test/api/{stage}"],
  );
  assert.deepEqual(read.servers[0]?.variables.stage, {
    default: "v2",
    enum: ["v2", "beta"],
  });
  const list = operation(read, "listInvoices");
  const ids = list.parameters.find((parameter) => parameter.name === "ids");
  assert.equal(ids?.style, "form");
  assert.equal(ids?.explode, false);
  // An explicit style survives; a defaulted style is filled per location.
  const status = list.parameters.find(
    (parameter) => parameter.name === "status",
  );
  assert.equal(status?.style, "form");
  assert.equal(status?.explode, true);
  const trace = list.parameters.find(
    (parameter) => parameter.name === "X-Request-Trace",
  );
  assert.equal(trace?.style, "simple");

  const search = operation(read, "searchInvoices");
  assert.equal(
    search.parameters.find((parameter) => parameter.name === "filter")?.style,
    "deepObject",
  );
  const session = operation(read, "readSession");
  assert.equal(
    session.parameters.find((parameter) => parameter.name === "session")?.in,
    "cookie",
  );
});

test("OpenAPI 3.0: callbacks become event descriptors without becoming executable", async () => {
  const read = await readFixture("openapi-3.0-billing.json");
  const create = operation(read, "createInvoice");
  assert.deepEqual(create.callbacks, ["invoicePaid"]);
  const event = read.definition.events.find(
    (item) => item.label === "invoicePaid",
  );
  assert.ok(event);
  assert.equal(event.transport, "http-webhook");
  assert.equal(event.verification, "unknown");
  // A callback is not an operation.
  assert.ok(
    !read.definition.capabilities.some(
      (item) => item.nativeId === "invoicePaidCallback",
    ),
  );
});

test("OpenAPI 3.1: webhooks, dialect and type arrays are read", async () => {
  const read = await readFixture("openapi-3.1-catalog.json");
  assert.equal(read.profile, "openapi-3.1");
  assert.equal(read.dialect, "https://spec.openapis.org/oas/3.1/dialect/base");
  assert.equal(read.webhooks.length, 1);
  assert.equal(read.webhooks[0]?.source, "webhooks");
  assert.ok(
    read.definition.events.some((event) => event.transport === "http-webhook"),
  );
  // Webhooks are events, never invocable capabilities.
  assert.ok(
    !read.definition.capabilities.some(
      (item) => item.nativeId === "productChangedWebhook",
    ),
  );
});

test("OpenAPI 3.1: the document dialect defaults when jsonSchemaDialect is absent", async () => {
  const read = await readFixture("openapi-3.1-recursive.json");
  assert.equal(read.dialect, "https://spec.openapis.org/oas/3.1/dialect/base");
});

test("OpenAPI 3.2: QUERY, additionalOperations and querystring are read", async () => {
  const read = await readFixture("openapi-3.2-fleet.json");
  assert.equal(read.profile, "openapi-3.2");
  assert.equal(operation(read, "queryVehicles").method, "QUERY");
  assert.equal(operation(read, "purgeVehicles").method, "PURGE");
  assert.equal(
    operation(read, "searchRaw").parameters.find(
      (parameter) => parameter.name === "rawQuery",
    )?.in,
    "querystring",
  );
  // A 3.2-only path-item key is not read by the 3.1 reader.
  const as31 = readOpenApi31({
    ...(fixture("openapi-3.2-fleet.json") as object),
    openapi: "3.1.0",
  });
  assert.ok(isReadResult(as31));
  assert.ok(!as31.operations.some((item) => item.method === "QUERY"));
  assert.ok(!as31.operations.some((item) => item.method === "PURGE"));
});

test("an operation without an operationId gets a deterministic method+path identity", async () => {
  const document = {
    openapi: "3.1.0",
    info: { title: "Anonymous", version: "1" },
    servers: [{ url: "https://anon.example.test" }],
    paths: {
      "/a": {
        get: { responses: { "200": { description: "ok" } } },
        post: { responses: { "200": { description: "ok" } } },
      },
    },
  };
  const first = await readOpenApi(document);
  const second = await readOpenApi(structuredClone(document));
  assert.ok(isReadResult(first) && isReadResult(second));
  assert.deepEqual(
    first.operations.map((item) => item.nativeId),
    ["GET /a", "POST /a"],
  );
  assert.deepEqual(
    first.operations.map((item) => item.nativeId),
    second.operations.map((item) => item.nativeId),
  );
  assert.ok(first.operations.every((item) => item.identity === "method-path"));
});

test("a duplicate operationId does not collide: the second operation keeps a distinct identity", async () => {
  const read = await readOpenApi({
    openapi: "3.1.0",
    info: { title: "Duplicates", version: "1" },
    servers: [{ url: "https://dup.example.test" }],
    paths: {
      "/a": {
        get: {
          operationId: "same",
          responses: { "200": { description: "ok" } },
        },
      },
      "/b": {
        get: {
          operationId: "same",
          responses: { "200": { description: "ok" } },
        },
      },
    },
  });
  assert.ok(isReadResult(read));
  const ids = read.operations.map((item) => item.nativeId);
  assert.equal(new Set(ids).size, ids.length);
  assert.ok(ids.includes("same"));
  assert.ok(ids.includes("GET /b"));
  assert.ok(
    read.issues.some(
      (issue) => issue.code === "structure.operation-id-duplicate",
    ),
  );
});

test("a recursive schema is preserved without infinite expansion", async () => {
  const read = await readFixture("openapi-3.1-recursive.json");
  assert.equal(read.operations.length, 3);
  // Both the self-referencing and the mutually-referencing schemas survive.
  assert.ok(
    read.definition.capabilities.some((item) => item.nativeId === "getTree"),
  );
  assert.ok(
    read.definition.capabilities.some((item) => item.nativeId === "putPerson"),
  );
  assert.ok(!read.issues.some((issue) => issue.severity === "blocking"));
});

test("operation effect is read for GET and HEAD and stays unknown otherwise", async () => {
  const read = await readFixture("openapi-3.1-catalog.json");
  const byId = new Map(
    read.definition.capabilities.map((item) => [item.nativeId, item]),
  );
  assert.equal(byId.get("listProducts")?.effect, "read");
  assert.equal(byId.get("getProduct")?.effect, "read");
  // A description cannot establish that a write is safe; nothing infers "read"
  // from a name, a summary or the absence of a body.
  assert.equal(byId.get("createProduct")?.effect, "unknown");
  assert.equal(byId.get("deleteProduct")?.effect, "unknown");
  for (const capability of read.definition.capabilities) {
    assert.equal(capability.dataClassification, "unknown");
    assert.equal(capability.cost, "unknown");
  }
});

test("x-* extensions are preserved inertly and example-bearing keys are excluded", async () => {
  const read = await readFixture("openapi-2.0-microsoft.json");
  assert.deepEqual(Object.keys(read.definition.nativeExtensions).sort(), [
    "x-ms-api-annotation",
    "x-ms-connector-metadata",
  ]);
  const list = read.definition.capabilities.find(
    (item) => item.nativeId === "ListTickets",
  );
  assert.equal(list?.nativeExtensions?.["x-ms-visibility"], "important");
  // Dynamic-value descriptions survive as data on the parameter, never as an
  // instruction the reader follows.
  const queue = operation(read, "ListTickets").parameters.find(
    (item) => item.name === "queue",
  );
  assert.ok(queue?.extensions["x-ms-dynamic-values"]);
  assert.equal(queue?.extensions["x-ms-summary"], "Queue");
});

test("a credential canary in examples never reaches the definition, issues or extensions", async () => {
  const read = await readFixture("openapi-3.1-canary.json");
  const canary = "CANARY_SECRET_9f3";
  for (const text of allStrings(read.definition))
    assert.ok(!text.includes(canary), `definition leaked the canary: ${text}`);
  for (const text of allStrings(read.issues))
    assert.ok(!text.includes(canary), `an issue leaked the canary: ${text}`);
  for (const text of allStrings(read.definition.nativeExtensions))
    assert.ok(!text.includes(canary));
  // The reader still saw the document: the operations are there.
  assert.ok(read.operations.some((item) => item.nativeId === "echo"));
});

test("securityRequirementsFor reports alternatives, AND, inheritance and anonymity", async () => {
  const read = await readFixture("swagger-2.0-inventory.json");
  const list = securityRequirementsFor(operation(read, "listItems"));
  assert.equal(list.source, "document");
  assert.equal(list.alternatives.length, 1);
  assert.deepEqual(
    list.alternatives[0]?.schemes.map((entry) => entry.scheme),
    ["api_key"],
  );

  const create = securityRequirementsFor(operation(read, "createItem"));
  assert.equal(create.source, "operation");
  assert.equal(create.alternatives.length, 2);
  assert.deepEqual(create.alternatives[0]?.schemes[0]?.scopes, [
    "inventory:write",
  ]);
  // Two schemes inside one requirement object are a conjunction.
  assert.deepEqual(
    create.alternatives[1]?.schemes.map((entry) => entry.scheme).sort(),
    ["api_key", "basic_auth"],
  );

  const get = securityRequirementsFor(operation(read, "getItem"));
  assert.equal(get.source, "operation");
  assert.equal(get.alternatives.length, 0);
  assert.equal(get.anonymous, true);
});

test("the reader produces a definition whose digest is stable across reads", async () => {
  const first = await readFixture("openapi-3.1-catalog.json");
  const second = await readFixture("openapi-3.1-catalog.json");
  assert.equal(
    first.definition.normalizedDigest,
    second.definition.normalizedDigest,
  );
  assert.equal(first.definition.definitionRef, second.definition.definitionRef);
  assert.equal(first.definition.importer.id, "openapi-http-reader");
});

test("import never claims invoke: the definition's dimensions require configuration", async () => {
  const read = await readFixture("openapi-3.1-catalog.json");
  assert.equal(
    read.definition.compatibility.dimensions.invoke,
    "requires-configuration",
  );
  assert.equal(
    read.definition.compatibility.dimensions.discover,
    "unsupported",
  );
  assert.equal(read.definition.compatibility.dimensions.import, "exact");
  // Declared servers are candidates, never approvals.
  for (const server of read.definition.declaredServers)
    assert.equal(server.status, "declared");
});
