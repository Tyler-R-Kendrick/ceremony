import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "node:crypto";
import {
  beginAuthorizationCode,
  completeAuthorizationCode,
  issueHandoff,
  issuerPolicy,
  resolveAuthorizationServer,
  resolveClientRegistration,
} from "../../../src/server/connectors/auth/index.js";
import { createMcpRegistryClient } from "../../../src/server/connectors/registries/mcp/index.js";
import {
  createNangoAdapter,
  NANGO_CONFIGURATION_NAMES,
} from "../../../src/server/connectors/providers/nango/index.js";
import type {
  AdapterCallContext,
  HandoffRecord,
} from "../../../src/server/connectors/index.js";
import { ConnectorError } from "../../../src/server/connectors/errors.js";
import { fixtureActor, memoryPorts } from "../doubles/ports.js";
import {
  CALLBACK_URI,
  HOST_ORIGIN,
  memoryRegistrationStore,
  testBinding,
  testConnection,
} from "../auth/harness.js";
import {
  activeConnection,
  CONNECTION_ID,
  INTEGRATION,
  makeBinding,
  makeConnection,
  readOperation,
  SECRET_KEY,
  ENVIRONMENT,
} from "../nango/harness.js";
import {
  createS256,
  startNangoContract,
  startOauthContract,
  startRegistryContract,
} from "./doubles/pinned.js";

/*
 * QA-01. Independent protocol doubles, written from the pinned documented
 * contracts, driving the real adapters.
 *
 * Two obligations are discharged here. First, each adapter's outgoing request
 * is validated against the documentation by a server that shares no code with
 * it: the doubles in `doubles/pinned.ts` import no product module. Second,
 * each double is proved to be unforgiving — a deliberately wrong request is
 * refused with the provider's documented error variant and recorded as a
 * violation, so a passing conformance test cannot be explained by a lenient
 * fixture.
 *
 * Pinned profiles: nango-http-api-2026-09, mcp-registry-v0.1,
 * rfc6749+rfc7636+rfc8414+rfc9207 authorization server.
 */

/* ------------------------------------------------------------- QA-01 Nango */

async function nangoAgainstContract(
  options: Parameters<typeof startNangoContract>[0] = {
    secretKey: SECRET_KEY,
    integrations: [INTEGRATION],
    connections: { [INTEGRATION]: [CONNECTION_ID] },
  },
) {
  const double = await startNangoContract(options);
  const ports = memoryPorts();
  ports.configuration.set(NANGO_CONFIGURATION_NAMES.secretKey, SECRET_KEY);
  ports.configuration.set(NANGO_CONFIGURATION_NAMES.environment, ENVIRONMENT);
  const binding = makeBinding({ apiOrigin: double.origin });
  const adapter = createNangoAdapter({});
  const context = (connection?: Awaited<ReturnType<typeof activeConnection>>) =>
    ({
      actor: fixtureActor,
      binding,
      ...(connection ? { connection } : {}),
      generation: connection?.generation ?? 0,
      signal: new AbortController().signal,
      environment: ports.environment({ fetch }),
    }) as AdapterCallContext;
  return { double, ports, binding, adapter, context };
}

test("QA-01/AC-NG-01: the Nango connect session matches the documented request exactly", async (t) => {
  const h = await nangoAgainstContract();
  t.after(() => h.double.close());

  const start = await h.adapter.authorize!(
    h.context(makeConnection(h.binding) as never),
    {
      ownerKind: "user",
      requestedPermissions: ["repo"],
      accountSwitch: false,
      interruption: "allowed",
    },
  );

  assert.equal(start.kind, "handoff");
  assert.deepEqual(
    h.double.violations,
    [],
    "the independent contract server found nothing wrong with the request",
  );
  const session = h.double.sessions[0];
  assert.ok(session, "the double issued exactly one connect session");
  assert.equal(session.kind, "connect");
  assert.deepEqual(session.body.allowed_integrations, [INTEGRATION]);
  assert.equal(session.body.end_user, undefined);
  assert.equal(session.body.organization, undefined);
  assert.equal(session.body.webhook_url_override, undefined);

  const recorded = h.double.requests.at(-1)!;
  assert.equal(recorded.method, "POST");
  assert.equal(recorded.url.pathname, "/connect/sessions");
  assert.equal(recorded.headers.authorization, `Bearer ${SECRET_KEY}`);
  assert.match(recorded.headers["content-type"] ?? "", /^application\/json/);
  if (start.kind === "handoff")
    assert.equal(start.handoff.private["token"], session.token);
});

test("QA-01: the Nango contract double refuses every wrong request instead of accommodating it", async (t) => {
  const double = await startNangoContract({
    secretKey: SECRET_KEY,
    integrations: [INTEGRATION],
    connections: { [INTEGRATION]: [CONNECTION_ID] },
  });
  t.after(() => double.close());
  const body = {
    allowed_integrations: [INTEGRATION],
    tags: { "ceremony.connection": "c" },
  };
  const post = (init: RequestInit, path = "/connect/sessions") =>
    fetch(`${double.origin}${path}`, { method: "POST", ...init });

  const cases: Array<{
    code: string;
    status: number;
    run(): Promise<Response>;
  }> = [
    {
      code: "nango.auth.missing-bearer",
      status: 401,
      run: () =>
        post({
          headers: {
            accept: "application/json",
            "content-type": "application/json",
          },
          body: JSON.stringify(body),
        }),
    },
    {
      code: "nango.auth.wrong-secret",
      status: 401,
      run: () =>
        post({
          headers: {
            authorization: "Bearer not-the-secret",
            accept: "application/json",
            "content-type": "application/json",
          },
          body: JSON.stringify(body),
        }),
    },
    {
      code: "nango.headers.accept",
      status: 400,
      run: () =>
        post({
          headers: {
            authorization: `Bearer ${SECRET_KEY}`,
            accept: "text/html",
            "content-type": "application/json",
          },
          body: JSON.stringify(body),
        }),
    },
    {
      code: "nango.sessions.content-type",
      status: 400,
      run: () =>
        post({
          headers: {
            authorization: `Bearer ${SECRET_KEY}`,
            accept: "application/json",
            "content-type": "text/plain",
          },
          body: JSON.stringify(body),
        }),
    },
    {
      code: "nango.sessions.deprecated-inputs",
      status: 400,
      run: () =>
        post({
          headers: {
            authorization: `Bearer ${SECRET_KEY}`,
            accept: "application/json",
            "content-type": "application/json",
          },
          body: JSON.stringify({ ...body, end_user: { id: "u" } }),
        }),
    },
    {
      code: "nango.sessions.unrestricted",
      status: 400,
      run: () =>
        post({
          headers: {
            authorization: `Bearer ${SECRET_KEY}`,
            accept: "application/json",
            "content-type": "application/json",
          },
          body: JSON.stringify({ ...body, allowed_integrations: [] }),
        }),
    },
    {
      code: "nango.sessions.unknown-integration",
      status: 404,
      run: () =>
        post({
          headers: {
            authorization: `Bearer ${SECRET_KEY}`,
            accept: "application/json",
            "content-type": "application/json",
          },
          body: JSON.stringify({
            ...body,
            allowed_integrations: ["not-approved"],
          }),
        }),
    },
    {
      code: "nango.sessions.webhook-override",
      status: 400,
      run: () =>
        post({
          headers: {
            authorization: `Bearer ${SECRET_KEY}`,
            accept: "application/json",
            "content-type": "application/json",
          },
          body: JSON.stringify({
            ...body,
            webhook_url_override: "https://attacker.example/hook",
          }),
        }),
    },
    {
      code: "nango.connection.provider-config-key",
      status: 400,
      run: () =>
        fetch(`${double.origin}/connections/${CONNECTION_ID}`, {
          headers: {
            authorization: `Bearer ${SECRET_KEY}`,
            accept: "application/json",
          },
        }),
    },
  ];

  for (const entry of cases) {
    const response = await entry.run();
    assert.equal(
      response.status,
      entry.status,
      `${entry.code} must answer the documented status`,
    );
    await response.json();
    assert.ok(
      double.violations.some((violation) => violation.code === entry.code),
      `${entry.code} must be recorded as a contract violation`,
    );
  }
  assert.equal(
    double.sessions.length,
    0,
    "no wrong request produced a session",
  );
});

test("QA-01/AC-NG-03: verification reads the correlated list, never a credential-bearing route", async (t) => {
  const h = await nangoAgainstContract();
  t.after(() => h.double.close());
  const connection = await activeConnection(h.ports, h.binding);

  const verified = await h.adapter.verify!(h.context(connection));
  assert.deepEqual(h.double.violations, []);

  const list = h.double.requests.filter(
    (request) => request.url.pathname === "/connections",
  );
  assert.ok(list.length >= 1, "verification read the connection list");
  const query = list.at(-1)!.url.searchParams;
  assert.ok(
    query.get("connectionId") === CONNECTION_ID ||
      [...query.keys()].some((key) => key.startsWith("tags[")),
    "the list is narrowed by the native connection id or the host-derived tags",
  );
  assert.equal(list.at(-1)!.headers.authorization, `Bearer ${SECRET_KEY}`);
  assert.equal(
    h.double.requests.some((request) =>
      /^\/connections\/[^/]+$/.test(request.url.pathname),
    ),
    false,
    "the credential-returning single-connection route is not used to verify",
  );

  const serialized = JSON.stringify(verified);
  for (const canary of ["CONTRACT_ACCESS_TOKEN", "CONTRACT_REFRESH_TOKEN"])
    assert.equal(
      serialized.includes(canary),
      false,
      `${canary} must not leave the adapter in a verification result`,
    );
});

test("QA-01/AC-STATE-06: a documented 429 with Retry-After becomes a bounded connector error", async (t) => {
  const h = await nangoAgainstContract({
    secretKey: SECRET_KEY,
    integrations: [INTEGRATION],
    connections: { [INTEGRATION]: [CONNECTION_ID] },
    rateLimitAt: { path: "/connect/sessions", nth: 1, retryAfterSeconds: 42 },
  });
  t.after(() => h.double.close());

  await assert.rejects(
    () =>
      h.adapter.authorize!(h.context(makeConnection(h.binding) as never), {
        ownerKind: "user",
        requestedPermissions: ["repo"],
        accountSwitch: false,
        interruption: "allowed",
      }),
    (error: unknown) => {
      assert.ok(error instanceof ConnectorError, "a typed connector error");
      assert.equal(error.code, "rate-limited");
      return true;
    },
  );
  assert.deepEqual(
    h.double.violations,
    [],
    "the request itself was well formed; only the provider throttled it",
  );
});

test("QA-01/AC-NG-06: an operation outside the binding never reaches the provider", async (t) => {
  const h = await nangoAgainstContract();
  t.after(() => h.double.close());
  const connection = await activeConnection(h.ports, h.binding);
  const before = h.double.requests.length;

  await assert.rejects(
    () =>
      h.adapter.invoke!(h.context(connection), {
        operationRef: "github.repo.delete",
        input: {},
        commandId: "cmd-unapproved",
      }),
    (error: unknown) => error instanceof ConnectorError,
  );
  assert.equal(
    h.double.requests.length,
    before,
    "no request was sent for an unapproved operation",
  );

  // The approved read does reach the proxy, with the documented routing headers.
  await h.adapter.invoke!(h.context(connection), {
    operationRef: readOperation.operationRef,
    input: {},
    commandId: "cmd-approved",
  });
  assert.deepEqual(h.double.violations, []);
  assert.ok(h.double.proxied.length >= 1, "the approved read was proxied");
});

/* ---------------------------------------------------- QA-01 MCP registry */

const REGISTRY_ENTRIES = [
  {
    server: {
      $schema:
        "https://static.modelcontextprotocol.io/schemas/2025-09-29/server.schema.json",
      name: "io.example/alpha",
      description: "Alpha server used by the contract double.",
      version: "1.0.0",
      remotes: [{ type: "streamable-http", url: "https://alpha.example/mcp" }],
    },
  },
  {
    server: {
      $schema:
        "https://static.modelcontextprotocol.io/schemas/2025-09-29/server.schema.json",
      name: "io.example/beta",
      description: "Beta server used by the contract double.",
      version: "2026-09-01",
      remotes: [{ type: "streamable-http", url: "https://beta.example/mcp" }],
    },
  },
  {
    server: {
      $schema:
        "https://static.modelcontextprotocol.io/schemas/2025-09-29/server.schema.json",
      name: "io.example/gamma",
      description: "Gamma server withdrawn by its publisher.",
      version: "0.9.0",
      remotes: [{ type: "streamable-http", url: "https://gamma.example/mcp" }],
    },
    status: "deleted" as const,
  },
];

test("QA-01/AC-MCP-07: the registry client follows documented cursor pagination", async (t) => {
  const double = await startRegistryContract({
    entries: REGISTRY_ENTRIES,
    pageSize: 1,
  });
  t.after(() => double.close());
  const client = createMcpRegistryClient({ baseUrl: double.origin, fetch });

  const all = await client.listAll({ limit: 1 });
  assert.deepEqual(double.violations, []);
  assert.equal(all.complete, true);
  const names = all.pages.flatMap((page) =>
    page.entries.map((entry) => entry.identity.nativeId),
  );
  assert.deepEqual(
    names,
    ["io.example/alpha", "io.example/beta"],
    "tombstoned entries are excluded until they are asked for",
  );
  assert.ok(
    double.listRequests >= 2,
    "more than one page was actually fetched",
  );
  for (const request of double.requests)
    assert.equal(request.url.pathname.startsWith("/v0.1/"), true);
});

test("QA-01/AC-MCP-07: an unrecognized continuation marker truncates a listing silently", async (t) => {
  // The client reads `metadata.nextCursor`. This double serves the snake_case
  // spelling that the registry's REST examples also use. Offline this host
  // cannot settle which spelling the service emits, so the test records the
  // consequence rather than asserting a winner: the page is reported complete
  // while an entry is missing. If upstream is snake_case, this is the
  // partial-refresh corruption AC-MCP-07 exists to prevent.
  const double = await startRegistryContract({
    entries: REGISTRY_ENTRIES,
    pageSize: 1,
    cursorField: "next_cursor",
  });
  t.after(() => double.close());
  const client = createMcpRegistryClient({ baseUrl: double.origin, fetch });

  const all = await client.listAll({ limit: 1 });
  assert.deepEqual(double.violations, []);
  assert.equal(double.listRequests, 1, "no continuation was attempted");
  assert.deepEqual(
    all.pages.flatMap((page) =>
      page.entries.map((entry) => entry.identity.nativeId),
    ),
    ["io.example/alpha"],
    "one of the two live entries is missing",
  );
  assert.equal(
    all.complete,
    true,
    "and the truncated listing still reports itself complete",
  );
});

test("QA-01/AC-MCP-07: a tombstone is a status, not a disappearance", async (t) => {
  const double = await startRegistryContract({
    entries: REGISTRY_ENTRIES,
    pageSize: 10,
  });
  t.after(() => double.close());
  const client = createMcpRegistryClient({ baseUrl: double.origin, fetch });

  const page = await client.list({ includeDeleted: true });
  assert.deepEqual(double.violations, []);
  const gamma = page.entries.find(
    (entry) => entry.identity.nativeId === "io.example/gamma",
  );
  assert.ok(gamma, "the withdrawn entry is still returned");
  assert.equal(gamma.status, "deleted");
  const request = double.requests.at(-1)!;
  assert.equal(request.url.searchParams.get("include_deleted"), "true");
});

test("QA-01/AC-IMP-03: a hierarchical server name is percent-encoded exactly once", async (t) => {
  const double = await startRegistryContract({
    entries: REGISTRY_ENTRIES,
    pageSize: 10,
  });
  t.after(() => double.close());
  const client = createMcpRegistryClient({ baseUrl: double.origin, fetch });

  const versions = await client.versions("io.example/alpha");
  assert.deepEqual(
    double.violations,
    [],
    "the double rejects a double-encoded name; none was sent",
  );
  assert.equal(versions.entries.length, 1);
  const request = double.requests.at(-1)!;
  assert.equal(
    request.url.pathname,
    "/v0.1/servers/io.example%2Falpha/versions",
  );
});

test("QA-01/AC-STATE-06: a registry outage is reported, never papered over", async (t) => {
  const double = await startRegistryContract({
    entries: REGISTRY_ENTRIES,
    pageSize: 10,
    outageAt: 1,
  });
  t.after(() => double.close());
  const client = createMcpRegistryClient({ baseUrl: double.origin, fetch });

  await assert.rejects(
    () => client.list({}),
    (error: unknown) => error instanceof ConnectorError,
  );
  assert.deepEqual(double.violations, []);
});

test("QA-01: the registry contract double refuses wrong requests", async (t) => {
  const double = await startRegistryContract({
    entries: REGISTRY_ENTRIES,
    readToken: "registry-token",
  });
  t.after(() => double.close());

  const wrongVersion = await fetch(`${double.origin}/v1/servers`, {
    headers: { accept: "application/json" },
  });
  assert.equal(wrongVersion.status, 404);
  const noToken = await fetch(`${double.origin}/v0.1/servers`, {
    headers: { accept: "application/json" },
  });
  assert.equal(noToken.status, 401);
  const wrongMethod = await fetch(`${double.origin}/v0.1/servers`, {
    method: "POST",
    headers: {
      accept: "application/json",
      authorization: "Bearer registry-token",
    },
  });
  assert.equal(wrongMethod.status, 405);
  const badCursor = await fetch(
    `${double.origin}/v0.1/servers?cursor=not-a-boundary`,
    {
      headers: {
        accept: "application/json",
        authorization: "Bearer registry-token",
      },
    },
  );
  assert.equal(badCursor.status, 400);
  const doubleEncoded = await fetch(
    `${double.origin}/v0.1/servers/io.example%252Falpha/versions`,
    {
      headers: {
        accept: "application/json",
        authorization: "Bearer registry-token",
      },
    },
  );
  assert.equal(doubleEncoded.status, 400);

  assert.deepEqual(
    double.violations.map((violation) => violation.code).sort(),
    [
      "registry.api-version",
      "registry.auth",
      "registry.cursor",
      "registry.method",
      "registry.name-encoding",
    ],
    "every wrong request was recorded, none was accommodated",
  );
});

/* ------------------------------------------- QA-01 authorization server */

async function oauthAgainstContract(
  t: import("node:test").TestContext,
  options: Partial<Parameters<typeof startOauthContract>[0]> = {},
) {
  const server = await startOauthContract({
    clientId: "contract-client",
    redirectUris: [CALLBACK_URI],
    scopesGranted: ["read:things", "write:things"],
    ...options,
  });
  t.after(() => server.close());
  const ports = memoryPorts();
  ports.configuration.set("OAUTH_CLIENT_ID", "contract-client");
  const policy = issuerPolicy({
    issuer: server.issuer,
    allowLoopbackHttp: true,
    registration: {
      allowed: ["pre-registered"],
      clientIdConfiguration: "OAUTH_CLIENT_ID",
    },
  });
  const resolved = await resolveAuthorizationServer(policy, { fetch });
  const registrations = memoryRegistrationStore();
  const client = await resolveClientRegistration({
    actor: fixtureActor,
    policy,
    server: resolved,
    redirectUri: CALLBACK_URI,
    hostOrigin: HOST_ORIGIN,
    configuration: ports.configuration,
    fetch,
    registrations,
    effects: ports.effects,
    now: Date.now,
  });
  const binding = testBinding({ settings: { oauth: policy } });
  const connection = testConnection();
  const ctx: AdapterCallContext = {
    actor: fixtureActor,
    binding,
    connection,
    generation: 0,
    signal: new AbortController().signal,
    environment: ports.environment({ fetch, origin: HOST_ORIGIN }),
  };
  return { server, ports, policy, resolved, client, ctx };
}

async function begin(h: Awaited<ReturnType<typeof oauthAgainstContract>>) {
  const start = await beginAuthorizationCode(h.ctx, {
    server: h.resolved,
    client: h.client,
    policy: h.policy,
    scopes: ["read:things", "write:things"],
  });
  assert.equal(start.kind, "handoff");
  if (start.kind !== "handoff") throw new Error("unreachable");
  const issued = await issueHandoff(h.ctx, start.handoff);
  const record = h.ports.inspect
    .handoffs()
    .find((item) => item.handoffRef === issued.handoffRef) as HandoffRecord;
  assert.ok(record);
  return { start, record };
}

/** Drives the authorization endpoint the way a browser would and returns the callback. */
async function followAuthorization(url: string): Promise<URL> {
  const response = await fetch(url, { redirect: "manual" });
  const location = response.headers.get("location");
  await response.body?.cancel().catch(() => {});
  assert.ok(location, "the contract server issued a redirect");
  return new URL(location);
}

test("QA-01/AC-AUTH-03: the code exchange satisfies RFC 7636 against an independent server", async (t) => {
  const h = await oauthAgainstContract(t);
  const { record } = await begin(h);
  const authorizationUrl = record.private["authorizationUrl"]!;

  // The challenge really is the digest of the verifier this run generated.
  const url = new URL(authorizationUrl);
  assert.equal(
    url.searchParams.get("code_challenge"),
    createS256(record.private["verifier"]!),
  );

  const callback = await followAuthorization(authorizationUrl);
  const result = await completeAuthorizationCode(h.ctx, {
    url: callback,
    handoff: record,
    server: h.resolved,
    client: h.client,
    policy: h.policy,
  });

  assert.equal(result.state, "complete");
  assert.deepEqual(
    h.server.violations,
    [],
    "no request violated the pinned OAuth contract",
  );
  assert.equal(h.server.redemptions.length, 1, "the code was redeemed once");
  const tokenRequest = h.server.requests.find(
    (request) => request.url.pathname === "/token",
  )!;
  assert.match(
    tokenRequest.headers["content-type"] ?? "",
    /^application\/x-www-form-urlencoded/,
  );
  assert.equal(tokenRequest.method, "POST");
});

test("QA-01/AC-AUTH-06: a replayed authorization code is refused by both sides", async (t) => {
  const h = await oauthAgainstContract(t);
  const { record } = await begin(h);
  const callback = await followAuthorization(
    record.private["authorizationUrl"]!,
  );

  const first = await completeAuthorizationCode(h.ctx, {
    url: callback,
    handoff: record,
    server: h.resolved,
    client: h.client,
    policy: h.policy,
  });
  assert.equal(first.state, "complete");

  await assert.rejects(
    () =>
      completeAuthorizationCode(h.ctx, {
        url: callback,
        handoff: record,
        server: h.resolved,
        client: h.client,
        policy: h.policy,
      }),
    (error: unknown) => error instanceof ConnectorError,
    "the one-use handoff refuses the replay before the network",
  );
  assert.equal(
    h.server.redemptions.length,
    1,
    "the provider never saw the code a second time",
  );
});

test("QA-01: the OAuth contract double refuses wrong requests", async (t) => {
  const h = await oauthAgainstContract(t);
  const verifier = "a".repeat(43);
  const challenge = createS256(verifier);
  const state = "s".repeat(32);
  const authorize = (extra: Record<string, string> = {}) => {
    const url = new URL(`${h.server.origin}/authorize`);
    for (const [name, value] of Object.entries({
      response_type: "code",
      client_id: "contract-client",
      redirect_uri: CALLBACK_URI,
      state,
      code_challenge: challenge,
      code_challenge_method: "S256",
      ...extra,
    }))
      url.searchParams.set(name, value);
    return fetch(url, { redirect: "manual" });
  };

  const plain = await authorize({
    code_challenge_method: "plain",
    code_challenge: verifier,
  });
  await plain.body?.cancel().catch(() => {});
  assert.equal(plain.status, 400, "a plain PKCE challenge is refused");

  const shortChallenge = await authorize({ code_challenge: "too-short" });
  await shortChallenge.body?.cancel().catch(() => {});
  assert.equal(
    shortChallenge.status,
    400,
    "a challenge that is not a base64url digest is refused",
  );

  const strangerRedirect = await authorize({
    redirect_uri: "https://attacker.example/cb",
  });
  await strangerRedirect.body?.cancel().catch(() => {});
  assert.equal(strangerRedirect.status, 400);

  const wrongClient = await authorize({ client_id: "someone-else" });
  await wrongClient.body?.cancel().catch(() => {});
  assert.equal(wrongClient.status, 400);

  const getToken = await fetch(`${h.server.origin}/token`);
  await getToken.json();
  assert.equal(getToken.status, 405, "the token endpoint is POST only");

  const jsonToken = await fetch(`${h.server.origin}/token`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ grant_type: "authorization_code" }),
  });
  await jsonToken.json();
  assert.equal(jsonToken.status, 400, "a JSON token request is refused");

  assert.deepEqual(
    [...new Set(h.server.violations.map((violation) => violation.code))].sort(),
    [
      "oauth.authorize.client-id",
      "oauth.authorize.pkce-challenge",
      "oauth.authorize.pkce-method",
      "oauth.authorize.redirect-uri",
      "oauth.token.encoding",
      "oauth.token.method",
    ],
    "every wrong request was recorded, none was accommodated",
  );
  assert.equal(h.server.authorizations.length, 0, "no code was ever issued");
});

test("QA-01: a mismatched verifier is rejected by the contract server", async (t) => {
  const h = await oauthAgainstContract(t);
  const verifier = "v".repeat(43);
  const state = "s".repeat(32);
  const url = new URL(`${h.server.origin}/authorize`);
  for (const [name, value] of Object.entries({
    response_type: "code",
    client_id: "contract-client",
    redirect_uri: CALLBACK_URI,
    state,
    code_challenge: createS256(verifier),
    code_challenge_method: "S256",
  }))
    url.searchParams.set(name, value);
  const redirect = await fetch(url, { redirect: "manual" });
  await redirect.body?.cancel().catch(() => {});
  const code = new URL(redirect.headers.get("location")!).searchParams.get(
    "code",
  )!;

  const response = await fetch(`${h.server.origin}/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code,
      client_id: "contract-client",
      redirect_uri: CALLBACK_URI,
      code_verifier: "w".repeat(43),
    }),
  });
  const payload = (await response.json()) as { error: string };
  assert.equal(response.status, 400);
  assert.equal(payload.error, "invalid_grant");
  assert.ok(
    h.server.violations.some(
      (violation) => violation.code === "oauth.token.verifier-mismatch",
    ),
  );
  // Independently: the digest really is what RFC 7636 says it is.
  assert.equal(
    createS256(verifier),
    createHash("sha256").update(verifier, "ascii").digest("base64url"),
  );
});
