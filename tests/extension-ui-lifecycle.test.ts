import assert from "node:assert/strict";
import test from "node:test";
import { createRequire } from "node:module";
import { runInNewContext } from "node:vm";
import { readFile } from "node:fs/promises";
import { build } from "esbuild";
import { parseHTML } from "linkedom";

const identifier = "11111111-1111-4111-8111-111111111111";
const submit = "22222222-2222-4222-8222-222222222222";
const form = "33333333-3333-4333-8333-333333333333";
const page = {
  document: form,
  origin: "https://fixture.test",
  challenge: false,
  passkey: false,
  controls: [
    {
      ref: identifier,
      kind: "unknown",
      label: "Account",
      form,
      recipient: "https://fixture.test/login",
    },
    {
      ref: submit,
      kind: "submit",
      label: "Login",
      form,
      recipient: "https://fixture.test/login",
    },
  ],
};
const proposal = { data: { step: { mapping: { identifier, submit } } } };
const bundled = await build({
  entryPoints: [
    new URL("../extensions/browser-login/ui.ts", import.meta.url).pathname,
  ],
  bundle: true,
  packages: "external",
  format: "cjs",
  platform: "node",
  write: false,
});
const html = await readFile(
  new URL("../extensions/browser-login/ui.html", import.meta.url),
  "utf8",
);
async function flush() {
  for (let i = 0; i < 20; i++) await Promise.resolve();
}
function fixture() {
  const { window, document } = parseHTML(html);
  let now = 1000;
  let sequence = 0;
  const timers = new Map<number, { at: number; callback: () => void }>();
  const workers: FakeWorker[] = [];
  const messages: { type: string; runId?: string }[] = [];
  let cancel: () => Promise<unknown> = async () => ({});
  let expires = now + 120_000;
  class FakeWorker {
    terminated = false;
    onmessage?: (event: typeof proposal) => void;
    onerror?: () => void;
    constructor() {
      workers.push(this);
    }
    terminate() {
      this.terminated = true;
    }
    postMessage() {}
  }
  runInNewContext(bundled.outputFiles[0]!.text, {
    require: createRequire(import.meta.url),
    document,
    URL,
    Date: { now: () => now },
    setTimeout(callback: () => void, delay: number) {
      const id = ++sequence;
      timers.set(id, { at: now + delay, callback });
      return id;
    },
    clearTimeout(id: number) {
      timers.delete(id);
    },
    Worker: FakeWorker,
    addEventListener: window.addEventListener.bind(window),
    chrome: {
      permissions: { request: async () => true },
      tabs: {
        query: async () => [{ id: 1, url: "https://fixture.test/login" }],
      },
      runtime: {
        getURL: (path: string) => path,
        sendMessage: async (message: { type: string; runId?: string }) => {
          messages.push(message);
          if (message.type === "inspect") return { runId: form, page, expires };
          if (message.type === "cancel") return cancel();
          return { status: "submitted-unverified" };
        },
      },
    },
  });
  const button = (id: string) =>
    document.querySelector<HTMLButtonElement>(`#${id}`)!;
  const status = () => document.querySelector("#status")!.textContent;
  const review = () => document.querySelector<HTMLElement>("#review")!.hidden;
  document.querySelector<HTMLInputElement>("#target")!.value =
    "https://fixture.test/login";
  return {
    button,
    status,
    review,
    timers,
    workers,
    messages,
    document,
    async inspect() {
      button("inspect").click();
      await flush();
    },
    async click(id: string) {
      button(id).click();
      await flush();
    },
    setExpiry(value: number) {
      expires = value;
    },
    setCancel(fn: typeof cancel) {
      cancel = fn;
    },
    jump(value: number) {
      now = value;
    },
    advance(value: number) {
      now += value;
      for (const [id, timer] of timers)
        if (timer.at <= now) {
          timers.delete(id);
          timer.callback();
        }
    },
    hide() {
      window.dispatchEvent(new window.Event("pagehide"));
    },
  };
}

for (const action of ["cancel", "inspect", "pagehide"] as const) {
  test(`${action} clears the model timer and ignores obsolete worker callbacks`, async () => {
    const f = fixture();
    await f.inspect();
    await f.click("infer");
    const old = f.workers[0]!;
    assert.equal(f.button("infer").disabled, true);
    if (action === "pagehide") f.hide();
    else await f.click(action);
    assert.equal(old.terminated, true);
    assert.equal(f.button("infer").disabled, false);
    assert.ok([...f.timers.values()].every((timer) => timer.at !== 181000));
    const status = f.status();
    old.onmessage?.(proposal);
    old.onerror?.();
    assert.equal(f.status(), status);
    if (action !== "pagehide") {
      await f.inspect();
      await f.click("infer");
      assert.equal(f.workers.length, 2);
      old.onerror?.();
      assert.equal(f.button("infer").disabled, true);
      f.workers[1]!.onmessage?.(proposal);
      assert.equal(f.review(), false);
      assert.equal(f.button("infer").disabled, false);
    }
  });
}

test("observation expiry stops inference at 120s, hides review and requires reinspection", async () => {
  const f = fixture();
  await f.inspect();
  await f.click("infer");
  f.advance(120_000);
  assert.equal(f.workers[0]!.terminated, true);
  assert.equal(f.button("infer").hidden, true);
  assert.equal(f.review(), true);
  assert.match(f.status()!, /expired.*inspect again/i);
  f.workers[0]!.onmessage?.(proposal);
  assert.equal(f.review(), true);
  const status = f.status();
  f.advance(60_000);
  assert.equal(f.status(), status);
});

for (const action of ["infer", "reply", "approve"] as const) {
  test(`expired observation is rejected on ${action} even before a delayed timer fires`, async () => {
    const f = fixture();
    await f.inspect();
    if (action !== "infer") await f.click("infer");
    if (action === "approve") {
      f.workers[0]!.onmessage?.(proposal);
      assert.equal(f.review(), false);
      f.document.querySelector<HTMLInputElement>("#username")!.value =
        "synthetic-user";
    }
    f.jump(121000);
    if (action === "reply") f.workers[0]!.onmessage?.(proposal);
    else await f.click(action);
    assert.equal(f.review(), true);
    assert.match(f.status()!, /expired.*inspect again/i);
    assert.equal(
      f.messages.some((message) => message.type === "submit"),
      false,
    );
    assert.equal(f.workers.length, action === "infer" ? 0 : 1);
  });
}

test("an already expired inspection reply cannot offer inference", async () => {
  const f = fixture();
  f.setExpiry(1000);
  await f.inspect();
  assert.equal(f.button("infer").hidden, true);
  assert.match(f.status()!, /expired.*inspect again/i);
});

test("expiry removes an already offered mapping and credentials", async () => {
  const f = fixture();
  await f.inspect();
  await f.click("infer");
  f.workers[0]!.onmessage?.(proposal);
  assert.equal(f.review(), false);
  f.document.querySelector<HTMLInputElement>("#password")!.value =
    "synthetic-password";
  f.advance(119999);
  assert.equal(f.review(), false);
  f.advance(1);
  assert.equal(f.review(), true);
  assert.equal(
    f.document.querySelector<HTMLInputElement>("#password")!.value,
    "",
  );
  assert.match(f.status()!, /expired.*inspect again/i);
});

test("pending cancellation hides review immediately and cannot reset a new inspection", async () => {
  const f = fixture();
  await f.inspect();
  await f.click("infer");
  f.workers[0]!.onmessage?.(proposal);
  let resolve!: (value: unknown) => void;
  f.setCancel(
    () =>
      new Promise((done) => {
        resolve = done;
      }),
  );
  await f.click("cancel");
  assert.equal(f.review(), true);
  await f.inspect();
  const status = f.status();
  resolve({});
  await flush();
  assert.equal(f.status(), status);
  await f.click("infer");
  assert.equal(f.workers.length, 2);
});
