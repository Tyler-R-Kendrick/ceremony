import assert from "node:assert/strict";
import { test } from "node:test";
import { randomBytes } from "node:crypto";
import { chromium } from "playwright-core";
import { CloudflareHumanBrowser } from "../src/server/cloudflare.js";
import { CeremonyDatabase } from "../src/server/storage.js";

test("behavior: remote browser handoff uses a private cookie, isolates ownership and closes on cancellation", async (t) => {
  // Real browser/context; only Cloudflare's vendor CDP service is simulated.
  const browser = await chromium.launch({ headless: true });
  t.after(() => browser.close());
  const context = await browser.newContext();
  await context.route("https://ceremony.example/**", (route) =>
    route.fulfill({
      contentType: "text/html",
      body: '<script>location.href="https://github.com/login"</script>',
    }),
  );
  await context.route("https://github.com/**", (route) =>
    route.fulfill({
      contentType: "text/html",
      body: "<title>Provider approval</title>",
    }),
  );
  const page = await context.newPage();
  const cdp = await context.newCDPSession(page);
  t.mock.method(context, "newCDPSession", async () => cdp);
  const commands: string[] = [];
  t.mock.method(cdp, "send", async (method: string) => {
    commands.push(method);
    if (method === "Cloudflare.getLiveView")
      return { devtoolsFrontendUrl: "https://browser.example/human-control" };
    if (method === "Cloudflare.handoff") return {};
    throw new Error("Unexpected CDP command");
  });
  let connects = 0;
  t.mock.method(chromium, "connectOverCDP", async (endpoint: string) => {
    connects++;
    assert.match(endpoint, /^wss:\/\/api.cloudflare.com\//);
    return browser;
  });
  const db = new CeremonyDatabase(":memory:", randomBytes(32));
  t.after(() => db.close());
  const service = new CloudflareHumanBrowser(db, {
    origin: "https://ceremony.example",
    accountId: "a".repeat(32),
    apiToken: "synthetic-token",
  });
  await service.request("alice", "run", "synthetic-cookie");
  await service.request("alice", "run", "synthetic-cookie");
  assert.equal(connects, 1);
  assert.deepEqual(commands, ["Cloudflare.getLiveView", "Cloudflare.handoff"]);
  const cookie = (
    await context.cookies("https://ceremony.example/api/live/github/run/human")
  )[0]!;
  assert.equal(cookie.httpOnly, true);
  assert.equal(cookie.secure, true);
  assert.equal(cookie.path, "/api/live/github/run");
  assert.equal((await context.cookies("https://github.com")).length, 0);
  assert.equal(
    service.humanUrl("alice", "run"),
    "https://browser.example/human-control",
  );
  assert.throws(() => service.humanUrl("bob", "run"));
  assert.equal(db.keys("connection:").length, 0);
  await service.close();
  assert.throws(() => service.humanUrl("alice", "run"));
  assert.equal(browser.isConnected(), false);
});
