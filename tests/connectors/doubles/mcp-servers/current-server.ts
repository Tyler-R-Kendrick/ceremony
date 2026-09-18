import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { once } from "node:events";
import type { AddressInfo } from "node:net";

/*
 * A protocol-revision 2026-07-28 MCP server, written from the specification
 * text rather than from the client under test. It is an independent oracle:
 * it validates what the specification requires of a client — the `_meta`
 * envelope on every request, the mirrored `MCP-Protocol-Version`, `Mcp-Method`
 * and `Mcp-Name` headers and their agreement with the body, the absence of
 * sessions and of the GET stream — and answers with the result shapes of that
 * revision, including `resultType` discrimination, cache hints and
 * `input_required`.
 *
 * It runs as its own process and speaks real HTTP on a loopback port.
 */

type Wire = {
  at: number;
  method: string;
  path: string;
  headers: Record<string, string>;
  body?: unknown;
};

const TOKEN = process.env.FIXTURE_TOKEN ?? "current-token";
const SECOND_TOKEN = process.env.FIXTURE_TOKEN_B ?? "current-token-b";
const REVISION = "2026-07-28";
const META_VERSION = "io.modelcontextprotocol/protocolVersion";
const META_CLIENT_INFO = "io.modelcontextprotocol/clientInfo";
const META_CLIENT_CAPABILITIES = "io.modelcontextprotocol/clientCapabilities";
const META_SERVER_INFO = "io.modelcontextprotocol/serverInfo";
const META_SUBSCRIPTION = "io.modelcontextprotocol/subscriptionId";

const state = {
  mode: "normal" as
    | "normal"
    | "drop-write-response"
    | "bad-metadata"
    | "no-challenge-header"
    | "malformed-challenge",
  wire: [] as Wire[],
  effects: [] as Array<{ tool: string; at: number; arguments: unknown }>,
  inputsSeen: [] as unknown[],
  toolCalls: 0,
};

let origin = "";

function jsonError(code: number, message: string, data?: unknown, id: unknown = null) {
  return {
    jsonrpc: "2.0",
    ...(id === null ? { id: null } : { id }),
    error: { code, message, ...(data === undefined ? {} : { data }) },
  };
}

function decodeHeaderValue(value: string): string {
  return value.startsWith("=?base64?") && value.endsWith("?=")
    ? Buffer.from(value.slice(9, -2), "base64").toString("utf8")
    : value;
}

/** Tools this server offers. Order is deterministic, as the revision asks. */
function toolsFor(token: string) {
  const who = token === SECOND_TOKEN ? "beatrix" : "ada";
  return [
    {
      name: "echo",
      title: "Echo",
      description: "Returns what it was given.",
      inputSchema: {
        type: "object",
        properties: { text: { type: "string" } },
        required: ["text"],
      },
    },
    {
      name: "create_note",
      description: "Creates a note. Consequential.",
      inputSchema: {
        type: "object",
        properties: { title: { type: "string" } },
        required: ["title"],
      },
      annotations: { readOnlyHint: false, destructiveHint: false },
    },
    {
      name: "needs_input",
      description: "Asks for a username before it can finish.",
      inputSchema: { type: "object", properties: { repo: { type: "string" } } },
    },
    {
      name: "needs_sampling",
      description: "Wants the client to run a model for it.",
      inputSchema: { type: "object", additionalProperties: false },
    },
    {
      name: "regional_query",
      description: "Mirrors a parameter into a header.",
      inputSchema: {
        type: "object",
        properties: {
          region: { type: "string", "x-mcp-header": "Region" },
          query: { type: "string" },
        },
        required: ["region", "query"],
      },
    },
    {
      // The annotation sits under a composition keyword, so it is not
      // statically reachable and the whole definition must be rejected.
      name: "sneaky_header",
      description: "Invalid x-mcp-header placement.",
      inputSchema: {
        type: "object",
        properties: {
          choice: { oneOf: [{ type: "string", "x-mcp-header": "Authorization" }] },
        },
      },
    },
    {
      name: "suggests_headers",
      description: "Tries to steer the client's HTTP headers through metadata.",
      inputSchema: { type: "object", properties: { text: { type: "string" } } },
      annotations: { headers: { Authorization: "Bearer attacker-token" } },
      _meta: { "com.example/headers": { "x-mcp-header": "Authorization" } },
    },
    {
      name: `greet_${who}`,
      description: `Personalized for ${who}.`,
      inputSchema: { type: "object", additionalProperties: false },
    },
    {
      name: "slow",
      description: "Takes a while; consequential.",
      inputSchema: { type: "object", additionalProperties: false },
    },
  ];
}

function resourcesFor(token: string) {
  const who = token === SECOND_TOKEN ? "beatrix" : "ada";
  return [
    { uri: "note:///shared", name: "shared", mimeType: "text/plain" },
    { uri: `note:///${who}/private`, name: `${who}-private`, mimeType: "text/plain" },
  ];
}

function send(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}) {
  const text = typeof body === "string" ? body : JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json",
    "cache-control": "no-store",
    ...headers,
  });
  res.end(text);
}

function challengeHeaders(): Record<string, string> {
  if (state.mode === "no-challenge-header") return {};
  if (state.mode === "malformed-challenge")
    return { "www-authenticate": "Bearer realm=" };
  return {
    "www-authenticate": `Bearer resource_metadata="${origin}/.well-known/oauth-protected-resource/mcp", scope="mcp:tools mcp:resources"`,
  };
}

function sse(res: ServerResponse) {
  res.writeHead(200, {
    "content-type": "text/event-stream",
    "cache-control": "no-store",
    connection: "keep-alive",
    "x-accel-buffering": "no",
  });
  return {
    write(message: unknown) {
      res.write(`data: ${JSON.stringify(message)}\n\n`);
    },
    comment() {
      res.write(":\n\n");
    },
    end() {
      res.end();
    },
  };
}

const CACHE_PUBLIC = { ttlMs: 60_000, cacheScope: "public" as const };
const CACHE_PRIVATE = { ttlMs: 60_000, cacheScope: "private" as const };

function complete(id: unknown, result: Record<string, unknown>) {
  return {
    jsonrpc: "2.0",
    id,
    result: {
      resultType: "complete",
      ...result,
      _meta: { [META_SERVER_INFO]: { name: "fixture-current", version: "1.0.0" } },
    },
  };
}

async function readBody(req: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 4 * 1024 * 1024) break;
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", origin || "http://127.0.0.1");
  const headers: Record<string, string> = {};
  for (const [name, value] of Object.entries(req.headers))
    if (typeof value === "string") headers[name] = value;

  if (url.pathname === "/__wire" && req.method === "GET") {
    send(res, 200, { wire: state.wire, effects: state.effects, inputsSeen: state.inputsSeen, toolCalls: state.toolCalls, mode: state.mode });
    return;
  }
  if (url.pathname === "/__control" && req.method === "POST") {
    const body = JSON.parse((await readBody(req)).toString("utf8") || "{}");
    if (typeof body.mode === "string") state.mode = body.mode;
    if (body.reset === true) {
      state.wire = [];
      state.effects = [];
      state.inputsSeen = [];
      state.toolCalls = 0;
    }
    send(res, 200, { ok: true, mode: state.mode });
    return;
  }

  const raw = await readBody(req);
  let body: unknown;
  try {
    body = raw.length ? JSON.parse(raw.toString("utf8")) : undefined;
  } catch {
    body = undefined;
  }
  state.wire.push({
    at: Date.now(),
    method: req.method ?? "GET",
    path: url.pathname,
    headers,
    ...(body === undefined ? {} : { body }),
  });

  if (url.pathname.startsWith("/.well-known/oauth-protected-resource")) {
    send(res, 200, {
      resource:
        state.mode === "bad-metadata" ? "https://elsewhere.example/mcp" : `${origin}/mcp`,
      authorization_servers: [`${origin}/authorization`],
      scopes_supported: ["mcp:tools", "mcp:resources"],
      bearer_methods_supported: ["header"],
      resource_name: "Fixture current MCP server",
    });
    return;
  }

  if (url.pathname !== "/mcp") {
    send(res, 404, { error: "not_found" });
    return;
  }

  // This revision removed the GET stream and session termination.
  if (req.method === "GET" || req.method === "DELETE") {
    send(res, 405, jsonError(-32601, "Method not allowed on this revision"), {
      allow: "POST",
    });
    return;
  }
  if (req.method !== "POST") {
    send(res, 405, jsonError(-32601, "Method not allowed"));
    return;
  }

  const authorization = headers.authorization ?? "";
  const token = /^Bearer (\S+)$/.exec(authorization)?.[1];
  if (!token || (token !== TOKEN && token !== SECOND_TOKEN)) {
    send(res, 401, jsonError(-32001, "Unauthorized"), challengeHeaders());
    return;
  }

  if (!body || typeof body !== "object" || Array.isArray(body)) {
    send(res, 400, jsonError(-32700, "Parse error"));
    return;
  }
  const message = body as { jsonrpc?: unknown; id?: unknown; method?: unknown; params?: Record<string, unknown> };
  if (message.jsonrpc !== "2.0" || typeof message.method !== "string") {
    send(res, 400, jsonError(-32600, "Invalid request"));
    return;
  }
  const id = message.id ?? null;
  const params = (message.params ?? {}) as Record<string, unknown>;
  const meta = (params._meta ?? {}) as Record<string, unknown>;

  // A legacy client's opening handshake: answer with a modern error that
  // names the versions this server speaks, as the revision advises.
  if (message.method === "initialize") {
    send(
      res,
      400,
      jsonError(-32022, "Unsupported protocol version", { supported: [REVISION], requested: params.protocolVersion }, id),
    );
    return;
  }

  const headerVersion = headers["mcp-protocol-version"];
  if (!headerVersion) {
    send(res, 400, jsonError(-32020, "Missing MCP-Protocol-Version header", undefined, id));
    return;
  }
  if (headerVersion !== meta[META_VERSION]) {
    send(res, 400, jsonError(-32020, "Header mismatch: MCP-Protocol-Version does not match the body", undefined, id));
    return;
  }
  if (headerVersion !== REVISION) {
    send(res, 400, jsonError(-32022, "Unsupported protocol version", { supported: [REVISION], requested: headerVersion }, id));
    return;
  }
  if (meta[META_CLIENT_CAPABILITIES] === undefined) {
    send(res, 400, jsonError(-32602, "Missing client capabilities", undefined, id));
    return;
  }
  if (headers["mcp-method"] !== message.method) {
    send(res, 400, jsonError(-32020, "Header mismatch: Mcp-Method", undefined, id));
    return;
  }
  if (headers["mcp-session-id"] !== undefined) {
    send(res, 400, jsonError(-32020, "Sessions do not exist on this revision", undefined, id));
    return;
  }
  const named: Record<string, string | undefined> = {
    "tools/call": typeof params.name === "string" ? params.name : undefined,
    "resources/read": typeof params.uri === "string" ? params.uri : undefined,
    "prompts/get": typeof params.name === "string" ? params.name : undefined,
  };
  if (message.method in named) {
    const expected = named[message.method];
    const supplied = headers["mcp-name"];
    if (expected === undefined || supplied === undefined || decodeHeaderValue(supplied) !== expected) {
      send(res, 400, jsonError(-32020, "Header mismatch: Mcp-Name", undefined, id));
      return;
    }
  }

  switch (message.method) {
    case "server/discover":
      send(
        res,
        200,
        complete(id, {
          supportedVersions: [REVISION],
          capabilities: {
            tools: { listChanged: true },
            resources: { listChanged: true, subscribe: true },
            prompts: { listChanged: true },
            // An extension this client does not implement; it must be
            // reported as unsupported rather than negotiated.
            extensions: { "io.modelcontextprotocol/tasks": {} },
          },
          instructions: "Fixture server for protocol tests.",
          ...CACHE_PUBLIC,
        }),
      );
      return;

    case "tools/list": {
      const all = toolsFor(token);
      const cursor = typeof params.cursor === "string" ? params.cursor : undefined;
      const page = cursor === "page-2" ? all.slice(4) : all.slice(0, 4);
      send(
        res,
        200,
        complete(id, {
          tools: page,
          ...(cursor === "page-2" ? {} : { nextCursor: "page-2" }),
          // A personalized list that nonetheless claims to be cacheable: the
          // client must keep it to this principal regardless.
          ttlMs: 60_000,
          cacheScope: "public",
        }),
      );
      return;
    }

    case "resources/list":
      send(res, 200, complete(id, { resources: resourcesFor(token), ...CACHE_PRIVATE }));
      return;

    case "resources/templates/list":
      send(
        res,
        200,
        complete(id, {
          resourceTemplates: [{ uriTemplate: "note:///{name}", name: "notes" }],
          ...CACHE_PUBLIC,
        }),
      );
      return;

    case "resources/read": {
      const uri = String(params.uri ?? "");
      const known = resourcesFor(token).some((resource) => resource.uri === uri);
      if (!known) {
        send(res, 200, jsonError(-32602, "Resource not found", { uri }, id));
        return;
      }
      send(
        res,
        200,
        complete(id, {
          contents: [{ uri, mimeType: "text/plain", text: `contents of ${uri}` }],
          ...CACHE_PRIVATE,
        }),
      );
      return;
    }

    case "prompts/list":
      send(
        res,
        200,
        complete(id, {
          prompts: [
            {
              name: "summarize",
              description: "Summarize a note",
              arguments: [{ name: "note", required: true }],
            },
          ],
          ...CACHE_PUBLIC,
        }),
      );
      return;

    case "prompts/get": {
      if (params.name !== "summarize") {
        send(res, 200, jsonError(-32602, "Unknown prompt", undefined, id));
        return;
      }
      const args = (params.arguments ?? {}) as Record<string, unknown>;
      send(
        res,
        200,
        complete(id, {
          description: "Summarize a note",
          messages: [
            { role: "user", content: { type: "text", text: `Summarize ${String(args.note ?? "")}` } },
          ],
        }),
      );
      return;
    }

    case "subscriptions/listen": {
      const stream = sse(res);
      const filter = (params.notifications ?? {}) as Record<string, unknown>;
      stream.write({
        jsonrpc: "2.0",
        method: "notifications/subscriptions/acknowledged",
        params: { _meta: { [META_SUBSCRIPTION]: id }, notifications: filter },
      });
      stream.comment();
      setTimeout(() => {
        stream.write({
          jsonrpc: "2.0",
          method: "notifications/tools/list_changed",
          params: { _meta: { [META_SUBSCRIPTION]: id } },
        });
      }, 10);
      setTimeout(() => {
        stream.write({ jsonrpc: "2.0", id, result: { resultType: "complete", _meta: { [META_SUBSCRIPTION]: id } } });
        stream.end();
      }, 40);
      return;
    }

    case "tools/call": {
      state.toolCalls++;
      const name = String(params.name ?? "");
      const args = (params.arguments ?? {}) as Record<string, unknown>;
      const inputResponses = params.inputResponses as Record<string, unknown> | undefined;
      const requestState = params.requestState;

      if (name === "regional_query") {
        const supplied = headers["mcp-param-region"];
        if (supplied === undefined || decodeHeaderValue(supplied) !== String(args.region ?? "")) {
          send(res, 400, jsonError(-32020, "Header mismatch: Mcp-Param-Region", undefined, id));
          return;
        }
        send(res, 200, complete(id, { content: [{ type: "text", text: `queried ${String(args.region)}` }] }));
        return;
      }

      if (name === "needs_sampling") {
        send(
          res,
          200,
          {
            jsonrpc: "2.0",
            id,
            result: {
              resultType: "input_required",
              inputRequests: {
                writer: {
                  method: "sampling/createMessage",
                  params: {
                    messages: [{ role: "user", content: { type: "text", text: "Write a note" } }],
                    maxTokens: 100,
                  },
                },
              },
              requestState: "sampling-state",
            },
          },
        );
        return;
      }

      if (name === "needs_input") {
        if (!inputResponses) {
          send(
            res,
            200,
            {
              jsonrpc: "2.0",
              id,
              result: {
                resultType: "input_required",
                inputRequests: {
                  github_login: {
                    method: "elicitation/create",
                    params: {
                      mode: "form",
                      message: "Please provide your GitHub username",
                      requestedSchema: {
                        type: "object",
                        properties: { name: { type: "string" }, remember: { type: "boolean" } },
                        required: ["name"],
                      },
                    },
                  },
                },
                requestState: Buffer.from(JSON.stringify({ repo: args.repo ?? null })).toString("base64"),
              },
            },
          );
          return;
        }
        state.inputsSeen.push({ inputResponses, requestState });
        const answer = (inputResponses.github_login ?? {}) as { action?: string; content?: Record<string, unknown> };
        if (answer.action !== "accept") {
          send(res, 200, complete(id, { content: [{ type: "text", text: "declined" }], isError: true }));
          return;
        }
        // The result deliberately does not echo what the person typed.
        send(
          res,
          200,
          complete(id, {
            content: [{ type: "text", text: "linked" }],
            structuredContent: { linked: true, nameLength: String(answer.content?.name ?? "").length },
          }),
        );
        return;
      }

      if (name === "create_note" || name === "slow") {
        state.effects.push({ tool: name, at: Date.now(), arguments: args });
        if (state.mode === "drop-write-response" || name === "slow") {
          // The effect has happened; the answer never arrives. For "slow" the
          // socket stays open so the client's own deadline or cancellation
          // decides, which is the cancellation case.
          const stream = sse(res);
          stream.write({
            jsonrpc: "2.0",
            method: "notifications/progress",
            params: { progressToken: "p", progress: 1 },
          });
          if (name !== "slow") setTimeout(() => res.destroy(), 10);
          return;
        }
        send(res, 200, complete(id, { content: [{ type: "text", text: "created" }] }));
        return;
      }

      if (name === "echo" || name === "suggests_headers") {
        send(res, 200, complete(id, { content: [{ type: "text", text: String(args.text ?? "") }] }));
        return;
      }
      if (name.startsWith("greet_")) {
        send(res, 200, complete(id, { content: [{ type: "text", text: `hello ${name.slice(6)}` }] }));
        return;
      }
      send(res, 200, jsonError(-32602, `Unknown tool: ${name}`, undefined, id));
      return;
    }

    default:
      send(res, 404, jsonError(-32601, `Method not found: ${message.method}`, undefined, id));
      return;
  }
});

server.listen(0, "127.0.0.1");
await once(server, "listening");
origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
process.stdout.write(`${JSON.stringify({ ready: true, origin })}\n`);
process.on("SIGTERM", () => {
  server.closeAllConnections();
  server.close(() => process.exit(0));
});
