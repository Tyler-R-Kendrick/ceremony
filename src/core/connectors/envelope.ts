import { z } from "zod";
import {
  connectorProjectSchema,
  type ConnectorProject,
} from "../connector-authoring.js";
import {
  authenticationProfileSchema,
  compatibilityIssueSchema,
  normalizedDefinitionShape,
  refineNormalizedDefinition,
  sourceRecordSchema,
  type AuthenticationProfile,
  type CompatibilityIssue,
  type NormalizedDefinition,
} from "./contracts.js";
import {
  canonicalDigest,
  nativeVersionSchema,
  supportDimensions,
  type MappingDisposition,
  type SupportDimension,
} from "./identity.js";

/**
 * The `ceremony-connector` interoperability envelope, version 2.
 *
 * Version 1 is the studio's authoring project: a v1 manifest, its templates and
 * a constrained Arazzo document. It stays exactly as it is; every saved project
 * still parses with its own validator and nothing here relaxes it. Version 2
 * wraps a *description* — the normalized definition and the provenance of the
 * sources it came from — and may carry an unchanged v1 project beside it when
 * the connector also has a runnable ceremony. A public API with no login has a
 * v2 envelope with a `none` profile and no project; it never gets a fabricated
 * method to satisfy v1's minimum of one.
 */
export const ENVELOPE_LIMITS = Object.freeze({ bytes: 4 * 1024 * 1024 });
export const CEREMONY_CONNECTOR_PROFILE = "ceremony-connector/2" as const;

/** A definition as exported: identity and digests stay, persistence references do not. */
export const portableDefinitionSchema = z
  .strictObject(normalizedDefinitionShape)
  .omit({ definitionRef: true, sourceRef: true })
  .superRefine(refineNormalizedDefinition);
export type PortableDefinition = z.infer<typeof portableDefinitionSchema>;

/** A source record as exported: provenance stays, the protected artifact handle does not. */
export const portableSourceSchema = sourceRecordSchema
  .omit({ sourceRef: true, artifactRef: true })
  .strict();
export type PortableSource = z.infer<typeof portableSourceSchema>;

export const connectorEnvelopeSchema = z
  .strictObject({
    format: z.literal("ceremony-connector"),
    version: z.literal(2),
    profile: z.strictObject({
      id: z.literal(CEREMONY_CONNECTOR_PROFILE),
      producer: z.strictObject({
        id: z.string().min(1).max(120),
        version: nativeVersionSchema,
      }),
    }),
    definition: portableDefinitionSchema,
    sources: z.array(portableSourceSchema).max(16),
    /** The unchanged v1 project, when the connector has an executable Ceremony. */
    project: connectorProjectSchema.optional(),
  })
  .superRefine((envelope, ctx) => {
    if (
      envelope.project &&
      !envelope.definition.authentication.some(
        (profile) => profile.kind === "ceremony-method",
      )
    )
      ctx.addIssue({
        code: "custom",
        message:
          "An embedded v1 project must be described by ceremony-method profiles",
      });
    for (const profile of envelope.definition.authentication)
      if (
        profile.kind === "ceremony-method" &&
        !envelope.project?.manifest.methods.some(
          (method) =>
            method.id === profile.methodId && method.kind === profile.flowKind,
        )
      )
        ctx.addIssue({
          code: "custom",
          message: "ceremony-method profile names a method the project lacks",
        });
  });
export type ConnectorEnvelope = z.infer<typeof connectorEnvelopeSchema>;

export type ParsedConnectorDocument =
  | { version: 1; project: ConnectorProject }
  | { version: 2; envelope: ConnectorEnvelope };

/** Reads either envelope version; the byte ceiling is checked before parsing. */
export function parseConnectorEnvelope(text: string): ParsedConnectorDocument {
  if (new TextEncoder().encode(text).byteLength > ENVELOPE_LIMITS.bytes)
    throw new Error("Connector document exceeds import limit");
  const value: unknown = JSON.parse(text);
  const header = z
    .object({
      format: z.literal("ceremony-connector"),
      version: z.union([z.literal(1), z.literal(2)]),
    })
    .parse(value);
  if (header.version === 1)
    return { version: 1, project: connectorProjectSchema.parse(value) };
  return { version: 2, envelope: connectorEnvelopeSchema.parse(value) };
}

const v1Dimensions: Record<SupportDimension, MappingDisposition> = {
  discover: "unsupported",
  import: "exact",
  configure: "exact",
  authorize: "requires-configuration",
  verify: "requires-configuration",
  invoke: "unsupported",
  events: "unsupported",
  reconnect: "requires-configuration",
  disconnect: "exact",
  revoke: "unsupported",
  export: "exact",
  delegate: "unsupported",
};

/**
 * Wraps a v1 project in a v2 envelope without changing it. Every method
 * becomes a `ceremony-method` profile that points back at the method; the
 * project travels unchanged so a v1 reader still gets exactly what it saved.
 */
export async function upgradeConnectorProject(
  input: unknown,
  producer: { id: string; version: string },
  capturedAt: string,
): Promise<ConnectorEnvelope> {
  const project = connectorProjectSchema.parse(input);
  const manifest = project.manifest;
  const authentication: AuthenticationProfile[] = manifest.methods.map(
    (method) => ({
      id: method.id,
      label: method.label,
      kind: "ceremony-method",
      flowKind: method.kind,
      methodId: method.id,
    }),
  );
  const configuration = manifest.methods.flatMap((method) =>
    method.contract.configuration.map((item) => ({
      name: item.name,
      source: item.source,
      classification: item.classification,
      required: item.required,
    })),
  );
  const seen = new Set<string>();
  const uniqueConfiguration = configuration.filter((item) => {
    if (seen.has(item.name)) return false;
    seen.add(item.name);
    return true;
  });
  const declaredServers = project.workflows.flatMap((document) =>
    document.sourceDescriptions.map((source) => ({
      url: source.url,
      description: `${document.document} OpenAPI source description`,
      status: "declared" as const,
    })),
  );
  const projectText = JSON.stringify(project);
  const projectDigest = await canonicalDigest(project);
  const definitionBody = {
    schemaVersion: 1 as const,
    identity: {
      ecosystem: "ceremony",
      authorityNamespace: "",
      nativeId: manifest.id,
      nativeVersion: "1",
    },
    importer: { id: "ceremony-connector-v1", version: producer.version },
    display: {
      name: manifest.name,
      description: manifest.description,
      ecosystem: "ceremony",
      service: manifest.id,
    },
    authentication,
    configuration: uniqueConfiguration,
    capabilities: [],
    events: [],
    declaredServers,
    compatibility: { issues: [], dimensions: v1Dimensions },
    nativeExtensions: {},
  };
  const definition: PortableDefinition = portableDefinitionSchema.parse({
    ...definitionBody,
    normalizedDigest: await canonicalDigest(definitionBody),
  });
  return connectorEnvelopeSchema.parse({
    format: "ceremony-connector",
    version: 2,
    profile: { id: CEREMONY_CONNECTOR_PROFILE, producer },
    definition,
    sources: [
      {
        identity: definition.identity,
        format: { name: "ceremony-connector", version: "1" },
        origin: { kind: "upload" },
        digest: { algorithm: "sha256", value: projectDigest },
        byteLength: new TextEncoder().encode(projectText).byteLength,
        mediaType: "application/json",
        capturedAt,
        adaptation: [],
        overlays: [],
      },
    ],
    project,
  });
}

/**
 * Produces the v1 view of a v2 envelope. Only an embedded, unchanged project is
 * a faithful v1 document; a description without one has no v1 spelling, and
 * saying so is the deliverable. A public API is reported as exactly that.
 */
export function downgradeConnectorEnvelope(input: unknown): {
  project?: ConnectorProject;
  diagnostics: CompatibilityIssue[];
} {
  const envelope = connectorEnvelopeSchema.parse(input);
  const diagnostics: CompatibilityIssue[] = [];
  const issue = (
    code: string,
    message: string,
    severity: CompatibilityIssue["severity"],
    pointer: string,
  ) =>
    diagnostics.push(
      compatibilityIssueSchema.parse({
        code,
        category: "version",
        sourcePointer: pointer,
        dimension: "export",
        disposition: severity === "blocking" ? "unsupported" : "adapted",
        severity,
        executionImpact: severity === "blocking" ? "blocks-definition" : "none",
        message,
      }),
    );
  if (!envelope.project) {
    const publicOnly = envelope.definition.authentication.every(
      (profile) => profile.kind === "none",
    );
    issue(
      "envelope.v1.no-project",
      publicOnly
        ? "Version 1 requires at least one authentication method; this description is a public or no-credential API and has none to declare."
        : "Version 1 can carry only a Ceremony authoring project; this description has no executable ceremony to downgrade.",
      "blocking",
      "/definition/authentication",
    );
    return { diagnostics };
  }
  if (envelope.definition.capabilities.length)
    issue(
      "envelope.v1.capabilities-dropped",
      "Version 1 carries no capability descriptions; they are omitted from the downgraded project.",
      "warning",
      "/definition/capabilities",
    );
  if (envelope.definition.events.length)
    issue(
      "envelope.v1.events-dropped",
      "Version 1 carries no event descriptions; they are omitted from the downgraded project.",
      "warning",
      "/definition/events",
    );
  if (Object.keys(envelope.definition.nativeExtensions).length)
    issue(
      "envelope.v1.extensions-dropped",
      "Native extensions are not part of a version 1 project.",
      "warning",
      "/definition/nativeExtensions",
    );
  if (envelope.sources.length)
    issue(
      "envelope.v1.provenance-dropped",
      "Source provenance is not part of a version 1 project.",
      "info",
      "/sources",
    );
  return { project: envelope.project, diagnostics };
}

/** Dimensions a description alone claims, defaulting anything unstated to unsupported. */
export function completeDimensions(
  partial: Partial<Record<SupportDimension, MappingDisposition>>,
): Record<SupportDimension, MappingDisposition> {
  return Object.fromEntries(
    supportDimensions.map((dimension) => [
      dimension,
      partial[dimension] ?? "unsupported",
    ]),
  ) as Record<SupportDimension, MappingDisposition>;
}

export const authenticationKinds = authenticationProfileSchema.options.map(
  (option) => option.shape.kind.value,
);
export type DefinitionInput = NormalizedDefinition;
