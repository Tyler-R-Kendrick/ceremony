import { z } from "zod";
import {
  backendDescriptorSchema,
  browserSessionRefSchema,
  loginResultSchema,
  sessionReleaseKindSchema,
  sessionReleaseResultSchema,
  sessionStatusSchema,
  type BackendDescriptor,
  type BrowserOperationReason,
  type LoginEvidence,
  type LoginResult,
  type SessionReleaseResult,
  type SessionStatus,
} from "../core/browser-session-contracts.js";
import { requireCapability } from "./identity.js";
import type { ActorContext } from "./identity.js";
import { LeaseConflict, SessionLost } from "./browser-sessions.js";
import type { BrowserSessionRegistry } from "./browser-sessions.js";
import type { BrowserLoginService } from "./browser-login-service.js";
import {
  compileLoginPlan,
  connectionDraftSchema,
  PlanRejected,
  type PlanRejectionReason,
} from "./login-plan.js";

/**
 * The four operations a client may perform on a *retained browser session*.
 *
 * They live here for the same reason {@link ./agent-tools.js} exists: the HTTP
 * routes and the MCP tools perform the same operations for the same actors, and
 * an authorization rule that exists in one copy and not the other is a hole
 * rather than a difference. Here that rule is the controller check — the only
 * thing stopping one of a person's clients from driving a browser another of
 * their clients logged in — and the plan compilation, which is what stops a
 * caller naming a connector, a backend or a verification setting the server
 * never admitted.
 *
 * Every function takes the already-authenticated actor. Nothing here reads a
 * header, a cookie or a token, and an actor is never derived from tool
 * arguments. Nothing here accepts a credential *value*, a browser handle, a
 * control URL, a socket or a profile path either: a reference is all a client
 * ever holds, and every reference is resolved against the current actor by the
 * session registry on every single call.
 */

/** Mirrors `agentToolInputs`: a conservative identifier, not a free string. */
const identifier = z.string().regex(/^[a-zA-Z][a-zA-Z0-9_.:-]{0,119}$/);

/**
 * A credential *reference*, in the shape the private collector actually mints.
 *
 * The draft schema accepts any short string here because it is an internal
 * value by the time it reaches the compiler. At the tool boundary that is not
 * good enough: a password and a reference are both short strings, so a schema
 * that admits one admits the other, and the first place anybody would notice is
 * the provider's logs. A UUID is what the collector issues (see
 * `secretRef` in {@link ../core/schema.js}), so a UUID is what is accepted.
 */
const credentialReferenceSchema = z.uuid();

/**
 * What a client may say about the connection it wants.
 *
 * Derived from the compiler's own draft schema rather than restated, so a field
 * added there cannot silently become an unvalidated field here. Two deliberate
 * changes:
 *
 * - `connectorId` is removed. The tool names the connector once, at the top
 *   level, and the server splices it in; a draft that could disagree with the
 *   named connector would be two answers to one question.
 * - `credentialRefs` is narrowed to real references, as above.
 *
 * It stays strict, which is what refuses a client-supplied `verified`,
 * `actor`, `effectivePlanDigest` or any other field a caller might hope the
 * server reads. Those are outputs of compilation, never inputs to it.
 */
const clientDraftSchema = connectionDraftSchema
  .omit({ connectorId: true, credentialRefs: true })
  .extend({
    credentialRefs: z
      .record(z.string().min(1).max(32), credentialReferenceSchema)
      .optional(),
  });

export const browserLoginToolInputs = {
  login: z.strictObject({ connectorId: identifier, draft: clientDraftSchema }),
  sessionStatus: z.strictObject({ sessionRef: browserSessionRefSchema }),
  release: z.strictObject({
    sessionRef: browserSessionRefSchema,
    kind: sessionReleaseKindSchema,
  }),
  backends: z.strictObject({}),
} as const;

export type BrowserLoginToolName = keyof typeof browserLoginToolInputs;

/** What a client is told about the browsers this host can actually offer. */
export type BackendNegotiation = {
  backends: readonly BackendDescriptor[];
  /**
   * Whether a plan that turns verification off will be refused. Said up front
   * so a client can stop asking for something this deployment will never do,
   * rather than discovering it as a rejection.
   */
  verificationRequired: boolean;
};

export type BrowserLoginToolDeps = {
  service: BrowserLoginService;
  sessions: BrowserSessionRegistry;
  /**
   * Connectors this server knows, for this actor. An unknown one is rejected by
   * name; it never falls back to the first known connector.
   */
  knownConnectors(
    actor: ActorContext,
  ): Promise<ReadonlySet<string>> | ReadonlySet<string>;
  /**
   * Backends this host actually has. Defaults to the managed ones, imported
   * lazily so a deployment that never logs anybody in does not pull a browser
   * driver into its startup path.
   */
  backends?():
    Promise<readonly BackendDescriptor[]> | readonly BackendDescriptor[];
  /** Credential references this actor may use. Omitted means "not checked here". */
  credentialRefs?(
    actor: ActorContext,
  ): Promise<ReadonlySet<string>> | ReadonlySet<string>;
  /**
   * Whether this deployment permits a deliberately unverified attempt. A host
   * decision, never a client one: it is read from here and from nowhere else.
   */
  allowUnverified?: boolean;
  /** Plan revision this host is currently issuing. */
  revision?(): number;
  /**
   * The evidence behind a retained session, when the host keeps a ledger of it.
   *
   * {@link ../core/browser-session-contracts.js} recomputes `verified` from
   * evidence held in hand rather than from a stored boolean, precisely so stale
   * evidence cannot keep reporting success. The login service records evidence
   * against the session but does not hand the object back, so a host that wants
   * a live `verified` supplies it here. Without one this layer reports
   * `verified: false` and lets `evidenceKind` say what was once established,
   * rather than promoting a remembered label into a present claim.
   */
  evidenceFor?(
    actor: ActorContext,
    sessionRef: string,
  ): Promise<LoginEvidence | undefined>;
};

/** Structured failures. Finite codes and finite reasons, never free-form text. */
export const browserToolFailureCodes = [
  "plan-rejected",
  "session-lost",
  "lease-conflict",
] as const;
export type BrowserToolFailureCode = (typeof browserToolFailureCodes)[number];

export type BrowserToolFailure = {
  code: BrowserToolFailureCode;
  reason: PlanRejectionReason | BrowserOperationReason;
  status: number;
};

/**
 * Translate this module's failures for a transport, once.
 *
 * Both transports call this rather than each writing its own `instanceof`
 * ladder, for the same reason the tools themselves are shared. What comes out
 * is two enum members and a status code: no exception, no stack, no browser
 * object, no origin and no URL — a `PlanRejected` carries a `detail` naming the
 * thing that was rejected, and it is dropped here on purpose, because a
 * caller-supplied string echoed back is how a secret ends up in a log.
 */
export function browserToolFailure(
  error: unknown,
): BrowserToolFailure | undefined {
  if (error instanceof PlanRejected)
    return { code: "plan-rejected", reason: error.reason, status: 400 };
  if (error instanceof LeaseConflict)
    return { code: "lease-conflict", reason: "lease-conflict", status: 409 };
  if (error instanceof SessionLost)
    return { code: "session-lost", reason: "target-unavailable", status: 409 };
  return undefined;
}

export function createBrowserLoginTools(deps: BrowserLoginToolDeps) {
  /**
   * Plan digests for sessions this process established.
   *
   * The projection needs the plan a session was created under to decide whether
   * evidence still describes it. Keeping that here is not a second source of
   * truth: the registry only ever resolves a session whose *live* entry is in
   * this executor, so a session this map has forgotten is one the registry
   * reports lost anyway.
   */
  const planDigests = new Map<string, string>();

  /**
   * Which client is asking.
   *
   * Session, not just subject. A person's second MCP client is the same subject
   * and a different holder, and the registry's lease check is what keeps it
   * that way — so the identity handed to that check has to distinguish them.
   */
  const controllerOf = (actor: ActorContext) =>
    `${actor.tenantId}:${actor.subjectId}:${actor.sessionId}`;

  const admitted = async (): Promise<readonly BackendDescriptor[]> =>
    deps.backends
      ? await deps.backends()
      : (await import("./browser-backends.js")).managedBackends();

  return {
    /**
     * Compile what was asked for into what this server will do, run it, and
     * report exactly what was established.
     *
     * The draft is a *request*. Every decision that matters — which connector,
     * which backend, whether verification may be skipped, which credential
     * references are usable — is made here against the host's own registrations
     * and never against anything in the arguments. The result is re-parsed
     * through the published schema so a service that grew a field cannot leak
     * it through a tool.
     */
    async login(actor: ActorContext, input: unknown): Promise<LoginResult> {
      requireCapability(actor, "executor");
      const { connectorId, draft } = browserLoginToolInputs.login.parse(input);
      const usable = await deps.credentialRefs?.(actor);
      const plan = compileLoginPlan(
        { ...draft, connectorId },
        {
          backends: await admitted(),
          knownConnectors: await deps.knownConnectors(actor),
          ...(usable ? { availableCredentialRefs: usable } : {}),
          // Present only when the host set it. `allowUnverified` defaulting to
          // undefined is what makes `requireVerification: false` a rejection.
          ...(deps.allowUnverified === true ? { allowUnverified: true } : {}),
          revision: deps.revision?.() ?? 1,
        },
      );

      const result = loginResultSchema.parse(
        await deps.service.login(actor, { plan }),
      );

      const sessionRef =
        "sessionRef" in result ? (result.sessionRef ?? undefined) : undefined;
      // A `dispose` continuation ends its own session before returning, so
      // there is nothing left to hand control of; anything else that retained
      // one is bound to the client that asked for it, because a session with no
      // controller is a session nobody — including its creator — may drive.
      if (sessionRef && plan.continuation !== "dispose") {
        planDigests.set(sessionRef, plan.digest);
        try {
          const retained = await deps.sessions.status(actor, sessionRef, {
            planDigest: plan.digest,
          });
          // The scope the session already carries is carried across unchanged:
          // moving control must not widen what that control may do.
          await deps.sessions.transfer(actor, sessionRef, {
            controllerRef: controllerOf(actor),
            scope: retained.scope,
          });
        } catch (error) {
          // An unbound retained session is a browser nobody can reach and
          // nobody will close. Releasing it is the honest cleanup.
          planDigests.delete(sessionRef);
          await deps.sessions
            .release(actor, sessionRef, "dispose-managed")
            .catch(() => {});
          throw error;
        }
      }
      return result;
    },

    /**
     * What this client may see about a session.
     *
     * The projection, never the record: no tenant, no subject, no executor or
     * context reference, no browser handle and no control URL. A client of the
     * same person that does not hold control is not refused here — it is told
     * `controllable: false`, which is the question that field exists to answer.
     * Driving is a different permission, and {@link release} enforces it.
     */
    async sessionStatus(
      actor: ActorContext,
      input: unknown,
    ): Promise<SessionStatus> {
      requireCapability(actor, "executor");
      const { sessionRef } = browserLoginToolInputs.sessionStatus.parse(input);
      const evidence = await deps.evidenceFor?.(actor, sessionRef);
      return sessionStatusSchema.parse(
        await deps.sessions.status(actor, sessionRef, {
          ...(evidence ? { evidence } : {}),
          callerRef: controllerOf(actor),
          // A session this process did not establish has no known plan, and an
          // unmatchable digest is the right answer: it cannot be reported
          // verified on evidence nothing here can tie to it.
          planDigest: planDigests.get(sessionRef) ?? "",
        }),
      );
    },

    /**
     * Stop driving, dispose what this executor owns, or cancel a run.
     *
     * Control is proved before anything ends. `resolve` re-reads ownership from
     * the authenticated actor and refuses a client that is not the current
     * holder, which is why the check is made by calling it rather than by
     * reading a record here.
     */
    async release(
      actor: ActorContext,
      input: unknown,
    ): Promise<SessionReleaseResult> {
      requireCapability(actor, "executor");
      const { sessionRef, kind } = browserLoginToolInputs.release.parse(input);
      await deps.sessions.resolve(actor, sessionRef, {
        controllerRef: controllerOf(actor),
      });
      const result = sessionReleaseResultSchema.parse(
        await deps.sessions.release(actor, sessionRef, kind),
      );
      // Cancelling a run disposes nothing, so the session — and the plan it was
      // established under — is still there to ask about.
      if (kind !== "cancel-run") planDigests.delete(sessionRef);
      return result;
    },

    /**
     * The browsers this host can actually offer, with what each one can enforce.
     *
     * Honest negotiation: the descriptors are the runtime's own, capability
     * booleans and all, so a client can see before it asks that (say) no engine
     * here provides strong egress containment. A capability a client sends is a
     * demand the compiler checks against this same list; it is never a claim
     * about the host that the host then believes.
     */
    async backends(
      actor: ActorContext,
      input: unknown,
    ): Promise<BackendNegotiation> {
      requireCapability(actor, "executor");
      browserLoginToolInputs.backends.parse(input ?? {});
      return {
        backends: (await admitted()).map((descriptor) =>
          backendDescriptorSchema.parse(descriptor),
        ),
        verificationRequired: deps.allowUnverified !== true,
      };
    },
  };
}

export type BrowserLoginTools = ReturnType<typeof createBrowserLoginTools>;
