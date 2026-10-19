import assert from "node:assert/strict";
import test from "node:test";
import type { CeremonyBackend } from "../doubles/ceremony-backend.js";
import { custodyAudit, hold, settle } from "../doubles/interleave.js";
import {
  accountSetup,
  connectAndChoose,
  handoffRefOf,
  userCodeOf,
} from "./harness.js";

/*
 * The Vercel form of the reconnect race in aws-identity-center: the team
 * choice's sign-in becomes the credential when the team is chosen, and a
 * cancel that runs to its end in the middle of that submission must leave the
 * connection's old credential as it was.
 */

type View = { lifecycle: string; revision: number };

for (const backend of ["sqlite", "memory", "postgres"] as CeremonyBackend[])
  test(`a cancel that wins against a reconnect's team submission leaves the old credential (${backend})`, async (t) => {
    const setup = await accountSetup(t, { backend });
    const { connectionRef, done } = await connectAndChoose(setup);
    const old = (await setup.record(connectionRef)).credentialRef!;
    const restarted = await setup.service.reconnect(
      setup.person,
      connectionRef,
      { expectedRevision: (done as View).revision },
    );
    if (!setup.fixture.approve(userCodeOf(restarted)))
      throw new Error("code not approvable");
    setup.advance(6_000);
    const polled = await setup.service.poll(setup.person, connectionRef);

    const held = hold(setup.ports.evidence, "append");
    const submitting = settle(
      setup.service.provideInput(
        setup.person,
        connectionRef,
        handoffRefOf(polled),
        { team: "acme" },
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
