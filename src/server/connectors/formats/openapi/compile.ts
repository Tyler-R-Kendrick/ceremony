import { createHash } from "node:crypto";
import type {
  CompatibilityIssue,
  NormalizedDefinition,
} from "../../../../core/connectors/index.js";
import {
  boundOperationSchema,
  type ApprovedDestination,
  type BoundOperation,
} from "../../binding.js";
import { IssueCollector, safeText, token } from "./issues.js";
import { READER_VERSION, type ReadOperation, type ReadParameter, type ReadResult } from "./model.js";
import {
  HTTP_METHODS,
  PLAN_SETTINGS_KEY,
  PLAN_VERSION,
  operationPlanSchema,
  type HttpMethod,
  type OperationPlan,
  type PlanParameter,
  type PlanSettings,
} from "./plan.js";
import { isJsonMediaType, isSupportedDialect } from "./read.js";
import {
  compileSchema,
  type CompiledSchema,
  type SchemaProblem,
  type CompileSchemaContext,
} from "./schema.js";
import { EXECUTABLE_PROFILE_KINDS, securityRequirementsFor } from "./security.js";

/*
 * The compiler turns read operations into bound operations plus plans for the
 * subset this adapter can execute exactly: JSON bodies, simple path and header
 * parameters, form query parameters, primitive parameter values, the compiled
 * schema subset, and security alternatives the bound profiles can satisfy.
 * Everything outside that subset blocks the affected operation with a precise
 * diagnostic; the rest of the document stays discoverable and bindable.
 */

export interface OperationReview {
  effect?: BoundOperation["effect"];
  outputClassification?: BoundOperation["outputClassification"];
  cost?: BoundOperation["cost"];
  consent?: BoundOperation["consent"];
  replay?: BoundOperation["replay"];
  targetParameters?: string[];
  description?: string;
}

export interface CompileOptions {
  destinationId: string;
  /** The approved destination, when known; declared servers that differ from it produce a warning, not a block. */
  destination?: ApprovedDestination;
  /** Which declared server supplies the path prefix; default: the operation's first server. */
  server?: { index?: number; url?: string; variables?: Record<string, string> };
  /** Explicit path prefix under the destination; overrides the server-derived one. */
  pathPrefix?: string;
  /** Profile ids the binding can present; default: every executable profile in the definition. */
  profiles?: string[];
  /** Host review decisions keyed by native operation id. */
  review?: Record<string, OperationReview>;
  /** Native ids to compile; default: all operations. */
  include?: string[];
  maxResponseBytes?: number;
  /** Swagger 2.0 documents that declare no consumes/produces: treat JSON as the media type (warning) instead of blocking. */
  assumeJsonWhenUndeclared?: boolean;
  /** The approved read operation the host names as credential verifier. */
  verifier?: { nativeId: string; input?: unknown };
}

export interface CompileResult {
  operations: BoundOperation[];
  plans: Record<string, OperationPlan>;
  /** Ready to place under `RuntimeBinding.settings`. */
  settings: Record<string, unknown>;
  issues: CompatibilityIssue[];
  blocked: Array<{ nativeId: string; issues: CompatibilityIssue[] }>;
  executable: string[];
}

const RESERVED_HEADERS = new Set([
  "host",
  "content-length",
  "transfer-encoding",
  "connection",
  "cookie",
  "set-cookie",
  "proxy-authorization",
  "proxy-authenticate",
  "keep-alive",
  "te",
  "trailer",
  "upgrade",
  "proxy-connection",
  "expect",
  "via",
  "forwarded",
  "x-forwarded-for",
  "x-forwarded-host",
  "x-forwarded-proto",
]);
const IGNORED_HEADERS = new Set(["accept", "content-type"]);
const HEADER_TOKEN = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;

export function operationRefFor(definition: Pick<NormalizedDefinition, "definitionRef">, nativeId: string): string {
  const hash = createHash("sha256").update(nativeId).digest("hex").slice(0, 16);
  return `${definition.definitionRef.slice(0, 150)}:op:${hash}`;
}

function problemsToIssues(
  problems: SchemaProblem[],
  issues: IssueCollector,
  seen: Set<string>,
): void {
  for (const problem of problems) {
    const key = `${problem.code}|${problem.pointer}|${problem.keyword ?? ""}`;
    if (seen.has(key)) continue;
    seen.add(key);
    switch (problem.code) {
      case "schema.unsupported-keyword":
        issues.add({
          code: problem.code,
          category: "schema",
          pointer: problem.pointer,
          dimension: "invoke",
          severity: "blocking",
          message: `The schema keyword "${token(problem.keyword, 32)}" is not part of the executable subset; the operation is blocked until the schema is simplified or the host reviews an override.`,
        });
        break;
      case "schema.unknown-keyword":
        issues.add({
          code: problem.code,
          category: "schema",
          pointer: problem.pointer,
          dimension: "invoke",
          severity: "info",
          message: `The schema keyword "${token(problem.keyword, 32)}" is not a keyword this dialect defines and is ignored, as JSON Schema requires.`,
        });
        break;
      case "schema.format-not-validated":
        issues.add({
          code: problem.code,
          category: "schema",
          pointer: problem.pointer,
          dimension: "invoke",
          severity: "info",
          message: `The format "${token(problem.keyword, 32)}" is treated as an annotation and not validated.`,
        });
        break;
      case "schema.binary-in-json":
        issues.add({
          code: problem.code,
          category: "serialization",
          pointer: problem.pointer,
          dimension: "invoke",
          severity: "blocking",
          message: "A binary value cannot be carried in a JSON body by this adapter; the operation is blocked.",
        });
        break;
      case "schema.dialect-unsupported":
        issues.add({
          code: problem.code,
          category: "schema",
          pointer: problem.pointer,
          dimension: "invoke",
          severity: "blocking",
          message: "The schema declares a dialect this runtime does not implement; the operation is blocked rather than validated under different semantics.",
        });
        break;
      case "schema.reference-unresolved":
        issues.add({
          code: problem.code,
          category: "structure",
          pointer: problem.pointer,
          dimension: "invoke",
          severity: "blocking",
          message: "A schema reference could not be resolved within the document or the fetched external documents; the operation is blocked.",
        });
        break;
      case "schema.too-deep":
        issues.add({
          code: problem.code,
          category: "schema",
          pointer: problem.pointer,
          dimension: "invoke",
          severity: "blocking",
          message: "The schema nests deeper than the compiler's explicit limit; the operation is blocked.",
        });
        break;
      case "schema.invalid":
        issues.add({
          code: problem.code,
          category: "schema",
          pointer: problem.pointer,
          dimension: "invoke",
          severity: "blocking",
          message: "The schema is not a valid Schema Object for this OpenAPI version; the operation is blocked.",
        });
        break;
    }
  }
}

function primitiveShape(
  schema: CompiledSchema,
  definitions: Map<string, CompiledSchema | "compiling">,
  hops = 0,
): "primitive" | "array" | "complex" | "unknown" {
  if (hops > 8) return "unknown";
  const resolved = schema.kind === "ref" ? definitions.get(schema.name) : schema;
  if (!resolved || resolved === "compiling") return "unknown";
  if (resolved.kind === "ref") return primitiveShape(resolved, definitions, hops + 1);
  if (resolved.kind === "any") return "unknown";
  if (resolved.kind === "never") return "complex";
  const types = resolved.types ?? [];
  if (types.length === 0) return resolved.properties || resolved.items ? "complex" : "unknown";
  if (types.includes("object")) return "complex";
  if (types.includes("array")) {
    const items = resolved.items;
    if (!items) return "array";
    const inner = primitiveShape(items, definitions, hops + 1);
    return inner === "primitive" || inner === "unknown" ? "array" : "complex";
  }
  return "primitive";
}

function serverPrefix(
  operation: ReadOperation,
  options: CompileOptions,
  issues: IssueCollector,
): string | undefined {
  if (options.pathPrefix !== undefined) return normalizePrefix(options.pathPrefix);
  let server = operation.servers[0];
  if (options.server?.url !== undefined) {
    server = operation.servers.find((item) => item.url === options.server?.url) ?? {
      url: options.server.url,
      variables: {},
      pointer: "#",
    };
  } else if (options.server?.index !== undefined) server = operation.servers[options.server.index];
  if (!server) {
    issues.add({
      code: "network.no-declared-server",
      category: "network",
      pointer: operation.pointer,
      dimension: "invoke",
      severity: "info",
      message: "The operation declares no server; its path is bound directly under the approved destination.",
    });
    return "";
  }
  let url = server.url;
  const missing: string[] = [];
  url = url.replace(/\{([^{}]+)\}/g, (_match, name: string) => {
    const supplied = options.server?.variables?.[name];
    const declared = server?.variables[name];
    if (supplied !== undefined && (!declared?.enum || declared.enum.includes(supplied))) return supplied;
    if (declared && declared.default) return declared.default;
    missing.push(name);
    return "";
  });
  if (missing.length) {
    issues.add({
      code: "network.server-variable-unresolved",
      category: "network",
      pointer: server.pointer,
      dimension: "invoke",
      severity: "blocking",
      message: `The server URL uses the variable "${token(missing[0], 32)}" without a default or an approved value; the operation is blocked.`,
    });
    return undefined;
  }
  if (/^[A-Za-z][A-Za-z0-9+.-]*:\/\//.test(url) || url.startsWith("//")) {
    const parsed = URL.canParse(url.startsWith("//") ? `https:${url}` : url)
      ? new URL(url.startsWith("//") ? `https:${url}` : url)
      : undefined;
    if (!parsed) {
      issues.add({
        code: "network.server-url-invalid",
        category: "network",
        pointer: server.pointer,
        dimension: "invoke",
        severity: "blocking",
        message: "The declared server URL cannot be parsed; the operation is blocked until a path prefix is supplied by review.",
      });
      return undefined;
    }
    if (options.destination && !url.startsWith("//") && parsed.origin !== options.destination.origin)
      issues.add({
        code: "network.destination-differs-from-declared",
        category: "network",
        pointer: server.pointer,
        dimension: "invoke",
        severity: "warning",
        disposition: "adapted",
        message: "The approved destination differs from the server the document declares; requests go only to the approved destination.",
      });
    return normalizePrefix(parsed.pathname);
  }
  return normalizePrefix(url.split(/[?#]/)[0] ?? "");
}

function normalizePrefix(prefix: string): string {
  let value = prefix.trim();
  if (value === "" || value === "/") return "";
  if (!value.startsWith("/")) value = `/${value}`;
  return value.replace(/\/+$/, "");
}

interface OperationCompilation {
  operation?: BoundOperation;
  plan?: OperationPlan;
  issues: CompatibilityIssue[];
}

function compileOne(input: {
  operation: ReadOperation;
  definition: NormalizedDefinition;
  read: ReadResult;
  options: CompileOptions;
  allowedProfiles: string[];
}): OperationCompilation {
  const { operation, definition, read, options, allowedProfiles } = input;
  const issues = new IssueCollector(256);
  const pointer = operation.pointer;
  const method = operation.method.toUpperCase();
  if (!(HTTP_METHODS as readonly string[]).includes(method))
    issues.add({
      code: "structure.unsupported-method",
      category: "structure",
      pointer,
      dimension: "invoke",
      severity: "blocking",
      message: `The HTTP method "${token(operation.method, 16)}" is not in the executable subset; the operation stays discoverable but cannot be bound.`,
    });

  // Security: the first alternative every bound profile can satisfy, preferring authenticated ones.
  const alternatives = securityRequirementsFor(operation);
  let chosen: OperationPlan["security"] | undefined;
  let boundable = false;
  for (const alternative of alternatives.alternatives) {
    if (alternative.schemes.length === 0) continue;
    if (!alternative.schemes.every((entry) => entry.known && entry.executable)) continue;
    boundable = true;
    const picked = alternative.schemes.map((entry) => ({
      entry,
      profileId: entry.profileIds.find((id) => allowedProfiles.includes(id)),
    }));
    if (picked.every((item) => item.profileId !== undefined)) {
      chosen = {
        profiles: picked.map((item) => ({
          profileId: item.profileId!,
          scheme: item.entry.scheme,
          scopes: item.entry.scopes,
        })),
      };
      break;
    }
  }
  if (!chosen && alternatives.anonymous) chosen = { profiles: [] };
  if (!chosen) {
    if (boundable)
      issues.add({
        code: "security.profile-not-bound",
        category: "security",
        pointer,
        dimension: "invoke",
        severity: "blocking",
        disposition: "requires-configuration",
        message: "No bound authentication profile satisfies any of the operation's security alternatives; bind a profile the operation accepts.",
      });
    else
      issues.add({
        code: "security.unsupported-requirement",
        category: "security",
        pointer,
        dimension: "invoke",
        severity: "blocking",
        disposition: "unsupported",
        message: "Every security alternative of the operation requires a scheme this runtime cannot execute or the document does not declare; the operation is blocked.",
      });
  }

  const definitions = new Map<string, CompiledSchema | "compiling">();
  const problems: SchemaProblem[] = [];
  const schemaContext: CompileSchemaContext = { resolver: read.resolver, profile: read.profile, definitions, problems };
  const dialectOk = isSupportedDialect(read.profile, read.dialect);
  const seenProblems = new Set<string>();
  const compileParameterSchema = (parameter: ReadParameter): CompiledSchema => {
    if (!Object.hasOwn(parameter, "schema") || parameter.schema === undefined) return { kind: "any" };
    return compileSchema(parameter.schema, { documentKey: "", pointer: `${parameter.pointer}/schema` }, schemaContext);
  };

  const planParameters: PlanParameter[] = [];
  const declaredNames = new Set<string>();
  let usesSchema = false;
  for (const parameter of operation.parameters) {
    if (parameter.in === "body" || parameter.in === "formData") continue;
    const where = parameter.in;
    if (where === "cookie") {
      issues.add({
        code: "serialization.cookie-parameter-unsupported",
        category: "serialization",
        pointer: parameter.pointer,
        dimension: "invoke",
        severity: "blocking",
        message: "Cookie parameters are not part of the executable subset; the operation is blocked.",
      });
      continue;
    }
    if (where === "querystring") {
      issues.add({
        code: "serialization.querystring-parameter-unsupported",
        category: "serialization",
        pointer: parameter.pointer,
        dimension: "invoke",
        severity: "blocking",
        message: "Whole-querystring parameters are not part of the executable subset; the operation is blocked.",
      });
      continue;
    }
    if (parameter.content) {
      issues.add({
        code: "serialization.parameter-content-unsupported",
        category: "serialization",
        pointer: parameter.pointer,
        dimension: "invoke",
        severity: "blocking",
        message: "Parameters serialized through a media type are not part of the executable subset; the operation is blocked.",
      });
      continue;
    }
    const lower = parameter.name.toLowerCase();
    if (where === "header") {
      if (IGNORED_HEADERS.has(lower)) {
        issues.add({
          code: "serialization.header-parameter-ignored",
          category: "serialization",
          pointer: parameter.pointer,
          dimension: "invoke",
          severity: "warning",
          disposition: "adapted",
          message: "A header parameter named Accept or Content-Type is ignored, as the specification requires; the adapter sets these headers itself.",
        });
        continue;
      }
      if (lower === "authorization") {
        issues.add({
          code: "security.header-parameter-reserved",
          category: "security",
          pointer: parameter.pointer,
          dimension: "invoke",
          severity: "blocking",
          disposition: "unsupported",
          message: "The operation describes Authorization as an input header; credentials are placed only from custody, never from input, so the operation is blocked.",
        });
        continue;
      }
      if (RESERVED_HEADERS.has(lower)) {
        issues.add({
          code: "serialization.reserved-header-parameter",
          category: "serialization",
          pointer: parameter.pointer,
          dimension: "invoke",
          severity: "blocking",
          message: "A header parameter names a hop-by-hop or transport header that callers can never set; the operation is blocked.",
        });
        continue;
      }
      if (!HEADER_TOKEN.test(parameter.name)) {
        issues.add({
          code: "serialization.invalid-header-name",
          category: "serialization",
          pointer: parameter.pointer,
          dimension: "invoke",
          severity: "blocking",
          message: "A header parameter name is not a valid HTTP field name; the operation is blocked.",
        });
        continue;
      }
    }
    const style = parameter.style ?? (where === "query" ? "form" : "simple");
    const expectedStyle = where === "query" ? "form" : "simple";
    if (style !== expectedStyle) {
      issues.add({
        code: "serialization.unsupported-style",
        category: "serialization",
        pointer: parameter.pointer,
        dimension: "invoke",
        severity: "blocking",
        message: `The parameter style "${token(style, 24)}" is not part of the executable subset (path and header: simple; query: form); the operation is blocked.`,
      });
      continue;
    }
    const schema = compileParameterSchema(parameter);
    if (parameter.schema !== undefined) usesSchema = true;
    const shape = primitiveShape(schema, definitions);
    if (shape === "complex") {
      issues.add({
        code: "serialization.complex-parameter-unsupported",
        category: "serialization",
        pointer: parameter.pointer,
        dimension: "invoke",
        severity: "blocking",
        message: "Only primitive values and arrays of primitives are serialized as parameters; object-valued parameters block the operation.",
      });
      continue;
    }
    if (declaredNames.has(`${where}:${parameter.name}`)) continue;
    declaredNames.add(`${where}:${parameter.name}`);
    planParameters.push({
      name: parameter.name,
      in: where,
      required: parameter.required,
      style: expectedStyle,
      explode: where === "query" ? (parameter.explode ?? true) : false,
      allowReserved: where === "query" && parameter.allowReserved === true,
      schema,
    });
  }

  // Path template integrity: every expression has a parameter and every path parameter has an expression.
  const prefix = serverPrefix(operation, options, issues);
  const expressions = [...operation.path.matchAll(/\{([^{}]*)\}/g)].map((match) => match[1] ?? "");
  const pathParameterNames = new Set(
    planParameters.filter((parameter) => parameter.in === "path").map((parameter) => parameter.name),
  );
  for (const name of expressions)
    if (!pathParameterNames.has(name))
      issues.add({
        code: "structure.path-parameter-missing",
        category: "structure",
        pointer,
        dimension: "invoke",
        severity: "blocking",
        message: `The path template uses "{${token(name, 32)}}" without a usable path parameter; the operation is blocked.`,
      });
  for (const name of pathParameterNames)
    if (!expressions.includes(name))
      issues.add({
        code: "structure.path-parameter-unused",
        category: "structure",
        pointer,
        dimension: "invoke",
        severity: "blocking",
        message: `The path parameter "${token(name, 32)}" does not appear in the path template; the operation is blocked.`,
      });
  const pathTemplate = `${prefix ?? ""}${operation.path}`;
  if (
    prefix !== undefined &&
    (!/^\/[^\p{Cc}?#]*$/u.test(pathTemplate) ||
      pathTemplate.includes("//") ||
      pathTemplate.split("/").some((segment) => segment === "." || segment === ".."))
  )
    issues.add({
      code: "structure.invalid-path-template",
      category: "structure",
      pointer,
      dimension: "invoke",
      severity: "blocking",
      message: "The combined server path and operation path is not a single normalized absolute path; the operation is blocked.",
    });

  // Request body: JSON only.
  let requestBody: OperationPlan["requestBody"];
  if (operation.requestBody) {
    const body = operation.requestBody;
    const json = body.content.find((item) => isJsonMediaType(item.mediaType));
    const undeclared = body.content.find((item) => item.mediaType === "*/*");
    const unresolved = body.content.find((item) => item.mediaType === "unresolved");
    if (unresolved)
      issues.add({
        code: "structure.reference-unresolved",
        category: "structure",
        pointer: body.pointer,
        dimension: "invoke",
        severity: "blocking",
        message: "The request body reference could not be resolved; the operation is blocked.",
      });
    else if (json || (undeclared && options.assumeJsonWhenUndeclared)) {
      const chosenMedia = json ?? undeclared!;
      if (!json)
        issues.add({
          code: "serialization.request-media-type-assumed",
          category: "serialization",
          pointer: body.pointer,
          dimension: "invoke",
          severity: "warning",
          disposition: "adapted",
          message: "The document declares no request media type; JSON is assumed because the host review said so.",
        });
      const schema =
        chosenMedia.schema === undefined
          ? ({ kind: "any" } as CompiledSchema)
          : compileSchema(chosenMedia.schema, { documentKey: "", pointer: `${chosenMedia.pointer}/schema` }, schemaContext);
      if (chosenMedia.schema !== undefined) usesSchema = true;
      requestBody = { required: body.required, mediaType: "application/json", schema };
    } else if (undeclared)
      issues.add({
        code: "serialization.request-media-type-undeclared",
        category: "serialization",
        pointer: body.pointer,
        dimension: "invoke",
        severity: "blocking",
        message: "The document does not declare the request media type; the operation is blocked unless the host review assumes JSON.",
        remediation: "Declare `consumes` in the source or compile with assumeJsonWhenUndeclared.",
      });
    else
      issues.add({
        code: "serialization.unsupported-request-media-type",
        category: "serialization",
        pointer: body.pointer,
        dimension: "invoke",
        severity: "blocking",
        message: `The request body is only available as "${token(body.content[0]?.mediaType, 64)}"; this adapter sends JSON bodies only, so the operation is blocked.`,
      });
  }

  // Responses: success bodies must be JSON when they exist at all.
  const responses: OperationPlan["responses"] = [];
  for (const response of operation.responses) {
    const json = response.content.some((item) => isJsonMediaType(item.mediaType));
    const undeclared = response.content.some((item) => item.mediaType === "*/*");
    const success = /^2/.test(response.status) || response.status.toLowerCase() === "default" || response.status === "2XX";
    if (success && response.content.length && !json) {
      if (undeclared && options.assumeJsonWhenUndeclared)
        issues.add({
          code: "serialization.response-media-type-assumed",
          category: "serialization",
          pointer: response.pointer,
          dimension: "invoke",
          severity: "warning",
          disposition: "adapted",
          message: "The document declares no response media type; JSON is assumed because the host review said so.",
        });
      else
        issues.add({
          code: undeclared ? "serialization.response-media-type-undeclared" : "serialization.unsupported-response-media-type",
          category: "serialization",
          pointer: response.pointer,
          dimension: "invoke",
          severity: "blocking",
          message: undeclared
            ? "The document does not declare the response media type; the operation is blocked unless the host review assumes JSON."
            : `A success response is only available as "${token(response.content[0]?.mediaType, 64)}"; this adapter reads JSON responses only, so the operation is blocked.`,
        });
    }
    responses.push({ status: response.status.slice(0, 8), json: json || (undeclared && options.assumeJsonWhenUndeclared === true) });
  }

  if (usesSchema && !dialectOk)
    issues.add({
      code: "schema.dialect-unsupported",
      category: "schema",
      pointer: "#/jsonSchemaDialect",
      dimension: "invoke",
      severity: "blocking",
      message: "The document's default schema dialect is not implemented; operations with schemas are blocked rather than validated under different semantics.",
    });
  problemsToIssues(problems, issues, seenProblems);

  // Policy defaults and review.
  const review = options.review?.[operation.nativeId] ?? {};
  const isRead = method === "GET" || method === "HEAD";
  let effect: BoundOperation["effect"] = isRead ? "read" : "unknown";
  if (review.effect !== undefined) {
    if (review.effect === "read" && !isRead)
      issues.add({
        code: "policy.effect-overridden",
        category: "policy",
        pointer,
        dimension: "invoke",
        severity: "info",
        disposition: "adapted",
        message: "The host review declares a non-GET operation read-only; the description alone could not establish that.",
      });
    effect = review.effect;
  }
  const replay: BoundOperation["replay"] = review.replay ?? (effect === "read" ? "read-only" : "none");
  if (replay === "read-only" && effect !== "read")
    issues.add({
      code: "policy.invalid-review",
      category: "policy",
      pointer,
      dimension: "invoke",
      severity: "blocking",
      message: "Only a read operation can claim read-only replay; the review is inconsistent and the operation is blocked.",
    });
  const targetParameters = review.targetParameters ?? [];
  for (const name of targetParameters)
    if (!planParameters.some((parameter) => parameter.name === name))
      issues.add({
        code: "policy.target-parameter-unknown",
        category: "policy",
        pointer,
        dimension: "invoke",
        severity: "blocking",
        message: `The review names "${token(name, 32)}" as a target parameter but the operation declares no such usable parameter.`,
      });
  const description = safeText(review.description ?? operation.summary ?? "", 500);

  if (issues.blocking() || !chosen || prefix === undefined) return { issues: issues.issues };

  const finalDefinitions: Record<string, CompiledSchema> = {};
  for (const [name, schema] of definitions) finalDefinitions[name] = schema === "compiling" ? { kind: "never" } : schema;
  const operationRef = operationRefFor(definition, operation.nativeId);
  try {
    const plan = operationPlanSchema.parse({
      version: PLAN_VERSION,
      nativeId: operation.nativeId,
      method: method as HttpMethod,
      pathTemplate,
      parameters: planParameters,
      ...(requestBody ? { requestBody } : {}),
      responses,
      security: chosen,
      definitions: finalDefinitions,
      ...(options.maxResponseBytes ? { maxResponseBytes: options.maxResponseBytes } : {}),
    });
    const bound = boundOperationSchema.parse({
      operationRef,
      nativeId: operation.nativeId,
      destinationId: options.destinationId,
      transport: { kind: "http", method, pathTemplate },
      effect,
      outputClassification: review.outputClassification ?? "personal",
      cost: review.cost ?? "unknown",
      consent: review.consent ?? "confirm",
      replay,
      targetParameters,
      ...(chosen.profiles[0] ? { authenticationProfile: chosen.profiles[0].profileId } : {}),
      ...(description ? { description } : {}),
    });
    return { operation: bound, plan, issues: issues.issues };
  } catch {
    issues.add({
      code: "structure.binding-invalid",
      category: "structure",
      pointer,
      dimension: "invoke",
      severity: "blocking",
      message: "The operation could not be expressed as a valid bound operation; it is blocked.",
    });
    return { issues: issues.issues };
  }
}

/**
 * Compiles the executable subset of a read document into bound operations and
 * plans. Operations outside the subset are returned under `blocked` with
 * their diagnostics and are absent from the binding rows.
 */
export function compileOperations(
  definition: NormalizedDefinition,
  read: ReadResult,
  options: CompileOptions,
): CompileResult {
  const allowedProfiles =
    options.profiles ??
    definition.authentication
      .filter((profile) => EXECUTABLE_PROFILE_KINDS.has(profile.kind) && profile.kind !== "none")
      .map((profile) => profile.id);
  const include = options.include ? new Set(options.include) : undefined;
  const operations: BoundOperation[] = [];
  const plans: Record<string, OperationPlan> = {};
  const issues: CompatibilityIssue[] = [];
  const blocked: CompileResult["blocked"] = [];
  const executable: string[] = [];
  const capabilityIds = new Set(definition.capabilities.map((capability) => capability.nativeId));
  for (const operation of read.operations) {
    if (include && !include.has(operation.nativeId)) continue;
    if (!capabilityIds.has(operation.nativeId)) continue;
    const result = compileOne({ operation, definition, read, options, allowedProfiles });
    issues.push(...result.issues);
    if (result.operation && result.plan) {
      operations.push(result.operation);
      plans[result.operation.operationRef] = result.plan;
      executable.push(operation.nativeId);
    } else blocked.push({ nativeId: operation.nativeId, issues: result.issues });
  }
  let verifier: PlanSettings["verifier"];
  if (options.verifier) {
    const operationRef = operationRefFor(definition, options.verifier.nativeId);
    const bound = operations.find((item) => item.operationRef === operationRef);
    if (!bound || bound.effect !== "read") {
      const collector = new IssueCollector(4);
      collector.add({
        code: "policy.verifier-not-read",
        category: "policy",
        pointer: "#",
        dimension: "verify",
        severity: "blocking",
        executionImpact: "blocks-authorization",
        message: "The verifier named by the host is not a compiled read operation; verification cannot use it.",
      });
      issues.push(...collector.issues);
    } else
      verifier = {
        operationRef,
        ...(options.verifier.input === undefined ? {} : { input: options.verifier.input }),
      };
  }
  const settings: PlanSettings = {
    version: PLAN_VERSION,
    readerVersion: READER_VERSION,
    plans,
    ...(verifier ? { verifier } : {}),
  };
  return {
    operations,
    plans,
    settings: { [PLAN_SETTINGS_KEY]: settings },
    issues,
    blocked,
    executable,
  };
}
