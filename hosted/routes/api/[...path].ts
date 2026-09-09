import { defineHandler } from "nitro/h3";
import { getHostedRuntime } from "../../../src/server/hosted/runtime.js";
import { hostedHttp } from "../../../src/server/hosted/http.js";
import { ceremonyAgentWorkflow } from "../../../src/server/agent/workflow.js";
import { start } from "workflow/api";
import { dispatchHostedContinuations } from "../../../src/server/hosted/continuations.js";

export default defineHandler(async (event) => {
  try {
    const runtime = await getHostedRuntime();
    return hostedHttp(
      event.req,
      runtime,
      async (runId, turnId) => {
        await start(ceremonyAgentWorkflow, [runId, turnId]);
      },
      {
        secret: process.env.CRON_SECRET,
        dispatch: () =>
          dispatchHostedContinuations(
            runtime,
            process.env.CEREMONY_TENANT_ID ?? "",
          ),
      },
    );
  } catch {
    return Response.json(
      { error: "hosted-unavailable" },
      { status: 503, headers: { "cache-control": "no-store" } },
    );
  }
});
