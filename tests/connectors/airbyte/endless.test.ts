import assert from "node:assert/strict";
import test from "node:test";
import { ConnectorError } from "../../../src/server/connectors/errors.js";
import { airbyteConfigurationNames } from "../../../src/server/connectors/providers/airbyte/index.js";
import {
  assertReadUnder,
  endlessFetch,
  type Pulled,
} from "../doubles/endless-body.js";
import { sourceId } from "../fixtures/airbyte/deployment.js";
import { harness } from "./harness.js";

/*
 * The Airbyte adapter reads the deployment's answers (its API and its
 * application token) under a byte ceiling; an answer that never ends is cut
 * off there. Each read names the bounded site it is served to.
 */

test("an answer from the deployment that never ends is cut off at the body ceiling", async () => {
  const h = await harness();
  try {
    const seen: Pulled = { pulled: 0 };
    const ctx = {
      ...h.ctx,
      environment: h.ports.environment({
        fetch: endlessFetch(seen, [
          "src/server/connectors/providers/airbyte/transport.ts#call",
        ]),
      }),
    };
    await assert.rejects(
      () => h.adapter.discover!(ctx, { scope: { sourceId } }),
      (error: unknown) =>
        error instanceof ConnectorError &&
        error.detail === "airbyte.response.invalid",
    );
    assertReadUnder(assert, seen, 4 * 1024 * 1024, "airbyte");
  } finally {
    await h.close();
  }
});

test("a token answer that never ends is cut off at the OAuth ceiling", async () => {
  const h = await harness();
  try {
    h.ports.configuration.set(airbyteConfigurationNames.clientId, "client-1");
    h.ports.configuration.set(
      airbyteConfigurationNames.clientSecret,
      "secret-1",
    );
    const seen: Pulled = { pulled: 0 };
    const ctx = {
      ...h.ctx,
      environment: h.ports.environment({
        fetch: endlessFetch(seen, [
          "src/server/connectors/providers/airbyte/transport.ts#accessToken",
        ]),
      }),
    };
    await assert.rejects(
      () => h.adapter.discover!(ctx, { scope: { sourceId } }),
      (error: unknown) =>
        error instanceof ConnectorError &&
        error.detail === "airbyte.token.invalid",
    );
    assertReadUnder(assert, seen, 1_048_576, "airbyte token");
  } finally {
    await h.close();
  }
});
