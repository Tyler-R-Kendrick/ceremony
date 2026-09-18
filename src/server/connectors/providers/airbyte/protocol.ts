import { z } from "zod";
import {
  canonicalDigest,
  compatibilityIssueSchema,
  completeDimensions,
  DEFINITION_LIMITS,
  nativeIdentifierSchema,
  nativeVersionSchema,
  normalizedDefinitionSchema,
  safeTextSchema,
  type CompatibilityIssue,
  type ConnectorSourceIdentity,
  type NativeCapability,
  type NormalizedDefinition,
} from "../../../../core/connectors/index.js";
import { ConnectorError } from "../../errors.js";
import {
  airbyteAuthenticationProfileId,
  airbyteConfigurationRequirements,
  assertPlainJson,
  deepFreeze,
} from "./contracts.js";

/*
 * The Airbyte protocol as a read-only description. Shapes follow the
 * protocol JSON schema published in airbytehq/airbyte-protocol
 * (protocol-models `airbyte_protocol/v0/airbyte_protocol.yaml`, schema
 * `version: 0.3.2`) and the protocol reference at
 * https://docs.airbyte.com/platform/understanding-airbyte/airbyte-protocol,
 * both retrieved 2026-09-18. Verified there: the AirbyteMessage type set,
 * AirbyteStream/ConfiguredAirbyteStream fields and required lists, SyncMode
 * and DestinationSyncMode values, the state message (`type`, `stream`,
 * `global`, `data`, `sourceStats`, `destinationStats`), AirbyteStateType,
 * AirbyteConnectionStatus, and the trace message type set. Unknown fields are
 * preserved as inert extensions; nothing here executes a connector.
 *
 * Nothing in this module rewrites a checkpoint. State is copied, frozen and
 * reported; the platform that owns the connection is the only writer.
 */

export const AIRBYTE_PROTOCOL_PROFILE = "airbyte-protocol-v0";
export const AIRBYTE_CATALOG_IMPORTER = {
  id: "airbyte-protocol-catalog",
  version: "2026.09.18",
} as const;

export const airbyteSyncModes = ["full_refresh", "incremental"] as const;
export const airbyteDestinationSyncModes = [
  "append",
  "overwrite",
  "append_dedup",
] as const;
export const airbyteMessageTypes = [
  "RECORD",
  "STATE",
  "LOG",
  "SPEC",
  "CONNECTION_STATUS",
  "CATALOG",
  "TRACE",
] as const;
export const airbyteStateTypes = ["STREAM", "GLOBAL", "LEGACY"] as const;

const text = (max: number) =>
  z
    .string()
    .max(max)
    .regex(/^[^\p{Cc}]*$/u);
const name = text(512).min(1);
const fieldPath = z.array(text(512)).max(64);
const keyPaths = z.array(fieldPath).max(64);

export const airbyteStreamSchema = z.looseObject({
  name,
  json_schema: z.record(z.string(), z.unknown()),
  supported_sync_modes: z.array(text(64).min(1)).min(1).max(8),
  source_defined_cursor: z.boolean().optional(),
  default_cursor_field: fieldPath.optional(),
  source_defined_primary_key: keyPaths.optional(),
  namespace: text(512).nullable().optional(),
  is_resumable: z.boolean().optional(),
  is_file_based: z.boolean().optional(),
});
export type AirbyteStream = z.infer<typeof airbyteStreamSchema>;

export const airbyteCatalogSchema = z.looseObject({
  streams: z.array(airbyteStreamSchema).max(DEFINITION_LIMITS.capabilities),
});
export type AirbyteCatalog = z.infer<typeof airbyteCatalogSchema>;

export const configuredAirbyteStreamSchema = z.looseObject({
  stream: airbyteStreamSchema,
  sync_mode: text(64).min(1),
  destination_sync_mode: text(64).min(1),
  cursor_field: fieldPath.optional(),
  primary_key: keyPaths.optional(),
  generation_id: z.number().int().optional(),
  minimum_generation_id: z.number().int().optional(),
  sync_id: z.number().int().optional(),
  include_files: z.boolean().optional(),
  destination_object_name: text(512).optional(),
});
export type ConfiguredAirbyteStream = z.infer<
  typeof configuredAirbyteStreamSchema
>;

export const configuredAirbyteCatalogSchema = z.looseObject({
  streams: z
    .array(configuredAirbyteStreamSchema)
    .max(DEFINITION_LIMITS.capabilities),
});
export type ConfiguredAirbyteCatalog = z.infer<
  typeof configuredAirbyteCatalogSchema
>;

export const connectorSpecificationSchema = z.looseObject({
  protocol_version: text(64).optional(),
  documentationUrl: text(2048).optional(),
  changelogUrl: text(2048).optional(),
  connectionSpecification: z.record(z.string(), z.unknown()),
  supportsIncremental: z.boolean().optional(),
  supportsNormalization: z.boolean().optional(),
  supportsDBT: z.boolean().optional(),
  supported_destination_sync_modes: z.array(text(64)).max(8).optional(),
  authSpecification: z.unknown().optional(),
  advanced_auth: z.unknown().optional(),
});
export type ConnectorSpecification = z.infer<
  typeof connectorSpecificationSchema
>;

export const streamDescriptorSchema = z.looseObject({
  name,
  namespace: text(512).nullable().optional(),
});
export type StreamDescriptor = z.infer<typeof streamDescriptorSchema>;

export const airbyteStateStatsSchema = z.looseObject({
  recordCount: z.number().nonnegative().optional(),
  rejectedRecordCount: z.number().nonnegative().optional(),
});
export const airbyteStreamStateSchema = z.looseObject({
  stream_descriptor: streamDescriptorSchema,
  stream_state: z.unknown().optional(),
});
export const airbyteGlobalStateSchema = z.looseObject({
  shared_state: z.unknown().optional(),
  stream_states: z.array(airbyteStreamStateSchema).max(4096),
});
export const airbyteStateMessageSchema = z.looseObject({
  type: z.enum(airbyteStateTypes).optional(),
  stream: airbyteStreamStateSchema.optional(),
  global: airbyteGlobalStateSchema.optional(),
  data: z.unknown().optional(),
  sourceStats: airbyteStateStatsSchema.optional(),
  destinationStats: airbyteStateStatsSchema.optional(),
});
export type AirbyteStateMessage = z.infer<typeof airbyteStateMessageSchema>;

export const airbyteConnectionStatusSchema = z.looseObject({
  status: z.enum(["SUCCEEDED", "FAILED"]),
  message: z.string().max(8192).optional(),
});
export type AirbyteConnectionStatus = z.infer<
  typeof airbyteConnectionStatusSchema
>;

export const airbyteRecordMessageSchema = z.looseObject({
  stream: name,
  namespace: text(512).nullable().optional(),
  data: z.record(z.string(), z.unknown()),
  emitted_at: z.number(),
});

export const airbyteTraceMessageSchema = z.looseObject({
  type: z.enum(["ERROR", "ESTIMATE", "STREAM_STATUS", "ANALYTICS"]),
  emitted_at: z.number().optional(),
  error: z
    .looseObject({
      message: z.string().optional(),
      internal_message: z.string().optional(),
      stack_trace: z.string().optional(),
      failure_type: text(64).optional(),
      stream_descriptor: streamDescriptorSchema.optional(),
    })
    .optional(),
  stream_status: z
    .looseObject({
      stream_descriptor: streamDescriptorSchema,
      status: text(64),
    })
    .optional(),
});

export const airbyteMessageSchema = z.looseObject({
  type: z.enum(airbyteMessageTypes),
  record: airbyteRecordMessageSchema.optional(),
  state: airbyteStateMessageSchema.optional(),
  log: z.unknown().optional(),
  spec: connectorSpecificationSchema.optional(),
  connectionStatus: airbyteConnectionStatusSchema.optional(),
  catalog: airbyteCatalogSchema.optional(),
  trace: airbyteTraceMessageSchema.optional(),
});
export type AirbyteMessage = z.infer<typeof airbyteMessageSchema>;

export type AirbyteStreamSummary = {
  nativeId: string;
  name: string;
  namespace?: string;
  supportedSyncModes: string[];
  sourceDefinedCursor?: boolean;
  defaultCursorField?: string[];
  sourceDefinedPrimaryKey?: string[][];
  configured?: {
    syncMode: string;
    destinationSyncMode: string;
    cursorField?: string[];
    primaryKey?: string[][];
  };
  executable: boolean;
};

export type AirbyteCatalogImport = {
  definition: NormalizedDefinition;
  issues: CompatibilityIssue[];
  streams: AirbyteStreamSummary[];
  executableCandidates: string[];
  catalogKind: "catalog" | "configured";
};

export type ReadAirbyteCatalogOptions = {
  identity?: Partial<ConnectorSourceIdentity>;
  definitionRef?: string;
  sourceRef?: string;
  display?: { name?: string; description?: string };
};

const issue = (input: Omit<CompatibilityIssue, "normalizedPointer"> & {
  normalizedPointer?: string;
}): CompatibilityIssue => compatibilityIssueSchema.parse(input);

const blocking = (
  code: string,
  sourcePointer: string,
  normalizedPointer: string | undefined,
  message: string,
  remediation?: string,
) =>
  issue({
    code,
    category: "schema",
    sourcePointer,
    ...(normalizedPointer ? { normalizedPointer } : {}),
    dimension: "delegate",
    disposition: "rejected",
    severity: "blocking",
    executionImpact: "blocks-operation",
    message,
    ...(remediation ? { remediation } : {}),
  });

/** The stream identity Airbyte uses: name plus optional namespace, spelled exactly. */
export function streamKey(descriptor: {
  name: string;
  namespace?: string | null;
}): string {
  return JSON.stringify([descriptor.name, descriptor.namespace ?? null]);
}

function streamNativeId(stream: { name: string; namespace?: string | null }) {
  return stream.namespace ? `${stream.namespace}::${stream.name}` : stream.name;
}

function detectCatalogKind(catalog: unknown): "catalog" | "configured" {
  if (
    !catalog ||
    typeof catalog !== "object" ||
    !Array.isArray((catalog as { streams?: unknown }).streams)
  )
    throw new ConnectorError("invalid-request", {
      detail: "airbyte.catalog.invalid",
    });
  const streams = (catalog as { streams: unknown[] }).streams;
  const configured = streams.filter(
    (item) =>
      item &&
      typeof item === "object" &&
      typeof (item as { stream?: unknown }).stream === "object",
  ).length;
  if (configured && configured !== streams.length)
    throw new ConnectorError("invalid-request", {
      detail: "airbyte.catalog.mixed-shapes",
    });
  return configured ? "configured" : "catalog";
}

function parseWith<T>(schema: z.ZodType<T>, value: unknown, detail: string): T {
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw new ConnectorError("invalid-request", { detail });
  return parsed.data;
}

function definedEntries(value: Record<string, unknown>) {
  return Object.fromEntries(
    Object.entries(value).filter(([, item]) => item !== undefined),
  );
}

/**
 * Imports a connector specification and an `AirbyteCatalog` or a
 * `ConfiguredAirbyteCatalog` into a normalized, non-executable definition.
 * Every stream becomes one `sync` capability that preserves the stream's name,
 * namespace, JSON schema, supported sync modes, cursor and primary-key
 * declarations exactly as written. A configured stream that requests a sync
 * mode its stream does not support, or a mode outside the protocol, is a
 * blocking issue on that stream alone: the rest of the catalog stays
 * discoverable, and nothing is coerced to a mode the source never offered.
 */
export async function readAirbyteCatalog(
  spec: unknown,
  catalog: unknown,
  options: ReadAirbyteCatalogOptions = {},
): Promise<AirbyteCatalogImport> {
  if (spec !== undefined && spec !== null)
    assertPlainJson(spec, "airbyte.spec.invalid");
  assertPlainJson(catalog, "airbyte.catalog.invalid");
  const specification =
    spec === undefined || spec === null
      ? undefined
      : parseWith(connectorSpecificationSchema, spec, "airbyte.spec.invalid");
  const catalogKind = detectCatalogKind(catalog);
  const entries =
    catalogKind === "configured"
      ? parseWith(
          configuredAirbyteCatalogSchema,
          catalog,
          "airbyte.catalog.invalid",
        ).streams.map((item, index) => ({
          stream: item.stream,
          configured: item as ConfiguredAirbyteStream | undefined,
          pointer: `/streams/${index}/stream`,
          configuredPointer: `/streams/${index}`,
          index,
        }))
      : parseWith(
          airbyteCatalogSchema,
          catalog,
          "airbyte.catalog.invalid",
        ).streams.map((item, index) => ({
          stream: item,
          configured: undefined,
          pointer: `/streams/${index}`,
          configuredPointer: `/streams/${index}`,
          index,
        }));

  const issues: CompatibilityIssue[] = [];
  const capabilities: NativeCapability[] = [];
  const streams: AirbyteStreamSummary[] = [];
  const executableCandidates: string[] = [];
  const seen = new Map<string, number>();

  if (!specification)
    issues.push(
      issue({
        code: "airbyte.spec.missing",
        category: "structure",
        sourcePointer: "/spec",
        dimension: "import",
        disposition: "adapted",
        severity: "info",
        executionImpact: "none",
        message:
          "No connector specification accompanied the catalog; connection configuration requirements are unknown.",
      }),
    );

  for (const entry of entries) {
    const { stream, configured, pointer, index } = entry;
    const normalizedPointer = `/capabilities/${capabilities.length}`;
    let executable = true;
    const unknownModes = stream.supported_sync_modes.filter(
      (mode) => !(airbyteSyncModes as readonly string[]).includes(mode),
    );
    if (unknownModes.length) {
      executable = false;
      issues.push(
        blocking(
          "airbyte.sync-mode.unknown",
          `${pointer}/supported_sync_modes`,
          normalizedPointer,
          "The stream declares a sync mode outside the pinned protocol version.",
          "Update the importer profile before delegating this stream.",
        ),
      );
    }
    let nativeId: string;
    const candidate = nativeIdentifierSchema.safeParse(streamNativeId(stream));
    if (!candidate.success) {
      issues.push(
        blocking(
          "airbyte.stream.identifier-rejected",
          `${pointer}/name`,
          undefined,
          "The stream identity cannot be represented safely and was not imported.",
        ),
      );
      continue;
    }
    nativeId = candidate.data;
    const collisions = seen.get(nativeId) ?? 0;
    seen.set(nativeId, collisions + 1);
    if (collisions) {
      nativeId = `${nativeId}#${collisions + 1}`;
      executable = false;
      issues.push(
        blocking(
          "airbyte.stream.identity-collision",
          `${pointer}/name`,
          normalizedPointer,
          "Two streams share one name and namespace; both were kept, neither is executable until the source disambiguates them.",
        ),
      );
    }

    if (configured) {
      if (
        !(airbyteSyncModes as readonly string[]).includes(configured.sync_mode)
      ) {
        executable = false;
        issues.push(
          blocking(
            "airbyte.sync-mode.unknown",
            `${entry.configuredPointer}/sync_mode`,
            normalizedPointer,
            "The configured sync mode is outside the pinned protocol version.",
          ),
        );
      } else if (!stream.supported_sync_modes.includes(configured.sync_mode)) {
        executable = false;
        issues.push(
          blocking(
            "airbyte.sync-mode.unsupported",
            `${entry.configuredPointer}/sync_mode`,
            normalizedPointer,
            "The configured sync mode is not among the modes the stream supports; the stream cannot be delegated as configured.",
            "Choose one of the stream's supported sync modes.",
          ),
        );
      }
      if (
        !(airbyteDestinationSyncModes as readonly string[]).includes(
          configured.destination_sync_mode,
        )
      )
        issues.push(
          issue({
            code: "airbyte.destination-sync-mode.unknown",
            category: "schema",
            sourcePointer: `${entry.configuredPointer}/destination_sync_mode`,
            normalizedPointer,
            dimension: "delegate",
            disposition: "native-extension",
            severity: "warning",
            executionImpact: "none",
            message:
              "The destination sync mode is not one the pinned protocol version names; it is preserved verbatim for the platform to interpret.",
          }),
        );
      const cursor = configured.cursor_field?.length
        ? configured.cursor_field
        : stream.default_cursor_field;
      if (
        configured.sync_mode === "incremental" &&
        !stream.source_defined_cursor &&
        !cursor?.length
      ) {
        executable = false;
        issues.push(
          blocking(
            "airbyte.cursor.missing",
            `${entry.configuredPointer}/cursor_field`,
            normalizedPointer,
            "An incremental stream needs a cursor field unless the source defines one.",
          ),
        );
      }
      const primaryKey = configured.primary_key?.length
        ? configured.primary_key
        : stream.source_defined_primary_key;
      if (
        configured.destination_sync_mode === "append_dedup" &&
        !primaryKey?.length
      ) {
        executable = false;
        issues.push(
          blocking(
            "airbyte.primary-key.missing",
            `${entry.configuredPointer}/primary_key`,
            normalizedPointer,
            "Deduplicated writes need a primary key unless the source defines one.",
          ),
        );
      }
    }

    const label = safeTextSchema.max(200).safeParse(stream.name);
    const summaryText = `Airbyte stream${
      stream.namespace ? " in a source namespace" : ""
    }; supported sync modes: ${stream.supported_sync_modes.join(", ")}`;
    capabilities.push({
      kind: "sync",
      nativeId,
      ...(label.success && label.data ? { label: label.data } : {}),
      summary: safeTextSchema.parse(summaryText.slice(0, 500)),
      effect: "unknown",
      dataClassification: "unknown",
      cost: "unknown",
      authentication: [airbyteAuthenticationProfileId],
      inputSchemaRef: `${pointer}/json_schema`,
      nativeExtensions: {
        "airbyte.stream": definedEntries({ ...stream }),
        ...(configured
          ? {
              "airbyte.configured": definedEntries({
                sync_mode: configured.sync_mode,
                destination_sync_mode: configured.destination_sync_mode,
                cursor_field: configured.cursor_field,
                primary_key: configured.primary_key,
                generation_id: configured.generation_id,
                minimum_generation_id: configured.minimum_generation_id,
                sync_id: configured.sync_id,
                include_files: configured.include_files,
                destination_object_name: configured.destination_object_name,
              }),
            }
          : {}),
      },
    });
    streams.push({
      nativeId,
      name: stream.name,
      ...(typeof stream.namespace === "string"
        ? { namespace: stream.namespace }
        : {}),
      supportedSyncModes: [...stream.supported_sync_modes],
      ...(stream.source_defined_cursor === undefined
        ? {}
        : { sourceDefinedCursor: stream.source_defined_cursor }),
      ...(stream.default_cursor_field
        ? { defaultCursorField: [...stream.default_cursor_field] }
        : {}),
      ...(stream.source_defined_primary_key
        ? {
            sourceDefinedPrimaryKey: stream.source_defined_primary_key.map(
              (path) => [...path],
            ),
          }
        : {}),
      ...(configured
        ? {
            configured: {
              syncMode: configured.sync_mode,
              destinationSyncMode: configured.destination_sync_mode,
              ...(configured.cursor_field
                ? { cursorField: [...configured.cursor_field] }
                : {}),
              ...(configured.primary_key
                ? { primaryKey: configured.primary_key.map((p) => [...p]) }
                : {}),
            },
          }
        : {}),
      executable,
    });
    if (executable && configured) executableCandidates.push(nativeId);
    void index;
  }

  const protocolVersion = specification?.protocol_version;
  const identity: ConnectorSourceIdentity = {
    ecosystem: "airbyte",
    authorityNamespace: options.identity?.authorityNamespace ?? "",
    nativeId: options.identity?.nativeId ?? "airbyte-source",
    nativeVersion:
      options.identity?.nativeVersion ??
      (protocolVersion && nativeVersionSchema.safeParse(protocolVersion).success
        ? protocolVersion
        : "unversioned"),
  };
  const body = {
    schemaVersion: 1 as const,
    identity,
    importer: { ...AIRBYTE_CATALOG_IMPORTER },
    display: {
      name: options.display?.name ?? "Airbyte source catalog",
      description:
        options.display?.description ??
        `Airbyte ${catalogKind === "configured" ? "configured " : ""}catalog with ${streams.length} stream${streams.length === 1 ? "" : "s"}; delegated to an existing Airbyte deployment.`,
      ecosystem: "airbyte",
      service: "airbyte",
    },
    authentication: [
      {
        id: airbyteAuthenticationProfileId,
        label: "Airbyte API access token",
        kind: "http-bearer" as const,
      },
    ],
    configuration: airbyteConfigurationRequirements.map((item) => ({
      ...item,
    })),
    capabilities,
    events: [],
    declaredServers: [],
    compatibility: {
      issues: issues.slice(0, DEFINITION_LIMITS.issues),
      dimensions: completeDimensions({
        discover: "requires-configuration",
        import: "exact",
        configure: "requires-configuration",
        authorize: "requires-configuration",
        verify: "requires-configuration",
        invoke: "unsupported",
        events: "unsupported",
        reconnect: "requires-configuration",
        disconnect: "exact",
        revoke: "unsupported",
        export: "exact",
        delegate: "requires-configuration",
      }),
    },
    nativeExtensions: {
      "airbyte.protocol": { profile: AIRBYTE_PROTOCOL_PROFILE, catalogKind },
      ...(specification
        ? { "airbyte.spec": definedEntries({ ...specification }) }
        : {}),
    },
  };
  const normalizedDigest = await canonicalDigest(body);
  const parsed = normalizedDefinitionSchema.safeParse({
    ...body,
    definitionRef:
      options.definitionRef ?? `def:airbyte:${normalizedDigest.slice(0, 32)}`,
    sourceRef:
      options.sourceRef ?? `src:airbyte:${normalizedDigest.slice(0, 32)}`,
    normalizedDigest,
  });
  if (!parsed.success)
    throw new ConnectorError("invalid-request", {
      detail: "airbyte.catalog.limits",
    });
  return {
    definition: parsed.data,
    issues: parsed.data.compatibility.issues,
    streams,
    executableCandidates,
    catalogKind,
  };
}

export type AirbyteMessageReport = {
  profile: typeof AIRBYTE_PROTOCOL_PROFILE;
  spec?: ConnectorSpecification;
  catalog?: AirbyteCatalog;
  connectionStatus?: { status: "SUCCEEDED" | "FAILED" };
  states: AirbyteStateMessage[];
  records: {
    total: number;
    byStream: Array<{ name: string; namespace?: string; count: number }>;
  };
  traces: {
    errors: Array<{
      failureType?: string;
      stream?: { name: string; namespace?: string };
    }>;
    streamStatus: Array<{ name: string; namespace?: string; status: string }>;
  };
  counts: Record<(typeof airbyteMessageTypes)[number], number>;
  ignoredLines: number;
};

const descriptorOf = (descriptor: StreamDescriptor) => ({
  name: descriptor.name,
  ...(typeof descriptor.namespace === "string"
    ? { namespace: descriptor.namespace }
    : {}),
});

/**
 * Reads a connector's emitted messages (newline-delimited JSON or an array of
 * parsed objects). Lines that are not protocol messages are counted and
 * ignored, as the protocol requires. Connection-status prose, log bodies and
 * trace error text never surface: they can carry credentials and are the
 * connector's business, not the description's.
 */
export function readAirbyteMessages(
  input: string | readonly unknown[],
  options: { maxMessages?: number; maxBytes?: number } = {},
): AirbyteMessageReport {
  const maxMessages = options.maxMessages ?? 100_000;
  const maxBytes = options.maxBytes ?? 64 * 1024 * 1024;
  let candidates: unknown[];
  let ignoredLines = 0;
  if (typeof input === "string") {
    if (new TextEncoder().encode(input).byteLength > maxBytes)
      throw new ConnectorError("invalid-request", {
        detail: "airbyte.messages.too-large",
      });
    candidates = [];
    for (const line of input.split(/\r?\n/)) {
      if (!line.trim()) continue;
      try {
        const value: unknown = JSON.parse(line);
        assertPlainJson(value, "airbyte.messages.invalid");
        candidates.push(value);
      } catch (error) {
        if (error instanceof ConnectorError) throw error;
        ignoredLines++;
      }
    }
  } else {
    candidates = [...input];
    assertPlainJson(candidates, "airbyte.messages.invalid");
  }
  if (candidates.length > maxMessages)
    throw new ConnectorError("invalid-request", {
      detail: "airbyte.messages.too-many",
    });
  const report: AirbyteMessageReport = {
    profile: AIRBYTE_PROTOCOL_PROFILE,
    states: [],
    records: { total: 0, byStream: [] },
    traces: { errors: [], streamStatus: [] },
    counts: {
      RECORD: 0,
      STATE: 0,
      LOG: 0,
      SPEC: 0,
      CONNECTION_STATUS: 0,
      CATALOG: 0,
      TRACE: 0,
    },
    ignoredLines,
  };
  const perStream = new Map<string, { name: string; namespace?: string; count: number }>();
  for (const candidate of candidates) {
    const parsed = airbyteMessageSchema.safeParse(candidate);
    if (!parsed.success) {
      report.ignoredLines++;
      continue;
    }
    const message = parsed.data;
    report.counts[message.type]++;
    switch (message.type) {
      case "SPEC":
        if (message.spec) report.spec = message.spec;
        break;
      case "CATALOG":
        if (message.catalog) report.catalog = message.catalog;
        break;
      case "CONNECTION_STATUS":
        if (message.connectionStatus)
          report.connectionStatus = { status: message.connectionStatus.status };
        break;
      case "STATE":
        if (message.state) report.states.push(message.state);
        break;
      case "RECORD":
        if (message.record) {
          report.records.total++;
          const key = streamKey(message.record);
          const entry = perStream.get(key) ?? {
            ...descriptorOf({
              name: message.record.stream,
              namespace: message.record.namespace,
            }),
            count: 0,
          };
          entry.count++;
          perStream.set(key, entry);
        }
        break;
      case "TRACE":
        if (message.trace?.type === "ERROR")
          report.traces.errors.push({
            ...(message.trace.error?.failure_type
              ? { failureType: message.trace.error.failure_type }
              : {}),
            ...(message.trace.error?.stream_descriptor
              ? { stream: descriptorOf(message.trace.error.stream_descriptor) }
              : {}),
          });
        else if (message.trace?.type === "STREAM_STATUS" && message.trace.stream_status)
          report.traces.streamStatus.push({
            ...descriptorOf(message.trace.stream_status.stream_descriptor),
            status: message.trace.stream_status.status,
          });
        break;
      default:
        break;
    }
  }
  report.records.byStream = [...perStream.values()];
  return report;
}

export type AirbyteCheckpoint = {
  descriptor: { name: string; namespace?: string };
  stateType: "STREAM" | "GLOBAL";
  /** A frozen copy of the connector's checkpoint; opaque and never rewritten. */
  state: unknown;
  /** Position of the state message in the emission order. */
  sequence: number;
  sourceStats?: { recordCount?: number; rejectedRecordCount?: number };
  destinationStats?: { recordCount?: number; rejectedRecordCount?: number };
};

export type AirbyteCheckpointSet = {
  streams: Map<string, AirbyteCheckpoint>;
  global?: { sharedState: unknown; sequence: number };
  legacy?: { data: unknown; sequence: number };
  /** Records emitted for a stream after its latest checkpoint; a restart replays at least these. */
  uncheckpointedRecords: Map<string, number>;
  /** Streams a trace reported as errored or incomplete. */
  partialStreams: string[];
  /** A connector-level error trace without a stream descriptor. */
  connectorFailed: boolean;
};

const stats = (value: z.infer<typeof airbyteStateStatsSchema> | undefined) =>
  value
    ? {
        ...(value.recordCount === undefined
          ? {}
          : { recordCount: value.recordCount }),
        ...(value.rejectedRecordCount === undefined
          ? {}
          : { rejectedRecordCount: value.rejectedRecordCount }),
      }
    : undefined;

/**
 * Folds an ordered message sequence into the latest checkpoint per stream.
 * Stream state keeps its `stream_descriptor` identity, global state keeps its
 * shared and per-stream parts, legacy state is kept whole. Every checkpoint is
 * a frozen copy; records that arrived after the latest checkpoint of their
 * stream are counted as work a restart replays, never folded into the state.
 */
export function airbyteCheckpoints(
  messages: readonly AirbyteMessage[],
): AirbyteCheckpointSet {
  const set: AirbyteCheckpointSet = {
    streams: new Map(),
    uncheckpointedRecords: new Map(),
    partialStreams: [],
    connectorFailed: false,
  };
  const partial = new Set<string>();
  let sequence = 0;
  const checkpoint = (
    stateType: "STREAM" | "GLOBAL",
    entry: z.infer<typeof airbyteStreamStateSchema>,
    message: AirbyteStateMessage,
  ) => {
    const key = streamKey(entry.stream_descriptor);
    const source = stats(message.sourceStats);
    const destination = stats(message.destinationStats);
    set.streams.set(key, {
      descriptor: descriptorOf(entry.stream_descriptor),
      stateType,
      state: deepFreeze(structuredClone(entry.stream_state ?? null)),
      sequence,
      ...(source ? { sourceStats: source } : {}),
      ...(destination ? { destinationStats: destination } : {}),
    });
    set.uncheckpointedRecords.set(key, 0);
  };
  for (const message of messages) {
    sequence++;
    if (message.type === "RECORD" && message.record) {
      const key = streamKey({
        name: message.record.stream,
        namespace: message.record.namespace,
      });
      set.uncheckpointedRecords.set(
        key,
        (set.uncheckpointedRecords.get(key) ?? 0) + 1,
      );
    } else if (message.type === "STATE" && message.state) {
      const state = message.state;
      const type = state.type ?? (state.stream ? "STREAM" : state.global ? "GLOBAL" : "LEGACY");
      if (type === "STREAM" && state.stream) checkpoint("STREAM", state.stream, state);
      else if (type === "GLOBAL" && state.global) {
        set.global = {
          sharedState: deepFreeze(structuredClone(state.global.shared_state ?? null)),
          sequence,
        };
        for (const entry of state.global.stream_states)
          checkpoint("GLOBAL", entry, state);
        for (const key of set.uncheckpointedRecords.keys())
          set.uncheckpointedRecords.set(key, 0);
      } else if (type === "LEGACY") {
        set.legacy = {
          data: deepFreeze(structuredClone(state.data ?? null)),
          sequence,
        };
        for (const key of set.uncheckpointedRecords.keys())
          set.uncheckpointedRecords.set(key, 0);
      }
    } else if (message.type === "TRACE" && message.trace) {
      if (message.trace.type === "ERROR") {
        const descriptor = message.trace.error?.stream_descriptor;
        if (descriptor) partial.add(streamKey(descriptor));
        else set.connectorFailed = true;
      } else if (
        message.trace.type === "STREAM_STATUS" &&
        message.trace.stream_status?.status === "INCOMPLETE"
      )
        partial.add(streamKey(message.trace.stream_status.stream_descriptor));
    }
  }
  set.partialStreams = [...partial];
  return set;
}

export type AirbyteRestartPlan = {
  streams: Array<{
    key: string;
    descriptor: { name: string; namespace?: string };
    resumeFrom: "checkpoint" | "beginning";
    checkpointSequence?: number;
    replayAtLeast: number;
    partial: boolean;
  }>;
  /** Restart never carries state to the platform; it re-requests the same connection's job. */
  carriesState: false;
};

/** Describes what a restart would replay per stream without altering any checkpoint. */
export function planAirbyteRestart(
  checkpoints: AirbyteCheckpointSet,
): AirbyteRestartPlan {
  const keys = new Set<string>([
    ...checkpoints.streams.keys(),
    ...checkpoints.uncheckpointedRecords.keys(),
    ...checkpoints.partialStreams,
  ]);
  const partial = new Set(checkpoints.partialStreams);
  const streams = [...keys].map((key) => {
    const checkpoint = checkpoints.streams.get(key);
    const [name, namespace] = JSON.parse(key) as [string, string | null];
    return {
      key,
      descriptor: checkpoint?.descriptor ?? {
        name,
        ...(namespace === null ? {} : { namespace }),
      },
      resumeFrom: checkpoint ? ("checkpoint" as const) : ("beginning" as const),
      ...(checkpoint ? { checkpointSequence: checkpoint.sequence } : {}),
      replayAtLeast: checkpoints.uncheckpointedRecords.get(key) ?? 0,
      partial: partial.has(key) || checkpoints.connectorFailed,
    };
  });
  return { streams, carriesState: false };
}
