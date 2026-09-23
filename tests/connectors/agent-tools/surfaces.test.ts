import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import test from "node:test";
import type { McpServer } from "@modelcontextprotocol/server";
import type { ActorContext } from "../../../src/core/operation-contracts.js";
import { connectorServerToolNames } from "../../../src/server/connectors/mcp/server-tools.js";
import {
  DelegationStopRegistry,
  agentConnectorToolNames,
  createContinuationGuard,
  registerAgentConnectorTools,
  type AgentConnectorDependencies,
  type ContinuationConnection,
} from "../../../src/server/connectors/agents/index.js";
import { ConnectorError } from "../../../src/server/connectors/errors.js";
import {
  buildBinding,
  buildConnectionSummary,
  buildDefinition,
} from "../fixtures/builders.js";
import { fixtureActor } from "../doubles/ports.js";
import { SKILL, activeConnection, harness } from "../a2a/harness.js";

/*
 * The seams themselves: the intents mounted on the existing MCP server
 * without disturbing the tools already there, and one continuation gate
 * proven against a real A2A delegation rather than only against the pure
 * decision function.
 */

type Registered = {
  name: string;
  config: { description: string; inputSchema: unknown };
  handler: (input: unknown) => Promise<unknown>;
};

function fakeServer() {
  const tools: Registered[] = [];
  const server = {
    registerTool(
      name: string,
      config: { description: string; inputSchema: unknown },
      handler: (input: unknown) => Promise<unknown>,
    ) {
      if (tools.some((tool) => tool.name === name))
        throw new Error(`duplicate tool ${name}`);
      tools.push({ name, config, handler });
    },
  };
  return {
    tools,
    server: server as unknown as McpServer,
    /** Stands in for a tool some other module already mounted on this server. */
    preRegister(name: string) {
      server.registerTool(
        name,
        { description: name, inputSchema: {} },
        async () => ({}),
      );
    },
  };
}

const deps: AgentConnectorDependencies = {
  async list() {
    return [buildConnectionSummary()];
  },
  async definition() {
    return buildDefinition();
  },
  async status() {
    return buildConnectionSummary();
  },
  async connect() {
    return buildConnectionSummary();
  },
  async operations() {
    return buildBinding().operations;
  },
  async reconnect() {
    return buildConnectionSummary();
  },
  async disconnect() {
    return {
      local: "applied",
      broker: "not-attempted",
      upstream: "unsupported",
    };
  },
};

const textOf = (result: unknown) =>
  (result as { content: Array<{ text: string }> }).content[0]!.text;

test("AG-03: the intents mount beside the connector tools already on the MCP server and take none of their names", () => {
  const { tools, server, preRegister } = fakeServer();
  // The MCP swarm's four tools are registered first, as the integrator mounts them.
  for (const name of connectorServerToolNames) preRegister(name);
  const before = tools.length;
  const added = registerAgentConnectorTools(server, deps, {
    actor: () => fixtureActor,
    taken: connectorServerToolNames,
  });
  assert.deepEqual(added, [...agentConnectorToolNames]);
  assert.equal(tools.length, before + 5);
  // The four that were there are untouched and were not re-registered.
  for (const name of connectorServerToolNames)
    assert.equal(tools.filter((tool) => tool.name === name).length, 1, name);
  for (const tool of tools.slice(before))
    assert.ok(tool.config.description.length > 20, tool.name);
});

/**
 * Only names that are actually on the server are skipped. A host that mounts
 * the intents without the four connector tools (as the example server does)
 * would otherwise lose `connector_status` and `connector_connect` entirely:
 * skipped because a tool of that name was assumed, and never registered by
 * anything else.
 */
test("AG-03: without the connector tools mounted, the intents register status and connect too", () => {
  const { tools, server } = fakeServer();
  const added = registerAgentConnectorTools(server, deps, {
    actor: () => fixtureActor,
  });
  assert.deepEqual(added.sort(), [
    "connector_connect",
    "connector_disconnect",
    "connector_inspect",
    "connector_list",
    "connector_operations",
    "connector_reconnect",
    "connector_status",
  ]);
  assert.equal(tools.length, 7);
});

test("AG-03: an MCP intent without an authenticated actor refuses, and a failure never echoes upstream text", async () => {
  const { tools, server } = fakeServer();
  let actor: ActorContext | undefined;
  registerAgentConnectorTools(
    server,
    {
      ...deps,
      async list() {
        throw new ConnectorError("upstream-rejected", { detail: "provider.x" });
      },
    },
    { actor: () => actor },
  );
  const list = tools.find((tool) => tool.name === "connector_list")!;
  const refused = (await list.handler({})) as { isError?: true };
  assert.equal(refused.isError, true);
  assert.match(textOf(refused), /Sign in/);

  actor = fixtureActor;
  const failed = (await list.handler({})) as { isError?: true };
  assert.equal(failed.isError, true);
  assert.equal(textOf(failed), "The provider rejected this request.");
  assert.doesNotMatch(textOf(failed), /provider\.x/);
});

test("AG-03: an MCP intent answers with the agent projection and nothing else", async () => {
  const { tools, server } = fakeServer();
  registerAgentConnectorTools(server, deps, { actor: () => fixtureActor });
  const operations = tools.find(
    (tool) => tool.name === "connector_operations",
  )!;
  const answer = JSON.parse(
    textOf(await operations.handler({ connectionRef: "connection:1" })),
  ) as { operations: Array<Record<string, unknown>> };
  assert.deepEqual(Object.keys(answer.operations[0]!).sort(), [
    "consent",
    "cost",
    "effect",
    "operationRef",
    "outputClassification",
    "replay",
    "targetParameters",
  ]);
  const inspect = tools.find((tool) => tool.name === "connector_inspect")!;
  const invalid = (await inspect.handler({ definitionRef: "" })) as {
    isError?: true;
  };
  assert.equal(invalid.isError, true);
});

test("an MCP intent that leaves a person waiting names the owner's page, and nothing that grants anything", async () => {
  const waitingSummary = buildConnectionSummary({
    lifecycle: "human-required",
    handoff: {
      handoffRef: "handoff:canary-ref",
      kind: "provider-browser",
      state: "waiting",
      presentation: "popup",
      expiresAt: "2026-09-23T01:00:00.000Z",
      generation: 0,
    },
  });
  const settled = buildConnectionSummary({
    connectionRef: "connection:2",
    handoff: {
      handoffRef: "handoff:settled",
      kind: "device-code",
      state: "completed",
      presentation: "second-device",
      expiresAt: "2026-09-23T01:00:00.000Z",
      generation: 0,
    },
  });
  const { tools, server } = fakeServer();
  registerAgentConnectorTools(
    server,
    {
      ...deps,
      async list() {
        return [waitingSummary, settled];
      },
      async reconnect() {
        return waitingSummary;
      },
      async status() {
        return waitingSummary;
      },
    },
    { actor: () => fixtureActor, humanRoute: "/app/connectors" },
  );
  const handler = (name: string) =>
    tools.find((tool) => tool.name === name)!.handler;
  const expected = {
    kind: "provider-browser",
    state: "waiting",
    path: "/app/connectors?connection=connection%3A1",
  };
  for (const [name, input] of [
    [
      "connector_reconnect",
      { connectionRef: "connection:1", expectedRevision: 3 },
    ],
    ["connector_status", { connectionRef: "connection:1" }],
  ] as const) {
    const text = textOf(await handler(name)(input));
    assert.deepEqual(JSON.parse(text).handoff, expected, name);
    assert.doesNotMatch(text, /canary-ref|handoffRef|expiresAt|https?:/, name);
  }
  const listed = JSON.parse(textOf(await handler("connector_list")({}))) as {
    connections: Array<{ handoff?: Record<string, string> }>;
  };
  assert.deepEqual(listed.connections[0]!.handoff, expected);
  // A handoff nobody is waiting on any more has no page to open.
  assert.deepEqual(listed.connections[1]!.handoff, {
    kind: "device-code",
    state: "completed",
  });
});

test("AC-AG-04: after the assistant is stopped, an A2A delegation is refused by the same gate every other surface uses", async () => {
  const kit = await harness();
  try {
    const connection = await activeConnection(kit.ports, kit.binding);
    const stops = new DelegationStopRegistry();
    const view: ContinuationConnection = {
      connectionRef: connection.connectionRef,
      tenantId: connection.tenantId,
      ownerId: connection.ownerId,
      lifecycle: connection.lifecycle,
      generation: connection.generation,
      bindingRevision: connection.bindingRevision,
      policyRevision: connection.policyRevision,
      configurationRevision: connection.configurationRevision,
    };
    const guard = createContinuationGuard({
      stops,
      now: () => Date.now(),
      connection: async () => view,
    });
    const delegateOnce = async () => {
      await guard.assert({
        surface: "a2a",
        actor: kit.actor,
        intent: "delegate",
        connectionRef: connection.connectionRef,
        observed: { generation: connection.generation },
      });
      return kit.adapter.delegate!(kit.context({ connection }), {
        action: "start",
        skill: SKILL,
        input: { text: "Summarize." },
        commandId: `cmd-${Math.random()}`,
      });
    };

    const before = await delegateOnce();
    assert.equal(before.state, "complete");
    const sentBefore = kit.double.rpcCalls.length;

    stops.stop(
      {
        tenantId: kit.actor.tenantId,
        subjectId: kit.actor.subjectId,
        sessionId: kit.actor.sessionId,
      },
      Date.now(),
    );
    await assert.rejects(delegateOnce(), (error: unknown) => {
      assert.ok(error instanceof ConnectorError);
      assert.equal(error.code, "cancelled");
      assert.equal(error.detail, "continuation.assistant-stopped");
      return true;
    });
    // Nothing reached the agent after the stop.
    assert.equal(kit.double.rpcCalls.length, sentBefore);

    // The identical request on MCP, WebMCP and HTTP is refused the same way.
    for (const surface of ["mcp", "webmcp", "http"] as const) {
      const decision = await guard.evaluate({
        surface,
        actor: kit.actor,
        intent: "delegate",
        connectionRef: connection.connectionRef,
      });
      assert.equal(decision.allowed, false, surface);
      assert.equal(
        decision.allowed === false && decision.denial,
        "assistant-stopped",
      );
    }
  } finally {
    await kit.close();
  }
});

test("AG-03: the shipped reference application actually hands its connector intents to the MCP surface", () => {
  /*
   * The library contract above is the important half, and it is the half that
   * cannot tell you whether anything uses it. `createCeremonyMcpHandler` takes
   * `connectorIntents` as an option, so a deployment that never passes it gets a
   * working MCP surface with the connector tools simply absent -- and absence is
   * the failure mode hardest to see from the outside, because an assistant has
   * no way to distinguish a tool that was never registered from a capability
   * this deployment does not have. The reference application shipped that way.
   *
   * Asserted against the source rather than by starting the app, because
   * starting it boots Vite and a provider double for a question about one
   * argument. Phrased to survive reformatting and renaming of everything except
   * the two things that matter: that the option is passed at all, and that what
   * it is passed is the unprojected seam. The intents project for the actor
   * themselves, so handing them an already-projected view would project twice
   * and hide rows they meant to report.
   */
  const server = readFileSync(
    fileURLToPath(new URL("../../../examples/server.ts", import.meta.url)),
    "utf8",
  );
  assert.match(
    server,
    /connectorIntents:/,
    "the reference application must pass its connector intents to the MCP surface",
  );
  assert.match(
    server,
    /connectorIntents:\s*connectors\.agentDependencies/,
    "and must pass the unprojected seam, not a projection of it",
  );
  // The route table is the other half of the same claim: an assistant reaching
  // these tools and a person reaching the workspace both need the deployment to
  // have mounted the connector surface at all.
  assert.match(
    server,
    /\/api\/v1\/connectors\//,
    "and must mount the connector route table it shares with the browser",
  );
});
