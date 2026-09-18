import { test } from "node:test";
import assert from "node:assert/strict";
import type {
  AdapterCallContext,
  ConnectionRecord,
  HandoffProposal,
  RuntimeBinding,
} from "../../../src/server/connectors/index.js";
import {
  connectAuthorizeResponseSchema,
  connectTokenResponseSchema,
  createVercelConnectAdapter,
  type VercelSettings,
} from "../../../src/server/connectors/providers/vercel/index.js";
import { startVercelConnect } from "../doubles/vercel-connect.js";
import {
  APP_ORIGIN,
  buildBinding,
  buildConnection,
  fixtureActor,
  harness,
  type Harness,
} from "./harness.js";

/*
 * AC-VC-02: installation-aware and installation-free connector types both
 * reach an appropriately scoped verification, and native optionality is
 * preserved - the adapter never invents an installation id.
 * AC-VC-05: an expired authorization request, an unexpected verifier or
 * expiry representation, a denial and a hijacked callback all fail safely.
 */

const TEAM = "team_fixture";
const PROJECT = "prj_main";
const RETURN_PATH = "/connectors/vercel/return";
const USER_CONNECTOR = "oauth/linear";
const SLACK_CONNECTOR = "slack/acme-slack";

const userSettings = (
  overrides: Partial<VercelSettings> = {},
): VercelSettings => ({
  project: { id: PROJECT, environment: "production" },
  profiles: {
    user: {
      connector: USER_CONNECTOR,
      subject: { type: "user", identity: "tenant-qualified-subject" },
      installation: { mode: "installation-free" },
      scopes: ["read", "write"],
    },
  },
  defaultProfile: "user",
  returnPath: RETURN_PATH,
  ...overrides,
});

async function fixture(
  options: { authorizationLifetimeMs?: number; now?: () => number } = {},
) {
  return startVercelConnect({
    teamId: TEAM,
    ...(options.authorizationLifetimeMs !== undefined
      ? { authorizationLifetimeMs: options.authorizationLifetimeMs }
      : {}),
    ...(options.now ? { now: options.now } : {}),
    connectors: [
      {
        uid: USER_CONNECTOR,
        type: "oauth",
        service: "linear.app",
        supportedSubjectTypes: ["app", "user"],
        scopes: ["read", "write"],
        projects: { [PROJECT]: ["production"] },
      },
      {
        uid: SLACK_CONNECTOR,
        type: "slack",
        service: "slack",
        supportsInstallation: true,
        installations: ["inst_workspace_a", "inst_workspace_b"],
        defaultInstallationId: "inst_workspace_a",
        tenantId: "T0ACME",
        supportedSubjectTypes: ["app", "user"],
        scopes: ["chat:write"],
        projects: { [PROJECT]: ["production"] },
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
  settings: VercelSettings,
  options: {
    connectors?: string[];
    installations?: string[];
    connection?: Partial<Parameters<typeof buildConnection>[0]>;
  } = {},
) {
  const test = harness();
  test.ports.configuration.set("VERCEL_TEAM_ID", TEAM);
  test.ports.configuration.set(
    "VERCEL_CONNECT_WORKLOAD_TOKEN",
    "oidc_workload_token",
  );
  test.ports.configuration.set(
    "VERCEL_MANAGEMENT_TOKEN",
    "vma_management_token",
  );
  const binding = buildBinding({
    apiOrigin: double.origin,
    teamId: TEAM,
    settings,
    connectors: options.connectors ?? [USER_CONNECTOR, SLACK_CONNECTOR],
    projects: [PROJECT],
    environments: ["production"],
    ...(options.installations ? { installations: options.installations } : {}),
  });
  const connection = buildConnection({ binding, ...options.connection });
  return {
    test,
    binding,
    connection,
    ctx: test.context({ binding, connection }),
  };
}

/** Issues the proposal the adapter returned, the way the command layer does. */
async function issue(
  test: Harness,
  ctx: AdapterCallContext,
  connection: ConnectionRecord,
  proposal: HandoffProposal,
) {
  const issued = await test.ports.handoffs.issue({
    ...proposal,
    actor: ctx.actor,
    connectionRef: connection.connectionRef,
    bindingRef: ctx.binding.bindingRef,
    generation: ctx.generation,
  });
  return issued;
}

const withHandoff = (
  connection: ConnectionRecord,
  handoffRef: string,
  binding: RuntimeBinding,
): ConnectionRecord => ({
  ...connection,
  handoff: {
    handoffRef,
    kind: "provider-browser",
    state: "issued",
    presentation: "popup",
    expiresAt: "2030-01-01T00:00:00.000Z",
    generation: connection.generation,
  },
  bindingRef: binding.bindingRef,
});

const returnUrl = (state: string, extra: Record<string, string> = {}) => {
  const url = new URL(RETURN_PATH, APP_ORIGIN);
  url.searchParams.set("state", state);
  for (const [name, value] of Object.entries(extra))
    url.searchParams.set(name, value);
  return url;
};

test("the documented response schema, not a stale example, decides the field types", () => {
  const body = {
    connector: {
      displayName: "Linear",
      id: "scl_1",
      name: "linear",
      type: "oauth",
      uid: USER_CONNECTOR,
    },
    request: "car_1",
    url: "https://connect.vercel.com/authorize/car_1",
    verifier: "v".repeat(43),
  };
  assert.equal(
    connectAuthorizeResponseSchema.safeParse({ ...body, expiresAt: 1700000000000 })
      .success,
    true,
  );
  assert.equal(
    connectAuthorizeResponseSchema.safeParse({ ...body, expiresAt: "123" })
      .success,
    false,
    "the rendered example prints expiresAt as a string; the schema types it as a number",
  );
  assert.equal(
    connectTokenResponseSchema.safeParse({
      token: "t",
      tokenId: "stk_1",
      expiresAt: "123",
      connector: { id: "scl_1", type: "oauth", uid: USER_CONNECTOR },
    }).success,
    false,
  );
});

test("a user subject gets a private handoff whose correlation is the request id", async (t) => {
  const double = await fixture();
  t.after(double.close);
  const { test: h, ctx, connection, binding } = setup(double, userSettings());
  const adapter = createVercelConnectAdapter();
  const start = await adapter.authorize!(ctx, {
    ownerKind: "user",
    requestedPermissions: [],
    accountSwitch: false,
    interruption: "allowed",
  });
  assert.equal(start.kind, "handoff");
  if (start.kind !== "handoff") return;
  const call = double.routed("connect.authorize").at(-1)!;
  assert.equal(call.version, "v1");
  assert.equal(call.path, "/v1/connect/authorize/oauth%2Flinear");
  assert.equal(
    call.query["teamId"],
    undefined,
    "the token and authorize endpoints take their team from the credential",
  );
  assert.match(
    call.headers["authorization"] ?? "",
    /^Bearer oidc_workload_token$/,
    "authorization uses the workload identity, never the management token",
  );
  const body = call.body as Record<string, unknown>;
  assert.deepEqual(body["subject"], {
    type: "user",
    id: `${fixtureActor.tenantId}:${fixtureActor.subjectId}`,
  });
  assert.deepEqual(body["scopes"], ["read", "write"]);
  assert.equal(
    Object.hasOwn(body, "installationId"),
    false,
    "an installation-free connector is never given a synthesized installation",
  );
  assert.equal(
    Object.hasOwn(body, "additionalParams"),
    false,
    "no caller-supplied pass-through parameters",
  );
  assert.equal(Object.hasOwn(body, "webhook"), false);
  assert.equal(
    new URL(body["returnUrl"] as string).origin,
    APP_ORIGIN,
    "the return route is built from the deployment origin",
  );

  const requestId = (
    double.routed("connect.authorize").at(-1)!.body as Record<string, unknown>
  )["subject"]
    ? Object.values(double.calls).length
    : 0;
  assert.ok(requestId >= 0);
  assert.equal(
    start.handoff.correlationKey,
    start.handoff.private["request"],
    "the returned request id is the correlation key",
  );
  assert.match(start.handoff.private["url"] ?? "", /^http:\/\/127\.0\.0\.1:/);
  assert.ok(start.handoff.private["verifier"]);
  assert.ok(start.handoff.private["state"]);
  assert.equal(start.handoff.kind, "provider-browser");
  assert.equal(start.handoff.presentation, "popup");

  // The issued record keeps that material private and out of any summary.
  const issued = await issue(h, ctx, connection, start.handoff);
  assert.equal(
    Object.hasOwn(issued.summary, "private"),
    false,
    "the public summary carries no URL, verifier or state",
  );
  assert.equal(issued.summary.kind, "provider-browser");
  assert.equal(issued.summary.generation, connection.generation);
  void binding;
});

test("an app subject has no consent leg and an interruption ban yields human-required", async (t) => {
  const double = await fixture();
  t.after(double.close);
  const appSettings: VercelSettings = {
    project: { id: PROJECT, environment: "production" },
    profiles: {
      app: {
        connector: SLACK_CONNECTOR,
        subject: { type: "app" },
        installation: { mode: "installation-aware" },
        scopes: ["chat:write"],
      },
    },
    defaultProfile: "app",
    returnPath: RETURN_PATH,
  };
  const { ctx } = setup(double, appSettings);
  const adapter = createVercelConnectAdapter();
  const start = await adapter.authorize!(ctx, {
    ownerKind: "workload",
    requestedPermissions: [],
    accountSwitch: false,
    interruption: "allowed",
  });
  assert.deepEqual(start, { kind: "verify" });
  assert.equal(double.routed("connect.authorize").length, 0);

  const { ctx: userCtx } = setup(double, userSettings());
  const blocked = await adapter.authorize!(userCtx, {
    ownerKind: "user",
    requestedPermissions: [],
    accountSwitch: false,
    interruption: "none",
  });
  assert.deepEqual(blocked, {
    kind: "human-required",
    code: "vercel.consent-required",
  });
});

test("missing configuration is reported before any provider call", async (t) => {
  const double = await fixture();
  t.after(double.close);
  const h = harness();
  h.ports.configuration.set("VERCEL_TEAM_ID", TEAM);
  const binding = buildBinding({
    apiOrigin: double.origin,
    teamId: TEAM,
    settings: userSettings(),
    connectors: [USER_CONNECTOR],
    projects: [PROJECT],
    environments: ["production"],
  });
  const connection = buildConnection({ binding });
  const adapter = createVercelConnectAdapter();
  const start = await adapter.authorize!(
    h.context({ binding, connection }),
    {
      ownerKind: "user",
      requestedPermissions: [],
      accountSwitch: false,
      interruption: "allowed",
    },
  );
  assert.deepEqual(start, {
    kind: "configuration-required",
    missing: ["VERCEL_CONNECT_WORKLOAD_TOKEN"],
  });
  assert.equal(double.calls.length, 0);
});

test("completion is decided by the token endpoint, not by the redirect", async (t) => {
  const double = await fixture();
  t.after(double.close);
  const { test: h, ctx, connection, binding } = setup(double, userSettings());
  const adapter = createVercelConnectAdapter();
  const start = await adapter.authorize!(ctx, {
    ownerKind: "user",
    requestedPermissions: [],
    accountSwitch: false,
    interruption: "allowed",
  });
  assert.equal(start.kind, "handoff");
  if (start.kind !== "handoff") return;
  const issued = await issue(h, ctx, connection, start.handoff);
  const linked = withHandoff(connection, issued.handoffRef, binding);
  const pendingCtx = h.context({ binding, connection: linked });

  // The person has not consented yet: the redirect alone proves nothing.
  const premature = await adapter.complete!(pendingCtx, {
    kind: "redirect",
    url: returnUrl(start.handoff.private["state"]!),
  });
  assert.equal(premature.state, "pending");
  assert.equal(premature.code, "vercel.authorization.pending");

  const approval = double.approve(start.handoff.private["request"]!);
  const completed = await adapter.complete!(pendingCtx, {
    kind: "redirect",
    url: returnUrl(start.handoff.private["state"]!),
  });
  assert.equal(completed.state, "complete");
  assert.ok(completed.credentialRef);
  assert.equal(
    completed.target?.kind,
    "provider-user",
    "a user subject is verified as a provider user",
  );
  assert.equal(completed.target?.id, approval.externalSubject);
  assert.equal(
    completed.externalIds?.["externalSubject"],
    approval.externalSubject,
  );
  assert.equal(
    JSON.stringify(completed).includes("provider_"),
    false,
    "the provider token never appears in a completion result",
  );
  const material = h.ports.inspect.credentialMaterial(completed.credentialRef!);
  assert.match(material?.["token"] ?? "", /^provider_/);

  // One-use: the same redirect cannot be replayed.
  const replay = await adapter.complete!(pendingCtx, {
    kind: "redirect",
    url: returnUrl(start.handoff.private["state"]!),
  });
  assert.equal(replay.state, "denied");
  assert.equal(replay.code, "vercel.handoff.consumed");
});

test("polling completes the same authorized intent without a redirect", async (t) => {
  const double = await fixture();
  t.after(double.close);
  const { test: h, ctx, connection, binding } = setup(double, userSettings());
  const adapter = createVercelConnectAdapter();
  const start = await adapter.authorize!(ctx, {
    ownerKind: "user",
    requestedPermissions: [],
    accountSwitch: false,
    interruption: "allowed",
  });
  if (start.kind !== "handoff") throw new Error("expected a handoff");
  const issued = await issue(h, ctx, connection, start.handoff);
  const polling = h.context({
    binding,
    connection: withHandoff(connection, issued.handoffRef, binding),
  });
  const waiting = await adapter.complete!(polling, { kind: "poll" });
  assert.equal(waiting.state, "pending");
  double.approve(start.handoff.private["request"]!);
  const done = await adapter.complete!(polling, { kind: "poll" });
  assert.equal(done.state, "complete");
});

test("a hijacked or mis-stated callback cannot complete a handoff", async (t) => {
  const double = await fixture();
  t.after(double.close);
  const { test: h, ctx, connection, binding } = setup(double, userSettings());
  const adapter = createVercelConnectAdapter();
  const start = await adapter.authorize!(ctx, {
    ownerKind: "user",
    requestedPermissions: [],
    accountSwitch: false,
    interruption: "allowed",
  });
  if (start.kind !== "handoff") throw new Error("expected a handoff");
  const issued = await issue(h, ctx, connection, start.handoff);
  double.approve(start.handoff.private["request"]!);
  const linked = withHandoff(connection, issued.handoffRef, binding);

  const wrongState = await adapter.complete!(
    h.context({ binding, connection: linked }),
    { kind: "redirect", url: returnUrl("not-the-state") },
  );
  assert.equal(wrongState.state, "denied");
  assert.equal(wrongState.code, "vercel.return.state-mismatch");

  const foreignOrigin = new URL(
    `${RETURN_PATH}?state=${start.handoff.private["state"]}`,
    "https://attacker.example",
  );
  const wrongOrigin = await adapter.complete!(
    h.context({ binding, connection: linked }),
    { kind: "redirect", url: foreignOrigin },
  );
  assert.equal(wrongOrigin.state, "denied");
  assert.equal(wrongOrigin.code, "vercel.return.untrusted");

  // Another authenticated subject cannot see this handoff at all, so the
  // flow simply stays pending for them; nothing is disclosed.
  const otherActor = { ...fixtureActor, subjectId: "subject-2" };
  const foreignActor = await adapter.complete!(
    h.context({ binding, connection: linked, actor: otherActor }),
    { kind: "redirect", url: returnUrl(start.handoff.private["state"]!) },
  );
  assert.equal(foreignActor.state, "pending");
  assert.equal(foreignActor.code, "vercel.handoff.unresolved");

  // Nor by naming the real correlation key: the record is bound to the
  // subject that started it.
  const stolen = await adapter.complete!(
    h.context({ binding, connection: linked, actor: otherActor }),
    {
      kind: "redirect",
      url: returnUrl(start.handoff.private["state"]!, {
        request: start.handoff.private["request"]!,
      }),
    },
  );
  assert.equal(stolen.state, "denied");
  assert.equal(stolen.code, "vercel.handoff.foreign");
  assert.equal(
    double.routed("connect.token").length,
    0,
    "no token was requested for a hijacked callback",
  );

  const stale = await adapter.complete!(
    h.context({
      binding,
      connection: { ...linked, generation: 2 },
      generation: 2,
    }),
    { kind: "redirect", url: returnUrl(start.handoff.private["state"]!) },
  );
  assert.equal(stale.state, "denied");
  assert.equal(
    stale.code,
    "vercel.handoff.stale-generation",
    "a callback for an older generation cannot revive it",
  );

  const declined = await adapter.complete!(
    h.context({ binding, connection: linked }),
    {
      kind: "redirect",
      url: returnUrl(start.handoff.private["state"]!, {
        error: "access_denied",
      }),
    },
  );
  assert.equal(declined.state, "denied");
  assert.equal(declined.code, "vercel.authorization.denied");
});

test("an expired authorization request fails safely", async (t) => {
  let clock = Date.parse("2026-09-18T10:00:00.000Z");
  const double = await fixture({
    authorizationLifetimeMs: 60_000,
    now: () => clock,
  });
  t.after(double.close);
  const h = harness({ now: () => clock });
  h.ports.configuration.set("VERCEL_TEAM_ID", TEAM);
  h.ports.configuration.set(
    "VERCEL_CONNECT_WORKLOAD_TOKEN",
    "oidc_workload_token",
  );
  const binding = buildBinding({
    apiOrigin: double.origin,
    teamId: TEAM,
    settings: userSettings(),
    connectors: [USER_CONNECTOR],
    projects: [PROJECT],
    environments: ["production"],
  });
  const connection = buildConnection({ binding });
  const adapter = createVercelConnectAdapter();
  const ctx = h.context({ binding, connection });
  const start = await adapter.authorize!(ctx, {
    ownerKind: "user",
    requestedPermissions: [],
    accountSwitch: false,
    interruption: "allowed",
  });
  if (start.kind !== "handoff") throw new Error("expected a handoff");
  const issued = await issue(h, ctx, connection, start.handoff);
  double.approve(start.handoff.private["request"]!);
  clock += 3_600_000;
  const expired = await adapter.complete!(
    h.context({
      binding,
      connection: withHandoff(connection, issued.handoffRef, binding),
    }),
    { kind: "redirect", url: returnUrl(start.handoff.private["state"]!) },
  );
  assert.equal(expired.state, "expired");
  assert.equal(expired.code, "vercel.authorization.expired");
  assert.equal(
    double.routed("connect.token").length,
    0,
    "an expired request never reaches the token endpoint",
  );
});

test("installation-aware and installation-free connectors both verify, each in its own scope", async (t) => {
  const double = await fixture();
  t.after(double.close);
  const adapter = createVercelConnectAdapter();

  // Installation-aware, explicit installation: the id travels, and the
  // verified target is that installation.
  const explicit: VercelSettings = {
    project: { id: PROJECT, environment: "production" },
    profiles: {
      app: {
        connector: SLACK_CONNECTOR,
        subject: { type: "app" },
        installation: {
          mode: "installation-aware",
          installationId: "inst_workspace_b",
        },
        scopes: ["chat:write"],
      },
    },
    defaultProfile: "app",
    returnPath: RETURN_PATH,
  };
  const scoped = setup(double, explicit, {
    installations: ["inst_workspace_b"],
    connection: { ownerKind: "workload" },
  });
  double.grantApp(SLACK_CONNECTOR, {
    scopes: ["chat:write"],
    installationId: "inst_workspace_b",
  });
  const verified = await adapter.verify!(scoped.ctx);
  assert.equal(verified.state, "complete");
  assert.deepEqual(verified.target, {
    kind: "provider-installation",
    id: "inst_workspace_b",
  });
  assert.equal(
    (double.routed("connect.token").at(-1)!.body as Record<string, unknown>)[
      "installationId"
    ],
    "inst_workspace_b",
  );

  // Installation-aware, no id: the request omits it and Vercel applies the
  // connector's default. Nothing is synthesized locally.
  const defaulted: VercelSettings = {
    ...explicit,
    profiles: {
      app: {
        ...explicit.profiles["app"]!,
        installation: { mode: "installation-aware" },
      },
    },
  };
  const fallback = setup(double, defaulted, {
    connection: { ownerKind: "workload" },
  });
  double.grantApp(SLACK_CONNECTOR, {
    scopes: ["chat:write"],
    installationId: "inst_workspace_a",
  });
  const byDefault = await adapter.verify!(fallback.ctx);
  assert.equal(byDefault.state, "complete");
  assert.equal(
    Object.hasOwn(
      double.routed("connect.token").at(-1)!.body as Record<string, unknown>,
      "installationId",
    ),
    false,
    "an absent installation stays absent on the wire",
  );
  assert.deepEqual(byDefault.target, {
    kind: "provider-installation",
    id: "inst_workspace_a",
  });

  // Installation-free: sending an installation id at all would be rejected by
  // the provider, so the adapter must not send one.
  const free = setup(double, {
    project: { id: PROJECT, environment: "production" },
    profiles: {
      app: {
        connector: USER_CONNECTOR,
        subject: { type: "app" },
        installation: { mode: "installation-free" },
        scopes: ["read"],
      },
    },
    defaultProfile: "app",
    returnPath: RETURN_PATH,
  }, { connection: { ownerKind: "workload" } });
  double.grantApp(USER_CONNECTOR, { scopes: ["read"] });
  const plain = await adapter.verify!(free.ctx);
  assert.equal(plain.state, "complete");
  const body = double.routed("connect.token").at(-1)!.body as Record<
    string,
    unknown
  >;
  assert.equal(Object.hasOwn(body, "installationId"), false);
  assert.equal(
    plain.target?.kind,
    "vercel-connector",
    "with no installation, tenant or subject reported, identity stays unknown",
  );
  assert.ok(
    plain.claims[0]!.limitations.includes("account identity unknown"),
  );
});

test("an unpermitted installation is refused before the provider is asked", async (t) => {
  const double = await fixture();
  t.after(double.close);
  const adapter = createVercelConnectAdapter();
  const { ctx } = setup(
    double,
    {
      project: { id: PROJECT, environment: "production" },
      profiles: {
        app: {
          connector: SLACK_CONNECTOR,
          subject: { type: "app" },
          installation: {
            mode: "installation-aware",
            installationId: "inst_workspace_b",
          },
          scopes: ["chat:write"],
        },
      },
      defaultProfile: "app",
      returnPath: RETURN_PATH,
    },
    { installations: ["inst_workspace_a"], connection: { ownerKind: "workload" } },
  );
  const before = double.calls.length;
  await assert.rejects(adapter.verify!(ctx), (error: unknown) => {
    assert.ok(error instanceof Error);
    assert.match(String((error as { detail?: string }).detail), /installation/);
    return true;
  });
  assert.equal(double.calls.length, before);
});

test("scopes come from the approved profile; a wider request is refused locally", async (t) => {
  const double = await fixture();
  t.after(double.close);
  const { ctx } = setup(double, userSettings());
  const adapter = createVercelConnectAdapter();
  const before = double.calls.length;
  await assert.rejects(
    adapter.authorize!(ctx, {
      ownerKind: "user",
      requestedPermissions: ["read", "admin"],
      accountSwitch: false,
      interruption: "allowed",
    }),
    (error: unknown) =>
      (error as { detail?: string }).detail === "vercel.scopes.not-approved",
  );
  assert.equal(double.calls.length, before);

  const narrowed = await adapter.authorize!(ctx, {
    ownerKind: "user",
    requestedPermissions: ["read"],
    accountSwitch: false,
    interruption: "allowed",
  });
  assert.equal(narrowed.kind, "handoff");
  assert.deepEqual(
    (double.routed("connect.authorize").at(-1)!.body as Record<string, unknown>)[
      "scopes"
    ],
    ["read"],
    "a caller may narrow within the profile",
  );
});

test("an owner kind that contradicts the profile's subject is refused", async (t) => {
  const double = await fixture();
  t.after(double.close);
  const { ctx } = setup(double, userSettings());
  const adapter = createVercelConnectAdapter();
  await assert.rejects(
    adapter.authorize!(ctx, {
      ownerKind: "organization",
      requestedPermissions: [],
      accountSwitch: false,
      interruption: "allowed",
    }),
    (error: unknown) =>
      (error as { detail?: string }).detail ===
      "vercel.subject.owner-kind-mismatch",
    "a user-subject profile does not issue organization-owned connections",
  );
});
