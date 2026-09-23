import type { CeremonyResult } from "../../src/server/browser-driver.js";
import { caption, chainSummary, productNames } from "./captions.js";
import type { DemoEntry } from "./catalog.js";

/**
 * The fixed text of a title card: what is real in the video and what is a
 * double. It is the same for every run of a demo except the provider seed,
 * which is a number, so a viewer can replay the exact page shapes.
 */
export function disclosure(entry: DemoEntry, seed: number): string[] {
  return [
    ...(entry.chain
      ? [`§Chain: ${chainSummary(entry.chain).join("  ·  ")}`]
      : []),
    `Provider: self-hosted test provider (tests/doubles/auth-provider), "${productNames[entry.layout] ?? "test provider"}" ${entry.layout} layout, seed ${seed}. An invented product: not a real service, no real accounts.`,
    "Driver: Ceremony's runCeremony + Playwright page adapter, attached over CDP to the Chrome webreel is recording.",
    "Next-step decisions: createHeuristicInterpreter, the production model-free interpreter. It sees only the sanitized page snapshot; no model is called.",
    "Email: the provider's outbox, read through Ceremony's HTTP agent-inbox adapter. Mail transport is simulated.",
    ...(entry.consents?.length
      ? [
          `Consent: the person agreed in advance to the provider's ${consentList(entry.consents)}. The agent ticks that box because of it; a newsletter box is never ticked.`,
        ]
      : []),
    "Captions name roles and steps. No password, code, link or token is ever shown.",
  ];
}

/** A consent list in words, from a closed table. */
function consentList(kinds: readonly string[]): string {
  const names: Record<string, string> = {
    terms: "terms of service",
    privacy: "privacy policy",
    age: "age requirement",
  };
  const words = kinds
    .filter((kind) => Object.hasOwn(names, kind))
    .map((kind) => names[kind]!);
  return words.length > 1
    ? `${words.slice(0, -1).join(", ")} and ${words.at(-1)}`
    : (words[0] ?? "terms");
}

/** End-card lines about the driver's result; counts and closed names only. */
export function outcomeFacts(result: CeremonyResult): string[] {
  return [
    caption({
      kind: "outcome",
      status: result.status,
      ...(result.status === "blocked" ? { reason: result.reason } : {}),
    }),
    `Driver steps: ${result.steps} · people asked to help: ${result.handoffs}`,
  ];
}
