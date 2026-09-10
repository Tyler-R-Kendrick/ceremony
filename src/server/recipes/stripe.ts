import { createHash } from "node:crypto";
import Stripe from "stripe";
import { z } from "zod";
import type { RecipeDefinition } from "../../core/recipe-contracts.js";
import { AuthorizationError } from "../identity.js";
import type {
  AsyncCeremonyStore,
  AsyncTransaction,
  RecordKey,
} from "../persistence/index.js";
import { AsyncPrivateCollectionBroker } from "../persistence/collections.js";
import type { RunRecord } from "../commands.js";
import { runArazzo } from "../arazzo.js";
import { appendSemanticTransition } from "../demonstrations.js";
import { serviceWorkflows } from "../services.js";
import {
  OperationRegistry,
  type OperationContext,
  type OperationResult,
  type VocabularyEntry,
} from "./registry.js";

const keySchema = z
  .string()
  .max(512)
  .regex(/^(sk|rk)_(test|live)_[A-Za-z0-9]+$/);
const artifactSchema = z
  .string()
  .regex(/^stripe:(account|credential|connection):[a-f0-9]{64}$/);
const slot = (contract: string) => ({ contract, required: true });
export const stripeVocabulary = new Map<string, VocabularyEntry>(
  ["account", "credential", "connection"].map((kind) => [
    `stripe.${kind}`,
    {
      schema: artifactSchema,
      classification: "artifact",
      provider: "stripe",
      profile: "stripe-api-key",
    },
  ]),
);
export const stripeConnectionRecipe: RecipeDefinition = {
  schemaVersion: 1,
  id: "stripe-connect",
  title: "Connect Stripe",
  description:
    "Open or create an account, obtain a restricted key, and verify read-only access. Account readiness is a setup choice, not proof of account ownership.",
  inputs: {},
  invocations: [
    {
      id: "account",
      use: {
        kind: "operation",
        id: "stripe.prepare-account",
        version: "1.0.0",
      },
      dependsOn: [],
      bindings: {},
    },
    {
      id: "credential",
      use: { kind: "operation", id: "stripe.obtain-key", version: "1.0.0" },
      dependsOn: ["account"],
      bindings: {
        account: { from: "output", node: "account", name: "account" },
      },
    },
    {
      id: "access",
      use: { kind: "operation", id: "stripe.verify-access", version: "1.0.0" },
      dependsOn: ["credential"],
      bindings: {
        credential: { from: "output", node: "credential", name: "credential" },
      },
    },
  ],
  outputs: { connection: { node: "access", name: "connection" } },
};
type Artifact = {
  scope: string;
  kind: "account" | "credential" | "connection";
  expires: number;
  token?: string;
  evidenceEffect?: string;
};
export type StripeChildrenOptions = {
  /** Host-derived configuration. Keys remain server-only, including keys from the session Environment. */
  configuration(
    context: OperationContext,
  ): Promise<{ version: string; token?: string }>;
  authorize(context: OperationContext): Promise<void>;
  fetch?: typeof fetch;
};

/** Real Stripe SDK leaves. Account setup is a human choice; only Balance verification proves API access. */
export class AsyncStripeChildren {
  private readonly broker: AsyncPrivateCollectionBroker;
  constructor(
    private readonly store: AsyncCeremonyStore,
    private readonly options: StripeChildrenOptions,
  ) {
    this.broker = new AsyncPrivateCollectionBroker(store);
  }
  private scope(context: OperationContext) {
    return createHash("sha256")
      .update(
        JSON.stringify([
          context.actor.tenantId,
          context.actor.subjectId,
          context.actor.sessionId,
          "stripe",
          "stripe-api-key",
          context.origin,
          context.environment,
          context.configurationVersion,
          context.target,
        ]),
      )
      .digest("hex");
  }
  private key(context: OperationContext, kind: Artifact["kind"]): RecordKey {
    return {
      tenant: context.actor.tenantId,
      kind: "artifact",
      id: `stripe:${kind}:${this.scope(context)}`,
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
      run.value.status === "cancelled" ||
      run.value.provider !== "stripe" ||
      run.value.profile !== "stripe-api-key" ||
      run.value.target !== context.target ||
      run.value.origin !== context.origin ||
      run.value.environment !== context.environment ||
      run.value.configurationVersion !== context.configurationVersion
    )
      throw new AuthorizationError("denied");
    const configuration = await this.options.configuration(context);
    if (configuration.version !== context.configurationVersion)
      throw new AuthorizationError("denied");
    return configuration;
  }
  private async read(
    context: OperationContext,
    kind: Artifact["kind"],
    reference?: unknown,
  ) {
    await this.authorize(context);
    const key = this.key(context, kind);
    if (reference !== undefined && reference !== key.id)
      throw new AuthorizationError("denied");
    return this.store.transaction(async (tx) => {
      const record = await tx.get<Artifact>(key);
      return record &&
        record.value.scope === this.scope(context) &&
        record.value.kind === kind &&
        record.value.expires > (await tx.now())
        ? record.value
        : undefined;
    });
  }
  private async saveIn(
    tx: AsyncTransaction,
    context: OperationContext,
    kind: Artifact["kind"],
    data: Partial<Pick<Artifact, "token" | "evidenceEffect">> = {},
  ) {
    const run = await tx.get<RunRecord>({
      tenant: context.actor.tenantId,
      kind: "run",
      id: context.runId,
    });
    if (
      !run ||
      run.value.subjectId !== context.actor.subjectId ||
      run.value.status !== "active" ||
      run.value.configurationVersion !== context.configurationVersion
    )
      throw new AuthorizationError("denied");
    const key = this.key(context, kind);
    const prior = await tx.get(key);
    await tx.put(
      key,
      {
        scope: this.scope(context),
        kind,
        expires: (await tx.now()) + 86400000,
        ...data,
      } satisfies Artifact,
      prior?.revision ?? null,
    );
    return key.id;
  }
  private async save(
    context: OperationContext,
    kind: Artifact["kind"],
    data: Partial<Pick<Artifact, "token" | "evidenceEffect">> = {},
  ) {
    await this.authorize(context);
    return this.store.transaction(async (tx) => {
      const command = await tx.get<{ state: string; effectId: string }>({
        tenant: context.actor.tenantId,
        kind: "command",
        id: context.commandId,
      });
      if (
        !command ||
        command.value.state !== "running" ||
        command.value.effectId !== context.effectId
      )
        throw new AuthorizationError("denied");
      return this.saveIn(tx, context, kind, data);
    });
  }
  private result(kind: Artifact["kind"], reference: string): OperationResult {
    return { state: "complete", outputs: { [kind]: reference } };
  }
  register(registry: OperationRegistry) {
    for (const operation of [
      {
        id: "prepare-account",
        kind: "account" as const,
        input: undefined,
        handler: (context: OperationContext) => this.prepareAccount(context),
      },
      {
        id: "obtain-key",
        kind: "credential" as const,
        input: "account" as const,
        handler: (context: OperationContext, inputs: Record<string, unknown>) =>
          this.obtainKey(context, inputs.account),
      },
      {
        id: "verify-access",
        kind: "connection" as const,
        input: "credential" as const,
        handler: (context: OperationContext, inputs: Record<string, unknown>) =>
          this.verifyAccess(context, inputs.credential),
      },
    ])
      registry.register({
        contract: {
          id: `stripe.${operation.id}`,
          version: "1.0.0",
          provider: "stripe",
          profile: "stripe-api-key",
          inputs: operation.input
            ? { [operation.input]: slot(`stripe.${operation.input}`) }
            : {},
          outputs: { [operation.kind]: slot(`stripe.${operation.kind}`) },
          effects: [`stripe.${operation.id}`],
          verifier:
            operation.kind === "connection"
              ? "stripe.balance-read"
              : "stripe.bound-setup",
          humanFallback:
            operation.kind === "account"
              ? "stripe.own-browser"
              : "stripe.private-collector",
        },
        inputSchema: z.strictObject(
          operation.input ? { [operation.input]: artifactSchema } : {},
        ),
        outputSchema: z.strictObject({ [operation.kind]: artifactSchema }),
        classifications: {},
        fixtures: ["tests/stripe-children.test.ts"],
        handler: async (context, inputs) => {
          try {
            return await operation.handler(context, inputs);
          } catch {
            return {
              state:
                operation.kind === "connection" ? "awaiting-human" : "failed",
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
          if (operation.kind !== "connection") return true;
          if (!artifact.token) return false;
          // The effect's handler just performed this read. Reuse has a different effect identity and must recheck Stripe.
          if (artifact.evidenceEffect !== context.effectId)
            await this.balance(context, artifact.token);
          return true;
        },
      });
  }
  async prepareAccount(context: OperationContext): Promise<OperationResult> {
    const configured = await this.authorize(context);
    if (configured.token || (await this.read(context, "account")))
      return this.result("account", await this.save(context, "account"));
    return { state: "awaiting-human", outputs: {} };
  }
  async obtainKey(
    context: OperationContext,
    account: unknown,
  ): Promise<OperationResult> {
    if (!(await this.read(context, "account", account)))
      throw new AuthorizationError("denied");
    const configured = await this.authorize(context);
    const collected = await this.read(context, "credential");
    const token = configured.token ?? collected?.token;
    if (!token || !keySchema.safeParse(token).success)
      return { state: "awaiting-human", outputs: {} };
    return this.result(
      "credential",
      await this.save(context, "credential", { token }),
    );
  }
  private async balance(context: OperationContext, token: string) {
    await this.authorize(context);
    const transport = this.options.fetch ?? fetch;
    const stripe = new Stripe(keySchema.parse(token), {
      maxNetworkRetries: 0,
      timeout: 15000,
      httpClient: Stripe.createFetchHttpClient((url, init) =>
        transport(url, {
          ...init,
          redirect: "error",
          signal: AbortSignal.any([
            context.signal,
            ...(init?.signal ? [init.signal] : []),
          ]),
        }),
      ),
    });
    try {
      await runArazzo(
        serviceWorkflows.stripe!,
        "verify-access",
        new Map([
          [
            "GetBalance",
            async () => {
              const balance = await stripe.balance.retrieve();
              if (
                balance.object !== "balance" ||
                typeof balance.livemode !== "boolean" ||
                balance.livemode !== token.includes("_live_")
              )
                throw new Error();
            },
          ],
        ]),
      );
    } catch {
      throw new AuthorizationError("denied");
    }
    await this.authorize(context);
  }
  async verifyAccess(
    context: OperationContext,
    credential: unknown,
  ): Promise<OperationResult> {
    const artifact = await this.read(context, "credential", credential);
    if (!artifact?.token) throw new AuthorizationError("denied");
    await this.balance(context, artifact.token);
    return this.result(
      "connection",
      await this.save(context, "connection", {
        token: artifact.token,
        evidenceEffect: context.effectId,
      }),
    );
  }
  /** Authenticated native collector only. Acknowledgment enables key acquisition, never authenticated access. */
  async humanInput(
    context: OperationContext,
    revision: number,
    input: unknown,
  ): Promise<void> {
    await this.authorize(context);
    if (context.actor.actorKind !== "human")
      throw new AuthorizationError("denied");
    const parsed = z
      .union([
        z.strictObject({ accountReady: z.literal(true) }),
        z.strictObject({ token: keySchema }),
      ])
      .safeParse(input);
    if (!parsed.success) throw new AuthorizationError("invalid_request");
    const collecting = "token" in parsed.data;
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
        collecting
          ? ["stripe.obtain-key", "stripe.verify-access"]
          : ["stripe.prepare-account"]
      ).includes(planned.operationId)
    )
      throw new AuthorizationError("denied");
    const operationId = planned.operationId;
    const binding = {
      purpose: "stripe-key",
      provider: "stripe",
      operationId,
      operationVersion: "1.0.0",
      runId: context.runId,
      nodeId: context.nodeId,
      revision,
      fields: ["token"],
    };
    const reference = collecting
      ? await this.broker.collect(context.actor, binding, parsed.data)
      : undefined;
    await this.store.transaction(async (tx) => {
      const runKey = {
        tenant: context.actor.tenantId,
        kind: "run" as const,
        id: context.runId,
      };
      const run = await tx.get<RunRecord>(runKey);
      const node = run?.value.nodes.find(
        (n) => n.id === context.nodeId && n.operationId === operationId,
      );
      const state = await tx.get<{ state: string }>({
        tenant: context.actor.tenantId,
        kind: "node",
        id: `${context.runId}:${context.nodeId}`,
      });
      if (
        !run ||
        !node ||
        run.revision !== revision ||
        run.value.subjectId !== context.actor.subjectId ||
        run.value.status !== "active" ||
        state?.value.state !== "awaiting-human"
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
        runKey,
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
        await this.saveIn(tx, context, "credential", { token: values.token! });
      } else await this.saveIn(tx, context, "account");
      await tx.put(runKey, run.value, run.revision);
      await appendSemanticTransition(
        tx,
        context.actor,
        context.runId,
        {
          nodeId: node.id,
          operationId: node.operationId,
          operationVersion: node.operationVersion,
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
    if (reference)
      await this.broker.complete(
        context.actor,
        binding,
        reference,
        context.commandId,
      );
  }
}
