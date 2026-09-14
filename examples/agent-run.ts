import { chromium, type Browser } from "playwright-core";
import { randomBytes } from "node:crypto";
import {
  createSecrets,
  runCeremony,
  type CeremonyResult,
} from "../src/server/browser-driver.js";
import { createPlaywrightCeremonyPage } from "../src/server/browser-page.js";
import { createHeuristicInterpreter } from "../src/server/browser-interpreter.js";
import type {
  CeremonyGoal,
  CeremonyStep,
} from "../src/core/browser-contracts.js";

/**
 * The agent, in its own browser, doing the ceremony itself.
 *
 * Nothing here is handed to a person. The agent mints the identity it will
 * register, drives the provider's real pages, reads the confirmation code out
 * of band from the provider's own mailbox, and comes back with the outcome.
 * Every step it takes is reported as it happens, which is what lets a card show
 * the run rather than a link to somewhere the run might happen.
 */

const alphabet = "abcdefghijkmnopqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789-_";

function mint(length = 20): string {
  const limit = 256 - (256 % alphabet.length);
  let out = "";
  while (out.length < length)
    for (const byte of randomBytes(length * 2)) {
      if (byte >= limit) continue;
      out += alphabet[byte % alphabet.length];
      if (out.length === length) break;
    }
  return out;
}

export interface AgentRunOptions {
  /** The provider the agent will register at. Its pages, not ours. */
  issuer: string;
  goal: CeremonyGoal;
  /** Where the agent starts. Defaults to the provider's credential page. */
  entryUrl?: string;
  onStep?: (step: CeremonyStep) => void;
  /** Supplied by the caller in tests; launched here otherwise. */
  browser?: Browser;
}

export interface AgentRunReport {
  /** The address the agent invented and registered. Not a person's. */
  identity: string;
  result: CeremonyResult;
}

/**
 * Read the confirmation code from the provider's mailbox.
 *
 * Out of band on purpose: it is fetched from the provider's own origin, not
 * scraped from the page being driven, so the agent is doing what a person with
 * an inbox does rather than reading its own answer off the screen.
 */
async function codeFrom(issuer: string, address: string): Promise<string> {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const page = await fetch(`${issuer}/inbox`).then((response) =>
      response.ok ? response.text() : "",
    );
    for (const row of page.split("<li>").slice(1))
      if (row.includes(address)) {
        const code = /(\d{6})/.exec(row)?.[1];
        if (code) return code;
      }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error("No code arrived for this address");
}

export async function runAgentCeremony({
  issuer,
  goal,
  entryUrl,
  onStep,
  browser,
}: AgentRunOptions): Promise<AgentRunReport> {
  const identity = `agent-${randomBytes(4).toString("hex")}@ceremony.test`;
  const password = mint();
  const owned = browser ?? (await chromium.launch({ args: ["--no-sandbox"] }));
  const context = await owned.newContext();
  const page = await context.newPage();
  try {
    await page.goto(entryUrl ?? `${issuer}/register`, {
      waitUntil: "domcontentloaded",
    });
    const result = await runCeremony({
      page: createPlaywrightCeremonyPage(page),
      interpreter: createHeuristicInterpreter(),
      goal,
      secrets: createSecrets({
        email: identity,
        username: identity,
        password,
        "password-confirm": password,
        "verification-code": () => codeFrom(issuer, identity),
      }),
      allowedOrigins: [issuer],
      protectedValues: [password],
      // Provider-side proof, not the page's word for it: the account is only
      // real if the provider will issue against it. A "done" the driver cannot
      // confirm comes back as unverified rather than completed.
      verify: async () => {
        const response = await fetch(`${issuer}/credentials`, {
          method: "POST",
          headers: { "content-type": "application/x-www-form-urlencoded" },
          body: new URLSearchParams({ email: identity, password }),
        });
        if (!response.ok) return false;
        const body = (await response.json()) as { access_token?: string };
        return typeof body.access_token === "string";
      },
      ...(onStep ? { onStep } : {}),
    });
    return { identity, result };
  } finally {
    await context.close();
    if (!browser) await owned.close();
  }
}
