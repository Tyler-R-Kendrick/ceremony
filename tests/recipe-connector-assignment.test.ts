import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { test, type TestContext } from "node:test";
import { z } from "zod";
import { createTeachingRuntime } from "../src/server/teaching-runtime.js";
import {
  OperationRegistry,
  type OperationContext,
  type VocabularyEntry,
} from "../src/server/recipes/registry.js";
import { assignConnectors } from "../src/server/recipes/connector-assignment.js";
import {
  commonVocabulary,
  mintOAuthClient,
  readOAuthClient,
} from "../src/server/recipes/common.js";
import { SQLiteCeremonyStore } from "../src/server/persistence/index.js";
import { AuthorizationError } from "../src/server/identity.js";
import { createCeremonyMcpHandler } from "../src/server/mcp.js";
import { compileDemonstrationDraft } from "../src/server/teaching-operations.js";
import type { ActorContext } from "../src/core/operation-contracts.js";
import type {
  RecipeDefinition,
  RecipeInvocation,
} from "../src/core/recipe-contracts.js";
import type { RunContext, RunRecord } from "../src/server/commands.js";

/*
 * Automatic connector assignment: a draft whose steps belong to more than one
 * provider has each node placed under the one approved connector for its
 * provider, when there is exactly one. Several is a choice left to a person;
 * a provider-neutral step takes the connector of the steps it exchanges
 * artifacts with; only `crossProvider` vocabulary may cross between
 * connectors. Providers are local fixtures and every credential is synthetic.
 */

const actor: ActorContext = {
  tenantId: "tenant",
  subjectId: "subject",
  sessionId: "session",
  actorKind: "human",
  capabilities: ["executor", "author", "reviewer", "publisher"],
};
const CLIENT_ID = "synthetic-client-id-7310";
const CLIENT_SECRET = "synthetic-client-secret-c0de";

const context = (
  provider: string,
  profile: string,
  target: string,
): RunContext => ({
  provider,
  profile,
  target,
  origin: "https://app.example",
  environment: "test",
  configurationVersion: `${target}-v1`,
});
const catalog: Record<string, RunContext> = {
  alpha: context("alpha", "alpha-app", "alpha-org"),
  beta: context("beta", "beta-oauth", "beta-site"),
  // A second approved binding for the same provider and profile.
  "beta-eu": context("beta", "beta-oauth", "beta-eu-site"),
  // A GitHub App connector, and an installed authored connector.
  github: context("github", "github-app", "octo-org"),
  "authored-demo": context("authored-demo", "authored", "authored-demo"),
};

const scoped = (provider: string, profile: string): VocabularyEntry => ({
  schema: z.string().min(1).max(200),
  classification: "public",
  provider,
  profile,
});

function fixture(t: TestContext, connectors: string[] = ["alpha", "beta"]) {
  const store = new SQLiteCeremonyStore(":memory:", {
    current: "key",
    keys: { key: randomBytes(32) },
  });
  t.after(() => store.close());
  const registry = new OperationRegistry(
    new Map<string, VocabularyEntry>([
      ...commonVocabulary,
      ["alpha.note", scoped("alpha", "alpha-app")],
      ["beta.connection", scoped("beta", "beta-oauth")],
      ["beta.grant", scoped("beta", "beta-oauth")],
    ]),
  );
  const seen: Array<{ operation: string; provider?: string; target: string }> =
    [];
  const operation = (
    id: string,
    provider: string,
    profile: string,
    inputs: Record<string, string>,
    outputs: Record<string, string>,
    handler: (
      context: OperationContext,
      inputs: Record<string, unknown>,
    ) => Promise<Record<string, unknown>>,
  ) => ({
    contract: {
      id,
      version: "1.0.0",
      provider,
      profile,
      inputs: Object.fromEntries(
        Object.entries(inputs).map(([name, contract]) => [
          name,
          { contract, required: true },
        ]),
      ),
      outputs: Object.fromEntries(
        Object.entries(outputs).map(([name, contract]) => [
          name,
          { contract, required: true },
        ]),
      ),
      effects: [id],
      verifier: id,
      humanFallback: "none" as const,
    },
    inputSchema: z.record(z.string(), z.unknown()),
    outputSchema: z.record(z.string(), z.unknown()),
    classifications: Object.fromEntries(
      Object.entries(inputs).map(([name, contract]) => [
        name,
        {
          classification: registry.vocabulary.get(contract)!.classification,
          schema: registry.vocabulary.get(contract)!.schema,
        },
      ]),
    ),
    fixtures: ["tests/recipe-connector-assignment.test.ts"],
    handler: async (
      context: OperationContext,
      values: Record<string, unknown>,
    ) => {
      seen.push({
        operation: id,
        ...(context.provider ? { provider: context.provider } : {}),
        target: context.target,
      });
      return {
        state: "complete" as const,
        outputs: await handler(context, values),
      };
    },
    verify: async () => true,
  });
  registry.register(
    operation(
      "alpha.create-client",
      "alpha",
      "alpha-app",
      {},
      { client: "common.oauth-client", note: "alpha.note" },
      async (context) => ({
        client: await mintOAuthClient(store, context, {
          clientId: CLIENT_ID,
          clientSecret: CLIENT_SECRET,
        }),
        note: "created",
      }),
    ),
  );
  registry.register(
    operation(
      "beta.use-client",
      "beta",
      "beta-oauth",
      { client: "common.oauth-client" },
      { connection: "beta.connection" },
      async (context, values) => ({
        connection: (await readOAuthClient(store, context, values.client))
          ? "connected"
          : "missing",
      }),
    ),
  );
  registry.register(
    operation(
      "beta.read-note",
      "beta",
      "beta-oauth",
      { note: "alpha.note" },
      { connection: "beta.connection" },
      async () => ({ connection: "read" }),
    ),
  );
  registry.register(
    operation(
      "beta.issue-grant",
      "beta",
      "beta-oauth",
      {},
      { grant: "beta.grant" },
      async () => ({ grant: "granted" }),
    ),
  );
  registry.register(
    operation(
      "beta.use-grant",
      "beta",
      "beta-oauth",
      { grant: "beta.grant" },
      { connection: "beta.connection" },
      async () => ({ connection: "granted" }),
    ),
  );
  // The closed admission exceptions: a GitHub App context admits authored
  // account registration, and an authored context admits authored steps.
  registry.register(
    operation(
      "authored.register-account",
      "authored",
      "authored",
      {},
      {},
      async () => ({}),
    ),
  );
  registry.register(
    operation(
      "github.install-app",
      "github",
      "github-app",
      {},
      {},
      async () => ({}),
    ),
  );
  // Provider-neutral steps: one only reads a client handle, one passes it on.
  registry.registerNeutral(
    operation(
      "common.check-client",
      "common",
      "common",
      { client: "common.oauth-client" },
      {},
      async () => ({}),
    ),
  );
  registry.registerNeutral(
    operation(
      "common.relay-client",
      "common",
      "common",
      { client: "common.oauth-client" },
      { client: "common.oauth-client" },
      async (_context, values) => ({ client: values.client }),
    ),
  );
  const authorizations: Array<{
    operation: string;
    provider: string;
    connector?: string;
  }> = [];
  const trivial = (id: string): RecipeDefinition => ({
    schemaVersion: 1,
    id: `${id}-connect`,
    title: id,
    description: "",
    inputs: {},
    invocations: [
      {
        id: "only",
        use: { kind: "operation", id: "alpha.create-client", version: "1.0.0" },
        dependsOn: [],
        bindings: {},
      },
    ],
    outputs: {},
  });
  const runtime = createTeachingRuntime({
    store,
    registry,
    identity: { authenticate: async () => actor },
    origin: "https://app.example",
    connections: new Map(
      // "unconfigured" is registered, but the host resolves no context for it.
      [...connectors, "unconfigured"].map((id) => [
        id,
        {
          definition: trivial(id),
          outputContract: `${id}.connection`,
          revalidateOperation: "alpha.create-client",
        },
      ]),
    ),
    context: async (_actor, connectorId) => {
      const resolved = connectors.includes(connectorId)
        ? catalog[connectorId]
        : undefined;
      if (!resolved) throw new AuthorizationError("invalid_request");
      return resolved;
    },
    authorize: async (who, run: RunRecord, operation) => {
      authorizations.push({
        operation,
        provider: run.provider,
        ...(run.scope ? { connector: run.scope.connectorId } : {}),
      });
      return who.subjectId === run.subjectId;
    },
    authoringFetch: async () => new Response("", { status: 404 }),
  });
  async function publish(definition: RecipeDefinition) {
    const draft = await runtime.recipes.createDraft(actor, definition);
    assert.deepEqual(draft.diagnostics, []);
    return publishDraft(draft);
  }
  async function publishDraft(draft: {
    id: string;
    revision: number;
    digest: string;
    definition: RecipeDefinition;
  }) {
    await runtime.recipes.review(actor, draft.id, draft.revision, draft.digest);
    const published = await runtime.recipes.publish(
      actor,
      draft.id,
      draft.revision,
      draft.digest,
    );
    return {
      id: draft.definition.id,
      version: published.version,
      digest: published.digest,
    };
  }
  const single = (
    id: string,
    operationId: string,
    inputs: Record<string, string>,
    outputs: string[],
  ): RecipeDefinition => ({
    schemaVersion: 1,
    id,
    title: id,
    description: "",
    inputs: Object.fromEntries(
      Object.entries(inputs).map(([name, contract]) => [
        name,
        { contract, required: true },
      ]),
    ),
    invocations: [
      {
        id: "step",
        use: { kind: "operation", id: operationId, version: "1.0.0" },
        dependsOn: [],
        bindings: Object.fromEntries(
          Object.keys(inputs).map((name) => [name, { from: "input", name }]),
        ),
      },
    ],
    outputs: Object.fromEntries(
      outputs.map((name) => [name, { node: "step", name }]),
    ),
  });
  const advance = async (runId: string, nodeId: string) => {
    const snapshot = await runtime.commands.snapshot(actor, runId);
    return runtime.commands.advance(
      actor,
      runId,
      nodeId,
      snapshot.revision,
      `command:${randomUUID()}`,
    );
  };
  return {
    store,
    registry,
    runtime,
    seen,
    authorizations,
    publish,
    publishDraft,
    single,
    advance,
  };
}

const operationStep = (
  id: string,
  operationId: string,
  bindings: RecipeInvocation["bindings"] = {},
  extra: Partial<RecipeInvocation> = {},
): RecipeInvocation => ({
  id,
  use: { kind: "operation", id: operationId, version: "1.0.0" },
  dependsOn: [
    ...new Set(
      Object.values(bindings).flatMap((binding) =>
        binding.from === "output" ? [binding.node] : [],
      ),
    ),
  ],
  bindings,
  ...extra,
});
const recipe = (
  id: string,
  invocations: RecipeInvocation[],
): RecipeDefinition => ({
  schemaVersion: 1,
  id,
  title: id,
  description: "",
  inputs: {},
  invocations,
  outputs: {},
});
const client = (node: string) => ({
  client: { from: "output" as const, node, name: "client" },
});

async function mcpFor(runtime: ReturnType<typeof fixture>["runtime"]) {
  const endpoint = "https://app.example/mcp";
  const mcp = createCeremonyMcpHandler(runtime, {
    resourceUrl: endpoint,
    issuer: "https://issuer.example",
    authenticate: () => actor,
  });
  let id = 0;
  const rpc = async (method: string, params: unknown) => {
    const response = await mcp.fetch(
      new Request(endpoint, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
          authorization: "Bearer token",
        },
        body: JSON.stringify({ jsonrpc: "2.0", id: ++id, method, params }),
      }),
    );
    const text = await response!.text();
    const payload = text.trimStart().startsWith("{")
      ? text
      : text
          .split("\n")
          .filter((line) => line.startsWith("data: "))
          .map((line) => line.slice(6))
          .at(-1)!;
    return JSON.parse(payload) as {
      result: { isError?: boolean; content: Array<{ text: string }> };
    };
  };
  await rpc("initialize", {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "test", version: "1" },
  });
  return async (name: string, args: Record<string, unknown>) => {
    const { result } = await rpc("tools/call", { name, arguments: args });
    assert.notEqual(result.isError, true, result.content[0]!.text);
    return {
      text: result.content[0]!.text,
      value: JSON.parse(result.content[0]!.text) as Record<string, any>,
    };
  };
}

test("COMPOSE: recipes of two providers, each with one approved connector, are placed automatically and run end to end", async (t) => {
  const f = fixture(t);
  const alpha = await f.publish(
    f.single("alpha-client", "alpha.create-client", {}, ["client"]),
  );
  const beta = await f.publish(
    f.single(
      "beta-connect",
      "beta.use-client",
      { client: "common.oauth-client" },
      ["connection"],
    ),
  );

  // Composed over MCP, as an agent would: nothing names a connector.
  const call = await mcpFor(f.runtime);
  const composed = await call("ceremony_recipe_compose", {
    references: [beta, alpha],
  });
  const draft = composed.value;
  assert.deepEqual(draft.diagnostics, []);
  assert.deepEqual(
    draft.definition.invocations.map((node: RecipeInvocation) => [
      node.id,
      node.use.id,
      node.connector,
    ]),
    [
      ["part-1", "alpha-client", "alpha"],
      ["part-2", "beta-connect", "beta"],
    ],
  );
  assert.deepEqual(draft.connectors, {
    spansConnectors: true,
    nodes: [
      { node: "part-1", connector: "alpha", source: "provider" },
      { node: "part-2", connector: "beta", source: "provider" },
    ],
    issues: [],
    // Offered, but the host resolves no context for it: not a candidate,
    // and named so a reviewer sees it was not weighed.
    unavailable: ["unconfigured"],
  });
  // Inspecting the draft shows the same placement.
  const read = await call("ceremony_draft_read", { draftId: draft.id });
  assert.deepEqual(read.value.connectors, draft.connectors);
  assert.equal(read.value.digest, draft.digest);

  // A person reviews and publishes; then it runs, each step in its context.
  const published = await f.publishDraft(
    draft as Parameters<typeof f.publishDraft>[0],
  );
  const definition = (
    await f.runtime.recipes.getPublished(
      actor,
      published.id,
      published.version,
      published.digest,
    )
  ).definition;
  const run = await f.runtime.executeRecipe(actor, definition, {}, "alpha");
  assert.equal((await f.advance(run.id, "part-1.step")).verified, true);
  assert.equal((await f.advance(run.id, "part-2.step")).verified, true);
  assert.equal(
    (await f.runtime.commands.snapshot(actor, run.id)).status,
    "complete",
  );
  assert.deepEqual(f.seen, [
    {
      operation: "alpha.create-client",
      provider: "alpha",
      target: "alpha-org",
    },
    { operation: "beta.use-client", provider: "beta", target: "beta-site" },
  ]);
  assert.ok(
    f.authorizations.some(
      (entry) =>
        entry.operation === "beta.use-client" &&
        entry.provider === "beta" &&
        entry.connector === "beta",
    ),
  );
  // No tool output carries the client, its secret or a handle.
  for (const text of [composed.text, read.text])
    for (const secret of [CLIENT_ID, CLIENT_SECRET, "common-client-"])
      assert.equal(text.includes(secret), false, secret);
});

test("AMBIGUOUS: two approved connectors for one provider leave the choice, by name, to a person", async (t) => {
  const f = fixture(t, ["alpha", "beta", "beta-eu"]);
  const alpha = await f.publish(
    f.single("alpha-client", "alpha.create-client", {}, ["client"]),
  );
  const beta = await f.publish(
    f.single(
      "beta-connect",
      "beta.use-client",
      { client: "common.oauth-client" },
      ["connection"],
    ),
  );
  const draft = await f.runtime.recipes.composePublished(actor, [alpha, beta]);
  // Alpha has one binding and is placed; beta's is never picked.
  assert.equal(draft.definition.invocations[0]!.connector, "alpha");
  assert.equal(draft.definition.invocations[1]!.connector, undefined);
  assert.deepEqual(draft.diagnostics, [
    {
      code: "connector-ambiguous",
      node: "part-2",
      message:
        "More than one approved connector can run beta/beta-oauth steps: beta, beta-eu. Name the one this step runs under; it decides whose account the step acts with.",
      choices: ["beta", "beta-eu"],
    },
  ]);
  assert.deepEqual(draft.connectors?.nodes[1], {
    node: "part-2",
    source: "unresolved",
  });
  // The draft stays a draft: it cannot be reviewed, so it cannot be published.
  await assert.rejects(
    f.runtime.recipes.review(actor, draft.id, draft.revision, draft.digest),
    /Review does not match a valid draft/,
  );

  // The author makes the choice; the draft is then reviewable.
  const edited = await f.runtime.recipes.editDraft(
    actor,
    draft.id,
    draft.revision,
    {
      ...draft.definition,
      invocations: draft.definition.invocations.map((node) =>
        node.id === "part-2" ? { ...node, connector: "beta-eu" } : node,
      ),
    },
  );
  assert.deepEqual(edited.diagnostics, []);
  assert.deepEqual(edited.connectors?.nodes, [
    { node: "part-1", connector: "alpha", source: "declared" },
    { node: "part-2", connector: "beta-eu", source: "declared" },
  ]);
  await f.runtime.recipes.review(
    actor,
    edited.id,
    edited.revision,
    edited.digest,
  );
});

test("UNAVAILABLE: a provider with no approved connector is reported, not run under another", async (t) => {
  const f = fixture(t, ["alpha"]);
  const draft = await f.runtime.recipes.createDraft(
    actor,
    recipe("no-beta", [
      operationStep("create", "alpha.create-client"),
      operationStep("use", "beta.use-client", client("create")),
    ]),
  );
  assert.deepEqual(
    draft.definition.invocations.map((node) => node.connector),
    ["alpha", undefined],
  );
  assert.deepEqual(draft.diagnostics, [
    {
      code: "connector-unavailable",
      node: "use",
      message:
        "No approved connector runs beta/beta-oauth steps. Install or configure one, then name it here.",
    },
  ]);
});

test("CROSS: an artifact that is not crossProvider may not cross providers or connectors", async (t) => {
  const f = fixture(t, ["alpha", "beta", "beta-eu"]);
  // Across providers: composition binds alpha's note into beta's step by
  // contract, and the draft says why that cannot run.
  const alpha = await f.publish(
    f.single("alpha-note", "alpha.create-client", {}, ["note"]),
  );
  const beta = await f.publish(
    f.single("beta-note", "beta.read-note", { note: "alpha.note" }, [
      "connection",
    ]),
  );
  const across = await f.runtime.recipes.composePublished(actor, [alpha, beta]);
  assert.deepEqual(across.definition.invocations[1]!.bindings.note, {
    from: "output",
    node: "part-1",
    name: "note",
  });
  assert.deepEqual(
    across.diagnostics.filter((item) => item.code === "cross-provider-binding"),
    [
      {
        code: "cross-provider-binding",
        node: "part-2.step",
        message:
          '"alpha.note" is produced by a step of provider alpha and consumed by a step of provider beta. Only an artifact whose vocabulary is declared crossProvider may cross between providers.',
      },
    ],
  );
  await assert.rejects(
    f.runtime.recipes.review(actor, across.id, across.revision, across.digest),
  );

  // Across two connectors of the same provider: only the placement sees it.
  const between = await f.runtime.recipes.createDraft(
    actor,
    recipe("grant-between-sites", [
      operationStep("issue", "beta.issue-grant", {}, { connector: "beta" }),
      operationStep(
        "use",
        "beta.use-grant",
        { grant: { from: "output", node: "issue", name: "grant" } },
        { connector: "beta-eu" },
      ),
    ]),
  );
  assert.deepEqual(between.diagnostics, [
    {
      code: "cross-connector-artifact",
      node: "use",
      message:
        '"beta.grant" is produced under connector beta and consumed under beta-eu. Only an artifact whose vocabulary is declared crossProvider may cross between connectors; run both steps under one connector.',
    },
  ]);
  // The same, under one connector, is fine.
  const within = await f.runtime.recipes.createDraft(
    actor,
    recipe("grant-within-site", [
      operationStep("issue", "beta.issue-grant", {}, { connector: "beta-eu" }),
      operationStep(
        "use",
        "beta.use-grant",
        { grant: { from: "output", node: "issue", name: "grant" } },
        { connector: "beta-eu" },
      ),
    ]),
  );
  assert.deepEqual(within.diagnostics, []);
});

test("NEUTRAL: a provider-neutral step takes the connector of the step whose artifact it reads, and runs there", async (t) => {
  const f = fixture(t);
  const draft = await f.runtime.recipes.createDraft(
    actor,
    recipe("check-then-use", [
      operationStep("create", "alpha.create-client"),
      operationStep("check", "common.check-client", client("create")),
      operationStep("use", "beta.use-client", client("create")),
    ]),
  );
  assert.deepEqual(draft.diagnostics, []);
  assert.deepEqual(draft.connectors?.nodes, [
    { node: "create", connector: "alpha", source: "provider" },
    { node: "check", connector: "alpha", source: "inherited" },
    { node: "use", connector: "beta", source: "provider" },
  ]);
  const published = await f.publishDraft(draft);
  const definition = (
    await f.runtime.recipes.getPublished(
      actor,
      published.id,
      published.version,
      published.digest,
    )
  ).definition;
  // Started under beta this time: every step still runs where it was placed.
  const run = await f.runtime.executeRecipe(actor, definition, {}, "beta");
  for (const node of ["create", "check", "use"])
    assert.equal((await f.advance(run.id, node)).verified, true, node);
  assert.deepEqual(
    f.seen.map((entry) => [entry.operation, entry.provider]),
    [
      ["alpha.create-client", "alpha"],
      ["common.check-client", "alpha"],
      ["beta.use-client", "beta"],
    ],
  );
});

test("NEUTRAL-AMBIGUOUS: a neutral step between two connectors is left for a person", async (t) => {
  const f = fixture(t);
  const draft = await f.runtime.recipes.createDraft(
    actor,
    recipe("relay", [
      operationStep("create", "alpha.create-client"),
      operationStep("relay", "common.relay-client", client("create")),
      operationStep("use", "beta.use-client", client("relay")),
    ]),
  );
  assert.equal(draft.definition.invocations[1]!.connector, undefined);
  assert.deepEqual(draft.diagnostics, [
    {
      code: "connector-inherit-ambiguous",
      node: "relay",
      message:
        "This provider-neutral step exchanges artifacts with steps under different connectors (alpha, beta). Name the connector it runs under.",
      choices: ["alpha", "beta"],
    },
  ]);

  // A neutral step joined to nothing has nothing to inherit either.
  const alone = await f.runtime.recipes.createDraft(
    actor,
    recipe("alone", [
      operationStep("create", "alpha.create-client"),
      operationStep("use", "beta.use-client", client("create")),
      operationStep("check", "common.check-client", {
        client: { from: "output", node: "create", name: "client" },
      }),
    ]),
  );
  assert.deepEqual(alone.diagnostics, []);
  const lonely = await f.runtime.recipes.createDraft(actor, {
    ...recipe("lonely", [
      operationStep("create", "alpha.create-client"),
      operationStep("use", "beta.use-client", client("create")),
      operationStep("check", "common.check-client", {
        client: { from: "input", name: "client" },
      }),
    ]),
    inputs: { client: { contract: "common.oauth-client", required: true } },
  });
  assert.deepEqual(
    lonely.diagnostics.map((item) => [item.code, item.node]),
    [["connector-inherit-ambiguous", "check"]],
  );
});

test("SINGLE-ADMITTED: a GitHub App draft that registers an account first is not split, even with an authored connector installed", async (t) => {
  const f = fixture(t, ["alpha", "github", "authored-demo"]);
  const draft = await f.runtime.recipes.createDraft(
    actor,
    recipe("register-then-install", [
      operationStep("account", "authored.register-account"),
      operationStep(
        "install",
        "github.install-app",
        {},
        {
          dependsOn: ["account"],
        },
      ),
    ]),
  );
  // Two contract providers, but one context (the GitHub App's) admits both,
  // so the draft runs whole under the run's connector, as it always has.
  // Placing by provider would have made "account" a choice between the
  // GitHub and authored connectors.
  assert.deepEqual(draft.diagnostics, []);
  assert.deepEqual(
    draft.definition.invocations.map((node) => node.connector),
    [undefined, undefined],
  );
  assert.equal(draft.connectors?.spansConnectors, false);
});

test("SINGLE: a draft within one provider is saved as written and runs under the run's connector", async (t) => {
  const f = fixture(t, ["alpha", "beta", "beta-eu"]);
  const draft = await f.runtime.recipes.createDraft(
    actor,
    recipe("grant", [
      operationStep("issue", "beta.issue-grant"),
      operationStep("use", "beta.use-grant", {
        grant: { from: "output", node: "issue", name: "grant" },
      }),
    ]),
  );
  // Two beta connectors, but no choice to make: the run's connector decides.
  assert.deepEqual(draft.diagnostics, []);
  assert.deepEqual(
    draft.definition.invocations.map((node) => node.connector),
    [undefined, undefined],
  );
  assert.deepEqual(draft.connectors, {
    spansConnectors: false,
    nodes: [
      { node: "issue", source: "run" },
      { node: "use", source: "run" },
    ],
    issues: [],
  });
});

test("RECORDING: compiling a recorded run that spans two providers places each step", async (t) => {
  const f = fixture(t);
  const run = await f.runtime.executeRecipe(
    actor,
    recipe("recorded", [
      operationStep("create", "alpha.create-client"),
      operationStep("use", "beta.use-client", client("create"), {
        connector: "beta",
      }),
    ]),
    {},
    "alpha",
  );
  const demonstration = await f.runtime.demonstrations.start(actor, run.id);
  assert.equal((await f.advance(run.id, "create")).verified, true);
  assert.equal((await f.advance(run.id, "use")).verified, true);
  const timeline = await f.runtime.demonstrations.timeline(
    actor,
    demonstration.id,
  );
  const sequences = timeline.events.map((event) => event.sequence);
  const draft = await compileDemonstrationDraft(f.runtime, actor, {
    demonstrationId: demonstration.id,
    first: Math.min(...sequences),
    last: Math.max(...sequences),
  });
  assert.deepEqual(draft.diagnostics, []);
  assert.deepEqual(
    draft.definition.invocations.map((node) => [
      node.id,
      node.use.id,
      node.connector,
      node.bindings,
    ]),
    [
      ["step-1", "alpha.create-client", "alpha", {}],
      [
        "step-2",
        "beta.use-client",
        "beta",
        { client: { from: "output", node: "step-1", name: "client" } },
      ],
    ],
  );
  assert.deepEqual(
    draft.connectors?.nodes.map((node) => node.source),
    ["provider", "provider"],
  );
  // The recording, and so the draft, carries no handle or secret.
  const text = JSON.stringify([timeline, draft]);
  for (const secret of [CLIENT_ID, CLIENT_SECRET, "common-client-"])
    assert.equal(text.includes(secret), false, secret);
});

test("assignConnectors: nested placements are kept, and a child spanning providers is reported", (t) => {
  const f = fixture(t);
  const admits = (
    context: { provider: string; profile: string },
    id: string,
    version: string,
  ) => f.runtime.commands.admits(context, id, version);
  const connectors = [
    { connectorId: "alpha", provider: "alpha", profile: "alpha-app" },
    { connectorId: "beta", provider: "beta", profile: "beta-oauth" },
  ];
  const leaf = (
    id: string,
    operationId: string,
    connector?: string,
  ): RecipeInvocation => ({
    ...operationStep(id, operationId),
    ...(connector ? { connector } : {}),
  });
  const parent = recipe("parent", [
    {
      id: "mixed",
      use: {
        kind: "recipe",
        id: "child",
        version: "1.0.0",
        digest: "a".repeat(64),
      },
      dependsOn: [],
      bindings: {},
    },
    {
      id: "placed",
      use: {
        kind: "recipe",
        id: "placed-child",
        version: "1.0.0",
        digest: "b".repeat(64),
      },
      dependsOn: [],
      bindings: {},
    },
    {
      id: "empty",
      use: {
        kind: "recipe",
        id: "unavailable-child",
        version: "1.0.0",
        digest: "c".repeat(64),
      },
      dependsOn: [],
      bindings: {},
    },
  ]);
  const { definition, report } = assignConnectors({
    definition: parent,
    leaves: [
      leaf("mixed.create", "alpha.create-client"),
      leaf("mixed.issue", "beta.issue-grant"),
      leaf("placed.issue", "beta.issue-grant", "beta"),
    ],
    registry: f.registry,
    connectors,
    admits,
  });
  assert.deepEqual(report.nodes, [
    { node: "mixed", source: "unresolved" },
    { node: "placed", source: "nested" },
    { node: "empty", source: "unresolved" },
  ]);
  assert.deepEqual(report.issues, [
    {
      code: "connector-mixed",
      node: "mixed",
      message:
        "This step's operations belong to more than one provider (alpha/alpha-app, beta/beta-oauth), so no single connector can run them. Name a connector for each provider inside the child recipe.",
    },
  ]);
  assert.deepEqual(
    definition.invocations.map((node) => node.connector),
    [undefined, undefined, undefined],
  );
});
