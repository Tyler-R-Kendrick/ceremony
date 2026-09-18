import { createHash } from "node:crypto";
import {
  canonicalDigest,
  sourceIdentityDigest,
  normalizedDefinitionSchema,
  sourceRecordSchema,
  completeDimensions,
  type AuthenticationProfile,
  type ConfigurationRequirement,
  type ConnectorSourceIdentity,
  type MappingDisposition,
  type NativeCapability,
  type NormalizedDefinition,
  type SourceRecord,
  type SupportDimension,
} from "../../../../core/connectors/index.js";
import type { CompatibilityIssue, DiscoveredItem } from "../../adapter.js";
import {
  DOCKER_CATALOG_FORMAT,
  DOCKER_CATALOG_FORMAT_VERSION,
  serverExecutionBlocked,
  type DockerCatalogServer,
  type DockerMcpCatalog,
} from "./catalog.js";

/*
 * Normalization of one Docker MCP catalog entry into a Ceremony description.
 *
 * A catalog entry is a recipe for running a container or contacting a remote
 * endpoint. Nothing here runs it: the image reference, the command, the mounts
 * and the environment travel as inert native data, the secrets become named
 * configuration requirements with no values, and the `invoke` dimension stays
 * unsupported because this deployment has no local runner. Execution requires
 * an explicitly configured trusted local runner, and the capability rows say so
 * instead of implying that importing a catalog installed anything.
 */

export const DOCKER_ECOSYSTEM = "docker-mcp" as const;
export const DOCKER_IMPORTER_ID = "docker-mcp-catalog" as const;
export const DOCKER_IMPORTER_VERSION = "1.0.0" as const;
export const DOCKER_ADAPTER_VERSION = "1.0.0" as const;
export const DOCKER_CATALOG_PROFILE = "docker-mcp-catalog-v2" as const;
export const DOCKER_CATALOG_MEDIA_TYPE = "application/yaml" as const;

const serviceKey = /^[a-z0-9][a-z0-9._-]*$/;
const environmentName = /^[A-Z][A-Z0-9_]{0,95}$/;

export function sha256Hex(bytes: Uint8Array | string): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/**
 * The version of a catalog entry: the image digest when one pins the bytes,
 * otherwise the tag, the remote URL origin, or the date the entry was added.
 * Never coerced into SemVer, never invented.
 */
export function entryVersion(server: DockerCatalogServer): string {
  if (server.image?.digest) return server.image.digest;
  if (server.image?.tag) return `tag:${server.image.tag}`;
  if (server.remote?.url) return `remote:${new URL(server.remote.url).origin}`;
  if (server.dateAdded) return server.dateAdded;
  return "unversioned";
}

export function entryIdentity(
  catalogName: string,
  server: DockerCatalogServer,
): ConnectorSourceIdentity {
  return {
    ecosystem: DOCKER_ECOSYSTEM,
    authorityNamespace: catalogName,
    nativeId: server.id,
    nativeVersion: entryVersion(server),
  };
}

export function discoveredItem(
  catalogName: string,
  server: DockerCatalogServer,
): DiscoveredItem {
  const provenance: Record<string, string> = {
    catalog: catalogName,
    catalogFormat: `${DOCKER_CATALOG_FORMAT}/${DOCKER_CATALOG_FORMAT_VERSION}`,
    entryType: server.type,
  };
  if (server.image?.raw) provenance.image = server.image.raw;
  if (server.image?.digest) provenance.imageDigest = server.image.digest;
  if (server.source) provenance.sourceRepository = server.source;
  if (server.upstream) provenance.upstreamRepository = server.upstream;
  if (server.remote?.url) provenance.remoteUrl = server.remote.url;
  if (server.metadata?.owner) provenance.owner = server.metadata.owner;
  if (server.metadata?.license) provenance.license = server.metadata.license;
  if (server.metadata?.category) provenance.category = server.metadata.category;
  if (server.dateAdded) provenance.dateAdded = server.dateAdded;
  return {
    identity: entryIdentity(catalogName, server),
    displayName: server.title ?? server.id,
    description: server.description ?? "",
    provenance,
    status: serverExecutionBlocked(server) ? "unknown" : "active",
  };
}

function issue(
  code: string,
  category: CompatibilityIssue["category"],
  dimension: SupportDimension,
  disposition: MappingDisposition,
  severity: CompatibilityIssue["severity"],
  executionImpact: CompatibilityIssue["executionImpact"],
  pointer: string,
  message: string,
): CompatibilityIssue {
  return {
    code,
    category,
    sourcePointer: pointer,
    dimension,
    disposition,
    severity,
    executionImpact,
    message,
  };
}

/** The limitation every Docker capability row repeats; a host reads it verbatim. */
export const LOCAL_RUNNER_LIMITATION =
  "Local execution requires an explicitly configured trusted local runner; this deployment has none and never installs one.";

function authenticationFor(
  server: DockerCatalogServer,
  issues: CompatibilityIssue[],
  pointer: string,
): AuthenticationProfile[] {
  const profiles: AuthenticationProfile[] = [];
  if (server.remote) {
    const headerNames = Object.keys(server.remote.headers);
    headerNames.forEach((name, index) => {
      profiles.push({
        id: `remote-header-${index}`,
        label: `Remote header ${name}`,
        kind: "api-key",
        placement: "header",
        parameterName: name,
      });
    });
    if (!headerNames.length && !server.oauth?.providers.length) {
      profiles.push({
        id: "remote-declared-none",
        label: "No credential declared",
        kind: "none",
        reason: "public",
      });
      issues.push(
        issue(
          "docker-mcp.auth.undeclared",
          "identity",
          "authorize",
          "adapted",
          "info",
          "none",
          `${pointer}/remote`,
          "The catalog declares no credential for this remote server; the endpoint may still require authorization at connection time.",
        ),
      );
    }
  }
  for (const provider of server.oauth?.providers ?? []) {
    profiles.push({
      id: `oauth-${provider.provider}`.slice(0, 96),
      label: `Docker-brokered ${provider.provider} authorization`,
      kind: "external-broker",
      broker: DOCKER_ECOSYSTEM,
      custody: "external-credential-broker",
    });
    issues.push(
      issue(
        "docker-mcp.auth.toolkit-broker",
        "security",
        "authorize",
        "unsupported",
        "blocking",
        "blocks-authorization",
        `${pointer}/oauth`,
        "This entry's authorization is performed by the Docker MCP Toolkit, which this deployment does not run; the description is preserved but cannot be authorized here.",
      ),
    );
  }
  if (!server.remote && server.secrets.length) {
    profiles.push({
      id: "container-environment",
      label: "Container environment secrets",
      kind: "unsupported",
      native: "docker-mcp-container-environment",
    });
    issues.push(
      issue(
        "docker-mcp.auth.container-environment",
        "security",
        "authorize",
        "unsupported",
        "blocking",
        "blocks-authorization",
        `${pointer}/secrets`,
        "Credentials for this entry are handed to a local container process; Ceremony cannot execute that without a configured trusted local runner.",
      ),
    );
  }
  if (!profiles.length)
    profiles.push({
      id: "declared-none",
      label: "No credential declared",
      kind: "none",
      reason: "public",
    });
  return profiles;
}

function configurationFor(
  server: DockerCatalogServer,
  issues: CompatibilityIssue[],
  pointer: string,
): ConfigurationRequirement[] {
  const configuration: ConfigurationRequirement[] = [];
  const seen = new Set<string>();
  for (const secret of server.secrets) {
    const name = secret.env.toUpperCase();
    if (!environmentName.test(name) || seen.has(name)) continue;
    seen.add(name);
    configuration.push({
      name,
      source: "session-environment",
      classification: "secret",
      required: secret.required ?? true,
      ...(secret.description ? { description: secret.description } : {}),
    });
  }
  for (const entry of server.env) {
    const name = entry.name.toUpperCase();
    if (!environmentName.test(name) || seen.has(name)) continue;
    // A templated value names configuration the operator still has to supply.
    if (!/\{\{|\$\{/.test(entry.value)) continue;
    seen.add(name);
    configuration.push({
      name,
      source: "host",
      classification: "public",
      required: false,
      description: "Templated catalog value resolved by the runner.",
    });
  }
  if (configuration.length > 48) {
    issues.push(
      issue(
        "docker-mcp.configuration.truncated",
        "structure",
        "configure",
        "adapted",
        "warning",
        "none",
        `${pointer}/secrets`,
        "The entry declares more configuration than a definition carries; the remainder was dropped.",
      ),
    );
    configuration.length = 48;
  }
  return configuration;
}

function capabilitiesFor(
  server: DockerCatalogServer,
  authentication: AuthenticationProfile[],
): NativeCapability[] {
  const ids = authentication.map((profile) => profile.id);
  return server.tools.map((tool) => ({
    kind: "mcp-tool" as const,
    nativeId: tool.name,
    label: tool.name,
    ...(tool.description ? { summary: tool.description } : {}),
    effect: "unknown" as const,
    dataClassification: "unknown" as const,
    cost: "unknown" as const,
    authentication: ids.slice(0, 16),
    ...(tool.parameters !== undefined || tool.container
      ? {
          nativeExtensions: {
            ...(tool.parameters !== undefined
              ? { parameters: tool.parameters }
              : {}),
            ...(tool.container
              ? {
                  container: {
                    ...(tool.container.image
                      ? { image: tool.container.image.raw }
                      : {}),
                    command: tool.container.command,
                  },
                }
              : {}),
          },
        }
      : {}),
  }));
}

/** The inert native descriptor a definition carries so an export can reproduce the entry. */
export function nativeDescriptor(
  catalog: Pick<DockerMcpCatalog, "name" | "displayName" | "version">,
  server: DockerCatalogServer,
): Record<string, unknown> {
  return {
    catalog: {
      name: catalog.name,
      ...(catalog.displayName ? { displayName: catalog.displayName } : {}),
      ...(catalog.version ? { version: catalog.version } : {}),
      format: DOCKER_CATALOG_FORMAT,
    },
    entry: {
      id: server.id,
      type: server.type,
      ...(server.title ? { title: server.title } : {}),
      ...(server.description ? { description: server.description } : {}),
      ...(server.dateAdded ? { dateAdded: server.dateAdded } : {}),
      ...(server.image ? { image: server.image.raw } : {}),
      ...(server.ref ? { ref: server.ref } : {}),
      ...(server.readme ? { readme: server.readme } : {}),
      ...(server.toolsUrl ? { toolsUrl: server.toolsUrl } : {}),
      ...(server.source ? { source: server.source } : {}),
      ...(server.upstream ? { upstream: server.upstream } : {}),
      ...(server.icon ? { icon: server.icon } : {}),
      tools: server.tools.map((tool) => ({ name: tool.name })),
      secrets: server.secrets.map((secret) => ({
        name: secret.name,
        env: secret.env,
        ...(secret.example ? { example: secret.example } : {}),
        ...(secret.description ? { description: secret.description } : {}),
      })),
      env: server.env.map((entry) => ({
        name: entry.name,
        value: entry.value,
      })),
      command: server.command,
      volumes: server.volumes,
      allowHosts: server.allowHosts,
      ...(server.disableNetwork === undefined
        ? {}
        : { disableNetwork: server.disableNetwork }),
      ...(server.longLived === undefined
        ? {}
        : { longLived: server.longLived }),
      ...(server.user ? { user: server.user } : {}),
      config: server.config.map((entry) => ({
        name: entry.name,
        ...(entry.description ? { description: entry.description } : {}),
        schema: entry.schema,
      })),
      ...(server.metadata ? { metadata: server.metadata } : {}),
      ...(server.oauth ? { oauth: server.oauth } : {}),
      ...(server.remote
        ? {
            remote: {
              url: server.remote.url,
              ...(server.remote.transportType
                ? { transport_type: server.remote.transportType }
                : {}),
              headers: server.remote.headers,
            },
          }
        : {}),
      redactions: server.redactions,
      unknownKeys: server.unknownKeys,
    },
  };
}

export type NormalizeOptions = {
  sourceRef: string;
  catalog: DockerMcpCatalog;
  server: DockerCatalogServer;
};

/** One catalog entry as a normalized, non-executable definition. */
export async function normalizeDockerEntry(
  options: NormalizeOptions,
): Promise<NormalizedDefinition> {
  const { catalog, server, sourceRef } = options;
  const pointer = `/registry/${server.id}`;
  const issues: CompatibilityIssue[] = [...server.issues];
  const identity = entryIdentity(catalog.name, server);
  const authentication = authenticationFor(server, issues, pointer);
  const configuration = configurationFor(server, issues, pointer);
  const capabilities = capabilitiesFor(server, authentication);
  issues.push(
    issue(
      "docker-mcp.invoke.local-runner-required",
      "policy",
      "invoke",
      "requires-configuration",
      "warning",
      "none",
      pointer,
      LOCAL_RUNNER_LIMITATION,
    ),
  );
  if (!server.image?.digest && server.type !== "remote")
    issues.push(
      issue(
        "docker-mcp.image.unpinned",
        "version",
        "invoke",
        "requires-configuration",
        "warning",
        "none",
        `${pointer}/image`,
        "The image is not digest-pinned, so a runner cannot prove which bytes it would execute.",
      ),
    );
  const dimensions = completeDimensions({
    discover: "exact",
    import: "exact",
    configure: configuration.length ? "requires-configuration" : "exact",
    authorize: server.oauth?.providers.length
      ? "unsupported"
      : server.remote
        ? "requires-configuration"
        : "unsupported",
    invoke: "requires-configuration",
    export: "exact",
  });
  const body = {
    schemaVersion: 1 as const,
    definitionRef: `docker-mcp:definition:${(await sourceIdentityDigest(identity)).slice(0, 32)}`,
    identity,
    sourceRef,
    importer: { id: DOCKER_IMPORTER_ID, version: DOCKER_IMPORTER_VERSION },
    display: {
      name: (server.title ?? server.id).slice(0, 200),
      description: (server.description ?? "").slice(0, 500),
      ecosystem: DOCKER_ECOSYSTEM,
      ...(serviceKey.test(server.id.toLowerCase())
        ? { service: server.id.toLowerCase() }
        : {}),
    },
    authentication,
    configuration,
    capabilities,
    events: [],
    declaredServers: server.remote
      ? [{ url: server.remote.url, status: "declared" as const }]
      : [],
    compatibility: { issues, dimensions },
    nativeExtensions: nativeDescriptor(catalog, server),
  };
  return normalizedDefinitionSchema.parse({
    ...body,
    normalizedDigest: await canonicalDigest({
      ...body,
      definitionRef: undefined,
      sourceRef: undefined,
    }),
  });
}

export function catalogSourceRecord(input: {
  bytes: Uint8Array;
  catalogName: string;
  origin: SourceRecord["origin"];
  capturedAt: string;
  artifactRef?: string;
}): SourceRecord {
  const digest = sha256Hex(input.bytes);
  return sourceRecordSchema.parse({
    sourceRef: `docker-mcp:source:${digest.slice(0, 32)}`,
    identity: {
      ecosystem: DOCKER_ECOSYSTEM,
      authorityNamespace: input.catalogName,
      nativeId: input.catalogName,
      nativeVersion: DOCKER_CATALOG_FORMAT_VERSION,
    },
    format: {
      name: DOCKER_CATALOG_FORMAT,
      version: DOCKER_CATALOG_FORMAT_VERSION,
    },
    origin: input.origin,
    digest: { algorithm: "sha256", value: digest },
    byteLength: input.bytes.byteLength,
    mediaType: DOCKER_CATALOG_MEDIA_TYPE,
    capturedAt: input.capturedAt,
    license: { redistributable: "unknown" },
    ...(input.artifactRef ? { artifactRef: input.artifactRef } : {}),
    adaptation: [],
    overlays: [],
  });
}
