import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToString } from "react-dom/server";
import {
  flowKinds,
  manifestSchema,
  snapshotSchema,
  type CeremonySnapshot,
} from "../src/core/schema.js";
import { CeremonyView } from "../src/react/index.js";
import { ConnectorCard } from "../src/react/connectors.js";
import { createCeremonyClient } from "../src/core/client.js";
import { humanHandoffs, routeFor } from "../src/core/resolution.js";
import {
  liveConnectors,
  mcpManifest,
} from "../scripts/gallery-live-connectors.js";
import { createConnectorTransport } from "../scripts/gallery-live.js";
import { manifests } from "../examples/manifests.js";
import {
  asSpecimen,
  carrierFor,
  catalogue,
  everyManifest,
  galleryPayload,
  journeys,
  permissionChoices,
  permissionScopesAreReal,
  scopeVocabulary,
  specimen,
  tabStops,
  templateFor,
  walls,
} from "../scripts/gallery-data.js";
import { authScenarios } from "./doubles/auth-provider/scenarios.js";

/**
 * The published catalogue is generated, not written, and these are the claims
 * that generation has to keep true. A gallery is worth exactly as much as its
 * agreement with the thing it depicts.
 */

test("every scenario the doubles drive reaches the published catalogue", () => {
  const published = catalogue();
  assert.equal(published.length, authScenarios.length);
  assert.deepEqual(
    published.map((entry) => entry.id).sort(),
    authScenarios.map((scenario) => scenario.id).sort(),
  );
});

test("every scenario states an outcome the page can print", () => {
  // "unstated" is the fallback for an expectation shape this reducer does not
  // understand. One appearing means the scenario format moved and the page is
  // quietly printing less than it used to.
  for (const entry of catalogue())
    assert.notEqual(entry.outcome, "unstated", `${entry.id} has no outcome`);
});

test("every flow kind is shown, and shown as a sequence it really walks", () => {
  for (const kind of flowKinds) {
    const steps = journeys[kind];
    assert.ok(steps?.length, `${kind} has no journey`);
    // Every flow starts by saying what is about to happen and ends completed;
    // a journey that skipped either would be depicting a different product.
    assert.equal(steps[0], "intro", `${kind} does not start at intro`);
    assert.equal(steps.at(-1), "complete", `${kind} does not end complete`);
    assert.equal(new Set(steps).size, steps.length, `${kind} repeats a screen`);
  }
});

test("every flow kind is carried by a connector this project really ships", () => {
  for (const kind of flowKinds) {
    const { manifest, method } = carrierFor(kind);
    assert.equal(method.kind, kind);
    assert.ok(manifest.methods.includes(method));
  }
});

test("every screen on the page is one the production schema accepts", () => {
  for (const kind of flowKinds)
    for (const step of journeys[kind]) {
      const snapshot = specimen(kind, step);
      // specimen() parses on the way out; re-parsing proves the value it
      // returned is still acceptable rather than merely having been built.
      assert.deepEqual(snapshotSchema.parse(snapshot), snapshot);
      assert.equal(snapshot.step, step);
      assert.equal(snapshot.method.kind, kind);
    }
  for (const step of walls) assert.equal(specimen("form", step).step, step);
});

test("a redirect carries somewhere to go and a wait carries a code", () => {
  // The screens differ in what they must show, and a specimen missing that
  // field would render an empty screen that looks like a styling bug.
  assert.ok(specimen("oauth-code", "redirect").authorizationUrl);
  assert.ok(specimen("device", "waiting").userCode);
  assert.ok(specimen("api-key", "complete").outcome);
  assert.ok(specimen("form", "error").message);
});

test("anonymous access completes owned by nobody, and can still be claimed", () => {
  assert.equal(
    specimen("authmd-anonymous", "complete").outcome?.ownership,
    "anonymous",
  );
  assert.ok(journeys["authmd-anonymous"].includes("claim"));
  // No other flow has anything to claim.
  for (const kind of flowKinds)
    if (kind !== "authmd-anonymous")
      assert.ok(!journeys[kind].includes("claim"), `${kind} claims ownership`);
});

test("the registration variants the catalogue documents are all published", () => {
  const registration = catalogue().filter(
    (entry) => entry.goal === "registration",
  );
  assert.equal(
    registration.length,
    authScenarios.filter((scenario) => scenario.goal === "registration").length,
  );
  // More than one flow kind creates accounts, which is the point of grouping
  // by goal rather than by mechanism.
  assert.ok(
    new Set(registration.map((entry) => entry.flowKind)).size > 1,
    "registration should span more than one flow kind",
  );
  // A variant nobody can act on is not a variant.
  for (const entry of registration)
    assert.ok(entry.provides.length, `${entry.id} asks for nothing`);
});

/**
 * Minimal valid answers for the live probes, shaped like the real ones.
 *
 * Values are invented on purpose: the point is to record which tools a probe
 * reaches, and a real account's data has no business in a test fixture.
 */
const probeDouble: Record<string, unknown> = {
  get_me: {
    login: "example-user",
    details: { name: "Example User", public_repos: 1, followers: 0 },
  },
  search_repositories: { total_count: 0, items: [] },
  list_projects: { projects: [] },
};

test("every scope the page offers is one a connector here really declares", () => {
  // The labels are the host's copy and the page writes them. The scopes are
  // not copy: a permission naming a scope no method grants would filter
  // nothing, and the resolver demonstration would come out well because the
  // question was rigged rather than because the policy works.
  assert.ok(
    permissionScopesAreReal(),
    `offered scopes should all appear in ${JSON.stringify(scopeVocabulary())}`,
  );
  assert.ok(permissionChoices.length, "the page should offer some permission");
});

test("the resolver in the page runs against the manifests this project ships", () => {
  const payload = galleryPayload();
  assert.equal(payload.connectors.length, everyManifest.length);
  // Keys, not ids: two connectors here are both `github`, and a page keyed on
  // the id would silently show one of them twice.
  assert.equal(
    new Set(payload.connectors.map((entry) => entry.key)).size,
    payload.connectors.length,
  );
  for (const entry of payload.connectors) {
    // The browser re-parses what travels to it, so what travels has to survive
    // the trip: JSON is the wire, and the production schema is the gate.
    const shipped = manifestSchema.parse(
      JSON.parse(JSON.stringify(entry.manifest)),
    );
    assert.deepEqual(shipped, entry.manifest);
  }
});

test("every flow kind the page resolves to is one the page also shows", () => {
  // The resolver can only choose a method some connector declares, and the
  // catalogue shows a journey per flow kind. A kind reachable by resolution
  // but absent from the journeys would be a route with nowhere to look it up.
  const reachable = new Set(
    everyManifest.flatMap((manifest) =>
      manifest.methods.map((method) => method.kind),
    ),
  );
  for (const kind of reachable)
    assert.ok(journeys[kind]?.length, `${kind} resolves but has no journey`);
});

test("nothing inside a rendered specimen is left in the tab order", () => {
  // The claim the page makes about itself, checked against what the real
  // components actually render rather than against a hand-written sample. A
  // control that kept its tab stop is a control somebody can reach, press, and
  // watch do nothing.
  const rendered = [
    renderToString(
      createElement(ConnectorCard, {
        manifest: manifests[0]!,
        status: "available",
        onConnect: () => {},
      }),
    ),
    ...flowKinds.flatMap((kind) =>
      journeys[kind].map((step) => {
        const { manifest } = carrierFor(kind);
        return renderToString(
          createElement(CeremonyView, {
            model: {
              snapshot: specimen(kind, step),
              busy: false,
              refreshing: false,
              error: "",
              manifest,
              execute: async () => undefined,
              // Constructing a client performs no I/O, so this is the real
              // one the view would be handed rather than a shape resembling it.
              client: createCeremonyClient({ manifest }),
            },
            autoFocus: false,
            templates: [templateFor(kind)],
          }),
        );
      }),
    ),
  ];
  // A specimen with no control at all would pass the assertion below without
  // exercising it.
  assert.ok(
    rendered.reduce((total, html) => total + tabStops(html), 0) > 10,
    "the specimens should render controls worth neutralising",
  );
  for (const html of rendered)
    assert.equal(tabStops(asSpecimen(html)), 0, html.slice(0, 200));
});

test("neutralising a specimen neither dims a control nor mangles an element", () => {
  // `disabled` and `aria-disabled` both grey the control out, and a catalogue
  // showing a greyed Connect is showing a button the product never renders.
  const html = asSpecimen(
    '<article data-ceremony-card=""><a href="/x">go</a><button type="button" class="primary">Connect</button></article>',
  );
  assert.ok(!html.includes("disabled"), html);
  // `<article` starts with an `a`, and a neutraliser that rewrote it would
  // produce an element no browser has heard of.
  assert.ok(html.includes('<article data-ceremony-card=""'), html);
  assert.equal(tabStops(html), 0);
  assert.equal((html.match(/tabindex="-1"/g) ?? []).length, 2);
});

test("the page declares exactly the connector tools its probes call", async () => {
  // A tool the page calls but never declared is refused at runtime with
  // `not_in_manifest`, and a tool declared but never called asks the viewer to
  // grant access nobody needs. Both are invisible until somebody presses
  // Connect on a published page, so they are checked here instead.
  for (const live of liveConnectors) {
    const called: string[] = [];
    await live.probe(async (tool) => {
      called.push(tool);
      return probeDouble[tool];
    });
    const declared = mcpManifest.servers.find(
      (entry) => entry.server === live.server,
    );
    assert.ok(declared, `${live.server} should be declared`);
    assert.deepEqual(
      [...called].sort(),
      [...declared.tools].sort(),
      `${live.server}: declared tools should be the ones the probe calls`,
    );
    // The capability refuses a server entry carrying no tools, and treats it
    // as "none" rather than "all", so an empty list is never a shorthand.
    assert.ok(declared.tools.length, `${live.server} declares no tool`);
  }
});

test("a live connector states the mechanism that really runs", async () => {
  for (const live of liveConnectors) {
    // Through the production schema, so a live manifest obeys every rule the
    // library enforces on a connector somebody else writes.
    assert.deepEqual(manifestSchema.parse(live.manifest), live.manifest);
    const method = live.manifest.methods[0]!;
    // One method, because there is exactly one way this page connects. A
    // picker here would offer a choice that does not exist.
    assert.equal(live.manifest.methods.length, 1);
    // The grant is the tools, so the scopes have to be the tools; anything
    // else would tell a person they granted something they did not.
    assert.deepEqual(
      [...method.scopes].sort(),
      [
        ...(mcpManifest.servers.find((entry) => entry.server === live.server)
          ?.tools ?? []),
      ].sort(),
    );
    // It collects nothing: the credential is the viewer's assistant's, and a
    // field here would be this page asking for a secret it must never hold.
    assert.deepEqual(method.fields, []);
    // The label has to name the surface doing the approving, or "oauth-code"
    // reads as a redirect this page never performs.
    assert.match(method.label, /claude\.ai/);
    assert.equal(routeFor(method), "provider-approval");
    assert.equal(humanHandoffs(method), 1);
  }
});

test("every live connector is one this project already ships a manifest for", () => {
  // The live section exists to demonstrate the catalogue, not to introduce
  // services the catalogue never mentions.
  const known = new Set(everyManifest.map((manifest) => manifest.id));
  for (const live of liveConnectors)
    assert.ok(
      known.has(live.manifest.id),
      `${live.manifest.id} is live but absent from the catalogue`,
    );
});

/** Drive the real transport to the screen one connector failure produces. */
async function failWith(rejection: unknown): Promise<CeremonySnapshot> {
  const live = liveConnectors[0]!;
  const transport = createConnectorTransport(
    live,
    async () => {
      throw rejection;
    },
    () => {},
  );
  const started = await transport.start(live.manifest.id, "delegated");
  return transport.act(started.id, {
    action: "begin",
    revision: started.revision,
    values: {},
  });
}

test("declining a connector does not offer a retry that would ask again", async () => {
  // `not_in_manifest` is what a decline actually returns, and the capability
  // says not to re-ask in a loop. A Try again button is exactly that loop, so
  // the screen carries the fix and nothing to press.
  const snapshot = await failWith({
    code: "not_in_manifest",
    message: "declined",
    server: "github",
  });
  assert.equal(snapshot.step, "cancelled");
  assert.deepEqual(snapshot.actions, []);
  assert.match(snapshot.message ?? "", /not allowed to use github/);
});

test("a failure a person can clear keeps the retry that clears it", async () => {
  for (const code of [
    "server_not_connected",
    "needs_reauth",
    "selection_required",
    "server_unavailable",
    "rate_limited",
    "tool_error",
  ]) {
    const snapshot = await failWith({ code, message: "x", server: "github" });
    assert.ok(
      snapshot.actions.includes("retry"),
      `${code} should keep its retry`,
    );
  }
});

test("a failure retrying cannot clear does not pretend otherwise", async () => {
  for (const code of [
    "blocked_by_policy",
    "approval_required",
    "not_granted",
    "capability_disabled",
    "capability_removed",
    "user_changed",
    "bad_request",
    "transform_error",
    "server_not_found",
  ]) {
    const snapshot = await failWith({ code, message: "x", server: "github" });
    assert.deepEqual(snapshot.actions, [], `${code} should offer no retry`);
  }
});

test("every connector failure code says something of its own", async () => {
  // The named anti-pattern for this capability is collapsing distinct codes
  // into one banner, because that hides the one action that would fix the
  // page. Distinct sentences are the check that it has not happened.
  const codes = [
    "needs_reauth",
    "server_not_connected",
    "selection_required",
    "server_not_found",
    "server_unavailable",
    "not_in_manifest",
    "blocked_by_policy",
    "approval_required",
    "tool_error",
    "bad_request",
    "cancelled",
    "rate_limited",
    "upstream_error",
    "not_granted",
    "consent_required",
    "user_changed",
  ];
  const messages = new Map<string, string[]>();
  for (const code of codes) {
    const snapshot = await failWith({ code, message: "x", server: "github" });
    assert.ok(snapshot.message, `${code} says nothing`);
    messages.set(snapshot.message!, [
      ...(messages.get(snapshot.message!) ?? []),
      code,
    ]);
  }
  // `not_granted` and its two aliases are one state by the contract's own
  // reading; nothing else may share a sentence.
  const shared = [...messages.values()].filter((group) => group.length > 1);
  assert.deepEqual(shared, [], "these codes share one sentence");
});

test("a stale action is refused, as the connection server would refuse it", async () => {
  const live = liveConnectors[0]!;
  const transport = createConnectorTransport(
    live,
    async () => {
      throw new Error("the stale action should be refused before any call");
    },
    () => {},
  );
  const started = await transport.start(live.manifest.id, "delegated");
  await assert.rejects(
    () =>
      transport.act(started.id, {
        action: "begin",
        revision: started.revision + 5,
        values: {},
      }),
    /moved on/,
  );
});

test("what the card promises is what the page is allowed to ask for", async () => {
  for (const live of liveConnectors) {
    // The card lists these before anybody presses Connect, and pressing it
    // calls the provider straight away — so a label here that named access the
    // page never declared would be a promise nothing checks.
    assert.ok(live.access.length, `${live.server} declares no access`);
    assert.deepEqual(
      live.access.map((entry) => entry.tool),
      [...live.manifest.methods[0]!.scopes],
    );
    for (const entry of live.access) assert.ok(entry.label.trim().length > 3);
    assert.equal(
      new Set(live.access.map((entry) => entry.label)).size,
      live.access.length,
      `${live.server} repeats a label`,
    );
  }
});

test("the page only calls tools that read, because it tells viewers so", () => {
  // Every completion screen carries "nothing was written". That sentence is a
  // promise to somebody handing over their credentials, and the only thing
  // keeping it true is which tools the page may call — so the shape of those
  // names is checked rather than trusted. A write tool added later fails here
  // instead of quietly making the page lie.
  for (const live of liveConnectors)
    for (const entry of live.access)
      assert.match(
        entry.tool,
        /^(get|list|search|read)_/,
        `${live.server}/${entry.tool} is not obviously a read`,
      );
});

test("a screen offering nothing refuses the action it does not offer", async () => {
  // The transport states what is available and then enforces it, rather than
  // leaving that to whichever client happens to be driving it.
  const snapshot = await failWith({
    code: "blocked_by_policy",
    message: "x",
    server: "github",
  });
  assert.deepEqual(snapshot.actions, []);
  const live = liveConnectors[0]!;
  const transport = createConnectorTransport(
    live,
    async () => {
      throw { code: "blocked_by_policy", message: "x", server: live.server };
    },
    () => {},
  );
  const started = await transport.start(live.manifest.id, "delegated");
  const blocked = await transport.act(started.id, {
    action: "begin",
    revision: started.revision,
    values: {},
  });
  await assert.rejects(
    () =>
      transport.act(blocked.id, {
        action: "retry",
        revision: blocked.revision,
        values: {},
      }),
    /not available on this screen/,
  );
});

test("a connection that succeeds completes with what the provider returned", async () => {
  // The failure paths were covered and the success path was not, which is how
  // a refactor that handed the probe a call result instead of its payload got
  // as far as a published page. This drives the real transport to completion.
  const live = liveConnectors.find((entry) => entry.manifest.id === "github")!;
  const answers: Record<string, unknown> = {
    get_me: {
      login: "example-user",
      details: { name: "Example User", public_repos: 2, followers: 1 },
    },
    search_repositories: { items: [{ full_name: "example-user/thing" }] },
  };
  let proof: unknown;
  const transport = createConnectorTransport(
    live,
    async (tool) => answers[tool],
    (value) => {
      proof = value;
    },
  );
  const started = await transport.start(live.manifest.id, "delegated");
  assert.equal(started.step, "intro");
  const done = await transport.act(started.id, {
    action: "begin",
    revision: started.revision,
    values: {},
  });
  assert.equal(done.step, "complete");
  assert.equal(done.outcome?.ownership, "authenticated");
  // The reference is what the provider said this connection belongs to, not
  // an id this page minted.
  assert.equal(done.outcome?.connectionRef, "example-user");
  assert.deepEqual(
    [...(done.outcome?.scopes ?? [])],
    live.access.map((entry) => entry.tool),
  );
  assert.ok(proof, "the evidence panel should have something to show");
});

test("a failure code this page does not know still names itself", async () => {
  // An unhandled code used to print its message and nothing else, so finding
  // out which code it was cost a round trip through whoever hit it.
  const snapshot = await failWith({
    code: "some_future_code",
    message: "connector access isn't confirmed",
    server: "github",
  });
  assert.match(snapshot.message ?? "", /some_future_code/);
});
