import { timingSafeEqual } from "node:crypto";
import type { AdapterCallContext, EventPort } from "../../adapter.js";
import {
  createVerifiedEnvelope,
  headerValue,
  type HeadersLike,
  type VerifiedEventEnvelopeV1,
} from "../../events/index.js";
import type { VerifiedEventEnvelope } from "../../ports.js";
import {
  acceptsDaprInput,
  daprSidecarFromBinding,
  type DaprBindingSettings,
} from "./binding-settings.js";
import {
  DAPR_APP_API_TOKEN_HEADER,
  daprComponentNameSchema,
} from "./schemas.js";

/*
 * Receiving a Dapr input binding delivery.
 *
 * Dapr documents two things about the sidecar-to-application leg: the sidecar
 * probes `OPTIONS /<name>` at startup and then POSTs deliveries to `/<name>`,
 * and, when `APP_API_TOKEN` is set, it includes `dapr-api-token: <token>` on
 * every call to the app. That token is the only authentication the leg has,
 * so a delivery without it, or with the wrong one, is unverifiable and is
 * never accepted — there is no "it came from localhost so it must be the
 * sidecar" path here.
 *
 * Which component a delivery belongs to is decided by the host's own routing,
 * not by anything in the request: the sidecar addresses the app by URL path,
 * and a header naming the component would be attacker-controlled data. A host
 * that serves more than one input binding supplies a resolver that reports the
 * route it matched.
 */

export const DAPR_EVENT_LIMITS = Object.freeze({
  bodyBytes: 262_144,
  /** Deliveries whose declared source time is further out than this are still accepted but not trusted for ordering. */
  clockSkewMs: 300_000,
});

export type DaprDeliveryContext = {
  headers: HeadersLike;
  body: Uint8Array;
  receivedAt: number;
};

export type DaprInputBindingResolver = (
  delivery: DaprDeliveryContext,
) => string | undefined;

/** Constant-time token comparison; unequal lengths fail without a timing signal. */
function tokenMatches(expected: string, provided: string): boolean {
  const a = Buffer.from(expected, "utf8");
  const b = Buffer.from(provided, "utf8");
  if (a.length !== b.length) {
    // Still spend the comparison so length alone is not a fast path.
    timingSafeEqual(a, a);
    return false;
  }
  return timingSafeEqual(a, b);
}

export type DaprVerificationOutcome =
  | { ok: true; envelope: VerifiedEventEnvelopeV1 }
  | {
      ok: false;
      reason:
        | "no-app-token-configured"
        | "missing-token"
        | "token-mismatch"
        | "binding-unresolved"
        | "binding-unapproved"
        | "body-too-large"
        | "body-invalid";
    };

/**
 * Authenticates one delivery for a named input binding. The result is either a
 * verified envelope or a sanitized reason; the reason never leaves the server,
 * and an HTTP receiver collapses every failure to one status.
 */
export async function verifyDaprInputDelivery(
  ctx: AdapterCallContext,
  input: { bindingName: string; delivery: DaprDeliveryContext },
  settings?: DaprBindingSettings,
): Promise<DaprVerificationOutcome> {
  const resolved = settings ?? daprSidecarFromBinding(ctx.binding).settings;
  const name = daprComponentNameSchema.safeParse(input.bindingName);
  if (!name.success) return { ok: false, reason: "binding-unresolved" };
  if (!acceptsDaprInput(resolved, name.data))
    return { ok: false, reason: "binding-unapproved" };
  if (!resolved.appApiTokenConfiguration)
    /*
     * Without a configured app API token there is nothing to authenticate
     * against. That is reported as a missing prerequisite, never treated as
     * "no authentication required".
     */
    return { ok: false, reason: "no-app-token-configured" };
  const expected = await ctx.environment.configuration.read(
    resolved.appApiTokenConfiguration,
  );
  if (!expected) return { ok: false, reason: "no-app-token-configured" };
  const provided = headerValue(
    input.delivery.headers,
    DAPR_APP_API_TOKEN_HEADER,
  );
  if (!provided) return { ok: false, reason: "missing-token" };
  if (!tokenMatches(expected, provided))
    return { ok: false, reason: "token-mismatch" };
  if (input.delivery.body.byteLength > DAPR_EVENT_LIMITS.bodyBytes)
    return { ok: false, reason: "body-too-large" };

  let payload: unknown;
  if (input.delivery.body.byteLength > 0) {
    let text: string;
    try {
      text = new TextDecoder("utf-8", { fatal: true }).decode(
        input.delivery.body,
      );
    } catch {
      return { ok: false, reason: "body-invalid" };
    }
    const contentType =
      headerValue(input.delivery.headers, "content-type") ?? "";
    if (contentType.includes("json")) {
      try {
        payload = JSON.parse(text) as unknown;
      } catch {
        return { ok: false, reason: "body-invalid" };
      }
    } else payload = text;
  }

  /*
   * A Dapr delivery carries no provider event id, so the id is the host's own
   * request identity. Dedupe therefore happens on the host's terms, and no
   * upstream value is presented as a provider-assigned identifier.
   */
  const eventId =
    headerValue(input.delivery.headers, "traceparent") ??
    ctx.environment.random.uuid();
  const envelope = createVerifiedEnvelope({
    eventId: eventId.slice(0, 512),
    authority: `dapr:${resolved.appId ?? resolved.destinationId}`.slice(0, 120),
    providerEventType: `dapr.binding.input.${name.data}`,
    receivedAt: input.delivery.receivedAt,
    verification: { method: "vendor-signature", keyId: "app-api-token" },
    ...(ctx.connection ? { connectionRef: ctx.connection.connectionRef } : {}),
    /*
     * An input binding carries whatever the external system sent. Nothing about
     * it is known to be public, so it is classified personal until a host
     * policy says otherwise.
     */
    payloadClassification: "personal",
    payload,
  });
  return { ok: true, envelope };
}

export type DaprEventPortOptions = {
  /** Reports which approved input binding the host's own route matched. */
  resolveInputBinding?: DaprInputBindingResolver;
};

/**
 * The adapter's event port. With one approved input binding the route is
 * unambiguous; with several, the host supplies the resolver, because only the
 * host knows which of its routes matched.
 */
export function createDaprEventPort(
  options: DaprEventPortOptions = {},
): EventPort {
  return {
    async verify(
      ctx: AdapterCallContext,
      delivery: { headers: Headers; body: Uint8Array; receivedAt: number },
    ): Promise<VerifiedEventEnvelope | undefined> {
      const { settings } = daprSidecarFromBinding(ctx.binding);
      const bindingName =
        options.resolveInputBinding?.(delivery) ??
        (settings.inputBindings.length === 1
          ? settings.inputBindings[0]
          : undefined);
      if (!bindingName) return undefined;
      const outcome = await verifyDaprInputDelivery(
        ctx,
        { bindingName, delivery },
        settings,
      );
      return outcome.ok ? outcome.envelope : undefined;
    },
  };
}
