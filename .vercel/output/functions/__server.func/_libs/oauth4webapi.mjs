import { createRequire as __wkfCreateRequire } from "node:module";
if (typeof globalThis.require === "undefined") globalThis.require = __wkfCreateRequire(import.meta.url);
//#region node_modules/oauth4webapi/build/index.js
let USER_AGENT;
if (typeof navigator === "undefined" || !navigator.userAgent?.startsWith?.("Mozilla/5.0 ")) USER_AGENT = `oauth4webapi/v3.8.8`;
function looseInstanceOf(input, expected) {
	if (input == null) return false;
	try {
		return input instanceof expected || Object.getPrototypeOf(input)[Symbol.toStringTag] === expected.prototype[Symbol.toStringTag];
	} catch {
		return false;
	}
}
const ERR_INVALID_ARG_VALUE = "ERR_INVALID_ARG_VALUE";
const ERR_INVALID_ARG_TYPE = "ERR_INVALID_ARG_TYPE";
function CodedTypeError(message, code, cause) {
	const err = new TypeError(message, { cause });
	Object.assign(err, { code });
	return err;
}
const allowInsecureRequests = Symbol();
const clockSkew = Symbol();
const clockTolerance = Symbol();
const customFetch = Symbol();
const jweDecrypt = Symbol();
const jwksCache = Symbol();
const encoder = new TextEncoder();
const decoder = new TextDecoder();
function buf(input) {
	if (typeof input === "string") return encoder.encode(input);
	return decoder.decode(input);
}
let encodeBase64Url;
if (Uint8Array.prototype.toBase64) encodeBase64Url = (input) => {
	if (input instanceof ArrayBuffer) input = new Uint8Array(input);
	return input.toBase64({
		alphabet: "base64url",
		omitPadding: true
	});
};
else {
	const CHUNK_SIZE = 32768;
	encodeBase64Url = (input) => {
		if (input instanceof ArrayBuffer) input = new Uint8Array(input);
		const arr = [];
		for (let i = 0; i < input.byteLength; i += CHUNK_SIZE) arr.push(String.fromCharCode.apply(null, input.subarray(i, i + CHUNK_SIZE)));
		return btoa(arr.join("")).replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_");
	};
}
let decodeBase64Url;
if (Uint8Array.fromBase64) decodeBase64Url = (input) => {
	try {
		return Uint8Array.fromBase64(input, { alphabet: "base64url" });
	} catch (cause) {
		throw CodedTypeError("The input to be decoded is not correctly encoded.", ERR_INVALID_ARG_VALUE, cause);
	}
};
else decodeBase64Url = (input) => {
	try {
		const binary = atob(input.replace(/-/g, "+").replace(/_/g, "/").replace(/\s/g, ""));
		const bytes = new Uint8Array(binary.length);
		for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
		return bytes;
	} catch (cause) {
		throw CodedTypeError("The input to be decoded is not correctly encoded.", ERR_INVALID_ARG_VALUE, cause);
	}
};
function b64u(input) {
	if (typeof input === "string") return decodeBase64Url(input);
	return encodeBase64Url(input);
}
var UnsupportedOperationError = class extends Error {
	code;
	constructor(message, options) {
		super(message, options);
		this.name = this.constructor.name;
		this.code = "OAUTH_UNSUPPORTED_OPERATION";
		Error.captureStackTrace?.(this, this.constructor);
	}
};
var OperationProcessingError = class extends Error {
	code;
	constructor(message, options) {
		super(message, options);
		this.name = this.constructor.name;
		if (options?.code) this.code = options?.code;
		Error.captureStackTrace?.(this, this.constructor);
	}
};
function OPE(message, code, cause) {
	return new OperationProcessingError(message, {
		code,
		cause
	});
}
async function calculateJwkThumbprint(jwk) {
	let components;
	switch (jwk.kty) {
		case "EC":
			components = {
				crv: jwk.crv,
				kty: jwk.kty,
				x: jwk.x,
				y: jwk.y
			};
			break;
		case "OKP":
			components = {
				crv: jwk.crv,
				kty: jwk.kty,
				x: jwk.x
			};
			break;
		case "AKP":
			components = {
				alg: jwk.alg,
				kty: jwk.kty,
				pub: jwk.pub
			};
			break;
		case "RSA":
			components = {
				e: jwk.e,
				kty: jwk.kty,
				n: jwk.n
			};
			break;
		default: throw new UnsupportedOperationError("unsupported JWK key type", { cause: jwk });
	}
	return b64u(await crypto.subtle.digest("SHA-256", buf(JSON.stringify(components))));
}
function normalizeTyp(value) {
	return value.toLowerCase().replace(/^application\//, "");
}
function isJsonObject(input) {
	if (input === null || typeof input !== "object" || Array.isArray(input)) return false;
	return true;
}
function prepareHeaders(input) {
	if (looseInstanceOf(input, Headers)) input = Object.fromEntries(input.entries());
	const headers = new Headers(input ?? {});
	if (USER_AGENT && !headers.has("user-agent")) headers.set("user-agent", USER_AGENT);
	if (headers.has("authorization")) throw CodedTypeError("\"options.headers\" must not include the \"authorization\" header name", ERR_INVALID_ARG_VALUE);
	return headers;
}
function signal(url, value) {
	if (value !== void 0) {
		if (typeof value === "function") value = value(url.href);
		if (!(value instanceof AbortSignal)) throw CodedTypeError("\"options.signal\" must return or be an instance of AbortSignal", ERR_INVALID_ARG_TYPE);
		return value;
	}
}
function replaceDoubleSlash(pathname) {
	if (pathname.includes("//")) return pathname.replace("//", "/");
	return pathname;
}
function prependWellKnown(url, wellKnown, allowTerminatingSlash = false) {
	if (url.pathname === "/") url.pathname = wellKnown;
	else url.pathname = replaceDoubleSlash(`${wellKnown}/${allowTerminatingSlash ? url.pathname : url.pathname.replace(/(\/)$/, "")}`);
	return url;
}
function appendWellKnown(url, wellKnown) {
	url.pathname = replaceDoubleSlash(`${url.pathname}/${wellKnown}`);
	return url;
}
async function performDiscovery(input, urlName, transform, options) {
	if (!(input instanceof URL)) throw CodedTypeError(`"${urlName}" must be an instance of URL`, ERR_INVALID_ARG_TYPE);
	checkProtocol(input, options?.[allowInsecureRequests] !== true);
	const url = transform(new URL(input.href));
	const headers = prepareHeaders(options?.headers);
	headers.set("accept", "application/json");
	return (options?.[customFetch] || fetch)(url.href, {
		body: void 0,
		headers: Object.fromEntries(headers.entries()),
		method: "GET",
		redirect: "manual",
		signal: signal(url, options?.signal)
	});
}
async function discoveryRequest(issuerIdentifier, options) {
	return performDiscovery(issuerIdentifier, "issuerIdentifier", (url) => {
		switch (options?.algorithm) {
			case void 0:
			case "oidc":
				appendWellKnown(url, ".well-known/openid-configuration");
				break;
			case "oauth2":
				prependWellKnown(url, ".well-known/oauth-authorization-server");
				break;
			default: throw CodedTypeError("\"options.algorithm\" must be \"oidc\" (default), or \"oauth2\"", ERR_INVALID_ARG_VALUE);
		}
		return url;
	}, options);
}
function assertNumber(input, allow0, it, code, cause) {
	try {
		if (typeof input !== "number" || !Number.isFinite(input)) throw CodedTypeError(`${it} must be a number`, ERR_INVALID_ARG_TYPE, cause);
		if (input > 0) return;
		if (allow0) {
			if (input !== 0) throw CodedTypeError(`${it} must be a non-negative number`, ERR_INVALID_ARG_VALUE, cause);
			return;
		}
		throw CodedTypeError(`${it} must be a positive number`, ERR_INVALID_ARG_VALUE, cause);
	} catch (err) {
		if (code) throw OPE(err.message, code, cause);
		throw err;
	}
}
function assertString(input, it, code, cause) {
	try {
		if (typeof input !== "string") throw CodedTypeError(`${it} must be a string`, ERR_INVALID_ARG_TYPE, cause);
		if (input.length === 0) throw CodedTypeError(`${it} must not be empty`, ERR_INVALID_ARG_VALUE, cause);
	} catch (err) {
		if (code) throw OPE(err.message, code, cause);
		throw err;
	}
}
async function processDiscoveryResponse(expectedIssuerIdentifier, response) {
	const expected = expectedIssuerIdentifier;
	if (!(expected instanceof URL) && expected !== _nodiscoverycheck) throw CodedTypeError("\"expectedIssuerIdentifier\" must be an instance of URL", ERR_INVALID_ARG_TYPE);
	if (!looseInstanceOf(response, Response)) throw CodedTypeError("\"response\" must be an instance of Response", ERR_INVALID_ARG_TYPE);
	if (response.status !== 200) throw OPE("\"response\" is not a conform Authorization Server Metadata response (unexpected HTTP status code)", "OAUTH_RESPONSE_IS_NOT_CONFORM", response);
	assertReadableResponse(response);
	const json = await getResponseJsonBody(response);
	assertString(json.issuer, "\"response\" body \"issuer\" property", "OAUTH_INVALID_RESPONSE", { body: json });
	if (expected !== _nodiscoverycheck && new URL(json.issuer).href !== expected.href) throw OPE("\"response\" body \"issuer\" property does not match the expected value", "OAUTH_JSON_ATTRIBUTE_COMPARISON_FAILED", {
		expected: expected.href,
		body: json,
		attribute: "issuer"
	});
	return json;
}
function assertApplicationJson(response) {
	assertContentType(response, "application/json");
}
function notJson(response, ...types) {
	let msg = "\"response\" content-type must be ";
	if (types.length > 2) {
		const last = types.pop();
		msg += `${types.join(", ")}, or ${last}`;
	} else if (types.length === 2) msg += `${types[0]} or ${types[1]}`;
	else msg += types[0];
	return OPE(msg, "OAUTH_RESPONSE_IS_NOT_JSON", response);
}
function assertContentTypes(response, ...types) {
	if (!types.includes(getContentType(response))) throw notJson(response, ...types);
}
function assertContentType(response, contentType) {
	if (getContentType(response) !== contentType) throw notJson(response, contentType);
}
function randomBytes() {
	return b64u(crypto.getRandomValues(/* @__PURE__ */ new Uint8Array(32)));
}
function generateRandomCodeVerifier() {
	return randomBytes();
}
function generateRandomState() {
	return randomBytes();
}
function generateRandomNonce() {
	return randomBytes();
}
async function calculatePKCECodeChallenge(codeVerifier) {
	assertString(codeVerifier, "codeVerifier");
	return b64u(await crypto.subtle.digest("SHA-256", buf(codeVerifier)));
}
function getClockSkew(client) {
	const skew = client?.[clockSkew];
	return typeof skew === "number" && Number.isFinite(skew) ? skew : 0;
}
function getClockTolerance(client) {
	const tolerance = client?.[clockTolerance];
	return typeof tolerance === "number" && Number.isFinite(tolerance) && Math.sign(tolerance) !== -1 ? tolerance : 30;
}
function epochTime() {
	return Math.floor(Date.now() / 1e3);
}
function assertAs(as) {
	if (typeof as !== "object" || as === null) throw CodedTypeError("\"as\" must be an object", ERR_INVALID_ARG_TYPE);
	assertString(as.issuer, "\"as.issuer\"");
}
function assertClient(client) {
	if (typeof client !== "object" || client === null) throw CodedTypeError("\"client\" must be an object", ERR_INVALID_ARG_TYPE);
	assertString(client.client_id, "\"client.client_id\"");
}
function ClientSecretPost(clientSecret) {
	assertString(clientSecret, "\"clientSecret\"");
	return (_as, client, body, _headers) => {
		body.set("client_id", client.client_id);
		body.set("client_secret", clientSecret);
	};
}
function None() {
	return (_as, client, body, _headers) => {
		body.set("client_id", client.client_id);
	};
}
const URLParse = URL.parse ? (url, base) => URL.parse(url, base) : (url, base) => {
	try {
		return new URL(url, base);
	} catch {
		return null;
	}
};
function checkProtocol(url, enforceHttps) {
	if (enforceHttps && url.protocol !== "https:") throw OPE("only requests to HTTPS are allowed", "OAUTH_HTTP_REQUEST_FORBIDDEN", url);
	if (url.protocol !== "https:" && url.protocol !== "http:") throw OPE("only HTTP and HTTPS requests are allowed", "OAUTH_REQUEST_PROTOCOL_FORBIDDEN", url);
}
function validateEndpoint(value, endpoint, useMtlsAlias, enforceHttps) {
	let url;
	if (typeof value !== "string" || !(url = URLParse(value))) throw OPE(`authorization server metadata does not contain a valid ${useMtlsAlias ? `"as.mtls_endpoint_aliases.${endpoint}"` : `"as.${endpoint}"`}`, value === void 0 ? "OAUTH_MISSING_SERVER_METADATA" : "OAUTH_INVALID_SERVER_METADATA", { attribute: useMtlsAlias ? `mtls_endpoint_aliases.${endpoint}` : endpoint });
	checkProtocol(url, enforceHttps);
	return url;
}
function resolveEndpoint(as, endpoint, useMtlsAlias, enforceHttps) {
	if (useMtlsAlias && as.mtls_endpoint_aliases && endpoint in as.mtls_endpoint_aliases) return validateEndpoint(as.mtls_endpoint_aliases[endpoint], endpoint, useMtlsAlias, enforceHttps);
	return validateEndpoint(as[endpoint], endpoint, useMtlsAlias, enforceHttps);
}
var ResponseBodyError = class extends Error {
	cause;
	code;
	error;
	status;
	error_description;
	response;
	constructor(message, options) {
		super(message, options);
		this.name = this.constructor.name;
		this.code = "OAUTH_RESPONSE_BODY_ERROR";
		this.cause = options.cause;
		this.error = options.cause.error;
		this.status = options.response.status;
		this.error_description = options.cause.error_description;
		Object.defineProperty(this, "response", {
			enumerable: false,
			value: options.response
		});
		Error.captureStackTrace?.(this, this.constructor);
	}
};
var AuthorizationResponseError = class extends Error {
	cause;
	code;
	error;
	error_description;
	constructor(message, options) {
		super(message, options);
		this.name = this.constructor.name;
		this.code = "OAUTH_AUTHORIZATION_RESPONSE_ERROR";
		this.cause = options.cause;
		this.error = options.cause.get("error");
		this.error_description = options.cause.get("error_description") ?? void 0;
		Error.captureStackTrace?.(this, this.constructor);
	}
};
var WWWAuthenticateChallengeError = class extends Error {
	cause;
	code;
	response;
	status;
	constructor(message, options) {
		super(message, options);
		this.name = this.constructor.name;
		this.code = "OAUTH_WWW_AUTHENTICATE_CHALLENGE";
		this.cause = options.cause;
		this.status = options.response.status;
		this.response = options.response;
		Object.defineProperty(this, "response", { enumerable: false });
		Error.captureStackTrace?.(this, this.constructor);
	}
};
const schemeRE = /* @__PURE__ */ new RegExp("^[,\\s]*([a-zA-Z0-9!#$%&\\'\\*\\+\\-\\.\\^_`\\|~]+)");
const quotedParamRE = /* @__PURE__ */ new RegExp("^[,\\s]*([a-zA-Z0-9!#$%&\\'\\*\\+\\-\\.\\^_`\\|~]+)\\s*=\\s*\"((?:[^\"\\\\]|\\\\[\\s\\S])*)\"[,\\s]*(.*)");
const unquotedParamRE = /* @__PURE__ */ new RegExp("^[,\\s]*([a-zA-Z0-9!#$%&\\'\\*\\+\\-\\.\\^_`\\|~]+)\\s*=\\s*([a-zA-Z0-9!#$%&\\'\\*\\+\\-\\.\\^_`\\|~]+)[,\\s]*(.*)");
const token68ParamRE = /* @__PURE__ */ new RegExp("^([a-zA-Z0-9\\-\\._\\~\\+\\/]+={0,2})(?:$|[,\\s])(.*)");
function parseWwwAuthenticateChallenges(response) {
	if (!looseInstanceOf(response, Response)) throw CodedTypeError("\"response\" must be an instance of Response", ERR_INVALID_ARG_TYPE);
	const header = response.headers.get("www-authenticate");
	if (header === null) return;
	const challenges = [];
	let rest = header;
	while (rest) {
		let match = rest.match(schemeRE);
		const scheme = match?.["1"].toLowerCase();
		if (!scheme) return;
		const afterScheme = rest.substring(match[0].length);
		if (afterScheme && !afterScheme.match(/^[\s,]/)) return;
		const spaceMatch = afterScheme.match(/^\s+(.*)$/);
		const hasParameters = !!spaceMatch;
		rest = spaceMatch ? spaceMatch[1] : void 0;
		const parameters = {};
		let token68;
		if (hasParameters) while (rest) {
			let key;
			let value;
			if (match = rest.match(quotedParamRE)) {
				[, key, value, rest] = match;
				if (value.includes("\\")) value = value.replace(/\\([\s\S])/g, "$1");
				parameters[key.toLowerCase()] = value;
				continue;
			}
			if (match = rest.match(unquotedParamRE)) {
				[, key, value, rest] = match;
				parameters[key.toLowerCase()] = value;
				continue;
			}
			if (match = rest.match(token68ParamRE)) {
				if (Object.keys(parameters).length) break;
				[, token68, rest] = match;
				break;
			}
			return;
		}
		else rest = afterScheme || void 0;
		const challenge = {
			scheme,
			parameters
		};
		if (token68) challenge.token68 = token68;
		challenges.push(challenge);
	}
	if (!challenges.length) return;
	return challenges;
}
async function parseOAuthResponseErrorBody(response) {
	if (response.status > 399 && response.status < 500) {
		assertReadableResponse(response);
		assertApplicationJson(response);
		try {
			const json = await response.clone().json();
			if (isJsonObject(json) && typeof json.error === "string" && json.error.length) return json;
		} catch {}
	}
}
async function checkOAuthBodyError(response, expected, label) {
	if (response.status !== expected) {
		checkAuthenticationChallenges(response);
		let err;
		if (err = await parseOAuthResponseErrorBody(response)) {
			await response.body?.cancel();
			throw new ResponseBodyError("server responded with an error in the response body", {
				cause: err,
				response
			});
		}
		throw OPE(`"response" is not a conform ${label} response (unexpected HTTP status code)`, "OAUTH_RESPONSE_IS_NOT_CONFORM", response);
	}
}
function assertDPoP(option) {
	if (!branded.has(option)) throw CodedTypeError("\"options.DPoP\" is not a valid DPoPHandle", ERR_INVALID_ARG_VALUE);
}
let jwksMap;
let jwksRequests;
let jwksKeys;
function setJwksCache(as, jwks, uat, cache) {
	jwksMap ||= /* @__PURE__ */ new WeakMap();
	jwksMap.set(as, {
		jwks,
		uat,
		get age() {
			return epochTime() - this.uat;
		}
	});
	if (cache) Object.assign(cache, {
		jwks: structuredClone(jwks),
		uat
	});
}
function isFreshJwksCache(input) {
	if (typeof input !== "object" || input === null) return false;
	if (!("uat" in input) || typeof input.uat !== "number" || epochTime() - input.uat >= 300) return false;
	if (!("jwks" in input) || !isJsonObject(input.jwks) || !Array.isArray(input.jwks.keys) || !Array.prototype.every.call(input.jwks.keys, isJsonObject)) return false;
	return true;
}
function clearJwksCache(as, cache) {
	jwksMap?.delete(as);
	delete cache?.jwks;
	delete cache?.uat;
}
async function getPublicSigKeyFromIssuerJwksUri(as, options, header) {
	const { alg, kid } = header;
	checkSupportedJwsAlg(header);
	if (!jwksMap?.has(as) && isFreshJwksCache(options?.[jwksCache])) setJwksCache(as, options?.[jwksCache].jwks, options?.[jwksCache].uat);
	let jwks;
	let age;
	if (jwksMap?.has(as)) {
		({jwks, age} = jwksMap.get(as));
		if (age >= 300) {
			clearJwksCache(as, options?.[jwksCache]);
			return getPublicSigKeyFromIssuerJwksUri(as, options, header);
		}
	} else {
		const downloaded = await jwksRequest(as, options);
		jwks = downloaded.jwks;
		age = epochTime() - downloaded.uat;
		setJwksCache(as, jwks, downloaded.uat, options?.[jwksCache]);
	}
	let kty;
	switch (alg.slice(0, 2)) {
		case "RS":
		case "PS":
			kty = "RSA";
			break;
		case "ES":
			kty = "EC";
			break;
		case "Ed":
			kty = "OKP";
			break;
		case "ML":
			kty = "AKP";
			break;
		default: throw new UnsupportedOperationError("unsupported JWS algorithm", { cause: { alg } });
	}
	const candidates = jwks.keys.filter((jwk) => {
		if (jwk.kty !== kty) return false;
		if (kid !== void 0 && kid !== jwk.kid) return false;
		if (jwk.alg !== void 0 && alg !== jwk.alg) return false;
		if (jwk.use !== void 0 && jwk.use !== "sig") return false;
		if (jwk.key_ops?.includes("verify") === false) return false;
		switch (true) {
			case alg === "ES256" && jwk.crv !== "P-256":
			case alg === "ES384" && jwk.crv !== "P-384":
			case alg === "ES512" && jwk.crv !== "P-521":
			case alg === "Ed25519" && jwk.crv !== "Ed25519":
			case alg === "EdDSA" && jwk.crv !== "Ed25519": return false;
		}
		return true;
	});
	const { 0: jwk, length } = candidates;
	if (!length) {
		if (age >= 60) {
			clearJwksCache(as, options?.[jwksCache]);
			return getPublicSigKeyFromIssuerJwksUri(as, options, header);
		}
		throw OPE("error when selecting a JWT verification key, no applicable keys found", "OAUTH_KEY_SELECTION_FAILED", {
			header,
			candidates,
			jwks_uri: new URL(as.jwks_uri)
		});
	}
	if (length !== 1) throw OPE("error when selecting a JWT verification key, multiple applicable keys found, a \"kid\" JWT Header Parameter is required", "OAUTH_KEY_SELECTION_FAILED", {
		header,
		candidates,
		jwks_uri: new URL(as.jwks_uri)
	});
	jwksKeys ||= /* @__PURE__ */ new WeakMap();
	let keys = jwksKeys.get(jwk);
	if (!keys) {
		keys = /* @__PURE__ */ new Map();
		jwksKeys.set(jwk, keys);
	}
	let key = keys.get(alg);
	if (!key) {
		key = importJwk(alg, jwk).catch((cause) => {
			keys.delete(alg);
			throw cause;
		});
		keys.set(alg, key);
	}
	return key;
}
function getContentType(input) {
	return input.headers.get("content-type")?.split(";")[0];
}
async function authenticatedRequest(as, client, clientAuthentication, url, body, headers, options) {
	await clientAuthentication(as, client, body, headers);
	headers.set("content-type", "application/x-www-form-urlencoded;charset=UTF-8");
	return (options?.[customFetch] || fetch)(url.href, {
		body,
		headers: Object.fromEntries(headers.entries()),
		method: "POST",
		redirect: "manual",
		signal: signal(url, options?.signal)
	});
}
async function tokenEndpointRequest(as, client, clientAuthentication, grantType, parameters, options) {
	const url = resolveEndpoint(as, "token_endpoint", client.use_mtls_endpoint_aliases, options?.[allowInsecureRequests] !== true);
	parameters.set("grant_type", grantType);
	const headers = prepareHeaders(options?.headers);
	headers.set("accept", "application/json");
	if (options?.DPoP !== void 0) {
		assertDPoP(options.DPoP);
		await options.DPoP.addProof(url, headers, "POST");
	}
	const response = await authenticatedRequest(as, client, clientAuthentication, url, parameters, headers, options);
	options?.DPoP?.cacheNonce(response, url);
	return response;
}
const idTokenClaims = /* @__PURE__ */ new WeakMap();
const jwtRefs = /* @__PURE__ */ new WeakMap();
function getValidatedIdTokenClaims(ref) {
	if (!ref.id_token) return;
	const claims = idTokenClaims.get(ref);
	if (!claims) throw CodedTypeError("\"ref\" was already garbage collected or did not resolve from the proper sources", ERR_INVALID_ARG_VALUE);
	return claims;
}
async function validateApplicationLevelSignature(as, ref, options) {
	assertAs(as);
	if (!jwtRefs.has(ref)) throw CodedTypeError("\"ref\" does not contain a processed JWT Response to verify the signature of", ERR_INVALID_ARG_VALUE);
	const { 0: protectedHeader, 1: payload, 2: encodedSignature } = jwtRefs.get(ref).split(".");
	const header = JSON.parse(buf(b64u(protectedHeader)));
	if (header.alg.startsWith("HS")) throw new UnsupportedOperationError("unsupported JWS algorithm", { cause: { alg: header.alg } });
	let key;
	key = await getPublicSigKeyFromIssuerJwksUri(as, options, header);
	await validateJwsSignature(protectedHeader, payload, key, b64u(encodedSignature));
}
async function processGenericAccessTokenResponse(as, client, response, additionalRequiredIdTokenClaims, decryptFn, recognizedTokenTypes) {
	assertAs(as);
	assertClient(client);
	if (!looseInstanceOf(response, Response)) throw CodedTypeError("\"response\" must be an instance of Response", ERR_INVALID_ARG_TYPE);
	await checkOAuthBodyError(response, 200, "Token Endpoint");
	assertReadableResponse(response);
	const json = await getResponseJsonBody(response);
	assertString(json.access_token, "\"response\" body \"access_token\" property", "OAUTH_INVALID_RESPONSE", { body: json });
	assertString(json.token_type, "\"response\" body \"token_type\" property", "OAUTH_INVALID_RESPONSE", { body: json });
	json.token_type = json.token_type.toLowerCase();
	if (json.expires_in !== void 0) {
		let expiresIn = typeof json.expires_in !== "number" ? parseFloat(json.expires_in) : json.expires_in;
		assertNumber(expiresIn, true, "\"response\" body \"expires_in\" property", "OAUTH_INVALID_RESPONSE", { body: json });
		json.expires_in = expiresIn;
	}
	if (json.refresh_token !== void 0) assertString(json.refresh_token, "\"response\" body \"refresh_token\" property", "OAUTH_INVALID_RESPONSE", { body: json });
	if (json.scope !== void 0 && typeof json.scope !== "string") throw OPE("\"response\" body \"scope\" property must be a string", "OAUTH_INVALID_RESPONSE", { body: json });
	if (json.id_token !== void 0) {
		assertString(json.id_token, "\"response\" body \"id_token\" property", "OAUTH_INVALID_RESPONSE", { body: json });
		const requiredClaims = [];
		if (client.require_auth_time === true) requiredClaims.push("auth_time");
		if (client.default_max_age !== void 0) {
			assertNumber(client.default_max_age, true, "\"client.default_max_age\"");
			requiredClaims.push("auth_time");
		}
		if (additionalRequiredIdTokenClaims?.length) requiredClaims.push(...additionalRequiredIdTokenClaims);
		const { claims, jwt } = await validateIdTokenClaims(as, client, json.id_token, requiredClaims, decryptFn);
		validateIdTokenAuthorizedParty(client, claims);
		validateIdTokenAuthTimeClaim(claims);
		jwtRefs.set(response, jwt);
		idTokenClaims.set(json, claims);
	}
	if (recognizedTokenTypes?.[json.token_type] !== void 0) recognizedTokenTypes[json.token_type](response, json);
	else if (json.token_type !== "dpop" && json.token_type !== "bearer") throw new UnsupportedOperationError("unsupported `token_type` value", { cause: { body: json } });
	return json;
}
function checkAuthenticationChallenges(response) {
	let challenges;
	if (challenges = parseWwwAuthenticateChallenges(response)) throw new WWWAuthenticateChallengeError("server responded with a challenge in the WWW-Authenticate HTTP Header", {
		cause: challenges,
		response
	});
}
function validateAudience(expected, result) {
	if (Array.isArray(result.claims.aud)) {
		if (!result.claims.aud.includes(expected)) throw OPE("unexpected JWT \"aud\" (audience) claim value", "OAUTH_JWT_CLAIM_COMPARISON_FAILED", {
			expected,
			claims: result.claims,
			claim: "aud"
		});
	} else if (result.claims.aud !== expected) throw OPE("unexpected JWT \"aud\" (audience) claim value", "OAUTH_JWT_CLAIM_COMPARISON_FAILED", {
		expected,
		claims: result.claims,
		claim: "aud"
	});
	return result;
}
function validateIssuer(as, result) {
	const expected = as[_expectedIssuer]?.(result) ?? as.issuer;
	if (result.claims.iss !== expected) throw OPE("unexpected JWT \"iss\" (issuer) claim value", "OAUTH_JWT_CLAIM_COMPARISON_FAILED", {
		expected,
		claims: result.claims,
		claim: "iss"
	});
	return result;
}
const branded = /* @__PURE__ */ new WeakSet();
function brand(searchParams) {
	branded.add(searchParams);
	return searchParams;
}
const nopkce = Symbol();
async function authorizationCodeGrantRequest(as, client, clientAuthentication, callbackParameters, redirectUri, codeVerifier, options) {
	assertAs(as);
	assertClient(client);
	if (!branded.has(callbackParameters)) throw CodedTypeError("\"callbackParameters\" must be an instance of URLSearchParams obtained from \"validateAuthResponse()\", or \"validateJwtAuthResponse()", ERR_INVALID_ARG_VALUE);
	assertString(redirectUri, "\"redirectUri\"");
	const code = getURLSearchParameter(callbackParameters, "code");
	if (!code) throw OPE("no authorization code in \"callbackParameters\"", "OAUTH_INVALID_RESPONSE");
	const parameters = new URLSearchParams(options?.additionalParameters);
	parameters.set("redirect_uri", redirectUri);
	parameters.set("code", code);
	if (codeVerifier !== nopkce) {
		assertString(codeVerifier, "\"codeVerifier\"");
		parameters.set("code_verifier", codeVerifier);
	}
	return tokenEndpointRequest(as, client, clientAuthentication, "authorization_code", parameters, options);
}
const jwtClaimNames = {
	aud: "audience",
	c_hash: "code hash",
	client_id: "client id",
	exp: "expiration time",
	iat: "issued at",
	iss: "issuer",
	jti: "jwt id",
	nonce: "nonce",
	s_hash: "state hash",
	sub: "subject",
	ath: "access token hash",
	htm: "http method",
	htu: "http uri",
	cnf: "confirmation",
	auth_time: "authentication time"
};
function validatePresence(required, result) {
	for (const claim of required) if (result.claims[claim] === void 0) throw OPE(`JWT "${claim}" (${jwtClaimNames[claim]}) claim missing`, "OAUTH_INVALID_RESPONSE", { claims: result.claims });
	return result;
}
function validateStringClaim(claim, result) {
	if (typeof result.claims[claim] !== "string") throw OPE(`unexpected JWT "${claim}" (${jwtClaimNames[claim]}) claim type`, "OAUTH_INVALID_RESPONSE", { claims: result.claims });
	return result;
}
function validateIdTokenClaims(as, client, idToken, requiredClaims, decryptFn) {
	return validateJwt(idToken, checkSigningAlgorithm.bind(void 0, client.id_token_signed_response_alg, as.id_token_signing_alg_values_supported, "RS256"), getClockSkew(client), getClockTolerance(client), decryptFn).then(validatePresence.bind(void 0, [
		"aud",
		"exp",
		"iat",
		"iss",
		"sub",
		...requiredClaims
	])).then(validateIssuer.bind(void 0, as)).then(validateAudience.bind(void 0, client.client_id)).then(validateStringClaim.bind(void 0, "sub"));
}
function resolveIdTokenMaxAge(client, maxAge) {
	if (maxAge === skipAuthTimeCheck) return maxAge;
	const fromClient = maxAge === void 0;
	if (fromClient) maxAge = client.default_max_age;
	if (maxAge === void 0) return skipAuthTimeCheck;
	assertNumber(maxAge, true, fromClient ? "\"client.default_max_age\"" : "\"maxAge\" argument");
	return maxAge;
}
function validateIdTokenAuthTimeClaim(claims) {
	if (claims.auth_time !== void 0) assertNumber(claims.auth_time, true, "ID Token \"auth_time\" (authentication time)", "OAUTH_INVALID_RESPONSE", { claims });
}
function validateIdTokenAuthTime(client, claims, maxAge) {
	if (maxAge === skipAuthTimeCheck) return;
	const now = epochTime() + getClockSkew(client);
	const tolerance = getClockTolerance(client);
	if (claims.auth_time + maxAge < now - tolerance) throw OPE("too much time has elapsed since the last End-User authentication", "OAUTH_JWT_TIMESTAMP_CHECK_FAILED", {
		claims,
		now,
		tolerance,
		claim: "auth_time"
	});
}
function validateIdTokenNonce(claims, expectedNonce) {
	const expected = expectedNonce === expectNoNonce ? void 0 : expectedNonce;
	if (claims.nonce !== expected) throw OPE("unexpected ID Token \"nonce\" claim value", "OAUTH_JWT_CLAIM_COMPARISON_FAILED", {
		expected,
		claims,
		claim: "nonce"
	});
}
function validateIdTokenAuthorizedParty(client, claims) {
	if (Array.isArray(claims.aud) && claims.aud.length !== 1) {
		if (claims.azp === void 0) throw OPE("ID Token \"aud\" (audience) claim includes additional untrusted audiences", "OAUTH_JWT_CLAIM_COMPARISON_FAILED", {
			claims,
			claim: "aud"
		});
		if (claims.azp !== client.client_id) throw OPE("unexpected ID Token \"azp\" (authorized party) claim value", "OAUTH_JWT_CLAIM_COMPARISON_FAILED", {
			expected: client.client_id,
			claims,
			claim: "azp"
		});
	}
}
const expectNoNonce = Symbol();
const skipAuthTimeCheck = Symbol();
async function processAuthorizationCodeResponse(as, client, response, options) {
	if (typeof options?.expectedNonce === "string" || typeof options?.maxAge === "number" || options?.requireIdToken) return processAuthorizationCodeOpenIDResponse(as, client, response, options.expectedNonce, options.maxAge, options[jweDecrypt], options.recognizedTokenTypes);
	return processAuthorizationCodeOAuth2Response(as, client, response, options?.maxAge, options?.[jweDecrypt], options?.recognizedTokenTypes);
}
async function processAuthorizationCodeOpenIDResponse(as, client, response, expectedNonce, maxAge, decryptFn, recognizedTokenTypes) {
	const additionalRequiredClaims = [];
	switch (expectedNonce) {
		case void 0:
			expectedNonce = expectNoNonce;
			break;
		case expectNoNonce: break;
		default:
			assertString(expectedNonce, "\"expectedNonce\" argument");
			additionalRequiredClaims.push("nonce");
	}
	maxAge = resolveIdTokenMaxAge(client, maxAge);
	if (maxAge !== skipAuthTimeCheck) additionalRequiredClaims.push("auth_time");
	const result = await processGenericAccessTokenResponse(as, client, response, additionalRequiredClaims, decryptFn, recognizedTokenTypes);
	assertString(result.id_token, "\"response\" body \"id_token\" property", "OAUTH_INVALID_RESPONSE", { body: result });
	const claims = getValidatedIdTokenClaims(result);
	validateIdTokenAuthTime(client, claims, maxAge);
	validateIdTokenNonce(claims, expectedNonce);
	return result;
}
async function processAuthorizationCodeOAuth2Response(as, client, response, maxAge, decryptFn, recognizedTokenTypes) {
	const result = await processGenericAccessTokenResponse(as, client, response, void 0, decryptFn, recognizedTokenTypes);
	const claims = getValidatedIdTokenClaims(result);
	if (claims) {
		validateIdTokenAuthTime(client, claims, resolveIdTokenMaxAge(client, maxAge));
		validateIdTokenNonce(claims, expectNoNonce);
	}
	return result;
}
function checkJwtType(expected, result) {
	if (typeof result.header.typ !== "string" || normalizeTyp(result.header.typ) !== expected) throw OPE("unexpected JWT \"typ\" header parameter value", "OAUTH_INVALID_RESPONSE", { header: result.header });
	return result;
}
function assertReadableResponse(response) {
	if (response.bodyUsed) throw CodedTypeError("\"response\" body has been used already", ERR_INVALID_ARG_VALUE);
}
async function jwksRequest(as, options) {
	assertAs(as);
	const url = resolveEndpoint(as, "jwks_uri", false, options?.[allowInsecureRequests] !== true);
	const headers = prepareHeaders(options?.headers);
	headers.set("accept", "application/json");
	headers.append("accept", "application/jwk-set+json");
	const requestHeaders = Object.fromEntries(headers.entries());
	const headersKey = JSON.stringify(requestHeaders);
	const fetcher = options?.[customFetch] || fetch;
	const requestSignal = signal(url, options?.signal);
	jwksRequests ||= /* @__PURE__ */ new WeakMap();
	const requests = jwksRequests.get(as) ?? /* @__PURE__ */ new Set();
	for (const pending of requests) if (pending.url === url.href && pending.headers === headersKey && pending.fetch === fetcher && pending.signal === requestSignal) return pending.promise;
	const pending = {
		url: url.href,
		headers: headersKey,
		fetch: fetcher,
		signal: requestSignal,
		promise: Promise.resolve().then(() => fetcher(url.href, {
			body: void 0,
			headers: requestHeaders,
			method: "GET",
			redirect: "manual",
			signal: requestSignal
		})).then(processJwksResponse).then((jwks) => {
			const uat = epochTime();
			setJwksCache(as, jwks, uat);
			return {
				jwks,
				uat
			};
		}).finally(() => {
			requests.delete(pending);
			if (!requests.size) jwksRequests.delete(as);
		})
	};
	requests.add(pending);
	jwksRequests.set(as, requests);
	return pending.promise;
}
async function processJwksResponse(response) {
	if (!looseInstanceOf(response, Response)) throw CodedTypeError("\"response\" must be an instance of Response", ERR_INVALID_ARG_TYPE);
	if (response.status !== 200) throw OPE("\"response\" is not a conform JSON Web Key Set response (unexpected HTTP status code)", "OAUTH_RESPONSE_IS_NOT_CONFORM", response);
	assertReadableResponse(response);
	const json = await getResponseJsonBody(response, (response) => assertContentTypes(response, "application/json", "application/jwk-set+json"));
	if (!Array.isArray(json.keys)) throw OPE("\"response\" body \"keys\" property must be an array", "OAUTH_INVALID_RESPONSE", { body: json });
	if (!Array.prototype.every.call(json.keys, isJsonObject)) throw OPE("\"response\" body \"keys\" property members must be JWK formatted objects", "OAUTH_INVALID_RESPONSE", { body: json });
	return json;
}
function supported(alg) {
	switch (alg) {
		case "PS256":
		case "ES256":
		case "RS256":
		case "PS384":
		case "ES384":
		case "RS384":
		case "PS512":
		case "ES512":
		case "RS512":
		case "Ed25519":
		case "EdDSA":
		case "ML-DSA-44":
		case "ML-DSA-65":
		case "ML-DSA-87": return true;
		default: return false;
	}
}
function checkSupportedJwsAlg(header) {
	if (!supported(header.alg)) throw new UnsupportedOperationError("unsupported JWS \"alg\" identifier", { cause: { alg: header.alg } });
}
function checkRsaKeyAlgorithm(key) {
	const { algorithm } = key;
	if (typeof algorithm.modulusLength !== "number" || algorithm.modulusLength < 2048) throw new UnsupportedOperationError(`unsupported ${algorithm.name} modulusLength`, { cause: key });
}
function ecdsaHashName(key) {
	const { algorithm } = key;
	switch (algorithm.namedCurve) {
		case "P-256": return "SHA-256";
		case "P-384": return "SHA-384";
		case "P-521": return "SHA-512";
		default: throw new UnsupportedOperationError("unsupported ECDSA namedCurve", { cause: key });
	}
}
function keyToSubtle(key) {
	switch (key.algorithm.name) {
		case "ECDSA": return {
			name: key.algorithm.name,
			hash: ecdsaHashName(key)
		};
		case "RSA-PSS":
			checkRsaKeyAlgorithm(key);
			switch (key.algorithm.hash.name) {
				case "SHA-256":
				case "SHA-384":
				case "SHA-512": return {
					name: key.algorithm.name,
					saltLength: parseInt(key.algorithm.hash.name.slice(-3), 10) >> 3
				};
				default: throw new UnsupportedOperationError("unsupported RSA-PSS hash name", { cause: key });
			}
		case "RSASSA-PKCS1-v1_5":
			checkRsaKeyAlgorithm(key);
			return key.algorithm.name;
		case "ML-DSA-44":
		case "ML-DSA-65":
		case "ML-DSA-87":
		case "Ed25519": return key.algorithm.name;
	}
	throw new UnsupportedOperationError("unsupported CryptoKey algorithm name", { cause: key });
}
async function validateJwsSignature(protectedHeader, payload, key, signature) {
	const data = buf(`${protectedHeader}.${payload}`);
	const algorithm = keyToSubtle(key);
	if (!await crypto.subtle.verify(algorithm, key, signature, data)) throw OPE("JWT signature verification failed", "OAUTH_INVALID_RESPONSE", {
		key,
		data,
		signature,
		algorithm
	});
}
async function validateJwt(jws, checkAlg, clockSkew, clockTolerance, decryptJwt) {
	let { 0: protectedHeader, 1: payload, length } = jws.split(".");
	if (length === 5) {
		if (decryptJwt !== void 0) {
			jws = await decryptJwt(jws);
			({0: protectedHeader, 1: payload, length} = jws.split("."));
		} else throw new UnsupportedOperationError("JWE decryption is not configured", { cause: jws });
	}
	if (length !== 3) throw OPE("Invalid JWT", "OAUTH_INVALID_RESPONSE", jws);
	let header;
	try {
		header = JSON.parse(buf(b64u(protectedHeader)));
	} catch (cause) {
		throw OPE("failed to parse JWT Header body as base64url encoded JSON", "OAUTH_PARSE_ERROR", cause);
	}
	if (!isJsonObject(header)) throw OPE("JWT Header must be a top level object", "OAUTH_INVALID_RESPONSE", jws);
	checkAlg(header);
	if (header.crit !== void 0) throw new UnsupportedOperationError("no JWT \"crit\" header parameter extensions are supported", { cause: { header } });
	let claims;
	try {
		claims = JSON.parse(buf(b64u(payload)));
	} catch (cause) {
		throw OPE("failed to parse JWT Payload body as base64url encoded JSON", "OAUTH_PARSE_ERROR", cause);
	}
	if (!isJsonObject(claims)) throw OPE("JWT Payload must be a top level object", "OAUTH_INVALID_RESPONSE", jws);
	const now = epochTime() + clockSkew;
	if (claims.exp !== void 0) {
		if (typeof claims.exp !== "number") throw OPE("unexpected JWT \"exp\" (expiration time) claim type", "OAUTH_INVALID_RESPONSE", { claims });
		if (claims.exp <= now - clockTolerance) throw OPE("unexpected JWT \"exp\" (expiration time) claim value, expiration is past current timestamp", "OAUTH_JWT_TIMESTAMP_CHECK_FAILED", {
			claims,
			now,
			tolerance: clockTolerance,
			claim: "exp"
		});
	}
	if (claims.iat !== void 0) {
		if (typeof claims.iat !== "number") throw OPE("unexpected JWT \"iat\" (issued at) claim type", "OAUTH_INVALID_RESPONSE", { claims });
	}
	if (claims.iss !== void 0) {
		if (typeof claims.iss !== "string") throw OPE("unexpected JWT \"iss\" (issuer) claim type", "OAUTH_INVALID_RESPONSE", { claims });
	}
	if (claims.nbf !== void 0) {
		if (typeof claims.nbf !== "number") throw OPE("unexpected JWT \"nbf\" (not before) claim type", "OAUTH_INVALID_RESPONSE", { claims });
		if (claims.nbf > now + clockTolerance) throw OPE("unexpected JWT \"nbf\" (not before) claim value", "OAUTH_JWT_TIMESTAMP_CHECK_FAILED", {
			claims,
			now,
			tolerance: clockTolerance,
			claim: "nbf"
		});
	}
	if (claims.aud !== void 0) {
		if (typeof claims.aud !== "string" && !Array.isArray(claims.aud)) throw OPE("unexpected JWT \"aud\" (audience) claim type", "OAUTH_INVALID_RESPONSE", { claims });
	}
	return {
		header,
		claims,
		jwt: jws
	};
}
function checkSigningAlgorithm(client, issuer, fallback, header) {
	if (client !== void 0) {
		if (typeof client === "string" ? header.alg !== client : !client.includes(header.alg)) throw OPE("unexpected JWT \"alg\" header parameter", "OAUTH_INVALID_RESPONSE", {
			header,
			expected: client,
			reason: "client configuration"
		});
		return;
	}
	if (Array.isArray(issuer)) {
		if (!issuer.includes(header.alg)) throw OPE("unexpected JWT \"alg\" header parameter", "OAUTH_INVALID_RESPONSE", {
			header,
			expected: issuer,
			reason: "authorization server metadata"
		});
		return;
	}
	if (fallback !== void 0) {
		if (typeof fallback === "string" ? header.alg !== fallback : typeof fallback === "function" ? !fallback(header.alg) : !fallback.includes(header.alg)) throw OPE("unexpected JWT \"alg\" header parameter", "OAUTH_INVALID_RESPONSE", {
			header,
			expected: fallback,
			reason: "default value"
		});
		return;
	}
	throw OPE("missing client or server configuration to verify used JWT \"alg\" header parameter", void 0, {
		client,
		issuer,
		fallback
	});
}
function getURLSearchParameter(parameters, name) {
	const { 0: value, length } = parameters.getAll(name);
	if (length > 1) throw OPE(`"${name}" parameter must be provided only once`, "OAUTH_INVALID_RESPONSE");
	return value;
}
const skipStateCheck = Symbol();
const expectNoState = Symbol();
function validateAuthResponse(as, client, parameters, expectedState) {
	assertAs(as);
	assertClient(client);
	if (parameters instanceof URL) parameters = parameters.searchParams;
	if (!(parameters instanceof URLSearchParams)) throw CodedTypeError("\"parameters\" must be an instance of URLSearchParams, or URL", ERR_INVALID_ARG_TYPE);
	if (getURLSearchParameter(parameters, "response")) throw OPE("\"parameters\" contains a JARM response, use validateJwtAuthResponse() instead of validateAuthResponse()", "OAUTH_INVALID_RESPONSE", { parameters });
	const iss = getURLSearchParameter(parameters, "iss");
	const state = getURLSearchParameter(parameters, "state");
	if (!iss && as.authorization_response_iss_parameter_supported) throw OPE("response parameter \"iss\" (issuer) missing", "OAUTH_INVALID_RESPONSE", { parameters });
	if (iss && iss !== as.issuer) throw OPE("unexpected \"iss\" (issuer) response parameter value", "OAUTH_INVALID_RESPONSE", {
		expected: as.issuer,
		parameters
	});
	switch (expectedState) {
		case void 0:
		case expectNoState:
			if (state !== void 0) throw OPE("unexpected \"state\" response parameter encountered", "OAUTH_INVALID_RESPONSE", {
				expected: void 0,
				parameters
			});
			break;
		case skipStateCheck: break;
		default:
			assertString(expectedState, "\"expectedState\" argument");
			if (state !== expectedState) throw OPE(state === void 0 ? "response parameter \"state\" missing" : "unexpected \"state\" response parameter value", "OAUTH_INVALID_RESPONSE", {
				expected: expectedState,
				parameters
			});
	}
	if (getURLSearchParameter(parameters, "error")) throw new AuthorizationResponseError("authorization response from the server is an error", { cause: parameters });
	const id_token = getURLSearchParameter(parameters, "id_token");
	const token = getURLSearchParameter(parameters, "token");
	if (id_token !== void 0 || token !== void 0) throw new UnsupportedOperationError("implicit and hybrid flows are not supported");
	return brand(new URLSearchParams(parameters));
}
function algToSubtle(alg) {
	switch (alg) {
		case "PS256":
		case "PS384":
		case "PS512": return {
			name: "RSA-PSS",
			hash: `SHA-${alg.slice(-3)}`
		};
		case "RS256":
		case "RS384":
		case "RS512": return {
			name: "RSASSA-PKCS1-v1_5",
			hash: `SHA-${alg.slice(-3)}`
		};
		case "ES256":
		case "ES384": return {
			name: "ECDSA",
			namedCurve: `P-${alg.slice(-3)}`
		};
		case "ES512": return {
			name: "ECDSA",
			namedCurve: "P-521"
		};
		case "EdDSA": return "Ed25519";
		case "Ed25519":
		case "ML-DSA-44":
		case "ML-DSA-65":
		case "ML-DSA-87": return alg;
		default: throw new UnsupportedOperationError("unsupported JWS algorithm", { cause: { alg } });
	}
}
async function importJwk(alg, jwk) {
	const { ext, key_ops, use, ...key } = jwk;
	return crypto.subtle.importKey("jwk", key, algToSubtle(alg), true, ["verify"]);
}
function normalizeHtu(htu) {
	const url = new URL(htu);
	url.search = "";
	url.hash = "";
	return url.href;
}
async function validateDPoP(request, accessToken, accessTokenClaims, options) {
	const headerValue = request.headers.get("dpop");
	if (headerValue === null) throw OPE("operation indicated DPoP use but the request has no DPoP HTTP Header", "OAUTH_INVALID_REQUEST", { headers: request.headers });
	if (request.headers.get("authorization")?.toLowerCase().startsWith("dpop ") === false) throw OPE(`operation indicated DPoP use but the request's Authorization HTTP Header scheme is not DPoP`, "OAUTH_INVALID_REQUEST", { headers: request.headers });
	if (typeof accessTokenClaims.cnf?.jkt !== "string") throw OPE("operation indicated DPoP use but the JWT Access Token has no jkt confirmation claim", "OAUTH_INVALID_REQUEST", { claims: accessTokenClaims });
	const clockSkew = getClockSkew(options);
	const proof = await validateJwt(headerValue, checkSigningAlgorithm.bind(void 0, options?.signingAlgorithms, void 0, supported), clockSkew, getClockTolerance(options), void 0).then(checkJwtType.bind(void 0, "dpop+jwt")).then(validatePresence.bind(void 0, [
		"iat",
		"jti",
		"ath",
		"htm",
		"htu"
	])).then(validateStringClaim.bind(void 0, "jti"));
	const now = epochTime() + clockSkew;
	if (Math.abs(now - proof.claims.iat) > 300) throw OPE("DPoP Proof iat is not recent enough", "OAUTH_JWT_TIMESTAMP_CHECK_FAILED", {
		now,
		claims: proof.claims,
		claim: "iat"
	});
	if (proof.claims.htm !== request.method) throw OPE("DPoP Proof htm mismatch", "OAUTH_JWT_CLAIM_COMPARISON_FAILED", {
		expected: request.method,
		claims: proof.claims,
		claim: "htm"
	});
	if (typeof proof.claims.htu !== "string" || normalizeHtu(proof.claims.htu) !== normalizeHtu(request.url)) throw OPE("DPoP Proof htu mismatch", "OAUTH_JWT_CLAIM_COMPARISON_FAILED", {
		expected: normalizeHtu(request.url),
		claims: proof.claims,
		claim: "htu"
	});
	{
		const expected = b64u(await crypto.subtle.digest("SHA-256", buf(accessToken)));
		if (proof.claims.ath !== expected) throw OPE("DPoP Proof ath mismatch", "OAUTH_JWT_CLAIM_COMPARISON_FAILED", {
			expected,
			claims: proof.claims,
			claim: "ath"
		});
	}
	const { jwk, alg } = proof.header;
	if (!isJsonObject(jwk)) throw OPE("DPoP Proof jwk header parameter must be a JSON object", "OAUTH_INVALID_REQUEST", { header: proof.header });
	{
		const expected = await calculateJwkThumbprint(jwk);
		if (accessTokenClaims.cnf.jkt !== expected) throw OPE("JWT Access Token confirmation mismatch", "OAUTH_JWT_CLAIM_COMPARISON_FAILED", {
			expected,
			claims: accessTokenClaims,
			claim: "cnf.jkt"
		});
	}
	const { 0: protectedHeader, 1: payload, 2: encodedSignature } = headerValue.split(".");
	const signature = b64u(encodedSignature);
	const key = await importJwk(alg, jwk);
	if (key.type !== "public") throw OPE("DPoP Proof jwk header parameter must contain a public key", "OAUTH_INVALID_REQUEST", { header: proof.header });
	await validateJwsSignature(protectedHeader, payload, key, signature);
}
async function validateJwtAccessToken(as, request, expectedAudience, options) {
	assertAs(as);
	if (!looseInstanceOf(request, Request)) throw CodedTypeError("\"request\" must be an instance of Request", ERR_INVALID_ARG_TYPE);
	assertString(expectedAudience, "\"expectedAudience\"");
	const authorization = request.headers.get("authorization");
	if (authorization === null) throw OPE("\"request\" is missing an Authorization HTTP Header", "OAUTH_INVALID_REQUEST", { headers: request.headers });
	let { 0: scheme, 1: accessToken, length } = authorization.split(/ +/);
	scheme = scheme.toLowerCase();
	switch (scheme) {
		case "dpop":
		case "bearer": break;
		default: throw new UnsupportedOperationError("unsupported Authorization HTTP Header scheme", { cause: { headers: request.headers } });
	}
	if (length !== 2) throw OPE("invalid Authorization HTTP Header format", "OAUTH_INVALID_REQUEST", { headers: request.headers });
	const requiredClaims = [
		"iss",
		"exp",
		"aud",
		"sub",
		"iat",
		"jti",
		"client_id"
	];
	if (options?.requireDPoP || scheme === "dpop" || request.headers.has("dpop")) requiredClaims.push("cnf");
	const { claims, header } = await validateJwt(accessToken, checkSigningAlgorithm.bind(void 0, options?.signingAlgorithms, void 0, supported), getClockSkew(options), getClockTolerance(options), void 0).then(checkJwtType.bind(void 0, "at+jwt")).then(validatePresence.bind(void 0, requiredClaims)).then(validateIssuer.bind(void 0, as)).then(validateAudience.bind(void 0, expectedAudience)).catch(reassignRSCode);
	for (const claim of [
		"client_id",
		"jti",
		"sub"
	]) if (typeof claims[claim] !== "string") throw OPE(`unexpected JWT "${claim}" claim type`, "OAUTH_INVALID_REQUEST", { claims });
	if ("cnf" in claims) {
		if (!isJsonObject(claims.cnf)) throw OPE("unexpected JWT \"cnf\" (confirmation) claim value", "OAUTH_INVALID_REQUEST", { claims });
		const { 0: cnf, length } = Object.keys(claims.cnf);
		if (length) {
			if (length !== 1) throw new UnsupportedOperationError("multiple confirmation claims are not supported", { cause: { claims } });
			if (cnf !== "jkt") throw new UnsupportedOperationError("unsupported JWT Confirmation method", { cause: { claims } });
		}
	}
	const { 0: protectedHeader, 1: payload, 2: encodedSignature } = accessToken.split(".");
	const signature = b64u(encodedSignature);
	await validateJwsSignature(protectedHeader, payload, await getPublicSigKeyFromIssuerJwksUri(as, options, header), signature);
	if (options?.requireDPoP || scheme === "dpop" || claims.cnf?.jkt !== void 0 || request.headers.has("dpop")) await validateDPoP(request, accessToken, claims, options).catch(reassignRSCode);
	return claims;
}
function reassignRSCode(err) {
	if (err instanceof OperationProcessingError && err?.code === "OAUTH_INVALID_REQUEST") err.code = "OAUTH_INVALID_RESPONSE";
	throw err;
}
async function dynamicClientRegistrationRequest(as, metadata, options) {
	assertAs(as);
	const url = resolveEndpoint(as, "registration_endpoint", metadata.use_mtls_endpoint_aliases, options?.[allowInsecureRequests] !== true);
	const headers = prepareHeaders(options?.headers);
	headers.set("accept", "application/json");
	headers.set("content-type", "application/json");
	const method = "POST";
	if (options?.DPoP) {
		assertDPoP(options.DPoP);
		await options.DPoP.addProof(url, headers, method, options.initialAccessToken);
	}
	if (options?.initialAccessToken) headers.set("authorization", `${headers.has("dpop") ? "DPoP" : "Bearer"} ${options.initialAccessToken}`);
	const response = await (options?.[customFetch] || fetch)(url.href, {
		body: JSON.stringify(metadata),
		headers: Object.fromEntries(headers.entries()),
		method,
		redirect: "manual",
		signal: signal(url, options?.signal)
	});
	options?.DPoP?.cacheNonce(response, url);
	return response;
}
async function processDynamicClientRegistrationResponse(response) {
	if (!looseInstanceOf(response, Response)) throw CodedTypeError("\"response\" must be an instance of Response", ERR_INVALID_ARG_TYPE);
	await checkOAuthBodyError(response, 201, "Dynamic Client Registration Endpoint");
	assertReadableResponse(response);
	const json = await getResponseJsonBody(response);
	assertString(json.client_id, "\"response\" body \"client_id\" property", "OAUTH_INVALID_RESPONSE", { body: json });
	if (json.client_secret !== void 0) assertString(json.client_secret, "\"response\" body \"client_secret\" property", "OAUTH_INVALID_RESPONSE", { body: json });
	if (json.client_secret) assertNumber(json.client_secret_expires_at, true, "\"response\" body \"client_secret_expires_at\" property", "OAUTH_INVALID_RESPONSE", { body: json });
	return json;
}
async function getResponseJsonBody(response, check = assertApplicationJson) {
	let json;
	try {
		json = await response.json();
	} catch (cause) {
		check(response);
		throw OPE("failed to parse \"response\" body as JSON", "OAUTH_PARSE_ERROR", cause);
	}
	if (!isJsonObject(json)) throw OPE("\"response\" body must be a top level object", "OAUTH_INVALID_RESPONSE", { body: json });
	return json;
}
const _nodiscoverycheck = Symbol();
const _expectedIssuer = Symbol();
//#endregion
export { ClientSecretPost, None, allowInsecureRequests, authorizationCodeGrantRequest, calculatePKCECodeChallenge, discoveryRequest, dynamicClientRegistrationRequest, generateRandomCodeVerifier, generateRandomNonce, generateRandomState, getValidatedIdTokenClaims, processAuthorizationCodeResponse, processDiscoveryResponse, processDynamicClientRegistrationResponse, validateApplicationLevelSignature, validateAuthResponse, validateJwtAccessToken };
