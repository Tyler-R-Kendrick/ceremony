import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import * as connectors from "../../../src/server/connectors/index.js";
import { registrationKey } from "../../../src/server/connectors/auth/client.js";
import { CONNECTOR_CALLBACK_PATH } from "../../../src/server/connectors/commands/service.js";
import { ConnectorError } from "../../../src/server/connectors/errors.js";
import { createClientRegistrationStore } from "../../../src/server/connectors/state/index.js";
import { recordKinds } from "../../../src/server/persistence/index.js";
import { startAuthorizationServer } from "../doubles/authorization-server.js";
import { startHttpFixture } from "../doubles/http-fixture.js";
import { human, ORIGIN, TENANT } from "../commands/harness.js";
import { sqliteFixture } from "../fixtures/state/records.js";

/*
 * Dynamic client registrations (RFC 7591) on the durable store. A registration
 * carries the client secret the issuer returned, so it is stored under its own
 * record kind, encrypted at rest, per tenant, insert-only; and a composed
 * runtime uses this store by default, so dynamic registration works without
 * the host wiring a store of its own.
 */

const SECRET = "sec_registration_canary_7Hq2";

const record = (clientId: string) => ({
  issuer: "https://issuer.example.test",
  clientId,
  clientSecret: SECRET,
  tokenEndpointAuthMethod: "client_secret_basic" as const,
  redirectUris: [`${ORIGIN}${CONNECTOR_CALLBACK_PATH}`],
  grantTypes: ["authorization_code", "refresh_token"],
  registrationEndpoint: "https://issuer.example.test/register",
  registeredAt: 1_700_000_000_000,
  registrationAccessToken: "rat_canary_Pz81",
});

test("the registration kind is additive to the persistence kinds", () => {
  assert.ok(recordKinds.includes("connector-oauth-registration"));
  // Appended, never reordered: the kinds before it keep their positions.
  assert.equal(recordKinds.at(-1), "connector-oauth-registration");
});

test("registrations are insert-only, tenant-scoped and encrypted at rest", async (t) => {
  const database = await sqliteFixture();
  t.after(() => database.close());
  const store = createClientRegistrationStore(database.store);
  const key = registrationKey({
    issuer: "https://issuer.example.test",
    redirectUri: `${ORIGIN}${CONNECTOR_CALLBACK_PATH}`,
    hostOrigin: ORIGIN,
  });
  assert.equal(await store.get(TENANT, key), undefined);
  assert.equal(await store.create(TENANT, key, record("client-first")), true);
  // A replayed or racing registration does not replace the client the issuer knows.
  assert.equal(await store.create(TENANT, key, record("client-second")), false);
  assert.equal((await store.get(TENANT, key))?.clientId, "client-first");
  assert.equal(await store.get("tenant-other", key), undefined);
  await assert.rejects(
    store.create(TENANT, key, { ...record("x"), clientId: "" }),
    (error: unknown) =>
      error instanceof ConnectorError &&
      error.detail === "oauth.registration.record",
  );

  // Survives a reopen, and the database file never holds the secret in clear.
  const reopened = createClientRegistrationStore(await database.reopen());
  assert.equal((await reopened.get(TENANT, key))?.clientSecret, SECRET);
  const files = await Promise.all(
    [database.path, `${database.path}-wal`].map((path) =>
      readFile(path).catch(() => Buffer.alloc(0)),
    ),
  );
  for (const bytes of files)
    for (const canary of [SECRET, "rat_canary_Pz81", "client-first"])
      assert.ok(!bytes.includes(Buffer.from(canary)), `${canary} is encrypted`);
});

test("a composed runtime persists dynamic registrations in its own store by default", async (t) => {
  const database = await sqliteFixture();
  t.after(() => database.close());
  const as = await startAuthorizationServer({
    dynamicRegistration: true,
    redirectUris: [],
  });
  t.after(() => as.close());
  const api = await startHttpFixture(() => ({ status: 200, body: [] }));
  t.after(() => api.close());
  const runtime = connectors.createConnectorRuntime({
    origin: ORIGIN,
    store: database.store,
    network: {
      mode: "loopback-fixture",
      maxRedirects: 0,
      maxResponseBytes: 1024 * 1024,
      timeoutMs: 5000,
    },
    configuration: () => ({
      read: async () => undefined,
      present: async () => new Set(),
      revision: async () => "cfg:1",
    }),
  });
  const person = human();
  const imported = await runtime.service.import(person, {
    kind: "upload",
    mediaType: "application/json",
    text: JSON.stringify({
      openapi: "3.1.0",
      info: { title: "Registered", version: "1.0.0" },
      servers: [{ url: "https://registered.example.test" }],
      components: {
        securitySchemes: {
          oauth: {
            type: "oauth2",
            flows: {
              authorizationCode: {
                authorizationUrl: "https://registered.example.test/authorize",
                tokenUrl: "https://registered.example.test/token",
                scopes: { read: "Read" },
              },
            },
          },
        },
      },
      security: [{ oauth: ["read"] }],
      paths: {
        "/things": {
          get: {
            operationId: "listThings",
            responses: { "200": { description: "Things" } },
          },
        },
      },
    }),
    adapterId: "openapi-http",
  });
  const { bindingRef } = await runtime.service.approveBinding(person, {
    definitionRef: imported.definitions[0]!,
    adapterId: "openapi-http",
    approvals: {
      destinations: [api.origin],
      operations: ["listThings"],
      oauth: {
        issuer: as.issuer,
        allowLoopbackHttp: true,
        registration: { allowed: ["dynamic"] },
      },
    },
  });

  const first = await runtime.service.connect(person, { bindingRef });
  assert.equal(first.lifecycle, "authorization-required");
  assert.equal(as.counts.registration, 1);
  const stored = await runtime.ports.registrations.get(
    TENANT,
    registrationKey({
      issuer: as.issuer,
      redirectUri: `${ORIGIN}${CONNECTOR_CALLBACK_PATH}`,
      hostOrigin: ORIGIN,
    }),
  );
  assert.ok(stored?.clientId.startsWith("dcr-"));
  assert.ok(stored?.clientSecret, "the issued secret is held, encrypted");
  // Nothing a person or model sees carries it.
  assert.ok(!JSON.stringify(first).includes(stored.clientSecret!));

  // A second connection reuses the client the tenant already registered.
  await runtime.service.cancelPending(person, first.connectionRef);
  await runtime.service.connect(person, { bindingRef });
  assert.equal(as.counts.registration, 1);
});
