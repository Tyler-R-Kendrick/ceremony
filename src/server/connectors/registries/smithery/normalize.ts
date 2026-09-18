import {
  canonicalDigest,
  completeDimensions,
  normalizedDefinitionSchema,
  sourceIdentityDigest,
  sourceRecordSchema,
  type AuthenticationProfile,
  type ConnectorSourceIdentity,
  type NativeCapability,
  type NormalizedDefinition,
  type SourceRecord,
} from "../../../../core/connectors/index.js";
import { measureJsonValue } from "../../../../core/connectors/json-bounds.js";
import type { CompatibilityIssue, DiscoveredItem } from "../../adapter.js";
import {
  SMITHERY_ECOSYSTEM,
  SMITHERY_IMPORTER_ID,
  SMITHERY_IMPORTER_VERSION,
  type SmitheryServerDetail,
  type SmitheryServerListItem,
} from "./api.js";

/*
 * Smithery's registry is its own catalog with its own shapes. A listing there
 * carries a qualified name, a namespace, deployment and verification flags and
 * a session `configSchema`; it does not carry a `server.json`, a version or a
 * package identity, and this normalization does not pretend otherwise. What
 * Smithery exposes is preserved as provenance; what it does not expose is
 * recorded as unknown rather than filled in.
 */

const controlOrBidi = /\p{Cc}|[‪-‮⁦-⁩]/gu;
const serviceKey = /^[a-z0-9][a-z0-9._-]*$/;

/** Smithery exposes no server version; the fact is recorded, not invented. */
export const SMITHERY_UNVERSIONED = "unversioned";

export function text(value: unknown, max: number): string {
  return typeof value === "string"
    ? value.replace(controlOrBidi, " ").replace(/\s+/g, " ").trim().slice(0, max)
    : "";
}

function safeUrl(value: unknown): string | undefined {
  if (typeof value !== "string" || !value || value.length > 2048) return undefined;
  if (!URL.canParse(value)) return undefined;
  const url = new URL(value);
  if (url.protocol !== "https:" && url.protocol !== "http:") return undefined;
  if (url.username || url.password || url.hash) return undefined;
  return url.href;
}

export function smitheryIdentity(
  qualifiedName: string,
  namespace?: string | null,
): ConnectorSourceIdentity {
  return {
    ecosystem: SMITHERY_ECOSYSTEM,
    authorityNamespace:
      namespace ?? (qualifiedName.includes("/") ? qualifiedName.split("/")[0]! : ""),
    nativeId: qualifiedName,
    nativeVersion: SMITHERY_UNVERSIONED,
  };
}

export function smitheryDiscoveredItem(
  item: SmitheryServerListItem,
): DiscoveredItem {
  const provenance: Record<string, string> = {
    registry: "smithery",
    qualifiedName: item.qualifiedName,
    versionExposed: "no",
  };
  if (item.namespace) provenance.namespace = item.namespace;
  if (item.slug) provenance.slug = item.slug;
  if (item.id) provenance.registryId = item.id;
  if (item.owner) provenance.owner = item.owner;
  if (item.homepage) provenance.homepage = text(item.homepage, 300);
  if (item.createdAt) provenance.createdAt = text(item.createdAt, 64);
  if (item.verified !== undefined)
    provenance.verifiedFlag = String(item.verified);
  if (item.isDeployed !== undefined)
    provenance.isDeployed = String(item.isDeployed);
  if (item.remote !== undefined && item.remote !== null)
    provenance.remote = String(item.remote);
  if (item.bySmithery !== undefined)
    provenance.bySmithery = String(item.bySmithery);
  if (typeof item.useCount === "number")
    provenance.useCount = String(Math.trunc(item.useCount));
  return {
    identity: smitheryIdentity(item.qualifiedName, item.namespace),
    displayName: text(item.displayName ?? item.qualifiedName, 200),
    description: text(item.description, 500),
    provenance,
    status: "active",
  };
}

function issue(
  code: string,
  category: CompatibilityIssue["category"],
  dimension: CompatibilityIssue["dimension"],
  disposition: CompatibilityIssue["disposition"],
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

type ConfigProperty = { name: string; from: "header" | "query"; required: boolean };

/**
 * Reads a Smithery session `configSchema`. Smithery documents `x-from` as the
 * transport hint (`{ header }` or `{ query }`) and defaults to a query
 * parameter named after the property. Only an explicit header binding becomes
 * an api-key profile; everything else stays declared configuration data,
 * because a query-string value is the server's own configuration, not a
 * Ceremony credential placement decision.
 */
export function readConfigSchema(schema: unknown): ConfigProperty[] {
  if (!schema || typeof schema !== "object" || Array.isArray(schema)) return [];
  const bounded = measureJsonValue(schema, {
    depth: 12,
    nodes: 2048,
    bytes: 64 * 1024,
    stringLength: 8192,
  });
  if (!bounded.ok) return [];
  const properties = (schema as { properties?: unknown }).properties;
  if (!properties || typeof properties !== "object" || Array.isArray(properties))
    return [];
  const required = new Set(
    Array.isArray((schema as { required?: unknown }).required)
      ? ((schema as { required: unknown[] }).required.filter(
          (item): item is string => typeof item === "string",
        ) as string[])
      : [],
  );
  const read: ConfigProperty[] = [];
  for (const [name, value] of Object.entries(
    properties as Record<string, unknown>,
  )) {
    if (read.length >= 20) break;
    if (!/^[A-Za-z_][A-Za-z0-9_.-]{0,127}$/.test(name)) continue;
    const from = (value as { "x-from"?: unknown })?.["x-from"];
    const header =
      from && typeof from === "object" && !Array.isArray(from)
        ? (from as { header?: unknown }).header
        : undefined;
    const query =
      from && typeof from === "object" && !Array.isArray(from)
        ? (from as { query?: unknown }).query
        : undefined;
    if (typeof header === "string" && /^[A-Za-z0-9!#$%&'*+.^_`|~-]{1,128}$/.test(header))
      read.push({ name: header, from: "header", required: required.has(name) });
    else
      read.push({
        name: typeof query === "string" ? query : name,
        from: "query",
        required: required.has(name),
      });
  }
  return read;
}

export type SmitheryNormalizeInput = {
  detail: SmitheryServerDetail;
  sourceRef: string;
  listing?: SmitheryServerListItem;
};

/** One Smithery catalog listing as a normalized, non-executable description. */
export async function normalizeSmitheryServer(
  input: SmitheryNormalizeInput,
): Promise<NormalizedDefinition> {
  const { detail, sourceRef, listing } = input;
  const issues: CompatibilityIssue[] = [];
  const identity = smitheryIdentity(detail.qualifiedName, listing?.namespace);
  const authentication: AuthenticationProfile[] = [];
  const declaredServers: Array<{ url: string; status: "declared" }> = [];
  const deployment = safeUrl(detail.deploymentUrl);
  if (deployment) declaredServers.push({ url: deployment, status: "declared" });
  let index = 0;
  for (const connection of detail.connections ?? []) {
    const pointer = `/connections/${index++}`;
    const url = safeUrl(connection.deploymentUrl);
    if (url && !declaredServers.some((server) => server.url === url))
      declaredServers.push({ url, status: "declared" });
    if (connection.type === "stdio") {
      authentication.push({
        id: `stdio-${index}`,
        label: "Local bundle execution",
        kind: "unsupported",
        native: "smithery-stdio-bundle",
      });
      issues.push(
        issue(
          "smithery.connection.stdio-unsupported",
          "security",
          "invoke",
          "unsupported",
          "blocking",
          "blocks-operation",
          pointer,
          "This listing offers a downloadable stdio bundle; Ceremony never downloads or runs a package, so only a hosted connection can be used.",
        ),
      );
      continue;
    }
    for (const property of readConfigSchema(connection.configSchema))
      if (property.from === "header")
        authentication.push({
          id: `config-header-${authentication.length}`,
          label: `Session header ${property.name}`,
          kind: "api-key",
          placement: "header",
          parameterName: property.name,
        });
  }
  if (!authentication.length)
    issues.push(
      issue(
        "smithery.auth.undeclared",
        "identity",
        "authorize",
        "adapted",
        "info",
        "none",
        "/connections",
        "This listing declares no credential placement; the hosted endpoint may still require authorization when a connection is created.",
      ),
    );
  issues.push(
    issue(
      "smithery.version.not-exposed",
      "version",
      "import",
      "adapted",
      "info",
      "none",
      "/qualifiedName",
      "Smithery's catalog exposes no server version; the identity records this rather than inventing one.",
    ),
  );
  if (detail.security?.scanPassed !== undefined)
    issues.push(
      issue(
        "smithery.security.scan-is-not-approval",
        "policy",
        "invoke",
        "adapted",
        "info",
        "none",
        "/security",
        `Smithery reports its own security scan as ${detail.security.scanPassed ? "passed" : "not passed"}; a registry scan is provenance, never execution approval.`,
      ),
    );
  const capabilities: NativeCapability[] = (detail.tools ?? [])
    .slice(0, 1024)
    .map((tool) => ({
      kind: "mcp-tool" as const,
      nativeId: tool.name,
      label: text(tool.title ?? tool.name, 200) || tool.name,
      ...(tool.description ? { summary: text(tool.description, 500) } : {}),
      effect: "unknown" as const,
      dataClassification: "unknown" as const,
      cost: "unknown" as const,
      authentication: authentication
        .filter((profile) => profile.kind === "api-key")
        .map((profile) => profile.id)
        .slice(0, 16),
    }));
  const service = detail.qualifiedName.includes("/")
    ? detail.qualifiedName.split("/")[1]!.toLowerCase()
    : detail.qualifiedName.toLowerCase();
  const body = {
    schemaVersion: 1 as const,
    definitionRef: `smithery:definition:${(await sourceIdentityDigest(identity)).slice(0, 32)}`,
    identity,
    sourceRef,
    importer: { id: SMITHERY_IMPORTER_ID, version: SMITHERY_IMPORTER_VERSION },
    display: {
      name: text(detail.displayName ?? detail.qualifiedName, 200),
      description: text(detail.description, 500),
      ecosystem: SMITHERY_ECOSYSTEM,
      ...(serviceKey.test(service) ? { service } : {}),
    },
    authentication,
    configuration: [],
    capabilities,
    events: [],
    declaredServers,
    compatibility: {
      issues,
      dimensions: completeDimensions({
        discover: "exact",
        import: "exact",
        authorize: "requires-configuration",
        invoke: "requires-configuration",
        export: "unsupported",
      }),
    },
    nativeExtensions: {
      smithery: {
        qualifiedName: detail.qualifiedName,
        ...(listing?.namespace ? { namespace: listing.namespace } : {}),
        ...(listing?.slug ? { slug: listing.slug } : {}),
        ...(detail.remote === undefined || detail.remote === null
          ? {}
          : { remote: detail.remote }),
        ...(detail.security ? { security: detail.security } : {}),
        connections: (detail.connections ?? []).map((connection) => ({
          ...(connection.type ? { type: connection.type } : {}),
          ...(connection.deploymentUrl
            ? { deploymentUrl: connection.deploymentUrl }
            : {}),
          ...(connection.runtime ? { runtime: connection.runtime } : {}),
          ...(connection.configSchema !== undefined
            ? { configSchema: connection.configSchema }
            : {}),
        })),
        ...(listing
          ? {
              listing: {
                ...(listing.verified === undefined
                  ? {}
                  : { verified: listing.verified }),
                ...(listing.isDeployed === undefined
                  ? {}
                  : { isDeployed: listing.isDeployed }),
                ...(typeof listing.useCount === "number"
                  ? { useCount: listing.useCount }
                  : {}),
                ...(listing.owner ? { owner: listing.owner } : {}),
              },
            }
          : {}),
      },
    },
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

export function smitherySourceRecord(input: {
  bytes: Uint8Array;
  qualifiedName: string;
  namespace?: string | null | undefined;
  origin: SourceRecord["origin"];
  capturedAt: string;
  digest: string;
}): SourceRecord {
  return sourceRecordSchema.parse({
    sourceRef: `smithery:source:${input.digest.slice(0, 32)}`,
    identity: smitheryIdentity(input.qualifiedName, input.namespace),
    format: { name: "smithery-server", version: "2026-09" },
    origin: input.origin,
    digest: { algorithm: "sha256", value: input.digest },
    byteLength: input.bytes.byteLength,
    mediaType: "application/json",
    capturedAt: input.capturedAt,
    license: { redistributable: "unknown" },
    adaptation: [],
    overlays: [],
  });
}
