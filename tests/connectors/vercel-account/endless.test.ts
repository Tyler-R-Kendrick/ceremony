import assert from "node:assert/strict";
import test from "node:test";
import type { AdapterCallContext } from "../../../src/server/connectors/adapter.js";
import { runtimeBindingSchema } from "../../../src/server/connectors/binding.js";
import { ConnectorError } from "../../../src/server/connectors/errors.js";
import { VERCEL_ACCOUNT_RESPONSE_LIMIT_BYTES } from "../../../src/server/connectors/providers/vercel-account/contracts.js";
import { readUser } from "../../../src/server/connectors/providers/vercel-account/client.js";
import {
  assertReadUnder,
  endlessFetch,
  type Pulled,
} from "../doubles/endless-body.js";
import { accountSetup } from "./harness.js";

/*
 * Vercel's REST reads (the signed-in user, the teams) are read under 1 MiB.
 * An answer that never ends is cut off there, with the code the module gives
 * an answer over the ceiling.
 */

test("a Vercel REST answer that never ends is cut off at the byte ceiling", async (t) => {
  const { binding } = await accountSetup(t);
  const seen: Pulled = { pulled: 0 };
  const ctx = {
    binding: runtimeBindingSchema.parse({
      ...binding,
      destinations: [
        {
          id: "api",
          origin: "http://127.0.0.1:4010",
          network: "loopback-fixture",
        },
      ],
      operations: [],
    }),
    signal: new AbortController().signal,
    environment: {
      fetch: endlessFetch(seen, [
        "src/server/connectors/providers/vercel-account/client.ts#get",
      ]),
    },
  } as unknown as AdapterCallContext;
  await assert.rejects(
    readUser(ctx, "vca_dummy_bearer"),
    (error: unknown) =>
      error instanceof ConnectorError &&
      error.code === "upstream-rejected" &&
      error.detail === "vercel-account.response.too-large",
  );
  assertReadUnder(
    assert,
    seen,
    VERCEL_ACCOUNT_RESPONSE_LIMIT_BYTES,
    "a Vercel REST answer",
  );
});
