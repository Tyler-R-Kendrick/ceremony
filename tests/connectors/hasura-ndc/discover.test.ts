import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { sourceRecordSchema } from "../../../src/core/connectors/index.js";
import type { AdapterCallContext } from "../../../src/server/connectors/adapter.js";
import { runtimeBindingSchema } from "../../../src/server/connectors/binding.js";
import { ConnectorError } from "../../../src/server/connectors/errors.js";
import {
  createHasuraNdcAdapter,
  discoverNdc,
  hasNdcCapability,
  ndcVersionCompatible,
  parseNdcVersion,
  NDC_ADAPTER_VERSION,
  NDC_PINNED_VERSION,
} from "../../../src/server/connectors/providers/hasura-ndc/index.js";
import { startNdcConnectorDouble } from "../doubles/ndc-connector.js";
import { fixtureActor, memoryPorts } from "../doubles/ports.js";
import {
  fullCapabilities,
  minimalCapabilities,
  NDC_VERSION,
  NDC_VERSION_LEGACY,
  readOnlySchema,
  schema,
} from "../fixtures/hasura-ndc/connector.js";

/*
 * Discovery against the documented /capabilities and /schema endpoints. The
 * pinned specification range is ^0.2.0; the double declares its own version
 * and the adapter's compatibility decision is asserted against the spec's
 * stated rule rather than against the adapter's own opinion.
 */

const clientFor = (
  double: Awaited<ReturnType<typeof startNdcConnectorDouble>>,
) => ({
  capabilities: async () => {
    const response = await fetch(`${double.origin}/capabilities`);
    return response.json();
  },
  schema: async () => {
    const response = await fetch(`${double.origin}/schema`);
    return response.json();
  },
  health: async () => {
    const response = await fetch(`${double.origin}/health`);
    return { ok: response.status === 200 };
  },
});

test("the pinned version range follows the specification's caret rule", () => {
  assert.equal(NDC_PINNED_VERSION, "0.2.0");
  // Quoted from the spec: "If the client sends 0.2.0, then the compatible
  // semver range is ^0.2.0. If the connector implemented spec version 0.1.6,
  // this would be incompatible, but if it implemented spec version 0.2.1, this
  // would be compatible."
  assert.equal(ndcVersionCompatible("0.2.1"), true);
  assert.equal(ndcVersionCompatible("0.2.5"), true);
  assert.equal(ndcVersionCompatible("0.2.0"), true);
  assert.equal(ndcVersionCompatible("0.1.6"), false);
  assert.equal(ndcVersionCompatible("0.3.0"), false);
  assert.equal(ndcVersionCompatible("1.0.0"), false);
  assert.deepEqual(parseNdcVersion("0.2.5"), { major: 0, minor: 2, patch: 5 });
  assert.throws(
    () => parseNdcVersion("zero-two"),
    (error: unknown) =>
      error instanceof ConnectorError && error.detail === "ndc.version.invalid",
  );
});

test("a capability is declared by the presence of its key, not by a boolean", () => {
  assert.equal(hasNdcCapability(fullCapabilities, "query.aggregates"), true);
  assert.equal(hasNdcCapability(fullCapabilities, "relationships"), true);
  assert.equal(
    hasNdcCapability(fullCapabilities, "relationships.order_by_aggregate"),
    true,
  );
  assert.equal(hasNdcCapability(minimalCapabilities, "relationships"), false);
  assert.equal(
    hasNdcCapability(minimalCapabilities, "query.aggregates"),
    false,
  );
  assert.equal(hasNdcCapability(minimalCapabilities, "query.variables"), false);
});

test("discovery preserves collections, functions, procedures and version-specific declarations", async () => {
  const double = await startNdcConnectorDouble({
    version: NDC_VERSION,
    capabilities: fullCapabilities,
    schema,
  });
  try {
    const discovery = await discoverNdc(clientFor(double));
    assert.equal(discovery.version, NDC_VERSION);
    assert.equal(discovery.versionCompatible, true);
    assert.deepEqual(discovery.health, { ok: true });

    // Collections and functions become query capabilities; procedures actions.
    const byKind = (kind: string) =>
      discovery.definition.capabilities
        .filter((item) => item.kind === kind)
        .map((item) => item.nativeId);
    assert.deepEqual(byKind("query"), [
      "articles",
      "authors",
      "articles_by_author",
      "latest_article_id",
    ]);
    assert.deepEqual(byKind("action"), ["upsert_article", "delete_articles"]);

    // The native documents travel intact.
    const collection = discovery.definition.capabilities[0]?.nativeExtensions?.[
      "ndc.collection"
    ] as Record<string, unknown>;
    assert.equal(collection.type, "article");
    assert.deepEqual(collection.uniqueness_constraints, {
      ArticleByID: { unique_columns: ["id"] },
    });
    const procedure = discovery.definition.capabilities.find(
      (item) => item.nativeId === "upsert_article",
    )?.nativeExtensions?.["ndc.procedure"] as Record<string, unknown>;
    assert.deepEqual(procedure.result_type, {
      type: "nullable",
      underlying_type: { type: "named", name: "article" },
    });

    // Scalar types keep representations, operators and aggregate functions.
    const scalars = discovery.definition.nativeExtensions[
      "ndc.scalar_types"
    ] as Record<
      string,
      {
        comparison_operators: Record<string, unknown>;
        aggregate_functions: Record<string, unknown>;
      }
    >;
    assert.deepEqual(Object.keys(scalars.Int!.comparison_operators), [
      "eq",
      "lt",
    ]);
    assert.deepEqual(Object.keys(scalars.Int!.aggregate_functions), [
      "sum",
      "max",
    ]);

    // Object types keep their foreign keys, which is how relationships stay honest.
    const objects = discovery.definition.nativeExtensions[
      "ndc.object_types"
    ] as Record<string, { foreign_keys: Record<string, unknown> }>;
    assert.deepEqual(objects.article!.foreign_keys, {
      article_author: {
        column_mapping: { author_id: ["id"] },
        foreign_collection: "authors",
      },
    });

    // The declared capability set is recorded as declared.
    assert.ok(discovery.declaredCapabilities.includes("relationships"));
    assert.ok(discovery.declaredCapabilities.includes("query.aggregates"));
    assert.ok(
      discovery.declaredCapabilities.includes(
        "relationships.order_by_aggregate",
      ),
    );
    assert.equal(
      discovery.definition.nativeExtensions["ndc.version"],
      NDC_VERSION,
    );
    assert.equal(discovery.definition.identity.nativeVersion, NDC_VERSION);
    assert.equal(
      discovery.definition.compatibility.dimensions.invoke,
      "requires-configuration",
    );
  } finally {
    await double.close();
  }
});

test("a connector on an incompatible spec version is blocked, not adapted", async () => {
  const double = await startNdcConnectorDouble({
    version: NDC_VERSION_LEGACY,
    capabilities: minimalCapabilities,
    schema,
  });
  try {
    const discovery = await discoverNdc(clientFor(double));
    assert.equal(discovery.versionCompatible, false);
    const issue = discovery.issues.find(
      (item) => item.code === "ndc.version.incompatible",
    );
    assert.equal(issue?.severity, "blocking");
    assert.equal(issue?.executionImpact, "blocks-definition");
    assert.equal(issue?.category, "version");
    assert.equal(
      discovery.definition.compatibility.dimensions.invoke,
      "unsupported",
    );
    // The schema is still described: a version mismatch is not data loss.
    assert.equal(discovery.definition.capabilities.length, 6);
  } finally {
    await double.close();
  }
});

test("an undeclared relationship capability is reported at discovery", async () => {
  const double = await startNdcConnectorDouble({
    version: NDC_VERSION,
    capabilities: minimalCapabilities,
    schema,
  });
  try {
    const discovery = await discoverNdc(clientFor(double));
    const issue = discovery.issues.find(
      (item) => item.code === "ndc.relationships.undeclared",
    );
    assert.equal(issue?.disposition, "unsupported");
    assert.equal(issue?.executionImpact, "blocks-operation");
    assert.equal(
      discovery.declaredCapabilities.includes("relationships"),
      false,
    );
  } finally {
    await double.close();
  }
});

test("a connector without procedures reports that mutations are unavailable", async () => {
  const double = await startNdcConnectorDouble({
    version: NDC_VERSION,
    capabilities: fullCapabilities,
    schema: readOnlySchema,
  });
  try {
    const discovery = await discoverNdc(clientFor(double));
    assert.ok(
      discovery.issues.some((item) => item.code === "ndc.procedures.absent"),
    );
    assert.equal(
      discovery.definition.capabilities.filter((item) => item.kind === "action")
        .length,
      0,
    );
  } finally {
    await double.close();
  }
});

test("a malformed capabilities or schema document is refused", async () => {
  await assert.rejects(
    () =>
      discoverNdc({
        capabilities: async () => ({ capabilities: {} }),
        schema: async () => schema,
      }),
    (error: unknown) =>
      error instanceof ConnectorError &&
      error.detail === "ndc.capabilities.invalid",
  );
  await assert.rejects(
    () =>
      discoverNdc({
        capabilities: async () => ({
          version: NDC_VERSION,
          capabilities: fullCapabilities,
        }),
        schema: async () => ({ collections: [] }),
      }),
    (error: unknown) =>
      error instanceof ConnectorError && error.detail === "ndc.schema.invalid",
  );
});

/*
 * The import seam. An import runs with no approved destination and no
 * configuration, so the documents arrive as bytes; nothing here may reach the
 * network.
 */
function importContext() {
  const ports = memoryPorts({ now: () => 1_770_000_000_000 });
  // Exactly the shape ConnectorCommandService builds for an adapter import:
  // no destinations, no operations, no settings, nothing to sign.
  const binding = runtimeBindingSchema.parse({
    bindingRef: "binding:import-context",
    definitionRef: "definition:import-context",
    revision: 0,
    adapterId: "hasura-ndc",
    adapterVersion: NDC_ADAPTER_VERSION,
    runtime: "hosted-server",
    custody: "no-credential",
    authorityInstance: "",
    status: "retired",
    approvedAt: "2026-09-18T00:00:00.000Z",
    policyRevision: "policy:ndc:1",
    tenantId: fixtureActor.tenantId,
    destinations: [],
    operations: [],
    configuration: [],
    permittedTargets: [],
    reviewedDigest: "a".repeat(64),
    settings: {},
  });
  let fetches = 0;
  const ctx: AdapterCallContext = {
    actor: fixtureActor,
    binding,
    generation: 0,
    signal: new AbortController().signal,
    environment: ports.environment({
      fetch: async (...args: Parameters<typeof fetch>) => {
        fetches++;
        return fetch(...args);
      },
    }),
  };
  return { ctx, fetches: () => fetches };
}

test("a captured capabilities and schema pair imports into the same normalized definition", async () => {
  const adapter = createHasuraNdcAdapter();
  const { ctx, fetches } = importContext();
  const document = {
    capabilities: { version: NDC_VERSION, capabilities: fullCapabilities },
    schema,
  };
  const bytes = new TextEncoder().encode(JSON.stringify(document));
  const outcome = await adapter.import!(ctx, {
    bytes,
    mediaType: "application/json",
    origin: { kind: "upload" },
  });

  // The record is a valid source record: the import seam persists it as-is.
  assert.equal(sourceRecordSchema.safeParse(outcome.source).success, true);
  // Named by the captured bytes, timed by the clock, and the declared spec
  // version travels as the format version.
  assert.equal(
    outcome.source.digest.value,
    createHash("sha256").update(bytes).digest("hex"),
  );
  assert.equal(
    outcome.source.sourceRef,
    `src:ndc:${outcome.source.digest.value}`,
  );
  assert.equal(outcome.source.format.name, "hasura-ndc");
  assert.equal(outcome.source.format.version, NDC_VERSION);
  assert.equal(
    outcome.source.capturedAt,
    new Date(1_770_000_000_000).toISOString(),
  );

  // The definition is the one discovery builds: collections, functions and
  // procedures, with the connector's own documents preserved.
  assert.equal(outcome.definitions.length, 1);
  const definition = outcome.definitions[0]!;
  assert.deepEqual(
    definition.capabilities.map((capability) => capability.nativeId),
    [
      "articles",
      "authors",
      "articles_by_author",
      "latest_article_id",
      "upsert_article",
      "delete_articles",
    ],
  );
  assert.equal(
    definition.nativeExtensions?.["ndc.version"] as unknown,
    NDC_VERSION,
  );
  assert.deepEqual(
    outcome.executableCandidates,
    definition.capabilities.map((capability) => capability.nativeId),
  );
  // Nothing was fetched: an import describes bytes, it does not visit a
  // connector, and there is no approved destination it could visit.
  assert.equal(fetches(), 0);
});

test("a connector outside the pinned range imports as a description with no candidates", async () => {
  const adapter = createHasuraNdcAdapter();
  const { ctx } = importContext();
  const bytes = new TextEncoder().encode(
    JSON.stringify({
      capabilities: {
        version: NDC_VERSION_LEGACY,
        capabilities: fullCapabilities,
      },
      schema,
    }),
  );
  const outcome = await adapter.import!(ctx, {
    bytes,
    mediaType: "application/json",
    origin: { kind: "upload" },
  });
  assert.deepEqual(outcome.executableCandidates, []);
  assert.ok(
    outcome.issues.some((issue) => issue.code === "ndc.version.incompatible"),
  );
});

test("a document that is not a capabilities and schema pair is refused", async () => {
  const adapter = createHasuraNdcAdapter();
  const { ctx } = importContext();
  const attempt = (text: string) =>
    adapter.import!(ctx, {
      bytes: new TextEncoder().encode(text),
      mediaType: "application/json",
      origin: { kind: "upload" },
    });
  await assert.rejects(
    () => attempt("not json"),
    (error: unknown) =>
      error instanceof ConnectorError && error.detail === "ndc.import.invalid",
  );
  await assert.rejects(
    () => attempt(JSON.stringify({ capabilities: {} })),
    (error: unknown) =>
      error instanceof ConnectorError && error.detail === "ndc.import.shape",
  );
  await assert.rejects(
    () => attempt(JSON.stringify({ capabilities: {}, schema })),
    (error: unknown) =>
      error instanceof ConnectorError &&
      error.detail === "ndc.capabilities.invalid",
  );
});

test("every reported dimension matches the method the adapter exposes", async () => {
  // The published matrix is generated from these rows, so a row that claims a
  // dimension the adapter has no method for advertises a column nothing can
  // serve. Checked in both directions rather than trusted.
  const adapter = createHasuraNdcAdapter();
  const rows = adapter.capabilities(new Set());
  const methods: Array<[string, keyof typeof adapter]> = [
    ["import", "import"],
    ["discover", "discover"],
    ["verify", "verify"],
    ["invoke", "invoke"],
    ["disconnect", "disconnect"],
    ["authorize", "authorize"],
    ["reconnect", "reconnect"],
    ["revoke", "revoke"],
    ["delegate", "delegate"],
  ];
  for (const [dimension, method] of methods) {
    const row = rows.find((item) => item.dimension === dimension);
    assert.equal(
      row?.implementation === "implemented",
      typeof adapter[method] === "function",
      `${dimension} is reported as ${row?.implementation} but the method is ${typeof adapter[method]}`,
    );
  }
});
