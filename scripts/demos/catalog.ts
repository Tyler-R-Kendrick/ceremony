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
    title: "The agent creates an account",
    summary:
      "The agent registers a brand-new account on a provider it has never seen: a fresh agent-inbox address, a generated password, the emailed code read from the inbox, and a provider-verified account at the end.",
    scenario: "registration-with-emailed-code",
    interpreter: "heuristic",
    docsPreview: true,
    load: () => import("./agent-creates-account.js"),
  },
  {
    id: "registration-recovers",
    title: "Registration recovers from a taken address",
    summary:
      "The person's usual address is already registered. The driver reads the provider's refusal, asks the agent inbox for a fresh address, and finishes registration with it instead of stopping at the wall.",
    scenario: "registration-recovers-with-fresh-address",
    interpreter: "heuristic",
    docsPreview: false,
    load: () => import("./registration-recovers.js"),
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
