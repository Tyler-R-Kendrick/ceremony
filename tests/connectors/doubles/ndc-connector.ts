import { startHttpFixture } from "./http-fixture.js";

/*
 * An independent double of an NDC connector's HTTP surface, written from
 * https://hasura.github.io/ndc-spec/ (0.2.x, retrieved 2026-09-18) and not
 * from the adapter under test. It serves exactly the documented endpoints:
 *
 *   GET  /capabilities -> CapabilitiesResponse { version, capabilities }
 *   GET  /schema       -> SchemaResponse
 *   POST /query        -> QueryResponse (array of RowSet)
 *   POST /mutation     -> MutationResponse { operation_results }
 *   GET  /health       -> 200 with no body
 *
 * The double independently validates each request against the specification
 * *and* against its own declared capabilities, answering 501 ("it relies on an
 * unsupported capability") and 400 exactly as the spec prescribes. That is the
 * point: if the adapter ever let an undeclared capability through, this double
 * would answer 501 and the test would see the request arrive. A passing test
 * therefore shows the request never left, not that the double was lenient.
 */

export type NdcDoubleOptions = {
  version?: string;
  capabilities?: Record<string, unknown>;
  schema?: Record<string, unknown>;
  /** Rows answered to a valid query; keyed by collection name. */
  rows?: Record<string, Array<Record<string, unknown>>>;
  /** Result answered to a valid procedure call, keyed by procedure name. */
  procedureResults?: Record<string, unknown>;
  /** Bearer token the connector requires, when the deployment protects it. */
  serviceToken?: string | undefined;
  health?: boolean;
  /** Fail the next N mutations with this status, to exercise uncertainty. */
  failMutation?: { times: number; status: number };
};

type Json = Record<string, unknown>;

const isObject = (value: unknown): value is Json =>
  !!value && typeof value === "object" && !Array.isArray(value);

/** Walks a capability path the way the spec does: a key's presence is the declaration. */
function declared(capabilities: Json, path: string): boolean {
  let node: unknown = capabilities;
  for (const segment of path.split(".")) {
    if (!isObject(node) || !Object.hasOwn(node, segment)) return false;
    node = node[segment];
  }
  return node !== undefined && node !== null;
}

export async function startNdcConnectorDouble(options: NdcDoubleOptions = {}) {
  const version = options.version ?? "0.2.5";
  const capabilities = (options.capabilities ?? {
    query: { variables: {}, nested_fields: {} },
    mutation: {},
  }) as Json;
  const schema = (options.schema ?? {
    scalar_types: {},
    object_types: {},
    collections: [],
    functions: [],
    procedures: [],
  }) as Json;
  const violations: string[] = [];

  const error = (status: number, message: string, detail?: string) => {
    violations.push(`${status}:${detail ?? message}`);
    return { status, body: { message, details: detail ? { detail } : {} } };
  };

  /** Validates a QueryRequest against the spec and the declared capabilities. */
  const validateQuery = (body: unknown) => {
    if (!isObject(body)) return error(400, "malformed request", "not-object");
    if (typeof body.collection !== "string")
      return error(400, "collection is required", "collection");
    if (!isObject(body.query)) return error(400, "query is required", "query");
    if (!isObject(body.arguments))
      return error(400, "arguments is required", "arguments");
    if (!isObject(body.collection_relationships))
      return error(400, "collection_relationships is required", "relationships");

    const collections = (schema.collections as Json[]) ?? [];
    const functions = (schema.functions as Json[]) ?? [];
    const collection = collections.find((item) => item.name === body.collection);
    const fn = functions.find((item) => item.name === body.collection);
    if (!collection && !fn)
      return error(400, "unknown collection", "unknown-collection");

    const query = body.query;
    if (query.aggregates !== undefined && !declared(capabilities, "query.aggregates"))
      return error(501, "aggregates are not supported", "aggregates");
    if (body.variables !== undefined && !declared(capabilities, "query.variables"))
      return error(501, "variables are not supported", "variables");
    if (
      Object.keys(body.collection_relationships as Json).length &&
      !declared(capabilities, "relationships")
    )
      return error(501, "relationships are not supported", "relationships");

    const fields = isObject(query.fields) ? query.fields : {};
    for (const [, field] of Object.entries(fields)) {
      if (!isObject(field)) return error(400, "malformed field", "field");
      if (field.type === "relationship") {
        if (!declared(capabilities, "relationships"))
          return error(501, "relationships are not supported", "relationships");
        if (
          typeof field.relationship !== "string" ||
          !Object.hasOwn(body.collection_relationships as Json, field.relationship)
        )
          return error(400, "undefined relationship", "undefined-relationship");
        continue;
      }
      if (field.type !== "column")
        return error(400, "unknown field type", "field-type");
      // A selected column must exist on the collection's object type.
      if (collection) {
        const objectTypes = (schema.object_types as Json) ?? {};
        const objectType = objectTypes[collection.type as string];
        if (
          isObject(objectType) &&
          isObject(objectType.fields) &&
          typeof field.column === "string" &&
          !Object.hasOwn(objectType.fields, field.column)
        )
          return error(400, "unknown column", "unknown-column");
      }
    }

    const checkExpression = (expression: unknown): ReturnType<typeof error> | undefined => {
      if (!isObject(expression)) return error(400, "malformed predicate", "predicate");
      switch (expression.type) {
        case "and":
        case "or": {
          const list = expression.expressions;
          if (!Array.isArray(list))
            return error(400, "malformed predicate", "predicate");
          for (const item of list) {
            const failure = checkExpression(item);
            if (failure) return failure;
          }
          return undefined;
        }
        case "not":
          return checkExpression(expression.expression);
        case "unary_comparison_operator":
          if (expression.operator !== "is_null")
            return error(400, "unknown unary operator", "unary-operator");
          return undefined;
        case "binary_comparison_operator": {
          const target = expression.column;
          if (!isObject(target) || target.type !== "column")
            return error(400, "malformed comparison target", "comparison-target");
          const objectTypes = (schema.object_types as Json) ?? {};
          const objectType = collection
            ? objectTypes[collection.type as string]
            : undefined;
          if (
            isObject(objectType) &&
            isObject(objectType.fields) &&
            typeof target.name === "string" &&
            !Object.hasOwn(objectType.fields, target.name)
          )
            return error(400, "unknown column", "unknown-column");
          // The operator must be declared on the column's scalar type.
          const scalarTypes = (schema.scalar_types as Json) ?? {};
          const fieldInfo =
            isObject(objectType) && isObject(objectType.fields)
              ? objectType.fields[target.name as string]
              : undefined;
          const typeName = isObject(fieldInfo) && isObject(fieldInfo.type)
            ? (fieldInfo.type as Json).name
            : undefined;
          const scalar =
            typeof typeName === "string" ? scalarTypes[typeName] : undefined;
          if (
            isObject(scalar) &&
            isObject(scalar.comparison_operators) &&
            typeof expression.operator === "string" &&
            !Object.hasOwn(scalar.comparison_operators, expression.operator)
          )
            return error(501, "unsupported operator", "unsupported-operator");
          return undefined;
        }
        case "exists": {
          const inCollection = expression.in_collection;
          if (!isObject(inCollection))
            return error(400, "malformed exists", "exists");
          if (
            inCollection.type === "unrelated" &&
            !declared(capabilities, "query.exists.unrelated")
          )
            return error(501, "unrelated exists is not supported", "exists-unrelated");
          if (
            inCollection.type === "related" &&
            !declared(capabilities, "relationships")
          )
            return error(501, "relationships are not supported", "relationships");
          return undefined;
        }
        case "array_comparison":
          return undefined;
        default:
          return error(400, "unknown expression type", "expression-type");
      }
    };
    if (query.predicate !== undefined) {
      const failure = checkExpression(query.predicate);
      if (failure) return failure;
    }

    if (isObject(query.order_by)) {
      const elements = query.order_by.elements;
      if (!Array.isArray(elements))
        return error(400, "malformed order_by", "order-by");
      for (const element of elements) {
        if (!isObject(element) || !isObject(element.target))
          return error(400, "malformed order_by", "order-by");
        if (
          element.target.type === "aggregate" &&
          !declared(capabilities, "relationships.order_by_aggregate")
        )
          return error(501, "order by aggregate is not supported", "order-by-aggregate");
      }
    }

    // Declared collection arguments must all be supplied.
    const declaredArgs = collection?.arguments ?? fn?.arguments;
    if (isObject(declaredArgs))
      for (const name of Object.keys(declaredArgs))
        if (!Object.hasOwn(body.arguments as Json, name))
          return error(400, "missing argument", "missing-argument");
    for (const [name, argument] of Object.entries(body.arguments as Json)) {
      if (!isObject(argument) || (argument.type !== "literal" && argument.type !== "variable"))
        return error(400, "malformed argument", "argument");
      if (isObject(declaredArgs) && !Object.hasOwn(declaredArgs, name))
        return error(400, "undeclared argument", "undeclared-argument");
    }
    return undefined;
  };

  const validateMutation = (body: unknown) => {
    if (!isObject(body)) return error(400, "malformed request", "not-object");
    const operations = body.operations;
    if (!Array.isArray(operations) || !operations.length)
      return error(400, "operations are required", "operations");
    if (operations.length > 1 && !declared(capabilities, "mutation.transactional"))
      return error(
        400,
        "exactly one operation is required without the transactional capability",
        "multiple-operations",
      );
    const procedures = (schema.procedures as Json[]) ?? [];
    for (const operation of operations) {
      if (!isObject(operation) || operation.type !== "procedure")
        return error(400, "unknown operation type", "operation-type");
      const procedure = procedures.find((item) => item.name === operation.name);
      if (!procedure) return error(400, "unknown procedure", "unknown-procedure");
      if (!isObject(operation.arguments))
        return error(400, "arguments are required", "arguments");
      const declaredArgs = procedure.arguments;
      if (isObject(declaredArgs))
        for (const name of Object.keys(declaredArgs))
          if (!Object.hasOwn(operation.arguments, name))
            return error(400, "missing argument", "missing-argument");
    }
    return undefined;
  };

  let remainingMutationFailures = options.failMutation?.times ?? 0;

  const fixture = await startHttpFixture((request) => {
    if (
      options.serviceToken &&
      request.headers.authorization !== `Bearer ${options.serviceToken}`
    )
      return { status: 403, body: { message: "forbidden", details: {} } };

    const path = request.url.pathname;
    if (request.method === "GET" && path === "/health")
      return options.health === false
        ? { status: 503, body: { message: "unavailable", details: {} } }
        : { status: 200 };
    if (request.method === "GET" && path === "/capabilities")
      return { body: { version, capabilities } };
    if (request.method === "GET" && path === "/schema") return { body: schema };

    if (request.method === "POST" && path === "/query") {
      const body: unknown = JSON.parse(request.body.toString("utf8") || "null");
      const failure = validateQuery(body);
      if (failure) return failure;
      const collection = (body as Json).collection as string;
      const query = (body as Json).query as Json;
      const requested = isObject(query.fields) ? Object.keys(query.fields) : [];
      const source = options.rows?.[collection] ?? [];
      const limit = typeof query.limit === "number" ? query.limit : source.length;
      const rows = source.slice(0, limit).map((row) =>
        Object.fromEntries(
          requested.map((field) => [field, row[field] ?? null]),
        ),
      );
      const rowSet: Json = { rows };
      if (isObject(query.aggregates))
        rowSet.aggregates = Object.fromEntries(
          Object.keys(query.aggregates).map((name) => [name, source.length]),
        );
      return { body: [rowSet] };
    }

    if (request.method === "POST" && path === "/mutation") {
      if (remainingMutationFailures > 0) {
        remainingMutationFailures--;
        return {
          status: options.failMutation?.status ?? 503,
          body: { message: "unavailable", details: {} },
        };
      }
      const body: unknown = JSON.parse(request.body.toString("utf8") || "null");
      const failure = validateMutation(body);
      if (failure) return failure;
      const operations = (body as Json).operations as Json[];
      return {
        body: {
          operation_results: operations.map((operation) => ({
            type: "procedure",
            result:
              options.procedureResults?.[operation.name as string] ?? null,
          })),
        },
      };
    }
    return undefined;
  });

  return {
    ...fixture,
    version,
    capabilities,
    schema,
    /** Spec violations the double detected; a green policy test leaves this empty. */
    violations,
    queries() {
      return fixture
        .received("POST", "/query")
        .map((request) => JSON.parse(request.body.toString("utf8")) as Json);
    },
    mutations() {
      return fixture
        .received("POST", "/mutation")
        .map((request) => JSON.parse(request.body.toString("utf8")) as Json);
    },
  };
}
