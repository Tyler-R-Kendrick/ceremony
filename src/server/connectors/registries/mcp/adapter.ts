import { createHash } from "node:crypto";
import { z } from "zod";
import type {
  CompatibilityIssue,
  ConfigurationRequirement,
} from "../../../../core/connectors/contracts.js";
import type { EvidenceLevel } from "../../../../core/connectors/identity.js";
import { identifierSchema } from "../../../../core/operation-contracts.js";
import {
  capabilityStatus,
  type AdapterCallContext,
  type ConnectorAdapter,
  type DiscoverInput,
  type DiscoverResult,
  type DiscoveredItem,
  type ExportOutcome,
  type ExportRequest,
  type ImportInput,
  type ImportOutcome,
} from "../../adapter.js";
import {
  runtimeBindingSchema,
  type ApprovedDestination,
  type RuntimeBinding,
} from "../../binding.js";
import { ConnectorError } from "../../errors.js";
import {
  createMcpRegistryClient,
  registryBaseUrlForDestination,
  type McpRegistryLimits,
  type RegistryEntry,
} from "./client.js";
import {
  exportServerJson,
  implementationEvidenceSchema,
  publicationRequestSchema,
} from "./export.js";
import {
  SERVER_JSON_IMPORT_LIMITS,
  importServerJson,
  serverJsonSourceRecord,
  type ServerJsonImport,
} from "./import.js";
import { parseBoundedJsonBytes } from "./json.js";
import {
  MCP_REGISTRY_ADAPTER_VERSION,
  MCP_REGISTRY_API_PROFILE,
  MCP_REGISTRY_OFFICIAL_META_KEY,
  SERVER_JSON_PROFILE,
  type RegistryOfficialMeta,
  type RegistryStatus,
  type ServerJson,
} from "./schemas.js";
import type {
  RegistryIndexRow,
  RegistrySnapshotStore,
  RegistrySnapshotView,
} from "./snapshot.js";

/*
 * The registry as a connector adapter: catalog only. It discovers and imports
 * descriptions and can export a description of something this deployment
 * actually serves. It cannot authorize, invoke or configure anything, because
 * a registry entry is a description of a server, not a server; execution
 * belongs to an MCP binding made by the MCP runtime adapter. The base URL
 * comes from the binding's approved destination, never from input, and a
 * private source's bearer token is read through the configuration port at
 * call time and never stored on the adapter.
 */

export const MCP_REGISTRY_ADAPTER_ID = "mcp-registry";
export const MCP_REGISTRY_TOKEN_CONFIGURATION = "MCP_REGISTRY_TOKEN";

/** `binding.settings.registrySource`: which approved destination is the registry and how to authenticate to it. */
export const registrySourceSettingsSchema = z.strictObject({
  destinationId: identifierSchema,
  authorization: z
    .strictObject({
      kind: z.literal("bearer"),
      configurationName: z.string().regex(/^[A-Z][A-Z0-9_]{0,95}$/),
    })
    .optional(),
});

/** `binding.settings.export`: the approved MCP binding and evidence an export describes. Host-approved, never caller-supplied. */
export const registryExportSettingsSchema = z.strictObject({
  mcpBinding: runtimeBindingSchema,
  implementationEvidence: implementationEvidenceSchema,
  publication: publicationRequestSchema,
});

export type ResolvedRegistrySource = {
  destination: ApprovedDestination;
  baseUrl: string;
  configurationName?: string;
};

/** The registry source a binding approves; absence is a policy failure, not a lookup miss. */
export function registrySourceFromBinding(binding: RuntimeBinding): ResolvedRegistrySource {
  const raw = binding.settings["registrySource"];
  let destinationId: string | undefined;
  let configurationName: string | undefined;
  if (raw !== undefined) {
    const parsed = registrySourceSettingsSchema.safeParse(raw);
    if (!parsed.success)
      throw new ConnectorError("invalid-request", { detail: "registry.settings.invalid" });
    destinationId = parsed.data.destinationId;
    configurationName = parsed.data.authorization?.configurationName;
  } else if (binding.destinations.length === 1) {
    destinationId = binding.destinations[0]!.id;
  }
  const destination = binding.destinations.find((item) => item.id === destinationId);
  if (!destination)
    throw new ConnectorError("network-policy", {
      detail: "registry.destination-unapproved",
    });
  return {
    destination,
    baseUrl: registryBaseUrlForDestination(destination),
    ...(configurationName ? { configurationName } : {}),
  };
}

const clip = (value: string, max: number) => {
  const clean = value.replace(/\p{Cc}/gu, " ");
  return clean.length > max ? `${clean.slice(0, max - 1)}…` : clean;
};

function provenanceOf(
  sourceId: string,
  server: Pick<ServerJson, "$schema">,
  status: RegistryStatus,
  official: RegistryOfficialMeta | undefined,
): Record<string, string> {
  return {
    source: sourceId,
    registryStatus: status,
    /** The registry authenticated the publisher's namespace; that says nothing about the code. */
    namespaceAuthentication: official ? "registry-attested" : "unknown",
    schema: server.$schema ?? "unspecified",
    ...(official?.isLatest === undefined ? {} : { isLatest: String(official.isLatest) }),
    ...(official?.publishedAt ? { publishedAt: official.publishedAt } : {}),
    ...(official?.updatedAt ? { updatedAt: official.updatedAt } : {}),
    ...(official?.statusChangedAt ? { statusChangedAt: official.statusChangedAt } : {}),
  };
}

function itemFromEntry(entry: RegistryEntry, sourceId: string): DiscoveredItem {
  return {
    identity: entry.identity,
    displayName: clip(entry.server.title ?? entry.server.name, 200),
    description: clip(entry.server.description, 500),
    provenance: provenanceOf(sourceId, entry.server, entry.status, entry.official),
    status: entry.status,
  };
}

const encodeCursor = (digest: string) => Buffer.from(digest, "hex").toString("base64url");
const decodeCursor = (cursor: string) => {
  const digest = Buffer.from(cursor, "base64url").toString("hex");
  if (!/^[a-f0-9]{64}$/.test(digest) || encodeCursor(digest) !== cursor)
    throw new ConnectorError("invalid-request", { detail: "registry.cursor.invalid" });
  return digest;
};

async function itemsFromSnapshot(
  view: RegistrySnapshotView,
  input: { query?: string; cursor?: string; limit: number },
): Promise<Pick<DiscoverResult, "items" | "nextCursor">> {
  const search = input.query?.toLowerCase();
  const rows = view.rows.filter(
    (row: RegistryIndexRow) => !search || row.name.toLowerCase().includes(search),
  );
  let start = 0;
  if (input.cursor !== undefined) {
    const digest = decodeCursor(input.cursor);
    const index = rows.findIndex((row) => row.identityDigest === digest);
    if (index < 0)
      throw new ConnectorError("invalid-request", { detail: "registry.cursor.stale" });
    start = index + 1;
  }
  const slice = rows.slice(start, start + input.limit);
  const items: DiscoveredItem[] = [];
  for (const row of slice) {
    const entry = await view.entry(row.identityDigest);
    if (!entry) continue;
    items.push({
      identity: entry.identity,
      displayName: clip(entry.server.title ?? entry.server.name, 200),
      description: clip(entry.server.description, 500),
      provenance: {
        ...provenanceOf(view.sourceId, entry.server, row.status, entry.official),
        ...(row.tombstone ? { tombstone: row.tombstone.reason } : {}),
        ...(Object.hasOwn(view.pins, row.identityDigest) ? { pinned: "true" } : {}),
      },
      status: row.tombstone ? "deleted" : row.status,
    });
  }
  const last = slice.at(-1);
  return {
    items,
    ...(start + slice.length < rows.length && last
      ? { nextCursor: encodeCursor(last.identityDigest) }
      : {}),
  };
}

/** A registry response pasted or fetched whole: unwrap `{ server, _meta }` into the document and its official metadata. */
export function unwrapRegistryResponse(document: unknown): {
  server: unknown;
  official: unknown;
} {
  if (
    document &&
    typeof document === "object" &&
    !Array.isArray(document) &&
    "server" in document &&
    !("name" in document)
  ) {
    const wrapped = document as { server: unknown; _meta?: unknown };
    const meta = wrapped._meta;
    const official =
      meta && typeof meta === "object" && !Array.isArray(meta)
        ? (meta as Record<string, unknown>)[MCP_REGISTRY_OFFICIAL_META_KEY]
        : undefined;
    return { server: wrapped.server, official };
  }
  return { server: document, official: undefined };
}

/** Imports an entry already read from a registry, with the registry as its origin. */
export async function importRegistryEntry(
  entry: Pick<RegistryEntry, "server"> & { official?: RegistryOfficialMeta },
  provenance: { sourceRef: string; baseUrl: string; sourceId?: string; capturedAt?: string },
): Promise<ServerJsonImport> {
  return importServerJson(entry.server, {
    sourceRef: provenance.sourceRef,
    origin: { kind: "registry", location: provenance.baseUrl },
    ...(entry.official ? { official: entry.official } : {}),
    ...(provenance.sourceId ? { sourceId: provenance.sourceId } : {}),
    ...(provenance.capturedAt ? { capturedAt: provenance.capturedAt } : {}),
  });
}

export type McpRegistryAdapterOptions = {
  /** Durable snapshots; without one, discovery is always live against the approved destination. */
  snapshots?: RegistrySnapshotStore;
  limits?: Partial<McpRegistryLimits>;
  /** Evidence level the deployment has measured for this adapter; fixture evidence by default. */
  evidence?: EvidenceLevel;
};

const configuration: ConfigurationRequirement[] = [
  {
    name: MCP_REGISTRY_TOKEN_CONFIGURATION,
    source: "host",
    classification: "secret",
    required: false,
    description:
      "Bearer token for a private registry source; the public official registry needs none",
  },
];

const exportFormats = new Set([
  "server.json",
  "mcp-registry/server.json",
  "application/vnd.modelcontextprotocol.server+json",
]);

export function createMcpRegistryAdapter(
  options: McpRegistryAdapterOptions = {},
): ConnectorAdapter {
  const evidence = options.evidence ?? "protocol-fixture";
  const identity = {
    adapterVersion: MCP_REGISTRY_ADAPTER_VERSION,
    runtime: "hosted-server" as const,
  };
  const unsupported = (
    dimension: CompatibilityIssue["dimension"],
    limitation: string,
  ) =>
    capabilityStatus(identity, {
      dimension,
      profile: MCP_REGISTRY_API_PROFILE,
      implementation: "unsupported",
      limitations: [limitation],
    });
  const executionLimitation = "execution requires an MCP binding";

  const clientFor = (ctx: AdapterCallContext, source: ResolvedRegistrySource) =>
    createMcpRegistryClient({
      baseUrl: source.baseUrl,
      fetch: ctx.environment.fetch,
      ...(options.limits ? { limits: options.limits } : {}),
      ...(source.configurationName
        ? {
            bearer: () => ctx.environment.configuration.read(source.configurationName!),
          }
        : {}),
      now: ctx.environment.now,
    });

  const adapter: ConnectorAdapter = {
    id: MCP_REGISTRY_ADAPTER_ID,
    ecosystem: "mcp-registry",
    adapterVersion: MCP_REGISTRY_ADAPTER_VERSION,
    runtime: "hosted-server",
    displayName: "MCP Registry",
    description:
      "Discovers and imports server.json metadata from the official MCP registry or a configured subregistry. Catalog only: never a package runner or a trust oracle.",
    service: "mcp-registry",
    /*
     * The directory's `catalog-only` support level is reserved for entries that
     * implement nothing (`catalogEntrySchema` refuses an implemented capability
     * under it). This adapter really does talk to a registry, so it reports
     * `provider-backed` and says what it cannot do through its capability rows:
     * every execution dimension is `unsupported` with the limitation "execution
     * requires an MCP binding". Catalog-only is the *behaviour*, not the label.
     */
    support: "provider-backed",
    custody: ["no-credential", "host-owned"],
    configuration,
    profiles: [MCP_REGISTRY_API_PROFILE, SERVER_JSON_PROFILE],
    capabilities(present) {
      return [
        capabilityStatus(identity, {
          dimension: "discover",
          profile: MCP_REGISTRY_API_PROFILE,
          evidence,
          configuration: present.has(MCP_REGISTRY_TOKEN_CONFIGURATION)
            ? "ready"
            : "not-applicable",
          limitations: [
            "Bounded pagination (100 per page); registry status is provenance, not code safety",
          ],
        }),
        capabilityStatus(identity, {
          dimension: "import",
          profile: SERVER_JSON_PROFILE,
          evidence,
          limitations: [
            "Packages, arguments and environment values are imported as inert metadata",
          ],
        }),
        unsupported("configure", "configuration is bound by the MCP runtime adapter"),
        unsupported("authorize", executionLimitation),
        unsupported("verify", executionLimitation),
        unsupported("invoke", executionLimitation),
        unsupported("events", "registries publish no events; poll with updated_since"),
        unsupported("reconnect", executionLimitation),
        unsupported("disconnect", executionLimitation),
        unsupported("revoke", executionLimitation),
        capabilityStatus(identity, {
          dimension: "export",
          profile: SERVER_JSON_PROFILE,
          evidence,
          limitations: [
            "Only for an approved hosted MCP binding with served-endpoint evidence; packages are never exported",
          ],
        }),
        unsupported("delegate", executionLimitation),
      ];
    },
    async discover(ctx: AdapterCallContext, input: DiscoverInput): Promise<DiscoverResult> {
      const source = registrySourceFromBinding(ctx.binding);
      const client = clientFor(ctx, source);
      const limit = input.limit ?? 30;
      const snapshotLimit = 100;
      if (!Number.isInteger(limit) || limit < 1 || limit > snapshotLimit)
        throw new ConnectorError("invalid-request", { detail: "registry.limit.invalid" });
      if (input.query !== undefined && (input.query.length > 200 || /\p{Cc}/u.test(input.query)))
        throw new ConnectorError("invalid-request", { detail: "registry.search.invalid" });
      if (options.snapshots) {
        const snapshotSource = {
          id: source.destination.id,
          baseUrl: source.baseUrl,
          client,
        };
        if (input.refresh)
          await options.snapshots.refresh(ctx.actor.tenantId, snapshotSource, {
            signal: ctx.signal,
          });
        const view = await options.snapshots.read(ctx.actor.tenantId, source.destination.id);
        if (view) {
          const paged = await itemsFromSnapshot(view, {
            ...(input.query ? { query: input.query } : {}),
            ...(input.cursor ? { cursor: input.cursor } : {}),
            limit,
          });
          return {
            ...paged,
            freshness: {
              fetchedAt: view.freshness.fetchedAt,
              stale: view.freshness.stale,
              source: "snapshot",
            },
            issues: view.issues,
          };
        }
      }
      if (limit > client.limits.pageLimit)
        throw new ConnectorError("invalid-request", { detail: "registry.limit.invalid" });
      const page = await client.list(
        {
          ...(input.cursor ? { cursor: input.cursor } : {}),
          limit,
          ...(input.query ? { search: input.query } : {}),
        },
        { signal: ctx.signal },
      );
      return {
        items: page.entries.map((entry) => itemFromEntry(entry, source.destination.id)),
        ...(page.nextCursor ? { nextCursor: page.nextCursor } : {}),
        freshness: { fetchedAt: page.fetchedAt, stale: false, source: "live" },
        issues: page.issues,
      };
    },
    async import(ctx: AdapterCallContext, input: ImportInput): Promise<ImportOutcome> {
      if (input.bytes.byteLength > SERVER_JSON_IMPORT_LIMITS.bytes)
        throw new ConnectorError("invalid-request", { detail: "server-json.oversized" });
      const parsed = parseBoundedJsonBytes(input.bytes, SERVER_JSON_IMPORT_LIMITS.json);
      const unwrapped = unwrapRegistryResponse(parsed);
      const official =
        unwrapped.official ??
        input.metadata?.[MCP_REGISTRY_OFFICIAL_META_KEY] ??
        input.metadata?.["official"];
      const capturedAt = new Date(ctx.environment.now()).toISOString();
      const byteDigest = createHash("sha256").update(input.bytes).digest("hex");
      const sourceRef = `src:mcp-registry:${byteDigest}`;
      let sourceId: string | undefined;
      try {
        sourceId = registrySourceFromBinding(ctx.binding).destination.id;
      } catch {
        sourceId = undefined;
      }
      const imported = await importServerJson(unwrapped.server, {
        sourceRef,
        origin: input.origin,
        ...(official === undefined ? {} : { official }),
        ...(sourceId ? { sourceId } : {}),
        capturedAt,
      });
      const mediaType = input.mediaType.split(";")[0]!.trim() || "application/json";
      const source = await serverJsonSourceRecord({
        sourceRef,
        identity: imported.identity,
        origin: input.origin,
        bytes: input.bytes,
        mediaType,
        capturedAt,
        schemaVersion: imported.schema.version,
        normalizedDigest: imported.definition.normalizedDigest,
      });
      return {
        source,
        definitions: [imported.definition],
        issues: imported.issues,
        executableCandidates: imported.executableCandidates,
      };
    },
    async export(ctx: AdapterCallContext, request: ExportRequest): Promise<ExportOutcome> {
      if (!exportFormats.has(request.format))
        throw new ConnectorError("unsupported", { detail: "export.format" });
      const raw = ctx.binding.settings["export"];
      if (raw === undefined)
        throw new ConnectorError("unsupported", { detail: "export.requires-mcp-binding" });
      const settings = registryExportSettingsSchema.safeParse(raw);
      if (!settings.success)
        throw new ConnectorError("invalid-request", { detail: "export.settings.invalid" });
      if (settings.data.mcpBinding.tenantId !== ctx.actor.tenantId)
        throw new ConnectorError("denied", { detail: "export.tenant-mismatch" });
      const result = exportServerJson({
        definition: request.definition,
        binding: settings.data.mcpBinding,
        implementationEvidence: settings.data.implementationEvidence,
        publication: settings.data.publication,
        now: ctx.environment.now,
      });
      const losses = [...result.losses];
      if (request.includeNativeExtensions)
        losses.push({
          code: "structure.native-extensions-omitted",
          category: "structure",
          sourcePointer: "nativeExtensions",
          dimension: "export",
          disposition: "unsupported",
          severity: "info",
          executionImpact: "none",
          message: "server.json carries no native extensions; none were exported",
        });
      return { mediaType: result.mediaType, bytes: result.bytes, losses };
    },
  };
  return adapter;
}
