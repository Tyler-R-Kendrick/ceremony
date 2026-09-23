import { z } from "zod";
import { AuthorizationError, requireCapability } from "./identity.js";
import type { ActorContext } from "./identity.js";
import type { TeachingRuntime } from "./teaching-runtime.js";

/**
 * The four operations an agent may perform on a ceremony run.
 *
 * These used to live inline in the HTTP route. They are shared now because the
 * MCP server performs the same operations for the same actors, and an
 * authorization rule that exists in one copy and not the other is a hole rather
 * than a difference — in particular the delegation check in `advance` and
 * `cancel`, which is the only thing stopping one authenticated subject from
 * driving another's run.
 *
 * Every function takes the already-authenticated actor. Nothing here reads a
 * header, a cookie or a token: how the caller was authenticated is the
 * transport's business, and an actor is never derived from tool arguments.
 */

const identifier = z.string().regex(/^[a-zA-Z][a-zA-Z0-9_.:-]{0,119}$/);
const revision = z.number().int().positive();

export const agentToolInputs = {
  connect: z.strictObject({
    connectorId: identifier,
    /**
     * Record this ceremony as a demonstration from its first step, so the
     * steps that run without a person are part of what can be compiled into
     * a recipe draft. Recording requires the `author` capability.
     */
    teach: z.boolean().optional(),
  }),
  snapshot: z.strictObject({ runId: identifier }),
  advance: z.strictObject({
    runId: identifier,
    nodeId: identifier,
    revision,
    commandId: identifier,
  }),
  cancel: z.strictObject({ runId: identifier, revision }),
} as const;

export type AgentToolName = keyof typeof agentToolInputs;

export function ceremonyAgentTools(runtime: TeachingRuntime) {
  /**
   * The run is re-read as the authenticated actor first, so a run they cannot
   * see is not found rather than probed. The delegated agent actor is then
   * derived from the run and must be the same subject in the same session —
   * holding a run id is not authority over it.
   */
  async function delegatedFor(actor: ActorContext, runId: string) {
    await runtime.commands.snapshot(actor, runId);
    const delegated = await runtime.agentActor(runId);
    if (
      delegated.tenantId !== actor.tenantId ||
      delegated.subjectId !== actor.subjectId ||
      delegated.sessionId !== actor.sessionId
    )
      throw new AuthorizationError("denied");
    return delegated;
  }

  return {
    async connect(actor: ActorContext, input: unknown) {
      requireCapability(actor, "executor");
      const { connectorId, teach } = agentToolInputs.connect.parse(input);
      // Refused before a run exists, rather than after one was started for a
      // recording this caller was never allowed to make.
      if (teach) requireCapability(actor, "author");
      const delegated = await runtime.connectForAgent(actor, connectorId);
      let run = delegated.run;
      // The recording starts before the first step is advanced, as the
      // browser's teach mode does, so nothing the run does goes unrecorded.
      const demonstration = teach
        ? await runtime.demonstrations.start(actor, run.id)
        : undefined;
      // Prepared steps run to the first one that cannot complete on its own;
      // that step is what the caller is being asked to deal with.
      for (const node of run.nodes) {
        if (node.verified) continue;
        const result = await runtime.commands.advance(
          delegated.actor,
          run.id,
          node.id,
          run.revision,
          `native:${run.id}:${node.id}:${run.revision}`,
        );
        run = await runtime.commands.snapshot(delegated.actor, run.id);
        if (result.state !== "complete") break;
      }
      return demonstration ? { ...run, demonstration } : run;
    },

    async snapshot(actor: ActorContext, input: unknown) {
      requireCapability(actor, "executor");
      const { runId } = agentToolInputs.snapshot.parse(input);
      return await runtime.commands.snapshot(actor, runId);
    },

    async advance(actor: ActorContext, input: unknown) {
      requireCapability(actor, "executor");
      const checked = agentToolInputs.advance.parse(input);
      const delegated = await delegatedFor(actor, checked.runId);
      await runtime.commands.advance(
        delegated,
        checked.runId,
        checked.nodeId,
        checked.revision,
        checked.commandId,
      );
      return await runtime.commands.snapshot(actor, checked.runId);
    },

    async cancel(actor: ActorContext, input: unknown) {
      requireCapability(actor, "executor");
      const checked = agentToolInputs.cancel.parse(input);
      const delegated = await delegatedFor(actor, checked.runId);
      await runtime.commands.cancel(delegated, checked.runId, checked.revision);
      await runtime.cancel?.(delegated, checked.runId);
      return await runtime.commands.snapshot(actor, checked.runId);
    },
  };
}

export type CeremonyAgentTools = ReturnType<typeof ceremonyAgentTools>;
