import { createHook } from "workflow";

/** History contains only non-authorizing correlation IDs and bounded status codes. */
export async function ceremonyAgentWorkflow(runId: string, sessionId: string) {
  "use workflow";
  for (let turn = 0; turn < 16; turn++) {
    using wake = createHook<{ wake: true }>({
      token: `ceremony-agent:${runId}`,
    });
    const status = await runAgentTurn(runId, `${sessionId}:${turn}`);
    if (status !== "awaiting-human") return status;
    await wake;
    // A wake never grants permission: the next step reloads current domain authority.
  }
  return "budget-exhausted";
}

export async function runAgentTurn(runId: string, turnId: string) {
  "use step";
  try {
    const { createHostedRuntime } = await import("../hosted/runtime.js");
    // A worker owns this connection pool; do not retain private runtime clients in durable history.
    const runtime = await createHostedRuntime();
    try {
      const actor = await runtime.agentActor(runId);
      return await runtime.agent.turn(actor, runId, turnId);
    } finally {
      await runtime.store.close();
    }
  } catch {
    // Framework history must never receive an exception from a private host/provider boundary.
    return "unavailable" as const;
  }
}
