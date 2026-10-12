import assert from "node:assert/strict";
import test from "node:test";
import { ConnectorError } from "../../../src/server/connectors/errors.js";
import type { AdapterCallContext } from "../../../src/server/connectors/adapter.js";
import {
  createVercelConnectAdapter,
  credentialRole,
  resolveCredential,
  vercelOperationRef,
  withBearer,
  type VercelSettings,
} from "../../../src/server/connectors/providers/vercel/index.js";
import { callVercel } from "../../../src/server/connectors/providers/vercel/client.js";
import { accountManagementSource } from "../../../src/server/connectors/providers/vercel-account/index.js";
import { ORIGIN } from "../commands/harness.js";
import { startVercelConnect } from "../doubles/vercel-connect.js";
import { buildBinding, buildConnection } from "../vercel/harness.js";
import { accountSetup, alice, connectAndChoose } from "./harness.js";

/*
 * The management leg of Vercel Connect, fed by a signed-in account in place
 * of a pasted token. The Connect double asks the account double whether a
 * token is live, as Vercel's one backend would: so a refreshed token works,
 * and a token the person revoked does not.
 *
 * What is NOT shown, because nothing here can show it: that Vercel Connect
 * accepts a device-grant token at all (the permissions page calls API
 * permissions a private beta). The Connect double models that acceptance.
 */

const TEAM = "team_dummy_acme";
const PROJECT = "prj_main";
const CONNECTOR = "slack/acme-slack";
const WORKLOAD_TOKEN = "oidc_workload_token";
const CONFIGURED_TOKEN = "vma_configured_token";
const MINUTE = 60_000;

const settings: VercelSettings = {
  project: { id: PROJECT, environment: "production" },
  profiles: {
    app: {
      connector: CONNECTOR,
      subject: { type: "app" },
      installation: { mode: "installation-free" },
      scopes: ["chat:write"],
    },
  },
  defaultProfile: "app",
  returnPath: "/connectors/vercel/return",
};

async function rig(
  t: Parameters<typeof accountSetup>[0],
  options: {
    teamOnConnect?: string;
    configured?: boolean;
    account?: "signed-in" | "none";
  } = {},
) {
  const setup = await accountSetup(t);
  const { connectionRef } = await connectAndChoose(setup);
  const connectTeam = options.teamOnConnect ?? TEAM;
  const connect = await startVercelConnect({
    teamId: connectTeam,
    connectors: [
      {
        uid: CONNECTOR,
        type: "slack",
        typeName: "Slack",
        service: "slack",
        projects: { [PROJECT]: ["production"] },
      },
    ],
    credentials: [
      {
        token: WORKLOAD_TOKEN,
        kind: "workload",
        teamId: connectTeam,
        projectId: PROJECT,
        environment: "production",
      },
      ...(options.configured
        ? [
            {
              token: CONFIGURED_TOKEN,
              kind: "management" as const,
              teamId: connectTeam,
            },
          ]
        : []),
    ],
    // Vercel is one backend: a token its account service says is live is live.
    authenticate: (token) =>
      setup.fixture.accessTokenValid(token)
        ? { token, kind: "management", teamId: connectTeam }
        : undefined,
  });
  t.after(connect.close);
  const accountCtx = await setup.adapterContext(connectionRef);
  const source = accountManagementSource({
    account: async () => (options.account === "none" ? undefined : accountCtx),
  });
  const adapter = createVercelConnectAdapter({ managementToken: source });
  const binding = buildBinding({
    apiOrigin: connect.origin,
    teamId: connectTeam,
    settings,
    connectors: [CONNECTOR],
    projects: [PROJECT],
    environments: ["production"],
  });
  const connection = buildConnection({ binding });
  const configuration = new Map<string, string>([
    ["VERCEL_TEAM_ID", connectTeam],
    ["VERCEL_CONNECT_WORKLOAD_TOKEN", WORKLOAD_TOKEN],
    ...(options.configured
      ? ([["VERCEL_MANAGEMENT_TOKEN", CONFIGURED_TOKEN]] as const)
      : []),
  ]);
  const connectCtx = (): AdapterCallContext => ({
    actor: setup.person,
    binding,
    connection,
    generation: connection.generation,
    signal: new AbortController().signal,
    environment: setup.ports.environment({
      fetch: globalThis.fetch,
      origin: ORIGIN,
      configuration: {
        read: async (name: string) => configuration.get(name),
        present: async (names: readonly string[]) =>
          new Set(names.filter((name) => configuration.has(name))),
        revision: async () => "cfg:1",
      },
    }),
  });
  return { setup, connectionRef, connect, accountCtx, adapter, connectCtx };
}

const list = (
  rigged: Awaited<ReturnType<typeof rig>>,
  ctx = rigged.connectCtx(),
) =>
  rigged.adapter.invoke!(ctx, {
    operationRef: vercelOperationRef("connect.connectors.list"),
    input: {},
    commandId: `list-${Math.random().toString(36).slice(2)}`,
  });

const bearerOf = (call: { headers: Record<string, string> }) =>
  /^Bearer (\S+)$/.exec(call.headers["authorization"] ?? "")?.[1];

test("the management leg administers with the signed-in person's token, for the team they chose", async (t) => {
  const rigged = await rig(t);
  const held = await rigged.setup.heldMaterial(rigged.connectionRef);
  const result = await list(rigged);
  assert.equal(result.state, "complete");
  const calls = rigged.connect.routed("connect.connectors.list");
  assert.equal(calls.length, 1);
  assert.equal(
    bearerOf(calls[0]!),
    held["access_token"],
    "Vercel saw the sign-in's token as the bearer",
  );
  assert.deepEqual(calls[0]!.query["teamId"], [TEAM]);
  assert.deepEqual(rigged.connect.violations, []);
  // The token travelled to Vercel and nowhere else: not in the output, not in the journal.
  assert.equal(
    JSON.stringify([result, rigged.setup.journal]).includes(
      held["access_token"]!,
    ),
    false,
  );
});

test("a token about to lapse is renewed before the management call, and the new token is the one sent", async (t) => {
  const rigged = await rig(t);
  rigged.setup.advance(59 * MINUTE);
  const result = await list(rigged);
  assert.equal(result.state, "complete");
  assert.equal(rigged.setup.fixture.counts.refresh, 1);
  const [call] = rigged.connect.routed("connect.connectors.list");
  assert.equal(bearerOf(call!), rigged.setup.fixture.issued.accessTokens[1]);
});

test("a configured management token still serves a person who has not signed in", async (t) => {
  const rigged = await rig(t, { configured: true, account: "none" });
  const asked = rigged.setup.fixture.apiRequests.length;
  const result = await list(rigged);
  assert.equal(result.state, "complete");
  const [call] = rigged.connect.routed("connect.connectors.list");
  assert.equal(bearerOf(call!), CONFIGURED_TOKEN);
  assert.equal(
    rigged.setup.fixture.apiRequests.length,
    asked,
    "the account's backend was not asked anything: the configured token was used",
  );
});

test("a signed-in account is used in place of a configured token, not alongside it", async (t) => {
  const rigged = await rig(t, { configured: true });
  const held = await rigged.setup.heldMaterial(rigged.connectionRef);
  await list(rigged);
  const calls = rigged.connect.routed("connect.connectors.list");
  assert.equal(calls.length, 1);
  assert.equal(bearerOf(calls[0]!), held["access_token"]);
});

test("with no sign-in and no configured token there is no management credential", async (t) => {
  const rigged = await rig(t, { account: "none" });
  await assert.rejects(
    list(rigged),
    (error: unknown) =>
      error instanceof ConnectorError &&
      error.detail === "vercel.management.unconfigured",
  );
  assert.equal(rigged.connect.calls.length, 0);
});

test("a sign-in for one team never administers another", async (t) => {
  // The connection was bound to acme; Connect is configured for a different team.
  const rigged = await rig(t, { teamOnConnect: "team_dummy_labs" });
  await assert.rejects(
    list(rigged),
    (error: unknown) =>
      error instanceof ConnectorError &&
      error.detail === "vercel.management.team-mismatch",
  );
  assert.equal(
    rigged.connect.calls.length,
    0,
    "nothing was sent to Vercel Connect",
  );
});

test("another person's sign-in is refused, whatever the host's lookup returned", async (t) => {
  const rigged = await rig(t);
  const impostor = {
    ...rigged.connectCtx(),
    actor: { ...rigged.setup.person, subjectId: "someone-else" },
  };
  await assert.rejects(
    list(rigged, impostor),
    (error: unknown) =>
      error instanceof ConnectorError &&
      error.detail === "vercel-account.management.not-owner",
  );
  const otherTenant = {
    ...rigged.connectCtx(),
    actor: { ...rigged.setup.person, tenantId: "tenant-elsewhere" },
  };
  await assert.rejects(
    list(rigged, otherTenant),
    (error: unknown) =>
      error instanceof ConnectorError &&
      error.detail === "vercel-account.management.not-owner",
  );
  assert.equal(rigged.connect.calls.length, 0);
});

test("a person who removes the app stops the management leg", async (t) => {
  const rigged = await rig(t);
  rigged.setup.fixture.revokeApp(alice.id);
  await assert.rejects(
    list(rigged),
    (error: unknown) =>
      error instanceof ConnectorError && error.detail === "vercel.forbidden",
  );
});

test("a sign-in that was disconnected is not a credential: the configured token serves, or nothing does", async (t) => {
  const rigged = await rig(t, { configured: true });
  const record = await rigged.setup.record(rigged.connectionRef);
  await rigged.setup.service.disconnect(
    rigged.setup.person,
    rigged.connectionRef,
    {
      expectedRevision: record.revision,
      scope: "local",
    },
  );
  // The host's lookup now finds a disconnected connection.
  const accountCtx = await rigged.setup.adapterContext(rigged.connectionRef);
  const source = accountManagementSource({ account: async () => accountCtx });
  const adapter = createVercelConnectAdapter({ managementToken: source });
  const result = await adapter.invoke!(rigged.connectCtx(), {
    operationRef: vercelOperationRef("connect.connectors.list"),
    input: {},
    commandId: "after-disconnect",
  });
  assert.equal(result.state, "complete");
  const [call] = rigged.connect.routed("connect.connectors.list");
  assert.equal(bearerOf(call!), CONFIGURED_TOKEN);
});

test("the workload leg never takes the signed-in token, and the signed-in token is never spent as a workload credential", async (t) => {
  const rigged = await rig(t);
  const ctx = rigged.connectCtx();
  const source = accountManagementSource({
    account: async () => rigged.accountCtx,
  });
  const management = await resolveCredential(ctx, "management", settings, {
    managementToken: source,
  });
  const workload = await resolveCredential(ctx, "workload", settings, {
    managementToken: source,
  });
  assert.equal(credentialRole(management), "management");
  assert.equal(credentialRole(workload), "workload");
  assert.notEqual(workload.ref, management.ref);
  assert.equal(workload.lease, undefined, "the workload leg has no lease");
  // One role's handle is refused where the other's belongs, in both directions.
  await assert.rejects(
    withBearer(ctx, management, "workload" as never, async () => "x"),
    (error: unknown) =>
      error instanceof ConnectorError &&
      error.detail === "vercel.credential.role-mismatch",
  );
  await assert.rejects(
    callVercel(ctx, {
      operation: "connect.token",
      credential: management as never,
      teamId: TEAM,
      schema: (await import("zod")).z.unknown(),
    }),
    (error: unknown) =>
      error instanceof ConnectorError &&
      error.detail === "vercel.credential.role-mismatch",
  );
  assert.equal(rigged.connect.calls.length, 0);
});

test("the capability rows say a signed-in account feeds management, and that Connect's acceptance is unverified", () => {
  const adapter = createVercelConnectAdapter({
    managementToken: async () => undefined,
  });
  const rows = adapter.capabilities(new Set(["VERCEL_TEAM_ID"]));
  const invoke = rows.find((row) => row.dimension === "invoke")!;
  assert.equal(invoke.configuration, "ready");
  assert.match(invoke.limitations.join(" "), /not verified/);
  // Without the hook the same configuration is not enough.
  const plain = createVercelConnectAdapter().capabilities(
    new Set(["VERCEL_TEAM_ID"]),
  );
  assert.equal(
    plain.find((row) => row.dimension === "invoke")!.configuration,
    "missing",
  );
});
