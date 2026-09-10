import assert from "node:assert/strict";
import { test } from "node:test";
import {
  actionsFor,
  defaultTemplate,
  flowKinds,
  steps,
} from "../src/core/schema.js";
import { registerCeremonyTools, toolState } from "../src/core/webmcp.js";
import { manifests } from "../examples/manifests.js";
import { jiraOwnerPage, jiraRequesterPage } from "../src/server/jira-human.js";

test("characterization: every flow template and state action", (t) => {
  t.assert.snapshot(flowKinds.map(defaultTemplate));
  t.assert.snapshot(
    steps.map((step) => ({
      step,
      authenticated: actionsFor(step),
      anonymous: actionsFor(step, true),
    })),
  );
});

test("characterization: agent tool contracts exclude execution functions and secrets", async (t) => {
  const tools: unknown[] = [];
  const manifest = manifests[0]!;
  await registerCeremonyTools(
    {
      registerTool: async ({ execute: _execute, ...tool }) => {
        tools.push(tool);
      },
    },
    "github",
    manifest,
    async () => undefined,
    new AbortController().signal,
  );
  t.assert.snapshot(tools);
  t.assert.snapshot(toolState(manifest));
});

function stablePage(html: string) {
  return html
    .replaceAll(/nonce="[^"]+"/g, 'nonce="stable"')
    .replaceAll(/nonce-[A-Za-z0-9-]+/g, "nonce-stable");
}

test("characterization: jira owner collector pages exclude secrets", async (t) => {
  const view = {
    id: "11111111-1111-4111-8111-111111111111",
    revision: 1,
    state: "pending" as const,
    siteUrl: "https://fixture.atlassian.net",
    callbackUrl:
      "https://app.example/api/v1/teaching/jira/authorization-return",
    scopes: ["read:jira-user"],
  };
  const returnUrl = "https://app.example/?connector=jira";
  const pages = [
    jiraOwnerPage(view, returnUrl),
    jiraOwnerPage({ ...view, state: "configured" }, returnUrl),
    jiraRequesterPage(
      "/api/v1/teaching/jira/11111111-1111-4111-8111-111111111111/owner-setup",
      returnUrl,
    ),
  ];
  const html = [];
  for (const page of pages) {
    assert.equal(page.headers.get("cache-control"), "no-store");
    assert.match(
      page.headers.get("content-security-policy") ?? "",
      /script-src 'nonce-/,
    );
    html.push(stablePage(await page.text()));
  }
  for (const body of html) {
    assert.equal(body.includes("fixture-secret"), false);
    assert.doesNotMatch(body, /name="clientSecret"[^>]*value=/);
    assert.match(body, /Return to connection/);
  }
  t.assert.snapshot(html[0]);
  t.assert.snapshot(html[1]);
  t.assert.snapshot(html[2]);
});
