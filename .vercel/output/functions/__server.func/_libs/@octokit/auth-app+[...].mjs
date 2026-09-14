import { createRequire as __wkfCreateRequire } from "node:module";
if (typeof globalThis.require === "undefined") globalThis.require = __wkfCreateRequire(import.meta.url);
import { createPrivateKey, subtle } from "node:crypto";
//#region node_modules/universal-user-agent/index.js
function getUserAgent() {
	if (typeof navigator === "object" && "userAgent" in navigator) return navigator.userAgent;
	if (typeof process === "object" && process.version !== void 0) return `Node.js/${process.version.substr(1)} (${process.platform}; ${process.arch})`;
	return "<environment undetectable>";
}
//#endregion
//#region node_modules/@octokit/endpoint/dist-bundle/index.js
var DEFAULTS = {
	method: "GET",
	baseUrl: "https://api.github.com",
	headers: {
		accept: "application/vnd.github.v3+json",
		"user-agent": `octokit-endpoint.js/0.0.0-development ${getUserAgent()}`
	},
	mediaType: { format: "" }
};
function lowercaseKeys(object) {
	if (!object) return {};
	return Object.keys(object).reduce((newObj, key) => {
		newObj[key.toLowerCase()] = object[key];
		return newObj;
	}, {});
}
function isPlainObject$1(value) {
	if (typeof value !== "object" || value === null) return false;
	if (Object.prototype.toString.call(value) !== "[object Object]") return false;
	const proto = Object.getPrototypeOf(value);
	if (proto === null) return true;
	const Ctor = Object.prototype.hasOwnProperty.call(proto, "constructor") && proto.constructor;
	return typeof Ctor === "function" && Ctor instanceof Ctor && Function.prototype.call(Ctor) === Function.prototype.call(value);
}
function mergeDeep(defaults, options) {
	const result = Object.assign({}, defaults);
	Object.keys(options).forEach((key) => {
		if (isPlainObject$1(options[key])) {
			if (!(key in defaults)) Object.assign(result, { [key]: options[key] });
			else result[key] = mergeDeep(defaults[key], options[key]);
		} else Object.assign(result, { [key]: options[key] });
	});
	return result;
}
function removeUndefinedProperties(obj) {
	for (const key in obj) if (obj[key] === void 0) delete obj[key];
	return obj;
}
function merge(defaults, route, options) {
	if (typeof route === "string") {
		let [method, url] = route.split(" ");
		options = Object.assign(url ? {
			method,
			url
		} : { url: method }, options);
	} else options = Object.assign({}, route);
	options.headers = lowercaseKeys(options.headers);
	removeUndefinedProperties(options);
	removeUndefinedProperties(options.headers);
	const mergedOptions = mergeDeep(defaults || {}, options);
	if (options.url === "/graphql") {
		if (defaults && defaults.mediaType.previews?.length) mergedOptions.mediaType.previews = defaults.mediaType.previews.filter((preview) => !mergedOptions.mediaType.previews.includes(preview)).concat(mergedOptions.mediaType.previews);
		mergedOptions.mediaType.previews = (mergedOptions.mediaType.previews || []).map((preview) => preview.replace(/-preview/, ""));
	}
	return mergedOptions;
}
function addQueryParameters(url, parameters) {
	const separator = /\?/.test(url) ? "&" : "?";
	const names = Object.keys(parameters);
	if (names.length === 0) return url;
	return url + separator + names.map((name) => {
		if (name === "q") return "q=" + parameters.q.split("+").map(encodeURIComponent).join("+");
		return `${name}=${encodeURIComponent(parameters[name])}`;
	}).join("&");
}
var urlVariableRegex = /\{[^{}}]+\}/g;
function removeNonChars(variableName) {
	return variableName.replace(/(?:^\W+)|(?:(?<!\W)\W+$)/g, "").split(/,/);
}
function extractUrlVariableNames(url) {
	const matches = url.match(urlVariableRegex);
	if (!matches) return [];
	return matches.map(removeNonChars).reduce((a, b) => a.concat(b), []);
}
function omit(object, keysToOmit) {
	const result = { __proto__: null };
	for (const key of Object.keys(object)) if (keysToOmit.indexOf(key) === -1) result[key] = object[key];
	return result;
}
function encodeReserved(str) {
	return str.split(/(%[0-9A-Fa-f]{2})/g).map(function(part) {
		if (!/%[0-9A-Fa-f]/.test(part)) part = encodeURI(part).replace(/%5B/g, "[").replace(/%5D/g, "]");
		return part;
	}).join("");
}
function encodeUnreserved(str) {
	return encodeURIComponent(str).replace(/[!'()*]/g, function(c) {
		return "%" + c.charCodeAt(0).toString(16).toUpperCase();
	});
}
function encodeValue(operator, value, key) {
	value = operator === "+" || operator === "#" ? encodeReserved(value) : encodeUnreserved(value);
	if (key) return encodeUnreserved(key) + "=" + value;
	else return value;
}
function isDefined(value) {
	return value !== void 0 && value !== null;
}
function isKeyOperator(operator) {
	return operator === ";" || operator === "&" || operator === "?";
}
function getValues(context, operator, key, modifier) {
	var value = context[key], result = [];
	if (isDefined(value) && value !== "") {
		if (typeof value === "string" || typeof value === "number" || typeof value === "bigint" || typeof value === "boolean") {
			value = value.toString();
			if (modifier && modifier !== "*") value = value.substring(0, parseInt(modifier, 10));
			result.push(encodeValue(operator, value, isKeyOperator(operator) ? key : ""));
		} else if (modifier === "*") {
			if (Array.isArray(value)) value.filter(isDefined).forEach(function(value2) {
				result.push(encodeValue(operator, value2, isKeyOperator(operator) ? key : ""));
			});
			else Object.keys(value).forEach(function(k) {
				if (isDefined(value[k])) result.push(encodeValue(operator, value[k], k));
			});
		} else {
			const tmp = [];
			if (Array.isArray(value)) value.filter(isDefined).forEach(function(value2) {
				tmp.push(encodeValue(operator, value2));
			});
			else Object.keys(value).forEach(function(k) {
				if (isDefined(value[k])) {
					tmp.push(encodeUnreserved(k));
					tmp.push(encodeValue(operator, value[k].toString()));
				}
			});
			if (isKeyOperator(operator)) result.push(encodeUnreserved(key) + "=" + tmp.join(","));
			else if (tmp.length !== 0) result.push(tmp.join(","));
		}
	} else if (operator === ";") {
		if (isDefined(value)) result.push(encodeUnreserved(key));
	} else if (value === "" && (operator === "&" || operator === "?")) result.push(encodeUnreserved(key) + "=");
	else if (value === "") result.push("");
	return result;
}
function parseUrl(template) {
	return { expand: expand.bind(null, template) };
}
function expand(template, context) {
	var operators = [
		"+",
		"#",
		".",
		"/",
		";",
		"?",
		"&"
	];
	template = template.replace(/\{([^\{\}]+)\}|([^\{\}]+)/g, function(_, expression, literal) {
		if (expression) {
			let operator = "";
			const values = [];
			if (operators.indexOf(expression.charAt(0)) !== -1) {
				operator = expression.charAt(0);
				expression = expression.substr(1);
			}
			expression.split(/,/g).forEach(function(variable) {
				var tmp = /([^:\*]*)(?::(\d+)|(\*))?/.exec(variable);
				values.push(getValues(context, operator, tmp[1], tmp[2] || tmp[3]));
			});
			if (operator && operator !== "+") {
				var separator = ",";
				if (operator === "?") separator = "&";
				else if (operator !== "#") separator = operator;
				return (values.length !== 0 ? operator : "") + values.join(separator);
			} else return values.join(",");
		} else return encodeReserved(literal);
	});
	if (template === "/") return template;
	else return template.replace(/\/$/, "");
}
function parse$1(options) {
	let method = options.method.toUpperCase();
	let url = (options.url || "/").replace(/:([a-z]\w+)/g, "{$1}");
	let headers = Object.assign({}, options.headers);
	let body;
	let parameters = omit(options, [
		"method",
		"baseUrl",
		"url",
		"headers",
		"request",
		"mediaType"
	]);
	const urlVariableNames = extractUrlVariableNames(url);
	url = parseUrl(url).expand(parameters);
	if (!/^http/.test(url)) url = options.baseUrl + url;
	const remainingParameters = omit(parameters, Object.keys(options).filter((option) => urlVariableNames.includes(option)).concat("baseUrl"));
	if (!/application\/octet-stream/i.test(headers.accept)) {
		if (options.mediaType.format) headers.accept = headers.accept.split(/,/).map((format) => format.replace(/application\/vnd(\.\w+)(\.v3)?(\.\w+)?(\+json)?$/, `application/vnd$1$2.${options.mediaType.format}`)).join(",");
		if (url.endsWith("/graphql")) {
			if (options.mediaType.previews?.length) headers.accept = (headers.accept.match(/(?<![\w-])[\w-]+(?=-preview)/g) || []).concat(options.mediaType.previews).map((preview) => {
				return `application/vnd.github.${preview}-preview${options.mediaType.format ? `.${options.mediaType.format}` : "+json"}`;
			}).join(",");
		}
	}
	if (["GET", "HEAD"].includes(method)) url = addQueryParameters(url, remainingParameters);
	else if ("data" in remainingParameters) body = remainingParameters.data;
	else if (Object.keys(remainingParameters).length) body = remainingParameters;
	if (!headers["content-type"] && typeof body !== "undefined") headers["content-type"] = "application/json; charset=utf-8";
	if (["PATCH", "PUT"].includes(method) && typeof body === "undefined") body = "";
	return Object.assign({
		method,
		url,
		headers
	}, typeof body !== "undefined" ? { body } : null, options.request ? { request: options.request } : null);
}
function endpointWithDefaults(defaults, route, options) {
	return parse$1(merge(defaults, route, options));
}
function withDefaults$1(oldDefaults, newDefaults) {
	const DEFAULTS2 = merge(oldDefaults, newDefaults);
	const endpoint2 = endpointWithDefaults.bind(null, DEFAULTS2);
	return Object.assign(endpoint2, {
		DEFAULTS: DEFAULTS2,
		defaults: withDefaults$1.bind(null, DEFAULTS2),
		merge: merge.bind(null, DEFAULTS2),
		parse: parse$1
	});
}
var endpoint = withDefaults$1(null, DEFAULTS);
//#endregion
//#region node_modules/@octokit/request/node_modules/content-type/dist/index.js
/*!
* content-type
* Copyright(c) 2015 Douglas Christopher Wilson
* MIT Licensed
*/
/**
* Null object perf optimization. Faster than `Object.create(null)` and `{ __proto__: null }`.
*/
const NullObject = /* @__PURE__ */ (() => {
	const C = function() {};
	C.prototype = Object.create(null);
	return C;
})();
/**
* Parse a `Content-Type` header.
*/
function parse(header, options) {
	const stopChar = options?.comma === true ? COMMA : 65536;
	const len = header.length;
	let index = skipOWS(header, options?.start ?? 0, len);
	const valueStart = index;
	index = skipValue(header, index, len, stopChar);
	const valueEnd = trailingOWS(header, valueStart, index);
	const type = header.slice(valueStart, valueEnd).toLowerCase();
	if (options?.parameters === false) return {
		type,
		index,
		parameters: new NullObject()
	};
	return parseParameters(header, type, index, len, stopChar);
}
const SP = 32;
const HTAB = 9;
const SEMI = 59;
const EQ = 61;
const DQUOTE = 34;
const BSLASH = 92;
const COMMA = 44;
/**
* Parses the parameters of a `Content-Type` header starting at the given index.
*/
function parseParameters(header, type, index, len, stopChar) {
	const parameters = new NullObject();
	parameter: while (index < len) {
		if (header.charCodeAt(index) === stopChar) break;
		index = skipOWS(header, index + 1, len);
		const keyStart = index;
		while (index < len) {
			const code = header.charCodeAt(index);
			if (code === stopChar) break parameter;
			if (code === SEMI) continue parameter;
			if (code === EQ) {
				const keyEnd = trailingOWS(header, keyStart, index);
				const key = header.slice(keyStart, keyEnd).toLowerCase();
				index = skipOWS(header, index + 1, len);
				if (index < len && header.charCodeAt(index) === DQUOTE) {
					index++;
					let value = "";
					while (index < len) {
						const code = header.charCodeAt(index++);
						if (code === DQUOTE) {
							index = skipValue(header, index, len, stopChar);
							if (parameters[key] === void 0) parameters[key] = value;
							break;
						}
						if (code === BSLASH && index < len) {
							value += header[index++];
							continue;
						}
						value += String.fromCharCode(code);
					}
					continue parameter;
				}
				const valueStart = index;
				index = skipValue(header, index, len, stopChar);
				if (parameters[key] === void 0) {
					const valueEnd = trailingOWS(header, valueStart, index);
					parameters[key] = header.slice(valueStart, valueEnd);
				}
				continue parameter;
			}
			index++;
		}
	}
	return {
		type,
		index,
		parameters
	};
}
/**
* Skip over characters until a semicolon or other exit character.
*/
function skipValue(str, index, len, stopChar) {
	while (index < len) {
		const code = str.charCodeAt(index);
		if (code === SEMI || code === stopChar) break;
		index++;
	}
	return index;
}
/**
* Skip optional whitespace (OWS) in an HTTP header value.
*
* OWS is defined in RFC 9110 sec 5.6.3 as SP (" ") or HTAB ("\t").
*/
function skipOWS(header, index, len) {
	while (index < len) {
		const char = header.charCodeAt(index);
		if (char !== SP && char !== HTAB) break;
		index++;
	}
	return index;
}
/**
* Trim optional whitespace (OWS) from the end of a substring.
*
* OWS is defined in RFC 9110 sec 5.6.3 as SP (" ") or HTAB ("\t").
*/
function trailingOWS(header, start, end) {
	while (end > start) {
		const char = header.charCodeAt(end - 1);
		if (char !== SP && char !== HTAB) break;
		end--;
	}
	return end;
}
//#endregion
//#region node_modules/json-with-bigint/json-with-bigint.js
const intRegex = /^-?\d+$/;
const noiseValue = /^-?\d+n+$/;
const originalStringify = JSON.stringify;
const originalParse = JSON.parse;
const customFormat = /^-?\d+n$/;
const bigIntsStringify = /([\[:])?"(-?\d+)n"($|\s*[,\}\]])/g;
const noiseStringify = /([\[:])?("-?\d+n+)n("$|"\s*[,\}\]])/g;
/**
* @typedef {(this: any, key: string | number | undefined, value: any) => any} Replacer
* @typedef {(key: string | number | undefined, value: any, context?: { source: string }) => any} Reviver
*/
/**
* Checks if a value is unstringifiable according to native JSON.stringify rules.
*
* @param {any} val The value to check.
* @returns {boolean} True if the value is undefined, a function, or a symbol.
*/
const isUnstringifiable = (val) => val === void 0 || typeof val === "function" || typeof val === "symbol";
/**
* Checks if a value is a native JSON.rawJSON object (Node.js 22+).
*
* @param {any} val The value to check.
* @returns {boolean} True if the value is a RawJSON instance.
*/
const isRawJSON = (val) => val !== null && typeof val === "object" && val.constructor && val.constructor.name === "RawJSON";
/**
* Iteratively converts a JS value to a JSON string.
* Used as a fallback when the native JSON.stringify hits the Maximum Call Stack size.
* Fully compliant with JSON formatting (space), replacers, and toJSON behaviors.
*
* @param {any} rootValue The value to stringify.
* @param {Replacer | Array<string | number> | null} [replacer] User's custom replacer function.
* @param {string | number} [spaceParam] Indentation for pretty-printing.
* @returns {string | undefined} The generated JSON string.
*/
const stringifyIteratively = (rootValue, replacer, spaceParam) => {
	let space = "";
	if (typeof spaceParam === "number") space = " ".repeat(Math.min(10, Math.max(0, Math.floor(spaceParam))));
	else if (typeof spaceParam === "string") space = spaceParam.slice(0, 10);
	const isFunctionReplacer = typeof replacer === "function";
	const propertyList = Array.isArray(replacer) ? new Set(replacer.map(String)) : null;
	/**
	* Prepares a value for stringification by resolving toJSON, handling BigInts,
	* applying custom replacers, and unwrapping primitive objects.
	*
	* @param {object|Array} parent The parent object or array holding the value.
	* @param {string} key The key associated with the value.
	* @param {any} val The raw value to process.
	* @returns {any} The processed value ready for stringification.
	*/
	const prepareVal = (parent, key, val) => {
		if (val !== null && typeof val === "object" && typeof val.toJSON === "function") val = val.toJSON(key);
		if (typeof val === "string" && noiseValue.test(val)) return val + "n";
		if (typeof val === "bigint") {
			if ("rawJSON" in JSON) return JSON.rawJSON(val.toString());
			return val.toString() + "n";
		}
		if (isFunctionReplacer) val = replacer.call(parent, key, val);
		if (val !== null && typeof val === "object") {
			if (val instanceof Number || val instanceof String || val instanceof Boolean) val = val.valueOf();
		}
		return val;
	};
	const rootProcessed = prepareVal({ "": rootValue }, "", rootValue);
	if (isUnstringifiable(rootProcessed)) return;
	const isRootPrimitive = rootProcessed === null || typeof rootProcessed !== "object";
	const isRootNativeRawJSON = isRawJSON(rootProcessed);
	if (isRootPrimitive || isRootNativeRawJSON) return originalStringify(rootProcessed);
	const chunks = [];
	let level = 0;
	const stack = [{
		parent: { "": rootProcessed },
		key: "",
		val: rootProcessed,
		isArray: Array.isArray(rootProcessed),
		keys: Array.isArray(rootProcessed) ? null : Object.keys(rootProcessed),
		index: 0,
		first: true
	}];
	const visited = new WeakSet([rootProcessed]);
	while (stack.length > 0) {
		const node = stack[stack.length - 1];
		if (node.index === 0) {
			chunks.push(node.isArray ? "[" : "{");
			level++;
		}
		let isDone = false;
		if (node.isArray) {
			if (node.index < node.val.length) {
				if (!node.first) chunks.push(",");
				if (space) chunks.push("\n" + space.repeat(level));
				const childRaw = node.val[node.index];
				const childVal = prepareVal(node.val, String(node.index), childRaw);
				if (isUnstringifiable(childVal)) {
					chunks.push("null");
					node.first = false;
					node.index++;
				} else {
					const isComplexObject = childVal !== null && typeof childVal === "object";
					const isNativeRaw = isRawJSON(childVal);
					if (isComplexObject && !isNativeRaw) {
						if (visited.has(childVal)) throw new TypeError("Converting circular structure to JSON");
						visited.add(childVal);
						stack.push({
							parent: node.val,
							key: String(node.index),
							val: childVal,
							isArray: Array.isArray(childVal),
							keys: Array.isArray(childVal) ? null : Object.keys(childVal),
							index: 0,
							first: true
						});
						node.first = false;
						node.index++;
					} else {
						chunks.push(originalStringify(childVal));
						node.first = false;
						node.index++;
					}
				}
			} else isDone = true;
		} else {
			while (node.index < node.keys.length) {
				const k = node.keys[node.index++];
				if (propertyList && !propertyList.has(k)) continue;
				const childRaw = node.val[k];
				const childVal = prepareVal(node.val, k, childRaw);
				if (isUnstringifiable(childVal)) continue;
				if (!node.first) chunks.push(",");
				if (space) chunks.push("\n" + space.repeat(level) + originalStringify(k) + ": ");
				else chunks.push(originalStringify(k) + ":");
				const isComplexObject = childVal !== null && typeof childVal === "object";
				const isNativeRaw = isRawJSON(childVal);
				if (isComplexObject && !isNativeRaw) {
					if (visited.has(childVal)) throw new TypeError("Converting circular structure to JSON");
					visited.add(childVal);
					stack.push({
						parent: node.val,
						key: k,
						val: childVal,
						isArray: Array.isArray(childVal),
						keys: Array.isArray(childVal) ? null : Object.keys(childVal),
						index: 0,
						first: true
					});
					node.first = false;
					break;
				} else {
					chunks.push(originalStringify(childVal));
					node.first = false;
				}
			}
			if (node.index >= node.keys.length && stack[stack.length - 1] === node) isDone = true;
		}
		if (isDone) {
			level--;
			if (!node.first && space) chunks.push("\n" + space.repeat(level));
			chunks.push(node.isArray ? "]" : "}");
			visited.delete(node.val);
			stack.pop();
		}
	}
	return chunks.join("");
};
/**
* Converts a JavaScript value to a JSON string.
*
* Supports serialization of BigInt values using two strategies:
* 1. Custom format "123n" → "123" (universal fallback)
* 2. Native JSON.rawJSON() (Node.js 22+, fastest) when available
*
* All other values are serialized exactly like native JSON.stringify().
*
* @param {*} value The value to convert to a JSON string.
* @param {Replacer | Array<string | number> | null} [replacer]
* A function that alters the behavior of the stringification process,
* or an array of strings/numbers to indicate properties to exclude.
* @param {string | number} [space]
* A string or number to specify indentation or pretty-printing.
* @returns {string} The JSON string representation.
*/
const JSONStringify = (value, replacer, space) => {
	try {
		if ("rawJSON" in JSON) return originalStringify(value, (key, val) => {
			if (typeof val === "bigint") return JSON.rawJSON(val.toString());
			if (typeof replacer === "function") return replacer(key, val);
			if (Array.isArray(replacer) && replacer.includes(key)) return val;
			return val;
		}, space);
		if (!value) return originalStringify(value, replacer, space);
		return originalStringify(value, (key, val) => {
			if (typeof val === "string" && noiseValue.test(val)) return val.toString() + "n";
			if (typeof val === "bigint") return val.toString() + "n";
			if (typeof replacer === "function") return replacer(key, val);
			if (Array.isArray(replacer) && replacer.includes(key)) return val;
			return val;
		}, space).replace(bigIntsStringify, "$1$2$3").replace(noiseStringify, "$1$2$3");
	} catch (error) {
		if (error instanceof RangeError) {
			const convertedJSON = stringifyIteratively(value, replacer, space);
			if (convertedJSON === void 0) return void 0;
			if ("rawJSON" in JSON) return convertedJSON;
			return convertedJSON.replace(bigIntsStringify, "$1$2$3").replace(noiseStringify, "$1$2$3");
		}
		throw error;
	}
};
const featureCache = /* @__PURE__ */ new Map();
/**
* Detects if the current JSON.parse implementation supports the context.source feature.
*
* Uses toString() fingerprinting to cache results and automatically detect runtime
* replacements of JSON.parse (polyfills, mocks, etc.).
*
* @returns {boolean} true if context.source is supported, false otherwise.
*/
const isContextSourceSupported = () => {
	const parseFingerprint = JSON.parse.toString();
	if (featureCache.has(parseFingerprint)) return featureCache.get(parseFingerprint);
	try {
		const result = JSON.parse("1", (_, __, context) => !!context?.source && context.source === "1");
		featureCache.set(parseFingerprint, result);
		return result;
	} catch {
		featureCache.set(parseFingerprint, false);
		return false;
	}
};
/**
* Reviver function that converts custom-format BigInt strings back to BigInt values.
* Also handles "noise" strings that accidentally match the BigInt format.
*
* @param {string | number | undefined} key The object key.
* @param {*} value The value being parsed.
* @param {object} [context] Parse context (if supported by JSON.parse).
* @param {Reviver} [userReviver] User's custom reviver function.
* @returns {any} The transformed value.
*/
const convertMarkedBigIntsReviver = (key, value, context, userReviver) => {
	if (typeof value === "string" && customFormat.test(value)) return BigInt(value.slice(0, -1));
	if (typeof value === "string" && noiseValue.test(value)) return value.slice(0, -1);
	if (!(typeof userReviver === "function")) return value;
	return userReviver(key, value, context);
};
/**
* Fast JSON.parse implementation (~2x faster than classic fallback).
* Uses JSON.parse's context.source feature to detect integers and convert
* large numbers directly to BigInt without string manipulation.
*
* Does not support legacy custom format from v1 of this library.
*
* @param {string} text JSON string to parse.
* @param {Reviver} [reviver] Transform function to apply to each value.
* @returns {any} Parsed JavaScript value.
*/
const JSONParseV2 = (text, reviver) => {
	return JSON.parse(text, (key, value, context) => {
		const isNumber = typeof value === "number";
		const isOutOfBounds = value > Number.MAX_SAFE_INTEGER || value < Number.MIN_SAFE_INTEGER;
		const isBigNumber = isNumber && isOutOfBounds;
		const isInt = context && intRegex.test(context.source);
		if (isBigNumber && isInt) return BigInt(context.source);
		if (!(typeof reviver === "function")) return value;
		return reviver(key, value, context);
	});
};
const MAX_INT = Number.MAX_SAFE_INTEGER.toString();
const MAX_DIGITS = MAX_INT.length;
const stringsOrLargeNumbers = /"(?:[^"\\]|\\.)*"|-?(0|[1-9][0-9]*)(\.[0-9]+)?([eE][+-]?[0-9]+)?/g;
const noiseValueWithQuotes = /^"-?\d+n+"$/;
/**
* Iteratively traverses the parsed object bottom-up (post-order),
* emulating the native JSON.parse reviver behavior.
* This avoids Call Stack overflows (RangeError) on deeply nested structures.
*
* @param {any} parsed The natively parsed JSON object.
* @param {Reviver} [userReviver] User's custom reviver function.
* @returns {any} The fully processed object.
*/
const applyReviverIteratively = (parsed, userReviver) => {
	const rootHolder = { "": parsed };
	const stack = [{
		parent: rootHolder,
		key: "",
		visited: false
	}];
	while (stack.length > 0) {
		const node = stack[stack.length - 1];
		if (!node.visited) {
			node.visited = true;
			const value = node.parent[node.key];
			if (value !== null && typeof value === "object") {
				const keys = Object.keys(value);
				for (let i = keys.length - 1; i >= 0; i--) stack.push({
					parent: value,
					key: keys[i],
					visited: false
				});
			}
		} else {
			const { parent, key } = node;
			let value = parent[key];
			if (typeof value === "string") {
				if (customFormat.test(value)) value = BigInt(value.slice(0, -1));
				else if (noiseValue.test(value)) value = value.slice(0, -1);
			}
			if (typeof userReviver === "function") value = userReviver.call(parent, key, value);
			if (value === void 0) delete parent[key];
			else parent[key] = value;
			stack.pop();
		}
	}
	return rootHolder[""];
};
/**
* Pre-processes the JSON string to mark large numbers with an 'n' suffix.
*
* @param {string} text The raw JSON string.
* @returns {string} The serialized string with marked BigInts.
*/
const serializeBigInts = (text) => {
	return text.replace(stringsOrLargeNumbers, (match, digits, fractional, exponential) => {
		const isString = match[0] === "\"";
		if (isString && noiseValueWithQuotes.test(match)) return match.substring(0, match.length - 1) + "n\"";
		const hasFractionalOrExponential = fractional || exponential;
		const isLessThanMaxSafeInt = digits && (digits.length < MAX_DIGITS || digits.length === MAX_DIGITS && digits <= MAX_INT);
		if (isString || hasFractionalOrExponential || isLessThanMaxSafeInt) return match;
		return "\"" + match + "n\"";
	});
};
/**
* Converts a JSON string into a JavaScript value.
*
* Supports parsing of large integers using two strategies:
* 1. Classic fallback: Marks large numbers with "123n" format, then converts to BigInt
* 2. Fast path (JSONParseV2): Uses context.source feature (~2x faster) when available
*
* All other JSON values are parsed exactly like native JSON.parse().
*
* @param {string} text A valid JSON string.
* @param {Reviver} [reviver]
* A function that transforms the results. This function is called for each member
* of the object. If a member contains nested objects, the nested objects are
* transformed before the parent object is.
* @returns {any} The parsed JavaScript value.
* @throws {SyntaxError} If text is not valid JSON.
*/
const JSONParse = (text, reviver) => {
	if (!text) return originalParse(text, reviver);
	try {
		if (isContextSourceSupported()) return JSONParseV2(text, reviver);
		const serializedData = serializeBigInts(text);
		return originalParse(serializedData, (key, value, context) => convertMarkedBigIntsReviver(key, value, context, reviver));
	} catch (error) {
		if (error instanceof RangeError) {
			const serializedData = serializeBigInts(text);
			const parsed = originalParse(serializedData);
			return applyReviverIteratively(parsed, reviver);
		}
		throw error;
	}
};
//#endregion
//#region node_modules/@octokit/request-error/dist-src/index.js
var RequestError = class extends Error {
	name;
	/**
	* http status code
	*/
	status;
	/**
	* Request options that lead to the error.
	*/
	request;
	/**
	* Response object if a response was received
	*/
	response;
	constructor(message, statusCode, options) {
		super(message, { cause: options.cause });
		this.name = "HttpError";
		this.status = Number.parseInt(statusCode);
		if (Number.isNaN(this.status)) this.status = 0;
		/* v8 ignore else -- @preserve -- Bug with vitest coverage where it sees an else branch that doesn't exist */
		if ("response" in options) this.response = options.response;
		const requestCopy = Object.assign({}, options.request);
		if (options.request.headers.authorization) requestCopy.headers = Object.assign({}, options.request.headers, { authorization: options.request.headers.authorization.replace(/(?<! ) .*$/, " [REDACTED]") });
		requestCopy.url = requestCopy.url.replace(/\bclient_secret=\w+/g, "client_secret=[REDACTED]").replace(/\baccess_token=\w+/g, "access_token=[REDACTED]");
		this.request = requestCopy;
	}
};
//#endregion
//#region node_modules/@octokit/request/dist-bundle/index.js
var defaults_default = { headers: { "user-agent": `octokit-request.js/10.0.16 ${getUserAgent()}` } };
function isPlainObject(value) {
	if (typeof value !== "object" || value === null) return false;
	if (Object.prototype.toString.call(value) !== "[object Object]") return false;
	const proto = Object.getPrototypeOf(value);
	if (proto === null) return true;
	const Ctor = Object.prototype.hasOwnProperty.call(proto, "constructor") && proto.constructor;
	return typeof Ctor === "function" && Ctor instanceof Ctor && Function.prototype.call(Ctor) === Function.prototype.call(value);
}
var noop = () => "";
async function fetchWrapper(requestOptions) {
	const fetch = requestOptions.request?.fetch || globalThis.fetch;
	if (!fetch) throw new Error("fetch is not set. Please pass a fetch implementation as new Octokit({ request: { fetch }}). Learn more at https://github.com/octokit/octokit.js/#fetch-missing");
	const log = requestOptions.request?.log || console;
	const parseSuccessResponseBody = requestOptions.request?.parseSuccessResponseBody !== false;
	const body = isPlainObject(requestOptions.body) || Array.isArray(requestOptions.body) ? JSONStringify(requestOptions.body) : requestOptions.body;
	const requestHeaders = Object.fromEntries(Object.entries(requestOptions.headers).map(([name, value]) => [name, String(value)]));
	let fetchResponse;
	try {
		fetchResponse = await fetch(requestOptions.url, {
			method: requestOptions.method,
			body,
			redirect: requestOptions.request?.redirect,
			headers: requestHeaders,
			signal: requestOptions.request?.signal,
			...requestOptions.body && { duplex: "half" }
		});
	} catch (error) {
		let message = "Unknown Error";
		if (error instanceof Error) {
			if (error.name === "AbortError") {
				error.status = 500;
				throw error;
			}
			message = error.message;
			if (error.name === "TypeError" && "cause" in error) {
				if (error.cause instanceof Error) message = error.cause.message;
				else if (typeof error.cause === "string") message = error.cause;
			}
		}
		const requestError = new RequestError(message, 500, { request: requestOptions });
		requestError.cause = error;
		throw requestError;
	}
	const status = fetchResponse.status;
	const url = fetchResponse.url;
	const responseHeaders = {};
	for (const [key, value] of fetchResponse.headers) responseHeaders[key] = value;
	const octokitResponse = {
		url,
		status,
		headers: responseHeaders,
		data: ""
	};
	if ("deprecation" in responseHeaders) {
		const matches = responseHeaders.link && responseHeaders.link.match(/<([^<>]+)>; rel="deprecation"/);
		const deprecationLink = matches && matches.pop();
		log.warn(`[@octokit/request] "${requestOptions.method} ${requestOptions.url}" is deprecated. It is scheduled to be removed on ${responseHeaders.sunset}${deprecationLink ? `. See ${deprecationLink}` : ""}`);
	}
	if (status === 204 || status === 205) return octokitResponse;
	if (requestOptions.method === "HEAD") {
		if (status < 400) return octokitResponse;
		throw new RequestError(fetchResponse.statusText, status, {
			response: octokitResponse,
			request: requestOptions
		});
	}
	if (status === 304) {
		octokitResponse.data = await getResponseData(fetchResponse);
		throw new RequestError("Not modified", status, {
			response: octokitResponse,
			request: requestOptions
		});
	}
	if (status >= 400) {
		octokitResponse.data = await getResponseData(fetchResponse);
		throw new RequestError(toErrorMessage(octokitResponse.data), status, {
			response: octokitResponse,
			request: requestOptions
		});
	}
	octokitResponse.data = parseSuccessResponseBody ? await getResponseData(fetchResponse) : fetchResponse.body;
	return octokitResponse;
}
async function getResponseData(response) {
	const contentType = response.headers.get("content-type");
	if (!contentType) return response.text().catch(noop);
	const mimetype = parse(contentType);
	if (isJSONResponse(mimetype)) {
		let text = "";
		try {
			text = await response.text();
			return JSONParse(text);
		} catch (err) {
			return text;
		}
	} else if (mimetype.type.startsWith("text/") || mimetype.parameters.charset?.toLowerCase() === "utf-8" && mimetype.type !== "application/octet-stream") return response.text().catch(noop);
	else return response.arrayBuffer().catch(
		/* v8 ignore next -- @preserve */
		() => /* @__PURE__ */ new ArrayBuffer(0)
	);
}
function isJSONResponse(mimetype) {
	return mimetype.type === "application/json" || mimetype.type === "application/scim+json";
}
function toErrorMessage(data) {
	if (typeof data === "string") return data;
	if (data instanceof ArrayBuffer) return "Unknown error";
	if (typeof data === "object" && data !== null && "message" in data) {
		const objectData = data;
		const suffix = "documentation_url" in objectData ? ` - ${objectData.documentation_url}` : "";
		return Array.isArray(objectData.errors) ? `${objectData.message}: ${objectData.errors.map((v) => JSON.stringify(v)).join(", ")}${suffix}` : `${objectData.message}${suffix}`;
	}
	return `Unknown error: ${JSON.stringify(data)}`;
}
function withDefaults(oldEndpoint, newDefaults) {
	const endpoint2 = oldEndpoint.defaults(newDefaults);
	const newApi = function(route, parameters) {
		const endpointOptions = endpoint2.merge(route, parameters);
		if (!endpointOptions.request || !endpointOptions.request.hook) return fetchWrapper(endpoint2.parse(endpointOptions));
		const request2 = (route2, parameters2) => {
			return fetchWrapper(endpoint2.parse(endpoint2.merge(route2, parameters2)));
		};
		Object.assign(request2, {
			endpoint: endpoint2,
			defaults: withDefaults.bind(null, endpoint2)
		});
		return endpointOptions.request.hook(request2, endpointOptions);
	};
	return Object.assign(newApi, {
		endpoint: endpoint2,
		defaults: withDefaults.bind(null, endpoint2)
	});
}
var request = withDefaults(endpoint, defaults_default);
/* v8 ignore next -- @preserve */
/* v8 ignore else -- @preserve */
//#endregion
//#region node_modules/@octokit/oauth-methods/dist-bundle/index.js
function requestToOAuthBaseUrl(request) {
	const endpointDefaults = request.endpoint.DEFAULTS;
	if (/^https:\/\/(api\.)?github\.com$/.test(endpointDefaults.baseUrl)) return "https://github.com";
	if (/^https:\/\/api\..*\.ghe\.com$/.test(endpointDefaults.baseUrl)) return endpointDefaults.baseUrl.replace("api.", "");
	return endpointDefaults.baseUrl.replace("/api/v3", "");
}
async function oauthRequest(request, route, parameters) {
	const withOAuthParameters = {
		baseUrl: requestToOAuthBaseUrl(request),
		headers: { accept: "application/json" },
		...parameters
	};
	const response = await request(route, withOAuthParameters);
	if ("error" in response.data) {
		const error = new RequestError(`${response.data.error_description} (${response.data.error}, ${response.data.error_uri})`, 400, { request: request.endpoint.merge(route, withOAuthParameters) });
		error.response = response;
		throw error;
	}
	return response;
}
async function exchangeWebFlowCode(options) {
	const response = await oauthRequest(options.request || request, "POST /login/oauth/access_token", {
		client_id: options.clientId,
		client_secret: options.clientSecret,
		code: options.code,
		redirect_uri: options.redirectUrl
	});
	const authentication = {
		clientType: options.clientType,
		clientId: options.clientId,
		clientSecret: options.clientSecret,
		token: response.data.access_token,
		scopes: response.data.scope.split(/\s+/).filter(Boolean)
	};
	if (options.clientType === "github-app") {
		if ("refresh_token" in response.data) {
			const apiTimeInMs = new Date(response.headers.date).getTime();
			authentication.refreshToken = response.data.refresh_token, authentication.expiresAt = toTimestamp(apiTimeInMs, response.data.expires_in), authentication.refreshTokenExpiresAt = toTimestamp(apiTimeInMs, response.data.refresh_token_expires_in);
		}
		delete authentication.scopes;
	}
	return {
		...response,
		authentication
	};
}
function toTimestamp(apiTimeInMs, expirationInSeconds) {
	return new Date(apiTimeInMs + expirationInSeconds * 1e3).toISOString();
}
async function createDeviceCode(options) {
	const request$5 = options.request || request;
	const parameters = { client_id: options.clientId };
	if ("scopes" in options && Array.isArray(options.scopes)) parameters.scope = options.scopes.join(" ");
	return oauthRequest(request$5, "POST /login/device/code", parameters);
}
async function exchangeDeviceCode(options) {
	const response = await oauthRequest(options.request || request, "POST /login/oauth/access_token", {
		client_id: options.clientId,
		device_code: options.code,
		grant_type: "urn:ietf:params:oauth:grant-type:device_code"
	});
	const authentication = {
		clientType: options.clientType,
		clientId: options.clientId,
		token: response.data.access_token,
		scopes: response.data.scope.split(/\s+/).filter(Boolean)
	};
	if ("clientSecret" in options) authentication.clientSecret = options.clientSecret;
	if (options.clientType === "github-app") {
		if ("refresh_token" in response.data) {
			const apiTimeInMs = new Date(response.headers.date).getTime();
			authentication.refreshToken = response.data.refresh_token, authentication.expiresAt = toTimestamp2(apiTimeInMs, response.data.expires_in), authentication.refreshTokenExpiresAt = toTimestamp2(apiTimeInMs, response.data.refresh_token_expires_in);
		}
		delete authentication.scopes;
	}
	return {
		...response,
		authentication
	};
}
function toTimestamp2(apiTimeInMs, expirationInSeconds) {
	return new Date(apiTimeInMs + expirationInSeconds * 1e3).toISOString();
}
async function checkToken(options) {
	const response = await (options.request || request)("POST /applications/{client_id}/token", {
		headers: { authorization: `basic ${btoa(`${options.clientId}:${options.clientSecret}`)}` },
		client_id: options.clientId,
		access_token: options.token
	});
	const authentication = {
		clientType: options.clientType,
		clientId: options.clientId,
		clientSecret: options.clientSecret,
		token: options.token,
		scopes: response.data.scopes
	};
	if (response.data.expires_at) authentication.expiresAt = response.data.expires_at;
	if (options.clientType === "github-app") delete authentication.scopes;
	return {
		...response,
		authentication
	};
}
async function refreshToken(options) {
	const response = await oauthRequest(options.request || request, "POST /login/oauth/access_token", {
		client_id: options.clientId,
		client_secret: options.clientSecret,
		grant_type: "refresh_token",
		refresh_token: options.refreshToken
	});
	const apiTimeInMs = new Date(response.headers.date).getTime();
	const authentication = {
		clientType: "github-app",
		clientId: options.clientId,
		clientSecret: options.clientSecret,
		token: response.data.access_token,
		refreshToken: response.data.refresh_token,
		expiresAt: toTimestamp3(apiTimeInMs, response.data.expires_in),
		refreshTokenExpiresAt: toTimestamp3(apiTimeInMs, response.data.refresh_token_expires_in)
	};
	return {
		...response,
		authentication
	};
}
function toTimestamp3(apiTimeInMs, expirationInSeconds) {
	return new Date(apiTimeInMs + expirationInSeconds * 1e3).toISOString();
}
async function resetToken(options) {
	const response = await (options.request || request)("PATCH /applications/{client_id}/token", {
		headers: { authorization: `basic ${btoa(`${options.clientId}:${options.clientSecret}`)}` },
		client_id: options.clientId,
		access_token: options.token
	});
	const authentication = {
		clientType: options.clientType,
		clientId: options.clientId,
		clientSecret: options.clientSecret,
		token: response.data.token,
		scopes: response.data.scopes
	};
	if (response.data.expires_at) authentication.expiresAt = response.data.expires_at;
	if (options.clientType === "github-app") delete authentication.scopes;
	return {
		...response,
		authentication
	};
}
async function deleteToken(options) {
	return (options.request || request)("DELETE /applications/{client_id}/token", {
		headers: { authorization: `basic ${btoa(`${options.clientId}:${options.clientSecret}`)}` },
		client_id: options.clientId,
		access_token: options.token
	});
}
async function deleteAuthorization(options) {
	return (options.request || request)("DELETE /applications/{client_id}/grant", {
		headers: { authorization: `basic ${btoa(`${options.clientId}:${options.clientSecret}`)}` },
		client_id: options.clientId,
		access_token: options.token
	});
}
/* v8 ignore next: we always pass a custom request in tests -- @preserve */
//#endregion
//#region node_modules/@octokit/auth-oauth-device/dist-bundle/index.js
async function getOAuthAccessToken(state, options) {
	const cachedAuthentication = getCachedAuthentication(state, options.auth);
	if (cachedAuthentication) return cachedAuthentication;
	const { data: verification } = await createDeviceCode({
		clientType: state.clientType,
		clientId: state.clientId,
		request: options.request || state.request,
		scopes: options.auth.scopes || state.scopes
	});
	await state.onVerification(verification);
	const authentication = await waitForAccessToken(options.request || state.request, state.clientId, state.clientType, verification);
	state.authentication = authentication;
	return authentication;
}
function getCachedAuthentication(state, auth2) {
	if (auth2.refresh === true) return false;
	if (!state.authentication) return false;
	if (state.clientType === "github-app") return state.authentication;
	const authentication = state.authentication;
	return ("scopes" in auth2 && auth2.scopes || state.scopes).join(" ") === authentication.scopes.join(" ") ? authentication : false;
}
async function wait(seconds) {
	await new Promise((resolve) => setTimeout(resolve, seconds * 1e3));
}
async function waitForAccessToken(request, clientId, clientType, verification) {
	try {
		const options = {
			clientId,
			request,
			code: verification.device_code
		};
		const { authentication } = clientType === "oauth-app" ? await exchangeDeviceCode({
			...options,
			clientType: "oauth-app"
		}) : await exchangeDeviceCode({
			...options,
			clientType: "github-app"
		});
		return {
			type: "token",
			tokenType: "oauth",
			...authentication
		};
	} catch (error) {
		if (!error.response) throw error;
		const errorType = error.response.data.error;
		if (errorType === "authorization_pending") {
			await wait(verification.interval);
			return waitForAccessToken(request, clientId, clientType, verification);
		}
		if (errorType === "slow_down") {
			await wait(verification.interval + 7);
			return waitForAccessToken(request, clientId, clientType, verification);
		}
		throw error;
	}
}
async function auth$3(state, authOptions) {
	return getOAuthAccessToken(state, { auth: authOptions });
}
async function hook$3(state, request, route, parameters) {
	let endpoint = request.endpoint.merge(route, parameters);
	if (/\/login\/(oauth\/access_token|device\/code)$/.test(endpoint.url)) return request(endpoint);
	const { token } = await getOAuthAccessToken(state, {
		request,
		auth: { type: "oauth" }
	});
	endpoint.headers.authorization = `token ${token}`;
	return request(endpoint);
}
var VERSION$3 = "0.0.0-development";
function createOAuthDeviceAuth(options) {
	const requestWithDefaults = options.request || request.defaults({ headers: { "user-agent": `octokit-auth-oauth-device.js/${VERSION$3} ${getUserAgent()}` } });
	const { request: request$3 = requestWithDefaults, ...otherOptions } = options;
	const state = options.clientType === "github-app" ? {
		...otherOptions,
		clientType: "github-app",
		request: request$3
	} : {
		...otherOptions,
		clientType: "oauth-app",
		request: request$3,
		scopes: options.scopes || []
	};
	if (!options.clientId) throw new Error("[@octokit/auth-oauth-device] \"clientId\" option must be set (https://github.com/octokit/auth-oauth-device.js#usage)");
	if (!options.onVerification) throw new Error("[@octokit/auth-oauth-device] \"onVerification\" option must be a function (https://github.com/octokit/auth-oauth-device.js#usage)");
	return Object.assign(auth$3.bind(null, state), { hook: hook$3.bind(null, state) });
}
/* v8 ignore next 2 -- @preserve */
//#endregion
//#region node_modules/@octokit/auth-oauth-user/dist-bundle/index.js
var VERSION$2 = "0.0.0-development";
async function getAuthentication(state) {
	if ("code" in state.strategyOptions) {
		const { authentication } = await exchangeWebFlowCode({
			clientId: state.clientId,
			clientSecret: state.clientSecret,
			clientType: state.clientType,
			onTokenCreated: state.onTokenCreated,
			...state.strategyOptions,
			request: state.request
		});
		return {
			type: "token",
			tokenType: "oauth",
			...authentication
		};
	}
	if ("onVerification" in state.strategyOptions) {
		const authentication = await createOAuthDeviceAuth({
			clientType: state.clientType,
			clientId: state.clientId,
			onTokenCreated: state.onTokenCreated,
			...state.strategyOptions,
			request: state.request
		})({ type: "oauth" });
		return {
			clientSecret: state.clientSecret,
			...authentication
		};
	}
	if ("token" in state.strategyOptions) return {
		type: "token",
		tokenType: "oauth",
		clientId: state.clientId,
		clientSecret: state.clientSecret,
		clientType: state.clientType,
		onTokenCreated: state.onTokenCreated,
		...state.strategyOptions
	};
	throw new Error("[@octokit/auth-oauth-user] Invalid strategy options");
}
async function auth$2(state, options = {}) {
	if (!state.authentication) state.authentication = state.clientType === "oauth-app" ? await getAuthentication(state) : await getAuthentication(state);
	if (state.authentication.invalid) throw new Error("[@octokit/auth-oauth-user] Token is invalid");
	const currentAuthentication = state.authentication;
	if ("expiresAt" in currentAuthentication) {
		if (options.type === "refresh" || new Date(currentAuthentication.expiresAt) < /* @__PURE__ */ new Date()) {
			const { authentication } = await refreshToken({
				clientType: "github-app",
				clientId: state.clientId,
				clientSecret: state.clientSecret,
				refreshToken: currentAuthentication.refreshToken,
				request: state.request
			});
			state.authentication = {
				tokenType: "oauth",
				type: "token",
				...authentication
			};
		}
	}
	if (options.type === "refresh") {
		if (state.clientType === "oauth-app") throw new Error("[@octokit/auth-oauth-user] OAuth Apps do not support expiring tokens");
		if (!currentAuthentication.hasOwnProperty("expiresAt")) throw new Error("[@octokit/auth-oauth-user] Refresh token missing");
		await state.onTokenCreated?.(state.authentication, { type: options.type });
	}
	if (options.type === "check" || options.type === "reset") {
		const method = options.type === "check" ? checkToken : resetToken;
		try {
			const { authentication } = await method({
				clientType: state.clientType,
				clientId: state.clientId,
				clientSecret: state.clientSecret,
				token: state.authentication.token,
				request: state.request
			});
			state.authentication = {
				tokenType: "oauth",
				type: "token",
				...authentication
			};
			if (options.type === "reset") await state.onTokenCreated?.(state.authentication, { type: options.type });
			return state.authentication;
		} catch (error) {
			if (error.status === 404) {
				error.message = "[@octokit/auth-oauth-user] Token is invalid";
				state.authentication.invalid = true;
			}
			throw error;
		}
	}
	if (options.type === "delete" || options.type === "deleteAuthorization") {
		const method = options.type === "delete" ? deleteToken : deleteAuthorization;
		try {
			await method({
				clientType: state.clientType,
				clientId: state.clientId,
				clientSecret: state.clientSecret,
				token: state.authentication.token,
				request: state.request
			});
		} catch (error) {
			if (error.status !== 404) throw error;
		}
		state.authentication.invalid = true;
		return state.authentication;
	}
	return state.authentication;
}
var ROUTES_REQUIRING_BASIC_AUTH = /\/applications\/[^/]+\/(token|grant)s?/;
function requiresBasicAuth(url) {
	return url && ROUTES_REQUIRING_BASIC_AUTH.test(url);
}
async function hook$2(state, request, route, parameters = {}) {
	const endpoint = request.endpoint.merge(route, parameters);
	if (/\/login\/(oauth\/access_token|device\/code)$/.test(endpoint.url)) return request(endpoint);
	if (requiresBasicAuth(endpoint.url)) {
		const credentials = btoa(`${state.clientId}:${state.clientSecret}`);
		endpoint.headers.authorization = `basic ${credentials}`;
		return request(endpoint);
	}
	const { token } = state.clientType === "oauth-app" ? await auth$2({
		...state,
		request
	}) : await auth$2({
		...state,
		request
	});
	endpoint.headers.authorization = "token " + token;
	return request(endpoint);
}
function createOAuthUserAuth({ clientId, clientSecret, clientType = "oauth-app", request: request$2 = request.defaults({ headers: { "user-agent": `octokit-auth-oauth-app.js/${VERSION$2} ${getUserAgent()}` } }), onTokenCreated, ...strategyOptions }) {
	const state = Object.assign({
		clientType,
		clientId,
		clientSecret,
		onTokenCreated,
		strategyOptions,
		request: request$2
	});
	return Object.assign(auth$2.bind(null, state), { hook: hook$2.bind(null, state) });
}
createOAuthUserAuth.VERSION = VERSION$2;
/* v8 ignore if -- @preserve */
/* v8 ignore next -- @preserve */
//#endregion
//#region node_modules/@octokit/auth-oauth-app/dist-bundle/index.js
async function auth$1(state, authOptions) {
	if (authOptions.type === "oauth-app") return {
		type: "oauth-app",
		clientId: state.clientId,
		clientSecret: state.clientSecret,
		clientType: state.clientType,
		headers: { authorization: `basic ${btoa(`${state.clientId}:${state.clientSecret}`)}` }
	};
	if ("factory" in authOptions) {
		const { type, ...options } = {
			...authOptions,
			...state
		};
		return authOptions.factory(options);
	}
	const common = {
		clientId: state.clientId,
		clientSecret: state.clientSecret,
		request: state.request,
		...authOptions
	};
	return (state.clientType === "oauth-app" ? await createOAuthUserAuth({
		...common,
		clientType: state.clientType
	}) : await createOAuthUserAuth({
		...common,
		clientType: state.clientType
	}))();
}
async function hook$1(state, request2, route, parameters) {
	let endpoint = request2.endpoint.merge(route, parameters);
	if (/\/login\/(oauth\/access_token|device\/code)$/.test(endpoint.url)) return request2(endpoint);
	if (state.clientType === "github-app" && !requiresBasicAuth(endpoint.url)) throw new Error(`[@octokit/auth-oauth-app] GitHub Apps cannot use their client ID/secret for basic authentication for endpoints other than "/applications/{client_id}/**". "${endpoint.method} ${endpoint.url}" is not supported.`);
	const credentials = btoa(`${state.clientId}:${state.clientSecret}`);
	endpoint.headers.authorization = `basic ${credentials}`;
	try {
		return await request2(endpoint);
	} catch (error) {
		if (error.status !== 401) throw error;
		error.message = `[@octokit/auth-oauth-app] "${endpoint.method} ${endpoint.url}" does not support clientId/clientSecret basic authentication.`;
		throw error;
	}
}
var VERSION$1 = "0.0.0-development";
function createOAuthAppAuth(options) {
	const state = Object.assign({
		request: request.defaults({ headers: { "user-agent": `octokit-auth-oauth-app.js/${VERSION$1} ${getUserAgent()}` } }),
		clientType: "oauth-app"
	}, options);
	return Object.assign(auth$1.bind(null, state), { hook: hook$1.bind(null, state) });
}
/* v8 ignore next -- @preserve */
//#endregion
//#region node_modules/universal-github-app-jwt/lib/utils.js
/**
* @param {string} privateKey
* @returns {boolean}
*/
function isPkcs1(privateKey) {
	return privateKey.includes("-----BEGIN RSA PRIVATE KEY-----");
}
/**
* @param {string} privateKey
* @returns {boolean}
*/
function isOpenSsh(privateKey) {
	return privateKey.includes("-----BEGIN OPENSSH PRIVATE KEY-----");
}
/**
* @param {string} str
* @returns {ArrayBuffer}
*/
function string2ArrayBuffer(str) {
	const buf = new ArrayBuffer(str.length);
	const bufView = new Uint8Array(buf);
	for (let i = 0, strLen = str.length; i < strLen; i++) bufView[i] = str.charCodeAt(i);
	return buf;
}
/**
* @param {string} pem
* @returns {ArrayBuffer}
*/
function getDERfromPEM(pem) {
	const pemB64 = pem.trim().split("\n").slice(1, -1).join("");
	return string2ArrayBuffer(atob(pemB64));
}
/**
* @param {import('../internals').Header} header
* @param {import('../internals').Payload} payload
* @returns {string}
*/
function getEncodedMessage(header, payload) {
	return `${base64encodeJSON(header)}.${base64encodeJSON(payload)}`;
}
/**
* @param {ArrayBuffer} buffer
* @returns {string}
*/
function base64encode(buffer) {
	var binary = "";
	var bytes = new Uint8Array(buffer);
	var len = bytes.byteLength;
	for (var i = 0; i < len; i++) binary += String.fromCharCode(bytes[i]);
	return fromBase64(btoa(binary));
}
/**
* @param {string} base64
* @returns {string}
*/
function fromBase64(base64) {
	return base64.replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_");
}
/**
* @param {Record<string,unknown>} obj
* @returns {string}
*/
function base64encodeJSON(obj) {
	return fromBase64(btoa(JSON.stringify(obj)));
}
//#endregion
//#region node_modules/universal-github-app-jwt/lib/crypto-node.js
function convertPrivateKey(privateKey) {
	if (!isPkcs1(privateKey)) return privateKey;
	return createPrivateKey(privateKey).export({
		type: "pkcs8",
		format: "pem"
	});
}
//#endregion
//#region node_modules/universal-github-app-jwt/lib/get-token.js
/**
* @param {import('../internals').GetTokenOptions} options
* @returns {Promise<string>}
*/
async function getToken({ privateKey, payload }) {
	const convertedPrivateKey = convertPrivateKey(privateKey);
	/* c8 ignore start */
	if (isPkcs1(convertedPrivateKey)) throw new Error("[universal-github-app-jwt] Private Key is in PKCS#1 format, but only PKCS#8 is supported. See https://github.com/gr2m/universal-github-app-jwt#private-key-formats");
	/* c8 ignore stop */
	if (isOpenSsh(convertedPrivateKey)) throw new Error("[universal-github-app-jwt] Private Key is in OpenSSH format, but only PKCS#8 is supported. See https://github.com/gr2m/universal-github-app-jwt#private-key-formats");
	const algorithm = {
		name: "RSASSA-PKCS1-v1_5",
		hash: { name: "SHA-256" }
	};
	/** @type {import('../internals').Header} */
	const header = {
		alg: "RS256",
		typ: "JWT"
	};
	const privateKeyDER = getDERfromPEM(convertedPrivateKey);
	const importedKey = await subtle.importKey("pkcs8", privateKeyDER, algorithm, false, ["sign"]);
	const encodedMessage = getEncodedMessage(header, payload);
	const encodedMessageArrBuf = string2ArrayBuffer(encodedMessage);
	return `${encodedMessage}.${base64encode(await subtle.sign(algorithm.name, importedKey, encodedMessageArrBuf))}`;
}
//#endregion
//#region node_modules/universal-github-app-jwt/index.js
/**
* @param {import(".").Options} options
* @returns {Promise<import(".").Result>}
*/
async function githubAppJwt({ id, privateKey, now = Math.floor(Date.now() / 1e3) }) {
	const privateKeyWithNewlines = privateKey.replace(/\\n/g, "\n");
	const nowWithSafetyMargin = now - 30;
	const expiration = nowWithSafetyMargin + 600;
	return {
		appId: id,
		expiration,
		token: await getToken({
			privateKey: privateKeyWithNewlines,
			payload: {
				iat: nowWithSafetyMargin,
				exp: expiration,
				iss: id
			}
		})
	};
}
//#endregion
//#region node_modules/toad-cache/dist/toad-cache.mjs
/**
* toad-cache
*
* @copyright 2026 Igor Savin <kibertoad@gmail.com>
* @license MIT
* @version 3.7.3
*/
/**
* Validates the shared cache constructor parameters.
* Both values must be non-negative integers.
*
* @param {number} max
* @param {number} ttlInMsecs
*/
function validateCacheParams(max, ttlInMsecs) {
	if (typeof max !== "number" || !Number.isInteger(max) || max < 0) throw new Error("Invalid max value");
	if (typeof ttlInMsecs !== "number" || !Number.isInteger(ttlInMsecs) || ttlInMsecs < 0) throw new Error("Invalid ttl value");
}
var LruObject = class {
	constructor(max = 1e3, ttlInMsecs = 0) {
		validateCacheParams(max, ttlInMsecs);
		this.first = null;
		this.items = Object.create(null);
		this.last = null;
		this.size = 0;
		this.max = max;
		this.ttl = ttlInMsecs;
	}
	bumpLru(item) {
		if (this.last === item) return;
		const last = this.last;
		const next = item.next;
		const prev = item.prev;
		if (this.first === item) this.first = next;
		item.next = null;
		item.prev = last;
		last.next = item;
		if (prev !== null) prev.next = next;
		/* v8 ignore next 3 -- next is always non-null here: the early return above guarantees item !== this.last in a well-formed list */
		if (next !== null) next.prev = prev;
		this.last = item;
	}
	clear() {
		this.items = Object.create(null);
		this.first = null;
		this.last = null;
		this.size = 0;
	}
	delete(key) {
		const item = this.items[key];
		if (item !== void 0) {
			delete this.items[key];
			this.size--;
			if (item.prev !== null) item.prev.next = item.next;
			if (item.next !== null) item.next.prev = item.prev;
			if (this.first === item) this.first = item.next;
			if (this.last === item) this.last = item.prev;
		}
	}
	deleteMany(keys) {
		for (var i = 0; i < keys.length; i++) this.delete(keys[i]);
	}
	evict() {
		if (this.size > 0) {
			const item = this.first;
			delete this.items[item.key];
			if (--this.size === 0) {
				this.first = null;
				this.last = null;
			} else {
				this.first = item.next;
				this.first.prev = null;
			}
		}
	}
	expiresAt(key) {
		const item = this.items[key];
		if (item !== void 0) return item.expiry;
	}
	get(key) {
		const item = this.items[key];
		if (item !== void 0) {
			if (this.ttl > 0 && item.expiry <= Date.now()) {
				this.delete(key);
				return;
			}
			this.bumpLru(item);
			return item.value;
		}
	}
	getMany(keys) {
		const result = new Array(keys.length);
		for (var i = 0; i < keys.length; i++) result[i] = this.get(keys[i]);
		return result;
	}
	keys() {
		return Object.keys(this.items);
	}
	set(key, value) {
		const existing = this.items[key];
		if (existing !== void 0) {
			existing.value = value;
			existing.expiry = this.ttl > 0 ? Date.now() + this.ttl : this.ttl;
			this.bumpLru(existing);
			return;
		}
		if (this.max > 0 && this.size >= this.max) this.evict();
		const item = {
			expiry: this.ttl > 0 ? Date.now() + this.ttl : this.ttl,
			key,
			prev: this.last,
			next: null,
			value
		};
		this.items[key] = item;
		if (++this.size === 1) this.first = item;
		else this.last.next = item;
		this.last = item;
	}
};
//#endregion
//#region node_modules/@octokit/auth-app/dist-node/index.js
async function getAppAuthentication({ appId, privateKey, timeDifference, createJwt }) {
	try {
		if (createJwt) {
			const { jwt, expiresAt } = await createJwt(appId, timeDifference);
			return {
				type: "app",
				token: jwt,
				appId,
				expiresAt
			};
		}
		const authOptions = {
			id: appId,
			privateKey
		};
		if (timeDifference) Object.assign(authOptions, { now: Math.floor(Date.now() / 1e3) + timeDifference });
		const appAuthentication = await githubAppJwt(authOptions);
		return {
			type: "app",
			token: appAuthentication.token,
			appId: appAuthentication.appId,
			expiresAt: (/* @__PURE__ */ new Date(appAuthentication.expiration * 1e3)).toISOString()
		};
	} catch (error) {
		if (privateKey === "-----BEGIN RSA PRIVATE KEY-----") throw new Error("The 'privateKey` option contains only the first line '-----BEGIN RSA PRIVATE KEY-----'. If you are setting it using a `.env` file, make sure it is set on a single line with newlines replaced by '\n'");
		else throw error;
	}
}
function getCache() {
	return new LruObject(15e3, 354e4);
}
async function get(cache, options) {
	const cacheKey = optionsToCacheKey(options);
	const result = await cache.get(cacheKey);
	if (!result) return;
	const [token, createdAt, expiresAt, repositorySelection, permissionsString, singleFileName] = result.split("|");
	return {
		token,
		createdAt,
		expiresAt,
		permissions: options.permissions || permissionsString.split(/,/).reduce((permissions2, string) => {
			if (/!$/.test(string)) permissions2[string.slice(0, -1)] = "write";
			else permissions2[string] = "read";
			return permissions2;
		}, {}),
		repositoryIds: options.repositoryIds,
		repositoryNames: options.repositoryNames,
		singleFileName,
		repositorySelection
	};
}
async function set(cache, options, data) {
	const key = optionsToCacheKey(options);
	const permissionsString = options.permissions ? "" : Object.keys(data.permissions).map((name) => `${name}${data.permissions[name] === "write" ? "!" : ""}`).join(",");
	const value = [
		data.token,
		data.createdAt,
		data.expiresAt,
		data.repositorySelection,
		permissionsString,
		data.singleFileName
	].join("|");
	await cache.set(key, value);
}
function optionsToCacheKey({ installationId, permissions = {}, repositoryIds = [], repositoryNames = [] }) {
	const permissionsString = Object.keys(permissions).sort().map((name) => permissions[name] === "read" ? name : `${name}!`).join(",");
	return [
		installationId,
		repositoryIds.sort().join(","),
		repositoryNames.join(","),
		permissionsString
	].filter(Boolean).join("|");
}
function toTokenAuthentication({ installationId, token, createdAt, expiresAt, repositorySelection, permissions, repositoryIds, repositoryNames, singleFileName }) {
	return Object.assign({
		type: "token",
		tokenType: "installation",
		token,
		installationId,
		permissions,
		createdAt,
		expiresAt,
		repositorySelection
	}, repositoryIds ? { repositoryIds } : null, repositoryNames ? { repositoryNames } : null, singleFileName ? { singleFileName } : null);
}
async function getInstallationAuthentication(state, options, customRequest) {
	const installationId = Number(options.installationId || state.installationId);
	if (!installationId) throw new Error("[@octokit/auth-app] installationId option is required for installation authentication.");
	if (options.factory) {
		const { type, factory, oauthApp, ...factoryAuthOptions } = {
			...state,
			...options
		};
		return factory(factoryAuthOptions);
	}
	const request = customRequest || state.request;
	return getInstallationAuthenticationConcurrently(state, {
		...options,
		installationId
	}, request);
}
var pendingPromises = /* @__PURE__ */ new Map();
function getInstallationAuthenticationConcurrently(state, options, request) {
	const cacheKey = optionsToCacheKey(options);
	if (pendingPromises.has(cacheKey)) return pendingPromises.get(cacheKey);
	const promise = getInstallationAuthenticationImpl(state, options, request).finally(() => pendingPromises.delete(cacheKey));
	pendingPromises.set(cacheKey, promise);
	return promise;
}
async function getInstallationAuthenticationImpl(state, options, request) {
	if (!options.refresh) {
		const result = await get(state.cache, options);
		if (result) {
			const { token: token2, createdAt: createdAt2, expiresAt: expiresAt2, permissions: permissions2, repositoryIds: repositoryIds2, repositoryNames: repositoryNames2, singleFileName: singleFileName2, repositorySelection: repositorySelection2 } = result;
			return toTokenAuthentication({
				installationId: options.installationId,
				token: token2,
				createdAt: createdAt2,
				expiresAt: expiresAt2,
				permissions: permissions2,
				repositorySelection: repositorySelection2,
				repositoryIds: repositoryIds2,
				repositoryNames: repositoryNames2,
				singleFileName: singleFileName2
			});
		}
	}
	const appAuthentication = await getAppAuthentication(state);
	const payload = {
		installation_id: options.installationId,
		mediaType: { previews: ["machine-man"] },
		headers: { authorization: `bearer ${appAuthentication.token}` }
	};
	if (options.repositoryIds) Object.assign(payload, { repository_ids: options.repositoryIds });
	if (options.repositoryNames) Object.assign(payload, { repositories: options.repositoryNames });
	if (options.permissions) Object.assign(payload, { permissions: options.permissions });
	const { data: { token, expires_at: expiresAt, repositories, permissions: permissionsOptional, repository_selection: repositorySelectionOptional, single_file: singleFileName } } = await request("POST /app/installations/{installation_id}/access_tokens", payload);
	const permissions = permissionsOptional || {};
	const repositorySelection = repositorySelectionOptional || "all";
	const repositoryIds = repositories ? repositories.map((r) => r.id) : void 0;
	const repositoryNames = repositories ? repositories.map((repo) => repo.name) : void 0;
	const createdAt = (/* @__PURE__ */ new Date()).toISOString();
	const cacheOptions = {
		token,
		createdAt,
		expiresAt,
		repositorySelection,
		permissions,
		repositoryIds,
		repositoryNames
	};
	if (singleFileName) Object.assign(payload, { singleFileName });
	await set(state.cache, options, cacheOptions);
	const cacheData = {
		installationId: options.installationId,
		token,
		createdAt,
		expiresAt,
		repositorySelection,
		permissions,
		repositoryIds,
		repositoryNames
	};
	if (singleFileName) Object.assign(cacheData, { singleFileName });
	return toTokenAuthentication(cacheData);
}
async function auth(state, authOptions) {
	switch (authOptions.type) {
		case "app": return getAppAuthentication(state);
		case "oauth-app": return state.oauthApp({ type: "oauth-app" });
		case "installation": return getInstallationAuthentication(state, {
			...authOptions,
			type: "installation"
		});
		case "oauth-user": return state.oauthApp(authOptions);
		default: throw new Error(`Invalid auth type: ${authOptions.type}`);
	}
}
var PATHS = [
	"/app",
	"/app/hook/config",
	"/app/hook/deliveries",
	"/app/hook/deliveries/{delivery_id}",
	"/app/hook/deliveries/{delivery_id}/attempts",
	"/app/installations",
	"/app/installations/{installation_id}",
	"/app/installations/{installation_id}/access_tokens",
	"/app/installations/{installation_id}/suspended",
	"/app/installation-requests",
	"/marketplace_listing/accounts/{account_id}",
	"/marketplace_listing/plan",
	"/marketplace_listing/plans",
	"/marketplace_listing/plans/{plan_id}/accounts",
	"/marketplace_listing/stubbed/accounts/{account_id}",
	"/marketplace_listing/stubbed/plan",
	"/marketplace_listing/stubbed/plans",
	"/marketplace_listing/stubbed/plans/{plan_id}/accounts",
	"/orgs/{org}/installation",
	"/repos/{owner}/{repo}/installation",
	"/users/{username}/installation",
	"/enterprises/{enterprise}/installation"
];
function routeMatcher(paths) {
	const regex = `^(?:${paths.map((p) => p.split("/").map((c) => c.startsWith("{") ? "(?:.+?)" : c).join("/")).map((r) => `(?:${r})`).join("|")})$`;
	return new RegExp(regex, "i");
}
var REGEX = routeMatcher(PATHS);
function requiresAppAuth(url) {
	return !!url && REGEX.test(url.split("?")[0]);
}
var FIVE_SECONDS_IN_MS = 5e3;
function isNotTimeSkewError(error) {
	return !(error.message.match(/'Expiration time' claim \('exp'\) is too far in the future/) || error.message.match(/'Expiration time' claim \('exp'\) must be a numeric value representing the future time at which the assertion expires/) || error.message.match(/'Issued at' claim \('iat'\) must be an Integer representing the time that the assertion was issued/));
}
async function hook(state, request, route, parameters) {
	const endpoint = request.endpoint.merge(route, parameters);
	const url = endpoint.url;
	if (/\/login\/oauth\/access_token$/.test(url)) return request(endpoint);
	if (requiresAppAuth(url.replace(request.endpoint.DEFAULTS.baseUrl, ""))) {
		const { token: token2 } = await getAppAuthentication(state);
		endpoint.headers.authorization = `bearer ${token2}`;
		let response;
		try {
			response = await request(endpoint);
		} catch (error) {
			if (isNotTimeSkewError(error)) throw error;
			if (typeof error.response.headers.date === "undefined") throw error;
			const diff = Math.floor((Date.parse(error.response.headers.date) - Date.parse((/* @__PURE__ */ new Date()).toString())) / 1e3);
			state.log.warn(error.message);
			state.log.warn(`[@octokit/auth-app] GitHub API time and system time are different by ${diff} seconds. Retrying request with the difference accounted for.`);
			const { token: token3 } = await getAppAuthentication({
				...state,
				timeDifference: diff
			});
			endpoint.headers.authorization = `bearer ${token3}`;
			return request(endpoint);
		}
		return response;
	}
	if (requiresBasicAuth(url)) {
		const authentication = await state.oauthApp({ type: "oauth-app" });
		endpoint.headers.authorization = authentication.headers.authorization;
		return request(endpoint);
	}
	const { token, createdAt } = await getInstallationAuthentication(state, {}, request.defaults({ baseUrl: endpoint.baseUrl }));
	endpoint.headers.authorization = `token ${token}`;
	return sendRequestWithRetries(state, request, endpoint, createdAt);
}
async function sendRequestWithRetries(state, request, options, createdAt, retries = 0) {
	const timeSinceTokenCreationInMs = +/* @__PURE__ */ new Date() - +new Date(createdAt);
	try {
		return await request(options);
	} catch (error) {
		if (error.status !== 401) throw error;
		if (timeSinceTokenCreationInMs >= FIVE_SECONDS_IN_MS) {
			if (retries > 0) error.message = `After ${retries} retries within ${timeSinceTokenCreationInMs / 1e3}s of creating the installation access token, the response remains 401. At this point, the cause may be an authentication problem or a system outage. Please check https://www.githubstatus.com for status information`;
			throw error;
		}
		++retries;
		const awaitTime = retries * 1e3;
		state.log.warn(`[@octokit/auth-app] Retrying after 401 response to account for token replication delay (retry: ${retries}, wait: ${awaitTime / 1e3}s)`);
		await new Promise((resolve) => setTimeout(resolve, awaitTime));
		return sendRequestWithRetries(state, request, options, createdAt, retries);
	}
}
var VERSION = "8.3.1";
function createAppAuth(options) {
	if (!options.appId) throw new Error("[@octokit/auth-app] appId option is required");
	if (!options.privateKey && !options.createJwt) throw new Error("[@octokit/auth-app] privateKey option is required");
	else if (options.privateKey && options.createJwt) throw new Error("[@octokit/auth-app] privateKey and createJwt options are mutually exclusive");
	if ("installationId" in options && !options.installationId) throw new Error("[@octokit/auth-app] installationId is set to a falsy value");
	const log = options.log || {};
	if (typeof log.warn !== "function") log.warn = console.warn.bind(console);
	const request$1 = options.request || request.defaults({ headers: { "user-agent": `octokit-auth-app.js/${VERSION} ${getUserAgent()}` } });
	const state = Object.assign({
		request: request$1,
		cache: getCache()
	}, options, options.installationId ? { installationId: Number(options.installationId) } : {}, {
		log,
		oauthApp: createOAuthAppAuth({
			clientType: "github-app",
			clientId: options.clientId || "",
			clientSecret: options.clientSecret || "",
			request: request$1
		})
	});
	return Object.assign(auth.bind(null, state), { hook: hook.bind(null, state) });
}
/* v8 ignore next - permissions are optional per OpenAPI spec, but we think that is incorrect -- @preserve */
/* v8 ignore next - repositorySelection are optional per OpenAPI spec, but we think that is incorrect -- @preserve */
/* v8 ignore start - due to skipped tests, see https://github.com/octokit/auth-app.js/pull/580 -- @preserve */
/* v8 ignore end -- @preserve */
//#endregion
export { createAppAuth, request };
