import { randomUUID } from "node:crypto";
import { z } from "zod";
import {
  demonstrationConsentSchema,
  demonstrationEventSchema,
  type DemonstrationEvent,
} from "../core/teaching-contracts.js";
import {
  demonstrationProjection,
  auditProjection,
  type PublicBindingPolicy,
} from "../core/projections.js";
import { type ActorContext } from "../core/operation-contracts.js";
import { requireCapability, AuthorizationError } from "./identity.js";
import {
  type AsyncCeremonyStore,
  type AsyncTransaction,
  PersistenceConflict,
} from "./persistence/index.js";

export const demonstrationSchema = z.strictObject({
  id: z.string(),
  tenantId: z.string(),
  subjectId: z.string(),
  runId: z.string(),
  scope: z.array(z.string()).max(32),
  consent: demonstrationConsentSchema,
  startSequence: z.number().int().nonnegative(),
  endSequence: z.number().int().nonnegative().nullable(),
});
export type Demonstration = z.infer<typeof demonstrationSchema>;
type Ledger = { sequence: number };
const key = (actor: ActorContext, id: string) => ({
  tenant: actor.tenantId,
  kind: "demonstration" as const,
  id,
});

/** Consent and transitions share a transactional ledger, independent of tab lifetime. */
export class Demonstrations {
  constructor(readonly store: AsyncCeremonyStore) {}
  async start(actor: ActorContext, runId: string, scope: string[] = []) {
    requireCapability(actor, "author");
    return this.store.transaction(async (tx) => {
      const run = await tx.get<{ subjectId: string }>({
        tenant: actor.tenantId,
        kind: "run",
        id: runId,
      });
      if (!run || run.value.subjectId !== actor.subjectId)
        throw new AuthorizationError("denied");
      const ledger = await tx.get<Ledger>({
        tenant: actor.tenantId,
        kind: "event",
        id: `sequence:${runId}`,
      });
      const demo = demonstrationSchema.parse({
        id: `demo:${randomUUID()}`,
        tenantId: actor.tenantId,
        subjectId: actor.subjectId,
        runId,
        scope,
        consent: "recording",
        startSequence: ledger?.value.sequence ?? 0,
        endSequence: null,
      });
      const revision = await tx.put(key(actor, demo.id), demo, null);
      const pointer = {
        tenant: actor.tenantId,
        kind: "session" as const,
        id: `demonstration:${runId}`,
      };
      const previous = await tx.get(pointer);
      await tx.put(pointer, { id: demo.id }, previous?.revision ?? null);
      return { ...demo, revision };
    });
  }
  async change(
    actor: ActorContext,
    id: string,
    expectedRevision: number,
    consent: z.infer<typeof demonstrationConsentSchema>,
  ) {
    requireCapability(actor, "author");
    return this.store.transaction(async (tx) => {
      const saved = await tx.get<Demonstration>(key(actor, id));
      if (!saved || saved.value.subjectId !== actor.subjectId)
        throw new AuthorizationError("denied");
      if (saved.revision !== expectedRevision) throw new PersistenceConflict();
      if (
        saved.value.consent === "discarded" ||
        (saved.value.consent === "stopped" && consent !== "discarded")
      )
        throw new AuthorizationError("denied");
      const ledger = await tx.get<Ledger>({
        tenant: actor.tenantId,
        kind: "event",
        id: `sequence:${saved.value.runId}`,
      });
      const demo = {
        ...saved.value,
        consent: demonstrationConsentSchema.parse(consent),
        endSequence: ledger?.value.sequence ?? 0,
      };
      const revision = await tx.put(key(actor, id), demo, saved.revision);
      if (consent === "discarded") {
        let after = `${id}:`;
        for (;;) {
          const page = await tx.list<{ demonstrationId?: string }>(
            actor.tenantId,
            "event",
            1000,
            after,
          );
          const own = page.filter((record) => record.id.startsWith(`${id}:`));
          for (const record of own) {
            if (record.value.demonstrationId !== id)
              throw new AuthorizationError("denied");
            await tx.delete(
              { tenant: actor.tenantId, kind: "event", id: record.id },
              record.revision,
            );
          }
          if (own.length < 1000) break;
          after = own.at(-1)!.id;
        }
      }
      await tx.put(
        {
          tenant: actor.tenantId,
          kind: "audit",
          id: `consent:${randomUUID()}`,
        },
        {
          kind: "demonstration-consent",
          consent,
          subjectId: actor.subjectId,
          sequence: demo.endSequence,
        },
        null,
      );
      return { ...demo, revision };
    });
  }
  async timeline(actor: ActorContext, id: string, after = 0, limit = 100) {
    if (
      !Number.isSafeInteger(after) ||
      after < 0 ||
      !Number.isSafeInteger(limit) ||
      limit < 1 ||
      limit > 100
    )
      throw new AuthorizationError("invalid_request");
    return this.store.transaction(async (tx) => {
      const saved = await tx.get<Demonstration>(key(actor, id));
      if (
        !saved ||
        saved.value.consent === "discarded" ||
        (saved.value.subjectId !== actor.subjectId &&
          !actor.capabilities.includes("reviewer"))
      )
        throw new AuthorizationError("denied");
      const events = (
        await tx.list<DemonstrationEvent>(
          actor.tenantId,
          "event",
          limit,
          `${id}:${String(after).padStart(12, "0")}`,
        )
      )
        .filter(
          (x) =>
            x.id.startsWith(`${id}:`) &&
            x.value.demonstrationId === id &&
            x.value.sequence > after,
        )
        .map((x) => demonstrationEventSchema.parse(x.value));
      return { ...saved.value, revision: saved.revision, events };
    });
  }
}

/** Caller MUST append in the same transaction as the authoritative state change. */
export async function appendSemanticTransition(
  tx: AsyncTransaction,
  actor: ActorContext,
  runId: string,
  event: Omit<
    DemonstrationEvent,
    "eventId" | "demonstrationId" | "sequence" | "schemaVersion"
  >,
  policy: PublicBindingPolicy,
) {
  const ledgerKey = {
    tenant: actor.tenantId,
    kind: "event" as const,
    id: `sequence:${runId}`,
  };
  const prior = await tx.get<Ledger>(ledgerKey);
  const sequence = (prior?.value.sequence ?? 0) + 1;
  await tx.put(ledgerKey, { sequence }, prior?.revision ?? null);
  const safe = demonstrationProjection(
    {
      ...event,
      schemaVersion: 1,
      eventId: `event:${randomUUID()}`,
      demonstrationId: "audit",
      sequence,
    },
    policy,
  );
  await tx.put(
    { tenant: actor.tenantId, kind: "audit", id: safe.eventId },
    auditProjection(safe),
    null,
  );
  let after = "";
  for (;;) {
    const demos = await tx.list<Demonstration>(
      actor.tenantId,
      "demonstration",
      1000,
      after,
    );
    for (const demo of demos) {
      const d = demo.value;
      if (
        d.runId !== runId ||
        d.subjectId !== actor.subjectId ||
        d.consent !== "recording" ||
        (d.scope.length && !d.scope.includes(event.nodeId))
      )
        continue;
      await tx.put(
        {
          tenant: actor.tenantId,
          kind: "event",
          id: `${d.id}:${String(sequence).padStart(12, "0")}`,
        },
        { ...safe, demonstrationId: d.id },
        null,
      );
    }
    if (demos.length < 1000) break;
    after = demos.at(-1)!.id;
  }
  return sequence;
}
