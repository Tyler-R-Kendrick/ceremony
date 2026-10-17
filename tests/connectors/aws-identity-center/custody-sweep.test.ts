import assert from "node:assert/strict";
import test from "node:test";
import { sweepDroppedCredentials } from "../../../src/server/connectors/state/index.js";
import { TENANT } from "../commands/harness.js";
import { custodyAudit, scopeOf, settle } from "../doubles/interleave.js";
import {
  awsSetup,
  connectAndApprove,
  connectAndChoose,
  handoffRefOf,
  userCodeOf,
} from "./harness.js";

/*
 * Write first, drop second leaves a custody record behind when the drop
 * fails (or the process stops between the two). The write notes what it is
 * about to drop, and the sweep drops what was noted and is no longer named;
 * nothing it was not told to drop.
 */

type View = { revision: number };

test("a cancelled choice whose drop failed is swept, and nothing else is", async (t) => {
  const setup = await awsSetup(t);
  const { connectionRef } = await connectAndApprove(setup);
  const record = await setup.record(connectionRef);
  // A custody record no connection names on purpose (a trigger's signing key).
  const kept = await setup.credentials.store(scopeOf(record), {
    signingKey: "dummy-signing-key-0123456789abcdef",
  });
  const revoke = setup.credentials.revoke;
  setup.credentials.revoke = async () => {
    throw new Error("process stopped");
  };
  const cancelled = await settle(
    setup.service.cancelPending(setup.person, connectionRef),
  );
  setup.credentials.revoke = revoke;
  assert.equal(cancelled.error, undefined, "the cancel itself succeeded");
  const left = await custodyAudit(
    setup.ports.credentials,
    setup.stored,
    await setup.record(connectionRef),
  );
  assert.equal(left.leaked.length, 2, "the waiting sign-in and the kept key");

  assert.deepEqual(await sweepDroppedCredentials(setup.store, TENANT), {
    swept: 1,
  });
  const after = await custodyAudit(
    setup.ports.credentials,
    setup.stored,
    await setup.record(connectionRef),
  );
  assert.deepEqual(after.leaked, [kept], "only the noted drop was swept");
  assert.deepEqual(await sweepDroppedCredentials(setup.store, TENANT), {
    swept: 0,
  });
});

test("a replaced credential whose drop failed is swept; the new one is not", async (t) => {
  const setup = await awsSetup(t);
  const { connectionRef, done } = await connectAndChoose(setup);
  const old = (await setup.record(connectionRef)).credentialRef!;
  const restarted = await setup.service.reconnect(setup.person, connectionRef, {
    expectedRevision: (done as View).revision,
  });
  if (!setup.fixture.approve(userCodeOf(restarted)))
    throw new Error("code not approvable");
  setup.advance(6_000);
  const polled = await setup.service.poll(setup.person, connectionRef);
  const revoke = setup.credentials.revoke;
  setup.credentials.revoke = async () => {
    throw new Error("process stopped");
  };
  await setup.service.provideInput(
    setup.person,
    connectionRef,
    handoffRefOf(polled),
    { accountId: "111122223333", roleName: "ReadOnlyAccess" },
  );
  setup.credentials.revoke = revoke;
  const record = await setup.record(connectionRef);
  assert.notEqual(record.credentialRef, old);
  assert.ok(await setup.ports.credentials.describe(scopeOf(record), old));

  assert.deepEqual(await sweepDroppedCredentials(setup.store, TENANT), {
    swept: 1,
  });
  const after = await custodyAudit(
    setup.ports.credentials,
    setup.stored,
    record,
  );
  assert.deepEqual(after.leaked, []);
  assert.deepEqual(after.dangling, [], "the connection's own credential stays");
});
