import assert from "node:assert/strict";
import test from "node:test";
import {
  accountSetup,
  connectAndApprove,
  connectAndChoose,
  handoffRefOf,
  userCodeOf,
  type AccountSetup,
} from "./harness.js";

/*
 * Between the person approving the sign-in at Vercel and choosing a team, the
 * tokens are in custody under a reference only the open choice knows. The
 * connection has no credential yet, so what ends the connection in that window
 * finds the sign-in through the connection's own adapter state, which every
 * actor can read, and not through the handoff, which only the person who
 * signed in can. Without that, the tokens stayed live at Vercel and in custody
 * with nothing left to release them.
 */

type View = { lifecycle: string; revision: number };

/** The custody records this ceremony stored that are still there. */
async function leftInCustody(setup: AccountSetup, connectionRef: string) {
  const record = await setup.record(connectionRef);
  const scope = {
    tenantId: record.tenantId,
    ownerKind: record.ownerKind,
    ownerId: record.ownerId,
    connectionRef: record.connectionRef,
    bindingRef: record.bindingRef,
    custody: record.custody,
  };
  const left: string[] = [];
  for (const ref of setup.stored)
    if (await setup.ports.credentials.describe(scope, ref)) left.push(ref);
  return left;
}

const pendingOf = async (setup: AccountSetup, connectionRef: string) =>
  (await setup.record(connectionRef)).state["pendingSession"];

test("the sign-in waiting for a team is recorded on the connection, and the choice clears it", async (t) => {
  const setup = await accountSetup(t);
  const { connectionRef, polled } = await connectAndApprove(setup);
  assert.equal(setup.stored.length, 1);
  assert.equal(await pendingOf(setup, connectionRef), setup.stored[0]);
  assert.equal((await setup.record(connectionRef)).credentialRef, undefined);

  await setup.service.provideInput(
    setup.person,
    connectionRef,
    handoffRefOf(polled),
    { team: "acme" },
  );
  const bound = await setup.record(connectionRef);
  assert.equal(bound.credentialRef, setup.stored[0]);
  assert.equal(bound.state["pendingSession"], null, "nothing waits any more");
});

for (const scope of ["local", "upstream"] as const)
  test(`${scope === "local" ? "a local" : "an upstream"} disconnect while the team choice is open revokes the sign-in held for it, and discards it`, async (t) => {
    const setup = await accountSetup(t);
    const { connectionRef, polled } = await connectAndApprove(setup);
    const { accessTokens, refreshTokens } = setup.fixture.issued;
    assert.equal((await leftInCustody(setup, connectionRef)).length, 1);

    const result = await setup.service.disconnect(setup.person, connectionRef, {
      expectedRevision: (polled as View).revision,
      scope,
    });

    assert.equal(result.result.local, "applied");
    if (scope === "local")
      assert.deepEqual(result.result.release, {
        revoked: true,
        reason: "oauth.revoke.applied",
      });
    else assert.equal(result.result.upstream, "applied");
    assert.deepEqual(
      setup.fixture.revocations.map((item) => item.token),
      [refreshTokens[0], accessTokens[0]],
      "both tokens went to Vercel, once",
    );
    assert.equal(setup.fixture.accessTokenValid(accessTokens[0]!), false);
    assert.equal(setup.fixture.refreshTokenUsable(refreshTokens[0]!), false);
    assert.deepEqual(await leftInCustody(setup, connectionRef), []);
  });

test("a disconnect by an agent, who cannot read the person's handoff, still revokes the sign-in held for the choice", async (t) => {
  const setup = await accountSetup(t);
  const { connectionRef, polled } = await connectAndApprove(setup);
  assert.equal(
    await setup.ports.handoffs.present(setup.agent, handoffRefOf(polled)),
    undefined,
    "the control: an agent cannot see the handoff the sign-in is named in",
  );

  const result = await setup.service.disconnect(setup.agent, connectionRef, {
    expectedRevision: (polled as View).revision,
    scope: "local",
  });

  assert.deepEqual(result.result.release, {
    revoked: true,
    reason: "oauth.revoke.applied",
  });
  assert.equal(setup.fixture.counts.revoke, 2);
  assert.deepEqual(await leftInCustody(setup, connectionRef), []);
});

test("revocation pinned off still drops the sign-in held for the choice from custody, and says nothing was sent", async (t) => {
  const setup = await accountSetup(t, { revoke: false });
  const { connectionRef, polled } = await connectAndApprove(setup);

  const result = await setup.service.disconnect(setup.person, connectionRef, {
    expectedRevision: (polled as View).revision,
    scope: "local",
  });

  assert.deepEqual(result.result.release, {
    revoked: "unavailable",
    reason: "oauth.revoke.disabled",
  });
  assert.equal(setup.fixture.counts.revoke, 0);
  assert.deepEqual(await leftInCustody(setup, connectionRef), []);
});

/** Starts a reconnect and gets the new sign-in approved and polled to its choice. */
async function reconnectToChoice(setup: AccountSetup, connectionRef: string) {
  const held = await setup.ports.connections.get(setup.person, connectionRef);
  const restarted = await setup.service.reconnect(setup.person, connectionRef, {
    expectedRevision: held?.revision,
  });
  if (!setup.fixture.approve(userCodeOf(restarted)))
    throw new Error("code not approvable");
  setup.advance(6_000);
  return setup.service.poll(setup.person, connectionRef);
}

test("a disconnect while a reconnect waits for its team revokes both the sign-in it replaces and the one waiting", async (t) => {
  const setup = await accountSetup(t);
  const { connectionRef } = await connectAndChoose(setup);
  const polled = await reconnectToChoice(setup, connectionRef);
  const record = await setup.record(connectionRef);
  assert.ok(record.credentialRef, "the connection still has its own sign-in");
  assert.equal(setup.stored.length, 2);
  assert.notEqual(record.state["pendingSession"], record.credentialRef);

  const result = await setup.service.disconnect(setup.person, connectionRef, {
    expectedRevision: (polled as View).revision,
    scope: "local",
  });

  assert.equal(result.result.local, "applied");
  assert.deepEqual(result.result.release, {
    revoked: true,
    reason: "oauth.revoke.applied",
  });
  assert.equal(setup.fixture.counts.revoke, 4, "two tokens for each sign-in");
  const { accessTokens, refreshTokens } = setup.fixture.issued;
  for (const token of accessTokens)
    assert.equal(setup.fixture.accessTokenValid(token), false);
  for (const token of refreshTokens)
    assert.equal(setup.fixture.refreshTokenUsable(token), false);
  assert.deepEqual(await leftInCustody(setup, connectionRef), []);
});

test("a new sign-in that reaches its choice discards the one an earlier choice was holding", async (t) => {
  const setup = await accountSetup(t);
  const { connectionRef } = await connectAndApprove(setup);
  const first = setup.stored[0]!;
  assert.equal(await pendingOf(setup, connectionRef), first);

  await reconnectToChoice(setup, connectionRef);

  const second = setup.stored[1]!;
  assert.notEqual(first, second);
  assert.equal(await pendingOf(setup, connectionRef), second);
  assert.deepEqual(
    await leftInCustody(setup, connectionRef),
    [second],
    "only the sign-in the open choice names is still held",
  );
});
