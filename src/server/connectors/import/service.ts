import { readFile } from "node:fs/promises";
import { resolve as resolvePath, sep } from "node:path";
import { fileURLToPath } from "node:url";
import {
  connectorImportResultSchema,
  connectorSourceIdentitySchema,
  nativeIdentifierSchema,
  nativeVersionSchema,
  safeTextSchema,
  type CompatibilityIssue,
  type ConnectorImportResult,
  type ConnectorSourceIdentity,
  type SourceRecord,
} from "../../../core/connectors/index.js";
import {
  actorContextSchema,
  type ActorContext,
} from "../../../core/operation-contracts.js";
import { AuthorizationError, requireCapability } from "../../identity.js";
import { ConnectorError } from "../errors.js";
import type { DefinitionStorePort, SourceArtifactPort } from "../ports.js";
import { isPlainObject, makeIssue } from "./common.js";
import {
  diffSources,
  refreshDecision,
  type RefreshDecision,
  type SourceDiff,
  type SourceSnapshot,
} from "./diff.js";
import type { ParseLimits } from "./limits.js";
import { SYSTEM_TENANT } from "../../system-tenants.js";
import {
  createApprovedFetch,
  evaluateNetworkTarget,
  isApprovedFetch,
  type ApprovedFetch,
  type NetworkPolicy,
} from "./network.js";
import {
  assertSafeFileName,
  normalizeMediaType,
  parseBoundedDocument,
  type DocumentFormat,
  type ParsedDocument,
} from "./parse.js";
import {
  captureSource,
  normalizedDigestFor,
  type SourceOriginKind,
} from "./source.js";

/*
 * The import commands as pure functions over ports. Each one takes the
 * authenticated actor the command layer derived, reads bytes from exactly one
 * place (an upload, one approved retrieval, or a local fixture), parses them
 * within bounds, captures the source as a protected artifact and returns the
 * parsed value with its provenance for a format reader to normalize. Import
 * registers nothing executable: `definitions` and `executableCandidates` are
 * empty here by construction, and no server, `$ref` or discovery document is
 * contacted as a side effect.
 */

export const IMPORTER_ID = "ceremony-import";
export const IMPORTER_VERSION = "1.0.0";

export type ImportPorts = {
  artifacts: SourceArtifactPort;
  definitions?: Pick<DefinitionStorePort, "putSource"> | undefined;
  now?: (() => number) | undefined;
};

export type ImportOptions = {
  /** Upload file name; a hint for format detection, never a path. */
  fileName?: string | undefined;
  /** Overrides for the derived source identity; validated, never trusted for authority. */
  identity?: Partial<ConnectorSourceIdentity> | undefined;
  limits?: Partial<ParseLimits> | undefined;
  retainUntil?: number | undefined;
  license?: SourceRecord["license"] | undefined;
};

export type DetectedDocument = {
  ecosystem: string;
  formatName: string;
  version: string;
  dialect?: string;
  title?: string;
};

export type IngestionResult = {
  source: SourceRecord;
  document: {
    value: unknown;
    format: DocumentFormat;
    normalizedDigest: string;
    detected: DetectedDocument;
    stats: ParsedDocument["stats"];
  };
  result: ConnectorImportResult;
  issues: CompatibilityIssue[];
};

const documentAccept =
  "application/json, application/yaml, application/x-yaml, application/vnd.oai.openapi+json, application/vnd.oai.openapi, text/yaml;q=0.9, */*;q=0.1";

/** Import is an authoring act: the host's authenticated actor must hold the author capability. */
export function authorizeImport(actor: ActorContext): ActorContext {
  const parsed = actorContextSchema.safeParse(actor);
  if (!parsed.success) throw new AuthorizationError("unauthenticated");
  requireCapability(parsed.data, "author");
  return parsed.data;
}

const versionText = (value: unknown): string | undefined =>
  typeof value === "string" && nativeVersionSchema.safeParse(value).success
    ? value
    : undefined;

/** Recognizes the document family from its declared markers; nothing here trusts the content. */
export function detectDocument(value: unknown): DetectedDocument {
  const root = isPlainObject(value) ? value : undefined;
  const unknown: DetectedDocument = {
    ecosystem: "unknown",
    formatName: "unknown",
    version: "unknown",
  };
  if (!root) return unknown;
  const info = isPlainObject(root.info) ? root.info : undefined;
  const title =
    typeof info?.title === "string" &&
    safeTextSchema.safeParse(info.title).success &&
    info.title.trim()
      ? info.title.slice(0, 200)
      : undefined;
  const withTitle = (detected: DetectedDocument): DetectedDocument =>
    title ? { ...detected, title } : detected;
  const openapi = versionText(root.openapi);
  if (openapi)
    return withTitle({
      ecosystem: "openapi",
      formatName: "openapi",
      version: openapi,
      ...(typeof root.jsonSchemaDialect === "string" &&
      root.jsonSchemaDialect.length <= 120
        ? { dialect: root.jsonSchemaDialect }
        : {}),
    });
  if (versionText(root.swagger) === "2.0")
    return withTitle({
      ecosystem: "openapi",
      formatName: "swagger",
      version: "2.0",
    });
  const asyncapi = versionText(root.asyncapi);
  if (asyncapi)
    return withTitle({
      ecosystem: "asyncapi",
      formatName: "asyncapi",
      version: asyncapi,
    });
  const arazzo = versionText(root.arazzo);
  if (arazzo)
    return withTitle({
      ecosystem: "arazzo",
      formatName: "arazzo",
      version: arazzo,
    });
  const overlay = versionText(root.overlay);
  if (overlay)
    return withTitle({
      ecosystem: "openapi-overlay",
      formatName: "openapi-overlay",
      version: overlay,
    });
  if (
    root.format === "ceremony-connector" &&
    (root.version === 1 || root.version === 2)
  )
    return {
      ecosystem: "ceremony",
      formatName: "ceremony-connector",
      version: String(root.version),
    };
  const schema = typeof root.$schema === "string" ? root.$schema : "";
  if (
    /modelcontextprotocol\.io\/schemas\/.*server\.json/.test(schema) ||
    (typeof root.name === "string" &&
      (Array.isArray(root.packages) || Array.isArray(root.remotes)))
  )
    return {
      ecosystem: "mcp-registry",
      formatName: "mcp-server-json",
      version: schema.match(/schemas\/([0-9-]+)\//)?.[1] ?? "unknown",
    };
  if (
    typeof root.protocolVersion === "string" &&
    Array.isArray(root.skills) &&
    typeof root.url === "string"
  )
    return {
      ecosystem: "a2a",
      formatName: "agent-card",
      version: versionText(root.protocolVersion) ?? "unknown",
    };
  return unknown;
}

function deriveIdentity(
  detected: DetectedDocument,
  hint: Partial<ConnectorSourceIdentity>,
  context: {
    location?: URL | undefined;
    fileName?: string | undefined;
    digest: string;
    value: unknown;
  },
): ConnectorSourceIdentity {
  const info =
    isPlainObject(context.value) && isPlainObject(context.value.info)
      ? context.value.info
      : undefined;
  const candidates = [
    hint.nativeId,
    context.location?.pathname,
    context.fileName,
    `sha256:${context.digest.slice(0, 32)}`,
  ].filter(
    (candidate): candidate is string =>
      typeof candidate === "string" &&
      nativeIdentifierSchema.safeParse(candidate).success,
  );
  const identity = connectorSourceIdentitySchema.safeParse({
    ecosystem: hint.ecosystem ?? detected.ecosystem,
    authorityNamespace:
      hint.authorityNamespace ??
      (context.location ? context.location.host : ""),
    nativeId: candidates[0],
    nativeVersion:
      hint.nativeVersion ?? versionText(info?.version) ?? "unversioned",
  });
  if (!identity.success)
    throw new ConnectorError("invalid-request", {
      detail: "import.identity-invalid",
    });
  return identity.data;
}

function detectionIssues(
  detected: DetectedDocument,
  parsed: ParsedDocument,
): CompatibilityIssue[] {
  const issues: CompatibilityIssue[] = [];
  if (detected.ecosystem === "unknown")
    issues.push(
      makeIssue({
        code: "structure.format-unrecognized",
        category: "structure",
        sourcePointer: "",
        disposition: "unsupported",
        severity: "warning",
        executionImpact: "none",
        message:
          "The document format was not recognized; it is stored as an opaque source with no capabilities.",
        remediation:
          "Declare a supported format: OpenAPI, Swagger, AsyncAPI, Arazzo, Overlay, MCP server.json, A2A agent card or ceremony-connector.",
      }),
    );
  if (parsed.stats.aliases > 0)
    issues.push(
      makeIssue({
        code: "structure.yaml-aliases-expanded",
        category: "structure",
        sourcePointer: "",
        disposition: "adapted",
        severity: "info",
        executionImpact: "none",
        message:
          "YAML aliases were expanded into independent values within the import's bounds.",
      }),
    );
  return issues;
}

type IngestInput = {
  mediaType: string;
  contentEncoding?: string | undefined;
  origin: { kind: SourceOriginKind; location?: string | undefined };
  fileName?: string | undefined;
};

async function ingest(
  actor: ActorContext,
  bytes: Uint8Array,
  input: IngestInput,
  ports: ImportPorts,
  options: ImportOptions,
): Promise<IngestionResult> {
  const fileName =
    input.fileName === undefined
      ? undefined
      : assertSafeFileName(input.fileName);
  const mediaType = normalizeMediaType(input.mediaType);
  if (input.mediaType && !mediaType && input.mediaType.trim() !== "")
    throw new ConnectorError("invalid-request", {
      detail: "document.media-type-unsupported",
    });
  const parsed = parseBoundedDocument(bytes, {
    mediaType,
    fileName,
    contentEncoding: input.contentEncoding,
    limits: options.limits,
  });
  const detected = detectDocument(parsed.value);
  const location =
    input.origin.location === undefined
      ? undefined
      : new URL(input.origin.location);
  const identity = deriveIdentity(detected, options.identity ?? {}, {
    location,
    fileName,
    digest: parsed.digest,
    value: parsed.value,
  });
  const now = ports.now ?? Date.now;
  const source = await captureSource(
    parsed.bytes,
    {
      tenantId: actor.tenantId,
      identity,
      format: {
        name: detected.formatName,
        version: detected.version,
        ...(detected.dialect ? { dialect: detected.dialect } : {}),
      },
      origin: input.origin,
      mediaType:
        mediaType &&
        !["application/octet-stream", "text/plain"].includes(mediaType)
          ? mediaType
          : parsed.format === "json"
            ? "application/json"
            : "application/yaml",
      capturedAt: now(),
      retainUntil: options.retainUntil,
      license: options.license,
    },
    ports.artifacts,
  );
  await ports.definitions?.putSource(actor.tenantId, source);
  const issues = detectionIssues(detected, parsed);
  const result = connectorImportResultSchema.parse({
    sourceRef: source.sourceRef,
    definitions: [],
    issues,
    executableCandidates: [],
  });
  return {
    source,
    document: {
      value: parsed.value,
      format: parsed.format,
      normalizedDigest: await normalizedDigestFor(parsed.value),
      detected,
      stats: parsed.stats,
    },
    result,
    issues,
  };
}

/** An authenticated upload: bytes arrive from the host's bounded multipart or body handling. */
export async function importUpload(
  actor: ActorContext,
  bytes: Uint8Array,
  mediaType: string,
  ports: ImportPorts,
  options: ImportOptions & { contentEncoding?: string | undefined } = {},
): Promise<IngestionResult> {
  const checked = authorizeImport(actor);
  if (typeof mediaType !== "string" || mediaType.length > 200)
    throw new ConnectorError("invalid-request", {
      detail: "document.media-type-unsupported",
    });
  return ingest(
    checked,
    bytes,
    {
      mediaType,
      contentEncoding: options.contentEncoding,
      origin: { kind: "upload" },
      fileName: options.fileName,
    },
    ports,
    options,
  );
}

async function retrieve(
  url: string | URL,
  policy: NetworkPolicy,
  fetcher: ApprovedFetch | undefined,
): Promise<{ bytes: Uint8Array; mediaType: string; location: string }> {
  const target = evaluateNetworkTarget(url, policy, { hop: 0 });
  if (!target.allowed)
    throw new ConnectorError("network-policy", { detail: target.detail });
  if (fetcher !== undefined && !isApprovedFetch(fetcher))
    throw new ConnectorError("invalid-request", {
      detail: "import.fetch-not-approved",
    });
  const owned = fetcher === undefined;
  const approved = fetcher ?? createApprovedFetch(policy);
  try {
    const response = await approved(target.url, {
      method: "GET",
      headers: { accept: documentAccept },
      redirect: "follow",
    });
    if (response.status !== 200)
      throw new ConnectorError("upstream-rejected", {
        detail: `import.status-${response.status}`,
      });
    return {
      bytes: new Uint8Array(await response.arrayBuffer()),
      mediaType: normalizeMediaType(response.headers.get("content-type") ?? ""),
      location: response.url || target.url.href,
    };
  } finally {
    if (owned) await approved.close();
  }
}

/**
 * Retrieves one document through the approved fetcher and imports it. The
 * only network activity is that retrieval (and validated redirects of it):
 * declared servers, references and discovery documents are not contacted.
 */
export async function importFromUrl(
  actor: ActorContext,
  url: string | URL,
  policy: NetworkPolicy,
  ports: ImportPorts,
  options: ImportOptions & { fetch?: ApprovedFetch | undefined } = {},
): Promise<IngestionResult> {
  const checked = authorizeImport(actor);
  const retrieved = await retrieve(url, policy, options.fetch);
  return ingest(
    checked,
    retrieved.bytes,
    {
      mediaType: retrieved.mediaType,
      origin: { kind: "url", location: retrieved.location },
    },
    ports,
    options,
  );
}

export type RefreshResult = {
  previous: SourceRecord;
  candidate: IngestionResult;
  diff: SourceDiff;
  decision: RefreshDecision;
};

/** Compares a candidate against the previous capture; neither record is modified. */
export function evaluateRefresh(
  previous: SourceSnapshot,
  candidate: IngestionResult,
): RefreshResult {
  const diff = diffSources(previous, {
    record: candidate.source,
    value: candidate.document.value,
  });
  return {
    previous: previous.record,
    candidate,
    diff,
    decision: refreshDecision(diff),
  };
}

/**
 * Re-retrieves a URL-sourced document and produces a candidate revision with
 * its diff. The previous record stays exactly as it was; a caller decides
 * whether the candidate may be promoted, and the decision says what that
 * would invalidate.
 */
export async function refreshFromUrl(
  actor: ActorContext,
  previous: SourceSnapshot,
  policy: NetworkPolicy,
  ports: ImportPorts,
  options: ImportOptions & { fetch?: ApprovedFetch | undefined } = {},
): Promise<RefreshResult> {
  if (previous.record.origin.kind !== "url" || !previous.record.origin.location)
    throw new ConnectorError("invalid-request", {
      detail: "import.refresh-origin-not-url",
    });
  const candidate = await importFromUrl(
    actor,
    previous.record.origin.location,
    policy,
    ports,
    { identity: previous.record.identity, ...options },
  );
  return evaluateRefresh(previous, candidate);
}

/** A re-uploaded document compared against its previous capture. */
export async function refreshFromUpload(
  actor: ActorContext,
  previous: SourceSnapshot,
  bytes: Uint8Array,
  mediaType: string,
  ports: ImportPorts,
  options: ImportOptions = {},
): Promise<RefreshResult> {
  const candidate = await importUpload(actor, bytes, mediaType, ports, {
    identity: previous.record.identity,
    ...options,
  });
  return evaluateRefresh(previous, candidate);
}

/** Where the checked-in import fixtures live; the air-gapped path reads nothing else. */
export const IMPORT_FIXTURE_ROOT = fileURLToPath(
  new URL("../../../../tests/connectors/fixtures/import/", import.meta.url),
);

const fixtureNamePattern = /^[a-z0-9][a-z0-9._-]{0,99}\.(json|ya?ml)$/;

/** The system actor the air-gapped path runs as; it holds only the author capability. */
export const fixtureImportActor: Readonly<ActorContext> = Object.freeze({
  tenantId: SYSTEM_TENANT.fixture,
  subjectId: "fixture-import",
  sessionId: "fixture-import",
  actorKind: "system" as const,
  capabilities: ["author" as const],
});

/**
 * Imports a checked-in fixture by name from the fixture directory. The name
 * is a bounded token with a JSON or YAML extension, never a path; the
 * resolved file must stay inside the root. Nothing here touches the network.
 */
export async function importLocalFixture(
  name: string,
  ports: ImportPorts,
  options: ImportOptions & {
    root?: string | undefined;
    actor?: ActorContext | undefined;
  } = {},
): Promise<IngestionResult> {
  if (
    typeof name !== "string" ||
    !fixtureNamePattern.test(name) ||
    name.includes("..")
  )
    throw new ConnectorError("invalid-request", {
      detail: "import.fixture-name-invalid",
    });
  const root = resolvePath(options.root ?? IMPORT_FIXTURE_ROOT);
  const path = resolvePath(root, name);
  if (!path.startsWith(`${root}${sep}`))
    throw new ConnectorError("invalid-request", {
      detail: "import.fixture-name-invalid",
    });
  const checked = authorizeImport(options.actor ?? fixtureImportActor);
  let bytes: Uint8Array;
  try {
    bytes = new Uint8Array(await readFile(path));
  } catch {
    throw new ConnectorError("not-found", { detail: "import.fixture-missing" });
  }
  return ingest(
    checked,
    bytes,
    {
      mediaType: name.endsWith(".json")
        ? "application/json"
        : "application/yaml",
      origin: { kind: "builtin-fixture" },
      fileName: name,
    },
    ports,
    options,
  );
}
