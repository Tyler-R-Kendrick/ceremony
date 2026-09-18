import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  agentConnectorProjection,
  agentDefinitionProjection,
  auditConnectorProjection,
  authorReviewProjection,
  exportDefinitionProjection,
  humanConnectionProjection,
  publicCatalogProjection,
} from "../../../src/core/connectors/index.js";
import {
  ConnectorError,
  explainConnectorError,
} from "../../../src/server/connectors/errors.js";
import {
  humanHandoffPresentation,
  privateCollectorHandoff,
} from "../../../src/server/connectors/auth/index.js";
import {
  privateCatalogProjection,
  publicServerJsonProjection,
  serverJsonSchema,
  type RegistryIndexRow,
  type RegistrySnapshotEntry,
  type RegistrySnapshotView,
} from "../../../src/server/connectors/registries/mcp/index.js";
import {
  buildAuditEvent,
  buildCapability,
  buildCatalogEntry,
  buildConnectionSummary,
  buildDefinition,
  buildSourceRecord,
} from "../fixtures/builders.js";
import { fixtureActor } from "../doubles/ports.js";

/*
 * SEC-05. One canary per kind of secret, planted in every place an untrusted
 * source can put one, then swept across every surface that is not the
 * authorized one. Native private input may hold a secret transiently; a log,
 * an audit row, a model-visible result, an export, an error payload, a public
 * catalog row, a published registry document and the browser's own cached
 * shell must not.
 */

const canaries = Object.freeze({
  exampleSecret: "CANARY_EXAMPLE_SECRET_4f2",
  headerToken: "ghp_CANARY_HEADER_TOKEN_8b1",
  signedUrl:
    "https://files.example.com/spec.json?X-Amz-Signature=CANARY_SIG_2c9",
  userinfoUrl: "https://alice:CANARY_PASSWORD_7d3@api.example.com/v1",
  providerMessage: "invalid_grant: user CANARY_PERSON_9a4@example.com is gone",
  artifactRef: "artifact:CANARY-ARTIFACT-5e8",
  collectorRef: "collector:CANARY-COLLECTOR-1f6",
  configValue: "CANARY_CONFIG_VALUE_3b7",
});
const allCanaries = Object.values(canaries);

function sweep(label: string, value: unknown, allowed: readonly string[] = []) {
  const text = JSON.stringify(value) ?? "";
  for (const canary of allCanaries) {
    if (allowed.includes(canary)) continue;
    assert.ok(
      !text.includes(canary),
      `${label} leaked ${canary}\n${text.slice(0, 2000)}`,
    );
  }
}

/** A definition whose source put credentials in every place a source can. */
function poisonedDefinition() {
  return buildDefinition({
    display: {
      name: "Poisoned",
      description: `Call with token ${canaries.headerToken}`,
      ecosystem: "openapi",
      service: "poisoned",
    },
    declaredServers: [{ url: canaries.signedUrl, status: "declared" }],
    capabilities: [
      buildCapability({
        nativeId: "listItems",
        label: "List items",
        nativeExtensions: {
          "x-example": {
            headers: { authorization: `Bearer ${canaries.headerToken}` },
            body: { apiKey: canaries.exampleSecret },
          },
        },
      }),
    ],
    nativeExtensions: {
      "x-vendor-onboarding": {
        callbackUrl: canaries.userinfoUrl,
        seedCredential: canaries.exampleSecret,
      },
    },
  });
}

test("a model, a catalog row and an export never carry a source's credentials", () => {
  const definition = poisonedDefinition();
  const source = buildSourceRecord({ artifactRef: canaries.artifactRef });

  // A model sees identifiers, kinds and classifications only.
  sweep("agentDefinitionProjection", agentDefinitionProjection(definition));
  // The default export carries the description without the unreviewed
  // vendor extensions that a source can hide an example credential in.
  sweep("exportDefinitionProjection", exportDefinitionProjection(definition));
  // The public directory row is built from the catalog entry, which never
  // holds source prose in the first place.
  sweep("publicCatalogProjection", publicCatalogProjection(buildCatalogEntry()));
  // A reviewer sees everything except the protected artifact handle.
  const review = authorReviewProjection(definition, source);
  sweep("authorReviewProjection artifactRef", review.source, [
    canaries.signedUrl,
  ]);
  assert.equal(
    (review.source as Record<string, unknown>)["artifactRef"],
    undefined,
  );
  assert.equal(source.artifactRef, canaries.artifactRef, "the record kept it");

  // The one opt-in that may carry extensions says so, and only then.
  const opted = JSON.stringify(
    exportDefinitionProjection(definition, { includeNativeExtensions: true }),
  );
  assert.ok(
    opted.includes(canaries.exampleSecret),
    "the operator opt-in is the only path that republishes source extensions",
  );
});

test("a connection summary shows a person a URL and shows a model nothing", () => {
  const summary = buildConnectionSummary({
    handoff: {
      handoffRef: "handoff:1",
      kind: "connect-widget",
      state: "issued",
      presentation: "popup",
      expiresAt: "2026-09-18T13:00:00.000Z",
      generation: 0,
    },
  });
  const human = humanConnectionProjection(summary, {
    url: "https://connect.example.com/session/abc",
    userCode: "WDJB-MJHT",
    instructions: "Finish in the provider's window.",
  });
  assert.equal(human.presentation?.url, "https://connect.example.com/session/abc");
  sweep("humanConnectionProjection", human);
  const agent = agentConnectorProjection(summary);
  sweep("agentConnectorProjection", agent);
  const text = JSON.stringify(agent);
  assert.ok(!text.includes("connect.example.com"), text);
  assert.ok(!text.includes("WDJB-MJHT"), text);
  // A presentation URL that carries credentials is refused outright rather
  // than shown to anyone.
  assert.throws(() =>
    humanConnectionProjection(summary, { url: canaries.userinfoUrl }),
  );
  assert.throws(() =>
    humanConnectionProjection(summary, { url: "javascript:alert(1)" }),
  );
});

test("native private input holds a secret transiently and nothing else does", () => {
  const handoff = privateCollectorHandoff({
    collectorRef: canaries.collectorRef,
    collectorUrl: "https://app.example/collect/abc",
    expiresAt: Date.parse("2026-09-18T13:00:00.000Z"),
    extra: { seed: canaries.configValue },
  });
  // The private block is the authorized place: it does hold the material.
  assert.equal(handoff.private["collectorRef"], canaries.collectorRef);
  assert.equal(handoff.private["seed"], canaries.configValue);
  // Every surface built from it does not.
  sweep(
    "humanHandoffPresentation",
    humanHandoffPresentation(
      {
        kind: "private-collector",
        state: "issued",
        private: handoff.private,
        expiresAt: Date.parse("2026-09-18T13:00:00.000Z"),
      },
      Date.parse("2026-09-18T12:00:00.000Z"),
    ),
  );
  sweep(
    "audit",
    auditConnectorProjection(
      buildAuditEvent({
        action: "connect",
        outcome: "success",
        connectionRef: "connection:1",
      }),
    ),
  );
  // An audit row is an allowlist: an extra field a caller adds is dropped.
  const widened = auditConnectorProjection({
    ...buildAuditEvent(),
    ...({ note: canaries.exampleSecret } as Record<string, unknown>),
  } as Parameters<typeof auditConnectorProjection>[0]);
  sweep("audit widened", widened);
  assert.equal((widened as Record<string, unknown>)["note"], undefined);
});

test("an error payload names a code, never the provider's words", () => {
  const upstream = new Error(canaries.providerMessage);
  const wrapped = new ConnectorError("upstream-rejected", {
    detail: "oauth.token.invalid-grant",
    cause: upstream,
  });
  const explained = explainConnectorError(wrapped);
  sweep("explainConnectorError", explained);
  assert.equal(explained.code, "upstream-rejected");
  assert.equal(explained.detail, "oauth.token.invalid-grant");
  // The cause is still reachable inside trusted server code; it just never
  // reaches the explanation.
  assert.equal((wrapped.cause as Error).message, canaries.providerMessage);
  // An unknown failure collapses to one code with no text of its own.
  sweep("explainConnectorError unknown", explainConnectorError(upstream));
  assert.equal(explainConnectorError(upstream).code, "upstream-unavailable");
  // A detail is a bounded code shape: an attempt to smuggle text fails loudly.
  for (const detail of [
    canaries.providerMessage,
    "Upstream said: secret",
    "a".repeat(200),
    "UPPER.case",
  ])
    assert.throws(() => new ConnectorError("denied", { detail }), detail);
});

test("a published registry document carries no secret value and no private host", () => {
  const document = serverJsonSchema.parse({
    name: "io.example/poisoned",
    description: "A server whose publisher pasted a credential",
    version: "1.0.0",
    packages: [
      {
        registryType: "npm",
        identifier: "poisoned",
        transport: { type: "stdio" },
        environmentVariables: [
          { name: "API_TOKEN", value: canaries.headerToken, isSecret: true },
          { name: "SEED", value: canaries.exampleSecret, isSecret: true },
        ],
      },
    ],
    remotes: [
      {
        type: "streamable-http",
        url: "https://mcp.example.com/http",
        headers: [
          {
            name: "Authorization",
            value: `Bearer ${canaries.headerToken}`,
          },
        ],
      },
    ],
  });
  const projected = publicServerJsonProjection(document);
  sweep("publicServerJsonProjection", projected.server);
  assert.ok(projected.redactions >= 3, String(projected.redactions));

  // The private catalog is for the owning tenant, and it still never shows a
  // secret value; a reviewer who needs the bytes reads the protected record.
  const entry: RegistrySnapshotEntry = {
    schemaVersion: 1,
    identity: {
      ecosystem: "mcp-registry",
      authorityNamespace: "io.example",
      nativeId: "io.example/poisoned",
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
    name: "io.example/poisoned",
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
    freshness: { fetchedAt: 0, stale: false, source: "snapshot", refreshInProgress: false },
    issues: [],
    pins: {},
    rows: [row],
    row: () => row,
    entry: async () => entry,
  };
  return (async () => {
    const privateSurface = privateCatalogProjection(view, fixtureActor);
    const listed = await privateSurface.list();
    sweep("privateCatalogProjection", listed.response);
    // And the public subregistry refuses an entry no one marked public.
    const { publicSubregistryProjection } = await import(
      "../../../src/server/connectors/registries/mcp/projections.js"
    );
    const nothingPublic = await publicSubregistryProjection(view, {
      public: [],
    }).list();
    assert.deepEqual(nothingPublic.response.servers, []);
    // Marked public, it is served, and it still carries no secret value.
    const marked = await publicSubregistryProjection(view, {
      public: [row.identityDigest],
    }).list();
    assert.equal(marked.response.servers.length, 1);
    sweep("publicSubregistryProjection", marked.response);
    // A tenant that does not own the snapshot cannot read the private view
    // at all.
    assert.throws(() =>
      privateCatalogProjection(view, {
        ...fixtureActor,
        tenantId: "tenant-b",
      }),
    );
  })();
});

test("the browser shell caches nothing that could answer for authorization", async () => {
  const worker = await readFile(
    new URL("../../../examples/web/public/sw.js", import.meta.url),
    "utf8",
  );
  // Independent of the UX swarm's own assertions: nothing in the worker may
  // name a connector route, an API path, a token or a storage of credentials.
  for (const forbidden of [
    /connector/i,
    /\/api\//,
    /token/i,
    /credential/i,
    /authorization/i,
    /localStorage/,
    /indexedDB/,
  ])
    assert.doesNotMatch(worker, forbidden, String(forbidden));
});
