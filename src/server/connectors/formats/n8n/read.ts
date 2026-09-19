import type {
  AuthenticationProfile,
  CompatibilityIssue,
  ConfigurationRequirement,
  MappingDisposition,
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
  authenticationDisposition,
  buildAutomationDefinition,
  type AutomationDimensions,
  type AutomationReadResult,
} from "../automation/definition.js";
import {
  asArray,
  asBoolean,
  asNumber,
  asString,
  findClassPropertyIndex,
  findMethodNames,
  fromJsonValue,
  objectValue,
  parseJsSource,
  readValueAt,
  toJsonValue,
  type StaticValue,
} from "../automation/js-literals.js";
import {
  N8N_ECOSYSTEM,
  N8N_IMPORTER,
  N8N_LIMITS,
  N8N_PROFILES,
  N8N_PROGRAMMATIC_METHODS,
  isN8nExpression,
} from "./profile.js";

/*
 * Reads an n8n node into a normalized description.
 *
 * A declarative node describes its requests in data: `requestDefaults` and a
 * `routing.request` on each operation. Those are imported as capability
 * metadata a reviewer can turn into an approved operation. A programmatic
 * node puts the same behaviour in an `execute()` method; that method is
 * recorded and never read as behaviour, and the description says `invoke` is
 * unsupported rather than pretending the node can run here.
 *
 * n8n expressions — any parameter value beginning with `=` — are preserved
 * verbatim as inert text. They are never evaluated, never interpolated and
 * never treated as a URL, and each one that stands where this reader wanted a
 * literal produces a diagnostic saying so.
 */

export type N8nIdentityHint = {
  nativeId?: string;
  nativeVersion?: string;
  authorityNamespace?: string;
  displayName?: string;
  description?: string;
  service?: string;
};

export type N8nReadInput = {
  /** An exported `INodeTypeDescription`, already parsed from JSON. */
  json?: unknown;
  /** Node source text (`*.node.ts`); read by the bounded syntactic extractor. */
  sourceText?: string;
  /** A credential description as JSON, matching the node's `credentials[].name`. */
  credentialsJson?: unknown;
  /** Credential source text (`*.credentials.ts`). */
  credentialsSource?: string;
  /** The package manifest, for the `n8n` block, package name and version. */
  packageJson?: unknown;
  identity?: N8nIdentityHint;
};

type Loc = { line: number; column: number };

const codeMessage: Record<string, string> = {
  function: "a function",
  call: "a function call",
  reference: "a reference to another binding",
  expression: "a computed expression",
  "template-expression": "a template string with a substitution",
  regex: "a regular expression literal",
  spread: "a spread of another value",
  "computed-key": "a computed property key",
  truncated: "a value beyond the reader's bounds",
};

function opaqueReason(value: StaticValue | undefined): string | undefined {
  return value?.kind === "opaque" ? value.reason : undefined;
}

/** A literal https URL, or undefined when the value is an expression or absent. */
function literalUrl(value: StaticValue | undefined): string | undefined {
  const text = asString(value);
  if (text === undefined || isN8nExpression(text)) return undefined;
  if (!/^https:\/\/[^\s]+$/i.test(text) || !URL.canParse(text))
    return undefined;
  const parsed = new URL(text);
  return parsed.username || parsed.password ? undefined : text;
}

const CREDENTIAL_NAME = /^[A-Z][A-Z0-9_]{0,95}$/;

function configurationName(
  nodeName: string,
  property: string,
  used: Set<string>,
): string {
  const clean = (value: string) =>
    value
      .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
      .toUpperCase()
      .replace(/[^A-Z0-9]+/g, "_")
      .replace(/^_+|_+$/g, "");
  const base = `N8N_${clean(nodeName)}_${clean(property)}`
    .replace(/_{2,}/g, "_")
    .slice(0, 96);
  let candidate = CREDENTIAL_NAME.test(base)
    ? base
    : `N8N_${clean(property)}`.slice(0, 96);
  if (!CREDENTIAL_NAME.test(candidate)) candidate = "N8N_CREDENTIAL";
  let counter = 2;
  while (used.has(candidate)) {
    const suffix = `_${counter++}`;
    candidate = `${candidate.slice(0, 96 - suffix.length)}${suffix}`;
  }
  used.add(candidate);
  return candidate;
}

const SENSITIVE =
  /(password|secret|token|key|credential|signature|passphrase|private)/i;

type CredentialRead = {
  profiles: AuthenticationProfile[];
  profileIds: string[];
  configuration: ConfigurationRequirement[];
  native: Record<string, unknown>;
  limitations: string[];
  servers: Array<[string, string]>;
};

/**
 * Reads an n8n credential description. The placement of a credential is data
 * in this format — `authenticate.properties` names `header`, `qs`, `body` or
 * `auth` — so it can be mapped honestly. The value beside it is an expression
 * naming a credential property; the expression is never evaluated, only the
 * placement and the parameter name are used.
 */
function readCredential(
  credential: StaticValue | undefined,
  nodeName: string,
  issues: IssueCollector,
  file: string | undefined,
): CredentialRead {
  const result: CredentialRead = {
    profiles: [],
    profileIds: [],
    configuration: [],
    native: {},
    limitations: [],
    servers: [],
  };
  if (!credential || credential.kind !== "object") return result;
  const at = (...segments: Array<string | number>) =>
    locate(pointer("credentials", ...segments), {
      ...(credential.loc as Loc),
      ...(file ? { file } : {}),
    });
  const name = asString(objectValue(credential, "name"));
  const displayName = asString(objectValue(credential, "displayName"));
  const documentationUrl = asString(
    objectValue(credential, "documentationUrl"),
  );
  if (name !== undefined) result.native["name"] = name;
  if (displayName !== undefined) result.native["displayName"] = displayName;
  if (documentationUrl !== undefined)
    result.native["documentationUrl"] = documentationUrl;

  const used = new Set<string>();
  const properties = asArray(objectValue(credential, "properties")) ?? [];
  const literalProperties: unknown[] = [];
  const defaults = new Map<string, string>();
  for (const [index, property] of properties
    .slice(0, N8N_LIMITS.fields)
    .entries()) {
    const propertyName = asString(objectValue(property, "name"));
    if (propertyName === undefined) {
      issues.add({
        code: "n8n.credential.property-not-literal",
        category: "structure",
        pointer: at("properties", index),
        dimension: "configure",
        severity: "warning",
        disposition: "unsupported",
        message:
          "A credential property has no literal name and was not imported.",
      });
      continue;
    }
    const propertyType = asString(objectValue(property, "type"));
    const defaultValue = asString(objectValue(property, "default"));
    if (defaultValue !== undefined && !isN8nExpression(defaultValue))
      defaults.set(propertyName, defaultValue);
    const label = asString(objectValue(property, "displayName"));
    result.configuration.push({
      name: configurationName(nodeName, propertyName, used),
      source: "session-environment",
      classification:
        propertyType === "password" || SENSITIVE.test(propertyName)
          ? "secret"
          : "secret",
      required: asBoolean(objectValue(property, "required")) !== false,
      ...(label ? { description: safeText(label, 500) } : {}),
    });
    const copied = toJsonValue(property);
    if (copied !== undefined) literalProperties.push(inertCopy(copied));
  }
  if (literalProperties.length) result.native["properties"] = literalProperties;

  const test = objectValue(credential, "test");
  const testBaseUrl = literalUrl(
    objectValue(objectValue(test, "request"), "baseURL"),
  );
  if (testBaseUrl !== undefined) {
    result.servers.push([
      new URL(testBaseUrl).origin,
      "Declared credential test endpoint",
    ]);
    result.native["test"] = {
      baseURL: testBaseUrl,
      ...(asString(objectValue(objectValue(test, "request"), "url")) !==
      undefined
        ? { url: asString(objectValue(objectValue(test, "request"), "url")) }
        : {}),
    };
  }

  // OAuth 2.0 credentials inherit their endpoints from a base credential type.
  // Only literal defaults declared on this credential can be believed.
  const extendsList = asArray(objectValue(credential, "extends"))
    ?.map((item) => asString(item))
    .filter((item): item is string => item !== undefined);
  if (extendsList?.length) result.native["extends"] = extendsList;
  const authUrl = defaults.get("authUrl");
  const tokenUrl = defaults.get("accessTokenUrl");
  const declaresOauth2 =
    extendsList?.some((item) => /oAuth2/i.test(item)) === true;
  if (declaresOauth2 || authUrl !== undefined || tokenUrl !== undefined) {
    if (
      authUrl !== undefined &&
      tokenUrl !== undefined &&
      /^https:\/\//i.test(authUrl) &&
      /^https:\/\//i.test(tokenUrl)
    ) {
      const scope = defaults.get("scope");
      result.profiles.push({
        id: "n8n-oauth2",
        label: safeText(displayName ?? "n8n OAuth 2.0", 100),
        kind: "oauth-authorization-code",
        pkce: "unknown",
        authorizationEndpoint: authUrl,
        tokenEndpoint: tokenUrl,
        scopes: scope
          ? scope
              .split(/[\s,]+/)
              .filter(Boolean)
              .slice(0, 64)
          : [],
        scopeSemantics: scope ? "provider-scopes" : "unknown",
        clientRegistration: "pre-registered",
        clientAuthentication: "unknown",
        refresh: "unknown",
      });
      result.profileIds.push("n8n-oauth2");
      for (const url of [authUrl, tokenUrl])
        result.servers.push([
          new URL(url).origin,
          "Declared OAuth 2.0 endpoint",
        ]);
      return result;
    }
    result.profiles.push({
      id: "n8n-native",
      label: "n8n inherited OAuth 2.0",
      kind: "unsupported",
      native: "n8n-oauth2-inherited",
    });
    result.profileIds.push("n8n-native");
    issues.add({
      code: "n8n.credential.oauth2-inherited",
      category: "security",
      pointer: at("extends"),
      dimension: "authorize",
      severity: "blocking",
      disposition: "unsupported",
      executionImpact: "blocks-authorization",
      message:
        "The credential inherits its OAuth 2.0 endpoints from a base credential type that is not part of this import, so no authorization server can be approved from this description.",
      remediation:
        "Supply the authorization and token endpoints explicitly before approving a binding.",
    });
    result.limitations.push(
      "OAuth 2.0 endpoints are inherited from an n8n base credential and are not part of this description.",
    );
    return result;
  }

  const authenticate = objectValue(credential, "authenticate");
  if (!authenticate) {
    if (properties.length)
      issues.add({
        code: "n8n.credential.no-authenticate",
        category: "security",
        pointer: at("authenticate"),
        dimension: "authorize",
        severity: "blocking",
        disposition: "unsupported",
        executionImpact: "blocks-authorization",
        message:
          "The credential does not declare how it is applied to a request, so no authentication method could be read from it.",
        remediation:
          "Declare the placement explicitly before approving a binding that uses this credential.",
      });
    return result;
  }
  const reason = opaqueReason(authenticate);
  if (reason) {
    issues.add({
      code: "executable-code.function",
      category: "executable-code",
      pointer: at("authenticate"),
      dimension: "authorize",
      severity: "blocking",
      disposition: "unsupported",
      executionImpact: "blocks-authorization",
      message: `The credential applies itself through ${codeMessage[reason] ?? "code"}; it was recorded, not read or run.`,
    });
    result.profiles.push({
      id: "n8n-native",
      label: "n8n credential code",
      kind: "unsupported",
      native: "n8n-credential-code",
    });
    result.profileIds.push("n8n-native");
    return result;
  }
  const type = asString(objectValue(authenticate, "type"));
  const placementProperties = objectValue(authenticate, "properties");
  result.native["authenticate"] = {
    ...(type === undefined ? {} : { type }),
    ...(toJsonValue(placementProperties) === undefined
      ? {}
      : { properties: inertCopy(toJsonValue(placementProperties)) }),
  };
  const auth = objectValue(placementProperties, "auth");
  const header = objectValue(placementProperties, "header");
  const query = objectValue(placementProperties, "qs");
  const body = objectValue(placementProperties, "body");
  const label = safeText(displayName ?? name ?? "n8n credential", 100);
  if (auth?.kind === "object") {
    result.profiles.push({ id: "n8n-basic", label, kind: "http-basic" });
    result.profileIds.push("n8n-basic");
    return result;
  }
  const firstEntry = (value: StaticValue | undefined) =>
    value?.kind === "object"
      ? value.entries.find((entry) => entry.key)
      : undefined;
  const headerEntry = firstEntry(header);
  if (headerEntry) {
    const headerValue = asString(headerEntry.value) ?? "";
    if (
      headerEntry.key.toLowerCase() === "authorization" &&
      /^=?\s*bearer\s/i.test(headerValue)
    ) {
      result.profiles.push({ id: "n8n-bearer", label, kind: "http-bearer" });
      result.profileIds.push("n8n-bearer");
      return result;
    }
    result.profiles.push({
      id: "n8n-api-key",
      label,
      kind: "api-key",
      placement: "header",
      parameterName: headerEntry.key.slice(0, 120),
    });
    result.profileIds.push("n8n-api-key");
    return result;
  }
  const queryEntry = firstEntry(query);
  if (queryEntry) {
    result.profiles.push({
      id: "n8n-api-key",
      label,
      kind: "api-key",
      placement: "query",
      parameterName: queryEntry.key.slice(0, 120),
    });
    result.profileIds.push("n8n-api-key");
    return result;
  }
  if (body) {
    result.profiles.push({
      id: "n8n-native",
      label,
      kind: "unsupported",
      native: "n8n-body-credential",
    });
    result.profileIds.push("n8n-native");
    issues.add({
      code: "n8n.credential.body-placement",
      category: "security",
      pointer: at("authenticate", "properties", "body"),
      dimension: "authorize",
      severity: "blocking",
      disposition: "unsupported",
      executionImpact: "blocks-authorization",
      message:
        "The credential is placed in the request body, which is not an authentication placement this runtime implements.",
    });
    result.limitations.push(
      "Credentials placed in a request body are not supported by this runtime.",
    );
  }
  return result;
}

type OperationCandidate = {
  nativeId: string;
  resource?: string;
  operation: string;
  label?: string;
  summary?: string;
  action?: string;
  routing?: { method?: string; url?: string; urlIsExpression?: boolean };
  path: Array<string | number>;
};

const isSelector = (name: string | undefined) =>
  name === "resource" || name === "operation";

function showList(
  property: StaticValue | undefined,
  key: string,
): string[] | undefined {
  const show = objectValue(objectValue(property, "displayOptions"), "show");
  const list = asArray(objectValue(show, key));
  if (!list) return undefined;
  const values = list
    .map((item) => asString(item))
    .filter((item): item is string => item !== undefined);
  return values.length ? values : undefined;
}

/**
 * Reads a declarative node description, a programmatic one, or the JSON
 * export of either, into a normalized description with the diagnostics that
 * say exactly what was not imported. Nothing is executed on any path.
 */
export async function readN8nNode(
  input: N8nReadInput,
): Promise<AutomationReadResult> {
  const issues = new IssueCollector(N8N_LIMITS.issues);
  const limitations = new Set<string>();
  const declaredServers = new Map<string, string>();
  const hint = input.identity ?? {};
  const file = input.sourceText === undefined ? undefined : "node.ts";

  let description: StaticValue | undefined;
  let profile: string = N8N_PROFILES.json;
  let importDisposition: MappingDisposition = "exact";
  let sourceMaterial: unknown = null;
  let programmaticMethods: string[] = [];

  if (input.json !== undefined) {
    const value = fromJsonValue(input.json);
    sourceMaterial = input.json;
    if (value.kind === "object") description = value;
    else
      issues.add({
        code: "n8n.node.not-object",
        category: "structure",
        pointer: "#",
        dimension: "import",
        severity: "blocking",
        disposition: "rejected",
        executionImpact: "blocks-definition",
        message: "The exported node description is not a JSON object.",
      });
  } else if (input.sourceText !== undefined) {
    profile = N8N_PROFILES.source;
    importDisposition = "adapted";
    sourceMaterial = { sourceLength: input.sourceText.length };
    const parse = parseJsSource(input.sourceText);
    const methods = findMethodNames(parse);
    programmaticMethods = N8N_PROGRAMMATIC_METHODS.filter((name) =>
      methods.has(name),
    );
    const index = findClassPropertyIndex(parse, "description");
    if (index === undefined)
      issues.add({
        code: "n8n.source.no-description",
        category: "structure",
        pointer: "#",
        dimension: "import",
        severity: "blocking",
        disposition: "rejected",
        executionImpact: "blocks-definition",
        message:
          "No node description was found in the source text. Only a literal object assigned to the class's description property is read.",
        remediation:
          "Import the node description as JSON, or supply source in which the description is a literal object.",
      });
    else {
      const read = readValueAt(parse, index);
      if (read.truncated)
        issues.add({
          code: "n8n.source.truncated",
          category: "structure",
          pointer: "#",
          dimension: "import",
          severity: "warning",
          disposition: "adapted",
          message:
            "The source exceeded the reader's bounds; the description covers only the part that was read.",
        });
      if (read.value.kind === "object") description = read.value;
      else
        issues.add({
          code: "n8n.source.description-not-literal",
          category: "structure",
          pointer: "#",
          dimension: "import",
          severity: "blocking",
          disposition: "rejected",
          executionImpact: "blocks-definition",
          message:
            "The node's description is built by code rather than declared as a literal object, so no metadata could be extracted without running it.",
        });
    }
  } else {
    issues.add({
      code: "n8n.input.missing",
      category: "structure",
      pointer: "#",
      dimension: "import",
      severity: "blocking",
      disposition: "rejected",
      executionImpact: "blocks-definition",
      message: "No node description and no source text were supplied.",
    });
  }

  const name = description
    ? asString(objectValue(description, "name"))
    : undefined;
  const displayName = description
    ? asString(objectValue(description, "displayName"))
    : undefined;
  const summary = description
    ? asString(objectValue(description, "description"))
    : undefined;
  const nativeId = asNativeId(hint.nativeId) ?? asNativeId(name) ?? "n8n-node";
  if (name === undefined && description)
    issues.add({
      code: "n8n.node.name-not-literal",
      category: "identity",
      pointer: pointer("name"),
      dimension: "import",
      severity: "warning",
      disposition: "adapted",
      message:
        "The node's internal name is not a literal value; the description records the identifier the host supplied instead.",
    });

  // `version` is a number or an array of numbers; `defaultVersion` names the
  // one a new workflow gets. Both are preserved, and the identity carries the
  // node version, not a version of this importer.
  const versionValue = description
    ? objectValue(description, "version")
    : undefined;
  const versionList = asArray(versionValue)
    ?.map((item) => asNumber(item))
    .filter((item): item is number => item !== undefined)
    .slice(0, N8N_LIMITS.versions);
  const singleVersion = asNumber(versionValue);
  const defaultVersion = description
    ? asNumber(objectValue(description, "defaultVersion"))
    : undefined;
  const resolvedVersion =
    defaultVersion ??
    (versionList?.length ? versionList[versionList.length - 1] : undefined) ??
    singleVersion;
  const nativeVersion =
    asNativeId(hint.nativeVersion) ??
    (resolvedVersion === undefined ? undefined : String(resolvedVersion)) ??
    "unversioned";
  if (resolvedVersion === undefined && description)
    issues.add({
      code: "n8n.node.version-unknown",
      category: "version",
      pointer: pointer("version"),
      dimension: "import",
      severity: "warning",
      disposition: "adapted",
      message:
        "The node declares no literal version, so a workflow cannot be pinned to the version this description was read from.",
    });

  const credentialValue =
    input.credentialsJson !== undefined
      ? fromJsonValue(input.credentialsJson)
      : input.credentialsSource !== undefined
        ? (() => {
            const parse = parseJsSource(input.credentialsSource!);
            const parts: Array<[string, StaticValue]> = [];
            for (const key of [
              "name",
              "displayName",
              "documentationUrl",
              "properties",
              "authenticate",
              "test",
              "extends",
            ]) {
              const index = findClassPropertyIndex(parse, key);
              if (index === undefined) continue;
              parts.push([key, readValueAt(parse, index).value]);
            }
            return parts.length
              ? ({
                  kind: "object",
                  entries: parts.map(([key, value]) => ({
                    key,
                    quoted: false,
                    value,
                    loc: value.loc,
                  })),
                  loc: { line: 1, column: 1 },
                } satisfies StaticValue)
              : undefined;
          })()
        : undefined;
  const credential = readCredential(
    credentialValue,
    nativeId,
    issues,
    input.credentialsSource === undefined ? undefined : "credentials.ts",
  );
  for (const limitation of credential.limitations) limitations.add(limitation);
  for (const [origin, note] of credential.servers)
    declaredServers.set(origin, note);

  const declaredCredentials = asArray(
    description ? objectValue(description, "credentials") : undefined,
  );
  const credentialNames: Array<{ name: string; required: boolean }> = [];
  for (const entry of (declaredCredentials ?? []).slice(
    0,
    N8N_LIMITS.credentials,
  )) {
    const credentialName = asString(objectValue(entry, "name"));
    if (credentialName === undefined) continue;
    credentialNames.push({
      name: credentialName,
      required: asBoolean(objectValue(entry, "required")) === true,
    });
  }
  if (credentialNames.length && credential.profiles.length === 0) {
    issues.add({
      code: "n8n.credential.not-supplied",
      category: "security",
      pointer: pointer("credentials"),
      dimension: "authorize",
      severity: "warning",
      disposition: "requires-configuration",
      executionImpact: "blocks-authorization",
      message: `The node requires the credential type "${token(credentialNames[0]!.name)}", whose description was not part of this import.`,
      remediation:
        "Import the credential description alongside the node to establish how it authenticates.",
    });
    limitations.add(
      "The node names a credential type whose description was not imported.",
    );
  }
  if (credentialNames.length === 0 && credential.profiles.length === 0)
    credential.profiles.push({
      id: "n8n-none",
      label: "No credential declared",
      kind: "none",
      reason: "public",
    });
  if (credentialNames.length === 0 && credential.profileIds.length === 0)
    credential.profileIds.push("n8n-none");

  const requestDefaults = description
    ? objectValue(description, "requestDefaults")
    : undefined;
  const baseUrlText = asString(objectValue(requestDefaults, "baseURL"));
  const baseUrl = literalUrl(objectValue(requestDefaults, "baseURL"));
  if (baseUrl !== undefined)
    declaredServers.set(new URL(baseUrl).origin, "Declared request base URL");
  else if (baseUrlText !== undefined && isN8nExpression(baseUrlText)) {
    issues.add({
      code: "n8n.routing.expression",
      category: "network",
      pointer: pointer("requestDefaults", "baseURL"),
      dimension: "invoke",
      severity: "warning",
      disposition: "requires-configuration",
      message:
        "The request base URL is an expression evaluated per execution; it was preserved as text and never evaluated, so no destination can be approved from it.",
      remediation:
        "Approve an exact destination origin in the binding instead of deriving one from an expression.",
    });
    limitations.add(
      "The node's base URL is an expression; an approved destination must be named explicitly.",
    );
  }

  const properties = asArray(
    description ? objectValue(description, "properties") : undefined,
  );
  if (description && properties === undefined)
    issues.add({
      code: "n8n.properties.not-literal",
      category: "structure",
      pointer: pointer("properties"),
      dimension: "import",
      severity: "warning",
      disposition: "unsupported",
      message:
        "The node's properties are produced by code, so its operations and fields could not be imported.",
    });

  const candidates: OperationCandidate[] = [];
  const propertyList = (properties ?? []).slice(0, N8N_LIMITS.properties);
  for (const [propertyIndex, property] of propertyList.entries()) {
    const propertyName = asString(objectValue(property, "name"));
    if (propertyName !== "operation") continue;
    const options = asArray(objectValue(property, "options"));
    if (!options) {
      issues.add({
        code: "n8n.operation.options-not-literal",
        category: "structure",
        pointer: pointer("properties", propertyIndex, "options"),
        dimension: "import",
        severity: "warning",
        disposition: "unsupported",
        message:
          "An operation selector lists its options through code, so those operations were not imported.",
      });
      continue;
    }
    const resources = showList(property, "resource") ?? [undefined];
    for (const [optionIndex, option] of options
      .slice(0, N8N_LIMITS.options)
      .entries()) {
      const value = asString(objectValue(option, "value"));
      if (value === undefined) continue;
      const routing = objectValue(objectValue(option, "routing"), "request");
      const method = asString(objectValue(routing, "method"));
      const urlText = asString(objectValue(routing, "url"));
      const routingReason = opaqueReason(objectValue(option, "routing"));
      if (routingReason)
        issues.add({
          code: "executable-code.function",
          category: "executable-code",
          pointer: locate(
            pointer(
              "properties",
              propertyIndex,
              "options",
              optionIndex,
              "routing",
            ),
            { ...(option.loc as Loc), ...(file ? { file } : {}) },
          ),
          dimension: "invoke",
          severity: "warning",
          disposition: "requires-configuration",
          message: `The routing for operation "${token(value)}" is ${codeMessage[routingReason] ?? "code"}; it was recorded, not read or run.`,
        });
      if (urlText !== undefined && isN8nExpression(urlText))
        issues.add({
          code: "n8n.routing.expression",
          category: "network",
          pointer: pointer(
            "properties",
            propertyIndex,
            "options",
            optionIndex,
            "routing",
            "request",
            "url",
          ),
          dimension: "invoke",
          severity: "warning",
          disposition: "requires-configuration",
          message: `Operation "${token(value)}" builds its path from an expression; the expression was preserved as text and never evaluated.`,
          remediation:
            "Approve an exact path template in the binding instead of deriving one from an expression.",
        });
      for (const resource of resources) {
        const composed =
          resource === undefined ? value : `${resource}.${value}`;
        const id = asNativeId(composed);
        if (id === undefined) continue;
        candidates.push({
          nativeId: id,
          ...(resource === undefined ? {} : { resource }),
          operation: value,
          ...(asString(objectValue(option, "name")) === undefined
            ? {}
            : { label: asString(objectValue(option, "name"))! }),
          ...(asString(objectValue(option, "description")) === undefined
            ? {}
            : { summary: asString(objectValue(option, "description"))! }),
          ...(asString(objectValue(option, "action")) === undefined
            ? {}
            : { action: asString(objectValue(option, "action"))! }),
          ...(method === undefined && urlText === undefined
            ? {}
            : {
                routing: {
                  ...(method === undefined ? {} : { method }),
                  ...(urlText === undefined ? {} : { url: urlText }),
                  ...(urlText !== undefined && isN8nExpression(urlText)
                    ? { urlIsExpression: true }
                    : {}),
                },
              }),
          path: ["properties", propertyIndex, "options", optionIndex],
        });
      }
    }
  }

  const isProgrammatic = programmaticMethods.length > 0;
  if (isProgrammatic) {
    for (const method of programmaticMethods)
      issues.add({
        code: "executable-code.function",
        category: "executable-code",
        pointer: locate(pointer("class", method), {
          line: 0,
          column: 0,
          ...(file ? { file } : {}),
        }),
        dimension: "invoke",
        severity: "warning",
        disposition: "unsupported",
        message: `The node implements "${token(method)}" in code; it was recorded, not read or run.`,
        remediation:
          "A programmatic node requires an n8n host runtime; bind an approved external runtime to invoke it.",
      });
    limitations.add("programmatic node requires host runtime");
  }

  const capabilities: NativeCapability[] = [];
  const executableCandidates: string[] = [];
  const seen = new Set<string>();
  for (const candidate of candidates) {
    if (seen.has(candidate.nativeId)) continue;
    seen.add(candidate.nativeId);
    const fields: unknown[] = [];
    for (const [propertyIndex, property] of propertyList.entries()) {
      const propertyName = asString(objectValue(property, "name"));
      if (propertyName === undefined || isSelector(propertyName)) continue;
      const resourceShow = showList(property, "resource");
      const operationShow = showList(property, "operation");
      if (
        resourceShow &&
        (candidate.resource === undefined ||
          !resourceShow.includes(candidate.resource))
      )
        continue;
      if (operationShow && !operationShow.includes(candidate.operation))
        continue;
      const copied = toJsonValue(property);
      if (copied !== undefined) fields.push(inertCopy(copied));
      else
        issues.add({
          code: "executable-code.function",
          category: "executable-code",
          pointer: pointer("properties", propertyIndex),
          dimension: "import",
          severity: "warning",
          disposition: "requires-configuration",
          message:
            "A node parameter is produced by code and is not part of this description.",
        });
    }
    const extensions: Record<string, unknown> = {
      operation: candidate.operation,
      ...(candidate.resource === undefined
        ? {}
        : { resource: candidate.resource }),
      ...(candidate.action === undefined ? {} : { action: candidate.action }),
      ...(candidate.routing === undefined
        ? {}
        : { routing: candidate.routing }),
      implementation: isProgrammatic ? "programmatic" : "declarative",
      ...(fields.length ? { parameters: fields } : {}),
    };
    capabilities.push({
      kind: "action",
      nativeId: candidate.nativeId,
      ...(candidate.label ? { label: safeText(candidate.label, 200) } : {}),
      ...(candidate.summary
        ? { summary: safeText(candidate.summary, 500) }
        : {}),
      // n8n does not declare whether an operation reads or writes, and an HTTP
      // method is not that declaration. Host policy classifies the effect.
      effect: "unknown",
      dataClassification: "unknown",
      cost: "unknown",
      authentication: [...new Set(credential.profileIds)].slice(0, 16),
      inputSchemaRef: pointer(...candidate.path, "parameters"),
      nativeExtensions: extensions,
    });
    if (!isProgrammatic && candidate.routing?.url !== undefined)
      executableCandidates.push(candidate.nativeId);
  }
  if (capabilities.length)
    issues.add({
      code: "n8n.operation.effect-undeclared",
      category: "policy",
      pointer: pointer("properties"),
      dimension: "invoke",
      severity: "info",
      disposition: "requires-configuration",
      message:
        "An n8n node does not declare whether an operation reads or writes; every imported operation records an unknown effect until host policy classifies it.",
    });

  const packageValue =
    input.packageJson === undefined
      ? undefined
      : fromJsonValue(input.packageJson);
  const n8nBlock = objectValue(packageValue, "n8n");
  const nativeExtensions: Record<string, unknown> = {
    profile,
    implementation: isProgrammatic ? "programmatic" : "declarative",
    ...(programmaticMethods.length
      ? { programmaticMethods: [...programmaticMethods] }
      : {}),
    ...(versionList?.length
      ? { nodeVersions: versionList }
      : singleVersion === undefined
        ? {}
        : { nodeVersions: [singleVersion] }),
    ...(defaultVersion === undefined ? {} : { defaultVersion }),
    ...(credentialNames.length ? { credentials: credentialNames } : {}),
    ...(Object.keys(credential.native).length
      ? { credentialType: credential.native }
      : {}),
    ...(baseUrl === undefined
      ? baseUrlText === undefined
        ? {}
        : { requestDefaults: { baseURL: baseUrlText } }
      : { requestDefaults: { baseURL: baseUrl } }),
    ...(properties === undefined
      ? {}
      : {
          properties: inertCopy(
            toJsonValue(objectValue(description!, "properties")),
          ),
        }),
    ...(description && objectValue(description, "group")
      ? {
          // Null rather than undefined: a group built by code cannot convert,
          // and an undefined here fails the schema and loses the description
          // instead of reporting the one field that could not be read.
          group:
            inertCopy(toJsonValue(objectValue(description, "group"))) ?? null,
        }
      : {}),
    ...(description &&
    asString(objectValue(description, "subtitle")) !== undefined
      ? { subtitle: asString(objectValue(description, "subtitle")) }
      : {}),
    ...(description &&
    asBoolean(objectValue(description, "usableAsTool")) !== undefined
      ? { usableAsTool: asBoolean(objectValue(description, "usableAsTool")) }
      : {}),
    ...(asString(objectValue(packageValue, "name")) === undefined
      ? {}
      : { packageName: asString(objectValue(packageValue, "name")) }),
    ...(asString(objectValue(packageValue, "version")) === undefined
      ? {}
      : { packageVersion: asString(objectValue(packageValue, "version")) }),
    ...(asNumber(objectValue(n8nBlock, "n8nNodesApiVersion")) === undefined
      ? {}
      : {
          n8nNodesApiVersion: asNumber(
            objectValue(n8nBlock, "n8nNodesApiVersion"),
          ),
        }),
    limitations: [...limitations].slice(0, 32),
  };

  const dimensions: AutomationDimensions = {
    import: issues.blocksDefinition() ? "unsupported" : importDisposition,
    configure: "adapted",
    authorize: authenticationDisposition(credential.profiles),
    invoke: isProgrammatic ? "unsupported" : "requires-configuration",
    export: "adapted",
    delegate: "requires-configuration",
  };

  const definition = await buildAutomationDefinition({
    identity: {
      ecosystem: N8N_ECOSYSTEM,
      authorityNamespace: safeText(
        hint.authorityNamespace ??
          asString(objectValue(packageValue, "name")) ??
          "",
        256,
      ),
      nativeId,
      nativeVersion,
    },
    importer: N8N_IMPORTER,
    display: {
      name: safeText(hint.displayName ?? displayName ?? nativeId, 200),
      description: safeText(
        hint.description ??
          summary ??
          "n8n node imported as a description; its code is not executed here.",
        500,
      ),
      ecosystem: N8N_ECOSYSTEM,
      service: hint.service ? serviceKey(hint.service) : serviceKey(nativeId),
    },
    authentication: credential.profiles,
    configuration: credential.configuration,
    capabilities,
    events: [],
    declaredServers: [...declaredServers.entries()]
      .slice(0, N8N_LIMITS.servers)
      .map(([url, note]) => ({ url, description: note })),
    issues: issues.issues,
    dimensions,
    nativeExtensions,
    sourceMaterial,
  });

  const result: AutomationReadResult = {
    definition,
    issues: issues.issues,
    executableCandidates: issues.blocksDefinition() ? [] : executableCandidates,
  };
  return result;
}

export type { CompatibilityIssue };
