import { z } from "zod";
import {
  blockedReasonSchema,
  ceremonyGoalSchema,
  ceremonyRoleSchema,
  secretRoles,
  type CeremonyGoal,
  type CeremonyRole,
  type PageSnapshot,
  type SnapshotElement,
} from "./browser-contracts.js";
import {
  ceremonyPlanSchema,
  type CeremonyPlan,
  type PlanDatum,
  type PlanStep,
} from "./ceremony-plan.js";
import { identifierSchema } from "./operation-contracts.js";

/**
 * A recorded ceremony: the steps a login actually took at a provider, written
 * down so the same login can run again later with no model in the loop.
 *
 * A {@link CeremonyPlan} says what getting in *requires*. It has no actions,
 * so nothing can execute one. This is its executable sibling: an ordered list
 * of "on this page, do this to that control", captured while the login driver
 * completed a real login and replayed deterministically afterwards. It is what
 * "the AI recorded a new ceremony" means for a provider the code has never
 * seen, without generating code or embedding an endpoint: the artifact is
 * data, the executor is the same driver that owns every safety rule, and a
 * person publishes it before anyone else's login may use it.
 *
 * What it can never carry is a value. That is structural rather than a
 * convention:
 *
 * - There is no field that holds one. A fill names a *role* (`password`,
 *   `totp-code`) and the driver resolves it from the credential source at the
 *   moment of filling, exactly as it does for a model-chosen action.
 * - Every piece of provider text it keeps — a label, a caption, a placeholder
 *   — is refused when it looks like a value: an address, a run of digits, a
 *   base32 seed, an `otpauth:` URI or a long token. A page that prints the
 *   signed-in address on its "Continue as …" button costs the recording that
 *   descriptor, never the other way round.
 * - Pages are origin and path pattern. There is no query string, which is
 *   where a login hint, a state or a code would otherwise ride along.
 * - Every origin it mentions has to be declared in `origins`, and a replay
 *   refuses a recording whose origins the login plan did not admit.
 */

export const RECORDING_LIMITS = Object.freeze({
  bytes: 64 * 1024,
  steps: 32,
  branches: 8,
  success: 4,
  origins: 8,
  text: 120,
});

/**
 * Text that should not be in a value-free artifact.
 *
 * Deliberately broad. A false positive drops one descriptor from a
 * fingerprint, which costs a little robustness; a false negative puts a
 * person's address or a code into something that is shared and reviewed.
 */
const valuePatterns: readonly RegExp[] = [
  // An address, the most common thing a page prints back at the person.
  /[^\s@]+@[^\s@]+\.[^\s@]{2,}/,
  // A code, an account number, a phone number.
  /\d{6,}/,
  /otpauth:/i,
  // A bearer-shaped token.
  /[A-Za-z0-9+/_-]{32,}/,
];

export function looksLikeValue(text: string): boolean {
  if (valuePatterns.some((pattern) => pattern.test(text))) return true;
  // A base32 enrolment seed, grouped, spaced or lower-cased the way enrolment
  // screens print one. Requiring a digit keeps an upper-case caption such as
  // "SIGN INTO YOUR ACCOUNT" from reading as a seed.
  for (const run of text.match(/[A-Za-z2-7]{4,}(?:[\s-]?[A-Za-z2-7]{4,})*/g) ??
    []) {
    const compact = run.replace(/[\s-]/g, "");
    if (compact.length >= 16 && /[2-7]/.test(compact)) return true;
  }
  return false;
}

/**
 * Text a recording may carry: trimmed, bounded and not shaped like a value.
 * Exported so a host can refuse a recording's title where it is asked for,
 * rather than learn after a login that the title cannot be saved.
 */
export const recordingDescriptorTextSchema = z
  .string()
  .min(1)
  .max(RECORDING_LIMITS.text)
  .refine((text) => text === text.trim(), "Descriptor text is trimmed")
  .refine(
    (text) => !looksLikeValue(text),
    "Descriptor text looks like a value",
  );

/**
 * An exact origin. Same rule as the login plan's: scheme, host and port only,
 * HTTPS or the loopback fixture, never a wildcard.
 */
export const recordedOriginSchema = z
  .string()
  .max(512)
  .refine((value) => {
    try {
      const url = new URL(value);
      return (
        url.origin === value &&
        !url.username &&
        !url.password &&
        (url.protocol === "https:" ||
          (url.protocol === "http:" &&
            (url.hostname === "127.0.0.1" || url.hostname === "[::1]")))
      );
    } catch {
      return false;
    }
  }, "Expected an exact origin");

/**
 * A pathname with `*` standing for exactly one segment. No query, no
 * fragment, no `**`: a pattern that could match any depth could match a page
 * the recording never saw.
 */
const pathPatternSchema = z
  .string()
  .max(256)
  .regex(/^\/(?:(?:[A-Za-z0-9._~!$&'()+,;=:@%-]+|\*)(?:\/(?!$)|$))*$/);

/** Where a step happens: an origin and a path pattern on it. */
export const pageMatchSchema = z.strictObject({
  origin: recordedOriginSchema,
  path: pathPatternSchema,
});
export type PageMatch = z.infer<typeof pageMatchSchema>;

/** Input types a fingerprint may name. Anything else is not recorded. */
export const recordableInputTypes = [
  "text",
  "email",
  "password",
  "tel",
  "number",
  "date",
  "search",
  "url",
  "textarea",
  "checkbox",
  "radio",
] as const;

/**
 * How a control is found again: what a person would call it, not where it
 * was. A raw selector is exactly the thing that breaks on the next deploy, so
 * it is not here. `ordinal` of `of` settles the one case the descriptors
 * cannot — two identical "Continue" buttons — and a replay that finds a
 * different number of them stops rather than choosing.
 */
export const elementFingerprintSchema = z
  .strictObject({
    kind: z.enum(["input", "button", "link", "checkbox", "select"]),
    type: z.enum(recordableInputTypes).optional(),
    /** The control's `name` attribute, when it is a plain token. */
    name: z
      .string()
      .regex(/^[A-Za-z][A-Za-z0-9_.:[\]-]{0,63}$/)
      .refine((text) => !looksLikeValue(text))
      .optional(),
    /** The standard `autocomplete` hint, such as `username` or `one-time-code`. */
    autocomplete: z
      .string()
      .regex(/^[a-z][a-z0-9 -]{0,63}$/)
      .optional(),
    /** The accessible name: an ARIA label or the associated `<label>`. */
    label: recordingDescriptorTextSchema.optional(),
    placeholder: recordingDescriptorTextSchema.optional(),
    /** A button's or link's caption. */
    text: recordingDescriptorTextSchema.optional(),
    ordinal: z.number().int().min(0).max(59),
    of: z.number().int().min(1).max(60),
  })
  .superRefine((target, context) => {
    if (target.ordinal >= target.of)
      context.addIssue({ code: "custom", message: "ordinal must be below of" });
    if (identifiersOf(target).length === 0)
      context.addIssue({
        code: "custom",
        message:
          "A fingerprint names the control by at least one stable descriptor",
      });
  });
export type ElementFingerprint = z.infer<typeof elementFingerprintSchema>;

const fingerprintKeys = [
  "name",
  "autocomplete",
  "label",
  "placeholder",
  "text",
] as const;
type FingerprintKey = (typeof fingerprintKeys)[number];

function identifiersOf(
  target: Partial<Record<FingerprintKey, string | undefined>>,
): FingerprintKey[] {
  return fingerprintKeys.filter((key) => target[key] !== undefined);
}

/**
 * What a step does. There is a role to fill and never a value; a click says
 * whether the page is expected to change, so a replay can say "the submit did
 * not navigate" instead of only "the next page is wrong".
 */
export const recordedActionSchema = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("fill"),
    target: elementFingerprintSchema,
    role: ceremonyRoleSchema,
  }),
  z.strictObject({
    kind: z.literal("click"),
    target: elementFingerprintSchema,
    expect: z.enum(["navigation", "same-page"]),
  }),
  z.strictObject({
    kind: z.literal("check"),
    target: elementFingerprintSchema,
  }),
  /** The page was mid-transition; the recording waited for it. */
  z.strictObject({ kind: z.literal("wait-for") }),
]);
export type RecordedAction = z.infer<typeof recordedActionSchema>;

export const recordedStepSchema = z.strictObject({
  id: identifierSchema,
  page: pageMatchSchema,
  action: recordedActionSchema,
  /**
   * The page may not appear on every run. A replay skips an optional step
   * whose page is absent; a required one that is absent is drift.
   */
  optional: z.boolean(),
});
export type RecordedStep = z.infer<typeof recordedStepSchema>;

/**
 * A page that changes what happens next, wherever it appears. Two uses a
 * linear trace cannot express: an interstitial that sometimes appears ("MFA
 * page → continue at the code step") and a page the recording must never try
 * to get past on its own ("account chooser → stop, a person picks").
 */
export const recordedBranchSchema = z.strictObject({
  id: identifierSchema,
  when: pageMatchSchema,
  then: z.discriminatedUnion("do", [
    z.strictObject({ do: z.literal("continue-at"), step: identifierSchema }),
    /** The ceremony is over here; the verifier decides whether it worked. */
    z.strictObject({ do: z.literal("finish") }),
    z.strictObject({ do: z.literal("stop"), reason: blockedReasonSchema }),
  ]),
});
export type RecordedBranch = z.infer<typeof recordedBranchSchema>;

/** A reference to a published version. Integrity, not authority. */
export const recordingReferenceSchema = z.strictObject({
  id: identifierSchema,
  version: z.string().regex(/^\d{1,6}\.\d{1,6}\.\d{1,6}$/),
  digest: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
});
export type RecordingReference = z.infer<typeof recordingReferenceSchema>;

export const recordedCeremonySchema = z
  .strictObject({
    schemaVersion: z.literal(1),
    id: identifierSchema,
    title: recordingDescriptorTextSchema,
    goal: ceremonyGoalSchema,
    /** Where a replay is expected to begin. */
    entry: pageMatchSchema,
    /** Every origin the recording may act on. Nothing else may be named. */
    origins: z.array(recordedOriginSchema).min(1).max(RECORDING_LIMITS.origins),
    /** Every role any step fills, and nothing else. */
    roles: z.array(ceremonyRoleSchema).max(16),
    steps: z.array(recordedStepSchema).min(1).max(RECORDING_LIMITS.steps),
    branches: z.array(recordedBranchSchema).max(RECORDING_LIMITS.branches),
    /** Pages that mean the ceremony finished. */
    success: z.array(pageMatchSchema).max(RECORDING_LIMITS.success),
    /**
     * Who chose the actions when this was captured. A reviewer weighs a
     * model's choices differently from the built-in rules', and a repair is
     * a model's choice on top of an earlier recording.
     */
    recordedWith: z.enum(["deterministic", "host-model", "repair"]),
    /** The published version a repair was made from. */
    basedOn: recordingReferenceSchema.optional(),
  })
  .superRefine((recording, context) => {
    const issue = (message: string) =>
      context.addIssue({ code: "custom", message });
    const origins = new Set(recording.origins);
    if (origins.size !== recording.origins.length) issue("Duplicate origin");
    const declared = (match: PageMatch, where: string) => {
      if (!origins.has(match.origin))
        issue(`${where} names an origin the recording does not declare`);
    };
    declared(recording.entry, "entry");

    const ids = new Set<string>();
    const filled = new Set<CeremonyRole>();
    for (const step of recording.steps) {
      if (ids.has(step.id)) issue(`Duplicate step ${step.id}`);
      ids.add(step.id);
      declared(step.page, `step ${step.id}`);
      const action = step.action;
      if (action.kind === "fill") {
        filled.add(action.role);
        // A value is only ever typed into a field. A secret typed into
        // anything else - a button's caption, a link - is not a login.
        if (action.target.kind !== "input")
          issue(`step ${step.id} fills something that is not a field`);
        if (
          secretRoles.includes(action.role) &&
          action.target.type !== undefined &&
          !["password", "text", "tel", "number", "textarea"].includes(
            action.target.type,
          )
        )
          issue(`step ${step.id} types a secret into a ${action.target.type}`);
      }
      if (action.kind === "check" && action.target.kind !== "checkbox")
        issue(`step ${step.id} checks something that is not a checkbox`);
    }
    if (recording.steps.every((step) => step.optional))
      issue("At least one step is required");

    const roles = new Set(recording.roles);
    if (roles.size !== recording.roles.length) issue("Duplicate role");
    for (const role of filled)
      if (!roles.has(role)) issue(`Role ${role} is filled but not declared`);
    for (const role of roles)
      if (!filled.has(role)) issue(`Role ${role} is declared but never filled`);

    const branchIds = new Set<string>();
    for (const branch of recording.branches) {
      if (branchIds.has(branch.id)) issue(`Duplicate branch ${branch.id}`);
      branchIds.add(branch.id);
      declared(branch.when, `branch ${branch.id}`);
      if (branch.then.do === "continue-at" && !ids.has(branch.then.step))
        issue(`branch ${branch.id} continues at an unknown step`);
    }
    for (const match of recording.success) declared(match, "success page");
  });
export type RecordedCeremony = z.infer<typeof recordedCeremonySchema>;

export function parseRecordedCeremony(text: string): RecordedCeremony {
  if (new TextEncoder().encode(text).byteLength > RECORDING_LIMITS.bytes)
    throw new Error("Recorded ceremony exceeds import limit");
  return recordedCeremonySchema.parse(JSON.parse(text));
}

/** Stable bytes for a recording, so two copies can be compared or pinned. */
export function canonicalRecordedCeremony(recording: unknown): string {
  const parsed = recordedCeremonySchema.parse(recording);
  function canonical(value: unknown): unknown {
    if (Array.isArray(value)) return value.map(canonical);
    if (value !== null && typeof value === "object")
      return Object.fromEntries(
        Object.entries(value)
          .filter(([, item]) => item !== undefined)
          .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
          .map(([key, item]) => [key, canonical(item)]),
      );
    return value;
  }
  const text = JSON.stringify(canonical(parsed));
  if (new TextEncoder().encode(text).byteLength > RECORDING_LIMITS.bytes)
    throw new Error("Recorded ceremony exceeds import limit");
  return text;
}

/**
 * Integrity only. A digest says two recordings are the same bytes; it is not
 * evidence the recording works and conveys no approval — publication does.
 */
export async function digestRecordedCeremony(
  recording: unknown,
): Promise<string> {
  const digest = await globalThis.crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(canonicalRecordedCeremony(recording)),
  );
  return Buffer.from(digest).toString("base64url");
}

/* -------------------------------------------------------------------------- */
/* Matching a live page                                                       */
/* -------------------------------------------------------------------------- */

/** Whether an observed page (origin + pathname, as a snapshot carries it) matches. */
export function matchesPage(match: PageMatch, observed: string): boolean {
  let url: URL;
  try {
    url = new URL(observed);
  } catch {
    return false;
  }
  if (url.origin !== match.origin) return false;
  const want = match.path.split("/");
  // A trailing slash is the same page; the pattern is written without one.
  const pathname =
    url.pathname.length > 1 ? url.pathname.replace(/\/$/, "") : url.pathname;
  const have = pathname.split("/");
  if (want.length !== have.length) return false;
  return want.every(
    (segment, index) => segment === "*" || segment === have[index],
  );
}

/** A readable form of a page match, for drift reports. */
export function describePage(match: PageMatch): string {
  return `${match.origin}${match.path}`;
}

export type LocatedElement =
  { found: SnapshotElement } | { missing: true } | { ambiguous: number };

function typeOf(element: SnapshotElement): string | undefined {
  return element.type &&
    (recordableInputTypes as readonly string[]).includes(element.type)
    ? element.type
    : undefined;
}

/**
 * Find a recorded control on a live page.
 *
 * The kind and input type must agree — a password is never typed into a box
 * that is no longer a password box. Beyond that, a majority of the recorded
 * descriptors must still agree, so a relabelled button or a renamed field is
 * still found while a different control is not. When every descriptor
 * agrees, the number of such controls must be the number recorded, and the
 * ordinal picks among them; when only some agree, exactly one control may.
 * Anything else is reported, never guessed.
 */
export function locateElement(
  target: ElementFingerprint,
  elements: readonly SnapshotElement[],
): LocatedElement {
  const keys = identifiersOf(target);
  const threshold = Math.max(1, Math.ceil(keys.length / 2));
  const scored = elements
    .filter(
      (element) =>
        element.kind === target.kind &&
        (target.type === undefined || typeOf(element) === target.type),
    )
    .map((element) => {
      const own = descriptorsOf(element);
      return {
        element,
        score: keys.filter((key) => own[key] === target[key]).length,
      };
    })
    .filter((entry) => entry.score >= threshold);
  if (scored.length === 0) return { missing: true };
  const best = Math.max(...scored.map((entry) => entry.score));
  const top = scored.filter((entry) => entry.score === best);
  if (best === keys.length) {
    if (top.length !== target.of) return { ambiguous: top.length };
    return { found: top[target.ordinal]!.element };
  }
  if (top.length === 1 && target.of === 1) return { found: top[0]!.element };
  return { ambiguous: top.length };
}

/** The descriptors a snapshot element offers, before any scrubbing. */
function descriptorsOf(
  element: SnapshotElement,
): Partial<Record<FingerprintKey, string>> {
  return {
    ...(element.name ? { name: element.name } : {}),
    ...(element.autocomplete ? { autocomplete: element.autocomplete } : {}),
    ...(element.label ? { label: element.label } : {}),
    ...(element.placeholder ? { placeholder: element.placeholder } : {}),
    ...(element.text ? { text: element.text } : {}),
  };
}

/* -------------------------------------------------------------------------- */
/* Compiling a trace                                                          */
/* -------------------------------------------------------------------------- */

/**
 * One action the driver applied, with the observation it was decided on.
 *
 * The snapshot is the same sanitized, value-free page an interpreter sees, so
 * a trace carries nothing a model was not already allowed to read. It is
 * still an in-process object: only the compiled recording leaves.
 */
export type RecordedTraceEntry = {
  snapshot: PageSnapshot;
  action: "fill" | "click" | "check" | "wait" | "done";
  /** Index into `snapshot.elements`. */
  element?: number;
  role?: CeremonyRole;
};

export const recordingRejectionReasons = [
  /** The login applied no action worth replaying. */
  "empty",
  /** An action happened on an origin the recording was not allowed to name. */
  "undeclared-origin",
  /** A control had nothing stable left to be found by. */
  "unidentifiable-element",
  /** The login took more steps than a recording may hold. */
  "too-long",
  /** A value the login held privately appeared in what would be saved. */
  "protected-value",
  /**
   * What the login did cannot be written in the recording format: a title or
   * id it refuses, or more identical controls than a fingerprint can count.
   */
  "invalid",
] as const;
export type RecordingRejectionReason =
  (typeof recordingRejectionReasons)[number];

export class RecordingRejected extends Error {
  constructor(readonly reason: RecordingRejectionReason) {
    super(`Recording rejected: ${reason}`);
    this.name = "RecordingRejected";
  }
}

export type CompileRecordingOptions = {
  id: string;
  title: string;
  goal: CeremonyGoal;
  entryUrl: string;
  /** Origins the login was permitted to act on. */
  origins: readonly string[];
  recordedWith: RecordedCeremony["recordedWith"];
  basedOn?: RecordingReference;
  /**
   * Values the login resolved — every role, not only the secret ones. Any
   * descriptor containing one is dropped, and the finished artifact is
   * refused outright if one survives anywhere in it.
   *
   * Only the caller that resolved them holds this list; the compiler never
   * returns or stores it.
   */
  excluded: readonly string[];
};

/**
 * Segments that identify an attempt, or a person, rather than a page.
 *
 * Judged on the decoded segment: `alice%40corp.example` is an address, and
 * the encoding is exactly what would otherwise hide it from the value
 * patterns. A segment naming a value the login used is a wildcard rather than
 * the reason the whole recording is refused, since `/users/<name>/password`
 * is an ordinary shape for a page.
 */
function generalizeSegment(
  segment: string,
  excluded: readonly string[],
): string {
  let decoded = segment;
  try {
    decoded = decodeURIComponent(segment);
  } catch {
    // A malformed escape is judged as it stands; the raw checks still apply.
  }
  const forms = [segment.toLowerCase(), decoded.toLowerCase()];
  if (
    excluded.some((value) => forms.some((form) => form.includes(value))) ||
    looksLikeValue(decoded) ||
    /^\d{3,}$/.test(segment) ||
    /^[0-9a-f]{12,}$/i.test(segment) ||
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
      segment,
    ) ||
    segment.length > 40 ||
    looksLikeValue(segment) ||
    !/^[A-Za-z0-9._~!$&'()+,;=:@%-]+$/.test(segment)
  )
    return "*";
  return segment;
}

/** `excluded` are lower-cased values the login used; see {@link generalizeSegment}. */
export function pageMatchOf(
  observed: string,
  excluded: readonly string[] = [],
): PageMatch {
  const url = new URL(observed);
  const segments = url.pathname.split("/").slice(1);
  const trailing = segments.at(-1) === "";
  const path =
    "/" +
    (trailing ? segments.slice(0, -1) : segments)
      .map((segment) => generalizeSegment(segment, excluded))
      .join("/");
  // A pattern holds whole segments: one cut mid-way, or left ending in a
  // slash, would be a page nobody visited, or no pattern at all.
  const bounded =
    path.length <= 256 ? path : path.slice(0, path.lastIndexOf("/", 256));
  return { origin: url.origin, path: bounded || "/" };
}

/**
 * Turn what a successful login did into a recording.
 *
 * Only applied actions count. What an interpreter considered, a refusal, a
 * re-read after a page moved — none of that is the procedure, so none of it
 * is replayed. An exact repeat of the previous action on the same page is
 * dropped too: that is a retry, and replaying a retry is a second submission.
 */
export function compileRecording(
  trace: readonly RecordedTraceEntry[],
  options: CompileRecordingOptions,
): RecordedCeremony {
  const excluded = options.excluded
    .filter((value) => value.length >= 3)
    .map((value) => value.toLowerCase());
  const origins = [...new Set(options.origins.map((o) => new URL(o).origin))];
  const allowed = new Set(origins);
  const clean = (text: string | undefined): string | undefined => {
    if (text === undefined) return undefined;
    const trimmed = text
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, RECORDING_LIMITS.text)
      .trim();
    if (!trimmed || looksLikeValue(trimmed)) return undefined;
    const lower = trimmed.toLowerCase();
    if (excluded.some((value) => lower.includes(value))) return undefined;
    return trimmed;
  };
  const descriptors = (element: SnapshotElement) => {
    const own = descriptorsOf(element);
    const name =
      own.name &&
      /^[A-Za-z][A-Za-z0-9_.:[\]-]{0,63}$/.test(own.name) &&
      clean(own.name) === own.name
        ? own.name
        : undefined;
    const autocomplete =
      own.autocomplete && /^[a-z][a-z0-9 -]{0,63}$/.test(own.autocomplete)
        ? own.autocomplete
        : undefined;
    const result: Partial<Record<FingerprintKey, string>> = {};
    if (name) result.name = name;
    if (autocomplete) result.autocomplete = autocomplete;
    const label = clean(own.label);
    if (label) result.label = label;
    const placeholder = clean(own.placeholder);
    if (placeholder) result.placeholder = placeholder;
    const text = clean(own.text);
    if (text) result.text = text;
    return result;
  };
  const fingerprint = (
    snapshot: PageSnapshot,
    index: number,
  ): ElementFingerprint => {
    const element = snapshot.elements[index];
    if (!element) throw new RecordingRejected("unidentifiable-element");
    const own = descriptors(element);
    if (identifiersOf(own).length === 0)
      throw new RecordingRejected("unidentifiable-element");
    const type = typeOf(element) as ElementFingerprint["type"];
    // The same comparison a replay makes, so `of` counts exactly the controls
    // a replay would consider identical to this one.
    const twins = snapshot.elements.filter((other) => {
      if (other.kind !== element.kind || typeOf(other) !== type) return false;
      const theirs = descriptors(other);
      return fingerprintKeys.every((key) => theirs[key] === own[key]);
    });
    return {
      kind: element.kind,
      ...(type ? { type } : {}),
      ...own,
      ordinal: Math.max(0, twins.indexOf(element)),
      of: Math.max(1, twins.length),
    };
  };

  const steps: RecordedStep[] = [];
  const success: PageMatch[] = [];
  const roles: CeremonyRole[] = [];
  let previousKey = "";
  for (const [position, entry] of trace.entries()) {
    const page = pageMatchOf(entry.snapshot.path, excluded);
    if (!allowed.has(page.origin))
      throw new RecordingRejected("undeclared-origin");
    if (entry.action === "done") {
      if (!success.some((match) => describePage(match) === describePage(page)))
        success.push(page);
      continue;
    }
    let action: RecordedAction;
    if (entry.action === "wait") action = { kind: "wait-for" };
    else {
      const target = fingerprint(entry.snapshot, entry.element ?? -1);
      if (entry.action === "fill") {
        if (!entry.role) throw new RecordingRejected("unidentifiable-element");
        action = { kind: "fill", target, role: entry.role };
        if (!roles.includes(entry.role)) roles.push(entry.role);
      } else if (entry.action === "check") action = { kind: "check", target };
      else {
        const next = trace[position + 1];
        action = {
          kind: "click",
          target,
          expect:
            next && next.snapshot.path !== entry.snapshot.path
              ? "navigation"
              : "same-page",
        };
      }
    }
    const key = JSON.stringify([page, action]);
    if (key === previousKey) continue;
    previousKey = key;
    steps.push({
      id: `step-${steps.length + 1}`,
      page,
      action,
      optional: false,
    });
  }
  if (steps.length === 0) throw new RecordingRejected("empty");
  if (steps.length > RECORDING_LIMITS.steps)
    throw new RecordingRejected("too-long");

  // A page that is both a step and the finish line would end a replay before
  // its first action - an in-place single-page login looks exactly like that.
  // Such a page is left to "every step applied", which the verifier decides.
  const stepPages = new Set(steps.map((step) => describePage(step.page)));
  success.splice(
    0,
    success.length,
    ...success.filter((match) => !stepPages.has(describePage(match))),
  );
  const entry = pageMatchOf(options.entryUrl, excluded);
  const used = new Set([
    entry.origin,
    ...steps.map((step) => step.page.origin),
    ...success.map((match) => match.origin),
  ]);
  const parsed = recordedCeremonySchema.safeParse({
    schemaVersion: 1,
    id: options.id,
    title: options.title,
    goal: options.goal,
    entry,
    origins: origins.filter((origin) => used.has(origin)),
    roles,
    steps,
    branches: [],
    success: success.slice(0, RECORDING_LIMITS.success),
    recordedWith: options.recordedWith,
    ...(options.basedOn ? { basedOn: options.basedOn } : {}),
  } satisfies RecordedCeremony);
  if (!parsed.success) throw new RecordingRejected("invalid");
  const recording = parsed.data;

  // The descriptors were scrubbed one by one. This is the check that does not
  // trust that: a value the login held, anywhere in the finished bytes, and
  // there is no recording.
  const bytes = canonicalRecordedCeremony(recording).toLowerCase();
  if (
    options.excluded.some(
      (value) => value.length >= 4 && bytes.includes(value.toLowerCase()),
    )
  )
    throw new RecordingRejected("protected-value");
  return recording;
}

/* -------------------------------------------------------------------------- */
/* The plan a recording implies                                               */
/* -------------------------------------------------------------------------- */

/**
 * The {@link CeremonyPlan} a recording implies: one plan step per page, the
 * roles it needs as caller-supplied data, and a single path. What discovery
 * describes by reading, a recording describes by having done — so the two can
 * be compared, and a caller can ask a recording the same question it asks a
 * plan: what do I have to be able to supply?
 */
export function ceremonyPlanFromRecording(
  recording: RecordedCeremony,
): CeremonyPlan {
  const steps: PlanStep[] = [];
  const data: Record<string, PlanDatum> = {};
  const keyOf = (role: CeremonyRole) =>
    role.replace(/-([a-z])/g, (_, c: string) => c.toUpperCase());
  let current: { page: string; step: PlanStep } | undefined;
  for (const step of recording.steps) {
    const page = describePage(step.page);
    if (!current || current.page !== page) {
      const planStep: PlanStep = {
        id: `page-${steps.length + 1}`,
        kind: "navigate",
        label: `Continue on ${step.page.path}`.slice(0, 120),
        at: `${step.page.origin}${step.page.path.replace(/\*/g, "_")}`,
        needs: current ? [current.step.id] : [],
        uses: [],
        produces: [],
      };
      steps.push(planStep);
      current = { page, step: planStep };
    }
    if (step.action.kind === "fill") {
      const key = keyOf(step.action.role);
      current.step.kind = "form";
      current.step.label = `Complete the form on ${step.page.path}`.slice(
        0,
        120,
      );
      if (!current.step.uses.includes(key)) current.step.uses.push(key);
      data[key] ??= {
        role: step.action.role,
        secret: secretRoles.includes(step.action.role),
        source: { from: "caller" },
        always: true,
      };
    }
  }
  return ceremonyPlanSchema.parse({
    schemaVersion: 1,
    id: recording.id,
    title: recording.title,
    goal: recording.goal,
    origin: recording.entry.origin,
    data,
    steps,
    paths: [
      {
        id: "recorded",
        label: recording.title,
        steps: steps.map((step) => step.id),
        handoffs: 0,
        when: [],
      },
    ],
  } satisfies CeremonyPlan);
}
