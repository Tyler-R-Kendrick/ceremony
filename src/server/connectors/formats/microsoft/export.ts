import { z } from "zod";
import type {
  CompatibilityIssue,
  NormalizedDefinition,
} from "../../../../core/connectors/index.js";
import type { RuntimeBinding } from "../../binding.js";
import { IssueList, safeText, token } from "./issues.js";
import type { DynamicFieldContract } from "./dynamic.js";

/*
 * Export of the supported profile back to `apiDefinition.swagger.json`.
 *
 * Two rules decide everything here. Nothing is invented: an extension is
 * re-emitted only at the node it was read from, a security definition only
 * when the source declared one, and a host only when the source or the
 * approved binding names it. And nothing is quietly lost: request and
 * response schemas, policy instances, custom code and companion files that
 * this description does not carry are reported as losses, so a consumer of
 * the export knows the difference between what was preserved and what the
 * original connector did.
 */

export const EXPORT_FORMAT = "microsoft-custom-connector-swagger-2.0";

const extensionEntrySchema = z.object({
  pointer: z.string(),
  name: z.string(),
  value: z.unknown(),
});
const parameterEntrySchema = extensionEntrySchema.extend({
  parameter: z.string(),
  pathString: z.string().default(""),
});
const responseEntrySchema = extensionEntrySchema.extend({
  status: z.string(),
  pathString: z.string().default(""),
});

const operationRecordSchema = z.object({
  method: z.enum(["GET", "PUT", "POST", "DELETE", "OPTIONS", "HEAD", "PATCH"]),
  path: z.string(),
  deprecated: z.boolean().default(false),
  visibility: z.string().optional(),
  trigger: z.string().optional(),
  notificationUrlField: z.string().optional(),
  parameters: z
    .array(
      z.object({
        name: z.string(),
        in: z.enum(["path", "query", "header", "formData", "body"]),
        required: z.boolean().default(false),
        type: z.string().optional(),
        format: z.string().optional(),
        visibility: z.string().optional(),
        hasDefault: z.boolean().optional(),
        notificationUrl: z.boolean().optional(),
        summary: z.string().optional(),
      }),
    )
    .default([]),
  responses: z
    .array(
      z.object({
        status: z.string(),
        description: z.string().optional(),
        headers: z.array(z.string()).default([]),
      }),
    )
    .default([]),
  security: z
    .object({
      source: z.enum(["operation", "document", "none"]),
      alternatives: z
        .array(z.array(z.object({ scheme: z.string(), scopes: z.array(z.string()) })))
        .default([]),
    })
    .optional(),
  consumes: z.array(z.string()).optional(),
  produces: z.array(z.string()).optional(),
});

const connectorRecordSchema = z.object({
  connectorId: z.string().optional(),
  securityDefinitions: z
    .array(
      z.object({
        name: z.string(),
        type: z.string(),
        in: z.string().optional(),
        parameterName: z.string().optional(),
        flow: z.string().optional(),
        authorizationUrl: z.string().optional(),
        tokenUrl: z.string().optional(),
        scopes: z.record(z.string(), z.string()).default({}),
        description: z.string().optional(),
      }),
    )
    .default([]),
  security: z
    .array(z.array(z.object({ scheme: z.string(), scopes: z.array(z.string()) })))
    .optional(),
  document: z
    .object({
      host: z.string().optional(),
      basePath: z.string().optional(),
      schemes: z.array(z.string()).default([]),
      consumes: z.array(z.string()).optional(),
      produces: z.array(z.string()).optional(),
    })
    .default({ schemes: [] }),
  policyTemplateInstances: z
    .array(z.object({ templateId: z.string() }))
    .default([]),
  script: z
    .object({ present: z.boolean().default(false) })
    .default({ present: false }),
  gateway: z.object({ required: z.boolean().default(false) }).default({
    required: false,
  }),
});

export interface CustomConnectorExportResult {
  mediaType: "application/json";
  bytes: Uint8Array;
  /** The reconstructed Swagger 2.0 document. */
  document: Record<string, unknown>;
  losses: CompatibilityIssue[];
}

type JsonObject = Record<string, unknown>;
const isObject = (value: unknown): value is JsonObject =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const escapePointerSegment = (segment: string) =>
  segment.replaceAll("~", "~0").replaceAll("/", "~1");

function placeExtensions(
  target: JsonObject,
  entries: readonly { name: string; value: unknown }[],
): void {
  for (const entry of entries) {
    if (!entry.name.startsWith("x-")) continue;
    if (isObject(entry.value) && Object.hasOwn(entry.value, "$omitted")) continue;
    target[entry.name] = entry.value;
  }
}

/**
 * Rebuilds `apiDefinition.swagger.json` from the description and, when one is
 * given, the approved binding. With a binding the export is bounded to what
 * the host approved: operations it does not list are reported, not emitted.
 */
export function exportCustomConnector(
  definition: NormalizedDefinition,
  binding?: RuntimeBinding,
): CustomConnectorExportResult {
  const losses = new IssueList();
  const connector = connectorRecordSchema.safeParse(
    definition.nativeExtensions["microsoft-custom-connector"],
  );
  if (!connector.success)
    losses.push({
      code: "structure.connector-metadata-missing",
      category: "structure",
      pointer: "#/nativeExtensions",
      dimension: "export",
      severity: "warning",
      disposition: "adapted",
      message:
        "This description carries no Microsoft connector metadata, so security definitions and host details cannot be reproduced.",
    });
  const record = connector.success
    ? connector.data
    : connectorRecordSchema.parse({});

  const boundNativeIds = binding
    ? new Set(binding.operations.map((operation) => operation.nativeId))
    : undefined;
  const destination = binding?.destinations[0];

  const document: JsonObject = {
    swagger: "2.0",
    info: {
      title: definition.display.name,
      version: definition.identity.nativeVersion,
      ...(definition.display.description
        ? { description: definition.display.description }
        : {}),
    },
  };

  if (destination) {
    const origin = new URL(destination.origin);
    document.host = origin.host;
    document.schemes = [origin.protocol.replace(":", "")];
    if (destination.pathPrefix) document.basePath = destination.pathPrefix;
    else if (record.document.basePath) document.basePath = record.document.basePath;
    if (record.document.host && record.document.host !== origin.host)
      losses.push({
        code: "network.host-rebound",
        category: "network",
        pointer: "#/host",
        dimension: "export",
        severity: "warning",
        disposition: "adapted",
        message:
          "The exported host is the binding's approved destination, which is not the host the source declared; a reviewer must confirm the exported document names the intended service.",
      });
  } else {
    if (record.document.host) document.host = record.document.host;
    if (record.document.basePath) document.basePath = record.document.basePath;
    if (record.document.schemes.length) document.schemes = record.document.schemes;
  }
  if (record.document.consumes?.length) document.consumes = record.document.consumes;
  if (record.document.produces?.length) document.produces = record.document.produces;

  if (record.securityDefinitions.length) {
    const definitions: JsonObject = {};
    for (const scheme of record.securityDefinitions) {
      const emitted: JsonObject = { type: scheme.type };
      if (scheme.description) emitted.description = scheme.description;
      if (scheme.type === "apiKey") {
        if (scheme.in) emitted.in = scheme.in;
        if (scheme.parameterName) emitted.name = scheme.parameterName;
      } else if (scheme.type === "oauth2") {
        if (scheme.flow) emitted.flow = scheme.flow;
        if (scheme.authorizationUrl)
          emitted.authorizationUrl = scheme.authorizationUrl;
        if (scheme.tokenUrl) emitted.tokenUrl = scheme.tokenUrl;
        emitted.scopes = scheme.scopes;
      }
      definitions[scheme.name] = emitted;
    }
    document.securityDefinitions = definitions;
  }
  if (record.security)
    document.security = record.security.map((alternative) =>
      Object.fromEntries(
        alternative.map((entry) => [entry.scheme, entry.scopes]),
      ),
    );

  // Document-level extensions, including x-ms-capabilities.testConnection,
  // are re-emitted only from what the source actually carried.
  const documentEntries = z
    .array(extensionEntrySchema)
    .safeParse(definition.nativeExtensions["x-ms-extensions"]);
  if (documentEntries.success)
    placeExtensions(
      document,
      documentEntries.data.filter((entry) => entry.pointer === "#"),
    );

  const paths: JsonObject = {};
  for (const capability of definition.capabilities) {
    const extensions = capability.nativeExtensions ?? {};
    const parsed = operationRecordSchema.safeParse(
      extensions["microsoft-operation"],
    );
    if (!parsed.success) {
      losses.push({
        code: "structure.operation-not-exportable",
        category: "structure",
        pointer: `#/capabilities/${escapePointerSegment(capability.nativeId)}`,
        dimension: "export",
        severity: "warning",
        disposition: "unsupported",
        message: `Capability ${token(capability.nativeId)} has no preserved HTTP shape and cannot be written back to a Swagger operation.`,
      });
      continue;
    }
    const operation = parsed.data;
    if (boundNativeIds && !boundNativeIds.has(capability.nativeId)) {
      losses.push({
        code: "policy.operation-not-bound",
        category: "policy",
        pointer: `#/capabilities/${escapePointerSegment(capability.nativeId)}`,
        dimension: "export",
        severity: "info",
        disposition: "requires-configuration",
        message: `Operation ${token(capability.nativeId)} is described but not approved by this binding, so the bounded export omits it.`,
      });
      continue;
    }

    const parameterEntries = z
      .array(parameterEntrySchema)
      .safeParse(extensions["x-ms-parameter-extensions"]);
    const parameters = operation.parameters.map((parameter) => {
      const emitted: JsonObject = {
        name: parameter.name,
        in: parameter.in,
        required: parameter.required,
      };
      if (parameter.type) emitted.type = parameter.type;
      if (parameter.format) emitted.format = parameter.format;
      if (parameterEntries.success)
        placeExtensions(
          emitted,
          parameterEntries.data.filter(
            (entry) => entry.parameter === parameter.name && entry.pathString === "",
          ),
        );
      if (parameter.in === "body") {
        // The description keeps a pointer to the body schema, not the schema.
        losses.push({
          code: "schema.body-not-preserved",
          category: "schema",
          pointer: `#/capabilities/${escapePointerSegment(capability.nativeId)}`,
          dimension: "export",
          severity: "warning",
          disposition: "unsupported",
          message: `Operation ${token(capability.nativeId)} has a request body whose schema this description does not carry; the exported parameter has no schema and the document is not a working connector definition until one is supplied.`,
          remediation:
            "Export from the protected source artifact when a byte-faithful definition is required.",
        });
        const nested = parameterEntries.success
          ? parameterEntries.data.filter(
              (entry) => entry.parameter === parameter.name && entry.pathString !== "",
            )
          : [];
        if (nested.length)
          losses.push({
            code: "schema.body-extensions-unplaced",
            category: "schema",
            pointer: `#/capabilities/${escapePointerSegment(capability.nativeId)}`,
            dimension: "export",
            severity: "warning",
            disposition: "unsupported",
            message: `${nested.length} extension(s) inside the body schema of ${token(capability.nativeId)} — including any dynamic-field extensions — have no schema to attach to in the export.`,
          });
      }
      return emitted;
    });

    const responses: JsonObject = {};
    for (const response of operation.responses) {
      const emitted: JsonObject = {
        description: response.description ?? response.status,
      };
      if (response.headers.length)
        emitted.headers = Object.fromEntries(
          response.headers.map((header) => [header, { type: "string" }]),
        );
      responses[response.status] = emitted;
    }
    if (
      operation.responses.some(
        (response) => /^2/.test(response.status) && capability.outputSchemaRef,
      )
    )
      losses.push({
        code: "schema.response-not-preserved",
        category: "schema",
        pointer: `#/capabilities/${escapePointerSegment(capability.nativeId)}`,
        dimension: "export",
        severity: "warning",
        disposition: "unsupported",
        message: `The success response schema of ${token(capability.nativeId)} is referenced by pointer in the description and is not reproduced in the export.`,
      });

    const emittedOperation: JsonObject = {
      operationId: capability.nativeId,
      ...(capability.label ? { summary: capability.label } : {}),
      ...(capability.summary ? { description: capability.summary } : {}),
      ...(operation.deprecated ? { deprecated: true } : {}),
      parameters,
      responses,
    };
    if (operation.consumes?.length) emittedOperation.consumes = operation.consumes;
    if (operation.produces?.length) emittedOperation.produces = operation.produces;
    if (operation.security?.source === "operation")
      emittedOperation.security = operation.security.alternatives.map((alternative) =>
        Object.fromEntries(alternative.map((entry) => [entry.scheme, entry.scopes])),
      );
    const operationEntries = z
      .array(extensionEntrySchema)
      .safeParse(extensions["x-ms-operation-extensions"]);
    if (operationEntries.success)
      placeExtensions(emittedOperation, operationEntries.data);

    const item = isObject(paths[operation.path])
      ? (paths[operation.path] as JsonObject)
      : {};
    const pathEntries = z
      .array(extensionEntrySchema)
      .safeParse(extensions["x-ms-path-extensions"]);
    if (pathEntries.success) placeExtensions(item, pathEntries.data);
    item[operation.method.toLowerCase()] = emittedOperation;
    paths[operation.path] = item;

    const responseEntries = z
      .array(responseEntrySchema)
      .safeParse(extensions["x-ms-response-extensions"]);
    if (responseEntries.success && responseEntries.data.length)
      losses.push({
        code: "schema.response-extensions-unplaced",
        category: "schema",
        pointer: `#/capabilities/${escapePointerSegment(capability.nativeId)}`,
        dimension: "export",
        severity: "warning",
        disposition: "unsupported",
        message: `${responseEntries.data.length} extension(s) on the responses of ${token(capability.nativeId)} have no reproduced response schema to attach to.`,
      });
  }
  document.paths = paths;

  // Companion artefacts are not part of the swagger file and are not invented.
  if (record.policyTemplateInstances.length)
    losses.push({
      code: "policy.templates-not-exported",
      category: "policy",
      pointer: "#/nativeExtensions",
      dimension: "export",
      severity: "warning",
      disposition: "unsupported",
      message: `${record.policyTemplateInstances.length} policy template instance(s) live in apiProperties.json and change how the original connector behaves; they are not part of this export and the exported document therefore does not behave identically.`,
    });
  if (record.script.present)
    losses.push({
      code: "executable-code.script-not-exported",
      category: "executable-code",
      pointer: "#/nativeExtensions",
      dimension: "export",
      severity: "warning",
      disposition: "unsupported",
      message:
        "The original connector runs custom C# code in place of its codeless definition; that code is not carried, executed or exported here, so the exported document describes different behaviour.",
    });
  if (record.gateway.required)
    losses.push({
      code: "network.gateway-not-exported",
      category: "network",
      pointer: "#/nativeExtensions",
      dimension: "export",
      severity: "warning",
      disposition: "unsupported",
      message:
        "The original connector reaches its service through an on-premises data gateway; the export describes the HTTP surface only.",
    });
  if (definition.configuration.length)
    losses.push({
      code: "structure.api-properties-not-exported",
      category: "structure",
      pointer: "#/configuration",
      dimension: "export",
      severity: "info",
      disposition: "requires-configuration",
      message:
        "Connection parameters and authentication metadata belong to apiProperties.json, which this export does not produce; no credential, client secret or connection value ever leaves in an export.",
    });

  const text = JSON.stringify(document);
  return {
    mediaType: "application/json",
    bytes: new TextEncoder().encode(text),
    document,
    losses: losses.toArray(),
  };
}

/** The shape a UI needs to render one dynamic field; no pointers, no source prose. */
export interface DynamicFieldUiContract {
  id: string;
  kind: DynamicFieldContract["kind"];
  /** The field the person is filling in. */
  field: { location: string; name: string; pathString: string };
  /** Presentation hint only; a hidden field is still classified by policy, not by this. */
  visibility?: "important" | "advanced" | "internal";
  /** The bound operation the host calls to fill the field; absent when unresolved. */
  operationRef?: string;
  operationId: string;
  /** Names of the fields on this form whose values this field depends on. */
  dependsOn: string[];
  /** Static inputs the lookup always sends. */
  constants: Array<{ target: string; value: string | number | boolean | null }>;
  selection: DynamicFieldContract["selection"];
  executable: boolean;
  blockedBy: string[];
}

/**
 * A compact, renderable contract per dynamic field. Only the preferred form is
 * emitted when a field declares both the older and the newer extension, so a
 * UI never shows one field twice.
 */
export function dynamicFieldUiContracts(
  contracts: readonly DynamicFieldContract[],
): DynamicFieldUiContract[] {
  return contracts
    .filter((contract) => contract.preferred)
    .map((contract) => ({
      id: contract.id,
      kind: contract.kind,
      field: {
        location: contract.field.location,
        name: contract.field.name,
        pathString: contract.field.pathString,
      },
      ...(contract.visibility ? { visibility: contract.visibility } : {}),
      ...(contract.operation
        ? { operationRef: contract.operation.operationRef }
        : {}),
      operationId: contract.operationId,
      dependsOn: [
        ...new Set(
          contract.parameters
            .filter((parameter) => parameter.source === "parameter")
            .map((parameter) =>
              parameter.source === "parameter" ? parameter.reference : "",
            )
            .filter((reference) => reference.length),
        ),
      ],
      constants: contract.parameters.flatMap((parameter) =>
        parameter.source === "static"
          ? [{ target: parameter.target, value: parameter.value }]
          : [],
      ),
      selection: { ...contract.selection },
      executable: contract.executable,
      blockedBy: [...contract.blockedBy],
    }));
}

/** Display label for a dynamic field, safe to render. */
export const dynamicFieldLabel = (contract: DynamicFieldContract): string =>
  safeText(
    contract.field.pathString
      ? `${contract.field.name}/${contract.field.pathString}`
      : contract.field.name,
    120,
  );
