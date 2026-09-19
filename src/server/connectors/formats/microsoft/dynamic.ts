import { z } from "zod";
import {
  isReservedObjectKey,
  measureJsonValue,
  nativeIdentifierSchema,
} from "../../../../core/connectors/index.js";
import { IssueList, safeText, token } from "./issues.js";
import type { SwaggerWalk, WalkedOperation } from "./swagger-walk.js";

/*
 * Dynamic fields, as documented on the Power Platform OpenAPI extensions page
 * (ms.date 2026-06-03, retrieved 2026-09-18):
 *
 *   x-ms-dynamic-values     operationId, parameters, value-collection, value-path, value-title
 *   x-ms-dynamic-list       operationId, parameters, itemsPath, itemValuePath, itemTitlePath
 *   x-ms-dynamic-schema     operationId, parameters, value-path
 *   x-ms-dynamic-properties operationId, parameters, itemValuePath
 *
 * A "path string" is a JSON pointer without its leading slash. In the
 * `-values`/`-schema` forms a parameter entry is a literal or `{ "parameter":
 * name }`; in the `-list`/`-properties` forms it is `{ "value": literal }` or
 * `{ "parameterReference": "param/path" }`. The page documents both forms
 * side by side and recommends declaring the newer one alongside the older, so
 * one field may yield two contracts; the newer is marked preferred.
 *
 * A contract is a description for the UX: which operation to call, which of
 * the host operation's inputs feed it, and where the option value and title
 * live in the response. It carries nothing executable. The server executes a
 * dynamic operation only when a reviewed binding lists it, with the current
 * principal's connection, and hands back sanitized, bounded options.
 */

export const DYNAMIC_EXTENSIONS = [
  "x-ms-dynamic-values",
  "x-ms-dynamic-list",
  "x-ms-dynamic-schema",
  "x-ms-dynamic-properties",
] as const;
export type DynamicExtension = (typeof DYNAMIC_EXTENSIONS)[number];

export const DYNAMIC_OPTION_LIMITS = Object.freeze({
  options: 500,
  valueLength: 1024,
  titleLength: 256,
  responseBytes: 1024 * 1024,
  schema: { depth: 24, nodes: 4096, bytes: 256 * 1024, stringLength: 4096 },
  pathSegments: 32,
});

const pathStringSchema = z
  .string()
  .max(512)
  .regex(/^[^\p{Cc}]*$/u);
const literalSchema = z.union([
  z.string().max(1024),
  z.number().finite(),
  z.boolean(),
  z.null(),
]);

export const dynamicParameterBindingSchema = z.discriminatedUnion("source", [
  z.strictObject({
    /** Input of the dynamic operation: a parameter name, or "param/path" for a body property. */
    target: pathStringSchema.min(1),
    source: z.literal("parameter"),
    /** Input of the host operation that supplies the value: a parameter name, or "param/path". */
    reference: pathStringSchema.min(1),
    /** The referenced host parameter exists on the host operation. */
    resolved: z.boolean(),
  }),
  z.strictObject({
    target: pathStringSchema.min(1),
    source: z.literal("static"),
    value: literalSchema,
  }),
]);
export type DynamicParameterBinding = z.infer<
  typeof dynamicParameterBindingSchema
>;

export const dynamicFieldKindSchema = z.enum([
  "values",
  "list",
  "schema",
  "properties",
]);
export type DynamicFieldKind = z.infer<typeof dynamicFieldKindSchema>;

/** The small JSON contract a UI needs to render one dynamic field. */
export const dynamicFieldContractSchema = z.strictObject({
  id: z
    .string()
    .min(1)
    .max(400)
    .regex(/^[^\p{Cc}]+$/u),
  kind: dynamicFieldKindSchema,
  extension: z.enum(DYNAMIC_EXTENSIONS),
  /** When a field declares both the older and the newer form, the newer one is preferred. */
  preferred: z.boolean(),
  hostOperationId: nativeIdentifierSchema,
  field: z.strictObject({
    location: z.enum([
      "path",
      "query",
      "header",
      "formData",
      "body",
      "response",
    ]),
    /** Parameter name, or the response status for a response schema. */
    name: z.string().min(1).max(256),
    /** Path string inside a body or response schema; "" for the schema root. */
    pathString: pathStringSchema,
  }),
  sourcePointer: z.string().max(1024),
  /** x-ms-visibility of the field itself; presentation only, never authorization. */
  visibility: z.enum(["important", "advanced", "internal"]).optional(),
  operationId: nativeIdentifierSchema,
  /** Present only when the referenced operation exists exactly once in the document. */
  operation: z
    .strictObject({
      method: z.enum([
        "GET",
        "PUT",
        "POST",
        "DELETE",
        "OPTIONS",
        "HEAD",
        "PATCH",
      ]),
      pathTemplate: z.string().max(1024),
      /** Operation ref the binding candidate uses for this dynamic operation. */
      operationRef: z.string().max(200),
      /**
       * Where each input of the dynamic operation belongs on the wire. The
       * adapter places a resolved value by this table, so a form value can
       * never decide whether it becomes a path segment, a query value or a
       * header.
       */
      parameters: z
        .array(
          z.strictObject({
            name: z.string().min(1).max(256),
            in: z.enum(["path", "query", "header", "formData", "body"]),
            required: z.boolean(),
          }),
        )
        .max(64),
    })
    .optional(),
  parameters: z.array(dynamicParameterBindingSchema).max(32),
  selection: z.strictObject({
    /** value-collection / itemsPath: path string to the array; absent means the response is the array. */
    collection: pathStringSchema.optional(),
    /** value-path / itemValuePath: path string to the value inside each item, or to the schema. */
    value: pathStringSchema.optional(),
    /** value-title / itemTitlePath. */
    title: pathStringSchema.optional(),
  }),
  /** Every reference resolves, the operation exists once, and nothing blocks it at import. */
  executable: z.boolean(),
  /** Codes explaining a non-executable contract; empty when executable. */
  blockedBy: z.array(z.string().max(120)).max(16),
});
export type DynamicFieldContract = z.infer<typeof dynamicFieldContractSchema>;

/** What a dynamic-values/list invocation returns to the UX. */
export const dynamicOptionsResultSchema = z.strictObject({
  kind: z.literal("options"),
  options: z
    .array(
      z.strictObject({
        value: z.union([z.string(), z.number(), z.boolean(), z.null()]),
        title: z.string(),
      }),
    )
    .max(DYNAMIC_OPTION_LIMITS.options),
  truncated: z.boolean(),
  /** Items that were not primitives (or not selectable) and were dropped. */
  dropped: z.number().int().nonnegative(),
  cached: z.boolean(),
});
export type DynamicOptionsResult = z.infer<typeof dynamicOptionsResultSchema>;

export const dynamicSchemaResultSchema = z.strictObject({
  kind: z.literal("schema"),
  schema: z.unknown(),
  cached: z.boolean(),
});
export type DynamicSchemaResult = z.infer<typeof dynamicSchemaResultSchema>;

type JsonObject = Record<string, unknown>;
const isObject = (value: unknown): value is JsonObject =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** Splits a path string into unescaped segments; a leading slash is tolerated. */
export function pathStringSegments(path: string): string[] {
  const trimmed = path.startsWith("/") ? path.slice(1) : path;
  if (!trimmed.length) return [];
  return trimmed
    .split("/")
    .map((segment) => segment.replaceAll("~1", "/").replaceAll("~0", "~"));
}

/** Resolves a path string inside a JSON value; reserved keys and deep paths resolve to nothing. */
export function selectPathString(value: unknown, path: string): unknown {
  const segments = pathStringSegments(path);
  if (segments.length > DYNAMIC_OPTION_LIMITS.pathSegments) return undefined;
  let current: unknown = value;
  for (const segment of segments) {
    if (isReservedObjectKey(segment)) return undefined;
    if (Array.isArray(current)) {
      if (!/^\d{1,6}$/.test(segment)) return undefined;
      current = current[Number(segment)];
    } else if (isObject(current)) {
      if (!Object.hasOwn(current, segment)) return undefined;
      current = current[segment];
    } else return undefined;
  }
  return current;
}

const TAGS = /<[^>]*>/g;
const CONTROL_OR_BIDI = /\p{Cc}|\p{Cf}/gu;

/**
 * A title is text for a person: markup is stripped, control and format
 * characters (including bidirectional overrides) are removed, whitespace is
 * collapsed and the length is bounded. Values are kept as primitives and
 * bounded; an object or array can never be an option value.
 */
export function sanitizeTitle(
  value: unknown,
  max = DYNAMIC_OPTION_LIMITS.titleLength,
): string {
  const text =
    typeof value === "string"
      ? value
      : value === null || value === undefined
        ? ""
        : typeof value === "object"
          ? ""
          : String(value);
  let stripped = text;
  for (let round = 0; round < 4 && TAGS.test(stripped); round++)
    stripped = stripped.replace(TAGS, " ");
  const cleaned = stripped
    .replace(CONTROL_OR_BIDI, "")
    .replace(/\s+/g, " ")
    .trim();
  return cleaned.length > max ? cleaned.slice(0, max) : cleaned;
}

export function normalizeOptionValue(
  value: unknown,
): string | number | boolean | null | undefined {
  if (value === null) return null;
  if (typeof value === "boolean") return value;
  if (typeof value === "number")
    return Number.isFinite(value) ? value : undefined;
  if (typeof value === "string") {
    const cleaned = value.replace(CONTROL_OR_BIDI, "");
    return cleaned.length > DYNAMIC_OPTION_LIMITS.valueLength
      ? undefined
      : cleaned;
  }
  return undefined;
}

export type OptionSelection = {
  collection?: string | undefined;
  value?: string | undefined;
  title?: string | undefined;
};

/** Turns an upstream payload into bounded, sanitized options, or names why it cannot. */
export function extractOptions(
  payload: unknown,
  selection: OptionSelection,
): Omit<DynamicOptionsResult, "cached"> | { error: "collection-not-array" } {
  const collection =
    selection.collection !== undefined && selection.collection !== ""
      ? selectPathString(payload, selection.collection)
      : payload;
  if (!Array.isArray(collection)) return { error: "collection-not-array" };
  const options: DynamicOptionsResult["options"] = [];
  let dropped = 0;
  const limit = DYNAMIC_OPTION_LIMITS.options;
  for (const item of collection) {
    if (options.length >= limit) break;
    const rawValue =
      selection.value !== undefined && selection.value !== ""
        ? selectPathString(item, selection.value)
        : item;
    const value = normalizeOptionValue(rawValue);
    if (value === undefined) {
      dropped++;
      continue;
    }
    const rawTitle =
      selection.title !== undefined && selection.title !== ""
        ? selectPathString(item, selection.title)
        : undefined;
    const title = sanitizeTitle(rawTitle) || sanitizeTitle(value);
    options.push({ value, title });
  }
  return {
    kind: "options",
    options,
    truncated: collection.length > limit,
    dropped,
  };
}

/** Bounds and cleans a dynamic schema: strings lose control characters, structure stays within limits. */
export function extractSchema(
  payload: unknown,
  schemaPath: string | undefined,
): { schema: unknown } | { error: "schema-missing" | "schema-bounds" } {
  const selected =
    schemaPath !== undefined && schemaPath !== ""
      ? selectPathString(payload, schemaPath)
      : payload;
  if (selected === undefined) return { error: "schema-missing" };
  const measured = measureJsonValue(selected, DYNAMIC_OPTION_LIMITS.schema);
  if (!measured.ok) return { error: "schema-bounds" };
  const clean = (value: unknown): unknown => {
    if (typeof value === "string") return value.replace(CONTROL_OR_BIDI, "");
    if (Array.isArray(value)) return value.map(clean);
    if (isObject(value))
      return Object.fromEntries(
        Object.entries(value)
          .filter(([key]) => !isReservedObjectKey(key))
          .map(([key, item]) => [
            key.replace(CONTROL_OR_BIDI, ""),
            clean(item),
          ]),
      );
    return value;
  };
  return { schema: clean(selected) };
}

const visibilityOf = (
  extensions: Record<string, unknown>,
): "important" | "advanced" | "internal" | undefined => {
  const value = extensions["x-ms-visibility"];
  return value === "important" || value === "advanced" || value === "internal"
    ? value
    : undefined;
};

const pathString = (value: unknown): string | undefined =>
  typeof value === "string" && pathStringSchema.safeParse(value).success
    ? value
    : undefined;

const kindOf: Record<DynamicExtension, DynamicFieldKind> = {
  "x-ms-dynamic-values": "values",
  "x-ms-dynamic-list": "list",
  "x-ms-dynamic-schema": "schema",
  "x-ms-dynamic-properties": "properties",
};

export function dynamicOperationRef(operationId: string): string {
  // Operation refs are bounded ASCII; the native id is digested when it is not.
  const safe = /^[a-zA-Z0-9][a-zA-Z0-9_.:@/-]{0,150}$/.test(operationId)
    ? operationId
    : encodeURIComponent(operationId).replaceAll("%", "_").slice(0, 150);
  return `msdyn:${safe}`;
}

type FieldSite = {
  location: DynamicFieldContract["field"]["location"];
  name: string;
  pathString: string;
  pointer: string;
  extensions: Record<string, unknown>;
};

function readBindings(
  extension: DynamicExtension,
  raw: JsonObject,
  host: WalkedOperation,
  target: WalkedOperation | undefined,
  pointer: string,
  issues: IssueList,
  blockedBy: string[],
): DynamicParameterBinding[] {
  const hostParameters = new Set(host.parameters.map((item) => item.name));
  const targetParameters = target
    ? new Set(target.parameters.map((item) => item.name))
    : undefined;
  const newer =
    extension === "x-ms-dynamic-list" ||
    extension === "x-ms-dynamic-properties";
  const bindings: DynamicParameterBinding[] = [];
  if (raw.parameters !== undefined && !isObject(raw.parameters)) {
    issues.push({
      code: "structure.dynamic-parameters-shape",
      category: "structure",
      pointer: `${pointer}/parameters`,
      dimension: "invoke",
      severity: "warning",
      disposition: "unsupported",
      message: `${extension} parameters must be an object keyed by the dynamic operation's input names.`,
    });
    blockedBy.push("structure.dynamic-parameters-shape");
    return bindings;
  }
  const entries = Object.entries(
    isObject(raw.parameters) ? raw.parameters : {},
  );
  if (entries.length > 32) {
    issues.push({
      code: "structure.dynamic-parameter-count",
      category: "structure",
      pointer: `${pointer}/parameters`,
      dimension: "invoke",
      severity: "warning",
      disposition: "unsupported",
      message: "A dynamic extension may bind at most 32 parameters.",
    });
    blockedBy.push("structure.dynamic-parameter-count");
  }
  for (const [targetName, spec] of entries.slice(0, 32)) {
    const targetPath = pathString(targetName);
    if (!targetPath || isReservedObjectKey(targetName)) {
      blockedBy.push("structure.dynamic-target-invalid");
      continue;
    }
    const targetRoot = pathStringSegments(targetPath)[0] ?? "";
    if (targetParameters && !targetParameters.has(targetRoot)) {
      issues.push({
        code: "structure.dynamic-target-unknown",
        category: "structure",
        pointer: `${pointer}/parameters`,
        dimension: "invoke",
        severity: "warning",
        disposition: "unsupported",
        message: `${extension} binds ${token(targetName)}, which operation ${token(raw.operationId)} does not declare.`,
      });
      blockedBy.push("structure.dynamic-target-unknown");
    }
    let binding: DynamicParameterBinding | undefined;
    if (isObject(spec)) {
      const reference = newer ? spec.parameterReference : spec.parameter;
      const referenceForm = newer ? "parameterReference" : "parameter";
      if (typeof reference === "string" && pathString(reference)) {
        const root = pathStringSegments(reference)[0] ?? "";
        const resolved = hostParameters.has(root);
        if (!resolved) {
          issues.push({
            code: "structure.dynamic-reference-unresolved",
            category: "structure",
            pointer: `${pointer}/parameters`,
            dimension: "invoke",
            severity: "warning",
            disposition: "unsupported",
            message: `${extension} references host input ${token(reference)} through ${referenceForm}, but the operation declares no parameter of that name.`,
            remediation:
              "Reference an operation parameter by name, or use the newer extension with a full parameter reference path.",
          });
          blockedBy.push("structure.dynamic-reference-unresolved");
        }
        binding = {
          target: targetPath,
          source: "parameter",
          reference,
          resolved,
        };
      } else if (newer && Object.hasOwn(spec, "value")) {
        const literal = literalSchema.safeParse(spec.value);
        if (literal.success)
          binding = {
            target: targetPath,
            source: "static",
            value: literal.data,
          };
      }
    } else if (!newer) {
      const literal = literalSchema.safeParse(spec);
      if (literal.success)
        binding = { target: targetPath, source: "static", value: literal.data };
    }
    if (!binding) {
      issues.push({
        code: "structure.dynamic-parameter-shape",
        category: "structure",
        pointer: `${pointer}/parameters`,
        dimension: "invoke",
        severity: "warning",
        disposition: "unsupported",
        message: `${extension} parameter ${token(targetName)} is neither a documented literal nor a documented reference.`,
      });
      blockedBy.push("structure.dynamic-parameter-shape");
      continue;
    }
    bindings.push(binding);
  }
  return bindings;
}

function buildContract(
  extension: DynamicExtension,
  raw: unknown,
  host: WalkedOperation,
  site: FieldSite,
  byId: Map<string, WalkedOperation>,
  issues: IssueList,
): DynamicFieldContract | undefined {
  const pointer = `${site.pointer}/${extension}`;
  if (!isObject(raw)) {
    issues.push({
      code: "structure.dynamic-extension-shape",
      category: "structure",
      pointer,
      dimension: "invoke",
      severity: "warning",
      disposition: "unsupported",
      message: `${extension} must be an object with an operationId.`,
    });
    return undefined;
  }
  const operationId =
    typeof raw.operationId === "string" &&
    nativeIdentifierSchema.safeParse(raw.operationId).success
      ? raw.operationId
      : undefined;
  if (!operationId) {
    issues.push({
      code: "structure.dynamic-operation-missing",
      category: "structure",
      pointer,
      dimension: "invoke",
      severity: "warning",
      disposition: "unsupported",
      message: `${extension} does not name a usable operationId; the field stays a plain input.`,
    });
    return undefined;
  }
  const blockedBy: string[] = [];
  const target = byId.get(operationId);
  if (!target) {
    issues.push({
      code: "structure.dynamic-operation-unknown",
      category: "structure",
      pointer,
      dimension: "invoke",
      severity: "warning",
      disposition: "unsupported",
      message: `${extension} references operation ${token(operationId)}, which this document does not declare exactly once; the field cannot be resolved.`,
      remediation:
        "Add the operation to the definition or correct the operationId.",
    });
    blockedBy.push("structure.dynamic-operation-unknown");
  } else if (issues.blockingUnder(target.pointer).length)
    blockedBy.push("structure.dynamic-operation-blocked");
  const parameters = readBindings(
    extension,
    raw,
    host,
    target,
    pointer,
    issues,
    blockedBy,
  );
  const kind = kindOf[extension];
  const selection: DynamicFieldContract["selection"] = {};
  if (kind === "values") {
    const collection = pathString(raw["value-collection"]);
    const value = pathString(raw["value-path"]);
    const title = pathString(raw["value-title"]);
    if (collection !== undefined) selection.collection = collection;
    if (value !== undefined) selection.value = value;
    if (title !== undefined) selection.title = title;
  } else if (kind === "list") {
    const collection = pathString(raw.itemsPath);
    const value = pathString(raw.itemValuePath);
    const title = pathString(raw.itemTitlePath);
    if (collection !== undefined) selection.collection = collection;
    if (value !== undefined) selection.value = value;
    if (title !== undefined) selection.title = title;
  } else if (kind === "schema") {
    const value = pathString(raw["value-path"]);
    if (value !== undefined) selection.value = value;
  } else {
    const value = pathString(raw.itemValuePath);
    if (value !== undefined) selection.value = value;
  }
  const visibility = visibilityOf(site.extensions);
  const suffix = site.pathString
    ? `${site.name}/${site.pathString}`
    : site.name;
  const id = safeText(
    `${kind}:${host.nativeId}:${site.location}:${suffix}`,
    400,
  );
  return dynamicFieldContractSchema.parse({
    id,
    kind,
    extension,
    preferred: true,
    hostOperationId: host.nativeId,
    field: {
      location: site.location,
      name: site.name,
      pathString: site.pathString,
    },
    sourcePointer: pointer,
    ...(visibility ? { visibility } : {}),
    operationId,
    ...(target
      ? {
          operation: {
            method: target.method,
            pathTemplate: target.path,
            operationRef: dynamicOperationRef(target.nativeId),
            parameters: target.parameters.slice(0, 64).map((parameter) => ({
              name: parameter.name,
              in: parameter.in,
              required: parameter.required,
            })),
          },
        }
      : {}),
    parameters,
    selection,
    executable: blockedBy.length === 0,
    blockedBy: [...new Set(blockedBy)],
  });
}

/** Every dynamic field the document declares, with its references checked against the document. */
export function extractDynamicFields(
  walk: SwaggerWalk,
  issues: IssueList,
): DynamicFieldContract[] {
  const byId = new Map<string, WalkedOperation>();
  for (const operation of walk.operations)
    if (operation.identity === "operationId" && !operation.ambiguous)
      byId.set(operation.nativeId, operation);
  const contracts: DynamicFieldContract[] = [];
  for (const host of walk.operations) {
    if (host.identity !== "operationId") continue;
    const sites: FieldSite[] = [];
    for (const parameter of host.parameters) {
      if (parameter.in !== "body")
        sites.push({
          location: parameter.in,
          name: parameter.name,
          pathString: "",
          pointer: parameter.pointer,
          extensions: parameter.extensions,
        });
      for (const node of parameter.nested)
        sites.push({
          location: "body",
          name: parameter.name,
          pathString: node.pathString,
          pointer: node.pointer,
          extensions: node.extensions,
        });
    }
    for (const response of host.responses)
      for (const node of response.nested)
        sites.push({
          location: "response",
          name: response.status,
          pathString: node.pathString,
          pointer: node.pointer,
          extensions: node.extensions,
        });
    for (const site of sites)
      for (const extension of DYNAMIC_EXTENSIONS) {
        if (!Object.hasOwn(site.extensions, extension)) continue;
        const contract = buildContract(
          extension,
          site.extensions[extension],
          host,
          site,
          byId,
          issues,
        );
        if (contract) contracts.push(contract);
      }
  }
  // The newer form wins when both are declared on one field.
  const key = (contract: DynamicFieldContract) =>
    JSON.stringify([
      contract.hostOperationId,
      contract.field.location,
      contract.field.name,
      contract.field.pathString,
    ]);
  const newer = new Set(
    contracts
      .filter(
        (contract) =>
          contract.kind === "list" || contract.kind === "properties",
      )
      .map(
        (contract) =>
          `${key(contract)}|${contract.kind === "list" ? "options" : "schema"}`,
      ),
  );
  return contracts.map((contract) => {
    const family =
      contract.kind === "values" || contract.kind === "list"
        ? "options"
        : "schema";
    const superseded =
      (contract.kind === "values" || contract.kind === "schema") &&
      newer.has(`${key(contract)}|${family}`);
    return superseded ? { ...contract, preferred: false } : contract;
  });
}
