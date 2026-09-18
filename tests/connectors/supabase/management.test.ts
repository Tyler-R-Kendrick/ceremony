import assert from "node:assert/strict";
import { test } from "node:test";
import {
  createSupabaseManagementAdapter,
  supabaseLifecycleAfterDisconnect,
  supabaseLifecycleFor,
  type SupabaseAuthorizationStart,
} from "../../../src/server/connectors/providers/supabase/index.js";
import { ConnectorError } from "../../../src/server/connectors/errors.js";
import type {
  AdapterCallContext,
  AuthorizationIntent,
  CompletionResult,
  HandoffProposal,
} from "../../../src/server/connectors/adapter.js";
import { fixtureActor } from "../../doubles/ports.js";
import {
  managementOrganization,
  managementProject,
  startSupabaseManagementDouble,
  type SupabaseManagementDouble,
} from "../../doubles/supabase-management.js";
import {
  CALLBACK_PATH,
  HOST_ORIGIN,
  ORGANIZATION_SLUG,
  OTHER_ORGANIZATION_SLUG,
  OTHER_PROJECT_REF,
  PROJECT_REF,
  managementBinding,
  supabaseHarness,
  type SupabaseHarness,
} from "../fixtures/supabase/harness.js";

/*
 * SB-01 and SB-05 against an independent api.supabase.com double.
 * Oracles: AC-SB-02 (app-registered scopes, correct endpoints, PKCE, no
 * deprecated scope parameter), AC-SB-03 (target change invalidates evidence).
 */

const CLIENT_ID = "66666666-6666-4666-8666-666666666666";
const CLIENT_SECRET = "sb_secret_live_fixture_9f4d3a206b2e4a7e8c91";
const CONFIGURATION = {
  SUPABASE_OAUTH_CLIENT_ID: CLIENT_ID,
  SUPABASE_OAUTH_CLIENT_SECRET: CLIENT_SECRET,
};
const REDIRECT_URI = `${HOST_ORIGIN}${CALLBACK_PATH}`;
const adapter = createSupabaseManagementAdapter();

const intentFor = (
  overrides: Partial<AuthorizationIntent> = {},
): AuthorizationIntent => ({
  ownerKind: "user",
  requestedPermissions: [],
  accountSwitch: false,
  interruption: "allowed",
  ...overrides,
});

async function startDouble(
  options: Parameters<typeof startSupabaseManagementDouble>[0] = {},
) {
  const double = await startSupabaseManagementDouble({
    clientId: CLIENT_ID,
    clientSecret: CLIENT_SECRET,
    redirectUris: [REDIRECT_URI],
    projects: [managementProject(PROJECT_REF, ORGANIZATION_SLUG)],
    organizations: [managementOrganization(ORGANIZATION_SLUG)],
    ...options,
  });
  return double;
}

/** Issues the proposed handoff the way the command layer does, then returns the summary. */
async function issue(h: SupabaseHarness, proposal: HandoffProposal) {
  return h.ports.handoffs.issue({
    ...proposal,
    actor: fixtureActor,
    connectionRef: h.connection.connectionRef,
    bindingRef: h.ctx.binding.bindingRef,
    generation: h.ctx.generation,
  });
}

/** Walks the provider redirect exactly as a browser would; the adapter never fetches it. */
async function followAuthorization(url: string): Promise<URL> {
  const response = await fetch(url, { redirect: "manual" });
  assert.equal(response.status, 302);
  await response.body?.cancel();
  const location = response.headers.get("location");
  assert.ok(location, "authorize must redirect back to the registered route");
  return new URL(location);
}

async function connect(
  h: SupabaseHarness,
  target: { kind: string; id: string },
): Promise<{ result: CompletionResult; ctx: AdapterCallContext }> {
  const start = await adapter.authorize(h.ctx, intentFor({ target }));
  assert.equal(start.kind, "handoff");
  const proposal = (start as { handoff: HandoffProposal }).handoff;
  await issue(h, proposal);
  const callback = await followAuthorization(proposal.private.url!);
  const result = await adapter.complete(h.ctx, {
    kind: "redirect",
    url: callback,
  });
  return {
    result,
    ctx: h.with({
      ...(result.credentialRef ? { credentialRef: result.credentialRef } : {}),
      ...(result.target ? { target: result.target } : {}),
      externalIds: result.externalIds ?? {},
      state: result.adapterState ?? {},
      lifecycle: "active",
    }),
  };
}

test("AC-SB-02: Management OAuth uses the documented endpoints, S256 PKCE and app-registered scopes", async (t) => {
  const double = await startDouble();
  t.after(() => double.close());
  const h = await supabaseHarness({
    binding: managementBinding({ origin: double.origin }),
    fetch,
    configuration: CONFIGURATION,
  });
  t.after(() => h.close());

  const start = await adapter.authorize(
    h.ctx,
    intentFor({ target: { kind: "supabase-project", id: PROJECT_REF } }),
  );
  assert.equal(start.kind, "handoff");
  const proposal = (start as { handoff: HandoffProposal }).handoff;
  assert.equal(proposal.kind, "provider-browser");
  assert.equal(proposal.presentation, "popup");

  const authorizeUrl = new URL(proposal.private.url!);
  assert.equal(authorizeUrl.origin, double.origin);
  assert.equal(authorizeUrl.pathname, "/v1/oauth/authorize");
  assert.equal(authorizeUrl.searchParams.get("client_id"), CLIENT_ID);
  assert.equal(authorizeUrl.searchParams.get("response_type"), "code");
  assert.equal(authorizeUrl.searchParams.get("redirect_uri"), REDIRECT_URI);
  assert.equal(authorizeUrl.searchParams.get("code_challenge_method"), "S256");
  assert.ok(authorizeUrl.searchParams.get("code_challenge"));
  // The scope parameter is documented as deprecated: scopes come from the app
  // registration, so the request must not carry one.
  assert.equal(authorizeUrl.searchParams.has("scope"), false);
  // State is protected transient material, correlated but never public.
  assert.equal(proposal.correlationKey, proposal.private.state);
  assert.match(proposal.private.state!, /^[A-Za-z0-9_-]{43}$/);
  assert.ok(proposal.private.code_verifier);
  assert.equal(proposal.private.code_verifier === proposal.private.state, false);

  await issue(h, proposal);
  const callback = await followAuthorization(proposal.private.url!);
  const result = await adapter.complete(h.ctx, {
    kind: "redirect",
    url: callback,
  });
  assert.equal(result.state, "complete");
  assert.equal(double.observed.scopeParameterSeen, false);
  assert.equal(double.observed.plainPkceSeen, false);

  // The double validated the exchange itself: form encoding, PKCE verifier and
  // the exact redirect_uri from the first leg.
  const body = double.observed.tokenBodies.at(-1)!;
  assert.equal(body.get("grant_type"), "authorization_code");
  assert.equal(body.get("redirect_uri"), REDIRECT_URI);
  assert.ok(body.get("code_verifier"));
  assert.equal(body.has("scope"), false);
  assert.equal(
    double.rejections.filter((item) => item.path === "/v1/oauth/token").length,
    0,
  );

  const kinds = result.claims.map((claim) => claim.kind);
  assert.ok(kinds.includes("credential-accepted"));
  assert.ok(kinds.includes("resource-access"));
  assert.ok(kinds.includes("account-identity"));
  const resource = result.claims.find((claim) => claim.kind === "resource-access")!;
  assert.deepEqual(resource.target, {
    kind: "supabase-project",
    id: PROJECT_REF,
  });
  // Reported scopes come from the token response, never from the request.
  assert.deepEqual(resource.permissions?.requested, []);
  assert.deepEqual(resource.permissions?.reported, [
    "projects:read",
    "organizations:read",
  ]);
  assert.equal(resource.permissions?.semantics, "provider-scopes");
  assert.ok(
    resource.limitations.some((item) => item.includes("registration")),
    "the scope limitation must be recorded",
  );
});

test("A token response without a scope member records unknown semantics, never unlimited", async (t) => {
  const double = await startDouble({
    grant: { reportScopeInTokenResponse: false },
  });
  t.after(() => double.close());
  const h = await supabaseHarness({
    binding: managementBinding({ origin: double.origin }),
    fetch,
    configuration: CONFIGURATION,
  });
  t.after(() => h.close());
  const { result } = await connect(h, {
    kind: "supabase-project",
    id: PROJECT_REF,
  });
  assert.equal(result.state, "complete");
  const accepted = result.claims.find(
    (claim) => claim.kind === "credential-accepted",
  )!;
  assert.deepEqual(accepted.permissions?.reported, []);
  assert.equal(accepted.permissions?.semantics, "unknown");
  assert.ok(
    accepted.limitations.some((item) => item.includes("unknown")),
    "unknown granted scopes must be stated, not assumed",
  );
});

test("Exact redirect binding, one-use state and generation fencing govern the callback", async (t) => {
  const double = await startDouble();
  t.after(() => double.close());
  const h = await supabaseHarness({
    binding: managementBinding({ origin: double.origin }),
    fetch,
    configuration: CONFIGURATION,
  });
  t.after(() => h.close());

  const start = (await adapter.authorize(
    h.ctx,
    intentFor({ target: { kind: "supabase-project", id: PROJECT_REF } }),
  )) as { handoff: HandoffProposal };
  await issue(h, start.handoff);
  const callback = await followAuthorization(start.handoff.private.url!);

  // Another origin, another path, a missing state and a foreign state are all
  // refused before any credential exists.
  const foreign = new URL(callback.href);
  foreign.host = "attacker.example";
  await assert.rejects(
    () => adapter.complete(h.ctx, { kind: "redirect", url: foreign }),
    (error: unknown) =>
      error instanceof ConnectorError &&
      error.code === "denied" &&
      error.detail === "supabase.oauth.callback-route-mismatch",
  );
  const otherPath = new URL(callback.href);
  otherPath.pathname = "/api/v1/connectors/other/callback";
  await assert.rejects(
    () => adapter.complete(h.ctx, { kind: "redirect", url: otherPath }),
    (error: unknown) =>
      error instanceof ConnectorError && error.code === "denied",
  );
  const unknownState = new URL(callback.href);
  unknownState.searchParams.set("state", "x".repeat(43));
  await assert.rejects(
    () => adapter.complete(h.ctx, { kind: "redirect", url: unknownState }),
    (error: unknown) =>
      error instanceof ConnectorError &&
      error.detail === "supabase.oauth.handoff-mismatch",
  );
  const duplicated = new URL(callback.href);
  duplicated.searchParams.append("state", "y".repeat(43));
  await assert.rejects(
    () => adapter.complete(h.ctx, { kind: "redirect", url: duplicated }),
    (error: unknown) =>
      error instanceof ConnectorError &&
      error.detail === "supabase.oauth.state-invalid",
  );
  assert.equal(h.ports.inspect.credentialRefs().length, 0);

  // A callback that arrives for an older generation cannot complete.
  await assert.rejects(
    () =>
      adapter.complete(h.with({}, h.ctx.generation + 1), {
        kind: "redirect",
        url: callback,
      }),
    (error: unknown) =>
      error instanceof ConnectorError &&
      error.detail === "supabase.handoff.stale-generation",
  );

  const first = await adapter.complete(h.ctx, {
    kind: "redirect",
    url: callback,
  });
  assert.equal(first.state, "complete");
  // Delivered twice: the handoff is one-use, so the second delivery is refused
  // rather than exchanged again.
  const second = await adapter.complete(h.ctx, {
    kind: "redirect",
    url: callback,
  });
  assert.equal(second.state, "denied");
  assert.equal(second.code, "supabase.oauth.callback-replayed");
  assert.equal(
    double.observed.tokenBodies.filter(
      (body) => body.get("grant_type") === "authorization_code",
    ).length,
    1,
    "a replayed callback must not reach the token endpoint again",
  );
});

test("A target outside the binding or outside the grant never yields a stored credential", async (t) => {
  const double = await startDouble({
    projects: [
      managementProject(PROJECT_REF, ORGANIZATION_SLUG),
      managementProject(OTHER_PROJECT_REF, OTHER_ORGANIZATION_SLUG),
    ],
    grant: { projects: [PROJECT_REF], organizations: [ORGANIZATION_SLUG] },
  });
  t.after(() => double.close());
  const h = await supabaseHarness({
    binding: managementBinding({
      origin: double.origin,
      permittedTargets: [
        { kind: "supabase-project", id: PROJECT_REF },
        { kind: "supabase-project", id: OTHER_PROJECT_REF },
      ],
    }),
    fetch,
    configuration: CONFIGURATION,
  });
  t.after(() => h.close());

  // Not in permittedTargets at all: refused before a request is built.
  await assert.rejects(
    () =>
      adapter.authorize(
        h.ctx,
        intentFor({
          target: { kind: "supabase-organization", id: OTHER_ORGANIZATION_SLUG },
        }),
      ),
    (error: unknown) =>
      error instanceof ConnectorError &&
      error.detail === "supabase.target.not-permitted",
  );
  assert.equal(double.requests.length, 0);

  // Permitted by the binding, but the grant cannot reach it: the exchange
  // happens, the credential is not kept, and the failure names the target.
  const { result } = await connect(h, {
    kind: "supabase-project",
    id: OTHER_PROJECT_REF,
  });
  assert.equal(result.state, "denied");
  assert.equal(result.code, "supabase.target.unavailable");
  assert.equal(result.credentialRef, undefined);
  assert.equal(h.ports.inspect.credentialRefs().length, 0);
  assert.deepEqual(
    result.claims.map((claim) => claim.kind),
    ["credential-accepted"],
    "an issued token proves the exchange only",
  );
});

test("AC-SB-03: changing the target invalidates evidence and fences the old generation", async (t) => {
  const double = await startDouble({
    organizations: [
      managementOrganization(ORGANIZATION_SLUG),
      managementOrganization(OTHER_ORGANIZATION_SLUG),
    ],
    grant: {
      projects: [PROJECT_REF],
      organizations: [ORGANIZATION_SLUG, OTHER_ORGANIZATION_SLUG],
    },
  });
  t.after(() => double.close());
  const binding = managementBinding({
    origin: double.origin,
    permittedTargets: [
      { kind: "supabase-project", id: PROJECT_REF },
      { kind: "supabase-organization", id: ORGANIZATION_SLUG },
      { kind: "supabase-organization", id: OTHER_ORGANIZATION_SLUG },
    ],
  });
  const h = await supabaseHarness({ binding, fetch, configuration: CONFIGURATION });
  t.after(() => h.close());

  const connected = await connect(h, {
    kind: "supabase-project",
    id: PROJECT_REF,
  });
  assert.equal(connected.result.state, "complete");
  for (const claim of connected.result.claims)
    await h.ports.evidence.append(
      fixtureActor,
      h.connection.connectionRef,
      claim,
    );
  assert.equal(
    (await h.ports.evidence.list(fixtureActor, h.connection.connectionRef))
      .length,
    connected.result.claims.length,
  );
  // A pending handoff for the old target must not survive the change either.
  await issue(h, {
    kind: "input-required",
    presentation: "in-app",
    intent: "supabase.management.target-select",
    expiresAt: Date.now() + 60_000,
    private: {},
  });

  const switched = (await adapter.authorize(
    connected.ctx,
    intentFor({
      target: { kind: "supabase-organization", id: OTHER_ORGANIZATION_SLUG },
      accountSwitch: true,
    }),
  )) as SupabaseAuthorizationStart;
  assert.equal(switched.kind, "handoff");
  assert.ok(switched.supersedes, "a target change must report what it superseded");
  assert.ok(switched.supersedes!.invalidatedClaims > 0);
  assert.ok(switched.supersedes!.cancelledHandoffs > 0);
  assert.deepEqual(
    await h.ports.evidence.list(fixtureActor, h.connection.connectionRef),
    [],
    "evidence about the old target must not survive the change",
  );

  // Without explicit account-switch intent the change is refused outright.
  const refused = await adapter.authorize(
    connected.ctx,
    intentFor({
      target: { kind: "supabase-organization", id: OTHER_ORGANIZATION_SLUG },
    }),
  );
  assert.equal(refused.kind, "human-required");
  assert.equal(
    (refused as { code: string }).code,
    "supabase.target.switch-requires-intent",
  );

  // The command layer advances the generation; a callback for the old one is stale.
  const advanced = await h.ports.connections.advanceGeneration(
    fixtureActor,
    h.connection.connectionRef,
    1,
  );
  assert.equal(advanced.generation, 1);
});

test("Inventory lists organizations and projects and marks which targets the binding permits", async (t) => {
  const double = await startDouble({
    projects: [
      managementProject(PROJECT_REF, ORGANIZATION_SLUG),
      managementProject(OTHER_PROJECT_REF, ORGANIZATION_SLUG),
    ],
    grant: {
      projects: [PROJECT_REF, OTHER_PROJECT_REF],
      organizations: [ORGANIZATION_SLUG],
    },
  });
  t.after(() => double.close());
  const h = await supabaseHarness({
    binding: managementBinding({ origin: double.origin }),
    fetch,
    configuration: CONFIGURATION,
  });
  t.after(() => h.close());
  const connected = await connect(h, {
    kind: "supabase-project",
    id: PROJECT_REF,
  });

  const all = await adapter.discover(connected.ctx, {});
  const kinds = all.items.map((item) => item.provenance?.kind);
  assert.ok(kinds.includes("supabase-organization"));
  assert.ok(kinds.includes("supabase-project"));
  const permitted = all.items.find((item) => item.identity.nativeId === PROJECT_REF);
  assert.equal(permitted?.provenance?.permitted, "true");
  const notPermitted = all.items.find(
    (item) => item.identity.nativeId === OTHER_PROJECT_REF,
  );
  assert.equal(notPermitted?.provenance?.permitted, "false");
  // Native identifiers are preserved exactly, never slugged.
  assert.equal(permitted?.identity.nativeId, PROJECT_REF);
  assert.ok(
    all.issues.some(
      (issue) => issue.code === "supabase.management.no-server-pagination",
    ),
    "the absence of documented pagination is reported, not invented",
  );

  const page = await adapter.discover(connected.ctx, { limit: 1 });
  assert.equal(page.items.length, 1);
  assert.equal(page.nextCursor, "1");
  const next = await adapter.discover(connected.ctx, {
    limit: 1,
    cursor: page.nextCursor!,
  });
  assert.notEqual(
    next.items[0]?.identity.nativeId,
    page.items[0]?.identity.nativeId,
  );
});

test("Approved read operations run; an out-of-scope target parameter is refused before the request", async (t) => {
  const double = await startDouble({
    projects: [
      managementProject(PROJECT_REF, ORGANIZATION_SLUG),
      managementProject(OTHER_PROJECT_REF, ORGANIZATION_SLUG),
    ],
    grant: {
      projects: [PROJECT_REF, OTHER_PROJECT_REF],
      organizations: [ORGANIZATION_SLUG],
    },
  });
  t.after(() => double.close());
  const h = await supabaseHarness({
    binding: managementBinding({ origin: double.origin }),
    fetch,
    configuration: CONFIGURATION,
  });
  t.after(() => h.close());
  const connected = await connect(h, {
    kind: "supabase-project",
    id: PROJECT_REF,
  });

  const read = await adapter.invoke(connected.ctx, {
    operationRef: "operation:v1-get-project",
    input: { ref: PROJECT_REF },
    commandId: "command-1",
  });
  assert.equal(read.state, "complete");
  assert.equal(read.effect, "read");
  assert.equal(read.outputClassification, "personal");
  assert.equal((read.output as { ref: string }).ref, PROJECT_REF);

  const before = double.requests.length;
  await assert.rejects(
    () =>
      adapter.invoke(connected.ctx, {
        operationRef: "operation:v1-get-project",
        input: { ref: OTHER_PROJECT_REF },
        commandId: "command-2",
      }),
    (error: unknown) =>
      error instanceof ConnectorError &&
      error.code === "denied" &&
      error.detail === "supabase.target.out-of-scope",
  );
  assert.equal(
    double.requests.length,
    before,
    "a target check must happen before the request, not after",
  );

  // An unknown operation ref and an unapproved native id are both refused.
  await assert.rejects(
    () =>
      adapter.invoke(connected.ctx, {
        operationRef: "operation:v1-delete-a-project",
        input: {},
        commandId: "command-3",
      }),
    (error: unknown) =>
      error instanceof ConnectorError && error.code === "not-found",
  );

  // The listing is filtered to the connection's target.
  const listed = await adapter.invoke(connected.ctx, {
    operationRef: "operation:v1-list-all-projects",
    input: {},
    commandId: "command-4",
  });
  assert.equal(listed.state, "complete");
  assert.deepEqual(
    (listed.output as Array<{ ref: string }>).map((row) => row.ref),
    [PROJECT_REF],
  );
});

test("Rotating refresh runs once under single flight and a rejected refresh requires reconnect", async (t) => {
  const double = await startDouble();
  t.after(() => double.close());
  let clock = Date.now();
  const h = await supabaseHarness({
    binding: managementBinding({ origin: double.origin }),
    fetch,
    configuration: CONFIGURATION,
    now: () => clock,
  });
  t.after(() => h.close());
  const connected = await connect(h, {
    kind: "supabase-project",
    id: PROJECT_REF,
  });
  const credentialRef = connected.result.credentialRef!;
  const firstMaterial = h.ports.inspect.credentialMaterial(credentialRef)!;
  assert.equal(firstMaterial.kind, "management-access-token");

  // Move to just inside the refresh window, then invoke twice concurrently.
  clock += 86_400_000 - 30_000;
  const [a, b] = await Promise.all([
    adapter.invoke(connected.ctx, {
      operationRef: "operation:v1-get-project",
      input: { ref: PROJECT_REF },
      commandId: "command-a",
    }),
    adapter.invoke(connected.ctx, {
      operationRef: "operation:v1-get-project",
      input: { ref: PROJECT_REF },
      commandId: "command-b",
    }),
  ]);
  assert.equal(a.state, "complete");
  assert.equal(b.state, "complete");
  assert.equal(
    double.observed.tokenBodies.filter(
      (body) => body.get("grant_type") === "refresh_token",
    ).length,
    1,
    "concurrent callers share one refresh",
  );
  const rotated = h.ports.inspect.credentialMaterial(credentialRef)!;
  assert.notEqual(rotated.access_token, firstMaterial.access_token);
  assert.notEqual(
    rotated.refresh_token,
    firstMaterial.refresh_token,
    "the rotated refresh token replaces the old one",
  );
  assert.equal(rotated.kind, "management-access-token");

  // The user revokes the app upstream; the next refresh is rejected and the
  // connection must reconnect rather than retry.
  double.revokeUpstream();
  clock += 86_400_000;
  const failure = await adapter
    .invoke(connected.ctx, {
      operationRef: "operation:v1-get-project",
      input: { ref: PROJECT_REF },
      commandId: "command-c",
    })
    .then(
      () => undefined,
      (error: unknown) => error,
    );
  assert.ok(failure instanceof ConnectorError);
  assert.equal((failure as ConnectorError).code, "expired");
  assert.equal(supabaseLifecycleFor(failure), "reconnect-required");
});

test("Revoke calls the documented endpoint; without a refresh token it reports unsupported", async (t) => {
  const double = await startDouble();
  t.after(() => double.close());
  const h = await supabaseHarness({
    binding: managementBinding({ origin: double.origin }),
    fetch,
    configuration: CONFIGURATION,
  });
  t.after(() => h.close());
  const connected = await connect(h, {
    kind: "supabase-project",
    id: PROJECT_REF,
  });
  assert.equal(double.activeAccessTokens(), 1);

  // A local disconnect is not an upstream revocation.
  const local = await adapter.disconnect(connected.ctx, "local");
  assert.deepEqual(local, {
    local: "applied",
    broker: "not-attempted",
    upstream: "not-attempted",
  });
  assert.equal(
    supabaseLifecycleAfterDisconnect(local, "local"),
    "locally-disconnected",
  );
  assert.equal(
    double.received("POST", "/v1/oauth/revoke").length,
    0,
    "local unlink must not contact the provider",
  );

  const reconnected = await connect(h, {
    kind: "supabase-project",
    id: PROJECT_REF,
  });
  const revoked = await adapter.revoke(reconnected.ctx);
  assert.equal(revoked.upstream, "applied");
  assert.equal(revoked.local, "applied");
  assert.equal(
    supabaseLifecycleAfterDisconnect(revoked, "upstream"),
    "upstream-revoked",
  );
  const body = double.observed.revokeBodies.at(-1)!;
  assert.equal(body.client_id, CLIENT_ID);
  assert.ok(body.refresh_token);
  assert.equal(double.activeAccessTokens(), 0);

  // A grant with no refresh token cannot be revoked through the API: the
  // native limitation is reported, never a fabricated success.
  const scope = {
    tenantId: fixtureActor.tenantId,
    ownerKind: "user" as const,
    ownerId: fixtureActor.subjectId,
    connectionRef: h.connection.connectionRef,
    bindingRef: h.ctx.binding.bindingRef,
    custody: "host-owned" as const,
  };
  const ref = await h.ports.credentials.store(scope, {
    kind: "management-access-token",
    access_token: "sbp_oauth_access_without_refresh",
    token_type: "Bearer",
    client_id: CLIENT_ID,
    issued_at: String(Date.now()),
  });
  const withoutRefresh = await adapter.revoke(
    h.with({ credentialRef: ref, target: { kind: "supabase-project", id: PROJECT_REF } }),
  );
  assert.equal(withoutRefresh.upstream, "unsupported");
  assert.equal(withoutRefresh.local, "applied");
});

test("Missing configuration, a foreign destination and a non-user owner are reported, not attempted", async (t) => {
  const double = await startDouble();
  t.after(() => double.close());

  const unconfigured = await supabaseHarness({
    binding: managementBinding({ origin: double.origin }),
    fetch,
    configuration: {},
  });
  t.after(() => unconfigured.close());
  const missing = await adapter.authorize(unconfigured.ctx, intentFor());
  assert.equal(missing.kind, "configuration-required");
  assert.deepEqual((missing as { missing: string[] }).missing, [
    "SUPABASE_OAUTH_CLIENT_ID",
    "SUPABASE_OAUTH_CLIENT_SECRET",
  ]);
  assert.equal(double.requests.length, 0);

  const workload = await adapter.authorize(
    unconfigured.ctx,
    intentFor({ ownerKind: "workload" }),
  );
  assert.equal(workload.kind, "unsupported");

  // A destination that is not the documented origin is refused by policy.
  const foreign = await supabaseHarness({
    binding: managementBinding({
      origin: double.origin,
      overrides: {
        destinations: [
          {
            id: "api",
            origin: "https://api.supabase.com.attacker.example",
            network: "public",
          },
        ],
      },
    }),
    fetch,
    configuration: CONFIGURATION,
  });
  t.after(() => foreign.close());
  await assert.rejects(
    () => adapter.authorize(foreign.ctx, intentFor()),
    (error: unknown) =>
      error instanceof ConnectorError &&
      error.code === "network-policy" &&
      error.detail === "supabase.management.destination-not-pinned",
  );

  // The catalog distinguishes implemented-and-configured from unconfigured.
  const ready = adapter.capabilities(
    new Set(["SUPABASE_OAUTH_CLIENT_ID", "SUPABASE_OAUTH_CLIENT_SECRET"]),
  );
  assert.equal(
    ready.find((row) => row.dimension === "authorize")?.configuration,
    "ready",
  );
  const absent = adapter.capabilities(new Set());
  assert.equal(
    absent.find((row) => row.dimension === "authorize")?.configuration,
    "missing",
  );
  assert.equal(
    absent.find((row) => row.dimension === "import")?.implementation,
    "unsupported",
  );
  assert.equal(
    absent.find((row) => row.dimension === "import")?.evidence,
    "not-tested",
  );
  assert.ok(
    ready
      .find((row) => row.dimension === "revoke")
      ?.limitations.some((item) => item.includes("/v1/oauth/revoke")),
  );
});
