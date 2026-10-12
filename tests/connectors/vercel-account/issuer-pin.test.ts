import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  issuerPolicy,
  resolveAuthorizationServer,
} from "../../../src/server/connectors/auth/index.js";
import { ConnectorError } from "../../../src/server/connectors/errors.js";
import { vercelAccountIssuerPolicy } from "../../../src/server/connectors/providers/vercel-account/index.js";

/*
 * The policy a host pins for the real Vercel names one origin besides the
 * issuer's own: api.vercel.com. That pin only holds if an issuer document
 * cannot name another. These tests resolve documents through the helper's own
 * output, with no knob set by the test, so they fail if the helper stops
 * pinning.
 */

const recorded = JSON.parse(
  readFileSync(
    new URL("../fixtures/vercel/openid-configuration.json", import.meta.url),
    "utf8",
  ),
) as Record<string, unknown>;

const serving =
  (document: Record<string, unknown>): typeof fetch =>
  async (input) => {
    const url = input instanceof Request ? input.url : String(input);
    if (url === "https://vercel.com/.well-known/openid-configuration")
      return new Response(JSON.stringify(document), {
        headers: { "content-type": "application/json" },
      });
    return new Response("not found", { status: 404 });
  };

const hijacked = (member: string) => ({
  ...recorded,
  [member]: "https://attacker.example/login/oauth/endpoint",
});

test("the pinned Vercel policy refuses an issuer document that moves the token endpoint to another origin", async () => {
  await assert.rejects(
    resolveAuthorizationServer(issuerPolicy(vercelAccountIssuerPolicy()), {
      fetch: serving(hijacked("token_endpoint")),
    }),
    (error: unknown) =>
      error instanceof ConnectorError &&
      error.code === "network-policy" &&
      error.detail === "oauth.endpoint.token.foreign-origin",
  );
});

test("the pinned Vercel policy refuses an issuer document that moves the authorization endpoint to another origin", async () => {
  await assert.rejects(
    resolveAuthorizationServer(issuerPolicy(vercelAccountIssuerPolicy()), {
      fetch: serving(hijacked("authorization_endpoint")),
    }),
    (error: unknown) =>
      error instanceof ConnectorError &&
      error.code === "network-policy" &&
      error.detail === "oauth.endpoint.authorization.foreign-origin",
  );
});

/*
 * The other endpoints are not fatal: resolution removes the one that moved and
 * records why, so a caller finds it missing and never has it to contact.
 */
for (const [role, member] of [
  ["device-authorization", "device_authorization_endpoint"],
  ["revocation", "revocation_endpoint"],
  ["introspection", "introspection_endpoint"],
  ["registration", "registration_endpoint"],
] as const)
  test(`the pinned Vercel policy removes the ${role} endpoint when an issuer document moves it to another origin`, async () => {
    assert.ok(recorded[member], "the recorded document declares this endpoint");
    const server = await resolveAuthorizationServer(
      issuerPolicy(vercelAccountIssuerPolicy()),
      { fetch: serving(hijacked(member)) },
    );
    assert.equal(
      (server.metadata as Record<string, unknown>)[member],
      undefined,
      "the moved endpoint is not in the resolved metadata",
    );
    assert.deepEqual(server.refused, [
      { role, detail: `oauth.endpoint.${role}.foreign-origin` },
    ]);
    assert.ok(
      !JSON.stringify(server.metadata).includes("attacker.example"),
      "no member of the resolved metadata names the other origin",
    );
  });

test("the pinned Vercel policy does not accept origins an issuer declares for itself", () => {
  const policy = issuerPolicy(vercelAccountIssuerPolicy());
  assert.equal(policy.acceptIssuerDeclaredOrigins, false);
  assert.deepEqual(policy.trustedOrigins, ["https://api.vercel.com"]);
});

test("the pinned Vercel policy still accepts the origin it names", async () => {
  const server = await resolveAuthorizationServer(
    issuerPolicy(vercelAccountIssuerPolicy()),
    { fetch: serving(recorded) },
  );
  assert.equal(
    server.metadata.token_endpoint,
    "https://api.vercel.com/login/oauth/token",
  );
  assert.deepEqual(server.refused, []);
});
