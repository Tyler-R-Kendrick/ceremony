import { createSecrets, runCeremony } from "../../src/server/browser-driver.js";
import {
  createHeuristicInterpreter,
  type CeremonyInterpreter,
} from "../../src/server/browser-interpreter.js";
import { generateIsolatedAccount } from "../../src/server/browser-executor.js";
import {
  nextTotpCode,
  totpCode,
  totpSeedSpellings,
} from "../../src/server/totp.js";
import { authScenarios } from "../../tests/doubles/auth-provider/scenarios.js";
import { startAuthProvider } from "../../tests/doubles/auth-provider/server.js";
import { startAgentInbox } from "./agent-inbox.js";
import { caption } from "./captions.js";
import type { DemoSession } from "./harness.js";
import { pathnameOf, providerPhase } from "./phases.js";
import { disclosure, outcomeFacts } from "./story.js";

/**
 * PRIMARY: register, then enrol a second factor, then sign in with it.
 *
 * The agent registers a new account with a fresh agent-inbox address and a
 * generated password, and confirms the emailed code. The provider then
 * requires an authenticator app before the account is usable: it shows a
 * setup key and asks for a code from the app. The plan declares that field
 * as an issued `totp-seed`, so the *driver* reads the key into custody (here,
 * the demo's stand-in for the host's `credential-custody` sink), guards
 * every spelling of it, and answers the page with a code it computes from the
 * seed at fill time. The interpreter is offered the role and never sees the
 * seed or the code.
 *
 * Later, in an empty browser, the agent signs in again. The provider now asks
 * for an authenticator code, and the agent answers it from the seed custody
 * holds, again computed at the moment of filling.
 *
 * The provider page shows the setup key, and the driver types codes in plain
 * sight, so the video boxes out the setup key and every code field from the
 * moment each appears; the page is not touched. Nothing a caption, card or
 * transcript carries includes the seed in any spelling, or any code it made.
 */
const codeFields = [
  // The emailed code, the setup key, the enrolment code, the sign-in code.
  "#verify-code",
  "#totp-setup-key",
  "#totp-setup-code",
  "#totp-code",
];

export async function record(session: DemoSession) {
  const scenario = authScenarios.find(
    (entry) => entry.id === session.entry.scenario,
  );
  if (!scenario) throw new Error(`Missing scenario ${session.entry.scenario}`);
  // The scenario's behaviour (confirmation by code, an authenticator on
  // every account) in this demo's layout, with no account yet.
  const provider = await startAuthProvider({
    ...scenario.behavior({}),
    accounts: [],
    layout: session.entry.layout,
  });
  const agentInbox = await startAgentInbox(provider, session.protect);
  const started = Date.now();
  /** The host's private collector, as far as this demo goes. */
  const custody = new Map<string, string>();
  /** Every code the held seed could have produced while this ran. */
  const protectCodes = (seed: string) => {
    for (let at = started - 60_000; at <= Date.now() + 120_000; at += 30_000)
      session.protect(totpCode(seed, at));
  };
  try {
    await session.card(
      {
        title: session.entry.title,
        lines: [
          session.entry.summary,
          ...disclosure(session.entry, provider.markup.seed),
          "The setup key and every code field are covered by a solid box in this video, from the moment each appears. The page itself is unchanged.",
        ],
      },
      12_000,
    );

    // Segment 1: register, confirm, enrol.
    const address = await agentInbox.inbox.provision();
    const account = generateIsolatedAccount();
    session.protect(account.password);
    const since = Date.now();
    session.redact(codeFields);
    await session.page.goto(`${provider.origin}${provider.signupPath}`, {
      waitUntil: "domcontentloaded",
    });
    session.step("register");
    session.say({ kind: "inbox", stage: "provisioned" });
    session.panel({ kind: "inbox", stage: "provisioned" });
    await session.hold(2_200);
    session.panel({
      kind: "chain",
      chain: session.entry.chain!,
      current: "register",
    });

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
        "verification-code": "inbox-message",
        "totp-code": "totp-seed",
      },
      phase: (previous, observed) =>
        providerPhase(previous, observed, provider.signupPath),
    });
    let setupShown = false;
    const enrolling: CeremonyInterpreter = async (input) => {
      // The setup page, held on screen before anything is done on it. By
      // now the driver has already read the key into custody: that happens
      // before an interpreter is asked anything about the page.
      if (!setupShown && pathnameOf(input.snapshot.path) === "/mfa/setup") {
        setupShown = true;
        session.step("enroll-authenticator");
        session.say({ kind: "provider", says: "setup-authenticator" });
        await session.hold(2_400);
        session.say({ kind: "custody", stage: "seed-kept" });
        session.panel({ kind: "custody", stage: "held" });
        session.poster();
        await session.hold(3_000);
        session.panel({
          kind: "chain",
          chain: session.entry.chain!,
          current: "enroll-authenticator",
        });
      }
      return narrated(input);
    };
    const registered = await runCeremony({
      page: session.ceremonyPage(),
      interpreter: enrolling,
      goal: "registration",
      secrets,
      allowedOrigins: [provider.origin],
      onApplied: session.applied,
      protectedValues: [account.password],
      // The plan keeps the setup key, and only into custody.
      issued: {
        fields: { "totp-seed": "Setup key" },
        keep: async ({ "totp-seed": seed }) => {
          if (!seed) return;
          for (const spelling of totpSeedSpellings(seed))
            session.protect(spelling);
          protectCodes(seed);
          custody.set(address, seed);
        },
      },
      verify: () => provider.verifyAccess(address),
    });
    session.checkFills(registered);
    await session.park();
    const seed = custody.get(address);
    const enrolled =
      registered.status === "completed" &&
      seed !== undefined &&
      provider.account(address)?.totpSeed === seed.replace(/\s/g, "");
    if (enrolled) {
      session.say({ kind: "provider", says: "signed-in" });
      await session.hold(2_000);
    }
    await session.card(
      {
        title: enrolled
          ? "Account created, authenticator on, seed in custody"
          : "Registration and enrolment did not finish",
        tone: "result",
        lines: [
          ...outcomeFacts(registered),
          ...(enrolled
            ? [
                caption({ kind: "verified", what: "account" }),
                "The driver read the setup key into custody before the interpreter saw the page, and confirmed it with a code it derived from the seed.",
                "The interpreter was offered an authenticator code role; it never saw the seed or a code.",
              ]
            : []),
        ],
      },
      8_000,
    );
    if (!enrolled || !seed) return { ok: false, result: registered };

    // Segment 2: later, in an empty browser, sign in with the held seed.
    await session.card(
      {
        title: "Later: sign in again",
        tone: "intro",
        lines: [
          "The browser starts empty. The provider now asks this account for an authenticator code at every sign-in.",
          "The agent answers it from the seed custody holds, computed at the moment of filling.",
        ],
      },
      6_000,
    );
    await session.page.context().clearCookies();
    session.redact(codeFields);
    await session.page.goto(`${provider.origin}/signin?next=/`, {
      waitUntil: "domcontentloaded",
    });
    session.step("sign-in-again");
    session.panel({ kind: "custody", stage: "held" });
    await session.hold(1_600);
    let decided = false;
    const again = session.narrate(createHeuristicInterpreter(), {
      sources: {
        email: "private-collector",
        password: "private-collector",
        "totp-code": "totp-seed",
      },
      phase: (previous, observed) => {
        const phase = providerPhase(previous, observed, provider.signupPath);
        return phase === "sign-in" ? "sign-in-again" : phase;
      },
    });
    const signingIn: CeremonyInterpreter = async (input) => {
      if (!decided) {
        decided = true;
        session.say({
          kind: "decision",
          what: "has-account-sign-in",
          layout: session.entry.layout,
        });
        await session.hold(2_000);
        session.panel({
          kind: "chain",
          chain: session.entry.chain!,
          current: "sign-in-again",
        });
      }
      return again(input);
    };
    let derived = 0;
    const signedIn = await runCeremony({
      page: session.ceremonyPage(),
      interpreter: signingIn,
      goal: "sign-in",
      secrets: createSecrets({
        email: address,
        password: account.password,
        // Resolved from custody when the field is filled, never before: a
        // code computed early can expire before it is submitted.
        "totp-code": async () => {
          const held = custody.get(address);
          if (!held) throw new Error("no seed in custody");
          derived++;
          session.say({ kind: "custody", stage: "code-derived" });
          session.panel({ kind: "custody", stage: "used" });
          await session.hold(2_000);
          session.panel({
            kind: "chain",
            chain: session.entry.chain!,
            current: "second-factor",
          });
          session.say({
            kind: "fill",
            actor: "agent",
            role: "totp-code",
            source: "totp-seed",
          });
          // Never the code that confirmed the enrolment: if that one is
          // still current, this waits for the next period, as the provider
          // accepts each code once.
          const code = await nextTotpCode(held);
          session.protect(code);
          return code;
        },
      }),
      allowedOrigins: [provider.origin],
      onApplied: session.applied,
      protectedValues: [account.password, ...totpSeedSpellings(seed)],
      // Who this browser is signed in as, asked of the provider with this
      // browser's own cookies: an earlier session proves nothing here.
      verify: async () => {
        const answer = await session.page
          .context()
          .request.get(`${provider.origin}/api/whoami`);
        return answer.status() === 200;
      },
    });
    session.checkFills(signedIn);
    await session.park();
    const ok = signedIn.status === "completed" && derived === 1;
    if (ok) {
      session.step("verified");
      session.say({ kind: "verified", what: "session" });
      await session.hold(2_400);
    }
    await session.card(
      {
        title: ok
          ? "Signed in with the held seed"
          : "The second sign-in did not finish",
        tone: "result",
        lines: [
          ...outcomeFacts(signedIn),
          ...(ok
            ? [
                "Register → emailed code → authenticator enrolled from a kept seed → later sign-in → code from the held seed.",
                caption({ kind: "verified", what: "session" }),
                "The seed, in every spelling, and every code it produced appear in no caption, card or driver transcript.",
              ]
            : []),
        ],
      },
      8_000,
    );
    return { ok, result: signedIn };
  } finally {
    await agentInbox.close();
    await provider.close();
  }
}
