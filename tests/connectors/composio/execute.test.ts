import assert from "node:assert/strict";
import { after, describe, it } from "node:test";
import { canaries, canaryValues } from "../fixtures/builders.js";
import { canonicalDigest } from "../../../src/core/connectors/index.js";
import { ConnectorError } from "../../../src/server/connectors/errors.js";
import {
  ACCOUNT_B,
  READ_TOOL,
  RETIRED_VERSION,
  TOOLKIT,
  TOOLKIT_VERSION,
  WRITE_TOOL,
  account,
  activeConnection,
  defaultSettings,
  harness,
  metaOperation,
  readOperation,
  sessionOperation,
  stringsIn,
  unlistedOperation,
  writeOperation,
  type Harness,
} from "./harness.js";

/*
 * CO-03: approved tool and action execution through the documented direct or
 * session API profile, with a binding allowlist of tools and permitted
 * accounts. Oracles AC-EXT-03 (account substitution) and AC-EXT-04 (meta tools
 * and version drift) are exercised here.
 */

const open: Harness[] = [];
async function start(...args: Parameters<typeof harness>) {
  const created = await harness(...args);
  open.push(created);
  return created;
}
after(async () => {
  for (const item of open) await item.close();
});

const withAccount: Parameters<typeof harness>[0] = {
  double: { accounts: [account()] },
};

function bodyOf(request: { body: Buffer }): Record<string, unknown> {
  return JSON.parse(request.body.toString("utf8")) as Record<string, unknown>;
}

function request(overrides: Record<string, unknown> = {}) {
  return {
    operationRef: readOperation.operationRef,
    input: { per_page: 10 },
    commandId: "command-1",
    ...overrides,
  } as Parameters<NonNullable<Harness["adapter"]["invoke"]>>[1];
}

describe("Composio execution", () => {
  it("sends the documented direct execution body and classifies the output", async () => {
    const h = await start({ ...withAccount });
    const connection = activeConnection(h.binding);
    const result = await h.adapter.invoke!(
      h.context({ connection }),
      request(),
    );
    assert.equal(result.state, "complete");
    assert.equal(result.outputClassification, "personal");
    assert.equal(result.effect, "read");
    assert.deepEqual(result.output, { ok: true, tool: READ_TOOL });
    const [executed] = h.double.received(
      "POST",
      `/api/v3/tools/execute/${READ_TOOL}`,
    );
    assert.ok(executed);
    const body = bodyOf(executed);
    assert.equal(body.user_id, h.userId);
    assert.equal(
      body.connected_account_id,
      connection.externalIds.connectedAccountId,
    );
    assert.equal(body.version, TOOLKIT_VERSION);
    assert.deepEqual(body.arguments, { per_page: 10 });
    // The pinned version was checked against the live catalogue first.
    assert.equal(
      h.double.received("GET", `/api/v3/tools/${READ_TOOL}`).length,
      1,
    );
  });

  it("refuses an argument the operation did not declare", async () => {
    const h = await start({ ...withAccount });
    const connection = activeConnection(h.binding);
    await assert.rejects(
      () =>
        h.adapter.invoke!(
          h.context({ connection }),
          request({ input: { per_page: 5, sort: "stars" } }),
        ),
      (error: unknown) =>
        error instanceof ConnectorError &&
        error.code === "invalid-request" &&
        error.detail === "composio.arguments.unknown",
    );
  });

  it("refuses identity-bearing argument names whatever the binding declares", async () => {
    // AC-EXT-03 / model-supplied identity: naming another account or another
    // Composio user in the arguments is a substitution attempt, not an input.
    const h = await start({
      ...withAccount,
      binding: {
        settings: defaultSettings({
          operations: {
            [readOperation.operationRef]: {
              arguments: ["per_page"],
            },
          },
        }),
      },
    });
    const connection = activeConnection(h.binding);
    for (const name of [
      "user_id",
      "connected_account_id",
      "version",
      "custom_auth_params",
      "session_id",
      "__proto__",
    ])
      await assert.rejects(
        () =>
          h.adapter.invoke!(
            h.context({ connection }),
            request({ input: { [name]: "attacker" } }),
          ),
        (error: unknown) =>
          error instanceof ConnectorError && error.code === "invalid-request",
        `${name} was accepted`,
      );
    assert.equal(
      h.double.received("POST", `/api/v3/tools/execute/${READ_TOOL}`).length,
      0,
    );
  });

  it("checks a target parameter against the binding's permitted targets", async () => {
    const h = await start({ ...withAccount });
    const connection = activeConnection(h.binding);
    const ok = await h.adapter.invoke!(
      h.context({ connection }),
      request({
        operationRef: writeOperation.operationRef,
        input: { owner: "octocat", repo: "hello", title: "Hi" },
      }),
    );
    assert.equal(ok.state, "complete");
    await assert.rejects(
      () =>
        h.adapter.invoke!(
          h.context({ connection }),
          request({
            operationRef: writeOperation.operationRef,
            commandId: "command-2",
            input: { owner: "someone-else", repo: "hello", title: "Hi" },
          }),
        ),
      (error: unknown) =>
        error instanceof ConnectorError &&
        error.detail === "composio.target.not-permitted",
    );
  });

  it("refuses a bound operation whose tool the binding did not allowlist", async () => {
    const h = await start({ ...withAccount });
    const connection = activeConnection(h.binding);
    await assert.rejects(
      () =>
        h.adapter.invoke!(
          h.context({ connection }),
          request({ operationRef: unlistedOperation.operationRef, input: {} }),
        ),
      (error: unknown) =>
        error instanceof ConnectorError &&
        error.detail === "composio.tool.unapproved",
    );
  });

  it("refuses an operation reference the binding does not carry", async () => {
    const h = await start({ ...withAccount });
    const connection = activeConnection(h.binding);
    await assert.rejects(
      () =>
        h.adapter.invoke!(
          h.context({ connection }),
          request({ operationRef: "composio.anything.else", input: {} }),
        ),
      (error: unknown) =>
        error instanceof ConnectorError &&
        error.detail === "composio.operation.unbound",
    );
  });

  it("keeps the account-management meta tool disabled without an explicit grant", async () => {
    // AC-EXT-04: an unrestricted management meta tool is bound as an operation
    // but no binding entry authorizes it.
    const h = await start({
      ...withAccount,
      binding: { settings: defaultSettings({ execution: "session" }) },
    });
    const connection = activeConnection(h.binding);
    await assert.rejects(
      () =>
        h.adapter.invoke!(
          h.context({ connection }),
          request({ operationRef: metaOperation.operationRef, input: {} }),
        ),
      (error: unknown) =>
        error instanceof ConnectorError &&
        error.code === "denied" &&
        error.detail === "composio.meta-tool.unapproved",
    );
    assert.equal(
      h.double.received("POST", "/api/v3/tool_router/session").length,
      0,
    );
  });

  it("creates a session with connection management off and executes the approved tool", async () => {
    const h = await start({
      ...withAccount,
      binding: { settings: defaultSettings({ execution: "session" }) },
    });
    const connection = activeConnection(h.binding);
    const result = await h.adapter.invoke!(
      h.context({ connection }),
      request({ operationRef: sessionOperation.operationRef }),
    );
    assert.equal(result.state, "complete");
    const [created] = h.double.received("POST", "/api/v3/tool_router/session");
    assert.ok(created);
    const body = bodyOf(created);
    assert.equal(body.user_id, h.userId);
    assert.deepEqual(body.toolkits, [TOOLKIT]);
    assert.deepEqual(body.manage_connections, {
      enable: false,
      enable_wait_for_connections: false,
      enable_connection_removal: false,
    });
    assert.deepEqual(body.multi_account, {
      enable: true,
      max_accounts_per_toolkit: 1,
      require_explicit_selection: true,
    });
    const sessionId = [...h.double.sessions.keys()][0]!;
    const [executed] = h.double.received(
      "POST",
      `/api/v3/tool_router/session/${sessionId}/execute`,
    );
    const executeBody = bodyOf(executed!);
    assert.equal(executeBody.tool_slug, READ_TOOL);
    assert.equal(
      executeBody.account,
      connection.externalIds.connectedAccountId,
    );
    // The session's MCP URL is a private handle; it never reaches a result.
    const text = stringsIn(result).join(" ");
    assert.ok(!text.includes("/mcp/"));
  });

  it("refuses to use a session that advertises an unapproved meta tool", async () => {
    // AC-EXT-04: the broker hands back a session that can manage connections.
    const h = await start({
      ...withAccount,
      double: {
        accounts: [account()],
        sessionToolRouterTools: [READ_TOOL, "COMPOSIO_MANAGE_CONNECTIONS"],
      },
      binding: { settings: defaultSettings({ execution: "session" }) },
    });
    const connection = activeConnection(h.binding);
    await assert.rejects(
      () =>
        h.adapter.invoke!(
          h.context({ connection }),
          request({ operationRef: sessionOperation.operationRef }),
        ),
      (error: unknown) =>
        error instanceof ConnectorError &&
        error.detail === "composio.session.meta-tool-unapproved",
    );
    assert.equal(
      h.double.requests.filter((item) => item.url.pathname.endsWith("/execute"))
        .length,
      0,
    );
  });

  it("recreates a session Composio no longer holds, under the same checks", async () => {
    const h = await start({
      ...withAccount,
      double: { accounts: [account()], staleSessionOnce: true },
      binding: { settings: defaultSettings({ execution: "session" }) },
    });
    const connection = activeConnection(h.binding);
    const result = await h.adapter.invoke!(
      h.context({ connection }),
      request({ operationRef: sessionOperation.operationRef }),
    );
    assert.equal(result.state, "complete");
    assert.equal(
      h.double.received("POST", "/api/v3/tool_router/session").length,
      2,
      "a stale session is replaced, not reused",
    );
  });

  it("refuses a pinned tool version the toolkit no longer serves", async () => {
    // AC-EXT-04: version drift stops execution rather than silently running
    // whatever the toolkit serves today.
    const h = await start({
      ...withAccount,
      binding: {
        settings: defaultSettings({
          toolkit: { slug: TOOLKIT, version: RETIRED_VERSION },
        }),
      },
    });
    const connection = activeConnection(h.binding);
    await assert.rejects(
      () => h.adapter.invoke!(h.context({ connection }), request()),
      (error: unknown) =>
        error instanceof ConnectorError &&
        error.code === "unsupported" &&
        error.detail === "composio.tool.version-unavailable",
    );
    assert.equal(
      h.double.received("POST", `/api/v3/tools/execute/${READ_TOOL}`).length,
      0,
    );
  });

  it("refuses a tool whose reviewed input schema changed", async () => {
    const h = await start({
      ...withAccount,
      binding: {
        settings: defaultSettings({
          operations: {
            [readOperation.operationRef]: {
              arguments: ["per_page"],
              schemaDigest: await canonicalDigest({ reviewed: "earlier" }),
            },
          },
        }),
      },
    });
    const connection = activeConnection(h.binding);
    await assert.rejects(
      () => h.adapter.invoke!(h.context({ connection }), request()),
      (error: unknown) =>
        error instanceof ConnectorError &&
        error.code === "conflict" &&
        error.detail === "composio.tool.schema-drift",
    );
  });

  it("accepts the reviewed input schema digest it was pinned to", async () => {
    const digest = await canonicalDigest({
      type: "object",
      properties: { per_page: { type: "integer" } },
    });
    const h = await start({
      ...withAccount,
      binding: {
        settings: defaultSettings({
          operations: {
            [readOperation.operationRef]: {
              arguments: ["per_page"],
              schemaDigest: digest,
            },
          },
        }),
      },
    });
    const connection = activeConnection(h.binding);
    const result = await h.adapter.invoke!(
      h.context({ connection }),
      request(),
    );
    assert.equal(result.state, "complete");
  });

  it("never lets an upstream error payload leave the adapter", async () => {
    const h = await start({
      double: {
        accounts: [account()],
        execute: () => ({
          successful: false,
          error: `${canaries.providerMessage} token=${canaries.token}`,
          data: { note: canaries.secret },
        }),
      },
    });
    const connection = activeConnection(h.binding);
    const result = await h.adapter.invoke!(
      h.context({ connection }),
      request(),
    );
    assert.equal(result.state, "failed");
    assert.equal(result.code, "composio.tool.failed");
    assert.equal(result.output, undefined);
    const text = stringsIn(result).join(" ");
    for (const canary of canaryValues)
      assert.ok(!text.includes(canary), `leaked ${canary}`);
  });

  it("sanitizes an upstream transport failure into a code without provider text", async () => {
    const h = await start({
      double: {
        accounts: [account()],
        execute: () => ({ status: 403, error: canaries.providerMessage }),
      },
    });
    const connection = activeConnection(h.binding);
    await assert.rejects(
      () => h.adapter.invoke!(h.context({ connection }), request()),
      (error: unknown) => {
        assert.ok(error instanceof ConnectorError);
        assert.equal(error.code, "upstream-rejected");
        assert.ok(!error.message.includes(canaries.providerMessage));
        assert.ok(!String(error.detail).includes("CANARY"));
        return true;
      },
    );
  });

  it("refuses to execute for a connection whose account is not active", async () => {
    const h = await start({
      double: { accounts: [account({ status: "INACTIVE" })] },
    });
    const connection = activeConnection(h.binding, {
      state: { composioStatus: "INACTIVE" },
    });
    await assert.rejects(
      () => h.adapter.invoke!(h.context({ connection }), request()),
      (error: unknown) =>
        error instanceof ConnectorError &&
        error.detail === "composio.account.not-active",
    );
    const degraded = activeConnection(h.binding, { lifecycle: "degraded" });
    await assert.rejects(
      () => h.adapter.invoke!(h.context({ connection: degraded }), request()),
      (error: unknown) =>
        error instanceof ConnectorError &&
        error.detail === "composio.connection.not-active",
    );
    assert.equal(
      h.double.received("POST", `/api/v3/tools/execute/${READ_TOOL}`).length,
      0,
    );
  });

  it("fences an invocation against an older connection generation", async () => {
    const h = await start({ ...withAccount });
    const connection = activeConnection(h.binding, { generation: 1 });
    await assert.rejects(
      () =>
        h.adapter.invoke!(h.context({ connection, generation: 2 }), request()),
      (error: unknown) =>
        error instanceof ConnectorError &&
        error.detail === "composio.connection.stale-generation",
    );
  });

  it("refuses an account the binding does not permit", async () => {
    const h = await start({
      double: { accounts: [account({ id: ACCOUNT_B })] },
    });
    const connection = activeConnection(h.binding, {
      externalIds: {
        connectedAccountId: ACCOUNT_B,
        authConfigId: h.binding.settings.authConfigs
          ? String(
              (h.binding.settings as never as { authConfigs: string[] })
                .authConfigs[0],
            )
          : "",
        toolkitSlug: TOOLKIT,
        userId: h.userId,
        authority: h.binding.authorityInstance,
      },
    });
    await assert.rejects(
      () => h.adapter.invoke!(h.context({ connection }), request()),
      (error: unknown) =>
        error instanceof ConnectorError &&
        error.detail === "composio.account.not-permitted",
    );
  });

  it("does not repeat an unreplayable write whose outcome is already journaled", async () => {
    const h = await start({ ...withAccount });
    const connection = activeConnection(h.binding);
    const write = request({
      operationRef: writeOperation.operationRef,
      input: { owner: "octocat", repo: "hello", title: "Hi" },
      commandId: "command-write",
    });
    const first = await h.adapter.invoke!(h.context({ connection }), write);
    assert.equal(first.state, "complete");
    const second = await h.adapter.invoke!(h.context({ connection }), write);
    assert.equal(second.code, "composio.effect.replayed");
    assert.equal(
      h.double.received("POST", `/api/v3/tools/execute/${WRITE_TOOL}`).length,
      1,
      "the write was not sent twice",
    );
  });

  it("repeats a read-only operation without consulting the journal", async () => {
    const h = await start({ ...withAccount });
    const connection = activeConnection(h.binding);
    await h.adapter.invoke!(h.context({ connection }), request());
    await h.adapter.invoke!(h.context({ connection }), request());
    assert.equal(
      h.double.received("POST", `/api/v3/tools/execute/${READ_TOOL}`).length,
      2,
    );
  });

  it("refuses a session route when the binding runs the direct profile", async () => {
    const h = await start({ ...withAccount });
    const connection = activeConnection(h.binding);
    await assert.rejects(
      () =>
        h.adapter.invoke!(
          h.context({ connection }),
          request({ operationRef: sessionOperation.operationRef }),
        ),
      (error: unknown) =>
        error instanceof ConnectorError &&
        error.detail === "composio.execution.profile",
    );
  });
});
