import assert from "node:assert/strict";
import test from "node:test";
import { parseHTML } from "linkedom";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { renderToString } from "react-dom/server";
import { manifestSchema, type ConnectorManifest } from "../src/core/index.js";
import type { EntryContext } from "../src/core/resolution.js";
import {
  ConnectorCard,
  ConnectorGrid,
  HandoffMeter,
  ProviderMark,
  StatusChip,
} from "../src/react/connectors.js";
import { manifests } from "../examples/manifests.js";

const handoff = (surface: "provider-browser" | "private-collector") => ({
  surface,
  recipient: "initiating-subject" as const,
  delegation: "a2h-authorize" as const,
  resume: "verify" as const,
});

/**
 * Fixtures go through the real manifest schema, which enforces genuine
 * connector rules: an api-key carries exactly a masked `token`, basic carries
 * username and password, a form carries at least one field, every other kind
 * carries none, and a credential method hands off to a private collector. A
 * fixture that ignored those would prove the components work on manifests the
 * product cannot produce.
 */
const credentialKinds = ["basic", "api-key", "form"];

function fieldsFor(kind: string, count: number) {
  if (kind === "api-key")
    return [
      { name: "token", label: "Token", type: "password", required: true },
    ];
  if (kind === "basic")
    return [
      { name: "username", label: "Username", type: "text", required: true },
      { name: "password", label: "Password", type: "password", required: true },
    ];
  if (kind !== "form") return [];
  return Array.from({ length: Math.max(1, count) }, (_, index) =>
    index === 0
      ? { name: "email", label: "Email", type: "email", required: true }
      : {
          name: `detail${index}`,
          label: `Detail ${index}`,
          type: "text",
          required: false,
        },
  );
}

function build(
  methods: Array<{
    id: string;
    kind: string;
    fields?: number;
    prerequisites?: number;
    anonymous?: boolean;
    scopes?: string[];
    contract?: boolean;
  }>,
): ConnectorManifest {
  return manifestSchema.parse({
    id: "fixture-co",
    name: "Fixture Co",
    description: "A connector assembled for this test.",
    methods: methods.map((method) => {
      const credential = credentialKinds.includes(method.kind);
      return {
        id: method.id,
        label: `Method ${method.id}`,
        kind: method.kind,
        templateId: method.kind,
        scopes: method.scopes ?? ["read"],
        fields: fieldsFor(method.kind, method.fields ?? 1),
        ...(method.contract === false
          ? {}
          : {
              contract: {
                profile: "test-profile",
                surfaces: ["browser"],
                configuration: [],
                configurationGroups: [],
                prerequisites: Array.from(
                  { length: method.prerequisites ?? 0 },
                  (_, index) => ({
                    id: `step-${index}`,
                    kind: "provider-consent" as const,
                    reuse: "verified-context" as const,
                    handoff: handoff("provider-browser"),
                  }),
                ),
                handoff: handoff(
                  credential ? "private-collector" : "provider-browser",
                ),
                completion: {
                  verifier: "test.verifier",
                  ownership: method.anonymous
                    ? ["anonymous", "claimed"]
                    : ["authenticated"],
                },
                workflows: [],
              },
            }),
      };
    }),
  });
}

/** React separates adjacent text and expressions with a comment node. */
const render = (element: Parameters<typeof renderToString>[0]) =>
  renderToString(element).replaceAll("<!-- -->", "");

const card = (
  manifest: ConnectorManifest,
  props: Record<string, unknown> = {},
) =>
  render(
    createElement(ConnectorCard, { manifest, onConnect: () => {}, ...props }),
  );

test("a card names the service, its status and what the route will cost", () => {
  const html = card(
    build([{ id: "only", kind: "oauth-code", prerequisites: 1 }]),
  );
  assert.match(html, /Fixture Co/);
  assert.match(html, /Not connected/);
  assert.match(html, /2 handoffs/);
  assert.match(html, /Connect/);
});

test("a card never names the mechanism it resolved to", () => {
  // The manifest's own method labels are "Method oauth" and so on; a card that
  // leaked them would be asking a person to choose between protocols again.
  for (const kind of ["oauth-code", "device", "api-key"]) {
    const html = card(build([{ id: "only", kind }]));
    assert.doesNotMatch(html, /Method only/);
    for (const word of ["PKCE", "OAuth", "API key", "Device approval"])
      assert.doesNotMatch(html, new RegExp(word, "i"));
  }
});

test("with nothing declared, a card says what will happen rather than nothing", () => {
  assert.match(
    card(build([{ id: "only", kind: "oauth-code" }])),
    /Approve at the provider/,
  );
  assert.match(
    card(build([{ id: "only", kind: "device" }])),
    /Code on another device/,
  );
  assert.match(
    card(build([{ id: "only", kind: "api-key" }])),
    /Credential you hold/,
  );
  assert.match(
    card(build([{ id: "only", kind: "authmd-anonymous", anonymous: true }])),
    /No account needed/,
  );
});

test("a declared permission is what the card shows, in the host's words", () => {
  const intent: EntryContext = {
    permissions: [{ label: "Open pull requests for you", scopes: ["repo"] }],
  };
  const html = card(
    build([{ id: "only", kind: "oauth-code", scopes: ["repo"] }]),
    {
      intent,
    },
  );
  assert.match(html, /Open pull requests for you/);
  assert.match(html, /What Fixture Co will be able to do/);
  // The route label is the fallback for a host that declared nothing, not an
  // extra chip competing with what the host actually said.
  assert.doesNotMatch(html, /Approve at the provider/);
});

test("more permissions than fit are counted rather than dropped", () => {
  const html = card(build([{ id: "only", kind: "oauth-code" }]), {
    intent: {
      permissions: [
        { label: "Read your profile" },
        { label: "List your repositories" },
        { label: "Open pull requests" },
        { label: "Read your teams" },
        { label: "Write checks" },
      ],
    } satisfies EntryContext,
  });
  assert.match(html, /\+2/);
});

test("a connector no declared intent can use is shown as unusable, not offered", () => {
  const html = card(
    build([{ id: "only", kind: "oauth-code", scopes: ["read"] }]),
    { intent: { requiredScopes: ["admin"] } satisfies EntryContext },
  );
  assert.match(html, /Not available for this integration/);
  assert.match(html, /No route satisfies/);
  assert.match(html, /data-status="unavailable"/);
  assert.match(html, /disabled/);
});

test("a connected card offers management rather than another connection", () => {
  const html = card(build([{ id: "only", kind: "device" }]), {
    status: "connected",
  });
  assert.match(html, /Connected/);
  assert.match(html, /Manage/);
  assert.doesNotMatch(html, /Not connected/);
});

test("a card needing attention says so, and a caller may name the action", () => {
  const html = card(build([{ id: "only", kind: "device" }]), {
    status: "attention",
    actionLabel: "Reconnect",
  });
  assert.match(html, /Needs attention/);
  assert.match(html, /Reconnect/);
});

test("a busy card cannot be started twice", () => {
  const html = card(build([{ id: "only", kind: "device" }]), { busy: true });
  assert.match(html, /Opening/);
  assert.match(html, /disabled/);
});

test("a route that interrupts nobody says so instead of showing a count", () => {
  const zero = render(createElement(HandoffMeter, { count: 0 }));
  assert.match(zero, /No one is interrupted/);
  assert.match(zero, /data-cost="0"/);
  const one = render(createElement(HandoffMeter, { count: 1 }));
  assert.match(one, /1 handoff(?!s)/);
  // A count past the default scale widens the meter rather than clipping it.
  const many = render(createElement(HandoffMeter, { count: 5 }));
  assert.equal((many.match(/handoff-pip"/g) ?? []).length, 5);
  assert.match(many, /5 handoffs/);
});

test("a provider mark falls back to initials when the host supplies no logo", () => {
  assert.match(
    render(createElement(ProviderMark, { name: "Fixture Co" })),
    />FC</,
  );
  assert.match(render(createElement(ProviderMark, { name: "Stripe" })), />ST</);
  assert.match(
    render(createElement(ProviderMark, { name: "Neon", tint: "#0f7a6d" })),
    /background:#0f7a6d/,
  );
  assert.match(
    render(
      createElement(ProviderMark, {
        name: "Neon",
        logo: createElement("svg", { "data-brand": "neon" }),
      }),
    ),
    /data-brand="neon"/,
  );
});

test("a status chip can be relabelled without losing its tone", () => {
  assert.match(
    render(
      createElement(StatusChip, { status: "connected" }, "Linked 3 days ago"),
    ),
    /data-tone="ok"[\s\S]*Linked 3 days ago/,
  );
  assert.match(
    render(createElement(StatusChip, { status: "available" })),
    /data-tone="muted"/,
  );
});

test("a grid applies one intent to every card and per-connector presentation", () => {
  const html = render(
    createElement(ConnectorGrid, {
      manifests,
      onConnect: () => {},
      intent: { permissions: [{ label: "Act on your behalf" }] },
      present: (manifest) =>
        manifest.id === "stripe" ? { status: "connected" } : {},
    }),
  );
  for (const manifest of manifests)
    assert.match(html, new RegExp(manifest.name));
  assert.match(html, /Connected/);
  assert.match(html, /aria-label="Available connections"/);
  // One declaration reached every card.
  assert.equal(
    (html.match(/Act on your behalf/g) ?? []).length,
    manifests.length,
  );
});

test("a card may override the grid's intent for one connector", () => {
  const html = render(
    createElement(ConnectorGrid, {
      manifests,
      onConnect: () => {},
      intent: { permissions: [{ label: "Shared" }] },
      present: (manifest) =>
        manifest.id === "stripe"
          ? { intent: { permissions: [{ label: "Charge cards" }] } }
          : {},
    }),
  );
  assert.match(html, /Charge cards/);
  assert.equal((html.match(/Shared/g) ?? []).length, manifests.length - 1);
});

test("choosing a connector hands the whole manifest back to the host", async () => {
  const { window, document } = parseHTML(
    '<html><body><div id="root"></div></body></html>',
  );
  // react-dom/client reads these off the global before it will render at all.
  // The act flag is not cosmetic: without it React falls back to its real
  // scheduler, so how much has flushed by the time the assertions run depends
  // on how loaded the machine is. With it, act owns the queue and the test is
  // deterministic. tests/teaching-component.test.ts sets it for the same reason.
  const originals = new Map<string, PropertyDescriptor | undefined>();
  for (const [key, value] of Object.entries({
    window,
    document,
    IS_REACT_ACT_ENVIRONMENT: true,
  })) {
    originals.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { value, configurable: true });
  }
  try {
    const chosen: ConnectorManifest[] = [];
    const root = createRoot(
      document.getElementById("root") as unknown as Element,
    );
    await act(async () => {
      root.render(
        createElement(ConnectorGrid, {
          manifests,
          onConnect: (manifest) => chosen.push(manifest),
        }),
      );
    });
    const button = document.querySelector("[data-ceremony-card] button");
    assert.ok(button, "a card should offer an action");
    await act(async () => {
      button.dispatchEvent(new window.Event("click", { bubbles: true }));
    });
    assert.equal(chosen.length, 1);
    assert.equal(chosen[0]!.id, manifests[0]!.id);
    await act(async () => {
      root.unmount();
    });
  } finally {
    for (const [key, descriptor] of originals)
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else Reflect.deleteProperty(globalThis, key);
  }
});
