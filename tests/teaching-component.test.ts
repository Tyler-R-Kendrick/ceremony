import assert from "node:assert/strict";
import test from "node:test";
import { parseHTML } from "linkedom";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { renderToString } from "react-dom/server";
import { recipeDefinitionSchema } from "../src/core/recipe-contracts.js";
import {
  CeremonyBoard,
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
  capabilityOverrides: Record<string, unknown> = {},
  snapshot: TeachingRun = waiting,
  respond?: (
    url: string,
    body: unknown,
  ) => Response | Promise<Response> | undefined,
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
      const override = respond?.(url, calls.at(-1)!.body);
      if (override) return override;
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
    async render(element: Parameters<typeof root.render>[0]) {
      await act(async () => root.render(element));
    },
    async setOnline(online: boolean) {
      Reflect.set(navigator, "onLine", online);
      await act(async () => {
        window.dispatchEvent(new window.Event(online ? "online" : "offline"));
      });
    },
    async focus() {
      await act(async () => {
        window.dispatchEvent(new window.Event("focus"));
      });
    },
    get navigations() {
      return navigations;
    },
    async account(value: string, name = "github-account") {
      const input = document.querySelector<HTMLInputElement>(
        `input[name="${name}"]`,
      );
      assert.ok(input);
      await act(async () => {
        input.value = value;
        input.dispatchEvent(new window.Event("input", { bubbles: true }));
      });
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

for (const responseStatus of [200, 403])
  test(`a late initial resume (${responseStatus}) cannot replace the connection the human just started`, async () => {
    let release!: (response: Response) => void;
    const initial = new Promise<Response>((resolve) => {
      release = resolve;
    });
    const observed: string[] = [];
    let requested = false;
    const view = await mount(
      {
        resumeId: "old-run",
        onRunChange: (run) => {
          observed.push(run.id);
        },
      },
      200,
      {},
      waiting,
      (url) => {
        if (url.endsWith("/runs/old-run")) {
          requested = true;
          return initial;
        }
      },
    );
    try {
      assert.equal(requested, true);
      await view.account("chosen-owner");
      await view.click("Connect GitHub");
      assert.deepEqual(observed, [waiting.id]);
      await act(async () => {
        release(
          Response.json(
            { ...waiting, id: "old-run" },
            { status: responseStatus },
          ),
        );
      });
      assert.deepEqual(observed, [waiting.id]);
      assert.equal(
        view.document.querySelector("a.button")?.getAttribute("href"),
        `/api/v1/teaching/github/${waiting.id}/human`,
      );
    } finally {
      release(Response.json({ ...waiting, id: "old-run" }));
      await view.close();
    }
  });

for (const responseStatus of [200, 403])
  test(`a late focus refresh (${responseStatus}) cannot restore an older run after a newer server read`, async () => {
    let release!: (response: Response) => void;
    const older = new Promise<Response>((resolve) => {
      release = resolve;
    });
    const observed: string[] = [];
    let reads = 0;
    const cancelled = { ...waiting, revision: 2, status: "cancelled" };
    const view = await mount(
      {
        resumeId: waiting.id,
        onRunChange: (run) => {
          observed.push(run.status);
        },
      },
      200,
      {},
      waiting,
      (url) => {
        if (!url.endsWith(`/runs/${waiting.id}`)) return;
        reads++;
        if (reads === 2) return older;
        return Response.json(reads === 1 ? waiting : cancelled);
      },
    );
    try {
      await view.focus();
      assert.equal(reads, 2);
      await view.streams.at(-1)!.emit("stopped");
      assert.equal(reads, 3);
      assert.deepEqual(observed, ["active", "cancelled"]);
      await act(async () => {
        release(Response.json(waiting, { status: responseStatus }));
      });
      assert.deepEqual(observed, ["active", "cancelled"]);
      assert.doesNotMatch(
        view.document.body.textContent ?? "",
        /does not have permission/,
      );
    } finally {
      release(Response.json(waiting));
      await view.close();
    }
  });

test("current resume and refresh failures still report unavailable access", async () => {
  for (const phase of ["resume", "refresh"]) {
    let reads = 0;
    const view = await mount(
      { resumeId: waiting.id, onRunChange() {} },
      200,
      {},
      waiting,
      (url) => {
        if (!url.endsWith(`/runs/${waiting.id}`)) return;
        reads++;
        if (phase === "refresh" && reads === 1) return Response.json(waiting);
        return Response.json({ error: "denied" }, { status: 403 });
      },
    );
    try {
      if (phase === "refresh") {
        await view.focus();
        assert.match(
          view.document.body.textContent ?? "",
          /does not have permission/,
        );
      } else {
        assert.match(view.document.body.textContent ?? "", /unavailable/);
        assert.equal(Boolean(view.document.querySelector("a.button")), false);
      }
    } finally {
      await view.close();
    }
  }
});

for (const existing of [false, true])
  test(`human demonstration consent stays revision-bound and discard preserves the connection (existing run: ${existing})`, async () => {
    let unavailable = false;
    let demonstration = {
      id: "human-demo",
      revision: 1,
      consent: "recording",
      events: [
        {
          eventId: "step-one",
          sequence: 7,
          operationId: "github.prepare-app",
          verification: "accepted",
          kind: "operation-completed",
        },
        {
          eventId: "step-two",
          sequence: 9,
          operationId: "github.authorize-installation",
          verification: "accepted",
          kind: "operation-completed",
        },
        {
          eventId: "step-three",
          sequence: 13,
          operationId: "github.verify-access",
          verification: "accepted",
          kind: "operation-completed",
        },
      ],
    };
    const view = await mount(
      { ...(existing ? { resumeId: waiting.id } : {}), onRunChange() {} },
      200,
      {},
      waiting,
      (url, body) => {
        if (url.endsWith("/drafts/compile")) {
          assert.deepEqual(body, {
            demonstrationId: "human-demo",
            first: 7,
            last: 13,
          });
          return Response.json({
            id: "human-draft",
            revision: 1,
            digest: "fixture-digest",
            diagnostics: [],
            definition: recipeDefinitionSchema.parse({
              schemaVersion: 1,
              id: "recorded-step",
              title: "Recorded step",
              description: "Synthetic review fixture",
              inputs: {},
              outputs: {},
              invocations: [
                {
                  id: "prepare",
                  use: {
                    kind: "operation",
                    id: "github.prepare-app",
                    version: "1.0.0",
                  },
                  dependsOn: [],
                  bindings: {},
                },
              ],
            }),
          });
        }
        if (url.endsWith("/runs") && body)
          return Response.json({ ...waiting, demonstration });
        if (url.endsWith("/demonstrations"))
          return Response.json(demonstration);
        if (url.endsWith("/demonstrations/human-demo")) {
          if (body) {
            if (unavailable)
              return Response.json(
                { error: "untrusted-provider-body" },
                { status: 503 },
              );
            const submitted = body as { revision: number; consent: string };
            assert.equal(submitted.revision, demonstration.revision);
            demonstration = {
              ...demonstration,
              revision: demonstration.revision + 1,
              consent: submitted.consent,
            };
          }
          return Response.json(demonstration);
        }
        return undefined;
      },
    );
    try {
      if (!existing) await view.account("fixture-owner");
      await view.click(existing ? "Teach this step" : "Teach this connection");
      const started = view.calls.find((call) => call.body !== undefined);
      assert.deepEqual(
        started,
        existing
          ? {
              path: "/api/v1/teaching/demonstrations",
              body: { runId: waiting.id, scope: ["prepare"] },
            }
          : {
              path: "/api/v1/teaching/runs",
              body: {
                connectorId: "github",
                teach: true,
                target: "fixture-owner",
                account: "fixture-owner",
              },
            },
      );
      assert.match(
        view.document.querySelector('[aria-label="Demonstration"]')!
          .textContent!,
        /Teaching this connection/,
      );
      assert.match(
        view.document.body.textContent!,
        /Teaching started\. Only permitted semantic steps are recorded, not passwords or provider pages/,
      );
      unavailable = true;
      const beforePause = view.calls.length;
      await view.click("Pause teaching");
      assert.equal(demonstration.consent, "recording");
      assert.equal(demonstration.revision, 1);
      assert.equal(view.calls.length, beforePause + 1);
      assert.match(
        view.document.querySelector('[role="alert"]')!.textContent!,
        /completed steps are preserved/,
      );
      assert.equal(
        view.document.body.textContent!.includes("untrusted-provider-body"),
        false,
      );
      unavailable = false;
      await view.click("Pause teaching");
      assert.equal(demonstration.consent, "paused");
      await view.click("Resume teaching");
      assert.equal(demonstration.consent, "recording");
      await view.click("Stop teaching and review");
      assert.equal(demonstration.consent, "stopped");
      assert.deepEqual(
        [...view.document.querySelectorAll(".teaching-timeline li")].map(
          (item) => item.textContent,
        ),
        [
          "Prepare GitHub App — verified boundary",
          "Authorize installation — verified boundary",
          "Verify GitHub access — verified boundary",
        ],
      );
      assert.deepEqual(
        [...view.document.querySelectorAll(".teaching-range select")].map(
          (select) =>
            select.getAttribute("value") ??
            select.querySelector("option[selected]")?.getAttribute("value"),
        ),
        ["7", "13"],
      );
      await view.click("Review reusable step");
      assert.equal(
        view.document.querySelector('[aria-label="Reusable step review"] h3')
          ?.textContent,
        "Recorded step",
      );
      const beforeDiscard = view.calls.length;
      await view.click("Discard demonstration");
      assert.deepEqual(view.calls.slice(beforeDiscard), [
        {
          path: "/api/v1/teaching/demonstrations/human-demo",
          body: { revision: 4, consent: "discarded" },
        },
      ]);
      assert.equal(
        Boolean(view.document.querySelector('[aria-label="Demonstration"]')),
        false,
      );
      assert.equal(
        Boolean(
          view.document.querySelector('[aria-label="Reusable step review"]'),
        ),
        false,
      );
      assert.ok(view.document.querySelector('a[href$="/human"]'));
      assert.match(
        view.document.body.textContent!,
        /connection and required security records are unchanged/,
      );
      assert.equal(
        view.calls.some((call) => /cancel|delete|publish/.test(call.path)),
        false,
      );
    } finally {
      await view.close();
    }
  });

for (const events of [undefined, []])
  test(`stopping a demonstration with ${events ? "empty" : "missing"} events cannot compile invented steps`, async () => {
    let consent = "recording";
    const demo = () => ({
      id: "empty-demo",
      revision: 1,
      consent,
      ...(events ? { events } : {}),
    });
    const view = await mount(
      { onRunChange() {} },
      200,
      {},
      waiting,
      (url, body) => {
        if (url.endsWith("/runs") && body)
          return Response.json({ ...waiting, demonstration: demo() });
        if (url.endsWith("/demonstrations/empty-demo")) {
          if (body) consent = (body as { consent: string }).consent;
          return Response.json(demo());
        }
        return undefined;
      },
    );
    try {
      await view.account("fixture-owner");
      await view.click("Teach this connection");
      await view.click("Stop teaching and review");
      assert.match(
        view.document.querySelector('[aria-label="Demonstration"]')!
          .textContent!,
        /No completed semantic steps were captured/,
      );
      assert.equal(
        view.document.querySelectorAll(
          ".teaching-timeline li, .teaching-range select",
        ).length,
        0,
      );
      assert.equal(
        view.document.body.textContent!.includes("Review reusable step"),
        false,
      );
      assert.equal(
        Boolean(view.document.querySelector('[role="alert"]')),
        false,
      );
    } finally {
      await view.close();
    }
  });

test("Jira teaching requests its site without sending a GitHub account field", async () => {
  const view = await mount(
    { connectorId: "jira", onRunChange() {} },
    200,
    { connectors: ["jira"] },
    { ...waiting, provider: "jira" },
    (url, body) => {
      if (url.endsWith("/runs") && body) {
        const input = body as { target?: string };
        if (!input.target)
          return Response.json(
            { error: "jira-site-required" },
            { status: 409 },
          );
        return Response.json({
          ...waiting,
          provider: "jira",
          demonstration: { id: "jira-demo", revision: 1, consent: "recording" },
        });
      }
      return undefined;
    },
  );
  try {
    await view.click("Teach this connection");
    assert.deepEqual(view.calls.find((call) => call.body)?.body, {
      connectorId: "jira",
      teach: true,
    });
    await view.account("https://fixture.atlassian.net", "jira-site");
    await view.click("Teach this connection");
    assert.deepEqual(view.calls.filter((call) => call.body).at(-1)?.body, {
      connectorId: "jira",
      teach: true,
      target: "https://fixture.atlassian.net",
    });
    assert.ok(view.document.querySelector('[aria-label="Demonstration"]'));
  } finally {
    await view.close();
  }
});

test("webmcp false opts out of both connection and authoring tool registration", async () => {
  const view = await mount();
  const registered = new Set<string>();
  Object.defineProperty(view.document, "modelContext", {
    value: {
      registerTool: (
        tool: { name: string },
        options: { signal: AbortSignal },
      ) => {
        registered.add(tool.name);
        options.signal.addEventListener("abort", () =>
          registered.delete(tool.name),
        );
      },
    },
  });
  try {
    await view.render(
      createElement(TeachingConnection, {
        key: "native-context-present",
        webmcp: false,
        autoFocus: false,
      }),
    );
    assert.equal(registered.size, 0);
    await view.render(
      createElement(TeachingConnection, {
        key: "native-context-present",
        webmcp: { prefix: "host_owned" },
        autoFocus: false,
      }),
    );
    assert.equal(registered.size, 8);
    await view.render(
      createElement(TeachingConnection, {
        key: "native-context-present",
        webmcp: false,
        autoFocus: false,
      }),
    );
    assert.equal(registered.size, 0);
  } finally {
    await view.close();
  }
});

test("ceremony discovery renders provider evidence as text without inventing actions", () => {
  assert.equal(
    renderToString(createElement(CeremonyBoard, { report: {} })),
    "",
  );
  const report = {
    origin: "https://provider.example",
    assumed: true,
    candidates: ["https://provider.example", "https://auth.provider.example"],
    methods: [
      "oauth-code",
      { kind: "device-code", requires: ["Provider account"] },
      { label: "Manual consent" },
      {},
    ],
    extra: ["<script>untrusted-discovery</script>"],
    documents: ["/.well-known/oauth-authorization-server"],
    issuer: "https://auth.provider.example",
    authorizationEndpoint: "https://auth.provider.example/authorize",
    deviceAuthorizationEndpoint: "https://auth.provider.example/device",
    registrationEndpoint: "https://auth.provider.example/register",
    clientId: "public-client",
    scopes: ["openid", "email"],
  };
  const html = renderToString(createElement(CeremonyBoard, { report }));
  const { document } = parseHTML(html);
  assert.equal(document.querySelectorAll("button, a, input, script").length, 0);
  assert.deepEqual(
    [...document.querySelectorAll("li")].map((item) => item.textContent),
    ["oauth-code", "device-code — requires Provider account", "Manual consent"],
  );
  for (const text of [
    "assumed from the provider name",
    report.candidates.join(", "),
    report.extra[0]!,
    report.documents[0]!,
    report.issuer,
    report.authorizationEndpoint,
    report.deviceAuthorizationEndpoint,
    report.registrationEndpoint,
    report.clientId,
    "openid email",
  ])
    assert.ok(
      document.querySelector(".ceremony-board")?.textContent?.includes(text),
      `missing evidence: ${text}`,
    );
});

test("ceremony actions ask for the required account and stay disabled while a run is active", async () => {
  const view = await mount();
  const calls: Array<[string, string | undefined]> = [];
  const props = {
    report: {
      methods: [
        { kind: "account-registration", label: "Register" },
        {
          kind: "oauth-code",
          label: "Authorize",
          requires: ["Provider account"],
        },
        { kind: "app-registration", label: "Register application" },
      ],
    },
    onRun: (kind: string, account?: string) => calls.push([kind, account]),
    accountPrompt: {
      label: "Account name or email",
      hint: "Choose your account",
    },
  };
  try {
    await view.render(createElement(CeremonyBoard, props));
    await view.click("Register application");
    assert.deepEqual(calls, [["app-registration", undefined]]);
    for (const label of ["Register", "Authorize"]) {
      await view.click(label);
      assert.equal(view.document.querySelectorAll("form").length, 1);
      assert.match(
        view.document.querySelector("input")!.outerHTML,
        /\bmaxlength="254"/i,
      );
      assert.equal(
        view.document.querySelector("input")?.getAttribute("pattern"),
        null,
      );
      assert.match(
        view.document.querySelector("input")!.outerHTML,
        /\bautocomplete="username"/i,
      );
      assert.ok(
        view.document
          .querySelector('button[type="submit"]')
          ?.hasAttribute("disabled"),
      );
      assert.equal(calls.length, 1);
    }
    await view.render(
      createElement(CeremonyBoard, {
        ...props,
        running: true,
        accountPrompt: {
          label: "GitHub handle",
          hint: "Public handle",
          pattern: "[A-Za-z0-9-]+",
          maxLength: 100,
        },
      }),
    );
    assert.match(
      view.document.querySelector("input")!.outerHTML,
      /\bmaxlength="100"/i,
    );
    assert.equal(
      view.document.querySelector("input")?.getAttribute("pattern"),
      "[A-Za-z0-9-]+",
    );
    for (const button of view.document.querySelectorAll("button"))
      assert.ok(button.hasAttribute("disabled"));
  } finally {
    await view.close();
  }
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

test("account-only completion never claims that protected-resource access was verified", async () => {
  const view = await mount(
    { resumeId: waiting.id, onRunChange() {} },
    200,
    {},
    {
      ...waiting,
      status: "complete",
      nodes: [
        {
          id: "account",
          operationId: "authored.register-account",
          state: "complete",
          verified: true,
        },
      ],
    },
  );
  try {
    assert.equal(
      view.document.querySelector("h2")?.textContent,
      "GitHub account setup complete",
    );
    assert.match(
      view.document.querySelector('[role="status"]')?.textContent ?? "",
      /Run the authorization ceremony to verify resource access/,
    );
    assert.equal(
      view.document.body.textContent?.includes("Verified access is ready"),
      false,
    );
  } finally {
    await view.close();
  }
});

test("connection status distinguishes verified identity, cancelled work, and each unverified provider state", async () => {
  const cases: Array<{ run: TeachingRun; heading: string; message: string }> =
    [];
  for (const did of ["did:fixture:123", "fixture-owner", ""])
    cases.push({
      run: {
        ...waiting,
        status: "complete",
        identity: { handle: "fixture-owner", did },
        nodes: waiting.nodes.map((node) => ({ ...node, verified: true })),
      },
      heading: "GitHub connection verified",
      message: `Verified GitHub account fixture-owner${did === "did:fixture:123" ? " (did:fixture:123)" : ""}. Secrets are not shown.`,
    });
  cases.push({
    run: { ...waiting, status: "cancelled" },
    heading: "Connect GitHub",
    message:
      "Connection cancelled. Completed provider changes have not been revoked.",
  });
  for (const [state, description] of [
    ["awaiting-human", "your participation is needed"],
    ["uncertain", "the provider outcome needs reconciliation"],
    ["failed", "verification needs attention"],
    ["verifying", "checking provider evidence"],
    ["running", "preparing the next step"],
  ])
    cases.push({
      run: { ...waiting, nodes: [{ ...waiting.nodes[0]!, state: state! }] },
      heading: "Connect GitHub",
      message: `Prepare GitHub App — ${description}.`,
    });
  cases.push({
    run: { ...waiting, nodes: [] },
    heading: "Connect GitHub",
    message: "Existing setup is reused. We’ll ask only for what’s missing.",
  });
  cases.push({
    run: {
      ...waiting,
      nodes: [
        { ...waiting.nodes[0]!, verified: true },
        {
          id: "authorize",
          operationId: "authored.authorize-user",
          state: "awaiting-human",
          verified: false,
        },
        {
          id: "verify",
          operationId: "authored.verify-access",
          state: "uncertain",
          verified: false,
        },
      ],
    },
    heading: "Connect GitHub",
    message: "Your input is needed for step 2 of 3: OAuth authorization code.",
  });
  for (const { run, heading, message } of cases) {
    const view = await mount(
      { resumeId: run.id, onRunChange() {} },
      200,
      {},
      run,
    );
    try {
      assert.equal(view.document.querySelector("h2")?.textContent, heading);
      assert.equal(
        view.document.querySelector("h2")?.getAttribute("tabindex"),
        "-1",
      );
      const status = view.document.querySelector('[role="status"]');
      assert.equal(status?.textContent, message);
      assert.equal(status?.getAttribute("aria-live"), "polite");
      assert.equal(
        view.calls.every((call) => call.body === undefined),
        true,
      );
    } finally {
      await view.close();
    }
  }
});

test("human handoff preserves native credential fields across status refreshes without sending them through component requests", async () => {
  const run: TeachingRun = {
    ...waiting,
    provider: "novel",
    human: { reason: "session", account: "fixture-owner", fields: [] },
    nodes: [{ ...waiting.nodes[0]!, operationId: "authored.register-account" }],
  };
  const view = await mount(
    {
      connectorId: "novel",
      apiBase: "/host/auth/",
      resumeId: run.id,
      onRunChange() {},
    },
    200,
    { connectors: ["novel"] },
    run,
  );
  try {
    const form = view.document.querySelector("form")!;
    const password = form.querySelector<HTMLInputElement>(
      'input[name="password"]',
    )!;
    const account = form.querySelector<HTMLInputElement>(
      'input[name="username"]',
    )!;
    assert.equal(
      form.getAttribute("action"),
      "/host/auth/novel/host-run/human",
    );
    assert.equal(form.getAttribute("method"), "post");
    assert.equal(password.getAttribute("type"), "password");
    // Linkedom preserves React's attribute casing; browsers normalize it.
    assert.equal(password.getAttribute("autoComplete"), "current-password");
    assert.equal(password.getAttribute("maxLength"), "1024");
    assert.equal(password.hasAttribute("required"), true);
    assert.equal(account.value, "fixture-owner");
    assert.equal(account.hasAttribute("readOnly"), true);
    assert.equal(account.getAttribute("autoComplete"), "username");
    assert.equal(account.getAttribute("maxLength"), "254");
    assert.equal(
      form.querySelector("button")?.textContent,
      "Continue in isolated browser",
    );
    assert.equal(form.querySelector("button")?.getAttribute("type"), "submit");
    assert.equal(
      view.document.querySelector(
        'a[href="/host/auth/novel/host-run/human?flow=native"]',
      )?.textContent,
      "Continue in your browser",
    );
    assert.equal(
      view.document.querySelector(
        'a[href="/host/auth/novel/host-run/human"]',
      ) === null,
      true,
    );
    assert.equal(
      [...view.document.querySelectorAll(".teaching-note")].some(
        (node) =>
          node.textContent ===
          "The account exists. Supply its password through the secure broker so the isolated browser can use the traditional sign-in flow.",
      ),
      true,
    );
    password.value = "fixture-only-private-value";
    await view.setOnline(false);
    await view.setOnline(true);
    await view.click("Refresh status");
    assert.equal(
      view.document.querySelector('input[name="password"]') === password,
      true,
    );
    assert.equal(password.value, "fixture-only-private-value");
    assert.equal(
      view.calls.every((call) => call.body === undefined),
      true,
    );
    assert.equal(JSON.stringify(view.calls).includes(password.value), false);
  } finally {
    await view.close();
  }
});

test("human handoff explains provider requirements and keeps native and isolated continuation distinct", async () => {
  const reasons = [
    [
      "passkey",
      "A passkey or security key is required. Continue in your own browser using a discovered provider authorization method. Your private key stays in your authenticator.",
    ],
    [
      "challenge",
      "The isolated browser reached a CAPTCHA or MFA challenge. Continue through the human handoff.",
    ],
    [
      "verification",
      "The isolated browser reached a verification-code step. Continue through the human handoff.",
    ],
    [
      "submission-uncertain",
      "The provider outcome is unclear. Automatic resubmission stopped; use the secure handoff to check the account or try sign-in recovery.",
    ],
    [
      "email-in-use",
      "This account identifier is already in use. Sign in if it is yours, or choose another account in the human handoff.",
    ],
    [
      "username-in-use",
      "This account identifier is already in use. Sign in if it is yours, or choose another account in the human handoff.",
    ],
    [
      "unknown",
      "Next action: continue the provider ceremony through the secure human handoff.",
    ],
  ];
  for (const [reason, message] of reasons) {
    const run: TeachingRun = {
      ...waiting,
      human: { reason: reason!, fields: [] },
      nodes: [{ ...waiting.nodes[0]!, operationId: "authored.authorize-user" }],
    };
    const view = await mount(
      { resumeId: run.id, onRunChange() {} },
      200,
      {},
      run,
    );
    try {
      assert.equal(
        [...view.document.querySelectorAll(".teaching-note")].some(
          (node) => node.textContent === message,
        ),
        true,
        reason,
      );
      assert.equal(
        view.document.querySelector('[role="status"]')?.textContent,
        "Your input is needed for step 1 of 1: OAuth authorization code.",
      );
      assert.equal(
        view.document.querySelector('a[href$="?flow=native"]')?.textContent,
        "Continue in your browser",
      );
      assert.equal(
        view.document.querySelector('a[href$="/human"]')?.textContent,
        "Continue isolated authorization",
      );
      assert.equal(view.document.querySelector("form") === null, true);
    } finally {
      await view.close();
    }
  }
});

test("Studio and Connect retain distinct headings before and after a run exists", async () => {
  for (const mode of ["studio", "connect"] as const)
    for (const existing of [false, true]) {
      const view = await mount({
        mode,
        ...(existing ? { resumeId: waiting.id } : {}),
        onRunChange() {},
      });
      try {
        assert.equal(
          view.document.querySelector("h2")?.textContent,
          mode === "studio" && !existing
            ? "Create from demonstration"
            : "Connect GitHub",
        );
        if (!existing) {
          assert.equal(
            view.document.querySelector('a[href*="/human"]') === null,
            true,
          );
          assert.equal(view.document.querySelector("form") === null, true);
        }
      } finally {
        await view.close();
      }
    }
});

test("handoff entry points respect provider state and preserve Supabase and Jira uncertain recovery", async () => {
  const cases = [
    {
      provider: "github",
      state: "uncertain",
      operationId: "github.prepare-app",
    },
    {
      provider: "supabase",
      state: "uncertain",
      operationId: "supabase.obtain-session",
      label: "Continue with Supabase",
    },
    {
      provider: "jira",
      state: "uncertain",
      operationId: "jira.authorize-user",
      label: "Continue with Jira",
    },
    {
      provider: "supabase",
      state: "verifying",
      operationId: "supabase.obtain-session",
    },
    { provider: "jira", state: "failed", operationId: "jira.authorize-user" },
    {
      provider: "novel",
      state: "uncertain",
      operationId: "authored.authorize-user",
    },
    {
      provider: "novel",
      state: "verifying",
      operationId: "authored.register-account",
      reason: "session",
    },
    {
      provider: "novel",
      state: "awaiting-human",
      operationId: "authored.prepare-app",
      label: "Continue with novel",
      stepLabel: "App registration",
    },
    {
      provider: "novel",
      state: "awaiting-human",
      operationId: "authored.collect-credential",
      label: "Continue with novel",
      stepLabel: "API key collection",
    },
    {
      provider: "novel",
      state: "awaiting-human",
      operationId: "github.prepare-app",
      label: "Continue with novel",
    },
    {
      provider: "novel",
      state: "awaiting-human",
      operationId: "authored.register-account",
      reason: "session",
      native: true,
      form: true,
    },
  ];
  for (const item of cases) {
    const run: TeachingRun = {
      ...waiting,
      provider: item.provider,
      ...(item.reason ? { human: { reason: item.reason, fields: [] } } : {}),
      nodes: [
        {
          ...waiting.nodes[0]!,
          operationId: item.operationId,
          state: item.state,
        },
      ],
    };
    const view = await mount(
      { connectorId: item.provider, resumeId: run.id, onRunChange() {} },
      200,
      { connectors: [item.provider] },
      run,
    );
    try {
      assert.equal(
        Boolean(view.document.querySelector('a[href$="?flow=native"]')),
        Boolean(item.native),
      );
      assert.equal(
        view.document.querySelector('a[href$="/human"]')?.textContent,
        item.label,
      );
      assert.equal(
        Boolean(view.document.querySelector("form")),
        Boolean(item.form),
      );
      if (item.stepLabel) {
        assert.equal(
          view.document.querySelector('[role="status"]')?.textContent,
          `Your input is needed for step 1 of 1: ${item.stepLabel}.`,
        );
        assert.equal(
          [...view.document.querySelectorAll(".teaching-note")].some(
            (node) =>
              node.textContent ===
              "Next action: continue the provider ceremony through the secure human handoff.",
          ),
          true,
        );
      }
      if (item.form) {
        const account = view.document.querySelector<HTMLInputElement>(
          'input[name="username"]',
        )!;
        assert.equal(account.value, "");
        assert.equal(account.hasAttribute("readOnly"), false);
      }
    } finally {
      await view.close();
    }
  }
  for (const status of ["cancelled", "complete"] as const)
    for (const reason of ["session", "challenge"]) {
      const run: TeachingRun = {
        ...waiting,
        status,
        human: { reason, fields: [] },
        nodes: [
          { ...waiting.nodes[0]!, operationId: "authored.authorize-user" },
        ],
      };
      const view = await mount(
        { resumeId: run.id, onRunChange() {} },
        200,
        {},
        run,
      );
      try {
        assert.equal(view.document.querySelector("form") === null, true);
        assert.equal(
          view.document.querySelector('a[href$="/human"]') === null,
          true,
        );
        assert.equal(
          view.document.querySelector('a[href$="?flow=native"]') === null,
          true,
          `${status} runs must not offer a continuation that the server rejects`,
        );
        assert.equal(
          [...view.document.querySelectorAll(".teaching-note")].some((node) =>
            node.textContent?.includes("Continue through the human handoff"),
          ),
          false,
        );
      } finally {
        await view.close();
      }
    }
});

test("saved-account claim links require verified account progress and never appear for cancelled or unrelated steps", async () => {
  for (const operationId of [
    "authored.register-account",
    "authored.authorize-user",
    "github.prepare-app",
  ])
    for (const status of ["active", "complete", "cancelled"] as const)
      for (const verified of [true, false]) {
        const run: TeachingRun = {
          ...waiting,
          account: "stored",
          status,
          nodes: [
            { ...waiting.nodes[0]!, operationId, verified },
            {
              id: "verify",
              operationId: "authored.verify-access",
              state: "uncertain",
              verified: false,
            },
          ],
        };
        const view = await mount(
          { resumeId: run.id, onRunChange() {} },
          200,
          {},
          run,
        );
        try {
          const link = view.document.querySelector('a[href$="/account"]');
          const allowed =
            status !== "cancelled" &&
            verified &&
            operationId.startsWith("authored.");
          assert.equal(Boolean(link), allowed);
          if (allowed) {
            assert.equal(link?.textContent, "Get saved account credentials");
            assert.equal(
              link?.getAttribute("href"),
              "/api/v1/teaching/github/host-run/account",
            );
          }
          assert.equal(
            view.calls.every((call) => call.body === undefined),
            true,
          );
        } finally {
          await view.close();
        }
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
    await view.account("fixture-owner");
    await view.click("Connect GitHub");
    assert.equal(runs[0]?.id, waiting.id);
    assert.equal(view.navigations, 0);
    assert.equal(
      view.document.querySelectorAll(
        'a[href="/host/ceremony/github/host-run/human"]',
      ).length,
      1,
    );
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

test("a resume hint for another provider cannot replace the selected connector", async () => {
  const runs: TeachingRun[] = [];
  const view = await mount(
    { resumeId: waiting.id, onRunChange: (run) => runs.push(run) },
    200,
    {},
    { ...waiting, provider: "stripe", profile: "stripe-api-key" },
  );
  try {
    assert.equal(runs.length, 0);
    assert.equal(view.document.querySelector('a[href$="/human"]'), null);
    assert.equal(view.streams.length, 0);
    assert.ok(view.document.body.textContent?.includes("Connect GitHub"));
    assert.ok(view.calls.every((call) => call.body === undefined));
    assert.equal(
      view.calls.some((call) => call.path.endsWith("/demonstration")),
      false,
    );
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
          ? /has not registered a working ceremony/
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
      await view.account("fixture-owner");
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
