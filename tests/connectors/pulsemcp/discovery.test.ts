import { test } from "node:test";
import assert from "node:assert/strict";
import { memoryPorts, fixtureActor } from "../doubles/ports.js";
import {
  startPulseMcpDouble,
  type PulseMcpDoubleOptions,
  type PulseMcpServerSeed,
} from "../doubles/pulsemcp.js";
import { buildBinding } from "../fixtures/builders.js";
import {
  createPulseMcpAdapter,
  listPulseMcpIntegrations,
  PULSEMCP_OPERATIONS,
} from "../../../src/server/connectors/registries/pulsemcp/adapter.js";
import {
  PULSEMCP_API_KEY,
  PULSEMCP_TENANT_ID,
} from "../../../src/server/connectors/registries/pulsemcp/api.js";
import { ConnectorError } from "../../../src/server/connectors/errors.js";
import type {
  AdapterCallContext,
  NormalizedDefinition,
} from "../../../src/server/connectors/adapter.js";

/*
 * CAT-04 and AC-EXT-09. PulseMCP's native API pages with offset and
 * count_per_page and answers total_count and an absolute next link; the
 * sub-registry pages with cursor and limit behind an API key and a tenant.
 * These tests hold the adapter to each contract separately.
 */

const servers: PulseMcpServerSeed[] = [
  {
    name: "Notion",
    url: "https://www.pulsemcp.com/servers/notion",
    external_url: "https://developers.notion.com/docs/mcp",
    short_description: "Read and write Notion pages and databases.",
    source_code_url: "https://github.com/makenotion/notion-mcp-server",
    github_stars: 2400,
    package_registry: "npm",
    package_name: "@notionhq/notion-mcp-server",
    package_download_count: 51000,
    EXPERIMENTAL_ai_generated_description:
      "This machine-written description must not become the connector description.",
    remotes: [
      {
        url_direct: "https://mcp.notion.com/mcp",
        url_setup: "https://mcp.notion.com/setup",
        transport: "streamable-http",
        authentication_method: "oauth2",
      },
    ],
    integrations: [{ name: "Notion", slug: "notion" }],
  },
  {
    name: "Local Filesystem",
    short_description: "Read files from a local directory.",
    source_code_url:
      "https://github.com/modelcontextprotocol/servers/tree/main/src/filesystem",
    package_registry: "npm",
    package_name: "@modelcontextprotocol/server-filesystem",
  },
  {
    name: "Open Weather",
    short_description: "Public weather data.",
    remotes: [
      {
        url_direct: "https://weather.example.com/mcp",
        transport: "streamable-http",
        authentication_method: "none",
      },
    ],
  },
  {
    name: "Globex Search",
    short_description: "Search the Globex corpus.",
    remotes: [
      { url_direct: "https://mcp.globex.example/mcp", transport: "sse" },
    ],
  },
];

type HarnessOptions = {
  profile?: "native-v0beta" | "subregistry-v0.1";
  apiKey?: string;
  tenantId?: string;
  doubleApiKey?: string;
  doubleTenantId?: string;
  cacheTtlMs?: number;
  importServerJson?: (
    document: unknown,
    provenance: { location?: string; capturedAt: string },
  ) => Promise<NormalizedDefinition[]>;
  subregistry?: PulseMcpDoubleOptions["subregistry"];
  now?: () => number;
};

async function harness(options: HarnessOptions = {}) {
  const double = await startPulseMcpDouble({
    servers,
    integrations: [
      { name: "Notion", slug: "notion", server_count: 3 },
      { name: "Weather", slug: "weather", server_count: 1 },
    ],
    ...(options.doubleApiKey ? { apiKey: options.doubleApiKey } : {}),
    ...(options.doubleTenantId ? { tenantId: options.doubleTenantId } : {}),
    ...(options.subregistry ? { subregistry: options.subregistry } : {}),
    maxCountPerPage: 5000,
  });
  const ports = memoryPorts(options.now ? { now: options.now } : {});
  if (options.apiKey) ports.configuration.set(PULSEMCP_API_KEY, options.apiKey);
  if (options.tenantId)
    ports.configuration.set(PULSEMCP_TENANT_ID, options.tenantId);
  const binding = buildBinding({
    adapterId: "pulsemcp",
    profileId: undefined,
    destinations: [
      { id: "api", origin: double.origin, network: "loopback-fixture" },
    ],
    operations: [
      {
        operationRef: PULSEMCP_OPERATIONS.nativeServers,
        nativeId: "listServers",
        destinationId: "api",
        transport: {
          kind: "http",
          method: "GET",
          pathTemplate: "/v0beta/servers",
        },
        effect: "read",
        outputClassification: "public",
        cost: "free",
        consent: "none",
        replay: "read-only",
        targetParameters: [],
      },
      {
        operationRef: PULSEMCP_OPERATIONS.nativeIntegrations,
        nativeId: "listIntegrations",
        destinationId: "api",
        transport: {
          kind: "http",
          method: "GET",
          pathTemplate: "/v0beta/integrations",
        },
        effect: "read",
        outputClassification: "public",
        cost: "free",
        consent: "none",
        replay: "read-only",
        targetParameters: [],
      },
      {
        operationRef: PULSEMCP_OPERATIONS.subregistryServers,
        nativeId: "listSubregistryServers",
        destinationId: "api",
        transport: {
          kind: "http",
          method: "GET",
          pathTemplate: "/v0.1/servers",
        },
        effect: "read",
        outputClassification: "public",
        cost: "free",
        consent: "none",
        replay: "read-only",
        targetParameters: [],
      },
    ],
    configuration: [],
    settings: options.profile ? { profile: options.profile } : {},
  });
  const ctx: AdapterCallContext = {
    actor: fixtureActor,
    binding,
    generation: 0,
    signal: AbortSignal.timeout(5000),
    environment: ports.environment({ fetch: globalThis.fetch }),
  };
  const adapter = createPulseMcpAdapter({
    ...(options.cacheTtlMs === undefined
      ? {}
      : { cacheTtlMs: options.cacheTtlMs }),
    ...(options.importServerJson
      ? { importServerJson: options.importServerJson }
      : {}),
  });
  return { double, ports, ctx, binding, adapter };
}

test("AC-EXT-09: the native API is paged with offset and count_per_page, not a registry cursor", async () => {
  const { double, ctx, adapter } = await harness();
  try {
    const first = await adapter.discover!(ctx, { limit: 2 });
    assert.deepEqual(
      first.items.map((item) => item.identity.nativeId),
      ["Notion", "Local Filesystem"],
    );
    assert.equal(first.nextCursor, "2");
    const request = double.received("GET", "/v0beta/servers")[0]!;
    assert.equal(request.url.searchParams.get("count_per_page"), "2");
    assert.equal(request.url.searchParams.get("offset"), "0");
    assert.equal(request.url.searchParams.get("cursor"), null);
    assert.equal(request.url.searchParams.get("limit"), null);
    assert.equal(
      request.headers.authorization,
      undefined,
      "the native API is documented as needing no credential",
    );
    const second = await adapter.discover!(ctx, {
      limit: 2,
      cursor: first.nextCursor!,
    });
    assert.deepEqual(
      second.items.map((item) => item.identity.nativeId),
      ["Open Weather", "Globex Search"],
    );
    assert.equal(second.nextCursor, undefined);
    assert.equal(
      double
        .received("GET", "/v0beta/servers")[1]
        ?.url.searchParams.get("offset"),
      "2",
    );
  } finally {
    await double.close();
  }
});

test("native provenance keeps PulseMCP's own documented fields", async () => {
  const { double, ctx, adapter } = await harness();
  try {
    const result = await adapter.discover!(ctx, { limit: 1, query: "notion" });
    assert.equal(
      double
        .received("GET", "/v0beta/servers")[0]
        ?.url.searchParams.get("query"),
      "notion",
    );
    const item = result.items[0]!;
    assert.equal(item.identity.ecosystem, "pulsemcp");
    assert.equal(item.identity.authorityNamespace, "pulsemcp.com");
    assert.equal(item.identity.nativeId, "Notion");
    assert.equal(item.identity.nativeVersion, "unversioned");
    assert.equal(item.provenance?.apiProfile, "v0beta");
    assert.equal(item.provenance?.packageRegistry, "npm");
    assert.equal(item.provenance?.packageName, "@notionhq/notion-mcp-server");
    assert.equal(item.provenance?.githubStars, "2400");
    assert.equal(item.provenance?.remoteUrl, "https://mcp.notion.com/mcp");
    assert.equal(item.provenance?.remoteAuthentication, "oauth2");
    assert.equal(item.provenance?.integrations, "notion");
    assert.equal(result.freshness.source, "live");
    assert.equal(result.freshness.stale, false);
  } finally {
    await double.close();
  }
});

test("import normalizes a native listing without inventing a version, tools or an installer", async () => {
  const { double, ctx, adapter } = await harness();
  try {
    const listing = servers[0]!;
    const bytes = new TextEncoder().encode(
      JSON.stringify({
        name: listing.name,
        url: listing.url,
        external_url: listing.external_url,
        short_description: listing.short_description,
        source_code_url: listing.source_code_url,
        github_stars: listing.github_stars,
        package_registry: listing.package_registry,
        package_name: listing.package_name,
        package_download_count: listing.package_download_count,
        EXPERIMENTAL_ai_generated_description:
          listing.EXPERIMENTAL_ai_generated_description,
        remotes: listing.remotes,
        integrations: listing.integrations,
      }),
    );
    const outcome = await adapter.import!(ctx, {
      bytes,
      mediaType: "application/json",
      origin: { kind: "registry", location: `${double.origin}/v0beta/servers` },
    });
    const definition = outcome.definitions[0]!;
    assert.equal(definition.identity.nativeVersion, "unversioned");
    assert.deepEqual(definition.capabilities, []);
    assert.deepEqual(definition.declaredServers, [
      { url: "https://mcp.notion.com/mcp", status: "declared" },
    ]);
    assert.equal(
      definition.display.description,
      "Read and write Notion pages and databases.",
      "the human description is the source's own short description",
    );
    assert.ok(
      !definition.display.description.includes("machine-written"),
      "the experimental machine-written text is not used as the description",
    );
    assert.ok(
      definition.compatibility.issues.some(
        (issue) => issue.code === "pulsemcp.description.machine-generated",
      ),
    );
    assert.ok(
      definition.compatibility.issues.some(
        (issue) => issue.code === "pulsemcp.package.not-approved",
      ),
    );
    assert.equal(definition.compatibility.dimensions.invoke, "unsupported");
    assert.deepEqual(outcome.executableCandidates, []);
    assert.equal(outcome.source.format.name, "pulsemcp-server");
    assert.equal(outcome.source.format.version, "v0beta");
    const native = definition.nativeExtensions as {
      pulsemcp: {
        packageName: string;
        experimentalAiGeneratedDescription: string;
      };
    };
    assert.equal(native.pulsemcp.packageName, "@notionhq/notion-mcp-server");
    assert.ok(native.pulsemcp.experimentalAiGeneratedDescription.length > 0);
  } finally {
    await double.close();
  }
});

test("a declared authentication method is preserved and blocked, and an open one is explicit", async () => {
  const { double, ctx, adapter } = await harness();
  try {
    const oauth = await adapter.import!(ctx, {
      bytes: new TextEncoder().encode(
        JSON.stringify({
          name: "Notion",
          remotes: [
            {
              url_direct: "https://mcp.notion.com/mcp",
              authentication_method: "oauth2",
            },
          ],
        }),
      ),
      mediaType: "application/json",
      origin: { kind: "registry" },
    });
    const oauthDefinition = oauth.definitions[0]!;
    assert.equal(oauthDefinition.authentication[0]?.kind, "unsupported");
    const blocking = oauthDefinition.compatibility.issues.find(
      (issue) => issue.code === "pulsemcp.auth.native-declaration",
    );
    assert.equal(blocking?.severity, "blocking");
    assert.equal(blocking?.executionImpact, "blocks-authorization");

    const open = await adapter.import!(ctx, {
      bytes: new TextEncoder().encode(
        JSON.stringify({
          name: "Open Weather",
          remotes: [
            {
              url_direct: "https://weather.example.com/mcp",
              authentication_method: "none",
            },
          ],
        }),
      ),
      mediaType: "application/json",
      origin: { kind: "registry" },
    });
    assert.deepEqual(
      open.definitions[0]!.authentication.map((profile) => profile.kind),
      ["none"],
      "a public server is described as public, not given a fabricated login",
    );
  } finally {
    await double.close();
  }
});

test("a bounded cache serves repeats and a refresh bypasses it", async () => {
  let clock = 1_000_000;
  const { double, ctx, adapter } = await harness({
    cacheTtlMs: 60_000,
    now: () => clock,
  });
  try {
    const first = await adapter.discover!(ctx, { limit: 2 });
    const cached = await adapter.discover!(ctx, { limit: 2 });
    assert.equal(double.received("GET", "/v0beta/servers").length, 1);
    assert.equal(cached.freshness.source, "snapshot");
    assert.equal(cached.freshness.stale, false);
    assert.deepEqual(
      cached.items.map((item) => item.identity.nativeId),
      first.items.map((item) => item.identity.nativeId),
    );
    const refreshed = await adapter.discover!(ctx, { limit: 2, refresh: true });
    assert.equal(double.received("GET", "/v0beta/servers").length, 2);
    assert.equal(refreshed.freshness.source, "live");
    clock += 120_000;
    await adapter.discover!(ctx, { limit: 2 });
    assert.equal(
      double.received("GET", "/v0beta/servers").length,
      3,
      "an expired snapshot is refetched",
    );
  } finally {
    await double.close();
  }
});

test("an outage serves the previous snapshot marked stale, and a cold outage fails", async () => {
  let clock = 2_000_000;
  const { double, ctx, adapter } = await harness({
    cacheTtlMs: 1,
    now: () => clock,
  });
  try {
    const live = await adapter.discover!(ctx, { limit: 2 });
    assert.equal(live.freshness.stale, false);
    clock += 10_000;
    double.control.failWith = 503;
    const stale = await adapter.discover!(ctx, { limit: 2 });
    assert.equal(stale.freshness.stale, true);
    assert.equal(stale.freshness.source, "snapshot");
    assert.deepEqual(
      stale.items.map((item) => item.identity.nativeId),
      live.items.map((item) => item.identity.nativeId),
    );
    assert.equal(stale.issues[0]?.code, "pulsemcp.refresh.failed");
    await assert.rejects(
      () => adapter.discover!(ctx, { limit: 3, query: "never-fetched" }),
      (error: unknown) =>
        error instanceof ConnectorError &&
        error.code === "upstream-unavailable",
      "an outage with no snapshot is an error, never an empty catalog",
    );
  } finally {
    await double.close();
  }
});

test("an interrupted page reports that it is incomplete and keeps paging from what arrived", async () => {
  const { double, ctx, adapter } = await harness();
  try {
    double.control.truncateAfter = 1;
    const result = await adapter.discover!(ctx, { limit: 3 });
    assert.equal(result.items.length, 1);
    assert.equal(result.issues[0]?.code, "pulsemcp.page.short");
    assert.equal(result.nextCursor, "1");
  } finally {
    await double.close();
  }
});

test("cached pages are keyed per principal and per configuration revision", async () => {
  const { double, ctx, ports, adapter } = await harness({ cacheTtlMs: 60_000 });
  try {
    await adapter.discover!(ctx, { limit: 2 });
    const otherTenant: AdapterCallContext = {
      ...ctx,
      actor: { ...ctx.actor, tenantId: "tenant-b", subjectId: "subject-2" },
    };
    await adapter.discover!(otherTenant, { limit: 2 });
    assert.equal(
      double.received("GET", "/v0beta/servers").length,
      2,
      "another tenant never reads the first tenant's snapshot",
    );
    ports.configuration.set(PULSEMCP_API_KEY, "pmk_rotated");
    await adapter.discover!(ctx, { limit: 2 });
    assert.equal(
      double.received("GET", "/v0beta/servers").length,
      3,
      "a configuration change invalidates the snapshot",
    );
  } finally {
    await double.close();
  }
});

test("the sub-registry profile sends the documented headers and cursor pagination", async () => {
  const { double, ctx, adapter } = await harness({
    profile: "subregistry-v0.1",
    apiKey: "pmk_test",
    tenantId: "tenant-alpha",
    doubleApiKey: "pmk_test",
    doubleTenantId: "tenant-alpha",
    subregistry: [
      {
        server: {
          $schema:
            "https://static.modelcontextprotocol.io/schemas/2025-12-11/server.schema.json",
          name: "com.notion/notion",
          description: "Notion MCP server.",
          version: "1.4.0",
          repository: {
            url: "https://github.com/makenotion/notion-mcp-server",
            source: "github",
          },
        },
        meta: {
          isOfficial: true,
          visitorsEstimateLastFourWeeks: 4820,
          source: "registry.modelcontextprotocol.io",
          status: "active",
          publishedAt: "2025-06-15T10:30:00Z",
        },
      },
      {
        server: {
          name: "com.example/retired",
          description: "A retired server.",
          version: "0.9.0",
        },
        meta: { status: "deleted", statusMessage: "Replaced by v2" },
      },
    ],
  });
  try {
    const result = await adapter.discover!(ctx, { limit: 1 });
    const request = double.received("GET", "/v0.1/servers")[0]!;
    assert.equal(request.headers["x-api-key"], "pmk_test");
    assert.equal(request.headers["x-tenant-id"], "tenant-alpha");
    assert.equal(request.url.searchParams.get("limit"), "1");
    assert.equal(request.url.searchParams.get("count_per_page"), null);
    assert.equal(result.nextCursor, "1");
    const item = result.items[0]!;
    assert.equal(item.identity.nativeId, "com.notion/notion");
    assert.equal(item.identity.authorityNamespace, "com.notion");
    assert.equal(
      item.identity.nativeVersion,
      "1.4.0",
      "the sub-registry does expose a version, and it is used",
    );
    assert.equal(item.provenance?.apiProfile, "v0.1");
    assert.equal(item.provenance?.documentShape, "server.json");
    assert.equal(item.provenance?.source, "registry.modelcontextprotocol.io");
    assert.equal(item.provenance?.isOfficialFlag, "true");
    assert.equal(item.status, "active");
    const second = await adapter.discover!(ctx, { limit: 1, cursor: "1" });
    assert.equal(second.items[0]?.status, "deleted");
    assert.equal(second.items[0]?.provenance?.statusMessage, "Replaced by v2");
  } finally {
    await double.close();
  }
});

test("the sub-registry profile fails closed without credentials and refuses a forged cursor upstream", async () => {
  const missing = await harness({
    profile: "subregistry-v0.1",
    doubleApiKey: "pmk_test",
  });
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
  const wrong = await harness({
    profile: "subregistry-v0.1",
    apiKey: "pmk_wrong",
    doubleApiKey: "pmk_test",
  });
  try {
    await assert.rejects(
      () => wrong.adapter.discover!(wrong.ctx, {}),
      (error: unknown) =>
        error instanceof ConnectorError && error.code === "unauthenticated",
    );
  } finally {
    await wrong.double.close();
  }
});

test("a sub-registry entry is imported only through a wired server.json importer", async () => {
  const entry = {
    server: {
      name: "com.notion/notion",
      description: "Notion MCP server.",
      version: "1.4.0",
    },
  };
  const bytes = new TextEncoder().encode(JSON.stringify(entry));
  const without = await harness({
    profile: "subregistry-v0.1",
    apiKey: "pmk_test",
    doubleApiKey: "pmk_test",
  });
  try {
    await assert.rejects(
      () =>
        without.adapter.import!(without.ctx, {
          bytes,
          mediaType: "application/json",
          origin: { kind: "registry" },
        }),
      (error: unknown) =>
        error instanceof ConnectorError && error.code === "unsupported",
    );
    const row = without.adapter
      .capabilities(new Set([PULSEMCP_API_KEY]))
      .find(
        (item) =>
          item.dimension === "import" &&
          item.profile === "pulsemcp-subregistry-v0.1",
      );
    assert.equal(row?.implementation, "unsupported");
  } finally {
    await without.double.close();
  }

  const seen: unknown[] = [];
  const withImporter = await harness({
    profile: "subregistry-v0.1",
    apiKey: "pmk_test",
    doubleApiKey: "pmk_test",
    importServerJson: async (document) => {
      seen.push(document);
      return [];
    },
  });
  try {
    const outcome = await withImporter.adapter.import!(withImporter.ctx, {
      bytes,
      mediaType: "application/json",
      origin: { kind: "registry" },
    });
    assert.deepEqual(outcome.definitions, []);
    assert.deepEqual(
      seen,
      [entry.server],
      "the inner server.json is handed over whole",
    );
    assert.equal(outcome.source.identity.nativeId, "com.notion/notion");
  } finally {
    await withImporter.double.close();
  }
});

test("integrations are listed as PulseMCP documents them", async () => {
  const { double, ctx } = await harness();
  try {
    const integrations = await listPulseMcpIntegrations(ctx);
    assert.deepEqual(
      integrations.map((integration) => integration.slug),
      ["notion", "weather"],
    );
    assert.equal(double.received("GET", "/v0beta/integrations").length, 1);
  } finally {
    await double.close();
  }
});

test("the catalog boundary stays visible in the capability rows", async () => {
  const { double, adapter } = await harness();
  try {
    // provider-backed, because this adapter really implements discovery and
    // import; the contract reserves catalog-only for implementing nothing.
    // The catalog boundary is reported per dimension instead, which the
    // assertions below check.
    assert.equal(adapter.support, "provider-backed");
    const rows = adapter.capabilities(new Set());
    const native = rows.find(
      (row) =>
        row.dimension === "discover" && row.profile === "pulsemcp-v0beta",
    )!;
    assert.equal(native.implementation, "implemented");
    assert.ok(
      native.limitations.some((text) =>
        text.includes("offset and count_per_page"),
      ),
    );
    assert.ok(native.limitations.some((text) => text.includes("sunset")));
    for (const dimension of [
      "invoke",
      "authorize",
      "verify",
      "export",
    ] as const)
      assert.equal(
        rows.find((row) => row.dimension === dimension)?.implementation,
        "unsupported",
        dimension,
      );
    assert.equal(
      rows.find(
        (row) =>
          row.dimension === "discover" &&
          row.profile === "pulsemcp-subregistry-v0.1",
      )?.configuration,
      "missing",
    );
  } finally {
    await double.close();
  }
});

test("a malformed or hostile response is refused rather than half-read", async () => {
  const { double, ctx, adapter } = await harness();
  try {
    double.control.malformed = true;
    await assert.rejects(
      () => adapter.discover!(ctx, { limit: 2 }),
      (error: unknown) =>
        error instanceof ConnectorError && error.code === "upstream-rejected",
    );
    double.control.malformed = false;
    await assert.rejects(
      () =>
        adapter.import!(ctx, {
          bytes: new TextEncoder().encode('{"description":"no name"}'),
          mediaType: "application/json",
          origin: { kind: "upload" },
        }),
      (error: unknown) =>
        error instanceof ConnectorError && error.code === "invalid-request",
    );
    await assert.rejects(
      () => adapter.discover!(ctx, { cursor: "not-an-offset" }),
      (error: unknown) =>
        error instanceof ConnectorError && error.code === "invalid-request",
    );
  } finally {
    await double.close();
  }
});
