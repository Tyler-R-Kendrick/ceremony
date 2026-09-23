import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import {
  OFFICIAL_MCP_REGISTRY_SOURCE,
  SERVER_JSON_SCHEMA_URL,
  createMcpRegistryClient,
  normalizeRegistryBaseUrl,
  type ServerJsonExport,
} from "../../../src/server/connectors/registries/mcp/index.js";
import { ConnectorError } from "../../../src/server/connectors/errors.js";
import {
  registryEntry,
  startMcpRegistryDouble,
} from "../doubles/mcp-registry.js";
import { sampleEntries } from "./support.js";

/*
 * REG-01: the read client against a registry double written from the
 * documented API. Bounded pages, verbatim filters, single encoding of path
 * segments, per-entry validation and sanitized failure codes.
 */

let double: Awaited<ReturnType<typeof startMcpRegistryDouble>>;

before(async () => {
  double = await startMcpRegistryDouble({
    entries: sampleEntries(),
    poisoned: [
      {
        afterIndex: 0,
        raw: {
          server: { name: "../../etc/passwd", description: "x", version: "1" },
        },
      },
      {
        afterIndex: 0,
        raw: {
          server: { name: "io.github.x/y", description: "x", version: "1" },
          _meta: {
            "io.modelcontextprotocol.registry/official": { status: "purged" },
          },
        },
      },
      {
        afterIndex: 0,
        raw: {
          server: {
            name: "io.github.big/one",
            description: "y".repeat(70_000),
            version: "1",
          },
        },
      },
      { afterIndex: 0, raw: "not-an-object" },
    ],
  });
});
after(() => double.close());

const client = () =>
  createMcpRegistryClient({ baseUrl: double.origin, fetch: globalThis.fetch });

test("lists pages within the documented bounds and follows nextCursor", async () => {
  const registry = client();
  const first = await registry.list({ limit: 2 });
  assert.equal(first.entries.length, 2);
  assert.equal(first.nextCursor, "com.example/beta:1.0.0");
  assert.equal(
    first.count,
    6,
    "the double splices four poisoned values into this page; the client reports the registry's own count and validates entries itself",
  );
  const second = await registry.list({ limit: 2, cursor: first.nextCursor });
  assert.deepEqual(
    second.entries.map(
      (entry) => `${entry.identity.nativeId}@${entry.identity.nativeVersion}`,
    ),
    ["io.github.a/b@1.0.0-rc.1", "io.github.a/b@1.0.0"],
  );
  const requests = double.received("GET", "/v0.1/servers");
  assert.equal(
    requests.at(-1)!.url.searchParams.get("cursor"),
    "com.example/beta:1.0.0",
  );
  assert.equal(requests.at(-1)!.url.searchParams.get("limit"), "2");
  const all = await registry.listAll({ limit: 3 });
  assert.equal(all.complete, true);
  assert.equal(all.pages.length, 3);
  assert.equal(all.pages.flatMap((page) => page.entries).length, 7);
  const bounded = await registry.listAll({ limit: 2 }, { maxPages: 2 });
  assert.equal(bounded.complete, false);
  assert.equal(bounded.reason, "pages");
  assert.equal(bounded.nextCursor, "io.github.a/b:1.0.0");
});

test("refuses limits above the documented maximum and passes filters verbatim", async () => {
  const registry = client();
  await assert.rejects(registry.list({ limit: 101 }), (error: unknown) => {
    assert.ok(error instanceof ConnectorError);
    assert.equal(error.code, "invalid-request");
    assert.equal(error.detail, "registry.limit.invalid");
    return true;
  });
  assert.throws(
    () =>
      createMcpRegistryClient({
        baseUrl: double.origin,
        fetch: globalThis.fetch,
        limits: { pageLimit: 500 },
      }),
    /not valid/,
  );
  const before = double.received("GET", "/v0.1/servers").length;
  await registry.list({
    search: "hybrid",
    updatedSince: "2026-01-01T00:00:00Z",
    version: "latest",
    includeDeleted: true,
  });
  const request = double.received("GET", "/v0.1/servers").at(-1)!;
  assert.equal(double.received("GET", "/v0.1/servers").length, before + 1);
  assert.equal(request.url.searchParams.get("search"), "hybrid");
  assert.equal(
    request.url.searchParams.get("updated_since"),
    "2026-01-01T00:00:00Z",
  );
  assert.equal(request.url.searchParams.get("version"), "latest");
  assert.equal(request.url.searchParams.get("include_deleted"), "true");
  assert.equal(request.headers.accept, "application/json");
  assert.equal(request.headers.authorization, undefined);
  await assert.rejects(
    registry.list({ updatedSince: "yesterday" }),
    /not valid/,
  );
  await assert.rejects(
    registry.list({ search: `a${String.fromCharCode(7)}b` }),
    /not valid/,
  );
});

test("encodes server names and versions exactly once (AC-IMP-03)", async () => {
  const registry = client();
  const versions = await registry.versions("io.github.a/b");
  assert.equal(versions.entries.length, 2);
  const versionsRequest = double.requests.at(-1)!;
  assert.equal(
    versionsRequest.url.pathname,
    "/v0.1/servers/io.github.a%2Fb/versions",
  );
  const pinned = await registry.version("io.github.a/b", "1.0.0-rc.1");
  assert.equal(
    double.requests.at(-1)!.url.pathname,
    "/v0.1/servers/io.github.a%2Fb/versions/1.0.0-rc.1",
  );
  assert.equal(pinned.identity.nativeId, "io.github.a/b");
  assert.equal(pinned.identity.nativeVersion, "1.0.0-rc.1");
  assert.equal(pinned.identity.authorityNamespace, "io.github.a");
  assert.equal(pinned.identity.ecosystem, "mcp-registry");
  const latest = await registry.version("io.github.a/b", "latest");
  assert.equal(latest.identity.nativeVersion, "1.0.0");
  assert.equal(latest.official?.isLatest, true);
  double.publish({
    $schema:
      "https://static.modelcontextprotocol.io/schemas/2025-12-11/server.schema.json",
    name: "io.github.a/b",
    description: "build metadata version",
    version: "2.0.0+build.7 (rc)",
  });
  const odd = await registry.version("io.github.a/b", "2.0.0+build.7 (rc)");
  assert.equal(odd.identity.nativeVersion, "2.0.0+build.7 (rc)");
  assert.equal(
    double.requests.at(-1)!.url.pathname,
    "/v0.1/servers/io.github.a%2Fb/versions/2.0.0%2Bbuild.7%20%28rc%29",
  );
});

test("refuses poisoned names and versions before any request leaves", async () => {
  const registry = client();
  const before = double.requests.length;
  for (const name of [
    "../x",
    "io.github.a/..",
    "a/b/c",
    "no-slash",
    `io.github.a/${String.fromCharCode(7)}b`,
    "__proto__",
    "x".repeat(201),
  ])
    await assert.rejects(registry.versions(name), (error: unknown) => {
      assert.ok(error instanceof ConnectorError);
      assert.equal(error.detail, "registry.name.invalid");
      return true;
    });
  await assert.rejects(
    registry.version("io.github.a/b", `1.0${String.fromCharCode(0)}`),
    (error: unknown) => {
      assert.ok(error instanceof ConnectorError);
      assert.equal(error.detail, "registry.version.invalid");
      return true;
    },
  );
  assert.equal(double.requests.length, before);
});

test("reports poisoned entries as issues, keeps the page, and preserves unknown fields inertly", async () => {
  const registry = client();
  const page = await registry.list({ limit: 1 });
  assert.equal(page.entries.length, 1);
  assert.deepEqual(page.issues.map((issue) => issue.code).sort(), [
    "registry.entry.invalid",
    "registry.entry.invalid",
    "registry.entry.meta-invalid",
    "registry.entry.oversized",
  ]);
  assert.ok(
    page.issues.every(
      (issue) =>
        issue.disposition === "rejected" &&
        issue.sourcePointer.startsWith("servers["),
    ),
  );
  double.entries.push(
    registryEntry(
      {
        $schema:
          "https://static.modelcontextprotocol.io/schemas/2025-12-11/server.schema.json",
        name: "io.github.future/fields",
        description: "carries fields this reader does not know",
        version: "1.0.0",
        futureField: { nested: true },
        remotes: [
          {
            type: "streamable-http",
            url: "https://future.example.com/mcp",
            futureTransportField: 1,
          },
        ],
      },
      {
        publishedAt: "2026-05-01T00:00:00Z",
        ...({ futureMeta: "x" } as object),
      },
      { "com.example.subregistry/custom": { rating: 4.5 } },
    ),
  );
  const entry = await registry.version("io.github.future/fields", "latest");
  assert.deepEqual(entry.server["futureField"], { nested: true });
  assert.equal(
    (entry.server.remotes?.[0] as Record<string, unknown>)[
      "futureTransportField"
    ],
    1,
  );
  assert.equal((entry.official as Record<string, unknown>)["futureMeta"], "x");
  assert.deepEqual(entry.meta, {
    "com.example.subregistry/custom": { rating: 4.5 },
  });
  assert.equal(entry.status, "active");
  assert.match(entry.entryDigest, /^[a-f0-9]{64}$/);
  assert.notEqual(entry.entryDigest, entry.serverDigest);
});

test("maps upstream failures to sanitized codes without echoing bodies", async () => {
  const registry = client();
  await assert.rejects(
    registry.version("io.github.a/b", "9.9.9"),
    (error: unknown) => {
      assert.ok(error instanceof ConnectorError);
      assert.equal(error.code, "not-found");
      assert.equal(error.detail, "registry.not-found");
      assert.doesNotMatch(error.message, /server version not found/);
      return true;
    },
  );
  double.faults.staleCursors = new Set(["com.example/alpha:1.0.0"]);
  await assert.rejects(
    registry.list({ cursor: "com.example/alpha:1.0.0" }),
    (error: unknown) => {
      assert.ok(error instanceof ConnectorError);
      assert.equal(error.code, "upstream-rejected");
      assert.equal(error.detail, "registry.cursor.stale");
      return true;
    },
  );
  double.faults.staleCursors = undefined;
  await assert.rejects(
    registry.list({ cursor: "never-issued:1" }),
    (error: unknown) => {
      assert.ok(
        error instanceof ConnectorError &&
          error.detail === "registry.cursor.stale",
      );
      return true;
    },
  );
  double.resetListRequests();
  double.faults.failListRequest = { at: 1, status: 503 };
  await assert.rejects(registry.list(), (error: unknown) => {
    assert.ok(error instanceof ConnectorError);
    assert.equal(error.code, "upstream-unavailable");
    assert.equal(error.detail, "registry.upstream-status");
    return true;
  });
  double.resetListRequests();
  double.faults.failListRequest = { at: 1, status: 429 };
  await assert.rejects(
    registry.list(),
    (error: unknown) =>
      error instanceof ConnectorError && error.code === "rate-limited",
  );
  double.resetListRequests();
  double.faults.failListRequest = { at: 1, disconnect: true };
  await assert.rejects(registry.list(), (error: unknown) => {
    assert.ok(error instanceof ConnectorError);
    assert.equal(error.code, "upstream-unavailable");
    assert.equal(error.detail, "registry.network");
    return true;
  });
  double.faults.failListRequest = undefined;
  double.faults.malformedList = true;
  await assert.rejects(registry.list(), (error: unknown) => {
    assert.ok(error instanceof ConnectorError);
    assert.equal(error.detail, "json.invalid");
    return true;
  });
  double.faults.malformedList = false;
  double.faults.oversizedList = true;
  await assert.rejects(registry.list(), (error: unknown) => {
    assert.ok(error instanceof ConnectorError);
    assert.equal(error.detail, "registry.response.oversized");
    return true;
  });
  double.faults.oversizedList = false;
  double.faults.loopOnce = true;
  const looped = await registry.list({
    cursor: "com.example/alpha:1.0.0",
    limit: 1,
  });
  assert.equal(looped.nextCursor, undefined);
  assert.ok(
    looped.issues.some((issue) => issue.code === "registry.cursor.loop"),
  );
  // The registry holds its answer twenty times longer than the client waits,
  // so the timeout fires every time. A 1 ms limit against an immediate
  // loopback reply lost that race about once in two hundred calls.
  const tiny = createMcpRegistryClient({
    baseUrl: double.origin,
    fetch: globalThis.fetch,
    limits: { requestTimeoutMs: 50 },
  });
  double.faults.stallListMs = 1_000;
  await assert.rejects(
    tiny.list(),
    (error: unknown) =>
      error instanceof ConnectorError && error.detail === "registry.timeout",
  );
  double.faults.stallListMs = undefined;
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(
    registry.list({}, { signal: controller.signal }),
    (error: unknown) =>
      error instanceof ConnectorError && error.code === "cancelled",
  );
});

test("rejects pages carrying reserved keys, duplicate keys or excessive depth before materializing them", async () => {
  const hostile = await startMcpRegistryDouble();
  try {
    const registry = createMcpRegistryClient({
      baseUrl: hostile.origin,
      fetch: globalThis.fetch,
    });
    let body =
      '{"servers":[{"server":{"name":"io.github.a/b","description":"d","version":"1","__proto__":{"polluted":true}}}],"metadata":{"count":1}}';
    const proxied = createMcpRegistryClient({
      baseUrl: hostile.origin,
      fetch: async () =>
        new Response(body, {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
    });
    await assert.rejects(
      proxied.list(),
      (error: unknown) =>
        error instanceof ConnectorError && error.detail === "json.key.reserved",
    );
    body =
      '{"servers":[],"servers":[{"server":{"name":"io.github.a/b","description":"d","version":"1"}}],"metadata":{"count":1}}';
    await assert.rejects(
      proxied.list(),
      (error: unknown) =>
        error instanceof ConnectorError &&
        error.detail === "json.key.duplicate",
    );
    body = `{"servers":[],"metadata":{"count":0},"deep":${"[".repeat(40)}${"]".repeat(40)}}`;
    await assert.rejects(
      proxied.list(),
      (error: unknown) =>
        error instanceof ConnectorError &&
        error.detail === "json.depth.exceeded",
    );
    assert.equal(({} as Record<string, unknown>)["polluted"], undefined);
    void registry;
  } finally {
    await hostile.close();
  }
});

test("reads a private source's bearer token at call time and never exposes it", async () => {
  const token = "private-registry-token-canary-7731";
  const secured = await startMcpRegistryDouble({
    entries: sampleEntries(),
    readToken: token,
  });
  try {
    const anonymous = createMcpRegistryClient({
      baseUrl: secured.origin,
      fetch: globalThis.fetch,
    });
    await assert.rejects(anonymous.list(), (error: unknown) => {
      assert.ok(error instanceof ConnectorError);
      assert.equal(error.code, "denied");
      assert.equal(error.detail, "registry.unauthorized");
      return true;
    });
    let reads = 0;
    const authorized = createMcpRegistryClient({
      baseUrl: secured.origin,
      fetch: globalThis.fetch,
      bearer: async () => {
        reads++;
        return token;
      },
    });
    const page = await authorized.list({ limit: 2 });
    assert.equal(reads, 1);
    assert.equal(page.entries.length, 2);
    assert.equal(
      secured.requests.at(-1)!.headers.authorization,
      `Bearer ${token}`,
    );
    assert.doesNotMatch(JSON.stringify(page), new RegExp(token));
    assert.doesNotMatch(
      JSON.stringify(Object.keys(authorized)),
      new RegExp(token),
    );
  } finally {
    await secured.close();
  }
});

test("publication is disabled by default, requires explicit authorization, and never targets the official registry by accident", async () => {
  const registry = client();
  const document: ServerJsonExport = {
    $schema: SERVER_JSON_SCHEMA_URL,
    name: "com.example/published",
    description: "published through the double",
    version: "1.0.0",
    remotes: [
      { type: "streamable-http", url: "https://published.example.com/mcp" },
    ],
  };
  await assert.rejects(
    registry.publish(document, { authorized: true }),
    (error: unknown) =>
      error instanceof ConnectorError &&
      error.detail === "registry.publication.disabled",
  );
  let fetched = 0;
  const official = createMcpRegistryClient({
    baseUrl: OFFICIAL_MCP_REGISTRY_SOURCE.baseUrl,
    fetch: async () => {
      fetched++;
      throw new Error("must not be called");
    },
    allowPublication:
      OFFICIAL_MCP_REGISTRY_SOURCE.publication?.allowed === true,
  });
  await assert.rejects(
    official.publish(document, { authorized: true }),
    (error: unknown) =>
      error instanceof ConnectorError &&
      error.detail === "registry.publication.disabled",
  );
  assert.equal(fetched, 0);
  const publisher = await startMcpRegistryDouble({
    publishTokens: ["publish-token-1"],
  });
  try {
    const unauthenticated = createMcpRegistryClient({
      baseUrl: publisher.origin,
      fetch: globalThis.fetch,
      allowPublication: true,
    });
    await assert.rejects(
      unauthenticated.publish(document, { authorized: false }),
      (error: unknown) =>
        error instanceof ConnectorError &&
        error.detail === "registry.publication.unauthorized",
    );
    await assert.rejects(
      unauthenticated.publish(document, { authorized: true }),
      (error: unknown) =>
        error instanceof ConnectorError &&
        error.detail === "registry.authorization.missing",
    );
    const authorized = createMcpRegistryClient({
      baseUrl: publisher.origin,
      fetch: globalThis.fetch,
      allowPublication: true,
      bearer: async () => "publish-token-1",
    });
    const entry = await authorized.publish(document, { authorized: true });
    assert.equal(entry.identity.nativeId, "com.example/published");
    assert.equal(entry.official?.isLatest, true);
    const request = publisher.received("POST", "/v0.1/publish")[0]!;
    assert.equal(request.headers.authorization, "Bearer publish-token-1");
    assert.deepEqual(JSON.parse(request.body.toString("utf8")), document);
    await assert.rejects(
      authorized.publish({ ...document, packages: [] } as never, {
        authorized: true,
      }),
      /Unrecognized|unrecognized|invalid/i,
    );
  } finally {
    await publisher.close();
  }
});

test("base URLs are exact origins with an optional prefix, never credentials or traversal", () => {
  assert.equal(
    normalizeRegistryBaseUrl("https://registry.modelcontextprotocol.io/"),
    "https://registry.modelcontextprotocol.io",
  );
  assert.equal(
    normalizeRegistryBaseUrl("https://sub.example.com/registry/"),
    "https://sub.example.com/registry",
  );
  assert.equal(
    normalizeRegistryBaseUrl("http://127.0.0.1:8080"),
    "http://127.0.0.1:8080",
  );
  for (const bad of [
    "http://registry.example.com",
    "https://user:pw@example.com",
    "https://example.com/?x=1",
    "https://example.com/#f",
    "https://example.com/a/../b",
    "https://example.com//v0.1",
    "ftp://example.com",
    "not a url",
  ])
    assert.throws(
      () => normalizeRegistryBaseUrl(bad),
      (error: unknown) =>
        error instanceof ConnectorError && error.code === "network-policy",
    );
});
