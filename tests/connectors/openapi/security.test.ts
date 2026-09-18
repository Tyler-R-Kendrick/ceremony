import assert from "node:assert/strict";
import { test } from "node:test";
import {
  isReadResult,
  readOpenApi,
  securityRequirementsFor,
} from "../../../src/server/connectors/formats/openapi/index.js";
import { readFixture } from "./helpers.js";

/*
 * HTTP-02 / AC-IMP-04: the security semantics of the source, copied exactly.
 * A list of requirement objects is a disjunction; the names inside one object
 * are a conjunction; an operation's own list replaces the document default;
 * `{}` is an anonymous alternative and `[]` at operation level removes the
 * inherited default entirely.
 */

const read31 = async (paths: unknown, extra: Record<string, unknown> = {}) => {
  const result = await readOpenApi({
    openapi: "3.1.0",
    info: { title: "Security", version: "1" },
    servers: [{ url: "https://security.example.test" }],
    components: {
      securitySchemes: {
        key: { type: "apiKey", name: "X-Api-Key", in: "header" },
        cookieKey: { type: "apiKey", name: "sid", in: "cookie" },
        queryKey: { type: "apiKey", name: "api_key", in: "query" },
        basic: { type: "http", scheme: "basic" },
        bearer: { type: "http", scheme: "bearer", bearerFormat: "JWT" },
        oauth: {
          type: "oauth2",
          flows: {
            authorizationCode: {
              authorizationUrl: "https://auth.example.test/authorize",
              tokenUrl: "https://auth.example.test/token",
              scopes: { read: "Read", write: "Write" },
            },
          },
        },
        oidc: {
          type: "openIdConnect",
          openIdConnectUrl:
            "https://id.example.test/.well-known/openid-configuration",
        },
        mtls: { type: "mutualTLS" },
        weird: { type: "quantumHandshake" },
      },
    },
    paths,
    ...extra,
  });
  assert.ok(isReadResult(result));
  return result;
};

const alternativesOf = (
  read: Awaited<ReturnType<typeof read31>>,
  id: string,
) => {
  const found = read.operations.find((item) => item.nativeId === id);
  assert.ok(found, `operation ${id} missing`);
  return securityRequirementsFor(found);
};

test("alternatives are OR and schemes inside one requirement are AND", async () => {
  const read = await read31({
    "/a": {
      get: {
        operationId: "a",
        security: [{ key: [] }, { basic: [], bearer: [] }],
        responses: { "200": { description: "ok" } },
      },
    },
  });
  const security = alternativesOf(read, "a");
  assert.equal(security.alternatives.length, 2);
  assert.deepEqual(
    security.alternatives[0]?.schemes.map((entry) => entry.scheme),
    ["key"],
  );
  assert.deepEqual(
    security.alternatives[1]?.schemes.map((entry) => entry.scheme).sort(),
    ["basic", "bearer"],
  );
  assert.equal(security.anonymous, false);
  // Both alternatives are satisfiable, so both are executable.
  assert.deepEqual(security.executableAlternatives, [0, 1]);
});

test("an operation's security replaces the document default", async () => {
  const read = await read31(
    {
      "/inherits": {
        get: {
          operationId: "inherits",
          responses: { "200": { description: "ok" } },
        },
      },
      "/replaces": {
        get: {
          operationId: "replaces",
          security: [{ bearer: [] }],
          responses: { "200": { description: "ok" } },
        },
      },
    },
    { security: [{ key: [] }] },
  );
  const inherits = alternativesOf(read, "inherits");
  assert.equal(inherits.source, "document");
  assert.deepEqual(
    inherits.alternatives[0]?.schemes.map((entry) => entry.scheme),
    ["key"],
  );

  const replaces = alternativesOf(read, "replaces");
  assert.equal(replaces.source, "operation");
  // The document default is gone, not merged.
  assert.deepEqual(
    replaces.alternatives.map((alternative) =>
      alternative.schemes.map((entry) => entry.scheme),
    ),
    [["bearer"]],
  );
});

test("an empty operation-level security list removes the inherited requirement", async () => {
  const read = await read31(
    {
      "/open": {
        get: {
          operationId: "open",
          security: [],
          responses: { "200": { description: "ok" } },
        },
      },
    },
    { security: [{ key: [] }, { oauth: ["read"] }] },
  );
  const security = alternativesOf(read, "open");
  assert.equal(security.source, "operation");
  assert.equal(security.alternatives.length, 0);
  assert.equal(security.anonymous, true);
  assert.deepEqual(security.profileIds, []);
});

test("an explicit empty requirement object is one anonymous alternative beside the others", async () => {
  const read = await read31({
    "/optional": {
      get: {
        operationId: "optional",
        security: [{}, { oauth: ["read"] }],
        responses: { "200": { description: "ok" } },
      },
    },
  });
  const security = alternativesOf(read, "optional");
  assert.equal(security.alternatives.length, 2);
  assert.equal(security.alternatives[0]?.schemes.length, 0);
  assert.equal(security.anonymous, true);
  // The authenticated alternative is still there; anonymity does not erase it.
  assert.deepEqual(security.alternatives[1]?.schemes[0]?.scopes, ["read"]);
});

test("a document with no security at all is not the same as an empty requirement", async () => {
  const read = await read31({
    "/none": {
      get: { operationId: "none", responses: { "200": { description: "ok" } } },
    },
  });
  const security = alternativesOf(read, "none");
  assert.equal(security.source, "none");
  assert.equal(security.alternatives.length, 0);
  assert.equal(security.anonymous, true);
});

test("OAuth scopes are preserved per requirement, not merged across alternatives", async () => {
  const read = await read31({
    "/scoped": {
      post: {
        operationId: "scoped",
        security: [{ oauth: ["write"] }, { oauth: ["read"] }],
        responses: { "200": { description: "ok" } },
      },
    },
  });
  const security = alternativesOf(read, "scoped");
  assert.deepEqual(security.alternatives[0]?.schemes[0]?.scopes, ["write"]);
  assert.deepEqual(security.alternatives[1]?.schemes[0]?.scopes, ["read"]);
});

test("api-key placement comes from the scheme, in every location the version allows", async () => {
  const read = await read31({
    "/a": {
      get: { operationId: "a", responses: { "200": { description: "ok" } } },
    },
  });
  const byId = new Map(
    read.definition.authentication.map((profile) => [profile.id, profile]),
  );
  const header = byId.get("key");
  assert.equal(header?.kind, "api-key");
  assert.equal(header.kind === "api-key" && header.placement, "header");
  assert.equal(header.kind === "api-key" && header.parameterName, "X-Api-Key");
  const query = byId.get("queryKey");
  assert.equal(query?.kind === "api-key" && query.placement, "query");
  assert.equal(query?.kind === "api-key" && query.parameterName, "api_key");
  const cookie = byId.get("cookieKey");
  assert.equal(cookie?.kind === "api-key" && cookie.placement, "cookie");
});

test("http schemes map to basic and bearer, and an unsupported scheme blocks", async () => {
  const read = await read31({
    "/a": {
      get: { operationId: "a", responses: { "200": { description: "ok" } } },
    },
  });
  const byId = new Map(
    read.definition.authentication.map((profile) => [profile.id, profile]),
  );
  assert.equal(byId.get("basic")?.kind, "http-basic");
  const bearer = byId.get("bearer");
  assert.equal(bearer?.kind, "http-bearer");
  assert.equal(bearer?.kind === "http-bearer" && bearer.format, "JWT");

  const catalog = await readFixture("openapi-3.1-catalog.json");
  const digest = catalog.definition.authentication.find(
    (profile) => profile.id === "digest",
  );
  assert.equal(digest?.kind, "unsupported");
  assert.equal(digest?.kind === "unsupported" && digest.native, "http:digest");
  const issue = catalog.issues.find(
    (item) => item.code === "security.unsupported-http-scheme",
  );
  assert.ok(issue);
  assert.equal(issue.severity, "blocking");
  assert.equal(issue.category, "security");
});

test("openIdConnect yields an issuer only from the standard well-known form", async () => {
  const read = await read31({
    "/a": {
      get: { operationId: "a", responses: { "200": { description: "ok" } } },
    },
  });
  const oidc = read.definition.authentication.find(
    (profile) => profile.id === "oidc",
  );
  assert.equal(oidc?.kind, "openid-connect");
  assert.equal(
    oidc?.kind === "openid-connect" && oidc.issuer,
    "https://id.example.test/",
  );

  const odd = await readOpenApi({
    openapi: "3.1.0",
    info: { title: "Odd", version: "1" },
    components: {
      securitySchemes: {
        oidc: {
          type: "openIdConnect",
          openIdConnectUrl: "https://id.example.test/discovery",
        },
      },
    },
    paths: {},
  });
  assert.ok(isReadResult(odd));
  // An issuer is not guessed by trimming an arbitrary path.
  assert.equal(odd.definition.authentication[0]?.kind, "unsupported");
  assert.ok(
    odd.issues.some(
      (issue) => issue.code === "security.openid-issuer-underivable",
    ),
  );
});

test("mutualTLS is preserved and blocks authorization; unknown types become unsupported", async () => {
  const read = await read31({
    "/a": {
      get: { operationId: "a", responses: { "200": { description: "ok" } } },
    },
  });
  const mtls = read.definition.authentication.find(
    (profile) => profile.id === "mtls",
  );
  assert.equal(mtls?.kind, "mutual-tls");
  const mtlsIssue = read.issues.find(
    (issue) => issue.code === "security.mutual-tls-not-executable",
  );
  assert.equal(mtlsIssue?.severity, "blocking");
  assert.equal(mtlsIssue?.executionImpact, "blocks-authorization");

  const weird = read.definition.authentication.find(
    (profile) => profile.id === "weird",
  );
  assert.equal(weird?.kind, "unsupported");
  // The native spelling survives for review; nothing executable is invented.
  assert.equal(
    weird?.kind === "unsupported" && weird.native,
    "quantumHandshake",
  );
  assert.ok(
    read.issues.some((issue) => issue.code === "security.unsupported-scheme"),
  );
});

test("3.x has no device flow: only 3.2 reads deviceAuthorization, and 3.1 refuses it", async () => {
  const fleet = await readFixture("openapi-3.2-fleet.json");
  const device = fleet.definition.authentication.find(
    (profile) => profile.id === "deviceOauth",
  );
  assert.equal(device?.kind, "oauth-device");
  assert.equal(
    device?.kind === "oauth-device" && device.deviceAuthorizationEndpoint,
    "https://auth.example.test/device",
  );
  assert.deepEqual(device?.kind === "oauth-device" ? device.scopes : [], [
    "fleet:read",
    "fleet:write",
  ]);

  // The same scheme under 3.1, where the flow does not exist, is not invented.
  const as31 = await readOpenApi({
    openapi: "3.1.0",
    info: { title: "No device flow", version: "1" },
    components: {
      securitySchemes: {
        device: {
          type: "oauth2",
          flows: {
            deviceAuthorization: {
              deviceAuthorizationUrl: "https://auth.example.test/device",
              tokenUrl: "https://auth.example.test/token",
              scopes: {},
            },
          },
        },
      },
    },
    paths: {},
  });
  assert.ok(isReadResult(as31));
  assert.equal(as31.definition.authentication[0]?.kind, "unsupported");
  const issue = as31.issues.find(
    (item) => item.code === "security.unknown-flow",
  );
  assert.equal(issue?.severity, "blocking");
});

test("implicit and password flows are preserved as unsupported with blocking issues", async () => {
  const billing = await readFixture("openapi-3.0-billing.json");
  const password = billing.definition.authentication.find(
    (profile) => profile.id === "oauth.password",
  );
  assert.equal(password?.kind, "unsupported");
  assert.equal(
    password?.kind === "unsupported" && password.native,
    "oauth2:password",
  );
  const issue = billing.issues.find(
    (item) => item.code === "security.unsupported-flow",
  );
  assert.equal(issue?.severity, "blocking");
  assert.equal(issue?.disposition, "unsupported");

  const inventory = await readFixture("swagger-2.0-inventory.json");
  const implicit = inventory.definition.authentication.find(
    (profile) => profile.id === "implicit_oauth",
  );
  assert.equal(implicit?.kind, "unsupported");
  // No usable credential is invented for a flow the runtime will not perform.
  assert.ok(
    !inventory.definition.authentication.some(
      (profile) =>
        profile.id === "implicit_oauth" && profile.kind !== "unsupported",
    ),
  );
});

test("Swagger 2.0 flow names map to their 3.x spelling without changing meaning", async () => {
  const read = await readFixture("swagger-2.0-inventory.json");
  const legacy = read.definition.authentication.find(
    (profile) => profile.id === "legacy_oauth",
  );
  assert.equal(legacy?.kind, "oauth-authorization-code");
  assert.equal(
    legacy?.kind === "oauth-authorization-code" && legacy.authorizationEndpoint,
    "https://auth.example.test/authorize",
  );
  assert.deepEqual(
    legacy?.kind === "oauth-authorization-code" ? legacy.scopes : [],
    ["inventory:read", "inventory:write"],
  );
});

test("one oauth2 scheme with several flows yields one profile per flow", async () => {
  const read = await readFixture("openapi-3.0-billing.json");
  const ids = read.definition.authentication.map((profile) => profile.id);
  assert.ok(ids.includes("oauth.authorizationCode"));
  assert.ok(ids.includes("oauth.clientCredentials"));
  assert.ok(ids.includes("oauth.password"));
  const requirement = securityRequirementsFor(
    read.operations.find((item) => item.nativeId === "createInvoice")!,
  );
  // The requirement names the scheme; every flow of it can satisfy that name.
  assert.deepEqual(requirement.alternatives[0]?.schemes[0]?.profileIds.sort(), [
    "oauth.authorizationCode",
    "oauth.clientCredentials",
    "oauth.password",
  ]);
});

test("a requirement naming an undeclared scheme is blocking and satisfies nothing", async () => {
  const read = await read31({
    "/ghost": {
      get: {
        operationId: "ghost",
        security: [{ nonexistent: [] }],
        responses: { "200": { description: "ok" } },
      },
    },
  });
  const security = alternativesOf(read, "ghost");
  assert.equal(security.alternatives[0]?.schemes[0]?.known, false);
  assert.deepEqual(security.executableAlternatives, []);
  assert.equal(security.anonymous, false);
  const issue = read.issues.find(
    (item) => item.code === "security.unknown-scheme",
  );
  assert.equal(issue?.severity, "blocking");
  assert.equal(issue?.executionImpact, "blocks-operation");
  // The requirement is not dropped: dropping it would widen access.
  assert.equal(security.alternatives.length, 1);
});

test("every capability lists only authentication profiles the definition declares", async () => {
  for (const name of [
    "swagger-2.0-inventory.json",
    "openapi-3.0-billing.json",
    "openapi-3.1-catalog.json",
    "openapi-3.2-fleet.json",
  ]) {
    const read = await readFixture(name);
    const declared = new Set(
      read.definition.authentication.map((profile) => profile.id),
    );
    for (const capability of read.definition.capabilities)
      for (const id of capability.authentication ?? [])
        assert.ok(
          declared.has(id),
          `${name}: ${capability.nativeId} names unknown profile ${id}`,
        );
  }
});

test("an unsupported security requirement is blocking under the contract, never informational", async () => {
  const read = await readFixture("openapi-3.1-catalog.json");
  for (const issue of read.issues)
    if (
      issue.category === "security" &&
      (issue.disposition === "unsupported" || issue.disposition === "rejected")
    )
      assert.equal(
        issue.severity,
        "blocking",
        `${issue.code} was not blocking`,
      );
});
