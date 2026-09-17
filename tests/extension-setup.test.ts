import assert from "node:assert/strict";
import test from "node:test";
import { parseHTML } from "linkedom";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import ExtensionSetup from "../examples/web/extension-setup.js";

test("setup offers actual download and instructions, gates opening on versioned handshake", async () => {
  const { window, document } = parseHTML(
    '<html><body><div id="root"></div></body></html>',
  );
  const originals = new Map<string, PropertyDescriptor | undefined>();
  const calls: string[] = [];
  let enabled = false;
  const values: Record<string, unknown> = {
    window,
    document,
    IS_REACT_ACT_ENVIRONMENT: true,
    addEventListener: window.addEventListener.bind(window),
    removeEventListener: window.removeEventListener.bind(window),
    fetch: async () =>
      Response.json({
        version: "0.1.0",
        protocol: 1,
        extensionId: "a".repeat(32),
        downloadUrl: "/extension/ceremony-browser-login.zip",
        sha256: "0".repeat(64),
      }),
    chrome: {
      runtime: {
        sendMessage(
          _id: string,
          message: { type: string },
          callback: (reply: unknown) => void,
        ) {
          calls.push(message.type);
          callback(enabled ? { protocol: 1, version: "0.1.0" } : undefined);
        },
      },
    },
  };
  for (const [key, value] of Object.entries(values)) {
    originals.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, {
      value,
      configurable: true,
      writable: true,
    });
  }
  const root = createRoot(document.querySelector("#root")!);
  try {
    await act(async () => {
      root.render(createElement(ExtensionSetup));
    });
    assert.match(document.body.textContent!, /Load unpacked/);
    assert.match(document.body.textContent!, /manifest.json/);
    assert.equal(
      document.querySelector("a[download]")?.getAttribute("href"),
      "/extension/ceremony-browser-login.zip",
    );
    assert.match(document.body.textContent!, /Provider catalog/);
    assert.match(document.body.textContent!, /pending validation/);
    assert.match(document.body.textContent!, /multi-step mode/);
    const catalogHrefs = Array.from(
      document.querySelectorAll<HTMLAnchorElement>(
        'a[target="_blank"][rel="noopener noreferrer"]',
      ),
    ).map((anchor) => anchor.getAttribute("href"));
    assert.deepEqual(catalogHrefs, [
      "https://github.com/login",
      "https://accounts.google.com/ServiceLogin",
      "https://login.microsoftonline.com/",
    ]);
    const open = Array.from(document.querySelectorAll("button")).find(
      (button) => button.textContent === "Open browser login",
    )!;
    assert.equal(open.hasAttribute("disabled"), true);
    enabled = true;
    await act(async () => {
      window.dispatchEvent(new window.Event("focus"));
    });
    assert.equal(open.hasAttribute("disabled"), false);
    await act(async () => {
      open.click();
    });
    assert.equal(calls.at(-1), "ceremony.open");
  } finally {
    await act(async () => root.unmount());
    for (const [key, descriptor] of originals) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
    }
  }
});
