import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { fixtureActor, memoryPorts } from "../doubles/ports.js";
import { buildBinding } from "../fixtures/builders.js";
import { catalogEntryFor } from "../../../src/server/connectors/inventory.js";
import type { AdapterCallContext } from "../../../src/server/connectors/adapter.js";
import {
  CAMEL_KAMELET_ADAPTER_ID,
  KAMELET_CATALOG_VERSION,
  createCamelKameletAdapter,
  unavailableKameletRunner,
} from "../../../src/server/connectors/formats/camel-kamelet/index.js";
import { createDaprAdapter } from "../../../src/server/connectors/providers/dapr/index.js";
import { createOpenServiceBrokerAdapter } from "../../../src/server/connectors/providers/open-service-broker/index.js";

/*
 * Directory honesty. Each of these adapters really implements something, so
 * each reports `provider-backed` and marks the dimensions it cannot perform
 * `unsupported` one at a time. `catalog-only` would be a lie for all three,
 * and the catalog schema would reject it anyway once an implemented capability
 * is present.
 */

function ctxFor() {
  const ports = memoryPorts();
  const binding = buildBinding({
    adapterId: CAMEL_KAMELET_ADAPTER_ID,
    destinations: [],
    operations: [],
    configuration: [],
    profileId: undefined,
  });
  const ctx: AdapterCallContext = {
    actor: fixtureActor,
    binding,
    generation: 0,
    signal: AbortSignal.timeout(5000),
    environment: ports.environment({ fetch: globalThis.fetch }),
  };
  return { ports, ctx };
}

test("importing through the adapter yields a definition and a source record", async () => {
  const { ctx } = ctxFor();
  const adapter = createCamelKameletAdapter();
  const bytes = new Uint8Array(
    await readFile(
      fileURLToPath(
        new URL(
          "../fixtures/camel-kamelet/aws-s3-source.kamelet.yaml",
          import.meta.url,
        ),
      ),
    ),
  );
  const outcome = await adapter.import!(ctx, {
    bytes,
    mediaType: "application/yaml",
    origin: { kind: "url", location: "https://camel.example/kamelets/s3.yaml" },
  });
  assert.equal(outcome.definitions.length, 1);
  assert.equal(outcome.source.format.version, KAMELET_CATALOG_VERSION);
  assert.equal(outcome.source.origin.kind, "url");
  assert.deepEqual(outcome.executableCandidates, ["fixture-object-store-source"]);
  assert.ok(outcome.issues.length > 0);
});

test("the Kamelet catalog entry is provider-backed with per-dimension refusals", () => {
  const adapter = createCamelKameletAdapter();
  const entry = catalogEntryFor(adapter, new Set());
  assert.equal(entry.support, "provider-backed");
  assert.equal(entry.ecosystem, "camel-kamelet");
  assert.deepEqual(entry.runtimes, ["hosted-server"]);
  const byDimension = new Map(
    entry.capabilities.map((row) => [row.dimension, row]),
  );
  assert.equal(byDimension.get("import")?.implementation, "implemented");
  assert.equal(byDimension.get("export")?.implementation, "implemented");
  for (const dimension of [
    "discover",
    "configure",
    "authorize",
    "verify",
    "events",
    "reconnect",
    "disconnect",
    "revoke",
    "invoke",
    "delegate",
  ] as const) {
    const row = byDimension.get(dimension);
    assert.ok(row, dimension);
    assert.equal(row.implementation, "unsupported", dimension);
    assert.ok(row.limitations.length > 0, dimension);
  }
  // Fixture and catalog-only entries may carry no live evidence; this one is
  // fixture-measured and says so.
  assert.equal(entry.evidence, "protocol-fixture");
});

test("a configured runner turns invoke and delegate into implemented rows", () => {
  const runner = unavailableKameletRunner("configured but currently down");
  const adapter = createCamelKameletAdapter({ runner });
  const entry = catalogEntryFor(adapter, new Set());
  const byDimension = new Map(
    entry.capabilities.map((row) => [row.dimension, row]),
  );
  const invoke = byDimension.get("invoke")!;
  assert.equal(invoke.implementation, "implemented");
  assert.equal(invoke.runtime, "trusted-local-runner");
  assert.equal(byDimension.get("delegate")?.implementation, "implemented");
  // Presence of a runner never upgrades evidence beyond what was measured.
  assert.equal(invoke.evidence, "protocol-fixture");
});

test("the Dapr and broker adapters are provider-backed and unconfigured until their secrets exist", () => {
  for (const adapter of [
    createDaprAdapter(),
    createOpenServiceBrokerAdapter(),
  ]) {
    const entry = catalogEntryFor(adapter, new Set());
    // Neither adapter marks its configuration `required`, because each has a
    // documented mode that needs none (a loopback fixture sidecar; a broker
    // that authenticates out of band), so they stay provider-backed and the
    // per-dimension rows carry the configuration state instead.
    assert.equal(entry.support, "provider-backed");
    assert.equal(
      entry.capabilities.some((row) => row.implementation === "implemented"),
      true,
    );
    assert.equal(
      entry.capabilities.some(
        (row) => row.implementation === "unsupported" && row.limitations.length > 0,
      ),
      true,
    );
    for (const row of entry.capabilities)
      if (row.implementation === "unsupported")
        assert.equal(row.evidence, "not-tested", `${adapter.id}:${row.dimension}`);
  }
});
