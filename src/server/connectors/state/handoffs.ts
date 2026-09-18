import { z } from "zod";
import type { ConnectorHandoffSummary } from "../../../core/connectors/index.js";
import type {
  AsyncCeremonyStore,
  AsyncTransaction,
} from "../../persistence/index.js";
import { ConnectorError } from "../errors.js";
import type {
  Clock,
  HandoffIssue,
  HandoffPort,
  HandoffRecord,
} from "../ports.js";
import {
  SCHEMA_VERSION,
  checkActor,
  checkTenant,
  compact,
  isReference,
  isoAt,
  newRef,
  readRecord,
  registerRef,
  resolveRef,
  scanPrefix,
  timeSource,
  transact,
} from "./common.js";
import {
  connectionKey,
  correlationKey,
  handoffKey,
  handoffPointerKey,
  handoffPointerPrefix,
} from "./keys.js";
import {
  correlationIndexSchema,
  handoffIssueInputSchema,
  handoffPointerSchema,
  stateCodeSchema,
  storedConnectionSchema,
  storedHandoffSchema,
  type StoredHandoff,
} from "./schemas.js";

/*
 * Durable connector handoffs, modelled on DurableAuthorizationCode. A handoff
 * is issued for one connection generation by one authenticated human in one
 * session; its private material (destination, PKCE verifier, widget token,
 * device code) is encrypted at rest and is shown only to that person through
 * `present`. An external completion is routed by a hashed correlation index
 * within one tenant and completes exactly once, fenced by generation, so a
 * callback that arrives after a cancel, unlink or reconnect can neither
 * reactivate nor overwrite the newer connection.
 */

export type HandoffOptions = { now?: Clock };

const pending = (state: StoredHandoff["state"]) =>
  state === "issued" || state === "waiting";

const summaryOf = (record: StoredHandoff): ConnectorHandoffSummary => ({
  handoffRef: record.handoffRef,
  kind: record.kind,
  state: record.state,
  presentation: record.presentation,
  expiresAt: isoAt(record.expiresAt),
  generation: record.generation,
});

const recordOf = (value: StoredHandoff): HandoffRecord => {
  const {
    schemaVersion: _schema,
    completedAt: _completed,
    reason: _reason,
    ...rest
  } = value;
  void _schema;
  void _completed;
  void _reason;
  return compact({ ...rest, private: { ...rest.private } });
};

const connectionRefIndex = (connectionRef: string) =>
  `connection:${connectionRef}`;

/** Marks every pending handoff of a connection; used by cancel, unlink and generation fences in the same transaction. */
export async function settlePendingHandoffs(
  tx: AsyncTransaction,
  tenantId: string,
  connectionRef: string,
  state: "cancelled" | "superseded",
  reason: string,
  at: number,
): Promise<number> {
  const refs: string[] = [];
  await scanPrefix(
    tx,
    tenantId,
    "connector-handoff",
    handoffPointerPrefix(connectionRef),
    handoffPointerSchema,
    ({ value }) => {
      refs.push(value.handoffRef);
    },
  );
  let count = 0;
  for (const handoffRef of refs) {
    const record = await readRecord(
      tx,
      handoffKey(tenantId, handoffRef),
      storedHandoffSchema,
    );
    if (!record || !pending(record.value.state)) continue;
    await tx.put(
      handoffKey(tenantId, handoffRef),
      { ...record.value, state, reason, completedAt: at } satisfies StoredHandoff,
      record.revision,
    );
    await dropCorrelation(tx, tenantId, record.value);
    count++;
  }
  return count;
}

async function dropCorrelation(
  tx: AsyncTransaction,
  tenantId: string,
  record: StoredHandoff,
): Promise<void> {
  if (record.correlationKey === undefined) return;
  const key = correlationKey(tenantId, record.correlationKey);
  const index = await readRecord(tx, key, correlationIndexSchema);
  if (index && index.value.handoffRef === record.handoffRef)
    await tx.delete(key, index.revision);
}

/** A pending handoff past its expiry becomes expired the moment anyone looks at it. */
async function settleExpiry(
  tx: AsyncTransaction,
  tenantId: string,
  record: { revision: number; value: StoredHandoff },
  at: number,
): Promise<StoredHandoff> {
  if (!pending(record.value.state) || record.value.expiresAt > at)
    return record.value;
  const expired: StoredHandoff = {
    ...record.value,
    state: "expired",
    reason: "handoff.expired",
    completedAt: at,
  };
  await tx.put(
    handoffKey(tenantId, record.value.handoffRef),
    expired,
    record.revision,
  );
  await dropCorrelation(tx, tenantId, record.value);
  return expired;
}

export function createHandoffPort(
  store: AsyncCeremonyStore,
  options: HandoffOptions = {},
): HandoffPort {
  const time = timeSource(options.now);
  return {
    async issue(input: HandoffIssue) {
      const actor = checkActor(input.actor);
      const { actor: _actor, ...rest } = input;
      void _actor;
      const parsed = handoffIssueInputSchema.safeParse(rest);
      if (!parsed.success)
        throw new ConnectorError("invalid-request", { detail: "handoff.input" });
      const issue = parsed.data;
      const handoffRef = newRef("handoff");
      const record = await transact(store, async (tx) => {
        const at = await time(tx);
        if (issue.expiresAt <= at)
          throw new ConnectorError("invalid-request", {
            detail: "handoff.expires-at",
          });
        const record: StoredHandoff = compact({
          schemaVersion: SCHEMA_VERSION,
          ...issue,
          handoffRef,
          tenantId: actor.tenantId,
          subjectId: actor.subjectId,
          sessionId: actor.sessionId,
          state: "issued",
          issuedAt: at,
        });
        if (issue.correlationKey !== undefined) {
          const key = correlationKey(actor.tenantId, issue.correlationKey);
          const existing = await readRecord(tx, key, correlationIndexSchema);
          if (existing) {
            const owner = await readRecord(
              tx,
              handoffKey(actor.tenantId, existing.value.handoffRef),
              storedHandoffSchema,
            );
            if (owner && pending(owner.value.state) && owner.value.expiresAt > at)
              throw new ConnectorError("conflict", {
                detail: "handoff.correlation-in-use",
              });
            await tx.put(
              key,
              {
                schemaVersion: SCHEMA_VERSION,
                handoffRef,
                expiresAt: issue.expiresAt,
              },
              existing.revision,
            );
          } else
            await tx.put(
              key,
              {
                schemaVersion: SCHEMA_VERSION,
                handoffRef,
                expiresAt: issue.expiresAt,
              },
              null,
            );
        }
        await tx.put(handoffKey(actor.tenantId, handoffRef), record, null);
        await tx.put(
          handoffPointerKey(actor.tenantId, issue.connectionRef, handoffRef),
          { schemaVersion: SCHEMA_VERSION, handoffRef },
          null,
        );
        await registerRef(
          tx,
          "connector-handoff",
          handoffRef,
          actor.tenantId,
          "handoff.ref-conflict",
        );
        // The connection reference is owned by one tenant; cancelAll relies on it.
        await registerRef(
          tx,
          "connector-handoff",
          connectionRefIndex(issue.connectionRef),
          actor.tenantId,
          "handoff.connection-conflict",
        );
        return record;
      });
      return { handoffRef, summary: summaryOf(record) };
    },

    async present(rawActor, handoffRef) {
      const actor = checkActor(rawActor);
      if (actor.actorKind !== "human" || !isReference(handoffRef))
        return undefined;
      return transact(store, async (tx) => {
        const record = await readRecord(
          tx,
          handoffKey(actor.tenantId, handoffRef),
          storedHandoffSchema,
        );
        if (
          !record ||
          record.value.tenantId !== actor.tenantId ||
          record.value.subjectId !== actor.subjectId ||
          record.value.sessionId !== actor.sessionId
        )
          return undefined;
        return recordOf(
          await settleExpiry(tx, actor.tenantId, record, await time(tx)),
        );
      });
    },

    async resolveCorrelation(rawTenant, correlation) {
      const tenantId = checkTenant(rawTenant);
      if (
        typeof correlation !== "string" ||
        !correlation.length ||
        correlation.length > 1024
      )
        return undefined;
      return transact(store, async (tx) => {
        const index = await readRecord(
          tx,
          correlationKey(tenantId, correlation),
          correlationIndexSchema,
        );
        if (!index) return undefined;
        const record = await readRecord(
          tx,
          handoffKey(tenantId, index.value.handoffRef),
          storedHandoffSchema,
        );
        if (!record || record.value.correlationKey !== correlation)
          return undefined;
        return recordOf(
          await settleExpiry(tx, tenantId, record, await time(tx)),
        );
      });
    },

    async complete(handoffRef, expectedGeneration, state) {
      const target = z
        .enum(["completed", "denied", "expired", "cancelled", "superseded"])
        .safeParse(state);
      if (!target.success || !Number.isSafeInteger(expectedGeneration))
        throw new ConnectorError("invalid-request", { detail: "handoff.state" });
      if (!isReference(handoffRef))
        throw new ConnectorError("not-found", { detail: "handoff.unknown" });
      return transact(store, async (tx) => {
        const tenantId = await resolveRef(tx, "connector-handoff", handoffRef);
        if (!tenantId)
          throw new ConnectorError("not-found", { detail: "handoff.unknown" });
        const key = handoffKey(tenantId, handoffRef);
        const record = await readRecord(tx, key, storedHandoffSchema);
        if (!record)
          throw new ConnectorError("not-found", { detail: "handoff.unknown" });
        const at = await time(tx);
        const current = await settleExpiry(tx, tenantId, record, at);
        if (current.generation !== expectedGeneration)
          throw new ConnectorError("conflict", {
            detail: "handoff.stale-generation",
          });
        if (!pending(current.state)) {
          if (current.state === "expired")
            throw new ConnectorError("expired", { detail: "handoff.expired" });
          throw new ConnectorError("conflict", {
            detail: "handoff.already-completed",
          });
        }
        // A connection that moved on since issue fences this handoff even when
        // the caller passed the handoff's own generation as the expectation.
        const connection = await readRecord(
          tx,
          connectionKey(tenantId, current.connectionRef),
          storedConnectionSchema,
        );
        if (
          connection &&
          connection.value.record.generation !== current.generation
        ) {
          await tx.put(
            key,
            {
              ...current,
              state: "superseded",
              reason: "handoff.stale-generation",
              completedAt: at,
            } satisfies StoredHandoff,
            record.revision,
          );
          await dropCorrelation(tx, tenantId, current);
          throw new ConnectorError("conflict", {
            detail: "handoff.stale-generation",
          });
        }
        const completed: StoredHandoff = {
          ...current,
          state: target.data,
          completedAt: at,
        };
        await tx.put(key, completed, record.revision);
        await dropCorrelation(tx, tenantId, current);
        return recordOf(completed);
      });
    },

    async cancelAll(connectionRef, reason) {
      const code = stateCodeSchema.safeParse(reason);
      if (!code.success || !isReference(connectionRef))
        throw new ConnectorError("invalid-request", {
          detail: "handoff.cancel-reason",
        });
      return transact(store, async (tx) => {
        const tenantId = await resolveRef(
          tx,
          "connector-handoff",
          connectionRefIndex(connectionRef),
        );
        if (!tenantId) return 0;
        return settlePendingHandoffs(
          tx,
          tenantId,
          connectionRef,
          "cancelled",
          code.data,
          await time(tx),
        );
      });
    },
  };
}
