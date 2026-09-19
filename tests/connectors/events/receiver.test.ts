import assert from "node:assert/strict";
import { test } from "node:test";
import {
  EventInbox,
  createEventDispatcher,
  createWebhookReceiver,
  eventDeliveryId,
  hmacVendorVerifier,
  secretsFromMaterial,
  type EventDelivery,
  type ReceiverAudit,
} from "../../../src/server/connectors/events/index.js";
import { ConnectorError } from "../../../src/server/connectors/errors.js";
import type { CompletionInput } from "../../../src/server/connectors/adapter.js";
import {
  ROTATED,
  SECRET,
  receiverBinding,
  scaffold,
  signStandardWebhook,
  webhookRequest,
  type Scaffold,
} from "./helpers.js";

/*
 * EVT-05. Subscriptions are approvals of a destination, and the receiver is
 * the only door an event comes through: bounded before it is read, verified
 * before it is parsed, refused with a sanitized status that never echoes the
 * request, and only then admitted. A lifecycle event that was not
 * authenticated changes nothing about a connection.
 */

const NOW_SECONDS = 1789000000;
const NOW = NOW_SECONDS * 1000;
const BODY = JSON.stringify({ type: "invoice.paid", id: "in_9", amount: 1200 });
const CANARY = "CANARY_WEBHOOK_BODY_SECRET_4f2";

type Harness = {
  context: Scaffold;
  receive: (request: Request) => Promise<Response>;
  audits: ReceiverAudit[];
  applied: EventDelivery[];
  inbox: EventInbox;
  drain: () => Promise<void>;
};

async function harness(
  options: Parameters<typeof scaffold>[0] & {
    identify?: Parameters<typeof createWebhookReceiver>[0]["policy"] extends
      infer P | undefined
      ? P extends { identify?: infer I }
        ? I
        : never
      : never;
  } = {},
): Promise<Harness> {
  const context = await scaffold(options);
  const audits: ReceiverAudit[] = [];
  const applied: EventDelivery[] = [];
  const inbox = new EventInbox(context.store, {
    subscriptions: context.registry,
  });
  const dispatcher = createEventDispatcher({
    complete: async (delivery, input: CompletionInput) => {
      assert.equal(input.kind, "event");
      applied.push(delivery);
      return "applied" as const;
    },
  });
  const receive = createWebhookReceiver({
    resolveSecrets: context.resolveSecrets,
    inbox,
    verifiers: [
      hmacVendorVerifier({ id: "acme-vendor", header: "x-acme-signature" }),
    ],
    policy: {
      now: () => NOW,
      audit: (event) => audits.push(event),
      lifecycle: ({ providerEventType }) =>
        providerEventType === "connection.revoked"
          ? { kind: "revoked" }
          : undefined,
      ...(options.identify ? { identify: options.identify } : {}),
    },
  });
  return {
    context,
    receive,
    audits,
    applied,
    inbox,
    drain: async () => {
      await inbox.drain({
        tenantId: context.subscription.tenantId,
        handlers: { "connector-event": dispatcher },
      });
    },
  };
}

const signed = (body = BODY, id = "msg_recv_1", seconds = NOW_SECONDS) =>
  signStandardWebhook({ id, timestampSeconds: seconds, body });

test("EVT-05: an authenticated delivery is admitted and dispatched to the owning adapter", async () => {
  const h = await harness();
  try {
    const response = await h.receive(
      webhookRequest({
        subscription: h.context.subscription,
        body: BODY,
        headers: signed(),
      }),
    );
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { status: "accepted" });
    assert.equal(response.headers.get("cache-control"), "no-store");
    const record = await h.inbox.get(
      "tenant-a",
      eventDeliveryId("acme-billing", "msg_recv_1"),
    );
    assert.equal(record?.envelope.providerEventType, "invoice.paid");
    assert.equal(record?.envelope.verification.method, "standard-webhooks");
    assert.equal(record?.envelope.verification.keyId, "primary");
    assert.equal(record?.envelope.connectionRef, "connection:1");
    assert.equal(record?.envelope.payloadClassification, "personal");
    // The owner comes from the approved subscription, never from the request.
    assert.equal(record?.subjectId, h.context.actor.subjectId);
    assert.equal(record?.generation, 1);
    await h.drain();
    assert.equal(h.applied.length, 1);
    assert.equal(h.applied[0]?.envelope.eventId, "msg_recv_1");
  } finally {
    await h.context.store.close();
  }
});

test("EVT-05: the negative matrix is refused with sanitized responses that never echo the request", async () => {
  const h = await harness();
  const body = JSON.stringify({ type: "invoice.paid", secret: CANARY });
  try {
    const attempts: Array<[string, Request, number]> = [
      [
        "forged signature",
        webhookRequest({
          subscription: h.context.subscription,
          body,
          headers: (() => {
            const headers = signed(body, "msg_forged");
            headers.set("webhook-signature", `v1,${"A".repeat(43)}=`);
            return headers;
          })(),
        }),
        401,
      ],
      [
        "signature over a different body (payload swapped after signing)",
        webhookRequest({
          subscription: h.context.subscription,
          body: JSON.stringify({ type: "invoice.paid", amount: 999999 }),
          headers: signed(body, "msg_swap"),
        }),
        401,
      ],
      [
        "wrong signing key",
        webhookRequest({
          subscription: h.context.subscription,
          body,
          headers: signStandardWebhook({
            id: "msg_wrongkey",
            timestampSeconds: NOW_SECONDS,
            body,
            secret: ROTATED,
          }),
        }),
        401,
      ],
      [
        "stale timestamp",
        webhookRequest({
          subscription: h.context.subscription,
          body,
          headers: signed(body, "msg_stale", NOW_SECONDS - 4000),
        }),
        401,
      ],
      [
        "missing signature headers",
        webhookRequest({
          subscription: h.context.subscription,
          body,
          headers: new Headers({ "content-type": "application/json" }),
        }),
        401,
      ],
      [
        "unknown subscription",
        webhookRequest({
          subscription: {
            authority: "acme-billing",
            subscriptionId: "sub:does-not-exist",
          },
          body,
          headers: signed(body, "msg_unknown"),
        }),
        404,
      ],
      [
        "authority that does not own the subscription",
        webhookRequest({
          subscription: {
            authority: "other-provider",
            subscriptionId: h.context.subscription.subscriptionId,
          },
          body,
          headers: signed(body, "msg_authority"),
        }),
        404,
      ],
      [
        "route outside the mount path",
        new Request(
          "https://app.example/api/v1/connectors/events/acme-billing",
          {
            method: "POST",
            headers: signed(body, "msg_route"),
            body,
          },
        ),
        404,
      ],
      [
        "wrong method",
        webhookRequest({
          subscription: h.context.subscription,
          body,
          headers: signed(body, "msg_method"),
          method: "GET",
        }),
        405,
      ],
      [
        "unexpected content type",
        webhookRequest({
          subscription: h.context.subscription,
          body,
          headers: (() => {
            const headers = signed(body, "msg_ctype");
            headers.set("content-type", "text/plain");
            return headers;
          })(),
        }),
        415,
      ],
      [
        "declared amplification via content-length",
        webhookRequest({
          subscription: h.context.subscription,
          body,
          headers: (() => {
            const headers = signed(body, "msg_len");
            headers.set("content-length", "999999999");
            return headers;
          })(),
        }),
        413,
      ],
      [
        "malformed body under a valid signature",
        (() => {
          const broken = "{not json";
          return webhookRequest({
            subscription: h.context.subscription,
            body: broken,
            headers: signed(broken, "msg_malformed"),
          });
        })(),
        400,
      ],
    ];
    for (const [label, request, status] of attempts) {
      const response = await h.receive(request);
      assert.equal(response.status, status, label);
      const text = await response.text();
      // A refusal never reflects the body, a header or an upstream message.
      assert.equal(text.includes(CANARY), false, label);
      assert.equal(text.includes("webhook-signature"), false, label);
      assert.equal(text.includes("in_9"), false, label);
      assert.ok(text.length < 64, label);
    }
    // Nothing was admitted and nothing reached an adapter.
    await h.drain();
    assert.equal(h.applied.length, 0);
    // Every refusal is auditable by code without carrying the payload.
    const codes = h.audits.map((event) => event.code);
    assert.ok(codes.includes("unverified"));
    assert.ok(codes.includes("unknown-subscription"));
    assert.ok(codes.includes("too-large"));
    assert.ok(codes.includes("malformed"));
    assert.equal(JSON.stringify(h.audits).includes(CANARY), false);
    const unverified = h.audits.filter((event) => event.code === "unverified");
    assert.ok(
      unverified.some((event) => event.reason === "timestamp-out-of-tolerance"),
    );
    assert.ok(
      unverified.some((event) => event.reason === "signature-mismatch"),
    );
  } finally {
    await h.context.store.close();
  }
});

test("EVT-05: an oversized body is refused while it streams, not after it is buffered", async () => {
  const h = await harness();
  try {
    const huge = JSON.stringify({
      type: "invoice.paid",
      blob: "x".repeat(400_000),
    });
    const response = await h.receive(
      webhookRequest({
        subscription: h.context.subscription,
        body: huge,
        // No content-length hint: the ceiling must hold on the actual bytes.
        headers: (() => {
          const headers = signed(huge, "msg_huge");
          headers.delete("content-length");
          return headers;
        })(),
      }),
    );
    assert.equal(response.status, 413);
    assert.deepEqual(await response.json(), { error: "too-large" });
    await h.drain();
    assert.equal(h.applied.length, 0);
  } finally {
    await h.context.store.close();
  }
});

test("EVT-05: a replayed delivery is deduplicated and never dispatched twice", async () => {
  const h = await harness();
  try {
    const headers = signed(BODY, "msg_replay");
    const first = await h.receive(
      webhookRequest({
        subscription: h.context.subscription,
        body: BODY,
        headers,
      }),
    );
    assert.equal(first.status, 200);
    assert.deepEqual(await first.json(), { status: "accepted" });
    // The exact same signed bytes again: a valid signature is not freshness.
    const replay = await h.receive(
      webhookRequest({
        subscription: h.context.subscription,
        body: BODY,
        headers,
      }),
    );
    assert.equal(replay.status, 200);
    assert.deepEqual(await replay.json(), { status: "duplicate" });
    await h.drain();
    assert.equal(h.applied.length, 1);
  } finally {
    await h.context.store.close();
  }
});

test("AC-STATE-07/EVT-05: an unsigned or wrong-tenant lifecycle event cannot revoke a connection", async () => {
  const h = await harness();
  const revocation = JSON.stringify({
    type: "connection.revoked",
    connectionId: "connection:1",
  });
  try {
    // Unsigned.
    const unsigned = await h.receive(
      webhookRequest({
        subscription: h.context.subscription,
        body: revocation,
        headers: new Headers({ "content-type": "application/json" }),
      }),
    );
    assert.equal(unsigned.status, 401);
    // Signed with a secret belonging to another tenant's subscription.
    const other = await scaffold({
      tenantId: "tenant-b",
      subjectId: "subject-2",
      material: { primary: ROTATED },
    });
    try {
      const crossTenant = await h.receive(
        webhookRequest({
          subscription: h.context.subscription,
          body: revocation,
          headers: signStandardWebhook({
            id: "msg_cross",
            timestampSeconds: NOW_SECONDS,
            body: revocation,
            secret: ROTATED,
          }),
        }),
      );
      assert.equal(crossTenant.status, 401);
      // And a correctly signed event for the other tenant's own subscription
      // never touches this tenant's connection.
      assert.equal(
        (
          await other.registry.get(
            other.actor,
            other.subscription.subscriptionId,
          )
        )?.tenantId,
        "tenant-b",
      );
      assert.equal(
        await other.registry.get(
          h.context.actor,
          other.subscription.subscriptionId,
        ),
        undefined,
        "a foreign subscription is not readable across tenants",
      );
    } finally {
      await other.store.close();
    }
    await h.drain();
    assert.equal(h.applied.length, 0, "no lifecycle event was ever dispatched");
    // A properly signed revocation does reach the adapter, as a lifecycle hint.
    const valid = await h.receive(
      webhookRequest({
        subscription: h.context.subscription,
        body: revocation,
        headers: signStandardWebhook({
          id: "msg_revoke",
          timestampSeconds: NOW_SECONDS,
          body: revocation,
        }),
      }),
    );
    assert.equal(valid.status, 200);
    await h.drain();
    const dispatched = h.applied.at(0);
    assert.equal(h.applied.length, 1);
    assert.deepEqual(dispatched?.lifecycle, { kind: "revoked" });
    assert.equal(dispatched?.envelope.providerEventType, "connection.revoked");
  } finally {
    await h.context.store.close();
  }
});

test("EVT-05: an event type outside the approved subscription is acknowledged but never admitted", async () => {
  const h = await harness({ eventTypes: ["invoice.paid"] });
  try {
    const body = JSON.stringify({ type: "invoice.deleted", id: "in_x" });
    const response = await h.receive(
      webhookRequest({
        subscription: h.context.subscription,
        body,
        headers: signed(body, "msg_untyped"),
      }),
    );
    assert.equal(response.status, 202);
    assert.deepEqual(await response.json(), { status: "ignored" });
    await h.drain();
    assert.equal(h.applied.length, 0);
  } finally {
    await h.context.store.close();
  }
});

test("EVT-05: a subscription may only name an approved destination of its binding", async () => {
  const context = await scaffold();
  try {
    await assert.rejects(
      () =>
        context.registry.approve(context.actor, {
          connectionRef: "connection:1",
          binding: context.binding,
          destinationId: "not-approved",
          eventTypes: ["invoice.paid"],
          secretRef: context.secretRef,
          verification: { method: "standard-webhooks" },
          authority: "acme-billing",
          generation: 1,
          policyRevision: "policy:1",
        }),
      (error: unknown) =>
        error instanceof ConnectorError &&
        error.code === "denied" &&
        error.detail === "events.destination.unapproved",
    );
    // A binding belonging to another tenant cannot be used to approve one here.
    await assert.rejects(
      () =>
        context.registry.approve(context.actor, {
          connectionRef: "connection:1",
          binding: receiverBinding("tenant-b"),
          destinationId: "receiver",
          eventTypes: ["invoice.paid"],
          secretRef: context.secretRef,
          verification: { method: "standard-webhooks" },
          authority: "acme-billing",
          generation: 1,
          policyRevision: "policy:1",
        }),
      (error: unknown) =>
        error instanceof ConnectorError &&
        error.detail === "events.binding.foreign-tenant",
    );
    // A suspended or retired binding is not an approval either.
    await assert.rejects(() =>
      context.registry.approve(context.actor, {
        connectionRef: "connection:1",
        binding: receiverBinding("tenant-a", { status: "suspended" }),
        destinationId: "receiver",
        eventTypes: ["invoice.paid"],
        secretRef: context.secretRef,
        verification: { method: "standard-webhooks" },
        authority: "acme-billing",
        generation: 1,
        policyRevision: "policy:1",
      }),
    );
    // The approved destination's exact origin is pinned into the record.
    assert.equal(context.subscription.destinationOrigin, "https://app.example");
  } finally {
    await context.store.close();
  }
});

test("EVT-05: changing the destination is a new approval that retires the old subscription", async () => {
  const context = await scaffold();
  try {
    const original = context.subscription;
    const { retired, approved } = await context.registry.replace(
      context.actor,
      original.subscriptionId,
      { binding: context.binding, destinationId: "other-receiver" },
    );
    // The old subscription is retired, not edited.
    assert.equal(retired.subscriptionId, original.subscriptionId);
    assert.equal(retired.state, "retired");
    assert.equal(retired.retiredReason, "destination-changed");
    assert.equal(retired.destinationId, "receiver");
    assert.equal(retired.replacedBy, approved.subscriptionId);
    // The replacement is a distinct subscription pointing back at it.
    assert.notEqual(approved.subscriptionId, original.subscriptionId);
    assert.equal(approved.state, "approved");
    assert.equal(approved.destinationId, "other-receiver");
    assert.equal(approved.destinationOrigin, "https://other.app.example");
    assert.equal(approved.replaces, original.subscriptionId);
    // Deliveries to the retired route stop, even with a perfect signature.
    const inbox = new EventInbox(context.store, {
      subscriptions: context.registry,
    });
    const receive = createWebhookReceiver({
      resolveSecrets: context.resolveSecrets,
      inbox,
      policy: { now: () => NOW },
    });
    const response = await receive(
      webhookRequest({
        subscription: original,
        body: BODY,
        headers: signed(BODY, "msg_retired"),
      }),
    );
    assert.equal(response.status, 410);
    assert.deepEqual(await response.json(), { error: "retired" });
    // The replacement route accepts the same event.
    const accepted = await receive(
      webhookRequest({
        subscription: approved,
        body: BODY,
        headers: signed(BODY, "msg_replaced"),
      }),
    );
    assert.equal(accepted.status, 200);
    // A destination change on an already retired subscription is refused.
    await assert.rejects(
      () =>
        context.registry.replace(context.actor, original.subscriptionId, {
          binding: context.binding,
          destinationId: "receiver",
        }),
      (error: unknown) =>
        error instanceof ConnectorError && error.code === "conflict",
    );
    // And the replacement itself must still name an approved destination.
    await assert.rejects(() =>
      context.registry.replace(context.actor, approved.subscriptionId, {
        binding: context.binding,
        destinationId: "elsewhere",
      }),
    );
  } finally {
    await context.store.close();
  }
});

test("EVT-05: subscription reads and retirement are owner-scoped", async () => {
  const context = await scaffold();
  try {
    const stranger = {
      ...context.actor,
      subjectId: "subject-other",
    };
    assert.equal(
      await context.registry.get(stranger, context.subscription.subscriptionId),
      undefined,
    );
    await assert.rejects(
      () =>
        context.registry.retire(
          stranger,
          context.subscription.subscriptionId,
          "manual",
        ),
      (error: unknown) =>
        error instanceof ConnectorError && error.code === "not-found",
    );
    assert.deepEqual(
      (await context.registry.list(stranger)).map(
        (item) => item.subscriptionId,
      ),
      [],
    );
    const mine = await context.registry.list(context.actor, "connection:1");
    assert.deepEqual(
      mine.map((item) => item.subscriptionId),
      [context.subscription.subscriptionId],
    );
    const retired = await context.registry.retire(
      context.actor,
      context.subscription.subscriptionId,
      "user-disconnected",
    );
    assert.equal(retired.state, "retired");
    assert.equal(retired.retiredReason, "user-disconnected");
  } finally {
    await context.store.close();
  }
});

test("EVT-05: the secret stays in custody and the receiver reads only what the convention names", async () => {
  const context = await scaffold({
    material: { primary: SECRET, "upstream:origin": ROTATED },
  });
  try {
    const resolved = secretsFromMaterial({
      primary: SECRET,
      "upstream:origin": ROTATED,
      "not a key id": "ignored",
    });
    assert.deepEqual(
      resolved.current.map((item) => item.keyId),
      ["primary"],
    );
    assert.deepEqual(
      resolved.upstream.map((item) => item.keyId),
      ["origin"],
    );
    // The resolver hands the verifier its keys inside custody, and the
    // subscription record itself never carries the secret.
    const target = await context.resolveSecrets({
      authority: "acme-billing",
      subscriptionId: context.subscription.subscriptionId,
    });
    assert.ok(target);
    const keyIds = await target.useSecrets(async (secrets) =>
      secrets.current.map((item) => item.keyId),
    );
    assert.deepEqual(keyIds, ["primary"]);
    assert.equal(JSON.stringify(context.subscription).includes(SECRET), false);
    assert.equal(context.subscription.secretRef, context.secretRef);
  } finally {
    await context.store.close();
  }
});

test("EVT-05: a vendor-signed subscription uses its registered verifier and nothing else", async () => {
  const context = await scaffold({
    verification: { method: "vendor-signature", vendor: "acme-vendor" },
    material: { primary: "vendor-shared-secret-value" },
  });
  try {
    const inbox = new EventInbox(context.store, {
      subscriptions: context.registry,
    });
    const receive = createWebhookReceiver({
      resolveSecrets: context.resolveSecrets,
      inbox,
      verifiers: [
        hmacVendorVerifier({
          id: "acme-vendor",
          header: "x-acme-signature",
          identify: (delivery) => {
            const id =
              delivery.headers instanceof Headers
                ? delivery.headers.get("x-acme-delivery")
                : undefined;
            return id ? { eventId: id } : undefined;
          },
        }),
      ],
      policy: { now: () => NOW },
    });
    const { createHmac } = await import("node:crypto");
    const signature = createHmac("sha256", "vendor-shared-secret-value")
      .update(Buffer.from(BODY, "utf8"))
      .digest("hex");
    const response = await receive(
      webhookRequest({
        subscription: context.subscription,
        body: BODY,
        headers: new Headers({
          "content-type": "application/json",
          "x-acme-signature": signature,
          "x-acme-delivery": "vendor-evt-1",
        }),
      }),
    );
    assert.equal(response.status, 200);
    const record = await inbox.get(
      "tenant-a",
      eventDeliveryId("acme-billing", "vendor-evt-1"),
    );
    assert.equal(record?.envelope.verification.method, "vendor-signature");
    // Standard Webhooks headers are not a fallback for a vendor subscription.
    const standard = await receive(
      webhookRequest({
        subscription: context.subscription,
        body: BODY,
        headers: signed(BODY, "msg_sw_fallback"),
      }),
    );
    assert.equal(standard.status, 401);
  } finally {
    await context.store.close();
  }
});

test("EVT-05: a subscription naming an unregistered verifier fails closed", async () => {
  const context = await scaffold({
    verification: { method: "vendor-signature", vendor: "never-registered" },
  });
  try {
    const inbox = new EventInbox(context.store);
    const audits: ReceiverAudit[] = [];
    const receive = createWebhookReceiver({
      resolveSecrets: context.resolveSecrets,
      inbox,
      policy: { now: () => NOW, audit: (event) => audits.push(event) },
    });
    const response = await receive(
      webhookRequest({
        subscription: context.subscription,
        body: BODY,
        headers: signed(BODY, "msg_noverifier"),
      }),
    );
    assert.equal(response.status, 401);
    assert.equal(audits.at(-1)?.reason, "verifier-unavailable");
  } finally {
    await context.store.close();
  }
});

test("EVT-05: an event the verifier cannot name is refused rather than given an invented id", async () => {
  const context = await scaffold({
    verification: { method: "vendor-signature", vendor: "acme-vendor" },
    material: { primary: "vendor-shared-secret-value" },
  });
  try {
    const inbox = new EventInbox(context.store);
    const receive = createWebhookReceiver({
      resolveSecrets: context.resolveSecrets,
      inbox,
      verifiers: [
        hmacVendorVerifier({ id: "acme-vendor", header: "x-acme-signature" }),
      ],
      policy: { now: () => NOW },
    });
    const { createHmac } = await import("node:crypto");
    // A body with no id anywhere: the vendor verifier proves the sender but
    // establishes no delivery identity, and nothing invents one.
    const body = JSON.stringify({ type: "invoice.paid" });
    const signature = createHmac("sha256", "vendor-shared-secret-value")
      .update(Buffer.from(body, "utf8"))
      .digest("hex");
    const response = await receive(
      webhookRequest({
        subscription: context.subscription,
        body,
        headers: new Headers({
          "content-type": "application/json",
          "x-acme-signature": signature,
        }),
      }),
    );
    assert.equal(response.status, 400);
    assert.deepEqual(await response.json(), { error: "unidentified" });
  } finally {
    await context.store.close();
  }
});
