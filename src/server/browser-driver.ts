import type { HumanHandoffContract } from "../core/connector-contracts.js";
import {
  driverActionSchema,
  secretRoles,
  type BlockedReason,
  type CeremonyCallback,
  type CeremonyGoal,
  type CeremonyRole,
  type CeremonyStep,
  type CeremonyStepAction,
  type DriverAction,
  type PageSnapshot,
  type SnapshotElement,
} from "../core/browser-contracts.js";
import type {
  CeremonyInterpreter,
  InterpreterInput,
} from "./browser-interpreter.js";

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
 * Why a person has to take part. Each is read from the page or the response,
 * never inferred from prose, and none of them is a failure: a ceremony that
 * needs a human is the ordinary case this framework exists to guide.
 */
export const humanStepReasons = [
  /** A CAPTCHA or other proof-of-personhood widget. */
  "human-challenge",
  /** A platform authenticator this browser cannot drive. */
  "passkey",
  /** Credentials demanded by a browser dialog, which has no page to fill. */
  "native-dialog",
] as const;
export type HumanStepReason = (typeof humanStepReasons)[number];

/**
 * What a host is asked for. It carries no value and no secret: the person acts
 * at `url` in their own browser, or through whatever the host's delegation
 * offers. `attempt` lets a host stop asking rather than prompt forever.
 */
export type HumanParticipationRequest = {
  reason: HumanStepReason;
  surface: HumanHandoffContract["surface"];
  recipient: HumanHandoffContract["recipient"];
  url: string;
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
  /** Wait for navigation or in-page updates to quiesce, bounded by the adapter. */
  settle(): Promise<void>;
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
}

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
  | { status: "unverified"; steps: number };

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
  onStep?: (step: CeremonyStep) => void;
}

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
  const history: { action: string; note?: string }[] = [];
  /** Values actually substituted into the page, plus any caller-declared ones. */
  const guarded: string[] = [...(options.protectedValues ?? [])];
  let steps = 0;
  let unchanged = 0;
  let refusals = 0;
  let unverifiedClaims = 0;
  let previous = "";
  let followed: string | undefined;
  let handoffs = 0;
  const maxHandoffs = options.human?.maxRequests ?? 2;

  const record = (
    snapshot: PageSnapshot,
    action: CeremonyStepAction,
    extra: { role?: CeremonyRole; reason?: BlockedReason; note?: string } = {},
  ) => {
    const step: CeremonyStep = { path: snapshot.path, action };
    if (extra.role) step.role = extra.role;
    if (extra.reason) step.reason = extra.reason;
    if (extra.note) step.note = redact(extra.note, guarded);
    transcript.push(step);
    history.push(step.note ? { action, note: step.note } : { action });
    options.onStep?.(step);
  };
  const finish = (outcome: CeremonyOutcome): CeremonyResult => ({
    ...outcome,
    transcript,
    handoffs,
  });

  /**
   * Bring a person into a step the browser cannot complete. The declared
   * handoff contract says where they act and who they are; the driver supplies
   * the live page so an own-browser fallback always exists. A person's "done"
   * is a claim: the attempt resumes and re-reads the page, and completion still
   * requires the same provider evidence it always did.
   */
  const handOff = async (
    snapshot: PageSnapshot,
    reason: HumanStepReason,
    url: string,
  ): Promise<BlockedReason | undefined> => {
    const fallback: BlockedReason =
      reason === "passkey"
        ? "passkey-required"
        : reason === "native-dialog"
          ? "native-dialog"
          : "human-challenge";
    if (!options.human || handoffs >= maxHandoffs) return fallback;
    record(snapshot, "handoff", { reason: fallback });
    handoffs++;
    const outcome = await options.human.request({
      reason,
      surface: options.human.contract.surface,
      recipient: options.human.contract.recipient,
      url,
      attempt: handoffs,
    });
    if (outcome === "declined") return "human-declined";
    if (outcome === "unavailable") return fallback;
    return undefined;
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

    const snapshot = await page.snapshot();
    // A step needing a person is never handed to an interpreter to solve.
    // A passkey hint beside a password box is conditional UI: the page still
    // accepts a password, so it is driven normally. Only a prompt with nothing
    // else to fill actually requires the authenticator, and so a person.
    const passkeyOnly =
      snapshot.passkey &&
      !snapshot.elements.some((element) => element.type === "password");
    const humanStep: HumanStepReason | undefined = snapshot.challenge
      ? "human-challenge"
      : passkeyOnly
        ? "passkey"
        : dialog
          ? "native-dialog"
          : undefined;
    if (humanStep) {
      const refused = await handOff(snapshot, humanStep, url);
      if (refused) {
        record(snapshot, "blocked", { reason: refused });
        return finish({ status: "blocked", reason: refused, steps });
      }
      await page.settle();
      steps++;
      continue;
    }
    const serialized = JSON.stringify(snapshot);
    if (contains(serialized, guarded))
      throw new CeremonySecretLeak("a page snapshot");

    const input: InterpreterInput = {
      goal,
      snapshot,
      available: secrets.roles,
      history: history.slice(-8),
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
      continue;
    }
    const action = parsed.data;
    if (action.note && contains(action.note, guarded))
      throw new CeremonySecretLeak("an interpreter note");

    // Reaching here means the proposal is structurally usable.
    if (action.action === "blocked") {
      const reason = action.reason ?? "unsupported-page";
      record(snapshot, "blocked", {
        reason,
        ...(action.note ? { note: action.note } : {}),
      });
      return finish({ status: "blocked", reason, steps });
    }
    if (action.action === "done") {
      refusals = 0;
      record(snapshot, "done", action.note ? { note: action.note } : {});
      if (options.verify && (await options.verify()))
        return finish({ status: "completed", steps });
      if (++unverifiedClaims >= 2)
        return finish({ status: "unverified", steps });
      steps++;
      continue;
    }
    if (action.action === "wait") {
      refusals = 0;
      record(snapshot, "wait", action.note ? { note: action.note } : {});
      const link = await options.confirmationLink?.();
      if (link && allowed.has(originOf(link)) && link !== followed) {
        followed = link;
        await page.goto(link);
      } else await page.settle();
      steps++;
      const settled = fingerprint(await page.snapshot());
      if (settled === previous) {
        if (++unchanged >= stallLimit)
          return finish({ status: "stalled", steps });
      } else unchanged = 0;
      previous = settled;
      continue;
    }

    const element =
      action.element === undefined
        ? undefined
        : snapshot.elements[action.element];
    if (!element) {
      steps++;
      if (++refusals >= 2) {
        record(snapshot, "blocked", { reason: "unsupported-page" });
        return finish({ status: "blocked", reason: "unsupported-page", steps });
      }
      continue;
    }

    if (action.action === "fill") {
      const role = action.role;
      // A role the caller never supplied is as unusable as a missing element:
      // the value is never resolved, and the attempt says so rather than
      // spending its whole budget re-asking.
      if (!role || !secrets.roles.includes(role)) {
        steps++;
        if (++refusals >= 2) {
          record(snapshot, "blocked", { reason: "unsupported-page" });
          return finish({
            status: "blocked",
            reason: "unsupported-page",
            steps,
          });
        }
        continue;
      }
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
      await page.fill(element, value);
      record(snapshot, "fill", {
        role,
        ...(action.note ? { note: action.note } : {}),
      });
    } else if (action.action === "check") {
      await page.check(element);
      record(snapshot, "check", action.note ? { note: action.note } : {});
    } else {
      await page.click(element);
      record(snapshot, "click", action.note ? { note: action.note } : {});
    }

    refusals = 0;
    await page.settle();
    steps++;
    const current = fingerprint(await page.snapshot());
    if (current === previous) {
      if (++unchanged >= stallLimit)
        return finish({ status: "stalled", steps });
    } else unchanged = 0;
    previous = current;
  }
  return finish({ status: "exhausted", steps });
}
