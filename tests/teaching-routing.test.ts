import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { test } from "node:test";
import {
  AuthorizationError,
  type ActorContext,
} from "../src/server/identity.js";
import {
  PersistenceConflict,
  SQLiteCeremonyStore,
} from "../src/server/persistence/index.js";
import {
  OperationRegistry,
  type PublishedRecipe,
} from "../src/server/recipes/index.js";
import { createTeachingRuntime } from "../src/server/teaching-runtime.js";
import { teachingHttp } from "../src/server/teaching-http.js";
import { ConnectorDrafts } from "../src/server/connector-drafts.js";
import { ceremonyAgentTools } from "../src/server/agent-tools.js";
import {
  saveAuthoredAccountIntent,
  saveAuthoredBlocker,
} from "../src/server/authored-operations.js";

test("HTTP tool responses retain human guidance without exposing it through shared agent tools", async (t) => {
  const store = new SQLiteCeremonyStore(":memory:", {
    current: "test",
    keys: { test: randomBytes(32) },
  });
  t.after(() => store.close());
  const actor: ActorContext = {
    tenantId: "routing-tenant",
    subjectId: "routing-owner",
    sessionId: "routing-session",
    actorKind: "human",
    capabilities: ["executor"],
  };
  const origin = "https://routing.example";
  const runtime = createTeachingRuntime({
    store,
    registry: new OperationRegistry(),
    identity: { authenticate: async () => actor },
    origin,
    context: async () => ({
      provider: "fixture",
      profile: "authored",
      target: "fixture",
      origin,
      environment: "test",
      configurationVersion: "1",
    }),
    authorize: async () => true,
  });
  const run = {
    id: "fixture-run",
    revision: 1,
    provider: "fixture",
    profile: "authored",
    status: "active" as const,
    nodes: [],
  };
  runtime.connectForAgent = async () => ({
    run,
    actor: { ...actor, actorKind: "agent" as const },
  });
  runtime.commands.snapshot = async () => run;
  await saveAuthoredAccountIntent(store, actor, run.id, {
    identifier: "chosen@example.test",
    status: "existing",
  });
  await saveAuthoredBlocker(store, actor, run.id, "session");
  for (const [action, body] of [
    ["connect", { connectorId: "fixture" }],
    ["snapshot", { runId: run.id }],
  ] as const) {
    const response = await teachingHttp(
      new Request(`${origin}/api/v1/teaching/tools/${action}`, {
        method: "POST",
        headers: { origin, "content-type": "application/json" },
        body: JSON.stringify(body),
      }),
      runtime,
    );
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), {
      ...run,
      human: {
        reason: "session",
        account: "chosen@example.test",
        fields: ["account", "password"],
      },
    });
    assert.deepEqual(
      await ceremonyAgentTools(runtime)[action](actor, body),
      run,
    );
  }
});

test("teaching endpoint families preserve error translation, authoring round trips and unmatched methods", async (t) => {
  const store = new SQLiteCeremonyStore(":memory:", {
    current: "test",
    keys: { test: randomBytes(32) },
  });
  t.after(() => store.close());
  const actor: ActorContext = {
    tenantId: "routing-tenant",
    subjectId: "routing-owner",
    sessionId: "routing-session",
    actorKind: "human",
    capabilities: ["author", "executor"],
  };
  const origin = "https://routing.example";
  let failure: unknown = new Error("synthetic-private-failure");
  let attempts = 0;
  const fail = async () => {
    attempts++;
    await Promise.resolve();
    throw failure;
  };
  const runtime = createTeachingRuntime({
    store,
    registry: new OperationRegistry(),
    identity: { authenticate: async () => actor },
    origin,
    context: async () => ({
      provider: "github",
      profile: "app",
      target: "fixture",
      origin,
      environment: "test",
      configurationVersion: "1",
    }),
    authorize: async () => true,
    human: fail,
  });
  runtime.authoring.fromProvider = fail;
  runtime.connect = fail;
  runtime.commands.snapshot = fail;
  runtime.demonstrations.timeline = fail;
  runtime.recipes.getDraft = fail;
  runtime.recipes.getPublished = fail;
  runtime.agent.status = fail;
  const call = (path: string, body?: unknown, accept?: string) =>
    teachingHttp(
      new Request(
        `${origin}/api/v1/teaching${path}`,
        body === undefined
          ? {}
          : {
              method: "POST",
              headers: {
                origin,
                "content-type": "application/json",
                ...(accept ? { accept } : {}),
              },
              body: JSON.stringify(body),
            },
      ),
      runtime,
    );
  const emptyRecipes = await call("/recipes");
  assert.equal(emptyRecipes.status, 200);
  assert.deepEqual(await emptyRecipes.json(), { recipes: [] });
  const published: PublishedRecipe = {
    definition: {
      schemaVersion: 1,
      id: "fixture",
      title: "Published fixture",
      description: "Synthetic recipe inventory fixture",
      inputs: {},
      invocations: [
        {
          id: "prepare",
          use: { kind: "operation", id: "prepare", version: "1.0.0" },
          dependsOn: [],
          bindings: {},
        },
      ],
      outputs: {},
    },
    version: "1.0.0",
    digest: "a".repeat(64),
    closure: {},
    retired: false,
    publisher: actor.subjectId,
  };
  await store.transaction(async (tx) => {
    for (const [tenant, id, value] of [
      [actor.tenantId, "fixture", published],
      [actor.tenantId, "retired", { ...published, retired: true }],
      ["other-tenant", "foreign", published],
    ] as const)
      await tx.put({ tenant, kind: "recipe", id }, value, null);
  });
  const recipes = await call("/recipes");
  assert.equal(recipes.status, 200);
  assert.deepEqual(await recipes.json(), {
    recipes: [
      {
        id: published.definition.id,
        title: published.definition.title,
        version: published.version,
        digest: published.digest,
        definition: published.definition,
      },
    ],
  });
  const routes: Array<[string, unknown?]> = [
    ["/authoring/from-provider", { provider: "fixture" }],
    ["/tools/snapshot", { runId: "fixture" }],
    ["/runs", { connectorId: "github" }],
    ["/runs/fixture"],
    ["/demonstrations/fixture"],
    ["/drafts/fixture"],
    [`/recipes/fixture/export?version=1.0.0&digest=${"a".repeat(64)}`],
    ["/agent/fixture/status"],
    ["/github/fixture/recovery", {}],
  ];
  for (const [error, status, code] of [
    [new AuthorizationError("denied"), 403, "denied"],
    [new AuthorizationError("unauthenticated"), 401, "unauthenticated"],
    [new AuthorizationError("invalid_request"), 400, "invalid_request"],
    [new AuthorizationError("rate_limited"), 403, "rate_limited"],
    [new PersistenceConflict(), 409, "conflict"],
    [new Error("account-required"), 409, "account-required"],
    [new Error("jira-site-required"), 409, "jira-site-required"],
    [
      new Error("incomplete-github-configuration"),
      409,
      "incomplete-github-configuration",
    ],
    [new Error("synthetic-private-failure"), 400, "unavailable"],
    [null, 400, "unavailable"],
  ] as const) {
    failure = error;
    for (const [path, body] of routes) {
      const before = attempts;
      const response = await call(path, body);
      assert.equal(response.status, status, path);
      assert.deepEqual(await response.json(), { error: code }, path);
      assert.equal(response.headers.get("cache-control"), "no-store");
      assert.equal(response.headers.get("referrer-policy"), "no-referrer");
      assert.equal(response.headers.get("x-content-type-options"), "nosniff");
      assert.equal(attempts, before + 1, path);
    }
  }
  for (const [path, body, status] of [
    ["/authoring/from-provider", undefined, 405],
    ["/tools/snapshot", undefined, 405],
    ["/authoring/installed/fixture", {}, 404],
    ["/authoring/drafts/00000000-0000-4000-8000-000000000000", {}, 404],
    ["/runs", undefined, 404],
    ["/runs/fixture", {}, 404],
    ["/runs/fixture/advance", undefined, 404],
    ["/demonstrations", undefined, 404],
    ["/recipes/compose", undefined, 404],
    ["/recipes/fixture/export", {}, 404],
    ["/agent/fixture/start", undefined, 404],
    ["/agent/fixture/status", {}, 404],
    ["/unknown", undefined, 404],
  ] as const) {
    const before = attempts;
    const response = await call(path, body);
    assert.equal(response.status, status, path);
    assert.deepEqual(await response.json(), { error: "unavailable" });
    assert.equal(attempts, before, path);
  }
  for (const path of ["/authoring/from-provider", "/composition/preview"]) {
    const before = attempts;
    const response = await call(path, {});
    assert.equal(response.status, 400);
    assert.deepEqual(await response.json(), { error: "invalid_request" });
    assert.equal(attempts, before);
  }
  runtime.authoring = new ConnectorDrafts(store, {
    fetch: async () => new Response("", { status: 404 }),
  });
  const drafted = await call("/authoring/from-provider", {
    provider: "acme",
    origin: "https://acme.example",
  });
  assert.equal(drafted.status, 200);
  const created = await drafted.json();
  assert.equal(created.draft.connectorId, "acme");
  const installed = await call("/authoring/installed/acme");
  assert.equal(installed.status, 200);
  const descriptor = await installed.json();
  assert.equal(descriptor.id, "acme");
  assert.deepEqual(
    descriptor.methods.map((method: { kind: string }) => method.kind),
    ["oauth-code", "account-registration"],
  );
  assert.equal(descriptor.discovery.origin, "https://acme.example");
  assert.deepEqual(descriptor.discovery.extra, []);
  assert.equal((await call("/authoring/installed/missing")).status, 404);
  const read = await call(`/authoring/drafts/${created.draft.id}`);
  assert.equal(read.status, 200);
  assert.equal((await read.json()).draft.revision, created.draft.revision);
  const composed = await call("/authoring/compose", {
    draftId: created.draft.id,
    revision: created.draft.revision,
    childIds: ["method-1", "method-2"],
  });
  assert.equal(composed.status, 200);
  const composition = await composed.json();
  assert.equal(composition.draft.revision, created.draft.revision + 1);
  assert.equal(composition.draft.methods.length, 3);
  assert.deepEqual(
    (await (await call(`/authoring/drafts/${created.draft.id}`)).json()).draft,
    composition.draft,
  );
  const removed = await call("/authoring/delete", { connectorId: "acme" });
  assert.equal(removed.status, 200);
  assert.deepEqual(await removed.json(), {
    ok: true,
    human: null,
    removed: true,
  });
  assert.equal((await call("/authoring/installed/acme")).status, 404);

  const readEvents = async (response: Response) => {
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("content-type"), "text/event-stream");
    assert.equal(response.headers.get("cache-control"), "no-store");
    assert.equal(response.headers.get("x-content-type-options"), "nosniff");
    return (await response.text())
      .split("\n\n")
      .filter(Boolean)
      .map((frame) => {
        const [event, data] = frame.split("\n");
        return {
          event: event!.slice("event: ".length),
          data: JSON.parse(data!.slice("data: ".length)),
        };
      });
  };
  const beforeChat = attempts;
  const events = await readEvents(
    await call(
      "/authoring/chat",
      { message: "create a ceremony for acme" },
      "text/event-stream",
    ),
  );
  assert.deepEqual(events[0], {
    event: "progress",
    data: { text: "Starting ceremony discovery" },
  });
  assert.equal(events.at(-1)?.event, "done");
  const draftEvent = events.find((event) => event.event === "draft");
  assert.equal(draftEvent?.data.result.draft.connectorId, "acme");
  assert.deepEqual(events.at(-1)?.data.result, draftEvent?.data.result);
  assert.equal(Object.hasOwn(events.at(-1)!.data, "run"), false);
  assert.match(events.at(-1)!.data.messages.at(-1).text, /Choose a ceremony/);
  assert.equal(attempts, beforeChat);

  const deletedChat = await readEvents(
    await call(
      "/authoring/chat",
      { message: "delete acme" },
      "text/event-stream",
    ),
  );
  assert.deepEqual(
    deletedChat.map((event) => event.event),
    ["progress", "done"],
  );
  assert.equal(deletedChat.at(-1)!.data.result, undefined);
  assert.equal(
    deletedChat.at(-1)!.data.messages.at(-1).text.includes("Choose a ceremony"),
    false,
  );

  failure = new Error("synthetic-private-failure");
  runtime.authoring.chat = fail;
  const failedChat = await readEvents(
    await call("/authoring/chat", { message: "acme" }, "text/event-stream"),
  );
  assert.deepEqual(failedChat, [
    { event: "progress", data: { text: "Starting ceremony discovery" } },
    { event: "error", data: { error: "denied-or-unavailable" } },
  ]);
  runtime.demonstrations.start = fail;
  failure = new AuthorizationError("denied");
  const beforeStart = attempts;
  const started = await call("/demonstrations", { runId: "fixture" });
  assert.equal(started.status, 403);
  assert.deepEqual(await started.json(), { error: "denied" });
  assert.equal(attempts, beforeStart + 1);
});
