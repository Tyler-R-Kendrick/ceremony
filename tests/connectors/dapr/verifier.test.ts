import { test } from "node:test";
import assert from "node:assert/strict";
import { daprInputDelivery } from "../doubles/dapr-sidecar.js";
import {
  DAPR_VERIFIER_ID,
  createDaprVendorVerifier,
} from "../../../src/server/connectors/providers/dapr/index.js";

/*
 * The Dapr app API token as the shared receiver sees it. The delivery comes
 * from the sidecar double, so the header name and shape are decided by the
 * documentation rather than by the verifier under test.
 */

const delivery = (token?: string) => {
  const built = daprInputDelivery({
    bindingName: "orders-topic",
    payload: { orderId: "o-1" },
    ...(token === undefined ? {} : { appApiToken: token }),
    receivedAt: 1_760_000_000_000,
  });
  return {
    headers: built.headers,
    body: built.body,
    receivedAt: built.receivedAt,
  };
};

test("the verifier accepts a delivery presenting a configured app API token", async () => {
  const verifier = createDaprVendorVerifier();
  assert.equal(verifier.id, DAPR_VERIFIER_ID);
  const result = await verifier.verify(delivery("token-a"), [
    { keyId: "current", secret: "token-a" },
  ]);
  assert.deepEqual(result, { ok: true, keyId: "current" });
});

test("rotation works: either live token is accepted and the key id says which", async () => {
  const verifier = createDaprVendorVerifier();
  const secrets = [
    { keyId: "next", secret: "token-b" },
    { keyId: "current", secret: "token-a" },
  ];
  assert.deepEqual(await verifier.verify(delivery("token-a"), secrets), {
    ok: true,
    keyId: "current",
  });
  assert.deepEqual(await verifier.verify(delivery("token-b"), secrets), {
    ok: true,
    keyId: "next",
  });
});

test("a wrong, absent or unconfigured token yields a sanitized refusal", async () => {
  const verifier = createDaprVendorVerifier();
  assert.deepEqual(
    await verifier.verify(delivery("token-wrong"), [
      { keyId: "current", secret: "token-a" },
    ]),
    { ok: false, reason: "signature-mismatch" },
  );
  assert.deepEqual(
    await verifier.verify(delivery(), [
      { keyId: "current", secret: "token-a" },
    ]),
    { ok: false, reason: "missing-headers" },
  );
  // No configured secret means nothing can be authenticated, not that
  // everything is.
  assert.deepEqual(await verifier.verify(delivery("token-a"), []), {
    ok: false,
    reason: "verifier-unavailable",
  });
});

test("the verifier claims no upstream on this delivery's behalf", () => {
  const verifier = createDaprVendorVerifier();
  // A sidecar speaks for itself; it never asserts that an external system was
  // already verified, so no upstream-claim reader exists.
  assert.equal(verifier.upstreamClaim, undefined);
});
