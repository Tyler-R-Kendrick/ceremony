import { createHash } from "node:crypto";
import { z } from "zod";
import type { RecipeDefinition } from "../../core/recipe-contracts.js";
import type {
  AsyncCeremonyStore,
  AsyncTransaction,
} from "../persistence/index.js";
import { AsyncPrivateCollectionBroker } from "../persistence/collections.js";
import type { RunRecord } from "../commands.js";
import { AuthorizationError } from "../identity.js";
import { appendSemanticTransition } from "../demonstrations.js";
import {
  supabaseAuth,
  SupabaseAuthFailure,
  type SupabaseProject,
  type SupabasePrivateSession,
} from "../supabase-auth.js";
import {
  OperationRegistry,
  type OperationContext,
  type OperationResult,
  type VocabularyEntry,
} from "./registry.js";

const artifactSchema = z
  .string()
  .regex(/^supabase:(project|session|connection):[a-f0-9]{64}$/);
export const supabaseVocabulary = new Map<string, VocabularyEntry>(
  ["project", "session", "connection"].map((kind) => [
    `supabase.${kind}`,
    {
      schema: artifactSchema,
      classification: "artifact",
      provider: "supabase",
      profile: "supabase-password",
    },
  ]),
);
export const supabaseConnectionRecipe: RecipeDefinition = {
  schemaVersion: 1,
  id: "supabase-connect",
  title: "Connect Supabase",
  description:
    "Configure a project, sign in or create a project user, and verify access. Project configuration is not dashboard ownership.",
  inputs: {},
  invocations: [
    {
      id: "project",
      use: {
        kind: "operation",
        id: "supabase.prepare-project",
        version: "1.0.0",
      },
      dependsOn: [],
      bindings: {},
    },
    {
      id: "session",
      use: {
        kind: "operation",
        id: "supabase.obtain-session",
        version: "1.0.0",
      },
      dependsOn: ["project"],
      bindings: {
        project: { from: "output", node: "project", name: "project" },
      },
    },
    {
      id: "access",
      use: {
        kind: "operation",
        id: "supabase.verify-access",
        version: "1.0.0",
      },
      dependsOn: ["session"],
      bindings: {
        session: { from: "output", node: "session", name: "session" },
      },
    },
  ],
  outputs: { connection: { node: "access", name: "connection" } },
};
type Material = {
  scope: string;
  expires: number;
  project?: SupabaseProject;
  credentials?: {
    action: "sign-in" | "sign-up";
    email: string;
    password: string;
  };
  session?: SupabasePrivateSession;
  mfa?: { factorId: string; code: string };
  confirmationPending?: boolean;
  evidenceEffect?: string;
  verifiedUntil?: number;
};
type Kind = "project" | "input" | "session" | "connection";
export type SupabaseChildrenOptions = {
  configuration(
    context: OperationContext,
  ): Promise<{ version: string; projectUrl?: string; publishableKey?: string }>;
  authorize(context: OperationContext): Promise<void>;
  fetch?: typeof fetch;
  requiredAssurance?: "aal1" | "aal2";
};

/** Deterministic leaves; private input is never an operation argument or demonstration binding. */
export class AsyncSupabaseChildren {
  private readonly broker: AsyncPrivateCollectionBroker;
  constructor(
    private readonly store: AsyncCeremonyStore,
    private readonly options: SupabaseChildrenOptions,
  ) {
    this.broker = new AsyncPrivateCollectionBroker(store);
  }
  private scope(context: OperationContext, kind: Kind) {
    return createHash("sha256")
      .update(
        JSON.stringify([
          context.actor.tenantId,
          context.actor.subjectId,
          context.actor.sessionId,
          "supabase",
          "supabase-password",
          context.origin,
          context.environment,
          context.configurationVersion,
          context.target,
          ...(kind === "input" || kind === "session" ? [context.runId] : []),
        ]),
      )
      .digest("hex");
  }
  private key(context: OperationContext, kind: Kind) {
    return {
      tenant: context.actor.tenantId,
      kind: "artifact" as const,
      id: `supabase:${kind}:${this.scope(context, kind)}`,
    };
  }
  private signupKey(context: OperationContext) {
    return {
      tenant: context.actor.tenantId,
      kind: "effect" as const,
      id: `supabase-signup:${context.runId}`,
    };
  }
  private async authorize(context: OperationContext) {
    context.signal.throwIfAborted();
    await this.options.authorize(context);
    const record = await this.store.transaction((tx) =>
      tx.get<RunRecord>({
        tenant: context.actor.tenantId,
        kind: "run",
        id: context.runId,
      }),
    );
    const run = record?.value;
    if (
      !run ||
      run.subjectId !== context.actor.subjectId ||
      run.sessionId !== context.actor.sessionId ||
      run.status === "cancelled" ||
      run.provider !== "supabase" ||
      run.profile !== "supabase-password" ||
      run.origin !== context.origin ||
      run.environment !== context.environment ||
      run.target !== context.target ||
      run.configurationVersion !== context.configurationVersion
    )
      throw new AuthorizationError("denied");
    const config = await this.options.configuration(context);
    if (config.version !== context.configurationVersion)
      throw new AuthorizationError("denied");
    return config;
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
      const record = await tx.get<Material>(key);
      return record &&
        record.value.scope === this.scope(context, kind) &&
        record.value.expires > (await tx.now())
        ? record.value
        : undefined;
    });
  }
  private async write(
    tx: AsyncTransaction,
    context: OperationContext,
    kind: Kind,
    data: Omit<Material, "scope" | "expires">,
    ttl: number,
  ) {
    const run = await tx.get<RunRecord>({
      tenant: context.actor.tenantId,
      kind: "run",
      id: context.runId,
    });
    if (
      !run ||
      run.value.status !== "active" ||
      run.value.subjectId !== context.actor.subjectId ||
      run.value.sessionId !== context.actor.sessionId ||
      run.value.configurationVersion !== context.configurationVersion
    )
      throw new AuthorizationError("denied");
    const key = this.key(context, kind),
      prior = await tx.get<Material>(key);
    // A shared configuration binding is immutable within its version. Switching projects requires a new host/session configuration revision.
    if (
      kind === "project" &&
      prior?.value.project &&
      data.project &&
      (new URL(prior.value.project.projectUrl).origin !==
        new URL(data.project.projectUrl).origin ||
        prior.value.project.publishableKey !== data.project.publishableKey)
    )
      throw new AuthorizationError("denied");
    await tx.put(
      key,
      {
        ...data,
        scope: this.scope(context, kind),
        expires: (await tx.now()) + ttl,
      } satisfies Material,
      prior?.revision ?? null,
    );
    return key.id;
  }
  private async save(
    context: OperationContext,
    kind: Kind,
    data: Omit<Material, "scope" | "expires">,
    ttl = 86400000,
  ) {
    await this.authorize(context);
    return this.store.transaction(async (tx) => {
      const command = await tx.get<{ state: string; effectId: string }>({
        tenant: context.actor.tenantId,
        kind: "command",
        id: context.commandId,
      });
      if (
        command?.value.state !== "running" ||
        command.value.effectId !== context.effectId
      )
        throw new AuthorizationError("denied");
      return this.write(tx, context, kind, data, ttl);
    });
  }
  private client(context: OperationContext, project: SupabaseProject) {
    return supabaseAuth(project, {
      signal: context.signal,
      ...(this.options.fetch ? { fetch: this.options.fetch } : {}),
    });
  }
  private result(
    kind: Exclude<Kind, "input">,
    reference: string,
  ): OperationResult {
    return { state: "complete", outputs: { [kind]: reference } };
  }
  register(registry: OperationRegistry) {
    for (const leaf of [
      {
        id: "prepare-project",
        output: "project" as const,
        input: undefined,
        handler: (context: OperationContext) => this.prepareProject(context),
      },
      {
        id: "obtain-session",
        output: "session" as const,
        input: "project",
        handler: (context: OperationContext, input: Record<string, unknown>) =>
          this.obtainSession(context, input.project),
      },
      {
        id: "verify-access",
        output: "connection" as const,
        input: "session",
        handler: (context: OperationContext, input: Record<string, unknown>) =>
          this.verifyAccess(context, input.session),
      },
    ])
      registry.register({
        contract: {
          id: `supabase.${leaf.id}`,
          version: "1.0.0",
          provider: "supabase",
          profile: "supabase-password",
          inputs: leaf.input
            ? {
                [leaf.input]: {
                  contract: `supabase.${leaf.input}`,
                  required: true,
                },
              }
            : {},
          outputs: {
            [leaf.output]: {
              contract: `supabase.${leaf.output}`,
              required: true,
            },
          },
          effects: [`supabase.${leaf.id}`],
          verifier:
            leaf.output === "connection"
              ? "supabase.auth-session"
              : "supabase.bound-setup",
          humanFallback: "supabase.private-collector",
        },
        inputSchema: z.strictObject(
          leaf.input ? { [leaf.input]: artifactSchema } : {},
        ),
        outputSchema: z.strictObject({ [leaf.output]: artifactSchema }),
        classifications: {},
        fixtures: ["tests/supabase-children.test.ts"],
        handler: async (context, inputs) => {
          try {
            return await leaf.handler(context, inputs);
          } catch {
            return {
              state: "awaiting-human",
              outputs: {},
              diagnosticCode: "verification-rejected",
            };
          }
        },
        verify: async (context, result) => {
          if (result.state !== "complete") return false;
          const material = await this.read(
            context,
            leaf.output,
            result.outputs[leaf.output],
          );
          if (!material) return false;
          if (leaf.output !== "connection") return true;
          if (
            !material.project ||
            !material.session ||
            !material.verifiedUntil ||
            material.verifiedUntil <= Date.now()
          )
            return false;
          if (material.evidenceEffect === context.effectId) return true;
          return (
            (
              await this.client(context, material.project).verify(
                material.session,
                this.options.requiredAssurance,
              )
            ).state === "verified"
          );
        },
      });
  }
  async prepareProject(context: OperationContext): Promise<OperationResult> {
    const config = await this.authorize(context),
      collected = await this.read(context, "project");
    const project =
      config.projectUrl && config.publishableKey
        ? {
            projectUrl: config.projectUrl,
            publishableKey: config.publishableKey,
          }
        : collected?.project;
    if (!project) return { state: "awaiting-human", outputs: {} };
    this.client(context, project); // Validate a configuration candidate; this does not prove dashboard ownership.
    return this.result(
      "project",
      await this.save(context, "project", { project }),
    );
  }
  async obtainSession(
    context: OperationContext,
    reference: unknown,
  ): Promise<OperationResult> {
    const project = (await this.read(context, "project", reference))?.project;
    if (!project) throw new AuthorizationError("denied");
    const prior = await this.read(context, "session");
    if (prior?.session)
      return this.result("session", this.key(context, "session").id);
    const input = await this.read(context, "input");
    if (!input?.credentials) return { state: "awaiting-human", outputs: {} };
    let action = input.credentials.action;
    if (action === "sign-up") {
      // Persist before the external request. Recovery always signs in; it never repeats account creation.
      const exists = await this.store.transaction(async (tx) => {
        const run = await tx.get<RunRecord>({
          tenant: context.actor.tenantId,
          kind: "run",
          id: context.runId,
        });
        const command = await tx.get<{ state: string; effectId: string }>({
          tenant: context.actor.tenantId,
          kind: "command",
          id: context.commandId,
        });
        if (
          !run ||
          run.value.status !== "active" ||
          run.value.subjectId !== context.actor.subjectId ||
          run.value.configurationVersion !== context.configurationVersion ||
          command?.value.state !== "running" ||
          command.value.effectId !== context.effectId
        )
          throw new AuthorizationError("denied");
        const key = this.signupKey(context),
          prior = await tx.get(key);
        if (prior) return true;
        await tx.put(
          key,
          {
            runId: context.runId,
            commandId: context.commandId,
            effectId: context.effectId,
          },
          null,
        );
        return false;
      });
      if (exists) action = "sign-in";
    }
    let result;
    try {
      result = await this.client(context, project).authenticate({
        ...input.credentials,
        action,
      });
    } catch (error) {
      if (
        action === "sign-up" &&
        error instanceof SupabaseAuthFailure &&
        error.code === "provider-unavailable"
      )
        return { state: "uncertain", outputs: {}, diagnosticCode: "uncertain" };
      throw error;
    }
    await this.authorize(context);
    if (result.state !== "session") {
      await this.save(
        context,
        "input",
        { credentials: input.credentials, confirmationPending: true },
        Math.max(1, input.expires - Date.now()),
      );
      return { state: "awaiting-human", outputs: {} };
    }
    const output = await this.save(
      context,
      "session",
      { project, session: result.session },
      Math.max(1, result.session.expires_at * 1000 - Date.now()),
    );
    await this.store.transaction(async (tx) => {
      const key = this.key(context, "input"),
        input = await tx.get(key);
      if (input) await tx.delete(key, input.revision);
    });
    return this.result("session", output);
  }
  async verifyAccess(
    context: OperationContext,
    reference: unknown,
  ): Promise<OperationResult> {
    const material = await this.read(context, "session", reference);
    if (!material?.project || !material.session)
      throw new AuthorizationError("denied");
    const client = this.client(context, material.project);
    let result = await client.verify(
      material.session,
      this.options.requiredAssurance,
    );
    if (result.state === "mfa-required") {
      // Consume into the admitted command before either external MFA effect. A lost outcome requires fresh human input, never code replay.
      const input = await this.store.transaction(async (tx) => {
        const command = await tx.get<{ state: string; effectId: string }>({
          tenant: context.actor.tenantId,
          kind: "command",
          id: context.commandId,
        });
        if (
          command?.value.state !== "running" ||
          command.value.effectId !== context.effectId
        )
          throw new AuthorizationError("denied");
        const key = this.key(context, "input"),
          record = await tx.get<Material>(key);
        if (!record?.value.mfa || record.value.expires <= (await tx.now()))
          return undefined;
        await tx.delete(key, record.revision);
        return record.value.mfa;
      });
      if (!input) return { state: "awaiting-human", outputs: {} };
      await this.authorize(context);
      try {
        const challenge = await client.challengeTotp(
          material.session,
          input.factorId,
        );
        await this.authorize(context);
        material.session = await client.verifyTotp(
          material.session,
          challenge,
          input.code,
        );
        await this.save(
          context,
          "session",
          { project: material.project, session: material.session },
          Math.max(1, material.session.expires_at * 1000 - Date.now()),
        );
        result = await client.verify(
          material.session,
          this.options.requiredAssurance,
        );
      } catch (error) {
        if (
          error instanceof SupabaseAuthFailure &&
          error.code === "provider-unavailable"
        )
          return {
            state: "uncertain",
            outputs: {},
            diagnosticCode: "uncertain",
          };
        throw error;
      }
    }
    await this.authorize(context);
    if (result.state !== "verified")
      return { state: "awaiting-human", outputs: {} };
    return this.result(
      "connection",
      await this.save(
        context,
        "connection",
        {
          project: material.project,
          session: material.session,
          evidenceEffect: context.effectId,
          verifiedUntil: result.expiresAt,
        },
        Math.max(1, result.expiresAt - Date.now()),
      ),
    );
  }
  /** Native authenticated collector only; a confirmation click is permission to check, never completion evidence. */
  async humanView(
    context: OperationContext,
  ): Promise<
    | { mode: "project" }
    | { mode: "credentials"; allowSignup: boolean }
    | { mode: "confirmation" }
    | { mode: "mfa"; factors: string[] }
  > {
    await this.authorize(context);
    if (context.actor.actorKind !== "human")
      throw new AuthorizationError("denied");
    const node = await this.store.transaction(async (tx) => {
      const run = await tx.get<RunRecord>({
        tenant: context.actor.tenantId,
        kind: "run",
        id: context.runId,
      });
      const node = run?.value.nodes.find((item) => item.id === context.nodeId);
      const state = await tx.get<{ state: string }>({
        tenant: context.actor.tenantId,
        kind: "node",
        id: `${context.runId}:${context.nodeId}`,
      });
      if (
        !node ||
        !["awaiting-human", "uncertain"].includes(state?.value.state ?? "")
      )
        throw new AuthorizationError("denied");
      return node;
    });
    if (node.operationId === "supabase.prepare-project")
      return { mode: "project" };
    if (node.operationId === "supabase.obtain-session") {
      const input = await this.read(context, "input");
      if (input?.confirmationPending) return { mode: "confirmation" };
      const attempted = await this.store.transaction((tx) =>
        tx.get(this.signupKey(context)),
      );
      return { mode: "credentials", allowSignup: !attempted };
    }
    if (node.operationId !== "supabase.verify-access")
      throw new AuthorizationError("denied");
    const material = await this.read(context, "session");
    if (material?.project && material.session) {
      const client = this.client(context, material.project);
      try {
        if (
          (
            await client.verify(
              material.session,
              this.options.requiredAssurance,
            )
          ).state === "mfa-required"
        )
          return {
            mode: "mfa",
            factors: await client.totpFactors(material.session),
          };
      } catch {
        // Revoked or expired sessions require fresh private sign-in, never stale evidence.
      }
    }
    return { mode: "credentials", allowSignup: false };
  }
  /** Native authenticated collector only; a confirmation click is permission to check, never completion evidence. */
  async humanInput(
    context: OperationContext,
    revision: number,
    input: unknown,
  ) {
    await this.authorize(context);
    if (context.actor.actorKind !== "human")
      throw new AuthorizationError("denied");
    const project = z.strictObject({
      projectUrl: z.string().max(2048),
      publishableKey: z.string().max(4096),
    });
    const credentials = z.strictObject({
      action: z.enum(["sign-in", "sign-up"]),
      email: z.email().max(254),
      password: z.string().min(1).max(1024),
    });
    const mfa = z.strictObject({
      factorId: z.uuid(),
      code: z.string().regex(/^\d{6}$/),
    });
    const parsed = z
      .union([
        project,
        credentials,
        mfa,
        z.strictObject({ confirmed: z.literal(true) }),
      ])
      .safeParse(input);
    if (!parsed.success) throw new AuthorizationError("invalid_request");
    const collectingProject = "projectUrl" in parsed.data,
      collectingMfa = "factorId" in parsed.data,
      confirming = "confirmed" in parsed.data;
    const planned = await this.store.transaction(async (tx) =>
      (
        await tx.get<RunRecord>({
          tenant: context.actor.tenantId,
          kind: "run",
          id: context.runId,
        })
      )?.value.nodes.find((node) => node.id === context.nodeId),
    );
    if (
      !planned ||
      !(
        collectingProject
          ? ["supabase.prepare-project"]
          : ["supabase.obtain-session", "supabase.verify-access"]
      ).includes(planned.operationId)
    )
      throw new AuthorizationError("denied");
    const operationId = planned.operationId;
    const recovering = operationId === "supabase.verify-access";
    if (collectingMfa && !recovering) throw new AuthorizationError("denied");
    if (recovering && confirming) throw new AuthorizationError("denied");
    if (collectingProject) this.client(context, project.parse(parsed.data));
    const fields = collectingProject
      ? ["projectUrl", "publishableKey"]
      : collectingMfa
        ? ["factorId", "code"]
        : ["action", "email", "password"];
    const binding = {
      purpose: collectingProject
        ? "supabase-project"
        : collectingMfa
          ? "supabase-mfa"
          : "supabase-user",
      provider: "supabase",
      operationId,
      operationVersion: "1.0.0",
      runId: context.runId,
      nodeId: context.nodeId,
      revision,
      fields,
    };
    const reference = confirming
      ? undefined
      : await this.broker.collect(context.actor, binding, parsed.data);
    await this.store.transaction(async (tx) => {
      const key = {
          tenant: context.actor.tenantId,
          kind: "run" as const,
          id: context.runId,
        },
        run = await tx.get<RunRecord>(key);
      const node = run?.value.nodes.find(
        (node) =>
          node.id === context.nodeId && node.operationId === operationId,
      );
      const stateKey = {
          tenant: context.actor.tenantId,
          kind: "node" as const,
          id: `${context.runId}:${context.nodeId}`,
        },
        state = await tx.get<{ state: string }>(stateKey);
      if (
        !run ||
        !node ||
        run.revision !== revision ||
        run.value.status !== "active" ||
        run.value.subjectId !== context.actor.subjectId ||
        !["awaiting-human", "uncertain"].includes(state?.value.state ?? "")
      )
        throw new AuthorizationError("denied");
      for (const dependency of node.dependsOn) {
        const parent = await tx.get<{ verified: boolean }>({
          tenant: context.actor.tenantId,
          kind: "node",
          id: `${context.runId}:${dependency}`,
        });
        if (!parent?.value.verified) throw new AuthorizationError("denied");
      }
      const fence = await tx.claim(
        key,
        `collector-${createHash("sha256").update(context.commandId).digest("hex")}`,
        30000,
      );
      if (reference) {
        const values = await this.broker.consumeIn(
          tx,
          context.actor,
          binding,
          reference,
          context.commandId,
        );
        if (collectingProject)
          await this.write(
            tx,
            context,
            "project",
            { project: project.parse(values) },
            86400000,
          );
        else if (collectingMfa) {
          const session = await tx.get<Material>(this.key(context, "session"));
          if (
            !session?.value.session ||
            session.value.expires <= (await tx.now())
          )
            throw new AuthorizationError("denied");
          await this.write(
            tx,
            context,
            "input",
            { mfa: mfa.parse(values) },
            300000,
          );
        } else {
          const value = credentials.parse(values);
          if (
            value.action === "sign-up" &&
            (await tx.get(this.signupKey(context)))
          )
            throw new AuthorizationError("denied");
          await this.write(
            tx,
            context,
            "input",
            { credentials: value },
            900000,
          );
          if (recovering) {
            const binding = node.bindings.session;
            const producer =
              binding?.from === "output"
                ? run.value.nodes.find(
                    (item) =>
                      item.id === binding.node &&
                      item.operationId === "supabase.obtain-session",
                  )
                : undefined;
            if (!producer || !node.dependsOn.includes(producer.id))
              throw new AuthorizationError("denied");
            const sessionKey = {
              tenant: context.actor.tenantId,
              kind: "node" as const,
              id: `${context.runId}:${producer.id}`,
            };
            const prior = await tx.get(sessionKey);
            if (!prior) throw new AuthorizationError("denied");
            await tx.put(
              sessionKey,
              { state: "awaiting-human", verified: false, outputs: {} },
              prior.revision,
            );
            await appendSemanticTransition(
              tx,
              context.actor,
              context.runId,
              {
                nodeId: producer.id,
                operationId: producer.operationId,
                operationVersion: producer.operationVersion,
                actorKind: "human",
                kind: "transition",
                beforeState: "complete",
                afterState: "awaiting-human",
                publicBindings: {},
                verification: "pending",
              },
              {},
            );
            for (const kind of ["session", "connection"] as const) {
              const key = this.key(context, kind),
                material = await tx.get(key);
              if (material) await tx.delete(key, material.revision);
            }
          }
        }
      } else {
        const material = await tx.get<Material>(this.key(context, "input"));
        if (
          !material?.value.credentials ||
          material.value.expires <= (await tx.now())
        )
          throw new AuthorizationError("denied");
      }
      if (state?.value.state === "uncertain")
        await tx.put(
          stateKey,
          { state: "awaiting-human", verified: false, outputs: {} },
          state.revision,
        );
      await tx.put(key, run.value, run.revision);
      await appendSemanticTransition(
        tx,
        context.actor,
        context.runId,
        {
          nodeId: node.id,
          operationId,
          operationVersion: "1.0.0",
          actorKind: "human",
          kind: "handoff",
          beforeState: state!.value.state,
          afterState: "awaiting-human",
          publicBindings: {},
          verification: "pending",
        },
        {},
      );
      await tx.assertFence(fence);
      await tx.cancel(key);
    });
    if (reference)
      await this.broker.complete(
        context.actor,
        binding,
        reference,
        context.commandId,
      );
  }
}
