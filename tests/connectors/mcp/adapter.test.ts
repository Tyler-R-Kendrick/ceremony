import assert from "node:assert/strict";
import { after, before, beforeEach, test } from "node:test";
import { randomUUID } from "node:crypto";
import {
  McpResultCache,
  createMcpRemoteAdapter,
  type McpRemoteAdapterOptions,
} from "../../../src/server/connectors/mcp/index.js";
import { runtimeBindingSchema, type RuntimeBinding } from "../../../src/server/connectors/binding.js";
import { ConnectorError } from "../../../src/server/connectors/errors.js";
import type {
  AdapterCallContext,
  ConnectorAdapter,
} from "../../../src/server/connectors/adapter.js";
import type { ConnectionRecord, HandoffIssue } from "../../../src/server/connectors/ports.js";
import { agentConnectorProjection } from "../../../src/core/connectors/index.js";
import type { ActorContext } from "../../../src/core/operation-contracts.js";
import { fixtureActor, memoryPorts } from "../doubles/ports.js";
import { startMcpFixture, type FixtureServer } from "../doubles/mcp-servers/harness.js";

/*
 * The adapter against the current-profile fixture: what the host's rules add
 * to the protocol. An operation the binding does not name never reaches the
 * wire; a consequential call is journaled before it is made and its uncertain
 * outcome is reported rather than repeated; a request for input becomes a
 * private handoff whose values never appear in a result; and what the adapter
 * claims to have verified is exactly what it observed.
 */

const TOKEN = "current-token";
const SECOND_TOKEN = "current-token-b";
let fixture: FixtureServer;

before(async () => {
  fixture = await startMcpFixture("current", { token: TOKEN, secondToken: SECOND_TOKEN });
});
after(async () => {
  await fixture?.stop();
});
beforeEach(async () => {
  await fixture.control({ mode: "normal", reset: true });
});

const DIGEST = "a".repeat(64);

function binding(overrides: Partial<RuntimeBinding> = {}): RuntimeBinding {
  return runtimeBindingSchema.parse({
    bindingRef: "binding:mcp",
    definitionRef: "definition:mcp",
    revision: 3,
    adapterId: "mcp-remote",
    adapterVersion: "1.0.0",
    runtime: "hosted-server",
    custody: "host-owned",
    authorityInstance: fixture.origin,
    status: "approved",
    approvedAt: "2026-09-18T00:00:00.000Z",
    policyRevision: "policy-1",
    tenantId: "tenant-a",
    destinations: [{ id: "server", origin: fixture.origin, network: "loopback-fixture" }],
    operations: [
      {
        operationRef: "op:echo",
        nativeId: "echo",
        destinationId: "server",
        transport: { kind: "mcp-tool", toolName: "echo" },
        effect: "read",
        outputClassification: "public",
        cost: "free",
        consent: "none",
        replay: "read-only",
        targetParameters: [],
      },
      {
        operationRef: "op:create",
        nativeId: "create_note",
        destinationId: "server",
        transport: { kind: "mcp-tool", toolName: "create_note" },
        effect: "write",
        outputClassification: "personal",
        cost: "free",
        consent: "confirm",
        replay: "none",
        targetParameters: [],
      },
      {
        operationRef: "op:link",
        nativeId: "needs_input",
        destinationId: "server",
        transport: { kind: "mcp-tool", toolName: "needs_input" },
        effect: "write",
        outputClassification: "personal",
        cost: "free",
        consent: "confirm",
        replay: "none",
        targetParameters: [],
      },
      {
        operationRef: "op:sample",
        nativeId: "needs_sampling",
        destinationId: "server",
        transport: { kind: "mcp-tool", toolName: "needs_sampling" },
        effect: "read",
        outputClassification: "public",
        cost: "free",
        consent: "none",
        replay: "read-only",
        targetParameters: [],
      },
      {
        operationRef: "op:note",
        nativeId: "note:///{name}",
        destinationId: "server",
        transport: { kind: "mcp-resource", uriTemplate: "note:///{name}" },
        effect: "read",
        outputClassification: "personal",
        cost: "free",
        consent: "none",
        replay: "read-only",
        targetParameters: [],
      },
      {
        operationRef: "op:summarize",
        nativeId: "summarize",
        destinationId: "server",
        transport: { kind: "mcp-prompt", promptName: "summarize" },
        effect: "read",
        outputClassification: "public",
        cost: "free",
        consent: "none",
        replay: "read-only",
        targetParameters: [],
      },
      {
        operationRef: "op:http",
        nativeId: "GET /admin",
        destinationId: "server",
        transport: { kind: "http", method: "GET", pathTemplate: "/admin" },
        effect: "read",
        outputClassification: "public",
        cost: "free",
        consent: "none",
        replay: "read-only",
        targetParameters: [],
      },
    ],
    configuration: [],
    permittedTargets: [],
    reviewedDigest: DIGEST,
    settings: { mcp: { profile: "2026-07-28", endpointPath: "/mcp", auth: "bearer" } },
    ...overrides,
  });
}

type Harness = {
  ctx: AdapterCallContext;
  ports: ReturnType<typeof memoryPorts>;
  adapter: ReturnType<typeof createMcpRemoteAdapter>;
  connection: ConnectionRecord;
  controller: AbortController;
};

async function harness(
  options: {
    actor?: ActorContext;
    token?: string;
    adapter?: McpRemoteAdapterOptions;
    binding?: RuntimeBinding;
    generation?: number;
  } = {},
): Promise<Harness> {
  const actor = options.actor ?? fixtureActor;
  const ports = memoryPorts();
  const bound = options.binding ?? binding();
  const connectionRef = `connection:${randomUUID()}`;
  const scope = {
    tenantId: actor.tenantId,
    ownerKind: "user" as const,
    ownerId: actor.subjectId,
    connectionRef,
    bindingRef: bound.bindingRef,
    custody: "host-owned" as const,
  };
  const credentialRef = await ports.credentials.store(scope, { bearer: options.token ?? TOKEN });
  const connection: ConnectionRecord = {
    connectionRef,
    bindingRef: bound.bindingRef,
    definitionRef: bound.definitionRef,
    ecosystem: "mcp",
    service: "mcp",
    displayName: "Fixture MCP server",
    ownerKind: "user",
    custody: "host-owned",
    runtime: "hosted-server",
    lifecycle: "active",
    generation: options.generation ?? 1,
    revision: 1,
    createdAt: "2026-09-18T00:00:00.000Z",
    updatedAt: "2026-09-18T00:00:00.000Z",
    tenantId: actor.tenantId,
    ownerId: actor.subjectId,
    authorityInstance: fixture.origin,
    bindingRevision: bound.revision,
    policyRevision: bound.policyRevision,
    configurationRevision: "cfg:1",
    credentialRef,
    externalIds: {},
    evidenceRefs: [],
    state: {},
  };
  await ports.connections.create(connection);
  const controller = new AbortController();
  return {
    ports,
    connection,
    controller,
    adapter: createMcpRemoteAdapter(options.adapter),
    ctx: {
      actor,
      binding: bound,
      connection,
      generation: options.generation ?? 1,
      signal: controller.signal,
      environment: ports.environment({ fetch: globalThis.fetch }),
    },
  };
}

test("the adapter reports a capability row per profile and refuses stdio outright", async () => {
  const adapter: ConnectorAdapter = createMcpRemoteAdapter();
  const rows = adapter.capabilities(new Set());
  const invoke = rows.filter((row) => row.dimension === "invoke");
  assert.deepEqual(
    invoke.map((row) => row.profile).sort(),
    [
      "mcp-2025-06-18",
      "mcp-2025-06-18-stdio",
      "mcp-2025-11-25",
      "mcp-2025-11-25-stdio",
      "mcp-2026-07-28",
      "mcp-2026-07-28-stdio",
    ],
  );
  for (const row of invoke.filter((item) => !item.profile.endsWith("-stdio"))) {
    assert.equal(row.implementation, "implemented");
    assert.equal(row.evidence, "protocol-fixture");
  }
  for (const row of invoke.filter((item) => item.profile.endsWith("-stdio"))) {
    assert.equal(row.implementation, "unsupported");
    assert.equal(row.evidence, "not-tested");
    assert.match(row.limitations.join(" "), /stdio transports are not supported/);
  }
  const revoke = rows.find((row) => row.dimension === "revoke");
  assert.equal(revoke?.implementation, "unsupported");
  assert.match(revoke!.limitations.join(" "), /no revocation operation/);
  // The authorization row states this revision's registration order rather
  // than claiming every server supports the newest mechanism.
  const authorize = rows.find(
    (row) => row.dimension === "authorize" && row.profile === "mcp-2025-06-18",
  );
  assert.match(authorize!.limitations.join(" "), /pre-registered, dynamic/);
});

test("verify records what it observed and names what it does not establish", async () => {
  const h = await harness();
  const result = await h.adapter.verify!(h.ctx);
  assert.equal(result.state, "complete");
  assert.equal(result.claims.length, 1);
  const claim = result.claims[0]!;
  assert.equal(claim.kind, "credential-accepted");
  assert.equal(claim.issuer, "provider");
  assert.deepEqual(claim.target, { kind: "mcp-server", id: fixture.origin });
  assert.ok(claim.limitations.includes("server identity not attested beyond TLS origin"));
  assert.equal(claim.bindingRevision, 3);
  assert.deepEqual(result.adapterState?.unsupportedExtensions, ["io.modelcontextprotocol/tasks"]);
  assert.equal(result.adapterState?.protocolVersion, "2026-07-28");
});

test("verification without a credential is denied and carries the challenge, not a guess", async () => {
  const h = await harness({ token: "wrong-token" });
  const result = await h.adapter.verify!(h.ctx);
  assert.equal(result.state, "denied");
  assert.equal(result.code, "authorization-required");
  const challenge = result.adapterState?.challenge as { requestedScopes: string[]; authorizationServers: string[] };
  assert.deepEqual(challenge.requestedScopes, ["mcp:tools", "mcp:resources"]);
  assert.deepEqual(challenge.authorizationServers, [`${fixture.origin}/authorization`]);
});

test("an operation the binding does not name never reaches the wire", async () => {
  const h = await harness();
  await assert.rejects(
    h.adapter.invoke!(h.ctx, { operationRef: "op:nowhere", input: {}, commandId: "c1" }),
    (error: unknown) =>
      error instanceof ConnectorError &&
      error.code === "denied" &&
      error.detail === "mcp.operation.not-bound",
  );
  const report = await fixture.report();
  assert.equal(report.wire.length, 0);
});

test("a non-MCP transport under an MCP binding is refused", async () => {
  const h = await harness();
  await assert.rejects(
    h.adapter.invoke!(h.ctx, { operationRef: "op:http", input: {}, commandId: "c1" }),
    (error: unknown) =>
      error instanceof ConnectorError && error.detail === "mcp.operation.transport-not-mcp",
  );
  const report = await fixture.report();
  assert.equal(report.wire.length, 0);
});

test("invocation routes to tools, resources and prompts and keeps their semantics", async () => {
  const h = await harness();
  const tool = await h.adapter.invoke!(h.ctx, {
    operationRef: "op:echo",
    input: { text: "hi" },
    commandId: "c1",
  });
  assert.equal(tool.state, "complete");
  assert.equal(tool.outputClassification, "public");
  assert.deepEqual((tool.output as { content: unknown[] }).content, [{ type: "text", text: "hi" }]);

  const resource = await h.adapter.invoke!(h.ctx, {
    operationRef: "op:note",
    input: { name: "shared" },
    commandId: "c2",
  });
  assert.equal(resource.state, "complete");
  assert.equal(resource.outputClassification, "personal");
  assert.ok((resource.output as { contents: Array<{ uri: string }> }).contents[0]!.uri.startsWith("note:///"));

  const prompt = await h.adapter.invoke!(h.ctx, {
    operationRef: "op:summarize",
    input: { note: "n1" },
    commandId: "c3",
  });
  assert.equal(prompt.state, "complete");
  assert.deepEqual((prompt.output as { messages: unknown[] }).messages, [
    { role: "user", content: { type: "text", text: "Summarize n1" } },
  ]);

  const report = await fixture.report();
  const methods = report.wire
    .filter((entry) => entry.path === "/mcp")
    .map((entry) => (entry.body as { method?: string }).method);
  assert.ok(methods.includes("tools/call"));
  assert.ok(methods.includes("resources/read"));
  assert.ok(methods.includes("prompts/get"));
});

test("a resource template variable is bounded, encoded and never allowed to escape", async () => {
  const h = await harness();
  // Not a string: refused before anything is sent.
  await assert.rejects(
    h.adapter.invoke!(h.ctx, { operationRef: "op:note", input: { name: { evil: true } }, commandId: "c1" }),
    (error: unknown) =>
      error instanceof ConnectorError && error.detail === "mcp.resource.variable-invalid",
  );
  // A traversal-shaped name is percent-encoded into the template rather than
  // escaping it, so the server simply does not know that resource.
  const result = await h.adapter.invoke!(h.ctx, {
    operationRef: "op:note",
    input: { name: "../secret" },
    commandId: "c2",
  });
  assert.equal(result.state, "failed");
  assert.equal(result.code, "mcp.resource.not-found");
  const report = await fixture.report();
  const read = report.wire.find(
    (entry) => (entry.body as { method?: string }).method === "resources/read",
  );
  assert.equal((read!.body as { params: { uri: string } }).params.uri, "note:///..%2Fsecret");
});

test("a dropped response to a consequential call is indeterminate, journaled, and never repeated", async () => {
  await fixture.control({ mode: "drop-write-response" });
  const h = await harness();
  const first = await h.adapter.invoke!(h.ctx, {
    operationRef: "op:create",
    input: { title: "n" },
    commandId: "c1",
  });
  assert.equal(first.state, "indeterminate");
  assert.ok(first.effectRef);
  const journal = h.ports.inspect.effects();
  assert.equal(journal.length, 1);
  assert.equal(journal[0]!.outcome?.status, "indeterminate");

  // The same intent again: the journal answers, the server is not called.
  const second = await h.adapter.invoke!(h.ctx, {
    operationRef: "op:create",
    input: { title: "n" },
    commandId: "c2",
  });
  assert.equal(second.state, "indeterminate");
  assert.equal(second.code, "reconciliation-required");
  const report = await fixture.report();
  assert.equal(report.effects.length, 1, "the write happened once");
  assert.equal(report.toolCalls, 1, "and was never re-sent");
});

test("a request for input suspends the intent privately and resumes it once", async () => {
  const h = await harness();
  const started = await h.adapter.invoke!(h.ctx, {
    operationRef: "op:link",
    input: { repo: "ceremony" },
    commandId: "c1",
  });
  assert.equal(started.state, "human-required");
  assert.equal(started.code, "input-required");
  const proposal = started.handoff!;
  assert.equal(proposal.kind, "input-required");
  assert.equal(proposal.presentation, "in-app");
  assert.equal(proposal.intent, "mcp.input-required");
  assert.ok(proposal.private.requestState, "the server's opaque state stays private");
  assert.ok(proposal.private.inputRequests.includes("github_login"));
  assert.equal(JSON.stringify(started).includes("octocat"), false);

  const issue: HandoffIssue = {
    ...proposal,
    actor: h.ctx.actor,
    connectionRef: h.connection.connectionRef,
    bindingRef: h.connection.bindingRef,
    generation: h.ctx.generation,
  };
  const { handoffRef, summary } = await h.ports.handoffs.issue(issue);
  assert.equal(summary.kind, "input-required");
  assert.equal(JSON.stringify(summary).includes("octocat"), false);

  const record = await h.ports.handoffs.present(h.ctx.actor, handoffRef);
  const resumed = await h.adapter.resumeInput(h.ctx, record!, { name: "octocat", remember: "true" });
  assert.equal(resumed.state, "complete");
  assert.equal(resumed.outputClassification, "personal");
  // What the person typed reached the server and nothing else.
  const report = await fixture.report();
  const seen = report.inputsSeen?.[0] as {
    inputResponses: { github_login: { action: string; content: { name: string; remember: boolean } } };
  };
  assert.equal(seen.inputResponses.github_login.action, "accept");
  assert.equal(seen.inputResponses.github_login.content.name, "octocat");
  assert.equal(seen.inputResponses.github_login.content.remember, true);
  assert.equal(JSON.stringify(resumed).includes("octocat"), false);
  assert.equal(
    JSON.stringify(agentConnectorProjection({ ...h.connection, handoff: summary })).includes("octocat"),
    false,
  );

  // One use: the same continuation cannot be replayed.
  const replayed = await h.adapter.resumeInput(h.ctx, record!, { name: "octocat" });
  assert.equal(replayed.state, "denied");
  assert.equal(replayed.code, "mcp.handoff.not-pending");
  const after = await fixture.report();
  assert.equal(after.inputsSeen?.length, 1);
});

test("a continuation for an older generation or a changed binding is refused", async () => {
  const h = await harness();
  const started = await h.adapter.invoke!(h.ctx, {
    operationRef: "op:link",
    input: { repo: "ceremony" },
    commandId: "c1",
  });
  const { handoffRef } = await h.ports.handoffs.issue({
    ...started.handoff!,
    actor: h.ctx.actor,
    connectionRef: h.connection.connectionRef,
    bindingRef: h.connection.bindingRef,
    generation: h.ctx.generation,
  });
  const record = await h.ports.handoffs.present(h.ctx.actor, handoffRef);

  const newerGeneration = { ...h.ctx, generation: 2 };
  const stale = await h.adapter.resumeInput(newerGeneration, record!, { name: "octocat" });
  assert.equal(stale.state, "denied");
  assert.equal(stale.code, "mcp.handoff.stale-generation");

  const changedBinding = { ...h.ctx, binding: binding({ revision: 4 }) };
  const reviewed = await h.adapter.resumeInput(changedBinding, record!, { name: "octocat" });
  assert.equal(reviewed.state, "denied");
  assert.equal(reviewed.code, "mcp.binding.changed");

  const report = await fixture.report();
  assert.equal(report.inputsSeen?.length ?? 0, 0, "nothing was continued");
});

test("values that do not match the requested schema are refused before the retry", async () => {
  const h = await harness();
  const started = await h.adapter.invoke!(h.ctx, {
    operationRef: "op:link",
    input: { repo: "ceremony" },
    commandId: "c1",
  });
  const { handoffRef } = await h.ports.handoffs.issue({
    ...started.handoff!,
    actor: h.ctx.actor,
    connectionRef: h.connection.connectionRef,
    bindingRef: h.connection.bindingRef,
    generation: h.ctx.generation,
  });
  const record = await h.ports.handoffs.present(h.ctx.actor, handoffRef);
  await assert.rejects(
    h.adapter.resumeInput(h.ctx, record!, { nickname: "octocat" }),
    (error: unknown) =>
      error instanceof ConnectorError && (error.detail ?? "").startsWith("mcp.input."),
  );
  const report = await fixture.report();
  assert.equal(report.inputsSeen?.length ?? 0, 0);
});

test("an implicit sampling request is denied and leaves no effect", async () => {
  const h = await harness();
  const result = await h.adapter.invoke!(h.ctx, {
    operationRef: "op:sample",
    input: {},
    commandId: "c1",
  });
  assert.equal(result.state, "denied");
  assert.equal(result.code, "mcp.sampling.refused");
});

test("cancellation mid-call leaves the outcome unknown and the call unrepeated", async () => {
  const h = await harness();
  const bound = binding();
  const withSlow = runtimeBindingSchema.parse({
    ...bound,
    operations: [
      ...bound.operations,
      {
        operationRef: "op:slow",
        nativeId: "slow",
        destinationId: "server",
        transport: { kind: "mcp-tool", toolName: "slow" },
        effect: "write",
        outputClassification: "personal",
        cost: "free",
        consent: "confirm",
        replay: "none",
        targetParameters: [],
      },
    ],
  });
  const ctx = { ...h.ctx, binding: withSlow };
  const call = h.adapter.invoke!(ctx, { operationRef: "op:slow", input: {}, commandId: "c1" });
  await new Promise((resolve) => setTimeout(resolve, 150));
  h.controller.abort();
  const result = await call;
  assert.equal(result.state, "indeterminate");
  assert.equal(result.code, "mcp.cancelled");
  const journal = h.ports.inspect.effects();
  assert.equal(journal[0]!.outcome?.status, "indeterminate");
  const report = await fixture.report();
  assert.equal(report.toolCalls, 1);
});

test("disconnect is local only and says what MCP cannot do", async () => {
  const h = await harness();
  const result = await h.adapter.disconnect!(h.ctx, "upstream");
  assert.deepEqual(result, { local: "applied", broker: "not-attempted", upstream: "unsupported" });
  const revoked = await h.adapter.revoke!(h.ctx);
  assert.equal(revoked.upstream, "unsupported");
  const report = await fixture.report();
  assert.equal(report.wire.length, 0, "no disconnect request exists to send");
});

test("two principals sharing one cache never see each other's lists", async () => {
  const cache = new McpResultCache(Date.now, { cacheMaxTtlMs: 60_000, cacheMaxEntries: 64 });
  const first = await harness({ adapter: { cache }, token: TOKEN });
  const second = await harness({
    actor: { ...fixtureActor, subjectId: "subject-2", sessionId: "session-2" },
    adapter: { cache },
    token: SECOND_TOKEN,
  });
  const one = await first.adapter.invoke!(first.ctx, {
    operationRef: "op:echo",
    input: { text: "a" },
    commandId: "c1",
  });
  assert.equal(one.state, "complete");
  const other = await second.adapter.invoke!(second.ctx, {
    operationRef: "op:echo",
    input: { text: "b" },
    commandId: "c2",
  });
  assert.equal(other.state, "complete");
  const report = await fixture.report();
  const listings = report.wire.filter(
    (entry) => (entry.body as { method?: string }).method === "tools/list",
  );
  const tokens = new Set(listings.map((entry) => entry.headers.authorization));
  assert.equal(tokens.size, 2, "each principal listed with its own credential");
});

test("a tool that drifted from its reviewed definition is refused", async () => {
  const h = await harness({
    binding: binding({
      settings: {
        mcp: {
          profile: "2026-07-28",
          endpointPath: "/mcp",
          auth: "bearer",
          pinnedTools: { echo: "b".repeat(64) },
        },
      },
    }),
  });
  const result = await h.adapter.invoke!(h.ctx, {
    operationRef: "op:echo",
    input: { text: "hi" },
    commandId: "c1",
  });
  assert.equal(result.state, "failed");
  assert.equal(result.code, "mcp.tool.drift");
  const report = await fixture.report();
  assert.equal(report.toolCalls, 0, "a changed definition is not called");
});
