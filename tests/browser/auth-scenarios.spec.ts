import { test, expect, type Page } from "../fixtures/browser-test.js";
import {
  runCeremony,
  type CeremonyResult,
} from "../../src/server/browser-driver.js";
import {
  createHeuristicInterpreter,
  type CeremonyInterpreter,
} from "../../src/server/browser-interpreter.js";
import { createPlaywrightCeremonyPage } from "../../src/server/browser-page.js";
import { createScriptedInterpreter } from "../doubles/scripted-interpreter.js";
import {
  assertFillsMatchLabels,
  recordDecisions,
} from "../doubles/fill-labels.js";
import {
  realisticLayouts,
  type RealisticLayout,
} from "../doubles/auth-provider/layouts.js";
import {
  authScenarios,
  createIdentity,
  startScenario,
  withLayout,
  type AuthScenario,
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

/**
 * Scenarios a real browser genuinely cannot host are excluded rather than
 * declared and skipped: verification treats a skipped browser result as a
 * failure, and rightly so — a skip is indistinguishable from a test that
 * quietly stopped covering anything. Each exclusion names its reason, and each
 * still runs in full in the Node contract suite.
 */
const browserCatalog = authScenarios.filter(
  (scenario) => scenario.browserRunnerSkip === undefined,
);

for (const scenario of browserCatalog) {
  test(`browser scenario: ${scenario.id} — ${scenario.title}`, async ({
    page,
  }) => {
    const identity = createIdentity();
    const untrusted = scenario.needsUntrustedOrigin
      ? await startUntrustedOrigin()
      : undefined;
    const context = await startScenario(scenario, identity, untrusted);
    try {
      const plan = await scenario.plan(context);
      const headers = scenario.clientHeaders?.(context);
      if (headers) await page.setExtraHTTPHeaders(headers);
      await page.goto(plan.entryUrl, { waitUntil: "domcontentloaded" });
      const { entryUrl: _entry, state, ...options } = plan;
      const driven = createPlaywrightCeremonyPage(page);
      const human = scenario.human?.(driven, identity, context);
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
      await context.close();
      await untrusted?.close();
    }
  });
}

/**
 * The same catalog on pages that look like real ones, where Chromium
 * enforces what a parsed document cannot: `required`, `minlength`, the
 * code field's pattern, and the CSS that decides what is visible. The
 * classic card carries the whole browser catalog; every layout carries the
 * flows a demonstration shows, driven by the production heuristic that
 * demos use. Each run is also held to its fills: every value went into the
 * field labelled for it.
 */
async function runOnLayout(
  page: Page,
  scenario: AuthScenario,
  layout: RealisticLayout,
  interpreter: CeremonyInterpreter,
): Promise<void> {
  const identity = createIdentity();
  const untrusted = scenario.needsUntrustedOrigin
    ? await startUntrustedOrigin()
    : undefined;
  const context = await startScenario(
    withLayout(scenario, layout),
    identity,
    untrusted,
  );
  try {
    const plan = await scenario.plan(context);
    const headers = scenario.clientHeaders?.(context);
    if (headers) await page.setExtraHTTPHeaders(headers);
    await page.goto(plan.entryUrl, { waitUntil: "domcontentloaded" });
    const { entryUrl: _entry, state, ...options } = plan;
    const driven = createPlaywrightCeremonyPage(page);
    const human = scenario.human?.(driven, identity, context);
    const recorded = recordDecisions(interpreter);
    const result = await runCeremony({
      ...options,
      page: driven,
      interpreter: recorded.interpreter,
      ...(human ? { human } : {}),
    });
    expect(result.status, detail(result)).toBe(scenario.expect.status);
    if (scenario.expect.status === "blocked" && result.status === "blocked")
      expect(result.reason, detail(result)).toBe(scenario.expect.reason);
    if (scenario.expect.status === "completed" && scenario.expect.callback)
      expect(
        result.status === "completed" ? result.callback?.code : undefined,
      ).toBeTruthy();
    assertFillsMatchLabels(result.transcript, recorded.decisions);
    const transcript = JSON.stringify(result.transcript);
    expect(transcript).not.toContain(identity.password);
    await scenario.confirm?.(context, result, state ?? {});
  } finally {
    await context.close();
    await untrusted?.close();
  }
}

for (const scenario of browserCatalog)
  test(`classic-card scenario: ${scenario.id}`, async ({ page }) => {
    await runOnLayout(
      page,
      scenario,
      "classic-card",
      createScriptedInterpreter(),
    );
  });

const demonstrated = [
  "sign-in",
  "sign-in-with-second-factor",
  "registration-with-emailed-code",
  "registration-started-from-sign-in",
  "authorization-code-with-consent",
  "authorization-requires-registration-first",
];
for (const layout of realisticLayouts)
  for (const id of demonstrated)
    test(`${layout} heuristic: ${id}`, async ({ page }) => {
      const scenario = authScenarios.find((entry) => entry.id === id)!;
      await runOnLayout(page, scenario, layout, createHeuristicInterpreter());
    });

test("every scenario a browser can host is in the browser catalog", () => {
  const excluded = authScenarios.filter(
    (scenario) => scenario.browserRunnerSkip !== undefined,
  );
  // `browserCatalog` is this set's complement, so counting them against the
  // total proves nothing. The reason and the bound are what matter.
  expect(browserCatalog.length).toBeGreaterThan(0);
  // An exclusion without a stated reason is just a gap.
  for (const scenario of excluded)
    expect(
      (scenario.browserRunnerSkip ?? "").length,
      `${scenario.id} must say why a browser cannot host it`,
    ).toBeGreaterThan(30);
  // Exclusions stay exceptional; a growing list means the runner is drifting.
  expect(excluded.length).toBeLessThanOrEqual(2);
});

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
    await context.close();
  }
});
