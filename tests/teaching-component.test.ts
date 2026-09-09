import assert from "node:assert/strict";
import test from "node:test";
import { parseHTML } from "linkedom";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { renderToString } from "react-dom/server";
import {
  TeachingConnection,
  type TeachingConnectionProps,
  type TeachingRun,
} from "../src/react/teaching.js";

const waiting: TeachingRun = {
  id: "host-run",
  revision: 1,
  provider: "github",
  profile: "app",
  status: "active",
  nodes: [
    {
      id: "prepare",
      operationId: "github.prepare-app",
      state: "awaiting-human",
      verified: false,
    },
  ],
};

async function mount(
  props: TeachingConnectionProps = {},
  status = 200,
  capabilityOverrides: Record<string, boolean> = {},
  snapshot: TeachingRun = waiting,
) {
  const { window, document } = parseHTML(
    '<html><body><div id="root"></div></body></html>',
  );
  const originals = new Map<string, PropertyDescriptor | undefined>();
  let navigations = 0;
  const calls: Array<{ path: string; body: unknown }> = [];
  const streams: FakeStream[] = [];
  class FakeStream {
    closed = false;
    listener?: (event: { data: string }) => void;
    constructor(readonly url: string) {
      streams.push(this);
    }
    addEventListener(
      _type: string,
      listener: (event: { data: string }) => void,
    ) {
      this.listener = listener;
    }
    close() {
      this.closed = true;
    }
    async emit(status: string) {
      await act(async () => {
        this.listener?.({
          data: JSON.stringify({ status, modelCalls: 0, requestedTools: 0 }),
        });
      });
    }
  }
  const values: Record<string, unknown> = {
    window,
    document,
    navigator: { onLine: true },
    location: {
      href: "https://host.test/task",
      replace() {
        navigations++;
      },
    },
    history: {
      replaceState() {
        navigations++;
      },
    },
    addEventListener: window.addEventListener.bind(window),
    removeEventListener: window.removeEventListener.bind(window),
    BroadcastChannel: undefined,
    EventSource: FakeStream,
    IS_REACT_ACT_ENVIRONMENT: true,
    fetch: async (url: string, init?: RequestInit) => {
      calls.push({
        path: url,
        body: init?.body ? JSON.parse(String(init.body)) : undefined,
      });
      let body: unknown = {};
      let code = 200;
      if (url.endsWith("/capabilities"))
        body = {
          available: true,
          authenticated: true,
          modelAvailable: true,
          ...capabilityOverrides,
        };
      else if (url.endsWith("/recipes")) body = { recipes: [] };
      else if (url.endsWith("/demonstration")) body = { demonstration: null };
      else if (url.endsWith("/cancel"))
        body = { ...waiting, status: "cancelled", revision: 2 };
      else if (url.endsWith("/runs") && init?.method === "POST") {
        code = status;
        body = status === 200 ? waiting : { error: "untrusted-provider-body" };
      } else if (url.includes("/runs/")) body = snapshot;
      return new Response(JSON.stringify(body), { status: code });
    },
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
    root.render(
      createElement(TeachingConnection, {
        webmcp: false,
        autoFocus: false,
        ...props,
      }),
    );
  });
  return {
    document,
    streams,
    calls,
    async setOnline(online: boolean) {
      Reflect.set(navigator, "onLine", online);
      await act(async () => {
        window.dispatchEvent(new window.Event(online ? "online" : "offline"));
      });
    },
    get navigations() {
      return navigations;
    },
    async click(label: string) {
      const button = Array.from(document.querySelectorAll("button")).find(
        (node) => node.textContent === label,
      );
      assert.ok(button, `missing control: ${label}`);
      await act(async () => {
        button.dispatchEvent(new window.Event("click", { bubbles: true }));
      });
    },
    async close() {
      await act(async () => root.unmount());
      for (const [name, descriptor] of originals) {
        if (descriptor) Object.defineProperty(globalThis, name, descriptor);
        else Reflect.deleteProperty(globalThis, name);
      }
    },
  };
}

test("TeachingConnection renders server-side without browser globals", () => {
  assert.match(
    renderToString(createElement(TeachingConnection, { webmcp: false })),
    /connection/i,
  );
});

test("completed connection heading is neutral offline and restores trusted status online without replaying effects", async () => {
  const view = await mount(
    { resumeId: waiting.id, onRunChange() {} },
    200,
    { modelAvailable: false },
    {
      ...waiting,
      status: "complete",
      nodes: waiting.nodes.map((node) => ({
        ...node,
        state: "complete",
        verified: true,
      })),
    },
  );
  try {
    assert.equal(
      view.document.querySelector("h2")?.textContent,
      "GitHub connection verified",
    );
    await view.setOnline(false);
    assert.equal(
      view.document.querySelector("h2")?.textContent,
      "Reconnect to check GitHub",
    );
    assert.match(
      view.document.querySelector('[role="status"]')?.textContent ?? "",
      /Offline\. Reconnect/,
    );
    assert.equal(
      view.document.body.textContent?.includes("Verified access is ready"),
      false,
    );
    await view.setOnline(true);
    assert.equal(
      view.document.querySelector("h2")?.textContent,
      "GitHub connection verified",
    );
    assert.match(
      view.document.querySelector('[role="status"]')?.textContent ?? "",
      /Verified access is ready/,
    );
    assert.ok(view.calls.every((call) => call.body === undefined));
  } finally {
    await view.close();
  }
});

test("host owns navigation and styling; deterministic controls preserve callback and cancel semantics", async () => {
  const runs: TeachingRun[] = [];
  const view = await mount({
    apiBase: "/host/ceremony/",
    onRunChange: (run) => runs.push(run),
    className: "host-owned",
    style: { color: "red" },
  });
  try {
    assert.ok(view.document.querySelector(".host-owned"));
    await view.click("Connect GitHub");
    assert.equal(runs[0]?.id, waiting.id);
    assert.equal(view.navigations, 0);
    assert.equal(
      view.document.querySelector(
        'a[href="/host/ceremony/github/host-run/human"]',
      )?.textContent,
      "Continue with GitHub",
    );
    await view.click("Ask assistant to help");
    await view.click("Stop assistant");
    assert.ok(
      [...view.document.querySelectorAll("button")]
        .find((button) => button.textContent === "Assistant stopped")
        ?.hasAttribute("disabled"),
    );
    await view.click("Refresh status");
    await view.click("Cancel connection");
    assert.equal(runs.at(-1)?.status, "cancelled");
    assert.ok(
      view.calls.every((call) => call.path.startsWith("/host/ceremony/")),
    );
    assert.ok(
      view.calls.some((call) => call.path.endsWith("/agent/host-run/stop")),
    );
    assert.deepEqual(
      view.calls.find((call) => call.path.endsWith("/cancel"))?.body,
      { revision: 1 },
    );
    assert.equal(view.navigations, 0);
  } finally {
    await view.close();
  }
});

test("explicit host resume restores same run without creating an effect", async () => {
  const runs: TeachingRun[] = [];
  const view = await mount({
    resumeId: waiting.id,
    onRunChange: (run) => runs.push(run),
  });
  try {
    assert.equal(runs[0]?.id, waiting.id);
    assert.equal(view.navigations, 0);
    assert.ok(view.calls.every((call) => call.body === undefined));
  } finally {
    await view.close();
  }
});

test("assistant status transport closes on terminal and unmount without implicit stop", async () => {
  const view = await mount({ resumeId: waiting.id, onRunChange() {} });
  try {
    const stream = view.streams[0]!;
    assert.ok(stream.url.endsWith("/agent/host-run/stream"));
    const readsBefore = view.calls.length;
    await stream.emit("running");
    assert.equal(stream.closed, false);
    await stream.emit("complete");
    assert.equal(stream.closed, true);
    assert.equal(view.calls.length, readsBefore + 1);
    assert.ok(view.calls.every((call) => call.body === undefined));
  } finally {
    await view.close();
  }
  assert.ok(view.streams.every((stream) => stream.closed));
});

test("host sign-in callback retains identity and navigation ownership", async () => {
  let signIns = 0;
  const view = await mount(
    {
      onSignIn: () => {
        signIns++;
      },
    },
    200,
    { authenticated: false },
  );
  try {
    await view.click("Sign in");
    assert.equal(signIns, 1);
    assert.equal(view.navigations, 0);
    assert.equal(
      view.calls.some((call) => call.path.includes("/auth/")),
      false,
    );
  } finally {
    await view.close();
  }
});

test("host sign-out override owns identity action, scrubs run and assistant, then notifies host", async () => {
  const notifications: string[] = [];
  const view = await mount(
    {
      resumeId: waiting.id,
      onRunChange() {},
      onSignOut: async () => {
        notifications.push("sign-out");
      },
      onSignedOut: () => {
        notifications.push("signed-out");
      },
    },
    200,
    { signOutAvailable: true },
  );
  try {
    await view.streams[0]!.emit("running");
    assert.ok(view.document.querySelector('a[href$="/human"]'));
    await view.click("Sign out");
    assert.deepEqual(notifications, ["sign-out", "signed-out"]);
    assert.equal(
      view.calls.some((call) => call.path === "/api/auth/logout"),
      false,
    );
    assert.equal(view.navigations, 0);
    assert.equal(view.document.querySelector('a[href$="/human"]'), null);
    assert.equal(
      view.document.body.textContent?.includes("Stop assistant"),
      false,
    );
    assert.equal(
      view.document.body.textContent?.includes("Cancel connection"),
      false,
    );
    assert.ok(view.document.body.textContent?.includes("Sign in to connect"));
    assert.ok(view.streams.every((stream) => stream.closed));
  } finally {
    await view.close();
  }
});

test("failed host sign-out does not falsely clear the session or invoke signed-out callback", async () => {
  let completed = false;
  const view = await mount(
    {
      resumeId: waiting.id,
      onRunChange() {},
      onSignOut: async () => {
        throw new Error("Host sign-out unavailable");
      },
      onSignedOut: () => {
        completed = true;
      },
    },
    200,
    { signOutAvailable: true },
  );
  try {
    await view.click("Sign out");
    assert.equal(completed, false);
    assert.ok(view.document.querySelector('a[href$="/human"]'));
    assert.ok(
      view.document.body.textContent?.includes("Host sign-out unavailable"),
    );
    assert.equal(
      view.calls.some((call) => call.path === "/api/auth/logout"),
      false,
    );
  } finally {
    await view.close();
  }
});

test("unavailable host and unsupported connector are truthful and do not execute", async () => {
  for (const props of [{ connectorId: "stripe" }, {}]) {
    const view = await mount(
      props,
      200,
      props.connectorId ? {} : { available: false },
    );
    try {
      assert.equal(view.document.querySelectorAll("button").length, 0);
      assert.ok(view.calls.every((call) => call.body === undefined));
      assert.match(
        view.document.body.textContent!,
        props.connectorId
          ? /currently supports GitHub/
          : /unavailable in this host/,
      );
    } finally {
      await view.close();
    }
  }
});

for (const [status, message] of [
  [401, "Sign in again"],
  [403, "does not have permission"],
  [409, "changed in another tab"],
  [500, "completed steps are preserved"],
] as const) {
  test(`HTTP ${status} produces safe actionable feedback without reflecting provider body`, async () => {
    const view = await mount({ onRunChange() {} }, status);
    try {
      await view.click("Connect GitHub");
      assert.ok(view.document.body.textContent?.includes(message));
      assert.equal(
        view.document.body.textContent?.includes("untrusted-provider-body"),
        false,
      );
    } finally {
      await view.close();
    }
  });
}
