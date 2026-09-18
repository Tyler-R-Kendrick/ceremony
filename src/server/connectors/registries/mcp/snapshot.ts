import type { CompatibilityIssue } from "../../../../core/connectors/contracts.js";
import {
  sourceIdentityDigest,
  type ConnectorSourceIdentity,
} from "../../../../core/connectors/identity.js";
import { identifierSchema } from "../../../../core/operation-contracts.js";
import {
  PersistenceConflict,
  type AsyncCeremonyStore,
  type RecordKind,
} from "../../../persistence/index.js";
import { ConnectorError } from "../../errors.js";
import type { McpRegistryClient, RegistryEntry, RegistryPage } from "./client.js";
import {
  registryServerNameSchema,
  registryVersionSchema,
  type RegistryOfficialMeta,
  type RegistryStatus,
  type ServerJson,
} from "./schemas.js";

/*
 * Durable registry snapshots. A snapshot is a generation: an index of every
 * server version a source lists (16 shards keyed by the first hex digit of the
 * identity digest) pointing at content-addressed entry records. A refresh
 * stages pages into a *pending* generation and persists its cursor after every
 * complete page, so an outage or an exhausted budget resumes where it stopped;
 * the header only switches to the pending generation once the last page has
 * been read. Readers therefore always see a complete generation, never a mix.
 * Deleted and unlisted versions become tombstones in the new generation; they
 * are never dropped. Version pins name an identity, not "latest", so a newer
 * publication cannot move them.
 */

export const REGISTRY_SNAPSHOT_RECORD_KIND =
  "connector-registry-snapshot" satisfies RecordKind;

export interface RegistrySnapshotTransaction {
  get<T>(id: string): Promise<{ value: T; revision: number } | undefined>;
  put(id: string, value: unknown, expectedRevision: number | null): Promise<number>;
  delete(id: string, expectedRevision: number): Promise<void>;
}
export interface RegistrySnapshotStorage {
  transaction<T>(
    tenantId: string,
    work: (tx: RegistrySnapshotTransaction) => Promise<T>,
  ): Promise<T>;
}

/** Snapshot records inside the shared encrypted store, under their own record kind. */
export function ceremonyStoreRegistrySnapshotStorage(
  store: AsyncCeremonyStore,
): RegistrySnapshotStorage {
  return {
    transaction(tenantId, work) {
      return store.transaction((tx) =>
        work({
          get: (id) =>
            tx.get({ tenant: tenantId, kind: REGISTRY_SNAPSHOT_RECORD_KIND, id }),
          put: (id, value, expected) =>
            tx.put(
              { tenant: tenantId, kind: REGISTRY_SNAPSHOT_RECORD_KIND, id },
              value,
              expected,
            ),
          delete: (id, expected) =>
            tx.delete(
              { tenant: tenantId, kind: REGISTRY_SNAPSHOT_RECORD_KIND, id },
              expected,
            ),
        }),
      );
    },
  };
}

type MemoryRecord = { value: unknown; revision: number };

/** In-process storage with the same revision and atomicity rules; for tests and ephemeral caches. */
export function memoryRegistrySnapshotStorage(): RegistrySnapshotStorage & {
  inspect(tenantId: string): Map<string, MemoryRecord>;
} {
  const tenants = new Map<string, Map<string, MemoryRecord>>();
  let tail: Promise<unknown> = Promise.resolve();
  return {
    transaction(tenantId, work) {
      const run = tail.then(async () => {
        const records = tenants.get(tenantId) ?? new Map<string, MemoryRecord>();
        tenants.set(tenantId, records);
        const staged = new Map<string, MemoryRecord | null>();
        const current = (id: string): MemoryRecord | undefined => {
          if (staged.has(id)) return staged.get(id) ?? undefined;
          return records.get(id);
        };
        const result = await work({
          async get<T>(id: string) {
            const record = current(id);
            return record
              ? { value: structuredClone(record.value) as T, revision: record.revision }
              : undefined;
          },
          async put(id, value, expected) {
            const record = current(id);
            if (expected === null) {
              if (record) throw new PersistenceConflict();
              staged.set(id, { value: structuredClone(value), revision: 1 });
              return 1;
            }
            if (!record || record.revision !== expected)
              throw new PersistenceConflict();
            staged.set(id, { value: structuredClone(value), revision: expected + 1 });
            return expected + 1;
          },
          async delete(id, expected) {
            const record = current(id);
            if (!record || record.revision !== expected)
              throw new PersistenceConflict();
            staged.set(id, null);
          },
        });
        for (const [id, record] of staged)
          if (record === null) records.delete(id);
          else records.set(id, record);
        return result;
      });
      tail = run.catch(() => {});
      return run;
    },
    inspect(tenantId) {
      return tenants.get(tenantId) ?? new Map();
    },
  };
}

export type RegistryTombstone = {
  reason: "deleted" | "unlisted";
  at: string;
  message?: string;
};
export type RegistryDeprecation = { at: string; message?: string };

export type RegistryIndexRow = {
  identityDigest: string;
  /** Content address of the entry record. */
  content: string;
  serverDigest: string;
  name: string;
  version: string;
  namespace: string;
  status: RegistryStatus;
  isLatest?: boolean;
  publishedAt?: string;
  updatedAt?: string;
  tombstone?: RegistryTombstone;
  deprecation?: RegistryDeprecation;
  firstSeenAt: string;
  lastSeenAt: string;
  /** Only inside a pending generation: copied from the previous generation, not yet re-listed. */
  carried?: true;
};
type ShardRow = Omit<RegistryIndexRow, "identityDigest">;
type ShardRecord = { schemaVersion: 1; rows: Record<string, ShardRow> };

export type RegistrySnapshotEntry = {
  schemaVersion: 1;
  identity: ConnectorSourceIdentity;
  identityDigest: string;
  entryDigest: string;
  serverDigest: string;
  server: ServerJson;
  official?: RegistryOfficialMeta;
  meta: Record<string, unknown>;
  capturedAt: string;
};

export type RegistryRefreshProgress = {
  generation: number;
  mode: "full" | "incremental";
  cursor?: string;
  pagesDone: number;
  startedAt: string;
  updatedSince?: string;
  staged: number;
  bytes: number;
  watermark?: string;
  issues: CompatibilityIssue[];
  droppedIssues: number;
  conflicts: number;
  /** Restarts spent on a rejected cursor; bounded so a permanently stale cursor cannot loop. */
  restarts: number;
};

export type RegistryPin = { name: string; version: string; pinnedAt: string };

export type RegistrySnapshotHeader = {
  schemaVersion: 1;
  sourceId: string;
  baseUrl: string;
  /** 0 until the first complete refresh. */
  generation: number;
  lastSuccessfulRefreshAt?: string;
  lastAttemptAt?: string;
  lastFailureCode?: string;
  /** Latest registry `updatedAt` seen in a complete generation; the next incremental refresh starts before it. */
  watermark?: string;
  entryCount: number;
  tombstoneCount: number;
  deprecatedCount: number;
  issues: CompatibilityIssue[];
  pending?: RegistryRefreshProgress;
  pins: Record<string, RegistryPin>;
  abandonedGenerations: number[];
};

export type RegistryFreshness = {
  fetchedAt: number;
  stale: boolean;
  source: "snapshot";
  lastSuccessfulRefreshAt?: string;
  lastAttemptAt?: string;
  lastFailureCode?: string;
  reason?: "never-refreshed" | "refresh-failed" | "expired";
  refreshInProgress: boolean;
};

export type RegistryRefreshReport = {
  state: "complete" | "interrupted" | "partial" | "cancelled";
  sourceId: string;
  /** Generation served after this call. */
  generation: number;
  pagesFetched: number;
  entriesSeen: number;
  bytes: number;
  code?: string;
  nextCursor?: string;
  reason?: "pages" | "bytes" | "entries";
  issues: CompatibilityIssue[];
  freshness: RegistryFreshness;
};

export type RegistrySnapshotView = {
  tenantId: string;
  sourceId: string;
  baseUrl: string;
  generation: number;
  freshness: RegistryFreshness;
  issues: CompatibilityIssue[];
  pins: Record<string, RegistryPin>;
  /** Every row of the served generation, ordered by name, publication time, version. */
  rows: RegistryIndexRow[];
  row(identityDigest: string): RegistryIndexRow | undefined;
  entry(identityDigest: string): Promise<RegistrySnapshotEntry | undefined>;
};

export type RegistrySnapshotSource = {
  id: string;
  baseUrl: string;
  client: Pick<McpRegistryClient, "list" | "limits">;
};

export type RegistrySnapshotStoreOptions = {
  storage: RegistrySnapshotStorage;
  now?: () => number;
  /** Age after which a served snapshot reports itself stale. */
  maxAgeMs?: number;
  /** How far before the watermark an incremental refresh starts, to absorb clock skew. */
  overlapMs?: number;
  /** A pending refresh older than this is abandoned and restarted. */
  maxPendingAgeMs?: number;
  maxEntries?: number;
  maxIssues?: number;
};

/**
 * One restart per refresh. A cursor the registry keeps rejecting would
 * otherwise restart forever; after the budget the refresh stops as interrupted
 * and the last complete snapshot keeps serving.
 */
const MAX_CURSOR_RESTARTS = 1;

const shards = "0123456789abcdef".split("");
const shardOf = (digest: string) => digest[0]!;
const shardId = (sourceId: string, generation: number, shard: string) =>
  `${sourceId}:g${generation}:${shard}`;
const contentId = (sourceId: string, entryDigest: string) =>
  `${sourceId}:c:${entryDigest}`;
const emptyShard = (): ShardRecord => ({ schemaVersion: 1, rows: {} });
const clip = (value: string, max: number) =>
  value.length > max ? `${value.slice(0, max - 1)}…` : value;
const safeText = (value: string | undefined, max: number) =>
  value === undefined
    ? undefined
    : clip(value.replace(/\p{Cc}/gu, " "), max) || undefined;

function snapshotIssue(
  code: string,
  pointer: string,
  message: string,
  overrides: Partial<CompatibilityIssue> = {},
): CompatibilityIssue {
  return {
    code,
    category: "version",
    sourcePointer: pointer,
    dimension: "discover",
    disposition: "adapted",
    severity: "warning",
    executionImpact: "none",
    message,
    ...overrides,
  };
}

function initialHeader(sourceId: string, baseUrl: string): RegistrySnapshotHeader {
  return {
    schemaVersion: 1,
    sourceId,
    baseUrl,
    generation: 0,
    entryCount: 0,
    tombstoneCount: 0,
    deprecatedCount: 0,
    issues: [],
    pins: {},
    abandonedGenerations: [],
  };
}

function conflictError(error: unknown): never {
  if (error instanceof PersistenceConflict)
    throw new ConnectorError("conflict", {
      detail: "registry.refresh.concurrent",
      cause: error,
    });
  throw error;
}

function epoch(value: string | undefined): number {
  if (!value) return Number.POSITIVE_INFINITY;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : Number.POSITIVE_INFINITY;
}

function compareRows(a: RegistryIndexRow, b: RegistryIndexRow): number {
  if (a.name !== b.name) return a.name < b.name ? -1 : 1;
  const pa = epoch(a.publishedAt);
  const pb = epoch(b.publishedAt);
  if (pa !== pb) return pa < pb ? -1 : 1;
  if (a.version !== b.version) return a.version < b.version ? -1 : 1;
  return 0;
}

function laterTime(a: string | undefined, b: string | undefined): string | undefined {
  if (!a) return b;
  if (!b) return a;
  return Date.parse(b) > Date.parse(a) ? b : a;
}

export class RegistrySnapshotStore {
  private readonly storage: RegistrySnapshotStorage;
  private readonly now: () => number;
  private readonly maxAgeMs: number;
  private readonly overlapMs: number;
  private readonly maxPendingAgeMs: number;
  private readonly maxEntries: number;
  private readonly maxIssues: number;

  constructor(options: RegistrySnapshotStoreOptions) {
    this.storage = options.storage;
    this.now = options.now ?? Date.now;
    this.maxAgeMs = options.maxAgeMs ?? 2 * 60 * 60 * 1000;
    this.overlapMs = options.overlapMs ?? 10 * 60 * 1000;
    this.maxPendingAgeMs = options.maxPendingAgeMs ?? 24 * 60 * 60 * 1000;
    this.maxEntries = options.maxEntries ?? 20_000;
    this.maxIssues = options.maxIssues ?? 256;
  }

  private iso(): string {
    return new Date(this.now()).toISOString();
  }

  freshness(header: RegistrySnapshotHeader): RegistryFreshness {
    const last = header.lastSuccessfulRefreshAt
      ? Date.parse(header.lastSuccessfulRefreshAt)
      : undefined;
    const refreshInProgress = header.pending !== undefined;
    if (last === undefined || !Number.isFinite(last))
      return {
        fetchedAt: 0,
        stale: true,
        source: "snapshot",
        ...(header.lastAttemptAt ? { lastAttemptAt: header.lastAttemptAt } : {}),
        ...(header.lastFailureCode ? { lastFailureCode: header.lastFailureCode } : {}),
        reason: "never-refreshed",
        refreshInProgress,
      };
    const failedSince =
      header.lastFailureCode !== undefined &&
      header.lastAttemptAt !== undefined &&
      Date.parse(header.lastAttemptAt) >= last;
    const expired = this.now() - last > this.maxAgeMs;
    return {
      fetchedAt: last,
      stale: failedSince || expired,
      source: "snapshot",
      lastSuccessfulRefreshAt: header.lastSuccessfulRefreshAt!,
      ...(header.lastAttemptAt ? { lastAttemptAt: header.lastAttemptAt } : {}),
      ...(header.lastFailureCode ? { lastFailureCode: header.lastFailureCode } : {}),
      ...(failedSince
        ? { reason: "refresh-failed" as const }
        : expired
          ? { reason: "expired" as const }
          : {}),
      refreshInProgress,
    };
  }

  private addIssue(progress: RegistryRefreshProgress, issue: CompatibilityIssue): void {
    if (progress.issues.length >= this.maxIssues) progress.droppedIssues++;
    else progress.issues.push(issue);
  }

  private async copyGeneration(
    tx: RegistrySnapshotTransaction,
    sourceId: string,
    from: number,
    to: number,
  ): Promise<void> {
    for (const shard of shards) {
      const previous = await tx.get<ShardRecord>(shardId(sourceId, from, shard));
      if (!previous) continue;
      const rows: Record<string, ShardRow> = {};
      for (const [digest, row] of Object.entries(previous.value.rows))
        rows[digest] = { ...row, carried: true };
      await tx.put(shardId(sourceId, to, shard), { schemaVersion: 1, rows }, null);
    }
  }

  private startPending(
    header: RegistrySnapshotHeader,
    requested: "full" | "incremental" | undefined,
  ): RegistryRefreshProgress {
    const mode: "full" | "incremental" =
      header.generation === 0 ? "full" : (requested ?? "incremental");
    const generation =
      Math.max(header.generation, ...header.abandonedGenerations, 0) + 1;
    const since = header.watermark ?? header.lastSuccessfulRefreshAt;
    return {
      generation,
      mode,
      pagesDone: 0,
      startedAt: this.iso(),
      staged: 0,
      bytes: 0,
      issues: [],
      droppedIssues: 0,
      conflicts: 0,
      restarts: 0,
      ...(mode === "incremental" && since
        ? {
            updatedSince: new Date(
              Date.parse(since) - this.overlapMs,
            ).toISOString(),
          }
        : {}),
    };
  }

  private rowFor(
    entry: RegistryEntry,
    previous: ShardRow | undefined,
    now: string,
  ): ShardRow {
    const official = entry.official;
    const at = official?.statusChangedAt ?? official?.updatedAt ?? now;
    const message = safeText(official?.statusMessage, 500);
    return {
      content: entry.entryDigest,
      serverDigest: entry.serverDigest,
      name: entry.identity.nativeId,
      version: entry.identity.nativeVersion,
      namespace: entry.identity.authorityNamespace,
      status: entry.status,
      ...(official?.isLatest === undefined ? {} : { isLatest: official.isLatest }),
      ...(official?.publishedAt ? { publishedAt: official.publishedAt } : {}),
      ...(official?.updatedAt ? { updatedAt: official.updatedAt } : {}),
      ...(entry.status === "deleted"
        ? { tombstone: { reason: "deleted" as const, at, ...(message ? { message } : {}) } }
        : {}),
      ...(entry.status === "deprecated"
        ? { deprecation: { at, ...(message ? { message } : {}) } }
        : {}),
      firstSeenAt: previous?.firstSeenAt ?? now,
      lastSeenAt: now,
    };
  }

  /**
   * Fetches pages for one source within the client's budgets, persisting
   * progress after every complete page. Returns without throwing on upstream
   * failure: the report says what happened and the served snapshot is
   * untouched. Throws only for programming errors, invalid configuration and
   * concurrent refreshes of the same source.
   */
  async refresh(
    tenantId: string,
    source: RegistrySnapshotSource,
    options: {
      mode?: "full" | "incremental";
      maxPages?: number;
      signal?: AbortSignal;
    } = {},
  ): Promise<RegistryRefreshReport> {
    const sourceId = identifierSchema.safeParse(source.id);
    if (!sourceId.success)
      throw new ConnectorError("invalid-request", { detail: "registry.source.invalid" });
    const id = sourceId.data;
    const limits = source.client.limits;
    const maxPages = options.maxPages ?? limits.maxPagesPerRefresh;
    let header!: RegistrySnapshotHeader;
    let revision!: number;
    const persist = async (
      work?: (tx: RegistrySnapshotTransaction) => Promise<void>,
    ) => {
      try {
        revision = await this.storage.transaction(tenantId, async (tx) => {
          if (work) await work(tx);
          return tx.put(id, header, revision);
        });
      } catch (error) {
        conflictError(error);
      }
    };
    const report = (
      state: RegistryRefreshReport["state"],
      extra: Partial<RegistryRefreshReport>,
      pagesFetched: number,
      entriesSeen: number,
      bytes: number,
    ): RegistryRefreshReport => ({
      state,
      sourceId: id,
      generation: header.generation,
      pagesFetched,
      entriesSeen,
      bytes,
      issues: [...(header.pending?.issues ?? header.issues)],
      freshness: this.freshness(header),
      ...extra,
    });

    try {
      const loaded = await this.storage.transaction(tenantId, async (tx) => {
        const existing = await tx.get<RegistrySnapshotHeader>(id);
        const current = existing?.value ?? initialHeader(id, source.baseUrl);
        if (current.baseUrl !== source.baseUrl)
          throw new ConnectorError("conflict", { detail: "registry.source.changed" });
        if (
          current.pending &&
          ((options.mode === "full" && current.pending.mode !== "full") ||
            this.now() - Date.parse(current.pending.startedAt) > this.maxPendingAgeMs)
        ) {
          current.abandonedGenerations.push(current.pending.generation);
          delete current.pending;
        }
        if (!current.pending) {
          current.pending = this.startPending(current, options.mode);
          if (current.pending.mode === "incremental")
            await this.copyGeneration(tx, id, current.generation, current.pending.generation);
        }
        const nextRevision = await tx.put(id, current, existing?.revision ?? null);
        return { header: current, revision: nextRevision };
      });
      header = loaded.header;
      revision = loaded.revision;
    } catch (error) {
      conflictError(error);
    }

    let pagesFetched = 0;
    let entriesSeen = 0;
    let bytes = 0;
    while (pagesFetched < maxPages) {
      const pending = header.pending!;
      if (options.signal?.aborted) {
        header.lastAttemptAt = this.iso();
        header.lastFailureCode = "cancelled";
        await persist();
        return report("cancelled", { code: "cancelled" }, pagesFetched, entriesSeen, bytes);
      }
      let page: RegistryPage;
      try {
        page = await source.client.list(
          {
            ...(pending.cursor === undefined ? {} : { cursor: pending.cursor }),
            limit: limits.pageLimit,
            ...(pending.updatedSince ? { updatedSince: pending.updatedSince } : {}),
            includeDeleted: true,
          },
          options.signal ? { signal: options.signal } : {},
        );
      } catch (error) {
        const code =
          error instanceof ConnectorError ? error.code : "upstream-unavailable";
        const detail = error instanceof ConnectorError ? error.detail : undefined;
        pagesFetched++;
        if (
          detail === "registry.cursor.stale" &&
          pending.cursor !== undefined &&
          pending.restarts < MAX_CURSOR_RESTARTS
        ) {
          // The persisted cursor no longer works: restart this refresh from its
          // first page under a new generation number. The served generation is
          // not involved, and the abandoned staging is garbage-collected later.
          header.abandonedGenerations.push(pending.generation);
          const { pending: _abandoned, ...withoutPending } = header;
          void _abandoned;
          const restarted = this.startPending(withoutPending, pending.mode);
          restarted.issues = [...pending.issues];
          restarted.droppedIssues = pending.droppedIssues;
          restarted.restarts = pending.restarts + 1;
          this.addIssue(
            restarted,
            snapshotIssue(
              "registry.cursor.stale",
              `page[${pending.pagesDone}]`,
              "The registry rejected the persisted pagination cursor; the refresh restarted from its first page",
              { category: "structure" },
            ),
          );
          header.pending = restarted;
          await persist(async (tx) => {
            if (restarted.mode === "incremental")
              await this.copyGeneration(tx, id, header.generation, restarted.generation);
          });
          continue;
        }
        header.lastAttemptAt = this.iso();
        header.lastFailureCode = code;
        await persist();
        return report(
          "interrupted",
          { code, ...(pending.cursor === undefined ? {} : { nextCursor: pending.cursor }) },
          pagesFetched,
          entriesSeen,
          bytes,
        );
      }
      pagesFetched++;
      bytes += page.bytes;
      entriesSeen += page.entries.length;
      const now = this.iso();
      let tooMany = false;
      await persist(async (tx) => {
        const touched = new Map<string, { record: ShardRecord; revision: number | null }>();
        const load = async (shard: string) => {
          const cached = touched.get(shard);
          if (cached) return cached;
          const stored = await tx.get<ShardRecord>(shardId(id, pending.generation, shard));
          const loadedShard = stored
            ? { record: stored.value, revision: stored.revision }
            : { record: emptyShard(), revision: null };
          touched.set(shard, loadedShard);
          return loadedShard;
        };
        for (const [index, entry] of page.entries.entries()) {
          const pointer = `page[${pending.pagesDone}].servers[${index}]`;
          const shard = await load(shardOf(entry.identityDigest));
          const existing = shard.record.rows[entry.identityDigest];
          if (existing && !existing.carried) {
            pending.conflicts++;
            this.addIssue(
              pending,
              snapshotIssue(
                "version.conflict",
                pointer,
                `The registry listed ${clip(entry.identity.nativeId, 120)}@${clip(entry.identity.nativeVersion, 60)} twice in one refresh; the first entry was kept`,
              ),
            );
            continue;
          }
          if (existing?.carried) {
            if (existing.serverDigest !== entry.serverDigest)
              this.addIssue(
                pending,
                snapshotIssue(
                  "version.content-changed",
                  pointer,
                  `The server.json of ${clip(entry.identity.nativeId, 120)}@${clip(entry.identity.nativeVersion, 60)} changed without a version change; pinned definitions keep their reviewed digest`,
                ),
              );
            if (existing.tombstone && entry.status !== "deleted")
              this.addIssue(
                pending,
                snapshotIssue(
                  "version.resurrected",
                  pointer,
                  `A previously deleted or unlisted version of ${clip(entry.identity.nativeId, 120)} is listed again`,
                ),
              );
          }
          if (!(await tx.get(contentId(id, entry.entryDigest)))) {
            const record: RegistrySnapshotEntry = {
              schemaVersion: 1,
              identity: entry.identity,
              identityDigest: entry.identityDigest,
              entryDigest: entry.entryDigest,
              serverDigest: entry.serverDigest,
              server: entry.server,
              ...(entry.official ? { official: entry.official } : {}),
              meta: entry.meta,
              capturedAt: now,
            };
            await tx.put(contentId(id, entry.entryDigest), record, null);
          }
          shard.record.rows[entry.identityDigest] = this.rowFor(entry, existing, now);
          if (!existing || existing.carried) pending.staged++;
          const watermark = laterTime(
            pending.watermark,
            entry.official?.updatedAt ?? entry.official?.publishedAt,
          );
          if (watermark !== undefined) pending.watermark = watermark;
        }
        for (const issue of page.issues)
          this.addIssue(pending, {
            ...issue,
            sourcePointer: clip(`page[${pending.pagesDone}].${issue.sourcePointer}`, 1024),
          });
        pending.pagesDone++;
        pending.bytes += page.bytes;
        if (page.nextCursor === undefined) delete pending.cursor;
        else pending.cursor = page.nextCursor;
        tooMany = pending.staged > this.maxEntries;
        for (const [shard, { record, revision: shardRevision }] of touched)
          await tx.put(shardId(id, pending.generation, shard), record, shardRevision);
      });
      if (tooMany) {
        header.lastAttemptAt = this.iso();
        header.lastFailureCode = "registry.entries.exceeded";
        await persist();
        return report(
          "interrupted",
          { code: "registry.entries.exceeded", reason: "entries" },
          pagesFetched,
          entriesSeen,
          bytes,
        );
      }
      if (page.nextCursor === undefined) {
        await this.commit(tenantId, id, header, () => revision, (next) => {
          revision = next;
        });
        await this.collect(tenantId, id);
        return report("complete", {}, pagesFetched, entriesSeen, bytes);
      }
      if (bytes >= limits.maxBytesPerRefresh)
        return report(
          "partial",
          { reason: "bytes", nextCursor: page.nextCursor },
          pagesFetched,
          entriesSeen,
          bytes,
        );
    }
    const cursor = header.pending?.cursor;
    return report(
      "partial",
      { reason: "pages", ...(cursor === undefined ? {} : { nextCursor: cursor }) },
      pagesFetched,
      entriesSeen,
      bytes,
    );
  }

  private async commit(
    tenantId: string,
    id: string,
    header: RegistrySnapshotHeader,
    revision: () => number,
    setRevision: (next: number) => void,
  ): Promise<void> {
    const pending = header.pending!;
    const now = this.iso();
    try {
      const next = await this.storage.transaction(tenantId, async (tx) => {
        let entryCount = 0;
        let tombstoneCount = 0;
        let deprecatedCount = 0;
        for (const shard of shards) {
          const key = shardId(id, pending.generation, shard);
          const stored = await tx.get<ShardRecord>(key);
          const record = stored?.value ?? emptyShard();
          let changed = false;
          if (pending.mode === "full" && header.generation > 0) {
            const previous = await tx.get<ShardRecord>(
              shardId(id, header.generation, shard),
            );
            for (const [digest, row] of Object.entries(previous?.value.rows ?? {}))
              if (!record.rows[digest]) {
                const { carried: _carried, ...rest } = row;
                void _carried;
                record.rows[digest] = {
                  ...rest,
                  ...(rest.tombstone
                    ? {}
                    : { tombstone: { reason: "unlisted" as const, at: now } }),
                  lastSeenAt: rest.lastSeenAt,
                };
                changed = true;
              }
          }
          for (const row of Object.values(record.rows)) {
            if (row.carried) {
              delete row.carried;
              changed = true;
            }
            entryCount++;
            if (row.tombstone) tombstoneCount++;
            else if (row.status === "deprecated") deprecatedCount++;
          }
          if (changed || !stored)
            await tx.put(key, record, stored?.revision ?? null);
        }
        const previousGeneration = header.generation;
        if (previousGeneration > 0)
          header.abandonedGenerations.push(previousGeneration);
        header.generation = pending.generation;
        header.lastSuccessfulRefreshAt = now;
        header.lastAttemptAt = now;
        delete header.lastFailureCode;
        if (pending.watermark) header.watermark = pending.watermark;
        header.entryCount = entryCount;
        header.tombstoneCount = tombstoneCount;
        header.deprecatedCount = deprecatedCount;
        header.issues = pending.issues;
        delete header.pending;
        return tx.put(id, header, revision());
      });
      setRevision(next);
    } catch (error) {
      conflictError(error);
    }
  }

  /** Best-effort removal of abandoned generations and the content only they referenced. */
  async collect(tenantId: string, sourceId: string): Promise<number> {
    let removed = 0;
    try {
      await this.storage.transaction(tenantId, async (tx) => {
        const stored = await tx.get<RegistrySnapshotHeader>(sourceId);
        if (!stored) return;
        const header = stored.value;
        const live = new Set<number>([header.generation]);
        if (header.pending) live.add(header.pending.generation);
        const referenced = new Set<string>();
        for (const generation of live)
          for (const shard of shards) {
            const record = await tx.get<ShardRecord>(shardId(sourceId, generation, shard));
            for (const row of Object.values(record?.value.rows ?? {}))
              referenced.add(row.content);
          }
        const remaining: number[] = [];
        for (const generation of header.abandonedGenerations) {
          if (live.has(generation)) continue;
          for (const shard of shards) {
            const key = shardId(sourceId, generation, shard);
            const record = await tx.get<ShardRecord>(key);
            if (!record) continue;
            for (const row of Object.values(record.value.rows))
              if (!referenced.has(row.content)) {
                const content = await tx.get(contentId(sourceId, row.content));
                if (content) {
                  await tx.delete(contentId(sourceId, row.content), content.revision);
                  removed++;
                }
                referenced.add(row.content);
              }
            await tx.delete(key, record.revision);
            removed++;
          }
        }
        header.abandonedGenerations = remaining;
        await tx.put(sourceId, header, stored.revision);
      });
    } catch {
      // Collection is repeatable; a conflict here never fails the refresh.
    }
    return removed;
  }

  /** The served snapshot, or undefined before the first complete refresh. */
  async read(tenantId: string, sourceId: string): Promise<RegistrySnapshotView | undefined> {
    const id = identifierSchema.parse(sourceId);
    const loaded = await this.storage.transaction(tenantId, async (tx) => {
      const stored = await tx.get<RegistrySnapshotHeader>(id);
      if (!stored || stored.value.generation === 0) return undefined;
      const rows: RegistryIndexRow[] = [];
      for (const shard of shards) {
        const record = await tx.get<ShardRecord>(shardId(id, stored.value.generation, shard));
        for (const [identityDigest, row] of Object.entries(record?.value.rows ?? {}))
          rows.push({ identityDigest, ...row });
      }
      return { header: stored.value, rows };
    });
    if (!loaded) return undefined;
    loaded.rows.sort(compareRows);
    const byDigest = new Map(loaded.rows.map((row) => [row.identityDigest, row]));
    const { header } = loaded;
    return {
      tenantId,
      sourceId: id,
      baseUrl: header.baseUrl,
      generation: header.generation,
      freshness: this.freshness(header),
      issues: [...header.issues],
      pins: { ...header.pins },
      rows: loaded.rows,
      row: (identityDigest) => byDigest.get(identityDigest),
      entry: async (identityDigest) => {
        const row = byDigest.get(identityDigest);
        if (!row) return undefined;
        const record = await this.storage.transaction(tenantId, (tx) =>
          tx.get<RegistrySnapshotEntry>(contentId(id, row.content)),
        );
        return record?.value;
      },
    };
  }

  /** The header as stored (freshness, progress, counts); for operators and tests. */
  async header(tenantId: string, sourceId: string): Promise<RegistrySnapshotHeader | undefined> {
    const id = identifierSchema.parse(sourceId);
    const stored = await this.storage.transaction(tenantId, (tx) =>
      tx.get<RegistrySnapshotHeader>(id),
    );
    return stored?.value;
  }

  /** Pins an exact server version; the pin survives later publications because it names an identity, not `latest`. */
  async pin(
    tenantId: string,
    sourceId: string,
    target: { name: string; version: string },
  ): Promise<RegistryIndexRow> {
    const id = identifierSchema.parse(sourceId);
    const name = registryServerNameSchema.parse(target.name);
    const version = registryVersionSchema.parse(target.version);
    const digest = await sourceIdentityDigest({
      ecosystem: "mcp-registry",
      authorityNamespace: name.slice(0, name.indexOf("/")),
      nativeId: name,
      nativeVersion: version,
    });
    try {
      return await this.storage.transaction(tenantId, async (tx) => {
        const stored = await tx.get<RegistrySnapshotHeader>(id);
        if (!stored || stored.value.generation === 0)
          throw new ConnectorError("not-found", { detail: "registry.snapshot.missing" });
        const shard = await tx.get<ShardRecord>(
          shardId(id, stored.value.generation, shardOf(digest)),
        );
        const row = shard?.value.rows[digest];
        if (!row) throw new ConnectorError("not-found", { detail: "registry.pin.unknown" });
        stored.value.pins[digest] = { name, version, pinnedAt: this.iso() };
        await tx.put(id, stored.value, stored.revision);
        return { identityDigest: digest, ...row };
      });
    } catch (error) {
      conflictError(error);
    }
  }

  async unpin(tenantId: string, sourceId: string, target: { name: string; version: string }): Promise<boolean> {
    const id = identifierSchema.parse(sourceId);
    const digest = await sourceIdentityDigest({
      ecosystem: "mcp-registry",
      authorityNamespace: target.name.slice(0, target.name.indexOf("/")),
      nativeId: registryServerNameSchema.parse(target.name),
      nativeVersion: registryVersionSchema.parse(target.version),
    });
    try {
      return await this.storage.transaction(tenantId, async (tx) => {
        const stored = await tx.get<RegistrySnapshotHeader>(id);
        if (!stored || !stored.value.pins[digest]) return false;
        delete stored.value.pins[digest];
        await tx.put(id, stored.value, stored.revision);
        return true;
      });
    } catch (error) {
      conflictError(error);
    }
  }

  /** Exact lookup by native spelling; a pinned version resolves whether or not it is still `latest`. */
  async resolve(
    tenantId: string,
    sourceId: string,
    target: { name: string; version: string },
  ): Promise<{ row: RegistryIndexRow; entry: RegistrySnapshotEntry } | undefined> {
    const view = await this.read(tenantId, sourceId);
    if (!view) return undefined;
    const digest = await sourceIdentityDigest({
      ecosystem: "mcp-registry",
      authorityNamespace: target.name.slice(0, target.name.indexOf("/")),
      nativeId: registryServerNameSchema.parse(target.name),
      nativeVersion: registryVersionSchema.parse(target.version),
    });
    const row = view.row(digest);
    if (!row) return undefined;
    const entry = await view.entry(digest);
    return entry ? { row, entry } : undefined;
  }
}
