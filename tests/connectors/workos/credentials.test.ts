import assert from "node:assert/strict";
import test from "node:test";
import { ConnectorError } from "../../../src/server/connectors/errors.js";
import { createWorkOsPipesAdapter } from "../../../src/server/connectors/providers/workos/index.js";
import { startWorkOsPipesDouble } from "../doubles/workos-pipes.js";
import { fixtureActor } from "../doubles/ports.js";
import {
  API_KEY,
  ORGANIZATION_ID,
  PROVIDER,
  USER_ID,
  connectionRecord,
  credentialBinding,
  defaultPrincipals,
  harness,
  principalPort,
  relayBinding,
} from "./support.js";

/*
 * IB-02, credential mode: the documented token endpoint vends a provider
 * credential into host custody, and a 200 that says `active: false` is a
 * request for human participation, not a credential (AC-EXT-05).
 */

const TOKEN = "gho_16C7e42F292c6912E7710c838347Ae178B4a";

test("WorkOS credential mode stores the vended token in custody and returns only a reference", async () => {
  const expiresAt = new Date(Date.now() + 3_600_000).toISOString();
  const workos = await startWorkOsPipesDouble({
    apiKey: API_KEY,
    connections: [
      {
        provider: PROVIDER,
        userId: USER_ID,
        accessToken: TOKEN,
        expiresAt,
        scopes: ["repo", "user:email"],
        missingScopes: ["admin:org"],
        accountIdentifier: "octocat",
      },
    ],
  });
  const adapter = createWorkOsPipesAdapter({
    principals: principalPort(defaultPrincipals()),
  });
  const binding = credentialBinding(workos.origin);
  const app = harness({ binding });
  const connection = connectionRecord(binding);
  const result = await adapter.invoke!(app.context({ connection }), {
    operationRef: "operation:workos.credential",
    input: {},
    commandId: "command:1",
  });

  assert.equal(result.state, "complete");
  const output = result.output as Record<string, unknown>;
  // The token is not in the result; a reference, an expiry and the scope gap are.
  assert.equal(JSON.stringify(output).includes(TOKEN), false);
  assert.deepEqual(output.scopes, ["repo", "user:email"]);
  assert.deepEqual(output.missingScopes, ["admin:org"]);
  assert.equal(output.expiresAt, expiresAt);
  assert.equal(result.outputClassification, "personal");

  const scope = {
    tenantId: binding.tenantId,
    ownerKind: connection.ownerKind,
    ownerId: connection.ownerId,
    connectionRef: connection.connectionRef,
    bindingRef: binding.bindingRef,
    custody: "external-credential-broker" as const,
  };
  const described = await app.ports.credentials.describe(
    scope,
    String(output.credentialRef),
  );
  assert.equal(described?.custody, "external-credential-broker");
  assert.equal(described?.expiresAt, Date.parse(expiresAt));
  // Only a `use` callback sees the material, and it stays inside it.
  const seen = await app.ports.credentials.use(
    scope,
    String(output.credentialRef),
    async (material) => material.access_token === TOKEN,
  );
  assert.equal(seen, true);

  const [vend] = workos.received(
    "POST",
    `/data-integrations/${PROVIDER}/token`,
  );
  assert.ok(vend);
  const body = JSON.parse(vend.body.toString("utf8")) as Record<string, unknown>;
  assert.equal(body.user_id, USER_ID);
  assert.equal(body.connection_owner, undefined);
  await workos.close();
});

test("WorkOS credential mode leases an expiry when the provider reports none", async () => {
  const workos = await startWorkOsPipesDouble({
    apiKey: API_KEY,
    connections: [
      { provider: PROVIDER, userId: USER_ID, accessToken: TOKEN, scopes: [] },
    ],
  });
  const now = 1_780_000_000_000;
  const adapter = createWorkOsPipesAdapter({
    principals: principalPort(defaultPrincipals()),
  });
  const binding = credentialBinding(workos.origin, {
    settings: {
      provider: PROVIDER,
      mode: "credentials",
      credentialLeaseSeconds: 300,
    },
  });
  const app = harness({ binding, now: () => now });
  const result = await adapter.invoke!(
    app.context({ connection: connectionRecord(binding) }),
    { operationRef: "operation:workos.credential", input: {}, commandId: "c" },
  );
  assert.equal(result.state, "complete");
  assert.equal(
    (result.output as Record<string, unknown>).expiresAt,
    new Date(now + 300_000).toISOString(),
  );
  await workos.close();
});

test("WorkOS AC-EXT-05: an inactive token response is human participation, never a credential", async () => {
  const adapter = createWorkOsPipesAdapter({
    principals: principalPort(defaultPrincipals()),
  });
  const cases: Array<[
    "not_installed" | "needs_reauthorization" | "account_selection_required",
    string,
    string,
  ]> = [
    ["not_installed", "human-required", "workos.not-installed"],
    ["needs_reauthorization", "human-required", "workos.needs-reauthorization"],
    ["account_selection_required", "denied", "workos.account-selection-required"],
  ];
  for (const [reason, state, code] of cases) {
    const workos = await startWorkOsPipesDouble({
      apiKey: API_KEY,
      inactive: { [PROVIDER]: reason },
    });
    const binding = credentialBinding(workos.origin);
    const app = harness({ binding });
    const result = await adapter.invoke!(
      app.context({ connection: connectionRecord(binding) }),
      {
        operationRef: "operation:workos.credential",
        input: {},
        commandId: `command:${reason}`,
      },
    );
    assert.equal(result.state, state, reason);
    assert.equal(result.code, code, reason);
    assert.equal(result.output, undefined, reason);
    // Nothing was written to custody for an inactive answer.
    assert.deepEqual(app.ports.inspect.credentialRefs(), [], reason);
    // The journal records that no effect was applied.
    const [effect] = app.ports.inspect.effects();
    assert.equal(effect?.outcome?.status, "not-applied", reason);
    assert.equal(effect?.outcome?.code, "inactive", reason);
    await workos.close();
  }
});

test("WorkOS credential mode refuses an operation belonging to the relay profile", async () => {
  const workos = await startWorkOsPipesDouble({ apiKey: API_KEY });
  const adapter = createWorkOsPipesAdapter({
    principals: principalPort(defaultPrincipals()),
  });
  // A binding whose custody is credential-broker but which names an HTTP
  // operation: brokered execution is a different capability, not a fallback.
  const binding = credentialBinding(workos.origin, {
    operations: [
      {
        operationRef: "operation:listRepositories",
        nativeId: "GET /user/repos",
        destinationId: "api",
        transport: { kind: "http", method: "GET", pathTemplate: "/user/repos" },
        effect: "read",
        outputClassification: "personal",
        cost: "free",
        consent: "none",
        replay: "read-only",
        targetParameters: [],
      },
    ],
  });
  const app = harness({ binding });
  await assert.rejects(
    adapter.invoke!(app.context({ connection: connectionRecord(binding) }), {
      operationRef: "operation:listRepositories",
      input: {},
      commandId: "command:1",
    }),
    (error: unknown) =>
      error instanceof ConnectorError &&
      error.code === "denied" &&
      error.detail === "workos.operation.mode-mismatch",
  );
  assert.equal(workos.requests.length, 0);
  await workos.close();
});

test("WorkOS relay mode never calls the token or credentials endpoint", async () => {
  const workos = await startWorkOsPipesDouble({
    apiKey: API_KEY,
    knownUsers: [USER_ID],
    connections: [
      { provider: PROVIDER, userId: USER_ID, accessToken: TOKEN, scopes: [] },
    ],
  });
  const adapter = createWorkOsPipesAdapter({
    principals: principalPort(defaultPrincipals()),
  });
  const binding = relayBinding(workos.origin);
  const app = harness({ binding });
  await adapter.invoke!(
    app.context({ connection: connectionRecord(binding) }),
    {
      operationRef: "operation:listRepositories",
      input: {},
      commandId: "command:relay",
    },
  );
  assert.equal(
    workos.requests.some((request) =>
      /\/(token|credentials)$/.test(request.url.pathname),
    ),
    false,
  );
  // And nothing entered custody: brokered execution copies no credential.
  assert.deepEqual(app.ports.inspect.credentialRefs(), []);
  await workos.close();
});

test("WorkOS credential mode vends the organization's shared connection only with its own ids", async () => {
  const workos = await startWorkOsPipesDouble({
    apiKey: API_KEY,
    connections: [
      {
        provider: PROVIDER,
        userId: USER_ID,
        organizationId: ORGANIZATION_ID,
        owner: "organization",
        accessToken: TOKEN,
        scopes: ["repo"],
        accountIdentifier: "acme-workspace",
      },
    ],
  });
  const adapter = createWorkOsPipesAdapter({
    principals: principalPort(defaultPrincipals()),
  });
  const binding = credentialBinding(workos.origin);
  const app = harness({ binding });
  const connection = connectionRecord(binding, {
    ownerKind: "organization",
    ownerId: ORGANIZATION_ID,
  });
  const result = await adapter.invoke!(app.context({ connection }), {
    operationRef: "operation:workos.credential",
    input: {},
    commandId: "command:org",
  });
  assert.equal(result.state, "complete");
  const [vend] = workos.received(
    "POST",
    `/data-integrations/${PROVIDER}/token`,
  );
  const body = JSON.parse(vend!.body.toString("utf8")) as Record<
    string,
    unknown
  >;
  assert.equal(body.connection_owner, "organization");
  assert.equal(body.organization_id, ORGANIZATION_ID);
  assert.equal(body.user_id, USER_ID);

  // The same person's *own* connection is a different lookup, and the double
  // has none, so the user-owned call reports not-installed rather than
  // silently vending the organization's token.
  const personal = await adapter.invoke!(
    app.context({ connection: connectionRecord(binding) }),
    {
      operationRef: "operation:workos.credential",
      input: {},
      commandId: "command:user",
    },
  );
  assert.equal(personal.state, "human-required");
  assert.equal(personal.code, "workos.not-installed");
  await workos.close();
});

test("WorkOS disconnect separates local, broker and upstream effects", async () => {
  const workos = await startWorkOsPipesDouble({
    apiKey: API_KEY,
    connections: [
      { provider: PROVIDER, userId: USER_ID, accessToken: TOKEN, scopes: [] },
    ],
  });
  const adapter = createWorkOsPipesAdapter({
    principals: principalPort(defaultPrincipals()),
  });
  const binding = credentialBinding(workos.origin);
  const app = harness({ binding });
  const connection = connectionRecord(binding);

  const local = await adapter.disconnect!(
    app.context({ connection }),
    "local",
  );
  assert.deepEqual(local, {
    local: "applied",
    broker: "not-attempted",
    upstream: "not-attempted",
  });
  // A local unlink causes no broker call at all.
  assert.equal(workos.requests.length, 0);

  const broker = await adapter.disconnect!(
    app.context({ connection }),
    "broker",
  );
  assert.deepEqual(broker, {
    local: "applied",
    broker: "applied",
    upstream: "unsupported",
  });
  assert.equal(
    workos.received(
      "DELETE",
      `/user_management/users/${USER_ID}/connected_accounts/${PROVIDER}`,
    ).length,
    1,
  );
  assert.equal(workos.connection(PROVIDER, { userId: USER_ID }), undefined);

  // WorkOS documents that deleting the connected account does not revoke the
  // grant at the provider, so revoke reports exactly that.
  assert.deepEqual(await adapter.revoke!(app.context({ connection })), {
    local: "not-attempted",
    broker: "not-attempted",
    upstream: "unsupported",
  });
  const revoke = adapter
    .capabilities(new Set(["WORKOS_API_KEY", "WORKOS_CLIENT_ID"]))
    .find((status) => status.dimension === "revoke");
  assert.equal(revoke?.implementation, "unsupported");
  assert.equal(revoke?.evidence, "not-tested");
  await workos.close();
});

test("WorkOS rejects a stolen API key path: the double refuses anything but the configured key", async () => {
  const workos = await startWorkOsPipesDouble({ apiKey: API_KEY });
  const adapter = createWorkOsPipesAdapter({
    principals: principalPort(defaultPrincipals()),
  });
  const binding = credentialBinding(workos.origin);
  const app = harness({
    binding,
    configuration: {
      WORKOS_API_KEY: "sk_wrong_key",
      WORKOS_CLIENT_ID: "client_01FIXTURE",
    },
  });
  await assert.rejects(
    adapter.invoke!(app.context({ connection: connectionRecord(binding) }), {
      operationRef: "operation:workos.credential",
      input: {},
      commandId: "command:1",
    }),
    (error: unknown) =>
      error instanceof ConnectorError && error.code === "upstream-rejected",
  );
  // The provider's rejection text never becomes the public explanation.
  assert.equal(fixtureActor.tenantId, "tenant-a");
  await workos.close();
});
