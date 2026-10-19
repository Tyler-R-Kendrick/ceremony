import assert from "node:assert/strict";
import test from "node:test";
import { ConnectorError } from "../../../src/server/connectors/errors.js";
import { hold, settle } from "../doubles/interleave.js";
import { awsSetup, connectAndApprove, handoffRefOf } from "./harness.js";

/*
 * A cancel that loses on revision has changed nothing. Its write comes first;
 * the handoff is cancelled and the waiting sign-in dropped only after that
 * write landed. Otherwise an unrelated write in the window (here a revocation
 * request) leaves the handoff cancelled while the record still shows the
 * choice open, and the person's next submission is refused until a second
 * cancel.
 */

type View = { lifecycle: string; revision: number };

test("a cancel that loses on revision leaves the choice open and usable", async (t) => {
  const setup = await awsSetup(t);
  const { connectionRef, polled } = await connectAndApprove(setup);
  const service = setup.service as unknown as {
    ports: { connections: object };
  };
  // The cancel has read the connection and is about to write it.
  const held = hold(service.ports.connections, "update");
  const cancelling = settle(
    setup.service.cancelPending(setup.person, connectionRef),
  );
  await held.reached;
  await setup.service.requestRevocation(setup.person, connectionRef);
  held.release();
  const cancelled = await cancelling;

  assert.ok(
    cancelled.error instanceof ConnectorError &&
      cancelled.error.code === "conflict",
    "the cancel lost on revision and says so",
  );
  const record = await setup.record(connectionRef);
  const handoff = await setup.ports.handoffs.present(
    setup.person,
    handoffRefOf(polled),
  );
  assert.equal(
    record.handoff?.state,
    "issued",
    "the record shows the choice open",
  );
  assert.equal(handoff?.state, "issued", "and so does the handoff store");
  const done = await setup.service.provideInput(
    setup.person,
    connectionRef,
    handoffRefOf(polled),
    { accountId: "111122223333", roleName: "ReadOnlyAccess" },
  );
  assert.equal((done as View).lifecycle, "active");
});
