import assert from "node:assert/strict";
import test from "node:test";
import { ConnectorError } from "../../../src/server/connectors/errors.js";
import {
  awsSetup,
  connectAndApprove,
  handoffRefOf,
  type AwsSetup,
} from "./harness.js";

/*
 * Two submissions of the role choice at once. Custody's single-flight rotation
 * answers the second caller from the first caller's run, so a second
 * submission with a DIFFERENT value would be told "complete" for a role whose
 * credentials were never issued if nothing refused it. A handoff is claimed by
 * exactly one submission before any adapter runs: a different value is refused
 * as `handoff.already-claimed` without touching the connection (no revision
 * bump, no `lastOutcome`), and the same value is answered from the first run.
 */

type View = { lifecycle: string; target?: { id?: string } };
type Answer = { ok: View } | { error: unknown };
const READ_ONLY = { accountId: "111122223333", roleName: "ReadOnlyAccess" };
const ADMIN = { accountId: "111122223333", roleName: "AdministratorAccess" };

const answer = (work: Promise<unknown>): Promise<Answer> =>
  work.then(
    (value) => ({ ok: value as View }),
    (error: unknown) => ({ error }),
  );

const submit = (
  setup: AwsSetup,
  connectionRef: string,
  handoffRef: string,
  choice: { accountId: string; roleName: string },
) =>
  answer(
    setup.service.provideInput(setup.person, connectionRef, handoffRef, choice),
  );

/** Holds back the first call to `handoffs.complete`, so the other submission can run meanwhile. */
function holdFirstSettlement(setup: AwsSetup) {
  const real = setup.ports.handoffs.complete.bind(setup.ports.handoffs);
  let settling = 0;
  const gate = Promise.withResolvers<void>();
  setup.ports.handoffs.complete = async (...args) => {
    settling += 1;
    if (settling === 1) await gate.promise;
    return real(...args);
  };
  return {
    release: () => gate.resolve(),
    restore: () => (setup.ports.handoffs.complete = real),
  };
}

const revisionOf = async (setup: AwsSetup, connectionRef: string) =>
  (await setup.ports.connections.get(setup.person, connectionRef))!.revision;

const completions = (setup: AwsSetup) =>
  setup.journal.filter(
    (entry) =>
      "operation" in entry && entry.operation === "connector.handoff.complete",
  ).length;

test("a second submission with another value is refused, and the winner completes", async (t) => {
  const setup = await awsSetup(t);
  const first = await connectAndApprove(setup);
  const handoffRef = handoffRefOf(first.polled);
  const before = await revisionOf(setup, first.connectionRef);
  const hold = holdFirstSettlement(setup);
  t.after(hold.restore);

  const readOnly = submit(setup, first.connectionRef, handoffRef, READ_ONLY);
  const admin = submit(setup, first.connectionRef, handoffRef, ADMIN);
  // The refusal does not wait for the winner, which is held at its settlement.
  const second = await admin;
  hold.release();
  const winner = await readOnly;

  const answered = [winner, second].flatMap((r) => ("ok" in r ? [r.ok] : []));
  assert.equal(answered.length, 1, "exactly one submission has an answer");

  // What the connection says it is bound to is what the credentials are for.
  const issued = setup.fixture.issued.roleCredentials;
  assert.equal(issued.length, 1, "one set of role credentials exists");
  const session = setup.fixture.roleSession(issued[0]!.accessKeyId)!;
  const target = `${session.accountId}:${session.roleName}`;
  assert.equal(answered[0]!.target?.id, target);
  const record = await setup.record(first.connectionRef);
  assert.equal(record.target?.id, target);

  // The one that claimed first is the one that completes; the other is refused.
  assert.ok("ok" in winner, "the submission that claimed first completes");
  assert.ok("error" in second, "the other is refused");
  assert.ok(second.error instanceof ConnectorError);
  assert.equal(second.error.code, "conflict");
  assert.equal(second.error.detail, "handoff.already-claimed");
  assert.equal(winner.ok.lifecycle, "active");
  assert.equal(session.roleName, "ReadOnlyAccess");

  // The refusal wrote nothing: one revision for the winner, its own outcome, one journal entry.
  assert.equal(
    await revisionOf(setup, first.connectionRef),
    before + 1,
    "the connection revision moved once",
  );
  assert.equal(record.lastOutcome, "authorization.complete");
  assert.equal(completions(setup), 1);
});

test("the refusal is the same whichever value arrives second", async (t) => {
  const setup = await awsSetup(t);
  const first = await connectAndApprove(setup);
  const handoffRef = handoffRefOf(first.polled);
  const hold = holdFirstSettlement(setup);
  t.after(hold.restore);

  const admin = submit(setup, first.connectionRef, handoffRef, ADMIN);
  const readOnly = submit(setup, first.connectionRef, handoffRef, READ_ONLY);
  const refused = await readOnly;
  hold.release();
  const winner = await admin;

  assert.ok("ok" in winner && "error" in refused);
  assert.equal(
    (refused.error as ConnectorError).detail,
    "handoff.already-claimed",
  );
  const session = setup.fixture.roleSession(
    setup.fixture.issued.roleCredentials[0]!.accessKeyId,
  )!;
  assert.equal(session.roleName, "AdministratorAccess");
  assert.equal(
    winner.ok.target?.id,
    `${session.accountId}:${session.roleName}`,
  );
});

test("a second submission with the same value is answered from the first run", async (t) => {
  const setup = await awsSetup(t);
  const first = await connectAndApprove(setup);
  const handoffRef = handoffRefOf(first.polled);
  const before = await revisionOf(setup, first.connectionRef);

  const [one, two] = await Promise.all([
    submit(setup, first.connectionRef, handoffRef, READ_ONLY),
    submit(setup, first.connectionRef, handoffRef, READ_ONLY),
  ]);

  assert.ok("ok" in one && "ok" in two, "both submissions have an answer");
  assert.equal(one.ok.lifecycle, "active");
  assert.deepEqual(two.ok, one.ok, "the same answer, not a second run");
  assert.equal(setup.fixture.issued.roleCredentials.length, 1);
  assert.equal(await revisionOf(setup, first.connectionRef), before + 1);
  assert.equal(completions(setup), 1);
});

test("a joined submission takes over when the run it joined fails", async (t) => {
  const setup = await awsSetup(t);
  const first = await connectAndApprove(setup);
  const handoffRef = handoffRefOf(first.polled);
  // The portal fails the first run; it recovers by the time the claim is given back.
  setup.fixture.failPortal(503);
  const realRelease = setup.ports.handoffs.release.bind(setup.ports.handoffs);
  setup.ports.handoffs.release = async (...args) => {
    setup.fixture.failPortal(null);
    return realRelease(...args);
  };
  t.after(() => {
    setup.ports.handoffs.release = realRelease;
  });

  const [one, two] = await Promise.all([
    submit(setup, first.connectionRef, handoffRef, READ_ONLY),
    submit(setup, first.connectionRef, handoffRef, READ_ONLY),
  ]);

  const answers = [one, two];
  assert.equal(answers.filter((r) => "error" in r).length, 1);
  const failed = answers.find((r) => "error" in r) as { error: unknown };
  assert.ok(failed.error instanceof ConnectorError);
  assert.equal(failed.error.code, "upstream-unavailable");
  const ok = answers.find((r) => "ok" in r) as { ok: View };
  assert.equal(ok.ok.lifecycle, "active");
  assert.equal(setup.fixture.issued.roleCredentials.length, 1);
});

test("a rejected submission gives the claim back, so another value can be submitted", async (t) => {
  const setup = await awsSetup(t);
  const first = await connectAndApprove(setup);
  const handoffRef = handoffRefOf(first.polled);

  const rejected = await submit(setup, first.connectionRef, handoffRef, {
    accountId: "111122223333",
    roleName: "NotARole",
  });
  assert.ok("error" in rejected);
  assert.equal((rejected.error as ConnectorError).code, "invalid-request");

  const retried = await submit(setup, first.connectionRef, handoffRef, ADMIN);
  assert.ok("ok" in retried, "the claim did not outlive the rejected attempt");
  assert.equal(retried.ok.lifecycle, "active");
});

test("a submission after the handoff settled is refused as consumed, as before", async (t) => {
  const setup = await awsSetup(t);
  const first = await connectAndApprove(setup);
  const handoffRef = handoffRefOf(first.polled);
  const done = await submit(setup, first.connectionRef, handoffRef, READ_ONLY);
  assert.ok("ok" in done);

  for (const choice of [READ_ONLY, ADMIN]) {
    const late = await submit(setup, first.connectionRef, handoffRef, choice);
    assert.ok("error" in late);
    assert.equal((late.error as ConnectorError).detail, "handoff.consumed");
  }
});
