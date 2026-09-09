import { test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes, generateKeyPairSync } from "node:crypto";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  exportSPKI,
  generateKeyPair,
  importSPKI,
  jwtVerify,
  CompactSign,
} from "jose";
import { z } from "zod";
import {
  CeremonyDatabase,
  PrivateCredentialBroker,
  CeremonyController,
  GitHubAppCeremonies,
  githubAppManifest,
  Agent2Human,
  canonicalJson,
} from "../src/server/index.js";

test("encrypted records survive restart; credential references enforce owner, run, revision, expiry and replay", () => {
  const path = join(
    mkdtempSync(join(tmpdir(), "ceremony-vault-")),
    "state.sqlite",
  );
  const key = randomBytes(32);
  let db = new CeremonyDatabase(path, key);
  let broker = new PrivateCredentialBroker(db);
  const ref = broker.collect("alice", "run", 2, {
    token: "sentinel-private-token",
  });
  assert.throws(() => broker.consume("bob", "run", 2, ref));
  assert.throws(() => broker.consume("alice", "other", 2, ref));
  assert.throws(() => broker.consume("alice", "run", 3, ref));
  assert.ok(
    !readFileSync(path).includes(Buffer.from("sentinel-private-token")),
  );
  db.close();
  db = new CeremonyDatabase(path, key);
  broker = new PrivateCredentialBroker(db);
  assert.deepEqual(broker.consume("alice", "run", 2, ref), {
    token: "sentinel-private-token",
  });
  assert.throws(() => broker.consume("alice", "run", 2, ref));
  db.put("collection:expired", {
    owner: "alice",
    instanceId: "run",
    revision: 2,
    expiresAt: 0,
    values: { token: "expired" },
  });
  assert.throws(() => broker.consume("alice", "run", 2, "expired"));
  const lease = db.acquire("run");
  assert.throws(() => db.acquire("run"));
  db.release("run", "wrong");
  assert.throws(() => db.acquire("run"));
  db.release("run", lease);
  db.put("test", { value: "secret" });
  db.close();
  const wrong = new CeremonyDatabase(path, randomBytes(32));
  assert.throws(() => wrong.get("test", z.object({ value: z.string() })));
  wrong.close();
});

test("GitHub registration gates installation/signing, resumes across restart, verifies JWT and provider identity", async () => {
  const path = join(
    mkdtempSync(join(tmpdir(), "ceremony-github-")),
    "state.sqlite",
  );
  const vaultKey = randomBytes(32);
  const pair = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const pem = pair.privateKey
    .export({ type: "pkcs1", format: "pem" })
    .toString();
  const publicKey = await importSPKI(
    pair.publicKey.export({ type: "spki", format: "pem" }).toString(),
    "RS256",
  );
  const calls: string[] = [];
  let wrongAccount = false;
  let lostConversion = false;
  const fetcher: typeof fetch = async (input, init) => {
    const url = String(input);
    calls.push(url);
    if (lostConversion && url.endsWith("/conversions"))
      throw new Error("Lost response");
    if (url.endsWith("/conversions"))
      return Response.json({
        id: 42,
        slug: "ceremony-test",
        pem,
        owner: { login: "alice" },
        client_secret: "unused-private-client-secret",
      });
    const auth = new Headers(init?.headers).get("authorization")!.slice(7);
    if (url.endsWith("/installation/repositories?per_page=1")) {
      assert.equal(auth, "sentinel-installation-token");
      return Response.json({ total_count: 1, repositories: [{ id: 8 }] });
    }
    const verified = await jwtVerify(auth, publicKey, {
      issuer: "42",
      algorithms: ["RS256"],
    });
    assert.ok(verified.payload.exp! - verified.payload.iat! <= 600);
    if (url.endsWith("/app"))
      return Response.json({
        id: 42,
        slug: "ceremony-test",
        owner: { login: "alice" },
        permissions: { contents: "read" },
      });
    if (url.endsWith("/app/installations/7"))
      return Response.json({
        id: 7,
        app_id: 42,
        account: { login: wrongAccount ? "mallory" : "alice" },
        suspended_at: null,
      });
    if (url.endsWith("/access_tokens")) {
      assert.deepEqual(JSON.parse(String(init?.body)), {
        permissions: { contents: "read" },
      });
      return Response.json({
        token: "sentinel-installation-token",
        expires_at: new Date(Date.now() + 3_600_000).toISOString(),
        permissions: { contents: "read" },
      });
    }
    throw new Error("Unexpected provider request");
  };
  let db = new CeremonyDatabase(path, vaultKey);
  let github = new GitHubAppCeremonies(db, {
    origin: "http://127.0.0.1:4173",
    fetch: fetcher,
    requestHuman: async () => {},
  });
  const controller = () =>
    new CeremonyController(
      [
        {
          manifest: githubAppManifest,
          recoverable: true,
          createAdapter: (context) => github.createAdapter(context),
          resume: (owner) => github.resume(owner),
        },
      ],
      new Map(),
      Date.now,
      { database: db, broker: new PrivateCredentialBroker(db) },
    );
  let runtime = controller();
  let snapshot = runtime.start("alice", "github", "github-app");
  assert.ok(snapshot.actions.includes("request-human"));
  assert.equal(snapshot.prerequisites?.[1]?.status, "blocked");
  assert.equal(runtime.start("alice", "github", "github-app").id, snapshot.id);
  db.put(`github:${snapshot.id}`, {
    owner: "alice",
    phase: "prepare",
    nonce: "legacy",
    expiresAt: Date.now() + 600_000,
  });
  db.put(`instance:${snapshot.id}`, {
    owner: "alice",
    snapshot: { ...snapshot, step: "intro", actions: ["begin", "cancel"] },
  });
  runtime = controller();
  snapshot = runtime.start("alice", "github", "github-app");
  assert.equal(snapshot.step, "redirect");
  assert.ok(snapshot.actions.includes("request-human"));
  await assert.rejects(
    runtime.act("alice", snapshot.id, {
      action: "finish",
      revision: snapshot.revision,
    }),
  );
  assert.equal(calls.length, 0);
  assert.equal(snapshot.step, "redirect");
  assert.equal(snapshot.prerequisites?.[0]?.status, "awaiting-human");
  const registration = github.destination("alice", snapshot.id);
  assert.equal(registration.kind, "manifest");
  assert.throws(() => github.destination("bob", snapshot.id));
  const state = new URL(registration.url).searchParams.get("state")!;
  assert.throws(() => github.callbackOwner(snapshot.id, "forged"));
  assert.equal(github.callbackOwner(snapshot.id, state), "alice");
  const callback = new URL(
    `http://127.0.0.1:4173/api/live/github/${snapshot.id}/callback?state=${state}&code=conversion-code`,
  );
  snapshot = await runtime.callback("alice", snapshot.id, callback);
  assert.equal(snapshot.prerequisites?.[0]?.status, "succeeded");
  assert.equal(snapshot.prerequisites?.[2]?.status, "blocked");
  assert.equal(snapshot.outcome, undefined);
  assert.throws(() => github.callbackOwner(snapshot.id, state));
  db.close();
  db = new CeremonyDatabase(path, vaultKey);
  github = new GitHubAppCeremonies(db, {
    origin: "http://127.0.0.1:4173",
    fetch: fetcher,
  });
  runtime = controller();
  snapshot = await runtime.read("alice", snapshot.id);
  assert.equal(snapshot.step, "redirect");
  assert.equal(
    (await runtime.read("alice", snapshot.id)).revision,
    snapshot.revision,
  );
  const installationState = new URL(
    github.destination("alice", snapshot.id).url,
  ).searchParams.get("state")!;
  snapshot = await runtime.callback(
    "alice",
    snapshot.id,
    new URL(
      `http://127.0.0.1:4173/api/live/github/${snapshot.id}/callback?state=${installationState}&installation_id=7`,
    ),
  );
  assert.equal(snapshot.step, "complete");
  assert.ok(
    snapshot.prerequisites?.every((node) => node.status === "succeeded"),
  );
  assert.ok(snapshot.outcome?.connectionRef);
  assert.ok(!JSON.stringify(snapshot).includes("sentinel"));
  assert.ok(!JSON.stringify(snapshot).includes("PRIVATE KEY"));
  assert.ok(
    !readFileSync(path).includes(Buffer.from("sentinel-installation-token")),
  );
  await assert.rejects(runtime.callback("alice", snapshot.id, callback));
  // A second principal gets an independent app ceremony and cannot consume Alice's app configuration.
  const other = runtime.start("bob", "github", "github-app");
  assert.equal(other.prerequisites?.[0]?.status, "awaiting-human");
  assert.notEqual(other.id, snapshot.id);
  const shared = new GitHubAppCeremonies(db, {
    origin: "http://127.0.0.1:4173",
    fetch: fetcher,
    app: { id: 42, slug: "ceremony-test", pem, owner: { login: "alice" } },
    expectedAccount: "alice",
  });
  const adapter = shared.createAdapter({
    owner: "charlie",
    instanceId: "other-install",
    method: githubAppManifest.methods[0]!,
  });
  await adapter.begin();
  const configured = new GitHubAppCeremonies(db, {
    origin: "http://127.0.0.1:4173",
    fetch: fetcher,
    resolveApp: (owner) => {
      assert.equal(owner, "environment-owner");
      return { id: 42, slug: "ceremony-test", pem, owner: { login: "alice" } };
    },
  });
  const configuredAdapter = configured.createAdapter({
    owner: "environment-owner",
    instanceId: "environment-run",
    method: githubAppManifest.methods[0]!,
  });
  assert.equal(
    configuredAdapter.initial?.().prerequisites?.[0]?.status,
    "succeeded",
  );
  assert.equal(
    configured.destination("environment-owner", "environment-run").kind,
    "installation",
  );
  wrongAccount = true;
  const nonce = new URL(
    shared.destination("charlie", "other-install").url,
  ).searchParams.get("state")!;
  await assert.rejects(
    adapter.callback(
      new URL(
        `http://127.0.0.1:4173/api/live/github/other-install/callback?state=${nonce}&installation_id=7`,
      ),
    ),
    /does not match/,
  );
  let recovery = other;
  const recoveryNonce = new URL(
    github.destination("bob", other.id).url,
  ).searchParams.get("state")!;
  lostConversion = true;
  recovery = await runtime.callback(
    "bob",
    other.id,
    new URL(
      `http://127.0.0.1:4173/api/live/github/${other.id}/callback?state=${recoveryNonce}&code=lost`,
    ),
  );
  assert.equal(recovery.step, "input");
  assert.equal(recovery.outcome, undefined);
  assert.ok(recovery.fields.some((field) => field.type === "password"));
  await assert.rejects(
    runtime.act("bob", other.id, {
      action: "submit",
      revision: recovery.revision,
      values: { appId: "42", privateKey: pem },
    }),
  );
  const secretRef = runtime.collect("bob", other.id, recovery.revision, {
    appId: "42",
    privateKey: pem,
  });
  const recovered = await runtime.act("bob", other.id, {
    action: "submit",
    revision: recovery.revision,
    secretRef,
  });
  assert.equal(recovered.step, "redirect");
  assert.equal(github.destination("bob", other.id).kind, "installation");
  assert.equal(calls.filter((url) => url.endsWith("/conversions")).length, 2);
  const before = db.keys("event:").length;
  assert.ok(before > 0);
  await assert.rejects(
    db.deliverEvents(async () => {
      throw new Error("offline");
    }),
  );
  assert.equal(db.keys("event:").length, before);
  assert.equal(
    await db.deliverEvents(async (event) => {
      assert.ok(!JSON.stringify(event).includes("sentinel"));
    }),
    before,
  );
  assert.equal(await db.deliverEvents(async () => {}), 0);
  db.close();
});

test("Agent2Human signs canonical intents, deduplicates delivery and rejects forged/replayed responses", async () => {
  const db = new CeremonyDatabase(":memory:", randomBytes(32));
  const agent = await generateKeyPair("EdDSA");
  const gateway = await generateKeyPair("EdDSA");
  let intent: Record<string, z.infer<ReturnType<typeof z.json>>> = {};
  let sends = 0;
  const a2h = new Agent2Human(db, {
    gatewayOrigin: "https://gateway.example",
    agentId: "did:web:ceremony.example",
    keyId: "agent",
    privateKey: agent.privateKey,
    gatewayKey: gateway.publicKey,
    apiKey: "private-gateway-key",
    recipient: () => ({
      principalId: "principal-alice",
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
      sends++;
      intent = JSON.parse(String(init?.body));
      return Response.json({ interaction_id: intent.interaction_id });
    },
  });
  const interaction = await a2h.authorize(
    "alice",
    "run",
    "https://ceremony.example/human/run",
  );
  assert.equal(
    await a2h.authorize("alice", "run", "https://ceremony.example/human/run"),
    interaction,
  );
  assert.equal(sends, 1);
  const payload = {
    type: "RESPONSE",
    message_id: "response-1",
    interaction_id: interaction,
    responds_to: intent.message_id!,
    principal_id: "principal-alice",
    decision: "APPROVE",
    decided_at: new Date().toISOString(),
    evidence: { factor: "otp.email.v1" },
  };
  const jws = await new CompactSign(Buffer.from(canonicalJson(payload)))
    .setProtectedHeader({ alg: "EdDSA" })
    .sign(gateway.privateKey);
  const [head, , signature] = jws.split(".");
  const response = { ...payload, signature: `${head}..${signature}` };
  await assert.rejects(
    a2h.receive("run", { ...response, principal_id: "mallory" }),
  );
  assert.equal(await a2h.receive("run", response), "verify");
  await assert.rejects(a2h.receive("run", response));
  assert.throws(() => canonicalJson(NaN));
  assert.equal(
    canonicalJson({ z: 1, a: [true, "x"] }),
    '{"a":[true,"x"],"z":1}',
  );
  assert.ok((await exportSPKI(agent.publicKey)).includes("PUBLIC KEY"));
  db.close();
});
