import { authoritySchema, type ForwarderHop } from "./envelope.js";
import { standardWebhooksVerifier } from "./standard-webhooks.js";
import type {
  DeliveryIdentity,
  RawDelivery,
  SecretMaterial,
  VendorVerifierPort,
  VerificationFailure,
} from "./verification.js";

/*
 * A broker-forwarded delivery (a Vercel Connect trigger, a relay) has two
 * signatures that matter and one that does not. The forwarder's own outbound
 * signature is what proves the bytes came through the forwarder; it is the
 * hop Ceremony verifies. The original provider's signature may still be
 * present and is verified only when this deployment holds that provider's
 * secret. A header in which the forwarder asserts "the provider was verified
 * upstream" is neither: it is recorded as a claim with verified=false, and a
 * request whose forwarder signature fails is rejected no matter what that
 * header says.
 */

export type ForwardedVerification =
  | {
      ok: true;
      /** The forwarder's key that verified the delivery. */
      keyId: string;
      hops: ForwarderHop[];
      identity?: DeliveryIdentity;
    }
  | { ok: false; reason: VerificationFailure; hops: ForwarderHop[] };

export type ForwardedDeliveryInput = {
  delivery: RawDelivery;
  forwarder: {
    /** Authority name of the forwarder, e.g. the host's name for its Vercel Connect connector. */
    authority: string;
    verifier: VendorVerifierPort;
    secrets: readonly SecretMaterial[];
  };
  upstream?: {
    authority: string;
    /** How the original provider signs; "standard-webhooks" or a vendor verifier. */
    verifier?: VendorVerifierPort | "standard-webhooks";
    /** The provider's secrets when this deployment holds them; without them the hop stays unverified. */
    secrets?: readonly SecretMaterial[];
  };
};

export async function verifyForwardedDelivery(
  input: ForwardedDeliveryInput,
): Promise<ForwardedVerification> {
  const forwarder = authoritySchema.parse(input.forwarder.authority);
  let forwarded;
  try {
    forwarded = await input.forwarder.verifier.verify(
      input.delivery,
      input.forwarder.secrets,
    );
  } catch {
    forwarded = { ok: false as const, reason: "verifier-unavailable" as const };
  }
  if (!forwarded.ok)
    return {
      ok: false,
      reason: forwarded.reason,
      hops: [{ forwarder, verified: false, method: "forwarder-signature" }],
    };
  const hops: ForwarderHop[] = [
    {
      forwarder,
      verified: true,
      method: "forwarder-signature",
      keyId: forwarded.keyId,
    },
  ];
  const claim = input.forwarder.verifier.upstreamClaim?.(
    input.delivery.headers,
  );
  if (claim) {
    const claimed = authoritySchema.safeParse(claim.authority);
    hops.push({
      forwarder: claimed.success ? claimed.data : "unknown-upstream",
      verified: false,
      method: "upstream-claim",
    });
  }
  let identity = forwarded.identity;
  if (input.upstream) {
    const upstream = authoritySchema.parse(input.upstream.authority);
    const verifier =
      input.upstream.verifier === "standard-webhooks"
        ? standardWebhooksVerifier
        : input.upstream.verifier;
    if (verifier && input.upstream.secrets?.length) {
      let result;
      try {
        result = await verifier.verify(input.delivery, input.upstream.secrets);
      } catch {
        result = {
          ok: false as const,
          reason: "verifier-unavailable" as const,
        };
      }
      const method =
        verifier.id === "standard-webhooks"
          ? ("standard-webhooks" as const)
          : ("vendor-signature" as const);
      hops.push(
        result.ok
          ? { forwarder: upstream, verified: true, method, keyId: result.keyId }
          : { forwarder: upstream, verified: false, method },
      );
      if (result.ok && result.identity)
        identity = { ...(identity ?? {}), ...result.identity };
    }
  }
  return {
    ok: true,
    keyId: forwarded.keyId,
    hops,
    ...(identity ? { identity } : {}),
  };
}
