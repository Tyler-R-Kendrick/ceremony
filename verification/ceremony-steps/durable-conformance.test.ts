// Ties DurableSteps.tla to the real durable controller on SQLite.
//
// Two workers are two CeremonyControllers, each with its own CeremonyDatabase
// connection to one SQLite file, as two processes would have. The leases use
// Date.now() (storage.ts:98-112), so a lease runs out when the mocked Date
// passes it; the ceremony's own clock is the controller's `now`.
//
// The first three tests show what DurableSteps.tla takes as given: the lease,
// the reload in instance(), and the poll on redirect. The rest show the two
// rules of the database path on the real code: a lease that runs out during
// an adapter call does not let a second worker's answer be applied over the
// first, and a reload never moves a final step. They cover a late answer of
// the begin, callback and poll flights and a late throw of the callback and
// poll flights.
//
// Run from the repo root:
//   node --import tsx --test verification/ceremony-steps/durable-conformance.test.ts
// verification/ceremony-steps/check.sh runs it after the model check.
import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { z } from "zod";
import { snapshotSchema } from "../../src/core/schema.js";
import {
  CeremonyController,
  type AdapterUpdate,
} from "../../src/server/controller.js";
import { CeremonyDatabase } from "../../src/server/storage.js";

const manifest = {
  id: "provider",
  name: "Provider",
  description: "A provider used only by this check.",
  methods: [
    {
      id: "oauth",
      label: "Sign in",
      kind: "oauth-code" as const,
      fields: [],
      scopes: [],
      templateId: "oauth-code",
    },
  ],
};
const redirect: AdapterUpdate = {
  step: "redirect",
  authorizationUrl: "https://provider.example/authorize",
};
const complete: AdapterUpdate = {
  step: "complete",
  outcome: { connectionRef: "ref", ownership: "authenticated", scopes: [] },
};
const callbackUrl = new URL("https://host.example/callback?code=c&state=s");
const stored = z.object({ owner: z.string(), snapshot: snapshotSchema });

/** What one worker's adapters answer. A test replaces an entry to hold an answer back. */
interface Script {
  begin: () => Promise<AdapterUpdate>;
  callback: () => Promise<AdapterUpdate>;
  poll: () => Promise<AdapterUpdate | undefined>;
  polls: number;
}

function cluster(t: TestContext) {
  // The leases read Date.now(); the mocked Date makes them run out on demand.
  t.mock.timers.enable({ apis: ["Date"], now: 0 });
  const dir = mkdtempSync(join(tmpdir(), "ceremony-durable-"));
  const path = join(dir, "ceremony.db");
  const key = randomBytes(32);
  const clock = { now: 1_000_000 };
  const opened: CeremonyDatabase[] = [];
  const open = () => {
    const database = new CeremonyDatabase(path, key);
    opened.push(database);
    return database;
  };
  t.after(() => {
    for (const database of opened) database.close();
    rmSync(dir, { recursive: true, force: true });
  });
  const worker = () => {
    const script: Script = {
      begin: async () => redirect,
      callback: async () => complete,
      poll: async () => undefined,
      polls: 0,
    };
    const controller = new CeremonyController(
      [
        {
          manifest,
          recoverable: true,
          createAdapter: () => ({
            begin: () => script.begin(),
            submit: async () => complete,
            callback: () => script.callback(),
            poll: () => {
              script.polls++;
              return script.poll();
            },
            cancel() {},
          }),
        },
      ],
      new Map(),
      () => clock.now,
      { database: open() },
    );
    return {
      controller,
      script,
      start: () => controller.start("alice", "provider", "oauth"),
      act: (id: string, action: string, revision: number) =>
        controller.act("alice", id, { action, revision }),
      read: (id: string) => controller.read("alice", id),
      callback: (id: string) => controller.callback("alice", id, callbackUrl),
    };
  };
  const inspector = open();
  return {
    w1: worker(),
    w2: worker(),
    clock,
    /** The stored snapshot, as the database holds it. */
    stored: (id: string) => inspector.get(`instance:${id}`, stored)?.snapshot,
    /** The lease the waiting request holds runs out (storage.ts:98: 60 seconds). */
    leaseRunsOut: () => t.mock.timers.tick(60_001),
    pastTheDeadline: () => {
      clock.now += 600_001;
    },
  };
}

test("lease: while one worker waits on the adapter, every request to another worker is refused (storage.ts:98-112)", async (t) => {
  const c = cluster(t);
  const first = c.w1.start();
  const pending = Promise.withResolvers<AdapterUpdate>();
  c.w1.script.begin = () => pending.promise;
  const beginning = c.w1.act(first.id, "begin", first.revision);
  await assert.rejects(c.w2.read(first.id), /already executing/);
  await assert.rejects(
    c.w2.act(first.id, "cancel", first.revision),
    /already executing/,
  );
  await assert.rejects(c.w2.callback(first.id), /already executing/);
  pending.resolve(redirect);
  assert.equal((await beginning).step, "redirect");
  assert.equal(c.stored(first.id)?.revision, 1);
});

test("reload-each-request: a worker reads what another worker stored (controller.ts:274-299)", async (t) => {
  const c = cluster(t);
  const first = c.w1.start();
  const atProvider = await c.w1.act(first.id, "begin", first.revision);
  assert.equal(atProvider.step, "redirect");
  assert.deepEqual(await c.w2.read(first.id), atProvider);
  const connected = await c.w2.callback(first.id);
  assert.equal(connected.step, "complete");
  assert.equal(connected.revision, atProvider.revision + 1);
  assert.deepEqual(await c.w1.read(first.id), connected);
});

test("poll on redirect: a durable read polls the adapter on redirect (controller.ts:422-430)", async (t) => {
  const c = cluster(t);
  const first = c.w1.start();
  const atProvider = await c.w1.act(first.id, "begin", first.revision);
  assert.equal(c.w1.script.polls, 0);
  c.w1.script.poll = async () => complete;
  const connected = await c.w1.read(first.id);
  assert.equal(c.w1.script.polls, 1);
  assert.equal(connected.step, "complete");
  assert.equal(connected.revision, atProvider.revision + 1);
  assert.deepEqual(c.stored(first.id), connected);
});

test("OneWorkerAppliesAnswers: an answer that lands after its lease ran out is not stored over a later change", async (t) => {
  // DurableSteps.tla, Durable.cfg: ActBegin(w1), LeaseExpires, then w2 moves
  // the ceremony on, then Answer(w1).
  const c = cluster(t);
  const first = c.w1.start();
  const pending = Promise.withResolvers<AdapterUpdate>();
  c.w1.script.begin = () => pending.promise;
  const beginning = c.w1.act(first.id, "begin", first.revision);
  c.leaseRunsOut();
  const atProvider = await c.w2.act(first.id, "begin", first.revision);
  const connected = await c.w2.callback(first.id);
  assert.equal(connected.step, "complete");
  assert.equal(connected.revision, atProvider.revision + 1);
  pending.resolve(redirect);
  await beginning.catch(() => undefined);
  const now = c.stored(first.id);
  assert.equal(now?.step, "complete", "the stored ceremony stays connected");
  assert.equal(now?.revision, connected.revision);
  assert.deepEqual(now?.outcome, connected.outcome);
});

test("ReloadNeverMovesAnEndStep: cancelled stays cancelled after a late answer from a worker that lost its lease", async (t) => {
  // DurableReload.cfg: ActBegin(w1), LeaseExpires, ActCancel(w2), Answer(w1),
  // Read(w2).
  const c = cluster(t);
  const first = c.w1.start();
  const pending = Promise.withResolvers<AdapterUpdate>();
  c.w1.script.begin = () => pending.promise;
  const beginning = c.w1.act(first.id, "begin", first.revision);
  c.leaseRunsOut();
  const cancelled = await c.w2.act(first.id, "cancel", first.revision);
  assert.equal(cancelled.step, "cancelled");
  pending.resolve(redirect);
  await beginning.catch(() => undefined);
  const again = await c.w2.read(first.id);
  assert.equal(again.step, "cancelled", "the reload keeps the end step");
  assert.equal(again.revision, cancelled.revision);
});

test("ReloadNeverMovesAnEndStep: expired stays expired after a late callback answer from a worker that lost its lease", async (t) => {
  const c = cluster(t);
  const first = c.w1.start();
  const atProvider = await c.w1.act(first.id, "begin", first.revision);
  const pending = Promise.withResolvers<AdapterUpdate>();
  c.w1.script.callback = () => pending.promise;
  const returning = c.w1.callback(first.id);
  c.leaseRunsOut();
  c.pastTheDeadline();
  const expired = await c.w2.read(first.id);
  assert.equal(expired.step, "expired");
  assert.equal(expired.revision, atProvider.revision + 1);
  pending.resolve(complete);
  await returning.catch(() => undefined);
  const again = await c.w2.read(first.id);
  assert.equal(again.step, "expired", "the reload keeps the end step");
  assert.equal(again.revision, expired.revision);
  assert.equal(again.outcome, undefined);
});

// DurableSteps.tla sends every answer of every flight through Fenced,
// including the poll flight and the "throws" answers of the callback and poll
// flights. The tests below replay those answers on the real code: a poll
// answer, a callback that throws, and a poll that throws while waiting, each
// landing after its lease ran out and another worker cancelled.

const waiting: AdapterUpdate = {
  step: "waiting",
  verificationUri: "https://provider.example/device",
  userCode: "ABCD-EFGH",
};

test("OneWorkerAppliesAnswers on the poll flight: a poll answer that lands after its lease ran out is not stored over cancelled", async (t) => {
  // DurableSteps.tla: Read(w1) polls on redirect, LeaseExpires, ActCancel(w2),
  // Answer(w1) for the "poll" flight.
  const c = cluster(t);
  const first = c.w1.start();
  const atProvider = await c.w1.act(first.id, "begin", first.revision);
  const pending = Promise.withResolvers<AdapterUpdate | undefined>();
  c.w1.script.poll = () => pending.promise;
  const reading = c.w1.read(first.id);
  assert.equal(c.w1.script.polls, 1);
  c.leaseRunsOut();
  const cancelled = await c.w2.act(first.id, "cancel", atProvider.revision);
  assert.equal(cancelled.step, "cancelled");
  pending.resolve(complete);
  await reading.catch(() => undefined);
  const now = c.stored(first.id);
  assert.equal(now?.step, "cancelled", "the late poll answer is not stored");
  assert.equal(now?.revision, cancelled.revision);
  assert.equal(now?.outcome, undefined);
});

test("OneWorkerAppliesAnswers on a throw: a callback that throws after its lease ran out does not store error over cancelled", async (t) => {
  // DurableSteps.tla: ActCallback(w1), LeaseExpires, ActCancel(w2),
  // Answer(w1) with "throws" for the "callback" flight.
  const c = cluster(t);
  const first = c.w1.start();
  const atProvider = await c.w1.act(first.id, "begin", first.revision);
  const pending = Promise.withResolvers<AdapterUpdate>();
  c.w1.script.callback = () => pending.promise;
  const returning = c.w1.callback(first.id);
  c.leaseRunsOut();
  const cancelled = await c.w2.act(first.id, "cancel", atProvider.revision);
  assert.equal(cancelled.step, "cancelled");
  pending.reject(new Error("provider down"));
  await returning.catch(() => undefined);
  const now = c.stored(first.id);
  assert.equal(now?.step, "cancelled", "the late throw is not stored as error");
  assert.equal(now?.revision, cancelled.revision);
});

test("OneWorkerAppliesAnswers on a throw while waiting: a poll that throws after its lease ran out does not store waiting over cancelled", async (t) => {
  // DurableSteps.tla: Read(w1) polls while waiting, LeaseExpires,
  // ActCancel(w2), Answer(w1) with "throws" for the "poll" flight.
  const c = cluster(t);
  const first = c.w1.start();
  c.w1.script.begin = async () => waiting;
  const onDevice = await c.w1.act(first.id, "begin", first.revision);
  assert.equal(onDevice.step, "waiting");
  const pending = Promise.withResolvers<AdapterUpdate | undefined>();
  c.w1.script.poll = () => pending.promise;
  const reading = c.w1.read(first.id);
  assert.equal(c.w1.script.polls, 1);
  c.leaseRunsOut();
  const cancelled = await c.w2.act(first.id, "cancel", onDevice.revision);
  assert.equal(cancelled.step, "cancelled");
  pending.reject(new Error("provider down"));
  await reading.catch(() => undefined);
  const now = c.stored(first.id);
  assert.equal(
    now?.step,
    "cancelled",
    "the late throw is not stored as waiting",
  );
  assert.equal(now?.revision, cancelled.revision);
});
