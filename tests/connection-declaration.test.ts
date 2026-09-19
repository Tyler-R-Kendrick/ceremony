import assert from "node:assert/strict";
import test from "node:test";
import {
  declarationOf,
  heldConfigurationOf,
  requiredScopesOf,
} from "../examples/web/declaration.js";
import { emptyDraft } from "../examples/web/add-connection.js";
import {
  capabilityDetails,
  catalog,
  customEntries,
  isHostSwitchable,
  type Capability,
} from "../examples/web/catalog.js";
import {
  entryContextSchema,
  explainCeremonySelection,
  manifestSchema,
  type ConnectorManifest,
} from "../src/core/index.js";

const oauthCard = customEntries.find((entry) => entry.id === "custom-oauth")!;
const draftWith = (values: Record<string, string>) => ({
  ...emptyDraft(oauthCard),
  values,
});

test("an environment name reaches the resolver as held configuration", () => {
  assert.deepEqual(
    heldConfigurationOf(draftWith({ clientIdName: "EXAMPLE_CLIENT_ID" })),
    ["EXAMPLE_CLIENT_ID"],
  );
  // Every family's name field lands in the same place, so a route is ranked
  // on what is held rather than on which form collected it.
  assert.deepEqual(
    heldConfigurationOf(
      draftWith({
        keyName: "SERVICE_KEY",
        appIdName: "APP_ID",
        appKeyName: "APP_PRIVATE_KEY",
      }),
    ),
    ["SERVICE_KEY", "APP_ID", "APP_PRIVATE_KEY"],
  );
});

test("a name that cannot be an environment entry is dropped, not thrown", () => {
  // The client parses its context while the drawer is rendering, so an
  // unparseable name has to stop here rather than from inside a render.
  for (const name of ["lowercase", "1LEADING", "HAS-HYPHEN", "", "  "])
    assert.deepEqual(
      heldConfigurationOf(draftWith({ clientIdName: name })),
      [],
    );
  assert.deepEqual(
    heldConfigurationOf(draftWith({ clientIdName: `A${"B".repeat(96)}` })),
    [],
  );
});

test("held names are deduplicated and bounded", () => {
  assert.deepEqual(
    heldConfigurationOf(draftWith({ clientIdName: "SAME", keyName: "SAME" })),
    ["SAME"],
  );
});

test("scopes are separated by whitespace or commas, and deduplicated", () => {
  assert.deepEqual(requiredScopesOf(draftWith({ scopes: "read:user repo" })), [
    "read:user",
    "repo",
  ]);
  assert.deepEqual(
    requiredScopesOf(draftWith({ scopes: "read:user, repo ,read:user" })),
    ["read:user", "repo"],
  );
  assert.deepEqual(requiredScopesOf(draftWith({ scopes: "   " })), []);
  assert.deepEqual(
    requiredScopesOf(draftWith({ scopes: "ok " + "x".repeat(101) })),
    ["ok"],
  );
});

test("the declaration is what the resolver accepts", () => {
  const declaration = declarationOf(
    draftWith({ clientIdName: "EXAMPLE_CLIENT_ID", scopes: "read:user" }),
  );
  assert.doesNotThrow(() => entryContextSchema.parse(declaration));
  assert.equal(declaration.identity, "either");
  assert.equal(declaration.interruptions, "any");
});

/**
 * Two routes of the same kind, so nothing but the declaration separates them.
 * Built through the real manifest schema: a route these tests prove reachable
 * is one the product can actually produce.
 */
const build = (
  methods: { id: string; scopes: string[]; needs?: string[] }[],
): ConnectorManifest =>
  manifestSchema.parse({
    id: "declaration-fixture",
    name: "Declaration fixture",
    description: "Routes that differ only in what the drawer declared.",
    methods: methods.map((method) => ({
      id: method.id,
      label: `Method ${method.id}`,
      kind: "api-key",
      templateId: "api-key",
      scopes: method.scopes,
      fields: [
        { name: "token", label: "Token", type: "password", required: true },
      ],
      contract: {
        profile: "test-profile",
        surfaces: ["browser", "headless"],
        configuration: (method.needs ?? []).map((name) => ({
          name,
          source: "host",
          classification: "public",
          required: true,
        })),
        configurationGroups: [],
        prerequisites: [],
        handoff: {
          surface: "private-collector",
          recipient: "initiating-subject",
          delegation: "a2h-authorize",
          resume: "verify",
        },
        completion: {
          verifier: "test.verifier",
          ownership: ["authenticated"],
        },
        workflows: [],
      },
    })),
  });

const scoped = build([
  { id: "narrow", scopes: ["read:user"] },
  { id: "wide", scopes: ["read:user", "repo"] },
]);

test("declaring a scope the first route cannot carry moves the selection", () => {
  assert.equal(
    explainCeremonySelection(scoped, declarationOf(draftWith({})))
      .selectedMethodId,
    "narrow",
  );
  const withScopes = explainCeremonySelection(
    scoped,
    declarationOf(draftWith({ scopes: "read:user repo" })),
  );
  assert.equal(withScopes.selectedMethodId, "wide");
  assert.equal(
    withScopes.candidates.find((item) => item.methodId === "narrow")?.reason,
    "insufficient-scopes",
  );
});

test("a scope no route carries leaves the selection empty and says why", () => {
  const selection = explainCeremonySelection(
    scoped,
    declarationOf(draftWith({ scopes: "admin:org" })),
  );
  assert.equal(selection.selectedMethodId, null);
  assert.deepEqual(
    selection.candidates.map((item) => item.reason),
    ["insufficient-scopes", "insufficient-scopes"],
  );
});

const asking = build([
  { id: "asks", scopes: ["read:user"], needs: ["EXAMPLE_CLIENT_ID"] },
  { id: "ready", scopes: ["read:user"] },
]);

test("naming what the host holds promotes the route that would have to ask", () => {
  // `asks` is declared first, so index alone would pick it. It loses anyway
  // while it has to stop for configuration nothing says is held.
  assert.equal(
    explainCeremonySelection(asking, declarationOf(draftWith({})))
      .selectedMethodId,
    "ready",
  );
  // Naming the entry settles that tiebreak, and declaration order decides
  // again — which is the point: what the host holds changed the route.
  assert.equal(
    explainCeremonySelection(
      asking,
      declarationOf(draftWith({ clientIdName: "EXAMPLE_CLIENT_ID" })),
    ).selectedMethodId,
    "asks",
  );
  // A name for something no route wants changes nothing, rather than being
  // mistaken for a route that is ready.
  assert.equal(
    explainCeremonySelection(
      asking,
      declarationOf(draftWith({ clientIdName: "UNRELATED" })),
    ).selectedMethodId,
    "ready",
  );
  // Both routes stay eligible either way: holding configuration ranks a
  // route, it never gates one.
  for (const values of [{}, { clientIdName: "EXAMPLE_CLIENT_ID" }])
    assert.deepEqual(
      explainCeremonySelection(
        asking,
        declarationOf(draftWith(values)),
      ).candidates.map((item) => item.reason),
      ["eligible", "eligible"],
    );
});

test("a capability is a switch or a description, never both", () => {
  // Every capability names an owner, so nothing falls through the split into
  // neither the toggle list nor the read-out.
  for (const capability of Object.keys(capabilityDetails) as Capability[])
    assert.ok(
      ["host", "connector"].includes(capabilityDetails[capability].control),
    );
  // Only a host switch carries the sentence that explains turning it off, and
  // only a host switch says where it starts.
  for (const [capability, detail] of Object.entries(capabilityDetails))
    assert.equal(
      "offNote" in detail && "defaultOn" in detail,
      isHostSwitchable(capability as Capability),
      capability,
    );
});

test("a fresh draft only holds capabilities somebody here can change", () => {
  for (const entry of catalog) {
    const draft = emptyDraft(entry);
    for (const capability of draft.capabilities) {
      assert.ok(isHostSwitchable(capability), `${entry.id}: ${capability}`);
      // A draft cannot switch on something its connector never offered.
      assert.ok(entry.capabilities.includes(capability), entry.id);
    }
  }
});

test("a fresh draft starts where the application already started", () => {
  const github = catalog.find((entry) => entry.id === "github")!;
  // Teaching wherever it is offered, WebMCP because the component exposes a
  // connection unless a host says otherwise, and agent assistance off.
  assert.deepEqual(emptyDraft(github).capabilities.toSorted(), [
    "teaching",
    "webmcp",
  ]);
  // A card's own default adds to those rather than replacing them: choosing
  // to record a sign-in is not a reason to stop exposing the connection.
  const record = customEntries.find((entry) => entry.id === "custom-record")!;
  assert.deepEqual(record.defaultCapabilities, ["teaching"]);
  assert.ok(emptyDraft(record).capabilities.includes("webmcp"));
});
