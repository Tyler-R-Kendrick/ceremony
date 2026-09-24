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
import {
  commonVocabulary,
  mintOAuthClient,
  readOAuthClient,
} from "../src/server/recipes/common.js";
import { SQLiteCeremonyStore } from "../src/server/persistence/index.js";
import { AuthorizationError } from "../src/server/identity.js";
import type { ActorContext } from "../src/core/operation-contracts.js";
import type { RecipeDefinition } from "../src/core/recipe-contracts.js";
import type { RunContext, RunRecord } from "../src/server/commands.js";

/*
 * One run that spans two providers: a client is created at provider "alpha"
 * and used at provider "beta". Each step is admitted and authorized against
 * the context of the connector its recipe placed it under; only a contract
 * declared shareable crosses from one context to the other; the client
 * secret stays behind an opaque, run-bound handle. Both providers are local
 * fixtures, and every credential is synthetic.
 */

const actor: ActorContext = {
  tenantId: "tenant",
  subjectId: "subject",
  sessionId: "session",
  actorKind: "human",
  capabilities: ["executor", "author", "reviewer", "publisher"],
};
const CLIENT_ID = "synthetic-client-id-4411";
const CLIENT_SECRET = "synthetic-client-secret-9f2c";

const contexts: Record<string, RunContext> = {
  alpha: {
    provider: "alpha",
    profile: "alpha-app",
    target: "alpha-org",
    origin: "https://app.example",
    environment: "test",
    configurationVersion: "alpha-v1",
  },
  beta: {
    provider: "beta",
    profile: "beta-oauth",
    target: "beta-site",
    origin: "https://app.example",
    environment: "test",
    configurationVersion: "beta-v1",
  },
  // Registered, but the host refuses this actor anything under it.
  gamma: {
    provider: "beta",
    profile: "beta-oauth",
    target: "someone-elses-site",
    origin: "https://app.example",
    environment: "test",
    configurationVersion: "beta-v1",
  },
};

const scoped = (provider: string, profile: string): VocabularyEntry => ({
  schema: z.string().min(1).max(200),
  classification: "public",
  provider,
  profile,
});

function fixture(t: TestContext) {
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
    ]),
  );
  const seen: Array<{ operation: string; context: OperationContext }> = [];
  const register = (
    id: string,
    provider: string,
    profile: string,
    inputs: Record<string, string>,
    outputs: Record<string, string>,
    handler: (
      context: OperationContext,
      inputs: Record<string, unknown>,
    ) => Promise<Record<string, unknown>>,
  ) =>
    registry.register({
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
        humanFallback: "none",
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
      fixtures: ["tests/cross-provider-runs.test.ts"],
      handler: async (context, values) => {
        seen.push({ operation: id, context });
        return { state: "complete", outputs: await handler(context, values) };
      },
      verify: async () => true,
    });
  register(
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
  );
  let received: { clientId: string; clientSecret?: string } | undefined;
  register(
    "beta.use-client",
    "beta",
    "beta-oauth",
    { client: "common.oauth-client" },
    { connection: "beta.connection" },
    async (context, values) => {
      // The secret is resolved server-side, from the handle, for this run only.
      received = await readOAuthClient(store, context, values.client);
      return { connection: received ? "connected" : "missing" };
    },
  );
  register(
    "beta.read-note",
    "beta",
    "beta-oauth",
    { note: "alpha.note" },
    { connection: "beta.connection" },
    async () => ({ connection: "read" }),
  );
  const authorizations: Array<{
    operation: string;
    provider: string;
    target: string;
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
      ["alpha", "beta", "gamma"].map((id) => [
        id,
        {
          definition: trivial(id),
          outputContract: `${id}.connection`,
          revalidateOperation: "alpha.create-client",
        },
      ]),
    ),
    context: async (_actor, connectorId) => {
      const context = contexts[connectorId];
      if (!context) throw new AuthorizationError("invalid_request");
      return context;
    },
    authorize: async (who, run: RunRecord, operation) => {
      authorizations.push({
        operation,
        provider: run.provider,
        target: run.target,
        ...(run.scope ? { connector: run.scope.connectorId } : {}),
      });
      return (
        who.subjectId === run.subjectId &&
        run.target !== "someone-elses-site" &&
        run.scope?.connectorId !== "gamma"
      );
    },
  });
  async function publish(definition: RecipeDefinition) {
    const draft = await runtime.recipes.createDraft(actor, definition);
    assert.deepEqual(draft.diagnostics, []);
    await runtime.recipes.review(actor, draft.id, draft.revision, draft.digest);
    const published = await runtime.recipes.publish(
      actor,
      draft.id,
      draft.revision,
      draft.digest,
    );
    return {
      id: definition.id,
      version: published.version,
      digest: published.digest,
    };
  }
  async function children() {
    const alpha = await publish({
      schemaVersion: 1,
      id: "alpha-client",
      title: "Create an alpha client",
      description: "",
      inputs: {},
      invocations: [
        {
          id: "create",
          use: {
            kind: "operation",
            id: "alpha.create-client",
            version: "1.0.0",
          },
          dependsOn: [],
          bindings: {},
        },
      ],
      outputs: {
        client: { node: "create", name: "client" },
        note: { node: "create", name: "note" },
      },
    });
    const beta = await publish({
      schemaVersion: 1,
      id: "beta-connect",
      title: "Use a client at beta",
      description: "",
      inputs: { client: { contract: "common.oauth-client", required: true } },
      invocations: [
        {
          id: "use",
          use: { kind: "operation", id: "beta.use-client", version: "1.0.0" },
          dependsOn: [],
          bindings: { client: { from: "input", name: "client" } },
        },
      ],
      outputs: { connection: { node: "use", name: "connection" } },
    });
    return { alpha, beta };
  }
  const composed = (
    alpha: { id: string; version: string; digest: string },
    beta: { id: string; version: string; digest: string },
    betaConnector = "beta",
  ): RecipeDefinition => ({
    schemaVersion: 1,
    id: "alpha-client-at-beta",
    title: "Create a client at alpha and use it at beta",
    description: "",
    inputs: {},
    invocations: [
      {
        id: "client",
        use: { kind: "recipe", ...alpha },
        connector: "alpha",
        dependsOn: [],
        bindings: {},
      },
      {
        id: "connect",
        use: { kind: "recipe", ...beta },
        connector: betaConnector,
        dependsOn: ["client"],
        bindings: {
          client: { from: "output", node: "client", name: "client" },
        },
      },
    ],
    outputs: { connection: { node: "connect", name: "connection" } },
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
  const runs = () =>
    store.transaction((tx) => tx.list(actor.tenantId, "run", 100));
  return {
    store,
    runtime,
    seen,
    authorizations,
    received: () => received,
    children,
    composed,
    advance,
    runs,
  };
}

test("a recipe spanning two providers runs each step in its own connector's context", async (t) => {
  const f = fixture(t);
  const { alpha, beta } = await f.children();
  const run = await f.runtime.executeRecipe(
    actor,
    f.composed(alpha, beta),
    {},
    "alpha",
  );
  // The run's own context is the connector it was started for; the beta step
  // names the context it runs in, and nothing about a target or a secret.
  assert.equal(run.provider, "alpha");
  assert.deepEqual(
    run.nodes.map((node) => ({
      id: node.id,
      provider: (node as { provider?: string }).provider,
    })),
    [
      { id: "client.create", provider: undefined },
      { id: "connect.use", provider: "beta" },
    ],
  );
  // Both connectors were authorized before the run existed.
  assert.ok(
    f.authorizations.some(
      (entry) =>
        entry.operation === "beta.use-client" &&
        entry.provider === "beta" &&
        entry.target === "beta-site" &&
        entry.connector === "beta",
    ),
  );

  assert.equal((await f.advance(run.id, "client.create")).verified, true);
  f.authorizations.length = 0;
  assert.equal((await f.advance(run.id, "connect.use")).verified, true);

  // Every authorization of the beta step evaluated beta's context.
  assert.ok(f.authorizations.length > 0);
  for (const entry of f.authorizations)
    assert.deepEqual(entry, {
      operation: "beta.use-client",
      provider: "beta",
      target: "beta-site",
      connector: "beta",
    });
  // Each handler ran with its own connector's context.
  assert.deepEqual(
    f.seen.map(({ operation, context }) => [
      operation,
      context.provider,
      context.target,
      context.configurationVersion,
    ]),
    [
      ["alpha.create-client", "alpha", "alpha-org", "alpha-v1"],
      ["beta.use-client", "beta", "beta-site", "beta-v1"],
    ],
  );
  // The shared client crossed as a handle and resolved server-side.
  assert.deepEqual(f.received(), {
    clientId: CLIENT_ID,
    clientSecret: CLIENT_SECRET,
  });
  const snapshot = await f.runtime.commands.snapshot(actor, run.id);
  assert.equal(snapshot.status, "complete");

  // No snapshot or audit event carries the client, its secret or its handle.
  const audit = await f.store.transaction((tx) =>
    tx.list(actor.tenantId, "audit", 100),
  );
  assert.ok(audit.length >= 2);
  const visible = JSON.stringify([snapshot, run, audit]);
  for (const secret of [CLIENT_ID, CLIENT_SECRET, "common-client-"])
    assert.equal(visible.includes(secret), false, secret);
});

test("a provider-scoped artifact cannot cross into another provider's step", async (t) => {
  const f = fixture(t);
  // Statically: the note belongs to alpha and is not declared shareable.
  const preview = await f.runtime.recipes.preview(actor, {
    schemaVersion: 1,
    id: "leak-note",
    title: "Leak",
    description: "",
    inputs: {},
    invocations: [
      {
        id: "create",
        use: { kind: "operation", id: "alpha.create-client", version: "1.0.0" },
        dependsOn: [],
        bindings: {},
      },
      {
        id: "read",
        use: { kind: "operation", id: "beta.read-note", version: "1.0.0" },
        connector: "beta",
        dependsOn: ["create"],
        bindings: { note: { from: "output", node: "create", name: "note" } },
      },
    ],
    outputs: {},
  } satisfies RecipeDefinition);
  assert.deepEqual(preview.diagnostics, [
    {
      code: "cross-provider-binding",
      node: "read",
      message:
        '"alpha.note" is produced by a step of provider alpha and consumed by a step of provider beta. Only an artifact whose vocabulary is declared crossProvider may cross between providers.',
    },
  ]);

  // At the command service, whatever the plan's source: refused before the run exists.
  await assert.rejects(
    f.runtime.commands.createRun(
      actor,
      contexts.alpha!,
      [
        {
          id: "create",
          operationId: "alpha.create-client",
          operationVersion: "1.0.0",
          dependsOn: [],
          bindings: {},
        },
        {
          id: "read",
          operationId: "beta.read-note",
          operationVersion: "1.0.0",
          dependsOn: ["create"],
          bindings: { note: { from: "output", node: "create", name: "note" } },
          context: { ...contexts.beta!, connectorId: "beta" },
        },
      ],
      {},
    ),
    (error) => error instanceof AuthorizationError && error.code === "denied",
  );
  assert.equal((await f.runs()).length, 0);
});

test("a step is admitted only under a connector of its own provider", async (t) => {
  const f = fixture(t);
  const { alpha, beta } = await f.children();
  // The beta child placed under alpha's connector would run beta's operation
  // in alpha's authorization context.
  await assert.rejects(
    f.runtime.executeRecipe(
      actor,
      f.composed(alpha, beta, "alpha"),
      {},
      "alpha",
    ),
    (error) => error instanceof AuthorizationError && error.code === "denied",
  );
  assert.equal((await f.runs()).length, 0);
  assert.equal(f.seen.length, 0);
});

test("a composition naming a connector the host will not authorize, or does not register, is refused before a run exists", async (t) => {
  const f = fixture(t);
  const { alpha, beta } = await f.children();
  await assert.rejects(
    f.runtime.executeRecipe(
      actor,
      f.composed(alpha, beta, "gamma"),
      {},
      "alpha",
    ),
    (error) => error instanceof AuthorizationError && error.code === "denied",
  );
  assert.ok(
    f.authorizations.some(
      (entry) =>
        entry.connector === "gamma" && entry.target === "someone-elses-site",
    ),
  );
  await assert.rejects(
    f.runtime.executeRecipe(
      actor,
      f.composed(alpha, beta, "unregistered"),
      {},
      "alpha",
    ),
    (error) =>
      error instanceof AuthorizationError && error.code === "invalid_request",
  );
  assert.equal((await f.runs()).length, 0);
  assert.equal(f.seen.length, 0);
});

test("a single-provider recipe keeps the run's own context and adds nothing to its snapshot", async (t) => {
  const f = fixture(t);
  const { alpha } = await f.children();
  const run = await f.runtime.executeRecipe(
    actor,
    {
      schemaVersion: 1,
      id: "alpha-only",
      title: "Alpha only",
      description: "",
      inputs: {},
      invocations: [
        {
          id: "client",
          use: { kind: "recipe", ...alpha },
          // Naming the run's own connector is the same as naming none.
          connector: "alpha",
          dependsOn: [],
          bindings: {},
        },
      ],
      outputs: {},
    },
    {},
    "alpha",
  );
  assert.deepEqual(run.nodes, [
    {
      id: "client.create",
      operationId: "alpha.create-client",
      operationVersion: "1.0.0",
      state: "pending",
      verified: false,
    },
  ]);
  assert.ok(f.authorizations.every((entry) => entry.connector === undefined));
});
