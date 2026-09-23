import assert from "node:assert/strict";
import { test } from "node:test";
import {
  ProviderRegistry,
  type ProviderEntry,
} from "../src/server/provider-registry.js";
import { OperationRegistry } from "../src/server/recipes/registry.js";
import { githubConnectionRecipe } from "../src/server/teaching-runtime.js";
import type { ActorContext } from "../src/core/operation-contracts.js";
import type { RunRecord } from "../src/server/commands.js";

const actor: ActorContext = {
  tenantId: "tenant",
  subjectId: "subject",
  sessionId: "session",
  actorKind: "human",
  capabilities: ["executor"],
};

function entry(
  id: string,
  version: string,
  extra: Partial<ProviderEntry> = {},
): ProviderEntry {
  return {
    id,
    vocabulary: new Map(),
    register: () => {},
    connection: {
      definition: githubConnectionRecipe,
      outputContract: `${id}.connection`,
      revalidateOperation: `${id}.verify-access`,
    },
    configurationVersion: async () => version,
    context: async () => ({
      provider: id,
      profile: `${id}-profile`,
      target: "self",
      origin: "https://app.example",
      environment: "test",
      configurationVersion: version,
    }),
    ...extra,
  };
}

function run(fields: Partial<RunRecord>): RunRecord {
  return {
    id: "run",
    subjectId: "subject",
    sessionId: "session",
    status: "active",
    provider: "stripe",
    profile: "stripe-api-key",
    target: "self",
    origin: "https://app.example",
    environment: "test",
    configurationVersion: "v1",
    ...fields,
  } as RunRecord;
}

test("a duplicate provider id is a composition error, never a replacement", () => {
  assert.throws(
    () => new ProviderRegistry([entry("stripe", "v1"), entry("stripe", "v2")]),
    /Duplicate provider stripe/,
  );
});

test("a run is authorized only against its own provider's current configuration", async () => {
  const providers = new ProviderRegistry([entry("stripe", "v1")]);
  assert.equal(await providers.authorizes(actor, run({}), "op", "base"), true);
  // Rotation fences the run, but a continuation only resumes and still may.
  const rotated = run({ configurationVersion: "v0" });
  assert.equal(await providers.authorizes(actor, rotated, "op", "base"), false);
  assert.equal(
    await providers.authorizes(actor, rotated, "continuation", "base"),
    true,
  );
  // A provider nobody registered has no configuration to match: fail closed,
  // including a built-in name a host chose not to configure.
  for (const provider of ["supabase", "unregistered"])
    assert.equal(
      await providers.authorizes(actor, run({ provider }), "op", "base"),
      false,
    );
  // Authored runs have no entry and match the host's authored version.
  const authored = run({ provider: "acme", profile: "authored" });
  assert.equal(
    await providers.authorizes(
      actor,
      { ...authored, configurationVersion: "base" },
      "op",
      "base",
    ),
    true,
  );
  assert.equal(
    await providers.authorizes(actor, authored, "op", "base"),
    false,
  );
});

test("provider admission runs before the version check and never for a continuation", async () => {
  let admitted = false;
  const providers = new ProviderRegistry([
    entry("jira", "v1", { admits: async () => admitted }),
  ]);
  const record = run({ provider: "jira" });
  assert.equal(await providers.authorizes(actor, record, "op", "base"), false);
  assert.equal(
    await providers.authorizes(actor, record, "continuation", "base"),
    true,
  );
  admitted = true;
  assert.equal(await providers.authorizes(actor, record, "op", "base"), true);
});

test("the registry supplies vocabulary, registration, connections and context", async () => {
  const registered: string[] = [];
  const providers = new ProviderRegistry([
    entry("github", "v1", {
      yieldsToAuthored: true,
      register: () => registered.push("github"),
    }),
    entry("jira", "v2", { register: () => registered.push("jira") }),
  ]);
  providers.register(new OperationRegistry());
  assert.deepEqual(registered, ["github", "jira"]);
  assert.deepEqual([...providers.connections().keys()], ["github", "jira"]);
  assert.deepEqual(providers.ids(), ["github", "jira"]);
  assert.equal(
    (await providers.context(actor, "jira", false))?.configurationVersion,
    "v2",
  );
  // An installed authored connector of the same name wins only where the
  // entry yields to it, which is the historical order.
  assert.equal(await providers.context(actor, "github", true), undefined);
  assert.equal(
    (await providers.context(actor, "jira", true))?.provider,
    "jira",
  );
  assert.equal(await providers.context(actor, "unknown", false), undefined);
});
