import { createHash } from "node:crypto";
import { z } from "zod";
import type {
  AdapterCallContext,
  DelegateRequest,
  InvokeResult,
} from "../../adapter.js";
import { boundOperation, type BoundOperation } from "../../binding.js";
import { ConnectorError } from "../../errors.js";
import { classifyAddress } from "../../import/network.js";
import type {
  ConnectionRecord,
  EffectOutcome,
  HandoffRecord,
} from "../../ports.js";
import {
  effectDigest,
  requireConnection,
  resolveA2a,
  sha256,
  type ResolvedA2a,
} from "./context.js";
import {
  A2A_LIMITS,
  a2aInterruptedStates,
  a2aTerminalStates,
  type A2aArtifactView,
  type A2aPartView,
  type A2aTaskState,
  type A2aTaskView,
  type ApprovedSkill,
} from "./schemas.js";

/*
 * AG-02: configured, authenticated A2A task delegation.
 *
 * Four actions, one authority model. A caller names a skill the binding
 * approved and, for a continuation, a task reference this deployment issued;
 * it never names a task id, a URL, a header, an agent or an owner. Task
 * identity is owner-bound: the reference is a digest, the upstream id lives in
 * protected handoff material, and resolving a reference checks the tenant, the
 * subject, the connection and the connection generation before anything is
 * sent. Cancelling one task therefore cannot reach another principal's task
 * even if its reference leaks.
 *
 * Every consequential action is journaled before it happens, so an
 * interrupted start is not silently retried into a second task and a lost
 * response is reported as uncertain rather than as a failure a caller may
 * simply repeat.
 *
 * Artifacts are described, never fetched. An agent that answers with a URL —
 * on a private network, a metadata address or anywhere else — gets its URL
 * recorded and left alone; retrieval is a separate, explicitly approved
 * operation against an approved destination.
 */

export const TASK_REF_PREFIX = "a2atask:";

const delegateTextSchema = z.strictObject({
  text: z.string().min(1).max(A2A_LIMITS.textChars),
});

export type A2aDelegationOutput = {
  taskRef: string;
  state: A2aTaskState;
  /** Set when the agent interrupted and is waiting on this deployment. */
  awaiting?: "input" | "authorization";
  /** The agent's own words, when the skill's output policy admits them. */
  prompt?: string;
  data?: unknown;
  artifacts: Array<{
    artifactId: string;
    name?: string;
    parts: Array<{
      kind: A2aPartView["kind"];
      mediaType?: string;
      filename?: string;
      /** Included only for text parts, and only when the skill inlines them. */
      text?: string;
      /** A URL part is never followed here; retrieval is a separate approved step. */
      retrieval?: "not-fetched";
      retrievable?: boolean;
      byteLength?: number;
    }>;
  }>;
};

/** The reference a caller holds. It is a digest, so it discloses no upstream id. */
export function taskReferenceFor(authority: string, taskId: string): string {
  return `${TASK_REF_PREFIX}${createHash("sha256")
    .update(`${authority.length}:${authority}|${taskId.length}:${taskId}`)
    .digest("hex")}`;
}

const taskRefSchema = z
  .string()
  .regex(new RegExp(`^${TASK_REF_PREFIX}[a-f0-9]{64}$`));

function approvedSkill(
  resolved: ResolvedA2a,
  skillId: string,
): { skill: ApprovedSkill; operation: BoundOperation } {
  const skill = resolved.settings.approvedSkills.find(
    (item) => item.skillId === skillId,
  );
  if (!skill)
    throw new ConnectorError("denied", { detail: "a2a.skill.unapproved" });
  const operation = boundOperation(resolved.ctx.binding, skill.operationRef);
  if (!operation)
    throw new ConnectorError("denied", { detail: "a2a.operation.unapproved" });
  if (
    operation.transport.kind !== "delegated" ||
    operation.transport.route !== `a2a-skill:${skill.skillId}`
  )
    throw new ConnectorError("denied", { detail: "a2a.operation.route" });
  if (operation.destinationId !== resolved.settings.agent.destinationId)
    throw new ConnectorError("network-policy", {
      detail: "a2a.operation.destination",
    });
  return { skill, operation };
}

async function issueTaskHandle(
  resolved: ResolvedA2a,
  connection: ConnectionRecord,
  task: A2aTaskView,
  skill: ApprovedSkill,
): Promise<string> {
  const ctx = resolved.ctx;
  const taskRef = taskReferenceFor(resolved.authority, task.id);
  const existing = await ctx.environment.handoffs.resolveCorrelation(
    ctx.actor.tenantId,
    taskRef,
  );
  if (existing) return taskRef;
  await ctx.environment.handoffs.issue({
    actor: ctx.actor,
    connectionRef: connection.connectionRef,
    bindingRef: ctx.binding.bindingRef,
    generation: ctx.generation,
    kind: "input-required",
    presentation: "in-app",
    expiresAt: ctx.environment.now() + resolved.settings.taskTtlMs,
    intent: "a2a.task",
    correlationKey: taskRef,
    // Protected transient material: the upstream task id never leaves the
    // server, so a reference cannot be turned back into one.
    private: {
      taskId: task.id,
      ...(task.contextId ? { contextId: task.contextId } : {}),
      skillId: skill.skillId,
      operationRef: skill.operationRef,
    },
  });
  return taskRef;
}

export type ResolvedTask = {
  record: HandoffRecord;
  taskRef: string;
  taskId: string;
  contextId?: string;
  skillId: string;
};

/**
 * Resolves a caller's task reference to the upstream task, refusing anything
 * that is not this owner's task on this connection at this generation. A
 * reference from another principal, another connection or an older generation
 * is not found; it never becomes a cancellation of somebody else's work.
 */
export async function resolveTaskHandle(
  resolved: ResolvedA2a,
  connection: ConnectionRecord,
  reference: unknown,
): Promise<ResolvedTask> {
  const parsed = taskRefSchema.safeParse(reference);
  if (!parsed.success)
    throw new ConnectorError("invalid-request", { detail: "a2a.task.reference" });
  const ctx = resolved.ctx;
  const record = await ctx.environment.handoffs.resolveCorrelation(
    ctx.actor.tenantId,
    parsed.data,
  );
  if (!record || record.intent !== "a2a.task")
    throw new ConnectorError("not-found", { detail: "a2a.task.unknown" });
  if (
    record.tenantId !== ctx.actor.tenantId ||
    record.subjectId !== ctx.actor.subjectId
  )
    throw new ConnectorError("not-found", { detail: "a2a.task.unknown" });
  if (
    record.connectionRef !== connection.connectionRef ||
    record.bindingRef !== ctx.binding.bindingRef
  )
    throw new ConnectorError("not-found", { detail: "a2a.task.unknown" });
  if (record.generation !== ctx.generation)
    throw new ConnectorError("conflict", { detail: "a2a.task.generation" });
  const taskId = record.private.taskId;
  const skillId = record.private.skillId;
  if (!taskId || !skillId)
    throw new ConnectorError("not-found", { detail: "a2a.task.unknown" });
  return {
    record,
    taskRef: parsed.data,
    taskId,
    ...(record.private.contextId ? { contextId: record.private.contextId } : {}),
    skillId,
  };
}

async function settleHandle(
  resolved: ResolvedA2a,
  handle: ResolvedTask | undefined,
  state: A2aTaskState,
): Promise<void> {
  if (!handle) return;
  if (handle.record.state !== "issued" && handle.record.state !== "waiting")
    return;
  if (!a2aTerminalStates.includes(state)) return;
  const settled =
    state === "canceled"
      ? ("cancelled" as const)
      : state === "completed"
        ? ("completed" as const)
        : ("denied" as const);
  try {
    await resolved.ctx.environment.handoffs.complete(
      handle.record.handoffRef,
      resolved.ctx.generation,
      settled,
    );
  } catch {
    // A concurrent settlement already recorded the outcome; the task state we
    // just read is authoritative either way, so this is not a failure.
  }
}

function describeParts(
  skill: ApprovedSkill,
  artifact: A2aArtifactView,
  retrievableOrigins: ReadonlySet<string>,
): A2aDelegationOutput["artifacts"][number] {
  return {
    artifactId: artifact.artifactId,
    ...(artifact.name ? { name: artifact.name } : {}),
    parts: artifact.parts.slice(0, A2A_LIMITS.parts).map((part) => {
      if (part.kind === "text")
        return {
          kind: part.kind,
          ...(skill.artifactPolicy === "inline-text"
            ? { text: part.text.slice(0, A2A_LIMITS.textChars) }
            : {}),
        };
      if (part.kind === "file-url") {
        const origin = URL.canParse(part.url)
          ? new URL(part.url).origin
          : undefined;
        return {
          kind: part.kind,
          ...(part.mediaType ? { mediaType: part.mediaType } : {}),
          ...(part.filename ? { filename: part.filename } : {}),
          // The URL itself is withheld: it may be signed, private or a
          // metadata address, and none of those belong in a tool result.
          retrieval: "not-fetched" as const,
          retrievable: origin !== undefined && retrievableOrigins.has(origin),
        };
      }
      if (part.kind === "file-bytes")
        return {
          kind: part.kind,
          ...(part.mediaType ? { mediaType: part.mediaType } : {}),
          ...(part.filename ? { filename: part.filename } : {}),
          byteLength: part.byteLength,
        };
      if (part.kind === "data")
        return {
          kind: part.kind,
          ...(skill.outputPolicy === "data" ? {} : {}),
        };
      return { kind: part.kind };
    }),
  };
}

/** Builds the caller-visible view of a task under the skill's output policy. */
export function projectTask(
  resolved: ResolvedA2a,
  skill: ApprovedSkill,
  taskRef: string,
  task: A2aTaskView,
): A2aDelegationOutput {
  const retrievableOrigins = new Set(
    resolved.settings.artifactRetrieval.enabled
      ? resolved.ctx.binding.destinations
          .filter(
            (destination) =>
              destination.id ===
              (resolved.settings.artifactRetrieval.destinationId ??
                resolved.settings.agent.destinationId),
          )
          .map((destination) => destination.origin)
      : [],
  );
  const textParts = task.statusParts.filter(
    (part): part is Extract<A2aPartView, { kind: "text" }> =>
      part.kind === "text",
  );
  const dataPart = task.statusParts.find(
    (part): part is Extract<A2aPartView, { kind: "data" }> =>
      part.kind === "data",
  );
  return {
    taskRef,
    state: task.state,
    ...(task.state === "input-required"
      ? { awaiting: "input" as const }
      : task.state === "auth-required"
        ? { awaiting: "authorization" as const }
        : {}),
    ...(skill.outputPolicy !== "none" && textParts.length
      ? {
          prompt: textParts
            .map((part) => part.text)
            .join("\n")
            .slice(0, A2A_LIMITS.promptChars),
        }
      : {}),
    ...(skill.outputPolicy === "data" && dataPart
      ? { data: dataPart.data }
      : {}),
    artifacts: task.artifacts
      .slice(0, A2A_LIMITS.artifacts)
      .map((artifact) => describeParts(skill, artifact, retrievableOrigins)),
  };
}

function stateToResult(state: A2aTaskState): InvokeResult["state"] {
  if (a2aInterruptedStates.includes(state)) return "human-required";
  if (state === "rejected") return "denied";
  if (state === "failed") return "failed";
  if (state === "unknown") return "indeterminate";
  return "complete";
}

function priorResult(
  operation: BoundOperation,
  prior: EffectOutcome,
  base: { outputClassification: InvokeResult["outputClassification"]; effect: InvokeResult["effect"] },
): InvokeResult | undefined {
  if (operation.replay === "read-only") return undefined;
  if (prior.status === "applied" || prior.status === "reconciled")
    return { ...base, state: "complete", code: "a2a.effect.already-applied" };
  if (prior.status === "indeterminate")
    return { ...base, state: "indeterminate", code: "a2a.effect.indeterminate" };
  return undefined;
}

export async function delegateA2a(
  ctx: AdapterCallContext,
  request: DelegateRequest,
): Promise<InvokeResult> {
  const resolved = resolveA2a(ctx);
  const connection = requireConnection(ctx);
  if (connection.lifecycle !== "active" && connection.lifecycle !== "degraded")
    throw new ConnectorError("denied", { detail: "a2a.connection.inactive" });
  const { skill, operation } = approvedSkill(resolved, request.skill);
  const base = {
    outputClassification: operation.outputClassification,
    effect: operation.effect,
  };

  if (request.action === "status") {
    const handle = await resolveTaskHandle(resolved, connection, request.taskRef);
    if (handle.skillId !== skill.skillId)
      throw new ConnectorError("denied", { detail: "a2a.task.skill-mismatch" });
    const task = await resolved.client.getTask({
      id: handle.taskId,
      historyLength: resolved.settings.historyLength,
    });
    await settleHandle(resolved, handle, task.state);
    return {
      ...base,
      state: stateToResult(task.state),
      effect: "read",
      output: projectTask(resolved, skill, handle.taskRef, task),
    };
  }

  const text =
    request.action === "cancel"
      ? ""
      : delegateTextSchema.parse(request.input).text.slice(0, skill.maxInputChars);
  if (request.action !== "cancel" && text.length === 0)
    throw new ConnectorError("invalid-request", { detail: "a2a.input.empty" });

  const handle =
    request.action === "start"
      ? undefined
      : await resolveTaskHandle(resolved, connection, request.taskRef);
  if (handle && handle.skillId !== skill.skillId)
    throw new ConnectorError("denied", { detail: "a2a.task.skill-mismatch" });
  if (
    handle &&
    handle.record.expiresAt <= ctx.environment.now() &&
    (handle.record.state === "issued" || handle.record.state === "waiting")
  )
    throw new ConnectorError("expired", { detail: "a2a.task.expired" });
  if (handle && handle.record.state === "cancelled")
    throw new ConnectorError("cancelled", { detail: "a2a.task.cancelled" });

  const digest = effectDigest({
    tenant: ctx.actor.tenantId,
    owner: connection.ownerId,
    connection: connection.connectionRef,
    generation: ctx.generation,
    binding: ctx.binding.bindingRef,
    bindingRevision: ctx.binding.revision,
    operation: operation.operationRef,
    action: request.action,
    task: handle?.taskRef ?? "",
    input: sha256(text),
    commandId: request.commandId,
  });
  const journal = await ctx.environment.effects.begin({
    actor: ctx.actor,
    connectionRef: connection.connectionRef,
    bindingRef: ctx.binding.bindingRef,
    operation: `a2a.${request.action}:${operation.operationRef}`,
    digest,
    commandId: request.commandId,
  });
  if (journal.prior) {
    const replay = priorResult(operation, journal.prior, base);
    if (replay) return { ...replay, effectRef: journal.effectRef };
  }
  const finish = async (status: EffectOutcome["status"], code?: string) =>
    ctx.environment.effects.complete(journal.effectRef, {
      status,
      ...(code ? { code } : {}),
      at: ctx.environment.now(),
    });
  const withRef = { ...base, effectRef: journal.effectRef };

  try {
    if (request.action === "cancel") {
      if (!handle) throw new ConnectorError("invalid-request", { detail: "a2a.task.reference" });
      const task = await resolved.client.cancelTask({ id: handle.taskId });
      await settleHandle(resolved, handle, task.state);
      await finish("applied", "a2a.task.cancel-requested");
      return {
        ...withRef,
        state: "complete",
        output: projectTask(resolved, skill, handle.taskRef, task),
      };
    }
    const sent = await resolved.client.sendMessage({
      messageId: ctx.environment.random.uuid(),
      text,
      ...(handle ? { taskId: handle.taskId } : {}),
      ...(handle?.contextId ? { contextId: handle.contextId } : {}),
      acceptedOutputModes: skill.acceptedOutputModes,
      historyLength: resolved.settings.historyLength,
      returnImmediately: resolved.settings.returnImmediately,
    });
    if (sent.kind === "message") {
      // The agent answered without creating a task. There is nothing to poll
      // or cancel, and nothing was journaled as an ongoing delegation.
      await finish("applied", "a2a.message.no-task");
      return {
        ...withRef,
        state: "complete",
        code: "a2a.message.no-task",
        output: { taskRef: handle?.taskRef ?? "", state: "completed", artifacts: [] },
      };
    }
    const taskRef = handle
      ? handle.taskRef
      : await issueTaskHandle(resolved, connection, sent.task, skill);
    if (handle && taskReferenceFor(resolved.authority, sent.task.id) !== handle.taskRef) {
      // A continuation that comes back about a different task is a routing
      // failure, not a result: nothing about the caller's task is known now.
      await finish("indeterminate", "a2a.task.identity-drift");
      return { ...withRef, state: "indeterminate", code: "a2a.task.identity-drift" };
    }
    await settleHandle(resolved, handle, sent.task.state);
    await finish("applied", `a2a.task.${sent.task.state}`);
    return {
      ...withRef,
      state: stateToResult(sent.task.state),
      output: projectTask(resolved, skill, taskRef, sent.task),
    };
  } catch (error) {
    if (error instanceof ConnectorError) {
      if (
        error.code === "invalid-request" ||
        error.code === "denied" ||
        error.code === "rate-limited"
      ) {
        await finish("not-applied", error.detail ?? `a2a.${error.code}`);
        throw error;
      }
      if (error.code === "not-found" || error.code === "conflict") {
        await finish("failed", error.detail ?? `a2a.${error.code}`);
        throw error;
      }
      // The request may have reached the agent. A delegation is not a read,
      // so a lost response is uncertain rather than a failure to retry.
      if (
        error.code === "upstream-unavailable" ||
        error.code === "cancelled"
      ) {
        await finish("indeterminate", "a2a.transport.lost-response");
        return {
          ...withRef,
          state: "indeterminate",
          code: "a2a.transport.lost-response",
        };
      }
      await finish("failed", error.detail ?? "a2a.upstream.error");
      return { ...withRef, state: "failed", code: error.detail ?? "a2a.upstream.error" };
    }
    await finish("failed", "a2a.upstream.error");
    return { ...withRef, state: "failed", code: "a2a.upstream.error" };
  }
}

/* ------------------------------------------------------- artifact retrieval */

export type ArtifactRetrieval = {
  mediaType: string;
  byteLength: number;
  digest: string;
  bytes: Uint8Array;
};

const approvalSchema = z.strictObject({
  approvedBy: z.string().min(1).max(200),
  approvedAt: z.number().int().nonnegative(),
});

/**
 * Privileged-internal, non-automatic artifact retrieval. It exists so that a
 * person can deliberately fetch one artifact a delegated agent produced; it is
 * never called while reading a task, is not part of `ConnectorAdapter`, and
 * is therefore unreachable through a generic agent or read-only route.
 *
 * The URL the agent supplied must resolve to an origin this binding already
 * approved for artifacts. A private, loopback or link-local literal is
 * refused unless the approved destination itself is an administrator-approved
 * private or fixture destination.
 */
export async function retrieveA2aArtifact(
  ctx: AdapterCallContext,
  input: {
    taskRef: string;
    artifactId: string;
    partIndex: number;
    approval: { approvedBy: string; approvedAt: number };
  },
): Promise<ArtifactRetrieval> {
  const resolved = resolveA2a(ctx);
  const connection = requireConnection(ctx);
  const retrieval = resolved.settings.artifactRetrieval;
  if (!retrieval.enabled)
    throw new ConnectorError("unsupported", { detail: "a2a.artifact.disabled" });
  approvalSchema.parse(input.approval);
  const handle = await resolveTaskHandle(resolved, connection, input.taskRef);
  const task = await resolved.client.getTask({
    id: handle.taskId,
    historyLength: 0,
  });
  const artifact = task.artifacts.find(
    (item) => item.artifactId === input.artifactId,
  );
  const part = artifact?.parts[input.partIndex];
  if (!part || part.kind !== "file-url")
    throw new ConnectorError("not-found", { detail: "a2a.artifact.not-found" });
  if (!URL.canParse(part.url))
    throw new ConnectorError("network-policy", {
      detail: "a2a.artifact.not-a-url",
    });
  const url = new URL(part.url);
  if (url.username || url.password)
    throw new ConnectorError("network-policy", {
      detail: "a2a.artifact.credentialed",
    });
  const destination = ctx.binding.destinations.find(
    (item) =>
      item.id === (retrieval.destinationId ?? resolved.settings.agent.destinationId),
  );
  if (!destination || destination.origin !== url.origin)
    throw new ConnectorError("network-policy", {
      detail: "a2a.artifact.unapproved-origin",
    });
  const host = url.hostname.replace(/^\[|\]$/g, "");
  const classification = classifyAddress(host);
  if (
    classification !== "public" &&
    /^[0-9[]|:/.test(url.hostname) &&
    destination.network === "public"
  )
    throw new ConnectorError("network-policy", {
      detail: "a2a.artifact.private-network",
    });
  const signal = AbortSignal.any([
    ctx.signal,
    AbortSignal.timeout(resolved.settings.deadlineMs),
  ]);
  let response: Response;
  try {
    response = await ctx.environment.fetch(url, {
      method: "GET",
      redirect: "error",
      signal,
    });
  } catch (cause) {
    throw new ConnectorError("upstream-unavailable", {
      detail: "a2a.artifact.unreachable",
      cause,
    });
  }
  if (response.status !== 200)
    throw new ConnectorError("upstream-rejected", {
      detail: "a2a.artifact.status",
    });
  const buffer = new Uint8Array(await response.arrayBuffer());
  if (buffer.byteLength > retrieval.maxBytes)
    throw new ConnectorError("upstream-rejected", {
      detail: "a2a.artifact.too-large",
    });
  return {
    mediaType: response.headers.get("content-type") ?? "application/octet-stream",
    byteLength: buffer.byteLength,
    digest: createHash("sha256").update(buffer).digest("hex"),
    bytes: buffer,
  };
}
