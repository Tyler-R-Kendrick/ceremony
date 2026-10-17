import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import {
  beginAuthorizationCode,
  beginDeviceAuthorization,
  completeAuthorizationCode,
  issueHandoff,
  MAX_RESPONSE_BYTES,
  pollDeviceAuthorization,
  ResponseTooLargeError,
  revokeUpstreamGrantWithReason,
} from "../../../src/server/connectors/auth/index.js";
import { ConnectorError } from "../../../src/server/connectors/errors.js";
import type {
  AdapterCallContext,
  HandoffRecord,
} from "../../../src/server/connectors/index.js";
import {
  assertReadUnder,
  endlessResponse,
  type Pulled,
  type Sites,
} from "../doubles/endless-body.js";
import { authHarness, type AuthHarness } from "./harness.js";
import {
  answering,
  describeFailure,
  exchangeWith,
  grantWith,
  journalOf,
  refreshWith,
  registerWith,
  signedIn,
} from "./outcome-rigs.js";

/*
 * Every call the OAuth engine makes is shown to cut an answer that never ends
 * at the ceiling, by the call itself (not by the transport under it, which
 * response-bound.test.ts holds to the same): the endpoint under test is
 * served a body without end, every other endpoint is the real fixture
 * server's, and what the host pulled is measured. Where the request was sent
 * before its answer was read, the outcome is the unknown a lost answer is.
 */

const PAR: Sites = [
  "src/server/connectors/auth/authorization-code.ts#beginAuthorizationCode",
];
const CALLBACK: Sites = [
  "src/server/connectors/auth/authorization-code.ts#completeAuthorizationCode",
];
const STALE: Sites = [
  "src/server/connectors/auth/authorization-code.ts#revokeQuietly",
];
const REFRESH: Sites = [
  "src/server/connectors/auth/authorization-code.ts#refreshAccessToken",
];
const GRANT: Sites = [
  "src/server/connectors/auth/client-credentials.ts#grantClientCredentials",
];
const GRANT_JSON: Sites = [
  "src/server/connectors/auth/client-credentials.ts#jsonBodyFetch",
];
const REGISTRATION: Sites = [
  "src/server/connectors/auth/client.ts#dynamicClient",
];
const DEVICE: Sites = ["src/server/connectors/auth/device.ts#wireOf"];
const REVOKE: Sites = ["src/server/connectors/auth/revocation.ts#present"];
const EXCHANGE: Sites = [
  "src/server/connectors/auth/token-exchange.ts#exchangeToken",
];
const KEY_SET: Sites = ["src/server/connectors/auth/token-exchange.ts#jwks"];
const INTROSPECT: Sites = [
  "src/server/connectors/auth/token-exchange.ts#introspect",
];

const bounded = (seen: Pulled, what: string) =>
  assertReadUnder(assert, seen, MAX_RESPONSE_BYTES, what);

/** An answer without end for `sites`, counted in `seen`. */
const without =
  (seen: Pulled, sites: Sites, status = 200) =>
  () =>
    endlessResponse(seen, sites, { status });

const tooLarge = (failure: unknown) =>
  failure instanceof ConnectorError &&
  (failure instanceof ResponseTooLargeError ||
    failure.cause instanceof ResponseTooLargeError);

async function begun(harness: AuthHarness, ctx: AdapterCallContext) {
  const start = await beginAuthorizationCode(ctx, {
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
    .find((item) => item.handoffRef === issued.handoffRef) as HandoffRecord;
  const callback = await harness.server.authorize(
    record.private["authorizationUrl"]!,
  );
  return { record, callback: new URL(callback) };
}

const fixtureClient = { OAUTH_CLIENT_ID: "fixture-client" };

test("a pushed authorization answer that never ends is cut off, and no handoff is made from it", async (t) => {
  const harness = await authHarness(t, {
    configuration: fixtureClient,
    server: { pushedAuthorization: true, requirePushedAuthorization: true },
  });
  const seen: Pulled = { pulled: 0 };
  const ctx = answering(harness.ctx(), without(seen, PAR, 201), "/par");
  await assert.rejects(
    beginAuthorizationCode(ctx, {
      server: harness.resolved,
      client: harness.client,
      policy: harness.policy,
      scopes: ["profile"],
    }),
    tooLarge,
  );
  bounded(seen, "a pushed authorization answer");
  assert.equal(harness.ports.inspect.handoffs().length, 0);
});

test("a code exchange answer that never ends is cut off, and the code is reported as possibly spent", async (t) => {
  const harness = await authHarness(t, { configuration: fixtureClient });
  const ctx = harness.ctx();
  const { record, callback } = await begun(harness, ctx);
  const seen: Pulled = { pulled: 0 };
  const outcome = await completeAuthorizationCode(
    answering(ctx, without(seen, CALLBACK), "/token"),
    {
      url: callback,
      handoff: record,
      server: harness.resolved,
      client: harness.client,
      policy: harness.policy,
    },
  );
  assert.equal(outcome.state, "indeterminate");
  assert.equal(outcome.code, "oauth.token.indeterminate");
  assert.equal(harness.ports.inspect.credentialRefs().length, 0);
  bounded(seen, "a code exchange answer");
});

test("a revocation answer that never ends is cut off when a stale sign-in's tokens are discarded", async (t) => {
  const harness = await authHarness(t, { configuration: fixtureClient });
  const ctx = harness.ctx();
  const { record, callback } = await begun(harness, ctx);
  // Both tokens are presented for revocation, one answer each.
  const served: Pulled[] = [];
  const real = ctx.environment.fetch;
  const stale: AdapterCallContext = {
    ...ctx,
    environment: {
      ...ctx.environment,
      fetch: async (input, init) => {
        const path = new URL(
          typeof input === "string"
            ? input
            : input instanceof URL
              ? input.href
              : input.url,
        ).pathname;
        if (path === "/revoke") {
          const seen: Pulled = { pulled: 0 };
          served.push(seen);
          return without(seen, STALE)();
        }
        const answered = await real(input, init);
        // The connection moves on while the code is being exchanged.
        if (path === "/token")
          await harness.ports.handoffs.cancelAll(
            harness.connection.connectionRef,
            "cancelled",
          );
        return answered;
      },
    },
  };
  await assert.rejects(
    completeAuthorizationCode(stale, {
      url: callback,
      handoff: record,
      server: harness.resolved,
      client: harness.client,
      policy: harness.policy,
    }),
    (error: unknown) =>
      error instanceof ConnectorError &&
      error.detail === "oauth.handoff.stale-generation",
  );
  assert.ok(served.length > 0, "the discarded tokens were presented");
  for (const seen of served) bounded(seen, "a revocation answer");
  assert.equal(harness.ports.inspect.credentialRefs().length, 0);
});

test("a refresh answer that never ends is cut off and reported exactly as a lost answer is", async (t) => {
  const seen: Pulled = { pulled: 0 };
  const refreshed = await refreshWith(t, without(seen, REFRESH));
  assert.deepEqual(refreshed.first, {
    code: "indeterminate",
    detail: "oauth.refresh.indeterminate",
  });
  assert.deepEqual(refreshed.journal, [
    ["indeterminate", "oauth.refresh.indeterminate"],
  ]);
  bounded(seen, "a refresh answer");
});

/** A client-credentials grant whose token answer never ends, sent as `encoding` for `sites`. */
const grantTest = (name: string, sites: Sites, encoding?: "json") =>
  test(`a ${name} client-credentials answer that never ends is cut off, reported as unknown and kept nowhere`, async (t) => {
    const seen: Pulled = { pulled: 0 };
    const granted = await grantWith(t, without(seen, sites), encoding);
    assert.deepEqual(granted.described, {
      code: "indeterminate",
      detail: "oauth.client-credentials.indeterminate",
    });
    assert.equal(granted.stored, 0);
    bounded(seen, "a client-credentials answer");
  });

grantTest("form-encoded", GRANT);
grantTest("JSON-encoded", GRANT_JSON, "json");

test("a dynamic registration answer that never ends is cut off, and whether a client exists is unknown", async (t) => {
  const seen: Pulled = { pulled: 0 };
  const { failure, effects } = await registerWith(
    t,
    without(seen, REGISTRATION, 201),
  );
  assert.deepEqual(describeFailure(failure), {
    code: "indeterminate",
    detail: "oauth.registration.indeterminate",
  });
  assert.deepEqual(effects, [
    ["indeterminate", "oauth.registration.indeterminate"],
  ]);
  bounded(seen, "a registration answer");
});

test("a device authorization answer that never ends is cut off, and no handoff is made from it", async (t) => {
  const harness = await authHarness(t, {
    configuration: fixtureClient,
    server: { deviceFlow: true, deviceInterval: 5 },
  });
  const seen: Pulled = { pulled: 0 };
  const ctx = answering(harness.ctx(), without(seen, DEVICE), "/device");
  await assert.rejects(
    beginDeviceAuthorization(ctx, {
      server: harness.resolved,
      client: harness.client,
      policy: harness.policy,
      scopes: ["profile"],
    }),
    tooLarge,
  );
  bounded(seen, "a device authorization answer");
  assert.equal(harness.ports.inspect.handoffs().length, 0);
});

test("a device token answer that never ends is cut off, reported as unknown and kept nowhere", async (t) => {
  const harness = await authHarness(t, {
    configuration: fixtureClient,
    server: { deviceFlow: true, deviceInterval: 5 },
  });
  const ctx = harness.ctx();
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
    .find((item) => item.handoffRef === issued.handoffRef) as HandoffRecord;
  assert.ok(harness.server.approveDevice(record.private["userCode"]!));
  harness.advance(5_000);
  const seen: Pulled = { pulled: 0 };
  const outcome = await pollDeviceAuthorization(
    answering(ctx, without(seen, DEVICE), "/token"),
    {
      handoff: record,
      server: harness.resolved,
      client: harness.client,
      policy: harness.policy,
    },
  );
  assert.equal(outcome.state, "indeterminate");
  assert.equal(outcome.code, "oauth.device.indeterminate");
  assert.equal(harness.ports.inspect.credentialRefs().length, 0);
  bounded(seen, "a device token answer");
});

test("a revocation answer that never ends is cut off, and the grant is reported as possibly revoked", async (t: TestContext) => {
  const signed = await signedIn(t, {
    policy: { revocation: "on-upstream-disconnect" },
  });
  const seen: Pulled = { pulled: 0 };
  const outcome = await revokeUpstreamGrantWithReason(
    answering(signed.ctx, without(seen, REVOKE), "/revoke"),
    {
      server: signed.harness.resolved,
      client: signed.harness.client,
      policy: signed.harness.policy,
      scope: signed.scope,
      credentialRef: signed.credentialRef,
    },
  );
  assert.equal(outcome.outcome, "indeterminate");
  assert.equal(outcome.reason, "oauth.revoke.indeterminate");
  assert.deepEqual(journalOf(signed.harness, "oauth.token.revoke"), [
    ["indeterminate", "oauth.revoke.indeterminate"],
  ]);
  bounded(seen, "a revocation answer");
});

test("an RFC 8693 token answer that never ends is cut off, reported as unknown and kept nowhere", async (t) => {
  const seen: Pulled = { pulled: 0 };
  const { failure, journal, stored } = await exchangeWith(
    t,
    without(seen, EXCHANGE),
  );
  assert.deepEqual(describeFailure(failure), {
    code: "indeterminate",
    detail: "oauth.exchange.indeterminate",
  });
  assert.deepEqual(journal, ["indeterminate"]);
  assert.equal(stored, 0);
  bounded(seen, "an exchange answer");
});

test("a key set that never ends is cut off when an exchanged token is verified", async (t) => {
  const seen: Pulled = { pulled: 0 };
  const { failure, stored } = await exchangeWith(
    t,
    without(seen, KEY_SET),
    "/jwks",
  );
  assert.ok(tooLarge(failure), String(failure));
  assert.equal(stored, 0);
  bounded(seen, "a key set");
});

test("an introspection answer that never ends is cut off when an opaque exchanged token is verified", async (t) => {
  const seen: Pulled = { pulled: 0 };
  const { failure, stored } = await exchangeWith(
    t,
    without(seen, INTROSPECT),
    "/introspect",
    "opaque",
  );
  assert.ok(tooLarge(failure), String(failure));
  assert.equal(stored, 0);
  bounded(seen, "an introspection answer");
});
