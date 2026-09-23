import { randomBytes, randomUUID } from "node:crypto";
import { z } from "zod";
import type { ActorContext } from "../../src/core/operation-contracts.js";
import type { RecipeDefinition } from "../../src/core/recipe-contracts.js";
import {
  runCeremony,
  type CeremonyResult,
} from "../../src/server/browser-driver.js";
import {
  createHeuristicInterpreter,
  type InterpreterInput,
} from "../../src/server/browser-interpreter.js";
import type { RunContext, RunRecord } from "../../src/server/commands.js";
import { AuthorizationError } from "../../src/server/identity.js";
import { SQLiteCeremonyStore } from "../../src/server/persistence/index.js";
import {
  commonVocabulary,
  mintOAuthClient,
  readOAuthClient,
} from "../../src/server/recipes/common.js";
import {
  OperationRegistry,
  type OperationContext,
  type OperationResult,
  type VocabularyEntry,
} from "../../src/server/recipes/registry.js";
import { createTeachingRuntime } from "../../src/server/teaching-runtime.js";
import {
  configureSignIn,
  issuedAtA,
  registrationPlan,
  signInPlan,
  startChainProviders,
} from "../../tests/doubles/auth-provider/two-provider-chain.js";
import { caption, type Phase } from "./captions.js";
import { pathnameOf } from "./phases.js";
import type { DemoSession } from "./harness.js";
import { disclosure, outcomeFacts } from "./story.js";

/**
 * One run across two providers: an OAuth app registered at A is what signs a
 * person in to B.
 *
 * This is the teaching runtime's own run, not a script of three ceremonies.
 * A composed recipe places step 1 under connector `alpha` and steps 2 and 3
 * under connector `beta`; each step is admitted and authorized in its own
 * connector's context, and the only thing that crosses from alpha to beta is
 * the run-bound `common.oauth-client` handle. The chain position on screen
 * advances when the command service advances a node, never on a timer.
 *
 * Step 1 runs in the browser at A (Northwind Cloud's developer settings): the
 * driver reads the issued client ID and secret from the fields the plan names
 * and hands them straight to `mintOAuthClient`, so neither reaches a
 * snapshot, the interpreter or a caption. The page itself shows the secret in
 * a read-only field, so the video boxes that field out; the page is not
 * touched. Step 2 is server side at B: the handle is resolved for this run
 * and saved through B's admin API, which checks it with A. Step 3 runs in the
 * browser at B: "Continue with Northwind Cloud", sign in at A, allow B's
 * registered app, back at B signed in.
 *
 * Both providers are local doubles with a strict client registry at A; every
 * credential is synthetic. Mirrors `tests/two-provider-chain.test.ts`.
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

/** The run's nodes, the phase each is shown as, and its connector. */
const nodes: readonly { id: string; phase: Phase; connector: string }[] = [
  { id: "app.register", phase: "a-register-app", connector: "alpha" },
  { id: "workspace.configure", phase: "b-configure", connector: "beta" },
  { id: "workspace.sign-in", phase: "b-sign-in", connector: "beta" },
];

export async function record(session: DemoSession) {
  const chain = await startChainProviders();
  const store = new SQLiteCeremonyStore(":memory:", {
    current: "key",
    keys: { key: randomBytes(32) },
  });
  session.protect(chain.account.password);
  try {
    await session.card(
      {
        title: session.entry.title,
        lines: [
          session.entry.summary,
          ...disclosure(session.entry, chain.a.markup.seed),
          "One run, three steps, each authorized under its own connector: alpha (Northwind Cloud), then beta (Globex Workspace). Only the run-bound client handle crosses between them.",
          "Northwind's page shows the new client secret in a read-only field; this video boxes it out. The page itself is unchanged.",
        ],
      },
      12_000,
    );

    const registry = new OperationRegistry(
      new Map<string, VocabularyEntry>([
        ...commonVocabulary,
        ["beta.integration", publicContract("beta", "beta-workspace")],
        ["beta.session", publicContract("beta", "beta-workspace")],
      ]),
    );
    const interpreted: InterpreterInput[] = [];
    const transcripts: CeremonyResult[] = [];
    const seen: { operation: string; provider: string; target: string }[] = [];
    const minted: string[] = [];
    const kept: { clientId: string; clientSecret?: string }[] = [];

    /** One browser step, driven by the production heuristic, on camera. */
    const browse = async (
      plan: ReturnType<typeof signInPlan>,
      phase: Phase,
      keep?: (values: Record<string, string | undefined>) => Promise<void>,
    ) => {
      // Each browser step starts from an empty browser, as a person's would
      // on a different day: no session at A carries over from step 1.
      await session.page.context().clearCookies();
      await session.page.goto(plan.entryUrl, { waitUntil: "domcontentloaded" });
      const heuristic = createHeuristicInterpreter();
      const { entryUrl: _entry, ...rest } = plan;
      const narrated = session.narrate(
        async (input) => {
          interpreted.push(structuredClone(input));
          return heuristic(input);
        },
        {
          sources: {
            username: "private-collector",
            password: "private-collector",
          },
          // The chain position stays on this step; A's consent screen is
          // still named as consent so its button is captioned as approval.
          phase: (_previous, observed) =>
            observed.pathname === "/authorize" ? "consent" : phase,
        },
      );
      let consentShown = false;
      const result = await runCeremony({
        ...rest,
        page: session.ceremonyPage(),
        // A's consent screen names B's registered app; it holds on screen
        // with its buttons in view before the agent allows it.
        interpreter: async (input) => {
          const atConsent =
            !consentShown && pathnameOf(input.snapshot.path) === "/authorize";
          if (atConsent) {
            session.say({ kind: "provider", says: "consent-screen" });
            await session.reveal();
            await session.hold(1_800);
          }
          const action = await narrated(input);
          if (atConsent) {
            consentShown = true;
            session.poster();
            await session.hold(1_200);
          }
          return action;
        },
        onApplied: session.applied,
        ...(keep
          ? {
              issued: {
                fields: issuedAtA,
                keep: async (values) => keep(values),
              },
            }
          : {}),
      });
      session.checkFills(result);
      transcripts.push(result);
      await session.park();
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
        values: Record<string, unknown>,
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
        fixtures: ["scripts/demos/chain-two-providers.ts"],
        handler: async (context, values) => {
          seen.push({
            operation: id,
            provider: context.provider ?? "",
            target: context.target,
          });
          return handler(context, values);
        },
        verify,
      });

    register(
      "alpha.register-oauth-app",
      "alpha",
      "alpha-developer",
      {},
      { client: "common.oauth-client" },
      async (context) => {
        let handle: string | undefined;
        session.redact("#oauth-app-client-secret");
        const result = await browse(
          registrationPlan(chain),
          "a-register-app",
          async (values) => {
            const clientId = values["client-id"]!;
            const clientSecret = values["client-secret"];
            session.protect(clientId);
            if (clientSecret) session.protect(clientSecret);
            kept.push({ clientId, ...(clientSecret ? { clientSecret } : {}) });
            handle = await mintOAuthClient(store, context, {
              clientId,
              ...(clientSecret ? { clientSecret } : {}),
            });
            session.protect(handle);
            session.say({ kind: "connector", stage: "secret-kept" });
            await session.hold(2_400);
          },
        );
        await session.hold(1_200);
        if (result.status !== "completed" || !handle)
          return failed("unavailable");
        minted.push(handle);
        return { state: "complete", outputs: { client: handle } };
      },
      async (context, result) =>
        Boolean(await readOAuthClient(store, context, result.outputs.client)),
    );
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
    register(
      "beta.sign-in-with-alpha",
      "beta",
      "beta-workspace",
      { integration: "beta.integration" },
      { session: "beta.session" },
      async () => {
        const result = await browse(signInPlan(chain), "b-sign-in");
        return result.status === "completed"
          ? { state: "complete", outputs: { session: "signed-in" } }
          : failed("unavailable");
      },
      async () => chain.b.signIns().includes(chain.account.email),
    );

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
    const authorizations: { operation: string; connector?: string }[] = [];
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
          ...(run.scope ? { connector: run.scope.connectorId } : {}),
        });
        return who.subjectId === run.subjectId;
      },
    });
    const publish = async (definition: RecipeDefinition) => {
      const draft = await runtime.recipes.createDraft(actor, definition);
      await runtime.recipes.review(
        actor,
        draft.id,
        draft.revision,
        draft.digest,
      );
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
    };
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
          bindings: {
            client: { from: "output", node: "app", name: "client" },
          },
        },
      ],
      outputs: { session: { node: "workspace", name: "session" } },
    };

    const run = await runtime.executeRecipe(actor, chained, {}, "alpha");
    const results: unknown[] = [];
    const states: { node: string; state: string; verified: boolean }[] = [];
    for (const node of nodes) {
      session.step(node.phase);
      if (node.id === "workspace.configure")
        await session.card(
          {
            title: "Step 2 · server side at Globex (beta context)",
            tone: "connector",
            keepPanel: true,
            lines: [
              "The handle is resolved for this run only, then sent to Globex's admin API.",
              "Globex checks the client with Northwind before saving it.",
            ],
          },
          3_500,
        );
      const snapshot = await runtime.commands.snapshot(actor, run.id);
      const advanced = await runtime.commands.advance(
        actor,
        run.id,
        node.id,
        snapshot.revision,
        `command:${randomUUID()}`,
      );
      results.push(advanced);
      states.push({
        node: node.id,
        state: advanced.state,
        verified: advanced.verified === true,
      });
      if (advanced.state !== "complete" || advanced.verified !== true) break;
      if (node.id === "workspace.configure") {
        session.say({ kind: "connector", stage: "b-checked-client" });
        await session.card(
          {
            title: "Step 2 · server side at Globex (beta context)",
            tone: "connector",
            keepPanel: true,
            lines: [
              "The handle is resolved for this run only, then sent to Globex's admin API.",
              "Globex checks the client with Northwind before saving it.",
              caption({ kind: "connector", stage: "b-checked-client" }),
            ],
          },
          3_000,
        );
      }
    }
    const finalSnapshot = await runtime.commands.snapshot(actor, run.id);

    // The same canary the chain's test holds: nothing a model, a person
    // reading the run or a caller of the command service is handed carries
    // the secret, the client ID, the handle or the password.
    const visible = JSON.stringify([
      interpreted,
      transcripts,
      results,
      finalSnapshot,
      run,
    ]);
    const secrets = [
      ...kept.flatMap((client) => [client.clientId, client.clientSecret ?? ""]),
      ...minted,
      chain.account.password,
    ].filter(Boolean);
    const canaryClean = secrets.every((value) => !visible.includes(value));
    const perStep = seen.map(
      (step) =>
        `${step.operation} ran in connector ${step.provider} (target ${step.target})`,
    );
    const complete =
      states.length === nodes.length &&
      states.every((step) => step.state === "complete" && step.verified) &&
      finalSnapshot.status === "complete" &&
      chain.b.signIns().includes(chain.account.email) &&
      canaryClean;
    if (complete) {
      session.panel({
        kind: "chain",
        chain: session.entry.chain!,
        current: session.entry.chain!.at(-1)!,
        finished: true,
      });
      session.say({ kind: "connector", stage: "b-signed-in" });
      await session.hold(2_400);
    }
    await session.card(
      {
        title: complete
          ? "One run, two providers, each step in its own context"
          : "The two-provider run did not finish",
        tone: "result",
        lines: [
          ...(transcripts.at(-1) ? outcomeFacts(transcripts.at(-1)!) : []),
          ...perStep,
          ...(complete
            ? [
                caption({ kind: "connector", stage: "b-signed-in" }),
                "Canary: the secret, client ID, handle and password appear in no snapshot, transcript, command result or run record ✓",
              ]
            : []),
        ],
      },
      8_000,
    );
    return complete && transcripts.at(-1)
      ? { ok: true, result: transcripts.at(-1)! }
      : { ok: false };
  } finally {
    store.close();
    await chain.close();
  }
}
