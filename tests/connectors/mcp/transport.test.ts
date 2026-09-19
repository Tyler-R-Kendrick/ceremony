import assert from "node:assert/strict";
import { test } from "node:test";
import { createServer, type ServerResponse } from "node:http";
import { once } from "node:events";
import type { AddressInfo } from "node:net";
import {
  createMcpClient,
  resolveLimits,
} from "../../../src/server/connectors/mcp/index.js";
import { exchange } from "../../../src/server/connectors/mcp/http.js";

/*
 * The HTTP leg on its own: what happens to a response body the client decided
 * about without reading.
 *
 * An error status answers the request by itself, so the frames are never
 * consumed -- and a `text/event-stream` body that is neither read nor cancelled
 * holds its socket open for as long as the server keeps writing to it. Nothing
 * else releases it: there is no owner but the caller that was handed it, and
 * every attempt is handed its own.
 *
 * These tests run the real client over a real loopback hop and ask the server
 * whether the connection went away, because that is the only place the leak is
 * observable; the boundary test at the end pins the release itself.
 */

type OpenStream = {
  method: string;
  status: number;
  /** Set when the socket for this reply closed, which is the client letting go. */
  closed: boolean;
};

/**
 * A server that answers with an event stream it never finishes. `reply` picks
 * the status per request; returning undefined answers as ordinary JSON instead,
 * which is how the legacy handshake gets far enough to reach the GET.
 */
async function startOpenStreamServer(
  reply: (request: {
    method: string;
    body: unknown;
  }) => number | { json: unknown; status?: number },
) {
  const streams: OpenStream[] = [];
  const timers = new Set<NodeJS.Timeout>();
  const server = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(Buffer.from(chunk));
    const raw = Buffer.concat(chunks).toString("utf8");
    const decided = reply({
      method: req.method ?? "GET",
      body: raw.length ? JSON.parse(raw) : undefined,
    });
    if (typeof decided !== "number") {
      const body =
        decided.json === undefined ? undefined : JSON.stringify(decided.json);
      res.writeHead(decided.status ?? 200, {
        ...(body === undefined
          ? {}
          : {
              "content-type": "application/json",
              "content-length": Buffer.byteLength(body),
            }),
      });
      res.end(body);
      return;
    }
    const record: OpenStream = {
      method: req.method ?? "GET",
      status: decided,
      closed: false,
    };
    streams.push(record);
    // An error status on an event stream: allowed, and the shape that leaks.
    res.writeHead(decided, {
      "content-type": "text/event-stream",
      "cache-control": "no-store",
      connection: "keep-alive",
    });
    keepOpen(res, record, timers);
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return {
    origin,
    endpoint: `${origin}/mcp`,
    streams,
    async close() {
      for (const timer of timers) clearInterval(timer);
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

/**
 * Keeps writing comments so the reply stays unfinished. A client that walks
 * away without cancelling leaves this running against a live socket, and the
 * server therefore learns the moment the body is released.
 */
function keepOpen(
  res: ServerResponse,
  record: OpenStream,
  timers: Set<NodeJS.Timeout>,
): void {
  res.write(":\n\n");
  const timer = setInterval(() => res.write(":\n\n"), 20);
  timers.add(timer);
  // Writing to a socket the client just destroyed is expected here.
  res.on("error", () => {});
  res.on("close", () => {
    record.closed = true;
    clearInterval(timer);
    timers.delete(timer);
  });
}

/** Waits briefly for something the other end of a socket decides. */
async function eventually(
  condition: () => boolean,
  budgetMs = 2000,
): Promise<boolean> {
  const deadline = Date.now() + budgetMs;
  while (!condition() && Date.now() < deadline)
    await new Promise((resolve) => setTimeout(resolve, 10));
  return condition();
}

test("an error status on an event stream releases the body it never read", async (t) => {
  const server = await startOpenStreamServer(() => 400);
  t.after(() => server.close());
  const client = createMcpClient({
    profile: "2026-07-28",
    endpoint: server.endpoint,
    fetch: globalThis.fetch,
    auth: { kind: "none" },
    // Generously long, so nothing here is decided by a timeout aborting the
    // request: the only thing that can close this socket is the client.
    limits: { requestTimeoutMs: 30_000, readRetries: 0 },
  });
  await assert.rejects(client.listTools());
  assert.equal(server.streams.length, 1, "one reply was served");
  assert.equal(server.streams[0]!.status, 400);
  assert.ok(
    await eventually(() => server.streams[0]!.closed),
    "the server saw the event stream released, rather than left open",
  );
});

test("every failing read releases its own stream, not only the first", async (t) => {
  // Each attempt is handed its own body, so releasing one is not releasing the
  // rest: a client that fails repeatedly against the same server is how one
  // leak becomes a socket per attempt.
  const server = await startOpenStreamServer(() => 400);
  t.after(() => server.close());
  const client = createMcpClient({
    profile: "2026-07-28",
    endpoint: server.endpoint,
    fetch: globalThis.fetch,
    auth: { kind: "none" },
    limits: { requestTimeoutMs: 30_000, readRetries: 0 },
  });
  await assert.rejects(client.listTools());
  await assert.rejects(client.listTools());
  assert.equal(server.streams.length, 2);
  assert.ok(
    await eventually(() => server.streams.every((stream) => stream.closed)),
    "no attempt leaves its body behind",
  );
});

test("a 405 to the legacy GET stream is answered by the status and the body let go", async (t) => {
  // The standalone GET is how a legacy server pushes notifications, and 405 is
  // the documented way of saying it does not offer one. That decides the call
  // on its own -- but the server may still have said it as an event stream.
  const server = await startOpenStreamServer((request) => {
    if (request.method === "GET") return 405;
    const body = request.body as { id?: unknown; method?: string } | undefined;
    if (body?.method === "initialize")
      return {
        json: {
          jsonrpc: "2.0",
          id: body.id,
          result: {
            protocolVersion: "2025-11-25",
            capabilities: { tools: {} },
            serverInfo: { name: "open-stream", version: "1.0.0" },
          },
        },
      };
    // The initialized notification; 202 is the documented acknowledgement.
    return { json: undefined, status: 202 };
  });
  t.after(() => server.close());
  const client = createMcpClient({
    profile: "2025-11-25",
    endpoint: server.endpoint,
    fetch: globalThis.fetch,
    auth: { kind: "none" },
    limits: { requestTimeoutMs: 30_000, listenMaxMs: 30_000 },
  });
  const result = await client.listen({
    filter: { toolsListChanged: true },
    maxEvents: 1,
  });
  assert.equal(result.supported, false);
  assert.equal(result.closedBy, "unsupported");
  assert.equal(server.streams.length, 1, "only the GET was an event stream");
  assert.equal(server.streams[0]!.method, "GET");
  assert.ok(
    await eventually(() => server.streams[0]!.closed),
    "the stream the client refused to read was released",
  );
});

test("a stream reply can be released without reading a frame, more than once", async () => {
  // The boundary itself, away from any socket: `cancel` releases the body, and
  // a caller that has already read or already cancelled is not punished for
  // saying so again, because the point was only to let go of it.
  let cancelled = 0;
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(":\n\n"));
    },
    cancel() {
      cancelled++;
    },
  });
  const reply = await exchange(
    async () =>
      new Response(body, {
        status: 500,
        headers: { "content-type": "text/event-stream" },
      }),
    {
      url: new URL("http://127.0.0.1/mcp"),
      method: "POST",
      headers: {},
      timeoutMs: 5_000,
    },
    resolveLimits(),
  );
  assert.equal(reply.kind, "stream");
  if (reply.kind !== "stream") return;
  assert.equal(cancelled, 0, "nothing is released until the caller says so");
  await reply.cancel();
  assert.equal(cancelled, 1);
  await reply.cancel();
  assert.equal(
    cancelled,
    1,
    "releasing an already-released body is not a fault",
  );
});

test("a retried status releases every attempt's body, and so does a challenge", async (t) => {
  // These are the statuses the release originally missed. `rpc` answers 429,
  // 5xx and 401/403 from the status alone, before `singleMessage` is reached,
  // so a release that lived only in `singleMessage` never ran for exactly the
  // statuses that retry -- one abandoned socket per attempt, which is the case
  // the release was added for in the first place.
  for (const status of [429, 503]) {
    const server = await startOpenStreamServer(() => status);
    t.after(() => server.close());
    const client = createMcpClient({
      profile: "2026-07-28",
      endpoint: server.endpoint,
      fetch: globalThis.fetch,
      auth: { kind: "none" },
      limits: { requestTimeoutMs: 30_000, readRetries: 1 },
    });
    await assert.rejects(client.listTools());
    assert.ok(
      server.streams.length > 1,
      `${status} was retried, so there is more than one body to release`,
    );
    assert.ok(
      await eventually(() => server.streams.every((stream) => stream.closed)),
      `every ${status} attempt released its own body`,
    );
  }
  // A challenge is answered from the headers, so the frames are never read.
  const challenged = await startOpenStreamServer(() => 401);
  t.after(() => challenged.close());
  const client = createMcpClient({
    profile: "2026-07-28",
    endpoint: challenged.endpoint,
    fetch: globalThis.fetch,
    auth: { kind: "none" },
    limits: { requestTimeoutMs: 30_000, readRetries: 0 },
  });
  await client.listTools().catch(() => undefined);
  // Only the client's own POST is in scope. Resolving the challenge also probes
  // this origin for OAuth metadata, and those GETs are answered by the same
  // catch-all fixture with an endless event stream, which no authorization
  // server would do; they travel a different path and are not what is pinned
  // here.
  const posted = challenged.streams.filter(
    (stream) => stream.method === "POST",
  );
  assert.ok(posted.length >= 1, "the challenged request was a POST");
  assert.ok(
    await eventually(() => posted.every((stream) => stream.closed)),
    `the body behind an authorization challenge is released: ${JSON.stringify(challenged.streams)}`,
  );
});
