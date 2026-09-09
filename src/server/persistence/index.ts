import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { chmodSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { setTimeout as delay } from "node:timers/promises";
import { Pool, type PoolConfig } from "pg";
import { z } from "zod";

export const recordKinds = [
  "run",
  "node",
  "collection",
  "recipe",
  "draft",
  "review",
  "command",
  "effect",
  "evidence",
  "artifact",
  "handoff",
  "demonstration",
  "event",
  "outbox",
  "continuation",
  "budget",
  "session",
  "audit",
] as const;
export type RecordKind = (typeof recordKinds)[number];
export type RecordKey = { tenant: string; kind: RecordKind; id: string };
export type StoredRecord<T> = { revision: number; value: T };
export type Fence = RecordKey & { generation: number; worker: string };
export type Keyring = {
  current: string;
  keys: Readonly<Record<string, Uint8Array>>;
};
const backupKey = z.string().regex(/^[a-zA-Z0-9_.:@/-]{1,200}$/);
export const encryptedBackupSchema = z.strictObject({
  schemaVersion: z.literal(1),
  records: z
    .array(
      z.strictObject({
        tenant: backupKey,
        kind: z.enum(recordKinds),
        id: backupKey,
        revision: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
        value: z
          .string()
          .max(2_000_000)
          .regex(/^[A-Za-z0-9+/]+={0,2}$/),
      }),
    )
    .max(10000),
  claims: z
    .array(
      z.strictObject({
        tenant: backupKey,
        kind: z.enum(recordKinds),
        id: backupKey,
        generation: z
          .number()
          .int()
          .positive()
          .max(Number.MAX_SAFE_INTEGER - 1),
      }),
    )
    .max(10000),
});
export type EncryptedBackup = z.infer<typeof encryptedBackupSchema>;
export class PersistenceConflict extends Error {
  constructor() {
    super("Persistence revision or fencing conflict");
  }
}
export interface AsyncTransaction {
  now(): Promise<number>;
  get<T>(key: RecordKey): Promise<StoredRecord<T> | undefined>;
  put(
    key: RecordKey,
    value: unknown,
    expectedRevision: number | null,
  ): Promise<number>;
  delete(key: RecordKey, expectedRevision: number): Promise<void>;
  list<T>(
    tenant: string,
    kind: RecordKind,
    limit?: number,
    afterId?: string,
  ): Promise<Array<StoredRecord<T> & { id: string }>>;
  claim(key: RecordKey, worker: string, durationMs: number): Promise<Fence>;
  heartbeat(fence: Fence, durationMs: number): Promise<void>;
  assertFence(fence: Fence): Promise<void>;
  cancel(key: RecordKey): Promise<void>;
}
export interface AsyncCeremonyStore {
  transaction<T>(work: (tx: AsyncTransaction) => Promise<T>): Promise<T>;
  close(): Promise<void>;
}
type Row = Record<string, unknown>;
type Query = (sql: string, parameters?: unknown[]) => Promise<Row[]>;
const migration = `CREATE TABLE IF NOT EXISTS ceremony_records (
 tenant TEXT NOT NULL, kind TEXT NOT NULL, id TEXT NOT NULL,
 revision BIGINT NOT NULL, value BYTEA NOT NULL, PRIMARY KEY(tenant,kind,id));
 CREATE TABLE IF NOT EXISTS ceremony_claims (
 tenant TEXT NOT NULL, kind TEXT NOT NULL, id TEXT NOT NULL,
 generation BIGINT NOT NULL, worker TEXT NOT NULL, expires BIGINT NOT NULL,
 PRIMARY KEY(tenant,kind,id));`;
function parameters(key: RecordKey): string[] {
  if (
    !recordKinds.includes(key.kind) ||
    ![key.tenant, key.id].every(
      (v) => typeof v === "string" && /^[a-zA-Z0-9_.:@/-]{1,200}$/.test(v),
    )
  )
    throw new Error("Invalid persistence key");
  return [key.tenant, key.kind, key.id];
}
function validateKeys(keyring: Keyring): void {
  if (
    !Object.hasOwn(keyring.keys, keyring.current) ||
    !Object.entries(keyring.keys).every(
      ([id, key]) => /^[a-zA-Z0-9_-]{1,64}$/.test(id) && key.byteLength === 32,
    )
  )
    throw new Error("Invalid encryption key configuration");
}
function seal(
  key: RecordKey,
  revision: number,
  value: unknown,
  keyring: Keyring,
): Buffer {
  const iv = randomBytes(12);
  const cipher = createCipheriv(
    "aes-256-gcm",
    keyring.keys[keyring.current]!,
    iv,
  );
  cipher.setAAD(
    Buffer.from(
      JSON.stringify([...parameters(key), revision, keyring.current]),
    ),
  );
  const ciphertext = Buffer.concat([
    cipher.update(JSON.stringify(value)),
    cipher.final(),
  ]);
  return Buffer.from(
    JSON.stringify({
      key: keyring.current,
      iv: iv.toString("base64"),
      tag: cipher.getAuthTag().toString("base64"),
      data: ciphertext.toString("base64"),
    }),
  );
}
function open<T>(
  key: RecordKey,
  revision: number,
  value: unknown,
  keyring: Keyring,
): T {
  try {
    if (!(value instanceof Uint8Array)) throw new Error();
    const envelope = JSON.parse(Buffer.from(value).toString());
    if (
      typeof envelope.key !== "string" ||
      !Object.hasOwn(keyring.keys, envelope.key)
    )
      throw new Error();
    const decipher = createDecipheriv(
      "aes-256-gcm",
      keyring.keys[envelope.key]!,
      Buffer.from(envelope.iv, "base64"),
    );
    decipher.setAAD(
      Buffer.from(JSON.stringify([...parameters(key), revision, envelope.key])),
    );
    decipher.setAuthTag(Buffer.from(envelope.tag, "base64"));
    return JSON.parse(
      Buffer.concat([
        decipher.update(Buffer.from(envelope.data, "base64")),
        decipher.final(),
      ]).toString(),
    ) as T;
  } catch {
    throw new Error("Protected record cannot be decrypted");
  }
}
function transaction(
  query: Query,
  postgres: boolean,
  keyring: Keyring,
): AsyncTransaction & { finish(): void } {
  let active = true;
  const q: Query = (sql, args) => {
    if (!active) throw new Error("Transaction is closed");
    return query(sql, args);
  };
  const lock = postgres ? " FOR UPDATE" : "";
  const now = async () =>
    Number(
      (
        await q(
          postgres
            ? "SELECT floor(extract(epoch from clock_timestamp()) * 1000) AS now"
            : "SELECT CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER) AS now",
        )
      )[0]!.now,
    );
  const fenceRow = async (key: RecordKey) =>
    (
      await q(
        `SELECT * FROM ceremony_claims WHERE tenant=$1 AND kind=$2 AND id=$3${lock}`,
        parameters(key),
      )
    )[0];
  const assertFence = async (fence: Fence) => {
    const row = await fenceRow(fence);
    if (
      !row ||
      Number(row.generation) !== fence.generation ||
      row.worker !== fence.worker ||
      Number(row.expires) <= (await now())
    )
      throw new PersistenceConflict();
  };
  const duration = (ms: number) => {
    if (!Number.isSafeInteger(ms) || ms < 1 || ms > 300_000)
      throw new Error("Invalid claim duration");
  };
  return {
    finish() {
      active = false;
    },
    now,
    async get<T>(key: RecordKey) {
      const row = (
        await q(
          `SELECT revision,value FROM ceremony_records WHERE tenant=$1 AND kind=$2 AND id=$3${lock}`,
          parameters(key),
        )
      )[0];
      return row
        ? {
            revision: Number(row.revision),
            value: open<T>(key, Number(row.revision), row.value, keyring),
          }
        : undefined;
    },
    async put(key, value, expectedRevision) {
      if (
        expectedRevision !== null &&
        (!Number.isSafeInteger(expectedRevision) || expectedRevision < 1)
      )
        throw new Error("Invalid expected revision");
      const revision = (expectedRevision ?? 0) + 1;
      const bytes = seal(key, revision, value, keyring);
      const rows =
        expectedRevision === null
          ? await q(
              "INSERT INTO ceremony_records(tenant,kind,id,revision,value) VALUES($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING RETURNING revision",
              [...parameters(key), revision, bytes],
            )
          : await q(
              "UPDATE ceremony_records SET revision=$4,value=$5 WHERE tenant=$1 AND kind=$2 AND id=$3 AND revision=$6 RETURNING revision",
              [...parameters(key), revision, bytes, expectedRevision],
            );
      if (!rows.length) throw new PersistenceConflict();
      return revision;
    },
    async delete(key, expectedRevision) {
      if (
        !(
          await q(
            "DELETE FROM ceremony_records WHERE tenant=$1 AND kind=$2 AND id=$3 AND revision=$4 RETURNING id",
            [...parameters(key), expectedRevision],
          )
        ).length
      )
        throw new PersistenceConflict();
    },
    async list<T>(tenant: string, kind: RecordKind, limit = 100, afterId = "") {
      parameters({ tenant, kind, id: "validation" });
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1000)
        throw new Error("Invalid record limit");
      if (afterId) parameters({ tenant, kind, id: afterId });
      return (
        await q(
          `SELECT id,revision,value FROM ceremony_records WHERE tenant=$1 AND kind=$2 AND id>$3 ORDER BY id LIMIT $4${lock}`,
          [tenant, kind, afterId, limit],
        )
      ).map((row) => ({
        id: String(row.id),
        revision: Number(row.revision),
        value: open<T>(
          { tenant, kind, id: String(row.id) },
          Number(row.revision),
          row.value,
          keyring,
        ),
      }));
    },
    async claim(key, worker, durationMs) {
      duration(durationMs);
      if (!/^[a-zA-Z0-9_-]{1,200}$/.test(worker))
        throw new Error("Invalid worker identity");
      const time = await now();
      const rows = await q(
        "INSERT INTO ceremony_claims(tenant,kind,id,generation,worker,expires) VALUES($1,$2,$3,1,$4,$5) ON CONFLICT(tenant,kind,id) DO UPDATE SET generation=ceremony_claims.generation+1,worker=excluded.worker,expires=excluded.expires WHERE ceremony_claims.expires<=$6 RETURNING generation",
        [...parameters(key), worker, time + durationMs, time],
      );
      if (!rows.length) throw new PersistenceConflict();
      return { ...key, generation: Number(rows[0]!.generation), worker };
    },
    async heartbeat(fence, durationMs) {
      duration(durationMs);
      await assertFence(fence);
      await q(
        "UPDATE ceremony_claims SET expires=$4 WHERE tenant=$1 AND kind=$2 AND id=$3",
        [...parameters(fence), (await now()) + durationMs],
      );
    },
    assertFence,
    async cancel(key) {
      await q(
        "INSERT INTO ceremony_claims(tenant,kind,id,generation,worker,expires) VALUES($1,$2,$3,1,'cancelled',0) ON CONFLICT(tenant,kind,id) DO UPDATE SET generation=ceremony_claims.generation+1,worker='cancelled',expires=0",
        parameters(key),
      );
    },
  };
}

/** Local transactional adapter. Async callbacks are awaited before COMMIT. Never perform network work inside them. */
export class SQLiteCeremonyStore implements AsyncCeremonyStore {
  private readonly db: DatabaseSync;
  private tail: Promise<unknown> = Promise.resolve();
  constructor(
    path: string,
    private readonly keyring: Keyring,
  ) {
    validateKeys(keyring);
    this.db = new DatabaseSync(path);
    if (path !== ":memory:") chmodSync(path, 0o600);
    this.db.exec(
      "PRAGMA busy_timeout=0; PRAGMA journal_mode=WAL;" +
        migration.replaceAll("BYTEA", "BLOB"),
    );
  }
  transaction<T>(work: (tx: AsyncTransaction) => Promise<T>): Promise<T> {
    const result = this.tail.then(async () => {
      const deadline = Date.now() + 5000;
      for (;;) {
        try {
          this.db.exec("BEGIN IMMEDIATE");
          break;
        } catch (error) {
          if (
            !(error instanceof Error) ||
            !error.message.includes("locked") ||
            Date.now() >= deadline
          )
            throw error;
          await delay(5);
        }
      }
      const tx = transaction(
        async (sql, args = []) => {
          const statement = this.db.prepare(sql.replace(/\$\d+/g, "?"));
          // SQLite positional placeholders follow appearance; current statements use ordered $N except UPDATE.
          const order = [...sql.matchAll(/\$(\d+)/g)].map(
            (match) => args[Number(match[1]) - 1],
          );
          return statement.all(
            ...(order as Array<string | number | Uint8Array | null>),
          ) as Row[];
        },
        false,
        this.keyring,
      );
      try {
        const value = await work(tx);
        this.db.exec("COMMIT");
        return value;
      } catch (error) {
        this.db.exec("ROLLBACK");
        throw error;
      } finally {
        tx.finish();
      }
    });
    this.tail = result.catch(() => {});
    return result;
  }
  async close() {
    await this.tail;
    this.db.close();
  }
}

export class PostgresCeremonyStore implements AsyncCeremonyStore {
  private readonly pool: Pool;
  private idleFailure = false;
  constructor(
    config: PoolConfig,
    private readonly keyring: Keyring,
  ) {
    validateKeys(keyring);
    this.pool = new Pool(config);
    // pg's idle-client error event otherwise becomes an uncaught exception carrying connection configuration.
    this.pool.on("error", () => {
      this.idleFailure = true;
    });
  }
  health(): "ready" | "degraded" {
    return this.idleFailure ? "degraded" : "ready";
  }
  async migrate(): Promise<void> {
    try {
      await this.pool.query(migration);
    } catch {
      throw new Error("Persistence migration unavailable");
    }
  }
  /** Offline maintenance only: locks both tables and refuses outstanding live leases. Never exports plaintext. */
  async encryptedBackup(): Promise<EncryptedBackup> {
    return this.maintenance(async (client) => {
      const active = await client.query(
        "SELECT 1 FROM ceremony_claims WHERE expires > (EXTRACT(EPOCH FROM clock_timestamp()) * 1000)::bigint LIMIT 1",
      );
      if (active.rowCount) throw new Error();
      const size = await client.query(
        "SELECT COUNT(*)::int AS count, COALESCE(SUM(octet_length(value)),0)::bigint AS bytes FROM ceremony_records",
      );
      if (size.rows[0].count > 10000 || Number(size.rows[0].bytes) > 16_000_000)
        throw new Error();
      const records = (
        await client.query(
          "SELECT tenant,kind,id,revision,value FROM ceremony_records ORDER BY tenant,kind,id LIMIT 10001",
        )
      ).rows.map((r) => ({
        tenant: r.tenant,
        kind: r.kind,
        id: r.id,
        revision: Number(r.revision),
        value: r.value.toString("base64"),
      }));
      const claims = (
        await client.query(
          "SELECT tenant,kind,id,generation FROM ceremony_claims ORDER BY tenant,kind,id LIMIT 10001",
        )
      ).rows.map((r) => ({
        tenant: r.tenant,
        kind: r.kind,
        id: r.id,
        generation: Number(r.generation),
      }));
      return encryptedBackupSchema.parse({ schemaVersion: 1, records, claims });
    });
  }
  /** Fresh, offline database only. Authenticate every envelope before importing; invalidate every historical worker generation. */
  async restoreEncryptedBackup(input: unknown): Promise<void> {
    let backup: EncryptedBackup;
    try {
      if (JSON.stringify(input).length > 24_000_000) throw new Error();
      backup = encryptedBackupSchema.parse(input);
      for (const r of backup.records)
        open(r, r.revision, Buffer.from(r.value, "base64"), this.keyring);
    } catch {
      throw new Error(
        "Encrypted backup is invalid or unavailable with configured keys",
      );
    }
    await this.maintenance(async (client) => {
      const existing = await client.query(
        "SELECT 1 FROM ceremony_records UNION ALL SELECT 1 FROM ceremony_claims LIMIT 1",
      );
      if (existing.rowCount) throw new Error();
      for (const r of backup.records)
        await client.query(
          "INSERT INTO ceremony_records(tenant,kind,id,revision,value) VALUES($1,$2,$3,$4,$5)",
          [r.tenant, r.kind, r.id, r.revision, Buffer.from(r.value, "base64")],
        );
      for (const c of backup.claims)
        await client.query(
          "INSERT INTO ceremony_claims(tenant,kind,id,generation,worker,expires) VALUES($1,$2,$3,$4,'restored',0)",
          [c.tenant, c.kind, c.id, c.generation + 1],
        );
    });
  }
  private async maintenance<T>(
    work: (client: import("pg").PoolClient) => Promise<T>,
  ): Promise<T> {
    const client = await this.pool.connect().catch(() => {
      throw new Error("Persistence maintenance unavailable");
    });
    try {
      await client.query("BEGIN");
      await client.query("SET LOCAL lock_timeout = '5s'");
      await client.query(
        "LOCK TABLE ceremony_records, ceremony_claims IN ACCESS EXCLUSIVE MODE",
      );
      const result = await work(client);
      await client.query("COMMIT");
      return result;
    } catch {
      await client.query("ROLLBACK").catch(() => {});
      throw new Error(
        "Persistence maintenance refused; require valid keys, quiescent source or empty destination",
      );
    } finally {
      client.release();
    }
  }
  async transaction<T>(work: (tx: AsyncTransaction) => Promise<T>): Promise<T> {
    const client = await this.pool.connect().catch(() => {
      throw new Error("Persistence connection unavailable");
    });
    const query: Query = async (sql, args) => {
      try {
        return (await client.query(sql, args)).rows as Row[];
      } catch {
        throw new Error("Persistence operation unavailable");
      }
    };
    const tx = transaction(query, true, this.keyring);
    try {
      await query("BEGIN");
      const value = await work(tx);
      await query("COMMIT");
      this.idleFailure = false;
      return value;
    } catch (error) {
      await query("ROLLBACK");
      throw error;
    } finally {
      tx.finish();
      client.release();
    }
  }
  async close() {
    await this.pool.end();
  }
}

/** Re-encrypt a bounded batch under the current key. Retain old keys until all records/backups have migrated. */
export async function rotateRecords(
  store: AsyncCeremonyStore,
  tenant: string,
  kind: RecordKind,
  limit = 1000,
  afterId = "",
): Promise<number> {
  return store.transaction(async (tx) => {
    const records = await tx.list(tenant, kind, limit, afterId);
    for (const record of records)
      await tx.put(
        { tenant, kind, id: record.id },
        record.value,
        record.revision,
      );
    return records.length;
  });
}
