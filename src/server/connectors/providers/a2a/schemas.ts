import { z } from "zod";
import { identifierSchema } from "../../../../core/operation-contracts.js";
import type { ConfigurationRequirement } from "../../adapter-types.js";

/*
 * A2A wire vocabulary, pinned per protocol profile.
 *
 * Two profiles are supported and never mixed. `a2a-1.0` is the current
 * published specification: Agent Cards declare `supportedInterfaces`, the
 * JSON-RPC binding uses PascalCase method names, enums are ProtoJSON
 * SCREAMING_SNAKE_CASE and a Part is discriminated by which member is
 * present. `a2a-0.3` is the previous published specification, still deployed
 * by peers: cards declare `url`/`preferredTransport`/`additionalInterfaces`,
 * methods are `category/action`, enums are lower-hyphen strings and a Part
 * carries an explicit `kind`. A card selects the profile; the adapter then
 * speaks exactly one of them.
 *
 * Sources (retrieved 2026-09-18):
 *  - https://a2a-protocol.org/latest/specification/  (version 1.0.0)
 *  - https://a2a-protocol.org/v0.3.0/specification/  (version 0.3.0)
 *
 * Everything in this file describes what an agent *says*. None of it is
 * authority: a card is a self-published manifest, and the host's runtime
 * binding decides which skills may be delegated, where requests may go and
 * what may come back.
 */

export const A2A_ADAPTER_ID = "a2a";
export const A2A_ADAPTER_VERSION = "1.0.0";

export const A2A_PROFILE_1_0 = "a2a-1.0";
export const A2A_PROFILE_0_3 = "a2a-0.3";
export const a2aProfiles = [A2A_PROFILE_1_0, A2A_PROFILE_0_3] as const;
export const a2aProfileSchema = z.enum(a2aProfiles);
export type A2aProfile = z.infer<typeof a2aProfileSchema>;

/** Protocol versions each profile answers for, as an interface may declare them. */
export const A2A_PROTOCOL_VERSIONS: Readonly<
  Record<A2aProfile, readonly string[]>
> = Object.freeze({
  [A2A_PROFILE_1_0]: ["1.0", "1.0.0"],
  [A2A_PROFILE_0_3]: ["0.3", "0.3.0"],
});

/** The one transport binding this adapter implements; the others are reported unsupported. */
export const A2A_SUPPORTED_BINDING = "JSONRPC";
export const A2A_WELL_KNOWN_CARD_PATH = "/.well-known/agent-card.json";
export const A2A_CARD_MEDIA_TYPE = "application/json";

export const A2A_LIMITS = Object.freeze({
  cardBytes: 512 * 1024,
  responseBytes: 1024 * 1024,
  deadlineMs: 30_000,
  skills: 256,
  interfaces: 16,
  securitySchemes: 32,
  parts: 64,
  artifacts: 64,
  textChars: 8192,
  promptChars: 2048,
  historyLength: 0,
  taskTtlMs: 24 * 60 * 60 * 1000,
  artifactBytes: 4 * 1024 * 1024,
});

export const A2A_CONFIGURATION_NAMES = Object.freeze({
  credential: "A2A_AGENT_CREDENTIAL",
});

export const A2A_CONFIGURATION: readonly ConfigurationRequirement[] =
  Object.freeze([
    {
      name: A2A_CONFIGURATION_NAMES.credential,
      source: "session-environment",
      classification: "secret",
      required: true,
      description:
        "Credential this deployment presents to the configured A2A agent. Never read by a model and never sent to any destination outside the binding.",
    } satisfies ConfigurationRequirement,
  ]);

/* ------------------------------------------------------------------ cards */

const noControl = /^[^\p{Cc}]*$/u;
const boundedText = (max: number) => z.string().max(max).regex(noControl);
const requiredText = (max: number) =>
  z.string().min(1).max(max).regex(noControl);
/** A declared URL. Not parsed into a destination here: declared is not approved. */
const declaredUrl = z
  .string()
  .min(1)
  .max(2048)
  .regex(/^[^\p{Cc}\s]+$/u);

const modeList = z.array(boundedText(120)).max(32);

/**
 * A skill, in both profiles. 1.0 renamed a skill's `security` to
 * `securityRequirements`; both are read and neither grants anything.
 */
const agentSkillSchema = z.object({
  id: requiredText(256),
  name: requiredText(200),
  description: boundedText(4096).default(""),
  tags: z.array(boundedText(120)).max(32).default([]),
  examples: z.array(boundedText(1024)).max(32).optional(),
  inputModes: modeList.optional(),
  outputModes: modeList.optional(),
  security: z
    .array(z.record(boundedText(120), z.array(boundedText(200)).max(64)))
    .max(16)
    .optional(),
  securityRequirements: z
    .array(z.record(boundedText(120), z.array(boundedText(200)).max(64)))
    .max(16)
    .optional(),
});
export type A2aAgentSkill = z.infer<typeof agentSkillSchema>;

const agentCapabilitiesSchema = z.object({
  streaming: z.boolean().optional(),
  pushNotifications: z.boolean().optional(),
  extendedAgentCard: z.boolean().optional(),
  extensions: z
    .array(
      z.object({
        uri: declaredUrl.optional(),
        description: boundedText(1024).optional(),
        required: z.boolean().optional(),
      }),
    )
    .max(32)
    .optional(),
});

const agentProviderSchema = z.object({
  url: declaredUrl.optional(),
  organization: boundedText(200).optional(),
  /** 0.3 spelled the organization `name`. */
  name: boundedText(200).optional(),
});

const agentInterfaceSchema = z.object({
  url: declaredUrl,
  protocolBinding: boundedText(200).optional(),
  /** 0.3 spelled the binding `transport` on AgentInterface. */
  transport: boundedText(200).optional(),
  protocolVersion: boundedText(64).optional(),
  tenant: boundedText(200).optional(),
});

const agentCardSignatureSchema = z.object({
  protected: boundedText(8192),
  signature: boundedText(8192),
  header: z.record(boundedText(120), z.unknown()).optional(),
});

const securitySchemeSchema = z.object({
  /** 0.3 / OpenAPI spelling. */
  type: boundedText(64).optional(),
  scheme: boundedText(64).optional(),
  bearerFormat: boundedText(64).optional(),
  name: boundedText(120).optional(),
  in: boundedText(32).optional(),
  location: boundedText(32).optional(),
  openIdConnectUrl: declaredUrl.optional(),
  description: boundedText(1024).optional(),
  flows: z.record(boundedText(64), z.unknown()).optional(),
  /** 1.0 wraps each scheme in a one-of member. */
  apiKeySecurityScheme: z.unknown().optional(),
  httpAuthSecurityScheme: z.unknown().optional(),
  oauth2SecurityScheme: z.unknown().optional(),
  openIdConnectSecurityScheme: z.unknown().optional(),
  mtlsSecurityScheme: z.unknown().optional(),
});

const cardCommon = {
  name: requiredText(200),
  description: boundedText(4096).default(""),
  version: requiredText(128),
  documentationUrl: declaredUrl.optional(),
  iconUrl: declaredUrl.optional(),
  provider: agentProviderSchema.optional(),
  capabilities: agentCapabilitiesSchema.default({}),
  securitySchemes: z.record(boundedText(120), securitySchemeSchema).optional(),
  defaultInputModes: modeList.default([]),
  defaultOutputModes: modeList.default([]),
  skills: z.array(agentSkillSchema).max(A2A_LIMITS.skills).default([]),
  signatures: z.array(agentCardSignatureSchema).max(8).optional(),
};

/** 1.0: interfaces are the only endpoint declaration, first entry preferred. */
export const agentCard10Schema = z.object({
  ...cardCommon,
  supportedInterfaces: z
    .array(agentInterfaceSchema)
    .min(1)
    .max(A2A_LIMITS.interfaces),
  securityRequirements: z
    .array(z.record(boundedText(120), z.array(boundedText(200)).max(64)))
    .max(16)
    .optional(),
});

/** 0.3: a main `url` plus `preferredTransport`, with optional extra interfaces. */
export const agentCard03Schema = z.object({
  ...cardCommon,
  protocolVersion: boundedText(64).default("0.3.0"),
  url: declaredUrl,
  preferredTransport: boundedText(200).optional(),
  additionalInterfaces: z
    .array(agentInterfaceSchema)
    .max(A2A_LIMITS.interfaces)
    .optional(),
  security: z
    .array(z.record(boundedText(120), z.array(boundedText(200)).max(64)))
    .max(16)
    .optional(),
  supportsAuthenticatedExtendedCard: z.boolean().optional(),
});

export type A2aCard10 = z.infer<typeof agentCard10Schema>;
export type A2aCard03 = z.infer<typeof agentCard03Schema>;

export type A2aInterfaceView = {
  url: string;
  binding: string;
  protocolVersion: string;
  tenant?: string;
  preferred: boolean;
};

/** One shape for both card profiles, so the importer has a single code path. */
export type A2aCardView = {
  profile: A2aProfile;
  name: string;
  description: string;
  version: string;
  protocolVersion: string;
  interfaces: A2aInterfaceView[];
  capabilities: z.infer<typeof agentCapabilitiesSchema>;
  securitySchemes: Record<string, z.infer<typeof securitySchemeSchema>>;
  securityRequirements: Array<Record<string, string[]>>;
  skills: A2aAgentSkill[];
  defaultInputModes: string[];
  defaultOutputModes: string[];
  provider?: { organization?: string; url?: string };
  documentationUrl?: string;
  iconUrl?: string;
  signatures: number;
  extendedCard: boolean;
};

/**
 * Chooses the profile from the card's own shape rather than from a caller's
 * assertion. `supportedInterfaces` exists only in 1.0; a top-level `url` with
 * no interface list is 0.3. A card with neither is not an Agent Card.
 */
export function detectCardProfile(value: unknown): A2aProfile | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value))
    return undefined;
  const card = value as Record<string, unknown>;
  if (Array.isArray(card.supportedInterfaces)) return A2A_PROFILE_1_0;
  if (typeof card.url === "string") return A2A_PROFILE_0_3;
  return undefined;
}

function normalizeRequirements(
  value: Array<Record<string, string[]>> | undefined,
): Array<Record<string, string[]>> {
  return (value ?? []).map((entry) =>
    Object.fromEntries(
      Object.entries(entry).map(([key, scopes]) => [key, [...scopes]]),
    ),
  );
}

/** Reads a parsed card into the common view; throws a Zod error on a card it cannot read. */
export function readAgentCard(
  profile: A2aProfile,
  value: unknown,
): A2aCardView {
  if (profile === A2A_PROFILE_1_0) {
    const card = agentCard10Schema.parse(value);
    const interfaces = card.supportedInterfaces.map((entry, index) => ({
      url: entry.url,
      binding: entry.protocolBinding ?? entry.transport ?? "JSONRPC",
      protocolVersion: entry.protocolVersion ?? "1.0",
      ...(entry.tenant === undefined ? {} : { tenant: entry.tenant }),
      preferred: index === 0,
    }));
    return {
      profile,
      name: card.name,
      description: card.description,
      version: card.version,
      protocolVersion: interfaces[0]?.protocolVersion ?? "1.0",
      interfaces,
      capabilities: card.capabilities,
      securitySchemes: card.securitySchemes ?? {},
      securityRequirements: normalizeRequirements(card.securityRequirements),
      skills: card.skills,
      defaultInputModes: card.defaultInputModes,
      defaultOutputModes: card.defaultOutputModes,
      ...(card.provider
        ? {
            provider: {
              ...((card.provider.organization ?? card.provider.name)
                ? {
                    organization: (card.provider.organization ??
                      card.provider.name) as string,
                  }
                : {}),
              ...(card.provider.url ? { url: card.provider.url } : {}),
            },
          }
        : {}),
      ...(card.documentationUrl
        ? { documentationUrl: card.documentationUrl }
        : {}),
      ...(card.iconUrl ? { iconUrl: card.iconUrl } : {}),
      signatures: card.signatures?.length ?? 0,
      extendedCard: card.capabilities.extendedAgentCard === true,
    };
  }
  const card = agentCard03Schema.parse(value);
  const main: A2aInterfaceView = {
    url: card.url,
    binding: card.preferredTransport ?? "JSONRPC",
    protocolVersion: card.protocolVersion,
    preferred: true,
  };
  const extra = (card.additionalInterfaces ?? [])
    .filter(
      (entry) =>
        entry.url !== main.url ||
        (entry.transport ?? entry.protocolBinding ?? "JSONRPC") !==
          main.binding,
    )
    .map((entry) => ({
      url: entry.url,
      binding: entry.transport ?? entry.protocolBinding ?? "JSONRPC",
      protocolVersion: entry.protocolVersion ?? card.protocolVersion,
      ...(entry.tenant === undefined ? {} : { tenant: entry.tenant }),
      preferred: false,
    }));
  return {
    profile,
    name: card.name,
    description: card.description,
    version: card.version,
    protocolVersion: card.protocolVersion,
    interfaces: [main, ...extra],
    capabilities: card.capabilities,
    securitySchemes: card.securitySchemes ?? {},
    securityRequirements: normalizeRequirements(card.security),
    skills: card.skills,
    defaultInputModes: card.defaultInputModes,
    defaultOutputModes: card.defaultOutputModes,
    ...(card.provider
      ? {
          provider: {
            ...((card.provider.organization ?? card.provider.name)
              ? {
                  organization: (card.provider.organization ??
                    card.provider.name) as string,
                }
              : {}),
            ...(card.provider.url ? { url: card.provider.url } : {}),
          },
        }
      : {}),
    ...(card.documentationUrl
      ? { documentationUrl: card.documentationUrl }
      : {}),
    ...(card.iconUrl ? { iconUrl: card.iconUrl } : {}),
    signatures: card.signatures?.length ?? 0,
    extendedCard:
      card.supportsAuthenticatedExtendedCard === true ||
      card.capabilities.extendedAgentCard === true,
  };
}

/* ------------------------------------------------------------------ tasks */

export const a2aTaskStates = [
  "submitted",
  "working",
  "input-required",
  "auth-required",
  "completed",
  "failed",
  "canceled",
  "rejected",
  "unknown",
] as const;
export type A2aTaskState = (typeof a2aTaskStates)[number];

export const a2aTerminalStates: readonly A2aTaskState[] = Object.freeze([
  "completed",
  "failed",
  "canceled",
  "rejected",
]);
export const a2aInterruptedStates: readonly A2aTaskState[] = Object.freeze([
  "input-required",
  "auth-required",
]);

/** ProtoJSON (1.0) enum names; 0.3 already uses the normalized spelling. */
const protoTaskStates: Readonly<Record<string, A2aTaskState>> = Object.freeze({
  TASK_STATE_UNSPECIFIED: "unknown",
  TASK_STATE_SUBMITTED: "submitted",
  TASK_STATE_WORKING: "working",
  TASK_STATE_COMPLETED: "completed",
  TASK_STATE_FAILED: "failed",
  TASK_STATE_CANCELED: "canceled",
  /** 0.3's proto spelled it with two Ls; both map to the same state. */
  TASK_STATE_CANCELLED: "canceled",
  TASK_STATE_INPUT_REQUIRED: "input-required",
  TASK_STATE_REJECTED: "rejected",
  TASK_STATE_AUTH_REQUIRED: "auth-required",
});

export function readTaskState(
  profile: A2aProfile,
  value: unknown,
): A2aTaskState {
  if (typeof value !== "string") return "unknown";
  if (profile === A2A_PROFILE_1_0) return protoTaskStates[value] ?? "unknown";
  return (a2aTaskStates as readonly string[]).includes(value)
    ? (value as A2aTaskState)
    : (protoTaskStates[value] ?? "unknown");
}

export type A2aPartView =
  | { kind: "text"; text: string }
  | { kind: "data"; data: unknown }
  | { kind: "file-url"; url: string; mediaType?: string; filename?: string }
  | {
      kind: "file-bytes";
      byteLength: number;
      mediaType?: string;
      filename?: string;
    }
  | { kind: "unsupported" };

export type A2aArtifactView = {
  artifactId: string;
  name?: string;
  description?: string;
  parts: A2aPartView[];
};

export type A2aTaskView = {
  id: string;
  contextId?: string;
  state: A2aTaskState;
  /** Parts of the status message, if the agent attached one. */
  statusParts: A2aPartView[];
  artifacts: A2aArtifactView[];
  timestamp?: string;
};

const rawPartSchema = z.object({
  kind: z.string().max(32).optional(),
  text: z
    .string()
    .max(A2A_LIMITS.textChars * 8)
    .optional(),
  data: z.unknown().optional(),
  raw: z.string().max(A2A_LIMITS.artifactBytes).optional(),
  url: z.string().max(2048).optional(),
  filename: z.string().max(256).optional(),
  mediaType: z.string().max(200).optional(),
  file: z
    .object({
      name: z.string().max(256).optional(),
      mimeType: z.string().max(200).optional(),
      bytes: z.string().max(A2A_LIMITS.artifactBytes).optional(),
      uri: z.string().max(2048).optional(),
    })
    .optional(),
});

function readPart(profile: A2aProfile, value: unknown): A2aPartView {
  const parsed = rawPartSchema.safeParse(value);
  if (!parsed.success) return { kind: "unsupported" };
  const part = parsed.data;
  if (profile === A2A_PROFILE_0_3) {
    if (part.kind === "text" && typeof part.text === "string")
      return { kind: "text", text: part.text };
    if (part.kind === "data" && part.data !== undefined)
      return { kind: "data", data: part.data };
    if (part.kind === "file" && part.file) {
      const meta = {
        ...(part.file.mimeType ? { mediaType: part.file.mimeType } : {}),
        ...(part.file.name ? { filename: part.file.name } : {}),
      };
      if (typeof part.file.uri === "string")
        return { kind: "file-url", url: part.file.uri, ...meta };
      if (typeof part.file.bytes === "string")
        return {
          kind: "file-bytes",
          byteLength: part.file.bytes.length,
          ...meta,
        };
    }
    return { kind: "unsupported" };
  }
  const meta = {
    ...(part.mediaType ? { mediaType: part.mediaType } : {}),
    ...(part.filename ? { filename: part.filename } : {}),
  };
  if (typeof part.text === "string") return { kind: "text", text: part.text };
  if (typeof part.url === "string")
    return { kind: "file-url", url: part.url, ...meta };
  if (typeof part.raw === "string")
    return { kind: "file-bytes", byteLength: part.raw.length, ...meta };
  if (part.data !== undefined) return { kind: "data", data: part.data };
  return { kind: "unsupported" };
}

const rawTaskSchema = z.object({
  id: z.string().min(1).max(512),
  contextId: z.string().max(512).optional(),
  status: z
    .object({
      state: z.unknown().optional(),
      message: z
        .object({
          parts: z.array(z.unknown()).max(A2A_LIMITS.parts).optional(),
        })
        .optional(),
      timestamp: z.string().max(64).optional(),
    })
    .optional(),
  artifacts: z
    .array(
      z.object({
        artifactId: z.string().max(512).optional(),
        name: z.string().max(200).optional(),
        description: z.string().max(1024).optional(),
        parts: z.array(z.unknown()).max(A2A_LIMITS.parts).default([]),
      }),
    )
    .max(A2A_LIMITS.artifacts)
    .optional(),
});

/** Reads an agent's Task object into the common view; unknown members are dropped, never executed. */
export function readTask(profile: A2aProfile, value: unknown): A2aTaskView {
  const task = rawTaskSchema.parse(value);
  return {
    id: task.id,
    ...(task.contextId ? { contextId: task.contextId } : {}),
    state: readTaskState(profile, task.status?.state),
    statusParts: (task.status?.message?.parts ?? []).map((part) =>
      readPart(profile, part),
    ),
    artifacts: (task.artifacts ?? []).map((artifact, index) => ({
      artifactId: artifact.artifactId ?? `artifact-${index}`,
      ...(artifact.name ? { name: artifact.name } : {}),
      ...(artifact.description ? { description: artifact.description } : {}),
      parts: artifact.parts.map((part) => readPart(profile, part)),
    })),
    ...(task.status?.timestamp ? { timestamp: task.status.timestamp } : {}),
  };
}

/* --------------------------------------------------------------- bindings */

const configurationNameSchema = z.string().regex(/^[A-Z][A-Z0-9_]{0,95}$/);

/**
 * What a host approved for one A2A agent. The skill list is the whole of what
 * may be delegated: a card that advertises more skills does not widen it, and
 * a skill removed from the binding stops being delegable even though the
 * agent still advertises it.
 */
export const approvedSkillSchema = z.strictObject({
  skillId: z.string().min(1).max(256).regex(noControl),
  operationRef: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_.:@/-]{0,199}$/),
  /** Ceiling on the text a caller may send to this skill. */
  maxInputChars: z
    .number()
    .int()
    .min(1)
    .max(A2A_LIMITS.textChars)
    .default(2048),
  acceptedOutputModes: z
    .array(boundedText(120))
    .max(16)
    .default(["text/plain"]),
  /** What of the agent's own words may reach the caller. */
  outputPolicy: z.enum(["text", "data", "none"]).default("text"),
  /** Artifacts are always described; "descriptor-only" never inlines their content. */
  artifactPolicy: z
    .enum(["descriptor-only", "inline-text"])
    .default("descriptor-only"),
});
export type ApprovedSkill = z.infer<typeof approvedSkillSchema>;

export const a2aBindingSettingsSchema = z.strictObject({
  agent: z.strictObject({
    /** The card's `name`, pinned at review; a card that renames itself is a drift signal. */
    name: z.string().min(1).max(200).regex(noControl),
    cardVersion: z.string().min(1).max(128).regex(noControl),
    profile: a2aProfileSchema,
    protocolVersion: z.string().min(1).max(64).regex(noControl),
    /** Destination id of the agent's JSON-RPC interface. */
    destinationId: identifierSchema,
    /** Absolute path of the interface under that destination. */
    rpcPath: z
      .string()
      .min(1)
      .max(1024)
      .regex(/^\/[^\p{Cc}?#]*$/u),
    /** Opaque routing value the selected interface declared; sent verbatim when set. */
    tenant: z.string().max(200).regex(noControl).optional(),
  }),
  security: z.discriminatedUnion("kind", [
    z.strictObject({
      kind: z.literal("http-bearer"),
      configurationName: configurationNameSchema,
    }),
    z.strictObject({
      kind: z.literal("api-key"),
      configurationName: configurationNameSchema,
      headerName: z
        .string()
        .min(1)
        .max(120)
        .regex(/^[A-Za-z0-9-]+$/),
    }),
    z.strictObject({ kind: z.literal("none") }),
  ]),
  approvedSkills: z.array(approvedSkillSchema).max(64),
  deadlineMs: z
    .number()
    .int()
    .min(100)
    .max(120_000)
    .default(A2A_LIMITS.deadlineMs),
  maxResponseBytes: z
    .number()
    .int()
    .min(1024)
    .max(A2A_LIMITS.responseBytes)
    .default(A2A_LIMITS.responseBytes),
  taskTtlMs: z
    .number()
    .int()
    .min(60_000)
    .max(A2A_LIMITS.taskTtlMs)
    .default(A2A_LIMITS.taskTtlMs),
  /** History is not requested by default: another principal's turns are not this caller's business. */
  historyLength: z.number().int().min(0).max(64).default(0),
  /** Non-blocking sends are the default so a delegation cannot hold a request open. */
  returnImmediately: z.boolean().default(true),
  /**
   * Artifact retrieval is off unless a host turned it on and pinned a
   * destination for it. Even then a caller must approve each retrieval; the
   * adapter never follows an artifact URL on its own.
   */
  artifactRetrieval: z
    .strictObject({
      enabled: z.boolean().default(false),
      destinationId: identifierSchema.optional(),
      maxBytes: z
        .number()
        .int()
        .min(1024)
        .max(A2A_LIMITS.artifactBytes)
        .default(A2A_LIMITS.artifactBytes),
    })
    .default({ enabled: false, maxBytes: A2A_LIMITS.artifactBytes }),
});
export type A2aBindingSettings = z.infer<typeof a2aBindingSettingsSchema>;

/* ----------------------------------------------------------- error codes */

/**
 * A2A JSON-RPC error codes, identical in both profiles for -32001..-32006.
 * 1.0 added -32008/-32009 and renamed -32007. Numbers are the contract; the
 * upstream message is never surfaced.
 */
export const a2aErrorCodes: Readonly<Record<number, string>> = Object.freeze({
  [-32700]: "parse",
  [-32600]: "invalid-request",
  [-32601]: "method-not-found",
  [-32602]: "invalid-params",
  [-32603]: "internal",
  [-32001]: "task-not-found",
  [-32002]: "task-not-cancelable",
  [-32003]: "push-notification-not-supported",
  [-32004]: "unsupported-operation",
  [-32005]: "content-type-not-supported",
  [-32006]: "invalid-agent-response",
  [-32007]: "extended-card-not-configured",
  [-32008]: "extension-support-required",
  [-32009]: "version-not-supported",
});

export const jsonRpcMethods: Readonly<
  Record<
    A2aProfile,
    Readonly<Record<"send" | "get" | "cancel" | "extendedCard", string>>
  >
> = Object.freeze({
  [A2A_PROFILE_1_0]: {
    send: "SendMessage",
    get: "GetTask",
    cancel: "CancelTask",
    extendedCard: "GetExtendedAgentCard",
  },
  [A2A_PROFILE_0_3]: {
    send: "message/send",
    get: "tasks/get",
    cancel: "tasks/cancel",
    extendedCard: "agent/authenticatedExtendedCard",
  },
});
