import { randomInt } from "node:crypto";
import { createSecrets, runCeremony } from "../../src/server/browser-driver.js";
import {
  createHeuristicInterpreter,
  type CeremonyInterpreter,
} from "../../src/server/browser-interpreter.js";
import { generateIsolatedAccount } from "../../src/server/browser-executor.js";
import { totpCode, totpSeedSpellings } from "../../src/server/totp.js";
import { createIdentity } from "../../tests/doubles/auth-provider/scenarios.js";
import { startAuthProvider } from "../../tests/doubles/auth-provider/server.js";
import { caption } from "./captions.js";
import { redeemOnScreen, startConnectorCallback } from "./connector.js";
import type { DemoSession } from "./harness.js";
import { pathnameOf, providerPhase } from "./phases.js";
import { disclosure, outcomeFacts } from "./story.js";

/**
 * Connect an API for someone who already has an account.
 *
 * The other half of the stitched demo: the same authorization-code request,
 * but the person already has an account, so the agent signs in instead of
 * registering. Sign-in is identifier-first (the address alone, then the
 * password on its own page), and the account has an authenticator enrolled:
 * the agent derives the current RFC 6238 code from the seed it holds with
 * `totpCode` at the moment of filling. The seed is never typed and never
 * shown; only the six-digit code it produces reaches the page.
 */
const base32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

export async function record(session: DemoSession) {
  const callback = await startConnectorCallback();
  const identity = createIdentity();
  const password = generateIsolatedAccount().password;
  // A synthetic enrolment seed, fresh per run.
  const seed = Array.from({ length: 32 }, () => base32[randomInt(32)]).join("");
  for (const spelling of totpSeedSpellings(seed)) session.protect(spelling);
  session.protect(password);
  const provider = await startAuthProvider({
    seed: 41,
    identifierFirst: true,
    requireMfa: true,
    totpSeed: seed,
    accounts: [
      {
        email: identity.email,
        username: identity.username,
        password,
        verified: true,
      },
    ],
    redirectUri: callback.uri,
    layout: session.entry.layout,
  });
  try {
    await session.card(
      {
        title: session.entry.title,
        lines: [
          session.entry.summary,
          ...disclosure(session.entry, provider.markup.seed),
          "The person's sign-in and authenticator seed come from the private collector; the seed only ever produces a code at fill time.",
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
          "This person already has an account at the provider.",
          "The agent signs in with it: no registration, no new address.",
        ],
      },
      4_000,
    );
    await session.page.goto(request.url, { waitUntil: "domcontentloaded" });

    const secrets = createSecrets({
      username: identity.email,
      password,
      "totp-code": async () => {
        const code = totpCode(seed, Date.now());
        session.protect(code);
        return code;
      },
    });
    const narrated = session.narrate(createHeuristicInterpreter(), {
      sources: {
        username: "private-collector",
        password: "private-collector",
        "totp-code": "totp-seed",
      },
      phase: (previous, observed) =>
        providerPhase(previous, observed, provider.signupPath),
    });
    let consentShown = false;
    let decided = false;
    const interpreter: CeremonyInterpreter = async (input) => {
      if (!decided && pathnameOf(input.snapshot.path) === "/signin") {
        decided = true;
        session.step("sign-in");
        session.say({
          kind: "decision",
          what: "has-account-sign-in",
          layout: session.entry.layout,
        });
        await session.hold(2_000);
      }
      const atConsent =
        !consentShown && pathnameOf(input.snapshot.path) === "/authorize";
      if (atConsent) {
        session.step("consent");
        session.say({ kind: "provider", says: "consent-screen" });
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
      goal: "authorize",
      secrets,
      allowedOrigins: [provider.origin],
      onApplied: session.applied,
      redirectUri: provider.redirectUri,
      protectedValues: [password, ...totpSeedSpellings(seed)],
      maxSteps: 30,
    });
    session.checkFills(result);
    await session.park();

    const verified = await redeemOnScreen(session, provider, request, result, {
      expected: identity.email,
      stage: "subject-is-person",
    });
    await session.card(
      {
        title: verified
          ? "Connected: the person's own account, with API access"
          : "The sign-in run did not finish",
        tone: "result",
        lines: [
          ...outcomeFacts(result),
          ...(verified
            ? [
                "One browser run: authorize → identifier → password → authenticator code → consent → callback.",
                "The authenticator code was derived from the held seed at fill time; the seed never left the driver.",
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
    await provider.close();
    await callback.close();
  }
}
