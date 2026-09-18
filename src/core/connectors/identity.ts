import { z } from "zod";
import { isReservedObjectKey } from "./json-bounds.js";

/**
 * Vocabulary shared by every connector ecosystem adapter.
 *
 * Support is reported per dimension, never as one boolean. A family that can
 * import a description but not execute it says so in `invoke`, and a family
 * whose adapter exists but whose deployment lacks credentials says so in
 * `configuration`, not by pretending to be unsupported or pretending to work.
 */
export const supportDimensions = [
  "discover",
  "import",
  "configure",
  "authorize",
  "verify",
  "invoke",
  "events",
  "reconnect",
  "disconnect",
  "revoke",
  "export",
  "delegate",
] as const;
export const supportDimensionSchema = z.enum(supportDimensions);
export type SupportDimension = z.infer<typeof supportDimensionSchema>;

export const mappingDispositions = [
  "exact",
  "adapted",
  "native-extension",
  "requires-configuration",
  "unsupported",
  "rejected",
] as const;
export const mappingDispositionSchema = z.enum(mappingDispositions);
export type MappingDisposition = z.infer<typeof mappingDispositionSchema>;

/** Ordered weakest to strongest. A fixture pass is never relabelled live. */
export const evidenceLevels = [
  "not-tested",
  "unit",
  "protocol-fixture",
  "local-integration",
  "browser-integration",
  "live-authorized",
  "deployed-authorized",
] as const;
export const evidenceLevelSchema = z.enum(evidenceLevels);
export type EvidenceLevel = z.infer<typeof evidenceLevelSchema>;

export const credentialCustodies = [
  "host-owned",
  "external-credential-broker",
  "external-execution-broker",
  "attended-browser",
  "no-credential",
] as const;
export const credentialCustodySchema = z.enum(credentialCustodies);
export type CredentialCustody = z.infer<typeof credentialCustodySchema>;

export const runtimeClasses = [
  "browser",
  "hosted-server",
  "trusted-local-runner",
] as const;
export const runtimeClassSchema = z.enum(runtimeClasses);
export type RuntimeClass = z.infer<typeof runtimeClassSchema>;

/** Owner kinds are different principals, not labels on one grant. */
export const ownerKinds = ["user", "organization", "workload"] as const;
export const ownerKindSchema = z.enum(ownerKinds);
export type OwnerKind = z.infer<typeof ownerKindSchema>;

/**
 * Ecosystems this repository knows how to describe. The schema accepts any
 * bounded token so a host can register its own adapter without a core change;
 * the list is for display grouping and documentation, not authorization.
 */
export const knownEcosystems = [
  "ceremony",
  "openapi",
  "openapi-overlay",
  "arazzo",
  "asyncapi",
  "cloudevents",
  "standard-webhooks",
  "mcp",
  "mcp-registry",
  "vercel-connect",
  "supabase",
  "nango",
  "pipedream",
  "composio",
  "workos",
  "auth0",
  "smithery",
  "docker-mcp",
  "pulsemcp",
  "microsoft-custom-connector",
  "zapier",
  "n8n",
  "workato",
  "airbyte",
  "hasura-ndc",
  "merge",
  "aws-agentcore",
  "google-integration-connectors",
  "camel-kamelet",
  "dapr",
  "open-service-broker",
  "a2a",
  "webmcp",
  "retrieval",
] as const;
export const ecosystemSchema = z.string().regex(/^[a-z][a-z0-9-]{0,63}$/);
export type Ecosystem = z.infer<typeof ecosystemSchema>;

/** Length ceilings for opaque upstream values; the only local constraint besides control characters. */
export const IDENTIFIER_LIMITS = Object.freeze({
  nativeId: 512,
  nativeVersion: 128,
  authorityNamespace: 256,
  safeText: 500,
  reference: 200,
});

// Control characters (C0 and DEL) never belong in an identifier, a version or
// a message that will be shown to a person or written to a log.
const noControlCharacters = /^[^\p{Cc}]+$/u;
const noControlCharactersOrEmpty = /^[^\p{Cc}]*$/u;
// Explicit bidirectional controls can make one identifier read as another in
// a review screen; nothing upstream needs them in an identifier or a version.
const noBidiControls = /^[^\u{202A}-\u{202E}\u{2066}-\u{2069}]*$/u;
const notBlank = (value: string) => value.trim().length > 0;
const traversal = /(^|[\\/])\.\.?([\\/]|$)/;

/**
 * An upstream identifier is preserved exactly as the upstream spelled it:
 * case, separators, slashes, dots and all. It is never lowercased, never
 * slugged and never used as a filesystem path or as an object key. Length and
 * control characters are the only local constraints; reserved object keys and
 * path traversal segments are refused because nothing upstream needs them and
 * everything downstream is safer without them.
 */
export const nativeIdentifierSchema = z
  .string()
  .min(1)
  .max(IDENTIFIER_LIMITS.nativeId)
  .regex(noControlCharacters, "Identifier contains control characters")
  .regex(noBidiControls, "Identifier contains bidirectional controls")
  .refine(notBlank, "Identifier is blank")
  .refine(
    (value) => !isReservedObjectKey(value),
    "Identifier is a reserved object key",
  )
  .refine((value) => !traversal.test(value), "Identifier looks like a path");
export type NativeIdentifier = z.infer<typeof nativeIdentifierSchema>;

/** Versions are opaque too: dates, hashes, "latest" and SemVer all appear upstream. */
export const nativeVersionSchema = z
  .string()
  .min(1)
  .max(IDENTIFIER_LIMITS.nativeVersion)
  .regex(noControlCharacters, "Version contains control characters")
  .regex(noBidiControls, "Version contains bidirectional controls")
  .refine(notBlank, "Version is blank")
  .refine(
    (value) => !isReservedObjectKey(value),
    "Version is a reserved object key",
  );
export type NativeVersion = z.infer<typeof nativeVersionSchema>;

/** Human-readable text that may be displayed or logged: bounded, no control characters. */
export const safeTextSchema = z
  .string()
  .max(IDENTIFIER_LIMITS.safeText)
  .regex(noControlCharactersOrEmpty, "Text contains control characters")
  .regex(noBidiControls, "Text contains bidirectional controls");

export const connectorSourceIdentitySchema = z.strictObject({
  ecosystem: ecosystemSchema,
  /** Registry namespace, broker environment, tenant or publisher; "" when the ecosystem has none. */
  authorityNamespace: z
    .string()
    .max(IDENTIFIER_LIMITS.authorityNamespace)
    .regex(noControlCharactersOrEmpty)
    .regex(noBidiControls),
  nativeId: nativeIdentifierSchema,
  nativeVersion: nativeVersionSchema,
});
export type ConnectorSourceIdentity = z.infer<
  typeof connectorSourceIdentitySchema
>;

/** Internal references are opaque, bounded and safe for persistence keys. */
export const connectorReferenceSchema = z
  .string()
  .regex(/^[a-zA-Z0-9][a-zA-Z0-9_.:@/-]{0,199}$/)
  .refine(
    (value) => !isReservedObjectKey(value),
    "Reference is a reserved object key",
  )
  .refine((value) => !traversal.test(value), "Reference looks like a path");
export type SourceRef = string;
export type DefinitionRef = string;
export type BindingRef = string;
export type ConnectionRef = string;
export type OperationRef = string;
export type EvidenceRef = string;
export type HandoffRef = string;

/**
 * Percent-encode one URL path segment the way RFC 3986 requires for a value
 * that may contain `/`, `@`, `:` or unreserved-but-special characters.
 * `encodeURIComponent` leaves `!'()*` alone; registries and brokers do not.
 * Encode exactly once at the boundary; never re-encode an encoded value.
 */
export function encodePathSegment(value: string): string {
  return encodeURIComponent(value).replace(
    /[!'()*]/g,
    (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`,
  );
}

const CANONICAL_DEPTH = 256;

function canonical(value: unknown, depth = 0): unknown {
  // Bounded parsers keep documents shallow; anything deeper is refused with a
  // clear error instead of a stack overflow inside a digest.
  if (depth > CANONICAL_DEPTH)
    throw new RangeError("Value is nested too deeply to canonicalize");
  if (Array.isArray(value)) return value.map((item) => canonical(item, depth + 1));
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([key, item]) => [key, canonical(item, depth + 1)]),
    );
  return value;
}

/** Stable JSON with sorted keys; the input to every content digest here. */
export function canonicalConnectorJson(value: unknown): string {
  return JSON.stringify(canonical(value));
}

async function sha256Hex(text: string): Promise<string> {
  const digest = await globalThis.crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(text),
  );
  return Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
}

/**
 * A digest of a source identity, for indexes and persistence keys whose
 * alphabet cannot carry the native spelling. It identifies the identity; the
 * native fields are stored beside it so lookup and round trips keep the
 * original spelling. A digest proves identity of bytes, never trust.
 */
export async function sourceIdentityDigest(
  identity: ConnectorSourceIdentity,
): Promise<string> {
  return sha256Hex(
    canonicalConnectorJson(connectorSourceIdentitySchema.parse(identity)),
  );
}

/** Canonical digest of a normalized document; distinct from the exact-byte source digest. */
export async function canonicalDigest(value: unknown): Promise<string> {
  return sha256Hex(canonicalConnectorJson(value));
}

export const sha256HexSchema = z.string().regex(/^[a-f0-9]{64}$/);
