import assert from "node:assert/strict";
import { test } from "node:test";
import { randomBytes, randomUUID } from "node:crypto";
import { generateKeyPair } from "jose";
import { chromium } from "playwright-core";
import { z } from "zod";
import { Agent2Human } from "../src/server/a2h.js";
import { CeremonyDatabase } from "../src/server/storage.js";
import {
  GitHubAppCeremonies,
  githubAppManifest,
} from "../src/server/github.js";
import { CloudflareHumanBrowser } from "../src/server/cloudflare.js";

for (const fault of [
  "disconnect",
  "timeout",
  "rate-limit",
  "unavailable",
  "malformed-json",
  "invalid-schema",
] as const) {
  test(`chaos: GitHub one-shot conversion ${fault} requires recovery, never duplicate creation`, async (t) => {
    const db = new CeremonyDatabase(":memory:", randomBytes(32));
    t.after(() => db.close());
    let calls = 0;
    const github = new GitHubAppCeremonies(db, {
      origin: "https://ceremony.example",
      fetch: async () => {
        calls++;
        if (fault === "disconnect")
          throw new TypeError("synthetic secret network error");
        if (fault === "timeout")
          throw new DOMException("synthetic timeout", "TimeoutError");
        if (fault === "rate-limit")
          return new Response("private diagnostic", { status: 429 });
        if (fault === "unavailable")
          return new Response("private diagnostic", { status: 503 });
        if (fault === "malformed-json") return new Response("{");
        return Response.json({ id: "wrong" });
      },
    });
    const adapter = github.createAdapter({
      owner: "alice",
      instanceId: "run",
      method: githubAppManifest.methods[0]!,
    });
    const state = new URL(
      github.destination("alice", "run").url,
    ).searchParams.get("state")!;
    const callback = new URL(
      `https://ceremony.example/api/live/github/run/callback?state=${state}&code=synthetic`,
    );
    const result = await adapter.callback(callback);
    assert.equal(result.step, "input");
    assert.equal(result.outcome, undefined);
    assert.doesNotMatch(
      JSON.stringify(result),
      /private diagnostic|synthetic secret/,
    );
    await assert.rejects(adapter.callback(callback));
    await assert.rejects(adapter.begin(), /Reconcile/);
    assert.equal(calls, 1);
    assert.equal(db.keys("connection:").length, 0);
  });
}

test("chaos: uncertain A2H delivery retries the same signed intent and releases its lease", async (t) => {
  const db = new CeremonyDatabase(":memory:", randomBytes(32));
  t.after(() => db.close());
  const pair = await generateKeyPair("EdDSA");
  const sent: string[] = [];
  const a2h = new Agent2Human(db, {
    gatewayOrigin: "https://gateway.example",
    agentId: "agent",
    keyId: "key",
    privateKey: pair.privateKey,
    gatewayKey: pair.publicKey,
    apiKey: "synthetic",
    recipient: () => ({
      principalId: "alice",
      type: "email",
      address: "mailto:alice@example.test",
    }),
    fetch: async (input, init) => {
      if (String(input).endsWith("/.well-known/a2h"))
        return Response.json({
          a2h_supported: ["1.0"],
          channels: ["email"],
          max_ttl_sec: 600,
          auth: { methods: ["api_key"] },
        });
      sent.push(String(init?.body));
      if (sent.length === 1) throw new Error("lost acknowledgement");
      return Response.json({
        interaction_id: JSON.parse(sent[0]!).interaction_id,
      });
    },
  });
  await assert.rejects(
    a2h.authorize("alice", "run", "https://ceremony.example/human/run"),
  );
  const id = await a2h.authorize(
    "alice",
    "run",
    "https://ceremony.example/human/run",
  );
  assert.equal(sent.length, 2);
  assert.equal(sent[0], sent[1]);
  assert.equal(
    await a2h.authorize("alice", "run", "https://ceremony.example/human/run"),
    id,
  );
  assert.equal(sent.length, 2);
});

test("chaos: failed event delivery retains its identity and retries after releasing the lease", async (t) => {
  const db = new CeremonyDatabase(":memory:", randomBytes(32));
  t.after(() => db.close());
  const event = {
    eventId: randomUUID(),
    instanceId: "run",
    revision: 1,
    step: "complete",
    occurredAt: 1,
    status: "success",
  };
  db.put(`event:${event.eventId}`, event);
  await assert.rejects(
    db.deliverEvents(async () => {
      throw Error("consumer offline");
    }),
  );
  assert.deepEqual(db.get(`event:${event.eventId}`, z.unknown()), event);
  assert.equal(
    await db.deliverEvents(async (actual) => {
      assert.deepEqual(actual, event);
    }),
    1,
  );
  assert.equal(
    await db.deliverEvents(async () => {
      assert.fail("duplicate");
    }),
    0,
  );
});

test("chaos: remote browser outage permits retry without exposing provider credentials", async (t) => {
  const db = new CeremonyDatabase(":memory:", randomBytes(32));
  t.after(() => db.close());
  t.mock.method(chromium, "connectOverCDP", async () => {
    throw Error("synthetic-private-provider-error");
  });
  const browser = new CloudflareHumanBrowser(db, {
    origin: "https://ceremony.example",
    accountId: "a".repeat(32),
    apiToken: "synthetic-token",
  });
  for (let i = 0; i < 2; i++)
    await assert.rejects(
      browser.request("alice", "run", "synthetic-cookie"),
      (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.match(error.message, /Continue in your own browser/);
        assert.doesNotMatch(error.message, /synthetic/);
        return true;
      },
    );
  assert.throws(() => browser.humanUrl("alice", "run"));
  browser.cancel("run");
  await browser.close();
});
