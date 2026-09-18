import { test } from "node:test";
import assert from "node:assert/strict";
import { memoryPorts, fixtureActor } from "../doubles/ports.js";
import { startSmitheryDouble } from "../doubles/smithery.js";
import { buildBinding } from "../fixtures/builders.js";
import { canaries } from "../fixtures/builders.js";
import {
  createSmitheryRegistryAdapter,
  fetchSmitheryServerDocument,
  SMITHERY_GET_OPERATION,
  SMITHERY_LIST_OPERATION,
} from "../../../src/server/connectors/registries/smithery/adapter.js";
import { SMITHERY_API_KEY } from "../../../src/server/connectors/registries/smithery/api.js";
import { ConnectorError } from "../../../src/server/connectors/errors.js";
import type { AdapterCallContext } from "../../../src/server/connectors/adapter.js";

/*
 * CAT-01. The double enforces Smithery's documented request contract; these
 * tests assert that the adapter speaks it and that a Smithery listing is
 * carried as a Smithery listing, never as an official-registry document.
 */

const servers = [
  {
    id: "srv-1",
    qualifiedName: "acme/notes-mcp",
    namespace: "acme",
    slug: "notes-mcp",
    displayName: "Acme Notes",
    description: "Read and write Acme notes.",
    verified: true,
    useCount: 1200,
    remote: true,
    isDeployed: true,
    createdAt: "2026-02-01T00:00:00.000Z",
    homepage: "https://smithery.ai/server/acme/notes-mcp",
    owner: "acme",
    detail: {
      deploymentUrl: "https://server.smithery.ai/acme/notes-mcp/mcp",
      connections: [
        {
          type: "http",
          deploymentUrl: "https://server.smithery.ai/acme/notes-mcp/mcp",
          configSchema: {
            type: "object",
            required: ["apiKey"],
            properties: {
              apiKey: { type: "string", "x-from": { header: "x-acme-key" } },
              model: { type: "string", "x-from": { query: "model" } },
            },
          },
        },
      ],
      security: { scanPassed: true },
      tools: [
        { name: "search_notes", description: "Search notes." },
        { name: "create_note", description: "Create a note." },
      ],
    },
  },
  {
    id: "srv-2",
    qualifiedName: "acme/bundle-mcp",
    namespace: "acme",
    slug: "bundle-mcp",
    displayName: "Acme Bundle",
    description: "A downloadable stdio bundle.",
    remote: false,
    isDeployed: false,
    detail: {
      connections: [
        {
          type: "stdio",
          bundleUrl: "https://smithery.ai/bundle.zip",
          runtime: "node",
        },
      ],
      security: { scanPassed: false },
      tools: [{ name: "local_tool" }],
    },
  },
  {
    id: "srv-3",
    qualifiedName: "globex/search-mcp",
    namespace: "globex",
    slug: "search-mcp",
    displayName: "Globex Search",
    description: "Search the Globex corpus.",
    detail: {
      deploymentUrl: "https://server.smithery.ai/globex/search-mcp/mcp",
    },
  },
];

async function harness(options: { apiKey?: string | undefined } = {}) {
  const double = await startSmitheryDouble({
    apiKey: canaries.token,
    namespaces: ["acme"],
    servers,
  });
  const ports = memoryPorts();
  if (options.apiKey !== undefined)
    ports.configuration.set(SMITHERY_API_KEY, options.apiKey);
  else ports.configuration.set(SMITHERY_API_KEY, canaries.token);
  const binding = buildBinding({
    adapterId: "smithery-registry",
    profileId: undefined,
    destinations: [
      { id: "api", origin: double.origin, network: "loopback-fixture" },
    ],
    operations: [
      {
        operationRef: SMITHERY_LIST_OPERATION,
        nativeId: "listServers",
        destinationId: "api",
        transport: { kind: "http", method: "GET", pathTemplate: "/servers" },
        effect: "read",
        outputClassification: "public",
        cost: "free",
        consent: "none",
        replay: "read-only",
        targetParameters: [],
      },
      {
        operationRef: SMITHERY_GET_OPERATION,
        nativeId: "getServer",
        destinationId: "api",
        transport: { kind: "http", method: "GET", pathTemplate: "/servers" },
        effect: "read",
        outputClassification: "public",
        cost: "free",
        consent: "none",
        replay: "read-only",
        targetParameters: [],
      },
    ],
    configuration: [SMITHERY_API_KEY],
  });
  const ctx: AdapterCallContext = {
    actor: fixtureActor,
    binding,
    generation: 0,
    signal: AbortSignal.timeout(5000),
    environment: ports.environment({ fetch: globalThis.fetch }),
  };
  return {
    double,
    ports,
    ctx,
    binding,
    adapter: createSmitheryRegistryAdapter(),
  };
}

test("discovery uses Smithery's documented page/pageSize paging and search", async () => {
  const { double, ctx, adapter } = await harness();
  try {
    const first = await adapter.discover!(ctx, { limit: 2 });
    assert.deepEqual(
      first.items.map((item) => item.identity.nativeId),
      ["acme/notes-mcp", "acme/bundle-mcp"],
    );
    assert.equal(first.nextCursor, "2");
    const request = double.received("GET", "/servers")[0]!;
    assert.equal(request.url.searchParams.get("page"), "1");
    assert.equal(request.url.searchParams.get("pageSize"), "2");
    assert.equal(request.headers.authorization, `Bearer ${canaries.token}`);
    const second = await adapter.discover!(ctx, {
      limit: 2,
      cursor: first.nextCursor!,
    });
    assert.deepEqual(
      second.items.map((item) => item.identity.nativeId),
      ["globex/search-mcp"],
    );
    assert.equal(second.nextCursor, undefined);
    const searched = await adapter.discover!(ctx, { query: "globex" });
    assert.equal(
      double.received("GET", "/servers")[2]?.url.searchParams.get("q"),
      "globex",
    );
    assert.deepEqual(
      searched.items.map((item) => item.identity.nativeId),
      ["globex/search-mcp"],
    );
  } finally {
    await double.close();
  }
});

test("discovery preserves namespace, qualified name and Smithery's own flags as provenance", async () => {
  const { double, ctx, adapter } = await harness();
  try {
    const result = await adapter.discover!(ctx, { limit: 1 });
    const item = result.items[0]!;
    assert.equal(item.identity.ecosystem, "smithery");
    assert.equal(item.identity.authorityNamespace, "acme");
    assert.equal(item.identity.nativeId, "acme/notes-mcp");
    assert.equal(
      item.identity.nativeVersion,
      "unversioned",
      "Smithery exposes no version and none is invented",
    );
    assert.equal(item.provenance?.registry, "smithery");
    assert.equal(item.provenance?.verifiedFlag, "true");
    assert.equal(item.provenance?.isDeployed, "true");
    assert.equal(item.provenance?.useCount, "1200");
    assert.equal(item.provenance?.owner, "acme");
    assert.equal(item.provenance?.versionExposed, "no");
    assert.equal(result.freshness.source, "live");
  } finally {
    await double.close();
  }
});

test("a missing or rejected API key fails closed without a fallback", async () => {
  const missing = await harness({ apiKey: undefined });
  missing.ports.configuration.set(SMITHERY_API_KEY, undefined);
  try {
    await assert.rejects(
      () => missing.adapter.discover!(missing.ctx, {}),
      (error: unknown) =>
        error instanceof ConnectorError &&
        error.code === "configuration-required",
    );
    assert.equal(missing.double.requests.length, 0);
  } finally {
    await missing.double.close();
  }
  const wrong = await harness({ apiKey: "sk-not-the-key" });
  try {
    await assert.rejects(
      () => wrong.adapter.discover!(wrong.ctx, {}),
      (error: unknown) =>
        error instanceof ConnectorError && error.code === "unauthenticated",
    );
    assert.equal(wrong.double.requests.length, 1, "no retry with another key");
  } finally {
    await wrong.double.close();
  }
});

test("a forged cursor is refused before any request", async () => {
  const { double, ctx, adapter } = await harness();
  try {
    await assert.rejects(
      () => adapter.discover!(ctx, { cursor: "1; DROP" }),
      (error: unknown) =>
        error instanceof ConnectorError && error.code === "invalid-request",
    );
    assert.equal(double.requests.length, 0);
  } finally {
    await double.close();
  }
});

test("import normalizes a hosted listing with its declared header credential and tools", async () => {
  const { double, ctx, adapter } = await harness();
  try {
    const document = await fetchSmitheryServerDocument(ctx, "acme/notes-mcp");
    assert.equal(
      double.received("GET", "/servers/acme%2Fnotes-mcp").length,
      1,
      "the qualified name is percent-encoded exactly once",
    );
    const outcome = await adapter.import!(ctx, {
      bytes: document.bytes,
      mediaType: "application/json",
      origin: { kind: "registry", location: `${double.origin}/servers` },
    });
    assert.equal(outcome.definitions.length, 1);
    const definition = outcome.definitions[0]!;
    assert.equal(definition.identity.nativeId, "acme/notes-mcp");
    assert.equal(definition.display.service, "notes-mcp");
    assert.deepEqual(definition.declaredServers, [
      {
        url: "https://server.smithery.ai/acme/notes-mcp/mcp",
        status: "declared",
      },
    ]);
    const apiKeyProfile = definition.authentication.find(
      (profile) => profile.kind === "api-key",
    );
    assert.ok(apiKeyProfile);
    assert.equal(
      apiKeyProfile.kind === "api-key" && apiKeyProfile.parameterName,
      "x-acme-key",
    );
    assert.deepEqual(
      definition.capabilities.map((capability) => capability.nativeId),
      ["search_notes", "create_note"],
    );
    assert.equal(definition.capabilities[0]?.kind, "mcp-tool");
    assert.deepEqual(outcome.executableCandidates, []);
    assert.ok(
      definition.compatibility.issues.some(
        (issue) => issue.code === "smithery.version.not-exposed",
      ),
    );
    assert.ok(
      definition.compatibility.issues.some(
        (issue) => issue.code === "smithery.security.scan-is-not-approval",
      ),
      "a Smithery scan flag is provenance, not approval",
    );
    assert.equal(
      definition.compatibility.dimensions.invoke,
      "requires-configuration",
    );
    // The captured document is the exact bytes Smithery served.
    assert.equal(outcome.source.mediaType, "application/json");
    assert.equal(outcome.source.byteLength, document.bytes.byteLength);
    assert.equal(outcome.source.identity.ecosystem, "smithery");
    assert.equal(outcome.source.format.name, "smithery-server");
  } finally {
    await double.close();
  }
});

test("a stdio bundle listing is preserved and blocked, never turned into an executable candidate", async () => {
  const { double, ctx, adapter } = await harness();
  try {
    const document = await fetchSmitheryServerDocument(ctx, "acme/bundle-mcp");
    const outcome = await adapter.import!(ctx, {
      bytes: document.bytes,
      mediaType: "application/json",
      origin: { kind: "registry" },
    });
    const definition = outcome.definitions[0]!;
    assert.equal(
      definition.authentication.some(
        (profile) => profile.kind === "unsupported",
      ),
      true,
    );
    const blocking = definition.compatibility.issues.find(
      (issue) => issue.code === "smithery.connection.stdio-unsupported",
    );
    assert.ok(blocking);
    assert.equal(blocking.severity, "blocking");
    assert.equal(blocking.executionImpact, "blocks-operation");
    assert.deepEqual(definition.declaredServers, []);
    assert.deepEqual(outcome.executableCandidates, []);
  } finally {
    await double.close();
  }
});

test("the catalog boundary and its capability rows stay visible", async () => {
  const { double, adapter } = await harness();
  try {
    // provider-backed, because this adapter really implements discovery and
    // import; the contract reserves catalog-only for implementing nothing.
    // The catalog boundary is reported per dimension instead, which the
    // assertions below check.
    assert.equal(adapter.support, "provider-backed");
    const configured = adapter.capabilities(new Set([SMITHERY_API_KEY]));
    const missing = adapter.capabilities(new Set());
    assert.equal(
      configured.find((row) => row.dimension === "discover")?.configuration,
      "ready",
    );
    assert.equal(
      missing.find((row) => row.dimension === "discover")?.configuration,
      "missing",
    );
    for (const dimension of [
      "invoke",
      "authorize",
      "verify",
      "export",
    ] as const) {
      const row = configured.find((item) => item.dimension === dimension)!;
      assert.equal(row.implementation, "unsupported", dimension);
      assert.equal(row.evidence, "not-tested", dimension);
      assert.ok(row.limitations.length > 0, dimension);
    }
  } finally {
    await double.close();
  }
});

test("the deployment API key never reaches a definition or an error", async () => {
  const { double, ctx, adapter } = await harness();
  try {
    const document = await fetchSmitheryServerDocument(ctx, "acme/notes-mcp");
    const outcome = await adapter.import!(ctx, {
      bytes: document.bytes,
      mediaType: "application/json",
      origin: { kind: "registry" },
    });
    assert.ok(!JSON.stringify(outcome.definitions).includes(canaries.token));
    assert.ok(!JSON.stringify(outcome.source).includes(canaries.token));
    await assert.rejects(
      () => fetchSmitheryServerDocument(ctx, "acme/missing-mcp"),
      (error: unknown) => {
        assert.ok(error instanceof ConnectorError);
        assert.equal(error.code, "not-found");
        assert.ok(
          !JSON.stringify({ ...error, message: error.message }).includes(
            canaries.token,
          ),
        );
        return true;
      },
    );
  } finally {
    await double.close();
  }
});

test("an oversized or unrecognized document is refused", async () => {
  const { double, ctx, adapter } = await harness();
  try {
    await assert.rejects(
      () =>
        adapter.import!(ctx, {
          bytes: new TextEncoder().encode('{"not":"a smithery server"}'),
          mediaType: "application/json",
          origin: { kind: "upload" },
        }),
      (error: unknown) =>
        error instanceof ConnectorError && error.code === "invalid-request",
    );
    await assert.rejects(
      () =>
        adapter.import!(ctx, {
          bytes: new TextEncoder().encode("{not json"),
          mediaType: "application/json",
          origin: { kind: "upload" },
        }),
      (error: unknown) =>
        error instanceof ConnectorError && error.code === "invalid-request",
    );
  } finally {
    await double.close();
  }
});
