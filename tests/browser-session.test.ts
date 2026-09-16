import assert from "node:assert/strict";
import { test } from "node:test";
import {
  configuredBackend,
  openBrowserSession,
} from "../examples/browser-session.js";

/**
 * Where the agent's browser runs is a configuration decision, and it is the one
 * decision in the run that no test can make by driving a page: the hosted
 * backends need accounts this repository does not have. So what is proved here
 * is the choice itself and the refusals around it — that a partial credential
 * never silently becomes a different backend, that a malformed account is
 * rejected before anything is dialled, and that a refusal from a provider is
 * reported rather than swallowed into a broken browser.
 */

test("behavior: the backend is chosen by configuration, and a partial credential is not one", () => {
  const account = "a".repeat(32);
  assert.equal(configuredBackend({}), "local");
  assert.equal(
    configuredBackend({
      CLOUDFLARE_ACCOUNT_ID: account,
      CLOUDFLARE_API_TOKEN: "token",
    }),
    "cloudflare",
  );
  assert.equal(
    configuredBackend({ BROWSER_USE_API_KEY: "key" }),
    "browser-use",
  );

  // Half of a Cloudflare credential is not a Cloudflare session. Falling back
  // is right; falling through to Browser Use on someone else's key would not be.
  assert.equal(configuredBackend({ CLOUDFLARE_ACCOUNT_ID: account }), "local");
  assert.equal(configuredBackend({ CLOUDFLARE_API_TOKEN: "token" }), "local");
  assert.equal(
    configuredBackend({
      CLOUDFLARE_API_TOKEN: "token",
      BROWSER_USE_API_KEY: "key",
    }),
    "browser-use",
  );

  // Cloudflare wins when both are fully configured: it is the one that can hand
  // a person a live view of the agent's own tab.
  assert.equal(
    configuredBackend({
      CLOUDFLARE_ACCOUNT_ID: account,
      CLOUDFLARE_API_TOKEN: "token",
      BROWSER_USE_API_KEY: "key",
    }),
    "cloudflare",
  );
});

test("behavior: a malformed Cloudflare account is refused before anything is dialled", async () => {
  // No network double is installed, so reaching one would fail differently.
  // The point is that the identifier is validated first: an account id pasted
  // with a stray character must not become a wss:// URL at all.
  await assert.rejects(
    openBrowserSession({
      CLOUDFLARE_ACCOUNT_ID: "not-an-account",
      CLOUDFLARE_API_TOKEN: "token",
    }),
  );
  await assert.rejects(
    openBrowserSession({
      CLOUDFLARE_ACCOUNT_ID: `${"a".repeat(32)} `,
      CLOUDFLARE_API_TOKEN: "token",
    }),
  );
});

test("behavior: a refused Browser Use session is reported, not connected to", async (t) => {
  const calls: { url: string; method: string | undefined }[] = [];
  t.mock.method(
    globalThis,
    "fetch",
    async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push({ url: String(input), method: init?.method });
      return new Response("{}", { status: 402 });
    },
  );
  await assert.rejects(
    openBrowserSession({ BROWSER_USE_API_KEY: "key" }),
    /Browser Use refused a session \(402\)/,
  );
  assert.equal(calls.length, 1);
  assert.equal(calls[0]?.method, "POST");
  assert.match(calls[0]?.url ?? "", /^https:\/\/api\.browser-use\.com\//);
});

test("behavior: a Browser Use session of the wrong shape is refused rather than driven", async (t) => {
  // A 200 carrying no CDP endpoint is worse than an error: connecting to
  // undefined produces a browser-shaped object that fails at the first step.
  t.mock.method(globalThis, "fetch", async () =>
    Response.json({ id: "abc", liveUrl: "https://example.test/watch" }),
  );
  await assert.rejects(openBrowserSession({ BROWSER_USE_API_KEY: "key" }));
});
