import type {
  CeremonyRole,
  DriverAction,
  PageSnapshot,
  SnapshotElement,
} from "../../src/core/browser-contracts.js";
import type {
  CeremonyInterpreter,
  InterpreterInput,
} from "../../src/server/browser-interpreter.js";

/**
 * A deterministic stand-in for the inference boundary.
 *
 * This is a test double, never production code: in a real ceremony a model
 * interprets the page, because no fixed rule set survives contact with real
 * providers. Its job here is to make the contract suite reproducible while
 * proving something the suite would otherwise assume — that a snapshot carries
 * enough signal to finish the ceremony. It reads nothing but the snapshot it is
 * given: no markup, no selectors, no knowledge of which scenario is running,
 * and no value of any kind. If a page is randomized into a shape the snapshot
 * cannot express, this interpreter fails, and that is the finding.
 */

const patterns = {
  confirmPassword: /confirm|repeat|again|verify your password/i,
  email: /e-?mail/i,
  identifier: /user ?name|handle|login name|account name|identifier/i,
  displayName: /display name|your name|full name/i,
  birthDate: /birth|birthday/i,
  verification: /confirmation code|verification code|digit code|\bcode\b/i,
  totp: /authenticator|two-factor|one-time|2fa/i,
  userCode: /device code|pairing code|code shown/i,
  terms: /agree|accept|terms|privacy|old enough|consent/i,
  signUpAction:
    /create\s+(an\s+|your\s+)?account|regist(er|ration)|sign\s?up|join/i,
  signInAction: /sign ?in|log ?in/i,
  approveAction: /authorize|allow|approve|grant/i,
  denyAction: /deny|cancel|not now|reject/i,
  submitAction: /continue|next|submit|confirm|verify|send/i,
  resendAction: /resend|send a new|email me again/i,
  retryAction: /try again|retry|go back|back to sign/i,
  completed:
    /you are signed in|signed in as|device is now approved|account is ready/i,
  inUse: /already in use|already exists|is taken/i,
  rejected: /not sign you in|incorrect|were not accepted/i,
  unverified: /confirm your email|not verified/i,
  badCode: /not correct|did not match|invalid code/i,
  mismatch: /passwords do not match|must be the same/i,
  unavailable: /unavailable|try again|temporarily/i,
} as const;

/** Everything the snapshot says about a control, as one searchable string. */
function describe(element: SnapshotElement): string {
  return [element.label, element.placeholder, element.name, element.text]
    .filter((part): part is string => typeof part === "string")
    .join(" ");
}

function inputs(snapshot: PageSnapshot): SnapshotElement[] {
  return snapshot.elements.filter((element) => element.kind === "input");
}

function roleOf(
  element: SnapshotElement,
  all: SnapshotElement[],
): CeremonyRole | undefined {
  const text = describe(element);
  const type = element.type ?? "text";
  if (type === "password") {
    const passwords = all.filter((other) => other.type === "password");
    if (patterns.confirmPassword.test(text)) return "password-confirm";
    // An unlabelled second password box on a page with two is the confirmation.
    if (passwords.length > 1 && passwords[1]?.index === element.index)
      return "password-confirm";
    return "password";
  }
  if (patterns.totp.test(text)) return "totp-code";
  if (patterns.userCode.test(text)) return "user-code";
  if (patterns.verification.test(text)) return "verification-code";
  if (type === "email" || patterns.email.test(text)) return "email";
  if (type === "date" || patterns.birthDate.test(text)) return "birth-date";
  if (patterns.displayName.test(text)) return "display-name";
  if (patterns.identifier.test(text)) return "username";
  return undefined;
}

function findButton(
  snapshot: PageSnapshot,
  pattern: RegExp,
  kinds: SnapshotElement["kind"][] = ["button"],
): SnapshotElement | undefined {
  return snapshot.elements.find(
    (element) =>
      kinds.includes(element.kind) &&
      pattern.test(describe(element)) &&
      !patterns.denyAction.test(describe(element)),
  );
}

function count(
  history: InterpreterInput["history"],
  action: string,
  note?: string,
): number {
  return history.filter(
    (entry) => entry.action === action && (!note || entry.note === note),
  ).length;
}

export type ScriptedInterpreterOptions = {
  /** Deny consent rather than approving it, to exercise the refusal path. */
  denyConsent?: boolean;
  /** Report a page this double cannot act on instead of guessing. */
  onUnsupported?: (snapshot: PageSnapshot) => void;
};

export function createScriptedInterpreter(
  options: ScriptedInterpreterOptions = {},
): CeremonyInterpreter {
  return async ({ goal, snapshot, available, history }) => {
    const alerts = snapshot.alerts.join(" ");
    const headings = snapshot.headings.join(" ");
    const has = (role: CeremonyRole) => available.includes(role);
    const act = (action: DriverAction): DriverAction => action;

    if (snapshot.challenge)
      return act({ action: "blocked", reason: "human-challenge" });

    // Finished pages have nothing left to fill and say so.
    if (patterns.completed.test(`${headings} ${snapshot.title}`))
      return act({ action: "done", note: "The provider reports access." });

    // Registration offered elsewhere on this page is taken up before any
    // attempt to sign in with an account that may not exist yet.
    if (goal === "registration") {
      const offer = snapshot.elements.find(
        (element) =>
          element.kind === "link" &&
          patterns.signUpAction.test(describe(element)),
      );
      if (offer && count(history, "click") < 3)
        return act({
          action: "click",
          element: offer.index,
          note: "to-signup",
        });
    }

    const fields = inputs(snapshot);
    if (patterns.inUse.test(alerts)) {
      const address = fields.find(
        (element) => roleOf(element, fields) === "email",
      );
      const retries = count(history, "fill", "retry-address");
      // Only a caller that declared it can obtain another address may retry.
      if (!has("alternate-email") || retries >= 2 || !address)
        return act({ action: "blocked", reason: "account-exists" });
      if (address.filled !== true)
        return act({
          action: "fill",
          element: address.index,
          role: "alternate-email",
          note: "retry-address",
        });
      // The new address is in place; the rest of the form is refilled below.
    }
    if (patterns.rejected.test(alerts) && count(history, "fill") >= 2)
      return act({ action: "blocked", reason: "credentials-rejected" });
    if (patterns.unavailable.test(alerts)) {
      const retry = findButton(snapshot, patterns.retryAction, [
        "link",
        "button",
      ]);
      if (retry && count(history, "click", "retry") < 3)
        return act({ action: "click", element: retry.index, note: "retry" });
      return act({ action: "blocked", reason: "provider-error" });
    }

    const available_ = fields;
    const unfilled = available_.filter((element) => element.filled !== true);
    // A rejected code is refilled once: a newer message may have arrived.
    const retryCode =
      patterns.badCode.test(alerts) || patterns.mismatch.test(alerts);
    const candidates = retryCode ? available_ : unfilled;

    let awaited: SnapshotElement | undefined;
    for (const element of candidates) {
      const role = roleOf(element, available_);
      if (!role) continue;
      if (role === "username" && !has("username") && has("email"))
        return act({ action: "fill", element: element.index, role: "email" });
      if (!has(role)) {
        // A confirmation field with no code on offer means the confirmation
        // arrives out of band; waiting is the only honest move.
        if (role === "verification-code" && element.filled !== true)
          awaited = element;
        continue;
      }
      if (element.filled === true && !retryCode) continue;
      return act({ action: "fill", element: element.index, role });
    }
    if (awaited && count(history, "wait") < 4)
      return act({ action: "wait", note: "awaiting confirmation" });

    const checkbox = snapshot.elements.find(
      (element) =>
        element.kind === "checkbox" &&
        element.filled !== true &&
        patterns.terms.test(describe(element)),
    );
    if (checkbox) return act({ action: "check", element: checkbox.index });

    if (goal === "authorize") {
      const decision = options.denyConsent
        ? findButton(snapshot, patterns.denyAction)
        : findButton(snapshot, patterns.approveAction);
      if (decision) return act({ action: "click", element: decision.index });
    }

    // With every known field satisfied, submit. Captions are tried in the order
    // that suits the goal: an authorization ceremony passes through sign-in,
    // and a registration ends at a consent screen.
    const order =
      goal === "registration"
        ? [
            patterns.signUpAction,
            patterns.submitAction,
            patterns.approveAction,
            patterns.signInAction,
          ]
        : goal === "authorize"
          ? [
              patterns.approveAction,
              patterns.signInAction,
              patterns.submitAction,
            ]
          : [
              patterns.signInAction,
              patterns.submitAction,
              patterns.approveAction,
            ];
    const submit = order.reduce<SnapshotElement | undefined>(
      (found, pattern) => found ?? findButton(snapshot, pattern),
      undefined,
    );
    if (submit) return act({ action: "click", element: submit.index });

    if (patterns.unverified.test(alerts)) {
      const resend = findButton(snapshot, patterns.resendAction);
      if (resend && count(history, "click") < 2)
        return act({ action: "click", element: resend.index });
    }

    const fallback = findButton(snapshot, patterns.submitAction, [
      "button",
      "link",
    ]);
    if (fallback && count(history, "click") < 6)
      return act({ action: "click", element: fallback.index });

    options.onUnsupported?.(snapshot);
    return act({ action: "blocked", reason: "unsupported-page" });
  };
}
