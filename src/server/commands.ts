import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";
import {
  commandEnvelopeSchema,
  type CommandEnvelope,
} from "../core/teaching-contracts.js";
import type { ActorContext } from "../core/operation-contracts.js";
import type { Binding, RecipeOutcome } from "../core/recipe-contracts.js";
import {
  type AsyncCeremonyStore,
  type AsyncTransaction,
  PersistenceConflict,
} from "./persistence/index.js";
import { AuthorizationError, requireCapability } from "./identity.js";
import {
  OperationRegistry,
  type OperationContext,
  type OperationResult,
  type RegisteredOperation,
} from "./recipes/registry.js";
import { evaluateOutcome } from "./recipes/outcome.js";
import { appendSemanticTransition } from "./demonstrations.js";

export type RunPlanNode = {
  id: string;
  operationId: string;
  operationVersion: string;
  dependsOn: string[];
  bindings: Record<string, Binding>;
  /**
   * The authorization context of a step that runs under a different
   * connector than the run's own, resolved by the host for this actor when
   * the run was planned. Absent means the run's context.
   */
  context?: NodeContext;
  /** Success criteria and bounded retry, from the recipe invocation. */
  outcome?: RecipeOutcome;
};
export type RunContext = {
  provider: string;
  profile: string;
  target: string;
  origin: string;
  environment: string;
  configurationVersion: string;
};
export type NodeContext = RunContext & { connectorId: string };
export type RunRecord = RunContext & {
  id: string;
  subjectId: string;
  sessionId: string;
  status: "active" | "cancelled" | "complete";
  nodes: RunPlanNode[];
  inputs: Record<string, unknown>;
  continuation?: string;
  /**
   * Present only on the view a host's authorization check receives for a step
   * with its own context: the run's context fields are that step's, and this
   * names the step and its connector. Never stored.
   */
  scope?: { nodeId: string; connectorId: string };
};
type NodeRecord = {
  state: OperationResult["state"];
  verified: boolean;
  outputs: Record<string, unknown>;
  diagnosticCode?: "verification-rejected";
  /** Failed attempts of a step with an outcome. */
  attempts?: number;
  /** Earliest time the next attempt may start, when a retry is allowed. */
  retryAt?: number;
  /** A step with an outcome that failed and may not be attempted again. */
  exhausted?: boolean;
};
const contextFields = [
  "provider",
  "profile",
  "target",
  "origin",
  "environment",
  "configurationVersion",
] as const;
function contextOf(run: RunRecord, node: RunPlanNode | undefined): RunContext {
  const source = node?.context ?? run;
  return Object.fromEntries(
    contextFields.map((name) => [name, source[name]]),
  ) as RunContext;
}
/**
 * The run as a step's authorization sees it: a step planned under another
 * connector is checked against that connector's context, never the run's.
 */
export function scopedRun(
  run: RunRecord,
  node: RunPlanNode | undefined,
): RunRecord {
  if (!node?.context) return run;
  return {
    ...run,
    ...contextOf(run, node),
    scope: { nodeId: node.id, connectorId: node.context.connectorId },
  };
}
const sameContext = (a: RunContext, b: RunContext) =>
  contextFields.every((name) => a[name] === b[name]);
type CommandRecord = {
  digest: string;
  runId: string;
  state:
    | "admitted"
    | "running"
    | "complete"
    | "awaiting-human"
    | "verifying"
    | "uncertain"
    | "failed";
  effectId: string;
  nodeId: string;
};
export type CommandStatus = {
  commandId: string;
  runId: string;
  nodeId: string;
  revision: number;
  state: CommandRecord["state"] | "cancelled";
  verified: boolean;
};
type Reauthorize = (
  actor: ActorContext,
  run: RunRecord,
  operationId: string,
  tx?: AsyncTransaction,
) => Promise<boolean>;
const key = (
  actor: ActorContext,
  kind: "run" | "node" | "command" | "effect" | "outbox" | "continuation",
  id: string,
) => ({ tenant: actor.tenantId, kind, id });
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([k, v]) => [k, canonical(v)]),
    );
  return value;
}
const digest = (value: unknown) =>
  createHash("sha256")
    .update(JSON.stringify(canonical(value)))
    .digest("hex");

/** Shared authority service. Actor context is supplied by trusted host middleware, never command JSON. */
export class ProtectedCommandService {
  constructor(
    readonly store: AsyncCeremonyStore,
    readonly registry: OperationRegistry,
    readonly reauthorize: Reauthorize,
  ) {}
  /**
   * Whether a context with this provider/profile may include the operation.
   * A node must match the provider and profile of the context it runs in (the
   * run's, or the one its recipe placed it under), so one provider's operation
   * never executes under another's authorization context. The exceptions are
   * closed: steps the registry holds as provider-neutral, authored steps under
   * an authored profile, and the authored account bootstrap ahead of a GitHub
   * App installation. That bootstrap is not neutral: it finds the provider
   * origin through authored discovery (or GitHub's known origin) and verifies
   * against authored session state, so it stays scoped here.
   */
  admits(
    context: Pick<RunContext, "provider" | "profile">,
    operationId: string,
    operationVersion: string,
  ): boolean {
    const operation = this.registry.get(operationId, operationVersion);
    if (!operation) return false;
    if (this.registry.isNeutral(operationId, operationVersion)) return true;
    const { provider, profile } = operation.contract;
    if (
      provider === "authored" &&
      profile === "authored" &&
      context.profile === "authored"
    )
      return true;
    if (
      operationId === "authored.register-account" &&
      context.provider === "github" &&
      context.profile === "github-app"
    )
      return true;
    return provider === context.provider && profile === context.profile;
  }
  async createRun(
    actor: ActorContext,
    context: RunContext,
    nodes: RunPlanNode[],
    inputs: Record<string, unknown>,
    continuation?: string,
  ) {
    requireCapability(actor, "executor");
    if (
      !nodes.length ||
      nodes.length > 32 ||
      new Set(nodes.map((n) => n.id)).size !== nodes.length
    )
      throw new AuthorizationError("invalid_request");
    const prior = new Map<string, RunPlanNode>();
    for (const node of nodes) {
      const operation = this.registry.require(
        node.operationId,
        node.operationVersion,
      );
      // Each step is admitted against its own context: a step planned under
      // another connector must belong to that connector's provider/profile.
      const own = node.context ?? context;
      if (
        !this.admits(own, node.operationId, node.operationVersion) ||
        node.dependsOn.some((id) => !prior.has(id))
      )
        throw new AuthorizationError("denied");
      // An artifact crosses from one connector's context into another's only
      // when its contract is declared shareable; checked again at execution.
      for (const binding of [
        ...Object.values(node.bindings),
        ...Object.values(node.outcome?.values ?? {}),
      ]) {
        if (binding.from !== "output" || binding.node === node.id) continue;
        const producer = prior.get(binding.node);
        if (
          producer &&
          !sameContext(producer.context ?? context, own) &&
          !this.shareable(producer, binding.name)
        )
          throw new AuthorizationError("denied");
      }
      // A retry repeats the handler: only the host's replay evidence allows it.
      if (node.outcome?.retry && !operation.replay)
        throw new AuthorizationError("denied");
      commandEnvelopeSchema.parse({
        commandId: "validate",
        runId: "validate",
        nodeId: node.id,
        operationId: node.operationId,
        operationVersion: node.operationVersion,
        expectedRevision: 0,
        bindings: node.bindings,
      });
      prior.set(node.id, node);
    }
    const run: RunRecord = {
      ...context,
      id: `run:${randomUUID()}`,
      subjectId: actor.subjectId,
      sessionId: actor.sessionId,
      status: "active",
      nodes: structuredClone(nodes),
      inputs: structuredClone(inputs),
      ...(continuation ? { continuation } : {}),
    };
    if (!(await this.reauthorize(actor, run, nodes[0]!.operationId)))
      throw new AuthorizationError("denied");
    // Every step under another connector needs the host's consent for that
    // connector's context before the run exists, not when it is reached.
    for (const node of nodes)
      if (
        node.context &&
        !(await this.reauthorize(actor, scopedRun(run, node), node.operationId))
      )
        throw new AuthorizationError("denied");
    await this.store.transaction((tx) =>
      tx.put(key(actor, "run", run.id), run, null),
    );
    return this.snapshot(actor, run.id);
  }
  private async owned(
    tx: AsyncTransaction,
    actor: ActorContext,
    runId: string,
  ) {
    const run = await tx.get<RunRecord>(key(actor, "run", runId));
    if (!run || run.value.subjectId !== actor.subjectId)
      throw new AuthorizationError("denied");
    return run;
  }
  /** Whether a producer's output may leave the producer's connector context. */
  private shareable(producer: RunPlanNode, name: string): boolean {
    const contract = this.registry.get(
      producer.operationId,
      producer.operationVersion,
    )?.contract.outputs[name]?.contract;
    return Boolean(
      contract && this.registry.vocabulary.get(contract)?.crossProvider,
    );
  }
  async snapshot(actor: ActorContext, runId: string) {
    return this.store.transaction(async (tx) => {
      const run = await this.owned(tx, actor, runId);
      const nodes = [];
      for (const node of run.value.nodes) {
        const state = await tx.get<NodeRecord>(
          key(actor, "node", `${runId}:${node.id}`),
        );
        nodes.push({
          id: node.id,
          operationId: node.operationId,
          operationVersion: node.operationVersion,
          state: state?.value.state ?? "pending",
          verified: state?.value.verified ?? false,
          // A step under another connector says whose context it runs in.
          ...(node.context
            ? {
                provider: node.context.provider,
                profile: node.context.profile,
              }
            : {}),
          ...(state?.value.retryAt !== undefined
            ? {
                retry: {
                  attempts: state.value.attempts ?? 0,
                  notBefore: state.value.retryAt,
                },
              }
            : {}),
        });
      }
      return {
        id: runId,
        revision: run.revision,
        provider: run.value.provider,
        profile: run.value.profile,
        status: run.value.status,
        nodes,
      };
    });
  }
  async cancel(actor: ActorContext, runId: string, expectedRevision: number) {
    requireCapability(actor, "executor");
    if (actor.actorKind === "agent") {
      const current = await this.store.transaction((tx) =>
        this.owned(tx, actor, runId),
      );
      if (!(await this.reauthorize(actor, current.value, "cancel")))
        throw new AuthorizationError("denied");
    }
    await this.store.transaction(async (tx) => {
      const run = await this.owned(tx, actor, runId);
      if (
        actor.actorKind === "agent" &&
        !(await this.reauthorize(actor, run.value, "cancel", tx))
      )
        throw new AuthorizationError("denied");
      if (run.revision !== expectedRevision) throw new PersistenceConflict();
      await tx.cancel(key(actor, "run", runId));
      await tx.put(
        key(actor, "run", runId),
        { ...run.value, status: "cancelled" },
        run.revision,
      );
    });
    return this.snapshot(actor, runId);
  }
  /** Fresh provider evidence is required for reuse; never rerun an effect to test validity. */
  async revalidate(actor: ActorContext, runId: string) {
    requireCapability(actor, "executor");
    const initial = await this.store.transaction(async (tx) => {
      const run = await this.owned(tx, actor, runId);
      if (run.value.status === "cancelled")
        throw new AuthorizationError("denied");
      const nodes = new Map<string, NodeRecord>();
      for (const node of run.value.nodes) {
        const record = await tx.get<NodeRecord>(
          key(actor, "node", `${runId}:${node.id}`),
        );
        if (record) nodes.set(node.id, record.value);
      }
      return {
        run,
        nodes,
        fence: await tx.claim(
          key(actor, "run", runId),
          `revalidate-${randomUUID()}`,
          60_000,
        ),
      };
    });
    const invalid = new Set<string>();
    for (const node of initial.run.value.nodes) {
      const result = initial.nodes.get(node.id);
      if (node.dependsOn.some((id) => invalid.has(id))) {
        invalid.add(node.id);
        continue;
      }
      if (!result?.verified) continue;
      const operation = this.registry.require(
        node.operationId,
        node.operationVersion,
      );
      const run = scopedRun(initial.run.value, node);
      if (!(await this.reauthorize(actor, run, node.operationId)))
        throw new AuthorizationError("denied");
      try {
        const valid =
          operation.verify &&
          (await operation.verify(
            {
              actor,
              runId,
              nodeId: node.id,
              commandId: `reuse:${runId}`,
              effectId: `reuse:${runId}`,
              provider: run.provider,
              target: run.target,
              configurationVersion: run.configurationVersion,
              origin: run.origin,
              environment: run.environment,
              signal: AbortSignal.timeout(30_000),
            },
            {
              state: "complete",
              outputs: operation.outputSchema.parse(result.outputs),
            },
          ));
        if (!valid) invalid.add(node.id);
      } catch {
        invalid.add(node.id);
      }
    }
    await this.store.transaction(async (tx) => {
      const current = await this.owned(tx, actor, runId);
      await tx.assertFence(initial.fence);
      if (
        current.revision !== initial.run.revision ||
        current.value.status === "cancelled"
      )
        throw new PersistenceConflict();
      for (const node of current.value.nodes) {
        if (
          !(await this.reauthorize(
            actor,
            scopedRun(current.value, node),
            node.operationId,
            tx,
          ))
        )
          throw new AuthorizationError("denied");
        if (!invalid.has(node.id)) continue;
        const nodeKey = key(actor, "node", `${runId}:${node.id}`);
        const prior = await tx.get<NodeRecord>(nodeKey);
        if (prior)
          await tx.put(
            nodeKey,
            { state: "failed", verified: false, outputs: {} },
            prior.revision,
          );
      }
      if (invalid.size)
        await tx.put(
          key(actor, "run", runId),
          { ...current.value, status: "active" },
          current.revision,
        );
      await tx.cancel(key(actor, "run", runId));
    });
    return this.snapshot(actor, runId);
  }
  async advance(
    actor: ActorContext,
    runId: string,
    nodeId: string,
    expectedRevision: number,
    commandId: string,
    signal?: AbortSignal,
  ) {
    const run = await this.store.transaction((tx) =>
      this.owned(tx, actor, runId),
    );
    const node = run.value.nodes.find((n) => n.id === nodeId);
    if (!node) throw new AuthorizationError("denied");
    return this.execute(
      actor,
      {
        commandId,
        runId,
        nodeId,
        expectedRevision,
        operationId: node.operationId,
        operationVersion: node.operationVersion,
        bindings: node.bindings,
      },
      signal,
    );
  }
  private async resolveInputs(
    tx: AsyncTransaction,
    actor: ActorContext,
    run: RunRecord,
    node: RunPlanNode,
    operation: RegisteredOperation,
  ) {
    const outputs = new Map<string, Record<string, unknown>>();
    for (const dependency of node.dependsOn) {
      const complete = await tx.get<NodeRecord>(
        key(actor, "node", `${run.id}:${dependency}`),
      );
      if (!complete?.value.verified || complete.value.state !== "complete")
        throw new AuthorizationError("denied");
      outputs.set(dependency, complete.value.outputs);
    }
    const own = contextOf(run, node);
    const output = (producer: string, name: string) => {
      const source = outputs.get(producer);
      if (!source || !Object.hasOwn(source, name))
        throw new AuthorizationError("denied");
      // The plan was checked when the run was created; check the stored plan again.
      const planned = run.nodes.find((candidate) => candidate.id === producer);
      if (
        !planned ||
        (!sameContext(contextOf(run, planned), own) &&
          !this.shareable(planned, name))
      )
        throw new AuthorizationError("denied");
      return source[name];
    };
    const values: Record<string, unknown> = {};
    for (const [name, binding] of Object.entries(node.bindings)) {
      if (!Object.hasOwn(operation.contract.inputs, name))
        throw new AuthorizationError("invalid_request");
      if (binding.from === "literal") {
        if (operation.classifications[name]?.classification !== "public")
          throw new AuthorizationError("denied");
        values[name] = binding.value;
      } else if (binding.from === "input") {
        if (!Object.hasOwn(run.inputs, binding.name))
          throw new AuthorizationError("invalid_request");
        values[name] = run.inputs[binding.name];
      } else values[name] = output(binding.node, binding.name);
    }
    const checked = operation.inputSchema.safeParse(values);
    if (!checked.success) throw new AuthorizationError("invalid_request");
    // Values a success criterion reads, except the step's own outputs, which
    // exist only once the handler has run.
    const outcome = new Map<string, unknown>();
    const ownOutputs: Array<[key: string, name: string]> = [];
    for (const [reference, binding] of Object.entries(
      node.outcome?.values ?? {},
    )) {
      if (binding.from === "literal") outcome.set(reference, binding.value);
      else if (binding.from === "input") {
        if (Object.hasOwn(run.inputs, binding.name))
          outcome.set(reference, run.inputs[binding.name]);
      } else if (binding.node === node.id)
        ownOutputs.push([reference, binding.name]);
      else outcome.set(reference, output(binding.node, binding.name));
    }
    return { values: checked.data, outcome, ownOutputs };
  }
  async execute(
    actor: ActorContext,
    input: unknown,
    signal = AbortSignal.timeout(30_000),
  ): Promise<CommandStatus> {
    requireCapability(actor, "executor");
    const command = commandEnvelopeSchema.parse(input);
    const initial = await this.store.transaction((tx) =>
      this.owned(tx, actor, command.runId),
    );
    // A step planned under another connector is authorized in that context.
    const step = (run: RunRecord) =>
      run.nodes.find((candidate) => candidate.id === command.nodeId);
    if (
      !(await this.reauthorize(
        actor,
        scopedRun(initial.value, step(initial.value)),
        command.operationId,
      ))
    )
      throw new AuthorizationError("denied");
    signal.throwIfAborted();
    const operation = this.registry.require(
      command.operationId,
      command.operationVersion,
    );
    const admission = await this.store.transaction(async (tx) => {
      const saved = await this.owned(tx, actor, command.runId);
      const run = saved.value;
      const planned = step(run);
      if (
        !(await this.reauthorize(
          actor,
          scopedRun(run, planned),
          command.operationId,
          tx,
        ))
      )
        throw new AuthorizationError("denied");
      const intent = digest({
        command,
        tenantId: actor.tenantId,
        subjectId: actor.subjectId,
        context: contextOf(run, planned),
        ...(planned?.context
          ? { connectorId: planned.context.connectorId }
          : {}),
      });
      const prior = await tx.get<CommandRecord>(
        key(actor, "command", command.commandId),
      );
      if (prior) {
        if (prior.value.digest !== intent)
          throw new AuthorizationError("denied");
        if (prior.value.state === "running" && run.status === "active") {
          // A retry may fence an expired worker, but cannot repeat its uncertain external effect.
          const takeover = await tx
            .claim(
              key(actor, "run", run.id),
              `reconcile-${randomUUID()}`,
              60_000,
            )
            .catch((error) => {
              if (error instanceof PersistenceConflict) return undefined;
              throw error;
            });
          if (takeover) {
            const effectKey = key(actor, "effect", prior.value.effectId);
            const effect = await tx.get<Record<string, unknown>>(effectKey);
            if (!effect) throw new AuthorizationError("denied");
            const nodeKey = key(actor, "node", `${run.id}:${command.nodeId}`);
            const previous = await tx.get<NodeRecord>(nodeKey);
            await tx.put(
              key(actor, "command", command.commandId),
              { ...prior.value, state: "uncertain" },
              prior.revision,
            );
            await tx.put(
              effectKey,
              { ...effect.value, status: "uncertain", verified: false },
              effect.revision,
            );
            await tx.put(
              nodeKey,
              { state: "uncertain", verified: false, outputs: {} },
              previous?.revision ?? null,
            );
            const revision = await tx.put(
              key(actor, "run", run.id),
              run,
              saved.revision,
            );
            await appendSemanticTransition(
              tx,
              actor,
              run.id,
              {
                nodeId: command.nodeId,
                operationId: command.operationId,
                operationVersion: command.operationVersion,
                actorKind: "system",
                kind: "transition",
                beforeState: previous?.value.state ?? "pending",
                afterState: "uncertain",
                publicBindings: {},
                verification: "pending",
              },
              {},
            );
            await tx.put(
              key(actor, "outbox", `reconciliation:${command.commandId}`),
              {
                task: "reconciliation-required",
                runId: run.id,
                subjectId: run.subjectId,
                status: "pending",
              },
              null,
            );
            await tx.cancel(key(actor, "run", run.id));
            return {
              existing: {
                commandId: command.commandId,
                runId: run.id,
                nodeId: command.nodeId,
                revision,
                state: "uncertain",
                verified: false,
              } as CommandStatus,
            };
          }
        }
        return {
          existing: {
            commandId: command.commandId,
            runId: run.id,
            nodeId: command.nodeId,
            revision: saved.revision,
            state: prior.value.state,
            verified: prior.value.state === "complete",
          } as CommandStatus,
        };
      }
      if (
        run.status !== "active" ||
        saved.revision !== command.expectedRevision
      )
        throw new PersistenceConflict();
      const node = run.nodes.find((n) => n.id === command.nodeId);
      if (
        !node ||
        node.operationId !== command.operationId ||
        node.operationVersion !== command.operationVersion ||
        digest(node.bindings) !== digest(command.bindings)
      )
        throw new AuthorizationError("denied");
      const ownState = await tx.get<NodeRecord>(
        key(actor, "node", `${run.id}:${node.id}`),
      );
      if (
        ownState?.value.state === "uncertain" ||
        ownState?.value.state === "complete" ||
        ownState?.value.verified ||
        ownState?.value.exhausted
      )
        throw new AuthorizationError("denied");
      // A declared retry is spaced: an attempt before its time is a conflict
      // the caller resolves by reading the run again, not a new effect.
      if (
        ownState?.value.retryAt !== undefined &&
        ownState.value.retryAt > (await tx.now())
      )
        throw new PersistenceConflict();
      const resolved = await this.resolveInputs(
        tx,
        actor,
        run,
        node,
        operation,
      );
      const values = resolved.values;
      // Non-public inputs can originate only in host-owned run bindings, never inline tool arguments.
      const fence = await tx.claim(
        key(actor, "run", run.id),
        `worker-${randomUUID()}`,
        60_000,
      );
      const effectId = `effect:${randomUUID()}`;
      const record: CommandRecord = {
        digest: intent,
        runId: run.id,
        state: "running",
        effectId,
        nodeId: node.id,
      };
      await tx.put(key(actor, "command", command.commandId), record, null);
      await tx.put(
        key(actor, "effect", effectId),
        { commandId: command.commandId, intent, status: "intent-persisted" },
        null,
      );
      return {
        run,
        node,
        values,
        outcome: resolved.outcome,
        ownOutputs: resolved.ownOutputs,
        fence,
        effectId,
        record,
      };
    });
    if (admission.existing) return admission.existing;
    const { run, node, values, fence, effectId, outcome, ownOutputs } =
      admission;
    const scoped = scopedRun(run, node);
    const context: OperationContext = {
      actor,
      fence,
      runId: run.id,
      nodeId: node.id,
      commandId: command.commandId,
      effectId,
      provider: scoped.provider,
      target: scoped.target,
      configurationVersion: scoped.configurationVersion,
      origin: scoped.origin,
      environment: scoped.environment,
      signal,
    };
    let result: OperationResult;
    let verified = false;
    let response: OperationResult["response"];
    try {
      if (!(await this.reauthorize(actor, scoped, command.operationId)))
        throw new AuthorizationError("denied");
      signal.throwIfAborted();
      result = await operation.handler(context, values);
      response = result.response;
      if (result.state === "complete") {
        result.outputs = operation.outputSchema.parse(result.outputs);
        verified = Boolean(
          operation.verify && (await operation.verify(context, result)),
        );
        if (!verified)
          result = {
            state: "failed",
            outputs: {},
            diagnosticCode: "verification-rejected",
          };
      } else result.outputs = z.strictObject({}).parse(result.outputs);
    } catch {
      // A transport exception is not evidence that an external effect did not happen.
      result = { state: "uncertain", outputs: {}, diagnosticCode: "uncertain" };
    }
    // Success criteria: a verified attempt that misses them is a failed one.
    // The reported transport facts are read here and then dropped.
    let retryable = false;
    if (
      node.outcome &&
      (result.state === "complete" || result.state === "failed")
    ) {
      const read = new Map(outcome);
      for (const [reference, name] of ownOutputs)
        if (Object.hasOwn(result.outputs, name))
          read.set(reference, result.outputs[name]);
      const decision = evaluateOutcome(node.outcome, read, response);
      if (result.state === "complete" && !decision.satisfied) {
        verified = false;
        result = {
          state: "failed",
          outputs: {},
          diagnosticCode: "verification-rejected",
        };
      }
      retryable = result.state === "failed" && decision.retryable;
    }
    if (!(await this.reauthorize(actor, scoped, command.operationId)))
      throw new AuthorizationError("denied");
    return this.store.transaction(async (tx) => {
      // Match admission/cancellation: lock the run before its lease.
      const current = await this.owned(tx, actor, run.id);
      await tx.assertFence(fence);
      if (
        !(await this.reauthorize(
          actor,
          scopedRun(current.value, node),
          command.operationId,
          tx,
        ))
      )
        throw new AuthorizationError("denied");
      if (
        current.value.status !== "active" ||
        current.revision !== command.expectedRevision
      )
        throw new PersistenceConflict();
      const nodeKey = key(actor, "node", `${run.id}:${node.id}`);
      const prior = await tx.get<NodeRecord>(nodeKey);
      // A step with an outcome counts its failed attempts; once no retry is
      // left (or none was declared, or its criteria refuse) it is exhausted.
      let attempts: Pick<NodeRecord, "attempts" | "retryAt" | "exhausted"> = {};
      if (node.outcome) {
        const count =
          (prior?.value.attempts ?? 0) + (result.state === "failed" ? 1 : 0);
        if (count) attempts = { attempts: count };
        if (result.state === "failed")
          attempts =
            retryable && node.outcome.retry && count <= node.outcome.retry.limit
              ? {
                  attempts: count,
                  retryAt: (await tx.now()) + node.outcome.retry.afterMs,
                }
              : { attempts: count, exhausted: true };
      }
      await tx.put(
        nodeKey,
        {
          state: result.state,
          verified,
          outputs: result.outputs,
          ...(result.diagnosticCode === "verification-rejected"
            ? { diagnosticCode: "verification-rejected" as const }
            : {}),
          ...attempts,
        },
        prior?.revision ?? null,
      );
      const record = await tx.get<CommandRecord>(
        key(actor, "command", command.commandId),
      );
      await tx.put(
        key(actor, "command", command.commandId),
        { ...record!.value, state: result.state },
        record!.revision,
      );
      const effect = await tx.get(key(actor, "effect", effectId));
      await tx.put(
        key(actor, "effect", effectId),
        { commandId: command.commandId, status: result.state, verified },
        effect!.revision,
      );
      let complete = true;
      for (const planned of run.nodes) {
        const done = await tx.get<NodeRecord>(
          key(actor, "node", `${run.id}:${planned.id}`),
        );
        if (!done?.value.verified) complete = false;
      }
      const revision = await tx.put(
        key(actor, "run", run.id),
        { ...run, status: complete ? "complete" : "active" },
        current.revision,
      );
      await appendSemanticTransition(
        tx,
        actor,
        run.id,
        {
          nodeId: node.id,
          operationId: node.operationId,
          operationVersion: node.operationVersion,
          actorKind: actor.actorKind,
          kind: verified
            ? "verification"
            : result.state === "awaiting-human"
              ? "handoff"
              : "transition",
          beforeState: prior?.value.state ?? "pending",
          afterState: result.state,
          publicBindings: values as Record<
            string,
            string | number | boolean | null
          >,
          verification: verified
            ? "accepted"
            : result.state === "failed"
              ? "rejected"
              : "pending",
          ...(result.diagnosticCode
            ? { diagnosticCode: result.diagnosticCode }
            : {}),
        },
        operation.classifications,
      );
      if (verified) {
        const delegation = await tx.get<{
          revoked: boolean;
          expiresAt: number;
        }>({ tenant: "workload", kind: "session", id: run.id });
        const budget = await tx.get<{ stopped: boolean }>({
          tenant: actor.tenantId,
          kind: "budget",
          id: `agent:${run.id}`,
        });
        if (
          delegation &&
          !delegation.value.revoked &&
          delegation.value.expiresAt > (await tx.now()) &&
          !budget?.value.stopped
        )
          await tx.put(
            key(actor, "outbox", `agent-wake:${run.id}:${revision}`),
            {
              task: "agent-wake",
              runId: run.id,
              subjectId: run.subjectId,
              status: "pending",
            },
            null,
          );
      }
      if (
        complete &&
        run.continuation &&
        !(await tx.get(key(actor, "outbox", `continuation:${run.id}`)))
      )
        await tx.put(
          key(actor, "outbox", `continuation:${run.id}`),
          {
            runId: run.id,
            subjectId: run.subjectId,
            task: run.continuation,
            deliveryId: `continuation:${run.id}`,
            status: "pending",
          },
          null,
        );
      await tx.cancel(key(actor, "run", run.id));
      return {
        commandId: command.commandId,
        runId: run.id,
        nodeId: node.id,
        revision,
        state: result.state,
        verified,
      };
    });
  }
}

/** Delivery handlers must use the stable ID to deduplicate/reconcile their own external effect. */
export async function deliverContinuations(
  store: AsyncCeremonyStore,
  actor: ActorContext,
  handlers: ReadonlyMap<
    string,
    (input: { runId: string; deliveryId: string }) => Promise<void>
  >,
) {
  let after = "";
  for (;;) {
    const entries = await store.transaction((tx) =>
      tx.list<{
        runId: string;
        subjectId: string;
        task: string;
        deliveryId: string;
        status: string;
      }>(actor.tenantId, "outbox", 100, after),
    );
    for (const entry of entries) {
      const value = entry.value;
      if (value.status !== "pending" || value.subjectId !== actor.subjectId)
        continue;
      const handler = handlers.get(value.task);
      if (!handler) continue;
      const fence = await store
        .transaction(async (tx) => {
          const current = await tx.get<{ status: string }>(
            key(actor, "outbox", entry.id),
          );
          if (!current || current.value.status !== "pending") return undefined;
          return tx.claim(
            key(actor, "outbox", entry.id),
            `delivery-${randomUUID()}`,
            30_000,
          );
        })
        .catch((error) => {
          if (error instanceof PersistenceConflict) return undefined;
          throw error;
        });
      if (!fence) continue;
      try {
        await handler({ runId: value.runId, deliveryId: value.deliveryId });
        await store.transaction(async (tx) => {
          await tx.get(key(actor, "outbox", entry.id));
          await tx.assertFence(fence);
          await tx.put(
            key(actor, "outbox", entry.id),
            { ...value, status: "delivered" },
            entry.revision,
          );
          await tx.cancel(key(actor, "outbox", entry.id));
        });
      } catch (error) {
        // The consumer may already have applied the effect: retain deliveryId and retry only with consumer deduplication.
        await store
          .transaction(async (tx) => {
            await tx.assertFence(fence);
            await tx.cancel(key(actor, "outbox", entry.id));
          })
          .catch(() => {});
        throw error;
      }
    }
    if (entries.length < 100) break;
    after = entries.at(-1)!.id;
  }
}
