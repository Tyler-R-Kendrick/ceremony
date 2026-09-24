import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import {
  launchManagedBrowser,
  type ManagedBrowser,
} from "../src/server/browser-backends.js";
import {
  runCeremony,
  type CeremonyResult,
  type IssuedValues,
} from "../src/server/browser-driver.js";
import {
  createHeuristicInterpreter,
  type InterpreterInput,
} from "../src/server/browser-interpreter.js";
import {
  configureSignIn,
  issuedAtA,
  registrationPlan,
  signInPlan,
  startChainProviders,
  type ChainProviders,
} from "./doubles/auth-provider/two-provider-chain.js";

/**
 * The browser halves of the two-provider chain, in real Chromium through the
 * production Playwright adapter.
 *
 * The Node runner parses documents and cannot run a real `readonly` check, a
 * computed style or a real click; this is where the read of an issued value
 * goes through the shipped-in `readOnlyValue` source against a live DOM. Both
 * providers are local fixtures, the interpreter is the production heuristic,
 * and nothing here certifies a real provider.
 */

let browser: ManagedBrowser;
let chain: ChainProviders;

before(async () => {
  browser = await launchManagedBrowser("chromium");
  chain = await startChainProviders();
});

after(async () => {
  await chain?.close();
  await browser?.dispose();
});

async function drive(
  plan: ReturnType<typeof signInPlan>,
  issued?: { keep(values: IssuedValues): Promise<void> },
): Promise<{ result: CeremonyResult; inputs: InterpreterInput[] }> {
  // A fresh context per step: the two steps need not share a browser, and a
  // person signing in to B has not necessarily just been at A.
  const context = await browser.openContext();
  try {
    const { page } = await context.openPage();
    await page.goto(plan.entryUrl);
    const heuristic = createHeuristicInterpreter();
    const inputs: InterpreterInput[] = [];
    const { entryUrl: _entry, ...options } = plan;
    const result = await runCeremony({
      ...options,
      page,
      interpreter: async (input) => {
        inputs.push(structuredClone(input));
        return heuristic(input);
      },
      ...(issued ? { issued: { fields: issuedAtA, keep: issued.keep } } : {}),
    });
    return { result, inputs };
  } finally {
    await context.close();
  }
}

test("CHAIN-CHROMIUM: an app registered at A in Chromium signs a person in to B, with the secret kept out of every snapshot", async () => {
  const kept: IssuedValues[] = [];
  const registration = await drive(registrationPlan(chain), {
    keep: async (values) => {
      kept.push(values);
    },
  });
  assert.equal(registration.result.status, "completed");
  assert.equal(kept.length, 1);
  const clientId = kept[0]!["client-id"]!;
  const secret = kept[0]!["client-secret"]!;
  const [app] = chain.a.oauthApps();
  assert.equal(app?.clientId, clientId);
  assert.match(secret, /^ocs_[a-f0-9]{40}$/);

  // The value read from the live page is the one A accepts.
  const configured = await configureSignIn(chain.b, {
    clientId,
    clientSecret: secret,
  });
  assert.equal(configured.status, 200);

  const signIn = await drive(signInPlan(chain));
  assert.equal(signIn.result.status, "completed");
  assert.deepEqual(chain.b.signIns(), [chain.account.email]);

  const visible = JSON.stringify([registration, signIn]);
  for (const value of [secret, clientId, chain.account.password])
    assert.equal(visible.includes(value), false, value.slice(0, 8));
});
