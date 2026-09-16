import { createRequire as __wkfCreateRequire } from "node:module";
if (typeof globalThis.require === "undefined") globalThis.require = __wkfCreateRequire(import.meta.url);
import { defineHandler } from "../_libs/h3+rou3+srvx.mjs";
import { getHostedMcp } from "../_chunks/mcp.mjs";
//#region hosted/routes/mcp.ts
/**
* The MCP endpoint, mounted outside `/api` because a chat client is not the
* browser application: it authenticates with a bearer token rather than the
* session cookie, so it does not pass through the browser request boundary.
*/
var mcp_default = defineHandler(async (event) => {
	return await (await getHostedMcp())?.fetch(event.req) ?? Response.json({ error: "mcp-unavailable" }, {
		status: 503,
		headers: { "cache-control": "no-store" }
	});
});
//#endregion
export { mcp_default as default };
