import assert from "node:assert/strict";
import { test } from "node:test";
import { randomBytes } from "node:crypto";
import { z } from "zod";
import { createCeremonyMcpHandler } from "../../../src/server/mcp.js";
import { createTeachingRuntime } from "../../../src/server/teaching-runtime.js";
import { OperationRegistry } from "../../../src/server/recipes/registry.js";
import { SQLiteCeremonyStore } from "../../../src/server/persistence/index.js";
import type { ActorContext } from "../../../src/core/operation-contracts.js";
import type { RecipeDefinition } from "../../../src/core/recipe-contracts.js";
import type { ConnectorToolDependencies } from "../../../src/server/connectors/mcp/server-tools.js";
import { connectorServerToolNames } from "../../../src/server/connectors/mcp/server-tools.js";
import {
  catalogEntrySchema,
  connectionSummarySchema,
} from "../../../src/core/connectors/index.js";

/*
 * The connector tools on Ceremony's own MCP server. The five existing tools
 * must still be there and still behave, the new four must be reachable only
 * with host authentication, and nothing a model can read may carry a
 * credential, a destination or a handoff link. The actor is asserted to come
 * from the authenticate path: a forged one in the arguments changes nothing.
 */

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

function runtimeFixture() {
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

const catalogEntry = catalogEntrySchema.parse({
  id: "mcp-remote",
  ecosystem: "mcp",
  service: "mcp",
  displayName: "MCP server",
  description: "A remote MCP server",
  support: "provider-backed",
  custody: ["host-owned"],
  runtimes: ["hosted-server"],
  authentication: ["oauth-authorization-code"],
  configuration: [],
  capabilities: [
    {
      dimension: "invoke",
      profile: "mcp-2026-07-28",
      adapterVersion: "1.0.0",
      runtime: "hosted-server",
      implementation: "implemented",
      configuration: "ready",
      evidence: "protocol-fixture",
      limitations: [],
    },
  ],
  evidence: "protocol-fixture",
  group: "mcp",
});

const connection = connectionSummarySchema.parse({
  connectionRef: "connection:1",
  bindingRef: "binding:mcp",
  definitionRef: "definition:mcp",
  ecosystem: "mcp",
  service: "mcp",
  displayName: "Fixture MCP server",
  ownerKind: "user",
  custody: "host-owned",
  runtime: "hosted-server",
  lifecycle: "active",
  generation: 1,
  revision: 2,
  target: { kind: "mcp-server", id: "https://mcp.example" },
  verification: {
    kinds: ["credential-accepted"],
    observedAt: "2026-09-18T00:00:00.000Z",
    limitations: ["server identity not attested beyond TLS origin"],
  },
  createdAt: "2026-09-18T00:00:00.000Z",
  updatedAt: "2026-09-18T00:00:00.000Z",
});

type Seen = {
  actors: ActorContext[];
  invokes: unknown[];
  connects: unknown[];
  verifies?: string[];
  revocations?: string[];
};

function dependencies(seen: Seen): ConnectorToolDependencies {
  return {
    async catalog(who) {
      seen.actors.push(who);
      return [catalogEntry];
    },
    async status(who, connectionRef) {
      seen.actors.push(who);
      return connectionRef === connection.connectionRef
        ? connection
        : undefined;
    },
    async connect(who, input) {
      seen.actors.push(who);
      seen.connects.push(input);
      return {
        connectionRef: connection.connectionRef,
        lifecycle: "human-required",
        handoff: { kind: "provider-browser", state: "issued" },
      };
    },
    async verify(who, connectionRef) {
      seen.actors.push(who);
      (seen.verifies ??= []).push(connectionRef);
      return connectionRef === connection.connectionRef
        ? connection
        : undefined;
    },
    async requestRevocation(who, connectionRef) {
      seen.actors.push(who);
      (seen.revocations ??= []).push(connectionRef);
      return {
        connectionRef,
        revocation: "pending-approval",
        requestedAt: "2026-09-23T00:00:00.000Z",
      };
    },
    async invoke(who, input) {
      seen.actors.push(who);
      seen.invokes.push(input);
      if (input.operationRef === "op:personal")
        return {
          state: "complete",
          outputClassification: "personal",
          effect: "read",
          output: { email: "person@example.test" },
        };
      if (input.operationRef === "op:personal-consented")
        return {
          state: "complete",
          outputClassification: "personal",
          effect: "read",
          output: { email: "person@example.test" },
          agentOutputConsent: "personal",
        };
      if (input.operationRef === "op:secret-claiming-consent")
        return {
          state: "complete",
          outputClassification: "secret",
          effect: "read",
          output: { token: "super-secret-value" },
          agentOutputConsent: "personal",
        };
      return input.operationRef === "op:secret"
        ? {
            state: "complete",
            outputClassification: "secret",
            effect: "read",
            output: { token: "super-secret-value" },
          }
        : {
            state: "complete",
            outputClassification: "public",
            effect: "read",
            output: { content: [{ type: "text", text: "hi" }] },
          };
    },
  };
}

function handlerFor(
  runtime: ReturnType<typeof runtimeFixture>["runtime"],
  options: {
    connectors?: ConnectorToolDependencies;
    authenticate?: (token: string) => ActorContext | null;
  } = {},
) {
  return createCeremonyMcpHandler(runtime, {
    resourceUrl: endpoint,
    issuer,
    authenticate: (token) =>
      options.authenticate ? options.authenticate(token) : actor,
    ...(options.connectors ? { connectors: options.connectors } : {}),
  });
}

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

async function call(
  mcp: ReturnType<typeof createCeremonyMcpHandler>,
  token: string | undefined,
  body: unknown,
): Promise<Response | undefined> {
  return mcp.fetch(
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
}

/** The tool result text of a JSON or SSE response from the ceremony server. */
async function resultText(response: Response | undefined): Promise<string> {
  const text = await response!.text();
  const line = text
    .split("\n")
    .map((entry) => (entry.startsWith("data:") ? entry.slice(5).trim() : entry))
    .filter((entry) => entry.startsWith("{"))
    .pop();
  const payload = JSON.parse(line ?? "{}") as {
    result?: { content?: Array<{ text?: string }>; isError?: boolean };
  };
  return payload.result?.content?.[0]?.text ?? "";
}

test("the five existing tools are untouched and the four connector tools appear beside them", async () => {
  const f = runtimeFixture();
  try {
    const seen: Seen = { actors: [], invokes: [], connects: [] };
    const mcp = handlerFor(f.runtime, { connectors: dependencies(seen) });
    await call(mcp, "good", initialize);
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
      ...connectorServerToolNames,
    ])
      assert.ok(text.includes(name), `${name} is not offered`);
  } finally {
    await f.store.close();
  }
});

test("without the option the server is exactly as it was", async () => {
  const f = runtimeFixture();
  try {
    const mcp = handlerFor(f.runtime);
    await call(mcp, "good", initialize);
    const listed = await call(mcp, "good", {
      jsonrpc: "2.0",
      id: 2,
      method: "tools/list",
      params: {},
    });
    const text = await listed!.text();
    for (const name of connectorServerToolNames)
      assert.ok(!text.includes(name));
    assert.ok(text.includes("ceremony_connect"));
  } finally {
    await f.store.close();
  }
});

test("a connector tool cannot be reached without host authentication", async () => {
  const f = runtimeFixture();
  try {
    const seen: Seen = { actors: [], invokes: [], connects: [] };
    const mcp = handlerFor(f.runtime, { connectors: dependencies(seen) });
    const anonymous = await call(mcp, undefined, {
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: { name: "connector_catalog", arguments: {} },
    });
    assert.equal(anonymous?.status, 401);
    assert.match(
      anonymous!.headers.get("www-authenticate") ?? "",
      /^Bearer resource_metadata="https:\/\/app\.example\/\.well-known\/oauth-protected-resource/,
    );

    const refused = handlerFor(f.runtime, {
      connectors: dependencies(seen),
      authenticate: () => null,
    });
    const rejected = await call(refused, "forged", {
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: { name: "connector_catalog", arguments: {} },
    });
    assert.equal(rejected?.status, 401);
    assert.equal(
      seen.actors.length,
      0,
      "no unauthenticated call reaches the service",
    );
  } finally {
    await f.store.close();
  }
});

test("an actor named in the arguments is refused rather than believed", async () => {
  const f = runtimeFixture();
  try {
    const seen: Seen = { actors: [], invokes: [], connects: [] };
    const mcp = handlerFor(f.runtime, { connectors: dependencies(seen) });
    await call(mcp, "good", initialize);
    const response = await call(mcp, "good", {
      jsonrpc: "2.0",
      id: 3,
      method: "tools/call",
      params: {
        name: "connector_status",
        arguments: {
          connectionRef: connection.connectionRef,
          tenantId: "other-tenant",
          subjectId: "somebody-else",
          actor: { tenantId: "other-tenant", subjectId: "somebody-else" },
        },
      },
    });
    const text = await response!.text();
    // The strict argument schema refuses the extra fields outright.
    assert.ok(text.includes("not valid") || text.includes("isError"));
    for (const who of seen.actors) {
      assert.equal(who.tenantId, actor.tenantId);
      assert.equal(who.subjectId, actor.subjectId);
    }
  } finally {
    await f.store.close();
  }
});

test("catalog and status answer with public projections only", async () => {
  const f = runtimeFixture();
  try {
    const seen: Seen = { actors: [], invokes: [], connects: [] };
    const mcp = handlerFor(f.runtime, { connectors: dependencies(seen) });
    await call(mcp, "good", initialize);

    const catalog = JSON.parse(
      await resultText(
        await call(mcp, "good", {
          jsonrpc: "2.0",
          id: 4,
          method: "tools/call",
          params: { name: "connector_catalog", arguments: {} },
        }),
      ),
    ) as { connectors: Array<{ id: string; evidence: string }> };
    assert.equal(catalog.connectors[0]?.id, "mcp-remote");
    assert.equal(catalog.connectors[0]?.evidence, "protocol-fixture");

    const status = JSON.parse(
      await resultText(
        await call(mcp, "good", {
          jsonrpc: "2.0",
          id: 5,
          method: "tools/call",
          params: {
            name: "connector_status",
            arguments: { connectionRef: connection.connectionRef },
          },
        }),
      ),
    ) as Record<string, unknown>;
    assert.equal(status.connectionRef, connection.connectionRef);
    assert.equal(status.verified, true);
    assert.equal(status.targetKind, "mcp-server");
    // The agent projection carries no target identity, no verification detail
    // and no destination.
    assert.equal(status.target, undefined);
    assert.equal(status.displayName, undefined);
    assert.equal(JSON.stringify(status).includes("mcp.example"), false);

    assert.equal(seen.actors.length, 2);
    for (const who of seen.actors) assert.equal(who.subjectId, actor.subjectId);
  } finally {
    await f.store.close();
  }
});

test("connect returns the handoff and the owner's page path, never a provider link or code", async () => {
  const f = runtimeFixture();
  try {
    const seen: Seen = { actors: [], invokes: [], connects: [] };
    const mcp = handlerFor(f.runtime, { connectors: dependencies(seen) });
    await call(mcp, "good", initialize);
    const text = await resultText(
      await call(mcp, "good", {
        jsonrpc: "2.0",
        id: 6,
        method: "tools/call",
        params: {
          name: "connector_connect",
          arguments: { connectorId: "mcp-remote" },
        },
      }),
    );
    const outcome = JSON.parse(text) as {
      connectionRef: string;
      lifecycle: string;
      handoff: { kind: string; state: string; path: string };
    };
    assert.deepEqual(outcome, {
      connectionRef: connection.connectionRef,
      lifecycle: "human-required",
      handoff: {
        kind: "provider-browser",
        state: "issued",
        // The owner's own page for this connection, same origin, reference only.
        path: "/connectors?connection=connection%3A1",
      },
    });
    assert.equal(
      text.includes("http"),
      false,
      "no absolute or provider URL may appear in a tool result",
    );
    assert.deepEqual(seen.connects, [{ connectorId: "mcp-remote" }]);
  } finally {
    await f.store.close();
  }
});

test("invoke names an approved operation and withholds output the policy does not publish", async () => {
  const f = runtimeFixture();
  try {
    const seen: Seen = { actors: [], invokes: [], connects: [] };
    const mcp = handlerFor(f.runtime, { connectors: dependencies(seen) });
    await call(mcp, "good", initialize);

    const open = JSON.parse(
      await resultText(
        await call(mcp, "good", {
          jsonrpc: "2.0",
          id: 7,
          method: "tools/call",
          params: {
            name: "connector_invoke",
            arguments: {
              connectionRef: connection.connectionRef,
              operationRef: "op:echo",
              input: { text: "hi" },
              commandId: "command-1",
            },
          },
        }),
      ),
    ) as { state: string; output: unknown; outputClassification: string };
    assert.equal(open.state, "complete");
    assert.equal(open.outputClassification, "public");
    assert.deepEqual(open.output, { content: [{ type: "text", text: "hi" }] });

    const secret = await resultText(
      await call(mcp, "good", {
        jsonrpc: "2.0",
        id: 8,
        method: "tools/call",
        params: {
          name: "connector_invoke",
          arguments: {
            connectionRef: connection.connectionRef,
            operationRef: "op:secret",
            input: {},
            commandId: "command-2",
          },
        },
      }),
    );
    assert.equal(secret.includes("super-secret-value"), false);
    assert.ok(secret.includes("withheld-by-policy"));

    assert.deepEqual(seen.invokes[0], {
      connectionRef: connection.connectionRef,
      operationRef: "op:echo",
      input: { text: "hi" },
      commandId: "command-1",
    });
  } finally {
    await f.store.close();
  }
});

test("a failure from the service is explained without upstream text", async () => {
  const f = runtimeFixture();
  try {
    const seen: Seen = { actors: [], invokes: [], connects: [] };
    const deps = dependencies(seen);
    const mcp = handlerFor(f.runtime, {
      connectors: {
        ...deps,
        async invoke() {
          throw new Error("provider said: token sk-live-123 is invalid");
        },
      },
    });
    await call(mcp, "good", initialize);
    const text = await resultText(
      await call(mcp, "good", {
        jsonrpc: "2.0",
        id: 9,
        method: "tools/call",
        params: {
          name: "connector_invoke",
          arguments: {
            connectionRef: connection.connectionRef,
            operationRef: "op:echo",
            input: {},
            commandId: "command-3",
          },
        },
      }),
    );
    assert.equal(text.includes("sk-live-123"), false);
    assert.ok(text.length > 0);
  } finally {
    await f.store.close();
  }
});

async function callTool(
  mcp: ReturnType<typeof createCeremonyMcpHandler>,
  name: string,
  args: Record<string, unknown>,
) {
  return resultText(
    await call(mcp, "good", {
      jsonrpc: "2.0",
      id: 20,
      method: "tools/call",
      params: { name, arguments: args },
    }),
  );
}

test("connector tools carry MCP annotations that match what they do", async () => {
  const f = runtimeFixture();
  try {
    const seen: Seen = { actors: [], invokes: [], connects: [] };
    const mcp = handlerFor(f.runtime, { connectors: dependencies(seen) });
    await call(mcp, "good", initialize);
    const listed = await call(mcp, "good", {
      jsonrpc: "2.0",
      id: 2,
      method: "tools/list",
      params: {},
    });
    const body = await listed!.text();
    const line = body
      .split("\n")
      .map((entry) =>
        entry.startsWith("data:") ? entry.slice(5).trim() : entry,
      )
      .filter((entry) => entry.startsWith("{"))
      .pop();
    const tools = (
      JSON.parse(line!) as {
        result: {
          tools: Array<{ name: string; annotations?: Record<string, boolean> }>;
        };
      }
    ).result.tools;
    const hints = (name: string) =>
      tools.find((tool) => tool.name === name)?.annotations ?? {};
    for (const name of connectorServerToolNames)
      assert.ok(
        Object.keys(hints(name)).length > 0,
        `${name} has no annotations`,
      );
    assert.equal(hints("connector_catalog").readOnlyHint, true);
    assert.equal(hints("connector_status").readOnlyHint, true);
    assert.equal(hints("connector_invoke").readOnlyHint, false);
    assert.equal(hints("connector_revoke_request").destructiveHint, false);
    assert.equal(hints("connector_verify").destructiveHint, false);
  } finally {
    await f.store.close();
  }
});

test("connector_verify refreshes evidence through the service and returns the agent projection", async () => {
  const f = runtimeFixture();
  try {
    const seen: Seen = { actors: [], invokes: [], connects: [] };
    const mcp = handlerFor(f.runtime, { connectors: dependencies(seen) });
    await call(mcp, "good", initialize);
    const view = JSON.parse(
      await callTool(mcp, "connector_verify", {
        connectionRef: connection.connectionRef,
      }),
    ) as Record<string, unknown>;
    assert.deepEqual(seen.verifies, [connection.connectionRef]);
    assert.equal(view.verified, true);
    assert.equal(view.target, undefined);
    assert.equal(JSON.stringify(view).includes("mcp.example"), false);
  } finally {
    await f.store.close();
  }
});

test("connector_revoke_request queues a request for a person and revokes nothing", async () => {
  const f = runtimeFixture();
  try {
    const seen: Seen = { actors: [], invokes: [], connects: [] };
    const mcp = handlerFor(f.runtime, { connectors: dependencies(seen) });
    await call(mcp, "good", initialize);
    const outcome = JSON.parse(
      await callTool(mcp, "connector_revoke_request", {
        connectionRef: connection.connectionRef,
      }),
    ) as Record<string, unknown>;
    assert.deepEqual(outcome, {
      connectionRef: connection.connectionRef,
      revocation: "pending-approval",
      requestedAt: "2026-09-23T00:00:00.000Z",
      approval: {
        kind: "person",
        path: "/connectors?connection=connection%3A1",
      },
    });
    assert.deepEqual(seen.revocations, [connection.connectionRef]);
  } finally {
    await f.store.close();
  }
});

test("personal output needs the binding's owner consent and secret output never leaves", async () => {
  const f = runtimeFixture();
  try {
    const seen: Seen = { actors: [], invokes: [], connects: [] };
    const mcp = handlerFor(f.runtime, { connectors: dependencies(seen) });
    await call(mcp, "good", initialize);
    const invoke = async (operationRef: string, commandId: string) =>
      callTool(mcp, "connector_invoke", {
        connectionRef: connection.connectionRef,
        operationRef,
        input: {},
        commandId,
      });
    const withheld = await invoke("op:personal", "c-1");
    assert.equal(withheld.includes("person@example.test"), false);
    assert.ok(withheld.includes("withheld-by-policy"));

    const released = JSON.parse(
      await invoke("op:personal-consented", "c-2"),
    ) as Record<string, unknown>;
    assert.deepEqual(released.output, { email: "person@example.test" });
    assert.equal(released.agentOutputConsent, "personal");

    const secret = await invoke("op:secret-claiming-consent", "c-3");
    assert.equal(secret.includes("super-secret-value"), false);
    assert.ok(secret.includes("withheld-by-policy"));
  } finally {
    await f.store.close();
  }
});

test("verify and revoke-request are offered only when the host supplies them", async () => {
  const f = runtimeFixture();
  try {
    const seen: Seen = { actors: [], invokes: [], connects: [] };
    const {
      verify: _verify,
      requestRevocation: _revoke,
      ...base
    } = dependencies(seen);
    void _verify;
    void _revoke;
    const mcp = handlerFor(f.runtime, { connectors: base });
    await call(mcp, "good", initialize);
    const listed = await call(mcp, "good", {
      jsonrpc: "2.0",
      id: 2,
      method: "tools/list",
      params: {},
    });
    const text = await listed!.text();
    assert.ok(text.includes("connector_invoke"));
    assert.equal(text.includes("connector_verify"), false);
    assert.equal(text.includes("connector_revoke_request"), false);
  } finally {
    await f.store.close();
  }
});
