import { createHash, randomBytes } from "node:crypto";
import { canonicalConnectorJson } from "../../../core/connectors/index.js";
import { ConnectorError } from "../errors.js";
import {
  resolveAuthorizationChallenge,
  type AuthorizationChallenge,
} from "./authorization.js";
import { McpResultCache, type CachePrincipal } from "./cache.js";
import { BoundsError, TransportError, exchange, type HttpReply } from "./http.js";
import { parseInputRequests, type ParsedInputRequest } from "./input.js";
import {
  CURRENT_PROFILE,
  HEADER_NAMES,
  JSON_RPC_ERROR_CODES,
  META_KEYS,
  MODERN_ERROR_CODES,
  NEWEST_LEGACY_PROFILE,
  isProfileId,
  profileFor,
  resolveLimits,
  type McpCompatibilityMode,
  type McpEra,
  type McpLimits,
  type McpProfileId,
} from "./profiles.js";
import {
  SESSION_ID,
  callToolResultSchema,
  classifyJsonRpc,
  collectHeaderParameters,
  contentBlockSchema,
  discoverResultSchema,
  elicitationParamsSchema,
  encodeMcpHeaderValue,
  getPromptResultSchema,
  initializeResultSchema,
  inputRequiredResultSchema,
  isRecognizedModernError,
  jsonByteLength,
  listPromptsResultSchema,
  listResourceTemplatesResultSchema,
  listResourcesResultSchema,
  listToolsResultSchema,
  parseBoundedJson,
  promptMessageSchema,
  promptSchema,
  readResourceResultSchema,
  resourceContentsSchema,
  resourceSchema,
  resourceTemplateSchema,
  toolSchema,
  unsupportedVersionDataSchema,
  type ContentBlock,
  type ElicitationParams,
  type ElicitationResult,
  type Implementation,
  type InputRequiredResult,
  type JsonRpcError,
  type JsonRpcMessage,
  type PromptDefinition,
  type RequestId,
  type ResourceContents,
  type ResourceDefinition,
  type ResourceTemplateDefinition,
  type ServerCapabilities,
  type SseFrame,
} from "./wire.js";

/*
 * The inbound MCP client. One instance speaks to one server on behalf of one
 * connection, in the profile its binding pinned. It knows two eras and keeps
 * them apart: the modern per-request envelope and the legacy session, each
 * with its own discovery, headers, interaction model and cancellation.
 *
 * Nothing here decides policy. The client bounds and validates what the
 * server sends, tells the caller precisely what happened (complete, more
 * input needed, authorization needed, failed before execution, or outcome
 * unknown) and leaves effect journaling, custody and handoffs to the adapter.
 */

export type McpAuth =
  | { kind: "none" }
  | {
      kind: "bearer";
      /** Runs `work` with the bearer; the token exists only inside the callback. */
      use<T>(work: (token: string) => Promise<T>): Promise<T>;
    };

export type ElicitationDecision = {
  result: ElicitationResult;
  /** True when the answer only defers the question to a later, separate attempt. */
  deferred: boolean;
};

export type McpClientOptions = {
  profile: McpProfileId;
  compatibility?: McpCompatibilityMode;
  /** Exact MCP endpoint: origin and path, no query, fragment or userinfo. */
  endpoint: string | URL;
  fetch: typeof fetch;
  auth: McpAuth;
  limits?: Partial<McpLimits>;
  clientInfo?: Implementation;
  now?: () => number;
  cache?: { store: McpResultCache; principal: CachePrincipal };
  /** Legacy servers ask for input mid-request; the policy answers or defers. */
  onElicitation?: (
    params: ElicitationParams,
    context: { requestId: RequestId; method: string },
  ) => Promise<ElicitationDecision>;
  onWarning?: (code: string) => void;
};

export type McpTool = {
  name: string;
  title?: string;
  description?: string;
  inputSchema: Record<string, unknown>;
  outputSchema?: Record<string, unknown>;
  /** Server-declared hints; never used for policy. */
  annotations?: Record<string, unknown>;
  /** Parameters the server designated for `Mcp-Param-*` mirroring, validated. */
  headerParameters: Array<{ path: string[]; header: string }>;
  /** Canonical digest of the reviewed definition surface, for pinning. */
  definitionDigest: string;
};

export type McpList<T> = {
  items: T[];
  pages: number;
  truncated: boolean;
  ttlMs?: number;
  cacheScope?: "public" | "private";
  fromCache: boolean;
  warnings: string[];
};

export type CallToolPayload = {
  content: ContentBlock[];
  structuredContent?: unknown;
  isError: boolean;
};
export type ReadResourcePayload = { contents: ResourceContents[] };
export type GetPromptPayload = {
  description?: string;
  messages: Array<{ role: string; content: unknown }>;
};

export type McpOutcome<T> =
  | {
      kind: "complete";
      payload: T;
      cache?: { ttlMs?: number; cacheScope?: "public" | "private" };
      warnings: string[];
    }
  | {
      kind: "input-required";
      requests: ParsedInputRequest[];
      unknownRequests: string[];
      requestState?: string;
      /** Present when a legacy server elicited mid-call and the answer was deferred. */
      legacy?: { elicitationDigest: string; finalIsError: boolean };
      warnings: string[];
    }
  | { kind: "authorization-required"; challenge: AuthorizationChallenge; warnings: string[] }
  | {
      kind: "failed";
      code: string;
      /** "no": the server refused before execution or nothing was sent; "unknown": it may have run. */
      applied: "no" | "unknown";
      error?: JsonRpcError;
      warnings: string[];
    }
  | { kind: "indeterminate"; code: string; warnings: string[] };

export type McpDiscovery = {
  requestedProfile: McpProfileId;
  usedProfile: McpProfileId;
  era: McpEra;
  protocolVersion: string;
  supportedVersions?: string[];
  capabilities: ServerCapabilities;
  serverInfo?: Implementation;
  instructions?: string;
  /** Extension identifiers the server advertised; none are negotiated by this client. */
  extensions: { advertised: string[]; supported: string[]; unsupported: string[] };
  warnings: string[];
};

export type ListenFilter = {
  toolsListChanged?: boolean;
  promptsListChanged?: boolean;
  resourcesListChanged?: boolean;
  resourceSubscriptions?: string[];
};
export type ListenResult = {
  supported: boolean;
  acknowledged?: ListenFilter;
  events: Array<{ method: string; params?: Record<string, unknown> }>;
  closedBy: "client" | "server" | "limit" | "unsupported" | "error";
  warnings: string[];
};

type Effect = "read" | "write" | "unknown";

type RpcOptions = {
  effect: Effect;
  signal?: AbortSignal;
  /** Value mirrored into `Mcp-Name` (tools/call, resources/read, prompts/get). */
  name?: string;
  headerParameters?: Record<string, string>;
  warnings: Warnings;
  /** Internal: retries already spent on this logical request. */
  attempt?: number;
  /** Internal: the legacy session was re-established once already. */
  reinitialized?: boolean;
};

type RpcResult =
  | { kind: "result"; result: Record<string, unknown>; deferred: DeferredElicitation[] }
  | { kind: "error"; error: JsonRpcError; status: number }
  | { kind: "authorization-required"; challenge: AuthorizationChallenge }
  | { kind: "failed"; code: string; applied: "no" | "unknown" }
  | { kind: "indeterminate"; code: string };

type DeferredElicitation = { params: ElicitationParams; digest: string };

class Warnings {
  readonly codes: string[] = [];
  constructor(private readonly sink: ((code: string) => void) | undefined) {}
  add(code: string): void {
    const bounded = code.slice(0, 200);
    if (this.codes.length >= 64 || this.codes.includes(bounded)) return;
    this.codes.push(bounded);
    this.sink?.(bounded);
  }
}

const CLIENT_CAPABILITIES = Object.freeze({ elicitation: { form: {}, url: {} } });

export function definitionDigest(tool: {
  name: string;
  description?: string;
  inputSchema: unknown;
  outputSchema?: unknown;
  annotations?: unknown;
}): string {
  return createHash("sha256")
    .update(
      canonicalConnectorJson({
        name: tool.name,
        description: tool.description ?? "",
        inputSchema: tool.inputSchema,
        outputSchema: tool.outputSchema ?? null,
        annotations: tool.annotations ?? null,
      }),
    )
    .digest("hex");
}

function valueAtPath(value: unknown, path: string[]): unknown {
  let current: unknown = value;
  for (const segment of path) {
    if (!current || typeof current !== "object" || Array.isArray(current)) return undefined;
    current = (current as Record<string, unknown>)[segment];
  }
  return current;
}

const HEADER_SUGGESTION = /^(x-mcp-header|headers?|authorization|cookie|set-cookie|bearer|proxy-authorization)$/i;

/** Servers may not steer headers or credentials through `_meta` or annotations; any attempt is flagged. */
function headerSuggestions(value: unknown, depth = 0): boolean {
  if (!value || typeof value !== "object" || depth > 4) return false;
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    if (HEADER_SUGGESTION.test(key)) return true;
    if (headerSuggestions(child, depth + 1)) return true;
  }
  return false;
}

function delay(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(done, ms);
    function done() {
      clearTimeout(timer);
      signal?.removeEventListener("abort", done);
      resolve();
    }
    signal?.addEventListener("abort", done, { once: true });
  });
}

export interface McpClient {
  readonly profile: McpProfileId;
  discover(options?: { signal?: AbortSignal; refresh?: boolean }): Promise<McpDiscovery>;
  listTools(options?: { signal?: AbortSignal; refresh?: boolean }): Promise<McpList<McpTool>>;
  listResources(options?: {
    signal?: AbortSignal;
    refresh?: boolean;
  }): Promise<McpList<ResourceDefinition>>;
  listResourceTemplates(options?: {
    signal?: AbortSignal;
    refresh?: boolean;
  }): Promise<McpList<ResourceTemplateDefinition>>;
  listPrompts(options?: { signal?: AbortSignal; refresh?: boolean }): Promise<McpList<PromptDefinition>>;
  callTool(request: {
    name: string;
    arguments: Record<string, unknown>;
    effect: Effect;
    signal?: AbortSignal;
    inputResponses?: Record<string, unknown>;
    requestState?: string;
    /** Reviewed definition digest; a changed live definition is refused. */
    expectedDigest?: string;
  }): Promise<McpOutcome<CallToolPayload>>;
  readResource(request: {
    uri: string;
    signal?: AbortSignal;
    inputResponses?: Record<string, unknown>;
    requestState?: string;
  }): Promise<McpOutcome<ReadResourcePayload>>;
  getPrompt(request: {
    name: string;
    arguments?: Record<string, string>;
    signal?: AbortSignal;
    inputResponses?: Record<string, unknown>;
    requestState?: string;
  }): Promise<McpOutcome<GetPromptPayload>>;
  listen(options: {
    filter: ListenFilter;
    signal?: AbortSignal;
    maxEvents?: number;
    maxMs?: number;
  }): Promise<ListenResult>;
  state(): { era: McpEra; protocolVersion: string; usedProfile: McpProfileId; session: boolean };
  close(): void;
}

export function createMcpClient(options: McpClientOptions): McpClient {
  const endpoint = new URL(options.endpoint);
  if (endpoint.username || endpoint.password || endpoint.search || endpoint.hash)
    throw new ConnectorError("invalid-request", { detail: "mcp.endpoint.invalid" });
  const limits = resolveLimits(options.limits);
  const now = options.now ?? Date.now;
  const compatibility = options.compatibility ?? "pinned";
  const requestedProfile = options.profile;
  const clientInfo: Implementation = options.clientInfo ?? {
    name: "ceremony-mcp-client",
    version: "1.0.0",
  };
  const idPrefix = randomBytes(6).toString("base64url");
  let counter = 0;
  const nextId = (): string => `${idPrefix}-${++counter}`;

  const state = {
    era: profileFor(requestedProfile).era as McpEra,
    protocolVersion: requestedProfile as string,
    usedProfile: requestedProfile as McpProfileId,
    session: undefined as string | undefined,
    initialized: false,
    initializing: undefined as Promise<void> | undefined,
    capabilities: undefined as ServerCapabilities | undefined,
    serverInfo: undefined as Implementation | undefined,
    instructions: undefined as string | undefined,
    supportedVersions: undefined as string[] | undefined,
    discoveredAt: undefined as number | undefined,
  };

  const cache = options.cache;

  function principal(): CachePrincipal | undefined {
    if (!cache) return undefined;
    return { ...cache.principal, profile: `${cache.principal.profile}:${state.era}:${state.protocolVersion}` };
  }

  async function withAuthorization<T>(
    work: (authorization: string | undefined) => Promise<T>,
  ): Promise<T> {
    if (options.auth.kind === "none") return work(undefined);
    return options.auth.use((token) => work(`Bearer ${token}`));
  }

  /* ----------------------------------------------------------- envelopes */

  function modernParams(params: Record<string, unknown> | undefined): Record<string, unknown> {
    return {
      ...(params ?? {}),
      _meta: {
        ...((params?._meta as Record<string, unknown> | undefined) ?? {}),
        [META_KEYS.protocolVersion]: state.protocolVersion,
        [META_KEYS.clientInfo]: clientInfo,
        [META_KEYS.clientCapabilities]: CLIENT_CAPABILITIES,
      },
    };
  }

  function modernHeaders(method: string, name?: string, headerParameters?: Record<string, string>) {
    const headers: Record<string, string> = {
      [HEADER_NAMES.protocolVersion]: state.protocolVersion,
      [HEADER_NAMES.method]: method,
    };
    if (name !== undefined) headers[HEADER_NAMES.name] = encodeMcpHeaderValue(name);
    for (const [header, value] of Object.entries(headerParameters ?? {}))
      headers[`${HEADER_NAMES.paramPrefix}${header}`.toLowerCase()] = encodeMcpHeaderValue(value);
    return headers;
  }

  function legacyHeaders(afterInitialize: boolean): Record<string, string> {
    const headers: Record<string, string> = {};
    if (afterInitialize) headers[HEADER_NAMES.protocolVersion] = state.protocolVersion;
    if (state.session) headers[HEADER_NAMES.sessionId] = state.session;
    return headers;
  }

  /* --------------------------------------------------------- era changes */

  function switchToLegacy(warnings: Warnings, reason: string): void {
    warnings.add(`mcp.profile.fallback-legacy:${reason}`);
    state.era = "legacy";
    state.protocolVersion = NEWEST_LEGACY_PROFILE;
    state.usedProfile = NEWEST_LEGACY_PROFILE;
    state.initialized = false;
    state.session = undefined;
  }

  function switchToModern(warnings: Warnings, reason: string): void {
    warnings.add(`mcp.profile.fallback-modern:${reason}`);
    state.era = "modern";
    state.protocolVersion = CURRENT_PROFILE;
    state.usedProfile = CURRENT_PROFILE;
    state.initialized = false;
    state.session = undefined;
  }

  /* ------------------------------------------------------- legacy session */

  async function ensureInitialized(warnings: Warnings, signal?: AbortSignal): Promise<RpcResult | undefined> {
    if (state.era !== "legacy" || state.initialized) return undefined;
    if (!state.initializing) {
      state.initializing = (async () => {
        const failure = await initialize(warnings, signal);
        if (failure) throw failure;
      })().finally(() => {
        state.initializing = undefined;
      });
    }
    try {
      await state.initializing;
      return undefined;
    } catch (failure) {
      return failure as RpcResult;
    }
  }

  async function initialize(warnings: Warnings, signal?: AbortSignal): Promise<RpcResult | undefined> {
    const id = nextId();
    const body = {
      jsonrpc: "2.0",
      id,
      method: "initialize",
      params: {
        protocolVersion: state.protocolVersion,
        capabilities: CLIENT_CAPABILITIES,
        clientInfo,
      },
    };
    let reply: HttpReply;
    try {
      reply = await withAuthorization((authorization) =>
        exchange(
          options.fetch,
          {
            url: endpoint,
            method: "POST",
            headers: {},
            body,
            ...(authorization ? { authorization } : {}),
            ...(signal ? { signal } : {}),
            timeoutMs: limits.requestTimeoutMs,
          },
          limits,
        ),
      );
    } catch (error) {
      return transportFailure(error, "read");
    }
    if (reply.status === 401 || reply.status === 403)
      return { kind: "authorization-required", challenge: await challengeFor(reply, signal) };
    const message = await singleMessage(reply, id, warnings, signal, "read");
    if (message.kind !== "result") {
      if (message.kind === "error" && compatibility === "auto-detect" && looksModern(message)) {
        switchToModern(warnings, "initialize-refused");
        return undefined;
      }
      return message;
    }
    const parsed = initializeResultSchema.safeParse(message.result);
    if (!parsed.success) return { kind: "failed", code: "mcp.protocol.initialize-invalid", applied: "no" };
    const negotiated = parsed.data.protocolVersion;
    if (negotiated !== state.protocolVersion) {
      const profile = profileFor(requestedProfile);
      if (compatibility === "pinned" || !profile.negotiableVersions.includes(negotiated))
        return { kind: "failed", code: "mcp.protocol.version-mismatch", applied: "no" };
      warnings.add(`mcp.protocol.negotiated:${negotiated}`);
      state.protocolVersion = negotiated;
      if (isProfileId(negotiated)) state.usedProfile = negotiated;
    }
    const session = reply.headers.get(HEADER_NAMES.sessionId);
    if (session !== null) {
      if (!SESSION_ID.test(session))
        return { kind: "failed", code: "mcp.session.invalid-id", applied: "no" };
      state.session = session;
    }
    state.capabilities = parsed.data.capabilities;
    state.serverInfo = parsed.data.serverInfo;
    state.instructions = parsed.data.instructions;
    state.discoveredAt = now();
    state.initialized = true;
    // The initialized notification completes the handshake; 202 is the
    // documented acknowledgement, other 2xx are tolerated from older servers.
    try {
      const ack = await withAuthorization((authorization) =>
        exchange(
          options.fetch,
          {
            url: endpoint,
            method: "POST",
            headers: legacyHeaders(true),
            body: { jsonrpc: "2.0", method: "notifications/initialized" },
            ...(authorization ? { authorization } : {}),
            ...(signal ? { signal } : {}),
            timeoutMs: limits.requestTimeoutMs,
          },
          limits,
        ),
      );
      if (ack.status >= 300) warnings.add(`mcp.protocol.initialized-status:${ack.status}`);
    } catch {
      warnings.add("mcp.protocol.initialized-undelivered");
    }
    return undefined;
  }

  function looksModern(message: { kind: "error"; error: JsonRpcError; status: number }): boolean {
    if (message.error.code === MODERN_ERROR_CODES.unsupportedProtocolVersion) return true;
    if (message.error.code === JSON_RPC_ERROR_CODES.methodNotFound && message.status === 404) return true;
    const data = unsupportedVersionDataSchema.safeParse(message.error.data);
    return Boolean(data.success && data.data.supported?.includes(CURRENT_PROFILE));
  }

  /* ------------------------------------------------------------ transport */

  function transportFailure(error: unknown, effect: Effect): RpcResult {
    if (error instanceof BoundsError)
      return effect === "read"
        ? { kind: "failed", code: `mcp.bounds.${error.code}`, applied: "unknown" }
        : { kind: "indeterminate", code: `mcp.bounds.${error.code}` };
    if (error instanceof TransportError) {
      if (error.phase === "undelivered")
        return { kind: "failed", code: "mcp.transport.undelivered", applied: "no" };
      const code =
        error.phase === "aborted"
          ? "mcp.cancelled"
          : error.phase === "timeout"
            ? "mcp.transport.timeout"
            : "mcp.transport.dropped";
      return effect === "read"
        ? { kind: "failed", code, applied: "unknown" }
        : { kind: "indeterminate", code };
    }
    if (error instanceof ConnectorError) throw error;
    return effect === "read"
      ? { kind: "failed", code: "mcp.transport.error", applied: "unknown" }
      : { kind: "indeterminate", code: "mcp.transport.error" };
  }

  async function challengeFor(reply: HttpReply, signal?: AbortSignal): Promise<AuthorizationChallenge> {
    const profile = profileFor(state.usedProfile);
    return resolveAuthorizationChallenge({
      response: { status: reply.status, headers: reply.headers },
      endpoint,
      canonicalResource: canonicalResource(),
      clientRegistration: profile.clientRegistration,
      fetch: options.fetch,
      limits,
      ...(signal ? { signal } : {}),
    });
  }

  function canonicalResource(): string {
    const path = endpoint.pathname.endsWith("/") ? endpoint.pathname.slice(0, -1) : endpoint.pathname;
    return `${endpoint.origin}${path}`;
  }

  /** Posts a JSON-RPC response or notification (legacy only); the server answers 202. */
  async function postLegacyMessage(message: Record<string, unknown>, warnings: Warnings, signal?: AbortSignal): Promise<void> {
    try {
      const reply = await withAuthorization((authorization) =>
        exchange(
          options.fetch,
          {
            url: endpoint,
            method: "POST",
            headers: legacyHeaders(true),
            body: message,
            ...(authorization ? { authorization } : {}),
            ...(signal ? { signal } : {}),
            timeoutMs: limits.requestTimeoutMs,
          },
          limits,
        ),
      );
      if (reply.status >= 300) warnings.add(`mcp.protocol.response-status:${reply.status}`);
    } catch {
      warnings.add("mcp.protocol.response-undelivered");
    }
  }

  /** Answers a server request found on a legacy stream; modern streams never carry them. */
  async function answerServerRequest(
    request: { id: RequestId; method: string; params: Record<string, unknown> | undefined },
    warnings: Warnings,
    deferred: DeferredElicitation[],
    signal?: AbortSignal,
  ): Promise<void> {
    const respond = (payload: { result: unknown } | { error: JsonRpcError }) =>
      postLegacyMessage({ jsonrpc: "2.0", id: request.id, ...payload }, warnings, signal);
    switch (request.method) {
      case "ping":
        return respond({ result: {} });
      case "roots/list":
        warnings.add("mcp.roots.answered-empty");
        return respond({ result: { roots: [] } });
      case "sampling/createMessage":
        warnings.add("mcp.sampling.refused");
        return respond({
          error: { code: JSON_RPC_ERROR_CODES.methodNotFound, message: "Sampling is not offered by this client" },
        });
      case "elicitation/create": {
        const params = elicitationParamsSchema.safeParse(request.params ?? {});
        if (!params.success)
          return respond({ error: { code: JSON_RPC_ERROR_CODES.invalidParams, message: "Invalid elicitation" } });
        const digest = createHash("sha256")
          .update(
            canonicalConnectorJson({
              mode: params.data.mode ?? "form",
              message: params.data.message,
              requestedSchema: params.data.requestedSchema ?? null,
              url: params.data.url ?? null,
            }),
          )
          .digest("hex");
        let decision: ElicitationDecision;
        try {
          decision = options.onElicitation
            ? await options.onElicitation(params.data, { requestId: request.id, method: request.method })
            : { result: { action: "cancel" }, deferred: true };
        } catch {
          decision = { result: { action: "cancel" }, deferred: true };
        }
        if (decision.deferred) deferred.push({ params: params.data, digest });
        return respond({ result: decision.result });
      }
      default:
        warnings.add(`mcp.extension.unsupported-request:${request.method.replace(/[^a-z0-9/_.-]/gi, "").slice(0, 60)}`);
        return respond({
          error: { code: JSON_RPC_ERROR_CODES.methodNotFound, message: "Method not supported by this client" },
        });
    }
  }

  function handleNotification(method: string): void {
    if (method === "notifications/tools/list_changed") invalidate("tools/list");
    else if (method === "notifications/prompts/list_changed") invalidate("prompts/list");
    else if (method === "notifications/resources/list_changed") {
      invalidate("resources/list");
      invalidate("resources/templates/list");
    }
  }

  function invalidate(method?: string): void {
    const who = principal();
    if (who) cache?.store.invalidate(who, method);
  }

  /**
   * Reads the reply to one request: a JSON object, or an SSE stream that may
   * carry notifications and (legacy only) server requests before the
   * response. A stream that ends without the response is a dropped response.
   */
  async function singleMessage(
    reply: HttpReply,
    id: string,
    warnings: Warnings,
    signal: AbortSignal | undefined,
    effect: Effect,
  ): Promise<RpcResult> {
    const deferred: DeferredElicitation[] = [];
    const interpret = (message: JsonRpcMessage): RpcResult | undefined => {
      if (message.kind === "result" && String(message.id) === id)
        return { kind: "result", result: message.result, deferred };
      if (message.kind === "error" && (message.id === null || String(message.id) === id))
        return { kind: "error", error: message.error, status: reply.status };
      return undefined;
    };
    if (reply.kind === "json") {
      const message = classifyJsonRpc(reply.body);
      const outcome = interpret(message);
      if (outcome) return outcome;
      if (reply.status >= 400)
        return { kind: "failed", code: `mcp.http.${reply.status}`, applied: reply.status >= 500 ? "unknown" : "no" };
      return { kind: "failed", code: "mcp.protocol.unexpected-message", applied: "unknown" };
    }
    if (reply.kind === "stream") {
      if (reply.status >= 400)
        return { kind: "failed", code: `mcp.http.${reply.status}`, applied: reply.status >= 500 ? "unknown" : "no" };
      try {
        for await (const frame of reply.frames()) {
          let value: unknown;
          try {
            value = parseBoundedJson(frame.data, { maxDepth: limits.maxJsonDepth });
          } catch {
            warnings.add("mcp.protocol.frame-invalid");
            continue;
          }
          const message = classifyJsonRpc(value);
          const outcome = interpret(message);
          if (outcome) return outcome;
          if (message.kind === "notification") handleNotification(message.method);
          else if (message.kind === "request") {
            if (state.era === "legacy") await answerServerRequest(message, warnings, deferred, signal);
            else warnings.add("mcp.protocol.server-request-refused");
          } else if (message.kind === "invalid") warnings.add("mcp.protocol.frame-invalid");
        }
      } catch (error) {
        return transportFailure(error, effect);
      }
      return effect === "read"
        ? { kind: "failed", code: "mcp.transport.dropped", applied: "unknown" }
        : { kind: "indeterminate", code: "mcp.transport.dropped" };
    }
    if (reply.kind === "empty") {
      if (reply.status >= 400)
        return { kind: "failed", code: `mcp.http.${reply.status}`, applied: reply.status >= 500 ? "unknown" : "no" };
      // 202 to a request is a protocol violation: the request was accepted but no answer will come.
      return effect === "read"
        ? { kind: "failed", code: "mcp.protocol.no-response", applied: "unknown" }
        : { kind: "indeterminate", code: "mcp.protocol.no-response" };
    }
    return {
      kind: "failed",
      code: reply.status >= 400 ? `mcp.http.${reply.status}` : "mcp.transport.unexpected-content-type",
      applied: reply.status >= 500 || reply.status < 400 ? "unknown" : "no",
    };
  }

  /* ------------------------------------------------------------------ rpc */

  async function rpc(method: string, params: Record<string, unknown> | undefined, rpcOptions: RpcOptions): Promise<RpcResult> {
    const attempt = rpcOptions.attempt ?? 0;
    const retry = async (reason: string): Promise<RpcResult> => {
      rpcOptions.warnings.add(`mcp.retry:${reason}`);
      await delay(Math.min(250 * (attempt + 1), 1000), rpcOptions.signal);
      return rpc(method, params, { ...rpcOptions, attempt: attempt + 1 });
    };
    const mayRetry = (budget: number) => attempt < budget && !rpcOptions.signal?.aborted;

    if (state.era === "legacy") {
      const failure = await ensureInitialized(rpcOptions.warnings, rpcOptions.signal);
      if (failure) return failure;
      if (state.era !== "legacy") return rpc(method, params, rpcOptions);
    }
    const id = nextId();
    const modern = state.era === "modern";
    const body = {
      jsonrpc: "2.0",
      id,
      method,
      ...(modern ? { params: modernParams(params) } : params ? { params } : {}),
    };
    let reply: HttpReply;
    try {
      reply = await withAuthorization((authorization) =>
        exchange(
          options.fetch,
          {
            url: endpoint,
            method: "POST",
            headers: modern
              ? modernHeaders(method, rpcOptions.name, rpcOptions.headerParameters)
              : legacyHeaders(true),
            body,
            ...(authorization ? { authorization } : {}),
            ...(rpcOptions.signal ? { signal: rpcOptions.signal } : {}),
            timeoutMs: limits.requestTimeoutMs,
          },
          limits,
        ),
      );
    } catch (error) {
      const failure = transportFailure(error, rpcOptions.effect);
      if (failure.kind === "failed" && failure.code === "mcp.transport.undelivered" && mayRetry(rpcOptions.effect === "read" ? limits.readRetries : 1))
        return retry("undelivered");
      if (failure.kind === "failed" && rpcOptions.effect === "read" && failure.applied === "unknown" && failure.code !== "mcp.cancelled" && mayRetry(limits.readRetries))
        return retry(failure.code.replace(/^mcp\./, ""));
      if (failure.kind === "indeterminate" && failure.code === "mcp.cancelled" && !modern)
        await postLegacyMessage(
          { jsonrpc: "2.0", method: "notifications/cancelled", params: { requestId: id, reason: "cancelled" } },
          rpcOptions.warnings,
        );
      return failure;
    }

    if (reply.status === 401 || reply.status === 403)
      return { kind: "authorization-required", challenge: await challengeFor(reply, rpcOptions.signal) };

    // Legacy: a 404 for a session the server no longer knows means "start a
    // new session"; the request was not processed. Reads are reissued once.
    if (!modern && reply.status === 404 && state.session && !rpcOptions.reinitialized) {
      state.initialized = false;
      state.session = undefined;
      invalidate();
      if (rpcOptions.effect !== "read")
        return { kind: "failed", code: "mcp.session.expired", applied: "no" };
      rpcOptions.warnings.add("mcp.session.reinitialized");
      return rpc(method, params, { ...rpcOptions, reinitialized: true });
    }

    if (reply.status === 429 || (reply.status >= 500 && reply.status <= 599)) {
      if (rpcOptions.effect === "read" && mayRetry(limits.readRetries)) return retry(`http-${reply.status}`);
      if (reply.status === 429) return { kind: "failed", code: "mcp.http.429", applied: "no" };
      return rpcOptions.effect === "read"
        ? { kind: "failed", code: `mcp.http.${reply.status}`, applied: "unknown" }
        : { kind: "indeterminate", code: `mcp.http.${reply.status}` };
    }

    const message = await singleMessage(reply, id, rpcOptions.warnings, rpcOptions.signal, rpcOptions.effect);

    if (message.kind === "error") {
      if (modern) {
        if (!isRecognizedModernError(message.error) && reply.status >= 400 && reply.status < 500) {
          // Not a modern error body on a 4xx: the documented sign of a legacy server.
          if (compatibility === "auto-detect" && !rpcOptions.reinitialized) {
            switchToLegacy(rpcOptions.warnings, `http-${reply.status}`);
            return rpc(method, params, { ...rpcOptions, reinitialized: true });
          }
          return { kind: "failed", code: "mcp.profile.legacy-server", applied: "no" };
        }
        if (message.error.code === MODERN_ERROR_CODES.unsupportedProtocolVersion) {
          const data = unsupportedVersionDataSchema.safeParse(message.error.data);
          const supported = data.success ? (data.data.supported ?? []) : [];
          const mutual = profileFor(requestedProfile).negotiableVersions.find((v) => supported.includes(v));
          if (compatibility !== "pinned" && mutual && mutual !== state.protocolVersion && !rpcOptions.reinitialized) {
            rpcOptions.warnings.add(`mcp.protocol.negotiated:${mutual}`);
            state.protocolVersion = mutual;
            return rpc(method, params, { ...rpcOptions, reinitialized: true });
          }
          if (compatibility === "auto-detect" && !mutual && supported.some((v) => v < CURRENT_PROFILE) && !rpcOptions.reinitialized) {
            switchToLegacy(rpcOptions.warnings, "unsupported-version");
            return rpc(method, params, { ...rpcOptions, reinitialized: true });
          }
          return { kind: "failed", code: "mcp.protocol.version-unsupported", applied: "no" };
        }
        if (message.error.code === MODERN_ERROR_CODES.headerMismatch && method === "tools/call" && rpcOptions.effect === "read" && !rpcOptions.reinitialized) {
          // The tool's header annotations may have changed: refresh the list once and retry.
          invalidate("tools/list");
          rpcOptions.warnings.add("mcp.header-mismatch.refreshed");
          const refreshed = await listTools({ ...(rpcOptions.signal ? { signal: rpcOptions.signal } : {}), refresh: true });
          const tool = refreshed.items.find((item) => item.name === params?.name);
          const headerParameters = tool ? mirroredHeaders(tool, (params?.arguments as Record<string, unknown> | undefined) ?? {}) : {};
          return rpc(method, params, { ...rpcOptions, headerParameters, reinitialized: true });
        }
      } else if (compatibility === "auto-detect" && looksModern(message) && !rpcOptions.reinitialized) {
        switchToModern(rpcOptions.warnings, "modern-error");
        return rpc(method, params, { ...rpcOptions, reinitialized: true });
      }
      return message;
    }

    if (message.kind === "failed" && message.code === "mcp.transport.dropped" && rpcOptions.effect === "read" && mayRetry(limits.readRetries))
      return retry("dropped-response");
    if (message.kind === "failed" && modern && reply.status >= 400 && reply.status < 500 && !message.code.startsWith("mcp.protocol")) {
      // A 4xx without any JSON-RPC body is likewise not a modern server.
      if (compatibility === "auto-detect" && !rpcOptions.reinitialized && reply.status !== 404) {
        switchToLegacy(rpcOptions.warnings, `http-${reply.status}`);
        return rpc(method, params, { ...rpcOptions, reinitialized: true });
      }
      return { kind: "failed", code: "mcp.profile.legacy-server", applied: "no" };
    }
    return message;
  }

  /* ------------------------------------------------------------- results */

  type Interpreted<T> =
    | { kind: "complete"; value: T; ttlMs?: number; cacheScope?: "public" | "private" }
    | { kind: "input-required"; result: InputRequiredResult }
    | { kind: "failed"; code: string };

  /** Applies result discrimination: absent `resultType` is complete, unknown is invalid. */
  function interpretResult<T>(
    result: Record<string, unknown>,
    parse: (value: Record<string, unknown>) => T | undefined,
    warnings: Warnings,
    allowInputRequired: boolean,
  ): Interpreted<T> {
    const resultType = result.resultType;
    if (resultType === undefined) {
      if (state.era === "modern") warnings.add("mcp.result.result-type-missing");
    } else if (resultType === "input_required") {
      if (!allowInputRequired || state.era !== "modern")
        return { kind: "failed", code: "mcp.result.unexpected-input-required" };
      const parsed = inputRequiredResultSchema.safeParse(result);
      if (!parsed.success) return { kind: "failed", code: "mcp.result.input-required-invalid" };
      if (parsed.data.inputRequests === undefined && parsed.data.requestState === undefined)
        return { kind: "failed", code: "mcp.result.input-required-invalid" };
      return { kind: "input-required", result: parsed.data };
    } else if (resultType !== "complete") return { kind: "failed", code: "mcp.result.unknown-type" };
    const value = parse(result);
    if (value === undefined) return { kind: "failed", code: "mcp.result.invalid" };
    const ttl = typeof result.ttlMs === "number" && Number.isFinite(result.ttlMs) ? result.ttlMs : undefined;
    const scope = result.cacheScope === "public" || result.cacheScope === "private" ? result.cacheScope : undefined;
    return {
      kind: "complete",
      value,
      ...(ttl !== undefined ? { ttlMs: ttl } : {}),
      ...(scope !== undefined ? { cacheScope: scope } : {}),
    };
  }

  function boundText(text: string, warnings: Warnings, code: string): string {
    if (Buffer.byteLength(text, "utf8") <= limits.maxTextBytes) return text;
    warnings.add(code);
    return Buffer.from(text, "utf8").subarray(0, limits.maxTextBytes).toString("utf8");
  }

  function boundBlocks(blocks: unknown[], warnings: Warnings): ContentBlock[] {
    const out: ContentBlock[] = [];
    for (const raw of blocks) {
      if (out.length >= limits.maxContentBlocks) {
        warnings.add("mcp.output.blocks-truncated");
        break;
      }
      const parsed = contentBlockSchema.safeParse(raw);
      if (!parsed.success) {
        warnings.add("mcp.output.block-invalid");
        continue;
      }
      const { _meta, ...block } = parsed.data;
      void _meta;
      if (block.text !== undefined) block.text = boundText(block.text, warnings, "mcp.output.text-truncated");
      if (block.data !== undefined && Buffer.byteLength(block.data, "utf8") > limits.maxStructuredBytes) {
        warnings.add("mcp.output.binary-dropped");
        delete block.data;
      }
      if (block.resource && jsonByteLength(block.resource) > limits.maxStructuredBytes) {
        warnings.add("mcp.output.resource-dropped");
        delete block.resource;
      }
      out.push(block);
    }
    return out;
  }

  function outcomeFromRpc<T>(
    message: RpcResult,
    warnings: Warnings,
    parse: (value: Record<string, unknown>) => T | undefined,
    allowInputRequired: boolean,
  ): McpOutcome<T> {
    switch (message.kind) {
      case "authorization-required":
        return { kind: "authorization-required", challenge: message.challenge, warnings: warnings.codes };
      case "failed":
        return { kind: "failed", code: message.code, applied: message.applied, warnings: warnings.codes };
      case "indeterminate":
        return { kind: "indeterminate", code: message.code, warnings: warnings.codes };
      case "error":
        return {
          kind: "failed",
          code: errorCode(message.error),
          applied: appliedAfterError(message.error),
          error: { code: message.error.code, message: message.error.message.slice(0, 500) },
          warnings: warnings.codes,
        };
      case "result": {
        const interpreted = interpretResult(message.result, parse, warnings, allowInputRequired);
        if (interpreted.kind === "failed")
          return { kind: "failed", code: interpreted.code, applied: "unknown", warnings: warnings.codes };
        if (interpreted.kind === "input-required") {
          const { requests, unknown } = parseInputRequests(interpreted.result);
          for (const id of unknown) warnings.add(`mcp.input.unknown-request:${id.slice(0, 40)}`);
          return {
            kind: "input-required",
            requests,
            unknownRequests: unknown,
            ...(interpreted.result.requestState !== undefined ? { requestState: interpreted.result.requestState } : {}),
            warnings: warnings.codes,
          };
        }
        if (message.deferred.length) {
          const first = message.deferred[0]!;
          const finalIsError = Boolean((message.result as { isError?: unknown }).isError);
          return {
            kind: "input-required",
            requests: [
              {
                id: "legacy",
                kind: (first.params.mode ?? "form") === "url" ? "elicitation-url" : "elicitation-form",
                method: "elicitation/create",
                elicitation: first.params,
              },
            ],
            unknownRequests: [],
            legacy: { elicitationDigest: first.digest, finalIsError },
            warnings: warnings.codes,
          };
        }
        return {
          kind: "complete",
          payload: interpreted.value,
          cache: {
            ...(interpreted.ttlMs !== undefined ? { ttlMs: interpreted.ttlMs } : {}),
            ...(interpreted.cacheScope !== undefined ? { cacheScope: interpreted.cacheScope } : {}),
          },
          warnings: warnings.codes,
        };
      }
    }
  }

  function errorCode(error: JsonRpcError): string {
    switch (error.code) {
      case JSON_RPC_ERROR_CODES.invalidParams:
        return "mcp.invalid-params";
      case JSON_RPC_ERROR_CODES.methodNotFound:
        return "mcp.method-not-found";
      case JSON_RPC_ERROR_CODES.legacyResourceNotFound:
        return "mcp.resource.not-found";
      case JSON_RPC_ERROR_CODES.legacyUrlElicitationRequired:
        return "mcp.elicitation.url-required";
      case MODERN_ERROR_CODES.headerMismatch:
        return "mcp.header-mismatch";
      case MODERN_ERROR_CODES.missingRequiredClientCapability:
        return "mcp.capability-missing";
      case MODERN_ERROR_CODES.unsupportedProtocolVersion:
        return "mcp.protocol.version-unsupported";
      case JSON_RPC_ERROR_CODES.internal:
        return "mcp.upstream-error";
      default:
        return error.code >= -32099 && error.code <= -32000 ? "mcp.upstream-error" : "mcp.upstream-error";
    }
  }

  /** Requests refused before execution leave nothing behind; internal errors may. */
  function appliedAfterError(error: JsonRpcError): "no" | "unknown" {
    return error.code === JSON_RPC_ERROR_CODES.internal ||
      (error.code >= -32099 && error.code <= -32000 && error.code !== JSON_RPC_ERROR_CODES.legacyResourceNotFound)
      ? "unknown"
      : "no";
  }

  /* ----------------------------------------------------------- discovery */

  function extensionsOf(capabilities: ServerCapabilities, warnings: Warnings): McpDiscovery["extensions"] {
    const advertised = new Set<string>(Object.keys(capabilities.extensions ?? {}));
    if (capabilities.tasks) advertised.add("tasks");
    for (const key of Object.keys(capabilities.experimental ?? {})) advertised.add(`experimental:${key}`);
    const list = [...advertised].map((name) => name.slice(0, 120)).slice(0, 32);
    for (const name of list) warnings.add(`mcp.extension.unsupported:${name}`);
    return { advertised: list, supported: [], unsupported: list };
  }

  async function discover(discoverOptions: { signal?: AbortSignal; refresh?: boolean } = {}): Promise<McpDiscovery> {
    const warnings = new Warnings(options.onWarning);
    const signal = discoverOptions.signal;
    if (state.era === "modern") {
      const message = await rpc("server/discover", {}, { effect: "read", warnings, ...(signal ? { signal } : {}) });
      if (state.era !== "modern") return discover(discoverOptions);
      if (message.kind === "authorization-required")
        throw new ConnectorError("unauthenticated", { detail: "mcp.authorization-required" });
      if (message.kind !== "result") throw discoveryFailure(message);
      const interpreted = interpretResult(
        message.result,
        (value) => {
          const parsed = discoverResultSchema.safeParse(value);
          return parsed.success ? parsed.data : undefined;
        },
        warnings,
        false,
      );
      if (interpreted.kind !== "complete")
        throw new ConnectorError("upstream-rejected", { detail: "mcp.discover.invalid" });
      const result = interpreted.value;
      if (!result.supportedVersions.includes(state.protocolVersion))
        warnings.add("mcp.discover.version-not-listed");
      state.capabilities = result.capabilities;
      state.supportedVersions = result.supportedVersions;
      state.instructions = result.instructions;
      const info = result._meta?.[META_KEYS.serverInfo];
      state.serverInfo = info && typeof info === "object" ? (info as Implementation) : undefined;
      state.discoveredAt = now();
    } else {
      const failure = await ensureInitialized(warnings, signal);
      if (failure) {
        if (failure.kind === "authorization-required")
          throw new ConnectorError("unauthenticated", { detail: "mcp.authorization-required" });
        throw discoveryFailure(failure);
      }
      if (state.era !== "legacy") return discover(discoverOptions);
    }
    const capabilities = state.capabilities ?? {};
    return {
      requestedProfile,
      usedProfile: state.usedProfile,
      era: state.era,
      protocolVersion: state.protocolVersion,
      ...(state.supportedVersions ? { supportedVersions: [...state.supportedVersions] } : {}),
      capabilities,
      ...(state.serverInfo ? { serverInfo: state.serverInfo } : {}),
      ...(state.instructions !== undefined ? { instructions: state.instructions.slice(0, 4096) } : {}),
      extensions: extensionsOf(capabilities, warnings),
      warnings: warnings.codes,
    };
  }

  function discoveryFailure(message: RpcResult): ConnectorError {
    if (message.kind === "error") {
      const code = errorCode(message.error);
      return new ConnectorError(code === "mcp.protocol.version-unsupported" ? "unsupported" : "upstream-rejected", {
        detail: code,
      });
    }
    if (message.kind === "failed") {
      if (message.code === "mcp.profile.legacy-server" || message.code.startsWith("mcp.protocol.version"))
        return new ConnectorError("unsupported", { detail: message.code });
      if (message.code === "mcp.cancelled") return new ConnectorError("cancelled", { detail: message.code });
      return new ConnectorError(
        message.code.startsWith("mcp.transport") || message.code.startsWith("mcp.http.5") ? "upstream-unavailable" : "upstream-rejected",
        { detail: message.code.replace(/[^a-z0-9.-]/g, "").slice(0, 120) },
      );
    }
    if (message.kind === "indeterminate")
      return new ConnectorError("indeterminate", { detail: message.code });
    if (message.kind === "authorization-required")
      return new ConnectorError("unauthenticated", { detail: "mcp.authorization-required" });
    return new ConnectorError("upstream-rejected", { detail: "mcp.discover.invalid" });
  }

  /* ---------------------------------------------------------------- lists */

  async function list<T>(
    method: string,
    itemsKey: "tools" | "resources" | "resourceTemplates" | "prompts",
    parseResult: (value: Record<string, unknown>) => { items: unknown[]; nextCursor?: string } | undefined,
    parseItem: (item: unknown, warnings: Warnings) => T | undefined,
    listOptions: { signal?: AbortSignal; refresh?: boolean },
  ): Promise<McpList<T>> {
    const warnings = new Warnings(options.onWarning);
    const who = principal();
    if (who && !listOptions.refresh) {
      const cached = cache?.store.get<McpList<T>>(who, method, { pages: "all" });
      if (cached) return { ...cached, fromCache: true, warnings: warnings.codes };
    }
    const items: T[] = [];
    let cursor: string | undefined;
    let pages = 0;
    let truncated = false;
    let ttlMs: number | undefined;
    let cacheScope: "public" | "private" | undefined;
    for (;;) {
      const message = await rpc(method, cursor === undefined ? {} : { cursor }, {
        effect: "read",
        warnings,
        ...(listOptions.signal ? { signal: listOptions.signal } : {}),
      });
      if (message.kind !== "result") throw listFailure(message);
      const interpreted = interpretResult(message.result, parseResult, warnings, false);
      if (interpreted.kind !== "complete")
        throw new ConnectorError("upstream-rejected", { detail: interpreted.kind === "failed" ? interpreted.code : "mcp.result.invalid" });
      pages++;
      const pageTtl = interpreted.ttlMs;
      ttlMs = ttlMs === undefined ? pageTtl : pageTtl === undefined ? ttlMs : Math.min(ttlMs, pageTtl);
      if (interpreted.cacheScope) cacheScope = cacheScope === "private" ? "private" : interpreted.cacheScope;
      for (const raw of interpreted.value.items) {
        if (items.length >= limits.maxListItems) {
          truncated = true;
          warnings.add(`mcp.list.truncated:${itemsKey}`);
          break;
        }
        const item = parseItem(raw, warnings);
        if (item !== undefined) items.push(item);
      }
      const next = interpreted.value.nextCursor;
      if (next === undefined || truncated) break;
      if (next.length === 0 || next.length > limits.maxCursorLength || /\p{Cc}/u.test(next)) {
        warnings.add("mcp.list.cursor-rejected");
        truncated = true;
        break;
      }
      if (pages >= limits.maxListPages) {
        warnings.add(`mcp.list.pages-exhausted:${itemsKey}`);
        truncated = true;
        break;
      }
      cursor = next;
    }
    const result: McpList<T> = {
      items,
      pages,
      truncated,
      ...(ttlMs !== undefined ? { ttlMs } : {}),
      ...(cacheScope !== undefined ? { cacheScope } : {}),
      fromCache: false,
      warnings: warnings.codes,
    };
    if (who && !truncated)
      cache?.store.set(who, method, { pages: "all" }, { ...result, warnings: [] }, { ttlMs, cacheScope });
    return result;
  }

  function listFailure(message: RpcResult): ConnectorError {
    if (message.kind === "authorization-required")
      return new ConnectorError("unauthenticated", { detail: "mcp.authorization-required" });
    return discoveryFailure(message);
  }

  function parseTool(raw: unknown, warnings: Warnings): McpTool | undefined {
    const parsed = toolSchema.safeParse(raw);
    if (!parsed.success) {
      warnings.add("mcp.tool.invalid-definition");
      return undefined;
    }
    const tool = parsed.data;
    const safeName = tool.name.replace(/[^A-Za-z0-9_.-]/g, "").slice(0, 60);
    if (headerSuggestions(tool._meta) || headerSuggestions(tool.annotations))
      warnings.add(`mcp.tool.header-suggestion-ignored:${safeName}`);
    const headers = collectHeaderParameters(tool.inputSchema);
    if (!headers.ok) {
      warnings.add(`mcp.tool.excluded.invalid-x-mcp-header:${safeName}`);
      return undefined;
    }
    return {
      name: tool.name,
      ...(tool.title !== undefined ? { title: tool.title } : {}),
      ...(tool.description !== undefined ? { description: tool.description } : {}),
      inputSchema: tool.inputSchema,
      ...(tool.outputSchema !== undefined ? { outputSchema: tool.outputSchema } : {}),
      ...(tool.annotations !== undefined ? { annotations: tool.annotations } : {}),
      headerParameters: headers.parameters,
      definitionDigest: definitionDigest({
        name: tool.name,
        ...(tool.description !== undefined ? { description: tool.description } : {}),
        inputSchema: tool.inputSchema,
        ...(tool.outputSchema !== undefined ? { outputSchema: tool.outputSchema } : {}),
        ...(tool.annotations !== undefined ? { annotations: tool.annotations } : {}),
      }),
    };
  }

  function listTools(listOptions: { signal?: AbortSignal; refresh?: boolean } = {}) {
    return list<McpTool>(
      "tools/list",
      "tools",
      (value) => {
        const parsed = listToolsResultSchema.safeParse(value);
        return parsed.success
          ? { items: parsed.data.tools, ...(parsed.data.nextCursor !== undefined ? { nextCursor: parsed.data.nextCursor } : {}) }
          : undefined;
      },
      parseTool,
      listOptions,
    );
  }

  function listResources(listOptions: { signal?: AbortSignal; refresh?: boolean } = {}) {
    return list<ResourceDefinition>(
      "resources/list",
      "resources",
      (value) => {
        const parsed = listResourcesResultSchema.safeParse(value);
        return parsed.success
          ? { items: parsed.data.resources, ...(parsed.data.nextCursor !== undefined ? { nextCursor: parsed.data.nextCursor } : {}) }
          : undefined;
      },
      (raw, warnings) => {
        const parsed = resourceSchema.safeParse(raw);
        if (!parsed.success) warnings.add("mcp.resource.invalid-definition");
        if (!parsed.success) return undefined;
        const { _meta, ...resource } = parsed.data;
        void _meta;
        return resource;
      },
      listOptions,
    );
  }

  function listResourceTemplates(listOptions: { signal?: AbortSignal; refresh?: boolean } = {}) {
    return list<ResourceTemplateDefinition>(
      "resources/templates/list",
      "resourceTemplates",
      (value) => {
        const parsed = listResourceTemplatesResultSchema.safeParse(value);
        return parsed.success
          ? {
              items: parsed.data.resourceTemplates,
              ...(parsed.data.nextCursor !== undefined ? { nextCursor: parsed.data.nextCursor } : {}),
            }
          : undefined;
      },
      (raw, warnings) => {
        const parsed = resourceTemplateSchema.safeParse(raw);
        if (!parsed.success) warnings.add("mcp.resource.invalid-template");
        if (!parsed.success) return undefined;
        const { _meta, ...template } = parsed.data;
        void _meta;
        return template;
      },
      listOptions,
    );
  }

  function listPrompts(listOptions: { signal?: AbortSignal; refresh?: boolean } = {}) {
    return list<PromptDefinition>(
      "prompts/list",
      "prompts",
      (value) => {
        const parsed = listPromptsResultSchema.safeParse(value);
        return parsed.success
          ? { items: parsed.data.prompts, ...(parsed.data.nextCursor !== undefined ? { nextCursor: parsed.data.nextCursor } : {}) }
          : undefined;
      },
      (raw, warnings) => {
        const parsed = promptSchema.safeParse(raw);
        if (!parsed.success) warnings.add("mcp.prompt.invalid-definition");
        if (!parsed.success) return undefined;
        const { _meta, ...prompt } = parsed.data;
        void _meta;
        return prompt;
      },
      listOptions,
    );
  }

  /* -------------------------------------------------------- invocations */

  /** `Mcp-Param-*` values from the arguments, for the tool's validated annotations only. */
  function mirroredHeaders(tool: McpTool, args: Record<string, unknown>): Record<string, string> {
    const headers: Record<string, string> = {};
    for (const parameter of tool.headerParameters) {
      const value = valueAtPath(args, parameter.path);
      if (value === undefined || value === null) continue;
      if (typeof value === "string") headers[parameter.header] = value;
      else if (typeof value === "boolean") headers[parameter.header] = value ? "true" : "false";
      else if (typeof value === "number" && Number.isSafeInteger(value)) headers[parameter.header] = String(value);
    }
    return headers;
  }

  async function callTool(request: Parameters<McpClient["callTool"]>[0]): Promise<McpOutcome<CallToolPayload>> {
    const warnings = new Warnings(options.onWarning);
    const signal = request.signal;
    let headerParameters: Record<string, string> = {};
    if (state.era === "modern" || request.expectedDigest !== undefined) {
      let tools: McpList<McpTool> | undefined;
      try {
        tools = await listTools({ ...(signal ? { signal } : {}) });
      } catch (error) {
        if (error instanceof ConnectorError && error.code === "unauthenticated") throw error;
        warnings.add("mcp.tool.list-unavailable");
      }
      const tool = tools?.items.find((item) => item.name === request.name);
      if (!tool) warnings.add("mcp.tool.not-listed");
      if (request.expectedDigest !== undefined && tool && tool.definitionDigest !== request.expectedDigest)
        return { kind: "failed", code: "mcp.tool.drift", applied: "no", warnings: warnings.codes };
      if (tool && state.era === "modern") headerParameters = mirroredHeaders(tool, request.arguments);
    }
    const params: Record<string, unknown> = { name: request.name, arguments: request.arguments };
    if (request.inputResponses) params.inputResponses = request.inputResponses;
    if (request.requestState !== undefined) params.requestState = request.requestState;
    const message = await rpc("tools/call", params, {
      effect: request.effect,
      name: request.name,
      headerParameters,
      warnings,
      ...(signal ? { signal } : {}),
    });
    return outcomeFromRpc<CallToolPayload>(
      message,
      warnings,
      (value) => {
        const parsed = callToolResultSchema.safeParse(value);
        if (!parsed.success) return undefined;
        const payload: CallToolPayload = {
          content: boundBlocks(parsed.data.content ?? [], warnings),
          isError: parsed.data.isError === true,
        };
        if (parsed.data.structuredContent !== undefined) {
          if (jsonByteLength(parsed.data.structuredContent) > limits.maxStructuredBytes)
            warnings.add("mcp.output.structured-dropped");
          else payload.structuredContent = parsed.data.structuredContent;
        }
        return payload;
      },
      true,
    );
  }

  async function readResource(request: Parameters<McpClient["readResource"]>[0]): Promise<McpOutcome<ReadResourcePayload>> {
    const warnings = new Warnings(options.onWarning);
    const params: Record<string, unknown> = { uri: request.uri };
    if (request.inputResponses) params.inputResponses = request.inputResponses;
    if (request.requestState !== undefined) params.requestState = request.requestState;
    const message = await rpc("resources/read", params, {
      effect: "read",
      name: request.uri,
      warnings,
      ...(request.signal ? { signal: request.signal } : {}),
    });
    const outcome = outcomeFromRpc<ReadResourcePayload>(
      message,
      warnings,
      (value) => {
        const parsed = readResourceResultSchema.safeParse(value);
        if (!parsed.success) return undefined;
        const contents: ResourceContents[] = [];
        for (const raw of parsed.data.contents) {
          if (contents.length >= limits.maxContentBlocks) {
            warnings.add("mcp.output.blocks-truncated");
            break;
          }
          const item = resourceContentsSchema.safeParse(raw);
          if (!item.success) {
            warnings.add("mcp.output.block-invalid");
            continue;
          }
          const { _meta, ...content } = item.data;
          void _meta;
          if (content.text !== undefined) content.text = boundText(content.text, warnings, "mcp.output.text-truncated");
          if (content.blob !== undefined && Buffer.byteLength(content.blob, "utf8") > limits.maxStructuredBytes) {
            warnings.add("mcp.output.binary-dropped");
            delete content.blob;
          }
          contents.push(content);
        }
        return { contents };
      },
      true,
    );
    if (outcome.kind === "failed" && outcome.error?.code === JSON_RPC_ERROR_CODES.invalidParams)
      return { ...outcome, code: "mcp.resource.not-found" };
    return outcome;
  }

  async function getPrompt(request: Parameters<McpClient["getPrompt"]>[0]): Promise<McpOutcome<GetPromptPayload>> {
    const warnings = new Warnings(options.onWarning);
    const params: Record<string, unknown> = { name: request.name };
    if (request.arguments) params.arguments = request.arguments;
    if (request.inputResponses) params.inputResponses = request.inputResponses;
    if (request.requestState !== undefined) params.requestState = request.requestState;
    const message = await rpc("prompts/get", params, {
      effect: "read",
      name: request.name,
      warnings,
      ...(request.signal ? { signal: request.signal } : {}),
    });
    return outcomeFromRpc<GetPromptPayload>(
      message,
      warnings,
      (value) => {
        const parsed = getPromptResultSchema.safeParse(value);
        if (!parsed.success) return undefined;
        const messages: GetPromptPayload["messages"] = [];
        for (const raw of parsed.data.messages) {
          if (messages.length >= limits.maxContentBlocks) {
            warnings.add("mcp.output.blocks-truncated");
            break;
          }
          const item = promptMessageSchema.safeParse(raw);
          if (!item.success) {
            warnings.add("mcp.output.block-invalid");
            continue;
          }
          const [content] = boundBlocks([item.data.content], warnings);
          if (content) messages.push({ role: item.data.role, content });
        }
        return {
          ...(parsed.data.description !== undefined ? { description: parsed.data.description } : {}),
          messages,
        };
      },
      true,
    );
  }

  /* --------------------------------------------------------- listening */

  async function listen(listenOptions: Parameters<McpClient["listen"]>[0]): Promise<ListenResult> {
    const warnings = new Warnings(options.onWarning);
    const maxEvents = Math.min(listenOptions.maxEvents ?? limits.listenMaxEvents, limits.listenMaxEvents);
    const maxMs = Math.min(listenOptions.maxMs ?? limits.listenMaxMs, limits.listenMaxMs);
    const events: ListenResult["events"] = [];
    const finish = (closedBy: ListenResult["closedBy"], acknowledged?: ListenFilter, supported = true): ListenResult => ({
      supported,
      ...(acknowledged ? { acknowledged } : {}),
      events,
      closedBy,
      warnings: warnings.codes,
    });
    const record = (method: string, params: Record<string, unknown> | undefined): void => {
      if (events.length >= maxEvents) return;
      const bounded = params && jsonByteLength(params) <= limits.maxResponseBytes ? params : undefined;
      events.push({ method, ...(bounded ? { params: bounded } : {}) });
      handleNotification(method);
    };
    if (state.era === "legacy") {
      const failure = await ensureInitialized(warnings, listenOptions.signal);
      if (failure) return finish("error");
    }
    if (state.era === "legacy") {
      let reply: HttpReply;
      try {
        reply = await withAuthorization((authorization) =>
          exchange(
            options.fetch,
            {
              url: endpoint,
              method: "GET",
              headers: { ...legacyHeaders(true), accept: "text/event-stream" },
              ...(authorization ? { authorization } : {}),
              ...(listenOptions.signal ? { signal: listenOptions.signal } : {}),
              timeoutMs: maxMs,
            },
            limits,
          ),
        );
      } catch (error) {
        return finish(error instanceof TransportError && error.phase === "timeout" ? "limit" : "error");
      }
      if (reply.status === 405) return finish("unsupported", undefined, false);
      if (reply.kind !== "stream") return finish("error", undefined, reply.status < 400);
      try {
        for await (const frame of reply.frames()) {
          const message = classifyJsonRpc(parseBoundedJson(frame.data, { maxDepth: limits.maxJsonDepth }));
          if (message.kind === "notification") record(message.method, message.params);
          else if (message.kind === "request") await answerServerRequest(message, warnings, [], listenOptions.signal);
          if (events.length >= maxEvents) return finish("limit");
        }
      } catch (error) {
        if (error instanceof TransportError && error.phase === "timeout") return finish("limit");
        if (error instanceof TransportError && error.phase === "aborted") return finish("client");
        return finish("error");
      }
      return finish("server");
    }
    const id = nextId();
    let reply: HttpReply;
    try {
      reply = await withAuthorization((authorization) =>
        exchange(
          options.fetch,
          {
            url: endpoint,
            method: "POST",
            headers: modernHeaders("subscriptions/listen"),
            body: { jsonrpc: "2.0", id, method: "subscriptions/listen", params: modernParams({ notifications: listenOptions.filter }) },
            ...(authorization ? { authorization } : {}),
            ...(listenOptions.signal ? { signal: listenOptions.signal } : {}),
            timeoutMs: maxMs,
          },
          limits,
        ),
      );
    } catch (error) {
      return finish(error instanceof TransportError && error.phase === "timeout" ? "limit" : "error");
    }
    if (reply.kind !== "stream") {
      if (reply.kind === "json") {
        const message = classifyJsonRpc(reply.body);
        if (message.kind === "error") warnings.add(`mcp.listen.refused:${message.error.code}`);
      }
      return finish("unsupported", undefined, false);
    }
    let acknowledged: ListenFilter | undefined;
    try {
      for await (const frame of reply.frames()) {
        const message = classifyJsonRpc(parseBoundedJson(frame.data, { maxDepth: limits.maxJsonDepth }));
        if (message.kind === "notification") {
          const meta = message.params?._meta as Record<string, unknown> | undefined;
          if (String(meta?.[META_KEYS.subscriptionId]) !== id) {
            warnings.add("mcp.listen.foreign-subscription");
            continue;
          }
          if (message.method === "notifications/subscriptions/acknowledged") {
            const filter = message.params?.notifications;
            acknowledged = filter && typeof filter === "object" ? (filter as ListenFilter) : {};
            continue;
          }
          if (!acknowledged) {
            warnings.add("mcp.listen.unacknowledged-notification");
            continue;
          }
          if (message.method === "notifications/cancelled") return finish("server", acknowledged);
          record(message.method, message.params);
          if (events.length >= maxEvents) return finish("limit", acknowledged);
        } else if (message.kind === "result" && String(message.id) === id) return finish("server", acknowledged);
        else if (message.kind === "error") {
          warnings.add(`mcp.listen.refused:${message.error.code}`);
          return finish("error", acknowledged);
        } else if (message.kind === "request") warnings.add("mcp.protocol.server-request-refused");
      }
    } catch (error) {
      if (error instanceof TransportError && error.phase === "timeout") return finish("limit", acknowledged);
      if (error instanceof TransportError && error.phase === "aborted") return finish("client", acknowledged);
      return finish("error", acknowledged);
    }
    return finish("server", acknowledged);
  }

  return {
    profile: requestedProfile,
    discover,
    listTools,
    listResources,
    listResourceTemplates,
    listPrompts,
    callTool,
    readResource,
    getPrompt,
    listen,
    state: () => ({
      era: state.era,
      protocolVersion: state.protocolVersion,
      usedProfile: state.usedProfile,
      session: state.session !== undefined,
    }),
    close: () => {
      state.session = undefined;
      state.initialized = false;
      invalidate();
    },
  };
}

export type { SseFrame };
