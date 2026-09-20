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

export const snapshotElementSchema = z
  .object({
    index: z.number().int().nonnegative(),
    kind: z.enum(["input", "button", "link", "checkbox", "select"]),
    type: z.string().max(32).optional(),
    name: z.string().max(128).optional(),
    label: z.string().max(200).optional(),
    placeholder: z.string().max(200).optional(),
    text: z.string().max(200).optional(),
    options: z.array(z.string().max(100)).max(20).optional(),
    required: z.boolean().optional(),
    /** Whether the control already holds a value. Never the value itself. */
    filled: z.boolean().optional(),
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
] as const;
export const blockedReasonSchema = z.enum(blockedReasons);
export type BlockedReason = z.infer<typeof blockedReasonSchema>;

/**
 * One step. `note` is a public status line shown to a human; the driver rejects
 * any note that reproduces a supplied secret rather than trusting the author.
 */
export const driverActionSchema = z.strictObject({
  action: z.enum(["fill", "click", "check", "wait", "done", "blocked"]),
  element: z.number().int().nonnegative().optional(),
  role: ceremonyRoleSchema.optional(),
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
 * attempt read it again instead of ending. Neither is something an
 * interpreter proposed, which is why they are not `DriverAction`s.
 */
export type CeremonyStepAction =
  DriverAction["action"] | "handoff" | "reobserve";

/** One transcript entry. Values are excluded, so this is safe to persist. */
export type CeremonyStep = {
  path: string;
  action: CeremonyStepAction;
  role?: CeremonyRole;
  reason?: BlockedReason;
  note?: string;
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
    if (label) entry.label = label;
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
        entry.options = Array.from(control.querySelectorAll("option"))
          .slice(0, 20)
          .map((option) => trim(option.textContent, 100));
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
] as const;
export type HumanStepReason = (typeof humanStepReasons)[number];
