import { setTimeout as delay } from "node:timers/promises";
import type { ActorContext } from "../../core/operation-contracts.js";
import type { AgentCoordinator } from "./coordinator.js";

/** A reconnect rereads authoritative state. Disconnect never cancels domain execution. */
export async function agentStatusStream(
  coordinator: AgentCoordinator,
  actor: ActorContext,
  runId: string,
  turnId: string | undefined,
  authorize?: () => Promise<void>,
): Promise<Response> {
  await authorize?.();
  await coordinator.status(actor, runId, turnId);
  const abort = new AbortController();
  let reads = 0;
  return new Response(
    new ReadableStream<Uint8Array>({
      async pull(controller) {
        try {
          if (reads++) await delay(1000, undefined, { signal: abort.signal });
          await authorize?.();
          const state = await coordinator.status(actor, runId, turnId);
          const event = {
            status: state.status,
            modelCalls: state.calls,
            requestedTools: state.tools,
          };
          controller.enqueue(
            new TextEncoder().encode(
              `event: status\ndata: ${JSON.stringify(event)}\n\n`,
            ),
          );
          if (state.status !== "running" || reads >= 30) controller.close();
        } catch {
          if (!abort.signal.aborted) controller.close();
        }
      },
      cancel() {
        abort.abort();
      },
    }),
    {
      headers: {
        "content-type": "text/event-stream",
        "cache-control": "no-store",
        "x-content-type-options": "nosniff",
      },
    },
  );
}
