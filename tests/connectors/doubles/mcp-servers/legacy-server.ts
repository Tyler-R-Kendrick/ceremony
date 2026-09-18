import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { once } from "node:events";
import { randomUUID } from "node:crypto";
import type { AddressInfo } from "node:net";
import { z } from "zod";
import {
  McpServer,
  WebStandardStreamableHTTPServerTransport,
} from "@modelcontextprotocol/server";

/*
 * A legacy-profile MCP server built with the deployed SDK
 * (`@modelcontextprotocol/server` v2), which speaks the initialization-based
 * revisions up to 2025-11-25. It is the "already deployed provider" side of
 * the compatibility story: the handshake, the `Mcp-Session-Id` session, the
 * SSE response stream and server-initiated requests (elicitation, sampling,
 * roots) all come from the SDK, not from anything under test.
 *
 * The thin wrapper around it does three things the SDK leaves to a
 * deployment: it requires a bearer and answers RFC 9728 metadata, it records
 * the wire, and it can drop a response mid-write on request.
 */

type Wire = {
  at: number;
  method: string;
  path: string;
  headers: Record<string, string>;
  body?: unknown;
};

const TOKEN = process.env.FIXTURE_TOKEN ?? "legacy-token";
const SECOND_TOKEN = process.env.FIXTURE_TOKEN_B ?? "legacy-token-b";

const state = {
  mode: "normal" as "normal" | "bad-metadata" | "no-metadata",
  wire: [] as Wire[],
  effects: [] as Array<{ tool: string; at: number; arguments: unknown }>,
  elicitations: [] as unknown[],
  toolCalls: 0,
};

let origin = "";

type Entry = { transport: WebStandardStreamableHTTPServerTransport; server: McpServer };
const sessions = new Map<string, Entry>();

function buildServer(token: string): McpServer {
  const who = token === SECOND_TOKEN ? "beatrix" : "ada";
  const server = new McpServer({ name: "fixture-legacy", version: "1.0.0" });

  server.registerTool(
    "echo",
    { description: "Returns what it was given.", inputSchema: { text: z.string() } },
    async (args) => ({ content: [{ type: "text", text: args.text }] }),
  );

  server.registerTool(
    `greet_${who}`,
    { description: `Personalized for ${who}.`, inputSchema: {} },
    async () => ({ content: [{ type: "text", text: `hello ${who}` }] }),
  );

  server.registerTool(
    "create_note",
    { description: "Creates a note. Consequential.", inputSchema: { title: z.string() } },
    async (args) => {
      state.effects.push({ tool: "create_note", at: Date.now(), arguments: args });
      return { content: [{ type: "text", text: "created" }] };
    },
  );

  server.registerTool(
    "slow_note",
    { description: "Consequential and slow.", inputSchema: {} },
    async () => {
      state.effects.push({ tool: "slow_note", at: Date.now(), arguments: {} });
      await new Promise((resolve) => setTimeout(resolve, 5000));
      return { content: [{ type: "text", text: "eventually" }] };
    },
  );

  server.registerTool(
    "ask_login",
    { description: "Asks the person for a username first.", inputSchema: { repo: z.string().optional() } },
    async (_args, ctx) => {
      // The generic server-to-client request channel of this revision; the
      // SDK's `elicitInput` sugar is era-gated, this is the wire itself.
      const answer = (await ctx.mcpReq.send({
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
      })) as { action: string; content?: Record<string, unknown> };
      state.elicitations.push(answer);
      if (answer.action !== "accept")
        return { content: [{ type: "text", text: "declined" }], isError: true };
      const name = String((answer.content as Record<string, unknown> | undefined)?.name ?? "");
      return {
        content: [{ type: "text", text: "linked" }],
        structuredContent: { linked: true, nameLength: name.length },
      };
    },
  );

  server.registerTool(
    "probe_roots",
    { description: "Asks the client for filesystem roots.", inputSchema: {} },
    async (_args, ctx) => {
      const roots = (await ctx.mcpReq.send({ method: "roots/list" })) as { roots?: unknown[] };
      return {
        content: [{ type: "text", text: JSON.stringify({ rootCount: roots.roots?.length ?? -1 }) }],
        structuredContent: { rootCount: roots.roots?.length ?? -1, roots: roots.roots ?? [] },
      };
    },
  );

  server.registerTool(
    "probe_sampling",
    { description: "Asks the client to run a model.", inputSchema: {} },
    async (_args, ctx) => {
      try {
        await ctx.mcpReq.send({
          method: "sampling/createMessage",
          params: {
            messages: [{ role: "user", content: { type: "text", text: "hi" } }],
            maxTokens: 10,
          },
        });
        return { content: [{ type: "text", text: "sampled" }] };
      } catch {
        return { content: [{ type: "text", text: "client refused sampling" }], isError: true };
      }
    },
  );

  server.registerResource(
    "shared",
    "note:///shared",
    { mimeType: "text/plain" },
    async (uri) => ({ contents: [{ uri: uri.href, mimeType: "text/plain", text: "contents of note:///shared" }] }),
  );
  server.registerResource(
    `${who}-private`,
    `note:///${who}/private`,
    { mimeType: "text/plain" },
    async (uri) => ({ contents: [{ uri: uri.href, mimeType: "text/plain", text: `contents of ${uri.href}` }] }),
  );

  server.registerPrompt(
    "summarize",
    { description: "Summarize a note", argsSchema: { note: z.string() } },
    async (args) => ({
      description: "Summarize a note",
      messages: [{ role: "user", content: { type: "text", text: `Summarize ${args.note}` } }],
    }),
  );

  return server;
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

function sendJson(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}) {
  res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store", ...headers });
  res.end(JSON.stringify(body));
}

async function writeWebResponse(res: ServerResponse, response: Response): Promise<void> {
  const headers: Record<string, string> = {};
  response.headers.forEach((value, name) => {
    headers[name] = value;
  });
  res.writeHead(response.status, headers);
  if (!response.body) {
    res.end();
    return;
  }
  const reader = response.body.getReader();
  let closed = false;
  res.on("close", () => {
    closed = true;
    void reader.cancel().catch(() => undefined);
  });
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done || closed) break;
      res.write(Buffer.from(value));
    }
  } catch {
    // The client went away mid-stream; nothing more to send.
  }
  if (!closed) res.end();
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", origin || "http://127.0.0.1");
  const headers: Record<string, string> = {};
  for (const [name, value] of Object.entries(req.headers))
    if (typeof value === "string") headers[name] = value;

  if (url.pathname === "/__wire" && req.method === "GET") {
    sendJson(res, 200, {
      wire: state.wire,
      effects: state.effects,
      elicitations: state.elicitations,
      toolCalls: state.toolCalls,
      sessions: [...sessions.keys()].length,
      mode: state.mode,
    });
    return;
  }
  if (url.pathname === "/__control" && req.method === "POST") {
    const body = JSON.parse((await readBody(req)).toString("utf8") || "{}");
    if (typeof body.mode === "string") state.mode = body.mode;
    if (body.reset === true) {
      state.wire = [];
      state.effects = [];
      state.elicitations = [];
      state.toolCalls = 0;
    }
    sendJson(res, 200, { ok: true, mode: state.mode });
    return;
  }

  const raw = await readBody(req);
  let parsed: unknown;
  try {
    parsed = raw.length ? JSON.parse(raw.toString("utf8")) : undefined;
  } catch {
    parsed = undefined;
  }
  state.wire.push({
    at: Date.now(),
    method: req.method ?? "GET",
    path: url.pathname,
    headers,
    ...(parsed === undefined ? {} : { body: parsed }),
  });

  if (url.pathname.startsWith("/.well-known/oauth-protected-resource")) {
    if (state.mode === "no-metadata") {
      sendJson(res, 404, { error: "not_found" });
      return;
    }
    sendJson(res, 200, {
      resource: state.mode === "bad-metadata" ? "https://elsewhere.example/mcp" : `${origin}/mcp`,
      authorization_servers: [`${origin}/authorization`],
      scopes_supported: ["mcp:tools"],
      bearer_methods_supported: ["header"],
    });
    return;
  }

  if (url.pathname !== "/mcp") {
    sendJson(res, 404, { error: "not_found" });
    return;
  }

  const token = /^Bearer (\S+)$/.exec(headers.authorization ?? "")?.[1];
  if (!token || (token !== TOKEN && token !== SECOND_TOKEN)) {
    sendJson(res, 401, { jsonrpc: "2.0", id: null, error: { code: -32001, message: "Unauthorized" } }, {
      "www-authenticate": `Bearer resource_metadata="${origin}/.well-known/oauth-protected-resource/mcp", scope="mcp:tools"`,
    });
    return;
  }

  const call = parsed as { method?: unknown; params?: { name?: unknown } } | undefined;
  if (call?.method === "tools/call") state.toolCalls++;
  // A consequential call whose response never arrives: the work happens and
  // the socket dies before the result is written.
  if (call?.method === "tools/call" && call.params?.name === "drop_note") {
    state.effects.push({ tool: "drop_note", at: Date.now(), arguments: call.params });
    res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-store" });
    res.write(`data: ${JSON.stringify({ jsonrpc: "2.0", method: "notifications/progress", params: { progressToken: "p", progress: 1 } })}\n\n`);
    setTimeout(() => res.destroy(), 10);
    return;
  }

  const request = new Request(`${origin}${req.url ?? "/mcp"}`, {
    method: req.method ?? "GET",
    headers,
    ...(raw.length && req.method !== "GET" && req.method !== "HEAD" ? { body: raw } : {}),
  });

  const sessionId = headers["mcp-session-id"];
  const existing = sessionId ? sessions.get(sessionId) : undefined;
  if (existing) {
    await writeWebResponse(res, await existing.transport.handleRequest(request));
    return;
  }
  if (sessionId) {
    // The session is gone: the revision says a 404 tells the client to start a new one.
    sendJson(res, 404, { jsonrpc: "2.0", id: null, error: { code: -32001, message: "Session not found" } });
    return;
  }

  const holder: { entry?: Entry } = {};
  const transport = new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: () => randomUUID(),
    onsessioninitialized: (id) => {
      if (holder.entry) sessions.set(id, holder.entry);
    },
    onsessionclosed: (id) => {
      sessions.delete(id);
    },
  });
  const mcp = buildServer(token);
  holder.entry = { transport, server: mcp };
  await mcp.connect(transport);
  await writeWebResponse(res, await transport.handleRequest(request));
});

server.listen(0, "127.0.0.1");
await once(server, "listening");
origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
process.stdout.write(`${JSON.stringify({ ready: true, origin })}\n`);
process.on("SIGTERM", () => {
  server.closeAllConnections();
  server.close(() => process.exit(0));
});
