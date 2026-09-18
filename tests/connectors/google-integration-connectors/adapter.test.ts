import assert from "node:assert/strict";
import { test } from "node:test";
import {
  ConnectorAdapterRegistry,
  type AdapterCallContext,
} from "../../../src/server/connectors/adapter.js";
import { ConnectorError } from "../../../src/server/connectors/errors.js";
import { catalogEntryFor } from "../../../src/server/connectors/inventory.js";
import {
  createGoogleConnectorsAdapter,
  GOOGLE_CONNECTORS_ADAPTER_ID,
  googleConnectorsConfigurationNames,
} from "../../../src/server/connectors/providers/google-integration-connectors/index.js";
import {
  startGoogleConnectorsDouble,
  type GoogleDoubleOptions,
} from "../doubles/google-connectors.js";
import {
  ACCESS_TOKEN,
  ACTION,
  CONNECTION,
  END_USER_TOKEN,
  ENTITY_TYPE,
  LOCATION,
  PROJECT,
  RESOURCE_NAME,
  googleBinding,
  googleConnection,
  googleContext,
  googlePorts,
} from "./support.js";

/*
 * The adapter against the loopback double. The theme of these tests is
 * authority: the project, location and connection are the host's, the entity
 * type and action are the reviewer's, and the identity is the binding's.
 * Nothing a caller passes can change any of them.
 */

const adapter = createGoogleConnectorsAdapter();
const resource = { project: PROJECT, location: LOCATION, connection: CONNECTION };

async function withDouble<T>(
  options: Partial<GoogleDoubleOptions>,
  work: (
    double: Awaited<ReturnType<typeof startGoogleConnectorsDouble>>,
  ) => Promise<T>,
): Promise<T> {
  const double = await startGoogleConnectorsDouble({
    tokens: [ACCESS_TOKEN, END_USER_TOKEN],
    resource,
    entityTypes: [
      {
        entity: ENTITY_TYPE,
        operations: ["LIST", "GET"],
        fields: [
          { name: "Id", dataType: "STRING", key: true },
          { name: "Blob", dataType: "JAVA_OBJECT" },
        ],
      },
      { entity: "Ledger", operations: [] },
    ],
    actions: [{ action: ACTION, description: "Send an email" }],
    entities: {
      [ENTITY_TYPE]: [
        { id: "001", Name: "Acme" },
        { id: "002", Name: "Globex" },
      ],
    },
    unsupportedTypeNames: ["Attachment"],
    unsupportedActionNames: ["BulkUpsert"],
    ...options,
  });
  try {
    return await work(double);
  } finally {
    await double.close();
  }
}

function contextFor(
  origin: string,
  ports = googlePorts(),
  binding = googleBinding({ origin }),
  connection = googleConnection(),
): AdapterCallContext {
  return googleContext(binding, ports, { connection });
}

test("the catalog entry is provider-backed and names its unsupported dimensions", () => {
  const registry = new ConnectorAdapterRegistry();
  registry.register(adapter);
  assert.equal(
    registry.require(GOOGLE_CONNECTORS_ADAPTER_ID).ecosystem,
    "google-integration-connectors",
  );
  const present = new Set([googleConnectorsConfigurationNames.accessToken]);
  const rows = adapter.capabilities(present);
  assert.equal(rows.length, 12);
  const byDimension = new Map(rows.map((row) => [row.dimension, row]));
  for (const dimension of [
    "discover",
    "import",
    "verify",
    "invoke",
    "disconnect",
  ] as const)
    assert.equal(byDimension.get(dimension)?.implementation, "implemented");
  for (const dimension of [
    "configure",
    "authorize",
    "events",
    "reconnect",
    "revoke",
    "export",
    "delegate",
  ] as const) {
    assert.equal(byDimension.get(dimension)?.implementation, "unsupported");
    assert.ok((byDimension.get(dimension)?.limitations.length ?? 0) > 0);
  }
  assert.equal(catalogEntryFor(adapter, present).support, "provider-backed");
  assert.equal(catalogEntryFor(adapter, new Set()).support, "unconfigured");
});

test("without a token nothing is attempted and every path is configuration-required", async () => {
  await withDouble({}, async (double) => {
    const ctx = contextFor(
      double.origin,
      googlePorts({
        [googleConnectorsConfigurationNames.accessToken]: undefined,
      }),
    );
    const started = await adapter.authorize!(ctx, {
      ownerKind: "workload",
      requestedPermissions: [],
      accountSwitch: false,
      interruption: "allowed",
    });
    assert.equal(started.kind, "configuration-required");
    for (const attempt of [
      () => adapter.verify!(ctx),
      () =>
        adapter.invoke!(ctx, {
          operationRef: "operation:accounts.list",
          input: {},
          commandId: "command-1",
        }),
      () => adapter.discover!(ctx, {}),
    ])
      await assert.rejects(
        attempt(),
        (error: unknown) =>
          error instanceof ConnectorError &&
          error.code === "configuration-required",
      );
    assert.equal(double.requests.length, 0);
  });
});

test("an expired workload token fails before the request rather than as an upstream error", async () => {
  await withDouble({}, async (double) => {
    const ctx = contextFor(
      double.origin,
      googlePorts({
        [googleConnectorsConfigurationNames.expiresAt]:
          "2026-09-18T00:00:00.000Z",
      }),
    );
    await assert.rejects(
      adapter.verify!(ctx),
      (error: unknown) =>
        error instanceof ConnectorError &&
        error.code === "expired" &&
        error.detail === "google-connectors.credentials.expired",
    );
    assert.equal(double.requests.length, 0);
  });
});

test("discovery lists connections and reports capability availability per connection", async () => {
  await withDouble({}, async (double) => {
    const ctx = contextFor(double.origin);
    const connections = await adapter.discover!(ctx, {});
    assert.deepEqual(
      connections.items.map((item) => item.identity.nativeId),
      [RESOURCE_NAME],
    );
    assert.equal(connections.items[0]?.identity.authorityNamespace, LOCATION);
    const capabilities = await adapter.discover!(ctx, {
      scope: { connection: CONNECTION },
    });
    assert.deepEqual(
      capabilities.items.map((item) => item.provenance?.["nativeId"]),
      [ENTITY_TYPE, ACTION],
      "an entity type with no operations is not offered as a capability",
    );
    assert.equal(
      capabilities.items[0]?.provenance?.["operations"],
      "LIST,GET",
    );
    const codes = capabilities.issues.map((issue) => issue.code);
    for (const code of [
      "google-connectors.entity-type.unsupported-datatype",
      "google-connectors.action.unsupported-datatype",
      "google-connectors.entity-type.no-operations",
      "google-connectors.field.opaque-datatype",
    ])
      assert.ok(codes.includes(code), `expected issue ${code}`);
  });
});

test("a caller-supplied connection name is refused before any request", async () => {
  await withDouble({}, async (double) => {
    const ctx = contextFor(double.origin);
    await assert.rejects(
      adapter.discover!(ctx, { scope: { connection: "someone-elses" } }),
      (error: unknown) =>
        error instanceof ConnectorError &&
        error.code === "denied" &&
        error.detail === "google-connectors.connection.not-permitted",
    );
    assert.equal(double.requests.length, 0);
  });
});

test("import records what the connection can do and what it cannot", async () => {
  await withDouble({}, async (double) => {
    const ctx = contextFor(double.origin);
    const captured = {
      connection: {
        name: RESOURCE_NAME,
        description: "Salesforce orders",
        status: { state: "ACTIVE" },
        connectionRevision: "7",
        asyncOperationsEnabled: true,
        authOverrideEnabled: true,
        fallbackOnAdminCredentials: true,
        eventingEnablementType: "EVENTING_AND_CONNECTION",
        serviceDirectory: "projects/p/locations/l/namespaces/n/services/s",
      },
      entityTypes: [
        { entity: ENTITY_TYPE, operations: ["LIST", "GET"], fields: [] },
        { entity: "Ledger", operations: [], fields: [] },
      ],
      actions: [{ action: ACTION, inputParameters: [], resultMetadata: [] }],
      unsupportedTypeNames: ["Attachment"],
      unsupportedActionNames: ["BulkUpsert"],
    };
    const outcome = await adapter.import!(ctx, {
      bytes: new TextEncoder().encode(JSON.stringify(captured)),
      mediaType: "application/json",
      origin: { kind: "provider-api" },
    });
    const [definition] = outcome.definitions;
    assert.ok(definition);
    assert.deepEqual(
      definition.capabilities.map(
        (capability) => `${capability.kind}:${capability.nativeId}`,
      ),
      [`entity:${ENTITY_TYPE}`, `action:${ACTION}`],
    );
    assert.equal(definition.identity.nativeId, RESOURCE_NAME);
    assert.equal(definition.authentication[0]?.kind, "http-bearer");
    const codes = outcome.issues.map((issue) => issue.code);
    for (const code of [
      "google-connectors.connection.async-operations",
      "google-connectors.connection.auth-override",
      "google-connectors.connection.admin-fallback",
      "google-connectors.connection.private-endpoint",
      "google-connectors.connection.eventing",
      "google-connectors.entity-type.unsupported-datatype",
      "google-connectors.action.unsupported-datatype",
    ])
      assert.ok(codes.includes(code), `expected issue ${code}`);
    assert.deepEqual(
      definition.nativeExtensions["entityOperations"],
      { [ENTITY_TYPE]: ["LIST", "GET"] },
    );
    assert.ok(
      definition.capabilities.every(
        (capability) => capability.dataClassification === "unknown",
      ),
    );
  });
});

test("verification separates connection access from connector session state", async () => {
  await withDouble({}, async (double) => {
    const ctx = contextFor(double.origin);
    const result = await adapter.verify!(ctx);
    assert.equal(result.state, "complete");
    assert.deepEqual(
      result.claims.map((claim) => claim.kind),
      ["resource-access", "credential-accepted"],
    );
    assert.equal(result.claims[0]?.target.id, RESOURCE_NAME);
    assert.deepEqual(result.claims[0]?.permissions?.observed, []);
    assert.match(
      result.claims[0]?.limitations[0] ?? "",
      /not to the system behind it/,
    );
    assert.equal(result.adapterState?.["connectorState"], "ACTIVE");
  });
});

test("connector auth failure and pending user authorization keep their own outcomes", async () => {
  await withDouble(
    { faults: { connectorState: "AUTH_ERROR" } },
    async (double) => {
      const result = await adapter.verify!(contextFor(double.origin));
      assert.equal(result.state, "denied");
      assert.equal(result.code, "google-connectors.auth-error");
    },
  );
  await withDouble(
    { connection: { state: "AUTHORIZATION_REQUIRED" } },
    async (double) => {
      const result = await adapter.verify!(contextFor(double.origin));
      assert.equal(result.state, "human-required");
      assert.equal(result.code, "google-connectors.authorization-required");
    },
  );
  await withDouble({ faults: { connectorState: "ERROR" } }, async (double) => {
    const result = await adapter.verify!(contextFor(double.origin));
    assert.equal(result.state, "pending");
    assert.equal(result.code, "google-connectors.connector-not-active");
  });
});

test("an end-user identity is refused on a connection that would fall back to admin credentials", async () => {
  await withDouble(
    {
      connection: {
        authOverrideEnabled: true,
        fallbackOnAdminCredentials: true,
      },
    },
    async (double) => {
      const ports = googlePorts();
      const connection = googleConnection();
      const credentialRef = await ports.credentials.store(
        {
          tenantId: connection.tenantId,
          ownerKind: connection.ownerKind,
          ownerId: connection.ownerId,
          connectionRef: connection.connectionRef,
          bindingRef: "binding:google-connectors",
          custody: connection.custody,
        },
        { accessToken: END_USER_TOKEN },
      );
      const ctx = googleContext(
        googleBinding({
          origin: double.origin,
          identity: { kind: "end-user" },
        }),
        ports,
        { connection: { ...connection, credentialRef } },
      );
      await assert.rejects(
        adapter.verify!(ctx),
        (error: unknown) =>
          error instanceof ConnectorError &&
          error.code === "denied" &&
          error.detail === "google-connectors.admin-fallback",
      );
    },
  );
});

test("a private-endpoint connection may not be bound to a public destination", async () => {
  await withDouble(
    {
      connection: {
        serviceDirectory: "projects/p/locations/l/namespaces/n/services/s",
      },
    },
    async (double) => {
      const binding = googleBinding({ origin: double.origin });
      const publicRuntime = {
        ...binding,
        destinations: binding.destinations.map((destination) =>
          destination.id === "runtime"
            ? { ...destination, network: "public" as const }
            : destination,
        ),
      };
      const ctx = googleContext(publicRuntime, googlePorts(), {
        connection: googleConnection(),
      });
      await assert.rejects(
        adapter.verify!(ctx),
        (error: unknown) =>
          error instanceof ConnectorError &&
          error.code === "network-policy" &&
          error.detail === "google-connectors.private-endpoint",
      );
    },
  );
});

test("an approved entity listing preserves the caller's paging and the connector's ordering", async () => {
  await withDouble({}, async (double) => {
    const ctx = contextFor(double.origin);
    const result = await adapter.invoke!(ctx, {
      operationRef: "operation:accounts.list",
      input: { pageSize: 1, sortBy: ["Name"], sortOrder: "ASC" },
      commandId: "command-list",
    });
    assert.equal(result.state, "complete");
    assert.equal(result.effect, "read");
    const output = result.output as {
      entities: Array<{ fields?: Record<string, unknown> }>;
      nextPageToken?: string;
    };
    assert.equal(output.entities.length, 1);
    assert.ok(output.nextPageToken, "the connector's page token is preserved");
    assert.deepEqual(double.entityQueries.at(-1), {
      entityType: ENTITY_TYPE,
      pageSize: "1",
      pageToken: null,
      sortBy: ["Name"],
      sortOrder: "ASC",
      conditions: null,
    });
  });
});

test("an entity read names its id as input, never as a resource path", async () => {
  await withDouble({}, async (double) => {
    const ctx = contextFor(double.origin);
    const result = await adapter.invoke!(ctx, {
      operationRef: "operation:accounts.get",
      input: { entityId: "002" },
      commandId: "command-get",
    });
    assert.equal(result.state, "complete");
    assert.equal(
      (result.output as { fields?: Record<string, unknown> }).fields?.["Name"],
      "Globex",
    );
  });
});

test("an action execution is journaled, replayed from the journal and never sent twice", async () => {
  await withDouble({}, async (double) => {
    const ports = googlePorts();
    const ctx = contextFor(double.origin, ports);
    const request = {
      operationRef: "operation:sendEmail",
      input: { parameters: { to: "person@example.invalid" } },
      commandId: "command-execute",
    };
    const first = await adapter.invoke!(ctx, request);
    assert.equal(first.state, "complete");
    assert.equal(first.effect, "write");
    assert.equal(ports.inspect.effects()[0]?.outcome?.status, "applied");
    const second = await adapter.invoke!(ctx, request);
    assert.equal(second.state, "complete");
    assert.equal(second.code, "google-connectors.effect.replayed");
    assert.equal(double.executeCount(), 1);
  });
});

test("an uncertain action execution is reported as indeterminate, not as a failure", async () => {
  await withDouble({ faults: { dropExecuteAt: 1 } }, async (double) => {
    const ports = googlePorts();
    const ctx = contextFor(double.origin, ports);
    const result = await adapter.invoke!(ctx, {
      operationRef: "operation:sendEmail",
      input: { parameters: {} },
      commandId: "command-uncertain",
    });
    assert.equal(result.state, "indeterminate");
    assert.equal(result.code, "google-connectors.call.uncertain");
    assert.equal(ports.inspect.effects()[0]?.outcome?.status, "indeterminate");
  });
});

test("an async-enabled connection never has its action result reported as settled work", async () => {
  await withDouble(
    { connection: { asyncOperationsEnabled: true } },
    async (double) => {
      const ports = googlePorts();
      const ctx = googleContext(googleBinding({ origin: double.origin }), ports, {
        connection: googleConnection({ state: { asyncOperations: true } }),
      });
      const result = await adapter.invoke!(ctx, {
        operationRef: "operation:sendEmail",
        input: { parameters: {} },
        commandId: "command-async",
      });
      assert.equal(result.state, "complete");
      assert.equal(result.code, "google-connectors.async-result-unreconciled");
    },
  );
});

test("caller-supplied resource names, execution config and unapproved targets are refused", async () => {
  await withDouble({}, async (double) => {
    const ctx = contextFor(double.origin);
    const substitutions: Array<[Record<string, unknown>, string]> = [
      [{ name: "projects/other/locations/l/connections/c" }, "google-connectors.resource.substituted"],
      [{ project: "other-project" }, "google-connectors.resource.substituted"],
      [{ parent: "projects/other" }, "google-connectors.resource.substituted"],
      [
        { executionConfig: { headers: '{"x-integration-connectors-auth":"x"}' } },
        "google-connectors.execution-config.denied",
      ],
    ];
    for (const [input, detail] of substitutions)
      await assert.rejects(
        adapter.invoke!(ctx, {
          operationRef: "operation:accounts.list",
          input,
          commandId: "command-substitute",
        }),
        (error: unknown) =>
          error instanceof ConnectorError &&
          error.code === "denied" &&
          error.detail === detail,
        `input ${JSON.stringify(input)} should be refused`,
      );

    const otherProject = googleBinding({
      origin: double.origin,
      operations: googleBinding({ origin: double.origin }).operations.map(
        (operation) =>
          operation.operationRef === "operation:accounts.list"
            ? {
                ...operation,
                transport: {
                  kind: "http" as const,
                  method: "GET" as const,
                  pathTemplate: `/v2/projects/other-project/locations/${LOCATION}/connections/${CONNECTION}/entityTypes/${ENTITY_TYPE}/entities`,
                },
              }
            : operation,
      ),
    });
    await assert.rejects(
      adapter.invoke!(
        googleContext(otherProject, googlePorts(), {
          connection: googleConnection(),
        }),
        {
          operationRef: "operation:accounts.list",
          input: {},
          commandId: "command-path",
        },
      ),
      (error: unknown) =>
        error instanceof ConnectorError &&
        error.code === "denied" &&
        error.detail === "google-connectors.operation.path-mismatch",
    );

    const unpermitted = googleBinding({
      origin: double.origin,
      permittedTargets: [{ kind: "connection", id: CONNECTION }],
    });
    await assert.rejects(
      adapter.invoke!(
        googleContext(unpermitted, googlePorts(), {
          connection: googleConnection(),
        }),
        {
          operationRef: "operation:accounts.list",
          input: {},
          commandId: "command-target",
        },
      ),
      (error: unknown) =>
        error instanceof ConnectorError &&
        error.code === "denied" &&
        error.detail === "google-connectors.target.not-permitted",
    );

    await assert.rejects(
      adapter.invoke!(ctx, {
        operationRef: "operation:unapproved",
        input: {},
        commandId: "command-unapproved",
      }),
      (error: unknown) =>
        error instanceof ConnectorError &&
        error.code === "denied" &&
        error.detail === "google-connectors.operation.unapproved",
    );
    assert.equal(
      double.requests.length,
      0,
      "no policy failure reaches the provider",
    );
  });
});

test("an end-user token is used from custody and never appears in a result", async () => {
  await withDouble({}, async (double) => {
    const ports = googlePorts({
      [googleConnectorsConfigurationNames.accessToken]: undefined,
    });
    const connection = googleConnection();
    const credentialRef = await ports.credentials.store(
      {
        tenantId: connection.tenantId,
        ownerKind: connection.ownerKind,
        ownerId: connection.ownerId,
        connectionRef: connection.connectionRef,
        bindingRef: "binding:google-connectors",
        custody: connection.custody,
      },
      { accessToken: END_USER_TOKEN },
    );
    const ctx = googleContext(
      googleBinding({ origin: double.origin, identity: { kind: "end-user" } }),
      ports,
      { connection: { ...connection, credentialRef } },
    );
    const result = await adapter.invoke!(ctx, {
      operationRef: "operation:accounts.list",
      input: {},
      commandId: "command-end-user",
    });
    assert.equal(result.state, "complete");
    assert.ok(!JSON.stringify(result).includes(END_USER_TOKEN));
    assert.equal(
      double.requests.at(-1)?.headers["authorization"],
      `Bearer ${END_USER_TOKEN}`,
    );
  });
});

test("disconnect is local only and never touches the connection in Google Cloud", async () => {
  await withDouble({}, async (double) => {
    const ctx = contextFor(double.origin);
    const result = await adapter.disconnect!(ctx, "upstream");
    assert.equal(result.local, "applied");
    assert.equal(result.upstream, "unsupported");
    assert.equal(double.requests.length, 0);
  });
});
