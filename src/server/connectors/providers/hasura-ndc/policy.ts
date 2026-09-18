import { z } from "zod";
import { ConnectorError } from "../../errors.js";
import {
  hasNdcCapability,
  type NdcCapabilities,
  type NdcCapabilityPath,
  type NdcSchemaResponse,
} from "./spec.js";

/*
 * The bounded native adapter. A caller names an approved operation and gives
 * validated input; it never supplies a collection, a field list, a predicate,
 * a relationship or an argument that the binding has not approved, and the
 * adapter never rewrites what a caller asked for into something permitted.
 * When a request would rely on a capability the connector does not declare, or
 * touch a field, argument, predicate or relationship outside the allowlist,
 * the request is refused before a byte is sent (AC-EXT-14).
 *
 * The request shapes built here are the connector's own QueryRequest and
 * MutationRequest. There is no SQL anywhere in this adapter, and no untyped
 * escape hatch: every leaf is either a literal the caller passed through a
 * declared argument, or a name that survived the allowlist.
 */

const ndcName = z
  .string()
  .min(1)
  .max(512)
  .regex(/^[^\p{Cc}]+$/u);

/** The approved surface of one NDC operation; it lives in the binding's settings. */
export const ndcOperationPolicySchema = z
  .strictObject({
    /** Which NDC target this operation is: a collection, a function, or a procedure. */
    kind: z.enum(["collection", "function", "procedure"]),
    /** The exact native name; a caller never supplies it. */
    target: ndcName,
    /** Fields a caller may select. An empty list means no field selection is approved. */
    fields: z.array(ndcName).max(512),
    /** Arguments a caller may supply values for, with the declared name. */
    arguments: z.array(ndcName).max(64).default([]),
    /** Request-level arguments this operation is allowed to pass. */
    requestArguments: z.array(ndcName).max(64).default([]),
    /** Columns a caller may filter on, with the operators approved per column. */
    predicates: z
      .array(
        z.strictObject({
          column: ndcName,
          /** Comparison operator names; `is_null` is the spec's only unary operator. */
          operators: z.array(ndcName).max(32),
        }),
      )
      .max(128)
      .default([]),
    /** Relationship names a caller may traverse, with the fields approved on the target. */
    relationships: z
      .array(
        z.strictObject({
          name: ndcName,
          targetCollection: ndcName,
          fields: z.array(ndcName).max(512),
        }),
      )
      .max(32)
      .default([]),
    /** Aggregates a caller may request, by name; absent means aggregates are not approved. */
    aggregates: z
      .array(
        z.strictObject({
          column: ndcName,
          functions: z.array(ndcName).max(32),
          starCount: z.boolean().default(false),
        }),
      )
      .max(64)
      .default([]),
    /** A hard row ceiling the host imposes; a caller may ask for fewer, never more. */
    maxRows: z.number().int().min(1).max(10_000),
    /** Columns a caller may sort by. */
    orderBy: z.array(ndcName).max(64).default([]),
    /** A predicate the host always applies, expressed with approved columns only. */
    rowFilter: z.unknown().optional(),
  })
  .readonly();
export type NdcOperationPolicy = z.infer<typeof ndcOperationPolicySchema>;

/** Reads an operation policy out of an approved binding's inert settings. */
export function ndcPolicyFrom(
  settings: Record<string, unknown>,
  operationRef: string,
): NdcOperationPolicy {
  const policies = settings["ndc.operations"];
  if (!policies || typeof policies !== "object")
    throw new ConnectorError("denied", { detail: "ndc.policy.absent" });
  if (!Object.hasOwn(policies, operationRef))
    throw new ConnectorError("denied", { detail: "ndc.policy.absent" });
  const parsed = ndcOperationPolicySchema.safeParse(
    (policies as Record<string, unknown>)[operationRef],
  );
  if (!parsed.success)
    throw new ConnectorError("denied", { detail: "ndc.policy.invalid" });
  return parsed.data;
}

/*
 * Caller input. Everything here is a *selection within* the approved surface:
 * field names to include, argument values, comparison values, a smaller limit.
 * There is no free-form expression, no raw predicate tree and no relationship
 * the binding did not name.
 */

export const ndcQueryInputSchema = z
  .strictObject({
    fields: z.array(ndcName).max(512).optional(),
    arguments: z.record(ndcName, z.unknown()).optional(),
    requestArguments: z.record(ndcName, z.unknown()).optional(),
    filters: z
      .array(
        z.union([
          z.strictObject({
            column: ndcName,
            operator: ndcName,
            value: z.unknown(),
          }),
          z.strictObject({ column: ndcName, isNull: z.literal(true) }),
        ]),
      )
      .max(64)
      .optional(),
    relationships: z
      .array(
        z.strictObject({
          name: ndcName,
          fields: z.array(ndcName).max(512).optional(),
        }),
      )
      .max(32)
      .optional(),
    aggregates: z
      .array(
        z.union([
          z.strictObject({ name: ndcName, starCount: z.literal(true) }),
          z.strictObject({
            name: ndcName,
            column: ndcName,
            function: ndcName,
          }),
        ]),
      )
      .max(64)
      .optional(),
    orderBy: z
      .array(
        z.strictObject({
          column: ndcName,
          direction: z.enum(["asc", "desc"]),
        }),
      )
      .max(16)
      .optional(),
    limit: z.number().int().min(1).max(10_000).optional(),
    offset: z.number().int().min(0).max(1_000_000).optional(),
  })
  .readonly();
export type NdcQueryInput = z.infer<typeof ndcQueryInputSchema>;

export const ndcMutationInputSchema = z
  .strictObject({
    arguments: z.record(ndcName, z.unknown()).optional(),
    requestArguments: z.record(ndcName, z.unknown()).optional(),
    fields: z.array(ndcName).max(512).optional(),
  })
  .readonly();
export type NdcMutationInput = z.infer<typeof ndcMutationInputSchema>;

const denied = (detail: string): never => {
  throw new ConnectorError("denied", { detail });
};
const unsupported = (detail: string): never => {
  throw new ConnectorError("unsupported", { detail });
};

const requireCapability = (
  capabilities: NdcCapabilities,
  path: NdcCapabilityPath,
  detail: string,
) => {
  if (!hasNdcCapability(capabilities, path)) unsupported(detail);
};

type BuildContext = {
  policy: NdcOperationPolicy;
  capabilities: NdcCapabilities;
  schema: NdcSchemaResponse;
};

/** The object type backing a collection, function result or procedure result. */
function collectionObjectType(
  schema: NdcSchemaResponse,
  policy: NdcOperationPolicy,
): string | undefined {
  if (policy.kind === "collection")
    return schema.collections.find((item) => item.name === policy.target)?.type;
  return undefined;
}

function assertFieldsDeclared(
  ctx: BuildContext,
  objectTypeName: string | undefined,
  fields: readonly string[],
  detail: string,
) {
  if (!objectTypeName) return;
  const objectType = ctx.schema.object_types[objectTypeName];
  if (!objectType) denied(detail);
  for (const field of fields)
    if (!Object.hasOwn(objectType!.fields, field)) denied(detail);
}

/**
 * Builds a QueryRequest from the approved policy and the caller's selection.
 * Every step is a check that fails closed:
 *
 * - the target exists in the connector's schema;
 * - each selected field is in the allowlist *and* declared by the schema;
 * - each argument is declared by the schema and approved by the binding;
 * - each predicate column and operator is approved, and the operator exists on
 *   that column's scalar type;
 * - relationships require both the connector's `relationships` capability and
 *   an entry in the binding's relationship allowlist;
 * - aggregates require `query.aggregates` and an allowlist entry;
 * - the host's row ceiling always wins over the caller's limit.
 */
export function buildNdcQueryRequest(
  ctx: BuildContext,
  input: NdcQueryInput,
): Record<string, unknown> {
  const { policy, capabilities, schema } = ctx;
  if (policy.kind === "procedure")
    denied("ndc.operation.kind-mismatch");
  if (
    policy.kind === "collection" &&
    !schema.collections.some((item) => item.name === policy.target)
  )
    denied("ndc.collection.unknown");
  if (
    policy.kind === "function" &&
    !schema.functions.some((item) => item.name === policy.target)
  )
    denied("ndc.function.unknown");

  const approvedFields = new Set(policy.fields);
  const objectTypeName = collectionObjectType(schema, policy);

  // Functions are queried as a collection whose single field is `__value`.
  const selected =
    policy.kind === "function"
      ? ["__value"]
      : (input.fields ?? policy.fields).filter((field) => {
          if (!approvedFields.has(field)) denied("ndc.field.unapproved");
          return true;
        });
  if (policy.kind !== "function") {
    if (!selected.length) denied("ndc.field.none-approved");
    assertFieldsDeclared(ctx, objectTypeName, selected, "ndc.field.undeclared");
  }

  const fields: Record<string, unknown> = {};
  for (const field of selected)
    fields[field] = { type: "column", column: field };

  const relationshipFields: Record<string, unknown> = {};
  const collectionRelationships: Record<string, unknown> = {};
  for (const requested of input.relationships ?? []) {
    requireCapability(capabilities, "relationships", "ndc.relationships.undeclared");
    const approved = policy.relationships.find(
      (item) => item.name === requested.name,
    );
    if (!approved) denied("ndc.relationship.unapproved");
    const target = schema.collections.find(
      (item) => item.name === approved!.targetCollection,
    );
    if (!target) denied("ndc.relationship.unknown-target");
    const approvedTargetFields = new Set(approved!.fields);
    const targetFields = (requested.fields ?? approved!.fields).filter(
      (field) => {
        if (!approvedTargetFields.has(field))
          denied("ndc.relationship.field-unapproved");
        return true;
      },
    );
    if (!targetFields.length) denied("ndc.relationship.no-fields");
    assertFieldsDeclared(
      ctx,
      target!.type,
      targetFields,
      "ndc.relationship.field-undeclared",
    );
    const foreignKey = Object.values(
      (objectTypeName && schema.object_types[objectTypeName]?.foreign_keys) ?? {},
    ).find((key) => key.foreign_collection === approved!.targetCollection);
    if (!foreignKey) denied("ndc.relationship.no-foreign-key");
    collectionRelationships[requested.name] = {
      column_mapping: foreignKey!.column_mapping,
      relationship_type: "array",
      target_collection: approved!.targetCollection,
      arguments: {},
    };
    relationshipFields[requested.name] = {
      type: "relationship",
      relationship: requested.name,
      arguments: {},
      query: {
        fields: Object.fromEntries(
          targetFields.map((field) => [
            field,
            { type: "column", column: field },
          ]),
        ),
      },
    };
  }

  const predicates: unknown[] = [];
  for (const filter of input.filters ?? []) {
    const approved = policy.predicates.find(
      (item) => item.column === filter.column,
    );
    if (!approved) denied("ndc.predicate.unapproved");
    assertFieldsDeclared(
      ctx,
      objectTypeName,
      [filter.column],
      "ndc.predicate.undeclared-column",
    );
    if ("isNull" in filter) {
      if (!approved!.operators.includes("is_null"))
        denied("ndc.predicate.operator-unapproved");
      predicates.push({
        type: "unary_comparison_operator",
        operator: "is_null",
        column: { type: "column", name: filter.column },
      });
      continue;
    }
    if (!approved!.operators.includes(filter.operator))
      denied("ndc.predicate.operator-unapproved");
    // The operator must also exist on the column's scalar type.
    const columnType =
      objectTypeName === undefined
        ? undefined
        : schema.object_types[objectTypeName]?.fields[filter.column]?.type;
    const scalarName = namedTypeOf(columnType);
    if (scalarName && schema.scalar_types[scalarName]) {
      if (
        !Object.hasOwn(
          schema.scalar_types[scalarName]!.comparison_operators,
          filter.operator,
        )
      )
        unsupported("ndc.predicate.operator-undeclared");
    }
    predicates.push({
      type: "binary_comparison_operator",
      column: { type: "column", name: filter.column },
      operator: filter.operator,
      value: { type: "scalar", value: filter.value },
    });
  }
  if (policy.rowFilter !== undefined) predicates.push(policy.rowFilter);

  const aggregates: Record<string, unknown> = {};
  for (const requested of input.aggregates ?? []) {
    requireCapability(capabilities, "query.aggregates", "ndc.aggregates.undeclared");
    if ("starCount" in requested) {
      if (!policy.aggregates.some((item) => item.starCount))
        denied("ndc.aggregate.unapproved");
      aggregates[requested.name] = { type: "star_count" };
      continue;
    }
    const approved = policy.aggregates.find(
      (item) => item.column === requested.column,
    );
    if (!approved || !approved.functions.includes(requested.function))
      denied("ndc.aggregate.unapproved");
    assertFieldsDeclared(
      ctx,
      objectTypeName,
      [requested.column],
      "ndc.aggregate.undeclared-column",
    );
    aggregates[requested.name] = {
      type: "single_column",
      column: requested.column,
      function: requested.function,
    };
  }

  const orderByElements = (input.orderBy ?? []).map((element) => {
    if (!policy.orderBy.includes(element.column))
      denied("ndc.order-by.unapproved");
    assertFieldsDeclared(
      ctx,
      objectTypeName,
      [element.column],
      "ndc.order-by.undeclared-column",
    );
    return {
      order_direction: element.direction,
      target: { type: "column", name: element.column, path: [] },
    };
  });

  const args = buildArguments(
    ctx,
    input.arguments,
    policy.arguments,
    argumentInfoFor(schema, policy),
    "ndc.argument",
  );
  const requestArgs = input.requestArguments
    ? buildArguments(
        ctx,
        input.requestArguments,
        policy.requestArguments,
        undefined,
        "ndc.request-argument",
      )
    : undefined;

  const limit = Math.min(input.limit ?? policy.maxRows, policy.maxRows);
  const query: Record<string, unknown> = {
    fields: { ...fields, ...relationshipFields },
    limit,
  };
  if (Object.keys(aggregates).length) query.aggregates = aggregates;
  if (input.offset !== undefined) query.offset = input.offset;
  if (orderByElements.length) query.order_by = { elements: orderByElements };
  if (predicates.length)
    query.predicate =
      predicates.length === 1
        ? predicates[0]
        : { type: "and", expressions: predicates };

  return {
    collection: policy.target,
    query,
    arguments: args,
    collection_relationships: collectionRelationships,
    ...(requestArgs && Object.keys(requestArgs).length
      ? { request_arguments: requestArgs }
      : {}),
  };
}

function namedTypeOf(type: unknown): string | undefined {
  let node = type;
  for (let depth = 0; depth < 16; depth++) {
    if (!node || typeof node !== "object") return undefined;
    const record = node as Record<string, unknown>;
    if (record.type === "named" && typeof record.name === "string")
      return record.name;
    if (record.type === "nullable") node = record.underlying_type;
    else if (record.type === "array") node = record.element_type;
    else return undefined;
  }
  return undefined;
}

function argumentInfoFor(
  schema: NdcSchemaResponse,
  policy: NdcOperationPolicy,
): Record<string, unknown> | undefined {
  if (policy.kind === "collection")
    return schema.collections.find((item) => item.name === policy.target)
      ?.arguments;
  if (policy.kind === "function")
    return schema.functions.find((item) => item.name === policy.target)
      ?.arguments;
  return schema.procedures.find((item) => item.name === policy.target)
    ?.arguments;
}

function buildArguments(
  _ctx: BuildContext,
  supplied: Record<string, unknown> | undefined,
  approved: readonly string[],
  declared: Record<string, unknown> | undefined,
  detailPrefix: string,
): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [name, value] of Object.entries(supplied ?? {})) {
    if (!approved.includes(name)) denied(`${detailPrefix}.unapproved`);
    if (declared && !Object.hasOwn(declared, name))
      denied(`${detailPrefix}.undeclared`);
    result[name] = { type: "literal", value };
  }
  // Every argument the schema declares must be supplied; the spec requires the
  // provided set to be compatible with the declared one.
  for (const name of Object.keys(declared ?? {}))
    if (!Object.hasOwn(result, name)) denied(`${detailPrefix}.missing`);
  return result;
}

/**
 * Builds a MutationRequest for one approved procedure. Without the
 * `mutation.transactional` capability the spec requires exactly one operation
 * per request, which is what this builds; it never batches to look faster.
 */
export function buildNdcMutationRequest(
  ctx: BuildContext,
  input: NdcMutationInput,
): Record<string, unknown> {
  const { policy, schema } = ctx;
  if (policy.kind !== "procedure") denied("ndc.operation.kind-mismatch");
  const procedure = schema.procedures.find(
    (item) => item.name === policy.target,
  );
  if (!procedure) denied("ndc.procedure.unknown");

  const args = buildArguments(
    ctx,
    input.arguments,
    policy.arguments,
    procedure!.arguments,
    "ndc.argument",
  );
  const requestArgs = input.requestArguments
    ? buildArguments(
        ctx,
        input.requestArguments,
        policy.requestArguments,
        undefined,
        "ndc.request-argument",
      )
    : undefined;

  const approvedFields = new Set(policy.fields);
  const selected = (input.fields ?? policy.fields).filter((field) => {
    if (!approvedFields.has(field)) denied("ndc.field.unapproved");
    return true;
  });
  const resultTypeName = namedTypeOf(procedure!.result_type);
  if (selected.length)
    assertFieldsDeclared(ctx, resultTypeName, selected, "ndc.field.undeclared");

  const operation: Record<string, unknown> = {
    type: "procedure",
    name: policy.target,
    arguments: args,
  };
  if (selected.length)
    operation.fields = {
      type: "object",
      fields: Object.fromEntries(
        selected.map((field) => [field, { type: "column", column: field }]),
      ),
    };

  return {
    operations: [operation],
    collection_relationships: {},
    ...(requestArgs && Object.keys(requestArgs).length
      ? { request_arguments: requestArgs }
      : {}),
  };
}

export type { BuildContext as NdcBuildContext };
