import { test } from "node:test";
import assert from "node:assert/strict";
import { ConnectorError } from "../../../src/server/connectors/index.js";
import {
  createVercelConnectAdapter,
  credentialRole,
  resolveCredential,
  vercelConfigurationNames,
  withBearer,
  type VercelSettings,
} from "../../../src/server/connectors/providers/vercel/index.js";
import { startVercelConnect } from "../doubles/vercel-connect.js";
import { buildBinding, buildConnection, harness } from "./harness.js";

/*
 * AC-VC-03: the workload leg and the management leg are separate credentials
 * with separate custody scopes, and using one where the other belongs is
 * rejected by construction.
 * AC-VC-04: a token acquired for an unauthorized project, environment,
 * subject or resource fails before provider access, with no fallback to a
 * broad personal token; and what the token response actually proves is
 * recorded as evidence, including when it proves no account at all.
 */

const TEAM = "team_fixture";
const PROJECT = "prj_main";
const CONNECTOR = "oauth/linear";
const APP_CONNECTOR = "slack/acme-slack";
const ANON_CONNECTOR = "api-key/mailer";
const MANAGEMENT_TOKEN = "vma_management_token";
const WORKLOAD_TOKEN = "oidc_workload_token";

const appSettings = (
  connector: string,
  overrides: Partial<VercelSettings> = {},
): VercelSettings => ({
  project: { id: PROJECT, environment: "production" },
  profiles: {
    app: {
      connector,
      subject: { type: "app" },
      installation: { mode: "installation-free" },
      scopes: ["read"],
    },
  },
  defaultProfile: "app",
  returnPath: "/connectors/vercel/return",
  ...overrides,
});

async function fixture(options: { tokenLifetimeMs?: number; now?: () => number } = {}) {
  return startVercelConnect({
    teamId: TEAM,
    ...(options.tokenLifetimeMs !== undefined
      ? { tokenLifetimeMs: options.tokenLifetimeMs }
      : {}),
    ...(options.now ? { now: options.now } : {}),
    connectors: [
      {
        uid: CONNECTOR,
        type: "oauth",
        service: "linear.app",
        supportedSubjectTypes: ["app", "user", "jwt-bearer"],
        scopes: ["read", "write"],
        projects: { [PROJECT]: ["production"] },
      },
      {
        uid: APP_CONNECTOR,
        type: "slack",
        service: "slack",
        supportsInstallation: true,
        installations: ["inst_a"],
        defaultInstallationId: "inst_a",
        tenantId: "T0ACME",
        scopes: ["chat:write"],
        projects: { [PROJECT]: ["production"] },
      },
      {
        uid: ANON_CONNECTOR,
        type: "api-key",
        service: "mailer.example",
        supportedSubjectTypes: ["app"],
        reportsExternalSubject: false,
        scopes: ["send"],
        projects: { [PROJECT]: ["production"] },
      },
    ],
    credentials: [
      { token: MANAGEMENT_TOKEN, kind: "management", teamId: TEAM },
      {
        token: WORKLOAD_TOKEN,
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
  settings: VercelSettings,
  options: {
    workloadToken?: string;
    managementToken?: string;
    connectors?: string[];
    projects?: string[];
    environments?: string[];
    connection?: Partial<Parameters<typeof buildConnection>[0]>;
    now?: () => number;
  } = {},
) {
  const h = harness(options.now ? { now: options.now } : {});
  h.ports.configuration.set("VERCEL_TEAM_ID", TEAM);
  h.ports.configuration.set(
    vercelConfigurationNames.managementToken,
    options.managementToken ?? MANAGEMENT_TOKEN,
  );
  h.ports.configuration.set(
    vercelConfigurationNames.workloadToken,
    options.workloadToken ?? WORKLOAD_TOKEN,
  );
  const binding = buildBinding({
    apiOrigin: double.origin,
    teamId: TEAM,
    settings,
    connectors: options.connectors ?? [CONNECTOR, APP_CONNECTOR, ANON_CONNECTOR],
    projects: options.projects ?? [PROJECT],
    environments: options.environments ?? ["production"],
    installations: ["inst_a"],
  });
  const connection = buildConnection({
    binding,
    ownerKind: "workload",
    ...options.connection,
  });
  return { h, binding, connection, ctx: h.context({ binding, connection }) };
}

test("the two credentials live in different custody scopes and cannot be swapped", async (t) => {
  const double = await fixture();
  t.after(double.close);
  const { h, ctx } = setup(double, appSettings(CONNECTOR));
  const settings = appSettings(CONNECTOR);
  const management = await resolveCredential(ctx, "management", settings);
  const workload = await resolveCredential(ctx, "workload", settings);

  assert.equal(credentialRole(management), "management");
  assert.equal(credentialRole(workload), "workload");
  assert.notEqual(management.ref, workload.ref);
  assert.equal(management.scope.ownerKind, "organization");
  assert.equal(workload.scope.ownerKind, "workload");
  assert.notEqual(management.scope.ownerId, workload.scope.ownerId);
  assert.notEqual(management.scope.connectionRef, workload.scope.connectionRef);

  // A handle of the wrong role is refused before a bearer header exists.
  await assert.rejects(
    withBearer(ctx, management as never, "workload", async () => "used"),
    (error: unknown) =>
      error instanceof ConnectorError &&
      error.detail === "vercel.credential.role-mismatch",
  );
  await assert.rejects(
    withBearer(ctx, workload as never, "management", async () => "used"),
    (error: unknown) =>
      error instanceof ConnectorError &&
      error.detail === "vercel.credential.role-mismatch",
  );
  // Nor can one credential's reference be opened under the other's scope.
  await assert.rejects(
    h.ports.credentials.use(workload.scope, management.ref, async () => "used"),
  );
  assert.equal(
    await withBearer(ctx, workload, "workload", async (bearer) => bearer),
    WORKLOAD_TOKEN,
  );
});

test("a management token configured as the workload credential is rejected upstream, with no fallback", async (t) => {
  const double = await fixture();
  t.after(double.close);
  double.grantApp(CONNECTOR, { scopes: ["read"] });
  const { ctx } = setup(double, appSettings(CONNECTOR), {
    workloadToken: MANAGEMENT_TOKEN,
  });
  const adapter = createVercelConnectAdapter();
  const result = await adapter.verify!(ctx);
  assert.equal(result.state, "denied");
  const call = double.routed("connect.token").at(-1)!;
  assert.equal(call.status, 403);
  assert.match(call.headers["authorization"] ?? "", /^Bearer vma_/);
  assert.equal(
    double.routed("connect.token").length,
    1,
    "a rejected workload credential is not retried with another credential",
  );
});

test("a workload token configured as the management credential is rejected upstream", async (t) => {
  const double = await fixture();
  t.after(double.close);
  const { ctx } = setup(double, appSettings(CONNECTOR), {
    managementToken: WORKLOAD_TOKEN,
  });
  const adapter = createVercelConnectAdapter();
  await assert.rejects(
    adapter.discover!(ctx, {}),
    (error: unknown) =>
      error instanceof ConnectorError &&
      error.code === "denied" &&
      error.detail === "vercel.forbidden",
  );
  const call = double.routed("connect.connectors.list").at(-1)!;
  assert.equal(call.status, 403);
  assert.match(call.headers["authorization"] ?? "", /^Bearer oidc_/);
});

test("the provider token reaches custody and nothing else", async (t) => {
  const double = await fixture();
  t.after(double.close);
  double.grantApp(CONNECTOR, { scopes: ["read"] });
  const { h, ctx } = setup(double, appSettings(CONNECTOR));
  const adapter = createVercelConnectAdapter();
  const result = await adapter.verify!(ctx);
  assert.equal(result.state, "complete");
  assert.ok(result.credentialRef);
  const issued = double.issuedTokens.at(-1)!;
  assert.equal(
    h.ports.inspect.credentialMaterial(result.credentialRef!)?.["token"],
    issued.token,
  );
  const serialized = JSON.stringify(result);
  assert.equal(
    serialized.includes(issued.token),
    false,
    "the token never appears in a completion result",
  );
  assert.equal(serialized.includes(issued.tokenId), false);
  assert.equal(
    JSON.stringify(result.adapterState).includes(issued.token),
    false,
    "nor in the state persisted on the connection",
  );
  const describe = await h.ports.credentials.describe(
    {
      tenantId: ctx.actor.tenantId,
      ownerKind: "workload",
      ownerId: `vercel-workload@${ctx.binding.bindingRef}`,
      connectionRef: "connection:vercel-1",
      bindingRef: ctx.binding.bindingRef,
      custody: "external-credential-broker",
    },
    result.credentialRef!,
  );
  assert.equal(
    describe?.custody,
    "external-credential-broker",
    "a Connect-vended token is broker custody, not host-owned",
  );
  assert.equal(describe?.expiresAt, issued.expiresAt);
});

test("verification names the target the token response reports, per subject kind", async (t) => {
  const double = await fixture();
  t.after(double.close);
  const adapter = createVercelConnectAdapter();

  const appOnSlack = setup(
    double,
    appSettings(APP_CONNECTOR, {
      profiles: {
        app: {
          connector: APP_CONNECTOR,
          subject: { type: "app" },
          installation: { mode: "installation-aware", installationId: "inst_a" },
          scopes: ["chat:write"],
        },
      },
    }),
  );
  double.grantApp(APP_CONNECTOR, {
    scopes: ["chat:write"],
    installationId: "inst_a",
  });
  const installed = await adapter.verify!(appOnSlack.ctx);
  assert.equal(installed.state, "complete");
  assert.deepEqual(installed.target, {
    kind: "provider-installation",
    id: "inst_a",
  });
  const claim = installed.claims[0]!;
  assert.equal(claim.kind, "credential-accepted");
  assert.equal(claim.issuer, "external-broker");
  assert.deepEqual(claim.permissions, {
    requested: ["chat:write"],
    reported: [],
    observed: [],
    semantics: "provider-scopes",
  });
  assert.ok(
    claim.limitations.some((item) => /scopes are not returned/.test(item)),
    "Vercel reports no granted scopes, and the claim says so",
  );
  assert.equal(
    installed.claims.some((item) => item.kind === "account-identity"),
    true,
  );

  // No installation, no tenant, no subject: identity is unknown and the
  // claim says exactly that rather than implying an account.
  const anonymous = setup(double, appSettings(ANON_CONNECTOR, {
    profiles: {
      app: {
        connector: ANON_CONNECTOR,
        subject: { type: "app" },
        installation: { mode: "installation-free" },
        scopes: ["send"],
      },
    },
  }));
  double.grantApp(ANON_CONNECTOR, { scopes: ["send"] });
  const unknown = await adapter.verify!(anonymous.ctx);
  assert.equal(unknown.state, "complete");
  assert.equal(unknown.target?.kind, "vercel-connector");
  assert.ok(unknown.claims[0]!.limitations.includes("account identity unknown"));
  assert.equal(
    unknown.claims.some((item) => item.kind === "account-identity"),
    false,
    "an unknown account produces no account-identity claim",
  );
});

test("an exact-account intent is not satisfied by a broker success without identity", async (t) => {
  const double = await fixture();
  t.after(double.close);
  double.grantApp(ANON_CONNECTOR, { scopes: ["send"] });
  const adapter = createVercelConnectAdapter();
  const settings = appSettings(ANON_CONNECTOR, {
    profiles: {
      app: {
        connector: ANON_CONNECTOR,
        subject: { type: "app" },
        installation: { mode: "installation-free" },
        scopes: ["send"],
      },
    },
  });
  const { h, binding, connection } = setup(double, settings);
  const intended = {
    ...connection,
    state: {
      vercel: {
        profileId: "app",
        subjectType: "app" as const,
        scopes: ["send"],
        connectorUid: ANON_CONNECTOR,
        connectorId: double.connector(ANON_CONNECTOR)!.id,
        connectorType: "api-key",
        expiresAt: 0,
        target: { kind: "provider-tenant", id: "expected-account" },
        identityKnown: false,
        intentTarget: { kind: "provider-tenant", id: "expected-account" },
      },
    },
  };
  const result = await adapter.verify!(
    h.context({ binding, connection: intended }),
  );
  assert.equal(
    result.state,
    "human-required",
    "transport success is not exact-account verification",
  );
  assert.equal(result.code, "vercel.identity.unverifiable");
});

test("a changed account is refused unless the human asked to switch", async (t) => {
  const double = await fixture();
  t.after(double.close);
  const adapter = createVercelConnectAdapter();
  const settings = appSettings(APP_CONNECTOR, {
    profiles: {
      app: {
        connector: APP_CONNECTOR,
        subject: { type: "app" },
        installation: { mode: "installation-aware", installationId: "inst_a" },
        scopes: ["chat:write"],
      },
    },
  });
  double.grantApp(APP_CONNECTOR, {
    scopes: ["chat:write"],
    installationId: "inst_a",
  });
  const { h, binding, connection } = setup(double, settings);
  const previous = {
    ...connection,
    state: {
      vercel: {
        profileId: "app",
        subjectType: "app" as const,
        scopes: ["chat:write"],
        connectorUid: APP_CONNECTOR,
        connectorId: double.connector(APP_CONNECTOR)!.id,
        connectorType: "slack",
        installationId: "inst_a",
        expiresAt: 0,
        target: { kind: "provider-installation", id: "inst_previous" },
        identityKnown: true,
      },
    },
  };
  const result = await adapter.verify!(
    h.context({ binding, connection: previous }),
  );
  assert.equal(result.state, "denied");
  assert.equal(result.code, "vercel.identity.changed");
});

test("an expired token is reacquired once, even under concurrent use", async (t) => {
  let clock = Date.parse("2026-09-18T09:00:00.000Z");
  const double = await fixture({ tokenLifetimeMs: 60_000, now: () => clock });
  t.after(double.close);
  double.grantApp(CONNECTOR, { scopes: ["read"] });
  const { h, binding, connection, ctx } = setup(double, appSettings(CONNECTOR), {
    now: () => clock,
  });
  const adapter = createVercelConnectAdapter();
  const first = await adapter.verify!(ctx);
  assert.equal(first.state, "complete");
  assert.equal(double.routed("connect.token").length, 1);

  const established = {
    ...connection,
    credentialRef: first.credentialRef!,
    state: first.adapterState as Record<string, unknown>,
  };
  // Still valid: verification reuses the stored credential.
  const cached = await adapter.verify!(
    h.context({ binding, connection: established }),
  );
  assert.equal(cached.state, "complete");
  assert.equal(cached.credentialRef, first.credentialRef);
  assert.equal(
    double.routed("connect.token").length,
    1,
    "a live token is not re-requested",
  );

  clock += 3_600_000;
  const concurrent = await Promise.all([
    adapter.verify!(h.context({ binding, connection: established })),
    adapter.verify!(h.context({ binding, connection: established })),
  ]);
  for (const result of concurrent) assert.equal(result.state, "complete");
  assert.equal(
    double.routed("connect.token").length,
    2,
    "two workers share one refresh instead of each acquiring a token",
  );
  assert.equal(
    h.ports.inspect.credentialMaterial(first.credentialRef!)?.["token"],
    double.issuedTokens.at(-1)!.token,
    "the refreshed material replaced the expired one in place",
  );
});

test("an unauthorized project or environment fails before the provider is asked", async (t) => {
  const double = await fixture();
  t.after(double.close);
  const adapter = createVercelConnectAdapter();

  // The binding does not permit the project the settings name.
  const wrongProject = setup(double, appSettings(CONNECTOR), {
    projects: ["prj_other"],
  });
  await assert.rejects(
    adapter.verify!(wrongProject.ctx),
    (error: unknown) =>
      error instanceof ConnectorError &&
      error.detail === "vercel.project.not-permitted",
  );
  // Nor the environment.
  const wrongEnvironment = setup(double, appSettings(CONNECTOR), {
    environments: ["preview"],
  });
  await assert.rejects(
    adapter.verify!(wrongEnvironment.ctx),
    (error: unknown) =>
      error instanceof ConnectorError &&
      error.detail === "vercel.environment.not-permitted",
  );
  assert.equal(double.routed("connect.token").length, 0);

  // And when the deployment identity itself is bound elsewhere, the provider
  // refuses and the adapter reports it without trying another credential.
  const elsewhere = await startVercelConnect({
    teamId: TEAM,
    connectors: [
      { uid: CONNECTOR, projects: { prj_elsewhere: ["production"] } },
    ],
    credentials: [
      { token: MANAGEMENT_TOKEN, kind: "management", teamId: TEAM },
      {
        token: WORKLOAD_TOKEN,
        kind: "workload",
        teamId: TEAM,
        projectId: PROJECT,
        environment: "production",
      },
    ],
  });
  t.after(elsewhere.close);
  const unlinked = setup(elsewhere, appSettings(CONNECTOR));
  const result = await adapter.verify!(unlinked.ctx);
  assert.equal(result.state, "denied");
  assert.equal(elsewhere.routed("connect.token").at(-1)!.status, 403);
});

test("the configured team must also be an approved target", async (t) => {
  const double = await fixture();
  t.after(double.close);
  const h = harness();
  h.ports.configuration.set("VERCEL_TEAM_ID", "team_unreviewed");
  h.ports.configuration.set(vercelConfigurationNames.workloadToken, WORKLOAD_TOKEN);
  const binding = buildBinding({
    apiOrigin: double.origin,
    teamId: TEAM,
    settings: appSettings(CONNECTOR),
    connectors: [CONNECTOR],
    projects: [PROJECT],
    environments: ["production"],
  });
  const adapter = createVercelConnectAdapter();
  await assert.rejects(
    adapter.verify!(
      h.context({ binding, connection: buildConnection({ binding }) }),
    ),
    (error: unknown) =>
      error instanceof ConnectorError &&
      error.detail === "vercel.team.not-permitted",
  );
  assert.equal(double.calls.length, 0);
});
