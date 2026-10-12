import assert from "node:assert/strict";
import test from "node:test";
import { ConnectorError } from "../../../src/server/connectors/errors.js";
import { awsSetup, connectAndApprove, handoffRefOf } from "./harness.js";

/*
 * A submission that joined an identical one is answered from the run it
 * joined. If that run failed and gave the claim back, a different submission
 * can claim and settle the handoff between two of the waiter's looks, and the
 * waiter must not be answered with that run: it asked for something else.
 */

type View = { lifecycle: string; revision: number };
type HandoffsPort = {
  claim: (...args: unknown[]) => Promise<unknown>;
  release: (ref: string, attempt: string) => Promise<void>;
};

test("a waiter whose winner failed is not answered with a different value's run", async (t) => {
  const setup = await awsSetup(t);
  const { connectionRef, polled } = await connectAndApprove(setup);
  const handoffRef = handoffRefOf(polled);
  const readOnly = { accountId: "111122223333", roleName: "ReadOnlyAccess" };
  const admin = { accountId: "111122223333", roleName: "AdministratorAccess" };
  const handoffs = (
    setup.service as unknown as { ports: { handoffs: HandoffsPort } }
  ).ports.handoffs;
  const realClaim = handoffs.claim.bind(handoffs);
  const realRelease = handoffs.release.bind(handoffs);
  const attempts: string[] = [];
  const waiterGate = Promise.withResolvers<void>();
  const firstReleased = Promise.withResolvers<void>();
  let holdWaiter = false;
  handoffs.claim = async (...args: unknown[]) => {
    const attempt = args[3] as string;
    if (!attempts.includes(attempt)) attempts.push(attempt);
    // The second submission is the waiter: once the first has given the claim
    // back, its next look is held.
    if (holdWaiter && attempt === attempts[1]) await waiterGate.promise;
    return realClaim(...args);
  };
  handoffs.release = async (ref: string, attempt: string) => {
    await realRelease(ref, attempt);
    if (attempt === attempts[0]) {
      holdWaiter = true;
      firstReleased.resolve();
    }
  };
  // The first submission's GetRoleCredentials fails like a dropped connection, after a gate.
  const real = globalThis.fetch;
  const firstReached = Promise.withResolvers<void>();
  const firstGate = Promise.withResolvers<void>();
  let first = true;
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
      if (
        new URL(url).pathname.startsWith("/federation/credentials") &&
        first
      ) {
        first = false;
        firstReached.resolve();
        await firstGate.promise;
        throw new TypeError("fetch failed");
      }
      return real(input, init);
    },
  );
  const settle = <T>(work: Promise<T>) =>
    work.then(
      (value) => ({ value }),
      (error: unknown) => ({ error }),
    );
  const A = settle(
    setup.service.provideInput(
      setup.person,
      connectionRef,
      handoffRef,
      readOnly,
    ),
  );
  await firstReached.promise;
  const B = settle(
    setup.service.provideInput(
      setup.person,
      connectionRef,
      handoffRef,
      readOnly,
    ),
  );
  await new Promise((resolve) => setTimeout(resolve, 200)); // B has joined A's run
  firstGate.resolve();
  await firstReleased.promise;
  const C = await setup.service.provideInput(
    setup.person,
    connectionRef,
    handoffRef,
    admin,
  );
  assert.equal((C as View).lifecycle, "active");
  waiterGate.resolve();
  const [, b] = await Promise.all([A, B]);

  assert.ok(
    "error" in b &&
      b.error instanceof ConnectorError &&
      b.error.code === "conflict",
    "the waiter asked for ReadOnlyAccess and is told the handoff was taken, not that it succeeded",
  );
  const record = await setup.record(connectionRef);
  assert.equal(
    (record.state["aws"] as { roleName?: string }).roleName,
    "AdministratorAccess",
    "the connection is what the run that settled it built",
  );
});
