import { defineHandler } from "nitro/h3";
import { getHostedMcp } from "../../../../src/server/hosted/mcp.js";

/** RFC 9728 metadata: which authorization server issues tokens for this MCP endpoint. */
export default defineHandler(async (event) => {
  const mcp = await getHostedMcp();
  const handled = await mcp?.fetch(event.req);
  return (
    handled ??
    Response.json(
      { error: "mcp-unavailable" },
      { status: 503, headers: { "cache-control": "no-store" } },
    )
  );
});
