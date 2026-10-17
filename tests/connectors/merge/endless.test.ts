import assert from "node:assert/strict";
import test from "node:test";
import { ConnectorError } from "../../../src/server/connectors/errors.js";
import {
  assertReadUnder,
  endlessFetch,
  type Pulled,
} from "../doubles/endless-body.js";
import { accountA, ACCOUNT_A_TOKEN } from "../fixtures/merge/accounts.js";
import { harness } from "./harness.js";

/*
 * Merge's answers are provider data read under an 8 MiB ceiling; an answer
 * that never ends is cut off there.
 */

const rejects = (detail: string) => (error: unknown) =>
  error instanceof ConnectorError && error.detail === detail;

test("an answer from Merge that never ends is cut off at the body ceiling", async () => {
  const h = await harness({
    accountToken: ACCOUNT_A_TOKEN,
    linkedAccountId: accountA.id,
  });
  try {
    const seen: Pulled = { pulled: 0 };
    const ctx = {
      ...h.ctx,
      environment: h.ports.environment({
        fetch: endlessFetch(seen, [
          "src/server/connectors/providers/merge/adapter.ts#call",
        ]),
      }),
    };
    await assert.rejects(
      () => h.adapter.verify!(ctx),
      rejects("merge.response.too-large"),
    );
    assertReadUnder(assert, seen, 8 * 1024 * 1024, "merge");
  } finally {
    await h.close();
  }
});
