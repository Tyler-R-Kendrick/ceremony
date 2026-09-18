import type {
  CompatibilityIssue,
  NativeCapability,
} from "../../../../core/connectors/contracts.js";
import type {
  GoogleConnection,
  RuntimeActionSchema,
  RuntimeEntitySchema,
} from "./schemas.js";

/*
 * What a configured connection can actually do.
 *
 * Integration Connectors do not all support the same things: "Not all
 * connectors support every operation. Some connectors may have empty
 * Operations lists entirely", and the runtime API reports entity types and
 * actions it cannot represent in `unsupportedTypeNames` and
 * `unsupportedActionNames`. Native capability availability is therefore a
 * property of the connection in front of us, never of the product, and this
 * module reports it per connection rather than assuming a uniform CRUD
 * surface.
 *
 * Sources, both retrieved 2026-09-18:
 * https://docs.cloud.google.com/integration-connectors/docs/entities-operation-action
 * and the v1/v2 discovery documents at revision 20260907.
 */

/** Operations the documentation names for an entity type. */
export const ENTITY_OPERATIONS = [
  "LIST",
  "GET",
  "CREATE",
  "UPDATE",
  "DELETE",
] as const;

const UNREPRESENTABLE_DATA_TYPES = new Set([
  "DATA_TYPE_UNSPECIFIED",
  "OTHER",
  "JAVA_OBJECT",
  "DISTINCT",
  "REF",
  "REF_CURSOR",
  "DATALINK",
  "SQLXML",
]);

function issue(
  input: Pick<
    CompatibilityIssue,
    "code" | "category" | "message" | "sourcePointer"
  > &
    Partial<CompatibilityIssue>,
): CompatibilityIssue {
  return {
    dimension: "import",
    disposition: "unsupported",
    severity: "blocking",
    executionImpact: "blocks-operation",
    ...input,
  } as CompatibilityIssue;
}

export type ConnectionCapabilityReport = {
  capabilities: NativeCapability[];
  issues: CompatibilityIssue[];
  /** Entity types with at least one usable operation, and which operations those are. */
  entityOperations: Record<string, string[]>;
  actions: string[];
  unsupportedTypeNames: string[];
  unsupportedActionNames: string[];
  /** The connection reaches its backend through a private network path. */
  privateEndpoint: boolean;
  /** A call made without a dynamic auth header would run as the connection's admin identity. */
  adminFallback: boolean;
  asyncOperations: boolean;
};

export type CapabilityInput = {
  connection: GoogleConnection;
  entityTypes?: RuntimeEntitySchema[];
  actions?: RuntimeActionSchema[];
  unsupportedTypeNames?: string[];
  unsupportedActionNames?: string[];
};

/** Reads a connection and its schema metadata into capabilities and honest limits. */
export function reportConnectionCapabilities(
  input: CapabilityInput,
): ConnectionCapabilityReport {
  const issues: CompatibilityIssue[] = [];
  const capabilities: NativeCapability[] = [];
  const entityOperations: Record<string, string[]> = {};
  const connection = input.connection;
  const state = connection.status?.state;

  if (connection.suspended)
    issues.push(
      issue({
        code: "google-connectors.connection.suspended",
        category: "policy",
        sourcePointer: "/suspended",
        dimension: "invoke",
        disposition: "requires-configuration",
        executionImpact: "blocks-definition",
        message: "The connection is suspended; no runtime call will succeed.",
      }),
    );
  if (state === "AUTHORIZATION_REQUIRED")
    issues.push(
      issue({
        code: "google-connectors.connection.authorization-required",
        category: "security",
        sourcePointer: "/status/state",
        dimension: "authorize",
        disposition: "requires-configuration",
        severity: "warning",
        executionImpact: "blocks-authorization",
        message:
          "The connection reports AUTHORIZATION_REQUIRED; a person must complete the connector's own authorization.",
      }),
    );
  else if (state && state !== "ACTIVE")
    issues.push(
      issue({
        code: "google-connectors.connection.not-active",
        category: "policy",
        sourcePointer: "/status/state",
        dimension: "invoke",
        disposition: "requires-configuration",
        severity: "warning",
        executionImpact: "blocks-operation",
        message: `The connection state is ${state}; runtime calls may fail.`,
      }),
    );

  const adminFallback = Boolean(
    connection.authOverrideEnabled && connection.fallbackOnAdminCredentials,
  );
  if (connection.authOverrideEnabled)
    issues.push(
      issue({
        code: "google-connectors.connection.auth-override",
        category: "security",
        sourcePointer: "/authOverrideEnabled",
        dimension: "invoke",
        disposition: "native-extension",
        severity: "warning",
        executionImpact: "none",
        message:
          "This connection allows the backend auth to be overridden per call; Ceremony never sends an override header.",
      }),
    );
  if (adminFallback)
    issues.push(
      issue({
        code: "google-connectors.connection.admin-fallback",
        category: "identity",
        sourcePointer: "/fallbackOnAdminCredentials",
        dimension: "invoke",
        disposition: "rejected",
        severity: "warning",
        executionImpact: "blocks-operation",
        message:
          "Without a dynamic auth header this connection falls back to admin credentials, so an end-user identity cannot be guaranteed.",
        remediation:
          "Bind this connection with the service identity, or disable the admin-credential fallback.",
      }),
    );
  const privateEndpoint = Boolean(
    connection.serviceDirectory ?? connection.tlsServiceDirectory,
  );
  if (privateEndpoint)
    issues.push(
      issue({
        code: "google-connectors.connection.private-endpoint",
        category: "network",
        sourcePointer: "/serviceDirectory",
        dimension: "invoke",
        disposition: "requires-configuration",
        severity: "warning",
        executionImpact: "blocks-operation",
        message:
          "The connection reaches its backend privately through Service Directory; only an administrator-approved private policy may bind it.",
      }),
    );
  if (connection.asyncOperationsEnabled)
    issues.push(
      issue({
        code: "google-connectors.connection.async-operations",
        category: "structure",
        sourcePointer: "/asyncOperationsEnabled",
        dimension: "invoke",
        disposition: "native-extension",
        severity: "warning",
        executionImpact: "none",
        message:
          "Async long-running operations are enabled for this connection; an action result may describe work still in progress.",
        remediation:
          "Treat an action result as the connector's own payload and reconcile completion with the connector's documented mechanism.",
      }),
    );
  if (connection.eventingEnablementType)
    issues.push(
      issue({
        code: "google-connectors.connection.eventing",
        category: "structure",
        sourcePointer: "/eventingEnablementType",
        dimension: "events",
        disposition: "unsupported",
        severity: "warning",
        executionImpact: "blocks-operation",
        message:
          "Eventing is enabled on this connection; this adapter binds entities and actions only.",
      }),
    );

  for (const name of input.unsupportedTypeNames ?? [])
    issues.push(
      issue({
        code: "google-connectors.entity-type.unsupported-datatype",
        category: "schema",
        sourcePointer: `/entityTypes/${name}`,
        message:
          "The connector reports this entity type as containing unsupported data types.",
      }),
    );
  for (const name of input.unsupportedActionNames ?? [])
    issues.push(
      issue({
        code: "google-connectors.action.unsupported-datatype",
        category: "schema",
        sourcePointer: `/actions/${name}`,
        message:
          "The connector reports this action as containing unsupported data types.",
      }),
    );

  const unsupportedTypes = new Set(input.unsupportedTypeNames ?? []);
  for (const entity of input.entityTypes ?? []) {
    if (unsupportedTypes.has(entity.entity)) continue;
    const operations = (entity.operations ?? []).filter((operation) =>
      (ENTITY_OPERATIONS as readonly string[]).includes(operation.toUpperCase()),
    );
    if (operations.length === 0) {
      issues.push(
        issue({
          code: "google-connectors.entity-type.no-operations",
          category: "structure",
          sourcePointer: `/entityTypes/${entity.entity}`,
          disposition: "requires-configuration",
          severity: "warning",
          message:
            "The connector exposes no entity operations for this entity type.",
        }),
      );
      continue;
    }
    for (const field of entity.fields)
      if (
        field.dataType &&
        UNREPRESENTABLE_DATA_TYPES.has(field.dataType.toUpperCase())
      )
        issues.push(
          issue({
            code: "google-connectors.field.opaque-datatype",
            category: "schema",
            sourcePointer: `/entityTypes/${entity.entity}/fields/${field.name}`,
            disposition: "native-extension",
            severity: "warning",
            executionImpact: "none",
            message: `Field ${field.name} has the connector-specific data type ${field.dataType}; its value is preserved without interpretation.`,
          }),
        );
    entityOperations[entity.entity] = operations.map((operation) =>
      operation.toUpperCase(),
    );
    capabilities.push({
      kind: "entity",
      nativeId: entity.entity,
      label: entity.entity.slice(0, 200),
      summary: `Entity operations: ${operations.join(", ")}`,
      effect: operations.some((operation) =>
        ["CREATE", "UPDATE", "DELETE"].includes(operation.toUpperCase()),
      )
        ? "unknown"
        : "read",
      dataClassification: "unknown",
      cost: "unknown",
    });
  }

  const unsupportedActions = new Set(input.unsupportedActionNames ?? []);
  const actions: string[] = [];
  for (const action of input.actions ?? []) {
    if (unsupportedActions.has(action.action)) continue;
    actions.push(action.action);
    capabilities.push({
      kind: "action",
      nativeId: action.action,
      label: (action.displayName ?? action.action).slice(0, 200),
      ...(action.description ? { summary: action.description.slice(0, 500) } : {}),
      /*
       * An action is "a first class function ... [that] enables changes to
       * entities". Which of them write is connector-specific and is not
       * reported anywhere, so the declared effect stays unknown and the host's
       * bound operation decides.
       */
      effect: "unknown",
      dataClassification: "unknown",
      cost: "unknown",
    });
  }

  return {
    capabilities,
    issues,
    entityOperations,
    actions,
    unsupportedTypeNames: input.unsupportedTypeNames ?? [],
    unsupportedActionNames: input.unsupportedActionNames ?? [],
    privateEndpoint,
    adminFallback,
    asyncOperations: Boolean(connection.asyncOperationsEnabled),
  };
}
