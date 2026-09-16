import { generateText, Output, type LanguageModel } from "ai";
import { z } from "zod";

/**
 * Private-account inference for isolated-browser ceremonies. The model interprets
 * a sanitized page snapshot and chooses ONE next action; code substitutes all
 * secret values (passwords, email addresses, verification codes) by role, so
 * secrets never enter the prompt or the model's context. Deterministic
 * guardrails (origin allowlist, callback capture, inbox polling, step caps)
 * stay in the executor, not the model.
 */
export type SnapshotElement = {
  index: number;
  kind: "input" | "button" | "link" | "checkbox" | "select";
  type?: string;
  name?: string;
  label?: string;
  placeholder?: string;
  text?: string;
  required?: boolean;
};

export type PageSnapshot = {
  /** Origin only. Paths and query strings can carry credentials or codes. */
  path: string;
  title: string;
  alerts: string[];
  challenge: boolean;
  elements: SnapshotElement[];
};

export const fillRoles = [
  "email",
  "username",
  "password",
  "password-confirm",
  "display-name",
  "verification-code",
  "birth-date",
] as const;

export const interpreterActionSchema = z.strictObject({
  action: z.enum(["fill", "click", "check", "wait", "done", "blocked"]),
  element: z.number().int().nonnegative().optional(),
  role: z.enum(fillRoles).optional(),
  note: z.string().max(200).optional(),
  reason: z
    .enum(["required-input", "verification", "passkey", "challenge", "session"])
    .optional(),
});

export type InterpreterAction = z.infer<typeof interpreterActionSchema>;

export type InterpreterInput = {
  goal: string;
  snapshot: PageSnapshot;
  history: Array<{ action: string; note?: string | undefined }>;
};

export type CeremonyInterpreter = (
  input: InterpreterInput,
) => Promise<InterpreterAction | undefined>;

function describeSnapshot(snapshot: PageSnapshot) {
  return {
    path: snapshot.path,
    title: snapshot.title,
    alerts: snapshot.alerts,
    challenge: snapshot.challenge,
    elements: snapshot.elements.map((element) => {
      const { index, ...rest } = element;
      return { index, ...rest };
    }),
  };
}

/** Purpose-built prompt for the ceremony surface: register, sign in, consent. */
export function interpreterPrompt(input: InterpreterInput): string {
  const goal =
    input.goal === "registration"
      ? "Complete account registration at this provider, then finish any email verification step."
      : "Complete sign-in at this provider and approve any consent prompt.";
  return `You drive an isolated browser to ${goal}
Choose exactly ONE next action as a JSON object.
Rules:
- "fill" an input by referencing its element index and a role. Code substitutes the real value; you never see secrets. Roles: ${fillRoles.join(", ")}.
- "click" a button or link by element index (submit, next, continue, sign in, create account, authorize, allow, resend confirmation).
- "check" identifies a checkbox for human confirmation; never infer age, eligibility, or consent.
- "wait" only when the page is clearly mid-transition with nothing to do.
- "done" only when the ceremony is visibly complete (e.g. a dashboard or confirmed-account page).
- "blocked" for CAPTCHA/human challenge, unavailable personal information, missing account, or a provider rejection that persists. Use reason "required-input" for facts or declarations only the human can supply, "verification" for unavailable codes, "passkey" for an authenticator, or "session" for missing credentials. Explain in note; never invent personal facts or substitute a username for them.
- "note" is a short public status line; never include secrets in it.
- If an alert is present and the same action already failed, do not repeat it; adjust or report blocked.
Snapshot: ${JSON.stringify(describeSnapshot(input.snapshot))}
Previous actions: ${JSON.stringify(input.history.slice(-8))}`;
}

export function createModelInterpreter(
  model: LanguageModel,
): CeremonyInterpreter {
  return async (input) => {
    try {
      const result = await generateText({
        model,
        output: Output.object({ schema: interpreterActionSchema }),
        maxOutputTokens: 200,
        maxRetries: 0,
        abortSignal: AbortSignal.timeout(20_000),
        telemetry: { isEnabled: false },
        prompt: interpreterPrompt(input),
      });
      return interpreterActionSchema.parse(result.output);
    } catch {
      return undefined;
    }
  };
}
