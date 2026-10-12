import assert from "node:assert/strict";
import test from "node:test";
import { awsSetup, connectAndChoose } from "./harness.js";

/*
 * A disconnect fences the connection, tells AWS (up to ten seconds), drops the
 * tokens and only then closes the record. Something that writes the connection
 * in that window moves its revision. The close used to fail on it, after the
 * provider had been told and custody emptied, leaving the record `active` with
 * a credential that no longer exists and the caller holding an error.
 */

type View = { lifecycle: string; revision: number };

test("a write that lands while Logout is in flight does not stop the disconnect closing the record", async (t) => {
  const setup = await awsSetup(t);
  const { connectionRef, done } = await connectAndChoose(setup);

  const real = globalThis.fetch;
  const reached = Promise.withResolvers<void>();
  const gate = Promise.withResolvers<void>();
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
      if (new URL(url).pathname === "/logout") {
        reached.resolve();
        await gate.promise;
      }
      return real(input, init);
    },
  );

  const disconnecting = setup.service
    .disconnect(setup.person, connectionRef, {
      expectedRevision: (done as View).revision,
      scope: "local",
    })
    .then(
      (value) => ({ value }),
      (error: unknown) => ({ error }),
    );
  await reached.promise;
  // Someone else writes the connection while the provider is being told.
  const meanwhile = await setup.service.verify(setup.person, connectionRef);
  assert.equal((meanwhile as View).lifecycle, "active");
  gate.resolve();

  const outcome = await disconnecting;
  assert.ok(
    "value" in outcome,
    `the disconnect threw: ${String("error" in outcome ? outcome.error : "")}`,
  );
  assert.equal(outcome.value.result.local, "applied");
  assert.equal(outcome.value.result.release?.revoked, true);
  assert.equal(
    (outcome.value.connection as View).lifecycle,
    "locally-disconnected",
  );

  // What is stored agrees: closed, one fence, and no credential left behind.
  const record = await setup.record(connectionRef);
  assert.equal(record.lifecycle, "locally-disconnected");
  assert.equal(record.generation, 1);
  assert.equal(record.lastOutcome, "disconnect.local");
  const scope = {
    tenantId: record.tenantId,
    ownerKind: record.ownerKind,
    ownerId: record.ownerId,
    connectionRef: record.connectionRef,
    bindingRef: record.bindingRef,
    custody: record.custody,
  };
  for (const ref of setup.stored)
    assert.equal(await setup.ports.credentials.describe(scope, ref), undefined);
  assert.equal(setup.fixture.counts.logout, 1);
});
