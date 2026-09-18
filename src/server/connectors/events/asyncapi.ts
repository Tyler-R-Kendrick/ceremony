import { createHash } from "node:crypto";
import { z } from "zod";
import {
  DEFINITION_LIMITS,
  authenticationProfileSchema,
  canonicalDigest,
  compatibilityIssueSchema,
  completeDimensions,
  connectorReferenceSchema,
  nativeExtensionsSchema,
  nativeIdentifierSchema,
  nativeVersionSchema,
  normalizedDefinitionSchema,
  type AuthenticationProfile,
  type CompatibilityIssue,
  type EventDescriptor,
  type NormalizedDefinition,
} from "../../../core/connectors/index.js";
import { identifierSchema } from "../../../core/operation-contracts.js";
import { ConnectorError } from "../errors.js";

/*
 * AsyncAPI 3.0.0 / 3.1.0 reader. Channels, messages and operations become
 * event descriptors and nothing else: an AsyncAPI operation is never compiled
 * into an HTTP capability, because "receive over http" describes something
 * that calls us, not something we call. Channel address, message identity,
 * operation action, security and protocol bindings all survive in the
 * descriptor's native extensions. Only inbound operations whose every declared
 * protocol is HTTP are marked `http-webhook`; everything else keeps its native
 * transport and an issue that says exactly why it is not executable here. The
 * document is already-parsed JSON handed in by the import layer, and it is
 * treated as untrusted data throughout: references resolve only inside the
 * document, never expand recursively, and reserved keys are refused.
 */

export const ASYNCAPI_IMPORTER_ID = "asyncapi-3";
export const ASYNCAPI_IMPORTER_VERSION = "1.0.0";
export const supportedAsyncApiVersions = ["3.0.0", "3.1.0"] as const;
export type AsyncApiVersion = (typeof supportedAsyncApiVersions)[number];
export const ASYNCAPI_LIMITS = Object.freeze({
  servers: 32,
  channels: 512,
  operations: 512,
  messagesPerChannel: 128,
  events: DEFINITION_LIMITS.events,
  securitySchemes: DEFINITION_LIMITS.authentication,
  referenceHops: 16,
  traits: 8,
  bindingsPerLevel: 16,
  bindingBytes: 2048,
  descriptorExtensionBytes: 8192,
  extensionBytes: 32768,
  issues: DEFINITION_LIMITS.issues,
});
/** Protocol names in the AsyncAPI 3.1.0 bindings table; anything else is preserved as an unknown native binding. */
export const asyncApiBindingProtocols = [
  "http",
  "ws",
  "kafka",
  "anypointmq",
  "amqp",
  "amqp1",
  "mqtt",
  "mqtt5",
  "nats",
  "jms",
  "sns",
  "solace",
  "sqs",
  "stomp",
  "redis",
  "mercure",
  "ibmmq",
  "googlepubsub",
  "pulsar",
  "ros2",
] as const;
const knownBindings = new Set<string>(asyncApiBindingProtocols);

/**
 * Whose document this is. AsyncAPI describes "the application"; `send` and
 * `receive` are that application's actions. A document written for the
 * consuming application ("consumer", the default) receives webhooks through
 * `receive` operations; a document describing the provider itself emits them
 * through `send` operations. The choice is explicit and recorded, never
 * inferred from names.
 */
export const asyncApiPerspectives = ["consumer", "provider"] as const;
export type AsyncApiPerspective = (typeof asyncApiPerspectives)[number];

const optionsSchema = z.strictObject({
  sourceRef: connectorReferenceSchema,
  definitionRef: connectorReferenceSchema,
  identity: z
    .strictObject({
      authorityNamespace: z
        .string()
        .max(256)
        .regex(/^[^\p{Cc}]*$/u)
        .optional(),
      nativeId: nativeIdentifierSchema.optional(),
      nativeVersion: nativeVersionSchema.optional(),
    })
    .optional(),
  perspective: z.enum(asyncApiPerspectives).default("consumer"),
  importerVersion: nativeVersionSchema.default(ASYNCAPI_IMPORTER_VERSION),
});
export type ReadAsyncApiOptions = z.input<typeof optionsSchema>;

export type AsyncApiImport = {
  definition: NormalizedDefinition;
  issues: CompatibilityIssue[];
  /** Descriptor ids with transport `http-webhook`: candidates for an approved subscription, nothing more. */
  receivable: string[];
  document: {
    version: AsyncApiVersion;
    id?: string;
    title: string;
    infoVersion: string;
    perspective: AsyncApiPerspective;
  };
};

type Json = Record<string, unknown>;
const reserved = new Set(["__proto__", "prototype", "constructor"]);
const isPlainObject = (value: unknown): value is Json =>
  typeof value === "object" &&
  value !== null &&
  !Array.isArray(value) &&
  (Object.getPrototypeOf(value) === Object.prototype ||
    Object.getPrototypeOf(value) === null);
const escapePointer = (segment: string) =>
  segment.replace(/~/g, "~0").replace(/\//g, "~1");
const unescapePointer = (segment: string) =>
  segment.replace(/~1/g, "/").replace(/~0/g, "~");
const pointerOf = (...segments: string[]) =>
  `/${segments.map(escapePointer).join("/")}`.slice(0, 1024);
const sha = (value: string) =>
  createHash("sha256").update(value).digest("hex");
const bounds = (what: string) =>
  new ConnectorError("invalid-request", { detail: `asyncapi.bounds.${what}` });

function safeText(value: unknown, max: number): string | undefined {
  if (typeof value !== "string") return undefined;
  const text = value
    .replace(/\p{Cc}|[‪-‮⁦-⁩]/gu, " ")
    .trim();
  return text ? text.slice(0, max) : undefined;
}

/** A JSON-safe, depth- and size-bounded copy for inert preservation; oversize values are replaced by a marker, never truncated mid-structure. */
function boundedCopy(value: unknown, maxBytes: number): unknown {
  const strip = (item: unknown, depth: number): unknown => {
    if (depth > 12) return { $truncated: "depth" };
    if (item === null || typeof item !== "object")
      return typeof item === "string" || typeof item === "boolean"
        ? item
        : typeof item === "number" && Number.isFinite(item)
          ? item
          : null;
    if (Array.isArray(item))
      return item.slice(0, 256).map((entry) => strip(entry, depth + 1));
    if (!isPlainObject(item)) return null;
    const out: Json = {};
    for (const [key, entry] of Object.entries(item).slice(0, 256))
      if (!reserved.has(key) && key.length <= 120)
        out[key] = strip(entry, depth + 1);
    return out;
  };
  const copy = strip(value, 0);
  const bytes = Buffer.byteLength(JSON.stringify(copy) ?? "");
  return bytes > maxBytes ? { $truncated: "bytes", bytes } : copy;
}

class Issues {
  readonly list: CompatibilityIssue[] = [];
  add(issue: {
    code: string;
    category: CompatibilityIssue["category"];
    sourcePointer: string;
    dimension: CompatibilityIssue["dimension"];
    disposition: CompatibilityIssue["disposition"];
    severity: CompatibilityIssue["severity"];
    executionImpact: CompatibilityIssue["executionImpact"];
    message: string;
    remediation?: string;
  }): void {
    if (this.list.length >= ASYNCAPI_LIMITS.issues) throw bounds("issues");
    this.list.push(
      compatibilityIssueSchema.parse({
        ...issue,
        sourcePointer: issue.sourcePointer.slice(0, 1024),
        message: safeText(issue.message, 500) ?? "Unsupported construct",
        ...(issue.remediation
          ? { remediation: safeText(issue.remediation, 500) }
          : {}),
      }),
    );
  }
  unresolved(pointer: string, reason: string): void {
    this.add({
      code: `structure.unresolved-reference`,
      category: "structure",
      sourcePointer: pointer,
      dimension: "import",
      disposition: "rejected",
      severity: "warning",
      executionImpact: "blocks-operation",
      message: `A reference could not be resolved inside the document (${reason}); the construct is preserved by name only.`,
    });
  }
}

type Resolved =
  | { ok: true; value: unknown; pointer: string; ref?: string }
  | {
      ok: false;
      reason: "external" | "missing" | "cycle" | "depth" | "invalid";
    };

/** Local JSON-pointer references only; external documents are reported, never fetched. */
class Resolver {
  constructor(private readonly root: Json) {}
  resolve(node: unknown, at: string): Resolved {
    let current = node;
    let pointer = at;
    let ref: string | undefined;
    const seen = new Set<string>();
    for (let hops = 0; ; hops++) {
      if (!isPlainObject(current) || !Object.hasOwn(current, "$ref"))
        return { ok: true, value: current, pointer, ...(ref ? { ref } : {}) };
      const target = current.$ref;
      if (typeof target !== "string" || target.length > 2048)
        return { ok: false, reason: "invalid" };
      if (hops >= ASYNCAPI_LIMITS.referenceHops)
        return { ok: false, reason: "depth" };
      if (!target.startsWith("#/")) return { ok: false, reason: "external" };
      if (seen.has(target)) return { ok: false, reason: "cycle" };
      seen.add(target);
      const walked = this.walk(target);
      if (walked === undefined) return { ok: false, reason: "missing" };
      current = walked;
      pointer = target.slice(1);
      ref = target;
    }
  }
  private walk(target: string): unknown {
    let current: unknown = this.root;
    for (const raw of target.slice(2).split("/")) {
      const key = unescapePointer(raw);
      if (reserved.has(key)) return undefined;
      if (Array.isArray(current)) {
        if (!/^\d{1,6}$/.test(key)) return undefined;
        current = current[Number(key)];
      } else if (isPlainObject(current) && Object.hasOwn(current, key))
        current = current[key];
      else return undefined;
    }
    return current;
  }
}

/** Entries of a native map, skipping reserved keys with a rejected-disposition issue. */
function mapEntries(
  value: unknown,
  pointer: string,
  issues: Issues,
  what: string,
  limit: number,
): Array<[string, unknown]> {
  if (value === undefined) return [];
  if (!isPlainObject(value)) {
    issues.add({
      code: "structure.invalid-map",
      category: "structure",
      sourcePointer: pointer,
      dimension: "import",
      disposition: "rejected",
      severity: "warning",
      executionImpact: "none",
      message: `The ${what} map is not an object and was ignored.`,
    });
    return [];
  }
  const entries = Object.entries(value);
  if (entries.length > limit) throw bounds(what);
  return entries.filter(([key]) => {
    if (!reserved.has(key)) return true;
    issues.add({
      code: "structure.reserved-key",
      category: "structure",
      sourcePointer: pointerOf(...pointer.split("/").slice(1), key),
      dimension: "import",
      disposition: "rejected",
      severity: "warning",
      executionImpact: "none",
      message: `A ${what} entry uses a reserved object key and was ignored.`,
    });
    return false;
  });
}

/** Operation and message traits: a shallow JSON-merge in order, own fields last; bindings maps merge key-wise. */
function withTraits(
  object: Json,
  resolver: Resolver,
  at: string,
  issues: Issues,
): Json {
  if (!Array.isArray(object.traits) || !object.traits.length) return object;
  if (object.traits.length > ASYNCAPI_LIMITS.traits) throw bounds("traits");
  let merged: Json = {};
  let bindings: Json = {};
  object.traits.forEach((trait, index) => {
    const resolved = resolver.resolve(trait, `${at}/traits/${index}`);
    if (!resolved.ok || !isPlainObject(resolved.value)) {
      issues.unresolved(
        `${at}/traits/${index}`,
        resolved.ok ? "invalid" : resolved.reason,
      );
      return;
    }
    const clean = Object.fromEntries(
      Object.entries(resolved.value).filter(([key]) => !reserved.has(key)),
    );
    merged = { ...merged, ...clean };
    if (isPlainObject(clean.bindings))
      bindings = { ...bindings, ...clean.bindings };
  });
  const own = Object.fromEntries(
    Object.entries(object).filter(([key]) => !reserved.has(key)),
  );
  return {
    ...merged,
    ...own,
    bindings: {
      ...bindings,
      ...(isPlainObject(own.bindings) ? own.bindings : {}),
    },
  };
}

type BindingRecord = { protocols: string[]; copies: Json };
function bindingsOf(
  bindings: unknown,
  resolver: Resolver,
  at: string,
  issues: Issues,
): BindingRecord {
  const resolved = resolver.resolve(bindings, at);
  if (!resolved.ok) {
    issues.unresolved(at, resolved.reason);
    return { protocols: [], copies: {} };
  }
  if (resolved.value === undefined) return { protocols: [], copies: {} };
  const entries = mapEntries(
    resolved.value,
    at,
    issues,
    "bindings",
    ASYNCAPI_LIMITS.bindingsPerLevel,
  );
  const protocols: string[] = [];
  const copies: Json = {};
  for (const [protocol, binding] of entries) {
    if (!/^[a-z][a-z0-9]{0,31}$/.test(protocol)) {
      issues.add({
        code: "structure.unknown-binding",
        category: "structure",
        sourcePointer: at,
        dimension: "events",
        disposition: "native-extension",
        severity: "info",
        executionImpact: "none",
        message: "A binding uses a name outside the AsyncAPI bindings table.",
      });
      continue;
    }
    if (!knownBindings.has(protocol))
      issues.add({
        code: "structure.unknown-binding",
        category: "structure",
        sourcePointer: `${at}/${escapePointer(protocol)}`,
        dimension: "events",
        disposition: "native-extension",
        severity: "info",
        executionImpact: "none",
        message: `The "${protocol}" binding is not in the AsyncAPI 3.1.0 bindings table; it is preserved as native data.`,
      });
    protocols.push(protocol);
    const body = resolver.resolve(binding, `${at}/${escapePointer(protocol)}`);
    copies[protocol] = body.ok
      ? boundedCopy(body.value, ASYNCAPI_LIMITS.bindingBytes)
      : { $unresolved: body.reason };
  }
  return { protocols, copies };
}

/** Lower-cased header names a message declares, from a JSON Schema or a multi-format schema object. */
function headerNames(
  headers: unknown,
  resolver: Resolver,
  at: string,
): Set<string> {
  const names = new Set<string>();
  let resolved = resolver.resolve(headers, at);
  if (!resolved.ok || !isPlainObject(resolved.value)) return names;
  if (
    Object.hasOwn(resolved.value, "schemaFormat") &&
    Object.hasOwn(resolved.value, "schema")
  ) {
    resolved = resolver.resolve(resolved.value.schema, `${at}/schema`);
    if (!resolved.ok || !isPlainObject(resolved.value)) return names;
  }
  if (isPlainObject(resolved.value.properties))
    for (const key of Object.keys(resolved.value.properties).slice(0, 256))
      names.add(key.toLowerCase());
  return names;
}

const httpsOrLoopback = (value: unknown): string | undefined => {
  if (typeof value !== "string" || !URL.canParse(value)) return undefined;
  const url = new URL(value);
  const loopback =
    url.protocol === "http:" &&
    ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  return !url.username &&
    !url.password &&
    !url.hash &&
    (url.protocol === "https:" || loopback)
    ? value
    : undefined;
};

const scopeList = (value: unknown): string[] =>
  Array.isArray(value)
    ? value
        .filter(
          (item): item is string =>
            typeof item === "string" &&
            item.length > 0 &&
            item.length <= 200 &&
            !/\p{Cc}/u.test(item),
        )
        .slice(0, 64)
    : [];

type SchemeContext = {
  profiles: AuthenticationProfile[];
  byPointer: Map<string, string>;
  used: Set<string>;
  issues: Issues;
};

/** Maps one AsyncAPI Security Scheme Object to an authentication profile; whatever cannot execute here is preserved as `unsupported`. */
function schemeProfile(
  scheme: Json,
  id: string,
  nativeName: string,
  pointer: string,
  issues: Issues,
): AuthenticationProfile {
  const label = safeText(scheme.description, 100) ?? nativeName.slice(0, 100);
  const type = typeof scheme.type === "string" ? scheme.type : "unknown";
  const unsupported = (native: string, why: string): AuthenticationProfile => {
    issues.add({
      code: "security.unsupported-scheme",
      category: "security",
      sourcePointer: pointer,
      dimension: "authorize",
      disposition: "unsupported",
      severity: "blocking",
      executionImpact: "blocks-operation",
      message: `Security scheme "${native.slice(0, 64)}" cannot be executed by this runtime: ${why}`,
      remediation:
        "Operations that require this scheme stay descriptive; bind an approved profile or a broker route instead.",
    });
    return { id, label, kind: "unsupported", native: native.slice(0, 120) };
  };
  let candidate: unknown;
  switch (type) {
    case "http": {
      const httpScheme =
        typeof scheme.scheme === "string" ? scheme.scheme.toLowerCase() : "";
      if (httpScheme === "bearer")
        candidate = {
          id,
          label,
          kind: "http-bearer",
          ...(safeText(scheme.bearerFormat, 64)
            ? { format: safeText(scheme.bearerFormat, 64) }
            : {}),
        };
      else if (httpScheme === "basic")
        candidate = { id, label, kind: "http-basic" };
      else
        return unsupported(
          `http:${httpScheme || "unknown"}`,
          "only bearer and basic HTTP authentication are supported.",
        );
      break;
    }
    case "httpApiKey":
      candidate = {
        id,
        label,
        kind: "api-key",
        placement: scheme.in,
        parameterName: scheme.name,
      };
      break;
    case "oauth2": {
      const flows = isPlainObject(scheme.flows) ? scheme.flows : {};
      const code = isPlainObject(flows.authorizationCode)
        ? flows.authorizationCode
        : undefined;
      const client = isPlainObject(flows.clientCredentials)
        ? flows.clientCredentials
        : undefined;
      const requested = scopeList(scheme.scopes);
      if (code)
        candidate = {
          id,
          label,
          kind: "oauth-authorization-code",
          pkce: "unknown",
          ...(httpsOrLoopback(code.authorizationUrl)
            ? { authorizationEndpoint: code.authorizationUrl }
            : {}),
          ...(httpsOrLoopback(code.tokenUrl)
            ? { tokenEndpoint: code.tokenUrl }
            : {}),
          scopes: requested,
          scopeSemantics: isPlainObject(code.availableScopes)
            ? "provider-scopes"
            : "unknown",
          clientRegistration: "unknown",
          clientAuthentication: "unknown",
          refresh: typeof code.refreshUrl === "string" ? "supported" : "unknown",
        };
      else if (client)
        candidate = {
          id,
          label,
          kind: "oauth-client-credentials",
          ...(httpsOrLoopback(client.tokenUrl)
            ? { tokenEndpoint: client.tokenUrl }
            : {}),
          scopes: requested,
          clientAuthentication: "unknown",
        };
      else
        return unsupported(
          `oauth2:${Object.keys(flows).slice(0, 4).join("+") || "none"}`,
          "only authorization-code and client-credentials flows are executable.",
        );
      break;
    }
    case "openIdConnect": {
      const url = scheme.openIdConnectUrl;
      const suffix = "/.well-known/openid-configuration";
      const issuer =
        typeof url === "string" && url.endsWith(suffix)
          ? httpsOrLoopback(url.slice(0, -suffix.length))
          : undefined;
      if (!issuer)
        return unsupported(
          "openIdConnect",
          "the discovery URL does not name an HTTPS issuer.",
        );
      candidate = {
        id,
        label,
        kind: "openid-connect",
        issuer,
        scopes: scopeList(scheme.scopes),
      };
      break;
    }
    case "userPassword":
    case "apiKey":
    case "X509":
    case "symmetricEncryption":
    case "asymmetricEncryption":
    case "plain":
    case "scramSha256":
    case "scramSha512":
    case "gssapi":
      return unsupported(
        type,
        "it is a broker-level mechanism with no HTTP execution profile.",
      );
    default:
      return unsupported(
        `unknown:${type.slice(0, 40)}`,
        "the scheme type is not part of AsyncAPI 3.x.",
      );
  }
  const parsed = authenticationProfileSchema.safeParse(candidate);
  if (parsed.success) return parsed.data;
  return unsupported(
    type,
    "its declared endpoints or parameters are incomplete or not HTTPS.",
  );
}

/** Profile id for a scheme: the native name when it is a valid identifier, otherwise a stable digest-derived id. */
function profileIdFor(nativeName: string, used: Set<string>): string {
  let candidate = identifierSchema.safeParse(nativeName).success
    ? nativeName
    : `scheme-${sha(nativeName).slice(0, 12)}`;
  while (used.has(candidate)) candidate = `${candidate}-alt`;
  used.add(candidate);
  return candidate;
}

/** Security list of a server or operation: any-of semantics, ids of profiles, inline schemes registered on the fly. */
function securityIds(
  security: unknown,
  at: string,
  resolver: Resolver,
  context: SchemeContext,
): string[] | undefined {
  if (security === undefined) return undefined;
  if (!Array.isArray(security)) {
    context.issues.add({
      code: "security.invalid-requirement",
      category: "security",
      sourcePointer: at,
      dimension: "authorize",
      disposition: "rejected",
      severity: "blocking",
      executionImpact: "blocks-operation",
      message: "The security list is not an array; the requirement is refused.",
    });
    return undefined;
  }
  const ids: string[] = [];
  security.slice(0, 16).forEach((entry, index) => {
    const pointer = `${at}/${index}`;
    const resolved = resolver.resolve(entry, pointer);
    if (!resolved.ok || !isPlainObject(resolved.value)) {
      context.issues.unresolved(
        pointer,
        resolved.ok ? "invalid" : resolved.reason,
      );
      return;
    }
    const known = context.byPointer.get(resolved.pointer);
    if (known) {
      if (!ids.includes(known)) ids.push(known);
      return;
    }
    if (context.profiles.length >= ASYNCAPI_LIMITS.securitySchemes)
      throw bounds("security-schemes");
    const nativeName =
      resolved.ref === undefined
        ? `inline:${resolved.pointer}`
        : (resolved.pointer.split("/").pop() ?? resolved.pointer);
    const id = profileIdFor(
      resolved.ref === undefined
        ? `inline-${sha(resolved.pointer).slice(0, 12)}`
        : nativeName,
      context.used,
    );
    context.byPointer.set(resolved.pointer, id);
    context.profiles.push(
      schemeProfile(
        resolved.value,
        id,
        nativeName,
        resolved.pointer,
        context.issues,
      ),
    );
    ids.push(id);
  });
  return ids;
}

const httpLike = (protocol: string) =>
  protocol === "http" || protocol === "https";

export async function readAsyncApi(
  document: unknown,
  options: ReadAsyncApiOptions,
): Promise<AsyncApiImport> {
  const opts = optionsSchema.parse(options);
  if (!isPlainObject(document))
    throw new ConnectorError("invalid-request", {
      detail: "asyncapi.document.not-object",
    });
  const version = document.asyncapi;
  if (typeof version !== "string")
    throw new ConnectorError("invalid-request", {
      detail: "asyncapi.version.missing",
    });
  if (!(supportedAsyncApiVersions as readonly string[]).includes(version))
    throw new ConnectorError("unsupported", {
      detail: "asyncapi.version.unsupported",
    });
  const info = document.info;
  const title = isPlainObject(info) ? safeText(info.title, 200) : undefined;
  const infoVersion = isPlainObject(info)
    ? safeText(info.version, 128)
    : undefined;
  if (!title || !infoVersion)
    throw new ConnectorError("invalid-request", {
      detail: "asyncapi.info.invalid",
    });
  const issues = new Issues();
  const resolver = new Resolver(document);
  const schemes: SchemeContext = {
    profiles: [],
    byPointer: new Map(),
    used: new Set(),
    issues,
  };

  // Declared security schemes first, so operations reference stable ids.
  const components = isPlainObject(document.components)
    ? document.components
    : {};
  for (const [name, raw] of mapEntries(
    components.securitySchemes,
    "/components/securitySchemes",
    issues,
    "security-schemes",
    ASYNCAPI_LIMITS.securitySchemes,
  )) {
    const pointer = pointerOf("components", "securitySchemes", name);
    const resolved = resolver.resolve(raw, pointer);
    if (!resolved.ok || !isPlainObject(resolved.value)) {
      issues.unresolved(pointer, resolved.ok ? "invalid" : resolved.reason);
      continue;
    }
    const id = profileIdFor(name, schemes.used);
    schemes.byPointer.set(pointer, id);
    schemes.profiles.push(
      schemeProfile(resolved.value, id, name, pointer, issues),
    );
  }

  // Servers: declared, never approved.
  type ServerInfo = {
    name: string;
    protocol: string;
    security: string[] | undefined;
    bindings: BindingRecord;
    summary: Json;
  };
  const servers = new Map<string, ServerInfo>();
  const declaredServers: NormalizedDefinition["declaredServers"] = [];
  for (const [name, raw] of mapEntries(
    document.servers,
    "/servers",
    issues,
    "servers",
    ASYNCAPI_LIMITS.servers,
  )) {
    const pointer = pointerOf("servers", name);
    const resolved = resolver.resolve(raw, pointer);
    if (!resolved.ok || !isPlainObject(resolved.value)) {
      issues.unresolved(pointer, resolved.ok ? "invalid" : resolved.reason);
      continue;
    }
    const server = resolved.value;
    const host = safeText(server.host, 1024);
    const protocol = safeText(server.protocol, 32)?.toLowerCase();
    if (!host || !protocol || /\s/.test(host)) {
      issues.add({
        code: "structure.invalid-server",
        category: "structure",
        sourcePointer: pointer,
        dimension: "import",
        disposition: "rejected",
        severity: "warning",
        executionImpact: "none",
        message: "A server lacks a usable host or protocol and was ignored.",
      });
      continue;
    }
    const pathname = safeText(server.pathname, 512) ?? "";
    const security = securityIds(
      server.security,
      `${pointer}/security`,
      resolver,
      schemes,
    );
    const bindings = bindingsOf(
      server.bindings,
      resolver,
      `${pointer}/bindings`,
      issues,
    );
    const url = `${protocol}://${host}${pathname}`.slice(0, 2048);
    declaredServers.push({
      url,
      ...(safeText(server.description, 500)
        ? { description: safeText(server.description, 500) }
        : {}),
      status: "declared",
    });
    servers.set(name, {
      name,
      protocol,
      security,
      bindings,
      summary: {
        host,
        protocol,
        ...(safeText(server.protocolVersion, 64)
          ? { protocolVersion: safeText(server.protocolVersion, 64) }
          : {}),
        ...(pathname ? { pathname } : {}),
        ...(security === undefined ? {} : { security }),
        bindings: bindings.protocols,
      },
    });
  }

  // Channels: address, messages and bindings, keyed by their native names.
  type ChannelInfo = {
    name: string;
    pointer: string;
    address: string | null | undefined;
    title: string | undefined;
    servers: string[] | undefined;
    messages: Array<[string, unknown, string]>;
    bindings: BindingRecord;
  };
  const channels = new Map<string, ChannelInfo>();
  const channelEntries = mapEntries(
    document.channels,
    "/channels",
    issues,
    "channels",
    ASYNCAPI_LIMITS.channels,
  );
  const readChannel = (
    name: string,
    raw: unknown,
    pointer: string,
  ): ChannelInfo | undefined => {
    const resolved = resolver.resolve(raw, pointer);
    if (!resolved.ok || !isPlainObject(resolved.value)) {
      issues.unresolved(pointer, resolved.ok ? "invalid" : resolved.reason);
      return undefined;
    }
    const channel = resolved.value;
    const channelPointer = resolved.pointer;
    const serverRefs = Array.isArray(channel.servers)
      ? channel.servers
          .slice(0, ASYNCAPI_LIMITS.servers)
          .map((item) =>
            isPlainObject(item) && typeof item.$ref === "string"
              ? item.$ref.match(/^#\/servers\/([^/]+)$/)?.[1]
              : undefined,
          )
          .filter((item): item is string => item !== undefined)
          .map(unescapePointer)
      : undefined;
    const messages = mapEntries(
      channel.messages,
      `${channelPointer}/messages`,
      issues,
      "messages",
      ASYNCAPI_LIMITS.messagesPerChannel,
    ).map(
      ([key, value]): [string, unknown, string] => [
        key,
        value,
        `${channelPointer}/messages/${escapePointer(key)}`,
      ],
    );
    return {
      name,
      pointer: channelPointer,
      address:
        channel.address === null
          ? null
          : (safeText(channel.address, 1024) ?? undefined),
      title: safeText(channel.title, 200),
      servers: serverRefs,
      messages,
      bindings: bindingsOf(
        channel.bindings,
        resolver,
        `${channelPointer}/bindings`,
        issues,
      ),
    };
  };
  for (const [name, raw] of channelEntries) {
    const info = readChannel(name, raw, pointerOf("channels", name));
    if (info) channels.set(name, info);
  }

  // Operations become event descriptors, one per (operation, message).
  const events: EventDescriptor[] = [];
  const receivable: string[] = [];
  for (const [operationKey, raw] of mapEntries(
    document.operations,
    "/operations",
    issues,
    "operations",
    ASYNCAPI_LIMITS.operations,
  )) {
    const pointer = pointerOf("operations", operationKey);
    if (!nativeIdentifierSchema.safeParse(operationKey).success) {
      issues.add({
        code: "structure.invalid-identifier",
        category: "structure",
        sourcePointer: pointer,
        dimension: "events",
        disposition: "rejected",
        severity: "warning",
        executionImpact: "blocks-operation",
        message: "An operation key is not a usable identifier and was skipped.",
      });
      continue;
    }
    const resolved = resolver.resolve(raw, pointer);
    if (!resolved.ok || !isPlainObject(resolved.value)) {
      issues.unresolved(pointer, resolved.ok ? "invalid" : resolved.reason);
      continue;
    }
    const operation = withTraits(resolved.value, resolver, pointer, issues);
    const action = operation.action;
    if (action !== "send" && action !== "receive") {
      issues.add({
        code: "structure.invalid-operation",
        category: "structure",
        sourcePointer: `${pointer}/action`,
        dimension: "events",
        disposition: "rejected",
        severity: "warning",
        executionImpact: "blocks-operation",
        message: 'An operation action is neither "send" nor "receive".',
      });
      continue;
    }
    const inbound =
      opts.perspective === "consumer"
        ? action === "receive"
        : action === "send";

    // The channel: a reference into /channels (or an inline channel object).
    let channel: ChannelInfo | undefined;
    let channelProblem: string | undefined;
    const channelRef =
      isPlainObject(operation.channel) &&
      typeof operation.channel.$ref === "string"
        ? operation.channel.$ref
        : undefined;
    const named = channelRef?.match(/^#\/channels\/([^/]+)$/)?.[1];
    if (named !== undefined && channels.has(unescapePointer(named)))
      channel = channels.get(unescapePointer(named));
    else if (operation.channel !== undefined) {
      const inline = readChannel(
        named === undefined ? operationKey : unescapePointer(named),
        operation.channel,
        `${pointer}/channel`,
      );
      if (inline) channel = inline;
      else channelProblem = "unresolved";
    } else channelProblem = "missing";
    if (channelProblem === "missing")
      issues.add({
        code: "structure.invalid-operation",
        category: "structure",
        sourcePointer: `${pointer}/channel`,
        dimension: "events",
        disposition: "rejected",
        severity: "warning",
        executionImpact: "blocks-operation",
        message: "An operation names no channel.",
      });

    const security = securityIds(
      operation.security,
      `${pointer}/security`,
      resolver,
      schemes,
    );
    const operationBindings = bindingsOf(
      operation.bindings,
      resolver,
      `${pointer}/bindings`,
      issues,
    );
    const channelServers =
      channel?.servers === undefined
        ? [...servers.values()]
        : channel.servers
            .map((name) => servers.get(name))
            .filter((item): item is ServerInfo => item !== undefined);

    // Messages: the operation's subset, else every message of the channel.
    let messages: Array<[string, unknown, string]> = channel?.messages ?? [];
    if (Array.isArray(operation.messages)) {
      const selected: Array<[string, unknown, string]> = [];
      operation.messages
        .slice(0, ASYNCAPI_LIMITS.messagesPerChannel)
        .forEach((item, index) => {
          const ref =
            isPlainObject(item) && typeof item.$ref === "string"
              ? item.$ref
              : undefined;
          const key = unescapePointer(
            ref?.match(/^#\/channels\/[^/]+\/messages\/([^/]+)$/)?.[1] ??
              ref?.split("/").pop() ??
              `message-${index}`,
          );
          selected.push([key, item, `${pointer}/messages/${index}`]);
        });
      messages = selected;
    }

    const describe = (
      messageKey: string | undefined,
      rawMessage: unknown,
      messagePointer: string,
    ) => {
      if (events.length >= ASYNCAPI_LIMITS.events) throw bounds("events");
      const nativeId =
        messageKey === undefined ? operationKey : `${operationKey}/${messageKey}`;
      if (!nativeIdentifierSchema.safeParse(nativeId).success) {
        issues.add({
          code: "structure.invalid-identifier",
          category: "structure",
          sourcePointer: messagePointer,
          dimension: "events",
          disposition: "rejected",
          severity: "warning",
          executionImpact: "blocks-operation",
          message: "A message key is not a usable identifier and was skipped.",
        });
        return;
      }
      let message: Json = {};
      let messageRef: string | undefined;
      if (rawMessage !== undefined) {
        const resolvedMessage = resolver.resolve(rawMessage, messagePointer);
        if (!resolvedMessage.ok || !isPlainObject(resolvedMessage.value))
          issues.unresolved(
            messagePointer,
            resolvedMessage.ok ? "invalid" : resolvedMessage.reason,
          );
        else {
          message = withTraits(
            resolvedMessage.value,
            resolver,
            resolvedMessage.pointer,
            issues,
          );
          messageRef = resolvedMessage.pointer;
        }
      }
      const messageBindings = bindingsOf(
        message.bindings,
        resolver,
        `${messageRef ?? messagePointer}/bindings`,
        issues,
      );
      const protocols: string[] = [];
      for (const protocol of [
        ...operationBindings.protocols,
        ...(channel?.bindings.protocols ?? []),
        ...messageBindings.protocols,
        ...channelServers.map((server) => server.protocol),
      ])
        if (!protocols.includes(protocol)) protocols.push(protocol);

      let transport: EventDescriptor["transport"] = "unsupported";
      let nativeTransport: string | undefined = protocols.find(
        (protocol) => !httpLike(protocol),
      ) ?? protocols[0];
      if (channelProblem) {
        issues.unresolved(`${pointer}/channel`, channelProblem);
      } else if (!inbound) {
        issues.add({
          code: "structure.unsupported-direction",
          category: "structure",
          sourcePointer: pointer,
          dimension: "events",
          disposition: "unsupported",
          severity: "info",
          executionImpact: "blocks-operation",
          message: `Operation "${operationKey.slice(0, 64)}" is outbound from Ceremony's ${opts.perspective} perspective; Ceremony has no publisher runtime for it.`,
        });
      } else if (protocols.length && protocols.every(httpLike)) {
        transport = "http-webhook";
        nativeTransport = undefined;
      } else if (!protocols.length) {
        issues.add({
          code: "structure.undeclared-transport",
          category: "structure",
          sourcePointer: pointer,
          dimension: "events",
          disposition: "unsupported",
          severity: "info",
          executionImpact: "blocks-operation",
          message: `Operation "${operationKey.slice(0, 64)}" declares no server or binding protocol, so no webhook profile can be claimed for it.`,
        });
      } else {
        issues.add({
          code: "structure.unsupported-transport",
          category: "structure",
          sourcePointer: pointer,
          dimension: "events",
          disposition: "unsupported",
          severity: "info",
          executionImpact: "blocks-operation",
          message: `Operation "${operationKey.slice(0, 64)}" uses ${protocols
            .map((protocol) => `"${protocol}"`)
            .join(", ")}; only HTTP webhook delivery is supported, so it stays descriptive.`,
          remediation:
            "Broker transports (Kafka, AMQP, MQTT, WebSocket ...) are preserved as native bindings; delegate them to a host runner or a broker adapter.",
        });
      }

      const headers = headerNames(
        message.headers,
        resolver,
        `${messageRef ?? messagePointer}/headers`,
      );
      const standard = ["webhook-id", "webhook-timestamp", "webhook-signature"];
      const signatureLike = [...headers].some((name) =>
        /signature|hmac|x-hub|-sig$/i.test(name),
      );
      const verification: EventDescriptor["verification"] = standard.every(
        (name) => headers.has(name),
      )
        ? "standard-webhooks"
        : signatureLike || (security !== undefined && security.length > 0)
          ? "vendor"
          : security !== undefined && security.length === 0 && headers.size
            ? "none"
            : "unknown";

      const payload = message.payload;
      const payloadRef =
        isPlainObject(payload) && typeof payload.$ref === "string"
          ? payload.$ref.startsWith("#/")
            ? payload.$ref.slice(1)
            : undefined
          : payload === undefined
            ? undefined
            : `${messageRef ?? messagePointer}/payload`;
      const schemaFormat =
        isPlainObject(payload) && typeof payload.schemaFormat === "string"
          ? safeText(payload.schemaFormat, 120)
          : undefined;
      const httpBinding = operationBindings.copies.http;
      const extension = {
        asyncapi: {
          operation: operationKey,
          action,
          direction: inbound ? "inbound" : "outbound",
          perspective: opts.perspective,
          ...(channel
            ? {
                channel: {
                  name: channel.name,
                  address: channel.address ?? null,
                  ...(channel.title ? { title: channel.title } : {}),
                  ...(channel.servers ? { servers: channel.servers } : {}),
                },
              }
            : {}),
          ...(messageKey === undefined
            ? {}
            : {
                message: {
                  key: messageKey,
                  ...(safeText(message.name, 200)
                    ? { name: safeText(message.name, 200) }
                    : {}),
                  ...(safeText(message.title, 200)
                    ? { title: safeText(message.title, 200) }
                    : {}),
                  ...(safeText(message.contentType, 120)
                    ? { contentType: safeText(message.contentType, 120) }
                    : {}),
                  ...(payloadRef ? { payloadRef } : {}),
                  ...(schemaFormat ? { schemaFormat } : {}),
                  headers: [...headers].slice(0, 64),
                },
              }),
          protocols,
          ...(isPlainObject(httpBinding) &&
          typeof httpBinding.method === "string"
            ? { http: { method: httpBinding.method.slice(0, 16) } }
            : {}),
          bindings: {
            operation: operationBindings.copies,
            channel: channel?.bindings.copies ?? {},
            message: messageBindings.copies,
          },
          security: {
            semantics: "any-of",
            declared: security !== undefined,
            profiles: security ?? [],
          },
        },
      };
      const label =
        safeText(message.title, 200) ??
        safeText(message.name, 200) ??
        safeText(operation.title, 200) ??
        nativeId.slice(0, 200);
      events.push({
        nativeId,
        label,
        transport,
        ...(nativeTransport === undefined
          ? {}
          : { nativeTransport: nativeTransport.slice(0, 64) }),
        verification,
        ...(payloadRef ? { messageSchemaRef: payloadRef.slice(0, 1024) } : {}),
        ...(security === undefined ? {} : { authentication: security }),
        nativeExtensions: {
          asyncapi: boundedCopy(
            extension.asyncapi,
            ASYNCAPI_LIMITS.descriptorExtensionBytes,
          ),
        },
      });
      if (transport === "http-webhook") receivable.push(nativeId);
    };

    if (messages.length)
      for (const [messageKey, rawMessage, messagePointer] of messages)
        describe(messageKey, rawMessage, messagePointer);
    else describe(undefined, undefined, pointer);
  }

  // Document-level native data, bounded: identity fields, servers, channels and root extensions.
  const rootExtensions = Object.fromEntries(
    Object.entries(document)
      .filter(([key]) => key.startsWith("x-") && !reserved.has(key))
      .slice(0, 64)
      .map(([key, value]) => [
        key.slice(0, 120),
        boundedCopy(value, ASYNCAPI_LIMITS.bindingBytes),
      ]),
  );
  const infoCopy = isPlainObject(info)
    ? boundedCopy(info, ASYNCAPI_LIMITS.bindingBytes * 2)
    : {};
  const nativeDocument: Json = {
    version,
    perspective: opts.perspective,
    ...(typeof document.id === "string" && safeText(document.id, 512)
      ? { id: safeText(document.id, 512) }
      : {}),
    ...(safeText(document.defaultContentType, 120)
      ? { defaultContentType: safeText(document.defaultContentType, 120) }
      : {}),
    info: infoCopy,
    servers: Object.fromEntries(
      [...servers.values()].map((server) => [server.name, server.summary]),
    ),
    channels: Object.fromEntries(
      [...channels.values()].map((channel) => [
        channel.name,
        {
          address: channel.address ?? null,
          messages: channel.messages.map(([key]) => key),
          ...(channel.servers ? { servers: channel.servers } : {}),
          bindings: channel.bindings.protocols,
        },
      ]),
    ),
    extensions: rootExtensions,
  };
  let nativeExtensions: Json = { asyncapi: nativeDocument };
  if (
    Buffer.byteLength(JSON.stringify(nativeExtensions)) >
    ASYNCAPI_LIMITS.extensionBytes
  )
    nativeExtensions = {
      asyncapi: {
        ...nativeDocument,
        info: { title },
        channels: { $truncated: "bytes", count: channels.size },
        extensions: { $truncated: "bytes" },
      },
    };
  nativeExtensions = nativeExtensionsSchema.parse(nativeExtensions);

  const executable = schemes.profiles.some((profile) =>
    [
      "oauth-authorization-code",
      "oauth-client-credentials",
      "api-key",
      "http-bearer",
      "http-basic",
      "openid-connect",
    ].includes(profile.kind),
  );
  const nativeId =
    opts.identity?.nativeId ??
    (typeof document.id === "string" &&
    nativeIdentifierSchema.safeParse(document.id).success
      ? document.id
      : title);
  const identity = {
    ecosystem: "asyncapi",
    authorityNamespace: opts.identity?.authorityNamespace ?? "",
    nativeId,
    nativeVersion: opts.identity?.nativeVersion ?? infoVersion,
  };
  const service = title
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^[^a-z0-9]+|[^a-z0-9._-]+$/g, "")
    .slice(0, 120);
  const body = {
    schemaVersion: 1 as const,
    identity,
    importer: { id: ASYNCAPI_IMPORTER_ID, version: opts.importerVersion },
    display: {
      name: title,
      description:
        (isPlainObject(info) && safeText(info.description, 500)) || "",
      ecosystem: "asyncapi",
      ...(service && /^[a-z0-9]/.test(service) ? { service } : {}),
    },
    authentication: schemes.profiles,
    configuration: [],
    capabilities: [],
    events,
    declaredServers,
    compatibility: {
      issues: issues.list,
      dimensions: completeDimensions({
        import: "adapted",
        events: receivable.length ? "adapted" : "unsupported",
        ...(executable ? { authorize: "requires-configuration" } : {}),
        ...(receivable.length ? { verify: "requires-configuration" } : {}),
      }),
    },
    nativeExtensions,
  };
  const normalizedDigest = await canonicalDigest(body);
  const parsed = normalizedDefinitionSchema.safeParse({
    ...body,
    definitionRef: opts.definitionRef,
    sourceRef: opts.sourceRef,
    normalizedDigest,
  });
  if (!parsed.success)
    throw new ConnectorError("invalid-request", {
      detail: "asyncapi.definition.invalid",
      cause: parsed.error,
    });
  return {
    definition: parsed.data,
    issues: parsed.data.compatibility.issues,
    receivable,
    document: {
      version: version as AsyncApiVersion,
      ...(typeof nativeDocument.id === "string" ? { id: nativeDocument.id } : {}),
      title,
      infoVersion,
      perspective: opts.perspective,
    },
  };
}
