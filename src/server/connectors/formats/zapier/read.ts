import type {
  AuthenticationProfile,
  ConfigurationRequirement,
  EventDescriptor,
  NativeCapability,
} from "../../../../core/connectors/index.js";
import {
  IssueCollector,
  inertCopy,
  locate,
  nativeId as asNativeId,
  pointer,
  safeText,
  serviceKey,
  token,
} from "../automation/common.js";
import {
  automationCapabilityRows,
  buildAutomationDefinition,
  type AutomationReadResult,
} from "../automation/definition.js";
import {
  asArray,
  asBoolean,
  asObject,
  asString,
  findExportedValueIndex,
  fromJsonValue,
  objectValue,
  parseJsSource,
  readValueAt,
  toJsonValue,
  type JsLoc,
  type StaticEntry,
  type StaticValue,
} from "../automation/js-literals.js";
import {
  ZAPIER_CURLIES,
  ZAPIER_ECOSYSTEM,
  ZAPIER_FUNC_MARKER,
  ZAPIER_IMPORTER,
  ZAPIER_KEY,
  ZAPIER_LIMITS,
  ZAPIER_PROFILES,
  ZAPIER_VERSION,
} from "./profile.js";

/*
 * Reads a Zapier Platform app definition into a normalized description.
 *
 * Two inputs are accepted and they are read the same way once parsed: an
 * exported JSON definition (preferred, and what `zapier` itself produces),
 * and CLI source text, from which a bounded syntactic pass extracts literal
 * metadata only. Nothing is required, imported, compiled or evaluated in
 * either path. Every `perform`, middleware, hydrator, dynamic dropdown and
 * `{{curly}}` template is recorded as an inert diagnostic with a pointer, and
 * the metadata around it is still imported, because a reviewer needs to see
 * what the app claims to do even when this runtime cannot do it.
 */

export type ZapierIdentityHint = {
  nativeId?: string;
  nativeVersion?: string;
  authorityNamespace?: string;
  displayName?: string;
  description?: string;
  service?: string;
};

export type ZapierReadInput = {
  /** An exported app definition, already parsed from JSON. */
  json?: unknown;
  /** CLI source text; read by the bounded syntactic extractor. */
  sourceText?: string;
  /**
   * Host-supplied identity. The app schema carries no identifier or display
   * name, so a host that has one (an upload name, a Zapier app id) passes it
   * here; the reader never invents one.
   */
  identity?: ZapierIdentityHint;
};

type FunctionForm =
  | "func-marker"
  | "require"
  | "source"
  | "function"
  | "expression"
  | "template-expression"
  | "reference"
  | "call"
  | "regex"
  | "spread"
  | "computed-key"
  | "truncated";

/** Classifies a value that is code rather than data, or returns undefined. */
function functionForm(
  value: StaticValue | undefined,
): FunctionForm | undefined {
  if (!value) return undefined;
  if (value.kind === "opaque") return value.reason;
  if (value.kind === "string" && ZAPIER_FUNC_MARKER.test(value.value))
    return "func-marker";
  if (value.kind === "object") {
    const keys = value.entries.map((entry) => entry.key);
    if (keys.includes("require")) return "require";
    if (keys.includes("source")) return "source";
  }
  return undefined;
}

const FORM_MESSAGE: Record<FunctionForm, string> = {
  "func-marker": "a function pointer in the exported definition",
  require: "a function loaded from a file path",
  source: "inline function source",
  function: "a function literal",
  expression: "a computed expression",
  "template-expression": "a template string with a substitution",
  reference: "a reference to another binding",
  call: "a function call",
  regex: "a regular expression literal",
  spread: "a spread of another value",
  "computed-key": "a computed property key",
  truncated: "a value beyond the reader's bounds",
};

/** A literal `RequestSchema`/`RedirectRequestSchema`, or undefined. */
function literalRequest(
  value: StaticValue | undefined,
): { method?: string; url: string } | undefined {
  if (value?.kind !== "object") return undefined;
  const url = asString(objectValue(value, "url"));
  if (url === undefined || ZAPIER_CURLIES.test(url)) return undefined;
  if (!/^https:\/\/[^\s]+$/i.test(url)) return undefined;
  if (!URL.canParse(url)) return undefined;
  const parsed = new URL(url);
  if (parsed.username || parsed.password) return undefined;
  const method = asString(objectValue(value, "method"));
  return method === undefined ? { url } : { method, url };
}

/** A literal URL string that is not a request object (oauth2 `authorizeUrl` may be either). */
function literalUrl(value: StaticValue | undefined): string | undefined {
  const request = literalRequest(value);
  if (request) return request.url;
  const text = asString(value);
  if (text === undefined || ZAPIER_CURLIES.test(text)) return undefined;
  if (!/^https:\/\/[^\s]+$/i.test(text) || !URL.canParse(text))
    return undefined;
  const parsed = new URL(text);
  return parsed.username || parsed.password ? undefined : text;
}

function configurationName(
  appKey: string,
  fieldKey: string,
  used: Set<string>,
): string {
  const clean = (value: string) =>
    value
      .toUpperCase()
      .replace(/[^A-Z0-9]+/g, "_")
      .replace(/^_+|_+$/g, "");
  const base = `ZAPIER_${clean(appKey)}_${clean(fieldKey)}`
    .replace(/_{2,}/g, "_")
    .slice(0, 96);
  let candidate = /^[A-Z]/.test(base) ? base : `ZAPIER_${base}`.slice(0, 96);
  let counter = 2;
  while (used.has(candidate)) {
    const suffix = `_${counter++}`;
    candidate = `${candidate.slice(0, 96 - suffix.length)}${suffix}`;
  }
  used.add(candidate);
  return candidate;
}

const SENSITIVE_FIELD =
  /(password|secret|token|key|credential|signature|passphrase)/i;

type AuthRead = {
  profiles: AuthenticationProfile[];
  configuration: ConfigurationRequirement[];
  limitations: string[];
  profileIds: string[];
  /** Literal authentication metadata, preserved verbatim for review and export. */
  native: Record<string, unknown>;
};

function readAuthentication(
  authentication: StaticValue | undefined,
  appKey: string,
  issues: IssueCollector,
  file: string | undefined,
  declaredServers: Map<string, string>,
): AuthRead {
  const result: AuthRead = {
    profiles: [],
    configuration: [],
    limitations: [],
    profileIds: [],
    native: {},
  };
  if (!authentication) return result;
  if (authentication.kind !== "object") {
    issues.add({
      code: "zapier.authentication.not-literal",
      category: "security",
      pointer: locate(pointer("authentication"), {
        ...authentication.loc,
        ...(file ? { file } : {}),
      }),
      dimension: "authorize",
      severity: "blocking",
      disposition: "unsupported",
      executionImpact: "blocks-authorization",
      message:
        "The authentication block is not a literal object, so no authentication method could be read from it.",
      remediation:
        "Import an exported app definition in which authentication is a literal object.",
    });
    return result;
  }
  const at = (...segments: Array<string | number>) =>
    locate(pointer("authentication", ...segments), {
      ...authentication.loc,
      ...(file ? { file } : {}),
    });

  const type = asString(objectValue(authentication, "type"));
  if (type !== undefined) result.native["type"] = type;
  if (objectValue(authentication, "test") !== undefined)
    result.native["hasTest"] = true;
  const used = new Set<string>();
  const fields = asArray(objectValue(authentication, "fields")) ?? [];
  if (
    objectValue(authentication, "fields") &&
    !asArray(objectValue(authentication, "fields"))
  )
    issues.add({
      code: "zapier.authentication.fields-not-literal",
      category: "structure",
      pointer: at("fields"),
      dimension: "configure",
      severity: "warning",
      disposition: "unsupported",
      message:
        "Authentication fields are computed rather than listed, so the connection form could not be imported.",
    });
  for (const [index, field] of fields
    .slice(0, ZAPIER_LIMITS.configuration)
    .entries()) {
    const key = asString(objectValue(field, "key"));
    if (key === undefined) {
      issues.add({
        code: "zapier.authentication.field-not-literal",
        category: "structure",
        pointer: at("fields", index),
        dimension: "configure",
        severity: "warning",
        disposition: "unsupported",
        message:
          "An authentication field has no literal key and was not imported.",
      });
      continue;
    }
    const fieldType = asString(objectValue(field, "type"));
    const noSecret = asBoolean(objectValue(field, "isNoSecret"));
    const computed = asBoolean(objectValue(field, "computed")) === true;
    // AuthFieldSchema defaults `required` to true; only an explicit false opts out.
    const required =
      asBoolean(objectValue(field, "required")) !== false && !computed;
    const classification: ConfigurationRequirement["classification"] =
      noSecret === true && !SENSITIVE_FIELD.test(key)
        ? "public"
        : fieldType === "password" || SENSITIVE_FIELD.test(key)
          ? "secret"
          : "secret";
    const label = asString(objectValue(field, "label"));
    const help = asString(objectValue(field, "helpText"));
    const literalField = toJsonValue(field);
    if (literalField !== undefined) {
      const list = (result.native["fields"] ??= []) as unknown[];
      list.push(inertCopy(literalField));
    }
    result.configuration.push({
      name: configurationName(appKey, key, used),
      source: "session-environment",
      classification,
      required,
      ...(label || help
        ? {
            description: safeText(
              label ? `${label}. ${help ?? ""}` : (help ?? ""),
              500,
            ),
          }
        : {}),
    });
    if (computed)
      result.limitations.push(
        `Authentication field "${token(key)}" is populated by the platform after authorization and cannot be supplied as configuration.`,
      );
  }

  const noteCode = (key: string, dimension: "authorize" | "verify") => {
    const form = functionForm(objectValue(authentication, key));
    if (!form) return;
    issues.add({
      code: "executable-code.function",
      category: "executable-code",
      pointer: at(key),
      dimension,
      severity: "warning",
      disposition: "requires-configuration",
      message: `The authentication "${token(key)}" step is ${FORM_MESSAGE[form]}; it was recorded, not read or run.`,
      remediation:
        "Bind an approved host operation for this step; imported code is never executed.",
    });
  };
  noteCode("test", "verify");
  noteCode("connectionLabel", "verify");

  const unsupported = (native: string, message: string) => {
    result.profiles.push({
      id: "zapier-native",
      label: `Zapier ${safeText(native, 60)} authentication`,
      kind: "unsupported",
      native,
    });
    result.profileIds.push("zapier-native");
    issues.add({
      code: `zapier.authentication.${native.replace(/[^a-z0-9]+/gi, "-").toLowerCase()}`,
      category: "security",
      pointer: at("type"),
      dimension: "authorize",
      severity: "blocking",
      disposition: "unsupported",
      executionImpact: "blocks-authorization",
      message,
      remediation:
        "Authorize this service through a host-owned method or an external runtime binding instead.",
    });
    result.limitations.push(message);
  };

  switch (type) {
    case undefined: {
      issues.add({
        code: "zapier.authentication.type-not-literal",
        category: "security",
        pointer: at("type"),
        dimension: "authorize",
        severity: "blocking",
        disposition: "unsupported",
        executionImpact: "blocks-authorization",
        message:
          "The authentication type is not a literal value, so no authentication method could be determined.",
      });
      break;
    }
    case "basic": {
      result.profiles.push({
        id: "zapier-basic",
        label: "Zapier basic authentication",
        kind: "http-basic",
      });
      result.profileIds.push("zapier-basic");
      break;
    }
    case "oauth2": {
      const config = objectValue(authentication, "oauth2Config");
      const authorize = literalUrl(objectValue(config, "authorizeUrl"));
      const tokenEndpoint = literalUrl(objectValue(config, "getAccessToken"));
      const refresh = objectValue(config, "refreshAccessToken");
      const scopeText = asString(objectValue(config, "scope"));
      const pkceFlag = asBoolean(objectValue(config, "enablePkce"));
      if (authorize === undefined || tokenEndpoint === undefined) {
        unsupported(
          "zapier-oauth2-dynamic",
          "The OAuth 2.0 endpoints are produced by code or by a template rather than declared as literal URLs, so they cannot be approved from this description.",
        );
        for (const key of ["authorizeUrl", "getAccessToken"] as const) {
          const form = functionForm(objectValue(config, key));
          if (form)
            issues.add({
              code: "executable-code.function",
              category: "executable-code",
              pointer: at("oauth2Config", key),
              dimension: "authorize",
              severity: "warning",
              disposition: "requires-configuration",
              message: `The OAuth 2.0 "${token(key)}" endpoint is ${FORM_MESSAGE[form]}; it was recorded, not read or run.`,
            });
        }
        break;
      }
      for (const url of [authorize, tokenEndpoint])
        declaredServers.set(new URL(url).origin, "Declared OAuth 2.0 endpoint");
      result.profiles.push({
        id: "zapier-oauth2",
        label: "Zapier OAuth 2.0",
        kind: "oauth-authorization-code",
        pkce:
          pkceFlag === true ? "S256" : pkceFlag === false ? "none" : "unknown",
        authorizationEndpoint: authorize,
        tokenEndpoint,
        scopes: scopeText
          ? scopeText
              .split(/[\s,]+/)
              .filter(Boolean)
              .slice(0, ZAPIER_LIMITS.scopes)
          : [],
        scopeSemantics: scopeText ? "provider-scopes" : "unknown",
        clientRegistration: "pre-registered",
        clientAuthentication: "unknown",
        refresh: refresh === undefined ? "unknown" : "supported",
      });
      result.profileIds.push("zapier-oauth2");
      result.native["oauth2Config"] = {
        authorizeUrl: authorize,
        getAccessToken: tokenEndpoint,
        ...(scopeText ? { scope: scopeText } : {}),
        ...(pkceFlag === undefined ? {} : { enablePkce: pkceFlag }),
        ...(refresh === undefined ? {} : { hasRefresh: true }),
      };
      if (refresh !== undefined) {
        const form = functionForm(refresh);
        if (form)
          issues.add({
            code: "executable-code.function",
            category: "executable-code",
            pointer: at("oauth2Config", "refreshAccessToken"),
            dimension: "reconnect",
            severity: "info",
            disposition: "requires-configuration",
            message: `Token refresh is ${FORM_MESSAGE[form]}; the host performs refresh itself under its own custody.`,
          });
      }
      break;
    }
    case "custom": {
      unsupported(
        "zapier-custom-auth",
        "Custom authentication places its credential through middleware code, so where the credential belongs in a request cannot be read from this description.",
      );
      break;
    }
    case "session": {
      unsupported(
        "zapier-session-auth",
        "Session authentication exchanges credentials through code, so the exchange cannot be read from this description.",
      );
      break;
    }
    case "digest": {
      unsupported(
        "zapier-digest-auth",
        "HTTP digest authentication is not an authentication method this runtime implements.",
      );
      break;
    }
    case "oauth1": {
      unsupported(
        "zapier-oauth1",
        "OAuth 1.0a request signing is not an authentication method this runtime implements.",
      );
      break;
    }
    default: {
      unsupported(
        `zapier-${
          safeText(type, 40)
            .replace(/[^a-zA-Z0-9]+/g, "-")
            .toLowerCase() || "unknown"
        }`,
        `The authentication type "${token(type, 40)}" is not one this runtime implements.`,
      );
    }
  }
  return result;
}

type OperationSource = {
  collection: string;
  key: string;
  entry: StaticValue;
  kind: NativeCapability["kind"];
  effect: NativeCapability["effect"];
  /** Pointer segments identifying this operation in the source. */
  path: Array<string | number>;
  /** Literal metadata that lives above the operation (a resource's noun). */
  extra?: Record<string, unknown>;
};

const PERFORM_KEYS = [
  "perform",
  "performList",
  "performSubscribe",
  "performUnsubscribe",
  "performGet",
  "performResume",
  "performBuffer",
] as const;

function readFieldList(
  fields: StaticValue | undefined,
  issues: IssueCollector,
  path: Array<string | number>,
  loc: JsLoc,
  file: string | undefined,
  limitations: Set<string>,
): unknown {
  const list = asArray(fields);
  if (!list) {
    if (fields)
      issues.add({
        code: "zapier.field.not-literal",
        category: "schema",
        pointer: locate(pointer(...path), {
          ...loc,
          ...(file ? { file } : {}),
        }),
        dimension: "import",
        severity: "warning",
        disposition: "unsupported",
        message:
          "An input or output field list is produced by code, so the form it describes could not be imported.",
      });
    return undefined;
  }
  const preserved: unknown[] = [];
  for (const [index, field] of list.slice(0, ZAPIER_LIMITS.fields).entries()) {
    const form = functionForm(field);
    if (form) {
      issues.add({
        code: "executable-code.function",
        category: "executable-code",
        pointer: locate(pointer(...path, index), {
          ...field.loc,
          ...(file ? { file } : {}),
        }),
        dimension: "import",
        severity: "warning",
        disposition: "requires-configuration",
        message: `A field entry is ${FORM_MESSAGE[form]}; the fields it would produce are not part of this description.`,
      });
      limitations.add(
        "Some input fields are produced by code at configuration time and are not described here.",
      );
      continue;
    }
    const entries = asObject(field);
    if (!entries) continue;
    const key = asString(objectValue(field, "key"));
    const dynamic = objectValue(field, "dynamic");
    const search = objectValue(field, "search");
    const choices = objectValue(field, "choices");
    if (dynamic !== undefined) {
      issues.add({
        code: "zapier.field.dynamic-dropdown",
        category: "policy",
        pointer: locate(pointer(...path, index, "dynamic"), {
          ...field.loc,
          ...(file ? { file } : {}),
        }),
        dimension: "invoke",
        severity: "warning",
        disposition: "requires-configuration",
        message: `Field "${token(key ?? String(index))}" is filled by a dynamic dropdown that queries the provider; its options are not part of this description.`,
        remediation:
          "Bind an approved host operation if the option list is needed, and apply the host's authorization and classification to it.",
      });
      limitations.add(
        "Dynamic dropdown options require an authorized provider call and are not imported.",
      );
    }
    if (search !== undefined)
      limitations.add(
        "Some fields reference a search step to populate them; that step is not part of this description.",
      );
    if (
      choices !== undefined &&
      functionForm(objectValue(choices, "perform"))
    ) {
      issues.add({
        code: "zapier.field.dynamic-choices",
        category: "policy",
        pointer: locate(pointer(...path, index, "choices"), {
          ...field.loc,
          ...(file ? { file } : {}),
        }),
        dimension: "invoke",
        severity: "warning",
        disposition: "requires-configuration",
        message: `Field "${token(key ?? String(index))}" populates its choices by calling the provider; the option list is not part of this description.`,
      });
      limitations.add(
        "Dynamic dropdown options require an authorized provider call and are not imported.",
      );
    }
    const copied = toJsonValue(field);
    if (copied !== undefined) preserved.push(inertCopy(copied));
    void entries;
  }
  return preserved;
}

function collectOperations(
  app: StaticValue,
  issues: IssueCollector,
  file: string | undefined,
): OperationSource[] {
  const found: OperationSource[] = [];
  const collections: Array<{
    name: string;
    kind: NativeCapability["kind"];
    effect: NativeCapability["effect"];
  }> = [
    { name: "triggers", kind: "event", effect: "read" },
    { name: "searches", kind: "query", effect: "read" },
    { name: "creates", kind: "action", effect: "write" },
    { name: "bulkReads", kind: "query", effect: "read" },
    { name: "searchOrCreates", kind: "action", effect: "write" },
    { name: "searchAndCreates", kind: "action", effect: "write" },
  ];
  for (const collection of collections) {
    const value = objectValue(app, collection.name);
    if (!value) continue;
    const entries = asObject(value);
    if (!entries) {
      issues.add({
        code: "zapier.collection.not-literal",
        category: "structure",
        pointer: locate(pointer(collection.name), {
          ...value.loc,
          ...(file ? { file } : {}),
        }),
        dimension: "import",
        severity: "warning",
        disposition: "unsupported",
        message: `The "${token(collection.name)}" collection is produced by code and was not imported.`,
      });
      continue;
    }
    for (const entry of entries.slice(0, ZAPIER_LIMITS.actions)) {
      if (!entry.key) continue;
      const key = asString(objectValue(entry.value, "key")) ?? entry.key;
      found.push({
        collection: collection.name,
        key,
        entry: entry.value,
        kind: collection.kind,
        effect: collection.effect,
        path: [collection.name, entry.key],
      });
    }
  }
  // Resources generate triggers, searches and creates on the platform side.
  const resources = objectValue(app, "resources");
  const resourceEntries = asObject(resources);
  if (resources && !resourceEntries)
    issues.add({
      code: "zapier.collection.not-literal",
      category: "structure",
      pointer: locate(pointer("resources"), {
        ...resources.loc,
        ...(file ? { file } : {}),
      }),
      dimension: "import",
      severity: "warning",
      disposition: "unsupported",
      message:
        "The resources collection is produced by code and was not imported.",
    });
  const methods: Array<{
    name: string;
    kind: NativeCapability["kind"];
    effect: NativeCapability["effect"];
  }> = [
    { name: "list", kind: "query", effect: "read" },
    { name: "hook", kind: "event", effect: "read" },
    { name: "search", kind: "query", effect: "read" },
    { name: "create", kind: "action", effect: "write" },
    { name: "get", kind: "query", effect: "read" },
  ];
  for (const entry of (resourceEntries ?? []).slice(0, ZAPIER_LIMITS.actions)) {
    if (!entry.key) continue;
    const resourceKey = asString(objectValue(entry.value, "key")) ?? entry.key;
    const resourceNoun = asString(objectValue(entry.value, "noun"));
    for (const method of methods) {
      const value = objectValue(entry.value, method.name);
      if (!value || value.kind !== "object") continue;
      found.push({
        collection: "resources",
        key: `${resourceKey}.${method.name}`,
        entry: value,
        kind: method.kind,
        effect: method.effect,
        path: ["resources", entry.key, method.name],
        ...(resourceNoun === undefined ? {} : { extra: { resourceNoun } }),
      });
    }
  }
  if (resourceEntries?.length)
    issues.add({
      code: "zapier.resource.generated-key",
      category: "identity",
      pointer: pointer("resources"),
      dimension: "import",
      severity: "info",
      disposition: "adapted",
      message:
        "Resource methods are exposed by the platform under keys the definition does not state; this import identifies them by resource and method instead of inventing that spelling.",
    });
  return found;
}

/**
 * Reads an exported Zapier app definition or CLI source text into a
 * normalized description plus the diagnostics that say exactly what was not
 * imported. Nothing from the input is executed on any path.
 */
export async function readZapierApp(
  input: ZapierReadInput,
): Promise<AutomationReadResult> {
  const issues = new IssueCollector(ZAPIER_LIMITS.issues);
  const limitations = new Set<string>();
  const declaredServers = new Map<string, string>();
  const hint = input.identity ?? {};
  const file = input.sourceText === undefined ? undefined : "app.js";

  let app: StaticValue | undefined;
  let profile: string = ZAPIER_PROFILES.json;
  let importDisposition: "exact" | "adapted" = "exact";
  let sourceMaterial: unknown = null;

  if (input.json !== undefined) {
    app = fromJsonValue(input.json);
    sourceMaterial = input.json;
    if (app.kind !== "object") {
      issues.add({
        code: "zapier.app.not-object",
        category: "structure",
        pointer: "#",
        dimension: "import",
        severity: "blocking",
        disposition: "rejected",
        executionImpact: "blocks-definition",
        message: "The exported definition is not a JSON object.",
      });
      app = undefined;
    }
  } else if (input.sourceText !== undefined) {
    profile = ZAPIER_PROFILES.source;
    importDisposition = "adapted";
    sourceMaterial = { sourceLength: input.sourceText.length };
    const parse = parseJsSource(input.sourceText);
    const exported = findExportedValueIndex(parse);
    if (exported === undefined) {
      issues.add({
        code: "zapier.source.no-export",
        category: "structure",
        pointer: "#",
        dimension: "import",
        severity: "blocking",
        disposition: "rejected",
        executionImpact: "blocks-definition",
        message:
          "No exported app definition was found in the source text. Only a literal object assigned to the module's export is read.",
        remediation:
          "Import the exported JSON definition, which the platform produces from this source.",
      });
    } else {
      const read = readValueAt(parse, exported);
      if (read.truncated)
        issues.add({
          code: "zapier.source.truncated",
          category: "structure",
          pointer: "#",
          dimension: "import",
          severity: "warning",
          disposition: "adapted",
          message:
            "The source exceeded the reader's bounds; the description covers only the part that was read.",
        });
      if (read.value.kind === "object") app = read.value;
      else {
        const form = functionForm(read.value);
        issues.add({
          code: "zapier.source.export-not-literal",
          category: "structure",
          pointer: "#",
          dimension: "import",
          severity: "blocking",
          disposition: "rejected",
          executionImpact: "blocks-definition",
          message: `The module's export is ${form ? FORM_MESSAGE[form] : "not a literal object"}, so no metadata could be extracted without running it.`,
          remediation:
            "Import the exported JSON definition, which the platform produces from this source.",
        });
      }
    }
  } else {
    issues.add({
      code: "zapier.input.missing",
      category: "structure",
      pointer: "#",
      dimension: "import",
      severity: "blocking",
      disposition: "rejected",
      executionImpact: "blocks-definition",
      message: "No exported definition and no source text were supplied.",
    });
  }

  const version = app ? asString(objectValue(app, "version")) : undefined;
  const platformVersion = app
    ? asString(objectValue(app, "platformVersion"))
    : undefined;
  if (app && version === undefined)
    issues.add({
      code: "zapier.app.version-not-literal",
      category: "version",
      pointer: pointer("version"),
      dimension: "import",
      severity: "warning",
      disposition: "adapted",
      message:
        "The app version is not a literal value, so the imported description records the version the host supplied instead.",
    });
  if (version !== undefined && !ZAPIER_VERSION.test(version))
    issues.add({
      code: "zapier.app.version-shape",
      category: "version",
      pointer: pointer("version"),
      dimension: "import",
      severity: "info",
      disposition: "adapted",
      message:
        "The app version does not match the platform's version pattern; it is preserved exactly as written.",
    });

  const nativeVersion =
    asNativeId(hint.nativeVersion) ?? asNativeId(version) ?? "unversioned";
  const nativeId = asNativeId(hint.nativeId) ?? "zapier-app";
  if (hint.nativeId === undefined)
    issues.add({
      code: "zapier.app.no-identifier",
      category: "identity",
      pointer: "#",
      dimension: "import",
      severity: "info",
      disposition: "adapted",
      message:
        "A Zapier app definition carries no identifier; the host must supply one for this description to be distinguishable from another app.",
    });

  const appKey = nativeId;
  const auth = app
    ? readAuthentication(
        objectValue(app, "authentication"),
        appKey,
        issues,
        file,
        declaredServers,
      )
    : {
        profiles: [],
        configuration: [],
        limitations: [],
        profileIds: [],
        native: {} as Record<string, unknown>,
      };
  for (const limitation of auth.limitations) limitations.add(limitation);

  const authenticationProfiles: AuthenticationProfile[] = auth.profiles;
  if (app && objectValue(app, "authentication") === undefined) {
    authenticationProfiles.push({
      id: "zapier-none",
      label: "No credential declared",
      kind: "none",
      reason: "public",
    });
    auth.profileIds.push("zapier-none");
  }

  for (const key of [
    "beforeRequest",
    "afterResponse",
    "hydrators",
    "beforeApp",
    "afterApp",
  ] as const) {
    const value = app ? objectValue(app, key) : undefined;
    if (!value) continue;
    issues.add({
      code: "executable-code.function",
      category: "executable-code",
      pointer: locate(pointer(key), {
        ...value.loc,
        ...(file ? { file } : {}),
      }),
      dimension: "invoke",
      severity: "warning",
      disposition: "requires-configuration",
      message: `The app declares "${token(key)}" middleware; it was recorded, not read or run, and it does not apply to any host request.`,
      remediation:
        "Anything this middleware does to a request must be restated as approved host policy.",
    });
    limitations.add(
      "Request and response middleware defined by the app is not applied by this runtime.",
    );
  }
  const requestTemplate = app ? objectValue(app, "requestTemplate") : undefined;
  let literalRequestTemplate: { method?: string; url: string } | undefined;
  if (requestTemplate) {
    const template = literalRequest(requestTemplate);
    if (template) {
      literalRequestTemplate = template;
      declaredServers.set(
        new URL(template.url).origin,
        "Declared request template",
      );
    } else
      issues.add({
        code: "zapier.request-template.not-literal",
        category: "structure",
        pointer: locate(pointer("requestTemplate"), {
          ...requestTemplate.loc,
          ...(file ? { file } : {}),
        }),
        dimension: "invoke",
        severity: "info",
        disposition: "requires-configuration",
        message:
          "The default request template is not a literal request; host policy decides request defaults instead.",
      });
  }

  const capabilities: NativeCapability[] = [];
  const events: EventDescriptor[] = [];
  const executableCandidates: string[] = [];
  const operations = app ? collectOperations(app, issues, file) : [];
  const seen = new Set<string>();
  for (const operation of operations) {
    const id = asNativeId(operation.key);
    if (id === undefined || seen.has(id)) continue;
    seen.add(id);
    if (!ZAPIER_KEY.test(operation.key) && operation.collection !== "resources")
      issues.add({
        code: "zapier.action.key-shape",
        category: "identity",
        pointer: pointer(...operation.path, "key"),
        dimension: "import",
        severity: "info",
        disposition: "adapted",
        message: `The key "${token(operation.key)}" does not match the platform's key pattern; it is preserved exactly as written.`,
      });
    const display = objectValue(operation.entry, "display");
    const label = asString(objectValue(display, "label"));
    const description = asString(objectValue(display, "description"));
    const noun = asString(objectValue(operation.entry, "noun"));
    const hidden = asBoolean(objectValue(display, "hidden")) === true;
    const operationValue = objectValue(operation.entry, "operation");
    const isHook =
      asString(objectValue(operationValue, "type")) === "hook" ||
      (operation.collection === "resources" && operation.path[2] === "hook");
    const extensions: Record<string, unknown> = {
      collection: operation.collection,
      ...(noun ? { noun } : {}),
      ...(hidden ? { hidden: true } : {}),
      ...(operation.extra ?? {}),
    };
    if (operation.collection === "resources") {
      const resourceKey = operation.path[1];
      const method = operation.path[2];
      if (typeof resourceKey === "string")
        extensions["resourceKey"] = resourceKey;
      if (typeof method === "string") extensions["resourceMethod"] = method;
    }
    for (const key of ["search", "create", "update"] as const) {
      const linked = asString(objectValue(operation.entry, key));
      if (linked !== undefined) extensions[`${key}Key`] = linked;
    }

    let performIsLiteral = false;
    for (const performKey of PERFORM_KEYS) {
      const value = objectValue(operationValue, performKey);
      if (!value) continue;
      const request = literalRequest(value);
      if (request) {
        performIsLiteral = true;
        declaredServers.set(
          new URL(request.url).origin,
          "Declared operation endpoint",
        );
        extensions[performKey] = {
          ...(request.method ? { method: request.method } : {}),
          url: request.url,
        };
        continue;
      }
      const form = functionForm(value);
      // One marker for every spelling of "this is code": the exact spelling
      // belongs in the diagnostic, not in a field an export has to reproduce.
      extensions[performKey] = { code: "function" };
      issues.add({
        code: "executable-code.function",
        category: "executable-code",
        pointer: locate(pointer(...operation.path, "operation", performKey), {
          ...value.loc,
          ...(file ? { file } : {}),
        }),
        dimension: "invoke",
        severity: "warning",
        disposition: "requires-configuration",
        message: `"${token(operation.key)}" implements "${token(performKey)}" as ${form ? FORM_MESSAGE[form] : "a value this reader cannot read"}; it was recorded, not read or run.`,
        remediation:
          "Bind this operation to an approved host runtime; imported code is never executed.",
      });
      limitations.add(
        "Operation bodies are code and are not executed by this runtime; invoking one requires an approved external runtime binding.",
      );
    }

    const inputFields = readFieldList(
      objectValue(operationValue, "inputFields"),
      issues,
      [...operation.path, "operation", "inputFields"],
      operation.entry.loc,
      file,
      limitations,
    );
    const outputFields = readFieldList(
      objectValue(operationValue, "outputFields"),
      issues,
      [...operation.path, "operation", "outputFields"],
      operation.entry.loc,
      file,
      limitations,
    );
    if (inputFields !== undefined) extensions["inputFields"] = inputFields;
    if (outputFields !== undefined) extensions["outputFields"] = outputFields;
    const sample = objectValue(operationValue, "sample");
    if (sample?.kind === "object") {
      const copied = toJsonValue(sample);
      if (copied !== undefined) extensions["sample"] = inertCopy(copied);
    }
    const operationType = asString(objectValue(operationValue, "type"));
    if (operationType !== undefined) extensions["type"] = operationType;
    if (performIsLiteral) extensions["performIsLiteralRequest"] = true;

    capabilities.push({
      kind: isHook ? "event" : operation.kind,
      nativeId: id,
      ...(label ? { label: safeText(label, 200) } : {}),
      ...(description ? { summary: safeText(description, 500) } : {}),
      effect: operation.effect,
      dataClassification: "unknown",
      cost: "unknown",
      authentication: [...new Set(auth.profileIds)].slice(0, 16),
      inputSchemaRef: pointer(...operation.path, "operation", "inputFields"),
      outputSchemaRef: pointer(...operation.path, "operation", "outputFields"),
      nativeExtensions: extensions,
    });
    if (isHook)
      events.push({
        nativeId: id,
        ...(label ? { label: safeText(label, 200) } : {}),
        transport: "http-webhook",
        verification: "unknown",
        messageSchemaRef: pointer(...operation.path, "operation", "sample"),
      });
    executableCandidates.push(id);
  }

  if (app && capabilities.length === 0)
    issues.add({
      code: "zapier.app.no-actions",
      category: "structure",
      pointer: "#",
      dimension: "import",
      severity: "info",
      disposition: "adapted",
      message:
        "The definition declares no triggers, searches, creates or resources.",
    });

  const flags = app ? objectValue(app, "flags") : undefined;
  const throttle = app ? objectValue(app, "throttle") : undefined;
  const nativeExtensions: Record<string, unknown> = {
    profile,
    ...(platformVersion ? { platformVersion } : {}),
    ...(version ? { appVersion: version } : {}),
    ...(Object.keys(auth.native).length ? { authentication: auth.native } : {}),
    ...(literalRequestTemplate
      ? { requestTemplate: literalRequestTemplate }
      : {}),
    ...(flags ? { flags: inertCopy(toJsonValue(flags)) } : {}),
    ...(throttle ? { throttle: inertCopy(toJsonValue(throttle)) } : {}),
    limitations: [...limitations].slice(0, 32),
  };

  const definition = await buildAutomationDefinition({
    identity: {
      ecosystem: ZAPIER_ECOSYSTEM,
      authorityNamespace: safeText(hint.authorityNamespace ?? "", 256),
      nativeId,
      nativeVersion,
    },
    importer: ZAPIER_IMPORTER,
    display: {
      name: safeText(hint.displayName ?? nativeId, 200),
      description: safeText(
        hint.description ??
          "Zapier Platform integration imported as a description; its code is not executed here.",
        500,
      ),
      ecosystem: ZAPIER_ECOSYSTEM,
      service: hint.service ? serviceKey(hint.service) : serviceKey(nativeId),
    },
    authentication: authenticationProfiles,
    configuration: auth.configuration,
    capabilities,
    events,
    declaredServers: [...declaredServers.entries()]
      .slice(0, ZAPIER_LIMITS.servers)
      .map(([url, description]) => ({ url, description })),
    issues: issues.issues,
    dimensions: automationCapabilityRows({
      importDisposition,
      hasBlockingIssue: issues.blocksDefinition(),
    }),
    nativeExtensions,
    sourceMaterial,
  });

  return {
    definition,
    issues: issues.issues,
    executableCandidates: issues.blocksDefinition() ? [] : executableCandidates,
  };
}
