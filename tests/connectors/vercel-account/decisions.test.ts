import assert from "node:assert/strict";
import test from "node:test";
import type { AdapterCallContext } from "../../../src/server/connectors/adapter.js";
import { runtimeBindingSchema } from "../../../src/server/connectors/binding.js";
import { ConnectorError } from "../../../src/server/connectors/errors.js";
import {
  accountApiDestination,
  accountManagementSource,
  createVercelAccountAdapter,
  vercelAccountBoundOperations,
} from "../../../src/server/connectors/providers/vercel-account/index.js";
import {
  devicePollState,
  planTeams,
} from "../../../src/server/connectors/providers/vercel-account/ceremony.js";
import {
  listTeams,
  readUser,
} from "../../../src/server/connectors/providers/vercel-account/client.js";
import {
  accountSwitchRequested,
  claimsFor,
  priorUserId,
} from "../../../src/server/connectors/providers/vercel-account/evidence.js";
import { ensureFresh } from "../../../src/server/connectors/providers/vercel-account/session.js";
import { resolveCredential } from "../../../src/server/connectors/providers/vercel/index.js";
import { startHttpFixture } from "../doubles/http-fixture.js";
import {
  accountSetup,
  alice,
  connectAndApprove,
  connectAndChoose,
  connectionRefOf,
  handoffRefOf,
  START_TIME,
  userCodeOf,
} from "./harness.js";

/*
 * The decisions the ceremony, renewal and management tests exercise only
 * through their results, pinned one at a time: what the poll state may be,
 * what an intent can and cannot narrow, what fits in the line a person reads,
 * the edges of the renewal rule, and what each refusal is called. Each was
 * found by mutating the adapter and seeing no test notice.
 */

type View = {
  lifecycle: string;
  lastOutcome?: string;
  presentation?: { instructions?: string };
};
const asView = (value: unknown) => value as View;
const MINUTE = 60_000;
const detailOf = (error: unknown) =>
  error instanceof ConnectorError ? error.detail : undefined;
const stateOnly = (state: Record<string, unknown>) =>
  ({ connection: { state } }) as unknown as AdapterCallContext;

test("the poll state is the interval and the next time, or it is nothing", async () => {
  await Promise.resolve();
  assert.deepEqual(
    devicePollState(
      stateOnly({ devicePoll: { interval: 10, nextPollAt: 99 } }),
    ),
    { interval: 10, nextPollAt: 99 },
  );
  for (const devicePoll of [
    undefined,
    null,
    "10",
    5,
    {},
    { interval: 10 },
    { nextPollAt: 99 },
    { interval: "10", nextPollAt: 99 },
    { interval: 10, nextPollAt: "99" },
    { interval: Number.NaN, nextPollAt: 99 },
    { interval: 10, nextPollAt: Number.POSITIVE_INFINITY },
  ])
    assert.equal(
      devicePollState(stateOnly({ devicePoll })),
      undefined,
      JSON.stringify(devicePoll),
    );
  assert.equal(devicePollState({} as AdapterCallContext), undefined);
});

const plan = (
  permitted: string[],
  listed: string[],
  state?: Record<string, unknown>,
) =>
  planTeams(
    {
      binding: {
        permittedTargets: permitted.map((id) => ({ kind: "vercel-team", id })),
      },
      ...(state ? { connection: { state } } : {}),
    } as unknown as AdapterCallContext,
    {
      teams: listed.map((id) => ({ id, slug: id })),
      truncated: false,
    },
  );

test("teams are planned from the binding first and the intent second", async () => {
  await Promise.resolve();
  const ids = (result: ReturnType<typeof plan>) =>
    result.kind === "choose"
      ? result.teams.map((team) => team.id)
      : result.kind === "single"
        ? [result.team.id]
        : [];
  assert.deepEqual(plan(["a", "b"], ["a", "b", "c"]), {
    kind: "choose",
    teams: [
      { id: "a", slug: "a" },
      { id: "b", slug: "b" },
    ],
    truncated: false,
  });
  assert.equal(plan(["a"], ["a", "b"]).kind, "single");
  assert.equal(plan(["a"], ["b"]).kind, "none");
  assert.equal(plan(["a"], []).kind, "none");
  // An intent for a permitted team narrows to it; for one the binding does not permit, to nothing.
  const intent = (kind: string, id: string) => ({
    intent: { target: { kind, id } },
  });
  assert.deepEqual(
    ids(plan(["a", "b"], ["a", "b"], intent("vercel-team", "b"))),
    ["b"],
  );
  assert.equal(
    plan(["a", "b"], ["a", "b"], intent("vercel-team", "z")).kind,
    "none",
  );
  // An intent of another kind, or none at all, narrows nothing.
  assert.equal(
    plan(["a", "b"], ["a", "b"], intent("vercel-user", "b")).kind,
    "choose",
  );
  assert.equal(plan(["a", "b"], ["a", "b"], { intent: {} }).kind, "choose");
  assert.equal(plan(["a", "b"], ["a", "b"], {}).kind, "choose");
});

test("asking for an account switch is exactly asking, in the intent the connection holds", async () => {
  await Promise.resolve();
  assert.equal(
    accountSwitchRequested(stateOnly({ intent: { accountSwitch: true } })),
    true,
  );
  for (const state of [
    {},
    { intent: {} },
    { intent: { accountSwitch: false } },
    { intent: { accountSwitch: "true" } },
    { intent: { accountSwitch: 1 } },
  ])
    assert.equal(
      accountSwitchRequested(stateOnly(state)),
      false,
      JSON.stringify(state),
    );
  assert.equal(accountSwitchRequested({} as AdapterCallContext), false);
});

// ------------------------------------------------------------ the line read

const LEAD = "Enter the team slug to use: ";
const LIMIT = 440;
const teamId = (index: number) =>
  `team_dummy_${String(index).padStart(3, "0")}`;
const partLength = (slug: string, id: string) => slug.length + 3 + id.length;

async function offered(
  t: Parameters<typeof accountSetup>[0],
  teams: Array<{ slug: string }>,
) {
  const person = {
    ...alice,
    teams: teams.map((team, index) => ({
      id: teamId(index),
      slug: team.slug,
      createdAt: START_TIME - index * 1000,
    })),
  };
  const setup = await accountSetup(t, {
    people: [person],
    teams: person.teams.map((team) => team.id),
  });
  const first = await connectAndApprove(setup);
  return {
    setup,
    first,
    text: asView(first.polled).presentation!.instructions!,
  };
}

test("the line a person reads is cleaned of control characters and capped, saying when there is more", async (t) => {
  const { text } = await offered(
    t,
    Array.from({ length: 30 }, (_, index) => ({
      slug: `team\u0007-${index}-with-a-slug-long-enough-to-matter`,
    })),
  );
  assert.ok(text.length <= 500, String(text.length));
  assert.ok(text.endsWith("; more are available."), text);
  assert.equal(/\p{Cc}/u.test(text), false);
  assert.ok(
    text.startsWith(
      `${LEAD}team -0-with-a-slug-long-enough-to-matter (team_dummy_000); `,
    ),
  );
  const shown = text
    .slice(LEAD.length, -"; more are available.".length)
    .split("; ");
  assert.ok(shown.length > 1 && shown.length < 30);
  for (const part of shown)
    assert.match(
      part,
      /^team -\d+-with-a-slug-long-enough-to-matter \(team_dummy_\d{3}\)$/,
    );
});

test("a list that fits exactly is shown whole; one character more drops its last part", async (t) => {
  const build = (extra: number) => {
    const first = ["a".repeat(60), "b".repeat(60)];
    const used =
      LEAD.length +
      first.reduce(
        (sum, slug, index) => sum + partLength(slug, teamId(index)) + 2,
        0,
      );
    const room = LIMIT - used - 2 - partLength("", teamId(2));
    return [...first, "c".repeat(room + extra)].map((slug) => ({ slug }));
  };
  const whole = (await offered(t, build(0))).text;
  assert.match(whole, /c+ \(team_dummy_002\)\.$/);
  assert.equal(whole.includes("more are available"), false);
  const over = (await offered(t, build(1))).text;
  assert.equal(over.includes("team_dummy_002"), false);
  assert.ok(over.endsWith("; more are available."));
});

// ------------------------------------------------------ handoffs and claims

test("a completion for a handoff of another kind, or one missing its session, is refused", async (t) => {
  const setup = await accountSetup(t);
  const adapter = createVercelAccountAdapter();
  const connected = await setup.service.connect(setup.person, {
    bindingRef: setup.binding.bindingRef,
    intent: {},
  });
  const device = await setup.ports.handoffs.present(
    setup.person,
    handoffRefOf(connected),
  );
  assert.ok(device);
  setup.fixture.approve(userCodeOf(connected));
  setup.advance(6_000);
  const polled = await setup.service.poll(
    setup.person,
    connectionRefOf(connected),
  );
  const choice = await setup.ports.handoffs.present(
    setup.person,
    handoffRefOf(polled),
  );
  assert.ok(choice);
  const ctx = await setup.adapterContext(connectionRefOf(connected));
  const values = { team: "acme" };
  const refusal = (detail: string) => (error: unknown) =>
    error instanceof ConnectorError &&
    error.code === "invalid-request" &&
    error.detail === detail;
  await assert.rejects(
    adapter.complete!({ ...ctx, handoff: choice }, { kind: "poll" }),
    refusal("oauth.handoff.kind"),
  );
  await assert.rejects(
    adapter.complete!({ ...ctx, handoff: device }, { kind: "input", values }),
    refusal("oauth.handoff.kind"),
  );
  await assert.rejects(
    adapter.complete!({ ...ctx }, { kind: "input", values }),
    refusal("oauth.handoff.kind"),
  );
  await assert.rejects(
    adapter.complete!(
      {
        ...ctx,
        handoff: { ...choice, private: { ...choice.private, sessionRef: "" } },
      },
      { kind: "input", values },
    ),
    refusal("oauth.handoff.private-missing"),
  );
  const { sessionRef: _dropped, ...rest } = choice.private;
  void _dropped;
  await assert.rejects(
    adapter.complete!(
      { ...ctx, handoff: { ...choice, private: rest } },
      { kind: "input", values },
    ),
    refusal("oauth.handoff.private-missing"),
  );
  // An input completion is the person's: the handoff stays theirs to settle.
  const done = await adapter.complete!(
    { ...ctx, handoff: choice },
    { kind: "input", values },
  );
  assert.equal(done.state, "complete");
  assert.equal(done.handoffSettled, undefined);
  setup.advance(601_000);
  const lapsed = await adapter.complete!(
    { ...ctx, handoff: choice },
    { kind: "input", values },
  );
  assert.equal(lapsed.state, "expired");
  assert.deepEqual(lapsed.claims, []);
});

test("a sign-in with one team to bind says it settled its own handoff, and the scopes Vercel reported are the claim's", async (t) => {
  const setup = await accountSetup(t, { teams: ["team_dummy_labs"] });
  const adapter = createVercelAccountAdapter();
  const connected = await setup.service.connect(setup.person, {
    bindingRef: setup.binding.bindingRef,
    intent: {},
  });
  setup.fixture.approve(userCodeOf(connected));
  setup.advance(6_000);
  const handoff = await setup.ports.handoffs.present(
    setup.person,
    handoffRefOf(connected),
  );
  assert.ok(handoff);
  const ctx = await setup.adapterContext(connectionRefOf(connected));
  const result = await adapter.complete!({ ...ctx, handoff }, { kind: "poll" });
  assert.equal(result.state, "complete");
  assert.equal(result.handoffSettled, true);
  const accepted = result.claims.find(
    (claim) => claim.kind === "credential-accepted",
  );
  assert.deepEqual(accepted?.permissions?.reported, [
    "openid",
    "offline_access",
  ]);
  assert.deepEqual(accepted?.permissions?.requested, [
    "openid",
    "offline_access",
  ]);
  assert.deepEqual(accepted?.target, {
    kind: "vercel-team",
    id: "team_dummy_labs",
  });
  assert.deepEqual(result.claims.map((claim) => claim.kind).sort(), [
    "account-identity",
    "credential-accepted",
    "resource-access",
  ]);
  for (const claim of result.claims)
    assert.ok(claim.limitations.length > 0, claim.kind);
  assert.equal(
    accepted?.validUntil,
    new Date(setup.clock() + 3_600_000).toISOString(),
  );
  assert.deepEqual(result.adapterState?.["vercelAccount"], {
    userId: alice.id,
    teamId: "team_dummy_labs",
    slug: "labs",
    reported: ["openid", "offline_access"],
    expiresAt: setup.clock() + 3_600_000,
  });
});

test("the scopes Vercel reported survive the choice step", async (t) => {
  const setup = await accountSetup(t);
  const first = await connectAndApprove(setup);
  await setup.service.provideInput(
    setup.person,
    first.connectionRef,
    handoffRefOf(first.polled),
    { team: "acme" },
  );
  const evidence = JSON.stringify(
    await setup.ports.evidence.list(setup.person, first.connectionRef),
  );
  assert.match(evidence, /"reported":\["openid","offline_access"\]/);
});

// ----------------------------------------------------------- operations

test("an operation is run only if it is bound to the account API over HTTP, and only for a connected account", async (t) => {
  const setup = await accountSetup(t);
  const adapter = createVercelAccountAdapter();
  const { connectionRef } = await connectAndChoose(setup);
  const ctx = await setup.adapterContext(connectionRef);
  const request = {
    operationRef: "vercel-account.get-user",
    input: {},
    commandId: "c",
  };
  const rebound = (
    change: (
      operation: ReturnType<typeof vercelAccountBoundOperations>[number],
    ) => Record<string, unknown>,
  ) =>
    ({
      ...ctx,
      binding: runtimeBindingSchema.parse({
        ...setup.binding,
        destinations: [
          ...setup.binding.destinations,
          {
            id: "elsewhere",
            origin: setup.fixture.apiOrigin,
            network: "loopback-fixture",
          },
        ],
        operations: vercelAccountBoundOperations().map((operation) =>
          operation.operationRef === request.operationRef
            ? change(operation)
            : operation,
        ),
      }),
    }) as AdapterCallContext;
  const unbound = (error: unknown) =>
    error instanceof ConnectorError &&
    error.code === "denied" &&
    error.detail === "vercel-account.operation.unbound";
  await assert.rejects(
    adapter.invoke!(
      rebound((operation) => ({ ...operation, destinationId: "elsewhere" })),
      request,
    ),
    unbound,
  );
  await assert.rejects(
    adapter.invoke!(
      rebound((operation) => ({
        ...operation,
        transport: { kind: "mcp-tool", toolName: "x" },
      })),
      request,
    ),
    unbound,
  );
  await assert.rejects(
    adapter.invoke!(ctx, {
      ...request,
      operationRef: "vercel-account.nothing",
    }),
    unbound,
  );
  // No connection at all, or one with no credential, is a person to sign in, not a crash.
  const without = {
    ...ctx,
    connection: undefined,
  } as unknown as AdapterCallContext;
  const idle = await adapter.invoke!(without, request);
  assert.equal(idle.state, "human-required");
  assert.equal(idle.code, "vercel-account.not-connected");
  // A credential with no account bound to it is a conflict the adapter names.
  const unbindable = { ...ctx, connection: { ...ctx.connection!, state: {} } };
  await assert.rejects(
    adapter.invoke!(unbindable, request),
    (error: unknown) =>
      error instanceof ConnectorError &&
      error.code === "conflict" &&
      error.detail === "vercel-account.team.not-bound",
  );
});

test("a team read names each team, with its name when Vercel gave one, and which one is bound", async (t) => {
  const { name: _unnamed, ...nameless } = alice.teams[0]!;
  void _unnamed;
  const named = { ...alice, teams: [nameless, alice.teams[1]!] };
  const setup = await accountSetup(t, { people: [named] });
  const { connectionRef } = await connectAndChoose(setup);
  const result = (await setup.service.invoke(setup.agent, connectionRef, {
    operationRef: "vercel-account.list-teams",
    input: {},
    commandId: "names",
  })) as {
    output: { teams: Array<Record<string, unknown>>; truncated: boolean };
  };
  assert.deepEqual(result.output, {
    teams: [
      { id: "team_dummy_labs", slug: "labs", name: "Labs", bound: false },
      { id: "team_dummy_acme", slug: "acme", bound: true },
    ],
    truncated: false,
  });
});

test("a person who removed the app is told to sign in again, not shown an error", async (t) => {
  const setup = await accountSetup(t);
  const { connectionRef } = await connectAndChoose(setup);
  setup.fixture.revokeApp(alice.id);
  const result = (await setup.service.invoke(setup.agent, connectionRef, {
    operationRef: "vercel-account.get-user",
    input: {},
    commandId: "revoked",
  })) as { state: string; code?: string };
  assert.equal(result.state, "human-required");
  assert.equal(result.code, "vercel-account.session.expired");
});

test("a verification reports a different user or a lost team as denied, and an outage as an outage", async (t) => {
  const setup = await accountSetup(t);
  const adapter = createVercelAccountAdapter();
  const { connectionRef } = await connectAndChoose(setup);
  const ctx = await setup.adapterContext(connectionRef);
  const bound = (patch: Record<string, unknown>) => ({
    ...ctx,
    connection: {
      ...ctx.connection!,
      state: {
        ...ctx.connection!.state,
        vercelAccount: {
          ...(ctx.connection!.state["vercelAccount"] as object),
          ...patch,
        },
      },
    },
  });
  const user = await adapter.verify!(bound({ userId: "someone-else" }));
  assert.deepEqual(
    [user.state, user.code, user.claims],
    ["denied", "vercel-account.user.changed", []],
  );
  const team = await adapter.verify!(bound({ teamId: "team_dummy_gone" }));
  assert.deepEqual(
    [team.state, team.code, team.claims],
    ["denied", "vercel-account.team.left", []],
  );
  const ok = await adapter.verify!(ctx);
  assert.equal(ok.state, "complete");
  const described = await ctx.environment.credentials.describe(
    {
      tenantId: ctx.connection!.tenantId,
      ownerKind: ctx.connection!.ownerKind,
      ownerId: ctx.connection!.ownerId,
      connectionRef: ctx.connection!.connectionRef,
      bindingRef: ctx.connection!.bindingRef,
      custody: ctx.connection!.custody,
    },
    ctx.connection!.credentialRef!,
  );
  assert.equal(described?.expiresAt, setup.clock() + 3_600_000);
  assert.equal(
    (ok.adapterState?.["vercelAccount"] as { expiresAt: number }).expiresAt,
    described?.expiresAt,
  );
  assert.equal(
    ok.claims.find((claim) => claim.kind === "credential-accepted")?.validUntil,
    new Date(described!.expiresAt!).toISOString(),
  );
  setup.fixture.failRest(503);
  await assert.rejects(
    adapter.verify!(ctx),
    (error: unknown) =>
      error instanceof ConnectorError && error.code === "upstream-unavailable",
  );
  setup.fixture.failRest(null);
  const idle = await adapter.verify!({
    ...ctx,
    connection: { ...ctx.connection!, credentialRef: undefined },
  } as unknown as AdapterCallContext);
  assert.deepEqual(
    [idle.state, idle.code, idle.claims],
    ["human-required", "vercel-account.not-connected", []],
  );
});

// ------------------------------------------------------------ the session

test("a token is renewed when exactly two minutes remain, not before; a token with no stated lifetime is used until Vercel refuses it", async (t) => {
  const setup = await accountSetup(t);
  const { connectionRef } = await connectAndChoose(setup);
  const ctx = await setup.adapterContext(connectionRef);
  const ref = ctx.connection!.credentialRef!;
  const expiry = Number(
    (await setup.heldMaterial(connectionRef))["expires_at"],
  );
  setup.advance(expiry - setup.clock() - 2 * MINUTE - 1);
  await ensureFresh(ctx, ref, {});
  assert.equal(setup.fixture.counts.refresh, 0, "one millisecond early");
  setup.advance(1);
  await ensureFresh(ctx, ref, {});
  assert.equal(setup.fixture.counts.refresh, 1, "exactly two minutes left");

  const open = await accountSetup(t, { double: { omitExpiresIn: true } });
  const chosen = await connectAndChoose(open);
  open.advance(30 * MINUTE);
  assert.equal(
    asView(await open.service.verify(open.person, chosen.connectionRef))
      .lifecycle,
    "active",
  );
  assert.equal(open.fixture.counts.refresh, 0);
});

test("a reference custody does not hold is a session that is over", async (t) => {
  const setup = await accountSetup(t);
  const { connectionRef } = await connectAndChoose(setup);
  const ctx = await setup.adapterContext(connectionRef);
  await assert.rejects(
    ensureFresh(ctx, "cred:nothing-here", {}),
    (error: unknown) =>
      error instanceof ConnectorError &&
      error.code === "expired" &&
      error.detail === "vercel-account.session.unknown",
  );
});

test("an issuer that is down is an outage to retry, not a missing configuration", async (t) => {
  const setup = await accountSetup(t);
  await setup.fixture.stopIssuer();
  await assert.rejects(
    setup.service.connect(setup.person, {
      bindingRef: setup.binding.bindingRef,
      intent: {},
    }),
    (error: unknown) =>
      error instanceof ConnectorError &&
      error.code === "upstream-unavailable" &&
      error.detail === "oauth.discovery.unavailable",
  );
  assert.equal(setup.fixture.counts.device, 0);
});

test("an upstream disconnect that cannot reach the issuer says it failed; with nothing held it says it did not try", async (t) => {
  const setup = await accountSetup(t, { revoke: true });
  const { connectionRef, done } = await connectAndChoose(setup);
  await setup.fixture.stopIssuer();
  const result = await setup.service.disconnect(setup.person, connectionRef, {
    expectedRevision: (done as { revision: number }).revision,
    scope: "upstream",
  });
  assert.equal(result.result.upstream, "failed");
  const adapter = createVercelAccountAdapter();
  const ctx = await setup.adapterContext(connectionRef);
  const bare = {
    ...ctx,
    connection: { ...ctx.connection!, credentialRef: undefined },
  } as unknown as AdapterCallContext;
  assert.equal(
    (await adapter.disconnect!(bare, "upstream")).upstream,
    "not-attempted",
  );
  assert.equal((await adapter.revoke!(bare)).upstream, "not-attempted");
});

// -------------------------------------------------------------- the client

function contextFor(
  binding: ReturnType<typeof runtimeBindingSchema.parse>,
  origin: string,
  settings: Record<string, unknown> = {},
  signal: AbortSignal = new AbortController().signal,
): AdapterCallContext {
  return {
    binding: runtimeBindingSchema.parse({
      ...binding,
      destinations: [{ id: "api", origin, network: "loopback-fixture" }],
      operations: [],
      settings: { ...binding.settings, "vercel-account": settings },
    }),
    signal,
    environment: { fetch: globalThis.fetch },
  } as unknown as AdapterCallContext;
}

test("a request is bounded by the reviewed timeout and by the caller's signal", async (t) => {
  const { binding } = await accountSetup(t);
  const hung = await startHttpFixture(() => new Promise(() => {}));
  t.after(() => hung.close());
  const started = Date.now();
  await assert.rejects(
    readUser(
      contextFor(binding, hung.origin, { requestTimeoutMs: 150 }),
      "vca_dummy",
    ),
    (error: unknown) =>
      error instanceof ConnectorError &&
      error.code === "upstream-unavailable" &&
      error.detail === "vercel-account.network",
  );
  assert.ok(
    Date.now() - started < 5_000,
    "the reviewed bound, not the default, applied",
  );
  const cancelled = new AbortController();
  cancelled.abort();
  await assert.rejects(
    readUser(
      contextFor(binding, hung.origin, {}, cancelled.signal),
      "vca_dummy",
    ),
    (error: unknown) =>
      error instanceof ConnectorError && error.code === "cancelled",
  );
});

test("a listing with no pagination member is one page, and the destination may name the root path", async (t) => {
  const { binding } = await accountSetup(t);
  const server = await startHttpFixture(() => ({
    status: 200,
    body: { teams: [{ id: "team_x", slug: "x" }] },
  }));
  t.after(() => server.close());
  const listing = await listTeams(
    contextFor(binding, server.origin),
    "vca_dummy",
  );
  assert.deepEqual(listing, {
    teams: [{ id: "team_x", slug: "x" }],
    truncated: false,
  });
  assert.equal(server.requests.length, 1);
  const withPrefix = (pathPrefix: string) =>
    ({
      binding: runtimeBindingSchema.parse({
        ...binding,
        operations: [],
        destinations: [
          {
            id: "api",
            origin: "https://api.vercel.com",
            network: "public",
            pathPrefix,
          },
        ],
      }),
    }) as AdapterCallContext;
  assert.equal(
    accountApiDestination(withPrefix("/")).origin,
    "https://api.vercel.com",
  );
  assert.throws(
    () => accountApiDestination(withPrefix("/v2")),
    (error: unknown) =>
      error instanceof ConnectorError &&
      error.code === "network-policy" &&
      error.detail === "vercel-account.destination.api-host",
  );
  // The destination is found by its id, not by being first.
  const other = {
    binding: runtimeBindingSchema.parse({
      ...binding,
      operations: [],
      destinations: [
        {
          id: "elsewhere",
          origin: "https://attacker.example",
          network: "public",
        },
        { id: "api", origin: "https://api.vercel.com", network: "public" },
      ],
    }),
  } as AdapterCallContext;
  assert.equal(accountApiDestination(other).origin, "https://api.vercel.com");
});

// ------------------------------------------------------------- the lease

test("a lookup that finds nothing gives no lease, a connection that is another's or cannot serve is refused, and a lease is made once per call", async (t) => {
  const setup = await accountSetup(t);
  const { connectionRef } = await connectAndChoose(setup);
  const accountCtx = await setup.adapterContext(connectionRef);
  const call = (account: () => Promise<AdapterCallContext | undefined>) =>
    accountManagementSource({ account })(accountCtx);
  assert.equal(await call(async () => undefined), undefined);
  assert.equal(
    await call(
      async () =>
        ({
          ...accountCtx,
          connection: undefined,
        }) as unknown as AdapterCallContext,
    ),
    undefined,
  );
  const notOwner = (change: Record<string, unknown>) =>
    assert.rejects(
      call(async () => ({
        ...accountCtx,
        connection: { ...accountCtx.connection!, ...change },
      })),
      (error: unknown) =>
        detailOf(error) === "vercel-account.management.not-owner",
      JSON.stringify(change),
    );
  await notOwner({ ecosystem: "vercel-connect" });
  await notOwner({ ownerKind: "organization" });
  await notOwner({ ownerId: "someone-else" });
  await notOwner({ tenantId: "elsewhere" });
  // A connection that is not active, or holds no credential, cannot serve, and
  // the person is told so: it is a refusal, never "no lease" (which would let
  // the configured team token serve in their place).
  const cannotServe = (
    change: Record<string, unknown>,
    code: string,
    detail: string,
  ) =>
    assert.rejects(
      call(
        async () =>
          ({
            ...accountCtx,
            connection: { ...accountCtx.connection!, ...change },
          }) as unknown as AdapterCallContext,
      ),
      (error: unknown) =>
        error instanceof ConnectorError &&
        error.code === code &&
        error.detail === `vercel-account.management.${detail}`,
      JSON.stringify(change),
    );
  await cannotServe({ lifecycle: "expired" }, "expired", "session-expired");
  await cannotServe(
    { lifecycle: "reconnect-required" },
    "human-required",
    "sign-in-required",
  );
  await cannotServe({ lifecycle: "degraded" }, "conflict", "sign-in-unsettled");
  await cannotServe(
    { credentialRef: undefined },
    "human-required",
    "sign-in-required",
  );

  // The same context asked twice is answered with the same credential, not a second lease.
  const lease = accountManagementSource({ account: async () => accountCtx });
  const environment = setup.environment();
  const connectCtx = {
    ...accountCtx,
    environment: {
      ...environment,
      configuration: {
        read: async (name: string) =>
          name === "VERCEL_TEAM_ID" ? "team_dummy_acme" : undefined,
        present: async () => new Set<string>(),
        revision: async () => "cfg:1",
      },
    },
  } as AdapterCallContext;
  let looked = 0;
  const counted = async (ctx: AdapterCallContext) => {
    looked++;
    return lease(ctx);
  };
  const settings = {
    project: { id: "prj", environment: "production" },
    profiles: {},
    defaultProfile: "x",
    returnPath: "/r",
  } as never;
  const first = await resolveCredential(connectCtx, "management", settings, {
    managementToken: counted,
  });
  const second = await resolveCredential(connectCtx, "management", settings, {
    managementToken: counted,
  });
  assert.equal(first, second);
  assert.equal(looked, 1);
});

// ------------------------------------------------ what the adapter answers

test("a claim carries an expiry only when the token has one still to come", async (t) => {
  const setup = await accountSetup(t);
  const { connectionRef } = await connectAndChoose(setup);
  const ctx = await setup.adapterContext(connectionRef);
  const base = {
    user: { id: alice.id },
    team: { id: "team_dummy_acme" },
    reported: [],
  };
  const validUntil = (given: number | undefined) =>
    claimsFor(ctx, { ...base, validUntil: given }).map(
      (claim) => claim.validUntil,
    );
  const now = setup.clock();
  assert.deepEqual(validUntil(undefined), [undefined, undefined, undefined]);
  assert.deepEqual(validUntil(now), [undefined, undefined, undefined]);
  assert.deepEqual(validUntil(now - 1), [undefined, undefined, undefined]);
  const later = new Date(now + 1).toISOString();
  assert.deepEqual(validUntil(now + 1), [later, later, later]);
});

test("a poll answers a choice with no claim, a nothing-to-choose with a denial, a different user with a denial, and a typed pick of 256 characters is read but 257 is not", async (t) => {
  const adapter = createVercelAccountAdapter();
  const pollOf = async (options: Parameters<typeof accountSetup>[1]) => {
    const setup = await accountSetup(t, options);
    const connected = await setup.service.connect(setup.person, {
      bindingRef: setup.binding.bindingRef,
      intent: {},
    });
    setup.fixture.approve(userCodeOf(connected));
    setup.advance(6_000);
    const handoff = await setup.ports.handoffs.present(
      setup.person,
      handoffRefOf(connected),
    );
    assert.ok(handoff);
    const ctx = await setup.adapterContext(connectionRefOf(connected));
    return {
      setup,
      ctx,
      result: await adapter.complete!({ ...ctx, handoff }, { kind: "poll" }),
    };
  };
  const choose = await pollOf({});
  assert.equal(choose.result.state, "human-required");
  assert.equal(choose.result.code, "vercel-account.selection.required");
  assert.deepEqual(choose.result.claims, []);
  assert.equal(choose.result.handoffSettled, true);
  assert.equal(choose.result.handoff?.intent, "vercel-account.select-team");
  const none = await pollOf({ teams: ["team_dummy_unrelated"] });
  assert.equal(none.result.state, "denied");
  assert.equal(none.result.code, "vercel-account.selection.nothing-permitted");
  assert.deepEqual(none.result.claims, []);
  assert.equal(none.result.handoffSettled, true);

  // A connection that already belongs to someone else's sign-in refuses this one.
  const setup = await accountSetup(t, { teams: ["team_dummy_acme"] });
  const connected = await setup.service.connect(setup.person, {
    bindingRef: setup.binding.bindingRef,
    intent: {},
  });
  setup.fixture.approve(userCodeOf(connected));
  setup.advance(6_000);
  const handoff = await setup.ports.handoffs.present(
    setup.person,
    handoffRefOf(connected),
  );
  const ctx = await setup.adapterContext(connectionRefOf(connected));
  const taken = {
    ...ctx,
    handoff,
    connection: {
      ...ctx.connection!,
      state: {
        ...ctx.connection!.state,
        vercelAccount: {
          userId: "someone-else",
          teamId: "team_dummy_acme",
          slug: "acme",
        },
      },
    },
  } as AdapterCallContext;
  const denied = await adapter.complete!(taken, { kind: "poll" });
  assert.deepEqual(
    [denied.state, denied.code, denied.claims, denied.handoffSettled],
    ["denied", "vercel-account.user.changed", [], true],
  );

  // The pick: 256 characters are read (and found unknown), 257 are not read at all.
  const picked = await accountSetup(t);
  const first = await connectAndApprove(picked);
  const choice = await picked.ports.handoffs.present(
    picked.person,
    handoffRefOf(first.polled),
  );
  assert.ok(choice);
  const pickCtx = await picked.adapterContext(first.connectionRef);
  const ask = (team: string) =>
    adapter.complete!(
      { ...pickCtx, handoff: choice },
      { kind: "input", values: { team } },
    );
  const refused = (detail: string) => (error: unknown) =>
    error instanceof ConnectorError &&
    error.code === "invalid-request" &&
    error.detail === detail;
  await assert.rejects(
    ask("x".repeat(256)),
    refused("vercel-account.team.unknown"),
  );
  await assert.rejects(
    ask("x".repeat(257)),
    refused("vercel-account.selection.fields"),
  );
  await assert.rejects(ask("  "), refused("vercel-account.selection.fields"));
});

test("an outage while reading an account is an outage, not a session that ended", async (t) => {
  const setup = await accountSetup(t);
  const { connectionRef } = await connectAndChoose(setup);
  setup.fixture.failRest(503);
  await assert.rejects(
    setup.service.invoke(setup.agent, connectionRef, {
      operationRef: "vercel-account.get-user",
      input: {},
      commandId: "outage",
    }),
    (error: unknown) =>
      error instanceof ConnectorError && error.code === "upstream-unavailable",
  );
});

// ------------------------------------------- the rest of what is observable

test("slugs are cleaned at their edges in the line, and the handoff tells the page which one field to ask for", async (t) => {
  const { setup, first, text } = await offered(t, [
    { slug: "\u0007acme\u0007" },
    { slug: "labs" },
  ]);
  assert.equal(text, `${LEAD}acme (team_dummy_000); labs (team_dummy_001).`);
  const choice = await setup.ports.handoffs.present(
    setup.person,
    handoffRefOf(first.polled),
  );
  assert.equal(choice?.private["fields"], JSON.stringify(["team"]));
});

test("a token with no stated lifetime leaves no expiry in the state or the claims", async (t) => {
  const setup = await accountSetup(t, {
    teams: ["team_dummy_acme"],
    double: { omitExpiresIn: true },
  });
  const { connectionRef } = await connectAndApprove(setup);
  const record = await setup.record(connectionRef);
  assert.deepEqual(record.state["vercelAccount"], {
    userId: alice.id,
    teamId: "team_dummy_acme",
    slug: "acme",
    reported: ["openid", "offline_access"],
  });
  assert.equal(record.verification?.validUntil, undefined);
  const adapter = createVercelAccountAdapter();
  const ctx = await setup.adapterContext(connectionRef);
  const result = await adapter.verify!(ctx);
  assert.equal(result.state, "complete");
  assert.deepEqual(result.adapterState?.["vercelAccount"], {
    userId: alice.id,
    teamId: "team_dummy_acme",
    slug: "acme",
    reported: ["openid", "offline_access"],
  });
  for (const claim of result.claims) assert.equal(claim.validUntil, undefined);
});

test("an operation bound under a name the adapter does not know is not run as one it does", async (t) => {
  const setup = await accountSetup(t);
  const adapter = createVercelAccountAdapter();
  const { connectionRef } = await connectAndChoose(setup);
  const ctx = await setup.adapterContext(connectionRef);
  const withStranger = {
    ...ctx,
    binding: runtimeBindingSchema.parse({
      ...setup.binding,
      operations: [
        ...vercelAccountBoundOperations(),
        {
          ...vercelAccountBoundOperations()[0]!,
          operationRef: "vercel-account.other",
          nativeId: "Other",
        },
      ],
    }),
  } as AdapterCallContext;
  const before = setup.fixture.apiRequests.length;
  await assert.rejects(
    adapter.invoke!(withStranger, {
      operationRef: "vercel-account.other",
      input: {},
      commandId: "c",
    }),
    (error: unknown) => detailOf(error) === "vercel-account.operation.unbound",
  );
  assert.equal(setup.fixture.apiRequests.length, before, "nothing was sent");
});

test("a verification of a session the person ended answers expired, with no claim", async (t) => {
  const setup = await accountSetup(t);
  const adapter = createVercelAccountAdapter();
  const { connectionRef } = await connectAndChoose(setup);
  const ctx = await setup.adapterContext(connectionRef);
  setup.fixture.revokeApp(alice.id);
  const result = await adapter.verify!(ctx);
  assert.deepEqual(
    [result.state, result.code, result.claims],
    ["expired", "vercel-account.session.revoked", []],
  );
});

test("an issuer that is down is an outage even when the client id is also missing", async (t) => {
  const setup = await accountSetup(t, { clientId: null });
  const view = (await setup.service.connect(setup.person, {
    bindingRef: setup.binding.bindingRef,
    intent: {},
  })) as { connectionRef: string };
  const ctx = await setup.adapterContext(view.connectionRef);
  await setup.fixture.stopIssuer();
  await assert.rejects(
    createVercelAccountAdapter().authorize!(ctx, {
      ownerKind: "user",
    } as never),
    (error: unknown) =>
      error instanceof ConnectorError &&
      error.code === "upstream-unavailable" &&
      error.detail === "oauth.discovery.unavailable",
  );
});

test("a custody record that holds no access token is a conflict the adapter names, not a request without a bearer", async (t) => {
  const setup = await accountSetup(t);
  const { connectionRef } = await connectAndChoose(setup);
  const connection = await setup.record(connectionRef);
  const scope = {
    tenantId: connection.tenantId,
    ownerKind: connection.ownerKind,
    ownerId: connection.ownerId,
    connectionRef: connection.connectionRef,
    bindingRef: connection.bindingRef,
    custody: connection.custody,
  };
  await setup.ports.credentials.refresh(
    scope,
    connection.credentialRef!,
    async (current) => {
      const { access_token: _gone, ...rest } = current;
      void _gone;
      return { material: rest, expiresAt: Number(current["expires_at"]) };
    },
  );
  const before = setup.fixture.apiRequests.length;
  await assert.rejects(
    setup.service.invoke(setup.agent, connectionRef, {
      operationRef: "vercel-account.get-user",
      input: {},
      commandId: "malformed",
    }),
    (error: unknown) =>
      error instanceof ConnectorError &&
      error.code === "conflict" &&
      error.detail === "vercel-account.credential.malformed",
  );
  assert.equal(setup.fixture.apiRequests.length, before);
});

test("the user a connection was bound to is read from its state, and a connection with none has none", async () => {
  await Promise.resolve();
  assert.equal(priorUserId({} as AdapterCallContext), undefined);
  assert.equal(priorUserId(stateOnly({})), undefined);
  assert.equal(
    priorUserId(
      stateOnly({
        vercelAccount: { userId: "u", teamId: "t", slug: "s" },
      }),
    ),
    "u",
  );
});
