import { generateText, Output, type LanguageModel } from "ai";
import {
  ceremonyRoles,
  driverActionSchema,
  type CeremonyGoal,
  type CeremonyRole,
  type DriverAction,
  type PageSnapshot,
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
  /** Earlier actions, oldest first, so a failed approach is not repeated. */
  history: readonly { action: string; note?: string }[];
};

export type CeremonyInterpreter = (
  input: InterpreterInput,
) => Promise<DriverAction | undefined>;

const goalDescriptions: Record<CeremonyGoal, string> = {
  "sign-in": "sign in to an existing account at this provider",
  registration:
    "create an account at this provider and finish any confirmation step",
  authorize: "approve the requested access at this provider",
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
