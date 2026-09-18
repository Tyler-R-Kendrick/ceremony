import { z } from "zod";
import type {
  CompatibilityIssue,
  SupportDimension,
} from "../../../../core/connectors/index.js";
import type {
  AdapterCallContext,
  AuthorizationIntent,
  AuthorizationStart,
  CompletionInput,
  CompletionResult,
  ConnectorAdapter,
  DisconnectResult,
  DisconnectScope,
  DiscoverInput,
  DiscoverResult,
  InvokeRequest,
  InvokeResult,
} from "../../adapter.js";
import { capabilityStatus } from "../../adapter.js";
import type {
  CapabilityStatus,
  ConfigurationRequirement,
} from "../../adapter-types.js";
import { ConnectorError } from "../../errors.js";
import {
  composioConfigurationNames,
  createComposioShared,
  defaultComposioTimeouts,
  readComposioConfiguration,
  type ComposioShared,
  type ComposioTimeouts,
} from "./client.js";
import {
  fetchAuthConfigs,
  fetchConnectedAccounts,
  fetchTools,
  getToolkit,
  listAuthConfigs,
  listConnectedAccounts,
  listToolkits,
  listTools,
  negativeCapabilities,
} from "./catalog.js";
import {
  composioAuthorize,
  composioComplete,
  composioVerify,
  COMPOSIO_PROFILE_ID,
} from "./connect.js";
import {
  prepareComposioCall,
  COMPOSIO_ADAPTER_ID,
  type ComposioCall,
  type ComposioResolvedOptions,
} from "./context.js";
import { composioInvoke } from "./execute.js";
import { composioDisconnect } from "./lifecycle.js";
import { COMPOSIO_API_ORIGIN, COMPOSIO_SOURCE_PROFILE } from "./wire.js";

/*
 * The Composio adapter.
 *
 * Custody is external in both senses Ceremony distinguishes: Composio stores
 * the end user's provider credential (a credential broker) and executes tools
 * against it (an execution broker). This adapter holds the project API key,
 * which is the host's own credential, and references — never the user's.
 *
 * Four Composio concepts stay four things: a toolkit is a versioned family of
 * tools, an auth config is the reusable blueprint a grant is created under, a
 * connected account is one host user's credential under one auth config, and a
 * session is a runtime context that can span toolkits. A request names none of
 * them: the binding names the toolkit and the auth configs, the connection
 * names the account, and the Composio user is derived from the authenticated
 * host owner.
 */

export const COMPOSIO_ADAPTER_VERSION = "1.0.0";

export type ComposioAdapterOptions = {
  /** Path on the deployment origin that receives hosted authorization returns. */
  returnPath?: string;
  /** Host key that makes the derived Composio user id unguessable outside the deployment. */
  userIdKey?: Uint8Array;
  /** How long a hosted authorization handoff stays valid. Composio expires INITIATED after ten minutes. */
  handoffTtlMs?: number;
  /** Extra exact origins a hosted authorization URL may have, beyond the binding's `connect` destination. */
  authorizationOrigins?: readonly string[];
  /** Deleting a connected account at Composio is permanent; off unless a deployment enables it. */
  allowBrokerDeletion?: boolean;
  timeouts?: Partial<ComposioTimeouts>;
  /** Process-local session and rate-limit state; supply one per deployment. */
  shared?: ComposioShared;
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

/** Composio documents a ten-minute life for an INITIATED connection. */
const DEFAULT_HANDOFF_TTL_MS = 10 * 60 * 1000;

function resolveOptions(
  options: ComposioAdapterOptions,
): ComposioResolvedOptions {
  return {
    returnPath: pathSchema.parse(
      options.returnPath ?? "/api/v1/connectors/composio/return",
    ),
    ...(options.userIdKey
      ? { userIdKey: options.userIdKey }
      : { userIdKey: undefined }),
    handoffTtlMs: Math.min(
      Math.max(options.handoffTtlMs ?? DEFAULT_HANDOFF_TTL_MS, 60_000),
      60 * 60 * 1000,
    ),
    authorizationOrigins: (options.authorizationOrigins ?? []).map((origin) =>
      originSchema.parse(origin),
    ),
    timeouts: { ...defaultComposioTimeouts, ...(options.timeouts ?? {}) },
  };
}

export const composioConfiguration: readonly ConfigurationRequirement[] =
  Object.freeze([
    {
      name: composioConfigurationNames.apiKey,
      source: "session-environment",
      classification: "secret",
      required: true,
      description:
        "Composio project API key, sent as the documented x-api-key header. Server-only; it never reaches a browser or a model.",
    },
  ]);

const dimensionProfiles: Record<SupportDimension, string> = {
  discover: "composio-toolkits-v3",
  import: "composio-tools-v3",
  configure: "composio-project-v3",
  authorize: "composio-hosted-authorization",
  verify: "composio-connected-accounts-v3",
  invoke: "composio-tool-execution-v3",
  events: "composio-triggers",
  reconnect: "composio-hosted-authorization",
  disconnect: "composio-connected-accounts-v3",
  revoke: "composio-connected-accounts-v3",
  export: "composio-tools-v3",
  delegate: "composio-tool-router-v3",
};

const dimensionLimitations: Partial<Record<SupportDimension, string[]>> = {
  discover: [
    "Toolkits, auth configs and connected accounts are discovered separately; a toolkit never implies an account.",
    "Composio states no version for an auth config or a connected account; those rows are recorded as unversioned.",
  ],
  import: [
    "This adapter does not build a normalized definition from a Composio document; discovery carries the versioned capability metadata instead.",
  ],
  authorize: [
    "The end user authorizes on Composio's hosted page; Ceremony never sees the provider credential.",
    "Only OAuth auth configs are driven: an API-key auth config would require submitting the user's credential to Composio.",
    "An INITIATED connection expires after ten minutes, per Composio's documentation.",
  ],
  verify: [
    "Evidence is Composio's account record for the derived user; the provider account behind it is not observed by Ceremony.",
    "Composio redacts credential fields in state.val; this adapter reads none of them.",
  ],
  invoke: [
    "Only tools in the binding's allowlist run, at the pinned version, with the reviewed input schema.",
    "Router meta tools are disabled unless the binding authorizes each one separately.",
    "The session execute_meta request body is reused from the documented session execute body and is unverified.",
  ],
  events: [
    "Composio triggers and their webhook verification are not bound by this adapter.",
  ],
  disconnect: [
    "Local unlink performs no Composio call. Broker scope deletes the connected account permanently and is disabled unless the deployment enables it.",
  ],
  revoke: [
    "Composio documents no operation that revokes the end user's grant at the third-party provider.",
  ],
  export: ["Composio tool descriptions are not re-exported by this adapter."],
  delegate: [
    "Session delegation runs approved tools only; the workbench and bash meta tools are not bound.",
  ],
};

const unsupportedDimensions = new Set<SupportDimension>([
  "import",
  "events",
  "revoke",
  "export",
]);

export type ComposioDiscoverKind =
  | "toolkit"
  | "auth-config"
  | "connected-account"
  | "tool"
  | "negative-capabilities";

/**
 * The negative-capability report: what this toolkit advertises that the
 * current account cannot do. It is a discovery result with no items and only
 * issues, because a capability the account lacks is a fact about the grant,
 * not a row in a catalogue.
 */
async function negativeCapabilityReport(
  call: ComposioCall,
): Promise<DiscoverResult> {
  const toolkit = await getToolkit(call, call.settings.toolkit.slug);
  const configs = await fetchAuthConfigs(call);
  const recorded = call.ctx.connection?.externalIds.authConfigId;
  const authConfig =
    configs.find((config) => config.id === recorded) ??
    configs.find((config) => call.settings.authConfigs.includes(config.id));
  const accountId = call.ctx.connection?.externalIds.connectedAccountId;
  const { accounts } = await fetchConnectedAccounts(call);
  const account = accountId
    ? accounts.find((item) => item.id === accountId)
    : undefined;
  const { tools } = await fetchTools(call, { limit: 50 });
  const issues: CompatibilityIssue[] = negativeCapabilities(call, {
    toolkit,
    authConfig,
    account,
    tools,
  });
  return {
    items: [],
    freshness: {
      fetchedAt: call.ctx.environment.now(),
      stale: false,
      source: "live",
    },
    issues,
  };
}

/**
 * `createComposioAdapter` produces an adapter bound to injected options only;
 * every per-call dependency arrives through the adapter call context, so a
 * fixture server on loopback exercises the same wire code a deployment runs.
 */
export function createComposioAdapter(
  options: ComposioAdapterOptions = {},
): ConnectorAdapter {
  const resolved = resolveOptions(options);
  const shared = options.shared ?? createComposioShared();
  const deps = {
    shared,
    options: resolved,
    adapterVersion: COMPOSIO_ADAPTER_VERSION,
  };
  const allowBrokerDeletion = options.allowBrokerDeletion === true;

  const prepare = async (
    ctx: AdapterCallContext,
    ownerKind?: AuthorizationIntent["ownerKind"],
  ): Promise<ComposioCall> => {
    const report = await readComposioConfiguration(ctx);
    if (report.missing.length)
      throw new ConnectorError("configuration-required", {
        detail: "composio.configuration.missing",
      });
    return prepareComposioCall(ctx, deps, ownerKind);
  };

  return {
    id: COMPOSIO_ADAPTER_ID,
    ecosystem: "composio",
    adapterVersion: COMPOSIO_ADAPTER_VERSION,
    runtime: "hosted-server",
    displayName: "Composio",
    description:
      "Hosted authorization, connected-account selection and approved tool execution for one Composio toolkit, on behalf of a host-derived user.",
    service: "composio",
    support: "provider-backed",
    custody: ["external-credential-broker", "external-execution-broker"],
    configuration: composioConfiguration,
    profiles: [COMPOSIO_PROFILE_ID, "external-broker"],

    capabilities(present: ReadonlySet<string>): CapabilityStatus[] {
      const missing = composioConfiguration.some(
        (item) => item.required && !present.has(item.name),
      );
      return (Object.keys(dimensionProfiles) as SupportDimension[]).map(
        (dimension) => {
          const unsupported = unsupportedDimensions.has(dimension);
          return capabilityStatus(
            {
              adapterVersion: COMPOSIO_ADAPTER_VERSION,
              runtime: "hosted-server",
            },
            {
              dimension,
              profile: dimensionProfiles[dimension],
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
      const call = await prepare(ctx);
      const kind = (input.scope?.kind ?? "toolkit") as ComposioDiscoverKind;
      switch (kind) {
        case "toolkit":
          return listToolkits(call, input);
        case "auth-config":
          return listAuthConfigs(call, input);
        case "connected-account":
          return listConnectedAccounts(call, input);
        case "tool":
          return listTools(call, input);
        case "negative-capabilities":
          return negativeCapabilityReport(call);
        default:
          throw new ConnectorError("invalid-request", {
            detail: "composio.discover.scope",
          });
      }
    },

    async authorize(
      ctx: AdapterCallContext,
      intent: AuthorizationIntent,
    ): Promise<AuthorizationStart> {
      if (intent.ownerKind !== "user")
        return { kind: "unsupported", code: "composio.owner.unsupported" };
      const report = await readComposioConfiguration(ctx);
      if (report.missing.length)
        return { kind: "configuration-required", missing: report.missing };
      return composioAuthorize(
        prepareComposioCall(ctx, deps, intent.ownerKind),
        intent,
        "authorize",
      );
    },

    async reconnect(
      ctx: AdapterCallContext,
      intent: AuthorizationIntent,
    ): Promise<AuthorizationStart> {
      if (intent.ownerKind !== "user")
        return { kind: "unsupported", code: "composio.owner.unsupported" };
      const report = await readComposioConfiguration(ctx);
      if (report.missing.length)
        return { kind: "configuration-required", missing: report.missing };
      return composioAuthorize(
        prepareComposioCall(ctx, deps, intent.ownerKind),
        intent,
        "reconnect",
      );
    },

    async complete(
      ctx: AdapterCallContext,
      input: CompletionInput,
    ): Promise<CompletionResult> {
      return composioComplete(await prepare(ctx), input);
    },

    async verify(ctx: AdapterCallContext): Promise<CompletionResult> {
      return composioVerify(await prepare(ctx));
    },

    async invoke(
      ctx: AdapterCallContext,
      request: InvokeRequest,
    ): Promise<InvokeResult> {
      return composioInvoke(await prepare(ctx), request, shared);
    },

    async disconnect(
      ctx: AdapterCallContext,
      scope: DisconnectScope,
    ): Promise<DisconnectResult> {
      return composioDisconnect(await prepare(ctx), scope, {
        allowBrokerDeletion,
      });
    },

    async revoke(ctx: AdapterCallContext): Promise<DisconnectResult> {
      // Composio documents no operation that revokes the end user's grant at
      // the provider. Reporting that is the honest result; deleting Composio's
      // own copy instead would claim an upstream effect that never happened.
      await prepare(ctx);
      return {
        local: "not-attempted",
        broker: "not-attempted",
        upstream: "unsupported",
      };
    },
  };
}

export {
  COMPOSIO_ADAPTER_ID,
  COMPOSIO_API_ORIGIN,
  COMPOSIO_PROFILE_ID,
  COMPOSIO_SOURCE_PROFILE,
};
export { composioConfigurationNames, createComposioShared } from "./client.js";
export type { ComposioShared, ComposioTimeouts } from "./client.js";
export {
  composioAuthorityInstance,
  composioLifecycle,
  composioUserId,
  isExecutableStatus,
  isTerminalStatus,
} from "./identity.js";
export {
  composioBindingSettingsSchema,
  composioRoute,
  permittedAccounts,
  readComposioSettings,
  type ComposioBindingSettings,
} from "./settings.js";
export { negativeCapabilities, UNVERSIONED } from "./catalog.js";
export { toolkitCapabilities } from "./lifecycle.js";
export {
  composioAccountStatuses,
  composioMetaTools,
  composioUnimplementedEndpoints,
  composioEndpoints,
  unrestrictedMetaTools,
} from "./wire.js";
export { selectAccount } from "./connect.js";
export { reservedArgumentNames } from "./execute.js";
