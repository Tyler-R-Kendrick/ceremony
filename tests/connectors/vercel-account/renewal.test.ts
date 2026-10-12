import assert from "node:assert/strict";
import test from "node:test";
import { ensureFresh } from "../../../src/server/connectors/providers/vercel-account/session.js";
import {
  accountSetup,
  alice,
  CLIENT_ID,
  connectAndApprove,
  connectAndChoose,
  handoffRefOf,
  userCodeOf,
  type AccountSetup,
} from "./harness.js";

/*
 * Vercel's access token lasts an hour and its refresh token is single use, so
 * what keeps a connection useful is one refresh grant per hour, journaled
 * before it is sent. These tests move the clock and watch which request each
 * layer makes: a token with time left is left alone, one about to lapse costs
 * one refresh with the newest refresh token, and a refresh token that was
 * spent (or never issued) ends the session for a person to start again.
 */

type View = {
  lifecycle: string;
  lastOutcome?: string;
  revision: number;
  verification?: { validUntil?: string };
};
const asView = (value: unknown) => value as View;
const MINUTE = 60_000;

const verify = async (setup: AccountSetup, connectionRef: string) =>
  asView(await setup.service.verify(setup.person, connectionRef));

const refreshEntries = (setup: AccountSetup) =>
  setup.journal.filter(
    (entry) =>
      "operation" in entry && entry.operation === "oauth.token.refresh",
  );

test("a token with time left is left alone", async (t) => {
  const setup = await accountSetup(t);
  const { connectionRef } = await connectAndChoose(setup);
  setup.advance(30 * MINUTE);
  const view = await verify(setup, connectionRef);
  assert.equal(view.lifecycle, "active");
  assert.equal(setup.fixture.counts.refresh, 0);
});

test("a token about to lapse costs one refresh, and each refresh token is used once", async (t) => {
  const setup = await accountSetup(t);
  const { connectionRef } = await connectAndChoose(setup);
  // 59 minutes: the one-hour token has under two minutes left.
  setup.advance(59 * MINUTE);
  const first = await verify(setup, connectionRef);
  assert.equal(first.lifecycle, "active");
  assert.equal(setup.fixture.counts.refresh, 1);
  assert.equal(
    first.verification?.validUntil,
    new Date(setup.clock() + 60 * MINUTE).toISOString(),
    "the claim carries the new token's expiry",
  );
  const held = await setup.heldMaterial(connectionRef);
  assert.equal(held["access_token"], setup.fixture.issued.accessTokens[1]);
  assert.equal(held["refresh_token"], setup.fixture.issued.refreshTokens[1]);
  assert.equal(held["client_id"], CLIENT_ID);
  setup.advance(59 * MINUTE);
  assert.equal((await verify(setup, connectionRef)).lifecycle, "active");
  assert.equal(
    setup.fixture.counts.refresh,
    2,
    "the rotated token, not the first",
  );
  assert.equal(setup.fixture.counts.replayedRefreshTokens, 0);
  assert.equal(refreshEntries(setup).length, 2);
});

test("with no refresh token a lapsed access token ends the session for a person to start again", async (t) => {
  const setup = await accountSetup(t, { settings: { scopes: ["openid"] } });
  const { connectionRef } = await connectAndChoose(setup);
  assert.equal(setup.fixture.issued.refreshTokens.length, 0);
  setup.advance(59 * MINUTE);
  const view = await verify(setup, connectionRef);
  assert.equal(view.lifecycle, "expired");
  assert.equal(view.lastOutcome, "vercel-account.session.expired");
  assert.equal(setup.fixture.counts.refresh, 0, "nothing was presented");
});

test("a refresh Vercel refuses ends the session", async (t) => {
  const setup = await accountSetup(t);
  const { connectionRef } = await connectAndChoose(setup);
  // Someone spends the refresh token elsewhere: the double rotates it, so the held one is dead.
  const spent = setup.fixture.issued.refreshTokens[0]!;
  const elsewhere = await fetch(
    `${setup.fixture.apiOrigin}/login/oauth/token`,
    {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "refresh_token",
        client_id: CLIENT_ID,
        refresh_token: spent,
      }),
    },
  );
  assert.equal(elsewhere.status, 200);
  setup.advance(59 * MINUTE);
  const view = await verify(setup, connectionRef);
  assert.equal(view.lifecycle, "expired");
  assert.equal(view.lastOutcome, "vercel-account.session.refresh-rejected");
  assert.equal(setup.fixture.counts.replayedRefreshTokens, 1);
});

test("an application restricted to a team the person left is refused at refresh, which ends the session", async (t) => {
  const setup = await accountSetup(t);
  const { connectionRef } = await connectAndChoose(setup);
  // Vercel's dashboard page: a team-restricted application is refused with
  // access_denied when the user authorizes, completes the device flow or refreshes.
  setup.fixture.refuseRefreshesWith("access_denied");
  setup.advance(59 * MINUTE);
  const view = await verify(setup, connectionRef);
  assert.equal(view.lifecycle, "expired");
  assert.equal(view.lastOutcome, "vercel-account.session.refresh-rejected");
  assert.equal(setup.fixture.counts.refresh, 1);
  // And it is not tried again.
  setup.fixture.refuseRefreshesWith(null);
  const again = await verify(setup, connectionRef);
  assert.equal(again.lifecycle, "expired");
  assert.equal(
    setup.fixture.counts.refresh,
    1,
    "the refresh token is not presented again",
  );
});

test("a person who removes the app in their dashboard ends the session, even with the token in date", async (t) => {
  const setup = await accountSetup(t);
  const { connectionRef } = await connectAndChoose(setup);
  setup.fixture.revokeApp(alice.id);
  setup.advance(10 * MINUTE);
  const view = await verify(setup, connectionRef);
  assert.equal(view.lifecycle, "expired");
  assert.equal(view.lastOutcome, "vercel-account.session.revoked");
  assert.equal(
    setup.fixture.counts.refresh,
    0,
    "the token was not out of date",
  );
});

test("a team the person left is a reconnect, not a retry", async (t) => {
  const setup = await accountSetup(t);
  const { connectionRef } = await connectAndChoose(setup);
  setup.fixture.leaveTeam(alice.id, "team_dummy_acme");
  const view = await verify(setup, connectionRef);
  assert.equal(view.lifecycle, "reconnect-required");
  assert.equal(view.lastOutcome, "vercel-account.team.left");
});

test("a team renamed at Vercel is followed: the slug is refreshed, the id is what binds", async (t) => {
  const setup = await accountSetup(t);
  const { connectionRef } = await connectAndChoose(setup);
  setup.fixture.leaveTeam(alice.id, "team_dummy_acme");
  setup.fixture.addTeam(alice.id, {
    id: "team_dummy_acme",
    slug: "acme-renamed",
    createdAt: alice.teams[0]!.createdAt,
  });
  const view = await verify(setup, connectionRef);
  assert.equal(view.lifecycle, "active");
  const record = await setup.record(connectionRef);
  assert.equal(
    (record.state["vercelAccount"] as { slug: string }).slug,
    "acme-renamed",
  );
});

test("concurrent users of an expiring token share one refresh", async (t) => {
  const setup = await accountSetup(t);
  const { connectionRef } = await connectAndChoose(setup);
  setup.advance(59 * MINUTE);
  const ctx = await setup.adapterContext(connectionRef);
  const ref = ctx.connection!.credentialRef!;
  await Promise.all([1, 2, 3].map(() => ensureFresh(ctx, ref, {})));
  assert.equal(setup.fixture.counts.refresh, 1, "one refresh, not three");
  assert.equal(setup.fixture.counts.replayedRefreshTokens, 0);
  const held = await setup.heldMaterial(connectionRef);
  assert.equal(held["access_token"], setup.fixture.issued.accessTokens[1]);
});

test("a local disconnect releases everything the sign-in held and tells Vercel nothing", async (t) => {
  const setup = await accountSetup(t, { revoke: true });
  const { connectionRef, done } = await connectAndChoose(setup);
  const before = await setup.record(connectionRef);
  const view = asView(
    await setup.service
      .disconnect(setup.person, connectionRef, {
        expectedRevision: asView(done).revision,
        scope: "local",
      })
      .then((result) => result.connection),
  );
  assert.equal(view.lifecycle, "locally-disconnected");
  assert.equal(setup.fixture.counts.revoke, 0);
  const scope = {
    tenantId: before.tenantId,
    ownerKind: before.ownerKind,
    ownerId: before.ownerId,
    connectionRef: before.connectionRef,
    bindingRef: before.bindingRef,
    custody: before.custody,
  };
  assert.equal(
    await setup.ports.credentials.describe(scope, before.credentialRef!),
    undefined,
    "the access token and the refresh token are gone",
  );
});

test("an upstream disconnect presents both tokens to Vercel's revocation endpoint when the policy says so", async (t) => {
  const setup = await accountSetup(t, { revoke: true });
  const { connectionRef, done } = await connectAndChoose(setup);
  const { accessTokens, refreshTokens } = setup.fixture.issued;
  const result = await setup.service.disconnect(setup.person, connectionRef, {
    expectedRevision: asView(done).revision,
    scope: "upstream",
  });
  assert.equal(result.result.upstream, "applied");
  assert.deepEqual(
    setup.fixture.revocations.map((item) => [item.token, item.hint]),
    [
      [refreshTokens[0], "refresh_token"],
      [accessTokens[0], "access_token"],
    ],
  );
  assert.equal(setup.fixture.accessTokenValid(accessTokens[0]!), false);
  assert.equal(setup.fixture.refreshTokenUsable(refreshTokens[0]!), false);
  assert.deepEqual(setup.fixture.violations, []);
});

test("an upstream disconnect with revocation off says it did not try", async (t) => {
  const setup = await accountSetup(t);
  const { connectionRef, done } = await connectAndChoose(setup);
  const result = await setup.service.disconnect(setup.person, connectionRef, {
    expectedRevision: asView(done).revision,
    scope: "upstream",
  });
  assert.equal(result.result.upstream, "not-attempted");
  assert.equal(setup.fixture.counts.revoke, 0);
  assert.equal(
    setup.fixture.accessTokenValid(setup.fixture.issued.accessTokens[0]!),
    true,
    "the token Vercel issued still works: only the host forgot it",
  );
});

test("reconnecting is a new sign-in, and the old credentials are released once it completes", async (t) => {
  const setup = await accountSetup(t, { teams: ["team_dummy_acme"] });
  const { connectionRef, polled } = await connectAndApprove(setup);
  const first = await setup.record(connectionRef);
  const scope = {
    tenantId: first.tenantId,
    ownerKind: first.ownerKind,
    ownerId: first.ownerId,
    connectionRef: first.connectionRef,
    bindingRef: first.bindingRef,
    custody: first.custody,
  };
  const reconnecting = await setup.service.reconnect(
    setup.person,
    connectionRef,
    { expectedRevision: asView(polled).revision },
  );
  assert.ok(setup.fixture.approve(userCodeOf(reconnecting)));
  setup.advance(6_000);
  const again = asView(await setup.service.poll(setup.person, connectionRef));
  assert.equal(again.lifecycle, "active");
  assert.equal(
    setup.fixture.counts.device,
    2,
    "one device request per sign-in",
  );
  assert.equal(
    await setup.ports.credentials.describe(scope, first.credentialRef!),
    undefined,
    "the superseded record was released",
  );
  assert.notEqual(
    (await setup.record(connectionRef)).credentialRef,
    first.credentialRef,
  );
});

test("reconnecting into a different team is refused without an explicit account switch", async (t) => {
  const setup = await accountSetup(t);
  const { connectionRef, done } = await connectAndChoose(setup);
  const reconnecting = await setup.service.reconnect(
    setup.person,
    connectionRef,
    { expectedRevision: asView(done).revision },
  );
  setup.fixture.approve(userCodeOf(reconnecting));
  setup.advance(6_000);
  const choose = await setup.service.poll(setup.person, connectionRef);
  const view = asView(
    await setup.service.provideInput(
      setup.person,
      connectionRef,
      handoffRefOf(choose),
      { team: "labs" },
    ),
  );
  assert.equal(view.lifecycle, "reconnect-required");
  assert.equal(view.lastOutcome, "verification.account-changed");
});

test("a different person approving the reconnect is refused unless an account switch was asked for", async (t) => {
  const bob = {
    id: "user_dummy_bob",
    username: "bob",
    teams: [alice.teams[0]!],
  };
  const setup = await accountSetup(t, {
    people: [structuredClone(alice), bob],
    teams: ["team_dummy_acme"],
  });
  const { connectionRef, polled } = await connectAndApprove(setup);
  const before = await setup.record(connectionRef);
  const reconnecting = await setup.service.reconnect(
    setup.person,
    connectionRef,
    { expectedRevision: asView(polled).revision },
  );
  assert.ok(setup.fixture.approve(userCodeOf(reconnecting), bob.id));
  setup.advance(6_000);
  const view = asView(await setup.service.poll(setup.person, connectionRef));
  assert.equal(view.lifecycle, "authorization-required");
  assert.equal(view.lastOutcome, "vercel-account.user.changed");
  const after = await setup.record(connectionRef);
  assert.equal(
    (after.state["vercelAccount"] as { userId: string }).userId,
    alice.id,
    "the connection is still Alice's",
  );
  assert.equal(after.credentialRef, before.credentialRef);
  // Bob's token was released, not kept: the only record left is Alice's.
  const bobsToken = setup.fixture.issued.accessTokens.at(-1)!;
  assert.notEqual(
    (await setup.heldMaterial(connectionRef))["access_token"],
    bobsToken,
  );
});

test("an account switch the person asked for binds the new user", async (t) => {
  const bob = {
    id: "user_dummy_bob",
    username: "bob",
    teams: [alice.teams[0]!],
  };
  const setup = await accountSetup(t, {
    people: [structuredClone(alice), bob],
    teams: ["team_dummy_acme"],
  });
  const { connectionRef, polled } = await connectAndApprove(setup);
  const reconnecting = await setup.service.reconnect(
    setup.person,
    connectionRef,
    { expectedRevision: asView(polled).revision, accountSwitch: true },
  );
  assert.ok(setup.fixture.approve(userCodeOf(reconnecting), bob.id));
  setup.advance(6_000);
  const view = asView(await setup.service.poll(setup.person, connectionRef));
  assert.equal(view.lifecycle, "active");
  const after = await setup.record(connectionRef);
  assert.equal(
    (after.state["vercelAccount"] as { userId: string }).userId,
    bob.id,
  );
});
