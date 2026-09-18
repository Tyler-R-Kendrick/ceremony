import assert from "node:assert/strict";
import test from "node:test";
import { ConnectorError } from "../../../src/server/connectors/errors.js";
import {
  discoverNdc,
  hasNdcCapability,
  ndcVersionCompatible,
  parseNdcVersion,
  NDC_PINNED_VERSION,
} from "../../../src/server/connectors/providers/hasura-ndc/index.js";
import { startNdcConnectorDouble } from "../doubles/ndc-connector.js";
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

const clientFor = (double: Awaited<ReturnType<typeof startNdcConnectorDouble>>) => ({
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
  assert.equal(hasNdcCapability(minimalCapabilities, "query.aggregates"), false);
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
    const procedure = discovery.definition.capabilities
      .find((item) => item.nativeId === "upsert_article")
      ?.nativeExtensions?.["ndc.procedure"] as Record<string, unknown>;
    assert.deepEqual(procedure.result_type, {
      type: "nullable",
      underlying_type: { type: "named", name: "article" },
    });

    // Scalar types keep representations, operators and aggregate functions.
    const scalars = discovery.definition.nativeExtensions["ndc.scalar_types"] as
      Record<string, { comparison_operators: Record<string, unknown>; aggregate_functions: Record<string, unknown> }>;
    assert.deepEqual(Object.keys(scalars.Int!.comparison_operators), ["eq", "lt"]);
    assert.deepEqual(Object.keys(scalars.Int!.aggregate_functions), ["sum", "max"]);

    // Object types keep their foreign keys, which is how relationships stay honest.
    const objects = discovery.definition.nativeExtensions["ndc.object_types"] as
      Record<string, { foreign_keys: Record<string, unknown> }>;
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
      discovery.declaredCapabilities.includes("relationships.order_by_aggregate"),
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
    assert.equal(discovery.declaredCapabilities.includes("relationships"), false);
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
