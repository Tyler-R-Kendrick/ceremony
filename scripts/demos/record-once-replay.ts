import { compileRecording } from "../../src/core/recorded-ceremony.js";
import type { RecordedTraceEntry } from "../../src/core/recorded-ceremony.js";
import type { CeremonyRole } from "../../src/core/browser-contracts.js";
import {
  createSecrets,
  runCeremony,
  runRecordedCeremony,
} from "../../src/server/browser-driver.js";
import {
  createHeuristicInterpreter,
  type CeremonyInterpreter,
} from "../../src/server/browser-interpreter.js";
import { generateIsolatedAccount } from "../../src/server/browser-executor.js";
import {
  authScenarios,
  createIdentity,
  startScenario,
  withLayout,
} from "../../tests/doubles/auth-provider/scenarios.js";
import { startAgentInbox, type AgentInbox } from "./agent-inbox.js";
import { caption, type ValueSource } from "./captions.js";
import type { DemoSession } from "./harness.js";
import { providerPhase } from "./phases.js";
import { disclosure } from "./story.js";

/**
 * Record once, replay with no model.
 *
 * The first registration on a never-seen provider is interpreted page by
 * page and recorded through the driver's `onApplied` seam: only steps that
 * actually took effect, as sanitized page patterns and control fingerprints,
 * compiled by `compileRecording` with every resolved value excluded. The
 * second registration, for a different fresh address on the same provider, is
 * `runRecordedCeremony` with no fallback: the recording proposes each step,
 * the same driver enforces every rule, and the interpreter is never called.
 */
const sources: Partial<Record<CeremonyRole, ValueSource>> = {
  email: "agent-inbox",
  password: "generated",
  "password-confirm": "generated",
  "display-name": "person-profile",
  "verification-code": "inbox-message",
};

function registrationSecrets(
  session: DemoSession,
  agentInbox: AgentInbox,
  address: string,
  password: string,
  since: number,
  actor: "agent" | "replay",
) {
  return createSecrets({
    email: address,
    password,
    "password-confirm": password,
    "display-name": "Ceremony demo agent",
    "verification-code": async () => {
      session.say({ kind: "inbox", stage: "waiting" });
      session.panel({ kind: "inbox", stage: "waiting" });
      await session.hold(1_000);
      const code = await agentInbox.readCode(address, since);
      if (code) {
        session.protect(code);
        session.say({ kind: "inbox", stage: "received" });
        session.panel({ kind: "inbox", stage: "received" });
        await session.hold(1_600);
        session.say({
          kind: "fill",
          actor,
          role: "verification-code",
          source: "inbox-message",
        });
      }
      return code ?? "";
    },
  });
}

export async function record(session: DemoSession) {
  const scenario = authScenarios.find(
    (entry) => entry.id === session.entry.scenario,
  );
  if (!scenario) throw new Error(`Missing scenario ${session.entry.scenario}`);
  const context = await startScenario(
    withLayout(scenario, session.entry.layout),
    createIdentity(),
  );
  const agentInbox = await startAgentInbox(context.provider, session.protect);
  try {
    const { provider } = context;
    const entryUrl = `${provider.origin}${provider.signupPath}`;
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

    // First run: interpreted, and recorded as it goes.
    await session.card(
      {
        title: "1 · First registration: interpreted and recorded",
        tone: "connector",
        lines: [
          caption({ kind: "recording", stage: "capturing" }),
          "The interpreter reads each sanitized page and proposes the next step.",
        ],
      },
      3_500,
    );
    const first = await agentInbox.inbox.provision();
    const firstAccount = generateIsolatedAccount();
    session.protect(firstAccount.password);
    const firstSince = Date.now();
    await session.page.goto(entryUrl, { waitUntil: "domcontentloaded" });
    session.say({ kind: "inbox", stage: "provisioned" });
    session.panel({ kind: "inbox", stage: "provisioned" });
    await session.hold(1_600);

    const trace: RecordedTraceEntry[] = [];
    let decisions = 0;
    const heuristic = createHeuristicInterpreter();
    const counted: CeremonyInterpreter = async (input) => {
      decisions += 1;
      return heuristic(input);
    };
    const recorded = await runCeremony({
      page: session.ceremonyPage(),
      interpreter: session.narrate(counted, {
        sources,
        phase: (previous, observed) =>
          providerPhase(previous, observed, provider.signupPath),
      }),
      goal: "registration",
      secrets: registrationSecrets(
        session,
        agentInbox,
        first,
        firstAccount.password,
        firstSince,
        "agent",
      ),
      allowedOrigins: [provider.origin],
      protectedValues: [firstAccount.password],
      verify: () => provider.verifyAccess(first),
      onApplied: (entry) => {
        trace.push(entry);
        session.applied(entry);
      },
    });
    session.checkFills(recorded);
    await session.park();
    session.panel(undefined);
    const firstMade =
      recorded.status === "completed" &&
      Boolean(provider.account(first)?.verified);

    const codes = provider.mailbox
      .messages()
      .flatMap((message) => [message.code, message.link]);
    const recording = compileRecording(trace, {
      id: "demo-registration",
      title: "Registration on the self-hosted test provider",
      goal: "registration",
      entryUrl,
      origins: [provider.origin],
      recordedWith: "deterministic",
      excluded: [first, firstAccount.password, "Ceremony demo agent", ...codes],
    });
    const serialized = JSON.stringify(recording);
    for (const value of [first, firstAccount.password, ...codes])
      if (value && serialized.includes(value))
        throw new Error("The compiled recording carries a value");

    session.say({ kind: "recording", stage: "compiled" });
    await session.card(
      {
        title: "Recording compiled",
        tone: "connector",
        lines: [
          caption({ kind: "recording", stage: "compiled" }),
          `${recording.steps.length} recorded steps, ${recording.roles.length} roles, 0 values`,
          `The first run asked the interpreter ${decisions} times.`,
          "In production a person reviews the draft before it is published.",
        ],
      },
      5_000,
    );

    // Second run: a different fresh address, the recording in charge.
    const second = await agentInbox.inbox.provision();
    const secondAccount = generateIsolatedAccount();
    session.protect(secondAccount.password);
    const secondSince = Date.now();
    await session.card(
      {
        title: "2 · Second registration: replayed with no model",
        tone: "connector",
        lines: [
          caption({ kind: "recording", stage: "replaying" }),
          "A new address from the agent inbox; the same driver rules apply.",
        ],
      },
      3_500,
    );
    await session.page.goto(entryUrl, { waitUntil: "domcontentloaded" });
    session.say({ kind: "recording", stage: "replaying" });
    session.panel({ kind: "inbox", stage: "provisioned" });
    await session.hold(1_600);
    const replayed = await runRecordedCeremony({
      page: session.ceremonyPage(),
      recording,
      goal: "registration",
      secrets: registrationSecrets(
        session,
        agentInbox,
        second,
        secondAccount.password,
        secondSince,
        "replay",
      ),
      allowedOrigins: [provider.origin],
      protectedValues: [secondAccount.password],
      verify: () => provider.verifyAccess(second),
      onApplied: session.applied,
      onStep: (step) => {
        if (step.action === "fill" && step.role)
          session.say({
            kind: "fill",
            actor: "replay",
            role: step.role,
            ...(sources[step.role] ? { source: sources[step.role]! } : {}),
          });
        else if (step.action === "click")
          session.say({ kind: "click", actor: "replay", control: "button" });
        else if (step.action === "check")
          session.say({ kind: "check", actor: "replay" });
      },
    });
    session.checkFills(replayed);
    await session.park();
    session.panel(undefined);
    const secondMade =
      replayed.status === "completed" &&
      Boolean(provider.account(second)?.verified);
    const clean = firstMade && secondMade && replayed.interpreterCalls === 0;
    if (clean) {
      session.say({ kind: "recording", stage: "replayed" });
      await session.hold(2_400);
    }
    await session.card(
      {
        title: clean
          ? "Two accounts: one interpreted, one replayed"
          : "The replay did not finish cleanly",
        tone: "result",
        lines: [
          `First run: ${caption({ kind: "outcome", status: recorded.status })} · interpreter calls: ${decisions}`,
          `Replay: ${caption({ kind: "outcome", status: replayed.status })} · interpreter calls: ${replayed.interpreterCalls}`,
          ...(clean
            ? [
                caption({ kind: "verified", what: "account" }),
                "Drift would stop the replay by name; a fallback interpreter is opt-in and only sees the page that drifted.",
              ]
            : []),
        ],
      },
      6_500,
    );
    return { ok: clean, result: replayed };
  } finally {
    await agentInbox.close();
    await context.close();
  }
}
