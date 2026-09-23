import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";
import {
  connectorReferenceSchema,
  credentialCustodySchema,
  ownerKindSchema,
} from "../../../core/connectors/index.js";
import {
  identifierSchema,
  type ActorContext,
} from "../../../core/operation-contracts.js";
import { requireCapability } from "../../identity.js";
import {
  PersistenceConflict,
  type AsyncCeremonyStore,
  type AsyncTransaction,
  type RecordKey,
} from "../../persistence/index.js";
import { runtimeBindingSchema } from "../binding.js";
import { ConnectorError } from "../errors.js";
import { EVENT_LIMITS, authoritySchema, eventTypeSchema } from "./envelope.js";
import { EVENT_TASK, taskSchema } from "./inbox.js";
import { vendorIdPattern } from "./verification.js";
import { SYSTEM_TENANT } from "../../system-tenants.js";

/*
 * A subscription is the approved fact that events from one authority may be
 * delivered, at one approved destination of one binding, to one connection.
 * The destination is checked against the binding at approval and pinned in
 * the record; changing it is not an update but a new approval that retires
 * the old subscription, because a destination is exactly the thing a review
 * looked at. Every subscription carries the connection generation it was
 * approved under, so cancel, unlink and reconnect can fence it: `fence`
 * retires everything approved under an older generation, and deliveries that
 * were already admitted for a retired subscription surface as stale.
 */

export const SUBSCRIPTION_KIND = "connector-event-subscription" as const;
/** Route lookups arrive with an authority and a subscription id and no tenant; the index under this fixed tenant maps them. */
export const ROUTE_INDEX_TENANT = SYSTEM_TENANT.connectorEvents;
const idAlphabet = /^[a-zA-Z0-9_.:@/-]{1,200}$/;
const noControl = /^[^\p{Cc}]+$/u;
const time = z.number().int().nonnegative();
const dottedCode = z
  .string()
  .regex(/^[a-z][a-z0-9]*(?:[.-][a-z0-9]+){0,11}$/)
  .max(120);
const vendorId = z.string().regex(vendorIdPattern);

export const subscriptionVerificationSchema = z.discriminatedUnion("method", [
  z.strictObject({ method: z.literal("standard-webhooks") }),
  z.strictObject({ method: z.literal("vendor-signature"), vendor: vendorId }),
  z.strictObject({
    method: z.literal("forwarder-signature"),
    /** Authority name of the forwarder (the broker that re-signs). */
    forwarder: authoritySchema,
    /** Registered vendor verifier that checks the forwarder's outbound signature. */
    forwarderVerifier: vendorId,
    upstream: z
      .strictObject({
        authority: authoritySchema,
        verifier: z
          .union([z.literal("standard-webhooks"), vendorId])
          .optional(),
      })
      .optional(),
  }),
]);
export type SubscriptionVerification = z.infer<
  typeof subscriptionVerificationSchema
>;

export const subscriptionStates = ["approved", "active", "retired"] as const;
export const eventSubscriptionSchema = z.strictObject({
  schemaVersion: z.literal(1),
  subscriptionId: connectorReferenceSchema,
  tenantId: z.string().regex(idAlphabet),
  subjectId: z.string().min(1).max(200).regex(noControl),
  ownerKind: ownerKindSchema,
  custody: credentialCustodySchema,
  connectionRef: connectorReferenceSchema,
  bindingRef: connectorReferenceSchema,
  bindingRevision: time,
  authority: authoritySchema,
  destinationId: identifierSchema,
  /** The exact origin approved for this destination when the subscription was approved. */
  destinationOrigin: z.string().max(2048),
  eventTypes: z.array(eventTypeSchema).min(1).max(EVENT_LIMITS.eventTypes),
  /** Custody reference to the signing secret(s); never the secret. */
  secretRef: z.string().min(1).max(200).regex(noControl),
  verification: subscriptionVerificationSchema,
  payloadClassification: z.enum(["public", "personal", "secret"]),
  task: taskSchema,
  generation: time,
  state: z.enum(subscriptionStates),
  approvedAt: time,
  activatedAt: time.optional(),
  retiredAt: time.optional(),
  retiredReason: dottedCode.optional(),
  replaces: connectorReferenceSchema.optional(),
  replacedBy: connectorReferenceSchema.optional(),
  /** The provider's identifiers for the subscription once it was created upstream. */
  externalIds: z
    .record(
      z.string().regex(/^[a-zA-Z][a-zA-Z0-9_.-]{0,63}$/),
      z.string().min(1).max(512).regex(noControl),
    )
    .refine((value) => Object.keys(value).length <= 16),
  policyRevision: z.string().min(1).max(200),
});
export type EventSubscription = z.infer<typeof eventSubscriptionSchema>;

const approveInputSchema = z.strictObject({
  connectionRef: connectorReferenceSchema,
  binding: runtimeBindingSchema,
  destinationId: identifierSchema,
  eventTypes: z.array(eventTypeSchema).min(1).max(EVENT_LIMITS.eventTypes),
  secretRef: z.string().min(1).max(200).regex(noControl),
  verification: subscriptionVerificationSchema,
  authority: authoritySchema,
  generation: time,
  policyRevision: z.string().min(1).max(200),
  ownerKind: ownerKindSchema.default("user"),
  custody: credentialCustodySchema.default("host-owned"),
  payloadClassification: z
    .enum(["public", "personal", "secret"])
    .default("personal"),
  task: taskSchema.default(EVENT_TASK),
});
export type ApproveSubscriptionInput = z.input<typeof approveInputSchema>;

const routeIndexSchema = z.strictObject({
  schemaVersion: z.literal(1),
  tenantId: z.string().regex(idAlphabet),
});

const digest = (...parts: unknown[]) =>
  createHash("sha256").update(JSON.stringify(parts)).digest("hex");

function compact<T extends object>(value: T): T {
  const out: Record<string, unknown> = {};
  for (const [name, item] of Object.entries(value))
    if (item !== undefined) out[name] = item;
  return out as T;
}

export class SubscriptionRegistry {
  constructor(
    private readonly store: AsyncCeremonyStore,
    private readonly options: { newId?: () => string } = {},
  ) {}

  private key(tenantId: string, subscriptionId: string): RecordKey {
    return { tenant: tenantId, kind: SUBSCRIPTION_KIND, id: subscriptionId };
  }
  private routeKey(authority: string, subscriptionId: string): RecordKey {
    return {
      tenant: ROUTE_INDEX_TENANT,
      kind: SUBSCRIPTION_KIND,
      id: `route:${digest(authority, subscriptionId)}`,
    };
  }

  private async transact<T>(
    work: (tx: AsyncTransaction) => Promise<T>,
  ): Promise<T> {
    try {
      return await this.store.transaction(work);
    } catch (error) {
      if (error instanceof PersistenceConflict)
        throw new ConnectorError("conflict", { cause: error });
      throw error;
    }
  }

  private tenantOf(actor: ActorContext): string {
    if (!idAlphabet.test(actor.tenantId))
      throw new ConnectorError("denied", { detail: "tenant.invalid" });
    return actor.tenantId;
  }

  /** Reads one subscription inside an existing transaction; undefined for missing or unreadable records. */
  async readIn(
    tx: AsyncTransaction,
    tenantId: string,
    subscriptionId: string,
  ): Promise<EventSubscription | undefined> {
    if (!idAlphabet.test(tenantId) || !idAlphabet.test(subscriptionId))
      return undefined;
    const stored = await tx.get(this.key(tenantId, subscriptionId));
    if (!stored) return undefined;
    const parsed = eventSubscriptionSchema.safeParse(stored.value);
    return parsed.success ? parsed.data : undefined;
  }

  private async owned(
    tx: AsyncTransaction,
    actor: ActorContext,
    subscriptionId: string,
  ): Promise<{ record: EventSubscription; revision: number }> {
    const stored = await tx.get(this.key(this.tenantOf(actor), subscriptionId));
    const parsed = stored
      ? eventSubscriptionSchema.safeParse(stored.value)
      : undefined;
    // A foreign subscription is indistinguishable from a missing one.
    if (
      !stored ||
      !parsed?.success ||
      parsed.data.subjectId !== actor.subjectId
    )
      throw new ConnectorError("not-found");
    return { record: parsed.data, revision: stored.revision };
  }

  private buildRecord(
    actor: ActorContext,
    input: z.output<typeof approveInputSchema>,
    approvedAt: number,
    replaces?: string,
  ): EventSubscription {
    const tenantId = this.tenantOf(actor);
    if (input.binding.tenantId !== tenantId)
      throw new ConnectorError("denied", {
        detail: "events.binding.foreign-tenant",
      });
    if (input.binding.status !== "approved")
      throw new ConnectorError("denied", {
        detail: "events.binding.not-approved",
      });
    const destination = input.binding.destinations.find(
      (item) => item.id === input.destinationId,
    );
    if (!destination)
      throw new ConnectorError("denied", {
        detail: "events.destination.unapproved",
      });
    return eventSubscriptionSchema.parse(
      compact({
        schemaVersion: 1,
        subscriptionId: this.options.newId?.() ?? `sub:${randomUUID()}`,
        tenantId,
        subjectId: actor.subjectId,
        ownerKind: input.ownerKind,
        custody: input.custody,
        connectionRef: input.connectionRef,
        bindingRef: input.binding.bindingRef,
        bindingRevision: input.binding.revision,
        authority: input.authority,
        destinationId: destination.id,
        destinationOrigin: destination.origin,
        eventTypes: [...new Set(input.eventTypes)],
        secretRef: input.secretRef,
        verification: input.verification,
        payloadClassification: input.payloadClassification,
        task: input.task,
        generation: input.generation,
        state: "approved",
        approvedAt,
        replaces,
        externalIds: {},
        policyRevision: input.policyRevision,
      }),
    );
  }

  private async insert(
    tx: AsyncTransaction,
    record: EventSubscription,
  ): Promise<void> {
    await tx.put(
      this.key(record.tenantId, record.subscriptionId),
      record,
      null,
    );
    await tx.put(
      this.routeKey(record.authority, record.subscriptionId),
      { schemaVersion: 1, tenantId: record.tenantId },
      null,
    );
  }

  /** Approves delivery to one approved destination of the binding; anything else is refused before a record exists. */
  async approve(
    actor: ActorContext,
    input: ApproveSubscriptionInput,
  ): Promise<EventSubscription> {
    requireCapability(actor, "executor");
    const parsed = approveInputSchema.safeParse(input);
    if (!parsed.success)
      throw new ConnectorError("invalid-request", {
        detail: "events.subscription.invalid",
        cause: parsed.error,
      });
    return this.transact(async (tx) => {
      const record = this.buildRecord(actor, parsed.data, await tx.now());
      await this.insert(tx, record);
      return record;
    });
  }

  /**
   * A changed destination (or a re-review of event types under a new binding
   * revision) is a new subscription: the replacement is approved against the
   * binding and the old one is retired in the same transaction, so there is
   * never a moment where an unreviewed destination receives deliveries.
   */
  async replace(
    actor: ActorContext,
    subscriptionId: string,
    changes: Pick<ApproveSubscriptionInput, "binding" | "destinationId"> &
      Partial<Pick<ApproveSubscriptionInput, "eventTypes" | "policyRevision">>,
  ): Promise<{ retired: EventSubscription; approved: EventSubscription }> {
    requireCapability(actor, "executor");
    return this.transact(async (tx) => {
      const { record: previous, revision } = await this.owned(
        tx,
        actor,
        subscriptionId,
      );
      if (previous.state === "retired")
        throw new ConnectorError("conflict", {
          detail: "events.subscription.retired",
        });
      const parsed = approveInputSchema.safeParse({
        connectionRef: previous.connectionRef,
        binding: changes.binding,
        destinationId: changes.destinationId,
        eventTypes: changes.eventTypes ?? previous.eventTypes,
        secretRef: previous.secretRef,
        verification: previous.verification,
        authority: previous.authority,
        generation: previous.generation,
        policyRevision: changes.policyRevision ?? previous.policyRevision,
        ownerKind: previous.ownerKind,
        custody: previous.custody,
        payloadClassification: previous.payloadClassification,
        task: previous.task,
      });
      if (!parsed.success)
        throw new ConnectorError("invalid-request", {
          detail: "events.subscription.invalid",
          cause: parsed.error,
        });
      const now = await tx.now();
      const approved = this.buildRecord(
        actor,
        parsed.data,
        now,
        previous.subscriptionId,
      );
      const retired: EventSubscription = {
        ...previous,
        state: "retired",
        retiredAt: now,
        retiredReason: "destination-changed",
        replacedBy: approved.subscriptionId,
      };
      await tx.put(
        this.key(previous.tenantId, previous.subscriptionId),
        retired,
        revision,
      );
      await this.insert(tx, approved);
      return { retired, approved };
    });
  }

  async activate(
    actor: ActorContext,
    subscriptionId: string,
    externalIds: Record<string, string> = {},
  ): Promise<EventSubscription> {
    requireCapability(actor, "executor");
    return this.transact(async (tx) => {
      const { record, revision } = await this.owned(tx, actor, subscriptionId);
      if (record.state !== "approved")
        throw new ConnectorError("conflict", {
          detail: "events.subscription.not-approved",
        });
      const active = eventSubscriptionSchema.parse({
        ...record,
        state: "active",
        activatedAt: await tx.now(),
        externalIds: { ...record.externalIds, ...externalIds },
      });
      await tx.put(
        this.key(record.tenantId, record.subscriptionId),
        active,
        revision,
      );
      return active;
    });
  }

  async retire(
    actor: ActorContext,
    subscriptionId: string,
    reason: string,
  ): Promise<EventSubscription> {
    requireCapability(actor, "executor");
    const code = dottedCode.parse(reason);
    return this.transact(async (tx) => {
      const { record, revision } = await this.owned(tx, actor, subscriptionId);
      if (record.state === "retired") return record;
      const retired: EventSubscription = {
        ...record,
        state: "retired",
        retiredAt: await tx.now(),
        retiredReason: code,
      };
      await tx.put(
        this.key(record.tenantId, record.subscriptionId),
        retired,
        revision,
      );
      return retired;
    });
  }

  /**
   * Generation fence: every subscription of the connection approved under an
   * older generation is retired. Called by the command layer whenever the
   * connection generation advances (cancel, unlink, reconnect), it makes any
   * already-admitted delivery for those subscriptions stale.
   */
  async fence(
    tenantId: string,
    connectionRef: string,
    generation: number,
  ): Promise<number> {
    if (!idAlphabet.test(tenantId))
      throw new ConnectorError("denied", { detail: "tenant.invalid" });
    return this.transact(async (tx) => {
      let retired = 0;
      let after = "sub:";
      for (;;) {
        const page = await tx.list<unknown>(
          tenantId,
          SUBSCRIPTION_KIND,
          200,
          after,
        );
        for (const entry of page) {
          if (!entry.id.startsWith("sub:")) return retired;
          const parsed = eventSubscriptionSchema.safeParse(entry.value);
          if (
            !parsed.success ||
            parsed.data.connectionRef !== connectionRef ||
            parsed.data.state === "retired" ||
            parsed.data.generation >= generation
          )
            continue;
          await tx.put(
            this.key(tenantId, entry.id),
            {
              ...parsed.data,
              state: "retired",
              retiredAt: await tx.now(),
              retiredReason: "generation-advanced",
            },
            entry.revision,
          );
          retired++;
        }
        if (page.length < 200) return retired;
        after = page.at(-1)!.id;
      }
    });
  }

  async get(
    actor: ActorContext,
    subscriptionId: string,
  ): Promise<EventSubscription | undefined> {
    return this.store.transaction(async (tx) => {
      const record = await this.readIn(
        tx,
        this.tenantOf(actor),
        subscriptionId,
      );
      return record && record.subjectId === actor.subjectId
        ? record
        : undefined;
    });
  }

  async list(
    actor: ActorContext,
    connectionRef?: string,
  ): Promise<EventSubscription[]> {
    const tenantId = this.tenantOf(actor);
    return this.store.transaction(async (tx) => {
      const found: EventSubscription[] = [];
      let after = "sub:";
      for (;;) {
        const page = await tx.list<unknown>(
          tenantId,
          SUBSCRIPTION_KIND,
          200,
          after,
        );
        for (const entry of page) {
          if (!entry.id.startsWith("sub:")) return found;
          const parsed = eventSubscriptionSchema.safeParse(entry.value);
          if (
            parsed.success &&
            parsed.data.subjectId === actor.subjectId &&
            (!connectionRef || parsed.data.connectionRef === connectionRef)
          )
            found.push(parsed.data);
        }
        if (page.length < 200) return found;
        after = page.at(-1)!.id;
      }
    });
  }

  /** Receiver lookup by route: the index names the tenant, the record must agree on authority and id. */
  async resolveRoute(
    authority: string,
    subscriptionId: string,
  ): Promise<EventSubscription | undefined> {
    if (
      !authoritySchema.safeParse(authority).success ||
      !connectorReferenceSchema.safeParse(subscriptionId).success
    )
      return undefined;
    return this.store.transaction(async (tx) => {
      const index = await tx.get(this.routeKey(authority, subscriptionId));
      const pointer = index
        ? routeIndexSchema.safeParse(index.value)
        : undefined;
      if (!pointer?.success) return undefined;
      const record = await this.readIn(
        tx,
        pointer.data.tenantId,
        subscriptionId,
      );
      return record &&
        record.authority === authority &&
        record.subscriptionId === subscriptionId
        ? record
        : undefined;
    });
  }
}
