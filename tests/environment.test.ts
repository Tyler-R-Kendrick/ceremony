import { test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { CeremonyDatabase, CeremonyEnvironment } from "../src/server/index.js";

test("environment import merges privately, scopes owners/connectors and rejects stale or oversized edits", () => {
  const db = new CeremonyDatabase(":memory:", randomBytes(32));
  const env = new CeremonyEnvironment(db);
  const original = process.env.TOKEN;
  const input =
    "# ignored\nexport TOKEN='sentinel-env-value'\nMULTILINE=\"line one\nline two\"\nLITERAL=$(echo never-run)\n";
  let meta = env.update("alice", "github", { revision: 0, dotenv: input });
  assert.deepEqual(meta.names, ["LITERAL", "MULTILINE", "TOKEN"]);
  assert.ok(!JSON.stringify(meta).includes("sentinel"));
  assert.equal(env.read("alice", "github").MULTILINE, "line one\nline two");
  assert.equal(env.read("alice", "github").LITERAL, "$(echo never-run)");
  assert.deepEqual(env.describe("bob", "github").names, []);
  assert.deepEqual(env.describe("alice", "stripe").names, []);
  assert.throws(() =>
    env.update("alice", "github", { revision: 0, values: { TOKEN: "stale" } }),
  );
  meta = env.update("alice", "github", {
    revision: meta.revision,
    values: { TOKEN: "replacement" },
    remove: ["LITERAL"],
  });
  assert.equal(env.read("alice", "github").TOKEN, "replacement");
  assert.ok(!meta.names.includes("LITERAL"));
  assert.throws(() =>
    env.update("alice", "github", {
      revision: meta.revision,
      values: { "INVALID-NAME": "private" },
    }),
  );
  assert.throws(() =>
    env.update("alice", "github", {
      revision: meta.revision,
      dotenv: "# empty",
    }),
  );
  assert.throws(() =>
    env.update("alice", "github", {
      revision: meta.revision,
      values: { HUGE: "x".repeat(16385) },
    }),
  );
  assert.equal(process.env.TOKEN, original);
  db.close();
});
