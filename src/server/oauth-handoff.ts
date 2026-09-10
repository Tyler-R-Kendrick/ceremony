import { createHash, randomBytes } from "node:crypto";
import { z } from "zod";
import type { ActorContext } from "../core/operation-contracts.js";
import type { RunRecord } from "./commands.js";
import { AuthorizationError } from "./identity.js";
import { appendSemanticTransition } from "./demonstrations.js";
import type {
  AsyncCeremonyStore,
  AsyncTransaction,
  RecordKey,
} from "./persistence/index.js";
import type { OperationContext } from "./recipes/registry.js";

export interface AuthorizationCodeDriver<Session> {
  authorizationUrl(state: string): string;
  validateCallback(url: string, state: string): void;
  exchange(url: string, state: string): Promise<Session>;
}
const indexSchema = z.strictObject({
  runId: z.string().min(1).max(200),
  nodeId: z.string().min(1).max(200),
  subjectId: z.string().min(1).max(200),
  sessionId: z.string().min(1).max(200),
  expires: z.number().int().positive(),
});
type Index = z.infer<typeof indexSchema>;
const attemptSchema = z.strictObject({
  phase: z.enum(["waiting", "ready", "exchanging", "issued", "uncertain"]),
  expires: z.number().int().positive(),
  state: z
    .string()
    .regex(/^[A-Za-z0-9_-]{43}$/)
    .optional(),
  callback: z.string().max(8192).url().optional(),
  session: z.unknown().optional(),
  commandId: z.string().min(1).max(200).optional(),
  effectId: z.string().min(1).max(200).optional(),
});
type Attempt<Session> = Omit<z.infer<typeof attemptSchema>, "session"> & {
  session?: Session;
};

/** Private, encrypted OAuth handoff carrier; registered domain operations still own verification and completion. */
export class DurableAuthorizationCode<Session> {
  constructor(
    private readonly store: AsyncCeremonyStore,
    private readonly options: {
      provider: string;
      profile: string;
      operationId: string;
      operationVersion: string;
      sessionSchema: z.ZodType<Session>;
      authorize(context: OperationContext): Promise<void>;
      driver(
        context: OperationContext,
      ): Promise<AuthorizationCodeDriver<Session>>;
      expiresAt(session: Session): number;
    },
  ) {}
  private async load(tx: AsyncTransaction, key: RecordKey) {
    const record = await tx.get(key);
    if (!record) return undefined;
    const { session, ...parsed } = attemptSchema.parse(record.value);
    const value: Attempt<Session> = {
      ...parsed,
      ...(session === undefined
        ? {}
        : { session: this.options.sessionSchema.parse(session) }),
    };
    return { revision: record.revision, value };
  }
  private key(context: OperationContext): RecordKey {
    const binding = [
      context.actor.tenantId,
      context.actor.subjectId,
      context.actor.sessionId,
      context.runId,
      context.nodeId,
      this.options.provider,
      this.options.profile,
      context.target,
      context.origin,
      context.environment,
      context.configurationVersion,
    ];
    return {
      tenant: context.actor.tenantId,
      kind: "handoff",
      id: `oauth-code:${createHash("sha256").update(JSON.stringify(binding)).digest("hex")}`,
    };
  }
  private index(tenant: string, state: string): RecordKey {
    // State is generated with 256 bits of entropy; this is an index, never an authorization substitute.
    return {
      tenant,
      kind: "handoff",
      id: `oauth-state:${createHash("sha256").update(state).digest("hex")}`,
    };
  }
  private async guard(
    tx: AsyncTransaction,
    context: OperationContext,
    command = false,
  ) {
    const run = await tx.get<RunRecord>({
      tenant: context.actor.tenantId,
      kind: "run",
      id: context.runId,
    });
    const node = run?.value.nodes.find((node) => node.id === context.nodeId);
    if (
      !run ||
      !node ||
      run.value.status === "cancelled" ||
      run.value.subjectId !== context.actor.subjectId ||
      run.value.sessionId !== context.actor.sessionId ||
      run.value.provider !== this.options.provider ||
      run.value.profile !== this.options.profile ||
      run.value.target !== context.target ||
      run.value.origin !== context.origin ||
      run.value.environment !== context.environment ||
      run.value.configurationVersion !== context.configurationVersion ||
      node.operationId !== this.options.operationId ||
      node.operationVersion !== this.options.operationVersion
    )
      throw new AuthorizationError("denied");
    for (const id of node.dependsOn) {
      const prerequisite = await tx.get<{ verified: boolean; state: string }>({
        tenant: context.actor.tenantId,
        kind: "node",
        id: `${context.runId}:${id}`,
      });
      if (
        !prerequisite?.value.verified ||
        prerequisite.value.state !== "complete"
      )
        throw new AuthorizationError("denied");
    }
    if (command) {
      const record = await tx.get<{
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
        run.value.status !== "active" ||
        record?.value.state !== "running" ||
        record.value.runId !== context.runId ||
        record.value.nodeId !== context.nodeId ||
        record.value.effectId !== context.effectId
      )
        throw new AuthorizationError("denied");
    }
    return run;
  }
  private async authorize(context: OperationContext) {
    context.signal.throwIfAborted();
    await this.options.authorize(context);
  }
  /** Called only inside a registered, admitted operation. No provider request occurs. */
  async prepare(context: OperationContext): Promise<void> {
    await this.authorize(context);
    await this.store.transaction(async (tx) => {
      await this.guard(tx, context, true);
      const key = this.key(context);
      if (await tx.get(key)) return; // Expiry/uncertainty needs explicit recovery, never implicit reauthorization.
      const state = randomBytes(32).toString("base64url"),
        expires = (await tx.now()) + 600000;
      await tx.put(
        key,
        { phase: "waiting", state, expires } satisfies Attempt<Session>,
        null,
      );
      await tx.put(
        this.index(context.actor.tenantId, state),
        {
          runId: context.runId,
          nodeId: context.nodeId,
          subjectId: context.actor.subjectId,
          sessionId: context.actor.sessionId,
          expires,
        } satisfies Index,
        null,
      );
    });
  }
  /** Private human surface only; the returned URL must never become a model tool result. */
  async humanUrl(context: OperationContext): Promise<string> {
    await this.authorize(context);
    if (context.actor.actorKind !== "human")
      throw new AuthorizationError("denied");
    const record = await this.store.transaction(async (tx) => {
      await this.guard(tx, context);
      const record = await this.load(tx, this.key(context));
      if (
        record?.value.phase !== "waiting" ||
        !record.value.state ||
        record.value.expires <= (await tx.now())
      )
        throw new AuthorizationError("denied");
      return record.value;
    });
    return (await this.options.driver(context)).authorizationUrl(record.state!);
  }
  /** Route a fixed provider callback only after authenticating the original recipient. */
  async resolve(
    actor: ActorContext,
    url: URL,
  ): Promise<{ runId: string; nodeId: string }> {
    const state = url.searchParams.get("state");
    if (
      actor.actorKind !== "human" ||
      !state ||
      !/^[A-Za-z0-9_-]{43}$/.test(state) ||
      url.searchParams.getAll("state").length !== 1
    )
      throw new AuthorizationError("denied");
    return this.store.transaction(async (tx) => {
      const record = await tx.get(this.index(actor.tenantId, state));
      const index = record && indexSchema.parse(record.value);
      if (
        !index ||
        index.subjectId !== actor.subjectId ||
        index.sessionId !== actor.sessionId ||
        index.expires <= (await tx.now())
      )
        throw new AuthorizationError("denied");
      // This correlation lookup grants no effect authority; acceptCallback rechecks the full run and host policy.
      return { runId: index.runId, nodeId: index.nodeId };
    });
  }
  /** Store the validated callback privately. Receipt cannot exchange a code or certify access. */
  async acceptCallback(context: OperationContext, url: URL): Promise<void> {
    await this.authorize(context);
    if (context.actor.actorKind !== "human")
      throw new AuthorizationError("denied");
    const key = this.key(context);
    const prior = await this.store.transaction(async (tx) => {
      const run = await this.guard(tx, context);
      const node = await tx.get<{ state: string }>({
        tenant: context.actor.tenantId,
        kind: "node",
        id: `${context.runId}:${context.nodeId}`,
      });
      const record = await this.load(tx, key);
      if (
        run.value.status !== "active" ||
        node?.value.state !== "awaiting-human" ||
        record?.value.phase !== "waiting" ||
        !record.value.state ||
        record.value.expires <= (await tx.now())
      )
        throw new AuthorizationError("denied");
      return record;
    });
    (await this.options.driver(context)).validateCallback(
      url.href,
      prior.value.state!,
    );
    await this.authorize(context);
    await this.store.transaction(async (tx) => {
      const run = await this.guard(tx, context);
      if (
        run.value.status !== "active" ||
        prior.value.expires <= (await tx.now())
      )
        throw new AuthorizationError("denied");
      await tx.put(
        key,
        { ...prior.value, phase: "ready", callback: url.href },
        prior.revision,
      );
      const indexKey = this.index(context.actor.tenantId, prior.value.state!);
      const index = await tx.get(indexKey);
      if (index) await tx.delete(indexKey, index.revision);
      await tx.put(
        { tenant: context.actor.tenantId, kind: "run", id: context.runId },
        run.value,
        run.revision,
      );
      await appendSemanticTransition(
        tx,
        context.actor,
        context.runId,
        {
          nodeId: context.nodeId,
          operationId: this.options.operationId,
          operationVersion: this.options.operationVersion,
          actorKind: "human",
          kind: "handoff",
          beforeState: "awaiting-human",
          afterState: "awaiting-human",
          publicBindings: {},
          verification: "pending",
        },
        {},
      );
    });
  }
  /** Explicit human recovery starts new consent; it neither retries an old code nor revokes any upstream grant. */
  async restart(
    context: OperationContext,
    expectedRevision: number,
  ): Promise<void> {
    await this.authorize(context);
    if (context.actor.actorKind !== "human")
      throw new AuthorizationError("denied");
    await this.store.transaction(async (tx) => {
      const run = await this.guard(tx, context);
      const key = this.key(context),
        prior = await this.load(tx, key);
      const nodeKey: RecordKey = {
        tenant: context.actor.tenantId,
        kind: "node",
        id: `${context.runId}:${context.nodeId}`,
      };
      const node = await tx.get<{ state: string }>(nodeKey);
      if (
        run.value.status !== "active" ||
        run.revision !== expectedRevision ||
        !prior ||
        !node ||
        !["awaiting-human", "uncertain"].includes(node.value.state) ||
        (prior.value.phase !== "uncertain" &&
          prior.value.expires > (await tx.now()))
      )
        throw new AuthorizationError("denied");
      await tx.cancel(key);
      await tx.cancel({
        tenant: context.actor.tenantId,
        kind: "run",
        id: context.runId,
      });
      if (prior.value.state) {
        const indexKey = this.index(context.actor.tenantId, prior.value.state),
          index = await tx.get(indexKey);
        if (index) await tx.delete(indexKey, index.revision);
      }
      const state = randomBytes(32).toString("base64url"),
        expires = (await tx.now()) + 600000;
      await tx.put(
        key,
        { phase: "waiting", state, expires } satisfies Attempt<Session>,
        prior.revision,
      );
      await tx.put(
        this.index(context.actor.tenantId, state),
        {
          runId: context.runId,
          nodeId: context.nodeId,
          subjectId: context.actor.subjectId,
          sessionId: context.actor.sessionId,
          expires,
        } satisfies Index,
        null,
      );
      await tx.put(
        nodeKey,
        { state: "awaiting-human", verified: false, outputs: {} },
        node.revision,
      );
      await tx.put(
        { tenant: context.actor.tenantId, kind: "run", id: context.runId },
        run.value,
        run.revision,
      );
      await appendSemanticTransition(
        tx,
        context.actor,
        context.runId,
        {
          nodeId: context.nodeId,
          operationId: this.options.operationId,
          operationVersion: this.options.operationVersion,
          actorKind: "human",
          kind: "handoff",
          beforeState: node.value.state,
          afterState: "awaiting-human",
          publicBindings: {},
          verification: "pending",
        },
        {},
      );
    });
  }
  /** The registered operation invokes this. Retried commands never repeat a possibly consumed code. */
  async exchange(
    context: OperationContext,
  ): Promise<
    | { state: "issued"; session: Session }
    | { state: "awaiting-human" | "uncertain" }
  > {
    await this.authorize(context);
    const key = this.key(context);
    const admitted = await this.store.transaction(async (tx) => {
      await this.guard(tx, context, true);
      const record = await this.load(tx, key);
      if (!record || record.value.expires <= (await tx.now()))
        return { state: "awaiting-human" as const };
      if (record.value.phase === "issued" && record.value.session !== undefined)
        return { state: "issued" as const, session: record.value.session };
      if (
        record.value.phase === "exchanging" ||
        record.value.phase === "uncertain"
      )
        return { state: "uncertain" as const };
      if (
        record.value.phase !== "ready" ||
        !record.value.callback ||
        !record.value.state
      )
        return { state: "awaiting-human" as const };
      const fence = await tx.claim(
        key,
        createHash("sha256").update(context.effectId).digest("hex"),
        30000,
      );
      await tx.put(
        key,
        {
          ...record.value,
          phase: "exchanging",
          commandId: context.commandId,
          effectId: context.effectId,
        },
        record.revision,
      );
      return { state: "exchange" as const, record: record.value, fence };
    });
    if (admitted.state !== "exchange") return admitted;
    try {
      const session = this.options.sessionSchema.parse(
        await (
          await this.options.driver(context)
        ).exchange(admitted.record.callback!, admitted.record.state!),
      );
      await this.authorize(context);
      await this.store.transaction(async (tx) => {
        await this.guard(tx, context, true);
        await tx.assertFence(admitted.fence);
        const record = await this.load(tx, key);
        const expires = this.options.expiresAt(session);
        if (
          !record ||
          record.value.commandId !== context.commandId ||
          record.value.effectId !== context.effectId ||
          !Number.isSafeInteger(expires) ||
          expires <= (await tx.now())
        )
          throw new AuthorizationError("denied");
        await tx.put(
          key,
          {
            phase: "issued",
            session,
            expires,
            commandId: context.commandId,
            effectId: context.effectId,
          } satisfies Attempt<Session>,
          record.revision,
        );
      });
      return { state: "issued", session };
    } catch {
      await this.store.transaction(async (tx) => {
        try {
          await tx.assertFence(admitted.fence);
        } catch {
          return;
        }
        const record = await this.load(tx, key);
        if (
          record?.value.phase === "exchanging" &&
          record.value.effectId === context.effectId
        )
          await tx.put(
            key,
            {
              phase: "uncertain",
              expires: record.value.expires,
              commandId: context.commandId,
              effectId: context.effectId,
            } satisfies Attempt<Session>,
            record.revision,
          );
      });
      return { state: "uncertain" };
    }
  }
}
