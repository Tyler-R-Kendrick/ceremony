import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { createServer } from "node:http";
import { once } from "node:events";
import { randomBytes, randomUUID } from "node:crypto";
import { SignJWT, jwtVerify } from "jose";
import {
  AsyncSupabaseChildren,
  supabaseConnectionRecipe,
  supabaseVocabulary,
} from "../src/server/recipes/supabase.js";
import {
  OperationRegistry,
  type OperationContext,
} from "../src/server/recipes/registry.js";
import { SQLiteCeremonyStore } from "../src/server/persistence/index.js";
import { createTeachingRuntime } from "../src/server/teaching-runtime.js";
import type { ActorContext } from "../src/core/operation-contracts.js";
import type { RunRecord } from "../src/server/commands.js";

async function fixture(
  t: TestContext,
  requiredAssurance: "aal1" | "aal2" = "aal1",
) {
  const key = randomBytes(32);
  const token = await new SignJWT({ aal: "aal1" })
    .setProtectedHeader({ alg: "HS256" })
    .setSubject("fixture-user")
    .setExpirationTime("1h")
    .sign(key);
  const elevated = await new SignJWT({ aal: "aal2" })
    .setProtectedHeader({ alg: "HS256" })
    .setSubject("fixture-user")
    .setExpirationTime("1h")
    .sign(key);
  const factorId = randomUUID(),
    challengeId = randomUUID();
  const state = {
    confirmed: false,
    loseSignup: false,
    revoked: false,
    signups: 0,
    signins: 0,
    verifications: 0,
    version: "v1",
    challenges: 0,
    mfaVerifications: 0,
    loseMfa: false,
  };
  const server = createServer(async (req, res) => {
    res.setHeader("content-type", "application/json");
    if (req.url === "/auth/v1/user") {
      state.verifications++;
      await jwtVerify(req.headers.authorization!.slice(7), key);
      res.statusCode = state.revoked ? 401 : 200;
      res.end(
        JSON.stringify(
          state.revoked
            ? { message: "private-provider-error" }
            : {
                id: "fixture-user",
                factors: [
                  { id: factorId, factor_type: "totp", status: "verified" },
                ],
              },
        ),
      );
      return;
    }
    assert.equal(req.method, "POST");
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString());
    if (req.url === `/auth/v1/factors/${factorId}/challenge`) {
      await jwtVerify(req.headers.authorization!.slice(7), key);
      state.challenges++;
      res.end(
        JSON.stringify({
          id: challengeId,
          type: "totp",
          expires_at: Math.floor(Date.now() / 1000) + 300,
        }),
      );
      return;
    }
    if (req.url === `/auth/v1/factors/${factorId}/verify`) {
      await jwtVerify(req.headers.authorization!.slice(7), key);
      state.mfaVerifications++;
      assert.equal(body.challenge_id, challengeId);
      if (state.loseMfa) {
        res.destroy();
        return;
      }
      if (body.code !== "123456") {
        res.statusCode = 400;
        res.end(JSON.stringify({ message: "private-provider-error" }));
      } else
        res.end(
          JSON.stringify({
            access_token: elevated,
            refresh_token: "synthetic-refresh",
            expires_in: 3600,
            token_type: "bearer",
            user: { id: "fixture-user" },
          }),
        );
      return;
    }
    assert.equal(
      body.email === "user@example.com" &&
        body.password === "synthetic-password",
      true,
    );
    if (req.url === "/auth/v1/signup") {
      state.signups++;
      if (state.loseSignup) {
        res.destroy();
        return;
      }
      res.end(JSON.stringify({ id: "fixture-user" }));
    } else {
      assert.equal(req.url, "/auth/v1/token?grant_type=password");
      state.signins++;
      if (!state.confirmed) {
        res.statusCode = 400;
        res.end(
          JSON.stringify({
            code: "email_not_confirmed",
            msg: "private-provider-error",
          }),
        );
      } else
        res.end(
          JSON.stringify({
            access_token: token,
            refresh_token: "synthetic-refresh",
            expires_in: 3600,
            token_type: "bearer",
            user: { id: "fixture-user" },
          }),
        );
    }
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  t.after(
    () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  );
  const store = new SQLiteCeremonyStore(":memory:", {
    current: "fixture",
    keys: { fixture: randomBytes(32) },
  });
  t.after(() => store.close());
  const actor: ActorContext = {
    tenantId: "tenant",
    subjectId: "subject",
    sessionId: "session",
    actorKind: "human",
    capabilities: ["executor", "author", "reviewer", "publisher"],
  };
  const context = {
    provider: "supabase",
    profile: "supabase-password",
    target: "self",
    origin: "https://app.example",
    environment: "test",
    configurationVersion: "v1",
  };
  const options = {
    requiredAssurance,
    configuration: async () => ({ version: state.version }),
    authorize: async () => {},
    fetch: (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      const url = new URL(String(input));
      assert.equal(url.origin, "https://synthetic.supabase.co");
      return fetch(
        `http://127.0.0.1:${address.port}${url.pathname}${url.search}`,
        init,
      );
    },
  };
  const children = new AsyncSupabaseChildren(store, options);
  const registry = new OperationRegistry(supabaseVocabulary);
  children.register(registry);
  const runtime = createTeachingRuntime({
    store,
    registry,
    identity: { authenticate: async () => actor },
    origin: context.origin,
    context: async () => context,
    authorize: async (actor, run) =>
      actor.subjectId === run.subjectId &&
      run.configurationVersion === state.version,
    connections: new Map([
      [
        "supabase",
        {
          definition: supabaseConnectionRecipe,
          outputContract: "supabase.connection",
          revalidateOperation: "supabase.verify-access",
        },
      ],
    ]),
  });
  const inputContext = (runId: string, nodeId: string): OperationContext => ({
    actor,
    ...context,
    runId,
    nodeId,
    commandId: `human:${randomUUID()}`,
    effectId: "human",
    signal: AbortSignal.timeout(30000),
  });
  const advance = async (runId: string, nodeId: string) => {
    const snapshot = await runtime.commands.snapshot(actor, runId);
    return runtime.commands.advance(
      actor,
      runId,
      nodeId,
      snapshot.revision,
      `step:${randomUUID()}`,
    );
  };
  const input = async (runId: string, nodeId: string, value: unknown) => {
    const snapshot = await runtime.commands.snapshot(actor, runId);
    await children.humanInput(
      inputContext(runId, nodeId),
      snapshot.revision,
      value,
    );
  };
  return {
    store,
    state,
    actor,
    runtime,
    children,
    advance,
    input,
    inputContext,
    token,
    factorId,
  };
}
const project = {
  projectUrl: "https://synthetic.supabase.co",
  publishableKey: "sb_publishable_synthetic",
};
const credentials = {
  action: "sign-up",
  email: "user@example.com",
  password: "synthetic-password",
};

for (const loseSignup of [false, true])
  test(`Supabase children ${loseSignup ? "recover a lost signup response without repeating creation" : "compose setup, confirmed signup and verified access"}`, async (t) => {
    const f = await fixture(t);
    f.state.loseSignup = loseSignup;
    const run = await f.runtime.connect(f.actor, "supabase");
    assert.equal((await f.advance(run.id, "project")).state, "awaiting-human");
    await assert.rejects(f.advance(run.id, "session"), /denied/);
    await f.input(run.id, "project", project);
    assert.equal((await f.advance(run.id, "project")).state, "complete");
    assert.equal((await f.advance(run.id, "session")).state, "awaiting-human");
    await f.input(run.id, "session", credentials);
    assert.equal(
      (await f.advance(run.id, "session")).state,
      loseSignup ? "uncertain" : "awaiting-human",
    );
    assert.equal(f.state.signups, 1);
    assert.deepEqual(
      await f.children.humanView(f.inputContext(run.id, "session")),
      loseSignup
        ? { mode: "credentials", allowSignup: false }
        : { mode: "confirmation" },
    );
    await assert.rejects(f.advance(run.id, "access"), /denied/);
    await f.input(run.id, "session", { confirmed: true });
    assert.equal((await f.advance(run.id, "session")).state, "awaiting-human");
    assert.equal(
      (await f.runtime.commands.snapshot(f.actor, run.id)).status,
      "active",
    );
    f.state.confirmed = true;
    await f.input(run.id, "session", { confirmed: true });
    assert.equal((await f.advance(run.id, "session")).state, "complete");
    assert.equal(f.state.signups, 1);
    assert.equal(f.state.verifications, 0);
    assert.equal((await f.advance(run.id, "access")).state, "complete");
    const done = await f.runtime.commands.snapshot(f.actor, run.id);
    assert.equal(done.status, "complete");
    assert.equal(
      /synthetic-password|synthetic-refresh|private-provider-error/.test(
        JSON.stringify(done),
      ),
      false,
    );
    assert.equal(JSON.stringify(done).includes(f.token), false);
    assert.equal((await f.runtime.connect(f.actor, "supabase")).id, run.id);
    assert.equal(f.state.verifications, 2);
    assert.equal(f.state.signups, 1);
    f.state.revoked = true;
    assert.equal(
      (await f.runtime.connect(f.actor, "supabase")).status,
      "active",
    );
    assert.equal((await f.advance(run.id, "access")).state, "awaiting-human");
    await f.input(run.id, "access", { ...credentials, action: "sign-in" });
    f.state.revoked = false;
    assert.equal((await f.advance(run.id, "session")).state, "complete");
    assert.equal((await f.advance(run.id, "access")).state, "complete");
    assert.equal(f.state.signups, 1);
  });

test("Supabase children reject foreign actors, source impersonation, wrong stages and stale configuration", async (t) => {
  const f = await fixture(t),
    run = await f.runtime.connect(f.actor, "supabase");
  await f.advance(run.id, "project");
  const snapshot = await f.runtime.commands.snapshot(f.actor, run.id),
    context = f.inputContext(run.id, "project");
  for (const actor of [
    { ...f.actor, actorKind: "agent" as const },
    { ...f.actor, subjectId: "other" },
    { ...f.actor, sessionId: "other" },
    { ...f.actor, tenantId: "other" },
  ]) {
    await assert.rejects(f.children.humanView({ ...context, actor }), /denied/);
    await assert.rejects(
      f.children.humanInput({ ...context, actor }, snapshot.revision, project),
      /denied/,
    );
  }
  await assert.rejects(f.input(run.id, "project", credentials), /denied/);
  await assert.rejects(
    f.children.humanInput(context, snapshot.revision + 1, project),
    /denied/,
  );
  await assert.rejects(
    f.input(run.id, "project", { ...project, source: "ui" }),
    /invalid_request/,
  );
  f.state.version = "v2";
  await assert.rejects(f.input(run.id, "project", project), /denied/);
  assert.equal(f.state.signups, 0);
  assert.equal(f.state.signins, 0);
});

for (const loseMfa of [false, true])
  test(`Supabase durable MFA ${loseMfa ? "does not replay a code after a lost response" : "resumes the same parent after private authenticator input"}`, async (t) => {
    const f = await fixture(t, "aal2");
    f.state.confirmed = true;
    const run = await f.runtime.connect(f.actor, "supabase");
    await f.advance(run.id, "project");
    await f.input(run.id, "project", project);
    await f.advance(run.id, "project");
    await f.advance(run.id, "session");
    await assert.rejects(
      f.input(run.id, "session", { factorId: f.factorId, code: "123456" }),
      /denied/,
    );
    await f.input(run.id, "session", { ...credentials, action: "sign-in" });
    await f.advance(run.id, "session");
    assert.equal((await f.advance(run.id, "access")).state, "awaiting-human");
    assert.equal(f.state.challenges, 0);
    const before = await f.runtime.commands.snapshot(f.actor, run.id);
    await assert.rejects(
      f.children.humanInput(
        {
          ...f.inputContext(run.id, "access"),
          actor: { ...f.actor, actorKind: "agent" },
        },
        before.revision,
        { factorId: f.factorId, code: "123456" },
      ),
      /denied/,
    );
    await f.input(run.id, "access", { factorId: f.factorId, code: "654321" });
    assert.equal((await f.advance(run.id, "access")).state, "awaiting-human");
    assert.equal(f.state.mfaVerifications, 1);
    assert.equal((await f.advance(run.id, "access")).state, "awaiting-human");
    assert.equal(f.state.mfaVerifications, 1);
    f.state.loseMfa = loseMfa;
    await f.input(run.id, "access", { factorId: f.factorId, code: "123456" });
    assert.equal(
      (await f.advance(run.id, "access")).state,
      loseMfa ? "uncertain" : "complete",
    );
    if (loseMfa) {
      await assert.rejects(f.advance(run.id, "access"), /denied/);
      assert.equal(f.state.mfaVerifications, 2);
      f.state.loseMfa = false;
      await f.input(run.id, "access", { factorId: f.factorId, code: "123456" });
      assert.equal((await f.advance(run.id, "access")).state, "complete");
    }
    const done = await f.runtime.commands.snapshot(f.actor, run.id);
    assert.equal(done.status, "complete");
    assert.equal(
      /123456|654321|synthetic-refresh|factorId/.test(JSON.stringify(done)),
      false,
    );
    assert.equal(f.state.signups, 0);
    assert.equal(f.state.signins, 1);
    assert.equal((await f.runtime.connect(f.actor, "supabase")).id, run.id);
  });

test("Parallel Supabase parents cannot replace a shared project binding before another parent's credential exchange", async (t) => {
  const f = await fixture(t),
    first = await f.runtime.connect(f.actor, "supabase");
  const record = await f.store.transaction((tx) =>
    tx.get<RunRecord>({ tenant: f.actor.tenantId, kind: "run", id: first.id }),
  );
  assert.ok(record);
  const second = await f.runtime.commands.createRun(
    f.actor,
    record.value,
    record.value.nodes,
    {},
  );
  await f.advance(first.id, "project");
  await f.advance(second.id, "project");
  await f.input(first.id, "project", project);
  for (const changed of [
    { ...project, projectUrl: "https://different.supabase.co" },
    { ...project, publishableKey: "sb_publishable_different" },
  ])
    await assert.rejects(f.input(second.id, "project", changed), /denied/);
  await f.input(second.id, "project", project);
  assert.equal((await f.advance(first.id, "project")).state, "complete");
  assert.equal((await f.advance(second.id, "project")).state, "complete");
  assert.equal(f.state.signins + f.state.signups + f.state.verifications, 0);
});
