import assert from "node:assert/strict";
import test from "node:test";
import { verificationClaimSchema } from "../../../src/core/connectors/index.js";
import { ConnectorError } from "../../../src/server/connectors/errors.js";
import { createMicrosoftCustomConnectorAdapter } from "../../../src/server/connectors/formats/microsoft/adapter.js";
import {
  readCustomConnector,
  TEST_CONNECTION_LIMITATIONS,
} from "../../../src/server/connectors/formats/microsoft/read.js";
import { startHttpFixture } from "../doubles/http-fixture.js";
import {
  actorFor,
  adapterContext,
  buildMicrosoftBinding,
  connectedPrincipal,
  portsWithFetch,
  readFixtureConnector,
  swaggerFixture,
} from "./support.js";

/*
 * MS-03 and AC-EXT-11. `x-ms-capabilities.testConnection` names an operation
 * whose success proves exactly one thing: the provider accepted the credential
 * this connection holds. It names no account and observes no permission, and
 * the claim must not quietly become either.
 */

const CONNECTOR_ID = "contoso-projects-9f21";

async function verifyHarness(
  handler: Parameters<typeof startHttpFixture>[0],
  options: { withVerifier?: boolean } = {},
) {
  const read = await readFixtureConnector();
  const fixture = await startHttpFixture(handler);
  const { ports, environment } = portsWithFetch(fixture.origin);
  assert.ok(read.verifierOperation, "the fixture offers a verifier candidate");
  const binding = buildMicrosoftBinding({
    origin: fixture.origin,
    pathPrefix: "/v1",
    operations: [read.verifierOperation],
    connectorId: CONNECTOR_ID,
    ...(options.withVerifier === false
      ? {}
      : {
          verifier: {
            operationRef: read.verifierOperation.operationRef,
            operationId: read.verifierCandidate?.operationId ?? "WhoAmI",
          },
        }),
    authentication: {
      kind: "api-key",
      placement: "header",
      parameterName: "X-Api-Key",
    },
  });
  const actor = actorFor("tenant-a", "subject-1");
  const connection = await connectedPrincipal({
    ports,
    binding,
    actor,
    apiKey: "key-for-subject-1",
  });
  return {
    read,
    fixture,
    adapter: createMicrosoftCustomConnectorAdapter(),
    ctx: adapterContext({ actor, binding, connection, environment }),
  };
}

test("testConnection is offered as a verifier candidate that requires host review", async () => {
  const read = await readFixtureConnector();
  const candidate = read.verifierCandidate;
  assert.ok(
    candidate,
    "the document declares x-ms-capabilities.testConnection",
  );
  assert.equal(candidate?.operationId, "WhoAmI");
  assert.equal(candidate?.sourcePointer, "#/x-ms-capabilities/testConnection");
  assert.equal(candidate?.requiresHostReview, true);
  assert.equal(candidate?.resolved, true);
  assert.deepEqual(candidate?.limitations, [...TEST_CONNECTION_LIMITATIONS]);

  // Importing offers a candidate; it does not approve one.
  const issue = read.issues.find(
    (item) => item.code === "identity.test-connection-candidate",
  );
  assert.equal(issue?.severity, "info");
  assert.equal(issue?.disposition, "requires-configuration");
  assert.match(issue?.message ?? "", /establishes no account identity/);
  assert.equal(
    read.definition.compatibility.dimensions.verify,
    "requires-configuration",
  );

  // The compiled candidate is a read against the described path.
  assert.deepEqual(read.verifierOperation?.transport, {
    kind: "http",
    method: "GET",
    pathTemplate: "/v1/me",
  });
  assert.equal(read.verifierOperation?.effect, "read");
  assert.equal(read.verifierOperation?.replay, "read-only");
  assert.equal(read.verifierOperation?.consent, "none");
});

test("a 200 records connectivity only, never an account identity or a permission", async (t) => {
  const harness = await verifyHarness((request) =>
    request.url.pathname === "/v1/me"
      ? { body: { displayName: "Ada Lovelace", roles: ["owner"] } }
      : undefined,
  );
  t.after(() => harness.fixture.close());

  const result = await harness.adapter.verify!(harness.ctx);
  assert.equal(result.state, "complete");
  assert.equal(result.claims.length, 1);
  const claim = result.claims[0]!;

  assert.equal(claim.kind, "credential-accepted");
  // Even though the provider returned a display name and roles, the claim
  // interprets only what the operation demonstrates.
  assert.notEqual(claim.kind, "account-identity");
  assert.notEqual(claim.kind, "permission-observed");
  assert.deepEqual(claim.target, {
    kind: "custom-connector-connection",
    id: CONNECTOR_ID,
  });
  assert.deepEqual(claim.limitations, [
    "testConnection demonstrates connectivity only",
    "account identity not established",
  ]);
  // No permissions are reported, because none were observed.
  assert.equal(claim.permissions, undefined);
  assert.equal(claim.issuer, "ceremony-verifier");
  assert.equal(claim.bindingRevision, harness.ctx.binding.revision);
  assert.equal(claim.policyRevision, harness.ctx.binding.policyRevision);
  assert.doesNotThrow(() => verificationClaimSchema.parse(claim));

  // Nothing from the provider's body is carried into the claim.
  assert.ok(!JSON.stringify(claim).includes("Ada Lovelace"));
  assert.ok(!JSON.stringify(claim).includes("owner"));

  const received = harness.fixture.received("GET", "/v1/me");
  assert.equal(received.length, 1);
  assert.equal(received[0]?.headers["x-api-key"], "key-for-subject-1");
});

test("a rejected credential is denied and claims nothing", async (t) => {
  const harness = await verifyHarness(() => ({
    status: 401,
    body: { error: "invalid_api_key", hint: "rotate your key" },
  }));
  t.after(() => harness.fixture.close());
  const result = await harness.adapter.verify!(harness.ctx);
  assert.equal(result.state, "denied");
  assert.deepEqual(result.claims, []);
  assert.equal(result.code, "microsoft.verify.rejected");
  assert.ok(!JSON.stringify(result).includes("rotate your key"));
});

test("an unavailable provider leaves verification pending rather than denied", async (t) => {
  const harness = await verifyHarness(() => ({
    status: 503,
    body: { error: "down" },
  }));
  t.after(() => harness.fixture.close());
  const result = await harness.adapter.verify!(harness.ctx);
  assert.equal(result.state, "pending");
  assert.deepEqual(result.claims, []);
  assert.equal(result.code, "microsoft.verify.upstream-unavailable");
});

test("verification is refused when the host has not approved a verifier", async (t) => {
  const harness = await verifyHarness(() => ({ body: {} }), {
    withVerifier: false,
  });
  t.after(() => harness.fixture.close());
  await assert.rejects(
    harness.adapter.verify!(harness.ctx),
    (error: unknown) => {
      assert.ok(error instanceof ConnectorError);
      assert.equal(error.code, "unsupported");
      assert.equal(error.detail, "microsoft.verify.unapproved");
      return true;
    },
  );
  assert.equal(harness.fixture.requests.length, 0);
});

test("a testConnection naming an operation the document does not declare offers no candidate", async () => {
  const swagger = swaggerFixture() as Record<string, unknown>;
  (
    swagger["x-ms-capabilities"] as { testConnection: { operationId: string } }
  ).testConnection.operationId = "NoSuchOperation";
  const read = await readCustomConnector({ swagger });
  assert.equal(read.verifierCandidate, undefined);
  assert.equal(read.verifierOperation, undefined);
  const issue = read.issues.find(
    (item) => item.code === "structure.test-connection-unknown",
  );
  assert.equal(issue?.dimension, "verify");
  assert.equal(issue?.disposition, "unsupported");
  assert.equal(read.definition.compatibility.dimensions.verify, "unsupported");
});
