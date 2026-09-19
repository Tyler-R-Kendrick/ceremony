import assert from "node:assert/strict";
import { after, test } from "node:test";
import { agentConnectorProjection } from "../../../src/core/connectors/index.js";
import { ConnectorError } from "../../../src/server/connectors/errors.js";
import type {
  AuthorizationIntent,
  AuthorizationStart,
} from "../../../src/server/connectors/adapter.js";
import {
  DEPLOYMENT_ORIGIN,
  RETURN_PATH,
  fixtureActor,
  handoffPrivate,
  issueHandoff,
  makeBinding,
  makeConnection,
  makeContext,
  otherTenantActor,
  startHarness,
  type Harness,
} from "./harness.js";

/*
 * PD-02: restricted hosted connect. These tests watch the wire the double
 * recorded, not the adapter's own account of itself: what external user the
 * token was issued for, which origins it allows, where it may return to, and
 * what it takes to move a connection from one account to another.
 */

const open: Harness[] = [];
async function harness(options: Parameters<typeof startHarness>[0] = {}) {
  const started = await startHarness(options);
  open.push(started);
  return started;
}
after(async () => {
  for (const item of open) await item.close();
});

function connectContext(
  h: Harness,
  overrides: {
    actor?: typeof fixtureActor;
    externalIds?: Record<string, string>;
    credentialRef?: string;
    handoff?: ReturnType<typeof makeConnection>["handoff"];
    connectionRef?: string;
  } = {},
) {
  const binding = makeBinding({ apiOrigin: h.double.origin });
  const actor = overrides.actor ?? fixtureActor;
  const connection = makeConnection({
    binding,
    actor,
    lifecycle: "authorization-required",
    ...(overrides.connectionRef
      ? { connectionRef: overrides.connectionRef }
      : {}),
    ...(overrides.credentialRef
      ? { credentialRef: overrides.credentialRef }
      : {}),
    ...(overrides.handoff ? { handoff: overrides.handoff } : {}),
    externalIds: overrides.externalIds ?? {
      projectId: h.double.projectId,
      environment: h.environment,
      app: h.app,
      externalUserId: h.externalUserId(actor),
    },
  });
  return {
    binding,
    connection,
    ctx: makeContext({ harness: h, binding, connection, actor }),
  };
}

const intent: AuthorizationIntent = {
  ownerKind: "user",
  requestedPermissions: [],
  accountSwitch: false,
  interruption: "allowed",
};

function handoffOf(start: AuthorizationStart) {
  assert.equal(start.kind, "handoff");
  if (start.kind !== "handoff") throw new Error("unreachable");
  return start.handoff;
}

test("a connect token names the derived external user, this app and this origin only", async () => {
  const h = await harness();
  const { ctx } = connectContext(h);
  const start = await h.adapter.authorize!(ctx, intent);
  const handoff = handoffOf(start);

  assert.equal(handoff.kind, "connect-widget");
  const [token] = [...h.double.connectTokens.values()];
  assert.ok(token, "the double issued exactly one connect token");
  assert.equal(h.double.connectTokens.size, 1);

  // The external user is the host's derived id, never the subject id.
  assert.equal(token.external_user_id, h.externalUserId());
  assert.match(token.external_user_id, /^cer_[0-9a-f]{64}$/);
  assert.notEqual(token.external_user_id, fixtureActor.subjectId);

  // allowed_origins is the deployment origin and nothing else.
  assert.deepEqual(token.allowed_origins, [DEPLOYMENT_ORIGIN]);
  assert.equal(
    token.success_redirect_uri?.startsWith(
      `${DEPLOYMENT_ORIGIN}${RETURN_PATH}?`,
    ),
    true,
  );
  assert.equal(
    token.error_redirect_uri?.startsWith(`${DEPLOYMENT_ORIGIN}${RETURN_PATH}?`),
    true,
  );
  assert.equal(
    new URL(token.webhook_uri!).origin,
    DEPLOYMENT_ORIGIN,
    "connection webhooks return to the deployment, not to an input-supplied host",
  );

  // The request carried the documented environment header and a bearer token.
  const [request] = h.double.received(
    "POST",
    `/v1/connect/${h.double.projectId}/tokens`,
  );
  assert.ok(request);
  assert.equal(request.headers["x-pd-environment"], "production");
  assert.match(request.headers.authorization ?? "", /^Bearer pdat_/);

  // The Connect Link is private and restricted to the binding's one app.
  const link = new URL(handoff.private.connectLinkUrl!);
  assert.equal(link.origin, "https://pipedream.com");
  assert.equal(link.searchParams.get("app"), "slack");
  assert.equal(link.searchParams.get("token"), token.token);
  assert.notEqual(
    handoff.correlationKey,
    token.token,
    "the correlation index holds a digest, not the token",
  );
  assert.match(handoff.correlationKey ?? "", /^[0-9a-f]{64}$/);
});

test("the external user id is host-derived: another tenant is another external user", async () => {
  const h = await harness();
  const first = connectContext(h);
  await h.adapter.authorize!(first.ctx, intent);

  const otherBinding = makeBinding({
    apiOrigin: h.double.origin,
    tenantId: otherTenantActor.tenantId,
  });
  const otherConnection = makeConnection({
    binding: otherBinding,
    actor: otherTenantActor,
    lifecycle: "authorization-required",
    externalIds: {},
  });
  await h.adapter.authorize!(
    makeContext({
      harness: h,
      binding: otherBinding,
      connection: otherConnection,
      actor: otherTenantActor,
    }),
    intent,
  );

  const ids = [...h.double.connectTokens.values()].map(
    (token) => token.external_user_id,
  );
  assert.equal(ids.length, 2);
  assert.notEqual(ids[0], ids[1]);
  assert.equal(ids[0], h.externalUserId(fixtureActor));
  assert.equal(ids[1], h.externalUserId(otherTenantActor));
});

test("a policy that forbids interruption asks for a person rather than bypassing consent", async () => {
  const h = await harness();
  const { ctx } = connectContext(h);
  const start = await h.adapter.authorize!(ctx, {
    ...intent,
    interruption: "none",
  });
  assert.equal(start.kind, "human-required");
  assert.equal(h.double.connectTokens.size, 0);
});

test("completion binds the account the flow produced for this external user", async () => {
  const h = await harness();
  const { binding, connection, ctx } = connectContext(h);
  const start = await h.adapter.authorize!(ctx, intent);
  const proposal = handoffOf(start);
  const issued = await issueHandoff(h, proposal, connection);
  const material = await handoffPrivate(h, issued.handoffRef);

  // Another host's user connects an account of the same app at the same time.
  h.double.seedAccount({
    externalUserId: "someone-else",
    app: "slack",
    environment: "production",
    id: "apn_foreign",
  });
  const account = h.double.completeConnect(material.connectToken!, {
    app: "slack",
    name: "workspace@example.com",
  });

  const bound = { ...connection, handoff: issued.summary };
  const result = await h.adapter.complete!(
    makeContext({ harness: h, binding, connection: bound }),
    {
      kind: "redirect",
      url: new URL(
        `${DEPLOYMENT_ORIGIN}${RETURN_PATH}?state=${material.returnState}&outcome=success`,
      ),
    },
  );

  assert.equal(result.state, "complete");
  assert.equal(result.externalIds?.accountId, account.id);
  assert.notEqual(result.externalIds?.accountId, "apn_foreign");
  assert.equal(result.externalIds?.environment, "production");
  assert.equal(result.externalIds?.externalUserId, h.externalUserId());
  assert.equal(result.target?.id, account.id);
  assert.ok(result.credentialRef);
  assert.ok(
    result.claims.some((claim) => claim.kind === "account-identity"),
    "an account-identity claim names the observed account",
  );
  assert.ok(
    result.claims[0]!.limitations.join(" ").includes("broker"),
    "evidence says what it does not establish",
  );
});

test("a webhook hint naming another user's account is refused", async () => {
  const h = await harness();
  const { binding, connection, ctx } = connectContext(h);
  const start = await h.adapter.authorize!(ctx, intent);
  const issued = await issueHandoff(h, handoffOf(start), connection);
  const material = await handoffPrivate(h, issued.handoffRef);
  const foreign = h.double.seedAccount({
    externalUserId: "someone-else",
    app: "slack",
    environment: "production",
  });

  const bound = { ...connection, handoff: issued.summary };
  await assert.rejects(
    h.adapter.complete!(
      makeContext({ harness: h, binding, connection: bound }),
      {
        kind: "input",
        values: {
          connect_token: material.connectToken!,
          event: "CONNECTION_SUCCESS",
          account_id: foreign.id,
        },
      },
    ),
    (error: unknown) =>
      error instanceof ConnectorError &&
      error.code === "denied" &&
      error.detail === "pipedream.account.mismatch",
  );
});

test("an account connected in development is not a production connection", async () => {
  const h = await harness({ environment: "production" });
  const { binding, connection, ctx } = connectContext(h);
  const start = await h.adapter.authorize!(ctx, intent);
  const issued = await issueHandoff(h, handoffOf(start), connection);
  const material = await handoffPrivate(h, issued.handoffRef);

  // The same external user connected this app, but in the other environment.
  h.double.seedAccount({
    externalUserId: h.externalUserId(),
    app: "slack",
    environment: "development",
    id: "apn_devonly",
  });

  const result = await h.adapter.complete!(
    makeContext({
      harness: h,
      binding,
      connection: { ...connection, handoff: issued.summary },
    }),
    {
      kind: "redirect",
      url: new URL(
        `${DEPLOYMENT_ORIGIN}${RETURN_PATH}?state=${material.returnState}&outcome=success`,
      ),
    },
  );
  assert.equal(result.state, "pending");
  assert.equal(result.code, "pipedream.connect.pending");
  void material;
});

test("a connection recorded in one environment is refused under the other", async () => {
  const h = await harness({ environment: "production" });
  const binding = makeBinding({ apiOrigin: h.double.origin });
  const connection = makeConnection({
    binding,
    externalIds: {
      projectId: h.double.projectId,
      environment: "development",
      app: "slack",
      externalUserId: h.externalUserId(),
    },
  });
  await assert.rejects(
    h.adapter.verify!(makeContext({ harness: h, binding, connection })),
    (error: unknown) =>
      error instanceof ConnectorError &&
      error.detail === "pipedream.environment.mismatch",
  );
});

test("a connection whose external user is not the caller's derived id is refused", async () => {
  const h = await harness();
  const binding = makeBinding({ apiOrigin: h.double.origin });
  const connection = makeConnection({
    binding,
    externalIds: {
      projectId: h.double.projectId,
      environment: h.environment,
      app: "slack",
      externalUserId: "cer_" + "0".repeat(64),
    },
  });
  await assert.rejects(
    h.adapter.verify!(makeContext({ harness: h, binding, connection })),
    (error: unknown) =>
      error instanceof ConnectorError &&
      error.detail === "pipedream.external-user.mismatch",
  );
});

test("a completion link cannot be replayed and a wrong state is refused", async () => {
  const h = await harness();
  const { binding, connection, ctx } = connectContext(h);
  const start = await h.adapter.authorize!(ctx, intent);
  const issued = await issueHandoff(h, handoffOf(start), connection);
  const material = await handoffPrivate(h, issued.handoffRef);
  h.double.completeConnect(material.connectToken!, { app: "slack" });
  const bound = { ...connection, handoff: issued.summary };
  const redirect = (state: string) => ({
    kind: "redirect" as const,
    url: new URL(
      `${DEPLOYMENT_ORIGIN}${RETURN_PATH}?state=${state}&outcome=success`,
    ),
  });

  await assert.rejects(
    h.adapter.complete!(
      makeContext({ harness: h, binding, connection: bound }),
      redirect("not-the-state"),
    ),
    (error: unknown) =>
      error instanceof ConnectorError &&
      error.detail === "pipedream.return.state",
  );

  const first = await h.adapter.complete!(
    makeContext({ harness: h, binding, connection: bound }),
    redirect(material.returnState!),
  );
  assert.equal(first.state, "complete");

  const replay = await h.adapter.complete!(
    makeContext({ harness: h, binding, connection: bound }),
    redirect(material.returnState!),
  ).catch((error: unknown) => error);
  assert.ok(
    replay instanceof ConnectorError && replay.code === "expired",
    "a completed handoff cannot be completed a second time",
  );
});

test("a second account for the same app never replaces a bound one silently", async () => {
  const h = await harness();
  const { binding, connection: base } = connectContext(h);
  const first = h.double.seedAccount({
    externalUserId: h.externalUserId(),
    app: "slack",
    environment: "production",
    id: "apn_first",
  });
  const connection = {
    ...base,
    lifecycle: "active" as const,
    externalIds: { ...base.externalIds, accountId: first.id },
  };

  const start = await h.adapter.reconnect!(
    makeContext({ harness: h, binding, connection }),
    intent,
  );
  const issued = await issueHandoff(h, handoffOf(start), connection);
  const material = await handoffPrivate(h, issued.handoffRef);
  assert.equal(material.boundAccountId, first.id);
  assert.equal(material.accountSwitch, "false");

  // The person connects a second workspace instead of the bound one.
  h.double.completeConnect(material.connectToken!, {
    app: "slack",
    id: "apn_second",
  });

  const refused = await h.adapter.complete!(
    makeContext({
      harness: h,
      binding,
      connection: { ...connection, handoff: issued.summary },
    }),
    {
      kind: "redirect",
      url: new URL(
        `${DEPLOYMENT_ORIGIN}${RETURN_PATH}?state=${material.returnState}&outcome=success`,
      ),
    },
  );
  assert.equal(refused.state, "denied");
  assert.equal(refused.code, "pipedream.account.switch-required");
  assert.equal(refused.externalIds, undefined);
  assert.equal(refused.credentialRef, undefined);
});

test("an explicit account switch that names the account binds it", async () => {
  const h = await harness();
  const { binding, connection: base } = connectContext(h);
  const first = h.double.seedAccount({
    externalUserId: h.externalUserId(),
    app: "slack",
    environment: "production",
    id: "apn_first",
  });
  const second = h.double.seedAccount({
    externalUserId: h.externalUserId(),
    app: "slack",
    environment: "production",
    id: "apn_second",
  });
  const connection = {
    ...base,
    lifecycle: "active" as const,
    externalIds: { ...base.externalIds, accountId: first.id },
  };

  // Without the intent, naming another account does not even start a flow.
  const blocked = await h.adapter.reconnect!(
    makeContext({ harness: h, binding, connection }),
    {
      ...intent,
      target: { kind: "pipedream-account", id: second.id },
    },
  );
  assert.equal(blocked.kind, "human-required");

  const start = await h.adapter.reconnect!(
    makeContext({ harness: h, binding, connection }),
    {
      ...intent,
      accountSwitch: true,
      target: { kind: "pipedream-account", id: second.id },
    },
  );
  const issued = await issueHandoff(h, handoffOf(start), connection);
  const material = await handoffPrivate(h, issued.handoffRef);
  assert.equal(material.requestedAccountId, second.id);

  const switched = await h.adapter.complete!(
    makeContext({
      harness: h,
      binding,
      connection: { ...connection, handoff: issued.summary },
    }),
    {
      kind: "redirect",
      url: new URL(
        `${DEPLOYMENT_ORIGIN}${RETURN_PATH}?state=${material.returnState}&outcome=success`,
      ),
    },
  );
  assert.equal(switched.state, "complete");
  assert.equal(switched.externalIds?.accountId, second.id);
});

test("two fresh accounts for one app need an explicit selection", async () => {
  const h = await harness();
  const { binding, connection, ctx } = connectContext(h);
  const start = await h.adapter.authorize!(ctx, intent);
  const issued = await issueHandoff(h, handoffOf(start), connection);
  const material = await handoffPrivate(h, issued.handoffRef);
  h.double.seedAccount({
    externalUserId: h.externalUserId(),
    app: "slack",
    environment: "production",
    id: "apn_one",
  });
  h.double.seedAccount({
    externalUserId: h.externalUserId(),
    app: "slack",
    environment: "production",
    id: "apn_two",
  });

  const result = await h.adapter.complete!(
    makeContext({
      harness: h,
      binding,
      connection: { ...connection, handoff: issued.summary },
    }),
    {
      kind: "redirect",
      url: new URL(
        `${DEPLOYMENT_ORIGIN}${RETURN_PATH}?state=${material.returnState}&outcome=success`,
      ),
    },
  );
  assert.equal(result.state, "human-required");
  assert.equal(result.code, "pipedream.account.selection-required");
});

test("an error return denies the attempt without inventing a connection", async () => {
  const h = await harness();
  const { binding, connection, ctx } = connectContext(h);
  const start = await h.adapter.authorize!(ctx, intent);
  const issued = await issueHandoff(h, handoffOf(start), connection);
  const material = await handoffPrivate(h, issued.handoffRef);
  const result = await h.adapter.complete!(
    makeContext({
      harness: h,
      binding,
      connection: { ...connection, handoff: issued.summary },
    }),
    {
      kind: "input",
      values: {
        connect_token: material.connectToken!,
        event: "CONNECTION_ERROR",
      },
    },
  );
  assert.equal(result.state, "denied");
  assert.deepEqual(result.claims, []);
  assert.equal(result.credentialRef, undefined);
});

test("verification reports the broker's current view and flags an unhealthy account", async () => {
  const h = await harness();
  const binding = makeBinding({ apiOrigin: h.double.origin });
  const account = h.double.seedAccount({
    externalUserId: h.externalUserId(),
    app: "slack",
    environment: "production",
    scopes: ["chat:write"],
  });
  const base = makeConnection({ binding, externalIds: {} });
  const { bindAccount } = await import("./harness.js");
  const connection = await bindAccount(h, base, {
    accountId: account.id,
    externalUserId: h.externalUserId(),
    projectId: h.double.projectId,
    environment: "production",
    app: "slack",
  });

  const healthy = await h.adapter.verify!(
    makeContext({ harness: h, binding, connection }),
  );
  assert.equal(healthy.state, "complete");
  const identity = healthy.claims.find(
    (claim) => claim.kind === "account-identity",
  );
  assert.deepEqual(identity?.permissions?.reported, ["chat:write"]);
  assert.deepEqual(identity?.permissions?.requested, []);
  assert.deepEqual(identity?.permissions?.observed, []);

  account.healthy = false;
  account.error = "token expired";
  const unhealthy = await h.adapter.verify!(
    makeContext({ harness: h, binding, connection }),
  );
  assert.equal(unhealthy.state, "human-required");
  assert.equal(unhealthy.code, "pipedream.account.unhealthy");
  assert.equal(
    JSON.stringify(unhealthy).includes("token expired"),
    false,
    "provider text never leaves the adapter",
  );
});

test("no secret reaches a public projection of the connect flow", async () => {
  const h = await harness();
  const { binding, connection, ctx } = connectContext(h);
  const start = await h.adapter.authorize!(ctx, intent);
  const proposal = handoffOf(start);
  const issued = await issueHandoff(h, proposal, connection);
  const material = await handoffPrivate(h, issued.handoffRef);
  const account = h.double.completeConnect(material.connectToken!, {
    app: "slack",
  });
  const result = await h.adapter.complete!(
    makeContext({
      harness: h,
      binding,
      connection: { ...connection, handoff: issued.summary },
    }),
    {
      kind: "redirect",
      url: new URL(
        `${DEPLOYMENT_ORIGIN}${RETURN_PATH}?state=${material.returnState}&outcome=success`,
      ),
    },
  );

  const canaries = [
    h.double.clientSecret,
    material.connectToken!,
    material.returnState!,
    ...[...h.double.accessTokens.keys()],
    String(account.credentials.oauth_access_token),
    String(account.credentials.oauth_refresh_token),
  ];
  const publicSurfaces = JSON.stringify({
    summary: agentConnectorProjection({
      ...connection,
      lifecycle: "active",
      handoff: issued.summary,
    }),
    completion: result,
    handoffSummary: issued.summary,
    // The adapter's proposal minus the protected material the port holds.
    proposal: { ...proposal, private: undefined },
  });
  for (const canary of canaries)
    assert.equal(
      publicSurfaces.includes(canary),
      false,
      `secret leaked into a public surface: ${canary.slice(0, 12)}…`,
    );

  // The client secret only ever appears in the documented token request.
  const secretCarriers = h.double.requests.filter((request) =>
    request.body.toString("utf8").includes(h.double.clientSecret),
  );
  assert.equal(secretCarriers.length, 1);
  assert.equal(secretCarriers[0]!.url.pathname, "/v1/oauth/token");
});
