import assert from "node:assert/strict";
import { test } from "node:test";
import { createServer } from "node:http";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";

test("MV3 worker injects into a test-owned page in headless Chromium", async () => {
  const extension = fileURLToPath(
    new URL("./fixtures/extension-loading/", import.meta.url),
  );
  const profile = await mkdtemp(join(tmpdir(), "ceremony-extension-spike-"));
  const server = createServer((_request, response) => {
    response.writeHead(200, { "content-type": "text/html" });
    response.end(
      "<!doctype html><title>Owned extension fixture</title><h1>Fixture</h1>",
    );
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  let context;
  try {
    context = await chromium.launchPersistentContext(profile, {
      channel: "chromium",
      headless: true,
      args: [
        `--disable-extensions-except=${extension}`,
        `--load-extension=${extension}`,
      ],
    });
    const worker =
      context.serviceWorkers()[0] ??
      (await context.waitForEvent("serviceworker"));
    assert.match(worker.url(), /^chrome-extension:\/\/[a-p]{32}\/worker\.js$/);
    const page = await context.newPage();
    const url = `http://127.0.0.1:${address.port}/`;
    await page.goto(url);
    const injected = (await worker.evaluate(`(async () => {
      const tab = (await chrome.tabs.query({})).find(candidate => candidate.url === ${JSON.stringify(url)});
      if (tab?.id === undefined) throw new Error("Owned fixture tab not found");
      return chrome.scripting.executeScript({
        target: { tabId: tab.id },
        func: () => {
          document.documentElement.dataset.ceremonyExtension = "loaded";
          return document.title;
        }
      });
    })()`)) as Array<{ result: string }>;
    assert.equal(injected[0]?.result, "Owned extension fixture");
    assert.equal(
      await page.locator("html").getAttribute("data-ceremony-extension"),
      "loaded",
    );
  } finally {
    await context?.close();
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
    await rm(profile, { recursive: true, force: true });
  }
});
