import { z } from "zod";
import {
  handoffRefSchema,
  mintReference,
  type BrowserOperationReason,
} from "../core/browser-session-contracts.js";
import type { HumanHandoffContract } from "../core/connector-contracts.js";
import type { ActorContext } from "../core/operation-contracts.js";
import { boundedText } from "./authorization.js";
import { AuthorizationError } from "./identity.js";
import type {
  HumanParticipation,
  HumanParticipationRequest,
  HumanParticipationResult,
} from "./browser-driver.js";
import type { AsyncCeremonyStore } from "./persistence/index.js";
import { safeLiveViewUrl } from "./live-view.js";

/**
 * A person's part in a browser login, kept where every process can see it.
 *
 * The login driver asks for a person through `HumanParticipation.request` and
 * waits for the answer in the same browser. Until now that wait lived only in
 * the memory of the process holding the browser: a person could answer only
 * through that process, and if it restarted the hand-off vanished with nobody
 * told why. This module keeps the hand-off in the store instead - tenant
 * scoped, bound to the subject who owns the login, encrypted at rest like
 * every record, and expiring - so:
 *
 * - **Any process can take the answer.** The human route reads and resolves
 *   the record; the process holding the browser polls it and resumes the
 *   same attempt in the same browser. Which process served the person does
 *   not matter.
 * - **Only the holder says "continuing".** An answer is recorded, and then
 *   picked up by the process holding the browser, which acknowledges it
 *   under the generation that created the record. A person is told the
 *   sign-in is continuing only after that acknowledgement.
 * - **A restart fails by name.** The waiting process heartbeats the record.
 *   An answer the holder never acknowledges - it arrived after the process
 *   stopped, however recently - is refused as `generation-mismatch` and the
 *   record is marked `lost`, instead of being accepted for a browser that no
 *   longer exists.
 * - **Expiry is enforced on both sides.** The waiter gives up at `expiresAt`
 *   and reports the person unavailable; a late answer is refused `expired`.
 *
 * What does *not* survive a restart is the browser itself - the page, its
 * cookies, the CDP connection - and so neither does the attempt that was
 * waiting in it. What survives is this record, which says the hand-off was
 * lost and why, and the login's own effect-ledger entry, which says whether
 * anything had been submitted (a replay of the same idempotency key answers
 * `indeterminate` rather than logging in twice). A person finds a named
 * outcome, never a hand-off that silently never completes.
 *
 * The record carries no credential and no page content: the reason, the
 * page's origin and path (never its query), and - when the host's browser
 * offers one - the provider's live-view URL, which controls the tab and so
 * is resolvable only through `controlUrl`, from an authenticated human route.
 */

/**
 * `answered` is an answer recorded and not yet picked up by the process
 * holding the browser; `completed` and `declined` mean it was picked up.
 */
export type BrowserHandoffStatus =
  "pending" | "answered" | "completed" | "declined" | "expired" | "lost";

const recordSchema = z.strictObject({
  schemaVersion: z.literal(1),
  handoffRef: handoffRefSchema,
  subject: z.string().min(1),
  reason: z.string().min(1).max(64),
  surface: z.string().min(1).max(64),
  recipient: z.string().min(1).max(64),
  /** Origin and pathname of the waiting page. Never the query. */
  path: z.string().max(2048),
  attempt: z.number().int().positive(),
  status: z.enum(["pending", "completed", "declined", "expired", "lost"]),
  /** Which process holds the browser, and when it last said so. */
  generation: z.string().min(1),
  heartbeatAt: z.number(),
  createdAt: z.number(),
  expiresAt: z.number(),
  /** The provider's takeover URL. Encrypted at rest; never summarised. */
  liveView: z.url().optional(),
  /**
   * Set by the holding process, under `generation`, when it has picked up a
   * `completed` or `declined` answer and the attempt has resumed or ended.
   */
  acknowledged: z.boolean().optional(),
});
type HandoffRecord = z.infer<typeof recordSchema>;

/** What a person, a route or a log may be told about a hand-off. */
export type BrowserHandoffSummary = {
  handoffRef: string;
  reason: string;
  surface: string;
  recipient: string;
  path: string;
  attempt: number;
  status: BrowserHandoffStatus;
  expiresAt: string;
  /** Whether a live view can be requested. Never the URL itself. */
  liveView: boolean;
};

export type BrowserHandoffResolution =
  | { status: "delivered" }
  | {
      status: "refused";
      reason: Extract<
        BrowserOperationReason,
        "not-authorized" | "expired" | "generation-mismatch" | "cancelled"
      >;
    };

export type BrowserHandoffsOptions = {
  store: AsyncCeremonyStore;
  now?: () => number;
  /** How long a person has to answer. Ten minutes, like the executor's. */
  ttlMs?: number;
  /** How often the waiting process reads the record. */
  pollMs?: number;
  /** How often the waiting process records that it is still there. */
  heartbeatMs?: number;
  /**
   * How long without a heartbeat before the waiter is presumed gone. Three
   * heartbeats by default: long enough that a busy process is not declared
   * dead, short enough that a person is not left waiting on a restart.
   */
  staleAfterMs?: number;
  /**
   * How long `resolve` waits for the holding process to acknowledge an
   * answer before declaring it gone. `staleAfterMs` by default.
   */
  acknowledgeWithinMs?: number;
  /** Swapped in tests. */
  sleep?: (ms: number) => Promise<void>;
};

const prefix = "browser-handoff:";
const key = (actor: ActorContext, handoffRef: string) => ({
  tenant: actor.tenantId,
  kind: "handoff" as const,
  id: `${prefix}${handoffRef}`,
});

export function createBrowserHandoffs(options: BrowserHandoffsOptions) {
  const now = options.now ?? Date.now;
  const ttl = options.ttlMs ?? 600_000;
  const pollMs = options.pollMs ?? 1_000;
  const heartbeatMs = options.heartbeatMs ?? 5_000;
  const staleAfter = options.staleAfterMs ?? heartbeatMs * 3;
  const acknowledgeWithin = options.acknowledgeWithinMs ?? staleAfter;
  const sleep =
    options.sleep ??
    ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  /** This process, as the holder of whichever browsers it is waiting in. */
  const generation = mintReference("bexec");

  const load = async (actor: ActorContext, handoffRef: string) => {
    if (!handoffRefSchema.safeParse(handoffRef).success) return undefined;
    const stored = await options.store.transaction((tx) =>
      tx.get<HandoffRecord>(key(actor, handoffRef)),
    );
    if (!stored) return undefined;
    const record = recordSchema.parse(stored.value);
    // The tenant is in the key; the subject is the other half. A reference
    // shared between colleagues resolves nothing for the wrong one.
    if (record.subject !== actor.subjectId) return undefined;
    return { record, revision: stored.revision };
  };

  /** The status a record has now, which is not always the one it was written with. */
  const effective = (record: HandoffRecord): BrowserHandoffStatus => {
    const stale = now() - record.heartbeatAt > staleAfter;
    if (record.status === "completed" || record.status === "declined") {
      if (record.acknowledged) return record.status;
      // Recorded, not picked up: whoever held the browser has not said so.
      return stale ? "lost" : "answered";
    }
    if (record.status !== "pending") return record.status;
    if (now() >= record.expiresAt) return "expired";
    if (stale) return "lost";
    return "pending";
  };

  const summarise = (record: HandoffRecord): BrowserHandoffSummary => ({
    handoffRef: record.handoffRef,
    reason: record.reason,
    surface: record.surface,
    recipient: record.recipient,
    path: record.path,
    attempt: record.attempt,
    status: effective(record),
    expiresAt: new Date(record.expiresAt).toISOString(),
    liveView: record.liveView !== undefined && effective(record) === "pending",
  });

  /**
   * Write a status, if the record is still what the writer last read and -
   * decided inside the same transaction - `when` still holds of it. Returns
   * the record as it stands afterwards, so a caller that lost a race learns
   * what won it.
   */
  const settle = async (
    actor: ActorContext,
    handoffRef: string,
    from: HandoffRecord["status"][],
    to: HandoffRecord["status"],
    patch: Partial<HandoffRecord> = {},
    when: (record: HandoffRecord) => boolean = () => true,
  ) =>
    options.store.transaction(async (tx) => {
      const stored = await tx.get<HandoffRecord>(key(actor, handoffRef));
      if (!stored) return undefined;
      const record = recordSchema.parse(stored.value);
      if (!from.includes(record.status) || !when(record)) return record;
      const next: HandoffRecord = { ...record, ...patch, status: to };
      // A settled hand-off keeps no control URL: nobody may take over a tab
      // this record no longer vouches for.
      if (to !== "pending") delete next.liveView;
      await tx.put(key(actor, handoffRef), next, stored.revision);
      return next;
    });

  return {
    generation,

    /**
     * A `HumanParticipation` for one actor's login, backed by this store.
     *
     * A host returns this from `BrowserLoginToolDeps.human`. `liveView`, when
     * the host's browser offers one, is asked once per request and kept only
     * in the encrypted record. `onRequested` is how the host tells the person
     * a hand-off exists - a notification, an email with a link to its human
     * route - and is given the summary, never the control URL.
     */
    participation(
      actor: ActorContext,
      input: {
        contract: HumanHandoffContract;
        maxRequests?: number;
        liveView?: () => Promise<string | undefined>;
        onRequested?: (summary: BrowserHandoffSummary) => unknown;
      },
    ): HumanParticipation {
      return {
        contract: input.contract,
        ...(input.maxRequests !== undefined
          ? { maxRequests: input.maxRequests }
          : {}),
        request: async (
          request: HumanParticipationRequest,
        ): Promise<HumanParticipationResult> => {
          const handoffRef = mintReference("bhof");
          const liveView = await input
            .liveView?.()
            // The same rule as every takeover URL: https, no userinfo.
            .then((url) => (url ? safeLiveViewUrl(url) : undefined))
            .catch(() => undefined);
          const at = now();
          const record: HandoffRecord = {
            schemaVersion: 1,
            handoffRef,
            subject: actor.subjectId,
            reason: request.reason,
            surface: request.surface,
            recipient: request.recipient,
            path: request.path,
            attempt: request.attempt,
            status: "pending",
            generation,
            heartbeatAt: at,
            createdAt: at,
            expiresAt: at + ttl,
            ...(liveView ? { liveView } : {}),
          };
          try {
            await options.store.transaction((tx) =>
              tx.put(key(actor, handoffRef), record, null),
            );
          } catch {
            // Nowhere to keep the hand-off is nobody to ask.
            return "unavailable";
          }
          await Promise.resolve(input.onRequested?.(summarise(record))).catch(
            () => {},
          );
          /**
           * Pick up a recorded answer: acknowledge it under this process's
           * generation, and act on it only if the acknowledgement is what the
           * record now says. A route that already gave up on this process
           * (and marked the hand-off lost) wins, and the attempt ends.
           */
          const pickUp = async (
            answer: "completed" | "declined",
          ): Promise<HumanParticipationResult> => {
            const after = await settle(
              actor,
              handoffRef,
              [answer],
              answer,
              { acknowledged: true },
              (record) => record.generation === generation,
            ).catch(() => undefined);
            return after?.status === answer && after.acknowledged
              ? answer
              : "unavailable";
          };
          const answered = (record: HandoffRecord) =>
            record.status === "completed" || record.status === "declined"
              ? record.status
              : undefined;
          let beat = at;
          for (;;) {
            await sleep(pollMs);
            const current = await load(actor, handoffRef).catch(
              () => undefined,
            );
            if (!current) return "unavailable";
            const { record: seen } = current;
            const answer = answered(seen);
            if (answer) return pickUp(answer);
            if (seen.status !== "pending") return "unavailable";
            if (now() >= seen.expiresAt) {
              // An answer that landed between the read and this write wins:
              // it was accepted, so it is honoured rather than dropped.
              const final = await settle(
                actor,
                handoffRef,
                ["pending"],
                "expired",
              ).catch(() => undefined);
              const late = final && answered(final);
              return late ? pickUp(late) : "unavailable";
            }
            if (now() - beat >= heartbeatMs) {
              beat = now();
              await settle(actor, handoffRef, ["pending"], "pending", {
                heartbeatAt: beat,
              }).catch(() => {});
            }
          }
        },
      };
    },

    /** Every hand-off this actor has waiting, for the human route's list. */
    async pending(actor: ActorContext): Promise<BrowserHandoffSummary[]> {
      const found: BrowserHandoffSummary[] = [];
      let after = prefix;
      for (;;) {
        const page = await options.store.transaction((tx) =>
          tx.list<HandoffRecord>(actor.tenantId, "handoff", 100, after),
        );
        for (const row of page) {
          if (!row.id.startsWith(prefix)) return found;
          const parsed = recordSchema.safeParse(row.value);
          if (
            parsed.success &&
            parsed.data.subject === actor.subjectId &&
            effective(parsed.data) === "pending"
          )
            found.push(summarise(parsed.data));
        }
        if (page.length < 100) return found;
        after = page.at(-1)!.id;
      }
    },

    async read(
      actor: ActorContext,
      handoffRef: string,
    ): Promise<BrowserHandoffSummary | undefined> {
      const found = await load(actor, handoffRef);
      return found && summarise(found.record);
    },

    /**
     * A person's answer, from whichever process served them.
     *
     * Delivered only to a hand-off that is still pending, unexpired and still
     * being waited on. Anything else is refused under its own name and the
     * record is settled accordingly, so the same answer given twice, too late
     * or after a restart is never mistaken for one that resumed a login.
     */
    async resolve(
      actor: ActorContext,
      handoffRef: string,
      answer: "completed" | "declined",
    ): Promise<BrowserHandoffResolution> {
      const found = await load(actor, handoffRef);
      if (!found) return { status: "refused", reason: "not-authorized" };
      const refusal = (
        status: BrowserHandoffStatus,
      ): BrowserHandoffResolution => ({
        status: "refused",
        reason:
          status === "expired"
            ? "expired"
            : status === "lost"
              ? "generation-mismatch"
              : "cancelled",
      });
      const status = effective(found.record);
      if (status === "expired" || status === "lost") {
        await settle(actor, handoffRef, ["pending"], status);
        return refusal(status);
      }
      if (status !== "pending") return refusal(status);
      // Expiry and staleness are decided again inside the write, so an
      // answer is never recorded for a hand-off that lapsed after the read.
      const settled = await settle(
        actor,
        handoffRef,
        ["pending"],
        answer,
        {},
        (record) => effective(record) === "pending",
      );
      if (settled?.status !== answer || settled.acknowledged)
        return refusal(settled ? effective(settled) : "lost");
      // Recorded. "Delivered" is the holder's to say: wait, bounded, for it
      // to pick the answer up. One that never does is gone, and the answer
      // is refused rather than reported as resuming anything.
      for (
        let waited = 0;
        waited < acknowledgeWithin;
        waited += Math.max(pollMs, 1)
      ) {
        await sleep(pollMs);
        const seen = await load(actor, handoffRef);
        if (seen?.record.acknowledged && seen.record.status === answer)
          return { status: "delivered" };
      }
      const after = await settle(
        actor,
        handoffRef,
        [answer],
        "lost",
        {},
        (record) => !record.acknowledged,
      );
      return after?.acknowledged && after.status === answer
        ? { status: "delivered" }
        : refusal("lost");
    },

    /**
     * The provider's takeover URL for a pending hand-off, or nothing. For an
     * authenticated human route to redirect to, and for nothing else.
     */
    async controlUrl(
      actor: ActorContext,
      handoffRef: string,
    ): Promise<string | undefined> {
      const found = await load(actor, handoffRef);
      if (!found || effective(found.record) !== "pending") return undefined;
      return found.record.liveView;
    },
  };
}

export type BrowserHandoffs = ReturnType<typeof createBrowserHandoffs>;

const escape = (text: string) =>
  text.replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ]!,
  );

const reasonText: Record<string, string> = {
  "human-challenge":
    "The provider is showing a challenge only a person can answer.",
  passkey: "The provider wants a passkey or security key.",
  "native-dialog": "The browser is showing a sign-in dialog.",
  "device-code":
    "The provider's device page wants the code shown on your device.",
  choice: "The provider needs a choice this login was not given.",
};

/**
 * The human route for durable hand-offs: a page a person opens to see what
 * is waiting, take over through a live view, and say they are done or
 * decline. A host mounts it behind its own authentication and passes the
 * authenticated actor; nothing in the request names who the person is.
 *
 * - `GET ?handoff=<ref>` shows the hand-off.
 * - `GET ?handoff=<ref>&live-view=1` redirects to the provider's live view,
 *   `no-store`, while the hand-off is pending - the only place the control
 *   URL ever leaves the store.
 * - `POST handoff=<ref>&answer=completed|declined` resolves it. Same-origin
 *   only, so a page elsewhere cannot answer on the person's behalf.
 */
export async function browserHandoffRoute(
  handoffs: BrowserHandoffs,
  actor: ActorContext,
  request: Request,
): Promise<Response> {
  const headers = {
    "cache-control": "no-store",
    "referrer-policy": "no-referrer",
    "x-content-type-options": "nosniff",
    "content-security-policy":
      "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'",
  };
  const page = (status: number, body: string) =>
    new Response(
      `<!doctype html><html lang="en"><meta charset="utf-8"><title>Sign-in needs you</title>${body}</html>`,
      {
        status,
        headers: { ...headers, "content-type": "text/html; charset=utf-8" },
      },
    );
  const url = new URL(request.url);
  if (request.method === "POST") {
    const sameOrigin =
      request.headers.get("origin") === url.origin ||
      request.headers.get("sec-fetch-site") === "same-origin";
    if (!sameOrigin) throw new AuthorizationError("denied");
    const form = new URLSearchParams(await boundedText(request, 4_096));
    const handoffRef = form.get("handoff") ?? "";
    const answer = form.get("answer");
    if (answer !== "completed" && answer !== "declined")
      throw new AuthorizationError("invalid_request");
    const resolved = await handoffs.resolve(actor, handoffRef, answer);
    if (resolved.status === "delivered") {
      const next = new URL(url);
      next.search = new URLSearchParams({ handoff: handoffRef }).toString();
      return new Response(null, {
        status: 303,
        headers: { ...headers, location: next.href },
      });
    }
    return page(
      409,
      `<h1>This sign-in can no longer continue</h1><p>${
        resolved.reason === "generation-mismatch"
          ? "The browser that was waiting for you is no longer running, so nothing you do here can resume it. Start the sign-in again."
          : resolved.reason === "expired"
            ? "It waited too long and has expired. Start the sign-in again."
            : "It has already been answered or is not yours to answer."
      }</p><p>Reason: <code>${escape(resolved.reason)}</code></p>`,
    );
  }
  if (request.method !== "GET") throw new AuthorizationError("invalid_request");
  const handoffRef = url.searchParams.get("handoff") ?? "";
  if (url.searchParams.has("live-view")) {
    const control = await handoffs.controlUrl(actor, handoffRef);
    return control
      ? new Response(null, {
          status: 303,
          headers: { ...headers, location: control },
        })
      : new Response("No live view is available for this sign-in", {
          status: 410,
          headers,
        });
  }
  const summary = await handoffs.read(actor, handoffRef);
  if (!summary) return page(404, "<h1>Nothing is waiting for you here</h1>");
  if (summary.status !== "pending")
    return page(
      200,
      `<h1>${
        summary.status === "completed"
          ? "Thanks - the sign-in is continuing"
          : summary.status === "answered"
            ? "Your answer is recorded; the sign-in has not picked it up yet"
            : summary.status === "declined"
              ? "You declined this sign-in"
              : summary.status === "expired"
                ? "This sign-in expired"
                : "The browser for this sign-in is no longer running"
      }</h1><p>Status: <code>${escape(summary.status)}</code></p>`,
    );
  const hidden = `<input type="hidden" name="handoff" value="${escape(summary.handoffRef)}">`;
  return page(
    200,
    `<h1>A sign-in needs you</h1>
    <p>${escape(reasonText[summary.reason] ?? "The provider needs a person to continue.")}</p>
    <p>Page: <code>${escape(summary.path)}</code>. Waiting until ${escape(summary.expiresAt)}.</p>
    ${summary.liveView ? `<p><a href="?handoff=${encodeURIComponent(summary.handoffRef)}&amp;live-view=1" target="_blank" rel="noopener noreferrer">Open the provider page in a live browser</a></p>` : ""}
    <p>Finishing here is a claim, not proof: the sign-in continues and is verified with the provider either way.</p>
    <form method="post">${hidden}<input type="hidden" name="answer" value="completed"><button>I'm done</button></form>
    <form method="post">${hidden}<input type="hidden" name="answer" value="declined"><button>Decline</button></form>`,
  );
}
