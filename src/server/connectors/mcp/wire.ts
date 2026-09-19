import { z } from "zod";
import { JSON_RPC_ERROR_CODES, MODERN_ERROR_CODES } from "./profiles.js";

/*
 * Wire vocabulary for both eras: JSON-RPC envelopes, the result shapes the
 * client consumes, the SSE framing of the Streamable HTTP transport and the
 * header value encoding of the 2026-07-28 revision. Every message a server
 * sends is parsed within bounds and validated here before anything else
 * looks at it; objects are loose (servers add fields) but strings are
 * bounded and reserved object keys are refused.
 */

const RESERVED_KEYS = new Set(["__proto__", "prototype", "constructor"]);

export class WireError extends Error {
  constructor(
    readonly code:
      | "json-too-large"
      | "json-too-deep"
      | "json-invalid"
      | "json-reserved-key"
      | "json-too-many-nodes",
  ) {
    super(code);
    this.name = "WireError";
  }
}

/**
 * Parses JSON text within depth and node bounds and refuses reserved object
 * keys so a server payload can never shape a prototype. The text itself is
 * bounded by the transport before it gets here.
 */
export function parseBoundedJson(
  text: string,
  options: { maxDepth: number; maxNodes?: number },
): unknown {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new WireError("json-invalid");
  }
  const maxNodes = options.maxNodes ?? 200_000;
  let nodes = 0;
  const walk = (node: unknown, depth: number): void => {
    if (++nodes > maxNodes) throw new WireError("json-too-many-nodes");
    if (depth > options.maxDepth) throw new WireError("json-too-deep");
    if (Array.isArray(node)) {
      for (const item of node) walk(item, depth + 1);
      return;
    }
    if (node && typeof node === "object") {
      for (const key of Object.keys(node)) {
        if (RESERVED_KEYS.has(key)) throw new WireError("json-reserved-key");
        walk((node as Record<string, unknown>)[key], depth + 1);
      }
    }
  };
  walk(value, 0);
  return value;
}

export function jsonByteLength(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value) ?? "null", "utf8");
}

/* ---------------------------------------------------------------- JSON-RPC */

export const requestIdSchema = z.union([z.string().max(256), z.number().int()]);
export type RequestId = z.infer<typeof requestIdSchema>;

const boundedString = (max: number) => z.string().max(max);
const anyRecord = z.record(z.string(), z.unknown());

export const jsonRpcErrorSchema = z.looseObject({
  code: z.number().int(),
  message: boundedString(4096),
  data: z.unknown().optional(),
});
export type JsonRpcError = z.infer<typeof jsonRpcErrorSchema>;

export const jsonRpcResultResponseSchema = z.looseObject({
  jsonrpc: z.literal("2.0"),
  id: requestIdSchema,
  result: anyRecord,
});
export const jsonRpcErrorResponseSchema = z.looseObject({
  jsonrpc: z.literal("2.0"),
  id: requestIdSchema.nullable().optional(),
  error: jsonRpcErrorSchema,
});
export const jsonRpcRequestSchema = z.looseObject({
  jsonrpc: z.literal("2.0"),
  id: requestIdSchema,
  method: boundedString(256),
  params: anyRecord.optional(),
});
export const jsonRpcNotificationSchema = z.looseObject({
  jsonrpc: z.literal("2.0"),
  method: boundedString(256),
  params: anyRecord.optional(),
});

export type JsonRpcMessage =
  | { kind: "result"; id: RequestId; result: Record<string, unknown> }
  | { kind: "error"; id: RequestId | null; error: JsonRpcError }
  | {
      kind: "request";
      id: RequestId;
      method: string;
      params: Record<string, unknown> | undefined;
    }
  | {
      kind: "notification";
      method: string;
      params: Record<string, unknown> | undefined;
    }
  | { kind: "invalid" };

/** Classifies one parsed JSON value as a JSON-RPC message; batches are not accepted. */
export function classifyJsonRpc(value: unknown): JsonRpcMessage {
  if (!value || typeof value !== "object" || Array.isArray(value))
    return { kind: "invalid" };
  const record = value as Record<string, unknown>;
  if ("result" in record && "id" in record) {
    const parsed = jsonRpcResultResponseSchema.safeParse(record);
    return parsed.success
      ? { kind: "result", id: parsed.data.id, result: parsed.data.result }
      : { kind: "invalid" };
  }
  if ("error" in record) {
    const parsed = jsonRpcErrorResponseSchema.safeParse(record);
    return parsed.success
      ? { kind: "error", id: parsed.data.id ?? null, error: parsed.data.error }
      : { kind: "invalid" };
  }
  if ("method" in record) {
    if ("id" in record && record.id !== null && record.id !== undefined) {
      const parsed = jsonRpcRequestSchema.safeParse(record);
      return parsed.success
        ? {
            kind: "request",
            id: parsed.data.id,
            method: parsed.data.method,
            params: parsed.data.params,
          }
        : { kind: "invalid" };
    }
    const parsed = jsonRpcNotificationSchema.safeParse(record);
    return parsed.success
      ? {
          kind: "notification",
          method: parsed.data.method,
          params: parsed.data.params,
        }
      : { kind: "invalid" };
  }
  return { kind: "invalid" };
}

/** A JSON-RPC error a 2026-07-28 server emits; anything else on a 4xx marks a legacy server. */
export function isRecognizedModernError(error: JsonRpcError): boolean {
  return (
    error.code === MODERN_ERROR_CODES.headerMismatch ||
    error.code === MODERN_ERROR_CODES.missingRequiredClientCapability ||
    error.code === MODERN_ERROR_CODES.unsupportedProtocolVersion ||
    error.code === JSON_RPC_ERROR_CODES.methodNotFound
  );
}

export const unsupportedVersionDataSchema = z.looseObject({
  supported: z.array(boundedString(64)).max(32).optional(),
  requested: boundedString(64).optional(),
});

/* ------------------------------------------------------------- MCP results */

export const implementationSchema = z.looseObject({
  name: boundedString(256),
  version: boundedString(128),
  title: boundedString(256).optional(),
});
export type Implementation = z.infer<typeof implementationSchema>;

const capabilityObject = z.record(z.string().max(120), z.unknown());
export const serverCapabilitiesSchema = z.looseObject({
  tools: capabilityObject.optional(),
  resources: capabilityObject.optional(),
  prompts: capabilityObject.optional(),
  logging: capabilityObject.optional(),
  completions: capabilityObject.optional(),
  experimental: capabilityObject.optional(),
  extensions: z.record(z.string().max(120), capabilityObject).optional(),
  tasks: capabilityObject.optional(),
});
export type ServerCapabilities = z.infer<typeof serverCapabilitiesSchema>;

export const cacheScopeSchema = z.enum(["public", "private"]);
const cacheableFields = {
  ttlMs: z.number().optional(),
  cacheScope: cacheScopeSchema.optional(),
};

export const resultTypeSchema = z.enum(["complete", "input_required"]);

export const discoverResultSchema = z.looseObject({
  resultType: z.string().optional(),
  supportedVersions: z.array(boundedString(64)).max(32),
  capabilities: serverCapabilitiesSchema,
  instructions: boundedString(16_384).optional(),
  _meta: anyRecord.optional(),
  ...cacheableFields,
});

export const initializeResultSchema = z.looseObject({
  protocolVersion: boundedString(64),
  capabilities: serverCapabilitiesSchema,
  serverInfo: implementationSchema,
  instructions: boundedString(16_384).optional(),
});

export const annotationsSchema = anyRecord;

export const toolSchema = z.looseObject({
  name: boundedString(512),
  title: boundedString(512).optional(),
  description: boundedString(16_384).optional(),
  inputSchema: anyRecord,
  outputSchema: anyRecord.optional(),
  annotations: annotationsSchema.optional(),
  icons: z.array(anyRecord).max(16).optional(),
  _meta: anyRecord.optional(),
});
export type ToolDefinition = z.infer<typeof toolSchema>;

export const listToolsResultSchema = z.looseObject({
  resultType: z.string().optional(),
  tools: z.array(z.unknown()),
  nextCursor: z.string().optional(),
  _meta: anyRecord.optional(),
  ...cacheableFields,
});

export const resourceSchema = z.looseObject({
  uri: boundedString(2048),
  name: boundedString(512),
  title: boundedString(512).optional(),
  description: boundedString(16_384).optional(),
  mimeType: boundedString(256).optional(),
  size: z.number().optional(),
  annotations: annotationsSchema.optional(),
  icons: z.array(anyRecord).max(16).optional(),
  _meta: anyRecord.optional(),
});
export type ResourceDefinition = z.infer<typeof resourceSchema>;

export const resourceTemplateSchema = z.looseObject({
  uriTemplate: boundedString(2048),
  name: boundedString(512),
  title: boundedString(512).optional(),
  description: boundedString(16_384).optional(),
  mimeType: boundedString(256).optional(),
  annotations: annotationsSchema.optional(),
  _meta: anyRecord.optional(),
});
export type ResourceTemplateDefinition = z.infer<typeof resourceTemplateSchema>;

export const listResourcesResultSchema = z.looseObject({
  resultType: z.string().optional(),
  resources: z.array(z.unknown()),
  nextCursor: z.string().optional(),
  _meta: anyRecord.optional(),
  ...cacheableFields,
});
export const listResourceTemplatesResultSchema = z.looseObject({
  resultType: z.string().optional(),
  resourceTemplates: z.array(z.unknown()),
  nextCursor: z.string().optional(),
  _meta: anyRecord.optional(),
  ...cacheableFields,
});

export const resourceContentsSchema = z.looseObject({
  uri: boundedString(2048),
  mimeType: boundedString(256).optional(),
  text: z.string().optional(),
  blob: z.string().optional(),
  _meta: anyRecord.optional(),
});
export type ResourceContents = z.infer<typeof resourceContentsSchema>;

export const readResourceResultSchema = z.looseObject({
  resultType: z.string().optional(),
  contents: z.array(z.unknown()),
  _meta: anyRecord.optional(),
  ...cacheableFields,
});

export const promptArgumentSchema = z.looseObject({
  name: boundedString(256),
  description: boundedString(4096).optional(),
  required: z.boolean().optional(),
});
export const promptSchema = z.looseObject({
  name: boundedString(512),
  title: boundedString(512).optional(),
  description: boundedString(16_384).optional(),
  arguments: z.array(promptArgumentSchema).max(64).optional(),
  icons: z.array(anyRecord).max(16).optional(),
  _meta: anyRecord.optional(),
});
export type PromptDefinition = z.infer<typeof promptSchema>;

export const listPromptsResultSchema = z.looseObject({
  resultType: z.string().optional(),
  prompts: z.array(z.unknown()),
  nextCursor: z.string().optional(),
  _meta: anyRecord.optional(),
  ...cacheableFields,
});

/** Content blocks are kept by type; unknown types are preserved as opaque records. */
export const contentBlockSchema = z.looseObject({
  type: boundedString(64),
  text: z.string().optional(),
  data: z.string().optional(),
  mimeType: boundedString(256).optional(),
  uri: boundedString(2048).optional(),
  name: boundedString(512).optional(),
  resource: anyRecord.optional(),
  annotations: annotationsSchema.optional(),
  _meta: anyRecord.optional(),
});
export type ContentBlock = z.infer<typeof contentBlockSchema>;

export const promptMessageSchema = z.looseObject({
  role: boundedString(32),
  content: z.unknown(),
});

export const getPromptResultSchema = z.looseObject({
  resultType: z.string().optional(),
  description: boundedString(16_384).optional(),
  messages: z.array(z.unknown()),
  _meta: anyRecord.optional(),
});

export const callToolResultSchema = z.looseObject({
  resultType: z.string().optional(),
  content: z.array(z.unknown()).optional(),
  structuredContent: z.unknown().optional(),
  isError: z.boolean().optional(),
  _meta: anyRecord.optional(),
});

/** One entry of `inputRequests`: the request the server would have sent. */
export const inputRequestSchema = z.looseObject({
  method: boundedString(256),
  params: anyRecord.optional(),
});
export const inputRequiredResultSchema = z.looseObject({
  resultType: z.literal("input_required"),
  inputRequests: z
    .record(z.string().max(256), inputRequestSchema)
    .refine((value) => Object.keys(value).length <= 16)
    .optional(),
  requestState: z.string().optional(),
  _meta: anyRecord.optional(),
});
export type InputRequiredResult = z.infer<typeof inputRequiredResultSchema>;

/** `elicitation/create` parameters shared by both eras (mode omitted means form). */
export const elicitationParamsSchema = z.looseObject({
  mode: z.enum(["form", "url"]).optional(),
  message: boundedString(4096),
  requestedSchema: anyRecord.optional(),
  url: boundedString(2048).optional(),
  elicitationId: boundedString(256).optional(),
});
export type ElicitationParams = z.infer<typeof elicitationParamsSchema>;

export const elicitationResultSchema = z.strictObject({
  action: z.enum(["accept", "decline", "cancel"]),
  content: z.record(z.string(), z.unknown()).optional(),
});
export type ElicitationResult = z.infer<typeof elicitationResultSchema>;

/* -------------------------------------------------------- header encoding */

const HEADER_SAFE = /^[\x21-\x7e][\x20-\x7e]*$/;
const SENTINEL_START = "=?base64?";
const SENTINEL_END = "?=";

/**
 * Value encoding for `Mcp-Name` and `Mcp-Param-*` (streamable-http#value-encoding):
 * plain when the value is visible ASCII without leading/trailing whitespace,
 * otherwise the Base64 sentinel form; a plain value that already looks like
 * the sentinel is encoded too so it cannot be mistaken for one.
 */
export function encodeMcpHeaderValue(value: string): string {
  const plainSafe =
    HEADER_SAFE.test(value) &&
    !/\s$/.test(value) &&
    !(value.startsWith(SENTINEL_START) && value.endsWith(SENTINEL_END));
  if (plainSafe) return value;
  return `${SENTINEL_START}${Buffer.from(value, "utf8").toString("base64")}${SENTINEL_END}`;
}

export function decodeMcpHeaderValue(value: string): string {
  if (value.startsWith(SENTINEL_START) && value.endsWith(SENTINEL_END))
    return Buffer.from(
      value.slice(SENTINEL_START.length, -SENTINEL_END.length),
      "base64",
    ).toString("utf8");
  return value;
}

/** RFC 9110 token syntax (`1*tchar`) for `x-mcp-header` names. */
export const HTTP_TOKEN = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;

/**
 * Finds `x-mcp-header` annotations statically reachable through `properties`
 * chains only, and reports whether the definition violates the constraints
 * (streamable-http#schema-extension). A violation excludes the whole tool.
 */
export function collectHeaderParameters(
  inputSchema: Record<string, unknown>,
  maxDepth = 8,
):
  | { ok: true; parameters: Array<{ path: string[]; header: string }> }
  | { ok: false; reason: string } {
  const parameters: Array<{ path: string[]; header: string }> = [];
  const seen = new Set<string>();
  let violation: string | undefined;
  const visit = (schema: unknown, path: string[], depth: number): void => {
    if (violation || !schema || typeof schema !== "object") return;
    const record = schema as Record<string, unknown>;
    const header = record["x-mcp-header"];
    if (header !== undefined) {
      if (path.length === 0) {
        violation = "annotation-on-root";
        return;
      }
      if (typeof header !== "string" || header === "") {
        violation = "empty-or-non-string";
        return;
      }
      if (!HTTP_TOKEN.test(header)) {
        violation = "invalid-token";
        return;
      }
      const type = record.type;
      if (type !== "string" && type !== "integer" && type !== "boolean") {
        violation = "non-primitive-type";
        return;
      }
      const lower = header.toLowerCase();
      if (seen.has(lower)) {
        violation = "duplicate-name";
        return;
      }
      seen.add(lower);
      parameters.push({ path, header });
    }
    // Annotations under array, composition, conditional or reference keywords
    // are not statically reachable; their presence invalidates the definition.
    for (const keyword of [
      "items",
      "prefixItems",
      "oneOf",
      "anyOf",
      "allOf",
      "not",
      "if",
      "then",
      "else",
      "$ref",
      "$defs",
      "definitions",
      "additionalProperties",
      "patternProperties",
    ])
      if (
        record[keyword] !== undefined &&
        containsHeaderAnnotation(record[keyword], maxDepth)
      ) {
        violation = "annotation-not-statically-reachable";
        return;
      }
    if (depth >= maxDepth) return;
    const properties = record.properties;
    if (properties && typeof properties === "object")
      for (const [name, child] of Object.entries(
        properties as Record<string, unknown>,
      ))
        visit(child, [...path, name], depth + 1);
  };
  visit(inputSchema, [], 0);
  return violation
    ? { ok: false, reason: violation }
    : { ok: true, parameters };
}

function containsHeaderAnnotation(value: unknown, maxDepth: number): boolean {
  const stack: Array<{ node: unknown; depth: number }> = [
    { node: value, depth: 0 },
  ];
  while (stack.length) {
    const { node, depth } = stack.pop()!;
    if (!node || typeof node !== "object" || depth > maxDepth) continue;
    if (Array.isArray(node)) {
      for (const item of node) stack.push({ node: item, depth: depth + 1 });
      continue;
    }
    const record = node as Record<string, unknown>;
    if ("x-mcp-header" in record) return true;
    for (const child of Object.values(record))
      stack.push({ node: child, depth: depth + 1 });
  }
  return false;
}

/* ------------------------------------------------------------------- SSE */

export type SseFrame = {
  event?: string;
  data: string;
  id?: string;
  retry?: number;
};

/**
 * Incremental Server-Sent Events parser. Comment lines are ignored, `data`
 * lines are joined with newlines, a blank line dispatches. CRLF, LF and a
 * bare CR all end a line, so a CR arriving as the last byte of a chunk is not
 * yet decidable and its line waits for the next chunk; `push` returning
 * nothing therefore means only that nothing is certain yet, never that a byte
 * was dropped. The caller bounds frames and bytes; the parser only reports
 * what it consumed.
 */
export class SseParser {
  private buffer = "";
  private readonly decoder = new TextDecoder("utf-8");
  private pending: {
    event?: string;
    data: string[];
    id?: string;
    retry?: number;
  } = { data: [] };
  bytes = 0;

  push(chunk: Uint8Array): SseFrame[] {
    this.bytes += chunk.byteLength;
    this.buffer += this.decoder.decode(chunk, { stream: true });
    return this.drain(false);
  }

  finish(): SseFrame[] {
    this.buffer += this.decoder.decode();
    return this.drain(true);
  }

  private drain(final: boolean): SseFrame[] {
    const frames: SseFrame[] = [];
    for (;;) {
      const index = this.buffer.search(/\r\n|\n|\r/);
      if (index === -1) break;
      const separator = this.buffer.slice(index, index + 2);
      // A CR that is the last character we hold is ambiguous, because the next
      // chunk may open with the LF that completes a CRLF: a slice of the TCP
      // stream can fall anywhere, including between those two bytes. Believing
      // it now would end the line here and then read that LF as a blank line,
      // which dispatches the half-written frame and leaves the rest to be
      // dispatched as a second one; downstream neither half parses as JSON and
      // an answered call looks dropped. So hold the CR and its line back until
      // a byte arrives to decide it. Only the end of the stream decides it the
      // other way, and `final` covers that: there the CR is the bare-CR
      // terminator the spec allows and the line is delivered, so waiting here
      // can never lose data. Held-back bytes stay in the buffer they were
      // already counted into, so the caller's ceilings are unaffected: this
      // withholds at most the one CR beyond what an unterminated line already
      // withheld.
      if (separator === "\r" && !final) break;
      const line = this.buffer.slice(0, index);
      this.buffer = this.buffer.slice(index + (separator === "\r\n" ? 2 : 1));
      const frame = this.line(line);
      if (frame) frames.push(frame);
    }
    if (final) {
      // A server that closes without the final blank line still meant to send
      // what it wrote; a truncated frame fails to parse as JSON anyway.
      if (this.buffer.length) {
        const frame = this.line(this.buffer);
        this.buffer = "";
        if (frame) frames.push(frame);
      }
      const last = this.dispatch();
      if (last) frames.push(last);
    }
    return frames;
  }

  private line(line: string): SseFrame | undefined {
    if (line === "") return this.dispatch();
    if (line.startsWith(":")) return undefined;
    const colon = line.indexOf(":");
    const field = colon === -1 ? line : line.slice(0, colon);
    let value = colon === -1 ? "" : line.slice(colon + 1);
    if (value.startsWith(" ")) value = value.slice(1);
    switch (field) {
      case "data":
        this.pending.data.push(value);
        break;
      case "event":
        this.pending.event = value;
        break;
      case "id":
        if (!value.includes(String.fromCharCode(0))) this.pending.id = value;
        break;
      case "retry":
        if (/^\d{1,9}$/.test(value)) this.pending.retry = Number(value);
        break;
      default:
        break;
    }
    return undefined;
  }

  private dispatch(): SseFrame | undefined {
    const { event, data, id, retry } = this.pending;
    this.pending = { data: [] };
    if (!data.length) return undefined;
    return {
      data: data.join("\n"),
      ...(event !== undefined ? { event } : {}),
      ...(id !== undefined ? { id } : {}),
      ...(retry !== undefined ? { retry } : {}),
    };
  }
}

/** Visible ASCII only (0x21-0x7E), per the legacy session id rules. */
export const SESSION_ID = /^[\x21-\x7e]{1,512}$/;
