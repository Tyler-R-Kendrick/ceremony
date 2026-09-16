import assert from "node:assert/strict";
import test from "node:test";
import { manifestSchema, type ConnectorManifest } from "../src/core/index.js";
import {
  entryContextSchema,
  explainCeremonySelection,
  humanHandoffs,
  resolveConnection,
  routeFor,
  startsWithoutAPerson,
} from "../src/core/resolution.js";

/**
 * What a host declares, and what the resolver does with it.
 *
 * Every fixture goes through the real manifest schema, so a route these tests
 * prove reachable is one the product can actually produce.
 */

const handoff = (surface: "provider-browser" | "private-collector") => ({
  surface,
  recipient: "initiating-subject" as const,
  delegation: "a2h-authorize" as const,
  resume: "verify" as const,
});

const credentialKinds = ["basic", "api-key", "form"];

function fieldsFor(kind: string) {
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
  return [{ name: "email", label: "Email", type: "email", required: true }];
}

interface Spec {
  id: string;
  kind: string;
  scopes?: string[];
  prerequisites?: number;
  anonymous?: boolean;
  surfaces?: ("browser" | "headless")[];
  /** Host-sourced configuration the route requires before it can run. */
  needs?: string[];
  contract?: false;
}

function build(methods: Spec[]): ConnectorManifest {
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
        fields: fieldsFor(method.kind),
        ...(method.contract === false
          ? {}
          : {
              contract: {
                profile: "test-profile",
                surfaces: method.surfaces ?? ["browser", "headless"],
                configuration: (method.needs ?? []).map((name) => ({
                  name,
                  source: "host" as const,
                  classification: "public" as const,
                  required: true,
                })),
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

test("an unstated intent narrows nothing", () => {
  assert.deepEqual(entryContextSchema.parse({}), {
    surface: "browser",
    requiredScopes: [],
    permissions: [],
    identity: "either",
    interruptions: "any",
    heldConfiguration: [],
  });
});

test("a permission filters by the scopes it costs, not by its wording", () => {
  const manifest = build([
    { id: "narrow", kind: "oauth-code", scopes: ["read:user"] },
    { id: "broad", kind: "device", scopes: ["read:user", "repo"] },
  ]);
  // The label is for the person. Only the scopes decide what survives.
  const resolved = resolveConnection(manifest, {
    permissions: [{ label: "Open pull requests for you", scopes: ["repo"] }],
  });
  assert.equal(resolved.method.id, "broad");
  assert.deepEqual(resolved.permissions, ["Open pull requests for you"]);
  assert.deepEqual(
    resolved.rejected.map((item) => [item.methodId, item.reason]),
    [["narrow", "insufficient-scopes"]],
  );
});

test("a permission carrying no scopes describes without narrowing", () => {
  const manifest = build([{ id: "only", kind: "oauth-code" }]);
  const resolved = resolveConnection(manifest, {
    permissions: [{ label: "See your profile" }],
  });
  assert.equal(resolved.method.id, "only");
  assert.deepEqual(resolved.permissions, ["See your profile"]);
});

test("permissions and requiredScopes are both honoured, not one or the other", () => {
  const manifest = build([
    { id: "a", kind: "oauth-code", scopes: ["repo"] },
    { id: "b", kind: "oauth-code", scopes: ["repo", "admin"] },
  ]);
  const selection = explainCeremonySelection(manifest, {
    requiredScopes: ["admin"],
    permissions: [{ label: "Open pull requests", scopes: ["repo"] }],
  });
  assert.equal(selection.selectedMethodId, "b");
});

test("identity decides whose access this is, and says so when nothing matches", () => {
  const manifest = build([
    { id: "named", kind: "oauth-code" },
    { id: "nobody", kind: "authmd-anonymous", anonymous: true },
  ]);
  assert.equal(
    resolveConnection(manifest, { identity: "personal" }).method.id,
    "named",
  );
  assert.equal(
    resolveConnection(manifest, { identity: "anonymous" }).method.id,
    "nobody",
  );
  const onlyAnonymous = build([
    { id: "nobody", kind: "authmd-anonymous", anonymous: true },
  ]);
  assert.throws(
    () => resolveConnection(onlyAnonymous, { identity: "personal" }),
    /No available/,
  );
  assert.equal(
    explainCeremonySelection(onlyAnonymous, { identity: "personal" })
      .candidates[0]!.reason,
    "wrong-identity",
  );
});

test("an attention budget rules out routes that would exceed it", () => {
  const manifest = build([
    { id: "staged", kind: "oauth-code", prerequisites: 2 },
    { id: "direct", kind: "device" },
  ]);
  // Three stops against a budget of one leaves the single-stop route.
  assert.equal(
    resolveConnection(manifest, { interruptions: "at-most-one" }).method.id,
    "direct",
  );
  const staged = build([
    { id: "staged", kind: "oauth-code", prerequisites: 2 },
  ]);
  assert.equal(
    explainCeremonySelection(staged, { interruptions: "at-most-one" })
      .candidates[0]!.reason,
    "too-many-interruptions",
  );
  // "none" is satisfiable, but only by a route that interrupts nobody.
  const anonymous = build([
    { id: "staged", kind: "oauth-code", prerequisites: 2 },
    { id: "nobody", kind: "authmd-anonymous", anonymous: true },
  ]);
  assert.equal(
    resolveConnection(anonymous, { interruptions: "none" }).method.id,
    "nobody",
  );
});

test("cost breaks a tie; it does not overturn the surface policy", () => {
  // Between two routes the policy ranks equally, the one that stops a person
  // fewer times wins, whichever order the manifest lists them in.
  for (const methods of [
    [
      { id: "staged", kind: "oauth-code", prerequisites: 2 },
      { id: "direct", kind: "oauth-code" },
    ],
    [
      { id: "direct", kind: "oauth-code" },
      { id: "staged", kind: "oauth-code", prerequisites: 2 },
    ],
  ] satisfies Spec[][])
    assert.equal(resolveConnection(build(methods)).method.id, "direct");
  // Across kinds the browser policy still decides: a GitHub App install stops
  // more often than a device code and is still the better access to hold. A
  // host that would rather be cheap says so, and then it is granted.
  const across = build([
    { id: "app", kind: "github-app", prerequisites: 2 },
    { id: "device", kind: "device" },
  ]);
  assert.equal(resolveConnection(across).method.id, "app");
  assert.equal(
    resolveConnection(across, { interruptions: "at-most-one" }).method.id,
    "device",
  );
});

test("app keys the host holds make a route preferable, never eligible", () => {
  const manifest = build([
    { id: "needs-keys", kind: "oauth-code", needs: ["CLIENT_SECRET"] },
    { id: "ready", kind: "oauth-code" },
  ]);
  // Both stay eligible — collecting configuration is something a ceremony does
  // — but the route that will not have to stop and ask for it comes first.
  assert.equal(resolveConnection(manifest).method.id, "ready");
  assert.deepEqual(resolveConnection(manifest).rejected, []);
  // With the keys in hand the tie is level again, so manifest order decides.
  const held = resolveConnection(manifest, {
    heldConfiguration: ["CLIENT_SECRET"],
  });
  assert.equal(held.method.id, "needs-keys");
  assert.deepEqual(held.missingConfiguration, []);
  // What a route still needs is reported, not discovered halfway through it.
  assert.deepEqual(
    resolveConnection(
      build([
        { id: "needs-keys", kind: "oauth-code", needs: ["CLIENT_SECRET"] },
      ]),
    ).missingConfiguration,
    ["CLIENT_SECRET"],
  );
});

test("a route is named by what happens to a person, not by its protocol", () => {
  const manifest = build([
    { id: "oauth", kind: "oauth-code" },
    { id: "app", kind: "github-app" },
    { id: "device", kind: "device" },
    { id: "key", kind: "api-key" },
    { id: "anon", kind: "authmd-anonymous", anonymous: true },
  ]);
  const routes = Object.fromEntries(
    manifest.methods.map((method) => [method.id, routeFor(method)]),
  );
  assert.deepEqual(routes, {
    oauth: "provider-approval",
    app: "provider-approval",
    device: "second-device",
    key: "supplied-credential",
    anon: "no-account",
  });
  // A manifest with no contract still resolves to a route rather than nothing.
  const bare = build([
    { id: "key", kind: "api-key", contract: false },
    { id: "anon", kind: "authmd-anonymous", contract: false },
    { id: "oauth", kind: "oauth-code", contract: false },
    { id: "device", kind: "device", contract: false },
  ]);
  assert.deepEqual(
    bare.methods.map((method) => routeFor(method)),
    ["supplied-credential", "no-account", "provider-approval", "second-device"],
  );
});

test("a summary says what is about to happen and names no mechanism", () => {
  const of = (spec: Spec) =>
    resolveConnection(build([spec])).summary.toLowerCase();
  assert.match(of({ id: "a", kind: "oauth-code" }), /approve this once/);
  assert.match(of({ id: "b", kind: "device" }), /another device/);
  assert.match(of({ id: "c", kind: "api-key" }), /credential you already hold/);
  assert.match(
    of({ id: "d", kind: "authmd-anonymous", anonymous: true }),
    /no fixture co account is needed/,
  );
  for (const spec of [
    { id: "a", kind: "oauth-code" },
    { id: "b", kind: "device" },
    { id: "c", kind: "api-key" },
  ] satisfies Spec[])
    for (const word of ["pkce", "oauth", "api key", "token", "device code"])
      assert.doesNotMatch(of(spec), new RegExp(word));
});

test("an anonymous route interrupts nobody and a staged one counts every stop", () => {
  const manifest = build([
    { id: "anon", kind: "authmd-anonymous", anonymous: true },
    { id: "staged", kind: "oauth-code", prerequisites: 2 },
    { id: "bare", kind: "device", contract: false },
  ]);
  const [anon, staged, bare] = manifest.methods;
  assert.equal(humanHandoffs(anon!), 0);
  assert.equal(startsWithoutAPerson(anon!), true);
  assert.equal(humanHandoffs(staged!), 3);
  // No contract to read: one stop is the floor, never zero.
  assert.equal(humanHandoffs(bare!), 1);
});

test("an unsupported surface is still reported per method", () => {
  const manifest = build([
    { id: "browser-only", kind: "oauth-code", surfaces: ["browser"] },
    { id: "anywhere", kind: "device" },
  ]);
  const selection = explainCeremonySelection(manifest, {
    surface: "headless",
  });
  assert.equal(selection.selectedMethodId, "anywhere");
  assert.deepEqual(
    selection.candidates.map((item) => item.reason),
    ["unsupported-surface", "eligible"],
  );
});

test("a permission's scopes reach the server, not only the client", async () => {
  const { CeremonyController } = await import("../src/server/controller.js");
  const manifest = build([
    { id: "narrow", kind: "oauth-code", scopes: ["read"] },
    { id: "broad", kind: "oauth-code", scopes: ["read", "repo"] },
  ]);
  const controller = new CeremonyController([
    {
      manifest,
      createAdapter: () => ({
        async begin() {
          return { step: "redirect" as const };
        },
        async submit() {
          return { step: "complete" as const };
        },
        async callback() {
          return { step: "complete" as const };
        },
        async poll() {
          return undefined;
        },
        cancel() {},
      }),
    },
  ]);
  // The controller pre-filters before it resolves. If it filtered on
  // requiredScopes alone it would discard the only method that can satisfy the
  // declared permission, and then fail to find one.
  const snapshot = controller.connect("owner", "fixture-co", {
    permissions: [{ label: "Open pull requests", scopes: ["repo"] }],
  });
  assert.equal(snapshot.method.id, "broad");
  assert.throws(
    () =>
      controller.connect("owner", "fixture-co", {
        permissions: [{ label: "Administer", scopes: ["admin"] }],
      }),
    /No available authentication method/,
  );
});

test("what a view describes does not depend on there being a window", async () => {
  const { createCeremonyClient } = await import("../src/core/index.js");
  const manifest = build([
    // The browser policy prefers oauth-code; the headless policy prefers device.
    // A declaration that names no surface must not resolve differently on a
    // server than in the browser that hydrates it.
    { id: "oauth", kind: "oauth-code" },
    { id: "device", kind: "device" },
  ]);
  assert.equal(typeof globalThis.window, "undefined");
  // Never reached: initialize() is not called, so nothing is transported.
  const refuse = async () => {
    throw new Error("this client is never started");
  };
  const transport = { start: refuse, read: refuse, act: refuse };
  const client = createCeremonyClient({ manifest, transport });
  // The declaration a view describes carries the schema's surface, not the
  // environment's, so it is the same value wherever it is rendered.
  assert.equal(client.intent.surface, "browser");
  assert.equal(resolveConnection(manifest, client.intent).method.id, "oauth");
  // A host that really is headless still says so, and still gets the device
  // route — the environment is a default, never an override.
  const declared = createCeremonyClient({
    manifest,
    transport,
    context: { surface: "headless" },
  });
  assert.equal(declared.intent.surface, "headless");
  assert.equal(
    resolveConnection(manifest, declared.intent).method.id,
    "device",
  );
});
