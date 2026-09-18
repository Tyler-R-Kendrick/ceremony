import assert from "node:assert/strict";
import test from "node:test";
import {
  createPlatform,
  type ExtensionPlatform,
} from "../extensions/browser-login/platform.js";

type Call = { name: string; args: unknown[] };

/**
 * Chromium's dialect: a trailing callback, a bare `undefined` return, and a
 * failure reported out of band on `runtime.lastError`.
 */
function chromiumShaped(options: { withBrowserAlias?: boolean } = {}) {
  const calls: Call[] = [];
  const failures = new Map<string, string>();
  const results = new Map<string, unknown>();
  const listeners = new Map<string, unknown[]>();
  const chrome: Record<string, unknown> = {};
  const answer =
    (name: string) =>
    (...args: unknown[]) => {
      calls.push({ name, args });
      const callback = args.at(-1);
      const failure = failures.get(name);
      (chrome["runtime"] as Record<string, unknown>)["lastError"] = failure
        ? { message: failure }
        : undefined;
      if (typeof callback === "function")
        (callback as (value: unknown) => void)(results.get(name));
      return undefined;
    };
  const event = (name: string) => ({
    addListener: (listener: unknown) => {
      listeners.set(name, [...(listeners.get(name) ?? []), listener]);
    },
  });
  Object.assign(chrome, {
    runtime: {
      id: "chromium-extension-id",
      lastError: undefined,
      getURL: (path: string) => `chrome-extension://abcdef/${path}`,
      getManifest: () => ({ version: "0.1.0" }),
      connect: answer("runtime.connect"),
      sendMessage: answer("runtime.sendMessage"),
      onMessage: event("runtime.onMessage"),
      onMessageExternal: event("runtime.onMessageExternal"),
      onConnect: event("runtime.onConnect"),
      onConnectExternal: event("runtime.onConnectExternal"),
    },
    action: { onClicked: event("action.onClicked") },
    tabs: {
      query: answer("tabs.query"),
      get: answer("tabs.get"),
      create: answer("tabs.create"),
      sendMessage: answer("tabs.sendMessage"),
    },
    scripting: { executeScript: answer("scripting.executeScript") },
    permissions: {
      request: answer("permissions.request"),
      contains: answer("permissions.contains"),
    },
    storage: {
      session: {
        get: answer("storage.session.get"),
        set: answer("storage.session.set"),
        remove: answer("storage.session.remove"),
      },
    },
  });
  // Chromium ships a `browser` global of its own, and it is a different object
  // rather than an alias. A platform that read it as evidence of Gecko would
  // silently drop document-bound delivery on the engine that supports it.
  const scope = options.withBrowserAlias
    ? { browser: structuredCloneShape(chrome), chrome }
    : { chrome };
  return { scope, calls, failures, results, listeners };
}

/** A `browser` object that names Chromium, exactly as Chromium's alias does. */
function structuredCloneShape(chrome: Record<string, unknown>) {
  return {
    runtime: {
      id: "chromium-extension-id",
      getURL: (path: string) => `chrome-extension://abcdef/${path}`,
      getManifest: () => ({ version: "0.1.0" }),
      onMessage: { addListener: () => {} },
    },
    tabs: {
      get: () => {
        throw new Error("the browser alias must not be used on Chromium");
      },
    },
    scripting: chrome["scripting"],
  };
}

/** Gecko's dialect: promises, no trailing callback, no `lastError`. */
function geckoShaped() {
  const calls: Call[] = [];
  const failures = new Map<string, string>();
  const results = new Map<string, unknown>();
  const listeners = new Map<string, unknown[]>();
  const answer =
    (name: string) =>
    async (...args: unknown[]) => {
      calls.push({ name, args });
      const failure = failures.get(name);
      if (failure) throw new Error(failure);
      return results.get(name);
    };
  const event = (name: string) => ({
    addListener: (listener: unknown) => {
      listeners.set(name, [...(listeners.get(name) ?? []), listener]);
    },
  });
  const browser = {
    runtime: {
      id: "gecko-extension-id",
      getURL: (path: string) => `moz-extension://abcdef-uuid/${path}`,
      getManifest: () => ({ version: "0.1.0" }),
      connect: (info: unknown) => {
        calls.push({ name: "runtime.connect", args: [info] });
        return results.get("runtime.connect");
      },
      sendMessage: answer("runtime.sendMessage"),
      onMessage: event("runtime.onMessage"),
      onConnect: event("runtime.onConnect"),
      // Gecko exposes neither webpage-facing event; the facade must treat a
      // missing event as "never fires", not as an error.
    },
    action: { onClicked: event("action.onClicked") },
    tabs: {
      query: answer("tabs.query"),
      get: answer("tabs.get"),
      create: answer("tabs.create"),
      sendMessage: answer("tabs.sendMessage"),
    },
    scripting: { executeScript: answer("scripting.executeScript") },
    permissions: {
      request: answer("permissions.request"),
      contains: answer("permissions.contains"),
    },
    storage: {
      session: {
        get: answer("storage.session.get"),
        set: answer("storage.session.set"),
        remove: answer("storage.session.remove"),
      },
    },
  };
  return { scope: { browser }, calls, failures, results, listeners };
}

async function exerciseEveryCall(platform: ExtensionPlatform) {
  await platform.tabs.query({});
  await platform.tabs.get(7);
  await platform.tabs.create({ url: "moz-extension://x/ui.html" });
  await platform.tabs.sendMessage(7, { type: "observe" });
  await platform.tabs.sendMessage(7, { type: "observe" }, { frameId: 0 });
  await platform.scripting.executeScript({
    target: { tabId: 7 },
    files: ["content.js"],
  });
  await platform.permissions.contains({ origins: ["https://owned.example/*"] });
  await platform.permissions.request({ origins: ["https://owned.example/*"] });
  await platform.sessionStorage.get("run");
  await platform.sessionStorage.set({ run: 1 });
  await platform.sessionStorage.remove("run");
  await platform.runtime.sendMessage({ type: "ceremony.ping", protocol: 1 });
}

test("the facade drives Chromium through callbacks and Gecko through promises", async () => {
  const chromium = chromiumShaped();
  const chromiumPlatform = createPlatform(chromium.scope);
  assert.equal(chromiumPlatform.style, "callback");
  assert.equal(chromiumPlatform.capabilities.documentIdMessaging, true);
  assert.equal(chromiumPlatform.capabilities.externalWebMessaging, true);
  await exerciseEveryCall(chromiumPlatform);
  for (const call of chromium.calls)
    assert.equal(
      typeof call.args.at(-1),
      "function",
      `${call.name} must be called with a trailing callback on Chromium`,
    );
  assert.deepEqual(
    chromium.calls.find((call) => call.name === "tabs.sendMessage")?.args
      .length,
    3,
    "omitted options must not become an undefined positional argument",
  );

  const gecko = geckoShaped();
  const geckoPlatform = createPlatform(gecko.scope);
  assert.equal(geckoPlatform.style, "promise");
  assert.equal(geckoPlatform.capabilities.documentIdMessaging, false);
  assert.equal(geckoPlatform.capabilities.externalWebMessaging, false);
  await exerciseEveryCall(geckoPlatform);
  for (const call of gecko.calls)
    assert.ok(
      call.args.every((argument) => typeof argument !== "function"),
      `${call.name} must not receive a callback on Gecko`,
    );
  assert.deepEqual(
    gecko.calls.map((call) => call.name),
    chromium.calls.map((call) => call.name),
    "both dialects must reach the same underlying calls in the same order",
  );
});

test("a `browser` global is not evidence of Gecko; the extension URL is", async () => {
  // Chromium defines `browser` alongside `chrome`. Resolving `browser ?? chrome`
  // still has to land on Chromium's documented namespace and its document-bound
  // delivery, so the alias here throws if the facade ever calls through it.
  const chromium = chromiumShaped({ withBrowserAlias: true });
  const platform = createPlatform(chromium.scope);
  assert.equal(platform.style, "callback");
  assert.equal(platform.capabilities.documentIdMessaging, true);
  chromium.results.set("tabs.get", { id: 7, url: "https://owned.example/" });
  assert.deepEqual(await platform.tabs.get(7), {
    id: 7,
    url: "https://owned.example/",
  });
  assert.equal(platform.runtime.id, "chromium-extension-id");
  assert.equal(platform.runtime.getManifestVersion(), "0.1.0");
  assert.equal(
    platform.runtime.getURL("ui.html"),
    "chrome-extension://abcdef/ui.html",
  );
});

test("results and failures cross both dialects the same way", async () => {
  const chromium = chromiumShaped();
  const chromiumPlatform = createPlatform(chromium.scope);
  chromium.results.set("permissions.contains", true);
  assert.equal(
    await chromiumPlatform.permissions.contains({ origins: ["https://a/*"] }),
    true,
  );
  chromium.results.set("storage.session.get", { run: { tabId: 7 } });
  assert.deepEqual(await chromiumPlatform.sessionStorage.get("run"), {
    run: { tabId: 7 },
  });
  // Out-of-band failure must become a rejection: every caller in the worker
  // refuses on a thrown error and would otherwise read `undefined` as success.
  chromium.failures.set("tabs.get", "No tab with id: 7.");
  await assert.rejects(
    () => chromiumPlatform.tabs.get(7),
    /No tab with id: 7\./,
  );
  // And the failure must not stick to the next call.
  chromium.failures.delete("tabs.get");
  chromium.results.set("tabs.get", { id: 7 });
  assert.deepEqual(await chromiumPlatform.tabs.get(7), { id: 7 });

  const gecko = geckoShaped();
  const geckoPlatform = createPlatform(gecko.scope);
  gecko.results.set("permissions.contains", false);
  assert.equal(
    await geckoPlatform.permissions.contains({ origins: ["https://a/*"] }),
    false,
  );
  gecko.failures.set("tabs.sendMessage", "Receiving end does not exist.");
  await assert.rejects(
    () => geckoPlatform.tabs.sendMessage(7, { type: "observe" }),
    /Receiving end does not exist\./,
  );
});

test("a callback dialect that answers a promise anyway settles once, from the promise", async () => {
  // The extension UI is exercised in tests against a hand-built `chrome` whose
  // methods are `async`. Preferring the promise keeps one settlement, and the
  // one that can carry a rejection.
  const calls: Call[] = [];
  const scope = {
    chrome: {
      runtime: {
        id: "hybrid",
        getURL: (path: string) => path,
        getManifest: () => ({ version: "0.1.0" }),
        sendMessage: async (...args: unknown[]) => {
          calls.push({ name: "runtime.sendMessage", args });
          return { status: "submitted-unverified" };
        },
        onMessage: { addListener: () => {} },
      },
      tabs: {
        query: async (...args: unknown[]) => {
          calls.push({ name: "tabs.query", args });
          return [{ id: 1, url: "https://fixture.test/login" }];
        },
      },
      permissions: { request: async () => true },
    },
  };
  const platform = createPlatform(scope);
  assert.equal(platform.style, "callback");
  assert.deepEqual(await platform.runtime.sendMessage({ type: "inspect" }), {
    status: "submitted-unverified",
  });
  assert.deepEqual(await platform.tabs.query({}), [
    { id: 1, url: "https://fixture.test/login" },
  ]);
  assert.equal(await platform.permissions.request({ origins: [] }), true);
  assert.equal(calls.length, 2);
});

test("absent APIs refuse rather than pretend, and absent events are inert", async () => {
  const gecko = geckoShaped();
  const platform = createPlatform(gecko.scope);
  // Gecko has no webpage-facing external messaging at all. Registering must be
  // a no-op so the worker can register both bridges unconditionally.
  platform.runtime.onMessageExternal(() => {});
  platform.runtime.onConnectExternal(() => {});
  assert.equal(gecko.listeners.has("runtime.onMessageExternal"), false);
  assert.equal(gecko.listeners.has("runtime.onConnectExternal"), false);
  platform.runtime.onMessage(() => {});
  platform.runtime.onConnect(() => {});
  platform.action.onClicked(() => {});
  assert.equal(gecko.listeners.get("runtime.onMessage")?.length, 1);
  assert.equal(gecko.listeners.get("runtime.onConnect")?.length, 1);
  assert.equal(gecko.listeners.get("action.onClicked")?.length, 1);

  const bare = createPlatform({
    chrome: { runtime: { id: "bare", getURL: (path: string) => path } },
  });
  await assert.rejects(
    () => bare.tabs.get(1),
    /Unsupported extension API: get/,
  );
  await assert.rejects(
    () => bare.sessionStorage.get("run"),
    /Unsupported extension API: get/,
  );
  assert.throws(() => createPlatform({}), /No WebExtension API in this scope/);
});

test("ports are handed through unchanged so a sender stays the browser's word", () => {
  const gecko = geckoShaped();
  const port = {
    name: "ceremony.handoffs",
    sender: { id: "gecko-extension-id", url: "http://127.0.0.1:4173/" },
    postMessage: () => {},
    disconnect: () => {},
    onMessage: { addListener: () => {} },
    onDisconnect: { addListener: () => {} },
  };
  gecko.results.set("runtime.connect", port);
  const platform = createPlatform(gecko.scope);
  const opened = platform.runtime.connect({ name: "ceremony.handoffs" });
  assert.equal(opened, port);
  assert.deepEqual(
    gecko.calls.find((call) => call.name === "runtime.connect")?.args,
    [{ name: "ceremony.handoffs" }],
  );
});
