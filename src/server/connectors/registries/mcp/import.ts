import {
  DEFINITION_LIMITS,
  normalizedDefinitionSchema,
  sourceRecordSchema,
  type CompatibilityIssue,
  type ConfigurationRequirement,
  type NativeCapability,
  type NormalizedDefinition,
  type SourceRecord,
} from "../../../../core/connectors/contracts.js";
import {
  canonicalConnectorJson,
  canonicalDigest,
  sourceIdentityDigest,
  type ConnectorSourceIdentity,
} from "../../../../core/connectors/identity.js";
import type { AuthenticationProfile } from "../../../../core/connectors/contracts.js";
import { ConnectorError } from "../../errors.js";
import { parseBoundedJsonBytes, type JsonBounds } from "./json.js";
import {
  MCP_REGISTRY_IMPORTER_ID,
  MCP_REGISTRY_IMPORTER_VERSION,
  MCP_REGISTRY_OFFICIAL_META_KEY,
  SERVER_JSON_SCHEMA_VERSION,
  configurationNamePattern,
  declaredSchemaVersion,
  knownPackageRegistryTypes,
  knownTransportTypes,
  registryOfficialMetaSchema,
  serverJsonSchema,
  splitRegistryServerName,
  type RegistryArgument,
  type RegistryInput,
  type RegistryKeyValueInput,
  type RegistryOfficialMeta,
  type RegistryPackage,
  type RegistryTransport,
  type ServerJson,
} from "./schemas.js";

/*
 * Inert import of a `server.json` into a normalized definition. Everything in
 * the document is a description: a remote is a declared server, a package is
 * catalog metadata that is never installed, an environment variable is a
 * configuration name whose value this code never sees, and a suspicious
 * argument is flagged, not executed. The definition that comes out cannot be
 * invoked; a reviewed MCP binding is the only path from it to a running
 * connection.
 */

export const MCP_REMOTE_EXTENSION = "io.modelcontextprotocol.registry/remote";
export const MCP_PACKAGE_EXTENSION = "io.modelcontextprotocol.registry/package";
export const MCP_SERVER_EXTENSION = "io.modelcontextprotocol.registry/server";
export const CEREMONY_EXECUTION_EXTENSION = "io.ceremony.connectors/execution";
export const CEREMONY_SCHEMA_EXTENSION = "io.ceremony.connectors/schema";
export const CEREMONY_UNSUPPORTED_CONFIGURATION_EXTENSION =
  "io.ceremony.connectors/unsupported-configuration";
export const CEREMONY_REDACTIONS_EXTENSION = "io.ceremony.connectors/redactions";

export const SERVER_JSON_IMPORT_LIMITS = Object.freeze({
  bytes: 256 * 1024,
  json: { maxBytes: 256 * 1024, maxDepth: 24, maxNodes: 50_000 } as JsonBounds,
});

export type ServerJsonProvenance = {
  sourceRef: string;
  origin: SourceRecord["origin"];
  /** Registry-managed metadata that accompanied the document, when it came from a registry. */
  official?: RegistryOfficialMeta | unknown;
  /** Configured source the document was read from; display form only. */
  sourceId?: string;
  capturedAt?: string;
};

export type ServerJsonImport = {
  definition: NormalizedDefinition;
  identity: ConnectorSourceIdentity;
  identityDigest: string;
  issues: CompatibilityIssue[];
  /** Remote capabilities a reviewer may bind through the MCP runtime; packages are never candidates. */
  executableCandidates: string[];
  schema: { declared: string | undefined; version: string | undefined };
};

const shellMetacharacters = /[;&|`$<>\n\r]|\$\(|\{[^}]*\}\s*\|/;
const remoteFetchPipe = /\b(curl|wget|iwr|invoke-webrequest)\b[^|]*\|\s*(sh|bash|zsh|python\d?|node|pwsh|powershell)\b/i;
const absolutePath = /^(\/|[A-Za-z]:\\|\\\\|~\/)/;
const traversalSegment = /(^|[\\/])\.\.([\\/]|$)/;

const clip = (value: string, max: number) =>
  value.length > max ? `${value.slice(0, max - 1)}…` : value;
const safe = (value: string | undefined, max = 500) =>
  value === undefined
    ? undefined
    : clip(value.replace(/\p{Cc}/gu, " "), max);

class IssueList {
  readonly issues: CompatibilityIssue[] = [];
  dropped = 0;
  add(issue: CompatibilityIssue): void {
    if (this.issues.length >= DEFINITION_LIMITS.issues) this.dropped++;
    else this.issues.push(issue);
  }
}

function issue(
  code: string,
  pointer: string,
  message: string,
  overrides: Partial<CompatibilityIssue> = {},
): CompatibilityIssue {
  return {
    code,
    category: "structure",
    sourcePointer: pointer,
    dimension: "import",
    disposition: "adapted",
    severity: "warning",
    executionImpact: "none",
    message,
    ...overrides,
  };
}

/** Is a command-line value the kind of thing that should make a reviewer look twice? */
export function suspiciousArgument(value: string): string | undefined {
  if (remoteFetchPipe.test(value)) return "remote-script-pipe";
  if (shellMetacharacters.test(value)) return "shell-metacharacters";
  if (traversalSegment.test(value)) return "path-traversal";
  if (absolutePath.test(value)) return "absolute-path";
  return undefined;
}

type Redaction = { pointer: string; field: "value" | "default" | "placeholder" };

/** A copy of an input with secret values removed; the field names stay so a reviewer sees what was there. */
function inertInput<T extends RegistryInput>(
  input: T,
  pointer: string,
  redactions: Redaction[],
): T {
  const copy: Record<string, unknown> = { ...input };
  if (input.isSecret === true) {
    for (const field of ["value", "default", "placeholder"] as const)
      if (typeof copy[field] === "string" && copy[field].length > 0) {
        copy[field] = undefined;
        delete copy[field];
        redactions.push({ pointer, field });
      }
  }
  if (input && typeof input === "object" && "variables" in input) {
    const variables = (input as { variables?: Record<string, RegistryInput> })
      .variables;
    if (variables)
      copy.variables = Object.fromEntries(
        Object.entries(variables).map(([name, variable]) => [
          name,
          inertInput(variable, `${pointer}.variables.${name}`, redactions),
        ]),
      );
  }
  return copy as T;
}

function scanArguments(
  args: RegistryArgument[] | null | undefined,
  pointer: string,
  issues: IssueList,
): void {
  for (const [index, argument] of (args ?? []).entries()) {
    const fields: Array<[string, string | undefined]> = [
      ["name", argument.name],
      ["value", argument.value],
      ["default", argument.default],
      ["valueHint", argument.valueHint],
    ];
    for (const [field, value] of fields) {
      if (value === undefined) continue;
      const reason = suspiciousArgument(value);
      if (reason)
        issues.add(
          issue(
            "executable-code.suspicious-argument",
            `${pointer}[${index}].${field}`,
            `Package argument looks like ${reason.replace(/-/g, " ")}; it is recorded as inert text and is never executed`,
            { category: "executable-code", dimension: "invoke", disposition: "unsupported" },
          ),
        );
    }
    for (const [name, variable] of Object.entries(argument.variables ?? {}))
      for (const field of ["value", "default"] as const) {
        const value = variable[field];
        if (value === undefined) continue;
        const reason = suspiciousArgument(value);
        if (reason)
          issues.add(
            issue(
              "executable-code.suspicious-argument",
              `${pointer}[${index}].variables.${name}.${field}`,
              `Argument variable looks like ${reason.replace(/-/g, " ")}; it is recorded as inert text and is never executed`,
              { category: "executable-code", dimension: "invoke", disposition: "unsupported" },
            ),
          );
      }
  }
}

type ConfigurationCollector = {
  requirements: Map<string, ConfigurationRequirement>;
  unsupported: Array<{ pointer: string; name: string; reason: string }>;
};

function collectConfiguration(
  input: RegistryKeyValueInput | (RegistryInput & { name?: string }),
  name: string,
  pointer: string,
  collector: ConfigurationCollector,
  issues: IssueList,
  kind: "environment variable" | "header" | "variable",
): void {
  if (!configurationNamePattern.test(name)) {
    collector.unsupported.push({ pointer, name: clip(name, 120), reason: "name" });
    issues.add(
      issue(
        "structure.configuration-name-unsupported",
        pointer,
        `A ${kind} name does not fit the configuration naming rule; it is preserved as native data and is not a configuration requirement`,
        { dimension: "configure", disposition: "native-extension" },
      ),
    );
    return;
  }
  const classification: ConfigurationRequirement["classification"] =
    input.isSecret === true
      ? "secret"
      : input.format === "filepath"
        ? "personal"
        : "public";
  const existing = collector.requirements.get(name);
  const description = safe(input.description, 500);
  const next: ConfigurationRequirement = {
    name,
    source: "host",
    classification:
      existing?.classification === "secret" ? "secret" : classification,
    required: (existing?.required ?? false) || input.isRequired === true,
    ...(description ? { description } : existing?.description ? { description: existing.description } : {}),
  };
  collector.requirements.set(name, next);
}

function transportSummary(transport: RegistryTransport): string {
  const type = knownTransportTypes.includes(
    transport.type as (typeof knownTransportTypes)[number],
  )
    ? transport.type
    : "unknown";
  return `MCP ${type} transport declared by the registry document`;
}

function remoteCapability(
  remote: RegistryTransport,
  index: number,
  issues: IssueList,
  redactions: Redaction[],
  collector: ConfigurationCollector,
  profiles: AuthenticationProfile[],
): NativeCapability | undefined {
  const pointer = `remotes[${index}]`;
  if (!["streamable-http", "sse"].includes(remote.type)) {
    issues.add(
      issue(
        "structure.remote-transport-unsupported",
        pointer,
        "Remote transport type is not streamable-http or sse; it is preserved as native data only",
        { disposition: "native-extension", dimension: "invoke" },
      ),
    );
  }
  if (!remote.url) {
    issues.add(
      issue(
        "structure.remote-url-missing",
        pointer,
        "Remote declares no URL and cannot be described as a server",
        { disposition: "rejected" },
      ),
    );
    return undefined;
  }
  const headers = (remote.headers ?? []).map((header, headerIndex) =>
    inertInput(header, `${pointer}.headers[${headerIndex}]`, redactions),
  );
  const authentication: string[] = [];
  for (const [headerIndex, header] of headers.entries()) {
    const headerPointer = `${pointer}.headers[${headerIndex}]`;
    if (header.isSecret === true) {
      const id = `remote-${index}-header-${headerIndex}`;
      profiles.push({
        id,
        label: clip(`Header ${header.name}`, 100),
        kind: "api-key",
        placement: "header",
        parameterName: clip(header.name.replace(/\s/g, ""), 120) || "X-Header",
      });
      authentication.push(id);
    }
    collectConfiguration(
      header,
      header.name.toUpperCase().replace(/-/g, "_"),
      headerPointer,
      collector,
      issues,
      "header",
    );
  }
  for (const [name, variable] of Object.entries(remote.variables ?? {}))
    collectConfiguration(
      variable,
      name,
      `${pointer}.variables.${name}`,
      collector,
      issues,
      "variable",
    );
  if (authentication.length === 0)
    issues.add(
      issue(
        "security.remote-authorization-undeclared",
        pointer,
        "The document does not declare how this remote authenticates; MCP authorization is discovered when a reviewed binding connects",
        {
          category: "security",
          dimension: "authorize",
          disposition: "requires-configuration",
          severity: "info",
        },
      ),
    );
  const variables = Object.fromEntries(
    Object.entries(remote.variables ?? {}).map(([name, variable]) => [
      name,
      inertInput(variable, `${pointer}.variables.${name}`, redactions),
    ]),
  );
  return {
    kind: "custom",
    nativeId: `mcp-remote:${index}`,
    label: clip(`Remote ${index + 1} (${remote.type})`, 200),
    summary: transportSummary(remote),
    effect: "unknown",
    dataClassification: "unknown",
    cost: "unknown",
    ...(authentication.length ? { authentication } : {}),
    nativeExtensions: {
      [MCP_REMOTE_EXTENSION]: {
        ...remote,
        headers,
        variables,
      },
      [CEREMONY_EXECUTION_EXTENSION]: {
        approved: false,
        reason: "A declared remote is a candidate for an MCP binding, never an approved destination",
      },
    },
  };
}

function packageCapability(
  pkg: RegistryPackage,
  index: number,
  issues: IssueList,
  redactions: Redaction[],
  collector: ConfigurationCollector,
): NativeCapability {
  const pointer = `packages[${index}]`;
  if (
    !knownPackageRegistryTypes.includes(
      pkg.registryType as (typeof knownPackageRegistryTypes)[number],
    )
  )
    issues.add(
      issue(
        "structure.package-registry-unknown",
        `${pointer}.registryType`,
        "Package registry type is not one this reader knows; the package is preserved as native data",
        { disposition: "native-extension" },
      ),
    );
  scanArguments(pkg.runtimeArguments, `${pointer}.runtimeArguments`, issues);
  scanArguments(pkg.packageArguments, `${pointer}.packageArguments`, issues);
  for (const field of ["identifier", "runtimeHint"] as const) {
    const value = pkg[field];
    if (value === undefined) continue;
    const reason = suspiciousArgument(value);
    if (reason && !(field === "identifier" && pkg.registryType === "mcpb" && /^https:\/\//.test(value)))
      issues.add(
        issue(
          "executable-code.suspicious-argument",
          `${pointer}.${field}`,
          `Package ${field} looks like ${reason.replace(/-/g, " ")}; it is recorded as inert text and is never executed`,
          { category: "executable-code", dimension: "invoke", disposition: "unsupported" },
        ),
      );
  }
  const environmentVariables = (pkg.environmentVariables ?? []).map(
    (variable, variableIndex) => {
      const variablePointer = `${pointer}.environmentVariables[${variableIndex}]`;
      collectConfiguration(
        variable,
        variable.name,
        variablePointer,
        collector,
        issues,
        "environment variable",
      );
      return inertInput(variable, variablePointer, redactions);
    },
  );
  const inertArguments = (args: RegistryArgument[] | null | undefined, argPointer: string) =>
    (args ?? []).map((argument, argumentIndex) =>
      inertInput(argument, `${argPointer}[${argumentIndex}]`, redactions),
    );
  const idCandidate = `mcp-package:${pkg.registryType}:${pkg.identifier}`;
  const nativeId =
    idCandidate.length <= 512 &&
    !traversalSegment.test(pkg.identifier) &&
    !/^\.\.?$/.test(pkg.identifier)
      ? idCandidate
      : `mcp-package:${index}`;
  return {
    kind: "custom",
    nativeId,
    label: clip(`Package ${index + 1} (${pkg.registryType})`, 200),
    summary: `Catalog metadata for a ${pkg.registryType} package; Ceremony never installs or runs packages`,
    effect: "unknown",
    dataClassification: "unknown",
    cost: "unknown",
    nativeExtensions: {
      [MCP_PACKAGE_EXTENSION]: {
        ...pkg,
        runtimeArguments: inertArguments(pkg.runtimeArguments, `${pointer}.runtimeArguments`),
        packageArguments: inertArguments(pkg.packageArguments, `${pointer}.packageArguments`),
        environmentVariables,
        transport: {
          ...pkg.transport,
          headers: (pkg.transport.headers ?? []).map((header, headerIndex) =>
            inertInput(header, `${pointer}.transport.headers[${headerIndex}]`, redactions),
          ),
        },
      },
      [CEREMONY_EXECUTION_EXTENSION]: {
        approved: false,
        reason:
          "Package commands, images, arguments and environment values are never approved for execution by an import",
      },
    },
  };
}

/** Reads and validates the document; identity failures are refused with sanitized codes. */
export function parseServerJson(document: unknown): ServerJson {
  const parsed = serverJsonSchema.safeParse(document);
  if (parsed.success) return parsed.data;
  const first = parsed.error.issues[0];
  const path = first?.path[0];
  const detail =
    path === "name"
      ? "server-json.name.invalid"
      : path === "version"
        ? "server-json.version.invalid"
        : path === "description"
          ? "server-json.description.invalid"
          : path === "packages"
            ? "server-json.packages.invalid"
            : path === "remotes"
              ? "server-json.remotes.invalid"
              : "server-json.invalid";
  throw new ConnectorError("invalid-request", { detail });
}

/**
 * Imports one `server.json` document (already parsed JSON) with its provenance.
 * The document must at least carry a valid registry name and version; the rest
 * is normalized with issues rather than refused.
 */
export async function importServerJson(
  document: unknown,
  provenance: ServerJsonProvenance,
): Promise<ServerJsonImport> {
  if (
    document === null ||
    typeof document !== "object" ||
    Array.isArray(document) ||
    canonicalConnectorJson(document).length > SERVER_JSON_IMPORT_LIMITS.bytes
  )
    throw new ConnectorError("invalid-request", { detail: "server-json.invalid" });
  const server = parseServerJson(document);
  const issues = new IssueList();
  const redactions: Redaction[] = [];
  const collector: ConfigurationCollector = {
    requirements: new Map(),
    unsupported: [],
  };
  const profiles: AuthenticationProfile[] = [];
  const { namespace } = splitRegistryServerName(server.name);
  const identity: ConnectorSourceIdentity = {
    ecosystem: "mcp-registry",
    authorityNamespace: namespace,
    nativeId: server.name,
    nativeVersion: server.version,
  };
  const identityDigest = await sourceIdentityDigest(identity);

  const schema = declaredSchemaVersion(server.$schema);
  if (schema.declared === undefined)
    issues.add(
      issue(
        "version.schema-unspecified",
        "$schema",
        `The document declares no server.json schema; it was read as ${SERVER_JSON_SCHEMA_VERSION}`,
        { category: "version" },
      ),
    );
  else if (!schema.compatible)
    issues.add(
      issue(
        "version.schema-unpinned",
        "$schema",
        `The document declares a server.json schema this reader has not pinned; it was read as ${SERVER_JSON_SCHEMA_VERSION} and should be reviewed`,
        { category: "version" },
      ),
    );
  if (server.description.length > 100)
    issues.add(
      issue(
        "structure.description-length",
        "description",
        "Description exceeds the 100 characters the registry schema allows; the full text is preserved as native data",
      ),
    );

  let official: RegistryOfficialMeta | undefined;
  if (provenance.official !== undefined) {
    const parsedMeta = registryOfficialMetaSchema.safeParse(provenance.official);
    if (parsedMeta.success) official = parsedMeta.data;
    else
      issues.add(
        issue(
          "structure.registry-meta-invalid",
          "_meta",
          "Registry-managed metadata supplied with the document did not match the pinned shape and was ignored",
          { disposition: "rejected" },
        ),
      );
  }
  if (official?.status === "deleted")
    issues.add(
      issue(
        "version.tombstoned",
        "_meta",
        "The registry reports this version as deleted; it is imported as a tombstoned description",
        { category: "version", dimension: "discover" },
      ),
    );
  else if (official?.status === "deprecated")
    issues.add(
      issue(
        "version.deprecated",
        "_meta",
        "The registry reports this version as deprecated",
        { category: "version", dimension: "discover", severity: "info" },
      ),
    );

  const capabilities: NativeCapability[] = [];
  const declaredServers: NormalizedDefinition["declaredServers"] = [];
  const remotes = server.remotes ?? [];
  const packages = server.packages ?? [];
  for (const [index, remote] of remotes.entries()) {
    const capability = remoteCapability(remote, index, issues, redactions, collector, profiles);
    if (!capability) continue;
    capabilities.push(capability);
    if (remote.url && remote.url.length <= 2048)
      declaredServers.push({
        url: remote.url,
        description: clip(`Declared ${remote.type} remote ${index + 1}`, 500),
        status: "declared",
      });
  }
  for (const [index, pkg] of packages.entries())
    capabilities.push(packageCapability(pkg, index, issues, redactions, collector));
  if (packages.length)
    issues.add(
      issue(
        "executable-code.package-not-executable",
        "packages",
        "Packages are catalog metadata; no installation, process or image pull happens on import or on binding",
        {
          category: "executable-code",
          dimension: "invoke",
          disposition: "unsupported",
          severity: "info",
        },
      ),
    );
  if (!remotes.length && !packages.length)
    issues.add(
      issue(
        "structure.no-runtime-declared",
        "",
        "The document declares neither remotes nor packages; only descriptive metadata was imported",
        { severity: "info" },
      ),
    );
  issues.add(
    issue(
      "policy.execution-requires-binding",
      "",
      "Imported registry metadata is not executable; invocation requires a reviewed MCP binding to an approved destination",
      {
        category: "policy",
        dimension: "invoke",
        disposition: "requires-configuration",
        severity: "blocking",
        executionImpact: "blocks-operation",
      },
    ),
  );
  if (redactions.length)
    issues.add(
      issue(
        "security.secret-value-redacted",
        redactions[0]!.pointer,
        `${redactions.length} secret input value(s) present in the document were not carried into the definition`,
        { category: "security", disposition: "adapted", severity: "info" },
      ),
    );

  const configuration = [...collector.requirements.values()];
  if (configuration.length > DEFINITION_LIMITS.configuration) {
    issues.add(
      issue(
        "structure.configuration-truncated",
        "packages",
        `Only the first ${DEFINITION_LIMITS.configuration} configuration names were kept as requirements; the rest are preserved as native data`,
      ),
    );
    for (const item of configuration.slice(DEFINITION_LIMITS.configuration))
      collector.unsupported.push({ pointer: "", name: item.name, reason: "limit" });
    configuration.length = DEFINITION_LIMITS.configuration;
  }
  const knownKeys = new Set([
    "$schema",
    "name",
    "description",
    "title",
    "version",
    "websiteUrl",
    "repository",
    "icons",
    "packages",
    "remotes",
    "_meta",
  ]);
  const extra: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(server))
    if (!knownKeys.has(key)) extra[key] = value;
  const { packages: _packages, remotes: _remotes, ...descriptive } = server;
  void _packages;
  void _remotes;
  const nativeExtensions: NormalizedDefinition["nativeExtensions"] = {
    [MCP_SERVER_EXTENSION]: { ...descriptive, ...(Object.keys(extra).length ? { unknownFields: extra } : {}) },
    [CEREMONY_SCHEMA_EXTENSION]: {
      pinned: SERVER_JSON_SCHEMA_VERSION,
      declared: schema.declared ?? null,
      declaredVersion: schema.version ?? null,
      compatible: schema.compatible,
    },
    ...(official ? { [MCP_REGISTRY_OFFICIAL_META_KEY]: official } : {}),
    ...(collector.unsupported.length
      ? { [CEREMONY_UNSUPPORTED_CONFIGURATION_EXTENSION]: collector.unsupported.slice(0, 256) }
      : {}),
    ...(redactions.length ? { [CEREMONY_REDACTIONS_EXTENSION]: redactions.slice(0, 256) } : {}),
    ...(provenance.sourceId ? { "io.ceremony.connectors/source": { sourceId: provenance.sourceId } } : {}),
  };
  const dimensions: NormalizedDefinition["compatibility"]["dimensions"] = {
    discover: "exact",
    import: "exact",
    export: "adapted",
    configure: configuration.length ? "requires-configuration" : "exact",
    authorize: remotes.length ? "requires-configuration" : "unsupported",
    verify: remotes.length ? "requires-configuration" : "unsupported",
    invoke: remotes.length ? "requires-configuration" : "unsupported",
    events: "unsupported",
    reconnect: remotes.length ? "requires-configuration" : "unsupported",
    disconnect: remotes.length ? "requires-configuration" : "unsupported",
    revoke: "unsupported",
    delegate: "unsupported",
  };
  const withoutDigest = {
    schemaVersion: 1 as const,
    definitionRef: `def:mcp-registry:${identityDigest}`,
    identity,
    sourceRef: provenance.sourceRef,
    importer: { id: MCP_REGISTRY_IMPORTER_ID, version: MCP_REGISTRY_IMPORTER_VERSION },
    display: {
      name: clip(safe(server.title, 200) || server.name, 200),
      description: safe(server.description, 500) ?? "",
      ecosystem: "mcp-registry",
    },
    authentication: profiles.slice(0, DEFINITION_LIMITS.authentication),
    configuration,
    capabilities: capabilities.slice(0, DEFINITION_LIMITS.capabilities),
    events: [],
    declaredServers: declaredServers.slice(0, 32),
    compatibility: { issues: issues.issues, dimensions },
    nativeExtensions,
  };
  const normalizedDigest = await canonicalDigest(withoutDigest);
  const definition = normalizedDefinitionSchema.parse({
    ...withoutDigest,
    normalizedDigest,
  });
  return {
    definition,
    identity,
    identityDigest,
    issues: definition.compatibility.issues,
    executableCandidates: definition.capabilities
      .filter((capability) => capability.nativeId.startsWith("mcp-remote:"))
      .map((capability) => capability.nativeId),
    schema: { declared: schema.declared, version: schema.version },
  };
}

/** Decodes uploaded or fetched bytes within bounds and imports them. */
export async function importServerJsonBytes(
  bytes: Uint8Array,
  provenance: ServerJsonProvenance,
): Promise<ServerJsonImport> {
  return importServerJson(
    parseBoundedJsonBytes(bytes, SERVER_JSON_IMPORT_LIMITS.json),
    provenance,
  );
}

/** Builds the provenance record for bytes that were imported; exact-byte digest, never the bytes themselves. */
export async function serverJsonSourceRecord(input: {
  sourceRef: string;
  identity: ConnectorSourceIdentity;
  origin: SourceRecord["origin"];
  bytes: Uint8Array;
  mediaType?: string;
  capturedAt: string;
  schemaVersion: string | undefined;
  normalizedDigest: string;
  artifactRef?: string;
}): Promise<SourceRecord> {
  const digest = Array.from(
    new Uint8Array(await globalThis.crypto.subtle.digest("SHA-256", input.bytes)),
    (byte) => byte.toString(16).padStart(2, "0"),
  ).join("");
  return sourceRecordSchema.parse({
    sourceRef: input.sourceRef,
    identity: input.identity,
    format: {
      name: "server-json",
      version: input.schemaVersion ?? "unspecified",
    },
    origin: input.origin,
    digest: { algorithm: "sha256", value: digest },
    byteLength: input.bytes.byteLength,
    mediaType: input.mediaType ?? "application/json",
    capturedAt: input.capturedAt,
    ...(input.artifactRef ? { artifactRef: input.artifactRef } : {}),
    adaptation: [
      {
        step: MCP_REGISTRY_IMPORTER_ID,
        version: MCP_REGISTRY_IMPORTER_VERSION,
        inputDigest: digest,
        outputDigest: input.normalizedDigest,
      },
    ],
    overlays: [],
  });
}
