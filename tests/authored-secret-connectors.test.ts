import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { test } from "node:test";
import { SQLiteCeremonyStore } from "../src/server/persistence/index.js";
import {
  OperationRegistry,
  type OperationContext,
} from "../src/server/recipes/registry.js";
import {
  ProtectedCommandService,
  type RunRecord,
} from "../src/server/commands.js";
import { authoredHuman } from "../src/server/authored-human.js";
import {
  authoredHandleBound,
  authoredVocabulary,
  declareAuthoredCredentialVerification,
  authoredCredentialStored,
  deleteAuthoredSession,
  discoveredAuthSchema,
  registerAuthoredOperations,
} from "../src/server/authored-operations.js";
import type { ActorContext } from "../src/core/operation-contracts.js";

/*
 * Authored API-key, Basic and form connectors, end to end: the person enters
 * the secret on the native private form, it goes into custody, and the
 * declared verification request proves it against the provider. The value
 * must never reach a run snapshot, a node output, an event or a page.
 */

const provider = "https://provider.example";
const origin = "https://ceremony.example";
const actor: ActorContext = {
  tenantId: "tenant",
  subjectId: "owner",
  sessionId: "session",
  actorKind: "human",
  capabilities: ["executor"],
};

type Placement =
  | { in: "header"; name: string; prefix?: string }
  | { in: "query"; name: string }
  | { in: "basic" }
  | { in: "form"; usernameField?: string; passwordField?: string };

async function fixture(options: {
  kind: "api-key" | "basic" | "form";
  placement?: Placement;
  verificationUrl?: string;
  accept: (request: Request) => boolean;
  status?: number;
  /** A composed run: two secret ceremonies, one after the other. */
  twice?: boolean;
}) {
  const store = new SQLiteCeremonyStore(":memory:", {
    current: "test",
    keys: { test: randomBytes(32) },
  });
  const runContext = {
    provider: "novel",
    profile: "authored",
    target: "novel",
    origin,
    environment: "test",
    configurationVersion: "v1",
  };
  await store.transaction((tx) =>
    tx.put(
      {
        tenant: actor.tenantId,
        kind: "artifact",
        id: "installed-connector:novel",
      },
      {
        author: actor.subjectId,
        session: actor.sessionId,
        manifest: { name: "Novel", methods: [{ kind: options.kind }] },
        definition: {},
        discovery: {
          origin: provider,
          documents: [],
          methods: [options.kind],
          grantTypes: [],
          searchUsed: false,
        },
      },
      null,
    ),
  );
  if (options.placement)
    await declareAuthoredCredentialVerification(store, actor, "novel", {
      url: options.verificationUrl ?? `${provider}/v1/me`,
      placement: options.placement,
    });
  const requests: Request[] = [];
  const fetcher: typeof fetch = async (input, init) => {
    const request = new Request(String(input), init);
    requests.push(request.clone());
    return new Response(`{"secret-echo":"never read"}`, {
      status: options.accept(request) ? (options.status ?? 200) : 401,
    });
  };
  const registry = new OperationRegistry(authoredVocabulary);
  registerAuthoredOperations(registry, { store, fetch: fetcher });
  const commands = new ProtectedCommandService(
    store,
    registry,
    async () => true,
  );
  const run = await commands.createRun(
    actor,
    runContext,
    [
      {
        id: "secret",
        operationId: "authored.collect-credential",
        operationVersion: "1.0.0",
        dependsOn: [],
        bindings: {},
      },
      {
        id: "access",
        operationId: "authored.verify-access",
        operationVersion: "1.0.0",
        dependsOn: ["secret"],
        bindings: {
          session: { from: "output" as const, node: "secret", name: "session" },
        },
      },
      ...(options.twice
        ? [
            {
              id: "secret2",
              operationId: "authored.collect-credential",
              operationVersion: "1.0.0",
              dependsOn: ["access"],
              bindings: {},
            },
            {
              id: "access2",
              operationId: "authored.verify-access",
              operationVersion: "1.0.0",
              dependsOn: ["secret2"],
              bindings: {
                session: {
                  from: "output" as const,
                  node: "secret2",
                  name: "session",
                },
              },
            },
          ]
        : []),
    ],
    {},
  );
  const advance = async (nodeId: string) => {
    const snapshot = await commands.snapshot(actor, run.id);
    await commands.advance(
      actor,
      run.id,
      nodeId,
      snapshot.revision,
      `advance:${nodeId}:${snapshot.revision}`,
    );
  };
  await advance("secret");
  const context: OperationContext = {
    ...runContext,
    actor,
    runId: run.id,
    nodeId: "secret",
    commandId: "human",
    effectId: "human",
    signal: new AbortController().signal,
  };
  const humanUrl = `${origin}/api/v1/teaching/novel/${run.id}/human`;
  let pendingSecret = "secret";
  const human = async (init?: RequestInit) => {
    const record = await store.transaction((tx) =>
      tx.get<RunRecord>({ tenant: actor.tenantId, kind: "run", id: run.id }),
    );
    assert.ok(record);
    return authoredHuman(
      store,
      context,
      record,
      new Request(humanUrl, init),
      origin,
      () => advance(pendingSecret),
      { connectorId: "novel", name: "Novel", fetch: fetcher },
    );
  };
  /** Everything a person, an agent or an audit reader can see of this run. */
  const visible = async () => {
    const snapshot = await commands.snapshot(actor, run.id);
    const records = await store.transaction(async (tx) => [
      ...(await tx.list(actor.tenantId, "node", 1000, "")),
      ...(await tx.list(actor.tenantId, "event", 1000, "")),
      ...(await tx.list(actor.tenantId, "audit", 1000, "")),
      ...(await tx.list(actor.tenantId, "run", 1000, "")),
    ]);
    return JSON.stringify({ snapshot, records });
  };
  return {
    store,
    commands,
    run,
    advance,
    human,
    requests,
    visible,
    next(nodeId: string) {
      pendingSecret = nodeId;
    },
  };
}

const form = (values: Record<string, string>) => ({
  method: "POST",
  headers: { "content-type": "application/x-www-form-urlencoded" },
  body: new URLSearchParams(values).toString(),
});

test("an authored API-key connector collects the key privately and completes against the declared endpoint", async (t) => {
  const key = "sk-synthetic-authored-key-123";
  const f = await fixture({
    kind: "api-key",
    placement: { in: "header", name: "Authorization", prefix: "Bearer " },
    accept: (request) =>
      request.headers.get("authorization") === `Bearer ${key}`,
  });
  t.after(() => f.store.close());
  const before = await f.commands.snapshot(actor, f.run.id);
  assert.equal(
    before.nodes.find((node) => node.id === "secret")?.state,
    "awaiting-human",
  );
  const page = await (await f.human()).text();
  assert.match(page, /name="token" type="password"/);
  assert.match(page, /provider\.example/);
  assert.equal(page.includes(key), false);

  const saved = await f.human(form({ token: key }));
  assert.equal(saved.status, 303);
  await f.advance("access");
  const after = await f.commands.snapshot(actor, f.run.id);
  assert.equal(after.status, "complete");
  assert.ok(after.nodes.every((node) => node.verified));
  assert.equal(f.requests.length, 1);
  assert.equal(f.requests[0]!.url, `${provider}/v1/me`);
  assert.equal(f.requests[0]!.method, "GET");
  assert.equal((await f.visible()).includes(key), false);
});

test("an authored Basic connector applies username and password as declared and completes", async (t) => {
  const f = await fixture({
    kind: "basic",
    placement: { in: "basic" },
    accept: (request) =>
      request.headers.get("authorization") ===
      `Basic ${Buffer.from("fixture-user:synthetic-password").toString("base64")}`,
  });
  t.after(() => f.store.close());
  const page = await (await f.human()).text();
  assert.match(page, /name="username"/);
  assert.match(page, /name="password" type="password"/);
  assert.equal(
    (
      await f.human(
        form({ username: "fixture-user", password: "synthetic-password" }),
      )
    ).status,
    303,
  );
  await f.advance("access");
  assert.equal((await f.commands.snapshot(actor, f.run.id)).status, "complete");
  assert.equal((await f.visible()).includes("synthetic-password"), false);
});

test("an authored form connector posts the declared fields and completes", async (t) => {
  const f = await fixture({
    kind: "form",
    placement: { in: "form", usernameField: "login", passwordField: "pass" },
    verificationUrl: `${provider}/session`,
    accept: (request) => request.method === "POST",
  });
  t.after(() => f.store.close());
  await f.human(form({ username: "fixture-user", password: "form-password" }));
  await f.advance("access");
  assert.equal((await f.commands.snapshot(actor, f.run.id)).status, "complete");
  const body = new URLSearchParams(await f.requests[0]!.text());
  assert.equal(body.get("login"), "fixture-user");
  assert.equal(body.get("pass"), "form-password");
});

test("a rejected key fails verification without completing the connection", async (t) => {
  const f = await fixture({
    kind: "api-key",
    placement: { in: "query", name: "api_key" },
    accept: () => false,
  });
  t.after(() => f.store.close());
  await f.human(form({ token: "wrong-key" }));
  await f.advance("access");
  const snapshot = await f.commands.snapshot(actor, f.run.id);
  assert.equal(snapshot.status, "active");
  const access = snapshot.nodes.find((node) => node.id === "access");
  assert.equal(access?.state, "failed");
  assert.equal(access?.verified, false);
  assert.equal(
    new URL(f.requests[0]!.url).searchParams.get("api_key"),
    "wrong-key",
  );
  assert.equal((await f.visible()).includes("wrong-key"), false);
});

test("without a declared verification request a collected key never becomes a verified connection", async (t) => {
  const f = await fixture({ kind: "api-key", accept: () => true });
  t.after(() => f.store.close());
  const page = await (await f.human()).text();
  assert.match(page, /declares no verification request/);
  await f.human(form({ token: "unverifiable-key" }));
  await f.advance("access");
  const snapshot = await f.commands.snapshot(actor, f.run.id);
  assert.equal(snapshot.status, "active");
  assert.equal(
    snapshot.nodes.find((node) => node.id === "access")?.state,
    "awaiting-human",
  );
  assert.equal(f.requests.length, 0);
});

test("a verification declaration cannot point a credential at another origin or over plain HTTP", async (t) => {
  const f = await fixture({ kind: "api-key", accept: () => true });
  t.after(() => f.store.close());
  for (const url of [
    "https://attacker.example/collect",
    "http://provider.example/v1/me",
    "https://user:pass@provider.example/v1/me",
  ])
    await assert.rejects(
      declareAuthoredCredentialVerification(f.store, actor, "novel", {
        url,
        placement: { in: "header", name: "X-Api-Key" },
      }),
    );
  await assert.rejects(
    declareAuthoredCredentialVerification(f.store, actor, "novel", {
      url: `${provider}/v1/me`,
      placement: { in: "header", name: "Host" },
    }),
  );
  await assert.rejects(
    declareAuthoredCredentialVerification(
      f.store,
      { ...actor, subjectId: "someone-else" },
      "novel",
      { url: `${provider}/v1/me`, placement: { in: "basic" } },
    ),
  );
});

test("a credential form cannot be replayed after the step completed, and deletion removes custody", async (t) => {
  const f = await fixture({
    kind: "api-key",
    placement: { in: "header", name: "X-Api-Key" },
    accept: (request) => request.headers.get("x-api-key") === "first-key",
  });
  t.after(() => f.store.close());
  await f.human(form({ token: "first-key" }));
  await assert.rejects(f.human(form({ token: "second-key" })));
  await f.advance("access");
  assert.equal((await f.commands.snapshot(actor, f.run.id)).status, "complete");
  assert.equal(await deleteAuthoredSession(f.store, actor, f.run.id), true);
  const stored = await f.store.transaction((tx) =>
    tx.list(actor.tenantId, "handoff", 1000, ""),
  );
  assert.equal(JSON.stringify(stored).includes("first-key"), false);
});

test("authored handles are random per run and bound to the node that issued them", async (t) => {
  const accept = (request: Request) => request.headers.get("x-api-key") === "k";
  const first = await fixture({
    kind: "api-key",
    placement: { in: "header", name: "X-Api-Key" },
    accept,
  });
  const second = await fixture({
    kind: "api-key",
    placement: { in: "header", name: "X-Api-Key" },
    accept,
  });
  t.after(() => first.store.close());
  t.after(() => second.store.close());
  for (const f of [first, second]) {
    await f.human(form({ token: "k" }));
    await f.advance("access");
  }
  const outputs = async (f: typeof first) =>
    (
      await f.store.transaction((tx) =>
        tx.get<{ outputs: Record<string, string> }>({
          tenant: actor.tenantId,
          kind: "node",
          id: `${f.run.id}:access`,
        }),
      )
    )?.value.outputs.connection;
  const a = await outputs(first);
  const b = await outputs(second);
  assert.match(a ?? "", /^authored-connection-[a-f0-9]{32}$/);
  assert.notEqual(a, b);
  assert.equal(
    await authoredHandleBound(first.store, actor, first.run.id, a, {
      kind: "connection",
      nodeId: "access",
    }),
    true,
  );
  assert.equal(
    await authoredHandleBound(first.store, actor, first.run.id, a, {
      kind: "connection",
      nodeId: "secret",
    }),
    false,
  );
  assert.equal(
    await authoredHandleBound(first.store, actor, "run:other", a, {
      kind: "connection",
    }),
    false,
  );
  assert.equal(
    await authoredHandleBound(
      first.store,
      { ...actor, subjectId: "other" },
      first.run.id,
      a,
      { kind: "connection" },
    ),
    false,
  );
});

test("the discovered-auth schema accepts only declared placements and HTTPS verification", () => {
  const base = {
    origin: provider,
    documents: [],
    methods: [],
    grantTypes: [],
    searchUsed: false,
  };
  assert.equal(
    discoveredAuthSchema.safeParse({
      ...base,
      credentialVerification: {
        url: "javascript:alert(1)",
        placement: { in: "basic" },
      },
    }).success,
    false,
  );
  assert.equal(
    discoveredAuthSchema.safeParse({
      ...base,
      credentialVerification: {
        url: `${provider}/me`,
        placement: { in: "cookie", name: "session" },
      },
    }).success,
    false,
  );
});

test("a composed run collects each secret on its own step", async (t) => {
  const f = await fixture({
    kind: "api-key",
    placement: { in: "header", name: "X-Api-Key" },
    accept: (request) =>
      ["key-one", "key-two"].includes(request.headers.get("x-api-key") ?? ""),
    twice: true,
  });
  t.after(() => f.store.close());
  await f.human(form({ token: "key-one" }));
  await f.advance("access");
  f.next("secret2");
  await f.advance("secret2");
  // The first step's stored key must not make the second step's form vanish.
  const page = await (await f.human()).text();
  assert.match(page, /name="token"/);
  await f.human(form({ token: "key-two" }));
  // Each step keeps its own secret: the second is not written over the first.
  assert.equal(
    await authoredCredentialStored(f.store, actor, f.run.id, {
      nodeId: "secret",
      verified: true,
    }),
    true,
  );
  await f.advance("access2");
  const snapshot = await f.commands.snapshot(actor, f.run.id);
  assert.equal(snapshot.status, "complete");
  assert.deepEqual(
    f.requests.map((request) => request.headers.get("x-api-key")),
    ["key-one", "key-two"],
  );
  assert.equal(
    await authoredCredentialStored(f.store, actor, f.run.id, {
      nodeId: "secret2",
      verified: true,
    }),
    true,
  );
  // Deleting the connection removes every step's custody.
  assert.equal(await deleteAuthoredSession(f.store, actor, f.run.id), true);
  const stored = JSON.stringify(
    await f.store.transaction((tx) =>
      tx.list(actor.tenantId, "handoff", 1000, ""),
    ),
  );
  assert.equal(stored.includes("key-one"), false);
  assert.equal(stored.includes("key-two"), false);
});
