import assert from "node:assert/strict";
import test from "node:test";
import {
  awsSetup,
  connectAndApprove,
  connectAndChoose,
  handoffRefOf,
  userCodeOf,
  type AwsSetup,
} from "./harness.js";

/*
 * Between the person approving the sign-in and choosing a role, the tokens are
 * in custody under a reference only the open choice knows. The connection
 * itself has no credential yet, so what ends the connection in that window has
 * to find the sign-in some other way: through the connection's own adapter
 * state, which every actor can read, and not through the handoff, which only
 * the person who signed in can.
 */

type View = { lifecycle: string; revision: number };
const CODE = "aws-identity-center.release";

/** The custody records this ceremony stored that are still there. */
async function leftInCustody(setup: AwsSetup, connectionRef: string) {
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

const pendingOf = async (setup: AwsSetup, connectionRef: string) =>
  (await setup.record(connectionRef)).state["pendingSession"];

test("the sign-in waiting for a choice is recorded on the connection, and the choice clears it", async (t) => {
  const setup = await awsSetup(t);
  const { connectionRef, polled } = await connectAndApprove(setup);
  assert.equal(setup.stored.length, 1);
  assert.equal(await pendingOf(setup, connectionRef), setup.stored[0]);

  await setup.service.provideInput(
    setup.person,
    connectionRef,
    handoffRefOf(polled),
    { accountId: "111122223333", roleName: "ReadOnlyAccess" },
  );
  const bound = await setup.record(connectionRef);
  assert.equal(bound.credentialRef, setup.stored[0]);
  assert.equal(bound.state["pendingSession"], null, "nothing waits any more");
});

test("a disconnect by an agent, who cannot read the person's handoff, still ends the sign-in held for the choice", async (t) => {
  const setup = await awsSetup(t);
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

  assert.equal(result.result.local, "applied");
  assert.deepEqual(result.result.release, {
    revoked: true,
    reason: `${CODE}.session-ended`,
  });
  assert.equal(setup.fixture.counts.logout, 1);
  assert.deepEqual(await leftInCustody(setup, connectionRef), []);
});

test("a disconnect after the person cancelled the choice still ends the sign-in that was held for it", async (t) => {
  const setup = await awsSetup(t);
  const { connectionRef } = await connectAndApprove(setup);
  const cancelled = await setup.service.cancelPending(
    setup.person,
    connectionRef,
  );
  assert.equal(
    (await leftInCustody(setup, connectionRef)).length,
    1,
    "cancelling the choice does not by itself end the sign-in",
  );

  const result = await setup.service.disconnect(setup.person, connectionRef, {
    expectedRevision: (cancelled as View).revision,
    scope: "local",
  });

  assert.equal(result.result.release?.revoked, true);
  assert.equal(setup.fixture.counts.logout, 1);
  assert.deepEqual(await leftInCustody(setup, connectionRef), []);
});

/** Starts a reconnect and gets the new sign-in approved and polled to its choice. */
async function reconnectToChoice(setup: AwsSetup, connectionRef: string) {
  const held = await setup.ports.connections.get(setup.person, connectionRef);
  const restarted = await setup.service.reconnect(setup.person, connectionRef, {
    expectedRevision: held?.revision,
  });
  if (!setup.fixture.approve(userCodeOf(restarted)))
    throw new Error("code not approvable");
  setup.advance(6_000);
  return setup.service.poll(setup.person, connectionRef);
}

test("a disconnect while a reconnect waits for its choice ends both the sign-in it replaces and the one waiting", async (t) => {
  const setup = await awsSetup(t);
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
    reason: `${CODE}.session-ended`,
  });
  assert.equal(setup.fixture.counts.logout, 2, "each sign-in was ended");
  assert.deepEqual(await leftInCustody(setup, connectionRef), []);
});

test("a new sign-in that reaches its choice discards the one an earlier choice was holding", async (t) => {
  const setup = await awsSetup(t);
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
