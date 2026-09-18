import type {
  AirbyteDoubleConnection,
  AirbyteDoubleSource,
} from "../../doubles/airbyte-api.js";

/*
 * A deployment the Airbyte API double serves: one Postgres source, one
 * connection whose streams are configured with the API's own sync-mode
 * vocabulary (`incremental_append`, `full_refresh_overwrite`, ...), and the
 * opaque checkpoints the platform holds for it. Ids are fixed UUIDs so tests
 * can assert exact target binding.
 */

export const workspaceId = "9d2e8a10-6b7f-4d21-9f3a-2f0a1b2c3d4e";
export const sourceId = "1f0f8cf2-51f8-4f6b-9a6e-2b9c3d4e5f60";
export const destinationId = "2a1b3c4d-5e6f-4071-8293-a4b5c6d7e8f9";
export const connectionId = "3b2c4d5e-6f70-4182-93a4-b5c6d7e8f901";
export const otherConnectionId = "4c3d5e6f-7081-4293-a4b5-c6d7e8f90123";

export const postgresSource: AirbyteDoubleSource = {
  sourceId,
  name: "Warehouse Postgres",
  sourceType: "postgres",
  workspaceId,
  streams: [
    {
      streamName: "users",
      syncModes: [
        "full_refresh_overwrite",
        "full_refresh_append",
        "incremental_append",
        "incremental_deduped_history",
      ],
      defaultCursorField: ["updated_at"],
      sourceDefinedCursorField: true,
      sourceDefinedPrimaryKey: [["id"]],
      propertyFields: [["id"], ["email"], ["updated_at"]],
    },
    {
      streamName: "audit_log",
      syncModes: ["full_refresh_overwrite"],
      sourceDefinedCursorField: false,
      propertyFields: [["line"]],
    },
  ],
};

/** A source the deployment cannot reach; discovery fails rather than reporting success. */
export const unreachableSource: AirbyteDoubleSource = {
  sourceId: "5d4e6f70-8192-43a4-b5c6-d7e8f9012345",
  name: "Offline MySQL",
  sourceType: "mysql",
  workspaceId,
  reachable: false,
};

export const warehouseConnection: AirbyteDoubleConnection = {
  connectionId,
  name: "Postgres to Snowflake",
  sourceId,
  destinationId,
  workspaceId,
  status: "active",
  streams: [
    {
      name: "users",
      syncMode: "incremental_deduped_history",
      cursorField: ["updated_at"],
      primaryKey: [["id"]],
    },
    { name: "audit_log", syncMode: "full_refresh_overwrite" },
  ],
  state: {
    users: { updated_at: "2026-09-02T00:00:00Z" },
    audit_log: null,
  },
};

/** A second connection in the same workspace, never permitted by the test binding. */
export const foreignConnection: AirbyteDoubleConnection = {
  connectionId: otherConnectionId,
  name: "Stripe to Snowflake",
  sourceId: "6e5f7081-9203-44b5-c6d7-e8f901234567",
  destinationId,
  workspaceId,
  status: "active",
  streams: [{ name: "charges", syncMode: "incremental_append" }],
  state: { charges: { created: 1_700_000_000 } },
};
