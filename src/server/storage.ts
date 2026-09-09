import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
  randomUUID,
} from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { chmodSync } from "node:fs";
import { z } from "zod";
import { CeremonyError } from "./controller.js";

export const serverEventSchema = z.object({
  eventId: z.uuid(),
  instanceId: z.string(),
  revision: z.number(),
  step: z.string(),
  occurredAt: z.number(),
  status: z.enum(["success", "failure"]),
  action: z.string().optional(),
});
export type ServerCeremonyEvent = z.infer<typeof serverEventSchema>;

/** Encrypted records and atomic leases. Keep the key outside the database/backups. */
export class CeremonyDatabase {
  private readonly db: DatabaseSync;
  private transactionDepth = 0;
  constructor(
    path: string,
    private readonly key: Uint8Array,
  ) {
    if (key.byteLength !== 32)
      throw new Error("A 32-byte vault key is required");
    this.db = new DatabaseSync(path);
    if (path !== ":memory:") chmodSync(path, 0o600);
    this.db.exec(`PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS records (id TEXT PRIMARY KEY, value BLOB NOT NULL);
      CREATE TABLE IF NOT EXISTS leases (id TEXT PRIMARY KEY, token TEXT NOT NULL, expires INTEGER NOT NULL);`);
  }
  get<T>(id: string, schema: z.ZodType<T>): T | undefined {
    const row = this.db.prepare("SELECT value FROM records WHERE id=?").get(id);
    if (!row) return undefined;
    const bytes = row.value;
    if (!(bytes instanceof Uint8Array))
      throw new Error("Invalid protected record");
    const decipher = createDecipheriv(
      "aes-256-gcm",
      this.key,
      bytes.slice(0, 12),
    );
    decipher.setAAD(Buffer.from(id));
    decipher.setAuthTag(bytes.slice(12, 28));
    return schema.parse(
      JSON.parse(
        Buffer.concat([
          decipher.update(bytes.slice(28)),
          decipher.final(),
        ]).toString(),
      ),
    );
  }
  put(id: string, value: unknown): void {
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", this.key, iv);
    cipher.setAAD(Buffer.from(id));
    const encrypted = Buffer.concat([
      cipher.update(JSON.stringify(value)),
      cipher.final(),
    ]);
    this.db
      .prepare("INSERT OR REPLACE INTO records VALUES (?,?)")
      .run(id, Buffer.concat([iv, cipher.getAuthTag(), encrypted]));
  }
  delete(id: string): void {
    this.db.prepare("DELETE FROM records WHERE id=?").run(id);
  }
  keys(prefix: string): string[] {
    return this.db
      .prepare("SELECT id FROM records WHERE substr(id,1,?)=?")
      .all(prefix.length, prefix)
      .map((row) => String(row.id));
  }
  transaction<T>(fn: () => T): T {
    const savepoint = `ceremony_${this.transactionDepth++}`;
    const nested = this.transactionDepth > 1;
    try {
      this.db.exec(nested ? `SAVEPOINT ${savepoint}` : "BEGIN IMMEDIATE");
      const result = fn();
      this.db.exec(nested ? `RELEASE ${savepoint}` : "COMMIT");
      return result;
    } catch (error) {
      this.db.exec(nested ? `ROLLBACK TO ${savepoint}` : "ROLLBACK");
      if (nested) this.db.exec(`RELEASE ${savepoint}`);
      throw error;
    } finally {
      this.transactionDepth--;
    }
  }
  acquire(id: string, duration = 60_000): string {
    return this.transaction(() => {
      this.db
        .prepare("DELETE FROM leases WHERE id=? AND expires<=?")
        .run(id, Date.now());
      const token = randomUUID();
      if (
        !this.db
          .prepare("INSERT OR IGNORE INTO leases VALUES (?,?,?)")
          .run(id, token, Date.now() + duration).changes
      )
        throw new CeremonyError("This ceremony is already executing", 409);
      return token;
    });
  }
  release(id: string, token: string): void {
    this.db.prepare("DELETE FROM leases WHERE id=? AND token=?").run(id, token);
  }
  close(): void {
    this.db.close();
  }
  /** At-least-once delivery. Consumers must deduplicate eventId; failure retains the event. */
  async deliverEvents(
    deliver: (event: ServerCeremonyEvent) => Promise<void>,
    limit = 100,
  ): Promise<number> {
    let count = 0;
    for (const key of this.keys("event:").slice(0, limit)) {
      const lease = this.acquire(`delivery:${key}`);
      try {
        const event = this.get(key, serverEventSchema);
        if (!event) continue;
        await deliver(event);
        this.delete(key);
        count++;
      } finally {
        this.release(`delivery:${key}`, lease);
      }
    }
    return count;
  }
}

const collectionSchema = z.object({
  owner: z.string(),
  instanceId: z.string(),
  revision: z.number(),
  expiresAt: z.number(),
  values: z.record(z.string(), z.string()),
});
/** References never authorize resolution on their own and have no model-facing read API. */
export class PrivateCredentialBroker {
  constructor(private readonly db: CeremonyDatabase) {}
  collect(
    owner: string,
    instanceId: string,
    revision: number,
    values: Record<string, string>,
  ): string {
    const ref = randomUUID();
    this.db.put(`collection:${ref}`, {
      owner,
      instanceId,
      revision,
      values,
      expiresAt: Date.now() + 300_000,
    });
    return ref;
  }
  consume(
    owner: string,
    instanceId: string,
    revision: number,
    ref: string,
  ): Record<string, string> {
    return this.db.transaction(() => {
      const record = this.db.get(`collection:${ref}`, collectionSchema);
      if (
        !record ||
        record.owner !== owner ||
        record.instanceId !== instanceId ||
        record.revision !== revision ||
        record.expiresAt <= Date.now()
      )
        throw new CeremonyError(
          "Credential reference is unavailable or expired",
          409,
        );
      this.db.delete(`collection:${ref}`);
      return record.values;
    });
  }
}
