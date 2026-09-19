import assert from "node:assert/strict";
import { test } from "node:test";
import {
  McpResultCache,
  SseParser,
  collectHeaderParameters,
  decodeMcpHeaderValue,
  encodeMcpHeaderValue,
  isRecognizedModernError,
  parseBearerChallenge,
  parseBoundedJson,
  protectedResourceMetadataSchema,
  WireError,
  mcpProfiles,
  resolveLimits,
  parseMcpBindingSettings,
} from "../../../src/server/connectors/mcp/index.js";
import { validateFormValues } from "../../../src/server/connectors/mcp/input.js";
import { formSchemaSchema } from "../../../src/server/connectors/mcp/input.js";

/*
 * The pieces every profile depends on, tested away from the network: the SSE
 * framing, the header value encoding this revision defines, challenge
 * parsing (including the malformed shapes a hostile or careless server may
 * send), bounded JSON, and the cache's principal rules.
 */

test("the SSE parser joins data lines, ignores comments and dispatches on blank lines", () => {
  const parser = new SseParser();
  const chunk = (text: string) => parser.push(new TextEncoder().encode(text));
  assert.deepEqual(chunk(":\n"), []);
  assert.deepEqual(chunk('data: {"a":1}\n\n'), [{ data: '{"a":1}' }]);
  // A frame split across chunks in the middle of a field value. The harder
  // split, between the CR and the LF of one CRLF, has its own test below.
  assert.deepEqual(chunk("event: message\r\ndata: one\r\ndata:"), []);
  assert.deepEqual(chunk(" two\r\n\r\n"), [
    { data: "one\ntwo", event: "message" },
  ]);
  assert.deepEqual(chunk("id: 7\nretry: 500\ndata: x\n\n"), [
    { data: "x", id: "7", retry: 500 },
  ]);
  // A field with no value and an unterminated final frame.
  assert.deepEqual(chunk("data\n"), []);
  assert.deepEqual(parser.finish(), [{ data: "" }]);
});

test("the SSE parser reports the same frames wherever the chunks are cut", () => {
  const encode = (text: string) => new TextEncoder().encode(text);
  const frames = (...parts: string[]) => {
    const parser = new SseParser();
    const seen = parts.flatMap((part) => parser.push(encode(part)));
    return [...seen, ...parser.finish()];
  };
  /*
   * The boundary that used to be read wrong: a chunk ends on the CR of a CRLF
   * and the LF opens the next one, which ordinary TCP segmentation does at
   * will. Ending the line on that CR then read the LF as a blank line, which
   * dispatched half a frame and left the rest to be dispatched as a second
   * one. Neither half parses as JSON downstream, so an answered call looked
   * like a dropped stream.
   */
  assert.deepEqual(
    frames('data: {"jsonrpc":"2.0",\r', '\ndata: "id":1}\r\n\r\n'),
    [{ data: '{"jsonrpc":"2.0",\n"id":1}' }],
  );
  /*
   * The property behind that case, for each of the three terminators the spec
   * allows and at every byte a reader could cut on: what we report may not
   * depend on where the stream was sliced. Exhaustive rather than by example,
   * so it cannot quietly stop covering the seam.
   */
  for (const terminator of ["\r\n", "\n", "\r"]) {
    const payload = [
      ": ping",
      "event: message",
      "id: 7",
      'data: {"jsonrpc":"2.0",',
      'data: "id":1}',
      "",
      "",
    ].join(terminator);
    const whole = frames(payload);
    assert.deepEqual(whole, [
      { data: '{"jsonrpc":"2.0",\n"id":1}', event: "message", id: "7" },
    ]);
    for (let at = 1; at < payload.length; at += 1)
      assert.deepEqual(
        frames(payload.slice(0, at), payload.slice(at)),
        whole,
        `${JSON.stringify(terminator)} split at byte ${at}`,
      );
  }
  // Bytes the parser is still holding are bytes it has counted, so waiting for
  // the next chunk cannot hide a flood from the caller's stream ceiling.
  const parser = new SseParser();
  assert.deepEqual(parser.push(encode("data: x\r")), []);
  assert.equal(parser.bytes, 8);
  assert.deepEqual(parser.push(encode("\n\r\n")), [{ data: "x" }]);
  assert.equal(parser.bytes, 11);
});

test("header values are encoded only when they cannot travel as plain ASCII", () => {
  assert.equal(encodeMcpHeaderValue("us-west1"), "us-west1");
  assert.equal(
    encodeMcpHeaderValue("Hello, 世界"),
    "=?base64?SGVsbG8sIOS4lueVjA==?=",
  );
  assert.equal(encodeMcpHeaderValue(" padded "), "=?base64?IHBhZGRlZCA=?=");
  assert.equal(
    encodeMcpHeaderValue("line1\nline2"),
    "=?base64?bGluZTEKbGluZTI=?=",
  );
  // A plain value that looks like the sentinel is encoded so it cannot be
  // mistaken for one.
  assert.equal(
    encodeMcpHeaderValue("=?base64?literal?="),
    "=?base64?PT9iYXNlNjQ/bGl0ZXJhbD89?=",
  );
  for (const value of [
    "us-west1",
    "Hello, 世界",
    " padded ",
    "=?base64?literal?=",
  ])
    assert.equal(decodeMcpHeaderValue(encodeMcpHeaderValue(value)), value);
});

test("x-mcp-header annotations are accepted only where they are statically reachable", () => {
  const ok = collectHeaderParameters({
    type: "object",
    properties: {
      region: { type: "string", "x-mcp-header": "Region" },
      nested: {
        type: "object",
        properties: { tenant: { type: "integer", "x-mcp-header": "Tenant" } },
      },
    },
  });
  assert.deepEqual(ok, {
    ok: true,
    parameters: [
      { path: ["region"], header: "Region" },
      { path: ["nested", "tenant"], header: "Tenant" },
    ],
  });
  for (const [reason, schema] of [
    [
      "non-primitive-type",
      {
        type: "object",
        properties: { a: { type: "number", "x-mcp-header": "A" } },
      },
    ],
    [
      "invalid-token",
      {
        type: "object",
        properties: { a: { type: "string", "x-mcp-header": "bad header" } },
      },
    ],
    [
      "empty-or-non-string",
      {
        type: "object",
        properties: { a: { type: "string", "x-mcp-header": "" } },
      },
    ],
    [
      "duplicate-name",
      {
        type: "object",
        properties: {
          a: { type: "string", "x-mcp-header": "Dup" },
          b: { type: "string", "x-mcp-header": "dup" },
        },
      },
    ],
    [
      "annotation-not-statically-reachable",
      {
        type: "object",
        properties: { a: { items: { type: "string", "x-mcp-header": "A" } } },
      },
    ],
    [
      "annotation-not-statically-reachable",
      {
        type: "object",
        properties: { a: { oneOf: [{ type: "string", "x-mcp-header": "A" }] } },
      },
    ],
  ] as const) {
    const outcome = collectHeaderParameters(schema as Record<string, unknown>);
    assert.equal(outcome.ok, false);
    if (!outcome.ok) assert.equal(outcome.reason, reason);
  }
});

test("a Bearer challenge is parsed, and a malformed one yields nothing rather than a guess", () => {
  const parsed = parseBearerChallenge(
    'Bearer resource_metadata="https://mcp.example/.well-known/oauth-protected-resource", scope="files:read files:write", error="insufficient_scope"',
  );
  assert.equal(
    parsed?.resource_metadata,
    "https://mcp.example/.well-known/oauth-protected-resource",
  );
  assert.equal(parsed?.scope, "files:read files:write");
  assert.equal(parsed?.error, "insufficient_scope");
  // Case-insensitive scheme, token parameters, and an escaped quote.
  assert.equal(parseBearerChallenge("bearer realm=main")?.realm, "main");
  assert.equal(parseBearerChallenge('Bearer realm="a\\"b"')?.realm, 'a"b');
  // Not a Bearer challenge, or not a challenge at all.
  assert.equal(parseBearerChallenge("Basic realm=x"), undefined);
  assert.equal(parseBearerChallenge(""), undefined);
  assert.equal(parseBearerChallenge(null), undefined);
  assert.equal(parseBearerChallenge("Bearer realm="), undefined);
  // Bearer with no parameters is still a Bearer challenge.
  assert.deepEqual(parseBearerChallenge("Bearer"), {});
});

test("protected resource metadata is validated before it is used", () => {
  assert.equal(
    protectedResourceMetadataSchema.safeParse({
      resource: "https://mcp.example/mcp",
      authorization_servers: ["https://issuer.example"],
    }).success,
    true,
  );
  assert.equal(
    protectedResourceMetadataSchema.safeParse({
      resource: "https://mcp.example",
    }).success,
    false,
  );
  assert.equal(
    protectedResourceMetadataSchema.safeParse({
      resource: "https://mcp.example",
      authorization_servers: "https://issuer.example",
    }).success,
    false,
  );
});

test("JSON from a server is bounded in depth, size and object keys", () => {
  assert.deepEqual(parseBoundedJson('{"a":[1,2]}', { maxDepth: 8 }), {
    a: [1, 2],
  });
  assert.throws(
    () => parseBoundedJson("{", { maxDepth: 8 }),
    (error: unknown) => error instanceof WireError,
  );
  const deep = "[".repeat(40) + "]".repeat(40);
  assert.throws(
    () => parseBoundedJson(deep, { maxDepth: 8 }),
    (error: unknown) =>
      error instanceof WireError && error.code === "json-too-deep",
  );
  assert.throws(
    () => parseBoundedJson('{"__proto__":{"polluted":true}}', { maxDepth: 8 }),
    (error: unknown) =>
      error instanceof WireError && error.code === "json-reserved-key",
  );
  assert.throws(
    () => parseBoundedJson("[1,2,3,4,5]", { maxDepth: 8, maxNodes: 3 }),
    (error: unknown) =>
      error instanceof WireError && error.code === "json-too-many-nodes",
  );
  assert.equal(({} as Record<string, unknown>).polluted, undefined);
});

test("only the errors this revision defines identify a modern server", () => {
  assert.equal(isRecognizedModernError({ code: -32022, message: "" }), true);
  assert.equal(isRecognizedModernError({ code: -32021, message: "" }), true);
  assert.equal(isRecognizedModernError({ code: -32020, message: "" }), true);
  assert.equal(isRecognizedModernError({ code: -32601, message: "" }), true);
  assert.equal(
    isRecognizedModernError({ code: -32000, message: "Bad Request" }),
    false,
  );
  assert.equal(isRecognizedModernError({ code: -32602, message: "" }), false);
});

test("the cache separates principals and honours the server's freshness hint", () => {
  let now = 1000;
  const cache = new McpResultCache(() => now, {
    cacheMaxTtlMs: 5000,
    cacheMaxEntries: 4,
  });
  const ada = {
    tenantId: "t",
    ownerId: "ada",
    connectionRef: "c1",
    generation: 1,
    profile: "2026-07-28",
    credentialRef: "cred-1",
  };
  cache.set(
    ada,
    "tools/list",
    {},
    { tools: ["a"] },
    { ttlMs: 1000, cacheScope: "public" },
  );
  assert.deepEqual(cache.get(ada, "tools/list", {}), { tools: ["a"] });
  // Another owner, another connection, another generation and another
  // credential are each a different principal.
  for (const other of [
    { ...ada, ownerId: "beatrix" },
    { ...ada, connectionRef: "c2" },
    { ...ada, generation: 2 },
    { ...ada, credentialRef: "cred-2" },
    { ...ada, tenantId: "t2" },
  ])
    assert.equal(cache.get(other, "tools/list", {}), undefined);
  // Different parameters are a different entry.
  assert.equal(cache.get(ada, "tools/list", { cursor: "page-2" }), undefined);
  now += 1001;
  assert.equal(cache.get(ada, "tools/list", {}), undefined, "the hint expires");
  // A ttl above the host bound is clamped, and no ttl means no caching.
  cache.set(
    ada,
    "tools/list",
    {},
    { tools: ["b"] },
    { ttlMs: 1_000_000, cacheScope: "public" },
  );
  now += 5001;
  assert.equal(cache.get(ada, "tools/list", {}), undefined);
  cache.set(
    ada,
    "tools/list",
    {},
    { tools: ["c"] },
    { ttlMs: undefined, cacheScope: "public" },
  );
  assert.equal(cache.get(ada, "tools/list", {}), undefined);
  // Invalidation is per principal and may be narrowed to one method.
  cache.set(
    ada,
    "tools/list",
    {},
    { tools: ["d"] },
    { ttlMs: 1000, cacheScope: "private" },
  );
  cache.set(
    ada,
    "prompts/list",
    {},
    { prompts: [] },
    { ttlMs: 1000, cacheScope: "private" },
  );
  assert.equal(cache.invalidate(ada, "tools/list"), 1);
  assert.equal(cache.get(ada, "tools/list", {}), undefined);
  assert.deepEqual(cache.get(ada, "prompts/list", {}), { prompts: [] });
});

test("the cache evicts within its bound rather than growing", () => {
  const cache = new McpResultCache(() => 0, {
    cacheMaxTtlMs: 10_000,
    cacheMaxEntries: 2,
  });
  const who = {
    tenantId: "t",
    ownerId: "o",
    connectionRef: "c",
    generation: 1,
    profile: "p",
  };
  for (const method of ["a", "b", "c"])
    cache.set(
      who,
      method,
      {},
      { method },
      { ttlMs: 1000, cacheScope: "private" },
    );
  assert.equal(cache.size, 2);
  assert.equal(cache.get(who, "a", {}), undefined);
  assert.deepEqual(cache.get(who, "c", {}), { method: "c" });
});

test("the profile table keeps the two eras apart", () => {
  assert.equal(mcpProfiles["2026-07-28"].era, "modern");
  assert.equal(mcpProfiles["2026-07-28"].sessions, "none");
  assert.equal(mcpProfiles["2026-07-28"].handshake, "none");
  assert.equal(mcpProfiles["2026-07-28"].serverInteraction, "input_required");
  assert.equal(mcpProfiles["2026-07-28"].resumableStreams, false);
  assert.equal(
    mcpProfiles["2026-07-28"].dynamicClientRegistration,
    "deprecated",
  );
  for (const id of ["2025-11-25", "2025-06-18"] as const) {
    assert.equal(mcpProfiles[id].era, "legacy");
    assert.equal(mcpProfiles[id].handshake, "initialize");
    assert.equal(mcpProfiles[id].sessions, "mcp-session-id");
    assert.equal(mcpProfiles[id].serverInteraction, "server-requests");
    assert.equal(mcpProfiles[id].dynamicClientRegistration, "documented");
  }
  assert.deepEqual(
    [...mcpProfiles["2025-06-18"].clientRegistration],
    ["pre-registered", "dynamic"],
  );
});

test("binding settings are inert, bounded and pin one profile", () => {
  const settings = parseMcpBindingSettings({ profile: "2026-07-28" });
  assert.equal(settings.compatibility, "pinned");
  assert.equal(settings.endpointPath, "/mcp");
  assert.equal(settings.auth, "bearer");
  assert.throws(() => parseMcpBindingSettings({ profile: "2024-11-05" }));
  assert.throws(() =>
    parseMcpBindingSettings({ profile: "2026-07-28", endpointPath: "//evil" }),
  );
  assert.throws(() =>
    parseMcpBindingSettings({
      profile: "2026-07-28",
      endpointPath: "/mcp?x=1",
    }),
  );
  assert.throws(() =>
    parseMcpBindingSettings({
      profile: "2026-07-28",
      resource: "https://mcp.example/mcp#frag",
    }),
  );
  const limits = resolveLimits({ maxListPages: 2 });
  assert.equal(limits.maxListPages, 2);
  assert.equal(limits.maxStreamFrames, 256);
  assert.throws(() => resolveLimits({ maxListPages: 1000 }));
});

test("answers are validated against the schema the server asked for", () => {
  const schema = formSchemaSchema.parse({
    type: "object",
    properties: {
      name: { type: "string", minLength: 2 },
      age: { type: "integer", minimum: 18 },
      remember: { type: "boolean" },
      colour: { type: "string", enum: ["red", "green"] },
    },
    required: ["name"],
  });
  assert.deepEqual(
    validateFormValues(schema, {
      name: "octocat",
      age: "30",
      remember: "true",
      colour: "red",
    }),
    {
      ok: true,
      content: { name: "octocat", age: 30, remember: true, colour: "red" },
    },
  );
  assert.deepEqual(validateFormValues(schema, {}), {
    ok: false,
    code: "required:name",
  });
  assert.deepEqual(validateFormValues(schema, { name: "o" }), {
    ok: false,
    code: "min-length:name",
  });
  assert.deepEqual(validateFormValues(schema, { name: "ok", age: "17" }), {
    ok: false,
    code: "minimum:age",
  });
  assert.deepEqual(validateFormValues(schema, { name: "ok", colour: "blue" }), {
    ok: false,
    code: "enum:colour",
  });
  assert.deepEqual(validateFormValues(schema, { name: "ok", nickname: "x" }), {
    ok: false,
    code: "unknown-field:nickname",
  });
  // A schema with nested objects is not a form-mode schema at all.
  assert.equal(
    formSchemaSchema.safeParse({
      type: "object",
      properties: { nested: { type: "object", properties: {} } },
    }).success,
    false,
  );
});
