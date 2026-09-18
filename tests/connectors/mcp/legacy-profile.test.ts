import assert from "node:assert/strict";
import { after, before, beforeEach, test } from "node:test";
import { createMcpClient } from "../../../src/server/connectors/mcp/index.js";
import type { McpClient } from "../../../src/server/connectors/mcp/index.js";
import {
  mcpRequests,
  methodsSeen,
  startMcpFixture,
  type FixtureServer,
} from "../doubles/mcp-servers/harness.js";

/*
 * The legacy profile against a server built with the deployed SDK: the
 * initialization handshake, the `Mcp-Session-Id` session, server-initiated
 * requests on the response stream and the standalone GET stream. This is the
 * "provider that is already deployed" case, and the assertions are that the
 * client speaks that revision and only that revision.
 */

const TOKEN = "legacy-token";
let fixture: FixtureServer;

before(async () => {
  fixture = await startMcpFixture("legacy", { token: TOKEN });
});
after(async () => {
  await fixture?.stop();
});
beforeEach(async () => {
  await fixture.control({ mode: "normal", reset: true });
});

function client(
  options: {
    token?: string | null;
    profile?: "2026-07-28" | "2025-11-25" | "2025-06-18";
    compatibility?: "pinned" | "negotiate" | "auto-detect";
    onElicitation?: Parameters<typeof createMcpClient>[0]["onElicitation"];
  } = {},
): McpClient {
  const token = options.token === undefined ? TOKEN : options.token;
  return createMcpClient({
    profile: options.profile ?? "2025-11-25",
    ...(options.compatibility ? { compatibility: options.compatibility } : {}),
    endpoint: fixture.endpoint,
    fetch: globalThis.fetch,
    auth: token === null ? { kind: "none" } : { kind: "bearer", use: (work) => work(token) },
    limits: { requestTimeoutMs: 5000, listenMaxMs: 1500 },
    ...(options.onElicitation ? { onElicitation: options.onElicitation } : {}),
  });
}

test("the legacy profile initializes, takes a session and speaks only legacy messages", async () => {
  const connection = client();
  const discovery = await connection.discover();
  assert.equal(discovery.era, "legacy");
  assert.equal(discovery.usedProfile, "2025-11-25");
  assert.equal(discovery.protocolVersion, "2025-11-25");
  assert.equal(discovery.serverInfo?.name, "fixture-legacy");
  assert.equal(connection.state().session, true);

  await connection.listTools();
  const report = await fixture.report();
  const methods = methodsSeen(report);
  assert.equal(methods[0], "initialize");
  assert.ok(methods.includes("notifications/initialized"));
  assert.ok(methods.includes("tools/list"));
  // Nothing from the newer revision may appear on this wire.
  assert.ok(!methods.includes("server/discover"));
  assert.ok(!methods.includes("subscriptions/listen"));
  for (const request of mcpRequests(report)) {
    const body = request.body as { method?: string; params?: { _meta?: Record<string, unknown> } };
    assert.equal(
      body.params?._meta?.["io.modelcontextprotocol/protocolVersion"],
      undefined,
      "the per-request envelope belongs to the newer revision only",
    );
    assert.equal(request.headers["mcp-method"], undefined);
    assert.equal(request.headers["mcp-name"], undefined);
    if (body.method !== "initialize") {
      assert.equal(request.headers["mcp-protocol-version"], "2025-11-25");
      assert.ok(request.headers["mcp-session-id"], "the session travels on every later request");
    }
  }
});

test("tools, resources and prompts work through the handshake profile", async () => {
  const connection = client();
  const tools = await connection.listTools();
  assert.ok(tools.items.some((tool) => tool.name === "echo"));
  assert.ok(tools.items.some((tool) => tool.name === "greet_ada"));

  const echo = await connection.callTool({ name: "echo", arguments: { text: "hi" }, effect: "read" });
  assert.equal(echo.kind, "complete");
  if (echo.kind === "complete")
    assert.deepEqual(echo.payload.content[0], { type: "text", text: "hi" });

  const resources = await connection.listResources();
  assert.ok(resources.items.some((resource) => resource.uri === "note:///shared"));
  const read = await connection.readResource({ uri: "note:///shared" });
  assert.equal(read.kind, "complete");

  const prompts = await connection.listPrompts();
  assert.ok(prompts.items.some((prompt) => prompt.name === "summarize"));
  const prompt = await connection.getPrompt({ name: "summarize", arguments: { note: "n1" } });
  assert.equal(prompt.kind, "complete");
});

test("an elicitation on the response stream becomes an input-required outcome", async () => {
  const outcome = await client().callTool({ name: "ask_login", arguments: {}, effect: "read" });
  assert.equal(outcome.kind, "input-required");
  if (outcome.kind !== "input-required") return;
  assert.equal(outcome.requests[0]?.kind, "elicitation-form");
  assert.equal(outcome.requests[0]?.elicitation?.message, "Please provide your GitHub username");
  assert.ok(outcome.legacy?.elicitationDigest);
});

test("answering the elicitation completes the same call without echoing the answer", async () => {
  const outcome = await client({
    onElicitation: async () => ({
      result: { action: "accept", content: { name: "octocat" } },
      deferred: false,
    }),
  }).callTool({ name: "ask_login", arguments: {}, effect: "read" });
  assert.equal(outcome.kind, "complete");
  if (outcome.kind !== "complete") return;
  assert.equal(JSON.stringify(outcome.payload).includes("octocat"), false);
  const report = await fixture.report();
  const answered = report.elicitations?.[0] as { action?: string; content?: { name?: string } };
  assert.equal(answered.action, "accept");
  assert.equal(answered.content?.name, "octocat");
});

test("a roots request is answered with an empty list and never a path", async () => {
  const outcome = await client().callTool({ name: "probe_roots", arguments: {}, effect: "read" });
  assert.equal(outcome.kind, "complete");
  if (outcome.kind !== "complete") return;
  assert.deepEqual(outcome.payload.structuredContent, { rootCount: 0, roots: [] });
});

test("a sampling request is refused with an error the server can see", async () => {
  const outcome = await client().callTool({ name: "probe_sampling", arguments: {}, effect: "read" });
  assert.equal(outcome.kind, "complete");
  if (outcome.kind !== "complete") return;
  assert.equal(outcome.payload.isError, true);
  assert.deepEqual(outcome.payload.content[0], {
    type: "text",
    text: "client refused sampling",
  });
});

test("a dropped response to a consequential call is indeterminate and is not re-sent", async () => {
  const outcome = await client().callTool({
    name: "drop_note",
    arguments: { title: "n" },
    effect: "write",
  });
  assert.equal(outcome.kind, "indeterminate");
  const report = await fixture.report();
  assert.equal(report.effects.filter((effect) => effect.tool === "drop_note").length, 1);
});

test("cancelling a slow consequential call leaves one call and an unknown outcome", async () => {
  const controller = new AbortController();
  const call = client().callTool({
    name: "slow_note",
    arguments: {},
    effect: "write",
    signal: controller.signal,
  });
  await new Promise((resolve) => setTimeout(resolve, 250));
  controller.abort();
  const outcome = await call;
  assert.equal(outcome.kind, "indeterminate");
  const report = await fixture.report();
  assert.equal(report.effects.filter((effect) => effect.tool === "slow_note").length, 1);
  // On this revision the client does say so explicitly, unlike the newer one.
  assert.ok(
    mcpRequests(report).some(
      (entry) => (entry.body as { method?: string }).method === "notifications/cancelled",
    ),
  );
});

test("an unauthenticated legacy request surfaces the challenge and its metadata", async () => {
  const outcome = await client({ token: null }).probeAuthorization();
  assert.ok(outcome);
  assert.equal(outcome!.status, 401);
  assert.deepEqual(outcome!.challengeScopes, ["mcp:tools"]);
  assert.equal(outcome!.metadata?.resource, `${fixture.origin}/mcp`);
  // 2025-06-18 documents pre-registration and Dynamic Client Registration;
  // the report says so rather than claiming the newest mechanism everywhere.
  const older = await client({ token: null, profile: "2025-06-18" }).probeAuthorization();
  assert.deepEqual([...older!.clientRegistration], ["pre-registered", "dynamic"]);
});

test("a pinned current-profile client refuses to speak to a legacy server", async () => {
  const outcome = await client({ profile: "2026-07-28", compatibility: "pinned" }).callTool({
    name: "echo",
    arguments: { text: "hi" },
    effect: "read",
  });
  assert.equal(outcome.kind, "failed");
  if (outcome.kind !== "failed") return;
  assert.equal(outcome.code, "mcp.profile.legacy-server");
  assert.equal(outcome.applied, "no");
  const report = await fixture.report();
  assert.ok(
    !methodsSeen(report).includes("initialize"),
    "a pinned client does not quietly change era",
  );
});

test("auto-detect falls back once and records the profile it actually used", async () => {
  const connection = client({ profile: "2026-07-28", compatibility: "auto-detect" });
  const outcome = await connection.callTool({ name: "echo", arguments: { text: "hi" }, effect: "read" });
  assert.equal(outcome.kind, "complete");
  assert.equal(connection.state().era, "legacy");
  assert.equal(connection.state().usedProfile, "2025-11-25");
  const report = await fixture.report();
  const methods = methodsSeen(report);
  assert.ok(methods.includes("initialize"));
  // The first attempt was modern; after the fallback every later request is
  // legacy. What matters is that no single message mixes the two.
  for (const request of mcpRequests(report)) {
    const body = request.body as { method?: string; params?: { _meta?: Record<string, unknown> } };
    const modern = body.params?._meta?.["io.modelcontextprotocol/protocolVersion"] !== undefined;
    const legacy = request.headers["mcp-session-id"] !== undefined;
    assert.equal(modern && legacy, false, "no message may carry both eras");
  }
});

test("the legacy notification stream is the GET stream, bounded by the client", async () => {
  const connection = client();
  await connection.discover();
  const result = await connection.listen({ filter: { toolsListChanged: true }, maxMs: 700, maxEvents: 2 });
  assert.equal(typeof result.supported, "boolean");
  const report = await fixture.report();
  const streamRequests = mcpRequests(report).filter((entry) => entry.method === "GET");
  if (result.supported) {
    assert.equal(streamRequests.length, 1);
    assert.ok(streamRequests[0]!.headers["mcp-session-id"]);
  }
  assert.ok(
    !methodsSeen(report).includes("subscriptions/listen"),
    "the POST subscription belongs to the newer revision",
  );
});
