import type { Phase } from "./captions.js";

/**
 * The demo videos, in the order they are recorded and documented.
 *
 * Registration comes first on purpose. Creating an account on a provider the
 * agent has never seen — fresh address, form, emailed code, verified account —
 * is the ceremony API-driven agents most often cannot finish, so it is the one
 * a viewer should see before anything else. A test holds that order.
 *
 * Every entry is pure metadata; the module that records it is loaded only when
 * it runs, so reading the catalog never starts a browser.
 */
export type DemoEntry = {
  /** Output name: `artifacts/demos/<id>.mp4`. */
  id: string;
  title: string;
  /** One sentence for the title card and `docs/demos.md`. */
  summary: string;
  /** The auth scenario double this demo runs against. */
  scenario: string;
  /**
   * Which interpreter decides the agent's next step, stated on screen. Every
   * demo uses the production model-free one; the field exists so a demo that
   * ever needs a different one has to say so on its title card.
   */
  interpreter: "heuristic";
  /** The chain the title card lists, when the run is stitched. */
  chain?: readonly Phase[];
  /** The provider layout the demo is recorded on (`tests/doubles/auth-provider/layouts.ts`). */
  layout: "classic-card" | "identifier-first" | "split-panel";
  /** Which side of the frame the chain/inbox panel sits on, clear of the form. */
  panelSide?: "left" | "right";
  /** Whether the run reads mail through the agent inbox. Most do. */
  mail?: boolean;
  /** Also published as a small preview under `docs/demos/`. */
  docsPreview: boolean;
  load: () => Promise<{ record: DemoRecorder }>;
};

/** What a scenario module exports. The harness supplies the session. */
export type DemoRecorder = (
  session: import("./harness.js").DemoSession,
) => Promise<import("./harness.js").DemoOutcome>;

export const demoCatalog: readonly DemoEntry[] = [
  {
    id: "agent-creates-account",
    layout: "classic-card",
    title: "The agent creates an account",
    summary:
      "The agent registers a brand-new account on a provider it has never seen: a fresh agent-inbox address, a generated password, the emailed code read from the inbox, and a provider-verified account at the end.",
    scenario: "registration-with-emailed-code",
    interpreter: "heuristic",
    docsPreview: true,
    load: () => import("./agent-creates-account.js"),
  },
  {
    id: "totp-enrollment",
    layout: "split-panel",
    panelSide: "left",
    title: "Register, then set up an authenticator",
    summary:
      "The agent registers a new account and the provider requires an authenticator app: the driver reads the setup key into custody, confirms it with a code derived from that seed, and a later sign-in answers the two-factor prompt from the held seed. The seed and every code are boxed out of the video.",
    scenario: "registration-enrolls-an-authenticator",
    interpreter: "heuristic",
    chain: [
      "register",
      "verify-email",
      "enroll-authenticator",
      "sign-in-again",
      "second-factor",
      "verified",
    ],
    docsPreview: true,
    load: () => import("./totp-enrollment.js"),
  },
  {
    id: "registration-recovers",
    layout: "split-panel",
    panelSide: "left",
    title: "Registration recovers from a taken address",
    summary:
      "The person's usual address is already registered. The driver reads the provider's refusal, asks the agent inbox for a fresh address, and finishes registration with it instead of stopping at the wall.",
    scenario: "registration-recovers-with-fresh-address",
    interpreter: "heuristic",
    docsPreview: false,
    load: () => import("./registration-recovers.js"),
  },
  {
    id: "connect-without-account",
    layout: "identifier-first",
    title: "Connect an API for someone with no account yet",
    summary:
      "One stitched run: OAuth authorization finds no account, so the agent registers one, verifies it through the agent inbox, approves consent, and the connector redeems the code with PKCE for verified access.",
    scenario: "authorization-requires-registration-first",
    interpreter: "heuristic",
    chain: [
      "authorize",
      "no-account",
      "register",
      "verify-email",
      "consent",
      "token-exchange",
      "verified",
    ],
    docsPreview: true,
    load: () => import("./connect-without-account.js"),
  },
  {
    id: "connect-with-account",
    layout: "identifier-first",
    title: "Connect an API for someone who has an account",
    summary:
      "The same OAuth request, but the person already has an account: the agent signs in identifier-first, answers the authenticator with a code derived from the held seed, approves consent, and the connector redeems the code with PKCE.",
    scenario: "sign-in-with-second-factor",
    interpreter: "heuristic",
    chain: [
      "authorize",
      "sign-in",
      "second-factor",
      "consent",
      "token-exchange",
      "verified",
    ],
    docsPreview: true,
    load: () => import("./connect-with-account.js"),
  },
  {
    id: "device-authorization",
    layout: "identifier-first",
    title: "Authorize a device with its code",
    summary:
      "A command-line device asks to be authorized and shows a code. The agent signs in at the provider's device page, types the code because the plan supplies it, and approves the consent screen; the device's own token poll proves it is connected. Without a code in the plan, a person enters it instead.",
    scenario: "device-authorization-with-consent",
    interpreter: "heuristic",
    chain: ["device-request", "sign-in", "device-code", "consent", "verified"],
    mail: false,
    docsPreview: true,
    load: () => import("./device-authorization.js"),
  },
  {
    id: "chain-two-providers",
    layout: "classic-card",
    title: "Chain two providers in one run",
    summary:
      "An OAuth app the agent registers at Northwind Cloud is what signs the person in to Globex Workspace: one run, each step authorized under its own connector, with only a run-bound client handle crossing between them.",
    scenario: "two-provider-chain",
    interpreter: "heuristic",
    chain: ["a-register-app", "b-configure", "b-sign-in"],
    docsPreview: true,
    load: () => import("./chain-two-providers.js"),
  },
  {
    id: "record-once-replay",
    layout: "classic-card",
    title: "Record once, replay with no model",
    summary:
      "The first registration is interpreted and recorded as value-free steps; a second registration on the same provider, for a different fresh address, is replayed from that recording with zero interpreter calls.",
    scenario: "registration-with-emailed-code",
    interpreter: "heuristic",
    docsPreview: false,
    load: () => import("./record-once-replay.js"),
  },
];

export function findDemos(names: readonly string[]): DemoEntry[] {
  if (names.length === 0) return [...demoCatalog];
  return names.map((name) => {
    const found = demoCatalog.find((entry) => entry.id === name);
    if (!found)
      throw new Error(
        `Unknown demo "${name}". Known: ${demoCatalog.map((entry) => entry.id).join(", ")}`,
      );
    return found;
  });
}
