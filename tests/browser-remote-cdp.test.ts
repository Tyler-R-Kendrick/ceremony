import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer, request as httpRequest, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";
import {
  createAuthorizationBrowser,
  remoteBrowserOptionsFromEnv,
  remoteCdpEndpointAllowed,
} from "../src/server/browser-executor.js";
import { chromium } from "../src/server/playwright.js";

/**
 * A remote browser reached through a plain CDP endpoint.
 *
 * The case that matters runs a real Chromium as a separate process with a
 * debugging port — standing in for Steel, browserless or any operator-run
 * browser — and connects to it the way a host configured with
 * `CEREMONY_BROWSER_CDP_URL` would. The proxy in front of the provider is the
 * oracle for containment: if the provider saw the request and the proxy did
 * not, the remote browser's traffic went around the egress rule.
 */

const CDP_TOKEN = "cdp-header-canary-3b9e";

describe("REMOTE-CDP-CONFIG: host configuration is validated at boot", () => {
  test("endpoints are encrypted, or plaintext only on this machine", () => {
    for (const allowed of [
      "wss://connect.steel.example/?apiKey=x",
      "https://browserless.example/",
      "ws://127.0.0.1:9222/devtools/browser/abc",
      "ws://localhost:9222/devtools/browser/abc",
      "http://[::1]:9222",
    ])
      assert.equal(remoteCdpEndpointAllowed(allowed), true, allowed);
    for (const refused of [
      "ws://browser.example:9222/devtools/browser/abc",
      "http://10.0.0.5:9222",
      "wss://user:secret@browser.example/",
      "file:///tmp/socket",
      "not a url",
    ])
      assert.equal(remoteCdpEndpointAllowed(refused), false, refused);
  });

  test("the environment reader builds CDP, headers and proxy together", () => {
    const options = remoteBrowserOptionsFromEnv({
      CEREMONY_BROWSER_CDP_URL: "wss://browser.example/devtools",
      CEREMONY_BROWSER_CDP_HEADERS: JSON.stringify({
        Authorization: `Bearer ${CDP_TOKEN}`,
      }),
      CEREMONY_BROWSER_REMOTE_PROXY: "http://egress.example:3128",
      CEREMONY_BROWSER_REMOTE_PROXY_USERNAME: "egress",
      CEREMONY_BROWSER_REMOTE_PROXY_PASSWORD: "egress-secret",
    });
    assert.deepEqual(options, {
      cdp: {
        endpoint: "wss://browser.example/devtools",
        headers: { Authorization: `Bearer ${CDP_TOKEN}` },
      },
      remoteProxy: {
        server: "http://egress.example:3128",
        username: "egress",
        password: "egress-secret",
      },
    });
    assert.deepEqual(remoteBrowserOptionsFromEnv({}), {});
  });

  test("bad values refuse to boot and never quote the value", () => {
    const cases: Record<string, string>[] = [
      { CEREMONY_BROWSER_CDP_URL: "ws://browser.example:9222" },
      {
        CEREMONY_BROWSER_CDP_URL: "wss://browser.example",
        CEREMONY_BROWSER_CDP_HEADERS: `Bearer ${CDP_TOKEN}`,
      },
      {
        CEREMONY_BROWSER_CDP_URL: "wss://browser.example",
        CEREMONY_BROWSER_CDP_HEADERS: JSON.stringify([CDP_TOKEN]),
      },
      { CEREMONY_BROWSER_REMOTE_PROXY: `http://u:${CDP_TOKEN}@proxy.example` },
      { CEREMONY_BROWSER_REMOTE_PROXY: "socks5://proxy.example:1080" },
    ];
    for (const env of cases)
      assert.throws(
        () => remoteBrowserOptionsFromEnv(env),
        (error: unknown) =>
          error instanceof Error && !error.message.includes(CDP_TOKEN),
        JSON.stringify(env),
      );
  });
});

describe("REMOTE-CDP-DIAL: the configured endpoint and headers are what is dialled", () => {
  test("headers reach the connection; nothing falls back to a local launch", async (t) => {
    const dialled: unknown[][] = [];
    t.mock.method(chromium, "connectOverCDP", async (...args: unknown[]) => {
      dialled.push(args);
      throw new Error("synthetic remote refusal");
    });
    let launched = 0;
    t.mock.method(chromium, "launch", async () => {
      launched++;
      throw new Error("unexpected local fallback");
    });
    const result = await createAuthorizationBrowser({
      cdp: {
        endpoint: "wss://browser.example/devtools",
        headers: { Authorization: `Bearer ${CDP_TOKEN}` },
      },
      remoteProxy: { server: "http://egress.example:3128" },
    }).complete({
      startUrl: "https://provider.example/login",
      redirectUri: "https://ceremony.example/callback",
      allowedOrigins: ["https://provider.example"],
    });
    assert.equal(launched, 0);
    assert.equal(dialled.length, 1);
    assert.equal(dialled[0]![0], "wss://browser.example/devtools");
    assert.deepEqual((dialled[0]![1] as { headers?: unknown }).headers, {
      Authorization: `Bearer ${CDP_TOKEN}`,
    });
    assert.deepEqual(result, {
      status: "blocked",
      reason: "browser-unavailable",
    });
    // The header authenticates the browser. It is not something a result says.
    assert.ok(!JSON.stringify(result).includes(CDP_TOKEN));
  });

  test("an endpoint configured in code is checked again before dialling", async (t) => {
    let dialled = 0;
    t.mock.method(chromium, "connectOverCDP", async () => {
      dialled++;
      throw new Error("unexpected dial");
    });
    const result = await createAuthorizationBrowser({
      cdp: { endpoint: "ws://browser.example:9222/devtools/browser/x" },
      remoteProxy: { server: "http://egress.example:3128" },
    }).complete({
      startUrl: "https://provider.example/login",
      redirectUri: "https://ceremony.example/callback",
      allowedOrigins: ["https://provider.example"],
    });
    assert.equal(dialled, 0);
    assert.equal(result.status, "blocked");
  });
});

describe("REMOTE-CDP-LIVE: a separately running Chromium, driven through its debugging port", () => {
  let browser: ChildProcess | undefined;
  let profile: string | undefined;
  let endpoint = "";
  let provider: Server;
  let providerOrigin = "";
  let proxy: Server;
  let proxyOrigin = "";
  /** What reached the provider, and what reached it through the proxy. */
  const providerSaw: string[] = [];
  const proxySaw: string[] = [];

  before(async () => {
    provider = createServer((request, response) => {
      providerSaw.push(request.url ?? "");
      response.writeHead(200, { "content-type": "text/html" });
      response.end(
        '<!doctype html><title>Account</title><main data-authenticated="true">Fixture account</main>',
      );
    });
    await new Promise<void>((resolve) =>
      provider.listen(0, "127.0.0.1", resolve),
    );
    providerOrigin = `http://127.0.0.1:${(provider.address() as AddressInfo).port}`;

    // A forward proxy for plain HTTP: the request line carries the absolute
    // URL, and this records it before relaying. It stands in for the vetted
    // egress proxy a hosted browser would be pointed at.
    proxy = createServer((request, response) => {
      proxySaw.push(request.url ?? "");
      let target: URL;
      try {
        target = new URL(request.url ?? "");
      } catch {
        response.writeHead(400).end();
        return;
      }
      const upstream = httpRequest(
        {
          host: target.hostname,
          port: target.port,
          path: `${target.pathname}${target.search}`,
          method: request.method,
          headers: request.headers,
        },
        (answer) => {
          response.writeHead(answer.statusCode ?? 502, answer.headers);
          answer.pipe(response);
        },
      );
      upstream.on("error", () => response.writeHead(502).end());
      request.pipe(upstream);
    });
    await new Promise<void>((resolve) => proxy.listen(0, "127.0.0.1", resolve));
    proxyOrigin = `http://127.0.0.1:${(proxy.address() as AddressInfo).port}`;

    profile = mkdtempSync(join(tmpdir(), "ceremony-cdp-"));
    browser = spawn(
      chromium.executablePath(),
      [
        "--headless=new",
        "--no-sandbox",
        "--no-first-run",
        "--remote-debugging-address=127.0.0.1",
        "--remote-debugging-port=0",
        `--user-data-dir=${profile}`,
        "about:blank",
      ],
      { stdio: ["ignore", "ignore", "pipe"] },
    );
    endpoint = await new Promise<string>((resolve, reject) => {
      let output = "";
      const timer = setTimeout(
        () => reject(new Error("Chromium did not report a debugging endpoint")),
        20_000,
      );
      browser!.stderr!.on("data", (chunk: Buffer) => {
        output += chunk.toString();
        const found = /DevTools listening on (ws:\/\/\S+)/.exec(output);
        if (found) {
          clearTimeout(timer);
          resolve(found[1]!);
        }
      });
      browser!.on("exit", () => {
        clearTimeout(timer);
        reject(new Error("Chromium exited before listening"));
      });
    });
  });

  after(async () => {
    // The profile directory is still being written until the process is gone.
    if (browser && browser.exitCode === null) {
      const exited = new Promise<void>((resolve) =>
        browser!.once("exit", () => resolve()),
      );
      browser.kill("SIGKILL");
      await exited;
    }
    await new Promise<void>((resolve) => provider.close(() => resolve()));
    await new Promise<void>((resolve) => proxy.close(() => resolve()));
    if (profile)
      rmSync(profile, {
        recursive: true,
        force: true,
        maxRetries: 5,
        retryDelay: 100,
      });
  });

  test("the provider is reached, and only through the configured proxy", async () => {
    assert.match(endpoint, /^ws:\/\/127\.0\.0\.1:\d+\/devtools\/browser\//);
    const result = await createAuthorizationBrowser({
      cdp: { endpoint },
      remoteProxy: { server: proxyOrigin },
    }).complete({
      startUrl: `${providerOrigin}/private`,
      redirectUri: `${providerOrigin}/callback`,
      allowedOrigins: [providerOrigin],
      accountOnly: true,
      timeoutMs: 5_000,
    });
    // It opened: a remote browser that failed to connect reports this, and
    // nothing else here would.
    assert.notDeepEqual(result, {
      status: "blocked",
      reason: "browser-unavailable",
    });
    assert.ok(
      providerSaw.includes("/private"),
      `provider saw ${JSON.stringify(providerSaw)}`,
    );
    // Every request the provider served arrived through the proxy.
    assert.ok(
      proxySaw.includes(`${providerOrigin}/private`),
      `proxy saw ${JSON.stringify(proxySaw)}`,
    );
    assert.ok(proxySaw.length >= providerSaw.length);
  });
});
