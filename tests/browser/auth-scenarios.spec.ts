import { test, expect } from "@playwright/test";
import {
  runCeremony,
  type CeremonyResult,
} from "../../src/server/browser-driver.js";
import { createPlaywrightCeremonyPage } from "../../src/server/browser-page.js";
import { createScriptedInterpreter } from "../doubles/scripted-interpreter.js";
import {
  authScenarios,
  createIdentity,
  startScenario,
} from "../doubles/auth-provider/scenarios.js";
import { startUntrustedOrigin } from "../doubles/auth-provider/server.js";

/**
 * The auth scenario catalog, executed in a real browser.
 *
 * `tests/contracts/auth-scenarios.test.ts` runs the same scenarios against a
 * parsed document over real HTTP, which is fast and covers the protocol. It
 * cannot run scripts, resolve styles or perform a real click, so the identical
 * contract is repeated here through Chromium and the Playwright adapter. Each
 * suite covers what the other cannot; neither is reported as covering both, and
 * neither certifies a live provider.
 */

function detail(result: CeremonyResult): string {
  const reason = result.status === "blocked" ? `:${result.reason}` : "";
  return `${result.status}${reason} in ${result.steps} steps via ${
    result.transcript.map((step) => step.action).join(" > ") || "no steps"
  }`;
}

for (const scenario of authScenarios) {
  test(`browser scenario: ${scenario.id} — ${scenario.title}`, async ({
    page,
  }) => {
    test.skip(
      scenario.browserRunnerSkip !== undefined,
      scenario.browserRunnerSkip,
    );
    const identity = createIdentity();
    const untrusted = scenario.needsUntrustedOrigin
      ? await startUntrustedOrigin()
      : undefined;
    const context = await startScenario(scenario, identity, untrusted);
    try {
      const plan = await scenario.plan(context);
      await page.goto(plan.entryUrl, { waitUntil: "domcontentloaded" });
      const { entryUrl: _entry, state, ...options } = plan;
      const driven = createPlaywrightCeremonyPage(page);
      const human = scenario.human?.(driven, identity);
      const result = await runCeremony({
        ...options,
        page: driven,
        interpreter: createScriptedInterpreter(),
        ...(human ? { human } : {}),
      });

      expect(result.status, detail(result)).toBe(scenario.expect.status);
      if (scenario.expect.status === "blocked" && result.status === "blocked")
        expect(result.reason, detail(result)).toBe(scenario.expect.reason);
      if (scenario.expect.status === "completed" && scenario.expect.callback)
        expect(
          result.status === "completed" ? result.callback?.code : undefined,
        ).toBeTruthy();

      // A real click, a real navigation and a real redirect must not change
      // what the driver is willing to disclose.
      const transcript = JSON.stringify(result.transcript);
      expect(transcript).not.toContain(identity.password);
      for (const message of context.provider.mailbox.messages())
        expect(transcript).not.toContain(message.code);

      await scenario.confirm?.(context, result, state ?? {});
    } finally {
      await context.provider.close();
      await untrusted?.close();
    }
  });
}

test("the snapshot a real browser produces matches the one parsed in Node", async ({
  page,
}) => {
  // The two runners share `snapshotDocument`; this proves the shipped-in copy
  // behaves the same as the in-process one on the same markup, so a contract
  // proved in one place means the same thing in the other.
  const { createHttpCeremonyPage } = await import("../doubles/http-page.js");
  const scenario = authScenarios.find((entry) => entry.id === "sign-in")!;
  const identity = createIdentity();
  const context = await startScenario(scenario, identity, undefined, 4242);
  try {
    const target = `${context.provider.origin}${context.provider.signupPath}`;
    const parsed = createHttpCeremonyPage();
    await parsed.goto(target);
    const fromNode = await parsed.snapshot();
    await page.goto(target, { waitUntil: "domcontentloaded" });
    const fromBrowser = await createPlaywrightCeremonyPage(page).snapshot();
    expect(fromBrowser).toEqual(fromNode);
  } finally {
    await context.provider.close();
  }
});
