import { Document, stringify } from "yaml";
import { ConnectorError } from "../../errors.js";
import type { CompatibilityIssue, NormalizedDefinition } from "../../adapter.js";
import {
  DOCKER_CATALOG_FORMAT_VERSION,
  environmentNamePattern,
  parseImageReference,
  unsafeEnvironmentNames,
  type DockerServerType,
} from "./catalog.js";
import { DOCKER_ECOSYSTEM } from "./normalize.js";

/*
 * Export back to the Docker MCP catalog format.
 *
 * Only a definition that came from a catalog can be exported to one: a
 * connector Ceremony learned from OpenAPI or from a broker has no image, no
 * entry type and no catalog identity, and inventing them would advertise a
 * runnable container that does not exist. What a catalog cannot carry is
 * reported as a loss rather than dropped quietly, and anything a reader
 * removed on import (a literal credential, an unsafe environment name) stays
 * removed: an export never reconstructs it.
 */

export type DockerRunDescriptor = {
  catalogName: string;
  id: string;
  type: DockerServerType;
  image?: string;
  imageDigest?: string;
  command: string[];
  /** Environment names only; values are resolved by a runner, never carried. */
  environment: Array<{ name: string; value: string }>;
  secrets: Array<{ name: string; env: string }>;
  volumes: string[];
  allowHosts: string[];
  disableNetwork?: boolean;
  longLived?: boolean;
  user?: string;
  remote?: { url: string; transportType?: string; headerNames: string[] };
};

export type DockerExportResult = {
  mediaType: string;
  bytes: Uint8Array;
  text: string;
  losses: CompatibilityIssue[];
};

function loss(
  code: string,
  category: CompatibilityIssue["category"],
  dimension: CompatibilityIssue["dimension"],
  severity: CompatibilityIssue["severity"],
  executionImpact: CompatibilityIssue["executionImpact"],
  pointer: string,
  message: string,
): CompatibilityIssue {
  return {
    code,
    category,
    sourcePointer: pointer,
    dimension,
    disposition: severity === "blocking" ? "unsupported" : "adapted",
    severity,
    executionImpact,
    message,
  };
}

type NativeEntry = {
  catalog?: { name?: unknown; displayName?: unknown; version?: unknown };
  entry?: Record<string, unknown>;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

/** The catalog descriptor a definition carries, or undefined when it has none. */
export function dockerDescriptorOf(
  definition: NormalizedDefinition,
): { catalogName: string; entry: Record<string, unknown> } | undefined {
  if (definition.identity.ecosystem !== DOCKER_ECOSYSTEM) return undefined;
  const native = definition.nativeExtensions as NativeEntry;
  const entry = native?.entry;
  const catalogName = native?.catalog?.name;
  if (!isRecord(entry) || typeof catalogName !== "string") return undefined;
  if (entry.id !== definition.identity.nativeId) return undefined;
  return { catalogName, entry };
}

/**
 * The run descriptor a trusted local runner would need. Building it is not
 * running it: the descriptor is data, and a host runner decides separately
 * whether it is willing to execute anything at all.
 */
export function dockerRunDescriptor(
  definition: NormalizedDefinition,
): DockerRunDescriptor {
  const held = dockerDescriptorOf(definition);
  if (!held)
    throw new ConnectorError("unsupported", {
      detail: "docker.export.foreign-origin",
    });
  const entry = held.entry;
  const type = entry.type;
  if (type !== "server" && type !== "remote" && type !== "poci")
    throw new ConnectorError("invalid-request", {
      detail: "docker.export.type-unknown",
    });
  const image =
    typeof entry.image === "string" ? parseImageReference(entry.image) : undefined;
  const environment = Array.isArray(entry.env)
    ? entry.env.flatMap((item) =>
        isRecord(item) &&
        typeof item.name === "string" &&
        environmentNamePattern.test(item.name) &&
        !unsafeEnvironmentNames.has(item.name.toUpperCase()) &&
        typeof item.value === "string"
          ? [{ name: item.name, value: item.value }]
          : [],
      )
    : [];
  const secrets = Array.isArray(entry.secrets)
    ? entry.secrets.flatMap((item) =>
        isRecord(item) &&
        typeof item.name === "string" &&
        typeof item.env === "string" &&
        environmentNamePattern.test(item.env) &&
        !unsafeEnvironmentNames.has(item.env.toUpperCase())
          ? [{ name: item.name, env: item.env }]
          : [],
      )
    : [];
  const strings = (value: unknown): string[] =>
    Array.isArray(value)
      ? value.filter((item): item is string => typeof item === "string")
      : [];
  const remoteRaw = isRecord(entry.remote) ? entry.remote : undefined;
  return {
    catalogName: held.catalogName,
    id: definition.identity.nativeId,
    type,
    ...(image ? { image: image.raw } : {}),
    ...(image?.digest ? { imageDigest: image.digest } : {}),
    command: strings(entry.command),
    environment,
    secrets,
    volumes: strings(entry.volumes),
    allowHosts: strings(entry.allowHosts),
    ...(typeof entry.disableNetwork === "boolean"
      ? { disableNetwork: entry.disableNetwork }
      : {}),
    ...(typeof entry.longLived === "boolean"
      ? { longLived: entry.longLived }
      : {}),
    ...(typeof entry.user === "string" ? { user: entry.user } : {}),
    ...(remoteRaw && typeof remoteRaw.url === "string"
      ? {
          remote: {
            url: remoteRaw.url,
            ...(typeof remoteRaw.transport_type === "string"
              ? { transportType: remoteRaw.transport_type }
              : {}),
            headerNames: isRecord(remoteRaw.headers)
              ? Object.keys(remoteRaw.headers)
              : [],
          },
        }
      : {}),
  };
}

/**
 * Serializes one definition back into a single-entry Docker MCP catalog
 * document, with the losses a reviewer must see before publishing it.
 */
export function exportDockerMcpDescriptor(
  definition: NormalizedDefinition,
  options: { catalogName?: string; displayName?: string } = {},
): DockerExportResult {
  const held = dockerDescriptorOf(definition);
  if (!held)
    throw new ConnectorError("unsupported", {
      detail: "docker.export.foreign-origin",
    });
  const entry = { ...held.entry };
  const losses: CompatibilityIssue[] = [];
  const pointer = `/registry/${definition.identity.nativeId}`;
  const redactions = Array.isArray(entry.redactions) ? entry.redactions : [];
  const unknownKeys = Array.isArray(entry.unknownKeys) ? entry.unknownKeys : [];
  delete entry.redactions;
  delete entry.unknownKeys;
  delete entry.id;
  if (redactions.length)
    losses.push(
      loss(
        "docker-mcp.export.redacted-on-import",
        "security",
        "export",
        "warning",
        "none",
        pointer,
        `${redactions.length} value(s) were removed when this entry was imported and are not reconstructed by the export.`,
      ),
    );
  if (unknownKeys.length)
    losses.push(
      loss(
        "docker-mcp.export.unknown-keys-dropped",
        "structure",
        "export",
        "warning",
        "none",
        pointer,
        `${unknownKeys.length} catalog field(s) this reader does not model were not carried and are absent from the export.`,
      ),
    );
  const blocking = definition.compatibility.issues.filter(
    (item) => item.severity === "blocking",
  );
  if (blocking.length)
    losses.push(
      loss(
        "docker-mcp.export.blocking-issues",
        "policy",
        "export",
        "warning",
        "none",
        pointer,
        `${blocking.length} blocking import diagnostic(s) have no representation in the catalog format; the exported entry does not carry them.`,
      ),
    );
  const foreignAuth = definition.authentication.filter(
    (profile) =>
      profile.kind !== "none" &&
      profile.kind !== "api-key" &&
      profile.kind !== "external-broker" &&
      profile.kind !== "unsupported",
  );
  if (foreignAuth.length)
    losses.push(
      loss(
        "docker-mcp.export.authentication-dropped",
        "security",
        "export",
        "blocking",
        "blocks-authorization",
        pointer,
        `${foreignAuth.length} authentication profile(s) have no catalog representation; the exported entry cannot describe how to authorize them.`,
      ),
    );
  const declaredSecrets = new Set(
    (Array.isArray(entry.secrets) ? entry.secrets : []).flatMap((item) =>
      isRecord(item) && typeof item.env === "string"
        ? [item.env.toUpperCase()]
        : [],
    ),
  );
  const unbackedSecrets = definition.configuration.filter(
    (item) => item.classification === "secret" && !declaredSecrets.has(item.name),
  );
  if (unbackedSecrets.length)
    losses.push(
      loss(
        "docker-mcp.export.configuration-dropped",
        "structure",
        "export",
        "warning",
        "none",
        pointer,
        `${unbackedSecrets.length} secret configuration requirement(s) are not backed by a catalog secret entry and are not exported.`,
      ),
    );
  const toolNames = new Set(
    (Array.isArray(entry.tools) ? entry.tools : []).flatMap((item) =>
      isRecord(item) && typeof item.name === "string" ? [item.name] : [],
    ),
  );
  const extraCapabilities = definition.capabilities.filter(
    (capability) => !toolNames.has(capability.nativeId),
  );
  if (extraCapabilities.length)
    losses.push(
      loss(
        "docker-mcp.export.capabilities-dropped",
        "structure",
        "export",
        "warning",
        "none",
        pointer,
        `${extraCapabilities.length} capabilit(ies) are not catalog tool entries and are not exported.`,
      ),
    );
  if (definition.events.length)
    losses.push(
      loss(
        "docker-mcp.export.events-dropped",
        "structure",
        "export",
        "warning",
        "none",
        pointer,
        "The catalog format carries no event descriptions; they are not exported.",
      ),
    );
  const document = new Document({
    version: Number(DOCKER_CATALOG_FORMAT_VERSION),
    name: options.catalogName ?? held.catalogName,
    ...(options.displayName ? { displayName: options.displayName } : {}),
    registry: { [definition.identity.nativeId]: entry },
  });
  const text = stringify(document, {
    lineWidth: 0,
    defaultKeyType: "PLAIN",
    defaultStringType: "QUOTE_SINGLE",
    schema: "core",
  });
  return {
    mediaType: "application/yaml",
    bytes: new TextEncoder().encode(text),
    text,
    losses,
  };
}
