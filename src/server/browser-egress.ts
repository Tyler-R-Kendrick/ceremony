import { createServer } from "node:http";
import { connect, isIP, type AddressInfo, type Socket } from "node:net";
import {
  createPublicAuthLookup,
  isPublicAuthAddress,
  type PublicAuthNetworkOptions,
} from "./public-auth-fetch.js";

/** CONNECT only: Chromium retains end-to-end TLS and validates provider certificates. */
export async function createBrowserEgressProxy(
  options: PublicAuthNetworkOptions = {},
) {
  const lookup = createPublicAuthLookup(options);
  const sockets = new Set<Socket>();
  const track = (socket: Socket) => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
    return socket;
  };
  const server = createServer((_request, response) => {
    // Production browser ceremonies use HTTPS. Never forward arbitrary HTTP requests.
    response.writeHead(403, { connection: "close" });
    response.end();
  });
  server.on("connection", track);
  server.on("connect", (request, client, head) => {
    let target: URL;
    try {
      if (!/^(?:\[[0-9a-f:.]+\]|[a-z0-9.-]+):\d{1,5}$/i.test(request.url ?? ""))
        throw new Error("invalid target");
      target = new URL(`https://${request.url}`);
      const host = target.hostname.replace(/^\[|\]$/g, "");
      if (
        isIP(host) &&
        !isPublicAuthAddress(host) &&
        !(options.allowLoopbackHttp && ["127.0.0.1", "::1"].includes(host))
      )
        throw new Error("nonpublic target");
      const upstream = track(
        connect({
          host,
          port: Number(target.port || 443),
          lookup,
          autoSelectFamily: true,
        }),
      );
      // Bound connection setup; established TLS tunnels live until the browser closes.
      upstream.setTimeout(10_000, () => upstream.destroy());
      client.once("close", () => upstream.destroy());
      client.once("error", () => upstream.destroy());
      upstream.once("error", () => client.destroy());
      upstream.once("close", () => {
        if (!upstream.readableEnded) client.destroy();
      });
      upstream.once("connect", () => {
        upstream.setTimeout(0);
        client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
        if (head.length) upstream.write(head);
        client.pipe(upstream);
        upstream.pipe(client);
      });
    } catch {
      client.end("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n");
    }
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  return {
    server: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    async close() {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
