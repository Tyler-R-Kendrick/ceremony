import assert from "node:assert/strict";
import { test } from "node:test";
import {
  applyOverlay,
  diffOverlay,
} from "../../../src/server/connectors/formats/overlay/index.js";

/*
 * HTTP-05 / AC-IMP-06: the security diff. A transformation is structural; it
 * cannot approve an endpoint, move a credential, change an issuer or widen a
 * grant. Whenever it does one of those things, the diff says so and the
 * approval granted against the previous document is no longer reusable.
 */

const document = () => ({
  openapi: "3.1.0",
  info: { title: "Approved", version: "1.0.0" },
  servers: [{ url: "https://approved.example.test" }],
  security: [{ oauth: ["read"] }],
  paths: {
    "/items": {
      get: {
        operationId: "listItems",
        parameters: [{ name: "token", in: "header", schema: { type: "string" } }],
        responses: { "200": { description: "ok" } },
      },
    },
  },
  components: {
    securitySchemes: {
      oauth: {
        type: "oauth2",
        flows: {
          authorizationCode: {
            authorizationUrl: "https://auth.example.test/authorize",
            tokenUrl: "https://auth.example.test/token",
            scopes: { read: "Read" },
          },
        },
      },
    },
  },
});

const overlay = (actions: unknown[]) => ({
  overlay: "1.1.0",
  info: { title: "Change", version: "1.0.0" },
  actions,
});

/** Applies an overlay and diffs the result against the document it started from. */
function transform(actions: unknown[]) {
  const before = document();
  const applied = applyOverlay(before, overlay(actions));
  assert.equal(applied.applied, true, "the overlay under test must apply");
  return { ...diffOverlay(before, applied.document), after: applied.document };
}

const kinds = (result: { changes: Array<{ kind: string }> }) =>
  result.changes.map((change) => change.kind);

test("an unchanged document produces no changes and keeps the approval", () => {
  const result = diffOverlay(document(), document());
  assert.deepEqual(result.changes, []);
  assert.equal(result.securityAffected, false);
  assert.equal(result.approvalReusable, true);
});

test("an overlay that adds a server is flagged security and invalidates the approval", () => {
  const result = transform([
    { target: "$.servers", update: [{ url: "https://attacker.example.test" }] },
  ]);
  assert.ok(kinds(result).includes("server-added"));
  const change = result.changes.find((item) => item.kind === "server-added");
  assert.equal(change?.category, "security");
  assert.equal(change?.security, true);
  assert.equal(result.securityAffected, true);
  assert.equal(result.approvalReusable, false);
  const issue = result.issues.find((item) => item.code === "security.server-added");
  assert.equal(issue?.severity, "blocking");
  assert.equal(issue?.executionImpact, "blocks-operation");
});

test("an overlay that widens a scope is flagged security", () => {
  const result = transform([
    {
      target: "$.components.securitySchemes.oauth.flows.authorizationCode.scopes",
      update: { write: "Write", admin: "Everything" },
    },
  ]);
  assert.ok(kinds(result).includes("scope-widened"));
  assert.equal(result.approvalReusable, false);
  const change = result.changes.find((item) => item.kind === "scope-widened");
  assert.equal(change?.category, "security");
  assert.ok(change?.detail.includes("cannot expand grant authority"));
});

test("narrowing a scope is reported but does not invalidate the approval", () => {
  const before = document();
  const after = document();
  after.components.securitySchemes.oauth.flows.authorizationCode.scopes = {} as Record<
    string,
    string
  >;
  const result = diffOverlay(before, after);
  assert.ok(kinds(result).includes("scope-narrowed"));
  assert.equal(result.securityAffected, false);
  assert.equal(result.approvalReusable, true);
});

test("an overlay that moves a parameter to the query is flagged security", () => {
  const result = transform([
    { target: "$.paths['/items'].get.parameters[0].in", update: "query" },
  ]);
  const change = result.changes.find((item) => item.kind === "parameter-location-changed");
  assert.ok(change);
  assert.equal(change.security, true);
  assert.equal(change.category, "security");
  // The message names both locations so a reviewer sees the move.
  assert.ok(change.detail.includes("header"));
  assert.ok(change.detail.includes("query"));
  assert.equal(result.approvalReusable, false);
});

test("an overlay that changes an issuer or token endpoint is flagged security", () => {
  const authorization = transform([
    {
      target: "$.components.securitySchemes.oauth.flows.authorizationCode.authorizationUrl",
      update: "https://evil.example.test/authorize",
    },
  ]);
  assert.ok(kinds(authorization).includes("issuer-changed"));
  assert.equal(authorization.approvalReusable, false);

  const tokenEndpoint = transform([
    {
      target: "$.components.securitySchemes.oauth.flows.authorizationCode.tokenUrl",
      update: "https://evil.example.test/token",
    },
  ]);
  assert.ok(kinds(tokenEndpoint).includes("issuer-changed"));
});

test("an overlay that changes a security requirement is flagged security", () => {
  const operationLevel = transform([
    { target: "$.paths['/items'].get", update: { security: [{}] } },
  ]);
  assert.ok(kinds(operationLevel).includes("security-requirement-changed"));
  assert.equal(operationLevel.approvalReusable, false);

  // Changing the document default affects every operation that inherits it.
  const before = document();
  const after = document();
  after.security = [] as Array<Record<string, string[]>>;
  const documentLevel = diffOverlay(before, after);
  assert.ok(kinds(documentLevel).includes("security-requirement-changed"));
  assert.equal(documentLevel.approvalReusable, false);
});

test("an overlay that adds an operation is flagged security", () => {
  const result = transform([
    {
      target: "$.paths",
      update: {
        "/admin": { post: { operationId: "escalate", responses: { "200": { description: "ok" } } } },
      },
    },
  ]);
  assert.ok(kinds(result).includes("operation-added"));
  const change = result.changes.find((item) => item.kind === "operation-added");
  assert.ok(change?.detail.includes("cannot approve an endpoint"));
  assert.equal(result.approvalReusable, false);
});

test("an overlay that changes a security scheme's placement is flagged security", () => {
  const before = document();
  const after = document();
  (after.components.securitySchemes as Record<string, unknown>).apiKey = {
    type: "apiKey",
    name: "X-Key",
    in: "header",
  };
  const added = diffOverlay(before, after);
  assert.ok(kinds(added).includes("security-scheme-added"));
  assert.equal(added.approvalReusable, false);

  const moved = document();
  (moved.components.securitySchemes as Record<string, unknown>).oauth = {
    type: "apiKey",
    name: "X-Key",
    in: "query",
  };
  const changed = diffOverlay(before, moved);
  assert.ok(kinds(changed).includes("security-scheme-changed"));
  assert.equal(changed.approvalReusable, false);
});

test("removing a security scheme an operation relies on is flagged security", () => {
  const before = document();
  const after = document();
  after.components.securitySchemes = {} as typeof after.components.securitySchemes;
  const result = diffOverlay(before, after);
  assert.ok(kinds(result).includes("security-scheme-changed"));
  assert.equal(result.approvalReusable, false);
});

test("cosmetic changes are reported without invalidating the approval", () => {
  const result = transform([
    {
      target: "$.paths['/items'].get",
      update: { summary: "A nicer summary", description: "More words", tags: ["items"] },
    },
  ]);
  assert.equal(result.securityAffected, false);
  assert.equal(result.approvalReusable, true);
  for (const issue of result.issues) assert.notEqual(issue.severity, "blocking");
});

test("adding a query or header parameter is a security change; removing one is not", () => {
  const added = transform([
    {
      target: "$.paths['/items'].get.parameters",
      update: [{ name: "impersonate", in: "query", schema: { type: "string" } }],
    },
  ]);
  assert.ok(kinds(added).includes("parameter-added"));
  assert.equal(added.approvalReusable, false);

  const removed = transform([
    { target: "$.paths['/items'].get.parameters[0]", remove: true },
  ]);
  assert.ok(kinds(removed).includes("parameter-removed"));
  assert.equal(removed.securityAffected, false);
});

test("Swagger 2.0 host and basePath changes are detected as server changes", () => {
  const before = {
    swagger: "2.0",
    info: { title: "Two", version: "1" },
    host: "approved.example.test",
    basePath: "/v1",
    schemes: ["https"],
    paths: {},
  };
  const after = { ...before, host: "attacker.example.test" };
  const result = diffOverlay(before, after);
  assert.ok(kinds(result).includes("server-added"));
  assert.equal(result.approvalReusable, false);
});

test("a diff over a document whose operations moved servers catches the per-operation server", () => {
  const result = transform([
    {
      target: "$.paths['/items'].get",
      update: { servers: [{ url: "https://sneaky.example.test" }] },
    },
  ]);
  assert.ok(kinds(result).includes("server-added"));
  assert.equal(result.approvalReusable, false);
});

test("the diff never echoes a document value into its messages", () => {
  const before = document();
  const after = document();
  after.servers = [{ url: "https://secret-internal-host.example.test/CANARY_SECRET_9f3" }];
  const result = diffOverlay(before, after);
  assert.ok(result.securityAffected);
  for (const change of result.changes) assert.ok(!change.detail.includes("CANARY_SECRET_9f3"));
  for (const issue of result.issues) assert.ok(!issue.message.includes("CANARY_SECRET_9f3"));
});
