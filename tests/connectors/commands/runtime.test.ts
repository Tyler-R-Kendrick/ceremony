import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import test, { type TestContext } from "node:test";
import * as connectors from "../../../src/server/connectors/index.js";
import { ConnectorError } from "../../../src/server/connectors/errors.js";
import { SQLiteCeremonyStore } from "../../../src/server/persistence/index.js";
import { FIXTURE_DOCUMENT, fixtureImporter, human, ORIGIN } from "./harness.js";

/*
 * The composition root and the package's public surface. The runtime must hand
 * the service everything the service can use -- an importer a host supplies
 * included -- and the package must expose the seams a host builds on (the
 * OAuth grants, the webhook receiver, the format readers), not only the ones
 * it configures.
 */

function runtime(
  t: TestContext,
  extra: Partial<connectors.ConnectorRuntimeOptions> = {},
) {
  const store = new SQLiteCeremonyStore(":memory:", {
    current: "test",
    keys: { test: randomBytes(32) },
  });
  t.after(() => store.close());
  return connectors.createConnectorRuntime({
    origin: ORIGIN,
    store,
    network: {
      mode: "loopback-fixture",
      maxRedirects: 0,
      maxResponseBytes: 1024 * 1024,
      timeoutMs: 5000,
    },
    configuration: () => ({
      read: async () => undefined,
      present: async () => new Set(),
      revision: async () => "cfg:1",
    }),
    ...extra,
  });
}

const upload = {
  kind: "upload",
  mediaType: "application/json",
  text: FIXTURE_DOCUMENT("https://fixture.example.test"),
} as const;

test("importers given to the runtime reach the service", async (t) => {
  const composed = runtime(t, { importers: [fixtureImporter] });
  const imported = await composed.service.import(human(), upload);
  assert.equal(imported.definitions.length, 1);
});

test("a runtime without importers says so rather than guessing a format", async (t) => {
  const composed = runtime(t);
  await assert.rejects(
    composed.service.import(human(), upload),
    (error: unknown) =>
      error instanceof ConnectorError && error.detail === "import.no-importer",
  );
});

test("the package exposes the OAuth grants, the webhook receiver and the format readers", () => {
  for (const name of [
    "beginAuthorizationCode",
    "completeAuthorizationCode",
    "refreshAccessToken",
    "beginDeviceAuthorization",
    "pollDeviceAuthorization",
    "acquireClientCredentials",
    "renewClientCredentials",
    "exchangeToken",
    "resolveAuthorizationServer",
    "resolveClientRegistration",
    "resolveConnectorOAuth",
  ] as const)
    assert.equal(typeof connectors.oauth[name], "function", name);
  assert.equal(typeof connectors.createWebhookReceiver, "function");
  assert.equal(
    connectors.events.createWebhookReceiver,
    connectors.createWebhookReceiver,
  );
  assert.equal(typeof connectors.formats.openapi.readOpenApi, "function");
  assert.equal(
    typeof connectors.formats.openapi.createOpenApiHttpAdapter,
    "function",
  );
  assert.equal(typeof connectors.formats.arazzo, "object");
});
