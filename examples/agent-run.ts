import { randomBytes } from "node:crypto";
import {
  createSecrets,
  runCeremony,
  type CeremonyResult,
  type HumanParticipationResult,
} from "../src/server/browser-driver.js";
import { createPlaywrightCeremonyPage } from "../src/server/browser-page.js";
import { createHeuristicInterpreter } from "../src/server/browser-interpreter.js";
import type {
  CeremonyRole,
  CeremonyStep,
} from "../src/core/browser-contracts.js";
import type { HumanHandoffContract } from "../src/core/connector-contracts.js";
import type { AccountProvider } from "../scripts/gallery-accounts.js";
import type { BrowserBackend, BrowserSession } from "./browser-session.js";

/**
 * The agent, in its own browser, making the account itself.
 *
 * It is handed an address and a provider and nothing else. It mints the
 * password, drives the provider's real registration pages, and asks a person
 * for exactly the things it cannot produce: a code the provider mailed to an
 * inbox it does not have, a challenge only a human can answer, a credential the
 * provider issues on a page the driver is built not to read. Everything it does
 * is reported as it happens, which is what lets a card show the run rather
 * than a link to somewhere the run might happen.
 *
 * What comes back is by value only to the caller, who is expected to hold it
 * by reference for everybody else: nothing here ever puts a secret in a step.
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

export type AgentPhase = "register" | "issue" | "collect";

export interface AgentOutput {
  name: string;
  label: string;
  value: string;
}

export interface AgentRunOptions {
  provider: AccountProvider;
  /** The person's address. Absent, a provider with its own mailbox gets one minted. */
  email?: string;
  /** The reference provider, the one account this ceremony can register unaided. */
  issuer: string;
  session: BrowserSession;
  onStep?: (step: CeremonyStep) => void;
  onSession?: (info: { backend: BrowserBackend; liveUrl?: string }) => void;
  onPhase?: (phase: AgentPhase) => void;
  /** A value the run produced. Handed over once, as it is made. */
  onOutput?: (output: AgentOutput) => void;
  /** Ask the person for a value the agent cannot produce. */
  ask: (role: CeremonyRole | "token", prompt: string) => Promise<string>;
  /** Ask the person to take over the browser for a step only they can do. */
  takeOver: (input: {
    reason: string;
    url: string;
    attempt: number;
  }) => Promise<HumanParticipationResult>;
}

export interface AgentRunReport {
  /** The address that was registered. */
  identity: string;
  result: CeremonyResult;
  /** What, if anything, showed the account is real. */
  evidence: "provider-confirmed" | "credential-shape" | "none";
}

const openHandoff: HumanHandoffContract = {
  surface: "provider-browser",
  recipient: "initiating-subject",
  delegation: "a2h-authorize",
  resume: "verify",
};

/**
 * Read the confirmation code from the reference provider's mailbox.
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

/** Provider-side proof: the account is real only if the provider issues against it. */
async function issuedBy(
  issuer: string,
  email: string,
  password: string,
): Promise<string | undefined> {
  const response = await fetch(`${issuer}/credentials`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ email, password }),
  });
  if (!response.ok) return undefined;
  const body = (await response.json()) as { access_token?: unknown };
  return typeof body.access_token === "string" ? body.access_token : undefined;
}

export async function runAgentCeremony(
  options: AgentRunOptions,
): Promise<AgentRunReport> {
  const { provider, issuer, session, ask, takeOver } = options;
  const own = provider.registration.createdBy === "this-ceremony";
  const identity =
    options.email?.trim() ||
    (own ? `agent-${randomBytes(4).toString("hex")}@ceremony.test` : "");
  if (!identity)
    throw new Error(`${provider.manifest.name} needs an address to register`);
  const local = identity.split("@")[0] ?? "agent";
  const password = mint();
  const entry = own
    ? `${issuer}/register`
    : provider.signup?.({ email: identity });
  if (!entry)
    throw new Error(`${provider.manifest.name} has no registration page`);
  const origins = own
    ? [issuer]
    : [entry, ...(provider.issuing ? [provider.issuing.url] : [])];
  const contract =
    provider.manifest.methods[0]?.contract?.handoff ?? openHandoff;

  const context = await session.browser.newContext();
  const page = await context.newPage();
  const given = new Set<string>();
  const produce = (name: string, label: string, value: string) => {
    if (given.has(name)) return;
    given.add(name);
    options.onOutput?.({ name, label, value });
  };
  try {
    await page.goto(entry, { waitUntil: "domcontentloaded" });
    const liveUrl = await session.liveView(page).catch(() => undefined);
    options.onSession?.({
      backend: session.backend,
      ...(liveUrl ? { liveUrl } : {}),
    });
    options.onPhase?.("register");
    const result = await runCeremony({
      page: createPlaywrightCeremonyPage(page),
      interpreter: createHeuristicInterpreter(),
      goal: "registration",
      secrets: createSecrets({
        email: identity,
        username: own
          ? identity
          : `${local.replace(/[^a-z0-9]/gi, "").slice(0, 20) || "agent"}-${randomBytes(2).toString("hex")}`,
        "display-name": local,
        password,
        "password-confirm": password,
        "verification-code": own
          ? () => codeFrom(issuer, identity)
          : () =>
              ask(
                "verification-code",
                `The code ${provider.manifest.name} sent to ${identity}`,
              ),
      }),
      allowedOrigins: origins,
      protectedValues: [password],
      human: {
        contract,
        // The live view when this host has one, because handing a person a
        // viewer onto the very browser the agent is driving is the point of
        // the example. Without one they get the request's own `path`, which
        // is origin and pathname: enough to know where to go, and carrying
        // none of the query string the driver deliberately leaves out.
        request: async ({ reason, path, attempt }) =>
          takeOver({ reason, url: liveUrl ?? path, attempt }),
      },
      ...(own
        ? {
            verify: async () => {
              const token = await issuedBy(issuer, identity, password);
              if (!token) return false;
              produce("password", "Generated password", password);
              produce("access_token", "Session token", token);
              return true;
            },
          }
        : {}),
      ...(options.onStep ? { onStep: options.onStep } : {}),
    });
    let evidence: AgentRunReport["evidence"] =
      result.status === "completed" ? "provider-confirmed" : "none";

    // The provider issues the credential on a page of its own, and the driver
    // is built not to read one off a screen. So the agent goes there, a person
    // copies it — from the live view when there is one — and it comes back
    // through a field, shape-checked. A registration that was stopped outright
    // has no account to issue against, so nobody is asked.
    if (
      !own &&
      provider.issuing &&
      provider.credential &&
      result.status !== "blocked"
    ) {
      produce("password", "Generated password", password);
      options.onPhase?.("issue");
      await page
        .goto(provider.issuing.url, { waitUntil: "domcontentloaded" })
        .catch(() => {});
      options.onPhase?.("collect");
      for (let attempt = 0; attempt < 3; attempt += 1) {
        const value = await ask("token", provider.credential.label);
        const complaint = provider.shape?.check(value);
        if (complaint) {
          options.onStep?.({
            path: new URL(provider.issuing.url).pathname,
            action: "wait",
            note: complaint,
          });
          continue;
        }
        produce("token", provider.credential.label, value.trim());
        evidence = "credential-shape";
        break;
      }
    }
    return { identity, result, evidence };
  } finally {
    await context.close().catch(() => {});
  }
}
