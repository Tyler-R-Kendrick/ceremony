import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { test } from "node:test";
import {
  EventInbox,
  createWebhookReceiver,
  eventDeliveryId,
  hmacVendorVerifier,
  verifyForwardedDelivery,
  type ReceiverAudit,
  type VendorVerifierPort,
} from "../../../src/server/connectors/events/index.js";
import { ROTATED, SECRET, scaffold, signStandardWebhook, webhookRequest } from "./helpers.js";

/*
 * EVT-06 / AC-VC-07. A broker-forwarded trigger has two different facts in it:
 * what the forwarder signed, and what the forwarder says about the original
 * provider. The first is verified here; the second is recorded as a claim and
 * never as the provider's signature. A forged or missing forwarder signature
 * is rejected however confidently the headers assert upstream verification.
 */

const NOW_SECONDS = 1789000000;
const NOW = NOW_SECONDS * 1000;
const BODY = JSON.stringify({ type: "invoice.paid", id: "in_42" });
const FORWARDER_SECRET = "vercel-connect-outbound-signing-key";

/** A Vercel-Connect-shaped forwarder: it signs its outbound request and asserts what it verified. */
const forwarderVerifier: VendorVerifierPort = hmacVendorVerifier({
  id: "vercel-connect",
  header: "x-vercel-signature",
  identify: (delivery) => {
    const headers = delivery.headers as Headers;
    const id = headers.get("x-vercel-delivery-id");
    const type = headers.get("x-vercel-event-type");
    return {
      ...(id ? { eventId: id } : {}),
      ...(type ? { providerEventType: type } : {}),
    };
  },
  upstreamClaim: (headers) => {
    const claimed = (headers as Headers).get("x-vercel-provider-verified");
    return claimed ? { authority: claimed } : undefined;
  },
});

const forwardedHeaders = (options: {
  body?: string;
  secret?: string;
  claim?: string;
  signature?: string;
  providerHeaders?: Headers;
}) => {
  const body = options.body ?? BODY;
  const signature =
    options.signature ??
    createHmac("sha256", options.secret ?? FORWARDER_SECRET)
      .update(Buffer.from(body, "utf8"))
      .digest("hex");
  const headers = new Headers(options.providerHeaders ?? undefined);
  headers.set("content-type", "application/json");
  headers.set("x-vercel-signature", signature);
  headers.set("x-vercel-delivery-id", "vercel-delivery-1");
  headers.set("x-vercel-event-type", "invoice.paid");
  if (options.claim) headers.set("x-vercel-provider-verified", options.claim);
  return headers;
};

const delivery = (headers: Headers, body = BODY) => ({
  headers,
  body: new Uint8Array(Buffer.from(body, "utf8")),
  receivedAt: NOW,
});

test("AC-VC-07/EVT-06: the forwarder's own signature is the hop that is verified", async () => {
  const result = await verifyForwardedDelivery({
    delivery: delivery(forwardedHeaders({})),
    forwarder: {
      authority: "vercel-connect",
      verifier: forwarderVerifier,
      secrets: [{ keyId: "vercel-primary", secret: FORWARDER_SECRET }],
    },
  });
  assert.equal(result.ok, true);
  assert.equal(result.ok && result.keyId, "vercel-primary");
  assert.deepEqual(result.ok ? result.hops : [], [
    {
      forwarder: "vercel-connect",
      verified: true,
      method: "forwarder-signature",
      keyId: "vercel-primary",
    },
  ]);
  // The forwarder's headers may also identify the event it carries.
  assert.equal(result.ok && result.identity?.eventId, "vercel-delivery-1");
  assert.equal(result.ok && result.identity?.providerEventType, "invoice.paid");
});

test("AC-VC-07/EVT-06: a forged or missing forwarder signature is rejected however the headers boast", async () => {
  const secrets = [{ keyId: "vercel-primary", secret: FORWARDER_SECRET }];
  const forged = await verifyForwardedDelivery({
    delivery: delivery(
      forwardedHeaders({
        signature: "0".repeat(64),
        claim: "acme-billing",
      }),
    ),
    forwarder: {
      authority: "vercel-connect",
      verifier: forwarderVerifier,
      secrets,
    },
  });
  assert.equal(forged.ok, false);
  assert.equal(forged.ok === false && forged.reason, "signature-mismatch");
  // The failed hop is recorded as unverified, and the upstream boast does not
  // appear at all: a rejected delivery makes no claims on anyone's behalf.
  assert.deepEqual(forged.ok === false ? forged.hops : [], [
    { forwarder: "vercel-connect", verified: false, method: "forwarder-signature" },
  ]);
  const missing = await verifyForwardedDelivery({
    delivery: delivery(
      (() => {
        const headers = forwardedHeaders({ claim: "acme-billing" });
        headers.delete("x-vercel-signature");
        return headers;
      })(),
    ),
    forwarder: {
      authority: "vercel-connect",
      verifier: forwarderVerifier,
      secrets,
    },
  });
  assert.equal(missing.ok, false);
  assert.equal(missing.ok === false && missing.reason, "missing-headers");
  // A body altered after the forwarder signed it fails too.
  const tampered = await verifyForwardedDelivery({
    delivery: delivery(forwardedHeaders({}), JSON.stringify({ type: "invoice.paid", id: "in_99" })),
    forwarder: {
      authority: "vercel-connect",
      verifier: forwarderVerifier,
      secrets,
    },
  });
  assert.equal(tampered.ok, false);
});

test("AC-VC-07/EVT-06: a header claiming upstream verification is recorded as an unverified claim", async () => {
  const result = await verifyForwardedDelivery({
    delivery: delivery(forwardedHeaders({ claim: "acme-billing" })),
    forwarder: {
      authority: "vercel-connect",
      verifier: forwarderVerifier,
      secrets: [{ keyId: "vercel-primary", secret: FORWARDER_SECRET }],
    },
  });
  assert.equal(result.ok, true);
  const hops = result.ok ? result.hops : [];
  assert.equal(hops.length, 2);
  assert.deepEqual(hops[1], {
    forwarder: "acme-billing",
    verified: false,
    method: "upstream-claim",
  });
  // The claim is never promoted to a signature of the original provider.
  assert.equal(
    hops.some(
      (hop) => hop.verified && hop.forwarder === "acme-billing",
    ),
    false,
  );
  assert.equal(hops.filter((hop) => hop.verified).length, 1);
  // A nonsense authority in the claim header does not become a hop identity.
  const hostile = await verifyForwardedDelivery({
    delivery: delivery(
      forwardedHeaders({ claim: "../../etc/passwd or whatever" }),
    ),
    forwarder: {
      authority: "vercel-connect",
      verifier: forwarderVerifier,
      secrets: [{ keyId: "vercel-primary", secret: FORWARDER_SECRET }],
    },
  });
  assert.equal(hostile.ok && hostile.hops[1]?.forwarder, "unknown-upstream");
  assert.equal(hostile.ok && hostile.hops[1]?.verified, false);
});

test("AC-VC-07/EVT-06: the original provider's hop is verified only when this deployment holds its secret", async () => {
  const providerHeaders = signStandardWebhook({
    id: "msg_provider_1",
    timestampSeconds: NOW_SECONDS,
    body: BODY,
  });
  const headers = forwardedHeaders({
    claim: "acme-billing",
    providerHeaders,
  });
  const forwarder = {
    authority: "vercel-connect",
    verifier: forwarderVerifier,
    secrets: [{ keyId: "vercel-primary", secret: FORWARDER_SECRET }],
  };
  // With the provider's secret, both hops verify and are named separately.
  const both = await verifyForwardedDelivery({
    delivery: delivery(headers),
    forwarder,
    upstream: {
      authority: "acme-billing",
      verifier: "standard-webhooks",
      secrets: [{ keyId: "acme-primary", secret: SECRET }],
    },
  });
  assert.equal(both.ok, true);
  const hops = both.ok ? both.hops : [];
  assert.deepEqual(
    hops.map((hop) => [hop.forwarder, hop.verified, hop.method]),
    [
      ["vercel-connect", true, "forwarder-signature"],
      ["acme-billing", false, "upstream-claim"],
      ["acme-billing", true, "standard-webhooks"],
    ],
  );
  // The provider's signed message id becomes the delivery identity.
  assert.equal(both.ok && both.identity?.eventId, "msg_provider_1");
  // With the wrong provider secret the upstream hop stays unverified, while
  // the forwarder hop — and therefore the delivery — remains good.
  const wrongKey = await verifyForwardedDelivery({
    delivery: delivery(headers),
    forwarder,
    upstream: {
      authority: "acme-billing",
      verifier: "standard-webhooks",
      secrets: [{ keyId: "acme-primary", secret: ROTATED }],
    },
  });
  assert.equal(wrongKey.ok, true);
  assert.deepEqual(
    (wrongKey.ok ? wrongKey.hops : []).map((hop) => [hop.forwarder, hop.verified]),
    [
      ["vercel-connect", true],
      ["acme-billing", false],
      ["acme-billing", false],
    ],
  );
  // Without the provider's secret at all, there is simply no provider hop.
  const forwarderOnly = await verifyForwardedDelivery({
    delivery: delivery(headers),
    forwarder,
    upstream: { authority: "acme-billing", verifier: "standard-webhooks" },
  });
  assert.equal(forwarderOnly.ok, true);
  assert.equal(forwarderOnly.ok && forwarderOnly.hops.length, 2);
  assert.equal(
    (forwarderOnly.ok ? forwarderOnly.hops : []).filter(
      (hop) => hop.method === "standard-webhooks",
    ).length,
    0,
  );
});

test("AC-VC-07/EVT-06: a forwarded subscription admits through the receiver and records its hops", async () => {
  const context = await scaffold({
    authority: "vercel-connect",
    eventTypes: ["invoice.paid"],
    material: {
      primary: FORWARDER_SECRET,
      "upstream:acme": SECRET,
    },
    verification: {
      method: "forwarder-signature",
      forwarder: "vercel-connect",
      forwarderVerifier: "vercel-connect",
      upstream: { authority: "acme-billing", verifier: "standard-webhooks" },
    },
  });
  try {
    const inbox = new EventInbox(context.store, {
      subscriptions: context.registry,
    });
    const audits: ReceiverAudit[] = [];
    const receive = createWebhookReceiver({
      resolveSecrets: context.resolveSecrets,
      inbox,
      verifiers: [forwarderVerifier],
      policy: { now: () => NOW, audit: (event) => audits.push(event) },
    });
    const providerHeaders = signStandardWebhook({
      id: "msg_forwarded_1",
      timestampSeconds: NOW_SECONDS,
      body: BODY,
    });
    const accepted = await receive(
      webhookRequest({
        subscription: context.subscription,
        body: BODY,
        headers: forwardedHeaders({ claim: "acme-billing", providerHeaders }),
      }),
    );
    assert.equal(accepted.status, 200);
    const record = await inbox.get(
      "tenant-a",
      eventDeliveryId("vercel-connect", "msg_forwarded_1"),
    );
    assert.equal(record?.envelope.verification.method, "forwarder-signature");
    assert.equal(record?.envelope.verification.keyId, "primary");
    assert.deepEqual(
      record?.envelope.forwarderHops.map((hop) => [hop.forwarder, hop.verified]),
      [
        ["vercel-connect", true],
        ["acme-billing", false],
        ["acme-billing", true],
      ],
    );
    // The delivery id is scoped by the receiving authority (the forwarder), so
    // the same provider event forwarded through another route is a distinct
    // delivery rather than a silent collision.
    assert.notEqual(
      eventDeliveryId("vercel-connect", "msg_forwarded_1"),
      eventDeliveryId("acme-billing", "msg_forwarded_1"),
    );
    // A forged forwarder signature on the very same provider-signed bytes is
    // refused: an upstream signature is not authority to use this route.
    const forged = await receive(
      webhookRequest({
        subscription: context.subscription,
        body: BODY,
        headers: forwardedHeaders({
          signature: "0".repeat(64),
          claim: "acme-billing",
          providerHeaders: signStandardWebhook({
            id: "msg_forwarded_2",
            timestampSeconds: NOW_SECONDS,
            body: BODY,
          }),
        }),
      }),
    );
    assert.equal(forged.status, 401);
    assert.equal(
      await inbox.get("tenant-a", eventDeliveryId("vercel-connect", "msg_forwarded_2")),
      undefined,
    );
    assert.equal(audits.at(-1)?.code, "unverified");
  } finally {
    await context.store.close();
  }
});

test("EVT-06: a verifier that throws is a failure to verify, never an acceptance", async () => {
  const broken: VendorVerifierPort = {
    id: "broken-forwarder",
    verify() {
      throw new Error("verifier exploded");
    },
  };
  const result = await verifyForwardedDelivery({
    delivery: delivery(forwardedHeaders({})),
    forwarder: {
      authority: "vercel-connect",
      verifier: broken,
      secrets: [{ keyId: "k", secret: FORWARDER_SECRET }],
    },
  });
  assert.equal(result.ok, false);
  assert.equal(result.ok === false && result.reason, "verifier-unavailable");
});
