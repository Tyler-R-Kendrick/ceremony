import assert from "node:assert/strict";
import { test } from "node:test";
import {
  createSupabaseHostedMcpProfile,
  resolveSupabaseHostedMcpBinding,
  supabaseMcpDefaultFeatureGroups,
  supabaseMcpTools,
  type McpClientPort,
  type McpServerSession,
  type McpToolDescriptor,
} from "../../../src/server/connectors/providers/supabase/index.js";
import { ConnectorError } from "../../../src/server/connectors/errors.js";
import type { AuthorizationIntent } from "../../../src/server/connectors/adapter.js";
import { startHttpFixture } from "../doubles/http-fixture.js";
import {
  PROJECT_REF,
  OTHER_PROJECT_REF,
  mcpBinding,
  supabaseHarness,
} from "../fixtures/supabase/harness.js";

/*
 * SB-02 / AC-SB-04. The approved restrictions are binding settings: a caller
 * cannot hand the profile a URL that merely claims read_only=true. Protocol
 * execution is delegated, so the client here is a small fake of the port, and
 * an independent loopback double asserts the exact URL and query the binding
 * produces when the client actually dials it.
 */

const intentFor = (
  overrides: Partial<AuthorizationIntent> = {},
): AuthorizationIntent => ({
  ownerKind: "user",
  requestedPermissions: [],
  accountSwitch: false,
  interruption: "allowed",
  ...overrides,
});

/** A fake of the MCP swarm's client: it records sessions and answers from a fixed tool list. */
function fakeClient(
  options: {
    tools?: McpToolDescriptor[];
    result?: { content: unknown; isError?: boolean };
    /** When set, the client really dials the session URL so a double can observe it. */
    dial?: boolean;
  } = {},
): McpClientPort & { sessions: McpServerSession[]; calls: Array<{ name: string; arguments: Record<string, unknown> }> } {
  const sessions: McpServerSession[] = [];
  const calls: Array<{ name: string; arguments: Record<string, unknown> }> = [];
  const dial = async (session: McpServerSession, body: unknown) => {
    if (!options.dial) return;
    const headers: Record<string, string> = {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
    };
    if (session.authorization.kind === "bearer")
      await session.authorization.use(async (token) => {
        headers.authorization = `Bearer ${token}`;
      });
    const response = await session.fetch(session.url, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      redirect: "error",
      signal: session.signal,
    });
    await response.body?.cancel();
  };
  return {
    sessions,
    calls,
    async listTools(session) {
      sessions.push(session);
      await dial(session, { jsonrpc: "2.0", id: 1, method: "tools/list" });
      return {
        tools:
          options.tools ??
          [...supabaseMcpTools.database, ...supabaseMcpTools.docs].map((name) => ({
            name,
          })),
      };
    },
    async callTool(session, call) {
      sessions.push(session);
      calls.push(call);
      await dial(session, {
        jsonrpc: "2.0",
        id: 2,
        method: "tools/call",
        params: call,
      });
      return options.result ?? { content: [{ type: "text", text: "ok" }] };
    },
  };
}

test("AC-SB-04: approved restrictions become the server URL, and the URL is never caller-supplied", async (t) => {
  const seen: URL[] = [];
  const double = await startHttpFixture(async (request) => {
    seen.push(request.url);
    return { status: 200, body: { jsonrpc: "2.0", id: 1, result: { tools: [] } } };
  });
  t.after(() => double.close());
  const client = fakeClient({ dial: true });
  const profile = createSupabaseHostedMcpProfile({ client });
  const h = await supabaseHarness({
    binding: mcpBinding({
      origin: double.origin,
      settings: {
        project_ref: PROJECT_REF,
        read_only: true,
        features: ["database", "docs"],
      },
      tools: [{ name: "list_tables" }, { name: "search_docs" }],
    }),
    fetch,
  });
  t.after(() => h.close());

  await profile.verify!(h.ctx);
  assert.equal(seen.length, 1);
  const dialed = seen[0]!;
  assert.equal(dialed.pathname, "/mcp");
  assert.equal(dialed.searchParams.get("project_ref"), PROJECT_REF);
  assert.equal(dialed.searchParams.get("read_only"), "true");
  assert.equal(dialed.searchParams.get("features"), "database,docs");
  assert.equal(
    [...dialed.searchParams.keys()].sort().join(","),
    "features,project_ref,read_only",
    "only the three documented parameters are sent",
  );

  // The same settings resolve to a pinned origin and a documented resource.
  const resolved = resolveSupabaseHostedMcpBinding(h.ctx.binding);
  assert.equal(resolved.url.origin, double.origin);
  assert.equal(resolved.resource, `${double.origin}/mcp`);
  assert.equal(resolved.settings.authorization, "dynamic-client-registration");
  assert.equal(resolved.settings.protocol, "mcp-2026-07-28");
});

test("An arbitrary URL carrying read_only=true cannot be supplied in place of the approved binding", async (t) => {
  const client = fakeClient();
  const profile = createSupabaseHostedMcpProfile({ client });

  // A destination that is not the documented host is refused, however the
  // settings are spelled.
  const foreign = await supabaseHarness({
    binding: mcpBinding({
      origin: "https://mcp.supabase.com.attacker.example",
      settings: { project_ref: PROJECT_REF, read_only: true },
      tools: [{ name: "list_tables" }],
      overrides: {
        destinations: [
          {
            id: "mcp",
            origin: "https://mcp.supabase.com.attacker.example",
            pathPrefix: "/mcp",
            network: "public",
          },
        ],
      },
    }),
    fetch,
  });
  t.after(() => foreign.close());
  assert.throws(
    () => resolveSupabaseHostedMcpBinding(foreign.ctx.binding),
    (error: unknown) =>
      error instanceof ConnectorError &&
      error.code === "network-policy" &&
      error.detail === "supabase.mcp.destination-not-pinned",
  );
  await assert.rejects(() => profile.verify!(foreign.ctx), ConnectorError);
  assert.equal(client.sessions.length, 0);

  // A path outside /mcp is refused too.
  const badPath = await supabaseHarness({
    binding: mcpBinding({
      origin: "https://mcp.supabase.com",
      settings: { project_ref: PROJECT_REF },
      overrides: {
        destinations: [
          {
            id: "mcp",
            origin: "https://mcp.supabase.com",
            pathPrefix: "/projects",
            network: "public",
          },
        ],
      },
    }),
    fetch,
  });
  t.after(() => badPath.close());
  assert.throws(
    () => resolveSupabaseHostedMcpBinding(badPath.ctx.binding),
    (error: unknown) =>
      error instanceof ConnectorError &&
      error.detail === "supabase.mcp.path-not-pinned",
  );
});

test("Overbroad feature requests and host policy are enforced when the binding resolves", async (t) => {
  const profile = createSupabaseHostedMcpProfile({
    client: fakeClient(),
    policy: { allowedFeatures: ["database", "docs"], requireReadOnly: true, requireProjectScope: true },
  });

  const overbroad = await supabaseHarness({
    binding: mcpBinding({
      origin: "https://mcp.supabase.com",
      settings: {
        project_ref: PROJECT_REF,
        read_only: true,
        features: ["database", "storage"],
      },
      overrides: {
        destinations: [
          { id: "mcp", origin: "https://mcp.supabase.com", pathPrefix: "/mcp", network: "public" },
        ],
      },
    }),
    fetch,
  });
  t.after(() => overbroad.close());
  await assert.rejects(
    () => profile.verify!(overbroad.ctx),
    (error: unknown) =>
      error instanceof ConnectorError &&
      error.code === "denied" &&
      error.detail === "supabase.mcp.features-overbroad",
  );

  const writable = await supabaseHarness({
    binding: mcpBinding({
      origin: "https://mcp.supabase.com",
      settings: { project_ref: PROJECT_REF, read_only: false, features: ["database"] },
      overrides: {
        destinations: [
          { id: "mcp", origin: "https://mcp.supabase.com", pathPrefix: "/mcp", network: "public" },
        ],
      },
    }),
    fetch,
  });
  t.after(() => writable.close());
  await assert.rejects(
    () => profile.verify!(writable.ctx),
    (error: unknown) =>
      error instanceof ConnectorError &&
      error.detail === "supabase.mcp.read-only-required",
  );

  const unscoped = await supabaseHarness({
    binding: mcpBinding({
      origin: "https://mcp.supabase.com",
      settings: { read_only: true, features: ["database"] },
      overrides: {
        destinations: [
          { id: "mcp", origin: "https://mcp.supabase.com", pathPrefix: "/mcp", network: "public" },
        ],
      },
    }),
    fetch,
  });
  t.after(() => unscoped.close());
  await assert.rejects(
    () => profile.verify!(unscoped.ctx),
    (error: unknown) =>
      error instanceof ConnectorError &&
      error.detail === "supabase.mcp.project-scope-required",
  );

  // A project ref outside the binding's permitted targets is refused.
  const foreignProject = await supabaseHarness({
    binding: mcpBinding({
      origin: "https://mcp.supabase.com",
      settings: { project_ref: OTHER_PROJECT_REF, read_only: true, features: ["database"] },
      overrides: {
        destinations: [
          { id: "mcp", origin: "https://mcp.supabase.com", pathPrefix: "/mcp", network: "public" },
        ],
      },
    }),
    fetch,
  });
  t.after(() => foreignProject.close());
  await assert.rejects(
    () => profile.verify!(foreignProject.ctx),
    (error: unknown) =>
      error instanceof ConnectorError &&
      error.detail === "supabase.target.not-permitted",
  );

  // Account tools contradict project scoping, as the documentation states.
  const accountScoped = await supabaseHarness({
    binding: mcpBinding({
      origin: "https://mcp.supabase.com",
      settings: { project_ref: PROJECT_REF, read_only: true, features: ["account"] },
      overrides: {
        destinations: [
          { id: "mcp", origin: "https://mcp.supabase.com", pathPrefix: "/mcp", network: "public" },
        ],
      },
    }),
    fetch,
  });
  t.after(() => accountScoped.close());
  assert.throws(
    () => resolveSupabaseHostedMcpBinding(accountScoped.ctx.binding),
    (error: unknown) =>
      error instanceof ConnectorError &&
      error.detail === "supabase.mcp.account-with-project-scope",
  );
});

test("A read-only binding cannot bind or invoke a mutating tool", async (t) => {
  const client = fakeClient();
  const profile = createSupabaseHostedMcpProfile({ client });

  const h = await supabaseHarness({
    binding: mcpBinding({
      origin: "https://mcp.supabase.com",
      settings: { project_ref: PROJECT_REF, read_only: true, features: ["database"] },
      tools: [{ name: "apply_migration", effect: "write" }],
      overrides: {
        destinations: [
          { id: "mcp", origin: "https://mcp.supabase.com", pathPrefix: "/mcp", network: "public" },
        ],
      },
    }),
    fetch,
  });
  t.after(() => h.close());
  assert.throws(
    () => resolveSupabaseHostedMcpBinding(h.ctx.binding),
    (error: unknown) =>
      error instanceof ConnectorError &&
      error.detail === "supabase.mcp.read-only-binding",
  );
  assert.equal(client.calls.length, 0);

  // A tool outside the enabled feature groups is refused as well.
  const outsideFeatures = await supabaseHarness({
    binding: mcpBinding({
      origin: "https://mcp.supabase.com",
      settings: { project_ref: PROJECT_REF, read_only: true, features: ["docs"] },
      tools: [{ name: "list_tables" }],
      overrides: {
        destinations: [
          { id: "mcp", origin: "https://mcp.supabase.com", pathPrefix: "/mcp", network: "public" },
        ],
      },
    }),
    fetch,
  });
  t.after(() => outsideFeatures.close());
  assert.throws(
    () => resolveSupabaseHostedMcpBinding(outsideFeatures.ctx.binding),
    (error: unknown) =>
      error instanceof ConnectorError &&
      error.detail === "supabase.mcp.tool-not-enabled",
  );
});

test("Approved tools invoke through the delegated client; project arguments stay inside the scope", async (t) => {
  const client = fakeClient();
  const profile = createSupabaseHostedMcpProfile({ client });
  const h = await supabaseHarness({
    binding: mcpBinding({
      origin: "https://mcp.supabase.com",
      settings: { project_ref: PROJECT_REF, read_only: true, features: ["database", "docs"] },
      tools: [{ name: "list_tables" }],
      overrides: {
        destinations: [
          { id: "mcp", origin: "https://mcp.supabase.com", pathPrefix: "/mcp", network: "public" },
        ],
      },
    }),
    fetch,
  });
  t.after(() => h.close());

  const result = await profile.invoke!(h.ctx, {
    operationRef: "operation:list_tables",
    input: { schemas: ["public"], project_id: PROJECT_REF },
    commandId: "command-1",
  });
  assert.equal(result.state, "complete");
  assert.equal(result.effect, "read");
  assert.equal(result.outputClassification, "personal");
  // The server omits project_id when scoped, so the adapter drops the redundant argument.
  assert.deepEqual(client.calls.at(-1), {
    name: "list_tables",
    arguments: { schemas: ["public"] },
  });

  // A different project in the arguments is refused before the call.
  await assert.rejects(
    () =>
      profile.invoke!(h.ctx, {
        operationRef: "operation:list_tables",
        input: { project_id: OTHER_PROJECT_REF },
        commandId: "command-2",
      }),
    (error: unknown) =>
      error instanceof ConnectorError &&
      error.detail === "supabase.target.out-of-scope",
  );
  assert.equal(client.calls.length, 1);

  // An operation the binding does not carry cannot be named.
  await assert.rejects(
    () =>
      profile.invoke!(h.ctx, {
        operationRef: "operation:execute_sql",
        input: {},
        commandId: "command-3",
      }),
    (error: unknown) =>
      error instanceof ConnectorError && error.code === "not-found",
  );
});

test("Verification refuses a server that does not honour the approved restrictions", async (t) => {
  // The binding says read_only and project scope; the server advertises a
  // mutating tool and an account tool anyway.
  const dishonest = fakeClient({
    tools: [{ name: "list_tables" }, { name: "apply_migration" }, { name: "list_projects" }],
  });
  const profile = createSupabaseHostedMcpProfile({ client: dishonest });
  const h = await supabaseHarness({
    binding: mcpBinding({
      origin: "https://mcp.supabase.com",
      settings: { project_ref: PROJECT_REF, read_only: true, features: ["database"] },
      tools: [{ name: "list_tables" }],
      overrides: {
        destinations: [
          { id: "mcp", origin: "https://mcp.supabase.com", pathPrefix: "/mcp", network: "public" },
        ],
      },
    }),
    fetch,
  });
  t.after(() => h.close());
  const result = await profile.verify!(h.ctx);
  assert.equal(result.state, "denied");
  assert.equal(result.code, "supabase.mcp.configuration-not-honoured");
  assert.deepEqual(result.claims, []);
});

test("Verification records what the server advertises as a permission observation, not as access", async (t) => {
  const client = fakeClient({ tools: [{ name: "list_tables" }, { name: "search_docs" }] });
  const profile = createSupabaseHostedMcpProfile({ client });
  const h = await supabaseHarness({
    binding: mcpBinding({
      origin: "https://mcp.supabase.com",
      settings: { project_ref: PROJECT_REF, read_only: true, features: ["database", "docs"] },
      tools: [{ name: "list_tables" }],
      overrides: {
        destinations: [
          { id: "mcp", origin: "https://mcp.supabase.com", pathPrefix: "/mcp", network: "public" },
        ],
      },
    }),
    fetch,
  });
  t.after(() => h.close());
  const result = await profile.verify!(h.ctx);
  assert.equal(result.state, "complete");
  const claim = result.claims[0]!;
  // The server accepted the token and reported a tool set; nothing was
  // observed, so this is not a permission-observed claim.
  assert.equal(claim.kind, "credential-accepted");
  assert.deepEqual(claim.permissions?.requested, ["list_tables"]);
  assert.deepEqual(claim.permissions?.reported, ["list_tables", "search_docs"]);
  assert.deepEqual(claim.permissions?.observed, []);
  assert.ok(
    claim.limitations.some((item) => item.includes("advertises")),
    "advertisement is not access",
  );
  assert.deepEqual(result.target, { kind: "supabase-project", id: PROJECT_REF });

  // Default feature groups follow the documented set: everything except storage.
  assert.deepEqual([...supabaseMcpDefaultFeatureGroups].sort(), [
    "account",
    "branching",
    "database",
    "debugging",
    "development",
    "docs",
    "functions",
  ]);
});

test("Without a registered authorization profile, authorize reports unsupported rather than improvising", async (t) => {
  const profile = createSupabaseHostedMcpProfile({ client: fakeClient() });
  const h = await supabaseHarness({
    binding: mcpBinding({
      origin: "https://mcp.supabase.com",
      settings: { project_ref: PROJECT_REF, read_only: true, features: ["database"] },
      tools: [{ name: "list_tables" }],
      overrides: {
        destinations: [
          { id: "mcp", origin: "https://mcp.supabase.com", pathPrefix: "/mcp", network: "public" },
        ],
      },
    }),
    fetch,
  });
  t.after(() => h.close());
  const start = await profile.authorize!(h.ctx, intentFor());
  assert.equal(start.kind, "unsupported");
  assert.equal(
    (start as { code: string }).code,
    "supabase.mcp.authorization-port-missing",
  );

  const rows = profile.capabilities(new Set());
  assert.equal(
    rows.find((row) => row.dimension === "authorize")?.implementation,
    "unsupported",
  );
  assert.equal(
    rows.find((row) => row.dimension === "revoke")?.implementation,
    "unsupported",
  );
  assert.ok(
    rows
      .find((row) => row.dimension === "revoke")
      ?.limitations.some((item) => item.includes("dashboard")),
    "the documented alternative to a missing revoke route is recorded",
  );
});

test("The authorization profile receives the pinned resource and the documented registration mode", async (t) => {
  const requests: Array<Record<string, unknown>> = [];
  const profile = createSupabaseHostedMcpProfile({
    client: fakeClient(),
    authorization: {
      async begin(_ctx, request) {
        requests.push({ ...request, serverUrl: request.serverUrl.href });
        return { kind: "verify" };
      },
      async complete() {
        return { state: "complete", claims: [], credentialRef: "cred:mcp" };
      },
    },
  });
  const h = await supabaseHarness({
    binding: mcpBinding({
      origin: "https://mcp.supabase.com",
      settings: {
        project_ref: PROJECT_REF,
        read_only: true,
        features: ["database"],
        authorization: "oauth-app",
        protocol: "mcp-2025-11-25",
      },
      tools: [{ name: "list_tables" }],
      overrides: {
        destinations: [
          { id: "mcp", origin: "https://mcp.supabase.com", pathPrefix: "/mcp", network: "public" },
        ],
      },
    }),
    fetch,
  });
  t.after(() => h.close());

  const start = await profile.authorize!(h.ctx, intentFor());
  assert.equal(start.kind, "verify");
  assert.deepEqual(requests.at(-1), {
    serverUrl: `https://mcp.supabase.com/mcp?project_ref=${PROJECT_REF}&read_only=true&features=database`,
    resource: "https://mcp.supabase.com/mcp",
    registration: "oauth-app",
    protocol: "mcp-2025-11-25",
    credentialKind: "hosted-mcp-access-token",
    intent: intentFor(),
  });

  const completed = await profile.complete!(h.ctx, { kind: "poll" });
  assert.equal(completed.state, "complete");
  assert.deepEqual(completed.target, {
    kind: "supabase-project",
    id: PROJECT_REF,
  });
  assert.equal(
    (completed.adapterState as { readOnly: boolean }).readOnly,
    true,
  );
  assert.equal(
    (completed.adapterState as { authorization: string }).authorization,
    "oauth-app",
  );
});
