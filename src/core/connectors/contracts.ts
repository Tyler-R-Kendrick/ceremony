import { z } from "zod";
import { identifierSchema } from "../operation-contracts.js";
import { fieldClassificationSchema } from "../operation-contracts.js";
import {
  connectorReferenceSchema,
  connectorSourceIdentitySchema,
  credentialCustodySchema,
  ecosystemSchema,
  evidenceLevelSchema,
  mappingDispositionSchema,
  nativeIdentifierSchema,
  nativeVersionSchema,
  ownerKindSchema,
  runtimeClassSchema,
  safeTextSchema,
  sha256HexSchema,
  supportDimensionSchema,
} from "./identity.js";

/*
 * Every record here is a description of something, never the thing itself:
 * a source record describes bytes it does not contain, a definition describes
 * capabilities it cannot execute, a binding references a server-approved
 * runtime it does not embed, and a claim describes an observation it cannot
 * repeat. That separation is the point. An imported description is not an
 * approved runtime binding; an approved binding is not a grant; a grant is not
 * proof of every advertised capability; and a successful transport response is
 * not proof of the intended identity or of the absence of an earlier effect.
 */

const isoTime = z.iso.datetime({ offset: true });
const boundedList = <T extends z.ZodType>(item: T, max: number) =>
  z.array(item).max(max);
const dottedCode = z
  .string()
  .regex(/^[a-z][a-z0-9]*(?:[.-][a-z0-9]+){0,11}$/)
  .max(120);
/** A JSON pointer, JSONPath-ish location, or file:line spelling; opaque and bounded. */
const pointerSchema = z
  .string()
  .max(1024)
  .regex(/^[^\p{Cc}]*$/u);

export const compatibilityCategories = [
  "structure",
  "security",
  "serialization",
  "schema",
  "network",
  "policy",
  "identity",
  "version",
  "executable-code",
  "license",
] as const;
export const compatibilityCategorySchema = z.enum(compatibilityCategories);
export const compatibilitySeveritySchema = z.enum([
  "info",
  "warning",
  "blocking",
]);
export const executionImpacts = [
  "none",
  "blocks-operation",
  "blocks-authorization",
  "blocks-definition",
] as const;
export const executionImpactSchema = z.enum(executionImpacts);

/**
 * A structured import diagnostic. `message` and `remediation` are written for
 * a person and must never echo a credential or an arbitrary source fragment;
 * the pointer says where, the code says what.
 */
export const compatibilityIssueSchema = z
  .strictObject({
    code: dottedCode,
    category: compatibilityCategorySchema,
    sourcePointer: pointerSchema,
    normalizedPointer: pointerSchema.optional(),
    dimension: supportDimensionSchema,
    disposition: mappingDispositionSchema,
    severity: compatibilitySeveritySchema,
    executionImpact: executionImpactSchema,
    message: safeTextSchema.min(1),
    remediation: safeTextSchema.optional(),
  })
  .superRefine((issue, ctx) => {
    // An unknown or unsupported security requirement cannot be talked down to
    // an informational note: it decides whether an operation may execute.
    if (
      issue.category === "security" &&
      (issue.disposition === "unsupported" ||
        issue.disposition === "rejected") &&
      issue.severity !== "blocking"
    )
      ctx.addIssue({
        code: "custom",
        message: "Unsupported security requirements are blocking",
      });
    if (issue.severity === "blocking" && issue.executionImpact === "none")
      ctx.addIssue({
        code: "custom",
        message: "A blocking issue must name what it blocks",
      });
    if (
      (issue.disposition === "exact" || issue.disposition === "adapted") &&
      issue.severity === "blocking"
    )
      ctx.addIssue({
        code: "custom",
        message: "A mapped construct cannot also be blocking",
      });
  });
export type CompatibilityIssue = z.infer<typeof compatibilityIssueSchema>;

export const capabilityStatusSchema = z
  .strictObject({
    dimension: supportDimensionSchema,
    /** Protocol/profile identifier such as "openapi-3.1" or "mcp-2026-07-28". */
    profile: z
      .string()
      .min(1)
      .max(120)
      .regex(/^[^\p{Cc}]+$/u),
    adapterVersion: nativeVersionSchema,
    runtime: runtimeClassSchema,
    implementation: z.enum(["implemented", "unsupported"]),
    configuration: z.enum(["ready", "missing", "not-applicable"]),
    evidence: evidenceLevelSchema,
    evidenceRef: connectorReferenceSchema.optional(),
    limitations: boundedList(safeTextSchema, 32),
  })
  .superRefine((status, ctx) => {
    if (
      status.implementation === "unsupported" &&
      status.evidence !== "not-tested"
    )
      ctx.addIssue({
        code: "custom",
        message: "An unsupported dimension has no passing evidence",
      });
    if (status.evidenceRef && status.evidence === "not-tested")
      ctx.addIssue({
        code: "custom",
        message: "Evidence reference requires an evidence level",
      });
  });
export type CapabilityStatus = z.infer<typeof capabilityStatusSchema>;

export const verificationClaimKinds = [
  "credential-accepted",
  "account-identity",
  "resource-access",
  "ownership-claimed",
  "permission-observed",
] as const;
export const verificationClaimKindSchema = z.enum(verificationClaimKinds);
export const claimIssuerSchema = z.enum([
  "provider",
  "external-broker",
  "host-policy",
  "ceremony-verifier",
]);

/** A named target of evidence: the thing that was actually observed. */
export const evidenceTargetSchema = z.strictObject({
  kind: z
    .string()
    .min(1)
    .max(64)
    .regex(/^[a-z][a-z0-9-]*$/),
  /** Display identity of the target (account login, project ref, repository); never a secret. */
  id: nativeIdentifierSchema,
});

/**
 * One narrow observation. It says what was checked, against which target,
 * when, by which verifier version, and what it does not establish. Requested,
 * provider-reported and observed permissions are kept apart because a broker
 * that ignores a downscoping request still reports the wider grant, and an
 * empty list means unknown under most protocols, not unlimited.
 */
export const verificationClaimSchema = z
  .strictObject({
    kind: verificationClaimKindSchema,
    evidenceRef: connectorReferenceSchema,
    issuer: claimIssuerSchema,
    target: evidenceTargetSchema,
    observedAt: isoTime,
    validUntil: isoTime.optional(),
    verifierVersion: nativeVersionSchema,
    bindingRevision: z.number().int().nonnegative(),
    policyRevision: z.string().min(1).max(200),
    permissions: z
      .strictObject({
        requested: boundedList(z.string().min(1).max(200), 64),
        reported: boundedList(z.string().min(1).max(200), 64),
        observed: boundedList(z.string().min(1).max(200), 64),
        semantics: z.enum(["provider-scopes", "operations", "unknown"]),
      })
      .optional(),
    limitations: boundedList(safeTextSchema, 16),
  })
  .superRefine((claim, ctx) => {
    if (claim.validUntil && claim.validUntil <= claim.observedAt)
      ctx.addIssue({
        code: "custom",
        message: "Evidence validity ends after it was observed",
      });
  });
export type VerificationClaim = z.infer<typeof verificationClaimSchema>;

export const connectionLifecycles = [
  "configuration-required",
  "authorization-required",
  "human-required",
  "verifying",
  "active",
  "degraded",
  "expired",
  "reconnect-required",
  "locally-disconnected",
  "upstream-revoked",
  "indeterminate",
] as const;
export const connectionLifecycleSchema = z.enum(connectionLifecycles);
export type ConnectionLifecycle = z.infer<typeof connectionLifecycleSchema>;

/** Configuration a deployment or session must hold; names only, never values. */
export const configurationRequirementSchema = z.strictObject({
  name: z.string().regex(/^[A-Z][A-Z0-9_]{0,95}$/),
  source: z.enum(["session-environment", "host", "provider-console"]),
  classification: z.enum(["public", "personal", "secret"]),
  required: z.boolean(),
  description: safeTextSchema.optional(),
});
export type ConfigurationRequirement = z.infer<
  typeof configurationRequirementSchema
>;

const httpsOrLoopbackUrl = z.url().refine((value) => {
  const url = new URL(value);
  return (
    !url.username &&
    !url.password &&
    !url.hash &&
    (url.protocol === "https:" ||
      (url.protocol === "http:" &&
        ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)))
  );
}, "Endpoints must be HTTPS or loopback HTTP without credentials");
const scopeList = boundedList(z.string().min(1).max(200), 64);
const profileBase = {
  id: identifierSchema,
  label: safeTextSchema.min(1).max(100),
};

/**
 * Authentication as a description. Endpoints listed here are *declared* by the
 * source and are candidates until a server-approved binding pins them; a
 * profile is never itself permission to contact anything. `none` is an explicit
 * public/no-credential profile, and `unsupported` preserves a description the
 * runtime cannot execute rather than inventing a login method for it.
 */
export const authenticationProfileSchema = z.discriminatedUnion("kind", [
  z.strictObject({
    ...profileBase,
    kind: z.literal("oauth-authorization-code"),
    pkce: z.enum(["S256", "plain", "none", "unknown"]),
    issuer: httpsOrLoopbackUrl.optional(),
    authorizationEndpoint: httpsOrLoopbackUrl.optional(),
    tokenEndpoint: httpsOrLoopbackUrl.optional(),
    scopes: scopeList,
    scopeSemantics: z.enum(["provider-scopes", "unknown"]),
    clientRegistration: z.enum([
      "pre-registered",
      "dynamic",
      "client-id-metadata-document",
      "unknown",
    ]),
    clientAuthentication: z.enum([
      "none",
      "client_secret_basic",
      "client_secret_post",
      "private_key_jwt",
      "unknown",
    ]),
    refresh: z.enum(["supported", "unsupported", "unknown"]),
    resourceIndicator: httpsOrLoopbackUrl.optional(),
  }),
  z.strictObject({
    ...profileBase,
    kind: z.literal("oauth-client-credentials"),
    tokenEndpoint: httpsOrLoopbackUrl.optional(),
    scopes: scopeList,
    clientAuthentication: z.enum([
      "client_secret_basic",
      "client_secret_post",
      "private_key_jwt",
      "unknown",
    ]),
  }),
  z.strictObject({
    ...profileBase,
    kind: z.literal("oauth-device"),
    deviceAuthorizationEndpoint: httpsOrLoopbackUrl.optional(),
    tokenEndpoint: httpsOrLoopbackUrl.optional(),
    scopes: scopeList,
  }),
  z.strictObject({
    ...profileBase,
    kind: z.literal("api-key"),
    placement: z.enum(["header", "query", "cookie"]),
    parameterName: z
      .string()
      .min(1)
      .max(120)
      .regex(/^[^\p{Cc}\s]+$/u),
  }),
  z.strictObject({ ...profileBase, kind: z.literal("http-basic") }),
  z.strictObject({
    ...profileBase,
    kind: z.literal("http-bearer"),
    format: z.string().max(64).optional(),
  }),
  z.strictObject({
    ...profileBase,
    kind: z.literal("openid-connect"),
    issuer: httpsOrLoopbackUrl,
    scopes: scopeList,
  }),
  z.strictObject({ ...profileBase, kind: z.literal("mutual-tls") }),
  z.strictObject({
    ...profileBase,
    kind: z.literal("signature"),
    scheme: z.string().min(1).max(64),
  }),
  z.strictObject({
    ...profileBase,
    kind: z.literal("external-broker"),
    broker: ecosystemSchema,
    custody: z.enum([
      "external-credential-broker",
      "external-execution-broker",
    ]),
  }),
  z.strictObject({
    ...profileBase,
    kind: z.literal("none"),
    reason: z.enum(["public", "anonymous"]),
  }),
  z.strictObject({
    ...profileBase,
    /** A method of an unchanged v1 Ceremony manifest, executed by the existing runtime. */
    kind: z.literal("ceremony-method"),
    flowKind: z.enum([
      "api-key",
      "basic",
      "form",
      "oauth-code",
      "device",
      "authmd-anonymous",
      "github-app",
      "account-registration",
    ]),
    methodId: z.string().regex(/^[a-z0-9-]{1,64}$/),
  }),
  z.strictObject({
    ...profileBase,
    kind: z.literal("unsupported"),
    /** The native scheme name, preserved verbatim for review; nothing executable. */
    native: z
      .string()
      .min(1)
      .max(120)
      .regex(/^[^\p{Cc}]+$/u),
  }),
]);
export type AuthenticationProfile = z.infer<typeof authenticationProfileSchema>;

export const capabilityKinds = [
  "http-operation",
  "mcp-tool",
  "mcp-resource",
  "mcp-prompt",
  "event",
  "a2a-skill",
  "sync",
  "action",
  "query",
  "entity",
  "custom",
] as const;
export const capabilityKindSchema = z.enum(capabilityKinds);

/** Inert extension data preserved from a source; bounded and namespaced, never evaluated. */
export const nativeExtensionsSchema = z
  .record(
    z
      .string()
      .min(1)
      .max(120)
      .regex(/^[^\p{Cc}]+$/u),
    z.unknown(),
  )
  .refine((value) => Object.keys(value).length <= 64)
  .refine(
    (value) =>
      !["__proto__", "prototype", "constructor"].some((key) =>
        Object.hasOwn(value, key),
      ),
  );

/**
 * One capability a definition describes. Effect, data classification and cost
 * are *declared* facts about the source, defaulting to unknown; the host's
 * registered operation policy decides consent and output handling.
 */
export const nativeCapabilitySchema = z.strictObject({
  kind: capabilityKindSchema,
  nativeId: nativeIdentifierSchema,
  label: safeTextSchema.min(1).max(200).optional(),
  summary: safeTextSchema.optional(),
  effect: z.enum(["read", "write", "unknown"]),
  dataClassification: z.enum(["public", "personal", "secret", "unknown"]),
  cost: z.enum(["free", "metered", "unknown"]),
  /** Authentication profile ids this capability requires; [] means declared anonymous. */
  authentication: boundedList(identifierSchema, 16).optional(),
  inputSchemaRef: pointerSchema.optional(),
  outputSchemaRef: pointerSchema.optional(),
  nativeExtensions: nativeExtensionsSchema.optional(),
});
export type NativeCapability = z.infer<typeof nativeCapabilitySchema>;

export const sourceFormatSchema = z.strictObject({
  name: z
    .string()
    .min(1)
    .max(64)
    .regex(/^[a-z][a-z0-9-]*$/),
  version: nativeVersionSchema,
  /** Schema dialect or sub-profile, when the format has one (OpenAPI 3.1 JSON Schema 2020-12). */
  dialect: z.string().max(120).optional(),
});

export const sourceOriginSchema = z.strictObject({
  kind: z.enum([
    "upload",
    "url",
    "registry",
    "provider-api",
    "builtin-fixture",
    "host-configuration",
  ]),
  /** Origin and path only; never a URL carrying userinfo, query tokens or fragments. */
  location: z
    .string()
    .max(2048)
    .refine((value) => {
      if (!value) return true;
      if (!URL.canParse(value)) return false;
      const url = new URL(value);
      return !url.username && !url.password && !url.search && !url.hash;
    })
    .optional(),
});

export const adaptationStepSchema = z.strictObject({
  step: z.string().min(1).max(120),
  version: nativeVersionSchema,
  inputDigest: sha256HexSchema,
  outputDigest: sha256HexSchema,
});

/**
 * Provenance of captured bytes. The bytes themselves live in a protected,
 * tenant-scoped artifact referenced by `artifactRef`; that reference must never
 * survive a public projection. The exact-byte digest and the canonical digest
 * of the normalized document are different facts and are stored separately.
 */
export const sourceRecordSchema = z.strictObject({
  sourceRef: connectorReferenceSchema,
  identity: connectorSourceIdentitySchema,
  format: sourceFormatSchema,
  origin: sourceOriginSchema,
  digest: z.strictObject({
    algorithm: z.literal("sha256"),
    value: sha256HexSchema,
  }),
  byteLength: z
    .number()
    .int()
    .nonnegative()
    .max(64 * 1024 * 1024),
  mediaType: z
    .string()
    .max(120)
    .regex(/^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/i),
  capturedAt: isoTime,
  license: z
    .strictObject({
      spdx: z.string().max(64).optional(),
      note: safeTextSchema.optional(),
      redistributable: z.union([z.boolean(), z.literal("unknown")]),
    })
    .optional(),
  artifactRef: connectorReferenceSchema.optional(),
  adaptation: boundedList(adaptationStepSchema, 16),
  /** Overlays applied after capture, by exact digest; provenance, not approval. */
  overlays: boundedList(
    z.strictObject({
      sourceRef: connectorReferenceSchema,
      digest: sha256HexSchema,
    }),
    8,
  ),
});
export type SourceRecord = z.infer<typeof sourceRecordSchema>;

export const declaredServerSchema = z.strictObject({
  url: z
    .string()
    .max(2048)
    .regex(/^[^\p{Cc}]+$/u),
  description: safeTextSchema.optional(),
  /** Declared, not approved. A binding decides what may be contacted. */
  status: z.literal("declared"),
});

export const eventDescriptorSchema = z.strictObject({
  nativeId: nativeIdentifierSchema,
  label: safeTextSchema.max(200).optional(),
  transport: z.enum(["http-webhook", "unsupported"]),
  /** Native binding name (kafka, amqp, mqtt, ws ...) preserved when unsupported. */
  nativeTransport: z.string().max(64).optional(),
  verification: z.enum(["standard-webhooks", "vendor", "none", "unknown"]),
  messageSchemaRef: pointerSchema.optional(),
});
export type EventDescriptor = z.infer<typeof eventDescriptorSchema>;

export const DEFINITION_LIMITS = Object.freeze({
  capabilities: 4096,
  events: 512,
  authentication: 32,
  configuration: 48,
  issues: 4096,
  bytes: 4 * 1024 * 1024,
});

/**
 * The normalized, non-executable description of a connector. It carries no
 * runnable code, no grant material and no approved destination. Anything an
 * adapter needs to actually reach a service lives in a server-side binding.
 */
export const normalizedDefinitionShape = {
  schemaVersion: z.literal(1),
  definitionRef: connectorReferenceSchema,
  identity: connectorSourceIdentitySchema,
  sourceRef: connectorReferenceSchema,
  normalizedDigest: sha256HexSchema,
  importer: z.strictObject({
    id: z.string().min(1).max(120),
    version: nativeVersionSchema,
  }),
  display: z.strictObject({
    name: safeTextSchema.min(1).max(200),
    description: safeTextSchema.max(500),
    ecosystem: ecosystemSchema,
    /** Logical service grouping key for discovery ("github", "slack"); grouping never merges grants. */
    service: z
      .string()
      .max(120)
      .regex(/^[a-z0-9][a-z0-9._-]*$/)
      .optional(),
  }),
  authentication: boundedList(
    authenticationProfileSchema,
    DEFINITION_LIMITS.authentication,
  ),
  configuration: boundedList(
    configurationRequirementSchema,
    DEFINITION_LIMITS.configuration,
  ),
  capabilities: boundedList(
    nativeCapabilitySchema,
    DEFINITION_LIMITS.capabilities,
  ),
  events: boundedList(eventDescriptorSchema, DEFINITION_LIMITS.events),
  declaredServers: boundedList(declaredServerSchema, 32),
  compatibility: z.strictObject({
    issues: boundedList(compatibilityIssueSchema, DEFINITION_LIMITS.issues),
    /** Dimensions this description alone can support once bound; import never enables invoke. */
    dimensions: z.record(supportDimensionSchema, mappingDispositionSchema),
  }),
  nativeExtensions: nativeExtensionsSchema,
};

/** Cross-field rules shared by the stored and the portable definition shapes. */
export function refineNormalizedDefinition(
  definition: {
    authentication: AuthenticationProfile[];
    capabilities: NativeCapability[];
    configuration: ConfigurationRequirement[];
  },
  ctx: z.RefinementCtx,
): void {
  const ids = definition.authentication.map((profile) => profile.id);
  if (new Set(ids).size !== ids.length)
    ctx.addIssue({ code: "custom", message: "Duplicate authentication id" });
  const known = new Set(ids);
  for (const capability of definition.capabilities)
    for (const id of capability.authentication ?? [])
      if (!known.has(id))
        ctx.addIssue({
          code: "custom",
          message: "Capability references an unknown authentication profile",
        });
  const names = definition.configuration.map((item) => item.name);
  if (new Set(names).size !== names.length)
    ctx.addIssue({ code: "custom", message: "Duplicate configuration name" });
}

/**
 * The normalized, non-executable description of a connector. It carries no
 * runnable code, no grant material and no approved destination. Anything an
 * adapter needs to actually reach a service lives in a server-side binding.
 */
export const normalizedDefinitionSchema = z
  .strictObject(normalizedDefinitionShape)
  .superRefine(refineNormalizedDefinition);
export type NormalizedDefinition = z.infer<typeof normalizedDefinitionSchema>;

export const connectorImportResultSchema = z.strictObject({
  sourceRef: connectorReferenceSchema,
  definitions: boundedList(connectorReferenceSchema, 64),
  issues: boundedList(compatibilityIssueSchema, DEFINITION_LIMITS.issues),
  /** Candidates a reviewer may bind; import registers nothing executable. */
  executableCandidates: boundedList(
    nativeIdentifierSchema,
    DEFINITION_LIMITS.capabilities,
  ),
});
export type ConnectorImportResult = z.infer<typeof connectorImportResultSchema>;

/**
 * A public reference to a server-approved runtime binding. The binding itself
 * (destinations, handlers, credential authority, output policy) is server
 * state; only its identity, revision and custody are ever projected.
 */
export const bindingReferenceSchema = z.strictObject({
  bindingRef: connectorReferenceSchema,
  definitionRef: connectorReferenceSchema,
  revision: z.number().int().nonnegative(),
  adapterId: z
    .string()
    .min(1)
    .max(120)
    .regex(/^[a-z][a-z0-9-]*$/),
  adapterVersion: nativeVersionSchema,
  runtime: runtimeClassSchema,
  custody: credentialCustodySchema,
  /** Issuer, broker environment or provider region this binding is tied to; display form. */
  authorityInstance: z
    .string()
    .max(256)
    .regex(/^[^\p{Cc}]*$/u),
  status: z.enum(["approved", "suspended", "retired"]),
  approvedAt: isoTime,
  policyRevision: z.string().min(1).max(200),
});
export type BindingReference = z.infer<typeof bindingReferenceSchema>;

export const handoffKinds = [
  "provider-browser",
  "connect-widget",
  "device-code",
  "private-collector",
  "input-required",
] as const;
export const handoffKindSchema = z.enum(handoffKinds);
export const handoffStates = [
  "issued",
  "waiting",
  "completed",
  "denied",
  "expired",
  "cancelled",
  "superseded",
] as const;
export const handoffStateSchema = z.enum(handoffStates);

/** Public shape of a handoff; the destination URL, token or code is private. */
export const connectorHandoffSummarySchema = z.strictObject({
  handoffRef: connectorReferenceSchema,
  kind: handoffKindSchema,
  state: handoffStateSchema,
  presentation: z.enum(["same-window", "popup", "second-device", "in-app"]),
  expiresAt: isoTime,
  /** Connection generation this handoff belongs to; stale completions are refused. */
  generation: z.number().int().nonnegative(),
});
export type ConnectorHandoffSummary = z.infer<
  typeof connectorHandoffSummarySchema
>;

export const connectionSummarySchema = z.strictObject({
  connectionRef: connectorReferenceSchema,
  bindingRef: connectorReferenceSchema,
  definitionRef: connectorReferenceSchema,
  ecosystem: ecosystemSchema,
  service: z.string().max(120),
  displayName: safeTextSchema.min(1).max(200),
  ownerKind: ownerKindSchema,
  custody: credentialCustodySchema,
  runtime: runtimeClassSchema,
  lifecycle: connectionLifecycleSchema,
  generation: z.number().int().nonnegative(),
  revision: z.number().int().nonnegative(),
  /** The exact verified target, when verification established one. */
  target: evidenceTargetSchema.optional(),
  verification: z
    .strictObject({
      kinds: boundedList(verificationClaimKindSchema, 8),
      observedAt: isoTime,
      validUntil: isoTime.optional(),
      limitations: boundedList(safeTextSchema, 16),
    })
    .optional(),
  handoff: connectorHandoffSummarySchema.optional(),
  /** Sanitized last outcome code, never a provider message. */
  lastOutcome: dottedCode.optional(),
  createdAt: isoTime,
  updatedAt: isoTime,
});
export type ConnectionSummary = z.infer<typeof connectionSummarySchema>;

export const supportLevels = [
  "provider-backed",
  "fixture",
  "unconfigured",
  "catalog-only",
] as const;
export const supportLevelSchema = z.enum(supportLevels);

/**
 * One row of the public directory. It is built by the server from registered
 * adapters and their measured evidence; the browser never composes it from a
 * static list, and it carries no destination, configuration value or secret.
 */
export const catalogEntrySchema = z.strictObject({
  id: z
    .string()
    .min(1)
    .max(160)
    .regex(/^[a-z0-9][a-z0-9._:-]*$/),
  ecosystem: ecosystemSchema,
  service: z
    .string()
    .max(120)
    .regex(/^[a-z0-9][a-z0-9._-]*$/),
  displayName: safeTextSchema.min(1).max(200),
  description: safeTextSchema.max(500),
  support: supportLevelSchema,
  custody: boundedList(credentialCustodySchema, 5),
  runtimes: boundedList(runtimeClassSchema, 3),
  authentication: boundedList(
    z.enum(
      authenticationProfileSchema.options.map(
        (option) => option.shape.kind.value,
      ) as [AuthenticationProfile["kind"], ...AuthenticationProfile["kind"][]],
    ),
    16,
  ),
  configuration: boundedList(
    z.strictObject({
      name: z.string().regex(/^[A-Z][A-Z0-9_]{0,95}$/),
      required: z.boolean(),
      classification: z.enum(["public", "personal", "secret"]),
      present: z.boolean(),
    }),
    48,
  ),
  capabilities: boundedList(capabilityStatusSchema, 64),
  /** Strongest evidence across dimensions; individual dimensions keep their own. */
  evidence: evidenceLevelSchema,
  /** Alternatives for the same logical service are grouped by this key, never merged. */
  group: z
    .string()
    .max(120)
    .regex(/^[a-z0-9][a-z0-9._-]*$/),
  definitionRef: connectorReferenceSchema.optional(),
});
export type CatalogEntry = z.infer<typeof catalogEntrySchema>;

export const connectorAuditEventSchema = z.strictObject({
  schemaVersion: z.literal(1),
  at: isoTime,
  actorKind: z.enum(["human", "agent", "system"]),
  action: dottedCode,
  connectionRef: connectorReferenceSchema.optional(),
  bindingRef: connectorReferenceSchema.optional(),
  outcome: z.enum([
    "applied",
    "denied",
    "failed",
    "indeterminate",
    "reconciled",
  ]),
  code: dottedCode.optional(),
  generation: z.number().int().nonnegative().optional(),
});
export type ConnectorAuditEvent = z.infer<typeof connectorAuditEventSchema>;

/** Field classification vocabulary re-exported for connector policy tables. */
export const connectorFieldClassificationSchema = fieldClassificationSchema;
