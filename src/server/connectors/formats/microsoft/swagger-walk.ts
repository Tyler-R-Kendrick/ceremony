import {
  isReservedObjectKey,
  measureJsonValue,
  type CompatibilityIssue,
} from "../../../../core/connectors/index.js";
import { IssueList, pointer, safeText, token } from "./issues.js";

/*
 * A bounded walk over a Swagger 2.0 document, which is the only OpenAPI
 * version the Power Platform custom-connector importer accepts (Microsoft
 * Learn, "Create a custom connector from an OpenAPI definition", ms.date
 * 2026-06-03: "OpenAPI definitions that are in OpenAPI 3.0 format are not
 * supported"; definition size under 1 MB).
 *
 * This file is deliberately the one seam between the Microsoft reader and the
 * document: the shared OpenAPI reader under ../openapi/ is being written
 * concurrently, and once its `ReadResult` is complete it can be adapted into a
 * `SwaggerWalk` here without any other Microsoft file changing. The walk
 * fetches nothing, evaluates nothing and copies nothing it has not measured:
 * local `$ref`s resolve under a depth and cycle guard, extension values are
 * bounded before they are kept, and every structural fault becomes a
 * diagnostic located by pointer rather than an echoed fragment.
 */

export const SWAGGER_WALK_LIMITS = Object.freeze({
  document: {
    depth: 64,
    nodes: 250_000,
    bytes: 4 * 1024 * 1024,
    stringLength: 65_536,
  },
  paths: 512,
  operations: 1024,
  parameters: 64,
  responses: 32,
  schemaDepth: 24,
  schemaNodes: 4096,
  extensionKeys: 64,
  extensionValue: {
    depth: 16,
    nodes: 2048,
    bytes: 64 * 1024,
    stringLength: 8192,
  },
  refDepth: 32,
  securityDefinitions: 32,
});

export type HttpMethod =
  "GET" | "PUT" | "POST" | "DELETE" | "OPTIONS" | "HEAD" | "PATCH";
export type SwaggerParameterLocation =
  "path" | "query" | "header" | "formData" | "body";

/** A schema node worth indexing: it carries an extension, a password format or a default. */
export interface SchemaNode {
  /** Power Platform "path string": a JSON pointer without the leading slash, relative to the schema root. */
  pathString: string;
  pointer: string;
  type?: string;
  format?: string;
  required: boolean;
  hasDefault: boolean;
  default?: unknown;
  extensions: Record<string, unknown>;
}

export interface WalkedParameter {
  name: string;
  in: SwaggerParameterLocation;
  required: boolean;
  type?: string;
  format?: string;
  items?: { type?: string; format?: string };
  collectionFormat?: string;
  hasDefault: boolean;
  default?: unknown;
  enum?: unknown[];
  description?: string;
  /** Body parameters only: the dereferenced schema root; never copied into a definition. */
  schema?: unknown;
  pointer: string;
  extensions: Record<string, unknown>;
  /** Indexed nodes inside a body schema (extensions, password formats, defaults). */
  nested: SchemaNode[];
}

export interface WalkedResponse {
  status: string;
  description?: string;
  schema?: unknown;
  headers: string[];
  pointer: string;
  extensions: Record<string, unknown>;
  nested: SchemaNode[];
}

/** One Security Requirement Object (AND of schemes); a list of them is OR. */
export interface SecurityAlternative {
  schemes: Array<{ scheme: string; scopes: string[]; known: boolean }>;
  pointer: string;
}

export interface WalkedOperation {
  nativeId: string;
  identity: "operationId" | "method-path";
  /** Another operation declares the same operationId; references to it are refused. */
  ambiguous: boolean;
  /** The contested operationId, when ambiguity forced a method-and-path identity. */
  declaredOperationId?: string;
  method: HttpMethod;
  path: string;
  pointer: string;
  summary?: string;
  description?: string;
  deprecated: boolean;
  tags: string[];
  consumes: string[];
  produces: string[];
  parameters: WalkedParameter[];
  responses: WalkedResponse[];
  security: {
    source: "operation" | "document" | "none";
    alternatives: SecurityAlternative[];
  };
  extensions: Record<string, unknown>;
  /** Extensions on the enclosing Path Item (x-ms-notification-content lives there). */
  pathItemExtensions: Record<string, unknown>;
}

export interface WalkedSecurityDefinition {
  name: string;
  type: string;
  pointer: string;
  in?: string;
  parameterName?: string;
  flow?: string;
  authorizationUrl?: string;
  tokenUrl?: string;
  scopes: Record<string, string>;
  description?: string;
  extensions: Record<string, unknown>;
}

export interface SwaggerWalk {
  version: "2.0";
  info: { title: string; version: string; description?: string };
  host?: string;
  basePath?: string;
  schemes: string[];
  consumes: string[];
  produces: string[];
  securityDefinitions: Record<string, WalkedSecurityDefinition>;
  documentSecurity: SecurityAlternative[] | undefined;
  operations: WalkedOperation[];
  extensions: Record<string, unknown>;
}

export type SwaggerWalkResult =
  | { ok: true; walk: SwaggerWalk; issues: CompatibilityIssue[] }
  | { ok: false; issues: CompatibilityIssue[] };

type JsonObject = Record<string, unknown>;
const isObject = (value: unknown): value is JsonObject =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const methodKeys: Record<string, HttpMethod> = {
  get: "GET",
  put: "PUT",
  post: "POST",
  delete: "DELETE",
  options: "OPTIONS",
  head: "HEAD",
  patch: "PATCH",
};
const locations = new Set<string>([
  "path",
  "query",
  "header",
  "formData",
  "body",
]);
const NAME = /^[^\p{Cc}]{1,256}$/u;
const PATH = /^\/[^\p{Cc}?#\s]*$/u;
const STATUS = /^(default|[1-5]\d\d|[1-5]XX)$/;

const stringList = (value: unknown, max = 32): string[] =>
  Array.isArray(value)
    ? value
        .filter((item): item is string => typeof item === "string")
        .slice(0, max)
        .map((item) => safeText(item, 200))
    : [];

const optionalText = (value: unknown, max: number) =>
  typeof value === "string" && value.length
    ? { text: safeText(value, max) }
    : undefined;

type Deref = (
  node: unknown,
  at: string,
  seen?: readonly string[],
) => { value: unknown; pointer: string } | undefined;

function createDeref(document: JsonObject, issues: IssueList): Deref {
  const decode = (segment: string) =>
    segment.replaceAll("~1", "/").replaceAll("~0", "~");
  const deref: Deref = (node, at, seen = []) => {
    if (!isObject(node) || typeof node.$ref !== "string")
      return { value: node, pointer: at };
    const ref = node.$ref;
    if (!ref.startsWith("#/") || ref.length > 1024) {
      issues.push({
        code: "structure.remote-reference",
        category: "structure",
        pointer: at,
        dimension: "import",
        severity: "blocking",
        disposition: "unsupported",
        executionImpact: "blocks-operation",
        message:
          "Only local references inside the document are resolved; remote or relative references are never fetched during import.",
        remediation: "Inline the referenced definition or bundle it locally.",
      });
      return undefined;
    }
    if (seen.includes(ref) || seen.length >= SWAGGER_WALK_LIMITS.refDepth) {
      issues.push({
        code: "structure.reference-cycle",
        category: "structure",
        pointer: at,
        dimension: "import",
        severity: "blocking",
        disposition: "unsupported",
        executionImpact: "blocks-operation",
        message:
          "The reference chain is cyclic or deeper than the import allows.",
      });
      return undefined;
    }
    let current: unknown = document;
    for (const raw of ref.slice(2).split("/")) {
      const key = decode(raw);
      if (isReservedObjectKey(key)) return unresolved(issues, at);
      if (Array.isArray(current)) {
        if (!/^\d{1,6}$/.test(key)) return unresolved(issues, at);
        current = current[Number(key)];
      } else if (isObject(current)) current = current[key];
      else return unresolved(issues, at);
      if (current === undefined) return unresolved(issues, at);
    }
    return deref(current, ref, [...seen, ref]);
  };
  return deref;
}

function unresolved(issues: IssueList, at: string): undefined {
  issues.push({
    code: "structure.unresolved-reference",
    category: "structure",
    pointer: at,
    dimension: "import",
    severity: "blocking",
    disposition: "rejected",
    executionImpact: "blocks-operation",
    message: "A local reference points at nothing in this document.",
  });
  return undefined;
}

/** Vendor extensions of one node, each measured before it is kept. */
export function collectExtensions(
  node: JsonObject,
  at: string,
  issues: IssueList,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  let count = 0;
  for (const [key, value] of Object.entries(node)) {
    if (!key.startsWith("x-") || key.length > 120 || /\p{Cc}/u.test(key))
      continue;
    if (++count > SWAGGER_WALK_LIMITS.extensionKeys) {
      issues.push({
        code: "structure.extension-count",
        category: "structure",
        pointer: at,
        dimension: "import",
        severity: "warning",
        disposition: "adapted",
        message: `More than ${SWAGGER_WALK_LIMITS.extensionKeys} extensions on one node; the rest are not preserved.`,
      });
      break;
    }
    const measured = measureJsonValue(
      value,
      SWAGGER_WALK_LIMITS.extensionValue,
    );
    if (measured.ok) out[key] = value;
    else {
      out[key] = { $truncated: measured.reason };
      issues.push({
        code: "structure.extension-truncated",
        category: "structure",
        pointer: `${at}/${key}`,
        dimension: "import",
        severity: "warning",
        disposition: "adapted",
        message: `Extension ${token(key)} exceeds preservation bounds (${measured.reason}) and is kept as a marker only.`,
      });
    }
  }
  return out;
}

function walkSchemaNodes(
  root: unknown,
  rootPointer: string,
  deref: Deref,
  budget: { nodes: number },
  out: SchemaNode[],
  issues: IssueList,
): void {
  type Frame = {
    schema: unknown;
    pointer: string;
    pathString: string;
    required: boolean;
    depth: number;
    seen: readonly string[];
  };
  const stack: Frame[] = [
    {
      schema: root,
      pointer: rootPointer,
      pathString: "",
      required: false,
      depth: 0,
      seen: [],
    },
  ];
  while (stack.length) {
    const frame = stack.pop()!;
    if (budget.nodes-- <= 0) {
      issues.push({
        code: "structure.schema-bounds",
        category: "structure",
        pointer: rootPointer,
        dimension: "import",
        severity: "warning",
        disposition: "adapted",
        message:
          "Schema indexing stopped at the node limit; extensions beyond it are not indexed.",
      });
      return;
    }
    if (frame.depth > SWAGGER_WALK_LIMITS.schemaDepth) {
      issues.push({
        code: "structure.schema-depth",
        category: "structure",
        pointer: frame.pointer,
        dimension: "import",
        severity: "warning",
        disposition: "adapted",
        message: `Schema nesting deeper than ${SWAGGER_WALK_LIMITS.schemaDepth} levels is not indexed.`,
      });
      continue;
    }
    let seen = frame.seen;
    if (isObject(frame.schema) && typeof frame.schema.$ref === "string") {
      if (seen.includes(frame.schema.$ref)) {
        // A recursive schema is valid; indexing simply stops at the repetition.
        issues.push({
          code: "structure.recursive-schema",
          category: "schema",
          pointer: frame.pointer,
          dimension: "import",
          severity: "info",
          disposition: "exact",
          message:
            "Recursive schema detected; nested extension indexing stops at the first repetition.",
        });
        continue;
      }
      seen = [...seen, frame.schema.$ref];
    }
    const resolved = deref(frame.schema, frame.pointer, frame.seen);
    if (!resolved || !isObject(resolved.value)) continue;
    const schema = resolved.value;
    const extensions = collectExtensions(schema, resolved.pointer, issues);
    const hasDefault = Object.hasOwn(schema, "default");
    if (
      Object.keys(extensions).length ||
      schema.format === "password" ||
      hasDefault
    )
      out.push({
        pathString: frame.pathString,
        pointer: resolved.pointer,
        ...(typeof schema.type === "string" ? { type: schema.type } : {}),
        ...(typeof schema.format === "string" ? { format: schema.format } : {}),
        required: frame.required,
        hasDefault,
        ...(hasDefault ? { default: schema.default } : {}),
        extensions,
      });
    const requiredNames = new Set(stringList(schema.required, 256));
    if (isObject(schema.properties))
      for (const [name, child] of Object.entries(schema.properties)) {
        if (isReservedObjectKey(name) || !NAME.test(name)) continue;
        stack.push({
          schema: child,
          pointer: `${resolved.pointer}/properties/${escapeSegment(name)}`,
          pathString: frame.pathString ? `${frame.pathString}/${name}` : name,
          required: requiredNames.has(name),
          depth: frame.depth + 1,
          seen,
        });
      }
    if (schema.items !== undefined)
      stack.push({
        schema: schema.items,
        pointer: `${resolved.pointer}/items`,
        pathString: frame.pathString ? `${frame.pathString}/items` : "items",
        required: false,
        depth: frame.depth + 1,
        seen,
      });
    if (Array.isArray(schema.allOf))
      schema.allOf.slice(0, 16).forEach((part, index) =>
        stack.push({
          schema: part,
          pointer: `${resolved.pointer}/allOf/${index}`,
          pathString: frame.pathString,
          required: frame.required,
          depth: frame.depth + 1,
          seen,
        }),
      );
  }
}

const escapeSegment = (segment: string) =>
  segment.replaceAll("~", "~0").replaceAll("/", "~1");

export function walkSwagger(document: unknown): SwaggerWalkResult {
  const issues = new IssueList();
  const measured = measureJsonValue(document, SWAGGER_WALK_LIMITS.document);
  if (!measured.ok) {
    issues.push({
      code: "structure.document-bounds",
      category: "structure",
      pointer: "#",
      dimension: "import",
      severity: "blocking",
      disposition: "rejected",
      executionImpact: "blocks-definition",
      message: `The API definition exceeds import bounds (${measured.reason}).`,
    });
    return { ok: false, issues: issues.toArray() };
  }
  if (!isObject(document)) {
    issues.push({
      code: "structure.not-an-object",
      category: "structure",
      pointer: "#",
      dimension: "import",
      severity: "blocking",
      disposition: "rejected",
      executionImpact: "blocks-definition",
      message: "The API definition is not a JSON object.",
    });
    return { ok: false, issues: issues.toArray() };
  }
  if (document.swagger !== "2.0") {
    issues.push(
      typeof document.openapi === "string"
        ? {
            code: "version.openapi-3-unsupported",
            category: "version",
            pointer: "#/openapi",
            dimension: "import",
            severity: "blocking",
            disposition: "unsupported",
            executionImpact: "blocks-definition",
            message:
              "Power Platform custom connectors accept OpenAPI 2.0 (Swagger) definitions only; an OpenAPI 3.x document is not a custom connector definition.",
            remediation:
              "Import the document through the generic OpenAPI reader, or convert it to Swagger 2.0 first.",
          }
        : {
            code: "version.unrecognized",
            category: "version",
            pointer: "#/swagger",
            dimension: "import",
            severity: "blocking",
            disposition: "rejected",
            executionImpact: "blocks-definition",
            message: 'The document does not declare "swagger": "2.0".',
          },
    );
    return { ok: false, issues: issues.toArray() };
  }
  const deref = createDeref(document, issues);
  const info = isObject(document.info) ? document.info : {};
  const title = safeText(info.title, 200) || "Custom connector";
  if (!safeText(info.title, 200))
    issues.push({
      code: "structure.info-title-missing",
      category: "structure",
      pointer: "#/info/title",
      dimension: "import",
      severity: "warning",
      disposition: "adapted",
      message: "The definition has no title; a placeholder name is used.",
    });
  const version = safeText(info.version, 128) || "unversioned";
  const description = optionalText(info.description, 500);

  const securityDefinitions: Record<string, WalkedSecurityDefinition> = {};
  if (isObject(document.securityDefinitions))
    for (const [name, raw] of Object.entries(
      document.securityDefinitions,
    ).slice(0, SWAGGER_WALK_LIMITS.securityDefinitions)) {
      if (!isObject(raw) || isReservedObjectKey(name) || !NAME.test(name))
        continue;
      const at = pointer("securityDefinitions", name);
      const scopes: Record<string, string> = {};
      if (isObject(raw.scopes))
        for (const [scope, text] of Object.entries(raw.scopes).slice(0, 64))
          if (!isReservedObjectKey(scope) && NAME.test(scope))
            scopes[scope] = safeText(text, 200);
      const desc = optionalText(raw.description, 500);
      securityDefinitions[name] = {
        name,
        type: typeof raw.type === "string" ? safeText(raw.type, 32) : "unknown",
        pointer: at,
        ...(typeof raw.in === "string" ? { in: safeText(raw.in, 16) } : {}),
        ...(typeof raw.name === "string"
          ? { parameterName: safeText(raw.name, 120) }
          : {}),
        ...(typeof raw.flow === "string"
          ? { flow: safeText(raw.flow, 32) }
          : {}),
        ...(typeof raw.authorizationUrl === "string"
          ? { authorizationUrl: raw.authorizationUrl.slice(0, 2048) }
          : {}),
        ...(typeof raw.tokenUrl === "string"
          ? { tokenUrl: raw.tokenUrl.slice(0, 2048) }
          : {}),
        scopes,
        ...(desc ? { description: desc.text } : {}),
        extensions: collectExtensions(raw, at, issues),
      };
    }

  const readSecurity = (
    value: unknown,
    at: string,
  ): SecurityAlternative[] | undefined => {
    if (!Array.isArray(value)) return undefined;
    return value.slice(0, 32).map((alternative, index) => ({
      pointer: `${at}/${index}`,
      schemes: isObject(alternative)
        ? Object.entries(alternative)
            .slice(0, 16)
            .map(([scheme, scopes]) => {
              const known = Object.hasOwn(securityDefinitions, scheme);
              if (!known)
                issues.push({
                  code: "security.unknown-scheme",
                  category: "security",
                  pointer: `${at}/${index}`,
                  dimension: "authorize",
                  severity: "blocking",
                  disposition: "rejected",
                  executionImpact: "blocks-operation",
                  message: `Security requirement names ${token(scheme)}, which securityDefinitions does not declare.`,
                });
              return {
                scheme: safeText(scheme, 120),
                scopes: stringList(scopes, 64),
                known,
              };
            })
        : [],
    }));
  };
  const documentSecurity = readSecurity(document.security, "#/security");

  const documentConsumes = stringList(document.consumes, 16);
  const documentProduces = stringList(document.produces, 16);
  const operations: WalkedOperation[] = [];
  const operationIds = new Map<string, WalkedOperation[]>();
  const paths = isObject(document.paths) ? document.paths : {};
  if (!isObject(document.paths))
    issues.push({
      code: "structure.paths-missing",
      category: "structure",
      pointer: "#/paths",
      dimension: "import",
      severity: "warning",
      disposition: "adapted",
      message: "The definition declares no paths.",
    });
  const pathEntries = Object.entries(paths);
  if (pathEntries.length > SWAGGER_WALK_LIMITS.paths)
    issues.push({
      code: "structure.path-count",
      category: "structure",
      pointer: "#/paths",
      dimension: "import",
      severity: "warning",
      disposition: "adapted",
      message: `Only the first ${SWAGGER_WALK_LIMITS.paths} paths are imported.`,
    });
  for (const [path, rawItem] of pathEntries.slice(
    0,
    SWAGGER_WALK_LIMITS.paths,
  )) {
    const itemPointer = pointer("paths", path);
    if (!PATH.test(path) || path.length > 1024) {
      issues.push({
        code: "structure.invalid-path",
        category: "structure",
        pointer: itemPointer,
        dimension: "import",
        severity: "blocking",
        disposition: "rejected",
        executionImpact: "blocks-operation",
        message:
          "A path must be a single absolute template without query, fragment or control characters.",
      });
      continue;
    }
    const resolvedItem = deref(rawItem, itemPointer);
    if (!resolvedItem || !isObject(resolvedItem.value)) continue;
    const item = resolvedItem.value;
    const pathItemExtensions = collectExtensions(item, itemPointer, issues);
    const itemParameters = Array.isArray(item.parameters)
      ? item.parameters.slice(0, SWAGGER_WALK_LIMITS.parameters)
      : [];
    const templateParameters = [...path.matchAll(/\{([^{}]+)\}/g)].map(
      (match) => match[1] ?? "",
    );
    for (const [key, method] of Object.entries(methodKeys)) {
      const rawOperation = item[key];
      if (rawOperation === undefined) continue;
      const at = `${itemPointer}/${key}`;
      if (operations.length >= SWAGGER_WALK_LIMITS.operations) {
        issues.push({
          code: "structure.operation-count",
          category: "structure",
          pointer: at,
          dimension: "import",
          severity: "warning",
          disposition: "adapted",
          message: `Only the first ${SWAGGER_WALK_LIMITS.operations} operations are imported.`,
        });
        break;
      }
      if (!isObject(rawOperation)) continue;
      const budget = { nodes: SWAGGER_WALK_LIMITS.schemaNodes };
      const parameters = new Map<string, WalkedParameter>();
      const readParameter = (raw: unknown, parameterPointer: string) => {
        const resolved = deref(raw, parameterPointer);
        if (!resolved || !isObject(resolved.value)) return;
        const parameter = resolved.value;
        const name = parameter.name;
        const location = parameter.in;
        if (
          typeof name !== "string" ||
          !NAME.test(name) ||
          isReservedObjectKey(name) ||
          typeof location !== "string" ||
          !locations.has(location)
        ) {
          issues.push({
            code: "structure.invalid-parameter",
            category: "structure",
            pointer: resolved.pointer,
            dimension: "import",
            severity: "blocking",
            disposition: "rejected",
            executionImpact: "blocks-operation",
            message:
              "A parameter needs a valid name and a Swagger 2.0 location.",
          });
          return;
        }
        const nested: SchemaNode[] = [];
        if (location === "body" && parameter.schema !== undefined)
          walkSchemaNodes(
            parameter.schema,
            `${resolved.pointer}/schema`,
            deref,
            budget,
            nested,
            issues,
          );
        const hasDefault = Object.hasOwn(parameter, "default");
        const desc = optionalText(parameter.description, 500);
        const items = isObject(parameter.items)
          ? {
              ...(typeof parameter.items.type === "string"
                ? { type: safeText(parameter.items.type, 32) }
                : {}),
              ...(typeof parameter.items.format === "string"
                ? { format: safeText(parameter.items.format, 32) }
                : {}),
            }
          : undefined;
        parameters.set(JSON.stringify([location, name]), {
          name,
          in: location as SwaggerParameterLocation,
          required: parameter.required === true || location === "path",
          ...(typeof parameter.type === "string"
            ? { type: safeText(parameter.type, 32) }
            : {}),
          ...(typeof parameter.format === "string"
            ? { format: safeText(parameter.format, 32) }
            : {}),
          ...(items ? { items } : {}),
          ...(typeof parameter.collectionFormat === "string"
            ? { collectionFormat: safeText(parameter.collectionFormat, 16) }
            : {}),
          hasDefault,
          ...(hasDefault ? { default: parameter.default } : {}),
          ...(Array.isArray(parameter.enum)
            ? { enum: parameter.enum.slice(0, 256) }
            : {}),
          ...(desc ? { description: desc.text } : {}),
          ...(location === "body" && parameter.schema !== undefined
            ? { schema: parameter.schema }
            : {}),
          pointer: resolved.pointer,
          extensions: collectExtensions(parameter, resolved.pointer, issues),
          nested,
        });
      };
      itemParameters.forEach((raw, index) =>
        readParameter(raw, `${itemPointer}/parameters/${index}`),
      );
      if (Array.isArray(rawOperation.parameters)) {
        if (rawOperation.parameters.length > SWAGGER_WALK_LIMITS.parameters)
          issues.push({
            code: "structure.parameter-count",
            category: "structure",
            pointer: `${at}/parameters`,
            dimension: "import",
            severity: "blocking",
            disposition: "rejected",
            executionImpact: "blocks-operation",
            message: `An operation may declare at most ${SWAGGER_WALK_LIMITS.parameters} parameters.`,
          });
        rawOperation.parameters
          .slice(0, SWAGGER_WALK_LIMITS.parameters)
          .forEach((raw, index) =>
            readParameter(raw, `${at}/parameters/${index}`),
          );
      }
      for (const templateName of templateParameters)
        if (!parameters.has(JSON.stringify(["path", templateName])))
          issues.push({
            code: "structure.path-parameter-undeclared",
            category: "structure",
            pointer: at,
            dimension: "invoke",
            severity: "blocking",
            disposition: "rejected",
            executionImpact: "blocks-operation",
            message: `Path template names ${token(templateName)} but no path parameter declares it.`,
          });
      const responses: WalkedResponse[] = [];
      if (isObject(rawOperation.responses))
        for (const [status, raw] of Object.entries(
          rawOperation.responses,
        ).slice(0, SWAGGER_WALK_LIMITS.responses)) {
          if (!STATUS.test(status)) continue;
          const responsePointer = `${at}/responses/${status}`;
          const resolved = deref(raw, responsePointer);
          if (!resolved || !isObject(resolved.value)) continue;
          const response = resolved.value;
          const nested: SchemaNode[] = [];
          if (response.schema !== undefined)
            walkSchemaNodes(
              response.schema,
              `${resolved.pointer}/schema`,
              deref,
              budget,
              nested,
              issues,
            );
          const desc = optionalText(response.description, 500);
          responses.push({
            status,
            ...(desc ? { description: desc.text } : {}),
            ...(response.schema !== undefined
              ? { schema: response.schema }
              : {}),
            headers: isObject(response.headers)
              ? Object.keys(response.headers)
                  .filter((name) => NAME.test(name))
                  .slice(0, 32)
              : [],
            pointer: resolved.pointer,
            extensions: collectExtensions(response, resolved.pointer, issues),
            nested,
          });
        }
      const operationSecurity = readSecurity(
        rawOperation.security,
        `${at}/security`,
      );
      const rawId = rawOperation.operationId;
      const validId =
        typeof rawId === "string" &&
        NAME.test(rawId) &&
        rawId.trim().length > 0 &&
        rawId.length <= 512 &&
        !isReservedObjectKey(rawId);
      if (rawId !== undefined && !validId)
        issues.push({
          code: "structure.invalid-operation-id",
          category: "structure",
          pointer: `${at}/operationId`,
          dimension: "import",
          severity: "warning",
          disposition: "adapted",
          message:
            "The operationId is not a usable identifier; the method and path identify the operation.",
        });
      const summary = optionalText(rawOperation.summary, 200);
      const operationDescription = optionalText(rawOperation.description, 500);
      const operation: WalkedOperation = {
        nativeId: validId ? (rawId as string) : `${method} ${path}`,
        identity: validId ? "operationId" : "method-path",
        ambiguous: false,
        method,
        path,
        pointer: at,
        ...(summary ? { summary: summary.text } : {}),
        ...(operationDescription
          ? { description: operationDescription.text }
          : {}),
        deprecated: rawOperation.deprecated === true,
        tags: stringList(rawOperation.tags, 16),
        consumes: Array.isArray(rawOperation.consumes)
          ? stringList(rawOperation.consumes, 16)
          : documentConsumes,
        produces: Array.isArray(rawOperation.produces)
          ? stringList(rawOperation.produces, 16)
          : documentProduces,
        parameters: [...parameters.values()],
        responses,
        security: operationSecurity
          ? { source: "operation", alternatives: operationSecurity }
          : documentSecurity
            ? { source: "document", alternatives: documentSecurity }
            : { source: "none", alternatives: [] },
        extensions: collectExtensions(rawOperation, at, issues),
        pathItemExtensions,
      };
      if (validId) {
        const list = operationIds.get(operation.nativeId) ?? [];
        list.push(operation);
        operationIds.set(operation.nativeId, list);
      }
      operations.push(operation);
    }
  }
  for (const [id, list] of operationIds)
    if (list.length > 1)
      for (const operation of list) {
        // Both operations stay described and stay distinct: the contested
        // operationId is remembered for diagnostics, but each operation is
        // identified by its own method and path, and nothing may bind to the
        // ambiguous name.
        operation.ambiguous = true;
        operation.declaredOperationId = id;
        operation.nativeId = `${operation.method} ${operation.path}`;
        operation.identity = "method-path";
        issues.push({
          code: "structure.duplicate-operation-id",
          category: "structure",
          pointer: operation.pointer,
          dimension: "import",
          severity: "blocking",
          disposition: "rejected",
          executionImpact: "blocks-operation",
          message: `operationId ${token(id)} is declared by ${list.length} operations; references to it are ambiguous, so each is identified by its method and path instead and none may be bound under that name.`,
        });
      }

  const host =
    typeof document.host === "string" ? safeText(document.host, 253) : "";
  const basePath =
    typeof document.basePath === "string"
      ? safeText(document.basePath, 512)
      : "";
  const walk: SwaggerWalk = {
    version: "2.0",
    info: {
      title,
      version,
      ...(description ? { description: description.text } : {}),
    },
    ...(host ? { host } : {}),
    ...(basePath ? { basePath } : {}),
    schemes: stringList(document.schemes, 4),
    consumes: documentConsumes,
    produces: documentProduces,
    securityDefinitions,
    documentSecurity,
    operations,
    extensions: collectExtensions(document, "#", issues),
  };
  return { ok: true, walk, issues: issues.toArray() };
}
