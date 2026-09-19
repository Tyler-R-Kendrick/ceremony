import assert from "node:assert/strict";
import { test } from "node:test";
import { ConnectorError } from "../../../src/server/connectors/errors.js";
import {
  actionOperation,
  activeConnection,
  CONNECTION_ID,
  connectionRow,
  harness,
  INTEGRATION,
  makeBinding,
  makeConnection,
  PROVIDER,
  readOperation,
  recordsOperation,
  stringsIn,
  writeOperation,
} from "./harness.js";

/*
 * NG-04: protected proxy and action invocation. AC-NG-06 (altered base URL,
 * header or unapproved operation rejected before credentials are attached)
 * and AC-NG-04 (no cross-integration connection substitution).
 */

const contracts = {
  [readOperation.operationRef]: { deadlineMs: 5000 },
  [writeOperation.operationRef]: {
    path: {
      owner: { type: "string", required: true, maxLength: 64 },
      repo: { type: "string", required: true, maxLength: 64 },
    },
    body: {
      type: "object",
      properties: {
        title: { type: "string", maxLength: 120 },
        body: { type: "string" },
      },
      required: ["title"],
      additionalProperties: false,
    },
  },
  [actionOperation.operationRef]: {
    body: {
      type: "object",
      properties: { title: { type: "string" } },
      required: ["title"],
      additionalProperties: false,
    },
  },
};

const proxyEcho = ({
  method,
  path,
  query,
  headers,
  body,
}: {
  method: string;
  path: string;
  query: URLSearchParams;
  headers: Record<string, string>;
  body: Buffer;
}) => ({
  status: 200,
  body: {
    method,
    path,
    query: Object.fromEntries(query.entries()),
    sawHeaders: Object.keys(headers),
    body: body.length ? (JSON.parse(body.toString("utf8")) as unknown) : null,
  },
});

async function invokeHarness(overrides: Parameters<typeof harness>[0] = {}) {
  return harness({
    double: {
      connections: [connectionRow()],
      proxy: proxyEcho,
      ...overrides.double,
    },
    binding: { contracts, ...overrides.binding },
    ...overrides,
  });
}

test("NG-04: a bound proxy operation sends the documented routing headers from the connection", async (t) => {
  const h = await invokeHarness();
  t.after(() => h.close());
  const connection = await activeConnection(h.ports, h.binding);
  const result = await h.adapter.invoke!(h.context({ connection }), {
    operationRef: readOperation.operationRef,
    input: {},
    commandId: "cmd-1",
  });

  assert.equal(result.state, "complete");
  assert.equal(result.effect, "read");
  assert.equal(result.outputClassification, "personal");

  const [request] = h.double.received("GET", "/proxy/user");
  assert.ok(request);
  // The two documented proxy headers come from the connection record only.
  assert.equal(request.headers["connection-id"], CONNECTION_ID);
  assert.equal(request.headers["provider-config-key"], INTEGRATION);
  assert.equal(
    request.headers.authorization,
    "Bearer nango-secret-key-fixture",
  );
  // No base URL override is ever sent.
  assert.equal(request.headers["base-url-override"], undefined);
});

test("AC-NG-06: an input base URL or header override is rejected before credentials are used", async (t) => {
  const h = await invokeHarness();
  t.after(() => h.close());
  const connection = await activeConnection(h.ports, h.binding);

  for (const input of [
    { baseUrlOverride: "https://attacker.example" },
    { "Base-Url-Override": "https://attacker.example" },
    { headers: { authorization: "Bearer stolen" } },
    { connectionId: "someone-elses" },
    { provider_config_key: "github-sandbox" },
    { retries: 5 },
  ]) {
    await assert.rejects(
      h.adapter.invoke!(h.context({ connection }), {
        operationRef: readOperation.operationRef,
        input,
        commandId: `cmd-${JSON.stringify(input)}`,
      }),
      (error: unknown) =>
        error instanceof ConnectorError &&
        error.code === "denied" &&
        error.detail === "nango.input.override-rejected",
      `input ${JSON.stringify(input)} must be refused`,
    );
  }
  assert.equal(h.double.requests.length, 0, "nothing reached Nango");
});

test("AC-NG-06: an unapproved operation reference never reaches Nango", async (t) => {
  const h = await invokeHarness();
  t.after(() => h.close());
  const connection = await activeConnection(h.ports, h.binding);
  await assert.rejects(
    h.adapter.invoke!(h.context({ connection }), {
      operationRef: "github.repo.delete",
      input: {},
      commandId: "cmd-2",
    }),
    (error: unknown) =>
      error instanceof ConnectorError &&
      error.code === "denied" &&
      error.detail === "nango.operation.unapproved",
  );
  assert.equal(h.double.requests.length, 0);
});

test("NG-04: path and body inputs are validated against the approved contract", async (t) => {
  const h = await invokeHarness();
  t.after(() => h.close());
  const connection = await activeConnection(h.ports, h.binding);

  const ok = await h.adapter.invoke!(h.context({ connection }), {
    operationRef: writeOperation.operationRef,
    input: {
      path: { owner: "octocat", repo: "hello-world" },
      body: { title: "Bug" },
    },
    commandId: "cmd-ok",
  });
  assert.equal(ok.state, "complete");
  const [request] = h.double.received(
    "POST",
    "/proxy/repos/octocat/hello-world/issues",
  );
  assert.ok(request);

  // A path value that would escape its segment is refused, not encoded away.
  await assert.rejects(
    h.adapter.invoke!(h.context({ connection }), {
      operationRef: writeOperation.operationRef,
      input: {
        path: { owner: "../../admin", repo: "x" },
        body: { title: "t" },
      },
      commandId: "cmd-escape",
    }),
    (error: unknown) =>
      error instanceof ConnectorError &&
      error.detail === "nango.input.path.value",
  );

  // An undeclared body property is refused by the contract's allowlist.
  await assert.rejects(
    h.adapter.invoke!(h.context({ connection }), {
      operationRef: writeOperation.operationRef,
      input: {
        path: { owner: "octocat", repo: "hello-world" },
        body: { title: "t", labels: ["urgent"] },
      },
      commandId: "cmd-extra",
    }),
    (error: unknown) =>
      error instanceof ConnectorError &&
      error.detail === "nango.input.body.schema",
  );

  // A missing required path parameter is refused.
  await assert.rejects(
    h.adapter.invoke!(h.context({ connection }), {
      operationRef: writeOperation.operationRef,
      input: { path: { owner: "octocat" }, body: { title: "t" } },
      commandId: "cmd-missing",
    }),
    (error: unknown) =>
      error instanceof ConnectorError &&
      error.detail === "nango.input.path.required",
  );
});

test("AC-NG-04: a connection from another integration cannot be substituted", async (t) => {
  const h = await invokeHarness();
  t.after(() => h.close());
  // The local record claims a connection id that belongs to another
  // integration's unique key; the binding names github-prod.
  const foreign = await activeConnection(h.ports, h.binding, {
    externalIds: {
      connectionId: CONNECTION_ID,
      providerConfigKey: "github-sandbox",
      provider: PROVIDER,
      environment: "dev",
    },
  });
  await assert.rejects(
    h.adapter.invoke!(h.context({ connection: foreign }), {
      operationRef: readOperation.operationRef,
      input: {},
      commandId: "cmd-3",
    }),
    (error: unknown) =>
      error instanceof ConnectorError &&
      error.code === "denied" &&
      error.detail === "nango.connection.integration",
  );
  assert.equal(h.double.requests.length, 0);
});

test("AC-NG-04: a connection whose authority is another Nango environment is refused", async (t) => {
  const h = await invokeHarness();
  t.after(() => h.close());
  const connection = await activeConnection(h.ports, h.binding, {
    authorityInstance: `nango:prod:${h.double.origin}`,
  });
  await assert.rejects(
    h.adapter.invoke!(h.context({ connection }), {
      operationRef: readOperation.operationRef,
      input: {},
      commandId: "cmd-4",
    }),
    (error: unknown) =>
      error instanceof ConnectorError &&
      error.detail === "nango.connection.authority",
  );
  assert.equal(h.double.requests.length, 0);
});

test("AC-NG-04: a stored broker reference disagreeing with the record is refused mid-flight", async (t) => {
  const h = await invokeHarness();
  t.after(() => h.close());
  const connection = await activeConnection(h.ports, h.binding);
  // The credential material is the authority on which broker connection this
  // is; a record edited to point elsewhere cannot borrow it.
  const tampered = {
    ...connection,
    externalIds: { ...connection.externalIds, connectionId: "someone-elses" },
  };
  await assert.rejects(
    h.adapter.invoke!(h.context({ connection: tampered }), {
      operationRef: readOperation.operationRef,
      input: {},
      commandId: "cmd-5",
    }),
    (error: unknown) =>
      error instanceof ConnectorError &&
      error.detail === "nango.credential.mismatch",
  );
  assert.equal(h.double.requests.length, 0);
});

test("NG-04: actions take their name from the bound operation, never from input", async (t) => {
  const h = await invokeHarness({
    double: {
      connections: [connectionRow()],
      action: ({ actionName, input }) =>
        actionName === "create-issue"
          ? { status: 200, body: { created: true, echo: input } }
          : {
              status: 404,
              body: {
                error: { message: "no", code: "unknown_action", payload: {} },
              },
            },
    },
  });
  t.after(() => h.close());
  const connection = await activeConnection(h.ports, h.binding);
  const result = await h.adapter.invoke!(h.context({ connection }), {
    operationRef: actionOperation.operationRef,
    input: { body: { title: "Bug" } },
    commandId: "cmd-action",
  });
  assert.equal(result.state, "complete");

  const [request] = h.double.received("POST", "/action/trigger");
  const body = JSON.parse(request!.body.toString("utf8")) as Record<
    string,
    unknown
  >;
  assert.equal(body.action_name, "create-issue");
  assert.deepEqual(body.input, { title: "Bug" });
  assert.equal(request!.headers["connection-id"], CONNECTION_ID);
  assert.equal(request!.headers["provider-config-key"], INTEGRATION);
  // The adapter never opts into asynchronous actions implicitly.
  assert.equal(request!.headers["x-async"], undefined);

  // An input-supplied action name is refused outright.
  await assert.rejects(
    h.adapter.invoke!(h.context({ connection }), {
      operationRef: actionOperation.operationRef,
      input: { action_name: "delete-everything", body: { title: "x" } },
      commandId: "cmd-action-2",
    }),
    (error: unknown) =>
      error instanceof ConnectorError &&
      error.detail === "nango.input.override-rejected",
  );
});

test("NG-04: a gateway failure on a write is indeterminate and is not blindly replayed", async (t) => {
  let calls = 0;
  const h = await invokeHarness({
    double: {
      connections: [connectionRow()],
      proxy: () => {
        calls++;
        // Nango accepted the request and answered 502: it may already have
        // forwarded the write upstream, so the outcome is unknown.
        return { status: 502, body: { error: "bad gateway" } };
      },
    },
  });
  t.after(() => h.close());
  const connection = await activeConnection(h.ports, h.binding);
  const request = {
    operationRef: writeOperation.operationRef,
    input: {
      path: { owner: "octocat", repo: "hello-world" },
      body: { title: "Bug" },
    },
    commandId: "cmd-lost",
  };
  const first = await h.adapter.invoke!(h.context({ connection }), request);
  assert.equal(first.state, "indeterminate");
  assert.equal(first.code, "nango.upstream.uncertain");

  // The identical retry returns the journal's uncertain outcome instead of
  // sending the write a second time (replay policy "none").
  const callsAfterFirst = calls;
  const retry = await h.adapter.invoke!(h.context({ connection }), request);
  assert.equal(retry.state, "indeterminate");
  assert.equal(retry.code, "nango.effect.indeterminate");
  assert.equal(calls, callsAfterFirst, "the write was not repeated");

  // A read against the same gateway failure stays an ordinary failure: it
  // changed nothing, so it is safely retryable.
  const read = await h.adapter.invoke!(h.context({ connection }), {
    operationRef: readOperation.operationRef,
    input: {},
    commandId: "cmd-read-502",
  });
  assert.equal(read.state, "failed");
});

test("NG-04: a dropped connection on a write is indeterminate, never a clean failure", async (t) => {
  const h = await invokeHarness();
  t.after(() => h.close());
  const connection = await activeConnection(h.ports, h.binding);
  // The transport itself dies after the request leaves: no response at all.
  const brokenFetch: typeof fetch = async () => {
    throw new TypeError("network error");
  };
  const result = await h.adapter.invoke!(
    h.context({ connection, fetch: brokenFetch }),
    {
      operationRef: writeOperation.operationRef,
      input: {
        path: { owner: "octocat", repo: "hello-world" },
        body: { title: "Bug" },
      },
      commandId: "cmd-dropped",
    },
  );
  assert.equal(result.state, "indeterminate");
  assert.equal(result.code, "nango.upstream.lost-response");
});

test("NG-04: a completed write is not applied twice for the same command", async (t) => {
  let calls = 0;
  const h = await invokeHarness({
    double: {
      connections: [connectionRow()],
      proxy: () => {
        calls++;
        return { status: 201, body: { number: 7 } };
      },
    },
  });
  t.after(() => h.close());
  const connection = await activeConnection(h.ports, h.binding);
  const request = {
    operationRef: writeOperation.operationRef,
    input: {
      path: { owner: "octocat", repo: "hello-world" },
      body: { title: "Bug" },
    },
    commandId: "cmd-dup",
  };
  const first = await h.adapter.invoke!(h.context({ connection }), request);
  assert.equal(first.state, "complete");
  const second = await h.adapter.invoke!(h.context({ connection }), request);
  assert.equal(second.state, "complete");
  assert.equal(second.code, "nango.effect.already-applied");
  assert.equal(calls, 1);
});

test("NG-04: a read-only operation may repeat; its retry budget is bounded by the contract", async (t) => {
  const h = await invokeHarness();
  t.after(() => h.close());
  const connection = await activeConnection(h.ports, h.binding);
  const request = {
    operationRef: readOperation.operationRef,
    input: {},
    commandId: "cmd-read",
  };
  await h.adapter.invoke!(h.context({ connection }), request);
  await h.adapter.invoke!(h.context({ connection }), request);
  assert.equal(h.double.received("GET", "/proxy/user").length, 2);
});

test("NG-04: an operation rate limit is enforced per connection before the call", async (t) => {
  const h = await invokeHarness({
    binding: {
      contracts: {
        ...contracts,
        [readOperation.operationRef]: { rateLimit: { perMinute: 2 } },
      },
    },
  });
  t.after(() => h.close());
  const connection = await activeConnection(h.ports, h.binding);
  for (const commandId of ["a", "b"])
    await h.adapter.invoke!(h.context({ connection }), {
      operationRef: readOperation.operationRef,
      input: {},
      commandId,
    });
  await assert.rejects(
    h.adapter.invoke!(h.context({ connection }), {
      operationRef: readOperation.operationRef,
      input: {},
      commandId: "c",
    }),
    (error: unknown) =>
      error instanceof ConnectorError &&
      error.code === "rate-limited" &&
      error.detail === "nango.operation.rate-limit",
  );
  assert.equal(h.double.received("GET", "/proxy/user").length, 2);
});

test("NG-04: an upstream 429 puts the authority in cool-down instead of hammering it", async (t) => {
  const h = await invokeHarness({
    double: {
      connections: [connectionRow()],
      intercept: (request) =>
        request.url.pathname.startsWith("/proxy/")
          ? {
              status: 429,
              headers: { "retry-after": "30" },
              body: { error: "slow down" },
            }
          : undefined,
    },
  });
  t.after(() => h.close());
  const connection = await activeConnection(h.ports, h.binding);
  const limited = await h.adapter.invoke!(h.context({ connection }), {
    operationRef: readOperation.operationRef,
    input: {},
    commandId: "cmd-429",
  });
  assert.equal(limited.state, "failed");
  assert.equal(limited.code, "nango.upstream.rate-limited");

  await assert.rejects(
    h.adapter.invoke!(h.context({ connection }), {
      operationRef: readOperation.operationRef,
      input: {},
      commandId: "cmd-429-b",
    }),
    (error: unknown) =>
      error instanceof ConnectorError && error.detail === "nango.api.cooldown",
  );
  assert.equal(h.double.received("GET", "/proxy/user").length, 1);
});

test("NG-04: an upstream failure body never reaches the result", async (t) => {
  const h = await invokeHarness({
    double: {
      connections: [connectionRow()],
      proxy: () => ({
        status: 403,
        body: {
          message: "Bad credentials for token ghp_SUPERSECRETVALUE",
          documentation_url: "https://internal.example/secret",
        },
      }),
    },
  });
  t.after(() => h.close());
  const connection = await activeConnection(h.ports, h.binding);
  const result = await h.adapter.invoke!(h.context({ connection }), {
    operationRef: readOperation.operationRef,
    input: {},
    commandId: "cmd-403",
  });
  assert.equal(result.state, "failed");
  assert.equal(result.code, "nango.upstream.denied");
  assert.equal(result.output, undefined);
  assert.equal(
    stringsIn(result).some((value) => value.includes("ghp_SUPERSECRETVALUE")),
    false,
  );
});

test("NG-04: an inactive or uncredentialed connection cannot invoke", async (t) => {
  const h = await invokeHarness();
  t.after(() => h.close());
  const unbound = makeConnection(h.binding);
  await assert.rejects(
    h.adapter.invoke!(h.context({ connection: unbound }), {
      operationRef: readOperation.operationRef,
      input: {},
      commandId: "cmd-6",
    }),
    (error: unknown) =>
      error instanceof ConnectorError &&
      error.detail === "nango.connection.unbound",
  );

  const revoked = await activeConnection(h.ports, h.binding, {
    lifecycle: "upstream-revoked",
  });
  await assert.rejects(
    h.adapter.invoke!(h.context({ connection: revoked }), {
      operationRef: readOperation.operationRef,
      input: {},
      commandId: "cmd-7",
    }),
    (error: unknown) =>
      error instanceof ConnectorError &&
      error.detail === "nango.connection.inactive",
  );
  assert.equal(h.double.requests.length, 0);
});

test("NG-05: records are read through the documented cursor endpoint", async (t) => {
  const h = await harness({
    double: {
      connections: [connectionRow()],
      records: {
        GithubIssue: {
          records: [
            {
              id: "1",
              title: "Bug",
              _nango_metadata: {
                deleted_at: null,
                last_action: "ADDED",
                first_seen_at: "2026-03-01T00:00:00.000Z",
                last_modified_at: "2026-03-01T00:00:00.000Z",
                cursor: "cursor-1",
              },
            },
          ],
          next_cursor: "cursor-2",
        },
      },
    },
    binding: { operations: [recordsOperation], contracts: {} },
  });
  t.after(() => h.close());
  const connection = await activeConnection(h.ports, h.binding);
  const result = await h.adapter.invoke!(h.context({ connection }), {
    operationRef: recordsOperation.operationRef,
    input: { query: { cursor: "cursor-0", limit: 50 } },
    commandId: "cmd-records",
  });

  assert.equal(result.state, "complete");
  const output = result.output as {
    records: unknown[];
    nextCursor: string | null;
  };
  assert.equal(output.records.length, 1);
  assert.equal(output.nextCursor, "cursor-2");

  const [request] = h.double.received("GET", "/records");
  assert.equal(request!.url.searchParams.get("model"), "GithubIssue");
  assert.equal(request!.url.searchParams.get("cursor"), "cursor-0");
  assert.equal(request!.url.searchParams.get("limit"), "50");
  assert.equal(request!.headers["connection-id"], CONNECTION_ID);
});

test("NG-04: a binding whose destination is not the configured API origin cannot be used", async (t) => {
  const h = await invokeHarness();
  t.after(() => h.close());
  const elsewhere = makeBinding({ apiOrigin: "https://api.attacker.example" });
  const connection = await activeConnection(h.ports, h.binding);
  await assert.rejects(
    h.adapter.invoke!(h.context({ connection, binding: elsewhere }), {
      operationRef: readOperation.operationRef,
      input: {},
      commandId: "cmd-8",
    }),
    (error: unknown) => error instanceof ConnectorError,
  );
  assert.equal(h.double.requests.length, 0);
});
