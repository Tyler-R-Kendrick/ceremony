import assert from "node:assert/strict";
import test from "node:test";
import { SELECTION_TTL_MS } from "../../../src/server/connectors/providers/aws-identity-center/contracts.js";
import { sweepDroppedCredentials } from "../../../src/server/connectors/state/index.js";
import { TENANT } from "../commands/harness.js";
import { scopeOf } from "../doubles/interleave.js";
import { awsSetup, connectAndApprove, handoffRefOf } from "./harness.js";

/*
 * A sign-in held for a role choice can be used only through that choice.
 * When the choice expires with nobody answering it, the custody sweep lets go
 * of the sign-in by the path every abandoned sign-in takes: the connection
 * stops naming it and notes the drop in one write, and the noted drop is
 * made. The clock here is the harness's own, handed to the sweep as it is to
 * the ports.
 */

const DIGEST = "c".repeat(64);
const ATTEMPT = "attempt-held-0001";

test("a role choice that expires unanswered has its sign-in dropped by the next sweep", async (t) => {
  const setup = await awsSetup(t);
  const { connectionRef } = await connectAndApprove(setup);
  const [waiting] = setup.stored;
  const sweep = () =>
    sweepDroppedCredentials(setup.store, TENANT, { now: setup.clock });
  const scope = scopeOf(await setup.record(connectionRef));

  // The control: while the choice can still be answered, nothing is dropped.
  setup.advance(SELECTION_TTL_MS - 60_000);
  assert.deepEqual(await sweep(), { swept: 0 });
  assert.ok(await setup.ports.credentials.describe(scope, waiting!));

  setup.advance(120_000);
  assert.deepEqual(await sweep(), { swept: 1 });
  assert.equal(
    await setup.ports.credentials.describe(scope, waiting!),
    undefined,
    "the sign-in held for the expired choice is gone from custody",
  );
  const record = await setup.record(connectionRef);
  assert.equal(record.state["pendingSession"], null);
  assert.deepEqual(record.state["droppedCredentials"], [waiting]);
  assert.equal(setup.fixture.counts.logout, 0, "the provider is not told");
  assert.deepEqual(await sweep(), { swept: 0 }, "a second sweep finds nothing");
});

test("a sign-in whose choice a submission still holds is not dropped, though the choice has expired", async (t) => {
  const setup = await awsSetup(t);
  const { connectionRef, polled } = await connectAndApprove(setup);
  const [waiting] = setup.stored;
  const scope = scopeOf(await setup.record(connectionRef));
  const handoffRef = handoffRefOf(polled);
  const { generation } = await setup.record(connectionRef);
  // A submission taken just before the choice expired, still being worked.
  setup.advance(SELECTION_TTL_MS - 1_000);
  assert.equal(
    await setup.ports.handoffs.claim(
      handoffRef,
      generation,
      DIGEST,
      ATTEMPT,
      10 * 60_000,
    ),
    "claimed",
  );
  setup.advance(60_000);
  assert.deepEqual(
    await sweepDroppedCredentials(setup.store, TENANT, { now: setup.clock }),
    { swept: 0 },
  );
  assert.ok(await setup.ports.credentials.describe(scope, waiting!));
  assert.equal(
    (await setup.record(connectionRef)).state["pendingSession"],
    waiting,
  );
});
