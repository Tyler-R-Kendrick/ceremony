import assert from "node:assert/strict";
import { writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { runCeremony } from "../../src/server/browser-driver.js";
import { createAgentBrowserPage } from "../doubles/agent-browser.js";
import { createScriptedInterpreter } from "../doubles/scripted-interpreter.js";
import {
  authScenarios,
  createIdentity,
  startScenario,
} from "../doubles/auth-provider/scenarios.js";
import { startUntrustedOrigin } from "../doubles/auth-provider/server.js";

/**
 * The auth scenario catalog, driven through a real browser by the
 * `agent-browser` CLI.
 *
 * The Node contract suite proves the protocol and the browser suite proves a
 * real click; this one exists for evidence. Every ceremony is recorded as
 * video and its console and page errors are captured, so a flow that breaks
 * leaves something a person can watch rather than a status word. Artifacts
 * land under `artifacts/flows/<scenario>/`.
 *
 * These are our own doubles, which is what makes capturing any of it safe:
 * nothing provider-owned or credential-bearing is retained, and verification's
 * rule against keeping raw provider or DOM diagnostics is untouched. Pointing
 * this runner at a live provider would break that rule, so it never is.
 */

const artifactRoot = join("artifacts", "flows");
/** Scenarios whose wall is browser chrome rather than page content. */
const runnable = authScenarios.filter(
  (scenario) => scenario.browserRunnerSkip === undefined,
);

for (const scenario of runnable) {
  test(`flow: ${scenario.id} — ${scenario.title}`, async (t: TestContext) => {
    const identity = createIdentity();
    const untrusted = scenario.needsUntrustedOrigin
      ? await startUntrustedOrigin()
      : undefined;
    const context = await startScenario(scenario, identity, untrusted);
    const directory = join(artifactRoot, scenario.id);
    const page = createAgentBrowserPage({
      session: `flow-${scenario.id}`,
      artifacts: directory,
    });
    t.after(async () => {
      await page.close();
      await context.close();
      await untrusted?.close();
    });

    const plan = await scenario.plan(context);
    const headers = scenario.clientHeaders?.(context);
    if (headers) await page.setHeaders(headers);
    await page.goto(plan.entryUrl);
    await page.startRecording("ceremony");

    const { entryUrl: _entry, state, ...options } = plan;
    const human = scenario.human?.(page, identity);
    const result = await runCeremony({
      ...options,
      page,
      interpreter: createScriptedInterpreter(),
      ...(human ? { human } : {}),
    });
    await page.stopRecording();

    // Evidence is written before the assertion, so a failing flow still leaves
    // its recording, console and transcript behind.
    await mkdir(directory, { recursive: true });
    await writeFile(
      join(directory, "ceremony.json"),
      `${JSON.stringify(
        {
          scenario: scenario.id,
          flowKind: scenario.flowKind,
          family: scenario.family,
          expected: scenario.expect,
          status: result.status,
          steps: result.steps,
          handoffs: result.handoffs,
          transcript: result.transcript,
        },
        null,
        2,
      )}\n`,
    );
    const [messages, failures] = await Promise.all([
      page.console(),
      page.errors(),
    ]);
    await writeFile(join(directory, "console.log"), `${messages}\n`);
    await writeFile(join(directory, "errors.log"), `${failures}\n`);

    const summary = `${scenario.id}: ${result.status}${
      result.status === "blocked" ? `:${result.reason}` : ""
    } in ${result.steps} steps`;
    assert.equal(result.status, scenario.expect.status, summary);
    if (scenario.expect.status === "blocked")
      assert.equal(
        result.status === "blocked" ? result.reason : undefined,
        scenario.expect.reason,
        summary,
      );
    if (scenario.expect.handoffs !== undefined)
      assert.equal(result.handoffs, scenario.expect.handoffs, summary);

    // A real browser is where a page's own scripts can fail. Nothing in these
    // doubles should throw, so an uncaught error is a finding, not noise.
    assert.equal(failures, "", `${scenario.id} produced page errors`);

    // The same disclosure rules hold in a third runner.
    const recorded = JSON.stringify(result.transcript);
    assert.ok(
      !recorded.includes(identity.password),
      `${scenario.id} recorded a password`,
    );
    for (const mail of context.provider.mailbox.messages())
      assert.ok(
        !recorded.includes(mail.code),
        `${scenario.id} recorded a confirmation code`,
      );

    await scenario.confirm?.(context, result, state ?? {});
  });
}

test("the flow catalog covers every scenario a browser can host", () => {
  const excluded = authScenarios.length - runnable.length;
  assert.equal(
    runnable.length + excluded,
    authScenarios.length,
    "Every scenario is either run or explicitly excluded",
  );
  assert.ok(
    excluded <= 2,
    `Only browser-chrome walls may be excluded; ${excluded} were`,
  );
});
