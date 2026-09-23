import { timingSafeEqual } from "node:crypto";
import {
  headerValue,
  type RawDelivery,
  type SecretMaterial,
  type VendorVerification,
  type VendorVerifierPort,
} from "../../events/index.js";
import { DAPR_APP_API_TOKEN_HEADER } from "./schemas.js";

/*
 * Dapr's app API token as a vendor verifier, so an input binding can be
 * received through the shared webhook receiver instead of a parallel route.
 *
 * The scheme is a shared bearer token, not a signature: Dapr adds
 * `dapr-api-token: <APP_API_TOKEN>` to every call it makes to the app, and
 * that is the whole of the sidecar-to-application authentication the runtime
 * documents. Two consequences are stated rather than papered over. There is
 * no timestamp, so a delivery cannot be replay-bounded by this verifier and
 * the receiver's own dedupe is what prevents reprocessing. And a token is
 * symmetric, so anyone who can read it can impersonate the sidecar; it is
 * never written into a log, an error or a result.
 */

export const DAPR_VERIFIER_ID = "dapr-app-api-token";

function tokenMatches(expected: string, provided: string): boolean {
  const a = Buffer.from(expected, "utf8");
  const b = Buffer.from(provided, "utf8");
  if (a.length !== b.length) {
    timingSafeEqual(a, a);
    return false;
  }
  return timingSafeEqual(a, b);
}

/**
 * Accepts a delivery when it presents one of the host's configured app API
 * tokens. Several secrets are supported so a token can be rotated without a
 * window in which deliveries are refused; the matching key id is reported so
 * the rotation is observable.
 */
export function createDaprVendorVerifier(): VendorVerifierPort {
  return {
    id: DAPR_VERIFIER_ID,
    verify(
      delivery: RawDelivery,
      secrets: readonly SecretMaterial[],
    ): VendorVerification {
      const provided = headerValue(delivery.headers, DAPR_APP_API_TOKEN_HEADER);
      if (!provided) return { ok: false, reason: "missing-headers" };
      if (secrets.length === 0)
        return { ok: false, reason: "verifier-unavailable" };
      for (const secret of secrets) {
        const expected =
          typeof secret.secret === "string"
            ? secret.secret
            : Buffer.from(secret.secret).toString("utf8");
        if (tokenMatches(expected, provided))
          return { ok: true, keyId: secret.keyId };
      }
      return { ok: false, reason: "signature-mismatch" };
    },
  };
}
