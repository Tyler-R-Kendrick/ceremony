import { createServer, type Server } from "node:http";
import { once } from "node:events";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import type { AddressInfo } from "node:net";
import { build } from "esbuild";
import { createConnectorFixture, type FixtureOptions } from "./fixture.js";

/*
 * The browser harness, served from its own loopback origin.
 *
 * It bundles the real components and the real page composition and serves the
 * documented route table from the same fixture the node tests use, so a
 * browser test exercises the shipped code without the reference application,
 * its database or the shared development port. A second origin is started
 * beside it for one purpose: to prove that a completion message from somewhere
 * else changes nothing.
 */

const harnessEntry = fileURLToPath(
  new URL("../../browser/connector-harness.tsx", import.meta.url),
);

async function bundle() {
  const result = await build({
    entryPoints: [harnessEntry],
    bundle: true,
    write: false,
    format: "esm",
    platform: "browser",
    target: "es2022",
    jsx: "automatic",
    outdir: "/harness",
    define: { "process.env.NODE_ENV": '"production"' },
    logLevel: "silent",
  });
  const script = result.outputFiles.find((file) => file.path.endsWith(".js"));
  const styles = result.outputFiles.find((file) => file.path.endsWith(".css"));
  if (!script) throw new Error("The harness bundle produced no script");
  return { script: script.text, styles: styles?.text ?? "" };
}

const page = (body: string, head = "") => `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Connector harness</title>${head}</head><body>${body}</body></html>`;

export type Harness = Awaited<ReturnType<typeof startConnectorHarness>>;

export async function startConnectorHarness(options: FixtureOptions = {}) {
  const assets = await bundle();
  const listen = async (server: Server) => {
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  };
  // The other origin. It serves one page, whose only job is to post a
  // well-formed completion message at a window that did not open it.
  const strangerServer = createServer((request, response) => {
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    const connection = url.searchParams.get("connection") ?? "";
    response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    response.end(
      page(
        `<h1>Another origin</h1><p id="posted">posting…</p>
<script type="module">
  const message = {
    type: "ceremony:connector-handoff",
    connectionRef: ${JSON.stringify(connection)},
  };
  try { opener.postMessage(message, "*"); } catch {}
  document.getElementById("posted").textContent = "posted";
</script>`,
      ),
    );
  });
  const strangerOrigin = await listen(strangerServer);

  let fixture = createConnectorFixture({ ...options, origin: "" });
  const server = createServer(async (request, response) => {
    const origin = `http://${request.headers.host}`;
    const url = new URL(request.url ?? "/", origin);
    const send = (
      status: number,
      type: string,
      body: string,
      headers: Record<string, string> = {},
    ) => {
      response.writeHead(status, {
        "content-type": type,
        "cache-control": "no-store",
        ...headers,
      });
      response.end(body);
    };
    if (url.pathname === "/harness.js")
      return send(200, "text/javascript; charset=utf-8", assets.script);
    if (url.pathname === "/harness.css")
      return send(200, "text/css; charset=utf-8", assets.styles);
    if (url.pathname === "/connectors.css")
      return send(
        200,
        "text/css; charset=utf-8",
        await readFile(
          fileURLToPath(
            new URL("../../../src/react/connectors.css", import.meta.url),
          ),
          "utf8",
        ),
      );
    if (url.pathname.startsWith("/api/v1/connectors")) {
      const body =
        request.method === "POST"
          ? await new Promise<string>((resolve) => {
              const chunks: Buffer[] = [];
              request.on("data", (chunk: Buffer) => chunks.push(chunk));
              request.on("end", () =>
                resolve(Buffer.concat(chunks).toString()),
              );
            })
          : undefined;
      const result = await fixture.handle(
        new Request(new URL(url.pathname + url.search, origin), {
          method: request.method ?? "GET",
          headers: { "content-type": "application/json" },
          ...(body ? { body } : {}),
        }),
      );
      return send(result.status, "application/json", await result.text());
    }
    // The provider's own page. Approving is a navigation, exactly as it is at
    // a real provider; closing the window is not.
    if (url.pathname === "/authorize") {
      const connection = url.searchParams.get("connection") ?? "";
      return send(
        200,
        "text/html; charset=utf-8",
        page(`<h1>Fixture provider</h1>
<p>Approve the fixture app for this connection.</p>
<a id="approve" href="/provider/approve?connection=${encodeURIComponent(connection)}">Approve fixture app</a>
<button id="abandon" onclick="window.close()">Close without approving</button>`),
      );
    }
    if (url.pathname === "/provider/approve") {
      const connection = url.searchParams.get("connection") ?? "";
      fixture.approve(connection);
      response.writeHead(303, {
        location: `/callback?connector=github-app&connection=${encodeURIComponent(connection)}&outcome=handoff.completed`,
        "cache-control": "no-store",
      });
      return response.end();
    }
    if (url.pathname === "/callback" || url.pathname === "/")
      return send(
        200,
        "text/html; charset=utf-8",
        page(
          '<div id="root"></div><script type="module" src="/harness.js"></script>',
          '<link rel="stylesheet" href="/connectors.css"><link rel="stylesheet" href="/harness.css">',
        ),
      );
    return send(404, "text/plain; charset=utf-8", "not found");
  });
  const origin = await listen(server);
  fixture = createConnectorFixture({ ...options, origin });

  return {
    origin,
    strangerOrigin,
    get fixture() {
      return fixture;
    },
    /** The URL a test opens, with the harness switches it needs. */
    url(params: Record<string, string> = {}) {
      const query = new URLSearchParams({ poll: "80", ...params });
      return `${origin}/?${query.toString()}`;
    },
    strangerUrl(connectionRef: string) {
      return `${strangerOrigin}/?connection=${encodeURIComponent(connectionRef)}`;
    },
    async close() {
      for (const instance of [server, strangerServer]) {
        instance.closeAllConnections();
        await new Promise<void>((resolve) => instance.close(() => resolve()));
      }
    },
  };
}
