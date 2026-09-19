import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { createConnectorClient } from "../../../src/core/connectors/client.js";
import {
  ConnectorImport,
  DefinitionReviewPanel,
} from "../../../src/react/connector-review.js";
import { blockedDefinition, createConnectorFixture } from "./fixture.js";
import { mount } from "./render.js";

/*
 * Import review. The two things worth proving here are that a reviewer sees
 * the blocking losses before anything else, and that the page says only what
 * the diagnostics said — never the document those diagnostics point at.
 */

const review = {
  definition: blockedDefinition(),
  source: {
    sourceRef: "source:legacy-signed",
    identity: blockedDefinition().identity,
    format: { name: "openapi", version: "3.1.0" },
    origin: {
      kind: "url" as const,
      location: "https://vendor.test/openapi.json",
    },
    digest: { algorithm: "sha256" as const, value: "c".repeat(64) },
    byteLength: 8192,
    mediaType: "application/json",
    capturedAt: "2026-09-18T09:00:00.000Z",
    license: { spdx: "NOASSERTION", redistributable: "unknown" as const },
    adaptation: [],
    overlays: [],
  },
};

test("AC-UX-03: blocking security losses come first and say what they block", async () => {
  const view = await mount(
    createElement(DefinitionReviewPanel, { review, busy: false }),
  );
  try {
    const groups = view.all("[data-connector-issue-group]");
    assert.equal(
      groups[0]?.getAttribute("data-connector-issue-group"),
      "security",
    );
    assert.match(groups[0]?.textContent ?? "", /1 blocking/);
    assert.match(view.text, /security-relevant loss/);
    assert.match(view.text, /blocks authorization/);
    assert.match(view.text, /openapi\.security\.unsupported-scheme/);
    // The unsupported profile is shown as exactly that, not as a method.
    assert.match(view.text, /not executable/);
    // Provenance a reviewer needs to decide anything at all.
    const provenance = view.query("[data-connector-provenance]");
    assert.match(provenance?.textContent ?? "", /openapi 3\.1\.0/);
    assert.match(provenance?.textContent ?? "", /vendor\.test/);
    assert.match(provenance?.textContent ?? "", /NOASSERTION/);
    assert.match(provenance?.textContent ?? "", /sha256:cccccccccccccccc…/);
    // Every dimension is stated, including the ones that did not survive.
    assert.match(view.text, /Not supported by this runtime/);
  } finally {
    await view.close();
  }
});

test("publish controls appear only when the server grants the role", async () => {
  const reader = await mount(
    createElement(DefinitionReviewPanel, {
      review,
      viewer: { capabilities: ["executor"], ownerKinds: ["user"] },
      onBind: () => assert.fail("a reader must not be able to bind"),
    }),
  );
  try {
    assert.equal(reader.query("[data-connector-publish]"), null);
    assert.ok(reader.query("[data-connector-readonly]"));
    assert.match(reader.text, /need an operator role/);
  } finally {
    await reader.close();
  }

  const operator = await mount(
    createElement(DefinitionReviewPanel, {
      review,
      viewer: { capabilities: ["publisher"], ownerKinds: ["user"] },
      onBind: () => assert.fail("binding stays blocked while a blocker stands"),
    }),
  );
  try {
    assert.ok(operator.query("[data-connector-publish]"));
    const bind = operator.button("Propose a runtime binding") as unknown as {
      disabled: boolean;
    };
    // The role is present; the blocking issue still refuses the binding, and
    // the copy says the server refuses it too.
    assert.equal(bind.disabled, true);
    assert.match(operator.text, /The server refuses it too/);
  } finally {
    await operator.close();
  }
});

test("an operator can propose a binding for a description with nothing blocking", async () => {
  const fixture = createConnectorFixture();
  const clean = fixture.definitions.find(
    (item) => item.definitionRef === "definition:github-app",
  )!;
  const proposals: string[] = [];
  const view = await mount(
    createElement(DefinitionReviewPanel, {
      review: { definition: clean, source: review.source },
      viewer: { capabilities: ["admin"], ownerKinds: ["user"] },
      onBind: (chosen, profileId) =>
        proposals.push(`${chosen.definition.definitionRef}:${profileId}`),
    }),
  );
  try {
    await view.fill("#connector-bind-profile", "oauth");
    await view.click("Propose a runtime binding");
    assert.deepEqual(proposals, ["definition:github-app:oauth"]);
  } finally {
    await view.close();
  }
});

test("an import shows diagnostics without echoing the document", async () => {
  const fixture = createConnectorFixture();
  const client = createConnectorClient({ fetch: fixture.fetch });
  const canary = '{"info":{"x-key":"CANARY-IMPORT-SECRET"}}';
  const view = await mount(
    createElement(ConnectorImport, {
      client,
      viewer: { capabilities: ["executor"], ownerKinds: ["user"] },
    }),
  );
  try {
    await view.fill("#connector-import-text", canary);
    await view.submit("[data-connector-import] form");
    await view.waitFor(() => view.text.includes("Legacy signed API"));
    assert.match(view.text, /1 description read/);
    assert.match(view.text, /Nothing executable was registered/);
    assert.match(view.text, /openapi\.security\.unsupported-scheme/);
    // The document a person pasted stays in the field they pasted it into.
    // What the server sent back carries codes and pointers and nothing else,
    // so a key sitting in an example value cannot arrive with its diagnostic.
    const reviewed = [
      view.query("[data-connector-issues]")?.textContent ?? "",
      view.query("[data-connector-definition]")?.textContent ?? "",
    ].join(" ");
    assert.doesNotMatch(reviewed, /CANARY-IMPORT-SECRET/);
    assert.match(reviewed, /components\/securitySchemes\/vendorHmac/);
  } finally {
    await view.close();
  }
});

test("a description that cannot be read back does not unsay the import", async () => {
  const fixture = createConnectorFixture();
  const client = createConnectorClient({
    // The document imports; reading back the description it produced does not.
    // These are two different failures, and only one of them is about the
    // document.
    fetch: (async (input: RequestInfo | URL, init?: RequestInit) =>
      String(input).includes("/definitions/")
        ? new Response(JSON.stringify({ error: "not-found" }), {
            status: 404,
            headers: { "content-type": "application/json" },
          })
        : fixture.fetch(input, init)) as typeof fetch,
  });
  const view = await mount(createElement(ConnectorImport, { client }));
  try {
    await view.fill("#connector-import-text", '{"openapi":"3.1.0"}');
    await view.submit("[data-connector-import] form");
    await view.waitFor(() => view.text.includes("could not be read back"));
    // What the importer said about this document is still on screen beside the
    // count that summarised it.
    assert.match(view.text, /1 description read/);
    assert.ok(view.query("[data-connector-issues]"));
    assert.match(view.text, /openapi\.security\.unsupported-scheme/);
    assert.match(view.text, /no longer exists/);
    // No review panel, because no description was read; that is the only thing
    // the failed read decides.
    assert.equal(view.query("[data-connector-definition]"), null);
  } finally {
    await view.close();
  }
});

test("the URL field is named by its label and explained by its description", async () => {
  const fixture = createConnectorFixture();
  const client = createConnectorClient({ fetch: fixture.fetch });
  const view = await mount(createElement(ConnectorImport, { client }));
  try {
    const url = view.all("input[name='connector-import-kind']").at(1) as
      (Record<string, unknown> & { checked: boolean }) | undefined;
    assert.ok(url);
    // A radio reports its state on the click, so the state comes first.
    url.checked = true;
    await view.clickElement(url as never);
    const field = view.query("#connector-import-url");
    assert.ok(field);
    const label = view
      .all("label")
      .find(
        (element) => element.getAttribute("for") === "connector-import-url",
      );
    // The name is the field's name. The network policy under it is a
    // description the control points at, not part of what it is called.
    assert.equal(label?.textContent, "Document URL");
    const describedBy = field.getAttribute("aria-describedby") ?? "";
    assert.match(
      view.query(`#${describedBy}`)?.textContent ?? "",
      /own network policy/,
    );
  } finally {
    await view.close();
  }
});

test("an invalid document reports its issues, not its contents", async () => {
  const fixture = createConnectorFixture();
  const client = createConnectorClient({ fetch: fixture.fetch });
  const view = await mount(createElement(ConnectorImport, { client }));
  try {
    await view.fill("#connector-import-text", "{}");
    await view.submit("[data-connector-import] form");
    await view.waitFor(() => view.text.includes("could not be read"));
    assert.doesNotMatch(view.text, /Legacy signed API/);
    assert.equal(view.query("[data-connector-publish]"), null);
  } finally {
    await view.close();
  }
});
