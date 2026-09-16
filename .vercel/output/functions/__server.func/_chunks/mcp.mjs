import { createRequire as __wkfCreateRequire } from "node:module";
if (typeof globalThis.require === "undefined") globalThis.require = __wkfCreateRequire(import.meta.url);
import { ZodError, _enum, array, number, object, record, strictObject, string, url, uuid } from "../_libs/@ai-sdk/gateway+[...].mjs";
import { McpServer, createMcpHandler, getOAuthProtectedResourceMetadataUrl } from "../_libs/modelcontextprotocol__server.mjs";
import { AuthorizationError, actorContextSchema, getHostedRuntime } from "./runtime.mjs";
import { ceremonyAgentTools } from "./agent-tools.mjs";
import { G, H, j } from "../_libs/modelcontextprotocol__ext-apps.mjs";
import { allowInsecureRequests, discoveryRequest, processDiscoveryResponse, validateJwtAccessToken } from "../_libs/oauth4webapi.mjs";
import { createHash, randomUUID } from "node:crypto";
//#region src/server/mcp-app.ts
const grantSchema = object({
	owner: string(),
	instanceId: string(),
	revision: number(),
	expiresAt: number()
});
/** Register on an authenticated MCP server; mount handleRequest on the broker HTTPS origin. */
function registerPrivateCollector(server, controller, db, options) {
	const brokerOrigin = new URL(options.brokerOrigin).origin;
	const appOrigin = new URL(options.appOrigin).origin;
	if (![brokerOrigin, appOrigin].every((origin) => origin.startsWith("https://"))) throw new Error("Private MCP collection requires stable HTTPS origins");
	const uri = "ui://ceremony/private-collector.html";
	const endpoint = `${brokerOrigin}/ceremony/private-collection`;
	G(server, "Private credential collector", uri, {}, async () => ({ contents: [{
		uri,
		mimeType: "text/html;profile=mcp-app",
		text: options.appHtml,
		_meta: { ui: {
			domain: appOrigin,
			csp: { connectDomains: [brokerOrigin] }
		} }
	}] }));
	j(server, "ceremony_collect_private", {
		description: "Ask the human to supply required credentials privately. Never put credentials in tool arguments or chat.",
		inputSchema: object({ instanceId: uuid() }).strict(),
		_meta: { ui: { resourceUri: uri } }
	}, async ({ instanceId }, context) => {
		try {
			const owner = await options.owner(context);
			if (!owner || !options.requestOwner || !H(server.server.getClientCapabilities())?.mimeTypes?.includes("text/html;profile=mcp-app")) return {
				isError: true,
				content: [{
					type: "text",
					text: "Private MCP Apps collection is unavailable. Continue in the authenticated ceremony webpage; never send credentials in chat."
				}]
			};
			const snapshot = await controller.read(owner, instanceId);
			if (!snapshot.actions.includes("submit")) throw new Error("No collection pending");
			const handle = randomUUID();
			db.put(`mcp-collection:${handle}`, {
				owner,
				instanceId,
				revision: snapshot.revision,
				expiresAt: Date.now() + 3e5
			});
			return {
				content: [{
					type: "text",
					text: "Waiting for private input from the human."
				}],
				_meta: { collection: {
					handle,
					endpoint,
					instanceId,
					revision: snapshot.revision,
					fields: snapshot.fields
				} }
			};
		} catch {
			return {
				isError: true,
				content: [{
					type: "text",
					text: "Private collection could not start. Refresh the ceremony."
				}]
			};
		}
	});
	j(server, "ceremony_bind_private", {
		description: "Bind a one-use credential reference; this tool never accepts raw credentials.",
		inputSchema: object({
			instanceId: uuid(),
			revision: number().int().nonnegative(),
			secretRef: uuid()
		}).strict(),
		_meta: { ui: {
			resourceUri: uri,
			visibility: ["app"]
		} }
	}, async ({ instanceId, revision, secretRef }, context) => {
		try {
			const owner = await options.owner(context);
			if (!owner) throw new Error("Authentication required");
			const snapshot = await controller.act(owner, instanceId, {
				action: "submit",
				revision,
				secretRef
			});
			return {
				content: [{
					type: "text",
					text: snapshot.step === "error" ? "Credential verification failed." : "Private input submitted; check ceremony status."
				}],
				isError: snapshot.step === "error"
			};
		} catch {
			return {
				isError: true,
				content: [{
					type: "text",
					text: "The reference is invalid, expired or stale. Refresh private collection."
				}]
			};
		}
	});
	return { async handleRequest(request) {
		if (new URL(request.url).href !== endpoint) return void 0;
		if (request.headers.get("origin") !== appOrigin) return new Response("Forbidden", { status: 403 });
		const headers = {
			"access-control-allow-origin": appOrigin,
			"access-control-allow-credentials": "true",
			"access-control-allow-methods": "POST",
			"access-control-allow-headers": "content-type,x-ceremony-collection",
			"cache-control": "no-store",
			vary: "Origin",
			"content-type": "application/json"
		};
		if (request.method === "OPTIONS") return new Response(null, {
			status: 204,
			headers
		});
		if (request.method !== "POST" || request.headers.get("content-type")?.split(";")[0]?.trim() !== "application/json") return new Response("{}", {
			status: 405,
			headers
		});
		let recipient;
		try {
			recipient = await options.requestOwner?.(request) ?? null;
		} catch {
			return new Response("{}", {
				status: 403,
				headers
			});
		}
		if (typeof recipient !== "string" || !recipient) return new Response("{}", {
			status: 403,
			headers
		});
		try {
			const handle = uuid().parse(request.headers.get("x-ceremony-collection"));
			const issued = db.get(`mcp-collection:${handle}`, grantSchema);
			if (!issued || issued.owner !== recipient || issued.expiresAt <= Date.now()) return new Response("{}", {
				status: 403,
				headers
			});
			const reader = request.body?.getReader();
			if (!reader) throw new Error("Missing body");
			const chunks = [];
			let length = 0;
			try {
				for (;;) {
					const chunk = await reader.read();
					if (chunk.done) break;
					length += chunk.value.byteLength;
					if (length > 64e3) {
						await reader.cancel();
						throw new Error("Oversize input");
					}
					chunks.push(chunk.value);
				}
			} finally {
				reader.releaseLock();
			}
			const values = record(string(), string().max(4096)).parse(JSON.parse(Buffer.concat(chunks).toString()));
			const secretRef = db.transaction(() => {
				const grant = db.get(`mcp-collection:${handle}`, grantSchema);
				if (!grant || grant.owner !== recipient || grant.expiresAt <= Date.now()) throw new Error("Expired collection");
				const ref = controller.collect(grant.owner, grant.instanceId, grant.revision, values);
				db.delete(`mcp-collection:${handle}`);
				return ref;
			});
			return new Response(JSON.stringify({ secretRef }), { headers });
		} catch {
			return new Response("{\"error\":\"Private collection failed. Start a new collection.\"}", {
				status: 400,
				headers
			});
		}
	} };
}
//#endregion
//#region src/server/mcp.ts
const bearer = /^Bearer +([^\s]+)$/i;
function refusal(message) {
	return {
		isError: true,
		content: [{
			type: "text",
			text: message
		}]
	};
}
/** A failure tells the model what to do next; it never echoes provider detail. */
function explain(error) {
	if (error instanceof AuthorizationError) return {
		unauthenticated: "Sign in to the ceremony application first.",
		denied: "This run belongs to a different session or subject.",
		invalid_request: "That request is not valid for this ceremony.",
		rate_limited: "Too many attempts. Wait before retrying."
	}[error.code];
	if (error instanceof ZodError) return "Those arguments are not valid.";
	return "The ceremony could not be advanced. Read the run again.";
}
function createCeremonyMcpHandler(runtime, options) {
	const resourceUrl = new URL(options.resourceUrl);
	const metadataUrl = getOAuthProtectedResourceMetadataUrl(resourceUrl);
	const metadata = {
		resource: resourceUrl.href,
		authorization_servers: [options.issuer],
		scopes_supported: [
			"executor",
			"author",
			"reviewer",
			"publisher",
			"admin"
		],
		bearer_methods_supported: ["header"],
		resource_name: options.serverName ?? "Ceremony"
	};
	const challenge = () => new Response(null, {
		status: 401,
		headers: {
			"www-authenticate": `Bearer resource_metadata="${metadataUrl}"`,
			"cache-control": "no-store"
		}
	});
	const tools = ceremonyAgentTools(runtime);
	const collectorOrigins = options.privateCollector;
	const collectorAvailable = Boolean(collectorOrigins && collectorOrigins.brokerOrigin.startsWith("https://") && collectorOrigins.appOrigin.startsWith("https://"));
	function build(context) {
		const actor = context.authInfo?.extra?.actor;
		const server = new McpServer({
			name: options.serverName ?? "ceremony",
			version: options.serverVersion ?? "1.0.0"
		});
		const run = async (operate) => {
			if (!actor) return refusal("Sign in to the ceremony application first.");
			try {
				return { content: [{
					type: "text",
					text: JSON.stringify(await operate(actor))
				}] };
			} catch (error) {
				options.onerror?.(error instanceof Error ? error : new Error(String(error)));
				return refusal(explain(error));
			}
		};
		server.registerTool("ceremony_connect", {
			description: "Start connecting a service and run every step that does not need a person. Returns the run, including the step now waiting.",
			inputSchema: strictObject({ connectorId: string().describe("A connector this deployment offers, such as github.") })
		}, async (input) => await run((who) => tools.connect(who, input)));
		server.registerTool("ceremony_snapshot", {
			description: "Read the current state of a run. Use this after a person has been asked to do something.",
			inputSchema: strictObject({ runId: string() })
		}, async (input) => await run((who) => tools.snapshot(who, input)));
		server.registerTool("ceremony_advance", {
			description: "Advance one step of a run. The revision must be the one you last read.",
			inputSchema: strictObject({
				runId: string(),
				nodeId: string(),
				revision: number().int().positive(),
				commandId: string().describe("Your own id for this attempt, so a retry is not a second attempt.")
			})
		}, async (input) => await run((who) => tools.advance(who, input)));
		server.registerTool("ceremony_cancel", {
			description: "Cancel a run. This does not revoke access a completed ceremony already granted.",
			inputSchema: strictObject({
				runId: string(),
				revision: number().int().positive()
			})
		}, async (input) => await run((who) => tools.cancel(who, input)));
		server.registerTool("ceremony_connectors", {
			description: "List the services this deployment can connect.",
			inputSchema: strictObject({})
		}, async () => ({ content: [{
			type: "text",
			text: JSON.stringify({
				connectors: runtime.connectors,
				privateCollection: collectorAvailable ? "in-chat" : "web-application-only"
			})
		}] }));
		if (collectorOrigins && collectorAvailable) registerPrivateCollector(server, collectorOrigins.controller, collectorOrigins.db, {
			brokerOrigin: collectorOrigins.brokerOrigin,
			appOrigin: collectorOrigins.appOrigin,
			appHtml: collectorOrigins.appHtml,
			owner: () => actor?.subjectId ?? "",
			requestOwner: collectorOrigins.requestOwner
		});
		return server;
	}
	const handler = createMcpHandler(build, { ...options.onerror ? { onerror: options.onerror } : {} });
	return {
		/** True when the in-chat collector is mounted; false means web-only. */
		collectorAvailable,
		metadataUrl,
		/** Answers the MCP endpoint and its RFC 9728 metadata; undefined otherwise. */
		async fetch(request) {
			const url = new URL(request.url);
			if (url.pathname === new URL(metadataUrl).pathname) return Response.json(metadata, { headers: { "cache-control": "no-store" } });
			if (url.pathname !== resourceUrl.pathname) return void 0;
			const token = bearer.exec(request.headers.get("authorization") ?? "")?.[1];
			if (!token) return challenge();
			let actor;
			try {
				actor = await options.authenticate(token, request);
			} catch {
				actor = null;
			}
			if (!actor) return challenge();
			const authInfo = {
				token,
				clientId: actor.sessionId,
				scopes: actor.capabilities,
				extra: { actor }
			};
			return await handler.fetch(request, { authInfo });
		}
	};
}
//#endregion
//#region src/server/mcp-identity.ts
/**
* One chat connection is one session for as long as its grant lasts.
*
* A run is drivable only from the session that created it, so this cannot be
* the token's own id: refreshing an access token mid-ceremony would orphan the
* run the previous token started. Subject plus client is stable across refresh
* and still separates two different chat clients held by the same person.
*/
function sessionFor(subject, clientId) {
	const material = `${subject}\u0000${clientId}`;
	return `mcp:${createHash("sha256").update(material).digest("hex").slice(0, 32)}`;
}
async function createMcpIdentity(config) {
	const issuer = new URL(config.issuer);
	if (issuer.username || issuer.password || issuer.search || issuer.hash || issuer.protocol !== "https:" && !(config.development === true && issuer.protocol === "http:" && issuer.hostname === "127.0.0.1")) throw new AuthorizationError("invalid_request");
	const options = { [allowInsecureRequests]: config.development === true };
	const as = config.metadata ?? await processDiscoveryResponse(issuer, await discoveryRequest(issuer, options));
	if (as.issuer !== issuer.href.replace(/\/$/, "") && as.issuer !== issuer.href) throw new AuthorizationError("invalid_request");
	if (!as.jwks_uri) throw new AuthorizationError("invalid_request");
	return async function authenticate(_token, request) {
		try {
			const claims = await validateJwtAccessToken(as, request, config.audience, options);
			if (!claims.sub || !claims.client_id) return null;
			const mapped = await config.mapClaims(claims);
			return actorContextSchema.parse({
				...mapped,
				sessionId: sessionFor(claims.sub, String(claims.client_id)),
				actorKind: "agent"
			});
		} catch {
			return null;
		}
	};
}
let instance;
function getHostedMcp() {
	return instance ??= createHostedMcp().catch(() => {
		instance = void 0;
	});
}
async function createHostedMcp(env = process.env) {
	const config = strictObject({
		origin: url(),
		issuer: url(),
		tenant: string().min(1).max(100)
	}).safeParse({
		origin: env.CEREMONY_PUBLIC_ORIGIN,
		issuer: env.CEREMONY_OIDC_ISSUER,
		tenant: env.CEREMONY_TENANT_ID
	});
	if (!config.success) return void 0;
	const resourceUrl = new URL("/mcp", config.data.origin).href;
	const runtime = await getHostedRuntime();
	const authenticate = await createMcpIdentity({
		issuer: config.data.issuer,
		audience: resourceUrl,
		mapClaims: async (claims) => ({
			tenantId: config.data.tenant,
			subjectId: String(claims.sub),
			capabilities: array(_enum([
				"author",
				"reviewer",
				"publisher",
				"executor",
				"admin"
			])).max(5).catch(["executor"]).parse(claims.ceremony_roles ?? ["executor"])
		})
	});
	return createCeremonyMcpHandler(runtime, {
		resourceUrl,
		issuer: config.data.issuer,
		authenticate,
		serverName: "Ceremony"
	});
}
//#endregion
export { getHostedMcp };
