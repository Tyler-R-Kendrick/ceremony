import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { hold, settle } from "../doubles/interleave.js";
import { awsSetup, connectAndChoose, type AwsSetup } from "./harness.js";

/*
 * A disconnect fences the connection, talks to the provider for as long as that
 * takes, and then closes the record. If something else took the connection over
 * in between (a reconnect, or another disconnect that closed it first or is
 * closing it), this
 * disconnect has still released what it held, but it did not close the record,
 * and `local: "applied"` on a view that is not closed reads as "the connection
 * is disconnected". The outcome says which it was.
 */

type View = { lifecycle: string; revision: number };

/** Starts a local disconnect that stops at the portal's Logout, and returns what a second client sees then. */
async function disconnectHeldAtLogout(t: TestContext, setup: AwsSetup) {
  const { connectionRef, done } = await connectAndChoose(setup);
  const real = globalThis.fetch;
  const reached = Promise.withResolvers<void>();
  const gate = Promise.withResolvers<void>();
  let held = false;
  t.mock.method(
    globalThis,
    "fetch",
    async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      const url =
        typeof input === "string"
          ? input
          : input instanceof URL
            ? input.href
            : input.url;
      if (new URL(url).pathname === "/logout" && !held) {
        held = true;
        reached.resolve();
        await gate.promise;
      }
      return real(input, init);
    },
  );
  const first = setup.service
    .disconnect(setup.person, connectionRef, {
      expectedRevision: (done as View).revision,
      scope: "local",
    })
    .then(
      (value) => ({ value }),
      (error: unknown) => ({ error }),
    );
  await reached.promise;
  const seen = (await setup.service.status(
    setup.person,
    connectionRef,
  )) as View;
  return { connectionRef, seen, first, release: () => gate.resolve() };
}

test("a disconnect that loses the connection to a reconnect says it was superseded, and does not claim the record is disconnected", async (t) => {
  const setup = await awsSetup(t);
  const window = await disconnectHeldAtLogout(t, setup);

  const reconnected = await setup.service.reconnect(
    setup.person,
    window.connectionRef,
    { expectedRevision: window.seen.revision },
  );
  assert.equal((reconnected as View).lifecycle, "authorization-required");
  window.release();
  const outcome = await window.first;

  assert.ok(
    "value" in outcome,
    String("error" in outcome ? outcome.error : ""),
  );
  assert.equal(outcome.value.result.local, "superseded");
  assert.equal(
    (outcome.value.connection as View).lifecycle,
    "authorization-required",
    "the view is the reconnect's, as it is",
  );
  assert.equal(
    outcome.value.result.release?.revoked,
    true,
    "what this disconnect held was still released",
  );
});

test("a disconnect that loses the record to another disconnect that closed it says it was already closed", async (t) => {
  const setup = await awsSetup(t);
  const { connectionRef, done } = await connectAndChoose(setup);
  // The first disconnect has told the provider and dropped the tokens, and
  // stops just before it closes the record.
  const evidence = (
    setup.service as unknown as {
      ports: {
        evidence: { invalidate: (...args: unknown[]) => Promise<void> };
      };
    }
  ).ports.evidence;
  const realInvalidate = evidence.invalidate.bind(evidence);
  const reached = Promise.withResolvers<void>();
  const gate = Promise.withResolvers<void>();
  let held = false;
  evidence.invalidate = async (...args: unknown[]) => {
    if (!held) {
      held = true;
      reached.resolve();
      await gate.promise;
    }
    return realInvalidate(...args);
  };
  const first = setup.service
    .disconnect(setup.person, connectionRef, {
      expectedRevision: (done as View).revision,
      scope: "local",
    })
    .then(
      (value) => ({ value }),
      (error: unknown) => ({ error }),
    );
  await reached.promise;
  const seen = (await setup.service.status(
    setup.person,
    connectionRef,
  )) as View;

  const second = await setup.service.disconnect(setup.person, connectionRef, {
    expectedRevision: seen.revision,
    scope: "local",
  });
  assert.equal(second.result.local, "applied");
  assert.equal((second.connection as View).lifecycle, "locally-disconnected");
  gate.resolve();
  const outcome = await first;

  assert.ok(
    "value" in outcome,
    String("error" in outcome ? outcome.error : ""),
  );
  assert.equal(outcome.value.result.local, "already-closed");
  assert.equal(
    (outcome.value.connection as View).lifecycle,
    "locally-disconnected",
  );
});

test("a disconnect overtaken by another disconnect that has fenced but not closed yet says the record is being closed, not that it was superseded", async (t) => {
  const setup = await awsSetup(t);
  const { connectionRef, done } = await connectAndChoose(setup);
  const ports = (
    setup.service as unknown as {
      ports: { connections: object; evidence: object };
    }
  ).ports;
  // The first stops at its closing write; the second fences and stops before
  // it closes; then the first goes on.
  const closing = hold(ports.connections, "update");
  const first = settle(
    setup.service.disconnect(setup.person, connectionRef, {
      expectedRevision: (done as View).revision,
      scope: "local",
    }),
  );
  await closing.reached;
  const seen = (await setup.service.status(
    setup.person,
    connectionRef,
  )) as View;
  const second = hold(ports.evidence, "invalidate");
  const secondDone = settle(
    setup.service.disconnect(setup.person, connectionRef, {
      expectedRevision: seen.revision,
      scope: "local",
    }),
  );
  await second.reached;
  closing.release();
  const outcome = await first;
  second.release();
  await secondDone;

  assert.equal(outcome.error, undefined, String(outcome.error));
  assert.equal(outcome.value!.result.local, "already-closing");
  assert.equal(
    (await setup.record(connectionRef)).lifecycle,
    "locally-disconnected",
    "the second disconnect closed it",
  );
});
