import { createHash } from "node:crypto";
import { z } from "zod";
import {
  browserStateRefSchema,
  mintReference,
} from "../core/browser-session-contracts.js";
import type { ActorContext } from "../core/operation-contracts.js";
import type { AsyncCeremonyStore } from "./persistence/index.js";

/**
 * Where a browser's storage state lives between contexts.
 *
 * A storage-state export is not a description of a session. It **is** the
 * session: cookies that anything presenting them can use, for as long as the
 * provider honours them. So it is handled the way this project handles a
 * credential rather than the way it handles a record.
 *
 * Three rules follow, and the shape of this module is all three.
 *
 * **The bytes never leave.** There is no read operation. `save` returns an
 * opaque reference and `restore` returns a *thunk* that the backend calls once
 * at context creation; nothing in between can be asked for the value. A
 * function that returned it would be reachable from a tool, and then a
 * caller's transcript would hold somebody's session.
 *
 * **It is scoped to a subject.** The key carries the subject, so one person's
 * saved state cannot be restored under another's actor even with the
 * reference in hand. Guessing a reference gets you a refusal, not a session.
 *
 * **It expires.** A cookie jar with no expiry is a credential nobody revokes.
 * A restore past the record's own deadline is refused and the record is
 * dropped, so the store does not accumulate live sessions indefinitely.
 */

/**
 * What Playwright hands back, narrowed to what is stored.
 *
 * Declared here rather than imported so `playwright-core` stays out of the
 * type surface, and validated on the way in: a backend that returned
 * something else should fail at the boundary rather than write an
 * unreadable record.
 */
export const storageStateSchema = z
  .object({
    cookies: z.array(z.looseObject({})),
    origins: z.array(z.looseObject({})),
  })
  .loose();
export type StorageState = z.infer<typeof storageStateSchema>;

const stateRecordSchema = z
  .strictObject({
    stateRef: browserStateRefSchema,
    tenant: z.string().min(1),
    subject: z.string().min(1),
    /**
     * The browser process the state came out of. Not a restriction on where
     * it may be restored - a saved session outliving its browser is the whole
     * point - but a reader deserves to know which generation produced it.
     */
    browserGeneration: z.string().min(1),
    /** The plan in force when it was saved, so evidence can be traced back. */
    effectivePlanDigest: z.string().min(1),
    /** The state itself. Encrypted at rest by the store's keyring. */
    state: storageStateSchema,
    /** How many origins it carries. Countable without reading the value. */
    origins: z.number().int().nonnegative(),
    createdAt: z.string().min(1),
    expiresAt: z.string().min(1),
  })
  .readonly();
export type BrowserStateRecord = z.infer<typeof stateRecordSchema>;

/** What a reader may be told about a saved state, which is never the state. */
export type BrowserStateSummary = Omit<BrowserStateRecord, "state">;

export class BrowserStateUnavailable extends Error {
  constructor(readonly reason: "unknown" | "expired" | "not-authorized") {
    super(`Saved browser state unavailable: ${reason}`);
    this.name = "BrowserStateUnavailable";
  }
}

export type BrowserStateStoreOptions = {
  store: AsyncCeremonyStore;
  now?: () => number;
  /** How long a saved state may be restored for. Defaults to one hour. */
  ttlMs?: number;
};

const key = (actor: ActorContext, stateRef: string) => ({
  tenant: actor.tenantId,
  kind: "browser-state" as const,
  id: stateRef,
});

export function createBrowserStateStore(options: BrowserStateStoreOptions) {
  const now = options.now ?? Date.now;
  const ttl = options.ttlMs ?? 3_600_000;

  const load = async (actor: ActorContext, stateRef: string) => {
    const stored = await options.store.transaction((tx) =>
      tx.get<BrowserStateRecord>(key(actor, stateRef)),
    );
    if (!stored) throw new BrowserStateUnavailable("unknown");
    const record = stateRecordSchema.parse(stored.value);
    // Same tenant is not the same person. The tenant is already in the key;
    // this is the second half, and without it a reference leaked between
    // colleagues would restore one of them into the other's session.
    if (record.subject !== actor.subjectId)
      throw new BrowserStateUnavailable("not-authorized");
    if (Date.parse(record.expiresAt) <= now()) {
      await options.store
        .transaction((tx) => tx.delete(key(actor, stateRef), stored.revision))
        .catch(() => {});
      throw new BrowserStateUnavailable("expired");
    }
    return record;
  };

  const api = {
    /** Keep a context's storage state, and answer with a reference to it. */
    async save(
      actor: ActorContext,
      input: { browserGeneration: string; effectivePlanDigest: string },
      state: StorageState,
    ): Promise<string> {
      const parsed = storageStateSchema.parse(state);
      const stateRef = mintReference("bstt");
      const at = now();
      const record: BrowserStateRecord = {
        stateRef,
        tenant: actor.tenantId,
        subject: actor.subjectId,
        browserGeneration: input.browserGeneration,
        effectivePlanDigest: input.effectivePlanDigest,
        state: parsed,
        origins: parsed.origins.length,
        createdAt: new Date(at).toISOString(),
        expiresAt: new Date(at + ttl).toISOString(),
      };
      await options.store.transaction((tx) =>
        tx.put(key(actor, stateRef), record, null),
      );
      return stateRef;
    },

    /**
     * A thunk the backend calls once, while creating a context.
     *
     * Deliberately not the value. Handing back a `StorageState` would put
     * somebody's cookies in whatever variable the caller happened to use, and
     * from there into a log line or an error message sooner or later. The
     * backend receives something it can only invoke, at the one moment it
     * legitimately needs the bytes.
     */
    restore(
      actor: ActorContext,
      stateRef: string,
    ): () => Promise<StorageState> {
      return async () => (await load(actor, stateRef)).state;
    },

    /** Everything about a saved state except the state. */
    async describe(
      actor: ActorContext,
      stateRef: string,
    ): Promise<BrowserStateSummary> {
      const { state: _state, ...summary } = await load(actor, stateRef);
      return summary;
    },

    /** Drop a saved state. A session nobody can restore is one nobody holds. */
    async forget(actor: ActorContext, stateRef: string): Promise<void> {
      const stored = await options.store.transaction((tx) =>
        tx.get<BrowserStateRecord>(key(actor, stateRef)),
      );
      if (!stored) return;
      const record = stateRecordSchema.parse(stored.value);
      if (record.subject !== actor.subjectId)
        throw new BrowserStateUnavailable("not-authorized");
      await options.store.transaction((tx) =>
        tx.delete(key(actor, stateRef), stored.revision),
      );
    },
  };

  /**
   * Where "the state for this login" is found again.
   *
   * The key is a digest of the subject and a caller-chosen slot, so the
   * pointer names nobody in the clear and one subject's slot can never resolve
   * to another's pointer. The pointer holds only a reference; the state stays
   * in its own record, under every rule above, and a pointer to a state that
   * has expired or been forgotten simply finds nothing.
   */
  const slotKey = (actor: ActorContext, slot: string) => ({
    tenant: actor.tenantId,
    kind: "browser-state" as const,
    id: `slot:${createHash("sha256")
      .update(JSON.stringify([actor.subjectId, slot]))
      .digest("hex")}`,
  });

  return {
    ...api,

    /**
     * Keep a state as *the* state for a slot, replacing whatever held it.
     *
     * The previous state is forgotten rather than left to expire: two live
     * cookie jars for one login is one more than anybody needs to hold.
     */
    async remember(
      actor: ActorContext,
      slot: string,
      input: { browserGeneration: string; effectivePlanDigest: string },
      state: StorageState,
    ): Promise<string> {
      const stateRef = await api.save(actor, input, state);
      const previous = await options.store.transaction(async (tx) => {
        const current = await tx.get<{ subject: string; stateRef: string }>(
          slotKey(actor, slot),
        );
        await tx.put(
          slotKey(actor, slot),
          { subject: actor.subjectId, stateRef },
          current?.revision ?? null,
        );
        return current?.value.stateRef;
      });
      if (previous && previous !== stateRef)
        await api.forget(actor, previous).catch(() => {});
      return stateRef;
    },

    /**
     * The restore thunk for a slot's state, or nothing when there is none
     * this actor may restore.
     *
     * Checked before the thunk is handed out, so an expired or foreign state
     * is an absent one — a caller starts a fresh context — rather than a
     * failure at context creation. The thunk still re-checks when called.
     */
    async recall(
      actor: ActorContext,
      slot: string,
    ): Promise<(() => Promise<StorageState>) | undefined> {
      const pointer = await options.store.transaction((tx) =>
        tx.get<{ subject: string; stateRef: string }>(slotKey(actor, slot)),
      );
      if (!pointer || pointer.value.subject !== actor.subjectId) return;
      try {
        await api.describe(actor, pointer.value.stateRef);
      } catch {
        return;
      }
      return api.restore(actor, pointer.value.stateRef);
    },
  };
}

export type BrowserStateStore = ReturnType<typeof createBrowserStateStore>;
