import {
  completeDimensions,
  normalizedDefinitionSchema,
  normalizedDigestOf,
  sourceRecordSchema,
  type CompatibilityIssue,
  type ConnectorSourceIdentity,
  type NativeCapability,
  type NormalizedDefinition,
  type SourceRecord,
} from "../../../../core/connectors/index.js";
import { ConnectorError } from "../../errors.js";
import { sha256Hex } from "../../import/parse.js";
import {
  OSB_ADAPTER_VERSION,
  OSB_API_VERSION,
  OSB_ECOSYSTEM,
  OSB_IMPORTER_ID,
  OSB_PROFILE,
  bindingsRetrievable,
  instancesRetrievable,
  osbCatalogSchema,
  planIsBindable,
  type OsbCatalog,
  type OsbService,
} from "./schemas.js";

/*
 * Describing a broker catalog.
 *
 * A Service Offering and a Service Plan are descriptions. Everything that
 * could change state — provisioning an instance, creating a binding, changing
 * a plan — is outside this adapter entirely, so the capabilities produced here
 * are reads and only reads. `instances_retrievable` and `bindings_retrievable`
 * are carried through exactly as declared, because they decide whether the
 * fetch endpoints may be called at all: the spec defines no error for calling
 * one that is unsupported, which means an absent flag is a limitation to
 * report rather than a call to attempt.
 */

export type OsbServiceSummary = {
  serviceId: string;
  name: string;
  bindable: boolean;
  instancesRetrievable: boolean;
  bindingsRetrievable: boolean;
  planUpdateable: boolean;
  tags: string[];
  requires: string[];
  plans: Array<{
    planId: string;
    name: string;
    free: boolean;
    bindable: boolean;
    bindingRotatable: boolean;
    planUpdateable: boolean;
    maximumPollingDuration?: number;
  }>;
};

export type OsbCatalogImport = {
  identity: ConnectorSourceIdentity;
  catalog: OsbCatalog;
  services: OsbServiceSummary[];
  definition: NormalizedDefinition;
  issues: CompatibilityIssue[];
  executableCandidates: string[];
};

const clip = (value: string, max: number) =>
  value.replace(/\s+/gu, " ").trim().slice(0, max);

export function summarizeService(service: OsbService): OsbServiceSummary {
  return {
    serviceId: service.id,
    name: service.name,
    bindable: service.bindable,
    instancesRetrievable: instancesRetrievable(service),
    bindingsRetrievable: bindingsRetrievable(service),
    planUpdateable: service.plan_updateable === true,
    tags: [...(service.tags ?? [])],
    requires: [...(service.requires ?? [])],
    plans: service.plans.map((plan) => ({
      planId: plan.id,
      name: plan.name,
      /* The spec's default for `free` is true. */
      free: plan.free ?? true,
      bindable: planIsBindable(service, plan),
      bindingRotatable: plan.binding_rotatable === true,
      planUpdateable: plan.plan_updateable ?? service.plan_updateable === true,
      ...(plan.maximum_polling_duration === undefined
        ? {}
        : { maximumPollingDuration: plan.maximum_polling_duration }),
    })),
  };
}

export type OsbImportOptions = {
  sourceRef: string;
  origin: SourceRecord["origin"];
  /** Stable broker identity: an approved destination id or configured broker name. */
  brokerId: string;
  capturedAt: string;
};

/** Describes a catalog document already read from a broker (or uploaded for review). */
export async function importOpenServiceBrokerCatalog(
  document: unknown,
  options: OsbImportOptions,
): Promise<OsbCatalogImport> {
  const parsed = osbCatalogSchema.safeParse(document);
  if (!parsed.success)
    throw new ConnectorError("invalid-request", {
      detail: "osb.catalog.invalid",
    });
  const catalog = parsed.data;
  const issues: CompatibilityIssue[] = [];
  const services = catalog.services.map(summarizeService);

  const seenServiceIds = new Set<string>();
  for (const service of services) {
    if (seenServiceIds.has(service.serviceId))
      issues.push({
        code: "osb.catalog.duplicate-service-id",
        category: "identity",
        sourcePointer: "/services",
        dimension: "import",
        disposition: "rejected",
        severity: "blocking",
        executionImpact: "blocks-definition",
        message:
          "Two Service Offerings share an id; the id is the only immutable identity a platform may use, so the catalog cannot be described unambiguously.",
      });
    seenServiceIds.add(service.serviceId);
    const seenPlanIds = new Set<string>();
    for (const plan of service.plans) {
      if (seenPlanIds.has(plan.planId))
        issues.push({
          code: "osb.catalog.duplicate-plan-id",
          category: "identity",
          sourcePointer: `/services/${service.serviceId}/plans`,
          dimension: "import",
          disposition: "rejected",
          severity: "blocking",
          executionImpact: "blocks-definition",
          message: "Two Service Plans of one offering share an id.",
        });
      seenPlanIds.add(plan.planId);
      if (!plan.free)
        issues.push({
          code: "osb.plan.not-free",
          category: "policy",
          sourcePointer: `/services/${service.serviceId}/plans/${plan.planId}`,
          dimension: "invoke",
          disposition: "unsupported",
          severity: "warning",
          executionImpact: "blocks-operation",
          message:
            "This plan is not free. Provisioning and plan changes are unavailable in this profile, so no paid resource can be created or changed from here.",
        });
    }
    if (!service.instancesRetrievable)
      issues.push({
        code: "osb.service.instances-not-retrievable",
        category: "structure",
        sourcePointer: `/services/${service.serviceId}/instances_retrievable`,
        dimension: "verify",
        disposition: "unsupported",
        severity: "warning",
        executionImpact: "blocks-operation",
        message:
          "The offering does not declare instances_retrievable, so the fetch-instance endpoint is not supported and is never called.",
        remediation:
          "Ask the broker operator whether the offering can declare instances_retrievable.",
      });
    if (service.bindable && !service.bindingsRetrievable)
      issues.push({
        code: "osb.service.bindings-not-retrievable",
        category: "structure",
        sourcePointer: `/services/${service.serviceId}/bindings_retrievable`,
        dimension: "invoke",
        disposition: "unsupported",
        severity: "warning",
        executionImpact: "blocks-operation",
        message:
          "The offering does not declare bindings_retrievable, so the fetch-binding endpoint is not supported and is never called; existing binding credentials cannot be read back.",
        remediation:
          "Ask the broker operator whether the offering can declare bindings_retrievable.",
      });
  }

  issues.push({
    code: "osb.profile.inspection-only",
    category: "policy",
    sourcePointer: "/services",
    dimension: "invoke",
    disposition: "unsupported",
    severity: "warning",
    executionImpact: "blocks-operation",
    message:
      "This profile reads a catalog and inspects existing instances and bindings. Provision, deprovision, update, bind and unbind are not implemented and no such request is issued.",
  });

  const capabilities: NativeCapability[] = [
    {
      kind: "query",
      nativeId: "catalog",
      label: "Read the broker catalog",
      summary: "Reads the Service Offerings and Plans a broker advertises.",
      effect: "read",
      dataClassification: "public",
      cost: "free",
      authentication: ["osb-basic"],
      nativeExtensions: { route: "/v2/catalog", apiVersion: OSB_API_VERSION },
    },
  ];
  for (const service of services) {
    if (service.instancesRetrievable)
      capabilities.push({
        kind: "query",
        nativeId: `instance:${service.serviceId}`,
        label: clip(`Inspect an instance of ${service.name}`, 200),
        summary:
          "Reads an existing Service Instance the broker declares retrievable.",
        effect: "read",
        dataClassification: "personal",
        cost: "free",
        authentication: ["osb-basic"],
        nativeExtensions: { serviceId: service.serviceId, role: "instance" },
      });
    if (service.bindable && service.bindingsRetrievable)
      capabilities.push({
        kind: "query",
        nativeId: `binding:${service.serviceId}`,
        label: clip(`Inspect a binding of ${service.name}`, 200),
        summary:
          "Reads an existing Service Binding; retrieved credentials are held in private custody and never returned.",
        effect: "read",
        /*
         * A binding response carries the credential itself. The capability is
         * declared secret even though this adapter strips the credential out
         * of every result: the declaration describes the source, not the
         * projection.
         */
        dataClassification: "secret",
        cost: "free",
        authentication: ["osb-basic"],
        nativeExtensions: { serviceId: service.serviceId, role: "binding" },
      });
  }

  const identity: ConnectorSourceIdentity = {
    ecosystem: OSB_ECOSYSTEM,
    authorityNamespace: options.brokerId.slice(0, 256),
    nativeId: `broker:${options.brokerId}`.slice(0, 512),
    nativeVersion: OSB_API_VERSION,
  };

  const shape = {
    schemaVersion: 1 as const,
    definitionRef: `definition:osb:${options.brokerId}`,
    identity,
    sourceRef: options.sourceRef,
    normalizedDigest: "0".repeat(64),
    importer: { id: OSB_IMPORTER_ID, version: OSB_ADAPTER_VERSION },
    display: {
      name: clip(`Open Service Broker: ${options.brokerId}`, 200),
      description: clip(
        `Catalog of ${services.length} Service Offering(s) advertised by an Open Service Broker API ${OSB_API_VERSION} broker. Inspection only.`,
        500,
      ),
      ecosystem: OSB_ECOSYSTEM,
      service: "open-service-broker",
    },
    authentication: [
      {
        id: "osb-basic",
        label: "Broker basic authentication",
        kind: "http-basic" as const,
      },
    ],
    configuration: [],
    capabilities,
    events: [],
    declaredServers: [],
    compatibility: {
      issues,
      dimensions: completeDimensions({
        discover: "exact",
        import: "exact",
        configure: "adapted",
        authorize: "requires-configuration",
        verify: services.some((service) => service.instancesRetrievable)
          ? "requires-configuration"
          : "unsupported",
        invoke: services.some(
          (service) => service.instancesRetrievable || service.bindingsRetrievable,
        )
          ? "requires-configuration"
          : "unsupported",
      }),
    },
    nativeExtensions: {
      apiVersion: OSB_API_VERSION,
      brokerId: options.brokerId,
      services: services.map((service) => ({
        serviceId: service.serviceId,
        name: service.name,
        bindable: service.bindable,
        instancesRetrievable: service.instancesRetrievable,
        bindingsRetrievable: service.bindingsRetrievable,
        planIds: service.plans.map((plan) => plan.planId),
        freePlanIds: service.plans
          .filter((plan) => plan.free)
          .map((plan) => plan.planId),
      })),
    },
  };
  const definition = normalizedDefinitionSchema.parse({
    ...shape,
    normalizedDigest: await normalizedDigestOf(shape),
  });

  return {
    identity,
    catalog,
    services,
    definition,
    issues,
    executableCandidates: capabilities.map((capability) => capability.nativeId),
  };
}

export function osbSourceRecord(input: {
  sourceRef: string;
  identity: ConnectorSourceIdentity;
  origin: SourceRecord["origin"];
  bytes: Uint8Array;
  mediaType: string;
  capturedAt: string;
}): SourceRecord {
  return sourceRecordSchema.parse({
    sourceRef: input.sourceRef,
    identity: input.identity,
    format: { name: "open-service-broker", version: OSB_API_VERSION, dialect: OSB_PROFILE },
    origin: input.origin,
    digest: { algorithm: "sha256", value: sha256Hex(input.bytes) },
    byteLength: input.bytes.byteLength,
    mediaType: input.mediaType,
    capturedAt: input.capturedAt,
    adaptation: [],
    overlays: [],
  });
}
