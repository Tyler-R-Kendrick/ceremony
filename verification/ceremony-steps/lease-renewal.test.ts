// The durable controller renews a request's lease while its adapter call is
// in flight (controller.ts renewWhileWaiting), so a call longer than the
// 60-second lease keeps it: no other worker is let in, and the answer is
// stored. DurableSteps.tla's LeaseExpires is then a renewal that did not
// land in time, which durable-conformance.test.ts replays.
//
// The leases and the renewal timer run on a fake clock (Date and
// setInterval mocked); the ceremony's own clock is the controller's `now`.
//
// Run from the repo root:
//   node --import tsx --test verification/ceremony-steps/lease-renewal.test.ts
// verification/ceremony-steps/check.sh runs it with durable-conformance.test.ts.
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

function cluster(t: TestContext) {
  t.mock.timers.enable({ apis: ["Date", "setInterval"], now: 0 });
  const dir = mkdtempSync(join(tmpdir(), "ceremony-renewal-"));
  const path = join(dir, "ceremony.db");
  const key = randomBytes(32);
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
    const script = {
      begin: async (): Promise<AdapterUpdate> => redirect,
      callback: async (): Promise<AdapterUpdate> => complete,
      requestHuman: async (): Promise<AdapterUpdate> => redirect,
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
            poll: async () => undefined,
            requestHuman: () => script.requestHuman(),
            cancel() {},
          }),
        },
      ],
      new Map(),
      () => 1_000_000,
      { database: open() },
    );
    return {
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
    stored: (id: string) => inspector.get(`instance:${id}`, stored)?.snapshot,
    /** The fake clock moves on in 10-second steps, firing every renewal due. */
    wait: (ms: number) => {
      for (let passed = 0; passed < ms; passed += 10_000)
        t.mock.timers.tick(Math.min(10_000, ms - passed));
    },
  };
}

test("a begin call of 90 seconds keeps its 60-second lease: no other worker is let in, and its answer is stored", async (t) => {
  const c = cluster(t);
  const first = c.w1.start();
  const pending = Promise.withResolvers<AdapterUpdate>();
  c.w1.script.begin = () => pending.promise;
  const beginning = c.w1.act(first.id, "begin", first.revision);
  c.wait(90_000);
  await assert.rejects(
    c.w2.act(first.id, "cancel", first.revision),
    /already executing/,
  );
  await assert.rejects(c.w2.read(first.id), /already executing/);
  pending.resolve(redirect);
  const atProvider = await beginning;
  assert.equal(atProvider.step, "redirect");
  assert.equal(atProvider.revision, first.revision + 1);
  assert.deepEqual(c.stored(first.id), atProvider);
  // The lease is released with the request, and the renewal stops with it.
  assert.deepEqual(await c.w2.read(first.id), atProvider);
  c.wait(120_000);
  assert.deepEqual(await c.w2.read(first.id), atProvider);
});

test("a callback of 150 seconds keeps its lease and stores complete", async (t) => {
  const c = cluster(t);
  const first = c.w1.start();
  const atProvider = await c.w1.act(first.id, "begin", first.revision);
  const pending = Promise.withResolvers<AdapterUpdate>();
  c.w1.script.callback = () => pending.promise;
  const returning = c.w1.callback(first.id);
  c.wait(150_000);
  await assert.rejects(c.w2.callback(first.id), /already executing/);
  pending.resolve(complete);
  const connected = await returning;
  assert.equal(connected.step, "complete");
  assert.equal(connected.revision, atProvider.revision + 1);
  assert.deepEqual(c.stored(first.id), connected);
});

test("a request-human delivery of 90 seconds keeps its lease and stores its answer", async (t) => {
  const c = cluster(t);
  const first = c.w1.start();
  const atProvider = await c.w1.act(first.id, "begin", first.revision);
  assert.ok(atProvider.actions.includes("request-human"));
  const pending = Promise.withResolvers<AdapterUpdate>();
  c.w1.script.requestHuman = () => pending.promise;
  const delivering = c.w1.act(first.id, "request-human", atProvider.revision);
  c.wait(90_000);
  await assert.rejects(
    c.w2.act(first.id, "cancel", atProvider.revision),
    /already executing/,
  );
  pending.resolve(complete);
  const answered = await delivering;
  assert.equal(answered.step, "complete");
  assert.equal(answered.revision, atProvider.revision + 1);
  assert.deepEqual(c.stored(first.id), answered);
});
