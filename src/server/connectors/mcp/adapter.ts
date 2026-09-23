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
import type { ConnectorOAuthOptions } from "../auth/connector-oauth.js";
import {
  completeMcpOAuth,
  createMcpOAuth,
  renewMcpCredential,
  revokeMcpGrant,
} from "./oauth.js";
import { beginAttempt } from "../attempts.js";
import {
  boundOperation,
  destinationFor,
  type BoundOperation,
  type RuntimeBinding,
} from "../binding.js";
import { ConnectorError } from "../errors.js";
import type {
  CredentialMaterial,
  CredentialScope,
  HandoffRecord,
} from "../ports.js";
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
  /**
   * Replaces the default OAuth profile (`createMcpOAuth`, over the grants in
   * `connectors/auth` and the issuer policy pinned in the binding). A custom
   * hook owns its own completion; the default one's redirect is completed here.
   */
  beginOAuth?: BeginMcpOAuth;
  /** Host seams for the default OAuth profile: registrations store, metadata cache, CIMD publisher. */
  oauth?: ConnectorOAuthOptions;
  broker?: McpBrokerPort;
  /** Shared, principal-keyed cache; one per deployment is expected. */
  cache?: McpResultCache;
  /** Longest a suspended input handoff stays open. */
  inputHandoffMs?: number;
};

const BEARER_FIELDS = ["bearer", "access_token", "token", "apiKey"] as const;

/** The bearer a credential presents, by the same field order `authFor` uses. */
function bearerOf(material: Readonly<CredentialMaterial>): string | undefined {
  return BEARER_FIELDS.map((field) => material[field]).find(
    (value) => typeof value === "string" && value.length > 0,
  );
}

function tokenDigest(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

/** A custody refusal because the stored credential is past, or at, its expiry: nothing was sent. */
function credentialExpired(error: unknown): boolean {
  return (
    error instanceof ConnectorError &&
    error.code === "expired" &&
    (error.detail === "credential.expired" ||
      error.detail === "credential.expiring")
  );
}

/** Refresh margin matching the custody port's default: a token this close to expiry is stale. */
const EXPIRY_MARGIN_MS = 30_000;

/** Where the digest of the bearer last presented is kept for one invocation; never the bearer. */
type Presented = { digest?: string };

/**
 * Only the default OAuth profile's own tokens are renewed here: a custom hook
 * or a broker owns the tokens it hands out, and a configured bearer has no
 * refresh token to spend.
 */
function renewable(
  ctx: AdapterCallContext,
  options: McpRemoteAdapterOptions,
): boolean {
  return !options.beginOAuth && settingsOf(ctx.binding).auth === "bearer";
}

/** The held token is stale when it is expired or inside the refresh margin. */
function heldTokenStale(ctx: AdapterCallContext) {
  return (current: Readonly<CredentialMaterial>) => {
    const held = Number(current["expires_at"]);
    return !(
      Number.isFinite(held) && held > ctx.environment.now() + EXPIRY_MARGIN_MS
    );
  };
}

/** The held token is stale when it is still the one the server refused. */
function heldTokenRefused(digest: string) {
  return (current: Readonly<CredentialMaterial>) => {
    const bearer = bearerOf(current);
    return bearer !== undefined && tokenDigest(bearer) === digest;
  };
}

function renew(
  ctx: AdapterCallContext,
  options: McpRemoteAdapterOptions,
  endpoint: URL,
  stillStale: (current: Readonly<CredentialMaterial>) => boolean,
): Promise<boolean> {
  return renewMcpCredential(ctx, {
    endpoint,
    options: options.oauth ?? {},
    stillStale,
  });
}

/**
 * One renewal, then one retry, around a tool call; used by `invoke` and by
 * the continuation of a suspended input request, which can outlive the token
 * it was started with. Custody refusing an expired token sends nothing; a 401
 * to a presented token is recorded as not applied. The renewal is
 * single-flight in custody and presents nothing upstream when the held token
 * is no longer the one that failed, so calls failing together make one
 * refresh.
 *
 * A renewal that does not succeed is classified as verification's is: only a
 * refusal reads as the connection needing a person. Either way the refused
 * attempt was already journaled not applied by `invokeInternal`, and stays
 * so: the operation never ran, whatever became of the refresh.
 */
async function callRenewing(
  ctx: AdapterCallContext,
  options: McpRemoteAdapterOptions,
  operation: BoundOperation,
  call: (presented: Presented) => Promise<InvokeResult>,
): Promise<InvokeResult> {
  const presented: Presented = {};
  const endpoint = () => endpointFor(ctx, operation);
  const unrenewed = (
    failure: unknown,
    base: Pick<InvokeResult, "outputClassification" | "effect" | "effectRef">,
  ): InvokeResult => ({
    ...base,
    ...renewalInvokeOutcome[renewalFailure(failure)],
  });
  let result: InvokeResult;
  try {
    result = await call(presented);
  } catch (error) {
    if (!renewable(ctx, options) || !credentialExpired(error)) throw error;
    let renewed: boolean;
    try {
      renewed = await renew(ctx, options, endpoint(), heldTokenStale(ctx));
    } catch (failure) {
      return unrenewed(failure, {
        outputClassification: operation.outputClassification,
        effect: operation.effect,
      });
    }
    if (!renewed) throw error;
    return call(presented);
  }
  const refused = presented.digest;
  if (
    !renewable(ctx, options) ||
    result.code !== "authorization-required" ||
    refused === undefined
  )
    return result;
  let renewed: boolean;
  try {
    renewed = await renew(ctx, options, endpoint(), heldTokenRefused(refused));
  } catch (failure) {
    // The refresh's own code stays in the journal it wrote; the caller
    // learns only which kind of failure it was.
    const { output: _none, handoff: _noHandoff, ...base } = result;
    void _none;
    void _noHandoff;
    return unrenewed(failure, base);
  }
  return renewed ? call(presented) : result;
}

/**
 * An invocation's answer when its renewal did not succeed. The operation did
 * not run in any case; the state says what the caller should do next.
 */
const renewalInvokeOutcome: Record<
  "refused" | "unavailable" | "unknown",
  Pick<InvokeResult, "state" | "code">
> = {
  // Needs a person: the grant was refused.
  refused: { state: "denied", code: "mcp.credential-renewal-failed" },
  // Retry later: the issuer could not be reached and nothing was spent.
  unavailable: { state: "failed", code: "mcp.credential-renewal-unavailable" },
  // The refresh token may have been spent; nobody can say, so it is not
  // presented again and the caller is told the connection's state is unknown.
  unknown: {
    state: "indeterminate",
    code: "mcp.credential-renewal-indeterminate",
  },
};

/**
 * Renews the default profile's token after a verification attempt the token
 * caused to fail: custody found it expired, or the server answered 401 to it.
 * A renewal that did not succeed is classified, because only one kind means a
 * person must reconnect: `refused` (the issuer rejected the grant, or it is
 * not ours to use). `unavailable` (the issuer could not be reached, nothing
 * was spent) is worth retrying later, and `unknown` (cancelled, raced, or a
 * request whose outcome was lost, so the refresh token may be spent) is
 * reported as such rather than guessed at. The refresh's own code stays in
 * the journal it wrote; nothing about it reaches the caller.
 */
async function renewAfterVerifyFailure(
  ctx: AdapterCallContext,
  options: McpRemoteAdapterOptions,
  error: unknown,
  presented: Presented,
): Promise<"renewed" | "not-renewed" | RenewalFailure> {
  if (!renewable(ctx, options)) return "not-renewed";
  const stillStale = credentialExpired(error)
    ? heldTokenStale(ctx)
    : error instanceof ConnectorError &&
        error.code === "unauthenticated" &&
        presented.digest !== undefined
      ? heldTokenRefused(presented.digest)
      : undefined;
  if (!stillStale) return "not-renewed";
  try {
    return (await renew(ctx, options, endpointFor(ctx), stillStale))
      ? "renewed"
      : "not-renewed";
  } catch (failure) {
    return renewalFailure(failure);
  }
}

type RenewalFailure = "refused" | "unavailable" | "unknown";

function renewalFailure(failure: unknown): RenewalFailure {
  if (!(failure instanceof ConnectorError)) return "unknown";
  if (failure.code === "upstream-unavailable") return "unavailable";
  if (
    failure.code === "cancelled" ||
    failure.code === "indeterminate" ||
    failure.code === "conflict"
  )
    return "unknown";
  return "refused";
}

/** The verification answer for a renewal that did not succeed. */
const renewalOutcome: Record<RenewalFailure, CompletionResult> = {
  // The command layer makes a denied verification reconnect-required.
  refused: {
    state: "denied",
    claims: [],
    code: "mcp.credential-renewal-failed",
  },
  // Pending leaves the connection as it was, to be verified again later.
  unavailable: {
    state: "pending",
    claims: [],
    code: "mcp.credential-renewal-unavailable",
  },
  unknown: {
    state: "indeterminate",
    claims: [],
    code: "mcp.credential-renewal-indeterminate",
  },
};

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
  presented?: Presented,
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
        const token = bearerOf(material);
        if (!token)
          throw new ConnectorError("unauthenticated", {
            detail: "mcp.credential.not-a-bearer",
          });
        if (presented) presented.digest = tokenDigest(token);
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
    presented?: Presented;
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
    auth: authFor(ctx, options, settings, extra.presented),
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
    presented?: Presented;
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
    // An attempt refused before it ran (a 401 a token renewal then cures, a
    // credential custody found expired) leaves the next attempt its own
    // journal entry; see `../attempts.ts`.
    const begun = await beginAttempt(
      ctx.environment.effects,
      {
        actor: ctx.actor,
        ...(ctx.connection
          ? { connectionRef: ctx.connection.connectionRef }
          : {}),
        bindingRef: ctx.binding.bindingRef,
        operation: operation.operationRef,
        digest,
        commandId: input.commandId,
      },
      { mode: "until-applied", random: ctx.environment.random },
    );
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
    ...(input.presented ? { presented: input.presented } : {}),
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
    // Custody refusing an expired credential happens before any byte is
    // sent, so even a consequential call is known not to have run.
    if (effectRef)
      await ctx.environment.effects.complete(effectRef, {
        status:
          consequential && !credentialExpired(error)
            ? "indeterminate"
            : "not-applied",
        ...(credentialExpired(error) ? { code: "credential.expired" } : {}),
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
    const digest = suspended.elicitationDigest;
    if (!digest) return unmet("mcp.handoff.not-pending");
    return callRenewing(ctx, options, operation, (presented) =>
      invokeInternal(ctx, options, {
        operation,
        request,
        commandId: suspended.commandId,
        round: suspended.round,
        legacyAnswer: { digest, values, action, requests },
        presented,
      }),
    );
  }
  const inputResponses = buildInputResponses(requests, values, action);
  // A person may answer long after the call was suspended, so the token it
  // was started with can have expired meanwhile. The handoff is already
  // consumed, so the renewal and its one retry happen here, not by resuming
  // again.
  return callRenewing(ctx, options, operation, (presented) =>
    invokeInternal(ctx, options, {
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
      presented,
    }),
  );
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
  const beginOAuth = options.beginOAuth ?? createMcpOAuth(options.oauth);
  /** Upstream revocation of the default profile's grant; a custom hook or broker owns its own. */
  const revokeGrant = async (
    ctx: AdapterCallContext,
  ): Promise<DisconnectResult["upstream"]> => {
    if (options.beginOAuth) return "unsupported";
    const settings = settingsOf(ctx.binding);
    if (settings.auth !== "bearer") return "unsupported";
    return revokeMcpGrant(ctx, {
      endpoint: endpointFor(ctx),
      options: options.oauth ?? {},
    });
  };

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
            "The default profile runs authorization code with PKCE only under an issuer policy pinned in the binding and named by the server's protected-resource metadata.",
            "Its tokens are refreshed once, single-flight, when custody finds them expired or the server answers 401, and only when a refresh token is held; a custom OAuth hook or broker renews its own.",
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
            "MCP defines no disconnect or revocation operation; a local disconnect never contacts the server or its authorization server.",
            "An upstream disconnect revokes the default profile's grant at the authorization server (RFC 7009) only when the reviewed issuer policy sets revocation to on-upstream-disconnect and the issuer advertises a revocation endpoint.",
          ],
        },
        revoke: {
          limitations: [
            "Revocation is the authorization server's (RFC 7009), for the default OAuth profile's grant only, under the reviewed issuer policy; an issuer answers 200 for tokens it no longer knows, so success is its statement.",
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
      return beginOAuth(ctx, {
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
      /*
       * Verification is where an expired access token is usually first
       * noticed: a reconnect or a poll over a stored credential lands here,
       * and so does `connector_verify`. So the default profile's token is
       * renewed once and discovery retried once, as `invoke` does. Only a
       * refresh the issuer refuses is a denial, which the command layer turns
       * into the reconnect state a person resolves; an issuer outage is
       * pending and a lost outcome indeterminate, so neither sends a person
       * to reconnect a grant that may still be good.
       */
      const presented: Presented = {};
      // Built outside the try: a binding with nothing to call is refused as
      // an error, never reported as a verification outcome.
      const first = clientFor(ctx, options, { presented }).client;
      const discover = (
        client = clientFor(ctx, options, { presented }).client,
      ) => client.discover({ signal: ctx.signal });
      let discovery: Awaited<ReturnType<typeof discover>>;
      try {
        discovery = await discover(first);
      } catch (error) {
        const renewal = await renewAfterVerifyFailure(
          ctx,
          options,
          error,
          presented,
        );
        if (renewal === "not-renewed") return verifyFailure(ctx, error);
        if (renewal !== "renewed") return { ...renewalOutcome[renewal] };
        try {
          discovery = await discover();
        } catch (retried) {
          return verifyFailure(ctx, retried);
        }
      }
      const origin = endpointFor(ctx).origin;
      const claim: VerificationClaim = {
        kind: "credential-accepted",
        evidenceRef: `mcp-verify:${randomUUID()}`,
        issuer: "provider",
        target: { kind: "mcp-server", id: origin },
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
        target: { kind: "mcp-server", id: origin },
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
    },

    async complete(ctx, input: CompletionInput): Promise<CompletionResult> {
      // The default OAuth profile's provider redirect. A host that replaced
      // the profile with its own hook completes its own handoffs.
      if (!options.beginOAuth) {
        const completed = await completeMcpOAuth(
          ctx,
          input,
          options.oauth ?? {},
        );
        if (completed) return completed;
      }
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
      return callRenewing(ctx, options, operation, (presented) =>
        invokeInternal(ctx, options, {
          operation,
          request: request.input,
          commandId: request.commandId,
          round: 0,
          presented,
        }),
      );
    },

    async disconnect(ctx, scope: DisconnectScope): Promise<DisconnectResult> {
      if (ctx.connection)
        await ctx.environment.handoffs.cancelAll(
          ctx.connection.connectionRef,
          "disconnect",
        );
      // MCP has no disconnect, delete or revoke operation. The only upstream
      // act is the authorization server's: RFC 7009 revocation of a
      // default-profile grant, when the reviewed issuer policy asks for it.
      return {
        local: "applied",
        broker: scope === "broker" ? "unsupported" : "not-attempted",
        upstream:
          scope === "upstream" ? await revokeGrant(ctx) : "not-attempted",
      };
    },

    async revoke(ctx): Promise<DisconnectResult> {
      return {
        local: "not-attempted",
        broker: "not-attempted",
        upstream: await revokeGrant(ctx),
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

/** How a verification that did not reach the server's evidence is reported. */
async function verifyFailure(
  ctx: AdapterCallContext,
  error: unknown,
): Promise<CompletionResult> {
  if (error instanceof ConnectorError && error.code === "unauthenticated") {
    const challenge = await probeChallenge(ctx, settingsOf(ctx.binding));
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
