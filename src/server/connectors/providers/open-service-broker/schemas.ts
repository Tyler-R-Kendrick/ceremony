import { z } from "zod";

/*
 * Open Service Broker API v2.17.
 *
 * Verified against the released tag `v2.17` of
 * https://github.com/openservicebrokerapi/servicebroker (`spec.md`), read
 * 2026-09-18. The repository's `master` copy of the same file is explicitly
 * labelled as possibly containing unreleased changes, so the tag is what these
 * shapes are pinned to.
 *
 * Four distinct things, kept distinct: a *catalog* advertises Service
 * Offerings and Plans; a *Service Instance* is a reserved resource; a *Service
 * Binding* is access to that resource; and the *credentials* inside a binding
 * response are private custody data. This module reads the first three and
 * never produces the fourth into a result.
 *
 * Provisioning, deprovisioning, updating and unbinding are deliberately not
 * modelled here at all. There is no request builder for them, so there is no
 * code path — configured, misconfigured or hostile — that issues one.
 */

export const OSB_ECOSYSTEM = "open-service-broker";
export const OSB_ADAPTER_VERSION = "1.0.0";
export const OSB_IMPORTER_ID = "open-service-broker-importer";
export const OSB_API_VERSION = "2.17";
export const OSB_PROFILE = "osb-2.17";
export const OSB_SOURCE = Object.freeze({
  repository: "https://github.com/openservicebrokerapi/servicebroker",
  tag: "v2.17",
  document: "spec.md",
  retrievedAt: "2026-09-18",
});

export const OSB_API_VERSION_HEADER = "x-broker-api-version";
export const OSB_ORIGINATING_IDENTITY_HEADER =
  "x-broker-api-originating-identity";
export const OSB_REQUEST_IDENTITY_HEADER = "x-broker-api-request-identity";

/** Routes this adapter is allowed to build. Every one of them is a GET. */
export const OSB_ROUTES = Object.freeze({
  catalog: "/v2/catalog",
  instance: (instanceId: string) =>
    `/v2/service_instances/${encodeURIComponent(instanceId)}`,
  instanceLastOperation: (instanceId: string) =>
    `/v2/service_instances/${encodeURIComponent(instanceId)}/last_operation`,
  binding: (instanceId: string, bindingId: string) =>
    `/v2/service_instances/${encodeURIComponent(instanceId)}/service_bindings/${encodeURIComponent(bindingId)}`,
  bindingLastOperation: (instanceId: string, bindingId: string) =>
    `/v2/service_instances/${encodeURIComponent(instanceId)}/service_bindings/${encodeURIComponent(bindingId)}/last_operation`,
});

const noControl = /^[^\p{Cc}]*$/u;
const boundedText = z.string().max(20_000).regex(noControl);

/**
 * The spec places no character restriction on these ids and only recommends
 * RFC 3986 unreserved characters. They are kept opaque and bounded, never
 * slugged, and percent-encoded exactly once at the URL boundary.
 */
export const osbIdentifierSchema = z
  .string()
  .min(1)
  .max(512)
  .regex(/^[^\p{Cc}]+$/u)
  .refine((value) => !/[?#]/.test(value), "Identifier carries URL syntax")
  .refine(
    (value) => !["__proto__", "prototype", "constructor"].includes(value),
    "Identifier is a reserved object key",
  );

export const osbMaintenanceInfoSchema = z.looseObject({
  version: z.string().max(128).regex(noControl),
  description: boundedText.optional(),
});

export const osbSchemasSchema = z.looseObject({
  service_instance: z.unknown().optional(),
  service_binding: z.unknown().optional(),
});

export const osbPlanSchema = z.looseObject({
  id: osbIdentifierSchema,
  name: z.string().min(1).max(512).regex(noControl),
  description: boundedText,
  metadata: z.unknown().optional(),
  free: z.boolean().optional(),
  bindable: z.boolean().optional(),
  binding_rotatable: z.boolean().optional(),
  plan_updateable: z.boolean().optional(),
  schemas: osbSchemasSchema.optional(),
  maximum_polling_duration: z.number().int().min(0).max(31_536_000).optional(),
  maintenance_info: osbMaintenanceInfoSchema.optional(),
});
export type OsbPlan = z.infer<typeof osbPlanSchema>;

export const osbServiceSchema = z.looseObject({
  id: osbIdentifierSchema,
  name: z.string().min(1).max(512).regex(noControl),
  description: boundedText,
  tags: z.array(z.string().max(256).regex(noControl)).max(128).optional(),
  requires: z.array(z.string().max(64).regex(noControl)).max(16).optional(),
  bindable: z.boolean(),
  instances_retrievable: z.boolean().optional(),
  bindings_retrievable: z.boolean().optional(),
  allow_context_updates: z.boolean().optional(),
  metadata: z.unknown().optional(),
  plan_updateable: z.boolean().optional(),
  plans: z.array(osbPlanSchema).min(1).max(512),
});
export type OsbService = z.infer<typeof osbServiceSchema>;

export const osbCatalogSchema = z.looseObject({
  services: z.array(osbServiceSchema).max(512),
});
export type OsbCatalog = z.infer<typeof osbCatalogSchema>;

export const osbInstanceMetadataSchema = z.looseObject({
  labels: z.record(z.string().max(256), z.unknown()).optional(),
  attributes: z.record(z.string().max(256), z.unknown()).optional(),
});

export const osbInstanceSchema = z.looseObject({
  service_id: osbIdentifierSchema.optional(),
  plan_id: osbIdentifierSchema.optional(),
  dashboard_url: z.string().max(2048).regex(noControl).optional(),
  parameters: z.unknown().optional(),
  maintenance_info: osbMaintenanceInfoSchema.optional(),
  metadata: osbInstanceMetadataSchema.optional(),
});
export type OsbInstance = z.infer<typeof osbInstanceSchema>;

export const osbEndpointSchema = z.looseObject({
  host: z.string().max(512).regex(noControl),
  ports: z.array(z.string().max(16).regex(noControl)).max(64),
  protocol: z.enum(["tcp", "udp", "all"]).optional(),
});
export type OsbEndpoint = z.infer<typeof osbEndpointSchema>;

export const osbBindingSchema = z.looseObject({
  metadata: z
    .looseObject({
      expires_at: z.string().max(64).regex(noControl).optional(),
      renew_before: z.string().max(64).regex(noControl).optional(),
    })
    .optional(),
  /** Free-form and private: this is the credential, not a description of one. */
  credentials: z.record(z.string().max(256), z.unknown()).optional(),
  syslog_drain_url: z.string().max(2048).regex(noControl).optional(),
  route_service_url: z.string().max(2048).regex(noControl).optional(),
  volume_mounts: z.array(z.unknown()).max(64).optional(),
  parameters: z.unknown().optional(),
  endpoints: z.array(osbEndpointSchema).max(64).optional(),
});
export type OsbBinding = z.infer<typeof osbBindingSchema>;

export const osbOperationStates = [
  "in progress",
  "succeeded",
  "failed",
] as const;
export const osbLastOperationSchema = z.looseObject({
  state: z.enum(osbOperationStates),
  description: boundedText.optional(),
  instance_usable: z.boolean().optional(),
  update_repeatable: z.boolean().optional(),
});
export type OsbLastOperation = z.infer<typeof osbLastOperationSchema>;

/** The documented error body; `description` is provider prose and never leaves the server. */
export const osbErrorSchema = z.looseObject({
  error: z.string().max(256).regex(noControl).optional(),
  description: boundedText.optional(),
  instance_usable: z.boolean().optional(),
  update_repeatable: z.boolean().optional(),
});

/**
 * Whether a plan is bindable: the plan's own flag takes precedence over the
 * offering's, and the offering's is the default. Getting this backwards would
 * advertise bindings a broker does not have.
 */
export function planIsBindable(service: OsbService, plan: OsbPlan): boolean {
  return plan.bindable ?? service.bindable;
}

/**
 * Whether the platform may call the fetch endpoints at all. The spec says a
 * platform SHOULD NOT attempt the call unless the offering declares the flag,
 * and it defines no error a broker must return when it is unsupported. An
 * absent flag is therefore "not supported", never "try it and see".
 */
export function instancesRetrievable(service: OsbService): boolean {
  return service.instances_retrievable === true;
}

export function bindingsRetrievable(service: OsbService): boolean {
  return service.bindings_retrievable === true;
}
