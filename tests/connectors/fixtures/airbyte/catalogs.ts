/*
 * Airbyte catalog, specification and message fixtures, written from the
 * protocol schema (airbytehq/airbyte-protocol, `airbyte_protocol/v0`, schema
 * version 0.3.2) and the protocol reference page, both retrieved 2026-09-18.
 * These are documents a source would emit; no adapter produced them.
 */

export const postgresSpecification = {
  protocol_version: "0.3.2",
  documentationUrl: "https://docs.airbyte.com/integrations/sources/postgres",
  connectionSpecification: {
    $schema: "http://json-schema.org/draft-07/schema#",
    title: "Postgres Source Spec",
    type: "object",
    required: ["host", "port", "database", "username"],
    properties: {
      host: { type: "string", title: "Host" },
      port: { type: "integer", title: "Port", default: 5432 },
      database: { type: "string", title: "Database" },
      username: { type: "string", title: "Username" },
      password: { type: "string", title: "Password", airbyte_secret: true },
    },
  },
  supportsIncremental: true,
  supported_destination_sync_modes: ["overwrite", "append", "append_dedup"],
};

/** A discovered catalog: streams with their supported modes, cursor and key declarations. */
export const discoveredCatalog = {
  streams: [
    {
      name: "users",
      namespace: "public",
      json_schema: {
        type: "object",
        properties: {
          id: { type: "integer" },
          email: { type: "string" },
          updated_at: { type: "string", format: "date-time" },
        },
      },
      supported_sync_modes: ["full_refresh", "incremental"],
      source_defined_cursor: true,
      default_cursor_field: ["updated_at"],
      source_defined_primary_key: [["id"]],
      is_resumable: true,
    },
    {
      name: "events",
      namespace: "analytics",
      json_schema: {
        type: "object",
        properties: {
          event_id: { type: "string" },
          occurred_at: { type: "string", format: "date-time" },
        },
      },
      supported_sync_modes: ["incremental"],
      source_defined_cursor: false,
      default_cursor_field: ["occurred_at"],
      source_defined_primary_key: [["event_id"]],
    },
    {
      name: "audit_log",
      json_schema: { type: "object", properties: { line: { type: "string" } } },
      supported_sync_modes: ["full_refresh"],
    },
  ],
};

/** A configured catalog whose every stream is consistent with its declarations. */
export const configuredCatalog = {
  streams: [
    {
      stream: discoveredCatalog.streams[0],
      sync_mode: "incremental",
      destination_sync_mode: "append_dedup",
      cursor_field: ["updated_at"],
      primary_key: [["id"]],
      generation_id: 7,
      minimum_generation_id: 7,
      sync_id: 41,
    },
    {
      stream: discoveredCatalog.streams[2],
      sync_mode: "full_refresh",
      destination_sync_mode: "overwrite",
    },
  ],
};

/** A configured catalog asking `audit_log` for a mode it does not support (AC-EXT-13). */
export const unsupportedModeCatalog = {
  streams: [
    {
      stream: discoveredCatalog.streams[2],
      sync_mode: "incremental",
      destination_sync_mode: "append",
      cursor_field: ["line"],
    },
    {
      stream: discoveredCatalog.streams[0],
      sync_mode: "incremental",
      destination_sync_mode: "append_dedup",
      cursor_field: ["updated_at"],
      primary_key: [["id"]],
    },
  ],
};

/** A configured catalog naming a mode outside the protocol vocabulary entirely. */
export const unknownModeCatalog = {
  streams: [
    {
      stream: {
        name: "users",
        namespace: "public",
        json_schema: { type: "object" },
        supported_sync_modes: ["full_refresh", "cdc_only"],
      },
      sync_mode: "cdc_only",
      destination_sync_mode: "append",
    },
  ],
};

/** Two streams that collide once namespace is dropped; both must survive distinctly. */
export const collidingCatalog = {
  streams: [
    {
      name: "orders",
      namespace: "shop_a",
      json_schema: { type: "object" },
      supported_sync_modes: ["full_refresh"],
    },
    {
      name: "orders",
      namespace: "shop_b",
      json_schema: { type: "object" },
      supported_sync_modes: ["full_refresh"],
    },
  ],
};

const record = (
  stream: string,
  namespace: string | undefined,
  data: Record<string, unknown>,
  emitted: number,
) => ({
  type: "RECORD" as const,
  record: {
    stream,
    ...(namespace ? { namespace } : {}),
    data,
    emitted_at: emitted,
  },
});

const streamState = (
  name: string,
  namespace: string | undefined,
  state: unknown,
  recordCount?: number,
) => ({
  type: "STATE" as const,
  state: {
    type: "STREAM" as const,
    stream: {
      stream_descriptor: { name, ...(namespace ? { namespace } : {}) },
      stream_state: state,
    },
    ...(recordCount === undefined
      ? {}
      : { sourceStats: { recordCount, rejectedRecordCount: 0 } }),
  },
});

/** A full sync: spec, catalog, records and per-stream checkpoints, ending cleanly. */
export const completeSyncMessages = [
  { type: "SPEC" as const, spec: postgresSpecification },
  { type: "CATALOG" as const, catalog: discoveredCatalog },
  record("users", "public", { id: 1, updated_at: "2026-09-01T00:00:00Z" }, 1),
  record("users", "public", { id: 2, updated_at: "2026-09-02T00:00:00Z" }, 2),
  streamState("users", "public", { updated_at: "2026-09-02T00:00:00Z" }, 2),
  record(
    "events",
    "analytics",
    { event_id: "e1", occurred_at: "2026-09-02T01:00:00Z" },
    3,
  ),
  streamState(
    "events",
    "analytics",
    { occurred_at: "2026-09-02T01:00:00Z" },
    1,
  ),
];

/**
 * A partial sync: `users` checkpoints once, then emits two more records and
 * fails. A restart resumes `users` from its checkpoint and replays at least
 * those two records; `events` never checkpointed and restarts from the
 * beginning.
 */
export const partialSyncMessages = [
  record("users", "public", { id: 1, updated_at: "2026-09-01T00:00:00Z" }, 1),
  streamState("users", "public", { updated_at: "2026-09-01T00:00:00Z" }, 1),
  record("users", "public", { id: 2, updated_at: "2026-09-02T00:00:00Z" }, 2),
  record("users", "public", { id: 3, updated_at: "2026-09-03T00:00:00Z" }, 3),
  record(
    "events",
    "analytics",
    { event_id: "e1", occurred_at: "2026-09-02T01:00:00Z" },
    4,
  ),
  {
    type: "TRACE" as const,
    trace: {
      type: "ERROR" as const,
      emitted_at: 5,
      error: {
        message: "connection reset while reading users",
        internal_message: "psycopg2.OperationalError token=SHOULD-NOT-LEAK",
        stack_trace: "Traceback ... token=SHOULD-NOT-LEAK",
        failure_type: "transient_error",
        stream_descriptor: { name: "users", namespace: "public" },
      },
    },
  },
];

/** A global-state sync: shared CDC position plus per-stream positions. */
export const globalStateMessages = [
  record("users", "public", { id: 9 }, 1),
  record("events", "analytics", { event_id: "e9" }, 2),
  {
    type: "STATE" as const,
    state: {
      type: "GLOBAL" as const,
      global: {
        shared_state: { lsn: "0/1A2B3C4D" },
        stream_states: [
          {
            stream_descriptor: { name: "users", namespace: "public" },
            stream_state: { cursor: 9 },
          },
          {
            stream_descriptor: { name: "events", namespace: "analytics" },
            stream_state: { cursor: "e9" },
          },
        ],
      },
      sourceStats: { recordCount: 2 },
    },
  },
];

/** Legacy (pre-per-stream) state, which must survive untouched. */
export const legacyStateMessages = [
  record("users", undefined, { id: 1 }, 1),
  {
    type: "STATE" as const,
    state: { type: "LEGACY" as const, data: { cdc_lsn: 4242 } },
  },
];

/** A successful and a failed connection check, with prose that must never surface. */
export const checkSucceeded = {
  type: "CONNECTION_STATUS" as const,
  connectionStatus: { status: "SUCCEEDED" as const },
};
export const checkFailed = {
  type: "CONNECTION_STATUS" as const,
  connectionStatus: {
    status: "FAILED" as const,
    message:
      "could not connect: password authentication failed for user 'svc' (password=SHOULD-NOT-LEAK)",
  },
};

/** Newline-delimited transcript including a non-protocol line a source logged. */
export const noisyTranscript = [
  JSON.stringify(completeSyncMessages[0]),
  "2026-09-18 00:00:01 INFO  starting source",
  JSON.stringify(completeSyncMessages[2]),
  JSON.stringify(completeSyncMessages[4]),
  "",
].join("\n");
