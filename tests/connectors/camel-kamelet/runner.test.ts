import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { fixtureActor, memoryPorts } from "../doubles/ports.js";
import { startCamelRunnerFixture } from "../doubles/camel-runner.js";
import { buildBinding } from "../fixtures/builders.js";
import type { AdapterCallContext } from "../../../src/server/connectors/adapter.js";
import { ConnectorError } from "../../../src/server/connectors/errors.js";
import {
  CAMEL_KAMELET_ADAPTER_ID,
  KAMELET_BROWSER_DEPLOYMENT_REASON,
  KAMELET_NO_RUNNER_CONFIGURED,
  KAMELET_RUN_DESCRIPTOR_FORMAT,
  KAMELET_RUN_OPERATION,
  createCamelKameletAdapter,
  createRemoteKameletRunner,
  importKamelet,
  kameletRunDescriptor,
  unavailableKameletRunner,
  type KameletHostRunnerPort,
} from "../../../src/server/connectors/formats/camel-kamelet/index.js";

/*
 * Runtime availability is the whole point of these tests: a deployment that
 * has no runner says so with the exact reason and runs nothing, and a browser
 * deployment cannot acquire one at all.
 */

const SIGNING_SECRET = "CEREMONY_FIXTURE_RUNNER_SECRET";
const RUNNER_SECRET_CONFIGURATION = "CAMEL_RUNNER_SIGNING_SECRET";

const kameletSettings = {
  kameletName: "fixture-object-store-source",
  kameletType: "source" as const,
  catalogVersion: "4.22.0",
  scheme: "aws2-s3",
  dependencies: ["camel:core", "camel:aws2-s3", "camel:kamelet"],
  parameters: { bucketName: "fixture-bucket", region: "eu-west-1", delay: 500 },
  secretParameters: {
    accessKey: "FIXTURE_OBJECT_STORE_ACCESS_KEY",
    secretKey: "FIXTURE_OBJECT_STORE_SECRET_KEY",
  },
};

function harness(options: {
  runnerOrigin?: string;
  runner?: KameletHostRunnerPort;
  deploymentRuntime?: "browser" | "hosted-server";
}) {
  const ports = memoryPorts();
  const binding = buildBinding({
    adapterId: CAMEL_KAMELET_ADAPTER_ID,
    destinations: options.runnerOrigin
      ? [
          {
            id: "runner",
            origin: options.runnerOrigin,
            network: "loopback-fixture",
          },
        ]
      : [{ id: "runner", origin: "https://runner.invalid", network: "public" }],
    operations: [
      {
        operationRef: KAMELET_RUN_OPERATION,
        nativeId: kameletSettings.kameletName,
        destinationId: "runner",
        transport: { kind: "http", method: "POST", pathTemplate: "/run" },
        effect: "write",
        outputClassification: "personal",
        cost: "unknown",
        consent: "confirm",
        replay: "none",
        targetParameters: [],
      },
    ],
    configuration: [],
    settings: { kamelet: kameletSettings },
    profileId: undefined,
  });
  const ctx: AdapterCallContext = {
    actor: fixtureActor,
    binding,
    generation: 0,
    signal: AbortSignal.timeout(10_000),
    environment: ports.environment({ fetch: globalThis.fetch }),
  };
  return { ports, binding, ctx };
}

test("AC-EXT-18: a Kamelet that requests a local runtime installs nothing", async () => {
  // The clause of AC-EXT-18 this swarm owns for Camel: asking for execution
  // where no runner exists produces a reported unavailability, not an
  // installation, a download, a process or an invented success.
  const { ctx } = harness({});
  const adapter = createCamelKameletAdapter();
  const availability = await adapter.runnerAvailability();
  assert.equal(availability.available, false);
  await assert.rejects(
    () =>
      adapter.invoke!(ctx, {
        operationRef: KAMELET_RUN_OPERATION,
        input: { trigger: "manual" },
        commandId: "command-ac-ext-18",
      }),
    (error: unknown) =>
      error instanceof ConnectorError && error.code === "unsupported",
  );
  // Import still works: a description is available even where execution is not.
  const imported = await importKamelet(
    new Uint8Array(
      await readFile(
        fileURLToPath(
          new URL(
            "../fixtures/camel-kamelet/aws-s3-source.kamelet.yaml",
            import.meta.url,
          ),
        ),
      ),
    ),
    { sourceRef: "source:s3", origin: { kind: "upload" } },
  );
  assert.equal(imported.definition.capabilities.length, 1);
});

test("with no runner configured, availability names the exact reason and invoke refuses", async () => {
  const { ctx } = harness({});
  const adapter = createCamelKameletAdapter();
  const availability = await adapter.runnerAvailability();
  assert.equal(availability.available, false);
  assert.equal(
    availability.available === false ? availability.reason : "",
    KAMELET_NO_RUNNER_CONFIGURED,
  );
  assert.match(
    availability.available === false ? availability.reason : "",
    /no JVM|starts no JVM/i,
  );
  const invoke = adapter.capabilities(new Set()).find(
    (row) => row.dimension === "invoke",
  );
  assert.ok(invoke);
  assert.equal(invoke.implementation, "unsupported");
  assert.equal(invoke.configuration, "missing");
  assert.equal(invoke.evidence, "not-tested");
  assert.deepEqual(invoke.limitations, [KAMELET_NO_RUNNER_CONFIGURED]);
  await assert.rejects(
    () =>
      adapter.invoke!(ctx, {
        operationRef: KAMELET_RUN_OPERATION,
        input: {},
        commandId: "command-1",
      }),
    (error: unknown) =>
      error instanceof ConnectorError &&
      error.code === "unsupported" &&
      error.detail === "kamelet.runner.unavailable",
  );
});

test("a browser-only deployment cannot be handed a local runner", async () => {
  // Acceptance: local runner capabilities cannot be claimed by a browser-only
  // deployment. Construction fails outright, so no code path exists in which
  // such a deployment reports local execution.
  const runner = unavailableKameletRunner("a runner that should never be taken");
  assert.throws(
    () =>
      createCamelKameletAdapter({
        runner,
        deploymentRuntime: "browser",
      }),
    (error: unknown) =>
      error instanceof ConnectorError &&
      error.code === "unsupported" &&
      error.detail === "kamelet.runner.browser-deployment",
  );
  const adapter = createCamelKameletAdapter({ deploymentRuntime: "browser" });
  const availability = await adapter.runnerAvailability();
  assert.equal(availability.available, false);
  assert.equal(
    availability.available === false ? availability.reason : "",
    KAMELET_BROWSER_DEPLOYMENT_REASON,
  );
  const rows = adapter.capabilities(new Set());
  for (const dimension of ["invoke", "delegate"] as const) {
    const row = rows.find((item) => item.dimension === dimension);
    assert.ok(row);
    assert.equal(row.implementation, "unsupported");
    assert.ok(
      row.limitations.some((limitation) => /browser runtime class/.test(limitation)),
    );
  }
});

test("a configured remote runner is unavailable until its signing secret is present", async () => {
  const runnerFixture = await startCamelRunnerFixture({ secret: SIGNING_SECRET });
  try {
    const { ctx, ports } = harness({ runnerOrigin: runnerFixture.origin });
    const runner = createRemoteKameletRunner(
      {
        runnerId: "fixture-runner",
        operationRef: KAMELET_RUN_OPERATION,
        signingSecretConfiguration: RUNNER_SECRET_CONFIGURATION,
      },
      { readConfiguration: (name) => ports.configuration.read(name) },
    );
    const before = await runner.available();
    assert.equal(before.available, false);
    assert.match(
      before.available === false ? before.reason : "",
      /CAMEL_RUNNER_SIGNING_SECRET/,
    );
    await assert.rejects(
      () =>
        runner.run(kameletRunDescriptor(kameletSettings), ctx, {
          operationRef: KAMELET_RUN_OPERATION,
          input: {},
          commandId: "command-1",
        }),
      (error: unknown) =>
        error instanceof ConnectorError &&
        error.detail === "kamelet.runner.secret-missing",
    );
    assert.equal(
      runnerFixture.requests.length,
      0,
      "an unsigned delegation is never sent",
    );
    ports.configuration.set(RUNNER_SECRET_CONFIGURATION, SIGNING_SECRET);
    const after = await runner.available();
    assert.equal(after.available, true);
    assert.equal(after.available === true ? after.authentication : "", "host-signed");
    assert.equal(after.available === true ? after.mode : "", "remote");
  } finally {
    await runnerFixture.close();
  }
});

test("delegation is host-signed and the runner verifies it independently", async () => {
  const runnerFixture = await startCamelRunnerFixture({
    secret: SIGNING_SECRET,
    reply: { state: "complete", output: { routeId: "fixture-route-1" } },
  });
  try {
    const { ctx, ports } = harness({ runnerOrigin: runnerFixture.origin });
    ports.configuration.set(RUNNER_SECRET_CONFIGURATION, SIGNING_SECRET);
    const runner = createRemoteKameletRunner(
      {
        runnerId: "fixture-runner",
        operationRef: KAMELET_RUN_OPERATION,
        signingSecretConfiguration: RUNNER_SECRET_CONFIGURATION,
      },
      { readConfiguration: (name) => ports.configuration.read(name) },
    );
    const adapter = createCamelKameletAdapter({ runner });
    const result = await adapter.invoke!(ctx, {
      operationRef: KAMELET_RUN_OPERATION,
      input: { trigger: "manual" },
      commandId: "command-run-1",
    });
    assert.equal(result.state, "complete");
    assert.deepEqual(result.output, { routeId: "fixture-route-1" });
    assert.equal(runnerFixture.rejected.length, 0);
    assert.equal(runnerFixture.accepted.length, 1);
    const descriptor = runnerFixture.accepted[0]!.descriptor as Record<
      string,
      unknown
    >;
    assert.equal(descriptor["descriptorVersion"], 1);
    assert.equal(descriptor["catalogVersion"], "4.22.0");
    assert.equal(descriptor["requiredRuntime"], "trusted-local-runner");
    // Secrets travel as host configuration names, never as values.
    assert.deepEqual(descriptor["secretParameters"], {
      accessKey: "FIXTURE_OBJECT_STORE_ACCESS_KEY",
      secretKey: "FIXTURE_OBJECT_STORE_SECRET_KEY",
    });
    const body = runnerFixture.requests[0]!.body.toString("utf8");
    assert.equal(body.includes(SIGNING_SECRET), false);
    // The effect is journalled, so an interrupted run is reconcilable.
    assert.ok(result.effectRef);
    const effects = ports.inspect.effects();
    assert.equal(effects.length, 1);
    assert.equal(effects[0]!.outcome?.status, "applied");
  } finally {
    await runnerFixture.close();
  }
});

test("a runner that rejects the signature produces a denial, not a silent local run", async () => {
  const runnerFixture = await startCamelRunnerFixture({ secret: "a-different-secret" });
  try {
    const { ctx, ports } = harness({ runnerOrigin: runnerFixture.origin });
    ports.configuration.set(RUNNER_SECRET_CONFIGURATION, SIGNING_SECRET);
    const runner = createRemoteKameletRunner(
      {
        runnerId: "fixture-runner",
        operationRef: KAMELET_RUN_OPERATION,
        signingSecretConfiguration: RUNNER_SECRET_CONFIGURATION,
      },
      { readConfiguration: (name) => ports.configuration.read(name) },
    );
    const adapter = createCamelKameletAdapter({ runner });
    await assert.rejects(
      () =>
        adapter.invoke!(ctx, {
          operationRef: KAMELET_RUN_OPERATION,
          input: {},
          commandId: "command-run-2",
        }),
      (error: unknown) =>
        error instanceof ConnectorError && error.code === "denied",
    );
    assert.deepEqual(
      runnerFixture.rejected.map((entry) => entry.reason),
      ["signature-mismatch"],
    );
    const effects = ports.inspect.effects();
    assert.equal(effects[0]!.outcome?.status, "indeterminate");
  } finally {
    await runnerFixture.close();
  }
});

test("an operation naming a different Kamelet than the binding is refused", async () => {
  const runnerFixture = await startCamelRunnerFixture({ secret: SIGNING_SECRET });
  try {
    const { ports, binding } = harness({ runnerOrigin: runnerFixture.origin });
    ports.configuration.set(RUNNER_SECRET_CONFIGURATION, SIGNING_SECRET);
    const tampered = {
      ...binding,
      operations: [
        { ...binding.operations[0]!, nativeId: "some-other-kamelet" },
      ],
    };
    const ctx: AdapterCallContext = {
      actor: fixtureActor,
      binding: tampered,
      generation: 0,
      signal: AbortSignal.timeout(5000),
      environment: ports.environment({ fetch: globalThis.fetch }),
    };
    const runner = createRemoteKameletRunner(
      {
        runnerId: "fixture-runner",
        operationRef: KAMELET_RUN_OPERATION,
        signingSecretConfiguration: RUNNER_SECRET_CONFIGURATION,
      },
      { readConfiguration: (name) => ports.configuration.read(name) },
    );
    const adapter = createCamelKameletAdapter({ runner });
    await assert.rejects(
      () =>
        adapter.invoke!(ctx, {
          operationRef: KAMELET_RUN_OPERATION,
          input: {},
          commandId: "command-run-3",
        }),
      (error: unknown) =>
        error instanceof ConnectorError &&
        error.detail === "kamelet.operation.kamelet-mismatch",
    );
    assert.equal(runnerFixture.requests.length, 0);
  } finally {
    await runnerFixture.close();
  }
});

test("the exported run descriptor carries configuration names and no credential value", async () => {
  const bytes = new Uint8Array(
    await readFile(
      fileURLToPath(
        new URL(
          "../fixtures/camel-kamelet/aws-s3-source.kamelet.yaml",
          import.meta.url,
        ),
      ),
    ),
  );
  const imported = await importKamelet(bytes, {
    sourceRef: "source:s3",
    origin: { kind: "upload" },
  });
  const { ctx } = harness({});
  const adapter = createCamelKameletAdapter();
  const exported = await adapter.export!(ctx, {
    definition: imported.definition,
    format: KAMELET_RUN_DESCRIPTOR_FORMAT,
    includeNativeExtensions: false,
  });
  const descriptor = JSON.parse(
    new TextDecoder().decode(exported.bytes),
  ) as Record<string, unknown>;
  assert.equal(descriptor["requiredRuntime"], "trusted-local-runner");
  assert.deepEqual(descriptor["secretParameters"], {});
  assert.deepEqual(descriptor["parameters"], {});
  assert.ok(
    exported.losses.some(
      (loss) => loss.code === "kamelet.export.credentials-omitted",
    ),
    "the credential omission is an explicit loss, not a silence",
  );
  assert.ok(
    exported.losses.some(
      (loss) => loss.code === "kamelet.export.template-omitted",
    ),
  );
  await assert.rejects(
    () =>
      adapter.export!(ctx, {
        definition: imported.definition,
        format: "camel/route-xml",
        includeNativeExtensions: false,
      }),
    (error: unknown) =>
      error instanceof ConnectorError && error.code === "unsupported",
  );
});
