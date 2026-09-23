import assert from "node:assert/strict";
import test from "node:test";
import {
  beginDeviceAuthorization,
  humanHandoffPresentation,
  issueHandoff,
  pollDeviceAuthorization,
  type DevicePollState,
} from "../../../src/server/connectors/auth/index.js";
import { ConnectorError } from "../../../src/server/connectors/errors.js";
import type {
  AdapterCallContext,
  HandoffRecord,
} from "../../../src/server/connectors/index.js";
import { authHarness, type AuthHarness } from "./harness.js";

/*
 * RFC 8628 device authorization against the fixture server. The fixture owns
 * the pending/slow_down/denied/expired behaviour, so the adapter's backoff and
 * result mapping are measured against a real server's answers.
 */

async function deviceHandoff(harness: AuthHarness, ctx: AdapterCallContext) {
  const start = await beginDeviceAuthorization(ctx, {
    server: harness.resolved,
    client: harness.client,
    policy: harness.policy,
    scopes: ["profile"],
  });
  assert.equal(start.kind, "handoff");
  if (start.kind !== "handoff") throw new Error("unreachable");
  const issued = await issueHandoff(ctx, start.handoff);
  const record = harness.ports.inspect
    .handoffs()
    .find((item) => item.handoffRef === issued.handoffRef)!;
  return record as HandoffRecord;
}

const deviceServer = { deviceFlow: true, deviceInterval: 5 } as const;

test("a device handoff keeps the device code private and shows only the user code", async (t) => {
  const harness = await authHarness(t, {
    configuration: { OAUTH_CLIENT_ID: "fixture-client" },
    server: deviceServer,
  });
  const ctx = harness.ctx();
  const record = await deviceHandoff(harness, ctx);
  assert.equal(record.kind, "device-code");
  assert.ok(record.private["deviceCode"]);
  const shown = humanHandoffPresentation(record, harness.now());
  assert.equal(shown.userCode, record.private["userCode"]);
  assert.equal(shown.url, record.private["verificationUriComplete"]);
  assert.equal(
    JSON.stringify(shown).includes(record.private["deviceCode"]!),
    false,
    "the device code is never presented",
  );
});

test("polling yields pending, then completes once a person approves", async (t) => {
  const harness = await authHarness(t, {
    configuration: { OAUTH_CLIENT_ID: "fixture-client" },
    server: deviceServer,
  });
  const ctx = harness.ctx();
  const record = await deviceHandoff(harness, ctx);
  const first = await pollDeviceAuthorization(ctx, {
    handoff: record,
    server: harness.resolved,
    client: harness.client,
    policy: harness.policy,
  });
  assert.equal(first.state, "pending");
  assert.equal(first.code, "oauth.device.pending");
  const poll = first.adapterState?.["devicePoll"] as DevicePollState;
  assert.equal(poll.interval, 5);

  // Polling before the interval elapses does not touch the token endpoint.
  const beforeCount = harness.server.counts.deviceToken;
  const early = await pollDeviceAuthorization(ctx, {
    handoff: record,
    server: harness.resolved,
    client: harness.client,
    policy: harness.policy,
    poll,
  });
  assert.equal(early.code, "oauth.device.wait");
  assert.equal(harness.server.counts.deviceToken, beforeCount);

  assert.ok(harness.server.approveDevice(record.private["userCode"]!));
  harness.advance(5000);
  const done = await pollDeviceAuthorization(ctx, {
    handoff: record,
    server: harness.resolved,
    client: harness.client,
    policy: harness.policy,
    poll,
  });
  assert.equal(done.state, "complete");
  assert.ok(done.credentialRef);
  assert.equal(harness.ports.inspect.handoffs()[0]?.state, "completed");
});

test("slow_down grows the interval by five seconds and is respected", async (t) => {
  const harness = await authHarness(t, {
    configuration: { OAUTH_CLIENT_ID: "fixture-client" },
    server: { ...deviceServer, misbehave: { slowDown: 1 } },
  });
  const ctx = harness.ctx();
  const record = await deviceHandoff(harness, ctx);
  const first = await pollDeviceAuthorization(ctx, {
    handoff: record,
    server: harness.resolved,
    client: harness.client,
    policy: harness.policy,
  });
  assert.equal(first.state, "pending");
  assert.equal(first.code, "oauth.device.slow-down");
  const poll = first.adapterState?.["devicePoll"] as DevicePollState;
  assert.equal(poll.interval, 10, "5s advertised + 5s increment");
  assert.equal(poll.nextPollAt, harness.now() + 10_000);

  const before = harness.server.counts.deviceToken;
  harness.advance(9_000);
  const tooEarly = await pollDeviceAuthorization(ctx, {
    handoff: record,
    server: harness.resolved,
    client: harness.client,
    policy: harness.policy,
    poll,
  });
  assert.equal(tooEarly.code, "oauth.device.wait");
  assert.equal(
    harness.server.counts.deviceToken,
    before,
    "the grown interval is honoured",
  );
  harness.advance(2_000);
  const next = await pollDeviceAuthorization(ctx, {
    handoff: record,
    server: harness.resolved,
    client: harness.client,
    policy: harness.policy,
    poll,
  });
  assert.equal(next.state, "pending");
  assert.equal(harness.server.counts.deviceToken, before + 1);
});

test("a denied device authorization ends the handoff as denied", async (t) => {
  const harness = await authHarness(t, {
    configuration: { OAUTH_CLIENT_ID: "fixture-client" },
    server: deviceServer,
  });
  const ctx = harness.ctx();
  const record = await deviceHandoff(harness, ctx);
  assert.ok(harness.server.denyDevice(record.private["userCode"]!));
  const result = await pollDeviceAuthorization(ctx, {
    handoff: record,
    server: harness.resolved,
    client: harness.client,
    policy: harness.policy,
  });
  assert.equal(result.state, "denied");
  assert.equal(result.code, "oauth.device.access-denied");
  assert.deepEqual(result.claims, []);
  assert.equal(harness.ports.inspect.handoffs()[0]?.state, "denied");
  assert.equal(harness.ports.inspect.credentialRefs().length, 0);
});

test("an expired device code is reported expired, by the server and by the clock", async (t) => {
  const serverExpired = await authHarness(t, {
    configuration: { OAUTH_CLIENT_ID: "fixture-client" },
    server: { ...deviceServer, misbehave: { expiredDeviceCode: true } },
  });
  const ctx = serverExpired.ctx();
  const record = await deviceHandoff(serverExpired, ctx);
  const result = await pollDeviceAuthorization(ctx, {
    handoff: record,
    server: serverExpired.resolved,
    client: serverExpired.client,
    policy: serverExpired.policy,
  });
  assert.equal(result.state, "expired");
  assert.equal(result.code, "oauth.device.expired");

  // A handoff that outlived its own expiry never polls at all.
  const local = await authHarness(t, {
    configuration: { OAUTH_CLIENT_ID: "fixture-client" },
    server: deviceServer,
  });
  const localCtx = local.ctx();
  const localRecord = await deviceHandoff(local, localCtx);
  const before = local.server.counts.deviceToken;
  local.advance(700_000);
  const expired = await pollDeviceAuthorization(localCtx, {
    handoff: localRecord,
    server: local.resolved,
    client: local.client,
    policy: local.policy,
  });
  assert.equal(expired.state, "expired");
  assert.equal(local.server.counts.deviceToken, before);
});

test("a device poll for an older generation is fenced", async (t) => {
  const harness = await authHarness(t, {
    configuration: { OAUTH_CLIENT_ID: "fixture-client" },
    server: deviceServer,
  });
  const ctx = harness.ctx();
  const record = await deviceHandoff(harness, ctx);
  harness.server.approveDevice(record.private["userCode"]!);
  const newer = harness.ctx({
    connection: { ...harness.connection, generation: 1 },
    generation: 1,
  });
  await assert.rejects(
    pollDeviceAuthorization(newer, {
      handoff: record,
      server: harness.resolved,
      client: harness.client,
      policy: harness.policy,
    }),
    (error: unknown) =>
      error instanceof ConnectorError &&
      error.detail === "oauth.handoff.stale-generation",
  );
  assert.equal(harness.ports.inspect.credentialRefs().length, 0);
});

test("a device handoff bound to another issuer or client is refused", async (t) => {
  const harness = await authHarness(t, {
    configuration: { OAUTH_CLIENT_ID: "fixture-client" },
    server: deviceServer,
  });
  const ctx = harness.ctx();
  const record = await deviceHandoff(harness, ctx);
  const forged: HandoffRecord = {
    ...record,
    private: { ...record.private, issuer: "https://evil.example" },
  };
  await assert.rejects(
    pollDeviceAuthorization(ctx, {
      handoff: forged,
      server: harness.resolved,
      client: harness.client,
      policy: harness.policy,
    }),
    (error: unknown) =>
      error instanceof ConnectorError &&
      error.detail === "oauth.device.binding-mismatch",
  );
});

test("device authorization reports unsupported when the issuer has no device endpoint", async (t) => {
  const harness = await authHarness(t, {
    configuration: { OAUTH_CLIENT_ID: "fixture-client" },
  });
  const start = await beginDeviceAuthorization(harness.ctx(), {
    server: harness.resolved,
    client: harness.client,
    policy: harness.policy,
    scopes: ["profile"],
  });
  assert.equal(start.kind, "unsupported");
  assert.equal(
    start.kind === "unsupported" && start.code,
    "oauth.device-endpoint.missing",
  );
});
