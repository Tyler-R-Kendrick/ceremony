import type {
  CapabilityStatus,
  ConfigurationRequirement,
  ConnectorAdapter,
} from "../../adapter.js";
import { capabilityStatus } from "../../adapter.js";
import { boundOperation, type BoundOperation } from "../../binding.js";
import { ConnectorError } from "../../errors.js";
import {
  authorizeStart,
  completeAuthorization,
  disconnectConnection,
  invokeProviderOperation,
  revokeGrant,
  verifyConnection,
  type AuthorizationOptions,
} from "./authorization.js";
import {
  vercelConfigurationNames,
  vercelConnectOperationTable,
  vercelManagementOperationIds,
  vercelOperationRef,
  VERCEL_SOURCE_PROFILE,
  type VercelManagementOperationId,
} from "./contracts.js";
import type { WorkloadTokenSource } from "./credentials.js";
import { createVercelTriggerEvents } from "./events.js";
import {
  defaultAdminPolicy,
  discoverConnectors,
  invokeManagement,
  managementOperationFor,
  type VercelAdminPolicy,
} from "./management.js";

export * from "./contracts.js";
export {
  credentialRole,
  resolveCredential,
  withBearer,
  type ManagementCredential,
  type RoleCredential,
  type WorkloadCredential,
  type WorkloadTokenSource,
} from "./credentials.js";
export { callVercel, operationPath, operationUrl } from "./client.js";
export {
  acquireToken,
  connectionState,
  judgeIdentity,
  requestedScopes,
  subjectFor,
  vercelConnectionStateSchema,
  verificationFor,
  type VercelConnectionState,
  type Verification,
} from "./authorization.js";
export {
  assertTransportMatches,
  defaultAdminPolicy,
  projectConnector,
  type VercelAdminPolicy,
} from "./management.js";
export {
  createVercelTriggerEvents,
  type ForwarderHop,
  type VercelForwardedEvent,
} from "./events.js";
export {
  assessConnectProviderConformance,
  discoveryLocations,
  type ConformanceFinding,
  type ConformanceExercise,
  type ProviderConformanceReport,
} from "./provider-conformance.js";

export const VERCEL_CONNECT_ADAPTER_ID = "vercel-connect";
export const VERCEL_CONNECT_ADAPTER_VERSION = "1.0.0";

export type VercelConnectAdapterOptions = {
  /** Administrative policy for create/update/delete/link/unlink; defaults to the host `admin` capability. */
  administer?: VercelAdminPolicy;
  /** Host-supplied workload identity (for example the deployment OIDC token); configuration is the fallback. */
  workloadToken?: WorkloadTokenSource;
};

const configuration: readonly ConfigurationRequirement[] = [
  {
    name: vercelConfigurationNames.teamId,
    source: "host",
    classification: "public",
    required: true,
    description: "Vercel team that owns the connectors; scopes every management call.",
  },
  {
    name: vercelConfigurationNames.managementToken,
    source: "host",
    classification: "secret",
    required: false,
    description:
      "Host-configured team access token for connector and project-link administration; never a user's personal token.",
  },
  {
    name: vercelConfigurationNames.workloadToken,
    source: "host",
    classification: "secret",
    required: true,
    description:
      "Deployment workload identity (OIDC or project-scoped access token) used to acquire provider tokens.",
  },
  {
    name: vercelConfigurationNames.teamSlug,
    source: "host",
    classification: "public",
    required: false,
    description: "Team slug for forwarded-trigger audience checks.",
  },
];

/** Bound management operations with the documented transport, ready for a host binding. */
export function vercelManagementBoundOperations(
  overrides: Partial<Pick<BoundOperation, "consent" | "cost">> = {},
): BoundOperation[] {
  return vercelManagementOperationIds.map((id) => {
    const operation = vercelConnectOperationTable[id];
    return {
      operationRef: vercelOperationRef(id),
      nativeId: id,
      destinationId: "api",
      transport: {
        kind: "http",
        method: operation.method,
        pathTemplate: operation.pathTemplate,
      },
      effect: operation.effect,
      outputClassification: "personal",
      cost: overrides.cost ?? "free",
      consent: overrides.consent ?? (operation.admin ? "confirm" : "none"),
      replay: operation.replay,
      targetParameters: [],
      description: operation.summary,
    };
  });
}

export function createVercelConnectAdapter(
  options: VercelConnectAdapterOptions = {},
): ConnectorAdapter {
  const authorization: AuthorizationOptions = {
    policy: options.administer ?? defaultAdminPolicy,
    ...(options.workloadToken ? { workloadToken: options.workloadToken } : {}),
    verifierVersion: VERCEL_CONNECT_ADAPTER_VERSION,
  };
  const adapter: ConnectorAdapter = {
    id: VERCEL_CONNECT_ADAPTER_ID,
    ecosystem: "vercel-connect",
    adapterVersion: VERCEL_CONNECT_ADAPTER_VERSION,
    runtime: "hosted-server",
    displayName: "Vercel Connect",
    description:
      "Team connectors and project links administered with a host management token; provider tokens acquired through Connect with the deployment's workload identity and kept in broker custody.",
    service: "vercel",
    support: "provider-backed",
    custody: ["host-owned", "external-credential-broker"],
    configuration,
    profiles: [VERCEL_SOURCE_PROFILE, "external-broker"],
    capabilities(present) {
      const workload = present.has(vercelConfigurationNames.teamId) &&
        present.has(vercelConfigurationNames.workloadToken)
        ? "ready"
        : "missing";
      const management = present.has(vercelConfigurationNames.teamId) &&
        present.has(vercelConfigurationNames.managementToken)
        ? "ready"
        : "missing";
      const status = (
        dimension: CapabilityStatus["dimension"],
        configurationState: CapabilityStatus["configuration"],
        limitations: string[] = [],
        implementation: CapabilityStatus["implementation"] = "implemented",
      ) =>
        capabilityStatus(adapter, {
          dimension,
          profile: VERCEL_SOURCE_PROFILE,
          implementation,
          configuration: configurationState,
          evidence: implementation === "implemented" ? "protocol-fixture" : "not-tested",
          limitations,
        });
      return [
        status("discover", management, ["Lists the configured team's connectors through the management credential."]),
        status("import", "not-applicable", [], "unsupported"),
        status("configure", "not-applicable"),
        status("authorize", workload, [
          "User and federated subjects consent through Vercel's hosted authorization request; app subjects have no consent leg.",
          "Installations are created by the provider install flow; the adapter never synthesizes an installation id.",
        ]),
        status("verify", workload, [
          "Identity comes from the token response (externalSubject, installationId, tenantId); Vercel does not report granted scopes.",
        ]),
        status("invoke", management, [
          "Management operations use the documented per-operation versions; provider calls use the custody token.",
        ]),
        status("events", workload, [
          "Forwarded triggers are authenticated by Vercel's OIDC bearer token, which does not bind the body bytes.",
        ]),
        status("reconnect", workload),
        status("disconnect", management, [
          "Broker scope unlinks this project only; upstream scope refuses to delete a connector other projects still use.",
        ]),
        status("revoke", workload, [
          "Grant revocation uses an endpoint observed in @vercel/connect 2.3.0 that the REST reference does not document; it is opt-in per binding.",
        ]),
        status("export", "not-applicable", [], "unsupported"),
        status("delegate", "not-applicable", [], "unsupported"),
      ];
    },
    discover: (ctx, input) => discoverConnectors(ctx, input),
    authorize: (ctx, intent) => authorizeStart(ctx, intent, authorization, "authorize"),
    complete: (ctx, input) => completeAuthorization(ctx, input, authorization),
    verify: (ctx) => verifyConnection(ctx, authorization),
    async invoke(ctx, request) {
      const bound = boundOperation(ctx.binding, request.operationRef);
      if (!bound)
        throw new ConnectorError("denied", { detail: "vercel.operation.unbound" });
      const management: VercelManagementOperationId | undefined =
        managementOperationFor(bound);
      if (management)
        return invokeManagement(ctx, request, bound, management, authorization);
      return invokeProviderOperation(ctx, request, bound, authorization);
    },
    events: createVercelTriggerEvents(),
    reconnect: (ctx, intent) => authorizeStart(ctx, intent, authorization, "reconnect"),
    disconnect: (ctx, scope) => disconnectConnection(ctx, scope, authorization),
    revoke: (ctx) => revokeGrant(ctx, authorization),
  };
  return adapter;
}
