import { createHash } from "node:crypto";
import { z } from "zod";
import {
  canonicalConnectorJson,
  measureJsonValue,
  type CompatibilityIssue,
  type ConfigurationRequirement,
  type NativeCapability,
  type NormalizedDefinition,
  type VerificationClaim,
} from "../../../../core/connectors/index.js";
import { identifierSchema } from "../../../../core/operation-contracts.js";
import {
  capabilityStatus,
  type AdapterCallContext,
  type AuthorizationIntent,
  type AuthorizationStart,
  type CompletionResult,
  type ConnectorAdapter,
  type DiscoverInput,
  type DiscoverResult,
  type DiscoveredItem,
  type DisconnectResult,
  type DisconnectScope,
  type ImportInput,
  type ImportOutcome,
  type InvokeRequest,
  type InvokeResult,
} from "../../adapter.js";
import {
  boundOperation,
  destinationFor,
  type ApprovedDestination,
  type RuntimeBinding,
} from "../../binding.js";
import { ConnectorError } from "../../errors.js";
import {
  reportConnectionCapabilities,
  type ConnectionCapabilityReport,
} from "./compatibility.js";
import {
  createGoogleConnectorsClient,
  GoogleTransportUncertain,
  type GoogleConnectorsClient,
} from "./client.js";
import { parseBoundedJsonBytes } from "./json.js";
import {
  assertEndpointLocation,
  baseUrlForDestination,
  connectionResourceName,
  connectionResourceSchema,
  runtimeConnectionPath,
  schemaNameSchema,
  type ConnectionResource,
} from "./resources.js";
import {
  connectionSchema,
  GOOGLE_CONNECTORS_ADAPTER_VERSION,
  GOOGLE_CONNECTORS_ADMIN_PROFILE,
  GOOGLE_CONNECTORS_RUNTIME_PROFILE,
  GOOGLE_CLOUD_PLATFORM_SCOPE,
  runtimeActionSchema,
  runtimeEntitySchema,
} from "./schemas.js";

/*
 * The Google Cloud Integration Connectors adapter.
 *
 * A connection is a configured cloud resource with its own authorization
 * boundary: the project, the location and the connection name decide whose
 * data a call touches, and the identity that calls decides what it may see.
 * Neither is caller input here. The binding pins all three parts of the
 * resource name and the identity, every bound operation's path must equal the
 * path those settings produce, and an input object that tries to carry
 * `name`, `project`, `parent` or `executionConfig` is refused before anything
 * is sent — `executionConfig.headers` is the connector's auth-override
 * channel, and a caller that could set it could make the connection act as
 * somebody else.
 */

export const GOOGLE_CONNECTORS_ADAPTER_ID = "google-integration-connectors";

export const googleConnectorsConfigurationNames = Object.freeze({
  accessToken: "GOOGLE_CONNECTORS_ACCESS_TOKEN",
  expiresAt: "GOOGLE_CONNECTORS_TOKEN_EXPIRES_AT",
});

const configurationName = z.string().regex(/^[A-Z][A-Z0-9_]{0,95}$/);

const identitySchema = z.discriminatedUnion("kind", [
  z.strictObject({
    /** A service account or workload identity the deployment holds a token for. */
    kind: z.literal("service-identity"),
    configurationName: configurationName.default(
      googleConnectorsConfigurationNames.accessToken,
    ),
    expiresAtName: configurationName.optional(),
  }),
  z.strictObject({
    /** An end user's own Google credential, held in this connection's custody. */
    kind: z.literal("end-user"),
    materialField: z.string().max(64).default("accessToken"),
    /** Refuse the connection when it would fall back to admin credentials. */
    requireNoAdminFallback: z.boolean().default(true),
  }),
]);
export type GoogleConnectorsIdentity = z.infer<typeof identitySchema>;

export const googleConnectorsSettingsSchema = z.strictObject({
  admin: z.strictObject({ destinationId: identifierSchema }),
  runtime: z.strictObject({ destinationId: identifierSchema }),
  resource: connectionResourceSchema,
  identity: identitySchema,
});
export type GoogleConnectorsSettings = z.infer<
  typeof googleConnectorsSettingsSchema
>;

export type ResolvedGoogleBinding = {
  admin: ApprovedDestination;
  runtime: ApprovedDestination;
  adminBaseUrl: string;
  runtimeBaseUrl: string;
  resource: ConnectionResource;
  identity: GoogleConnectorsIdentity;
};

function destination(
  binding: RuntimeBinding,
  destinationId: string,
): ApprovedDestination {
  const approved = binding.destinations.find(
    (item) => item.id === destinationId,
  );
  if (!approved)
    throw new ConnectorError("network-policy", {
      detail: "google-connectors.destination.unapproved",
    });
  return approved;
}

/** The connection, identity and destinations a binding approves. */
export function resolveGoogleBinding(
  binding: RuntimeBinding,
): ResolvedGoogleBinding {
  const raw = binding.settings["googleConnectors"];
  if (raw === undefined)
    throw new ConnectorError("configuration-required", {
      detail: "google-connectors.settings.missing",
    });
  const parsed = googleConnectorsSettingsSchema.safeParse(raw);
  if (!parsed.success)
    throw new ConnectorError("invalid-request", {
      detail: "google-connectors.settings.invalid",
    });
  const admin = destination(binding, parsed.data.admin.destinationId);
  const runtime = destination(binding, parsed.data.runtime.destinationId);
  assertEndpointLocation(runtime, parsed.data.resource.location);
  assertEndpointLocation(admin, parsed.data.resource.location);
  return {
    admin,
    runtime,
    adminBaseUrl: baseUrlForDestination(admin),
    runtimeBaseUrl: baseUrlForDestination(runtime),
    resource: parsed.data.resource,
    identity: parsed.data.identity,
  };
}

/** Operation kinds a binding may approve; each has exactly one documented path. */
export const googleOperationKinds = [
  "entityTypes.list",
  "entities.list",
  "entities.get",
  "actions.list",
  "actions.execute",
  "connection.checkStatus",
] as const;
export type GoogleOperationKind = (typeof googleOperationKinds)[number];

export function expectedOperation(
  kind: GoogleOperationKind,
  resource: ConnectionResource,
  name?: string,
): { method: "GET" | "POST"; path: string } {
  switch (kind) {
    case "entityTypes.list":
      return { method: "GET", path: runtimeConnectionPath(resource, "/entityTypes") };
    case "actions.list":
      return { method: "GET", path: runtimeConnectionPath(resource, "/actions") };
    case "connection.checkStatus":
      return { method: "GET", path: runtimeConnectionPath(resource, ":checkStatus") };
    case "entities.list":
      return {
        method: "GET",
        path: runtimeConnectionPath(resource, `/entityTypes/${name}/entities`),
      };
    case "entities.get":
      return {
        method: "GET",
        path: runtimeConnectionPath(
          resource,
          `/entityTypes/${name}/entities/{entityId}`,
        ),
      };
    case "actions.execute":
      return {
        method: "POST",
        path: runtimeConnectionPath(resource, `/actions/${name}:execute`),
      };
  }
}

const reservedInputKeys = new Set([
  "name",
  "parent",
  "project",
  "location",
  "connection",
  "executionConfig",
  "executionConfig.headers",
]);

const listInputSchema = z.strictObject({
  pageSize: z.number().int().min(1).max(1000).optional(),
  pageToken: z.string().max(4096).optional(),
  sortBy: z.array(z.string().max(200)).max(8).optional(),
  sortOrder: z.enum(["ASC", "DESC", "asc", "desc"]).optional(),
  conditions: z.string().max(2048).optional(),
});
const getInputSchema = z.strictObject({ entityId: z.string().min(1).max(512) });
const executeInputSchema = z.strictObject({
  parameters: z.record(z.string().max(200), z.unknown()),
});

const configuration: ConfigurationRequirement[] = [
  {
    name: googleConnectorsConfigurationNames.accessToken,
    source: "host",
    classification: "secret",
    required: true,
    description: `OAuth access token for ${GOOGLE_CLOUD_PLATFORM_SCOPE}, held by the deployment's Google identity`,
  },
  {
    name: googleConnectorsConfigurationNames.expiresAt,
    source: "host",
    classification: "public",
    required: false,
    description:
      "Expiry of the access token, so an expired workload credential fails before it is used",
  },
];

function digestOf(value: unknown): string {
  return createHash("sha256")
    .update(canonicalConnectorJson(value) ?? "")
    .digest("hex");
}

async function resolveToken(
  ctx: AdapterCallContext,
  resolved: ResolvedGoogleBinding,
): Promise<string | undefined> {
  const identity = resolved.identity;
  if (identity.kind === "service-identity") {
    const expiresAtRaw = identity.expiresAtName
      ? await ctx.environment.configuration.read(identity.expiresAtName)
      : await ctx.environment.configuration.read(
          googleConnectorsConfigurationNames.expiresAt,
        );
    if (expiresAtRaw) {
      const expiresAt = Date.parse(expiresAtRaw);
      if (Number.isFinite(expiresAt) && expiresAt <= ctx.environment.now())
        throw new ConnectorError("expired", {
          detail: "google-connectors.credentials.expired",
        });
    }
    return ctx.environment.configuration.read(identity.configurationName);
  }
  return undefined;
}

/**
 * Runs `work` with the identity the binding selected. An end user's token is
 * only ever visible inside the custody callback, and a connection that would
 * fall back to admin credentials is refused rather than silently downgraded to
 * a different principal.
 */
async function withIdentity<T>(
  ctx: AdapterCallContext,
  resolved: ResolvedGoogleBinding,
  work: (token: () => Promise<string | undefined>) => Promise<T>,
): Promise<T> {
  const identity = resolved.identity;
  if (identity.kind === "service-identity") {
    const token = await resolveToken(ctx, resolved);
    return work(async () => token);
  }
  const connection = ctx.connection;
  if (!connection?.credentialRef)
    throw new ConnectorError("configuration-required", {
      detail: "google-connectors.end-user-credential.missing",
    });
  if (identity.requireNoAdminFallback && connection.state["adminFallback"] === true)
    throw new ConnectorError("denied", {
      detail: "google-connectors.admin-fallback",
    });
  return ctx.environment.credentials.use(
    {
      tenantId: connection.tenantId,
      ownerKind: connection.ownerKind,
      ownerId: connection.ownerId,
      connectionRef: connection.connectionRef,
      bindingRef: ctx.binding.bindingRef,
      custody: connection.custody,
    },
    connection.credentialRef,
    async (material) => {
      const token = material[identity.materialField];
      if (!token)
        throw new ConnectorError("configuration-required", {
          detail: "google-connectors.end-user-credential.missing",
        });
      return work(async () => token);
    },
  );
}

function clientWith(
  ctx: AdapterCallContext,
  resolved: ResolvedGoogleBinding,
  token: () => Promise<string | undefined>,
): GoogleConnectorsClient {
  return createGoogleConnectorsClient({
    adminBaseUrl: resolved.adminBaseUrl,
    runtimeBaseUrl: resolved.runtimeBaseUrl,
    fetch: ctx.environment.fetch,
    now: ctx.environment.now,
    token,
  });
}

function identityOf(resource: ConnectionResource, version: string) {
  return {
    ecosystem: "google-integration-connectors",
    /** The location is the authority instance; the project is part of the native id. */
    authorityNamespace: resource.location,
    nativeId: connectionResourceName(resource),
    nativeVersion: version,
  } as const;
}

export function createGoogleConnectorsAdapter(): ConnectorAdapter {
  const identity = {
    adapterVersion: GOOGLE_CONNECTORS_ADAPTER_VERSION,
    runtime: "hosted-server" as const,
  };
  const unsupported = (
    dimension: CompatibilityIssue["dimension"],
    limitation: string,
  ) =>
    capabilityStatus(identity, {
      dimension,
      profile: GOOGLE_CONNECTORS_RUNTIME_PROFILE,
      implementation: "unsupported",
      limitations: [limitation],
    });

  const adapter: ConnectorAdapter = {
    id: GOOGLE_CONNECTORS_ADAPTER_ID,
    ecosystem: "google-integration-connectors",
    adapterVersion: GOOGLE_CONNECTORS_ADAPTER_VERSION,
    runtime: "hosted-server",
    displayName: "Google Cloud Integration Connectors",
    description:
      "Discovers configured Integration Connectors connections and their entity types and actions, and invokes the supported ones with the project, location, connection and identity the host approved.",
    service: "google-integration-connectors",
    support: "provider-backed",
    custody: ["host-owned"],
    configuration,
    profiles: [
      GOOGLE_CONNECTORS_ADMIN_PROFILE,
      GOOGLE_CONNECTORS_RUNTIME_PROFILE,
    ],
    capabilities(present) {
      const ready = present.has(googleConnectorsConfigurationNames.accessToken);
      return [
        capabilityStatus(identity, {
          dimension: "discover",
          profile: GOOGLE_CONNECTORS_ADMIN_PROFILE,
          evidence: "protocol-fixture",
          configuration: ready ? "ready" : "missing",
          limitations: [
            "Existing connections only: connections are never created, updated, suspended or deleted",
          ],
        }),
        capabilityStatus(identity, {
          dimension: "import",
          profile: GOOGLE_CONNECTORS_ADMIN_PROFILE,
          evidence: "protocol-fixture",
          limitations: [
            "Entity and action availability is per connection; the connector's unsupported names are reported, not hidden",
          ],
        }),
        unsupported(
          "configure",
          "Connection configuration and config variables stay in Google Cloud",
        ),
        unsupported(
          "authorize",
          "The access token comes from the host's Google identity; this adapter runs no OAuth or service-account flow",
        ),
        capabilityStatus(identity, {
          dimension: "verify",
          profile: GOOGLE_CONNECTORS_RUNTIME_PROFILE,
          evidence: "protocol-fixture",
          configuration: ready ? "ready" : "missing",
          limitations: [
            "checkStatus reports the connector's state, not the caller's permissions on the backing system",
          ],
        }),
        capabilityStatus(identity, {
          dimension: "invoke",
          profile: GOOGLE_CONNECTORS_RUNTIME_PROFILE,
          evidence: "protocol-fixture",
          configuration: ready ? "ready" : "missing",
          limitations: [
            "Entity list and get, and action execute; entity writes are not bound by this adapter",
            "executionConfig is never sent, so a caller cannot override the connection's backend auth",
            "Async long-running action results are preserved as the connector returned them and never reported as completed work",
          ],
        }),
        unsupported(
          "events",
          "Eventing subscriptions are configured in Google Cloud and are not bound here",
        ),
        unsupported(
          "reconnect",
          "A new credential is supplied through host configuration or custody, not by a provider flow",
        ),
        capabilityStatus(identity, {
          dimension: "disconnect",
          profile: GOOGLE_CONNECTORS_RUNTIME_PROFILE,
          evidence: "unit",
          limitations: [
            "Local only: the connection in Google Cloud is never deleted or suspended",
          ],
        }),
        unsupported(
          "revoke",
          "Revocation belongs to Google Cloud IAM or the connector's own authorization",
        ),
        unsupported(
          "export",
          "A connection is project-specific and is not exportable metadata",
        ),
        unsupported(
          "delegate",
          "The connection exposes entities and actions, not delegated tasks",
        ),
      ];
    },

    async discover(
      ctx: AdapterCallContext,
      input: DiscoverInput,
    ): Promise<DiscoverResult> {
      const resolved = resolveGoogleBinding(ctx.binding);
      const scopeConnection = input.scope?.["connection"];
      if (
        scopeConnection !== undefined &&
        scopeConnection !== resolved.resource.connection &&
        !ctx.binding.permittedTargets.some(
          (target) =>
            target.kind === "connection" && target.id === scopeConnection,
        )
      )
        throw new ConnectorError("denied", {
          detail: "google-connectors.connection.not-permitted",
        });
      const call = { signal: ctx.signal };
      return withIdentity(ctx, resolved, async (token) => {
        const client = clientWith(ctx, resolved, token);
        const issues: CompatibilityIssue[] = [];
        const items: DiscoveredItem[] = [];
        if (input.scope?.["level"] === "connections" || !scopeConnection) {
          const page = await client.listConnections(
            resolved.resource,
            {
              ...(input.limit ? { pageSize: input.limit } : {}),
              ...(input.cursor ? { pageToken: input.cursor } : {}),
            },
            call,
          );
          for (const location of page.unreachable)
            issues.push({
              code: "google-connectors.location.unreachable",
              category: "network",
              sourcePointer: `/unreachable/${location}`,
              dimension: "discover",
              disposition: "requires-configuration",
              severity: "warning",
              executionImpact: "blocks-operation",
              message:
                "A location could not be reached; its connections are missing from this listing.",
            });
          for (const connection of page.connections) {
            const name = connection.name.split("/").pop() ?? connection.name;
            items.push({
              identity: identityOf(
                { ...resolved.resource, connection: name },
                connection.connectionRevision ??
                  connection.updateTime ??
                  "unknown",
              ),
              displayName: name,
              description: (connection.description ?? "").slice(0, 500),
              provenance: {
                state: connection.status?.state ?? "STATE_UNSPECIFIED",
                ...(connection.connectorVersion
                  ? {
                      connectorVersion: connection.connectorVersion
                        .split("/")
                        .slice(-3)
                        .join("/"),
                    }
                  : {}),
                ...(connection.suspended ? { suspended: "true" } : {}),
                ...(connection.asyncOperationsEnabled
                  ? { asyncOperations: "true" }
                  : {}),
              },
              status:
                connection.status?.state === "ACTIVE" ? "active" : "unknown",
            });
          }
          return {
            items,
            ...(page.nextPageToken ? { nextCursor: page.nextPageToken } : {}),
            freshness: {
              fetchedAt: ctx.environment.now(),
              stale: false,
              source: "live",
            },
            issues,
          };
        }
        const resource = { ...resolved.resource, connection: scopeConnection };
        const [connection, entityTypes, actions, runtimeTypes, runtimeActions] =
          await Promise.all([
            client.getConnection(resource, call),
            client.listEntityTypeMetadata(resource, {}, call),
            client.listActionMetadata(resource, {}, call),
            client.listRuntimeEntityTypes(resource, {}, call),
            client.listRuntimeActions(resource, {}, call),
          ]);
        const report = reportConnectionCapabilities({
          connection,
          entityTypes: entityTypes.entityTypes,
          actions: actions.actions,
          unsupportedTypeNames: runtimeTypes.unsupportedTypeNames,
          unsupportedActionNames: runtimeActions.unsupportedActionNames,
        });
        for (const capability of report.capabilities)
          items.push({
            identity: identityOf(
              resource,
              connection.connectionRevision ?? "unknown",
            ),
            displayName: capability.label ?? capability.nativeId,
            description: capability.summary ?? "",
            provenance: {
              kind: capability.kind,
              nativeId: capability.nativeId,
              ...(report.entityOperations[capability.nativeId]
                ? {
                    operations:
                      report.entityOperations[capability.nativeId]!.join(","),
                  }
                : {}),
            },
            status: "active",
          });
        return {
          items,
          freshness: {
            fetchedAt: ctx.environment.now(),
            stale: false,
            source: "live",
          },
          issues: [...issues, ...report.issues],
        };
      });
    },

    /** Imports a captured connection description with its schema metadata. */
    async import(
      ctx: AdapterCallContext,
      input: ImportInput,
    ): Promise<ImportOutcome> {
      const value = parseBoundedJsonBytes(input.bytes);
      const document = z
        .object({
          connection: z.unknown(),
          entityTypes: z.array(z.unknown()).max(4096).default([]),
          actions: z.array(z.unknown()).max(4096).default([]),
          unsupportedTypeNames: z.array(z.string().max(200)).max(1000).optional(),
          unsupportedActionNames: z
            .array(z.string().max(200))
            .max(1000)
            .optional(),
        })
        .safeParse(value);
      if (!document.success)
        throw new ConnectorError("invalid-request", {
          detail: "google-connectors.import.shape",
        });
      const connection = connectionSchema.safeParse(document.data.connection);
      if (!connection.success)
        throw new ConnectorError("invalid-request", {
          detail: "google-connectors.import.connection",
        });
      const parts =
        /^projects\/([^/]+)\/locations\/([^/]+)\/connections\/([^/]+)$/.exec(
          connection.data.name,
        );
      const resource = connectionResourceSchema.safeParse({
        project: parts?.[1] ?? "",
        location: parts?.[2] ?? "",
        connection: parts?.[3] ?? "",
      });
      if (!resource.success)
        throw new ConnectorError("invalid-request", {
          detail: "google-connectors.import.resource",
        });
      const entityTypes = document.data.entityTypes
        .map((raw) => runtimeEntitySchema.safeParse(raw))
        .filter((parsed) => parsed.success)
        .map((parsed) => parsed.data);
      const actions = document.data.actions
        .map((raw) => runtimeActionSchema.safeParse(raw))
        .filter((parsed) => parsed.success)
        .map((parsed) => parsed.data);
      const report = reportConnectionCapabilities({
        connection: connection.data,
        entityTypes,
        actions,
        ...(document.data.unsupportedTypeNames
          ? { unsupportedTypeNames: document.data.unsupportedTypeNames }
          : {}),
        ...(document.data.unsupportedActionNames
          ? { unsupportedActionNames: document.data.unsupportedActionNames }
          : {}),
      });
      const digest = createHash("sha256").update(input.bytes).digest("hex");
      const sourceRef = `src:google-connectors:${digest}`;
      const definition: NormalizedDefinition = {
        schemaVersion: 1,
        definitionRef: `definition:google-connectors:${digest.slice(0, 32)}`,
        identity: identityOf(
          resource.data,
          connection.data.connectionRevision ?? "unknown",
        ),
        sourceRef,
        normalizedDigest: digestOf({
          connection: connection.data.name,
          capabilities: report.capabilities.map(
            (capability) => `${capability.kind}:${capability.nativeId}`,
          ),
        }),
        importer: {
          id: "google-connectors-importer",
          version: GOOGLE_CONNECTORS_ADAPTER_VERSION,
        },
        display: {
          name: resource.data.connection,
          description: (
            connection.data.description ?? "Integration Connectors connection"
          ).slice(0, 500),
          ecosystem: "google-integration-connectors",
          service: "google-integration-connectors",
        },
        authentication: [
          {
            id: "google-identity",
            label: "Google Cloud identity",
            kind: "http-bearer",
            format: "oauth2-access-token",
          },
        ],
        configuration: [
          {
            name: googleConnectorsConfigurationNames.accessToken,
            source: "host",
            classification: "secret",
            required: true,
            description: `Access token for ${GOOGLE_CLOUD_PLATFORM_SCOPE}`,
          },
        ],
        capabilities: report.capabilities,
        events: [],
        declaredServers: [
          { url: "https://connectors.googleapis.com", status: "declared" },
        ],
        compatibility: {
          issues: report.issues,
          dimensions: {
            discover: "exact",
            import: "adapted",
            configure: "unsupported",
            authorize: "requires-configuration",
            verify: "requires-configuration",
            invoke: "requires-configuration",
            events: "unsupported",
            reconnect: "unsupported",
            disconnect: "adapted",
            revoke: "unsupported",
            export: "unsupported",
            delegate: "unsupported",
          },
        },
        nativeExtensions: {
          entityOperations: report.entityOperations,
          actions: report.actions,
          unsupportedTypeNames: report.unsupportedTypeNames,
          unsupportedActionNames: report.unsupportedActionNames,
          asyncOperations: report.asyncOperations,
          adminFallback: report.adminFallback,
          privateEndpoint: report.privateEndpoint,
        },
      };
      return {
        source: {
          sourceRef,
          identity: definition.identity,
          format: {
            name: "google-integration-connectors",
            version: GOOGLE_CONNECTORS_ADMIN_PROFILE,
          },
          origin: input.origin,
          digest: { algorithm: "sha256", value: digest },
          byteLength: input.bytes.byteLength,
          mediaType: input.mediaType.split(";")[0]!.trim() || "application/json",
          capturedAt: new Date(ctx.environment.now()).toISOString(),
          adaptation: [],
          overlays: [],
        },
        definitions: [definition],
        issues: report.issues,
        executableCandidates: report.capabilities.map(
          (capability) => capability.nativeId,
        ),
      };
    },

    async authorize(
      ctx: AdapterCallContext,
      _intent: AuthorizationIntent,
    ): Promise<AuthorizationStart> {
      const resolved = resolveGoogleBinding(ctx.binding);
      if (resolved.identity.kind === "service-identity") {
        const token = await ctx.environment.configuration.read(
          resolved.identity.configurationName,
        );
        if (!token)
          return {
            kind: "configuration-required",
            missing: [resolved.identity.configurationName],
          };
        return { kind: "verify" };
      }
      if (!ctx.connection?.credentialRef)
        return {
          kind: "configuration-required",
          missing: ["end-user-credential"],
        };
      return { kind: "verify" };
    },

    async verify(ctx: AdapterCallContext): Promise<CompletionResult> {
      const resolved = resolveGoogleBinding(ctx.binding);
      const observedAt = new Date(ctx.environment.now()).toISOString();
      const policyRevision = ctx.connection?.policyRevision ?? "policy:unknown";
      const resourceName = connectionResourceName(resolved.resource);
      return withIdentity(ctx, resolved, async (token) => {
        const client = clientWith(ctx, resolved, token);
        const call = { signal: ctx.signal };
        const connection = await client.getConnection(resolved.resource, call);
        const report = reportConnectionCapabilities({ connection });
        if (
          resolved.identity.kind === "end-user" &&
          resolved.identity.requireNoAdminFallback &&
          report.adminFallback
        )
          throw new ConnectorError("denied", {
            detail: "google-connectors.admin-fallback",
          });
        if (report.privateEndpoint && resolved.runtime.network === "public")
          throw new ConnectorError("network-policy", {
            detail: "google-connectors.private-endpoint",
          });
        const claims: VerificationClaim[] = [
          {
            kind: "resource-access",
            evidenceRef: `evidence:google-connection:${digestOf(resourceName).slice(0, 24)}`,
            issuer: "provider",
            target: { kind: "connection", id: resourceName },
            observedAt,
            verifierVersion: GOOGLE_CONNECTORS_ADAPTER_VERSION,
            bindingRevision: ctx.binding.revision,
            policyRevision,
            permissions: {
              requested: [GOOGLE_CLOUD_PLATFORM_SCOPE],
              reported: [],
              observed: [],
              semantics: "provider-scopes",
            },
            limitations: [
              "Reading the connection proves access to the connection resource, not to the system behind it",
              ...(report.adminFallback
                ? [
                    "This connection falls back to admin credentials when no dynamic auth header is sent",
                  ]
                : []),
            ],
          },
        ];
        const state = connection.status?.state;
        if (state === "AUTHORIZATION_REQUIRED")
          return {
            state: "human-required",
            claims,
            code: "google-connectors.authorization-required",
            adapterState: { connectionState: state },
          };
        const status = await client.checkStatus(resolved.resource, call);
        if (status.state === "AUTH_ERROR")
          return {
            state: "denied",
            claims,
            code: "google-connectors.auth-error",
            adapterState: { connectorState: status.state },
          };
        if (status.state !== "ACTIVE")
          return {
            state: "pending",
            claims,
            code: "google-connectors.connector-not-active",
            adapterState: { connectorState: status.state },
          };
        claims.push({
          kind: "credential-accepted",
          evidenceRef: `evidence:google-status:${digestOf([resourceName, observedAt]).slice(0, 24)}`,
          issuer: "provider",
          target: { kind: "connection", id: resourceName },
          observedAt,
          verifierVersion: GOOGLE_CONNECTORS_ADAPTER_VERSION,
          bindingRevision: ctx.binding.revision,
          policyRevision,
          limitations: [
            "The connector reports its own backend session as ACTIVE; it names no account on the backing system",
          ],
        });
        return {
          state: "complete",
          claims,
          target: { kind: "connection", id: resourceName },
          adapterState: {
            connectorState: status.state,
            adminFallback: report.adminFallback,
            asyncOperations: report.asyncOperations,
            privateEndpoint: report.privateEndpoint,
          },
        };
      });
    },

    async invoke(
      ctx: AdapterCallContext,
      request: InvokeRequest,
    ): Promise<InvokeResult> {
      const resolved = resolveGoogleBinding(ctx.binding);
      const bound = boundOperation(ctx.binding, request.operationRef);
      if (!bound)
        throw new ConnectorError("denied", {
          detail: "google-connectors.operation.unapproved",
        });
      if (bound.transport.kind !== "http")
        throw new ConnectorError("invalid-request", {
          detail: "google-connectors.operation.transport",
        });
      const approved = destinationFor(ctx.binding, bound);
      if (approved.id !== resolved.runtime.id)
        throw new ConnectorError("network-policy", {
          detail: "google-connectors.operation.destination",
        });
      const kind = googleOperationKinds.find(
        (candidate) => candidate === bound.nativeId,
      );
      if (!kind)
        throw new ConnectorError("invalid-request", {
          detail: "google-connectors.operation.kind",
        });
      const template = bound.transport.pathTemplate;
      const named =
        /\/entityTypes\/([^/]+)\/entities/.exec(template)?.[1] ??
        /\/actions\/([^/:]+):execute$/.exec(template)?.[1];
      const name = named ? decodeURIComponent(named) : undefined;
      if (name !== undefined && !schemaNameSchema.safeParse(name).success)
        throw new ConnectorError("invalid-request", {
          detail: "google-connectors.operation.name",
        });
      const expected = expectedOperation(kind, resolved.resource, name);
      if (
        expected.method !== bound.transport.method ||
        expected.path !== template
      )
        /*
         * The approved path is the whole authority: it pins the project, the
         * location, the connection and the entity type or action. A template
         * that does not equal the one those settings produce is a different
         * resource, whoever asked for it.
         */
        throw new ConnectorError("denied", {
          detail: "google-connectors.operation.path-mismatch",
        });
      if (
        name !== undefined &&
        !ctx.binding.permittedTargets.some(
          (target) =>
            target.id === name &&
            (target.kind === "entity-type" || target.kind === "action"),
        )
      )
        throw new ConnectorError("denied", {
          detail: "google-connectors.target.not-permitted",
        });

      if (
        request.input === null ||
        typeof request.input !== "object" ||
        Array.isArray(request.input)
      )
        throw new ConnectorError("invalid-request", {
          detail: "google-connectors.input.shape",
        });
      const measured = measureJsonValue(request.input);
      if (!measured.ok)
        throw new ConnectorError("invalid-request", {
          detail: "google-connectors.input.bounds",
        });
      for (const key of Object.keys(request.input as Record<string, unknown>))
        if (reservedInputKeys.has(key))
          throw new ConnectorError("denied", {
            detail:
              key === "executionConfig"
                ? "google-connectors.execution-config.denied"
                : "google-connectors.resource.substituted",
          });

      const journaled = bound.effect !== "read";
      const digest = digestOf([
        connectionResourceName(resolved.resource),
        request.operationRef,
        request.input,
        request.commandId,
      ]);
      const journal = journaled
        ? await ctx.environment.effects.begin({
            actor: ctx.actor,
            ...(ctx.connection
              ? { connectionRef: ctx.connection.connectionRef }
              : {}),
            bindingRef: ctx.binding.bindingRef,
            operation: `google-connectors.${kind}.${request.operationRef}`,
            digest,
            commandId: request.commandId,
          })
        : undefined;
      if (journal?.prior)
        return {
          state:
            journal.prior.status === "applied"
              ? "complete"
              : journal.prior.status === "not-applied"
                ? "failed"
                : "indeterminate",
          outputClassification: bound.outputClassification,
          effect: bound.effect,
          effectRef: journal.effectRef,
          code: "google-connectors.effect.replayed",
        };

      try {
        const output = await withIdentity(ctx, resolved, async (token) => {
          const client = clientWith(ctx, resolved, token);
          const call = { signal: ctx.signal };
          switch (kind) {
            case "entityTypes.list": {
              const page = await client.listRuntimeEntityTypes(
                resolved.resource,
                listInputSchema.parse(request.input),
                call,
              );
              return page;
            }
            case "actions.list":
              return client.listRuntimeActions(
                resolved.resource,
                listInputSchema.parse(request.input),
                call,
              );
            case "connection.checkStatus":
              return client.checkStatus(resolved.resource, call);
            case "entities.list": {
              const input = listInputSchema.parse(request.input);
              return client.listEntities(resolved.resource, name!, input, call);
            }
            case "entities.get": {
              const input = getInputSchema.parse(request.input);
              return client.getEntity(
                resolved.resource,
                name!,
                input.entityId,
                call,
              );
            }
            case "actions.execute": {
              const input = executeInputSchema.parse(request.input);
              return client.executeAction(
                resolved.resource,
                name!,
                input.parameters,
                call,
              );
            }
          }
        });
        if (journal)
          await ctx.environment.effects.complete(journal.effectRef, {
            status: "applied",
            at: ctx.environment.now(),
          });
        return {
          state: "complete",
          output,
          outputClassification: bound.outputClassification,
          effect: bound.effect,
          ...(journal ? { effectRef: journal.effectRef } : {}),
          ...(ctx.connection?.state["asyncOperations"] === true &&
          kind === "actions.execute"
            ? { code: "google-connectors.async-result-unreconciled" }
            : {}),
        };
      } catch (error) {
        if (error instanceof GoogleTransportUncertain) {
          if (journal)
            await ctx.environment.effects.complete(journal.effectRef, {
              status: "indeterminate",
              at: ctx.environment.now(),
              code: error.detail,
            });
          return {
            state: "indeterminate",
            outputClassification: bound.outputClassification,
            effect: bound.effect,
            ...(journal ? { effectRef: journal.effectRef } : {}),
            code: "google-connectors.call.uncertain",
          };
        }
        if (journal)
          await ctx.environment.effects.complete(journal.effectRef, {
            status:
              error instanceof ConnectorError &&
              (error.code === "denied" ||
                error.code === "invalid-request" ||
                error.code === "configuration-required")
                ? "not-applied"
                : "failed",
            at: ctx.environment.now(),
          });
        if (error instanceof z.ZodError)
          throw new ConnectorError("invalid-request", {
            detail: "google-connectors.input.invalid",
          });
        throw error;
      }
    },

    async disconnect(
      _ctx: AdapterCallContext,
      scope: DisconnectScope,
    ): Promise<DisconnectResult> {
      return {
        local: "applied",
        broker: scope === "broker" ? "unsupported" : "not-attempted",
        upstream: scope === "upstream" ? "unsupported" : "not-attempted",
      };
    },
  };
  return adapter;
}

export type { ConnectionCapabilityReport };
