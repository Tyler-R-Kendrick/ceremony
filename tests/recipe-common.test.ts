import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { test, type TestContext } from "node:test";
import { z } from "zod";
import { createGitHubRuntime } from "../src/server/github-runtime.js";
import { SQLiteCeremonyStore } from "../src/server/persistence/index.js";
import type { ActorContext } from "../src/core/operation-contracts.js";
import type { RecipeDefinition } from "../src/core/recipe-contracts.js";
import {
  OperationRegistry,
  NEUTRAL_PROVIDER,
} from "../src/server/recipes/registry.js";
import { validateRecipe } from "../src/server/recipes/index.js";
import {
  commonOperations,
  commonVocabulary,
  consumeInboxVerification,
  readInboxAddress,
} from "../src/server/recipes/common.js";
import { ProtectedCommandService } from "../src/server/commands.js";
import type {
  InboxMessage,
  ProgrammableInbox,
} from "../src/server/authored-inbox.js";
import {
  attachGenericCeremony,
  composeAuthoredMethods,
  newConnectorProject,
} from "../src/core/connector-authoring.js";
import {
  authoredVocabulary,
  recipeFromProject,
} from "../src/server/authored-operations.js";

const actor: ActorContext = {
  tenantId: "tenant",
  subjectId: "alice",
  sessionId: "session",
  actorKind: "human",
  capabilities: ["executor", "author", "reviewer", "publisher"],
};

function store(t: TestContext) {
  const value = new SQLiteCeremonyStore(":memory:", {
    current: "test",
    keys: { test: randomBytes(32) },
  });
  t.after(() => value.close());
  return value;
}

/** Synthetic agent inbox: a fixed address and messages the test delivers. */
function fakeInbox() {
  const address = `agent-${randomBytes(4).toString("hex")}@inbox.example`;
  const messages: InboxMessage[] = [];
  let provisions = 0;
  const inbox: ProgrammableInbox = {
    provision: async () => {
      provisions++;
      return address;
    },
    latest: async (to, since) =>
      messages
        .filter((message) => message.to === to && message.at >= since)
        .sort((a, b) => b.at - a.at)[0],
  };
  return {
    inbox,
    address,
    deliver: (text: string) =>
      messages.push({ to: address, subject: "Verify", text, at: Date.now() }),
    provisions: () => provisions,
  };
}

function runtime(t: TestContext, inbox?: ProgrammableInbox) {
  return createGitHubRuntime({
    store: store(t),
    identity: { authenticate: async () => actor },
    origin: "https://app.example",
    environment: "test",
    configurationVersion: "v1",
    stripe: { configuration: async () => ({ version: "v1" }) },
    ...(inbox ? { inbox } : {}),
    allowTarget: async () => true,
    authorize: async (subject, run) => subject.subjectId === run.subjectId,
  });
}

const inboxRecipe: RecipeDefinition = {
  schemaVersion: 1,
  id: "agent-inbox-verification",
  title: "Receive a verification email",
  description: "Provision an agent inbox and wait for a code or link.",
  inputs: {},
  invocations: [
    {
      id: "inbox",
      use: { kind: "operation", ...commonOperations.provisionInbox },
      dependsOn: [],
      bindings: {},
    },
    {
      id: "code",
      use: { kind: "operation", ...commonOperations.awaitInboxVerification },
      dependsOn: ["inbox"],
      bindings: {
        inbox: { from: "output", node: "inbox", name: "inbox" },
        linkHost: { from: "literal", value: "provider.example" },
      },
    },
  ],
  outputs: { verification: { node: "code", name: "verification" } },
};

async function advance(
  r: ReturnType<typeof runtime>,
  runId: string,
  nodeId: string,
) {
  const run = await r.commands.snapshot(actor, runId);
  return r.commands.advance(
    actor,
    runId,
    nodeId,
    run.revision,
    `step:${randomUUID()}`,
  );
}

test("an account request for a connector whose runs cannot register an account fails clearly, not as a denied run", async (t) => {
  const r = runtime(t);
  await assert.rejects(r.connect(actor, "stripe", true, "alice@example.com"), {
    message: "account-registration-unsupported",
  });
  // Nothing was created that a later reuse lookup could pick up.
  const runs = await r.store.transaction((tx) =>
    tx.list(actor.tenantId, "run", 10),
  );
  assert.equal(runs.length, 0);
});

test("only registerNeutral registers a provider-neutral operation, and only over neutral vocabulary", () => {
  const registry = new OperationRegistry(
    new Map([
      ...commonVocabulary,
      [
        "stripe.credential",
        {
          schema: z.string(),
          classification: "artifact" as const,
          provider: "stripe",
          profile: "stripe-api-key",
        },
      ],
    ]),
  );
  const operation = (
    provider: string,
    profile: string,
    outputs: Record<string, { contract: string; required: boolean }>,
  ) => ({
    contract: {
      id: `probe.${randomBytes(4).toString("hex")}`,
      version: "1.0.0",
      provider,
      profile,
      inputs: {},
      outputs,
      effects: ["probe"],
      verifier: "probe",
      humanFallback: "none",
    },
    inputSchema: z.strictObject({}),
    outputSchema: z.strictObject({}),
    classifications: {},
    fixtures: ["probe"],
    handler: async () => ({ state: "complete" as const, outputs: {} }),
    verify: async () => true,
  });
  const inbox = { inbox: { contract: "common.inbox", required: true } };
  assert.throws(
    () =>
      registry.register(operation(NEUTRAL_PROVIDER, NEUTRAL_PROVIDER, inbox)),
    /registerNeutral/,
  );
  assert.throws(
    () => registry.register(operation(NEUTRAL_PROVIDER, "stripe-api-key", {})),
    /registerNeutral/,
  );
  assert.throws(
    () => registry.registerNeutral(operation("stripe", "stripe-api-key", {})),
    /registerNeutral/,
  );
  // A neutral step can neither consume nor mint a provider artifact.
  assert.throws(
    () =>
      registry.registerNeutral(
        operation(NEUTRAL_PROVIDER, NEUTRAL_PROVIDER, {
          credential: { contract: "stripe.credential", required: true },
        }),
      ),
    /neutral vocabulary/,
  );
  const accepted = operation(NEUTRAL_PROVIDER, NEUTRAL_PROVIDER, inbox);
  registry.registerNeutral(accepted);
  assert.equal(registry.isNeutral(accepted.contract.id, "1.0.0"), true);
  const provider = operation("stripe", "stripe-api-key", {});
  registry.register(provider);
  assert.equal(registry.isNeutral(provider.contract.id, "1.0.0"), false);
});

test("a run admits a neutral step under any provider but still denies a foreign provider's operation", async (t) => {
  const r = runtime(t, fakeInbox().inbox);
  const stripe = await r.executeRecipe(actor, inboxRecipe, {}, "stripe");
  assert.equal(stripe.provider, "stripe");
  assert.deepEqual(
    stripe.nodes.map((node) => node.operationId),
    [
      commonOperations.provisionInbox.id,
      commonOperations.awaitInboxVerification.id,
    ],
  );
  const context = await r.commands.snapshot(actor, stripe.id);
  const runContext = {
    provider: context.provider,
    profile: context.profile,
    target: "self",
    origin: "https://app.example",
    environment: "test",
    configurationVersion: "v1",
  };
  const node = (operationId: string) => ({
    id: "step",
    operationId,
    operationVersion: "1.0.0",
    dependsOn: [],
    bindings: {},
  });
  for (const smuggled of [
    "github.prepare-app",
    "authored.register-account",
    "authored.prepare-app",
  ])
    await assert.rejects(
      r.commands.createRun(actor, runContext, [node(smuggled)], {}),
      /denied/,
    );
  assert.equal(
    r.commands.admits(runContext, "stripe.verify-access", "1.0.0"),
    true,
  );
  assert.equal(
    r.commands.admits(runContext, commonOperations.provisionInbox.id, "1.0.0"),
    true,
  );
  // The existing scoped bootstrap is unchanged: GitHub App runs may register first.
  assert.equal(
    r.commands.admits(
      { provider: "github", profile: "github-app" },
      "authored.register-account",
      "1.0.0",
    ),
    true,
  );
});

test("inbox steps carry only opaque run-bound handles; the address, code and link stay server-side", async (t) => {
  const mail = fakeInbox();
  const r = runtime(t, mail.inbox);
  const run = await r.executeRecipe(actor, inboxRecipe, {}, "stripe");
  const provisioned = await advance(r, run.id, "inbox");
  assert.equal(provisioned.state, "complete");
  assert.equal(provisioned.verified, true);
  // Nothing has arrived: the step stays open instead of failing.
  const waiting = await advance(r, run.id, "code");
  assert.equal(waiting.state, "verifying");
  const code = String(100000 + (randomBytes(3).readUIntBE(0, 3) % 900000));
  const link = `https://provider.example/verify?token=${randomBytes(12).toString("hex")}`;
  mail.deliver(`Your verification code is ${code}. Or open ${link}`);
  const received = await advance(r, run.id, "code");
  assert.equal(received.state, "complete");
  assert.equal(received.verified, true);
  assert.equal(mail.provisions(), 1);

  const nodes = await r.store.transaction(async (tx) => ({
    inbox: await tx.get<{ outputs: Record<string, string> }>({
      tenant: actor.tenantId,
      kind: "node",
      id: `${run.id}:inbox`,
    }),
    code: await tx.get<{ outputs: Record<string, string> }>({
      tenant: actor.tenantId,
      kind: "node",
      id: `${run.id}:code`,
    }),
  }));
  const inboxHandle = nodes.inbox!.value.outputs.inbox!;
  const verificationHandle = nodes.code!.value.outputs.verification!;
  assert.match(inboxHandle, /^common-inbox-[a-f0-9]{32}$/);
  assert.match(verificationHandle, /^common-verification-[a-f0-9]{32}$/);

  // Snapshots, run/node records and audit events never carry the secrets.
  const snapshot = await r.commands.snapshot(actor, run.id);
  const visible = await r.store.transaction(async (tx) =>
    JSON.stringify([
      snapshot,
      ...(await tx.list(actor.tenantId, "run", 100)),
      ...(await tx.list(actor.tenantId, "node", 100)),
      ...(await tx.list(actor.tenantId, "audit", 100)),
      ...(await tx.list(actor.tenantId, "event", 100)),
      ...(await tx.list(actor.tenantId, "command", 100)),
      ...(await tx.list(actor.tenantId, "effect", 100)),
    ]),
  );
  for (const secret of [mail.address, code, link, "provider.example/verify"])
    assert.equal(visible.includes(secret), false, "secret escaped");
  // Handles live in node outputs only; snapshots and audit events omit them.
  const projected = await r.store.transaction(async (tx) =>
    JSON.stringify([
      snapshot,
      ...(await tx.list(actor.tenantId, "audit", 100)),
      ...(await tx.list(actor.tenantId, "event", 100)),
    ]),
  );
  for (const handle of [inboxHandle, verificationHandle])
    assert.equal(projected.includes(handle), false, "handle escaped");

  // Handles resolve only for the run that minted them, and a code is single use.
  const other = await r.executeRecipe(actor, inboxRecipe, {}, "stripe");
  assert.equal(
    await readInboxAddress(r.store, { actor, runId: other.id }, inboxHandle),
    undefined,
  );
  assert.equal(
    await consumeInboxVerification(
      r.store,
      { actor, runId: other.id },
      verificationHandle,
    ),
    undefined,
  );
  assert.equal(
    await readInboxAddress(r.store, { actor, runId: run.id }, inboxHandle),
    mail.address,
  );
  assert.deepEqual(
    await consumeInboxVerification(
      r.store,
      { actor, runId: run.id },
      verificationHandle,
    ),
    { code, link },
  );
  assert.equal(
    await consumeInboxVerification(
      r.store,
      { actor, runId: run.id },
      verificationHandle,
    ),
    undefined,
  );
});

test("inbox steps without a configured inbox report unavailable rather than waiting", async (t) => {
  const r = runtime(t);
  const run = await r.executeRecipe(actor, inboxRecipe, {}, "stripe");
  const result = await advance(r, run.id, "inbox");
  assert.equal(result.state, "failed");
  assert.equal(result.verified, false);
});

function composedProject() {
  const project = newConnectorProject();
  project.manifest.id = "acme";
  project.manifest.name = "Acme";
  const register = attachGenericCeremony(
    project,
    "account-registration",
    "Register",
  );
  const oauth = attachGenericCeremony(project, "oauth-code", "Sign in");
  const key = attachGenericCeremony(project, "api-key", "API key");
  const parent = composeAuthoredMethods(project, [register.id, oauth.id]);
  return { project, register, oauth, key, parent };
}

test("install derives a composed recipe that runs each child in order and validates", async (t) => {
  const { project, register, oauth } = composedProject();
  const definition = recipeFromProject(project);
  assert.deepEqual(
    definition.invocations.map((node) => [
      node.id,
      node.use.id,
      node.dependsOn,
    ]),
    [
      [`${register.id}.account`, "authored.register-account", []],
      [`${oauth.id}.app`, "authored.prepare-app", [`${register.id}.account`]],
      [`${oauth.id}.user`, "authored.authorize-user", [`${oauth.id}.app`]],
      [`${oauth.id}.access`, "authored.verify-access", [`${oauth.id}.user`]],
    ],
  );
  assert.deepEqual(definition.outputs, {
    connection: { node: `${oauth.id}.access`, name: "connection" },
  });
  const r = runtime(t);
  const checked = await validateRecipe(definition, r.registry, async () => {
    throw new Error("no child recipes");
  });
  assert.deepEqual(checked.diagnostics, []);

  // The installed connector runs the composition, not a fixed template.
  const connectorId = await r.authoring.install(actor, project);
  // The parent shares its first child's family without a duplicate method ID.
  assert.deepEqual(
    (await r.authoring.getInstalled(actor, connectorId))!.manifest.methods.map(
      (method) => method.id,
    ),
    [
      "account-registration",
      "oauth-code",
      "api-key",
      `account-registration-${project.manifest.methods[3]!.id}`,
    ],
  );
  const run = await r.connect(actor, connectorId);
  assert.equal(run.profile, "authored");
  assert.deepEqual(
    run.nodes.map((node) => node.id),
    definition.invocations.map((node) => node.id),
  );
  // A later child cannot start before the earlier child is verified.
  await assert.rejects(advance(r, run.id, `${oauth.id}.app`), /denied/);
  assert.equal(
    (await advance(r, run.id, `${register.id}.account`)).state,
    "awaiting-human",
  );
});

test("a composed recipe executes end to end through the command service", async (t) => {
  const { project } = composedProject();
  const definition = recipeFromProject(project);
  // Fixture handlers with the authored contracts: every step completes and verifies.
  const registry = new OperationRegistry(authoredVocabulary);
  const executed: string[] = [];
  const outputs: Record<string, string> = {
    "authored.register-account": "connection",
    "authored.prepare-app": "app",
    "authored.authorize-user": "session",
    "authored.collect-credential": "session",
    "authored.verify-access": "connection",
  };
  const inputs: Record<string, string[]> = {
    "authored.authorize-user": ["app"],
    "authored.verify-access": ["session"],
  };
  for (const [id, output] of Object.entries(outputs))
    registry.register({
      contract: {
        id,
        version: "1.0.0",
        provider: "authored",
        profile: "authored",
        inputs: Object.fromEntries(
          (inputs[id] ?? []).map((name) => [
            name,
            { contract: `authored.${name}`, required: true },
          ]),
        ),
        outputs: {
          [output]: { contract: `authored.${output}`, required: true },
        },
        effects: [id],
        verifier: "authored.verify-access",
        humanFallback: "authored.own-browser",
      },
      inputSchema: z.record(z.string(), z.string()),
      outputSchema: z.record(z.string(), z.string()),
      classifications: {},
      fixtures: ["tests/recipe-common.test.ts"],
      handler: async (context) => {
        executed.push(context.nodeId);
        return {
          state: "complete",
          outputs: { [output]: `authored-${output}-fixture` },
        };
      },
      verify: async () => true,
    });
  const checked = await validateRecipe(definition, registry, async () => {
    throw new Error("no child recipes");
  });
  assert.deepEqual(checked.diagnostics, []);
  const commands = new ProtectedCommandService(
    store(t),
    registry,
    async () => true,
  );
  let run = await commands.createRun(
    actor,
    {
      provider: "acme",
      profile: "authored",
      target: "acme",
      origin: "https://app.example",
      environment: "test",
      configurationVersion: "v1",
    },
    checked.leaves.map((leaf) => ({
      id: leaf.id,
      operationId: leaf.use.id,
      operationVersion: leaf.use.version,
      dependsOn: leaf.dependsOn,
      bindings: leaf.bindings,
    })),
    {},
  );
  for (const leaf of checked.leaves) {
    const result = await commands.advance(
      actor,
      run.id,
      leaf.id,
      run.revision,
      `step:${randomUUID()}`,
    );
    assert.equal(result.verified, true);
    run = await commands.snapshot(actor, run.id);
  }
  assert.equal(run.status, "complete");
  assert.deepEqual(
    executed,
    checked.leaves.map((leaf) => leaf.id),
  );
});

test("a composition that names itself is refused rather than expanded", () => {
  const { project, parent, key } = composedProject();
  parent.contract!.prerequisites.push({
    ...parent.contract!.prerequisites[0]!,
    id: key.id,
  });
  // Make the API-key child depend on the composed parent: a cycle.
  key.contract!.prerequisites = [
    { ...parent.contract!.prerequisites[0]!, id: parent.id },
  ];
  assert.throws(() => recipeFromProject(project), /cannot include itself/);
});
