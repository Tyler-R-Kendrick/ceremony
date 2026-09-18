import { createHash } from "node:crypto";
import {
  DEFINITION_LIMITS,
  canonicalConnectorJson,
  completeDimensions,
  nativeIdentifierSchema,
  normalizedDefinitionSchema,
  type AuthenticationProfile,
  type ConnectorSourceIdentity,
  type EventDescriptor,
  type NativeCapability,
  type NormalizedDefinition,
} from "../../../../core/connectors/index.js";
import {
  IssueCollector,
  makeIssue,
  pointer as jsonPointer,
  safeText,
  token,
  type IssueInput,
} from "./issues.js";
import {
  READER_ID,
  READER_VERSION,
  type OpenApiProfile,
  type ReadFailure,
  type ReadInfo,
  type ReadMediaType,
  type ReadOperation,
  type ReadParameter,
  type ReadRequestBody,
  type ReadResponse,
  type ReadResult,
  type ReadSecurityScheme,
  type ReadServer,
  type SecurityRequirement,
} from "./model.js";
import {
  DEFAULT_REFERENCE_LIMITS,
  ReferenceBudgetExceeded,
  ReferenceResolver,
  entriesOf,
  isRecord,
  prefetchExternalReferences,
  type ExternalResolver,
  type ReferenceLimits,
} from "./refs.js";
import {
  EXECUTABLE_PROFILE_KINDS,
  effectiveSecurity,
  extensionsOf,
  normalizeRequirements,
  readSecurityScheme,
  securityRequirementsFor,
} from "./security.js";

/*
 * Four readers, one walker. The version field selects the reader; nothing is
 * inferred from the shape of the document when the field is missing or names
 * a version this module does not implement. Each reader knows which path item
 * keys are operations, where security schemes live, how bodies are described,
 * and which schema dialect its Schema Objects use. The walker produces a read
 * model and a normalized definition; it never produces anything executable.
 */

export interface ReadOptions {
  sourceRef?: string;
  definitionRef?: string;
  identityHint?: Partial<ConnectorSourceIdentity>;
  /** Directory grouping key; defaults to a slug of the title. */
  service?: string;
  resolveExternal?: ExternalResolver;
  limits?: Partial<ReferenceLimits>;
}

type SyncOptions = ReadOptions & { external?: Map<string, unknown> };

export type VersionDetection =
  | { profile: OpenApiProfile; version: string }
  | { profile: undefined; issue: IssueInput };

const VERSION_PATTERN = /^3\.([012])\.[0-9]+(?:-[0-9A-Za-z.-]+)?$/;

/** The version field alone decides the reader. Missing, doubled or unknown versions are refused. */
export function detectOpenApiVersion(document: unknown): VersionDetection {
  if (!isRecord(document))
    return {
      profile: undefined,
      issue: {
        code: "structure.not-an-object",
        category: "structure",
        pointer: "#",
        dimension: "import",
        severity: "blocking",
        disposition: "rejected",
        executionImpact: "blocks-definition",
        message: "The document is not a JSON object and cannot be read as an OpenAPI description.",
      },
    };
  const hasSwagger = Object.hasOwn(document, "swagger");
  const hasOpenapi = Object.hasOwn(document, "openapi");
  if (hasSwagger && hasOpenapi)
    return {
      profile: undefined,
      issue: {
        code: "version.ambiguous",
        category: "version",
        pointer: "#",
        dimension: "import",
        severity: "blocking",
        disposition: "rejected",
        executionImpact: "blocks-definition",
        message: "The document declares both `swagger` and `openapi`; the version is ambiguous and is not guessed.",
      },
    };
  if (hasSwagger) {
    if (document.swagger === "2.0") return { profile: "swagger-2.0", version: "2.0" };
    return {
      profile: undefined,
      issue: {
        code: "version.unsupported",
        category: "version",
        pointer: "#/swagger",
        dimension: "import",
        severity: "blocking",
        disposition: "unsupported",
        executionImpact: "blocks-definition",
        message: `The Swagger version "${token(document.swagger, 16)}" is not supported; only 2.0 is read.`,
      },
    };
  }
  if (hasOpenapi) {
    const value = document.openapi;
    const match = typeof value === "string" ? VERSION_PATTERN.exec(value) : null;
    if (match) {
      const minor = match[1]!;
      const profile: OpenApiProfile =
        minor === "0" ? "openapi-3.0" : minor === "1" ? "openapi-3.1" : "openapi-3.2";
      return { profile, version: value as string };
    }
    return {
      profile: undefined,
      issue: {
        code: "version.unsupported",
        category: "version",
        pointer: "#/openapi",
        dimension: "import",
        severity: "blocking",
        disposition: "unsupported",
        executionImpact: "blocks-definition",
        message: `The OpenAPI version "${token(value, 16)}" is not supported; 3.0.x, 3.1.x and 3.2.x are read.`,
      },
    };
  }
  return {
    profile: undefined,
    issue: {
      code: "version.missing",
      category: "version",
      pointer: "#",
      dimension: "import",
      severity: "blocking",
      disposition: "rejected",
      executionImpact: "blocks-definition",
      message: "The document declares neither `openapi` nor `swagger`; the version is not guessed.",
    },
  };
}

interface ProfileRules {
  profile: OpenApiProfile;
  /** Path item keys that hold operations, in the order they are read. */
  methods: readonly string[];
  additionalOperations: boolean;
  webhooks: boolean;
  parameterLocations: readonly string[];
  bodyModel: "parameter" | "requestBody";
  defaultDialect: (document: Record<string, unknown>) => string;
}

const swagger2Rules: ProfileRules = {
  profile: "swagger-2.0",
  methods: ["get", "put", "post", "delete", "options", "head", "patch"],
  additionalOperations: false,
  webhooks: false,
  parameterLocations: ["query", "header", "path", "formData", "body"],
  bodyModel: "parameter",
  defaultDialect: () => "swagger-2.0-schema-object (JSON Schema draft-04 subset)",
};
const openapi30Rules: ProfileRules = {
  profile: "openapi-3.0",
  methods: ["get", "put", "post", "delete", "options", "head", "patch", "trace"],
  additionalOperations: false,
  webhooks: false,
  parameterLocations: ["query", "header", "path", "cookie"],
  bodyModel: "requestBody",
  defaultDialect: () => "openapi-3.0-schema-object (JSON Schema draft-05 subset with OAS keywords)",
};
const openapi31Rules: ProfileRules = {
  profile: "openapi-3.1",
  methods: ["get", "put", "post", "delete", "options", "head", "patch", "trace"],
  additionalOperations: false,
  webhooks: true,
  parameterLocations: ["query", "header", "path", "cookie"],
  bodyModel: "requestBody",
  defaultDialect: (document) =>
    typeof document.jsonSchemaDialect === "string"
      ? safeText(document.jsonSchemaDialect, 120)
      : "https://spec.openapis.org/oas/3.1/dialect/base",
};
const openapi32Rules: ProfileRules = {
  profile: "openapi-3.2",
  methods: ["get", "put", "post", "delete", "options", "head", "patch", "trace", "query"],
  additionalOperations: true,
  webhooks: true,
  parameterLocations: ["query", "querystring", "header", "path", "cookie"],
  bodyModel: "requestBody",
  defaultDialect: (document) =>
    typeof document.jsonSchemaDialect === "string"
      ? safeText(document.jsonSchemaDialect, 120)
      : "openapi-3.2-default-dialect (JSON Schema 2020-12 with OAS 3.2 vocabulary)",
};

const rulesFor: Record<OpenApiProfile, ProfileRules> = {
  "swagger-2.0": swagger2Rules,
  "openapi-3.0": openapi30Rules,
  "openapi-3.1": openapi31Rules,
  "openapi-3.2": openapi32Rules,
};

/** Dialects whose keyword semantics the compiled subset implements. */
const knownDialects = new Set([
  "https://spec.openapis.org/oas/3.1/dialect/base",
  "https://json-schema.org/draft/2020-12/schema",
]);

function shortHash(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 16);
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function slug(value: string): string {
  const cleaned = value
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^[^a-z0-9]+/, "")
    .replace(/-+$/, "")
    .slice(0, 120);
  return /^[a-z0-9][a-z0-9._-]*$/.test(cleaned) ? cleaned : "openapi";
}

function readInfo(document: Record<string, unknown>, issues: IssueCollector): ReadInfo {
  const info = isRecord(document.info) ? document.info : {};
  const title = safeText(info.title, 200);
  const version = safeText(info.version, 128);
  if (!title || !version)
    issues.add({
      code: "structure.info-incomplete",
      category: "structure",
      pointer: "#/info",
      dimension: "import",
      severity: "warning",
      message: "The info object lacks a title or version; placeholders are used for display and identity.",
    });
  const description = safeText(info.description, 500);
  return {
    title: title || "Untitled API",
    version: version || "unversioned",
    ...(description ? { description } : {}),
  };
}

function readServerObject(
  raw: unknown,
  pointer: string,
  issues: IssueCollector,
): ReadServer | undefined {
  if (!isRecord(raw) || typeof raw.url !== "string" || raw.url.length === 0) {
    issues.add({
      code: "structure.invalid-server",
      category: "structure",
      pointer,
      dimension: "import",
      severity: "warning",
      message: "A server entry has no URL string and was skipped.",
    });
    return undefined;
  }
  const url = safeText(raw.url, 2048);
  if (!url) return undefined;
  const variables: ReadServer["variables"] = {};
  if (isRecord(raw.variables))
    for (const [name, value] of entriesOf(raw.variables).slice(0, 32)) {
      if (!isRecord(value)) continue;
      const fallback = safeText(value.default, 256);
      const options = Array.isArray(value.enum)
        ? value.enum.filter((item): item is string => typeof item === "string").map((item) => safeText(item, 256))
        : undefined;
      variables[name] = { default: fallback, ...(options ? { enum: options } : {}) };
    }
  const description = safeText(raw.description, 500);
  return { url, ...(description ? { description } : {}), variables, pointer };
}

function readServers(raw: unknown, pointer: string, issues: IssueCollector): ReadServer[] {
  if (raw === undefined) return [];
  if (!Array.isArray(raw)) {
    issues.add({
      code: "structure.invalid-server",
      category: "structure",
      pointer,
      dimension: "import",
      severity: "warning",
      message: "The servers field is not a list and was ignored.",
    });
    return [];
  }
  return raw
    .slice(0, 32)
    .map((item, index) => readServerObject(item, `${pointer}/${index}`, issues))
    .filter((item): item is ReadServer => item !== undefined);
}

function swagger2Servers(
  document: Record<string, unknown>,
  schemes: unknown,
  issues: IssueCollector,
  pointer: string,
): ReadServer[] {
  const host = typeof document.host === "string" ? safeText(document.host, 256) : "";
  const basePath = typeof document.basePath === "string" ? safeText(document.basePath, 512) : "";
  const list = Array.isArray(schemes)
    ? schemes.filter((item): item is string => typeof item === "string")
    : [];
  if (host && !/^[A-Za-z0-9.-]+(?::[0-9]{1,5})?$|^\[[0-9A-Fa-f:.]+\](?::[0-9]{1,5})?$/.test(host)) {
    issues.add({
      code: "structure.invalid-host",
      category: "structure",
      pointer: "#/host",
      dimension: "import",
      severity: "warning",
      message: "The host field is not a host[:port] value; no server is declared from it.",
    });
    return [];
  }
  const path = basePath && basePath !== "/" ? basePath : "";
  if (!host) {
    if (!path) return [];
    issues.add({
      code: "structure.server-relative",
      category: "structure",
      pointer: "#/basePath",
      dimension: "import",
      severity: "info",
      message: "The document declares a base path without a host; the declared server is relative to wherever the description was served from.",
    });
    return [{ url: path, variables: {}, pointer }];
  }
  if (list.length === 0) {
    issues.add({
      code: "structure.server-scheme-unspecified",
      category: "structure",
      pointer: "#/schemes",
      dimension: "import",
      severity: "info",
      message: "The document declares no transfer scheme; the declared server is scheme-relative and no scheme is assumed.",
    });
    return [{ url: `//${host}${path}`, variables: {}, pointer }];
  }
  const servers: ReadServer[] = [];
  for (const scheme of list) {
    if (scheme === "http" || scheme === "https")
      servers.push({ url: `${scheme}://${host}${path}`, variables: {}, pointer });
    else
      issues.add({
        code: "network.unsupported-scheme",
        category: "network",
        pointer: "#/schemes",
        dimension: "invoke",
        severity: "info",
        message: `The transfer scheme "${token(scheme, 8)}" is not an HTTP scheme; no server is declared from it.`,
      });
  }
  return servers;
}

const parameterSchemaKeys = new Set([
  "type",
  "format",
  "items",
  "default",
  "maximum",
  "exclusiveMaximum",
  "minimum",
  "exclusiveMinimum",
  "maxLength",
  "minLength",
  "pattern",
  "maxItems",
  "minItems",
  "uniqueItems",
  "enum",
  "multipleOf",
]);

interface WalkContext {
  rules: ProfileRules;
  document: Record<string, unknown>;
  resolver: ReferenceResolver;
  issues: IssueCollector;
  schemes: Record<string, ReadSecurityScheme>;
  documentSecurity: SecurityRequirement[] | undefined;
  documentServers: ReadServer[];
  consumes: string[] | undefined;
  produces: string[] | undefined;
}

function mediaTypeList(raw: unknown): string[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  return raw
    .filter((item): item is string => typeof item === "string")
    .map((item) => safeText(item, 120))
    .filter((item) => item.length > 0)
    .slice(0, 32);
}

function readParameter(
  raw: unknown,
  pointer: string,
  ctx: WalkContext,
): ReadParameter | undefined {
  const resolved = ctx.resolver.resolve(raw, { documentKey: "", pointer });
  if (!resolved.ok) {
    ctx.issues.add({
      code: "structure.reference-unresolved",
      category: "structure",
      pointer,
      dimension: "import",
      severity: "warning",
      message: "A parameter reference could not be resolved; the parameter is treated as undeclared and its operation is blocked.",
    });
    return undefined;
  }
  const value = resolved.resolved.value;
  const location = resolved.resolved.chain.length ? resolved.resolved.pointer : pointer;
  if (!isRecord(value) || typeof value.name !== "string" || typeof value.in !== "string") {
    ctx.issues.add({
      code: "structure.invalid-parameter",
      category: "structure",
      pointer: location,
      dimension: "import",
      severity: "warning",
      message: "A parameter lacks a name or location and was skipped; its operation is blocked.",
    });
    return undefined;
  }
  const name = value.name;
  const where = value.in;
  if (!ctx.rules.parameterLocations.includes(where)) {
    ctx.issues.add({
      code: "structure.invalid-parameter",
      category: "structure",
      pointer: location,
      dimension: "import",
      severity: "warning",
      message: `A parameter names the location "${token(where, 16)}", which this OpenAPI version does not define; its operation is blocked.`,
    });
    return undefined;
  }
  const required = where === "path" ? true : value.required === true;
  if (where === "path" && value.required !== true)
    ctx.issues.add({
      code: "structure.path-parameter-not-required",
      category: "structure",
      pointer: location,
      dimension: "import",
      severity: "warning",
      message: "A path parameter is not marked required; it is treated as required because a path template cannot be left empty.",
    });
  const description = safeText(value.description, 500);
  const parameter: ReadParameter = {
    name,
    in: where as ReadParameter["in"],
    required,
    deprecated: value.deprecated === true,
    ...(description ? { description } : {}),
    pointer: location,
    extensions: extensionsOf(value),
  };
  if (ctx.rules.bodyModel === "parameter") {
    if (where === "body") {
      parameter.schema = value.schema;
      return parameter;
    }
    const schema: Record<string, unknown> = {};
    for (const [key, item] of entriesOf(value)) if (parameterSchemaKeys.has(key)) schema[key] = item;
    parameter.schema = schema;
    const collectionFormat = typeof value.collectionFormat === "string" ? value.collectionFormat : "csv";
    if (schema.type === "array") parameter.collectionFormat = collectionFormat;
    const style = where === "path" || where === "header" ? "simple" : "form";
    parameter.style =
      schema.type !== "array" || collectionFormat === "csv" || collectionFormat === "multi"
        ? style
        : collectionFormat === "ssv"
          ? "spaceDelimited"
          : collectionFormat === "pipes"
            ? "pipeDelimited"
            : collectionFormat;
    parameter.explode = schema.type === "array" && collectionFormat === "multi";
    return parameter;
  }
  const defaultStyle = where === "path" || where === "header" ? "simple" : "form";
  const style = typeof value.style === "string" ? safeText(value.style, 32) : defaultStyle;
  parameter.style = style;
  parameter.explode = typeof value.explode === "boolean" ? value.explode : style === "form";
  if (value.allowReserved === true) parameter.allowReserved = true;
  if (isRecord(value.content)) {
    parameter.content = entriesOf(value.content)
      .map(([mediaType]) => safeText(mediaType, 120))
      .slice(0, 8);
  } else parameter.schema = value.schema;
  return parameter;
}

function readContent(raw: unknown, pointer: string): ReadMediaType[] {
  if (!isRecord(raw)) return [];
  return entriesOf(raw)
    .slice(0, 32)
    .map(([mediaType, value]) => ({
      mediaType: safeText(mediaType, 120),
      ...(isRecord(value) && Object.hasOwn(value, "schema") ? { schema: value.schema } : {}),
      pointer: `${pointer}/${mediaType.replaceAll("~", "~0").replaceAll("/", "~1")}`,
    }))
    .filter((item) => item.mediaType.length > 0);
}

function readResponses(
  raw: unknown,
  pointer: string,
  ctx: WalkContext,
  produces: string[] | undefined,
): ReadResponse[] {
  if (!isRecord(raw)) {
    ctx.issues.add({
      code: "structure.responses-missing",
      category: "structure",
      pointer,
      dimension: "import",
      severity: "warning",
      message: "The operation declares no responses object.",
    });
    return [];
  }
  const responses: ReadResponse[] = [];
  for (const [status, item] of entriesOf(raw).slice(0, 64)) {
    if (status.startsWith("x-")) continue;
    const responsePointer = `${pointer}/${status}`;
    const resolved = ctx.resolver.resolve(item, { documentKey: "", pointer: responsePointer });
    if (!resolved.ok || !isRecord(resolved.resolved.value)) {
      ctx.issues.add({
        code: "structure.reference-unresolved",
        category: "structure",
        pointer: responsePointer,
        dimension: "import",
        severity: "warning",
        message: "A response reference could not be resolved; the response is recorded without content.",
      });
      responses.push({ status, content: [], headers: [], pointer: responsePointer });
      continue;
    }
    const value = resolved.resolved.value;
    const location = resolved.resolved.chain.length ? resolved.resolved.pointer : responsePointer;
    const description = safeText(value.description, 500);
    const headers = isRecord(value.headers) ? entriesOf(value.headers).map(([name]) => name).slice(0, 64) : [];
    let content: ReadMediaType[];
    if (ctx.rules.bodyModel === "parameter") {
      content = Object.hasOwn(value, "schema")
        ? (produces && produces.length ? produces : ["*/*"]).map((mediaType) => ({
            mediaType,
            schema: value.schema,
            pointer: `${location}/schema`,
          }))
        : [];
    } else content = readContent(value.content, `${location}/content`);
    responses.push({
      status,
      ...(description ? { description } : {}),
      content,
      headers,
      pointer: location,
    });
  }
  return responses;
}

function operationIdentity(
  raw: Record<string, unknown>,
  method: string,
  path: string,
  pointer: string,
  used: Set<string>,
  issues: IssueCollector,
): { nativeId: string; identity: ReadOperation["identity"] } {
  if (typeof raw.operationId === "string" && raw.operationId.length > 0) {
    const parsed = nativeIdentifierSchema.safeParse(raw.operationId);
    if (!parsed.success)
      issues.add({
        code: "structure.operation-id-invalid",
        category: "structure",
        pointer: `${pointer}/operationId`,
        dimension: "import",
        severity: "warning",
        message: "The operationId is not a usable identifier (length, control characters or path-like segments); a method+path identity is used instead.",
      });
    else if (used.has(parsed.data))
      issues.add({
        code: "structure.operation-id-duplicate",
        category: "structure",
        pointer: `${pointer}/operationId`,
        dimension: "import",
        severity: "warning",
        message: "The operationId is declared by another operation; this operation is identified by method and path instead.",
      });
    else {
      used.add(parsed.data);
      return { nativeId: parsed.data, identity: "operationId" };
    }
  }
  const candidate = `${method} ${path}`;
  const parsed = nativeIdentifierSchema.safeParse(candidate);
  let nativeId = parsed.success ? parsed.data : `${method} #${shortHash(path)}`;
  while (used.has(nativeId)) nativeId = `${nativeId}#${shortHash(nativeId)}`;
  used.add(nativeId);
  return { nativeId, identity: "method-path" };
}

function readOperation(input: {
  raw: Record<string, unknown>;
  method: string;
  path: string;
  pointer: string;
  source: ReadOperation["source"];
  pathParameters: ReadParameter[];
  pathServers: ReadServer[];
  ctx: WalkContext;
  usedIds: Set<string>;
}): ReadOperation {
  const { raw, method, path, pointer, source, ctx } = input;
  const { nativeId, identity } = operationIdentity(raw, method, path, pointer, input.usedIds, ctx.issues);
  const ownParameters = Array.isArray(raw.parameters)
    ? raw.parameters
        .slice(0, 64)
        .map((item, index) => readParameter(item, `${pointer}/parameters/${index}`, ctx))
        .filter((item): item is ReadParameter => item !== undefined)
    : [];
  const merged = new Map<string, ReadParameter>();
  for (const parameter of input.pathParameters) merged.set(`${parameter.in}\n${parameter.name}`, parameter);
  for (const parameter of ownParameters) merged.set(`${parameter.in}\n${parameter.name}`, parameter);
  const parameters = [...merged.values()];
  const consumes = ctx.rules.bodyModel === "parameter" ? (mediaTypeList(raw.consumes) ?? ctx.consumes) : undefined;
  const produces = ctx.rules.bodyModel === "parameter" ? (mediaTypeList(raw.produces) ?? ctx.produces) : undefined;
  let requestBody: ReadRequestBody | undefined;
  if (ctx.rules.bodyModel === "parameter") {
    const body = parameters.find((parameter) => parameter.in === "body");
    const form = parameters.filter((parameter) => parameter.in === "formData");
    if (body) {
      requestBody = {
        required: body.required,
        ...(body.description ? { description: body.description } : {}),
        content: (consumes && consumes.length ? consumes : ["*/*"]).map((mediaType) => ({
          mediaType,
          schema: body.schema,
          pointer: `${body.pointer}/schema`,
        })),
        pointer: body.pointer,
      };
    } else if (form.length) {
      const declared = (consumes ?? []).filter(
        (item) => item.startsWith("multipart/") || item.startsWith("application/x-www-form-urlencoded"),
      );
      requestBody = {
        required: form.some((parameter) => parameter.required),
        content: (declared.length ? declared : ["application/x-www-form-urlencoded"]).map((mediaType) => ({
          mediaType,
          pointer: form[0]!.pointer,
        })),
        pointer: form[0]!.pointer,
      };
    }
  } else if (Object.hasOwn(raw, "requestBody")) {
    const bodyPointer = `${pointer}/requestBody`;
    const resolved = ctx.resolver.resolve(raw.requestBody, { documentKey: "", pointer: bodyPointer });
    if (resolved.ok && isRecord(resolved.resolved.value)) {
      const value = resolved.resolved.value;
      const location = resolved.resolved.chain.length ? resolved.resolved.pointer : bodyPointer;
      const description = safeText(value.description, 500);
      requestBody = {
        required: value.required === true,
        ...(description ? { description } : {}),
        content: readContent(value.content, `${location}/content`),
        pointer: location,
      };
    } else
      ctx.issues.add({
        code: "structure.reference-unresolved",
        category: "structure",
        pointer: bodyPointer,
        dimension: "import",
        severity: "warning",
        message: "The request body reference could not be resolved; the operation is blocked.",
      });
    if (!requestBody)
      requestBody = { required: true, content: [{ mediaType: "unresolved", pointer: bodyPointer }], pointer: bodyPointer };
  }
  const responses = readResponses(raw.responses, `${pointer}/responses`, ctx, produces);
  const security = effectiveSecurity({
    operationRaw: raw,
    documentSecurity: ctx.documentSecurity,
    schemes: ctx.schemes,
    pointer,
    issues: ctx.issues,
  });
  let servers: ReadServer[];
  if (ctx.rules.bodyModel === "parameter") {
    servers = Object.hasOwn(raw, "schemes")
      ? swagger2Servers(ctx.document, raw.schemes, ctx.issues, `${pointer}/schemes`)
      : ctx.documentServers;
  } else {
    const own = Object.hasOwn(raw, "servers") ? readServers(raw.servers, `${pointer}/servers`, ctx.issues) : [];
    servers = own.length ? own : input.pathServers.length ? input.pathServers : ctx.documentServers;
  }
  const callbacks = isRecord(raw.callbacks) ? entriesOf(raw.callbacks).map(([name]) => name).slice(0, 64) : [];
  const summary = safeText(raw.summary, 200);
  const description = safeText(raw.description, 500);
  const tags = Array.isArray(raw.tags)
    ? raw.tags.filter((item): item is string => typeof item === "string").map((item) => safeText(item, 120)).slice(0, 32)
    : [];
  if (raw.deprecated === true)
    ctx.issues.add({
      code: "structure.operation-deprecated",
      category: "structure",
      pointer,
      dimension: "invoke",
      severity: "info",
      message: "The operation is declared deprecated by the source.",
    });
  return {
    nativeId,
    identity,
    method,
    path,
    pointer,
    source,
    ...(summary ? { summary } : {}),
    ...(description ? { description } : {}),
    deprecated: raw.deprecated === true,
    tags,
    servers,
    parameters,
    ...(requestBody ? { requestBody } : {}),
    responses,
    security,
    callbacks,
    ...(consumes ? { consumes } : {}),
    ...(produces ? { produces } : {}),
    extensions: extensionsOf(raw),
  };
}

function readPathItems(input: {
  container: unknown;
  containerPointer: string;
  source: ReadOperation["source"];
  ctx: WalkContext;
  usedIds: Set<string>;
  requireSlash: boolean;
}): ReadOperation[] {
  const { container, containerPointer, source, ctx, usedIds } = input;
  const operations: ReadOperation[] = [];
  if (container === undefined) return operations;
  if (!isRecord(container)) {
    ctx.issues.add({
      code: "structure.invalid-paths",
      category: "structure",
      pointer: containerPointer,
      dimension: "import",
      severity: "warning",
      message: "The paths container is not an object; no operations were read from it.",
    });
    return operations;
  }
  for (const [path, item] of entriesOf(container)) {
    if (path.startsWith("x-")) continue;
    const itemPointer = jsonPointer(...containerPointer.slice(2).split("/").map((part) => part.replaceAll("~1", "/").replaceAll("~0", "~")), path);
    if (input.requireSlash && !path.startsWith("/")) {
      ctx.issues.add({
        code: "structure.invalid-path",
        category: "structure",
        pointer: itemPointer,
        dimension: "import",
        severity: "warning",
        message: "A paths key does not start with a slash and was skipped.",
      });
      continue;
    }
    if (operations.length >= DEFINITION_LIMITS.capabilities) {
      ctx.issues.add({
        code: "structure.operation-limit",
        category: "structure",
        pointer: itemPointer,
        dimension: "import",
        severity: "blocking",
        disposition: "rejected",
        executionImpact: "blocks-definition",
        message: "The document declares more operations than a definition may carry; the definition is not usable until the source is split.",
      });
      break;
    }
    const resolved = ctx.resolver.resolve(item, { documentKey: "", pointer: itemPointer });
    if (!resolved.ok || !isRecord(resolved.resolved.value)) {
      ctx.issues.add({
        code: "structure.reference-unresolved",
        category: "structure",
        pointer: itemPointer,
        dimension: "import",
        severity: "warning",
        message: "A path item could not be resolved and was skipped.",
      });
      continue;
    }
    const pathItem = resolved.resolved.value;
    const basePointer = resolved.resolved.chain.length ? resolved.resolved.pointer : itemPointer;
    const pathParameters = Array.isArray(pathItem.parameters)
      ? pathItem.parameters
          .slice(0, 64)
          .map((parameter, index) => readParameter(parameter, `${basePointer}/parameters/${index}`, ctx))
          .filter((parameter): parameter is ReadParameter => parameter !== undefined)
      : [];
    const pathServers =
      ctx.rules.bodyModel === "requestBody" && Object.hasOwn(pathItem, "servers")
        ? readServers(pathItem.servers, `${basePointer}/servers`, ctx.issues)
        : [];
    const entries: Array<{ method: string; raw: unknown; pointer: string }> = [];
    for (const key of ctx.rules.methods)
      if (Object.hasOwn(pathItem, key))
        entries.push({ method: key.toUpperCase(), raw: pathItem[key], pointer: `${basePointer}/${key}` });
    if (ctx.rules.additionalOperations && isRecord(pathItem.additionalOperations))
      for (const [method, raw] of entriesOf(pathItem.additionalOperations).slice(0, 16))
        entries.push({ method: safeText(method, 32), raw, pointer: `${basePointer}/additionalOperations/${method}` });
    for (const entry of entries) {
      if (!isRecord(entry.raw)) {
        ctx.issues.add({
          code: "structure.invalid-operation",
          category: "structure",
          pointer: entry.pointer,
          dimension: "import",
          severity: "warning",
          message: "An operation is not an object and was skipped.",
        });
        continue;
      }
      operations.push(
        readOperation({
          raw: entry.raw,
          method: entry.method,
          path,
          pointer: entry.pointer,
          source,
          pathParameters,
          pathServers,
          ctx,
          usedIds,
        }),
      );
    }
  }
  return operations;
}

function readSchemes(
  document: Record<string, unknown>,
  rules: ProfileRules,
  resolver: ReferenceResolver,
  issues: IssueCollector,
): Record<string, ReadSecurityScheme> {
  const schemes: Record<string, ReadSecurityScheme> = {};
  const container =
    rules.profile === "swagger-2.0"
      ? document.securityDefinitions
      : isRecord(document.components)
        ? document.components.securitySchemes
        : undefined;
  const basePointer = rules.profile === "swagger-2.0" ? "#/securityDefinitions" : "#/components/securitySchemes";
  if (container === undefined) return schemes;
  if (!isRecord(container)) {
    issues.add({
      code: "structure.invalid-security-schemes",
      category: "structure",
      pointer: basePointer,
      dimension: "import",
      severity: "warning",
      message: "The security schemes container is not an object; no schemes were read.",
    });
    return schemes;
  }
  const usedIds = new Set<string>();
  let profileCount = 0;
  for (const [name, raw] of entriesOf(container)) {
    const pointer = `${basePointer}/${name.replaceAll("~", "~0").replaceAll("/", "~1")}`;
    if (profileCount >= DEFINITION_LIMITS.authentication) {
      issues.add({
        code: "security.profile-limit",
        category: "security",
        pointer,
        dimension: "authorize",
        severity: "blocking",
        disposition: "unsupported",
        executionImpact: "blocks-authorization",
        message: "The document declares more security schemes than a definition may carry; this scheme is treated as unsupported.",
      });
      schemes[name] = {
        name,
        type: "",
        pointer,
        profiles: [],
        executable: false,
        deprecated: false,
        extensions: {},
        native: {},
      };
      continue;
    }
    const resolved = resolver.resolve(raw, { documentKey: "", pointer });
    const value = resolved.ok ? resolved.resolved.value : undefined;
    const scheme = readSecurityScheme({ name, raw: value, profile: rules.profile, pointer, issues, usedIds });
    if (profileCount + scheme.profiles.length > DEFINITION_LIMITS.authentication)
      scheme.profiles = scheme.profiles.slice(0, DEFINITION_LIMITS.authentication - profileCount);
    profileCount += scheme.profiles.length;
    schemes[name] = scheme;
  }
  return schemes;
}

function buildDefinition(input: {
  document: Record<string, unknown>;
  rules: ProfileRules;
  version: string;
  dialect: string;
  info: ReadInfo;
  operations: ReadOperation[];
  webhooks: ReadOperation[];
  schemes: Record<string, ReadSecurityScheme>;
  servers: ReadServer[];
  issues: IssueCollector;
  options: SyncOptions;
}): NormalizedDefinition {
  const { rules, info, operations, webhooks, schemes, issues, options } = input;
  const profiles: AuthenticationProfile[] = [];
  for (const scheme of Object.values(schemes)) profiles.push(...scheme.profiles);
  const capabilities: NativeCapability[] = operations.map((operation) => {
    const alternatives = securityRequirementsFor(operation);
    const unresolvable =
      alternatives.alternatives.length > 0 &&
      alternatives.alternatives.every((alternative) => alternative.schemes.length > 0) &&
      alternatives.profileIds.length === 0;
    const authentication = unresolvable
      ? undefined
      : alternatives.profileIds.slice(0, 16);
    if (alternatives.profileIds.length > 16)
      issues.add({
        code: "security.profile-list-truncated",
        category: "security",
        pointer: operation.pointer,
        dimension: "authorize",
        severity: "warning",
        disposition: "adapted",
        message: "The operation references more authentication profiles than a capability lists; the read model keeps the full alternatives.",
      });
    const jsonBody = operation.requestBody?.content.find((item) => isJsonMediaType(item.mediaType));
    const success = operation.responses.find((response) => /^2/.test(response.status));
    const jsonResponse = success?.content.find((item) => isJsonMediaType(item.mediaType));
    const method = operation.method.toUpperCase();
    const label = operation.summary ? safeText(operation.summary, 200) : "";
    const summary = operation.description ? safeText(operation.description, 500) : "";
    const extensions = operation.extensions;
    return {
      kind: "http-operation",
      nativeId: operation.nativeId,
      ...(label ? { label } : {}),
      ...(summary ? { summary } : {}),
      effect: method === "GET" || method === "HEAD" ? "read" : "unknown",
      dataClassification: "unknown",
      cost: "unknown",
      ...(authentication ? { authentication } : {}),
      inputSchemaRef: jsonBody ? `${jsonBody.pointer}/schema` : operation.pointer,
      ...(jsonResponse ? { outputSchemaRef: `${jsonResponse.pointer}/schema` } : {}),
      ...(Object.keys(extensions).length ? { nativeExtensions: extensions } : {}),
    };
  });
  const events: EventDescriptor[] = [];
  for (const webhook of webhooks) {
    if (events.length >= DEFINITION_LIMITS.events) break;
    const label = safeText(webhook.summary ?? webhook.path, 200);
    const nativeParsed = nativeIdentifierSchema.safeParse(`${webhook.path} ${webhook.method}`);
    events.push({
      nativeId: nativeParsed.success ? nativeParsed.data : `webhook #${shortHash(webhook.pointer)}`,
      ...(label ? { label } : {}),
      transport: "http-webhook",
      verification: "unknown",
      messageSchemaRef: webhook.pointer,
    });
  }
  for (const operation of operations)
    for (const callback of operation.callbacks) {
      if (events.length >= DEFINITION_LIMITS.events) break;
      const nativeParsed = nativeIdentifierSchema.safeParse(`${operation.nativeId} callback ${callback}`);
      events.push({
        nativeId: nativeParsed.success ? nativeParsed.data : `callback #${shortHash(`${operation.pointer}/${callback}`)}`,
        label: safeText(callback, 200),
        transport: "http-webhook",
        verification: "unknown",
        messageSchemaRef: `${operation.pointer}/callbacks/${callback.replaceAll("~", "~0").replaceAll("/", "~1")}`,
      });
    }
  const declaredUrls = new Set<string>();
  const declaredServers: NormalizedDefinition["declaredServers"] = [];
  const addServer = (server: ReadServer) => {
    if (declaredUrls.has(server.url) || declaredServers.length >= 32) return;
    declaredUrls.add(server.url);
    declaredServers.push({
      url: server.url,
      ...(server.description ? { description: server.description } : {}),
      status: "declared",
    });
  };
  input.servers.forEach(addServer);
  for (const operation of operations) operation.servers.forEach(addServer);
  const executableProfiles = profiles.some(
    (profile) => EXECUTABLE_PROFILE_KINDS.has(profile.kind) && profile.kind !== "none",
  );
  const anyExecutableOperation = operations.some(
    (operation) => securityRequirementsFor(operation).executableAlternatives.length > 0 || securityRequirementsFor(operation).anonymous,
  );
  const dimensions = completeDimensions({
    import: rules.profile === "openapi-3.1" || rules.profile === "openapi-3.2" ? "exact" : "adapted",
    configure: "exact",
    authorize: executableProfiles ? "requires-configuration" : profiles.length ? "unsupported" : "exact",
    verify: "requires-configuration",
    invoke: anyExecutableOperation ? "requires-configuration" : "unsupported",
    events: events.length ? "requires-configuration" : "unsupported",
    reconnect: executableProfiles ? "requires-configuration" : "unsupported",
    disconnect: "exact",
    export: "adapted",
  });
  const hint = options.identityHint ?? {};
  const titleId = nativeIdentifierSchema.safeParse(info.title);
  const identity: ConnectorSourceIdentity = {
    ecosystem: hint.ecosystem ?? "openapi",
    authorityNamespace: hint.authorityNamespace ?? "",
    nativeId: hint.nativeId ?? (titleId.success ? titleId.data : `openapi-${shortHash(info.title)}`),
    nativeVersion: hint.nativeVersion ?? info.version,
  };
  const documentDigest = sha256(canonicalConnectorJson(input.document));
  const sourceRef = options.sourceRef ?? `openapi:src:${documentDigest.slice(0, 32)}`;
  const body = {
    schemaVersion: 1 as const,
    identity,
    sourceRef,
    importer: { id: READER_ID, version: READER_VERSION },
    display: {
      name: info.title,
      description: info.description ?? "",
      ecosystem: "openapi",
      service: options.service ?? slug(info.title),
    },
    authentication: profiles,
    configuration: [],
    capabilities,
    events,
    declaredServers,
    compatibility: { issues: [] as NormalizedDefinition["compatibility"]["issues"], dimensions },
    nativeExtensions: extensionsOf(input.document),
  };
  const normalizedDigest = sha256(canonicalConnectorJson(body));
  const definitionRef = options.definitionRef ?? `openapi:def:${normalizedDigest.slice(0, 32)}`;
  return normalizedDefinitionSchema.parse({
    ...body,
    definitionRef,
    normalizedDigest,
    compatibility: { issues: issues.issues, dimensions },
  });
}

/** Whether the compiled subset implements the document's default schema dialect. */
export function isSupportedDialect(profile: OpenApiProfile, dialect: string): boolean {
  if (profile === "swagger-2.0" || profile === "openapi-3.0") return true;
  return knownDialects.has(dialect) || dialect.startsWith("openapi-3.2-default-dialect");
}

/** JSON media types: `application/json` and structured-syntax `+json` types, parameters ignored. */
export function isJsonMediaType(mediaType: string): boolean {
  const essence = mediaType.split(";")[0]!.trim().toLowerCase();
  return essence === "application/json" || /^application\/[a-z0-9!#$&^_.+-]+\+json$/.test(essence);
}

function readWithRules(
  document: Record<string, unknown>,
  rules: ProfileRules,
  version: string,
  options: SyncOptions,
): ReadResult | ReadFailure {
  const issues = new IssueCollector(DEFINITION_LIMITS.issues);
  const limits: ReferenceLimits = { ...DEFAULT_REFERENCE_LIMITS, ...(options.limits ?? {}) };
  const resolver = new ReferenceResolver(document, options.external ?? new Map(), limits, issues);
  try {
    const info = readInfo(document, issues);
    const dialect = rules.defaultDialect(document);
    if (
      (rules.profile === "openapi-3.1" || rules.profile === "openapi-3.2") &&
      typeof document.jsonSchemaDialect === "string" &&
      !knownDialects.has(document.jsonSchemaDialect)
    )
      issues.add({
        code: "schema.document-dialect-unsupported",
        category: "schema",
        pointer: "#/jsonSchemaDialect",
        dimension: "invoke",
        severity: "warning",
        disposition: "adapted",
        message: "The document declares a default schema dialect this runtime does not implement; operations whose schemas rely on it are blocked at compile time.",
      });
    const servers =
      rules.profile === "swagger-2.0"
        ? swagger2Servers(document, document.schemes, issues, "#/host")
        : readServers(document.servers, "#/servers", issues);
    const schemes = readSchemes(document, rules, resolver, issues);
    const documentSecurity = Object.hasOwn(document, "security")
      ? normalizeRequirements({ raw: document.security, schemes, pointer: "#/security", issues })
      : undefined;
    const ctx: WalkContext = {
      rules,
      document,
      resolver,
      issues,
      schemes,
      documentSecurity,
      documentServers: servers,
      consumes: rules.profile === "swagger-2.0" ? mediaTypeList(document.consumes) : undefined,
      produces: rules.profile === "swagger-2.0" ? mediaTypeList(document.produces) : undefined,
    };
    const usedIds = new Set<string>();
    if (!Object.hasOwn(document, "paths") && !(rules.webhooks && Object.hasOwn(document, "webhooks")))
      issues.add({
        code: "structure.paths-missing",
        category: "structure",
        pointer: "#",
        dimension: "import",
        severity: "warning",
        message: "The document declares no paths; it describes no operations.",
      });
    const operations = readPathItems({
      container: document.paths,
      containerPointer: "#/paths",
      source: "paths",
      ctx,
      usedIds,
      requireSlash: true,
    });
    const webhooks = rules.webhooks
      ? readPathItems({
          container: document.webhooks,
          containerPointer: "#/webhooks",
          source: "webhooks",
          ctx,
          usedIds,
          requireSlash: false,
        })
      : [];
    const schemeProfiles: Record<string, string[]> = {};
    for (const [name, scheme] of Object.entries(schemes))
      schemeProfiles[name] = scheme.profiles.map((profile) => profile.id);
    const definition = buildDefinition({
      document,
      rules,
      version,
      dialect,
      info,
      operations,
      webhooks,
      schemes,
      servers,
      issues,
      options,
    });
    return {
      profile: rules.profile,
      version,
      dialect,
      info,
      servers,
      operations,
      webhooks,
      securitySchemes: schemes,
      schemeProfiles,
      documentSecurity,
      extensions: extensionsOf(document),
      definition,
      issues: issues.issues,
      resolver,
      document,
    };
  } catch (error) {
    if (error instanceof ReferenceBudgetExceeded) {
      issues.add({
        code: "structure.budget-exceeded",
        category: "structure",
        pointer: "#",
        dimension: "import",
        severity: "blocking",
        disposition: "rejected",
        executionImpact: "blocks-definition",
        message: "The document exceeds the reader's node, depth or reference budget and was not read.",
      });
      return { profile: undefined, issues: issues.issues, definition: undefined };
    }
    if (error && typeof error === "object" && (error as { name?: string }).name === "ZodError") {
      issues.add({
        code: "structure.definition-invalid",
        category: "structure",
        pointer: "#",
        dimension: "import",
        severity: "blocking",
        disposition: "rejected",
        executionImpact: "blocks-definition",
        message: "The document could not be normalized within the definition contract; nothing from it is usable.",
      });
      return { profile: undefined, issues: issues.issues, definition: undefined };
    }
    throw error;
  }
}

function assertFamily(document: unknown, expected: OpenApiProfile): { document: Record<string, unknown>; version: string } | ReadFailure {
  const detected = detectOpenApiVersion(document);
  if (detected.profile === expected)
    return { document: document as Record<string, unknown>, version: detected.version };
  const issue: IssueInput =
    detected.profile === undefined
      ? detected.issue
      : {
          code: "version.reader-mismatch",
          category: "version",
          pointer: "#",
          dimension: "import",
          severity: "blocking",
          disposition: "rejected",
          executionImpact: "blocks-definition",
          message: `The document is ${detected.profile}, not ${expected}; use the reader for its own version.`,
        };
  return { profile: undefined, issues: [makeIssue(issue)], definition: undefined };
}

const explicit = (expected: OpenApiProfile) => (document: unknown, options: SyncOptions = {}) => {
  const checked = assertFamily(document, expected);
  if ("profile" in checked) return checked;
  return readWithRules(checked.document, rulesFor[expected], checked.version, options);
};

/** Swagger 2.0 reader: host/basePath/schemes servers, body/formData parameters, securityDefinitions. */
export const readSwagger2 = explicit("swagger-2.0");
/** OpenAPI 3.0.x reader: OAS 3.0 schema dialect, requestBody, cookie parameters, callbacks. */
export const readOpenApi30 = explicit("openapi-3.0");
/** OpenAPI 3.1.x reader: JSON Schema 2020-12 dialect, webhooks, mutualTLS, type arrays. */
export const readOpenApi31 = explicit("openapi-3.1");
/** OpenAPI 3.2.x reader: QUERY and additional operations, querystring parameters, device authorization flow. */
export const readOpenApi32 = explicit("openapi-3.2");

const readers: Record<OpenApiProfile, ReturnType<typeof explicit>> = {
  "swagger-2.0": readSwagger2,
  "openapi-3.0": readOpenApi30,
  "openapi-3.1": readOpenApi31,
  "openapi-3.2": readOpenApi32,
};

/** Synchronous read of an already-parsed document with pre-fetched external documents. */
export function readOpenApiSync(document: unknown, options: SyncOptions = {}): ReadResult | ReadFailure {
  const detected = detectOpenApiVersion(document);
  if (detected.profile === undefined)
    return { profile: undefined, issues: [makeIssue(detected.issue)], definition: undefined };
  return readers[detected.profile](document, options);
}

/**
 * Reads a parsed OpenAPI document. External `$ref`s are fetched once through
 * the optional hook before the synchronous read; without a hook they are
 * reported and the constructs behind them are blocked, never guessed.
 */
export async function readOpenApi(document: unknown, options: ReadOptions = {}): Promise<ReadResult | ReadFailure> {
  const detected = detectOpenApiVersion(document);
  if (detected.profile === undefined)
    return { profile: undefined, issues: [makeIssue(detected.issue)], definition: undefined };
  const limits: ReferenceLimits = { ...DEFAULT_REFERENCE_LIMITS, ...(options.limits ?? {}) };
  const prefetchIssues = new IssueCollector(64);
  let external: Map<string, unknown>;
  try {
    external = await prefetchExternalReferences(document, options.resolveExternal, limits, prefetchIssues, {
      nodes: 0,
    });
  } catch (error) {
    if (error instanceof ReferenceBudgetExceeded)
      return {
        profile: undefined,
        issues: [
          makeIssue({
            code: "structure.budget-exceeded",
            category: "structure",
            pointer: "#",
            dimension: "import",
            severity: "blocking",
            disposition: "rejected",
            executionImpact: "blocks-definition",
            message: "The document exceeds the reader's node, depth or reference budget and was not read.",
          }),
        ],
        definition: undefined,
      };
    throw error;
  }
  const result = readers[detected.profile](document, { ...options, external });
  if (prefetchIssues.issues.length === 0) return result;
  if (result.profile === undefined)
    return { ...result, issues: [...prefetchIssues.issues, ...result.issues] };
  const issues = [...prefetchIssues.issues, ...result.issues];
  return {
    ...result,
    issues,
    definition: normalizedDefinitionSchema.parse({
      ...result.definition,
      compatibility: { ...result.definition.compatibility, issues },
    }),
  };
}
