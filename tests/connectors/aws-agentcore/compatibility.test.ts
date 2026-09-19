import assert from "node:assert/strict";
import { test } from "node:test";
import {
  analyzeOpenApiSchema,
  gatewayToolName,
  splitGatewayToolName,
} from "../../../src/server/connectors/providers/aws-agentcore/compatibility.js";

/*
 * The gateway supports a subset of OpenAPI, and this is where a document is
 * measured against it before anything is bound. The result decides which
 * operations may become tools, so the interesting property is not that a bad
 * document is rejected -- it is that a document which is bad in one place
 * still yields the operations that are fine, and that each refusal arrives
 * with the code naming what the gateway cannot do.
 *
 * Every input here is untrusted text. Nothing is fetched, dereferenced or
 * evaluated to read it, and a document that is not a document at all has to
 * come back as a refusal rather than an exception.
 */

const analyze = (document: unknown) =>
  analyzeOpenApiSchema(
    typeof document === "string" ? document : JSON.stringify(document),
    "/inline",
  );

const codes = (document: unknown) =>
  analyze(document).issues.map((issue) => issue.code);

/** A minimal document the gateway does support, for use as a baseline. */
const base = (operation: Record<string, unknown>) => ({
  openapi: "3.0.3",
  servers: [{ url: "https://api.example.com/v1" }],
  paths: { "/things": { get: { operationId: "getThing", ...operation } } },
});

test("AC-OAS-01: a supported document yields its operations and no blocking issue", () => {
  const analysis = analyze(base({}));
  assert.deepEqual(analysis.operationIds, ["getThing"]);
  assert.equal(analysis.blocked, false);
  assert.deepEqual(
    analysis.issues.filter((issue) => issue.severity === "blocking"),
    [],
  );
});

test("AC-OAS-02: text that is not a document is refused, never thrown", () => {
  for (const [input, code] of [
    ["{ this is not json", "agentcore.openapi.unreadable"],
    ["", "agentcore.openapi.unreadable"],
    ['"a string"', "agentcore.openapi.not-a-document"],
    ["[]", "agentcore.openapi.not-a-document"],
    ["null", "agentcore.openapi.not-a-document"],
  ] as const) {
    const analysis = analyzeOpenApiSchema(input, "/inline");
    assert.deepEqual(
      analysis.issues.map((i) => i.code),
      [code],
      input,
    );
    assert.equal(analysis.blocked, true, input);
    assert.deepEqual(analysis.operationIds, [], input);
  }
});

test("AC-OAS-03: an unsupported specification version is named, not guessed at", () => {
  assert.deepEqual(codes({ swagger: "2.0" }), ["agentcore.openapi.swagger-2"]);
  assert.deepEqual(codes({ openapi: "4.0.0" }), [
    "agentcore.openapi.version-unsupported",
  ]);
  // Each of these stops the read: nothing is reported about operations whose
  // spelling this reader has not agreed to interpret.
  assert.deepEqual(analyze({ swagger: "2.0" }).operationIds, []);
});

test("AC-OAS-04: a missing server, and a server whose host is a template", () => {
  assert.ok(
    codes({ openapi: "3.0.3", paths: {} }).includes(
      "agentcore.openapi.server-missing",
    ),
  );
  // A templated host can be pointed anywhere after approval, which is the one
  // part of a URL that must be settled before a binding exists.
  assert.ok(
    codes({
      openapi: "3.0.3",
      servers: [{ url: "https://{tenant}.example.com/v1" }],
      paths: {},
    }).includes("agentcore.openapi.server-host-templated"),
  );
  // A template in the path is not the same thing and is not reported.
  assert.ok(
    !codes({
      openapi: "3.0.3",
      servers: [{ url: "https://api.example.com/{version}" }],
      paths: {},
    }).includes("agentcore.openapi.server-host-templated"),
  );
});

test("AC-OAS-05: specification-level security is refused in favour of the gateway's own", () => {
  const fromRequirement = codes({
    ...base({}),
    security: [{ apiKey: [] }],
  });
  assert.ok(fromRequirement.includes("agentcore.openapi.security-scheme"));
  const fromSchemes = codes({
    ...base({}),
    components: { securitySchemes: { apiKey: { type: "apiKey" } } },
  });
  assert.ok(fromSchemes.includes("agentcore.openapi.security-scheme"));
  // An empty declaration is not a declaration.
  assert.ok(
    !codes({
      ...base({}),
      security: [],
      components: { securitySchemes: {} },
    }).includes("agentcore.openapi.security-scheme"),
  );
});

test("AC-OAS-06: an operation with no operationId cannot be named as a tool", () => {
  const analysis = analyze({
    openapi: "3.0.3",
    servers: [{ url: "https://api.example.com" }],
    paths: { "/things": { get: {} } },
  });
  assert.ok(
    analysis.issues.some(
      (issue) => issue.code === "agentcore.openapi.operation-id-missing",
    ),
  );
  assert.deepEqual(analysis.operationIds, []);
});

test("AC-OAS-07: a parameter serializer blocks its own operation", () => {
  for (const parameter of [
    { name: "tags", in: "query", style: "form" },
    { name: "tags", in: "query", explode: true },
  ]) {
    const analysis = analyze(base({ parameters: [parameter] }));
    assert.ok(
      analysis.issues.some(
        (issue) => issue.code === "agentcore.openapi.parameter-serializer",
      ),
      JSON.stringify(parameter),
    );
    assert.deepEqual(analysis.operationIds, []);
  }
  // A parameter that asks for no serializer is fine.
  assert.deepEqual(
    analyze(base({ parameters: [{ name: "id", in: "query" }] })).operationIds,
    ["getThing"],
  );
});

test("AC-OAS-08: only the documented media types are accepted", () => {
  const unsupported = analyze(
    base({
      requestBody: { content: { "application/octet-stream": { schema: {} } } },
    }),
  );
  assert.ok(
    unsupported.issues.some(
      (issue) => issue.code === "agentcore.openapi.media-type",
    ),
  );
  assert.deepEqual(unsupported.operationIds, []);

  for (const mediaType of [
    "application/json",
    "application/xml",
    "multipart/form-data",
    "application/x-www-form-urlencoded",
    // Parameters are not part of the type: a charset does not make it custom.
    "application/json; charset=utf-8",
  ]) {
    const analysis = analyze(
      base({ requestBody: { content: { [mediaType]: { schema: {} } } } }),
    );
    assert.deepEqual(analysis.operationIds, ["getThing"], mediaType);
  }
});

test("AC-OAS-09: schema composition anywhere in the operation blocks it", () => {
  for (const keyword of ["oneOf", "anyOf", "allOf"]) {
    const analysis = analyze(
      base({
        requestBody: {
          content: {
            "application/json": {
              // Nested, because composition is refused wherever it appears and
              // not only at the top of a schema.
              schema: {
                properties: { field: { [keyword]: [{ type: "string" }] } },
              },
            },
          },
        },
      }),
    );
    assert.ok(
      analysis.issues.some(
        (issue) => issue.code === "agentcore.openapi.schema-composition",
      ),
      keyword,
    );
    assert.deepEqual(analysis.operationIds, [], keyword);
  }
});

test("AC-OAS-10: callbacks are reported without blocking the operation", () => {
  const analysis = analyze(base({ callbacks: {} }));
  const callback = analysis.issues.find(
    (issue) => issue.code === "agentcore.openapi.callbacks",
  );
  assert.ok(callback);
  assert.equal(callback.severity, "warning");
  assert.equal(callback.executionImpact, "none");
  // The distinction that matters: the operation is still bindable.
  assert.deepEqual(analysis.operationIds, ["getThing"]);
  assert.equal(analysis.blocked, false);
});

test("AC-OAS-11: one unusable operation does not disqualify its neighbours", () => {
  const analysis = analyze({
    openapi: "3.0.3",
    servers: [{ url: "https://api.example.com" }],
    paths: {
      "/bad": {
        get: { operationId: "bad", parameters: [{ name: "a", style: "form" }] },
      },
      "/good": { get: { operationId: "good" } },
      // Not an HTTP method, so not an operation, and not an error either.
      "/described": { summary: "text", get: { operationId: "described" } },
    },
  });
  assert.deepEqual(analysis.operationIds.sort(), ["described", "good"]);
  assert.equal(analysis.blocked, false);
});

test("AC-OAS-12: a document with no operations at all is blocked and says so", () => {
  const analysis = analyze({
    openapi: "3.0.3",
    servers: [{ url: "https://api.example.com" }],
    paths: {},
  });
  assert.ok(
    analysis.issues.some(
      (issue) => issue.code === "agentcore.openapi.no-operations",
    ),
  );
  assert.equal(analysis.blocked, true);
});

test("AC-OAS-13: malformed paths and operations are skipped, not read", () => {
  // Each of these is the wrong shape for the place it sits in. None may throw,
  // and none may be interpreted as an operation.
  for (const paths of [
    { "/things": null },
    { "/things": "text" },
    { "/things": [] },
    { "/things": { get: null } },
    { "/things": { get: "text" } },
  ]) {
    const analysis = analyze({
      openapi: "3.0.3",
      servers: [{ url: "https://api.example.com" }],
      paths,
    });
    assert.deepEqual(analysis.operationIds, [], JSON.stringify(paths));
    assert.equal(analysis.blocked, true, JSON.stringify(paths));
  }
  // `paths` itself being the wrong shape is the same kind of non-event.
  for (const paths of [null, "text", []])
    assert.deepEqual(
      analyze({
        openapi: "3.0.3",
        servers: [{ url: "https://api.example.com" }],
        paths,
      }).operationIds,
      [],
    );
});

test("AC-OAS-14: a namespaced tool name round trips and refuses the ambiguous", () => {
  const name = gatewayToolName("orders", "create");
  assert.deepEqual(splitGatewayToolName(name), {
    targetName: "orders",
    toolName: "create",
  });
  // A tool name may itself contain the delimiter; the first one separates.
  const nested = gatewayToolName("orders", gatewayToolName("sub", "create"));
  assert.equal(splitGatewayToolName(nested)?.targetName, "orders");
  assert.equal(
    splitGatewayToolName(nested)?.toolName,
    gatewayToolName("sub", "create"),
  );
  // Nothing that fails to name both halves is accepted: a name belonging to no
  // target must not be resolved against an arbitrary one.
  for (const hostile of [
    "create",
    "",
    gatewayToolName("", "create"),
    gatewayToolName("orders", ""),
  ])
    assert.equal(splitGatewayToolName(hostile), undefined, hostile);
});
