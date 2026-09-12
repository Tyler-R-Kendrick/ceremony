import assert from "node:assert/strict";
import { test } from "node:test";
import { randomBytes } from "node:crypto";
import { z } from "zod";
import { createTeachingRuntime } from "../src/server/teaching-runtime.js";
import { OperationRegistry } from "../src/server/recipes/registry.js";
import { SQLiteCeremonyStore } from "../src/server/persistence/index.js";
import { createCeremonyMcpHandler } from "../src/server/mcp.js";
import { ceremonyAgentTools } from "../src/server/agent-tools.js";
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

function fixture() {
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
    handler: async () => ({ state: "complete" as const, outputs: {} }),
    verify: async () => true,
  });
  const runtime = createTeachingRuntime({
    store,
    registry,
    identity: { authenticate: async () => actor },
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
