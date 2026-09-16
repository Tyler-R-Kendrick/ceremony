import assert from "node:assert/strict";
import http, {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import net, {
  connect,
  createServer as createTcpServer,
  type AddressInfo,
  type Socket,
} from "node:net";
import { EventEmitter } from "node:events";
import { syncBuiltinESMExports } from "node:module";
import { test, type TestContext } from "node:test";
import type { Browser } from "playwright-core";
import { createAuthorizationBrowser } from "../src/server/browser-executor.js";
import { chromium } from "../src/server/playwright.js";
import { createBrowserEgressProxy } from "../src/server/browser-egress.js";

function socketProbe() {
  return Object.assign(new EventEmitter(), {
    readableEnded: false,
    destroys: 0,
    written: [] as string[],
    timeouts: [] as number[],
    destinations: [] as unknown[],
    onTimeout: undefined as (() => void) | undefined,
    destroy() {
      this.destroys++;
      return this;
    },
    write(bytes: string | Buffer) {
      this.written.push(bytes.toString());
      return true;
    },
    end(bytes: string) {
      this.written.push(bytes);
      return this;
    },
    pipe(destination: unknown) {
      this.destinations.push(destination);
      return destination;
    },
    setTimeout(delay: number, callback?: () => void) {
      this.timeouts.push(delay);
      if (callback) this.onTimeout = callback;
      return this;
    },
  });
}

async function bounded<T>(promise: Promise<T>) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () => reject(new Error("fixture callback did not complete")),
          1_000,
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

function proxyProbe(t: TestContext) {
  const upstream = socketProbe();
  const connections: net.NetConnectOpts[] = [];
  let handler:
    ((request: IncomingMessage, response: ServerResponse) => void) | undefined;
  let closed = 0;
  const server = Object.assign(new EventEmitter(), {
    listen(port: number, host: string, callback: () => void) {
      assert.equal(port, 0);
      assert.equal(host, "127.0.0.1");
      assert.equal(server.listenerCount("error"), 1);
      callback();
    },
    address: () => ({ port: 43210 }),
    close(callback: () => void) {
      closed++;
      callback();
    },
  });
  t.mock.method(http, "createServer", (listener: typeof handler) => {
    handler = listener;
    return server;
  });
  t.mock.method(net, "connect", (options: net.NetConnectOpts) => {
    connections.push(options);
    return upstream as unknown as Socket;
  });
  syncBuiltinESMExports();
  t.after(() => {
    t.mock.restoreAll();
    syncBuiltinESMExports();
  });
  return {
    server,
    upstream,
    connections,
    handler: () => handler!,
    closed: () => closed,
  };
}

test("proxy closes live sockets, releases closed sockets and completes server shutdown", async (t) => {
  const f = proxyProbe(t);
  const proxy = await bounded(createBrowserEgressProxy());
  assert.equal(proxy.server, "http://127.0.0.1:43210");
  const finished = socketProbe(),
    active = socketProbe();
  f.server.emit("connection", finished);
  f.server.emit("connection", active);
  finished.emit("close");
  await bounded(proxy.close());
  assert.equal(
    finished.destroys,
    0,
    "closed sockets must not stay retained for later cleanup",
  );
  assert.equal(active.destroys, 1);
  assert.equal(f.closed(), 1);
});

test("proxy ends forbidden HTTP responses with an explicit closed connection", async (t) => {
  const f = proxyProbe(t);
  const proxy = await bounded(createBrowserEgressProxy());
  let status: number | undefined,
    headers: unknown,
    ended = false;
  f.handler()(
    {} as IncomingMessage,
    {
      writeHead(code: number, value: unknown) {
        status = code;
        headers = value;
      },
      end() {
        ended = true;
      },
    } as unknown as ServerResponse,
  );
  assert.equal(status, 403);
  assert.deepEqual(headers, { connection: "close" });
  assert.equal(ended, true);
  await bounded(proxy.close());
});

for (const [address, allowLoopbackHttp] of [
  ["2606:4700:4700::1111", false],
  ["::1", true],
] as const)
  test(`proxy preserves ${address}, opaque head bytes and native connection lifecycle`, async (t) => {
    const f = proxyProbe(t);
    const proxy = await bounded(
      createBrowserEgressProxy({ allowLoopbackHttp }),
    );
    const client = socketProbe();
    f.server.emit("connection", client);
    f.server.emit(
      "connect",
      { url: `[${address}]:443` },
      client,
      Buffer.from("opaque-head"),
    );
    assert.equal(f.connections.length, 1);
    const options = f.connections[0] as net.TcpNetConnectOpts;
    assert.equal(options.host, address);
    assert.equal(options.port, 443);
    assert.equal(options.autoSelectFamily, true);
    assert.equal(typeof options.lookup, "function");
    assert.deepEqual(f.upstream.timeouts, [10_000]);
    f.upstream.emit("connect");
    assert.deepEqual(f.upstream.timeouts, [10_000, 0]);
    assert.deepEqual(client.written, [
      "HTTP/1.1 200 Connection Established\r\n\r\n",
    ]);
    assert.deepEqual(f.upstream.written, ["opaque-head"]);
    assert.deepEqual(client.destinations, [f.upstream]);
    assert.deepEqual(f.upstream.destinations, [client]);
    client.emit("close");
    assert.equal(f.upstream.destroys, 1);
    await bounded(proxy.close());
  });

for (const failure of [
  "client-error",
  "upstream-error",
  "upstream-close",
  "setup-timeout",
])
  test(`proxy releases the peer after ${failure}`, async (t) => {
    const f = proxyProbe(t);
    const proxy = await bounded(createBrowserEgressProxy());
    const client = socketProbe();
    f.server.emit("connection", client);
    f.server.emit(
      "connect",
      { url: "provider.example:443" },
      client,
      Buffer.alloc(0),
    );
    if (failure === "setup-timeout") {
      assert.equal(typeof f.upstream.onTimeout, "function");
      f.upstream.onTimeout!();
      assert.equal(f.upstream.destroys, 1);
    } else if (failure === "client-error") {
      client.emit("error", new Error("fixture client failure"));
      assert.equal(f.upstream.destroys, 1);
    } else if (failure === "upstream-error") {
      f.upstream.emit("error", new Error("fixture upstream failure"));
      assert.equal(client.destroys, 1);
    } else {
      f.upstream.emit("connect");
      f.upstream.emit("close");
      assert.equal(client.destroys, 1);
    }
    await bounded(proxy.close());
  });

test("proxy preserves a clean upstream end and rejects user-info authorities before transport", async (t) => {
  const f = proxyProbe(t);
  const proxy = await bounded(createBrowserEgressProxy());
  const client = socketProbe();
  f.server.emit(
    "connect",
    { url: "provider.example:443" },
    client,
    Buffer.alloc(0),
  );
  f.upstream.readableEnded = true;
  f.upstream.emit("close");
  assert.equal(client.destroys, 0);
  const rejected = socketProbe();
  f.server.emit(
    "connect",
    { url: "ignored@provider.example:443" },
    rejected,
    Buffer.alloc(0),
  );
  assert.equal(f.connections.length, 1);
  assert.deepEqual(rejected.written, [
    "HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n",
  ]);
  await bounded(proxy.close());
});

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
