import assert from "node:assert/strict";
import test from "node:test";
import type { CeremonyBackend } from "../doubles/ceremony-backend.js";
import { custodyAudit, hold, settle } from "../doubles/interleave.js";
import {
  awsSetup,
  connectAndChoose,
  handoffRefOf,
  userCodeOf,
} from "./harness.js";

/*
 * A reconnect's submission and a cancel of its role choice, at the same
 * moment. The submission has bound the new sign-in and is about to replace the
 * connection's credential with it; the cancel runs to its end in between and
 * drops the waiting sign-in. The submission then loses on revision. Its old
 * credential must still be there: the record still names it, and cancelling a
 * reconnect leaves the connection's own sign-in alone.
 */

type View = { lifecycle: string; revision: number };

for (const backend of ["sqlite", "memory", "postgres"] as CeremonyBackend[])
  test(`a cancel that wins against a reconnect's submission leaves the old credential (${backend})`, async (t) => {
    const setup = await awsSetup(t, { backend });
    const { connectionRef, done } = await connectAndChoose(setup);
    const before = await setup.record(connectionRef);
    const old = before.credentialRef!;
    const restarted = await setup.service.reconnect(
      setup.person,
      connectionRef,
      { expectedRevision: (done as View).revision },
    );
    if (!setup.fixture.approve(userCodeOf(restarted)))
      throw new Error("code not approvable");
    setup.advance(6_000);
    const polled = await setup.service.poll(setup.person, connectionRef);

    // The submission has run its adapter and is writing evidence: the next
    // thing it does is replace the old credential.
    const held = hold(setup.ports.evidence, "append");
    const submitting = settle(
      setup.service.provideInput(
        setup.person,
        connectionRef,
        handoffRefOf(polled),
        { accountId: "111122223333", roleName: "ReadOnlyAccess" },
      ),
    );
    await held.reached;
    const cancelled = await settle(
      setup.service.cancelPending(setup.person, connectionRef),
    );
    held.release();
    const submitted = await submitting;

    assert.equal(cancelled.error, undefined, "the cancel ran to its end");
    assert.ok(submitted.error, "the submission lost on revision");
    const record = await setup.record(connectionRef);
    assert.equal(
      record.credentialRef,
      old,
      "the record still names the old credential",
    );
    const audit = await custodyAudit(
      setup.ports.credentials,
      setup.stored,
      record,
    );
    assert.deepEqual(audit.dangling, [], "and custody still holds it");
    assert.deepEqual(audit.leaked, [], "nothing is left that nothing names");
  });
