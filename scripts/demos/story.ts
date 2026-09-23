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
    "Captions name roles and steps. No password, code, link or token is ever shown.",
  ];
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
