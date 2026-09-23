/**
 * Every word a demo video shows, and nothing a ceremony knows.
 *
 * A recording is the one artifact of a ceremony that is made to be shared, so
 * it is held to a stricter rule than a transcript: it may name *who* acted and
 * *which step* they took, and never *what* they typed. A caption is built only
 * from closed vocabularies — a role name, a phase, an outcome — and never from
 * a string the page, the interpreter or a secret source produced. There is no
 * parameter here that could carry a password, a code, a link or a token, and
 * `tests/demos-captions.test.ts` feeds canaries through every entry point to
 * keep it that way.
 */

/** Who did the thing on screen. */
export type Actor =
  "agent" | "person" | "provider" | "inbox" | "driver" | "replay";

/** A step in a ceremony, as a viewer would name it. */
export const phases = [
  "open-signup",
  "authorize",
  "sign-in",
  "register",
  "verify-email",
  "second-factor",
  "consent",
  "callback",
  "token-exchange",
  "verified",
] as const;
export type Phase = (typeof phases)[number];

const phaseNames: Record<Phase, string> = {
  "open-signup": "open the sign-up page",
  authorize: "authorize (PKCE S256)",
  "sign-in": "sign-in page, no account",
  register: "register a new account",
  "verify-email": "verify email via inbox",
  "second-factor": "second factor",
  consent: "consent",
  callback: "callback with code",
  "token-exchange": "token exchange",
  verified: "verified access",
};

/** Roles a driver can fill, described by where the value comes from. */
const roleNames: Record<string, string> = {
  email: "email address",
  "alternate-email": "replacement email",
  username: "username",
  password: "password",
  "password-confirm": "password confirmation",
  "display-name": "display name",
  "birth-date": "date of birth",
  "verification-code": "verification code",
  "totp-code": "authenticator code",
  "user-code": "device code",
};

/** Where a filled value came from. Never the value itself. */
export type ValueSource =
  | "agent-inbox"
  | "generated"
  | "inbox-message"
  | "person-profile"
  | "person-address"
  | "private-collector"
  | "totp-seed";

const sourceNames: Record<ValueSource, string> = {
  "agent-inbox": "new agent-inbox address",
  generated: "generated, masked",
  "inbox-message": "from agent inbox",
  "person-profile": "synthetic profile",
  "person-address": "the person's usual address",
  "private-collector": "private collector",
  "totp-seed": "derived from the held seed",
};

/** Named ceremony walls the driver reports; the reason list is closed. */
const blockedNames: Record<string, string> = {
  "account-exists": "address already registered",
  "human-challenge": "human challenge",
  "credentials-rejected": "credentials rejected",
  "consent-denied": "consent denied",
  "provider-error": "provider error",
  "unsupported-page": "page not understood",
  "untrusted-origin": "untrusted origin",
  "human-declined": "person declined",
  "passkey-required": "passkey required",
  "native-dialog": "browser dialog",
};

const outcomeNames: Record<string, string> = {
  completed: "completed",
  blocked: "blocked",
  exhausted: "step budget exhausted",
  stalled: "stalled",
  unverified: "claimed but unverified",
  indeterminate: "indeterminate",
};

export type CaptionEvent =
  | { kind: "fill"; actor: Actor; role: string; source?: ValueSource }
  | {
      kind: "click";
      actor: Actor;
      control: "button" | "link" | "checkbox" | "select" | "input";
      phase?: Phase;
    }
  | { kind: "check"; actor: Actor }
  | { kind: "wait"; actor: Actor }
  | { kind: "claim-done"; actor: Actor }
  | { kind: "inbox"; stage: "provisioned" | "waiting" | "received" }
  | {
      kind: "provider";
      says: "address-in-use" | "check-inbox" | "signed-in" | "consent-screen";
    }
  | { kind: "blocked"; reason: string }
  | { kind: "outcome"; status: string; reason?: string }
  | {
      kind: "verified";
      what: "account" | "session" | "token" | "single-use-code";
    }
  | { kind: "handoff"; what: "consent-approved" | "requested" }
  | {
      kind: "connector";
      stage:
        | "request"
        | "callback"
        | "state-matches"
        | "exchange"
        | "subject-matches"
        | "subject-is-person"
        | "replay-refused";
    }
  | { kind: "step"; index: number; total: number; phase: Phase }
  | {
      kind: "recording";
      stage: "capturing" | "compiled" | "replaying" | "replayed";
    };

const connectorLines: Record<string, string> = {
  request: "Connector: authorization request, PKCE S256",
  callback: "Connector: callback captured (code not shown)",
  "state-matches": "Connector: state matches the request ✓",
  exchange: "Connector: code + PKCE verifier → access token",
  "subject-matches": "Verified: token is for the account just made ✓",
  "subject-is-person": "Verified: token is for the person's own account ✓",
  "replay-refused": "Verified: same code refused on replay ✓",
};

const recordingLines: Record<string, string> = {
  capturing: "Recording: applied steps kept, values dropped",
  compiled: "Recording compiled: value-free, ready to publish",
  replaying: "Replay: the recording drives, no model is asked",
  replayed: "Replay finished with zero interpreter calls ✓",
};

const actorNames: Record<Actor, string> = {
  agent: "Agent",
  person: "Person",
  provider: "Provider",
  inbox: "Agent inbox",
  driver: "Driver",
  replay: "Replay",
};

/**
 * One HUD line is drawn as a single row of text; wider than the frame and the
 * compositor fails. Every caption is bounded so no event can do that.
 */
export const maxCaptionLength = 56;

function bounded(text: string): string {
  return text.length <= maxCaptionLength
    ? text
    : `${text.slice(0, maxCaptionLength - 1)}…`;
}

function lookup<T extends string>(
  table: Record<string, T>,
  key: unknown,
  fallback: T,
): T {
  return typeof key === "string" && Object.hasOwn(table, key)
    ? table[key]!
    : fallback;
}

function whole(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0
    ? Math.min(value, 99)
    : fallback;
}

function clickTarget(control: unknown, phase: Phase | undefined): string {
  if (control === "link")
    return phase === "sign-in" || phase === "register"
      ? "follow the create-account link"
      : "follow a link";
  if (control === "checkbox") return "tick a checkbox";
  switch (phase) {
    case "register":
      return "submit the registration form";
    case "verify-email":
      return "submit the verification code";
    case "second-factor":
      return "submit the second factor";
    case "consent":
      return "approve the consent screen";
    case "sign-in":
      return "submit the sign-in form";
    default:
      return "press the form's submit button";
  }
}

/** A caption for one event. Every word comes from a table above. */
export function caption(event: CaptionEvent): string {
  const who = (actor: unknown) => lookup(actorNames, actor, "Agent");
  switch (event.kind) {
    case "fill": {
      const role = lookup(roleNames, event.role, "a field");
      const source =
        event.source === undefined
          ? ""
          : ` (${lookup(sourceNames, event.source, "private")})`;
      return bounded(`${who(event.actor)}: fill ${role}${source}`);
    }
    case "click": {
      const phase = (phases as readonly unknown[]).includes(event.phase)
        ? event.phase
        : undefined;
      return bounded(
        `${who(event.actor)}: ${clickTarget(event.control, phase)}`,
      );
    }
    case "check":
      return bounded(`${who(event.actor)}: tick a required checkbox`);
    case "wait":
      return bounded(`${who(event.actor)}: wait for the page to settle`);
    case "claim-done":
      return bounded(
        `${who(event.actor)}: claims done; driver checks with provider`,
      );
    case "inbox":
      return bounded(
        event.stage === "provisioned"
          ? "Agent inbox: provisioned a fresh address"
          : event.stage === "received"
            ? "Agent inbox: email in · code extracted (not shown)"
            : "Agent: waiting for the verification email",
      );
    case "provider":
      return bounded(
        event.says === "address-in-use"
          ? "Provider: that address is already registered"
          : event.says === "signed-in"
            ? "Provider: signed in to the new account"
            : event.says === "consent-screen"
              ? "Provider: asks to grant the connector access"
              : "Provider: confirmation email sent",
      );
    case "blocked":
      return bounded(
        `Driver: stopped — ${lookup(blockedNames, event.reason, "named wall")}`,
      );
    case "outcome": {
      const status = lookup(outcomeNames, event.status, "finished");
      const reason =
        event.reason === undefined
          ? ""
          : ` (${lookup(blockedNames, event.reason, "named wall")})`;
      return bounded(`Outcome: ${status}${reason}`);
    }
    case "verified":
      return bounded(
        event.what === "account"
          ? "Verified: provider confirms the account ✓"
          : event.what === "session"
            ? "Verified: provider confirms the session ✓"
            : event.what === "single-use-code"
              ? "Verified: code refused on replay (single use) ✓"
              : "Verified access: API token issued and checked ✓",
      );
    case "handoff":
      return bounded(
        event.what === "consent-approved"
          ? "Handoff: consent approved"
          : "Handoff: a person is asked to act",
      );
    case "recording":
      return bounded(recordingLines[event.stage] ?? "Recording: working");
    case "connector":
      return bounded(connectorLines[event.stage] ?? "Connector: working");
    case "step": {
      const total = Math.max(1, whole(event.total, 1));
      const index = Math.min(total, Math.max(1, whole(event.index, 1)));
      return bounded(
        `Step ${index}/${total} · ${lookup(phaseNames, event.phase, "next step")}`,
      );
    }
    default:
      return "Agent: working";
  }
}

/** The phase list rendered for a title card, e.g. "register → verify email". */
export function chainSummary(chain: readonly Phase[]): string[] {
  return chain.map((phase, index) => `${index + 1}. ${phaseNames[phase]}`);
}

/**
 * A side panel drawn beside the provider page: where the chain is, or what
 * the agent inbox just did. Same rule as a caption — closed vocabulary, no
 * value — and the same canary test covers it.
 */
export type Panel = {
  title: string;
  rows: { mark: "done" | "current" | "pending" | "info"; text: string }[];
};

export type PanelEvent =
  | {
      kind: "chain";
      chain: readonly Phase[];
      current: Phase;
      finished?: boolean;
    }
  | { kind: "inbox"; stage: "provisioned" | "waiting" | "received" };

export function panel(event: PanelEvent): Panel {
  if (event.kind === "chain") {
    const chain = event.chain.filter((phase) =>
      (phases as readonly unknown[]).includes(phase),
    );
    const at = chain.indexOf(event.current);
    return {
      title: "Stitched run",
      rows: chain.map((phase, index) => ({
        mark:
          event.finished || index < at
            ? "done"
            : index === at
              ? "current"
              : "pending",
        text: `${index + 1}. ${phaseNames[phase]}`,
      })),
    };
  }
  const stage = event.stage;
  return {
    title: "Agent inbox",
    rows: [
      { mark: "done", text: "Fresh address issued for this run" },
      {
        mark:
          stage === "provisioned"
            ? "pending"
            : stage === "waiting"
              ? "current"
              : "done",
        text:
          stage === "received"
            ? "Confirmation email arrived"
            : "Waiting for the provider's email",
      },
      {
        mark: stage === "received" ? "done" : "pending",
        text: "Code extracted, handed to the driver",
      },
      { mark: "info", text: "Values are never shown" },
    ],
  };
}
