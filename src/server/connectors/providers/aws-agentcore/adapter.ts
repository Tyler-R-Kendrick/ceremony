import { createHash } from "node:crypto";
import { z } from "zod";
import {
  canonicalConnectorJson,
  measureJsonValue,
  type AuthenticationProfile,
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
import type { CredentialScope } from "../../ports.js";
import {
  analyzeTarget,
  splitGatewayToolName,
  type TargetAnalysis,
} from "./compatibility.js";
import {
  controlBaseUrlForDestination,
  controlRegionForDestination,
  createAgentCoreControlClient,
  type AgentCoreControlClient,
} from "./control.js";
import {
  createGatewayMcpClient,
  GatewayTransportUncertain,
  type GatewayAuthorization,
  type GatewayCallResult,
} from "./gateway.js";
import { parseBoundedJsonBytes } from "./json.js";
import {
  AGENTCORE_ADAPTER_VERSION,
  AGENTCORE_CONTROL_PROFILE,
  AGENTCORE_DEFAULT_SIGNING_SERVICE,
  AGENTCORE_MCP_LEGACY_VERSIONS,
  AGENTCORE_MCP_PROFILE,
  AGENTCORE_MCP_PROTOCOL_VERSION,
  gatewayIdentifierSchema,
  getGatewayResponseSchema,
  getGatewayTargetResponseSchema,
  targetNameSchema,
  type GetGatewayResponse,
  type GetGatewayTargetResponse,
} from "./schemas.js";
import type { AwsCredentials } from "./sigv4.js";

/*
 * The AgentCore Gateway adapter.
 *
 * Two identities meet at a gateway and this adapter never lets them merge.
 * The *management* identity is the deployment's own AWS principal; it may
 * describe gateways and targets and nothing else. The *caller* identity is
 * whatever the gateway's inbound authorization accepts — a JWT from the
 * gateway's identity provider, or a separate SigV4 principal holding
 * `bedrock-agentcore:InvokeGateway`. The *outbound* credentials that reach a
 * target are held by AgentCore Identity inside AWS; Ceremony never sees them,
 * never supplies them and never asks for them.
 *
 * The binding carries which destination and which configuration names each leg
 * uses, and `agentCoreSettingsSchema` refuses a binding that points both legs
 * at the same configuration. Nothing in this adapter reads an ambient AWS
 * credential chain, and nothing in it can create, update or delete an AWS
 * resource: the control client is read-only by construction.
 */

export const AGENTCORE_ADAPTER_ID = "aws-agentcore-gateway";

export const agentCoreConfigurationNames = Object.freeze({
  accessKeyId: "AWS_AGENTCORE_ACCESS_KEY_ID",
  secretAccessKey: "AWS_AGENTCORE_SECRET_ACCESS_KEY",
  sessionToken: "AWS_AGENTCORE_SESSION_TOKEN",
  expiresAt: "AWS_AGENTCORE_CREDENTIAL_EXPIRES_AT",
  gatewayToken: "AWS_AGENTCORE_GATEWAY_TOKEN",
  gatewayAccessKeyId: "AWS_AGENTCORE_GATEWAY_ACCESS_KEY_ID",
  gatewaySecretAccessKey: "AWS_AGENTCORE_GATEWAY_SECRET_ACCESS_KEY",
  gatewaySessionToken: "AWS_AGENTCORE_GATEWAY_SESSION_TOKEN",
});

const configurationName = z.string().regex(/^[A-Z][A-Z0-9_]{0,95}$/);
const regionSchema = z.string().regex(/^[a-z0-9-]{1,32}$/);
const signingServiceSchema = z.string().regex(/^[a-z0-9-]{1,64}$/);

const awsCredentialNamesSchema = z.strictObject({
  accessKeyId: configurationName,
  secretAccessKey: configurationName,
  sessionToken: configurationName.optional(),
  expiresAt: configurationName.optional(),
});
type AwsCredentialNames = z.infer<typeof awsCredentialNamesSchema>;

const inboundSchema = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("oauth-jwt"),
    /** Where the caller's bearer token comes from: deployment configuration or this connection's custody. */
    source: z.enum(["configuration", "connection"]).default("configuration"),
    configurationName: configurationName.optional(),
    /** Field of the stored credential material holding the access token. */
    materialField: z.string().max(64).default("accessToken"),
  }),
  z.strictObject({
    kind: z.literal("iam-sigv4"),
    region: regionSchema,
    signingService: signingServiceSchema.optional(),
    credentials: awsCredentialNamesSchema,
  }),
  z.strictObject({ kind: z.literal("none") }),
]);

export const agentCoreSettingsSchema = z
  .strictObject({
    management: z
      .strictObject({
        destinationId: identifierSchema,
        region: regionSchema,
        signingService: signingServiceSchema.optional(),
        credentials: awsCredentialNamesSchema,
      })
      .optional(),
    gateway: z
      .strictObject({
        destinationId: identifierSchema,
        gatewayIdentifier: gatewayIdentifierSchema,
        /** Path of the gateway's MCP endpoint within the approved destination. */
        endpointPath: z
          .string()
          .max(512)
          .regex(/^\/[^\p{Cc}?#]*$/u)
          .default("/mcp"),
        inbound: inboundSchema,
        /** Target names known to reach a VPC-private endpoint; they need an approved-private destination. */
        privateTargets: z.array(targetNameSchema).max(64).default([]),
      })
      .optional(),
  })
  .superRefine((settings, ctx) => {
    const management = settings.management;
    const gateway = settings.gateway;
    if (!management && !gateway)
      ctx.addIssue({
        code: "custom",
        message: "A binding names a management leg, a gateway leg, or both",
      });
    if (!management || !gateway) return;
    const managementNames = new Set(
      Object.values(management.credentials).filter(
        (value): value is string => typeof value === "string",
      ),
    );
    const inbound = gateway.inbound;
    const callerNames =
      inbound.kind === "iam-sigv4"
        ? Object.values(inbound.credentials).filter(
            (value): value is string => typeof value === "string",
          )
        : inbound.kind === "oauth-jwt" && inbound.configurationName
          ? [inbound.configurationName]
          : [];
    for (const name of callerNames)
      if (managementNames.has(name))
        ctx.addIssue({
          code: "custom",
          message:
            "The gateway caller identity must not reuse a management credential",
        });
  });
export type AgentCoreSettings = z.infer<typeof agentCoreSettingsSchema>;

export type ResolvedManagement = {
  destination: ApprovedDestination;
  baseUrl: string;
  region: string;
  signingService: string;
  credentials: AwsCredentialNames;
};
export type ResolvedGateway = {
  destination: ApprovedDestination;
  endpoint: URL;
  gatewayIdentifier: string;
  inbound: z.infer<typeof inboundSchema>;
  privateTargets: readonly string[];
};

/** The settings a binding approves; a malformed or absent block is a policy failure, not a default. */
export function agentCoreSettings(binding: RuntimeBinding): AgentCoreSettings {
  const raw = binding.settings["awsAgentCore"];
  if (raw === undefined)
    throw new ConnectorError("configuration-required", {
      detail: "agentcore.settings.missing",
    });
  const parsed = agentCoreSettingsSchema.safeParse(raw);
  if (!parsed.success)
    throw new ConnectorError("invalid-request", {
      detail: "agentcore.settings.invalid",
    });
  return parsed.data;
}

function destination(
  binding: RuntimeBinding,
  destinationId: string,
): ApprovedDestination {
  const approved = binding.destinations.find((item) => item.id === destinationId);
  if (!approved)
    throw new ConnectorError("network-policy", {
      detail: "agentcore.destination.unapproved",
    });
  return approved;
}

export function resolveManagement(binding: RuntimeBinding): ResolvedManagement {
  const settings = agentCoreSettings(binding);
  if (!settings.management)
    throw new ConnectorError("unsupported", {
      detail: "agentcore.management.not-bound",
    });
  const approved = destination(binding, settings.management.destinationId);
  return {
    destination: approved,
    baseUrl: controlBaseUrlForDestination(approved),
    region: controlRegionForDestination(approved, settings.management.region),
    signingService:
      settings.management.signingService ?? AGENTCORE_DEFAULT_SIGNING_SERVICE,
    credentials: settings.management.credentials,
  };
}

export function resolveGateway(binding: RuntimeBinding): ResolvedGateway {
  const settings = agentCoreSettings(binding);
  if (!settings.gateway)
    throw new ConnectorError("unsupported", {
      detail: "agentcore.gateway.not-bound",
    });
  const approved = destination(binding, settings.gateway.destinationId);
  const endpoint = new URL(settings.gateway.endpointPath, approved.origin);
  if (endpoint.origin !== approved.origin)
    throw new ConnectorError("network-policy", {
      detail: "agentcore.gateway.endpoint-escaped",
    });
  const prefix = approved.pathPrefix;
  if (
    prefix &&
    !(
      endpoint.pathname === prefix ||
      endpoint.pathname.startsWith(prefix.endsWith("/") ? prefix : `${prefix}/`)
    )
  )
    throw new ConnectorError("network-policy", {
      detail: "agentcore.gateway.endpoint-outside-prefix",
    });
  return {
    destination: approved,
    endpoint,
    gatewayIdentifier: settings.gateway.gatewayIdentifier,
    inbound: settings.gateway.inbound,
    privateTargets: settings.gateway.privateTargets,
  };
}

async function readCredentials(
  ctx: AdapterCallContext,
  names: AwsCredentialNames,
): Promise<AwsCredentials | undefined> {
  const accessKeyId = await ctx.environment.configuration.read(
    names.accessKeyId,
  );
  const secretAccessKey = await ctx.environment.configuration.read(
    names.secretAccessKey,
  );
  if (!accessKeyId || !secretAccessKey) return undefined;
  const sessionToken = names.sessionToken
    ? await ctx.environment.configuration.read(names.sessionToken)
    : undefined;
  const expiresAtRaw = names.expiresAt
    ? await ctx.environment.configuration.read(names.expiresAt)
    : undefined;
  const expiresAt = expiresAtRaw ? Date.parse(expiresAtRaw) : Number.NaN;
  return {
    accessKeyId,
    secretAccessKey,
    ...(sessionToken ? { sessionToken } : {}),
    ...(Number.isFinite(expiresAt) ? { expiresAt } : {}),
  };
}

function controlClient(
  ctx: AdapterCallContext,
  management: ResolvedManagement,
): AgentCoreControlClient {
  return createAgentCoreControlClient({
    baseUrl: management.baseUrl,
    region: management.region,
    signingService: management.signingService,
    fetch: ctx.environment.fetch,
    now: ctx.environment.now,
    credentials: () => readCredentials(ctx, management.credentials),
  });
}

function credentialScope(
  ctx: AdapterCallContext,
): CredentialScope & { ref: string } {
  const connection = ctx.connection;
  if (!connection?.credentialRef)
    throw new ConnectorError("configuration-required", {
      detail: "agentcore.gateway.credential.missing",
    });
  return {
    tenantId: connection.tenantId,
    ownerKind: connection.ownerKind,
    ownerId: connection.ownerId,
    connectionRef: connection.connectionRef,
    bindingRef: ctx.binding.bindingRef,
    custody: connection.custody,
    ref: connection.credentialRef,
  };
}

/**
 * Runs `work` with the caller authorization the binding selected. A token held
 * in custody is only ever visible inside the custody callback, and the value
 * `work` returns must not contain it.
 */
async function withCallerAuthorization<T>(
  ctx: AdapterCallContext,
  gateway: ResolvedGateway,
  work: (authorization: GatewayAuthorization) => Promise<T>,
): Promise<T> {
  const inbound = gateway.inbound;
  if (inbound.kind === "none") return work({ kind: "none" });
  if (inbound.kind === "iam-sigv4") {
    const credentials = await readCredentials(ctx, inbound.credentials);
    if (!credentials)
      throw new ConnectorError("configuration-required", {
        detail: "agentcore.gateway.credentials.missing",
      });
    return work({
      kind: "sigv4",
      credentials,
      region: inbound.region,
      service: inbound.signingService ?? AGENTCORE_DEFAULT_SIGNING_SERVICE,
    });
  }
  if (inbound.source === "connection") {
    const scope = credentialScope(ctx);
    const { ref, ...rest } = scope;
    return ctx.environment.credentials.use(rest, ref, async (material) => {
      const token = material[inbound.materialField];
      if (!token)
        throw new ConnectorError("configuration-required", {
          detail: "agentcore.gateway.token.missing",
        });
      return work({ kind: "bearer", token });
    });
  }
  const name = inbound.configurationName ?? agentCoreConfigurationNames.gatewayToken;
  const token = await ctx.environment.configuration.read(name);
  if (!token)
    throw new ConnectorError("configuration-required", {
      detail: "agentcore.gateway.token.missing",
    });
  return work({ kind: "bearer", token });
}

function gatewayClientFor(
  ctx: AdapterCallContext,
  gateway: ResolvedGateway,
  authorization: GatewayAuthorization,
) {
  return createGatewayMcpClient({
    endpoint: gateway.endpoint,
    fetch: ctx.environment.fetch,
    now: ctx.environment.now,
    authorization: async () => authorization,
  });
}

/** Native identity of a gateway; the ARN is never used, because it carries the account number. */
function gatewayIdentity(region: string, gatewayId: string, version: string) {
  return {
    ecosystem: "aws-agentcore",
    authorityNamespace: region,
    nativeId: gatewayId,
    nativeVersion: version,
  } as const;
}

function versionOf(updatedAt: string | undefined): string {
  return updatedAt && updatedAt.length > 0 && updatedAt.length <= 128
    ? updatedAt
    : "unknown";
}

function authenticationForGateway(
  gateway: GetGatewayResponse,
): AuthenticationProfile {
  if (gateway.authorizerType === "CUSTOM_JWT") {
    const discoveryUrl =
      gateway.authorizerConfiguration?.customJWTAuthorizer?.discoveryUrl;
    const issuer =
      discoveryUrl?.endsWith("/.well-known/openid-configuration") === true
        ? discoveryUrl.slice(
            0,
            -"/.well-known/openid-configuration".length,
          )
        : undefined;
    if (issuer)
      return {
        id: "inbound-jwt",
        label: "Gateway inbound JWT",
        kind: "openid-connect",
        issuer,
        scopes: [],
      };
    return {
      id: "inbound-jwt",
      label: "Gateway inbound JWT",
      kind: "unsupported",
      native: "CUSTOM_JWT",
    };
  }
  if (gateway.authorizerType === "AWS_IAM")
    return {
      id: "inbound-iam",
      label: "Gateway inbound IAM",
      kind: "signature",
      scheme: "aws-sigv4",
    };
  if (gateway.authorizerType === "AUTHENTICATE_ONLY")
    return {
      id: "inbound-authenticate-only",
      label: "Gateway authenticate-only",
      kind: "signature",
      scheme: "aws-sigv4-authenticate-only",
    };
  return {
    id: "inbound-none",
    label: "Gateway without inbound authorization",
    kind: "none",
    reason: "anonymous",
  };
}

function gatewayIssues(gateway: GetGatewayResponse): CompatibilityIssue[] {
  const issues: CompatibilityIssue[] = [];
  if (gateway.authorizerType === "NONE")
    issues.push({
      code: "agentcore.gateway.no-inbound-authorization",
      category: "security",
      sourcePointer: "/authorizerType",
      dimension: "authorize",
      disposition: "rejected",
      severity: "blocking",
      executionImpact: "blocks-authorization",
      message:
        "The gateway performs no inbound authentication; any caller reaches its targets.",
      remediation:
        "Configure JWT or IAM inbound authorization before binding this gateway.",
    });
  if (gateway.authorizerType === "AUTHENTICATE_ONLY")
    issues.push({
      code: "agentcore.gateway.authorization-offloaded",
      category: "security",
      sourcePointer: "/authorizerType",
      dimension: "authorize",
      disposition: "native-extension",
      severity: "warning",
      executionImpact: "none",
      message:
        "The gateway authenticates the SigV4 caller but makes no authorization decision of its own.",
    });
  const supported = gateway.protocolConfiguration?.mcp?.supportedVersions;
  if (supported && !supported.includes(AGENTCORE_MCP_PROTOCOL_VERSION))
    issues.push({
      code: "agentcore.gateway.protocol-version",
      category: "version",
      sourcePointer: "/protocolConfiguration/mcp/supportedVersions",
      dimension: "invoke",
      disposition: "unsupported",
      severity: "blocking",
      executionImpact: "blocks-operation",
      message: `This adapter speaks MCP ${AGENTCORE_MCP_PROTOCOL_VERSION}; the gateway does not list it among its supported versions.`,
      remediation: `Add ${AGENTCORE_MCP_PROTOCOL_VERSION} to the gateway's supportedVersions, or bind the gateway through the MCP runtime client for ${AGENTCORE_MCP_LEGACY_VERSIONS.join(", ")}.`,
    });
  if (gateway.status !== "READY")
    issues.push({
      code: "agentcore.gateway.not-ready",
      category: "policy",
      sourcePointer: "/status",
      dimension: "invoke",
      disposition: "requires-configuration",
      severity: "warning",
      executionImpact: "blocks-operation",
      message: "The gateway is not READY; invocations may fail.",
    });
  return issues;
}

const EXPECTED_ACCOUNT_FREE = /:\d{12}:/;

/** Provenance a discovery row may carry: never an ARN, because an ARN carries the account number. */
function gatewayProvenance(
  gateway: { status: string; authorizerType: string; protocolType: string },
  region: string,
): Record<string, string> {
  return {
    region,
    status: gateway.status,
    authorizerType: gateway.authorizerType,
    protocolType: gateway.protocolType,
  };
}

export type AgentCoreAdapterOptions = {
  evidence?: NormalizedDefinition extends never ? never : undefined;
};

const configuration: ConfigurationRequirement[] = [
  {
    name: agentCoreConfigurationNames.accessKeyId,
    source: "host",
    classification: "secret",
    required: true,
    description:
      "Access key id of the AWS identity that may describe gateways and targets",
  },
  {
    name: agentCoreConfigurationNames.secretAccessKey,
    source: "host",
    classification: "secret",
    required: true,
    description: "Secret access key of the management identity",
  },
  {
    name: agentCoreConfigurationNames.sessionToken,
    source: "host",
    classification: "secret",
    required: false,
    description: "Session token when the management identity is temporary",
  },
  {
    name: agentCoreConfigurationNames.expiresAt,
    source: "host",
    classification: "public",
    required: false,
    description:
      "Expiry of temporary management credentials, so an expired key fails before it is used",
  },
  {
    name: agentCoreConfigurationNames.gatewayToken,
    source: "host",
    classification: "secret",
    required: false,
    description:
      "Bearer token of the gateway caller identity; never the management identity",
  },
  {
    name: agentCoreConfigurationNames.gatewayAccessKeyId,
    source: "host",
    classification: "secret",
    required: false,
    description:
      "Access key id of a separate caller identity for IAM inbound authorization",
  },
  {
    name: agentCoreConfigurationNames.gatewaySecretAccessKey,
    source: "host",
    classification: "secret",
    required: false,
    description: "Secret access key of the gateway caller identity",
  },
  {
    name: agentCoreConfigurationNames.gatewaySessionToken,
    source: "host",
    classification: "secret",
    required: false,
    description: "Session token of a temporary gateway caller identity",
  },
];

function digestOf(value: unknown): string {
  return createHash("sha256")
    .update(canonicalConnectorJson(value) ?? "")
    .digest("hex");
}

export function createAgentCoreGatewayAdapter(): ConnectorAdapter {
  const identity = {
    adapterVersion: AGENTCORE_ADAPTER_VERSION,
    runtime: "hosted-server" as const,
  };
  const unsupported = (
    dimension: CompatibilityIssue["dimension"],
    limitation: string,
  ) =>
    capabilityStatus(identity, {
      dimension,
      profile: AGENTCORE_CONTROL_PROFILE,
      implementation: "unsupported",
      limitations: [limitation],
    });

  const adapter: ConnectorAdapter = {
    id: AGENTCORE_ADAPTER_ID,
    ecosystem: "aws-agentcore",
    adapterVersion: AGENTCORE_ADAPTER_VERSION,
    runtime: "hosted-server",
    displayName: "AWS Bedrock AgentCore Gateway",
    description:
      "Discovers approved AgentCore gateways and targets with documented management reads, and invokes gateway tools over MCP with a caller identity kept separate from the management identity.",
    service: "aws-agentcore",
    support: "provider-backed",
    custody: ["host-owned", "external-execution-broker"],
    configuration,
    profiles: [AGENTCORE_CONTROL_PROFILE, AGENTCORE_MCP_PROFILE],
    capabilities(present) {
      const managementReady =
        present.has(agentCoreConfigurationNames.accessKeyId) &&
        present.has(agentCoreConfigurationNames.secretAccessKey);
      const callerReady =
        present.has(agentCoreConfigurationNames.gatewayToken) ||
        (present.has(agentCoreConfigurationNames.gatewayAccessKeyId) &&
          present.has(agentCoreConfigurationNames.gatewaySecretAccessKey));
      return [
        capabilityStatus(identity, {
          dimension: "discover",
          profile: AGENTCORE_CONTROL_PROFILE,
          evidence: "protocol-fixture",
          configuration: managementReady ? "ready" : "missing",
          limitations: [
            "Read-only: ListGateways, GetGateway, ListGatewayTargets, GetGatewayTarget",
            "Never creates gateways, targets, IAM roles or resource policies",
          ],
        }),
        capabilityStatus(identity, {
          dimension: "import",
          profile: AGENTCORE_CONTROL_PROFILE,
          evidence: "protocol-fixture",
          limitations: [
            "Tool identities are derived only from inline schemas; S3-hosted schemas and synchronized targets are reported as unverifiable",
          ],
        }),
        unsupported(
          "configure",
          "Gateway, target and credential-provider configuration stays in AWS",
        ),
        unsupported(
          "authorize",
          "The caller's inbound token comes from the gateway's own identity provider; this adapter never runs that flow",
        ),
        capabilityStatus(identity, {
          dimension: "verify",
          profile: AGENTCORE_MCP_PROFILE,
          evidence: "protocol-fixture",
          configuration: callerReady ? "ready" : "missing",
          limitations: [
            "The gateway reports no caller scopes on success; observed permissions stay empty",
            "A management read proves the deployment's identity, never the caller's",
          ],
        }),
        capabilityStatus(identity, {
          dimension: "invoke",
          profile: AGENTCORE_MCP_PROFILE,
          evidence: "protocol-fixture",
          configuration: callerReady ? "ready" : "missing",
          limitations: [
            `MCP ${AGENTCORE_MCP_PROTOCOL_VERSION} only; ${AGENTCORE_MCP_LEGACY_VERSIONS.join(", ")} belong to the MCP runtime client`,
            "Outbound target credentials are held by AgentCore Identity and are never supplied by Ceremony",
          ],
        }),
        unsupported("events", "A gateway publishes no events to subscribe to"),
        unsupported(
          "reconnect",
          "Caller credentials are replaced through host configuration, not by a provider flow",
        ),
        capabilityStatus(identity, {
          dimension: "disconnect",
          profile: AGENTCORE_CONTROL_PROFILE,
          evidence: "unit",
          limitations: [
            "Local only: gateways, targets and credential providers are never deleted",
          ],
        }),
        unsupported(
          "revoke",
          "Upstream revocation belongs to IAM or the gateway's identity provider",
        ),
        unsupported(
          "export",
          "A gateway binding is account-specific and is not exportable metadata",
        ),
        unsupported("delegate", "The gateway exposes tools, not delegated tasks"),
      ];
    },

    async discover(
      ctx: AdapterCallContext,
      input: DiscoverInput,
    ): Promise<DiscoverResult> {
      const management = resolveManagement(ctx.binding);
      const client = controlClient(ctx, management);
      const limit = input.limit ?? 50;
      if (!Number.isInteger(limit) || limit < 1 || limit > 1000)
        throw new ConnectorError("invalid-request", {
          detail: "agentcore.limit.invalid",
        });
      const call = { signal: ctx.signal };
      const scopeGateway = input.scope?.["gatewayIdentifier"];
      if (scopeGateway !== undefined) {
        /*
         * A caller may narrow discovery to a gateway, but not to one the host
         * has not approved: a cloud resource name supplied by a caller is a
         * request, never an authority.
         */
        const permitted =
          ctx.binding.permittedTargets.some(
            (target) => target.kind === "gateway" && target.id === scopeGateway,
          ) ||
          (() => {
            const settings = agentCoreSettings(ctx.binding);
            return settings.gateway?.gatewayIdentifier === scopeGateway;
          })();
        if (!permitted)
          throw new ConnectorError("denied", {
            detail: "agentcore.gateway.not-permitted",
          });
        const targets = await client.listGatewayTargets(
          scopeGateway,
          {
            maxResults: limit,
            ...(input.cursor ? { nextToken: input.cursor } : {}),
          },
          call,
        );
        const items: DiscoveredItem[] = [];
        const issues: CompatibilityIssue[] = [...targets.issues];
        for (const summary of targets.targets) {
          const detail = await client.getGatewayTarget(
            scopeGateway,
            summary.targetId,
            call,
          );
          const analysis = analyzeTarget(detail);
          issues.push(...analysis.issues);
          items.push({
            identity: {
              ...gatewayIdentity(
                management.region,
                `${scopeGateway}/targets/${summary.targetId}`,
                versionOf(summary.updatedAt),
              ),
            },
            displayName: summary.name,
            description: (summary.description ?? "").slice(0, 500),
            provenance: {
              region: management.region,
              status: summary.status,
              targetKind: analysis.kind,
              tools: String(analysis.toolNames.length),
              ...(analysis.outboundCredential
                ? { outboundCredential: analysis.outboundCredential }
                : {}),
              ...(analysis.privateEndpoint ? { privateEndpoint: "true" } : {}),
            },
            status: summary.status === "READY" ? "active" : "unknown",
          });
        }
        return {
          items,
          ...(targets.nextToken ? { nextCursor: targets.nextToken } : {}),
          freshness: {
            fetchedAt: targets.fetchedAt,
            stale: false,
            source: "live",
          },
          issues,
        };
      }
      const page = await client.listGateways(
        {
          maxResults: limit,
          ...(input.cursor ? { nextToken: input.cursor } : {}),
        },
        call,
      );
      const search = input.query?.toLowerCase();
      const items = page.gateways
        .filter((gateway) => !search || gateway.name.toLowerCase().includes(search))
        .map((gateway) => ({
          identity: gatewayIdentity(
            management.region,
            gateway.gatewayId,
            versionOf(gateway.updatedAt),
          ),
          displayName: gateway.name,
          description: (gateway.description ?? "").slice(0, 500),
          provenance: gatewayProvenance(gateway, management.region),
          status:
            gateway.status === "READY"
              ? ("active" as const)
              : ("unknown" as const),
        }));
      return {
        items,
        ...(page.nextToken ? { nextCursor: page.nextToken } : {}),
        freshness: { fetchedAt: page.fetchedAt, stale: false, source: "live" },
        issues: page.issues,
      };
    },

    /**
     * Imports a captured control-plane description: one `GetGateway` response
     * and the `GetGatewayTarget` responses of its targets, exactly as the host
     * read them. Nothing is fetched here and nothing in the document is
     * trusted; targets are analyzed against the gateway's documented support.
     */
    async import(
      ctx: AdapterCallContext,
      input: ImportInput,
    ): Promise<ImportOutcome> {
      const value = parseBoundedJsonBytes(input.bytes);
      const document = z
        .object({
          gateway: z.unknown(),
          targets: z.array(z.unknown()).max(256).default([]),
          region: z.string().regex(/^[a-z0-9-]{1,32}$/).optional(),
        })
        .safeParse(value);
      if (!document.success)
        throw new ConnectorError("invalid-request", {
          detail: "agentcore.import.shape",
        });
      const gateway = getGatewayResponseSchema.safeParse(document.data.gateway);
      if (!gateway.success)
        throw new ConnectorError("invalid-request", {
          detail: "agentcore.import.gateway",
        });
      const region =
        document.data.region ??
        (() => {
          const match = /^arn:aws(?:|-cn|-us-gov):bedrock-agentcore:([a-z0-9-]+):/.exec(
            gateway.data.gatewayArn,
          );
          return match?.[1] ?? "unknown";
        })();
      const issues: CompatibilityIssue[] = gatewayIssues(gateway.data);
      const capabilities: NativeCapability[] = [];
      const analyses: TargetAnalysis[] = [];
      document.data.targets.forEach((raw, index) => {
        const target = getGatewayTargetResponseSchema.safeParse(raw);
        if (!target.success) {
          issues.push({
            code: "agentcore.target.invalid",
            category: "structure",
            sourcePointer: `/targets/${index}`,
            dimension: "import",
            disposition: "rejected",
            severity: "warning",
            executionImpact: "none",
            message:
              "A target description did not match the documented shape and was skipped",
          });
          return;
        }
        const analysis = analyzeTarget(target.data);
        analyses.push(analysis);
        issues.push(...analysis.issues);
        capabilities.push(...analysis.capabilities);
      });
      const bytes = input.bytes;
      const digest = createHash("sha256").update(bytes).digest("hex");
      const sourceRef = `src:aws-agentcore:${digest}`;
      const capturedAt = new Date(ctx.environment.now()).toISOString();
      const definition: NormalizedDefinition = {
        schemaVersion: 1,
        definitionRef: `definition:aws-agentcore:${digest.slice(0, 32)}`,
        identity: gatewayIdentity(
          region,
          gateway.data.gatewayId,
          versionOf(gateway.data.updatedAt),
        ),
        sourceRef,
        normalizedDigest: digestOf({
          gateway: gateway.data.gatewayId,
          capabilities: capabilities.map((capability) => capability.nativeId),
        }),
        importer: { id: "aws-agentcore-importer", version: AGENTCORE_ADAPTER_VERSION },
        display: {
          name: gateway.data.name,
          description: (gateway.data.description ?? "AgentCore gateway").slice(
            0,
            500,
          ),
          ecosystem: "aws-agentcore",
          service: "aws-agentcore",
        },
        authentication: [authenticationForGateway(gateway.data)],
        configuration: [
          {
            name: agentCoreConfigurationNames.gatewayToken,
            source: "host",
            classification: "secret",
            required: gateway.data.authorizerType === "CUSTOM_JWT",
            description: "Bearer token of the gateway caller identity",
          },
        ],
        capabilities,
        events: [],
        declaredServers: gateway.data.gatewayUrl
          ? [{ url: gateway.data.gatewayUrl, status: "declared" as const }]
          : [],
        compatibility: {
          issues,
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
          targets: analyses.map((analysis) => ({
            targetId: analysis.targetId,
            name: analysis.targetName,
            kind: analysis.kind,
            tools: analysis.toolNames,
            blocked: analysis.blocked,
            privateEndpoint: analysis.privateEndpoint,
          })),
        },
      };
      return {
        source: {
          sourceRef,
          identity: definition.identity,
          format: {
            name: "aws-agentcore-control",
            version: AGENTCORE_CONTROL_PROFILE,
          },
          origin: input.origin,
          digest: { algorithm: "sha256", value: digest },
          byteLength: bytes.byteLength,
          mediaType: input.mediaType.split(";")[0]!.trim() || "application/json",
          capturedAt,
          adaptation: [],
          overlays: [],
        },
        definitions: [definition],
        issues,
        executableCandidates: capabilities.map(
          (capability) => capability.nativeId,
        ),
      };
    },

    async authorize(
      ctx: AdapterCallContext,
      intent: AuthorizationIntent,
    ): Promise<AuthorizationStart> {
      const gateway = resolveGateway(ctx.binding);
      if (intent.ownerKind === "user" && gateway.inbound.kind === "iam-sigv4")
        return {
          kind: "unsupported",
          code: "agentcore.inbound.workload-only",
        };
      const missing: string[] = [];
      if (gateway.inbound.kind === "oauth-jwt") {
        const name =
          gateway.inbound.configurationName ??
          agentCoreConfigurationNames.gatewayToken;
        if (
          gateway.inbound.source === "configuration" &&
          !(await ctx.environment.configuration.read(name))
        )
          missing.push(name);
      } else if (gateway.inbound.kind === "iam-sigv4") {
        for (const name of [
          gateway.inbound.credentials.accessKeyId,
          gateway.inbound.credentials.secretAccessKey,
        ])
          if (!(await ctx.environment.configuration.read(name)))
            missing.push(name);
      }
      if (missing.length > 0) return { kind: "configuration-required", missing };
      /*
       * There is nothing for Ceremony to start: the caller's token is issued
       * by the gateway's own identity provider and configured by the host.
       * Verification is the next honest step, not a fabricated handoff.
       */
      return { kind: "verify" };
    },

    async verify(ctx: AdapterCallContext): Promise<CompletionResult> {
      const settings = agentCoreSettings(ctx.binding);
      const claims: VerificationClaim[] = [];
      const observedAt = new Date(ctx.environment.now()).toISOString();
      const policyRevision = ctx.connection?.policyRevision ?? "policy:unknown";
      const bindingRevision = ctx.binding.revision;
      let gatewayId: string | undefined;
      if (settings.management) {
        const management = resolveManagement(ctx.binding);
        const client = controlClient(ctx, management);
        const target = settings.gateway?.gatewayIdentifier;
        if (target) {
          const described = await client.getGateway(target, {
            signal: ctx.signal,
          });
          gatewayId = described.gatewayId;
          claims.push({
            kind: "resource-access",
            evidenceRef: `evidence:agentcore-management:${described.gatewayId}`,
            issuer: "provider",
            target: { kind: "gateway", id: described.gatewayId },
            observedAt,
            verifierVersion: AGENTCORE_ADAPTER_VERSION,
            bindingRevision,
            policyRevision,
            limitations: [
              "The management identity may describe this gateway; that is not the caller's authority to invoke it",
            ],
          });
        }
      }
      if (!settings.gateway) {
        if (claims.length === 0)
          throw new ConnectorError("configuration-required", {
            detail: "agentcore.verify.nothing-bound",
          });
        return { state: "pending", claims, code: "agentcore.caller.unbound" };
      }
      const gateway = resolveGateway(ctx.binding);
      const listing = await withCallerAuthorization(ctx, gateway, (authorization) =>
        gatewayClientFor(ctx, gateway, authorization).listTools(
          { requestId: ctx.environment.random.uuid() },
          { signal: ctx.signal },
        ),
      );
      claims.push({
        kind: "credential-accepted",
        evidenceRef: `evidence:agentcore-caller:${gateway.gatewayIdentifier}`,
        issuer: "provider",
        target: { kind: "gateway", id: gateway.gatewayIdentifier },
        observedAt,
        verifierVersion: AGENTCORE_ADAPTER_VERSION,
        bindingRevision,
        policyRevision,
        permissions: {
          requested: [],
          reported: [],
          observed: [],
          semantics: "unknown",
        },
        limitations: [
          "The gateway accepted the caller's credential; it reports no granted scopes and no account identity",
          "Tool availability is the gateway's aggregate view, not proof of any target's own authorization",
        ],
      });
      return {
        state: "complete",
        claims,
        target: { kind: "gateway", id: gateway.gatewayIdentifier },
        adapterState: {
          tools: listing.tools.map((tool) => tool.name).slice(0, 256),
          searchToolPresent: listing.searchToolPresent,
          ...(gatewayId ? { describedGatewayId: gatewayId } : {}),
        },
      };
    },

    async invoke(
      ctx: AdapterCallContext,
      request: InvokeRequest,
    ): Promise<InvokeResult> {
      const gateway = resolveGateway(ctx.binding);
      const bound = boundOperation(ctx.binding, request.operationRef);
      if (!bound)
        throw new ConnectorError("denied", {
          detail: "agentcore.operation.unapproved",
        });
      if (bound.transport.kind !== "mcp-tool")
        throw new ConnectorError("invalid-request", {
          detail: "agentcore.operation.transport",
        });
      const approved = destinationFor(ctx.binding, bound);
      if (approved.id !== gateway.destination.id)
        throw new ConnectorError("network-policy", {
          detail: "agentcore.operation.destination",
        });
      const toolName = bound.transport.toolName;
      const split = splitGatewayToolName(toolName);
      if (!split)
        throw new ConnectorError("invalid-request", {
          detail: "agentcore.tool.not-namespaced",
        });
      const permitted = ctx.binding.permittedTargets.some(
        (target) =>
          target.kind === "agentcore-target" && target.id === split.targetName,
      );
      if (!permitted)
        throw new ConnectorError("denied", {
          detail: "agentcore.target.not-permitted",
        });
      if (
        gateway.privateTargets.includes(split.targetName) &&
        approved.network !== "approved-private"
      )
        throw new ConnectorError("network-policy", {
          detail: "agentcore.target.private-endpoint",
        });
      if (
        request.input === null ||
        typeof request.input !== "object" ||
        Array.isArray(request.input)
      )
        throw new ConnectorError("invalid-request", {
          detail: "agentcore.arguments.shape",
        });
      const measured = measureJsonValue(request.input);
      if (!measured.ok)
        throw new ConnectorError("invalid-request", {
          detail: "agentcore.arguments.bounds",
        });
      const args = request.input as Record<string, unknown>;
      for (const name of bound.targetParameters) {
        const value = args[name];
        if (typeof value !== "string")
          throw new ConnectorError("invalid-request", {
            detail: "agentcore.target-parameter.missing",
          });
        if (
          !ctx.binding.permittedTargets.some(
            (target) => target.id === value && target.kind !== "gateway",
          )
        )
          throw new ConnectorError("denied", {
            detail: "agentcore.target-parameter.not-permitted",
          });
      }

      const journaled = bound.effect !== "read";
      const digest = digestOf([
        gateway.gatewayIdentifier,
        request.operationRef,
        toolName,
        args,
        request.commandId,
      ]);
      const journal = journaled
        ? await ctx.environment.effects.begin({
            actor: ctx.actor,
            ...(ctx.connection
              ? { connectionRef: ctx.connection.connectionRef }
              : {}),
            bindingRef: ctx.binding.bindingRef,
            operation: `agentcore.tools.call.${request.operationRef}`,
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
          code: "agentcore.effect.replayed",
        };

      let result: GatewayCallResult;
      try {
        result = await withCallerAuthorization(ctx, gateway, (authorization) =>
          gatewayClientFor(ctx, gateway, authorization).callTool(
            {
              name: toolName,
              arguments: args,
              requestId: ctx.environment.random.uuid(),
            },
            { signal: ctx.signal },
          ),
        );
      } catch (error) {
        if (error instanceof GatewayTransportUncertain) {
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
            code: "agentcore.call.uncertain",
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
        throw error;
      }

      if (result.resultType === "input_required") {
        /*
         * A multi round-trip interim result: the gateway needs more input from
         * a person. The request stays open in the journal, the values are
         * collected privately, and nothing of the interim payload reaches a
         * model-visible result.
         */
        return {
          state: "human-required",
          outputClassification: bound.outputClassification,
          effect: bound.effect,
          ...(journal ? { effectRef: journal.effectRef } : {}),
          code: "agentcore.call.input-required",
          handoff: {
            kind: "input-required",
            presentation: "in-app",
            expiresAt: ctx.environment.now() + 10 * 60_000,
            intent: "agentcore.tool.input",
            private: {
              toolName,
              operationRef: request.operationRef,
              commandId: request.commandId,
            },
          },
        };
      }
      if (journal)
        await ctx.environment.effects.complete(journal.effectRef, {
          status: result.isError ? "failed" : "applied",
          at: ctx.environment.now(),
          ...(result.isError ? { code: "agentcore.tool.error" } : {}),
        });
      if (result.isError)
        return {
          state: "failed",
          outputClassification: bound.outputClassification,
          effect: bound.effect,
          ...(journal ? { effectRef: journal.effectRef } : {}),
          code: "agentcore.tool.error",
        };
      return {
        state: "complete",
        output: {
          ...(result.content ? { content: result.content } : {}),
          ...(result.structuredContent !== undefined
            ? { structuredContent: result.structuredContent }
            : {}),
        },
        outputClassification: bound.outputClassification,
        effect: bound.effect,
        ...(journal ? { effectRef: journal.effectRef } : {}),
      };
    },

    async disconnect(
      _ctx: AdapterCallContext,
      scope: DisconnectScope,
    ): Promise<DisconnectResult> {
      /*
       * Local only, always. Deleting a gateway or a target would remove shared
       * AWS configuration that other callers depend on, and nothing about a
       * local disconnect authorizes that.
       */
      return {
        local: "applied",
        broker: scope === "broker" ? "unsupported" : "not-attempted",
        upstream: scope === "upstream" ? "unsupported" : "not-attempted",
      };
    },
  };
  return adapter;
}

/** Exposed so a host can assert that no ARN — and so no account number — leaves the adapter. */
export const containsAwsAccountNumber = (value: string): boolean =>
  EXPECTED_ACCOUNT_FREE.test(value);
