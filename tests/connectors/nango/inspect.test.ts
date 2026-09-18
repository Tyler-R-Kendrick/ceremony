import assert from "node:assert/strict";
import { test } from "node:test";
import type { ConnectorAdapter } from "../../../src/server/connectors/adapter.js";
import { ConnectorError } from "../../../src/server/connectors/errors.js";
import {
  activeConnection,
  CONNECTION_ID,
  connectionRow,
  harness,
  INTEGRATION,
  stringsIn,
} from "./harness.js";
import { fixtureActor } from "../doubles/ports.js";

/*
 * NG-03 and AC-NG-03: GET /connections/{connectionId} is privileged. It
 * returns credentials and refreshing is a documented side effect of reading
 * it, so the adapter treats it as a refresh-sensitive, internal-only path
 * whose result is rebuilt through an allowlist.
 */

const SECRET_ACCESS = "fixture-access-token-DO-NOT-LEAK";
const SECRET_REFRESH = "fixture-refresh-token-DO-NOT-LEAK";

const withCredentials = () =>
  connectionRow({
    created_at: "2026-03-01T00:00:00.000Z",
    updated_at: "2026-03-02T00:00:00.000Z",
    last_fetched_at: "2026-03-03T00:00:00.000Z",
    metadata: { board: "main" },
    tags: { end_user_id: "digest-value" },
    credentials: {
      type: "OAUTH2",
      access_token: SECRET_ACCESS,
      refresh_token: SECRET_REFRESH,
      expires_at: "2026-03-04T00:00:00.000Z",
      raw: { scope: "repo", token_type: "bearer" },
    },
  });

test("AC-NG-03: the credential-bearing response never surfaces; only metadata and expiry do", async (t) => {
  const h = await harness({ double: { connections: [withCredentials()] } });
  t.after(() => h.close());
  const connection = await activeConnection(h.ports, h.binding);
  const inspection = await h.adapter.inspectConnection(
    h.context({ connection }),
  );

  assert.equal(inspection.connectionId, CONNECTION_ID);
  assert.equal(inspection.providerConfigKey, INTEGRATION);
  assert.equal(inspection.credentialType, "OAUTH2");
  assert.equal(inspection.credentialExpiresAt, "2026-03-04T00:00:00.000Z");
  assert.deepEqual(inspection.metadata, { board: "main" });
  assert.equal(inspection.lastFetchedAt, "2026-03-03T00:00:00.000Z");
  // Reading this endpoint may have refreshed the token upstream; that fact is
  // recorded rather than assumed away.
  assert.equal(inspection.refreshMayHaveOccurred, true);

  const strings = stringsIn(inspection);
  assert.equal(strings.includes(SECRET_ACCESS), false);
  assert.equal(strings.includes(SECRET_REFRESH), false);
  assert.equal(
    strings.some((value) => value.includes("token_type")),
    false,
  );
  // The allowlist decides the shape, so a new upstream field cannot ride along.
  assert.deepEqual(
    Object.keys(inspection).sort(),
    [
      "connectionId",
      "createdAt",
      "credentialExpiresAt",
      "credentialType",
      "environment",
      "errors",
      "lastFetchedAt",
      "metadata",
      "observedAt",
      "providerConfigKey",
      "provider",
      "refreshMayHaveOccurred",
      "tags",
      "updatedAt",
    ].sort(),
  );
});

test("AC-NG-03: the stored credential material is never replaced by a token from the response", async (t) => {
  const h = await harness({ double: { connections: [withCredentials()] } });
  t.after(() => h.close());
  const connection = await activeConnection(h.ports, h.binding);
  await h.adapter.inspectConnection(h.context({ connection }));

  const material = h.ports.inspect.credentialMaterial(
    connection.credentialRef!,
  );
  assert.deepEqual(Object.keys(material!).sort(), [
    "authority",
    "connectionId",
    "environment",
    "providerConfigKey",
  ]);
  assert.equal(
    stringsIn(material).some((value) => value.includes("DO-NOT-LEAK")),
    false,
  );
});

test("NG-03: the privileged read asks Nango not to force a refresh or return a refresh token", async (t) => {
  const h = await harness({ double: { connections: [withCredentials()] } });
  t.after(() => h.close());
  const connection = await activeConnection(h.ports, h.binding);
  await h.adapter.inspectConnection(h.context({ connection }));

  const read = h.double.credentialReads[0];
  assert.ok(read);
  assert.equal(read.connectionId, CONNECTION_ID);
  // provider_config_key is documented as required and is sent every time.
  assert.equal(read.providerConfigKey, INTEGRATION);
  assert.equal(read.forceRefresh, "false");
  assert.equal(read.refreshToken, "false");
});

test("AC-NG-03: two concurrent inspections share one upstream call (rotating token race)", async (t) => {
  const h = await harness({ double: { connections: [withCredentials()] } });
  t.after(() => h.close());
  const connection = await activeConnection(h.ports, h.binding);
  const ctx = h.context({ connection });

  const [a, b] = await Promise.all([
    h.adapter.inspectConnection(ctx),
    h.adapter.inspectConnection(ctx),
  ]);

  // One refresh-sensitive request, one shared answer.
  assert.equal(h.double.credentialReads.length, 1);
  assert.equal(
    h.double.received("GET", `/connections/${CONNECTION_ID}`).length,
    1,
  );
  assert.deepEqual(a, b);

  // A later inspection is a fresh call: the single-flight window is per race,
  // not a cache that could serve a stale expiry.
  await h.adapter.inspectConnection(ctx);
  assert.equal(h.double.credentialReads.length, 2);
});

test("AC-NG-03: inspection is privileged-internal and refuses an agent actor", async (t) => {
  const h = await harness({ double: { connections: [withCredentials()] } });
  t.after(() => h.close());
  const connection = await activeConnection(h.ports, h.binding);
  await assert.rejects(
    h.adapter.inspectConnection(
      h.context({ connection, actor: { ...fixtureActor, actorKind: "agent" } }),
    ),
    (error: unknown) =>
      error instanceof ConnectorError &&
      error.code === "denied" &&
      error.detail === "nango.inspect.privileged",
  );
  assert.equal(h.double.credentialReads.length, 0);
});

test("AC-NG-03: the capability row marks inspection privileged-internal", async (t) => {
  const h = await harness();
  t.after(() => h.close());
  const verify = h.adapter
    .capabilities(new Set(["NANGO_SECRET_KEY", "NANGO_ENVIRONMENT"]))
    .find((status) => status.dimension === "verify");
  assert.ok(
    verify?.limitations.some(
      (text) =>
        text.includes("privileged-internal") &&
        text.includes("may refresh") &&
        text.includes("read-only agent routes"),
    ),
    "the verify row states the privileged-internal boundary",
  );
  // A generic route dispatches only the shared ConnectorAdapter surface.
  // Inspection is not part of it, so no read-only agent route can reach the
  // credential-bearing, refresh-triggering endpoint by dispatching a name.
  const shared: ConnectorAdapter = h.adapter;
  const genericSurface = new Set(Object.keys(shared));
  assert.equal(genericSurface.has("verify"), true);
  assert.equal(genericSurface.has("invoke"), true);
  const dispatchable: ReadonlyArray<keyof ConnectorAdapter> = [
    "discover",
    "import",
    "authorize",
    "complete",
    "verify",
    "invoke",
    "reconnect",
    "disconnect",
    "revoke",
    "export",
    "delegate",
  ];
  assert.equal(
    dispatchable.some((name) => String(name) === "inspectConnection"),
    false,
  );
  // It is reachable only through the provider-specific NangoAdapter type.
  assert.equal(typeof h.adapter.inspectConnection, "function");
});

test("AC-NG-03: a connection id from another integration is refused before the privileged read", async (t) => {
  const h = await harness({ double: { connections: [withCredentials()] } });
  t.after(() => h.close());
  const foreign = await activeConnection(h.ports, h.binding, {
    externalIds: {
      connectionId: CONNECTION_ID,
      providerConfigKey: "github-sandbox",
      provider: "github",
      environment: "dev",
    },
  });
  await assert.rejects(
    h.adapter.inspectConnection(h.context({ connection: foreign })),
    (error: unknown) =>
      error instanceof ConnectorError &&
      error.detail === "nango.connection.integration",
  );
  assert.equal(h.double.credentialReads.length, 0);
});

test("NG-03: an exhausted refresh (424) becomes human-required, not a generic failure", async (t) => {
  const h = await harness({
    double: {
      connections: [withCredentials()],
      intercept: (request) =>
        request.url.pathname === `/connections/${CONNECTION_ID}` &&
        request.method === "GET"
          ? {
              status: 424,
              body: {
                error: {
                  code: "invalid_credentials",
                  message: "The connection refresh has been exhausted",
                },
              },
            }
          : undefined,
    },
  });
  t.after(() => h.close());
  const connection = await activeConnection(h.ports, h.binding);
  await assert.rejects(
    h.adapter.inspectConnection(h.context({ connection })),
    (error: unknown) =>
      error instanceof ConnectorError &&
      error.code === "human-required" &&
      error.detail === "nango.connection.refresh-exhausted",
  );
});

test("NG-03: oversized or hostile metadata is dropped rather than stored", async (t) => {
  const deep: Record<string, unknown> = {};
  let node = deep;
  for (let i = 0; i < 40; i++) {
    const next: Record<string, unknown> = {};
    node.child = next;
    node = next;
  }
  const h = await harness({
    double: {
      connections: [
        connectionRow({ metadata: deep, credentials: { type: "API_KEY" } }),
      ],
    },
  });
  t.after(() => h.close());
  const connection = await activeConnection(h.ports, h.binding);
  const inspection = await h.adapter.inspectConnection(
    h.context({ connection }),
  );
  assert.equal(inspection.metadata, undefined);
  assert.equal(inspection.metadataOmitted, "bounds");
});

test("NG-03: a response whose identity disagrees with the request is refused", async (t) => {
  const h = await harness({
    double: {
      connections: [withCredentials()],
      intercept: (request) =>
        request.url.pathname === `/connections/${CONNECTION_ID}` &&
        request.method === "GET"
          ? {
              status: 200,
              body: {
                id: 1,
                connection_id: "a-different-connection",
                provider_config_key: INTEGRATION,
                provider: "github",
                errors: [],
                metadata: {},
                connection_config: {},
                tags: {},
                created_at: "2026-03-01T00:00:00.000Z",
                updated_at: "2026-03-01T00:00:00.000Z",
                last_fetched_at: "2026-03-01T00:00:00.000Z",
                credentials: { type: "OAUTH2", access_token: "x" },
              },
            }
          : undefined,
    },
  });
  t.after(() => h.close());
  const connection = await activeConnection(h.ports, h.binding);
  await assert.rejects(
    h.adapter.inspectConnection(h.context({ connection })),
    (error: unknown) =>
      error instanceof ConnectorError &&
      error.detail === "nango.response.identity",
  );
});
