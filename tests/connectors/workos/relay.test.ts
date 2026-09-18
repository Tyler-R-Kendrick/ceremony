import assert from "node:assert/strict";
import test from "node:test";
import { ConnectorError } from "../../../src/server/connectors/errors.js";
import { createWorkOsPipesAdapter } from "../../../src/server/connectors/providers/workos/index.js";
import { startWorkOsPipesDouble } from "../doubles/workos-pipes.js";
import { canaries } from "../fixtures/builders.js";
import {
  API_KEY,
  ORGANIZATION_ID,
  PROVIDER,
  USER_ID,
  connectionRecord,
  defaultPrincipals,
  harness,
  principalPort,
  relayBinding,
} from "./support.js";

/*
 * IB-02, relay mode: WorkOS makes the provider call. The request is the one
 * the bound operation describes, the credential never enters this process, and
 * the documented 402 becomes private human participation (AC-EXT-05).
 */

const connected = {
  provider: PROVIDER,
  userId: USER_ID,
  accessToken: "gho_relay_fixture_token",
  scopes: ["repo"],
  accountIdentifier: "octocat",
};

test("WorkOS relay forwards the bound request with the documented control headers", async () => {
  const workos = await startWorkOsPipesDouble({
    apiKey: API_KEY,
    knownUsers: [USER_ID],
    connections: [connected],
    upstream: ({ method, url, headers, injectedToken }) => ({
      status: 200,
      body: {
        method,
        path: url.pathname,
        query: url.search,
        // The relay injects the credential upstream; the caller never sees it.
        sawToken: Boolean(injectedToken),
        forwardedAuthorization: headers.authorization ?? null,
      },
    }),
  });
  const adapter = createWorkOsPipesAdapter({
    principals: principalPort(defaultPrincipals()),
  });
  const binding = relayBinding(workos.origin);
  const app = harness({ binding });
  const result = await adapter.invoke!(
    app.context({ connection: connectionRecord(binding) }),
    {
      operationRef: "operation:listRepositories",
      input: { query: { per_page: "5" } },
      commandId: "command:relay-1",
    },
  );

  assert.equal(result.state, "complete");
  const output = result.output as { status: number; body: Record<string, unknown> };
  assert.equal(output.status, 200);
  assert.equal(output.body.path, "/user/repos");
  assert.equal(output.body.sawToken, true);
  // The WorkOS API key authenticates the relay and is stripped before the
  // provider call; it is never forwarded upstream.
  assert.equal(output.body.forwardedAuthorization, null);

  const [relayed] = workos.received("GET", `/relay/${PROVIDER}/user/repos`);
  assert.ok(relayed);
  assert.equal(relayed.headers.authorization, `Bearer ${API_KEY}`);
  assert.equal(relayed.headers["x-relay-user"], USER_ID);
  assert.equal(relayed.headers["x-relay-provider"], PROVIDER);
  // No organization header for a user-scoped connection: the documented rule
  // is an exact match in both directions.
  assert.equal(relayed.headers["x-relay-organization"], undefined);
  assert.equal(relayed.url.searchParams.get("per_page"), "5");
  await workos.close();
});

test("WorkOS relay ignores caller-supplied hosts, headers and paths", async () => {
  const workos = await startWorkOsPipesDouble({
    apiKey: API_KEY,
    knownUsers: [USER_ID],
    connections: [connected],
    upstream: ({ url, headers }) => ({
      status: 200,
      body: { path: url.pathname, headerNames: Object.keys(headers).sort() },
    }),
  });
  const adapter = createWorkOsPipesAdapter({
    principals: principalPort(defaultPrincipals()),
  });
  const binding = relayBinding(workos.origin);
  const app = harness({ binding });
  const result = await adapter.invoke!(
    app.context({ connection: connectionRecord(binding) }),
    {
      operationRef: "operation:listRepositories",
      // Everything a confused-deputy caller might hope travels: rejected by
      // the input schema rather than quietly dropped.
      input: {
        url: "https://evil.example/exfiltrate",
        headers: { authorization: `Bearer ${canaries.token}` },
        host: "evil.example",
      },
      commandId: "command:relay-hostile",
    },
  ).then(
    (value) => value,
    (error: unknown) => error,
  );
  assert.ok(result instanceof ConnectorError);
  assert.equal(result.code, "invalid-request");
  assert.equal(result.detail, "workos.relay.input");
  assert.equal(workos.requests.length, 0);
  await workos.close();
});

test("WorkOS relay checks target parameters against the connection's permitted targets", async () => {
  const workos = await startWorkOsPipesDouble({
    apiKey: API_KEY,
    knownUsers: [USER_ID],
    connections: [connected],
    upstream: ({ url }) => ({ status: 201, body: { path: url.pathname } }),
  });
  const adapter = createWorkOsPipesAdapter({
    principals: principalPort(defaultPrincipals()),
  });
  const binding = relayBinding(workos.origin);
  const app = harness({ binding });
  const allowed = await adapter.invoke!(
    app.context({ connection: connectionRecord(binding) }),
    {
      operationRef: "operation:createIssue",
      input: {
        parameters: { owner: "acme", repository: "widgets" },
        body: { title: "x" },
      },
      commandId: "command:issue-1",
    },
  );
  assert.equal(allowed.state, "complete");
  assert.equal(
    (allowed.output as { body: Record<string, unknown> }).body.path,
    "/repos/acme/widgets/issues",
  );

  await assert.rejects(
    adapter.invoke!(app.context({ connection: connectionRecord(binding) }), {
      operationRef: "operation:createIssue",
      input: {
        parameters: { owner: "victim", repository: "private" },
        body: { title: "x" },
      },
      commandId: "command:issue-2",
    }),
    (error: unknown) =>
      error instanceof ConnectorError &&
      error.code === "denied" &&
      error.detail === "workos.target.not-permitted",
  );
  assert.equal(
    workos.requests.filter((request) =>
      request.url.pathname.includes("victim"),
    ).length,
    0,
  );
  await workos.close();
});

test("WorkOS AC-EXT-05: a relay 402 becomes a private authorization handoff, not a failure", async () => {
  const workos = await startWorkOsPipesDouble({
    apiKey: API_KEY,
    knownUsers: [USER_ID],
    connections: [],
  });
  const adapter = createWorkOsPipesAdapter({
    principals: principalPort(defaultPrincipals()),
  });
  const binding = relayBinding(workos.origin);
  const app = harness({ binding });
  const result = await adapter.invoke!(
    app.context({ connection: connectionRecord(binding) }),
    {
      operationRef: "operation:listRepositories",
      input: {},
      commandId: "command:402",
    },
  );
  assert.equal(result.state, "human-required");
  assert.equal(result.code, "workos.relay.authorization-required");
  assert.ok(result.handoff);
  assert.equal(result.handoff.kind, "provider-browser");
  assert.ok(String(result.handoff.private.url).startsWith(workos.origin));
  // Nothing was applied; the journal says so.
  const [effect] = app.ports.inspect.effects();
  assert.equal(effect?.outcome?.status, "not-applied");
  assert.equal(effect?.outcome?.code, "authorization-required");

  // An API-key connection has no authorization URL; the documented `null`
  // yields participation without inventing a link.
  const keyed = await startWorkOsPipesDouble({
    apiKey: API_KEY,
    knownUsers: [USER_ID],
    authorizationUrl: null,
  });
  const keyedBinding = relayBinding(keyed.origin);
  const keyedApp = harness({ binding: keyedBinding });
  const keyedResult = await adapter.invoke!(
    keyedApp.context({ connection: connectionRecord(keyedBinding) }),
    {
      operationRef: "operation:listRepositories",
      input: {},
      commandId: "command:402-null",
    },
  );
  assert.equal(keyedResult.state, "human-required");
  assert.equal(keyedResult.handoff, undefined);
  await workos.close();
  await keyed.close();
});

test("WorkOS relay organization scoping is an exact match in both directions", async () => {
  const workos = await startWorkOsPipesDouble({
    apiKey: API_KEY,
    knownUsers: [USER_ID],
    connections: [
      {
        ...connected,
        owner: "organization",
        organizationId: ORGANIZATION_ID,
      },
    ],
    upstream: () => ({ status: 200, body: { ok: true } }),
  });
  const adapter = createWorkOsPipesAdapter({
    principals: principalPort(defaultPrincipals()),
  });
  const binding = relayBinding(workos.origin);
  const app = harness({ binding });

  const organization = await adapter.invoke!(
    app.context({
      connection: connectionRecord(binding, {
        ownerKind: "organization",
        ownerId: ORGANIZATION_ID,
      }),
    }),
    {
      operationRef: "operation:listRepositories",
      input: {},
      commandId: "command:org",
    },
  );
  assert.equal(organization.state, "complete");
  const [relayed] = workos.received("GET", `/relay/${PROVIDER}/user/repos`);
  assert.equal(relayed!.headers["x-relay-organization"], ORGANIZATION_ID);

  // The same person acting for themselves must not reach the organization's
  // connection: the missing header is a 402, not a wider lookup.
  const personal = await adapter.invoke!(
    app.context({ connection: connectionRecord(binding) }),
    {
      operationRef: "operation:listRepositories",
      input: {},
      commandId: "command:user",
    },
  );
  assert.equal(personal.state, "human-required");
  assert.equal(personal.code, "workos.relay.authorization-required");
  await workos.close();
});

test("WorkOS relay maps documented relay error codes without echoing provider text", async () => {
  const workos = await startWorkOsPipesDouble({
    apiKey: API_KEY,
    knownUsers: [USER_ID],
    connections: [connected],
  });
  const adapter = createWorkOsPipesAdapter({
    principals: principalPort(defaultPrincipals()),
  });
  // A provider the environment has not enabled: path routing resolves no
  // connection, and an unknown user is the documented 400.
  const binding = relayBinding(workos.origin);
  const unknownUser = createWorkOsPipesAdapter({
    principals: principalPort({
      [`${binding.tenantId}|user|`]: {
        ownerId: "subject-1",
        userId: "user_01NOTINTHISENVIRONMENT",
      },
    }),
  });
  const app = harness({ binding });
  await assert.rejects(
    unknownUser.invoke!(app.context({ connection: connectionRecord(binding) }), {
      operationRef: "operation:listRepositories",
      input: {},
      commandId: "command:unknown-user",
    }),
    (error: unknown) =>
      error instanceof ConnectorError &&
      error.code === "invalid-request" &&
      error.detail === "workos.relay.rejected" &&
      // The public message is Ceremony's, never the relay's message field.
      error.message === "The request is not valid for this connector.",
  );

  // A rejected WorkOS API key is a policy failure for this deployment.
  const wrongKey = harness({
    binding,
    configuration: {
      WORKOS_API_KEY: "sk_wrong",
      WORKOS_CLIENT_ID: "client_01FIXTURE",
    },
  });
  await assert.rejects(
    adapter.invoke!(
      wrongKey.context({ connection: connectionRecord(binding) }),
      {
        operationRef: "operation:listRepositories",
        input: {},
        commandId: "command:bad-key",
      },
    ),
    (error: unknown) =>
      error instanceof ConnectorError && error.code === "denied",
  );
  await workos.close();
});

test("WorkOS relay passes a provider error through as a failure with its upstream status", async () => {
  const workos = await startWorkOsPipesDouble({
    apiKey: API_KEY,
    knownUsers: [USER_ID],
    connections: [connected],
    upstream: () => ({
      status: 404,
      body: { message: `Not Found ${canaries.providerMessage}` },
    }),
  });
  const adapter = createWorkOsPipesAdapter({
    principals: principalPort(defaultPrincipals()),
  });
  const binding = relayBinding(workos.origin);
  const app = harness({ binding });
  const result = await adapter.invoke!(
    app.context({ connection: connectionRecord(binding) }),
    {
      operationRef: "operation:listRepositories",
      input: {},
      commandId: "command:provider-404",
    },
  );
  // A provider 404 reached the provider: it is a failed operation, not an
  // unknown relay route, and the classification stays the operation's.
  assert.equal(result.state, "failed");
  assert.equal(result.code, "workos.relay.provider-error");
  assert.equal((result.output as { status: number }).status, 404);
  assert.equal(result.outputClassification, "personal");
  await workos.close();
});

test("WorkOS relay journals a write and refuses to replay it blindly", async () => {
  const workos = await startWorkOsPipesDouble({
    apiKey: API_KEY,
    knownUsers: [USER_ID],
    connections: [connected],
    upstream: () => ({ status: 201, body: { number: 1 } }),
  });
  const adapter = createWorkOsPipesAdapter({
    principals: principalPort(defaultPrincipals()),
  });
  const binding = relayBinding(workos.origin);
  const app = harness({ binding });
  const connection = connectionRecord(binding);
  const request = {
    operationRef: "operation:createIssue",
    input: {
        parameters: { owner: "acme", repository: "widgets" },
        body: { title: "x" },
      },
    commandId: "command:issue",
  };
  const first = await adapter.invoke!(app.context({ connection }), request);
  assert.equal(first.state, "complete");

  // The same call again is the same effect. A write with no replay evidence
  // is answered from the journal instead of being sent a second time.
  const second = await adapter.invoke!(app.context({ connection }), request);
  assert.equal(second.code, "workos.relay.replayed");
  assert.equal(second.effectRef, first.effectRef);
  assert.equal(
    workos.received("POST", "/relay/github/repos/acme/widgets/issues").length,
    1,
  );

  // A read is safe to make again.
  const read = {
    operationRef: "operation:listRepositories",
    input: {},
    commandId: "command:read",
  };
  await adapter.invoke!(app.context({ connection }), read);
  await adapter.invoke!(app.context({ connection }), read);
  assert.equal(workos.received("GET", "/relay/github/user/repos").length, 2);
  await workos.close();
});

test("WorkOS relay reports an interrupted write as indeterminate rather than failed", async () => {
  const workos = await startWorkOsPipesDouble({
    apiKey: API_KEY,
    knownUsers: [USER_ID],
    connections: [connected],
    upstream: () => ({ status: 201, body: { number: 1 } }),
  });
  const adapter = createWorkOsPipesAdapter({
    principals: principalPort(defaultPrincipals()),
    requestTimeoutMs: 5,
  });
  const binding = relayBinding(workos.origin);
  const app = harness({ binding });
  const context = app.context({ connection: connectionRecord(binding) });
  // Drop the response after the request is under way: the provider may
  // already have acted, so the outcome is uncertain, not a clean failure.
  const original = context.environment.fetch;
  context.environment.fetch = (async (
    input: RequestInfo | URL,
    init?: RequestInit,
  ) => {
    const response = await original(input, init);
    // The request reached WorkOS and the provider may have acted; the answer
    // is what gets lost.
    await response.body?.cancel();
    throw new TypeError("connection reset");
  }) as typeof fetch;
  const result = await adapter.invoke!(context, {
    operationRef: "operation:createIssue",
    input: {
        parameters: { owner: "acme", repository: "widgets" },
        body: { title: "x" },
      },
    commandId: "command:dropped",
  });
  assert.equal(result.state, "indeterminate");
  assert.equal(result.code, "workos.relay.uncertain");
  const [effect] = app.ports.inspect.effects();
  assert.equal(effect?.outcome?.status, "indeterminate");
  await workos.close();
});

test("WorkOS relay URL routing stays inside the host-approved upstream origin", async () => {
  const workos = await startWorkOsPipesDouble({
    apiKey: API_KEY,
    knownUsers: [USER_ID],
    connections: [connected],
    upstream: ({ url }) => ({ status: 200, body: { href: url.href } }),
  });
  const adapter = createWorkOsPipesAdapter({
    principals: principalPort(defaultPrincipals()),
  });
  const binding = relayBinding(workos.origin, {
    settings: {
      provider: PROVIDER,
      mode: "relay",
      relay: {
        routing: "url",
        upstreamOrigin: "https://api.github.com",
        maxResponseBytes: 65536,
      },
    },
  });
  const app = harness({ binding });
  const result = await adapter.invoke!(
    app.context({ connection: connectionRecord(binding) }),
    {
      operationRef: "operation:listRepositories",
      input: { query: { per_page: "5" } },
      commandId: "command:url-routing",
    },
  );
  assert.equal(result.state, "complete");
  const [relayed] = workos.received("GET", "/relay");
  assert.equal(
    relayed!.headers["x-relay-url"],
    "https://api.github.com/user/repos?per_page=5",
  );
  await workos.close();
});
