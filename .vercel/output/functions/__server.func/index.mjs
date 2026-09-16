globalThis.__nitro_main__ = import.meta.url;
import { createRequire as __wkfCreateRequire } from "node:module";
if (typeof globalThis.require === "undefined") globalThis.require = __wkfCreateRequire(import.meta.url);
import { H3Core, HTTPError, NodeResponse, createMatcherFromFind, defineLazyEventHandler, memoizeRouteRulesMatcher, toNodeHandler } from "./_libs/h3+rou3+srvx.mjs";
//#region #nitro/virtual/routing
const findRouteRules = (m, p) => {
	return [];
};
const _lazy_34d3ce1beb854385 = defineLazyEventHandler(() => import("./_...path_.mjs"));
const _lazy_f6bd14bf7653bad0 = defineLazyEventHandler(() => import("./_2...path_.mjs"));
const _lazy_c7c6983bbd99d8cf = defineLazyEventHandler(() => import("./_routes/mcp.mjs"));
const findRoute = /* @__PURE__ */ (() => {
	const $0 = {
		route: "/mcp",
		handler: _lazy_c7c6983bbd99d8cf
	}, $1 = {
		route: "/.well-known/oauth-protected-resource/**:path",
		handler: _lazy_34d3ce1beb854385
	}, $2 = {
		route: "/api/**:path",
		handler: _lazy_f6bd14bf7653bad0
	};
	return (m, p) => {
		if (p.charCodeAt(p.length - 1) === 47) p = p.slice(0, -1);
		if (p === "/mcp") return { data: $0 };
		else if (p.charCodeAt(p.length - 1) === 47) {
			if (p === "/mcp/") return { data: $0 };
		}
		let s = p.split("/");
		if (s.length > 1 && s[s.length - 1] === "") {
			s.pop();
			p = p.slice(0, -1);
		}
		let l = s.length;
		if (l > 1) {
			if (s[1] === ".well-known") {
				if (l > 2) {
					if (s[2] === "oauth-protected-resource") {
						if (l > 3) return {
							data: $1,
							params: { "path": p.slice(38) }
						};
					}
				}
			} else if (s[1] === "api") {
				if (l > 2) return {
					data: $2,
					params: { "path": p.slice(5) }
				};
			}
		}
	};
})();
[].filter(Boolean);
//#endregion
//#region node_modules/nitro/dist/runtime/internal/error/prod.mjs
const errorHandler = (error, event) => {
	const res = defaultHandler(error, event);
	return new NodeResponse(typeof res.body === "string" ? res.body : JSON.stringify(res.body, null, 2), res);
};
function defaultHandler(error, event) {
	const unhandled = error.unhandled ?? !HTTPError.isError(error);
	const { status = 500, statusText = "" } = unhandled ? {} : error;
	if (status === 404) {
		const url = event.url || new URL(event.req.url);
		const baseURL = "/";
		if (/^\/[^/]/.test(baseURL) && !url.pathname.startsWith(baseURL)) return {
			status: 302,
			headers: new Headers({ location: `${baseURL}${url.pathname.slice(1)}${url.search}` })
		};
	}
	const headers = new Headers(unhandled ? {} : error.headers);
	headers.set("content-type", "application/json; charset=utf-8");
	return {
		status,
		statusText,
		headers,
		body: {
			error: true,
			...unhandled ? {
				status,
				unhandled: true
			} : typeof error.toJSON === "function" ? error.toJSON() : {
				status,
				statusText,
				message: error.message
			}
		}
	};
}
//#endregion
//#region #nitro/virtual/error-handler
const errorHandlers = [errorHandler];
async function error_handler_default(error, event) {
	for (const handler of errorHandlers) try {
		const response = await handler(error, event, { defaultHandler });
		if (response) return response;
	} catch (error) {
		console.error(error);
	}
}
//#endregion
//#region #nitro/virtual/app
function createNitroApp() {
	const captureError = (error, errorCtx) => {
		if (errorCtx?.event) {
			const errors = errorCtx.event.req.context?.nitro?.errors;
			if (errors) errors.push({
				error,
				context: errorCtx
			});
		}
	};
	const h3App = createH3App({ onError(error, event) {
		return error_handler_default(error, event);
	} });
	let appHandler = (req) => {
		req.context ||= {};
		req.context.nitro = req.context.nitro || { errors: [] };
		return h3App.fetch(req);
	};
	return {
		fetch: appHandler,
		h3: h3App,
		hooks: void 0,
		captureError
	};
}
function createH3App(config) {
	const h3App = new H3Core(config);
	h3App["~findRoute"] = (event) => {
		return findRoute(event.req.method, event.url.pathname);
	};
	return h3App;
}
//#endregion
//#region node_modules/nitro/dist/runtime/internal/app.mjs
const APP_ID = "default";
function useNitroApp() {
	let instance = useNitroApp._instance;
	if (instance) return instance;
	instance = useNitroApp._instance = createNitroApp();
	globalThis.__nitro__ = globalThis.__nitro__ || {};
	globalThis.__nitro__[APP_ID] = instance;
	return instance;
}
let _matchRouteRules;
function getRouteRules(method, pathname) {
	return (_matchRouteRules ??= memoizeRouteRulesMatcher(createMatcherFromFind(findRouteRules)))(method, pathname);
}
function isrRouteRewrite(reqUrl, xNowRouteMatches) {
	const queryIndex = reqUrl.indexOf("?");
	const reqParams = queryIndex === -1 ? new URLSearchParams() : new URLSearchParams(reqUrl.slice(queryIndex + 1));
	const isrURL = xNowRouteMatches ? new URLSearchParams(xNowRouteMatches).get("__isr_route") : reqParams.get("__isr_route");
	if (!isrURL) return;
	reqParams.delete("__isr_route");
	return [isrURL, reqParams.toString()];
}
//#endregion
//#region node_modules/nitro/dist/presets/vercel/runtime/vercel.node.mjs
const nitroApp = useNitroApp();
const handler = toNodeHandler(nitroApp.fetch);
async function nodeHandler(req, res) {
	let ip;
	Object.defineProperty(req.socket, "remoteAddress", { get() {
		const h = req.headers["x-forwarded-for"];
		return ip ??= h?.split?.(",").shift()?.trim();
	} });
	const isrURL = isrRouteRewrite(req.url, req.headers["x-now-route-matches"]);
	if (isrURL) {
		const { routeRules } = getRouteRules("", isrURL[0]);
		if (routeRules?.isr) req.url = isrURL[0] + (isrURL[1] ? `?${isrURL[1]}` : "");
	}
	return handler(req, res);
}
//#endregion
export { nodeHandler as default };
