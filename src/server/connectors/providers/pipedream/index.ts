import { z } from "zod";
import { encodePathSegment } from "../../../../core/connectors/index.js";
import type {
  AuthorizationIntent,
  AuthorizationStart,
  CompletionInput,
  CompletionResult,
  ConnectorAdapter,
  DisconnectResult,
  DisconnectScope,
  DiscoverInput,
  DiscoverResult,
  EventPort,
  ImportInput,
  ImportOutcome,
  InvokeRequest,
  InvokeResult,
} from "../../adapter.js";
import { capabilityStatus } from "../../adapter.js";
import type {
  CapabilityStatus,
  ConfigurationRequirement,
} from "../../adapter-types.js";
import type { SupportDimension } from "../../../../core/connectors/index.js";
import { ConnectorError } from "../../errors.js";
import type { AdapterCallContext } from "../../adapter.js";
import {
  createPipedreamShared,
  pipedreamConfigurationNames,
  readPipedreamConfig,
  upstreamFailure,
  type PipedreamConfig,
  type PipedreamShared,
  type PipedreamTimeouts,
} from "./client.js";
import {
  pipedreamAuthorize,
  pipedreamComplete,
  pipedreamVerify,
  PIPEDREAM_PROFILE_ID,
} from "./connect.js";
import {
  guardConnection,
  preparePipedreamCall,
  PIPEDREAM_ADAPTER_ID,
  type PipedreamCall,
  type PipedreamResolvedOptions,
} from "./context.js";
import { verifyPipedreamDelivery } from "./events.js";
import { pipedreamInvoke } from "./execute.js";
import { pipedreamDiscover, pipedreamImport } from "./inventory.js";
import { pipedreamTriggerIdSchema } from "./identity.js";
import { PIPEDREAM_API_ORIGIN, PIPEDREAM_CONNECT_LINK_ORIGIN } from "./wire.js";

/*
 * The Pipedream Connect adapter.
 *
 * Custody is external: Pipedream holds the end user's provider credential and
 * executes against it, so this adapter is a credential broker for connection
 * state and an execution broker for the proxy, actions and triggers. It never
 * asks for the user's provider credential, never receives one, and holds only
 * the project access token (its own workspace credential) and references.
 *
 * Three identities are kept apart throughout: the Ceremony owner, the
 * Pipedream external user derived from that owner, and the connected account
 * the end user chose at the broker. The request never names any of them.
 */

export const PIPEDREAM_ADAPTER_VERSION = "1.0.0";

export type PipedreamAdapterOptions = {
  /** Path on the deployment origin that receives Connect Link returns. */
  returnPath?: string;
  /** Path prefix that receives unsigned connection webhooks, when the host mounts one. */
  connectionWebhookPath?: string;
  /** Host key that makes the external user id unguessable outside the deployment. */
  externalUserKey?: Uint8Array;
  /** Additional exact origins a Connect Link may have; the documented one is always allowed. */
  connectLinkOrigins?: readonly string[];
  /** Replay window for signed trigger deliveries, in seconds. */
  maxSignatureAgeSeconds?: number;
  timeouts?: Partial<PipedreamTimeouts>;
  /** Process-local token and rate-limit state; supply one per deployment. */
  shared?: PipedreamShared;
};

const pathSchema = z
  .string()
  .max(512)
  .regex(/^\/(?!\/)[^\p{Cc}?#]*$/u);
const originSchema = z.string().refine((value) => {
  if (!URL.canParse(value)) return false;
  const url = new URL(value);
  return url.origin === value && url.protocol === "https:";
}, "Exact HTTPS origin required");

const defaultTimeouts: PipedreamTimeouts = {
  token: 10_000,
  read: 15_000,
  write: 20_000,
  proxy: 30_000,
  action: 60_000,
};

function resolveOptions(
  options: PipedreamAdapterOptions,
): PipedreamResolvedOptions {
  const returnPath = pathSchema.parse(
    options.returnPath ?? "/api/v1/connectors/pipedream/return",
  );
  const webhookPath =
    options.connectionWebhookPath === undefined
      ? undefined
      : pathSchema.parse(options.connectionWebhookPath);
  return {
    returnPath,
    connectionWebhookPath: webhookPath,
    connectLinkOrigins: [
      PIPEDREAM_CONNECT_LINK_ORIGIN,
      ...(options.connectLinkOrigins ?? []).map((origin) =>
        originSchema.parse(origin),
      ),
    ],
    ...(options.externalUserKey
      ? { externalUserKey: options.externalUserKey }
      : { externalUserKey: undefined }),
    maxSignatureAgeSeconds: Math.min(
      Math.max(options.maxSignatureAgeSeconds ?? 300, 30),
      3600,
    ),
    timeouts: { ...defaultTimeouts, ...(options.timeouts ?? {}) },
  };
}

export const pipedreamConfiguration: readonly ConfigurationRequirement[] =
  Object.freeze([
    {
      name: pipedreamConfigurationNames.projectId,
      source: "session-environment",
      classification: "public",
      required: true,
      description: "Pipedream project id (proj_...) that owns the connections.",
    },
    {
      name: pipedreamConfigurationNames.environment,
      source: "session-environment",
      classification: "public",
      required: true,
      description:
        "Pipedream Connect environment: development or production. Accounts do not cross environments.",
    },
    {
      name: pipedreamConfigurationNames.clientId,
      source: "session-environment",
      classification: "public",
      required: true,
      description:
        "Workspace OAuth client id used for the client-credentials grant.",
    },
    {
      name: pipedreamConfigurationNames.clientSecret,
      source: "session-environment",
      classification: "secret",
      required: true,
      description:
        "Workspace OAuth client secret. Server-only; it never reaches a browser or a model.",
    },
  ]);

const dimensionProfiles: Record<SupportDimension, string> = {
  discover: "pipedream-connect-apps",
  import: "pipedream-connect-components",
  configure: "pipedream-connect-project",
  authorize: "pipedream-connect-managed-auth",
  verify: "pipedream-connect-accounts",
  invoke: "pipedream-connect-proxy-actions",
  events: "pipedream-connect-trigger-webhooks",
  reconnect: "pipedream-connect-managed-auth",
  disconnect: "pipedream-connect-accounts",
  revoke: "pipedream-connect-accounts",
  export: "pipedream-connect-components",
  delegate: "pipedream-connect-workflows",
};

const dimensionLimitations: Partial<Record<SupportDimension, string[]>> = {
  authorize: [
    "The end user authorizes at Pipedream; Ceremony never sees the provider credential.",
    "A connect token is single-use and expires within four hours.",
  ],
  verify: [
    "Evidence is the broker's account record for the derived external user; Ceremony does not query the provider directly.",
  ],
  invoke: [
    "Proxy requests are limited to apps Pipedream marks proxy_enabled and to that app's allowed domains.",
    "Pipedream terminates a proxied request after 30 seconds; a lost write stays indeterminate.",
  ],
  events: [
    "Trigger deliveries are authenticated with the documented HMAC-SHA256 x-pd-signature scheme.",
    "Connection webhooks are unsigned in Pipedream's documentation and are refused as events.",
  ],
  disconnect: [
    "Local unlink performs no broker call; broker scope deletes the connected account at Pipedream.",
  ],
  revoke: [
    "Pipedream documents no endpoint that revokes the end user's grant at the third-party provider.",
  ],
  delegate: ["Pipedream workflow delegation is not bound by this adapter."],
  export: [
    "Component descriptions are imported but not re-exported by this adapter.",
  ],
};

const unsupportedDimensions = new Set<SupportDimension>([
  "revoke",
  "export",
  "delegate",
]);

/**
 * `createPipedreamConnectAdapter` produces an adapter bound to injected
 * options only; every per-call dependency arrives through the adapter call
 * context, so a fixture server on loopback exercises the same wire code a
 * deployment runs.
 */
export function createPipedreamConnectAdapter(
  options: PipedreamAdapterOptions = {},
): ConnectorAdapter {
  const resolved = resolveOptions(options);
  const shared = options.shared ?? createPipedreamShared();
  const deps = {
    shared,
    options: resolved,
    adapterVersion: PIPEDREAM_ADAPTER_VERSION,
  };

  const prepare = async (
    ctx: AdapterCallContext,
    ownerKind?: AuthorizationIntent["ownerKind"],
  ): Promise<PipedreamCall> => {
    const report = await readPipedreamConfig(ctx);
    if (!report.config)
      throw new ConnectorError("configuration-required", {
        detail: "pipedream.configuration.missing",
      });
    return preparePipedreamCall(
      ctx,
      report.config satisfies PipedreamConfig,
      deps,
      ownerKind,
    );
  };

  const events: EventPort = {
    async verify(ctx, delivery) {
      let call: PipedreamCall;
      try {
        call = await prepare(ctx);
        guardConnection(call);
      } catch {
        // An unverifiable delivery is never an event, whatever the reason.
        return undefined;
      }
      return verifyPipedreamDelivery(call, ctx, delivery);
    },
  };

  return {
    id: PIPEDREAM_ADAPTER_ID,
    ecosystem: "pipedream",
    adapterVersion: PIPEDREAM_ADAPTER_VERSION,
    runtime: "hosted-server",
    displayName: "Pipedream Connect",
    description:
      "Managed authentication, proxied requests and approved component execution for one Pipedream app, on behalf of a host-derived external user.",
    service: "pipedream",
    support: "provider-backed",
    custody: ["external-credential-broker", "external-execution-broker"],
    configuration: pipedreamConfiguration,
    profiles: ["external-broker", "oauth-client-credentials"],

    capabilities(present: ReadonlySet<string>): CapabilityStatus[] {
      const missing = pipedreamConfiguration.some(
        (item) => item.required && !present.has(item.name),
      );
      return (Object.keys(dimensionProfiles) as SupportDimension[]).map(
        (dimension) => {
          const unsupported = unsupportedDimensions.has(dimension);
          return capabilityStatus(
            {
              adapterVersion: PIPEDREAM_ADAPTER_VERSION,
              runtime: "hosted-server",
            },
            {
              dimension,
              profile: dimensionProfiles[dimension] ?? "pipedream-connect",
              implementation: unsupported ? "unsupported" : "implemented",
              configuration: unsupported
                ? "not-applicable"
                : missing
                  ? "missing"
                  : "ready",
              evidence: unsupported ? "not-tested" : "protocol-fixture",
              limitations: dimensionLimitations[dimension] ?? [],
            },
          );
        },
      );
    },

    async discover(
      ctx: AdapterCallContext,
      input: DiscoverInput,
    ): Promise<DiscoverResult> {
      return pipedreamDiscover(await prepare(ctx), input);
    },

    async import(
      ctx: AdapterCallContext,
      input: ImportInput,
    ): Promise<ImportOutcome> {
      return pipedreamImport(await prepare(ctx), input);
    },

    async authorize(
      ctx: AdapterCallContext,
      intent: AuthorizationIntent,
    ): Promise<AuthorizationStart> {
      const report = await readPipedreamConfig(ctx);
      if (!report.config)
        return { kind: "configuration-required", missing: report.missing };
      return pipedreamAuthorize(
        preparePipedreamCall(ctx, report.config, deps, intent.ownerKind),
        intent,
        "authorize",
      );
    },

    async reconnect(
      ctx: AdapterCallContext,
      intent: AuthorizationIntent,
    ): Promise<AuthorizationStart> {
      const report = await readPipedreamConfig(ctx);
      if (!report.config)
        return { kind: "configuration-required", missing: report.missing };
      return pipedreamAuthorize(
        preparePipedreamCall(ctx, report.config, deps, intent.ownerKind),
        intent,
        "reconnect",
      );
    },

    async complete(
      ctx: AdapterCallContext,
      input: CompletionInput,
    ): Promise<CompletionResult> {
      return pipedreamComplete(await prepare(ctx), input);
    },

    async verify(ctx: AdapterCallContext): Promise<CompletionResult> {
      return pipedreamVerify(await prepare(ctx));
    },

    async invoke(
      ctx: AdapterCallContext,
      request: InvokeRequest,
    ): Promise<InvokeResult> {
      return pipedreamInvoke(await prepare(ctx), request);
    },

    events,

    async disconnect(
      ctx: AdapterCallContext,
      scope: DisconnectScope,
    ): Promise<DisconnectResult> {
      const call = await prepare(ctx);
      const connection = guardConnection(call);
      if (scope === "local")
        // A local unlink is a host decision. Nothing is asked of the broker,
        // and nothing upstream changes.
        return {
          local: "applied",
          broker: "not-attempted",
          upstream: "not-attempted",
        };
      if (scope === "upstream")
        return {
          local: "not-attempted",
          broker: "not-attempted",
          upstream: "unsupported",
        };
      const accountId = connection.externalIds.accountId;
      if (!accountId)
        return {
          local: "not-attempted",
          broker: "not-attempted",
          upstream: "not-attempted",
        };
      const triggers = Object.values(
        (connection.state as { pipedreamTriggers?: unknown })
          .pipedreamTriggers ?? {},
      ).filter(
        (value): value is string =>
          typeof value === "string" &&
          pipedreamTriggerIdSchema.safeParse(value).success,
      );
      let broker: DisconnectResult["broker"] = "applied";
      const brokerFailure = (error: unknown): DisconnectResult["broker"] =>
        error instanceof ConnectorError && error.code === "indeterminate"
          ? "indeterminate"
          : "failed";
      for (const triggerId of triggers.slice(0, 32)) {
        try {
          await call.client.send({
            method: "DELETE",
            path: call.client.projectPath(
              `/deployed-triggers/${encodePathSegment(triggerId)}`,
            ),
            query: { external_user_id: call.externalUserId },
            timeoutMs: resolved.timeouts.write,
            consequential: true,
          });
        } catch (error) {
          broker = brokerFailure(error);
        }
      }
      try {
        const response = await call.client.send({
          method: "DELETE",
          path: call.client.projectPath(
            `/accounts/${encodePathSegment(accountId)}`,
          ),
          timeoutMs: resolved.timeouts.write,
          consequential: true,
        });
        if (
          response.status !== 204 &&
          response.status !== 200 &&
          response.status !== 404
        )
          throw upstreamFailure(response.status);
      } catch (error) {
        return {
          local: "not-attempted",
          broker: brokerFailure(error),
          upstream: "not-attempted",
        };
      }
      return {
        local: "not-attempted",
        broker,
        // Deleting the broker's copy is not the provider revoking the grant.
        upstream: "not-attempted",
      };
    },

    async revoke(ctx: AdapterCallContext): Promise<DisconnectResult> {
      const call = await prepare(ctx);
      guardConnection(call);
      // Pipedream documents no endpoint that revokes the end user's grant at
      // the third-party provider. Saying so is the honest result; quietly
      // deleting the broker account instead would claim more than happened.
      return {
        local: "not-attempted",
        broker: "not-attempted",
        upstream: "unsupported",
      };
    },
  };
}

export { PIPEDREAM_ADAPTER_ID, PIPEDREAM_PROFILE_ID, PIPEDREAM_API_ORIGIN };
export { createPipedreamShared } from "./client.js";
export type { PipedreamShared } from "./client.js";
export {
  pipedreamExternalUserId,
  pipedreamAuthorityInstance,
  pipedreamTenantRoute,
} from "./identity.js";
export { triggerSigningKeyRefs } from "./events.js";
export { PIPEDREAM_SOURCE_PROFILE } from "./wire.js";
