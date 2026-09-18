import assert from "node:assert/strict";
import { after, before, beforeEach, test } from "node:test";
import { createMcpClient } from "../../../src/server/connectors/mcp/index.js";
import type { McpClient } from "../../../src/server/connectors/mcp/index.js";
import {
  methodsSeen,
  mcpRequests,
  startMcpFixture,
  type FixtureServer,
} from "../doubles/mcp-servers/harness.js";

/*
 * The current profile (protocol revision 2026-07-28) against an independent
 * server written from the specification. Every assertion is about what
 * actually crossed the wire: the per-request `_meta` envelope and its
 * mirrored headers, `server/discover` instead of a handshake, no session, no
 * GET stream, result discrimination, and the multi round-trip input pattern.
 */

const TOKEN = "current-token";
let fixture: FixtureServer;

before(async () => {
  fixture = await startMcpFixture("current", { token: TOKEN });
});
after(async () => {
  await fixture?.stop();
});
beforeEach(async () => {
  await fixture.control({ mode: "normal", reset: true });
});

function client(options: { token?: string | null } = {}): McpClient {
  const token = options.token === undefined ? TOKEN : options.token;
  return createMcpClient({
    profile: "2026-07-28",
    endpoint: fixture.endpoint,
    fetch: globalThis.fetch,
    auth: token === null ? { kind: "none" } : { kind: "bearer", use: (work) => work(token) },
    limits: { requestTimeoutMs: 5000, listenMaxMs: 2000 },
  });
}

test("discovery uses server/discover, with no handshake and no session", async () => {
  const discovery = await client().discover();
  assert.equal(discovery.usedProfile, "2026-07-28");
  assert.equal(discovery.era, "modern");
  assert.deepEqual(discovery.supportedVersions, ["2026-07-28"]);
  assert.equal(discovery.serverInfo?.name, "fixture-current");
  assert.ok(discovery.capabilities.tools);

  const report = await fixture.report();
  assert.deepEqual(methodsSeen(report), ["server/discover"]);
  const [request] = mcpRequests(report);
  assert.equal(request!.headers["mcp-protocol-version"], "2026-07-28");
  assert.equal(request!.headers["mcp-method"], "server/discover");
  assert.equal(request!.headers["mcp-session-id"], undefined);
  const meta = (request!.body as { params: { _meta: Record<string, unknown> } }).params._meta;
  assert.equal(meta["io.modelcontextprotocol/protocolVersion"], "2026-07-28");
  assert.ok(meta["io.modelcontextprotocol/clientCapabilities"]);
  assert.ok(meta["io.modelcontextprotocol/clientInfo"]);
});

test("the wire log of a current-profile session contains only current-profile messages", async () => {
  const connection = client();
  await connection.discover();
  await connection.listTools();
  await connection.listResources();
  await connection.callTool({ name: "echo", arguments: { text: "hi" }, effect: "read" });

  const report = await fixture.report();
  const methods = methodsSeen(report);
  assert.ok(!methods.includes("initialize"), "no handshake may appear");
  assert.ok(!methods.includes("notifications/initialized"));
  assert.ok(!methods.includes("resources/subscribe"));
  for (const request of mcpRequests(report)) {
    assert.equal(request.method, "POST", "this revision has no GET stream");
    assert.equal(request.headers["mcp-session-id"], undefined);
    assert.equal(request.headers["last-event-id"], undefined);
    assert.equal(request.headers["mcp-protocol-version"], "2026-07-28");
    const body = request.body as { params?: { _meta?: Record<string, unknown>; protocolVersion?: unknown } };
    assert.equal(body.params?.protocolVersion, undefined, "version travels in _meta, not in params");
    assert.equal(
      body.params?._meta?.["io.modelcontextprotocol/protocolVersion"],
      "2026-07-28",
    );
  }
});

test("an unauthenticated request surfaces the parsed challenge and its metadata", async () => {
  const outcome = await client({ token: null }).callTool({
    name: "echo",
    arguments: { text: "hi" },
    effect: "read",
  });
  assert.equal(outcome.kind, "authorization-required");
  if (outcome.kind !== "authorization-required") return;
  const challenge = outcome.challenge;
  assert.equal(challenge.status, 401);
  assert.deepEqual(challenge.challengeScopes, ["mcp:tools", "mcp:resources"]);
  assert.deepEqual(challenge.requestedScopes, ["mcp:tools", "mcp:resources"]);
  assert.equal(challenge.resourceMetadataUrl, `${fixture.origin}/.well-known/oauth-protected-resource/mcp`);
  assert.deepEqual(challenge.metadata?.authorizationServers, [`${fixture.origin}/authorization`]);
  assert.equal(challenge.canonicalResource, `${fixture.origin}/mcp`);
  assert.deepEqual(challenge.issues, []);
  // The revision's documented registration order is reported, not a claim
  // that every server supports the newest mechanism.
  assert.deepEqual(
    [...challenge.clientRegistration],
    ["pre-registered", "client-id-metadata-document", "dynamic"],
  );
});

test("metadata naming another resource is refused rather than believed", async () => {
  await fixture.control({ mode: "bad-metadata" });
  const outcome = await client({ token: null }).probeAuthorization();
  assert.ok(outcome);
  assert.equal(outcome!.metadata, undefined);
  assert.ok(outcome!.issues.includes("metadata-resource-mismatch"));
  // Without a validated document there is nothing to request scopes for
  // beyond what the challenge itself named.
  assert.deepEqual(outcome!.requestedScopes, ["mcp:tools", "mcp:resources"]);
});

test("a malformed WWW-Authenticate header is reported, not guessed at", async () => {
  await fixture.control({ mode: "malformed-challenge" });
  const outcome = await client({ token: null }).probeAuthorization();
  assert.ok(outcome);
  assert.ok(outcome!.issues.includes("challenge-malformed"));
  // The well-known fallback still finds the document.
  assert.equal(outcome!.metadata?.resource, `${fixture.origin}/mcp`);
  assert.deepEqual(outcome!.requestedScopes, ["mcp:tools", "mcp:resources"]);
});

test("a challenge with no header at all falls back to the well-known locations", async () => {
  await fixture.control({ mode: "no-challenge-header" });
  const outcome = await client({ token: null }).probeAuthorization();
  assert.ok(outcome);
  assert.ok(outcome!.issues.includes("challenge-missing"));
  assert.equal(outcome!.metadata?.resource, `${fixture.origin}/mcp`);
  assert.deepEqual(outcome!.requestedScopes, ["mcp:tools", "mcp:resources"]);
});

test("tool listing follows cursors, bounds pages and excludes invalid header annotations", async () => {
  const listed = await client().listTools();
  assert.equal(listed.pages, 2);
  assert.equal(listed.truncated, false);
  const names = listed.items.map((tool) => tool.name);
  assert.ok(names.includes("echo"));
  assert.ok(names.includes("greet_ada"));
  // The annotation under `oneOf` is not statically reachable, so that one
  // definition is dropped and the rest stay usable.
  assert.ok(!names.includes("sneaky_header"));
  assert.ok(listed.warnings.some((code) => code.startsWith("mcp.tool.excluded.invalid-x-mcp-header")));
  const regional = listed.items.find((tool) => tool.name === "regional_query");
  assert.deepEqual(regional?.headerParameters, [{ path: ["region"], header: "Region" }]);
  // A server that tries to steer headers through annotations or _meta is
  // flagged, and nothing it suggested is used.
  assert.ok(listed.warnings.some((code) => code.startsWith("mcp.tool.header-suggestion-ignored")));

  const report = await fixture.report();
  const listRequests = mcpRequests(report).filter(
    (entry) => (entry.body as { method?: string }).method === "tools/list",
  );
  assert.equal(listRequests.length, 2);
  assert.equal((listRequests[1]!.body as { params: { cursor?: string } }).params.cursor, "page-2");
});

test("designated tool parameters are mirrored into Mcp-Param headers the server validates", async () => {
  const outcome = await client().callTool({
    name: "regional_query",
    arguments: { region: "us-west1", query: "select 1" },
    effect: "read",
  });
  assert.equal(outcome.kind, "complete");
  const report = await fixture.report();
  const call = mcpRequests(report).find(
    (entry) => (entry.body as { method?: string }).method === "tools/call",
  );
  assert.equal(call!.headers["mcp-param-region"], "us-west1");
  assert.equal(call!.headers["mcp-name"], "regional_query");
  assert.equal(call!.headers["authorization"], `Bearer ${TOKEN}`);
});

test("resources and prompts keep their own semantics", async () => {
  const connection = client();
  const resources = await connection.listResources();
  assert.deepEqual(
    resources.items.map((resource) => resource.uri).sort(),
    ["note:///ada/private", "note:///shared"],
  );
  assert.equal(resources.cacheScope, "private");

  const templates = await connection.listResourceTemplates();
  assert.equal(templates.items[0]?.uriTemplate, "note:///{name}");

  const read = await connection.readResource({ uri: "note:///shared" });
  assert.equal(read.kind, "complete");
  if (read.kind === "complete")
    assert.equal(read.payload.contents[0]?.text, "contents of note:///shared");

  const missing = await connection.readResource({ uri: "note:///nowhere" });
  assert.equal(missing.kind, "failed");
  if (missing.kind === "failed") assert.equal(missing.code, "mcp.resource.not-found");

  const prompts = await connection.listPrompts();
  assert.equal(prompts.items[0]?.name, "summarize");
  const prompt = await connection.getPrompt({ name: "summarize", arguments: { note: "n1" } });
  assert.equal(prompt.kind, "complete");
  if (prompt.kind === "complete") {
    assert.equal(prompt.payload.description, "Summarize a note");
    assert.deepEqual(prompt.payload.messages[0], {
      role: "user",
      content: { type: "text", text: "Summarize n1" },
    });
  }
});

test("input_required suspends and resumes the same call, and the answers reach the server", async () => {
  const connection = client();
  const first = await connection.callTool({
    name: "needs_input",
    arguments: { repo: "ceremony" },
    effect: "read",
  });
  assert.equal(first.kind, "input-required");
  if (first.kind !== "input-required") return;
  assert.equal(first.requests.length, 1);
  assert.equal(first.requests[0]?.id, "github_login");
  assert.equal(first.requests[0]?.kind, "elicitation-form");
  assert.ok(first.requestState);

  const second = await connection.callTool({
    name: "needs_input",
    arguments: { repo: "ceremony" },
    effect: "read",
    inputResponses: { github_login: { action: "accept", content: { name: "octocat" } } },
    ...(first.requestState !== undefined ? { requestState: first.requestState } : {}),
  });
  assert.equal(second.kind, "complete");
  if (second.kind !== "complete") return;
  assert.equal(JSON.stringify(second.payload).includes("octocat"), false);

  const report = await fixture.report();
  const seen = report.inputsSeen?.[0] as {
    inputResponses: Record<string, { content?: { name?: string } }>;
    requestState?: string;
  };
  assert.equal(seen.inputResponses.github_login?.content?.name, "octocat");
  assert.equal(seen.requestState, first.requestState);
  const calls = mcpRequests(report).filter(
    (entry) => (entry.body as { method?: string }).method === "tools/call",
  );
  assert.equal(calls.length, 2);
  assert.notEqual(
    (calls[0]!.body as { id: unknown }).id,
    (calls[1]!.body as { id: unknown }).id,
    "the retry is a separate request",
  );
});

test("headers a server suggests through annotations or _meta are ignored", async () => {
  const outcome = await client().callTool({
    name: "suggests_headers",
    arguments: { text: "hi" },
    effect: "read",
  });
  assert.equal(outcome.kind, "complete");
  const report = await fixture.report();
  const call = mcpRequests(report).find(
    (entry) => (entry.body as { method?: string }).method === "tools/call",
  );
  assert.equal(call!.headers.authorization, `Bearer ${TOKEN}`, "the host's credential is unchanged");
  assert.equal(
    Object.keys(call!.headers).some((name) => name.startsWith("mcp-param-")),
    false,
    "a suggested parameter header is not invented",
  );
});

test("an unsafe sampling request is reported, never answered", async () => {
  const outcome = await client().callTool({
    name: "needs_sampling",
    arguments: {},
    effect: "read",
  });
  assert.equal(outcome.kind, "input-required");
  if (outcome.kind !== "input-required") return;
  assert.deepEqual(
    outcome.requests.map((request) => request.kind),
    ["sampling"],
  );
});

test("a dropped response to a consequential call is indeterminate and is not re-sent", async () => {
  await fixture.control({ mode: "drop-write-response" });
  const outcome = await client().callTool({
    name: "create_note",
    arguments: { title: "n" },
    effect: "write",
  });
  assert.equal(outcome.kind, "indeterminate");
  const report = await fixture.report();
  assert.equal(report.effects.length, 1, "the write must not be repeated");
  assert.equal(report.toolCalls, 1);
});

test("a dropped response to a read is retried within its budget", async () => {
  await fixture.control({ mode: "drop-write-response" });
  const outcome = await createMcpClient({
    profile: "2026-07-28",
    endpoint: fixture.endpoint,
    fetch: globalThis.fetch,
    auth: { kind: "bearer", use: (work) => work(TOKEN) },
    limits: { requestTimeoutMs: 3000, readRetries: 1 },
  }).callTool({ name: "create_note", arguments: { title: "n" }, effect: "read" });
  assert.equal(outcome.kind, "failed");
  const report = await fixture.report();
  assert.equal(report.toolCalls, 2, "a read may be reissued once");
});

test("cancelling mid-call leaves one call and an unknown outcome for a write", async () => {
  const controller = new AbortController();
  const connection = client();
  const call = connection.callTool({
    name: "slow",
    arguments: {},
    effect: "write",
    signal: controller.signal,
  });
  await new Promise((resolve) => setTimeout(resolve, 150));
  controller.abort();
  const outcome = await call;
  assert.equal(outcome.kind, "indeterminate");
  if (outcome.kind === "indeterminate") assert.equal(outcome.code, "mcp.cancelled");
  const report = await fixture.report();
  assert.equal(report.toolCalls, 1, "cancellation must not produce a second call");
  assert.equal(
    mcpRequests(report).some((entry) => (entry.body as { method?: string }).method === "notifications/cancelled"),
    false,
    "on this transport, closing the stream is the cancellation",
  );
});

test("an advertised extension is reported unsupported rather than negotiated", async () => {
  const discovery = await client().discover();
  assert.deepEqual(discovery.extensions.advertised, ["io.modelcontextprotocol/tasks"]);
  assert.deepEqual(discovery.extensions.supported, []);
  assert.deepEqual(discovery.extensions.unsupported, ["io.modelcontextprotocol/tasks"]);
  assert.ok(discovery.warnings.includes("mcp.extension.unsupported:io.modelcontextprotocol/tasks"));
  const report = await fixture.report();
  assert.equal(
    methodsSeen(report).some((method) => method.startsWith("tasks/")),
    false,
  );
});

test("the notification stream is a POST subscription and is bounded", async () => {
  const result = await client().listen({
    filter: { toolsListChanged: true },
    maxEvents: 4,
    maxMs: 1500,
  });
  assert.equal(result.supported, true);
  assert.deepEqual(result.acknowledged, { toolsListChanged: true });
  assert.ok(result.events.some((event) => event.method === "notifications/tools/list_changed"));
  const report = await fixture.report();
  const listen = mcpRequests(report).find(
    (entry) => (entry.body as { method?: string }).method === "subscriptions/listen",
  );
  assert.equal(listen!.method, "POST");
  assert.equal(
    mcpRequests(report).some((entry) => entry.method === "GET"),
    false,
    "the GET stream does not exist in this revision",
  );
});

test("a personalized list is never served to a second principal", async () => {
  const { McpResultCache } = await import("../../../src/server/connectors/mcp/cache.js");
  const store = new McpResultCache(Date.now, { cacheMaxTtlMs: 60_000, cacheMaxEntries: 32 });
  const build = (who: string, token: string) =>
    createMcpClient({
      profile: "2026-07-28",
      endpoint: fixture.endpoint,
      fetch: globalThis.fetch,
      auth: { kind: "bearer", use: (work) => work(token) },
      cache: {
        store,
        principal: {
          tenantId: "tenant-a",
          ownerId: who,
          connectionRef: `connection:${who}`,
          generation: 1,
          profile: "2026-07-28",
          credentialRef: `cred:${who}`,
        },
      },
    });
  const first = await build("ada", TOKEN).listTools();
  const cachedAgain = await build("ada", TOKEN).listTools();
  const other = await build("beatrix", "current-token-b").listTools();
  assert.ok(first.items.some((tool) => tool.name === "greet_ada"));
  assert.equal(cachedAgain.fromCache, true, "the same principal may reuse its own list");
  assert.equal(other.fromCache, false, "another principal must not be served it");
  assert.ok(other.items.some((tool) => tool.name === "greet_beatrix"));
  assert.ok(!other.items.some((tool) => tool.name === "greet_ada"));
});
