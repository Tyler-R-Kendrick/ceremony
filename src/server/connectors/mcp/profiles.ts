import { z } from "zod";
import {
  nativeIdentifierSchema,
  sha256HexSchema,
} from "../../../core/connectors/index.js";

/*
 * MCP protocol profiles. Two eras of the Model Context Protocol are spoken
 * here and they are never mixed on one wire:
 *
 * - the current revision 2026-07-28 ("modern"): no session, no initialize
 *   handshake, protocol version and client capabilities travel in every
 *   request's `_meta`, `server/discover` advertises the server, server-to-
 *   client interaction is a multi round-trip `input_required` result, and
 *   change notifications come from a POST `subscriptions/listen` stream;
 * - the legacy revisions 2025-11-25 and 2025-06-18: an `initialize` handshake
 *   negotiates one version, `Mcp-Session-Id` carries a server session,
 *   `MCP-Protocol-Version` is echoed on later requests, the server may send
 *   JSON-RPC requests (elicitation, sampling, roots, ping) on a POST response
 *   stream, and a standalone GET stream may exist.
 *
 * A binding pins one profile in its settings. Which profile was actually used
 * is recorded on every discovery so a deployment cannot silently drift.
 */

export const mcpProfileIds = ["2026-07-28", "2025-11-25", "2025-06-18"] as const;
export type McpProfileId = (typeof mcpProfileIds)[number];
export type McpEra = "modern" | "legacy";

export const CURRENT_PROFILE: McpProfileId = "2026-07-28";
/** The newest legacy revision; used when era auto-detection falls back. */
export const NEWEST_LEGACY_PROFILE: McpProfileId = "2025-11-25";

/** Reserved `_meta` keys of the 2026-07-28 per-request envelope (basic/index#meta). */
export const META_KEYS = {
  protocolVersion: "io.modelcontextprotocol/protocolVersion",
  clientInfo: "io.modelcontextprotocol/clientInfo",
  clientCapabilities: "io.modelcontextprotocol/clientCapabilities",
  serverInfo: "io.modelcontextprotocol/serverInfo",
  subscriptionId: "io.modelcontextprotocol/subscriptionId",
  logLevel: "io.modelcontextprotocol/logLevel",
  progressToken: "progressToken",
} as const;

/** HTTP header names, lower-case; HTTP field names are case-insensitive. */
export const HEADER_NAMES = {
  protocolVersion: "mcp-protocol-version",
  method: "mcp-method",
  name: "mcp-name",
  paramPrefix: "mcp-param-",
  sessionId: "mcp-session-id",
  lastEventId: "last-event-id",
} as const;

/** Error codes reserved by the 2026-07-28 specification (basic/index#error-codes). */
export const MODERN_ERROR_CODES = {
  headerMismatch: -32020,
  missingRequiredClientCapability: -32021,
  unsupportedProtocolVersion: -32022,
} as const;

export const JSON_RPC_ERROR_CODES = {
  parse: -32700,
  invalidRequest: -32600,
  methodNotFound: -32601,
  invalidParams: -32602,
  internal: -32603,
  /** Resource not found before 2026-07-28; clients still accept it. */
  legacyResourceNotFound: -32002,
  /** URL elicitation required, 2025-11-25 only. */
  legacyUrlElicitationRequired: -32042,
} as const;

export type ClientRegistrationMethod =
  | "pre-registered"
  | "client-id-metadata-document"
  | "dynamic";

export type McpProfile = {
  readonly id: McpProfileId;
  readonly era: McpEra;
  /** Specification revision this profile is implemented from, as pinned in the ledger. */
  readonly specificationRevision: string;
  readonly handshake: "none" | "initialize";
  readonly discovery: "server/discover" | "initialize";
  readonly sessions: "none" | "mcp-session-id";
  /** How the server asks for more input mid-request. */
  readonly serverInteraction: "input_required" | "server-requests";
  readonly notificationStream: "subscriptions/listen" | "http-get";
  readonly cancellation: "close-stream" | "notifications/cancelled";
  readonly resumableStreams: boolean;
  /** Whether requests carry the modern `_meta` envelope and mirrored headers. */
  readonly requestEnvelope: "meta-and-headers" | "session-headers";
  /**
   * Client registration mechanisms the revision's authorization section
   * documents, in its stated priority order. The newest revision prefers
   * Client ID Metadata Documents and keeps Dynamic Client Registration as a
   * deprecated fallback; 2025-06-18 documents Dynamic Client Registration.
   * The adapter reports this per profile instead of advertising universal
   * current behaviour (AC-AUTH-18).
   */
  readonly clientRegistration: readonly ClientRegistrationMethod[];
  readonly dynamicClientRegistration: "documented" | "deprecated";
  /** Versions a server may answer with under `negotiate` without leaving this profile's era. */
  readonly negotiableVersions: readonly string[];
};

export const mcpProfiles: Readonly<Record<McpProfileId, McpProfile>> = {
  "2026-07-28": {
    id: "2026-07-28",
    era: "modern",
    specificationRevision: "2026-07-28",
    handshake: "none",
    discovery: "server/discover",
    sessions: "none",
    serverInteraction: "input_required",
    notificationStream: "subscriptions/listen",
    cancellation: "close-stream",
    resumableStreams: false,
    requestEnvelope: "meta-and-headers",
    clientRegistration: [
      "pre-registered",
      "client-id-metadata-document",
      "dynamic",
    ],
    dynamicClientRegistration: "deprecated",
    negotiableVersions: ["2026-07-28"],
  },
  "2025-11-25": {
    id: "2025-11-25",
    era: "legacy",
    specificationRevision: "2025-11-25",
    handshake: "initialize",
    discovery: "initialize",
    sessions: "mcp-session-id",
    serverInteraction: "server-requests",
    notificationStream: "http-get",
    cancellation: "notifications/cancelled",
    resumableStreams: true,
    requestEnvelope: "session-headers",
    clientRegistration: [
      "pre-registered",
      "client-id-metadata-document",
      "dynamic",
    ],
    dynamicClientRegistration: "documented",
    negotiableVersions: ["2025-11-25", "2025-06-18"],
  },
  "2025-06-18": {
    id: "2025-06-18",
    era: "legacy",
    specificationRevision: "2025-06-18",
    handshake: "initialize",
    discovery: "initialize",
    sessions: "mcp-session-id",
    serverInteraction: "server-requests",
    notificationStream: "http-get",
    cancellation: "notifications/cancelled",
    resumableStreams: true,
    requestEnvelope: "session-headers",
    clientRegistration: ["pre-registered", "dynamic"],
    dynamicClientRegistration: "documented",
    negotiableVersions: ["2025-06-18", "2025-11-25"],
  },
};

export function profileFor(id: McpProfileId): McpProfile {
  return mcpProfiles[id];
}

export function isProfileId(value: string): value is McpProfileId {
  return (mcpProfileIds as readonly string[]).includes(value);
}

/** Capability profile label used in `CapabilityStatus.profile` rows. */
export function capabilityProfileLabel(id: McpProfileId): string {
  return `mcp-${id}`;
}

/**
 * How strictly the configured profile is enforced.
 * - `pinned`: the wire speaks exactly the configured revision; a server of the
 *   other era or another revision is refused, never accommodated.
 * - `negotiate`: the server may select another revision of the same era from
 *   the profile's negotiable list; the choice is recorded.
 * - `auto-detect`: additionally, a server of the other era is detected through
 *   the documented transport mechanics and the client switches era once,
 *   recording which profile was actually used.
 */
export const mcpCompatibilityModes = ["pinned", "negotiate", "auto-detect"] as const;
export type McpCompatibilityMode = (typeof mcpCompatibilityModes)[number];

export type McpLimits = {
  /** Whole-response bound for JSON bodies and for any single SSE frame. */
  maxResponseBytes: number;
  /** Total bytes accepted on one SSE response stream. */
  maxStreamBytes: number;
  /** Frames accepted on one SSE response stream before it is abandoned. */
  maxStreamFrames: number;
  requestTimeoutMs: number;
  /** Notification stream bounds (`subscriptions/listen` or legacy GET). */
  listenMaxMs: number;
  listenMaxEvents: number;
  maxListPages: number;
  maxListItems: number;
  maxCursorLength: number;
  maxContentBlocks: number;
  maxTextBytes: number;
  maxStructuredBytes: number;
  maxJsonDepth: number;
  /** Protected transient material bound for one handoff record. */
  maxHandoffPrivateBytes: number;
  maxRequestStateBytes: number;
  /** Input rounds one command may go through before it is refused. */
  maxInputRounds: number;
  /** Bounded transport retries for read-only operations only. */
  readRetries: number;
  cacheMaxTtlMs: number;
  cacheMaxEntries: number;
};

export const defaultMcpLimits: Readonly<McpLimits> = Object.freeze({
  maxResponseBytes: 1024 * 1024,
  maxStreamBytes: 2 * 1024 * 1024,
  maxStreamFrames: 256,
  requestTimeoutMs: 30_000,
  listenMaxMs: 10_000,
  listenMaxEvents: 32,
  maxListPages: 8,
  maxListItems: 512,
  maxCursorLength: 4096,
  maxContentBlocks: 64,
  maxTextBytes: 64 * 1024,
  maxStructuredBytes: 256 * 1024,
  maxJsonDepth: 32,
  maxHandoffPrivateBytes: 16 * 1024,
  maxRequestStateBytes: 8 * 1024,
  maxInputRounds: 3,
  readRetries: 2,
  cacheMaxTtlMs: 5 * 60_000,
  cacheMaxEntries: 256,
});

const positiveInt = z.number().int().positive();
export const mcpLimitsSchema = z
  .strictObject({
    maxResponseBytes: positiveInt.max(16 * 1024 * 1024),
    maxStreamBytes: positiveInt.max(64 * 1024 * 1024),
    maxStreamFrames: positiveInt.max(4096),
    requestTimeoutMs: positiveInt.max(300_000),
    listenMaxMs: positiveInt.max(3_600_000),
    listenMaxEvents: positiveInt.max(4096),
    maxListPages: positiveInt.max(64),
    maxListItems: positiveInt.max(4096),
    maxCursorLength: positiveInt.max(16 * 1024),
    maxContentBlocks: positiveInt.max(1024),
    maxTextBytes: positiveInt.max(4 * 1024 * 1024),
    maxStructuredBytes: positiveInt.max(4 * 1024 * 1024),
    maxJsonDepth: positiveInt.max(128),
    maxHandoffPrivateBytes: positiveInt.max(64 * 1024),
    maxRequestStateBytes: positiveInt.max(64 * 1024),
    maxInputRounds: positiveInt.max(8),
    readRetries: z.number().int().min(0).max(5),
    cacheMaxTtlMs: z.number().int().min(0).max(24 * 3_600_000),
    cacheMaxEntries: positiveInt.max(4096),
  })
  .partial();

export type McpLimitsInput = z.infer<typeof mcpLimitsSchema>;

export function resolveLimits(partial?: McpLimitsInput): McpLimits {
  const checked = partial ? mcpLimitsSchema.parse(partial) : {};
  const merged: McpLimits = { ...defaultMcpLimits };
  for (const [key, value] of Object.entries(checked))
    if (value !== undefined) (merged as Record<string, number>)[key] = value;
  return merged;
}

/**
 * Host-approved, inert binding settings under `RuntimeBinding.settings.mcp`.
 * They pin the profile and the endpoint path; nothing here is caller-supplied
 * and nothing here is a secret.
 */
export const mcpBindingSettingsSchema = z.strictObject({
  profile: z.enum(mcpProfileIds),
  compatibility: z.enum(mcpCompatibilityModes).default("pinned"),
  /** Path of the MCP endpoint under the approved destination origin. */
  endpointPath: z
    .string()
    .max(512)
    .regex(/^\/(?!\/)[^\p{Cc}?#]*$/u)
    .default("/mcp"),
  /** How requests are authenticated: a bearer in host custody, a broker-vended bearer, or nothing. */
  auth: z.enum(["bearer", "broker", "none"]).default("bearer"),
  /**
   * Name of a private configuration value holding a static bearer token that
   * the host places in custody on first authorization (no OAuth involved).
   */
  bearerConfiguration: z
    .string()
    .regex(/^[A-Z][A-Z0-9_]{0,95}$/)
    .optional(),
  clientInfo: z
    .strictObject({
      name: z
        .string()
        .min(1)
        .max(120)
        .regex(/^[^\p{Cc}]+$/u),
      version: z
        .string()
        .min(1)
        .max(64)
        .regex(/^[^\p{Cc}]+$/u),
    })
    .optional(),
  /** Canonical RFC 8707 resource identifier when it differs from origin + endpoint path. */
  resource: z
    .string()
    .max(2048)
    .refine((value) => {
      if (!URL.canParse(value)) return false;
      const url = new URL(value);
      return !url.username && !url.password && !url.hash && !url.search;
    })
    .optional(),
  /**
   * Reviewed tool definitions by canonical digest. When present, a tool whose
   * live definition differs from the reviewed digest is refused until it is
   * reviewed again: a remote tool can change behind a stable name.
   */
  pinnedTools: z
    .record(nativeIdentifierSchema, sha256HexSchema)
    .refine((value) => Object.keys(value).length <= 512)
    .optional(),
  limits: mcpLimitsSchema.optional(),
});
export type McpBindingSettings = z.infer<typeof mcpBindingSettingsSchema>;

export function parseMcpBindingSettings(settings: unknown): McpBindingSettings {
  return mcpBindingSettingsSchema.parse(settings);
}
