import type { ActorContext } from "../../../core/operation-contracts.js";
import type { ConnectionLifecycle } from "../../../core/connectors/index.js";
import { ConnectorError, type ConnectorErrorCode } from "../errors.js";

/*
 * AG-05: one continuation gate for every transport.
 *
 * HTTP routes, the MCP server, WebMCP tools in the browser and A2A
 * delegations are four ways of asking for the same work. If each of them
 * decided separately whether the work may still proceed, the weakest one
 * would be the deployment's real policy. They all call this instead, and the
 * decision depends only on facts — who is asking, on which surface, what they
 * last observed, and what the host currently permits — never on which
 * transport carried the request.
 *
 * "Stopping the assistant" is the case this exists for. A stop covers a
 * delegation scope, and every surface a model can reach is delegated work by
 * construction: a WebMCP tool runs inside a person's own browser session, so
 * the session alone cannot distinguish it from that person clicking a button.
 * The surface can.
 */

export const continuationSurfaces = ["http", "mcp", "webmcp", "a2a"] as const;
export type ContinuationSurface = (typeof continuationSurfaces)[number];

export const continuationIntents = [
  "read",
  "connect",
  "operate",
  "delegate",
  "disconnect",
  "administer",
] as const;
export type ContinuationIntent = (typeof continuationIntents)[number];

export type Capability = ActorContext["capabilities"][number];

/** What each intent needs from the host's current grant, not from the caller's claim. */
export const intentCapability: Readonly<Record<ContinuationIntent, Capability>> =
  Object.freeze({
    read: "executor",
    connect: "executor",
    operate: "executor",
    delegate: "executor",
    disconnect: "executor",
    administer: "admin",
  });

export type ObservedRevisions = {
  generation?: number | undefined;
  bindingRevision?: number | undefined;
  policyRevision?: string | undefined;
  configurationRevision?: string | undefined;
};

export type ContinuationRequest = {
  surface: ContinuationSurface;
  actor: ActorContext;
  intent: ContinuationIntent;
  connectionRef?: string | undefined;
  operationRef?: string | undefined;
  /** What the caller last read; a continuation built on stale state is refused. */
  observed?: ObservedRevisions | undefined;
};

export type ContinuationConnection = {
  connectionRef: string;
  tenantId: string;
  ownerId: string;
  sessionId?: string | undefined;
  lifecycle: ConnectionLifecycle;
  generation: number;
  bindingRevision: number;
  policyRevision: string;
  configurationRevision: string;
};

export type ContinuationState = {
  now: number;
  /** Capabilities the host grants this actor right now; a role change changes this. */
  capabilities: readonly Capability[];
  /** Milliseconds since the epoch at which delegated work was stopped, if it was. */
  stoppedAt?: number | undefined;
  connection?: ContinuationConnection | undefined;
};

export const continuationDenials = [
  "assistant-stopped",
  "role-revoked",
  "connection-not-owned",
  "connection-missing",
  "connection-inactive",
  "generation-fenced",
  "binding-revised",
  "policy-revised",
  "configuration-revised",
] as const;
export type ContinuationDenial = (typeof continuationDenials)[number];

export type ContinuationDecision =
  | { allowed: true; delegated: boolean }
  | {
      allowed: false;
      delegated: boolean;
      denial: ContinuationDenial;
      /** The connector error code this denial becomes on any transport. */
      code: ConnectorErrorCode;
      detail: string;
    };

const denialCodes: Readonly<Record<ContinuationDenial, ConnectorErrorCode>> =
  Object.freeze({
    "assistant-stopped": "cancelled",
    "role-revoked": "denied",
    "connection-not-owned": "not-found",
    "connection-missing": "not-found",
    "connection-inactive": "denied",
    "generation-fenced": "conflict",
    "binding-revised": "conflict",
    "policy-revised": "conflict",
    "configuration-revised": "conflict",
  });

/**
 * Whether this request is work an assistant is driving. Everything on the
 * MCP, WebMCP and A2A surfaces is, whatever actor kind the session carries;
 * on HTTP it is an agent actor or an explicit delegation.
 */
export function isDelegatedWork(request: ContinuationRequest): boolean {
  return (
    request.surface !== "http" ||
    request.actor.actorKind === "agent" ||
    request.intent === "delegate"
  );
}

/** Intents a stop halts. Reading state and taking a connection apart stay possible. */
const stoppableIntents = new Set<ContinuationIntent>([
  "connect",
  "operate",
  "delegate",
  "administer",
]);

/**
 * The whole decision. Order matters: a stopped assistant is refused before
 * anything is looked up, so a stop cannot be probed for the existence of a
 * connection, and ownership is checked before lifecycle, so a foreign
 * connection reports missing rather than its state.
 */
export function evaluateContinuation(
  request: ContinuationRequest,
  state: ContinuationState,
): ContinuationDecision {
  const delegated = isDelegatedWork(request);
  const deny = (denial: ContinuationDenial): ContinuationDecision => ({
    allowed: false,
    delegated,
    denial,
    code: denialCodes[denial],
    detail: `continuation.${denial}`,
  });
  if (
    state.stoppedAt !== undefined &&
    delegated &&
    stoppableIntents.has(request.intent)
  )
    return deny("assistant-stopped");
  if (!state.capabilities.includes(intentCapability[request.intent]))
    return deny("role-revoked");
  if (request.connectionRef === undefined) return { allowed: true, delegated };
  const connection = state.connection;
  if (!connection || connection.connectionRef !== request.connectionRef)
    return deny("connection-missing");
  if (
    connection.tenantId !== request.actor.tenantId ||
    connection.ownerId !== request.actor.subjectId ||
    (connection.sessionId !== undefined &&
      connection.sessionId !== request.actor.sessionId)
  )
    return deny("connection-not-owned");
  const observed = request.observed ?? {};
  if (
    observed.generation !== undefined &&
    observed.generation !== connection.generation
  )
    return deny("generation-fenced");
  if (
    observed.bindingRevision !== undefined &&
    observed.bindingRevision !== connection.bindingRevision
  )
    return deny("binding-revised");
  if (
    observed.policyRevision !== undefined &&
    observed.policyRevision !== connection.policyRevision
  )
    return deny("policy-revised");
  if (
    observed.configurationRevision !== undefined &&
    observed.configurationRevision !== connection.configurationRevision
  )
    return deny("configuration-revised");
  if (
    (request.intent === "operate" || request.intent === "delegate") &&
    connection.lifecycle !== "active" &&
    connection.lifecycle !== "degraded"
  )
    return deny("connection-inactive");
  return { allowed: true, delegated };
}

/** Turns a decision into the failure every transport reports for it. */
export function continuationError(
  decision: Extract<ContinuationDecision, { allowed: false }>,
): ConnectorError {
  return new ConnectorError(decision.code, { detail: decision.detail });
}

export function assertContinuation(
  request: ContinuationRequest,
  state: ContinuationState,
): void {
  const decision = evaluateContinuation(request, state);
  if (!decision.allowed) throw continuationError(decision);
}

export type DelegationScope = {
  tenantId: string;
  subjectId: string;
  /** Absent stops every session of that subject; present stops only that one. */
  sessionId?: string | undefined;
};

/**
 * Where "the assistant was stopped" is remembered. A stop is per tenant and
 * subject, optionally narrowed to one session, and is read the same way by
 * every surface. It is deliberately small and in-process: a deployment backs
 * it with the shared store, and the shape it must implement is `readStop`.
 */
export class DelegationStopRegistry {
  private readonly stops = new Map<string, number>();
  private static key(scope: DelegationScope): string {
    const parts = [scope.tenantId, scope.subjectId, scope.sessionId ?? ""];
    // Length-prefixed so no separator can appear inside a part and make two
    // different scopes collide.
    return parts.map((part) => `${part.length}:${part}`).join("|");
  }

  stop(scope: DelegationScope, at: number): void {
    if (this.stops.size > 8192) {
      const first = this.stops.keys().next().value;
      if (first !== undefined) this.stops.delete(first);
    }
    this.stops.set(DelegationStopRegistry.key(scope), at);
  }

  resume(scope: DelegationScope): void {
    this.stops.delete(DelegationStopRegistry.key(scope));
  }

  /** The stop that covers this actor: the session's own, or the subject's. */
  readStop(actor: ActorContext): number | undefined {
    return (
      this.stops.get(
        DelegationStopRegistry.key({
          tenantId: actor.tenantId,
          subjectId: actor.subjectId,
          sessionId: actor.sessionId,
        }),
      ) ??
      this.stops.get(
        DelegationStopRegistry.key({
          tenantId: actor.tenantId,
          subjectId: actor.subjectId,
        }),
      )
    );
  }
}

export type ContinuationGuardOptions = {
  stops: Pick<DelegationStopRegistry, "readStop">;
  now: () => number;
  /** Current host grant for this actor; defaults to the actor's own capabilities. */
  capabilities?: (actor: ActorContext) => readonly Capability[];
  connection?: (
    actor: ActorContext,
    connectionRef: string,
  ) => Promise<ContinuationConnection | undefined>;
};

/** A guard bound to one deployment's registries, for a transport to call directly. */
export function createContinuationGuard(options: ContinuationGuardOptions) {
  return {
    async evaluate(
      request: ContinuationRequest,
    ): Promise<ContinuationDecision> {
      const stoppedAt = options.stops.readStop(request.actor);
      const connection =
        request.connectionRef === undefined
          ? undefined
          : await options.connection?.(request.actor, request.connectionRef);
      return evaluateContinuation(request, {
        now: options.now(),
        capabilities:
          options.capabilities?.(request.actor) ?? request.actor.capabilities,
        ...(stoppedAt === undefined ? {} : { stoppedAt }),
        ...(connection ? { connection } : {}),
      });
    },
    async assert(request: ContinuationRequest): Promise<void> {
      const decision = await this.evaluate(request);
      if (!decision.allowed) throw continuationError(decision);
    },
  };
}

export type ContinuationGuard = ReturnType<typeof createContinuationGuard>;
