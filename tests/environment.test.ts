import { test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { CeremonyDatabase, CeremonyEnvironment } from "../src/server/index.js";

test("environment import merges privately, scopes sessions and rejects stale or oversized edits", () => {
  const db = new CeremonyDatabase(":memory:", randomBytes(32));
  const env = new CeremonyEnvironment(db);
  const original = process.env.TOKEN;
  const input =
    "# ignored\nexport TOKEN='sentinel-env-value'\nMULTILINE=\"line one\nline two\"\nLITERAL=$(echo never-run)\n";
  let meta = env.update("alice", { revision: 0, dotenv: input });
  assert.deepEqual(meta.names, ["LITERAL", "MULTILINE", "TOKEN"]);
  assert.ok(!JSON.stringify(meta).includes("sentinel"));
  assert.equal(env.read("alice").MULTILINE, "line one\nline two");
  assert.equal(env.read("alice").LITERAL, "$(echo never-run)");
  assert.deepEqual(env.describe("bob").names, []);
  assert.deepEqual(env.describe("alice").names, meta.names);
  assert.throws(() =>
    env.update("alice", { revision: 0, values: { TOKEN: "stale" } }),
  );
  meta = env.update("alice", {
    revision: meta.revision,
    values: { TOKEN: "replacement" },
    remove: ["LITERAL"],
  });
  assert.equal(env.read("alice").TOKEN, "replacement");
  assert.ok(!meta.names.includes("LITERAL"));
  assert.throws(() =>
    env.update("alice", {
      revision: meta.revision,
      values: { "INVALID-NAME": "private" },
    }),
  );
  assert.throws(() =>
    env.update("alice", {
      revision: meta.revision,
      dotenv: "# empty",
    }),
  );
  assert.throws(() =>
    env.update("alice", {
      revision: meta.revision,
      values: { HUGE: "x".repeat(16385) },
    }),
  );
  assert.equal(process.env.TOKEN, original);
  db.close();
});

test("legacy connector environments migrate once without losing originals or crossing sessions", () => {
  const db = new CeremonyDatabase(":memory:", randomBytes(32));
  db.put('environment:["alice","github"]', {
    revision: 3,
    values: { APP: "one" },
  });
  db.put('environment:["alice","stripe"]', {
    revision: 2,
    values: { PAYMENT: "two" },
  });
  const env = new CeremonyEnvironment(db);
  assert.deepEqual(env.read("alice"), { APP: "one", PAYMENT: "two" });
  assert.deepEqual(env.read("bob"), {});
  env.update("alice", { revision: 0, remove: ["APP"] });
  assert.deepEqual(new CeremonyEnvironment(db).read("alice"), {
    PAYMENT: "two",
  });
  assert.equal(db.keys("environment:").length, 2);
  db.put('environment:["conflict","github"]', {
    revision: 0,
    values: { KEY: "one" },
  });
  db.put('environment:["conflict","stripe"]', {
    revision: 0,
    values: { KEY: "two" },
  });
  assert.throws(() => env.read("conflict"), /conflict/);
  db.close();
});
