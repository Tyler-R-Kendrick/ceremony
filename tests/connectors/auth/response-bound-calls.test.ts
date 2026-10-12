import assert from "node:assert/strict";
import test from "node:test";
import { inspect } from "node:util";
import {
  beginDeviceAuthorization,
  discoverAuthorizationServer,
  exchangeToken,
  hostAuthorizedTokenExchange,
  credentialScopeFor,
  issueHandoff,
  MAX_RESPONSE_BYTES,
  pollDeviceAuthorization,
  ResponseTooLargeError,
  tokenTypeIdentifiers,
} from "../../../src/server/connectors/auth/index.js";
import type {
  AdapterCallContext,
  HandoffRecord,
} from "../../../src/server/connectors/index.js";
import { authHarness, type AuthHarness } from "./harness.js";

/*
 * The ceiling on an OAuth answer, met by the calls the connectors make with
 * the real fixture authorization server behind them: device authorization, the
 * device grant's token request, the key set a token exchange verifies with and
 * metadata discovery. The endpoint under test answers with a body over the
 * ceiling; every other endpoint is the real fixture server's.
 */

const MARKER = "tok_dummy_marker_0123456789abcdef";
const deviceServer = { deviceFlow: true, deviceInterval: 5 } as const;

const oversizedBody = () =>
  JSON.stringify({
    access_token: MARKER,
    padding: "x".repeat(MAX_RESPONSE_BYTES),
  });

/** The harness's fetch, except that `matches` is answered with a body over the ceiling. */
function oversizingAt(
  real: typeof fetch,
  matches: (path: string) => boolean,
): typeof fetch {
  return async (input, init) => {
    const url = new URL(
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.href
          : input.url,
    );
    if (!matches(url.pathname)) return real(input, init);
    return new Response(oversizedBody(), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };
}

function oversizing(
  ctx: AdapterCallContext,
  matches: (path: string) => boolean,
): AdapterCallContext {
  return {
    ...ctx,
    environment: {
      ...ctx.environment,
      fetch: oversizingAt(ctx.environment.fetch, matches),
    },
  };
}

const refused = (error: unknown) => {
  assert.ok(error instanceof ResponseTooLargeError, String(error));
  assert.equal(error.detail, "oauth.response.too-large");
  assert.equal(error.limitBytes, MAX_RESPONSE_BYTES);
  assert.equal(
    inspect(error, { depth: null, showHidden: true }).includes(MARKER),
    false,
    "nothing of the body is in the error",
  );
  return true;
};

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
  return harness.ports.inspect
    .handoffs()
    .find((item) => item.handoffRef === issued.handoffRef) as HandoffRecord;
}

test("an oversized device authorization answer is refused, and no handoff is made from it", async (t) => {
  const harness = await authHarness(t, {
    configuration: { OAUTH_CLIENT_ID: "fixture-client" },
    server: deviceServer,
  });
  const ctx = oversizing(harness.ctx(), (path) => path === "/device");
  await assert.rejects(
    beginDeviceAuthorization(ctx, {
      server: harness.resolved,
      client: harness.client,
      policy: harness.policy,
      scopes: ["profile"],
    }),
    refused,
  );
  assert.equal(harness.ports.inspect.handoffs().length, 0);
});

test("an oversized token answer to a device poll is not read, is indeterminate, and stores nothing", async (t) => {
  const harness = await authHarness(t, {
    configuration: { OAUTH_CLIENT_ID: "fixture-client" },
    server: deviceServer,
  });
  const record = await deviceHandoff(harness, harness.ctx());
  assert.ok(harness.server.approveDevice(record.private["userCode"]!));
  harness.advance(5_000);
  // The request went out, so the device code may be spent: the answer is
  // unknown, not a refusal, and a token that was never parsed is never kept.
  const outcome = await pollDeviceAuthorization(
    oversizing(harness.ctx(), (path) => path === "/token"),
    {
      handoff: record,
      server: harness.resolved,
      client: harness.client,
      policy: harness.policy,
    },
  );
  assert.equal(outcome.state, "indeterminate");
  assert.equal(outcome.code, "oauth.device.indeterminate");
  assert.equal(JSON.stringify(outcome).includes(MARKER), false);
  assert.equal(harness.ports.inspect.credentialRefs().length, 0);
});

test("an oversized key set is refused when a token exchange verifies with it", async (t) => {
  const RESOURCE = "https://downstream.example/api";
  const harness = await authHarness(t, {
    configuration: { OAUTH_CLIENT_ID: "fixture-client" },
    server: {
      tokenExchange: true,
      jwtAccessTokens: true,
      exchangeAudiences: [RESOURCE],
    },
    policy: {
      tokenExchange: {
        enabled: true,
        audiences: [RESOURCE],
        resources: [RESOURCE],
      },
    },
  });
  const port = hostAuthorizedTokenExchange(
    harness.policy,
    harness.resolved,
    harness.client,
  );
  const subjectToken = await harness.server.mintToken({
    subject: "user-1",
    audience: harness.client.client.client_id,
  });
  const ctx = oversizing(harness.ctx(), (path) => path === "/jwks");
  await assert.rejects(
    exchangeToken(ctx, port, {
      subjectToken,
      subjectTokenType: tokenTypeIdentifiers.accessToken,
      resource: RESOURCE,
      scope: credentialScopeFor(ctx, {
        connectionRef: harness.connection.connectionRef,
        bindingRef: harness.connection.bindingRef,
      }),
    }),
    refused,
  );
  assert.equal(harness.ports.inspect.credentialRefs().length, 0);
});

test("metadata discovery keeps its own, smaller ceiling and reads an oversized document as malformed", async (t) => {
  const harness = await authHarness(t, {
    configuration: { OAUTH_CLIENT_ID: "fixture-client" },
  });
  const outcome = await discoverAuthorizationServer(harness.server.issuer, {
    fetch: oversizingAt(fetch, (path) => path.startsWith("/.well-known/")),
    allowLoopbackHttp: true,
  });
  assert.equal(outcome.state, "unavailable");
  assert.equal(
    outcome.state === "unavailable" ? outcome.reason : undefined,
    "malformed",
  );
});
