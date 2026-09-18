import assert from "node:assert/strict";
import test from "node:test";
import { runtimeBindingSchema } from "../../../src/server/connectors/binding.js";
import type { RuntimeBinding } from "../../../src/server/connectors/binding.js";
import { ConnectorError } from "../../../src/server/connectors/errors.js";
import type {
  AdapterCallContext,
  ConnectionRecord,
} from "../../../src/server/connectors/index.js";
import {
  airbyteConfigurationNames,
  createAirbyteAdapter,
} from "../../../src/server/connectors/providers/airbyte/index.js";
import { startAirbyteApiDouble } from "../doubles/airbyte-api.js";
import { fixtureActor, memoryPorts } from "../doubles/ports.js";
import {
  connectionId,
  foreignConnection,
  otherConnectionId,
  postgresSource,
  sourceId,
  unreachableSource,
  warehouseConnection,
  workspaceId,
} from "../fixtures/airbyte/deployment.js";

/*
 * The adapter against an independent double of the documented API. The double
 * asserts the wire contract (paths, methods, bearer authorization, job types);
 * the adapter asserts policy (approved destination, approved operation,
 * permitted target, requested sync modes, journaled effects). Neither produces
 * the other's expectations.
 */

const bindingFor = (
  origin: string,
  overrides: Partial<RuntimeBinding> = {},
): RuntimeBinding =>
  runtimeBindingSchema.parse({
    bindingRef: "binding:airbyte:1",
    definitionRef: "def:airbyte:1",
    revision: 3,
    adapterId: "airbyte",
    adapterVersion: "2026.09.18",
    runtime: "hosted-server",
    custody: "host-owned",
    authorityInstance: origin,
    status: "approved",
    approvedAt: "2026-09-18T00:00:00.000Z",
    policyRevision: "policy-1",
    tenantId: fixtureActor.tenantId,
    profileId: "airbyte-api",
    destinations: [
      { id: "api", origin, network: "loopback-fixture" },
    ],
    operations: [
      {
        operationRef: "op:source.get",
        nativeId: "airbyte.source.get",
        destinationId: "api",
        transport: { kind: "http", method: "GET", pathTemplate: "/sources/{sourceId}" },
        effect: "read",
        outputClassification: "personal",
        cost: "free",
        consent: "none",
        replay: "read-only",
        targetParameters: ["sourceId"],
      },
      {
        operationRef: "op:connection.get",
        nativeId: "airbyte.connection.get",
        destinationId: "api",
        transport: {
          kind: "http",
          method: "GET",
          pathTemplate: "/connections/{connectionId}",
        },
        effect: "read",
        outputClassification: "personal",
        cost: "free",
        consent: "none",
        replay: "read-only",
        targetParameters: ["connectionId"],
      },
      {
        operationRef: "op:streams",
        nativeId: "airbyte.streams.discover",
        destinationId: "api",
        transport: { kind: "http", method: "GET", pathTemplate: "/streams" },
        effect: "read",
        outputClassification: "personal",
        cost: "free",
        consent: "none",
        replay: "read-only",
        targetParameters: ["sourceId"],
      },
      {
        operationRef: "op:job.sync",
        nativeId: "airbyte.job.sync",
        destinationId: "api",
        transport: { kind: "http", method: "POST", pathTemplate: "/jobs" },
        effect: "write",
        outputClassification: "personal",
        cost: "metered",
        consent: "confirm",
        replay: "none",
        targetParameters: ["connectionId"],
      },
      {
        operationRef: "op:job.reset",
        nativeId: "airbyte.job.reset",
        destinationId: "api",
        transport: { kind: "http", method: "POST", pathTemplate: "/jobs" },
        effect: "write",
        outputClassification: "personal",
        cost: "metered",
        consent: "confirm",
        replay: "none",
        targetParameters: ["connectionId"],
      },
      {
        operationRef: "op:job.get",
        nativeId: "airbyte.job.get",
        destinationId: "api",
        transport: { kind: "http", method: "GET", pathTemplate: "/jobs/{jobId}" },
        effect: "read",
        outputClassification: "personal",
        cost: "free",
        consent: "none",
        replay: "read-only",
        targetParameters: [],
      },
      {
        operationRef: "op:job.cancel",
        nativeId: "airbyte.job.cancel",
        destinationId: "api",
        transport: {
          kind: "http",
          method: "DELETE",
          pathTemplate: "/jobs/{jobId}",
        },
        effect: "write",
        outputClassification: "personal",
        cost: "free",
        consent: "confirm",
        replay: "reconciliation",
        targetParameters: [],
      },
    ],
    configuration: [
      airbyteConfigurationNames.apiUrl,
      airbyteConfigurationNames.apiKey,
    ],
    permittedTargets: [
      { kind: "airbyte-source", id: sourceId },
      { kind: "airbyte-connection", id: connectionId },
    ],
    reviewedDigest: "a".repeat(64),
    settings: {},
    ...overrides,
  });

const connectionRecord = (binding: RuntimeBinding): ConnectionRecord => ({
  connectionRef: "conn:airbyte:1",
  bindingRef: binding.bindingRef,
  definitionRef: binding.definitionRef,
  ecosystem: "airbyte",
  service: "airbyte",
  displayName: "Airbyte deployment",
  ownerKind: "organization",
  custody: "host-owned",
  runtime: "hosted-server",
  lifecycle: "active",
  generation: 1,
  revision: 1,
  createdAt: "2026-09-18T00:00:00.000Z",
  updatedAt: "2026-09-18T00:00:00.000Z",
  tenantId: fixtureActor.tenantId,
  ownerId: fixtureActor.subjectId,
  authorityInstance: binding.authorityInstance,
  bindingRevision: binding.revision,
  policyRevision: binding.policyRevision,
  configurationRevision: "cfg:1",
  externalIds: { sourceId, workspaceId, connectionId },
  evidenceRefs: [],
  state: {},
});

async function harness(
  options: Parameters<typeof startAirbyteApiDouble>[0] = {},
  bindingOverrides: Partial<RuntimeBinding> = {},
) {
  const double = await startAirbyteApiDouble({
    apiKey: "deployment-key",
    sources: [postgresSource, unreachableSource],
    connections: [warehouseConnection, foreignConnection],
    ...options,
  });
  const ports = memoryPorts({ now: () => 1_770_000_000_000 });
  ports.configuration.set(airbyteConfigurationNames.apiUrl, double.apiUrl);
  ports.configuration.set(airbyteConfigurationNames.apiKey, "deployment-key");
  const binding = bindingFor(double.origin, bindingOverrides);
  const record = connectionRecord(binding);
  await ports.connections.create(record);
  const controller = new AbortController();
  const ctx: AdapterCallContext = {
    actor: fixtureActor,
    binding,
    connection: record,
    generation: 1,
    signal: controller.signal,
    environment: ports.environment({ fetch: globalThis.fetch }),
  };
  return {
    double,
    ports,
    binding,
    ctx,
    adapter: createAirbyteAdapter(),
    async close() {
      controller.abort();
      await double.close();
    },
  };
}

test("the catalog reports host-owned custody and per-dimension configuration readiness", () => {
  const adapter = createAirbyteAdapter();
  assert.equal(adapter.id, "airbyte");
  assert.equal(adapter.ecosystem, "airbyte");
  assert.deepEqual([...adapter.custody], ["host-owned"]);
  const required = adapter.configuration
    .filter((item) => item.required)
    .map((item) => item.name);
  assert.deepEqual(required, ["AIRBYTE_API_URL", "AIRBYTE_API_KEY"]);
  assert.equal(
    adapter.configuration.find((item) => item.name === "AIRBYTE_API_URL")
      ?.classification,
    "public",
  );
  assert.equal(
    adapter.configuration.find((item) => item.name === "AIRBYTE_API_KEY")
      ?.classification,
    "secret",
  );

  const missing = adapter.capabilities(new Set());
  assert.equal(
    missing.find((status) => status.dimension === "delegate")?.configuration,
    "missing",
  );
  const ready = adapter.capabilities(
    new Set(["AIRBYTE_API_URL", "AIRBYTE_API_KEY"]),
  );
  assert.equal(
    ready.find((status) => status.dimension === "delegate")?.configuration,
    "ready",
  );
  // Authorization is genuinely unsupported: the deployment token is host-owned.
  const authorize = ready.find((status) => status.dimension === "authorize");
  assert.equal(authorize?.implementation, "unsupported");
  assert.equal(authorize?.evidence, "not-tested");
  // The absent public check_connection operation is reported, not hidden.
  assert.ok(
    ready
      .find((status) => status.dimension === "verify")
      ?.limitations.some((text) => text.includes("check_connection")),
  );
});

test("verify reaches the source through live discovery and states its limitation", async () => {
  const h = await harness();
  try {
    const result = await h.adapter.verify!(h.ctx);
    assert.equal(result.state, "complete");
    assert.equal(result.target?.id, sourceId);
    assert.equal(result.target?.kind, "airbyte-source");
    const claim = result.claims[0];
    assert.equal(claim?.kind, "resource-access");
    assert.equal(claim?.issuer, "provider");
    assert.ok(claim?.limitations.some((text) => text.includes("check_connection")));
    assert.ok(
      claim?.limitations.some((text) => text.includes("not the permissions of any end user")),
    );
    assert.deepEqual(claim?.permissions?.requested, []);

    // The double saw a cache-bypassing discovery with a bearer token.
    const discovery = h.double.received("GET", "/api/public/v1/streams").at(-1);
    assert.equal(discovery?.url.searchParams.get("ignoreCache"), "true");
    assert.equal(discovery?.headers.authorization, "Bearer deployment-key");
  } finally {
    await h.close();
  }
});

test("an unreachable source fails verification instead of reporting success", async () => {
  const h = await harness();
  try {
    const ctx = {
      ...h.ctx,
      binding: bindingFor(h.double.origin, {
        permittedTargets: [
          { kind: "airbyte-source", id: unreachableSource.sourceId },
        ],
      }),
      connection: {
        ...h.ctx.connection!,
        externalIds: { sourceId: unreachableSource.sourceId },
      },
    };
    await assert.rejects(
      () => h.adapter.verify!(ctx),
      (error: unknown) =>
        error instanceof ConnectorError && error.code === "upstream-unavailable",
    );
  } finally {
    await h.close();
  }
});

test("discovery returns the deployment's stream properties with freshness", async () => {
  const h = await harness();
  try {
    const result = await h.adapter.discover!(h.ctx, {
      scope: { sourceId },
      refresh: true,
    });
    assert.deepEqual(
      result.items.map((item) => item.displayName),
      ["users", "audit_log"],
    );
    assert.equal(result.items[0]?.identity.ecosystem, "airbyte");
    assert.equal(result.items[0]?.identity.authorityNamespace, sourceId);
    assert.equal(result.freshness.stale, false);
    assert.equal(result.freshness.source, "live");
  } finally {
    await h.close();
  }
});

test("a source outside the binding's permitted targets is refused before any call", async () => {
  const h = await harness();
  try {
    const before = h.double.requests.length;
    await assert.rejects(
      () =>
        h.adapter.discover!(h.ctx, {
          scope: { sourceId: unreachableSource.sourceId },
        }),
      (error: unknown) =>
        error instanceof ConnectorError &&
        error.code === "denied" &&
        error.detail === "airbyte.target.unpermitted",
    );
    assert.equal(h.double.requests.length, before, "no request was made");
  } finally {
    await h.close();
  }
});

test("AC-EXT-13: a sync requesting a mode the connection's stream lacks is rejected before submission", async () => {
  const h = await harness();
  try {
    await assert.rejects(
      () =>
        h.adapter.delegate!(h.ctx, {
          skill: "op:job.sync",
          action: "start",
          commandId: "cmd-unsupported",
          input: {
            connectionId,
            streams: [{ name: "audit_log", syncMode: "incremental_append" }],
          },
        }),
      (error: unknown) =>
        error instanceof ConnectorError &&
        error.code === "unsupported" &&
        error.detail === "airbyte.sync-mode.unsupported",
    );
    assert.equal(
      h.double.received("POST", "/api/public/v1/jobs").length,
      0,
      "no job was created",
    );
    // Nothing was journaled as an effect either.
    assert.deepEqual(h.ports.inspect.effects(), []);
  } finally {
    await h.close();
  }
});

test("AC-EXT-13: a sync mode outside the API vocabulary is rejected, never mapped to a neighbour", async () => {
  const h = await harness();
  try {
    await assert.rejects(
      () =>
        h.adapter.delegate!(h.ctx, {
          skill: "op:job.sync",
          action: "start",
          commandId: "cmd-unknown-mode",
          input: {
            connectionId,
            streams: [{ name: "users", syncMode: "cdc_only" }],
          },
        }),
      (error: unknown) =>
        error instanceof ConnectorError &&
        error.detail === "airbyte.sync-mode.unknown",
    );
    await assert.rejects(
      () =>
        h.adapter.delegate!(h.ctx, {
          skill: "op:job.sync",
          action: "start",
          commandId: "cmd-unknown-stream",
          input: {
            connectionId,
            streams: [{ name: "not_configured", syncMode: "incremental_append" }],
          },
        }),
      (error: unknown) =>
        error instanceof ConnectorError &&
        error.detail === "airbyte.stream.unconfigured",
    );
    assert.equal(h.double.received("POST", "/api/public/v1/jobs").length, 0);
  } finally {
    await h.close();
  }
});

test("AC-EXT-13: a restart submits the same connection's job and never sends state", async () => {
  const h = await harness();
  try {
    const before = structuredClone(h.double.stateOf(connectionId));
    const first = await h.adapter.delegate!(h.ctx, {
      skill: "op:job.sync",
      action: "start",
      commandId: "cmd-1",
      input: {
        connectionId,
        streams: [{ name: "users", syncMode: "incremental_deduped_history" }],
      },
    });
    assert.equal(first.state, "indeterminate", "a running job is not complete");
    assert.equal(first.effect, "write");
    assert.equal(first.code, "airbyte.job.running");
    const jobId = (first.output as { jobId: number }).jobId;

    // A restart under a new command id submits a new job for the same connection.
    const restart = await h.adapter.delegate!(h.ctx, {
      skill: "op:job.sync",
      action: "start",
      commandId: "cmd-2",
      input: { connectionId },
    });
    const restarted = (restart.output as { jobId: number; connectionId: string });
    assert.notEqual(restarted.jobId, jobId);
    assert.equal(restarted.connectionId, connectionId);

    // The request body carries only the documented fields; no state travels.
    const submissions = h.double.received("POST", "/api/public/v1/jobs");
    assert.equal(submissions.length, 2);
    for (const submission of submissions) {
      const body = JSON.parse(submission.body.toString("utf8")) as Record<
        string,
        unknown
      >;
      assert.deepEqual(Object.keys(body).sort(), ["connectionId", "jobType"]);
      assert.equal(body.jobType, "sync");
      assert.equal(body.connectionId, connectionId);
    }
    // The platform's checkpoints are exactly as they were.
    assert.deepEqual(h.double.stateOf(connectionId), before);
  } finally {
    await h.close();
  }
});

test("the job type comes from the approved operation, never from input", async () => {
  const h = await harness();
  try {
    await h.adapter.delegate!(h.ctx, {
      skill: "op:job.reset",
      action: "start",
      commandId: "cmd-reset",
      input: { connectionId },
    });
    const body = JSON.parse(
      h.double.received("POST", "/api/public/v1/jobs")[0]!.body.toString("utf8"),
    ) as { jobType: string };
    assert.equal(body.jobType, "reset");

    // An operation this binding does not carry is denied.
    await assert.rejects(
      () =>
        h.adapter.delegate!(h.ctx, {
          skill: "op:job.unknown",
          action: "start",
          commandId: "cmd-x",
          input: { connectionId },
        }),
      (error: unknown) =>
        error instanceof ConnectorError &&
        error.detail === "airbyte.operation.unapproved",
    );
  } finally {
    await h.close();
  }
});

test("a repeated submission returns the journaled outcome instead of a second sync", async () => {
  const h = await harness();
  try {
    const first = await h.adapter.delegate!(h.ctx, {
      skill: "op:job.sync",
      action: "start",
      commandId: "cmd-same",
      input: { connectionId },
    });
    const second = await h.adapter.delegate!(h.ctx, {
      skill: "op:job.sync",
      action: "start",
      commandId: "cmd-same",
      input: { connectionId },
    });
    assert.equal(h.double.received("POST", "/api/public/v1/jobs").length, 1);
    assert.equal(second.effectRef, first.effectRef);
    assert.equal(second.output, undefined, "no fabricated job response");
    assert.equal(second.code, "airbyte.job.running");
  } finally {
    await h.close();
  }
});

test("an interrupted submission is indeterminate, not a failure or a success", async () => {
  const h = await harness({ failJobCreation: { times: 1, status: 503 } });
  try {
    const result = await h.adapter.delegate!(h.ctx, {
      skill: "op:job.sync",
      action: "start",
      commandId: "cmd-uncertain",
      input: { connectionId },
    });
    assert.equal(result.state, "indeterminate");
    assert.equal(result.code, "airbyte.job.uncertain");
    assert.equal(result.output, undefined);
    const journal = h.ports.inspect.effects();
    assert.equal(journal.length, 1);
    assert.equal(journal[0]?.outcome?.status, "indeterminate");
  } finally {
    await h.close();
  }
});

test("job status and cancel stay bound to a permitted connection", async () => {
  const h = await harness({
    jobs: [
      {
        jobId: 5150,
        connectionId,
        jobType: "sync",
        status: "running",
        startTime: "2026-09-18T00:00:00Z",
      },
      {
        jobId: 5151,
        connectionId: otherConnectionId,
        jobType: "sync",
        status: "running",
        startTime: "2026-09-18T00:00:00Z",
      },
    ],
  });
  try {
    const status = await h.adapter.delegate!(h.ctx, {
      skill: "op:job.get",
      action: "status",
      commandId: "cmd-status",
      input: { jobId: 5150 },
    });
    assert.equal(status.state, "indeterminate");
    assert.equal(status.code, "airbyte.job.running");

    const cancelled = await h.adapter.delegate!(h.ctx, {
      skill: "op:job.cancel",
      action: "cancel",
      commandId: "cmd-cancel",
      input: { jobId: 5150 },
    });
    assert.equal(cancelled.state, "complete");
    assert.equal((cancelled.output as { status: string }).status, "cancelled");

    // A job belonging to another connection is refused after its identity is read.
    await assert.rejects(
      () =>
        h.adapter.delegate!(h.ctx, {
          skill: "op:job.cancel",
          action: "cancel",
          commandId: "cmd-cancel-foreign",
          input: { jobId: 5151 },
        }),
      (error: unknown) =>
        error instanceof ConnectorError &&
        error.detail === "airbyte.target.unpermitted",
    );
    assert.equal(h.double.jobs.get(5151)?.status, "running");
  } finally {
    await h.close();
  }
});

test("a binding whose transport disagrees with the documented operation is refused", async () => {
  const h = await harness({}, {
    operations: [
      {
        operationRef: "op:job.sync",
        nativeId: "airbyte.job.sync",
        destinationId: "api",
        // The documented path is /jobs; a binding cannot redirect it.
        transport: { kind: "http", method: "POST", pathTemplate: "/v1/jobs/create" },
        effect: "write",
        outputClassification: "personal",
        cost: "metered",
        consent: "confirm",
        replay: "none",
        targetParameters: ["connectionId"],
      },
    ],
  });
  try {
    await assert.rejects(
      () =>
        h.adapter.delegate!(h.ctx, {
          skill: "op:job.sync",
          action: "start",
          commandId: "cmd-transport",
          input: { connectionId },
        }),
      (error: unknown) =>
        error instanceof ConnectorError &&
        error.detail === "airbyte.operation.transport-mismatch",
    );
    assert.equal(h.double.requests.length, 0);
  } finally {
    await h.close();
  }
});

test("a configured API URL that is not the approved origin is refused", async () => {
  const h = await harness();
  try {
    h.ports.configuration.set(
      airbyteConfigurationNames.apiUrl,
      "https://api.airbyte.com/v1",
    );
    await assert.rejects(
      () => h.adapter.discover!(h.ctx, { scope: { sourceId } }),
      (error: unknown) =>
        error instanceof ConnectorError &&
        error.code === "network-policy" &&
        error.detail === "airbyte.api-url.origin-mismatch",
    );
    h.ports.configuration.set(
      airbyteConfigurationNames.apiUrl,
      `${h.double.origin}/api/public`,
    );
    await assert.rejects(
      () => h.adapter.discover!(h.ctx, { scope: { sourceId } }),
      (error: unknown) =>
        error instanceof ConnectorError &&
        error.detail === "airbyte.api-url.version",
    );
    h.ports.configuration.set(airbyteConfigurationNames.apiUrl, undefined);
    await assert.rejects(
      () => h.adapter.discover!(h.ctx, { scope: { sourceId } }),
      (error: unknown) =>
        error instanceof ConnectorError &&
        error.code === "configuration-required",
    );
    assert.equal(h.double.requests.length, 0);
  } finally {
    await h.close();
  }
});

test("application credentials mint a short-lived token rather than sending the client secret", async () => {
  const h = await harness({
    apiKey: undefined,
    application: {
      clientId: "client-1",
      clientSecret: "secret-1",
      mintedToken: "minted-token",
    },
  });
  try {
    h.ports.configuration.set(airbyteConfigurationNames.apiKey, "unused-key");
    h.ports.configuration.set(airbyteConfigurationNames.clientId, "client-1");
    h.ports.configuration.set(
      airbyteConfigurationNames.clientSecret,
      "secret-1",
    );
    await h.adapter.discover!(h.ctx, { scope: { sourceId } });
    assert.equal(h.double.tokenMints.length, 1);
    const discovery = h.double.received("GET", "/api/public/v1/streams")[0];
    assert.equal(discovery?.headers.authorization, "Bearer minted-token");
    // The configured API key was not used when applications are configured.
    assert.equal(
      h.double.requests.some((request) =>
        (request.headers.authorization ?? "").includes("unused-key"),
      ),
      false,
    );
  } finally {
    await h.close();
  }
});

test("import produces a source record and definitions without contacting the deployment", async () => {
  const h = await harness();
  try {
    const document = JSON.stringify({
      spec: { connectionSpecification: { type: "object" } },
      catalog: {
        streams: [
          {
            name: "users",
            json_schema: { type: "object" },
            supported_sync_modes: ["full_refresh"],
          },
        ],
      },
    });
    const outcome = await h.adapter.import!(h.ctx, {
      bytes: new TextEncoder().encode(document),
      mediaType: "application/json",
      origin: { kind: "upload" },
    });
    assert.equal(outcome.definitions.length, 1);
    assert.equal(outcome.definitions[0]?.capabilities[0]?.nativeId, "users");
    assert.equal(outcome.source.format.name, "airbyte-catalog");
    assert.equal(h.double.requests.length, 0);
  } finally {
    await h.close();
  }
});

test("local disconnect does not touch the deployment", async () => {
  const h = await harness();
  try {
    const result = await h.adapter.disconnect!(h.ctx, "local");
    assert.equal(result.local, "applied");
    assert.equal(result.upstream, "not-attempted");
    const upstream = await h.adapter.disconnect!(h.ctx, "upstream");
    assert.equal(upstream.upstream, "unsupported");
    assert.equal(h.double.requests.length, 0);
    assert.deepEqual(h.double.stateOf(connectionId), warehouseConnection.state);
  } finally {
    await h.close();
  }
});
