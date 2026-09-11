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
export const ceremonyGoals = ["sign-in", "registration", "authorize"] as const;
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

/** One transcript entry. Values are excluded, so this is safe to persist. */
export type CeremonyStep = {
  path: string;
  action: DriverAction["action"];
  role?: CeremonyRole;
  reason?: BlockedReason;
  note?: string;
};

const alertSelector =
  '[role="alert"],[role="alertdialog"],.alert-danger,.invalid-feedback,.form-error,.error-message,.field-error,[data-error]';
const challengeSelector =
  '[data-captcha],[data-challenge],.g-recaptcha,.h-captcha,.cf-turnstile,iframe[title*="recaptcha" i],iframe[title*="challenge" i],iframe[src*="captcha" i]';

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
  selectors: { alerts: string; challenge: string },
  onElement?: (element: Element, index: number) => void,
): PageSnapshot {
  const trim = (value: string | null | undefined, max: number) =>
    (value ?? "").replace(/\s+/g, " ").trim().slice(0, max);
  const labelFor = (element: Element): string => {
    const aria = trim(element.getAttribute("aria-label"), 200);
    if (aria) return aria;
    const labelledBy = element.getAttribute("aria-labelledby");
    if (labelledBy) {
      const target = doc.getElementById(labelledBy);
      if (target) return trim(target.textContent, 200);
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
    const entry: SnapshotElement = { index: elements.length, kind: "input" };
    if (tag === "input" && (rawType === "checkbox" || rawType === "radio")) {
      entry.kind = "checkbox";
      entry.filled = checked;
    } else if (tag === "select") {
      entry.kind = "select";
      entry.options = Array.from(control.querySelectorAll("option"))
        .slice(0, 20)
        .map((option) => trim(option.textContent, 100));
      entry.filled = value.length > 0;
    } else if (tag === "button" || rawType === "submit" || rawType === "button")
      entry.kind = "button";
    else if (tag === "a" || control.getAttribute("role") === "link")
      entry.kind = "link";
    else {
      entry.kind = "input";
      entry.filled = value.length > 0;
    }
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
    if (onElement) onElement(control, entry.index);
    elements.push(entry);
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
    elements,
  };
}

/** Selector arguments for {@link snapshotDocument}, shared by every adapter. */
export const snapshotSelectors = {
  alerts: alertSelector,
  challenge: challengeSelector,
} as const;
