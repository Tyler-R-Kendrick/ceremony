import {
  normalizedDigestOf,
  type CompatibilityIssue,
  type ConnectorSourceIdentity,
  type EventDescriptor,
  type NativeCapability,
  type NormalizedDefinition,
  type SourceRecord,
  completeDimensions,
  normalizedDefinitionSchema,
  sourceRecordSchema,
} from "../../../../core/connectors/index.js";
import { parseBoundedDocument, sha256Hex } from "../../import/parse.js";
import { ConnectorError } from "../../errors.js";
import {
  KAMELET_ADAPTER_VERSION,
  KAMELET_ANNOTATIONS,
  KAMELET_API_VERSION,
  KAMELET_CATALOG_VERSION,
  KAMELET_ECOSYSTEM,
  KAMELET_IMPORTER_ID,
  KAMELET_KIND,
  KAMELET_PROFILE,
  KAMELET_VERIFIED_LABEL,
  classifyKameletProperty,
  kameletDocumentSchema,
  kameletTypeOf,
  templateScheme,
  type KameletDocument,
  type KameletProperty,
  type KameletType,
} from "./schemas.js";

/*
 * Importing a Kamelet.
 *
 * The document is read with the shared bounded parser (duplicate keys, custom
 * tags, merge keys, alias amplification, depth and byte ceilings all refused
 * before anything is materialized), then described. Three facts survive that
 * matter to a host: what the Kamelet is (source, sink or action), what it needs
 * to be configured with and which of those parameters are credentials, and
 * where it came from. Nothing about the route template is executed, resolved or
 * turned into a destination.
 */

/** Ceilings for one Kamelet document; a catalog file is a few kilobytes. */
export const KAMELET_IMPORT_LIMITS = Object.freeze({
  bytes: 1024 * 1024,
  maxDepth: 32,
  maxNodes: 50_000,
  maxKeysPerObject: 1024,
  properties: 256,
});

export type KameletImport = {
  identity: ConnectorSourceIdentity;
  document: KameletDocument;
  kameletType: KameletType;
  properties: KameletProperty[];
  definition: NormalizedDefinition;
  issues: CompatibilityIssue[];
  executableCandidates: string[];
  /** Digest of the exact bytes that were read. */
  byteDigest: string;
  provenance: {
    catalogVersion: string;
    catalogVersionDeclared: boolean;
    provider?: string;
    group?: string;
    namespace?: string;
    supportLevel?: string;
    verified: boolean;
    scheme?: string;
    dependencies: string[];
  };
};

const issue = (
  input: Omit<CompatibilityIssue, "message"> & { message: string },
): CompatibilityIssue => input;

const clip = (value: string | undefined, max: number): string =>
  (value ?? "").replace(/\s+/gu, " ").trim().slice(0, max);

/**
 * `source`, `sink` and `action` are three different things and stay three
 * different things: a source produces into a route, a sink consumes from one,
 * and an action transforms in the middle. Collapsing them would make a
 * descriptor ambiguous for any runner.
 */
const effectForType: Record<KameletType, NativeCapability["effect"]> = {
  source: "read",
  sink: "write",
  action: "unknown",
};

export type KameletImportOptions = {
  sourceRef: string;
  origin: SourceRecord["origin"];
  mediaType?: string;
  fileName?: string;
  capturedAt?: string;
  /** Catalog release the bytes were taken from, when the caller knows it. */
  catalogVersion?: string;
};

/** Reads and describes one Kamelet document. */
export async function importKamelet(
  bytes: Uint8Array,
  options: KameletImportOptions,
): Promise<KameletImport> {
  if (bytes.byteLength > KAMELET_IMPORT_LIMITS.bytes)
    throw new ConnectorError("invalid-request", {
      detail: "kamelet.document.oversized",
    });
  const parsed = parseBoundedDocument(bytes, {
    mediaType: options.mediaType ?? "application/yaml",
    ...(options.fileName ? { fileName: options.fileName } : {}),
    limits: {
      maxBytes: KAMELET_IMPORT_LIMITS.bytes,
      maxDepth: KAMELET_IMPORT_LIMITS.maxDepth,
      maxNodes: KAMELET_IMPORT_LIMITS.maxNodes,
      maxKeysPerObject: KAMELET_IMPORT_LIMITS.maxKeysPerObject,
    },
  });
  const document = kameletDocumentSchema.safeParse(parsed.value);
  if (!document.success)
    throw new ConnectorError("invalid-request", {
      detail: "kamelet.document.invalid",
    });
  const kamelet = document.data;
  if (kamelet.kind !== KAMELET_KIND)
    throw new ConnectorError("invalid-request", {
      detail: "kamelet.document.kind",
    });
  if (kamelet.apiVersion !== KAMELET_API_VERSION)
    throw new ConnectorError("unsupported", {
      detail: "kamelet.document.api-version",
    });

  const issues: CompatibilityIssue[] = [];
  const annotations = kamelet.metadata.annotations ?? {};
  const declaredCatalog = annotations[KAMELET_ANNOTATIONS.catalogVersion];
  const catalogVersion =
    declaredCatalog ?? options.catalogVersion ?? KAMELET_CATALOG_VERSION;
  if (!declaredCatalog)
    issues.push(
      issue({
        code: "kamelet.catalog.version-undeclared",
        category: "version",
        sourcePointer: "/metadata/annotations",
        dimension: "import",
        disposition: "adapted",
        severity: "warning",
        executionImpact: "none",
        message:
          "The document declares no catalog version; the release this import was pinned to is recorded instead.",
        remediation:
          "Import the Kamelet from a released catalog tag so its version is part of the document.",
      }),
    );

  const kameletType = kameletTypeOf(kamelet);
  if (!kameletType)
    throw new ConnectorError("invalid-request", {
      detail: "kamelet.type.missing",
    });

  const definitionBlock = kamelet.spec.definition ?? {};
  const required = new Set(definitionBlock.required ?? []);
  const rawProperties = definitionBlock.properties ?? {};
  const names = Object.keys(rawProperties);
  if (names.length > KAMELET_IMPORT_LIMITS.properties)
    throw new ConnectorError("invalid-request", {
      detail: "kamelet.properties.too-many",
    });
  const properties: KameletProperty[] = [];
  for (const name of names) {
    const property = rawProperties[name]!;
    const { classification, source } = classifyKameletProperty(name, property);
    const secret = classification === "secret";
    if (source === "name-heuristic")
      issues.push(
        issue({
          code: "kamelet.property.credential-unmarked",
          category: "security",
          sourcePointer: `/spec/definition/properties/${name}`,
          dimension: "configure",
          disposition: "adapted",
          severity: "warning",
          executionImpact: "none",
          message:
            "A parameter was classified secret from its name because the catalog document did not mark it as a credential.",
          remediation:
            "Declare the parameter with format password and the credentials descriptor in the catalog.",
        }),
      );
    if (secret && property.default !== undefined)
      issues.push(
        issue({
          code: "kamelet.property.secret-default",
          category: "security",
          sourcePointer: `/spec/definition/properties/${name}/default`,
          dimension: "configure",
          disposition: "rejected",
          severity: "blocking",
          executionImpact: "blocks-authorization",
          message:
            "A credential parameter declared a default value; the default is dropped rather than imported, so the parameter has no value until one is configured.",
          remediation:
            "Supply the credential through host configuration for the configured runner.",
        }),
      );
    properties.push({
      name,
      ...(property.title ? { title: clip(property.title, 200) } : {}),
      ...(property.description
        ? { description: clip(property.description, 500) }
        : {}),
      ...(property.type ? { type: property.type } : {}),
      required: required.has(name),
      classification,
      secrecySource: source,
      hasDefault: property.default !== undefined,
      ...(secret || property.default === undefined
        ? {}
        : { default: property.default }),
      ...(property.enum ? { enumValues: property.enum } : {}),
    });
  }
  for (const name of required)
    if (!Object.hasOwn(rawProperties, name))
      issues.push(
        issue({
          code: "kamelet.definition.required-unknown",
          category: "schema",
          sourcePointer: "/spec/definition/required",
          dimension: "configure",
          disposition: "rejected",
          severity: "warning",
          executionImpact: "blocks-operation",
          message:
            "A required parameter name has no property declaration in the Kamelet definition.",
        }),
      );

  const scheme = templateScheme(kamelet.spec.template?.from?.uri);
  const dependencies = [...(kamelet.spec.dependencies ?? [])];
  const secretNames = properties
    .filter((property) => property.classification === "secret")
    .map((property) => property.name);

  /*
   * A Kamelet's credentials are supplied to, held by and used by a Camel
   * runner. Ceremony never takes custody of them, so the profile says exactly
   * that instead of inventing an API-key or OAuth method for a template.
   */
  const authentication: NormalizedDefinition["authentication"] =
    secretNames.length > 0
      ? [
          {
            id: "kamelet-credentials",
            label: "Camel runner credentials",
            kind: "external-broker",
            broker: KAMELET_ECOSYSTEM,
            custody: "external-execution-broker",
          },
        ]
      : [
          {
            id: "kamelet-no-credential",
            label: "No credential",
            kind: "none",
            reason: "public",
          },
        ];
  if (secretNames.length > 0)
    issues.push(
      issue({
        code: "kamelet.credentials.runner-held",
        category: "security",
        sourcePointer: "/spec/definition/properties",
        dimension: "authorize",
        disposition: "requires-configuration",
        severity: "warning",
        executionImpact: "blocks-authorization",
        message:
          "Credential parameters are resolved by the configured Camel runner from host configuration; Ceremony holds no credential for this Kamelet.",
        remediation:
          "Configure a Camel runner and the host configuration names that hold these credentials.",
      }),
    );

  issues.push(
    issue({
      code: "kamelet.template.not-executed",
      category: "executable-code",
      sourcePointer: "/spec/template",
      dimension: "invoke",
      disposition: "unsupported",
      severity: "warning",
      executionImpact: "blocks-operation",
      message:
        "The Camel route template is preserved as inert data; Ceremony neither evaluates it nor deploys an integration.",
      remediation:
        "Delegate execution to an explicitly configured Camel runner.",
    }),
  );

  const capability: NativeCapability = {
    kind: "custom",
    nativeId: kamelet.metadata.name,
    label: clip(definitionBlock.title ?? kamelet.metadata.name, 200),
    ...(definitionBlock.description
      ? { summary: clip(definitionBlock.description, 500) }
      : {}),
    effect: effectForType[kameletType],
    dataClassification: "unknown",
    cost: "unknown",
    authentication: [authentication[0]!.id],
    nativeExtensions: {
      kameletType,
      ...(scheme ? { scheme } : {}),
      dependencies,
      properties: properties.map((property) => ({
        name: property.name,
        required: property.required,
        classification: property.classification,
        secrecySource: property.secrecySource,
        ...(property.type ? { type: property.type } : {}),
      })),
    },
  };

  /*
   * A source Kamelet does emit events, but through a Camel component, not an
   * HTTP webhook. The transport is reported unsupported with its native name
   * preserved, which is the honest description: this runtime delivers nothing
   * for it.
   */
  const events: EventDescriptor[] =
    kameletType === "source"
      ? [
          {
            nativeId: kamelet.metadata.name,
            label: clip(definitionBlock.title ?? kamelet.metadata.name, 200),
            transport: "unsupported",
            ...(scheme ? { nativeTransport: scheme } : {}),
            verification: "none",
            authentication: [],
            nativeExtensions: { kameletType, ...(scheme ? { scheme } : {}) },
          },
        ]
      : [];
  if (events.length)
    issues.push(
      issue({
        code: "kamelet.events.camel-transport",
        category: "structure",
        sourcePointer: "/spec/template/from",
        dimension: "events",
        disposition: "unsupported",
        severity: "warning",
        executionImpact: "blocks-operation",
        message:
          "A source Kamelet delivers through a Camel component, not an HTTP webhook; this runtime receives nothing for it directly.",
        remediation:
          "Have the configured Camel runner forward to an approved HTTP event destination.",
      }),
    );

  const identity: ConnectorSourceIdentity = {
    ecosystem: KAMELET_ECOSYSTEM,
    authorityNamespace: annotations[KAMELET_ANNOTATIONS.namespace] ?? "",
    nativeId: kamelet.metadata.name,
    nativeVersion: catalogVersion,
  };

  const provenance: KameletImport["provenance"] = {
    catalogVersion,
    catalogVersionDeclared: Boolean(declaredCatalog),
    ...(annotations[KAMELET_ANNOTATIONS.provider]
      ? { provider: clip(annotations[KAMELET_ANNOTATIONS.provider], 200) }
      : {}),
    ...(annotations[KAMELET_ANNOTATIONS.group]
      ? { group: clip(annotations[KAMELET_ANNOTATIONS.group], 200) }
      : {}),
    ...(annotations[KAMELET_ANNOTATIONS.namespace]
      ? { namespace: clip(annotations[KAMELET_ANNOTATIONS.namespace], 200) }
      : {}),
    ...(annotations[KAMELET_ANNOTATIONS.supportLevel]
      ? {
          supportLevel: clip(annotations[KAMELET_ANNOTATIONS.supportLevel], 64),
        }
      : {}),
    verified: kamelet.metadata.labels?.[KAMELET_VERIFIED_LABEL] === "true",
    ...(scheme ? { scheme } : {}),
    dependencies,
  };

  const shape = {
    schemaVersion: 1 as const,
    definitionRef: `definition:kamelet:${kamelet.metadata.name}:${catalogVersion}`,
    identity,
    sourceRef: options.sourceRef,
    normalizedDigest: "0".repeat(64),
    importer: { id: KAMELET_IMPORTER_ID, version: KAMELET_ADAPTER_VERSION },
    display: {
      name: clip(definitionBlock.title ?? kamelet.metadata.name, 200),
      description: clip(
        definitionBlock.description ??
          `Apache Camel Kamelet ${kameletType}: ${kamelet.metadata.name}.`,
        500,
      ),
      ecosystem: KAMELET_ECOSYSTEM,
      service: kamelet.metadata.name.replace(/[^a-z0-9._-]/g, "-"),
    },
    authentication,
    configuration: [],
    capabilities: [capability],
    events,
    declaredServers: [],
    compatibility: {
      issues,
      dimensions: completeDimensions({
        import: "exact",
        configure: "adapted",
        export: "exact",
        discover: "exact",
        authorize: "requires-configuration",
        invoke: "requires-configuration",
        events: "unsupported",
      }),
    },
    nativeExtensions: {
      apiVersion: kamelet.apiVersion,
      kind: kamelet.kind,
      catalogVersion,
      kameletType,
      ...(provenance.provider ? { provider: provenance.provider } : {}),
      ...(provenance.group ? { group: provenance.group } : {}),
      ...(provenance.supportLevel
        ? { supportLevel: provenance.supportLevel }
        : {}),
      verified: provenance.verified,
      dependencies,
      ...(scheme ? { scheme } : {}),
      secretProperties: secretNames,
    },
  };
  const normalizedDigest = await normalizedDigestOf(shape);
  const definition = normalizedDefinitionSchema.parse({
    ...shape,
    normalizedDigest,
  });

  return {
    identity,
    document: kamelet,
    kameletType,
    properties,
    definition,
    issues,
    /*
     * A Kamelet is only a candidate for execution, and only where a runner is
     * configured. Listing it here does not approve it; a reviewer binds it.
     */
    executableCandidates: [kamelet.metadata.name],
    byteDigest: parsed.digest,
    provenance,
  };
}

/** The source record describing the captured bytes; the bytes themselves stay in the artifact store. */
export function kameletSourceRecord(input: {
  sourceRef: string;
  identity: ConnectorSourceIdentity;
  origin: SourceRecord["origin"];
  bytes: Uint8Array;
  mediaType: string;
  capturedAt: string;
  catalogVersion: string;
}): SourceRecord {
  return sourceRecordSchema.parse({
    sourceRef: input.sourceRef,
    identity: input.identity,
    format: {
      name: KAMELET_ECOSYSTEM,
      version: input.catalogVersion,
      dialect: KAMELET_PROFILE,
    },
    origin: input.origin,
    digest: { algorithm: "sha256", value: sha256Hex(input.bytes) },
    byteLength: input.bytes.byteLength,
    mediaType: input.mediaType,
    capturedAt: input.capturedAt,
    /*
     * The catalog is Apache-2.0 licensed. That is recorded as a fact read from
     * the project, not as permission to copy an implementation.
     */
    license: { spdx: "Apache-2.0", redistributable: true },
    adaptation: [],
    overlays: [],
  });
}
