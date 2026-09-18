import { createHmac, timingSafeEqual } from "node:crypto";
import { canonicalConnectorJson } from "../../../../core/connectors/index.js";
import type { ConnectionLifecycle } from "../../../../core/connectors/index.js";
import type { AdapterCallContext, EventPort } from "../../adapter.js";
import type { VerifiedEventEnvelope } from "../../ports.js";
import {
  brokerReference,
  resolveNango,
  sha256,
  TAG_KEYS,
  type NangoRuntime,
  type Resolved,
} from "./context.js";
import { projectSyncStatus } from "./syncs.js";
import {
  authWebhookOperations,
  authWebhookSchema,
  forwardWebhookSchema,
  genericWebhookSchema,
  NANGO_CONFIGURATION_NAMES,
  NANGO_LIMITS,
  syncWebhookSchema,
} from "./schemas.js";

/*
 * NG-06: webhooks from Nango. Verification is the documented one: the
 * `X-Nango-Hmac-Sha256` header is an HMAC-SHA256 of the raw request body with
 * the environment's webhook signing key (a key distinct from the API key;
 * this adapter never falls back to the API key). The legacy plain-SHA-256
 * `X-Nango-Signature` header is sent for compatibility and is ignored here
 * even when present and correct. Events are then classified, correlated and,
 * in `reconcile`, checked against Nango's own connection/sync state so that
 * duplicates and out-of-order deliveries converge on the same truth.
 */

const SIGNATURE_HEADER = "x-nango-hmac-sha256";
const HEX_64 = /^[0-9a-f]{64}$/i;
const DEDUPE_WINDOW_MS = 60 * 60_000;
const DEDUPE_CAPACITY = 4096;

/** Bounded in-process dedupe used when no shared event inbox is supplied. */
export class BoundedEventInbox {
  private readonly seenAt = new Map<string, number>();
  constructor(
    private readonly capacity = DEDUPE_CAPACITY,
    private readonly windowMs = DEDUPE_WINDOW_MS,
  ) {}
  async seen(authority: string, eventId: string, at: number): Promise<boolean> {
    for (const [key, time] of this.seenAt)
      if (time <= at - this.windowMs) this.seenAt.delete(key);
      else break;
    const key = `${authority}\n${eventId}`;
    if (this.seenAt.has(key)) return true;
    this.seenAt.set(key, at);
    if (this.seenAt.size > this.capacity) {
      const oldest = this.seenAt.keys().next().value;
      if (oldest !== undefined) this.seenAt.delete(oldest);
    }
    return false;
  }
}

function withinBounds(value: unknown): boolean {
  let nodes = 0;
  const stack: Array<{ value: unknown; depth: number }> = [{ value, depth: 0 }];
  while (stack.length) {
    const { value: item, depth } = stack.pop()!;
    if (++nodes > 50_000 || depth > 32) return false;
    if (Array.isArray(item)) for (const entry of item) stack.push({ value: entry, depth: depth + 1 });
    else if (item && typeof item === "object")
      for (const [key, entry] of Object.entries(item as Record<string, unknown>)) {
        if (["__proto__", "prototype", "constructor"].includes(key)) return false;
        stack.push({ value: entry, depth: depth + 1 });
      }
  }
  return true;
}

/** Constant-time comparison of the documented HMAC over the exact bytes received. */
export function verifyNangoSignature(
  signingKey: string,
  body: Uint8Array,
  header: string | null,
): boolean {
  if (!header || !HEX_64.test(header)) return false;
  const expected = createHmac("sha256", signingKey).update(body).digest();
  const provided = Buffer.from(header, "hex");
  return provided.byteLength === expected.byteLength && timingSafeEqual(provided, expected);
}

async function correlate(
  runtime: NangoRuntime,
  resolved: Resolved,
  payload: {
    connectionId: string;
    providerConfigKey: string;
    tags?: Record<string, string> | undefined;
  },
  creation: boolean,
): Promise<string | undefined> {
  const { ctx } = resolved;
  if (creation) {
    const nonce = payload.tags?.[TAG_KEYS.handoff];
    if (!nonce) return undefined;
    const record = await ctx.environment.handoffs.resolveCorrelation(ctx.actor.tenantId, nonce);
    return record && record.tenantId === ctx.actor.tenantId ? record.connectionRef : undefined;
  }
  const found = await runtime.options.resolveConnection?.({
    tenantId: ctx.actor.tenantId,
    authorityInstance: resolved.authority,
    providerConfigKey: payload.providerConfigKey,
    connectionId: payload.connectionId,
  });
  return found?.connectionRef;
}

export function createNangoEventPort(runtime: NangoRuntime): EventPort {
  return {
    async verify(ctx, delivery) {
      const resolved = await resolveNango(runtime, ctx);
      const signingKey = await ctx.environment.configuration.read(
        NANGO_CONFIGURATION_NAMES.webhookSigningKey,
      );
      if (!signingKey) return undefined;
      if (delivery.body.byteLength > NANGO_LIMITS.webhookBytes) return undefined;
      if (!verifyNangoSignature(signingKey, delivery.body, delivery.headers.get(SIGNATURE_HEADER)))
        return undefined;
      let parsed: unknown;
      try {
        parsed = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(delivery.body));
      } catch {
        return undefined;
      }
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed) || !withinBounds(parsed))
        return undefined;
      const eventId = sha256(`${resolved.authority}\n${canonicalConnectorJson(parsed)}`);
      const base = {
        eventId,
        authority: resolved.authority,
        receivedAt: delivery.receivedAt,
        verification: { method: "vendor-signature" as const, keyId: SIGNATURE_HEADER },
        payload: parsed,
      };
      const auth = authWebhookSchema.safeParse(parsed);
      if (auth.success) {
        const body = auth.data;
        if (body.environment && body.environment.toLowerCase() !== resolved.environment)
          return undefined;
        const operation = (authWebhookOperations as readonly string[]).includes(body.operation)
          ? body.operation
          : "unknown";
        const connectionRef = await correlate(runtime, resolved, body, operation === "creation");
        return {
          ...base,
          providerEventType: `nango.auth.${operation}`,
          ...(connectionRef ? { connectionRef } : {}),
          payloadClassification: "personal",
        };
      }
      const sync = syncWebhookSchema.safeParse(parsed);
      if (sync.success) {
        const body = sync.data;
        const sourceTime = Date.parse(body.failedAt ?? body.startedAt ?? body.modifiedAfter ?? "");
        const connectionRef = await correlate(runtime, resolved, body, false);
        return {
          ...base,
          providerEventType: body.success ? "nango.sync.success" : "nango.sync.failure",
          ...(Number.isFinite(sourceTime) ? { sourceTime } : {}),
          ...(connectionRef ? { connectionRef } : {}),
          payloadClassification: "personal",
        };
      }
      const forward = forwardWebhookSchema.safeParse(parsed);
      if (forward.success) {
        const connectionRef = await correlate(runtime, resolved, forward.data, false);
        return {
          ...base,
          providerEventType: "nango.forward",
          ...(connectionRef ? { connectionRef } : {}),
          payloadClassification: "secret",
        };
      }
      const generic = genericWebhookSchema.safeParse(parsed);
      return {
        ...base,
        providerEventType: generic.success && generic.data.type ? "nango.ignored" : "nango.forward.unattributed",
        payloadClassification: "secret",
      };
    },
  };
}

export type NangoReconcileResult = {
  duplicate: boolean;
  ordering: "current" | "stale" | "unknown";
  code: string;
  lifecycle?: ConnectionLifecycle;
  adapterState?: Record<string, unknown>;
  syncStatus?: ReturnType<typeof projectSyncStatus>[];
};

type SyncState = {
  modifiedAfter?: string;
  success: boolean;
  checkpoints?: unknown;
  at: string;
};

/**
 * Applies a verified event to one connection by asking Nango what is true
 * now. The event decides which question to ask; the answer decides the
 * lifecycle. A duplicate is reported and does nothing; an event older than
 * the recorded sync progress is marked stale and changes no state.
 */
export async function reconcileNangoEvent(
  runtime: NangoRuntime,
  inbox: { seen(authority: string, eventId: string, at: number): Promise<boolean> },
  ctx: AdapterCallContext,
  event: VerifiedEventEnvelope,
): Promise<NangoReconcileResult> {
  const resolved = await resolveNango(runtime, ctx);
  const now = ctx.environment.now();
  if (event.authority !== resolved.authority)
    return { duplicate: false, ordering: "unknown", code: "nango.event.authority" };
  if (event.verification.method !== "vendor-signature")
    return { duplicate: false, ordering: "unknown", code: "nango.event.unverified" };
  if (await inbox.seen(event.authority, event.eventId, now))
    return { duplicate: true, ordering: "unknown", code: "nango.event.duplicate" };
  if (event.providerEventType === "nango.auth.creation")
    return { duplicate: false, ordering: "current", code: "nango.event.creation-use-complete" };
  if (event.providerEventType.startsWith("nango.auth.")) {
    const body = authWebhookSchema.safeParse(event.payload);
    if (!body.success) return { duplicate: false, ordering: "unknown", code: "nango.event.malformed" };
    const reference = brokerReference(resolved);
    if (
      body.data.connectionId !== reference.connectionId ||
      body.data.providerConfigKey !== reference.providerConfigKey
    )
      return { duplicate: false, ordering: "unknown", code: "nango.event.connection-mismatch" };
    const list = await resolved.client.listConnections({ connectionId: reference.connectionId });
    const item = list.connections.find(
      (row) =>
        row.connection_id === reference.connectionId &&
        row.provider_config_key === reference.providerConfigKey,
    );
    if (!item)
      return {
        duplicate: false,
        ordering: body.data.operation === "deletion" ? "current" : "unknown",
        code: "nango.connection.deleted",
        lifecycle: "authorization-required",
      };
    const authError = (item.errors ?? []).some((error) => error.type === "auth");
    if (body.data.operation === "deletion")
      return { duplicate: false, ordering: "stale", code: "nango.event.deletion-stale", lifecycle: authError ? "reconnect-required" : "active" };
    if (authError)
      return { duplicate: false, ordering: "current", code: "nango.connection.auth-error", lifecycle: "reconnect-required" };
    if (body.data.operation === "refresh" && !body.data.success)
      return { duplicate: false, ordering: "current", code: "nango.connection.refresh-failed-transient", lifecycle: "degraded" };
    return { duplicate: false, ordering: "current", code: "nango.connection.healthy", lifecycle: "active" };
  }
  if (event.providerEventType.startsWith("nango.sync.")) {
    const body = syncWebhookSchema.safeParse(event.payload);
    if (!body.success) return { duplicate: false, ordering: "unknown", code: "nango.event.malformed" };
    const reference = brokerReference(resolved);
    if (
      body.data.connectionId !== reference.connectionId ||
      body.data.providerConfigKey !== reference.providerConfigKey
    )
      return { duplicate: false, ordering: "unknown", code: "nango.event.connection-mismatch" };
    const key = `${body.data.syncName}::${body.data.model}`;
    const state = ctx.connection?.state;
    const known =
      state && typeof state.nangoSync === "object" && state.nangoSync
        ? (state.nangoSync as Record<string, SyncState>)
        : {};
    const previous = known[key];
    const stale =
      previous?.modifiedAfter !== undefined &&
      body.data.modifiedAfter !== undefined &&
      body.data.modifiedAfter < previous.modifiedAfter;
    const status = await resolved.client.syncStatus({
      provider_config_key: reference.providerConfigKey,
      syncs: body.data.syncName,
      connection_id: reference.connectionId,
    });
    const syncStatus = status.syncs
      .filter((row) => row.connection_id === undefined || row.connection_id === reference.connectionId)
      .map(projectSyncStatus);
    if (stale)
      return { duplicate: false, ordering: "stale", code: "nango.sync.stale-event", syncStatus };
    const next: SyncState = {
      ...(body.data.modifiedAfter ? { modifiedAfter: body.data.modifiedAfter } : {}),
      success: body.data.success,
      // Checkpoints travel exactly as Nango sent them: absent stays absent,
      // null stays null. Nothing here derives or invents a checkpoint.
      ...(body.data.checkpoints !== undefined ? { checkpoints: body.data.checkpoints } : {}),
      at: new Date(now).toISOString(),
    };
    const entries = Object.entries(known).slice(-63);
    return {
      duplicate: false,
      ordering: "current",
      code: body.data.success ? "nango.sync.completed" : "nango.sync.failed",
      adapterState: { nangoSync: { ...Object.fromEntries(entries), [key]: next } },
      syncStatus,
    };
  }
  if (event.providerEventType === "nango.forward") {
    const body = forwardWebhookSchema.safeParse(event.payload);
    if (body.success && ctx.connection) {
      const reference = brokerReference(resolved);
      if (
        body.data.connectionId !== reference.connectionId ||
        body.data.providerConfigKey !== reference.providerConfigKey
      )
        return { duplicate: false, ordering: "unknown", code: "nango.event.connection-mismatch" };
    }
    return { duplicate: false, ordering: "current", code: "nango.event.forwarded" };
  }
  return { duplicate: false, ordering: "unknown", code: "nango.event.ignored" };
}
