import { defineHandler } from "nitro/h3";
import { getHostedRuntime } from "../../../src/server/hosted/runtime.js";
import { hostedHttp } from "../../../src/server/hosted/http.js";
import { ceremonyAgentWorkflow } from "../../../src/server/agent/workflow.js";
import { start } from "workflow/api";
import { dispatchHostedTenants } from "../../../src/server/hosted/continuations.js";

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
        // Every tenant with possible pending work, not one pinned tenant.
        dispatch: () => dispatchHostedTenants(runtime, runtime.hosted.tenancy),
      },
      undefined,
      // The `/api/v1/connectors/*` route table, including the signed events
      // route when the operator enabled it. Absent when connectors are off.
      runtime.hosted.connectors?.runtime.http,
    );
  } catch {
    return Response.json(
      { error: "hosted-unavailable" },
      { status: 503, headers: { "cache-control": "no-store" } },
    );
  }
});
