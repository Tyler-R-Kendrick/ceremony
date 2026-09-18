import assert from "node:assert/strict";
import test from "node:test";
import {
  runtimeBindingSchema,
  type RuntimeBinding,
} from "../../../src/server/connectors/binding.js";
import { ConnectorError } from "../../../src/server/connectors/errors.js";
import type {
  AdapterCallContext,
  ConnectionRecord,
} from "../../../src/server/connectors/index.js";
import {
  createHasuraNdcAdapter,
  ndcConfigurationNames,
} from "../../../src/server/connectors/providers/hasura-ndc/index.js";
import { startNdcConnectorDouble } from "../doubles/ndc-connector.js";
import { fixtureActor, memoryPorts } from "../doubles/ports.js";
import {
  articleRows,
  authorRows,
  fullCapabilities,
  minimalCapabilities,
  NDC_VERSION,
  NDC_VERSION_LEGACY,
  schema,
} from "../fixtures/hasura-ndc/connector.js";

/*
 * AC-EXT-14. The double independently validates every request against the
 * specification and its own declared capabilities, answering 501 or 400 where
 * the spec says to. A test that asserts "no request arrived" therefore proves
 * the adapter refused before submission, and a test that asserts the double
 * recorded no violation proves what did arrive was spec-correct.
 */

const approvedArticles = {
  kind: "collection",
  target: "articles",
  fields: ["id", "title", "author_id"],
  arguments: [],
  requestArguments: [],
  predicates: [
    { column: "id", operators: ["eq", "lt", "is_null"] },
    { column: "title", operators: ["like"] },
  ],
  relationships: [
    {
      name: "article_author",
      targetCollection: "authors",
      fields: ["id", "name"],
    },
  ],
  aggregates: [{ column: "id", functions: ["max"], starCount: true }],
  orderBy: ["id"],
  maxRows: 2,
};

const approvedProcedure = {
  kind: "procedure",
  target: "upsert_article",
  fields: ["id", "title"],
  arguments: ["article"],
  requestArguments: [],
  predicates: [],
  relationships: [],
  aggregates: [],
  orderBy: [],
  maxRows: 1,
};

const approvedFunction = {
  kind: "function",
  target: "latest_article_id",
  fields: ["__value"],
  arguments: [],
  requestArguments: [],
  predicates: [],
  relationships: [],
  aggregates: [],
  orderBy: [],
  maxRows: 1,
};

function bindingFor(
  origin: string,
  options: {
    capabilities?: Record<string, unknown>;
    version?: string;
    operations?: Record<string, unknown>;
  } = {},
): RuntimeBinding {
  return runtimeBindingSchema.parse({
    bindingRef: "binding:ndc:1",
    definitionRef: "def:ndc:1",
    revision: 2,
    adapterId: "hasura-ndc",
    adapterVersion: "2026.09.18",
    runtime: "hosted-server",
    custody: "host-owned",
    authorityInstance: origin,
    status: "approved",
    approvedAt: "2026-09-18T00:00:00.000Z",
    policyRevision: "policy-1",
    tenantId: fixtureActor.tenantId,
    destinations: [{ id: "connector", origin, network: "loopback-fixture" }],
    operations: [
      {
        operationRef: "op:articles.read",
        nativeId: "articles",
        destinationId: "connector",
        transport: { kind: "http", method: "POST", pathTemplate: "/query" },
        effect: "read",
        outputClassification: "personal",
        cost: "free",
        consent: "none",
        replay: "read-only",
        targetParameters: [],
      },
      {
        operationRef: "op:latest.read",
        nativeId: "latest_article_id",
        destinationId: "connector",
        transport: { kind: "http", method: "POST", pathTemplate: "/query" },
        effect: "read",
        outputClassification: "personal",
        cost: "free",
        consent: "none",
        replay: "read-only",
        targetParameters: [],
      },
      {
        operationRef: "op:article.upsert",
        nativeId: "upsert_article",
        destinationId: "connector",
        transport: { kind: "http", method: "POST", pathTemplate: "/mutation" },
        effect: "write",
        outputClassification: "personal",
        cost: "free",
        consent: "confirm",
        replay: "none",
        targetParameters: [],
      },
    ],
    configuration: [],
    permittedTargets: [],
    reviewedDigest: "b".repeat(64),
    settings: {
      "ndc.reviewed": {
        version: options.version ?? NDC_VERSION,
        capabilities: options.capabilities ?? fullCapabilities,
        schema,
      },
      "ndc.operations": options.operations ?? {
        "op:articles.read": approvedArticles,
        "op:latest.read": approvedFunction,
        "op:article.upsert": approvedProcedure,
      },
    },
  });
}

async function harness(
  options: {
    capabilities?: Record<string, unknown>;
    version?: string;
    operations?: Record<string, unknown>;
    doubleOptions?: Parameters<typeof startNdcConnectorDouble>[0];
  } = {},
) {
  const double = await startNdcConnectorDouble({
    version: options.version ?? NDC_VERSION,
    capabilities: options.capabilities ?? fullCapabilities,
    schema,
    rows: { articles: articleRows, authors: authorRows },
    procedureResults: { upsert_article: { id: 4, title: "New" } },
    ...options.doubleOptions,
  });
  const ports = memoryPorts({ now: () => 1_770_000_000_000 });
  const binding = bindingFor(double.origin, options);
  const record: ConnectionRecord = {
    connectionRef: "conn:ndc:1",
    bindingRef: binding.bindingRef,
    definitionRef: binding.definitionRef,
    ecosystem: "hasura-ndc",
    service: "hasura-ndc",
    displayName: "NDC connector",
    ownerKind: "organization",
    custody: "host-owned",
    runtime: "hosted-server",
    lifecycle: "active",
    generation: 1,
    revision: 1,
    createdAt: "2026-09-18T00:00:00.000Z",
    updatedAt: "2026-09-18T00:00:00.000Z",
    tenantId: fixtureActor.tenantId,
    ownerId: fixtureActor.subjectId,
    authorityInstance: binding.authorityInstance,
    bindingRevision: binding.revision,
    policyRevision: binding.policyRevision,
    configurationRevision: "cfg:1",
    externalIds: {},
    evidenceRefs: [],
    state: {},
  };
  await ports.connections.create(record);
  const controller = new AbortController();
  const ctx: AdapterCallContext = {
    actor: fixtureActor,
    binding,
    connection: record,
    generation: 1,
    signal: controller.signal,
    environment: ports.environment({ fetch: globalThis.fetch }),
  };
  return {
    double,
    ports,
    ctx,
    adapter: createHasuraNdcAdapter(),
    async close() {
      controller.abort();
      await double.close();
    },
  };
}

const rejects = (detail: string) => (error: unknown) =>
  error instanceof ConnectorError && error.detail === detail;

test("an approved query is built as a native QueryRequest with no SQL", async () => {
  const h = await harness();
  try {
    const result = await h.adapter.invoke!(h.ctx, {
      operationRef: "op:articles.read",
      commandId: "cmd-1",
      input: {
        fields: ["id", "title"],
        filters: [{ column: "id", operator: "lt", value: 3 }],
        orderBy: [{ column: "id", direction: "asc" }],
      },
    });
    assert.equal(result.state, "complete");
    assert.equal(result.effect, "read");
    assert.equal(result.outputClassification, "personal");

    const [request] = h.double.queries();
    assert.equal(request?.collection, "articles");
    assert.deepEqual(request?.query, {
      fields: {
        id: { type: "column", column: "id" },
        title: { type: "column", column: "title" },
      },
      limit: 2,
      order_by: {
        elements: [
          {
            order_direction: "asc",
            target: { type: "column", name: "id", path: [] },
          },
        ],
      },
      predicate: {
        type: "binary_comparison_operator",
        column: { type: "column", name: "id" },
        operator: "lt",
        value: { type: "scalar", value: 3 },
      },
    });
    assert.deepEqual(request?.arguments, {});
    assert.deepEqual(request?.collection_relationships, {});
    // The double validated it against the specification and found nothing wrong.
    assert.deepEqual(h.double.violations, []);
    // The unapproved column never appears in the result rows.
    const rows = (result.output as Array<{ rows: Array<Record<string, unknown>> }>)[0]!
      .rows;
    assert.deepEqual(Object.keys(rows[0]!), ["id", "title"]);
    assert.equal(JSON.stringify(result.output).includes("SECRET-NOTE"), false);
  } finally {
    await h.close();
  }
});

test("AC-EXT-14: an unapproved field is rejected before submission", async () => {
  const h = await harness();
  try {
    await assert.rejects(
      () =>
        h.adapter.invoke!(h.ctx, {
          operationRef: "op:articles.read",
          commandId: "cmd-field",
          input: { fields: ["id", "internal_notes"] },
        }),
      rejects("ndc.field.unapproved"),
    );
    assert.equal(h.double.queries().length, 0, "nothing was sent");
    assert.deepEqual(h.double.violations, []);
  } finally {
    await h.close();
  }
});

test("AC-EXT-14: an unapproved predicate column or operator is rejected before submission", async () => {
  const h = await harness();
  try {
    await assert.rejects(
      () =>
        h.adapter.invoke!(h.ctx, {
          operationRef: "op:articles.read",
          commandId: "cmd-pred-col",
          input: { filters: [{ column: "internal_notes", operator: "like", value: "x" }] },
        }),
      rejects("ndc.predicate.unapproved"),
    );
    await assert.rejects(
      () =>
        h.adapter.invoke!(h.ctx, {
          operationRef: "op:articles.read",
          commandId: "cmd-pred-op",
          // `like` is approved on title but not on id.
          input: { filters: [{ column: "id", operator: "like", value: "x" }] },
        }),
      rejects("ndc.predicate.operator-unapproved"),
    );
    assert.equal(h.double.queries().length, 0);
  } finally {
    await h.close();
  }
});

test("AC-EXT-14: an operator the connector's scalar type does not declare is rejected", async () => {
  const h = await harness({
    operations: {
      "op:articles.read": {
        ...approvedArticles,
        // The binding approves `gt` on id, but the Int scalar declares only eq and lt.
        predicates: [{ column: "id", operators: ["gt"] }],
      },
    },
  });
  try {
    await assert.rejects(
      () =>
        h.adapter.invoke!(h.ctx, {
          operationRef: "op:articles.read",
          commandId: "cmd-op",
          input: { filters: [{ column: "id", operator: "gt", value: 1 }] },
        }),
      (error: unknown) =>
        error instanceof ConnectorError &&
        error.code === "unsupported" &&
        error.detail === "ndc.predicate.operator-undeclared",
    );
    assert.equal(h.double.queries().length, 0);
  } finally {
    await h.close();
  }
});

test("AC-EXT-14: a relationship the connector does not declare support for is rejected", async () => {
  const h = await harness({ capabilities: minimalCapabilities });
  try {
    await assert.rejects(
      () =>
        h.adapter.invoke!(h.ctx, {
          operationRef: "op:articles.read",
          commandId: "cmd-rel",
          input: { relationships: [{ name: "article_author" }] },
        }),
      (error: unknown) =>
        error instanceof ConnectorError &&
        error.code === "unsupported" &&
        error.detail === "ndc.relationships.undeclared",
    );
    assert.equal(h.double.queries().length, 0, "no 501 was provoked");
  } finally {
    await h.close();
  }
});

test("AC-EXT-14: a relationship the binding did not approve is rejected even when declared", async () => {
  const h = await harness();
  try {
    await assert.rejects(
      () =>
        h.adapter.invoke!(h.ctx, {
          operationRef: "op:articles.read",
          commandId: "cmd-rel-2",
          input: { relationships: [{ name: "article_editor" }] },
        }),
      rejects("ndc.relationship.unapproved"),
    );
    // An approved relationship cannot be widened to unapproved target fields.
    await assert.rejects(
      () =>
        h.adapter.invoke!(h.ctx, {
          operationRef: "op:articles.read",
          commandId: "cmd-rel-3",
          input: {
            relationships: [{ name: "article_author", fields: ["id", "salary"] }],
          },
        }),
      rejects("ndc.relationship.field-unapproved"),
    );
    assert.equal(h.double.queries().length, 0);
  } finally {
    await h.close();
  }
});

test("an approved relationship builds the native shape from the schema's foreign key", async () => {
  const h = await harness();
  try {
    await h.adapter.invoke!(h.ctx, {
      operationRef: "op:articles.read",
      commandId: "cmd-rel-ok",
      input: {
        fields: ["id"],
        relationships: [{ name: "article_author", fields: ["name"] }],
      },
    });
    const [request] = h.double.queries();
    assert.deepEqual(request?.collection_relationships, {
      article_author: {
        column_mapping: { author_id: ["id"] },
        relationship_type: "array",
        target_collection: "authors",
        arguments: {},
      },
    });
    const fields = (request?.query as Record<string, unknown>).fields as Record<
      string,
      unknown
    >;
    assert.deepEqual(fields.article_author, {
      type: "relationship",
      relationship: "article_author",
      arguments: {},
      query: { fields: { name: { type: "column", column: "name" } } },
    });
    assert.deepEqual(h.double.violations, []);
  } finally {
    await h.close();
  }
});

test("AC-EXT-14: aggregates require both the capability and an allowlist entry", async () => {
  const withoutAggregates = await harness({ capabilities: minimalCapabilities });
  try {
    await assert.rejects(
      () =>
        withoutAggregates.adapter.invoke!(withoutAggregates.ctx, {
          operationRef: "op:articles.read",
          commandId: "cmd-agg",
          input: { aggregates: [{ name: "total", starCount: true }] },
        }),
      (error: unknown) =>
        error instanceof ConnectorError &&
        error.detail === "ndc.aggregates.undeclared",
    );
    assert.equal(withoutAggregates.double.queries().length, 0);
  } finally {
    await withoutAggregates.close();
  }

  const h = await harness();
  try {
    await assert.rejects(
      () =>
        h.adapter.invoke!(h.ctx, {
          operationRef: "op:articles.read",
          commandId: "cmd-agg-2",
          input: {
            aggregates: [{ name: "n", column: "author_id", function: "sum" }],
          },
        }),
      rejects("ndc.aggregate.unapproved"),
    );
    // The approved aggregate goes through in the native shape.
    await h.adapter.invoke!(h.ctx, {
      operationRef: "op:articles.read",
      commandId: "cmd-agg-3",
      input: { fields: ["id"], aggregates: [{ name: "biggest", column: "id", function: "max" }] },
    });
    const query = h.double.queries()[0]?.query as Record<string, unknown>;
    assert.deepEqual(query.aggregates, {
      biggest: { type: "single_column", column: "id", function: "max" },
    });
    assert.deepEqual(h.double.violations, []);
  } finally {
    await h.close();
  }
});

test("AC-EXT-14: the host row ceiling always wins over the caller's limit", async () => {
  const h = await harness();
  try {
    await h.adapter.invoke!(h.ctx, {
      operationRef: "op:articles.read",
      commandId: "cmd-limit",
      input: { fields: ["id"], limit: 5000 },
    });
    const query = h.double.queries()[0]?.query as Record<string, unknown>;
    assert.equal(query.limit, 2, "clamped to the policy maximum");
  } finally {
    await h.close();
  }
});

test("a row filter the host imposes is combined with the caller's predicate", async () => {
  const h = await harness({
    operations: {
      "op:articles.read": {
        ...approvedArticles,
        rowFilter: {
          type: "binary_comparison_operator",
          column: { type: "column", name: "author_id" },
          operator: "eq",
          value: { type: "scalar", value: 1 },
        },
      },
    },
  });
  try {
    await h.adapter.invoke!(h.ctx, {
      operationRef: "op:articles.read",
      commandId: "cmd-filter",
      input: { fields: ["id"], filters: [{ column: "id", operator: "lt", value: 3 }] },
    });
    const query = h.double.queries()[0]?.query as Record<string, unknown>;
    const predicate = query.predicate as { type: string; expressions: unknown[] };
    assert.equal(predicate.type, "and");
    assert.equal(predicate.expressions.length, 2);
    assert.deepEqual(h.double.violations, []);
  } finally {
    await h.close();
  }
});

test("declared collection arguments must be supplied and approved", async () => {
  const h = await harness({
    operations: {
      "op:articles.read": {
        ...approvedArticles,
        target: "articles_by_author",
        arguments: ["author_id"],
      },
    },
  });
  try {
    // Missing a declared argument is refused rather than defaulted.
    await assert.rejects(
      () =>
        h.adapter.invoke!(h.ctx, {
          operationRef: "op:articles.read",
          commandId: "cmd-arg-missing",
          input: { fields: ["id"] },
        }),
      rejects("ndc.argument.missing"),
    );
    // An argument the binding did not approve is refused.
    await assert.rejects(
      () =>
        h.adapter.invoke!(h.ctx, {
          operationRef: "op:articles.read",
          commandId: "cmd-arg-extra",
          input: { fields: ["id"], arguments: { author_id: 1, secret: 2 } },
        }),
      rejects("ndc.argument.unapproved"),
    );
    await h.adapter.invoke!(h.ctx, {
      operationRef: "op:articles.read",
      commandId: "cmd-arg-ok",
      input: { fields: ["id"], arguments: { author_id: 1 } },
    });
    assert.deepEqual(h.double.queries()[0]?.arguments, {
      author_id: { type: "literal", value: 1 },
    });
    assert.deepEqual(h.double.violations, []);
  } finally {
    await h.close();
  }
});

test("a function is queried through its __value column as the spec prescribes", async () => {
  const h = await harness({
    doubleOptions: { rows: { latest_article_id: [{ __value: 3 }] } },
  });
  try {
    await h.adapter.invoke!(h.ctx, {
      operationRef: "op:latest.read",
      commandId: "cmd-fn",
      input: {},
    });
    const [request] = h.double.queries();
    assert.equal(request?.collection, "latest_article_id");
    assert.deepEqual((request?.query as Record<string, unknown>).fields, {
      __value: { type: "column", column: "__value" },
    });
    assert.deepEqual(h.double.violations, []);
  } finally {
    await h.close();
  }
});

test("an approved mutation builds a single-operation MutationRequest and is journaled", async () => {
  const h = await harness();
  try {
    const result = await h.adapter.invoke!(h.ctx, {
      operationRef: "op:article.upsert",
      commandId: "cmd-mut",
      input: {
        arguments: { article: { id: 4, title: "New", author_id: 1 } },
        fields: ["id", "title"],
      },
    });
    assert.equal(result.state, "complete");
    assert.equal(result.effect, "write");
    assert.ok(result.effectRef);

    const [request] = h.double.mutations();
    assert.deepEqual(request?.operations, [
      {
        type: "procedure",
        name: "upsert_article",
        arguments: {
          article: { type: "literal", value: { id: 4, title: "New", author_id: 1 } },
        },
        fields: {
          type: "object",
          fields: {
            id: { type: "column", column: "id" },
            title: { type: "column", column: "title" },
          },
        },
      },
    ]);
    assert.deepEqual(request?.collection_relationships, {});
    assert.deepEqual(h.double.violations, []);

    const journal = h.ports.inspect.effects();
    assert.equal(journal.length, 1);
    assert.equal(journal[0]?.intent.operation, "ndc.mutation.upsert_article");
    assert.equal(journal[0]?.outcome?.status, "applied");
  } finally {
    await h.close();
  }
});

test("a repeated mutation returns the journaled outcome instead of running twice", async () => {
  const h = await harness();
  try {
    const input = {
      arguments: { article: { id: 4, title: "New", author_id: 1 } },
      fields: ["id"],
    };
    const first = await h.adapter.invoke!(h.ctx, {
      operationRef: "op:article.upsert",
      commandId: "cmd-same",
      input,
    });
    const second = await h.adapter.invoke!(h.ctx, {
      operationRef: "op:article.upsert",
      commandId: "cmd-same",
      input,
    });
    assert.equal(h.double.mutations().length, 1);
    assert.equal(second.effectRef, first.effectRef);
    assert.equal(second.output, undefined);
  } finally {
    await h.close();
  }
});

test("an interrupted mutation is indeterminate and stays journaled as such", async () => {
  const h = await harness({ doubleOptions: { failMutation: { times: 1, status: 503 } } });
  try {
    const result = await h.adapter.invoke!(h.ctx, {
      operationRef: "op:article.upsert",
      commandId: "cmd-uncertain",
      input: { arguments: { article: { id: 9, title: "X", author_id: 1 } } },
    });
    assert.equal(result.state, "indeterminate");
    assert.equal(result.code, "ndc.mutation.uncertain");
    assert.equal(h.ports.inspect.effects()[0]?.outcome?.status, "indeterminate");
  } finally {
    await h.close();
  }
});

test("a mutation missing a declared procedure argument never reaches the connector", async () => {
  const h = await harness();
  try {
    await assert.rejects(
      () =>
        h.adapter.invoke!(h.ctx, {
          operationRef: "op:article.upsert",
          commandId: "cmd-mut-arg",
          input: { fields: ["id"] },
        }),
      rejects("ndc.argument.missing"),
    );
    assert.equal(h.double.mutations().length, 0);
    assert.deepEqual(h.ports.inspect.effects(), []);
  } finally {
    await h.close();
  }
});

test("AC-EXT-14: a version mismatch blocks execution before any request", async () => {
  const h = await harness({ version: NDC_VERSION_LEGACY });
  try {
    await assert.rejects(
      () =>
        h.adapter.invoke!(h.ctx, {
          operationRef: "op:articles.read",
          commandId: "cmd-version",
          input: { fields: ["id"] },
        }),
      (error: unknown) =>
        error instanceof ConnectorError &&
        error.code === "unsupported" &&
        error.detail === "ndc.version.incompatible",
    );
    assert.equal(h.double.queries().length, 0);
  } finally {
    await h.close();
  }
});

test("an operation with no policy, or a mismatched transport, is denied", async () => {
  const h = await harness();
  try {
    await assert.rejects(
      () =>
        h.adapter.invoke!(h.ctx, {
          operationRef: "op:unknown",
          commandId: "cmd-unknown",
          input: {},
        }),
      rejects("ndc.policy.absent"),
    );
    // A query policy cannot be executed through the mutation endpoint.
    const ctx = {
      ...h.ctx,
      binding: {
        ...h.ctx.binding,
        operations: h.ctx.binding.operations.map((operation) =>
          operation.operationRef === "op:articles.read"
            ? {
                ...operation,
                transport: {
                  kind: "http" as const,
                  method: "POST" as const,
                  pathTemplate: "/mutation",
                },
              }
            : operation,
        ),
      },
    };
    await assert.rejects(
      () =>
        h.adapter.invoke!(ctx, {
          operationRef: "op:articles.read",
          commandId: "cmd-transport",
          input: { fields: ["id"] },
        }),
      rejects("ndc.operation.transport-mismatch"),
    );
    assert.equal(h.double.requests.length, 0);
  } finally {
    await h.close();
  }
});

test("the connector's service token is sent only when configured and never surfaces", async () => {
  const h = await harness({
    doubleOptions: { serviceToken: "svc-token" },
  });
  try {
    // Without the configured token the connector refuses; the adapter reports denied.
    await assert.rejects(
      () =>
        h.adapter.invoke!(h.ctx, {
          operationRef: "op:articles.read",
          commandId: "cmd-token-missing",
          input: { fields: ["id"] },
        }),
      (error: unknown) =>
        error instanceof ConnectorError && error.code === "denied",
    );
    h.ports.configuration.set(ndcConfigurationNames.serviceToken, "svc-token");
    const result = await h.adapter.invoke!(h.ctx, {
      operationRef: "op:articles.read",
      commandId: "cmd-token",
      input: { fields: ["id"] },
    });
    assert.equal(result.state, "complete");
    assert.equal(JSON.stringify(result).includes("svc-token"), false);
  } finally {
    await h.close();
  }
});

test("verify records declared capabilities as declarations, not observations", async () => {
  const h = await harness();
  try {
    const result = await h.adapter.verify!(h.ctx);
    assert.equal(result.state, "complete");
    const claim = result.claims[0];
    assert.equal(claim?.kind, "resource-access");
    assert.deepEqual(claim?.permissions?.observed, []);
    assert.ok(claim!.permissions!.reported.includes("relationships"));
    assert.ok(
      claim?.limitations.some((text) =>
        text.includes("not observed behaviour"),
      ),
    );
    assert.ok(
      claim?.limitations.some((text) =>
        text.includes("no authorization over the data"),
      ),
    );
  } finally {
    await h.close();
  }
});

test("verify denies an incompatible connector rather than downgrading the request", async () => {
  const h = await harness({
    doubleOptions: { version: NDC_VERSION_LEGACY, capabilities: minimalCapabilities },
  });
  try {
    const result = await h.adapter.verify!(h.ctx);
    assert.equal(result.state, "denied");
    assert.equal(result.code, "ndc.version.incompatible");
    assert.deepEqual(result.claims, []);
  } finally {
    await h.close();
  }
});

test("the adapter reports host-owned custody and a pinned profile", () => {
  const adapter = createHasuraNdcAdapter();
  assert.equal(adapter.id, "hasura-ndc");
  assert.deepEqual([...adapter.custody], ["host-owned"]);
  const statuses = adapter.capabilities(new Set());
  const invoke = statuses.find((status) => status.dimension === "invoke");
  assert.equal(invoke?.profile, "hasura-ndc-0.2");
  assert.ok(invoke?.limitations.some((text) => text.includes("^0.2.0")));
  assert.ok(invoke?.limitations.some((text) => text.includes("no SQL")));
  assert.equal(
    statuses.find((status) => status.dimension === "delegate")?.implementation,
    "unsupported",
  );
});
