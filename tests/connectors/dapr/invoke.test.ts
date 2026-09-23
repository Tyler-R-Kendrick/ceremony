import { test } from "node:test";
import assert from "node:assert/strict";
import { fixtureActor, memoryPorts } from "../doubles/ports.js";
import { startDaprSidecarFixture } from "../doubles/dapr-sidecar.js";
import { buildBinding, buildConnectionSummary } from "../fixtures/builders.js";
import type { AdapterCallContext } from "../../../src/server/connectors/adapter.js";
import type { ConnectionRecord } from "../../../src/server/connectors/ports.js";
import { ConnectorError } from "../../../src/server/connectors/errors.js";
import {
  DAPR_ADAPTER_ID,
  DAPR_API_TOKEN_CONFIGURATION,
  createDaprAdapter,
  daprBindingPath,
  daprSidecarFromBinding,
} from "../../../src/server/connectors/providers/dapr/index.js";

/*
 * Invocation is bounded by the binding on four axes at once: the sidecar
 * destination, the component name in the path, the operation verb, and the
 * per-call metadata keys. Each of these tests removes exactly one of those
 * guarantees and checks that the request never leaves the process.
 */

const API_TOKEN = "fixture-dapr-api-token";

function connectionRecord(): ConnectionRecord {
  return {
    ...buildConnectionSummary({
      connectionRef: "connection:dapr",
      bindingRef: "binding:dapr",
      definitionRef: "definition:dapr",
      ecosystem: "dapr",
      service: "dapr",
      displayName: "Dapr sidecar",
      target: undefined,
      verification: undefined,
    }),
    tenantId: fixtureActor.tenantId,
    ownerId: fixtureActor.subjectId,
    authorityInstance: "dapr-fixture",
    bindingRevision: 1,
    policyRevision: "policy:1",
    configurationRevision: "cfg:1",
    externalIds: {},
    evidenceRefs: [],
    state: {},
  };
}

function harness(options: {
  origin: string;
  operations?: Record<
    string,
    { operations: string[]; metadataKeys?: string[] }
  >;
  inputBindings?: string[];
  unauthenticated?: boolean;
  network?: "loopback-fixture" | "public";
  pathTemplate?: string;
  method?: "POST" | "GET";
  componentName?: string;
}) {
  const componentName = options.componentName ?? "orders-topic";
  const ports = memoryPorts();
  if (!options.unauthenticated)
    ports.configuration.set(DAPR_API_TOKEN_CONFIGURATION, API_TOKEN);
  const outputBindings = Object.fromEntries(
    Object.entries(
      options.operations ?? { [componentName]: { operations: ["create"] } },
    ).map(([name, value]) => [
      name,
      { operations: value.operations, metadataKeys: value.metadataKeys ?? [] },
    ]),
  );
  const binding = buildBinding({
    bindingRef: "binding:dapr",
    definitionRef: "definition:dapr",
    adapterId: DAPR_ADAPTER_ID,
    destinations: [
      {
        id: "sidecar",
        origin: options.origin,
        network: options.network ?? "loopback-fixture",
      },
    ],
    operations: [
      {
        operationRef: "operation:orders",
        nativeId: componentName,
        destinationId: "sidecar",
        transport: {
          kind: "http",
          method: options.method ?? "POST",
          pathTemplate: options.pathTemplate ?? daprBindingPath(componentName),
        },
        effect: "write",
        outputClassification: "personal",
        cost: "unknown",
        consent: "confirm",
        replay: "none",
        targetParameters: [],
      },
    ],
    configuration: [],
    settings: {
      dapr: {
        destinationId: "sidecar",
        ...(options.unauthenticated
          ? { unauthenticatedSidecar: true }
          : { apiTokenConfiguration: DAPR_API_TOKEN_CONFIGURATION }),
        appApiTokenConfiguration: "DAPR_APP_API_TOKEN",
        appId: "ceremony-fixture-app",
        outputBindings,
        inputBindings: options.inputBindings ?? [],
      },
    },
    profileId: undefined,
  });
  const ctx: AdapterCallContext = {
    actor: fixtureActor,
    binding,
    connection: connectionRecord(),
    generation: 0,
    signal: AbortSignal.timeout(10_000),
    environment: ports.environment({ fetch: globalThis.fetch }),
  };
  return { ports, binding, ctx };
}

test("an approved output binding is invoked at the documented route with the API token", async () => {
  const sidecar = await startDaprSidecarFixture({
    apiToken: API_TOKEN,
    components: [
      {
        name: "orders-topic",
        operations: ["create"],
        reply: { accepted: true },
      },
    ],
  });
  try {
    const { ctx, ports } = harness({ origin: sidecar.origin });
    const adapter = createDaprAdapter();
    const result = await adapter.invoke!(ctx, {
      operationRef: "operation:orders",
      input: { data: { orderId: "o-1" }, operation: "create" },
      commandId: "command-1",
    });
    assert.equal(result.state, "complete");
    assert.deepEqual(result.output, { accepted: true });
    assert.equal(result.outputClassification, "personal");
    const request = sidecar.requests[0]!;
    assert.equal(request.method, "POST");
    assert.equal(request.url.pathname, "/v1.0/bindings/orders-topic");
    assert.equal(request.headers["dapr-api-token"], API_TOKEN);
    assert.deepEqual(sidecar.invocations, [
      {
        name: "orders-topic",
        operation: "create",
        data: { orderId: "o-1" },
        metadata: undefined,
      },
    ]);
    const effects = ports.inspect.effects();
    assert.equal(effects.length, 1);
    assert.equal(effects[0]!.outcome?.status, "applied");
  } finally {
    await sidecar.close();
  }
});

test("a repeated identical invocation returns the journalled outcome instead of a second effect", async () => {
  const sidecar = await startDaprSidecarFixture({
    apiToken: API_TOKEN,
    components: [{ name: "orders-topic", operations: ["create"] }],
  });
  try {
    const { ctx } = harness({ origin: sidecar.origin });
    const adapter = createDaprAdapter();
    const request = {
      operationRef: "operation:orders",
      input: { data: { orderId: "o-2" }, operation: "create" as const },
      commandId: "command-2",
    };
    await adapter.invoke!(ctx, request);
    await adapter.invoke!(ctx, request);
    assert.equal(
      sidecar.invocations.length,
      1,
      "the same effect is not applied twice",
    );
  } finally {
    await sidecar.close();
  }
});

test("a verb the binding did not approve is refused before the request exists", async () => {
  const sidecar = await startDaprSidecarFixture({
    apiToken: API_TOKEN,
    components: [{ name: "orders-topic", operations: ["create", "delete"] }],
  });
  try {
    const { ctx } = harness({
      origin: sidecar.origin,
      operations: { "orders-topic": { operations: ["create"] } },
    });
    const adapter = createDaprAdapter();
    await assert.rejects(
      () =>
        adapter.invoke!(ctx, {
          operationRef: "operation:orders",
          input: { operation: "delete" },
          commandId: "command-3",
        }),
      (error: unknown) =>
        error instanceof ConnectorError &&
        error.code === "denied" &&
        error.detail === "dapr.operation.verb-unapproved",
    );
    assert.equal(sidecar.requests.length, 0);
  } finally {
    await sidecar.close();
  }
});

test("a component the binding did not name does not exist for this adapter", async () => {
  const sidecar = await startDaprSidecarFixture({
    apiToken: API_TOKEN,
    components: [
      { name: "orders-topic", operations: ["create"] },
      { name: "payouts-topic", operations: ["create"] },
    ],
  });
  try {
    const { ctx } = harness({
      origin: sidecar.origin,
      componentName: "payouts-topic",
      operations: { "orders-topic": { operations: ["create"] } },
    });
    const adapter = createDaprAdapter();
    await assert.rejects(
      () =>
        adapter.invoke!(ctx, {
          operationRef: "operation:orders",
          input: { operation: "create" },
          commandId: "command-4",
        }),
      (error: unknown) =>
        error instanceof ConnectorError &&
        error.code === "denied" &&
        error.detail === "dapr.component.unapproved",
    );
    assert.equal(sidecar.requests.length, 0);
  } finally {
    await sidecar.close();
  }
});

test("AC-EXT-18: a Dapr binding naming another component reaches no sidecar", async () => {
  // The Dapr clause of AC-EXT-18: arbitrary sidecar or component access is
  // refused by the binding before any request exists.
  const sidecar = await startDaprSidecarFixture({
    apiToken: API_TOKEN,
    components: [{ name: "payouts-topic", operations: ["create"] }],
  });
  try {
    const { ctx } = harness({
      origin: sidecar.origin,
      pathTemplate: "/v1.0/bindings/payouts-topic",
    });
    const adapter = createDaprAdapter();
    await assert.rejects(
      () =>
        adapter.invoke!(ctx, {
          operationRef: "operation:orders",
          input: { operation: "create" },
          commandId: "command-5",
        }),
      (error: unknown) =>
        error instanceof ConnectorError &&
        error.detail === "dapr.operation.path-mismatch",
    );
    assert.equal(sidecar.requests.length, 0);
  } finally {
    await sidecar.close();
  }
});

test("an operation pinned to another destination cannot reach the sidecar", async () => {
  const sidecar = await startDaprSidecarFixture({
    apiToken: API_TOKEN,
    components: [{ name: "orders-topic", operations: ["create"] }],
  });
  const other = await startDaprSidecarFixture({
    components: [{ name: "orders-topic", operations: ["create"] }],
  });
  try {
    const { ctx, binding, ports } = harness({ origin: sidecar.origin });
    const rebound = {
      ...binding,
      destinations: [
        ...binding.destinations,
        {
          id: "other",
          origin: other.origin,
          network: "loopback-fixture" as const,
        },
      ],
      operations: [{ ...binding.operations[0]!, destinationId: "other" }],
    };
    const adapter = createDaprAdapter();
    await assert.rejects(
      () =>
        adapter.invoke!(
          {
            ...ctx,
            binding: rebound,
            environment: ports.environment({ fetch: globalThis.fetch }),
          },
          {
            operationRef: "operation:orders",
            input: { operation: "create" },
            commandId: "command-6",
          },
        ),
      (error: unknown) =>
        error instanceof ConnectorError &&
        error.code === "network-policy" &&
        error.detail === "dapr.operation.destination-mismatch",
    );
    assert.equal(other.requests.length, 0);
    assert.equal(sidecar.requests.length, 0);
  } finally {
    await sidecar.close();
    await other.close();
  }
});

test("an unauthenticated sidecar is only ever a loopback fixture", () => {
  const { binding } = harness({
    origin: "https://sidecar.invalid",
    unauthenticated: true,
    network: "public",
  });
  assert.throws(
    () => daprSidecarFromBinding(binding),
    (error: unknown) =>
      error instanceof ConnectorError &&
      error.code === "configuration-required" &&
      error.detail === "dapr.sidecar.token-required",
  );
});

test("a missing API token stops the call instead of sending an unauthenticated one", async () => {
  const sidecar = await startDaprSidecarFixture({
    apiToken: API_TOKEN,
    components: [{ name: "orders-topic", operations: ["create"] }],
  });
  try {
    const { ctx, ports } = harness({ origin: sidecar.origin });
    ports.configuration.set(DAPR_API_TOKEN_CONFIGURATION, undefined);
    const adapter = createDaprAdapter();
    await assert.rejects(
      () =>
        adapter.invoke!(ctx, {
          operationRef: "operation:orders",
          input: { operation: "create" },
          commandId: "command-7",
        }),
      (error: unknown) =>
        error instanceof ConnectorError &&
        error.code === "configuration-required" &&
        error.detail === "dapr.api-token.missing",
    );
    assert.equal(sidecar.requests.length, 0);
  } finally {
    await sidecar.close();
  }
});

test("an unapproved metadata key is refused, and an approved one is forwarded", async () => {
  const sidecar = await startDaprSidecarFixture({
    apiToken: API_TOKEN,
    components: [{ name: "orders-topic", operations: ["create"] }],
  });
  try {
    const { ctx } = harness({
      origin: sidecar.origin,
      operations: {
        "orders-topic": {
          operations: ["create"],
          metadataKeys: ["partitionKey"],
        },
      },
    });
    const adapter = createDaprAdapter();
    await assert.rejects(
      () =>
        adapter.invoke!(ctx, {
          operationRef: "operation:orders",
          input: {
            operation: "create",
            metadata: { url: "https://elsewhere.invalid" },
          },
          commandId: "command-8",
        }),
      (error: unknown) =>
        error instanceof ConnectorError &&
        error.detail === "dapr.metadata.key-unapproved",
    );
    assert.equal(sidecar.requests.length, 0);
    await adapter.invoke!(ctx, {
      operationRef: "operation:orders",
      input: { operation: "create", metadata: { partitionKey: "eu" } },
      commandId: "command-9",
    });
    assert.deepEqual(sidecar.invocations[0]!.metadata, { partitionKey: "eu" });
  } finally {
    await sidecar.close();
  }
});

test("an upstream failure on a write is recorded indeterminate, not retried", async () => {
  const sidecar = await startDaprSidecarFixture({
    apiToken: API_TOKEN,
    components: [
      { name: "orders-topic", operations: ["create"], failWith: 500 },
    ],
  });
  try {
    const { ctx, ports } = harness({ origin: sidecar.origin });
    const adapter = createDaprAdapter();
    await assert.rejects(
      () =>
        adapter.invoke!(ctx, {
          operationRef: "operation:orders",
          input: { operation: "create" },
          commandId: "command-10",
        }),
      (error: unknown) =>
        error instanceof ConnectorError &&
        error.code === "upstream-unavailable",
    );
    const effects = ports.inspect.effects();
    assert.equal(effects[0]!.outcome?.status, "indeterminate");
  } finally {
    await sidecar.close();
  }
});

test("the sidecar's own rejection of a bad token becomes a denial", async () => {
  const sidecar = await startDaprSidecarFixture({
    apiToken: "a-different-token",
    components: [{ name: "orders-topic", operations: ["create"] }],
  });
  try {
    const { ctx, ports } = harness({ origin: sidecar.origin });
    const adapter = createDaprAdapter();
    await assert.rejects(
      () =>
        adapter.invoke!(ctx, {
          operationRef: "operation:orders",
          input: { operation: "create" },
          commandId: "command-11",
        }),
      (error: unknown) =>
        error instanceof ConnectorError &&
        error.code === "denied" &&
        error.detail === "dapr.api-token.rejected",
    );
    const effects = ports.inspect.effects();
    assert.equal(effects[0]!.outcome?.status, "not-applied");
  } finally {
    await sidecar.close();
  }
});

test("a bound operation that is not an output invocation is refused", async () => {
  const sidecar = await startDaprSidecarFixture({
    apiToken: API_TOKEN,
    components: [{ name: "orders-topic", operations: ["create"] }],
  });
  try {
    const { ctx } = harness({ origin: sidecar.origin, method: "GET" });
    const adapter = createDaprAdapter();
    await assert.rejects(
      () =>
        adapter.invoke!(ctx, {
          operationRef: "operation:orders",
          input: { operation: "create" },
          commandId: "command-12",
        }),
      (error: unknown) =>
        error instanceof ConnectorError &&
        error.detail === "dapr.operation.method",
    );
    assert.equal(sidecar.requests.length, 0);
  } finally {
    await sidecar.close();
  }
});

test("disconnect is local only and never claims an upstream effect", async () => {
  const sidecar = await startDaprSidecarFixture({
    apiToken: API_TOKEN,
    components: [{ name: "orders-topic", operations: ["create"] }],
  });
  try {
    const { ctx } = harness({ origin: sidecar.origin });
    const adapter = createDaprAdapter();
    const result = await adapter.disconnect!(ctx, "local");
    assert.deepEqual(result, {
      local: "applied",
      broker: "unsupported",
      upstream: "unsupported",
    });
    assert.equal(sidecar.requests.length, 0);
  } finally {
    await sidecar.close();
  }
});
