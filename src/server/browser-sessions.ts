import {
  browserSessionRecordSchema,
  mintReference,
  projectSessionStatus,
  type BrowserOwnership,
  type BrowserSessionRecord,
  type LoginEvidence,
  type SessionReleaseKind,
  type SessionReleaseResult,
  type SessionStatus,
} from "../core/browser-session-contracts.js";
import type { ActorContext } from "../core/operation-contracts.js";
import { AuthorizationError } from "./identity.js";
import type { AsyncCeremonyStore } from "./persistence/index.js";
import type { ManagedBrowser, ManagedContext } from "./browser-backends.js";

/**
 * Retained browser sessions: what survives the login call, who may drive it,
 * and what releasing it does and does not do.
 *
 * Two stores, deliberately:
 *
 * - The *durable* record is secret-free authorization and lifecycle metadata.
 *   It can be written to a database, read after a restart, and shown to a
 *   caller. It contains no browser handle and no control URL.
 * - The *live* registry holds the actual browser objects and never leaves this
 *   process. A database row does not make a browser process durable, so a
 *   record whose live entry is gone describes a session that is lost, and
 *   saying so is the only honest answer.
 *
 * Reconnection proves the same executor and the same browser generation. It
 * never adopts a browser that merely happens to be showing the same URL.
 */

/** Live resources for one retained session. Private to the executor. */
type LiveSession = {
  executorRef: string;
  browserGeneration: string;
  ownership: BrowserOwnership;
  browser: ManagedBrowser | undefined;
  context: ManagedContext | undefined;
  /** Bumped on every authorized transfer; fences an old controller's work. */
  leaseGeneration: number;
};

export class SessionLost extends Error {
  constructor(readonly sessionRef: string) {
    super("The browser behind this session is no longer available");
    this.name = "SessionLost";
  }
}

export class LeaseConflict extends Error {
  constructor(readonly sessionRef: string) {
    super("Another holder owns this session");
    this.name = "LeaseConflict";
  }
}

const recordKey = (actor: ActorContext, sessionRef: string) => ({
  tenant: actor.tenantId,
  kind: "session" as const,
  id: `browser:${sessionRef}`,
});

export type RetainInput = {
  ownership: BrowserOwnership;
  engine: BrowserSessionRecord["engine"];
  backendId: string;
  executorRef: string;
  browserGeneration: string;
  contextRef: string;
  trustMode: BrowserSessionRecord["trustMode"];
  scope: readonly string[];
  effectivePlanDigest: string;
  ttlMs: number;
  controllerRef?: string | undefined;
  browser?: ManagedBrowser | undefined;
  context?: ManagedContext | undefined;
};

/**
 * One executor's registry.
 *
 * `executorRef` identifies this process. It is written into every record and
 * checked on every reconnect, so a session retained by a worker that has since
 * been replaced is reported lost rather than driven by a stranger that inherited
 * its database rows.
 */
export function createBrowserSessionRegistry(options: {
  store: AsyncCeremonyStore;
  executorRef?: string;
  now?: () => number;
}) {
  const executorRef = options.executorRef ?? mintReference("bexec");
  const now = options.now ?? (() => Date.now());
  const live = new Map<string, LiveSession>();

  const load = async (
    actor: ActorContext,
    sessionRef: string,
  ): Promise<{ record: BrowserSessionRecord; revision: number }> => {
    const stored = await options.store.transaction((tx) =>
      tx.get<BrowserSessionRecord>(recordKey(actor, sessionRef)),
    );
    if (!stored) throw new AuthorizationError("denied");
    const record = browserSessionRecordSchema.parse(stored.value);
    // Ownership is re-derived from the authenticated actor on every operation.
    // Holding the reference is not holding a permission.
    if (record.tenant !== actor.tenantId || record.subject !== actor.subjectId)
      throw new AuthorizationError("denied");
    return { record, revision: stored.revision };
  };

  const save = async (
    actor: ActorContext,
    record: BrowserSessionRecord,
    expectedRevision: number | null,
  ) => {
    await options.store.transaction((tx) =>
      tx.put(recordKey(actor, record.sessionRef), record, expectedRevision),
    );
  };

  return {
    executorRef,

    /** Keep a session alive past the call that created it. */
    async retain(
      actor: ActorContext,
      input: RetainInput,
    ): Promise<BrowserSessionRecord> {
      const sessionRef = mintReference("bsess");
      const record = browserSessionRecordSchema.parse({
        sessionRef,
        ownership: input.ownership,
        engine: input.engine,
        backendId: input.backendId,
        executorRef: input.executorRef,
        browserGeneration: input.browserGeneration,
        contextRef: input.contextRef,
        tenant: actor.tenantId,
        subject: actor.subjectId,
        ...(input.controllerRef ? { controllerRef: input.controllerRef } : {}),
        leaseGeneration: 0,
        trustMode: input.trustMode,
        scope: [...input.scope],
        effectivePlanDigest: input.effectivePlanDigest,
        expiresAt: new Date(now() + input.ttlMs).toISOString(),
      } satisfies BrowserSessionRecord);
      live.set(sessionRef, {
        executorRef: input.executorRef,
        browserGeneration: input.browserGeneration,
        ownership: input.ownership,
        browser: input.browser,
        context: input.context,
        leaseGeneration: 0,
      });
      await save(actor, record, null);
      return record;
    },

    /**
     * Resolve a session for use, proving it is the same browser.
     *
     * Three separate things must agree: the record must belong to this actor,
     * the live entry must exist in *this* executor, and its browser generation
     * must match the one recorded. Any disagreement is a lost session; none of
     * them is recoverable by trying harder.
     */
    async resolve(
      actor: ActorContext,
      sessionRef: string,
      options2: { controllerRef?: string | undefined } = {},
    ): Promise<{ record: BrowserSessionRecord; session: LiveSession }> {
      const { record } = await load(actor, sessionRef);
      if (Date.parse(record.expiresAt) <= now())
        throw new SessionLost(sessionRef);
      const session = live.get(sessionRef);
      if (
        !session ||
        session.executorRef !== record.executorRef ||
        record.executorRef !== executorRef ||
        session.browserGeneration !== record.browserGeneration
      )
        throw new SessionLost(sessionRef);
      if (session.browser && !session.browser.alive())
        throw new SessionLost(sessionRef);
      if (
        options2.controllerRef !== undefined &&
        record.controllerRef !== options2.controllerRef
      )
        throw new LeaseConflict(sessionRef);
      if (
        options2.controllerRef !== undefined &&
        session.leaseGeneration !== record.leaseGeneration
      )
        throw new LeaseConflict(sessionRef);
      return { record, session };
    },

    /**
     * Hand control to a different client.
     *
     * The generation bump is the fence: work the previous controller queued
     * before the transfer is refused at the executor when it arrives, rather
     * than being allowed through because it was authorized once.
     */
    async transfer(
      actor: ActorContext,
      sessionRef: string,
      to: { controllerRef: string; scope: readonly string[] },
    ): Promise<BrowserSessionRecord> {
      const { record, revision } = await load(actor, sessionRef);
      const session = live.get(sessionRef);
      if (!session) throw new SessionLost(sessionRef);
      const next = browserSessionRecordSchema.parse({
        ...record,
        controllerRef: to.controllerRef,
        leaseRef: mintReference("blse"),
        leaseGeneration: record.leaseGeneration + 1,
        scope: [...to.scope],
      } satisfies BrowserSessionRecord);
      session.leaseGeneration = next.leaseGeneration;
      await save(actor, next, revision);
      return next;
    },

    /** Record verification against this session, replacing any earlier claim. */
    async recordEvidence(
      actor: ActorContext,
      sessionRef: string,
      evidence: LoginEvidence,
      evidenceRef: string,
    ): Promise<BrowserSessionRecord> {
      const { record, revision } = await load(actor, sessionRef);
      // Evidence gathered against a different browser cannot describe this one.
      if (evidence.browserGeneration !== record.browserGeneration)
        throw new SessionLost(sessionRef);
      const next = browserSessionRecordSchema.parse({
        ...record,
        evidenceRef,
        evidenceKind: evidence.kind,
        verifiedAt: evidence.verifiedAt,
      } satisfies BrowserSessionRecord);
      await save(actor, next, revision);
      return next;
    },

    /**
     * End something. Which something depends on `kind`, and the three are not
     * interchangeable.
     *
     * Releasing control of an attached browser revokes Ceremony's automation
     * and nothing else: the person's process, tabs and cookies are untouched,
     * because they were never Ceremony's to dispose. Disposing a managed
     * session destroys only the context and browser this executor created.
     * Neither ends the provider's session, and the result says so explicitly
     * rather than letting a caller infer a logout that did not happen.
     */
    async release(
      actor: ActorContext,
      sessionRef: string,
      kind: SessionReleaseKind,
    ): Promise<SessionReleaseResult> {
      const { record, revision } = await load(actor, sessionRef);
      const session = live.get(sessionRef);

      if (kind === "cancel-run") {
        // Cancellation stops future dispatch. It cannot retract a request that
        // is already on the wire, which is why it disposes nothing.
        return {
          kind,
          automationRevoked: false,
          managedResourcesDisposed: false,
          userBrowserPreserved: true,
          upstreamLogout: false,
        };
      }

      if (kind === "dispose-managed" && record.ownership === "attached-user")
        // Refusing is the point: an attached browser is the person's, and a
        // caller asking to destroy it has misunderstood what it is holding.
        throw new AuthorizationError("denied");

      if (kind === "dispose-managed") {
        // The context is this session's and always goes.
        await session?.context?.close().catch(() => {});
        // The browser is not. `ManagedBrowser.dispose()` closes every context
        // the backend ever created and then the process, so calling it to end
        // *one* session ends every session sharing that browser - and the
        // harm is the one this module exists to prevent, read the other way
        // round: an authenticated session nobody can reach.
        //
        // A managed browser is built to hold several contexts; `openContext`
        // exists and the backend keeps a set of them. Nothing in production
        // shares one yet, because the login service launches a browser per
        // login, so this was latent rather than live. It was not invisible:
        // the conformance suite shares a browser per engine and had to stub
        // `dispose` to a no-op so one case ending would not take the engine
        // away from the cases after it.
        //
        // So the last one out disposes it. Counted over the live sessions
        // rather than declared by the caller, because a caller that has to
        // remember gets it wrong, and the registry is the only thing that
        // knows who else is still holding the same object.
        const stillInUse = [...live].some(
          ([ref, other]) =>
            ref !== sessionRef &&
            session?.browser !== undefined &&
            other.browser === session.browser,
        );
        if (!stillInUse) await session?.browser?.dispose().catch(() => {});
      }
      // Dropping the live entry is what actually revokes automation: without
      // it every later operation fails to resolve, for every controller.
      live.delete(sessionRef);
      await options.store.transaction(async (tx) => {
        await tx.delete(recordKey(actor, sessionRef), revision);
      });
      return {
        kind,
        automationRevoked: true,
        managedResourcesDisposed: kind === "dispose-managed",
        // An invariant, not a variable. Disposal is refused outright for an
        // attached browser above, and a managed one is a process Ceremony
        // started, so no release path can ever close a browser the person owns.
        userBrowserPreserved: true,
        upstreamLogout: false,
      };
    },

    /** What a caller may see. Never the record. */
    async status(
      actor: ActorContext,
      sessionRef: string,
      view: {
        evidence?: LoginEvidence | undefined;
        callerRef?: string | undefined;
        planDigest: string;
      },
    ): Promise<SessionStatus> {
      const { record } = await load(actor, sessionRef);
      return projectSessionStatus(record, {
        now: new Date(now()),
        ...(view.evidence ? { evidence: view.evidence } : {}),
        ...(view.callerRef ? { callerRef: view.callerRef } : {}),
        planDigest: view.planDigest,
      });
    },

    /**
     * Drop sessions whose time is up.
     *
     * A person who never comes back must not leave a browser running and a
     * grant valid forever, so expiry disposes managed resources on its own
     * rather than waiting to be asked.
     */
    async expire(actor: ActorContext): Promise<number> {
      let closed = 0;
      for (const [sessionRef, session] of [...live]) {
        let record: BrowserSessionRecord | undefined;
        try {
          record = (await load(actor, sessionRef)).record;
        } catch {
          // The record is gone but the browser is not; that is exactly the
          // leak this pass exists to close.
          record = undefined;
        }
        if (record && Date.parse(record.expiresAt) > now()) continue;
        if (session.ownership === "managed") {
          await session.context?.close().catch(() => {});
          await session.browser?.dispose().catch(() => {});
        }
        live.delete(sessionRef);
        closed++;
      }
      return closed;
    },

    /** Test and shutdown seam: forget live entries without touching records. */
    async disposeAll(): Promise<void> {
      // Every context, then each distinct browser once. Tearing the registry
      // down does dispose browsers - that is what this is for, unlike a
      // single release - but two sessions sharing one must not dispose it
      // twice, so the same invariant holds on both paths: a browser is
      // disposed when the last thing using it lets go, exactly once.
      const browsers = new Set<ManagedBrowser>();
      for (const session of live.values()) {
        if (session.ownership !== "managed") continue;
        await session.context?.close().catch(() => {});
        if (session.browser) browsers.add(session.browser);
      }
      for (const browser of browsers) await browser.dispose().catch(() => {});
      live.clear();
    },
  };
}

export type BrowserSessionRegistry = ReturnType<
  typeof createBrowserSessionRegistry
>;
