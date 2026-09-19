import { createHash, randomBytes, randomUUID } from "node:crypto";
import { z } from "zod";
import {
  actorContextSchema,
  type ActorContext,
} from "../../../core/operation-contracts.js";
import {
  PersistenceConflict,
  type AsyncCeremonyStore,
  type AsyncTransaction,
  type RecordKey,
  type RecordKind,
} from "../../persistence/index.js";
import { ConnectorError } from "../errors.js";
import type { Clock, RandomPort } from "../ports.js";

/*
 * Shared plumbing for the connector state layer. Everything durable goes
 * through the encrypted AsyncCeremonyStore: a key is tenant + kind + an id
 * derived from a digest or a UUID (never a native identifier), a value carries
 * `schemaVersion` and is validated on every read, and a transaction never
 * outlives the function that opened it, so no provider call, credential use
 * or human wait ever happens inside one.
 */

/** Records that must be found from an opaque reference alone live under this fixed tenant. */
export const INDEX_TENANT = "connector";
export const SCHEMA_VERSION = 1 as const;

const referencePattern = /^[a-zA-Z0-9][a-zA-Z0-9_.:@/-]{0,199}$/;
const tenantPattern = /^[a-zA-Z0-9_.:@/-]{1,200}$/;

export function sha256Hex(...parts: unknown[]): string {
  return createHash("sha256").update(JSON.stringify(parts)).digest("hex");
}

export function newRef(prefix: string): string {
  return `${prefix}:${randomUUID()}`;
}

export function isReference(value: unknown): value is string {
  return typeof value === "string" && referencePattern.test(value);
}

/** A tenant string the store can index; actor tenants outside this alphabet cannot own connector state. */
export function checkTenant(value: unknown): string {
  if (typeof value !== "string" || !tenantPattern.test(value))
    throw new ConnectorError("denied", { detail: "tenant.invalid" });
  return value;
}

/** Pads a revision so lexical id order matches numeric order. */
export function paddedRevision(revision: number): string {
  return String(revision).padStart(12, "0");
}

export const isoAt = (ms: number): string => new Date(ms).toISOString();

export type TimeSource = (tx: AsyncTransaction) => Promise<number>;

/** Database time by default; an injected clock only for tests that simulate expiry. */
export function timeSource(clock?: Clock): TimeSource {
  return clock ? async () => clock() : (tx) => tx.now();
}

/** A stored value that fails its schema is reported without echoing its contents. */
export function unreadable(): Error {
  return new Error("Connector record is not readable");
}

export function parseStored<T extends z.ZodType>(
  schema: T,
  value: unknown,
): z.output<T> {
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw unreadable();
  return parsed.data;
}

export async function readRecord<T extends z.ZodType>(
  tx: AsyncTransaction,
  key: RecordKey,
  schema: T,
): Promise<{ revision: number; value: z.output<T> } | undefined> {
  const record = await tx.get(key);
  if (!record) return undefined;
  return {
    revision: record.revision,
    value: parseStored(schema, record.value),
  };
}

/** Runs one transaction, translating optimistic-concurrency failures into the connector vocabulary. */
export async function transact<T>(
  store: AsyncCeremonyStore,
  work: (tx: AsyncTransaction) => Promise<T>,
): Promise<T> {
  try {
    return await store.transaction(work);
  } catch (error) {
    if (error instanceof PersistenceConflict)
      throw new ConnectorError("conflict", { cause: error });
    throw error;
  }
}

/** Visits every record of a kind whose id starts with a prefix, in id order and in bounded pages. */
export async function scanPrefix<T extends z.ZodType>(
  tx: AsyncTransaction,
  tenant: string,
  kind: RecordKind,
  prefix: string,
  schema: T,
  visit: (entry: {
    id: string;
    revision: number;
    value: z.output<T>;
  }) => Promise<boolean | void> | boolean | void,
  pageSize = 200,
): Promise<void> {
  let after = prefix;
  for (;;) {
    const page = await tx.list(tenant, kind, pageSize, after);
    for (const entry of page) {
      if (prefix && !entry.id.startsWith(prefix)) return;
      const decision = await visit({
        id: entry.id,
        revision: entry.revision,
        value: parseStored(schema, entry.value),
      });
      if (decision === false) return;
    }
    if (page.length < pageSize) return;
    after = page.at(-1)!.id;
  }
}

/** Parsing an actor is not authentication; the host derived it, this only refuses malformed shapes. */
export function checkActor(actor: unknown): ActorContext {
  const parsed = actorContextSchema.safeParse(actor);
  if (!parsed.success)
    throw new ConnectorError("denied", { detail: "actor.invalid" });
  checkTenant(parsed.data.tenantId);
  return parsed.data;
}

/** The same shape with `undefined` removed from every property type; optionality is preserved. */
export type Defined<T> = { [K in keyof T]: Exclude<T[K], undefined> };

/** Drops undefined-valued keys so a record matches its strict schema and exact optional types. */
export function compact<T extends object>(value: T): Defined<T> {
  const out: Record<string, unknown> = {};
  for (const [name, item] of Object.entries(value))
    if (item !== undefined) out[name] = item;
  return out as Defined<T>;
}

export const systemRandom: RandomPort = {
  bytes: (length) => new Uint8Array(randomBytes(length)),
  uuid: () => randomUUID(),
};

export function boundedDuration(
  ms: number,
  detail: string,
  max = 300_000,
): number {
  if (!Number.isSafeInteger(ms) || ms < 1 || ms > max)
    throw new ConnectorError("invalid-request", { detail });
  return ms;
}

export function canonicalJson(value: unknown): string {
  const canonical = (item: unknown): unknown => {
    if (Array.isArray(item)) return item.map(canonical);
    if (item && typeof item === "object")
      return Object.fromEntries(
        Object.entries(item as Record<string, unknown>)
          .filter(([, v]) => v !== undefined)
          .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
          .map(([k, v]) => [k, canonical(v)]),
      );
    return item;
  };
  return JSON.stringify(canonical(value));
}

export function sameJson(a: unknown, b: unknown): boolean {
  return canonicalJson(a) === canonicalJson(b);
}

/*
 * Reference index: a completion or cancellation arrives with an opaque
 * reference and no actor, so the tenant that owns the record is looked up
 * under a fixed index tenant. The index maps a digest of the reference to the
 * tenant and nothing else; it grants nothing and carries nothing private.
 */
export const refIndexSchema = z.strictObject({
  schemaVersion: z.literal(1),
  tenantId: z.string().min(1).max(200),
});

export function refIndexKey(kind: RecordKind, ref: string): RecordKey {
  return { tenant: INDEX_TENANT, kind, id: `ref:${sha256Hex(ref)}` };
}

/** Insert-if-absent; a reference already owned by another tenant is refused, never re-pointed. */
export async function registerRef(
  tx: AsyncTransaction,
  kind: RecordKind,
  ref: string,
  tenantId: string,
  detail: string,
): Promise<void> {
  const key = refIndexKey(kind, ref);
  const existing = await readRecord(tx, key, refIndexSchema);
  if (existing) {
    if (existing.value.tenantId !== tenantId)
      throw new ConnectorError("conflict", { detail });
    return;
  }
  try {
    await tx.put(key, { schemaVersion: SCHEMA_VERSION, tenantId }, null);
  } catch (error) {
    if (!(error instanceof PersistenceConflict)) throw error;
    const raced = await readRecord(tx, key, refIndexSchema);
    if (raced?.value.tenantId !== tenantId)
      throw new ConnectorError("conflict", { detail });
  }
}

export async function resolveRef(
  tx: AsyncTransaction,
  kind: RecordKind,
  ref: string,
): Promise<string | undefined> {
  if (!isReference(ref)) return undefined;
  return (await readRecord(tx, refIndexKey(kind, ref), refIndexSchema))?.value
    .tenantId;
}

export async function forgetRef(
  tx: AsyncTransaction,
  kind: RecordKind,
  ref: string,
): Promise<void> {
  const key = refIndexKey(kind, ref);
  const existing = await tx.get(key);
  if (existing) await tx.delete(key, existing.revision);
}

/*
 * Caches (catalog rows, capability lists, resolved targets) are derived state.
 * The hook runs after the durable change committed and is best effort: a hook
 * failure never undoes a committed invalidation, because the record is the
 * authority and the cache is not.
 */
export type CacheInvalidationEvent = {
  tenantId: string;
  connectionRef: string;
  keyDigest?: string;
  authorityInstance?: string;
  reason: string;
};
export type CacheInvalidationHook = (
  event: CacheInvalidationEvent,
) => void | Promise<void>;

export async function notifyCache(
  hook: CacheInvalidationHook | undefined,
  event: CacheInvalidationEvent,
): Promise<void> {
  if (!hook) return;
  try {
    await hook(event);
  } catch {
    // Derived caches never gate durable state.
  }
}
