import assert from "node:assert/strict";
import { createServer } from "node:http";
import {
  connect,
  createServer as createTcpServer,
  type AddressInfo,
} from "node:net";
import { test } from "node:test";
import type { Browser } from "playwright-core";
import { createAuthorizationBrowser } from "../src/server/browser-executor.js";
import { chromium } from "../src/server/playwright.js";
import { createBrowserEgressProxy } from "../src/server/browser-egress.js";

for (const scheme of ["http", "https"])
  test(`default isolated Chromium cannot reach an allowlisted ${scheme} loopback provider`, async (t) => {
    let proxy = "";
    const launch = chromium.launch.bind(chromium);
    t.mock.method(
      chromium,
      "launch",
      async (options: Parameters<typeof chromium.launch>[0]) => {
        proxy = options!.proxy!.server;
        return launch(options);
      },
    );
    let requests = 0;
    const server = createServer((_request, response) => {
      response.end('<main data-authenticated="true">Fixture account</main>');
    });
    server.on("connection", () => requests++);
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve),
    );
    t.after(
      () => new Promise<void>((resolve) => server.close(() => resolve())),
    );
    const origin = `${scheme}://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const result = await createAuthorizationBrowser().complete({
      startUrl: `${origin}/private`,
      redirectUri: `${origin}/callback`,
      allowedOrigins: [origin],
      accountOnly: true,
      timeoutMs: 2_000,
    });
    assert.equal(requests, 0);
    assert.equal(result.status, "blocked");
    assert.match(proxy, /^http:\/\/127\.0\.0\.1:\d+$/);
    await assert.rejects(fetch(proxy, { signal: AbortSignal.timeout(1_000) }));
  });

async function tunnel(proxy: string, target: string, payload = "") {
  const url = new URL(proxy);
  return new Promise<string>((resolve, reject) => {
    const socket = connect({ host: url.hostname, port: Number(url.port) });
    let result = "";
    socket.setTimeout(1_000, () =>
      socket.destroy(new Error("fixture tunnel timeout")),
    );
    socket.on("error", reject);
    socket.on("connect", () =>
      socket.write(
        `CONNECT ${target} HTTP/1.1\r\nHost: ${target}\r\n\r\n${payload}`,
      ),
    );
    socket.on("data", (chunk) => {
      result += chunk.toString();
      if (
        result.includes("403") ||
        (result.includes("200 Connection Established") &&
          (!payload || result.endsWith(payload)))
      )
        socket.end();
    });
    socket.on("close", () => resolve(result));
  });
}

test("CONNECT proxy pins DNS, forwards opaque bytes and closes active tunnels", async (t) => {
  let connections = 0;
  const destination = createTcpServer((socket) => {
    connections++;
    socket.on("data", (bytes) => socket.write(bytes));
  });
  await new Promise<void>((resolve) =>
    destination.listen(0, "127.0.0.1", resolve),
  );
  t.after(
    () => new Promise<void>((resolve) => destination.close(() => resolve())),
  );
  let lookups = 0;
  const proxy = await createBrowserEgressProxy({
    allowLoopbackHttp: true,
    lookup: async () => {
      lookups++;
      return [
        { address: lookups === 1 ? "127.0.0.1" : "127.0.0.2", family: 4 },
      ];
    },
  });
  t.after(() => proxy.close());
  const port = (destination.address() as AddressInfo).port;
  assert.match(
    await tunnel(proxy.server, `localhost:${port}`, "opaque-tls-bytes"),
    /200 Connection Established\r\n\r\nopaque-tls-bytes$/,
  );
  assert.equal(lookups, 1);
  assert.equal(await tunnel(proxy.server, `localhost:${port}`), "");
  assert.equal(lookups, 2);
  assert.equal(connections, 1);
  assert.match(
    await tunnel(proxy.server, `127.0.0.1:${port}/bad`),
    /403 Forbidden/,
  );
  const rejected = await fetch(proxy.server);
  assert.equal(rejected.status, 403);
  await rejected.body?.cancel();
  const active = connect({
    host: "127.0.0.1",
    port: Number(new URL(proxy.server).port),
  });
  const connected = new Promise<void>((resolve, reject) => {
    active.once("error", reject);
    active.once("data", (bytes) => {
      if (bytes.toString().includes("200 Connection Established")) resolve();
      else reject(new Error("fixture tunnel was not established"));
    });
  });
  active.write(
    `CONNECT 127.0.0.1:${port} HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\n\r\n`,
  );
  await connected;
  const closed = new Promise<void>((resolve) =>
    active.once("close", () => resolve()),
  );
  let deadlineReached = false;
  const deadline = setTimeout(() => {
    deadlineReached = true;
    active.destroy();
  }, 1_000);
  await proxy.close();
  await closed;
  clearTimeout(deadline);
  assert.equal(deadlineReached, false);
  assert.equal(active.destroyed, true);
  await assert.rejects(tunnel(proxy.server, `localhost:${port}`));
});

for (const phase of ["launch", "vault", "context", "close"])
  test(`local egress proxy is closed after ${phase} failure`, async (t) => {
    let proxy = "";
    let launchOptions: Parameters<typeof chromium.launch>[0];
    let closes = 0;
    t.mock.method(
      chromium,
      "launch",
      async (options: Parameters<typeof chromium.launch>[0]) => {
        launchOptions = options;
        proxy = options!.proxy!.server;
        if (phase === "launch") throw new Error("injected launch failure");
        return {
          newContext: async () => {
            throw new Error("injected context failure");
          },
          close: async () => {
            closes++;
            if (phase === "close")
              throw new Error("injected browser close failure");
          },
        } as unknown as Browser;
      },
    );
    const result = await createAuthorizationBrowser().complete({
      startUrl: "https://provider.example",
      redirectUri: "https://ceremony.example/callback",
      allowedOrigins: ["https://provider.example"],
      ...(phase === "vault"
        ? {
            vault: {
              get: async () => {
                throw new Error("injected vault failure");
              },
              put: async () => {},
            },
          }
        : {}),
    });
    assert.equal(result.status, "blocked");
    assert.match(proxy, /^http:\/\/127\.0\.0\.1:\d+$/);
    assert.equal(launchOptions?.headless, true);
    assert.equal(launchOptions?.proxy?.bypass, "<-loopback>");
    assert.ok(launchOptions?.args?.includes("--disable-quic"));
    assert.ok(
      launchOptions?.args?.includes(
        "--force-webrtc-ip-handling-policy=disable_non_proxied_udp",
      ),
    );
    assert.equal(closes, phase === "launch" ? 0 : 1);
    await assert.rejects(fetch(proxy, { signal: AbortSignal.timeout(1_000) }));
  });

test("production proxy rejects numeric loopback and mapped IPv4 before connecting", async (t) => {
  const proxy = await createBrowserEgressProxy();
  t.after(() => proxy.close());
  for (const target of [
    "127.0.0.1:443",
    "[::1]:443",
    "[::ffff:127.0.0.1]:443",
    "localhost:0",
  ])
    assert.match(await tunnel(proxy.server, target), /403 Forbidden|^$/);
});

for (const remote of [
  { browserbase: { apiKey: "synthetic", projectId: "synthetic" } },
  { cloudflare: { apiToken: "synthetic", accountId: "synthetic" } },
])
  test(`remote browser requires vetted egress before opening ${Object.keys(remote)[0]}`, async (t) => {
    let attempted = 0;
    t.mock.method(globalThis, "fetch", async () => {
      attempted++;
      return new Response("", { status: 503 });
    });
    t.mock.method(chromium, "connectOverCDP", async () => {
      attempted++;
      throw new Error("unexpected remote connection");
    });
    t.mock.method(chromium, "launch", async () => {
      attempted++;
      throw new Error("unexpected local fallback");
    });
    const result = await createAuthorizationBrowser(remote).complete({
      startUrl: "https://provider.example/login",
      redirectUri: "https://ceremony.example/callback",
      allowedOrigins: ["https://provider.example"],
    });
    assert.equal(attempted, 0);
    assert.equal(result.status, "blocked");
  });
