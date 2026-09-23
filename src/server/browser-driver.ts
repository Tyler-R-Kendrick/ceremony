import type { HumanHandoffContract } from "../core/connector-contracts.js";
import {
  checkboxConsent,
  consentCovers,
  deviceVerificationField,
  driverActionSchema,
  needsConsent,
  secretIssuedValueKinds,
  secretRoles,
  type BlockedReason,
  type CeremonyCallback,
  type CeremonyGoal,
  type CeremonyRole,
  type CeremonyStep,
  type CeremonyStepAction,
  type ConsentKind,
  type DriverAction,
  type HumanStepReason,
  type IssuedValueKind,
  type PageSnapshot,
  type SnapshotElement,
} from "../core/browser-contracts.js";
import type {
  CeremonyInterpreter,
  InterpreterInput,
} from "./browser-interpreter.js";
import {
  describePage,
  locateElement,
  matchesPage,
  type ElementFingerprint,
  type RecordedCeremony,
  type RecordedTraceEntry,
} from "../core/recorded-ceremony.js";
import { DispatchUncertain, StaleTargetError } from "./browser-targets.js";
export {
  humanStepReasons,
  type HumanStepReason,
} from "../core/browser-contracts.js";

/**
 * Drives one isolated-browser ceremony to a reported outcome.
 *
 * Everything an interpreter is not trusted with lives here: which origins may
 * receive a secret, which value a role resolves to, how many steps an attempt
 * may take, when a page has stopped changing, and what counts as evidence that
 * the ceremony finished. An attempt always terminates with a named outcome and
 * a value-free transcript; it never waits indefinitely for a page that will
 * not appear.
 */

/**
 * What a host is asked for. It carries no value and no secret: the person acts
 * where the ceremony already is, or through whatever the host's delegation
 * offers. `attempt` lets a host stop asking rather than prompt forever.
 *
 * This request is the one thing in an attempt that is *meant* to leave the
 * process. A host shows it to a person, puts it in a notification, writes it
 * to an activity log — so it is held to the same rule as a snapshot rather
 * than to the rule for something only the driver sees.
 *
 * That is why `path` is origin and pathname and the full URL is not here. The
 * driver already refuses to put a submission's URL in the effect ledger, for
 * exactly this reason: a query string carries authorization codes, login
 * hints, session identifiers and one-time tokens, and the same string that
 * tells a person which page to look at would carry all of it into wherever
 * the host displays it. A host that genuinely needs to navigate holds the
 * live page already and can ask it — see `CeremonyPage.url()`, which is
 * reachable only from something that can already drive the browser.
 */
export type HumanParticipationRequest = {
  reason: HumanStepReason;
  surface: HumanHandoffContract["surface"];
  recipient: HumanHandoffContract["recipient"];
  /** Origin and pathname of the page awaiting a person. Never the query. */
  path: string;
  attempt: number;
};

/**
 * `completed` means the person says they finished, which is a claim to check,
 * not a grant: the driver resumes and re-reads the page, and completion still
 * needs provider evidence. `declined` is a refusal. `unavailable` means no
 * person could be reached at all.
 */
export type HumanParticipationResult = "completed" | "declined" | "unavailable";

export interface HumanParticipation {
  /** The connector's declared participation policy. */
  contract: HumanHandoffContract;
  request(input: HumanParticipationRequest): Promise<HumanParticipationResult>;
  /** How many times one attempt may ask a person. Defaults to 2. */
  maxRequests?: number;
}

/** The browser surface the driver needs. Adapters supply real pages. */
export interface CeremonyPage {
  url(): Promise<string>;
  goto(url: string): Promise<void>;
  snapshot(): Promise<PageSnapshot>;
  fill(element: SnapshotElement, value: string): Promise<void>;
  click(element: SnapshotElement): Promise<void>;
  check(element: SnapshotElement): Promise<void>;
  /**
   * Choose the option a `<select>` shows under this visible label. Held to
   * the same revalidation as `fill`: the observed control on the observed
   * document, or a refusal. Optional, so an adapter that cannot choose simply
   * does not, and a `select` proposal is then an unusable one.
   */
  select?(element: SnapshotElement, option: string): Promise<void>;
  /** Wait for navigation or in-page updates to quiesce, bounded by the adapter. */
  settle(): Promise<void>;
  /**
   * The origin a click on this control would submit to, or `undefined` when it
   * submits nothing. Answered from the observation the caller approved, not
   * from the live page, and an origin rather than a URL because a form action
   * can carry an identifier or a token in its query string.
   *
   * Optional: an adapter that cannot tell simply does not implement it, and the
   * driver then reports no dispatches rather than inventing them.
   */
  submissionTarget?(element: SnapshotElement): Promise<string | undefined>;
  /**
   * The last response's status and `WWW-Authenticate` header, when the adapter
   * can see them. A 401 challenge has no page to fill, so it is only visible
   * here.
   */
  response?(): Promise<{ status: number; authenticate?: string } | undefined>;
  /**
   * Give the browser credentials for an origin's HTTP authentication dialog,
   * as a person typing into that dialog would. The driver never calls this:
   * it exists so a human handoff can answer a challenge that has no page.
   */
  authenticate?(
    origin: string,
    credentials: { username: string; password: string },
  ): Promise<void>;
  /**
   * The value an observed read-only field displays, or `undefined` when the
   * control is not one. Revalidated against the observation exactly as an
   * action is, so it reads the field that was observed or refuses.
   *
   * The driver calls this only for a field whose label a plan named in
   * `issued`, and the value goes to that plan's sink and nowhere else.
   * Optional: an adapter without it cannot keep an issued value, and a plan
   * that declares one then never completes on it.
   */
  readIssued?(element: SnapshotElement): Promise<string | undefined>;
}

/** Issued values by kind, as the driver hands them to a plan's sink. */
export type IssuedValues = Readonly<Partial<Record<IssuedValueKind, string>>>;

/**
 * Resolves a role to a value. A verification code normally resolves by waiting
 * on a mailbox, so resolution is asynchronous and may fail.
 */
export interface CeremonySecrets {
  readonly roles: readonly CeremonyRole[];
  resolve(role: CeremonyRole): Promise<string | undefined>;
}

export type CeremonyOutcome =
  | { status: "completed"; steps: number; callback?: CeremonyCallback }
  | { status: "blocked"; reason: BlockedReason; steps: number }
  | { status: "exhausted"; steps: number }
  | { status: "stalled"; steps: number }
  /** Completion was claimed but no evidence confirmed it. */
  | { status: "unverified"; steps: number }
  /**
   * Something was dispatched and where it went is not known. Distinct from
   * every `blocked` reason, all of which mean the step did not happen: a caller
   * may retry a refusal and must not retry this.
   */
  | { status: "indeterminate"; steps: number };

export type CeremonyResult = CeremonyOutcome & {
  /** Ordered, value-free record of what the attempt did. Safe to persist. */
  transcript: readonly CeremonyStep[];
  /** How many times a person was asked to take part. */
  handoffs: number;
};

export interface CeremonyRunOptions {
  page: CeremonyPage;
  interpreter: CeremonyInterpreter;
  goal: CeremonyGoal;
  secrets: CeremonySecrets;
  /** Origins where the driver may act at all, and type a secret. */
  allowedOrigins: readonly string[];
  /**
   * Called immediately *before* a click that submits a form, never after.
   *
   * The ordering is the whole point. A caller records the intent to dispatch,
   * and if this process dies during the click the record survives saying a
   * submission may have gone out — which is exactly the case that used to be
   * reported as "nothing happened, safe to retry". A callback that throws stops
   * the attempt before the click, so a ledger that cannot record cannot be
   * bypassed by proceeding anyway.
   */
  onDispatch?: (info: { destination: string }) => Promise<void> | void;
  /**
   * Redirect target that ends an authorization ceremony. Reaching it captures
   * the code from the browser; the code never enters a snapshot or a prompt.
   */
  redirectUri?: string;
  /**
   * A confirmation link delivered out of band, normally by a mailbox binding.
   * The driver follows it only when the page is waiting and the link stays on
   * an allowed origin; an interpreter can neither see nor choose the address.
   */
  confirmationLink?: () => Promise<string | undefined>;
  /**
   * How a person is brought into a step the browser cannot complete. Without
   * it, such a step ends the attempt by name instead of hanging, which is the
   * correct behaviour for a host that has nobody to ask.
   */
  human?: HumanParticipation;
  /**
   * Provider-side confirmation that access exists. Without it a "done" claim
   * cannot be accepted, matching the rule that only verification completes a
   * ceremony.
   */
  verify?: () => Promise<boolean>;
  maxSteps?: number;
  /** Consecutive unchanged pages after an applied action before stopping. */
  stallLimit?: number;
  /** Extra values that must never reach the interpreter or a transcript. */
  protectedValues?: readonly string[];
  /**
   * Values the provider issues on a page and this plan keeps, such as an
   * OAuth client's ID and secret on a developer settings page.
   *
   * `fields` names, for each kind, the exact label of the read-only field
   * that displays it. The plan declares this, not the interpreter: an
   * interpreter never learns a value was read, cannot point the driver at a
   * field, and cannot name one. Each observation on an allowed origin is
   * checked for exactly one input carrying each declared label; a label that
   * matches twice identifies nothing, and a page that does not show every
   * declared field is not read at all.
   *
   * Once every declared value has been read from one page, `keep` receives
   * them, once. A secret kind is guarded from that moment like a typed
   * password, so a later snapshot or note reproducing it fails the attempt.
   * The values are never in the result, the transcript or anything the
   * interpreter is given; the transcript records a `kept` step naming the
   * kinds. While any declared
   * value is still unread, a claim of completion is not accepted.
   */
  issued?: {
    fields: Readonly<Partial<Record<IssuedValueKind, string>>>;
    keep(values: IssuedValues): Promise<void>;
  };
  /**
   * Choices the plan makes, by the exact label of the `<select>` they are
   * for: `{ "Country or region": "Canada" }`. Both sides are text the page
   * shows, so neither is a secret. A `select` on a field named here must
   * choose exactly this option; on any other field it must choose an option
   * the observation listed. A required choice with no entry here is a
   * person's to make.
   */
  choices?: Readonly<Record<string, string>>;
  /**
   * The person's advance consent: which kinds of legal box - terms, privacy
   * policy, age - this attempt may tick on their behalf. From the plan, never
   * from an interpreter.
   *
   * Every `check` an interpreter proposes is read against it here, whoever
   * proposed it: a box that accepts terms, a privacy policy or an age
   * attestation the person did not consent to is handed to a person to tick
   * (`consent`), or ends the attempt as `consent-required` with nobody to
   * ask. A marketing or newsletter opt-in is never ticked, consent or not.
   */
  consents?: readonly ConsentKind[];
  onStep?: (step: CeremonyStep) => void;
  /**
   * Called once an action has actually taken effect, with the observation it
   * was decided on. This is the recording seam: a refused, re-read or
   * unusable proposal never reaches it, so what it sees is the procedure and
   * not the attempts at one.
   *
   * The observation is the same sanitized snapshot the interpreter was given
   * — already checked against every protected value before the interpreter
   * saw it — and the entry carries a role, never the value it resolved to.
   */
  onApplied?: (entry: RecordedTraceEntry) => void;
}

/** What a step needing a person ends as, when no person takes it. */
const fallbackFor: Readonly<Record<HumanStepReason, BlockedReason>> = {
  "human-challenge": "human-challenge",
  passkey: "passkey-required",
  "native-dialog": "native-dialog",
  "device-code": "device-code-required",
  choice: "choice-required",
  consent: "consent-required",
};

const defaultMaxSteps = 24;
const defaultStallLimit = 3;

function originOf(url: string): string {
  try {
    return new URL(url).origin;
  } catch {
    return "";
  }
}

/**
 * An adapter refusing to act on something that moved is a named outcome, not a
 * crash. The page changing under an attempt is ordinary — a provider redirects,
 * a single-page app re-renders, a framework replaces an input while a model is
 * still deciding what to do with the old one — and the correct response is to
 * stop and say which thing moved, never to act on whatever is there instead.
 */
function refusalReason(error: unknown): BlockedReason | undefined {
  if (!(error instanceof StaleTargetError)) return undefined;
  return error.reason === "target-unavailable"
    ? "provider-error"
    : error.reason;
}

/**
 * Identity of what the user can currently see and do. Two consecutive applied
 * actions producing the same fingerprint mean the attempt is not progressing.
 */
function fingerprint(snapshot: PageSnapshot): string {
  return JSON.stringify([
    snapshot.path,
    snapshot.alerts,
    snapshot.elements.map((element) => [
      element.kind,
      element.name ?? element.text ?? element.label ?? "",
      element.filled ?? false,
    ]),
  ]);
}

function redact(text: string, values: readonly string[]): string {
  return values.reduce(
    (current, value) =>
      value.length >= 4 ? current.split(value).join("[redacted]") : current,
    text,
  );
}

function contains(haystack: string, values: readonly string[]): boolean {
  return values.some((value) => value.length >= 4 && haystack.includes(value));
}

export class CeremonySecretLeak extends Error {
  constructor(readonly surface: string) {
    super(`A protected value reached ${surface}`);
    this.name = "CeremonySecretLeak";
  }
}

/**
 * A fixed set of values, the usual source outside tests being a private
 * collector and a mailbox binding for `verification-code`.
 */
export function createSecrets(
  values: Partial<Record<CeremonyRole, string | (() => Promise<string>)>>,
): CeremonySecrets {
  const roles = Object.keys(values) as CeremonyRole[];
  return {
    roles,
    resolve: async (role) => {
      const entry = values[role];
      if (entry === undefined) return undefined;
      return typeof entry === "function" ? await entry() : entry;
    },
  };
}

export async function runCeremony(
  options: CeremonyRunOptions,
): Promise<CeremonyResult> {
  const {
    page,
    interpreter,
    goal,
    secrets,
    allowedOrigins,
    maxSteps = defaultMaxSteps,
    stallLimit = defaultStallLimit,
  } = options;
  const allowed = new Set(allowedOrigins.map((origin) => originOf(origin)));
  if (allowed.size === 0 || allowed.has(""))
    throw new Error("A ceremony requires at least one allowed origin");
  const transcript: CeremonyStep[] = [];
  const history: { action: string; note?: string; path?: string }[] = [];
  /** Values actually substituted into the page, plus any caller-declared ones. */
  const guarded: string[] = [...(options.protectedValues ?? [])];
  let steps = 0;
  let unchanged = 0;
  let refusals = 0;
  /** Consecutive times the page moved on under an approval. */
  let moved = 0;
  let unverifiedClaims = 0;
  let previous = "";
  let followed: string | undefined;
  let handoffs = 0;
  const maxHandoffs = options.human?.maxRequests ?? 2;
  /** The issued values the plan declared, and whether they are in hand. */
  const declared = Object.entries(options.issued?.fields ?? {}) as [
    IssuedValueKind,
    string,
  ][];
  let kept = declared.length === 0;

  const record = (
    snapshot: PageSnapshot,
    action: CeremonyStepAction,
    extra: {
      role?: CeremonyRole;
      reason?: BlockedReason;
      note?: string;
      consent?: readonly ConsentKind[];
      /**
       * Whether the interpreter should see this step. Everything it *did* to
       * the page belongs in its history; a re-read is not something it did,
       * and its `wait` heuristic reads the last entry, so recording one there
       * would change the next proposal for a reason that has nothing to do
       * with the page.
       */
      remembered?: boolean;
    } = {},
  ) => {
    const step: CeremonyStep = { path: snapshot.path, action };
    if (extra.role) step.role = extra.role;
    if (extra.reason) step.reason = extra.reason;
    if (extra.note) step.note = redact(extra.note, guarded);
    if (extra.consent) step.consent = [...extra.consent];
    transcript.push(step);
    // The document goes into the history too. An interpreter asking "have I
    // tried this already?" has to be able to tell one page's button from
    // another's with the same label, and a label is not an identity.
    if (extra.remembered !== false)
      history.push(
        step.note
          ? { action, note: step.note, path: step.path }
          : { action, path: step.path },
      );
    options.onStep?.(step);
  };
  const finish = (outcome: CeremonyOutcome): CeremonyResult => ({
    ...outcome,
    transcript,
    handoffs,
  });

  /**
   * Whether a refusal is one to read the page again over rather than give up
   * on.
   *
   * `stale-document` says the page was replaced between the observation that
   * approved something and the use of that observation. The guard did its
   * job: nothing was typed, nothing was sent, and the approval is gone. But
   * ending the attempt there throws away a login that may have *just
   * succeeded* — a submit whose navigation commits after the read that
   * followed it produces exactly this, and the page waiting to be read is the
   * signed-in one. Re-reading is already how this driver copes with a
   * document changing; AUTH-IDENTIFIER depends on it. The only reason a race
   * was fatal is that the change landed inside the window between the read
   * and the action, and nothing looked again.
   *
   * Looking again is not a weaker check. The new observation is read,
   * approved and origin-checked from scratch, and every recipient rule is
   * applied to it, so a page that really was swapped by someone hostile is
   * refused on its own merits rather than on a memory of the page before it.
   *
   * Bounded, because a page that keeps moving cannot be driven and re-reading
   * it forever would turn a refusal into a spin. The second move in a row
   * ends the attempt under the name it would have carried immediately, so
   * nothing is hidden — only retried once.
   *
   * Only this reason. `stale-element` means the control was replaced inside a
   * document that stayed and `unapproved-recipient` means the form was
   * re-pointed; both are a page rearranging itself under an approval rather
   * than replacing itself, and both stay terminal.
   */
  const rereadable = (reason: BlockedReason): boolean =>
    reason === "stale-document" && ++moved < 2;

  /**
   * Read the page, tolerating the one thing that legitimately stops a read: the
   * browser or tab going away. A fresh observation after an action is expected
   * to describe a *different* document — that is what the action was for — so
   * only an unreadable page ends the attempt here.
   *
   * A read that failed *because* the page moved under it is the one case with
   * nothing to report and nothing to undo: no snapshot was produced, so there
   * is no document to name in the transcript, and reading again is the whole
   * remedy. It is counted against the same budget as a refused action, so a
   * page thrashing is bounded however the driver notices.
   */
  const observe = async (): Promise<
    { snapshot: PageSnapshot } | { blocked: CeremonyResult }
  > => {
    for (;;) {
      try {
        return { snapshot: await page.snapshot() };
      } catch (error) {
        const reason = refusalReason(error);
        if (reason === undefined) throw error;
        if (!rereadable(reason))
          return { blocked: finish({ status: "blocked", reason, steps }) };
        steps++;
        if (steps >= maxSteps)
          return { blocked: finish({ status: "exhausted", steps }) };
      }
    }
  };

  /**
   * Bring a person into a step the browser cannot complete. The declared
   * handoff contract says where they act and who they are; the request names
   * the page by origin and pathname, and a host that drives the browser holds
   * the live page already. A person's "done" is a claim: the attempt resumes
   * and re-reads the page, and completion still requires the same provider
   * evidence it always did.
   */
  const handOff = async (
    snapshot: PageSnapshot,
    reason: HumanStepReason,
  ): Promise<BlockedReason | undefined> => {
    const fallback = fallbackFor[reason];
    if (!options.human || handoffs >= maxHandoffs) return fallback;
    record(snapshot, "handoff", { reason: fallback });
    handoffs++;
    const outcome = await options.human.request({
      reason,
      surface: options.human.contract.surface,
      recipient: options.human.contract.recipient,
      // The observation's own path, which is already origin and pathname.
      // Taking it from here rather than re-deriving it from the live URL is
      // deliberate: there is then no place in this function where the query
      // string exists at all, so no later edit can reintroduce it by
      // forgetting to strip something.
      path: snapshot.path,
      attempt: handoffs,
    });
    if (outcome === "declined") return "human-declined";
    if (outcome === "unavailable") return fallback;
    return undefined;
  };

  /**
   * Read the issued values the plan declared from the page in front of the
   * attempt, and hand them to the plan's sink.
   *
   * This is driven by the plan and by nothing an interpreter says: it runs on
   * every observation on an allowed origin, looks only for inputs whose label
   * is exactly one the plan named, and reads a field only when exactly one
   * matches. The adapter reads a value only from a read-only control the
   * observation still describes, so neither a field the driver filled nor one
   * that moved since the read can be taken for an issued value.
   *
   * Every declared value comes from one page or none does. A client ID read on
   * one page and a secret on another need not belong to the same client, and
   * the page that reveals a secret shows the client it belongs to.
   *
   * It runs before the interpreter sees this snapshot, and a secret joins the
   * guarded values the moment it is read, so a provider that also printed it
   * into a heading or an alert on the same page fails the attempt as a leak
   * rather than delivering it to the interpreter.
   */
  const collectIssued = async (snapshot: PageSnapshot): Promise<void> => {
    if (kept || !options.issued || !page.readIssued) return;
    const fields = declared.map(([kind, label]) => {
      const matches = snapshot.elements.filter(
        (element) => element.kind === "input" && element.label === label,
      );
      return { kind, field: matches.length === 1 ? matches[0] : undefined };
    });
    if (fields.some(({ field }) => !field)) return;
    const issued = new Map<IssuedValueKind, string>();
    for (const { kind, field } of fields) {
      let value: string | undefined;
      try {
        value = await page.readIssued(field!);
      } catch (error) {
        // The page moved since it was read: nothing is taken from it, and
        // the next observation looks again.
        if (error instanceof StaleTargetError) return;
        throw error;
      }
      const secret = secretIssuedValueKinds.includes(kind);
      // A secret too short to recognise could not be guarded afterwards, so
      // it is not one this driver will carry.
      if (!value || value.length > 4096 || (secret && value.length < 8)) return;
      issued.set(kind, value);
      if (secret && !guarded.includes(value)) guarded.push(value);
    }
    await options.issued.keep(Object.fromEntries(issued) as IssuedValues);
    kept = true;
    record(snapshot, "kept", {
      note: declared.map(([kind]) => kind).join(", "),
      remembered: false,
    });
  };

  /**
   * Whether this is the callback the ceremony is waiting for. Compared by
   * origin and path, never by prefix: `/callbackx` shares a prefix with
   * `/callback` and is a different endpoint, so a prefix test would accept a
   * code from somewhere the ceremony never nominated.
   */
  const isCallback = (current: string): boolean => {
    if (!options.redirectUri) return false;
    try {
      const arrived = new URL(current);
      const expected = new URL(options.redirectUri);
      return (
        arrived.origin === expected.origin &&
        arrived.pathname === expected.pathname
      );
    } catch {
      return false;
    }
  };

  async function applyElementAction(
    action: DriverAction,
    snapshot: PageSnapshot,
    url: string,
  ): Promise<CeremonyResult | undefined> {
    /**
     * The one ending shared by every action the adapter refused.
     *
     * Returning `undefined` is this function's "carry on", and carrying on is
     * what a re-readable refusal asks for: the main loop's next thing is to
     * read the page, which is precisely the remedy. A refusal that is not
     * re-readable ends the attempt under its own name, as before.
     */
    const refused = (error: unknown): CeremonyResult | undefined => {
      const reason = refusalReason(error);
      if (reason === undefined) throw error;
      // Reading the page again is always safe. *Acting* again on what is read
      // is not, if the refused action had already begun: a click that threw
      // while the page was being replaced may still have sent the submission
      // it was for, and nothing here can tell. That one ends the attempt, as
      // it did before - uncertainty is never rewritten into something more
      // retryable.
      const begun = error instanceof StaleTargetError && error.begun;
      if (!begun && rereadable(reason)) {
        record(snapshot, "reobserve", { reason, remembered: false });
        steps++;
        return undefined;
      }
      record(snapshot, "blocked", { reason });
      return finish({ status: "blocked", reason, steps });
    };
    /**
     * A proposal that names something this page cannot take. Discarded, and
     * two in a row mean the surface is not one this attempt can drive.
     */
    const unusable = (): CeremonyResult | undefined => {
      steps++;
      if (++refusals >= 2) {
        record(snapshot, "blocked", { reason: "unsupported-page" });
        return finish({ status: "blocked", reason: "unsupported-page", steps });
      }
      return undefined;
    };
    const element =
      action.element === undefined
        ? undefined
        : snapshot.elements[action.element];
    if (!element) return unusable();

    if (action.action === "fill") {
      const role = action.role;
      // A role the caller never supplied is as unusable as a missing element:
      // the value is never resolved, and the attempt says so rather than
      // spending its whole budget re-asking. So is a secret aimed at a
      // `<select>`: choosing the option that equals a password would put the
      // password in the form under a label nobody reviewed.
      if (
        !role ||
        !secrets.roles.includes(role) ||
        (element.kind === "select" && secretRoles.includes(role))
      )
        return unusable();
      // A permitted page can still hand a secret to a third party. Refuse the
      // entry rather than the navigation: by then the value is already sent.
      if (
        secretRoles.includes(role) &&
        (!allowed.has(originOf(url)) ||
          (element.submitsTo !== undefined &&
            !allowed.has(originOf(element.submitsTo))))
      )
        return finish({ status: "blocked", reason: "untrusted-origin", steps });
      const value = await secrets.resolve(role);
      if (value === undefined) {
        // A mailbox that never delivered is a reportable wall, not a retry loop.
        record(snapshot, "blocked", { reason: "provider-error" });
        return finish({ status: "blocked", reason: "provider-error", steps });
      }
      if (secretRoles.includes(role) && !guarded.includes(value))
        guarded.push(value);
      // The adapter revalidates the element and its destination here, after the
      // credential lookup that just awaited. A refusal at this point means the
      // page moved while the value was being fetched, so nothing is filled.
      try {
        await page.fill(element, value);
      } catch (error) {
        return refused(error);
      }
      record(snapshot, "fill", {
        role,
        ...(action.note ? { note: action.note } : {}),
      });
      options.onApplied?.({
        snapshot,
        action: "fill",
        element: element.index,
        role,
      });
    } else if (action.action === "check") {
      // Ticking a box that accepts terms, a privacy policy or an age
      // attestation is a legal act, and the plan's advance consent is the
      // only thing that lets anyone but the person perform it. Read here, on
      // the box itself, rather than trusted to the interpreter's reading of
      // it: a model that takes "I agree to the Terms" for an ordinary box
      // still cannot tick it. Without consent a person ticks it - or leaves
      // it - and the attempt reads the page again either way.
      const consent = checkboxConsent(element);
      // An optional opt-in is simply left alone: nobody needs asking about a
      // newsletter the form does not require.
      if (consent.marketing && element.required !== true) return unusable();
      if (
        needsConsent(consent) &&
        !consentCovers(consent, options.consents ?? [])
      ) {
        const declined = await handOff(snapshot, "consent");
        if (declined) {
          record(snapshot, "blocked", { reason: declined });
          return finish({ status: "blocked", reason: declined, steps });
        }
        refusals = 0;
        await page.settle();
        steps++;
        return;
      }
      try {
        await page.check(element);
      } catch (error) {
        return refused(error);
      }
      record(snapshot, "check", {
        ...(action.note ? { note: action.note } : {}),
        ...(consent.kinds.length ? { consent: consent.kinds } : {}),
      });
      options.onApplied?.({
        snapshot,
        action: "check",
        element: element.index,
        ...(consent.kinds.length ? { consent: consent.kinds } : {}),
      });
    } else if (action.action === "select") {
      // An option is chosen by the label the page shows. Where the plan named
      // the choice for this field, that is the only option it may be - and
      // it may be chosen even past the snapshot's first twenty options, since
      // a country list is longer than that and the plan, not the
      // interpreter, wrote it. Anything else must be an option the
      // observation listed: an interpreter cannot type free text into a
      // choice. The adapter refuses a label the live control does not offer.
      // A guarded value cannot be among the listed options - the snapshot
      // carrying it would already have failed the attempt - and the check
      // below says so rather than relying on it.
      const option = action.option;
      const planned =
        element.label === undefined
          ? undefined
          : options.choices?.[element.label];
      if (
        element.kind !== "select" ||
        !page.select ||
        option === undefined ||
        (planned !== undefined
          ? planned !== option
          : !(element.options ?? []).includes(option))
      )
        return unusable();
      if (contains(option, guarded))
        throw new CeremonySecretLeak("a chosen option");
      try {
        await page.select(element, option);
      } catch (error) {
        return refused(error);
      }
      record(snapshot, "select", action.note ? { note: action.note } : {});
      options.onApplied?.({
        snapshot,
        action: "select",
        element: element.index,
        option,
      });
    } else {
      // A control that belongs to a form is the only thing here that can change
      // the provider's state, so it is the only thing announced. Clicking a
      // link or an in-page toggle sends nothing and is not an effect.
      const destination = options.onDispatch
        ? await page.submissionTarget?.(element)
        : undefined;
      if (destination !== undefined)
        await options.onDispatch?.({ destination });
      try {
        await page.click(element);
      } catch (error) {
        if (error instanceof DispatchUncertain) {
          record(snapshot, "blocked", { reason: "provider-error" });
          return finish({ status: "indeterminate", steps });
        }
        return refused(error);
      }
      record(snapshot, "click", action.note ? { note: action.note } : {});
      options.onApplied?.({
        snapshot,
        action: "click",
        element: element.index,
      });
    }

    refusals = 0;
    // An action that landed means the page in front of the attempt is one it
    // can act on, so whatever moved before this is behind it. The budget
    // counts documents moving *in a row*, not over a whole login: a flow that
    // legitimately redirects twice is not a page thrashing.
    moved = 0;
    await page.settle();
    steps++;
    const observed = await observe();
    if ("blocked" in observed) return observed.blocked;
    const current = fingerprint(observed.snapshot);
    if (current === previous) {
      if (++unchanged >= stallLimit)
        return finish({ status: "stalled", steps });
    } else unchanged = 0;
    previous = current;
  }

  /**
   * Whether an interpreter's "a person has to do this" names a step a person
   * can do here, checked against the page rather than taken on its word.
   *
   * A device verification page needs a person only when this plan was not
   * given the user code - with it, the page is an ordinary form. A missing
   * choice needs one only where a `<select>` is actually waiting for one.
   */
  const personStep = (
    reason: BlockedReason,
    snapshot: PageSnapshot,
  ): HumanStepReason | undefined => {
    if (
      reason === "device-code-required" &&
      !secrets.roles.includes("user-code") &&
      deviceVerificationField(snapshot)
    )
      return "device-code";
    if (
      reason === "choice-required" &&
      snapshot.elements.some(
        (element) => element.kind === "select" && element.filled !== true,
      )
    )
      return "choice";
    if (
      reason === "consent-required" &&
      snapshot.elements.some(
        (element) =>
          element.kind === "checkbox" &&
          element.filled !== true &&
          needsConsent(checkboxConsent(element)),
      )
    )
      return "consent";
    return undefined;
  };

  async function driveSnapshot(
    snapshot: PageSnapshot,
    url: string,
  ): Promise<CeremonyResult | undefined> {
    const serialized = JSON.stringify(snapshot);
    if (contains(serialized, guarded))
      throw new CeremonySecretLeak("a page snapshot");

    const input: InterpreterInput = {
      goal,
      snapshot,
      available: secrets.roles,
      history: history.slice(-8),
      // Labels only, which the page shows anyway. What was read, and whether
      // anything has been, stays here.
      ...(declared.length > 0
        ? { issuedLabels: declared.map(([, label]) => label) }
        : {}),
      ...(options.choices ? { choices: options.choices } : {}),
      ...(options.consents?.length ? { consents: options.consents } : {}),
    };
    const proposed = await interpreter(input);
    const parsed = proposed
      ? driverActionSchema.safeParse(proposed)
      : undefined;
    if (!parsed?.success) {
      // Two consecutive unusable proposals mean this surface is not supported.
      if (++refusals >= 2) {
        record(snapshot, "blocked", { reason: "unsupported-page" });
        return finish({ status: "blocked", reason: "unsupported-page", steps });
      }
      steps++;
      return;
    }
    const action = parsed.data;
    if (action.note && contains(action.note, guarded))
      throw new CeremonySecretLeak("an interpreter note");

    // Reaching here means the proposal is structurally usable.
    if (action.action === "blocked") {
      const reason = action.reason ?? "unsupported-page";
      // Two walls a person can get past in this same browser. Asking a
      // person stays the driver's decision: the report is only acted on when
      // this page really is what it names, and the budget and the person's
      // answer are the same as for any other handoff.
      const person = personStep(reason, snapshot);
      if (person) {
        const refused = await handOff(snapshot, person);
        if (refused) {
          record(snapshot, "blocked", { reason: refused });
          return finish({ status: "blocked", reason: refused, steps });
        }
        refusals = 0;
        await page.settle();
        steps++;
        return;
      }
      record(snapshot, "blocked", {
        reason,
        ...(action.note ? { note: action.note } : {}),
      });
      return finish({ status: "blocked", reason, steps });
    }
    if (action.action === "done") {
      refusals = 0;
      record(snapshot, "done", action.note ? { note: action.note } : {});
      options.onApplied?.({ snapshot, action: "done" });
      // A declared issued value still unread means the thing the plan came
      // for is not in hand, whatever the page says.
      if (kept && options.verify && (await options.verify()))
        return finish({ status: "completed", steps });
      if (++unverifiedClaims >= 2)
        return finish({ status: "unverified", steps });
      steps++;
      return;
    }
    if (action.action === "wait") {
      refusals = 0;
      record(snapshot, "wait", action.note ? { note: action.note } : {});
      options.onApplied?.({ snapshot, action: "wait" });
      const link = await options.confirmationLink?.();
      if (link && allowed.has(originOf(link)) && link !== followed) {
        followed = link;
        await page.goto(link);
      } else await page.settle();
      steps++;
      const observed = await observe();
      if ("blocked" in observed) return observed.blocked;
      const settled = fingerprint(observed.snapshot);
      if (settled === previous) {
        if (++unchanged >= stallLimit)
          return finish({ status: "stalled", steps });
      } else unchanged = 0;
      previous = settled;
      return;
    }

    return applyElementAction(action, snapshot, url);
  }

  while (steps < maxSteps) {
    const url = await page.url();
    if (isCallback(url)) {
      const parsed = new URL(url);
      const code = parsed.searchParams.get("code");
      const error = parsed.searchParams.get("error");
      if (error)
        return finish({
          status: "blocked",
          reason:
            error === "access_denied" ? "consent-denied" : "provider-error",
          steps,
        });
      if (code) {
        const state = parsed.searchParams.get("state");
        const callback: CeremonyCallback = { code };
        if (state !== null) callback.state = state;
        return finish({ status: "completed", steps, callback });
      }
    }
    if (!allowed.has(originOf(url)))
      return finish({ status: "blocked", reason: "untrusted-origin", steps });

    // A 401 has no form to fill: the credentials go to a browser dialog, which
    // only a person can answer. It is visible in the response, not the page.
    const response = await page.response?.();
    const dialog =
      response?.status === 401 &&
      /^(basic|digest)\b/i.test(response.authenticate ?? "");

    const observed = await observe();
    if ("blocked" in observed) return observed.blocked;
    const snapshot = observed.snapshot;
    await collectIssued(snapshot);
    // A step needing a person is never handed to an interpreter to solve.
    // A passkey hint beside a password box is conditional UI: the page still
    // accepts a password, so it is driven normally. So is the hint on an
    // identifier field with no password beside it yet - the first step of an
    // identifier-first page. Conditional UI is spelled `username webauthn`
    // (or `email webauthn`): the token rides on a field a person types their
    // identifier into. A bare `webauthn` field is the authenticator's own
    // prompt, not an identifier, and with nothing else to fill that page
    // requires the authenticator, and so a person.
    const conditionalIdentifier = (element: SnapshotElement) => {
      const tokens = (element.autocomplete ?? "").split(/\s+/);
      return (
        element.kind === "input" &&
        tokens.includes("webauthn") &&
        (tokens.includes("username") || tokens.includes("email"))
      );
    };
    const passkeyOnly =
      snapshot.passkey &&
      !snapshot.elements.some(
        (element) =>
          element.type === "password" || conditionalIdentifier(element),
      );
    const humanStep: HumanStepReason | undefined = snapshot.challenge
      ? "human-challenge"
      : passkeyOnly
        ? "passkey"
        : dialog
          ? "native-dialog"
          : undefined;
    if (humanStep) {
      const refused = await handOff(snapshot, humanStep);
      if (refused) {
        record(snapshot, "blocked", { reason: refused });
        return finish({ status: "blocked", reason: refused, steps });
      }
      await page.settle();
      steps++;
      continue;
    }
    const outcome = await driveSnapshot(snapshot, url);
    if (outcome) return outcome;
  }
  return finish({ status: "exhausted", steps });
}

/* -------------------------------------------------------------------------- */
/* Replaying a recorded ceremony                                              */
/* -------------------------------------------------------------------------- */

/**
 * Why a replay could not place the page in front of it. Every kind names what
 * the recording expected and what was there instead, by page pattern and
 * control description — never by value, because a recording has none.
 */
export type RecordingDrift = {
  kind:
    | "unexpected-page"
    | "element-missing"
    | "element-ambiguous"
    /**
     * The box the recording ticks now accepts something other than what was
     * reviewed - more terms, a privacy policy, a bundled newsletter. Found,
     * but not the box whose consent was approved.
     */
    | "consent-changed"
    | "undeclared-origin"
    | "missing-role";
  /** The step the replay expected next, when there was one. */
  step?: string;
  /** The page the recording expected, as origin plus path pattern. */
  expected?: string;
  /** The control the recording expected, as the descriptors it recorded. */
  target?: string;
  /** Origin and pathname of the page in front of the replay. */
  observed?: string;
  /** A role the recording fills and this login cannot supply. */
  role?: CeremonyRole;
};

export type RecordedRunOptions = Omit<CeremonyRunOptions, "interpreter"> & {
  recording: RecordedCeremony;
  /**
   * The host's interpreter, for a page the recording cannot place.
   *
   * Absent — the default — means a replay makes no inference call at all and
   * stops at the first drift, by name. Present, the interpreter is asked about
   * the drifted page only, the replay picks the recording up again as soon as
   * a page matches, and the result says a repair happened so the caller can
   * save what worked as a new draft. It is never a reason to publish anything.
   */
  fallback?: CeremonyInterpreter;
};

export type RecordedRunResult = CeremonyResult & {
  /** The first place the recording and the provider disagreed. */
  drift?: RecordingDrift;
  /** How many times the fallback interpreter was consulted. Zero on a clean replay. */
  interpreterCalls: number;
  /** Whether the fallback interpreter chose any action that was applied. */
  repaired: boolean;
  /** What this run applied, replayed and repaired alike, for recompiling. */
  trace: readonly RecordedTraceEntry[];
};

function describeTarget(target: ElementFingerprint): string {
  const parts = [
    target.kind,
    target.type ? `type=${target.type}` : "",
    target.name ? `name=${target.name}` : "",
    target.autocomplete ? `autocomplete=${target.autocomplete}` : "",
    target.label ? `label="${target.label}"` : "",
    target.placeholder ? `placeholder="${target.placeholder}"` : "",
    target.text ? `text="${target.text}"` : "",
    target.of > 1 ? `#${target.ordinal + 1} of ${target.of}` : "",
  ];
  return parts.filter(Boolean).join(" ").slice(0, 400);
}

/** A drift, as the one-line note a transcript carries. */
export function describeDrift(drift: RecordingDrift): string {
  const at = drift.step ? `step ${drift.step}: ` : "";
  const line = (() => {
    switch (drift.kind) {
      case "element-missing":
        return `${at}no ${drift.target} on ${drift.observed}`;
      case "element-ambiguous":
        return `${at}more than one ${drift.target} on ${drift.observed}`;
      case "consent-changed":
        return `${at}${drift.target} on ${drift.observed} accepts something the recording did not`;
      case "unexpected-page":
        return `${at}expected ${drift.expected}, found ${drift.observed}`;
      case "undeclared-origin":
        return `recording names ${drift.observed}, which this login does not admit`;
      case "missing-role":
        return `recording fills ${drift.role}, which this login cannot supply`;
    }
  })();
  // A transcript note is bounded; the structured drift keeps every field.
  return line.slice(0, 200);
}

/**
 * Run a recorded ceremony with no model in the loop.
 *
 * The recording does not drive the browser itself. It becomes the
 * interpreter: at each observation it finds the next recorded step whose page
 * matches, finds that step's control by its fingerprint, and proposes exactly
 * what the recording did there. Everything else is {@link runCeremony}, so a
 * replay is held to every rule a live login is — origin policy, a secret typed
 * only where a plan admits it, the canary on every snapshot, the dispatch
 * ledger, stale-document refusals, human handoff and the step budget. A
 * recording can make a login faster and cheaper; it cannot make one less
 * careful.
 *
 * Where the recording and the page disagree, the replay stops and says where
 * and how. Only a host that configured a fallback interpreter gets anything
 * else, and then only for the page that drifted.
 */
export async function runRecordedCeremony(
  options: RecordedRunOptions,
): Promise<RecordedRunResult> {
  const { recording, fallback } = options;
  const allowed = new Set(
    options.allowedOrigins.map((origin) => originOf(origin)),
  );
  const trace: RecordedTraceEntry[] = [];
  let drift: RecordingDrift | undefined;
  let interpreterCalls = 0;
  let repaired = false;

  const refuse = (found: RecordingDrift): RecordedRunResult => ({
    status: "blocked",
    reason:
      found.kind === "undeclared-origin"
        ? "untrusted-origin"
        : "unsupported-page",
    steps: 0,
    transcript: [],
    handoffs: 0,
    drift: found,
    interpreterCalls: 0,
    repaired: false,
    trace: [],
  });
  // Checked before a page is opened, so a recording that could only ever
  // fail does not cost the provider a request.
  const undeclared = recording.origins.find((origin) => !allowed.has(origin));
  if (undeclared !== undefined)
    return refuse({ kind: "undeclared-origin", observed: undeclared });
  const unsupplied = recording.roles.find(
    (role) => !options.secrets.roles.includes(role),
  );
  if (unsupplied !== undefined)
    return refuse({ kind: "missing-role", role: unsupplied });

  const steps = recording.steps;
  const index = new Map(steps.map((step, position) => [step.id, position]));
  /** The next recorded step that has not been applied. */
  let cursor = 0;
  /** The step whose action was last proposed, until it is applied. */
  let pending: number | undefined;
  /** Whether the last proposal came from the fallback. */
  let fromFallback = false;

  type Decision =
    { propose: DriverAction; step?: number } | { drift: RecordingDrift };

  const decide = (snapshot: PageSnapshot): Decision => {
    if (recording.success.some((match) => matchesPage(match, snapshot.path)))
      return { propose: { action: "done", note: "recorded success page" } };
    for (const branch of recording.branches) {
      if (!matchesPage(branch.when, snapshot.path)) continue;
      if (branch.then.do === "finish")
        return { propose: { action: "done", note: `branch ${branch.id}` } };
      if (branch.then.do === "stop")
        return {
          propose: {
            action: "blocked",
            reason: branch.then.reason,
            note: `branch ${branch.id}`,
          },
        };
      cursor = index.get(branch.then.step) ?? cursor;
      break;
    }
    for (let position = cursor; position < steps.length; position++) {
      const step = steps[position]!;
      if (!matchesPage(step.page, snapshot.path)) {
        if (step.optional) continue;
        break;
      }
      const note = `step ${step.id}`;
      if (step.action.kind === "wait-for")
        return { propose: { action: "wait", note }, step: position };
      const located = locateElement(step.action.target, snapshot.elements);
      if (!("found" in located)) {
        if (step.optional) continue;
        return {
          drift: {
            kind:
              "missing" in located ? "element-missing" : "element-ambiguous",
            step: step.id,
            expected: describePage(step.page),
            target: describeTarget(step.action.target),
            observed: snapshot.path,
          },
        };
      }
      // A recorded tick is a recorded legal act, and it is not generalised:
      // the box found has to accept exactly what the reviewed step says it
      // accepts. A box that now also bundles a newsletter, or adds a privacy
      // policy, is a different agreement under a familiar label.
      if (step.action.kind === "check") {
        const live = checkboxConsent(located.found);
        const recorded = step.action.consent ?? [];
        if (
          live.marketing ||
          live.kinds.length !== recorded.length ||
          live.kinds.some((kind) => !recorded.includes(kind))
        )
          return {
            drift: {
              kind: "consent-changed",
              step: step.id,
              expected: describePage(step.page),
              target: describeTarget(step.action.target),
              observed: snapshot.path,
            },
          };
      }
      const element = located.found.index;
      const action: DriverAction =
        step.action.kind === "fill"
          ? { action: "fill", element, role: step.action.role, note }
          : step.action.kind === "select"
            ? { action: "select", element, option: step.action.option, note }
            : { action: step.action.kind, element, note };
      return { propose: action, step: position };
    }
    // Every recorded step has been applied and no success page was recorded
    // for this one. Claiming the end is safe: a claim is only ever a claim,
    // and whoever runs the replay decides with a verifier.
    if (cursor >= steps.length)
      return { propose: { action: "done", note: "recording complete" } };
    const expected = steps[cursor]!;
    const previous = steps[cursor - 1];
    return {
      drift: {
        kind: "unexpected-page",
        step: expected.id,
        expected: describePage(expected.page),
        observed: snapshot.path,
        // A click that was recorded navigating and left the page where it was
        // is the more useful thing to name than the page that did not appear.
        ...(previous?.action.kind === "click" &&
        previous.action.expect === "navigation" &&
        matchesPage(previous.page, snapshot.path)
          ? { target: describeTarget(previous.action.target) }
          : {}),
      },
    };
  };

  const interpreter: CeremonyInterpreter = async (input) => {
    const decision = decide(input.snapshot);
    if ("propose" in decision) {
      pending = decision.step;
      fromFallback = false;
      return decision.propose;
    }
    drift ??= decision.drift;
    pending = undefined;
    if (!fallback)
      return {
        action: "blocked",
        reason: "unsupported-page",
        note: describeDrift(decision.drift),
      };
    interpreterCalls++;
    fromFallback = true;
    return fallback(input);
  };

  const result = await runCeremony({
    ...options,
    interpreter,
    onApplied: (entry) => {
      trace.push(entry);
      if (fromFallback) repaired = true;
      else if (pending !== undefined) {
        cursor = pending + 1;
        pending = undefined;
      }
      options.onApplied?.(entry);
    },
  });
  return {
    ...result,
    ...(drift ? { drift } : {}),
    interpreterCalls,
    repaired,
    trace,
  };
}
