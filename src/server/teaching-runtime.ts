import { randomUUID } from "node:crypto";
import type { ActorContext } from "../core/operation-contracts.js";
import {
  ProtectedCommandService,
  deliverContinuations,
  type RunContext,
  type RunRecord,
} from "./commands.js";
import { Demonstrations } from "./demonstrations.js";
import { RecipeService, type OperationRegistry } from "./recipes/index.js";
import type {
  AsyncCeremonyStore,
  AsyncTransaction,
} from "./persistence/index.js";
import {
  AuthorizationError,
  requireCapability,
  type HostIdentityAdapter,
} from "./identity.js";
import { AgentCoordinator } from "./agent/coordinator.js";
import { configuredModel, type ModelConfiguration } from "./agent/model.js";
import type { RecipeDefinition } from "../core/recipe-contracts.js";

export const githubConnectionRecipe: RecipeDefinition = {
  schemaVersion: 1,
  id: "github-connect",
  title: "Connect GitHub",
  description:
    "Reuse or prepare an app, obtain installation consent, and verify access.",
  inputs: {},
  invocations: [
    {
      id: "app",
      use: { kind: "operation", id: "github.prepare-app", version: "1.0.0" },
      dependsOn: [],
      bindings: {},
    },
    {
      id: "installation",
      use: {
        kind: "operation",
        id: "github.authorize-installation",
        version: "1.0.0",
      },
      dependsOn: ["app"],
      bindings: { app: { from: "output", node: "app", name: "app" } },
    },
    {
      id: "access",
      use: { kind: "operation", id: "github.verify-access", version: "1.0.0" },
      dependsOn: ["installation"],
      bindings: {
        installation: {
          from: "output",
          node: "installation",
          name: "installation",
        },
      },
    },
  ],
  outputs: { connection: { node: "access", name: "connection" } },
};

export interface TeachingRuntimeOptions {
  store: AsyncCeremonyStore;
  identity: HostIdentityAdapter;
  registry: OperationRegistry;
  origin: string;
  modelConfiguration?: ModelConfiguration;
  /** Trusted host registrations, never supplied by a tool or imported recipe. */
  connections?: ReadonlyMap<
    string,
    {
      definition: RecipeDefinition;
      outputContract: string;
      revalidateOperation: string;
    }
  >;
  context(actor: ActorContext, connectorId: string): Promise<RunContext>;
  selectTarget?: (actor: ActorContext, target: string) => Promise<void>;
  authorize(
    actor: ActorContext,
    run: RunRecord,
    operationId: string,
  ): Promise<boolean>;
  /** Authenticated human route handler; never passed into model context. */
  human?: (
    actor: ActorContext,
    runId: string,
    request: Request,
  ) => Promise<Response>;
  humanReturn?: (actor: ActorContext, request: Request) => Promise<Response>;
  cancel?: (actor: ActorContext, runId: string) => Promise<void>;
  /** Trusted original host task, never selected by a browser/tool argument. Consumer deduplicates deliveryId. */
  continuation?: {
    id: string;
    handler(input: { runId: string; deliveryId: string }): Promise<void>;
  };
}
export function createTeachingRuntime(options: TeachingRuntimeOptions) {
  const { store, registry, identity, origin } = options;
  const connections = new Map(
    options.connections ?? [
      [
        "github",
        {
          definition: githubConnectionRecipe,
          outputContract: "github.connection",
          revalidateOperation: "github.verify-access",
        },
      ],
    ],
  );
  function connection(connectorId: string) {
    const registered = connections.get(connectorId);
    if (!registered) throw new AuthorizationError("invalid_request");
    return registered;
  }
  const commands = new ProtectedCommandService(
    store,
    registry,
    async (actor, run, operationId, tx) => {
      // Host policy may perform I/O: never invoke it while holding relational locks.
      // The command service checks it immediately before this transactional guard.
      if (!tx && !(await options.authorize(actor, run, operationId)))
        return false;
      if (actor.actorKind !== "agent") return true;
      const check = async (transaction: AsyncTransaction) => {
        const delegation = await transaction.get<{
          actor: ActorContext;
          runId: string;
          expiresAt: number;
          revoked: boolean;
        }>({ tenant: "workload", kind: "session", id: run.id });
        const budget = await transaction.get<{ stopped: boolean }>({
          tenant: actor.tenantId,
          kind: "budget",
          id: `agent:${run.id}`,
        });
        return Boolean(
          delegation &&
          !delegation.value.revoked &&
          delegation.value.expiresAt > (await transaction.now()) &&
          delegation.value.runId === run.id &&
          delegation.value.actor.tenantId === actor.tenantId &&
          delegation.value.actor.subjectId === actor.subjectId &&
          delegation.value.actor.sessionId === actor.sessionId &&
          !budget?.value.stopped,
        );
      };
      return tx ? check(tx) : store.transaction(check);
    },
  );
  const recipes = new RecipeService(store, registry);
  const demonstrations = new Demonstrations(store);
  const modelConfiguration = options.modelConfiguration ?? {};
  const agent = new AgentCoordinator(
    store,
    commands,
    configuredModel(modelConfiguration),
  );
  async function executeRecipe(
    actor: ActorContext,
    definition: RecipeDefinition,
    inputs: Record<string, unknown>,
    connectorId: string,
  ) {
    connection(connectorId);
    const checked = await recipes.preview(actor, definition);
    if (checked.diagnostics.length)
      throw new AuthorizationError("invalid_request");
    for (const [name, value] of Object.entries(inputs)) {
      const contract = definition.inputs[name];
      const vocabulary = contract && registry.vocabulary.get(contract.contract);
      // HTTP callers may bind only explicitly public slots; protected artifacts are host-resolved.
      if (
        !vocabulary ||
        vocabulary.classification !== "public" ||
        !vocabulary.schema.safeParse(value).success
      )
        throw new AuthorizationError("denied");
    }
    const nodes = checked.leaves.map((n) => ({
      id: n.id,
      operationId: n.use.id,
      operationVersion: n.use.version,
      dependsOn: n.dependsOn,
      bindings: n.bindings,
    }));
    return commands.createRun(
      actor,
      await options.context(actor, connectorId),
      nodes,
      inputs,
      options.continuation?.id,
    );
  }
  async function connect(
    actor: ActorContext,
    connectorId: string,
    fresh = true,
  ) {
    requireCapability(actor, "executor");
    const registered = connection(connectorId);
    const context = await options.context(actor, connectorId);
    // Reuse requires the entire authorization context, not just a connector name.
    const existing = await store.transaction(async (tx) => {
      let after = "";
      for (;;) {
        const page = await tx.list<RunRecord>(
          actor.tenantId,
          "run",
          1000,
          after,
        );
        const match = page.find(
          (r) =>
            r.value.subjectId === actor.subjectId &&
            r.value.continuation === options.continuation?.id &&
            r.value.status !== "cancelled" &&
            Object.entries(context).every(
              ([k, v]) => Reflect.get(r.value, k) === v,
            ),
        );
        if (match || page.length < 1000) return match;
        after = page.at(-1)!.id;
      }
    });
    if (
      existing &&
      (await options.authorize(
        actor,
        existing.value,
        registered.revalidateOperation,
      ))
    )
      return fresh
        ? commands.revalidate(actor, existing.id)
        : commands.snapshot(actor, existing.id);
    const selected = await recipes.selectConnection(actor, {
      provider: context.provider,
      profile: context.profile,
      outputContract: registered.outputContract,
    });
    return executeRecipe(
      actor,
      selected ?? registered.definition,
      {},
      connectorId,
    );
  }
  async function flushContinuations(actor: ActorContext): Promise<void> {
    if (!options.continuation) return;
    const continuation = options.continuation;
    await deliverContinuations(
      store,
      actor,
      new Map([
        [
          continuation.id,
          async (input) => {
            const record = await store.transaction((tx) =>
              tx.get<RunRecord>({
                tenant: actor.tenantId,
                kind: "run",
                id: input.runId,
              }),
            );
            if (
              !record ||
              record.value.subjectId !== actor.subjectId ||
              record.value.status !== "complete" ||
              record.value.continuation !== continuation.id ||
              !(await options.authorize(actor, record.value, "continuation"))
            )
              throw new AuthorizationError("denied");
            await continuation.handler(input);
          },
        ],
      ]),
    );
  }
  async function delegate(actor: ActorContext, runId: string) {
    requireCapability(actor, "executor");
    await commands.snapshot(actor, runId);
    const initial = await store.transaction((tx) =>
      tx.get<RunRecord>({ tenant: actor.tenantId, kind: "run", id: runId }),
    );
    if (
      !initial ||
      initial.value.status === "cancelled" ||
      !(await options.authorize(actor, initial.value, "agent"))
    )
      throw new AuthorizationError("denied");
    const id = `turn:${randomUUID()}`;
    await store.transaction(async (tx) => {
      const run = await tx.get<RunRecord>({
        tenant: actor.tenantId,
        kind: "run",
        id: runId,
      });
      const budget = await tx.get<{ stopped: boolean }>({
        tenant: actor.tenantId,
        kind: "budget",
        id: `agent:${runId}`,
      });
      if (
        !run ||
        run.value.subjectId !== actor.subjectId ||
        run.value.status === "cancelled" ||
        run.revision !== initial.revision ||
        budget?.value.stopped
      )
        throw new AuthorizationError("denied");
      const recordKey = {
        tenant: "workload",
        kind: "session" as const,
        id: runId,
      };
      const existing = await tx.get(recordKey);
      await tx.put(
        recordKey,
        { actor, runId, expiresAt: (await tx.now()) + 3600000, revoked: false },
        existing?.revision ?? null,
      );
    });
    return id;
  }
  async function agentActor(runId: string) {
    const delegation = await store.transaction(async (tx) => {
      const record = await tx.get<{
        actor: ActorContext;
        runId: string;
        expiresAt: number;
        revoked: boolean;
      }>({ tenant: "workload", kind: "session", id: runId });
      if (
        !record ||
        record.value.revoked ||
        record.value.expiresAt <= (await tx.now())
      )
        throw new AuthorizationError("denied");
      return record.value;
    });
    const run = await store.transaction((tx) =>
      tx.get<RunRecord>({
        tenant: delegation.actor.tenantId,
        kind: "run",
        id: runId,
      }),
    );
    if (
      !run ||
      !(await options.authorize(delegation.actor, run.value, "agent"))
    )
      throw new AuthorizationError("denied");
    return { ...delegation.actor, actorKind: "agent" as const };
  }
  async function connectForAgent(actor: ActorContext, connectorId: string) {
    const selected = await connect(actor, connectorId, false);
    await delegate(actor, selected.id);
    const delegated = await agentActor(selected.id);
    const run = await commands.revalidate(delegated, selected.id);
    return { run, actor: delegated };
  }
  return {
    store,
    registry,
    identity,
    origin,
    connectors: Object.freeze([...connections.keys()]),
    commands,
    recipes,
    demonstrations,
    agent,
    modelConfiguration,
    connect,
    connectForAgent,
    executeRecipe,
    delegate,
    agentActor,
    human: options.human,
    humanReturn: options.humanReturn,
    cancel: options.cancel,
    selectTarget: options.selectTarget,
    flushContinuations,
  };
}
export type TeachingRuntime = ReturnType<typeof createTeachingRuntime>;
