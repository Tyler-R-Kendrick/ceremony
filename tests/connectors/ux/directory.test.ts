import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import {
  ConnectorDirectory,
  filterCatalog,
  groupByService,
  implementedDimensions,
} from "../../../src/react/connector-directory.js";
import { fixtureCatalog } from "./fixture.js";
import { mount } from "./render.js";

/*
 * The directory is the first thing a person sees and the easiest place to make
 * a claim the deployment cannot keep. These tests hold it to the inventory: the
 * rows come from the server's catalogue, alternatives stay separate, paging is
 * a rendering budget rather than a filter, and every badge says something the
 * entry actually reports.
 */

const entries = fixtureCatalog();

test("search and facets run over the whole inventory, not the rendered page", () => {
  assert.equal(filterCatalog(entries, { query: "petstore" }).length, 1);
  assert.equal(
    filterCatalog(entries, { custody: "external-credential-broker" }).length,
    1,
  );
  assert.equal(
    filterCatalog(entries, { dimension: "invoke" }).every((entry) =>
      implementedDimensions(entry).includes("invoke"),
    ),
    true,
  );
  assert.equal(filterCatalog(entries, { support: "unconfigured" }).length, 1);
  assert.equal(filterCatalog(entries, { ecosystem: "nango" }).length, 1);
  assert.equal(
    filterCatalog(entries, { evidence: "browser-integration" }).length,
    1,
  );
  assert.equal(
    filterCatalog(entries, { query: "nothing here at all" }).length,
    0,
  );
});

test("alternatives for one service are grouped and never merged", () => {
  const groups = groupByService(entries);
  const github = groups.find((group) => group.group === "github");
  assert.ok(github);
  assert.equal(github.entries.length, 2);
  assert.deepEqual(github.entries.map((entry) => entry.id).sort(), [
    "github-app",
    "github-via-broker",
  ]);
  assert.notDeepEqual(github.entries[0]!.custody, github.entries[1]!.custody);
});

test("the rendered directory distinguishes implementation, configuration and evidence", async () => {
  const opened: string[] = [];
  const view = await mount(
    createElement(ConnectorDirectory, {
      entries,
      pageSize: 40,
      onOpen: (entry) => opened.push(entry.id),
    }),
  );
  try {
    const github = view.query('[data-connector-group="github"]');
    assert.ok(github);
    assert.equal(github.querySelectorAll("[data-connector-entry]").length, 2);
    assert.match(github.textContent ?? "", /2 alternatives, kept separate/);

    const native = view.query('[data-connector-entry="github-app"]');
    assert.ok(native);
    assert.equal(native.getAttribute("data-support"), "provider-backed");
    assert.match(native.textContent ?? "", /Provider-backed/);
    assert.match(native.textContent ?? "", /Evidence: Browser/);
    assert.match(native.textContent ?? "", /Host-held credential/);

    const broker = view.query('[data-connector-entry="github-via-broker"]');
    assert.match(broker?.textContent ?? "", /Local fixture/);
    assert.match(broker?.textContent ?? "", /Broker vends the credential/);
    assert.match(broker?.textContent ?? "", /Evidence: Protocol fixture/);

    // AC-UX-06: implemented, unconfigured and described-only are three states.
    const unconfigured = view.query('[data-connector-entry="vercel-connect"]');
    assert.match(unconfigured?.textContent ?? "", /Needs configuration/);
    assert.match(unconfigured?.textContent ?? "", /VERCEL_TEAM_ID/);

    const described = view.query('[data-connector-entry="smithery-registry"]');
    assert.match(described?.textContent ?? "", /Described only/);
    assert.equal(
      described?.querySelector("button")?.textContent,
      "Review Smithery catalogue",
    );

    await view.clickElement(native.querySelector("button")!);
    assert.deepEqual(opened, ["github-app"]);
  } finally {
    await view.close();
  }
});

test("paging renders a budget while search still reaches everything", async () => {
  const view = await mount(
    createElement(ConnectorDirectory, {
      entries,
      pageSize: 3,
      onOpen: () => {},
    }),
  );
  try {
    const rendered = () => view.all("[data-connector-entry]").length;
    assert.ok(rendered() <= 4, `first page rendered ${rendered()} cards`);
    assert.match(view.text, /Show \d+ more of \d+/);

    // A row well past the first page is still findable, which is the whole
    // point: paging must not become a filter.
    await view.fill("#connector-directory-search", "Sample 26");
    assert.equal(rendered(), 1);
    assert.match(view.text, /1 of \d+ connectors match/);

    await view.fill("#connector-directory-search", "");
    assert.ok(rendered() <= 4);
    const more = view.button("Show");
    assert.ok(more);
    await view.clickElement(more);
    assert.ok(rendered() > 3);
  } finally {
    await view.close();
  }
});

test("a facet narrows the inventory and says how much of it is showing", async () => {
  const view = await mount(
    createElement(ConnectorDirectory, {
      entries,
      pageSize: 40,
      onOpen: () => {},
    }),
  );
  try {
    await view.fill(
      "#connector-directory-custody",
      "external-credential-broker",
    );
    assert.equal(view.all("[data-connector-entry]").length, 1);
    assert.match(view.text, /1 of \d+ connectors match/);
    await view.fill("#connector-directory-custody", "");
    await view.fill("#connector-directory-evidence", "live-authorized");
    assert.equal(view.all("[data-connector-entry]").length, 0);
    assert.match(view.text, /No connector in this deployment matches that/);
  } finally {
    await view.close();
  }
});
