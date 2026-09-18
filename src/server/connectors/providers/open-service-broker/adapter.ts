import { z } from "zod";
import type {
  CapabilityStatus,
  ConfigurationRequirement,
  SupportDimension,
  VerificationClaim,
} from "../../../../core/connectors/index.js";
import type { EvidenceLevel } from "../../../../core/connectors/identity.js";
import { identifierSchema } from "../../../../core/operation-contracts.js";
import {
  capabilityStatus,
  type AdapterCallContext,
  type CompletionResult,
  type ConnectorAdapter,
  type DiscoverInput,
  type DiscoverResult,
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
import { sha256Hex } from "../../import/parse.js";
import type { CredentialScope } from "../../ports.js";
import {
  basicAuthorization,
  createOpenServiceBrokerClient,
  originatingIdentity,
  type OpenServiceBrokerClient,
  type OsbRequestOptions,
} from "./client.js";
import {
  importOpenServiceBrokerCatalog,
  osbSourceRecord,
  summarizeService,
  type OsbServiceSummary,
} from "./import.js";
import {
  OSB_ADAPTER_VERSION,
  OSB_API_VERSION,
  OSB_ECOSYSTEM,
  OSB_PROFILE,
  OSB_ROUTES,
  OSB_SOURCE,
  osbIdentifierSchema,
  type OsbBinding,
} from "./schemas.js";

/*
 * The Open Service Broker adapter: a non-provisioning inspection profile.
 *
 * It reads a catalog, inspects an existing Service Instance and an existing
 * Service Binding, and polls the two `last_operation` endpoints when a broker
 * reports an operation still in progress. That is the whole surface. There is
 * no provision, deprovision, update, bind or unbind request builder anywhere in
 * this module, and every bound operation must be a GET, so the default profile
 * cannot issue a state-changing request even if a binding asked it to.
 *
 * Retrieved binding credentials are private custody data: they go straight
 * into CredentialCustodyPort and a reference comes back. No projection, result
 * or error this adapter produces contains a credential value.
 */

export const OSB_ADAPTER_ID = "open-service-broker";
export const OSB_USERNAME_CONFIGURATION = "OSB_BROKER_USERNAME";
export const OSB_PASSWORD_CONFIGURATION = "OSB_BROKER_PASSWORD";

export const OSB_OPERATIONS = Object.freeze({
  catalog: "osb.catalog.read",
  instance: "osb.instance.fetch",
  instanceLastOperation: "osb.instance.last-operation",
  binding: "osb.binding.fetch",
  bindingLastOperation: "osb.binding.last-operation",
});

/** Route prefixes an operation of each kind must be bound to. */
const OPERATION_PATHS: Readonly<Record<string, string>> = Object.freeze({
  [OSB_OPERATIONS.catalog]: OSB_ROUTES.catalog,
  [OSB_OPERATIONS.instance]: "/v2/service_instances",
  [OSB_OPERATIONS.instanceLastOperation]: "/v2/service_instances",
  [OSB_OPERATIONS.binding]: "/v2/service_instances",
  [OSB_OPERATIONS.bindingLastOperation]: "/v2/service_instances",
});

const configuration: ConfigurationRequirement[] = [
  {
    name: OSB_USERNAME_CONFIGURATION,
    source: "host",
    classification: "personal",
    required: false,
    description:
      "Basic-auth user the platform presents to the broker; unused when the connection holds host-owned credentials",
  },
  {
    name: OSB_PASSWORD_CONFIGURATION,
    source: "host",
    classification: "secret",
    required: false,
    description: "Basic-auth password the platform presents to the broker",
  },
];

/**
 * `binding.settings.broker`: which approved destination is the broker, how the
 * platform authenticates to it, and the catalog snapshot this binding was
 * reviewed against. The catalog snapshot is what decides whether a fetch
 * endpoint may be called; it is host-approved and never re-read from a caller.
 */
export const osbBindingSettingsSchema = z.strictObject({
  destinationId: identifierSchema,
  brokerId: z.string().min(1).max(200),
  credentials: z
    .strictObject({
      kind: z.literal("basic"),
      usernameConfiguration: z.string().regex(/^[A-Z][A-Z0-9_]{0,95}$/),
      passwordConfiguration: z.string().regex(/^[A-Z][A-Z0-9_]{0,95}$/),
    })
    .optional(),
  /**
   * Retrievability, plan bindability and free/paid, exactly as the reviewed
   * catalog declared them. A broker that later changes its catalog produces a
   * new binding revision; it never silently widens this one.
   */
  services: z
    .array(
      z.strictObject({
        serviceId: osbIdentifierSchema,
        instancesRetrievable: z.boolean(),
        bindingsRetrievable: z.boolean(),
        bindable: z.boolean(),
      }),
    )
    .max(512),
  /** Whether the platform declares async support on reads; reads are synchronous, so this is false. */
  acceptsIncomplete: z.literal(false).default(false),
});
export type OsbBindingSettings = z.infer<typeof osbBindingSettingsSchema>;

export type ResolvedOsbBroker = {
  settings: OsbBindingSettings;
  destination: ApprovedDestination;
};

export function osbBrokerFromBinding(
  binding: RuntimeBinding,
): ResolvedOsbBroker {
  const raw = binding.settings["broker"];
  if (raw === undefined)
    throw new ConnectorError("configuration-required", {
      detail: "osb.settings.missing",
    });
  const parsed = osbBindingSettingsSchema.safeParse(raw);
  if (!parsed.success)
    throw new ConnectorError("invalid-request", {
      detail: "osb.settings.invalid",
    });
  const destination = binding.destinations.find(
    (item) => item.id === parsed.data.destinationId,
  );
  if (!destination)
    throw new ConnectorError("network-policy", {
      detail: "osb.destination-unapproved",
    });
  return { settings: parsed.data, destination };
}

/** The reviewed retrievability facts for one offering; an unknown offering is not a lookup miss. */
export function reviewedService(
  settings: OsbBindingSettings,
  serviceId: string,
): OsbBindingSettings["services"][number] {
  const service = settings.services.find(
    (item) => item.serviceId === serviceId,
  );
  if (!service)
    throw new ConnectorError("denied", { detail: "osb.service.unapproved" });
  return service;
}

const instanceInputSchema = z.strictObject({
  instanceId: osbIdentifierSchema,
  serviceId: osbIdentifierSchema,
  planId: osbIdentifierSchema.optional(),
  operation: z.string().max(10_000).optional(),
});
const bindingInputSchema = instanceInputSchema.safeExtend({
  bindingId: osbIdentifierSchema,
});

/**
 * A retrieved Service Binding with the credential removed. `credentialRef`
 * points at private custody; everything else is connection information a host
 * may show.
 */
export type OsbBindingProjection = {
  credentialRef?: string;
  credentialKeys: string[];
  endpoints: Array<{ host: string; ports: string[]; protocol?: string }>;
  expiresAt?: string;
  renewBefore?: string;
  /** Present only when the catalog declared the matching `requires` entry. */
  syslogDrainDeclared: boolean;
  routeServiceDeclared: boolean;
  volumeMountCount: number;
};

/**
 * Splits a binding response into the part that may be shown and the part that
 * must not be. The credential value never appears in the returned projection,
 * only the names of its keys, so a reviewer can see the shape of what was
 * stored without the value entering a result, a log or an error.
 */
export function projectOsbBinding(binding: OsbBinding): {
  projection: Omit<OsbBindingProjection, "credentialRef">;
  credentials?: Record<string, string>;
} {
  const raw = binding.credentials ?? {};
  const keys = Object.keys(raw).sort();
  const credentials: Record<string, string> = {};
  for (const key of keys) {
    const value = raw[key];
    credentials[key] =
      typeof value === "string" ? value : JSON.stringify(value ?? null);
  }
  return {
    projection: {
      credentialKeys: keys,
      endpoints: (binding.endpoints ?? []).map((endpoint) => ({
        host: endpoint.host,
        ports: [...endpoint.ports],
        ...(endpoint.protocol ? { protocol: endpoint.protocol } : {}),
      })),
      ...(binding.metadata?.expires_at
        ? { expiresAt: binding.metadata.expires_at }
        : {}),
      ...(binding.metadata?.renew_before
        ? { renewBefore: binding.metadata.renew_before }
        : {}),
      syslogDrainDeclared: binding.syslog_drain_url !== undefined,
      routeServiceDeclared: binding.route_service_url !== undefined,
      volumeMountCount: (binding.volume_mounts ?? []).length,
    },
    ...(keys.length > 0 ? { credentials } : {}),
  };
}

export type OsbAdapterOptions = {
  evidence?: EvidenceLevel;
  limits?: Parameters<typeof createOpenServiceBrokerClient>[0]["limits"];
};

const unsupportedDimensions: SupportDimension[] = [
  "authorize",
  "events",
  "reconnect",
  "revoke",
  "export",
  "delegate",
];

export function createOpenServiceBrokerAdapter(
  options: OsbAdapterOptions = {},
): ConnectorAdapter {
  const evidence = options.evidence ?? "protocol-fixture";
  const identity = {
    adapterVersion: OSB_ADAPTER_VERSION,
    runtime: "hosted-server" as const,
  };

  const credentialScope = (ctx: AdapterCallContext): CredentialScope => {
    const connection = ctx.connection;
    if (!connection)
      throw new ConnectorError("denied", { detail: "osb.connection.required" });
    return {
      tenantId: connection.tenantId,
      ownerKind: connection.ownerKind,
      ownerId: connection.ownerId,
      connectionRef: connection.connectionRef,
      bindingRef: ctx.binding.bindingRef,
      custody: connection.custody,
    };
  };

  /**
   * Builds the Authorization header inside the credential boundary. When the
   * binding names configuration entries, those are used; otherwise the
   * connection's host-owned credential is opened through the custody port.
   * Either way the value is produced and consumed in one place.
   */
  const authorizationFor =
    (ctx: AdapterCallContext, settings: OsbBindingSettings) =>
    async (): Promise<string | undefined> => {
      if (settings.credentials) {
        const [username, password] = await Promise.all([
          ctx.environment.configuration.read(
            settings.credentials.usernameConfiguration,
          ),
          ctx.environment.configuration.read(
            settings.credentials.passwordConfiguration,
          ),
        ]);
        if (!username || !password)
          throw new ConnectorError("configuration-required", {
            detail: "osb.credentials.missing",
          });
        return basicAuthorization(username, password);
      }
      const credentialRef = ctx.connection?.credentialRef;
      if (!credentialRef) return undefined;
      return ctx.environment.credentials.use(
        credentialScope(ctx),
        credentialRef,
        async (material) => {
          const username = material["username"];
          const password = material["password"];
          if (!username || !password)
            throw new ConnectorError("expired", {
              detail: "osb.credentials.empty",
            });
          return basicAuthorization(username, password);
        },
      );
    };

  const clientFor = (
    ctx: AdapterCallContext,
    broker: ResolvedOsbBroker,
  ): OpenServiceBrokerClient =>
    createOpenServiceBrokerClient({
      destination: broker.destination,
      fetch: ctx.environment.fetch,
      authorization: authorizationFor(ctx, broker.settings),
      ...(options.limits ? { limits: options.limits } : {}),
      now: ctx.environment.now,
    });

  const requestOptions = (ctx: AdapterCallContext): OsbRequestOptions => ({
    signal: ctx.signal,
    requestId: ctx.environment.random.uuid(),
    /*
     * The header is only included for a request a person actually initiated;
     * the spec says a catalog refetch or other unattended read MAY omit it,
     * and attaching a person to an unattended read would be a false record.
     */
    ...(ctx.actor.actorKind === "human"
      ? { originatingIdentity: originatingIdentity(ctx.actor) }
      : {}),
  });

  /**
   * Every bound operation must be a GET at the route its kind requires. A
   * binding that named PUT, PATCH or DELETE is refused here, which is what
   * makes "no provisioning request in the default profile" a property of the
   * code rather than of the caller's good behaviour.
   */
  const assertReadOnlyOperation = (
    ctx: AdapterCallContext,
    operationRef: string,
    broker: ResolvedOsbBroker,
  ) => {
    const operation = boundOperation(ctx.binding, operationRef);
    if (!operation)
      throw new ConnectorError("not-found", {
        detail: "osb.operation.unknown",
      });
    if (operation.transport.kind !== "http")
      throw new ConnectorError("invalid-request", {
        detail: "osb.operation.transport",
      });
    if (operation.transport.method !== "GET")
      throw new ConnectorError("denied", {
        detail: "osb.operation.not-read-only",
      });
    if (operation.effect !== "read")
      throw new ConnectorError("denied", {
        detail: "osb.operation.not-read-only",
      });
    const expectedPrefix = OPERATION_PATHS[operationRef];
    if (
      !expectedPrefix ||
      !operation.transport.pathTemplate.startsWith(expectedPrefix)
    )
      throw new ConnectorError("denied", { detail: "osb.operation.path" });
    const destination = destinationFor(ctx.binding, operation);
    if (destination.id !== broker.destination.id)
      throw new ConnectorError("network-policy", {
        detail: "osb.operation.destination-mismatch",
      });
    return operation;
  };

  /** Targets a caller may name are the ones the connection was permitted. */
  const assertPermittedTarget = (
    ctx: AdapterCallContext,
    kind: "service-instance" | "service-binding",
    id: string,
  ) => {
    const permitted = ctx.binding.permittedTargets.filter(
      (target) => target.kind === kind,
    );
    if (permitted.length === 0) return;
    if (!permitted.some((target) => target.id === id))
      throw new ConnectorError("denied", { detail: "osb.target.unpermitted" });
  };

  const adapter: ConnectorAdapter = {
    id: OSB_ADAPTER_ID,
    ecosystem: OSB_ECOSYSTEM,
    adapterVersion: OSB_ADAPTER_VERSION,
    runtime: "hosted-server",
    displayName: "Open Service Broker",
    description: `Reads an Open Service Broker API ${OSB_API_VERSION} catalog and inspects existing Service Instances and Service Bindings. Provisioning, deprovisioning, binding creation and plan changes are unavailable; no such request is issued.`,
    service: "open-service-broker",
    support: "provider-backed",
    custody: ["host-owned"],
    configuration,
    profiles: [OSB_PROFILE, "http-basic"],
    capabilities(present) {
      const configured =
        present.has(OSB_USERNAME_CONFIGURATION) &&
        present.has(OSB_PASSWORD_CONFIGURATION);
      const provisioningLimitation =
        "Provision, deprovision, update, bind and unbind are not implemented: this adapter has no request builder for them and every bound operation must be a GET.";
      const rows: CapabilityStatus[] = [
        capabilityStatus(identity, {
          dimension: "discover",
          profile: OSB_PROFILE,
          evidence,
          configuration: configured ? "ready" : "not-applicable",
          limitations: [
            `Pinned to ${OSB_SOURCE.tag} of the specification; the platform declares ${OSB_API_VERSION} and a broker that rejects it is reported unsupported, never retried at another version.`,
          ],
        }),
        capabilityStatus(identity, {
          dimension: "import",
          profile: OSB_PROFILE,
          evidence,
          limitations: [
            "instances_retrievable and bindings_retrievable are carried through exactly as declared; an absent flag means the endpoint is unsupported.",
          ],
        }),
        capabilityStatus(identity, {
          dimension: "configure",
          profile: OSB_PROFILE,
          evidence,
          limitations: [
            "A binding pins one broker destination, its basic-auth configuration and the reviewed retrievability of each offering.",
          ],
        }),
        capabilityStatus(identity, {
          dimension: "verify",
          profile: OSB_PROFILE,
          evidence,
          configuration: configured ? "ready" : "missing",
          limitations: [
            "Verification reads an existing instance and records what the broker asserted about it; a broker's statement is not proof of the underlying resource.",
            "An offering that does not declare instances_retrievable cannot be verified this way, and that is reported rather than worked around.",
          ],
        }),
        capabilityStatus(identity, {
          dimension: "invoke",
          profile: OSB_PROFILE,
          evidence,
          configuration: configured ? "ready" : "missing",
          limitations: [
            provisioningLimitation,
            "Retrieved binding credentials are stored through CredentialCustodyPort; results carry a reference and the credential key names, never a value.",
            "Native asynchronous status is read from last_operation; an in-progress operation stays in progress and is never reported as complete.",
          ],
        }),
        capabilityStatus(identity, {
          dimension: "disconnect",
          profile: OSB_PROFILE,
          evidence: "unit",
          limitations: [
            "Local disconnect only. Unbinding and deprovisioning are separate upstream effects this profile does not perform, so forgetting a connection never deletes a binding or an instance.",
          ],
        }),
      ];
      for (const dimension of unsupportedDimensions)
        rows.push(
          capabilityStatus(identity, {
            dimension,
            profile: OSB_PROFILE,
            implementation: "unsupported",
            limitations: [
              dimension === "authorize"
                ? "Platform-to-broker authentication is basic auth configured by the host; there is no end-user authorization flow to run."
                : dimension === "events"
                  ? "The specification defines no broker-to-platform event delivery; a platform polls last_operation instead."
                  : "The specification defines no such platform operation.",
            ],
          }),
        );
      return rows;
    },

    async discover(
      ctx: AdapterCallContext,
      _input: DiscoverInput,
    ): Promise<DiscoverResult> {
      const broker = osbBrokerFromBinding(ctx.binding);
      assertReadOnlyOperation(ctx, OSB_OPERATIONS.catalog, broker);
      const client = clientFor(ctx, broker);
      const response = await client.catalog(requestOptions(ctx));
      const services = response.value.services.map(summarizeService);
      return {
        items: services.map((service) => ({
          identity: {
            ecosystem: OSB_ECOSYSTEM,
            authorityNamespace: broker.settings.brokerId.slice(0, 256),
            nativeId: service.serviceId,
            nativeVersion: OSB_API_VERSION,
          },
          displayName: service.name.slice(0, 200),
          description: (
            response.value.services.find(
              (item) => item.id === service.serviceId,
            )?.description ?? ""
          ).slice(0, 500),
          provenance: {
            broker: broker.settings.brokerId,
            bindable: String(service.bindable),
            instancesRetrievable: String(service.instancesRetrievable),
            bindingsRetrievable: String(service.bindingsRetrievable),
            freePlans: String(service.plans.filter((plan) => plan.free).length),
            paidPlans: String(
              service.plans.filter((plan) => !plan.free).length,
            ),
          },
          status: "active",
        })),
        freshness: {
          fetchedAt: response.fetchedAt,
          stale: false,
          source: "live",
        },
        issues: response.issues,
      };
    },

    async import(
      ctx: AdapterCallContext,
      input: ImportInput,
    ): Promise<ImportOutcome> {
      const broker = (() => {
        try {
          return osbBrokerFromBinding(ctx.binding);
        } catch {
          return undefined;
        }
      })();
      const brokerId = broker?.settings.brokerId ?? "unbound-broker";
      let document: unknown;
      try {
        document = JSON.parse(
          new TextDecoder("utf-8", { fatal: true }).decode(input.bytes),
        ) as unknown;
      } catch {
        throw new ConnectorError("invalid-request", {
          detail: "osb.catalog.invalid",
        });
      }
      const capturedAt = new Date(ctx.environment.now()).toISOString();
      const sourceRef = `src:osb:${sha256Hex(input.bytes)}`;
      const imported = await importOpenServiceBrokerCatalog(document, {
        sourceRef,
        origin: input.origin,
        brokerId,
        capturedAt,
      });
      return {
        source: osbSourceRecord({
          sourceRef,
          identity: imported.identity,
          origin: input.origin,
          bytes: input.bytes,
          mediaType:
            input.mediaType.split(";")[0]?.trim() || "application/json",
          capturedAt,
        }),
        definitions: [imported.definition],
        issues: imported.issues,
        executableCandidates: imported.executableCandidates,
      };
    },

    async verify(ctx: AdapterCallContext): Promise<CompletionResult> {
      const broker = osbBrokerFromBinding(ctx.binding);
      const connection = ctx.connection;
      const instanceId = connection?.externalIds["instanceId"];
      const serviceId = connection?.externalIds["serviceId"];
      if (!instanceId || !serviceId)
        return {
          state: "pending",
          claims: [],
          code: "osb.instance.unselected",
        };
      const reviewed = reviewedService(broker.settings, serviceId);
      if (!reviewed.instancesRetrievable)
        /*
         * The broker declares no fetch support. That is a native limitation,
         * reported as such; the endpoint is not called "to see what happens",
         * and a transport success elsewhere is never relabelled as evidence
         * about this instance.
         */
        return {
          state: "pending",
          claims: [],
          code: "osb.instances-not-retrievable",
        };
      assertReadOnlyOperation(ctx, OSB_OPERATIONS.instance, broker);
      assertPermittedTarget(ctx, "service-instance", instanceId);
      const client = clientFor(ctx, broker);
      const response = await client.fetchInstance(
        { instanceId, serviceId },
        requestOptions(ctx),
      );
      const observedAt = new Date(response.fetchedAt).toISOString();
      const claim: VerificationClaim = {
        kind: "resource-access",
        evidenceRef: `evidence:osb:${instanceId}`.slice(0, 200),
        issuer: "provider",
        target: { kind: "service-instance", id: instanceId },
        observedAt,
        verifierVersion: OSB_ADAPTER_VERSION,
        bindingRevision: ctx.binding.revision,
        policyRevision: ctx.binding.policyRevision,
        limitations: [
          "The broker returned the instance; that is the broker's assertion about its own record, not proof that the underlying resource exists or is reachable.",
          "Parameters may be withheld by the broker, so an absent parameter is unknown, not empty.",
        ],
      };
      return {
        state: "complete",
        claims: [claim],
        target: { kind: "service-instance", id: instanceId },
        externalIds: {
          instanceId,
          serviceId: response.value.service_id ?? serviceId,
          ...(response.value.plan_id ? { planId: response.value.plan_id } : {}),
        },
      };
    },

    async invoke(
      ctx: AdapterCallContext,
      request: InvokeRequest,
    ): Promise<InvokeResult> {
      const broker = osbBrokerFromBinding(ctx.binding);
      const operation = assertReadOnlyOperation(
        ctx,
        request.operationRef,
        broker,
      );
      const client = clientFor(ctx, broker);
      const options = requestOptions(ctx);

      if (request.operationRef === OSB_OPERATIONS.catalog) {
        const response = await client.catalog(options);
        return {
          state: "complete",
          output: {
            apiVersion: OSB_API_VERSION,
            services: response.value.services.map(summarizeService),
          },
          outputClassification: operation.outputClassification,
          effect: "read",
        };
      }

      if (
        request.operationRef === OSB_OPERATIONS.instance ||
        request.operationRef === OSB_OPERATIONS.instanceLastOperation
      ) {
        const parsed = instanceInputSchema.safeParse(request.input);
        if (!parsed.success)
          throw new ConnectorError("invalid-request", {
            detail: "osb.input.invalid",
          });
        assertPermittedTarget(ctx, "service-instance", parsed.data.instanceId);
        const reviewed = reviewedService(
          broker.settings,
          parsed.data.serviceId,
        );
        if (request.operationRef === OSB_OPERATIONS.instance) {
          if (!reviewed.instancesRetrievable)
            throw new ConnectorError("unsupported", {
              detail: "osb.instances-not-retrievable",
            });
          const response = await client.fetchInstance(
            {
              instanceId: parsed.data.instanceId,
              serviceId: parsed.data.serviceId,
              ...(parsed.data.planId ? { planId: parsed.data.planId } : {}),
            },
            options,
          );
          return {
            state: "complete",
            output: {
              instanceId: parsed.data.instanceId,
              serviceId: response.value.service_id ?? parsed.data.serviceId,
              ...(response.value.plan_id
                ? { planId: response.value.plan_id }
                : {}),
              ...(response.value.dashboard_url
                ? { dashboardUrl: response.value.dashboard_url }
                : {}),
              ...(response.value.maintenance_info
                ? {
                    maintenanceVersion: response.value.maintenance_info.version,
                  }
                : {}),
              parametersPresent: response.value.parameters !== undefined,
            },
            outputClassification: operation.outputClassification,
            effect: "read",
          };
        }
        const response = await client.instanceLastOperation(
          {
            instanceId: parsed.data.instanceId,
            serviceId: parsed.data.serviceId,
            ...(parsed.data.planId ? { planId: parsed.data.planId } : {}),
            ...(parsed.data.operation
              ? { operation: parsed.data.operation }
              : {}),
          },
          options,
        );
        return {
          /*
           * A broker that is still working is still working. `in progress` is
           * reported as an incomplete result, never collapsed into success.
           */
          state: response.value.state === "failed" ? "failed" : "complete",
          output: {
            state: response.value.state,
            inProgress: response.value.state === "in progress",
            ...(response.value.instance_usable === undefined
              ? {}
              : { instanceUsable: response.value.instance_usable }),
          },
          outputClassification: operation.outputClassification,
          effect: "read",
          ...(response.value.state === "failed"
            ? { code: "osb.operation.failed" }
            : {}),
        };
      }

      if (
        request.operationRef === OSB_OPERATIONS.binding ||
        request.operationRef === OSB_OPERATIONS.bindingLastOperation
      ) {
        const parsed = bindingInputSchema.safeParse(request.input);
        if (!parsed.success)
          throw new ConnectorError("invalid-request", {
            detail: "osb.input.invalid",
          });
        assertPermittedTarget(ctx, "service-instance", parsed.data.instanceId);
        assertPermittedTarget(ctx, "service-binding", parsed.data.bindingId);
        const reviewed = reviewedService(
          broker.settings,
          parsed.data.serviceId,
        );
        if (request.operationRef === OSB_OPERATIONS.bindingLastOperation) {
          const response = await client.bindingLastOperation(
            {
              instanceId: parsed.data.instanceId,
              bindingId: parsed.data.bindingId,
              serviceId: parsed.data.serviceId,
              ...(parsed.data.planId ? { planId: parsed.data.planId } : {}),
              ...(parsed.data.operation
                ? { operation: parsed.data.operation }
                : {}),
            },
            options,
          );
          return {
            state: response.value.state === "failed" ? "failed" : "complete",
            output: {
              state: response.value.state,
              inProgress: response.value.state === "in progress",
            },
            outputClassification: operation.outputClassification,
            effect: "read",
            ...(response.value.state === "failed"
              ? { code: "osb.operation.failed" }
              : {}),
          };
        }
        if (!reviewed.bindable)
          throw new ConnectorError("unsupported", {
            detail: "osb.service.not-bindable",
          });
        if (!reviewed.bindingsRetrievable)
          /*
           * The spec says a platform SHOULD NOT call the fetch-binding
           * endpoint unless the offering declares bindings_retrievable, and it
           * defines no error for calling one that is unsupported. Reporting
           * the limitation is therefore the only accurate answer; inventing a
           * credential response would be the alternative.
           */
          throw new ConnectorError("unsupported", {
            detail: "osb.bindings-not-retrievable",
          });
        const response = await client.fetchBinding(
          {
            instanceId: parsed.data.instanceId,
            bindingId: parsed.data.bindingId,
            serviceId: parsed.data.serviceId,
            ...(parsed.data.planId ? { planId: parsed.data.planId } : {}),
          },
          options,
        );
        const split = projectOsbBinding(response.value);
        let credentialRef: string | undefined;
        if (split.credentials) {
          const scope = credentialScope(ctx);
          /*
           * `expires_at` is an ISO 8601 string the broker chose. An
           * unparsable one means the expiry is unknown, which is recorded by
           * omitting it rather than by inventing a moment.
           */
          const parsedExpiry = response.value.metadata?.expires_at
            ? Date.parse(response.value.metadata.expires_at)
            : Number.NaN;
          credentialRef = await ctx.environment.credentials.store(
            scope,
            split.credentials,
            {
              ...(Number.isFinite(parsedExpiry)
                ? { expiresAt: parsedExpiry }
                : {}),
              ...(ctx.connection?.credentialRef
                ? { replaces: ctx.connection.credentialRef }
                : {}),
            },
          );
        }
        const projection: OsbBindingProjection = {
          ...split.projection,
          ...(credentialRef ? { credentialRef } : {}),
        };
        return {
          state: "complete",
          output: projection,
          /*
           * The projection deliberately contains no credential value, so its
           * classification describes connection information rather than the
           * secret the broker returned.
           */
          outputClassification: "personal",
          effect: "read",
        };
      }

      throw new ConnectorError("not-found", {
        detail: "osb.operation.unknown",
      });
    },

    async disconnect(ctx: AdapterCallContext, scope) {
      osbBrokerFromBinding(ctx.binding);
      const credentialRef = ctx.connection?.credentialRef;
      if (scope === "local" && credentialRef)
        await ctx.environment.credentials.revoke(
          credentialScope(ctx),
          credentialRef,
        );
      return {
        local: scope === "local" ? "applied" : "not-attempted",
        broker: "unsupported",
        /*
         * Unbinding and deprovisioning are real upstream effects with their own
         * authorization. They are outside this profile, so they are reported
         * as not attempted rather than implied by a local disconnect.
         */
        upstream: "not-attempted",
      };
    },
  };
  return adapter;
}

export type { OsbServiceSummary };
