import { defineHandler } from "nitro/h3";
import { start } from "workflow/api";
import { ceremonyAgentWorkflow } from "../../src/server/agent/workflow.js";
import { getHostedMcp } from "../../src/server/hosted/mcp.js";

/**
 * The MCP endpoint, mounted outside `/api` because a chat client is not the
 * browser application: it authenticates with a bearer token rather than the
 * session cookie, so it does not pass through the browser request boundary.
 *
 * `ceremony_agent_start` hands its turn to the same durable workflow the
 * HTTP start route does, rather than running a model loop inside the tool
 * call.
 */
export default defineHandler(async (event) => {
  const mcp = await getHostedMcp(async (runId, turnId) => {
    await start(ceremonyAgentWorkflow, [runId, turnId]);
  });
  const handled = await mcp?.fetch(event.req);
  return (
    handled ??
    Response.json(
      { error: "mcp-unavailable" },
      { status: 503, headers: { "cache-control": "no-store" } },
    )
  );
});
