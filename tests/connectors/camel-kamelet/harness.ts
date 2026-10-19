import { fixtureActor, memoryPorts } from "../doubles/ports.js";
import { buildBinding } from "../fixtures/builders.js";
import type { AdapterCallContext } from "../../../src/server/connectors/adapter.js";
import {
  CAMEL_KAMELET_ADAPTER_ID,
  KAMELET_RUN_OPERATION,
  type KameletHostRunnerPort,
} from "../../../src/server/connectors/formats/camel-kamelet/index.js";

/* A Kamelet binding and call context over the in-memory ports, shared by the Camel suites. */

export const SIGNING_SECRET = "CEREMONY_FIXTURE_RUNNER_SECRET";
export const RUNNER_SECRET_CONFIGURATION = "CAMEL_RUNNER_SIGNING_SECRET";

export const kameletSettings = {
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

export function harness(options: {
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
