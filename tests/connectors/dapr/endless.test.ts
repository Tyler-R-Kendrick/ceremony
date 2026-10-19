import { test } from "node:test";
import assert from "node:assert/strict";
import {
  assertReadUnder,
  endlessFetch,
  type Pulled,
} from "../doubles/endless-body.js";
import { ConnectorError } from "../../../src/server/connectors/errors.js";
import {
  DAPR_MAX_RESPONSE_BYTES,
  createDaprAdapter,
} from "../../../src/server/connectors/providers/dapr/index.js";
import { harness } from "./harness.js";

/*
 * The sidecar's answer is read under a 1 MiB ceiling; one that never ends is
 * cut off there, and a write is journaled as unknown.
 */

test("a sidecar answer that never ends is cut off at the ceiling while it is read, and the effect is unknown", async () => {
  const { ctx, ports } = harness({ origin: "http://127.0.0.1:3500" });
  const seen: Pulled = { pulled: 0 };
  const endless = {
    ...ctx,
    environment: ports.environment({
      fetch: endlessFetch(seen, [
        "src/server/connectors/providers/dapr/invoke.ts#invokeDaprOutputBinding",
      ]),
    }),
  };
  await assert.rejects(
    createDaprAdapter().invoke!(endless, {
      operationRef: "operation:orders",
      input: { data: { orderId: "o-1" }, operation: "create" },
      commandId: "command-endless",
    }),
    (error: unknown) =>
      error instanceof ConnectorError &&
      error.detail === "dapr.response.oversized",
  );
  assertReadUnder(assert, seen, DAPR_MAX_RESPONSE_BYTES, "dapr");
  assert.equal(ports.inspect.effects()[0]?.outcome?.status, "indeterminate");
});
