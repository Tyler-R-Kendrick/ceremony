import assert from "node:assert/strict";
import { test } from "node:test";
import { chromium } from "playwright-core";
import { createAuthorizationBrowser } from "../src/server/browser-executor.js";
import { MAX_RESPONSE_BYTES } from "../src/server/connectors/auth/response-bound.js";
import {
  browserbaseLiveView,
  openLiveBrowser,
} from "../src/server/live-view.js";
import { createNeonAdapter } from "../src/server/neon.js";
import {
  assertReadUnder,
  endlessFetch,
  type Pulled,
  type Sites,
} from "./connectors/doubles/endless-body.js";
import { IndeterminateAnswer } from "../src/server/controller.js";

/*
 * An answer that carries a credential or establishes a session is read under
 * the OAuth ceiling wherever it is read: the anonymous-project handshake with
 * Neon, and the sessions a remote browser is opened with (the connect URL is a
 * credential, and so is the live-view address). Each is served an answer that
 * never ends, and what the host pulled is measured. Each request was sent
 * before its answer was read, so an answer too large to read leaves what it
 * did (a project made, a remote browser opened) unknown: the same typed
 * unknown every other flow reports, not a generic refusal.
 */

const unknown = (error: unknown) =>
  error instanceof IndeterminateAnswer && error.outcome === "indeterminate";

const NEON: Sites = ["src/server/neon.ts#checked"];
const LIVE_VIEW: Sites = ["src/server/live-view.ts#browserbaseLiveView"];
const SESSION: Sites = ["src/server/live-view.ts#openLiveBrowser"];
const EXECUTOR: Sites = ["src/server/browser-executor.ts#openRemote"];

const assertBounded = (seen: Pulled, what: string) =>
  assertReadUnder(assert, seen, MAX_RESPONSE_BYTES, what);

const store = {
  put: async () => "ref",
  get: async () => undefined,
  delete: async () => {},
};

test("a Neon identity answer that never ends is cut off at the ceiling, and what it did is unknown", async (t) => {
  const seen = { pulled: 0 };
  t.mock.method(globalThis, "fetch", endlessFetch(seen, NEON));
  const adapter = createNeonAdapter(store, {
    issuer: "http://127.0.0.1:4174",
    claimOrigins: ["http://127.0.0.1:4174"],
    allowLoopbackHttp: true,
  });
  await assert.rejects(adapter.begin(), unknown);
  assertBounded(seen, "neon");
});

test("a Browserbase live-view answer that never ends is cut off at the ceiling, and what it did is unknown", async () => {
  const seen = { pulled: 0 };
  const minter = browserbaseLiveView({
    apiKey: "synthetic-key",
    sessionId: "session",
    fetch: endlessFetch(seen, LIVE_VIEW),
  });
  await assert.rejects(minter({} as never), unknown);
  assertBounded(seen, "live view");
});

test("a Browserbase session answer that never ends is cut off at the ceiling, and what it did is unknown", async () => {
  const seen = { pulled: 0 };
  await assert.rejects(
    openLiveBrowser(
      { kind: "browserbase", apiKey: "synthetic-key", projectId: "project" },
      { fetch: endlessFetch(seen, SESSION) },
    ),
    unknown,
  );
  assertBounded(seen, "remote browser");
});

test("a Browserbase session answer to the authorization executor that never ends is cut off at the ceiling, and what it did is unknown", async (t) => {
  const seen = { pulled: 0 };
  t.mock.method(globalThis, "fetch", endlessFetch(seen, EXECUTOR));
  t.mock.method(chromium, "launch", async () => {
    throw new Error("Unexpected local fallback");
  });
  const executor = createAuthorizationBrowser({
    browserbase: { apiKey: "synthetic-key", projectId: "synthetic-project" },
    remoteProxy: { server: "https://vetted-proxy.example:8443" },
  });
  assert.deepEqual(
    await executor.complete({
      startUrl: "https://provider.example/login",
      redirectUri: "https://host.example/callback",
      allowedOrigins: ["https://provider.example"],
    }),
    { status: "blocked", reason: "indeterminate" },
  );
  assertBounded(seen, "authorization browser");
});
