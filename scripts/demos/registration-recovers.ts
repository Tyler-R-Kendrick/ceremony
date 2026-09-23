import { createSecrets, runCeremony } from "../../src/server/browser-driver.js";
import {
  createHeuristicInterpreter,
  type CeremonyInterpreter,
} from "../../src/server/browser-interpreter.js";
import { generateIsolatedAccount } from "../../src/server/browser-executor.js";
import {
  authScenarios,
  createIdentity,
  startScenario,
} from "../../tests/doubles/auth-provider/scenarios.js";
import { startAgentInbox } from "./agent-inbox.js";
import { caption } from "./captions.js";
import type { DemoSession } from "./harness.js";
import { providerPhase } from "./phases.js";
import { disclosure, outcomeFacts } from "./story.js";

/**
 * Registration that hits "that address is already registered" and recovers.
 *
 * The person's usual address already has an account at this provider. A
 * caller that can only offer that address must report `account-exists`; this
 * one declares `alternate-email`, backed by the agent inbox, so the driver can
 * offer the interpreter a real way forward. The recovery is the interpreter's
 * choice among roles the driver offers — never a value it invents — and the
 * interpreter making it is the production, model-free one.
 */
export async function record(session: DemoSession) {
  const scenario = authScenarios.find(
    (entry) => entry.id === session.entry.scenario,
  );
  if (!scenario) throw new Error(`Missing scenario ${session.entry.scenario}`);
  const identity = createIdentity();
  const context = await startScenario(scenario, identity);
  const agentInbox = await startAgentInbox(context.provider, session.protect);
  try {
    const { provider } = context;
    session.protect(identity.password);
    await session.card(
      {
        title: session.entry.title,
        lines: [
          session.entry.summary,
          ...disclosure(session.entry, provider.markup.seed),
        ],
      },
      9_000,
    );

    const account = generateIsolatedAccount();
    session.protect(account.password);
    let replacement: string | undefined;
    let since = Date.now();

    await session.page.goto(`${provider.origin}${provider.signupPath}`, {
      waitUntil: "domcontentloaded",
    });
    await session.hold(1_200);

    const secrets = createSecrets({
      email: identity.email,
      "alternate-email": async () => {
        replacement = await agentInbox.inbox.provision();
        since = Date.now();
        session.say({ kind: "inbox", stage: "provisioned" });
        session.panel({ kind: "inbox", stage: "provisioned" });
        await session.hold(1_800);
        session.say({
          kind: "fill",
          actor: "agent",
          role: "alternate-email",
          source: "agent-inbox",
        });
        return replacement;
      },
      password: account.password,
      "password-confirm": account.password,
      "display-name": "Ceremony demo agent",
      "birth-date": "1990-04-12",
      "verification-code": async () => {
        session.say({ kind: "inbox", stage: "waiting" });
        session.panel({ kind: "inbox", stage: "waiting" });
        await session.hold(1_400);
        const code = replacement
          ? await agentInbox.readCode(replacement, since)
          : undefined;
        if (code) {
          session.protect(code);
          session.say({ kind: "inbox", stage: "received" });
          session.panel({ kind: "inbox", stage: "received" });
          await session.hold(2_000);
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

    // The provider's refusal is announced from the snapshot the driver
    // already read: a closed caption chosen by whether an alert says the
    // address is taken, never the alert's own text.
    let announced = false;
    const interpreter = createHeuristicInterpreter();
    const watching: CeremonyInterpreter = async (input) => {
      if (
        !announced &&
        input.snapshot.alerts.some((text) =>
          /already|in use|exists|taken/i.test(text),
        )
      ) {
        announced = true;
        session.say({ kind: "provider", says: "address-in-use" });
        await session.hold(1_600);
        session.poster();
        await session.hold(1_000);
      }
      return interpreter(input);
    };

    const result = await runCeremony({
      page: session.ceremonyPage(),
      interpreter: session.narrate(watching, {
        sources: {
          email: "person-address",
          "alternate-email": "agent-inbox",
          password: "generated",
          "password-confirm": "generated",
          "display-name": "person-profile",
          "birth-date": "person-profile",
          "verification-code": "inbox-message",
        },
        phase: (previous, observed) =>
          providerPhase(previous, observed, provider.signupPath),
      }),
      goal: "registration",
      secrets,
      allowedOrigins: [provider.origin],
      onApplied: session.applied,
      protectedValues: [account.password, identity.password],
      verify: async () =>
        replacement !== undefined && provider.verifyAccess(replacement),
    });

    await session.park();
    session.panel(undefined);
    const recovered =
      result.status === "completed" &&
      announced &&
      replacement !== undefined &&
      Boolean(provider.account(replacement)?.verified) &&
      provider.accounts().length === 2;
    if (recovered) {
      session.say({ kind: "provider", says: "signed-in" });
      await session.hold(1_800);
      session.say({ kind: "verified", what: "account" });
      await session.hold(2_200);
    } else {
      session.say({
        kind: "outcome",
        status: result.status,
        ...(result.status === "blocked" ? { reason: result.reason } : {}),
      });
      await session.hold(2_000);
    }
    await session.card(
      {
        title: recovered
          ? "Recovered: registered with a fresh address"
          : "Registration did not recover",
        tone: "result",
        lines: [
          ...outcomeFacts(result),
          ...(recovered
            ? [
                caption({ kind: "verified", what: "account" }),
                "The existing account was left untouched; exactly one new account exists, on the inbox's address.",
                "Without a declared alternate-email role the same page ends blocked: account-exists, by design.",
              ]
            : []),
        ],
      },
      6_500,
    );
    return { ok: recovered, result };
  } finally {
    await agentInbox.close();
    await context.close();
  }
}
