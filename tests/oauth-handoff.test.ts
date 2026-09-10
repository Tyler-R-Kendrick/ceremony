import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { test, type TestContext } from "node:test";
import { z } from "zod";
import type { ActorContext } from "../src/core/operation-contracts.js";
import {
  ProtectedCommandService,
  type RunRecord,
} from "../src/server/commands.js";
import { DurableAuthorizationCode } from "../src/server/oauth-handoff.js";
import {
  SQLiteCeremonyStore,
  type AsyncCeremonyStore,
} from "../src/server/persistence/index.js";
import {
  OperationRegistry,
  type OperationContext,
} from "../src/server/recipes/registry.js";

const actor: ActorContext = {
  tenantId: "tenant",
  subjectId: "alice",
  sessionId: "session",
  actorKind: "human",
  capabilities: ["executor"],
};
const sessionSchema = z.strictObject({
  token: z.string().min(1),
  expires: z.number().int().positive(),
});
type Session = z.infer<typeof sessionSchema>;

async function fixture(t: TestContext, exchange?: () => Promise<Session>) {
  const store = new SQLiteCeremonyStore(":memory:", {
    current: "test",
    keys: { test: randomBytes(32) },
  });
  t.after(() => store.close());
  let fixedTime: number | undefined;
  // Keep real encrypted transactions; pin only the trusted expiry clock for exact-boundary assertions.
  const carrierStore: AsyncCeremonyStore = {
    transaction: (work) =>
      store.transaction((tx) =>
        work({ ...tx, now: async () => fixedTime ?? tx.now() }),
      ),
    close: () => store.close(),
  };
  let effects = 0,
    authorized = true;
  let context: OperationContext | undefined;
  let candidate: Session | undefined;
  const options = {
    provider: "jira",
    profile: "jira-3lo",
    operationId: "authorize",
    operationVersion: "1.0.0",
    sessionSchema,
    authorize: async () => {
      if (!authorized) throw new Error("denied");
    },
    driver: async () => ({
      authorizationUrl: (state: string) =>
        `https://provider.example/authorize?state=${state}`,
      validateCallback: (value: string, state: string) => {
        const url = new URL(value);
        if (
          url.origin !== "https://app.example" ||
          url.pathname !== "/callback" ||
          url.searchParams.getAll("state").length !== 1 ||
          url.searchParams.get("state") !== state ||
          url.searchParams.getAll("code").length !== 1 ||
          !url.searchParams.get("code")
        )
          throw new Error("invalid callback");
      },
      exchange: async () => {
        effects++;
        return exchange
          ? exchange()
          : { token: "synthetic-private-token", expires: Date.now() + 60000 };
      },
    }),
    expiresAt: (session: Session) => session.expires,
  };
  let carrier = new DurableAuthorizationCode(carrierStore, options);
  const registry = new OperationRegistry();
  registry.register({
    contract: {
      id: "authorize",
      version: "1.0.0",
      provider: "jira",
      profile: "jira-3lo",
      inputs: {},
      outputs: {},
      effects: ["read"],
      verifier: "provider",
      humanFallback: "provider-consent",
    },
    inputSchema: z.strictObject({}),
    outputSchema: z.strictObject({}),
    classifications: {},
    fixtures: ["synthetic-lifecycle"],
    handler: async (ctx) => {
      context = ctx;
      await carrier.prepare(ctx);
      const result = await carrier.exchange(ctx);
      if (result.state === "issued") candidate = result.session;
      // Receiving a token is deliberately not proof of an authenticated connection.
      return {
        state: result.state === "issued" ? "verifying" : result.state,
        outputs: {},
      };
    },
  });
  const commands = new ProtectedCommandService(
    store,
    registry,
    async () => authorized,
  );
  const run = await commands.createRun(
    actor,
    {
      provider: "jira",
      profile: "jira-3lo",
      target: "site",
      origin: "https://app.example",
      environment: "test",
      configurationVersion: "v1",
    },
    [
      {
        id: "auth",
        operationId: "authorize",
        operationVersion: "1.0.0",
        dependsOn: [],
        bindings: {},
      },
    ],
    {},
  );
  let command = 0;
  const advance = async () =>
    commands.advance(
      actor,
      run.id,
      "auth",
      (await commands.snapshot(actor, run.id)).revision,
      `command-${++command}`,
    );
  await advance();
  assert.ok(context);
  const ctx = context;
  return {
    store,
    commands,
    run,
    ctx,
    advance,
    carrier: () => carrier,
    reload: () => {
      carrier = new DurableAuthorizationCode(carrierStore, options);
    },
    freezeTime: (value: number) => {
      fixedTime = value;
    },
    effects: () => effects,
    candidate: () => candidate,
    revoke: () => {
      authorized = false;
    },
    callback: async () => {
      const url = new URL(await carrier.humanUrl(ctx));
      return new URL(
        `https://app.example/callback?state=${url.searchParams.get("state")}&code=synthetic-code`,
      );
    },
  };
}

test("OAuth handoff admits a private callback once and reuses durable output without certifying access", async (t) => {
  const f = await fixture(t);
  const callback = await f.callback();
  assert.deepEqual(await f.carrier().resolve(actor, callback), {
    runId: f.run.id,
    nodeId: "auth",
  });
  for (const changed of [
    { subjectId: "other" },
    { sessionId: "other" },
    { tenantId: "other" },
    { actorKind: "agent" as const },
  ])
    await assert.rejects(
      f.carrier().resolve({ ...actor, ...changed }, callback),
    );
  for (const changed of [
    { subjectId: "other" },
    { actorKind: "agent" as const },
  ]) {
    await assert.rejects(
      f.carrier().humanUrl({ ...f.ctx, actor: { ...actor, ...changed } }),
    );
    await assert.rejects(
      f
        .carrier()
        .acceptCallback(
          { ...f.ctx, actor: { ...actor, ...changed } },
          callback,
        ),
    );
  }
  for (const bad of [
    new URL(callback.href.replace("app.example", "wrong.example")),
    new URL(callback.href.replace("state=", "state=wrong")),
  ])
    await assert.rejects(f.carrier().acceptCallback(f.ctx, bad));
  assert.equal(f.effects(), 0);
  await f.carrier().acceptCallback(f.ctx, callback);
  assert.equal(f.effects(), 0);
  await assert.rejects(f.carrier().acceptCallback(f.ctx, callback));
  await assert.rejects(f.carrier().resolve(actor, callback));
  await f.advance();
  assert.equal(f.effects(), 1);
  assert.ok(f.candidate());
  f.reload();
  await f.advance();
  assert.equal(f.effects(), 1);
  const snapshot = await f.commands.snapshot(actor, f.run.id);
  assert.equal(snapshot.nodes[0]!.state, "verifying");
  assert.equal(snapshot.nodes[0]!.verified, false);
  const publicRecords = await f.store.transaction(async (tx) => ({
    audit: await tx.list(actor.tenantId, "audit"),
    events: await tx.list(actor.tenantId, "event"),
  }));
  for (const forbidden of [
    "synthetic-private-token",
    "synthetic-code",
    callback.searchParams.get("state")!,
  ])
    assert.equal(
      JSON.stringify({ snapshot, publicRecords }).includes(forbidden),
      false,
      "protected material must not reach public records",
    );
});

test("OAuth handoff rejects invalid driver output before persisting or returning it", async (t) => {
  const f = await fixture(t, async () => ({
    token: "",
    expires: Date.now() + 60000,
  }));
  await f.carrier().acceptCallback(f.ctx, await f.callback());
  await f.advance();
  assert.equal(f.candidate() === undefined, true);
  assert.equal(
    (await f.commands.snapshot(actor, f.run.id)).nodes[0]!.state,
    "uncertain",
  );
  const records = await f.store.transaction((tx) =>
    tx.list(actor.tenantId, "handoff"),
  );
  assert.equal(
    records.some((record) => Object.hasOwn(record.value as object, "session")),
    false,
  );
});

test("OAuth lost response cannot repeat a code; a current human can explicitly start fresh consent", async (t) => {
  const f = await fixture(t, async () => {
    throw new Error("synthetic transport loss");
  });
  const callback = await f.callback();
  await f.carrier().acceptCallback(f.ctx, callback);
  await f.advance();
  assert.equal(f.effects(), 1);
  await assert.rejects(f.advance());
  const revision = (await f.commands.snapshot(actor, f.run.id)).revision;
  await assert.rejects(f.carrier().restart(f.ctx, revision - 1));
  await assert.rejects(
    f
      .carrier()
      .restart({ ...f.ctx, actor: { ...actor, actorKind: "agent" } }, revision),
  );
  await f.carrier().restart(f.ctx, revision);
  assert.notEqual(
    (await f.callback()).searchParams.get("state"),
    callback.searchParams.get("state"),
  );
  await assert.rejects(f.carrier().acceptCallback(f.ctx, callback));
  await f.advance();
  assert.equal(f.effects(), 1);
});

for (const action of ["cancel", "revoke"] as const)
  test(
    `OAuth ${action} during exchange prevents late session persistence`,
    { timeout: 5000 },
    async (t) => {
      let entered!: () => void, release!: () => void;
      const started = new Promise<void>((resolve) => {
        entered = resolve;
      });
      const wait = new Promise<void>((resolve) => {
        release = resolve;
      });
      const f = await fixture(t, async () => {
        entered();
        await wait;
        return { token: "synthetic-late-token", expires: Date.now() + 60000 };
      });
      await f.carrier().acceptCallback(f.ctx, await f.callback());
      const pending = f.advance();
      const rejected = assert.rejects(pending);
      try {
        await started;
        if (action === "cancel")
          await f.commands.cancel(
            actor,
            f.run.id,
            (await f.commands.snapshot(actor, f.run.id)).revision,
          );
        else f.revoke();
      } finally {
        release();
      }
      await rejected;
      assert.equal(f.effects(), 1);
      assert.equal(f.candidate() === undefined, true);
      const records = await f.store.transaction((tx) =>
        tx.list(actor.tenantId, "handoff"),
      );
      assert.equal(
        JSON.stringify(records).includes("synthetic-late-token"),
        false,
      );
      await assert.rejects(f.carrier().humanUrl(f.ctx));
    },
  );

test("OAuth rejects mismatched context and a running command reassigned to another run", async (t) => {
  const f = await fixture(t);
  for (const changed of [
    { target: "other" },
    { origin: "https://other.example" },
    { configurationVersion: "v2" },
    { environment: "production" },
    { nodeId: "other" },
    { runId: "other" },
  ])
    await assert.rejects(f.carrier().humanUrl({ ...f.ctx, ...changed }));
  await assert.rejects(f.carrier().prepare(f.ctx)); // Completed command is not active authority.
  const key = {
    tenant: actor.tenantId,
    kind: "command" as const,
    id: f.ctx.commandId,
  };
  const original = await f.store.transaction((tx) =>
    tx.get<Record<string, unknown>>(key),
  );
  assert.ok(original);
  for (const changed of [
    { runId: "another-run" },
    { nodeId: "another-node" },
    { effectId: "another-effect" },
  ]) {
    await f.store.transaction(async (tx) => {
      const record = await tx.get(key);
      assert.ok(record);
      // Deliberate durable-record fault injection: each command binding must be checked independently.
      await tx.put(
        key,
        { ...original.value, state: "running", ...changed },
        record.revision,
      );
    });
    await assert.rejects(f.carrier().prepare(f.ctx));
    await assert.rejects(f.carrier().exchange(f.ctx));
  }
  assert.equal(f.effects(), 0);
});

test("OAuth exact expiry requires explicit fresh consent and removes the old state route", async (t) => {
  const f = await fixture(t);
  const original = await f.callback();
  await assert.rejects(
    f
      .carrier()
      .restart(f.ctx, (await f.commands.snapshot(actor, f.run.id)).revision),
  );
  const boundary = await f.store.transaction((tx) => tx.now());
  f.freezeTime(boundary);
  await f.store.transaction(async (tx) => {
    for (const record of await tx.list<Record<string, unknown>>(
      actor.tenantId,
      "handoff",
    ))
      await tx.put(
        { tenant: actor.tenantId, kind: "handoff", id: record.id },
        { ...record.value, expires: boundary },
        record.revision,
      );
  });
  await assert.rejects(f.carrier().resolve(actor, original));
  await assert.rejects(f.carrier().humanUrl(f.ctx));
  await assert.rejects(f.carrier().acceptCallback(f.ctx, original));
  await f.advance();
  assert.equal(f.effects(), 0);
  await f
    .carrier()
    .restart(f.ctx, (await f.commands.snapshot(actor, f.run.id)).revision);
  const fresh = await f.callback();
  assert.notEqual(
    fresh.searchParams.get("state"),
    original.searchParams.get("state"),
  );
  await assert.rejects(f.carrier().resolve(actor, original));
  await f.carrier().acceptCallback(f.ctx, fresh);
  await f.advance();
  assert.equal(f.effects(), 1);
});

test("OAuth human handoff cannot bypass an unverified prerequisite", async (t) => {
  const f = await fixture(t);
  const runKey = { tenant: actor.tenantId, kind: "run" as const, id: f.run.id };
  const nodeKey = {
    tenant: actor.tenantId,
    kind: "node" as const,
    id: `${f.run.id}:setup`,
  };
  await f.store.transaction(async (tx) => {
    const record = await tx.get<RunRecord>(runKey);
    assert.ok(record);
    await tx.put(
      runKey,
      {
        ...record.value,
        nodes: record.value.nodes.map((node) => ({
          ...node,
          dependsOn: ["setup"],
        })),
      },
      record.revision,
    );
  });
  await assert.rejects(f.carrier().humanUrl(f.ctx));
  for (const value of [
    { state: "complete", verified: false },
    { state: "awaiting-human", verified: true },
    { state: "complete", verified: true },
  ]) {
    await f.store.transaction(async (tx) => {
      const record = await tx.get(nodeKey);
      await tx.put(nodeKey, value, record?.revision ?? null);
    });
    if (value.verified && value.state === "complete")
      await f.carrier().humanUrl(f.ctx);
    else await assert.rejects(f.carrier().humanUrl(f.ctx));
  }
  assert.equal(f.effects(), 0);
});
