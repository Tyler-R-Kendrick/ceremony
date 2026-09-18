import { z } from "zod";
import {
  canonicalConnectorJson,
  catalogEntrySchema,
  compatibilityIssueSchema,
  normalizedDefinitionSchema,
  publicCatalogProjection,
  sourceRecordSchema,
  strongestEvidence,
  type CatalogEntry,
  type CompatibilityIssue,
  type EventDescriptor,
  type NativeCapability,
  type NormalizedDefinition,
  type SourceRecord,
} from "../../../../core/connectors/index.js";
import type {
  AdapterCallContext,
  ConnectorAdapter,
  DiscoverInput,
  DiscoverResult,
  DiscoveredItem,
  ImportInput,
  ImportOutcome,
} from "../../adapter.js";
import { ConnectorError } from "../../errors.js";
import {
  resolveNango,
  sha256,
  type NangoRuntime,
  type Resolved,
} from "./context.js";
import {
  integrationFullSchema,
  NANGO_CONFIGURATION,
  NANGO_LIMITS,
  NANGO_PROFILE_IDS,
  nangoEnvironmentSchema,
  nangoFunctionSchema,
  type NangoFunction,
  type NangoIntegration,
} from "./schemas.js";

/*
 * Discovery reads what the Nango environment actually has: integrations
 * (`unique_key` is the identity; `provider` is a display family shared by any
 * number of integrations) and the functions deployed to each of them. Import
 * turns a captured API snapshot into a normalized description. There is no
 * YAML reader here: `nango.yaml` is a deprecated authoring format, and the
 * current source of truth for deployed syncs and actions is the API.
 */

export const NANGO_SNAPSHOT_FORMAT = "nango-api-snapshot";
export const NANGO_IMPORTER_VERSION = "1.0.0";
const SNAPSHOT_BYTES = 4 * 1024 * 1024;
const FUNCTION_PAGES = 50;

export const nangoSnapshotSchema = z.strictObject({
  format: z.literal(NANGO_SNAPSHOT_FORMAT),
  version: z.literal(1),
  apiOrigin: z.string().max(2048),
  environment: nangoEnvironmentSchema,
  capturedAt: z.iso.datetime({ offset: true }),
  integration: integrationFullSchema,
  functions: z.array(nangoFunctionSchema).max(5000),
});
export type NangoSnapshot = z.infer<typeof nangoSnapshotSchema>;

const clean = (value: string | undefined, max = 500) =>
  (value ?? "")
    .replace(/[\p{Cc}‪-‮⁦-⁩]/gu, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, max);

const namespaceFor = (environment: string, apiOrigin: string) =>
  `${environment}@${apiOrigin}`;

function integrationItem(
  integration: NangoIntegration,
  resolved: Pick<Resolved, "environment" | "api">,
): DiscoveredItem {
  return {
    identity: {
      ecosystem: "nango",
      authorityNamespace: namespaceFor(resolved.environment, resolved.api.origin),
      nativeId: integration.unique_key,
      nativeVersion: integration.updated_at,
    },
    displayName: clean(integration.display_name, 200) || integration.unique_key,
    description: clean(
      `Nango integration ${integration.unique_key} (provider ${integration.provider}) in environment ${resolved.environment}`,
    ),
    provenance: {
      kind: "integration",
      provider: integration.provider,
      environment: resolved.environment,
      uniqueKey: integration.unique_key,
      forwardWebhooks: String(integration.forward_webhooks === true),
      createdAt: integration.created_at,
    },
    status: "active",
  };
}

function functionItem(
  uniqueKey: string,
  fn: NangoFunction,
  resolved: Pick<Resolved, "environment" | "api">,
): DiscoveredItem {
  return {
    identity: {
      ecosystem: "nango",
      authorityNamespace: namespaceFor(resolved.environment, resolved.api.origin),
      nativeId: `${uniqueKey}/functions/${fn.type}/${fn.name}`,
      nativeVersion: fn.last_deployed,
    },
    displayName: clean(fn.name, 200),
    description: clean(fn.description) || `${fn.type} function ${fn.name}`,
    provenance: {
      kind: "function",
      type: fn.type,
      integration: uniqueKey,
      enabled: String(fn.enabled),
      source: fn.source,
      lastDeployed: fn.last_deployed,
      ...(fn.type === "sync" ? { runs: fn.runs ?? "" } : {}),
      ...(fn.type === "on-event" ? { event: fn.event } : {}),
    },
    status: fn.enabled ? "active" : "deprecated",
  };
}

/**
 * An opaque continuation. It carries the page size as well as the page
 * number, so resuming with a different caller-supplied limit cannot skip or
 * repeat rows; the cursor alone determines the next page.
 */
const cursorSchema = z.strictObject({
  integration: z.string().max(512).optional(),
  page: z.number().int().nonnegative(),
  limit: z.number().int().min(1).max(NANGO_LIMITS.pageLimit),
});
const encodeCursor = (value: z.infer<typeof cursorSchema>) =>
  Buffer.from(JSON.stringify(value)).toString("base64url");
function decodeCursor(cursor: string | undefined) {
  if (!cursor) return undefined;
  try {
    return cursorSchema.parse(
      JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")),
    );
  } catch {
    throw new ConnectorError("invalid-request", { detail: "nango.discover.cursor" });
  }
}

/** NG-01: integrations and, per integration, its deployed functions. */
export async function discoverNango(
  runtime: NangoRuntime,
  ctx: AdapterCallContext,
  input: DiscoverInput,
): Promise<DiscoverResult> {
  const resolved = await resolveNango(runtime, ctx);
  const cursor = decodeCursor(input.cursor);
  const limit =
    cursor?.limit ?? Math.min(Math.max(input.limit ?? 50, 1), NANGO_LIMITS.pageLimit);
  const fetchedAt = ctx.environment.now();
  const scopeIntegration = input.scope?.integration ?? cursor?.integration;
  if (scopeIntegration !== undefined) {
    if (cursor?.integration !== undefined && cursor.integration !== scopeIntegration)
      throw new ConnectorError("invalid-request", { detail: "nango.discover.cursor" });
    const page = cursor?.page ?? 0;
    const integration = await resolved.client.getIntegration(scopeIntegration);
    const functions = await resolved.client.listFunctions(scopeIntegration, {
      page,
      limit,
    });
    const items: DiscoveredItem[] = [
      ...(page === 0 ? [integrationItem(integration.data, resolved)] : []),
      ...functions.data.map((fn) => functionItem(scopeIntegration, fn, resolved)),
    ];
    const more =
      (functions.pagination.page + 1) * functions.pagination.limit <
      functions.pagination.total;
    return {
      items,
      ...(more
        ? {
            nextCursor: encodeCursor({
              integration: scopeIntegration,
              page: page + 1,
              limit,
            }),
          }
        : {}),
      freshness: { fetchedAt, stale: false, source: "live" },
      issues: [],
    };
  }
  const list = await resolved.client.listIntegrations();
  const query = input.query?.toLowerCase();
  const matching = list.data.filter(
    (integration) =>
      !query ||
      integration.unique_key.toLowerCase().includes(query) ||
      integration.display_name.toLowerCase().includes(query) ||
      integration.provider.toLowerCase().includes(query),
  );
  const offset = (cursor?.page ?? 0) * limit;
  const pageItems = matching.slice(offset, offset + limit);
  return {
    items: pageItems.map((integration) => integrationItem(integration, resolved)),
    ...(offset + limit < matching.length
      ? { nextCursor: encodeCursor({ page: (cursor?.page ?? 0) + 1 }) }
      : {}),
    freshness: { fetchedAt, stale: false, source: "live" },
    issues: [],
  };
}

/**
 * Captures the current integration and all of its deployed functions through
 * the API as an importable snapshot. Credentials are never requested
 * (`include=credentials` is not sent), so the bytes are safe to retain as a
 * source artifact.
 */
export async function captureNangoIntegration(
  runtime: NangoRuntime,
  ctx: AdapterCallContext,
  uniqueKey: string,
): Promise<ImportInput & { snapshot: NangoSnapshot }> {
  const resolved = await resolveNango(runtime, ctx);
  const integration = await resolved.client.getIntegration(uniqueKey);
  const functions: NangoFunction[] = [];
  for (let page = 0; page < FUNCTION_PAGES; page++) {
    const result = await resolved.client.listFunctions(uniqueKey, {
      page,
      limit: NANGO_LIMITS.pageLimit,
    });
    functions.push(...result.data);
    if ((page + 1) * result.pagination.limit >= result.pagination.total) break;
  }
  const snapshot: NangoSnapshot = {
    format: NANGO_SNAPSHOT_FORMAT,
    version: 1,
    apiOrigin: resolved.api.origin,
    environment: resolved.environment,
    capturedAt: new Date(ctx.environment.now()).toISOString(),
    integration: integration.data,
    functions,
  };
  return {
    bytes: new TextEncoder().encode(JSON.stringify(snapshot)),
    mediaType: "application/json",
    origin: {
      kind: "provider-api",
      location: `${resolved.api.origin}/integrations/${encodeURIComponent(uniqueKey)}`,
    },
    snapshot,
  };
}

const issue = (input: {
  code: string;
  category: CompatibilityIssue["category"];
  pointer: string;
  dimension: CompatibilityIssue["dimension"];
  disposition: CompatibilityIssue["disposition"];
  severity: CompatibilityIssue["severity"];
  impact: CompatibilityIssue["executionImpact"];
  message: string;
  remediation?: string;
}): CompatibilityIssue =>
  compatibilityIssueSchema.parse({
    code: input.code,
    category: input.category,
    sourcePointer: input.pointer,
    dimension: input.dimension,
    disposition: input.disposition,
    severity: input.severity,
    executionImpact: input.impact,
    message: input.message,
    ...(input.remediation ? { remediation: input.remediation } : {}),
  });

const looksLikeYaml = (input: ImportInput) =>
  /yaml|yml/i.test(input.mediaType) ||
  /^\s*(integrations|models)\s*:/m.test(
    new TextDecoder().decode(input.bytes.subarray(0, 4096)),
  );

function capabilityFor(fn: NangoFunction, index: number): NativeCapability {
  const base = {
    nativeId: fn.name,
    label: clean(fn.name, 200) || fn.name,
    ...(clean(fn.description) ? { summary: clean(fn.description) } : {}),
    dataClassification: "unknown" as const,
    cost: "unknown" as const,
    authentication: [NANGO_PROFILE_IDS.proxy],
    ...(fn.json_schema && typeof fn.json_schema === "object"
      ? { inputSchemaRef: `#/functions/${index}/json_schema` }
      : {}),
  };
  const shared = {
    type: fn.type,
    enabled: fn.enabled,
    source: fn.source,
    lastDeployed: fn.last_deployed,
    ...(fn.scopes ? { scopes: fn.scopes.slice(0, 64) } : {}),
    ...(fn.input ? { input: fn.input } : {}),
    ...(fn.returns ? { returns: fn.returns.slice(0, 64) } : {}),
  };
  if (fn.type === "sync")
    return {
      kind: "sync",
      ...base,
      effect: "read",
      nativeExtensions: {
        ...shared,
        runs: fn.runs,
        autoStart: fn.auto_start,
        trackDeletes: fn.track_deletes,
      },
    };
  if (fn.type === "action")
    return { kind: "action", ...base, effect: "unknown", nativeExtensions: shared };
  return {
    kind: "custom",
    ...base,
    effect: "unknown",
    nativeExtensions: { ...shared, event: fn.event },
  };
}

/**
 * AC-NG-08: imports the current documented metadata (integration + deployed
 * functions) and refuses the legacy `nango.yaml` with a precise diagnostic
 * instead of parsing it.
 */
export async function importNango(
  ctx: AdapterCallContext,
  input: ImportInput,
): Promise<ImportOutcome> {
  if (input.bytes.byteLength > SNAPSHOT_BYTES)
    throw new ConnectorError("invalid-request", { detail: "nango.import.too-large" });
  const digest = sha256(Buffer.from(input.bytes).toString("latin1"));
  const capturedAt = new Date(ctx.environment.now()).toISOString();
  const sourceRef = `nango:src:${digest.slice(0, 32)}`;
  const baseSource = {
    sourceRef,
    origin: input.origin,
    digest: { algorithm: "sha256" as const, value: digest },
    byteLength: input.bytes.byteLength,
    mediaType: input.mediaType,
    capturedAt,
    adaptation: [],
    overlays: [],
  };
  if (looksLikeYaml(input)) {
    const source: SourceRecord = sourceRecordSchema.parse({
      ...baseSource,
      identity: {
        ecosystem: "nango",
        authorityNamespace: "",
        nativeId: input.identityHint?.nativeId ?? "nango.yaml",
        nativeVersion: input.identityHint?.nativeVersion ?? "legacy",
      },
      format: { name: "nango-yaml", version: "legacy" },
      mediaType: /^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/i.test(input.mediaType)
        ? input.mediaType
        : "application/octet-stream",
    });
    return {
      source,
      definitions: [],
      issues: [
        issue({
          code: "nango.yaml.legacy-unsupported",
          category: "version",
          pointer: "/",
          dimension: "import",
          disposition: "unsupported",
          severity: "blocking",
          impact: "blocks-definition",
          message:
            "nango.yaml is a deprecated authoring format; deployed syncs and actions are read from the Nango API (GET /integrations/{uniqueKey}/functions).",
          remediation:
            "Migrate the integration to Zero YAML (nango migrate-to-zero-yaml) and import the API snapshot instead.",
        }),
      ],
      executableCandidates: [],
    };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(input.bytes));
  } catch {
    throw new ConnectorError("invalid-request", { detail: "nango.import.not-json" });
  }
  const snapshot = nangoSnapshotSchema.safeParse(parsed);
  if (!snapshot.success)
    throw new ConnectorError("invalid-request", { detail: "nango.import.snapshot" });
  const { integration, functions, environment, apiOrigin } = snapshot.data;
  const identity = {
    ecosystem: "nango",
    authorityNamespace: namespaceFor(environment, apiOrigin),
    nativeId: integration.unique_key,
    nativeVersion: integration.updated_at,
  };
  const source: SourceRecord = sourceRecordSchema.parse({
    ...baseSource,
    identity,
    format: { name: NANGO_SNAPSHOT_FORMAT, version: "1" },
    mediaType: "application/json",
  });
  const issues: CompatibilityIssue[] = [];
  functions.forEach((fn, index) => {
    if (!fn.enabled)
      issues.push(
        issue({
          code: "nango.function.disabled",
          category: "policy",
          pointer: `/functions/${index}`,
          dimension: fn.type === "sync" ? "delegate" : "invoke",
          disposition: "requires-configuration",
          severity: "info",
          impact: "none",
          message: `Function ${clean(fn.name, 100)} is deployed but disabled in Nango.`,
        }),
      );
    if (fn.type === "action" && !(fn.json_schema && typeof fn.json_schema === "object"))
      issues.push(
        issue({
          code: "nango.action.schema-missing",
          category: "schema",
          pointer: `/functions/${index}/json_schema`,
          dimension: "invoke",
          disposition: "adapted",
          severity: "warning",
          impact: "none",
          message: `Action ${clean(fn.name, 100)} publishes no JSON schema; the binding must declare its input contract.`,
        }),
      );
  });
  const events: EventDescriptor[] = [
    { nativeId: "auth", label: "Connection lifecycle", transport: "http-webhook", verification: "vendor" },
    { nativeId: "sync", label: "Sync execution results", transport: "http-webhook", verification: "vendor" },
    ...(integration.forward_webhooks
      ? [
          {
            nativeId: "forward",
            label: `Forwarded ${clean(integration.provider, 100)} webhooks`,
            transport: "http-webhook" as const,
            verification: "vendor" as const,
          },
        ]
      : []),
  ];
  const definitionRef = `nango:def:${digest.slice(0, 32)}`;
  const body = {
    schemaVersion: 1 as const,
    definitionRef,
    identity,
    sourceRef,
    importer: { id: "nango-api-snapshot", version: NANGO_IMPORTER_VERSION },
    display: {
      name: clean(integration.display_name, 200) || integration.unique_key,
      description: clean(
        `Nango integration ${integration.unique_key} for ${integration.provider}; ${functions.length} deployed function(s) in ${environment}.`,
      ),
      ecosystem: "nango",
      service: serviceSlug(integration.provider),
    },
    authentication: [
      {
        id: NANGO_PROFILE_IDS.connection,
        label: "Nango connect session",
        kind: "external-broker" as const,
        broker: "nango",
        custody: "external-credential-broker" as const,
      },
      {
        id: NANGO_PROFILE_IDS.proxy,
        label: "Nango proxy and actions",
        kind: "external-broker" as const,
        broker: "nango",
        custody: "external-execution-broker" as const,
      },
    ],
    configuration: NANGO_CONFIGURATION.map((item) => ({ ...item })),
    capabilities: functions.map(capabilityFor),
    events,
    declaredServers: [
      { url: apiOrigin, description: "Nango API (declared by snapshot)", status: "declared" as const },
    ],
    compatibility: {
      issues,
      dimensions: {
        discover: "exact",
        import: "exact",
        configure: "exact",
        authorize: "adapted",
        verify: "adapted",
        invoke: "adapted",
        events: "adapted",
        reconnect: "adapted",
        disconnect: "exact",
        revoke: "unsupported",
        export: "unsupported",
        delegate: "adapted",
      },
    },
    nativeExtensions: {
      nango: {
        apiOrigin,
        environment,
        integration: {
          uniqueKey: integration.unique_key,
          provider: integration.provider,
          forwardWebhooks: integration.forward_webhooks === true,
          updatedAt: integration.updated_at,
        },
        functionCount: functions.length,
      },
    },
  };
  const definition: NormalizedDefinition = normalizedDefinitionSchema.parse({
    ...body,
    normalizedDigest: sha256(canonicalConnectorJson(body)),
  });
  return {
    source,
    definitions: [definition],
    issues,
    executableCandidates: functions
      .filter((fn) => fn.enabled && fn.type !== "on-event")
      .map((fn) => fn.name),
  };
}

/** A directory service key from a provider slug; never an identity, only a grouping. */
export function serviceSlug(provider: string): string {
  const slug = provider
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^[^a-z0-9]+/, "")
    .slice(0, 120);
  return slug || "nango";
}

/**
 * One directory entry per configured integration. Entries for the same
 * provider share a group and stay separate rows: two GitHub integrations in
 * one environment are two configurations, not one.
 */
export async function nangoCatalogEntries(
  adapter: ConnectorAdapter,
  runtime: NangoRuntime,
  ctx: AdapterCallContext,
  present: ReadonlySet<string>,
): Promise<CatalogEntry[]> {
  const resolved = await resolveNango(runtime, ctx);
  const list = await resolved.client.listIntegrations();
  const capabilities = adapter.capabilities(present);
  const missingRequired = adapter.configuration.some(
    (item) => item.required && !present.has(item.name),
  );
  return list.data.map((integration) => {
    const service = serviceSlug(integration.provider);
    const key = integration.unique_key
      .toLowerCase()
      .replace(/[^a-z0-9._:-]+/g, "-")
      .replace(/^[^a-z0-9]+/, "")
      .slice(0, 100);
    return publicCatalogProjection(
      catalogEntrySchema.parse({
        id: `nango:${key || "integration"}:${sha256(integration.unique_key).slice(0, 8)}`,
        ecosystem: "nango",
        service,
        displayName: clean(
          `${integration.display_name} via Nango (${integration.unique_key})`,
          200,
        ),
        description: clean(
          `Nango integration ${integration.unique_key} for ${integration.provider} in environment ${resolved.environment}; credentials stay in Nango.`,
        ),
        support: missingRequired ? "unconfigured" : adapter.support,
        custody: [...adapter.custody],
        runtimes: [adapter.runtime],
        authentication: ["external-broker"],
        configuration: adapter.configuration.map((item) => ({
          name: item.name,
          required: item.required,
          classification: item.classification,
          present: present.has(item.name),
        })),
        capabilities,
        evidence: strongestEvidence(capabilities.map((status) => status.evidence)),
        group: service,
      }),
    );
  });
}
