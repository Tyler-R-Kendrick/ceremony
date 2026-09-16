import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { test } from "node:test";
import { SQLiteCeremonyStore } from "../src/server/persistence/index.js";
import { resolveGitHubInstallationRun } from "../src/server/recipes/github.js";
import type { ActorContext } from "../src/core/operation-contracts.js";

test("installation return routing independently rejects forged actor, origin, state syntax, binding and expiry", async (t) => {
  const backing = new SQLiteCeremonyStore(":memory:", {
    current: "test",
    keys: { test: randomBytes(32) },
  });
  t.after(() => backing.close());
  const nonce = "a".repeat(43);
  const actor: ActorContext = {
    tenantId: "tenant",
    subjectId: "alice-subject",
    sessionId: "session",
    actorKind: "human",
    capabilities: ["executor"],
  };
  const origin = "http://127.0.0.1:4173";
  const fixedNow = Date.now();
  const store = {
    close: async () => {},
    transaction: <T>(
      work: (
        tx: import("../src/server/persistence/index.js").AsyncTransaction,
      ) => Promise<T>,
    ) =>
      backing.transaction((tx) => work({ ...tx, now: async () => fixedNow })),
  };
  const url = (state = nonce) =>
    new URL(
      `${origin}/api/v1/teaching/github/installation-return?state=${encodeURIComponent(state)}`,
    );
  const save = (state = nonce, changes = {}) =>
    backing.transaction(async (tx) => {
      const key = {
        tenant: actor.tenantId,
        kind: "handoff" as const,
        id: `github-return:${createHash("sha256").update(state).digest("hex")}`,
      };
      const prior = await tx.get(key);
      await tx.put(
        key,
        {
          subject: actor.subjectId,
          runId: "authorized-parent",
          origin,
          expires: fixedNow + 1,
          ...changes,
        },
        prior?.revision ?? null,
      );
    });
  await save();
  assert.equal(
    await resolveGitHubInstallationRun(store, actor, origin, url()),
    "authorized-parent",
  );
  for (const changed of [
    { actorKind: "agent" as const },
    { actorKind: "system" as const },
    { subjectId: "foreign" },
    { tenantId: "foreign" },
  ])
    await assert.rejects(
      resolveGitHubInstallationRun(
        store,
        { ...actor, ...changed },
        origin,
        url(),
      ),
      /return unavailable/,
    );
  for (const target of [
    new URL(url().href.replace(origin, "https://foreign.example")),
    new URL(`${origin}/other?state=${nonce}`),
    new URL(`${url()}&state=${nonce}`),
    new URL(`${origin}/api/v1/teaching/github/installation-return`),
  ])
    await assert.rejects(
      resolveGitHubInstallationRun(store, actor, origin, target),
      /return unavailable/,
    );
  // Seed invalid tokens deliberately: otherwise a lookup miss masks a removed syntax guard.
  for (const invalid of [
    `!${nonce}`,
    `${nonce}!`,
    "a".repeat(42),
    "a".repeat(44),
  ]) {
    await save(invalid);
    await assert.rejects(
      resolveGitHubInstallationRun(store, actor, origin, url(invalid)),
      /return unavailable/,
    );
  }
  for (const change of [
    { origin: "https://foreign.example" },
    { subject: "foreign" },
    { expires: fixedNow },
    { expires: fixedNow - 1 },
  ]) {
    await save(nonce, change);
    await assert.rejects(
      resolveGitHubInstallationRun(store, actor, origin, url()),
      /return unavailable/,
    );
  }
});
