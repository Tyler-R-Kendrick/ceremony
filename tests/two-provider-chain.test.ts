import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { test, type TestContext } from "node:test";
import { z } from "zod";
import { createTeachingRuntime } from "../src/server/teaching-runtime.js";
import {
  OperationRegistry,
  type OperationContext,
  type OperationResult,
  type VocabularyEntry,
} from "../src/server/recipes/registry.js";
import {
  commonVocabulary,
  mintOAuthClient,
  readOAuthClient,
} from "../src/server/recipes/common.js";
import {
  recordKinds,
  SQLiteCeremonyStore,
} from "../src/server/persistence/index.js";
import { AuthorizationError } from "../src/server/identity.js";
import {
  runCeremony,
  type CeremonyResult,
} from "../src/server/browser-driver.js";
import {
  createHeuristicInterpreter,
  type InterpreterInput,
} from "../src/server/browser-interpreter.js";
import type { ActorContext } from "../src/core/operation-contracts.js";
import type { RecipeDefinition } from "../src/core/recipe-contracts.js";
import type { RunContext, RunRecord } from "../src/server/commands.js";
import { createHttpCeremonyPage } from "./doubles/http-page.js";
import {
  configureSignIn,
  issuedAtA,
  registrationPlan,
  signInPlan,
  startChainProviders,
  type ChainProviders,
} from "./doubles/auth-provider/two-provider-chain.js";

/*
 * "Create an OAuth app at provider A, then use it at provider B", as one run
 * of three steps, each in its own connector's context:
 *
 * 1. alpha (browser, at A): sign in, register B's app at developer settings,
 *    generate a client secret. The driver reads the client ID and secret from
 *    the fields the plan names and hands them straight to `mintOAuthClient`;
 *    the step's only output is the opaque, run-bound `common.oauth-client`
 *    handle.
 * 2. beta (server side, at B): resolve the handle with `readOAuthClient` and
 *    save it through B's admin API, which checks it with A before saving.
 * 3. beta (browser, at B): "Continue with Northwind Cloud", sign in at A,
 *    allow B's app, arrive at B signed in.
 *
 * A has `strictClients` on, so every step is checked by the provider that
 * would check it for real: an unregistered client, a wrong secret or a
 * callback A never registered fails. The handle crosses from alpha to beta
 * only because `common.oauth-client` is `crossProvider`. Providers are local
 * fixtures and every credential is synthetic; the interpreter is the
 * production heuristic, so no model is involved.
 */

const actor: ActorContext = {
  tenantId: "tenant",
  subjectId: "subject",
  sessionId: "session",
  actorKind: "human",
  capabilities: ["executor", "author", "reviewer", "publisher"],
};

const contexts: Record<string, RunContext> = {
  alpha: {
    provider: "alpha",
    profile: "alpha-developer",
    target: "alpha-account",
    origin: "https://app.example",
    environment: "test",
    configurationVersion: "alpha-v1",
  },
  beta: {
    provider: "beta",
    profile: "beta-workspace",
    target: "beta-workspace",
    origin: "https://app.example",
    environment: "test",
    configurationVersion: "beta-v1",
  },
};

const publicContract = (
  provider: string,
  profile: string,
): VocabularyEntry => ({
  schema: z.enum(["configured", "signed-in"]),
  classification: "public",
  provider,
  profile,
});

const failed = (
  diagnosticCode: NonNullable<OperationResult["diagnosticCode"]>,
): OperationResult => ({ state: "failed", outputs: {}, diagnosticCode });

type Fixture = Awaited<ReturnType<typeof fixture>>;

async function fixture(
  t: TestContext,
  options: {
    /** Mint a client A never issued instead of registering one. */
    forge?: boolean;
  } = {},
) {
  const chain: ChainProviders = await startChainProviders();
  t.after(() => chain.close());
  const store = new SQLiteCeremonyStore(":memory:", {
    current: "key",
    keys: { key: randomBytes(32) },
  });
  t.after(() => store.close());
  const registry = new OperationRegistry(
    new Map<string, VocabularyEntry>([
      ...commonVocabulary,
      ["beta.integration", publicContract("beta", "beta-workspace")],
      ["beta.session", publicContract("beta", "beta-workspace")],
    ]),
  );

  /** Everything any interpreter was given, across both browser steps. */
  const interpreted: InterpreterInput[] = [];
  const transcripts: CeremonyResult[] = [];
  const seen: Array<{ operation: string; provider?: string; target: string }> =
    [];
  /** Handles minted, so a test can try one in another run. */
  const minted: string[] = [];

  const browse = async (
    plan: ReturnType<typeof signInPlan>,
    issued?: {
      keep: NonNullable<Parameters<typeof runCeremony>[0]["issued"]>["keep"];
    },
  ) => {
    const page = createHttpCeremonyPage();
    await page.goto(plan.entryUrl);
    const heuristic = createHeuristicInterpreter();
    const { entryUrl: _entry, ...rest } = plan;
    const result = await runCeremony({
      ...rest,
      page,
      interpreter: async (input) => {
        interpreted.push(structuredClone(input));
        return heuristic(input);
      },
      ...(issued ? { issued: { fields: issuedAtA, keep: issued.keep } } : {}),
    });
    transcripts.push(result);
    return result;
  };

  const register = (
    id: string,
    provider: string,
    profile: string,
    inputs: Record<string, string>,
    outputs: Record<string, string>,
    handler: (
      context: OperationContext,
      inputs: Record<string, unknown>,
    ) => Promise<OperationResult>,
    verify: (
      context: OperationContext,
      result: OperationResult,
    ) => Promise<boolean>,
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
      fixtures: ["tests/two-provider-chain.test.ts"],
      handler: async (context, values) => {
        seen.push({
          operation: id,
          ...(context.provider ? { provider: context.provider } : {}),
          target: context.target,
        });
        return handler(context, values);
      },
      verify,
    });

  // Step 1: the browser at A. The only thing the handler returns is the
  // handle; the values went from the page to the record without passing
  // through anything a model, a snapshot or a tool result can reach.
  register(
    "alpha.register-oauth-app",
    "alpha",
    "alpha-developer",
    {},
    { client: "common.oauth-client" },
    async (context) => {
      if (options.forge) {
        const handle = await mintOAuthClient(store, context, {
          clientId: "oac_never-registered",
          clientSecret: "ocs_forged-secret-0000000000",
        });
        minted.push(handle);
        return { state: "complete", outputs: { client: handle } };
      }
      let handle: string | undefined;
      const result = await browse(registrationPlan(chain), {
        keep: async (values) => {
          handle = await mintOAuthClient(store, context, {
            clientId: values["client-id"]!,
            ...(values["client-secret"]
              ? { clientSecret: values["client-secret"] }
              : {}),
          });
        },
      });
      if (result.status !== "completed" || !handle)
        return failed("unavailable");
      minted.push(handle);
      return { state: "complete", outputs: { client: handle } };
    },
    async (context, result) =>
      Boolean(await readOAuthClient(store, context, result.outputs.client)),
  );

  // Step 2: server side at B. The secret is resolved from the handle here,
  // for this run only, and sent to B's admin API; B checks it with A.
  register(
    "beta.configure-sign-in",
    "beta",
    "beta-workspace",
    { client: "common.oauth-client" },
    { integration: "beta.integration" },
    async (context, values) => {
      const client = await readOAuthClient(store, context, values.client);
      if (!client) return failed("denied");
      const saved = await configureSignIn(chain.b, client);
      if (saved.status !== 200) return failed("verification-rejected");
      return { state: "complete", outputs: { integration: "configured" } };
    },
    async () => chain.b.integration() !== undefined,
  );

  // Step 3: the browser at B, signing in with A through B's registered app.
  // The account at A stands in for the person's own private collection.
  register(
    "beta.sign-in-with-alpha",
    "beta",
    "beta-workspace",
    { integration: "beta.integration" },
    { session: "beta.session" },
    async () => {
      const result = await browse(signInPlan(chain));
      return result.status === "completed"
        ? { state: "complete", outputs: { session: "signed-in" } }
        : failed("unavailable");
    },
    async () => chain.b.signIns().includes(chain.account.email),
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
        use: {
          kind: "operation",
          id: "alpha.register-oauth-app",
          version: "1.0.0",
        },
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
      ["alpha", "beta"].map((id) => [
        id,
        {
          definition: trivial(id),
          outputContract: `${id}.integration`,
          revalidateOperation: "alpha.register-oauth-app",
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
        ...(run.scope ? { connector: run.scope.connectorId } : {}),
      });
      return who.subjectId === run.subjectId;
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

  const alphaChild = await publish({
    schemaVersion: 1,
    id: "alpha-oauth-app",
    title: "Register an OAuth app at Northwind Cloud",
    description: "",
    inputs: {},
    invocations: [
      {
        id: "register",
        use: {
          kind: "operation",
          id: "alpha.register-oauth-app",
          version: "1.0.0",
        },
        dependsOn: [],
        bindings: {},
      },
    ],
    outputs: { client: { node: "register", name: "client" } },
  });
  const betaChild = await publish({
    schemaVersion: 1,
    id: "beta-sign-in-with-alpha",
    title: "Set up and use Sign in with Northwind Cloud",
    description: "",
    inputs: { client: { contract: "common.oauth-client", required: true } },
    invocations: [
      {
        id: "configure",
        use: {
          kind: "operation",
          id: "beta.configure-sign-in",
          version: "1.0.0",
        },
        dependsOn: [],
        bindings: { client: { from: "input", name: "client" } },
      },
      {
        id: "sign-in",
        use: {
          kind: "operation",
          id: "beta.sign-in-with-alpha",
          version: "1.0.0",
        },
        dependsOn: ["configure"],
        bindings: {
          integration: {
            from: "output",
            node: "configure",
            name: "integration",
          },
        },
      },
    ],
    outputs: { session: { node: "sign-in", name: "session" } },
  });
  const chained: RecipeDefinition = {
    schemaVersion: 1,
    id: "northwind-app-for-globex",
    title: "Register an app at Northwind Cloud and sign in to Globex with it",
    description: "",
    inputs: {},
    invocations: [
      {
        id: "app",
        use: { kind: "recipe", ...alphaChild },
        connector: "alpha",
        dependsOn: [],
        bindings: {},
      },
      {
        id: "workspace",
        use: { kind: "recipe", ...betaChild },
        connector: "beta",
        dependsOn: ["app"],
        bindings: { client: { from: "output", node: "app", name: "client" } },
      },
    ],
    outputs: { session: { node: "workspace", name: "session" } },
  };

  /** Every result a caller of the command service was handed. */
  const results: unknown[] = [];
  const advance = async (runId: string, nodeId: string) => {
    const snapshot = await runtime.commands.snapshot(actor, runId);
    const result = await runtime.commands.advance(
      actor,
      runId,
      nodeId,
      snapshot.revision,
      `command:${randomUUID()}`,
    );
    results.push(result);
    return result;
  };
  /**
   * Every stored record except the run-bound handle records themselves,
   * optionally only of some kinds.
   */
  const everythingButHandles = async (
    kinds: readonly (typeof recordKinds)[number][] = recordKinds,
  ) => {
    const all: unknown[] = [];
    for (const kind of kinds) {
      const records = await store.transaction((tx) =>
        tx.list<unknown>(actor.tenantId, kind, 500),
      );
      for (const record of records)
        if (!(kind === "artifact" && record.id.startsWith("common-step:")))
          all.push(record);
    }
    return all;
  };
  return {
    chain,
    store,
    runtime,
    chained,
    alphaChild,
    betaChild,
    advance,
    results,
    interpreted,
    transcripts,
    seen,
    minted,
    authorizations,
    everythingButHandles,
  };
}

async function runChain(f: Fixture) {
  const run = await f.runtime.executeRecipe(actor, f.chained, {}, "alpha");
  const steps = [];
  for (const node of [
    "app.register",
    "workspace.configure",
    "workspace.sign-in",
  ])
    steps.push(await f.advance(run.id, node));
  return { run, steps };
}

test("CHAIN: an OAuth app registered at A in the browser signs a person in to B, each step in its own context", async (t) => {
  const f = await fixture(t);
  const { run, steps } = await runChain(f);
  assert.deepEqual(
    steps.map((step) => [step.nodeId, step.state, step.verified]),
    [
      ["app.register", "complete", true],
      ["workspace.configure", "complete", true],
      ["workspace.sign-in", "complete", true],
    ],
  );
  const snapshot = await f.runtime.commands.snapshot(actor, run.id);
  assert.equal(snapshot.status, "complete");

  // Each handler ran in its own connector's context, and each step was
  // authorized against that context.
  assert.deepEqual(f.seen, [
    {
      operation: "alpha.register-oauth-app",
      provider: "alpha",
      target: "alpha-account",
    },
    {
      operation: "beta.configure-sign-in",
      provider: "beta",
      target: "beta-workspace",
    },
    {
      operation: "beta.sign-in-with-alpha",
      provider: "beta",
      target: "beta-workspace",
    },
  ]);
  for (const operation of ["beta.configure-sign-in", "beta.sign-in-with-alpha"])
    assert.ok(
      f.authorizations.some(
        (entry) =>
          entry.operation === operation &&
          entry.provider === "beta" &&
          entry.connector === "beta",
      ),
      operation,
    );

  // The provider-side facts: A registered one app with one secret, for B's
  // exact callback; B saved that client and signed the person in through it.
  const [app] = f.chain.a.oauthApps();
  assert.ok(app);
  assert.equal(app.callbackUrl, f.chain.b.callbackUrl);
  assert.equal(app.secrets, 1);
  assert.deepEqual(f.chain.b.integration(), { clientId: app.clientId });
  assert.deepEqual(f.chain.b.signIns(), [f.chain.account.email]);

  // The one place the secret exists on our side is the run-bound record.
  const [handle] = f.minted;
  const resolved = await readOAuthClient(
    f.store,
    { actor, runId: run.id },
    handle,
  );
  assert.equal(resolved?.clientId, app.clientId);
  const secret = resolved?.clientSecret ?? "";
  assert.match(secret, /^ocs_[a-f0-9]{40}$/);

  // Canaries. Nothing a model, a person reading a run or an audit log is
  // shown — the interpreter's snapshots, the transcripts, the command
  // results, the run and its snapshot, audit records and semantic events —
  // carries the secret, the client ID, the handle or the password.
  const visible = JSON.stringify([
    f.interpreted,
    f.transcripts,
    f.results,
    snapshot,
    run,
    await f.everythingButHandles(["audit", "event", "demonstration"]),
  ]);
  for (const value of [secret, app.clientId, handle!, f.chain.account.password])
    assert.equal(visible.includes(value), false, value.slice(0, 8));
  // And no stored record but the handle's own holds the secret or the
  // client ID. The handle itself is a step output, kept server-side.
  const stored = JSON.stringify(await f.everythingButHandles());
  for (const value of [secret, app.clientId])
    assert.equal(stored.includes(value), false, value.slice(0, 8));
  // The interpreter still did real work in both browsers.
  assert.ok(
    f.interpreted.some((input) =>
      input.snapshot.headings.includes("Register a new OAuth app"),
    ),
  );
  assert.ok(
    f.interpreted.some((input) =>
      input.snapshot.headings.some((heading) =>
        heading.startsWith(`${f.chain.b.name} wants to access`),
      ),
    ),
  );
});

test("CHAIN-FORGED: B refuses a client A never issued, and the sign-in step never runs", async (t) => {
  const f = await fixture(t, { forge: true });
  const run = await f.runtime.executeRecipe(actor, f.chained, {}, "alpha");
  assert.equal((await f.advance(run.id, "app.register")).verified, true);
  const configure = await f.advance(run.id, "workspace.configure");
  assert.equal(configure.state, "failed");
  assert.equal(configure.verified, false);
  assert.equal(f.chain.b.integration(), undefined);
  assert.deepEqual(f.chain.b.refusedClients(), ["oac_never-registered"]);
  // The next step depends on an integration that does not exist.
  await assert.rejects(f.advance(run.id, "workspace.sign-in"));
  assert.deepEqual(f.chain.b.signIns(), []);
  assert.equal(
    JSON.stringify([f.results, await f.everythingButHandles()]).includes(
      "ocs_forged-secret",
    ),
    false,
  );
});

test("CHAIN-OTHER-RUN: a client handle from another run configures nothing", async (t) => {
  const f = await fixture(t);
  const first = await f.runtime.executeRecipe(actor, f.chained, {}, "alpha");
  assert.equal((await f.advance(first.id, "app.register")).verified, true);
  const [handle] = f.minted;
  assert.ok(handle);

  // Through the recipe surface, a caller cannot bind a protected handle at all.
  await assert.rejects(
    f.runtime.executeRecipe(
      actor,
      {
        schemaVersion: 1,
        id: "configure-with-a-handle",
        title: "Configure with a handle",
        description: "",
        inputs: { client: { contract: "common.oauth-client", required: true } },
        invocations: [
          {
            id: "configure",
            use: {
              kind: "operation",
              id: "beta.configure-sign-in",
              version: "1.0.0",
            },
            dependsOn: [],
            bindings: { client: { from: "input", name: "client" } },
          },
        ],
        outputs: {},
      },
      { client: handle },
      "beta",
    ),
    (error) => error instanceof AuthorizationError && error.code === "denied",
  );

  // At the command service itself, a run that carries it gets nowhere: the
  // handle resolves only inside the run that minted it.
  const second = await f.runtime.commands.createRun(
    actor,
    contexts.beta!,
    [
      {
        id: "configure",
        operationId: "beta.configure-sign-in",
        operationVersion: "1.0.0",
        dependsOn: [],
        bindings: { client: { from: "input", name: "client" } },
      },
    ],
    { client: handle },
  );
  const configure = await f.advance(second.id, "configure");
  assert.equal(configure.state, "failed");
  assert.equal(configure.verified, false);
  assert.equal(f.chain.b.integration(), undefined);
  // Refused before B, or A, was ever asked.
  assert.deepEqual(f.chain.b.refusedClients(), []);
});

test("CHAIN-COMPOSED: composing A's and B's recipes places each under its connector, and the published result runs the chain", async (t) => {
  const f = await fixture(t);
  // No connector named anywhere: each provider has one approved connector.
  const draft = await f.runtime.recipes.composePublished(actor, [
    f.betaChild,
    f.alphaChild,
  ]);
  assert.deepEqual(draft.diagnostics, []);
  assert.deepEqual(
    draft.definition.invocations.map((node) => [
      node.id,
      node.use.id,
      node.connector,
    ]),
    [
      ["part-1", "alpha-oauth-app", "alpha"],
      ["part-2", "beta-sign-in-with-alpha", "beta"],
    ],
  );
  assert.deepEqual(
    draft.connectors?.nodes.map((node) => node.source),
    ["provider", "provider"],
  );

  // Review and publication stay with a person.
  await f.runtime.recipes.review(actor, draft.id, draft.revision, draft.digest);
  const published = await f.runtime.recipes.publish(
    actor,
    draft.id,
    draft.revision,
    draft.digest,
  );
  const run = await f.runtime.executeRecipe(
    actor,
    published.definition,
    {},
    "alpha",
  );
  const steps = [];
  for (const node of ["part-1.register", "part-2.configure", "part-2.sign-in"])
    steps.push(await f.advance(run.id, node));
  assert.deepEqual(
    steps.map((step) => [step.nodeId, step.state, step.verified]),
    [
      ["part-1.register", "complete", true],
      ["part-2.configure", "complete", true],
      ["part-2.sign-in", "complete", true],
    ],
  );
  assert.deepEqual(
    f.seen.map((entry) => [entry.operation, entry.provider]),
    [
      ["alpha.register-oauth-app", "alpha"],
      ["beta.configure-sign-in", "beta"],
      ["beta.sign-in-with-alpha", "beta"],
    ],
  );
  const [app] = f.chain.a.oauthApps();
  assert.deepEqual(f.chain.b.integration(), { clientId: app!.clientId });
  assert.deepEqual(f.chain.b.signIns(), [f.chain.account.email]);
  // The draft and everything a caller was handed hold no client value.
  const [handle] = f.minted;
  const secret =
    (await readOAuthClient(f.store, { actor, runId: run.id }, handle))
      ?.clientSecret ?? "";
  assert.match(secret, /^ocs_/);
  const visible = JSON.stringify([draft, published, f.results]);
  for (const value of [secret, app!.clientId, handle!])
    assert.equal(visible.includes(value), false, value.slice(0, 8));
});
