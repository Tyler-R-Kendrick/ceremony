import { createHash, randomUUID } from "node:crypto";
import {
  canonicalConnectorJson,
  type VerificationClaim,
} from "../../../core/connectors/index.js";
import type {
  AdapterCallContext,
  AuthorizationIntent,
  AuthorizationStart,
  CompletionInput,
  CompletionResult,
  ConnectorAdapter,
  DisconnectResult,
  DisconnectScope,
  HandoffProposal,
  InvokeRequest,
  InvokeResult,
  CapabilityStatus,
} from "../adapter.js";
import { capabilityStatus } from "../adapter.js";
import {
  boundOperation,
  destinationFor,
  type BoundOperation,
  type RuntimeBinding,
} from "../binding.js";
import { ConnectorError } from "../errors.js";
import type { CredentialScope, HandoffRecord } from "../ports.js";
import type { AuthorizationChallenge } from "./authorization.js";
import { McpResultCache } from "./cache.js";
import {
  createMcpClient,
  type CallToolPayload,
  type GetPromptPayload,
  type McpAuth,
  type McpClient,
  type McpOutcome,
  type ReadResourcePayload,
} from "./client.js";
import {
  buildInputHandoff,
  buildInputResponses,
  elicitationDigest,
  inputDigest,
  parseInputRequests,
  readSuspendedInput,
  type FormValues,
  type ParsedInputRequest,
  type ResumeAction,
  type SuspendedInput,
} from "./input.js";
import {
  capabilityProfileLabel,
  mcpProfileIds,
  parseMcpBindingSettings,
  profileFor,
  resolveLimits,
  type McpBindingSettings,
  type McpLimits,
  type McpProfileId,
} from "./profiles.js";

/*
 * The `mcp-remote` adapter: one hosted MCP server, reached as a connector.
 *
 * The client below knows the protocol; this file knows the host's rules. It
 * refuses an operation the binding does not name, pins each call to the
 * binding's destination, opens a credential only inside `credentials.use`,
 * journals every consequential call before making it, turns a server's
 * request for more input into a private suspended handoff, and never treats
 * a dropped response to a write as a reason to call again.
 */

export const MCP_ADAPTER_VERSION = "1.0.0";

/** Sanitized view of a 401/403 challenge; safe for adapter state and evidence. */
export type McpChallengeState = {
  status: number;
  error?: string;
  requestedScopes: string[];
  authorizationServers: string[];
  resourceMetadataUrl?: string;
  canonicalResource: string;
  clientRegistration: string[];
  issues: string[];
};

export function summarizeChallenge(
  challenge: AuthorizationChallenge,
): McpChallengeState {
  return {
    status: challenge.status,
    ...(challenge.error ? { error: challenge.error } : {}),
    requestedScopes: challenge.requestedScopes.slice(0, 32),
    authorizationServers: (
      challenge.metadata?.authorizationServers ?? []
    ).slice(0, 8),
    ...(challenge.resourceMetadataUrl
      ? { resourceMetadataUrl: challenge.resourceMetadataUrl }
      : {}),
    canonicalResource: challenge.canonicalResource,
    clientRegistration: [...challenge.clientRegistration],
    issues: challenge.issues.slice(0, 16),
  };
}

/**
 * What the OAuth swarm implements for MCP servers that are OAuth-protected.
 * It receives the parsed challenge — the metadata document, the scopes the
 * server named, the resource indicator to request — and owns everything from
 * there: client registration, PKCE, the authorization URL and its handoff.
 */
export type McpOAuthRequest = {
  challenge: AuthorizationChallenge;
  intent: AuthorizationIntent;
  /** RFC 8707 canonical resource identifier of this MCP endpoint. */
  resource: string;
  profile: McpProfileId;
};
export type BeginMcpOAuth = (
  ctx: AdapterCallContext,
  request: McpOAuthRequest,
) => Promise<AuthorizationStart>;

/** Vends a bearer for an externally brokered connection without exporting it. */
export interface McpBrokerPort {
  useBearer<T>(
    ctx: AdapterCallContext,
    work: (token: string) => Promise<T>,
  ): Promise<T>;
}

export type McpRemoteAdapterOptions = {
  adapterVersion?: string;
  displayName?: string;
  description?: string;
  service?: string;
  beginOAuth?: BeginMcpOAuth;
  broker?: McpBrokerPort;
  /** Shared, principal-keyed cache; one per deployment is expected. */
  cache?: McpResultCache;
  /** Longest a suspended input handoff stays open. */
  inputHandoffMs?: number;
};

const BEARER_FIELDS = ["bearer", "access_token", "token", "apiKey"] as const;

function settingsOf(binding: RuntimeBinding): McpBindingSettings {
  const raw = (binding.settings as Record<string, unknown>).mcp;
  if (raw === undefined)
    throw new ConnectorError("invalid-request", {
      detail: "mcp.binding.settings-missing",
    });
  try {
    return parseMcpBindingSettings(raw);
  } catch {
    throw new ConnectorError("invalid-request", {
      detail: "mcp.binding.settings-invalid",
    });
  }
}

function endpointFor(ctx: AdapterCallContext, operation?: BoundOperation): URL {
  const settings = settingsOf(ctx.binding);
  const destination = operation
    ? destinationFor(ctx.binding, operation)
    : ctx.binding.destinations[0];
  if (!destination)
    throw new ConnectorError("network-policy", {
      detail: "mcp.binding.no-destination",
    });
  const url = new URL(settings.endpointPath, destination.origin);
  if (url.origin !== destination.origin)
    throw new ConnectorError("network-policy", {
      detail: "mcp.binding.endpoint-escaped",
    });
  const prefix = destination.pathPrefix;
  if (
    prefix &&
    !(
      url.pathname === prefix ||
      url.pathname.startsWith(prefix.endsWith("/") ? prefix : `${prefix}/`)
    )
  )
    throw new ConnectorError("network-policy", {
      detail: "mcp.binding.endpoint-outside-prefix",
    });
  return url;
}

function credentialScope(ctx: AdapterCallContext): CredentialScope {
  const connection = ctx.connection;
  if (!connection)
    throw new ConnectorError("invalid-request", {
      detail: "mcp.connection.missing",
    });
  return {
    tenantId: connection.tenantId,
    ownerKind: connection.ownerKind,
    ownerId: connection.ownerId,
    connectionRef: connection.connectionRef,
    bindingRef: connection.bindingRef,
    custody: connection.custody,
  };
}

function authFor(
  ctx: AdapterCallContext,
  options: McpRemoteAdapterOptions,
  settings: McpBindingSettings,
): McpAuth {
  if (settings.auth === "none") return { kind: "none" };
  if (settings.auth === "broker") {
    const broker = options.broker;
    if (!broker)
      throw new ConnectorError("configuration-required", {
        detail: "mcp.broker.missing",
      });
    return { kind: "bearer", use: (work) => broker.useBearer(ctx, work) };
  }
  const ref = ctx.connection?.credentialRef;
  if (!ref)
    throw new ConnectorError("unauthenticated", {
      detail: "mcp.credential.missing",
    });
  const scope = credentialScope(ctx);
  return {
    kind: "bearer",
    use: (work) =>
      ctx.environment.credentials.use(scope, ref, async (material) => {
        const token = BEARER_FIELDS.map((field) => material[field]).find(
          (value) => typeof value === "string" && value.length > 0,
        );
        if (!token)
          throw new ConnectorError("unauthenticated", {
            detail: "mcp.credential.not-a-bearer",
          });
        return work(token);
      }),
  };
}

type ClientBundle = {
  client: McpClient;
  settings: McpBindingSettings;
  limits: McpLimits;
  endpoint: URL;
};

function clientFor(
  ctx: AdapterCallContext,
  options: McpRemoteAdapterOptions,
  extra: {
    operation?: BoundOperation;
    onElicitation?: Parameters<typeof createMcpClient>[0]["onElicitation"];
  } = {},
): ClientBundle {
  const settings = settingsOf(ctx.binding);
  const limits = resolveLimits(settings.limits);
  const endpoint = endpointFor(ctx, extra.operation);
  const connection = ctx.connection;
  const client = createMcpClient({
    profile: settings.profile,
    compatibility: settings.compatibility,
    endpoint,
    fetch: ctx.environment.fetch,
    auth: authFor(ctx, options, settings),
    limits: settings.limits ?? {},
    now: ctx.environment.now,
    ...(settings.clientInfo ? { clientInfo: settings.clientInfo } : {}),
    ...(options.cache && connection
      ? {
          cache: {
            store: options.cache,
            principal: {
              tenantId: connection.tenantId,
              ownerId: connection.ownerId,
              connectionRef: connection.connectionRef,
              generation: ctx.generation,
              profile: settings.profile,
              ...(connection.credentialRef
                ? { credentialRef: connection.credentialRef }
                : {}),
            },
          },
        }
      : {}),
    ...(extra.onElicitation ? { onElicitation: extra.onElicitation } : {}),
  });
  return { client, settings, limits, endpoint };
}

function isoNow(ctx: AdapterCallContext): string {
  return new Date(ctx.environment.now()).toISOString();
}

function effectDigest(input: {
  operationRef: string;
  nativeId: string;
  connectionRef: string;
  generation: number;
  bindingRevision: number;
  request: unknown;
  round: number;
}): string {
  return createHash("sha256")
    .update(canonicalConnectorJson(input))
    .digest("hex");
}

/* ------------------------------------------------------------- invocation */

type TransportTarget =
  | { kind: "mcp-tool"; toolName: string }
  | { kind: "mcp-resource"; uri: string }
  | { kind: "mcp-prompt"; promptName: string };

/**
 * Resolves the operation a caller named into an MCP target. Only the three
 * MCP transports are accepted: an HTTP or broker operation under an MCP
 * binding is a configuration error, not an opportunity to make a request.
 */
function targetFor(operation: BoundOperation, input: unknown): TransportTarget {
  switch (operation.transport.kind) {
    case "mcp-tool":
      return { kind: "mcp-tool", toolName: operation.transport.toolName };
    case "mcp-prompt":
      return { kind: "mcp-prompt", promptName: operation.transport.promptName };
    case "mcp-resource": {
      const template = operation.transport.uriTemplate;
      const variables = template.match(/\{([A-Za-z0-9_]{1,64})\}/g) ?? [];
      let uri = template;
      for (const token of variables) {
        const name = token.slice(1, -1);
        const value = (input as Record<string, unknown> | undefined)?.[name];
        if (
          typeof value !== "string" ||
          value.length === 0 ||
          value.length > 512 ||
          /\p{Cc}/u.test(value)
        )
          throw new ConnectorError("invalid-request", {
            detail: "mcp.resource.variable-invalid",
          });
        uri = uri.replace(token, encodeURIComponent(value));
      }
      if (/\{|\}/.test(uri))
        throw new ConnectorError("invalid-request", {
          detail: "mcp.resource.template-unresolved",
        });
      return { kind: "mcp-resource", uri };
    }
    default:
      throw new ConnectorError("denied", {
        detail: "mcp.operation.transport-not-mcp",
      });
  }
}

function requireOperation(
  ctx: AdapterCallContext,
  operationRef: string,
): BoundOperation {
  const operation = boundOperation(ctx.binding, operationRef);
  // A tool, resource or prompt that is not in the binding is refused here,
  // before anything is sent: being listed by the server is not approval.
  if (!operation)
    throw new ConnectorError("denied", { detail: "mcp.operation.not-bound" });
  return operation;
}

function promptArguments(input: unknown): Record<string, string> | undefined {
  if (input === undefined || input === null) return undefined;
  if (typeof input !== "object" || Array.isArray(input))
    throw new ConnectorError("invalid-request", {
      detail: "mcp.prompt.arguments-invalid",
    });
  const args: Record<string, string> = {};
  for (const [name, value] of Object.entries(
    input as Record<string, unknown>,
  )) {
    if (typeof value === "string") args[name] = value;
    else if (typeof value === "number" || typeof value === "boolean")
      args[name] = String(value);
    else
      throw new ConnectorError("invalid-request", {
        detail: "mcp.prompt.arguments-invalid",
      });
  }
  return args;
}

function toolArguments(input: unknown): Record<string, unknown> {
  if (input === undefined || input === null) return {};
  if (typeof input !== "object" || Array.isArray(input))
    throw new ConnectorError("invalid-request", {
      detail: "mcp.tool.arguments-invalid",
    });
  return input as Record<string, unknown>;
}

type AnyPayload = CallToolPayload | ReadResourcePayload | GetPromptPayload;

async function performCall(
  bundle: ClientBundle,
  target: TransportTarget,
  operation: BoundOperation,
  input: unknown,
  ctx: AdapterCallContext,
  continuation?: {
    inputResponses: Record<string, unknown>;
    requestState?: string;
  },
): Promise<McpOutcome<AnyPayload>> {
  const signal = ctx.signal;
  switch (target.kind) {
    case "mcp-tool": {
      const pinned = bundle.settings.pinnedTools?.[target.toolName];
      return bundle.client.callTool({
        name: target.toolName,
        arguments: toolArguments(input),
        effect: operation.effect,
        signal,
        ...(pinned ? { expectedDigest: pinned } : {}),
        ...(continuation?.inputResponses
          ? { inputResponses: continuation.inputResponses }
          : {}),
        ...(continuation?.requestState !== undefined
          ? { requestState: continuation.requestState }
          : {}),
      });
    }
    case "mcp-resource":
      return bundle.client.readResource({
        uri: target.uri,
        signal,
        ...(continuation?.inputResponses
          ? { inputResponses: continuation.inputResponses }
          : {}),
        ...(continuation?.requestState !== undefined
          ? { requestState: continuation.requestState }
          : {}),
      });
    case "mcp-prompt": {
      const args = promptArguments(input);
      return bundle.client.getPrompt({
        name: target.promptName,
        ...(args ? { arguments: args } : {}),
        signal,
        ...(continuation?.inputResponses
          ? { inputResponses: continuation.inputResponses }
          : {}),
        ...(continuation?.requestState !== undefined
          ? { requestState: continuation.requestState }
          : {}),
      });
    }
  }
}

function suspendedFor(input: {
  ctx: AdapterCallContext;
  settings: McpBindingSettings;
  operation: BoundOperation;
  commandId: string;
  endpoint: URL;
  request: unknown;
  requests: ParsedInputRequest[];
  requestState?: string;
  round: number;
  effectRef?: string;
  legacyDigest?: string;
  mode: SuspendedInput["mode"];
}): SuspendedInput {
  return {
    protocol: "mcp",
    profile: input.settings.profile,
    mode: input.mode,
    operationRef: input.operation.operationRef,
    bindingRevision: input.ctx.binding.revision,
    commandId: input.commandId,
    destination: input.endpoint.href,
    input: canonicalConnectorJson(input.request ?? null),
    inputDigest: inputDigest(input.request ?? null),
    inputRequests: canonicalConnectorJson(
      input.requests.map((request) => ({
        id: request.id,
        kind: request.kind,
        method: request.method,
        ...(request.elicitation ? { elicitation: request.elicitation } : {}),
      })),
    ),
    ...(input.requestState !== undefined
      ? { requestState: input.requestState }
      : {}),
    round: input.round,
    ...(input.effectRef ? { effectRef: input.effectRef } : {}),
    ...(input.legacyDigest ? { elicitationDigest: input.legacyDigest } : {}),
  };
}

function payloadOf(payload: AnyPayload): unknown {
  if ("contents" in payload) return { contents: payload.contents };
  if ("messages" in payload)
    return {
      ...(payload.description !== undefined
        ? { description: payload.description }
        : {}),
      messages: payload.messages,
    };
  return {
    content: payload.content,
    ...(payload.structuredContent !== undefined
      ? { structuredContent: payload.structuredContent }
      : {}),
    isError: payload.isError,
  };
}

async function invokeInternal(
  ctx: AdapterCallContext,
  options: McpRemoteAdapterOptions,
  input: {
    operation: BoundOperation;
    request: unknown;
    commandId: string;
    round: number;
    continuation?: {
      inputResponses: Record<string, unknown>;
      requestState?: string;
    };
    legacyAnswer?: {
      digest: string;
      values: FormValues;
      action: ResumeAction;
      requests: ParsedInputRequest[];
    };
  },
): Promise<InvokeResult> {
  const { operation } = input;
  const target = targetFor(operation, input.request);
  const consequential = operation.effect !== "read";
  const base = {
    outputClassification: operation.outputClassification,
    effect: operation.effect,
  } as const;

  let effectRef: string | undefined;
  if (consequential) {
    const digest = effectDigest({
      operationRef: operation.operationRef,
      nativeId: operation.nativeId,
      connectionRef: ctx.connection?.connectionRef ?? "",
      generation: ctx.generation,
      bindingRevision: ctx.binding.revision,
      request: input.request ?? null,
      round: input.round,
    });
    const begun = await ctx.environment.effects.begin({
      actor: ctx.actor,
      ...(ctx.connection
        ? { connectionRef: ctx.connection.connectionRef }
        : {}),
      bindingRef: ctx.binding.bindingRef,
      operation: operation.operationRef,
      digest,
      commandId: input.commandId,
    });
    effectRef = begun.effectRef;
    const prior = begun.prior;
    if (prior) {
      // The same effect was attempted before. Protocol request ids do not
      // make a business operation idempotent, so a prior attempt whose
      // outcome is unknown is reported, never repeated (AC-MCP-03).
      if (prior.status === "applied")
        return {
          ...base,
          state: "complete",
          code: "already-applied",
          effectRef,
        };
      if (prior.status === "indeterminate" || prior.status === "reconciled")
        return {
          ...base,
          state: "indeterminate",
          code: "reconciliation-required",
          effectRef,
        };
      if (prior.status === "failed")
        return {
          ...base,
          state: "failed",
          code: "previous-attempt-failed",
          effectRef,
        };
    }
  }

  const legacyAnswer = input.legacyAnswer;
  const bundle = clientFor(ctx, options, {
    operation,
    ...(legacyAnswer
      ? {
          onElicitation: async (params) => {
            if (elicitationDigest(params) !== legacyAnswer.digest)
              return { result: { action: "cancel" as const }, deferred: true };
            const responses = buildInputResponses(
              legacyAnswer.requests,
              legacyAnswer.values,
              legacyAnswer.action,
            );
            const answer = responses[legacyAnswer.requests[0]?.id ?? "legacy"];
            return {
              result:
                answer && "action" in answer
                  ? answer
                  : { action: "cancel" as const },
              deferred: false,
            };
          },
        }
      : {}),
  });

  let outcome: McpOutcome<AnyPayload>;
  try {
    outcome = await performCall(
      bundle,
      target,
      operation,
      input.request,
      ctx,
      input.continuation,
    );
  } catch (error) {
    if (effectRef)
      await ctx.environment.effects.complete(effectRef, {
        status: consequential ? "indeterminate" : "not-applied",
        at: ctx.environment.now(),
      });
    throw error;
  }

  const finish = async (
    status: "applied" | "not-applied" | "failed" | "indeterminate",
    result: InvokeResult,
  ): Promise<InvokeResult> => {
    if (effectRef)
      await ctx.environment.effects.complete(effectRef, {
        status,
        ...(result.code ? { code: result.code.slice(0, 120) } : {}),
        at: ctx.environment.now(),
      });
    return effectRef ? { ...result, effectRef } : result;
  };

  switch (outcome.kind) {
    case "complete":
      return finish("applied", {
        ...base,
        state: "complete",
        output: payloadOf(outcome.payload),
      });
    case "authorization-required":
      return finish("not-applied", {
        ...base,
        state: "denied",
        code: "authorization-required",
      });
    case "indeterminate":
      return finish("indeterminate", {
        ...base,
        state: "indeterminate",
        code: sanitize(outcome.code),
      });
    case "failed":
      return outcome.applied === "unknown" && consequential
        ? finish("indeterminate", {
            ...base,
            state: "indeterminate",
            code: sanitize(outcome.code),
          })
        : finish(outcome.applied === "unknown" ? "indeterminate" : "failed", {
            ...base,
            state: "failed",
            code: sanitize(outcome.code),
          });
    case "input-required": {
      if (outcome.requests.some((request) => request.kind === "sampling"))
        return finish("not-applied", {
          ...base,
          state: "denied",
          code: "mcp.sampling.refused",
        });
      if (input.round + 1 >= bundle.limits.maxInputRounds)
        return finish("not-applied", {
          ...base,
          state: "failed",
          code: "mcp.input.too-many-rounds",
        });
      const suspended = suspendedFor({
        ctx,
        settings: bundle.settings,
        operation,
        commandId: input.commandId,
        endpoint: bundle.endpoint,
        request: input.request,
        requests: outcome.requests,
        ...(outcome.requestState !== undefined
          ? { requestState: outcome.requestState }
          : {}),
        round: input.round + 1,
        ...(effectRef ? { effectRef } : {}),
        ...(outcome.legacy
          ? { legacyDigest: outcome.legacy.elicitationDigest }
          : {}),
        mode: outcome.legacy ? "legacy-elicitation" : "input-required",
      });
      const handoff: HandoffProposal = buildInputHandoff(suspended, {
        requests: outcome.requests,
        now: ctx.environment.now(),
        expiresInMs: options.inputHandoffMs ?? 15 * 60_000,
        limits: bundle.limits,
      });
      return finish("not-applied", {
        ...base,
        state: "human-required",
        code: "input-required",
        handoff,
      });
    }
  }
}

/** A failure code that is safe to publish: bounded, lower-case, no upstream text. */
function sanitize(code: string): string {
  const pattern = /^[a-z][a-z0-9]*(?:[.-][a-z0-9]+){0,11}$/;
  const cleaned = code
    .toLowerCase()
    .replace(/[^a-z0-9.-]+/g, "-")
    .replace(/^[^a-z]+/, "")
    .replace(/([.-])[.-]+/g, "$1")
    .replace(/[.-]+$/, "");
  if (pattern.test(cleaned)) return cleaned;
  const candidate = cleaned.split(/[.-]/).filter(Boolean).slice(0, 4).join(".");
  return pattern.test(candidate) ? candidate : "mcp.failed";
}

/* --------------------------------------------------------------- resume */

/**
 * Continues the suspended intent with the values a person supplied. Policy and
 * generation are re-checked first, the handoff is consumed one-use, the values
 * go to the server on the retried request, and they appear in no result.
 */
export async function resumeInput(
  ctx: AdapterCallContext,
  record: HandoffRecord,
  values: FormValues,
  options: McpRemoteAdapterOptions & { action?: ResumeAction } = {},
): Promise<InvokeResult> {
  const suspended = readSuspendedInput(record);
  const settings = settingsOf(ctx.binding);
  const limits = resolveLimits(settings.limits);
  const action: ResumeAction = options.action ?? "accept";
  const operation = boundOperation(ctx.binding, suspended.operationRef);
  const unmet = (code: string): InvokeResult => ({
    state: "denied",
    outputClassification: operation?.outputClassification ?? "secret",
    effect: operation?.effect ?? "unknown",
    code,
  });
  if (!operation) return unmet("mcp.operation.not-bound");
  if (ctx.binding.revision !== suspended.bindingRevision)
    return unmet("mcp.binding.changed");
  if (record.generation !== ctx.generation)
    return unmet("mcp.handoff.stale-generation");
  if (record.state !== "issued" && record.state !== "waiting")
    return unmet("mcp.handoff.not-pending");
  if (record.expiresAt <= ctx.environment.now()) return unmet("expired");
  if (suspended.profile !== settings.profile)
    return unmet("mcp.binding.profile-changed");
  if (suspended.round >= limits.maxInputRounds)
    return unmet("mcp.input.too-many-rounds");
  const endpoint = endpointFor(ctx, operation);
  if (endpoint.href !== suspended.destination)
    return unmet("mcp.binding.destination-changed");

  const request: unknown = JSON.parse(suspended.input);
  if (inputDigest(request) !== suspended.inputDigest)
    return unmet("mcp.input.digest-mismatch");
  const stored = JSON.parse(suspended.inputRequests) as ParsedInputRequest[];
  const requests: ParsedInputRequest[] = Array.isArray(stored) ? stored : [];
  if (requests.some((entry) => entry.kind === "sampling"))
    return unmet("mcp.sampling.refused");

  // One use: consuming the handoff before the call means a replayed
  // continuation cannot reach the server a second time.
  try {
    await ctx.environment.handoffs.complete(
      record.handoffRef,
      ctx.generation,
      "completed",
    );
  } catch {
    return unmet("mcp.handoff.not-pending");
  }

  if (suspended.mode === "legacy-elicitation") {
    if (!suspended.elicitationDigest) return unmet("mcp.handoff.not-pending");
    return invokeInternal(ctx, options, {
      operation,
      request,
      commandId: suspended.commandId,
      round: suspended.round,
      legacyAnswer: {
        digest: suspended.elicitationDigest,
        values,
        action,
        requests,
      },
    });
  }
  const inputResponses = buildInputResponses(requests, values, action);
  return invokeInternal(ctx, options, {
    operation,
    request,
    commandId: suspended.commandId,
    round: suspended.round,
    continuation: {
      inputResponses,
      ...(suspended.requestState !== undefined
        ? { requestState: suspended.requestState }
        : {}),
    },
  });
}

/* -------------------------------------------------------------- adapter */

const DIMENSIONS = [
  "discover",
  "import",
  "configure",
  "authorize",
  "verify",
  "invoke",
  "events",
  "reconnect",
  "disconnect",
  "revoke",
  "export",
  "delegate",
] as const;

export function createMcpRemoteAdapter(
  options: McpRemoteAdapterOptions = {},
): ConnectorAdapter & {
  resumeInput(
    ctx: AdapterCallContext,
    record: HandoffRecord,
    values: FormValues,
    action?: ResumeAction,
  ): Promise<InvokeResult>;
} {
  const adapterVersion = options.adapterVersion ?? MCP_ADAPTER_VERSION;
  const identity = { adapterVersion, runtime: "hosted-server" as const };

  const capabilities = (present: ReadonlySet<string>): CapabilityStatus[] => {
    void present;
    const rows: CapabilityStatus[] = [];
    for (const id of mcpProfileIds) {
      const profile = capabilityProfileLabel(id);
      const era = profileFor(id);
      const supported: Record<
        (typeof DIMENSIONS)[number],
        Partial<CapabilityStatus>
      > = {
        discover: {
          limitations: [
            era.era === "modern"
              ? "Discovery is server/discover; advertised capabilities are the server's claims, not proof."
              : "Discovery is the initialize handshake; advertised capabilities are the server's claims, not proof.",
          ],
        },
        import: {
          implementation: "unsupported",
          limitations: [
            "A live server is not a portable definition; registry import belongs to the registry adapter.",
          ],
        },
        configure: {
          limitations: [
            "Configuration is the binding's pinned profile, endpoint and operations.",
          ],
        },
        authorize: {
          limitations: [
            `Delegated to the host OAuth profile; client registration follows this revision's order: ${era.clientRegistration.join(", ")}.`,
            era.dynamicClientRegistration === "deprecated"
              ? "Dynamic Client Registration is deprecated in this revision and kept only for servers without Client ID Metadata Documents."
              : "Dynamic Client Registration is documented in this revision.",
          ],
        },
        verify: {
          limitations: [
            "Server identity is not attested beyond the TLS origin.",
          ],
        },
        invoke: {
          limitations: [
            "Only tools, resources and prompts named by the binding; the server's own list is not approval.",
            "A dropped response to a consequential call is indeterminate and is never re-sent automatically.",
          ],
        },
        events: {
          limitations: [
            era.era === "modern"
              ? "Change notifications through a bounded subscriptions/listen stream; no webhook or event delivery."
              : "Change notifications through the bounded GET stream where the server offers one; no webhook delivery.",
          ],
        },
        reconnect: {
          limitations: [
            "Reconnect re-runs authorization against the same pinned resource.",
          ],
        },
        disconnect: {
          limitations: [
            "Local only: MCP defines no disconnect or revocation operation.",
          ],
        },
        revoke: {
          implementation: "unsupported",
          limitations: [
            "MCP has no revocation operation; revoking a grant belongs to the authorization server profile.",
          ],
        },
        export: {
          implementation: "unsupported",
          limitations: [
            "Export of a server description belongs to the registry adapter.",
          ],
        },
        delegate: {
          implementation: "unsupported",
          limitations: [
            "No sampling, no roots, no task extension: this client offers a server no host capabilities.",
          ],
        },
      };
      for (const dimension of DIMENSIONS) {
        const row = supported[dimension];
        rows.push(
          capabilityStatus(identity, {
            dimension,
            profile,
            ...(row.implementation
              ? { implementation: row.implementation }
              : {}),
            ...(row.implementation === "unsupported"
              ? {}
              : { evidence: "protocol-fixture" as const }),
            limitations: row.limitations ?? [],
          }),
        );
      }
      rows.push(
        capabilityStatus(identity, {
          dimension: "invoke",
          profile: `${profile}-stdio`,
          implementation: "unsupported",
          limitations: [
            "stdio transports are not supported: a hosted connector does not launch local processes or run packages.",
          ],
        }),
      );
    }
    return rows;
  };

  return {
    id: "mcp-remote",
    ecosystem: "mcp",
    adapterVersion,
    runtime: "hosted-server",
    displayName: options.displayName ?? "MCP server",
    description:
      options.description ??
      "Connect an authenticated remote MCP server and use the tools, resources and prompts a reviewer approved.",
    service: options.service ?? "mcp",
    support: "provider-backed",
    custody: ["host-owned", "no-credential", "external-credential-broker"],
    configuration: [],
    profiles: [
      ...mcpProfileIds.map((id) => capabilityProfileLabel(id)),
      "http-bearer",
      "oauth-authorization-code",
      "none",
    ],
    capabilities,

    async authorize(ctx, intent): Promise<AuthorizationStart> {
      const settings = settingsOf(ctx.binding);
      if (settings.auth === "none") return { kind: "verify" };
      if (settings.auth === "broker")
        return options.broker
          ? { kind: "verify" }
          : { kind: "unsupported", code: "mcp.broker.missing" };
      if (settings.bearerConfiguration) {
        const present = await ctx.environment.configuration.present([
          settings.bearerConfiguration,
        ]);
        return present.has(settings.bearerConfiguration)
          ? { kind: "verify" }
          : {
              kind: "configuration-required",
              missing: [settings.bearerConfiguration],
            };
      }
      if (ctx.connection?.credentialRef && !intent.accountSwitch)
        return { kind: "verify" };
      // No credential yet: ask the server what it wants, then hand the whole
      // challenge to the host's OAuth profile. This adapter never speaks to an
      // authorization server itself.
      const challenge = await probeChallenge(ctx, settings);
      if (!challenge) return { kind: "verify" };
      if (!options.beginOAuth)
        return { kind: "unsupported", code: "mcp.oauth.hook-missing" };
      return options.beginOAuth(ctx, {
        challenge,
        intent,
        resource: challenge.canonicalResource,
        profile: settings.profile,
      });
    },

    async reconnect(ctx, intent): Promise<AuthorizationStart> {
      return this.authorize!(ctx, intent);
    },

    async verify(ctx): Promise<CompletionResult> {
      const bundle = clientFor(ctx, options, {});
      try {
        const discovery = await bundle.client.discover({ signal: ctx.signal });
        const claim: VerificationClaim = {
          kind: "credential-accepted",
          evidenceRef: `mcp-verify:${randomUUID()}`,
          issuer: "provider",
          target: { kind: "mcp-server", id: bundle.endpoint.origin },
          observedAt: isoNow(ctx),
          verifierVersion: adapterVersion,
          bindingRevision: ctx.binding.revision,
          policyRevision: ctx.connection?.policyRevision ?? "unknown",
          limitations: [
            "server identity not attested beyond TLS origin",
            "Advertised capabilities are the server's own claims and are not proof of any tool.",
          ],
        };
        return {
          state: "complete",
          claims: [claim],
          target: { kind: "mcp-server", id: bundle.endpoint.origin },
          adapterState: {
            profile: discovery.usedProfile,
            requestedProfile: discovery.requestedProfile,
            era: discovery.era,
            protocolVersion: discovery.protocolVersion,
            ...(discovery.supportedVersions
              ? { supportedVersions: discovery.supportedVersions }
              : {}),
            capabilities: Object.keys(discovery.capabilities).slice(0, 32),
            unsupportedExtensions: discovery.extensions.unsupported,
            warnings: discovery.warnings.slice(0, 32),
          },
        };
      } catch (error) {
        if (
          error instanceof ConnectorError &&
          error.code === "unauthenticated"
        ) {
          const settings = settingsOf(ctx.binding);
          const challenge = await probeChallenge(ctx, settings);
          return {
            state: "denied",
            claims: [],
            code: "authorization-required",
            ...(challenge
              ? { adapterState: { challenge: summarizeChallenge(challenge) } }
              : {}),
          };
        }
        if (error instanceof ConnectorError && error.code === "cancelled")
          return { state: "indeterminate", claims: [], code: "cancelled" };
        if (error instanceof ConnectorError)
          return {
            state: error.code === "upstream-unavailable" ? "pending" : "denied",
            claims: [],
            code: error.detail ?? error.code,
          };
        throw error;
      }
    },

    async complete(ctx, input: CompletionInput): Promise<CompletionResult> {
      if (input.kind === "poll") return this.verify!(ctx);
      // Input values are continued through resumeInput, which needs the
      // handoff record the command layer holds; they are not accepted here.
      return {
        state: "denied",
        claims: [],
        code: "mcp.completion.unsupported-input",
      };
    },

    async invoke(ctx, request: InvokeRequest): Promise<InvokeResult> {
      const operation = requireOperation(ctx, request.operationRef);
      return invokeInternal(ctx, options, {
        operation,
        request: request.input,
        commandId: request.commandId,
        round: 0,
      });
    },

    async disconnect(ctx, scope: DisconnectScope): Promise<DisconnectResult> {
      if (ctx.connection)
        await ctx.environment.handoffs.cancelAll(
          ctx.connection.connectionRef,
          "disconnect",
        );
      // MCP has no disconnect, delete or revoke operation. Forgetting the
      // connection locally is all that can honestly be claimed; a grant is
      // revoked at the authorization server, which is a different intent.
      return {
        local: "applied",
        broker: scope === "broker" ? "unsupported" : "not-attempted",
        upstream: scope === "upstream" ? "unsupported" : "not-attempted",
      };
    },

    async revoke(): Promise<DisconnectResult> {
      return {
        local: "not-attempted",
        broker: "not-attempted",
        upstream: "unsupported",
      };
    },

    resumeInput(ctx, record, values, action) {
      return resumeInput(ctx, record, values, {
        ...options,
        ...(action ? { action } : {}),
      });
    },
  };
}

/** One unauthenticated probe, purely to read the challenge; nothing is invoked. */
async function probeChallenge(
  ctx: AdapterCallContext,
  settings: McpBindingSettings,
): Promise<AuthorizationChallenge | undefined> {
  const probe = createMcpClient({
    profile: settings.profile,
    compatibility: settings.compatibility,
    endpoint: endpointFor(ctx),
    fetch: ctx.environment.fetch,
    auth: { kind: "none" },
    limits: settings.limits ?? {},
    now: ctx.environment.now,
  });
  return probe.probeAuthorization({ signal: ctx.signal });
}
