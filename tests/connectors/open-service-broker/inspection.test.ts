import { test } from "node:test";
import assert from "node:assert/strict";
import { fixtureActor, memoryPorts } from "../doubles/ports.js";
import { startServiceBrokerFixture } from "../doubles/service-broker.js";
import { buildBinding, buildConnectionSummary } from "../fixtures/builders.js";
import type { AdapterCallContext } from "../../../src/server/connectors/adapter.js";
import type { ConnectionRecord } from "../../../src/server/connectors/ports.js";
import { ConnectorError } from "../../../src/server/connectors/errors.js";
import {
  OSB_ADAPTER_ID,
  OSB_OPERATIONS,
  OSB_PASSWORD_CONFIGURATION,
  OSB_USERNAME_CONFIGURATION,
  createOpenServiceBrokerAdapter,
  projectOsbBinding,
} from "../../../src/server/connectors/providers/open-service-broker/index.js";

/*
 * Inspection of things that already exist. Nothing here creates, changes or
 * removes a resource, and the fixture broker records every non-GET request so
 * "no provisioning happened" is asserted rather than asserted-about.
 */

const BROKER_USER = "fixture-platform";
const BROKER_PASSWORD = "fixture-platform-password";
const PG_SERVICE = "5cbd05d2-0f4a-4f0f-bd6c-63f1b8f5f5d1";
const PG_PLAN = "9fb0e0ba-b2ec-4ab9-9d9b-7d98d1b8a0a1";
const CACHE_SERVICE = "0b1f9d8b-4ab0-4f43-8e2c-6a8f2dcd4c10";
const CREDENTIAL_CANARY = "CANARY_BROKER_PASSWORD_7f2";

const services = [
  {
    id: PG_SERVICE,
    name: "fixture-postgres",
    description: "A fixture relational database offering.",
    bindable: true,
    instances_retrievable: true,
    bindings_retrievable: true,
    plans: [
      {
        id: PG_PLAN,
        name: "shared",
        description: "Shared fixture instance.",
        free: true,
      },
    ],
  },
  {
    id: CACHE_SERVICE,
    name: "fixture-opaque-cache",
    description: "A fixture cache whose broker supports no retrieval.",
    bindable: true,
    plans: [
      {
        id: "b6c3a3b0-1f8a-49cd-9bb1-5a3e3f9f1d42",
        name: "standard",
        description: "Standard fixture cache.",
        free: true,
      },
    ],
  },
];

function connectionRecord(
  externalIds: Record<string, string> = {},
): ConnectionRecord {
  return {
    ...buildConnectionSummary({
      connectionRef: "connection:osb",
      bindingRef: "binding:osb",
      definitionRef: "definition:osb",
      ecosystem: "open-service-broker",
      service: "open-service-broker",
      displayName: "Fixture broker",
      lifecycle: "verifying",
      target: undefined,
      verification: undefined,
    }),
    tenantId: fixtureActor.tenantId,
    ownerId: fixtureActor.subjectId,
    authorityInstance: "fixture-broker",
    bindingRevision: 1,
    policyRevision: "policy:1",
    configurationRevision: "cfg:1",
    externalIds,
    evidenceRefs: [],
    state: {},
  };
}

function harness(options: {
  origin: string;
  permittedTargets?: Array<{ kind: string; id: string }>;
  externalIds?: Record<string, string>;
  mutatingBinding?: boolean;
}) {
  const ports = memoryPorts();
  ports.configuration.set(OSB_USERNAME_CONFIGURATION, BROKER_USER);
  ports.configuration.set(OSB_PASSWORD_CONFIGURATION, BROKER_PASSWORD);
  const operationFor = (key: keyof typeof OSB_OPERATIONS, path: string) => ({
    operationRef: OSB_OPERATIONS[key],
    nativeId: key,
    destinationId: "broker",
    transport: {
      kind: "http" as const,
      method:
        options.mutatingBinding && key === "instance"
          ? ("PUT" as const)
          : ("GET" as const),
      pathTemplate: path,
    },
    effect:
      options.mutatingBinding && key === "instance"
        ? ("write" as const)
        : ("read" as const),
    outputClassification: "personal" as const,
    cost: "free" as const,
    consent: "none" as const,
    replay:
      options.mutatingBinding && key === "instance"
        ? ("none" as const)
        : ("read-only" as const),
    targetParameters: ["instanceId"],
  });
  const binding = buildBinding({
    bindingRef: "binding:osb",
    definitionRef: "definition:osb",
    adapterId: OSB_ADAPTER_ID,
    destinations: [
      { id: "broker", origin: options.origin, network: "loopback-fixture" },
    ],
    operations: [
      operationFor("catalog", "/v2/catalog"),
      operationFor("instance", "/v2/service_instances"),
      operationFor("instanceLastOperation", "/v2/service_instances"),
      operationFor("binding", "/v2/service_instances"),
      operationFor("bindingLastOperation", "/v2/service_instances"),
    ],
    configuration: [],
    permittedTargets: options.permittedTargets ?? [],
    settings: {
      broker: {
        destinationId: "broker",
        brokerId: "fixture-broker",
        credentials: {
          kind: "basic",
          usernameConfiguration: OSB_USERNAME_CONFIGURATION,
          passwordConfiguration: OSB_PASSWORD_CONFIGURATION,
        },
        services: services.map((service) => ({
          serviceId: service.id,
          instancesRetrievable: service.instances_retrievable === true,
          bindingsRetrievable: service.bindings_retrievable === true,
          bindable: service.bindable,
        })),
        acceptsIncomplete: false,
      },
    },
    profileId: undefined,
  });
  const ctx: AdapterCallContext = {
    actor: fixtureActor,
    binding,
    connection: connectionRecord(options.externalIds),
    generation: 0,
    signal: AbortSignal.timeout(10_000),
    environment: ports.environment({ fetch: globalThis.fetch }),
  };
  return { ports, binding, ctx };
}

const brokerOptions = {
  services,
  credentials: { username: BROKER_USER, password: BROKER_PASSWORD },
  instances: [
    {
      instanceId: "instance-1",
      serviceId: PG_SERVICE,
      planId: PG_PLAN,
      dashboardUrl: "https://dashboard.fixture.invalid/instance-1",
      parameters: { region: "eu" },
    },
    {
      instanceId: "instance-async",
      serviceId: PG_SERVICE,
      planId: PG_PLAN,
      lastOperation: { state: "in progress" as const, description: "50% done" },
    },
    {
      instanceId: "instance-cache",
      serviceId: CACHE_SERVICE,
      planId: "b6c3a3b0-1f8a-49cd-9bb1-5a3e3f9f1d42",
    },
  ],
  bindings: [
    {
      instanceId: "instance-1",
      bindingId: "binding-1",
      credentials: {
        uri: `postgres://app:${CREDENTIAL_CANARY}@db.fixture.invalid:5432/app`,
        username: "app",
        password: CREDENTIAL_CANARY,
      },
      endpoints: [{ host: "db.fixture.invalid", ports: ["5432"] }],
      expiresAt: "2026-12-31T23:59:59.000Z",
    },
    {
      instanceId: "instance-cache",
      bindingId: "binding-cache",
      credentials: { token: "never-fetched" },
    },
  ],
};

test("an existing instance is inspected and reported without inventing anything", async () => {
  const broker = await startServiceBrokerFixture(brokerOptions);
  try {
    const { ctx } = harness({ origin: broker.origin });
    const adapter = createOpenServiceBrokerAdapter();
    const result = await adapter.invoke!(ctx, {
      operationRef: OSB_OPERATIONS.instance,
      input: { instanceId: "instance-1", serviceId: PG_SERVICE },
      commandId: "command-1",
    });
    assert.equal(result.state, "complete");
    assert.deepEqual(result.output, {
      instanceId: "instance-1",
      serviceId: PG_SERVICE,
      planId: PG_PLAN,
      dashboardUrl: "https://dashboard.fixture.invalid/instance-1",
      parametersPresent: true,
    });
    assert.equal(
      broker.received("GET", "/v2/service_instances/instance-1").length,
      1,
    );
    assert.deepEqual(broker.mutating(), []);
  } finally {
    await broker.close();
  }
});

test("AC-EXT-18: missing optional broker retrieval support is reported, never fabricated", async () => {
  // The OSB clause of AC-EXT-18, and the independent acceptance criterion: an offering that does not declare
  // bindings_retrievable gets a reported native limitation, not an attempt and
  // not a fabricated response. Same for instances_retrievable.
  const broker = await startServiceBrokerFixture(brokerOptions);
  try {
    const { ctx } = harness({ origin: broker.origin });
    const adapter = createOpenServiceBrokerAdapter();
    await assert.rejects(
      () =>
        adapter.invoke!(ctx, {
          operationRef: OSB_OPERATIONS.binding,
          input: {
            instanceId: "instance-cache",
            bindingId: "binding-cache",
            serviceId: CACHE_SERVICE,
          },
          commandId: "command-2",
        }),
      (error: unknown) =>
        error instanceof ConnectorError &&
        error.code === "unsupported" &&
        error.detail === "osb.bindings-not-retrievable",
    );
    await assert.rejects(
      () =>
        adapter.invoke!(ctx, {
          operationRef: OSB_OPERATIONS.instance,
          input: { instanceId: "instance-cache", serviceId: CACHE_SERVICE },
          commandId: "command-3",
        }),
      (error: unknown) =>
        error instanceof ConnectorError &&
        error.code === "unsupported" &&
        error.detail === "osb.instances-not-retrievable",
    );
    assert.equal(
      broker.requests.length,
      0,
      "an unsupported retrieval endpoint is not probed",
    );
  } finally {
    await broker.close();
  }
});

test("no provisioning request occurs in the default profile", async () => {
  // Independent acceptance. Two halves: the adapter refuses a binding that
  // named a mutating method, and across a full inspection run the broker
  // records no non-GET request at all.
  const broker = await startServiceBrokerFixture(brokerOptions);
  try {
    const mutating = harness({ origin: broker.origin, mutatingBinding: true });
    const adapter = createOpenServiceBrokerAdapter();
    await assert.rejects(
      () =>
        adapter.invoke!(mutating.ctx, {
          operationRef: OSB_OPERATIONS.instance,
          input: { instanceId: "instance-1", serviceId: PG_SERVICE },
          commandId: "command-4",
        }),
      (error: unknown) =>
        error instanceof ConnectorError &&
        error.code === "denied" &&
        error.detail === "osb.operation.not-read-only",
    );
    assert.equal(broker.requests.length, 0);

    const { ctx } = harness({ origin: broker.origin });
    await adapter.discover!(ctx, {});
    await adapter.invoke!(ctx, {
      operationRef: OSB_OPERATIONS.instance,
      input: { instanceId: "instance-1", serviceId: PG_SERVICE },
      commandId: "command-5",
    });
    await adapter.invoke!(ctx, {
      operationRef: OSB_OPERATIONS.binding,
      input: {
        instanceId: "instance-1",
        bindingId: "binding-1",
        serviceId: PG_SERVICE,
      },
      commandId: "command-6",
    });
    await adapter.invoke!(ctx, {
      operationRef: OSB_OPERATIONS.instanceLastOperation,
      input: { instanceId: "instance-async", serviceId: PG_SERVICE },
      commandId: "command-7",
    });
    assert.ok(broker.requests.length >= 4);
    assert.deepEqual(broker.mutating(), []);
    assert.deepEqual(broker.provisioningAttempts(), []);
    assert.equal(
      broker.requests.every((request) => request.method === "GET"),
      true,
    );
  } finally {
    await broker.close();
  }
});

test("retrieved binding credentials go into custody and never into a result", async () => {
  const broker = await startServiceBrokerFixture(brokerOptions);
  try {
    const { ctx, ports } = harness({ origin: broker.origin });
    const adapter = createOpenServiceBrokerAdapter();
    const result = await adapter.invoke!(ctx, {
      operationRef: OSB_OPERATIONS.binding,
      input: {
        instanceId: "instance-1",
        bindingId: "binding-1",
        serviceId: PG_SERVICE,
      },
      commandId: "command-8",
    });
    assert.equal(result.state, "complete");
    const output = result.output as Record<string, unknown>;
    assert.deepEqual(output["credentialKeys"], ["password", "uri", "username"]);
    assert.deepEqual(output["endpoints"], [
      { host: "db.fixture.invalid", ports: ["5432"] },
    ]);
    assert.equal(output["expiresAt"], "2026-12-31T23:59:59.000Z");
    assert.equal(
      JSON.stringify(result).includes(CREDENTIAL_CANARY),
      false,
      "no credential value reaches the invocation result",
    );
    // The value is in custody, reachable only through the port.
    const credentialRef = output["credentialRef"] as string;
    assert.ok(credentialRef);
    assert.ok(ports.inspect.credentialRefs().includes(credentialRef));
    assert.equal(
      ports.inspect.credentialMaterial(credentialRef)?.["password"],
      CREDENTIAL_CANARY,
    );
    assert.equal(result.outputClassification, "personal");
  } finally {
    await broker.close();
  }
});

test("the binding projection separates the credential from the connection information", () => {
  const split = projectOsbBinding({
    credentials: { password: CREDENTIAL_CANARY, port: 5432 },
    endpoints: [
      { host: "db.fixture.invalid", ports: ["5432"], protocol: "tcp" },
    ],
    metadata: { expires_at: "2026-12-31T23:59:59.000Z" },
    syslog_drain_url: "https://logs.fixture.invalid/drain",
    volume_mounts: [{}],
  });
  assert.deepEqual(split.projection.credentialKeys, ["password", "port"]);
  assert.equal(split.projection.syslogDrainDeclared, true);
  assert.equal(split.projection.routeServiceDeclared, false);
  assert.equal(split.projection.volumeMountCount, 1);
  assert.equal(
    JSON.stringify(split.projection).includes(CREDENTIAL_CANARY),
    false,
  );
  assert.equal(split.credentials?.["password"], CREDENTIAL_CANARY);
  // A non-string credential value is preserved as text, not dropped.
  assert.equal(split.credentials?.["port"], "5432");
});

test("native asynchronous status is reported as in progress, not as success", async () => {
  const broker = await startServiceBrokerFixture(brokerOptions);
  try {
    const { ctx } = harness({ origin: broker.origin });
    const adapter = createOpenServiceBrokerAdapter();
    const result = await adapter.invoke!(ctx, {
      operationRef: OSB_OPERATIONS.instanceLastOperation,
      input: { instanceId: "instance-async", serviceId: PG_SERVICE },
      commandId: "command-9",
    });
    assert.deepEqual(result.output, { state: "in progress", inProgress: true });
    // The spec makes the fetch endpoint 404 while an operation is in flight;
    // that stays a not-found, never a fabricated instance.
    await assert.rejects(
      () =>
        adapter.invoke!(ctx, {
          operationRef: OSB_OPERATIONS.instance,
          input: { instanceId: "instance-async", serviceId: PG_SERVICE },
          commandId: "command-10",
        }),
      (error: unknown) =>
        error instanceof ConnectorError && error.code === "not-found",
    );
  } finally {
    await broker.close();
  }
});

test("verification records what the broker asserted and names what it does not prove", async () => {
  const broker = await startServiceBrokerFixture(brokerOptions);
  try {
    const { ctx } = harness({
      origin: broker.origin,
      externalIds: { instanceId: "instance-1", serviceId: PG_SERVICE },
    });
    const adapter = createOpenServiceBrokerAdapter();
    const result = await adapter.verify!(ctx);
    assert.equal(result.state, "complete");
    assert.equal(result.claims.length, 1);
    const claim = result.claims[0]!;
    assert.equal(claim.kind, "resource-access");
    assert.equal(claim.issuer, "provider");
    assert.deepEqual(claim.target, {
      kind: "service-instance",
      id: "instance-1",
    });
    assert.ok(claim.limitations.length >= 2);
    assert.match(claim.limitations[0]!, /broker's assertion/);
    assert.equal(claim.permissions, undefined, "no permission is inferred");
    assert.deepEqual(result.target, {
      kind: "service-instance",
      id: "instance-1",
    });
  } finally {
    await broker.close();
  }
});

test("verification of a non-retrievable offering stays pending with the native reason", async () => {
  const broker = await startServiceBrokerFixture(brokerOptions);
  try {
    const { ctx } = harness({
      origin: broker.origin,
      externalIds: { instanceId: "instance-cache", serviceId: CACHE_SERVICE },
    });
    const adapter = createOpenServiceBrokerAdapter();
    const result = await adapter.verify!(ctx);
    assert.equal(result.state, "pending");
    assert.equal(result.code, "osb.instances-not-retrievable");
    assert.deepEqual(result.claims, []);
    assert.equal(broker.requests.length, 0);
  } finally {
    await broker.close();
  }
});

test("an instance outside the connection's permitted targets is refused", async () => {
  const broker = await startServiceBrokerFixture(brokerOptions);
  try {
    const { ctx } = harness({
      origin: broker.origin,
      permittedTargets: [{ kind: "service-instance", id: "instance-1" }],
    });
    const adapter = createOpenServiceBrokerAdapter();
    await assert.rejects(
      () =>
        adapter.invoke!(ctx, {
          operationRef: OSB_OPERATIONS.instance,
          input: { instanceId: "instance-async", serviceId: PG_SERVICE },
          commandId: "command-11",
        }),
      (error: unknown) =>
        error instanceof ConnectorError &&
        error.code === "denied" &&
        error.detail === "osb.target.unpermitted",
    );
    assert.equal(broker.requests.length, 0);
  } finally {
    await broker.close();
  }
});

test("an offering the reviewed binding does not list is refused", async () => {
  const broker = await startServiceBrokerFixture(brokerOptions);
  try {
    const { ctx } = harness({ origin: broker.origin });
    const adapter = createOpenServiceBrokerAdapter();
    await assert.rejects(
      () =>
        adapter.invoke!(ctx, {
          operationRef: OSB_OPERATIONS.instance,
          input: {
            instanceId: "instance-1",
            serviceId: "00000000-0000-0000-0000-000000000000",
          },
          commandId: "command-12",
        }),
      (error: unknown) =>
        error instanceof ConnectorError &&
        error.code === "denied" &&
        error.detail === "osb.service.unapproved",
    );
    assert.equal(broker.requests.length, 0);
  } finally {
    await broker.close();
  }
});

test("a disconnect forgets the local connection and claims nothing upstream", async () => {
  const broker = await startServiceBrokerFixture(brokerOptions);
  try {
    const { ctx } = harness({ origin: broker.origin });
    const adapter = createOpenServiceBrokerAdapter();
    const result = await adapter.disconnect!(ctx, "local");
    assert.deepEqual(result, {
      local: "applied",
      broker: "unsupported",
      upstream: "not-attempted",
    });
    assert.deepEqual(broker.mutating(), []);
  } finally {
    await broker.close();
  }
});

test("the catalog entry reports provisioning as an intentional limitation", () => {
  const adapter = createOpenServiceBrokerAdapter();
  const rows = adapter.capabilities(
    new Set([OSB_USERNAME_CONFIGURATION, OSB_PASSWORD_CONFIGURATION]),
  );
  const invoke = rows.find((row) => row.dimension === "invoke");
  assert.ok(invoke);
  assert.equal(invoke.implementation, "implemented");
  assert.equal(invoke.configuration, "ready");
  assert.ok(
    invoke.limitations.some((limitation) =>
      /no request builder for them/.test(limitation),
    ),
  );
  const verify = rows.find((row) => row.dimension === "verify");
  assert.ok(
    verify?.limitations.some((limitation) =>
      /does not declare instances_retrievable/.test(limitation),
    ),
  );
  // Reads only: nothing in this adapter advertises an authorization flow.
  const authorize = rows.find((row) => row.dimension === "authorize");
  assert.equal(authorize?.implementation, "unsupported");
  assert.equal(adapter.authorize, undefined);
  assert.equal(adapter.complete, undefined);
});
