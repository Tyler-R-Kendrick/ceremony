import { z } from "zod";

/*
 * Dapr component and binding descriptions.
 *
 * Verified against the Dapr documentation for runtime v1.18, read 2026-09-18:
 * the bindings API reference (https://docs.dapr.io/reference/api/bindings_api/),
 * the bindings overview, the supported-bindings component reference, and the
 * API-token and app-API-token operations pages. The wire contract this module
 * implements is the sidecar HTTP API version prefix `v1.0`, which is what the
 * documented routes use; the runtime release is recorded as provenance, not as
 * a protocol version.
 *
 * Four things stay four things here. A *component* is a YAML description. A
 * *binding* is a component of type `bindings.*`. An *output invocation* is a
 * request Ceremony makes to a sidecar. An *input delivery* is a request the
 * sidecar makes to this application. Nothing in this module treats the sidecar
 * as a general-purpose proxy, and no code path lets a caller name a URL,
 * header, component or sidecar that the binding did not approve.
 */

export const DAPR_ECOSYSTEM = "dapr";
export const DAPR_ADAPTER_VERSION = "1.0.0";
export const DAPR_IMPORTER_ID = "dapr-component-importer";
/** The sidecar HTTP API version prefix; the actual wire contract. */
export const DAPR_HTTP_API_VERSION = "v1.0";
export const DAPR_COMPONENT_API_VERSION = "dapr.io/v1alpha1";
export const DAPR_COMPONENT_KIND = "Component";
export const DAPR_COMPONENT_PROFILE = "dapr-component-v1alpha1";
export const DAPR_BINDINGS_PROFILE = "dapr-bindings-http-v1.0";
export const DAPR_SOURCE = Object.freeze({
  documentation: "https://docs.dapr.io/reference/api/bindings_api/",
  runtimeDocsVersion: "v1.18",
  retrievedAt: "2026-09-18",
});

/** Header a caller sends to a sidecar (`DAPR_API_TOKEN`). */
export const DAPR_API_TOKEN_HEADER = "dapr-api-token";
/** The same header name is used by the sidecar when calling the app (`APP_API_TOKEN`). */
export const DAPR_APP_API_TOKEN_HEADER = "dapr-api-token";

/** Output-binding operation verbs the documentation names. */
export const daprOperations = ["create", "get", "list", "delete", "exec"] as const;
export const daprOperationSchema = z.enum(daprOperations);
export type DaprOperation = z.infer<typeof daprOperationSchema>;

const noControl = /^[^\p{Cc}]*$/u;

/** Dapr component names are Kubernetes object names. */
export const daprComponentNameSchema = z
  .string()
  .min(1)
  .max(253)
  .regex(/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*$/);

/** `spec.type` is `<building-block>.<implementation>`, e.g. `bindings.kafka`. */
export const daprComponentTypeSchema = z
  .string()
  .min(3)
  .max(120)
  .regex(/^[a-z][a-z0-9]*(?:\.[a-z0-9][a-z0-9-]*){1,3}$/);

export const daprMetadataEntrySchema = z.looseObject({
  name: z.string().min(1).max(200).regex(noControl),
  value: z.union([z.string().max(8192), z.number().finite(), z.boolean()]).optional(),
  secretKeyRef: z
    .looseObject({
      name: z.string().min(1).max(253).regex(noControl),
      key: z.string().min(1).max(253).regex(noControl).optional(),
    })
    .optional(),
});
export type DaprMetadataEntry = z.infer<typeof daprMetadataEntrySchema>;

export const daprComponentSchema = z.looseObject({
  apiVersion: z.string().max(120).regex(noControl),
  kind: z.string().max(120).regex(noControl),
  metadata: z.looseObject({
    name: daprComponentNameSchema,
    namespace: z.string().max(253).regex(noControl).optional(),
    annotations: z
      .record(z.string().max(253), z.string().max(8192).regex(noControl))
      .optional(),
  }),
  spec: z.looseObject({
    type: daprComponentTypeSchema,
    version: z.string().max(64).regex(noControl).optional(),
    metadata: z.array(daprMetadataEntrySchema).max(256).optional(),
    initTimeout: z.string().max(64).regex(noControl).optional(),
    ignoreErrors: z.boolean().optional(),
  }),
  scopes: z.array(z.string().max(253).regex(noControl)).max(128).optional(),
  auth: z
    .looseObject({ secretStore: z.string().max(253).regex(noControl).optional() })
    .optional(),
});
export type DaprComponent = z.infer<typeof daprComponentSchema>;

export const daprDirections = ["input", "output", "both", "unknown"] as const;
export const daprDirectionSchema = z.enum(daprDirections);
export type DaprDirection = z.infer<typeof daprDirectionSchema>;

/**
 * Directions taken directly from the supported-bindings component reference
 * (read 2026-09-18). Only what that page states is recorded. Anything absent
 * stays `unknown` and is reported as unverified rather than guessed: a wrong
 * direction would either invent an input receiver or refuse a real one.
 */
export const DAPR_BINDING_DIRECTIONS: Readonly<Record<string, DaprDirection>> =
  Object.freeze({
    "bindings.cron": "input",
    "bindings.kubernetes": "input",
    "bindings.rethinkdb.statechange": "input",
    "bindings.zeebe.jobworker": "input",
    "bindings.kafka": "both",
    "bindings.rabbitmq": "both",
    "bindings.mqtt3": "both",
    "bindings.kubemq": "both",
    "bindings.aws.kinesis": "both",
    "bindings.azure.eventhubs": "both",
    "bindings.azure.servicebusqueues": "both",
    "bindings.http": "output",
    "bindings.postgresql": "output",
    "bindings.aws.s3": "output",
    "bindings.azure.blobstorage": "output",
    "bindings.redis": "output",
  });

/** Direction the pinned reference states for a component type; `unknown` when it does not. */
export function daprDirectionFor(type: string): DaprDirection {
  return DAPR_BINDING_DIRECTIONS[type] ?? "unknown";
}

export function isDaprBindingType(type: string): boolean {
  return type.startsWith("bindings.");
}

/**
 * Component metadata names whose values are credentials whenever they are
 * given inline. A component that inlines one of these is a finding, not a
 * value to import: the value is dropped and an issue records it.
 */
const secretMetadataPattern =
  /(password|passphrase|secret|token|credential|privatekey|private_key|apikey|api_key|accesskey|access_key|connectionstring|connection_string|sharedaccesskey)/i;

export type DaprMetadataClassification = "public" | "secret";

export function classifyDaprMetadata(
  entry: DaprMetadataEntry,
): { classification: DaprMetadataClassification; fromSecretStore: boolean } {
  const fromSecretStore = entry.secretKeyRef !== undefined;
  if (fromSecretStore) return { classification: "secret", fromSecretStore };
  return {
    classification: secretMetadataPattern.test(entry.name) ? "secret" : "public",
    fromSecretStore,
  };
}

/** The documented output-binding route for one component name. */
export function daprBindingPath(name: string): string {
  return `/${DAPR_HTTP_API_VERSION}/bindings/${encodeURIComponent(daprComponentNameSchema.parse(name))}`;
}

/**
 * The request body the bindings API documents: a payload, per-call metadata
 * and the operation verb. Nothing else is sent, and a caller supplies only
 * these three fields — never a URL, a header or a component name.
 */
export const daprInvokeInputSchema = z.strictObject({
  data: z.unknown().optional(),
  metadata: z.record(z.string().max(200).regex(noControl), z.string().max(8192)).optional(),
  operation: daprOperationSchema.optional(),
});
export type DaprInvokeInput = z.infer<typeof daprInvokeInputSchema>;

/** Optional response an application may return to a Dapr input delivery. */
export const daprInputResponseSchema = z.strictObject({
  storeName: z.string().max(253).optional(),
  state: z.unknown().optional(),
  to: z.array(z.string().max(253)).max(32).optional(),
  concurrency: z.enum(["sequential", "parallel"]).optional(),
  data: z.unknown().optional(),
});
export type DaprInputResponse = z.infer<typeof daprInputResponseSchema>;
