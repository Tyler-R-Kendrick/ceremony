import assert from "node:assert/strict";
import { test } from "node:test";
import {
  compileOperations,
  isReadResult,
  parsePointer,
  readOpenApi,
  splitReference,
  validateValue,
} from "../../../src/server/connectors/formats/openapi/index.js";
import { loopbackDestination, readFixture } from "./helpers.js";

/*
 * Reference resolution and recursion bounds (AC-IMP-10 on the OpenAPI side).
 * The reader resolves in-document references itself, cycle-aware and bounded;
 * external references are only ever reached through the host's hook, so the
 * deployment's network policy — not the document — decides what is fetched.
 */

const destination = loopbackDestination("https://origin.example.test", "api");

const withRefs = (extra: Record<string, unknown> = {}) => ({
  openapi: "3.1.0",
  info: { title: "Refs", version: "1.0.0" },
  servers: [{ url: "https://refs.example.test" }],
  paths: {
    "/a": {
      get: {
        operationId: "a",
        parameters: [{ $ref: "#/components/parameters/Page" }],
        // A Responses Object is keyed by status codes; the individual Response
        // Objects inside it are what may be referenced.
        responses: { "200": { $ref: "#/components/responses/Common" } },
      },
    },
  },
  components: {
    parameters: {
      Page: { name: "page", in: "query", schema: { type: "integer", minimum: 1 } },
    },
    responses: {
      Common: {
        description: "ok",
        content: { "application/json": { schema: { type: "object" } } },
      },
    },
  },
  ...extra,
});

test("in-document references are resolved for parameters, bodies and responses", async () => {
  const read = await readOpenApi(withRefs());
  assert.ok(isReadResult(read));
  const operation = read.operations[0];
  assert.ok(operation);
  assert.equal(operation.parameters[0]?.name, "page");
  assert.equal(operation.parameters[0]?.in, "query");
  assert.equal(operation.responses[0]?.status, "200");
  assert.equal(operation.responses[0]?.description, "ok");
  assert.deepEqual(
    operation.responses[0]?.content.map((item) => item.mediaType),
    ["application/json"],
  );
  assert.ok(!read.issues.some((issue) => issue.severity === "blocking"));
});

test("a responses entry that is not a status code is not read as a response", async () => {
  const read = await readOpenApi(
    withRefs({
      paths: {
        "/a": {
          get: {
            operationId: "a",
            // The Responses Object is not itself referenceable.
            responses: {
              $ref: "#/components/responses/Common",
              "200": { description: "ok" },
            },
          },
        },
      },
    }),
  );
  assert.ok(isReadResult(read));
  assert.deepEqual(
    read.operations[0]?.responses.map((item) => item.status),
    ["200"],
  );
  assert.ok(read.issues.some((issue) => issue.code === "structure.invalid-response-key"));
});

test("an unresolvable in-document reference blocks its operation without failing the document", async () => {
  const read = await readOpenApi(
    withRefs({
      paths: {
        "/a": {
          get: {
            operationId: "a",
            parameters: [{ $ref: "#/components/parameters/Missing" }],
            responses: { "200": { description: "ok" } },
          },
        },
        "/b": {
          get: {
            operationId: "b",
            responses: {
              "200": {
                description: "ok",
                content: { "application/json": { schema: { type: "object" } } },
              },
            },
          },
        },
      },
    }),
  );
  assert.ok(isReadResult(read));
  assert.ok(read.issues.some((issue) => issue.code === "structure.reference-unresolved"));
  // The unrelated operation is still there and still compilable.
  const compiled = compileOperations(read.definition, read, {
    destinationId: destination.id,
    destination,
  });
  assert.ok(compiled.executable.includes("b"));
});

test("a reference cycle between schemas is bounded, not followed forever", async () => {
  const read = await readOpenApi({
    openapi: "3.1.0",
    info: { title: "Cycle", version: "1" },
    servers: [{ url: "https://cycle.example.test" }],
    paths: {
      "/a": {
        post: {
          operationId: "a",
          requestBody: {
            required: true,
            content: { "application/json": { schema: { $ref: "#/components/schemas/Loop" } } },
          },
          responses: {
            "200": {
              description: "ok",
              content: { "application/json": { schema: { type: "object" } } },
            },
          },
        },
      },
    },
    components: {
      schemas: {
        // A pure alias cycle: Loop points at Ping, Ping points back at Loop.
        Loop: { $ref: "#/components/schemas/Ping" },
        Ping: { $ref: "#/components/schemas/Loop" },
      },
    },
  });
  assert.ok(isReadResult(read));
  const compiled = compileOperations(read.definition, read, {
    destinationId: destination.id,
    destination,
  });
  // The cycle is reported as an unresolved reference and blocks that operation.
  assert.ok(
    compiled.blocked.some((entry) =>
      entry.issues.some((issue) => issue.code === "schema.reference-unresolved"),
    ),
  );
  assert.deepEqual(compiled.executable, []);
});

test("a recursive schema validates real values to an explicit depth", async () => {
  const read = await readFixture("openapi-3.1-recursive.json");
  const compiled = compileOperations(read.definition, read, {
    destinationId: destination.id,
    destination,
  });
  const operationRef = compiled.operations.find((item) => item.nativeId === "putTree")!
    .operationRef;
  const plan = compiled.plans[operationRef]!;
  const schema = plan.requestBody!.schema;

  // A shallow tree validates.
  assert.deepEqual(
    validateValue(
      { name: "root", children: [{ name: "child", children: [] }] },
      schema,
      plan.definitions,
    ),
    [],
  );
  // A violation deep inside the recursion is still caught.
  const deepFailure = validateValue(
    { name: "root", children: [{ name: "child", children: [{ children: [] }] }] },
    schema,
    plan.definitions,
  );
  assert.ok(deepFailure.some((failure) => failure.code === "schema.required"));

  // Beyond the explicit depth the validator refuses rather than recursing on.
  let deep: Record<string, unknown> = { name: "leaf", children: [] };
  for (let index = 0; index < 200; index++) deep = { name: "n", children: [deep] };
  const bounded = validateValue(deep, schema, plan.definitions, { maxDepth: 16 });
  assert.ok(bounded.some((failure) => failure.code === "schema.depth-exceeded"));
});

test("mutually recursive schemas compile and validate without expanding forever", async () => {
  const read = await readFixture("openapi-3.1-recursive.json");
  const compiled = compileOperations(read.definition, read, {
    destinationId: destination.id,
    destination,
  });
  const operationRef = compiled.operations.find((item) => item.nativeId === "putPerson")!
    .operationRef;
  const plan = compiled.plans[operationRef]!;
  assert.deepEqual(
    validateValue(
      { name: "ada", manager: { lead: { name: "grace" }, members: [] } },
      plan.requestBody!.schema,
      plan.definitions,
    ),
    [],
  );
  // Both sides of the mutual reference are named entries, not inlined copies.
  assert.ok(Object.keys(plan.definitions).some((key) => key.endsWith("/Person")));
  assert.ok(Object.keys(plan.definitions).some((key) => key.endsWith("/Team")));
});

test("an external reference without a resolver is reported, never fetched", async () => {
  const read = await readOpenApi({
    openapi: "3.1.0",
    info: { title: "External", version: "1" },
    servers: [{ url: "https://external.example.test" }],
    paths: {
      "/a": {
        get: {
          operationId: "a",
          parameters: [{ $ref: "https://attacker.example.test/params.json#/Evil" }],
          responses: { "200": { description: "ok" } },
        },
      },
    },
  });
  assert.ok(isReadResult(read));
  assert.ok(
    read.issues.some((issue) => issue.code === "structure.external-reference-unresolved"),
  );
  // The parameter behind the reference is not invented.
  assert.deepEqual(read.operations[0]?.parameters, []);
});

test("an external reference is fetched only through the host hook, which may refuse", async () => {
  const asked: string[] = [];
  const document = {
    openapi: "3.1.0",
    info: { title: "External", version: "1" },
    servers: [{ url: "https://external.example.test" }],
    paths: {
      "/a": {
        get: {
          operationId: "a",
          parameters: [{ $ref: "https://shared.example.test/params.json#/Page" }],
          responses: {
            "200": {
              description: "ok",
              content: { "application/json": { schema: { type: "object" } } },
            },
          },
        },
      },
    },
  };
  const resolved = await readOpenApi(document, {
    resolveExternal: async (ref) => {
      asked.push(ref);
      return { Page: { name: "page", in: "query", schema: { type: "integer" } } };
    },
  });
  assert.ok(isReadResult(resolved));
  assert.deepEqual(asked, ["https://shared.example.test/params.json"]);
  assert.equal(resolved.operations[0]?.parameters[0]?.name, "page");

  // A hook that refuses (network policy, private address, redirect) leaves the
  // construct unresolved and records the denial without a credential in it.
  const refused = await readOpenApi(document, {
    resolveExternal: async () => undefined,
  });
  assert.ok(isReadResult(refused));
  const issue = refused.issues.find(
    (item) => item.code === "network.external-reference-unavailable",
  );
  assert.ok(issue);
  assert.equal(issue.category, "network");
  assert.deepEqual(refused.operations[0]?.parameters, []);

  // A hook that throws is handled the same way, not propagated.
  const threw = await readOpenApi(document, {
    resolveExternal: async () => {
      throw new Error("blocked by policy: token=CANARY_SECRET_9f3");
    },
  });
  assert.ok(isReadResult(threw));
  assert.ok(
    threw.issues.every((item) => !item.message.includes("CANARY_SECRET_9f3")),
  );
});

test("reference fragments this resolver does not implement are refused", () => {
  assert.deepEqual(splitReference("#/components/schemas/A"), {
    uri: "",
    fragment: "/components/schemas/A",
  });
  assert.deepEqual(splitReference("other.json"), { uri: "other.json", fragment: "" });
  assert.deepEqual(parsePointer("/a~1b/c~0d"), ["a/b", "c~d"]);
  // A plain-name anchor is not a JSON pointer and is not guessed at.
  assert.equal(parsePointer("anchorName"), undefined);
  assert.deepEqual(parsePointer(""), []);
});

test("the reader refuses a document that exceeds its node budget", async () => {
  const paths: Record<string, unknown> = {};
  for (let index = 0; index < 50; index++)
    paths[`/p${index}`] = {
      get: { operationId: `op${index}`, responses: { "200": { description: "ok" } } },
    };
  const read = await readOpenApi(
    { openapi: "3.1.0", info: { title: "Big", version: "1" }, paths },
    { limits: { maxNodes: 10 } },
  );
  assert.equal(read.profile, undefined);
  assert.equal(read.issues[0]?.code, "structure.budget-exceeded");
  assert.equal(read.issues[0]?.executionImpact, "blocks-definition");
});

test("a document key named like a prototype never becomes a prototype", async () => {
  const hostile = JSON.parse(
    JSON.stringify({
      openapi: "3.1.0",
      info: { title: "Hostile", version: "1" },
      servers: [{ url: "https://hostile.example.test" }],
      paths: {
        "/a": {
          get: {
            operationId: "a",
            responses: {
              "200": {
                description: "ok",
                content: { "application/json": { schema: { type: "object" } } },
              },
            },
          },
        },
      },
      components: { schemas: { "__proto__": { polluted: true } } },
    }),
  );
  const read = await readOpenApi(hostile);
  assert.ok(isReadResult(read));
  assert.equal(({} as Record<string, unknown>).polluted, undefined);
  assert.equal((Object.prototype as Record<string, unknown>).polluted, undefined);
  const compiled = compileOperations(read.definition, read, {
    destinationId: destination.id,
    destination,
  });
  assert.ok(compiled.executable.includes("a"));
});
