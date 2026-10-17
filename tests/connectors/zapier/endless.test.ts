import { strict as assert } from "node:assert";
import { test } from "node:test";
import { ConnectorError } from "../../../src/server/connectors/errors.js";
import {
  assertReadUnder,
  endlessFetch,
  type Pulled,
} from "../doubles/endless-body.js";
import { OPERATION_REF, withHarness } from "./harness.js";

/*
 * The external automation runtime's answer is read under a 256 KiB ceiling; one
 * that never ends is cut off there, and a write is journaled as unknown.
 */

test("a runtime answer that never ends is cut off at the ceiling while it is read, and the write is unknown", async () => {
  await withHarness({}, async (h) => {
    const seen: Pulled = { pulled: 0 };
    const ctx = {
      ...h.ctx,
      environment: h.ports.environment({
        fetch: endlessFetch(seen, [
          "src/server/connectors/formats/automation/external-runtime.ts#invoke",
        ]),
      }),
    };
    await assert.rejects(
      h.adapter.invoke!(ctx, {
        operationRef: OPERATION_REF,
        input: { customer_id: "cus_1", total_cents: 4200, memo: "September" },
        commandId: "command-endless",
      }),
      (error: unknown) =>
        error instanceof ConnectorError && error.detail === "reply.size",
    );
    assertReadUnder(assert, seen, 256 * 1024, "external runtime");
    assert.equal(
      h.ports.inspect.effects()[0]?.outcome?.status,
      "indeterminate",
    );
  });
});
