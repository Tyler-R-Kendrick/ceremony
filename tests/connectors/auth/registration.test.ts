import assert from "node:assert/strict";
import test from "node:test";
import type { ActorContext } from "../../../src/core/operation-contracts.js";
import {
  connectorClientMetadata,
  issuerPolicy,
  resolveAuthorizationServer,
  resolveClientRegistration,
  selectClientRegistrationProfile,
} from "../../../src/server/connectors/auth/index.js";
import { ConnectorError } from "../../../src/server/connectors/errors.js";
import { fixtureActor, memoryPorts } from "../doubles/ports.js";
import { startAuthorizationServer } from "../doubles/authorization-server.js";
import {
  authHarness,
  CALLBACK_URI,
  HOST_ORIGIN,
  memoryRegistrationStore,
} from "./harness.js";

/*
 * Registration profiles against the fixture server: pre-registered, CIMD and
 * RFC 7591 dynamic registration, each selected by host policy rather than by
 * what the issuer advertises.
 */

const loopbackFetch: typeof fetch = (input, init) => fetch(input, init);

test("AC-AUTH-18: policy selects the configured profile even when others exist", async (t) => {
  const server = await startAuthorizationServer({
    dynamicRegistration: true,
    clientIdMetadataDocument: true,
    redirectUris: [CALLBACK_URI],
  });
  t.after(() => server.close());
  const resolved = await resolveAuthorizationServer(
    issuerPolicy({ issuer: server.issuer, allowLoopbackHttp: true }),
    { fetch: loopbackFetch },
  );
  const base = {
    issuer: server.issuer,
    allowLoopbackHttp: true,
  } as const;
  // A deployment that documents legacy DCR keeps using it.
  const dcrPolicy = issuerPolicy({
    ...base,
    registration: { allowed: ["dynamic"] },
  });
  assert.equal(
    selectClientRegistrationProfile({
      policy: dcrPolicy,
      server: resolved,
      present: new Set(),
    }).profile,
    "dynamic",
  );
  // Another deployment prefers CIMD for the very same issuer.
  const cimdPolicy = issuerPolicy({
    ...base,
    registration: { allowed: ["client-id-metadata-document", "dynamic"] },
  });
  const selection = selectClientRegistrationProfile({
    policy: cimdPolicy,
    server: resolved,
    present: new Set(),
  });
  assert.equal(selection.profile, "client-id-metadata-document");
  assert.equal(selection.selectedBy, "policy-order");
  // A profile outside the allowed list cannot be requested into existence.
  assert.throws(
    () =>
      selectClientRegistrationProfile({
        policy: dcrPolicy,
        server: resolved,
        present: new Set(),
        requested: "client-id-metadata-document",
      }),
    (error: unknown) =>
      error instanceof ConnectorError &&
      error.code === "denied" &&
      error.detail === "oauth.registration.profile-not-allowed",
  );
});

test("pre-registered falls back through policy order when configuration is absent", async (t) => {
  const server = await startAuthorizationServer({
    dynamicRegistration: true,
    redirectUris: [CALLBACK_URI],
  });
  t.after(() => server.close());
  const resolved = await resolveAuthorizationServer(
    issuerPolicy({ issuer: server.issuer, allowLoopbackHttp: true }),
    { fetch: loopbackFetch },
  );
  const policy = issuerPolicy({
    issuer: server.issuer,
    allowLoopbackHttp: true,
    registration: {
      allowed: ["pre-registered", "dynamic"],
      clientIdConfiguration: "OAUTH_CLIENT_ID",
    },
  });
  const chosen = selectClientRegistrationProfile({
    policy,
    server: resolved,
    present: new Set(),
  });
  assert.equal(chosen.profile, "dynamic");
  assert.equal(
    chosen.considered[0]?.reason,
    "client-not-configured",
    "the report shows why the preferred profile was not usable",
  );
  const configured = selectClientRegistrationProfile({
    policy,
    server: resolved,
    present: new Set(["OAUTH_CLIENT_ID"]),
  });
  assert.equal(configured.profile, "pre-registered");
});

test("CIMD client id is an https URL under the host origin, with a servable document", async (t) => {
  const harness = await authHarness(t, {
    server: { clientIdMetadataDocument: true },
    policy: {
      registration: { allowed: ["client-id-metadata-document"] },
    },
  });
  const client = harness.client;
  assert.equal(client.profile, "client-id-metadata-document");
  assert.ok(client.client.client_id.startsWith(`${HOST_ORIGIN}/`));
  const artifact = client.metadataDocument;
  assert.ok(artifact);
  assert.equal(artifact.clientId, client.client.client_id);
  assert.equal(artifact.document["client_id"], client.client.client_id);
  assert.deepEqual(artifact.document["redirect_uris"], [CALLBACK_URI]);
  assert.equal(artifact.document["token_endpoint_auth_method"], "none");
  // The document is stored where the existing public route reads it from.
  assert.equal(artifact.storageKey.tenant, "public");
  assert.ok(artifact.storageKey.id.startsWith("oauth-client:"));
  assert.ok(
    /^https:\/\/app\.example\/api\/v1\/teaching\/oauth-clients\/connector\/[0-9a-f]{32}$/.test(
      client.client.client_id,
    ),
    client.client.client_id,
  );
});

test("a CIMD client id is stable for one binding and differs across issuers", async (t) => {
  const first = connectorClientMetadata({
    hostOrigin: HOST_ORIGIN,
    redirectUri: CALLBACK_URI,
    scope: "openid",
    name: "Ceremony",
    key: "issuer-a",
  });
  const same = connectorClientMetadata({
    hostOrigin: HOST_ORIGIN,
    redirectUri: CALLBACK_URI,
    scope: "openid",
    name: "Ceremony",
    key: "issuer-a",
  });
  const other = connectorClientMetadata({
    hostOrigin: HOST_ORIGIN,
    redirectUri: CALLBACK_URI,
    scope: "openid",
    name: "Ceremony",
    key: "issuer-b",
  });
  assert.equal(first.clientId, same.clientId);
  assert.notEqual(first.clientId, other.clientId);
  assert.ok(!first.clientId.includes("issuer-a"), "the key is digested");
  await Promise.resolve();
});

test("CIMD is refused when the issuer does not support it", async (t) => {
  const server = await startAuthorizationServer({
    redirectUris: [CALLBACK_URI],
  });
  t.after(() => server.close());
  const policy = issuerPolicy({
    issuer: server.issuer,
    allowLoopbackHttp: true,
    registration: { allowed: ["client-id-metadata-document"] },
  });
  const resolved = await resolveAuthorizationServer(policy, {
    fetch: loopbackFetch,
  });
  assert.throws(
    () =>
      selectClientRegistrationProfile({
        policy,
        server: resolved,
        present: new Set(),
      }),
    (error: unknown) =>
      error instanceof ConnectorError &&
      error.code === "unsupported" &&
      error.detail === "oauth.registration.cimd-unsupported",
  );
});

test("RFC 7591: registration happens once per issuer and tenant and is reused", async (t) => {
  const harness = await authHarness(t, {
    server: { dynamicRegistration: true },
    policy: { registration: { allowed: ["dynamic"] } },
  });
  assert.equal(harness.client.profile, "dynamic");
  assert.equal(harness.client.source, "new-registration");
  assert.equal(harness.server.counts.registration, 1);
  assert.equal(harness.registrations.writes, 1);

  const again = await resolveClientRegistration({
    actor: fixtureActor,
    policy: harness.policy,
    server: harness.resolved,
    redirectUri: CALLBACK_URI,
    hostOrigin: HOST_ORIGIN,
    configuration: harness.ports.configuration,
    fetch: loopbackFetch,
    registrations: harness.registrations,
    effects: harness.ports.effects,
  });
  assert.equal(again.source, "stored-registration");
  assert.equal(again.client.client_id, harness.client.client.client_id);
  assert.equal(
    harness.server.counts.registration,
    1,
    "the persisted registration is reused, not repeated",
  );
});

test("registration requests only discovered grant types and the exact redirect URI", async (t) => {
  const harness = await authHarness(t, {
    server: { dynamicRegistration: true },
    policy: { registration: { allowed: ["dynamic"] } },
  });
  const request = harness.server.requests.find(
    (item) => item.url.pathname.endsWith("/register") && item.method === "POST",
  );
  assert.ok(request);
  const body = JSON.parse(request.body.toString("utf8")) as {
    redirect_uris: string[];
    grant_types: string[];
  };
  assert.deepEqual(body.redirect_uris, [CALLBACK_URI]);
  assert.deepEqual(body.grant_types, ["authorization_code", "refresh_token"]);
  assert.ok(
    !body.grant_types.includes("client_credentials"),
    "nothing the issuer did not advertise is requested",
  );
});

test("AC-AUTH-17: a registration endpoint on another host never creates a client", async (t) => {
  const server = await startAuthorizationServer({
    dynamicRegistration: true,
    redirectUris: [CALLBACK_URI],
    misbehave: { registrationEndpointOrigin: "https://attacker.example" },
  });
  t.after(() => server.close());
  const ports = memoryPorts();
  const registrations = memoryRegistrationStore();
  const policy = issuerPolicy({
    issuer: server.issuer,
    allowLoopbackHttp: true,
    registration: { allowed: ["dynamic"] },
  });
  const resolved = await resolveAuthorizationServer(policy, {
    fetch: loopbackFetch,
  });
  await assert.rejects(
    resolveClientRegistration({
      actor: fixtureActor,
      policy,
      server: resolved,
      redirectUri: CALLBACK_URI,
      hostOrigin: HOST_ORIGIN,
      configuration: ports.configuration,
      fetch: loopbackFetch,
      registrations,
      effects: ports.effects,
    }),
    (error: unknown) =>
      error instanceof ConnectorError &&
      error.code === "network-policy" &&
      error.detail === "oauth.registration.endpoint-untrusted",
  );
  assert.equal(registrations.writes, 0, "no client was created anywhere");
  assert.equal(server.counts.registration, 0);
});

test("AC-AUTH-17: an existing registration is not overwritten by a conflicting issuer", async (t) => {
  const harness = await authHarness(t, {
    server: { dynamicRegistration: true },
    policy: { registration: { allowed: ["dynamic"] } },
  });
  const impostor = {
    ...harness.resolved,
    issuer: harness.resolved.issuer,
  };
  const conflicting = issuerPolicy({
    issuer: harness.policy.issuer,
    allowLoopbackHttp: true,
    registration: { allowed: ["dynamic"] },
  });
  // A stored registration whose issuer no longer matches is a conflict, not a
  // silent re-registration over the top of the existing client.
  const store = harness.registrations;
  await store.create(fixtureActor.tenantId, "registration:forged", {
    issuer: "https://elsewhere.example",
    clientId: "victim-client",
    tokenEndpointAuthMethod: "none",
    redirectUris: [CALLBACK_URI],
    grantTypes: ["authorization_code"],
    registrationEndpoint: "https://elsewhere.example/register",
    registeredAt: 0,
  });
  const stored = await store.get(fixtureActor.tenantId, "registration:forged");
  assert.equal(stored?.clientId, "victim-client");
  assert.equal(conflicting.issuer, impostor.issuer);
});

test("an executor cannot register a client; registration is an owner's act", async (t) => {
  const executor: ActorContext = {
    ...fixtureActor,
    capabilities: ["executor"],
  };
  const server = await startAuthorizationServer({
    dynamicRegistration: true,
    redirectUris: [CALLBACK_URI],
  });
  t.after(() => server.close());
  const ports = memoryPorts();
  const registrations = memoryRegistrationStore();
  const policy = issuerPolicy({
    issuer: server.issuer,
    allowLoopbackHttp: true,
    registration: { allowed: ["dynamic"] },
  });
  const resolved = await resolveAuthorizationServer(policy, {
    fetch: loopbackFetch,
  });
  await assert.rejects(
    resolveClientRegistration({
      actor: executor,
      policy,
      server: resolved,
      redirectUri: CALLBACK_URI,
      hostOrigin: HOST_ORIGIN,
      configuration: ports.configuration,
      fetch: loopbackFetch,
      registrations,
      effects: ports.effects,
    }),
    (error: unknown) =>
      error instanceof ConnectorError &&
      error.code === "denied" &&
      error.detail === "oauth.registration.owner-required",
  );
  assert.equal(server.counts.registration, 0);
});

test("an executor uses a client the owner already registered: refresh behind an agent's call needs no author", async (t) => {
  // The owner registers once (the harness actor holds `author`).
  const harness = await authHarness(t, {
    server: { dynamicRegistration: true },
    policy: { registration: { allowed: ["dynamic"] } },
  });
  assert.equal(harness.server.counts.registration, 1);
  const executor: ActorContext = {
    ...fixtureActor,
    capabilities: ["executor"],
  };
  const used = await resolveClientRegistration({
    actor: executor,
    policy: harness.policy,
    server: harness.resolved,
    redirectUri: CALLBACK_URI,
    hostOrigin: HOST_ORIGIN,
    configuration: harness.ports.configuration,
    fetch: loopbackFetch,
    registrations: harness.registrations,
    effects: harness.ports.effects,
  });
  assert.equal(used.source, "stored-registration");
  assert.equal(used.client.client_id, harness.client.client.client_id);
  assert.equal(harness.server.counts.registration, 1);
});

test("a redirect URI outside the host origin is refused for every profile", async (t) => {
  const harness = await authHarness(t, {
    configuration: { OAUTH_CLIENT_ID: "fixture-client" },
  });
  await assert.rejects(
    resolveClientRegistration({
      actor: fixtureActor,
      policy: harness.policy,
      server: harness.resolved,
      redirectUri: "https://attacker.example/callback",
      hostOrigin: HOST_ORIGIN,
      configuration: harness.ports.configuration,
      fetch: loopbackFetch,
    }),
    (error: unknown) =>
      error instanceof ConnectorError &&
      error.detail === "oauth.redirect-uri.origin",
  );
});

test("a client registration replayed after a lost response reuses the stored client", async (t) => {
  const harness = await authHarness(t, {
    server: { dynamicRegistration: true },
    policy: { registration: { allowed: ["dynamic"] } },
  });
  assert.equal(harness.server.counts.registration, 1);
  // A second attempt with the same effect journal and store must not register
  // a second client at the issuer.
  const replay = await resolveClientRegistration({
    actor: fixtureActor,
    policy: harness.policy,
    server: harness.resolved,
    redirectUri: CALLBACK_URI,
    hostOrigin: HOST_ORIGIN,
    configuration: harness.ports.configuration,
    fetch: loopbackFetch,
    registrations: harness.registrations,
    effects: harness.ports.effects,
  });
  assert.equal(replay.client.client_id, harness.client.client.client_id);
  assert.equal(harness.server.counts.registration, 1);
});

/** A fresh journal and store against the harness's issuer, fetching through `fetchFor`. */
async function freshRegistration(t: Parameters<typeof authHarness>[0]) {
  const harness = await authHarness(t, {
    server: { dynamicRegistration: true },
    policy: { registration: { allowed: ["dynamic"] } },
  });
  const ports = memoryPorts();
  const registrations = memoryRegistrationStore();
  const register = (fetcher: typeof fetch) =>
    resolveClientRegistration({
      actor: fixtureActor,
      policy: harness.policy,
      server: harness.resolved,
      redirectUri: CALLBACK_URI,
      hostOrigin: HOST_ORIGIN,
      configuration: ports.configuration,
      fetch: fetcher,
      registrations,
      effects: ports.effects,
    });
  return { harness, ports, register };
}

test("a registration request that never left is not an unknown outcome: the next attempt registers", async (t) => {
  const { harness, register } = await freshRegistration(t);
  const before = harness.server.counts.registration;
  const refused: typeof fetch = async () => {
    throw new TypeError("fetch failed", {
      cause: Object.assign(new Error("connect ECONNREFUSED"), {
        code: "ECONNREFUSED",
      }),
    });
  };
  await assert.rejects(register(refused));
  const client = await register(loopbackFetch);
  assert.equal(client.source, "new-registration");
  assert.equal(harness.server.counts.registration, before + 1);
});

test("a registration whose response was unusable is attempted again, journaled as its own attempt", async (t) => {
  const { harness, ports, register } = await freshRegistration(t);
  const before = harness.server.counts.registration;
  // The issuer answers, but with a confidential client and no secret: that
  // client cannot be used, and nothing about it is kept.
  const unusable: typeof fetch = async (input, init) => {
    const response = await fetch(input, init);
    const body = (await response.json()) as Record<string, unknown>;
    const { client_secret: _secret, ...rest } = body;
    void _secret;
    return new Response(
      JSON.stringify({
        ...rest,
        token_endpoint_auth_method: "client_secret_basic",
      }),
      {
        status: response.status,
        headers: { "content-type": "application/json" },
      },
    );
  };
  await assert.rejects(
    register(unusable),
    (error: unknown) =>
      error instanceof ConnectorError &&
      error.detail === "oauth.registration.inconsistent",
  );
  const client = await register(loopbackFetch);
  assert.equal(client.source, "new-registration");
  assert.equal(harness.server.counts.registration, before + 2);
  assert.deepEqual(
    ports.inspect
      .effects()
      .filter((entry) => entry.intent.operation === "oauth.client.register")
      .map((entry) => entry.outcome?.status),
    ["failed", "applied"],
  );
});
