import assert from "node:assert/strict";
import { test } from "node:test";
import { parseHTML } from "linkedom";
import { snapshotPage } from "../src/server/browser-executor.js";

// Execute the actual evaluate callback in Node so mutation helpers stay in scope.
// Chromium tests separately prove serialization and native label association.
const page: Parameters<typeof snapshotPage>[0] = {
  url: () => "https://provider.test/login?private-query=value#private-fragment",
  evaluate: async <R, Arg>(
    fn: string | ((arg: Arg) => R | Promise<R>),
    arg: Arg,
  ) => {
    assert.equal(typeof fn, "function");
    if (typeof fn !== "function") throw new Error("Expected snapshot callback");
    return await fn(arg);
  },
};

for (const [kind, labels, aria, expected] of [
  ["absent collection", undefined, undefined, undefined],
  ["empty collection", [], undefined, undefined],
  ["null text", [{ textContent: null }], undefined, undefined],
  [
    "trimmed first label",
    [{ textContent: "  Account choice  " }],
    undefined,
    "Account choice",
  ],
  [
    "ARIA precedence",
    [{ textContent: "Wrapping label" }],
    "ARIA account",
    "ARIA account",
  ],
] as const)
  test(`snapshot preserves native label semantics (${kind})`, async (t) => {
    const { document } = parseHTML("<html><body><input></body></html>");
    // Linkedom does not implement HTMLInputElement.labels; supply its platform
    // value, not a replacement for the production label-selection algorithm.
    const input = document.querySelector("input")!;
    Object.defineProperty(input, "labels", { value: labels });
    if (aria !== undefined) input.setAttribute("aria-label", aria);
    const prior = Object.getOwnPropertyDescriptor(globalThis, "document");
    Object.defineProperty(globalThis, "document", {
      configurable: true,
      value: document,
    });
    t.after(() => {
      if (prior) Object.defineProperty(globalThis, "document", prior);
      else Reflect.deleteProperty(globalThis, "document");
    });
    const snapshot = await snapshotPage(page, new Set());
    assert.equal(snapshot.path, "https://provider.test");
    assert.equal(snapshot.elements.length, 1);
    assert.equal(snapshot.elements[0]?.label, expected);
    assert.equal(input.getAttribute("data-cmy-idx"), "0");
  });
