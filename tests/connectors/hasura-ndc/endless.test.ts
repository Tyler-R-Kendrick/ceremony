import assert from "node:assert/strict";
import test from "node:test";
import { ConnectorError } from "../../../src/server/connectors/errors.js";
import {
  assertReadUnder,
  endlessFetch,
  type Pulled,
} from "../doubles/endless-body.js";
import { harness } from "./harness.js";

/*
 * The connector's answers are read under an 8 MiB ceiling; an answer that never
 * ends is cut off there.
 */

const rejects = (detail: string) => (error: unknown) =>
  error instanceof ConnectorError && error.detail === detail;

test("an answer from the connector that never ends is cut off at the body ceiling", async () => {
  const h = await harness();
  try {
    const seen: Pulled = { pulled: 0 };
    const ctx = {
      ...h.ctx,
      environment: h.ports.environment({
        fetch: endlessFetch(seen, [
          "src/server/connectors/providers/hasura-ndc/adapter.ts#call",
        ]),
      }),
    };
    await assert.rejects(
      () => h.adapter.verify!(ctx),
      rejects("ndc.response.too-large"),
    );
    assertReadUnder(assert, seen, 8 * 1024 * 1024, "ndc");
  } finally {
    await h.close();
  }
});
