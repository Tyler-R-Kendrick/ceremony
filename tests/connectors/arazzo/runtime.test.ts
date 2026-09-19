import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { test, type TestContext } from "node:test";
import { ProtectedCommandService } from "../../../src/server/commands.js";
import { SQLiteCeremonyStore } from "../../../src/server/persistence/index.js";
import {
  RecipeService,
  validateRecipe,
} from "../../../src/server/recipes/index.js";
import {
  compileArazzoToRecipe,
  readArazzo,
  toRunPlan,
  type ArazzoCompilation,
  type OperationBindingCatalogInput,
} from "../../../src/server/connectors/formats/arazzo/index.js";
import { startHttpFixture } from "../doubles/http-fixture.js";
import {
  storeActor,
  storeCatalog,
  storeRegistry,
  storeRunContext,
  type HandlerBehavior,
} from "../fixtures/arazzo/host.js";
import {
  cyclicSteps110,
  storeWorkflow101,
} from "../fixtures/arazzo/documents.js";

/*
 * WF-05: a compiled Arazzo workflow driven through the existing recipe and
 * command infrastructure. The provider is a loopback fixture that records
 * every request it receives, so "the effect already happened" is an observed
 * fact rather than an assumption, and the command service's own rules about
 * waits, dependencies, cancellation and uncertainty are what is under test.
 */

type Behavior = {
  afterPrepare?: () => Promise<void> | void;
  afterVerify?: () => Promise<void> | void;
  prepareState?: "awaiting-human";
  prepareVerified?: boolean;
  verifyVerified?: boolean;
};

async function fixture(t: TestContext, behavior: Behavior = {}) {
  const bodies: Record<string, unknown>[] = [];
  const server = await startHttpFixture(async (request) => {
    const body = JSON.parse(request.body.toString() || "{}") as Record<
      string,
      unknown
    >;
    bodies.push({ path: request.url.pathname, ...body });
    if (request.url.pathname === "/prepare")
      return { body: { setup: "setup-1" } };
    if (request.url.pathname === "/verify")
      return {
        body: {
          account: "acct_1",
          token: "tok_secret",
          owner: "ada@example.com",
        },
      };
    if (request.url.pathname === "/finish")
      return { body: { account: "acct_1" } };
    return undefined;
  });
  t.after(() => server.close());
  const store = new SQLiteCeremonyStore(":memory:", {
    current: "test",
    keys: { test: randomBytes(32) },
  });
  t.after(() => store.close());
  const handlers: HandlerBehavior = {
    afterRequest: async (operation) => {
      if (operation === "store.prepare") await behavior.afterPrepare?.();
      if (operation === "store.verify") await behavior.afterVerify?.();
    },
    result: (operation) =>
      operation === "store.prepare" && behavior.prepareState
        ? { state: behavior.prepareState, outputs: {} }
        : undefined,
    verified: (operation) =>
      operation === "store.prepare"
        ? (behavior.prepareVerified ?? true)
        : (behavior.verifyVerified ?? true),
  };
  const { registry, calls } = storeRegistry({
    origin: server.origin,
    behavior: handlers,
  });
  const recipes = new RecipeService(store, registry);
  const commands = new ProtectedCommandService(
    store,
    registry,
    async () => true,
  );
  const compile = (
    document: unknown,
    workflowId: string,
    catalog: OperationBindingCatalogInput = storeCatalog(storeActor.tenantId),
  ): ArazzoCompilation =>
    compileArazzoToRecipe(readArazzo(document), catalog, {
      workflowId,
      registry,
      tenantId: storeActor.tenantId,
    });
  const start = async (
    compilation: ArazzoCompilation,
    inputs: Record<string, unknown>,
  ) => {
    const validated = await recipes.preview(storeActor, compilation.recipe!);
    assert.deepEqual(validated.diagnostics, []);
    const run = await commands.createRun(
      storeActor,
      storeRunContext,
      toRunPlan(validated.leaves),
      inputs,
    );
    return { run, validated };
  };
  const advance = async (runId: string, nodeId: string, commandId: string) => {
    const snapshot = await commands.snapshot(storeActor, runId);
    return commands.advance(
      storeActor,
      runId,
      nodeId,
      snapshot.revision,
      commandId,
    );
  };
  return {
    server,
    store,
    registry,
    recipes,
    commands,
    compile,
    start,
    advance,
    calls,
    bodies,
    requests: (path: string) => server.received("POST", path),
  };
}

test("a compiled workflow runs through the command service and passes step outputs forward", async (t) => {
  const f = await fixture(t);
  const compilation = f.compile(storeWorkflow101(), "connect-store");
  assert.equal(compilation.status, "executable");
  const { run, validated } = await f.start(compilation, { region: "eu" });
  assert.deepEqual(
    run.nodes.map((node) => [node.id, node.state]),
    [
      ["prepare", "pending"],
      ["verify", "pending"],
    ],
  );
  assert.deepEqual(
    validated.leaves.map((leaf) => leaf.dependsOn),
    [[], ["prepare"]],
  );

  // A dependent step cannot run before its producer.
  await assert.rejects(f.advance(run.id, "verify", "early"));
  assert.deepEqual(f.requests("/verify"), []);

  const prepared = await f.advance(run.id, "prepare", "c1");
  assert.equal(prepared.state, "complete");
  assert.equal(prepared.verified, true);
  const verified = await f.advance(run.id, "verify", "c2");
  assert.equal(verified.verified, true);
  assert.equal(
    (await f.commands.snapshot(storeActor, run.id)).status,
    "complete",
  );
  assert.deepEqual(f.calls, ["store.prepare", "store.verify"]);

  // The output reference carried the producer's value into the next request.
  assert.deepEqual(f.bodies, [
    { path: "/prepare", node: "prepare", inputs: { region: "eu" } },
    { path: "/verify", node: "verify", inputs: { setup: "setup-1" } },
  ]);
});

test("a workflow step becomes a recipe child that the existing validator expands", async (t) => {
  const f = await fixture(t);
  // The child workflow is itself compiled, reviewed and published as a recipe.
  const document = storeWorkflow101();
  const workflows = document.workflows as Record<string, unknown>[];
  const child = structuredClone(workflows[0]!);
  child.workflowId = "prepare-store";
  child.summary = "Prepare the store";
  (child.steps as Record<string, unknown>[]).length = 1;
  child.outputs = { setup: "$steps.prepare.outputs.setup" };
  workflows.push(child);
  const childCompilation = f.compile(document, "prepare-store");
  assert.equal(childCompilation.status, "executable");
  const draft = await f.recipes.createDraft(
    storeActor,
    childCompilation.recipe!,
  );
  assert.deepEqual(draft.diagnostics, []);
  await f.recipes.review(storeActor, draft.id, draft.revision, draft.digest);
  const published = await f.recipes.publish(
    storeActor,
    draft.id,
    draft.revision,
    draft.digest,
  );

  // The parent references it as a workflow step; only the host catalog may bind it.
  const parent = structuredClone(document);
  const parentWorkflow = (parent.workflows as Record<string, unknown>[])[0]!;
  parentWorkflow.workflowId = "connect-store";
  parentWorkflow.steps = [
    {
      stepId: "setup",
      description: "Run the prepare workflow",
      workflowId: "prepare-store",
      parameters: [{ name: "region", value: "$inputs.region" }],
    },
    {
      stepId: "verify",
      description: "Verify the account",
      operationId: "verifyAccount",
      parameters: [
        { name: "setup", in: "query", value: "$steps.setup.outputs.setup" },
      ],
      outputs: { account: "$response.body#/account" },
    },
  ];
  parentWorkflow.outputs = { account: "$steps.verify.outputs.account" };

  const unbound = f.compile(parent, "connect-store");
  assert.equal(
    unbound.status,
    "blocked",
    "an unregistered workflow reference is blocked",
  );
  assert.ok(
    unbound.issues.some(
      (issue) => issue.code === "arazzo.binding.unbound-workflow",
    ),
  );

  const catalog = storeCatalog(storeActor.tenantId);
  catalog.workflows = [
    {
      workflowId: "prepare-store",
      documentDigest: readArazzo(parent).digest!,
      recipe: {
        id: published.definition.id,
        version: published.version,
        digest: published.digest,
      },
      inputs: { region: "region" },
      outputs: { setup: "setup" },
    },
  ];
  const compilation = f.compile(parent, "connect-store", catalog);
  assert.deepEqual(
    compilation.issues.filter((issue) => issue.severity === "blocking"),
    [],
  );
  assert.deepEqual(compilation.recipe!.invocations[0]!.use, {
    kind: "recipe",
    id: published.definition.id,
    version: published.version,
    digest: published.digest,
  });

  const { run, validated } = await f.start(compilation, { region: "us" });
  assert.deepEqual(
    validated.leaves.map((leaf) => leaf.id),
    ["setup.prepare", "verify"],
    "the child expands into the parent's plan",
  );
  assert.deepEqual(validated.leaves[1]!.bindings.setup, {
    from: "output",
    node: "setup.prepare",
    name: "setup",
  });
  await f.advance(run.id, "setup.prepare", "c1");
  await f.advance(run.id, "verify", "c2");
  assert.equal(
    (await f.commands.snapshot(storeActor, run.id)).status,
    "complete",
  );
  assert.deepEqual(f.bodies, [
    { path: "/prepare", node: "setup.prepare", inputs: { region: "us" } },
    { path: "/verify", node: "verify", inputs: { setup: "setup-1" } },
  ]);

  // A child pinned to a digest the publisher retired is no longer executable.
  await f.recipes.retire(
    storeActor,
    published.definition.id,
    published.version,
  );
  await assert.rejects(
    f.recipes.preview(storeActor, compilation.recipe!).then((result) => {
      assert.deepEqual(result.diagnostics, []);
    }),
  );
});

test("a step that needs a person waits instead of completing, and blocks what follows", async (t) => {
  const f = await fixture(t, { prepareState: "awaiting-human" });
  const compilation = f.compile(storeWorkflow101(), "connect-store");
  const { run } = await f.start(compilation, { region: "eu" });
  const waiting = await f.advance(run.id, "prepare", "c1");
  assert.equal(waiting.state, "awaiting-human");
  assert.equal(waiting.verified, false);
  const snapshot = await f.commands.snapshot(storeActor, run.id);
  assert.equal(snapshot.nodes[0]!.state, "awaiting-human");
  assert.equal(snapshot.status, "active");
  await assert.rejects(f.advance(run.id, "verify", "c2"));
  assert.deepEqual(
    f.requests("/verify"),
    [],
    "no provider call follows a wait",
  );
});

test("a rejected verification fails the prerequisite and stops the dependent step", async (t) => {
  const f = await fixture(t, { prepareVerified: false });
  const compilation = f.compile(storeWorkflow101(), "connect-store");
  const { run } = await f.start(compilation, { region: "eu" });
  const failed = await f.advance(run.id, "prepare", "c1");
  assert.equal(failed.state, "failed");
  assert.equal(failed.verified, false);
  await assert.rejects(f.advance(run.id, "verify", "c2"));
  assert.equal(f.requests("/prepare").length, 1);
  assert.deepEqual(f.requests("/verify"), []);
  assert.equal(
    JSON.stringify(await f.commands.snapshot(storeActor, run.id)).includes(
      "setup-1",
    ),
    false,
    "a rejected step publishes no outputs",
  );
});

test("AC-IMP-08 an external effect whose handler then fails is uncertain, never retried", async (t) => {
  let fail = true;
  const f = await fixture(t, {
    afterVerify: () => {
      if (fail) throw new Error("connection lost after the provider answered");
    },
  });
  const compilation = f.compile(storeWorkflow101(), "connect-store");
  const { run } = await f.start(compilation, { region: "eu" });
  await f.advance(run.id, "prepare", "c1");
  const revision = (await f.commands.snapshot(storeActor, run.id)).revision;
  const uncertain = await f.commands.advance(
    storeActor,
    run.id,
    "verify",
    revision,
    "c2",
  );
  assert.equal(uncertain.state, "uncertain");
  assert.equal(uncertain.verified, false);
  assert.equal(
    f.requests("/verify").length,
    1,
    "the provider did receive the request before the failure",
  );

  // Repeating the very same command reports the same uncertainty; it does not re-send.
  const repeat = await f.commands.advance(
    storeActor,
    run.id,
    "verify",
    revision,
    "c2",
  );
  assert.equal(repeat.state, "uncertain");
  assert.equal(f.requests("/verify").length, 1);

  // A fresh command cannot quietly retry an uncertain effect either.
  fail = false;
  await assert.rejects(f.advance(run.id, "verify", "c3"), /denied/);
  assert.equal(f.requests("/verify").length, 1);
  const snapshot = await f.commands.snapshot(storeActor, run.id);
  assert.equal(snapshot.nodes[1]!.state, "uncertain");
  assert.equal(snapshot.status, "active");
});

test("cancelling a run stops further steps through the same authority", async (t) => {
  const f = await fixture(t);
  const compilation = f.compile(storeWorkflow101(), "connect-store");
  const { run } = await f.start(compilation, { region: "eu" });
  await f.advance(run.id, "prepare", "c1");
  const current = await f.commands.snapshot(storeActor, run.id);
  const cancelled = await f.commands.cancel(
    storeActor,
    run.id,
    current.revision,
  );
  assert.equal(cancelled.status, "cancelled");
  await assert.rejects(f.advance(run.id, "verify", "c2"));
  assert.deepEqual(f.requests("/verify"), []);
  assert.equal(f.requests("/prepare").length, 1);
});

test("resumed verification rechecks provider evidence instead of repeating the effect", async (t) => {
  const behavior: Behavior = {};
  const f = await fixture(t, behavior);
  const compilation = f.compile(storeWorkflow101(), "connect-store");
  const { run } = await f.start(compilation, { region: "eu" });
  await f.advance(run.id, "prepare", "c1");
  await f.advance(run.id, "verify", "c2");
  assert.equal(
    (await f.commands.snapshot(storeActor, run.id)).status,
    "complete",
  );
  const sent = f.requests("/verify").length;

  // Evidence still holds: revalidation keeps the run complete and sends nothing.
  await f.commands.revalidate(storeActor, run.id);
  assert.equal(
    f.requests("/verify").length,
    sent,
    "verification is not a new effect",
  );
  assert.equal(
    (await f.commands.snapshot(storeActor, run.id)).status,
    "complete",
  );

  // Evidence withdrawn: the node is invalidated and the run reopens.
  behavior.verifyVerified = false;
  await f.commands.revalidate(storeActor, run.id);
  const snapshot = await f.commands.snapshot(storeActor, run.id);
  assert.equal(snapshot.nodes[1]!.verified, false);
  assert.equal(snapshot.nodes[1]!.state, "failed");
  assert.equal(snapshot.status, "active");
});

test("AC-IMP-08 a cyclic workflow never reaches the command service", async (t) => {
  const f = await fixture(t);
  const compilation = f.compile(cyclicSteps110(), "cyclic");
  assert.equal(compilation.status, "blocked");
  assert.equal(compilation.recipe, undefined);
  assert.ok(
    compilation.issues.some(
      (issue) => issue.code === "arazzo.dependency.cycle",
    ),
  );
  assert.deepEqual(
    f.server.requests,
    [],
    "a blocked compilation performs no effect",
  );
  // There is nothing to validate or run: the report is the whole result.
  await assert.rejects(
    validateRecipe(compilation.recipe, f.registry, async () => {
      throw new Error("no child");
    }),
  );
});

test("a blocked compilation of an otherwise valid document yields a report, not a partial run", async (t) => {
  const f = await fixture(t);
  const catalog = storeCatalog(storeActor.tenantId);
  // The host registered only the first operation of the workflow.
  catalog.documents[0]!.operations = [catalog.documents[0]!.operations[0]!];
  const compilation = f.compile(storeWorkflow101(), "connect-store", catalog);
  assert.equal(compilation.status, "blocked");
  assert.equal(compilation.recipe, undefined);
  assert.ok(
    compilation.issues.some(
      (issue) =>
        issue.code === "arazzo.binding.unbound-operation" &&
        issue.sourcePointer === "/workflows/0/steps/1/operationId",
    ),
  );
  // The bound step is still reported as bound, for the reviewer's benefit.
  assert.deepEqual(
    compilation.steps.map((step) => step.stepId),
    ["prepare"],
  );
  assert.deepEqual(f.server.requests, []);
});
