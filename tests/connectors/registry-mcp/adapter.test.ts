import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import { catalogEntryFor } from "../../../src/server/connectors/inventory.js";
import { ConnectorAdapterRegistry, type AdapterCallContext } from "../../../src/server/connectors/adapter.js";
import { ConnectorError } from "../../../src/server/connectors/errors.js";
import {
  MCP_REGISTRY_OFFICIAL_META_KEY,
  OFFICIAL_MCP_REGISTRY_DESTINATION,
  RegistrySnapshotStore,
  createMcpRegistryAdapter,
  importRegistryEntry,
  memoryRegistrySnapshotStorage,
  registrySourceFromBinding,
} from "../../../src/server/connectors/registries/mcp/index.js";
import { fixtureActor, memoryPorts } from "../doubles/ports.js";
import { registryEntry, startMcpRegistryDouble } from "../doubles/mcp-registry.js";
import { loadServer, loadServerBytes, mcpBinding, registryBinding, sampleEntries } from "./support.js";

/*
 * The catalog-only connector adapter: honest capability rows, discovery from
 * the binding's approved destination (live or snapshot), byte import with
 * exact-byte provenance, and export only through host-approved settings.
 */

function context(binding: AdapterCallContext["binding"], ports = memoryPorts()): AdapterCallContext {
  return {
    actor: fixtureActor,
    binding,
    generation: 1,
    signal: new AbortController().signal,
    environment: ports.environment({ fetch: globalThis.fetch, origin: "https://app.example" }),
  };
}

test("reports catalog-only support with execution explicitly unsupported", () => {
  const adapter = createMcpRegistryAdapter();
  const registry = new ConnectorAdapterRegistry();
  registry.register(adapter);
  assert.equal(registry.require("mcp-registry").ecosystem, "mcp-registry");
  const rows = adapter.capabilities(new Set());
  assert.equal(rows.length, 12);
  const byDimension = Object.fromEntries(rows.map((row) => [row.dimension, row]));
  for (const dimension of ["discover", "import", "export"] as const) assert.equal(byDimension[dimension]!.implementation, "implemented");
  for (const dimension of ["invoke", "authorize", "verify", "configure", "events", "reconnect", "disconnect", "revoke", "delegate"] as const) {
    assert.equal(byDimension[dimension]!.implementation, "unsupported", dimension);
    assert.equal(byDimension[dimension]!.evidence, "not-tested");
  }
  assert.deepEqual(byDimension["invoke"]!.limitations, ["execution requires an MCP binding"]);
  assert.equal(byDimension["discover"]!.profile, "mcp-registry-api-v0.1");
  assert.equal(byDimension["import"]!.profile, "server-json-2025-12-11");
  assert.equal(byDimension["discover"]!.configuration, "not-applicable");
  assert.equal(adapter.capabilities(new Set(["MCP_REGISTRY_TOKEN"])).find((row) => row.dimension === "discover")!.configuration, "ready");
  const entry = catalogEntryFor(adapter, new Set());
  assert.equal(entry.support, "catalog-only");
  assert.equal(entry.id, "mcp-registry");
  assert.deepEqual(entry.custody, ["no-credential", "host-owned"]);
  assert.equal(entry.configuration[0]!.name, "MCP_REGISTRY_TOKEN");
  assert.equal(entry.configuration[0]!.present, false);
  assert.deepEqual(OFFICIAL_MCP_REGISTRY_DESTINATION, { id: "mcp-registry-official", origin: "https://registry.modelcontextprotocol.io", network: "public" });
});

test("discovers live from the binding's approved destination and refuses any other", async () => {
  const double = await startMcpRegistryDouble({ entries: sampleEntries() });
  try {
    const adapter = createMcpRegistryAdapter();
    const binding = registryBinding(double.origin, { settings: { registrySource: { destinationId: "registry-fixture" } } });
    const result = await adapter.discover!(context(binding), { limit: 3, query: "io.github" });
    assert.equal(result.freshness.source, "live");
    assert.equal(result.freshness.stale, false);
    assert.deepEqual(result.items.map((item) => item.identity.nativeId), ["io.github.a/b", "io.github.a/b", "io.github.c/d"]);
    assert.equal(result.items[0]!.identity.nativeVersion, "1.0.0-rc.1");
    assert.deepEqual(result.items[0]!.provenance, {
      source: "registry-fixture",
      registryStatus: "active",
      namespaceAuthentication: "registry-attested",
      schema: "https://static.modelcontextprotocol.io/schemas/2025-12-11/server.schema.json",
      isLatest: "false",
      publishedAt: "2026-01-03T00:00:00Z",
      updatedAt: "2026-01-03T00:00:00Z",
      statusChangedAt: "2026-01-03T00:00:00Z",
    });
    assert.equal(result.nextCursor, "io.github.c/d:1.0.0");
    const request = double.received("GET", "/v0.1/servers").at(-1)!;
    assert.equal(request.url.searchParams.get("search"), "io.github");
    assert.equal(request.url.searchParams.get("limit"), "3");
    const more = await adapter.discover!(context(binding), { limit: 3, query: "io.github", cursor: result.nextCursor });
    assert.deepEqual(more.items.map((item) => item.identity.nativeId), ["io.github.e/f"]);
    await assert.rejects(
      adapter.discover!(context(registryBinding(double.origin, { settings: { registrySource: { destinationId: "somewhere-else" } } })), {}),
      (error: unknown) => error instanceof ConnectorError && error.code === "network-policy" && error.detail === "registry.destination-unapproved",
    );
    await assert.rejects(
      adapter.discover!(context(registryBinding(double.origin, { extraDestinations: [{ id: "second", origin: "https://other.example.com", network: "public" }] })), {}),
      (error: unknown) => error instanceof ConnectorError && error.detail === "registry.destination-unapproved",
    );
    await assert.rejects(adapter.discover!(context(binding), { limit: 101 }), (error: unknown) => error instanceof ConnectorError && error.detail === "registry.limit.invalid");
    assert.equal(registrySourceFromBinding(registryBinding(double.origin)).baseUrl, double.origin, "a single destination needs no settings");
  } finally {
    await double.close();
  }
});

test("serves snapshots when a store is configured, refreshing only on request, and marks tombstones", async () => {
  const double = await startMcpRegistryDouble({ entries: sampleEntries() });
  try {
    const snapshots = new RegistrySnapshotStore({ storage: memoryRegistrySnapshotStorage() });
    const adapter = createMcpRegistryAdapter({ snapshots, limits: { pageLimit: 4 } });
    const binding = registryBinding(double.origin);
    const live = await adapter.discover!(context(binding), { limit: 2 });
    assert.equal(live.freshness.source, "live", "no snapshot yet falls back to live");
    const refreshed = await adapter.discover!(context(binding), { refresh: true, limit: 10 });
    assert.equal(refreshed.freshness.source, "snapshot");
    assert.equal(refreshed.freshness.stale, false);
    assert.equal(refreshed.items.length, 7);
    const requestsAfterRefresh = double.received("GET", "/v0.1/servers").length;
    double.setStatus("com.example/alpha", "1.0.0", "deleted");
    const cached = await adapter.discover!(context(binding), { limit: 3 });
    assert.equal(double.received("GET", "/v0.1/servers").length, requestsAfterRefresh, "no request without refresh");
    assert.equal(cached.items.length, 3);
    assert.ok(cached.nextCursor);
    const rest = await adapter.discover!(context(binding), { limit: 10, cursor: cached.nextCursor });
    assert.equal(rest.items.length, 4);
    const again = await adapter.discover!(context(binding), { refresh: true, limit: 10 });
    const alpha = again.items.find((item) => item.identity.nativeId === "com.example/alpha")!;
    assert.equal(alpha.status, "deleted");
    assert.equal(alpha.provenance?.tombstone, "deleted");
    const searched = await adapter.discover!(context(binding), { query: "HYBRID", limit: 10 });
    assert.deepEqual(searched.items.map((item) => item.identity.nativeId), ["io.modelcontextprotocol.anonymous/hybrid-mcp"]);
    assert.equal(await snapshots.read("tenant-b", "registry-fixture"), undefined);
  } finally {
    await double.close();
  }
});

test("imports bytes with exact-byte provenance and unwraps registry responses", async () => {
  const adapter = createMcpRegistryAdapter();
  const binding = registryBinding("https://registry.example.com");
  const bytes = loadServerBytes("hybrid");
  const outcome = await adapter.import!(context(binding), { bytes, mediaType: "application/json; charset=utf-8", origin: { kind: "upload" } });
  assert.equal(outcome.source.digest.value, createHash("sha256").update(bytes).digest("hex"));
  assert.equal(outcome.source.mediaType, "application/json");
  assert.equal(outcome.source.byteLength, bytes.byteLength);
  assert.equal(outcome.source.sourceRef, `src:mcp-registry:${outcome.source.digest.value}`);
  assert.equal(outcome.definitions[0]!.sourceRef, outcome.source.sourceRef);
  assert.equal(outcome.definitions[0]!.identity.nativeId, "io.modelcontextprotocol.anonymous/hybrid-mcp");
  assert.deepEqual(outcome.executableCandidates, ["mcp-remote:0", "mcp-remote:1"]);
  assert.ok(outcome.issues.some((issue) => issue.code === "policy.execution-requires-binding"));
  assert.deepEqual((outcome.definitions[0]!.nativeExtensions["io.ceremony.connectors/source"] as { sourceId: string }).sourceId, "registry-fixture");
  const wrapped = registryEntry(loadServer("brave-search"), { status: "deprecated", statusMessage: "old", publishedAt: "2026-01-01T00:00:00Z" });
  const wrappedOutcome = await adapter.import!(context(binding), {
    bytes: new TextEncoder().encode(JSON.stringify(wrapped)),
    mediaType: "application/json",
    origin: { kind: "registry", location: "https://registry.example.com" },
  });
  assert.equal((wrappedOutcome.definitions[0]!.nativeExtensions[MCP_REGISTRY_OFFICIAL_META_KEY] as { status: string }).status, "deprecated");
  assert.ok(wrappedOutcome.issues.some((issue) => issue.code === "version.deprecated"));
  await assert.rejects(
    adapter.import!(context(binding), { bytes: new Uint8Array(300 * 1024), mediaType: "application/json", origin: { kind: "upload" } }),
    (error: unknown) => error instanceof ConnectorError && error.detail === "server-json.oversized",
  );
  const viaEntry = await importRegistryEntry({ server: wrapped.server as never, official: wrapped._meta[MCP_REGISTRY_OFFICIAL_META_KEY] }, { sourceRef: "src:x", baseUrl: "https://registry.example.com", sourceId: "registry-fixture" });
  assert.equal(viaEntry.definition.identity.nativeVersion, "1.0.2");
});

test("exports only through host-approved settings naming the MCP binding and evidence", async () => {
  const adapter = createMcpRegistryAdapter();
  const imported = await adapter.import!(context(registryBinding("https://registry.example.com")), { bytes: loadServerBytes("hybrid"), mediaType: "application/json", origin: { kind: "upload" } });
  const definition = imported.definitions[0]!;
  const exportSettings = {
    mcpBinding: mcpBinding(definition.definitionRef),
    implementationEvidence: { servedEndpoints: [{ url: "https://mcp.example.com/mcp", transport: "streamable-http", runtime: "hosted-server", evidence: "local-integration", observedAt: "2026-09-18T00:00:00Z" }] },
    publication: { authorized: true, name: "com.example/ceremony-mcp", target: { sourceId: "registry-fixture", network: "public" } },
  };
  const request = { definition, format: "server.json", includeNativeExtensions: false };
  await assert.rejects(adapter.export!(context(registryBinding("https://registry.example.com")), request), (error: unknown) => error instanceof ConnectorError && error.detail === "export.requires-mcp-binding");
  await assert.rejects(adapter.export!(context(registryBinding("https://registry.example.com", { settings: { export: exportSettings } })), { ...request, format: "openapi" }), (error: unknown) => error instanceof ConnectorError && error.detail === "export.format");
  await assert.rejects(adapter.export!(context(registryBinding("https://registry.example.com", { settings: { export: { ...exportSettings, mcpBinding: mcpBinding(definition.definitionRef, { tenantId: "tenant-b" }) } } })), request), (error: unknown) => error instanceof ConnectorError && error.detail === "export.tenant-mismatch");
  await assert.rejects(adapter.export!(context(registryBinding("https://registry.example.com", { settings: { export: { ...exportSettings, mcpBinding: mcpBinding(definition.definitionRef, { runtime: "browser" }) } } })), request), (error: unknown) => error instanceof ConnectorError && error.detail === "export.browser-only");
  const outcome = await adapter.export!(context(registryBinding("https://registry.example.com", { settings: { export: exportSettings } })), { ...request, includeNativeExtensions: true });
  const document = JSON.parse(new TextDecoder().decode(outcome.bytes)) as Record<string, unknown>;
  assert.equal(document["name"], "com.example/ceremony-mcp");
  assert.ok(outcome.losses.some((loss) => loss.code === "structure.native-extensions-omitted"));
  assert.ok(outcome.losses.some((loss) => loss.code === "executable-code.package-omitted"));
});

test("a private source reads its bearer token through the configuration port per call", async () => {
  const token = "adapter-private-token-canary-2299";
  const double = await startMcpRegistryDouble({ entries: sampleEntries(), readToken: token });
  try {
    const adapter = createMcpRegistryAdapter();
    const binding = registryBinding(double.origin, { settings: { registrySource: { destinationId: "registry-fixture", authorization: { kind: "bearer", configurationName: "MCP_REGISTRY_TOKEN_PRIVATE" } } } });
    const ports = memoryPorts();
    await assert.rejects(adapter.discover!(context(binding, ports), {}), (error: unknown) => error instanceof ConnectorError && error.detail === "registry.unauthorized");
    ports.configuration.set("MCP_REGISTRY_TOKEN_PRIVATE", token);
    const result = await adapter.discover!(context(binding, ports), { limit: 2 });
    assert.equal(result.items.length, 2);
    assert.equal(double.requests.at(-1)!.headers.authorization, `Bearer ${token}`);
    assert.doesNotMatch(JSON.stringify(result), new RegExp(token));
    await assert.rejects(
      adapter.discover!(context(registryBinding(double.origin, { settings: { registrySource: { destinationId: "registry-fixture", authorization: { kind: "bearer", configurationName: "lowercase" } } } }), ports), {}),
      (error: unknown) => error instanceof ConnectorError && error.detail === "registry.settings.invalid",
    );
  } finally {
    await double.close();
  }
});
