import assert from "node:assert/strict";
import { after, test } from "node:test";
import { ConnectorError } from "../../../src/server/connectors/errors.js";
import type { RuntimeBinding } from "../../../src/server/connectors/binding.js";
import type { ConnectionRecord } from "../../../src/server/connectors/ports.js";
import {
  bindAccount,
  defaultOperations,
  defaultSettings,
  makeBinding,
  makeConnection,
  makeContext,
  startHarness,
  type Harness,
} from "./harness.js";

/*
 * PD-03: approved proxy and action execution. The binding fixes the method,
 * the upstream URL and the component; the connection fixes the account; the
 * host derives the external user. What is left for a caller is validated
 * input, and these tests try to turn that input into a destination, a header
 * or an account.
 */

const open: Harness[] = [];
async function harness(options: Parameters<typeof startHarness>[0] = {}) {
  const started = await startHarness(options);
  open.push(started);
  return started;
}
after(async () => {
  for (const item of open) await item.close();
});

async function connected(
  h: Harness,
  options: { binding?: RuntimeBinding; accountId?: string } = {},
): Promise<{ binding: RuntimeBinding; connection: ConnectionRecord }> {
  const binding =
    options.binding ?? makeBinding({ apiOrigin: h.double.origin });
  const account = h.double.seedAccount({
    externalUserId: h.externalUserId(),
    app: "slack",
    environment: h.environment,
    ...(options.accountId ? { id: options.accountId } : {}),
  });
  const connection = await bindAccount(h, makeConnection({ binding }), {
    accountId: account.id,
    externalUserId: h.externalUserId(),
    projectId: h.double.projectId,
    environment: h.environment,
    app: "slack",
  });
  return { binding, connection };
}

test("a proxied write goes to the bound URL with the connection's account", async () => {
  const h = await harness();
  const { binding, connection } = await connected(h, {
    accountId: "apn_bound",
  });
  h.double.setUpstream((call) => ({
    status: 200,
    body: { ok: true, echo: JSON.parse(call.body || "{}") },
  }));

  const result = await h.adapter.invoke!(
    makeContext({ harness: h, binding, connection }),
    {
      operationRef: "proxy.post-message",
      commandId: "cmd-1",
      input: { body: { channel: "C123", text: "hello" } },
    },
  );

  assert.equal(result.state, "complete");
  assert.equal(result.effect, "write");
  assert.equal(result.outputClassification, "personal");
  assert.equal(h.double.proxyCalls.length, 1);
  const call = h.double.proxyCalls[0]!;
  assert.equal(call.url, "https://slack.com/api/chat.postMessage");
  assert.equal(call.method, "POST");
  assert.equal(call.accountId, "apn_bound");
  assert.equal(call.externalUserId, h.externalUserId());
  assert.equal(call.environment, "production");
  // Host-approved upstream headers travel under the documented proxy prefix.
  assert.equal(call.headers["x-pd-proxy-x-fixture-tag"], "ceremony");
  assert.equal(JSON.parse(call.body).text, "hello");

  // The request path is the documented url_64 form of the bound URL.
  const [request] = h.double.received(
    "POST",
    `/v1/connect/${h.double.projectId}/proxy/${Buffer.from(
      "https://slack.com/api/chat.postMessage",
      "utf8",
    ).toString("base64url")}`,
  );
  assert.ok(request, "the proxy path is the url-safe base64 of the bound URL");
  assert.equal(request.url.searchParams.get("account_id"), "apn_bound");
  assert.equal(request.headers["x-pd-environment"], "production");
});

test("a read that names a permitted target reaches it and an unpermitted one does not", async () => {
  const h = await harness();
  const { binding, connection } = await connected(h);
  h.double.setUpstream(() => ({ status: 200, body: { team: "ok" } }));

  const allowed = await h.adapter.invoke!(
    makeContext({ harness: h, binding, connection }),
    {
      operationRef: "proxy.team",
      commandId: "cmd-target-1",
      input: { path: { teamId: "T01PERMITTED" } },
    },
  );
  assert.equal(allowed.state, "complete");
  assert.equal(
    h.double.proxyCalls[0]!.url,
    "https://slack.com/api/teams/T01PERMITTED/info",
  );

  await assert.rejects(
    h.adapter.invoke!(makeContext({ harness: h, binding, connection }), {
      operationRef: "proxy.team",
      commandId: "cmd-target-2",
      input: { path: { teamId: "T99OTHER" } },
    }),
    (error: unknown) =>
      error instanceof ConnectorError &&
      error.code === "denied" &&
      error.detail === "pipedream.target.not-permitted",
  );
  assert.equal(
    h.double.proxyCalls.length,
    1,
    "nothing left for the other team",
  );
});

test("input cannot become a destination, a query parameter or a header", async () => {
  const h = await harness();
  const { binding, connection } = await connected(h);
  const ctx = () => makeContext({ harness: h, binding, connection });

  // A path value that tries to escape its segment is encoded, not joined.
  h.double.setUpstream(() => ({ status: 200, body: { ok: true } }));
  await h.adapter.invoke!(ctx(), {
    operationRef: "proxy.team",
    commandId: "cmd-escape",
    input: { path: { teamId: "T01PERMITTED" } },
  });
  // A permitted target may legitimately contain a slash; it must still be
  // encoded into one path segment rather than joined into the URL. (A target
  // id containing a traversal segment is already refused by the foundation's
  // own native identifier schema, so it cannot even be approved.)
  const permitted = makeBinding({
    apiOrigin: h.double.origin,
    permittedTargets: [{ kind: "slack-team", id: "T01/evil.example" }],
  });
  const escaping = await bindAccount(
    h,
    makeConnection({ binding: permitted }),
    {
      accountId: connection.externalIds.accountId!,
      externalUserId: h.externalUserId(),
      projectId: h.double.projectId,
      environment: h.environment,
      app: "slack",
    },
  );
  await h.adapter.invoke!(
    makeContext({ harness: h, binding: permitted, connection: escaping }),
    {
      operationRef: "proxy.team",
      commandId: "cmd-escape-2",
      input: { path: { teamId: "T01/evil.example" } },
    },
  );
  for (const call of h.double.proxyCalls)
    assert.equal(
      new URL(call.url).origin,
      "https://slack.com",
      "a path value never changes the upstream origin",
    );
  assert.equal(
    h.double.proxyCalls[1]!.url,
    "https://slack.com/api/teams/T01%2Fevil.example/info",
    "the slash is encoded into the segment it belongs to",
  );

  // An undeclared query parameter is refused rather than forwarded.
  await assert.rejects(
    h.adapter.invoke!(ctx(), {
      operationRef: "proxy.read-channel",
      commandId: "cmd-query",
      input: { query: { channel: "C1", token: "attacker" } },
    }),
    (error: unknown) =>
      error instanceof ConnectorError &&
      error.detail === "pipedream.input.query",
  );

  // There is no input shape for headers at all.
  await assert.rejects(
    h.adapter.invoke!(ctx(), {
      operationRef: "proxy.post-message",
      commandId: "cmd-header",
      input: {
        body: { channel: "C1", text: "x" },
        headers: { authorization: "Bearer attacker" },
      } as unknown,
    }),
    (error: unknown) =>
      error instanceof ConnectorError &&
      error.detail === "pipedream.input.invalid",
  );

  // Body fields outside the binding's allowlist are refused.
  await assert.rejects(
    h.adapter.invoke!(ctx(), {
      operationRef: "proxy.post-message",
      commandId: "cmd-body",
      input: { body: { channel: "C1", text: "x", as_user: true } },
    }),
    (error: unknown) =>
      error instanceof ConnectorError &&
      error.detail === "pipedream.input.body-field",
  );
});

test("a binding that fixes a header the proxy rejects is a configuration error", async () => {
  const h = await harness();
  const binding = makeBinding({
    apiOrigin: h.double.origin,
    settings: {
      ...defaultSettings("slack"),
      operations: {
        ...(defaultSettings("slack").operations as Record<string, unknown>),
        "proxy.post-message": {
          body: "json",
          headers: { cookie: "session=1" },
        },
      },
    },
  });
  const { connection } = await connected(h, { binding });
  await assert.rejects(
    h.adapter.invoke!(makeContext({ harness: h, binding, connection }), {
      operationRef: "proxy.post-message",
      commandId: "cmd-blocked-header",
      input: { body: { text: "x" } },
    }),
    (error: unknown) =>
      error instanceof ConnectorError &&
      error.code === "configuration-required" &&
      error.detail === "pipedream.binding.header",
  );
  assert.equal(h.double.proxyCalls.length, 0);
});

test("an operation pinned to a destination the binding does not approve is refused", async () => {
  const h = await harness();
  const operations = defaultOperations().map((operation) =>
    operation.operationRef === "proxy.post-message"
      ? {
          ...operation,
          transport: {
            kind: "delegated" as const,
            route: "proxy:POST:https://evil.example/api",
          },
        }
      : operation,
  );
  const binding = makeBinding({ apiOrigin: h.double.origin, operations });
  const { connection } = await connected(h, { binding });
  h.double.setUpstream(() => ({ status: 200, body: { ok: true } }));

  const result = await h.adapter.invoke!(
    makeContext({ harness: h, binding, connection }),
    {
      operationRef: "proxy.post-message",
      commandId: "cmd-evil",
      input: { body: { text: "x" } },
    },
  );
  // The broker enforces its own allowed_domains: the request never reaches
  // anything but Pipedream, and Pipedream refuses the target.
  assert.equal(result.state, "failed");
  assert.equal(h.double.proxyCalls.length, 0);
  for (const request of h.double.requests)
    assert.equal(request.url.hostname, "127.0.0.1");
});

test("an action run carries the account as authProvisionId and only allowlisted props", async () => {
  const h = await harness();
  const { binding, connection } = await connected(h, { accountId: "apn_act" });
  h.double.setActionResult(() => ({
    exports: { $summary: "Sent" },
    os: [],
    ret: { ts: "1700000000.1" },
  }));

  const result = await h.adapter.invoke!(
    makeContext({ harness: h, binding, connection }),
    {
      operationRef: "action.send-message",
      commandId: "cmd-action-1",
      input: { props: { channel: "C123", text: "hi" } },
    },
  );
  assert.equal(result.state, "complete");
  assert.deepEqual((result.output as { ret: unknown }).ret, {
    ts: "1700000000.1",
  });
  const call = h.double.actionCalls[0]!;
  assert.equal(call.id, "slack-send-message-to-channel");
  assert.equal(call.externalUserId, h.externalUserId());
  assert.equal(call.accountId, "apn_act");
  assert.deepEqual(call.configuredProps.slack, { authProvisionId: "apn_act" });
  assert.equal(call.configuredProps.channel, "C123");

  // A caller cannot choose the account, under the app prop or anywhere else.
  for (const props of [
    { slack: { authProvisionId: "apn_other" } },
    { channel: { authProvisionId: "apn_other" } },
  ])
    await assert.rejects(
      h.adapter.invoke!(makeContext({ harness: h, binding, connection }), {
        operationRef: "action.send-message",
        commandId: "cmd-action-evil",
        input: { props },
      }),
      (error: unknown) =>
        error instanceof ConnectorError && error.code === "invalid-request",
    );
  assert.equal(h.double.actionCalls.length, 1);
});

test("an action that times out after it ran is indeterminate, and a retry does not run it again", async () => {
  const h = await harness({
    adapter: { timeouts: { action: 60 } },
  });
  const { binding, connection } = await connected(h);
  h.double.faults.actionDelayMs = 400;

  const first = await h.adapter.invoke!(
    makeContext({ harness: h, binding, connection }),
    {
      operationRef: "action.send-message",
      commandId: "cmd-timeout",
      input: { props: { channel: "C1", text: "once" } },
    },
  );

  // AC-EXT-02: the component ran; the response was lost; the outcome is not
  // reported as a failure and is not retried behind the caller's back.
  assert.equal(first.state, "indeterminate");
  assert.equal(h.double.actionCalls.length, 1);
  assert.ok(first.effectRef);
  const journal = h.ports.inspect
    .effects()
    .filter((entry) => entry.intent.operation === "pipedream.action.run");
  assert.equal(journal.length, 1);
  assert.equal(journal[0]!.outcome?.status, "indeterminate");

  const retry = await h.adapter.invoke!(
    makeContext({ harness: h, binding, connection }),
    {
      operationRef: "action.send-message",
      commandId: "cmd-timeout",
      input: { props: { channel: "C1", text: "once" } },
    },
  );
  assert.equal(retry.state, "indeterminate");
  assert.equal(retry.code, "pipedream.effect.indeterminate");
  assert.equal(
    h.double.actionCalls.length,
    1,
    "the journal refuses to repeat an uncertain effect",
  );
});

test("a repeated write that already applied is reported applied, not sent again", async () => {
  const h = await harness();
  const { binding, connection } = await connected(h);
  h.double.setUpstream(() => ({ status: 200, body: { ok: true } }));
  const request = {
    operationRef: "proxy.post-message",
    commandId: "cmd-repeat",
    input: { body: { channel: "C1", text: "once" } },
  };
  const first = await h.adapter.invoke!(
    makeContext({ harness: h, binding, connection }),
    request,
  );
  assert.equal(first.state, "complete");
  const second = await h.adapter.invoke!(
    makeContext({ harness: h, binding, connection }),
    request,
  );
  assert.equal(second.state, "complete");
  assert.equal(second.code, "pipedream.effect.already-applied");
  assert.equal(h.double.proxyCalls.length, 1);
});

test("a read is replayable and is not journaled as an effect", async () => {
  const h = await harness();
  const { binding, connection } = await connected(h);
  h.double.setUpstream(() => ({ status: 200, body: { channel: {} } }));
  for (const commandId of ["cmd-read-1", "cmd-read-2"])
    await h.adapter.invoke!(makeContext({ harness: h, binding, connection }), {
      operationRef: "proxy.read-channel",
      commandId,
      input: { query: { channel: "C1" } },
    });
  assert.equal(h.double.proxyCalls.length, 2);
  assert.equal(
    h.ports.inspect
      .effects()
      .filter((entry) => entry.intent.operation === "pipedream.proxy").length,
    0,
  );
});

test("a gateway timeout on a write is uncertain, on a read it is a failure", async () => {
  const h = await harness();
  const { binding, connection } = await connected(h);
  h.double.faults.proxyStatus = 504;

  const write = await h.adapter.invoke!(
    makeContext({ harness: h, binding, connection }),
    {
      operationRef: "proxy.post-message",
      commandId: "cmd-504-write",
      input: { body: { channel: "C1", text: "x" } },
    },
  );
  assert.equal(write.state, "indeterminate");
  assert.equal(write.code, "pipedream.proxy.lost");

  const read = await h.adapter.invoke!(
    makeContext({ harness: h, binding, connection }),
    {
      operationRef: "proxy.read-channel",
      commandId: "cmd-504-read",
      input: { query: { channel: "C1" } },
    },
  );
  assert.equal(read.state, "failed");
  assert.equal(read.code, "pipedream.proxy.unavailable");
});

test("a host-supplied idempotency key is refused because the API documents none", async () => {
  const h = await harness();
  const { binding, connection } = await connected(h);
  await assert.rejects(
    h.adapter.invoke!(makeContext({ harness: h, binding, connection }), {
      operationRef: "proxy.post-message",
      commandId: "cmd-idem",
      idempotencyKey: "key-1",
      input: { body: { text: "x" } },
    }),
    (error: unknown) =>
      error instanceof ConnectorError &&
      error.code === "unsupported" &&
      error.detail === "pipedream.idempotency.unsupported",
  );
});

test("an unknown operation, a suspended binding and an unbound connection are all refused", async () => {
  const h = await harness();
  const { binding, connection } = await connected(h);
  await assert.rejects(
    h.adapter.invoke!(makeContext({ harness: h, binding, connection }), {
      operationRef: "proxy.not-bound",
      commandId: "cmd-x",
      input: {},
    }),
    (error: unknown) =>
      error instanceof ConnectorError && error.code === "not-found",
  );

  const suspended = makeBinding({
    apiOrigin: h.double.origin,
    status: "suspended",
  });
  await assert.rejects(
    h.adapter.invoke!(
      makeContext({
        harness: h,
        binding: suspended,
        connection: { ...connection, bindingRef: suspended.bindingRef },
      }),
      {
        operationRef: "proxy.read-channel",
        commandId: "cmd-y",
        input: { query: { channel: "C1" } },
      },
    ),
    (error: unknown) =>
      error instanceof ConnectorError &&
      error.detail === "pipedream.binding.status",
  );

  const unbound = makeConnection({ binding, externalIds: {} });
  await assert.rejects(
    h.adapter.invoke!(
      makeContext({ harness: h, binding, connection: unbound }),
      {
        operationRef: "proxy.read-channel",
        commandId: "cmd-z",
        input: { query: { channel: "C1" } },
      },
    ),
    (error: unknown) =>
      error instanceof ConnectorError &&
      error.detail === "pipedream.connection.unbound",
  );
});

test("throttling is surfaced as rate limiting and held per authority", async () => {
  const h = await harness();
  const { binding, connection } = await connected(h);
  h.double.faults.throttle = true;
  const ctx = () => makeContext({ harness: h, binding, connection });
  const request = {
    operationRef: "proxy.read-channel",
    commandId: "cmd-429",
    input: { query: { channel: "C1" } },
  };
  await assert.rejects(
    h.adapter.invoke!(ctx(), request),
    (error: unknown) =>
      error instanceof ConnectorError && error.code === "rate-limited",
  );
  const before = h.double.requests.length;
  await assert.rejects(
    h.adapter.invoke!(ctx(), request),
    (error: unknown) =>
      error instanceof ConnectorError && error.code === "rate-limited",
  );
  assert.equal(
    h.double.requests.length,
    before,
    "the hold keeps the next call off the wire until Retry-After passes",
  );
});

test("no credential material reaches an invocation result", async () => {
  const h = await harness();
  const { binding, connection } = await connected(h, { accountId: "apn_leak" });
  const account = h.double.accounts.get("apn_leak")!;
  h.double.setUpstream(() => ({ status: 200, body: { ok: true } }));
  const result = await h.adapter.invoke!(
    makeContext({ harness: h, binding, connection }),
    {
      operationRef: "proxy.post-message",
      commandId: "cmd-canary",
      input: { body: { channel: "C1", text: "x" } },
    },
  );
  const serialized = JSON.stringify(result);
  for (const canary of [
    h.double.clientSecret,
    String(account.credentials.oauth_access_token),
    String(account.credentials.oauth_refresh_token),
    ...[...h.double.accessTokens.keys()],
  ])
    assert.equal(serialized.includes(canary), false);
  // The project access token is only ever an Authorization header.
  for (const request of h.double.requests)
    assert.equal(
      request.body.toString("utf8").includes("pdat_"),
      false,
      "the project token never travels in a body",
    );
});
