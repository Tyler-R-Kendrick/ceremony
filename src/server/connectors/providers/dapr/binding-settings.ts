import { z } from "zod";
import { identifierSchema } from "../../../../core/operation-contracts.js";
import type { ApprovedDestination, RuntimeBinding } from "../../binding.js";
import { ConnectorError } from "../../errors.js";
import {
  daprComponentNameSchema,
  daprOperationSchema,
  type DaprOperation,
} from "./schemas.js";

/*
 * What a runtime binding must say before a single byte reaches a Dapr sidecar.
 *
 * A sidecar speaks for every component it has loaded, which is exactly why it
 * is never reachable as a generic endpoint: the binding names one approved
 * destination, the component names that may be invoked, and the operation verbs
 * approved for each of them. A caller names an operation reference and a
 * payload. It never names a sidecar, a component, a URL or a header, and a
 * component the binding did not list does not exist as far as this adapter is
 * concerned.
 */

const configurationNameSchema = z.string().regex(/^[A-Z][A-Z0-9_]{0,95}$/);

export const daprBindingSettingsSchema = z
  .strictObject({
    /** The one approved sidecar destination; other destinations in the binding are not sidecars. */
    destinationId: identifierSchema,
    /** Host configuration holding the sidecar API token (`DAPR_API_TOKEN`). */
    apiTokenConfiguration: configurationNameSchema.optional(),
    /**
     * An explicit, narrow admission for a sidecar that has no API token, which
     * the loopback-fixture network class is the only place it is allowed.
     */
    unauthenticatedSidecar: z.boolean().default(false),
    /** Host configuration holding the app API token (`APP_API_TOKEN`) for input deliveries. */
    appApiTokenConfiguration: configurationNameSchema.optional(),
    /** Dapr app id this deployment presents as; display and audit only. */
    appId: z.string().max(253).optional(),
    /** Component names approved for output invocation, with the verbs approved for each. */
    outputBindings: z
      .record(
        daprComponentNameSchema,
        z.strictObject({
          operations: z.array(daprOperationSchema).min(1).max(8),
          /** Per-call metadata keys a caller may set; anything else is refused. */
          metadataKeys: z.array(z.string().max(200)).max(32).default([]),
        }),
      )
      .refine((value) => Object.keys(value).length <= 64),
    /** Component names whose input deliveries this deployment accepts. */
    inputBindings: z.array(daprComponentNameSchema).max(64).default([]),
  })
  .superRefine((settings, ctx) => {
    if (!settings.apiTokenConfiguration && !settings.unauthenticatedSidecar)
      ctx.addIssue({
        code: "custom",
        message:
          "A Dapr binding names the configuration holding the sidecar API token, or declares an unauthenticated sidecar explicitly",
      });
    if (settings.apiTokenConfiguration && settings.unauthenticatedSidecar)
      ctx.addIssue({
        code: "custom",
        message:
          "A sidecar is either token-authenticated or explicitly unauthenticated",
      });
  });
export type DaprBindingSettings = z.infer<typeof daprBindingSettingsSchema>;

export type ResolvedDaprSidecar = {
  settings: DaprBindingSettings;
  destination: ApprovedDestination;
};

/** The sidecar a binding approves; absence or a wrong shape is a policy failure. */
export function daprSidecarFromBinding(
  binding: RuntimeBinding,
): ResolvedDaprSidecar {
  const raw = binding.settings["dapr"];
  if (raw === undefined)
    throw new ConnectorError("configuration-required", {
      detail: "dapr.settings.missing",
    });
  const parsed = daprBindingSettingsSchema.safeParse(raw);
  if (!parsed.success)
    throw new ConnectorError("invalid-request", {
      detail: "dapr.settings.invalid",
    });
  const settings = parsed.data;
  const destination = binding.destinations.find(
    (item) => item.id === settings.destinationId,
  );
  if (!destination)
    throw new ConnectorError("network-policy", {
      detail: "dapr.destination-unapproved",
    });
  /*
   * An unauthenticated sidecar is only ever a loopback fixture. A public or
   * approved-private sidecar without an API token would be exactly the
   * unauthenticated proxy this adapter exists to refuse.
   */
  if (
    settings.unauthenticatedSidecar &&
    destination.network !== "loopback-fixture"
  )
    throw new ConnectorError("configuration-required", {
      detail: "dapr.sidecar.token-required",
    });
  return { settings, destination };
}

/** The verbs approved for one component, or a denial naming nothing about other components. */
export function approvedDaprOperations(
  settings: DaprBindingSettings,
  componentName: string,
): { operations: readonly DaprOperation[]; metadataKeys: readonly string[] } {
  const entry = settings.outputBindings[componentName];
  if (!entry)
    throw new ConnectorError("denied", { detail: "dapr.component.unapproved" });
  return { operations: entry.operations, metadataKeys: entry.metadataKeys };
}

/** Whether an input delivery for this component name is accepted at all. */
export function acceptsDaprInput(
  settings: DaprBindingSettings,
  componentName: string,
): boolean {
  return settings.inputBindings.includes(componentName);
}

/**
 * The answer to the sidecar's startup `OPTIONS /<name>` probe. Dapr reads 404
 * as "this app does not subscribe" and 2xx/405 as "it does"; declining an
 * unapproved binding here stops the subscription before any delivery exists.
 */
export function daprInputSubscriptionStatus(
  settings: DaprBindingSettings,
  componentName: string,
): 200 | 404 {
  return acceptsDaprInput(settings, componentName) ? 200 : 404;
}
