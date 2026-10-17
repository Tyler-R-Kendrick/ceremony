import { test } from "node:test";
import assert from "node:assert/strict";
import {
  assertReadUnder,
  endlessFetch,
  type Pulled,
} from "../doubles/endless-body.js";
import { ConnectorError } from "../../../src/server/connectors/errors.js";
import {
  KAMELET_RUN_OPERATION,
  createCamelKameletAdapter,
  createRemoteKameletRunner,
} from "../../../src/server/connectors/formats/camel-kamelet/index.js";
import {
  SIGNING_SECRET,
  RUNNER_SECRET_CONFIGURATION,
  harness,
} from "./harness.js";

/*
 * The runner's answer is read under a 256 KiB ceiling; one that never ends is
 * cut off there.
 */

test("a runner answer that never ends is cut off at the ceiling while it is read", async () => {
  const { ctx, ports } = harness({ runnerOrigin: "http://127.0.0.1:8765" });
  ports.configuration.set(RUNNER_SECRET_CONFIGURATION, SIGNING_SECRET);
  const seen: Pulled = { pulled: 0 };
  const endless = {
    ...ctx,
    environment: ports.environment({
      fetch: endlessFetch(seen, [
        "src/server/connectors/formats/camel-kamelet/runner.ts#run",
      ]),
    }),
  };
  const runner = createRemoteKameletRunner(
    {
      runnerId: "fixture-runner",
      operationRef: KAMELET_RUN_OPERATION,
      signingSecretConfiguration: RUNNER_SECRET_CONFIGURATION,
    },
    { readConfiguration: (name) => ports.configuration.read(name) },
  );
  const outcome = await createCamelKameletAdapter({ runner }).invoke!(endless, {
    operationRef: KAMELET_RUN_OPERATION,
    input: { trigger: "manual" },
    commandId: "command-endless",
  }).then(
    (result) => result.code,
    (error: unknown) =>
      error instanceof ConnectorError ? error.detail : String(error),
  );
  assert.equal(outcome, "kamelet.runner.response-oversized");
  assertReadUnder(assert, seen, 256 * 1024, "camel runner");
});
