import assert from "node:assert/strict";
import { test } from "node:test";
import { randomBytes } from "node:crypto";
import {
  createCeremonyClient,
  type CeremonySnapshot,
  type CeremonyTransport,
} from "../src/core/index.js";
import { MemoryCredentialStore } from "../src/server/adapters.js";
import { CloudflareHumanBrowser } from "../src/server/cloudflare.js";
import { CeremonyDatabase } from "../src/server/storage.js";
import { manifests } from "../examples/manifests.js";

for (const stop of ["abort", "dispose"] as const)
  test(`behavior: given an in-flight read, when ${stop} occurs, then no late completion is accepted`, async () => {
    const manifest = manifests[0]!;
    const snapshot: CeremonySnapshot = {
      id: "run",
      revision: 0,
      connectorId: manifest.id,
      connectorName: manifest.name,
      description: manifest.description,
      method: manifest.methods[0]!,
      step: "waiting",
      fields: [],
      actions: ["cancel"],
      expiresAt: Date.now() + 60000,
    };
    const pending = Promise.withResolvers<CeremonySnapshot>();
    const started = Promise.withResolvers<void>();
    let reads = 0;
    let completions = 0;
    const transport: CeremonyTransport = {
      start: async () => snapshot,
      read: async () => {
        reads++;
        started.resolve();
        return pending.promise;
      },
      act: async () => snapshot,
    };
    const client = createCeremonyClient({
      manifest,
      transport,
      selection: "manual",
      onComplete: () => {
        completions++;
      },
    });
    await client.execute({ action: "start", methodId: snapshot.method.id });
    const signal = new AbortController();
    const result = client.execute({ action: "read" }, "webmcp", signal.signal);
    await started.promise;
    if (stop === "abort") signal.abort();
    else client.dispose();
    pending.resolve({
      ...snapshot,
      step: "complete",
      actions: [],
      outcome: {
        connectionRef: "late",
        ownership: "authenticated",
        scopes: [],
      },
    });
    await assert.rejects(result, /abort|disposed/i);
    assert.equal(client.getState().snapshot?.step, "waiting");
    assert.equal(completions, 0);
    assert.equal(reads, 1);
    client.dispose();
  });

test("atomic: a memory credential expires at the exact expiry instant", async (t) => {
  let now = 1000;
  t.mock.method(Date, "now", () => now);
  const store = new MemoryCredentialStore();
  const ref = await store.put({ token: "synthetic" });
  now += 3600000;
  assert.equal(store.get(ref), undefined);
});

for (const origin of [
  "https://user:password@ceremony.example",
  "https://ceremony.example/path",
  "https://ceremony.example/?token=secret",
  "https://ceremony.example/#fragment",
  "http://localhost",
])
  test(`atomic: remote browser rejects ambiguous origin ${new URL(origin).pathname}${new URL(origin).protocol}`, (t) => {
    const db = new CeremonyDatabase(":memory:", randomBytes(32));
    t.after(() => db.close());
    assert.throws(
      () =>
        new CloudflareHumanBrowser(db, {
          origin,
          accountId: "a".repeat(32),
          apiToken: "synthetic",
        }),
    );
  });
