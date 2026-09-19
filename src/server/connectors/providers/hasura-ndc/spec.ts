import { z } from "zod";
import { ConnectorError } from "../../errors.js";

/*
 * The Hasura Native Data Connector specification, pinned to one version.
 *
 * Pinned: ndc-spec **0.2.x**, implemented against 0.2.5 (the latest listed in
 * https://hasura.github.io/ndc-spec/specification/changelog.html, retrieved
 * 2026-09-18). Versioning rule, quoted from the spec: "a data connector
 * declares the semantic version of the specification that it implements via
 * its capabilities endpoint", and "Compatibility is defined as the semver
 * range: ^{requested-version}". So a connector reporting 0.2.1 or 0.2.5 is
 * compatible with a request for 0.2.0; one reporting 0.1.6 is not.
 *
 * Endpoints (verified): GET /capabilities, GET /schema, POST /query,
 * POST /mutation, GET /health. Status codes and their meaning come from the
 * spec's error-handling page; 501 means "it relies on an unsupported
 * capability", which is exactly the answer this adapter refuses to provoke.
 */

export const NDC_PINNED_VERSION = "0.2.0";
export const NDC_IMPLEMENTED_VERSION = "0.2.5";
export const NDC_PROFILE = "hasura-ndc-0.2";

export const ndcEndpoints = {
  capabilities: "/capabilities",
  schema: "/schema",
  query: "/query",
  mutation: "/mutation",
  health: "/health",
} as const;

const semver = /^(\d{1,5})\.(\d{1,5})\.(\d{1,5})(?:[-+][0-9A-Za-z.-]{1,64})?$/;

export type ParsedVersion = { major: number; minor: number; patch: number };

export function parseNdcVersion(value: string): ParsedVersion {
  const match = semver.exec(value);
  if (!match)
    throw new ConnectorError("upstream-rejected", {
      detail: "ndc.version.invalid",
    });
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
  };
}

/**
 * Caret compatibility as the spec defines it: for 0.x the minor version is the
 * breaking-change axis, so `^0.2.0` accepts 0.2.y with y >= 0 and rejects
 * 0.1.z and 0.3.z. For a hypothetical 1.x, the major version governs.
 */
export function ndcVersionCompatible(
  reported: string,
  requested: string = NDC_PINNED_VERSION,
): boolean {
  const have = parseNdcVersion(reported);
  const want = parseNdcVersion(requested);
  if (have.major !== want.major) return false;
  if (want.major === 0)
    return have.minor === want.minor && have.patch >= want.patch;
  return (
    have.minor > want.minor ||
    (have.minor === want.minor && have.patch >= want.patch)
  );
}

/*
 * Capability declarations. In NDC a capability is present when its key exists
 * (its value is an object, usually empty, that may carry sub-capabilities).
 * Absence means the connector does not support it, and the spec says a request
 * relying on an undeclared capability is a 501. This adapter therefore treats
 * the declaration as a gate and refuses before submission.
 */

const unitCapability = z.looseObject({});

export const ndcCapabilitiesSchema = z.looseObject({
  query: z.looseObject({
    aggregates: z
      .looseObject({
        filter_by: unitCapability.optional(),
        group_by: z
          .looseObject({
            filter: unitCapability.optional(),
            order: unitCapability.optional(),
            paginate: unitCapability.optional(),
          })
          .optional(),
      })
      .optional(),
    variables: unitCapability.optional(),
    explain: unitCapability.optional(),
    nested_fields: z
      .looseObject({
        filter_by: z.looseObject({}).optional(),
        order_by: unitCapability.optional(),
        aggregates: unitCapability.optional(),
        nested_collections: unitCapability.optional(),
      })
      .optional(),
    exists: z
      .looseObject({
        named_scopes: unitCapability.optional(),
        unrelated: unitCapability.optional(),
        nested_collections: unitCapability.optional(),
        nested_scalar_collections: unitCapability.optional(),
      })
      .optional(),
  }),
  mutation: z.looseObject({
    transactional: unitCapability.optional(),
    explain: unitCapability.optional(),
  }),
  relationships: z
    .looseObject({
      relation_comparisons: unitCapability.optional(),
      order_by_aggregate: unitCapability.optional(),
      nested: z
        .looseObject({
          array: unitCapability.optional(),
          filtering: unitCapability.optional(),
          ordering: unitCapability.optional(),
        })
        .optional(),
    })
    .optional(),
});
export type NdcCapabilities = z.infer<typeof ndcCapabilitiesSchema>;

export const ndcCapabilitiesResponseSchema = z.looseObject({
  version: z.string().min(1).max(64),
  capabilities: ndcCapabilitiesSchema,
});
export type NdcCapabilitiesResponse = z.infer<
  typeof ndcCapabilitiesResponseSchema
>;

/*
 * Schema documents. Types are preserved exactly; nothing is flattened into a
 * SQL-ish shape, because the spec's own execution surface is the typed
 * QueryRequest and nothing else.
 */

const typeName = z.string().min(1).max(512);
export const ndcTypeSchema: z.ZodType<unknown> = z.lazy(() =>
  z.union([
    z.looseObject({ type: z.literal("named"), name: typeName }),
    z.looseObject({
      type: z.literal("nullable"),
      underlying_type: ndcTypeSchema,
    }),
    z.looseObject({ type: z.literal("array"), element_type: ndcTypeSchema }),
    z.looseObject({
      type: z.literal("predicate"),
      object_type_name: typeName,
    }),
  ]),
);

const argumentInfoSchema = z.looseObject({
  description: z.string().max(4096).optional(),
  type: ndcTypeSchema,
});

export const ndcObjectFieldSchema = z.looseObject({
  description: z.string().max(4096).optional(),
  type: ndcTypeSchema,
  arguments: z.record(typeName, argumentInfoSchema).optional(),
});

export const ndcObjectTypeSchema = z.looseObject({
  description: z.string().max(4096).optional(),
  fields: z.record(typeName, ndcObjectFieldSchema),
  foreign_keys: z
    .record(
      typeName,
      z.looseObject({
        column_mapping: z.record(typeName, z.array(typeName).max(32)),
        foreign_collection: typeName,
      }),
    )
    .optional(),
});

export const ndcScalarTypeSchema = z.looseObject({
  representation: z.looseObject({ type: z.string().max(64) }).optional(),
  aggregate_functions: z.record(typeName, z.looseObject({})),
  comparison_operators: z.record(
    typeName,
    z.looseObject({ type: z.string().max(64) }),
  ),
  extraction_functions: z.record(typeName, z.looseObject({})).optional(),
});

export const ndcCollectionInfoSchema = z.looseObject({
  name: typeName,
  description: z.string().max(4096).optional(),
  arguments: z.record(typeName, argumentInfoSchema).optional(),
  type: typeName,
  uniqueness_constraints: z
    .record(
      typeName,
      z.looseObject({ unique_columns: z.array(typeName).max(64) }),
    )
    .optional(),
  relational_mutations: z.unknown().optional(),
});

export const ndcFunctionInfoSchema = z.looseObject({
  name: typeName,
  description: z.string().max(4096).optional(),
  arguments: z.record(typeName, argumentInfoSchema).optional(),
  result_type: ndcTypeSchema,
});

export const ndcProcedureInfoSchema = ndcFunctionInfoSchema;

export const ndcSchemaResponseSchema = z.looseObject({
  scalar_types: z.record(typeName, ndcScalarTypeSchema),
  object_types: z.record(typeName, ndcObjectTypeSchema),
  collections: z.array(ndcCollectionInfoSchema).max(4096),
  functions: z.array(ndcFunctionInfoSchema).max(4096),
  procedures: z.array(ndcProcedureInfoSchema).max(4096),
  capabilities: z.unknown().optional(),
  request_arguments: z.unknown().optional(),
});
export type NdcSchemaResponse = z.infer<typeof ndcSchemaResponseSchema>;

export const ndcErrorResponseSchema = z.looseObject({
  message: z.string().max(8192),
  details: z.unknown().optional(),
});

/*
 * Request shapes the adapter *builds*. They are declared here so a test can
 * validate what the adapter sent against the specification independently of
 * how the adapter assembled it.
 */

export const ndcArgumentSchema = z.union([
  z.strictObject({ type: z.literal("literal"), value: z.unknown() }),
  z.strictObject({ type: z.literal("variable"), name: typeName }),
]);

export const ndcRelationshipSchema = z.looseObject({
  column_mapping: z.record(typeName, z.array(typeName).max(32)),
  relationship_type: z.enum(["object", "array"]),
  target_collection: typeName,
  arguments: z.record(typeName, z.unknown()),
});

export const ndcQueryResponseSchema = z.array(
  z.looseObject({
    rows: z.array(z.record(typeName, z.unknown())).optional(),
    aggregates: z.record(typeName, z.unknown()).optional(),
    groups: z.array(z.unknown()).optional(),
  }),
);

export const ndcMutationResponseSchema = z.looseObject({
  operation_results: z
    .array(z.looseObject({ type: z.literal("procedure"), result: z.unknown() }))
    .max(256),
});

/** Human-readable capability paths, used in diagnostics and in the allowlist. */
export const ndcCapabilityPaths = [
  "query.aggregates",
  "query.aggregates.filter_by",
  "query.aggregates.group_by",
  "query.variables",
  "query.explain",
  "query.nested_fields",
  "query.nested_fields.filter_by",
  "query.nested_fields.order_by",
  "query.nested_fields.aggregates",
  "query.nested_fields.nested_collections",
  "query.exists.named_scopes",
  "query.exists.unrelated",
  "query.exists.nested_collections",
  "query.exists.nested_scalar_collections",
  "mutation.transactional",
  "mutation.explain",
  "relationships",
  "relationships.relation_comparisons",
  "relationships.order_by_aggregate",
  "relationships.nested",
  "relationships.nested.array",
  "relationships.nested.filtering",
  "relationships.nested.ordering",
] as const;
export type NdcCapabilityPath = (typeof ndcCapabilityPaths)[number];

/** Whether a capability path is declared; a missing key means unsupported. */
export function hasNdcCapability(
  capabilities: NdcCapabilities,
  path: NdcCapabilityPath,
): boolean {
  let node: unknown = capabilities;
  for (const segment of path.split(".")) {
    if (!node || typeof node !== "object") return false;
    if (!Object.hasOwn(node, segment)) return false;
    node = (node as Record<string, unknown>)[segment];
    if (node === undefined || node === null) return false;
  }
  return true;
}
