import assert from "node:assert/strict";
import test from "node:test";
import {
  createAppRelay,
  relayChannel,
  type RelayMessageEvent,
  type RelayScope,
} from "../extensions/browser-login/relay.js";
import type {
  ExtensionPlatform,
  ExtensionPort,
} from "../extensions/browser-login/platform.js";
import { mintHandoffRef } from "../src/browser-login/handoffs.js";

const admitted = "http://127.0.0.1:4173";
const runId = "00000000-0000-4000-8000-000000000001";
const requestId = "00000000-0000-4000-8000-000000000002";

function pageScope(origin: string) {
  const listeners: ((event: RelayMessageEvent) => void)[] = [];
  const posted: { message: unknown; targetOrigin: string }[] = [];
  const scope: RelayScope = {
    location: { origin },
    addEventListener(_type, listener) {
      listeners.push(listener);
    },
    removeEventListener(_type, listener) {
      const at = listeners.indexOf(listener);
      if (at >= 0) listeners.splice(at, 1);
    },
    postMessage(message, targetOrigin) {
      posted.push({ message, targetOrigin });
    },
  };
  return {
    scope,
    listeners,
    posted,
    /** Deliver one `message` event, defaulting to "this window said it". */
    deliver(
      data: unknown,
      overrides: { source?: unknown; origin?: string } = {},
    ) {
      const event: RelayMessageEvent = {
        source: "source" in overrides ? overrides.source : scope,
        origin: overrides.origin ?? origin,
        data,
      };
      for (const listener of [...listeners]) listener(event);
    },
  };
}

function fakePlatform() {
  const sent: unknown[] = [];
  const connected: { name: string }[] = [];
  const portMessages: unknown[] = [];
  let reply: unknown = { protocol: 1, version: "0.1.0" };
  let fail = false;
  const portListeners: ((message: unknown) => void)[] = [];
  const disconnectListeners: (() => void)[] = [];
  let disconnected = 0;
  const port: ExtensionPort = {
    name: "ceremony.handoffs",
    postMessage(message) {
      portMessages.push(message);
    },
    disconnect() {
      disconnected++;
    },
    onMessage: {
      addListener(listener) {
        portListeners.push(listener);
      },
    },
    onDisconnect: {
      addListener(listener) {
        disconnectListeners.push(listener);
      },
    },
  };
  const platform = {
    runtime: {
      async sendMessage(message: unknown) {
        sent.push(message);
        if (fail) throw new Error("unavailable");
        return reply;
      },
      connect(info: { name: string }) {
        connected.push(info);
        return port;
      },
    },
  } as unknown as ExtensionPlatform;
  return {
    platform,
    sent,
    connected,
    portMessages,
    portListeners,
    disconnectListeners,
    get disconnected() {
      return disconnected;
    },
    setReply(value: unknown) {
      reply = value;
    },
    setFailure(value: boolean) {
      fail = value;
    },
  };
}

const ping = {
  channel: relayChannel,
  kind: "request",
  id: requestId,
  request: { type: "ceremony.ping", protocol: 1 },
};

async function flush() {
  for (let index = 0; index < 10; index++) await Promise.resolve();
}

test("a document that is not an exactly admitted app origin gets no relay at all", () => {
  for (const origin of [
    "http://127.0.0.1:4174", // right host, wrong port
    "https://127.0.0.1:4173", // right authority, wrong scheme
    "http://127.0.0.1", // default port is a different origin
    "http://evil.example",
    "null",
  ]) {
    const page = pageScope(origin);
    const runtime = fakePlatform();
    const relay = createAppRelay({
      admittedOrigins: [admitted],
      scope: page.scope,
      platform: runtime.platform,
    });
    assert.equal(relay.admitted, undefined, origin);
    assert.equal(page.listeners.length, 0, origin);
    relay.stop();
    assert.deepEqual(runtime.sent, []);
  }
});

test("only this window, at the admitted origin, in the exact shape, is relayed", async () => {
  const page = pageScope(admitted);
  const runtime = fakePlatform();
  const relay = createAppRelay({
    admittedOrigins: [admitted],
    scope: page.scope,
    platform: runtime.platform,
  });
  assert.equal(relay.admitted, admitted);

  // A hostile frame or opener shares the origin but is a different principal,
  // and `event.source` is the only thing that tells them apart.
  const iframe = { name: "hostile-iframe" };
  page.deliver(ping, { source: iframe });
  page.deliver(ping, { source: undefined });
  page.deliver(ping, { source: null });
  // A page on another origin cannot borrow the relay by claiming a channel.
  page.deliver(ping, { origin: "http://evil.example" });
  page.deliver(ping, { origin: "http://127.0.0.1:4174" });
  page.deliver(ping, { origin: "" });
  await flush();
  assert.deepEqual(runtime.sent, []);
  assert.deepEqual(runtime.connected, []);
  assert.deepEqual(page.posted, []);

  // Neither can a well-sourced message that is not the shape we accept.
  for (const malformed of [
    undefined,
    null,
    "ceremony.ping",
    42,
    {},
    { channel: relayChannel },
    { channel: "other", kind: "request", id: requestId, request: ping.request },
    { channel: relayChannel, kind: "request", request: ping.request },
    { ...ping, id: "not-a-uuid" },
    { ...ping, request: { type: "ceremony.ping", protocol: 2 } },
    { ...ping, request: { type: "ceremony.drive", protocol: 1 } },
    { ...ping, request: { type: "ceremony.ping" } },
    { ...ping, request: { type: "ceremony.ping", protocol: 1, extra: 1 } },
    { ...ping, extra: "smuggled" },
    { channel: relayChannel, kind: "evaluate", code: "fetch('/steal')" },
    {
      channel: relayChannel,
      kind: "resolve-handoff",
      handoffRef: "not-a-ref",
      runId,
      resolution: "completed",
    },
    {
      channel: relayChannel,
      kind: "resolve-handoff",
      handoffRef: mintHandoffRef(),
      runId,
      resolution: "approved",
    },
  ]) {
    page.deliver(malformed);
  }
  await flush();
  assert.deepEqual(runtime.sent, []);
  assert.deepEqual(page.posted, []);

  // The one accepted shape, from this window, at this origin.
  page.deliver(ping);
  await flush();
  assert.deepEqual(runtime.sent, [
    { type: "ceremony.relay", request: { type: "ceremony.ping", protocol: 1 } },
  ]);
  assert.deepEqual(page.posted, [
    {
      message: {
        channel: relayChannel,
        kind: "reply",
        id: requestId,
        reply: { protocol: 1, version: "0.1.0" },
      },
      // Never "*": the answer is addressed to the one origin that asked.
      targetOrigin: admitted,
    },
  ]);
});

test("a refused or absent worker answers the page rather than hanging it", async () => {
  const page = pageScope(admitted);
  const runtime = fakePlatform();
  createAppRelay({
    admittedOrigins: [admitted],
    scope: page.scope,
    platform: runtime.platform,
  });
  runtime.setFailure(true);
  page.deliver(ping);
  await flush();
  assert.deepEqual(page.posted, [
    {
      message: {
        channel: relayChannel,
        kind: "reply",
        id: requestId,
        reply: { error: "unavailable" },
      },
      targetOrigin: admitted,
    },
  ]);
});

test("handoffs keep their attempt reference across the relay", async () => {
  const page = pageScope(admitted);
  const runtime = fakePlatform();
  const relay = createAppRelay({
    admittedOrigins: [admitted],
    scope: page.scope,
    platform: runtime.platform,
  });

  // An answer with no open channel is dropped, never buffered for the next ask.
  const stray = mintHandoffRef();
  page.deliver({
    channel: relayChannel,
    kind: "resolve-handoff",
    handoffRef: stray,
    runId,
    resolution: "completed",
  });
  await flush();
  assert.deepEqual(runtime.connected, []);
  assert.deepEqual(runtime.portMessages, []);

  page.deliver({ channel: relayChannel, kind: "subscribe-handoffs" });
  await flush();
  assert.deepEqual(runtime.connected, [{ name: "ceremony.handoffs" }]);
  // Subscribing twice must not multiply the extension's resolvers.
  page.deliver({ channel: relayChannel, kind: "subscribe-handoffs" });
  await flush();
  assert.equal(runtime.connected.length, 1);

  const handoffRef = mintHandoffRef();
  const event = {
    kind: "handoff",
    handoffRef,
    runId,
    reason: "passkey-required",
    origin: "https://owned.example",
    attempt: 1,
  };
  for (const raw of [
    { type: "ceremony.handoff" },
    { type: "ceremony.handoff", event: { ...event, attempt: 0 } },
    { type: "ceremony.handoff", event: { ...event, handoffRef: "nope" } },
    { type: "other", event },
    { type: "ceremony.handoff", event, extra: 1 },
  ])
    for (const listener of runtime.portListeners) listener(raw);
  assert.deepEqual(page.posted, []);
  for (const listener of runtime.portListeners)
    listener({ type: "ceremony.handoff", event });
  assert.deepEqual(page.posted, [
    {
      message: { channel: relayChannel, kind: "handoff", event },
      targetOrigin: admitted,
    },
  ]);

  page.deliver({
    channel: relayChannel,
    kind: "resolve-handoff",
    handoffRef,
    runId,
    resolution: "completed",
  });
  await flush();
  assert.deepEqual(runtime.portMessages, [
    {
      type: "ceremony.resolve-handoff",
      // The attempt the page was asked about, echoed verbatim: the relay never
      // mints or substitutes a reference of its own.
      handoffRef,
      runId,
      resolution: "completed",
    },
  ]);

  for (const listener of runtime.disconnectListeners) listener();
  assert.deepEqual(page.posted.at(-1), {
    message: { channel: relayChannel, kind: "handoffs-closed" },
    targetOrigin: admitted,
  });
  // After the channel closes an answer has nowhere to go, and the relay
  // reconnects only when the page asks again.
  page.deliver({
    channel: relayChannel,
    kind: "resolve-handoff",
    handoffRef,
    runId,
    resolution: "declined",
  });
  await flush();
  assert.equal(runtime.portMessages.length, 1);
  relay.stop();
  assert.equal(page.listeners.length, 0);
  page.deliver(ping);
  await flush();
  assert.deepEqual(runtime.sent, []);
});
