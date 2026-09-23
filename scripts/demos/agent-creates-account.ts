import { createSecrets, runCeremony } from "../../src/server/browser-driver.js";
import { generateIsolatedAccount } from "../../src/server/browser-executor.js";
import { createHeuristicInterpreter } from "../../src/server/browser-interpreter.js";
import {
  authScenarios,
  createIdentity,
  startScenario,
} from "../../tests/doubles/auth-provider/scenarios.js";
import { startAgentInbox } from "./agent-inbox.js";
import { caption } from "./captions.js";
import type { DemoSession } from "./harness.js";
import { disclosure, outcomeFacts } from "./story.js";
import { providerPhase } from "./phases.js";

/**
 * PRIMARY: the agent creates an account on a provider it has never seen.
 *
 * Everything that decides and acts is production code: the ceremony driver,
 * the Playwright page adapter, the model-free heuristic interpreter a login
 * plan with `reasoning: "deterministic"` runs, the password generator the
 * isolated-account executor uses, and the HTTP agent-inbox adapter with its
 * verification-code extraction. The provider is the self-hosted test double,
 * and its outbox stands in for mail delivery.
 */
export async function record(session: DemoSession) {
  const scenario = authScenarios.find(
    (entry) => entry.id === session.entry.scenario,
  );
  if (!scenario) throw new Error(`Missing scenario ${session.entry.scenario}`);
  const context = await startScenario(scenario, createIdentity());
  const agentInbox = await startAgentInbox(context.provider, session.protect);
  try {
    const { provider } = context;
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

    // The agent's own identity for this provider: a fresh address from its
    // inbox and a generated password. Neither is ever shown in a caption.
    const address = await agentInbox.inbox.provision();
    const account = generateIsolatedAccount();
    session.protect(account.password);
    const since = Date.now();

    await session.page.goto(`${provider.origin}${provider.signupPath}`, {
      waitUntil: "domcontentloaded",
    });
    session.say({ kind: "inbox", stage: "provisioned" });
    session.panel({ kind: "inbox", stage: "provisioned" });
    await session.hold(2_200);

    const secrets = createSecrets({
      email: address,
      password: account.password,
      "password-confirm": account.password,
      "display-name": "Ceremony demo agent",
      "verification-code": async () => {
        session.say({ kind: "inbox", stage: "waiting" });
        session.panel({ kind: "inbox", stage: "waiting" });
        await session.hold(1_400);
        const code = await agentInbox.readCode(address, since);
        if (code) {
          session.protect(code);
          session.say({ kind: "inbox", stage: "received" });
          session.panel({ kind: "inbox", stage: "received" });
          await session.hold(400);
          session.poster();
          await session.hold(1_800);
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
    const result = await runCeremony({
      page: session.ceremonyPage(),
      interpreter: session.narrate(createHeuristicInterpreter(), {
        sources: {
          email: "agent-inbox",
          password: "generated",
          "password-confirm": "generated",
          "display-name": "person-profile",
          "verification-code": "inbox-message",
        },
        phase: (previous, observed) =>
          providerPhase(previous, observed, provider.signupPath),
      }),
      goal: "registration",
      secrets,
      allowedOrigins: [provider.origin],
      onApplied: session.applied,
      protectedValues: [account.password],
      verify: () => provider.verifyAccess(address),
    });

    await session.park();
    session.panel(undefined);
    const verified =
      result.status === "completed" &&
      Boolean(provider.account(address)?.verified);
    if (verified) {
      session.say({ kind: "provider", says: "signed-in" });
      await session.hold(1_800);
      session.say({ kind: "verified", what: "account" });
      await session.hold(2_200);
    } else {
      session.say({
        kind: "outcome",
        status: result.status,
        ...("reason" in result ? { reason: result.reason } : {}),
      });
      await session.hold(2_000);
    }
    await session.card(
      {
        title: verified
          ? "Account created and verified"
          : "Registration did not finish",
        tone: "result",
        lines: [
          ...outcomeFacts(result),
          ...(verified
            ? [
                caption({ kind: "verified", what: "account" }),
                "The new account belongs to an address the agent's inbox issued; the password never left the driver.",
              ]
            : []),
        ],
      },
      6_000,
    );
    return { ok: verified, result };
  } finally {
    await agentInbox.close();
    await context.close();
  }
}
