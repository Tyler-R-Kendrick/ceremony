import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import fc from "fast-check";
import {
  manifestSchema,
  connectorManifestV1Schema,
  parseConnectorManifest,
  methodContractSchema,
  humanHandoffContractSchema,
  inspectConfiguration,
  explainCeremonySelection,
  resolveCeremonyMethod,
  toolState,
} from "../src/core/index.js";
import { manifests } from "../examples/manifests.js";
import { githubAppManifest, githubWorkflows } from "../src/server/github.js";
import { serviceManifests, serviceWorkflows } from "../src/server/services.js";
import { validateConnectorWorkflows } from "../src/server/arazzo.js";
import {
  specificationSchemas,
  specificationDocument,
} from "../scripts/specifications.js";
import {
  CeremonyController,
  type AuthAdapter,
} from "../src/server/controller.js";

const github = githubAppManifest.methods[0]!.contract!;
const supabase = serviceManifests[1]!.methods[0]!.contract!;

test("SPEC-01: all shipped connector inventories satisfy the formal versioned profile", () => {
  for (const manifest of [
    ...manifests,
    githubAppManifest,
    ...serviceManifests,
  ]) {
    assert.deepEqual(connectorManifestV1Schema.parse(manifest), manifest);
    assert.deepEqual(
      parseConnectorManifest(JSON.stringify(manifest)),
      manifest,
    );
  }
  assert.ok(manifests.every((manifest) => manifest.support === "fixture"));
  assert.ok(
    serviceManifests.every((manifest) => manifest.support === "live-adapter"),
  );
  assert.equal(githubAppManifest.support, "live-adapter");
  assert.deepEqual(
    github.prerequisites.map((item) => item.id),
    ["prepare-app", "authorize-installation"],
  );
  assert.deepEqual(github.completion.ownership, ["authenticated"]);
  assert.deepEqual(manifests[4]!.methods[0]!.contract!.completion.ownership, [
    "anonymous",
    "claimed",
  ]);
});

test("SPEC-02: legacy manifests remain readable but cannot claim formal conformance", () => {
  const legacy = {
    id: "legacy",
    name: "Legacy",
    description: "",
    methods: [
      {
        id: "key",
        kind: "api-key",
        label: "Key",
        templateId: "api-key",
        scopes: [],
        fields: [
          { name: "token", label: "Token", type: "password", required: true },
        ],
      },
    ],
  };
  assert.ok(manifestSchema.safeParse(legacy).success);
  assert.equal(connectorManifestV1Schema.safeParse(legacy).success, false);
  assert.equal(
    manifestSchema.safeParse({ ...legacy, schemaVersion: 1 }).success,
    false,
  );
  for (const change of [
    { support: undefined },
    { schemaVersion: 2 },
    { certified: true },
  ])
    assert.equal(
      manifestSchema.safeParse({ ...githubAppManifest, ...change }).success,
      false,
    );
  const unclassified = structuredClone(serviceManifests[0]!);
  delete unclassified.methods[0]!.fields[0]!.classification;
  assert.equal(manifestSchema.safeParse(unclassified).success, false);
});

test("SPEC-03: protected material, endpoints and invented authority cannot enter handoff definitions", () => {
  for (const extra of [
    { secretRef: "private-ref" },
    { recipientAddress: "person@example.invalid" },
    { url: "https://example.invalid/control" },
    { _meta: { approved: true } },
    { resume: "complete" },
    { delegation: "session-approval" },
  ])
    assert.equal(
      humanHandoffContractSchema.safeParse({ ...github.handoff, ...extra })
        .success,
      false,
    );
  for (const extra of [
    { handler: "eval()" },
    { endpoint: "https://example.invalid" },
    { approved: true },
  ])
    assert.equal(
      methodContractSchema.safeParse({ ...github, ...extra }).success,
      false,
    );
  const invalid = structuredClone(serviceManifests[0]!);
  invalid.methods[0]!.contract!.handoff.surface = "provider-browser";
  assert.equal(manifestSchema.safeParse(invalid).success, false);
  invalid.methods[0]!.contract!.handoff.surface = "private-collector";
  invalid.methods[0]!.contract!.completion.ownership = ["claimed"];
  assert.equal(manifestSchema.safeParse(invalid).success, false);
});

test("SPEC-04: configuration groups preserve alternatives and do not carry values", () => {
  assert.equal(inspectConfiguration(github, new Set()).ready, true);
  const partial = inspectConfiguration(github, new Set(["GITHUB_APP_ID"]));
  assert.equal(partial.ready, false);
  assert.deepEqual(partial.unsatisfiedGroups, [
    {
      id: "existing-app",
      rule: "all-or-none",
      missing: [
        "GITHUB_APP_SLUG",
        "GITHUB_APP_OWNER",
        "GITHUB_APP_PRIVATE_KEY",
      ],
    },
  ]);
  assert.equal(
    inspectConfiguration(
      github,
      new Set(github.configuration.map((item) => item.name)),
    ).ready,
    true,
  );
  const absent = inspectConfiguration(supabase, new Set());
  assert.deepEqual(absent.missingRequired, ["SUPABASE_URL"]);
  assert.equal(absent.unsatisfiedGroups[0]!.rule, "at-least-one");
  for (const key of ["SUPABASE_PUBLISHABLE_KEY", "SUPABASE_ANON_KEY"])
    assert.equal(
      inspectConfiguration(supabase, new Set(["SUPABASE_URL", key])).ready,
      true,
    );
  assert.equal(
    inspectConfiguration(supabase, new Set(["SUPABASE_URL"])).ready,
    false,
  );
});

test("SPEC-05: duplicate, foreign and oversized requirements fail closed", () => {
  for (const change of [
    { surfaces: [] },
    { surfaces: ["browser", "browser"] },
    { configuration: [github.configuration[0], github.configuration[0]] },
    { prerequisites: [github.prerequisites[0], github.prerequisites[0]] },
    { workflows: [github.workflows[0], github.workflows[0]] },
    {
      completion: {
        ...github.completion,
        ownership: ["authenticated", "authenticated"],
      },
    },
    {
      configurationGroups: [
        github.configurationGroups[0],
        github.configurationGroups[0],
      ],
    },
    {
      configurationGroups: [
        { id: "bad", rule: "all-or-none", names: ["UNKNOWN", "GITHUB_APP_ID"] },
      ],
    },
    {
      configurationGroups: [
        {
          id: "bad",
          rule: "all-or-none",
          names: ["GITHUB_APP_ID", "GITHUB_APP_ID"],
        },
      ],
    },
    { configuration: [{ ...github.configuration[0], value: "forbidden" }] },
    { profile: "constructor" },
  ])
    assert.equal(
      methodContractSchema.safeParse({ ...github, ...change }).success,
      false,
    );
  const configuration = Array.from({ length: 24 }, (_, i) => ({
    name: `CONFIG_${i}`,
    source: "host",
    classification: "secret",
    required: false,
  }));
  assert.ok(
    methodContractSchema.safeParse({
      ...github,
      configuration,
      configurationGroups: [],
    }).success,
  );
  assert.equal(
    methodContractSchema.safeParse({
      ...github,
      configuration: [
        ...configuration,
        { ...configuration[0], name: "EXCESS" },
      ],
      configurationGroups: [],
    }).success,
    false,
  );
  const json = JSON.stringify(githubAppManifest);
  const exact = json + " ".repeat(256 * 1024 - Buffer.byteLength(json));
  assert.equal(parseConnectorManifest(exact).id, "github");
  assert.throws(() => parseConnectorManifest(exact + " "), /import limit/);
  assert.throws(() => parseConnectorManifest("{"));
  assert.throws(
    () =>
      parseConnectorManifest(
        JSON.stringify({
          ...githubAppManifest,
          description: "é".repeat(131072),
        }),
      ),
    /import limit/,
  );
});

test("SPEC-06: selection explains exclusions without configuration values or human authority", () => {
  const manifest = structuredClone(manifests[0]!);
  manifest.methods[0]!.contract!.surfaces = ["browser"];
  const decision = explainCeremonySelection(manifest, { surface: "headless" });
  assert.equal(decision.selectedMethodId, "device");
  assert.equal(decision.candidates[0]!.reason, "unsupported-surface");
  assert.equal(
    explainCeremonySelection(manifest, { requiredScopes: ["admin"] })
      .selectedMethodId,
    null,
  );
  assert.equal(
    explainCeremonySelection(manifest, {}, () => "unavailable").candidates[0]!
      .reason,
    "unavailable",
  );
  assert.equal(
    explainCeremonySelection(manifest, {}, () => "configured").selectedMethodId,
    "oauth",
  );
  assert.throws(() =>
    explainCeremonySelection(manifest, {}, () => "invented" as "available"),
  );
  assert.deepEqual(Object.keys(decision.candidates[0]!), [
    "methodId",
    "availability",
    "reason",
  ]);
  const byIdentity = new Map(
    manifest.methods.map((method) => [method, "available" as const]),
  );
  assert.equal(
    resolveCeremonyMethod(manifest, {}, (method) => byIdentity.get(method)!).id,
    "oauth",
  );
});

test("SPEC-07: selection invariants hold across trusted availability, scope and surface permutations", () => {
  fc.assert(
    fc.property(
      fc.constantFrom("browser" as const, "headless" as const),
      fc.array(
        fc.constantFrom(
          "available" as const,
          "configured" as const,
          "unavailable" as const,
        ),
        { minLength: 3, maxLength: 3 },
      ),
      fc.boolean(),
      (surface, states, scoped) => {
        const manifest = manifests[0]!;
        const context = {
          surface,
          requiredScopes: scoped ? ["read:user"] : [],
        };
        const availability = (method: { id: string }) =>
          states[manifest.methods.findIndex((item) => item.id === method.id)]!;
        const decision = explainCeremonySelection(
          manifest,
          context,
          availability,
        );
        if (decision.selectedMethodId === null) {
          assert.ok(
            decision.candidates.every((item) => item.reason !== "eligible"),
          );
          assert.throws(() =>
            resolveCeremonyMethod(manifest, context, availability),
          );
        } else {
          const method = resolveCeremonyMethod(manifest, context, availability);
          assert.equal(method.id, decision.selectedMethodId);
          assert.notEqual(availability(method), "unavailable");
          assert.ok(
            context.requiredScopes.every((scope) =>
              method.scopes.includes(scope),
            ),
          );
        }
      },
    ),
    { numRuns: 200, seed: 20260909 },
  );
});

test("SPEC-08: server resumption honors the same declared surface constraint", () => {
  const manifest = structuredClone(manifests[0]!);
  manifest.methods[0]!.contract!.surfaces = ["browser"];
  const adapter: AuthAdapter = {
    begin: async () => ({ step: "redirect" }),
    submit: async () => ({ step: "input" }),
    callback: async () => ({ step: "error" }),
    poll: async () => undefined,
    cancel() {},
  };
  const controller = new CeremonyController([
    { manifest, createAdapter: () => adapter },
  ]);
  assert.equal(
    controller.connect("owner", "github", { surface: "browser" }).method.id,
    "oauth",
  );
  assert.equal(
    controller.connect("owner", "github", { surface: "headless" }).method.id,
    "device",
  );
});

test("SPEC-09: connector Arazzo references resolve only against pinned host documents", () => {
  const documents = new Map([
    ["github", githubWorkflows],
    ...Object.entries(serviceWorkflows),
  ]);
  for (const manifest of [githubAppManifest, ...serviceManifests, ...manifests])
    validateConnectorWorkflows(manifest, documents);
  assert.throws(() => validateConnectorWorkflows(githubAppManifest, new Map()));
  for (const change of [{ version: "2.0.0" }, { workflowId: "unregistered" }]) {
    const invalid = structuredClone(githubAppManifest);
    Object.assign(invalid.methods[0]!.contract!.workflows[0]!, change);
    assert.throws(
      () => validateConnectorWorkflows(invalid, documents),
      /incompatible/,
    );
  }
});

test("SPEC-10: checked-in JSON Schemas are generated from the executable contracts", async () => {
  for (const name of Object.keys(
    specificationSchemas,
  ) as (keyof typeof specificationSchemas)[]) {
    const actual = await readFile(
      new URL(
        `../docs/specifications/schemas/${name}.schema.json`,
        import.meta.url,
      ),
      "utf8",
    );
    assert.equal(
      actual,
      await specificationDocument(name),
      `Schema drift: ${name}`,
    );
    const schema = JSON.parse(actual);
    assert.equal(
      schema.$schema,
      "https://json-schema.org/draft/2020-12/schema",
    );
    assert.equal(schema.additionalProperties, false);
  }
});

test("SPEC-11: agent requirements use an allowlist and never expose configuration or private runtime fields", () => {
  const manifest = structuredClone(githubAppManifest);
  const contract = manifest.methods[0]!.contract!;
  Object.assign(contract, {
    secretRef: "forbidden-handle",
    url: "https://example.invalid/private",
  });
  Object.assign(contract.handoff, { address: "private@example.invalid" });
  const requirements = toolState(manifest).methods[0]!.requirements!;
  assert.deepEqual(Object.keys(requirements), [
    "profile",
    "surfaces",
    "prerequisites",
    "humanSurface",
    "humanRecipient",
    "delegation",
    "resume",
  ]);
  assert.deepEqual(requirements.prerequisites, [
    { id: "prepare-app", kind: "provider-registration" },
    { id: "authorize-installation", kind: "provider-consent" },
  ]);
  assert.equal(requirements.resume, "verify");
  const projected = JSON.stringify(requirements);
  for (const forbidden of [
    "forbidden-handle",
    "example.invalid",
    "GITHUB_APP_PRIVATE_KEY",
    "configuration",
    "workflows",
  ])
    assert.equal(projected.includes(forbidden), false);
  delete manifest.methods[0]!.contract;
  assert.equal(toolState(manifest).methods[0]!.requirements, undefined);
});
