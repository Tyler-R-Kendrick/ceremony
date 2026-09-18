import assert from "node:assert/strict";
import { test } from "node:test";
import { ConnectorError } from "../../../src/server/connectors/errors.js";
import {
  assertEndpointLocation,
  assertResourceMatches,
  connectionResourceName,
  createGoogleConnectorsClient,
  GoogleTransportUncertain,
} from "../../../src/server/connectors/providers/google-integration-connectors/index.js";
import { startGoogleConnectorsDouble } from "../doubles/google-connectors.js";
import {
  ACCESS_TOKEN,
  ACTION,
  CONNECTION,
  ENTITY_TYPE,
  LOCATION,
  PROJECT,
  RESOURCE_NAME,
} from "./support.js";

/*
 * The client against an independent double built from the published discovery
 * documents: documented paths, documented paging, and the resource name the
 * binding pinned rather than anything a caller could supply.
 */

const resource = {
  project: PROJECT,
  location: LOCATION,
  connection: CONNECTION,
};

async function withDouble<T>(
  options: Partial<Parameters<typeof startGoogleConnectorsDouble>[0]>,
  work: (
    double: Awaited<ReturnType<typeof startGoogleConnectorsDouble>>,
  ) => Promise<T>,
): Promise<T> {
  const double = await startGoogleConnectorsDouble({
    tokens: [ACCESS_TOKEN],
    resource,
    entityTypes: [
      {
        entity: ENTITY_TYPE,
        operations: ["LIST", "GET"],
        fields: [
          { name: "Id", dataType: "STRING", key: true },
          { name: "Payload", dataType: "JAVA_OBJECT" },
        ],
      },
      { entity: "Ledger", operations: [] },
    ],
    actions: [{ action: ACTION, description: "Send an email" }],
    entities: {
      [ENTITY_TYPE]: [
        { id: "001", Name: "Acme" },
        { id: "002", Name: "Globex" },
        { id: "003", Name: "Initech" },
      ],
    },
    ...options,
  });
  try {
    return await work(double);
  } finally {
    await double.close();
  }
}

function clientFor(origin: string, token = ACCESS_TOKEN) {
  return createGoogleConnectorsClient({
    adminBaseUrl: origin,
    runtimeBaseUrl: origin,
    fetch: globalThis.fetch,
    now: Date.now,
    token: async () => token,
  });
}

test("reads connections, schema metadata and runtime metadata on their documented paths", async () => {
  await withDouble({}, async (double) => {
    const client = clientFor(double.origin);
    const connections = await client.listConnections(resource, {});
    assert.deepEqual(
      connections.connections.map((item) => item.name),
      [RESOURCE_NAME],
    );
    const connection = await client.getConnection(resource);
    assert.equal(connection.status?.state, "ACTIVE");
    const entityTypes = await client.listEntityTypeMetadata(resource, {});
    assert.deepEqual(
      entityTypes.entityTypes.map((item) => item.entity),
      [ENTITY_TYPE, "Ledger"],
    );
    const actions = await client.listActionMetadata(resource, {});
    assert.deepEqual(
      actions.actions.map((item) => item.action),
      [ACTION],
    );
    assert.deepEqual(
      double.requests.map((request) => request.url.pathname),
      [
        `/v1/${RESOURCE_NAME.replace(`/connections/${CONNECTION}`, "/connections")}`,
        `/v1/${RESOURCE_NAME}`,
        `/v1/${RESOURCE_NAME}/connectionSchemaMetadata:listEntityTypes`,
        `/v1/${RESOURCE_NAME}/connectionSchemaMetadata:listActions`,
      ],
    );
    for (const request of double.requests)
      assert.equal(request.headers["authorization"], `Bearer ${ACCESS_TOKEN}`);
  });
});

test("entity listing preserves paging and the connector's own ordering and conditions", async () => {
  await withDouble({}, async (double) => {
    const client = clientFor(double.origin);
    const first = await client.listEntities(resource, ENTITY_TYPE, {
      pageSize: 2,
      sortBy: ["Name"],
      sortOrder: "DESC",
      conditions: "Name != 'x'",
    });
    assert.equal(first.entities.length, 2);
    assert.ok(first.nextPageToken);
    const second = await client.listEntities(resource, ENTITY_TYPE, {
      pageSize: 2,
      pageToken: first.nextPageToken!,
    });
    assert.deepEqual(
      [...first.entities, ...second.entities].map(
        (entity) => entity.fields?.["Name"],
      ),
      ["Acme", "Globex", "Initech"],
    );
    assert.deepEqual(double.entityQueries[0], {
      entityType: ENTITY_TYPE,
      pageSize: "2",
      pageToken: null,
      sortBy: ["Name"],
      sortOrder: "DESC",
      conditions: "Name != 'x'",
    });
    assert.equal(second.nextPageToken, undefined);
  });
});

test("an entity id is encoded once into its own segment and cannot escape the collection", async () => {
  await withDouble(
    { entities: { [ENTITY_TYPE]: [{ id: "a/b", Name: "Slashy" }] } },
    async (double) => {
      const client = clientFor(double.origin);
      const entity = await client.getEntity(resource, ENTITY_TYPE, "a/b");
      assert.equal(entity.fields?.["Name"], "Slashy");
      const request = double.requests.at(-1)!;
      assert.ok(
        request.url.pathname.endsWith("/entities/a%2Fb"),
        `expected an encoded segment, saw ${request.url.pathname}`,
      );
    },
  );
});

test("executing an action sends only its parameters and never an executionConfig", async () => {
  await withDouble({}, async (double) => {
    const client = clientFor(double.origin);
    const result = await client.executeAction(resource, ACTION, {
      to: "person@example.invalid",
    });
    assert.deepEqual(result.results, [{ status: "ok" }]);
    assert.deepEqual(double.executed, [
      { action: ACTION, parameters: { to: "person@example.invalid" } },
    ]);
    const body = JSON.parse(
      double.requests.at(-1)!.body.toString("utf8"),
    ) as Record<string, unknown>;
    assert.deepEqual(Object.keys(body), ["parameters"]);
  });
});

test("a dropped or unavailable execute is uncertain, never a clean failure", async () => {
  await withDouble({ faults: { dropExecuteAt: 1 } }, async (double) => {
    const client = clientFor(double.origin);
    await assert.rejects(
      client.executeAction(resource, ACTION, {}),
      (error: unknown) => error instanceof GoogleTransportUncertain,
    );
  });
  await withDouble({ faults: { failExecuteAt: 1 } }, async (double) => {
    const client = clientFor(double.origin);
    await assert.rejects(
      client.executeAction(resource, ACTION, {}),
      (error: unknown) =>
        error instanceof GoogleTransportUncertain &&
        error.detail === "google-connectors.upstream-status",
    );
  });
});

test("missing, rejected and unauthorized credentials keep distinct codes", async () => {
  await withDouble({}, async (double) => {
    const missing = createGoogleConnectorsClient({
      adminBaseUrl: double.origin,
      runtimeBaseUrl: double.origin,
      fetch: globalThis.fetch,
      now: Date.now,
      token: async () => undefined,
    });
    await assert.rejects(
      missing.getConnection(resource),
      (error: unknown) =>
        error instanceof ConnectorError &&
        error.code === "configuration-required",
    );
    assert.equal(double.requests.length, 0);
    await assert.rejects(
      clientFor(double.origin, "not-the-token").getConnection(resource),
      (error: unknown) =>
        error instanceof ConnectorError &&
        error.code === "expired" &&
        error.detail === "google-connectors.credentials.rejected",
    );
  });
  await withDouble({ faults: { permissionDenied: true } }, async (double) => {
    await assert.rejects(
      clientFor(double.origin).getConnection(resource),
      (error: unknown) =>
        error instanceof ConnectorError &&
        error.code === "denied" &&
        error.detail === "google-connectors.permission-denied",
    );
  });
});

test("a connection in another project is refused by the service and never assumed", async () => {
  await withDouble({}, async (double) => {
    const client = clientFor(double.origin);
    await assert.rejects(
      client.getConnection({ ...resource, connection: "someone-elses" }),
      (error: unknown) =>
        error instanceof ConnectorError && error.code === "denied",
    );
  });
});

test("resource names and regional endpoints are checked before a request is built", () => {
  assert.equal(connectionResourceName(resource), RESOURCE_NAME);
  assert.throws(
    () =>
      assertResourceMatches(
        resource,
        "projects/other/locations/x/connections/y",
      ),
    (error: unknown) =>
      error instanceof ConnectorError &&
      error.code === "denied" &&
      error.detail === "google-connectors.resource.substituted",
  );
  const regional = {
    id: "runtime",
    origin: "https://connectors.us-central1.rep.googleapis.com",
    network: "public" as const,
  };
  assertEndpointLocation(regional, "us-central1");
  assert.throws(
    () => assertEndpointLocation(regional, "europe-west1"),
    (error: unknown) =>
      error instanceof ConnectorError &&
      error.code === "denied" &&
      error.detail === "google-connectors.location.mismatch",
  );
  assertEndpointLocation(
    {
      id: "admin",
      origin: "https://connectors.googleapis.com",
      network: "public",
    },
    "europe-west1",
  );
});
