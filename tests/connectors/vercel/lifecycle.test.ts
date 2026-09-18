import { test } from "node:test";
import assert from "node:assert/strict";
import { ConnectorError } from "../../../src/server/connectors/index.js";
import {
  createVercelConnectAdapter,
  vercelConfigurationNames,
  vercelOperationRef,
  type VercelSettings,
} from "../../../src/server/connectors/providers/vercel/index.js";
import { startVercelConnect } from "../doubles/vercel-connect.js";
import {
  buildBinding,
  buildConnection,
  harness,
  operatorActor,
} from "./harness.js";

/*
 * VC-05: unlinking a project, deleting a connector, reconnecting and
 * reacquiring a token are four different intents with four different
 * effects, and a trigger destination can only be changed to a destination
 * the binding already approved.
 */

const TEAM = "team_fixture";
const PROJECT = "prj_main";
const OTHER_PROJECT = "prj_other";
const CONNECTOR = "slack/acme-slack";

const settings = (overrides: Partial<VercelSettings> = {}): VercelSettings => ({
  project: { id: PROJECT, environment: "production" },
  profiles: {
    user: {
      connector: CONNECTOR,
      subject: { type: "user", identity: "tenant-qualified-subject" },
      installation: { mode: "installation-free" },
      scopes: ["chat:write"],
    },
  },
  defaultProfile: "user",
  returnPath: "/connectors/vercel/return",
  triggers: {
    destinations: [{ projectId: PROJECT, path: "/api/connect/slack" }],
  },
  ...overrides,
});

async function fixture(options: { shared?: boolean } = {}) {
  return startVercelConnect({
    teamId: TEAM,
    connectors: [
      {
        uid: CONNECTOR,
        type: "slack",
        service: "slack",
        supportsTriggers: true,
        triggersEnabled: true,
        supportsRevocation: true,
        supportedSubjectTypes: ["app", "user"],
        scopes: ["chat:write", "channels:read"],
        projects: {
          [PROJECT]: ["production"],
          ...(options.shared ? { [OTHER_PROJECT]: ["production"] } : {}),
        },
      },
    ],
    credentials: [
      { token: "vma_management_token", kind: "management", teamId: TEAM },
      {
        token: "oidc_workload_token",
        kind: "workload",
        teamId: TEAM,
        projectId: PROJECT,
        environment: "production",
      },
    ],
  });
}

function setup(
  double: Awaited<ReturnType<typeof startVercelConnect>>,
  options: {
    settings?: VercelSettings;
    connection?: Partial<Parameters<typeof buildConnection>[0]>;
    actor?: typeof operatorActor;
  } = {},
) {
  const h = harness(options.actor ? { actor: options.actor } : {});
  h.ports.configuration.set("VERCEL_TEAM_ID", TEAM);
  h.ports.configuration.set(
    vercelConfigurationNames.managementToken,
    "vma_management_token",
  );
  h.ports.configuration.set(
    vercelConfigurationNames.workloadToken,
    "oidc_workload_token",
  );
  const binding = buildBinding({
    apiOrigin: double.origin,
    teamId: TEAM,
    settings: options.settings ?? settings(),
    connectors: [CONNECTOR],
    projects: [PROJECT, OTHER_PROJECT],
    environments: ["production"],
  });
  const connection = buildConnection({
    binding,
    ownerKind: "user",
    lifecycle: "active",
    ...options.connection,
  });
  return { h, binding, connection, ctx: h.context({ binding, connection }) };
}

const connectedState = (scopes: string[], connectorId: string) => ({
  vercel: {
    profileId: "user",
    subjectType: "user" as const,
    scopes,
    connectorUid: CONNECTOR,
    connectorId,
    connectorType: "slack",
    externalSubject: "U1234",
    expiresAt: Date.now() + 3_600_000,
    target: { kind: "provider-user", id: "U1234" },
    identityKnown: true,
  },
});

test("a local disconnect touches nothing at the provider", async (t) => {
  const double = await fixture();
  t.after(double.close);
  const { h, binding, connection } = setup(double);
  const credentialRef = await h.ports.credentials.store(
    {
      tenantId: connection.tenantId,
      ownerKind: "user",
      ownerId: connection.ownerId,
      connectionRef: connection.connectionRef,
      bindingRef: binding.bindingRef,
      custody: "external-credential-broker",
    },
    { token: "provider_secret" },
  );
  const linked = { ...connection, credentialRef };
  const adapter = createVercelConnectAdapter();
  const result = await adapter.disconnect!(
    h.context({ binding, connection: linked }),
    "local",
  );
  assert.deepEqual(result, {
    local: "applied",
    broker: "not-attempted",
    upstream: "not-attempted",
  });
  assert.equal(double.calls.length, 0, "no provider call for a local unlink");
  assert.equal(
    h.ports.inspect.credentialMaterial(credentialRef),
    undefined,
    "the stored provider token is dropped",
  );
});

test("a broker disconnect unlinks this project and reports what still uses the connector", async (t) => {
  const double = await fixture({ shared: true });
  t.after(double.close);
  const { h, binding, connection } = setup(double);
  const adapter = createVercelConnectAdapter();
  const result = await adapter.disconnect!(
    h.context({ binding, connection }),
    "broker",
  );
  assert.equal(result.broker, "applied");
  assert.equal(result.upstream, "not-attempted");
  assert.deepEqual(result.sharedWith, [`vercel-project:${OTHER_PROJECT}`]);
  const call = double.routed("connect.projects.unlink").at(-1)!;
  assert.equal(call.method, "DELETE");
  assert.equal(call.version, "v1");
  assert.equal(
    call.path,
    `/v1/connect/connectors/slack%2Facme-slack/projects/${PROJECT}`,
  );
  assert.equal(
    double.connector(CONNECTOR)?.projects[OTHER_PROJECT]?.length,
    1,
    "the other project keeps its link",
  );
  assert.equal(double.routed("connect.connectors.delete").length, 0);
});

test("an upstream disconnect refuses to delete a connector another project uses", async (t) => {
  const double = await fixture({ shared: true });
  t.after(double.close);
  const { h, binding, connection } = setup(double);
  const adapter = createVercelConnectAdapter();
  const blocked = await adapter.disconnect!(
    h.context({ binding, connection }),
    "upstream",
  );
  assert.deepEqual(blocked, {
    local: "not-attempted",
    broker: "not-attempted",
    upstream: "not-attempted",
    sharedWith: [`vercel-project:${OTHER_PROJECT}`],
  });
  assert.equal(double.routed("connect.connectors.delete").length, 0);
  assert.ok(double.connector(CONNECTOR));
});

test("an upstream disconnect deletes an unshared connector, and needs administrative authority", async (t) => {
  const double = await fixture();
  t.after(double.close);
  const withoutAdmin = setup(double, { actor: operatorActor });
  const adapter = createVercelConnectAdapter();
  await assert.rejects(
    adapter.disconnect!(
      withoutAdmin.h.context({
        binding: withoutAdmin.binding,
        connection: withoutAdmin.connection,
      }),
      "upstream",
    ),
    (error: unknown) =>
      error instanceof ConnectorError && error.detail === "vercel.admin-required",
  );
  assert.ok(double.connector(CONNECTOR));

  const { h, binding, connection } = setup(double);
  const result = await adapter.disconnect!(
    h.context({ binding, connection }),
    "upstream",
  );
  assert.deepEqual(result, {
    local: "applied",
    broker: "applied",
    upstream: "applied",
  });
  assert.equal(double.connector(CONNECTOR), undefined);
});

test("revocation is unsupported unless the binding opts into the SDK-observed endpoint", async (t) => {
  const double = await fixture();
  t.after(double.close);
  const adapter = createVercelConnectAdapter();
  const plain = setup(double, {
    connection: {
      state: connectedState(["chat:write"], double.connector(CONNECTOR)!.id),
    },
  });
  const unsupported = await adapter.revoke!(
    plain.h.context({ binding: plain.binding, connection: plain.connection }),
  );
  assert.deepEqual(unsupported, {
    local: "applied",
    broker: "unsupported",
    upstream: "unsupported",
  });
  assert.equal(double.routed("connect.tokens.revoke").length, 0);

  const opted = setup(double, {
    settings: settings({ revocation: "sdk-observed-endpoint" }),
    connection: {
      state: connectedState(["chat:write"], double.connector(CONNECTOR)!.id),
    },
  });
  const revoked = await adapter.revoke!(
    opted.h.context({ binding: opted.binding, connection: opted.connection }),
  );
  assert.equal(revoked.broker, "applied");
  assert.equal(
    revoked.upstream,
    "indeterminate",
    "Vercel calls the provider's revocation endpoint only when the provider has one",
  );
  const call = double.routed("connect.tokens.revoke").at(-1)!;
  assert.equal(call.method, "DELETE");
  assert.equal(call.path, "/v1/connect/connectors/slack%2Facme-slack/tokens");
  assert.deepEqual((call.body as Record<string, unknown>)["subject"], {
    type: "user",
    id: `${opted.connection.tenantId}:${opted.connection.ownerId}`,
  });
});

test("reconnect cancels the previous handoff and flags a scope increase", async (t) => {
  const double = await fixture();
  t.after(double.close);
  const { h, binding, connection } = setup(double, {
    connection: {
      state: connectedState(["chat:write"], double.connector(CONNECTOR)!.id),
    },
  });
  const adapter = createVercelConnectAdapter();
  const first = await adapter.authorize!(h.context({ binding, connection }), {
    ownerKind: "user",
    requestedPermissions: [],
    accountSwitch: false,
    interruption: "allowed",
  });
  if (first.kind !== "handoff") throw new Error("expected a handoff");
  await h.ports.handoffs.issue({
    ...first.handoff,
    actor: h.context({ binding, connection }).actor,
    connectionRef: connection.connectionRef,
    bindingRef: binding.bindingRef,
    generation: connection.generation,
  });

  // A reconnect at the next generation cancels what the old one left open.
  const advanced = { ...connection, generation: 2 };
  const widened = buildBinding({
    apiOrigin: double.origin,
    teamId: TEAM,
    settings: settings({
      profiles: {
        user: {
          connector: CONNECTOR,
          subject: { type: "user", identity: "tenant-qualified-subject" },
          installation: { mode: "installation-free" },
          scopes: ["chat:write", "channels:read"],
        },
      },
    }),
    connectors: [CONNECTOR],
    projects: [PROJECT, OTHER_PROJECT],
    environments: ["production"],
  });
  const again = await adapter.reconnect!(
    h.context({ binding: widened, connection: advanced, generation: 2 }),
    {
      ownerKind: "user",
      requestedPermissions: [],
      accountSwitch: false,
      interruption: "allowed",
    },
  );
  if (again.kind !== "handoff") throw new Error("expected a handoff");
  assert.equal(
    again.handoff.intent,
    "vercel.connect.escalation",
    "asking for more than the connection holds is an escalation, not a refresh",
  );
  assert.deepEqual(
    (double.routed("connect.authorize").at(-1)!.body as Record<string, unknown>)[
      "scopes"
    ],
    ["chat:write", "channels:read"],
  );
  const cancelled = h.ports.inspect
    .handoffs()
    .filter((record) => record.state === "cancelled");
  assert.equal(cancelled.length, 1, "the superseded handoff was cancelled");

  const switching = await adapter.reconnect!(
    h.context({ binding, connection: advanced, generation: 2 }),
    {
      ownerKind: "user",
      requestedPermissions: [],
      accountSwitch: true,
      interruption: "allowed",
    },
  );
  if (switching.kind !== "handoff") throw new Error("expected a handoff");
  assert.equal(switching.handoff.intent, "vercel.connect.account-switch");
});

test("a trigger destination can only be replaced with an approved destination", async (t) => {
  const double = await fixture();
  t.after(double.close);
  const { ctx } = setup(double);
  const adapter = createVercelConnectAdapter();
  const before = double.calls.length;
  await assert.rejects(
    adapter.invoke!(ctx, {
      operationRef: vercelOperationRef("connect.triggers.destinations.replace"),
      input: {
        connector: CONNECTOR,
        destinations: [{ projectId: PROJECT, path: "/api/exfiltrate" }],
      },
      commandId: "cmd-destination-swap",
    }),
    (error: unknown) =>
      error instanceof ConnectorError &&
      error.detail === "vercel.trigger.destination-not-approved",
    "a path the binding never approved is not a destination",
  );
  await assert.rejects(
    adapter.invoke!(ctx, {
      operationRef: vercelOperationRef("connect.triggers.destinations.replace"),
      input: {
        connector: CONNECTOR,
        destinations: [{ projectId: OTHER_PROJECT, path: "/api/connect/slack" }],
      },
      commandId: "cmd-destination-project",
    }),
    (error: unknown) =>
      error instanceof ConnectorError &&
      error.detail === "vercel.trigger.destination-not-approved",
  );
  assert.equal(double.calls.length, before, "neither attempt reached Vercel");

  const applied = await adapter.invoke!(ctx, {
    operationRef: vercelOperationRef("connect.triggers.destinations.replace"),
    input: {
      connector: CONNECTOR,
      destinations: [{ projectId: PROJECT, path: "/api/connect/slack" }],
    },
    commandId: "cmd-destination-approved",
  });
  assert.equal(applied.state, "complete");
  const call = double.routed("connect.triggers.destinations.replace").at(-1)!;
  assert.equal(call.version, "v1");
  assert.equal(call.method, "PATCH");
  assert.deepEqual((call.body as Record<string, unknown>)["destinations"], [
    { projectId: PROJECT, path: "/api/connect/slack" },
  ]);
  assert.deepEqual(double.connector(CONNECTOR)?.triggerDestinations, [
    { projectId: PROJECT, path: "/api/connect/slack" },
  ]);
});

test("an interrupted project link reconciles instead of relinking blindly", async (t) => {
  const double = await fixture();
  t.after(double.close);
  const { ctx } = setup(double);
  const adapter = createVercelConnectAdapter();
  const request = {
    operationRef: vercelOperationRef("connect.projects.link"),
    input: {
      connector: CONNECTOR,
      projectId: PROJECT,
      environments: ["production"],
    },
    commandId: "cmd-link-retry",
  };
  const first = await adapter.invoke!(ctx, request);
  assert.equal(first.state, "complete");
  const repeated = await adapter.invoke!(ctx, request);
  assert.equal(repeated.state, "complete");
  assert.equal(repeated.code, "vercel.effect.already-applied");
  assert.equal(
    double.routed("connect.projects.link").length,
    1,
    "the journal recognised the same intent",
  );
});
