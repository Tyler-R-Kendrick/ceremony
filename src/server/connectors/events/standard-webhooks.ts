import { createHmac, timingSafeEqual } from "node:crypto";
import { EVENT_LIMITS, keyIdSchema } from "./envelope.js";
import {
  headerValue,
  vendorIdPattern,
  type DeliveryIdentity,
  type HeadersLike,
  type RawDelivery,
  type SecretMaterial,
  type VendorVerification,
  type VendorVerifierPort,
  type VerificationFailure,
} from "./verification.js";

/*
 * Standard Webhooks 1.0.0 (https://www.standardwebhooks.com/): the sender puts
 * `webhook-id`, `webhook-timestamp` (unix seconds) and `webhook-signature` on
 * the request; each signature is `v1,` followed by base64 HMAC-SHA256 over
 * `${id}.${timestamp}.${body}` with a secret serialized as `whsec_` + base64.
 * Several space-separated signatures allow zero-downtime rotation. Everything
 * here works on the original bytes: a body is never decoded to text and
 * re-encoded before it is signed, because that is not the same body.
 */

export const STANDARD_WEBHOOKS_VERSION = "1.0.0";
export const standardWebhookHeaders = Object.freeze({
  id: "webhook-id",
  timestamp: "webhook-timestamp",
  signature: "webhook-signature",
});

export type StandardWebhookVerification =
  | {
      ok: true;
      keyId: string;
      messageId: string;
      /** Sender timestamp in unix seconds, as signed. */
      timestamp: number;
      /** The same instant in epoch milliseconds. */
      sourceTime: number;
    }
  | { ok: false; reason: VerificationFailure };

const SECRET_PREFIX = "whsec_";
const base64 = /^[A-Za-z0-9+/]+={0,2}$/;
const MIN_KEY_BYTES = 16;

/** Decodes a Standard Webhooks secret; misconfiguration throws because it is the host's, not the sender's, mistake. */
export function standardWebhookKey(secret: string | Uint8Array): Uint8Array {
  if (secret instanceof Uint8Array) {
    if (secret.byteLength < MIN_KEY_BYTES)
      throw new Error("Standard Webhooks secret is too short");
    return secret;
  }
  const encoded = secret.startsWith(SECRET_PREFIX)
    ? secret.slice(SECRET_PREFIX.length)
    : secret;
  if (!base64.test(encoded) || encoded.length % 4 !== 0)
    throw new Error("Standard Webhooks secret is not base64");
  const key = Buffer.from(encoded, "base64");
  if (key.byteLength < MIN_KEY_BYTES)
    throw new Error("Standard Webhooks secret is too short");
  return new Uint8Array(key);
}

function checkSecrets(secrets: readonly SecretMaterial[]): void {
  if (!secrets.length || secrets.length > EVENT_LIMITS.secrets)
    throw new Error("Between one and eight signing secrets are required");
  const ids = new Set<string>();
  for (const item of secrets) {
    if (!keyIdSchema.safeParse(item.keyId).success || ids.has(item.keyId))
      throw new Error("Signing secrets need distinct bounded key ids");
    ids.add(item.keyId);
  }
}

function checkTolerance(seconds: number): number {
  if (!Number.isSafeInteger(seconds) || seconds < 1 || seconds > 86_400)
    throw new Error("Timestamp tolerance must be 1..86400 seconds");
  return seconds;
}

/** Constant-time comparison that treats a length mismatch as a mismatch instead of an exception. */
export function signaturesEqual(a: Uint8Array, b: Uint8Array): boolean {
  return a.byteLength === b.byteLength && timingSafeEqual(a, b);
}

/** Bytes that are signed: `${id}.${timestamp}.` concatenated with the body bytes as received. */
export function standardWebhookSignedContent(
  messageId: string,
  timestamp: string,
  body: Uint8Array,
): Uint8Array {
  return new Uint8Array(
    Buffer.concat([
      Buffer.from(`${messageId}.${timestamp}.`, "utf8"),
      Buffer.from(body.buffer, body.byteOffset, body.byteLength),
    ]),
  );
}

export function verifyStandardWebhook(input: {
  headers: HeadersLike;
  body: Uint8Array;
  secrets: readonly SecretMaterial[];
  toleranceSeconds?: number;
  /** Epoch milliseconds; injected by receivers and tests. */
  now?: number;
}): StandardWebhookVerification {
  checkSecrets(input.secrets);
  const tolerance = checkTolerance(
    input.toleranceSeconds ?? EVENT_LIMITS.toleranceSeconds,
  );
  const keys = input.secrets.map((item) => ({
    keyId: item.keyId,
    key: standardWebhookKey(item.secret),
  }));
  const now = input.now ?? Date.now();
  const messageId = headerValue(input.headers, standardWebhookHeaders.id);
  const timestamp = headerValue(
    input.headers,
    standardWebhookHeaders.timestamp,
  );
  const signatures = headerValue(
    input.headers,
    standardWebhookHeaders.signature,
  );
  if (!messageId || !timestamp || !signatures)
    return { ok: false, reason: "missing-headers" };
  // A merged duplicate header ("a, b") is a malformed id, not a second chance.
  if (
    messageId.length > 256 ||
    /[\s,\p{Cc}]/u.test(messageId) ||
    !/^\d{1,12}$/.test(timestamp)
  )
    return { ok: false, reason: "malformed-headers" };
  const seconds = Number(timestamp);
  if (Math.abs(Math.floor(now / 1000) - seconds) > tolerance)
    return { ok: false, reason: "timestamp-out-of-tolerance" };
  const entries = signatures.trim().split(/\s+/);
  if (entries.length > EVENT_LIMITS.signatures)
    return { ok: false, reason: "malformed-headers" };
  const candidates: Uint8Array[] = [];
  let otherSchemes = 0;
  for (const entry of entries) {
    const separator = entry.indexOf(",");
    if (separator < 1) return { ok: false, reason: "malformed-headers" };
    const version = entry.slice(0, separator);
    const encoded = entry.slice(separator + 1);
    if (version !== "v1") {
      otherSchemes++;
      continue;
    }
    if (!base64.test(encoded) || encoded.length % 4 !== 0)
      return { ok: false, reason: "malformed-headers" };
    candidates.push(new Uint8Array(Buffer.from(encoded, "base64")));
  }
  if (!candidates.length)
    return {
      ok: false,
      reason: otherSchemes ? "unsupported-scheme" : "malformed-headers",
    };
  const signed = standardWebhookSignedContent(messageId, timestamp, input.body);
  for (const { keyId, key } of keys) {
    const expected = new Uint8Array(
      createHmac("sha256", key).update(signed).digest(),
    );
    for (const candidate of candidates)
      if (signaturesEqual(expected, candidate))
        return {
          ok: true,
          keyId,
          messageId,
          timestamp: seconds,
          sourceTime: seconds * 1000,
        };
  }
  return { ok: false, reason: "signature-mismatch" };
}

/*
 * The common vendor pattern: one header carrying HMAC(secret, body) or
 * HMAC(secret, `${timestamp}.${body}`), hex or base64, sometimes prefixed
 * ("sha256="), sometimes several candidates. Everything that varies is an
 * option the provider module sets from its documentation; nothing is guessed.
 */
export type HmacHeaderOptions = {
  headers: HeadersLike;
  body: Uint8Array;
  secrets: readonly SecretMaterial[];
  /** Header carrying the signature(s). */
  header: string;
  algorithm?: "sha1" | "sha256" | "sha512";
  encoding?: "hex" | "base64" | "base64url";
  /** Literal prefix each candidate carries, e.g. "sha256=". */
  prefix?: string;
  /** How string secrets become key bytes; providers hand out UTF-8 strings unless documented otherwise. */
  secretEncoding?: "utf8" | "base64" | "hex";
  /** Bytes that are signed; defaults to the body alone. */
  signedContent?: (input: {
    body: Uint8Array;
    headers: HeadersLike;
    timestamp?: string;
  }) => Uint8Array;
  /** A timestamp header that must be within tolerance and usually enters the signed content. */
  timestamp?: {
    header: string;
    toleranceSeconds?: number;
    unit?: "seconds" | "milliseconds";
  };
  /** Extracts candidate signatures from the header value; default splits on commas and whitespace. */
  candidates?: (value: string) => string[];
  now?: number;
};

export type HmacHeaderVerification =
  | { ok: true; keyId: string; sourceTime?: number }
  | { ok: false; reason: VerificationFailure };

function keyBytes(
  secret: string | Uint8Array,
  encoding: NonNullable<HmacHeaderOptions["secretEncoding"]>,
): Uint8Array {
  if (secret instanceof Uint8Array) return secret;
  if (encoding === "utf8") return new Uint8Array(Buffer.from(secret, "utf8"));
  if (encoding === "hex") {
    if (!/^[0-9a-f]+$/i.test(secret) || secret.length % 2)
      throw new Error("Signing secret is not hex");
    return new Uint8Array(Buffer.from(secret, "hex"));
  }
  if (!base64.test(secret) || secret.length % 4)
    throw new Error("Signing secret is not base64");
  return new Uint8Array(Buffer.from(secret, "base64"));
}

function decodeCandidate(
  value: string,
  encoding: NonNullable<HmacHeaderOptions["encoding"]>,
): Uint8Array | undefined {
  if (encoding === "hex")
    return /^[0-9a-f]+$/i.test(value) && value.length % 2 === 0
      ? new Uint8Array(Buffer.from(value, "hex"))
      : undefined;
  if (encoding === "base64")
    return base64.test(value) && value.length % 4 === 0
      ? new Uint8Array(Buffer.from(value, "base64"))
      : undefined;
  return /^[A-Za-z0-9_-]+$/.test(value)
    ? new Uint8Array(Buffer.from(value, "base64url"))
    : undefined;
}

export function verifyHmacHeader(
  options: HmacHeaderOptions,
): HmacHeaderVerification {
  checkSecrets(options.secrets);
  const algorithm = options.algorithm ?? "sha256";
  const encoding = options.encoding ?? "hex";
  const keys = options.secrets.map((item) => ({
    keyId: item.keyId,
    key: keyBytes(item.secret, options.secretEncoding ?? "utf8"),
  }));
  const value = headerValue(options.headers, options.header);
  if (!value) return { ok: false, reason: "missing-headers" };
  let timestamp: string | undefined;
  let sourceTime: number | undefined;
  if (options.timestamp) {
    timestamp = headerValue(options.headers, options.timestamp.header);
    if (!timestamp) return { ok: false, reason: "missing-headers" };
    if (!/^\d{1,16}$/.test(timestamp))
      return { ok: false, reason: "malformed-headers" };
    const tolerance = checkTolerance(
      options.timestamp.toleranceSeconds ?? EVENT_LIMITS.toleranceSeconds,
    );
    const unit = options.timestamp.unit ?? "seconds";
    sourceTime =
      unit === "seconds" ? Number(timestamp) * 1000 : Number(timestamp);
    const now = options.now ?? Date.now();
    if (Math.abs(now - sourceTime) > tolerance * 1000)
      return { ok: false, reason: "timestamp-out-of-tolerance" };
  }
  const raw = (options.candidates ?? ((text) => text.trim().split(/[\s,]+/)))(
    value,
  ).filter(Boolean);
  if (!raw.length || raw.length > EVENT_LIMITS.signatures)
    return { ok: false, reason: "malformed-headers" };
  const candidates: Uint8Array[] = [];
  for (const item of raw) {
    const stripped =
      options.prefix && item.startsWith(options.prefix)
        ? item.slice(options.prefix.length)
        : options.prefix
          ? undefined
          : item;
    if (stripped === undefined) continue;
    const decoded = decodeCandidate(stripped, encoding);
    if (decoded) candidates.push(decoded);
  }
  if (!candidates.length) return { ok: false, reason: "malformed-headers" };
  const signed = options.signedContent
    ? options.signedContent({
        body: options.body,
        headers: options.headers,
        ...(timestamp === undefined ? {} : { timestamp }),
      })
    : options.body;
  for (const { keyId, key } of keys) {
    const expected = new Uint8Array(
      createHmac(algorithm, key).update(signed).digest(),
    );
    for (const candidate of candidates)
      if (signaturesEqual(expected, candidate))
        return {
          ok: true,
          keyId,
          ...(sourceTime === undefined ? {} : { sourceTime }),
        };
  }
  return { ok: false, reason: "signature-mismatch" };
}

/** A VendorVerifierPort over verifyHmacHeader; provider modules configure it from documented facts. */
export function hmacVendorVerifier(
  options: Omit<HmacHeaderOptions, "headers" | "body" | "secrets" | "now"> & {
    id: string;
    identify?: (delivery: RawDelivery) => DeliveryIdentity | undefined;
    upstreamClaim?: (headers: HeadersLike) => { authority: string } | undefined;
  },
): VendorVerifierPort {
  if (!vendorIdPattern.test(options.id))
    throw new Error("Invalid vendor verifier id");
  const { id, identify, upstreamClaim, ...rest } = options;
  const verifier: VendorVerifierPort = {
    id,
    verify(delivery, secrets): VendorVerification {
      const result = verifyHmacHeader({
        ...rest,
        headers: delivery.headers,
        body: delivery.body,
        secrets,
        now: delivery.receivedAt,
      });
      if (!result.ok) return result;
      const hinted = identify?.(delivery);
      const identity: DeliveryIdentity = {
        ...(hinted ?? {}),
        ...(result.sourceTime === undefined || hinted?.sourceTime !== undefined
          ? {}
          : { sourceTime: result.sourceTime }),
      };
      return {
        ok: true,
        keyId: result.keyId,
        ...(Object.keys(identity).length ? { identity } : {}),
      };
    },
  };
  if (upstreamClaim) verifier.upstreamClaim = upstreamClaim;
  return verifier;
}

/** The Standard Webhooks profile as a VendorVerifierPort, so a subscription can name it like any other scheme. */
export const standardWebhooksVerifier: VendorVerifierPort = {
  id: "standard-webhooks",
  verify(delivery, secrets): VendorVerification {
    const result = verifyStandardWebhook({
      headers: delivery.headers,
      body: delivery.body,
      secrets,
      now: delivery.receivedAt,
    });
    if (!result.ok) return result;
    return {
      ok: true,
      keyId: result.keyId,
      identity: { eventId: result.messageId, sourceTime: result.sourceTime },
    };
  },
};
