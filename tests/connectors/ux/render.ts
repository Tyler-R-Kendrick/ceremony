import { parseHTML } from "linkedom";
import { act, type ReactNode } from "react";
import { createRoot } from "react-dom/client";

/*
 * A DOM for component tests, built the way tests/teaching-component.test.ts
 * builds one: linkedom, the real React renderer, and the globals the component
 * legitimately reads. Nothing is stubbed inside the component — the fetch it
 * gets is the fixture double, and everything else is a real render.
 */

export type MountOptions = {
  fetch?: typeof fetch;
  onLine?: boolean;
  href?: string;
};

export type Mounted = Awaited<ReturnType<typeof mount>>;

export async function mount(node: ReactNode, options: MountOptions = {}) {
  const { window, document } = parseHTML(
    '<html><body><div id="root"></div></body></html>',
  );
  const href = options.href ?? "https://app.test/";
  const url = new URL(href);
  const originals = new Map<string, PropertyDescriptor | undefined>();
  const navigatorValue = { onLine: options.onLine ?? true };
  const values: Record<string, unknown> = {
    window,
    document,
    navigator: navigatorValue,
    location: {
      href,
      origin: url.origin,
      search: url.search,
      assign() {},
      replace() {},
    },
    history: { replaceState() {} },
    addEventListener: window.addEventListener.bind(window),
    removeEventListener: window.removeEventListener.bind(window),
    dispatchEvent: window.dispatchEvent.bind(window),
    IS_REACT_ACT_ENVIRONMENT: true,
    ...(options.fetch ? { fetch: options.fetch } : {}),
  };
  for (const [name, value] of Object.entries(values)) {
    originals.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
    Object.defineProperty(globalThis, name, {
      configurable: true,
      writable: true,
      value,
    });
  }
  const root = createRoot(document.getElementById("root")!);
  await act(async () => {
    root.render(node);
  });
  const api = {
    window,
    document,
    get text() {
      return document.body.textContent ?? "";
    },
    query(selector: string) {
      return document.querySelector(selector);
    },
    all(selector: string) {
      return [...document.querySelectorAll(selector)];
    },
    button(label: string) {
      return [...document.querySelectorAll("button")].find((element) =>
        (element.textContent ?? "").includes(label),
      );
    },
    async render(next: ReactNode) {
      await act(async () => {
        root.render(next);
      });
    },
    async click(label: string) {
      const button = api.button(label);
      if (!button) throw new Error(`No control labelled ${label}`);
      await act(async () => {
        button.dispatchEvent(new window.Event("click", { bubbles: true }));
      });
    },
    async clickElement(element: { dispatchEvent(event: unknown): unknown }) {
      await act(async () => {
        element.dispatchEvent(new window.Event("click", { bubbles: true }));
      });
    },
    async fill(selector: string, value: string) {
      const field = document.querySelector(selector) as
        | (Record<string, unknown> & {
            tagName: string;
            value?: string;
            dispatchEvent(event: unknown): unknown;
            querySelectorAll(selector: string): Iterable<Record<string, unknown>>;
          })
        | null;
      if (!field) throw new Error(`No field matching ${selector}`);
      await act(async () => {
        if (field.tagName === "SELECT") {
          // linkedom's select value is read-only; selecting the option is how
          // a person changes one anyway.
          for (const option of field.querySelectorAll("option"))
            option.selected = option.value === value;
        } else field.value = value;
        // React remembers the last value it saw on the node and ignores an
        // event when the node still matches it. An assignment updates that
        // memory, so it is reset afterwards — which is what a keystroke
        // effectively does.
        const tracker = field._valueTracker as
          | { setValue(value: string): void }
          | undefined;
        tracker?.setValue("ceremony-test-unset-sentinel");
        // A real keystroke fires both, and outside a browser React only
        // delivers the first of them for a text field.
        field.dispatchEvent(new window.Event("input", { bubbles: true }));
        field.dispatchEvent(new window.Event("change", { bubbles: true }));
      });
    },
    async submit(selector = "form") {
      const form = document.querySelector(selector);
      if (!form) throw new Error(`No form matching ${selector}`);
      await act(async () => {
        form.dispatchEvent(new window.Event("submit", { bubbles: true }));
      });
    },
    setOnline(online: boolean) {
      navigatorValue.onLine = online;
      return act(async () => {
        window.dispatchEvent(
          new window.Event(online ? "online" : "offline", { bubbles: false }),
        );
      });
    },
    /** Lets timers, fetches and effects settle, repeatedly, until it holds. */
    async waitFor(predicate: () => boolean, attempts = 60) {
      for (let index = 0; index < attempts; index++) {
        if (predicate()) return;
        await act(async () => {
          await new Promise((resolve) => setTimeout(resolve, 15));
        });
      }
      throw new Error(
        `Condition never held. Document said: ${(document.body.textContent ?? "").slice(0, 600)}`,
      );
    },
    async flush(times = 3) {
      for (let index = 0; index < times; index++)
        await act(async () => {
          await new Promise((resolve) => setTimeout(resolve, 5));
        });
    },
    async close() {
      await act(async () => {
        root.unmount();
      });
      for (const [name, descriptor] of originals) {
        if (descriptor) Object.defineProperty(globalThis, name, descriptor);
        else Reflect.deleteProperty(globalThis, name);
      }
    },
  };
  return api;
}
