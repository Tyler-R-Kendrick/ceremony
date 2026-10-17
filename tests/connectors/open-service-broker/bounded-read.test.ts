import assert from "node:assert/strict";
import test from "node:test";
import { ConnectorError } from "../../../src/server/connectors/errors.js";
import { createOpenServiceBrokerClient } from "../../../src/server/connectors/providers/open-service-broker/client.js";
import {
  assertReadUnder,
  endlessFetch,
  type Pulled,
} from "../doubles/endless-body.js";

/*
 * A binding's answer carries the credentials the adapter puts in custody, so
 * the client's 512 KiB ceiling is applied while the body is read: a broker
 * that never stops is cut off there, not after the whole answer was held.
 */

test("a binding answer that never ends is cut off at the client's ceiling", async () => {
  const seen: Pulled = { pulled: 0 };
  const client = createOpenServiceBrokerClient({
    destination: {
      id: "broker",
      origin: "https://broker.example",
      network: "public",
    } as never,
    fetch: endlessFetch(seen, [
      "src/server/connectors/providers/open-service-broker/client.ts#get",
    ]),
    authorization: async () => undefined,
  });
  await assert.rejects(
    client.fetchBinding(
      { instanceId: "inst-1", bindingId: "bind-1" },
      { signal: new AbortController().signal, requestId: "req-1" },
    ),
    (error: unknown) =>
      error instanceof ConnectorError &&
      error.code === "upstream-rejected" &&
      error.detail === "osb.response.oversized",
  );
  assertReadUnder(assert, seen, 512 * 1024, "osb");
});
