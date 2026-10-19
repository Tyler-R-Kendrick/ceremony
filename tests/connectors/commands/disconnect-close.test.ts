import assert from "node:assert/strict";
import test from "node:test";
import {
  CLOSE_ATTEMPTS,
  closeDisconnected,
  type ClosingConnection,
} from "../../../src/server/connectors/commands/disconnect-close.js";
import { ConnectorError } from "../../../src/server/connectors/errors.js";
import type {
  ConnectionRecord,
  ConnectionStorePort,
} from "../../../src/server/connectors/ports.js";
import { fixtureActor } from "../doubles/ports.js";

/*
 * Closing the record at the end of a disconnect, against a store that other
 * writers can move under it: a stale revision is read again and the closing
 * patch applied to what is there, a few times at most; a connection that is no
 * longer the generation this disconnect fenced is left alone; a credential a
 * concurrent write added is revoked.
 */

const PATCH = {
  lifecycle: "locally-disconnected",
  lastOutcome: "disconnect.local",
} as const;
const record = (over: Partial<ConnectionRecord> = {}) =>
  ({
    connectionRef: "connection:one",
    generation: 1,
    lifecycle: "active",
    credentialRef: "cred:one",
    ...over,
  }) as ConnectionRecord;
const fenced: ClosingConnection = { record: record(), revision: 5 };
const stale = () =>
  new ConnectorError("conflict", { detail: "connection.revision" });

/** A store whose revision moves under the first `moves` writes; `then` shows what a re-read finds. */
function store(options: {
  moves: number;
  then?: () => ClosingConnection;
  failWith?: Error;
}) {
  const writes: number[] = [];
  let moves = options.moves;
  const port = {
    update: async (_actor: unknown, _ref: string, revision: number) => {
      writes.push(revision);
      if (options.failWith) throw options.failWith;
      if (moves-- > 0) throw stale();
      return { revision: revision + 1 };
    },
    get: async () =>
      options.then?.() ?? { record: record(), revision: 5 + writes.length },
  } as unknown as ConnectionStorePort;
  return { port, writes };
}

test("a closing write that finds the revision moved is applied again to what is there", async () => {
  const { port, writes } = store({ moves: 2 });
  const closed = await closeDisconnected(
    port,
    async () => {},
    fixtureActor,
    fenced,
    PATCH,
  );
  assert.deepEqual(
    writes,
    [5, 6, 7],
    "each retry used the revision it had just read",
  );
  assert.equal(closed.record.lifecycle, "locally-disconnected");
  assert.equal(closed.revision, 8);
});

test("it gives up after a bounded number of tries, with the conflict", async () => {
  const { port, writes } = store({ moves: 100 });
  await assert.rejects(
    closeDisconnected(port, async () => {}, fixtureActor, fenced, PATCH),
    (error: unknown) =>
      error instanceof ConnectorError && error.code === "conflict",
  );
  assert.equal(writes.length, CLOSE_ATTEMPTS);
});

test("a connection that is no longer the generation this disconnect fenced is left as it is", async () => {
  const reconnected: ClosingConnection = {
    record: record({ generation: 2, lifecycle: "authorization-required" }),
    revision: 9,
  };
  const { port, writes } = store({ moves: 1, then: () => reconnected });
  const closed = await closeDisconnected(
    port,
    async () => {},
    fixtureActor,
    fenced,
    PATCH,
  );
  assert.equal(closed, reconnected);
  assert.deepEqual(writes, [5], "no second write over someone else's state");
});

test("a credential a concurrent write put on the record is revoked once, and the close still lands", async () => {
  const replaced: ClosingConnection = {
    record: record({ credentialRef: "cred:two" }),
    revision: 8,
  };
  const { port } = store({ moves: 1, then: () => replaced });
  const revoked: string[] = [];
  const closed = await closeDisconnected(
    port,
    async (ref) => void revoked.push(ref),
    fixtureActor,
    fenced,
    PATCH,
  );
  assert.deepEqual(revoked, ["cred:two"]);
  assert.equal(closed.record.lifecycle, "locally-disconnected");
});

test("an error that is not a stale revision is not retried", async () => {
  const { port, writes } = store({
    moves: 0,
    failWith: new Error("disk on fire"),
  });
  await assert.rejects(
    closeDisconnected(port, async () => {}, fixtureActor, fenced, PATCH),
    /disk on fire/,
  );
  assert.equal(writes.length, 1);
});
