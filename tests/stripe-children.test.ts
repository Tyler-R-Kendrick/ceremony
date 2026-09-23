import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { test, type TestContext } from "node:test";
import { AsyncStripeChildren } from "../src/server/recipes/stripe.js";
import type { OperationContext } from "../src/server/recipes/registry.js";
import { createGitHubRuntime } from "../src/server/github-runtime.js";
import { teachingHttp } from "../src/server/teaching-http.js";
import { SQLiteCeremonyStore } from "../src/server/persistence/index.js";
import type { ActorContext } from "../src/core/operation-contracts.js";
import type { RunPlanNode, RunRecord } from "../src/server/commands.js";
import { AgentCoordinator } from "../src/server/agent/coordinator.js";

async function fixture(t: TestContext, configured = false) {
  const token = `rk_test_${randomBytes(24).toString("hex")}`;
  let reads = 0;
  const behavior = { revoked: false, live: false, version: "v1", configured };
  const server = createServer((req, res) => {
    reads++;
    assert.equal(req.method, "GET");
    assert.equal(req.url, "/v1/balance");
    assert.ok(
      req.headers.authorization === `Bearer ${token}`,
      "SDK must carry the key only to the provider",
    );
    res.setHeader("content-type", "application/json");
    res.statusCode = behavior.revoked ? 401 : 200;
    res.end(
      JSON.stringify(
        behavior.revoked
          ? {
              error: {
                message: "provider-body-must-not-escape",
                type: "authentication_error",
              },
            }
          : {
              object: "balance",
              livemode: behavior.live,
              available: [],
              pending: [],
            },
      ),
    );
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  t.after(
    () =>
      new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      ),
  );
  const store = new SQLiteCeremonyStore(":memory:", {
    current: "test",
    keys: { test: randomBytes(32) },
  });
  t.after(() => store.close());
  const actor: ActorContext = {
    tenantId: "tenant",
    subjectId: "alice",
    sessionId: "session",
    actorKind: "human",
    capabilities: ["executor", "author", "reviewer", "publisher"],
  };
  const context = {
    provider: "stripe",
    profile: "stripe-api-key",
    target: "self",
    origin: "https://app.example",
    environment: "test",
    configurationVersion: "v1",
  };
  const options = {
    configuration: async () => ({
      version: behavior.version,
      ...(behavior.configured ? { token } : {}),
    }),
    authorize: async (ctx: OperationContext) => {
      const run = await store.transaction((tx) =>
        tx.get<RunRecord>({
          tenant: ctx.actor.tenantId,
          kind: "run",
          id: ctx.runId,
        }),
      );
      if (
        !run ||
        run.value.subjectId !== ctx.actor.subjectId ||
        run.value.status === "cancelled"
      )
        throw new Error("denied");
    },
    fetch: async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      const url = new URL(String(input));
      assert.equal(url.origin, "https://api.stripe.com");
      return fetch(
        `http://127.0.0.1:${address.port}${url.pathname}${url.search}`,
        init,
      );
    },
  };
  const children = new AsyncStripeChildren(store, options);
  // Who the mounted routes see, and every view of a run the host authorized.
  const session = { actor };
  const authorized: {
    operationId: string;
    provider: string;
    scope?: string;
  }[] = [];
  const runtime = createGitHubRuntime({
    store,
    identity: { authenticate: async () => session.actor },
    origin: context.origin,
    environment: context.environment,
    configurationVersion: "v1",
    stripe: { configuration: options.configuration, fetch: options.fetch },
    allowTarget: async () => true,
    authorize: async (subject, run, operationId) => {
      authorized.push({
        operationId,
        provider: run.provider,
        ...(run.scope ? { scope: run.scope.connectorId } : {}),
      });
      return subject.subjectId === run.subjectId;
    },
  });
  const advance = async (runId: string, nodeId: string) => {
    const run = await runtime.commands.snapshot(actor, runId);
    return runtime.commands.advance(
      actor,
      runId,
      nodeId,
      run.revision,
      `step:${randomUUID()}`,
    );
  };
  const inputContext = (runId: string, nodeId: string): OperationContext => ({
    actor,
    ...context,
    runId,
    nodeId,
    commandId: `human:${randomUUID()}`,
    effectId: "human",
    signal: AbortSignal.timeout(30000),
  });
  const input = async (runId: string, nodeId: string, value: unknown) => {
    const run = await runtime.commands.snapshot(actor, runId);
    await children.humanInput(inputContext(runId, nodeId), run.revision, value);
  };
  return {
    store,
    actor,
    runtime,
    children,
    inputContext,
    advance,
    input,
    token,
    behavior,
    session,
    authorized,
    reads: () => reads,
  };
}

test("Stripe account setup precedes private key collection; only a real SDK Balance read completes access", async (t) => {
  const f = await fixture(t);
  const run = await f.runtime.connect(f.actor, "stripe");
  assert.equal((await f.advance(run.id, "account")).state, "awaiting-human");
  await assert.rejects(f.advance(run.id, "credential"), /denied/);
  await assert.rejects(f.advance(run.id, "access"), /denied/);
  assert.equal(f.reads(), 0);
  await f.input(run.id, "account", { accountReady: true });
  assert.equal((await f.advance(run.id, "account")).state, "complete");
  assert.equal((await f.advance(run.id, "credential")).state, "awaiting-human");
  assert.equal(
    (await f.runtime.commands.snapshot(f.actor, run.id)).status,
    "active",
  );
  assert.equal(
    f.reads(),
    0,
    "Account acknowledgment must not imply authenticated API access",
  );
  await f.input(run.id, "credential", { token: f.token });
  assert.equal((await f.advance(run.id, "credential")).state, "complete");
  assert.equal((await f.advance(run.id, "access")).state, "complete");
  assert.equal(f.reads(), 1);
  const snapshot = await f.runtime.commands.snapshot(f.actor, run.id);
  assert.equal(snapshot.status, "complete");
  assert.ok(
    !JSON.stringify(snapshot).includes(f.token),
    "Public state must exclude credentials",
  );
  const reused = await f.runtime.connect(f.actor, "stripe");
  assert.equal(reused.id, run.id);
  assert.equal(reused.status, "complete");
  assert.equal(
    f.reads(),
    2,
    "Reuse checks current provider access without setup or model work",
  );
  f.behavior.revoked = true;
  const revoked = await f.runtime.connect(f.actor, "stripe");
  assert.equal(revoked.status, "active");
  assert.equal(revoked.nodes.find((n) => n.id === "access")?.verified, false);
  assert.ok(!JSON.stringify(revoked).includes("provider-body-must-not-escape"));
  assert.equal((await f.advance(run.id, "access")).state, "awaiting-human");
  f.behavior.revoked = false;
  await f.input(run.id, "access", { token: f.token });
  assert.equal((await f.advance(run.id, "access")).state, "complete");
});

test("Stripe configured keys skip human setup but never bypass mode or provider verification", async (t) => {
  const f = await fixture(t, true);
  const run = await f.runtime.connect(f.actor, "stripe");
  assert.equal((await f.advance(run.id, "account")).state, "complete");
  assert.equal((await f.advance(run.id, "credential")).state, "complete");
  f.behavior.live = true;
  assert.notEqual((await f.advance(run.id, "access")).state, "complete");
  assert.equal(
    (await f.runtime.commands.snapshot(f.actor, run.id)).status,
    "active",
  );
  f.behavior.version = "v2";
  await assert.rejects(f.advance(run.id, "access"), /denied/);
  assert.equal(
    f.reads(),
    1,
    "Configuration rotation must reject before another provider request",
  );
});

test("Stripe native input rejects forged actor, wrong stage, foreign context, stale revision, extras and cancellation", async (t) => {
  const f = await fixture(t);
  const run = await f.runtime.connect(f.actor, "stripe");
  await f.advance(run.id, "account");
  const current = await f.runtime.commands.snapshot(f.actor, run.id);
  const context = f.inputContext(run.id, "account");
  for (const actor of [
    { ...f.actor, actorKind: "agent" as const },
    { ...f.actor, subjectId: "mallory" },
  ])
    await assert.rejects(
      f.children.humanInput({ ...context, actor }, current.revision, {
        accountReady: true,
      }),
      /denied/,
    );
  await assert.rejects(
    f.children.humanInput(context, current.revision - 1, {
      accountReady: true,
    }),
    /denied/,
  );
  for (const value of [
    { accountReady: true, token: f.token },
    { token: f.token },
    { accountReady: false },
    { endpoint: "https://attacker.example" },
  ])
    await assert.rejects(
      f.children.humanInput(context, current.revision, value),
    );
  await f.runtime.commands.cancel(f.actor, run.id, current.revision);
  await assert.rejects(
    f.children.humanInput(context, current.revision, { accountReady: true }),
    /denied/,
  );
  assert.equal(f.reads(), 0);
  assert.equal(
    (await f.store.transaction((tx) => tx.list("tenant", "artifact"))).length,
    0,
  );
});

test("mounted Stripe HTTP guides account signup before isolated collection and resumes the original parent", async (t) => {
  const f = await fixture(t);
  const call = (path: string, body?: unknown) =>
    teachingHttp(
      new Request(
        `https://app.example/api/v1/teaching${path}`,
        body === undefined
          ? {}
          : {
              method: "POST",
              headers: {
                origin: "https://app.example",
                "content-type": "application/json",
              },
              body: JSON.stringify(body),
            },
      ),
      f.runtime,
    );
  assert.equal(
    (await call("/runs", { connectorId: "stripe", target: "other-account" }))
      .status,
    403,
  );
  assert.equal(
    (await f.store.transaction((tx) => tx.list(f.actor.tenantId, "session")))
      .length,
    0,
  );
  const started = await call("/runs", { connectorId: "stripe", teach: true });
  assert.equal(started.status, 200);
  const run = await started.json();
  assert.equal(run.nodes[0].state, "awaiting-human");
  const path = `/stripe/${run.id}/human`;
  assert.equal((await call(`/github/${run.id}/human`)).status, 403);
  const page = await call(path);
  assert.equal(page.status, 200);
  assert.equal(page.headers.get("cache-control"), "no-store");
  assert.ok(
    page.headers
      .get("content-security-policy")
      ?.includes("frame-ancestors 'none'"),
  );
  const html = await page.text();
  assert.ok(html.includes("https://dashboard.stripe.com/register"));
  assert.ok(
    !html.includes('name="token"'),
    "The first human step is account setup, not a key prompt",
  );
  const ticket = /ticket:"([a-f0-9-]+)"/.exec(html)?.[1];
  assert.ok(ticket);
  assert.equal((await call(path, { ticket, accountReady: true })).status, 200);
  assert.equal((await call(path, { ticket, accountReady: true })).status, 403);
  assert.equal(f.reads(), 0);
  const collector = await (await call(path)).text();
  assert.ok(collector.includes('type="password"'));
  const privateTicket = /ticket:"([a-f0-9-]+)"/.exec(collector)?.[1];
  assert.ok(privateTicket);
  assert.equal(
    (await call(path, { ticket: privateTicket, token: f.token, source: "ui" }))
      .status,
    400,
  );
  const submitted = await call(path, { ticket: privateTicket, token: f.token });
  assert.equal(submitted.status, 200);
  const returned = await submitted.json();
  assert.equal(
    new URL(returned.returnUrl).searchParams.get("teachingRun"),
    run.id,
  );
  assert.equal(
    (await f.runtime.commands.snapshot(f.actor, run.id)).status,
    "complete",
  );
  assert.equal(f.reads(), 1);
  for (const kind of ["event", "demonstration", "audit", "outbox"] as const) {
    const records = await f.store.transaction((tx) =>
      tx.list(f.actor.tenantId, kind),
    );
    assert.ok(
      !JSON.stringify(records).includes(f.token),
      `${kind} must exclude the credential`,
    );
  }
});

test("Stripe handoff tickets bind each authority dimension and expire without provider effects", async (t) => {
  const f = await fixture(t);
  const call = (path: string, body?: unknown) =>
    teachingHttp(
      new Request(
        `https://app.example/api/v1/teaching${path}`,
        body === undefined
          ? { headers: { accept: "application/json" } }
          : {
              method: "POST",
              headers: {
                origin: "https://app.example",
                "content-type": "application/json",
              },
              body: JSON.stringify(body),
            },
      ),
      f.runtime,
    );
  const run = await (await call("/runs", { connectorId: "stripe" })).json();
  const path = `/stripe/${run.id}/human`;
  const { ticket, operationId } = await (await call(path)).json();
  assert.equal(operationId, "stripe.prepare-account");
  assert.equal(
    (await call(path, { ticket: randomUUID(), accountReady: true })).status,
    403,
  );
  const key = {
    tenant: f.actor.tenantId,
    kind: "handoff" as const,
    id: `stripe-collector:${ticket}`,
  };
  const original = await f.store.transaction((tx) =>
    tx.get<Record<string, unknown>>(key),
  );
  assert.ok(original);
  for (const patch of [
    { subject: "other" },
    { session: "other" },
    { runId: "other" },
    { nodeId: "other" },
    { revision: -1 },
    { expires: 0 },
  ]) {
    await f.store.transaction(async (tx) => {
      const current = await tx.get(key);
      await tx.put(key, { ...original.value, ...patch }, current!.revision);
    });
    assert.equal(
      (await call(path, { ticket, accountReady: true })).status,
      403,
    );
  }
  await f.store.transaction(async (tx) => {
    const current = await tx.get(key);
    await tx.put(key, original.value, current!.revision);
  });
  assert.equal((await call(path, { ticket, accountReady: true })).status, 200);
  const fresh = await (await call(path)).json();
  assert.equal(fresh.operationId, "stripe.obtain-key");
  assert.equal(
    (await call(path, { ticket: fresh.ticket, token: "pk_test_invalid" }))
      .status,
    400,
  );
  assert.equal(f.reads(), 0);
  assert.equal(
    (await call(path, { ticket: fresh.ticket, token: f.token })).status,
    200,
  );
  assert.equal(f.reads(), 1);
  assert.equal((await call(path)).status, 403);
});

test("Stripe rejects changed execution context and aborted work before transport", async (t) => {
  const f = await fixture(t);
  const run = await f.runtime.connect(f.actor, "stripe");
  const context = f.inputContext(run.id, "account");
  for (const patch of [
    { target: "other" },
    { origin: "https://other.example" },
    { environment: "production" },
    { configurationVersion: "other" },
    { signal: AbortSignal.abort() },
  ])
    await assert.rejects(f.children.prepareAccount({ ...context, ...patch }));
  await assert.rejects(
    f.children.obtainKey(context, "foreign-artifact"),
    /denied/,
  );
  await assert.rejects(f.children.obtainKey(context, undefined), /denied/);
  await assert.rejects(f.children.verifyAccess(context, undefined), /denied/);
  assert.equal(f.reads(), 0);
});

test("GitHub target syntax remains enforced when host target policy is permissive", async (t) => {
  const f = await fixture(t);
  for (const target of ["!allowed", "allowed!", "a".repeat(101), ""])
    await assert.rejects(f.runtime.selectTarget!(f.actor, target), /denied/);
  assert.equal(
    (await f.store.transaction((tx) => tx.list(f.actor.tenantId, "session")))
      .length,
    0,
  );
  await f.runtime.selectTarget!(f.actor, "allowed");
  assert.equal(
    (await f.store.transaction((tx) => tx.list(f.actor.tenantId, "session")))
      .length,
    1,
  );
  assert.equal(f.reads(), 0);
});

test("a Stripe step planned under its own connector runs inside another provider's run", async (t) => {
  const f = await fixture(t, true);
  // A version of its own, so nothing passes by matching the run's.
  f.behavior.version = "stripe-v2";
  const stripe = {
    connectorId: "stripe",
    provider: "stripe",
    profile: "stripe-api-key",
    target: "self",
    origin: "https://app.example",
    environment: "test",
    configurationVersion: "stripe-v2",
  };
  const run = await f.runtime.commands.createRun(
    f.actor,
    {
      provider: "github",
      profile: "github-app",
      target: "acme",
      origin: "https://app.example",
      environment: "test",
      configurationVersion: "v1",
    },
    [
      {
        id: "account",
        operationId: "stripe.prepare-account",
        operationVersion: "1.0.0",
        dependsOn: [],
        bindings: {},
        context: stripe,
      },
      {
        id: "credential",
        operationId: "stripe.obtain-key",
        operationVersion: "1.0.0",
        dependsOn: ["account"],
        bindings: {
          account: { from: "output", node: "account", name: "account" },
        },
        context: stripe,
      },
      {
        id: "access",
        operationId: "stripe.verify-access",
        operationVersion: "1.0.0",
        dependsOn: ["credential"],
        bindings: {
          credential: {
            from: "output",
            node: "credential",
            name: "credential",
          },
        },
        context: stripe,
      },
    ],
    {},
  );
  // Each step is checked against the connector it was planned under, not
  // the run's own provider.
  assert.equal((await f.advance(run.id, "account")).state, "complete");
  assert.equal((await f.advance(run.id, "credential")).state, "complete");
  assert.equal((await f.advance(run.id, "access")).state, "complete");
  assert.equal(f.reads(), 1);
  // And a step that claims a node it is not is still refused.
  await assert.rejects(
    f.children.prepareAccount({
      ...f.inputContext(run.id, "account"),
      configurationVersion: "stripe-v2",
      nodeId: "not-a-node",
    }),
    /denied/,
  );
});

test("a person completes a Stripe step waiting inside a GitHub run on Stripe's own page", async (t) => {
  const f = await fixture(t);
  // A version of its own, so nothing passes by matching the run's.
  f.behavior.version = "stripe-v2";
  const stripe = {
    connectorId: "stripe",
    provider: "stripe",
    profile: "stripe-api-key",
    target: "self",
    origin: "https://app.example",
    environment: "test",
    configurationVersion: "stripe-v2",
  };
  const nodes: RunPlanNode[] = [
    {
      id: "account",
      operationId: "stripe.prepare-account",
      operationVersion: "1.0.0",
      dependsOn: [],
      bindings: {},
      context: stripe,
    },
    {
      id: "credential",
      operationId: "stripe.obtain-key",
      operationVersion: "1.0.0",
      dependsOn: ["account"],
      bindings: {
        account: { from: "output", node: "account", name: "account" },
      },
      context: stripe,
    },
    {
      id: "access",
      operationId: "stripe.verify-access",
      operationVersion: "1.0.0",
      dependsOn: ["credential"],
      bindings: {
        credential: { from: "output", node: "credential", name: "credential" },
      },
      context: stripe,
    },
  ];
  const run = await f.runtime.commands.createRun(
    f.actor,
    {
      provider: "github",
      profile: "github-app",
      target: "acme",
      origin: "https://app.example",
      environment: "test",
      configurationVersion: "v1",
    },
    nodes,
    {},
  );
  const call = (path: string, body?: unknown) =>
    teachingHttp(
      new Request(
        `https://app.example/api/v1/teaching${path}`,
        body === undefined
          ? {}
          : {
              method: "POST",
              headers: {
                origin: "https://app.example",
                "content-type": "application/json",
              },
              body: JSON.stringify(body),
            },
      ),
      f.runtime,
    );
  const path = `/stripe/${run.id}/human`;
  // A step that is not yet waiting on a person has no page.
  assert.equal((await call(path)).status, 403);
  assert.equal((await f.advance(run.id, "account")).state, "awaiting-human");

  // The agent's hand-off names the waiting step's provider, not the run's.
  const coordinator = new AgentCoordinator(f.store, f.runtime.commands);
  const outcome = await coordinator.turnOutcome(f.actor, run.id, "turn-1");
  assert.equal(outcome.status, "awaiting-human");
  assert.equal(
    outcome.handoff?.path,
    `/api/v1/teaching/stripe/${encodeURIComponent(run.id)}/human`,
  );
  assert.equal(outcome.handoff?.nodeId, "account");

  // Another provider in the URL reaches nothing, whether or not the host
  // offers it.
  for (const guessed of ["supabase", "jira", "authored-fixture"]) {
    assert.equal((await call(`/${guessed}/${run.id}/human`)).status, 403);
    assert.equal(
      (await call(`/${guessed}/${run.id}/human`, { accountReady: true }))
        .status,
      403,
    );
  }
  // Only the page itself is served for the scoped step: its provider's
  // account claim is refused, and it has no callback or recovery route.
  assert.equal((await call(`/stripe/${run.id}/account`)).status, 403);
  for (const action of ["callback", "recovery"])
    assert.equal((await call(`/stripe/${run.id}/${action}`)).status, 404);

  // Another person, even with the executor capability, is refused.
  f.session.actor = { ...f.actor, subjectId: "mallory" };
  assert.equal((await call(path)).status, 403);
  // An agent cannot use the person's page at all.
  f.session.actor = { ...f.actor, actorKind: "agent" };
  assert.equal((await call(path)).status, 403);
  f.session.actor = f.actor;

  f.authorized.length = 0;
  // The person follows the hand-off's own path.
  const page = await call(
    outcome.handoff!.path!.slice("/api/v1/teaching".length),
  );
  assert.equal(page.status, 200);
  const html = await page.text();
  assert.ok(html.includes("https://dashboard.stripe.com/register"));
  // The host authorized the page under the Stripe step's own view.
  assert.deepEqual(f.authorized, [
    { operationId: "stripe.human", provider: "stripe", scope: "stripe" },
  ]);
  const ticket = /ticket:"([a-f0-9-]+)"/.exec(html)?.[1];
  assert.ok(ticket);
  assert.equal((await call(path, { ticket, accountReady: true })).status, 200);
  assert.deepEqual(
    (await f.runtime.commands.snapshot(f.actor, run.id)).nodes.map((node) => [
      node.id,
      node.state,
    ]),
    [
      ["account", "complete"],
      ["credential", "awaiting-human"],
      ["access", "pending"],
    ],
  );
  assert.equal(
    (await coordinator.turnOutcome(f.actor, run.id, "turn-2")).handoff?.path,
    `/api/v1/teaching/stripe/${encodeURIComponent(run.id)}/human`,
  );
  const collector = await (await call(path)).text();
  assert.ok(collector.includes('type="password"'));
  const privateTicket = /ticket:"([a-f0-9-]+)"/.exec(collector)?.[1];
  assert.ok(privateTicket);
  const submitted = await call(path, { ticket: privateTicket, token: f.token });
  assert.equal(submitted.status, 200);
  const completed = await f.runtime.commands.snapshot(f.actor, run.id);
  assert.equal(completed.status, "complete");
  assert.ok(
    completed.nodes.every(
      (node) => node.verified && node.provider === "stripe",
    ),
  );
  assert.equal(f.reads(), 1);
  // Once no step waits, the page is gone.
  assert.equal((await call(path)).status, 403);
  for (const kind of ["event", "demonstration", "audit", "outbox"] as const) {
    const records = await f.store.transaction((tx) =>
      tx.list(f.actor.tenantId, kind),
    );
    assert.ok(
      !JSON.stringify(records).includes(f.token),
      `${kind} must exclude the credential`,
    );
  }
});

for (const [field, value] of [
  ["target", "other"],
  ["origin", "https://other.example"],
] as const)
  test(`Stripe's page refuses a waiting Stripe step planned under another ${field}`, async (t) => {
    const f = await fixture(t);
    const context = {
      provider: "stripe",
      profile: "stripe-api-key",
      target: "self",
      origin: "https://app.example",
      environment: "test",
      configurationVersion: "v1",
    };
    // The run is Stripe's own, but its first step is planned under a Stripe
    // connector whose context differs in one field.
    const run = await f.runtime.commands.createRun(
      f.actor,
      context,
      [
        {
          id: "account",
          operationId: "stripe.prepare-account",
          operationVersion: "1.0.0",
          dependsOn: [],
          bindings: {},
          context: { ...context, connectorId: "stripe", [field]: value },
        },
      ],
      {},
    );
    assert.equal((await f.advance(run.id, "account")).state, "awaiting-human");
    const page = await teachingHttp(
      new Request(`https://app.example/api/v1/teaching/stripe/${run.id}/human`),
      f.runtime,
    );
    // The page would act under the run's context, not the step's: refused
    // before any ticket is issued.
    assert.equal(page.status, 403);
    const tickets = await f.store.transaction((tx) =>
      tx.list(f.actor.tenantId, "handoff"),
    );
    assert.equal(
      JSON.stringify(tickets).includes("stripe-collector:"),
      false,
      "No collector ticket may be written for the mismatched step",
    );
  });
