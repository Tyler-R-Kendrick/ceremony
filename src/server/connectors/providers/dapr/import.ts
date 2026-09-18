import {
  completeDimensions,
  normalizedDefinitionSchema,
  normalizedDigestOf,
  sourceRecordSchema,
  type CompatibilityIssue,
  type ConnectorSourceIdentity,
  type EventDescriptor,
  type NativeCapability,
  type NormalizedDefinition,
  type SourceRecord,
} from "../../../../core/connectors/index.js";
import { ConnectorError } from "../../errors.js";
import { parseBoundedDocument, sha256Hex } from "../../import/parse.js";
import {
  DAPR_ADAPTER_VERSION,
  DAPR_BINDINGS_PROFILE,
  DAPR_COMPONENT_API_VERSION,
  DAPR_COMPONENT_KIND,
  DAPR_COMPONENT_PROFILE,
  DAPR_ECOSYSTEM,
  DAPR_IMPORTER_ID,
  DAPR_SOURCE,
  classifyDaprMetadata,
  daprComponentSchema,
  daprDirectionFor,
  isDaprBindingType,
  type DaprComponent,
  type DaprDirection,
} from "./schemas.js";

/*
 * Importing a Dapr component.
 *
 * A component file is configuration for a sidecar, not an API description. It
 * is read with the shared bounded parser and described: what building block it
 * belongs to, what its binding direction is according to the pinned reference,
 * which of its metadata entries are credentials, and which app ids it is
 * scoped to. Values that are credentials are never imported — only the fact
 * that the entry exists and where it is resolved from.
 */

export const DAPR_IMPORT_LIMITS = Object.freeze({
  bytes: 512 * 1024,
  maxDepth: 24,
  maxNodes: 20_000,
  maxKeysPerObject: 512,
  metadataEntries: 256,
});

export type DaprMetadataDescription = {
  name: string;
  classification: "public" | "secret";
  /** Whether the component resolves it from a Dapr secret store rather than inline. */
  fromSecretStore: boolean;
  /** Non-secret inline value, preserved for review. */
  value?: string | number | boolean;
  secretStoreRef?: { name: string; key?: string };
};

export type DaprComponentImport = {
  identity: ConnectorSourceIdentity;
  component: DaprComponent;
  componentType: string;
  buildingBlock: string;
  isBinding: boolean;
  direction: DaprDirection;
  directionVerified: boolean;
  scopes: string[];
  metadata: DaprMetadataDescription[];
  definition: NormalizedDefinition;
  issues: CompatibilityIssue[];
  executableCandidates: string[];
  byteDigest: string;
};

export type DaprImportOptions = {
  sourceRef: string;
  origin: SourceRecord["origin"];
  mediaType?: string;
  fileName?: string;
  capturedAt?: string;
};

const clip = (value: string, max: number) =>
  value.replace(/\s+/gu, " ").trim().slice(0, max);

export async function importDaprComponent(
  bytes: Uint8Array,
  options: DaprImportOptions,
): Promise<DaprComponentImport> {
  if (bytes.byteLength > DAPR_IMPORT_LIMITS.bytes)
    throw new ConnectorError("invalid-request", {
      detail: "dapr.component.oversized",
    });
  const parsed = parseBoundedDocument(bytes, {
    mediaType: options.mediaType ?? "application/yaml",
    ...(options.fileName ? { fileName: options.fileName } : {}),
    limits: {
      maxBytes: DAPR_IMPORT_LIMITS.bytes,
      maxDepth: DAPR_IMPORT_LIMITS.maxDepth,
      maxNodes: DAPR_IMPORT_LIMITS.maxNodes,
      maxKeysPerObject: DAPR_IMPORT_LIMITS.maxKeysPerObject,
    },
  });
  const document = daprComponentSchema.safeParse(parsed.value);
  if (!document.success)
    throw new ConnectorError("invalid-request", {
      detail: "dapr.component.invalid",
    });
  const component = document.data;
  if (component.kind !== DAPR_COMPONENT_KIND)
    throw new ConnectorError("invalid-request", { detail: "dapr.component.kind" });
  if (component.apiVersion !== DAPR_COMPONENT_API_VERSION)
    throw new ConnectorError("unsupported", {
      detail: "dapr.component.api-version",
    });

  const issues: CompatibilityIssue[] = [];
  const componentType = component.spec.type;
  const buildingBlock = componentType.split(".")[0]!;
  const isBinding = isDaprBindingType(componentType);
  const direction = isBinding ? daprDirectionFor(componentType) : "unknown";
  const directionVerified = isBinding && direction !== "unknown";
  if (isBinding && !directionVerified)
    issues.push({
      code: "dapr.binding.direction-unverified",
      category: "version",
      sourcePointer: "/spec/type",
      dimension: "invoke",
      disposition: "requires-configuration",
      severity: "warning",
      executionImpact: "blocks-operation",
      message: `The pinned Dapr component reference (${DAPR_SOURCE.runtimeDocsVersion}) does not state whether this binding type supports input, output or both; the direction is unverified.`,
      remediation:
        "State the approved direction in the runtime binding before any invocation is approved.",
    });
  if (!isBinding)
    issues.push({
      code: "dapr.component.not-a-binding",
      category: "structure",
      sourcePointer: "/spec/type",
      dimension: "invoke",
      disposition: "unsupported",
      severity: "warning",
      executionImpact: "blocks-definition",
      message:
        "This component belongs to a Dapr building block other than bindings; it is imported as description only and has no approved invocation profile here.",
    });

  const entries = component.spec.metadata ?? [];
  if (entries.length > DAPR_IMPORT_LIMITS.metadataEntries)
    throw new ConnectorError("invalid-request", {
      detail: "dapr.component.metadata-too-many",
    });
  const metadata: DaprMetadataDescription[] = [];
  for (const entry of entries) {
    const { classification, fromSecretStore } = classifyDaprMetadata(entry);
    if (classification === "secret" && !fromSecretStore && entry.value !== undefined)
      issues.push({
        code: "dapr.metadata.inline-credential",
        category: "security",
        sourcePointer: `/spec/metadata/${entry.name}`,
        dimension: "configure",
        disposition: "rejected",
        severity: "warning",
        executionImpact: "blocks-authorization",
        message:
          "A credential-bearing component metadata entry declared an inline value; the value is dropped rather than imported.",
        remediation:
          "Resolve the entry from a Dapr secret store with secretKeyRef, or supply it through host configuration.",
      });
    metadata.push({
      name: entry.name,
      classification,
      fromSecretStore,
      ...(classification === "public" && entry.value !== undefined
        ? { value: entry.value }
        : {}),
      ...(entry.secretKeyRef
        ? {
            secretStoreRef: {
              name: entry.secretKeyRef.name,
              ...(entry.secretKeyRef.key ? { key: entry.secretKeyRef.key } : {}),
            },
          }
        : {}),
    });
  }

  const scopes = [...(component.scopes ?? [])];
  const capabilities: NativeCapability[] = [];
  const nativeExtensions = {
    componentType,
    buildingBlock,
    ...(component.spec.version ? { version: component.spec.version } : {}),
    direction,
    directionVerified,
    scopes,
    metadata: metadata.map((entry) => ({
      name: entry.name,
      classification: entry.classification,
      fromSecretStore: entry.fromSecretStore,
    })),
  };

  const canOutput = direction === "output" || direction === "both";
  const canInput = direction === "input" || direction === "both";
  if (isBinding && canOutput)
    capabilities.push({
      kind: "action",
      nativeId: component.metadata.name,
      label: clip(`${component.metadata.name} output binding`, 200),
      summary: clip(
        `Invokes the ${componentType} output binding on an approved Dapr sidecar.`,
        500,
      ),
      /*
       * The documented verbs include create, delete and exec: an output
       * binding invocation is a write unless the binding pins a read-only verb,
       * and the binding — not this description — decides.
       */
      effect: "write",
      dataClassification: "unknown",
      cost: "unknown",
      authentication: ["dapr-api-token"],
      nativeExtensions: { ...nativeExtensions, role: "output" },
    });

  const events: EventDescriptor[] = [];
  if (isBinding && canInput) {
    events.push({
      nativeId: component.metadata.name,
      label: clip(`${component.metadata.name} input binding`, 200),
      /*
       * The sidecar delivers an input binding to the application over HTTP
       * POST, which this runtime can receive; the authenticity of that
       * delivery rests on the app API token, not on the transport.
       */
      transport: "http-webhook",
      nativeTransport: componentType,
      verification: "vendor",
      authentication: ["dapr-app-api-token"],
      nativeExtensions: { ...nativeExtensions, role: "input" },
    });
  }
  if (isBinding && !canInput && !canOutput)
    issues.push({
      code: "dapr.binding.no-approved-direction",
      category: "structure",
      sourcePointer: "/spec/type",
      dimension: "events",
      disposition: "unsupported",
      severity: "warning",
      executionImpact: "blocks-operation",
      message:
        "No direction is established for this binding, so neither an output invocation nor an input receiver is described.",
    });

  const authentication: NormalizedDefinition["authentication"] = [
    {
      id: "dapr-api-token",
      label: "Dapr sidecar API token",
      kind: "api-key",
      placement: "header",
      parameterName: "dapr-api-token",
    },
    {
      id: "dapr-app-api-token",
      label: "Dapr app API token",
      kind: "api-key",
      placement: "header",
      parameterName: "dapr-api-token",
    },
  ];

  issues.push({
    code: "dapr.sidecar.never-a-browser-proxy",
    category: "network",
    sourcePointer: "/spec",
    dimension: "invoke",
    disposition: "requires-configuration",
    severity: "warning",
    executionImpact: "blocks-operation",
    message:
      "A Dapr sidecar is reachable only through an approved destination, an approved component name and an approved operation verb; it is never exposed as a generic proxy.",
    remediation:
      "Approve the sidecar destination, the component names and the operation verbs in the runtime binding.",
  });

  const identity: ConnectorSourceIdentity = {
    ecosystem: DAPR_ECOSYSTEM,
    authorityNamespace: component.metadata.namespace ?? "",
    nativeId: component.metadata.name,
    nativeVersion: component.spec.version ?? "v1",
  };

  const shape = {
    schemaVersion: 1 as const,
    definitionRef: `definition:dapr:${component.metadata.name}:${identity.nativeVersion}`,
    identity,
    sourceRef: options.sourceRef,
    normalizedDigest: "0".repeat(64),
    importer: { id: DAPR_IMPORTER_ID, version: DAPR_ADAPTER_VERSION },
    display: {
      name: clip(component.metadata.name, 200),
      description: clip(
        `Dapr ${buildingBlock} component of type ${componentType}.`,
        500,
      ),
      ecosystem: DAPR_ECOSYSTEM,
      service: "dapr",
    },
    authentication,
    configuration: [],
    capabilities,
    events,
    declaredServers: [],
    compatibility: {
      issues,
      dimensions: completeDimensions({
        import: "exact",
        configure: "adapted",
        invoke: canOutput ? "requires-configuration" : "unsupported",
        events: canInput ? "requires-configuration" : "unsupported",
        export: "unsupported",
      }),
    },
    nativeExtensions,
  };
  const definition = normalizedDefinitionSchema.parse({
    ...shape,
    normalizedDigest: await normalizedDigestOf(shape),
  });

  return {
    identity,
    component,
    componentType,
    buildingBlock,
    isBinding,
    direction,
    directionVerified,
    scopes,
    metadata,
    definition,
    issues,
    executableCandidates: canOutput ? [component.metadata.name] : [],
    byteDigest: parsed.digest,
  };
}

export function daprSourceRecord(input: {
  sourceRef: string;
  identity: ConnectorSourceIdentity;
  origin: SourceRecord["origin"];
  bytes: Uint8Array;
  mediaType: string;
  capturedAt: string;
  isBinding: boolean;
}): SourceRecord {
  return sourceRecordSchema.parse({
    sourceRef: input.sourceRef,
    identity: input.identity,
    format: {
      name: DAPR_ECOSYSTEM,
      version: input.identity.nativeVersion,
      dialect: input.isBinding ? DAPR_BINDINGS_PROFILE : DAPR_COMPONENT_PROFILE,
    },
    origin: input.origin,
    digest: { algorithm: "sha256", value: sha256Hex(input.bytes) },
    byteLength: input.bytes.byteLength,
    mediaType: input.mediaType,
    capturedAt: input.capturedAt,
    adaptation: [],
    overlays: [],
  });
}
