import { createHash } from "node:crypto";
import { z } from "zod";
import { canonicalConnectorJson } from "../../../core/connectors/index.js";
import { presentationUrlSchema } from "../../../core/connectors/projections.js";
import type { HandoffProposal } from "../adapter.js";
import type { HandoffRecord } from "../ports.js";
import { ConnectorError } from "../errors.js";
import type { McpLimits, McpProfileId } from "./profiles.js";
import {
  elicitationParamsSchema,
  jsonByteLength,
  type ElicitationParams,
  type ElicitationResult,
  type InputRequiredResult,
} from "./wire.js";

/*
 * Human input requested by a server mid-operation. Both eras end up in the
 * same place: a suspended, private, one-use handoff that names what was
 * asked, which operation asked and which command it belongs to. The answers
 * a person gives go back to the server on the retried request and nowhere
 * else: never into the invoke result, a projection, a digest in clear or a
 * cache key.
 */

export type InputRequestKind =
  "elicitation-form" | "elicitation-url" | "roots" | "sampling";

export type ParsedInputRequest = {
  id: string;
  kind: InputRequestKind;
  method: string;
  elicitation?: ElicitationParams;
};

/** Reads `inputRequests` and classifies each entry; unknown methods are refused. */
export function parseInputRequests(result: InputRequiredResult): {
  requests: ParsedInputRequest[];
  unknown: string[];
} {
  const requests: ParsedInputRequest[] = [];
  const unknown: string[] = [];
  for (const [id, request] of Object.entries(result.inputRequests ?? {})) {
    if (request.method === "elicitation/create") {
      const params = elicitationParamsSchema.safeParse(request.params ?? {});
      if (!params.success) {
        unknown.push(id);
        continue;
      }
      const mode = params.data.mode ?? "form";
      requests.push({
        id,
        kind: mode === "url" ? "elicitation-url" : "elicitation-form",
        method: request.method,
        elicitation: params.data,
      });
    } else if (request.method === "roots/list")
      requests.push({ id, kind: "roots", method: request.method });
    else if (request.method === "sampling/createMessage")
      requests.push({ id, kind: "sampling", method: request.method });
    else unknown.push(id);
  }
  return { requests, unknown };
}

/* ------------------------------------------------------- form schemas */

const enumValue = z.union([z.string().max(512), z.number(), z.boolean()]);
const titledConst = z.looseObject({
  const: enumValue,
  title: z.string().max(256).optional(),
});

const stringProperty = z.looseObject({
  type: z.literal("string"),
  title: z.string().max(256).optional(),
  description: z.string().max(2048).optional(),
  minLength: z.number().int().min(0).optional(),
  maxLength: z.number().int().min(0).optional(),
  format: z.enum(["email", "uri", "date", "date-time"]).optional(),
  enum: z.array(z.string().max(512)).max(256).optional(),
  oneOf: z.array(titledConst).max(256).optional(),
  default: z.unknown().optional(),
});
const numberProperty = z.looseObject({
  type: z.enum(["number", "integer"]),
  title: z.string().max(256).optional(),
  description: z.string().max(2048).optional(),
  minimum: z.number().optional(),
  maximum: z.number().optional(),
  default: z.unknown().optional(),
});
const booleanProperty = z.looseObject({
  type: z.literal("boolean"),
  title: z.string().max(256).optional(),
  description: z.string().max(2048).optional(),
  default: z.unknown().optional(),
});
const arrayProperty = z.looseObject({
  type: z.literal("array"),
  title: z.string().max(256).optional(),
  description: z.string().max(2048).optional(),
  minItems: z.number().int().min(0).optional(),
  maxItems: z.number().int().min(0).optional(),
  items: z.union([
    z.looseObject({
      type: z.literal("string"),
      enum: z.array(z.string().max(512)).max(256),
    }),
    z.looseObject({ anyOf: z.array(titledConst).max(256) }),
  ]),
  default: z.unknown().optional(),
});
export const formPropertySchema = z.union([
  stringProperty,
  numberProperty,
  booleanProperty,
  arrayProperty,
]);
export type FormProperty = z.infer<typeof formPropertySchema>;

/** The flat, primitive-only object schema form-mode elicitation permits. */
export const formSchemaSchema = z.looseObject({
  type: z.literal("object"),
  properties: z
    .record(z.string().min(1).max(120), formPropertySchema)
    .refine((value) => Object.keys(value).length <= 32, "too many fields")
    .refine(
      (value) =>
        !["__proto__", "prototype", "constructor"].some((key) =>
          Object.hasOwn(value, key),
        ),
      "reserved key",
    ),
  required: z.array(z.string().max(120)).max(32).optional(),
});
export type FormSchema = z.infer<typeof formSchemaSchema>;

export type FormValues = Record<string, unknown>;

type ValueCheck = { ok: true; value: unknown } | { ok: false; reason: string };

function coerce(property: FormProperty, raw: unknown): ValueCheck {
  switch (property.type) {
    case "string": {
      if (typeof raw !== "string") return { ok: false, reason: "type" };
      if (/\p{Cc}/u.test(raw.replace(/[\n\r\t]/g, "")))
        return { ok: false, reason: "control-characters" };
      if (property.minLength !== undefined && raw.length < property.minLength)
        return { ok: false, reason: "min-length" };
      if (property.maxLength !== undefined && raw.length > property.maxLength)
        return { ok: false, reason: "max-length" };
      if (raw.length > 4096) return { ok: false, reason: "max-length" };
      if (property.enum && !property.enum.includes(raw))
        return { ok: false, reason: "enum" };
      if (property.oneOf && !property.oneOf.some((item) => item.const === raw))
        return { ok: false, reason: "enum" };
      if (property.format === "email" && !/^[^\s@]+@[^\s@]+$/.test(raw))
        return { ok: false, reason: "format" };
      if (property.format === "uri" && !URL.canParse(raw))
        return { ok: false, reason: "format" };
      if (property.format === "date" && !/^\d{4}-\d{2}-\d{2}$/.test(raw))
        return { ok: false, reason: "format" };
      if (property.format === "date-time" && Number.isNaN(Date.parse(raw)))
        return { ok: false, reason: "format" };
      return { ok: true, value: raw };
    }
    case "number":
    case "integer": {
      const value =
        typeof raw === "number"
          ? raw
          : typeof raw === "string" && /^-?\d+(\.\d+)?$/.test(raw.trim())
            ? Number(raw)
            : NaN;
      if (!Number.isFinite(value)) return { ok: false, reason: "type" };
      if (property.type === "integer" && !Number.isInteger(value))
        return { ok: false, reason: "integer" };
      if (property.minimum !== undefined && value < property.minimum)
        return { ok: false, reason: "minimum" };
      if (property.maximum !== undefined && value > property.maximum)
        return { ok: false, reason: "maximum" };
      return { ok: true, value };
    }
    case "boolean": {
      if (typeof raw === "boolean") return { ok: true, value: raw };
      if (raw === "true") return { ok: true, value: true };
      if (raw === "false") return { ok: true, value: false };
      return { ok: false, reason: "type" };
    }
    case "array": {
      const list = Array.isArray(raw)
        ? raw
        : typeof raw === "string"
          ? raw
              .split(",")
              .map((item) => item.trim())
              .filter(Boolean)
          : undefined;
      if (!list || list.length > 256) return { ok: false, reason: "type" };
      if (property.minItems !== undefined && list.length < property.minItems)
        return { ok: false, reason: "min-items" };
      if (property.maxItems !== undefined && list.length > property.maxItems)
        return { ok: false, reason: "max-items" };
      const items = property.items as {
        enum?: unknown[];
        anyOf?: Array<{ const: unknown }>;
      };
      const allowed: unknown[] = Array.isArray(items.enum)
        ? items.enum
        : (items.anyOf ?? []).map((item) => item.const);
      for (const item of list)
        if (!allowed.includes(item)) return { ok: false, reason: "enum" };
      return { ok: true, value: list };
    }
  }
}

/**
 * Validates a person's answers against the requested form schema. Unknown
 * fields are refused rather than forwarded, required fields must be present,
 * and string inputs are coerced to the primitive the schema names, because
 * the private input surface delivers strings.
 */
export function validateFormValues(
  schema: FormSchema,
  values: FormValues,
):
  { ok: true; content: Record<string, unknown> } | { ok: false; code: string } {
  const content: Record<string, unknown> = {};
  for (const name of Object.keys(values))
    if (!Object.hasOwn(schema.properties, name))
      return { ok: false, code: `unknown-field:${name.slice(0, 40)}` };
  for (const [name, property] of Object.entries(schema.properties)) {
    const raw = values[name];
    if (raw === undefined || raw === "") {
      if (schema.required?.includes(name))
        return { ok: false, code: `required:${name.slice(0, 40)}` };
      continue;
    }
    const checked = coerce(property, raw);
    if (!checked.ok)
      return { ok: false, code: `${checked.reason}:${name.slice(0, 40)}` };
    content[name] = checked.value;
  }
  return { ok: true, content };
}

/* ------------------------------------------------------- suspended input */

/**
 * Everything a resume needs, kept in `HandoffIssue.private` as strings. The
 * original arguments travel here too: the retried request must be the same
 * request plus the answers.
 */
export type SuspendedInput = {
  protocol: "mcp";
  profile: McpProfileId;
  mode: "input-required" | "legacy-elicitation";
  operationRef: string;
  bindingRevision: number;
  commandId: string;
  destination: string;
  /** Canonical JSON of the original arguments/input. */
  input: string;
  inputDigest: string;
  /** JSON of the parsed input requests (method, params) by server id. */
  inputRequests: string;
  requestState?: string;
  round: number;
  effectRef?: string;
  /** Legacy: digest of the elicitation the server sent, to recognize the repeat. */
  elicitationDigest?: string;
  url?: string;
};

export function elicitationDigest(params: ElicitationParams): string {
  return createHash("sha256")
    .update(
      canonicalConnectorJson({
        mode: params.mode ?? "form",
        message: params.message,
        requestedSchema: params.requestedSchema ?? null,
        url: params.url ?? null,
      }),
    )
    .digest("hex");
}

export function inputDigest(value: unknown): string {
  return createHash("sha256")
    .update(canonicalConnectorJson(value ?? null))
    .digest("hex");
}

export function buildInputHandoff(
  suspended: SuspendedInput,
  options: {
    requests: ParsedInputRequest[];
    now: number;
    expiresInMs: number;
    limits: Pick<McpLimits, "maxHandoffPrivateBytes" | "maxRequestStateBytes">;
  },
): HandoffProposal {
  const urlRequest = options.requests.find(
    (request) => request.kind === "elicitation-url",
  );
  const privateMaterial: Record<string, string> = {
    protocol: suspended.protocol,
    profile: suspended.profile,
    mode: suspended.mode,
    operationRef: suspended.operationRef,
    bindingRevision: String(suspended.bindingRevision),
    commandId: suspended.commandId,
    destination: suspended.destination,
    input: suspended.input,
    inputDigest: suspended.inputDigest,
    inputRequests: suspended.inputRequests,
    round: String(suspended.round),
    ...(suspended.requestState !== undefined
      ? { requestState: suspended.requestState }
      : {}),
    ...(suspended.effectRef ? { effectRef: suspended.effectRef } : {}),
    ...(suspended.elicitationDigest
      ? { elicitationDigest: suspended.elicitationDigest }
      : {}),
  };
  if (urlRequest?.elicitation?.url) {
    // A server-suggested URL is shown to the initiating human only, after
    // validation, and is never fetched by this client.
    const parsed = presentationUrlSchema.safeParse(urlRequest.elicitation.url);
    if (!parsed.success)
      throw new ConnectorError("upstream-rejected", {
        detail: "mcp.elicitation.url-rejected",
      });
    privateMaterial.url = parsed.data;
  }
  const message = options.requests
    .map((request) => request.elicitation?.message ?? "")
    .filter(Boolean)
    .join(" ")
    .replace(/\p{Cc}/gu, " ")
    .slice(0, 500);
  if (message) privateMaterial.message = message;
  if (
    suspended.requestState !== undefined &&
    Buffer.byteLength(suspended.requestState, "utf8") >
      options.limits.maxRequestStateBytes
  )
    throw new ConnectorError("upstream-rejected", {
      detail: "mcp.input-required.state-too-large",
    });
  if (jsonByteLength(privateMaterial) > options.limits.maxHandoffPrivateBytes)
    throw new ConnectorError("upstream-rejected", {
      detail: "mcp.input-required.too-large",
    });
  return {
    kind: urlRequest ? "provider-browser" : "input-required",
    presentation: urlRequest ? "popup" : "in-app",
    expiresAt: options.now + options.expiresInMs,
    intent: "mcp.input-required",
    private: privateMaterial,
  };
}

const suspendedSchema = z.strictObject({
  protocol: z.literal("mcp"),
  profile: z.enum(["2026-07-28", "2025-11-25", "2025-06-18"]),
  mode: z.enum(["input-required", "legacy-elicitation"]),
  operationRef: z.string().min(1).max(200),
  bindingRevision: z.string().regex(/^\d{1,9}$/),
  commandId: z.string().min(1).max(200),
  destination: z.string().max(2048),
  input: z.string().max(64 * 1024),
  inputDigest: z.string().regex(/^[a-f0-9]{64}$/),
  inputRequests: z.string().max(64 * 1024),
  round: z.string().regex(/^\d{1,2}$/),
  requestState: z
    .string()
    .max(64 * 1024)
    .optional(),
  effectRef: z.string().max(200).optional(),
  elicitationDigest: z
    .string()
    .regex(/^[a-f0-9]{64}$/)
    .optional(),
  url: z.string().max(2048).optional(),
  message: z.string().max(500).optional(),
});

/** Reads the suspended input back out of a handoff record; anything foreign is refused. */
export function readSuspendedInput(record: HandoffRecord): SuspendedInput {
  const parsed = suspendedSchema.safeParse(record.private);
  if (!parsed.success)
    throw new ConnectorError("invalid-request", {
      detail: "mcp.handoff.not-mcp-input",
    });
  const value = parsed.data;
  return {
    protocol: "mcp",
    profile: value.profile,
    mode: value.mode,
    operationRef: value.operationRef,
    bindingRevision: Number(value.bindingRevision),
    commandId: value.commandId,
    destination: value.destination,
    input: value.input,
    inputDigest: value.inputDigest,
    inputRequests: value.inputRequests,
    round: Number(value.round),
    ...(value.requestState !== undefined
      ? { requestState: value.requestState }
      : {}),
    ...(value.effectRef ? { effectRef: value.effectRef } : {}),
    ...(value.elicitationDigest
      ? { elicitationDigest: value.elicitationDigest }
      : {}),
    ...(value.url ? { url: value.url } : {}),
  };
}

export type ResumeAction = "accept" | "decline" | "cancel";

/** A bounded, alphabet-safe error detail; the field name is reduced to a token. */
export function inputErrorDetail(code: string): string {
  const token = code
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .split("-")
    .filter(Boolean)
    .slice(0, 6)
    .join("-");
  return `mcp.input.${token || "invalid"}`.slice(0, 120);
}

/**
 * Builds the `inputResponses` for a retry from a person's answers. Roots are
 * always answered empty, sampling is never answered (the retry is refused
 * before this point), URL elicitations are answered with the action alone.
 */
export function buildInputResponses(
  requests: ParsedInputRequest[],
  values: FormValues,
  action: ResumeAction,
): Record<string, ElicitationResult | { roots: [] }> {
  const responses: Record<string, ElicitationResult | { roots: [] }> = {};
  const forms = requests.filter(
    (request) => request.kind === "elicitation-form",
  );
  for (const request of requests) {
    switch (request.kind) {
      case "roots":
        responses[request.id] = { roots: [] };
        break;
      case "elicitation-url":
        responses[request.id] = { action };
        break;
      case "elicitation-form": {
        if (action !== "accept") {
          responses[request.id] = { action };
          break;
        }
        const schema = formSchemaSchema.safeParse(
          request.elicitation?.requestedSchema,
        );
        if (!schema.success)
          throw new ConnectorError("upstream-rejected", {
            detail: "mcp.elicitation.schema-unsupported",
          });
        // One form: the values are its content. Several: values are keyed by request id.
        const own =
          forms.length === 1
            ? values
            : ((values[request.id] as FormValues | undefined) ?? {});
        if (!own || typeof own !== "object" || Array.isArray(own))
          throw new ConnectorError("invalid-request", {
            detail: "mcp.input.values-shape",
          });
        const checked = validateFormValues(schema.data, own);
        if (!checked.ok)
          throw new ConnectorError("invalid-request", {
            detail: inputErrorDetail(checked.code),
          });
        responses[request.id] = { action: "accept", content: checked.content };
        break;
      }
      case "sampling":
        throw new ConnectorError("unsupported", {
          detail: "mcp.sampling.refused",
        });
    }
  }
  return responses;
}
