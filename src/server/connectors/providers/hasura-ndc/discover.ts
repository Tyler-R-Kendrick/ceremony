import {
  canonicalDigest,
  compatibilityIssueSchema,
  completeDimensions,
  DEFINITION_LIMITS,
  nativeIdentifierSchema,
  normalizedDefinitionSchema,
  safeTextSchema,
  type CompatibilityIssue,
  type NativeCapability,
  type NormalizedDefinition,
} from "../../../../core/connectors/index.js";
import { ConnectorError } from "../../errors.js";
import {
  hasNdcCapability,
  ndcCapabilitiesResponseSchema,
  ndcCapabilityPaths,
  ndcSchemaResponseSchema,
  ndcVersionCompatible,
  NDC_PINNED_VERSION,
  NDC_PROFILE,
  type NdcCapabilitiesResponse,
  type NdcSchemaResponse,
} from "./spec.js";

/*
 * Discovery reads a connector's own /capabilities and /schema and preserves
 * them. It does not translate NDC into anything else: collections stay
 * collections, functions stay functions, procedures stay procedures, scalar
 * types keep their representations, comparison operators and aggregate
 * functions, and relationships keep their foreign keys. What a version-specific
 * capability declares is recorded as declared — Ceremony reports the
 * connector's own answer rather than assuming a feature set.
 */

export const NDC_IMPORTER = {
  id: "hasura-ndc-discovery",
  version: "2026.09.18",
} as const;

export interface NdcClient {
  capabilities(): Promise<unknown>;
  schema(): Promise<unknown>;
  health?(): Promise<{ ok: boolean }>;
}

export type NdcDiscovery = {
  version: string;
  versionCompatible: boolean;
  capabilities: NdcCapabilitiesResponse["capabilities"];
  declaredCapabilities: string[];
  schema: NdcSchemaResponse;
  definition: NormalizedDefinition;
  issues: CompatibilityIssue[];
  health?: { ok: boolean };
};

export type DiscoverNdcOptions = {
  /** The spec version this host implements; a connector outside its range is reported. */
  requestedVersion?: string;
  authorityNamespace?: string;
  nativeId?: string;
  display?: { name?: string; description?: string };
  definitionRef?: string;
  sourceRef?: string;
};

const issue = (input: CompatibilityIssue): CompatibilityIssue =>
  compatibilityIssueSchema.parse(input);

const trim = (value: string | undefined, max = 500) =>
  value === undefined ? undefined : value.replace(/[\p{Cc}]/gu, " ").slice(0, max);

/**
 * Reads /capabilities and /schema, validates the declared spec version, and
 * projects both into a normalized definition whose capabilities are the
 * connector's collections (kind `query`), functions (kind `query`) and
 * procedures (kind `action`). Every native document travels intact under
 * `nativeExtensions` so a binding is reviewed against what the connector
 * actually said, not a lossy summary.
 */
export async function discoverNdc(
  client: NdcClient,
  options: DiscoverNdcOptions = {},
): Promise<NdcDiscovery> {
  const requested = options.requestedVersion ?? NDC_PINNED_VERSION;
  const capabilitiesParsed = ndcCapabilitiesResponseSchema.safeParse(
    await client.capabilities(),
  );
  if (!capabilitiesParsed.success)
    throw new ConnectorError("upstream-rejected", {
      detail: "ndc.capabilities.invalid",
    });
  const { version, capabilities } = capabilitiesParsed.data;
  const versionCompatible = ndcVersionCompatible(version, requested);

  const issues: CompatibilityIssue[] = [];
  if (!versionCompatible)
    issues.push(
      issue({
        code: "ndc.version.incompatible",
        category: "version",
        sourcePointer: "/capabilities/version",
        dimension: "invoke",
        disposition: "unsupported",
        severity: "blocking",
        executionImpact: "blocks-definition",
        message: `The connector declares a specification version outside the pinned compatible range ^${requested}.`,
        remediation:
          "Pin a binding to a connector implementing the supported specification range.",
      }),
    );

  const schemaParsed = ndcSchemaResponseSchema.safeParse(await client.schema());
  if (!schemaParsed.success)
    throw new ConnectorError("upstream-rejected", {
      detail: "ndc.schema.invalid",
    });
  const schema = schemaParsed.data;

  const declaredCapabilities = ndcCapabilityPaths.filter((path) =>
    hasNdcCapability(capabilities, path),
  );

  const capabilityList: NativeCapability[] = [];
  const push = (
    kind: NativeCapability["kind"],
    nativeId: string,
    description: string | undefined,
    effect: NativeCapability["effect"],
    extensionKey: string,
    extension: unknown,
    pointer: string,
  ) => {
    const safeId = nativeIdentifierSchema.safeParse(nativeId);
    if (!safeId.success) {
      issues.push(
        issue({
          code: "ndc.name.rejected",
          category: "structure",
          sourcePointer: pointer,
          dimension: "invoke",
          disposition: "rejected",
          severity: "blocking",
          executionImpact: "blocks-operation",
          message: "A schema element name cannot be represented safely.",
        }),
      );
      return;
    }
    const label = safeTextSchema.max(200).safeParse(nativeId);
    const summary = safeTextSchema.safeParse(trim(description) ?? "");
    capabilityList.push({
      kind,
      nativeId: safeId.data,
      ...(label.success && label.data ? { label: label.data } : {}),
      ...(summary.success && summary.data ? { summary: summary.data } : {}),
      effect,
      dataClassification: "unknown",
      cost: "unknown",
      nativeExtensions: { [extensionKey]: extension },
    });
  };

  for (const [index, collection] of schema.collections.entries())
    push(
      "query",
      collection.name,
      collection.description,
      "read",
      "ndc.collection",
      collection,
      `/schema/collections/${index}`,
    );
  for (const [index, fn] of schema.functions.entries())
    push(
      "query",
      fn.name,
      fn.description,
      "read",
      "ndc.function",
      fn,
      `/schema/functions/${index}`,
    );
  for (const [index, procedure] of schema.procedures.entries())
    push(
      "action",
      procedure.name,
      procedure.description,
      "write",
      "ndc.procedure",
      procedure,
      `/schema/procedures/${index}`,
    );

  if (capabilityList.length > DEFINITION_LIMITS.capabilities)
    throw new ConnectorError("invalid-request", {
      detail: "ndc.schema.too-large",
    });

  if (!hasNdcCapability(capabilities, "relationships"))
    issues.push(
      issue({
        code: "ndc.relationships.undeclared",
        category: "schema",
        sourcePointer: "/capabilities/capabilities/relationships",
        dimension: "invoke",
        disposition: "unsupported",
        severity: "warning",
        executionImpact: "blocks-operation",
        message:
          "The connector declares no relationship capability; queries traversing relationships are refused before submission.",
      }),
    );
  if (!schema.procedures.length)
    issues.push(
      issue({
        code: "ndc.procedures.absent",
        category: "schema",
        sourcePointer: "/schema/procedures",
        dimension: "invoke",
        disposition: "unsupported",
        severity: "info",
        executionImpact: "none",
        message: "The connector declares no procedures; mutations are unavailable.",
      }),
    );

  const body = {
    schemaVersion: 1 as const,
    identity: {
      ecosystem: "hasura-ndc",
      authorityNamespace: options.authorityNamespace ?? "",
      nativeId: options.nativeId ?? "ndc-connector",
      nativeVersion: version,
    },
    importer: { ...NDC_IMPORTER },
    display: {
      name: options.display?.name ?? "Hasura NDC connector",
      description:
        options.display?.description ??
        `Native Data Connector declaring specification ${version}; ${schema.collections.length} collections, ${schema.functions.length} functions, ${schema.procedures.length} procedures.`,
      ecosystem: "hasura-ndc",
      service: "hasura-ndc",
    },
    authentication: [
      {
        id: "ndc-service-token",
        label: "Connector service token",
        kind: "http-bearer" as const,
      },
    ],
    configuration: [],
    capabilities: capabilityList,
    events: [],
    declaredServers: [],
    compatibility: {
      issues,
      dimensions: completeDimensions({
        discover: "exact",
        import: "exact",
        configure: "requires-configuration",
        verify: "requires-configuration",
        invoke: versionCompatible ? "requires-configuration" : "unsupported",
        export: "exact",
        disconnect: "exact",
      }),
    },
    nativeExtensions: {
      "ndc.version": version,
      "ndc.requestedVersion": requested,
      "ndc.capabilities": capabilities,
      "ndc.declaredCapabilities": declaredCapabilities,
      "ndc.scalar_types": schema.scalar_types,
      "ndc.object_types": schema.object_types,
      ...(schema.capabilities === undefined
        ? {}
        : { "ndc.schema.capabilities": schema.capabilities }),
    },
  };
  const normalizedDigest = await canonicalDigest(body);
  const parsed = normalizedDefinitionSchema.safeParse({
    ...body,
    definitionRef:
      options.definitionRef ?? `def:ndc:${normalizedDigest.slice(0, 32)}`,
    sourceRef: options.sourceRef ?? `src:ndc:${normalizedDigest.slice(0, 32)}`,
    normalizedDigest,
  });
  if (!parsed.success)
    throw new ConnectorError("invalid-request", { detail: "ndc.schema.limits" });

  const health = client.health ? await client.health() : undefined;
  return {
    version,
    versionCompatible,
    capabilities,
    declaredCapabilities: [...declaredCapabilities],
    schema,
    definition: parsed.data,
    issues: parsed.data.compatibility.issues,
    ...(health ? { health } : {}),
  };
}

export { NDC_PROFILE };
