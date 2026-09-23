import { randomUUID } from "node:crypto";
import { loopbackAuthFetch, publicAuthFetch } from "./public-auth-fetch.js";
import type { ActorContext } from "../core/operation-contracts.js";
import {
  ProtectedCommandService,
  deliverContinuations,
  type NodeContext,
  type RunContext,
  type RunPlanNode,
  type RunRecord,
} from "./commands.js";
import { Demonstrations } from "./demonstrations.js";
import { RecipeService, type OperationRegistry } from "./recipes/index.js";
import { ConnectorDrafts } from "./connector-drafts.js";
import type { ProviderSearch } from "./provider-discovery.js";
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
import type { BrowserLoginTools } from "./browser-login-tools.js";
import type { OperationBindingCatalogInput } from "./connectors/formats/arazzo/catalog.js";
import {
  authoredAccountIntentKey,
  saveAuthoredAccountIntent,
  type AuthoredAccountIntent,
} from "./authored-operations.js";
import { SYSTEM_TENANT } from "./system-tenants.js";

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

const accountRegistrationStep = {
  kind: "operation",
  id: "authored.register-account",
  version: "1.0.0",
} as const;
/**
 * Prepend account registration to a connector's recipe. Callers first check
 * that the run's provider/profile admits the authored account step; connect()
 * refuses with `account-registration-unsupported` where it does not.
 */
const registrationFirst = (definition: RecipeDefinition): RecipeDefinition => ({
  ...definition,
  id: `${definition.id}-registration-first`,
  invocations: [
    {
      id: "provider-account",
      use: { ...accountRegistrationStep },
      dependsOn: [],
      bindings: {},
    },
    ...definition.invocations.map((invocation) => ({
      ...invocation,
      dependsOn: invocation.dependsOn.length
        ? invocation.dependsOn
        : ["provider-account"],
    })),
  ],
});

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
  context(
    actor: ActorContext,
    connectorId: string,
    authored?: boolean,
  ): Promise<RunContext>;
  /**
   * The host's reviewed Arazzo operation-binding catalog for the actor's
   * tenant: which document, version and registered operation each Arazzo
   * reference means. Arazzo import is offered only when this is present; an
   * imported description never supplies it.
   */
  arazzoCatalog?: (
    actor: ActorContext,
  ) => Promise<OperationBindingCatalogInput>;
  authoringSearch?: ProviderSearch;
  authoringFetch?: typeof fetch;
  accountStatus?: (
    actor: ActorContext,
    connectorId: string,
    account: string,
  ) => Promise<"existing" | "available" | "unchecked">;
  selectTarget?: (
    actor: ActorContext,
    target: string,
    connectorId?: string,
  ) => Promise<void>;
  /**
   * Host policy for one operation of one run. For a step a recipe placed
   * under another connector, `run` is that step's view: its context fields
   * (provider, profile, target, origin, environment, configuration version)
   * are the step's own, and `run.scope` names the step and its connector, so
   * a policy written for single-provider runs evaluates the right context
   * without change.
   */
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
  /** Private, authenticated integration-owner contribution; never an agent tool. */
  ownerSetup?: (actor: ActorContext, request: Request) => Promise<Response>;
  cancel?: (actor: ActorContext, runId: string) => Promise<void>;
  /**
   * Retained-browser login tools, when this deployment has a browser executor.
   *
   * Left undefined otherwise, and both transports then decline to offer the
   * operations at all: a route that exists and always refuses is a worse answer
   * than a host that says plainly it cannot do this.
   */
  browserLogin?: BrowserLoginTools;
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
  async function connection(
    actor: ActorContext,
    connectorId: string,
    authored: boolean,
  ) {
    const installed = await authoring.getInstalled(actor, connectorId);
    if (authored && installed)
      return {
        definition: installed.definition,
        outputContract: "authored.connection",
        revalidateOperation: "authored.verify-access",
      };
    const registered = connections.get(connectorId);
    if (registered) return registered;
    if (installed)
      return {
        definition: installed.definition,
        outputContract: "authored.connection",
        revalidateOperation: "authored.verify-access",
      };
    throw new AuthorizationError("invalid_request");
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
        }>({ tenant: SYSTEM_TENANT.workload, kind: "session", id: run.id });
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
  const authoring = new ConnectorDrafts(store, {
    fetch:
      options.authoringFetch ??
      (options.origin.startsWith("http://127.0.0.1")
        ? loopbackAuthFetch
        : publicAuthFetch),
    ...(options.authoringSearch ? { search: options.authoringSearch } : {}),
    ...(options.origin.startsWith("http://127.0.0.1")
      ? { allowLoopbackHttp: true }
      : {}),
  });
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
    sourceRunId?: string,
  ) {
    const authored = Boolean(await authoring.getInstalled(actor, connectorId));
    await connection(actor, connectorId, authored);
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
    const runContext = await options.context(actor, connectorId, authored);
    // A step a recipe placed under another connector runs in that connector's
    // context, resolved by the host for this actor. An unknown connector is
    // refused here; one the host will not authorize is refused by createRun.
    // Either way no run exists.
    const contexts = new Map<string, NodeContext>();
    for (const leaf of checked.leaves) {
      const other = leaf.connector;
      if (!other || other === connectorId || contexts.has(other)) continue;
      const installed = Boolean(await authoring.getInstalled(actor, other));
      await connection(actor, other, installed);
      const resolved = await options.context(actor, other, installed);
      contexts.set(other, {
        provider: resolved.provider,
        profile: resolved.profile,
        target: resolved.target,
        origin: resolved.origin,
        environment: resolved.environment,
        configurationVersion: resolved.configurationVersion,
        connectorId: other,
      });
    }
    const nodes: RunPlanNode[] = checked.leaves.map((n) => {
      const context = n.connector ? contexts.get(n.connector) : undefined;
      return {
        id: n.id,
        operationId: n.use.id,
        operationVersion: n.use.version,
        dependsOn: n.dependsOn,
        bindings: n.bindings,
        ...(context ? { context } : {}),
        ...(n.outcome ? { outcome: n.outcome } : {}),
      };
    });
    const identifier = sourceRunId
      ? await store.transaction(async (tx) => {
          const source = await tx.get<RunRecord>({
            tenant: actor.tenantId,
            kind: "run",
            id: sourceRunId,
          });
          if (
            !source ||
            source.value.subjectId !== actor.subjectId ||
            source.value.sessionId !== actor.sessionId ||
            source.value.status === "cancelled" ||
            !Object.entries(runContext).every(
              ([name, value]) => Reflect.get(source.value, name) === value,
            )
          )
            throw new AuthorizationError("denied");
          return (
            await tx.get<AuthoredAccountIntent>(
              authoredAccountIntentKey(actor, sourceRunId),
            )
          )?.value.identifier;
        })
      : undefined;
    // Reuse the person's selection, never a demonstration's credentials or
    // verification outcome. Provider availability is checked for the new run.
    const intent: AuthoredAccountIntent | undefined = identifier
      ? {
          identifier,
          status:
            (await options.accountStatus?.(actor, connectorId, identifier)) ??
            "unchecked",
        }
      : undefined;
    const run = await commands.createRun(
      actor,
      runContext,
      nodes,
      inputs,
      options.continuation?.id,
    );
    if (intent) await saveAuthoredAccountIntent(store, actor, run.id, intent);
    return run;
  }
  async function connect(
    actor: ActorContext,
    connectorId: string,
    fresh = true,
    account?: string,
  ) {
    requireCapability(actor, "executor");
    const authored = Boolean(await authoring.getInstalled(actor, connectorId));
    const context = await options.context(actor, connectorId, authored);
    // Name the refusal before any lookup or run exists: the account step is
    // authored, so a run for another provider's profile would only be denied.
    if (
      account &&
      !commands.admits(
        context,
        accountRegistrationStep.id,
        accountRegistrationStep.version,
      )
    )
      throw new Error("account-registration-unsupported");
    const registered = await connection(
      actor,
      connectorId,
      context.profile === "authored",
    );
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
        const candidates = page.filter(
          (r) =>
            r.value.subjectId === actor.subjectId &&
            r.value.sessionId === actor.sessionId &&
            r.value.continuation === options.continuation?.id &&
            r.value.status !== "cancelled" &&
            (!account ||
              (r.value.nodes[0]?.operationId === "authored.register-account" &&
                r.value.target === context.target)) &&
            (context.profile !== "authored" ||
              r.value.nodes.every((node) =>
                node.operationId.startsWith("authored."),
              )) &&
            Object.entries(context).every(
              ([k, v]) => Reflect.get(r.value, k) === v,
            ),
        );
        for (const candidate of candidates) {
          if (
            !account ||
            (
              await tx.get<AuthoredAccountIntent>(
                authoredAccountIntentKey(actor, candidate.id),
              )
            )?.value.identifier.toLowerCase() === account.toLowerCase()
          )
            return candidate;
        }
        if (page.length < 1000) return undefined;
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
      return fresh && (!account || existing.value.status === "complete")
        ? commands.revalidate(actor, existing.id)
        : commands.snapshot(actor, existing.id);
    const selected = await recipes.selectConnection(actor, {
      provider: context.provider,
      profile: context.profile,
      outputContract: registered.outputContract,
    });
    return executeRecipe(
      actor,
      account
        ? registrationFirst(selected ?? registered.definition)
        : (selected ?? registered.definition),
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
        tenant: SYSTEM_TENANT.workload,
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
      }>({ tenant: SYSTEM_TENANT.workload, kind: "session", id: runId });
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
    listConnectors: async (actor: ActorContext) => [
      ...connections.keys(),
      ...(await authoring.listManifests(actor)).map((item) => item.id),
    ],
    commands,
    recipes,
    authoring,
    demonstrations,
    agent,
    modelConfiguration,
    accountStatus: options.accountStatus,
    connect,
    connectForAgent,
    executeRecipe,
    delegate,
    agentActor,
    human: options.human,
    humanReturn: options.humanReturn,
    ownerSetup: options.ownerSetup,
    cancel: options.cancel,
    selectTarget: options.selectTarget,
    browserLogin: options.browserLogin,
    arazzoCatalog: options.arazzoCatalog,
    flushContinuations,
  };
}
export type TeachingRuntime = ReturnType<typeof createTeachingRuntime>;
