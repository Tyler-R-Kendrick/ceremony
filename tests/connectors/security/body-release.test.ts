import assert from "node:assert/strict";
import test from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import { ConnectorError } from "../../../src/server/connectors/errors.js";
import { airbyteConfigurationNames } from "../../../src/server/connectors/providers/airbyte/index.js";
import { withinDeadline } from "../../../src/server/connectors/request-deadline.js";
import { harness as airbyte } from "../airbyte/harness.js";
import { sourceId } from "../fixtures/airbyte/deployment.js";

/*
 * What a refusal does with the body it leaves behind. A reader that refuses
 * an answer before it touches the body (a 401, a not-ok status) must not
 * leave the body open on its socket until the garbage collector finds it.
 */

/** A body that says whether it was cancelled. */
function watched() {
  const seen = { cancelled: false };
  const response = new Response(
    new ReadableStream<Uint8Array>({
      pull(controller) {
        controller.enqueue(new Uint8Array([0x20]));
      },
      cancel() {
        seen.cancelled = true;
      },
    }),
    { status: 401 },
  );
  return { seen, response };
}

test("a read that refuses before touching the body cancels it", async () => {
  const { seen, response } = watched();
  const refusal = new ConnectorError("denied", { detail: "test.rejected" });
  await assert.rejects(
    withinDeadline(
      new AbortController().signal,
      5_000,
      (error) => new Error("unanswered", { cause: error }),
      async () => response,
      () => {
        throw refusal;
      },
    ),
    (error) => error === refusal,
  );
  await sleep(0);
  assert.ok(seen.cancelled, "the body was let go of");
});

test("Airbyte: a token answer refused by status cancels its body", async () => {
  const h = await airbyte({}, {}, { requestTimeoutMs: 5_000 });
  try {
    h.ports.configuration.set(airbyteConfigurationNames.clientId, "client-1");
    h.ports.configuration.set(
      airbyteConfigurationNames.clientSecret,
      "secret-1",
    );
    const { seen, response } = watched();
    const ctx = {
      ...h.ctx,
      environment: h.ports.environment({
        fetch: (async () => response) as typeof fetch,
      }),
    };
    await assert.rejects(
      () => h.adapter.discover!(ctx, { scope: { sourceId } }),
      (error: unknown) =>
        error instanceof ConnectorError &&
        error.detail === "airbyte.token.rejected",
    );
    await sleep(0);
    assert.ok(seen.cancelled, "the refused answer's body was cancelled");
  } finally {
    await h.close();
  }
});
