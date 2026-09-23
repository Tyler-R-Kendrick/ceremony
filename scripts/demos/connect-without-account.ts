import { createSecrets, runCeremony } from "../../src/server/browser-driver.js";
import {
  createHeuristicInterpreter,
  type CeremonyInterpreter,
} from "../../src/server/browser-interpreter.js";
import { generateIsolatedAccount } from "../../src/server/browser-executor.js";
import { authScenarios } from "../../tests/doubles/auth-provider/scenarios.js";
import { startAuthProvider } from "../../tests/doubles/auth-provider/server.js";
import { startAgentInbox } from "./agent-inbox.js";
import { caption } from "./captions.js";
import { redeemOnScreen, startConnectorCallback } from "./connector.js";
import type { DemoSession } from "./harness.js";
import { pathnameOf, providerPhase } from "./phases.js";
import { disclosure, outcomeFacts } from "./story.js";

/**
 * STITCHED: connect an API for someone who has no account there yet.
 *
 * One run, several ceremonies. The connector starts an OAuth authorization
 * code request with PKCE; the provider has no account for this person, so the
 * agent follows the sign-up link, registers with a fresh agent-inbox address,
 * confirms it with the emailed code, returns to the consent screen the
 * original request was waiting on, and approves it. The callback carries a
 * code the connector redeems with its verifier, and the provider's token names
 * the account the agent just created.
 *
 * The chain position shown on screen is derived from what the driver was
 * about to do and where, never from elapsed time. The redirect URI belongs to
 * a separate local "connector" origin, as it would in production, so the
 * browser lands on the connector's callback page rather than the provider's.
 */
export async function record(session: DemoSession) {
  const scenario = authScenarios.find(
    (entry) => entry.id === session.entry.scenario,
  );
  if (!scenario) throw new Error(`Missing scenario ${session.entry.scenario}`);
  const callback = await startConnectorCallback();
  // The scenario's own behaviour and seed, with no seeded account (its
  // precondition is `account-absent`) and the connector's redirect URI.
  const provider = await startAuthProvider({
    ...scenario.behavior({}),
    accounts: [],
    redirectUri: callback.uri,
    layout: session.entry.layout,
  });
  const agentInbox = await startAgentInbox(provider, session.protect);
  try {
    await session.card(
      {
        title: session.entry.title,
        lines: [
          session.entry.summary,
          ...disclosure(session.entry, provider.markup.seed),
          "OAuth client side (authorization request, token exchange) is the test provider's relying-party helper; the agent's part is everything in the browser between them.",
        ],
      },
      11_000,
    );

    session.step("authorize");
    const request = provider.authorization();
    session.protect(request.verifier);
    session.say({ kind: "connector", stage: "request" });
    await session.card(
      {
        title: "Start authorization",
        tone: "connector",
        keepPanel: true,
        lines: [
          caption({ kind: "connector", stage: "request" }),
          "No stored account for this person at the provider.",
          "The agent will register one first, in an isolated browser.",
        ],
      },
      4_000,
    );

    const account = generateIsolatedAccount();
    session.protect(account.password);
    let address: string | undefined;
    let since = Date.now();

    await session.page.goto(request.url, { waitUntil: "domcontentloaded" });

    const secrets = createSecrets({
      email: async () => {
        address = await agentInbox.inbox.provision();
        since = Date.now();
        session.say({ kind: "inbox", stage: "provisioned" });
        session.panel({ kind: "inbox", stage: "provisioned" });
        await session.hold(1_800);
        session.panel({
          kind: "chain",
          chain: session.entry.chain!,
          current: "register",
        });
        session.say({
          kind: "fill",
          actor: "agent",
          role: "email",
          source: "agent-inbox",
        });
        return address;
      },
      password: account.password,
      "password-confirm": account.password,
      "display-name": "Ceremony demo agent",
      "birth-date": "1990-04-12",
      "verification-code": async () => {
        session.say({ kind: "inbox", stage: "waiting" });
        session.panel({ kind: "inbox", stage: "waiting" });
        await session.hold(1_400);
        const code = address
          ? await agentInbox.readCode(address, since)
          : undefined;
        if (code) {
          session.protect(code);
          session.say({ kind: "inbox", stage: "received" });
          session.panel({ kind: "inbox", stage: "received" });
          await session.hold(2_000);
          session.panel({
            kind: "chain",
            chain: session.entry.chain!,
            current: "verify-email",
          });
          session.say({
            kind: "fill",
            actor: "agent",
            role: "verification-code",
            source: "inbox-message",
          });
        }
        return code ?? "";
      },
    });

    const narrated = session.narrate(createHeuristicInterpreter(), {
      sources: {
        email: "agent-inbox",
        password: "generated",
        "password-confirm": "generated",
        "display-name": "person-profile",
        "birth-date": "person-profile",
        "verification-code": "inbox-message",
      },
      // On this run the sign-in page is where the missing account is found.
      phase: (previous, observed) => {
        const phase = providerPhase(previous, observed, provider.signupPath);
        return phase === "sign-in" ? "no-account" : phase;
      },
    });
    let consentShown = false;
    let decided = false;
    const interpreter: CeremonyInterpreter = async (input) => {
      // The fork this demo is about, said out loud before anything is done
      // on the sign-in page: nobody holds an account here, so the agent
      // registers rather than trying to sign in.
      if (!decided && pathnameOf(input.snapshot.path) === "/signin") {
        decided = true;
        session.step("no-account");
        session.say({
          kind: "decision",
          what: "no-account-register",
          layout: session.entry.layout,
        });
        await session.hold(2_400);
      }
      const atConsent =
        !consentShown && pathnameOf(input.snapshot.path) === "/authorize";
      // Let the consent screen register before anything happens on it: it is
      // the step a person would most want to see the agent take.
      if (atConsent) {
        session.step("consent");
        session.say({ kind: "provider", says: "consent-screen" });
        await session.reveal();
        await session.hold(1_600);
      }
      const action = await narrated(input);
      if (atConsent) {
        consentShown = true;
        session.poster();
        await session.hold(1_400);
      }
      return action;
    };

    const result = await runCeremony({
      page: session.ceremonyPage(),
      interpreter,
      // The account does not exist yet, so the ceremony is a registration
      // that ends at the consent screen the original request was waiting on.
      goal: "registration",
      secrets,
      allowedOrigins: [provider.origin],
      onApplied: session.applied,
      redirectUri: provider.redirectUri,
      protectedValues: [account.password],
      maxSteps: 30,
    });
    session.checkFills(result);
    await session.park();

    const accountReady =
      address !== undefined && Boolean(provider.account(address)?.verified);
    const verified =
      accountReady &&
      (await redeemOnScreen(session, provider, request, result, {
        expected: address,
        stage: "subject-matches",
      }));

    await session.card(
      {
        title: verified
          ? "Connected: a new account, verified, with API access"
          : "The stitched run did not finish",
        tone: "result",
        lines: [
          ...outcomeFacts(result),
          ...(verified
            ? [
                "One browser run: authorize → no account → register → inbox code → consent → callback.",
                caption({ kind: "verified", what: "account" }),
                caption({ kind: "verified", what: "token" }),
                caption({ kind: "connector", stage: "replay-refused" }),
              ]
            : []),
        ],
      },
      7_000,
    );
    return { ok: verified, result };
  } finally {
    await agentInbox.close();
    await provider.close();
    await callback.close();
  }
}
