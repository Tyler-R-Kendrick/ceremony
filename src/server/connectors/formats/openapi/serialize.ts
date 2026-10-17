import { destinationUrl, type ApprovedDestination } from "../../binding.js";
import { ConnectorError } from "../../errors.js";
import type { OperationPlan } from "./plan.js";
import {
  validateValue,
  type CompiledSchema,
  type SchemaDefinitions,
} from "./schema.js";
import { isRecord } from "./refs.js";

/*
 * Serialization for the documented subset, and nothing else. Path parameters
 * use style `simple` (RFC 6570 `{var}`); query parameters use style `form`
 * with `explode` deciding whether an array repeats the name or joins with
 * commas; header parameters use style `simple`. Every value is validated
 * against the compiled schema before it is written, every path segment is
 * percent-encoded, and `allowReserved` widens the query encoding only when the
 * source said so. Nothing a caller supplies can become a header name, a URL,
 * an authorization value or a second parameter.
 */

export const RESERVED_REQUEST_HEADERS: ReadonlySet<string> = new Set([
  "host",
  "authorization",
  "cookie",
  "set-cookie",
  "content-length",
  "transfer-encoding",
  "connection",
  "keep-alive",
  "te",
  "trailer",
  "upgrade",
  "proxy-authorization",
  "proxy-authenticate",
  "proxy-connection",
  "expect",
  "via",
  "forwarded",
  "x-forwarded-for",
  "x-forwarded-host",
  "x-forwarded-proto",
]);

/** Input keys that are never parameters: an attempt to route transport control through input. */
export const FORBIDDEN_INPUT_KEYS: ReadonlySet<string> = new Set([
  "__proto__",
  "prototype",
  "constructor",
  "$headers",
  "$url",
  "$method",
  "$query",
  "$body",
  "$auth",
  "$authorization",
  "$destination",
  "$fetch",
  "headers",
  "authorization",
  "url",
]);

export type SerializationFailure = { code: string; path: string };

export class InputRejected extends Error {
  constructor(
    readonly detail: string,
    readonly failures: SerializationFailure[] = [],
  ) {
    super("Input rejected");
    this.name = "InputRejected";
  }
}

const reject = (
  detail: string,
  failures: SerializationFailure[] = [],
): never => {
  throw new InputRejected(detail, failures);
};

/** Reserved and sub-delimiter characters that `form` style keeps when `allowReserved` is set. */
const RESERVED_ALLOWED = /[:/?#[\]@!$&'()*+,;=]/;
/** Carriage return, line feed and NUL, by code point, never written literally. */
const HEADER_FORBIDDEN = new RegExp(
  `[${String.fromCharCode(13)}${String.fromCharCode(10)}${String.fromCharCode(0)}]`,
);

function encodeComponent(value: string, allowReserved: boolean): string {
  if (!allowReserved)
    return encodeURIComponent(value).replace(
      /[!'()*]/g,
      (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`,
    );
  return [...value]
    .map((character) =>
      RESERVED_ALLOWED.test(character)
        ? character
        : encodeURIComponent(character).replace(
            /[!'()*]/g,
            (item) => `%${item.charCodeAt(0).toString(16).toUpperCase()}`,
          ),
    )
    .join("");
}

/** Primitive to its serialized form; null and non-finite numbers are refused, not coerced. */
function primitiveText(value: unknown, name: string): string {
  if (typeof value === "string") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value))
      reject("openapi.parameter-not-primitive", [
        { code: "not-finite", path: name },
      ]);
    return String(value);
  }
  if (typeof value === "boolean") return value ? "true" : "false";
  return reject("openapi.parameter-not-primitive", [
    { code: "not-primitive", path: name },
  ]);
}

export interface SerializedRequest {
  url: URL;
  headers: Record<string, string>;
  body?: string;
}

/**
 * Builds the request for one plan from validated input. The destination is
 * pinned by the caller; this function can only produce a URL inside it,
 * because the path is resolved through `destinationUrl`.
 */
export function serializeRequest(input: {
  plan: OperationPlan;
  destination: ApprovedDestination;
  input: unknown;
  /** Header names the adapter will set itself; a parameter may never collide with one. */
  reservedHeaders?: ReadonlySet<string>;
  maxUrlLength?: number;
}): SerializedRequest {
  const { plan, destination } = input;
  const values = input.input === undefined ? {} : input.input;
  if (!isRecord(values)) reject("openapi.input-not-an-object");
  const record = values as Record<string, unknown>;
  for (const key of Object.keys(record))
    if (FORBIDDEN_INPUT_KEYS.has(key))
      reject("openapi.input-reserved-key", [
        { code: "reserved-key", path: key },
      ]);

  const definitions: SchemaDefinitions = plan.definitions;
  const declared = new Set(plan.parameters.map((parameter) => parameter.name));
  const bodyKey = "body";
  for (const key of Object.keys(record))
    if (!declared.has(key) && !(plan.requestBody && key === bodyKey))
      reject("openapi.input-undeclared-parameter", [
        { code: "undeclared", path: key },
      ]);

  const validate = (value: unknown, schema: CompiledSchema, name: string) => {
    const failures = validateValue(value, schema, definitions);
    if (failures.length)
      reject(
        "openapi.input-schema-rejected",
        failures.map((failure) => ({
          code: failure.code,
          path: `${name}${failure.path}`,
        })),
      );
  };

  const pathValues = new Map<string, string>();
  const query: Array<[string, string]> = [];
  const headers: Record<string, string> = {};
  const reservedHeaders = input.reservedHeaders ?? RESERVED_REQUEST_HEADERS;

  for (const parameter of plan.parameters) {
    const present = Object.hasOwn(record, parameter.name);
    const value = present ? record[parameter.name] : undefined;
    if (!present || value === undefined) {
      if (parameter.required)
        reject("openapi.parameter-required", [
          { code: "required", path: parameter.name },
        ]);
      continue;
    }
    validate(value, parameter.schema, parameter.name);
    if (parameter.in === "path") {
      const text = primitiveText(value, parameter.name);
      if (text.length === 0)
        reject("openapi.path-parameter-empty", [
          { code: "empty", path: parameter.name },
        ]);
      const encoded = encodeComponent(text, false);
      // A `/` inside a path segment has to travel as %2F, and intermediaries
      // disagree about when to decode it, so containment inside the approved
      // prefix cannot be proven. The value is refused with its own code rather
      // than reaching the destination resolver as a generic policy failure.
      if (/%2f/i.test(encoded))
        reject("openapi.path-parameter-encoded-slash", [
          { code: "encoded-slash", path: parameter.name },
        ]);
      pathValues.set(parameter.name, encoded);
      continue;
    }
    if (parameter.in === "header") {
      const lower = parameter.name.toLowerCase();
      if (reservedHeaders.has(lower))
        reject("openapi.header-reserved", [
          { code: "reserved-header", path: parameter.name },
        ]);
      if (Object.hasOwn(headers, lower))
        reject("openapi.header-collision", [
          { code: "collision", path: parameter.name },
        ]);
      const text = Array.isArray(value)
        ? value.map((item) => primitiveText(item, parameter.name)).join(",")
        : primitiveText(value, parameter.name);
      if (HEADER_FORBIDDEN.test(text) || /\p{Cc}/u.test(text))
        reject("openapi.header-value-invalid", [
          { code: "control-character", path: parameter.name },
        ]);
      headers[lower] = text;
      continue;
    }
    // style form
    if (Array.isArray(value)) {
      if (parameter.explode)
        for (const item of value)
          query.push([
            parameter.name,
            encodeComponent(
              primitiveText(item, parameter.name),
              parameter.allowReserved,
            ),
          ]);
      else
        query.push([
          parameter.name,
          value
            .map((item) =>
              encodeComponent(
                primitiveText(item, parameter.name),
                parameter.allowReserved,
              ),
            )
            .join(","),
        ]);
      continue;
    }
    query.push([
      parameter.name,
      encodeComponent(
        primitiveText(value, parameter.name),
        parameter.allowReserved,
      ),
    ]);
  }

  let path = plan.pathTemplate;
  for (const [name, encoded] of pathValues)
    path = path.replaceAll(`{${name}}`, encoded);
  if (/[{}]/.test(path))
    reject("openapi.path-template-unfilled", [
      { code: "unfilled", path: plan.pathTemplate.slice(0, 64) },
    ]);
  let url: URL;
  try {
    url = destinationUrl(destination, path);
  } catch {
    throw new ConnectorError("network-policy", {
      detail: "openapi.destination-escape",
    });
  }
  if (query.length) {
    const search = query
      .map(([name, value]) => `${encodeComponent(name, false)}=${value}`)
      .join("&");
    url.search = `?${search}`;
  }
  if (url.href.length > (input.maxUrlLength ?? 8192))
    reject("openapi.url-too-long", [{ code: "too-long", path: "url" }]);

  let body: string | undefined;
  if (plan.requestBody) {
    const present = Object.hasOwn(record, bodyKey);
    const value = present ? record[bodyKey] : undefined;
    if (!present || value === undefined) {
      if (plan.requestBody.required)
        reject("openapi.body-required", [{ code: "required", path: bodyKey }]);
    } else {
      validate(value, plan.requestBody.schema, bodyKey);
      const text = JSON.stringify(value);
      if (text === undefined)
        reject("openapi.body-not-json", [{ code: "not-json", path: bodyKey }]);
      body = text;
    }
  }
  return { url, headers, ...(body === undefined ? {} : { body }) };
}

/** Whether a response content type declares JSON; parameters are ignored. */
export function responseIsJson(contentType: string | null): boolean {
  if (!contentType) return false;
  const essence = contentType.split(";")[0]!.trim().toLowerCase();
  return (
    essence === "application/json" ||
    /^application\/[a-z0-9!#$&^_.+-]+\+json$/.test(essence)
  );
}

/**
 * Reads at most `limit` bytes of a response body, under `signal` when given
 * (the request's one deadline, request-deadline.ts: when it aborts the body is
 * cancelled and the read rejects). Exceeding the limit is a failure, not a
 * truncation: a truncated JSON document is not the response the operation
 * described. The limit is the operation plan's own (up to what plan.ts allows),
 * a number only a binding's settings know, which is why this reader is not
 * `readBoundedBytes`, whose ceilings are constants the fetch gate can see.
 */
export async function readBoundedBody(
  response: Response,
  limit: number,
  signal?: AbortSignal,
): Promise<{ bytes: Uint8Array; exceeded: boolean }> {
  const over = { bytes: new Uint8Array(0), exceeded: true };
  const declared = response.headers.get("content-length");
  if (
    declared !== null &&
    /^\d{1,20}$/.test(declared) &&
    Number(declared) > limit
  ) {
    await response.body?.cancel().catch(() => {});
    return over;
  }
  const reader = response.body?.getReader();
  if (!reader) return { bytes: new Uint8Array(0), exceeded: false };
  // Cancelling settles a read that is waiting on the provider, so the check
  // after each read is what turns an abort into a rejection.
  const stop = () => void reader.cancel(signal?.reason).catch(() => {});
  signal?.addEventListener("abort", stop, { once: true });
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      signal?.throwIfAborted();
      const { done, value } = await reader.read();
      signal?.throwIfAborted();
      if (done) break;
      size += value.byteLength;
      if (size > limit) {
        await reader.cancel();
        return over;
      }
      chunks.push(value);
    }
  } catch (error) {
    await reader.cancel().catch(() => {});
    throw error;
  } finally {
    signal?.removeEventListener("abort", stop);
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return { bytes, exceeded: false };
}
