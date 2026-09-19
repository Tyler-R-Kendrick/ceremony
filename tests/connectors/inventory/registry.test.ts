import assert from "node:assert/strict";
import test from "node:test";
import {
  createConnectorRegistry,
  connectorInventoryShape,
} from "../../../src/server/connectors/adapters.js";
import { catalogFor } from "../../../src/server/connectors/inventory.js";

/*
 * The directory is the promise a deployment makes about what it can do, so
 * these tests treat every row as a claim to be checked rather than a label to
 * be trusted. The invariant under test: a row exists only when the adapter
 * behind it is really registered, and a row says "usable here" only when its
 * configuration is really present.
 */

const noConfiguration = () => new Set<string>();

test("INT-INV-01: the standard inventory builds and every adapter is distinct", () => {
  const registry = createConnectorRegistry();
  const adapters = registry.list();
  assert.equal(adapters.length, connectorInventoryShape().always);

  const ids = adapters.map((adapter) => adapter.id);
  assert.equal(new Set(ids).size, ids.length, "adapter ids must be unique");
  for (const id of ids) assert.match(id, /^[a-z][a-z0-9-]{0,119}$/);

  // Every registered adapter is retrievable by the id it reports.
  for (const adapter of adapters)
    assert.equal(registry.require(adapter.id), adapter);
});

test("INT-INV-02: an adapter needing a host port is absent until the host supplies it", () => {
  const bare = new Set(
    createConnectorRegistry()
      .list()
      .map((adapter) => adapter.id),
  );
  for (const { adapterId } of connectorInventoryShape().hostPortRequired)
    assert.ok(
      !bare.has(adapterId),
      `${adapterId} must not appear without its host port`,
    );

  // Supplying one port adds exactly that adapter and nothing else.
  const withSessions = createConnectorRegistry({
    ports: {
      supabaseSessions: {
        resolve: async () => undefined,
      } as never,
    },
  });
  const added = withSessions
    .list()
    .map((adapter) => adapter.id)
    .filter((id) => !bare.has(id));
  assert.deepEqual(added, ["supabase-data-api"]);
});

test("INT-INV-03: a provider-backed row is unconfigured until its configuration is present", () => {
  const registry = createConnectorRegistry();
  const entries = catalogFor(registry, noConfiguration);
  assert.equal(entries.length, registry.list().length);

  for (const entry of entries) {
    const adapter = registry.require(entry.id);
    const needsConfiguration = adapter.configuration.some(
      (item) => item.required,
    );
    if (adapter.support === "provider-backed" && needsConfiguration)
      assert.equal(
        entry.support,
        "unconfigured",
        `${entry.id} claims to be usable with no configuration present`,
      );
    // Nothing may claim evidence it has not measured.
    assert.ok(
      !["live-authorized", "deployed-authorized"].includes(entry.evidence),
      `${entry.id} claims live evidence, which no fixture can establish`,
    );
  }
});

test("INT-INV-04: present configuration promotes exactly the rows that asked for it", () => {
  const registry = createConnectorRegistry();
  const target = registry
    .list()
    .find(
      (adapter) =>
        adapter.support === "provider-backed" &&
        adapter.configuration.some((item) => item.required),
    );
  assert.ok(target, "expected at least one provider-backed adapter");

  const required = new Set(
    target.configuration
      .filter((item) => item.required)
      .map((item) => item.name),
  );
  const entries = catalogFor(registry, (adapter) =>
    adapter.id === target.id ? required : new Set<string>(),
  );
  const promoted = entries.find((entry) => entry.id === target.id);
  assert.ok(promoted);
  assert.equal(promoted.support, "provider-backed");
  // Its neighbours are unaffected: configuration is per adapter, not global.
  for (const entry of entries)
    if (entry.id !== target.id) {
      const adapter = registry.require(entry.id);
      if (
        adapter.support === "provider-backed" &&
        adapter.configuration.some((item) => item.required)
      )
        assert.equal(entry.support, "unconfigured", entry.id);
    }
});

test("INT-INV-05: a duplicate adapter id is refused rather than silently replacing", () => {
  const registry = createConnectorRegistry();
  const existing = registry.list()[0];
  assert.ok(existing);
  assert.throws(
    () => createConnectorRegistry({ additional: [existing] }),
    /already registered/,
  );
});

test("INT-INV-06: catalog rows report a real runtime and custody, never a guess", () => {
  const registry = createConnectorRegistry();
  for (const entry of catalogFor(registry, noConfiguration)) {
    const adapter = registry.require(entry.id);
    assert.deepEqual(entry.runtimes, [adapter.runtime], entry.id);
    assert.deepEqual([...entry.custody], [...adapter.custody], entry.id);
    assert.ok(entry.capabilities.length > 0, `${entry.id} reports no rows`);
    // A catalog-only adapter must not claim to implement a dimension.
    if (entry.support === "catalog-only")
      for (const status of entry.capabilities)
        assert.equal(status.implementation, "unsupported", entry.id);
  }
});
