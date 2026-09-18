import {
  canonicalDigest,
  completeDimensions,
  normalizedDefinitionSchema,
  normalizedDigestOf,
  type AuthenticationProfile,
  type CompatibilityIssue,
  type ConfigurationRequirement,
  type ConnectorSourceIdentity,
  type EventDescriptor,
  type MappingDisposition,
  type NativeCapability,
  type NormalizedDefinition,
  type SupportDimension,
} from "../../../../core/connectors/index.js";
import { safeText } from "./common.js";

/*
 * The three automation readers produce the same shape, so they share the
 * assembly step. What a static reader can honestly claim is fixed here and
 * nowhere else: `import` is exact or adapted, `export` is adapted, and
 * `invoke` is never better than `requires-configuration`, because none of
 * these ecosystems can be executed by reading their source — execution needs
 * a host-approved external runtime binding. A reader that wants to claim more
 * has to change this function, in front of its tests.
 */

export type AutomationDimensions = Partial<
  Record<SupportDimension, MappingDisposition>
>;

export type AutomationDefinitionInput = {
  identity: ConnectorSourceIdentity;
  importer: { id: string; version: string };
  display: {
    name: string;
    description: string;
    ecosystem: string;
    service?: string | undefined;
  };
  authentication: AuthenticationProfile[];
  configuration: ConfigurationRequirement[];
  capabilities: NativeCapability[];
  events: EventDescriptor[];
  declaredServers: Array<{ url: string; description?: string }>;
  issues: CompatibilityIssue[];
  dimensions: AutomationDimensions;
  nativeExtensions: Record<string, unknown>;
  /** Bytes or canonical JSON the definition was read from; digested for the source reference. */
  sourceMaterial: unknown;
};

export type AutomationReadResult = {
  definition: NormalizedDefinition;
  issues: CompatibilityIssue[];
  /** Capability native ids a reviewer may bind; import approves nothing. */
  executableCandidates: string[];
};

/** Disposition a static reader may claim per dimension, after clamping. */
export function staticDimensions(
  claimed: AutomationDimensions,
): Record<SupportDimension, MappingDisposition> {
  const clamped: AutomationDimensions = { ...claimed };
  const invoke = clamped.invoke;
  if (invoke === "exact" || invoke === "adapted")
    clamped.invoke = "requires-configuration";
  const exportDisposition = clamped.export;
  if (exportDisposition === "exact") clamped.export = "adapted";
  return completeDimensions(clamped);
}

const MAX_SERVERS = 32;

export async function buildAutomationDefinition(
  input: AutomationDefinitionInput,
): Promise<NormalizedDefinition> {
  const sourceDigest = await canonicalDigest(input.sourceMaterial);
  const body = {
    schemaVersion: 1 as const,
    identity: input.identity,
    importer: input.importer,
    display: {
      name:
        safeText(input.display.name, 200) ||
        input.identity.nativeId.slice(0, 200),
      description: safeText(input.display.description, 500),
      ecosystem: input.display.ecosystem,
      ...(input.display.service ? { service: input.display.service } : {}),
    },
    authentication: input.authentication,
    configuration: input.configuration,
    capabilities: input.capabilities,
    events: input.events,
    declaredServers: input.declaredServers
      .slice(0, MAX_SERVERS)
      .map((server) => ({
        url: server.url.slice(0, 2048),
        ...(server.description
          ? { description: safeText(server.description, 500) }
          : {}),
        status: "declared" as const,
      })),
    compatibility: {
      issues: input.issues,
      dimensions: staticDimensions(input.dimensions),
    },
    nativeExtensions: input.nativeExtensions,
  };
  const normalizedDigest = await normalizedDigestOf(body);
  return normalizedDefinitionSchema.parse({
    ...body,
    definitionRef: `definition:${input.display.ecosystem}:${normalizedDigest.slice(0, 32)}`,
    sourceRef: `source:${input.display.ecosystem}:${sourceDigest.slice(0, 32)}`,
    normalizedDigest,
  });
}

/**
 * Capability rows a static automation reader may publish. `import` is what it
 * actually did; `invoke` is always requires-configuration through an external
 * runtime; `export` is adapted, never exact, because none of these formats
 * round-trips code.
 */
export function automationCapabilityRows(input: {
  importDisposition: MappingDisposition;
  hasBlockingIssue: boolean;
}): AutomationDimensions {
  return {
    import: input.hasBlockingIssue ? "unsupported" : input.importDisposition,
    configure: "adapted",
    invoke: "requires-configuration",
    export: "adapted",
    delegate: "requires-configuration",
  };
}

/**
 * What a description alone can claim about `authorize`. A profile this
 * runtime can execute means authorization is possible once configured; a
 * description whose only profile is `none` needs no authorization at all; and
 * a profile the runtime cannot execute is unsupported, not optimistic.
 */
export function authenticationDisposition(
  profiles: readonly AuthenticationProfile[],
): MappingDisposition {
  if (!profiles.length) return "unsupported";
  if (profiles.every((profile) => profile.kind === "none")) return "exact";
  const executable = profiles.some(
    (profile) => profile.kind !== "none" && profile.kind !== "unsupported",
  );
  return executable ? "requires-configuration" : "unsupported";
}

export type AutomationExportResult = {
  mediaType: string;
  bytes: Uint8Array;
  /** The exported document, before serialization; tests read this rather than re-parsing. */
  document: unknown;
  losses: CompatibilityIssue[];
};

/**
 * The part of a description that an export claims to round-trip. It is the
 * descriptive metadata: identity, display, authentication profiles,
 * configuration, capabilities and the named native extensions each ecosystem
 * documents as carried. Diagnostics, digests and persistence references are
 * deliberately outside it — an export legitimately produces its own
 * diagnostics, and a round trip that compared them would be comparing the
 * reader to itself.
 */
export function automationSupportedSubset(
  definition: NormalizedDefinition,
  extensionKeys: readonly string[],
): unknown {
  const keys = new Set(extensionKeys);
  return {
    identity: definition.identity,
    display: definition.display,
    authentication: definition.authentication,
    configuration: definition.configuration,
    events: definition.events,
    declaredServers: [...definition.declaredServers].sort((a, b) =>
      a.url < b.url ? -1 : a.url > b.url ? 1 : 0,
    ),
    capabilities: [...definition.capabilities]
      .sort((a, b) =>
        a.nativeId < b.nativeId ? -1 : a.nativeId > b.nativeId ? 1 : 0,
      )
      .map((capability) => ({
        kind: capability.kind,
        nativeId: capability.nativeId,
        label: capability.label,
        summary: capability.summary,
        effect: capability.effect,
        dataClassification: capability.dataClassification,
        cost: capability.cost,
        authentication: capability.authentication,
        inputSchemaRef: capability.inputSchemaRef,
        outputSchemaRef: capability.outputSchemaRef,
        nativeExtensions: Object.fromEntries(
          Object.entries(capability.nativeExtensions ?? {})
            .filter(([key]) => keys.has(key))
            .sort(([a], [b]) => (a < b ? -1 : 1)),
        ),
      })),
  };
}
