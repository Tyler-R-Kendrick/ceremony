import assert from "node:assert/strict";
import { test } from "node:test";
import { SQLiteCeremonyStore } from "../../../src/server/persistence/index.js";
import { ConnectorError } from "../../../src/server/connectors/errors.js";
import {
  RegistrySnapshotStore,
  ceremonyStoreRegistrySnapshotStorage,
  createMcpRegistryClient,
  memoryRegistrySnapshotStorage,
  type RegistrySnapshotStorage,
} from "../../../src/server/connectors/registries/mcp/index.js";
import { memoryPorts } from "../doubles/ports.js";
import { startMcpRegistryDouble } from "../doubles/mcp-registry.js";
import { keyring, sampleEntries } from "./support.js";

/*
 * REG-03 / AC-MCP-07: several pages, tombstones, changed versions, outages,
 * stale cursors, duplicates and pins against the loopback double, over the
 * memory storage and the shared encrypted SQLite store.
 */

const tenant = "tenant-a";
const schema =
  "https://static.modelcontextprotocol.io/schemas/2025-12-11/server.schema.json";

async function harness(
  options: {
    storage?: RegistrySnapshotStorage;
    readToken?: string;
    bearer?: () => Promise<string | undefined>;
  } = {},
) {
  const double = await startMcpRegistryDouble({
    entries: sampleEntries(),
    ...(options.readToken ? { readToken: options.readToken } : {}),
  });
  const client = createMcpRegistryClient({
    baseUrl: double.origin,
    fetch: globalThis.fetch,
    limits: { pageLimit: 3 },
    ...(options.bearer ? { bearer: options.bearer } : {}),
  });
  const storage = options.storage ?? memoryRegistrySnapshotStorage();
  const store = new RegistrySnapshotStore({ storage, overlapMs: 60_000 });
  const source = { id: "registry-fixture", baseUrl: double.origin, client };
  return { double, client, storage, store, source };
}

test("reconciles several pages into one complete generation with include_deleted on every page", async () => {
  const { double, store, source } = await harness();
  try {
    const report = await store.refresh(tenant, source);
    assert.equal(report.state, "complete");
    assert.equal(report.pagesFetched, 3);
    assert.equal(report.entriesSeen, 7);
    assert.equal(report.generation, 1);
    assert.equal(report.freshness.stale, false);
    const requests = double.received("GET", "/v0.1/servers");
    assert.equal(requests.length, 3);
    assert.equal(requests[0]!.url.searchParams.get("cursor"), null);
    assert.equal(requests[0]!.url.searchParams.get("limit"), "3");
    assert.equal(
      requests[1]!.url.searchParams.get("cursor"),
      "io.github.a/b:1.0.0-rc.1",
    );
    assert.equal(
      requests[2]!.url.searchParams.get("cursor"),
      "io.github.e/f:1.0.0",
    );
    assert.ok(
      requests.every(
        (request) => request.url.searchParams.get("include_deleted") === "true",
      ),
    );
    const view = (await store.read(tenant, "registry-fixture"))!;
    assert.equal(view.rows.length, 7);
    assert.deepEqual(
      view.rows.map((row) => `${row.name}@${row.version}`),
      [
        "com.example/alpha@1.0.0",
        "com.example/beta@1.0.0",
        "io.github.a/b@1.0.0-rc.1",
        "io.github.a/b@1.0.0",
        "io.github.c/d@1.0.0",
        "io.github.e/f@1.0.0",
        "io.modelcontextprotocol.anonymous/hybrid-mcp@1.0.0",
      ],
    );
    const entry = await view.entry(view.rows[2]!.identityDigest);
    assert.equal(entry?.server.version, "1.0.0-rc.1");
    assert.equal(entry?.identity.nativeVersion, "1.0.0-rc.1");
    assert.equal(await store.read(tenant, "never-refreshed"), undefined);
    assert.equal(
      await store.read("tenant-b", "registry-fixture"),
      undefined,
      "snapshots are tenant-scoped",
    );
  } finally {
    await double.close();
  }
});

test("incremental refresh uses updated_since and records deletions and deprecations as visible tombstones", async () => {
  const { double, store, source } = await harness();
  try {
    await store.refresh(tenant, source);
    const header = (await store.header(tenant, "registry-fixture"))!;
    assert.equal(header.watermark, "2026-01-06T00:00:00Z");
    double.setStatus("com.example/alpha", "1.0.0", "deleted", "spam");
    double.setStatus("com.example/beta", "1.0.0", "deprecated", "use gamma");
    double.publish({
      $schema: schema,
      name: "com.example/gamma",
      description: "new",
      version: "0.1.0",
    });
    double.resetListRequests();
    const report = await store.refresh(tenant, source);
    assert.equal(report.state, "complete");
    assert.equal(report.generation, 2);
    const requests = double
      .received("GET", "/v0.1/servers")
      .slice(-report.pagesFetched);
    const since = requests[0]!.url.searchParams.get("updated_since")!;
    assert.equal(
      since,
      "2026-01-05T23:59:00.000Z",
      "the watermark minus the configured one-minute overlap",
    );
    assert.ok(
      requests.every(
        (request) => request.url.searchParams.get("updated_since") === since,
      ),
    );
    const view = (await store.read(tenant, "registry-fixture"))!;
    assert.equal(view.rows.length, 8);
    const alpha = view.rows.find((row) => row.name === "com.example/alpha")!;
    assert.equal(alpha.status, "deleted");
    assert.equal(alpha.tombstone?.reason, "deleted");
    assert.equal(alpha.tombstone?.message, "spam");
    assert.ok(
      await view.entry(alpha.identityDigest),
      "tombstoned content stays readable",
    );
    const beta = view.rows.find((row) => row.name === "com.example/beta")!;
    assert.equal(beta.status, "deprecated");
    assert.equal(beta.deprecation?.message, "use gamma");
    assert.ok(view.rows.some((row) => row.name === "com.example/gamma"));
    const after = (await store.header(tenant, "registry-fixture"))!;
    assert.equal(after.tombstoneCount, 1);
    assert.equal(after.deprecatedCount, 1);
    assert.equal(after.entryCount, 8);
    assert.equal(after.pending, undefined);
  } finally {
    await double.close();
  }
});

test("an outage on page 3 keeps the previous complete snapshot, marks it stale, and resumes from the persisted cursor", async () => {
  const { double, store, source, storage } = await harness();
  try {
    const first = await store.refresh(tenant, source);
    const firstAt = first.freshness.lastSuccessfulRefreshAt!;
    double.publish({
      $schema: schema,
      name: "io.github.z/late",
      description: "arrives later",
      version: "1.0.0",
    });
    double.resetListRequests();
    double.faults.failListRequest = { at: 3, status: 503 };
    const interrupted = await store.refresh(tenant, source, { mode: "full" });
    assert.equal(interrupted.state, "interrupted");
    assert.equal(interrupted.code, "upstream-unavailable");
    assert.equal(interrupted.pagesFetched, 3);
    assert.equal(
      interrupted.generation,
      1,
      "the served generation did not change",
    );
    assert.equal(interrupted.nextCursor, "io.github.e/f:1.0.0");
    assert.equal(interrupted.freshness.stale, true);
    assert.equal(interrupted.freshness.reason, "refresh-failed");
    assert.equal(interrupted.freshness.lastSuccessfulRefreshAt, firstAt);
    const stale = (await store.read(tenant, "registry-fixture"))!;
    assert.equal(stale.rows.length, 7, "no partial generation is served");
    assert.equal(stale.freshness.stale, true);
    assert.ok(!stale.rows.some((row) => row.name === "io.github.z/late"));
    const header = (await store.header(tenant, "registry-fixture"))!;
    assert.equal(header.pending?.cursor, "io.github.e/f:1.0.0");
    assert.equal(header.pending?.pagesDone, 2);
    assert.equal(header.lastFailureCode, "upstream-unavailable");
    const staged = [
      ...(storage as ReturnType<typeof memoryRegistrySnapshotStorage>)
        .inspect(tenant)
        .keys(),
    ].filter((id) => id.startsWith("registry-fixture:g2:"));
    assert.ok(staged.length > 0, "progress is persisted per page");
    double.faults.failListRequest = undefined;
    double.resetListRequests();
    const resumed = await store.refresh(tenant, source);
    assert.equal(resumed.state, "complete");
    assert.equal(resumed.pagesFetched, 1, "only the missing page is fetched");
    assert.equal(
      double
        .received("GET", "/v0.1/servers")
        .at(-1)!
        .url.searchParams.get("cursor"),
      "io.github.e/f:1.0.0",
    );
    assert.equal(resumed.generation, 2);
    assert.equal(resumed.freshness.stale, false);
    const fresh = (await store.read(tenant, "registry-fixture"))!;
    assert.equal(fresh.rows.length, 8);
    assert.ok(fresh.rows.some((row) => row.name === "io.github.z/late"));
    const collected = [
      ...(storage as ReturnType<typeof memoryRegistrySnapshotStorage>)
        .inspect(tenant)
        .keys(),
    ].filter((id) => id.startsWith("registry-fixture:g1:"));
    assert.equal(collected.length, 0, "the superseded generation is collected");
  } finally {
    await double.close();
  }
});

test("a stale persisted cursor restarts the refresh from its first page without touching the served snapshot", async () => {
  const { double, store, source } = await harness();
  try {
    await store.refresh(tenant, source);
    double.resetListRequests();
    double.faults.failListRequest = { at: 3, status: 503 };
    await store.refresh(tenant, source, { mode: "full" });
    double.faults.failListRequest = undefined;
    const stuck = (await store.header(tenant, "registry-fixture"))!.pending!
      .cursor!;
    // The registry rejects the persisted cursor once, as it does after a data
    // reset, and then serves the listing again from its first page.
    double.faults.staleCursorsOnce = new Set([stuck]);
    double.publish({
      $schema: schema,
      name: "io.github.z/late",
      description: "arrives later",
      version: "1.0.0",
    });
    double.resetListRequests();
    const report = await store.refresh(tenant, source);
    assert.equal(report.state, "complete");
    assert.ok(
      report.issues.some((issue) => issue.code === "registry.cursor.stale"),
    );
    const requests = double
      .received("GET", "/v0.1/servers")
      .slice(-report.pagesFetched);
    assert.equal(requests[0]!.url.searchParams.get("cursor"), stuck);
    assert.equal(
      requests[1]!.url.searchParams.get("cursor"),
      null,
      "restart from the first page",
    );
    const view = (await store.read(tenant, "registry-fixture"))!;
    assert.equal(view.rows.length, 8);
    assert.equal(view.generation, report.generation);
    const header = (await store.header(tenant, "registry-fixture"))!;
    assert.equal(header.pending, undefined);
    assert.deepEqual(header.abandonedGenerations, []);
  } finally {
    await double.close();
  }
});

test("a cursor the registry keeps rejecting stops the refresh instead of restarting forever", async () => {
  const { double, store, source } = await harness();
  try {
    await store.refresh(tenant, source);
    double.resetListRequests();
    double.faults.failListRequest = { at: 3, status: 503 };
    await store.refresh(tenant, source, { mode: "full" });
    double.faults.failListRequest = undefined;
    const stuck = (await store.header(tenant, "registry-fixture"))!.pending!
      .cursor!;
    double.faults.staleCursors = new Set([stuck]);
    double.resetListRequests();
    const report = await store.refresh(tenant, source);
    assert.equal(report.state, "interrupted");
    assert.equal(report.code, "upstream-rejected");
    assert.ok(report.pagesFetched <= 6, "one restart, not a loop");
    assert.ok(
      report.issues.some((issue) => issue.code === "registry.cursor.stale"),
    );
    const view = (await store.read(tenant, "registry-fixture"))!;
    assert.equal(
      view.rows.length,
      7,
      "the last complete snapshot still serves",
    );
    assert.equal(view.freshness.stale, true);
    assert.equal(view.freshness.reason, "refresh-failed");
  } finally {
    await double.close();
  }
});

test("an unlisted version becomes a tombstone on a full refresh and a duplicate listing keeps the first entry with a version.conflict issue", async () => {
  const { double, store, source } = await harness();
  try {
    await store.refresh(tenant, source);
    double.remove("io.github.e/f", "1.0.0");
    const duplicate = structuredClone(
      double.entries.find((entry) => entry.server.name === "com.example/beta")!,
    );
    duplicate.server.description = "an impostor listing of the same version";
    double.entries.push(duplicate);
    const report = await store.refresh(tenant, source, { mode: "full" });
    assert.equal(report.state, "complete");
    assert.ok(
      report.issues.some(
        (issue) =>
          issue.code === "version.conflict" &&
          /com\.example\/beta@1\.0\.0/.test(issue.message),
      ),
    );
    const view = (await store.read(tenant, "registry-fixture"))!;
    const unlisted = view.rows.find((row) => row.name === "io.github.e/f")!;
    assert.equal(unlisted.tombstone?.reason, "unlisted");
    assert.equal(
      unlisted.status,
      "active",
      "the registry never said deleted; we say unlisted",
    );
    assert.ok(await view.entry(unlisted.identityDigest));
    const beta = view.rows.filter((row) => row.name === "com.example/beta");
    assert.equal(beta.length, 1);
    assert.equal(
      (await view.entry(beta[0]!.identityDigest))!.server.description,
      "Sample server 2",
    );
    const header = (await store.header(tenant, "registry-fixture"))!;
    assert.equal(header.tombstoneCount, 1);
    double.entries.pop();
    double.rewrite("com.example/beta", "1.0.0", {
      description: "silently changed content",
    });
    const changed = await store.refresh(tenant, source);
    assert.ok(
      changed.issues.some((issue) => issue.code === "version.content-changed"),
    );
  } finally {
    await double.close();
  }
});

test("version pinning survives a later publication that changes latest", async () => {
  const { double, store, source } = await harness();
  try {
    await store.refresh(tenant, source);
    const pinned = await store.pin(tenant, "registry-fixture", {
      name: "io.github.a/b",
      version: "1.0.0",
    });
    assert.equal(pinned.isLatest, true);
    await assert.rejects(
      store.pin(tenant, "registry-fixture", {
        name: "io.github.a/b",
        version: "3.0.0",
      }),
      (error: unknown) =>
        error instanceof ConnectorError &&
        error.detail === "registry.pin.unknown",
    );
    await assert.rejects(
      store.pin(tenant, "registry-fixture", {
        name: "io.github.a/b",
        version: "latest",
      }),
    );
    double.publish({
      $schema: schema,
      name: "io.github.a/b",
      description: "newer",
      version: "1.1.0",
    });
    const report = await store.refresh(tenant, source);
    assert.equal(report.state, "complete");
    const resolved = (await store.resolve(tenant, "registry-fixture", {
      name: "io.github.a/b",
      version: "1.0.0",
    }))!;
    assert.equal(resolved.entry.server.version, "1.0.0");
    assert.equal(
      resolved.entry.server.description,
      "Sample server 3, second version",
    );
    assert.equal(resolved.row.isLatest, false);
    assert.equal(resolved.row.tombstone, undefined);
    const view = (await store.read(tenant, "registry-fixture"))!;
    assert.equal(Object.values(view.pins).length, 1);
    assert.deepEqual(Object.values(view.pins)[0]!.name, "io.github.a/b");
    const latest = view.rows.filter(
      (row) => row.name === "io.github.a/b" && row.isLatest,
    );
    assert.deepEqual(
      latest.map((row) => row.version),
      ["1.1.0"],
    );
    assert.equal(
      await store.unpin(tenant, "registry-fixture", {
        name: "io.github.a/b",
        version: "1.0.0",
      }),
      true,
    );
    assert.equal(
      await store.unpin(tenant, "registry-fixture", {
        name: "io.github.a/b",
        version: "1.0.0",
      }),
      false,
    );
  } finally {
    await double.close();
  }
});

test("the shared encrypted SQLite store persists generations under the additive record kind", async () => {
  const sqlite = new SQLiteCeremonyStore(":memory:", keyring);
  const { double, store, source } = await harness({
    storage: ceremonyStoreRegistrySnapshotStorage(sqlite),
  });
  try {
    const report = await store.refresh(tenant, source);
    assert.equal(report.state, "complete");
    double.setStatus("com.example/alpha", "1.0.0", "deleted");
    await store.refresh(tenant, source);
    const view = (await store.read(tenant, "registry-fixture"))!;
    assert.equal(view.rows.length, 7);
    assert.equal(
      view.rows.find((row) => row.name === "com.example/alpha")!.tombstone
        ?.reason,
      "deleted",
    );
    const records = await sqlite.transaction((tx) =>
      tx.list(tenant, "connector-registry-snapshot", 1000),
    );
    const ids = records.map((record) => record.id);
    assert.ok(ids.includes("registry-fixture"));
    assert.ok(ids.some((id) => id.startsWith("registry-fixture:g2:")));
    assert.ok(
      !ids.some((id) => id.startsWith("registry-fixture:g1:")),
      "collected",
    );
    assert.equal(
      ids.filter((id) => id.startsWith("registry-fixture:c:")).length,
      7,
      "content is addressed by entry digest; the superseded record of the now-deleted entry is collected with its generation",
    );
    assert.deepEqual(
      await sqlite.transaction((tx) =>
        tx.list("tenant-b", "connector-registry-snapshot"),
      ),
      [],
    );
  } finally {
    await double.close();
    await sqlite.close();
  }
});

test("a private source's bearer token is read through the configuration port and never persisted or reported", async () => {
  const token = "private-source-token-canary-4410";
  const ports = memoryPorts();
  ports.configuration.set("MCP_REGISTRY_TOKEN_PRIVATE", token);
  const { double, store, source, storage } = await harness({
    readToken: token,
    bearer: () => ports.configuration.read("MCP_REGISTRY_TOKEN_PRIVATE"),
  });
  try {
    const report = await store.refresh(tenant, source);
    assert.equal(report.state, "complete");
    const persisted = JSON.stringify([
      ...(storage as ReturnType<typeof memoryRegistrySnapshotStorage>)
        .inspect(tenant)
        .values(),
    ]);
    assert.doesNotMatch(persisted, new RegExp(token));
    assert.doesNotMatch(JSON.stringify(report), new RegExp(token));
    ports.configuration.set("MCP_REGISTRY_TOKEN_PRIVATE", undefined);
    const denied = await store.refresh(tenant, source, { mode: "full" });
    assert.equal(denied.state, "interrupted");
    assert.equal(denied.code, "denied");
    assert.doesNotMatch(JSON.stringify(denied), new RegExp(token));
    assert.equal(
      (await store.read(tenant, "registry-fixture"))!.rows.length,
      7,
    );
  } finally {
    await double.close();
  }
});

test("concurrent refreshes of one source conflict instead of interleaving generations", async () => {
  const { double, store, source } = await harness();
  try {
    const outcomes = await Promise.allSettled([
      store.refresh(tenant, source),
      store.refresh(tenant, source),
    ]);
    const rejected = outcomes.filter(
      (outcome) => outcome.status === "rejected",
    );
    assert.equal(rejected.length, 1);
    const reason = (rejected[0] as PromiseRejectedResult)
      .reason as ConnectorError;
    assert.ok(reason instanceof ConnectorError);
    assert.equal(reason.code, "conflict");
    assert.equal(reason.detail, "registry.refresh.concurrent");
    const view = (await store.read(tenant, "registry-fixture"))!;
    assert.equal(view.rows.length, 7);
  } finally {
    await double.close();
  }
});

test("a changed base URL for the same source id is refused rather than merged", async () => {
  const { double, store, source } = await harness();
  try {
    await store.refresh(tenant, source);
    await assert.rejects(
      store.refresh(tenant, {
        ...source,
        baseUrl: "https://other.example.com",
      }),
      (error: unknown) =>
        error instanceof ConnectorError &&
        error.detail === "registry.source.changed",
    );
    await assert.rejects(
      store.refresh(tenant, { ...source, id: "not valid!" }),
      (error: unknown) =>
        error instanceof ConnectorError &&
        error.detail === "registry.source.invalid",
    );
  } finally {
    await double.close();
  }
});
