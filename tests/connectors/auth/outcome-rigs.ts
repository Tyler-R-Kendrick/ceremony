import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import {
  acquireClientCredentials,
  beginAuthorizationCode,
  completeAuthorizationCode,
  credentialScopeFor,
  exchangeToken,
  hostAuthorizedTokenExchange,
  issueHandoff,
  issuerPolicy,
  MAX_RESPONSE_BYTES,
  OAUTH_CLIENT_CREDENTIALS_OPERATION,
  OAUTH_REFRESH_OPERATION,
  refreshAccessToken,
  resolveAuthorizationServer,
  resolveClientRegistration,
  ResponseTooLargeError,
  tokenTypeIdentifiers,
} from "../../../src/server/connectors/auth/index.js";
import { ConnectorError } from "../../../src/server/connectors/errors.js";
import type {
  AdapterCallContext,
  HandoffRecord,
} from "../../../src/server/connectors/index.js";
import type { CredentialScope } from "../../../src/server/connectors/ports.js";
import { startAuthorizationServer } from "../doubles/authorization-server.js";
import { fixtureActor, memoryPorts } from "../doubles/ports.js";
import {
  authHarness,
  CALLBACK_URI,
  HOST_ORIGIN,
  memoryRegistrationStore,
  type AuthHarness,
} from "./harness.js";

/*
 * Rigs that run one OAuth flow with one of its answers replaced: the token
 * endpoint of a refresh, a client-credentials grant, a registration, an
 * RFC 8693 exchange. The answer is a function so a test can serve a body over
 * the ceiling, one that never ends, or a failure, and compare what each came to.
 */

export const OVERSIZED = () =>
  new Response(JSON.stringify({ padding: "x".repeat(MAX_RESPONSE_BYTES) }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
export const SERVICE_UNAVAILABLE = () =>
  new Response("unavailable", { status: 503 });
export const DROPPED = () => {
  throw new TypeError("terminated");
};

/** The context, with the token endpoint answered by `answer` instead of the fixture. */
export function answering(
  ctx: AdapterCallContext,
  answer: () => Response,
  at: string = "/token",
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
        return url.pathname === at
          ? answer()
          : ctx.environment.fetch(input, init);
      },
    },
  };
}

export const describeFailure = (error: unknown) =>
  error instanceof ConnectorError
    ? { code: error.code, detail: error.detail }
    : { unexpected: String(error) };

export const journalOf = (harness: AuthHarness, operation: string) =>
  harness.ports.inspect
    .effects()
    .filter((entry) => entry.intent.operation === operation)
    .map((entry) => [entry.outcome?.status ?? "open", entry.outcome?.code]);

// ---------------------------------------------------------------- refresh

export async function signedIn(
  t: TestContext,
  options: {
    policy?: NonNullable<Parameters<typeof authHarness>[1]>["policy"];
  } = {},
) {
  const harness = await authHarness(t, {
    configuration: { OAUTH_CLIENT_ID: "fixture-client" },
    server: { openidConnect: true },
    ...(options.policy ? { policy: options.policy } : {}),
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

export async function refreshWith(t: TestContext, answer: () => Response) {
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

export const SECRET = "cc-secret-71e2";

export async function grantWith(
  t: TestContext,
  answer: () => Response,
  requestEncoding?: "json",
) {
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
      ...(requestEncoding ? { requestEncoding } : {}),
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

export async function registerWith(t: TestContext, answer: () => Response) {
  const server = await startAuthorizationServer({
    dynamicRegistration: true,
    redirectUris: [CALLBACK_URI],
  });
  t.after(() => server.close());
  const policy = issuerPolicy({
    issuer: server.issuer,
    allowLoopbackHttp: true,
    registration: { allowed: ["dynamic"] },
  });
  const resolved = await resolveAuthorizationServer(policy, {
    fetch: (input, init) => fetch(input, init),
  });
  const ports = memoryPorts();
  const oversize: typeof fetch = async (input, init) => {
    const url = new URL(
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.href
          : input.url,
    );
    return url.pathname === "/register" ? answer() : fetch(input, init);
  };
  const failure = await resolveClientRegistration({
    actor: fixtureActor,
    policy,
    server: resolved,
    redirectUri: CALLBACK_URI,
    hostOrigin: HOST_ORIGIN,
    configuration: ports.configuration,
    fetch: oversize,
    registrations: memoryRegistrationStore(),
    effects: ports.effects,
  }).then(
    () => undefined,
    (error: unknown) => error,
  );
  return {
    failure,
    effects: ports.inspect
      .effects()
      .map((entry) => [entry.outcome?.status, entry.outcome?.code]),
  };
}

const RESOURCE = "https://downstream.example/api";
const OPAQUE_GRANT = () =>
  Response.json({
    access_token: "at_dummy_marker_0123456789abcdef",
    issued_token_type: "urn:ietf:params:oauth:token-type:access_token",
    token_type: "Bearer",
    expires_in: 3600,
  });

/**
 * An RFC 8693 exchange whose token endpoint (or the endpoint `at`: the key
 * set, the introspection endpoint) is answered by `answer`. The issued token
 * is a JWT, verified against the key set, or opaque, verified by introspection.
 */
export async function exchangeWith(
  t: TestContext,
  answer: () => Response,
  at = "/token",
  accessTokens: "jwt" | "opaque" = "jwt",
) {
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
  // The fixture issues exchanged tokens as JWTs only; an opaque one is
  // stood in for at the token endpoint, so the issuer is asked about it.
  const base =
    accessTokens === "opaque"
      ? answering(harness.ctx(), OPAQUE_GRANT, "/token")
      : harness.ctx();
  const ctx = answering(base, answer, at);
  const failure = await exchangeToken(ctx, port, {
    subjectToken,
    subjectTokenType: tokenTypeIdentifiers.accessToken,
    resource: RESOURCE,
    scope: credentialScopeFor(ctx, {
      connectionRef: harness.connection.connectionRef,
      bindingRef: harness.connection.bindingRef,
    }),
  }).then(
    () => undefined,
    (error: unknown) => error,
  );
  return {
    failure,
    journal: journalOf(harness, "oauth.token.exchange").map(
      ([status]) => status,
    ),
    stored: harness.ports.inspect.credentialRefs().length,
  };
}
