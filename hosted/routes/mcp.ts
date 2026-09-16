import { defineHandler } from "nitro/h3";
import { getHostedMcp } from "../../src/server/hosted/mcp.js";

/**
 * The MCP endpoint, mounted outside `/api` because a chat client is not the
 * browser application: it authenticates with a bearer token rather than the
 * session cookie, so it does not pass through the browser request boundary.
 */
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
