import assert from "node:assert/strict";
import test from "node:test";
import { createRequire } from "node:module";
import { runInNewContext } from "node:vm";
import { build } from "esbuild";

/**
 * The two Gecko-only mechanics, in isolation.
 *
 * Chromium binds a message to a document id and refuses delivery elsewhere.
 * Gecko offers no such option, so the binding moves into the message: the
 * worker names the document it observed, and the isolated world answers only to
 * its own name. Neither half is reachable from the Chromium end-to-end tests
 * and Playwright cannot open `moz-extension:` pages, so both halves are driven
 * here against a Gecko-shaped API.
 */
const require = createRequire(import.meta.url);

/**
 * Values that crossed out of the VM realm carry that realm's prototypes, which
 * a strict deep comparison treats as a difference. Only the data is under test.
 */
function plain<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

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

const workerBundle = await bundle("worker.ts");
const contentBundle = await bundle("content.ts");

const origin = "https://owned.example";
const appOrigin = "http://127.0.0.1:4173";
const identifier = "00000000-0000-4000-8000-000000000011";
const password = "00000000-0000-4000-8000-000000000012";
const submit = "00000000-0000-4000-8000-000000000013";
const form = "00000000-0000-4000-8000-000000000014";
const documentRef = "00000000-0000-4000-8000-000000000015";

function observation(document: string) {
  return {
    document,
    origin,
    challenge: false,
    passkey: false,
    controls: [
      {
        ref: identifier,
        kind: "identifier",
        label: "Username",
        form,
        recipient: `${origin}/login`,
      },
      {
        ref: password,
        kind: "password",
        label: "Password",
        form,
        recipient: `${origin}/login`,
      },
      {
        ref: submit,
        kind: "submit",
        label: "Sign in",
        form,
        recipient: `${origin}/login`,
      },
    ],
  };
}

type Listener = (
  message: unknown,
  sender: { id?: string; url?: string; tab?: unknown },
  reply: (value: unknown) => void,
) => boolean | void;

/** A Gecko-shaped worker host: promises, no document ids, a relay bridge. */
function workerHost(appBridge: "content-relay" | "externally-connectable") {
  const listeners: Listener[] = [];
  const sent: { tabId: number; message: unknown; options?: unknown }[] = [];
  const stored = new Map<string, unknown>();
  const extensionUrl = "moz-extension://abcdef-uuid/";
  let uuid = 0;
  const observed = observation(documentRef);
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
    browser: {
      runtime: {
        id: "gecko-extension-id",
        getURL: (path: string) => `${extensionUrl}${path}`,
        getManifest: () => ({ version: "0.1.0" }),
        onMessage: {
          addListener: (listener: Listener) => listeners.push(listener),
        },
        onConnect: { addListener: () => {} },
      },
      action: { onClicked: { addListener: () => {} } },
      tabs: {
        get: async (id: number) => ({ id, url: `${origin}/login` }),
        create: async () => ({}),
        sendMessage: async (
          tabId: number,
          message: unknown,
          options?: unknown,
        ) => {
          sent.push({ tabId, message, options });
          const type = (message as { type?: string }).type;
          if (type === "observe") return observed;
          return { status: "submitted-unverified" };
        },
      },
      scripting: {
        // Gecko returns an injection result with no document id at all.
        executeScript: async () => [{}],
      },
      permissions: { contains: async () => true },
      storage: {
        session: {
          get: async (key: string) =>
            stored.has(key) ? { [key]: stored.get(key) } : {},
          set: async (value: Record<string, unknown>) => {
            for (const [key, item] of Object.entries(value))
              stored.set(key, item);
          },
          remove: async (key: string) => void stored.delete(key),
        },
      },
    },
  };
  runInNewContext(workerBundle, context);
  const ask = (message: unknown, sender: Record<string, unknown>) =>
    new Promise<unknown>((resolve) => {
      let answered = false;
      for (const listener of listeners) {
        const handled = listener(message, sender, (value) => {
          if (answered) return;
          answered = true;
          resolve(value);
        });
        if (handled === true) return;
      }
      if (!answered) resolve(undefined);
    });
  return {
    sent,
    stored,
    fromUi: (message: unknown) =>
      ask(message, {
        id: "gecko-extension-id",
        url: `${extensionUrl}ui.html`,
      }),
    fromRelay: (request: unknown, url: string) =>
      ask(
        { type: "ceremony.relay", request },
        { id: "gecko-extension-id", url, tab: { id: 3 } },
      ),
    fromStranger: (request: unknown, url: string) =>
      ask(
        { type: "ceremony.relay", request },
        { id: "another-extension", url, tab: { id: 3 } },
      ),
  };
}

test("without document ids the worker names the document in the message", async () => {
  const host = workerHost("content-relay");
  const inspected = (await host.fromUi({
    type: "inspect",
    tabId: 7,
    origin,
  })) as { runId?: string; page?: { document?: string } };
  assert.equal(inspected.page?.document, documentRef);
  assert.ok(inspected.runId);

  // The observation itself is addressed by frame, because the document that
  // will answer has not named itself yet; nothing carries a document id.
  const observe = plain(host.sent.at(-1)!);
  assert.deepEqual(observe.message, { type: "observe" });
  assert.deepEqual(observe.options, { frameId: 0 });

  // The run is bound to the reference the isolated world minted, so it is as
  // specific as Chromium's document id and just as unguessable.
  assert.equal(
    (host.stored.get(inspected.runId!) as { documentId?: string }).documentId,
    documentRef,
  );

  const applied = await host.fromUi({
    type: "submit",
    runId: inspected.runId,
    mapping: { identifier, password, submit },
    username: "owner",
    password: "fixture-pass",
  });
  assert.deepEqual(plain(applied), { status: "submitted-unverified" });
  const apply = plain(host.sent.at(-1)!);
  const message = apply.message as { type: string; document?: string };
  assert.equal(message.type, "apply");
  assert.equal(message.document, documentRef);
  assert.deepEqual(apply.options, { frameId: 0 });
  // Reserve before dispatch still holds: the run cannot be submitted twice.
  assert.equal(
    (host.stored.get(inspected.runId!) as { dispatched?: boolean }).dispatched,
    true,
  );
  await assert.doesNotReject(async () => {
    const replay = await host.fromUi({
      type: "submit",
      runId: inspected.runId,
      mapping: { identifier, password, submit },
      username: "owner",
      password: "fixture-pass",
    });
    assert.deepEqual(plain(replay), {
      error:
        "Operation refused or uncertain; inspect the tab before continuing.",
    });
  });
});

test("the relay bridge admits exactly the configured app origin", async () => {
  const host = workerHost("content-relay");
  const request = { type: "ceremony.ping", protocol: 1 };
  assert.deepEqual(
    plain(await host.fromRelay(request, `${appOrigin}/index.html`)),
    {
      protocol: 1,
      version: "0.1.0",
    },
  );
  for (const url of [
    "http://127.0.0.1:4174/index.html",
    "https://127.0.0.1:4173/index.html",
    "http://evil.example/index.html",
  ])
    assert.deepEqual(plain(await host.fromRelay(request, url)), {
      error: "unapproved-origin",
    });
  assert.deepEqual(
    plain(
      await host.fromRelay({ type: "ceremony.drive", protocol: 1 }, appOrigin),
    ),
    { error: "unsupported-request" },
  );
  // Not our content script: the sender id the browser attests is the only
  // thing that says this message came from the relay we shipped.
  assert.equal(
    await host.fromStranger(request, `${appOrigin}/index.html`),
    undefined,
  );
});

test("an artifact built for the other bridge refuses relayed requests", async () => {
  // The Chromium artifact carries the same worker. Its manifest never registers
  // a relay, and if a relayed message reached it anyway it must not be answered
  // on a path that manifest does not admit.
  const host = workerHost("externally-connectable");
  assert.deepEqual(
    plain(
      await host.fromRelay(
        { type: "ceremony.ping", protocol: 1 },
        `${appOrigin}/index.html`,
      ),
    ),
    { error: "unavailable" },
  );
});

/** A document that only answers to its own name. */
function contentHost() {
  const listeners: Listener[] = [];
  let uuid = 0;
  const context = {
    console,
    require,
    URL,
    Event: class {
      constructor(public type: string) {}
    },
    crypto: {
      randomUUID: () =>
        `00000000-0000-4000-8000-${String(++uuid).padStart(12, "0")}`,
    },
    MutationObserver: class {
      observe() {}
      takeRecords() {
        return [];
      }
    },
    location: {
      origin,
      hostname: "owned.example",
      pathname: "/account",
    },
    document: { forms: [], querySelector: () => null },
    getComputedStyle: () => ({ visibility: "visible" }),
    HTMLElement: class {},
    HTMLInputElement: class {},
    HTMLButtonElement: class {},
    HTMLDataElement: class {},
    browser: {
      runtime: {
        id: "gecko-extension-id",
        getURL: (path: string) => `moz-extension://abcdef-uuid/${path}`,
        onMessage: {
          addListener: (listener: Listener) => listeners.push(listener),
        },
      },
    },
  };
  runInNewContext(contentBundle, context);
  // The first reference this document mints is its own.
  const mine = "00000000-0000-4000-8000-000000000001";
  return {
    mine,
    deliver(message: unknown, sender: Record<string, unknown> = {}) {
      let answer: unknown;
      let answered = false;
      for (const listener of listeners)
        listener(
          { ...(message as object) },
          { id: "gecko-extension-id", ...sender },
          (value) => {
            answered = true;
            answer = value;
          },
        );
      return plain({ answered, answer });
    },
  };
}

test("the isolated world answers only to the document the worker observed", () => {
  const page = contentHost();
  const stranger = "00000000-0000-4000-8000-0000000000ff";

  // A message naming another document is refused outright, before any of the
  // work the message asks for.
  for (const type of ["apply", "verify-fixture", "observe"])
    assert.deepEqual(
      page.deliver({ type, document: stranger, origin, expectedAccount: "a" }),
      { answered: true, answer: { status: "refused" } },
    );

  // Naming this document gets the ordinary handling: the fixture verifier still
  // has to find its account element, and does not.
  assert.deepEqual(
    page.deliver({
      type: "verify-fixture",
      document: page.mine,
      origin,
      expectedAccount: "account-1",
    }),
    { answered: true, answer: { verified: false } },
  );

  // A message with no document named at all is the Chromium shape, where the
  // browser bound delivery instead. It is handled, not refused.
  assert.deepEqual(
    page.deliver({
      type: "verify-fixture",
      origin,
      expectedAccount: "account-1",
    }),
    { answered: true, answer: { verified: false } },
  );

  // Sender checks are untouched: another extension, or a page, gets nothing.
  assert.equal(
    page.deliver(
      { type: "verify-fixture", document: page.mine, origin },
      { id: "another-extension" },
    ).answered,
    false,
  );
  assert.equal(
    page.deliver(
      { type: "verify-fixture", document: page.mine, origin },
      { tab: { id: 3 } },
    ).answered,
    false,
  );
});
