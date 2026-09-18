import { createHmac, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import type { AdapterCallContext } from "../../adapter.js";
import type { ConnectionRecord, VerifiedEventEnvelope } from "../../ports.js";
import { connectionScope, type PipedreamCall } from "./context.js";
import { sha256Hex } from "./identity.js";

/*
 * Lifecycle deliveries (PD-04). Pipedream signs trigger webhook deliveries
 * with HMAC-SHA256: `x-pd-signature: t=<unix seconds>,v1=<hex digest>` over
 * `${t}.${raw body}`, using the signing key returned when the trigger was
 * deployed with a webhook URL. This module authenticates a delivery against
 * the signing keys held for the connection and returns nothing at all when it
 * cannot: an unverifiable delivery is never an event.
 *
 * Connection webhooks (`CONNECTION_SUCCESS`, `CONNECTION_ERROR`, configured
 * through `webhook_uri` on a connect token) carry no signature in Pipedream's
 * documentation. They are therefore refused here and treated elsewhere as
 * untrusted hints that cause a trusted server query, never as evidence.
 */

const MAX_BODY_BYTES = 1024 * 1024;
const MAX_KEYS = 16;
const signaturePattern = /^t=(\d{1,15}),v1=([0-9a-f]{64})$/;

const keyRefSchema = z
  .string()
  .min(1)
  .max(200)
  .regex(/^[^\p{Cc}\s]+$/u);

/**
 * Signing-key references the command layer recorded on the connection when a
 * trigger was deployed. They are references, not keys; the key itself only
 * ever exists inside a custody callback.
 */
export function triggerSigningKeyRefs(
  connection: ConnectionRecord,
): string[] {
  const state = connection.state as {
    pipedreamTriggerKeys?: unknown;
  };
  const raw = state.pipedreamTriggerKeys;
  const values = Array.isArray(raw)
    ? raw
    : raw && typeof raw === "object"
      ? Object.values(raw as Record<string, unknown>)
      : [];
  const refs: string[] = [];
  for (const value of values) {
    const parsed = keyRefSchema.safeParse(value);
    if (parsed.success && !refs.includes(parsed.data)) refs.push(parsed.data);
    if (refs.length >= MAX_KEYS) break;
  }
  return refs;
}

export function parseSignature(
  header: string | null,
): { timestamp: number; digest: string } | undefined {
  if (!header || header.length > 200) return undefined;
  const match = signaturePattern.exec(header.trim());
  if (!match) return undefined;
  const timestamp = Number(match[1]);
  if (!Number.isSafeInteger(timestamp)) return undefined;
  return { timestamp, digest: match[2]! };
}

function matches(signingKey: string, signed: string, digest: string): boolean {
  const expected = createHmac("sha256", signingKey).update(signed).digest();
  const received = Buffer.from(digest, "hex");
  return (
    received.length === expected.length && timingSafeEqual(received, expected)
  );
}

export async function verifyPipedreamDelivery(
  call: PipedreamCall,
  ctx: AdapterCallContext,
  delivery: { headers: Headers; body: Uint8Array; receivedAt: number },
): Promise<VerifiedEventEnvelope | undefined> {
  const connection = ctx.connection;
  if (!connection || connection.tenantId !== ctx.actor.tenantId)
    return undefined;
  if (delivery.body.byteLength > MAX_BODY_BYTES) return undefined;
  const signature = parseSignature(delivery.headers.get("x-pd-signature"));
  if (!signature) return undefined;
  const ageSeconds = Math.abs(
    Math.floor(delivery.receivedAt / 1000) - signature.timestamp,
  );
  if (ageSeconds > call.options.maxSignatureAgeSeconds) return undefined;
  const refs = triggerSigningKeyRefs(connection);
  if (!refs.length) return undefined;
  const raw = new TextDecoder().decode(delivery.body);
  const signed = `${signature.timestamp}.${raw}`;
  const scope = connectionScope(ctx, "host-owned");
  let verified = false;
  for (const ref of refs) {
    try {
      verified = await ctx.environment.credentials.use(
        scope,
        ref,
        async (material) =>
          typeof material.signingKey === "string" &&
          matches(material.signingKey, signed, signature.digest),
      );
    } catch {
      verified = false;
    }
    if (verified) break;
  }
  if (!verified) return undefined;
  let payload: unknown;
  try {
    payload = raw.length ? JSON.parse(raw) : null;
  } catch {
    // A signed delivery whose body is not the documented JSON is still the
    // broker's; it is preserved verbatim as text rather than guessed at.
    payload = { raw: raw.slice(0, 4096) };
  }
  return {
    eventId: `pipedream:${sha256Hex(`${signature.timestamp}.${signature.digest}`)}`,
    authority: call.authority,
    providerEventType: "pipedream.trigger.event",
    receivedAt: delivery.receivedAt,
    sourceTime: signature.timestamp * 1000,
    verification: { method: "vendor-signature" },
    connectionRef: connection.connectionRef,
    payloadClassification: "personal",
    payload,
  };
}
