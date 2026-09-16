import assert from "node:assert/strict";
import { test } from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { Ceremony, CeremonyView } from "../src/react/index.js";
import {
  actionsFor,
  defaultTemplate,
  fieldsFor,
  steps,
  createCeremonyClient,
  type CeremonySnapshot,
} from "../src/core/index.js";
import { manifests } from "../examples/manifests.js";
import { githubAppManifest } from "../src/server/github.js";
import { parseHTML } from "linkedom";

test("rendering: extracted method picker preserves route labels and distinct same-route choices", () => {
  const manifest = {
    ...githubAppManifest,
    methods: [
      githubAppManifest.methods[0]!,
      {
        ...githubAppManifest.methods[0]!,
        id: "second-app",
        label: "Second app",
      },
    ],
  };
  const client = createCeremonyClient({ manifest, selection: "manual" });
  try {
    const { document } = parseHTML(
      renderToStaticMarkup(
        createElement(CeremonyView, {
          model: {
            snapshot: undefined,
            busy: false,
            refreshing: false,
            error: "",
            client,
            execute: client.execute,
            manifest,
          },
        }),
      ),
    );
    assert.equal(
      document.querySelector(".method-picker label")?.textContent,
      "How to connect",
    );
    assert.deepEqual(
      Array.from(document.querySelectorAll("option"), (option) => [
        option.getAttribute("value"),
        option.textContent,
      ]),
      [
        [
          manifest.methods[0]!.id,
          `Approve at the provider · ${manifest.methods[0]!.label}`,
        ],
        ["second-app", "Approve at the provider · Second app"],
      ],
    );
    assert.equal(
      document.querySelector("h2")?.textContent,
      `Connect ${manifest.name}`,
    );
  } finally {
    client.dispose();
  }
});

for (const manifest of [...manifests, githubAppManifest]) {
  for (const method of manifest.methods)
    test(`rendering: ${manifest.id}/${method.kind} renders every state without exposing connection references`, () => {
      const client = createCeremonyClient({ manifest, selection: "manual" });
      try {
        for (const step of steps) {
          const snapshot: CeremonySnapshot = {
            id: "render-run",
            revision: 1,
            connectorId: manifest.id,
            connectorName: manifest.name,
            description: manifest.description,
            method,
            step,
            fields: fieldsFor(step, method),
            actions: actionsFor(step),
            expiresAt: 2000000000000,
            authorizationUrl: "https://provider.example/authorize",
            verificationUri: "https://provider.example/verify",
            userCode: "ABCD",
            outcome: {
              connectionRef: "private-connection-handle",
              ownership: step === "anonymous" ? "anonymous" : "authenticated",
              scopes: method.scopes,
            },
          };
          const html = renderToStaticMarkup(
            createElement(CeremonyView, {
              model: {
                snapshot,
                busy: false,
                refreshing: false,
                error: "",
                client,
                execute: client.execute,
                manifest,
              },
              className: "host-theme",
              dir: "rtl",
              autoFocus: false,
            }),
          );
          assert.match(html, /role="region"/);
          assert.ok(html.includes(`data-step="${step}"`));
          assert.match(html, /host-theme/);
          assert.match(html, /dir="rtl"/);
          assert.doesNotMatch(html, /private-connection-handle/);
          for (const field of snapshot.fields.filter(
            (entry) => entry.type === "password",
          )) {
            assert.match(html, /type="password"/);
            // The Show and Copy controls sit inside the <label> that would
            // otherwise name this input, so a name computed from the label's
            // text picks them up too — "API token Show API token Copy API
            // token" — and the field stops being findable by its own name.
            // The explicit name is what keeps it addressable, to a screen
            // reader and to anything driving the page.
            assert.match(
              html,
              new RegExp(
                `aria-label="${field.label.replace(/[.*+?^$\\{}()|[\]]/g, "\\$&")}"`,
              ),
              `${field.name} should be named by its own label alone`,
            );
          }
        }
      } finally {
        client.dispose();
      }
    });
}
test("rendering: external hosts can replace the complete view without triggering network requests", () => {
  const html = renderToStaticMarkup(
    createElement(Ceremony, {
      manifest: manifests[0]!,
      selection: "manual",
      webmcp: false,
      children: (model) =>
        createElement(
          "output",
          null,
          `${model.manifest.id}:${model.snapshot ? "started" : "idle"}`,
        ),
    }),
  );
  assert.equal(html, "<output>github:idle</output>");
});

test("rendering: host styling, errors and every prerequisite status remain accessible", () => {
  const manifest = githubAppManifest;
  const client = createCeremonyClient({ manifest, selection: "manual" });
  try {
    const statuses = [
      "blocked",
      "ready",
      "awaiting-human",
      "verifying",
      "succeeded",
      "failed",
    ] as const;
    const snapshot: CeremonySnapshot = {
      id: "run",
      revision: 0,
      connectorId: manifest.id,
      connectorName: manifest.name,
      description: "",
      method: manifest.methods[0]!,
      step: "redirect",
      fields: [],
      actions: ["cancel"],
      expiresAt: 2000000000000,
      authorizationUrl: "https://provider.example/authorize",
      prerequisites: statuses.map((status) => ({
        id: status,
        label: status,
        status,
      })),
    };
    for (const current of [undefined, snapshot])
      for (const busy of [false, true]) {
        const html = renderToStaticMarkup(
          createElement(CeremonyView, {
            model: {
              snapshot: current,
              busy,
              refreshing: false,
              error: "Try again",
              client,
              execute: client.execute,
              manifest,
            },
            "aria-label": "Host connection",
            id: "host",
            style: { color: "red" },
          }),
        );
        assert.match(html, /role="alert"/);
        assert.match(html, /aria-label="Host connection"/);
        assert.match(html, /style="color:red"/);
        if (current)
          for (const label of [
            "Blocked",
            "Ready",
            "Needs your approval",
            "Verifying",
            "Verified",
            "Needs attention",
          ])
            assert.ok(html.includes(label));
      }
    const template = defaultTemplate("github-app");
    template.screens.redirect = "bad";
    const invalid = renderToStaticMarkup(
      createElement(CeremonyView, {
        model: {
          snapshot,
          busy: false,
          refreshing: false,
          error: "",
          client,
          execute: client.execute,
          manifest,
        },
        templates: [template],
      }),
    );
    assert.match(invalid, /invalid or incompatible/);
  } finally {
    client.dispose();
  }
});
