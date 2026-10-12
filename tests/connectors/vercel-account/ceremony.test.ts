import assert from "node:assert/strict";
import test from "node:test";
import { ConnectorError } from "../../../src/server/connectors/errors.js";
import {
  accountSetup,
  alice,
  CLIENT_ID,
  connectAndApprove,
  connectAndChoose,
  connectionRefOf,
  handoffRefOf,
  START_TIME,
  userCodeOf,
} from "./harness.js";

/*
 * The ceremony as a person lives it: connect, approve on Vercel's own page,
 * pick a team, and end up with a connection whose token the caller never
 * sees. Each test fails without the behaviour it names: remove the
 * permitted-team filter and the third team is offered, drop the check against
 * Vercel's own list and a typed team that is not the person's is bound, and
 * so on.
 */

type View = {
  lifecycle: string;
  lastOutcome?: string;
  target?: { kind: string; id: string };
  verification?: { kinds: string[]; validUntil?: string };
  presentation?: { url?: string; userCode?: string; instructions?: string };
  handoff?: { kind: string; state: string; handoffRef: string };
};
const asView = (value: unknown) => value as View;

test("a person signs in, picks a team, and the connection is active", async (t) => {
  const setup = await accountSetup(t);
  const { fixture } = setup;
  const connected = asView(
    await setup.service.connect(setup.person, {
      bindingRef: setup.binding.bindingRef,
      intent: {},
    }),
  );
  // The person is shown the page to open and the code to type, nothing else.
  assert.equal(connected.lifecycle, "authorization-required");
  assert.equal(connected.handoff?.kind, "device-code");
  const userCode = userCodeOf(connected);
  assert.match(connected.presentation!.url!, /\/oauth\/device\?user_code=/);
  assert.equal(
    JSON.stringify(connected).includes(fixture.issued.deviceCodes[0]!),
    false,
    "the device code is never presented",
  );
  // The device request named the client and the two scopes, and nothing secret.
  const [request] = fixture.apiRequests.filter(
    (item) => item.url.pathname === "/login/oauth/device-authorization",
  );
  const sent = new URLSearchParams(request!.body.toString("utf8"));
  assert.equal(sent.get("client_id"), CLIENT_ID);
  assert.equal(sent.get("scope"), "openid offline_access");
  assert.equal(request!.headers["authorization"], undefined);

  // Before anyone approves, a poll is pending; an immediate second one waits.
  const connectionRef = connectionRefOf(connected);
  setup.advance(6_000);
  const pending = asView(await setup.service.poll(setup.person, connectionRef));
  assert.equal(pending.lastOutcome, "oauth.device.pending");
  const before = fixture.counts.token;
  const waiting = asView(await setup.service.poll(setup.person, connectionRef));
  assert.equal(waiting.lastOutcome, "oauth.device.wait");
  assert.equal(fixture.counts.token, before, "no request inside the interval");

  // The person approves on Vercel's page; the next poll asks them to choose.
  assert.ok(fixture.approve(userCode));
  setup.advance(6_000);
  const choose = asView(await setup.service.poll(setup.person, connectionRef));
  assert.equal(choose.lifecycle, "human-required");
  assert.equal(choose.handoff?.kind, "input-required");
  const offered = choose.presentation!.instructions!;
  assert.match(offered, /acme \(team_dummy_acme\)/);
  assert.match(offered, /labs \(team_dummy_labs\)/);
  assert.equal(
    offered.includes("elsewhere"),
    false,
    "a team the binding does not permit is never offered",
  );

  const active = asView(
    await setup.service.provideInput(
      setup.person,
      connectionRef,
      handoffRefOf(choose),
      { team: "acme" },
    ),
  );
  assert.equal(active.lifecycle, "active");
  assert.deepEqual(active.target, {
    kind: "vercel-team",
    id: "team_dummy_acme",
  });
  assert.deepEqual(active.verification?.kinds, [
    "credential-accepted",
    "account-identity",
    "resource-access",
  ]);
  // The caller sees the expiry of the token Vercel issued: an hour on.
  assert.equal(
    active.verification?.validUntil,
    new Date(setup.clock() + 3_600_000).toISOString(),
  );
  assert.deepEqual(fixture.violations, []);
  const held = await setup.heldMaterial(connectionRef);
  assert.equal(held["access_token"], fixture.issued.accessTokens[0]);
  assert.equal(held["refresh_token"], fixture.issued.refreshTokens[0]);
  assert.equal(held["client_id"], CLIENT_ID);
  // The person's id and the team are in the connection's state, not in custody.
  const record = await setup.record(connectionRef);
  assert.deepEqual(record.state["vercelAccount"], {
    userId: alice.id,
    teamId: "team_dummy_acme",
    slug: "acme",
    expiresAt: START_TIME + 12_000 + 3_600_000,
  });
});

test("exactly one permitted team binds without asking", async (t) => {
  const setup = await accountSetup(t, { teams: ["team_dummy_labs"] });
  const { polled } = await connectAndApprove(setup);
  const view = asView(polled);
  assert.equal(view.lifecycle, "active");
  assert.equal(view.target?.id, "team_dummy_labs");
});

test("an intent naming a team narrows what is offered", async (t) => {
  const setup = await accountSetup(t);
  const { polled } = await connectAndApprove(setup, {
    target: { kind: "vercel-team", id: "team_dummy_labs" },
  });
  const view = asView(polled);
  assert.equal(view.lifecycle, "active");
  assert.equal(view.target?.id, "team_dummy_labs");
});

test("a team the binding does not permit is refused even when typed", async (t) => {
  const setup = await accountSetup(t);
  const first = await connectAndApprove(setup);
  const attempt = (team: string) =>
    setup.service.provideInput(
      setup.person,
      first.connectionRef,
      handoffRefOf(first.polled),
      { team },
    );
  for (const typed of ["elsewhere", "team_dummy_other"])
    await assert.rejects(
      attempt(typed),
      (error: unknown) =>
        error instanceof ConnectorError &&
        error.detail === "vercel-account.team.not-permitted",
    );
  const record = await setup.record(first.connectionRef);
  assert.equal(record.lifecycle, "human-required", "the choice stays open");
});

test("a team Vercel does not list for this person is refused, the choice stays open, and a valid one then works", async (t) => {
  const setup = await accountSetup(t);
  const first = await connectAndApprove(setup);
  const handoffRef = handoffRefOf(first.polled);
  await assert.rejects(
    setup.service.provideInput(setup.person, first.connectionRef, handoffRef, {
      team: "someone-elses",
    }),
    (error: unknown) =>
      error instanceof ConnectorError &&
      error.detail === "vercel-account.team.unknown",
  );
  // The id is accepted as well as the slug.
  const retried = asView(
    await setup.service.provideInput(
      setup.person,
      first.connectionRef,
      handoffRef,
      { team: "team_dummy_labs" },
    ),
  );
  assert.equal(retried.lifecycle, "active");
  assert.equal(retried.target?.id, "team_dummy_labs");
});

test("an id wins over a slug spelled like it, so a pick means one team", async (t) => {
  const tangled = {
    ...alice,
    teams: [
      { id: "team_dummy_a", slug: "team_dummy_b", createdAt: START_TIME - 2 },
      { id: "team_dummy_b", slug: "b", createdAt: START_TIME - 3 },
    ],
  };
  const setup = await accountSetup(t, {
    people: [tangled],
    teams: ["team_dummy_a", "team_dummy_b"],
  });
  const first = await connectAndApprove(setup);
  const active = asView(
    await setup.service.provideInput(
      setup.person,
      first.connectionRef,
      handoffRefOf(first.polled),
      { team: "team_dummy_b" },
    ),
  );
  assert.equal(active.target?.id, "team_dummy_b");
});

test("a choice outside the one field, or in the wrong shape, is refused before Vercel is asked", async (t) => {
  const setup = await accountSetup(t);
  const first = await connectAndApprove(setup);
  const handoffRef = handoffRefOf(first.polled);
  const teamsBefore = setup.fixture.counts.teams;
  const attempt = (values: Record<string, string>) =>
    setup.service.provideInput(
      setup.person,
      first.connectionRef,
      handoffRef,
      values,
    );
  await assert.rejects(attempt({}), /not valid/);
  await assert.rejects(attempt({ team: "acme", extra: "x" }), /not valid/);
  await assert.rejects(attempt({ team: "  " }), /not valid/);
  await assert.rejects(attempt({ team: "x".repeat(257) }), /not valid/);
  assert.equal(setup.fixture.counts.teams, teamsBefore);
});

test("teams past the first page are found by following the pagination", async (t) => {
  const many = {
    ...alice,
    teams: Array.from({ length: 7 }, (_, index) => ({
      id: `team_dummy_${index}`,
      slug: `team-${index}`,
      createdAt: START_TIME - (index + 1) * 86_400_000,
    })),
  };
  const setup = await accountSetup(t, {
    people: [many],
    teams: ["team_dummy_6", "team_dummy_5"],
    double: { pageCap: 2 },
  });
  const first = await connectAndApprove(setup);
  const choose = asView(first.polled);
  assert.match(choose.presentation!.instructions!, /team-6/);
  assert.equal(setup.fixture.counts.teams, 4, "four pages of two, then one");
  const active = asView(
    await setup.service.provideInput(
      setup.person,
      first.connectionRef,
      handoffRefOf(first.polled),
      { team: "team-6" },
    ),
  );
  assert.equal(active.target?.id, "team_dummy_6");
});

test("an agent can read the connection but cannot make the choice", async (t) => {
  const setup = await accountSetup(t);
  const first = await connectAndApprove(setup);
  await assert.rejects(
    setup.service.provideInput(
      setup.agent,
      first.connectionRef,
      handoffRefOf(first.polled),
      { team: "acme" },
    ),
    (error: unknown) =>
      error instanceof ConnectorError && error.detail === "input.human-only",
  );
  const seen = (await setup.service.status(
    setup.agent,
    first.connectionRef,
  )) as Record<string, unknown>;
  assert.equal(seen["lifecycle"], "human-required");
  assert.equal("presentation" in seen, false);
});

test("a denied approval ends the attempt with no credential held", async (t) => {
  const setup = await accountSetup(t);
  const connected = await setup.service.connect(setup.person, {
    bindingRef: setup.binding.bindingRef,
    intent: {},
  });
  const connectionRef = connectionRefOf(connected);
  assert.ok(setup.fixture.deny(userCodeOf(connected)));
  setup.advance(6_000);
  const view = asView(await setup.service.poll(setup.person, connectionRef));
  assert.equal(view.lifecycle, "authorization-required");
  assert.equal(view.lastOutcome, "oauth.device.access-denied");
  assert.equal(view.handoff?.state, "denied");
  assert.equal((await setup.record(connectionRef)).credentialRef, undefined);
  assert.equal(setup.fixture.issued.accessTokens.length, 0);
});

test("a code the server expired is expired, whatever the handoff said", async (t) => {
  const setup = await accountSetup(t);
  const connected = await setup.service.connect(setup.person, {
    bindingRef: setup.binding.bindingRef,
    intent: {},
  });
  setup.fixture.expireDevice(userCodeOf(connected));
  setup.advance(6_000);
  const view = asView(
    await setup.service.poll(setup.person, connectionRefOf(connected)),
  );
  assert.equal(view.lifecycle, "authorization-required");
  assert.equal(view.lastOutcome, "oauth.device.expired");
  assert.equal(view.handoff?.state, "expired");
});

test("a server that answers slow_down is obeyed: the interval grows by five seconds", async (t) => {
  const setup = await accountSetup(t, { double: { slowDownFirst: 1 } });
  const connected = await setup.service.connect(setup.person, {
    bindingRef: setup.binding.bindingRef,
    intent: {},
  });
  const connectionRef = connectionRefOf(connected);
  assert.ok(setup.fixture.approve(userCodeOf(connected)));
  setup.advance(6_000);
  const slowed = asView(await setup.service.poll(setup.person, connectionRef));
  assert.equal(slowed.lastOutcome, "oauth.device.slow-down");
  // 5s advertised + 5s increment: nothing is sent before ten seconds pass.
  setup.advance(9_000);
  const before = setup.fixture.counts.token;
  const waiting = asView(await setup.service.poll(setup.person, connectionRef));
  assert.equal(waiting.lastOutcome, "oauth.device.wait");
  assert.equal(setup.fixture.counts.token, before);
  setup.advance(2_000);
  const done = asView(await setup.service.poll(setup.person, connectionRef));
  assert.equal(done.lifecycle, "human-required");
  assert.equal(setup.fixture.counts.tooFastPolls, 0, "never polled early");
});

test("a person who belongs to none of the permitted teams ends with nothing held", async (t) => {
  const setup = await accountSetup(t, { teams: ["team_dummy_unrelated"] });
  const { polled, connectionRef } = await connectAndApprove(setup);
  const view = asView(polled);
  assert.equal(view.lifecycle, "authorization-required");
  assert.equal(view.lastOutcome, "vercel-account.selection.nothing-permitted");
  const record = await setup.record(connectionRef);
  assert.equal(record.credentialRef, undefined);
});

test("only a person signs in: a second connect with the same intent returns the connection", async (t) => {
  const setup = await accountSetup(t);
  const done = await connectAndChoose(setup);
  const again = await setup.service.connect(setup.person, {
    bindingRef: setup.binding.bindingRef,
    intent: {},
  });
  assert.equal(connectionRefOf(again), done.connectionRef);
  assert.equal(setup.fixture.counts.device, 1, "no second device request");
});
