import { createHash } from "node:crypto";
import { z } from "zod";
import type { RecipeDefinition } from "../../core/recipe-contracts.js";
import type { RunRecord } from "../commands.js";
import { AuthorizationError } from "../identity.js";
import { runArazzo, type ArazzoDocument } from "../arazzo.js";
import {
  jiraAuth,
  jiraPrivateSessionSchema,
  jiraOAuthConfigurationSchema,
  type JiraOAuthConfiguration,
  type JiraPrivateSession,
} from "../jira-auth.js";
import { DurableAuthorizationCode } from "../oauth-handoff.js";
import { AsyncPrivateCollectionBroker } from "../persistence/collections.js";
import { appendSemanticTransition } from "../demonstrations.js";
import type {
  AsyncCeremonyStore,
  AsyncTransaction,
  RecordKey,
} from "../persistence/index.js";
import {
  OperationRegistry,
  type OperationContext,
  type OperationResult,
  type VocabularyEntry,
} from "./registry.js";

const artifactReference = z
  .string()
  .regex(/^jira:(app|session|connection):[a-f0-9]{64}$/);
const artifactSchema = z.strictObject({
  scope: z.string().regex(/^[a-f0-9]{64}$/),
  expires: z.number().int().positive(),
  app: jiraOAuthConfigurationSchema.optional(),
  session: jiraPrivateSessionSchema.optional(),
  accountId: z.string().min(1).max(256).optional(),
  cloudId: z.guid().optional(),
  evidenceEffect: z.string().min(1).max(200).optional(),
});
type Artifact = z.infer<typeof artifactSchema>;
type Kind = "app" | "session" | "connection";
export const jiraVocabulary = new Map<string, VocabularyEntry>(
  (["app", "session", "connection"] as const).map((kind) => [
    `jira.${kind}`,
    {
      schema: artifactReference,
      classification: "artifact",
      provider: "jira",
      profile: "jira-3lo",
    },
  ]),
);
export const jiraConnectionRecipe: RecipeDefinition = {
  schemaVersion: 1,
  id: "jira-connect",
  title: "Connect Jira",
  description:
    "Reuse a configured shared OAuth app, authorize your Atlassian account and verify access to the intended Jira site. App configuration is not account ownership.",
  inputs: {},
  invocations: [
    {
      id: "app",
      use: { kind: "operation", id: "jira.prepare-app", version: "1.0.0" },
      dependsOn: [],
      bindings: {},
    },
    {
      id: "session",
      use: { kind: "operation", id: "jira.authorize-user", version: "1.0.0" },
      dependsOn: ["app"],
      bindings: { app: { from: "output", node: "app", name: "app" } },
    },
    {
      id: "access",
      use: { kind: "operation", id: "jira.verify-access", version: "1.0.0" },
      dependsOn: ["session"],
      bindings: {
        session: { from: "output", node: "session", name: "session" },
      },
    },
  ],
  outputs: { connection: { node: "access", name: "connection" } },
};
export const jiraAccessWorkflow: ArazzoDocument = {
  arazzo: "1.0.1",
  info: { title: "Jira site-bound access verification", version: "1.0.0" },
  sourceDescriptions: [
    {
      name: "jira",
      type: "openapi",
      url: "https://developer.atlassian.com/cloud/jira/platform/swagger-v3.v3.json",
    },
  ],
  workflows: [
    {
      workflowId: "verify-access",
      summary:
        "Resolve the authorized Jira site and verify its current active account.",
      steps: [
        {
          stepId: "verify-user",
          description:
            "Read the current user only after validating the authorized site and scopes.",
          operationPath:
            "{$sourceDescriptions.jira.url}#/paths/~1rest~1api~13~1myself/get",
        },
      ],
    },
  ],
};
export type JiraChildrenOptions = {
  /** Shared app belongs to the integration owner, not each person connecting. Version changes fence old runs. */
  configuration(
    context: OperationContext,
  ): Promise<{ version: string; app?: JiraOAuthConfiguration }>;
  authorize(context: OperationContext): Promise<void>;
  fetch?: typeof fetch;
  allowLoopbackHttp?: boolean;
  /** Host-selected permissions for owner setup; never a collector/model choice. */
  registrationScopes?: JiraOAuthConfiguration["scopes"];
};

/** Deterministic registered children. Tokens and account identifiers remain protected artifacts. */
export class AsyncJiraChildren {
  readonly authorization: DurableAuthorizationCode<JiraPrivateSession>;
  constructor(
    private readonly store: AsyncCeremonyStore,
    private readonly options: JiraChildrenOptions,
  ) {
    this.authorization = new DurableAuthorizationCode(store, {
      provider: "jira",
      profile: "jira-3lo",
      operationId: "jira.authorize-user",
      operationVersion: "1.0.0",
      sessionSchema: jiraPrivateSessionSchema,
      authorize: async (context) => {
        await this.authorize(context);
      },
      driver: (context) => this.client(context),
      expiresAt: (session) => session.expiresAt,
    });
  }
  private scope(context: OperationContext) {
    return createHash("sha256")
      .update(
        JSON.stringify([
          context.actor.tenantId,
          context.actor.subjectId,
          context.actor.sessionId,
          "jira",
          "jira-3lo",
          context.origin,
          context.environment,
          context.configurationVersion,
          context.target,
        ]),
      )
      .digest("hex");
  }
  private key(context: OperationContext, kind: Kind): RecordKey {
    return {
      tenant: context.actor.tenantId,
      kind: "artifact",
      id: `jira:${kind}:${this.scope(context)}`,
    };
  }
  private async authorize(context: OperationContext) {
    context.signal.throwIfAborted();
    await this.options.authorize(context);
    const run = await this.store.transaction((tx) =>
      tx.get<RunRecord>({
        tenant: context.actor.tenantId,
        kind: "run",
        id: context.runId,
      }),
    );
    if (
      !run ||
      run.value.subjectId !== context.actor.subjectId ||
      run.value.sessionId !== context.actor.sessionId ||
      run.value.status === "cancelled" ||
      run.value.provider !== "jira" ||
      run.value.profile !== "jira-3lo" ||
      run.value.target !== context.target ||
      run.value.origin !== context.origin ||
      run.value.environment !== context.environment ||
      run.value.configurationVersion !== context.configurationVersion
    )
      throw new AuthorizationError("denied");
    const config = await this.options.configuration(context);
    if (config.version !== context.configurationVersion)
      throw new AuthorizationError("denied");
    return config;
  }
  private async client(context: OperationContext) {
    const configured = await this.authorize(context);
    const app = configured.app ?? (await this.read(context, "app"))?.app;
    if (
      !app ||
      new URL(app.siteUrl).origin !== context.target ||
      app.callbackUrl !==
        `${context.origin}/api/v1/teaching/jira/authorization-return`
    )
      throw new AuthorizationError("denied");
    return jiraAuth(app, {
      signal: context.signal,
      ...(this.options.fetch ? { fetch: this.options.fetch } : {}),
      ...(this.options.allowLoopbackHttp ? { allowLoopbackHttp: true } : {}),
    });
  }
  private async read(
    context: OperationContext,
    kind: Kind,
    reference?: unknown,
  ) {
    await this.authorize(context);
    const key = this.key(context, kind);
    if (reference !== undefined && reference !== key.id)
      throw new AuthorizationError("denied");
    return this.store.transaction(async (tx) => {
      const record = await tx.get(key);
      if (!record) return undefined;
      const artifact = artifactSchema.parse(record.value);
      return artifact.scope === this.scope(context) &&
        artifact.expires > (await tx.now())
        ? artifact
        : undefined;
    });
  }
  private async save(
    context: OperationContext,
    kind: Kind,
    data: Omit<Artifact, "scope" | "expires"> = {},
  ) {
    await this.authorize(context);
    return this.store.transaction(async (tx) => {
      await this.assertExecutionFence(context, tx);
      const run = await tx.get<RunRecord>({
        tenant: context.actor.tenantId,
        kind: "run",
        id: context.runId,
      });
      const command = await tx.get<{
        state: string;
        runId: string;
        nodeId: string;
        effectId: string;
      }>({
        tenant: context.actor.tenantId,
        kind: "command",
        id: context.commandId,
      });
      if (
        !run ||
        run.value.status !== "active" ||
        run.value.subjectId !== context.actor.subjectId ||
        run.value.sessionId !== context.actor.sessionId ||
        command?.value.state !== "running" ||
        command.value.runId !== context.runId ||
        command.value.nodeId !== context.nodeId ||
        command.value.effectId !== context.effectId
      )
        throw new AuthorizationError("denied");
      const key = this.key(context, kind),
        prior = await tx.get(key);
      const now = await tx.now();
      const expires = data.session?.expiresAt ?? now + 86400000;
      if (expires <= now) throw new AuthorizationError("denied");
      await tx.put(
        key,
        artifactSchema.parse({ scope: this.scope(context), expires, ...data }),
        prior?.revision ?? null,
      );
      return {
        state: "complete",
        outputs: { [kind]: key.id },
      } satisfies OperationResult;
    });
  }
  private async assertExecutionFence(
    context: OperationContext,
    tx: AsyncTransaction,
  ) {
    if (
      !context.fence ||
      context.fence.tenant !== context.actor.tenantId ||
      context.fence.kind !== "run" ||
      context.fence.id !== context.runId
    )
      throw new AuthorizationError("denied");
    await tx.assertFence(context.fence);
  }
  register(registry: OperationRegistry) {
    for (const operation of [
      {
        id: "prepare-app",
        kind: "app" as const,
        input: undefined,
        handler: (context: OperationContext) => this.prepareApp(context),
      },
      {
        id: "authorize-user",
        kind: "session" as const,
        input: "app",
        handler: (context: OperationContext, input: Record<string, unknown>) =>
          this.obtainSession(context, input.app),
      },
      {
        id: "verify-access",
        kind: "connection" as const,
        input: "session",
        handler: (context: OperationContext, input: Record<string, unknown>) =>
          this.verifyAccess(context, input.session),
      },
    ]) {
      registry.register({
        contract: {
          id: `jira.${operation.id}`,
          version: "1.0.0",
          provider: "jira",
          profile: "jira-3lo",
          inputs: operation.input
            ? {
                [operation.input]: {
                  contract: `jira.${operation.input}`,
                  required: true,
                },
              }
            : {},
          outputs: {
            [operation.kind]: {
              contract: `jira.${operation.kind}`,
              required: true,
            },
          },
          effects: [`jira.${operation.id}`],
          verifier:
            operation.kind === "connection"
              ? "jira.current-user"
              : "jira.bound-prerequisite",
          humanFallback:
            operation.kind === "app"
              ? "jira.integration-owner"
              : "jira.provider-consent",
        },
        inputSchema: z.strictObject(
          operation.input ? { [operation.input]: artifactReference } : {},
        ),
        outputSchema: z.strictObject({ [operation.kind]: artifactReference }),
        classifications: {},
        fixtures: ["tests/jira-children.test.ts"],
        handler: async (context, inputs) => {
          try {
            await this.authorize(context);
            await this.store.transaction(async (tx) => {
              await this.assertExecutionFence(context, tx);
              const command = await tx.get<{
                state: string;
                runId: string;
                nodeId: string;
                effectId: string;
              }>({
                tenant: context.actor.tenantId,
                kind: "command",
                id: context.commandId,
              });
              const run = await tx.get<RunRecord>({
                tenant: context.actor.tenantId,
                kind: "run",
                id: context.runId,
              });
              const node = run?.value.nodes.find(
                (node) => node.id === context.nodeId,
              );
              if (
                run?.value.status !== "active" ||
                node?.operationId !== `jira.${operation.id}` ||
                node.operationVersion !== "1.0.0" ||
                command?.value.state !== "running" ||
                command.value.runId !== context.runId ||
                command.value.nodeId !== context.nodeId ||
                command.value.effectId !== context.effectId
              )
                throw new AuthorizationError("denied");
            });
            return await operation.handler(context, inputs);
          } catch {
            return {
              state: "failed",
              outputs: {},
              diagnosticCode: "verification-rejected",
            };
          }
        },
        verify: async (context, result) => {
          if (result.state !== "complete") return false;
          const artifact = await this.read(
            context,
            operation.kind,
            result.outputs[operation.kind],
          );
          if (!artifact) return false;
          await this.client(context);
          if (operation.kind === "app") return true;
          if (!artifact.session) return false;
          if (operation.kind === "session") return true; // Token receipt only; never a connection contract.
          if (!artifact.accountId || !artifact.cloudId) return false;
          if (artifact.evidenceEffect !== context.effectId) {
            const current = await this.identity(
              context,
              artifact.session,
              artifact.accountId,
            );
            if (current.cloudId !== artifact.cloudId) return false;
          }
          return true;
        },
      });
    }
  }
  private async prepareApp(
    context: OperationContext,
  ): Promise<OperationResult> {
    const app =
      (await this.authorize(context)).app ??
      (await this.read(context, "app"))?.app;
    if (!app) return { state: "awaiting-human", outputs: {} };
    await this.client(context);
    return this.save(context, "app", { app });
  }
  private async obtainSession(
    context: OperationContext,
    app: unknown,
  ): Promise<OperationResult> {
    if (!(await this.read(context, "app", app)))
      throw new AuthorizationError("denied");
    await this.client(context);
    const saved = await this.read(context, "session");
    if (saved?.session)
      return this.save(context, "session", { session: saved.session });
    await this.authorization.prepare(context);
    const result = await this.authorization.exchange(context);
    if (result.state !== "issued") return { state: result.state, outputs: {} };
    return this.save(context, "session", { session: result.session });
  }
  private async identity(
    context: OperationContext,
    session: JiraPrivateSession,
    accountId?: string,
  ) {
    const client = await this.client(context);
    let identity: Awaited<ReturnType<typeof client.verify>> | undefined;
    await runArazzo(
      jiraAccessWorkflow,
      "verify-access",
      new Map([
        [
          "{$sourceDescriptions.jira.url}#/paths/~1rest~1api~13~1myself/get",
          async () => {
            identity = await client.verify(session, accountId);
          },
        ],
      ]),
    );
    if (!identity) throw new AuthorizationError("denied");
    await this.authorize(context);
    return identity;
  }
  private async verifyAccess(
    context: OperationContext,
    reference: unknown,
  ): Promise<OperationResult> {
    const artifact = await this.read(context, "session", reference);
    if (!artifact?.session) throw new AuthorizationError("denied");
    const previous = await this.read(context, "connection");
    const identity = await this.identity(
      context,
      artifact.session,
      previous?.accountId,
    );
    return this.save(context, "connection", {
      session: artifact.session,
      accountId: identity.accountId,
      cloudId: identity.cloudId,
      evidenceEffect: context.effectId,
    });
  }
  /** Native private collection for an authenticated integration owner. Configuration is not provider approval. */
  async configureApp(
    context: OperationContext,
    revision: number,
    input: unknown,
  ): Promise<void> {
    await this.authorize(context);
    if (
      context.actor.actorKind !== "human" ||
      !context.actor.capabilities.includes("admin")
    )
      throw new AuthorizationError("denied");
    const parsed = jiraOAuthConfigurationSchema
      .pick({ clientId: true, clientSecret: true })
      .safeParse(input);
    if (!parsed.success) throw new AuthorizationError("invalid_request");
    const values = parsed.data;
    const app = jiraOAuthConfigurationSchema.parse({
      ...values,
      siteUrl: context.target,
      callbackUrl: `${context.origin}/api/v1/teaching/jira/authorization-return`,
      scopes: this.options.registrationScopes ?? ["read:jira-user"],
    });
    jiraAuth(app, {
      signal: context.signal,
      ...(this.options.allowLoopbackHttp ? { allowLoopbackHttp: true } : {}),
    });
    const binding = {
      purpose: "jira-app-configuration",
      provider: "jira",
      operationId: "jira.prepare-app",
      operationVersion: "1.0.0",
      runId: context.runId,
      nodeId: context.nodeId,
      revision,
      fields: ["clientId", "clientSecret"],
    };
    const broker = new AsyncPrivateCollectionBroker(this.store);
    const reference = await broker.collect(context.actor, binding, values);
    await this.authorize(context);
    await this.store.transaction(async (tx) => {
      const runKey: RecordKey = {
        tenant: context.actor.tenantId,
        kind: "run",
        id: context.runId,
      };
      const run = await tx.get<RunRecord>(runKey);
      const node = run?.value.nodes.find((node) => node.id === context.nodeId);
      const state = await tx.get<{ state: string }>({
        tenant: context.actor.tenantId,
        kind: "node",
        id: `${context.runId}:${context.nodeId}`,
      });
      if (
        !run ||
        run.revision !== revision ||
        run.value.status !== "active" ||
        run.value.subjectId !== context.actor.subjectId ||
        run.value.sessionId !== context.actor.sessionId ||
        node?.operationId !== "jira.prepare-app" ||
        node.operationVersion !== "1.0.0" ||
        state?.value.state !== "awaiting-human"
      )
        throw new AuthorizationError("denied");
      const fence = await tx.claim(
        runKey,
        `owner-${createHash("sha256").update(context.commandId).digest("hex")}`,
        30000,
      );
      const collected = await broker.consumeIn(
        tx,
        context.actor,
        binding,
        reference,
        context.commandId,
      );
      const key = this.key(context, "app"),
        prior = await tx.get(key);
      await tx.put(
        key,
        artifactSchema.parse({
          scope: this.scope(context),
          expires: (await tx.now()) + 86400000,
          app: {
            ...app,
            clientId: collected.clientId,
            clientSecret: collected.clientSecret,
          },
        }),
        prior?.revision ?? null,
      );
      await tx.put(runKey, run.value, run.revision);
      await appendSemanticTransition(
        tx,
        context.actor,
        context.runId,
        {
          nodeId: context.nodeId,
          operationId: "jira.prepare-app",
          operationVersion: "1.0.0",
          actorKind: "human",
          kind: "handoff",
          beforeState: "awaiting-human",
          afterState: "awaiting-human",
          publicBindings: {},
          verification: "pending",
        },
        {},
      );
      await tx.assertFence(fence);
      await tx.cancel(runKey);
    });
    await broker.complete(context.actor, binding, reference, context.commandId);
  }
}
