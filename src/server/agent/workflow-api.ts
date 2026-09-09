import { resumeHook, start } from "workflow/api";
import type { ActorContext } from "../../core/operation-contracts.js";
import type { AgentCommandPort } from "./coordinator.js";
import { ceremonyAgentWorkflow } from "./workflow.js";
import { randomUUID } from "node:crypto";
import { PersistenceConflict } from "../persistence/index.js";
import type { TeachingRuntime } from "../teaching-runtime.js";
import { AuthorizationError } from "../identity.js";

/** Invoke after durable session admission, with a stable session identity persisted by the host. */
export async function startAgentWorkflow(
  commands: AgentCommandPort,
  actor: ActorContext,
  runId: string,
  sessionId: string,
) {
  await commands.snapshot(actor, runId);
  return start(ceremonyAgentWorkflow, [runId, sessionId]);
}
/** Wake conveys no approval. The durable outbox retries false (hook not yet registered). */
export async function wakeAgent(
  commands: AgentCommandPort,
  actor: ActorContext,
  runId: string,
): Promise<boolean> {
  await commands.snapshot(actor, runId);
  try {
    await resumeHook(`ceremony-agent:${runId}`, { wake: true });
    return true;
  } catch {
    return false;
  }
}

/** Server outbox dispatcher. History receives only run correlation plus {wake:true}, never callback contents. */
export async function dispatchAgentWakes(
  runtime: TeachingRuntime,
  tenant: string,
  resume: typeof wakeAgent = wakeAgent,
): Promise<void> {
  let after = "";
  for (;;) {
    const page = await runtime.store.transaction((tx) =>
      tx.list<{
        task: string;
        runId: string;
        subjectId: string;
        status: string;
      }>(tenant, "outbox", 100, after),
    );
    for (const row of page) {
      if (row.value.task !== "agent-wake" || row.value.status !== "pending")
        continue;
      const key = { tenant, kind: "outbox" as const, id: row.id };
      const fence = await runtime.store
        .transaction(async (tx) => {
          const current = await tx.get<{ status: string }>(key);
          if (!current || current.value.status !== "pending") return undefined;
          return tx.claim(key, `wake-${randomUUID()}`, 30000);
        })
        .catch((error) => {
          if (error instanceof PersistenceConflict) return undefined;
          throw error;
        });
      if (!fence) continue;
      let status = "pending";
      try {
        const actor = await runtime.agentActor(row.value.runId);
        if (
          actor.tenantId !== tenant ||
          actor.subjectId !== row.value.subjectId
        )
          throw new AuthorizationError("denied");
        if (await resume(runtime.commands, actor, row.value.runId))
          status = "delivered";
      } catch (error) {
        if (error instanceof AuthorizationError) status = "blocked";
      }
      await runtime.store.transaction(async (tx) => {
        await tx.assertFence(fence);
        if (status !== "pending")
          await tx.put(key, { ...row.value, status }, row.revision);
        await tx.cancel(key);
      });
    }
    if (page.length < 100) break;
    after = page.at(-1)!.id;
  }
}
