import type { CatalogEntry } from "../../../../core/connectors/index.js";
import type {
  AdapterCallContext,
  CapabilityStatus,
  ConnectorAdapter,
  DisconnectResult,
  ImportInput,
} from "../../adapter.js";
import { capabilityStatus } from "../../adapter.js";
import type { ApprovedDestination } from "../../binding.js";
import type { VerifiedEventEnvelope } from "../../ports.js";
import { CooldownRegistry } from "./api.js";
import {
  NANGO_ADAPTER_ID,
  RateWindowRegistry,
  type NangoAdapterOptions,
  type NangoRuntime,
} from "./context.js";
import {
  captureNangoIntegration,
  discoverNango,
  importNango,
  nangoCatalogEntries,
  type NangoSnapshot,
} from "./discover.js";
import {
  deleteNangoBrokerConnection,
  disconnectNango,
  revokeNango,
} from "./disconnect.js";
import {
  inspectNangoConnection,
  type NangoConnectionInspection,
} from "./inspect.js";
import { invokeNango } from "./invoke.js";
import {
  NANGO_CONFIGURATION,
  NANGO_CONFIGURATION_NAMES,
  NANGO_DEFAULT_API_ORIGIN,
  NANGO_DEFAULT_CONNECT_ORIGIN,
  NANGO_PROFILE,
} from "./schemas.js";
import {
  authorizeNango,
  completeNango,
  NANGO_ADAPTER_VERSION,
  verifyNango,
} from "./sessions.js";
import { delegateNango } from "./syncs.js";
import {
  BoundedEventInbox,
  createNangoEventPort,
  reconcileNangoEvent,
  type NangoReconcileResult,
} from "./webhooks.js";

export type { NangoAdapterOptions } from "./context.js";
export type { NangoConnectionInspection } from "./inspect.js";
export type { NangoReconcileResult } from "./webhooks.js";
export type { NangoSnapshot } from "./discover.js";
export {
  NANGO_SNAPSHOT_FORMAT,
  nangoSnapshotSchema,
  serviceSlug,
} from "./discover.js";
export {
  NANGO_CONFIGURATION,
  NANGO_CONFIGURATION_NAMES,
  NANGO_DEFAULT_API_ORIGIN,
  NANGO_DEFAULT_CONNECT_ORIGIN,
  NANGO_PROFILE,
  NANGO_PROFILE_IDS,
  nangoBindingSettingsSchema,
  operationContractSchema,
  validateJsonSubset,
} from "./schemas.js";
export { authorityInstanceFor, TAG_KEYS } from "./context.js";
export { BoundedEventInbox, verifyNangoSignature } from "./webhooks.js";
export { NANGO_ADAPTER_VERSION } from "./sessions.js";

/**
 * The Nango adapter plus its privileged-internal surface. Everything on
 * `ConnectorAdapter` is reachable through the shared commands; the extra
 * methods below are for the command layer only and are deliberately not part
 * of the shared interface, so a generic read-only route cannot reach them.
 */
export interface NangoAdapter extends ConnectorAdapter {
  /** Privileged-internal: GET /connections/{id} may refresh tokens; agents are refused. */
  inspectConnection(
    ctx: AdapterCallContext,
  ): Promise<NangoConnectionInspection>;
  /** Applies a verified webhook to the connection after checking Nango's current state. */
  reconcileEvent(
    ctx: AdapterCallContext,
    event: VerifiedEventEnvelope,
  ): Promise<NangoReconcileResult>;
  /** Administrative broker deletion with an explicit shared-impact decision. */
  deleteBrokerConnection(
    ctx: AdapterCallContext,
    options: { approveSharedImpact: boolean },
  ): Promise<DisconnectResult>;
  /** Captures the current integration and function metadata as importable bytes. */
  captureIntegration(
    ctx: AdapterCallContext,
    uniqueKey: string,
  ): Promise<ImportInput & { snapshot: NangoSnapshot }>;
  /** One directory row per configured integration, grouped by provider service. */
  catalogEntries(
    ctx: AdapterCallContext,
    present: ReadonlySet<string>,
  ): Promise<CatalogEntry[]>;
}

/** Approved destinations for a Nango binding; a host builds its binding from these, never from a request. */
export function nangoDestinations(
  options: {
    apiOrigin?: string;
    connectOrigin?: string;
    network?: ApprovedDestination["network"];
  } = {},
): ApprovedDestination[] {
  const network = options.network ?? "public";
  return [
    {
      id: "api",
      origin: options.apiOrigin ?? NANGO_DEFAULT_API_ORIGIN,
      network,
    },
    {
      id: "connect",
      origin: options.connectOrigin ?? NANGO_DEFAULT_CONNECT_ORIGIN,
      network,
    },
  ];
}

export function createNangoAdapter(
  options: NangoAdapterOptions = {},
): NangoAdapter {
  const runtime: NangoRuntime = {
    options,
    cooldown: new CooldownRegistry(),
    rate: new RateWindowRegistry(),
  };
  const inbox = options.eventInbox ?? new BoundedEventInbox();
  const inflight = new Map<string, Promise<NangoConnectionInspection>>();
  const identity = {
    adapterVersion: NANGO_ADAPTER_VERSION,
    runtime: "hosted-server" as const,
  };
  const adapter: NangoAdapter = {
    id: NANGO_ADAPTER_ID,
    ecosystem: "nango",
    adapterVersion: NANGO_ADAPTER_VERSION,
    runtime: "hosted-server",
    displayName: "Nango",
    description:
      "Nango-brokered connections: integration discovery, Connect UI sessions, correlated verification, protected proxy/action/sync delegation and lifecycle webhooks. Credentials stay in Nango.",
    service: "nango",
    support: "provider-backed",
    custody: ["external-credential-broker", "external-execution-broker"],
    configuration: NANGO_CONFIGURATION,
    profiles: ["external-broker"],
    capabilities(present) {
      const core =
        present.has(NANGO_CONFIGURATION_NAMES.secretKey) &&
        present.has(NANGO_CONFIGURATION_NAMES.environment);
      const configuration = core ? ("ready" as const) : ("missing" as const);
      const row = (
        dimension: CapabilityStatus["dimension"],
        input: Partial<
          Pick<
            CapabilityStatus,
            "implementation" | "configuration" | "limitations" | "evidence"
          >
        > = {},
      ) =>
        capabilityStatus(identity, {
          dimension,
          profile: NANGO_PROFILE,
          configuration,
          evidence: "protocol-fixture",
          ...input,
        });
      return [
        row("discover", {
          limitations: [
            "GET /integrations is not paginated upstream; function listing is paginated per integration.",
          ],
        }),
        row("import", {
          configuration: "not-applicable",
          limitations: [
            "Imports API snapshots of integration + deployed functions; nango.yaml is refused as legacy.",
          ],
        }),
        row("configure", { configuration: "not-applicable", evidence: "unit" }),
        row("authorize", {
          limitations: [
            "Connect UI requires a person; interruption policy 'none' yields human-required.",
          ],
        }),
        row("verify", {
          limitations: [
            "Nango reports connection existence and auth errors, not provider account identity; exact-account intents need an approved verification operation.",
            "inspectConnection is privileged-internal: GET /connections/{id} returns credentials and may refresh them; it is not reachable through generic read-only agent routes.",
          ],
        }),
        row("invoke", {
          limitations: [
            "Proxy and action calls use only bound operations; asynchronous actions (X-Async) are not used.",
          ],
        }),
        row("events", {
          configuration:
            present.has(NANGO_CONFIGURATION_NAMES.webhookSigningKey) && core
              ? "ready"
              : "missing",
          limitations: [
            "X-Nango-Hmac-Sha256 (HMAC-SHA256 of the raw body with the webhook signing key) is verified; the legacy X-Nango-Signature header is ignored.",
            "Dedupe uses a bounded in-process inbox unless a shared event inbox is injected.",
          ],
        }),
        row("reconnect", {
          limitations: [
            "Only connections created through a connect session can be reconnected (documented Nango restriction).",
          ],
        }),
        row("disconnect", {
          limitations: [
            "Default scope is local unlink; DELETE /connections/{id} only under scope 'broker' and without unapproved shared references.",
          ],
        }),
        row("revoke", {
          implementation: "unsupported",
          configuration: "not-applicable",
          limitations: [
            "Nango documents no provider-grant revocation endpoint; broker deletion is not upstream revocation.",
          ],
        }),
        row("export", {
          implementation: "unsupported",
          configuration: "not-applicable",
          limitations: [
            "No Nango-native export format: nango.yaml is deprecated and Zero YAML is executable TypeScript.",
          ],
        }),
        row("delegate", {
          limitations: [
            "Syncs are triggered, scheduled, paused and inspected through Nango; cancel maps to POST /sync/pause (no run-cancel endpoint is documented); reset/emptyCache options are refused.",
          ],
        }),
      ];
    },
    discover: (ctx, input) => discoverNango(runtime, ctx, input),
    import: (ctx, input) => importNango(ctx, input),
    authorize: (ctx, intent) => authorizeNango(runtime, ctx, intent, "connect"),
    complete: (ctx, input) => completeNango(runtime, ctx, input),
    verify: (ctx) => verifyNango(runtime, ctx),
    invoke: (ctx, request) => invokeNango(runtime, ctx, request),
    events: createNangoEventPort(runtime),
    reconnect: (ctx, intent) =>
      authorizeNango(runtime, ctx, intent, "reconnect"),
    disconnect: (ctx, scope) => disconnectNango(runtime, ctx, scope),
    revoke: async () => revokeNango(),
    delegate: (ctx, request) => delegateNango(runtime, ctx, request),
    inspectConnection: (ctx) => inspectNangoConnection(runtime, inflight, ctx),
    reconcileEvent: (ctx, event) =>
      reconcileNangoEvent(runtime, inbox, ctx, event),
    deleteBrokerConnection: (ctx, options) =>
      deleteNangoBrokerConnection(runtime, ctx, options),
    captureIntegration: (ctx, uniqueKey) =>
      captureNangoIntegration(runtime, ctx, uniqueKey),
    catalogEntries: (ctx, present) =>
      nangoCatalogEntries(adapter, runtime, ctx, present),
  };
  return adapter;
}
