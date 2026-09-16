import { createRequire as __wkfCreateRequire } from "node:module";
if (typeof globalThis.require === "undefined") globalThis.require = __wkfCreateRequire(import.meta.url);
function j(B, Q, F, V) {
	let q = F._meta, J = q.ui, Z = q["ui/resourceUri"], $ = q;
	if (J?.resourceUri && !Z) $ = {
		...q,
		["ui/resourceUri"]: J.resourceUri
	};
	else if (Z && !J?.resourceUri) $ = {
		...q,
		ui: {
			...J,
			resourceUri: Z
		}
	};
	return B.registerTool(Q, {
		...F,
		_meta: $
	}, V);
}
function G(B, Q, F, V, q) {
	return B.registerResource(Q, F, {
		mimeType: "text/html;profile=mcp-app",
		...V
	}, q);
}
function H(B) {
	if (!B) return;
	return B.extensions?.["io.modelcontextprotocol/ui"];
}
//#endregion
export { G, H, j };
