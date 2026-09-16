import assert from "node:assert/strict";
import { createServer } from "node:http";
import { test } from "node:test";
import { chromium } from "playwright-core";
import { createAuthorizationBrowser } from "../src/server/browser-executor.js";

for (const [reason, markup, terminalEvent] of [
  [
    "username-in-use",
    "Username is already taken",
    "Provider rejected the requested account identifier as already in use",
  ],
  [
    "no-form",
    "Plain provider page",
    "No sign-in or registration form on the provider page",
  ],
] as const)
  test(`a terminal ${reason} is returned without another driver iteration`, async (t) => {
    const provider = createServer((_request, response) => {
      response.setHeader("content-type", "text/html");
      response.end(`<!doctype html><p>${markup}</p>`);
    });
    await new Promise<void>((done) => provider.listen(0, "127.0.0.1", done));
    t.after(() => new Promise<void>((done) => provider.close(() => done())));
    const address = provider.address();
    assert.ok(address && typeof address !== "string");
    const origin = `http://127.0.0.1:${address.port}`;
    const browser = await chromium.launch({ headless: true });
    t.after(() => browser.close());
    let reported = 0;
    const now = Date.now;
    // End a discarded terminal result at the next loop condition, before hit limits.
    t.mock.method(Date, "now", () => now() + (reported ? 30_000 : 0));
    const executor = createAuthorizationBrowser({
      open: async () => ({ browser, close: async () => {} }),
    });
    const result = await executor.complete({
      startUrl: origin,
      redirectUri: `${origin}/callback`,
      allowedOrigins: [origin],
      timeoutMs: 30_000,
      onEvent: (event) => {
        if (event === terminalEvent) reported++;
      },
    });
    assert.equal(reported, 1);
    assert.equal(result.status, "blocked");
    if (result.status === "blocked") assert.equal(result.reason, reason);
  });
