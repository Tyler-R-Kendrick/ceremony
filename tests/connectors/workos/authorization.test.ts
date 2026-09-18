import assert from "node:assert/strict";
import test from "node:test";
import { ConnectorError } from "../../../src/server/connectors/errors.js";
import { createWorkOsPipesAdapter } from "../../../src/server/connectors/providers/workos/index.js";
import type { AuthorizationIntent } from "../../../src/server/connectors/adapter.js";
import { startWorkOsPipesDouble } from "../doubles/workos-pipes.js";
import { fixtureActor } from "../doubles/ports.js";
import {
  API_KEY,
  CLIENT_ID,
  ORGANIZATION_ID,
  OTHER_USER_ID,
  PROVIDER,
  USER_ID,
  connectionRecord,
  credentialBinding,
  defaultPrincipals,
  deniedOrganizationPrincipal,
  harness,
  principalPort,
  relayBinding,
  userPrincipal,
} from "./support.js";

/*
 * IB-01: connection status and human authorization with an explicit user or
 * organization context. The WorkOS ids come from the host, the organization
 * grant needs host policy, and the authorization link never leaves the private
 * handoff.
 */

const intent = (
  overrides: Partial<AuthorizationIntent> = {},
): AuthorizationIntent => ({
  ownerKind: "user",
  requestedPermissions: ["repo"],
  accountSwitch: false,
  interruption: "allowed",
  ...overrides,
});

test("WorkOS authorization derives the user from the host principal port, not from the request", async () => {
  const workos = await startWorkOsPipesDouble({
    apiKey: API_KEY,
    knownUsers: [USER_ID],
  });
  const principals = principalPort(defaultPrincipals());
  const adapter = createWorkOsPipesAdapter({ principals });
  const app = harness({ binding: credentialBinding(workos.origin) });
  const start = await adapter.authorize!(app.context(), intent());
  assert.equal(start.kind, "handoff");
  assert.equal(principals.calls.length, 1);
  assert.deepEqual(principals.calls[0], {
    tenantId: fixtureActor.tenantId,
    ownerKind: "user",
  });

  const [authorize] = workos.received(
    "POST",
    `/data-integrations/${PROVIDER}/authorize`,
  );
  assert.ok(authorize);
  assert.equal(authorize.headers.authorization, `Bearer ${API_KEY}`);
  const body = JSON.parse(authorize.body.toString("utf8")) as Record<
    string,
    unknown
  >;
  // The host's WorkOS user id travelled; no organization did, and no caller
  // field could have put one there.
  assert.equal(body.user_id, USER_ID);
  assert.equal(body.organization_id, undefined);
  assert.equal(body.connection_owner, undefined);

  // The return route is built from this deployment's origin and carries the
  // correlation the completion is matched against.
  const returnTo = new URL(String(body.return_to));
  assert.equal(returnTo.origin, "https://app.example");
  assert.equal(returnTo.pathname, "/api/v1/connectors/workos/return");
  if (start.kind !== "handoff") throw new Error("unreachable");
  assert.equal(
    returnTo.searchParams.get("correlation"),
    start.handoff.correlationKey,
  );

  // The destination URL is private handoff material, not part of any summary.
  assert.equal(start.handoff.kind, "provider-browser");
  assert.ok(String(start.handoff.private.url).startsWith(workos.origin));
  assert.equal(start.handoff.intent, "workos.pipes.connect");
  await workos.close();
});

test("WorkOS organization connections require an organization principal and host policy", async () => {
  const workos = await startWorkOsPipesDouble({
    apiKey: API_KEY,
    knownUsers: [USER_ID],
  });
  const table = defaultPrincipals();
  const adapter = createWorkOsPipesAdapter({
    principals: principalPort(table),
  });
  const app = harness({ binding: credentialBinding(workos.origin) });

  const start = await adapter.authorize!(
    app.context(),
    intent({ ownerKind: "organization" }),
  );
  assert.equal(start.kind, "handoff");
  const [authorize] = workos.received(
    "POST",
    `/data-integrations/${PROVIDER}/authorize`,
  );
  const body = JSON.parse(authorize!.body.toString("utf8")) as Record<
    string,
    unknown
  >;
  assert.equal(body.organization_id, ORGANIZATION_ID);
  assert.equal(body.connection_owner, "organization");

  // Same actor, same organization, host policy says no: the connection cannot
  // be created, whatever the request asked for.
  const denied = createWorkOsPipesAdapter({
    principals: principalPort({
      ...table,
      [`${fixtureActor.tenantId}|organization|`]: deniedOrganizationPrincipal,
    }),
  });
  await assert.rejects(
    denied.authorize!(app.context(), intent({ ownerKind: "organization" })),
    (error: unknown) =>
      error instanceof ConnectorError &&
      error.code === "denied" &&
      error.detail === "workos.organization.not-permitted",
  );

  // A host with no organization mapping at all is refused before any call.
  const unmapped = createWorkOsPipesAdapter({
    principals: principalPort({
      [`${fixtureActor.tenantId}|organization|`]: {
        ownerId: ORGANIZATION_ID,
        userId: USER_ID,
      },
    }),
  });
  await assert.rejects(
    unmapped.authorize!(app.context(), intent({ ownerKind: "organization" })),
    (error: unknown) =>
      error instanceof ConnectorError &&
      error.detail === "workos.organization.unmapped",
  );
  await workos.close();
});

test("WorkOS refuses a workload owner and an unmapped principal without calling the broker", async () => {
  const workos = await startWorkOsPipesDouble({ apiKey: API_KEY });
  const adapter = createWorkOsPipesAdapter({
    principals: principalPort({}),
  });
  const app = harness({ binding: credentialBinding(workos.origin) });
  await assert.rejects(
    adapter.authorize!(app.context(), intent({ ownerKind: "workload" })),
    (error: unknown) =>
      error instanceof ConnectorError &&
      error.code === "unsupported" &&
      error.detail === "workos.owner.workload",
  );
  await assert.rejects(
    adapter.authorize!(app.context(), intent()),
    (error: unknown) =>
      error instanceof ConnectorError &&
      error.code === "denied" &&
      error.detail === "workos.principal.absent",
  );
  assert.equal(workos.requests.length, 0);
  await workos.close();
});

test("WorkOS reports missing configuration instead of attempting a call", async () => {
  const workos = await startWorkOsPipesDouble({ apiKey: API_KEY });
  const adapter = createWorkOsPipesAdapter({
    principals: principalPort(defaultPrincipals()),
  });
  const app = harness({
    binding: credentialBinding(workos.origin),
    configuration: { WORKOS_CLIENT_ID: CLIENT_ID },
  });
  await assert.rejects(
    adapter.authorize!(app.context(), intent()),
    (error: unknown) =>
      error instanceof ConnectorError &&
      error.code === "configuration-required",
  );
  assert.equal(workos.requests.length, 0);

  // The directory says the same thing: implemented, not usable here.
  const statuses = adapter.capabilities(new Set(["WORKOS_CLIENT_ID"]));
  const authorize = statuses.find(
    (status) => status.dimension === "authorize",
  );
  assert.equal(authorize?.configuration, "missing");
  assert.equal(authorize?.implementation, "implemented");
  await workos.close();
});

test("WorkOS refuses a binding whose custody and mode disagree, in both directions", async () => {
  const workos = await startWorkOsPipesDouble({ apiKey: API_KEY });
  const adapter = createWorkOsPipesAdapter({
    principals: principalPort(defaultPrincipals()),
  });
  // Relay settings under credential custody: a deployment that lost relay
  // access cannot start vending tokens instead.
  const confused = credentialBinding(workos.origin, {
    settings: {
      provider: PROVIDER,
      mode: "relay",
      relay: { routing: "path", maxResponseBytes: 1024 },
    },
  });
  const app = harness({ binding: confused });
  await assert.rejects(
    adapter.authorize!(app.context(), intent()),
    (error: unknown) =>
      error instanceof ConnectorError &&
      error.detail === "workos.mode.custody-mismatch",
  );

  // And the other way round: credential settings under execution custody.
  const reversed = relayBinding(workos.origin, {
    settings: { provider: PROVIDER, mode: "credentials" },
  });
  await assert.rejects(
    adapter.authorize!(app.context({ binding: reversed }), intent()),
    (error: unknown) =>
      error instanceof ConnectorError &&
      error.detail === "workos.mode.custody-mismatch",
  );
  assert.equal(workos.requests.length, 0);
  await workos.close();
});

test("WorkOS honours a no-interruption policy with human-required rather than a quieter route", async () => {
  const workos = await startWorkOsPipesDouble({ apiKey: API_KEY });
  const adapter = createWorkOsPipesAdapter({
    principals: principalPort(defaultPrincipals()),
  });
  const app = harness({ binding: credentialBinding(workos.origin) });
  const start = await adapter.authorize!(
    app.context(),
    intent({ interruption: "none" }),
  );
  assert.deepEqual(start, {
    kind: "human-required",
    code: "workos.authorization.attended",
  });
  assert.equal(workos.requests.length, 0);
  await workos.close();
});

test("WorkOS verification reads the connected account and separates identified from unidentified accounts", async () => {
  const workos = await startWorkOsPipesDouble({
    apiKey: API_KEY,
    connections: [
      {
        provider: PROVIDER,
        userId: USER_ID,
        scopes: ["repo", "user:email"],
        accountIdentifier: "octocat",
        accountDisplayName: "The Octocat",
      },
    ],
  });
  const adapter = createWorkOsPipesAdapter({
    principals: principalPort(defaultPrincipals()),
  });
  const binding = credentialBinding(workos.origin);
  const app = harness({ binding });
  const result = await adapter.verify!(
    app.context({ connection: connectionRecord(binding) }),
  );
  assert.equal(result.state, "complete");
  assert.deepEqual(result.target, { kind: "provider-account", id: "octocat" });
  const claim = result.claims[0]!;
  assert.equal(claim.kind, "account-identity");
  assert.equal(claim.issuer, "external-broker");
  assert.deepEqual(claim.permissions?.reported, ["repo", "user:email"]);
  // What the broker reported is not what this deployment observed.
  assert.deepEqual(claim.permissions?.observed, []);
  assert.equal(result.externalIds?.workosUserId, USER_ID);

  // AC-AUTH-08: a provider that exposes no account identifier yields a claim
  // that says an owner is claimed, never that the account was identified.
  const anonymous = await startWorkOsPipesDouble({
    apiKey: API_KEY,
    connections: [{ provider: PROVIDER, userId: USER_ID, scopes: ["repo"] }],
  });
  const secondBinding = credentialBinding(anonymous.origin);
  const secondApp = harness({ binding: secondBinding });
  const weak = await adapter.verify!(
    secondApp.context({ connection: connectionRecord(secondBinding) }),
  );
  assert.equal(weak.state, "complete");
  assert.equal(weak.claims[0]!.kind, "ownership-claimed");
  assert.equal(weak.target?.kind, "broker-connection");
  assert.ok(
    weak.claims[0]!.limitations.some((text) =>
      text.includes("no account identifier"),
    ),
  );
  await workos.close();
  await anonymous.close();
});

test("WorkOS verification maps needs_reauthorization and a missing connection to participation, not success", async () => {
  const workos = await startWorkOsPipesDouble({
    apiKey: API_KEY,
    connections: [
      {
        provider: PROVIDER,
        userId: USER_ID,
        state: "needs_reauthorization",
        scopes: ["repo"],
      },
    ],
  });
  const adapter = createWorkOsPipesAdapter({
    principals: principalPort(defaultPrincipals()),
  });
  const binding = credentialBinding(workos.origin);
  const app = harness({ binding });
  const stale = await adapter.verify!(
    app.context({ connection: connectionRecord(binding) }),
  );
  assert.equal(stale.state, "human-required");
  assert.equal(stale.code, "workos.needs-reauthorization");
  assert.deepEqual(stale.claims, []);

  const empty = await startWorkOsPipesDouble({ apiKey: API_KEY });
  const emptyBinding = credentialBinding(empty.origin);
  const emptyApp = harness({ binding: emptyBinding });
  const pending = await adapter.verify!(
    emptyApp.context({ connection: connectionRecord(emptyBinding) }),
  );
  assert.equal(pending.state, "pending");
  assert.equal(pending.code, "workos.not-installed");
  await workos.close();
  await empty.close();
});

test("WorkOS completion refuses a return whose correlation or generation does not match", async () => {
  const workos = await startWorkOsPipesDouble({
    apiKey: API_KEY,
    connections: [
      {
        provider: PROVIDER,
        userId: USER_ID,
        accountIdentifier: "octocat",
        scopes: ["repo"],
      },
    ],
  });
  const adapter = createWorkOsPipesAdapter({
    principals: principalPort(defaultPrincipals()),
  });
  const binding = credentialBinding(workos.origin);
  const app = harness({ binding });
  const connection = connectionRecord(binding);
  const issued = await app.ports.handoffs.issue({
    actor: fixtureActor,
    connectionRef: connection.connectionRef,
    bindingRef: binding.bindingRef,
    generation: connection.generation,
    kind: "provider-browser",
    presentation: "popup",
    expiresAt: Date.now() + 600_000,
    intent: "workos.pipes.connect",
    correlationKey: "workos:correlation-1",
    private: { url: `${workos.origin}/x`, accountSwitch: "false" },
  });
  const record = app.ports
    .inspect.handoffs()
    .find((item) => item.handoffRef === issued.handoffRef)!;

  const foreign = await adapter.complete!(
    app.context({ connection, handoff: record }),
    {
      kind: "redirect",
      url: new URL("https://app.example/api/v1/connectors/workos/return?correlation=someone-else"),
    },
  );
  assert.deepEqual(foreign, {
    state: "denied",
    claims: [],
    code: "workos.callback.correlation",
  });

  // A callback for an older generation cannot revive the connection.
  const stale = await adapter.complete!(
    app.context({ connection, handoff: record, generation: 7 }),
    {
      kind: "redirect",
      url: new URL(
        "https://app.example/api/v1/connectors/workos/return?correlation=workos:correlation-1",
      ),
    },
  );
  assert.deepEqual(stale, {
    state: "denied",
    claims: [],
    code: "workos.callback.stale",
  });

  // The matching return still proves nothing by itself: the answer comes from
  // the connected-account record.
  const good = await adapter.complete!(
    app.context({ connection, handoff: record }),
    {
      kind: "redirect",
      url: new URL(
        "https://app.example/api/v1/connectors/workos/return?correlation=workos:correlation-1",
      ),
    },
  );
  assert.equal(good.state, "complete");
  assert.ok(
    workos.received(
      "GET",
      `/user_management/users/${USER_ID}/connected_accounts/${PROVIDER}`,
    ).length >= 1,
  );
  await workos.close();
});

test("WorkOS reconnect landing on a different account needs explicit account-switch intent", async () => {
  const workos = await startWorkOsPipesDouble({
    apiKey: API_KEY,
    connections: [
      {
        provider: PROVIDER,
        userId: USER_ID,
        accountIdentifier: "octocat",
        scopes: ["repo"],
      },
    ],
  });
  const adapter = createWorkOsPipesAdapter({
    principals: principalPort(defaultPrincipals()),
  });
  const binding = credentialBinding(workos.origin);
  const app = harness({ binding });
  const connection = connectionRecord(binding, {
    externalIds: { connectedAccountId: "data_installation_previous" },
  });
  const refused = await adapter.verify!(app.context({ connection }));
  assert.equal(refused.state, "denied");
  assert.equal(refused.code, "workos.account-changed");

  const issued = await app.ports.handoffs.issue({
    actor: fixtureActor,
    connectionRef: connection.connectionRef,
    bindingRef: binding.bindingRef,
    generation: connection.generation,
    kind: "provider-browser",
    presentation: "popup",
    expiresAt: Date.now() + 600_000,
    intent: "workos.pipes.reconnect",
    correlationKey: "workos:switch",
    private: { url: `${workos.origin}/x`, accountSwitch: "true" },
  });
  const record = app.ports
    .inspect.handoffs()
    .find((item) => item.handoffRef === issued.handoffRef)!;
  const switched = await adapter.complete!(
    app.context({ connection, handoff: record }),
    {
      kind: "redirect",
      url: new URL(
        "https://app.example/api/v1/connectors/workos/return?correlation=workos:switch",
      ),
    },
  );
  assert.equal(switched.state, "complete");
  await workos.close();
});

test("WorkOS keeps two tenants with the same provider account apart", async () => {
  const workos = await startWorkOsPipesDouble({
    apiKey: API_KEY,
    connections: [
      {
        provider: PROVIDER,
        userId: USER_ID,
        accountIdentifier: "shared@example.invalid",
        scopes: ["repo"],
      },
      {
        provider: PROVIDER,
        userId: OTHER_USER_ID,
        accountIdentifier: "shared@example.invalid",
        scopes: ["repo", "admin:org"],
      },
    ],
  });
  const adapter = createWorkOsPipesAdapter({
    principals: principalPort({
      ...defaultPrincipals(),
      "tenant-b|user|": { ownerId: "subject-2", userId: OTHER_USER_ID },
    }),
  });
  const binding = credentialBinding(workos.origin);
  const app = harness({ binding });
  const first = await adapter.verify!(
    app.context({ connection: connectionRecord(binding) }),
  );
  const secondBinding = credentialBinding(workos.origin, {
    tenantId: "tenant-b",
  });
  const secondApp = harness({ binding: secondBinding });
  const second = await adapter.verify!(
    secondApp.context({
      actor: { ...fixtureActor, tenantId: "tenant-b", subjectId: "subject-2" },
      binding: secondBinding,
      connection: connectionRecord(secondBinding, {
        tenantId: "tenant-b",
        ownerId: "subject-2",
      }),
    }),
  );
  assert.equal(first.state, "complete");
  assert.equal(second.state, "complete");
  // Same display identity upstream, two different broker connections: nothing
  // in the adapter merged them.
  assert.notEqual(
    first.externalIds?.connectedAccountId,
    second.externalIds?.connectedAccountId,
  );
  assert.equal(first.externalIds?.workosUserId, USER_ID);
  assert.equal(second.externalIds?.workosUserId, OTHER_USER_ID);
  await workos.close();
});

test("WorkOS discovery lists configured providers with each owner's connection state", async () => {
  const workos = await startWorkOsPipesDouble({
    apiKey: API_KEY,
    providers: [
      { slug: "github", name: "GitHub", description: "Repositories" },
      { slug: "slack", name: "Slack" },
    ],
    connections: [
      { provider: PROVIDER, userId: USER_ID, accountIdentifier: "octocat" },
    ],
  });
  const adapter = createWorkOsPipesAdapter({
    principals: principalPort(defaultPrincipals()),
  });
  const app = harness({ binding: credentialBinding(workos.origin) });
  const result = await adapter.discover!(app.context(), {});
  assert.deepEqual(
    result.items.map((item) => item.identity.nativeId),
    ["github", "slack"],
  );
  assert.equal(result.items[0]!.provenance?.state, "connected");
  assert.equal(result.items[1]!.provenance?.state, "not-installed");
  assert.equal(
    result.items[0]!.identity.authorityNamespace,
    `workos:${CLIENT_ID}`,
  );
  await workos.close();
});
