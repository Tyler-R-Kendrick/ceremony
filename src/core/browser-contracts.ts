import { z } from "zod";

/**
 * Vocabulary shared by an isolated-browser ceremony driver, the inference port
 * that chooses its next action, and the scenario doubles it is tested against.
 *
 * The snapshot is the only description of a provider page any interpreter ever
 * receives. It deliberately excludes secret input values, query strings and raw
 * markup, so an interpreter cannot read an authorization code, a password or a
 * provider DOM it was never permitted to see. Contract tests assert that
 * exclusion; they do not assume it.
 */

/** What the driver is trying to accomplish at a provider. */
export const ceremonyGoals = [
  "sign-in",
  "registration",
  "authorize",
  /**
   * Cause a credential to be issued. The value is displayed for a person to
   * place in a private collector; the ceremony succeeds when the credential
   * exists, not when an agent has read it.
   */
  "obtain-credential",
] as const;
export const ceremonyGoalSchema = z.enum(ceremonyGoals);
export type CeremonyGoal = z.infer<typeof ceremonyGoalSchema>;

/**
 * Values the driver can supply by name. An interpreter selects a role; code
 * substitutes the value. No interpreter is ever given a value to echo back.
 */
export const ceremonyRoles = [
  "email",
  /**
   * A different, unused address. Offered only when the caller really can obtain
   * one, so an interpreter facing "that address is taken" can tell the
   * difference between a recoverable situation and a wall.
   */
  "alternate-email",
  "username",
  "password",
  "password-confirm",
  "display-name",
  "birth-date",
  "verification-code",
  "totp-code",
  "user-code",
] as const;
export const ceremonyRoleSchema = z.enum(ceremonyRoles);
export type CeremonyRole = z.infer<typeof ceremonyRoleSchema>;

/** Roles whose values must never appear in a snapshot, prompt or diagnostic. */
export const secretRoles: readonly CeremonyRole[] = [
  "password",
  "password-confirm",
  "verification-code",
  "totp-code",
];

/**
 * The secret roles a caller already *holds* when an attempt starts.
 *
 * The distinction is when the value comes into existence, and it matters to
 * anything that wants a secret's value before the flow asks for one. A
 * password sits in the private collector and is there to be read. A
 * verification code does not exist yet: resolving one means waiting on a
 * mailbox until the provider sends it, which cannot happen before the
 * submission that causes it. Asking early does not get an early answer — it
 * blocks, or polls until it gives up, before anything has been submitted.
 *
 * So a caller that wants to know a secret's value up front may ask for these
 * and must not ask for the others. The two lists are deliberately separate
 * rather than one list with a flag, because a role added to `secretRoles`
 * without a thought about this one is the mistake worth making visible.
 */
export const heldSecretRoles: readonly CeremonyRole[] = [
  "password",
  "password-confirm",
];

/**
 * Secrets a host may hold that are never typed as themselves.
 *
 * A `totp-seed` is the enrolment secret behind an authenticator. No page ever
 * asks for it, and no interpreter may select it: what a page asks for is the
 * `totp-code` derived from it at the moment of filling. So these are not
 * roles. A plan names one by reference exactly as it names a password, the
 * credential source resolves it inside the trusted path, and the driver only
 * ever sees the role it derives.
 *
 * Kept apart from {@link ceremonyRoles} deliberately. Adding the seed there
 * would offer it to an interpreter as a fillable value, and the one thing a
 * seed must never be is typed into a page.
 */
export const heldCredentialKinds = ["totp-seed"] as const;
export const heldCredentialKindSchema = z.enum(heldCredentialKinds);
export type HeldCredentialKind = z.infer<typeof heldCredentialKindSchema>;

/** The role each held credential kind produces a value for. */
export const derivedRoleOf: Readonly<Record<HeldCredentialKind, CeremonyRole>> =
  { "totp-seed": "totp-code" };

/**
 * Values a provider issues on a page, which a plan may declare it keeps.
 *
 * The direction is the opposite of a role. A role is a value the caller has
 * and the page asks for; an issued value is one the page shows once and the
 * caller must take away — an OAuth client's ID and secret on a developer
 * settings page, after "Register application" and "Generate a new client
 * secret". So these are deliberately not roles either: no interpreter selects,
 * fills or sees one. The plan names the read-only field that displays each by
 * its exact label, the driver reads it through the page adapter, and the value
 * goes to the plan's own sink — in a run, straight into a run-bound
 * `common.oauth-client` record — and nowhere else.
 */
export const issuedValueKinds = [
  "client-id",
  "client-secret",
  /**
   * A personal access token a provider just generated, shown once - often in
   * a `<code>` or `<pre>` block beside a copy button rather than in a field.
   * Kept only into `credential-custody`: it is a credential for the person's
   * account, not part of an OAuth client.
   */
  "access-token",
] as const;
export const issuedValueKindSchema = z.enum(issuedValueKinds);
export type IssuedValueKind = z.infer<typeof issuedValueKindSchema>;
/**
 * The issued values that are secrets. Once read, each is guarded exactly as a
 * typed password is: a later snapshot or note that reproduces it fails the
 * attempt. A client ID is an identifier the provider puts in every
 * authorization URL, so it is kept but not guarded.
 */
export const secretIssuedValueKinds: readonly IssuedValueKind[] = [
  "client-secret",
  "access-token",
];

/**
 * Where a production plan's issued values may go. Each is something the
 * *host* implements and registers, never a callback a caller or a model
 * supplies: `oauth-client` mints a run-bound `common.oauth-client` handle
 * (the host's `mintOAuthClient`), and `credential-custody` writes into the
 * host's private collector. A plan names one of these by kind and nothing
 * else, so what happens to a value is decided by the deployment.
 */
export const issuedSinkKinds = ["oauth-client", "credential-custody"] as const;
export const issuedSinkKindSchema = z.enum(issuedSinkKinds);
export type IssuedSinkKind = z.infer<typeof issuedSinkKindSchema>;

/**
 * Page text a plan names something by: the label of an issued field, the
 * label of a `<select>` and the option chosen in it. A reviewer reads it and
 * a recording may store it, so it is held to roughly the rule a recorded
 * descriptor is: short, trimmed, and nothing shaped like a value. That is
 * also what keeps a plan from smuggling a secret in as a "choice".
 */
export const pageLabelSchema = z
  .string()
  .min(1)
  .max(100)
  .refine((label) => label === label.trim(), "Page labels are trimmed")
  .refine(
    (label) => !/\d{6,}|[A-Za-z0-9+/_-]{32,}|@/.test(label),
    "A page label looks like a value",
  );

/**
 * What a plan declares it keeps from a provider page: which read-only field,
 * by exact label, displays which kind of value, and which host sink receives
 * them. One field per kind and one kind per label - a label naming two kinds,
 * or a kind read from two fields, would make "the value" ambiguous - and no
 * more fields than there are kinds.
 */
export const issuedDeclarationSchema = z
  .strictObject({
    sink: issuedSinkKindSchema,
    fields: z
      .array(
        z.strictObject({
          kind: issuedValueKindSchema,
          label: pageLabelSchema,
        }),
      )
      .min(1)
      .max(issuedValueKinds.length),
  })
  .superRefine((declaration, context) => {
    const kinds = new Set(declaration.fields.map((field) => field.kind));
    if (kinds.size !== declaration.fields.length)
      context.addIssue({ code: "custom", message: "Duplicate issued kind" });
    const labels = new Set(declaration.fields.map((field) => field.label));
    if (labels.size !== declaration.fields.length)
      context.addIssue({ code: "custom", message: "Duplicate issued label" });
    // A handle to a client with no identifier is a handle to nothing.
    if (declaration.sink === "oauth-client" && !kinds.has("client-id"))
      context.addIssue({
        code: "custom",
        message: "An oauth-client sink keeps a client-id",
      });
    // An access token is the person's credential, not part of a client: it
    // goes to custody and nowhere else.
    if (kinds.has("access-token") && declaration.sink !== "credential-custody")
      context.addIssue({
        code: "custom",
        message: "An access-token is kept only by a credential-custody sink",
      });
  });
export type IssuedDeclaration = z.infer<typeof issuedDeclarationSchema>;

/** A declaration as the driver's `issued.fields`: kind to exact label. */
export function issuedFieldsOf(
  declaration: IssuedDeclaration,
): Partial<Record<IssuedValueKind, string>> {
  return Object.fromEntries(
    declaration.fields.map((field) => [field.kind, field.label]),
  );
}

export const snapshotElementSchema = z
  .object({
    index: z.number().int().nonnegative(),
    kind: z.enum(["input", "button", "link", "checkbox", "select"]),
    type: z.string().max(32).optional(),
    name: z.string().max(128).optional(),
    /**
     * The field's `autocomplete` hint — `username`, `current-password`,
     * `one-time-code`. A published, stable signal a page gives about what a
     * field is for, which is what lets a recorded step find the field again
     * after its label is reworded.
     */
    autocomplete: z.string().max(64).optional(),
    label: z.string().max(200).optional(),
    placeholder: z.string().max(200).optional(),
    text: z.string().max(200).optional(),
    options: z.array(z.string().max(100)).max(20).optional(),
    required: z.boolean().optional(),
    /** Whether the control already holds a value. Never the value itself. */
    filled: z.boolean().optional(),
    /**
     * The field is read-only: the page shows a value rather than asking for
     * one. Present only when true, and never the value itself.
     */
    readOnly: z.boolean().optional(),
    /**
     * Origin this control's form posts to, present only when it differs from
     * the page's own origin. A provider page can target a third party; the
     * driver refuses to enter a secret into such a form.
     */
    submitsTo: z.string().max(200).optional(),
  })
  .strict();
export type SnapshotElement = z.infer<typeof snapshotElementSchema>;

export const pageSnapshotSchema = z
  .object({
    /** Origin and pathname only: query strings carry authorization codes. */
    path: z.string().max(400),
    title: z.string().max(200),
    headings: z.array(z.string().max(200)).max(8),
    alerts: z.array(z.string().max(300)).max(8),
    /** A human challenge (CAPTCHA, proof of personhood) is present. */
    challenge: z.boolean(),
    /**
     * The page asks for a platform authenticator. Detected from the standard
     * `webauthn` autocomplete hint, not guessed from prose.
     */
    passkey: z.boolean(),
    elements: z.array(snapshotElementSchema).max(60),
  })
  .strict();
export type PageSnapshot = z.infer<typeof pageSnapshotSchema>;

/**
 * Why a ceremony cannot continue. Structured so callers and contract tests can
 * assert the specific wall that was hit instead of matching prose.
 */
export const blockedReasons = [
  "human-challenge",
  "credentials-rejected",
  "account-exists",
  "account-missing",
  "consent-denied",
  "provider-error",
  "unsupported-page",
  /** The browser left every origin the ceremony is permitted to act on. */
  "untrusted-origin",
  /** A person was asked to take part and refused. */
  "human-declined",
  /** The step needs an authenticator this browser cannot drive. */
  "passkey-required",
  /** Credentials are demanded by a browser dialog, which has no page to fill. */
  "native-dialog",
  /**
   * The document that was observed is no longer the document in front of the
   * driver. A page is free to navigate or re-render while an interpreter is
   * thinking or a credential is being fetched; acting on what was seen before
   * that would deliver a secret under an approval that no longer describes the
   * page. Nothing is filled into the replacement.
   *
   * Reaching a *caller* under this name means it happened twice in a row. The
   * first time, the attempt reads the page again and decides on what is
   * actually there — a submit whose navigation commits late leaves a perfectly
   * drivable signed-in page behind the dead approval, and ending there would
   * report a login that succeeded as one that never happened. A page that
   * moves under two reads running cannot be driven, and says so.
   */
  "stale-document",
  /**
   * The control that was approved is gone, hidden, disabled, or has been moved
   * into a different form. Its replacement, however similar, was never
   * approved.
   */
  "stale-element",
  /**
   * There was no observation to act against at all — not a document that moved
   * on, but an approval that was never taken or was already released.
   *
   * Both refuse, so nothing is delivered either way, and for a long time both
   * said `stale-document`. That reads as the page having changed under the
   * attempt, which sends whoever is reading it to the guards that compare
   * documents — and those guards never ran. It is a fault in the caller's own
   * sequencing, and it says so.
   */
  "no-observation",
  /**
   * The submission would now reach somewhere the approval never covered —
   * a changed `action`, a `formaction` override, a different method or a
   * different target.
   */
  "unapproved-recipient",
  /**
   * The page, tab or browser this attempt was driving is gone.
   *
   * Distinct from `stale-document` on purpose, and the distinction is the
   * whole value: a document that moved on leaves a document to read, so the
   * attempt reads it again once before giving up. A closed target leaves
   * nothing, so re-reading is a wasted step and "the document moved" is a
   * report that sends its reader to the wrong place — the guards that compare
   * documents, for a tab that no longer exists.
   */
  "target-closed",
  /**
   * The plan says this login happens in a frame at a named origin, and no
   * such frame is on the page. Failing closed matters more here than most
   * places: the alternative is quietly acting in the embedding document,
   * which is a different origin with a different form, and the whole point
   * of naming the frame was that it is not that one.
   */
  "frame-missing",
  /**
   * More than one frame answers to the named origin, so "the frame" does not
   * identify a document. Choosing one would approve a position rather than a
   * thing, which is the failure every guard in `browser-targets.ts` exists to
   * prevent, one level up: a page that can add a second frame at an origin
   * could choose which document a credential is typed into.
   */
  "frame-ambiguous",
  /**
   * The page opened a window somewhere the plan does not admit. Nothing in
   * it is read, let alone acted in. A window is the page choosing where the
   * next document lives, and an origin the plan never named does not become
   * admitted by being opened rather than navigated to.
   */
  "popup-undeclared",
  /**
   * More than one window the page opened answers to an admitted origin, so
   * "the window" does not identify a document. The refusal frames make, one
   * level up: a page that can open two windows could choose which one a
   * credential is typed into.
   */
  "popup-ambiguous",
  /**
   * A device authorization (RFC 8628) verification page asks for the user
   * code shown on a device, and this plan was not given it. The code is on
   * the device, so a person holding it enters it; nothing on the page can.
   */
  "device-code-required",
  /**
   * A required choice - a country, an organisation - that the plan provided
   * no value for. Choosing on somebody's behalf is not something to guess at.
   */
  "choice-required",
  /**
   * A box accepting terms, a privacy policy or an age attestation that the
   * plan carries no advance consent for, or a required marketing opt-in, and
   * nobody to tick it. Accepting on somebody's behalf is a legal act, never a
   * form detail.
   */
  "consent-required",
] as const;
export const blockedReasonSchema = z.enum(blockedReasons);
export type BlockedReason = z.infer<typeof blockedReasonSchema>;

/**
 * One step. `note` is a public status line shown to a human; the driver rejects
 * any note that reproduces a supplied secret rather than trusting the author.
 */
export const driverActionSchema = z.strictObject({
  action: z.enum([
    "fill",
    "click",
    "check",
    "select",
    "wait",
    "done",
    "blocked",
  ]),
  element: z.number().int().nonnegative().optional(),
  role: ceremonyRoleSchema.optional(),
  /**
   * For `select`: the visible label of the option to choose, exactly as the
   * snapshot lists it. Something the page shows, never a value code
   * substitutes, so nothing secret can travel through it.
   */
  option: z.string().max(100).optional(),
  reason: blockedReasonSchema.optional(),
  note: z.string().max(200).optional(),
});
export type DriverAction = z.infer<typeof driverActionSchema>;

export type CeremonyOutcome =
  | { status: "completed"; steps: number; callback?: CeremonyCallback }
  | { status: "blocked"; reason: BlockedReason; steps: number }
  /** The step budget ran out with the ceremony still incomplete. */
  | { status: "exhausted"; steps: number }
  /** Repeated actions stopped changing the page; the driver stops instead of hanging. */
  | { status: "stalled"; steps: number };

/** Redirect parameters captured from the browser, never from a snapshot. */
export type CeremonyCallback = { code: string; state?: string };

/**
 * Steps a transcript can record. `handoff` is the driver's own, never an
 * interpreter's: asking a person to take part is not an inference decision.
 */
/**
 * What a transcript entry records. `handoff` is a person being brought in;
 * `reobserve` is the page having been replaced under an approval, so the
 * attempt read it again instead of ending; `kept` is every issued value the
 * plan declared having been read and handed to its sink, named by kind and
 * never by value. None is something an interpreter proposed, which is why
 * they are not `DriverAction`s.
 */
export type CeremonyStepAction =
  DriverAction["action"] | "handoff" | "reobserve" | "kept";

/** One transcript entry. Values are excluded, so this is safe to persist. */
export type CeremonyStep = {
  path: string;
  action: CeremonyStepAction;
  role?: CeremonyRole;
  reason?: BlockedReason;
  note?: string;
  /**
   * On a `check`: the legal acts ticking that box performed under the plan's
   * advance consent. Kinds, never page text, so a transcript says "accepted
   * the terms" without repeating the provider's wording.
   */
  consent?: ConsentKind[];
};

const alertSelector =
  '[role="alert"],[role="alertdialog"],.alert-danger,.invalid-feedback,.form-error,.error-message,.field-error,[data-error]';
const challengeSelector =
  '[data-captcha],[data-challenge],.g-recaptcha,.h-captcha,.cf-turnstile,iframe[title*="recaptcha" i],iframe[title*="challenge" i],iframe[src*="captcha" i]';
/**
 * The WebAuthn autocomplete hint is a real published signal a page gives for
 * conditional passkey UI, so detecting it is reading the page rather than
 * guessing at its wording.
 */
const passkeySelector =
  '[autocomplete~="webauthn"],[data-webauthn],[data-passkey]';

/**
 * Build a snapshot from a live document.
 *
 * This function must stay self-contained: `createPlaywrightCeremonyPage` ships
 * its source into the page with `evaluate`, so it may not reference anything
 * outside its own body apart from the two selector arguments. It runs unchanged
 * against a real browser DOM and against a parsed document in Node, which is
 * what lets one contract suite cover both.
 */
export function snapshotDocument(
  doc: Document,
  selectors: { alerts: string; challenge: string; passkey: string },
  onElement?: (element: Element, index: number) => void,
): PageSnapshot {
  const trim = (value: string | null | undefined, max: number) =>
    (value ?? "").replace(/\s+/g, " ").trim().slice(0, max);
  const labelFor = (element: Element): string => {
    const aria = trim(element.getAttribute("aria-label"), 200);
    if (aria) return aria;
    // `aria-labelledby` is a list of ids whose text is joined, not one id.
    // Passing the whole value to getElementById finds nothing when a label is
    // assembled from several elements, leaving the field unnamed.
    const labelledBy = element.getAttribute("aria-labelledby");
    if (labelledBy) {
      const named = labelledBy
        .split(/\s+/)
        .filter(Boolean)
        .map((id) => doc.getElementById(id)?.textContent ?? "")
        .filter(Boolean)
        .join(" ");
      if (named) return trim(named, 200);
    }
    const id = element.getAttribute("id");
    if (id && /^[A-Za-z][\w:.-]*$/.test(id)) {
      const explicit = doc.querySelector(`label[for="${id}"]`);
      if (explicit) return trim(explicit.textContent, 200);
    }
    const wrapping = element.closest("label");
    if (wrapping) return trim(wrapping.textContent, 200);
    return "";
  };
  /** The page's own address. A document parsed in Node carries it as an attribute. */
  const href =
    doc.defaultView?.location?.href ??
    doc.documentElement.getAttribute("data-ceremony-href") ??
    "";
  let path = "";
  try {
    const here = new URL(href);
    path = `${here.origin}${here.pathname}`;
  } catch {
    path = "";
  }
  const elements: SnapshotElement[] = [];
  const controls = doc.querySelectorAll(
    "input,select,textarea,button,a[href],[role='button'],[role='link']",
  );
  const seen = new Set<Element>();
  for (const control of Array.from(controls)) {
    if (elements.length >= 60) break;
    if (seen.has(control)) continue;
    seen.add(control);
    const style =
      typeof globalThis.getComputedStyle === "function"
        ? globalThis.getComputedStyle(control)
        : undefined;
    if (style && (style.display === "none" || style.visibility === "hidden"))
      continue;
    const tag = control.tagName.toLowerCase();
    const rawType = (control.getAttribute("type") ?? "").toLowerCase();
    if (tag === "input" && rawType === "hidden") continue;
    const entry = snapshotControl(control, elements.length, tag, rawType);
    if (onElement) onElement(control, entry.index);
    elements.push(entry);
  }
  // Values a page shows rather than asks for. A provider that has just
  // generated a personal access token often prints it in a `<code>` or
  // `<pre>` block beside a copy button, not in a field. Such a block is
  // described like a read-only field - its label and whether it shows
  // anything, never its text - and only when it is labelled: by
  // `aria-label`, `aria-labelledby`, a `<label for>`, or a heading or label
  // right before it. An unlabelled block is page prose, and not described.
  //
  // A label that contains the block's own text is no label: it would carry
  // the value into the snapshot. A wrapping `<label>` always would, so it is
  // not consulted here at all.
  const shownLabel = (block: Element): string => {
    const own = (element: Element): string => {
      const aria = trim(element.getAttribute("aria-label"), 200);
      if (aria) return aria;
      const labelledBy = element.getAttribute("aria-labelledby");
      if (labelledBy) {
        const named = labelledBy
          .split(/\s+/)
          .filter(Boolean)
          .map((id) => doc.getElementById(id)?.textContent ?? "")
          .filter(Boolean)
          .join(" ");
        if (named) return trim(named, 200);
      }
      const id = element.getAttribute("id");
      if (id && /^[A-Za-z][\w:.-]*$/.test(id)) {
        const explicit = doc.querySelector(`label[for="${id}"]`);
        if (explicit) return trim(explicit.textContent, 200);
      }
      return "";
    };
    const inner =
      block.tagName.toLowerCase() === "pre"
        ? block.querySelector("code")
        : null;
    let label = own(block) || (inner ? own(inner) : "");
    if (!label) {
      const before = block.previousElementSibling;
      if (before && /^(h[1-6]|label)$/i.test(before.tagName))
        label = trim(before.textContent, 200);
    }
    const shown = trim(block.textContent, 4096);
    return shown.length >= 4 && label.includes(shown) ? "" : label;
  };
  for (const block of Array.from(doc.querySelectorAll("pre,code"))) {
    if (elements.length >= 60) break;
    if (block.tagName.toLowerCase() === "code" && block.closest("pre"))
      continue;
    const style =
      typeof globalThis.getComputedStyle === "function"
        ? globalThis.getComputedStyle(block)
        : undefined;
    if (style && (style.display === "none" || style.visibility === "hidden"))
      continue;
    const label = shownLabel(block);
    if (!label) continue;
    const entry: SnapshotElement = {
      index: elements.length,
      kind: "input",
      type: "code",
      label,
      readOnly: true,
      filled: trim(block.textContent, 1).length > 0,
    };
    if (onElement) onElement(block, entry.index);
    elements.push(entry);
  }
  function snapshotControl(
    control: Element,
    index: number,
    tag: string,
    rawType: string,
  ): SnapshotElement {
    const label = labelFor(control);
    const name = trim(control.getAttribute("name"), 128);
    const placeholder = trim(control.getAttribute("placeholder"), 200);
    const text = trim(control.textContent, 200);
    const value =
      (control as { value?: string }).value ??
      control.getAttribute("value") ??
      "";
    const checked =
      (control as { checked?: boolean }).checked === true ||
      control.hasAttribute("checked");
    const required =
      control.hasAttribute("required") ||
      control.getAttribute("aria-required") === "true";
    const entry = controlState();
    if (entry.kind === "input" || entry.kind === "checkbox")
      entry.type = rawType || (tag === "textarea" ? "textarea" : "text");
    if (name) entry.name = name;
    const autocomplete = trim(
      control.getAttribute("autocomplete"),
      64,
    ).toLowerCase();
    if (autocomplete && entry.kind === "input")
      entry.autocomplete = autocomplete;
    if (label) entry.label = label;
    // What a checkbox agrees to is often not in its label. The terms may sit
    // in the element `aria-describedby` names, or in plain text beside the
    // box with no `<label>` at all - "<input type=checkbox><span>I agree to
    // the Terms</span>" - which left the box unnamed and read as agreeing to
    // nothing. For a checkbox those words are what it is described by, so
    // they are part of what the snapshot says about it.
    if (entry.kind === "checkbox") {
      const described = trim(
        (control.getAttribute("aria-describedby") ?? "")
          .split(/\s+/)
          .filter(Boolean)
          .map((id) => doc.getElementById(id)?.textContent ?? "")
          .join(" "),
        200,
      );
      const beside = (): string => {
        // The text right after the box, or - when the box is alone in its
        // wrapper - right after the wrapper. Never a control's own words.
        const after = (node: Node | null): string => {
          for (let next = node; next; next = next.nextSibling) {
            if (next.nodeType === 3) {
              const words = trim(next.textContent, 200);
              if (words) return words;
              continue;
            }
            if (next.nodeType !== 1) continue;
            const element = next as Element;
            if (
              /^(input|select|textarea|button)$/i.test(element.tagName) ||
              element.querySelector("input,select,textarea,button")
            )
              return "";
            return trim(element.textContent, 200);
          }
          return "";
        };
        const own = after(control.nextSibling);
        if (own) return own;
        const parent = control.parentElement;
        return parent &&
          parent.children.length === 1 &&
          !/^(form|body|label)$/i.test(parent.tagName)
          ? after(parent.nextSibling)
          : "";
      };
      const words = trim(
        [label || beside(), described].filter(Boolean).join(" "),
        200,
      );
      if (words) entry.label = words;
    }
    if (placeholder) entry.placeholder = placeholder;
    if (entry.kind === "button" || entry.kind === "link") {
      const caption =
        text ||
        label ||
        trim(control.getAttribute("value"), 200) ||
        trim(control.getAttribute("title"), 200);
      if (caption) entry.text = caption;
    }
    if (required) entry.required = true;
    if (
      entry.kind === "input" &&
      ((control as { readOnly?: boolean }).readOnly === true ||
        control.hasAttribute("readonly"))
    )
      entry.readOnly = true;
    const action = control.closest("form")?.getAttribute("action");
    if (action) {
      try {
        const target = new URL(action, href);
        if (target.origin !== new URL(href).origin)
          entry.submitsTo = target.origin;
      } catch {
        entry.submitsTo = "unknown";
      }
    }

    function controlState(): SnapshotElement {
      const entry: SnapshotElement = { index, kind: "input" };
      if (tag === "input" && (rawType === "checkbox" || rawType === "radio")) {
        entry.kind = "checkbox";
        entry.filled = checked;
      } else if (tag === "select") {
        entry.kind = "select";
        // Each option by its label - what a browser shows and what
        // Playwright's `selectOption({ label })` matches - which is the
        // option's own text unless a `label` attribute overrides it.
        entry.options = Array.from(control.querySelectorAll("option"))
          .slice(0, 20)
          .map((option) => {
            const shown = (option as { label?: unknown }).label;
            return trim(
              typeof shown === "string" && shown !== ""
                ? shown
                : option.getAttribute("label") || option.textContent,
              100,
            );
          });
        entry.filled = value.length > 0;
      } else if (
        tag === "button" ||
        rawType === "submit" ||
        rawType === "button"
      )
        entry.kind = "button";
      else if (tag === "a" || control.getAttribute("role") === "link")
        entry.kind = "link";
      else {
        entry.kind = "input";
        entry.filled = value.length > 0;
      }
      return entry;
    }
    return entry;
  }
  const headings = Array.from(doc.querySelectorAll("h1,h2,h3,legend"))
    .slice(0, 8)
    .map((heading) => trim(heading.textContent, 200))
    .filter((heading) => heading.length > 0);
  const alerts = Array.from(doc.querySelectorAll(selectors.alerts))
    .slice(0, 8)
    .map((alert) => trim(alert.textContent, 300))
    .filter((alert) => alert.length > 0);
  return {
    path,
    title: trim(doc.title, 200),
    headings,
    alerts,
    challenge: doc.querySelector(selectors.challenge) !== null,
    passkey: doc.querySelector(selectors.passkey) !== null,
    elements,
  };
}

/** Selector arguments for {@link snapshotDocument}, shared by every adapter. */
export const snapshotSelectors = {
  alerts: alertSelector,
  challenge: challengeSelector,
  passkey: passkeySelector,
} as const;

/**
 * Source that evaluates {@link snapshotDocument} inside a live page and stamps
 * each captured element with its index, so a later action addresses exactly the
 * element the interpreter saw.
 *
 * The function is shipped as text, which means it arrives compiled. A compiler
 * that preserves function names — esbuild's `keepNames`, which tsx turns on —
 * emits calls to a `__name` helper that exists in the bundle but not in the
 * page, so the shim is supplied alongside it. Without that, whether the
 * snapshot works at all depends on which tool compiled the caller.
 */
export function snapshotPageSource(indexAttribute: string): string {
  return `(() => {
    const __name = (value) => value;
    for (const stale of document.querySelectorAll('[${indexAttribute}]'))
      stale.removeAttribute('${indexAttribute}');
    const snapshot = ${snapshotDocument.toString()};
    return snapshot(document, ${JSON.stringify(snapshotSelectors)}, (element, index) =>
      element.setAttribute('${indexAttribute}', String(index)));
  })()`;
}

/**
 * Where a control's owning form would actually deliver, captured when the page
 * was observed and recomputed immediately before the driver acts.
 *
 * A form's destination is not fixed by its `action` attribute alone: a
 * submitter's `formaction`, `formmethod` and `formtarget` override it, a `base`
 * element changes how a relative action resolves, and an input can be
 * re-associated with a different form entirely. Approving a submission and then
 * reading the destination again at action time is the only way to notice any of
 * that happening while a model was thinking or a credential was being fetched.
 */
export type ElementDestination = {
  /** Whether the control belongs to a form at all. */
  form: boolean;
  /** Absolute URL the submission would reach. */
  action?: string;
  method?: string;
  target?: string;
};

/**
 * Source of the destination reader, shared by the observation pass and the
 * revalidation pass so the two can never drift apart and disagree about what
 * "the same destination" means.
 */
export const destinationReaderSource = `((element) => {
  const owner = element.form ?? (element.closest ? element.closest('form') : null);
  if (!owner) return { form: false };
  const has = (name) => typeof element.hasAttribute === 'function' && element.hasAttribute(name);
  return {
    form: true,
    action: String(has('formaction') ? element.formAction : owner.action),
    method: String(has('formmethod') ? element.formMethod : (owner.method || 'get')).toLowerCase(),
    target: String(has('formtarget') ? element.formTarget : (owner.target || '')),
  };
})`;

/**
 * Observe a document and hand the *element objects* back to the driver rather
 * than stamping the page with attributes that address them.
 *
 * `snapshotPageSource` writes `data-ceremony-index` on each captured control
 * and a later action finds that element again with a selector. A page can move,
 * duplicate or forge that attribute between the two, so the element acted on
 * need not be the element that was approved. This source instead returns live
 * references: the caller holds them outside the page, and no amount of DOM
 * rewriting can make one of them point somewhere else.
 *
 * The result is only useful to a caller that can hold JavaScript references —
 * an `evaluateHandle`, not an `evaluate`. Returning it by value would serialize
 * the elements away and defeat the entire point.
 */
export function boundSnapshotSource(): string {
  return `(() => {
    const __name = (value) => value;
    const snapshot = ${snapshotDocument.toString()};
    const destination = ${destinationReaderSource};
    const usable = ${elementUsableSource};
    const sameForm = ${sameFormSource};
    const readOnlyValue = ${readOnlyValueSource};
    const elements = [];
    const forms = [];
    const result = snapshot(document, ${JSON.stringify(snapshotSelectors)}, (element, index) => {
      elements[index] = element;
      forms[index] = element.form ?? (element.closest ? element.closest('form') : null);
    });
    return {
      snapshot: result,
      elements,
      forms,
      destinations: elements.map((element) => destination(element)),
      /**
       * The document node itself. Comparing it later against the live
       * document is what detects a navigation that stayed on the same
       * origin — the case an origin comparison cannot see and a selector would
       * happily resolve against the new page.
       */
      document,
      origin: location.origin,
      href: location.href,
      /**
       * The revalidation checks, defined here so the rules applied when an
       * action is about to happen are literally the same code that described
       * the page in the first place. They live on an object the driver holds a
       * reference to and the page never receives, so they cannot be replaced.
       */
      destination,
      usable,
      sameForm,
      readOnlyValue,
      /**
       * Whether the page still shows the document this observation describes.
       * Defined here, where \`document\` means the live one, so the driver
       * never has to reach for a page global it does not have.
       */
      sameDocument: function () { return this.document === document; },
    };
  })()`;
}

/** Whether a held document node is still the document the page is showing. */
export const sameDocumentSource = `((held) => held === document)`;

/**
 * Whether a control is still one the driver may act on: present in the live
 * tree, visible, and not disabled or read-only. Evaluated against a held
 * reference, so a replacement element fails it rather than inheriting approval.
 */
export const elementUsableSource = `((element) => {
  if (!element || !element.isConnected) return false;
  if (element.disabled === true || element.readOnly === true) return false;
  const rects = typeof element.getClientRects === 'function' ? element.getClientRects() : [];
  if (rects.length === 0) return false;
  const style = typeof getComputedStyle === 'function' ? getComputedStyle(element) : undefined;
  return !style || (style.visibility !== 'hidden' && style.display !== 'none');
})`;

/**
 * The value a held, read-only field displays, or `null` for any other control.
 *
 * Read-only is the whole point. It is what makes the value one the page
 * *shows* — a provider displaying an issued secret — rather than one somebody
 * typed: the driver never fills a read-only control (`elementUsableSource`
 * refuses it), so no field the attempt itself filled can be read back out
 * through here. A page can still copy a typed value into a read-only field of
 * its own; the driver refuses such a value when it compares each read against
 * what it substituted. A hidden or invisible field is not a value the page is
 * showing anyone, so it is not read either.
 */
export const readOnlyValueSource = `((element) => {
  if (!element || !element.isConnected) return null;
  const tag = String(element.tagName || '').toLowerCase();
  const block = tag === 'code' || tag === 'pre';
  if (tag !== 'input' && tag !== 'textarea' && !block) return null;
  if (!block && (element.readOnly !== true || element.disabled === true)) return null;
  if (!block && String(element.type || '').toLowerCase() === 'hidden') return null;
  const rects = typeof element.getClientRects === 'function' ? element.getClientRects() : [];
  if (rects.length === 0) return null;
  const style = typeof getComputedStyle === 'function' ? getComputedStyle(element) : undefined;
  if (style && (style.visibility === 'hidden' || style.display === 'none')) return null;
  if (block) return String(element.textContent || '').trim();
  return typeof element.value === 'string' ? element.value : null;
})`;

/** Whether a held control still belongs to the exact form it was approved in. */
export const sameFormSource = `((element, form) => {
  const owner = element.form ?? (element.closest ? element.closest('form') : null);
  return owner === form;
})`;

/** Two destinations agree only if every operative part of them agrees. */
export function sameDestination(
  approved: ElementDestination,
  current: ElementDestination,
): boolean {
  return (
    approved.form === current.form &&
    approved.action === current.action &&
    approved.method === current.method &&
    approved.target === current.target
  );
}

/**
 * Why a person, or a future owning-app resolver, has to take part. Read from
 * the page or the response, never inferred from prose.
 */
export const humanStepReasons = [
  "human-challenge",
  "passkey",
  "native-dialog",
  /**
   * A device authorization verification page, where the user code shown on a
   * device has to be entered and the plan was not given it. The request's
   * `path` is the verification URI: origin and pathname, never the
   * `verification_uri_complete` query that carries the code.
   */
  "device-code",
  /** A required choice the plan provided no value for. */
  "choice",
  /**
   * A box accepting a provider's terms, privacy policy or an age attestation
   * that the plan carries no advance consent for, or a required marketing
   * opt-in. Ticking one is a legal act on the person's behalf, so it is the
   * person's to tick.
   */
  "consent",
] as const;
export type HumanStepReason = (typeof humanStepReasons)[number];

/**
 * What a person may consent to in advance, so that a login ticks the box
 * saying so on their behalf.
 *
 * Accepting a provider's terms of service or privacy policy, or attesting to
 * being old enough, is a legal act. An agent does not get to perform one
 * because the form happens to need it: it performs one only when the plan
 * carries the person's explicit consent for that kind, set by the person, part
 * of the plan's digest and of any recording's review. Nothing a model says and
 * no agent tool can add one.
 *
 * Marketing and newsletter opt-ins are deliberately not a kind. There is no
 * advance consent that ticks one: a person who wants the newsletter can tick
 * it themselves.
 */
export const consentKinds = ["terms", "privacy", "age"] as const;
export const consentKindSchema = z.enum(consentKinds);
export type ConsentKind = z.infer<typeof consentKindSchema>;

/**
 * A set of consent kinds, as a plan or a recording carries one: no repeats,
 * so two that say the same thing digest the same once sorted.
 */
export const consentKindsSchema = z
  .array(consentKindSchema)
  .max(consentKinds.length)
  .refine(
    (kinds) => new Set(kinds).size === kinds.length,
    "Duplicate consent kind",
  );

/** Consent kinds in their canonical order, so equal sets are equal bytes. */
export function sortedConsent(kinds: readonly ConsentKind[]): ConsentKind[] {
  return consentKinds.filter((kind) => kinds.includes(kind));
}

/** What a checkbox asks a person to agree to, read from its own words. */
export type CheckboxConsent = {
  /** The legal acts ticking it performs. Empty for an ordinary box. */
  kinds: ConsentKind[];
  /**
   * The box opts into marketing or a newsletter, alone or bundled with
   * anything else. Never ticked by an agent, whatever the plan says.
   */
  marketing: boolean;
  /**
   * The box says nothing a person could read - no label, no caption, at
   * most a `name`. What ticking it agrees to cannot be told, so it is the
   * person's to tick, never a form detail.
   */
  unlabelled: boolean;
};

/**
 * Opt-ins that are nobody's to give: marketing, newsletters, being contacted,
 * and sharing the person's data with partners. "I agree" is how these are
 * worded too - and they are usually bundled into the terms sentence ("I agree
 * to the Terms and to receive emails from us") - so a box naming one is never
 * read as terms alone. Deliberately broad: a false positive leaves a box for
 * the person, a false negative signs them up.
 */
const marketingWords =
  /newsletter|marketing|promot|special offers|\boffers\b|\bupdates\b|\bnews\b|\btips\b|\bfeatures\b|subscribe|partners|third[- ]part(y|ies)|share my (data|information)|receiv(e|ing) (e-?mails?|communications?|messages?|news|updates|offers|information|texts?|sms|calls?)|(e-?mail|send|text|call|message) me|\bcontact(ed)? (me|by)|keep me (informed|updated|posted|in the loop)|hear (about|from|more)|communications? from/i;
const consentWords: Readonly<Record<ConsentKind, RegExp>> = {
  // A bare "I agree" or "I accept" is read as terms: it is the conservative
  // reading, since it asks a person rather than ticking.
  terms:
    /terms|conditions|\btos\b|\beula\b|user agreement|acceptable use|\bagree\b|\baccept (our|the|all)\b|\bi accept\b|i have read|i('ve| have) (read|reviewed)/i,
  privacy: /privacy|data (processing|protection)|personal data|cookie/i,
  age: /old enough|years of age|\b(1[3-9]|2[01]) ?(\+|years|or (older|over))|of (legal )?age|age of (majority|consent)|\b(over|at least) (1[3-9]|2[01])\b|minimum age/i,
};

/**
 * What ticking a checkbox would agree to, from the words the page shows for
 * it.
 *
 * Shared by the model-free interpreter, which decides whether to tick, and by
 * the driver, which refuses any interpreter's tick the plan did not consent
 * to - so a model reading the same box differently cannot tick it anyway. It
 * errs toward consent on purpose: a false positive asks a person to tick an
 * ordinary box, a false negative would perform a legal act nobody agreed to.
 */
export function checkboxConsent(
  element: Pick<SnapshotElement, "label" | "text" | "name" | "placeholder">,
): CheckboxConsent {
  // Separators read as spaces, so a `name` such as `accept_tos` or
  // `agree-terms` says what it is as plainly as a label would.
  const text = [element.label, element.text, element.name, element.placeholder]
    .filter((part): part is string => typeof part === "string")
    .join(" ")
    .replace(/[_\-.:[\]]+/g, " ");
  return {
    kinds: consentKinds.filter((kind) => consentWords[kind].test(text)),
    marketing: marketingWords.test(text),
    unlabelled: !(element.label || element.text || element.placeholder),
  };
}

/**
 * Whether a plan's advance consent covers ticking this box. A marketing
 * opt-in is never covered; a box naming several kinds needs every one.
 */
export function consentCovers(
  consent: CheckboxConsent,
  given: readonly ConsentKind[],
): boolean {
  return (
    !consent.marketing &&
    !consent.unlabelled &&
    consent.kinds.every((kind) => given.includes(kind))
  );
}

/** Whether ticking this box is a person's decision rather than a form detail. */
export function needsConsent(consent: CheckboxConsent): boolean {
  return consent.marketing || consent.unlabelled || consent.kinds.length > 0;
}

/**
 * Wording that names a device authorization verification page, read from the
 * title and headings. RFC 8628 leaves the page to the provider, so what is
 * recognised is what providers commonly put around the user code: "Enter the
 * code displayed on your device", "Activate your device", "Connect a device".
 */
const devicePageWords =
  /(enter|type) the code (shown|displayed) on (your|the) (device|screen|tv)|code (shown|displayed) on your device|connect (a|your) device|activate (a |your )?(device|tv)|device (activation|authori[sz]ation|login|sign[- ]?in|verification)|link (a|your) device/i;
/** Wording that names a sign-in identifier, which a user code never is. */
const identifierWords =
  /user\s?name|e-?mail|login|account|sign[- ]?in|phone|mobile|handle|^user$|^identifier$/i;
/** Wording that names the user code field itself. */
const userCodeWords =
  /\b(user|device|pairing|activation)[ _-]?code\b|code (shown|displayed) on (your|the) (device|screen|tv)|^user_?code$/i;

/**
 * The field a device authorization verification page asks for the user code
 * in, or `undefined` when this is not such a page.
 *
 * Shared by the heuristic, which fills it only with a `user-code` the plan
 * supplied, and by the driver, which checks an interpreter's report that the
 * page needs a person against it. A field alone is not enough - "device code"
 * appears on settings pages too - so the page has to say what it is, or the
 * field has to carry the RFC's own parameter name, `user_code`. A page with a
 * password box is a sign-in page whatever its heading says, and a read-only
 * field shows a value rather than asking for one.
 */
export function deviceVerificationField(
  snapshot: PageSnapshot,
): SnapshotElement | undefined {
  if (
    snapshot.elements.some(
      (element) => element.kind === "input" && element.type === "password",
    )
  )
    return undefined;
  // An identifier field is never the code field, however the page is
  // headed: "Connect a device" above a lone email box is the sign-in step
  // before the verification page, and a user code typed there goes to the
  // provider as somebody's address.
  const typed = snapshot.elements.filter((element) => {
    if (element.kind !== "input" || element.readOnly === true) return false;
    if (element.type === "email" || element.type === "tel") return false;
    if (/\b(username|email)\b/.test(element.autocomplete ?? "")) return false;
    return ![element.name, element.label, element.placeholder].some(
      (text) => text !== undefined && identifierWords.test(text),
    );
  });
  const page = devicePageWords.test(
    `${snapshot.title} ${snapshot.headings.join(" ")}`,
  );
  const named = typed.filter((element) =>
    [element.name, element.label, element.placeholder].some(
      (text) => text !== undefined && userCodeWords.test(text),
    ),
  );
  if (
    named.length === 1 &&
    (page || /^user_?code$/i.test(named[0]!.name ?? ""))
  )
    return named[0];
  if (page && named.length === 0 && typed.length === 1) return typed[0];
  return undefined;
}
