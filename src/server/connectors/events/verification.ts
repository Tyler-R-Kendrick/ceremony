/*
 * Vocabulary shared by every event verifier. A verifier looks at raw bytes and
 * headers, never at a parsed body, and answers with a keyId when it succeeds
 * or with a sanitized reason when it does not. Reasons are for audit hooks and
 * tests; an HTTP receiver collapses them to one status so a sender learns
 * nothing about which check failed.
 */

export type SecretMaterial = {
  /** Host-chosen key identifier; reported on success so rotation can be observed. */
  keyId: string;
  /** The signing secret as the provider issued it (string) or as raw bytes. */
  secret: string | Uint8Array;
};

export const verificationFailures = [
  "missing-headers",
  "malformed-headers",
  "timestamp-out-of-tolerance",
  "unsupported-scheme",
  "signature-mismatch",
  "verifier-unavailable",
] as const;
export type VerificationFailure = (typeof verificationFailures)[number];

export type HeadersLike =
  Headers | Readonly<Record<string, string | readonly string[] | undefined>>;

/** Case-insensitive header lookup over fetch Headers or a plain record; repeated values are joined like Headers does. */
export function headerValue(
  headers: HeadersLike,
  name: string,
): string | undefined {
  if (headers instanceof Headers) return headers.get(name) ?? undefined;
  const wanted = name.toLowerCase();
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() !== wanted || value === undefined) continue;
    return Array.isArray(value) ? value.join(", ") : String(value);
  }
  return undefined;
}

export type RawDelivery = {
  headers: HeadersLike;
  body: Uint8Array;
  /** Epoch milliseconds at which the receiver took custody of the bytes. */
  receivedAt: number;
};

/** What a verifier may learn about the event from the material it verified; hints only, the receiver still bounds them. */
export type DeliveryIdentity = {
  eventId?: string;
  providerEventType?: string;
  /** Epoch milliseconds the sender stamped on the delivery. */
  sourceTime?: number;
};

export type VendorVerification =
  | { ok: true; keyId: string; identity?: DeliveryIdentity }
  | { ok: false; reason: VerificationFailure };

/**
 * A vendor-specific signature scheme (Vercel Connect's outbound signature,
 * Nango's HMAC header, Pipedream's ...). Provider modules implement one and
 * register it with the receiver under its id; the receiver never guesses a
 * header name.
 */
export interface VendorVerifierPort {
  readonly id: string;
  verify(
    delivery: RawDelivery,
    secrets: readonly SecretMaterial[],
  ): Promise<VendorVerification> | VendorVerification;
  /**
   * For a forwarder: whether this request asserts that an upstream provider
   * was already verified. Such an assertion is recorded as a claim, never as
   * that provider's signature.
   */
  upstreamClaim?(headers: HeadersLike): { authority: string } | undefined;
}

export const vendorIdPattern = /^[a-z][a-z0-9-]{0,63}$/;
