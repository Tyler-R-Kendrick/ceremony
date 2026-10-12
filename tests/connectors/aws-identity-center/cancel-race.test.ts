import assert from "node:assert/strict";
import test from "node:test";
import { ConnectorError } from "../../../src/server/connectors/errors.js";
import { awsSetup, connectAndApprove, handoffRefOf } from "./harness.js";

/*
 * Cancelling a choice and making it can run at the same moment, in two tabs.
 * The sign-in that waits for the choice is the very custody record that
 * becomes the connection's credential when the choice is made, so a cancel
 * that drops "the waiting sign-in" from custody before its own write has
 * landed can destroy a credential another request has just bound. The write
 * comes first; the drop follows it, and only of what the record no longer
 * carries.
 */

type View = { lifecycle: string; revision: number };

test("a cancel that loses the race to a submission leaves the credential the submission bound", async (t) => {
  const setup = await awsSetup(t);
  const { connectionRef, polled } = await connectAndApprove(setup);
  const ports = (
    setup.service as unknown as {
      ports: {
        handoffs: { cancelAll: (...args: unknown[]) => Promise<unknown> };
      };
    }
  ).ports;
  const realCancelAll = ports.handoffs.cancelAll.bind(ports.handoffs);
  const reached = Promise.withResolvers<void>();
  const gate = Promise.withResolvers<void>();
  // The cancel has read the connection and is about to cancel the handoff.
  ports.handoffs.cancelAll = async (...args: unknown[]) => {
    reached.resolve();
    await gate.promise;
    return realCancelAll(...args);
  };
  const cancelling = setup.service
    .cancelPending(setup.person, connectionRef)
    .then(
      (value) => ({ value }),
      (error: unknown) => ({ error }),
    );
  await reached.promise;
  const done = await setup.service.provideInput(
    setup.person,
    connectionRef,
    handoffRefOf(polled),
    { accountId: "111122223333", roleName: "ReadOnlyAccess" },
  );
  assert.equal((done as View).lifecycle, "active");
  gate.resolve();
  const outcome = await cancelling;

  assert.ok(
    "error" in outcome &&
      outcome.error instanceof ConnectorError &&
      outcome.error.code === "conflict",
    "the cancel lost on revision and says so",
  );
  const record = await setup.record(connectionRef);
  assert.equal(record.lifecycle, "active");
  assert.ok(record.credentialRef);
  const scope = {
    tenantId: record.tenantId,
    ownerKind: record.ownerKind,
    ownerId: record.ownerId,
    connectionRef: record.connectionRef,
    bindingRef: record.bindingRef,
    custody: record.custody,
  };
  assert.ok(
    await setup.ports.credentials.describe(scope, record.credentialRef),
    "the credential the person just bound is still in custody",
  );
  const verified = await setup.service.verify(setup.person, connectionRef);
  assert.equal((verified as View).lifecycle, "active");
});
