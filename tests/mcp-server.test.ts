import assert from "node:assert/strict";
import { test } from "node:test";
import { randomBytes } from "node:crypto";
import { z } from "zod";
import { createTeachingRuntime } from "../src/server/teaching-runtime.js";
import { OperationRegistry } from "../src/server/recipes/registry.js";
import { SQLiteCeremonyStore } from "../src/server/persistence/index.js";
import { createCeremonyMcpHandler } from "../src/server/mcp.js";
import { ceremonyAgentTools } from "../src/server/agent-tools.js";
import { teachingRefusals } from "../src/server/mcp-teaching.js";
import {
  approveCredentialVerification,
  authoringTransportFor,
} from "../src/server/teaching-operations.js";
import { teachingHttp } from "../src/server/teaching-http.js";
import { installedDiscovery } from "../src/server/authored-operations.js";
import type { AgentConnectorDependencies } from "../src/server/connectors/agents/intents.js";
import type { ConnectorToolDependencies } from "../src/server/connectors/mcp/server-tools.js";
import type { ActorContext } from "../src/core/operation-contracts.js";
import type { RecipeDefinition } from "../src/core/recipe-contracts.js";

const actor: ActorContext = {
  tenantId: "tenant",
  subjectId: "subject",
  sessionId: "session",
  actorKind: "human",
  capabilities: ["executor"],
};
const context = {
  provider: "fixture-provider",
  profile: "fixture-key",
  target: "account",
  origin: "https://app.example",
  environment: "test",
  configurationVersion: "v1",
};
const recipe: RecipeDefinition = {
  schemaVersion: 1,
  id: "fixture",
  title: "Fixture",
  description: "Public argument fixture",
  inputs: {},
  invocations: [
    {
      id: "node",
      use: { kind: "operation", id: "verify", version: "1.0.0" },
      dependsOn: [],
      bindings: { target: { from: "literal", value: "account" } },
    },
  ],
  outputs: {},
};

function fixture(
  options: {
    waitsOnPerson?: boolean;
    person?: () => ActorContext;
  } & Partial<Parameters<typeof createTeachingRuntime>[0]> = {},
) {
  const { waitsOnPerson: _waits, person: _person, ...runtimeOptions } = options;
  void _waits;
  void _person;
  const store = new SQLiteCeremonyStore(":memory:", {
    current: "key",
    keys: { key: randomBytes(32) },
  });
  const registry = new OperationRegistry(
    new Map([
      [
        "target",
        { classification: "public" as const, schema: z.string().min(1) },
      ],
    ]),
  );
  registry.register({
    contract: {
      id: "verify",
      version: "1.0.0",
      provider: context.provider,
      profile: context.profile,
      inputs: { target: { contract: "target", required: true } },
      outputs: {},
      effects: ["verify"],
      verifier: "fixture",
      humanFallback: "human",
    },
    inputSchema: z.strictObject({ target: z.string().min(1) }),
    outputSchema: z.strictObject({}),
    classifications: {
      target: { classification: "public", schema: z.string().min(1) },
    },
    fixtures: ["local"],
    handler: async () =>
      options.waitsOnPerson
        ? { state: "awaiting-human" as const, outputs: {} }
        : { state: "complete" as const, outputs: {} },
    verify: async () => !options.waitsOnPerson,
  });
  const runtime = createTeachingRuntime({
    store,
    registry,
    // The browser-side actor, for the HTTP routes some tests also call.
    identity: { authenticate: async () => options.person?.() ?? actor },
    origin: context.origin,
    connections: new Map([
      [
        "fixture",
        {
          definition: recipe,
          outputContract: "fixture.connection",
          revalidateOperation: "verify",
        },
      ],
    ]),
    context: async () => context,
    authorize: async () => true,
    // Authoring discovery never leaves the process in these tests.
    authoringFetch: async () => new Response("", { status: 404 }),
    ...runtimeOptions,
  });
  return { store, runtime };
}

const endpoint = "https://app.example/mcp";
const issuer = "https://issuer.example";

function handlerFor(
  runtime: ReturnType<typeof fixture>["runtime"],
  authenticate: (token: string) => ActorContext | null,
) {
  return createCeremonyMcpHandler(runtime, {
    resourceUrl: endpoint,
    issuer,
    authenticate: (token) => authenticate(token),
  });
}

const call = (
  mcp: ReturnType<typeof createCeremonyMcpHandler>,
  token: string | undefined,
  body: unknown,
) =>
  mcp.fetch(
    new Request(endpoint, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        ...(token ? { authorization: `Bearer ${token}` } : {}),
      },
      body: JSON.stringify(body),
    }),
  );

const initialize = {
  jsonrpc: "2.0",
  id: 1,
  method: "initialize",
  params: {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "test", version: "1" },
  },
};

test("a request with no bearer token is refused and points at the resource metadata", async () => {
  const f = fixture();
  try {
    const mcp = handlerFor(f.runtime, () => actor);
    const response = await call(mcp, undefined, initialize);
    assert.equal(response?.status, 401);
    assert.match(
      response!.headers.get("www-authenticate") ?? "",
      /^Bearer resource_metadata="https:\/\/app\.example\/\.well-known\/oauth-protected-resource/,
    );
  } finally {
    await f.store.close();
  }
});

test("a token the host refuses cannot reach a tool", async () => {
  const f = fixture();
  try {
    const mcp = handlerFor(f.runtime, () => null);
    const response = await call(mcp, "not-a-real-token", initialize);
    assert.equal(response?.status, 401);
  } finally {
    await f.store.close();
  }
});

test("the resource metadata names the issuer and this endpoint, and needs no token", async () => {
  const f = fixture();
  try {
    const mcp = handlerFor(f.runtime, () => actor);
    const response = await mcp.fetch(
      new Request(
        "https://app.example/.well-known/oauth-protected-resource/mcp",
      ),
    );
    assert.equal(response?.status, 200);
    const body = await response!.json();
    assert.equal(body.resource, endpoint);
    assert.deepEqual(body.authorization_servers, [issuer]);
  } finally {
    await f.store.close();
  }
});

test("a path this server does not own is left for the rest of the application", async () => {
  const f = fixture();
  try {
    const mcp = handlerFor(f.runtime, () => actor);
    assert.equal(
      await mcp.fetch(new Request("https://app.example/api/config")),
      undefined,
    );
  } finally {
    await f.store.close();
  }
});

test("an authenticated client reaches the tools and sees the connectors", async () => {
  const f = fixture();
  try {
    const mcp = handlerFor(f.runtime, () => actor);
    const response = await call(mcp, "good", initialize);
    assert.equal(response?.status, 200);
    const listed = await call(mcp, "good", {
      jsonrpc: "2.0",
      id: 2,
      method: "tools/list",
      params: {},
    });
    const text = await listed!.text();
    for (const name of [
      "ceremony_connect",
      "ceremony_snapshot",
      "ceremony_advance",
      "ceremony_cancel",
      "ceremony_connectors",
    ])
      assert.ok(text.includes(name), `${name} is not offered`);
  } finally {
    await f.store.close();
  }
});

test("the in-chat collector stays unmounted on a plain-HTTP origin", async () => {
  const f = fixture();
  try {
    const insecure = createCeremonyMcpHandler(f.runtime, {
      resourceUrl: "http://127.0.0.1:4173/mcp",
      issuer: "http://127.0.0.1:4174",
      authenticate: () => actor,
      privateCollector: {
        brokerOrigin: "http://127.0.0.1:4173",
        appOrigin: "http://127.0.0.1:4173",
        appHtml: "<p>collector</p>",
        controller: undefined as never,
        db: undefined as never,
        requestOwner: () => actor.subjectId,
      },
    });
    assert.equal(insecure.collectorAvailable, false);
  } finally {
    await f.store.close();
  }
});

test("the in-chat collector mounts when both origins are HTTPS", async () => {
  const f = fixture();
  try {
    const secure = createCeremonyMcpHandler(f.runtime, {
      resourceUrl: "https://tunnel.example/mcp",
      issuer: "https://tunnel.example",
      authenticate: () => actor,
      privateCollector: {
        brokerOrigin: "https://tunnel.example",
        appOrigin: "https://tunnel.example",
        appHtml: "<p>collector</p>",
        controller: undefined as never,
        db: undefined as never,
        requestOwner: () => actor.subjectId,
      },
    });
    assert.equal(secure.collectorAvailable, true);
  } finally {
    await f.store.close();
  }
});

test("another subject cannot touch a run at all", async () => {
  const f = fixture();
  try {
    const tools = ceremonyAgentTools(f.runtime);
    const run = await tools.connect(actor, { connectorId: "fixture" });
    const stranger: ActorContext = { ...actor, subjectId: "somebody-else" };
    for (const attempt of [
      tools.snapshot(stranger, { runId: run.id }),
      tools.advance(stranger, {
        runId: run.id,
        nodeId: "node",
        revision: run.revision,
        commandId: "stranger-attempt",
      }),
      tools.cancel(stranger, { runId: run.id, revision: run.revision }),
    ])
      await assert.rejects(attempt);
  } finally {
    await f.store.close();
  }
});

/**
 * The same person in a second session can read the run — ownership is the
 * subject — but the delegation this run was started under belongs to the
 * session that started it, so driving it from elsewhere is refused. Reading
 * and driving are deliberately not the same permission, and nothing before
 * this check distinguishes them.
 */
test("the same subject in a different session may read a run but not drive it", async () => {
  const f = fixture();
  try {
    const tools = ceremonyAgentTools(f.runtime);
    const run = await tools.connect(actor, { connectorId: "fixture" });
    const elsewhere: ActorContext = { ...actor, sessionId: "another-session" };
    assert.equal(
      (await tools.snapshot(elsewhere, { runId: run.id })).id,
      run.id,
    );
    await assert.rejects(
      tools.advance(elsewhere, {
        runId: run.id,
        nodeId: "node",
        revision: run.revision,
        commandId: "other-session-attempt",
      }),
      /denied/,
    );
    await assert.rejects(
      tools.cancel(elsewhere, { runId: run.id, revision: run.revision }),
      /denied/,
    );
  } finally {
    await f.store.close();
  }
});

/**
 * A property of the system, not of one line: the command layer refuses a
 * non-executor too, and the check at the tool boundary is deliberately the
 * second of the two. The run id here is a real one, so what is being refused
 * is the capability rather than a run that does not exist.
 */
test("a reviewer cannot drive ceremonies through the agent tools", async () => {
  const f = fixture();
  try {
    const tools = ceremonyAgentTools(f.runtime);
    const run = await tools.connect(actor, { connectorId: "fixture" });
    const reader: ActorContext = { ...actor, capabilities: ["reviewer"] };
    for (const attempt of [
      tools.connect(reader, { connectorId: "fixture" }),
      tools.snapshot(reader, { runId: run.id }),
      tools.advance(reader, {
        runId: run.id,
        nodeId: "node",
        revision: run.revision,
        commandId: "reviewer-attempt",
      }),
      tools.cancel(reader, { runId: run.id, revision: run.revision }),
    ])
      await assert.rejects(attempt, /denied/);
  } finally {
    await f.store.close();
  }
});

/*
 * Recording, authoring and chaining over MCP. These drive the real handler
 * over its HTTP surface, so what is asserted is what a chat client sees:
 * which tools are offered to whom, what a result carries, and how a refusal
 * reads.
 */

const author: ActorContext = {
  ...actor,
  subjectId: "author",
  capabilities: ["author", "executor"],
};
const reviewer: ActorContext = {
  ...actor,
  subjectId: "person-reviewing",
  capabilities: ["reviewer"],
};
const publisher: ActorContext = {
  ...actor,
  subjectId: "person-publishing",
  capabilities: ["publisher"],
};

type ToolListing = {
  name: string;
  annotations?: { readOnlyHint?: boolean; destructiveHint?: boolean };
};
type ToolResult = { isError?: boolean; content: Array<{ text: string }> };

/** A JSON-RPC answer, whether the transport replied with JSON or an SSE frame. */
async function rpc<T>(
  mcp: ReturnType<typeof createCeremonyMcpHandler>,
  token: string,
  method: string,
  params: unknown,
): Promise<T> {
  const response = await call(mcp, token, {
    jsonrpc: "2.0",
    id: 7,
    method,
    params,
  });
  const text = await response!.text();
  const payload = text.trimStart().startsWith("{")
    ? text
    : text
        .split("\n")
        .filter((line) => line.startsWith("data: "))
        .map((line) => line.slice(6))
        .at(-1)!;
  const message = JSON.parse(payload) as { result: T; error?: unknown };
  assert.equal(message.error, undefined, JSON.stringify(message.error));
  return message.result;
}

async function toolsFor(
  mcp: ReturnType<typeof createCeremonyMcpHandler>,
  token: string,
) {
  await call(mcp, token, initialize);
  return (await rpc<{ tools: ToolListing[] }>(mcp, token, "tools/list", {}))
    .tools;
}

async function invoke(
  mcp: ReturnType<typeof createCeremonyMcpHandler>,
  token: string,
  name: string,
  args: Record<string, unknown> = {},
) {
  const result = await rpc<ToolResult>(mcp, token, "tools/call", {
    name,
    arguments: args,
  });
  return {
    isError: result.isError === true,
    text: result.content[0]!.text,
    value: () => JSON.parse(result.content[0]!.text) as Record<string, any>,
  };
}

const byToken = (token: string): ActorContext | null =>
  ({ executor: actor, author, reviewer })[token] ?? null;

const teachingTools = [
  "ceremony_author_from_provider",
  "ceremony_author_compose",
  "ceremony_author_read",
  "ceremony_author_delete",
  "ceremony_demonstration_start",
  "ceremony_demonstration_consent",
  "ceremony_demonstration_read",
  "ceremony_draft_compile",
  "ceremony_draft_import",
  "ceremony_draft_read",
  "ceremony_draft_edit",
  "ceremony_recipe_compose",
];
/** Every tool an agent holding every capability is offered. */
const AGENT_TOOLS = [
  "browser_backends",
  "browser_login",
  "browser_record_login",
  "browser_release",
  "browser_session_status",
  "ceremony_advance",
  "ceremony_author_compose",
  "ceremony_author_delete",
  "ceremony_author_from_provider",
  "ceremony_author_read",
  "ceremony_author_verification_propose",
  "ceremony_bind_private",
  "ceremony_cancel",
  "ceremony_collect_private",
  "ceremony_connect",
  "ceremony_connectors",
  "ceremony_demonstration_consent",
  "ceremony_demonstration_read",
  "ceremony_demonstration_start",
  "ceremony_draft_compile",
  "ceremony_draft_edit",
  "ceremony_draft_import",
  "ceremony_draft_read",
  "ceremony_recipe_compose",
  "ceremony_recipe_execute",
  "ceremony_recipe_preview",
  "ceremony_recipes",
  "ceremony_recording_read",
  "ceremony_snapshot",
  "connector_catalog",
  "connector_connect",
  "connector_disconnect",
  "connector_inspect",
  "connector_invoke",
  "connector_list",
  "connector_operations",
  "connector_reconnect",
  "connector_status",
];
const executorTools = [
  "ceremony_recipes",
  "ceremony_recipe_preview",
  "ceremony_recipe_execute",
];

test("recording, authoring and chaining tools are offered only to actors who could use them", async () => {
  const f = fixture();
  try {
    const mcp = handlerFor(f.runtime, byToken);
    const executorNames = (await toolsFor(mcp, "executor")).map((t) => t.name);
    for (const name of executorTools)
      assert.ok(executorNames.includes(name), `${name} missing for executor`);
    for (const name of teachingTools)
      assert.ok(!executorNames.includes(name), `${name} offered to executor`);

    const authorNames = (await toolsFor(mcp, "author")).map((t) => t.name);
    for (const name of [...teachingTools, ...executorTools])
      assert.ok(authorNames.includes(name), `${name} missing for author`);

    const reviewerNames = (await toolsFor(mcp, "reviewer")).map((t) => t.name);
    assert.ok(reviewerNames.includes("ceremony_draft_read"));
    assert.ok(reviewerNames.includes("ceremony_demonstration_read"));
    assert.ok(!reviewerNames.includes("ceremony_draft_compile"));
    assert.ok(!reviewerNames.includes("ceremony_recipe_execute"));
  } finally {
    await f.store.close();
  }
});

test("an agent holding every capability is offered exactly this list, with every tool family mounted", async () => {
  // Every optional family a deployment can mount: connector tools, connector
  // intents, browser login with recordings, and the private collector. Only
  // tool registration runs here, so the services behind them are never used.
  const browserLogin = {
    recordings: {},
  } as unknown as NonNullable<
    Parameters<typeof createTeachingRuntime>[0]["browserLogin"]
  >;
  const f = fixture({ browserLogin });
  try {
    // A person holding every capability is offered the same tools: review
    // and publication are the people's routes, never a tool.
    for (const actorKind of ["agent", "human"] as const) {
      const holder: ActorContext = {
        ...actor,
        actorKind,
        capabilities: ["executor", "author", "reviewer", "publisher", "admin"],
      };
      const mcp = createCeremonyMcpHandler(f.runtime, {
        resourceUrl: endpoint,
        issuer,
        authenticate: () => holder,
        connectors: {} as ConnectorToolDependencies,
        connectorIntents: {} as AgentConnectorDependencies,
        privateCollector: {
          brokerOrigin: "https://broker.example",
          appOrigin: "https://collector.example",
          appHtml: "<!doctype html>",
        } as unknown as NonNullable<
          Parameters<typeof createCeremonyMcpHandler>[1]["privateCollector"]
        >,
      });
      const names = (await toolsFor(mcp, actorKind)).map((t) => t.name).sort();
      // Review, publication and retirement are a person's decision: none of
      // them is here, for recipes, recordings or connectors, whatever the
      // actor holds. A tool added to this list is a decision, not an accident.
      assert.deepEqual(names, AGENT_TOOLS, actorKind);
      for (const name of names)
        assert.doesNotMatch(name, /_(publish|review|retire|approve)/, name);
    }
  } finally {
    await f.store.close();
  }
});

test("tools carry read-only and destructive hints", async () => {
  const f = fixture();
  try {
    const listed = await toolsFor(handlerFor(f.runtime, byToken), "author");
    const hints = new Map(listed.map((t) => [t.name, t.annotations ?? {}]));
    for (const name of [
      "ceremony_snapshot",
      "ceremony_connectors",
      "ceremony_author_read",
      "ceremony_draft_read",
      "ceremony_demonstration_read",
      "ceremony_recipes",
      "ceremony_recipe_preview",
    ])
      assert.equal(hints.get(name)?.readOnlyHint, true, name);
    for (const name of [
      "ceremony_cancel",
      "ceremony_author_delete",
      "ceremony_demonstration_consent",
    ])
      assert.equal(hints.get(name)?.destructiveHint, true, name);
    for (const name of ["ceremony_connect", "ceremony_recipe_execute"])
      assert.equal(hints.get(name)?.destructiveHint, false, name);
  } finally {
    await f.store.close();
  }
});

test("an authored connector is listed for its author over MCP, and for nobody else", async () => {
  const f = fixture();
  try {
    const mcp = handlerFor(f.runtime, byToken);
    await call(mcp, "author", initialize);
    const drafted = await invoke(
      mcp,
      "author",
      "ceremony_author_from_provider",
      {
        provider: "jira",
      },
    );
    assert.equal(drafted.isError, false, drafted.text);
    const result = drafted.value();
    assert.equal(result.ok, true);
    assert.equal(result.draft.connectorId, "jira");
    assert.doesNotMatch(drafted.text, /clientSecret|refreshToken|accessToken/);

    const read = await invoke(mcp, "author", "ceremony_author_read", {
      draftId: result.draft.id,
    });
    assert.equal(read.value().draft.id, result.draft.id);

    const mine = await invoke(mcp, "author", "ceremony_connectors");
    assert.deepEqual(mine.value().connectors.sort(), ["fixture", "jira"]);
    await call(mcp, "executor", initialize);
    const theirs = await invoke(mcp, "executor", "ceremony_connectors");
    assert.deepEqual(theirs.value().connectors, ["fixture"]);
    assert.equal(theirs.value().privateCollection, "web-application-only");

    // The same capability rule as `/authoring/*`: an executor reaching the
    // service directly is refused, and the refusal does not name a run.
    const refused = await authoringTransportFor(f.runtime, actor)
      .read(result.draft.id)
      .then(
        () => false,
        (error: unknown) => /denied/.test(String(error)),
      );
    assert.equal(refused, true);
  } finally {
    await f.store.close();
  }
});

test("an agent records a ceremony and compiles the recording into a recipe draft", async () => {
  const f = fixture();
  try {
    const mcp = handlerFor(f.runtime, byToken);
    await call(mcp, "author", initialize);
    const connected = await invoke(mcp, "author", "ceremony_connect", {
      connectorId: "fixture",
      teach: true,
    });
    assert.equal(connected.isError, false, connected.text);
    const run = connected.value();
    assert.equal(run.status, "complete");
    assert.equal(run.demonstration.consent, "recording");
    const demonstrationId = run.demonstration.id as string;

    const stopped = await invoke(
      mcp,
      "author",
      "ceremony_demonstration_consent",
      {
        demonstrationId,
        revision: run.demonstration.revision,
        consent: "stopped",
      },
    );
    assert.equal(stopped.value().consent, "stopped");

    const timeline = (
      await invoke(mcp, "author", "ceremony_demonstration_read", {
        demonstrationId,
      })
    ).value();
    const sequences = (timeline.events as Array<{ sequence: number }>).map(
      (event) => event.sequence,
    );
    assert.ok(sequences.length > 0, "the connect steps were not recorded");

    const compiled = await invoke(mcp, "author", "ceremony_draft_compile", {
      demonstrationId,
      first: Math.min(...sequences),
      last: Math.max(...sequences),
    });
    assert.equal(compiled.isError, false, compiled.text);
    const draft = compiled.value();
    assert.equal(draft.author, "author");
    assert.match(draft.id, /^draft-/);
    const reread = await invoke(mcp, "author", "ceremony_draft_read", {
      draftId: draft.id,
    });
    assert.equal(reread.value().digest, draft.digest);

    // Recording needs `author`; an executor asking to teach is refused before
    // any run is started for it.
    await call(mcp, "executor", initialize);
    const refused = await invoke(mcp, "executor", "ceremony_connect", {
      connectorId: "fixture",
      teach: true,
    });
    assert.equal(refused.isError, true);
  } finally {
    await f.store.close();
  }
});

test("an agent executes only a recipe a person published, and can then drive the run", async () => {
  const f = fixture();
  try {
    const mcp = handlerFor(f.runtime, byToken);
    await call(mcp, "author", initialize);
    const imported = await invoke(mcp, "author", "ceremony_draft_import", {
      definition: JSON.stringify(recipe),
    });
    assert.equal(imported.isError, false, imported.text);
    const draft = imported.value();

    // A draft is never executable, whatever an agent knows about it.
    const early = await invoke(mcp, "author", "ceremony_recipe_execute", {
      connectorId: "fixture",
      id: recipe.id,
      version: "1.0.1",
      digest: draft.digest,
      inputs: {},
    });
    assert.equal(early.isError, true);
    assert.equal(early.text, teachingRefusals.fallback);

    // A person reviews and publishes; no tool does this.
    await f.runtime.recipes.review(
      reviewer,
      draft.id,
      draft.revision,
      draft.digest,
    );
    const published = await f.runtime.recipes.publish(
      publisher,
      draft.id,
      draft.revision,
      draft.digest,
    );

    await call(mcp, "executor", initialize);
    const listed = (await invoke(mcp, "executor", "ceremony_recipes")).value()
      .recipes as Array<{ id: string; version: string }>;
    assert.deepEqual(
      listed.map((item) => [item.id, item.version]),
      [[recipe.id, published.version]],
    );
    const preview = await invoke(mcp, "executor", "ceremony_recipe_preview", {
      definition: recipe,
    });
    assert.deepEqual(preview.value().diagnostics, []);

    const executed = await invoke(mcp, "executor", "ceremony_recipe_execute", {
      connectorId: "fixture",
      id: recipe.id,
      version: published.version,
      digest: published.digest,
      inputs: {},
    });
    assert.equal(executed.isError, false, executed.text);
    const { run, delegated } = executed.value();
    assert.equal(delegated, true);
    const advanced = await invoke(mcp, "executor", "ceremony_advance", {
      runId: run.id,
      nodeId: "node",
      revision: run.revision,
      commandId: "execute-then-advance",
    });
    assert.equal(advanced.isError, false, advanced.text);
    assert.equal(advanced.value().status, "complete");

    // A private-looking input slot is refused, and the refusal does not echo it.
    const bound = await invoke(mcp, "executor", "ceremony_recipe_execute", {
      connectorId: "fixture",
      id: recipe.id,
      version: published.version,
      digest: published.digest,
      inputs: { password: "fixture-not-a-password" },
    });
    assert.equal(bound.isError, true);
    assert.doesNotMatch(bound.text, /fixture-not-a-password/);
  } finally {
    await f.store.close();
  }
});

/**
 * The example server mounts the connector intents without the four connector
 * tools. Status and connect then belong to the intents, and must be offered.
 */
test("connector intents mounted alone offer their own status and connect", async () => {
  const f = fixture();
  try {
    const intentsOnly = createCeremonyMcpHandler(f.runtime, {
      resourceUrl: endpoint,
      issuer,
      authenticate: () => actor,
      connectorIntents: {} as AgentConnectorDependencies,
    });
    const names = (await toolsFor(intentsOnly, "good")).map((t) => t.name);
    for (const name of [
      "connector_list",
      "connector_inspect",
      "connector_status",
      "connector_connect",
      "connector_operations",
      "connector_reconnect",
      "connector_disconnect",
    ])
      assert.ok(names.includes(name), `${name} is not offered`);
    assert.ok(!names.includes("connector_invoke"));
    assert.equal(new Set(names).size, names.length);
  } finally {
    await f.store.close();
  }
});

test("a run that waits on a person tells the MCP caller where that person continues", async () => {
  const f = fixture({ waitsOnPerson: true });
  try {
    const mcp = handlerFor(f.runtime, () => actor);
    await call(mcp, "good", initialize);
    const connected = await invoke(mcp, "good", "ceremony_connect", {
      connectorId: "fixture",
    });
    assert.equal(connected.isError, false, connected.text);
    const run = connected.value();
    assert.equal(run.nodes[0].state, "awaiting-human");
    // The coordinator's projection: kind, reason and the same-origin human
    // route, and nothing a person has not already got.
    const expected = {
      kind: "person",
      runId: run.id,
      nodeId: "node",
      operationId: "verify",
      nodeState: "awaiting-human",
      reason: "human-step",
      path: `/api/v1/teaching/fixture-provider/${encodeURIComponent(run.id)}/human`,
    };
    assert.deepEqual(run.handoff, expected);
    assert.doesNotMatch(connected.text, /[?&](code|state|token)=|https?:\/\//);

    const read = await invoke(mcp, "good", "ceremony_snapshot", {
      runId: run.id,
    });
    assert.deepEqual(read.value().handoff, expected);
  } finally {
    await f.store.close();
  }
});

test("a run nobody is waiting on carries no handoff", async () => {
  const f = fixture();
  try {
    const mcp = handlerFor(f.runtime, () => actor);
    await call(mcp, "good", initialize);
    const connected = await invoke(mcp, "good", "ceremony_connect", {
      connectorId: "fixture",
    });
    assert.equal(connected.value().status, "complete");
    assert.equal(connected.value().handoff, undefined);
  } finally {
    await f.store.close();
  }
});

test("an assistant proposes how an authored connector's credential is verified; only a person makes it take effect", async () => {
  // The browser's actor is the same subject as the MCP author, as a person
  // and their assistant are.
  const person: ActorContext = { ...author, actorKind: "human" };
  const f = fixture({ person: () => person });
  try {
    const mcp = handlerFor(f.runtime, (token) =>
      token === "author" ? { ...author, actorKind: "agent" } : byToken(token),
    );
    const names = (await toolsFor(mcp, "author")).map((t) => t.name);
    assert.ok(names.includes("ceremony_author_verification_propose"));
    assert.ok(
      !names.some((name) => /verification_(approve|publish)/.test(name)),
      "no tool approves a declaration",
    );
    assert.ok(
      !(await toolsFor(mcp, "executor"))
        .map((t) => t.name)
        .includes("ceremony_author_verification_propose"),
    );
    const drafted = await invoke(
      mcp,
      "author",
      "ceremony_author_from_provider",
      { provider: "acme", origin: "https://acme.example" },
    );
    assert.equal(drafted.value().draft.connectorId, "acme");
    const declaration = {
      url: "https://acme.example/v1/me",
      placement: { in: "header", name: "Authorization", prefix: "Bearer " },
    };

    // The same checks the direct declaration always ran: HTTPS, an origin
    // the provider declared, no forbidden header, the author's own connector.
    for (const bad of [
      { ...declaration, url: "https://attacker.example/collect" },
      { ...declaration, url: "http://acme.example/v1/me" },
      { ...declaration, placement: { in: "header", name: "Cookie" } },
    ]) {
      const refused = await invoke(
        mcp,
        "author",
        "ceremony_author_verification_propose",
        { connectorId: "acme", declaration: bad },
      );
      assert.equal(refused.isError, true, JSON.stringify(bad));
    }
    const elsewhere = await invoke(
      mcp,
      "author",
      "ceremony_author_verification_propose",
      { connectorId: "someone-elses", declaration },
    );
    assert.equal(elsewhere.isError, true);

    const proposed = await invoke(
      mcp,
      "author",
      "ceremony_author_verification_propose",
      { connectorId: "acme", declaration },
    );
    assert.equal(proposed.isError, false, proposed.text);
    const { digest, state } = proposed.value();
    assert.equal(state, "pending-review");
    assert.match(digest, /^[a-f0-9]{64}$/);
    // Pending verifies nothing.
    const pending = await installedDiscovery(f.store, person, "acme");
    assert.equal(pending?.credentialVerification, undefined);
    assert.equal(pending?.pendingCredentialVerification?.digest, digest);

    // An assistant cannot approve, whatever it holds.
    await assert.rejects(
      approveCredentialVerification(
        f.runtime,
        { ...author, actorKind: "agent", capabilities: ["admin"] },
        "acme",
        { digest },
      ),
      /denied/,
    );

    const http = (path: string, body: unknown) =>
      teachingHttp(
        new Request(`${context.origin}/api/v1/teaching${path}`, {
          method: "POST",
          headers: {
            origin: context.origin,
            "content-type": "application/json",
          },
          body: JSON.stringify(body),
        }),
        f.runtime,
      );
    const route = "/authoring/installed/acme/credential-verification";
    // The HTTP route proposes with the same validation, and a person
    // approves exactly what was proposed, by digest.
    assert.equal(
      (
        await http(route, {
          ...declaration,
          url: "https://attacker.example/collect",
        })
      ).status,
      403,
    );
    assert.equal(
      (await http(`${route}/approve`, { digest: "0".repeat(64) })).status,
      400,
    );
    const approved = await http(`${route}/approve`, { digest });
    assert.equal(approved.status, 200);
    assert.deepEqual(await approved.json(), {
      connectorId: "acme",
      state: "active",
      digest,
    });
    const active = await installedDiscovery(f.store, person, "acme");
    assert.deepEqual(active?.credentialVerification, declaration);
    assert.equal(active?.pendingCredentialVerification, undefined);
    // Nothing is left to approve twice.
    assert.equal((await http(`${route}/approve`, { digest })).status, 403);
  } finally {
    await f.store.close();
  }
});

test("the endpoint throttles each actor per tool and says when to retry", async () => {
  const f = fixture();
  try {
    let at = 5_000_000;
    const mcp = createCeremonyMcpHandler(f.runtime, {
      resourceUrl: endpoint,
      issuer,
      authenticate: (token) => byToken(token),
      rateLimit: {
        capacity: 2,
        refillPerSecond: 0.1,
        tools: { ceremony_recipes: { capacity: 1 } },
        now: () => at,
      },
    });
    await call(mcp, "executor", initialize);
    for (let i = 0; i < 2; i++)
      assert.equal(
        (await invoke(mcp, "executor", "ceremony_connectors")).isError,
        false,
      );
    const refused = await rpc<
      ToolResult & { structuredContent?: Record<string, unknown> }
    >(mcp, "executor", "tools/call", {
      name: "ceremony_connectors",
      arguments: {},
    });
    assert.equal(refused.isError, true);
    assert.deepEqual(refused.structuredContent, {
      error: "rate-limited",
      tool: "ceremony_connectors",
      retryAfterSeconds: 10,
    });
    assert.equal(JSON.parse(refused.content[0]!.text).error, "rate-limited");

    // Another tool, and another actor, have their own budgets; a per-tool
    // override applies to its tool.
    assert.equal(
      (await invoke(mcp, "executor", "ceremony_recipes")).isError,
      false,
    );
    assert.equal(
      (await invoke(mcp, "executor", "ceremony_recipes")).isError,
      true,
    );
    await call(mcp, "author", initialize);
    assert.equal(
      (await invoke(mcp, "author", "ceremony_connectors")).isError,
      false,
    );

    // The budget outlives the per-request server, and refills with time.
    at += 10_000;
    assert.equal(
      (await invoke(mcp, "executor", "ceremony_connectors")).isError,
      false,
    );

    // A host that throttles in front of the endpoint can turn it off.
    const open = createCeremonyMcpHandler(f.runtime, {
      resourceUrl: endpoint,
      issuer,
      authenticate: (token) => byToken(token),
      rateLimit: false,
    });
    for (let i = 0; i < 40; i++)
      assert.equal(
        (await invoke(open, "executor", "ceremony_connectors")).isError,
        false,
      );
  } finally {
    await f.store.close();
  }
});

test("ceremony_recipes lists every recipe past one page, at its latest unretired version", async () => {
  const f = fixture();
  try {
    const row = (id: string, version: string, retired = false) => ({
      key: {
        tenant: actor.tenantId,
        kind: "recipe" as const,
        id: `${id}@${version}`,
      },
      value: {
        definition: { ...recipe, id, title: id },
        version,
        digest: `digest-${id}-${version}`,
        closure: {},
        retired,
        publisher: "publisher",
      },
    });
    const rows = [
      ...Array.from({ length: 150 }, (_, index) =>
        row(`recipe-${String(index).padStart(3, "0")}`, "1.0.1"),
      ),
      // A newer version supersedes; a retired newer one does not.
      row("recipe-001", "1.0.2"),
      row("recipe-002", "1.0.2", true),
      row("recipe-003", "1.0.1", true),
    ];
    await f.store.transaction(async (tx) => {
      for (const entry of rows) {
        const prior = await tx.get(entry.key);
        await tx.put(entry.key, entry.value, prior?.revision ?? null);
      }
    });
    const mcp = handlerFor(f.runtime, byToken);
    await call(mcp, "executor", initialize);
    const listed = (await invoke(mcp, "executor", "ceremony_recipes")).value()
      .recipes as Array<{ id: string; version: string }>;
    const versions = new Map(listed.map((item) => [item.id, item.version]));
    assert.equal(listed.length, versions.size, "one entry per recipe");
    assert.equal(versions.size, 149);
    assert.equal(versions.get("recipe-149"), "1.0.1");
    assert.equal(versions.get("recipe-001"), "1.0.2");
    assert.equal(versions.get("recipe-002"), "1.0.1");
    assert.equal(versions.has("recipe-003"), false);
  } finally {
    await f.store.close();
  }
});
