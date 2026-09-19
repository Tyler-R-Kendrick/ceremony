import { test } from "node:test";
import assert from "node:assert/strict";
import { fixtureActor, memoryPorts } from "../doubles/ports.js";
import { daprInputDelivery, daprInputProbe } from "../doubles/dapr-sidecar.js";
import { buildBinding } from "../fixtures/builders.js";
import type { AdapterCallContext } from "../../../src/server/connectors/adapter.js";
import {
  acceptsDaprInput,
  createDaprAdapter,
  createDaprEventPort,
  daprInputSubscriptionStatus,
  daprSidecarFromBinding,
  verifyDaprInputDelivery,
} from "../../../src/server/connectors/providers/dapr/index.js";

/*
 * The sidecar-to-application leg has exactly one authenticator: the app API
 * token. These tests hold that line — an unauthenticated delivery, a wrong
 * token, an unapproved component and a deployment with no token configured all
 * produce nothing, and the reason is never leaked to the sender.
 */

const APP_TOKEN = "fixture-app-api-token";
const APP_TOKEN_CONFIGURATION = "DAPR_APP_API_TOKEN";

function harness(
  options: { inputBindings?: string[]; appToken?: string | null } = {},
) {
  const ports = memoryPorts();
  if (options.appToken !== null)
    ports.configuration.set(
      APP_TOKEN_CONFIGURATION,
      options.appToken ?? APP_TOKEN,
    );
  const binding = buildBinding({
    adapterId: "dapr",
    destinations: [
      {
        id: "sidecar",
        origin: "http://127.0.0.1:3500",
        network: "loopback-fixture",
      },
    ],
    operations: [],
    configuration: [],
    settings: {
      dapr: {
        destinationId: "sidecar",
        unauthenticatedSidecar: true,
        appApiTokenConfiguration: APP_TOKEN_CONFIGURATION,
        appId: "ceremony-fixture-app",
        outputBindings: {},
        inputBindings: options.inputBindings ?? ["orders-topic"],
      },
    },
    profileId: undefined,
  });
  const ctx: AdapterCallContext = {
    actor: fixtureActor,
    binding,
    generation: 0,
    signal: AbortSignal.timeout(5000),
    environment: ports.environment({ fetch: globalThis.fetch }),
  };
  return { ports, binding, ctx };
}

test("a delivery carrying the app API token becomes a verified envelope", async () => {
  const { ctx } = harness();
  const delivery = daprInputDelivery({
    bindingName: "orders-topic",
    payload: { orderId: "o-7" },
    appApiToken: APP_TOKEN,
    receivedAt: 1_760_000_000_000,
    traceparent: "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01",
  });
  const outcome = await verifyDaprInputDelivery(ctx, {
    bindingName: "orders-topic",
    delivery,
  });
  assert.equal(outcome.ok, true);
  if (!outcome.ok) return;
  assert.equal(
    outcome.envelope.providerEventType,
    "dapr.binding.input.orders-topic",
  );
  assert.equal(outcome.envelope.authority, "dapr:ceremony-fixture-app");
  assert.equal(outcome.envelope.verification.method, "vendor-signature");
  assert.equal(outcome.envelope.verification.keyId, "app-api-token");
  assert.equal(outcome.envelope.receivedAt, 1_760_000_000_000);
  assert.equal(outcome.envelope.payloadClassification, "personal");
  assert.deepEqual(outcome.envelope.payload, { orderId: "o-7" });
  assert.deepEqual(outcome.envelope.forwarderHops, []);
});

test("an unauthenticated delivery is never accepted", async () => {
  const { ctx } = harness();
  const delivery = daprInputDelivery({
    bindingName: "orders-topic",
    payload: { orderId: "o-8" },
    receivedAt: 1_760_000_000_000,
  });
  const outcome = await verifyDaprInputDelivery(ctx, {
    bindingName: "orders-topic",
    delivery,
  });
  assert.equal(outcome.ok, false);
  assert.equal(outcome.ok === false ? outcome.reason : "", "missing-token");
});

test("a delivery with the wrong token is rejected", async () => {
  const { ctx } = harness();
  const delivery = daprInputDelivery({
    bindingName: "orders-topic",
    payload: {},
    appApiToken: "not-the-token",
    receivedAt: 1_760_000_000_000,
  });
  const outcome = await verifyDaprInputDelivery(ctx, {
    bindingName: "orders-topic",
    delivery,
  });
  assert.equal(outcome.ok, false);
  assert.equal(outcome.ok === false ? outcome.reason : "", "token-mismatch");
});

test("a delivery for a component the binding did not approve is rejected before the token is read", async () => {
  const { ctx } = harness({ inputBindings: ["orders-topic"] });
  const delivery = daprInputDelivery({
    bindingName: "payouts-topic",
    payload: {},
    appApiToken: APP_TOKEN,
    receivedAt: 1_760_000_000_000,
  });
  const outcome = await verifyDaprInputDelivery(ctx, {
    bindingName: "payouts-topic",
    delivery,
  });
  assert.equal(outcome.ok, false);
  assert.equal(
    outcome.ok === false ? outcome.reason : "",
    "binding-unapproved",
  );
});

test("with no app token configured nothing is authenticated, rather than everything", async () => {
  const { ctx } = harness({ appToken: null });
  const delivery = daprInputDelivery({
    bindingName: "orders-topic",
    payload: {},
    receivedAt: 1_760_000_000_000,
  });
  const outcome = await verifyDaprInputDelivery(ctx, {
    bindingName: "orders-topic",
    delivery,
  });
  assert.equal(outcome.ok, false);
  assert.equal(
    outcome.ok === false ? outcome.reason : "",
    "no-app-token-configured",
  );
});

test("the subscription probe declines a component the binding did not approve", () => {
  const { binding } = harness({ inputBindings: ["orders-topic"] });
  const { settings } = daprSidecarFromBinding(binding);
  // Dapr reads 404 as "this app does not subscribe".
  assert.equal(daprInputProbe("orders-topic").method, "OPTIONS");
  assert.equal(daprInputSubscriptionStatus(settings, "orders-topic"), 200);
  assert.equal(daprInputSubscriptionStatus(settings, "payouts-topic"), 404);
  assert.equal(acceptsDaprInput(settings, "payouts-topic"), false);
});

test("the event port resolves a single approved binding and refuses an ambiguous one", async () => {
  const single = harness({ inputBindings: ["orders-topic"] });
  const port = createDaprEventPort();
  const delivery = daprInputDelivery({
    bindingName: "orders-topic",
    payload: { ok: true },
    appApiToken: APP_TOKEN,
    receivedAt: 1_760_000_000_000,
  });
  const envelope = await port.verify(single.ctx, {
    headers: delivery.headers,
    body: delivery.body,
    receivedAt: delivery.receivedAt,
  });
  assert.ok(envelope);
  assert.equal(envelope.providerEventType, "dapr.binding.input.orders-topic");

  // With two approved bindings the route is ambiguous, so the host's own
  // resolver decides; without one, nothing is verified.
  const many = harness({ inputBindings: ["orders-topic", "payouts-topic"] });
  assert.equal(
    await port.verify(many.ctx, {
      headers: delivery.headers,
      body: delivery.body,
      receivedAt: delivery.receivedAt,
    }),
    undefined,
  );
  const routed = createDaprEventPort({
    resolveInputBinding: () => "payouts-topic",
  });
  const second = await routed.verify(many.ctx, {
    headers: delivery.headers,
    body: delivery.body,
    receivedAt: delivery.receivedAt,
  });
  assert.ok(second);
  assert.equal(second.providerEventType, "dapr.binding.input.payouts-topic");
});

test("the adapter exposes the event port and reports its configuration state", async () => {
  const adapter = createDaprAdapter();
  assert.ok(adapter.events);
  const withToken = adapter
    .capabilities(new Set([APP_TOKEN_CONFIGURATION]))
    .find((row) => row.dimension === "events");
  assert.equal(withToken?.configuration, "ready");
  const without = adapter
    .capabilities(new Set())
    .find((row) => row.dimension === "events");
  assert.equal(without?.configuration, "missing");
  assert.ok(
    without?.limitations.some((limitation) =>
      /No app API token is configured/.test(limitation),
    ),
  );
});
