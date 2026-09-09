import assert from "node:assert/strict";
import { awaitStarted } from "./fixtures/await-started.js";
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
    try {
      await awaitStarted(started.promise, result);
    } catch (error) {
      pending.resolve(snapshot);
      client.dispose();
      await result.catch(() => undefined);
      throw error;
    }
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

for (const phase of ["collection", "recovery"] as const)
  for (const stop of ["abort", "dispose"] as const)
    test(`behavior: ${stop} during ${phase} cannot submit or accept late credentials`, async () => {
      const manifest = manifests[1]!;
      const snapshot: CeremonySnapshot = {
        id: "run",
        revision: 0,
        connectorId: manifest.id,
        connectorName: manifest.name,
        description: manifest.description,
        method: manifest.methods[0]!,
        step: "input",
        fields: manifest.methods[0]!.fields,
        actions: ["submit", "cancel"],
        expiresAt: Date.now() + 60000,
      };
      const pending = Promise.withResolvers<void>();
      const started = Promise.withResolvers<void>();
      let submissions = 0;
      let completions = 0;
      const client = createCeremonyClient({
        manifest,
        onComplete: () => {
          completions++;
        },
        transport: {
          start: async () => snapshot,
          collect: async () => {
            if (phase === "collection") {
              started.resolve();
              await pending.promise;
            }
            return "00000000-0000-4000-8000-000000000001";
          },
          act: async () => {
            submissions++;
            throw new Error("Synthetic submit failure");
          },
          read: async () => {
            started.resolve();
            await pending.promise;
            return {
              ...snapshot,
              step: "complete",
              actions: [],
              outcome: {
                connectionRef: "late",
                ownership: "authenticated",
                scopes: [],
              },
            };
          },
        },
      });
      await client.initialize();
      const signal = new AbortController();
      const result = client.execute(
        { action: "submit", values: { token: "synthetic" } },
        "ui",
        signal.signal,
      );
      try {
        await awaitStarted(started.promise, result);
      } catch (error) {
        pending.resolve();
        client.dispose();
        await result.catch(() => undefined);
        throw error;
      }
      if (stop === "abort") signal.abort();
      else client.dispose();
      pending.resolve();
      await assert.rejects(result);
      assert.equal(submissions, phase === "collection" ? 0 : 1);
      assert.equal(client.getState().snapshot?.step, "input");
      assert.equal(completions, 0);
      client.dispose();
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
