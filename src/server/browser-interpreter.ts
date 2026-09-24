import { generateText, Output, type LanguageModel } from "ai";
import {
  ceremonyRoles,
  driverActionSchema,
  type CeremonyGoal,
  type CeremonyRole,
  type DriverAction,
  type PageSnapshot,
  type SnapshotElement,
} from "../core/browser-contracts.js";

/**
 * The inference boundary of an isolated-browser ceremony.
 *
 * An interpreter reads one sanitized page snapshot and chooses one next action.
 * It never receives a credential, an authorization code or raw provider markup,
 * and it has no authority: the driver validates every action it returns and
 * owns origin policy, secret substitution, step budgets and completion
 * evidence. Replacing this port with a scripted implementation is what lets the
 * contract suite run the same scenarios without a model.
 */
export type InterpreterInput = {
  goal: CeremonyGoal;
  snapshot: PageSnapshot;
  /** Roles the driver can substitute. Requesting any other role is rejected. */
  available: readonly CeremonyRole[];
  /**
   * Earlier actions, oldest first, so a failed approach is not repeated.
   *
   * Each entry carries the document it happened on. Without that, "have I
   * pressed this already?" can only be asked of a button's label, and a label
   * is not an identity: an identifier-first provider puts a button reading
   * "Sign in" on the email page and another reading "Sign in" on the password
   * page, and they are different buttons on different documents.
   */
  history: readonly { action: string; note?: string; path?: string }[];
};

export type CeremonyInterpreter = (
  input: InterpreterInput,
) => Promise<DriverAction | undefined>;

const goalDescriptions: Record<CeremonyGoal, string> = {
  "sign-in": "sign in to an existing account at this provider",
  registration:
    "create an account at this provider and finish any confirmation step",
  authorize: "approve the requested access at this provider",
  "obtain-credential":
    "cause this provider to issue an access credential. You will never be shown its value; a person collects it privately",
};

/**
 * Serialize the snapshot for a model. Element indices are preserved because an
 * action refers to them; nothing else about the page is disclosed.
 */
export function interpreterPrompt(input: InterpreterInput): string {
  return `You drive an isolated browser to ${goalDescriptions[input.goal]}.
Choose exactly ONE next action and return only that object.
- "fill" names an element index and a role. Code substitutes the value; you never see it. Available roles: ${input.available.join(", ") || "none"}.
- "click" a button or link by element index to submit, continue, approve, or move to the sign-in or registration page you need.
- "check" a required checkbox, such as terms or age confirmation, by element index.
- "wait" only when the page is mid-transition and no element can be acted on.
- "done" only when the page shows the ceremony finished. A claim is checked; an unverified claim fails the attempt.
- "blocked" with a reason when no action can help: human-challenge, credentials-rejected, account-exists, account-missing, consent-denied, provider-error, unsupported-page.
- "note" is a short public status line. Never put a credential, code or personal value in it.
- If an alert repeats after the same action, change approach or report blocked instead of repeating it.
Page: ${JSON.stringify(input.snapshot)}
Earlier actions: ${JSON.stringify(input.history.slice(-8))}`;
}

/**
 * Bounded model-backed interpreter. A refusal, timeout, malformed object or
 * transport failure returns undefined; the driver treats that as a step that
 * made no progress rather than as an outcome.
 */
export function createModelInterpreter(
  model: LanguageModel,
  options: { timeoutMs?: number } = {},
): CeremonyInterpreter {
  return async (input) => {
    try {
      const result = await generateText({
        model,
        output: Output.object({ schema: driverActionSchema }),
        maxOutputTokens: 200,
        maxRetries: 0,
        abortSignal: AbortSignal.timeout(options.timeoutMs ?? 20_000),
        telemetry: { isEnabled: false },
        prompt: interpreterPrompt(input),
      });
      const action = driverActionSchema.parse(result.output);
      return action.role && !input.available.includes(action.role)
        ? undefined
        : action;
    } catch {
      // A provider error, refusal or schema violation is never an outcome.
      return undefined;
    }
  };
}

/** Every role name, for callers building a secret source. */
export const interpreterRoles: readonly CeremonyRole[] = ceremonyRoles;

/**
 * A model-free interpreter, reading the same sanitized snapshot as the model.
 *
 * It exists so an agent can drive a ceremony where no model is configured, and
 * so the driving itself is testable without one. It sees exactly what
 * `createModelInterpreter` sees — no page markup, no values — and returns the
 * same bounded action, so swapping the two changes one argument and nothing
 * else about the run.
 *
 * The rules are the ones a person uses on an unfamiliar sign-in page: fill what
 * is asked for and you can supply, then press the thing that moves forward; if
 * there is nothing to fill and the page is the wrong one, follow the link
 * toward the page you need. It is deliberately not clever — it reports blocked
 * rather than guessing, because a wrong guess at an auth provider costs a real
 * attempt.
 */
export function createHeuristicInterpreter(): CeremonyInterpreter {
  const words = (element: SnapshotElement) =>
    `${element.name ?? ""} ${element.label ?? ""} ${element.placeholder ?? ""} ${element.text ?? ""}`.toLowerCase();

  /** What this control is asking for, or nothing when it cannot be told. */
  const roleOf = (
    element: SnapshotElement,
    seenPassword: boolean,
  ): CeremonyRole | undefined => {
    const text = words(element);
    if (/\b(code|otp|one[- ]?time|verification)\b/.test(text))
      return /totp|authenticat/.test(text) ? "totp-code" : "verification-code";
    if (element.type === "email" || /e-?mail/.test(text)) return "email";
    if (element.type === "password" || /password|passphrase/.test(text))
      return seenPassword || /confirm|again|repeat|retype/.test(text)
        ? "password-confirm"
        : "password";
    if (/user\s?name|handle|login/.test(text)) return "username";
    if (/display|full name|your name/.test(text)) return "display-name";
    if (/birth|date of birth|dob/.test(text)) return "birth-date";
    return undefined;
  };

  const forward =
    /continue|submit|sign in|log in|sign up|join|register|create|next|confirm|verify|approve|authorize|allow|grant|accept|agree|get started|finish|done/;
  /**
   * Controls that never move a ceremony forward, whatever else they say:
   * pressing "Resend confirmation" or "Deny" is a wrong answer, not a slower
   * right one. Checked before `forward`, so "Send a new link" is not a submit.
   */
  const backward =
    /resend|send (a )?new|email me again|cancel|deny|decline|not now|\bback\b|sign out|log out|skip/;
  /** Sign-up or sign-in through someone else, or without a password. */
  const elsewhere =
    /with (google|github|gitlab|apple|microsoft|facebook|linkedin|twitter|x)\b|passkey|security key|\bsso\b|single sign-on/;
  /** A page telling the person to go and read their mail. */
  const awaitingMail =
    /check your (e-?mail|inbox)|we (have )?sent|confirmation (e-?mail|message|link)|verify your e-?mail/;
  /** Links that take an unfamiliar page toward the one the goal needs. */
  const toward: Record<CeremonyGoal, RegExp> = {
    "sign-in": /sign in|log in|already have/,
    registration: /sign up|register|create (an )?account|new account/,
    authorize: /authorize|approve|allow|continue/,
    "obtain-credential": /token|api key|credential|new (personal )?access/,
  };

  return async ({ goal, snapshot, available, history }) => {
    if (snapshot.challenge)
      return { action: "blocked", reason: "human-challenge" };
    if (snapshot.passkey && !available.includes("password"))
      return { action: "blocked", reason: "passkey-required" };

    // An alert that names a wall is a wall, whatever else is on the page —
    // except a taken address during registration, which a caller that
    // declared it can obtain another address may get past, at most twice.
    const alerts = snapshot.alerts.join(" ").toLowerCase();
    if (
      /already (exists|registered|taken|in use)|in use|is taken/.test(alerts)
    ) {
      const address = snapshot.elements.find(
        (element) =>
          element.kind === "input" && roleOf(element, false) === "email",
      );
      const swaps = history.filter(
        (entry) => entry.action === "fill" && entry.note === "retry-address",
      ).length;
      // Whether the address on the page is the one the provider just
      // refused: true unless an address was swapped in after the last press.
      const lastSwap = history.findLastIndex(
        (entry) => entry.action === "fill" && entry.note === "retry-address",
      );
      const lastPress = history.findLastIndex(
        (entry) => entry.action === "click",
      );
      const refused = lastSwap < lastPress;
      if (
        goal !== "registration" ||
        !available.includes("alternate-email") ||
        !address ||
        address.submitsTo
      )
        return { action: "blocked", reason: "account-exists" };
      if (refused) {
        if (swaps >= 2) return { action: "blocked", reason: "account-exists" };
        return {
          action: "fill",
          element: address.index,
          role: "alternate-email",
          note: "retry-address",
        };
      }
      // The replacement is in place; the rest of the form is refilled below.
    }
    if (/incorrect|invalid|did not match|wrong password/.test(alerts))
      return { action: "blocked", reason: "credentials-rejected" };

    // Registering, on a page that is not itself a registration form but links
    // to one: go there first. Filling a sign-in form here would post the
    // brand-new password to the provider's sign-in endpoint - a wasted
    // attempt that may count toward a lockout - before the account exists.
    //
    // Only before registration has started. Once anything was typed or ticked,
    // or the page says the account already exists (a sign-in page reached
    // after confirming the address), the link would start a second account;
    // the history window alone is too short to remember the first one. And
    // only a plain sign-up link: "Sign up with Google" leaves for another
    // provider, and a passkey sign-up needs a person.
    if (goal === "registration") {
      const heading =
        `${snapshot.title} ${snapshot.headings.join(" ")}`.toLowerCase();
      const passwords = snapshot.elements.filter(
        (element) => element.kind === "input" && element.type === "password",
      ).length;
      const started = history.some(
        (entry) => entry.action === "fill" || entry.action === "check",
      );
      const exists =
        /confirmed|verified|(account|was) created|registration (is )?complete/.test(
          `${heading} ${alerts}`,
        );
      const signUp = snapshot.elements.find(
        (element) =>
          element.kind === "link" &&
          toward.registration.test(words(element)) &&
          !backward.test(words(element)) &&
          !elsewhere.test(words(element)) &&
          !history.some(
            (entry) => entry.action === "click" && entry.note === element.text,
          ),
      );
      if (
        signUp &&
        !started &&
        !exists &&
        passwords < 2 &&
        !/create|sign up|regist|join|new account/.test(heading)
      )
        return { action: "click", element: signUp.index, note: signUp.text };
    }

    let seenPassword = false;
    for (const element of snapshot.elements) {
      if (element.kind !== "input" && element.kind !== "select") continue;
      const role = roleOf(element, seenPassword);
      if (role === "password") seenPassword = true;
      if (!role || element.filled || !available.includes(role)) continue;
      // Never type into a form that posts somewhere else; the driver refuses
      // it too, and asking is a wasted step.
      if (element.submitsTo) continue;
      return { action: "fill", element: element.index, role };
    }

    // A required box is ticked for any goal. Registration also ticks the
    // provider's terms or age confirmation when the page does not mark it
    // required - many only say so after a refused submit - because accepting
    // them is part of creating the account the person asked for. Nothing
    // else optional is ever ticked: "I agree" is also how marketing and
    // data-sharing boxes are worded, so the wording must name terms or an
    // age, and must not name mail, offers or partners.
    const unchecked = snapshot.elements.find(
      (element) =>
        element.kind === "checkbox" &&
        element.filled !== true &&
        (element.required === true ||
          (goal === "registration" &&
            /\b(terms|conditions|privacy policy|eula|old enough|years of age)\b/.test(
              words(element),
            ) &&
            !/marketing|newsletter|offers|partners|promot|updates/.test(
              words(element),
            ))),
    );
    if (unchecked) return { action: "check", element: unchecked.index };

    // Only what was pressed on *this* document counts as already tried.
    //
    // Scoped by label alone, a second step that reuses the first step's button
    // label was unreachable: the driver filled the password and then declined
    // to submit it, because something called "Sign in" had been pressed on the
    // page before. Most real providers reuse "Continue", "Next" or "Sign in"
    // across steps, so that was not an edge case - it was every
    // identifier-first flow.
    //
    // An entry with no recorded document is treated as elsewhere rather than
    // here, so an interpreter given a history from before this distinction
    // existed errs toward offering the button rather than withholding it. The
    // driver's own stall detection is what stops a genuine loop, and it can
    // see something this cannot: whether the page changed.
    //
    // A press also stops counting once the form on this document was
    // deliberately changed since - a replacement address swapped in, a box
    // ticked - because the provider refused the old form and the new one has
    // not been submitted. Refilling the same fields is not such a change, or a
    // page that keeps refusing would be submitted forever.
    const changed = history.findLastIndex(
      (entry) =>
        entry.path === snapshot.path &&
        (entry.action === "check" ||
          (entry.action === "fill" && entry.note === "retry-address")),
    );
    const lastPress = history.findLastIndex(
      (entry) => entry.action === "click" && entry.path === snapshot.path,
    );
    const unsubmitted =
      history.findLastIndex(
        (entry) =>
          (entry.action === "fill" || entry.action === "check") &&
          entry.path === snapshot.path,
      ) > lastPress;
    const pressed = new Set(
      history
        .filter(
          (entry, at) =>
            entry.action === "click" &&
            entry.path === snapshot.path &&
            at > changed,
        )
        .map((entry) => entry.note),
    );
    const buttons = snapshot.elements.filter(
      (element) =>
        element.kind === "button" &&
        !backward.test(words(element)) &&
        !pressed.has(element.text),
    );
    // A caption that says "forward" is taken first. Failing that, a form
    // filled here and not yet submitted, whose page has exactly one button
    // left that is not a way back, has one way on whatever the provider chose
    // to call it ("Join", "Go", "Let's go"): pressing it is what a person
    // would do, and the driver still verifies the outcome.
    const submit =
      buttons.find((element) => forward.test(words(element))) ??
      (unsubmitted && buttons.length === 1 ? buttons[0] : undefined);
    if (submit)
      return { action: "click", element: submit.index, note: submit.text };

    const link = snapshot.elements.find(
      (element) =>
        element.kind === "link" &&
        toward[goal].test(words(element)) &&
        !pressed.has(element.text),
    );
    if (link) return { action: "click", element: link.index, note: link.text };

    // Nothing to fill and nothing to press. A page that says the thing
    // happened, with no way left to act, is the end of the ceremony — claiming
    // it is safe because the driver only accepts a claim that verification
    // confirms. Otherwise one wait covers a page still settling, and a second
    // means this page is not one these rules understand.
    const said =
      `${snapshot.title} ${snapshot.headings.join(" ")}`.toLowerCase();
    if (
      /created|registered|confirmed|connected|approved|signed in|welcome|success/.test(
        said,
      )
    )
      return { action: "done" };
    // Mail takes time to arrive, and waiting is also how the driver collects
    // a confirmation link from the inbox, so a page that says "check your
    // inbox" earns a few waits; any other page earns one.
    let waits = 0;
    for (
      let i = history.length - 1;
      i >= 0 && history[i]!.action === "wait";
      i--
    )
      waits++;
    const patience = awaitingMail.test(
      `${said} ${snapshot.alerts.join(" ").toLowerCase()}`,
    )
      ? 4
      : 1;
    return waits >= patience
      ? { action: "blocked", reason: "unsupported-page" }
      : { action: "wait" };
  };
}
