import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { chromium, type Browser } from "playwright-core";
import {
  browserbaseLiveView,
  liveViewTemplateAllowed,
  openLiveBrowser,
  safeLiveViewUrl,
  templateLiveView,
  type LiveBrowser,
} from "../src/server/live-view.js";
import { RemoteHumanBrowser } from "../src/server/cloudflare.js";
import { remoteBrowserOptionsFromEnv } from "../src/server/browser-executor.js";
import { CeremonyDatabase } from "../src/server/storage.js";

test("a takeover URL is https with no userinfo, wherever it came from", () => {
  assert.equal(
    safeLiveViewUrl("https://viewer.example/live/tab"),
    "https://viewer.example/live/tab",
  );
  for (const unsafe of [
    "http://viewer.example/live",
    "https://user:secret@viewer.example/live",
    "javascript:alert(1)",
  ])
    assert.throws(() => safeLiveViewUrl(unsafe), unsafe);
});

test("an operator's live-view template admits only https and {targetId}", () => {
  for (const allowed of [
    "https://viewer.example/live/{targetId}",
    "https://viewer.example/live?tab={targetId}",
    "https://viewer.example/whole-browser",
  ])
    assert.equal(liveViewTemplateAllowed(allowed), true, allowed);
  for (const refused of [
    "http://viewer.example/live/{targetId}",
    "https://user:pass@viewer.example/{targetId}",
    "https://viewer.example/{sessionId}",
    "not a url",
  ])
    assert.equal(liveViewTemplateAllowed(refused), false, refused);
  assert.throws(() => templateLiveView("http://viewer.example/{targetId}"));
});

test("the CDP live-view template is validated at boot and never quoted", () => {
  const base = {
    CEREMONY_BROWSER_CDP_URL: "wss://browser.example/cdp",
    CEREMONY_BROWSER_REMOTE_PROXY: "https://proxy.example:8443",
  };
  assert.equal(
    remoteBrowserOptionsFromEnv({
      ...base,
      CEREMONY_BROWSER_CDP_LIVE_VIEW_URL:
        "https://viewer.example/live/{targetId}",
    }).cdp?.liveViewUrlTemplate,
    "https://viewer.example/live/{targetId}",
  );
  assert.equal(
    remoteBrowserOptionsFromEnv(base).cdp?.liveViewUrlTemplate,
    undefined,
  );
  assert.throws(
    () =>
      remoteBrowserOptionsFromEnv({
        ...base,
        CEREMONY_BROWSER_CDP_LIVE_VIEW_URL: "http://secret-viewer.example/{x}",
      }),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.match(error.message, /CEREMONY_BROWSER_CDP_LIVE_VIEW_URL/);
      assert.doesNotMatch(error.message, /secret-viewer/);
      return true;
    },
  );
});

async function tab(t: { after(fn: () => unknown): void }) {
  const browser = await chromium.launch({ headless: true });
  t.after(() => browser.close());
  const context = await browser.newContext();
  const page = await context.newPage();
  const session = await context.newCDPSession(page);
  const { targetInfo } = await session.send("Target.getTargetInfo");
  await session.detach();
  return { browser, context, page, targetId: targetInfo.targetId };
}

test("a template live view names the tab by its CDP target id", async (t) => {
  const { page, targetId } = await tab(t);
  const url = await templateLiveView("https://viewer.example/live/{targetId}")(
    page,
  );
  assert.equal(url, `https://viewer.example/live/${targetId}`);
});

test("a Browserbase live view prefers the waiting tab and refuses anything unsafe", async (t) => {
  const { page, targetId } = await tab(t);
  const responses: unknown[] = [
    {
      debuggerFullscreenUrl: "https://www.browserbase.example/devtools/all",
      pages: [
        {
          id: "another-tab",
          debuggerFullscreenUrl: "https://www.browserbase.example/devtools/x",
        },
        {
          id: targetId,
          debuggerFullscreenUrl: "https://www.browserbase.example/devtools/tab",
        },
      ],
    },
    { debuggerFullscreenUrl: "https://www.browserbase.example/devtools/all" },
    { debuggerFullscreenUrl: "http://www.browserbase.example/devtools/all" },
  ];
  const requests: { url: string; key: string | null }[] = [];
  const minter = browserbaseLiveView({
    apiKey: "synthetic-browserbase-key",
    sessionId: "fixture-session",
    fetch: async (input, init) => {
      requests.push({
        url: String(input),
        key: new Headers(init?.headers).get("x-bb-api-key"),
      });
      const next = responses.shift();
      return next === undefined
        ? new Response("", { status: 503 })
        : Response.json(next);
    },
  });
  assert.equal(
    await minter(page),
    "https://www.browserbase.example/devtools/tab",
  );
  assert.equal(
    await minter(page),
    "https://www.browserbase.example/devtools/all",
  );
  await assert.rejects(minter(page));
  await assert.rejects(minter(page));
  assert.deepEqual(requests[0], {
    url: "https://api.browserbase.com/v1/sessions/fixture-session/debug",
    key: "synthetic-browserbase-key",
  });
});

test("a remote browser for a person needs a vetted CDP endpoint", async () => {
  await assert.rejects(
    openLiveBrowser({
      kind: "cdp",
      endpoint: "ws://browser.example/cdp",
      liveViewUrlTemplate: "https://viewer.example/{targetId}",
    }),
    /Invalid remote CDP endpoint/,
  );
  await assert.rejects(
    openLiveBrowser({
      kind: "cdp",
      endpoint: "wss://browser.example/cdp",
      liveViewUrlTemplate: "http://viewer.example/{targetId}",
    }),
    /Invalid live view URL template/,
  );
});

/**
 * A provider with a live view and no hand-off signal of its own - Browserbase
 * or a CDP endpoint - over a real local browser. Only the provider's URL
 * minting is simulated; the broker and provider pages are routed fixtures.
 */
async function liveProvider(
  t: { after(fn: () => unknown): void },
  destination: string,
) {
  const browser: Browser = await chromium.launch({ headless: true });
  t.after(() => browser.close());
  const context = await browser.newContext();
  await context.route("https://ceremony.example/**", (route) =>
    route.fulfill({
      contentType: "text/html",
      body: `<script>location.href=${JSON.stringify(`${destination}/login`)}</script>`,
    }),
  );
  await context.route(`${destination}/**`, (route) =>
    route.fulfill({ contentType: "text/html", body: "<title>Sign in</title>" }),
  );
  let opened = 0;
  const minted: string[] = [];
  const open = async (): Promise<LiveBrowser> => {
    opened++;
    return {
      browser,
      liveView: async (page) => {
        minted.push(new URL(page.url()).origin);
        return "https://viewer.example/live/fixture-tab";
      },
      close: () => browser.close(),
    };
  };
  return { browser, context, open, opened: () => opened, minted };
}

test("any connector's login can be handed to a person through a provider's live view", async (t) => {
  const provider = await liveProvider(t, "https://id.fixture.example");
  const directory = mkdtempSync(join(tmpdir(), "ceremony-live-view-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const db = new CeremonyDatabase(join(directory, "live.db"), randomBytes(32));
  t.after(() => db.close());
  const service = new RemoteHumanBrowser(db, {
    origin: "https://ceremony.example",
    source: {
      kind: "cdp",
      endpoint: "wss://browser.example/cdp",
      liveViewUrlTemplate: "https://viewer.example/live/{targetId}",
    },
    open: provider.open,
  });
  const route = {
    path: "/api/v1/teaching/fixture/run-1/human",
    cookiePath: "/api/v1/teaching/fixture/run-1",
    destination: "https://id.fixture.example",
    instructions: "Sign in to Fixture ID and approve the connection.",
  };
  await service.request("alice", "run-1", "synthetic-cookie", route);
  await service.request("alice", "run-1", "synthetic-cookie", route);
  await assert.rejects(
    service.request("bob", "run-1", "other-cookie", route),
    /not found/,
  );
  assert.equal(provider.opened(), 1);
  // Minted only once the tab had reached the provider, never on the broker.
  assert.deepEqual(provider.minted, ["https://id.fixture.example"]);
  const cookie = (
    await provider.context.cookies(
      "https://ceremony.example/api/v1/teaching/fixture/run-1/human",
    )
  )[0]!;
  assert.equal(cookie.path, "/api/v1/teaching/fixture/run-1");
  assert.equal(cookie.httpOnly, true);
  assert.equal(cookie.secure, true);
  assert.equal(
    (await provider.context.cookies("https://id.fixture.example")).length,
    0,
  );
  assert.equal(
    service.humanUrl("alice", "run-1"),
    "https://viewer.example/live/fixture-tab",
  );
  assert.throws(() => service.humanUrl("bob", "run-1"));
  // The control URL is at rest only encrypted: no database file holds it.
  for (const file of readdirSync(directory))
    assert.equal(
      readFileSync(join(directory, file)).includes("viewer.example"),
      false,
      file,
    );
  service.cancel("run-1");
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.throws(() => service.humanUrl("alice", "run-1"), /expired/);
  assert.equal(provider.browser.isConnected(), false);
});

test("a takeover route is refused unless it stays on the broker and hands off elsewhere", async () => {
  const db = new CeremonyDatabase(":memory:", randomBytes(32));
  let opened = 0;
  const service = new RemoteHumanBrowser(db, {
    origin: "https://ceremony.example",
    source: {
      kind: "browserbase",
      apiKey: "synthetic",
      projectId: "synthetic",
    },
    open: async () => {
      opened++;
      throw new Error("not reached");
    },
  });
  const valid = {
    path: "/api/live/fixture/run/human",
    cookiePath: "/api/live/fixture/run",
    destination: "https://id.fixture.example",
    instructions: "Sign in.",
  };
  for (const route of [
    { ...valid, path: "https://elsewhere.example/api/live/fixture/run/human" },
    { ...valid, path: "/api/live/fixture/../other/human" },
    { ...valid, cookiePath: "/api/live/other" },
    { ...valid, destination: "http://id.fixture.example" },
    { ...valid, destination: "https://ceremony.example" },
  ])
    await assert.rejects(
      service.request("alice", "run", "cookie", route),
      /Invalid human takeover route/,
    );
  assert.equal(opened, 0);
  db.close();
});

test("a Browserbase browser for a person is opened unrecorded and keeps its session for the live view", async (t) => {
  const local = await chromium.launch({ headless: true });
  t.after(() => local.close());
  const dialled: string[] = [];
  t.mock.method(chromium, "connectOverCDP", async (endpoint: string) => {
    dialled.push(endpoint);
    return local;
  });
  const sent: { url: string; body?: string }[] = [];
  let available = true;
  const fetcher: typeof fetch = async (input, init) => {
    sent.push({
      url: String(input),
      ...(typeof init?.body === "string" ? { body: init.body } : {}),
    });
    if (!available) return new Response("", { status: 503 });
    if (String(input).endsWith("/v1/sessions"))
      return Response.json({
        id: "fixture-session",
        connectUrl: "wss://connect.browserbase.example/fixture",
      });
    return Response.json({
      debuggerFullscreenUrl: "https://www.browserbase.example/devtools/all",
    });
  };
  const source = {
    kind: "browserbase" as const,
    apiKey: "synthetic-browserbase-key",
    projectId: "fixture-project",
  };
  const live = await openLiveBrowser(source, { fetch: fetcher });
  assert.deepEqual(dialled, ["wss://connect.browserbase.example/fixture"]);
  assert.deepEqual(JSON.parse(sent[0]!.body!).browserSettings, {
    recordSession: false,
    logSession: false,
    solveCaptchas: false,
  });
  const page = await live.browser.newPage();
  assert.equal(
    await live.liveView(page),
    "https://www.browserbase.example/devtools/all",
  );
  assert.equal(
    sent[1]!.url,
    "https://api.browserbase.com/v1/sessions/fixture-session/debug",
  );
  assert.equal(live.handoff, undefined);
  available = false;
  await assert.rejects(openLiveBrowser(source, { fetch: fetcher }));
});

test("a CDP browser for a person presents its headers and names tabs through the operator's template", async (t) => {
  const local = await chromium.launch({ headless: true });
  t.after(() => local.close());
  const dialled: unknown[] = [];
  t.mock.method(
    chromium,
    "connectOverCDP",
    async (endpoint: string, options: unknown) => {
      dialled.push([endpoint, options]);
      return local;
    },
  );
  const live = await openLiveBrowser({
    kind: "cdp",
    endpoint: "wss://browser.example/cdp",
    headers: { authorization: "Bearer synthetic" },
    liveViewUrlTemplate: "https://viewer.example/live/{targetId}",
  });
  assert.deepEqual(dialled, [
    [
      "wss://browser.example/cdp",
      { headers: { authorization: "Bearer synthetic" }, timeout: 20_000 },
    ],
  ]);
  const context = await live.browser.newContext();
  const page = await context.newPage();
  const session = await context.newCDPSession(page);
  const { targetInfo } = await session.send("Target.getTargetInfo");
  assert.equal(
    await live.liveView(page),
    `https://viewer.example/live/${targetInfo.targetId}`,
  );
});
