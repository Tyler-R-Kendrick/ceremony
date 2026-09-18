import {
  EXTENSION_LIMITS,
  completeDimensions,
  measureJsonValue,
  normalizedDefinitionSchema,
  normalizedDigestOf,
  type AuthenticationProfile,
  type CompatibilityIssue,
  type ConfigurationRequirement,
  type ConnectorSourceIdentity,
  type EventDescriptor,
  type MappingDisposition,
  type NativeCapability,
  type NormalizedDefinition,
  type SupportDimension,
} from "../../../../core/connectors/index.js";
import { identifierSchema } from "../../../../core/operation-contracts.js";
import type { BoundOperation } from "../../binding.js";
import {
  readApiProperties,
  readConnectorSettings,
  type ApiProperties,
  type ConnectionParameter,
  type ConnectorSettings,
} from "./api-properties.js";
import {
  dynamicOperationRef,
  extractDynamicFields,
  type DynamicFieldContract,
  type DynamicParameterBinding,
} from "./dynamic.js";
import { IssueList, safeText, token } from "./issues.js";
import {
  walkSwagger,
  type SwaggerWalk,
  type WalkedOperation,
  type WalkedParameter,
} from "./swagger-walk.js";

/*
 * Import of a Power Platform custom connector: `apiDefinition.swagger.json`
 * plus the companion `apiProperties.json` and `settings.json` the `paconn`
 * CLI writes beside it. The result is a description — a NormalizedDefinition
 * and diagnostics — plus candidates a reviewer may later bind: dynamic-field
 * contracts, their operations as BoundOperations, and a test-connection
 * verifier. None of that is approved by importing it.
 *
 * What this reader deliberately does not do: run a policy template, compile or
 * execute `script.csx`, reach an on-premises gateway, fetch a remote `$ref`,
 * or infer an effect from an HTTP method. Each of those becomes an explicit
 * diagnostic against the capabilities it affects, so the metadata survives and
 * the execution does not.
 */

export const MICROSOFT_ECOSYSTEM = "microsoft-custom-connector";
export const MICROSOFT_IMPORTER = Object.freeze({
  id: "microsoft-custom-connector-reader",
  version: "1.0.0",
});
/** Documentation profile this reader was written against; see the ledger's sourceProfileIds. */
export const MICROSOFT_PROFILE = "microsoft-custom-connector-2026-06";

export interface CustomConnectorInput {
  /** Parsed `apiDefinition.swagger.json`. Parsing and byte bounds belong to the caller. */
  swagger: unknown;
  /** Parsed `apiProperties.json`; absent yields an actionable incomplete-configuration issue. */
  apiProperties?: unknown;
  /** Parsed `settings.json` (the CLI argument store). */
  settings?: unknown;
  /** Whether a `script.csx` accompanied the connector, when settings.json does not say. */
  scriptPresent?: boolean;
  identity?: Partial<ConnectorSourceIdentity>;
  definitionRef?: string;
  sourceRef?: string;
}

/** A test-connection operation a host may promote to a verifier; review is required. */
export interface VerifierCandidate {
  operationId: string;
  operationRef: string;
  sourcePointer: string;
  parameters: DynamicParameterBinding[];
  /** The named operation exists exactly once and is not itself execution-blocked. */
  resolved: boolean;
  /** What a successful call could establish, and what it could not. */
  limitations: string[];
  requiresHostReview: true;
}

/** What `testConnection` may ever claim: connectivity, never an account or a permission. */
export const TEST_CONNECTION_LIMITATIONS: readonly string[] = Object.freeze([
  "testConnection demonstrates connectivity only",
  "account identity not established",
]);

export interface CustomConnectorReadResult {
  definition: NormalizedDefinition;
  issues: CompatibilityIssue[];
  /** Dynamic field contracts for the UX, in document order. */
  dynamicFields: DynamicFieldContract[];
  /** Bound-operation candidates for the dynamic operations; a reviewer approves them, importing does not. */
  dynamicOperations: BoundOperation[];
  verifierCandidate?: VerifierCandidate;
  /** The test-connection operation as a bound-operation candidate, when one resolved. */
  verifierOperation?: BoundOperation;
  /** Native ids a reviewer may bind: operations with no blocking diagnostic. */
  executableCandidates: string[];
  /** Native id to the codes blocking it, for the review screen. */
  blocked: Record<string, string[]>;
  /** Native connection-parameter name to the host configuration name it maps to. */
  configurationNames: Record<string, string>;
  apiProperties?: ApiProperties;
  settings: ConnectorSettings;
}

type ExtensionEntry = { pointer: string; name: string; value: unknown };

const ENTRY_LIMITS = Object.freeze({
  depth: 10,
  nodes: 512,
  bytes: 16 * 1024,
  stringLength: 4096,
});

/**
 * Packs preserved extensions into a block that fits the definition's inert
 * extension bounds. Over-large values become markers that keep the pointer,
 * so a reviewer still learns the extension was there.
 */
function packExtensions<T extends ExtensionEntry>(
  entries: readonly T[],
  budget: { depth: number; nodes: number; bytes: number; stringLength: number },
  onTruncate?: (count: number) => void,
): T[] {
  const packed: T[] = [];
  let omitted = 0;
  for (const entry of entries) {
    const measured = measureJsonValue(entry.value, ENTRY_LIMITS);
    const candidate: T = measured.ok
      ? entry
      : { ...entry, value: { $omitted: measured.reason } };
    const next = [...packed, candidate];
    if (!measureJsonValue(next, budget).ok) {
      omitted = entries.length - packed.length;
      break;
    }
    packed.push(candidate);
  }
  if (omitted && onTruncate) onTruncate(omitted);
  return packed;
}

/** `#/paths/~1repos/post` describes an operation; its Path Item is one segment up. */
function pathItemPointerOf(operation: WalkedOperation): string {
  const cut = operation.pointer.lastIndexOf("/");
  return cut > 0 ? operation.pointer.slice(0, cut) : operation.pointer;
}

function extensionEntries(
  source: Record<string, unknown>,
  pointer: string,
): ExtensionEntry[] {
  return Object.entries(source).map(([name, value]) => ({
    pointer,
    name,
    value,
  }));
}

/**
 * Shrinks an inert extension block until it fits the definition's bounds by
 * dropping whole groups in the given order. A description that cannot carry
 * everything says so rather than failing to parse.
 */
function fitBlock(
  block: Record<string, unknown>,
  dropOrder: readonly string[],
  onDrop: (key: string) => void,
): Record<string, unknown> {
  const fitted = { ...block };
  for (const key of ["", ...dropOrder]) {
    if (key) {
      if (!Object.hasOwn(fitted, key)) continue;
      delete fitted[key];
      onDrop(key);
    }
    if (
      measureJsonValue(fitted, EXTENSION_LIMITS).ok &&
      Object.keys(fitted).length <= EXTENSION_LIMITS.keys
    )
      return fitted;
  }
  return fitted;
}

/** Every x-ms-* extension in the document, with the pointer it was read from. */
function collectDocumentExtensions(walk: SwaggerWalk): ExtensionEntry[] {
  const entries: ExtensionEntry[] = extensionEntries(walk.extensions, "#");
  for (const scheme of Object.values(walk.securityDefinitions))
    entries.push(...extensionEntries(scheme.extensions, scheme.pointer));
  for (const operation of walk.operations) {
    entries.push(
      ...extensionEntries(operation.pathItemExtensions, operation.pointer),
    );
    entries.push(...extensionEntries(operation.extensions, operation.pointer));
    for (const parameter of operation.parameters) {
      entries.push(
        ...extensionEntries(parameter.extensions, parameter.pointer),
      );
      for (const node of parameter.nested)
        entries.push(...extensionEntries(node.extensions, node.pointer));
    }
    for (const response of operation.responses) {
      entries.push(...extensionEntries(response.extensions, response.pointer));
      for (const node of response.nested)
        entries.push(...extensionEntries(node.extensions, node.pointer));
    }
  }
  return entries;
}

const CONFIG_NAME = /^[A-Z][A-Z0-9_]{0,95}$/;

/** A deterministic uppercase configuration name; the native spelling is preserved separately. */
export function configurationNameFor(
  nativeName: string,
  taken: ReadonlySet<string>,
  suffix = "",
): string {
  const room = 96 - suffix.length;
  const upper = nativeName
    .toUpperCase()
    .replace(/[^A-Z0-9_]/g, "_")
    .slice(0, Math.max(1, room));
  let base = `${/^[A-Z]/.test(upper) ? upper : `P_${upper}`.slice(0, Math.max(1, room))}${suffix}`;
  if (!CONFIG_NAME.test(base)) base = `PARAMETER${suffix}`.slice(0, 96);
  if (!taken.has(base)) return base;
  for (let index = 2; index < 1000; index++) {
    const candidate = `${base.slice(0, 96 - String(index).length - 1)}_${index}`;
    if (!taken.has(candidate) && CONFIG_NAME.test(candidate)) return candidate;
  }
  return base;
}

function profileId(raw: string, taken: Set<string>): string {
  const cleaned = raw.replace(/[^a-zA-Z0-9_.:-]/g, "-").slice(0, 96);
  let candidate = /^[a-zA-Z]/.test(cleaned)
    ? cleaned
    : `ms-${cleaned}`.slice(0, 96);
  if (!identifierSchema.safeParse(candidate).success) candidate = "ms-profile";
  let unique = candidate;
  for (let index = 2; taken.has(unique) && index < 1000; index++)
    unique = `${candidate.slice(0, 92)}-${index}`;
  taken.add(unique);
  return unique;
}

const httpsOrLoopback = (value: string | undefined): string | undefined => {
  if (!value || !URL.canParse(value)) return undefined;
  const url = new URL(value);
  if (url.username || url.password || url.hash) return undefined;
  if (url.protocol === "https:") return url.toString();
  return url.protocol === "http:" &&
    ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)
    ? url.toString()
    : undefined;
};

type ProfileBuild = {
  profiles: AuthenticationProfile[];
  configuration: ConfigurationRequirement[];
  configurationNames: Record<string, string>;
  /** Profile id to the connection parameter set it belongs to, for grouping. */
  profileSets: Record<string, string>;
  /** Native scheme name to profile ids, for capability authentication lists. */
  schemeProfiles: Record<string, string[]>;
};

function buildAuthentication(
  walk: SwaggerWalk,
  properties: ApiProperties | undefined,
  issues: IssueList,
): ProfileBuild {
  const taken = new Set<string>();
  const configurationTaken = new Set<string>();
  const profiles: AuthenticationProfile[] = [];
  const configuration: ConfigurationRequirement[] = [];
  const configurationNames: Record<string, string> = {};
  const profileSets: Record<string, string> = {};
  const schemeProfiles: Record<string, string[]> = {};

  const addConfiguration = (
    nativeName: string,
    pointer: string,
    classification: ConfigurationRequirement["classification"],
    source: ConfigurationRequirement["source"],
    required: boolean,
    description: string | undefined,
    suffix = "",
  ): string => {
    const key = `${nativeName}${suffix}`;
    const existing = configurationNames[key];
    if (existing) return existing;
    const name = configurationNameFor(nativeName, configurationTaken, suffix);
    configurationTaken.add(name);
    configurationNames[key] = name;
    if (name !== key)
      issues.push({
        code: "structure.configuration-name-adapted",
        category: "structure",
        pointer,
        dimension: "configure",
        severity: "warning",
        disposition: "adapted",
        message: `Connection parameter ${token(key)} is held under configuration name ${token(name)}; the native spelling is preserved in the definition's native extensions.`,
        remediation: `Provide the value as ${name} in the deployment or session environment.`,
      });
    configuration.push({
      name,
      source,
      classification,
      required,
      ...(description ? { description: safeText(description, 500) } : {}),
    });
    return name;
  };

  /** One connection parameter becomes zero or one authentication profile plus its configuration. */
  const fromConnectionParameter = (
    parameter: ConnectionParameter,
    setName: string | undefined,
  ): void => {
    const labelBase = parameter.ui.displayName ?? parameter.name;
    const label =
      safeText(setName ? `${setName}: ${labelBase}` : labelBase, 100) ||
      parameter.name;
    const idBase = setName ? `${setName}-${parameter.name}` : parameter.name;
    switch (parameter.kind) {
      case "securestring": {
        addConfiguration(
          parameter.name,
          parameter.pointer,
          "secret",
          "session-environment",
          parameter.ui.required,
          parameter.ui.description,
        );
        return;
      }
      case "string": {
        addConfiguration(
          parameter.name,
          parameter.pointer,
          "public",
          "session-environment",
          parameter.ui.required,
          parameter.ui.description,
        );
        return;
      }
      case "gatewaySetting": {
        addConfiguration(
          parameter.name,
          parameter.pointer,
          "public",
          "host",
          parameter.ui.required,
          parameter.ui.description,
        );
        issues.push({
          code: "network.gateway-required",
          category: "network",
          pointer: parameter.pointer,
          dimension: "invoke",
          severity: "blocking",
          disposition: "unsupported",
          executionImpact: "blocks-definition",
          message:
            "This connector reaches its service through an on-premises data gateway, which this deployment does not provide; its operations cannot be executed here.",
          remediation:
            "Import for description only, or bind an approved network path that does not require the gateway.",
        });
        return;
      }
      case "oauthSetting": {
        const id = profileId(`oauth-${idBase}`, taken);
        const clientIdName = addConfiguration(
          parameter.name,
          parameter.pointer,
          "public",
          "provider-console",
          true,
          "OAuth client identifier registered with the identity provider.",
          "_CLIENT_ID",
        );
        void clientIdName;
        addConfiguration(
          parameter.name,
          parameter.pointer,
          "secret",
          "provider-console",
          true,
          "OAuth client secret registered with the identity provider.",
          "_CLIENT_SECRET",
        );
        const custom = parameter.customParameters;
        const authorizationEndpoint = httpsOrLoopback(
          custom.authorizationurl ?? custom.authorizationUrl,
        );
        const tokenEndpoint = httpsOrLoopback(
          custom.tokenurl ?? custom.tokenUrl,
        );
        if (
          (custom.authorizationurl && !authorizationEndpoint) ||
          (custom.tokenurl && !tokenEndpoint)
        )
          issues.push({
            code: "security.endpoint-rejected",
            category: "security",
            pointer: parameter.pointer,
            dimension: "authorize",
            severity: "blocking",
            disposition: "rejected",
            executionImpact: "blocks-authorization",
            message:
              "An OAuth endpoint in the connection parameters is not an HTTPS URL without credentials and is not carried into the description.",
          });
        if (!authorizationEndpoint || !tokenEndpoint)
          issues.push({
            code: "security.authority-unresolved",
            category: "security",
            pointer: parameter.pointer,
            dimension: "authorize",
            severity: "warning",
            disposition: "requires-configuration",
            message: `Identity provider ${token(parameter.identityProvider)} supplies its own endpoints; the host must pin an issuer and its endpoints before this profile can authorize.`,
            remediation:
              "Record the provider's authorization and token endpoints in the binding under host review.",
          });
        profiles.push({
          id,
          label,
          kind: "oauth-authorization-code",
          pkce: "unknown",
          ...(authorizationEndpoint ? { authorizationEndpoint } : {}),
          ...(tokenEndpoint ? { tokenEndpoint } : {}),
          scopes: parameter.scopes.slice(0, 64),
          scopeSemantics: "provider-scopes",
          clientRegistration: "pre-registered",
          clientAuthentication: "unknown",
          refresh: custom.refreshurl ? "supported" : "unknown",
        });
        if (setName) profileSets[id] = setName;
        return;
      }
      default: {
        addConfiguration(
          parameter.name,
          parameter.pointer,
          "personal",
          "session-environment",
          parameter.ui.required,
          parameter.ui.description,
        );
        const id = profileId(`native-${idBase}`, taken);
        profiles.push({
          id,
          label,
          kind: "unsupported",
          native: token(parameter.nativeType, 120),
        });
        if (setName) profileSets[id] = setName;
        issues.push({
          code: "security.connection-parameter-unsupported",
          category: "security",
          pointer: parameter.pointer,
          dimension: "authorize",
          severity: "blocking",
          disposition: "unsupported",
          executionImpact: "blocks-authorization",
          message: `Connection parameter type ${token(parameter.nativeType)} has no executable authentication profile in this runtime.`,
        });
      }
    }
  };

  // Swagger security definitions describe how a request carries the credential.
  for (const scheme of Object.values(walk.securityDefinitions)) {
    const label =
      safeText(scheme.description ?? scheme.name, 100) || scheme.name;
    if (scheme.type === "apiKey") {
      const placement =
        scheme.in === "query"
          ? "query"
          : scheme.in === "header"
            ? "header"
            : undefined;
      if (!placement || !scheme.parameterName) {
        issues.push({
          code: "security.api-key-incomplete",
          category: "security",
          pointer: scheme.pointer,
          dimension: "authorize",
          severity: "blocking",
          disposition: "rejected",
          executionImpact: "blocks-authorization",
          message: `Security definition ${token(scheme.name)} declares an API key without a usable name and location.`,
        });
        continue;
      }
      const id = profileId(`apikey-${scheme.name}`, taken);
      profiles.push({
        id,
        label,
        kind: "api-key",
        placement,
        parameterName: scheme.parameterName,
      });
      schemeProfiles[scheme.name] = [id];
    } else if (scheme.type === "basic") {
      const id = profileId(`basic-${scheme.name}`, taken);
      profiles.push({ id, label, kind: "http-basic" });
      schemeProfiles[scheme.name] = [id];
    } else if (scheme.type === "oauth2") {
      // Swagger 2.0 flows: implicit, password, application, accessCode.
      // Power Platform does not support the client-credentials ("application") flow.
      if (scheme.flow === "application" || scheme.flow === "password") {
        const id = profileId(`oauth2-${scheme.name}`, taken);
        profiles.push({
          id,
          label,
          kind: "unsupported",
          native: `oauth2 ${token(scheme.flow, 32)}`,
        });
        schemeProfiles[scheme.name] = [id];
        issues.push({
          code: "security.oauth-flow-unsupported",
          category: "security",
          pointer: scheme.pointer,
          dimension: "authorize",
          severity: "blocking",
          disposition: "unsupported",
          executionImpact: "blocks-authorization",
          message: `Custom connectors do not support the OAuth ${token(scheme.flow, 32)} flow; this security definition cannot authorize an operation.`,
        });
        continue;
      }
      const id = profileId(`oauth2-${scheme.name}`, taken);
      const authorizationEndpoint = httpsOrLoopback(scheme.authorizationUrl);
      const tokenEndpoint = httpsOrLoopback(scheme.tokenUrl);
      if (
        (scheme.authorizationUrl && !authorizationEndpoint) ||
        (scheme.tokenUrl && !tokenEndpoint)
      )
        issues.push({
          code: "security.endpoint-rejected",
          category: "security",
          pointer: scheme.pointer,
          dimension: "authorize",
          severity: "blocking",
          disposition: "rejected",
          executionImpact: "blocks-authorization",
          message:
            "An OAuth endpoint in the security definition is not an HTTPS URL without credentials and is not carried into the description.",
        });
      profiles.push({
        id,
        label,
        kind: "oauth-authorization-code",
        pkce: "unknown",
        ...(authorizationEndpoint ? { authorizationEndpoint } : {}),
        ...(tokenEndpoint ? { tokenEndpoint } : {}),
        scopes: Object.keys(scheme.scopes).slice(0, 64),
        scopeSemantics: "provider-scopes",
        clientRegistration: "pre-registered",
        clientAuthentication: "unknown",
        refresh: "unknown",
      });
      schemeProfiles[scheme.name] = [id];
    } else {
      const id = profileId(`native-${scheme.name}`, taken);
      profiles.push({
        id,
        label,
        kind: "unsupported",
        native: token(scheme.type, 120),
      });
      schemeProfiles[scheme.name] = [id];
      issues.push({
        code: "security.scheme-unsupported",
        category: "security",
        pointer: scheme.pointer,
        dimension: "authorize",
        severity: "blocking",
        disposition: "unsupported",
        executionImpact: "blocks-authorization",
        message: `Security definition type ${token(scheme.type)} is not executable by this runtime.`,
      });
    }
  }

  if (properties) {
    for (const parameter of properties.connectionParameters)
      fromConnectionParameter(parameter, undefined);
    for (const set of properties.connectionParameterSets?.values ?? [])
      for (const parameter of set.parameters)
        fromConnectionParameter(parameter, set.name);
  }

  if (!profiles.length) {
    const anonymous =
      walk.documentSecurity !== undefined &&
      walk.documentSecurity.every(
        (alternative) => alternative.schemes.length === 0,
      );
    profiles.push({
      id: "none",
      label: anonymous ? "No authentication" : "No declared authentication",
      kind: "none",
      reason: "public",
    });
  }
  return {
    profiles,
    configuration,
    configurationNames,
    profileSets,
    schemeProfiles,
  };
}

const triggerKind = (
  extensions: Record<string, unknown>,
): "single" | "batch" | undefined => {
  const value = extensions["x-ms-trigger"];
  return value === "single" || value === "batch" ? value : undefined;
};

const visibilityOf = (
  extensions: Record<string, unknown>,
): "important" | "advanced" | "internal" | undefined => {
  const value = extensions["x-ms-visibility"];
  return value === "important" || value === "advanced" || value === "internal"
    ? value
    : undefined;
};

/** A parameter or body property flagged with `"x-ms-notification-url": true`. */
function notificationUrlField(operation: WalkedOperation): string | undefined {
  for (const parameter of operation.parameters) {
    if (parameter.extensions["x-ms-notification-url"] === true)
      return parameter.name;
    for (const node of parameter.nested)
      if (node.extensions["x-ms-notification-url"] === true)
        return node.pathString
          ? `${parameter.name}/${node.pathString}`
          : parameter.name;
  }
  return undefined;
}

function notificationSchemaRef(operation: WalkedOperation): string | undefined {
  const content = operation.pathItemExtensions["x-ms-notification-content"];
  if (typeof content !== "object" || content === null) return undefined;
  const schema = (content as Record<string, unknown>).schema;
  if (typeof schema !== "object" || schema === null) return undefined;
  const ref = (schema as Record<string, unknown>).$ref;
  return typeof ref === "string" && ref.length <= 1024 && !/\p{Cc}/u.test(ref)
    ? ref
    : undefined;
}

function parameterRecord(parameter: WalkedParameter) {
  const visibility = visibilityOf(parameter.extensions);
  return {
    name: parameter.name,
    in: parameter.in,
    required: parameter.required,
    ...(parameter.type ? { type: parameter.type } : {}),
    ...(parameter.format ? { format: parameter.format } : {}),
    ...(visibility ? { visibility } : {}),
    ...(parameter.hasDefault ? { hasDefault: true } : {}),
    ...(parameter.extensions["x-ms-notification-url"] === true
      ? { notificationUrl: true }
      : {}),
    ...(typeof parameter.extensions["x-ms-summary"] === "string"
      ? { summary: safeText(parameter.extensions["x-ms-summary"], 200) }
      : {}),
  };
}

export async function readCustomConnector(
  input: CustomConnectorInput,
): Promise<CustomConnectorReadResult> {
  const issues = new IssueList();
  const walkResult = walkSwagger(input.swagger);
  for (const issue of walkResult.issues)
    issues.push({
      code: issue.code,
      category: issue.category,
      pointer: issue.sourcePointer,
      dimension: issue.dimension,
      severity: issue.severity,
      disposition: issue.disposition,
      executionImpact: issue.executionImpact,
      message: issue.message,
      ...(issue.remediation ? { remediation: issue.remediation } : {}),
    });
  if (!walkResult.ok) throw new CustomConnectorReadError(issues.toArray());
  const walk = walkResult.walk;

  const settings = readConnectorSettings(input.settings);
  let properties: ApiProperties | undefined;
  if (input.apiProperties === undefined) {
    issues.push({
      code: "structure.incomplete-configuration",
      category: "structure",
      pointer: "#",
      dimension: "configure",
      severity: "warning",
      disposition: "requires-configuration",
      message:
        "No apiProperties.json accompanied this definition, so its connection parameters, authentication metadata and policy instances are unknown.",
      remediation:
        "Download the connector with the Power Platform CLI (paconn download) and import apiProperties.json beside the swagger definition.",
    });
  } else {
    const read = readApiProperties(input.apiProperties);
    for (const issue of read.issues)
      issues.push({
        code: issue.code,
        category: issue.category,
        pointer: issue.sourcePointer,
        dimension: issue.dimension,
        severity: issue.severity,
        disposition: issue.disposition,
        executionImpact: issue.executionImpact,
        message: issue.message,
        ...(issue.remediation ? { remediation: issue.remediation } : {}),
      });
    if (read.ok) properties = read.properties;
  }

  const auth = buildAuthentication(walk, properties, issues);
  const profileIds = new Set(auth.profiles.map((profile) => profile.id));

  // Policies, custom code and gateway requirements: preserved, never executed.
  const scriptOperations = properties?.scriptOperations;
  const scriptPresent =
    input.scriptPresent === true ||
    settings.script !== undefined ||
    scriptOperations !== undefined;
  const scriptScope = new Set(scriptOperations ?? []);
  const scriptAppliesToAll = scriptPresent && scriptScope.size === 0;
  if (scriptPresent)
    issues.push({
      code: "executable-code.custom-script",
      category: "executable-code",
      pointer: "#/properties/scriptOperations",
      dimension: "invoke",
      severity: "blocking",
      disposition: "unsupported",
      executionImpact: "blocks-operation",
      message: scriptAppliesToAll
        ? "This connector carries custom C# code that the Power Platform runs in place of its codeless definition for every operation; the code is preserved as metadata, never compiled or executed here, and every operation is execution-blocked."
        : `This connector carries custom C# code that the Power Platform runs in place of its codeless definition for ${scriptScope.size} operation(s); the code is preserved as metadata, never compiled or executed here.`,
      remediation:
        "Bind only operations whose behaviour is fully described by the definition, or reimplement the transformation as an approved host operation.",
    });

  const policyScopes = new Map<string, string[]>();
  let policyAppliesToAll = false;
  for (const policy of properties?.policyTemplateInstances ?? []) {
    const scoped = policy.operationNames && policy.operationNames.length > 0;
    if (!scoped) policyAppliesToAll = true;
    for (const name of policy.operationNames ?? [])
      policyScopes.set(name, [
        ...(policyScopes.get(name) ?? []),
        policy.templateId,
      ]);
    issues.push({
      code: "policy.template-unsupported",
      category: "policy",
      pointer: policy.pointer,
      dimension: "invoke",
      severity: "blocking",
      disposition: "unsupported",
      executionImpact: "blocks-operation",
      message: scoped
        ? `Policy template ${token(policy.templateId)} rewrites requests or responses for ${policy.operationNames?.length ?? 0} operation(s); Ceremony does not run Power Platform policies, so those operations are execution-blocked.`
        : `Policy template ${token(policy.templateId)} rewrites requests or responses for every operation; Ceremony does not run Power Platform policies, so all operations are execution-blocked.`,
      remediation:
        "Express the transformation in the approved binding, or bind only operations the policy does not alter.",
    });
  }
  const gatewayRequired =
    (properties?.capabilities ?? []).includes("gateway") ||
    (properties?.connectionParameters ?? []).some(
      (parameter) => parameter.kind === "gatewaySetting",
    );
  if (
    (properties?.capabilities ?? []).includes("gateway") &&
    !gatewayRequiredByParameter(properties)
  )
    issues.push({
      code: "network.gateway-capability",
      category: "network",
      pointer: "#/properties/capabilities",
      dimension: "invoke",
      severity: "blocking",
      disposition: "unsupported",
      executionImpact: "blocks-definition",
      message:
        "This connector declares the on-premises data gateway capability; this deployment provides no gateway runtime, so its operations cannot be executed here.",
    });

  const dynamicFields = extractDynamicFields(walk, issues);

  // Capabilities, events and per-operation blocking.
  const capabilities: NativeCapability[] = [];
  const events: EventDescriptor[] = [];
  const blocked: Record<string, string[]> = {};
  const executableCandidates: string[] = [];
  const visibility: Record<string, string> = {};
  const addBlocked = (nativeId: string, code: string) => {
    const list = blocked[nativeId] ?? [];
    if (!list.includes(code)) list.push(code);
    blocked[nativeId] = list;
  };

  for (const operation of walk.operations) {
    const operationVisibility = visibilityOf(operation.extensions);
    if (operationVisibility)
      visibility[operation.nativeId] = operationVisibility;
    for (const parameter of operation.parameters) {
      const parameterVisibility = visibilityOf(parameter.extensions);
      if (parameterVisibility)
        visibility[`${operation.nativeId}/${parameter.name}`] =
          parameterVisibility;
    }
    for (const issue of issues.blockingUnder(operation.pointer))
      addBlocked(operation.nativeId, issue.code);
    if (scriptAppliesToAll || scriptScope.has(operation.nativeId))
      addBlocked(operation.nativeId, "executable-code.custom-script");
    if (policyAppliesToAll)
      addBlocked(operation.nativeId, "policy.template-unsupported");
    for (const template of policyScopes.get(operation.nativeId) ?? [])
      addBlocked(
        operation.nativeId,
        `policy.template-unsupported:${template}`.slice(0, 120),
      );
    if (gatewayRequired)
      addBlocked(operation.nativeId, "network.gateway-required");

    const trigger = triggerKind(operation.extensions);
    const notificationField = notificationUrlField(operation);
    if (trigger) {
      const schemaRef = notificationSchemaRef(operation);
      if (notificationField) {
        const created = operation.responses.find(
          (response) => response.status === "201",
        );
        if (
          !created ||
          !created.headers.some((header) => header.toLowerCase() === "location")
        )
          issues.push({
            code: "structure.webhook-unsubscribe-unknown",
            category: "structure",
            pointer: operation.pointer,
            dimension: "events",
            severity: "warning",
            disposition: "adapted",
            message:
              "A webhook registration should answer 201 with a Location header naming the subscription to delete; without it this subscription cannot be withdrawn through the described API.",
          });
        events.push({
          nativeId: operation.nativeId,
          ...(operation.summary
            ? { label: safeText(operation.summary, 200) }
            : {}),
          transport: "http-webhook",
          verification: "unknown",
          ...(schemaRef ? { messageSchemaRef: schemaRef } : {}),
        });
        issues.push({
          code: "structure.webhook-receiver-review",
          category: "structure",
          pointer: operation.pointer,
          dimension: "events",
          severity: "warning",
          disposition: "requires-configuration",
          message:
            "This trigger registers a notification URL with the provider; the receiving endpoint and the way deliveries are authenticated must be approved by the host before the trigger is bound.",
          remediation:
            "Approve a receiver destination and a delivery verification method; unverified deliveries are never accepted.",
        });
      } else {
        events.push({
          nativeId: operation.nativeId,
          ...(operation.summary
            ? { label: safeText(operation.summary, 200) }
            : {}),
          transport: "unsupported",
          nativeTransport: "polling",
          verification: "none",
        });
        issues.push({
          code: "structure.polling-trigger-unsupported",
          category: "structure",
          pointer: operation.pointer,
          dimension: "events",
          severity: "blocking",
          disposition: "unsupported",
          executionImpact: "blocks-operation",
          message: `Trigger ${token(operation.nativeId)} is a polling trigger: the Power Platform holds its cursor in a Location header across 202 responses, and Ceremony has no equivalent trigger state, so it delivers no events here.`,
          remediation:
            "Bind the underlying operation as a read and schedule it through an approved host workflow, or use a webhook trigger.",
        });
        addBlocked(operation.nativeId, "structure.polling-trigger-unsupported");
      }
    }

    const body = operation.parameters.find(
      (parameter) => parameter.in === "body",
    );
    const success = operation.responses.find((response) =>
      /^2/.test(response.status),
    );
    // Extensions are grouped by where they were written, so an export can put
    // each one back on its own node instead of guessing.
    const groupBudget = Object.freeze({
      depth: 14,
      nodes: 900,
      bytes: 28 * 1024,
      stringLength: EXTENSION_LIMITS.stringLength,
    });
    const operationExtensions = packExtensions(
      extensionEntries(operation.extensions, operation.pointer),
      groupBudget,
    );
    const pathExtensions = packExtensions(
      extensionEntries(
        operation.pathItemExtensions,
        pathItemPointerOf(operation),
      ),
      groupBudget,
    );
    const parameterExtensions = packExtensions(
      operation.parameters.flatMap((parameter) => [
        ...extensionEntries(parameter.extensions, parameter.pointer).map(
          (entry) => ({ ...entry, parameter: parameter.name, pathString: "" }),
        ),
        ...parameter.nested.flatMap((node) =>
          extensionEntries(node.extensions, node.pointer).map((entry) => ({
            ...entry,
            parameter: parameter.name,
            pathString: node.pathString,
          })),
        ),
      ]),
      groupBudget,
    );
    const responseExtensions = packExtensions(
      operation.responses.flatMap((response) => [
        ...extensionEntries(response.extensions, response.pointer).map(
          (entry) => ({ ...entry, status: response.status, pathString: "" }),
        ),
        ...response.nested.flatMap((node) =>
          extensionEntries(node.extensions, node.pointer).map((entry) => ({
            ...entry,
            status: response.status,
            pathString: node.pathString,
          })),
        ),
      ]),
      groupBudget,
    );
    const nativeExtensions = fitBlock(
      {
        "microsoft-operation": {
          method: operation.method,
          path: operation.path,
          deprecated: operation.deprecated,
          ...(operationVisibility ? { visibility: operationVisibility } : {}),
          ...(trigger ? { trigger } : {}),
          ...(notificationField
            ? { notificationUrlField: notificationField }
            : {}),
          parameters: operation.parameters.slice(0, 64).map(parameterRecord),
          responses: operation.responses.map((response) => ({
            status: response.status,
            ...(response.description
              ? { description: response.description }
              : {}),
            ...(response.headers.length ? { headers: response.headers } : {}),
          })),
          security: {
            source: operation.security.source,
            alternatives: operation.security.alternatives.map((alternative) =>
              alternative.schemes.map((entry) => ({
                scheme: entry.scheme,
                scopes: entry.scopes,
              })),
            ),
          },
          ...(operation.consumes.length
            ? { consumes: operation.consumes }
            : {}),
          ...(operation.produces.length
            ? { produces: operation.produces }
            : {}),
        },
        ...(operationExtensions.length
          ? { "x-ms-operation-extensions": operationExtensions }
          : {}),
        ...(pathExtensions.length
          ? { "x-ms-path-extensions": pathExtensions }
          : {}),
        ...(parameterExtensions.length
          ? { "x-ms-parameter-extensions": parameterExtensions }
          : {}),
        ...(responseExtensions.length
          ? { "x-ms-response-extensions": responseExtensions }
          : {}),
      },
      [
        "x-ms-response-extensions",
        "x-ms-parameter-extensions",
        "x-ms-path-extensions",
        "x-ms-operation-extensions",
      ],
      (key) =>
        issues.push({
          code: "structure.extensions-truncated",
          category: "structure",
          pointer: operation.pointer,
          dimension: "import",
          severity: "warning",
          disposition: "adapted",
          message: `Preserved extensions of group ${token(key)} exceeded the budget for operation ${token(operation.nativeId)} and are not carried in the description; they remain in the protected source artifact.`,
        }),
    );

    const authentication = [
      ...new Set(
        operation.security.alternatives.flatMap((alternative) =>
          alternative.schemes.flatMap(
            (scheme) => auth.schemeProfiles[scheme.scheme] ?? [],
          ),
        ),
      ),
    ].filter((id) => profileIds.has(id));
    const declaredAnonymous =
      operation.security.alternatives.length > 0 &&
      operation.security.alternatives.every(
        (alternative) => alternative.schemes.length === 0,
      );
    const label = operation.summary ?? operation.nativeId;
    capabilities.push({
      kind: trigger ? "event" : "http-operation",
      nativeId: operation.nativeId,
      label: safeText(label, 200) || operation.nativeId,
      ...(operation.description
        ? { summary: safeText(operation.description, 500) }
        : {}),
      // Swagger 2.0 declares no effect, and a method is not evidence of one.
      effect: "unknown",
      dataClassification: "unknown",
      cost: "unknown",
      ...(authentication.length || declaredAnonymous ? { authentication } : {}),
      ...(body ? { inputSchemaRef: `${body.pointer}/schema` } : {}),
      ...(success?.schema !== undefined
        ? { outputSchemaRef: `${success.pointer}/schema` }
        : {}),
      nativeExtensions,
    });
    if (
      !blocked[operation.nativeId]?.length &&
      operation.identity === "operationId"
    )
      executableCandidates.push(operation.nativeId);
  }

  // x-ms-capabilities.testConnection at the document level.
  let verifierCandidate: VerifierCandidate | undefined;
  const documentCapabilities = walk.extensions["x-ms-capabilities"];
  if (
    typeof documentCapabilities === "object" &&
    documentCapabilities !== null &&
    !Array.isArray(documentCapabilities)
  ) {
    const testConnection = (documentCapabilities as Record<string, unknown>)
      .testConnection;
    if (
      typeof testConnection === "object" &&
      testConnection !== null &&
      !Array.isArray(testConnection)
    ) {
      const record = testConnection as Record<string, unknown>;
      const operationId =
        typeof record.operationId === "string" ? record.operationId : "";
      const target = walk.operations.find(
        (operation) =>
          operation.identity === "operationId" &&
          !operation.ambiguous &&
          operation.nativeId === operationId,
      );
      if (!operationId || !target)
        issues.push({
          code: "structure.test-connection-unknown",
          category: "structure",
          pointer: "#/x-ms-capabilities/testConnection",
          dimension: "verify",
          severity: "warning",
          disposition: "unsupported",
          message:
            "x-ms-capabilities.testConnection names an operation this definition does not declare exactly once; no verifier candidate is offered.",
        });
      else {
        const parameters: DynamicParameterBinding[] = [];
        const raw = record.parameters;
        if (typeof raw === "object" && raw !== null && !Array.isArray(raw))
          for (const [name, value] of Object.entries(raw).slice(0, 32))
            if (
              typeof value === "string" ||
              typeof value === "number" ||
              typeof value === "boolean" ||
              value === null
            )
              parameters.push({ target: name, source: "static", value });
        const resolved = !blocked[target.nativeId]?.length;
        verifierCandidate = {
          operationId,
          operationRef: `msverify:${dynamicOperationRef(operationId).slice(6)}`,
          sourcePointer: "#/x-ms-capabilities/testConnection",
          parameters,
          resolved,
          limitations: [...TEST_CONNECTION_LIMITATIONS],
          requiresHostReview: true,
        };
        issues.push({
          code: "identity.test-connection-candidate",
          category: "identity",
          pointer: "#/x-ms-capabilities/testConnection",
          dimension: "verify",
          severity: "info",
          disposition: "requires-configuration",
          message: `Operation ${token(operationId)} is offered as a connection test. A success shows only that the credential was accepted: it establishes no account identity and observes no permission.`,
          remediation:
            "Approve it as a verifier under host review if connectivity evidence is sufficient for this connector's intent.",
        });
      }
    }
  }

  // Dynamic operations as bound-operation candidates.
  const dynamicOperations = compileDynamicOperations(
    walk,
    dynamicFields,
    blocked,
    issues,
  );

  const documentExtensions = packExtensions(
    collectDocumentExtensions(walk),
    EXTENSION_LIMITS,
    (count) =>
      issues.push({
        code: "structure.extensions-truncated",
        category: "structure",
        pointer: "#",
        dimension: "import",
        severity: "warning",
        disposition: "adapted",
        message: `${count} vendor extension(s) exceeded the preservation budget and are not carried in the description; they remain in the protected source artifact.`,
      }),
  );

  const nativeExtensions = fitBlock(
    {
      "x-ms-extensions": documentExtensions,
      "microsoft-custom-connector": {
        ...(settings.connectorId ? { connectorId: settings.connectorId } : {}),
        ...(settings.environment ? { environment: settings.environment } : {}),
        ...(properties?.publisher ? { publisher: properties.publisher } : {}),
        ...(properties?.stackOwner
          ? { stackOwner: properties.stackOwner }
          : {}),
        ...(properties?.iconBrandColor
          ? { iconBrandColor: properties.iconBrandColor }
          : {}),
        capabilities: properties?.capabilities ?? [],
        connectionParameters: [
          ...(properties?.connectionParameters ?? []).map((parameter) =>
            connectionParameterRecord(
              parameter,
              undefined,
              auth.configurationNames,
            ),
          ),
          ...(properties?.connectionParameterSets?.values ?? []).flatMap(
            (set) =>
              set.parameters.map((parameter) =>
                connectionParameterRecord(
                  parameter,
                  set.name,
                  auth.configurationNames,
                ),
              ),
          ),
        ],
        ...(properties?.connectionParameterSets
          ? {
              connectionParameterSets: {
                ...(properties.connectionParameterSets.displayName
                  ? {
                      displayName:
                        properties.connectionParameterSets.displayName,
                    }
                  : {}),
                values: properties.connectionParameterSets.values.map(
                  (set) => ({
                    name: set.name,
                    ...(set.displayName
                      ? { displayName: set.displayName }
                      : {}),
                    ...(set.allowSharing === undefined
                      ? {}
                      : { allowSharing: set.allowSharing }),
                    parameters: set.parameters.map(
                      (parameter) => parameter.name,
                    ),
                  }),
                ),
              },
            }
          : {}),
        policyTemplateInstances: (
          properties?.policyTemplateInstances ?? []
        ).map((policy) => ({
          templateId: policy.templateId,
          ...(policy.title ? { title: policy.title } : {}),
          parameters: policy.parameters,
          ...(policy.operationNames
            ? { operationNames: policy.operationNames }
            : {}),
          executable: false,
        })),
        script: {
          present: scriptPresent,
          ...(settings.script ? { file: settings.script } : {}),
          operations: scriptOperations ?? [],
          appliesToAllOperations: scriptAppliesToAll,
          executable: false,
        },
        gateway: { required: gatewayRequired, available: false },
        /** Presentation hints only. Visibility never decides authorization or classification. */
        presentation: { visibility, profileSets: auth.profileSets },
        /** Security definitions exactly as written, so an export re-emits them rather than inventing them. */
        securityDefinitions: Object.values(walk.securityDefinitions).map(
          (scheme) => ({
            name: scheme.name,
            type: scheme.type,
            profileIds: auth.schemeProfiles[scheme.name] ?? [],
            ...(scheme.in ? { in: scheme.in } : {}),
            ...(scheme.parameterName
              ? { parameterName: scheme.parameterName }
              : {}),
            ...(scheme.flow ? { flow: scheme.flow } : {}),
            ...(scheme.authorizationUrl
              ? { authorizationUrl: scheme.authorizationUrl }
              : {}),
            ...(scheme.tokenUrl ? { tokenUrl: scheme.tokenUrl } : {}),
            scopes: scheme.scopes,
            ...(scheme.description ? { description: scheme.description } : {}),
          }),
        ),
        ...(walk.documentSecurity
          ? {
              security: walk.documentSecurity.map((alternative) =>
                alternative.schemes.map((entry) => ({
                  scheme: entry.scheme,
                  scopes: entry.scopes,
                })),
              ),
            }
          : {}),
        document: {
          ...(walk.host ? { host: walk.host } : {}),
          ...(walk.basePath ? { basePath: walk.basePath } : {}),
          schemes: walk.schemes,
          ...(walk.consumes.length ? { consumes: walk.consumes } : {}),
          ...(walk.produces.length ? { produces: walk.produces } : {}),
        },
      },
      "microsoft-dynamic-fields": dynamicFields,
      ...(verifierCandidate
        ? { "microsoft-test-connection": verifierCandidate }
        : {}),
    },
    ["x-ms-extensions", "microsoft-dynamic-fields"],
    (key) =>
      issues.push({
        code: "structure.extensions-truncated",
        category: "structure",
        pointer: "#",
        dimension: "import",
        severity: "warning",
        disposition: "adapted",
        message: `Preserved block ${token(key)} exceeded the description's inert-extension budget and is not carried; it remains in the protected source artifact.`,
      }),
  );

  const identity: ConnectorSourceIdentity = {
    ecosystem: MICROSOFT_ECOSYSTEM,
    authorityNamespace:
      input.identity?.authorityNamespace ?? settings.environment ?? "",
    nativeId:
      input.identity?.nativeId ?? settings.connectorId ?? walk.info.title,
    nativeVersion: input.identity?.nativeVersion ?? walk.info.version,
  };
  const serviceKey = walk.info.title
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^[^a-z0-9]+/, "")
    .slice(0, 120);
  const declaredServers = buildDeclaredServers(walk);

  const dimensions: Partial<Record<SupportDimension, MappingDisposition>> = {
    import: "adapted",
    configure: properties ? "adapted" : "requires-configuration",
    authorize: auth.profiles.some((profile) => profile.kind !== "unsupported")
      ? "requires-configuration"
      : "unsupported",
    verify: verifierCandidate ? "requires-configuration" : "unsupported",
    invoke: executableCandidates.length
      ? "requires-configuration"
      : "unsupported",
    events: events.some((event) => event.transport === "http-webhook")
      ? "requires-configuration"
      : events.length
        ? "unsupported"
        : "unsupported",
    export: "adapted",
  };

  const body = {
    schemaVersion: 1 as const,
    definitionRef:
      input.definitionRef ?? "definition:microsoft-custom-connector",
    identity,
    sourceRef: input.sourceRef ?? "source:microsoft-custom-connector",
    importer: {
      id: MICROSOFT_IMPORTER.id,
      version: MICROSOFT_IMPORTER.version,
    },
    display: {
      name: safeText(walk.info.title, 200) || "Custom connector",
      description: safeText(walk.info.description ?? "", 500),
      ecosystem: MICROSOFT_ECOSYSTEM,
      ...(/^[a-z0-9][a-z0-9._-]*$/.test(serviceKey)
        ? { service: serviceKey }
        : {}),
    },
    authentication: auth.profiles,
    configuration: auth.configuration,
    capabilities,
    events,
    declaredServers,
    compatibility: {
      issues: issues.toArray(),
      dimensions: completeDimensions(dimensions),
    },
    nativeExtensions,
  };
  const definition = normalizedDefinitionSchema.parse({
    ...body,
    normalizedDigest: await normalizedDigestOf(body),
  });

  return {
    definition,
    issues: issues.toArray(),
    dynamicFields,
    dynamicOperations,
    ...(verifierCandidate ? { verifierCandidate } : {}),
    executableCandidates,
    blocked,
    configurationNames: auth.configurationNames,
    ...(properties ? { apiProperties: properties } : {}),
    settings,
  };
}

function gatewayRequiredByParameter(
  properties: ApiProperties | undefined,
): boolean {
  return (properties?.connectionParameters ?? []).some(
    (parameter) => parameter.kind === "gatewaySetting",
  );
}

function connectionParameterRecord(
  parameter: ConnectionParameter,
  setName: string | undefined,
  configurationNames: Record<string, string>,
) {
  const base = {
    /** The native spelling, preserved exactly; the configuration name is derived from it. */
    nativeName: parameter.name,
    ...(setName ? { parameterSet: setName } : {}),
    type: parameter.kind === "unknown" ? parameter.nativeType : parameter.kind,
    required: parameter.ui.required,
    hidden: parameter.ui.hidden,
    ...(parameter.ui.displayName
      ? { displayName: parameter.ui.displayName }
      : {}),
    pointer: parameter.pointer,
  };
  const names = [
    configurationNames[parameter.name],
    configurationNames[`${parameter.name}_CLIENT_ID`],
    configurationNames[`${parameter.name}_CLIENT_SECRET`],
  ].filter((name): name is string => typeof name === "string");
  return {
    ...base,
    configurationNames: names,
    ...(parameter.kind === "oauthSetting"
      ? {
          identityProvider: parameter.identityProvider,
          scopes: parameter.scopes,
          ...(parameter.redirectMode
            ? { redirectMode: parameter.redirectMode }
            : {}),
          customParameterNames: Object.keys(parameter.customParameters),
        }
      : {}),
  };
}

function buildDeclaredServers(walk: SwaggerWalk) {
  if (!walk.host) return [];
  const schemes = walk.schemes.length ? walk.schemes : ["https"];
  const basePath = walk.basePath && walk.basePath !== "/" ? walk.basePath : "";
  return schemes
    .filter((scheme) => scheme === "https" || scheme === "http")
    .slice(0, 4)
    .map((scheme) => ({
      url: `${scheme}://${walk.host}${basePath}`,
      status: "declared" as const,
    }));
}

/**
 * Dynamic operations as bound-operation candidates. A lookup that answers a
 * picker is a read, so a GET or HEAD candidate claims read-only replay; any
 * other method keeps an unknown effect and no replay evidence, because a
 * document that says "call POST /search to fill this list" is not proof that
 * the call has no effect. Output is classified personal by default: an
 * account-specific list of projects, mailboxes or files is not public.
 */
function compileDynamicOperations(
  walk: SwaggerWalk,
  fields: readonly DynamicFieldContract[],
  blocked: Record<string, string[]>,
  issues: IssueList,
  destinationId: string,
): BoundOperation[] {
  const byRef = new Map<string, BoundOperation>();
  for (const field of fields) {
    if (!field.operation || !field.executable) continue;
    if (byRef.has(field.operation.operationRef)) continue;
    const operation = walk.operations.find(
      (candidate) =>
        candidate.identity === "operationId" &&
        candidate.nativeId === field.operationId,
    );
    if (!operation) continue;
    if (blocked[operation.nativeId]?.length) continue;
    const readOnly = operation.method === "GET" || operation.method === "HEAD";
    if (!readOnly)
      issues.push({
        code: "policy.dynamic-operation-effect-unknown",
        category: "policy",
        pointer: operation.pointer,
        dimension: "invoke",
        severity: "warning",
        disposition: "requires-configuration",
        message: `Dynamic field operation ${token(operation.nativeId)} is a ${operation.method}; its effect is not established by the description, so the candidate claims no replay evidence and a reviewer must confirm it is effect-free.`,
      });
    const targetParameters = [
      ...new Set(
        operation.parameters
          .filter((parameter) => parameter.in === "path")
          .map((parameter) => parameter.name)
          .filter((name) => identifierSchema.safeParse(name).success),
      ),
    ].slice(0, 8);
    byRef.set(field.operation.operationRef, {
      operationRef: field.operation.operationRef,
      nativeId: operation.nativeId,
      destinationId,
      transport: {
        kind: "http",
        method: operation.method,
        // Swagger 2.0 keys `paths` without `basePath`; the wire path is both.
        pathTemplate: joinBasePath(walk.basePath, operation.path),
      },
      effect: readOnly ? "read" : "unknown",
      outputClassification: "personal",
      cost: "unknown",
      consent: "none",
      replay: readOnly ? "read-only" : "none",
      targetParameters,
      description: `Dynamic field lookup for ${safeText(operation.summary ?? operation.nativeId, 200)}`,
    });
  }
  return [...byRef.values()];
}

/** Thrown when the document cannot be read at all; the diagnostics say why. */
export class CustomConnectorReadError extends Error {
  constructor(readonly issues: CompatibilityIssue[]) {
    super("The custom connector definition could not be imported");
    this.name = "CustomConnectorReadError";
  }
}
