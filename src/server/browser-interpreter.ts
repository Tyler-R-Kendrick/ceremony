import { generateText, Output, type LanguageModel } from "ai";
import {
  ceremonyRoles,
  checkboxConsent,
  consentCovers,
  deviceVerificationField,
  needsConsent,
  type ConsentKind,
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
  /**
   * Labels of the read-only fields the plan keeps a value from, when it keeps
   * any. Labels only - text the page shows anyway - so an interpreter can
   * leave those fields and the buttons around them alone. Whether a value was
   * read is never said.
   */
  issuedLabels?: readonly string[];
  /**
   * Options the plan chose, by the label of the `<select>` each is for. Page
   * text on both sides; never a secret.
   */
  choices?: Readonly<Record<string, string>>;
  /**
   * What the person consented to in advance: the kinds of box - terms,
   * privacy policy, age - the plan may tick on their behalf. Only the plan
   * sets them, so an interpreter reading them can decline a box but never
   * widen what may be ticked; the driver refuses any other tick anyway.
   */
  consents?: readonly ConsentKind[];
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
    "cause this provider to issue an access credential. You will never be shown its value; it is collected privately, by a person or by the plan",
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
- "check" a required checkbox by element index. A box accepting terms, a privacy policy or an age confirmation may be checked only when the person consented in advance to every kind it names: ${JSON.stringify(input.consents ?? [])}. Otherwise it is "blocked" with consent-required. Never check a marketing or newsletter opt-in.
- "select" chooses an "option" of a select element by its visible label, exactly as listed. Only choose what the plan chose: ${JSON.stringify(input.choices ?? {})}. A required choice the plan did not make is "blocked" with choice-required.
- "wait" only when the page is mid-transition and no element can be acted on.
- "done" only when the page shows the ceremony finished. A claim is checked; an unverified claim fails the attempt.
- "blocked" with a reason when no action can help: human-challenge, credentials-rejected, account-exists, account-missing, consent-denied, provider-error, unsupported-page, device-code-required (a page asking for the code shown on a device when no user-code role is available), choice-required, consent-required.${
    input.issuedLabels?.length
      ? `\n- The plan keeps what these read-only fields show, privately: ${JSON.stringify(input.issuedLabels)}. Never fill them. Once every one of them shows a value, the ceremony is "done"; do not press anything that would generate a new one.`
      : ""
  }
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

  /** Wording that names a sign-in identifier rather than an address. */
  const identifierWords =
    /user\s?name|handle|login|account name|sign[- ]?in name|user id/;

  /**
   * A field that takes either an address or a username ("Email or
   * username", or anything carrying `autocomplete="username"`): whichever the
   * caller can supply. Choosing by wording alone left such a field empty
   * whenever the caller held only the other one, and the form went in with
   * its identifier missing.
   */
  const identifier = (
    text: string,
    available: readonly CeremonyRole[],
  ): CeremonyRole => {
    const email = /e-?mail/.test(text) && available.includes("email");
    if (email) return "email";
    if (available.includes("username")) return "username";
    return available.includes("email") ? "email" : "username";
  };

  /**
   * Which code a code field wants: one from an authenticator, or one that was
   * mailed. The field's own words decide first, then what the page around it
   * says ("Check your email" or "Two-factor authentication"), and only then,
   * when nothing says, the one code the caller can actually supply. Labels
   * such as "One-time code" or "Enter code" say nothing on their own, and
   * guessing the mailed one there stopped every sign-in whose caller held
   * only an authenticator.
   */
  const codeRole = (
    text: string,
    page: string,
    available: readonly CeremonyRole[],
  ): CeremonyRole => {
    if (/totp|authenticat|two[- ]?factor|2fa/.test(text)) return "totp-code";
    if (/e-?mail|inbox/.test(text)) return "verification-code";
    if (
      /check your (e-?mail|inbox)|we (have )?sent|confirm(ation)? (your )?e-?mail|verify your e-?mail/.test(
        page,
      )
    )
      return "verification-code";
    if (/totp|authenticat|two[- ]?factor|2fa|one[- ]?time/.test(page))
      return "totp-code";
    const totp = available.includes("totp-code");
    if (totp !== available.includes("verification-code"))
      return totp ? "totp-code" : "verification-code";
    return "verification-code";
  };

  /** What this control is asking for, or nothing when it cannot be told. */
  const roleOf = (
    element: SnapshotElement,
    seenPassword: boolean,
    available: readonly CeremonyRole[] = [],
    /** The page's title, headings and alerts, lower-cased. */
    page = "",
  ): CeremonyRole | undefined => {
    const text = words(element);
    // The autocomplete token is the page's own published statement of what a
    // field is for, so it is read before any wording. It is what separates a
    // new password from the current one, and a code field from a name field,
    // when the labels alone would not.
    const hint = new Set((element.autocomplete ?? "").split(/\s+/));
    if (hint.has("one-time-code")) return codeRole(text, page, available);
    if (hint.has("current-password")) return "password";
    if (hint.has("new-password"))
      return seenPassword || /confirm|again|repeat|retype/.test(text)
        ? "password-confirm"
        : "password";
    if (hint.has("username")) return identifier(text, available);
    if (hint.has("email")) return "email";
    if (hint.has("name")) return "display-name";
    if (hint.has("bday")) return "birth-date";
    if (/\b(code|otp|one[- ]?time|verification)\b/.test(text))
      return codeRole(text, page, available);
    if (element.type === "email" || /e-?mail/.test(text))
      return identifierWords.test(text) ? identifier(text, available) : "email";
    if (element.type === "password" || /password|passphrase/.test(text))
      return seenPassword || /confirm|again|repeat|retype/.test(text)
        ? "password-confirm"
        : "password";
    if (identifierWords.test(text)) return "username";
    // Also the name of the thing a ceremony creates: an application, a token.
    if (
      /display|full name|your name|(application|app|token|key) name/.test(text)
    )
      return "display-name";
    if (/birth|date of birth|dob/.test(text)) return "birth-date";
    return undefined;
  };

  const forward =
    /continue|submit|sign in|log in|sign up|join|register|create|generate|next|confirm|verify|approve|authorize|allow|grant|accept|agree|get started|finish|done/;
  /**
   * Controls that never move a ceremony forward, whatever else they say:
   * pressing "Resend confirmation" or "Deny" is a wrong answer, not a slower
   * right one. Checked before `forward`, so "Send a new link" is not a submit.
   */
  const backward =
    /resend|send (a )?new|email me again|cancel|deny|decline|not now|\bback\b|sign out|log out|skip|passkey|security key/;
  /** A provider's own way back after it failed: not a way back from the goal. */
  const retry = /try again|retry|back to sign in/i;
  /**
   * A button that makes the provider issue something new: "Generate a new
   * client secret", "Create token", "Regenerate key". Pressing one twice can
   * revoke what the first press issued, so it is never pressed twice on one
   * page, whatever else changed there.
   */
  const issuing =
    /(generate|create|regenerate|new|roll|rotate)\b.*\b(secret|token|key)/;
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

  return async ({
    goal,
    snapshot,
    available,
    history,
    issuedLabels = [],
    choices = {},
    consents = [],
  }) => {
    if (snapshot.challenge)
      return { action: "blocked", reason: "human-challenge" };
    // A passkey hint is conditional UI only on a field that also takes
    // typing - a password box, or an identifier spelled `username webauthn`.
    // A page with neither is the authenticator's own prompt, whatever roles
    // are on offer: pressing its "Continue" asks for an assertion no
    // interpreter can give.
    const typedPath = snapshot.elements.some((element) => {
      const tokens = (element.autocomplete ?? "").split(/\s+/);
      return (
        element.type === "password" ||
        (element.kind === "input" &&
          tokens.includes("webauthn") &&
          (tokens.includes("username") || tokens.includes("email")))
      );
    });
    if (snapshot.passkey && (!available.includes("password") || !typedPath))
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

    // A page showing every value the plan keeps is the end of the ceremony.
    // The driver has already read them from this observation, before this
    // runs, so the only thing left to do on it is something that could spoil
    // them: press "Generate" again and the secret just read is revoked. A
    // claim is only a claim - the driver refuses it until the values are in
    // hand - so claiming here costs nothing when they are not. Shown but
    // still empty means the page is filling them in: wait for it.
    if (issuedLabels.length > 0) {
      const shown = issuedLabels.map((label) =>
        snapshot.elements.filter(
          (element) => element.kind === "input" && element.label === label,
        ),
      );
      if (shown.every((matches) => matches.length === 1)) {
        if (shown.every(([field]) => field!.filled === true))
          return { action: "done", note: "issued values shown" };
        const waited = history.at(-1)?.action === "wait";
        return waited
          ? { action: "blocked", reason: "unsupported-page" }
          : { action: "wait" };
      }
    }

    // A device authorization page wants the code shown on a device. That
    // code is typed only when the plan supplied it; guessing any other role
    // into the field - a mailed code, an authenticator's - would hand the
    // provider a value meant for somewhere else. Without it, a person holding
    // the device has to enter it, and the driver decides whether to ask one.
    const deviceField = deviceVerificationField(snapshot);
    if (
      deviceField &&
      deviceField.filled !== true &&
      !deviceField.submitsTo &&
      !available.includes("user-code")
    )
      return { action: "blocked", reason: "device-code-required" };

    // Registering, on a page that is not itself a registration form but links
    // to one: go there first. Filling a sign-in form here would post the
    // brand-new password to the provider's sign-in endpoint - a wasted
    // attempt that may count toward a lockout - before the account exists.
    if (goal === "registration") {
      const heading =
        `${snapshot.title} ${snapshot.headings.join(" ")}`.toLowerCase();
      const passwords = snapshot.elements.filter(
        (element) => element.kind === "input" && element.type === "password",
      ).length;
      const signUp = snapshot.elements.find(
        (element) =>
          element.kind === "link" &&
          toward.registration.test(words(element)) &&
          !history.some(
            (entry) => entry.action === "click" && entry.note === element.text,
          ),
      );
      if (
        signUp &&
        passwords < 2 &&
        !/create|sign up|regist|join|new account/.test(heading)
      )
        return { action: "click", element: signUp.index, note: signUp.text };
    }

    const context = [snapshot.title, ...snapshot.headings, ...snapshot.alerts]
      .join(" ")
      .toLowerCase();
    let seenPassword = false;
    /** A required choice the plan did not make, for a person to make. */
    let unchosen: SnapshotElement | undefined;
    for (const element of snapshot.elements) {
      if (element.kind !== "input" && element.kind !== "select") continue;
      // A read-only field shows a value; nothing is typed into it.
      if (element.readOnly) continue;
      if (element.kind === "select" && !element.filled) {
        // Chosen by the field's label: an option the page lists, or - when
        // the list was cut at the snapshot's twenty - the plan's option, for
        // the adapter to find in the live control or refuse.
        const option =
          element.label === undefined ? undefined : choices[element.label];
        const listed = element.options ?? [];
        if (
          option !== undefined &&
          (listed.includes(option) || listed.length >= 20)
        )
          return {
            action: "select",
            element: element.index,
            option,
            note: element.label,
          };
      }
      const role =
        element === deviceField
          ? "user-code"
          : roleOf(element, seenPassword, available, context);
      if (role === "password") seenPassword = true;
      if (
        element.kind === "select" &&
        !element.filled &&
        element.required &&
        (!role || !available.includes(role))
      )
        unchosen ??= element;
      if (!role || element.filled || !available.includes(role)) continue;
      // Never type into a form that posts somewhere else; the driver refuses
      // it too, and asking is a wasted step.
      if (element.submitsTo) continue;
      return { action: "fill", element: element.index, role };
    }
    // Everything this caller can supply is in. A required choice nobody made
    // is not one to guess - the first option is rarely the person's country -
    // and submitting without it only earns the provider's refusal.
    if (unchosen) return { action: "blocked", reason: "choice-required" };

    // A required box is ticked for any goal - unless ticking it is a legal
    // act. Accepting terms or a privacy policy, or attesting to an age, is
    // ticked only under the person's advance consent to every kind the box
    // names; otherwise it is theirs to tick, and saying so is what brings
    // them in. Registration also reads an unmarked terms box as needed - many
    // providers only say so after a refused submit - and holds it to the
    // same rule. A marketing or newsletter opt-in is never ticked, and a
    // required one is a person's call too. Nothing else optional is ticked.
    for (const element of snapshot.elements) {
      if (element.kind !== "checkbox" || element.filled === true) continue;
      const consent = checkboxConsent(element);
      if (needsConsent(consent)) {
        const needed =
          element.required === true ||
          (goal === "registration" && consent.kinds.length > 0);
        if (!needed) continue;
        if (!consentCovers(consent, consents))
          return { action: "blocked", reason: "consent-required" };
        return { action: "check", element: element.index };
      }
      if (element.required === true)
        return { action: "check", element: element.index };
    }

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
    // page that keeps refusing would be submitted forever. Nor is a press
    // counted once the provider failed and its own retry link loaded the page
    // again: the earlier submission never reached a working provider, and a
    // person would press the same button a second time.
    const changed = history.findLastIndex(
      (entry) =>
        entry.path === snapshot.path &&
        (entry.action === "check" ||
          (entry.action === "fill" && entry.note === "retry-address") ||
          (entry.action === "click" && retry.test(entry.note ?? ""))),
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
            (at > changed || issuing.test((entry.note ?? "").toLowerCase())),
        )
        .map((entry) => entry.note),
    );
    // A page already showing a value the plan keeps has issued it; a button
    // that issues another would replace it.
    const keeping = issuedLabels.some((label) =>
      snapshot.elements.some(
        (element) =>
          element.kind === "input" &&
          element.label === label &&
          element.filled === true &&
          /secret|token|key/i.test(label),
      ),
    );
    const buttons = snapshot.elements.filter(
      (element) =>
        element.kind === "button" &&
        !backward.test(words(element)) &&
        !pressed.has(element.text) &&
        !(keeping && issuing.test(words(element))),
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

    // A provider that failed and says so offers a way to try again; that is
    // the way forward whatever the goal, but only while the failure is shown.
    const failed = /unavailable|went wrong|try again/.test(alerts);
    const link = snapshot.elements.find(
      (element) =>
        element.kind === "link" &&
        (toward[goal].test(words(element)) ||
          (failed && retry.test(words(element)))) &&
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
