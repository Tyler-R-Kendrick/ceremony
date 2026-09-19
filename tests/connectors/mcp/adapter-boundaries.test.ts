import assert from "node:assert/strict";
import { after, before, beforeEach, test } from "node:test";
import { randomUUID } from "node:crypto";
import {
  createMcpRemoteAdapter,
  McpResultCache,
  type McpBrokerPort,
  type McpRemoteAdapterOptions,
} from "../../../src/server/connectors/mcp/index.js";
import {
  runtimeBindingSchema,
  type RuntimeBinding,
} from "../../../src/server/connectors/binding.js";
import { ConnectorError } from "../../../src/server/connectors/errors.js";
import type {
  AdapterCallContext,
  AuthorizationIntent,
} from "../../../src/server/connectors/adapter.js";
import type {
  ConnectionRecord,
  HandoffRecord,
} from "../../../src/server/connectors/ports.js";
import type { ActorContext } from "../../../src/core/operation-contracts.js";
import { fixtureActor, memoryPorts } from "../doubles/ports.js";
import {
  startMcpFixture,
  type FixtureServer,
} from "../doubles/mcp-servers/harness.js";

/*
 * The adapter's boundaries: what it refuses, and whether it refuses for the
 * right reason. Every assertion here is about a case where the honest answer
 * is "no" or "I do not know": a binding that was never reviewed for MCP, an
 * endpoint outside its destination, a credential that is not a bearer, a
 * server asking for input more times than the host allows, a continuation
 * whose approval has moved underneath it, and a result nobody can interpret.
 * The recurring invariant is that a refusal is specific, is visible in the
 * effect journal for a consequential call, and costs the server nothing it
 * did not already receive.
 */

const TOKEN = "current-token";
const LEGACY_TOKEN = "legacy-token";
const DIGEST = "a".repeat(64);
const CONTROL_CHARACTER = String.fromCharCode(7);

let fixture: FixtureServer;
let legacy: FixtureServer;

before(async () => {
  [fixture, legacy] = await Promise.all([
    startMcpFixture("current", { token: TOKEN }),
    startMcpFixture("legacy", { token: LEGACY_TOKEN }),
  ]);
});
after(async () => {
  await Promise.all([fixture?.stop(), legacy?.stop()]);
});
beforeEach(async () => {
  await Promise.all([
    fixture.control({ mode: "normal", reset: true }),
    legacy.control({ mode: "normal", reset: true }),
  ]);
});

type Settings = Record<string, unknown>;

function binding(
  overrides: Partial<RuntimeBinding> = {},
  settings: Settings = {},
): RuntimeBinding {
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
    destinations: [
      { id: "server", origin: fixture.origin, network: "loopback-fixture" },
    ],
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
        operationRef: "op:vanished",
        nativeId: "vanished_tool",
        destinationId: "server",
        transport: { kind: "mcp-tool", toolName: "vanished_tool" },
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
        operationRef: "op:note-shared",
        nativeId: "note:///shared",
        destinationId: "server",
        transport: { kind: "mcp-resource", uriTemplate: "note:///shared" },
        effect: "read",
        outputClassification: "personal",
        cost: "free",
        consent: "none",
        replay: "read-only",
        targetParameters: [],
      },
      {
        operationRef: "op:note-odd",
        nativeId: "note:///odd",
        destinationId: "server",
        // A reviewed template whose variable name is outside the alphabet the
        // adapter substitutes from; the binding schema does not police it.
        transport: { kind: "mcp-resource", uriTemplate: "note:///{note name}" },
        effect: "read",
        outputClassification: "personal",
        cost: "free",
        consent: "none",
        replay: "read-only",
        targetParameters: [],
      },
    ],
    configuration: [],
    permittedTargets: [],
    reviewedDigest: DIGEST,
    settings: {
      mcp: {
        profile: "2026-07-28",
        endpointPath: "/mcp",
        auth: "bearer",
        ...settings,
      },
    },
    ...overrides,
  });
}

function legacyBinding(settings: Settings = {}): RuntimeBinding {
  return runtimeBindingSchema.parse({
    bindingRef: "binding:mcp-legacy",
    definitionRef: "definition:mcp",
    revision: 2,
    adapterId: "mcp-remote",
    adapterVersion: "1.0.0",
    runtime: "hosted-server",
    custody: "host-owned",
    authorityInstance: legacy.origin,
    status: "approved",
    approvedAt: "2026-09-18T00:00:00.000Z",
    policyRevision: "policy-1",
    tenantId: "tenant-a",
    destinations: [
      { id: "server", origin: legacy.origin, network: "loopback-fixture" },
    ],
    operations: [
      {
        operationRef: "op:ask-login",
        nativeId: "ask_login",
        destinationId: "server",
        transport: { kind: "mcp-tool", toolName: "ask_login" },
        effect: "read",
        outputClassification: "personal",
        cost: "free",
        consent: "none",
        replay: "read-only",
        targetParameters: [],
      },
    ],
    configuration: [],
    permittedTargets: [],
    reviewedDigest: DIGEST,
    settings: {
      mcp: {
        profile: "2025-11-25",
        endpointPath: "/mcp",
        auth: "bearer",
        ...settings,
      },
    },
  });
}

type Harness = {
  ctx: AdapterCallContext;
  ports: ReturnType<typeof memoryPorts>;
  adapter: ReturnType<typeof createMcpRemoteAdapter>;
  connection?: ConnectionRecord;
  controller: AbortController;
};

/**
 * The same shape as the harness in `adapter.test.ts`, with the knobs these
 * boundary cases need: a connection that holds no credential, no connection
 * at all, non-bearer credential material, and a `fetch` that can stand in for
 * a server reply the fixture will not produce.
 */
async function harness(
  options: {
    actor?: ActorContext;
    material?: Record<string, string>;
    adapter?: McpRemoteAdapterOptions;
    binding?: RuntimeBinding;
    origin?: string;
    connection?: "with-credential" | "without-credential" | "none";
    fetch?: typeof fetch;
  } = {},
): Promise<Harness> {
  const actor = options.actor ?? fixtureActor;
  const ports = memoryPorts();
  const bound = options.binding ?? binding();
  const mode = options.connection ?? "with-credential";
  const connectionRef = `connection:${randomUUID()}`;
  const scope = {
    tenantId: actor.tenantId,
    ownerKind: "user" as const,
    ownerId: actor.subjectId,
    connectionRef,
    bindingRef: bound.bindingRef,
    custody: "host-owned" as const,
  };
  const credentialRef =
    mode === "with-credential"
      ? await ports.credentials.store(
          scope,
          options.material ?? { bearer: TOKEN },
        )
      : undefined;
  const base = {
    connectionRef,
    bindingRef: bound.bindingRef,
    definitionRef: bound.definitionRef,
    ecosystem: "mcp" as const,
    service: "mcp",
    displayName: "Fixture MCP server",
    ownerKind: "user" as const,
    custody: "host-owned" as const,
    runtime: "hosted-server" as const,
    lifecycle: "active" as const,
    generation: 1,
    revision: 1,
    createdAt: "2026-09-18T00:00:00.000Z",
    updatedAt: "2026-09-18T00:00:00.000Z",
    tenantId: actor.tenantId,
    ownerId: actor.subjectId,
    authorityInstance: options.origin ?? fixture.origin,
    bindingRevision: bound.revision,
    policyRevision: bound.policyRevision,
    configurationRevision: "cfg:1",
    externalIds: {},
    evidenceRefs: [],
    state: {},
  };
  const connection: ConnectionRecord | undefined =
    mode === "none"
      ? undefined
      : { ...base, ...(credentialRef ? { credentialRef } : {}) };
  if (connection) await ports.connections.create(connection);
  const controller = new AbortController();
  return {
    ports,
    ...(connection ? { connection } : {}),
    controller,
    adapter: createMcpRemoteAdapter(options.adapter),
    ctx: {
      actor,
      binding: bound,
      ...(connection ? { connection } : {}),
      generation: 1,
      signal: controller.signal,
      environment: ports.environment({
        fetch: options.fetch ?? globalThis.fetch,
      }),
    },
  };
}

const intent = (): AuthorizationIntent => ({
  ownerKind: "user",
  requestedPermissions: [],
  accountSwitch: false,
  interruption: "allowed",
});

/**
 * A `fetch` that answers one JSON-RPC method with a reply of its own and lets
 * every other request reach the fixture unchanged. Used only for server
 * behaviour the fixture cannot produce (a 503, an uninterpretable result).
 */
function interceptingFetch(
  match: (message: { method?: string }) => boolean,
  reply: (id: unknown) => { status: number; body: unknown },
): typeof fetch {
  return async (input, init) => {
    const raw = typeof init?.body === "string" ? init.body : undefined;
    const message = raw
      ? (JSON.parse(raw) as { id?: unknown; method?: string })
      : undefined;
    if (message && match(message)) {
      const answer = reply(message.id ?? null);
      return new Response(JSON.stringify(answer.body), {
        status: answer.status,
        headers: { "content-type": "application/json" },
      });
    }
    return globalThis.fetch(input, init);
  };
}

/** A `fetch` for a server that publishes no protected-resource metadata. */
function withoutMetadata(): typeof fetch {
  return async (input, init) => {
    const url =
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.href
          : input.url;
    if (url.includes("/.well-known/"))
      return new Response(JSON.stringify({ error: "not_found" }), {
        status: 404,
        headers: { "content-type": "application/json" },
      });
    return globalThis.fetch(input, init);
  };
}

function toolCallBody(entry: { body?: unknown }): {
  name?: string;
  arguments?: Record<string, unknown>;
  _meta?: Record<string, unknown>;
} {
  return (entry.body as { params?: Record<string, unknown> }).params as {
    name?: string;
    arguments?: Record<string, unknown>;
    _meta?: Record<string, unknown>;
  };
}

async function requestsFor(
  server: FixtureServer,
  method: string,
): Promise<Array<{ body?: unknown }>> {
  const report = await server.report();
  return report.wire.filter(
    (entry) => (entry.body as { method?: string }).method === method,
  );
}

/* ------------------------------------------------------- binding settings */

test("a binding that was never reviewed for MCP is refused, not defaulted", async () => {
  // Invariant: `settings.mcp` is the reviewed part of the approval — profile,
  // endpoint path and auth mode. If it is absent or does not parse, the
  // adapter refuses rather than assuming the current profile and `/mcp`.
  // This matters because a default would silently invent an approval nobody
  // gave, on an endpoint nobody reviewed.
  const missing = await harness({ binding: binding({ settings: {} }) });
  await assert.rejects(
    missing.adapter.invoke!(missing.ctx, {
      operationRef: "op:echo",
      input: { text: "hi" },
      commandId: "c1",
    }),
    (error: unknown) =>
      error instanceof ConnectorError &&
      error.code === "invalid-request" &&
      error.detail === "mcp.binding.settings-missing",
  );

  const invalid = await harness({
    binding: binding({ settings: { mcp: { profile: "2099-01-01" } } }),
  });
  await assert.rejects(
    invalid.adapter.invoke!(invalid.ctx, {
      operationRef: "op:echo",
      input: { text: "hi" },
      commandId: "c1",
    }),
    (error: unknown) =>
      error instanceof ConnectorError &&
      error.code === "invalid-request" &&
      error.detail === "mcp.binding.settings-invalid",
  );

  const report = await fixture.report();
  assert.equal(report.wire.length, 0, "an unreviewed binding sends nothing");
});

test("the endpoint must sit under the destination's approved path prefix", async () => {
  // Invariant: a destination may be approved for only part of an origin. The
  // endpoint path is checked against that prefix before a socket is opened,
  // so an approval for `/team-a` cannot be spent on `/mcp`.
  const outside = await harness({
    binding: binding({
      destinations: [
        {
          id: "server",
          origin: fixture.origin,
          pathPrefix: "/team-a",
          network: "loopback-fixture",
        },
      ],
    }),
  });
  await assert.rejects(
    outside.adapter.invoke!(outside.ctx, {
      operationRef: "op:echo",
      input: { text: "hi" },
      commandId: "c1",
    }),
    (error: unknown) =>
      error instanceof ConnectorError &&
      error.code === "network-policy" &&
      error.detail === "mcp.binding.endpoint-outside-prefix",
  );
  assert.equal((await fixture.report()).wire.length, 0);

  // The same prefix check admits the endpoint it does cover.
  const inside = await harness({
    binding: binding({
      destinations: [
        {
          id: "server",
          origin: fixture.origin,
          pathPrefix: "/mcp",
          network: "loopback-fixture",
        },
      ],
    }),
  });
  const allowed = await inside.adapter.invoke!(inside.ctx, {
    operationRef: "op:echo",
    input: { text: "hi" },
    commandId: "c2",
  });
  assert.equal(allowed.state, "complete");
});

test("a binding with no approved destination has nothing to call", async () => {
  // Invariant: the destination comes from the approval, never from the
  // connection record's `authorityInstance` or any other convenient field.
  // With no approved destination there is no fallback: verification refuses.
  const h = await harness({
    binding: binding({ destinations: [], operations: [] }),
  });
  await assert.rejects(
    h.adapter.verify!(h.ctx),
    (error: unknown) =>
      error instanceof ConnectorError &&
      error.code === "network-policy" &&
      error.detail === "mcp.binding.no-destination",
  );
  assert.equal((await fixture.report()).wire.length, 0);
});

/* ------------------------------------------------------------ credentials */

test("a broker binding without a broker is a configuration error, never an anonymous call", async () => {
  // Invariant: `auth: "broker"` means some other component vends the bearer.
  // If that component is not wired up, the adapter says so; it does not fall
  // back to calling the server with no credential, which would look to the
  // reviewer like an authenticated connector that happens to be public.
  const none = await harness({ binding: binding({}, { auth: "broker" }) });
  await assert.rejects(
    none.adapter.invoke!(none.ctx, {
      operationRef: "op:echo",
      input: { text: "hi" },
      commandId: "c1",
    }),
    (error: unknown) =>
      error instanceof ConnectorError &&
      error.code === "configuration-required" &&
      error.detail === "mcp.broker.missing",
  );
  const start = await none.adapter.authorize!(none.ctx, intent());
  assert.equal(start.kind, "unsupported");
  assert.equal(
    start.kind === "unsupported" ? start.code : undefined,
    "mcp.broker.missing",
  );
  assert.equal((await fixture.report()).wire.length, 0);

  // With a broker the token is only ever borrowed inside `useBearer`.
  let borrowed = 0;
  const broker: McpBrokerPort = {
    async useBearer(_ctx, work) {
      borrowed += 1;
      return work(TOKEN);
    },
  };
  const wired = await harness({
    binding: binding({}, { auth: "broker" }),
    adapter: { broker },
    connection: "without-credential",
  });
  const result = await wired.adapter.invoke!(wired.ctx, {
    operationRef: "op:echo",
    input: { text: "hi" },
    commandId: "c2",
  });
  assert.equal(result.state, "complete");
  assert.ok(borrowed > 0, "the bearer came from the broker");
  assert.equal(JSON.stringify(result).includes(TOKEN), false);
  const calls = await requestsFor(fixture, "tools/call");
  assert.equal(calls.length, 1);
  const authorized = (await fixture.report()).wire.filter(
    (entry) => entry.headers.authorization === `Bearer ${TOKEN}`,
  );
  assert.ok(authorized.length > 0, "the broker's bearer reached the server");
});

test("a connection with no credential is unauthenticated, and non-bearer material is never sent", async () => {
  // Invariant: the adapter only ever puts a bearer in an Authorization
  // header. A connection with no credential, or custody material that holds
  // no token, is refused inside `credentials.use` — the secret is not
  // stringified into a header on the hope that the server accepts it.
  const bare = await harness({ connection: "without-credential" });
  await assert.rejects(
    bare.adapter.invoke!(bare.ctx, {
      operationRef: "op:echo",
      input: { text: "hi" },
      commandId: "c1",
    }),
    (error: unknown) =>
      error instanceof ConnectorError &&
      error.code === "unauthenticated" &&
      error.detail === "mcp.credential.missing",
  );

  const wrongShape = await harness({
    material: { clientSecret: "s3cret", refresh_token: "r3fresh" },
  });
  await assert.rejects(
    wrongShape.adapter.invoke!(wrongShape.ctx, {
      operationRef: "op:echo",
      input: { text: "hi" },
      commandId: "c2",
    }),
    (error: unknown) =>
      error instanceof ConnectorError &&
      error.code === "unauthenticated" &&
      error.detail === "mcp.credential.not-a-bearer",
  );
  const report = await fixture.report();
  assert.equal(report.wire.length, 0, "neither attempt reached the server");
  assert.equal(JSON.stringify(report).includes("s3cret"), false);
});

test("an empty credential field is not mistaken for a token", async () => {
  // Invariant: the bearer is the first field that actually holds something.
  // An empty string left behind by a refresh must not be sent as the token,
  // because the server would answer 401 and the host would record a rejected
  // credential where the truth is that nothing was ever presented.
  const h = await harness({ material: { bearer: "", access_token: TOKEN } });
  const result = await h.adapter.invoke!(h.ctx, {
    operationRef: "op:echo",
    input: { text: "hi" },
    commandId: "c1",
  });
  assert.equal(result.state, "complete");
  const report = await fixture.report();
  assert.ok(
    report.wire.every(
      (entry) => entry.headers.authorization === `Bearer ${TOKEN}`,
    ),
    "the non-empty field was used, and only it",
  );
});

test("a server that demands authorization denies the write and journals it as not applied", async () => {
  // Invariant: a 401 on a consequential call is a denial with a named reason,
  // and the effect journal records that nothing was applied. A challenge is
  // not an error to swallow, and it is not an excuse to leave an open effect
  // whose outcome later reads as unknown.
  const cache = new McpResultCache(Date.now, {
    cacheMaxTtlMs: 60_000,
    cacheMaxEntries: 8,
  });
  const h = await harness({
    binding: binding({}, { auth: "none" }),
    adapter: { cache },
    connection: "without-credential",
  });
  const result = await h.adapter.invoke!(h.ctx, {
    operationRef: "op:create",
    input: { title: "n" },
    commandId: "c1",
  });
  assert.equal(result.state, "denied");
  assert.equal(result.code, "authorization-required");
  assert.ok(result.effectRef);
  const journal = h.ports.inspect.effects();
  assert.equal(journal.length, 1);
  assert.equal(journal[0]!.outcome?.status, "not-applied");
  const report = await fixture.report();
  assert.equal(report.effects.length, 0, "the note was not created");
  assert.ok(
    report.wire.every((entry) => entry.headers.authorization === undefined),
    "no credential was invented for an unauthenticated binding",
  );
});

test("a consequential call with no connection record is still journaled", async () => {
  // Invariant: the effect journal is the host's record of what it tried, so
  // it is written even when there is no connection row to attribute the call
  // to. An unattributed write must not be an unrecorded one.
  const h = await harness({
    binding: binding({}, { auth: "none" }),
    connection: "none",
  });
  const result = await h.adapter.invoke!(h.ctx, {
    operationRef: "op:create",
    input: undefined,
    commandId: "c1",
  });
  assert.equal(result.state, "denied");
  const journal = h.ports.inspect.effects();
  assert.equal(journal.length, 1);
  assert.equal(journal[0]!.intent.connectionRef, undefined);
  assert.equal(journal[0]!.outcome?.status, "not-applied");
});

/* -------------------------------------------------------------- arguments */

test("prompt arguments are scalars or nothing, and a structure is refused rather than flattened", async () => {
  // Invariant: prompt arguments are strings on the wire. Numbers and booleans
  // have one obvious rendering and are converted; an object or array does not,
  // so it is refused instead of being stringified into something the server
  // will interpret differently than the caller meant.
  const h = await harness();
  for (const bad of [[1, 2], { note: { nested: true } }, { note: [1] }]) {
    await assert.rejects(
      h.adapter.invoke!(h.ctx, {
        operationRef: "op:summarize",
        input: bad,
        commandId: "c1",
      }),
      (error: unknown) =>
        error instanceof ConnectorError &&
        error.detail === "mcp.prompt.arguments-invalid",
    );
  }
  assert.equal((await requestsFor(fixture, "prompts/get")).length, 0);

  const coerced = await h.adapter.invoke!(h.ctx, {
    operationRef: "op:summarize",
    input: { note: 7, draft: false },
    commandId: "c2",
  });
  assert.equal(coerced.state, "complete");

  // No input at all sends no `arguments` member, rather than an empty object
  // the server would have to treat as "every argument was omitted".
  const bare = await h.adapter.invoke!(h.ctx, {
    operationRef: "op:summarize",
    input: undefined,
    commandId: "c3",
  });
  assert.equal(bare.state, "complete");
  const sent = (await requestsFor(fixture, "prompts/get")).map(
    (entry) =>
      (entry.body as { params: Record<string, unknown> }).params.arguments,
  );
  assert.deepEqual(sent, [{ note: "7", draft: "false" }, undefined]);
});

test("tool arguments must be an object, and no input means no arguments", async () => {
  // Invariant: an array is not an argument map. Passing one through would let
  // a caller reach a tool with positional data the reviewer never saw, so it
  // is refused; absent input becomes an explicit empty map instead.
  const h = await harness();
  await assert.rejects(
    h.adapter.invoke!(h.ctx, {
      operationRef: "op:echo",
      input: ["hi"],
      commandId: "c1",
    }),
    (error: unknown) =>
      error instanceof ConnectorError &&
      error.detail === "mcp.tool.arguments-invalid",
  );
  assert.equal((await requestsFor(fixture, "tools/call")).length, 0);

  const empty = await h.adapter.invoke!(h.ctx, {
    operationRef: "op:echo",
    input: undefined,
    commandId: "c2",
  });
  assert.equal(empty.state, "complete");
  const calls = await requestsFor(fixture, "tools/call");
  assert.equal(calls.length, 1);
  assert.deepEqual(toolCallBody(calls[0]!).arguments, {});
});

test("a resource template is resolved only from values the adapter can bound", async () => {
  // Invariant: the URI the server receives is built from the reviewed
  // template plus values that are non-empty, bounded and free of control
  // characters. Anything else is refused by name, and a template the adapter
  // cannot fully resolve is never sent with its braces still in it — a server
  // might well treat `{name}` as a literal resource.
  const h = await harness();
  const refusals: Array<[unknown, string]> = [
    [{ name: "" }, "mcp.resource.variable-invalid"],
    [{ name: "x".repeat(513) }, "mcp.resource.variable-invalid"],
    [{ name: `bell${CONTROL_CHARACTER}` }, "mcp.resource.variable-invalid"],
    [{}, "mcp.resource.variable-invalid"],
  ];
  for (const [input, detail] of refusals) {
    await assert.rejects(
      h.adapter.invoke!(h.ctx, {
        operationRef: "op:note",
        input,
        commandId: "c1",
      }),
      (error: unknown) =>
        error instanceof ConnectorError && error.detail === detail,
    );
  }
  await assert.rejects(
    h.adapter.invoke!(h.ctx, {
      operationRef: "op:note-odd",
      input: { "note name": "shared" },
      commandId: "c2",
    }),
    (error: unknown) =>
      error instanceof ConnectorError &&
      error.detail === "mcp.resource.template-unresolved",
  );
  assert.equal((await requestsFor(fixture, "resources/read")).length, 0);

  // A template with no variables needs nothing from the caller and is sent
  // exactly as reviewed.
  const fixed = await h.adapter.invoke!(h.ctx, {
    operationRef: "op:note-shared",
    input: undefined,
    commandId: "c3",
  });
  assert.equal(fixed.state, "complete");
  const reads = await requestsFor(fixture, "resources/read");
  assert.equal(
    (reads[0]!.body as { params: { uri: string } }).params.uri,
    "note:///shared",
  );
});

/* ----------------------------------------------------------- the journal */

test("a write already applied is answered from the journal, not sent again", async () => {
  // Invariant: the same intent (same operation, connection, generation,
  // binding revision and arguments) is one effect however many commands ask
  // for it. Once it is known to have been applied, repeating the request is
  // reported as `already-applied` instead of creating a second note.
  const h = await harness();
  const first = await h.adapter.invoke!(h.ctx, {
    operationRef: "op:create",
    input: { title: "n" },
    commandId: "c1",
  });
  assert.equal(first.state, "complete");
  const again = await h.adapter.invoke!(h.ctx, {
    operationRef: "op:create",
    input: { title: "n" },
    commandId: "c2",
  });
  assert.equal(again.state, "complete");
  assert.equal(again.code, "already-applied");
  assert.equal(again.output, undefined, "no output is invented for a replay");
  const report = await fixture.report();
  assert.equal(report.effects.length, 1, "the note was created once");
  assert.equal(report.toolCalls, 1);
});

test("a write that failed before is reported as such rather than quietly retried", async () => {
  // Invariant: a known failure is a fact about this intent, and repeating the
  // request returns it. Retrying is a decision for whoever asked, not a
  // behaviour the adapter performs on their behalf.
  const h = await harness();
  const first = await h.adapter.invoke!(h.ctx, {
    operationRef: "op:vanished",
    input: { title: "n" },
    commandId: "c1",
  });
  assert.equal(first.state, "failed");
  assert.equal(first.code, "mcp.invalid-params");
  assert.equal(h.ports.inspect.effects()[0]!.outcome?.status, "failed");

  const again = await h.adapter.invoke!(h.ctx, {
    operationRef: "op:vanished",
    input: { title: "n" },
    commandId: "c2",
  });
  assert.equal(again.state, "failed");
  assert.equal(again.code, "previous-attempt-failed");
  assert.equal((await fixture.report()).toolCalls, 1, "sent once");
});

test("a result nobody can interpret is indeterminate for a write and failed for a read", async () => {
  // Invariant: "I received an answer I do not understand" is not the same as
  // "it did not happen". For a consequential call the outcome is unknown and
  // is journaled as indeterminate; for a read there is nothing to reconcile,
  // so it is simply a failure. The upstream text never becomes the code.
  const strangeResult = interceptingFetch(
    (message) => message.method === "tools/call",
    (id) => ({
      status: 200,
      body: { jsonrpc: "2.0", id, result: { resultType: "surprise" } },
    }),
  );
  const write = await harness({ fetch: strangeResult });
  const consequential = await write.adapter.invoke!(write.ctx, {
    operationRef: "op:create",
    input: { title: "n" },
    commandId: "c1",
  });
  assert.equal(consequential.state, "indeterminate");
  assert.equal(consequential.code, "mcp.result.unknown-type");
  assert.ok(consequential.effectRef);
  assert.equal(
    write.ports.inspect.effects()[0]!.outcome?.status,
    "indeterminate",
  );

  const read = await harness({ fetch: strangeResult });
  const harmless = await read.adapter.invoke!(read.ctx, {
    operationRef: "op:echo",
    input: { text: "hi" },
    commandId: "c2",
  });
  assert.equal(harmless.state, "failed");
  assert.equal(harmless.code, "mcp.result.unknown-type");
  assert.equal(harmless.effectRef, undefined);
  assert.equal(read.ports.inspect.effects().length, 0);
});

/* -------------------------------------------------------------- input rounds */

test("the host bounds how many times a server may ask for more input", async () => {
  // Invariant: the number of input rounds is the binding's, not the server's.
  // A server that keeps asking cannot hold a command open indefinitely, and
  // when the budget is spent the answer is a failure with a named reason and
  // no handoff for a person to fill in.
  const h = await harness({
    binding: binding({}, { limits: { maxInputRounds: 1 } }),
  });
  const result = await h.adapter.invoke!(h.ctx, {
    operationRef: "op:link",
    input: { repo: "ceremony" },
    commandId: "c1",
  });
  assert.equal(result.state, "failed");
  assert.equal(result.code, "mcp.input.too-many-rounds");
  assert.equal(result.handoff, undefined);
  assert.equal(h.ports.inspect.effects()[0]!.outcome?.status, "not-applied");
  assert.equal(h.ports.inspect.handoffs().length, 0);
});

/* ------------------------------------------------------------ continuation */

test("a continuation the binding no longer supports is refused before it is spent", async () => {
  // Invariant: the approval is re-read when the values come back, because a
  // suspended intent can outlive the review that allowed it. If the operation
  // has been removed, the profile or endpoint has moved, or the round budget
  // has been tightened, the continuation is refused — and refused before the
  // one-use handoff is consumed, so nothing is lost by re-approving.
  const h = await harness();
  const started = await h.adapter.invoke!(h.ctx, {
    operationRef: "op:link",
    input: { repo: "ceremony" },
    commandId: "c1",
  });
  assert.equal(started.state, "human-required");
  const { handoffRef } = await h.ports.handoffs.issue({
    ...started.handoff!,
    actor: h.ctx.actor,
    connectionRef: h.connection!.connectionRef,
    bindingRef: h.connection!.bindingRef,
    generation: h.ctx.generation,
  });
  const record = (await h.ports.handoffs.present(h.ctx.actor, handoffRef))!;
  const values = { name: "octocat" };

  const withoutOperation = binding();
  const removed = await h.adapter.resumeInput(
    {
      ...h.ctx,
      binding: runtimeBindingSchema.parse({
        ...withoutOperation,
        operations: withoutOperation.operations.filter(
          (operation) => operation.operationRef !== "op:link",
        ),
      }),
    },
    record,
    values,
  );
  assert.equal(removed.state, "denied");
  assert.equal(removed.code, "mcp.operation.not-bound");
  // With no operation to consult, the result claims the most restrictive
  // classification rather than guessing that the output was publishable.
  assert.equal(removed.outputClassification, "secret");
  assert.equal(removed.effect, "unknown");

  const otherProfile = await h.adapter.resumeInput(
    { ...h.ctx, binding: binding({}, { profile: "2025-11-25" }) },
    record,
    values,
  );
  assert.equal(otherProfile.code, "mcp.binding.profile-changed");

  const otherEndpoint = await h.adapter.resumeInput(
    { ...h.ctx, binding: binding({}, { endpointPath: "/mcp-v2" }) },
    record,
    values,
  );
  assert.equal(otherEndpoint.code, "mcp.binding.destination-changed");

  const tighterBudget = await h.adapter.resumeInput(
    { ...h.ctx, binding: binding({}, { limits: { maxInputRounds: 1 } }) },
    record,
    values,
  );
  assert.equal(tighterBudget.code, "mcp.input.too-many-rounds");

  for (const refused of [otherProfile, otherEndpoint, tighterBudget])
    assert.equal(refused.state, "denied");
  const report = await fixture.report();
  assert.equal(report.inputsSeen?.length ?? 0, 0, "nothing was continued");
  assert.equal(
    h.ports.inspect.handoffs()[0]!.state,
    "issued",
    "the handoff is still available to a valid continuation",
  );
});

test("a handoff that is spent, expired or altered cannot be continued", async () => {
  // Invariant: the stored request is re-verified against its own digest, the
  // stored requests are re-read for anything the host refuses outright, and a
  // handoff that is no longer pending or is past its expiry is not revived.
  // Otherwise the suspended record becomes a way to send a request no policy
  // ever saw, at a time nobody chose.
  const h = await harness();
  const started = await h.adapter.invoke!(h.ctx, {
    operationRef: "op:link",
    input: { repo: "ceremony" },
    commandId: "c1",
  });
  const { handoffRef } = await h.ports.handoffs.issue({
    ...started.handoff!,
    actor: h.ctx.actor,
    connectionRef: h.connection!.connectionRef,
    bindingRef: h.connection!.bindingRef,
    generation: h.ctx.generation,
  });
  const record = (await h.ports.handoffs.present(h.ctx.actor, handoffRef))!;
  const values = { name: "octocat" };

  const spent: HandoffRecord = { ...record, state: "cancelled" };
  const cancelled = await h.adapter.resumeInput(h.ctx, spent, values);
  assert.equal(cancelled.state, "denied");
  assert.equal(cancelled.code, "mcp.handoff.not-pending");

  const stale: HandoffRecord = {
    ...record,
    expiresAt: h.ctx.environment.now() - 1,
  };
  const expired = await h.adapter.resumeInput(h.ctx, stale, values);
  assert.equal(expired.code, "expired");

  const rewritten: HandoffRecord = {
    ...record,
    private: {
      ...record.private,
      input: JSON.stringify({ repo: "someone-elses-repo" }),
    },
  };
  const tampered = await h.adapter.resumeInput(h.ctx, rewritten, values);
  assert.equal(tampered.code, "mcp.input.digest-mismatch");

  // Even if the stored requests claim the server asked this host to run a
  // model, the continuation refuses; sampling is not something this client
  // offers, at suspension time or afterwards.
  const sampling: HandoffRecord = {
    ...record,
    private: {
      ...record.private,
      inputRequests: JSON.stringify([
        { id: "writer", kind: "sampling", method: "sampling/createMessage" },
      ]),
    },
  };
  const refused = await h.adapter.resumeInput(h.ctx, sampling, values);
  assert.equal(refused.code, "mcp.sampling.refused");

  const report = await fixture.report();
  assert.equal(report.inputsSeen?.length ?? 0, 0);
  assert.equal(h.ports.inspect.handoffs()[0]!.state, "issued");
});

test("declining an input request tells the server exactly that and invents no values", async () => {
  // Invariant: a person who declines is represented as declining. The server
  // learns the action and nothing else — no empty form, no guessed content —
  // and the tool's own error result is passed through as a failure of the
  // call rather than of the host.
  const h = await harness();
  const started = await h.adapter.invoke!(h.ctx, {
    operationRef: "op:link",
    input: undefined,
    commandId: "c1",
  });
  assert.equal(started.state, "human-required");
  const { handoffRef } = await h.ports.handoffs.issue({
    ...started.handoff!,
    actor: h.ctx.actor,
    connectionRef: h.connection!.connectionRef,
    bindingRef: h.connection!.bindingRef,
    generation: h.ctx.generation,
  });
  const record = (await h.ports.handoffs.present(h.ctx.actor, handoffRef))!;
  const declined = await h.adapter.resumeInput(h.ctx, record, {}, "decline");
  assert.equal(declined.state, "complete");
  assert.equal(
    (declined.output as { isError: boolean }).isError,
    true,
    "the tool reported its own refusal",
  );
  const report = await fixture.report();
  const seen = report.inputsSeen?.[0] as {
    inputResponses: Record<string, { action: string; content?: unknown }>;
  };
  assert.equal(seen.inputResponses.github_login!.action, "decline");
  assert.equal(
    seen.inputResponses.github_login!.content,
    undefined,
    "no content was invented for a person who declined",
  );
});

test("a legacy elicitation is answered on the retried call, and only if it is the same question", async () => {
  // Invariant: the pre-2026 revisions ask mid-request over the response
  // stream, which no handoff can span. The adapter suspends, then replays the
  // call and answers the elicitation inline — but only when the digest of
  // what the server asks matches what the person was shown. That digest is
  // what keeps an answer from being applied to a different question.
  const h = await harness({
    binding: legacyBinding(),
    material: { bearer: LEGACY_TOKEN },
    origin: legacy.origin,
  });
  const started = await h.adapter.invoke!(h.ctx, {
    operationRef: "op:ask-login",
    input: {},
    commandId: "c1",
  });
  assert.equal(started.state, "human-required");
  assert.equal(started.code, "input-required");
  // A read that suspends opens no effect: there is nothing to reconcile.
  assert.equal(started.effectRef, undefined);
  assert.equal(h.ports.inspect.effects().length, 0);
  assert.ok(
    started.handoff!.private.elicitationDigest,
    "the question asked is pinned to the handoff",
  );

  const { handoffRef } = await h.ports.handoffs.issue({
    ...started.handoff!,
    actor: h.ctx.actor,
    connectionRef: h.connection!.connectionRef,
    bindingRef: h.connection!.bindingRef,
    generation: h.ctx.generation,
  });
  const record = (await h.ports.handoffs.present(h.ctx.actor, handoffRef))!;
  const resumed = await h.adapter.resumeInput(h.ctx, record, {
    name: "octocat",
    remember: "true",
  });
  assert.equal(resumed.state, "complete");
  assert.equal(JSON.stringify(resumed).includes("octocat"), false);
  const report = await legacy.report();
  const answers = (report.elicitations ?? []) as Array<{
    action?: string;
    content?: { name?: string };
  }>;
  // The first attempt declined on the wire, because no person had been asked
  // yet; only the continuation carries an answer, and only one does.
  assert.deepEqual(
    answers.map((answer) => answer.action),
    ["cancel", "accept"],
  );
  assert.equal(answers[1]!.content?.name, "octocat");
});

/* --------------------------------------------------------- authorization */

test("authorization is answered from the binding's custody mode, not by guessing", async () => {
  // Invariant: `authorize` decides what a connection still needs from the
  // reviewed custody mode alone, and reaches no authorization server itself.
  // A binding that needs nothing says `verify`; one whose static bearer has
  // not been placed in custody names that configuration value instead of
  // starting an OAuth flow that would ask a person for a grant the deployment
  // does not use.
  const unauthenticated = await harness({
    binding: binding({}, { auth: "none" }),
  });
  assert.equal(
    (await unauthenticated.adapter.authorize!(unauthenticated.ctx, intent()))
      .kind,
    "verify",
  );

  const brokered = await harness({
    binding: binding({}, { auth: "broker" }),
    adapter: {
      broker: {
        async useBearer(_ctx, work) {
          return work(TOKEN);
        },
      },
    },
  });
  assert.equal(
    (await brokered.adapter.authorize!(brokered.ctx, intent())).kind,
    "verify",
  );

  const configured = await harness({
    binding: binding({}, { bearerConfiguration: "MCP_BEARER" }),
  });
  const missing = await configured.adapter.authorize!(configured.ctx, intent());
  assert.equal(missing.kind, "configuration-required");
  assert.deepEqual(
    missing.kind === "configuration-required" ? missing.missing : [],
    ["MCP_BEARER"],
  );
  configured.ports.configuration.set("MCP_BEARER", "static-token");
  assert.equal(
    (await configured.adapter.authorize!(configured.ctx, intent())).kind,
    "verify",
  );

  // An existing credential is enough, unless a person explicitly said they
  // are replacing the account — which is never inferred.
  const connected = await harness();
  assert.equal(
    (await connected.adapter.authorize!(connected.ctx, intent())).kind,
    "verify",
  );
  const switching = await connected.adapter.authorize!(connected.ctx, {
    ...intent(),
    accountSwitch: true,
  });
  assert.notEqual(
    switching.kind,
    "verify",
    "an account switch does not reuse the credential already held",
  );

  const report = await fixture.report();
  assert.equal(
    report.wire.some((entry) => entry.path === "/authorization"),
    false,
    "this adapter never speaks to an authorization server itself",
  );
});

/* ------------------------------------------------------ verify and complete */

test("verify reports unavailability as pending and cancellation as indeterminate", async () => {
  // Invariant: a claim is only made about something observed. A server that
  // answered 5xx has not rejected the credential, and a cancelled probe has
  // not either — neither may be recorded as a denial, and neither produces a
  // verification claim.
  const unavailable = await harness({
    binding: binding({}, { limits: { readRetries: 0 } }),
    fetch: interceptingFetch(
      (message) => message.method === "server/discover",
      (id) => ({
        status: 503,
        body: {
          jsonrpc: "2.0",
          id,
          error: { code: -32603, message: "maintenance" },
        },
      }),
    ),
  });
  const pending = await unavailable.adapter.verify!(unavailable.ctx);
  assert.equal(pending.state, "pending");
  assert.equal(pending.code, "mcp.http.503");
  assert.deepEqual(pending.claims, []);

  const cancelled = await harness();
  cancelled.controller.abort();
  const stopped = await cancelled.adapter.verify!(cancelled.ctx);
  assert.equal(stopped.state, "indeterminate");
  assert.equal(stopped.code, "cancelled");
  assert.deepEqual(stopped.claims, []);
});

test("a discovery answer the adapter cannot parse is denied by name", async () => {
  // Invariant: discovery is where a server states what it is, and an answer
  // that does not parse establishes nothing. It is reported as denied with the
  // adapter's own code — never as a successful verification with an empty
  // capability list, and never with the server's prose in the code.
  const h = await harness({
    fetch: interceptingFetch(
      (message) => message.method === "server/discover",
      (id) => ({
        status: 200,
        body: {
          jsonrpc: "2.0",
          id,
          result: { resultType: "complete", capabilities: "all of them" },
        },
      }),
    ),
  });
  const result = await h.adapter.verify!(h.ctx);
  assert.equal(result.state, "denied");
  assert.equal(result.code, "mcp.discover.invalid");
  assert.deepEqual(result.claims, []);
  assert.equal(result.adapterState, undefined);
});

test("a challenge nobody documented is reported as unknown, not filled in", async () => {
  // Invariant: the summarized challenge carries only what was observed. With
  // no WWW-Authenticate header and no reachable protected-resource metadata
  // there is no error code, no metadata URL and no authorization server to
  // name — and the adapter names none, recording instead the issues it hit.
  // Inventing an authorization server here would send a person's credentials
  // to an endpoint no server ever advertised.
  await fixture.control({ mode: "no-challenge-header" });
  const h = await harness({
    material: { bearer: "wrong-token" },
    fetch: withoutMetadata(),
  });
  const result = await h.adapter.verify!(h.ctx);
  assert.equal(result.state, "denied");
  assert.equal(result.code, "authorization-required");
  const challenge = result.adapterState?.challenge as {
    error?: string;
    resourceMetadataUrl?: string;
    canonicalResource: string;
    authorizationServers: string[];
    requestedScopes: string[];
    issues: string[];
  };
  assert.equal(challenge.error, undefined);
  assert.equal(challenge.resourceMetadataUrl, undefined);
  assert.deepEqual(challenge.authorizationServers, []);
  assert.deepEqual(challenge.requestedScopes, []);
  assert.equal(challenge.canonicalResource, `${fixture.origin}/mcp`);
  assert.ok(challenge.issues.includes("challenge-missing"));
  assert.ok(challenge.issues.includes("metadata-not-found"));
});

test("completion polls verification and refuses input values smuggled past the handoff", async () => {
  // Invariant: answers to a server's question travel one way only — through
  // the one-use handoff that `resumeInput` consumes. Accepting them on the
  // generic completion path would be a second, unfenced route to the same
  // call, with no record of which suspended intent they belong to.
  const h = await harness();
  const polled = await h.adapter.complete!(h.ctx, { kind: "poll" });
  assert.equal(polled.state, "complete");
  assert.equal(polled.claims.length, 1);

  const smuggled = await h.adapter.complete!(h.ctx, {
    kind: "input",
    values: { name: "octocat" },
  });
  assert.equal(smuggled.state, "denied");
  assert.equal(smuggled.code, "mcp.completion.unsupported-input");
  assert.deepEqual(smuggled.claims, []);
  assert.equal((await requestsFor(fixture, "tools/call")).length, 0);
});

/* ---------------------------------------------------------------- teardown */

test("disconnect at broker scope is honest about what MCP cannot do", async () => {
  // Invariant: each scope is answered for itself. MCP defines no disconnect,
  // so a broker-scoped request is `unsupported` rather than `applied`, and the
  // scope nobody asked about is `not-attempted` rather than claimed. Open
  // handoffs for the connection are cancelled, because forgetting locally must
  // not leave a continuation that could still reach the server.
  const h = await harness();
  const started = await h.adapter.invoke!(h.ctx, {
    operationRef: "op:link",
    input: { repo: "ceremony" },
    commandId: "c1",
  });
  await h.ports.handoffs.issue({
    ...started.handoff!,
    actor: h.ctx.actor,
    connectionRef: h.connection!.connectionRef,
    bindingRef: h.connection!.bindingRef,
    generation: h.ctx.generation,
  });
  const result = await h.adapter.disconnect!(h.ctx, "broker");
  assert.deepEqual(result, {
    local: "applied",
    broker: "unsupported",
    upstream: "not-attempted",
  });
  assert.equal(h.ports.inspect.handoffs()[0]!.state, "cancelled");
  const report = await fixture.report();
  assert.equal(
    report.wire.some((entry) => entry.method === "DELETE"),
    false,
    "no disconnect request exists to send",
  );
});

test("the client identity the server is told is the reviewed one", async () => {
  // Invariant: the binding names the client the server sees. It is reviewed
  // configuration, not something a caller or the server can influence, so a
  // server's access logs and rate limits attribute the call correctly.
  const h = await harness({
    binding: binding(
      {},
      { clientInfo: { name: "ceremony-host", version: "9.9.9" } },
    ),
  });
  const result = await h.adapter.invoke!(h.ctx, {
    operationRef: "op:echo",
    input: { text: "hi" },
    commandId: "c1",
  });
  assert.equal(result.state, "complete");
  const calls = await requestsFor(fixture, "tools/call");
  assert.deepEqual(
    toolCallBody(calls[0]!)._meta?.["io.modelcontextprotocol/clientInfo"],
    { name: "ceremony-host", version: "9.9.9" },
  );
});
