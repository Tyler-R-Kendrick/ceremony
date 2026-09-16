import { createRequire as __wkfCreateRequire } from "node:module";
if (typeof globalThis.require === "undefined") globalThis.require = __wkfCreateRequire(import.meta.url);
import { defineHandler } from "./_libs/h3+rou3+srvx.mjs";
import { getHostedMcp } from "./_chunks/mcp.mjs";
//#region hosted/routes/.well-known/oauth-protected-resource/[...path].ts
/** RFC 9728 metadata: which authorization server issues tokens for this MCP endpoint. */
var ____path__default = defineHandler(async (event) => {
	return await (await getHostedMcp())?.fetch(event.req) ?? Response.json({ error: "mcp-unavailable" }, {
		status: 503,
		headers: { "cache-control": "no-store" }
	});
});
//#endregion
export { ____path__default as default };
