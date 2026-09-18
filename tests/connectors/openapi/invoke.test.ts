import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import {
  compileOperations,
  createOpenApiHttpAdapter,
  isReadResult,
  readOpenApi,
  type CompileOptions,
} from "../../../src/server/connectors/formats/openapi/index.js";
import { startHttpFixture } from "../doubles/http-fixture.js";
import {
  allStrings,
  harness,
  invokeAdapter,
  loopbackDestination,
  makeBinding,
} from "./helpers.js";

/*
 * HTTP-04: exact wire behaviour, observed by an independent fixture server.
 * The fixture asserts what a provider would see — method, path, query string,
 * headers and raw body bytes — and the adapter under test never generates both
 * sides of the comparison.
 */

const CANARY = "CANARY_SECRET_9f3";

const petstore = (extra: Record<string, unknown> = {}) => ({
  openapi: "3.1.0",
  info: { title: "Wire", version: "1.0.0" },
  servers: [{ url: "https://wire.example.test/api" }],
  components: {
    securitySchemes: {
      headerKey: { type: "apiKey", name: "X-Api-Key", in: "header" },
      queryKey: { type: "apiKey", name: "api_key", in: "query" },
      tenant: { type: "apiKey", name: "X-Tenant", in: "header" },
      basic: { type: "http", scheme: "basic" },
      oauth: {
        type: "oauth2",
        flows: {
          authorizationCode: {
            authorizationUrl: "https://auth.example.test/authorize",
            tokenUrl: "https://auth.example.test/token",
            scopes: { "pets:read": "Read", "pets:write": "Write" },
          },
        },
      },
    },
    schemas: {
      Pet: {
        type: "object",
        required: ["name"],
        properties: {
          name: { type: "string", minLength: 1, maxLength: 40 },
          age: { type: "integer", minimum: 0, maximum: 40 },
          tags: { type: "array", items: { type: "string" } },
        },
      },
    },
  },
  security: [{ headerKey: [] }],
  paths: {
    "/pets": {
      get: {
        operationId: "listPets",
        parameters: [
          { name: "status", in: "query", schema: { type: "string" } },
          {
            name: "exploded",
            in: "query",
            style: "form",
            explode: true,
            schema: { type: "array", items: { type: "string" } },
          },
          {
            name: "joined",
            in: "query",
            style: "form",
            explode: false,
            schema: { type: "array", items: { type: "string" } },
          },
          {
            name: "reserved",
            in: "query",
            allowReserved: true,
            schema: { type: "string" },
          },
          { name: "X-Trace", in: "header", schema: { type: "string" } },
        ],
        responses: {
          "200": {
            description: "Pets",
            content: {
              "application/json": {
                schema: {
                  type: "array",
                  items: { $ref: "#/components/schemas/Pet" },
                },
              },
            },
          },
        },
      },
      post: {
        operationId: "createPet",
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/Pet" },
            },
          },
        },
        responses: {
          "201": {
            description: "Created",
            content: {
              "application/json": {
                schema: { $ref: "#/components/schemas/Pet" },
              },
            },
          },
        },
      },
    },
    "/pets/{petId}": {
      get: {
        operationId: "getPet",
        parameters: [
          {
            name: "petId",
            in: "path",
            required: true,
            schema: { type: "string" },
          },
        ],
        responses: {
          "200": {
            description: "Pet",
            content: {
              "application/json": {
                schema: { $ref: "#/components/schemas/Pet" },
              },
            },
          },
        },
      },
    },
    ...(extra.paths as Record<string, unknown> | undefined),
  },
  ...extra,
});

async function bind(
  t: TestContext,
  input: {
    document?: unknown;
    handler: Parameters<typeof startHttpFixture>[0];
    compile?: Partial<CompileOptions>;
    credential?: Record<string, string>;
  },
) {
  const server = await startHttpFixture(input.handler);
  t.after(() => server.close());
  const read = await readOpenApi(input.document ?? petstore());
  assert.ok(isReadResult(read));
  const destination = loopbackDestination(server.origin, "api");
  const compiled = compileOperations(read.definition, read, {
    destinationId: destination.id,
    destination,
    ...input.compile,
  });
  const profiles = read.definition.authentication;
  const binding = makeBinding({
    destination,
    operations: compiled.operations,
    settings: { ...compiled.settings, "openapi-http-profiles": profiles },
    definition: read.definition,
  });
  const context = await harness({
    binding,
    ...(input.credential ? { credential: input.credential } : {}),
  });
  const adapter = createOpenApiHttpAdapter();
  const refFor = (nativeId: string) => {
    const found = compiled.operations.find(
      (item) => item.nativeId === nativeId,
    );
    assert.ok(found, `${nativeId} did not compile`);
    return found.operationRef;
  };
  return { server, read, compiled, binding, adapter, refFor, ...context };
}

test("a GET reaches the exact path the binding pins, with the path parameter encoded once", async (t) => {
  const fixtureState = await bind(t, {
    handler: () => ({ status: 200, body: { name: "Rex" } }),
    credential: { apiKey: "key-value" },
  });
  const result = await invokeAdapter(fixtureState.adapter, fixtureState.ctx, {
    operationRef: fixtureState.refFor("getPet"),
    input: { petId: "a b+c%d" },
  });
  assert.equal(result.state, "complete");
  assert.deepEqual(result.output, { name: "Rex" });
  const [request] = fixtureState.server.requests;
  assert.ok(request);
  assert.equal(request.method, "GET");
  // Encoded exactly once: the space, the plus and the percent are escaped and
  // the template braces are gone.
  assert.equal(request.url.pathname, "/api/pets/a%20b%2Bc%25d");
  assert.equal(request.url.search, "");
});

test("a slash inside a path parameter is refused with its own diagnostic", async (t) => {
  const fixtureState = await bind(t, {
    handler: () => ({ status: 200, body: {} }),
    credential: { apiKey: "key-value" },
  });
  // %2F containment cannot be proven across intermediaries, so the value is
  // refused before the request is built rather than silently reinterpreted.
  await assert.rejects(
    invokeAdapter(fixtureState.adapter, fixtureState.ctx, {
      operationRef: fixtureState.refFor("getPet"),
      input: { petId: "a/b" },
    }),
    (error: { code?: string; detail?: string }) =>
      error.code === "invalid-request" &&
      error.detail === "openapi.path-parameter-encoded-slash",
  );
  assert.equal(fixtureState.server.requests.length, 0);
});

test("query parameters are serialized per style: explode repeats, no-explode joins", async (t) => {
  const fixtureState = await bind(t, {
    handler: () => ({ status: 200, body: [] }),
    credential: { apiKey: "key-value" },
  });
  await invokeAdapter(fixtureState.adapter, fixtureState.ctx, {
    operationRef: fixtureState.refFor("listPets"),
    input: {
      status: "available",
      exploded: ["a", "b"],
      joined: ["c", "d"],
    },
  });
  const [request] = fixtureState.server.requests;
  assert.ok(request);
  assert.deepEqual(request.url.searchParams.getAll("exploded"), ["a", "b"]);
  assert.deepEqual(request.url.searchParams.getAll("joined"), ["c,d"]);
  assert.equal(request.url.searchParams.get("status"), "available");
  // The raw query string shows the exact encodings, not a normalized re-parse.
  // The comma joining a non-exploded array is a delimiter, so it travels
  // literally; only the item values themselves are percent-encoded.
  assert.ok(request.url.search.includes("exploded=a&exploded=b"));
  assert.ok(request.url.search.includes("joined=c,d"));
});

test("allowReserved is respected exactly where the source declares it", async (t) => {
  const fixtureState = await bind(t, {
    handler: () => ({ status: 200, body: [] }),
    credential: { apiKey: "key-value" },
  });
  await invokeAdapter(fixtureState.adapter, fixtureState.ctx, {
    operationRef: fixtureState.refFor("listPets"),
    input: { reserved: "a/b:c", status: "a/b:c" },
  });
  const [request] = fixtureState.server.requests;
  assert.ok(request);
  // allowReserved keeps the reserved characters; the default parameter escapes them.
  assert.ok(request.url.search.includes("reserved=a/b:c"));
  assert.ok(request.url.search.includes("status=a%2Fb%3Ac"));
});

test("a JSON body is sent verbatim with the JSON content type", async (t) => {
  const fixtureState = await bind(t, {
    handler: () => ({ status: 201, body: { name: "Rex", age: 3 } }),
    credential: { apiKey: "key-value" },
  });
  const result = await invokeAdapter(fixtureState.adapter, fixtureState.ctx, {
    operationRef: fixtureState.refFor("createPet"),
    input: { body: { name: "Rex", age: 3, tags: ["good"] } },
  });
  assert.equal(result.state, "complete");
  const [request] = fixtureState.server.requests;
  assert.ok(request);
  assert.equal(request.method, "POST");
  assert.equal(request.headers["content-type"], "application/json");
  assert.deepEqual(JSON.parse(request.body.toString("utf8")), {
    name: "Rex",
    age: 3,
    tags: ["good"],
  });
});

test("input is validated against the compiled schema before anything is sent", async (t) => {
  const fixtureState = await bind(t, {
    handler: () => ({ status: 201, body: {} }),
    credential: { apiKey: "key-value" },
  });
  for (const body of [
    { age: 3 },
    { name: "", age: 3 },
    { name: "Rex", age: -1 },
    { name: "Rex", age: 1.5 },
    { name: "Rex", tags: [1, 2] },
  ])
    await assert.rejects(
      invokeAdapter(fixtureState.adapter, fixtureState.ctx, {
        operationRef: fixtureState.refFor("createPet"),
        input: { body },
      }),
      (error: { code?: string; detail?: string }) =>
        error.code === "invalid-request" &&
        error.detail === "openapi.input-schema-rejected",
    );
  // Nothing reached the network.
  assert.equal(fixtureState.server.requests.length, 0);
});

test("an api key placed in a header never appears in the URL, and the query stays clean", async (t) => {
  const fixtureState = await bind(t, {
    handler: () => ({ status: 200, body: [] }),
    credential: { apiKey: CANARY },
  });
  await invokeAdapter(fixtureState.adapter, fixtureState.ctx, {
    operationRef: fixtureState.refFor("listPets"),
    input: { status: "available" },
  });
  const [request] = fixtureState.server.requests;
  assert.ok(request);
  assert.equal(request.headers["x-api-key"], CANARY);
  assert.ok(!request.url.href.includes(CANARY));
  assert.equal(request.url.search, "?status=available");
});

test("a query api key is placed only when the profile says query", async (t) => {
  const document = petstore({ security: [{ queryKey: [] }] });
  const fixtureState = await bind(t, {
    document,
    handler: () => ({ status: 200, body: [] }),
    credential: { apiKey: "query-secret" },
  });
  await invokeAdapter(fixtureState.adapter, fixtureState.ctx, {
    operationRef: fixtureState.refFor("listPets"),
    input: {},
  });
  const [request] = fixtureState.server.requests;
  assert.ok(request);
  assert.equal(request.url.searchParams.get("api_key"), "query-secret");
  assert.equal(request.headers["x-api-key"], undefined);
  assert.equal(request.headers.authorization, undefined);
});

test("a credential never leaks into the result, the effect journal or an error", async (t) => {
  const fixtureState = await bind(t, {
    handler: () => ({ status: 500, body: { error: "upstream exploded" } }),
    credential: { apiKey: CANARY },
  });
  const result = await invokeAdapter(fixtureState.adapter, fixtureState.ctx, {
    operationRef: fixtureState.refFor("listPets"),
    input: { status: CANARY.toLowerCase() },
  });
  assert.equal(result.state, "failed");
  for (const text of allStrings(result))
    assert.ok(!text.includes(CANARY), `result leaked the canary: ${text}`);
  for (const text of allStrings(fixtureState.ports.inspect.effects()))
    assert.ok(
      !text.includes(CANARY),
      `the effect journal leaked the canary: ${text}`,
    );
  // The upstream body never becomes the public failure message either.
  assert.ok(
    !allStrings(result).some((text) => text.includes("upstream exploded")),
  );
});

test("an AND alternative presents both credentials on the same request", async (t) => {
  const document = petstore({ security: [{ headerKey: [], tenant: [] }] });
  const fixtureState = await bind(t, {
    document,
    handler: () => ({ status: 200, body: [] }),
    credential: { "apiKey:headerKey": "key-a", "apiKey:tenant": "tenant-b" },
  });
  await invokeAdapter(fixtureState.adapter, fixtureState.ctx, {
    operationRef: fixtureState.refFor("listPets"),
    input: {},
  });
  const [request] = fixtureState.server.requests;
  assert.ok(request);
  assert.equal(request.headers["x-api-key"], "key-a");
  assert.equal(request.headers["x-tenant"], "tenant-b");
});

test("basic and bearer credentials are placed as Authorization, never from input", async (t) => {
  const basic = await bind(t, {
    document: petstore({ security: [{ basic: [] }] }),
    handler: () => ({ status: 200, body: [] }),
    credential: { username: "alice", password: "s3cret" },
  });
  await invokeAdapter(basic.adapter, basic.ctx, {
    operationRef: basic.refFor("listPets"),
    input: {},
  });
  assert.equal(
    basic.server.requests[0]?.headers.authorization,
    `Basic ${Buffer.from("alice:s3cret", "utf8").toString("base64")}`,
  );

  const bearer = await bind(t, {
    document: petstore({ security: [{ oauth: ["pets:read"] }] }),
    handler: () => ({ status: 200, body: [] }),
    credential: { accessToken: "token-value" },
  });
  await invokeAdapter(bearer.adapter, bearer.ctx, {
    operationRef: bearer.refFor("listPets"),
    input: {},
  });
  assert.equal(
    bearer.server.requests[0]?.headers.authorization,
    "Bearer token-value",
  );
});

test("an operation with security: [] sends no credential at all", async (t) => {
  const document = petstore({
    paths: {
      "/open": {
        get: {
          operationId: "openPets",
          security: [],
          responses: {
            "200": {
              description: "ok",
              content: { "application/json": { schema: { type: "object" } } },
            },
          },
        },
      },
    },
  });
  const fixtureState = await bind(t, {
    document,
    handler: () => ({ status: 200, body: { ok: true } }),
    credential: { apiKey: CANARY },
  });
  const result = await invokeAdapter(fixtureState.adapter, fixtureState.ctx, {
    operationRef: fixtureState.refFor("openPets"),
    input: {},
  });
  assert.equal(result.state, "complete");
  const [request] = fixtureState.server.requests;
  assert.ok(request);
  // Inherited security was removed by the operation; nothing is presented.
  assert.equal(request.headers["x-api-key"], undefined);
  assert.equal(request.headers.authorization, undefined);
  assert.ok(!request.url.href.includes(CANARY));
});

test("input can never set a header the adapter owns, nor an undeclared parameter", async (t) => {
  const fixtureState = await bind(t, {
    handler: () => ({ status: 200, body: [] }),
    credential: { apiKey: "key-value" },
  });
  for (const [input, detail] of [
    [{ headers: { "X-Evil": "1" } }, "openapi.input-reserved-key"],
    [{ authorization: "Bearer stolen" }, "openapi.input-reserved-key"],
    [{ url: "https://evil.example.test" }, "openapi.input-reserved-key"],
    [{ undeclaredThing: "1" }, "openapi.input-undeclared-parameter"],
  ] as const)
    await assert.rejects(
      invokeAdapter(fixtureState.adapter, fixtureState.ctx, {
        operationRef: fixtureState.refFor("listPets"),
        input,
      }),
      (error: { code?: string; detail?: string }) =>
        error.code === "invalid-request" && error.detail === detail,
    );
  assert.equal(fixtureState.server.requests.length, 0);
});

test("a header parameter value carrying a control character is refused", async (t) => {
  const fixtureState = await bind(t, {
    handler: () => ({ status: 200, body: [] }),
    credential: { apiKey: "key-value" },
  });
  await assert.rejects(
    invokeAdapter(fixtureState.adapter, fixtureState.ctx, {
      operationRef: fixtureState.refFor("listPets"),
      input: {
        "X-Trace": `abc${String.fromCharCode(13)}${String.fromCharCode(10)}X-Evil: 1`,
      },
    }),
    (error: { detail?: string }) =>
      error.detail === "openapi.header-value-invalid",
  );
  assert.equal(fixtureState.server.requests.length, 0);
});

test("a response larger than the bound is refused rather than truncated", async (t) => {
  const big = JSON.stringify(
    Array.from({ length: 5000 }, (_, index) => ({ name: `pet-${index}` })),
  );
  const fixtureState = await bind(t, {
    handler: () => ({
      status: 200,
      body: big,
      headers: { "content-type": "application/json" },
    }),
    compile: { maxResponseBytes: 512 },
    credential: { apiKey: "key-value" },
  });
  const result = await invokeAdapter(fixtureState.adapter, fixtureState.ctx, {
    operationRef: fixtureState.refFor("listPets"),
    input: {},
  });
  assert.equal(result.state, "failed");
  assert.equal(result.code, "openapi.response-too-large");
  // No partial document is handed back as if it were the response.
  assert.equal(result.output, undefined);
});

test("a non-JSON response body is not parsed as JSON", async (t) => {
  const fixtureState = await bind(t, {
    handler: () => ({
      status: 200,
      body: "<html>not json</html>",
      headers: { "content-type": "text/html" },
    }),
    credential: { apiKey: "key-value" },
  });
  const result = await invokeAdapter(fixtureState.adapter, fixtureState.ctx, {
    operationRef: fixtureState.refFor("listPets"),
    input: {},
  });
  assert.equal(result.state, "complete");
  assert.equal(result.output, undefined);
});

test("an upstream 4xx fails and a 5xx on a write is indeterminate", async (t) => {
  const rejected = await bind(t, {
    handler: () => ({ status: 422, body: { error: "bad" } }),
    credential: { apiKey: "key-value" },
  });
  const failure = await invokeAdapter(rejected.adapter, rejected.ctx, {
    operationRef: rejected.refFor("createPet"),
    input: { body: { name: "Rex" } },
  });
  assert.equal(failure.state, "failed");
  assert.equal(failure.code, "upstream-rejected");

  const unavailable = await bind(t, {
    handler: () => ({ status: 503, body: { error: "down" } }),
    credential: { apiKey: "key-value" },
  });
  const uncertain = await invokeAdapter(unavailable.adapter, unavailable.ctx, {
    operationRef: unavailable.refFor("createPet"),
    input: { body: { name: "Rex" } },
  });
  // A write whose outcome the transport could not establish is not a failure.
  assert.equal(uncertain.state, "indeterminate");
  assert.equal(uncertain.code, "upstream-unavailable");

  const read = await invokeAdapter(unavailable.adapter, unavailable.ctx, {
    operationRef: unavailable.refFor("listPets"),
    input: {},
  });
  assert.equal(read.state, "failed");
});

test("a lost write response is indeterminate; a lost read is a plain failure", async (t) => {
  const fixtureState = await bind(t, {
    handler: (_request, raw) => {
      raw.res.destroy();
      return undefined;
    },
    credential: { apiKey: "key-value" },
  });
  const write = await invokeAdapter(fixtureState.adapter, fixtureState.ctx, {
    operationRef: fixtureState.refFor("createPet"),
    input: { body: { name: "Rex" } },
  });
  assert.equal(write.state, "indeterminate");
  const read = await invokeAdapter(fixtureState.adapter, fixtureState.ctx, {
    operationRef: fixtureState.refFor("getPet"),
    input: { petId: "1" },
  });
  assert.equal(read.state, "failed");
});

test("a redirect is refused rather than followed", async (t) => {
  const fixtureState = await bind(t, {
    handler: (request) =>
      request.url.pathname === "/api/pets"
        ? { status: 302, headers: { location: "/api/elsewhere" }, body: "" }
        : { status: 200, body: { moved: true } },
    credential: { apiKey: CANARY },
  });
  const result = await invokeAdapter(fixtureState.adapter, fixtureState.ctx, {
    operationRef: fixtureState.refFor("listPets"),
    input: {},
  });
  assert.equal(result.state, "failed");
  assert.equal(result.code, "upstream-unavailable");
  // The second hop was never made, so the credential never reached it.
  assert.equal(fixtureState.server.requests.length, 1);
  assert.equal(fixtureState.server.requests[0]?.url.pathname, "/api/pets");
});

test("the effect journal records the request digest and replays a repeated write", async (t) => {
  let served = 0;
  const fixtureState = await bind(t, {
    handler: () => {
      served += 1;
      return { status: 201, body: { name: "Rex" } };
    },
    credential: { apiKey: "key-value" },
  });
  const request = {
    operationRef: fixtureState.refFor("createPet"),
    input: { body: { name: "Rex" } },
  };
  const first = await invokeAdapter(
    fixtureState.adapter,
    fixtureState.ctx,
    request,
  );
  assert.equal(first.state, "complete");
  assert.equal(served, 1);
  const second = await invokeAdapter(
    fixtureState.adapter,
    fixtureState.ctx,
    request,
  );
  // The same effect is not applied twice: the journal answers instead.
  assert.equal(second.state, "complete");
  assert.equal(served, 1);
  assert.equal(second.effectRef, first.effectRef);

  // A read is not gated the same way: it may be repeated.
  const readRequest = {
    operationRef: fixtureState.refFor("getPet"),
    input: { petId: "1" },
  };
  await invokeAdapter(fixtureState.adapter, fixtureState.ctx, readRequest);
  await invokeAdapter(fixtureState.adapter, fixtureState.ctx, readRequest);
  assert.equal(served, 3);
});

test("an unbound operation ref cannot be invoked", async (t) => {
  const fixtureState = await bind(t, {
    handler: () => ({ status: 200, body: [] }),
    credential: { apiKey: "key-value" },
  });
  await assert.rejects(
    invokeAdapter(fixtureState.adapter, fixtureState.ctx, {
      operationRef: "binding:openapi-test:op:deadbeefdeadbeef",
      input: {},
    }),
    (error: { code?: string; detail?: string }) =>
      error.code === "not-found" &&
      error.detail === "openapi.operation-not-bound",
  );
  assert.equal(fixtureState.server.requests.length, 0);
});

test("a plan that disagrees with its bound operation is refused", async (t) => {
  const fixtureState = await bind(t, {
    handler: () => ({ status: 200, body: [] }),
    credential: { apiKey: "key-value" },
  });
  const operationRef = fixtureState.refFor("getPet");
  const settings = structuredClone(fixtureState.binding.settings) as Record<
    string,
    unknown
  >;
  const plans = (
    settings["openapi-http"] as { plans: Record<string, { method: string }> }
  ).plans;
  plans[operationRef]!.method = "DELETE";
  const tampered = {
    ...fixtureState.ctx,
    binding: { ...fixtureState.binding, settings },
  };
  await assert.rejects(
    invokeAdapter(fixtureState.adapter, tampered, {
      operationRef,
      input: { petId: "1" },
    }),
    (error: { code?: string; detail?: string }) =>
      error.code === "conflict" &&
      error.detail === "openapi.plan-binding-mismatch",
  );
  assert.equal(fixtureState.server.requests.length, 0);
});

test("verify uses an approved read operation and claims only credential acceptance", async (t) => {
  const document = petstore({
    paths: {
      "/whoami": {
        get: {
          operationId: "whoami",
          responses: {
            "200": {
              description: "ok",
              content: { "application/json": { schema: { type: "object" } } },
            },
          },
        },
      },
    },
  });
  const fixtureState = await bind(t, {
    document,
    handler: () => ({ status: 200, body: { account: "acme" } }),
    compile: { verifier: { nativeId: "whoami" } },
    credential: { apiKey: "key-value" },
  });
  const result = await fixtureState.adapter.verify!(fixtureState.ctx);
  assert.equal(result.state, "complete");
  assert.equal(result.claims.length, 1);
  assert.equal(result.claims[0]?.kind, "credential-accepted");
  // A 200 is not an account identity claim, and the limitation says so.
  assert.notEqual(result.claims[0]?.kind, "account-identity");
  assert.ok(
    result.claims[0]?.limitations.some((text) =>
      text.includes("not which account"),
    ),
  );
  assert.equal(result.target, undefined);
});

test("without a named verifier, verification stays pending rather than inventing one", async (t) => {
  const fixtureState = await bind(t, {
    handler: () => ({ status: 200, body: [] }),
    credential: { apiKey: "key-value" },
  });
  const result = await fixtureState.adapter.verify!(fixtureState.ctx);
  assert.equal(result.state, "pending");
  assert.equal(result.code, "openapi.no-verifier");
  assert.equal(fixtureState.server.requests.length, 0);
});

test("disconnect and revoke report local scope only, never an upstream claim", async (t) => {
  const fixtureState = await bind(t, {
    handler: () => ({ status: 200, body: [] }),
    credential: { apiKey: "key-value" },
  });
  const local = await fixtureState.adapter.disconnect!(
    fixtureState.ctx,
    "local",
  );
  assert.equal(local.local, "applied");
  assert.equal(local.upstream, "unsupported");
  const upstream = await fixtureState.adapter.disconnect!(
    fixtureState.ctx,
    "upstream",
  );
  assert.equal(upstream.upstream, "unsupported");
  assert.equal(upstream.local, "not-attempted");
  const revoked = await fixtureState.adapter.revoke!(fixtureState.ctx);
  assert.equal(revoked.upstream, "unsupported");
  assert.equal(fixtureState.server.requests.length, 0);
});

test("capabilities report per dimension and never claim evidence for an unsupported one", async () => {
  const adapter = createOpenApiHttpAdapter();
  const rows = adapter.capabilities(new Set());
  const byDimension = new Map(rows.map((row) => [row.dimension, row]));
  assert.equal(byDimension.get("discover")?.implementation, "unsupported");
  assert.equal(byDimension.get("events")?.implementation, "unsupported");
  assert.equal(byDimension.get("revoke")?.implementation, "unsupported");
  assert.equal(byDimension.get("delegate")?.implementation, "unsupported");
  for (const dimension of [
    "import",
    "configure",
    "authorize",
    "verify",
    "invoke",
    "export",
  ] as const)
    assert.equal(byDimension.get(dimension)?.implementation, "implemented");
  for (const row of rows)
    if (row.implementation === "unsupported")
      assert.equal(row.evidence, "not-tested");
  assert.equal(adapter.id, "openapi-http");
  assert.equal(adapter.ecosystem, "openapi");
  assert.equal(adapter.runtime, "hosted-server");
  assert.deepEqual([...adapter.custody], ["host-owned", "no-credential"]);
});
