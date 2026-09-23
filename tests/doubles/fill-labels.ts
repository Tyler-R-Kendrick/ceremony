import type {
  CeremonyRole,
  CeremonyStep,
  DriverAction,
  PageSnapshot,
  SnapshotElement,
} from "../../src/core/browser-contracts.js";
import type { CeremonyInterpreter } from "../../src/server/browser-interpreter.js";

/**
 * Did each value go into the field that asked for it?
 *
 * A ceremony can reach the right outcome with the wrong fills: a password
 * typed into "Email or username", the identifier left empty, and a provider
 * that happens to refuse the result in exactly the way the scenario expected.
 * Outcome assertions cannot see that; a person watching a recording sees
 * nothing else. This checks each fill the driver performed against what the
 * target field says it is for — its visible label, `type`, `autocomplete` and
 * `name` — using the snapshot the interpreter was looking at when it chose.
 *
 * Shared by the contract suite, the browser suite and the demo recorder, so a
 * recording is held to the same rule as a test.
 */

/** One choice: the page as the interpreter saw it, and what it proposed. */
export type Decision = { snapshot: PageSnapshot; action: DriverAction };

/**
 * Wrap an interpreter so every snapshot it saw and every action it proposed is
 * kept, in order. The snapshot is already value-free, so keeping it discloses
 * nothing the interpreter did not already hold.
 */
export function recordDecisions(interpreter: CeremonyInterpreter): {
  interpreter: CeremonyInterpreter;
  decisions: Decision[];
} {
  const decisions: Decision[] = [];
  return {
    decisions,
    interpreter: async (input) => {
      const action = await interpreter(input);
      if (action)
        decisions.push({
          snapshot: structuredClone(input.snapshot),
          action: { ...action },
        });
      return action;
    },
  };
}

type FieldKind = "password" | "email" | "username" | "code" | "name" | "date";

/** What a field says it is for, from every signal a snapshot carries. */
export function fieldKinds(element: SnapshotElement): Set<FieldKind> {
  const text = [element.label, element.placeholder, element.name]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();
  const hint = new Set((element.autocomplete ?? "").split(/\s+/));
  const kinds = new Set<FieldKind>();
  if (
    element.type === "password" ||
    hint.has("current-password") ||
    hint.has("new-password") ||
    /password|passphrase/.test(text)
  )
    kinds.add("password");
  if (element.type === "email" || hint.has("email") || /e-?mail/.test(text))
    kinds.add("email");
  if (
    hint.has("username") ||
    /user\s?name|login|handle|account name|sign[- ]?in name|user id/.test(text)
  )
    kinds.add("username");
  if (hint.has("one-time-code") || /\bcode\b|\botp\b|one[- ]?time/.test(text))
    kinds.add("code");
  if (hint.has("name") || /full name|display name|your name/.test(text))
    kinds.add("name");
  if (element.type === "date" || hint.has("bday") || /birth/.test(text))
    kinds.add("date");
  return kinds;
}

const identifierRoles: readonly CeremonyRole[] = [
  "email",
  "alternate-email",
  "username",
];
const codeRoles: readonly CeremonyRole[] = [
  "verification-code",
  "totp-code",
  "user-code",
];

/** Why this role does not belong in this field, or nothing if it does. */
export function fillMismatch(
  role: CeremonyRole,
  element: SnapshotElement,
): string | undefined {
  const kinds = fieldKinds(element);
  const name = element.label ?? element.placeholder ?? element.name ?? "?";
  const confirm = /confirm|repeat|again|retype|re-?enter|verify/i.test(
    element.label ?? element.placeholder ?? "",
  );
  if (role === "password" || role === "password-confirm") {
    if (!kinds.has("password"))
      return `${role} went into "${name}", which is not a password field`;
    if (kinds.has("email") || kinds.has("username"))
      return `${role} went into "${name}", which also names an identifier`;
    if (role === "password" && confirm)
      return `password went into the confirmation field "${name}"`;
    if (
      role === "password-confirm" &&
      !confirm &&
      element.autocomplete?.includes("new-password") !== true
    )
      return `password-confirm went into "${name}", which is not a confirmation`;
    return undefined;
  }
  if (identifierRoles.includes(role)) {
    if (!kinds.has("email") && !kinds.has("username"))
      return `${role} went into "${name}", which names no identifier`;
    if (kinds.has("password") || kinds.has("code"))
      return `${role} went into "${name}", which asks for a secret`;
    return undefined;
  }
  if (codeRoles.includes(role)) {
    if (!kinds.has("code"))
      return `${role} went into "${name}", which is not a code field`;
    if (kinds.has("password") || kinds.has("email"))
      return `${role} went into "${name}", which asks for something else`;
    return undefined;
  }
  // `display-name` is also the name of the thing a ceremony creates - an
  // application, a token - so any field asking for a name that is not a
  // sign-in identifier or a secret is its field.
  if (
    role === "display-name" &&
    !kinds.has("name") &&
    !(
      /\bname\b/i.test(name) &&
      !kinds.has("username") &&
      !kinds.has("email") &&
      !kinds.has("password")
    )
  )
    return `display-name went into "${name}", which is not a name field`;
  if (role === "birth-date" && !kinds.has("date"))
    return `birth-date went into "${name}", which is not a date field`;
  return undefined;
}

export type FillCheckOptions = {
  /**
   * Every filled field must carry a label. On by default: a page whose
   * inputs have none is not a page to demonstrate on. The randomized
   * layout deliberately serves placeholder-only fields, so its runs turn it
   * off.
   */
  requireLabel?: boolean;
  /**
   * A forward button is never pressed while a required field on the same
   * page is still empty. On by default: an empty identifier going in is the
   * other half of a wrong fill.
   */
  requireFilledBeforeSubmit?: boolean;
};

/** Captions that are not a submission of the form they sit beside. */
const notASubmit =
  /resend|cancel|deny|decline|not now|\bback\b|use a different/i;

/** Every way the fills in a run disagree with the fields they went into. */
export function fillMismatches(
  transcript: readonly CeremonyStep[],
  decisions: readonly Decision[],
  options: FillCheckOptions = {},
): string[] {
  const problems: string[] = [];
  const requireLabel = options.requireLabel ?? true;
  const requireFilled = options.requireFilledBeforeSubmit ?? true;

  // Each fill the driver performed is matched, in order, to the proposal it
  // came from; a proposal the driver discarded has no transcript step.
  let cursor = 0;
  for (const step of transcript) {
    if (step.action !== "fill" || !step.role) continue;
    let found: Decision | undefined;
    while (cursor < decisions.length) {
      const candidate = decisions[cursor++]!;
      if (
        candidate.action.action === "fill" &&
        candidate.action.role === step.role &&
        candidate.snapshot.path === step.path
      ) {
        found = candidate;
        break;
      }
    }
    if (!found) {
      problems.push(
        `a ${step.role} fill at ${step.path} has no recorded decision`,
      );
      continue;
    }
    const element = found.snapshot.elements.find(
      (candidate) => candidate.index === found.action.element,
    );
    if (!element) {
      problems.push(`a ${step.role} fill named an element that was not shown`);
      continue;
    }
    if (requireLabel && !element.label)
      problems.push(
        `${step.role} went into a field with no label (${element.name ?? "unnamed"})`,
      );
    const mismatch = fillMismatch(step.role, element);
    if (mismatch) problems.push(mismatch);
  }

  if (requireFilled)
    for (const { snapshot, action } of decisions) {
      if (action.action !== "click") continue;
      const pressed = snapshot.elements.find(
        (element) => element.index === action.element,
      );
      if (pressed?.kind !== "button" || notASubmit.test(pressed.text ?? ""))
        continue;
      const empty = snapshot.elements.find(
        (element) =>
          element.kind === "input" &&
          element.required === true &&
          element.filled !== true &&
          !element.submitsTo,
      );
      if (empty)
        problems.push(
          `"${pressed.text ?? "a button"}" was pressed with "${
            empty.label ?? empty.name ?? "a required field"
          }" still empty`,
        );
    }
  return problems;
}

/** Throw, naming every mismatch, unless each fill went where it belongs. */
export function assertFillsMatchLabels(
  transcript: readonly CeremonyStep[],
  decisions: readonly Decision[],
  options: FillCheckOptions = {},
): void {
  const problems = fillMismatches(transcript, decisions, options);
  if (problems.length > 0)
    throw new Error(
      `Fills did not match their fields:\n- ${problems.join("\n- ")}`,
    );
}
