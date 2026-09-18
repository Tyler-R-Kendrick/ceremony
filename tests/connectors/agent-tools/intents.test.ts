import assert from "node:assert/strict";
import test from "node:test";
import type { ActorContext } from "../../../src/core/operation-contracts.js";
import type {
  ConnectionSummary,
  NormalizedDefinition,
} from "../../../src/core/connectors/index.js";
import type { BoundOperation } from "../../../src/server/connectors/binding.js";
import {
  agentIntentNames,
  agentOperationProjection,
  createAgentConnectorIntents,
  type AgentConnectorDependencies,
} from "../../../src/server/connectors/agents/index.js";
import { agentConnectorToolNames } from "../../../src/server/connectors/agents/mcp-intents.js";
import { connectorServerToolNames } from "../../../src/server/connectors/mcp/server-tools.js";
import {
  buildBinding,
  buildConnectionSummary,
  buildDefinition,
  canaries,
} from "../fixtures/builders.js";
import { fixtureActor } from "../doubles/ports.js";

/*
 * AG-03. The intents are the only connector surface an assistant reaches, so
 * the tests are mostly about what does not come back: no link, no device
 * code, no account name, no destination, no transport, no configuration
 * value and no upstream prose.
 */

const stringsIn = (value: unknown, out: string[] = []): string[] => {
  if (typeof value === "string") out.push(value);
  else if (Array.isArray(value)) for (const item of value) stringsIn(item, out);
  else if (value && typeof value === "object")
    for (const item of Object.values(value)) stringsIn(item, out);
  return out;
};

function deps(
  overrides: Partial<AgentConnectorDependencies> = {},
  record: {
    calls: Array<{ name: string; actor: ActorContext; input: unknown }>;
  } = {
    calls: [],
  },
): AgentConnectorDependencies & { calls: typeof record.calls } {
  const note = (name: string, actor: ActorContext, input: unknown) =>
    record.calls.push({ name, actor, input });
  const summary: ConnectionSummary = buildConnectionSummary();
  const base: AgentConnectorDependencies = {
    async list(actor) {
      note("list", actor, undefined);
      return [summary];
    },
    async definition(actor, definitionRef) {
      note("definition", actor, definitionRef);
      return definitionRef === "definition:petstore"
        ? (buildDefinition() as NormalizedDefinition)
        : undefined;
    },
    async status(actor, connectionRef) {
      note("status", actor, connectionRef);
      return connectionRef === summary.connectionRef ? summary : undefined;
    },
    async connect(actor, input) {
      note("connect", actor, input);
      return { ...summary, lifecycle: "human-required" };
    },
    async operations(actor, connectionRef) {
      note("operations", actor, connectionRef);
      return buildBinding().operations as BoundOperation[];
    },
    async reconnect(actor, input) {
      note("reconnect", actor, input);
      return summary;
    },
    async disconnect(actor, input) {
      note("disconnect", actor, input);
      return {
        local: "applied",
        broker: "not-attempted",
        upstream: "unsupported",
        sharedWith: ["connection:2", "connection:3"],
      };
    },
    ...overrides,
  };
  return { ...base, calls: record.calls };
}

const intentsOf = (dependencies: AgentConnectorDependencies) =>
  new Map(
    createAgentConnectorIntents(dependencies).map((intent) => [
      intent.intent,
      intent,
    ]),
  );

test("AG-03: all seven intents exist, are named once and do not collide with the tools already on the MCP server", () => {
  const intents = createAgentConnectorIntents(deps());
  assert.deepEqual(
    intents.map((intent) => intent.intent),
    [
      "list",
      "inspect",
      "status",
      "connect",
      "operations",
      "reconnect",
      "disconnect",
    ],
  );
  assert.deepEqual(agentIntentNames.length, 7);
  assert.equal(new Set(intents.map((intent) => intent.name)).size, 7);
  // Read intents are marked read-only; the rest are consequential.
  assert.deepEqual(
    intents.filter((intent) => intent.readOnly).map((intent) => intent.intent),
    ["list", "inspect", "status", "operations"],
  );
  // The five this module adds to the existing MCP server take no name the
  // MCP swarm already registered.
  for (const name of agentConnectorToolNames)
    assert.ok(
      !(connectorServerToolNames as readonly string[]).includes(name),
      name,
    );
  assert.equal(agentConnectorToolNames.length, 5);
});

test("AG-03: list and status project connections through agentConnectorProjection and nothing else", async () => {
  const intents = intentsOf(deps());
  const listed = (await intents.get("list")!.run(fixtureActor, {})) as {
    connections: Array<Record<string, unknown>>;
  };
  const [connection] = listed.connections;
  assert.ok(connection);
  assert.deepEqual(Object.keys(connection).sort(), [
    "bindingRef",
    "connectionRef",
    "custody",
    "ecosystem",
    "generation",
    "lifecycle",
    "revision",
    "service",
    "targetKind",
    "verified",
  ]);
  // The verified target's identity is a kind, never the account name.
  assert.equal(connection.targetKind, "account");
  assert.doesNotMatch(stringsIn(connection).join(" "), /octocat|Petstore/);
  const status = await intents.get("status")!.run(fixtureActor, {
    connectionRef: "connection:1",
  });
  assert.deepEqual(status, connection);
  assert.deepEqual(
    await intents
      .get("status")!
      .run(fixtureActor, { connectionRef: "connection:9" }),
    { connection: "not-found" },
  );
});

test("AG-03: inspect projects definitions through agentDefinitionProjection and leaks no prose or endpoint", async () => {
  const hostile = buildDefinition({
    display: {
      name: "Petstore",
      description: `Contact support at ${canaries.email}`,
      ecosystem: "openapi",
      service: "petstore",
    },
    declaredServers: [
      { url: "https://internal.petstore.example/v1", status: "declared" },
    ],
    nativeExtensions: { note: canaries.secret },
  });
  const intents = intentsOf(
    deps({
      async definition() {
        return hostile;
      },
    }),
  );
  const inspected = (await intents.get("inspect")!.run(fixtureActor, {
    definitionRef: "definition:petstore",
  })) as Record<string, unknown>;
  assert.deepEqual(Object.keys(inspected).sort(), [
    "authentication",
    "blocked",
    "capabilities",
    "definitionRef",
    "dimensions",
    "displayName",
    "identity",
    "service",
  ]);
  const text = stringsIn(inspected).join(" ");
  assert.doesNotMatch(text, new RegExp(canaries.email));
  assert.doesNotMatch(text, new RegExp(canaries.secret));
  assert.doesNotMatch(text, /internal\.petstore/);
});

test("AG-03: the approved-operation intent describes policy and never how an operation is carried out", async () => {
  const intents = intentsOf(deps());
  const result = (await intents.get("operations")!.run(fixtureActor, {
    connectionRef: "connection:1",
  })) as { operations: Array<Record<string, unknown>> };
  const [operation] = result.operations;
  assert.ok(operation);
  assert.deepEqual(Object.keys(operation).sort(), [
    "consent",
    "cost",
    "effect",
    "operationRef",
    "outputClassification",
    "replay",
    "targetParameters",
  ]);
  const text = stringsIn(result).join(" ");
  assert.doesNotMatch(text, /petstore\.example|\/v1\/pets|GET|http|api/);
  // The projection is a positive allowlist, so a field added to a bound
  // operation later stays invisible until it is deliberately admitted.
  const projected = agentOperationProjection({
    ...(buildBinding().operations[0] as BoundOperation),
    description: "Lists pets.",
  });
  assert.equal(projected.description, "Lists pets.");
  assert.ok(!("transport" in projected));
  assert.ok(!("destinationId" in projected));
  assert.ok(!("authenticationProfile" in projected));
  assert.ok(!("nativeId" in projected));
});

test("AG-03: connect reports that a person is needed without saying where to go", async () => {
  const intents = intentsOf(deps());
  const connected = (await intents.get("connect")!.run(fixtureActor, {
    bindingRef: "binding:petstore",
  })) as Record<string, unknown>;
  assert.equal(connected.lifecycle, "human-required");
  assert.ok(!("presentation" in connected));
  assert.ok(!("handoff" in connected) || typeof connected.handoff === "object");
  assert.doesNotMatch(stringsIn(connected).join(" "), /https?:/);
});

test("AG-03: disconnect reports shared impact as a count, never as other people's connections", async () => {
  const intents = intentsOf(deps());
  assert.deepEqual(
    await intents.get("disconnect")!.run(fixtureActor, {
      connectionRef: "connection:1",
      expectedRevision: 3,
    }),
    {
      local: "applied",
      broker: "not-attempted",
      upstream: "unsupported",
      sharedCount: 2,
    },
  );
});

test("AG-03: an intent argument can never name a tenant, a subject, a session or an unknown field", async () => {
  const record = {
    calls: [] as Array<{ name: string; actor: ActorContext; input: unknown }>,
  };
  const intents = intentsOf(deps({}, record));
  for (const [name, input] of [
    ["status", { connectionRef: "connection:1", tenantId: "tenant-b" }],
    ["status", { connectionRef: "connection:1", subjectId: "other" }],
    ["connect", { bindingRef: "binding:petstore", sessionId: "s" }],
    ["connect", { bindingRef: "binding:petstore", ownerKind: "organization" }],
    ["connect", { bindingRef: "https://evil.invalid/callback" }],
    ["reconnect", { connectionRef: "connection:1", expectedRevision: 0 }],
    [
      "disconnect",
      { connectionRef: "connection:1", expectedRevision: 3, scope: "upstream" },
    ],
    ["inspect", { definitionRef: "../../etc/passwd" }],
  ] as const) {
    const before = record.calls.length;
    await assert.rejects(intents.get(name)!.run(fixtureActor, input), /./);
    assert.equal(record.calls.length, before, `${name} reached the service`);
  }
  // The actor is passed through from the transport, never from the argument.
  await intents
    .get("status")!
    .run(fixtureActor, { connectionRef: "connection:1" });
  assert.equal(record.calls.at(-1)?.actor, fixtureActor);
});

test("AG-03: an invalid tool prefix is refused rather than sanitized", () => {
  assert.throws(() =>
    createAgentConnectorIntents(deps(), { prefix: "bad prefix" }),
  );
  assert.throws(() => createAgentConnectorIntents(deps(), { prefix: "" }));
  assert.deepEqual(
    createAgentConnectorIntents(deps(), { prefix: "ceremony_connector" })
      .map((intent) => intent.name)
      .slice(0, 2),
    ["ceremony_connector_list", "ceremony_connector_inspect"],
  );
});
