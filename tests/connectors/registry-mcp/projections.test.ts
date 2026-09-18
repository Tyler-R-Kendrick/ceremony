import assert from "node:assert/strict";
import { test } from "node:test";
import { ConnectorError } from "../../../src/server/connectors/errors.js";
import {
  CEREMONY_SNAPSHOT_META_KEY,
  MCP_REGISTRY_OFFICIAL_META_KEY,
  RegistrySnapshotStore,
  createMcpRegistryClient,
  isPubliclyRoutableUrl,
  memoryRegistrySnapshotStorage,
  privateCatalogProjection,
  publicSubregistryProjection,
} from "../../../src/server/connectors/registries/mcp/index.js";
import { fixtureActor, memoryPorts } from "../doubles/ports.js";
import {
  registryEntry,
  startMcpRegistryDouble,
} from "../doubles/mcp-registry.js";
import { assertMatchesPinnedServerDetail, loadServer } from "./support.js";

/*
 * REG-04 / AC-MCP-10: the public subregistry returns only explicitly public,
 * allowlisted metadata; the private catalog shows the tenant everything it
 * holds. Canaries: a private remote URL, a token in a header value, a
 * configured environment value.
 */

const tenant = "tenant-a";
const schema =
  "https://static.modelcontextprotocol.io/schemas/2025-12-11/server.schema.json";
const TOKEN_CANARY = "Bearer header-token-canary-9001";
const CONFIG_CANARY = "configured-env-value-canary-5150";

async function snapshot() {
  const hybrid = loadServer("hybrid");
  (hybrid.remotes as Array<Record<string, unknown>>)[0]!["headers"] = [
    ...((hybrid.remotes as Array<{ headers: unknown[] }>)[0]!.headers ?? []),
    {
      name: "Authorization",
      description: "static token some publisher pasted",
      value: TOKEN_CANARY,
    },
  ];
  const double = await startMcpRegistryDouble({
    entries: [
      registryEntry(loadServer("brave-search"), {
        publishedAt: "2026-01-01T00:00:00Z",
      }),
      registryEntry(
        hybrid,
        { publishedAt: "2026-01-02T00:00:00Z" },
        { "com.example.subregistry/custom": { rating: 5 } },
      ),
      registryEntry(
        {
          $schema: schema,
          name: "com.example/intranet",
          description: "reachable only inside",
          version: "1.0.0",
          remotes: [
            { type: "streamable-http", url: "http://10.0.0.5/mcp" },
            { type: "sse", url: "https://mcp.corp.internal/sse" },
          ],
        },
        { publishedAt: "2026-01-03T00:00:00Z" },
      ),
      registryEntry(
        {
          $schema: schema,
          name: "com.example/deleted",
          description: "moderated away",
          version: "1.0.0",
          remotes: [
            { type: "streamable-http", url: "https://deleted.example.com/mcp" },
          ],
        },
        {
          publishedAt: "2026-01-04T00:00:00Z",
          status: "deleted",
          statusMessage: "spam",
        },
      ),
      registryEntry(
        {
          $schema: schema,
          name: "com.example/old",
          description: "deprecated but visible",
          version: "0.9.0",
          remotes: [
            { type: "streamable-http", url: "https://old.example.com/mcp" },
          ],
        },
        {
          publishedAt: "2026-01-05T00:00:00Z",
          status: "deprecated",
          statusMessage: "use 1.0",
        },
      ),
      registryEntry(
        {
          $schema: schema,
          name: "com.example/vanished",
          description: "will be unlisted",
          version: "1.0.0",
          remotes: [
            {
              type: "streamable-http",
              url: "https://vanished.example.com/mcp",
            },
          ],
        },
        { publishedAt: "2026-01-06T00:00:00Z" },
      ),
    ],
  });
  const client = createMcpRegistryClient({
    baseUrl: double.origin,
    fetch: globalThis.fetch,
    limits: { pageLimit: 4 },
  });
  const store = new RegistrySnapshotStore({
    storage: memoryRegistrySnapshotStorage(),
  });
  const source = { id: "registry-fixture", baseUrl: double.origin, client };
  await store.refresh(tenant, source);
  double.remove("com.example/vanished", "1.0.0");
  await store.refresh(tenant, source, { mode: "full" });
  const view = (await store.read(tenant, "registry-fixture"))!;
  const byName = (name: string) => view.rows.find((row) => row.name === name)!;
  return { double, view, byName, store };
}

test("the public subregistry serves only explicitly public, allowlisted, secret-free metadata (AC-MCP-10)", async () => {
  const { double, view, byName } = await snapshot();
  const ports = memoryPorts();
  ports.configuration.set("X_API_KEY", CONFIG_CANARY);
  try {
    const surface = publicSubregistryProjection(view, {
      public: new Set([
        byName("io.modelcontextprotocol.anonymous/hybrid-mcp").identityDigest,
        byName("com.example/intranet").identityDigest,
        byName("com.example/deleted").identityDigest,
        byName("com.example/vanished").identityDigest,
        byName("com.example/old").identityDigest,
      ]),
    });
    const { response, excluded } = await surface.list();
    assert.deepEqual(
      response.servers.map((item) => item.server["name"]),
      ["com.example/old", "io.modelcontextprotocol.anonymous/hybrid-mcp"],
      "not-public, deleted, unlisted and private-network entries are absent",
    );
    assert.deepEqual(excluded, [
      {
        identityDigest: byName("com.example/intranet").identityDigest,
        reason: "private-remote-url",
      },
    ]);
    assert.equal(response.metadata.count, 2);
    const text = JSON.stringify(response);
    assert.doesNotMatch(
      text,
      /10\.0\.0\.5|corp\.internal|127\.0\.0\.1|registry-fixture|io\.ceremony/,
      "no private origin or host provenance",
    );
    assert.doesNotMatch(
      text,
      new RegExp(TOKEN_CANARY.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")),
      "header token value stripped",
    );
    assert.doesNotMatch(
      text,
      new RegExp(CONFIG_CANARY),
      "configured values never enter a projection",
    );
    for (const item of response.servers) {
      assertMatchesPinnedServerDetail(item.server);
      assert.deepEqual(Object.keys(item._meta), [
        MCP_REGISTRY_OFFICIAL_META_KEY,
      ]);
    }
    const hybrid = response.servers[1]!;
    const headers = (
      hybrid.server["remotes"] as Array<{
        headers: Array<Record<string, unknown>>;
      }>
    )[0]!.headers;
    assert.deepEqual(
      headers.map((header) => header["name"]),
      ["X-API-Key", "X-Region", "Authorization"],
    );
    assert.equal(headers[0]!["isSecret"], true);
    assert.equal(
      headers[1]!["default"],
      "us-east-1",
      "non-secret defaults survive",
    );
    assert.equal(headers[2]!["value"], undefined);
    assert.equal(
      hybrid.server["_meta"],
      undefined,
      "publisher metadata is not republished unless the policy says so",
    );
    assert.equal(
      (hybrid._meta[MCP_REGISTRY_OFFICIAL_META_KEY] as { status: string })
        .status,
      "active",
    );
    const old = response.servers[0]!;
    assert.equal(
      (
        old._meta[MCP_REGISTRY_OFFICIAL_META_KEY] as {
          status: string;
          statusMessage: string;
        }
      ).status,
      "deprecated",
    );
    const withDeleted = await surface.list({ include_deleted: true });
    assert.deepEqual(
      withDeleted.response.servers.map((item) => item.server["name"]),
      [
        "com.example/deleted",
        "com.example/old",
        "io.modelcontextprotocol.anonymous/hybrid-mcp",
      ],
    );
    assert.ok(
      !withDeleted.response.servers.some(
        (item) => item.server["name"] === "com.example/vanished",
      ),
      "unlisted tombstones are never public",
    );
    const since = await surface.list({ updated_since: "2026-01-04T00:00:00Z" });
    assert.deepEqual(
      since.response.servers.map((item) => item.server["name"]),
      ["com.example/deleted", "com.example/old"],
      "updated_since implies include_deleted",
    );
    const latest = await surface.list({ version: "latest", search: "HYBRID" });
    assert.deepEqual(
      latest.response.servers.map((item) => item.server["name"]),
      ["io.modelcontextprotocol.anonymous/hybrid-mcp"],
    );
    const paged = await surface.list({ limit: 1 });
    assert.equal(paged.response.servers.length, 1);
    assert.ok(paged.response.metadata.nextCursor);
    const next = await surface.list({
      limit: 1,
      cursor: paged.response.metadata.nextCursor,
    });
    assert.equal(
      next.response.servers[0]!.server["name"],
      "io.modelcontextprotocol.anonymous/hybrid-mcp",
    );
    assert.equal(next.response.metadata.nextCursor, undefined);
    await assert.rejects(
      surface.list({ cursor: "bm90LWEtZGlnZXN0" }),
      (error: unknown) =>
        error instanceof ConnectorError &&
        error.detail === "subregistry.cursor.invalid",
    );
    await assert.rejects(surface.list({ limit: 1000 }));
    const versions = await surface.versions(
      "io.modelcontextprotocol.anonymous/hybrid-mcp",
    );
    assert.equal(versions.response.servers.length, 1);
    assert.equal(
      (await surface.version(
        "io.modelcontextprotocol.anonymous/hybrid-mcp",
        "latest",
      ))!.server["version"],
      "1.5.0",
    );
    assert.equal(
      await surface.version("com.example/deleted", "1.0.0"),
      undefined,
    );
    assert.equal(
      (await surface.version("com.example/deleted", "1.0.0", {
        include_deleted: true,
      }))!.server["name"],
      "com.example/deleted",
    );
    assert.equal(
      await surface.version("com.example/intranet", "1.0.0"),
      undefined,
    );
    assert.equal(
      await surface.version(
        "io.modelcontextprotocol.anonymous/brave-search",
        "1.0.2",
      ),
      undefined,
      "not marked public",
    );
    const withPublisher = publicSubregistryProjection(view, {
      public: () => true,
      includePublisherMeta: true,
    });
    const brave = (await withPublisher.version(
      "io.modelcontextprotocol.anonymous/brave-search",
      "1.0.2",
    ))!;
    assert.deepEqual(Object.keys(brave.server["_meta"] as object), [
      "io.modelcontextprotocol.registry/publisher-provided",
    ]);
    const env = (
      brave.server["packages"] as Array<{
        environmentVariables: Array<Record<string, unknown>>;
      }>
    )[0]!.environmentVariables[0]!;
    assert.deepEqual(env, {
      name: "BRAVE_API_KEY",
      description: "Brave Search API Key",
      isRequired: true,
      isSecret: true,
    });
  } finally {
    await double.close();
  }
});

test("the private catalog shows the tenant every entry, tombstone and provenance, and still never a secret value", async () => {
  const { double, view, byName } = await snapshot();
  try {
    const surface = privateCatalogProjection(view, fixtureActor);
    const { response } = await surface.list();
    assert.equal(
      response.servers.length,
      6,
      "deleted and unlisted are visible by default",
    );
    const text = JSON.stringify(response);
    assert.doesNotMatch(
      text,
      new RegExp(TOKEN_CANARY.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")),
    );
    assert.match(
      text,
      /10\.0\.0\.5/,
      "private sources are the tenant's own to see",
    );
    const vanished = response.servers.find(
      (item) => item.server["name"] === "com.example/vanished",
    )!;
    const meta = vanished._meta[CEREMONY_SNAPSHOT_META_KEY] as {
      tombstone: { reason: string };
      sourceId: string;
      pinned: boolean;
      identityDigest: string;
    };
    assert.equal(meta.tombstone.reason, "unlisted");
    assert.equal(meta.sourceId, "registry-fixture");
    assert.equal(meta.pinned, false);
    assert.equal(
      meta.identityDigest,
      byName("com.example/vanished").identityDigest,
    );
    const hybrid = response.servers.find(
      (item) =>
        item.server["name"] === "io.modelcontextprotocol.anonymous/hybrid-mcp",
    )!;
    assert.deepEqual(
      hybrid._meta["com.example.subregistry/custom"],
      { rating: 5 },
      "subregistry namespaces are kept inertly",
    );
    const deleted = response.servers.find(
      (item) => item.server["name"] === "com.example/deleted",
    )!;
    assert.equal(
      (
        deleted._meta[CEREMONY_SNAPSHOT_META_KEY] as {
          tombstone: { reason: string; message: string };
        }
      ).tombstone.message,
      "spam",
    );
    const active = await surface.list({ include_deleted: false });
    assert.equal(active.response.servers.length, 4);
    assert.throws(
      () =>
        privateCatalogProjection(view, {
          ...fixtureActor,
          tenantId: "tenant-b",
        }),
      (error: unknown) =>
        error instanceof ConnectorError && error.code === "denied",
    );
    assert.throws(
      () => privateCatalogProjection(view, { ...fixtureActor, subjectId: "" }),
      (error: unknown) =>
        error instanceof ConnectorError && error.code === "denied",
    );
  } finally {
    await double.close();
  }
});

test("public routability refuses private, loopback, link-local, special-use and insecure endpoints", () => {
  for (const url of [
    "https://mcp.example.com/mcp",
    "https://{tenant}.api.example.com/mcp",
    "https://[2606:4700::1111]/mcp",
    "https://8.8.8.8/mcp",
  ])
    assert.equal(isPubliclyRoutableUrl(url), true, url);
  for (const url of [
    "http://mcp.example.com/mcp",
    "https://localhost/mcp",
    "https://127.0.0.1/mcp",
    "https://10.1.2.3/mcp",
    "https://172.16.0.9/mcp",
    "https://192.168.1.1/mcp",
    "https://169.254.169.254/latest/meta-data",
    "https://100.64.0.1/mcp",
    "https://[::1]/mcp",
    "https://[fd12::1]/mcp",
    "https://[fe80::1]/mcp",
    "https://[::ffff:10.0.0.1]/mcp",
    "https://intranet/mcp",
    "https://mcp.corp.internal/mcp",
    "https://printer.local/mcp",
    "https://user:pw@mcp.example.com/mcp",
    "not a url",
  ])
    assert.equal(isPubliclyRoutableUrl(url), false, url);
});
