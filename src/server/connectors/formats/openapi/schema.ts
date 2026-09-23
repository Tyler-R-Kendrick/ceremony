import { isIP } from "node:net";
import { z } from "zod";
import { canonicalConnectorJson } from "../../../../core/connectors/index.js";
import type { OpenApiProfile } from "./model.js";
import { entriesOf, isRecord, type ReferenceResolver } from "./refs.js";

/*
 * The executable schema subset. A compiled schema contains only keywords this
 * module validates; anything else the source used is reported to the caller
 * as unsupported so the affected operation is blocked instead of being run
 * against a looser check than the source promised. Recursive schemas compile
 * once per target into a definitions table and are followed lazily, so a
 * self-referencing tree is preserved and validated to an explicit depth.
 */

export const JSON_TYPES = [
  "string",
  "number",
  "integer",
  "boolean",
  "object",
  "array",
  "null",
] as const;
export type JsonType = (typeof JSON_TYPES)[number];

export type CompiledSchema =
  | { kind: "any" }
  | { kind: "never" }
  | { kind: "ref"; name: string }
  | {
      kind: "node";
      types?: JsonType[];
      enum?: unknown[];
      const?: unknown;
      format?: string;
      minimum?: number;
      maximum?: number;
      exclusiveMinimum?: number;
      exclusiveMaximum?: number;
      multipleOf?: number;
      minLength?: number;
      maxLength?: number;
      minItems?: number;
      maxItems?: number;
      uniqueItems?: boolean;
      items?: CompiledSchema;
      properties?: Record<string, CompiledSchema>;
      required?: string[];
      additionalProperties?: boolean | CompiledSchema;
      minProperties?: number;
      maxProperties?: number;
      title?: string;
      description?: string;
      deprecated?: boolean;
      readOnly?: boolean;
      writeOnly?: boolean;
    };

const jsonValue: z.ZodType<unknown> = z.lazy(() =>
  z.union([
    z.string(),
    z.number(),
    z.boolean(),
    z.null(),
    z.array(jsonValue),
    z.record(z.string(), jsonValue),
  ]),
);

// Zod's inferred optional keys are `T | undefined`; the parsed value never holds
// an explicit undefined, so the exact shape is asserted once here.
export const compiledSchemaSchema: z.ZodType<CompiledSchema> = z.lazy(() =>
  z.discriminatedUnion("kind", [
    z.strictObject({ kind: z.literal("any") }),
    z.strictObject({ kind: z.literal("never") }),
    z.strictObject({
      kind: z.literal("ref"),
      name: z.string().min(1).max(2048),
    }),
    z.strictObject({
      kind: z.literal("node"),
      types: z.array(z.enum(JSON_TYPES)).max(7).optional(),
      enum: z.array(jsonValue).max(1024).optional(),
      const: jsonValue.optional(),
      format: z.string().max(64).optional(),
      minimum: z.number().optional(),
      maximum: z.number().optional(),
      exclusiveMinimum: z.number().optional(),
      exclusiveMaximum: z.number().optional(),
      multipleOf: z.number().positive().optional(),
      minLength: z.number().int().nonnegative().optional(),
      maxLength: z.number().int().nonnegative().optional(),
      minItems: z.number().int().nonnegative().optional(),
      maxItems: z.number().int().nonnegative().optional(),
      uniqueItems: z.boolean().optional(),
      items: compiledSchemaSchema.optional(),
      properties: z
        .record(z.string().max(256), compiledSchemaSchema)
        .optional(),
      required: z.array(z.string().max(256)).max(1024).optional(),
      additionalProperties: z
        .union([z.boolean(), compiledSchemaSchema])
        .optional(),
      minProperties: z.number().int().nonnegative().optional(),
      maxProperties: z.number().int().nonnegative().optional(),
      title: z.string().max(200).optional(),
      description: z.string().max(500).optional(),
      deprecated: z.boolean().optional(),
      readOnly: z.boolean().optional(),
      writeOnly: z.boolean().optional(),
    }),
  ]),
) as unknown as z.ZodType<CompiledSchema>;

export type SchemaDefinitions = Record<string, CompiledSchema>;

export interface SchemaProblem {
  code:
    | "schema.unsupported-keyword"
    | "schema.unknown-keyword"
    | "schema.format-not-validated"
    | "schema.binary-in-json"
    | "schema.dialect-unsupported"
    | "schema.reference-unresolved"
    | "schema.too-deep"
    | "schema.invalid";
  pointer: string;
  keyword?: string;
}

export interface CompileSchemaContext {
  resolver: ReferenceResolver;
  profile: OpenApiProfile;
  definitions: Map<string, CompiledSchema | "compiling">;
  problems: SchemaProblem[];
  maxDepth?: number;
}

/** Keywords the validator enforces exactly. */
const enforced = new Set([
  "type",
  "enum",
  "const",
  "format",
  "minimum",
  "maximum",
  "exclusiveMinimum",
  "exclusiveMaximum",
  "multipleOf",
  "minLength",
  "maxLength",
  "minItems",
  "maxItems",
  "uniqueItems",
  "items",
  "properties",
  "required",
  "additionalProperties",
  "minProperties",
  "maxProperties",
  "nullable",
  "$ref",
]);
/** Annotations that carry no validation semantics; kept or ignored, never blocking. */
const annotations = new Set([
  "title",
  "description",
  "default",
  "example",
  "examples",
  "deprecated",
  "readOnly",
  "writeOnly",
  "externalDocs",
  "xml",
  "$comment",
  "$defs",
  "definitions",
  "$id",
  "id",
  "$schema",
  "discriminator",
]);
/** Known JSON Schema / OAS keywords this validator does not implement: unsupported, not ignored. */
const known = new Set([
  "allOf",
  "anyOf",
  "oneOf",
  "not",
  "if",
  "then",
  "else",
  "pattern",
  "patternProperties",
  "propertyNames",
  "dependentRequired",
  "dependentSchemas",
  "dependencies",
  "prefixItems",
  "additionalItems",
  "contains",
  "minContains",
  "maxContains",
  "unevaluatedItems",
  "unevaluatedProperties",
  "contentEncoding",
  "contentMediaType",
  "contentSchema",
  "$dynamicRef",
  "$dynamicAnchor",
  "$anchor",
  "$recursiveRef",
  "$recursiveAnchor",
  "$vocabulary",
]);
const validatedFormats = new Set([
  "date-time",
  "date",
  "time",
  "uuid",
  "email",
  "uri",
  "uri-reference",
  "ipv4",
  "ipv6",
  "hostname",
  "int32",
  "int64",
  "float",
  "double",
  "byte",
  "password",
]);

const defaultDialects = new Set([
  "https://json-schema.org/draft/2020-12/schema",
  "https://spec.openapis.org/oas/3.1/dialect/base",
]);

function nameFor(documentKey: string, pointer: string): string {
  const raw = documentKey === "" ? pointer : `${documentKey}${pointer}`;
  return raw.length <= 1024 ? raw : raw.slice(0, 1024);
}

function nonNegativeInt(value: unknown): number | undefined {
  return typeof value === "number" && Number.isInteger(value) && value >= 0
    ? value
    : undefined;
}
function finite(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value)
    ? value
    : undefined;
}

/**
 * Compiles a raw schema into the executable subset. Unsupported constructs are
 * recorded on the context; the result is still a schema (the enforced part),
 * and the caller decides that the presence of problems blocks the operation.
 */
export function compileSchema(
  raw: unknown,
  location: { documentKey: string; pointer: string },
  ctx: CompileSchemaContext,
  depth = 0,
): CompiledSchema {
  ctx.resolver.visit();
  if (depth > (ctx.maxDepth ?? 64)) {
    ctx.problems.push({ code: "schema.too-deep", pointer: location.pointer });
    return { kind: "never" };
  }
  if (raw === true || raw === undefined) return { kind: "any" };
  if (raw === false) return { kind: "never" };
  if (!isRecord(raw)) {
    ctx.problems.push({ code: "schema.invalid", pointer: location.pointer });
    return { kind: "never" };
  }
  if (typeof raw.$ref === "string") {
    const siblings = entriesOf(raw)
      .map(([key]) => key)
      .filter(
        (key) =>
          key !== "$ref" && !key.startsWith("x-") && !annotations.has(key),
      );
    if (siblings.length)
      ctx.problems.push({
        code: "schema.unsupported-keyword",
        pointer: location.pointer,
        keyword: siblings[0] ?? "$ref",
      });
    const resolved = ctx.resolver.resolve(raw, location);
    if (!resolved.ok) {
      ctx.problems.push({
        code: "schema.reference-unresolved",
        pointer: location.pointer,
      });
      return { kind: "never" };
    }
    const name = nameFor(
      resolved.resolved.documentKey,
      resolved.resolved.pointer,
    );
    if (!ctx.definitions.has(name)) {
      ctx.definitions.set(name, "compiling");
      const compiled = compileSchema(
        resolved.resolved.value,
        {
          documentKey: resolved.resolved.documentKey,
          pointer: resolved.resolved.pointer,
        },
        ctx,
        depth + 1,
      );
      ctx.definitions.set(name, compiled);
    }
    return { kind: "ref", name };
  }
  const node: Extract<CompiledSchema, { kind: "node" }> = { kind: "node" };
  const modern = ctx.profile === "openapi-3.1" || ctx.profile === "openapi-3.2";
  for (const [key, value] of entriesOf(raw)) {
    if (key.startsWith("x-")) continue;
    if (annotations.has(key)) {
      if (
        key === "$schema" &&
        typeof value === "string" &&
        !defaultDialects.has(value)
      )
        ctx.problems.push({
          code: "schema.dialect-unsupported",
          pointer: location.pointer,
        });
      if (key === "discriminator")
        ctx.problems.push({
          code: "schema.unsupported-keyword",
          pointer: location.pointer,
          keyword: key,
        });
      if (key === "title" && typeof value === "string")
        node.title = value.slice(0, 200);
      if (key === "description" && typeof value === "string")
        node.description = value.replace(/\p{Cc}/gu, " ").slice(0, 500);
      if (key === "deprecated" && value === true) node.deprecated = true;
      if (key === "readOnly" && value === true) node.readOnly = true;
      if (key === "writeOnly" && value === true) node.writeOnly = true;
      continue;
    }
    if (known.has(key)) {
      ctx.problems.push({
        code: "schema.unsupported-keyword",
        pointer: location.pointer,
        keyword: key,
      });
      continue;
    }
    if (!enforced.has(key)) {
      ctx.problems.push({
        code: "schema.unknown-keyword",
        pointer: location.pointer,
        keyword: key.slice(0, 64),
      });
      continue;
    }
    switch (key) {
      case "type": {
        const list = Array.isArray(value) ? value : [value];
        if (Array.isArray(value) && !modern) {
          ctx.problems.push({
            code: "schema.unsupported-keyword",
            pointer: location.pointer,
            keyword: "type[]",
          });
          break;
        }
        const types: JsonType[] = [];
        for (const item of list)
          if (
            typeof item === "string" &&
            (JSON_TYPES as readonly string[]).includes(item)
          )
            types.push(item as JsonType);
          else
            ctx.problems.push({
              code: "schema.invalid",
              pointer: location.pointer,
              keyword: "type",
            });
        node.types = [...new Set([...(node.types ?? []), ...types])];
        break;
      }
      case "nullable": {
        if (modern) {
          ctx.problems.push({
            code: "schema.unknown-keyword",
            pointer: location.pointer,
            keyword: "nullable",
          });
          break;
        }
        if (value === true)
          node.types = [...new Set([...(node.types ?? []), "null" as const])];
        break;
      }
      case "enum": {
        if (Array.isArray(value) && value.length <= 1024)
          node.enum = value.map(cloneJson);
        else
          ctx.problems.push({
            code: "schema.invalid",
            pointer: location.pointer,
            keyword: "enum",
          });
        break;
      }
      case "const": {
        if (!modern) {
          ctx.problems.push({
            code: "schema.unknown-keyword",
            pointer: location.pointer,
            keyword: "const",
          });
          break;
        }
        node.const = cloneJson(value);
        break;
      }
      case "format": {
        if (typeof value !== "string") break;
        if (value === "binary") {
          ctx.problems.push({
            code: "schema.binary-in-json",
            pointer: location.pointer,
          });
          break;
        }
        node.format = value.slice(0, 64);
        if (!validatedFormats.has(value))
          ctx.problems.push({
            code: "schema.format-not-validated",
            pointer: location.pointer,
            keyword: value.slice(0, 64),
          });
        break;
      }
      case "minimum":
      case "maximum": {
        const number = finite(value);
        if (number !== undefined) node[key] = number;
        break;
      }
      case "exclusiveMinimum":
      case "exclusiveMaximum": {
        if (typeof value === "boolean") {
          if (modern) {
            ctx.problems.push({
              code: "schema.invalid",
              pointer: location.pointer,
              keyword: key,
            });
            break;
          }
          if (value) {
            const bound =
              key === "exclusiveMinimum" ? raw.minimum : raw.maximum;
            const number = finite(bound);
            if (number !== undefined) {
              node[key] = number;
              if (key === "exclusiveMinimum") delete node.minimum;
              else delete node.maximum;
            }
          }
          break;
        }
        const number = finite(value);
        if (number !== undefined) node[key] = number;
        break;
      }
      case "multipleOf": {
        const number = finite(value);
        if (number !== undefined && number > 0) node.multipleOf = number;
        break;
      }
      case "minLength":
      case "maxLength":
      case "minItems":
      case "maxItems":
      case "minProperties":
      case "maxProperties": {
        const number = nonNegativeInt(value);
        if (number !== undefined) node[key] = number;
        break;
      }
      case "uniqueItems": {
        if (value === true) node.uniqueItems = true;
        break;
      }
      case "items": {
        if (Array.isArray(value)) {
          ctx.problems.push({
            code: "schema.unsupported-keyword",
            pointer: location.pointer,
            keyword: "items[]",
          });
          break;
        }
        node.items = compileSchema(
          value,
          {
            documentKey: location.documentKey,
            pointer: `${location.pointer}/items`,
          },
          ctx,
          depth + 1,
        );
        break;
      }
      case "properties": {
        if (!isRecord(value)) break;
        const properties: Record<string, CompiledSchema> = {};
        for (const [name, property] of entriesOf(value)) {
          if (name.length > 256) continue;
          properties[name] = compileSchema(
            property,
            {
              documentKey: location.documentKey,
              pointer: `${location.pointer}/properties/${name.replaceAll("~", "~0").replaceAll("/", "~1")}`,
            },
            ctx,
            depth + 1,
          );
        }
        node.properties = properties;
        break;
      }
      case "required": {
        if (Array.isArray(value))
          node.required = value
            .filter(
              (item): item is string =>
                typeof item === "string" && item.length <= 256,
            )
            .slice(0, 1024);
        break;
      }
      case "additionalProperties": {
        if (typeof value === "boolean") node.additionalProperties = value;
        else
          node.additionalProperties = compileSchema(
            value,
            {
              documentKey: location.documentKey,
              pointer: `${location.pointer}/additionalProperties`,
            },
            ctx,
            depth + 1,
          );
        break;
      }
      default:
        break;
    }
  }
  // An exclusive bound is set while the inclusive sibling was removed in 2.0/3.0 form.
  const remove = new Set(
    modern
      ? []
      : [
          raw.exclusiveMinimum === true ? "minimum" : "",
          raw.exclusiveMaximum === true ? "maximum" : "",
        ],
  );
  if (remove.has("minimum")) delete node.minimum;
  if (remove.has("maximum")) delete node.maximum;
  return node;
}

function cloneJson(value: unknown): unknown {
  const text = JSON.stringify(value);
  return text === undefined ? null : JSON.parse(text);
}

export interface ValidationFailure {
  path: string;
  code: string;
}

const typeOf = (value: unknown): JsonType | undefined => {
  if (value === null) return "null";
  if (typeof value === "string") return "string";
  if (typeof value === "boolean") return "boolean";
  if (typeof value === "number")
    return Number.isFinite(value) ? "number" : undefined;
  if (Array.isArray(value)) return "array";
  if (isRecord(value)) return "object";
  return undefined;
};

function formatValid(format: string, value: string): boolean {
  switch (format) {
    case "date-time":
      return (
        /^\d{4}-\d{2}-\d{2}[Tt ]\d{2}:\d{2}:\d{2}(\.\d+)?([Zz]|[+-]\d{2}:\d{2})$/.test(
          value,
        ) && !Number.isNaN(Date.parse(value))
      );
    case "date":
      return (
        /^\d{4}-\d{2}-\d{2}$/.test(value) &&
        !Number.isNaN(Date.parse(`${value}T00:00:00Z`))
      );
    case "time":
      return /^\d{2}:\d{2}:\d{2}(\.\d+)?([Zz]|[+-]\d{2}:\d{2})$/.test(value);
    case "uuid":
      return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
        value,
      );
    case "email":
      return value.length <= 320 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
    case "uri":
      return URL.canParse(value) && /^[A-Za-z][A-Za-z0-9+.-]*:/.test(value);
    case "uri-reference":
      return value.length <= 4096 && !/\s/.test(value);
    case "ipv4":
      return isIP(value) === 4;
    case "ipv6":
      return isIP(value) === 6;
    case "hostname":
      return (
        value.length <= 253 &&
        /^[A-Za-z0-9]([A-Za-z0-9-]{0,61}[A-Za-z0-9])?(\.[A-Za-z0-9]([A-Za-z0-9-]{0,61}[A-Za-z0-9])?)*$/.test(
          value,
        )
      );
    case "byte":
      return /^[A-Za-z0-9+/]*={0,2}$/.test(value) && value.length % 4 === 0;
    default:
      return true;
  }
}

/**
 * Validates a value against a compiled schema. Failures name a path and a
 * code, never the value. Reference depth is bounded explicitly: a recursive
 * document nested deeper than the limit fails with `schema.depth-exceeded`.
 */
export function validateValue(
  value: unknown,
  schema: CompiledSchema,
  definitions: SchemaDefinitions,
  options: { maxDepth?: number; maxNodes?: number } = {},
): ValidationFailure[] {
  const failures: ValidationFailure[] = [];
  const maxDepth = options.maxDepth ?? 64;
  const budget = { nodes: 0, limit: options.maxNodes ?? 100_000 };
  const check = (
    item: unknown,
    current: CompiledSchema,
    path: string,
    depth: number,
  ): void => {
    if (++budget.nodes > budget.limit) {
      if (!failures.some((failure) => failure.code === "schema.node-budget"))
        failures.push({ path, code: "schema.node-budget" });
      return;
    }
    if (depth > maxDepth) {
      failures.push({ path, code: "schema.depth-exceeded" });
      return;
    }
    if (current.kind === "any") return;
    if (current.kind === "never") {
      failures.push({ path, code: "schema.never" });
      return;
    }
    if (current.kind === "ref") {
      const target = definitions[current.name];
      if (!target) {
        failures.push({ path, code: "schema.reference-missing" });
        return;
      }
      check(item, target, path, depth + 1);
      return;
    }
    const actual = typeOf(item);
    if (actual === undefined) {
      failures.push({ path, code: "schema.type" });
      return;
    }
    if (current.types && current.types.length) {
      const matches =
        current.types.includes(actual) ||
        (actual === "number" &&
          current.types.includes("integer") &&
          Number.isInteger(item));
      if (!matches) {
        failures.push({ path, code: "schema.type" });
        return;
      }
    }
    if (
      current.const !== undefined &&
      canonicalConnectorJson(item) !== canonicalConnectorJson(current.const)
    )
      failures.push({ path, code: "schema.const" });
    if (current.enum) {
      const canonical = canonicalConnectorJson(item);
      if (
        !current.enum.some(
          (option) => canonicalConnectorJson(option) === canonical,
        )
      )
        failures.push({ path, code: "schema.enum" });
    }
    if (typeof item === "number") {
      if (current.minimum !== undefined && item < current.minimum)
        failures.push({ path, code: "schema.minimum" });
      if (current.maximum !== undefined && item > current.maximum)
        failures.push({ path, code: "schema.maximum" });
      if (
        current.exclusiveMinimum !== undefined &&
        item <= current.exclusiveMinimum
      )
        failures.push({ path, code: "schema.exclusive-minimum" });
      if (
        current.exclusiveMaximum !== undefined &&
        item >= current.exclusiveMaximum
      )
        failures.push({ path, code: "schema.exclusive-maximum" });
      if (current.multipleOf !== undefined) {
        const quotient = item / current.multipleOf;
        if (Math.abs(quotient - Math.round(quotient)) > 1e-9)
          failures.push({ path, code: "schema.multiple-of" });
      }
      if (
        current.format === "int32" &&
        (!Number.isInteger(item) || item < -2147483648 || item > 2147483647)
      )
        failures.push({ path, code: "schema.format" });
      if (current.format === "int64" && !Number.isInteger(item))
        failures.push({ path, code: "schema.format" });
    }
    if (typeof item === "string") {
      const length = [...item].length;
      if (current.minLength !== undefined && length < current.minLength)
        failures.push({ path, code: "schema.min-length" });
      if (current.maxLength !== undefined && length > current.maxLength)
        failures.push({ path, code: "schema.max-length" });
      if (current.format && !formatValid(current.format, item))
        failures.push({ path, code: "schema.format" });
    }
    if (Array.isArray(item)) {
      if (current.minItems !== undefined && item.length < current.minItems)
        failures.push({ path, code: "schema.min-items" });
      if (current.maxItems !== undefined && item.length > current.maxItems)
        failures.push({ path, code: "schema.max-items" });
      if (current.uniqueItems) {
        if (item.length > 1024)
          failures.push({ path, code: "schema.unique-items-bound" });
        else if (
          new Set(item.map((entry) => canonicalConnectorJson(entry))).size !==
          item.length
        )
          failures.push({ path, code: "schema.unique-items" });
      }
      if (current.items)
        item.forEach((entry, index) =>
          check(entry, current.items!, `${path}/${index}`, depth + 1),
        );
    }
    if (isRecord(item)) {
      const keys = entriesOf(item).map(([key]) => key);
      if (
        current.minProperties !== undefined &&
        keys.length < current.minProperties
      )
        failures.push({ path, code: "schema.min-properties" });
      if (
        current.maxProperties !== undefined &&
        keys.length > current.maxProperties
      )
        failures.push({ path, code: "schema.max-properties" });
      for (const name of current.required ?? [])
        if (!keys.includes(name))
          failures.push({ path: `${path}/${name}`, code: "schema.required" });
      for (const key of keys) {
        const property = current.properties?.[key];
        const childPath = `${path}/${key.replaceAll("~", "~0").replaceAll("/", "~1")}`;
        if (property) check(item[key], property, childPath, depth + 1);
        else if (current.additionalProperties === false)
          failures.push({
            path: childPath,
            code: "schema.additional-property",
          });
        else if (typeof current.additionalProperties === "object")
          check(item[key], current.additionalProperties, childPath, depth + 1);
      }
    }
  };
  check(value, schema, "", 0);
  return failures;
}
