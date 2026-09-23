import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import { once } from "node:events";
import type { AddressInfo } from "node:net";

/*
 * A loopback HTTP fixture that records exactly what it received. Provider
 * doubles built on it assert methods, paths, query strings, headers and raw
 * bodies against the documented upstream contract, independently of the
 * adapter under test. It listens on an ephemeral port and only on 127.0.0.1.
 */

export type RecordedRequest = {
  method: string;
  url: URL;
  headers: Record<string, string>;
  body: Buffer;
  at: number;
};

export type FixtureReply = {
  status?: number;
  headers?: Record<string, string>;
  body?: string | Uint8Array | Record<string, unknown> | unknown[];
};

export type FixtureHandler = (
  request: RecordedRequest,
  raw: { req: IncomingMessage; res: ServerResponse },
) => FixtureReply | Promise<FixtureReply | undefined> | undefined;

export async function startHttpFixture(handler: FixtureHandler) {
  const requests: RecordedRequest[] = [];
  let origin = "";
  const server = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(Buffer.from(chunk));
    const headers: Record<string, string> = {};
    for (const [name, value] of Object.entries(req.headers))
      if (typeof value === "string") headers[name] = value;
      else if (Array.isArray(value)) headers[name] = value.join(", ");
    const recorded: RecordedRequest = {
      method: req.method ?? "GET",
      url: new URL(req.url ?? "/", origin),
      headers,
      body: Buffer.concat(chunks),
      at: Date.now(),
    };
    requests.push(recorded);
    try {
      const reply: FixtureReply = (await handler(recorded, { req, res })) ?? {
        status: 404,
        body: { error: "not_found" },
      };
      if (res.writableEnded) return;
      const body =
        reply.body === undefined
          ? undefined
          : typeof reply.body === "string" || reply.body instanceof Uint8Array
            ? reply.body
            : JSON.stringify(reply.body);
      const contentType =
        reply.headers?.["content-type"] ??
        (typeof reply.body === "object" && !(reply.body instanceof Uint8Array)
          ? "application/json"
          : "text/plain; charset=utf-8");
      res.writeHead(reply.status ?? 200, {
        ...(body === undefined ? {} : { "content-type": contentType }),
        ...reply.headers,
      });
      res.end(body);
    } catch {
      if (!res.writableEnded) {
        res.writeHead(500, { "content-type": "application/json" });
        res.end('{"error":"fixture_failure"}');
      }
    }
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return {
    origin,
    requests,
    /** Requests matching a method and path, in arrival order. */
    received(method: string, path: string) {
      return requests.filter(
        (request) => request.method === method && request.url.pathname === path,
      );
    },
    async close() {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
