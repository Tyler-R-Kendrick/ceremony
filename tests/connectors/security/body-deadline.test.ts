import assert from "node:assert/strict";
import test from "node:test";
import { ConnectorError } from "../../../src/server/connectors/errors.js";
import {
  KAMELET_RUN_OPERATION,
  createCamelKameletAdapter,
  createRemoteKameletRunner,
} from "../../../src/server/connectors/formats/camel-kamelet/index.js";
import { airbyteConfigurationNames } from "../../../src/server/connectors/providers/airbyte/index.js";
import { createDaprAdapter } from "../../../src/server/connectors/providers/dapr/index.js";
import { createOpenServiceBrokerClient } from "../../../src/server/connectors/providers/open-service-broker/client.js";
import { harness as airbyte } from "../airbyte/harness.js";
import {
  harness as camel,
  RUNNER_SECRET_CONFIGURATION,
  SIGNING_SECRET,
} from "../camel-kamelet/harness.js";
import { harness as dapr } from "../dapr/harness.js";
import {
  TRICKLE_BYTES,
  TRICKLE_MS,
  timed,
  trickleFetch,
  trickled,
  type Trickled,
} from "../doubles/trickle-body.js";
import { sourceId } from "../fixtures/airbyte/deployment.js";
import { accountA, ACCOUNT_A_TOKEN } from "../fixtures/merge/accounts.js";
import { harness as hasura } from "../hasura-ndc/harness.js";
import { harness as merge } from "../merge/harness.js";

/*
 * One deadline for a request's headers and its whole body. Each reader here
 * used to clear its request timer once the headers arrived and then read the
 * body for as long as the provider kept sending it, so an answer trickling a
 * byte at a time held the call far past its deadline (a size ceiling does not
 * help: a byte every 50 ms stays under any ceiling for days). Each is served
 * such an answer with a 300 ms deadline: it must be cut at the deadline, the
 * body cancelled, and reported with the code the reader already uses for a
 * request that got no answer in time.
 */

const DEADLINE_MS = 300;
/** Far above the deadline and far below the trickle's own 10 s. */
const CUT_WITHIN_MS = 5_000;

function assertCut(
  outcome: { ms: number; error: unknown },
  seen: Trickled,
  expected: { code: string; detail: string },
  what: string,
) {
  const error = outcome.error;
  assert.ok(
    error instanceof ConnectorError &&
      error.code === expected.code &&
      error.detail === expected.detail,
    `${what}: ended with ${error instanceof ConnectorError ? `${error.code} ${error.detail}` : String(error)} after ${Math.round(outcome.ms)} ms`,
  );
  assert.ok(seen.sent > 0, `${what}: the body was in fact trickling`);
  assert.ok(seen.cancelled && !seen.ended, `${what}: the body was cancelled`);
  assert.ok(
    outcome.ms < CUT_WITHIN_MS,
    `${what}: took ${Math.round(outcome.ms)} ms; the deadline is ${DEADLINE_MS} ms and the body runs ${TRICKLE_BYTES * TRICKLE_MS} ms`,
  );
}

const unanswered = (detail: string) => ({
  code: "upstream-unavailable",
  detail,
});

test("Airbyte: an API answer that trickles past the deadline is cut at it", async () => {
  const h = await airbyte({}, {}, { requestTimeoutMs: DEADLINE_MS });
  try {
    const seen = trickled();
    const ctx = {
      ...h.ctx,
      environment: h.ports.environment({ fetch: trickleFetch(seen) }),
    };
    const outcome = await timed(() =>
      h.adapter.discover!(ctx, { scope: { sourceId } }),
    );
    assertCut(outcome, seen, unanswered("airbyte.request.failed"), "airbyte");
  } finally {
    await h.close();
  }
});

test("Airbyte: a caller that goes away mid-body ends the read as cancelled", async () => {
  const h = await airbyte({}, {}, { requestTimeoutMs: 60_000 });
  try {
    const seen = trickled();
    const caller = new AbortController();
    const ctx = {
      ...h.ctx,
      signal: caller.signal,
      environment: h.ports.environment({ fetch: trickleFetch(seen) }),
    };
    setTimeout(() => caller.abort(), DEADLINE_MS);
    const outcome = await timed(() =>
      h.adapter.discover!(ctx, { scope: { sourceId } }),
    );
    assertCut(
      outcome,
      seen,
      { code: "cancelled", detail: "airbyte.request.cancelled" },
      "airbyte cancelled",
    );
  } finally {
    await h.close();
  }
});

test("Airbyte: an application token answer that trickles past the deadline is cut at it", async () => {
  const h = await airbyte({}, {}, { requestTimeoutMs: DEADLINE_MS });
  try {
    h.ports.configuration.set(airbyteConfigurationNames.clientId, "client-1");
    h.ports.configuration.set(
      airbyteConfigurationNames.clientSecret,
      "secret-1",
    );
    const seen = trickled();
    const ctx = {
      ...h.ctx,
      environment: h.ports.environment({ fetch: trickleFetch(seen) }),
    };
    const outcome = await timed(() =>
      h.adapter.discover!(ctx, { scope: { sourceId } }),
    );
    assertCut(
      outcome,
      seen,
      unanswered("airbyte.token.failed"),
      "airbyte token",
    );
  } finally {
    await h.close();
  }
});

test("Merge: an answer that trickles past the deadline is cut at it", async () => {
  const h = await merge({
    accountToken: ACCOUNT_A_TOKEN,
    linkedAccountId: accountA.id,
    adapterOptions: { requestTimeoutMs: DEADLINE_MS },
  });
  try {
    const seen = trickled();
    const ctx = {
      ...h.ctx,
      environment: h.ports.environment({ fetch: trickleFetch(seen) }),
    };
    const outcome = await timed(() => h.adapter.verify!(ctx));
    assertCut(outcome, seen, unanswered("merge.request.failed"), "merge");
  } finally {
    await h.close();
  }
});

test("Hasura NDC: an answer that trickles past the deadline is cut at it", async () => {
  const h = await hasura({ adapterOptions: { requestTimeoutMs: DEADLINE_MS } });
  try {
    const seen = trickled();
    const ctx = {
      ...h.ctx,
      environment: h.ports.environment({ fetch: trickleFetch(seen) }),
    };
    const outcome = await timed(() => h.adapter.verify!(ctx));
    assertCut(outcome, seen, unanswered("ndc.request.failed"), "ndc");
  } finally {
    await h.close();
  }
});

test("Open Service Broker: a binding answer that trickles past the deadline is cut at it", async () => {
  const seen = trickled();
  const client = createOpenServiceBrokerClient({
    destination: {
      id: "broker",
      origin: "https://broker.example",
      network: "public",
    } as never,
    fetch: trickleFetch(seen),
    authorization: async () => undefined,
    limits: { requestTimeoutMs: DEADLINE_MS },
  });
  const outcome = await timed(() =>
    client.fetchBinding(
      { instanceId: "inst-1", bindingId: "bind-1" },
      { signal: new AbortController().signal, requestId: "req-1" },
    ),
  );
  assertCut(outcome, seen, unanswered("osb.unreachable"), "osb");
});

test("Dapr: a sidecar answer that trickles past the deadline is cut at it, and the write is unknown", async () => {
  const { ctx, ports } = dapr({ origin: "http://127.0.0.1:3500" });
  const seen = trickled();
  const outcome = await timed(() =>
    createDaprAdapter({ invoke: { requestTimeoutMs: DEADLINE_MS } }).invoke!(
      { ...ctx, environment: ports.environment({ fetch: trickleFetch(seen) }) },
      {
        operationRef: "operation:orders",
        input: { data: { orderId: "o-1" }, operation: "create" },
        commandId: "command-trickle",
      },
    ),
  );
  assertCut(outcome, seen, unanswered("dapr.sidecar.unreachable"), "dapr");
  assert.equal(ports.inspect.effects()[0]?.outcome?.status, "indeterminate");
});

test("Camel: a runner answer that trickles past the deadline is cut at it", async () => {
  const { ctx, ports } = camel({ runnerOrigin: "http://127.0.0.1:8765" });
  ports.configuration.set(RUNNER_SECRET_CONFIGURATION, SIGNING_SECRET);
  const seen = trickled();
  const runner = createRemoteKameletRunner(
    {
      runnerId: "fixture-runner",
      operationRef: KAMELET_RUN_OPERATION,
      signingSecretConfiguration: RUNNER_SECRET_CONFIGURATION,
      requestTimeoutMs: DEADLINE_MS,
    },
    { readConfiguration: (name) => ports.configuration.read(name) },
  );
  const outcome = await timed(() =>
    createCamelKameletAdapter({ runner }).invoke!(
      { ...ctx, environment: ports.environment({ fetch: trickleFetch(seen) }) },
      {
        operationRef: KAMELET_RUN_OPERATION,
        input: { trigger: "manual" },
        commandId: "command-trickle",
      },
    ),
  );
  assertCut(outcome, seen, unanswered("kamelet.runner.unreachable"), "camel");
});
