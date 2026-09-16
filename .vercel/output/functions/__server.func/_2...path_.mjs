import { createRequire as __wkfCreateRequire } from "node:module";
if (typeof globalThis.require === "undefined") globalThis.require = __wkfCreateRequire(import.meta.url);
import { defineHandler } from "./_libs/h3+rou3+srvx.mjs";
import { ZodError, _enum, _null, array, boolean, number, object, record, strictObject, string, union } from "./_libs/@ai-sdk/gateway+[...].mjs";
import { AsyncCeremonyEnvironment, AuthorizationError, PersistenceConflict, assertRequestBoundary, authenticatedActor, boundedJson, configuredModel, demonstrationConsentSchema, dispatchHostedContinuations, getHostedRuntime, identifierSchema, manifestSchema, parseRecipeImport, recipeDefinitionSchema, requireCapability, reserveRequest, semanticVersionSchema, serviceManifests, validContinuationWorker, validateAgentText, validateConnectorWorkflows } from "./_chunks/runtime.mjs";
import { ceremonyAgentTools } from "./_chunks/agent-tools.mjs";
import { generateText, output_exports } from "./_libs/ai.mjs";
import { start } from "./_libs/@workflow/core+[...].mjs";
import "./_libs/workflow.mjs";
import "node:crypto";
import { setTimeout } from "node:timers/promises";
//#region src/server/agent/workflow.ts
/** History contains only non-authorizing correlation IDs and bounded status codes. */ async function ceremonyAgentWorkflow(runId, sessionId) {
	throw new Error("You attempted to execute workflow ceremonyAgentWorkflow function directly. To start a workflow, use start(ceremonyAgentWorkflow) from workflow/api");
}
ceremonyAgentWorkflow.workflowId = "workflow//./src/server/agent/workflow//ceremonyAgentWorkflow";
async function runAgentTurn(runId, turnId) {
	try {
		const { createHostedRuntime } = await import("./_chunks/runtime.mjs").then((n) => n.runtime_exports);
		const runtime = await createHostedRuntime();
		try {
			const actor = await runtime.agentActor(runId);
			return await runtime.agent.turn(actor, runId, turnId);
		} finally {
			await runtime.store.close();
		}
	} catch {
		return "unavailable";
	}
}
runAgentTurn.stepId = "step//./src/server/agent/workflow//runAgentTurn";
//#endregion
//#region src/server/github.ts
const githubWorkflows = {
	arazzo: "1.0.1",
	info: {
		title: "GitHub App connection",
		version: "1.0.0"
	},
	sourceDescriptions: [{
		name: "github",
		url: "https://raw.githubusercontent.com/github/rest-api-description/main/descriptions/api.github.com/api.github.com.json",
		type: "openapi"
	}],
	workflows: [{
		workflowId: "register-app",
		summary: "Prepare your GitHub App",
		steps: [{
			stepId: "exchange",
			description: "Exchange the approved registration for private app credentials",
			operationId: "apps/create-from-manifest"
		}, {
			stepId: "verify",
			description: "Verify the app identity and repository permissions",
			operationId: "apps/get-authenticated"
		}]
	}, {
		workflowId: "verify-access",
		summary: "Verify repository access",
		steps: [{
			stepId: "sign",
			description: "Issue a read-only installation access token",
			operationId: "apps/create-installation-access-token"
		}, {
			stepId: "verify",
			description: "Verify access against GitHub's repository API",
			operationId: "apps/list-repos-accessible-to-installation"
		}]
	}]
};
const githubAppManifest = manifestSchema.parse({
	schemaVersion: 1,
	support: "live-adapter",
	id: "github",
	name: "GitHub",
	description: "Register or reuse a GitHub App, approve its installation, then verify repository access.",
	methods: [{
		id: "github-app",
		label: "GitHub App · installation access",
		kind: "github-app",
		fields: [],
		scopes: ["contents:read"],
		templateId: "github-app",
		contract: {
			profile: "github-app",
			surfaces: ["browser", "headless"],
			configuration: [
				{
					name: "GITHUB_APP_ID",
					source: "session-environment",
					classification: "public",
					required: false
				},
				{
					name: "GITHUB_APP_SLUG",
					source: "session-environment",
					classification: "public",
					required: false
				},
				{
					name: "GITHUB_APP_OWNER",
					source: "session-environment",
					classification: "personal",
					required: false
				},
				{
					name: "GITHUB_APP_PRIVATE_KEY",
					source: "session-environment",
					classification: "secret",
					required: false
				}
			],
			prerequisites: [{
				id: "prepare-app",
				kind: "provider-registration",
				reuse: "verified-context",
				handoff: {
					surface: "provider-browser",
					recipient: "authorized-owner",
					delegation: "a2h-authorize",
					resume: "verify"
				}
			}, {
				id: "authorize-installation",
				kind: "provider-consent",
				reuse: "verified-context",
				handoff: {
					surface: "provider-browser",
					recipient: "authorized-owner",
					delegation: "a2h-authorize",
					resume: "verify"
				}
			}],
			configurationGroups: [{
				id: "existing-app",
				rule: "all-or-none",
				names: [
					"GITHUB_APP_ID",
					"GITHUB_APP_SLUG",
					"GITHUB_APP_OWNER",
					"GITHUB_APP_PRIVATE_KEY"
				]
			}],
			handoff: {
				surface: "provider-browser",
				recipient: "initiating-subject",
				delegation: "a2h-authorize",
				resume: "verify"
			},
			completion: {
				verifier: "github.verify-connection",
				ownership: ["authenticated"]
			},
			workflows: [{
				document: "github",
				version: "1.0.0",
				workflowId: "register-app"
			}, {
				document: "github",
				version: "1.0.0",
				workflowId: "verify-access"
			}]
		}
	}]
});
validateConnectorWorkflows(githubAppManifest, /* @__PURE__ */ new Map([["github", githubWorkflows]]));
const appSchema = object({
	id: number().int().positive(),
	slug: string().regex(/^[a-zA-Z0-9-]+$/),
	pem: string().max(3e4),
	owner: object({ login: string() })
});
object({
	owner: string(),
	phase: _enum([
		"prepare",
		"register",
		"converting",
		"install",
		"verify",
		"complete",
		"cancelled",
		"uncertain"
	]),
	nonce: string(),
	expiresAt: number(),
	app: appSchema.optional(),
	installationId: number().int().positive().optional(),
	connectionRef: string().optional()
});
//#endregion
//#region src/server/agent/stream.ts
/** A reconnect rereads authoritative state. Disconnect never cancels domain execution. */
async function agentStatusStream(coordinator, actor, runId, turnId, authorize) {
	await authorize?.();
	await coordinator.status(actor, runId, turnId);
	const abort = new AbortController();
	let reads = 0;
	return new Response(new ReadableStream({
		async pull(controller) {
			try {
				if (reads++) await setTimeout(1e3, void 0, { signal: abort.signal });
				await authorize?.();
				const state = await coordinator.status(actor, runId, turnId);
				const event = {
					status: state.status,
					modelCalls: state.calls,
					requestedTools: state.tools
				};
				controller.enqueue(new TextEncoder().encode(`event: status\ndata: ${JSON.stringify(event)}\n\n`));
				if (state.status !== "running" || reads >= 30) controller.close();
			} catch {
				if (!abort.signal.aborted) controller.close();
			}
		},
		cancel() {
			abort.abort();
		}
	}), { headers: {
		"content-type": "text/event-stream",
		"cache-control": "no-store",
		"x-content-type-options": "nosniff"
	} });
}
//#endregion
//#region src/server/agent/authoring.ts
const labels = strictObject({
	title: string().min(1).max(100),
	description: string().max(500)
});
const operationsSchema = array(strictObject({
	id: identifierSchema,
	version: semanticVersionSchema
})).min(1).max(32);
/** Labels are suggestions only. This does not grant publication or change executable semantics. */
async function suggestRecipeLabels(store, actor, draftId, operations, model) {
	requireCapability(actor, "author");
	identifierSchema.parse(draftId);
	const catalog = operationsSchema.parse(operations);
	for (const operation of catalog) {
		validateAgentText(operation.id);
		validateAgentText(operation.version);
	}
	if (!model) return null;
	for (let attempt = 0; attempt < 2; attempt++) {
		if (!await store.transaction(async (tx) => {
			const key = {
				tenant: actor.tenantId,
				kind: "budget",
				id: `authoring:${draftId}`
			};
			const prior = await tx.get(key);
			if (prior && prior.value.subjectId !== actor.subjectId) throw new Error("denied");
			if ((prior?.value.calls ?? 0) >= 2) return false;
			await tx.put(key, {
				subjectId: actor.subjectId,
				calls: (prior?.value.calls ?? 0) + 1
			}, prior?.revision ?? null);
			return true;
		})) return null;
		try {
			const result = await generateText({
				model,
				output: output_exports.object({ schema: labels }),
				maxOutputTokens: 300,
				maxRetries: 0,
				abortSignal: AbortSignal.timeout(15e3),
				telemetry: { isEnabled: false },
				prompt: `Suggest concise plain-language labels for these registered authentication operations. Do not claim verified authorization. Return only the required object. ${JSON.stringify(catalog)}`
			});
			return labels.parse(result.output);
		} catch {}
	}
	return null;
}
//#endregion
//#region src/server/teaching-http.ts
const revision = number().int().positive();
const id = string().regex(/^[a-zA-Z][a-zA-Z0-9_.:-]{0,119}$/);
const review = strictObject({
	revision,
	digest: string().regex(/^[a-f0-9]{64}$/)
});
const reply = (value, status = 200) => Response.json(value, {
	status,
	headers: {
		"cache-control": "no-store",
		"referrer-policy": "no-referrer",
		"x-content-type-options": "nosniff"
	}
});
/** Mounted unchanged by the local example and authenticated hosted adapter. */
async function teachingHttp(request, runtime, startAgent) {
	try {
		const path = new URL(request.url).pathname.replace(/^\/api\/v1\/teaching/, "");
		assertRequestBoundary(request, { origin: runtime.origin });
		let actor;
		try {
			actor = await authenticatedActor(request, runtime.identity);
		} catch (error) {
			if (path === "/capabilities" && request.method === "GET" && error instanceof AuthorizationError && error.code === "unauthenticated") return reply({
				available: true,
				authenticated: false,
				modelAvailable: false
			});
			throw error;
		}
		await reserveRequest(runtime.store, actor, 120, 6e4);
		if (!["GET", "POST"].includes(request.method)) return reply({ error: "unavailable" }, 405);
		const post = request.method === "POST";
		if (path === "/github/installation-return" && runtime.humanReturn) {
			if (post) return reply({ error: "unavailable" }, 405);
			requireCapability(actor, "executor");
			if (actor.actorKind !== "human") throw new AuthorizationError("denied");
			return await runtime.humanReturn(actor, request);
		}
		if ((/^\/github\/[^/]+\/(human|callback|recovery)$/.test(path) || /^\/stripe\/[^/]+\/human$/.test(path)) && runtime.human) {
			const action = path.split("/")[3];
			if (post && action !== "recovery" && !path.startsWith("/stripe/")) return reply({ error: "unavailable" }, 405);
			if (actor.actorKind !== "human") throw new AuthorizationError("denied");
			requireCapability(actor, "executor");
			const runId = id.parse(decodeURIComponent(path.split("/")[2]));
			await runtime.commands.snapshot(actor, runId);
			return await runtime.human(actor, runId, request);
		}
		const body = post ? await boundedJson(request) : void 0;
		if (path.startsWith("/tools/")) {
			requireCapability(actor, "executor");
			if (!post) return reply({ error: "unavailable" }, 405);
			const tools = ceremonyAgentTools(runtime);
			if (path === "/tools/connect") return reply(await tools.connect(actor, body));
			if (path === "/tools/snapshot") return reply(await tools.snapshot(actor, body));
			if (path === "/tools/advance") return reply(await tools.advance(actor, body));
			if (path === "/tools/cancel") return reply(await tools.cancel(actor, body));
			return reply({ error: "unavailable" }, 404);
		}
		if (path === "/capabilities" && !post) return reply({
			available: true,
			authenticated: true,
			modelAvailable: Boolean(runtime.modelConfiguration.model),
			signOutAvailable: typeof Reflect.get(runtime.identity, "logout") === "function",
			connectors: runtime.connectors
		});
		if (path === "/runs" && post) {
			const input = strictObject({
				connectorId: id,
				teach: boolean().optional(),
				target: string().regex(/^[a-zA-Z0-9-]{1,100}$/).optional()
			}).parse(body);
			if (!runtime.connectors.includes(input.connectorId)) throw new AuthorizationError("invalid_request");
			if (input.target) {
				if (!runtime.selectTarget) throw new AuthorizationError("denied");
				await runtime.selectTarget(actor, input.target, input.connectorId);
			}
			let run = await runtime.connect(actor, input.connectorId);
			const demo = input.teach ? await runtime.demonstrations.start(actor, run.id) : void 0;
			for (const node of run.nodes) {
				if (node.verified) continue;
				const result = await runtime.commands.advance(actor, run.id, node.id, run.revision, `auto:${run.id}:${node.id}:${run.revision}`);
				run = await runtime.commands.snapshot(actor, run.id);
				if (result.state !== "complete") break;
			}
			return reply({
				...run,
				...demo ? { demonstration: demo } : {}
			});
		}
		const runRoute = /^\/runs\/([^/]+)(?:\/(advance|cancel))?$/.exec(path);
		const activeDemo = /^\/runs\/([^/]+)\/demonstration$/.exec(path);
		if (activeDemo && !post) {
			const runId = id.parse(decodeURIComponent(activeDemo[1]));
			await runtime.commands.snapshot(actor, runId);
			const pointer = await runtime.store.transaction((tx) => tx.get({
				tenant: actor.tenantId,
				kind: "session",
				id: `demonstration:${runId}`
			}));
			if (!pointer) return reply({ demonstration: null });
			try {
				return reply({ demonstration: await runtime.demonstrations.timeline(actor, pointer.value.id) });
			} catch {
				return reply({ demonstration: null });
			}
		}
		if (runRoute) {
			const runId = id.parse(decodeURIComponent(runRoute[1]));
			if (!post && !runRoute[2]) return reply(await runtime.commands.snapshot(actor, runId));
			if (post && runRoute[2] === "cancel") {
				const result = await runtime.commands.cancel(actor, runId, strictObject({ revision }).parse(body).revision);
				await runtime.cancel?.(actor, runId);
				return reply(result);
			}
			if (post && runRoute[2] === "advance") {
				const input = strictObject({
					nodeId: id,
					revision,
					commandId: id
				}).parse(body);
				await runtime.commands.advance(actor, runId, input.nodeId, input.revision, input.commandId);
				return reply(await runtime.commands.snapshot(actor, runId));
			}
		}
		if (path === "/demonstrations" && post) {
			const input = strictObject({
				runId: id,
				scope: array(id).max(32).optional()
			}).parse(body);
			return reply(await runtime.demonstrations.start(actor, input.runId, input.scope));
		}
		const demoRoute = /^\/demonstrations\/([^/]+)$/.exec(path);
		if (demoRoute) {
			const demoId = id.parse(decodeURIComponent(demoRoute[1]));
			if (post) {
				const input = strictObject({
					revision,
					consent: demonstrationConsentSchema
				}).parse(body);
				return reply(await runtime.demonstrations.change(actor, demoId, input.revision, input.consent));
			}
			const url = new URL(request.url);
			return reply(await runtime.demonstrations.timeline(actor, demoId, Number(url.searchParams.get("after") ?? 0), Number(url.searchParams.get("limit") ?? 100)));
		}
		if (path === "/drafts/compile" && post) {
			const input = strictObject({
				demonstrationId: id,
				first: number().int().nonnegative(),
				last: number().int().nonnegative()
			}).parse(body);
			if (input.first < 1 || input.last < input.first || input.last - input.first >= 1e3) throw new AuthorizationError("invalid_request");
			const events = [];
			let after = input.first - 1;
			while (after < input.last) {
				const page = await runtime.demonstrations.timeline(actor, input.demonstrationId, after, Math.min(100, input.last - after));
				if (!page.events.length) break;
				events.push(...page.events.filter((event) => event.sequence <= input.last));
				after = page.events.at(-1).sequence;
			}
			return reply(await runtime.recipes.compileDraft(actor, events, {
				first: input.first,
				last: input.last
			}));
		}
		if (path === "/drafts/import" && post) {
			const input = strictObject({ definition: string().max(262144) }).parse(body);
			return reply(await runtime.recipes.createDraft(actor, parseRecipeImport(input.definition)));
		}
		const draftRoute = /^\/drafts\/([^/]+)(?:\/(edit|review|publish|suggest))?$/.exec(path);
		if (draftRoute) {
			const draftId = id.parse(decodeURIComponent(draftRoute[1]));
			if (!post && !draftRoute[2]) return reply(await runtime.recipes.getDraft(actor, draftId));
			if (post && draftRoute[2] === "edit") {
				const input = strictObject({
					revision,
					definition: recipeDefinitionSchema
				}).parse(body);
				return reply(await runtime.recipes.editDraft(actor, draftId, input.revision, input.definition));
			}
			if (post && draftRoute[2] === "suggest") {
				strictObject({ revision }).parse(body);
				const draft = await runtime.recipes.getDraft(actor, draftId);
				if (draft.revision !== strictObject({ revision }).parse(body).revision) throw new PersistenceConflict();
				if (draft.author !== actor.subjectId) throw new AuthorizationError("denied");
				const preview = await runtime.recipes.preview(actor, draft.definition);
				if (preview.diagnostics.length) throw new AuthorizationError("invalid_request");
				const suggestion = await suggestRecipeLabels(runtime.store, actor, draftId, preview.leaves.map((leaf) => ({
					id: leaf.use.id,
					version: leaf.use.version
				})), configuredModel(runtime.modelConfiguration));
				return reply({ suggestion });
			}
			if (post && (draftRoute[2] === "review" || draftRoute[2] === "publish")) {
				const input = review.parse(body);
				return reply(await runtime.recipes[draftRoute[2]](actor, draftId, input.revision, input.digest) ?? { reviewed: true });
			}
		}
		if (path === "/recipes" && !post) {
			requireCapability(actor, "executor");
			const rows = await runtime.store.transaction((tx) => tx.list(actor.tenantId, "recipe", 100));
			return reply({ recipes: rows.filter((x) => x.value.definition && !x.value.retired).map((x) => ({
				id: x.value.definition.id,
				title: x.value.definition.title,
				version: x.value.version,
				digest: x.value.digest,
				definition: x.value.definition
			})) });
		}
		const publishedRoute = /^\/recipes\/([^/]+)\/(export|retire)$/.exec(path);
		if (publishedRoute) {
			const recipeId = id.parse(decodeURIComponent(publishedRoute[1]));
			if (post && publishedRoute[2] === "retire") {
				const input = strictObject({ version: string().regex(/^\d+\.\d+\.\d+$/) }).parse(body);
				await runtime.recipes.retire(actor, recipeId, input.version);
				return reply({ retired: true });
			}
			if (!post && publishedRoute[2] === "export") {
				const url = new URL(request.url);
				const published = await runtime.recipes.getPublished(actor, recipeId, string().regex(/^\d+\.\d+\.\d+$/).parse(url.searchParams.get("version")), string().regex(/^[a-f0-9]{64}$/).parse(url.searchParams.get("digest")));
				return reply(published.definition);
			}
		}
		if (path === "/composition/preview" && post) return reply(await runtime.recipes.preview(actor, recipeDefinitionSchema.parse(body)));
		if (path === "/recipes/compose" && post) {
			const input = strictObject({ references: array(strictObject({
				id,
				version: string(),
				digest: string()
			})).min(2).max(32) }).parse(body);
			return reply(await runtime.recipes.composePublished(actor, input.references));
		}
		if (path === "/recipes/execute" && post) {
			const input = strictObject({
				connectorId: id.default("github"),
				id,
				version: string(),
				digest: string(),
				inputs: record(id, union([
					string().max(512),
					number().finite(),
					boolean(),
					_null()
				]))
			}).parse(body);
			const published = await runtime.recipes.getPublished(actor, input.id, input.version, input.digest);
			return reply(await runtime.executeRecipe(actor, published.definition, input.inputs, input.connectorId));
		}
		const agentRoute = /^\/agent\/([^/]+)\/(start|stop|status|stream)$/.exec(path);
		if (agentRoute) {
			const runId = id.parse(decodeURIComponent(agentRoute[1]));
			if (post && agentRoute[2] === "stop") {
				strictObject({}).parse(body);
				await runtime.agent.stop(actor, runId);
				return reply({ status: "stopped" });
			}
			if (post && agentRoute[2] === "start") {
				strictObject({}).parse(body);
				if (!runtime.modelConfiguration.model) return reply({ status: "unavailable" });
				const turnId = await runtime.delegate(actor, runId);
				if (startAgent) {
					await startAgent(runId, turnId);
					return reply({
						turnId,
						status: "running"
					});
				}
				return reply({
					turnId,
					status: await runtime.agent.turn(actor, runId, turnId)
				});
			}
			if (!post && agentRoute[2] === "status") return reply(await runtime.agent.status(actor, runId, id.optional().parse(new URL(request.url).searchParams.get("turnId") ?? void 0)));
			if (!post && agentRoute[2] === "stream") return await agentStatusStream(runtime.agent, actor, runId, id.optional().parse(new URL(request.url).searchParams.get("turnId") ?? void 0), async () => {
				const current = await authenticatedActor(request, runtime.identity);
				if (current.tenantId !== actor.tenantId || current.subjectId !== actor.subjectId || current.sessionId !== actor.sessionId) throw new AuthorizationError("denied");
				requireCapability(current, "executor");
			});
		}
		return reply({ error: "unavailable" }, 404);
	} catch (error) {
		if (error instanceof Error && error.message === "account-required") return reply({ error: "account-required" }, 409);
		if (error instanceof Error && error.message === "incomplete-github-configuration") return reply({ error: "incomplete-github-configuration" }, 409);
		if (error instanceof PersistenceConflict) return reply({ error: "conflict" }, 409);
		if (error instanceof AuthorizationError) return reply({ error: error.code }, error.code === "unauthenticated" ? 401 : error.code === "invalid_request" ? 400 : 403);
		if (error instanceof ZodError) return reply({ error: "invalid_request" }, 400);
		return reply({ error: "unavailable" }, 400);
	}
}
//#endregion
//#region src/server/hosted/http.ts
function browserIdentity(identity) {
	if (!("login" in identity) || typeof identity.login !== "function" || !("callback" in identity) || typeof identity.callback !== "function" || !("logout" in identity) || typeof identity.logout !== "function") throw new Error("Hosted identity unavailable");
	return identity;
}
/** One mounted hosted route, also used by real HTTP identity integration tests. Human auth responses are never agent tools. */
async function hostedHttp(request, runtime, startAgent, worker, mcp) {
	try {
		const handled = await mcp?.fetch(request);
		if (handled) return handled;
		assertRequestBoundary(request, { origin: runtime.origin });
		const path = new URL(request.url).pathname;
		if (path === "/api/environment") {
			const actor = await authenticatedActor(request, runtime.identity);
			requireCapability(actor, "executor");
			if (actor.actorKind !== "human") throw new AuthorizationError("denied");
			await reserveRequest(runtime.store, actor);
			const environment = new AsyncCeremonyEnvironment(runtime.store);
			const result = request.method === "GET" ? await environment.describe(actor) : request.method === "POST" ? await environment.update(actor, await boundedJson(request, 131072)) : void 0;
			if (!result) throw new AuthorizationError("invalid_request");
			return Response.json(result, { headers: {
				"cache-control": "no-store",
				"referrer-policy": "no-referrer",
				"x-robots-tag": "noindex"
			} });
		}
		if (path === "/api/internal/continuations") {
			if (request.method !== "GET" || !worker || !validContinuationWorker(request, worker.secret)) throw new AuthorizationError("denied");
			await worker.dispatch();
			return Response.json({ dispatched: true }, { headers: { "cache-control": "no-store" } });
		}
		if (path === "/api/config" && request.method === "GET") return Response.json({
			manifests: [githubAppManifest],
			liveManifests: [githubAppManifest, ...serviceManifests].filter((manifest) => runtime.connectors.includes(manifest.id)),
			liveAvailable: true,
			teachingAvailable: true,
			teachingConnectors: runtime.connectors,
			generationAvailable: false
		}, { headers: { "cache-control": "no-store" } });
		if (path === "/api/workflows/github" && request.method === "GET") return Response.json(githubWorkflows, { headers: { "cache-control": "no-store" } });
		if (path === "/api/auth/callback") return await browserIdentity(runtime.identity).callback(request);
		if (path === "/api/auth/login" || path === "/api/auth/logout") {
			if (request.method !== "POST") throw new AuthorizationError("invalid_request");
			if (!object({}).strict().safeParse(await boundedJson(request, 1024)).success) throw new AuthorizationError("invalid_request");
			await reserveRequest(runtime.store, {
				tenantId: "hosted",
				subjectId: "authentication-boundary",
				sessionId: "server",
				actorKind: "system",
				capabilities: []
			}, 120);
			const identity = browserIdentity(runtime.identity);
			const response = path.endsWith("/login") ? await identity.login(request) : await identity.logout(request);
			if (response.status !== 303) throw new Error("Hosted identity response unavailable");
			const headers = new Headers(response.headers);
			headers.delete("location");
			headers.set("cache-control", "no-store");
			headers.set("referrer-policy", "no-referrer");
			if (path.endsWith("/logout")) {
				headers.set("clear-site-data", "\"cache\", \"cookies\", \"storage\"");
				return Response.json({ signedOut: true }, { headers });
			}
			const authorizationUrl = response.headers.get("location");
			if (!authorizationUrl) throw new Error("Hosted identity response unavailable");
			return Response.json({ authorizationUrl }, { headers });
		}
		return await teachingHttp(request, runtime, startAgent);
	} catch (error) {
		const status = error instanceof ZodError ? 400 : error instanceof AuthorizationError ? {
			unauthenticated: 401,
			denied: 403,
			invalid_request: 400,
			rate_limited: 429
		}[error.code] : error instanceof PersistenceConflict ? 409 : 503;
		return Response.json({ error: error instanceof ZodError ? "invalid_request" : error instanceof AuthorizationError ? error.code : "hosted-unavailable" }, {
			status,
			headers: {
				"cache-control": "no-store",
				"referrer-policy": "no-referrer"
			}
		});
	}
}
//#endregion
//#region hosted/routes/api/[...path].ts
var ____path__default = defineHandler(async (event) => {
	try {
		const runtime = await getHostedRuntime();
		return hostedHttp(event.req, runtime, async (runId, turnId) => {
			await start(ceremonyAgentWorkflow, [runId, turnId]);
		}, {
			secret: process.env.CRON_SECRET,
			dispatch: () => dispatchHostedContinuations(runtime, process.env.CEREMONY_TENANT_ID ?? "")
		});
	} catch {
		return Response.json({ error: "hosted-unavailable" }, {
			status: 503,
			headers: { "cache-control": "no-store" }
		});
	}
});
//#endregion
export { ____path__default as default };
