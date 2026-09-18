import assert from "node:assert/strict";
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
  });
  assert.deepEqual(added, [...agentConnectorToolNames]);
  assert.equal(tools.length, before + 5);
  // The four that were there are untouched and were not re-registered.
  for (const name of connectorServerToolNames)
    assert.equal(tools.filter((tool) => tool.name === name).length, 1, name);
  for (const tool of tools.slice(before))
    assert.ok(tool.config.description.length > 20, tool.name);
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
