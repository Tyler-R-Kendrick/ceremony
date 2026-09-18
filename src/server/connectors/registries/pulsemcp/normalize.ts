import { createHash } from "node:crypto";
import {
  canonicalDigest,
  completeDimensions,
  normalizedDefinitionSchema,
  sourceIdentityDigest,
  sourceRecordSchema,
  type AuthenticationProfile,
  type ConnectorSourceIdentity,
  type NormalizedDefinition,
  type SourceRecord,
} from "../../../../core/connectors/index.js";
import type { CompatibilityIssue, DiscoveredItem } from "../../adapter.js";
import {
  PULSEMCP_ECOSYSTEM,
  PULSEMCP_IMPORTER_ID,
  PULSEMCP_IMPORTER_VERSION,
  PULSEMCP_SERVER_META,
  PULSEMCP_VERSION_META,
  type PulseMcpServer,
  type PulseMcpSubregistryEntry,
} from "./api.js";

/*
 * Normalization of PulseMCP's native listing.
 *
 * The native list is a directory entry: a name, a description, a repository,
 * package coordinates, and zero or more remotes. It has no version, no tool
 * list and no configuration schema, so this produces a description that says
 * so. Package coordinates are carried as inert provenance — a package name is
 * not permission to install anything — and PulseMCP's experimental
 * machine-written description is kept out of the display text and labelled.
 */

const controlOrBidi = /\p{Cc}|[‪-‮⁦-⁩]/gu;
const serviceKey = /^[a-z0-9][a-z0-9._-]*$/;

/** The native API exposes no version for a listing; the fact is recorded. */
export const PULSEMCP_UNVERSIONED = "unversioned";

export function text(value: unknown, max: number): string {
  return typeof value === "string"
    ? value
        .replace(controlOrBidi, " ")
        .replace(/\s+/g, " ")
        .trim()
        .slice(0, max)
    : "";
}

export function safeUrl(value: unknown): string | undefined {
  if (typeof value !== "string" || !value || value.length > 2048)
    return undefined;
  if (!URL.canParse(value)) return undefined;
  const url = new URL(value);
  if (url.protocol !== "https:" && url.protocol !== "http:") return undefined;
  if (url.username || url.password || url.hash) return undefined;
  return url.href;
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

export function pulseMcpIdentity(name: string): ConnectorSourceIdentity {
  return {
    ecosystem: PULSEMCP_ECOSYSTEM,
    authorityNamespace: "pulsemcp.com",
    nativeId: name,
    nativeVersion: PULSEMCP_UNVERSIONED,
  };
}

export function pulseMcpDiscoveredItem(server: PulseMcpServer): DiscoveredItem {
  const provenance: Record<string, string> = {
    registry: "pulsemcp",
    apiProfile: "v0beta",
    versionExposed: "no",
  };
  const listing = safeUrl(server.url);
  if (listing) provenance.listingUrl = listing;
  const external = safeUrl(server.external_url);
  if (external) provenance.externalUrl = external;
  const repository = safeUrl(server.source_code_url);
  if (repository) provenance.repositoryUrl = repository;
  if (typeof server.github_stars === "number")
    provenance.githubStars = String(Math.trunc(server.github_stars));
  if (server.package_registry)
    provenance.packageRegistry = text(server.package_registry, 64);
  if (server.package_name)
    provenance.packageName = text(server.package_name, 200);
  if (typeof server.package_download_count === "number")
    provenance.packageDownloads = String(
      Math.trunc(server.package_download_count),
    );
  const remote = (server.remotes ?? []).find((item) =>
    safeUrl(item.url_direct),
  );
  if (remote) {
    provenance.remoteUrl = safeUrl(remote.url_direct)!;
    if (remote.transport)
      provenance.remoteTransport = text(remote.transport, 64);
    if (remote.authentication_method)
      provenance.remoteAuthentication = text(remote.authentication_method, 64);
  }
  if (server.integrations?.length)
    provenance.integrations = server.integrations
      .map((integration) => text(integration.slug, 64))
      .filter(Boolean)
      .slice(0, 8)
      .join(",");
  return {
    identity: pulseMcpIdentity(server.name),
    displayName: text(server.name, 200),
    description: text(server.short_description, 500),
    provenance,
    status: "active",
  };
}

/** A `/v0.1` entry as a discovered item: envelope and `_meta` only. */
export function subregistryDiscoveredItem(
  entry: PulseMcpSubregistryEntry,
): DiscoveredItem {
  const meta = entry._meta?.[PULSEMCP_SERVER_META];
  const versionMeta = entry._meta?.[PULSEMCP_VERSION_META];
  const name = entry.server.name;
  const namespace = name.includes("/") ? name.split("/")[0]! : "";
  const provenance: Record<string, string> = {
    registry: "pulsemcp",
    apiProfile: "v0.1",
    documentShape: "server.json",
  };
  if (versionMeta?.source) provenance.source = text(versionMeta.source, 200);
  if (versionMeta?.publishedAt)
    provenance.publishedAt = text(versionMeta.publishedAt, 64);
  if (versionMeta?.updatedAt)
    provenance.updatedAt = text(versionMeta.updatedAt, 64);
  if (versionMeta?.isLatest !== undefined)
    provenance.isLatest = String(versionMeta.isLatest);
  if (versionMeta?.statusMessage)
    provenance.statusMessage = text(versionMeta.statusMessage, 200);
  if (meta?.isOfficial !== undefined)
    provenance.isOfficialFlag = String(meta.isOfficial);
  if (typeof meta?.visitorsEstimateLastFourWeeks === "number")
    provenance.visitorsLastFourWeeks = String(
      Math.trunc(meta.visitorsEstimateLastFourWeeks),
    );
  const repository = safeUrl(entry.server.repository?.url);
  if (repository) provenance.repositoryUrl = repository;
  const status = versionMeta?.status;
  return {
    identity: {
      ecosystem: PULSEMCP_ECOSYSTEM,
      authorityNamespace: namespace,
      nativeId: name,
      nativeVersion: entry.server.version ?? PULSEMCP_UNVERSIONED,
    },
    displayName: text(entry.server.title ?? name, 200),
    description: text(entry.server.description, 500),
    provenance,
    status:
      status === "active" || status === "deprecated" || status === "deleted"
        ? status
        : "unknown",
  };
}

/** One native PulseMCP listing as a normalized, non-executable description. */
export async function normalizePulseMcpServer(input: {
  server: PulseMcpServer;
  sourceRef: string;
}): Promise<NormalizedDefinition> {
  const { server, sourceRef } = input;
  const issues: CompatibilityIssue[] = [];
  const identity = pulseMcpIdentity(server.name);
  const declaredServers: Array<{ url: string; status: "declared" }> = [];
  const authentication: AuthenticationProfile[] = [];
  (server.remotes ?? []).forEach((remote, index) => {
    const pointer = `/remotes/${index}`;
    const direct = safeUrl(remote.url_direct);
    if (direct && !declaredServers.some((item) => item.url === direct))
      declaredServers.push({ url: direct, status: "declared" });
    const method = (remote.authentication_method ?? "").toLowerCase();
    if (method === "none" || method === "open")
      authentication.push({
        id: `remote-${index}-none`,
        label: "No credential declared",
        kind: "none",
        reason: "public",
      });
    else if (method)
      authentication.push({
        id: `remote-${index}-native`,
        label: `Declared authentication: ${text(remote.authentication_method, 60)}`,
        kind: "unsupported",
        native: text(remote.authentication_method, 120) || "unknown",
      });
    if (method && method !== "none" && method !== "open")
      issues.push(
        issue(
          "pulsemcp.auth.native-declaration",
          "security",
          "authorize",
          "unsupported",
          "blocking",
          "blocks-authorization",
          pointer,
          "PulseMCP names an authentication method as free text; it is preserved for review and cannot be executed from this description alone.",
        ),
      );
  });
  if (!server.remotes?.length)
    issues.push(
      issue(
        "pulsemcp.remote.none-declared",
        "structure",
        "invoke",
        "unsupported",
        "warning",
        "none",
        "/remotes",
        "This listing declares no remote endpoint; it describes a package a host would have to run itself.",
      ),
    );
  if (server.package_name || server.package_registry)
    issues.push(
      issue(
        "pulsemcp.package.not-approved",
        "policy",
        "invoke",
        "unsupported",
        "warning",
        "none",
        "/package_name",
        "Package coordinates are provenance only: importing this listing installs nothing and approves no package.",
      ),
    );
  if (server.EXPERIMENTAL_ai_generated_description)
    issues.push(
      issue(
        "pulsemcp.description.machine-generated",
        "structure",
        "import",
        "adapted",
        "info",
        "none",
        "/EXPERIMENTAL_ai_generated_description",
        "PulseMCP's experimental machine-written description is kept as native data and is not used as the connector's description.",
      ),
    );
  issues.push(
    issue(
      "pulsemcp.version.not-exposed",
      "version",
      "import",
      "adapted",
      "info",
      "none",
      "/name",
      "PulseMCP's native listing exposes no server version; the identity records this rather than inventing one.",
    ),
  );
  const service = server.name
    .split("/")
    .pop()!
    .toLowerCase()
    .replace(/[^a-z0-9._-]/g, "-");
  const body = {
    schemaVersion: 1 as const,
    definitionRef: `pulsemcp:definition:${(await sourceIdentityDigest(identity)).slice(0, 32)}`,
    identity,
    sourceRef,
    importer: { id: PULSEMCP_IMPORTER_ID, version: PULSEMCP_IMPORTER_VERSION },
    display: {
      name: text(server.name, 200),
      description: text(server.short_description, 500),
      ecosystem: PULSEMCP_ECOSYSTEM,
      ...(serviceKey.test(service) ? { service } : {}),
    },
    authentication,
    configuration: [],
    capabilities: [],
    events: [],
    declaredServers,
    compatibility: {
      issues,
      dimensions: completeDimensions({
        discover: "exact",
        import: "adapted",
        authorize: declaredServers.length
          ? "requires-configuration"
          : "unsupported",
        invoke: "unsupported",
        export: "unsupported",
      }),
    },
    nativeExtensions: {
      pulsemcp: {
        apiProfile: "v0beta",
        name: server.name,
        ...(safeUrl(server.url) ? { url: safeUrl(server.url) } : {}),
        ...(safeUrl(server.external_url)
          ? { externalUrl: safeUrl(server.external_url) }
          : {}),
        ...(safeUrl(server.source_code_url)
          ? { sourceCodeUrl: safeUrl(server.source_code_url) }
          : {}),
        ...(typeof server.github_stars === "number"
          ? { githubStars: Math.trunc(server.github_stars) }
          : {}),
        ...(server.package_registry
          ? { packageRegistry: text(server.package_registry, 64) }
          : {}),
        ...(server.package_name
          ? { packageName: text(server.package_name, 200) }
          : {}),
        ...(typeof server.package_download_count === "number"
          ? { packageDownloadCount: Math.trunc(server.package_download_count) }
          : {}),
        ...(server.EXPERIMENTAL_ai_generated_description
          ? {
              experimentalAiGeneratedDescription: text(
                server.EXPERIMENTAL_ai_generated_description,
                4096,
              ),
            }
          : {}),
        remotes: (server.remotes ?? []).map((remote) => ({
          ...(safeUrl(remote.url_direct)
            ? { urlDirect: safeUrl(remote.url_direct) }
            : {}),
          ...(safeUrl(remote.url_setup)
            ? { urlSetup: safeUrl(remote.url_setup) }
            : {}),
          ...(remote.transport
            ? { transport: text(remote.transport, 64) }
            : {}),
          ...(remote.authentication_method
            ? {
                authenticationMethod: text(remote.authentication_method, 64),
              }
            : {}),
          ...(remote.cost ? { cost: text(remote.cost, 64) } : {}),
        })),
        integrations: (server.integrations ?? []).slice(0, 64).map((item) => ({
          name: text(item.name, 200),
          slug: text(item.slug, 200),
          ...(safeUrl(item.url) ? { url: safeUrl(item.url) } : {}),
        })),
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

export function pulseMcpSourceRecord(input: {
  bytes: Uint8Array;
  name: string;
  origin: SourceRecord["origin"];
  capturedAt: string;
}): SourceRecord {
  const digest = createHash("sha256").update(input.bytes).digest("hex");
  return sourceRecordSchema.parse({
    sourceRef: `pulsemcp:source:${digest.slice(0, 32)}`,
    identity: pulseMcpIdentity(input.name),
    format: { name: "pulsemcp-server", version: "v0beta" },
    origin: input.origin,
    digest: { algorithm: "sha256", value: digest },
    byteLength: input.bytes.byteLength,
    mediaType: "application/json",
    capturedAt: input.capturedAt,
    license: { redistributable: "unknown" },
    adaptation: [],
    overlays: [],
  });
}
