import assert from "node:assert/strict";
import test from "node:test";
import {
  airbyteCheckpoints,
  airbyteMessageSchema,
  planAirbyteRestart,
  readAirbyteCatalog,
  readAirbyteMessages,
  streamKey,
  type AirbyteMessage,
} from "../../../src/server/connectors/providers/airbyte/protocol.js";
import { ConnectorError } from "../../../src/server/connectors/errors.js";
import {
  checkFailed,
  checkSucceeded,
  collidingCatalog,
  completeSyncMessages,
  configuredCatalog,
  discoveredCatalog,
  globalStateMessages,
  legacyStateMessages,
  noisyTranscript,
  partialSyncMessages,
  postgresSpecification,
  unknownModeCatalog,
  unsupportedModeCatalog,
} from "../fixtures/airbyte/catalogs.js";

/*
 * Catalog import is a description, never an execution. These tests use
 * documents written from the protocol schema in the fixtures directory, and
 * assert the preserved spelling of every field the protocol defines.
 */

const parseMessages = (messages: readonly unknown[]): AirbyteMessage[] =>
  messages.map((message) => airbyteMessageSchema.parse(message));

test("a discovered catalog becomes one sync capability per stream with exact declarations", async () => {
  const result = await readAirbyteCatalog(
    postgresSpecification,
    discoveredCatalog,
  );
  assert.equal(result.catalogKind, "catalog");
  assert.equal(result.definition.display.ecosystem, "airbyte");
  assert.equal(result.definition.identity.ecosystem, "airbyte");
  assert.equal(result.definition.capabilities.length, 3);
  assert.ok(result.definition.capabilities.every((c) => c.kind === "sync"));

  const users = result.definition.capabilities[0];
  assert.equal(users?.nativeId, "public::users");
  const stream = users?.nativeExtensions?.["airbyte.stream"] as Record<
    string,
    unknown
  >;
  assert.equal(stream.name, "users");
  assert.equal(stream.namespace, "public");
  assert.deepEqual(stream.supported_sync_modes, [
    "full_refresh",
    "incremental",
  ]);
  assert.equal(stream.source_defined_cursor, true);
  assert.deepEqual(stream.default_cursor_field, ["updated_at"]);
  assert.deepEqual(stream.source_defined_primary_key, [["id"]]);
  assert.deepEqual(
    stream.json_schema,
    discoveredCatalog.streams[0]?.json_schema,
  );

  // A stream without a namespace keeps its bare name, not an invented one.
  assert.equal(result.definition.capabilities[2]?.nativeId, "audit_log");
  assert.deepEqual(
    result.streams.map((item) => item.supportedSyncModes),
    [["full_refresh", "incremental"], ["incremental"], ["full_refresh"]],
  );
  // Import alone never claims invoke or delegate.
  assert.equal(
    result.definition.compatibility.dimensions.invoke,
    "unsupported",
  );
  assert.equal(
    result.definition.compatibility.dimensions.delegate,
    "requires-configuration",
  );
  assert.deepEqual(result.executableCandidates, []);
});

test("the connector specification travels as inert native extension data", async () => {
  const result = await readAirbyteCatalog(
    postgresSpecification,
    discoveredCatalog,
  );
  const spec = result.definition.nativeExtensions["airbyte.spec"] as Record<
    string,
    unknown
  >;
  assert.deepEqual(
    spec.connectionSpecification,
    postgresSpecification.connectionSpecification,
  );
  assert.deepEqual(spec.supported_destination_sync_modes, [
    "overwrite",
    "append",
    "append_dedup",
  ]);
  assert.equal(result.definition.identity.nativeVersion, "0.3.2");
  // A specification is not an authentication method for the deployment API.
  assert.deepEqual(
    result.definition.authentication.map((profile) => profile.kind),
    ["http-bearer"],
  );
});

test("a catalog without a specification is imported with an explicit diagnostic", async () => {
  const result = await readAirbyteCatalog(undefined, discoveredCatalog);
  const codes = result.issues.map((issue) => issue.code);
  assert.ok(codes.includes("airbyte.spec.missing"));
  assert.equal(result.definition.identity.nativeVersion, "unversioned");
});

test("a configured catalog preserves sync modes, cursor and key exactly", async () => {
  const result = await readAirbyteCatalog(
    postgresSpecification,
    configuredCatalog,
  );
  assert.equal(result.catalogKind, "configured");
  const configured = result.definition.capabilities[0]?.nativeExtensions?.[
    "airbyte.configured"
  ] as Record<string, unknown>;
  assert.equal(configured.sync_mode, "incremental");
  assert.equal(configured.destination_sync_mode, "append_dedup");
  assert.deepEqual(configured.cursor_field, ["updated_at"]);
  assert.deepEqual(configured.primary_key, [["id"]]);
  assert.equal(configured.generation_id, 7);
  assert.equal(configured.minimum_generation_id, 7);
  assert.equal(configured.sync_id, 41);
  assert.deepEqual(result.executableCandidates, ["public::users", "audit_log"]);
});

test("AC-EXT-13: a configured mode the stream does not support blocks that stream only", async () => {
  const result = await readAirbyteCatalog(
    postgresSpecification,
    unsupportedModeCatalog,
  );
  const blocking = result.issues.filter(
    (issue) => issue.severity === "blocking",
  );
  assert.equal(blocking.length, 1);
  assert.equal(blocking[0]?.code, "airbyte.sync-mode.unsupported");
  assert.equal(blocking[0]?.disposition, "rejected");
  assert.equal(blocking[0]?.executionImpact, "blocks-operation");
  assert.equal(blocking[0]?.sourcePointer, "/streams/0/sync_mode");

  // The rejected stream is still described, and the valid one stays executable.
  assert.equal(result.definition.capabilities.length, 2);
  assert.deepEqual(
    result.streams.map((item) => [item.nativeId, item.executable]),
    [
      ["audit_log", false],
      ["public::users", true],
    ],
  );
  assert.deepEqual(result.executableCandidates, ["public::users"]);
  // The requested mode is never rewritten to a supported one.
  const configured = result.definition.capabilities[0]?.nativeExtensions?.[
    "airbyte.configured"
  ] as Record<string, unknown>;
  assert.equal(configured.sync_mode, "incremental");
});

test("AC-EXT-13: a mode outside the protocol vocabulary is rejected, not coerced", async () => {
  const result = await readAirbyteCatalog(undefined, unknownModeCatalog);
  const codes = result.issues
    .filter((issue) => issue.severity === "blocking")
    .map((issue) => issue.code);
  assert.deepEqual(codes, [
    "airbyte.sync-mode.unknown",
    "airbyte.sync-mode.unknown",
  ]);
  const stream = result.definition.capabilities[0]?.nativeExtensions?.[
    "airbyte.stream"
  ] as Record<string, unknown>;
  assert.deepEqual(stream.supported_sync_modes, ["full_refresh", "cdc_only"]);
  assert.deepEqual(result.executableCandidates, []);
});

test("incremental without a cursor and dedup without a key are blocked", async () => {
  const result = await readAirbyteCatalog(undefined, {
    streams: [
      {
        stream: {
          name: "events",
          json_schema: { type: "object" },
          supported_sync_modes: ["incremental"],
          source_defined_cursor: false,
        },
        sync_mode: "incremental",
        destination_sync_mode: "append_dedup",
      },
    ],
  });
  const codes = result.issues
    .filter((issue) => issue.severity === "blocking")
    .map((issue) => issue.code)
    .sort();
  assert.deepEqual(codes, [
    "airbyte.cursor.missing",
    "airbyte.primary-key.missing",
  ]);
});

test("streams differing only by namespace do not collide after import", async () => {
  const result = await readAirbyteCatalog(undefined, collidingCatalog);
  assert.deepEqual(
    result.definition.capabilities.map((item) => item.nativeId),
    ["shop_a::orders", "shop_b::orders"],
  );
  assert.equal(
    result.issues.filter((issue) => issue.severity === "blocking").length,
    0,
  );
});

test("an exact duplicate stream identity is preserved but not executable", async () => {
  const result = await readAirbyteCatalog(undefined, {
    streams: [
      {
        name: "orders",
        namespace: "shop",
        json_schema: { type: "object" },
        supported_sync_modes: ["full_refresh"],
      },
      {
        name: "orders",
        namespace: "shop",
        json_schema: { type: "object" },
        supported_sync_modes: ["full_refresh"],
      },
    ],
  });
  assert.deepEqual(
    result.definition.capabilities.map((item) => item.nativeId),
    ["shop::orders", "shop::orders#2"],
  );
  assert.equal(
    result.issues.find(
      (issue) => issue.code === "airbyte.stream.identity-collision",
    )?.severity,
    "blocking",
  );
});

test("a mixed or malformed catalog is refused within bounds", async () => {
  await assert.rejects(
    () =>
      readAirbyteCatalog(undefined, {
        streams: [
          {
            name: "a",
            json_schema: {},
            supported_sync_modes: ["full_refresh"],
          },
          {
            stream: {
              name: "b",
              json_schema: {},
              supported_sync_modes: ["full_refresh"],
            },
            sync_mode: "full_refresh",
            destination_sync_mode: "append",
          },
        ],
      }),
    (error: unknown) =>
      error instanceof ConnectorError &&
      error.detail === "airbyte.catalog.mixed-shapes",
  );
  await assert.rejects(
    () => readAirbyteCatalog(undefined, { streams: "not-an-array" }),
    (error: unknown) => error instanceof ConnectorError,
  );
});

test("a catalog carrying reserved object keys is refused without mutating anything", async () => {
  const hostile = JSON.parse(
    '{"streams":[{"name":"x","json_schema":{"__proto__":{"polluted":true}},"supported_sync_modes":["full_refresh"]}]}',
  ) as unknown;
  await assert.rejects(
    () => readAirbyteCatalog(undefined, hostile),
    (error: unknown) =>
      error instanceof ConnectorError && error.code === "invalid-request",
  );
  assert.equal(
    ({} as Record<string, unknown>).polluted,
    undefined,
    "no prototype was mutated",
  );
});

test("protocol messages are read without surfacing connector prose", () => {
  const report = readAirbyteMessages([
    ...completeSyncMessages,
    checkSucceeded,
    checkFailed,
  ]);
  assert.equal(report.counts.RECORD, 3);
  assert.equal(report.counts.STATE, 2);
  assert.equal(report.counts.CONNECTION_STATUS, 2);
  assert.equal(report.records.total, 3);
  assert.deepEqual(
    report.records.byStream.map((item) => [item.name, item.count]),
    [
      ["users", 2],
      ["events", 1],
    ],
  );
  // The last status wins and only the status survives; the message does not.
  assert.deepEqual(report.connectionStatus, { status: "FAILED" });
  assert.equal(JSON.stringify(report).includes("SHOULD-NOT-LEAK"), false);
  // The failure prose (which quoted a password) is dropped entirely; only the
  // declared specification schema, which legitimately names a password field,
  // survives as inert description.
  assert.equal(
    JSON.stringify(report.connectionStatus).includes("password"),
    false,
  );
  assert.equal(JSON.stringify(report.traces).includes("password"), false);
});

test("non-protocol lines in a transcript are counted, not parsed as messages", () => {
  const report = readAirbyteMessages(noisyTranscript);
  assert.equal(report.ignoredLines, 1);
  assert.equal(report.counts.SPEC, 1);
  assert.equal(report.counts.RECORD, 1);
  assert.equal(report.counts.STATE, 1);
});

test("trace errors are reduced to failure type and stream, never text", () => {
  const report = readAirbyteMessages(partialSyncMessages);
  assert.deepEqual(report.traces.errors, [
    {
      failureType: "transient_error",
      stream: { name: "users", namespace: "public" },
    },
  ]);
  assert.equal(JSON.stringify(report).includes("SHOULD-NOT-LEAK"), false);
});

test("stream checkpoints keep their descriptor identity and stay frozen", () => {
  const checkpoints = airbyteCheckpoints(parseMessages(completeSyncMessages));
  const users = checkpoints.streams.get(
    streamKey({ name: "users", namespace: "public" }),
  );
  assert.deepEqual(users?.descriptor, { name: "users", namespace: "public" });
  assert.equal(users?.stateType, "STREAM");
  assert.deepEqual(users?.state, { updated_at: "2026-09-02T00:00:00Z" });
  assert.deepEqual(users?.sourceStats, {
    recordCount: 2,
    rejectedRecordCount: 0,
  });
  assert.ok(Object.isFrozen(users?.state));
  assert.throws(() => {
    (users?.state as Record<string, unknown>).updated_at = "tampered";
  });
  // A stream with the same name in another namespace is a different checkpoint.
  assert.equal(
    checkpoints.streams.has(streamKey({ name: "users", namespace: "other" })),
    false,
  );
});

test("global state keeps the shared position and each stream position", () => {
  const checkpoints = airbyteCheckpoints(parseMessages(globalStateMessages));
  assert.deepEqual(checkpoints.global?.sharedState, { lsn: "0/1A2B3C4D" });
  assert.equal(checkpoints.streams.size, 2);
  assert.equal(
    checkpoints.streams.get(streamKey({ name: "users", namespace: "public" }))
      ?.stateType,
    "GLOBAL",
  );
  assert.deepEqual(
    checkpoints.streams.get(
      streamKey({ name: "events", namespace: "analytics" }),
    )?.state,
    { cursor: "e9" },
  );
});

test("legacy state is preserved whole and not converted to per-stream state", () => {
  const checkpoints = airbyteCheckpoints(parseMessages(legacyStateMessages));
  assert.deepEqual(checkpoints.legacy?.data, { cdc_lsn: 4242 });
  assert.equal(checkpoints.streams.size, 0);
  assert.ok(Object.isFrozen(checkpoints.legacy?.data));
});

test("AC-EXT-13: a restart resumes from the checkpoint and reports the replay window", () => {
  const checkpoints = airbyteCheckpoints(parseMessages(partialSyncMessages));
  const plan = planAirbyteRestart(checkpoints);
  assert.equal(plan.carriesState, false);

  const users = plan.streams.find((item) => item.descriptor.name === "users");
  assert.equal(users?.resumeFrom, "checkpoint");
  assert.equal(users?.replayAtLeast, 2, "records after the last checkpoint");
  assert.equal(users?.partial, true);
  assert.deepEqual(users?.descriptor, { name: "users", namespace: "public" });

  const events = plan.streams.find((item) => item.descriptor.name === "events");
  assert.equal(events?.resumeFrom, "beginning");
  assert.equal(events?.replayAtLeast, 1);
  assert.deepEqual(events?.descriptor, {
    name: "events",
    namespace: "analytics",
  });

  // The checkpoint itself is untouched by planning a restart.
  const before = structuredClone(
    checkpoints.streams.get(streamKey({ name: "users", namespace: "public" }))
      ?.state,
  );
  planAirbyteRestart(checkpoints);
  assert.deepEqual(
    checkpoints.streams.get(streamKey({ name: "users", namespace: "public" }))
      ?.state,
    before,
  );
});

test("message reading is bounded", () => {
  assert.throws(
    () =>
      readAirbyteMessages(
        Array.from({ length: 5 }, () => completeSyncMessages[2]) as unknown[],
        { maxMessages: 2 },
      ),
    (error: unknown) =>
      error instanceof ConnectorError &&
      error.detail === "airbyte.messages.too-many",
  );
  assert.throws(
    () => readAirbyteMessages("x".repeat(64), { maxBytes: 8 }),
    (error: unknown) =>
      error instanceof ConnectorError &&
      error.detail === "airbyte.messages.too-large",
  );
});
