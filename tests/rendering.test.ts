import assert from "node:assert/strict";
import { test } from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { Ceremony, CeremonyView } from "../src/react/index.js";
import {
  actionsFor,
  fieldsFor,
  steps,
  createCeremonyClient,
  type CeremonySnapshot,
} from "../src/core/index.js";
import { manifests } from "../examples/manifests.js";
import { githubAppManifest } from "../src/server/github.js";

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
          if (snapshot.fields.some((field) => field.type === "password"))
            assert.match(html, /type="password"/);
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
