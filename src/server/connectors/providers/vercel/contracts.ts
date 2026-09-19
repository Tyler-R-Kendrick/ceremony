import { z } from "zod";
import {
  identifierSchema,
  measureJsonValue,
  nativeIdentifierSchema,
} from "../../../../core/index.js";
import type { RuntimeBinding } from "../../binding.js";
import { ConnectorError } from "../../errors.js";

/*
 * The Vercel Connect wire contract, written down from the published sources
 * and nothing else: the REST reference pages, the OpenAPI document served at
 * https://openapi.vercel.sh (retrieved 2026-09-18) and, where the REST
 * documentation is silent, the published `@vercel/connect` 2.3.0 SDK. Every
 * operation carries its own version prefix; nothing here guesses a newer or
 * older version for an operation the documentation does not list.
 *
 * Source profile: `vercel-connect-rest-2026-09`.
 */

export const VERCEL_SOURCE_PROFILE = "vercel-connect-rest-2026-09";
export const VERCEL_API_ORIGIN = "https://api.vercel.com";
export const VERCEL_OIDC_ISSUER = "https://oidc.vercel.com";
export const VERCEL_OIDC_JWKS_PATH = "/.well-known/jwks";
/** The redirect URL a Connect *provider* must accept (docs/connect/providers). */
export const VERCEL_CONNECT_PROVIDER_REDIRECT_URI =
  "https://connect.vercel.com/callback";

export const vercelConfigurationNames = {
  teamId: "VERCEL_TEAM_ID",
  teamSlug: "VERCEL_TEAM_SLUG",
  managementToken: "VERCEL_MANAGEMENT_TOKEN",
  workloadToken: "VERCEL_CONNECT_WORKLOAD_TOKEN",
} as const;

export const vercelDestinationIds = { api: "api", oidc: "oidc" } as const;

export type VercelCredentialRole = "management" | "workload";

export type VercelOperation = {
  readonly method: "GET" | "POST" | "PATCH" | "DELETE";
  readonly version: "v1" | "v2";
  readonly pathTemplate: string;
  /** Which credential authenticates the call; the two are never interchangeable. */
  readonly credential: VercelCredentialRole;
  readonly effect: "read" | "write";
  /** Administrative operations need the host's admin policy, not just a connection. */
  readonly admin: boolean;
  /** Whether the documented `teamId` query parameter scopes the call. */
  readonly teamQuery: boolean;
  readonly replay: "read-only" | "reconciliation" | "none";
  readonly provenance: "rest-openapi" | "sdk-observed";
  readonly summary: string;
};

/**
 * The verified operation inventory. Each entry is bound to the exact version
 * the documentation lists for that operation; a binding whose transport
 * disagrees with this table is refused rather than trusted.
 */
export const vercelConnectOperationTable = {
  "connect.connectors.list": {
    method: "GET",
    version: "v2",
    pathTemplate: "/v2/connect/connectors",
    credential: "management",
    effect: "read",
    admin: false,
    teamQuery: true,
    replay: "read-only",
    provenance: "rest-openapi",
    summary: "List connectors",
  },
  "connect.connectors.get": {
    method: "GET",
    version: "v1",
    pathTemplate: "/v1/connect/connectors/{connector}",
    credential: "management",
    effect: "read",
    admin: false,
    teamQuery: true,
    replay: "read-only",
    provenance: "rest-openapi",
    summary: "Get a connector",
  },
  "connect.connectors.create": {
    method: "POST",
    version: "v1",
    pathTemplate: "/v1/connect/connectors",
    credential: "management",
    effect: "write",
    admin: true,
    teamQuery: true,
    replay: "none",
    provenance: "rest-openapi",
    summary: "Create a connector",
  },
  "connect.connectors.update": {
    method: "PATCH",
    version: "v2",
    pathTemplate: "/v2/connect/connectors/{connector}",
    credential: "management",
    effect: "write",
    admin: true,
    teamQuery: true,
    replay: "none",
    provenance: "rest-openapi",
    summary: "Update a connector",
  },
  "connect.connectors.delete": {
    method: "DELETE",
    version: "v1",
    pathTemplate: "/v1/connect/connectors/{connector}",
    credential: "management",
    effect: "write",
    admin: true,
    teamQuery: true,
    replay: "reconciliation",
    provenance: "rest-openapi",
    summary: "Delete a connector",
  },
  "connect.projects.link": {
    method: "POST",
    version: "v1",
    pathTemplate: "/v1/connect/connectors/{connector}/projects/{projectId}",
    credential: "management",
    effect: "write",
    admin: true,
    teamQuery: true,
    replay: "reconciliation",
    provenance: "rest-openapi",
    summary: "Create or update a connector project connection",
  },
  "connect.projects.get": {
    method: "GET",
    version: "v1",
    pathTemplate: "/v1/connect/connectors/{connector}/projects/{projectId}",
    credential: "management",
    effect: "read",
    admin: false,
    teamQuery: true,
    replay: "read-only",
    provenance: "rest-openapi",
    summary: "Get a connector project connection",
  },
  "connect.projects.unlink": {
    method: "DELETE",
    version: "v1",
    pathTemplate: "/v1/connect/connectors/{connector}/projects/{projectId}",
    credential: "management",
    effect: "write",
    admin: true,
    teamQuery: true,
    replay: "reconciliation",
    provenance: "rest-openapi",
    summary: "Disconnect a connector from a project",
  },
  "connect.projects.connectors": {
    method: "GET",
    version: "v2",
    pathTemplate: "/v2/connect/projects/{projectId}/connectors",
    credential: "management",
    effect: "read",
    admin: false,
    teamQuery: true,
    replay: "read-only",
    provenance: "rest-openapi",
    summary: "List connectors for a project",
  },
  "connect.connectors.projects": {
    method: "GET",
    version: "v2",
    pathTemplate: "/v2/connect/connectors/{connector}/projects",
    credential: "management",
    effect: "read",
    admin: false,
    teamQuery: true,
    replay: "read-only",
    provenance: "rest-openapi",
    summary: "List projects for a connector",
  },
  "connect.authorize": {
    method: "POST",
    version: "v1",
    pathTemplate: "/v1/connect/authorize/{connector}",
    credential: "workload",
    effect: "write",
    admin: false,
    teamQuery: false,
    replay: "none",
    provenance: "rest-openapi",
    summary: "Create a Connect authorization request",
  },
  "connect.token": {
    method: "POST",
    version: "v1",
    pathTemplate: "/v1/connect/token/{connector}",
    credential: "workload",
    effect: "read",
    admin: false,
    teamQuery: false,
    replay: "none",
    provenance: "rest-openapi",
    summary: "Get a Connect token",
  },
  "connect.triggers.destinations.replace": {
    method: "PATCH",
    version: "v1",
    pathTemplate: "/v1/connect/connectors/{connector}/trigger-destinations",
    credential: "management",
    effect: "write",
    admin: true,
    teamQuery: true,
    replay: "reconciliation",
    provenance: "rest-openapi",
    summary: "Update connector trigger destinations",
  },
  /**
   * Not in the REST reference or OpenAPI document. `@vercel/connect` 2.3.0
   * `revokeToken` sends exactly this request; it is only used when a binding
   * opts in to the SDK-observed contract.
   */
  "connect.tokens.revoke": {
    method: "DELETE",
    version: "v1",
    pathTemplate: "/v1/connect/connectors/{connector}/tokens",
    credential: "workload",
    effect: "write",
    admin: false,
    teamQuery: false,
    replay: "none",
    provenance: "sdk-observed",
    summary: "Revoke the grant behind a connector subject (SDK-observed)",
  },
} as const satisfies Record<string, VercelOperation>;
export type VercelOperationId = keyof typeof vercelConnectOperationTable;
export const vercelOperationIds = Object.keys(
  vercelConnectOperationTable,
) as VercelOperationId[];

/** Management operations a host may bind for invocation; auth-leg operations stay internal. */
export const vercelManagementOperationIds = vercelOperationIds.filter(
  (id) => vercelConnectOperationTable[id].credential === "management",
);

export function vercelOperation(id: VercelOperationId): VercelOperation {
  return vercelConnectOperationTable[id];
}

/** Operation refs are stable, namespaced spellings of the table ids. */
export const vercelOperationRef = (id: VercelOperationId) => `vercel.${id}`;

// ---------------------------------------------------------------------------
// Wire schemas (responses). Types follow the documented JSON schemas, not the
// examples: the reference example renders `expiresAt` as the string "123"
// while the schema says number, and the schema wins.
// ---------------------------------------------------------------------------

const epochMs = z.number().int().min(0).max(8_640_000_000_000_000);
const shortString = z.string().min(1).max(512);
const boundedRecord = z
  .record(z.string().max(120), z.unknown())
  .refine((value) => measureJsonValue(value).ok, "Record exceeds JSON bounds");

export const connectSubjectSchema = z.discriminatedUnion("type", [
  z.strictObject({ type: z.literal("app") }),
  z.strictObject({
    type: z.literal("user"),
    id: shortString,
    issuer: z.string().max(2048).optional(),
  }),
  z.strictObject({
    type: z.literal("jwt-bearer"),
    sub: shortString,
    iss: z.string().max(2048).optional(),
    aud: z.string().max(2048).optional(),
    additionalClaims: boundedRecord.optional(),
  }),
]);
export type ConnectSubject = z.infer<typeof connectSubjectSchema>;
export type ConnectSubjectType = ConnectSubject["type"];

export const environmentSelectorSchema = z.union([
  z.enum(["development", "preview", "production"]),
  z.string().regex(/^env_[A-Za-z0-9_-]{1,120}$/),
]);
export type EnvironmentSelector = z.infer<typeof environmentSelectorSchema>;

export const triggerDestinationInputSchema = z.union([
  z.strictObject({
    projectId: nativeIdentifierSchema,
    path: z.string().min(1).max(2048).optional(),
  }),
  z.strictObject({
    projectId: nativeIdentifierSchema,
    branch: z.string().min(1).max(250),
    path: z.string().min(1).max(2048).optional(),
  }),
  z.strictObject({
    projectId: nativeIdentifierSchema,
    customEnvironmentId: z.string().regex(/^env_[A-Za-z0-9_-]{1,120}$/),
    path: z.string().min(1).max(2048).optional(),
  }),
]);
export type TriggerDestinationInput = z.infer<
  typeof triggerDestinationInputSchema
>;

export const connectErrorBodySchema = z.object({
  error: z.object({
    code: z.string().max(200),
    message: z.string().max(4096),
  }),
});

export const connectPaginationSchema = z.object({
  next: z.string().max(2048).nullable(),
});

export const connectTriggerDestinationSchema = z.object({
  projectId: z.string().min(1),
  path: z.string().optional(),
  branch: z.string().optional(),
  customEnvironmentId: z.string().optional(),
});

const tokenCapabilitiesSchema = z.object({
  crossInstallation: z.boolean(),
  supportsRefinement: z.boolean(),
  supportsResources: z.boolean().optional(),
  scopes: z.array(z.string()).optional(),
  supportedAuthorizationDetails: z.array(z.string()).optional(),
});

export const connectConnectorSchema = z.object({
  id: z.string().min(1),
  uid: z.string().min(1),
  name: z.string(),
  displayName: z.string(),
  type: z.string().min(1),
  typeName: z.string(),
  service: z.string(),
  supportedSubjectTypes: z.array(z.string()),
  supportsInstallation: z.boolean(),
  supportsRevocation: z.boolean(),
  supportsTriggers: z.boolean(),
  supportsIcon: z.union([z.boolean(), z.literal("maybe")]),
  createdAt: epochMs,
  updatedAt: epochMs,
  defaultInstallationId: z.string().optional(),
  clientUrl: z.string().nullable().optional(),
  connectionMethod: z.string().optional(),
  creationMode: z.enum(["managed", "manual"]).optional(),
  events: z.array(z.string()).optional(),
  triggers: z.object({ enabled: z.boolean() }).optional(),
  triggerDestinations: z.array(connectTriggerDestinationSchema).optional(),
  appTokens: tokenCapabilitiesSchema.optional(),
  userTokens: tokenCapabilitiesSchema
    .extend({ manualCredentialInput: z.boolean().optional() })
    .optional(),
  redirectUri: z.string().optional(),
  target: z.string().optional(),
});
export type ConnectConnector = z.infer<typeof connectConnectorSchema>;

export const connectConnectorListSchema = z.object({
  connectors: z.array(connectConnectorSchema).max(100),
  pagination: connectPaginationSchema,
});

export const connectProjectConnectionSchema = z.object({
  connectorId: z.string().min(1),
  createdAt: epochMs,
  updatedAt: epochMs,
  enabledEnvironments: z.array(z.string()).max(64),
  project: z.object({
    id: z.string().min(1),
    name: z.string(),
    customEnvironments: z
      .array(z.object({ id: z.string(), slug: z.string() }))
      .optional(),
  }),
});
export type ConnectProjectConnection = z.infer<
  typeof connectProjectConnectionSchema
>;

export const connectProjectConnectorListSchema = z.object({
  connectors: z.array(connectProjectConnectionSchema).max(100),
  pagination: connectPaginationSchema,
});
export const connectConnectorProjectListSchema = z.object({
  projects: z.array(connectProjectConnectionSchema).max(100),
  pagination: connectPaginationSchema,
});

export const connectConnectorUpdateResultSchema = z.object({
  connector: connectConnectorSchema,
  reconsentNeeded: z.object({ scope: z.literal("user") }).optional(),
  reinstallNeeded: z.boolean().optional(),
  serviceSync: z
    .object({
      status: z.enum(["done", "required"]),
      errors: z
        .array(
          z.object({
            message: z.string(),
            fields: z.array(z.string()).optional(),
          }),
        )
        .optional(),
    })
    .optional(),
});

export const connectAuthorizeResponseSchema = z.object({
  connector: z.object({
    displayName: z.string(),
    id: z.string().min(1),
    name: z.string(),
    service: z.string().optional(),
    serviceName: z.string().optional(),
    type: z.string().min(1),
    uid: z.string().min(1),
  }),
  deviceCode: z.string().min(1).max(64).optional(),
  expiresAt: epochMs,
  request: z.string().min(1).max(512),
  url: z.string().min(1).max(4096),
  verifier: z.string().min(1).max(4096),
});
export type ConnectAuthorizeResponse = z.infer<
  typeof connectAuthorizeResponseSchema
>;

export const connectTokenResponseSchema = z.object({
  token: z.string().min(1),
  tokenId: z.string().min(1).max(512),
  expiresAt: epochMs,
  connector: z.object({
    id: z.string().min(1),
    type: z.string().min(1),
    uid: z.string().min(1),
  }),
  name: z.string().optional(),
  installationId: z.string().optional(),
  tenantId: z.string().optional(),
  externalSubject: z.string().optional(),
  authorizationId: z.string().optional(),
  tokenGroupId: z.string().optional(),
  claims: boundedRecord.optional(),
  metadata: boundedRecord.optional(),
});
export type ConnectTokenResponse = z.infer<typeof connectTokenResponseSchema>;

// ---------------------------------------------------------------------------
// Invocation inputs (strict). A caller names an operation and validated
// arguments; team scope, credentials and transport come from the binding.
// ---------------------------------------------------------------------------

const pageInput = {
  limit: z.number().int().min(1).max(100).optional(),
  cursor: z.string().min(1).max(2048).optional(),
};
const hexColor = z.string().regex(/^#[0-9a-fA-F]{6}$/);
const iconDigest = z.string().regex(/^[0-9a-fA-F]{40}$/);

export const createConnectorBodySchema = z
  .strictObject({
    data: boundedRecord,
    type: z.string().min(1).max(64).optional(),
    service: z.string().min(1).max(256).optional(),
    connectionMethod: z.string().min(1).max(64).optional(),
    params: z
      .record(z.string().max(64), z.string().max(256))
      .refine((value) => Object.keys(value).length <= 16)
      .optional(),
    target: z.string().min(1).max(64).optional(),
    uid: z.string().min(1).max(200).optional(),
    name: z.string().min(1).max(200).optional(),
    projectId: nativeIdentifierSchema.optional(),
    environments: z.array(environmentSelectorSchema).min(1).max(32).optional(),
    triggers: z.boolean().optional(),
    triggerType: z.string().min(1).max(64).optional(),
    triggerData: boundedRecord.optional(),
    triggerDestination: triggerDestinationInputSchema.optional(),
    events: z.array(z.string().min(1).max(200)).max(64).optional(),
    icon: iconDigest.optional(),
    backgroundColor: hexColor.optional(),
    accentColor: hexColor.optional(),
  })
  .refine(
    (body) =>
      body.type !== undefined ||
      (body.service !== undefined && body.connectionMethod !== undefined),
    "Provide type, or service with connectionMethod",
  );

export const updateConnectorBodySchema = z
  .strictObject({
    triggers: z.boolean().optional(),
    events: z.array(z.string().min(1).max(200)).max(64).optional(),
    data: boundedRecord.optional(),
    icon: iconDigest.optional(),
    backgroundColor: hexColor.optional(),
    accentColor: hexColor.optional(),
    uid: z.string().min(1).max(200).optional(),
    name: z.string().min(1).max(200).optional(),
  })
  .refine((body) => Object.keys(body).length >= 1, "Nothing to update");

export const vercelInvokeInputSchemas = {
  "connect.connectors.list": z.strictObject({
    ...pageInput,
    projectId: nativeIdentifierSchema.optional(),
    search: z.string().max(100).optional(),
    type: z.string().max(200).optional(),
    service: z.string().max(200).optional(),
    sort: z.enum(["name", "createdAt", "updatedAt"]).optional(),
  }),
  "connect.connectors.get": z.strictObject({
    connector: nativeIdentifierSchema,
  }),
  "connect.connectors.create": z.strictObject({
    body: createConnectorBodySchema,
  }),
  "connect.connectors.update": z.strictObject({
    connector: nativeIdentifierSchema,
    body: updateConnectorBodySchema,
  }),
  "connect.connectors.delete": z.strictObject({
    connector: nativeIdentifierSchema,
    /** The exact set of other linked projects the administrator reviewed. */
    acknowledgeSharedWith: z.array(nativeIdentifierSchema).max(256).optional(),
  }),
  "connect.projects.link": z.strictObject({
    connector: nativeIdentifierSchema,
    projectId: nativeIdentifierSchema,
    environments: z.array(environmentSelectorSchema).min(1).max(32),
  }),
  "connect.projects.get": z.strictObject({
    connector: nativeIdentifierSchema,
    projectId: nativeIdentifierSchema,
  }),
  "connect.projects.unlink": z.strictObject({
    connector: nativeIdentifierSchema,
    projectId: nativeIdentifierSchema,
  }),
  "connect.projects.connectors": z.strictObject({
    projectId: nativeIdentifierSchema,
    ...pageInput,
  }),
  "connect.connectors.projects": z.strictObject({
    connector: nativeIdentifierSchema,
    ...pageInput,
  }),
  "connect.triggers.destinations.replace": z.strictObject({
    connector: nativeIdentifierSchema,
    destinations: z.array(triggerDestinationInputSchema).max(3),
  }),
} as const;
export type VercelManagementOperationId = keyof typeof vercelInvokeInputSchemas;

// ---------------------------------------------------------------------------
// Binding settings: everything an authorization or token request may name is
// approved here by the host. Callers pick a profile id; they never supply a
// subject, an installation, scopes, a callback or a webhook.
// ---------------------------------------------------------------------------

const absoluteUriWithoutFragment = z
  .string()
  .max(2048)
  .refine(
    (value) => URL.canParse(value) && !new URL(value).hash,
    "Resource indicators are absolute URIs without a fragment",
  );

export const vercelProfileSchema = z.strictObject({
  /** Connector UID (`slack/acme`) or stable id (`scl_…`), spelled as Vercel spells it. */
  connector: nativeIdentifierSchema,
  subject: z.discriminatedUnion("type", [
    z.strictObject({ type: z.literal("app") }),
    z.strictObject({
      type: z.literal("user"),
      /** How the authenticated host subject becomes the Connect user id. */
      identity: z.enum(["tenant-qualified-subject", "subject"]),
      issuer: z.string().url().max(2048).optional(),
    }),
    z.strictObject({
      type: z.literal("jwt-bearer"),
      sub: z.enum(["tenant-qualified-subject", "subject", "tenant"]),
      iss: z.string().max(2048).optional(),
      aud: z.string().max(2048).optional(),
      additionalClaims: z
        .record(
          z.string().max(120),
          z.union([z.string().max(512), z.number(), z.boolean()]),
        )
        .refine((value) => Object.keys(value).length <= 16)
        .optional(),
    }),
  ]),
  installation: z.discriminatedUnion("mode", [
    z.strictObject({ mode: z.literal("installation-free") }),
    z.strictObject({
      mode: z.literal("installation-aware"),
      /** Absent means the connector's default installation; `*` only when written here. */
      installationId: nativeIdentifierSchema.optional(),
    }),
  ]),
  scopes: z.array(z.string().min(1).max(200)).min(1).max(64),
  resources: z.array(absoluteUriWithoutFragment).max(16).optional(),
  audience: z.array(z.string().min(1).max(512)).max(8).optional(),
  authorizationDetails: z
    .array(
      z
        .looseObject({ type: z.string().min(1).max(120) })
        .refine((value) => measureJsonValue(value).ok),
    )
    .max(16)
    .optional(),
  prompt: z.enum(["consent", "login", "select_account", "none"]).optional(),
  expiresInMs: z
    .number()
    .int()
    .min(60_000)
    .max(24 * 3_600_000)
    .optional(),
  validityBufferMs: z.number().int().min(0).max(3_600_000).optional(),
  presentation: z.enum(["popup", "same-window", "second-device"]).optional(),
});
export type VercelProfile = z.infer<typeof vercelProfileSchema>;

export const vercelSettingsSchema = z
  .strictObject({
    /** The project and environment whose workload identity requests tokens. */
    project: z.strictObject({
      id: nativeIdentifierSchema,
      environment: environmentSelectorSchema,
    }),
    profiles: z
      .record(identifierSchema, vercelProfileSchema)
      .refine((value) => {
        const count = Object.keys(value).length;
        return count >= 1 && count <= 16;
      }, "Between 1 and 16 profiles"),
    defaultProfile: identifierSchema,
    /** Return path under the deployment origin; the origin itself is never configurable. */
    returnPath: z
      .string()
      .max(256)
      .regex(/^\/(?!\/)[A-Za-z0-9._~!$&'()*+,;=:@%/-]*$/),
    triggers: z
      .strictObject({
        /** The only destinations an administrator may register or keep. */
        destinations: z.array(triggerDestinationInputSchema).max(3),
        /** Expected `aud` of forwarded OIDC tokens, e.g. https://vercel.com/<team-slug>. */
        audience: z.string().url().max(2048).optional(),
        payloadClassification: z
          .enum(["public", "personal", "secret"])
          .optional(),
      })
      .optional(),
    revocation: z.enum(["unsupported", "sdk-observed-endpoint"]).optional(),
    /** Per-request bound for calls to Vercel; raise it behind a slow egress proxy. */
    requestTimeoutMs: z.number().int().min(1_000).max(120_000).optional(),
  })
  .refine(
    (settings) => Object.hasOwn(settings.profiles, settings.defaultProfile),
    "defaultProfile must name a profile",
  );
export type VercelSettings = z.infer<typeof vercelSettingsSchema>;

/** The host-approved Vercel settings of a binding, or a configuration failure. */
export function vercelSettings(binding: RuntimeBinding): VercelSettings {
  const parsed = vercelSettingsSchema.safeParse(binding.settings["vercel"]);
  if (!parsed.success)
    throw new ConnectorError("configuration-required", {
      detail: "vercel.settings.invalid",
    });
  return parsed.data;
}

export function vercelProfile(
  settings: VercelSettings,
  profileId: string | undefined,
): { id: string; profile: VercelProfile } {
  const id = profileId ?? settings.defaultProfile;
  const profile = Object.hasOwn(settings.profiles, id)
    ? settings.profiles[id]
    : undefined;
  if (!profile)
    throw new ConnectorError("denied", { detail: "vercel.profile.unknown" });
  return { id, profile };
}

// ---------------------------------------------------------------------------
// Permitted targets. Team, project, environment, connector and installation
// are each named by the binding; a request naming anything else fails before
// a byte reaches Vercel.
// ---------------------------------------------------------------------------

export const vercelTargetKinds = {
  team: "vercel-team",
  project: "vercel-project",
  environment: "vercel-environment",
  connector: "vercel-connector",
  installation: "vercel-installation",
} as const;
export type VercelTargetKind =
  (typeof vercelTargetKinds)[keyof typeof vercelTargetKinds];

export function permitsTarget(
  binding: RuntimeBinding,
  kind: VercelTargetKind,
  id: string,
): boolean {
  return binding.permittedTargets.some(
    (target) => target.kind === kind && target.id === id,
  );
}

export function requireTarget(
  binding: RuntimeBinding,
  kind: VercelTargetKind,
  id: string,
  detail: string,
): void {
  if (!permitsTarget(binding, kind, id))
    throw new ConnectorError("denied", { detail });
}

// ---------------------------------------------------------------------------
// Upstream failure mapping. Codes come from the documented generic error
// shape (`error.code`) and the SDK's error classification; statuses come from
// the OpenAPI response tables. Bodies never travel further than this file.
// ---------------------------------------------------------------------------

function detailFromCode(code: string): string {
  const slug = code
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .split("-")
    .filter(Boolean)
    .slice(0, 8)
    .join("-");
  const detail = slug ? `vercel.upstream.${slug}` : "vercel.upstream.error";
  return /^[a-z][a-z0-9]*(?:[.-][a-z0-9]+){0,11}$/.test(detail) &&
    detail.length <= 120
    ? detail
    : "vercel.upstream.error";
}

export function upstreamFailure(
  status: number,
  code: string | undefined,
): ConnectorError {
  switch (code) {
    case "user_authorization_required":
      return new ConnectorError("human-required", {
        detail: "vercel.user-authorization-required",
      });
    case "client_installation_required":
    case "connector_installation_required":
      return new ConnectorError("human-required", {
        detail: "vercel.installation-required",
      });
    case "no_token":
      return new ConnectorError("expired", { detail: "vercel.no-valid-token" });
    // The SDK names these as typed error classes; the wire code is the
    // snake_case spelling of the class name.
    case "client_not_linked_to_project":
      return new ConnectorError("denied", {
        detail: "vercel.project.not-linked",
      });
    case "client_not_enabled_for_environment":
      return new ConnectorError("denied", {
        detail: "vercel.environment.not-enabled",
      });
    case "rate_limited":
      return new ConnectorError("rate-limited", {
        detail: "vercel.rate-limited",
      });
    case "not_found":
      return new ConnectorError("not-found", { detail: "vercel.not-found" });
    case "forbidden":
      return new ConnectorError("denied", { detail: "vercel.forbidden" });
    default:
      break;
  }
  if (status === 400)
    return new ConnectorError("invalid-request", {
      detail: code ? detailFromCode(code) : "vercel.bad-request",
    });
  if (status === 401)
    return new ConnectorError("configuration-required", {
      detail: "vercel.credential-rejected",
    });
  if (status === 403)
    return new ConnectorError("denied", { detail: "vercel.forbidden" });
  if (status === 404)
    return new ConnectorError("not-found", { detail: "vercel.not-found" });
  if (status === 409)
    return new ConnectorError("conflict", { detail: "vercel.conflict" });
  if (status === 410)
    return new ConnectorError("expired", { detail: "vercel.gone" });
  if (status === 429)
    return new ConnectorError("rate-limited", {
      detail: "vercel.rate-limited",
    });
  if (status >= 500)
    return new ConnectorError("upstream-unavailable", {
      detail: "vercel.unavailable",
    });
  return new ConnectorError("upstream-rejected", {
    detail: code ? detailFromCode(code) : "vercel.rejected",
  });
}
