import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import {
  acquireClientCredentials,
  beginAuthorizationCode,
  completeAuthorizationCode,
  credentialScopeFor,
  issueHandoff,
  MAX_RESPONSE_BYTES,
  OAUTH_CLIENT_CREDENTIALS_OPERATION,
  OAUTH_REFRESH_OPERATION,
  refreshAccessToken,
  ResponseTooLargeError,
} from "../../../src/server/connectors/auth/index.js";
import { ConnectorError } from "../../../src/server/connectors/errors.js";
import type {
  AdapterCallContext,
  HandoffRecord,
} from "../../../src/server/connectors/index.js";
import type { CredentialScope } from "../../../src/server/connectors/ports.js";
import { authHarness, type AuthHarness } from "./harness.js";

/*
 * An answer too large to read is not a refusal: the request was sent, a
 * single-use refresh token may have been spent and a token may have been
 * minted. Where the engine journals the attempt, it is journaled the way a
 * lost answer is (indeterminate), and the caller is told so with the same
 * code. Each case is held to a baseline that is already right: a 5xx on a
 * refresh, a connection dropped after the request on a client-credentials
 * grant.
 */

const OVERSIZED = () =>
  new Response(JSON.stringify({ padding: "x".repeat(MAX_RESPONSE_BYTES) }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
const SERVICE_UNAVAILABLE = () => new Response("unavailable", { status: 503 });
const DROPPED = () => {
  throw new TypeError("terminated");
};

/** The context, with the token endpoint answered by `answer` instead of the fixture. */
function answering(
  ctx: AdapterCallContext,
  answer: () => Response,
): AdapterCallContext {
  return {
    ...ctx,
    environment: {
      ...ctx.environment,
      fetch: async (input, init) => {
        const url = new URL(
          typeof input === "string"
            ? input
            : input instanceof URL
              ? input.href
              : input.url,
        );
        return url.pathname === "/token"
          ? answer()
          : ctx.environment.fetch(input, init);
      },
    },
  };
}

const describeFailure = (error: unknown) =>
  error instanceof ConnectorError
    ? { code: error.code, detail: error.detail }
    : { unexpected: String(error) };

const journalOf = (harness: AuthHarness, operation: string) =>
  harness.ports.inspect
    .effects()
    .filter((entry) => entry.intent.operation === operation)
    .map((entry) => [entry.outcome?.status ?? "open", entry.outcome?.code]);

// ---------------------------------------------------------------- refresh

async function signedIn(t: TestContext) {
  const harness = await authHarness(t, {
    configuration: { OAUTH_CLIENT_ID: "fixture-client" },
    server: { openidConnect: true },
  });
  const ctx = harness.ctx();
  const start = await beginAuthorizationCode(ctx, {
    server: harness.resolved,
    client: harness.client,
    policy: harness.policy,
    scopes: ["openid", "profile"],
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
  const completed = await completeAuthorizationCode(ctx, {
    url: new URL(callback),
    handoff: record,
    server: harness.resolved,
    client: harness.client,
    policy: harness.policy,
  });
  return {
    harness,
    ctx,
    credentialRef: completed.credentialRef!,
    scope: credentialScopeFor(ctx, record),
  };
}

async function refreshWith(t: TestContext, answer: () => Response) {
  const { harness, ctx, credentialRef, scope } = await signedIn(t);
  const input = {
    server: harness.resolved,
    client: harness.client,
    policy: harness.policy,
    credentialRef,
    scope,
  };
  const failure = await refreshAccessToken(answering(ctx, answer), input).then(
    () => undefined,
    (error: unknown) => error,
  );
  // The same refresh token is never presented again after an answer was lost.
  const again = await refreshAccessToken(ctx, input).then(
    () => undefined,
    (error: unknown) => error,
  );
  return {
    failure,
    first: describeFailure(failure),
    second: describeFailure(again),
    journal: journalOf(harness, OAUTH_REFRESH_OPERATION),
    tokenRequests: harness.server.tokenRequests.length,
  };
}

test("a refresh answer too large to read is journaled and reported exactly as a lost answer is", async (t) => {
  const baseline = await refreshWith(t, SERVICE_UNAVAILABLE);
  assert.deepEqual(baseline.first, {
    code: "indeterminate",
    detail: "oauth.refresh.indeterminate",
  });
  assert.deepEqual(baseline.journal, [
    ["indeterminate", "oauth.refresh.indeterminate"],
  ]);

  const oversized = await refreshWith(t, OVERSIZED);

  assert.deepEqual(oversized.first, baseline.first);
  assert.deepEqual(oversized.journal, baseline.journal);
  assert.deepEqual(oversized.second, baseline.second);
  assert.ok(
    oversized.failure instanceof ConnectorError &&
      oversized.failure.cause instanceof ResponseTooLargeError,
    "the cause says what was too large, and holds none of it",
  );
  assert.equal(
    oversized.tokenRequests,
    baseline.tokenRequests,
    "the refresh token was not presented a second time",
  );
});

// ------------------------------------------------------- client credentials

const SECRET = "cc-secret-71e2";

async function grantWith(t: TestContext, answer: () => Response) {
  const harness = await authHarness(t, {
    server: { clientCredentials: true, clientSecret: SECRET },
    configuration: {
      OAUTH_CLIENT_ID: "fixture-client",
      OAUTH_CLIENT_SECRET: SECRET,
    },
    policy: {
      registration: {
        allowed: ["pre-registered"],
        clientIdConfiguration: "OAUTH_CLIENT_ID",
        clientSecretConfiguration: "OAUTH_CLIENT_SECRET",
      },
    },
  });
  const connection = harness.connection;
  const scope: CredentialScope = {
    tenantId: connection.tenantId,
    ownerKind: connection.ownerKind,
    ownerId: connection.ownerId,
    connectionRef: connection.connectionRef,
    bindingRef: connection.bindingRef,
    custody: connection.custody,
  };
  const failure = await acquireClientCredentials(
    answering(harness.ctx(), answer),
    {
      server: harness.resolved,
      client: harness.client,
      policy: harness.policy,
      scopes: ["profile"],
      scope,
    },
  ).then(
    () => undefined,
    (error: unknown) => error,
  );
  return {
    failure,
    described: describeFailure(failure),
    journal: journalOf(harness, OAUTH_CLIENT_CREDENTIALS_OPERATION),
    stored: harness.ports.inspect.credentialRefs().length,
  };
}

test("a client-credentials answer too large to read is journaled and reported exactly as a lost answer is", async (t) => {
  const baseline = await grantWith(t, DROPPED);
  assert.deepEqual(baseline.described, {
    code: "indeterminate",
    detail: "oauth.client-credentials.indeterminate",
  });
  assert.deepEqual(baseline.journal, [
    ["indeterminate", "oauth.client-credentials.indeterminate"],
  ]);

  const oversized = await grantWith(t, OVERSIZED);

  assert.deepEqual(oversized.described, baseline.described);
  assert.deepEqual(oversized.journal, baseline.journal);
  assert.equal(
    oversized.stored,
    0,
    "a token that was never parsed is not kept",
  );
  assert.ok(
    oversized.failure instanceof ConnectorError &&
      oversized.failure.cause instanceof ResponseTooLargeError,
  );
});
