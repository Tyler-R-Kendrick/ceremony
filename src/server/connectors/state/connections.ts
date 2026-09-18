import type { ActorContext } from "../../../core/operation-contracts.js";
import type { ConnectionSummary } from "../../../core/connectors/index.js";
import {
  PersistenceConflict,
  type AsyncCeremonyStore,
  type AsyncTransaction,
} from "../../persistence/index.js";
import type { DisconnectOutcome, DisconnectScope } from "../adapter.js";
import { ConnectorError } from "../errors.js";
import type { Clock, ConnectionRecord, ConnectionStorePort } from "../ports.js";
import {
  SCHEMA_VERSION,
  canonicalJson,
  checkActor,
  checkTenant,
  compact,
  isReference,
  isoAt,
  notifyCache,
  readRecord,
  scanPrefix,
  sha256Hex,
  timeSource,
  transact,
  type CacheInvalidationHook,
} from "./common.js";
import { settlePendingHandoffs } from "./handoffs.js";
import {
  connectionKey,
  externalIdKey,
  sharedIdKey,
  sharedIdPrefix,
} from "./keys.js";
import {
  connectionPatchSchema,
  connectionRecordSchema,
  disconnectOutcomeSchema,
  disconnectScopeSchema,
  externalIdNameSchema,
  externalIndexSchema,
  storedConnectionSchema,
  type DisconnectRecord,
  type StoredConnectionValue,
} from "./schemas.js";
import { nativeIdentifierSchema } from "../../../core/connectors/index.js";

/*
 * Owner-scoped connection links. Every read checks ownership and answers
 * `undefined` for a foreign record exactly as for a missing one. Writes are
 * optimistic on the store revision; `advanceGeneration` fences later
 * callbacks, refreshes and invocations and settles the connection's pending
 * handoffs in the same transaction. External identifiers are indexed per
 * (tenant, authority instance, name, value) with insert-if-absent semantics,
 * so two workers binding the same external response end with exactly one
 * owner, and the same account under two tenants or two authorities never
 * aliases. Local unlink, broker deletion and upstream revocation are recorded
 * as three separate outcomes on the record, never collapsed into one.
 */

export type ConnectionOwnership = (
  actor: ActorContext,
  record: ConnectionRecord,
) => boolean;

export type ConnectionStoreOptions = {
  now?: Clock;
  /**
   * External identifier names that legitimately appear on several connections
   * (a shared installation, project or organization grant). Every other name
   * is exclusive to one connection per tenant and authority instance.
   */
  sharedExternalIdNames?: readonly string[];
  /** Host ownership policy; the default is the subject-and-session rule of the memory double. */
  owns?: ConnectionOwnership;
  cacheInvalidation?: CacheInvalidationHook;
};

export type StoredConnectionRecord = ConnectionRecord & {
  disconnect?: DisconnectRecord;
};

export type ConnectionEntry = {
  record: StoredConnectionRecord;
  revision: number;
};

export type DisconnectInput = {
  scope: DisconnectScope;
  local: DisconnectOutcome;
  broker: DisconnectOutcome;
  upstream: DisconnectOutcome;
  /** Explicit shared-impact action; without it a broker or upstream action on a shared grant is refused. */
  sharedImpactAcknowledged?: boolean;
};

export interface ConnectorConnectionStore extends ConnectionStorePort {
  get(
    actor: ActorContext,
    connectionRef: string,
  ): Promise<ConnectionEntry | undefined>;
  list(
    actor: ActorContext,
    filter?: {
      ecosystem?: string;
      bindingRef?: string;
      lifecycle?: ConnectionSummary["lifecycle"];
    },
  ): Promise<ConnectionEntry[]>;
  findByExternalId(
    tenantId: string,
    authorityInstance: string,
    name: string,
    value: string,
  ): Promise<ConnectionEntry | undefined>;
  /** Every connection carrying a shared external identifier; exclusive names yield at most one. */
  listByExternalId(
    tenantId: string,
    authorityInstance: string,
    name: string,
    value: string,
  ): Promise<ConnectionEntry[]>;
  /** Other local connections in the tenant that share an upstream grant with this one. */
  sharedWith(actor: ActorContext, connectionRef: string): Promise<string[]>;
  /** Policy gate to run before any external disconnect action. */
  assertDisconnectAllowed(
    actor: ActorContext,
    connectionRef: string,
    scope: DisconnectScope,
    options?: { sharedImpactAcknowledged?: boolean },
  ): Promise<{ sharedWith: string[] }>;
  /** Records what actually happened, per scope, and moves the lifecycle accordingly. */
  recordDisconnect(
    actor: ActorContext,
    connectionRef: string,
    expectedRevision: number,
    input: DisconnectInput,
  ): Promise<ConnectionEntry & { generation: number }>;
  keyDigest(record: ConnectionRecord): string;
}

/** The charter §6.4 tuple; unknown parts are omitted, never guessed. */
export type ConnectionKeyParts = {
  tenantId: string;
  ownerKind: string;
  ownerId: string;
  sessionId?: string;
  authorityInstance: string;
  upstreamAccount?: Record<string, string>;
  clientRegistration?: string;
  authenticationProfile?: string;
  target?: { kind: string; id: string };
  bindingRef: string;
  bindingRevision: number;
  policyRevision: string;
  configurationRevision: string;
};

export function connectionKeyDigest(parts: ConnectionKeyParts): string {
  return sha256Hex(JSON.parse(canonicalJson(compact(parts))));
}

export function keyDigestOf(record: ConnectionRecord): string {
  return connectionKeyDigest(
    compact({
      tenantId: record.tenantId,
      ownerKind: record.ownerKind,
      ownerId: record.ownerId,
      sessionId: record.sessionId,
      authorityInstance: record.authorityInstance,
      upstreamAccount: record.externalIds,
      authenticationProfile:
        typeof record.state.authenticationProfile === "string"
          ? record.state.authenticationProfile
          : undefined,
      clientRegistration:
        typeof record.state.clientRegistration === "string"
          ? record.state.clientRegistration
          : undefined,
      target: record.target,
      bindingRef: record.bindingRef,
      bindingRevision: record.bindingRevision,
      policyRevision: record.policyRevision,
      configurationRevision: record.configurationRevision,
    }),
  );
}

export const defaultOwnership: ConnectionOwnership = (actor, record) =>
  record.tenantId === actor.tenantId &&
  record.ownerId === actor.subjectId &&
  (record.sessionId === undefined || record.sessionId === actor.sessionId);

const immutableFields = [
  "connectionRef",
  "tenantId",
  "ownerId",
  "ownerKind",
  "createdAt",
] as const;

/**
 * A validated stored value whose record carries the port's exact optional
 * properties. Zod spells an absent property `p?: T | undefined` and the port
 * spells it `p?: T`; the runtime value is the same object, with absent keys
 * genuinely absent, so this narrows the type and changes nothing else.
 */
export type LoadedConnection = {
  revision: number;
  value: {
    schemaVersion: 1;
    record: ConnectionRecord;
    keyDigest: string;
    disconnect?: DisconnectRecord;
  };
};

function asConnectionRecord(
  value: StoredConnectionValue["record"],
): ConnectionRecord {
  return compact(value) as ConnectionRecord;
}

function entryOf(
  value: StoredConnectionValue,
  revision: number,
): ConnectionEntry {
  const record: StoredConnectionRecord = {
    ...structuredClone(asConnectionRecord(value.record)),
    revision,
    ...(value.disconnect
      ? { disconnect: structuredClone(value.disconnect) }
      : {}),
  };
  return { record, revision };
}

export async function loadConnection(
  tx: AsyncTransaction,
  tenantId: string,
  connectionRef: string,
): Promise<LoadedConnection | undefined> {
  if (!isReference(connectionRef)) return undefined;
  const record = await readRecord(
    tx,
    connectionKey(tenantId, connectionRef),
    storedConnectionSchema,
  );
  if (!record) return undefined;
  return {
    revision: record.revision,
    value: compact({
      schemaVersion: record.value.schemaVersion,
      record: asConnectionRecord(record.value.record),
      keyDigest: record.value.keyDigest,
      disconnect: record.value.disconnect,
    }),
  };
}

/** The owned record or nothing; ownership failures look exactly like absence. */
export async function loadOwnedConnection(
  tx: AsyncTransaction,
  actor: ActorContext,
  connectionRef: string,
  owns: ConnectionOwnership,
): Promise<LoadedConnection | undefined> {
  const record = await loadConnection(tx, actor.tenantId, connectionRef);
  if (!record || !owns(actor, record.value.record)) return undefined;
  return record;
}

export async function saveConnection(
  tx: AsyncTransaction,
  tenantId: string,
  record: ConnectionRecord,
  extra: { disconnect?: DisconnectRecord },
  expectedRevision: number | null,
): Promise<number> {
  const revision = (expectedRevision ?? 0) + 1;
  const value: StoredConnectionValue = compact({
    schemaVersion: SCHEMA_VERSION,
    record: { ...record, revision },
    keyDigest: keyDigestOf(record),
    disconnect: extra.disconnect,
  });
  return tx.put(
    connectionKey(tenantId, record.connectionRef),
    value,
    expectedRevision,
  );
}

type ExternalEntry = { authorityInstance: string; name: string; value: string };
const externalEntries = (record: ConnectionRecord): ExternalEntry[] =>
  Object.entries(record.externalIds).map(([name, value]) => ({
    authorityInstance: record.authorityInstance,
    name,
    value,
  }));
const entryId = (entry: ExternalEntry) =>
  canonicalJson([entry.authorityInstance, entry.name, entry.value]);

export function createConnectionStore(
  store: AsyncCeremonyStore,
  options: ConnectionStoreOptions = {},
): ConnectorConnectionStore {
  const time = timeSource(options.now);
  const owns = options.owns ?? defaultOwnership;
  const shared = new Set(options.sharedExternalIdNames ?? []);
  for (const name of shared)
    if (!externalIdNameSchema.safeParse(name).success)
      throw new ConnectorError("invalid-request", {
        detail: "connection.shared-name",
      });

  const bind = async (
    tx: AsyncTransaction,
    tenantId: string,
    entry: ExternalEntry,
    connectionRef: string,
    at: number,
  ) => {
    const value = {
      schemaVersion: SCHEMA_VERSION,
      connectionRef,
      authorityInstance: entry.authorityInstance,
      name: entry.name,
      value: entry.value,
      exclusive: !shared.has(entry.name),
      createdAt: at,
    };
    if (shared.has(entry.name)) {
      const key = sharedIdKey(
        tenantId,
        entry.authorityInstance,
        entry.name,
        entry.value,
        connectionRef,
      );
      if (!(await tx.get(key))) await tx.put(key, value, null);
      return;
    }
    const key = externalIdKey(
      tenantId,
      entry.authorityInstance,
      entry.name,
      entry.value,
    );
    const existing = await readRecord(tx, key, externalIndexSchema);
    if (existing) {
      if (existing.value.connectionRef === connectionRef) return;
      throw new ConnectorError("conflict", {
        detail: "connection.external-id-bound",
      });
    }
    try {
      await tx.put(key, value, null);
    } catch (error) {
      if (error instanceof PersistenceConflict)
        throw new ConnectorError("conflict", {
          detail: "connection.external-id-bound",
        });
      throw error;
    }
  };

  const unbind = async (
    tx: AsyncTransaction,
    tenantId: string,
    entry: ExternalEntry,
    connectionRef: string,
  ) => {
    const key = shared.has(entry.name)
      ? sharedIdKey(
          tenantId,
          entry.authorityInstance,
          entry.name,
          entry.value,
          connectionRef,
        )
      : externalIdKey(
          tenantId,
          entry.authorityInstance,
          entry.name,
          entry.value,
        );
    const existing = await readRecord(tx, key, externalIndexSchema);
    if (existing && existing.value.connectionRef === connectionRef)
      await tx.delete(key, existing.revision);
  };

  const reindex = async (
    tx: AsyncTransaction,
    tenantId: string,
    before: ConnectionRecord | undefined,
    after: ConnectionRecord,
    at: number,
  ) => {
    const previous = new Map(
      (before ? externalEntries(before) : []).map((e) => [entryId(e), e]),
    );
    const next = new Map(externalEntries(after).map((e) => [entryId(e), e]));
    for (const [id, entry] of previous)
      if (!next.has(id)) await unbind(tx, tenantId, entry, after.connectionRef);
    for (const [id, entry] of next)
      if (!previous.has(id))
        await bind(tx, tenantId, entry, after.connectionRef, at);
  };

  const sharedRefs = async (
    tx: AsyncTransaction,
    tenantId: string,
    record: ConnectionRecord,
  ): Promise<string[]> => {
    const refs = new Set<string>();
    for (const entry of externalEntries(record)) {
      if (!shared.has(entry.name)) continue;
      await scanPrefix(
        tx,
        tenantId,
        "connector-connection-index",
        sharedIdPrefix(entry.authorityInstance, entry.name, entry.value),
        externalIndexSchema,
        ({ value }) => {
          if (value.connectionRef !== record.connectionRef)
            refs.add(value.connectionRef);
        },
      );
    }
    return [...refs].sort();
  };

  const lookup = async (
    tx: AsyncTransaction,
    tenantId: string,
    authorityInstance: string,
    name: string,
    value: string,
  ): Promise<ConnectionEntry[]> => {
    const refs: string[] = [];
    if (shared.has(name))
      await scanPrefix(
        tx,
        tenantId,
        "connector-connection-index",
        sharedIdPrefix(authorityInstance, name, value),
        externalIndexSchema,
        (entry) => {
          refs.push(entry.value.connectionRef);
        },
      );
    else {
      const index = await readRecord(
        tx,
        externalIdKey(tenantId, authorityInstance, name, value),
        externalIndexSchema,
      );
      if (index) refs.push(index.value.connectionRef);
    }
    const found: ConnectionEntry[] = [];
    for (const ref of refs) {
      const record = await loadConnection(tx, tenantId, ref);
      if (
        record &&
        record.value.record.authorityInstance === authorityInstance &&
        record.value.record.externalIds[name] === value
      )
        found.push(entryOf(record.value, record.revision));
    }
    return found;
  };

  const validLookup = (
    tenantId: unknown,
    authorityInstance: unknown,
    name: unknown,
    value: unknown,
  ) =>
    typeof tenantId === "string" &&
    typeof authorityInstance === "string" &&
    authorityInstance.length <= 256 &&
    externalIdNameSchema.safeParse(name).success &&
    nativeIdentifierSchema.safeParse(value).success;

  const connections: ConnectorConnectionStore = {
    keyDigest: keyDigestOf,

    async create(input) {
      const parsed = connectionRecordSchema.safeParse(input);
      if (!parsed.success)
        throw new ConnectorError("invalid-request", {
          detail: "connection.record",
        });
      const record = asConnectionRecord(parsed.data);
      checkTenant(record.tenantId);
      await transact(store, async (tx) => {
        const at = await time(tx);
        try {
          await saveConnection(tx, record.tenantId, record, {}, null);
        } catch (error) {
          if (error instanceof PersistenceConflict)
            throw new ConnectorError("conflict", {
              detail: "connection.exists",
            });
          throw error;
        }
        await reindex(tx, record.tenantId, undefined, record, at);
      });
      return { revision: 1 };
    },

    async get(rawActor, connectionRef) {
      const actor = checkActor(rawActor);
      return transact(store, async (tx) => {
        const record = await loadOwnedConnection(
          tx,
          actor,
          connectionRef,
          owns,
        );
        return record && entryOf(record.value, record.revision);
      });
    },

    async update(rawActor, connectionRef, expectedRevision, patch) {
      const actor = checkActor(rawActor);
      if (!patch || typeof patch !== "object")
        throw new ConnectorError("invalid-request", {
          detail: "connection.patch",
        });
      for (const field of immutableFields)
        if (Object.hasOwn(patch, field))
          throw new ConnectorError("invalid-request", {
            detail: "connection.immutable-field",
          });
      const {
        generation: _generation,
        revision: _revision,
        ...rest
      } = patch as Record<string, unknown>;
      void _generation;
      void _revision;
      const parsed = connectionPatchSchema.safeParse(rest);
      if (!parsed.success)
        throw new ConnectorError("invalid-request", {
          detail: "connection.patch",
        });
      const changes = compact(parsed.data);
      const outcome = await transact(store, async (tx) => {
        const current = await loadOwnedConnection(
          tx,
          actor,
          connectionRef,
          owns,
        );
        if (!current)
          throw new ConnectorError("not-found", {
            detail: "connection.unknown",
          });
        if (current.revision !== expectedRevision)
          throw new ConnectorError("conflict", {
            detail: "connection.revision",
          });
        const at = await time(tx);
        const before = current.value.record;
        const merged = asConnectionRecord(
          connectionRecordSchema.parse({
            ...before,
            ...changes,
            updatedAt: isoAt(at),
          }),
        );
        await reindex(tx, actor.tenantId, before, merged, at);
        const revision = await saveConnection(
          tx,
          actor.tenantId,
          merged,
          compact({ disconnect: current.value.disconnect }),
          current.revision,
        );
        const invalidates =
          before.lifecycle !== merged.lifecycle ||
          before.bindingRevision !== merged.bindingRevision ||
          before.policyRevision !== merged.policyRevision ||
          before.configurationRevision !== merged.configurationRevision ||
          before.credentialRef !== merged.credentialRef;
        return { revision, invalidates, merged };
      });
      if (outcome.invalidates)
        await notifyCache(options.cacheInvalidation, {
          tenantId: actor.tenantId,
          connectionRef,
          keyDigest: keyDigestOf(outcome.merged),
          authorityInstance: outcome.merged.authorityInstance,
          reason: "connection.updated",
        });
      return { revision: outcome.revision };
    },

    async list(rawActor, filter = {}) {
      const actor = checkActor(rawActor);
      return transact(store, async (tx) => {
        const entries: ConnectionEntry[] = [];
        await scanPrefix(
          tx,
          actor.tenantId,
          "connector-connection",
          "connection:",
          storedConnectionSchema,
          ({ value, revision }) => {
            const record = asConnectionRecord(value.record);
            if (
              owns(actor, record) &&
              (!filter.ecosystem || record.ecosystem === filter.ecosystem) &&
              (!filter.bindingRef || record.bindingRef === filter.bindingRef) &&
              (!filter.lifecycle || record.lifecycle === filter.lifecycle)
            )
              entries.push(entryOf(value, revision));
          },
        );
        return entries.sort((a, b) =>
          a.record.createdAt < b.record.createdAt
            ? -1
            : a.record.createdAt > b.record.createdAt
              ? 1
              : a.record.connectionRef.localeCompare(b.record.connectionRef),
        );
      });
    },

    async advanceGeneration(rawActor, connectionRef, expectedRevision) {
      const actor = checkActor(rawActor);
      const result = await transact(store, async (tx) => {
        const current = await loadOwnedConnection(
          tx,
          actor,
          connectionRef,
          owns,
        );
        if (!current)
          throw new ConnectorError("not-found", {
            detail: "connection.unknown",
          });
        if (current.revision !== expectedRevision)
          throw new ConnectorError("conflict", {
            detail: "connection.revision",
          });
        const at = await time(tx);
        const record: ConnectionRecord = {
          ...current.value.record,
          generation: current.value.record.generation + 1,
          updatedAt: isoAt(at),
        };
        const revision = await saveConnection(
          tx,
          actor.tenantId,
          record,
          compact({ disconnect: current.value.disconnect }),
          current.revision,
        );
        await settlePendingHandoffs(
          tx,
          actor.tenantId,
          connectionRef,
          "superseded",
          "connection.generation-advanced",
          at,
        );
        return { generation: record.generation, revision, record };
      });
      await notifyCache(options.cacheInvalidation, {
        tenantId: actor.tenantId,
        connectionRef,
        keyDigest: keyDigestOf(result.record),
        authorityInstance: result.record.authorityInstance,
        reason: "connection.generation-advanced",
      });
      return { generation: result.generation, revision: result.revision };
    },

    async findByExternalId(tenantId, authorityInstance, name, value) {
      if (!validLookup(tenantId, authorityInstance, name, value))
        return undefined;
      checkTenant(tenantId);
      return transact(store, async (tx) =>
        (await lookup(tx, tenantId, authorityInstance, name, value)).at(0),
      );
    },

    async listByExternalId(tenantId, authorityInstance, name, value) {
      if (!validLookup(tenantId, authorityInstance, name, value)) return [];
      checkTenant(tenantId);
      return transact(store, (tx) =>
        lookup(tx, tenantId, authorityInstance, name, value),
      );
    },

    async sharedWith(rawActor, connectionRef) {
      const actor = checkActor(rawActor);
      return transact(store, async (tx) => {
        const current = await loadOwnedConnection(
          tx,
          actor,
          connectionRef,
          owns,
        );
        if (!current) return [];
        return sharedRefs(tx, actor.tenantId, current.value.record);
      });
    },

    async assertDisconnectAllowed(rawActor, connectionRef, scope, opts = {}) {
      const actor = checkActor(rawActor);
      if (!disconnectScopeSchema.safeParse(scope).success)
        throw new ConnectorError("invalid-request", {
          detail: "disconnect.scope",
        });
      return transact(store, async (tx) => {
        const current = await loadOwnedConnection(
          tx,
          actor,
          connectionRef,
          owns,
        );
        if (!current)
          throw new ConnectorError("not-found", {
            detail: "connection.unknown",
          });
        const sharedWith = await sharedRefs(
          tx,
          actor.tenantId,
          current.value.record,
        );
        if (
          scope !== "local" &&
          sharedWith.length &&
          opts.sharedImpactAcknowledged !== true
        )
          throw new ConnectorError("denied", {
            detail: "disconnect.shared-impact",
          });
        return { sharedWith };
      });
    },

    async recordDisconnect(rawActor, connectionRef, expectedRevision, input) {
      const actor = checkActor(rawActor);
      const parsedScope = disconnectScopeSchema.safeParse(input?.scope);
      const parsedLocal = disconnectOutcomeSchema.safeParse(input?.local);
      const parsedBroker = disconnectOutcomeSchema.safeParse(input?.broker);
      const parsedUpstream = disconnectOutcomeSchema.safeParse(input?.upstream);
      if (
        !parsedScope.success ||
        !parsedLocal.success ||
        !parsedBroker.success ||
        !parsedUpstream.success
      )
        throw new ConnectorError("invalid-request", {
          detail: "disconnect.input",
        });
      const scope = parsedScope.data;
      const local = parsedLocal.data;
      const broker = parsedBroker.data;
      const upstream = parsedUpstream.data;
      const result = await transact(store, async (tx) => {
        const current = await loadOwnedConnection(
          tx,
          actor,
          connectionRef,
          owns,
        );
        if (!current)
          throw new ConnectorError("not-found", {
            detail: "connection.unknown",
          });
        if (current.revision !== expectedRevision)
          throw new ConnectorError("conflict", {
            detail: "connection.revision",
          });
        const at = await time(tx);
        const before = current.value.record;
        const sharedWith = await sharedRefs(tx, actor.tenantId, before);
        const codes = [
          `disconnect.local.${local}`,
          `disconnect.broker.${broker}`,
          `disconnect.upstream.${upstream}`,
        ];
        if (
          scope !== "local" &&
          sharedWith.length &&
          input.sharedImpactAcknowledged !== true
        )
          codes.push("disconnect.shared-impact-unacknowledged");
        const applied =
          local === "applied" || broker === "applied" || upstream === "applied";
        const uncertain =
          local === "indeterminate" ||
          broker === "indeterminate" ||
          upstream === "indeterminate";
        const lifecycle: ConnectionSummary["lifecycle"] =
          upstream === "applied"
            ? "upstream-revoked"
            : local === "applied" || broker === "applied"
              ? "locally-disconnected"
              : uncertain
                ? "indeterminate"
                : before.lifecycle;
        const { verification: _verification, ...withoutVerification } = before;
        void _verification;
        const record: ConnectionRecord = {
          ...(applied ? withoutVerification : before),
          lifecycle,
          generation: applied ? before.generation + 1 : before.generation,
          lastOutcome: `disconnect.${scope}.${
            upstream === "applied"
              ? "upstream-revoked"
              : applied
                ? "applied"
                : uncertain
                  ? "indeterminate"
                  : "not-applied"
          }`,
          updatedAt: isoAt(at),
        };
        const disconnect: DisconnectRecord = {
          scope,
          local,
          broker,
          upstream,
          at: isoAt(at),
          sharedWith,
          sharedImpactAcknowledged: input.sharedImpactAcknowledged === true,
          codes,
        };
        const revision = await saveConnection(
          tx,
          actor.tenantId,
          record,
          { disconnect },
          current.revision,
        );
        if (applied)
          await settlePendingHandoffs(
            tx,
            actor.tenantId,
            connectionRef,
            "cancelled",
            `disconnect.${scope}`,
            at,
          );
        return { record, disconnect, revision };
      });
      await notifyCache(options.cacheInvalidation, {
        tenantId: actor.tenantId,
        connectionRef,
        keyDigest: keyDigestOf(result.record),
        authorityInstance: result.record.authorityInstance,
        reason: `disconnect.${scope}`,
      });
      return {
        record: {
          ...result.record,
          revision: result.revision,
          disconnect: result.disconnect,
        },
        revision: result.revision,
        generation: result.record.generation,
      };
    },
  };
  return connections;
}

/** Sanitized explanation of a recorded disconnect, for people and audit rows. */
export function explainDisconnect(
  record: StoredConnectionRecord,
): { codes: string[]; sharedWith: string[] } | undefined {
  if (!record.disconnect) return undefined;
  return {
    codes: [...record.disconnect.codes],
    sharedWith: [...record.disconnect.sharedWith],
  };
}
