import { connectorReferenceSchema } from "../../../core/connectors/index.js";
import type {
  CredentialCustodyPort,
  CredentialMaterial,
  CredentialScope,
} from "../ports.js";
import {
  EVENT_LIMITS,
  authoritySchema,
  createVerifiedEnvelope,
  eventIdSchema,
  eventTypeSchema,
  keyIdSchema,
  measurePayload,
  type ForwarderHop,
  type VerificationMethod,
} from "./envelope.js";
import { verifyForwardedDelivery } from "./forwarded.js";
import type { EventInbox } from "./inbox.js";
import {
  lifecycleSignalSchema,
  type EventHandler,
  type LifecycleSignal,
} from "./lifecycle.js";
import { verifyStandardWebhook } from "./standard-webhooks.js";
import type {
  EventSubscription,
  SubscriptionRegistry,
} from "./subscriptions.js";
import type {
  DeliveryIdentity,
  SecretMaterial,
  VendorVerifierPort,
  VerificationFailure,
} from "./verification.js";

/*
 * The authenticated webhook receiver. Its route names an authority and a
 * subscription; nothing in the request may name a tenant, an owner or a
 * connection. Bytes are bounded before they are read and verified before they
 * are parsed; every refusal is a fixed 4xx body that echoes neither the
 * request body nor a header, and the reason goes to an audit hook instead.
 * Only after the source is authenticated does an envelope exist, and only
 * then does it enter the inbox, whose transaction is the point at which a
 * delivery becomes a durable fact.
 */

export type ResolvedSecrets = {
  /** Keys for the verification the subscription names (provider, vendor or forwarder). */
  current: SecretMaterial[];
  /** Keys for the original provider behind a forwarder, when this deployment holds them. */
  upstream: SecretMaterial[];
};
export type ReceiverTarget = {
  subscription: EventSubscription;
  /** Runs verification inside credential custody; the callback's result carries no material. */
  useSecrets<T>(work: (secrets: ResolvedSecrets) => Promise<T>): Promise<T>;
};
export type ResolveSecrets = (route: {
  authority: string;
  subscriptionId: string;
}) => Promise<ReceiverTarget | undefined>;

export type IdentifyInput = {
  headers: Headers;
  payload: unknown;
  /** What the verifier itself established (a Standard Webhooks id, a signed timestamp). */
  identity: DeliveryIdentity;
  subscription: Pick<EventSubscription, "authority" | "eventTypes">;
};

export type ReceiverAudit = {
  at: number;
  authority?: string;
  subscriptionId?: string;
  status: number;
  code: string;
  reason?: VerificationFailure;
};

export type ReceiverPolicy = {
  /** Path prefix the route follows: `${mountPath}/<authority>/<subscriptionId>`. */
  mountPath?: string;
  maxBodyBytes?: number;
  contentTypes?: string[];
  toleranceSeconds?: number;
  /** Provider-specific identification when the verifier cannot name the event. */
  identify?: (input: IdentifyInput) => DeliveryIdentity | undefined;
  /** Maps provider event types to connection lifecycle signals; a hint the dispatcher interprets. */
  lifecycle?: (input: {
    providerEventType: string;
    payload: unknown;
  }) => LifecycleSignal | undefined;
  audit?: (event: ReceiverAudit) => void;
  /** Drains this tenant's continuations before responding; otherwise a worker drains later. */
  deliverInline?: boolean;
  now?: () => number;
};

export type WebhookReceiverOptions = {
  resolveSecrets: ResolveSecrets;
  inbox: EventInbox;
  policy?: ReceiverPolicy;
  verifiers?: readonly VendorVerifierPort[];
  handlers?: Readonly<Record<string, EventHandler>>;
};

const DEFAULT_MOUNT = "/api/v1/connectors/events";

function parseRoute(
  url: URL,
  mountPath: string,
): { authority: string; subscriptionId: string } | undefined {
  if (!url.pathname.startsWith(`${mountPath}/`)) return undefined;
  const rest = url.pathname.slice(mountPath.length + 1).split("/");
  if (rest.length !== 2) return undefined;
  const [authority, subscriptionId] = rest;
  if (
    !authority ||
    !subscriptionId ||
    !authoritySchema.safeParse(authority).success ||
    !connectorReferenceSchema.safeParse(subscriptionId).success
  )
    return undefined;
  return { authority, subscriptionId };
}

async function readBounded(
  request: Request,
  maxBytes: number,
): Promise<Uint8Array | "too-large" | "unreadable"> {
  const reader = request.body?.getReader();
  if (!reader) return new Uint8Array();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maxBytes) {
        await reader.cancel().catch(() => {});
        return "too-large";
      }
      chunks.push(value);
    }
  } catch {
    return "unreadable";
  }
  return new Uint8Array(Buffer.concat(chunks));
}

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" &&
  value !== null &&
  !Array.isArray(value) &&
  (Object.getPrototypeOf(value) === Object.prototype ||
    Object.getPrototypeOf(value) === null);

type Verified = {
  ok: true;
  method: VerificationMethod;
  keyId: string;
  hops: ForwarderHop[];
  identity: DeliveryIdentity;
};

export function createWebhookReceiver(
  options: WebhookReceiverOptions,
): (request: Request) => Promise<Response> {
  const policy = options.policy ?? {};
  const mountPath = (policy.mountPath ?? DEFAULT_MOUNT).replace(/\/+$/, "");
  const maxBodyBytes = policy.maxBodyBytes ?? EVENT_LIMITS.bodyBytes;
  const contentTypes = policy.contentTypes ?? ["application/json"];
  const now = policy.now ?? Date.now;
  const verifiers = new Map(
    (options.verifiers ?? []).map((verifier) => [verifier.id, verifier]),
  );

  const respond = (
    status: number,
    body: Record<string, string>,
    audit: Omit<ReceiverAudit, "at" | "status">,
    headers: Record<string, string> = {},
  ): Response => {
    policy.audit?.({ at: now(), status, ...audit });
    return new Response(JSON.stringify(body), {
      status,
      headers: {
        "content-type": "application/json",
        "cache-control": "no-store",
        ...headers,
      },
    });
  };

  const verify = async (
    target: ReceiverTarget,
    headers: Headers,
    body: Uint8Array,
    receivedAt: number,
  ): Promise<Verified | { ok: false; reason: VerificationFailure }> => {
    const verification = target.subscription.verification;
    return target.useSecrets(async (secrets) => {
      if (!secrets.current.length)
        return { ok: false as const, reason: "verifier-unavailable" as const };
      if (verification.method === "standard-webhooks") {
        const result = verifyStandardWebhook({
          headers,
          body,
          secrets: secrets.current,
          toleranceSeconds:
            policy.toleranceSeconds ?? EVENT_LIMITS.toleranceSeconds,
          now: receivedAt,
        });
        if (!result.ok) return result;
        return {
          ok: true as const,
          method: "standard-webhooks" as const,
          keyId: result.keyId,
          hops: [],
          identity: { eventId: result.messageId, sourceTime: result.sourceTime },
        };
      }
      if (verification.method === "vendor-signature") {
        const verifier = verifiers.get(verification.vendor);
        if (!verifier)
          return {
            ok: false as const,
            reason: "verifier-unavailable" as const,
          };
        let result;
        try {
          result = await verifier.verify(
            { headers, body, receivedAt },
            secrets.current,
          );
        } catch {
          return {
            ok: false as const,
            reason: "verifier-unavailable" as const,
          };
        }
        if (!result.ok) return result;
        return {
          ok: true as const,
          method: "vendor-signature" as const,
          keyId: result.keyId,
          hops: [],
          identity: result.identity ?? {},
        };
      }
      const forwarderVerifier = verifiers.get(verification.forwarderVerifier);
      if (!forwarderVerifier)
        return { ok: false as const, reason: "verifier-unavailable" as const };
      const upstreamVerifier =
        verification.upstream?.verifier === undefined
          ? undefined
          : verification.upstream.verifier === "standard-webhooks"
            ? ("standard-webhooks" as const)
            : verifiers.get(verification.upstream.verifier);
      const result = await verifyForwardedDelivery({
        delivery: { headers, body, receivedAt },
        forwarder: {
          authority: verification.forwarder,
          verifier: forwarderVerifier,
          secrets: secrets.current,
        },
        ...(verification.upstream
          ? {
              upstream: {
                authority: verification.upstream.authority,
                ...(upstreamVerifier ? { verifier: upstreamVerifier } : {}),
                secrets: secrets.upstream,
              },
            }
          : {}),
      });
      if (!result.ok) return { ok: false as const, reason: result.reason };
      return {
        ok: true as const,
        method: "forwarder-signature" as const,
        keyId: result.keyId,
        hops: result.hops,
        identity: result.identity ?? {},
      };
    });
  };

  return async (request: Request): Promise<Response> => {
    const receivedAt = now();
    if (request.method !== "POST")
      return respond(
        405,
        { error: "method" },
        { code: "method-not-allowed" },
        { allow: "POST" },
      );
    const route = parseRoute(new URL(request.url), mountPath);
    if (!route)
      return respond(404, { error: "unknown" }, { code: "unknown-route" });
    const audit = {
      authority: route.authority,
      subscriptionId: route.subscriptionId,
    };
    const length = request.headers.get("content-length");
    if (length !== null && (!/^\d{1,12}$/.test(length) || Number(length) > maxBodyBytes))
      return respond(413, { error: "too-large" }, { ...audit, code: "too-large" });
    const mediaType =
      request.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase() ??
      "";
    if (!contentTypes.includes(mediaType))
      return respond(
        415,
        { error: "unsupported-media-type" },
        { ...audit, code: "unsupported-media-type" },
      );
    let target: ReceiverTarget | undefined;
    try {
      target = await options.resolveSecrets(route);
    } catch {
      return respond(503, { error: "unavailable" }, { ...audit, code: "resolve-failed" });
    }
    if (!target)
      return respond(404, { error: "unknown" }, { ...audit, code: "unknown-subscription" });
    const subscription = target.subscription;
    if (subscription.state === "retired")
      return respond(410, { error: "retired" }, { ...audit, code: "retired" });
    if (subscription.authority !== route.authority)
      return respond(404, { error: "unknown" }, { ...audit, code: "authority-mismatch" });

    const body = await readBounded(request, maxBodyBytes);
    if (body === "too-large")
      return respond(413, { error: "too-large" }, { ...audit, code: "too-large" });
    if (body === "unreadable")
      return respond(400, { error: "malformed" }, { ...audit, code: "unreadable" });

    let verified: Verified | { ok: false; reason: VerificationFailure };
    try {
      verified = await verify(target, request.headers, body, receivedAt);
    } catch {
      verified = { ok: false, reason: "verifier-unavailable" };
    }
    if (!verified.ok)
      return respond(
        401,
        { error: "unverified" },
        { ...audit, code: "unverified", reason: verified.reason },
      );

    // Only now are the bytes worth parsing.
    let payload: unknown;
    try {
      payload = JSON.parse(Buffer.from(body).toString("utf8"));
    } catch {
      return respond(400, { error: "malformed" }, { ...audit, code: "malformed" });
    }
    if (!measurePayload(payload, { bytes: EVENT_LIMITS.payloadBytes, depth: EVENT_LIMITS.payloadDepth, nodes: EVENT_LIMITS.payloadNodes }).ok)
      return respond(400, { error: "malformed" }, { ...audit, code: "payload-bounds" });

    const hinted = verified.identity;
    let custom: DeliveryIdentity | undefined;
    try {
      custom = policy.identify?.({
        headers: request.headers,
        payload,
        identity: hinted,
        subscription: {
          authority: subscription.authority,
          eventTypes: subscription.eventTypes,
        },
      });
    } catch {
      custom = undefined;
    }
    const eventId = custom?.eventId ?? hinted.eventId;
    const providerEventType =
      custom?.providerEventType ??
      hinted.providerEventType ??
      (isPlainObject(payload) && typeof payload.type === "string"
        ? payload.type
        : undefined);
    const sourceTime = custom?.sourceTime ?? hinted.sourceTime;
    if (
      !eventIdSchema.safeParse(eventId).success ||
      !eventTypeSchema.safeParse(providerEventType).success ||
      (sourceTime !== undefined &&
        !(Number.isSafeInteger(sourceTime) && sourceTime >= 0)) ||
      !keyIdSchema.safeParse(verified.keyId).success
    )
      return respond(400, { error: "unidentified" }, { ...audit, code: "unidentified" });
    const type = providerEventType as string;
    if (
      !subscription.eventTypes.includes("*") &&
      !subscription.eventTypes.includes(type)
    )
      return respond(202, { status: "ignored" }, { ...audit, code: "event-type-not-subscribed" });

    let lifecycle: LifecycleSignal | undefined;
    try {
      const signal = policy.lifecycle?.({ providerEventType: type, payload });
      const parsed = signal ? lifecycleSignalSchema.safeParse(signal) : undefined;
      lifecycle = parsed?.success ? parsed.data : undefined;
    } catch {
      lifecycle = undefined;
    }

    let envelope;
    try {
      envelope = createVerifiedEnvelope({
        eventId: eventId as string,
        authority: subscription.authority,
        providerEventType: type,
        receivedAt,
        sourceTime,
        verification: {
          method: verified.method,
          keyId: verified.keyId,
          verifiedAt: now(),
        },
        connectionRef: subscription.connectionRef,
        payloadClassification: subscription.payloadClassification,
        payload,
        forwarderHops: verified.hops,
      });
    } catch {
      return respond(400, { error: "malformed" }, { ...audit, code: "envelope-invalid" });
    }

    let admitted;
    try {
      admitted = await options.inbox.admit({
        tenantId: subscription.tenantId,
        subjectId: subscription.subjectId,
        envelope,
        task: subscription.task,
        connectionRef: subscription.connectionRef,
        subscriptionId: subscription.subscriptionId,
        generation: subscription.generation,
        ...(lifecycle ? { lifecycle } : {}),
      });
    } catch {
      return respond(503, { error: "unavailable" }, { ...audit, code: "inbox-unavailable" });
    }
    if (admitted.outcome === "duplicate")
      return respond(200, { status: "duplicate" }, { ...audit, code: "duplicate" });
    if (policy.deliverInline && options.handlers)
      await options.inbox
        .drain({ tenantId: subscription.tenantId, handlers: options.handlers })
        .catch(() => {});
    return respond(200, { status: "accepted" }, { ...audit, code: "accepted" });
  };
}

/** Material convention: each key is a keyId and its value the secret; keys prefixed `upstream:` belong to the provider behind a forwarder. */
export function secretsFromMaterial(material: CredentialMaterial): ResolvedSecrets {
  const current: SecretMaterial[] = [];
  const upstream: SecretMaterial[] = [];
  for (const [name, secret] of Object.entries(material)) {
    if (name.startsWith("upstream:")) {
      const keyId = name.slice("upstream:".length);
      if (keyIdSchema.safeParse(keyId).success) upstream.push({ keyId, secret });
    } else if (keyIdSchema.safeParse(name).success) current.push({ keyId: name, secret });
  }
  return {
    current: current.slice(0, EVENT_LIMITS.secrets),
    upstream: upstream.slice(0, EVENT_LIMITS.secrets),
  };
}

/** Resolves routes through the registry and opens the subscription's secret inside custody for the verifier only. */
export function registrySecretResolver(options: {
  registry: SubscriptionRegistry;
  credentials: CredentialCustodyPort;
}): ResolveSecrets {
  return async (route) => {
    const subscription = await options.registry.resolveRoute(
      route.authority,
      route.subscriptionId,
    );
    if (!subscription) return undefined;
    const scope: CredentialScope = {
      tenantId: subscription.tenantId,
      ownerKind: subscription.ownerKind,
      ownerId: subscription.subjectId,
      connectionRef: subscription.connectionRef,
      bindingRef: subscription.bindingRef,
      custody: subscription.custody,
    };
    return {
      subscription,
      useSecrets: (work) =>
        options.credentials.use(scope, subscription.secretRef, (material) =>
          work(secretsFromMaterial(material)),
        ),
    };
  };
}
