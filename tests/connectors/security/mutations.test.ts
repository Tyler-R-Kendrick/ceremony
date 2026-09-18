import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  agentConnectorProjection,
  connectionSummarySchema,
} from "../../../src/core/connectors/index.js";
import {
  assertHandoffCurrent,
  beginAuthorizationCode,
  completeAuthorizationCode,
  discoverAuthorizationServer,
  issueHandoff,
} from "../../../src/server/connectors/auth/index.js";
import { ConnectorError } from "../../../src/server/connectors/errors.js";
import { evaluateNetworkTarget } from "../../../src/server/connectors/import/index.js";
import { verifyNangoSignature } from "../../../src/server/connectors/providers/nango/webhooks.js";
import {
  publicServerJsonProjection,
  publicSubregistryProjection,
  serverJsonSchema,
  type RegistryIndexRow,
  type RegistrySnapshotEntry,
  type RegistrySnapshotView,
} from "../../../src/server/connectors/registries/mcp/index.js";
import { startAuthorizationServer } from "../doubles/authorization-server.js";
import {
  authHarness,
  CALLBACK_URI,
  testBinding,
  testConnection,
} from "../auth/harness.js";
import { fixtureActor, memoryPorts } from "../doubles/ports.js";
import { buildConnectionSummary } from "../fixtures/builders.js";
import { mutationOperators } from "./mutations.js";
import type {
  AdapterCallContext,
  HandoffRecord,
} from "../../../src/server/connectors/index.js";

/*
 * SEC-06. One killer per proposed mutation operator. Each test is written so
 * that removing exactly the guard named in `mutations.ts` makes it fail, and
 * nothing else in the module can make it pass by accident. The marker each
 * operator selects on is checked against the source here too, so a refactor
 * that moves a guard fails loudly instead of quietly dropping it from the
 * mutation matrix.
 */

const NOW = Date.parse("2026-09-18T12:00:00.000Z");

async function refused(work: () => Promise<unknown>): Promise<ConnectorError> {
  try {
    await work();
  } catch (error) {
    assert.ok(error instanceof ConnectorError, String(error));
    return error;
  }
  throw new Error("expected a refusal");
}

test("every proposed mutation operator still names a line in the source", async () => {
  assert.ok(mutationOperators.length >= 9);
  for (const operator of mutationOperators) {
    const source = await readFile(
      new URL(`../../../${operator.file}`, import.meta.url),
      "utf8",
    );
    const hits = source
      .split("\n")
      .filter((line) => line.includes(operator.marker)).length;
    assert.equal(
      hits,
      operator.occurrences,
      `${operator.id}: ${operator.file} no longer contains "${operator.marker}" exactly ${operator.occurrences} time(s)`,
    );
    assert.ok(operator.killedBy.length > 10, operator.id);
  }
});

test("SEC-MUT-01 removing the handoff owner check is caught", () => {
  const ports = memoryPorts({ now: () => NOW });
  const binding = testBinding();
  const connection = testConnection({ generation: 0 });
  const ctx = (actor = fixtureActor): AdapterCallContext => ({
    actor,
    binding,
    connection,
    generation: 0,
    signal: new AbortController().signal,
    environment: ports.environment({ fetch, origin: "https://app.example" }),
  });
  const record: HandoffRecord = {
    handoffRef: "handoff:1",
    kind: "provider-browser",
    presentation: "popup",
    expiresAt: NOW + 60_000,
    intent: "oauth.authorization-code",
    private: { state: "s", verifier: "v" },
    tenantId: fixtureActor.tenantId,
    subjectId: fixtureActor.subjectId,
    sessionId: fixtureActor.sessionId,
    connectionRef: connection.connectionRef,
    bindingRef: binding.bindingRef,
    generation: 0,
    state: "issued",
    issuedAt: NOW,
  };
  assert.equal(assertHandoffCurrent(ctx(), record), "open");
  // Each of the three comparisons must be load-bearing on its own.
  for (const [label, mutated] of [
    ["tenant", { ...record, tenantId: "tenant-b" }],
    ["binding", { ...record, bindingRef: "binding:other" }],
    ["connection", { ...record, connectionRef: "connection:other" }],
  ] as const)
    assert.throws(
      () => assertHandoffCurrent(ctx(), mutated),
      (error: unknown) =>
        error instanceof ConnectorError &&
        error.code === "denied" &&
        error.detail === "oauth.handoff.foreign",
      label,
    );
});

test("SEC-MUT-02 removing the callback issuer binding is caught", async (t) => {
  const harness = await authHarness(t, {
    configuration: { OAUTH_CLIENT_ID: "fixture-client" },
    server: { scopes: ["profile"] },
  });
  const ctx = harness.ctx();
  const start = await beginAuthorizationCode(ctx, {
    server: harness.resolved,
    client: harness.client,
    policy: harness.policy,
    scopes: ["profile"],
  });
  if (start.kind !== "handoff") throw new Error("unreachable");
  const issued = await issueHandoff(ctx, start.handoff);
  const record = harness.ports.inspect
    .handoffs()
    .find((item) => item.handoffRef === issued.handoffRef) as HandoffRecord;
  const callback = new URL(
    await harness.server.authorize(start.handoff.private["authorizationUrl"]!),
  );
  // Each leg of the binding is independently load-bearing.
  for (const field of ["issuer", "clientId", "redirectUri"] as const) {
    const error = await refused(() =>
      completeAuthorizationCode(ctx, {
        url: callback,
        handoff: {
          ...record,
          private: { ...record.private, [field]: "https://elsewhere.example" },
        },
        server: harness.resolved,
        client: harness.client,
        policy: harness.policy,
      }),
    );
    assert.equal(error.detail, "oauth.callback.binding-mismatch", field);
  }
  assert.deepEqual(harness.ports.inspect.credentialRefs(), []);
  assert.equal(harness.server.counts.token, 0);
});

test("SEC-MUT-03 removing the metadata issuer comparison is caught", async (t) => {
  const server = await startAuthorizationServer({
    clientId: "fixture-client",
    redirectUris: [CALLBACK_URI],
    misbehave: { issuerMismatch: "https://issuer.attacker.example" },
  });
  t.after(() => server.close());
  const error = await refused(() =>
    discoverAuthorizationServer(server.issuer, {
      fetch,
      allowLoopbackHttp: true,
    }),
  );
  assert.equal(error.detail, "oauth.metadata.issuer-mismatch");
});

test("SEC-MUT-04 removing the private-destination approval is caught", () => {
  const policy = {
    mode: "approved-private" as const,
    approvedPrivateOrigins: ["https://api.internal.example"],
    maxRedirects: 1,
    maxResponseBytes: 4096,
    timeoutMs: 1000,
  };
  for (const target of [
    "https://10.4.4.4/spec",
    "https://192.168.1.1/spec",
    "https://172.16.9.9/spec",
    "https://100.64.0.1/spec",
    "https://[fd00::1]/spec",
  ]) {
    const decision = evaluateNetworkTarget(target, policy);
    assert.equal(decision.allowed, false, target);
    assert.equal(
      decision.allowed === false && decision.detail,
      "network.private-origin-not-approved",
      target,
    );
  }
  // The approved origin still works, so the guard is the only difference.
  const approved = evaluateNetworkTarget(
    "https://api.internal.example/spec",
    policy,
  );
  assert.equal(approved.allowed, true);
  assert.equal(
    approved.allowed === true && approved.network,
    "approved-private",
  );
  // And in the default public mode nothing private is reachable at all.
  const strict = evaluateNetworkTarget("https://10.4.4.4/spec", {
    mode: "public",
    maxRedirects: 1,
    maxResponseBytes: 4096,
    timeoutMs: 1000,
  });
  assert.equal(strict.allowed, false);
});

test("SEC-MUT-05 removing the code-exchange fence is caught", async (t) => {
  const harness = await authHarness(t, {
    configuration: { OAUTH_CLIENT_ID: "fixture-client" },
    // The issuer would happily mint a second grant for the same code.
    server: { scopes: ["profile"], misbehave: { reusableCode: true } },
  });
  const ctx = harness.ctx();
  const start = await beginAuthorizationCode(ctx, {
    server: harness.resolved,
    client: harness.client,
    policy: harness.policy,
    scopes: ["profile"],
  });
  if (start.kind !== "handoff") throw new Error("unreachable");
  const issued = await issueHandoff(ctx, start.handoff);
  const record = harness.ports.inspect
    .handoffs()
    .find((item) => item.handoffRef === issued.handoffRef) as HandoffRecord;
  const callback = new URL(
    await harness.server.authorize(start.handoff.private["authorizationUrl"]!),
  );
  const first = await completeAuthorizationCode(ctx, {
    url: callback,
    handoff: record,
    server: harness.resolved,
    client: harness.client,
    policy: harness.policy,
  });
  assert.equal(first.state, "complete");
  const tokenCalls = harness.server.counts.token;
  // Reissue a handoff so nothing but the journal stands in the way.
  const second = await beginAuthorizationCode(ctx, {
    server: harness.resolved,
    client: harness.client,
    policy: harness.policy,
    scopes: ["profile"],
  });
  if (second.kind !== "handoff") throw new Error("unreachable");
  const reissued = await issueHandoff(ctx, second.handoff);
  const fresh = harness.ports.inspect
    .handoffs()
    .find((item) => item.handoffRef === reissued.handoffRef) as HandoffRecord;
  const smuggled = new URL(callback.href);
  smuggled.searchParams.set("state", second.handoff.private["state"]!);
  const error = await refused(() =>
    completeAuthorizationCode(ctx, {
      url: smuggled,
      handoff: fresh,
      server: harness.resolved,
      client: harness.client,
      policy: harness.policy,
    }),
  );
  assert.equal(error.code, "conflict");
  assert.ok(error.detail?.startsWith("oauth.code.duplicate"), error.detail);
  assert.equal(
    harness.server.counts.token,
    tokenCalls,
    "without the fence the issuer would have minted a second grant",
  );
  assert.equal(harness.ports.inspect.credentialRefs().length, 1);
});

test("SEC-MUT-06 removing webhook signature verification is caught", () => {
  const key = "nango-webhook-signing-key";
  const body = new TextEncoder().encode('{"type":"auth","success":true}');
  // Sixty-four hex characters that are not the right digest: a comparison
  // mutated to `true` would accept every one of these.
  for (const header of [
    "0".repeat(64),
    "f".repeat(64),
    "deadbeef".repeat(8),
    "0123456789abcdef".repeat(4),
  ])
    assert.equal(verifyNangoSignature(key, body, header), false, header);
  assert.equal(verifyNangoSignature(key, body, null), false);
  assert.equal(verifyNangoSignature(key, body, "short"), false);
  // The honest signature still passes, so the guard is the only difference.
  const honest = createHmac("sha256", key).update(body).digest("hex");
  assert.equal(verifyNangoSignature(key, body, honest), true);
});

test("SEC-MUT-08 turning a projection into a spread is caught", () => {
  const summary = buildConnectionSummary({
    handoff: {
      handoffRef: "handoff:1",
      kind: "provider-browser",
      state: "issued",
      presentation: "popup",
      expiresAt: "2026-09-18T13:00:00.000Z",
      generation: 0,
    },
    verification: {
      kinds: ["account-identity"],
      observedAt: "2026-09-18T11:00:00.000Z",
      limitations: [],
    },
    target: { kind: "account", id: "acct-primary" },
  });
  const projected = agentConnectorProjection(summary) as Record<
    string,
    unknown
  >;
  // The allowlist is exactly these keys. A spread would add every other field
  // of the summary, so the set is the assertion.
  assert.deepEqual(
    Object.keys(projected).sort(),
    [
      "bindingRef",
      "connectionRef",
      "custody",
      "ecosystem",
      "generation",
      "handoff",
      "lifecycle",
      "revision",
      "service",
      "targetKind",
      "verified",
    ].sort(),
  );
  // Fields a spread would carry are individually absent.
  for (const leaked of [
    "displayName",
    "ownerKind",
    "runtime",
    "createdAt",
    "updatedAt",
    "definitionRef",
    "verification",
    "target",
  ])
    assert.equal(projected[leaked], undefined, leaked);
  // The nested handoff is an allowlist too: no reference, no expiry.
  assert.deepEqual(projected["handoff"], {
    kind: "provider-browser",
    state: "issued",
  });
  // Verification collapses to a boolean and stays false unless the connection
  // is active, so a stale "connected" cannot read as authorized.
  assert.equal(projected["verified"], summary.lifecycle === "active");
  const inactive = connectionSummarySchema.parse({
    ...summary,
    lifecycle: "reconnect-required",
  });
  assert.equal(
    (agentConnectorProjection(inactive) as Record<string, unknown>)["verified"],
    false,
  );
});

test("SEC-MUT-09 removing the private-network exclusion from publication is caught", async () => {
  const document = serverJsonSchema.parse({
    name: "io.example/internal",
    description: "Names a private network",
    version: "1.0.0",
    remotes: [
      { type: "streamable-http", url: "https://10.0.0.5/internal/mcp" },
    ],
  });
  const projected = publicServerJsonProjection(document);
  assert.deepEqual(projected.privateRemoteUrls, [
    "https://10.0.0.5/internal/mcp",
  ]);
  const entry: RegistrySnapshotEntry = {
    schemaVersion: 1,
    identity: {
      ecosystem: "mcp-registry",
      authorityNamespace: "io.example",
      nativeId: "io.example/internal",
      nativeVersion: "1.0.0",
    },
    identityDigest: "a".repeat(64),
    entryDigest: "b".repeat(64),
    serverDigest: "c".repeat(64),
    server: document,
    meta: {},
    capturedAt: "2026-09-18T00:00:00.000Z",
  };
  const row: RegistryIndexRow = {
    identityDigest: entry.identityDigest,
    content: "d".repeat(64),
    serverDigest: entry.serverDigest,
    name: "io.example/internal",
    version: "1.0.0",
    namespace: "io.example",
    status: "active",
    isLatest: true,
    firstSeenAt: "2026-09-18T00:00:00.000Z",
    lastSeenAt: "2026-09-18T00:00:00.000Z",
  };
  const view: RegistrySnapshotView = {
    tenantId: fixtureActor.tenantId,
    sourceId: "source:test",
    baseUrl: "https://registry.example.com",
    generation: 1,
    freshness: {
      fetchedAt: 0,
      stale: false,
      source: "snapshot",
      refreshInProgress: false,
    },
    issues: [],
    pins: {},
    rows: [row],
    row: () => row,
    entry: async () => entry,
  };
  // Even explicitly marked public, an entry that names a private network is
  // excluded, and the exclusion says why.
  const listed = await publicSubregistryProjection(view, {
    public: [row.identityDigest],
  }).list();
  assert.deepEqual(listed.response.servers, []);
  assert.deepEqual(listed.excluded, [
    { identityDigest: row.identityDigest, reason: "private-remote-url" },
  ]);
  assert.equal(
    await publicSubregistryProjection(view, {
      public: [row.identityDigest],
    }).version("io.example/internal", "1.0.0"),
    undefined,
  );
});
