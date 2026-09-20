import assert from "node:assert/strict";
import test from "node:test";
import { createRequire } from "node:module";
import { runInNewContext } from "node:vm";
import { build } from "esbuild";

/**
 * BRIDGE-ORIGIN and BRIDGE-REPLAY on the bridge nothing was driving.
 *
 * The app bridge exists in two mutually exclusive shapes. Gecko has no
 * webpage-to-extension messaging, so its artifact ships a content script that
 * relays; Chromium admits the page directly through `externally_connectable`.
 * `extension-firefox-binding` drives the relay's admission thoroughly - exact
 * origin in, wrong port, wrong scheme and wrong host out, a stranger's sender
 * id ignored - and that is the Gecko path.
 *
 * The Chromium path had no such case. `extension-platform` covers the facade's
 * registration plumbing, which is a different question: it asserts that
 * registering `onMessageExternal` on Gecko is a no-op, never that admitting a
 * message on Chromium checks anything. So the primary bridge's origin
 * admission was resting on `answerApp` being shared with the relay, which is
 * true today and is not a test.
 *
 * What differs between the two is exactly where a mistake would live: the
 * relay derives the origin from the content script's document and the external
 * listener derives it from `sender.url`. That derivation is the subject here.
 */
async function bundle(entry: string) {
  const built = await build({
    entryPoints: [
      new URL(`../extensions/browser-login/${entry}`, import.meta.url).pathname,
    ],
    bundle: true,
    packages: "external",
    format: "cjs",
    platform: "node",
    write: false,
  });
  return built.outputFiles[0]!.text;
}

const require = createRequire(import.meta.url);
const workerBundle = await bundle("worker.ts");

/** Values crossing out of the VM realm carry its prototypes; only data matters. */
function plain<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

type Listener = (
  message: unknown,
  sender: { id?: string; url?: string; tab?: unknown },
  reply: (value: unknown) => void,
) => boolean | void;

const appOrigin = "http://127.0.0.1:4173";

/** A Chromium-shaped worker host: `chrome.*`, and a real external bridge. */
function workerHost(appBridge: "content-relay" | "externally-connectable") {
  const external: Listener[] = [];
  const internal: Listener[] = [];
  const extensionUrl = "chrome-extension://abcdefghijklmnopabcdefghijklmnop/";
  let uuid = 0;
  const context = {
    console,
    require,
    URL,
    Date,
    setTimeout,
    clearTimeout,
    crypto: {
      randomUUID: () =>
        `00000000-0000-4000-8000-${String(++uuid).padStart(12, "0")}`,
    },
    fetch: async (url: string) => {
      assert.equal(url, `${extensionUrl}config.json`);
      return { json: async () => ({ appOrigins: [appOrigin], appBridge }) };
    },
    chrome: {
      runtime: {
        id: "chromium-extension-id",
        getURL: (path: string) => `${extensionUrl}${path}`,
        getManifest: () => ({ version: "0.1.0" }),
        onMessage: {
          addListener: (listener: Listener) => internal.push(listener),
        },
        onMessageExternal: {
          addListener: (listener: Listener) => external.push(listener),
        },
        onConnect: { addListener: () => {} },
        onConnectExternal: { addListener: () => {} },
      },
      action: { onClicked: { addListener: () => {} } },
      tabs: {
        query: async () => [],
        get: async (id: number) => ({ id, url: `${appOrigin}/login` }),
        create: async () => ({}),
        sendMessage: async () => ({ status: "submitted-unverified" }),
      },
      scripting: { executeScript: async () => [{}] },
      permissions: { contains: async () => true },
      storage: {
        session: {
          get: async () => ({}),
          set: async () => {},
          remove: async () => {},
        },
      },
    },
  };
  runInNewContext(workerBundle, context);

  const ask = (listeners: Listener[], message: unknown, sender: object) =>
    new Promise<unknown>((resolve) => {
      let answered = false;
      for (const listener of listeners) {
        const handled = listener(
          message,
          sender as Parameters<Listener>[1],
          (value) => {
            if (answered) return;
            answered = true;
            resolve(value);
          },
        );
        if (handled === true) return;
      }
      if (!answered) resolve(undefined);
    });

  return {
    /** A web page reaching the extension directly, as Chromium allows. */
    fromPage: (request: unknown, url: string) =>
      ask(external, request, { url, tab: { id: 3 } }),
    /** The extension's own UI, which is the only privileged sender. */
    fromUi: (message: unknown) =>
      ask(internal, message, {
        id: "chromium-extension-id",
        url: `${extensionUrl}ui.html`,
      }),
  };
}

test("BRIDGE-ORIGIN: the external bridge admits exactly the configured origin", async () => {
  const host = workerHost("externally-connectable");
  const request = { type: "ceremony.ping", protocol: 1 };

  assert.deepEqual(plain(await host.fromPage(request, `${appOrigin}/app`)), {
    protocol: 1,
    version: "0.1.0",
  });

  // Equality on the whole origin, not a prefix, a suffix or a host. Each of
  // these is a real way an allowlist gets this wrong, and the port is the one
  // a manifest match pattern cannot express at all - so it has to hold here.
  for (const url of [
    "http://127.0.0.1:4174/app",
    "https://127.0.0.1:4173/app",
    "http://localhost:4173/app",
    "http://127.0.0.1:4173.evil.example/app",
    "http://evil.example/app",
  ])
    assert.deepEqual(plain(await host.fromPage(request, url)), {
      error: "unapproved-origin",
    });
});

test("BRIDGE-ORIGIN: a sender with no attested URL is refused, not defaulted", async () => {
  // The origin is whatever the browser attests for the sender. A message with
  // none is the case where guessing is tempting and wrong: there is no
  // "probably the app" here, and treating absence as the configured origin
  // would admit precisely the sender that could not prove it was one.
  const host = workerHost("externally-connectable");
  assert.deepEqual(
    plain(await host.fromPage({ type: "ceremony.ping", protocol: 1 }, "")),
    { error: "unapproved-origin" },
  );
});

test("BRIDGE-ORIGIN: the external bridge is closed in a relay build", async () => {
  // Each artifact answers only on the bridge its own manifest admits. A build
  // that ships the relay must not also accept direct page messages, or the
  // Gecko artifact's narrower surface would be a claim rather than a fact.
  const host = workerHost("content-relay");
  assert.deepEqual(
    plain(
      await host.fromPage(
        { type: "ceremony.ping", protocol: 1 },
        `${appOrigin}/app`,
      ),
    ),
    { error: "unavailable" },
  );
});

test("BRIDGE-REPLAY: an admitted origin still reaches only the two external verbs", async () => {
  // Admission is not authority. The origin check says who may speak; it says
  // nothing about what they may ask for, and the privileged commands the UI
  // uses must stay unreachable from a page that passed the origin test.
  //
  // This is the half that keeps F-EXTERNAL true: the extension is not an agent
  // execution service, and an admitted origin is still not one either.
  const host = workerHost("externally-connectable");
  for (const type of ["inspect", "submit", "release", "ceremony.drive"])
    assert.deepEqual(
      plain(await host.fromPage({ type, protocol: 1 }, `${appOrigin}/app`)),
      { error: "unsupported-request" },
    );
});
