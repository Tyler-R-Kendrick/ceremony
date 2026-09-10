import { test, expect } from "@playwright/test";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { join, resolve } from "node:path";
import { promisify } from "node:util";

test("AC-24 failed browser diagnostics exclude protected DOM and attachments", async () => {
  const directory = await mkdtemp(resolve(".diagnostics-"));
  const canary = `synthetic-private-${randomUUID()}`;
  try {
    await writeFile(
      join(directory, "playwright.config.ts"),
      `import config from '../playwright.config.ts';
export default { ...config, testDir: '.', testMatch: '**/intentional.spec.ts',
webServer: undefined, retries: 0, outputDir: './results',
reporter: [['json', { outputFile: './report.json' }], [${JSON.stringify(resolve("scripts/safe-browser-reporter.ts"))}]],
projects: [{ name: 'chromium', use: { browserName: 'chromium' } }] };
`,
    );
    await mkdir(join(directory, "tests/browser"), { recursive: true });
    await writeFile(
      join(directory, "tests/browser/intentional.spec.ts"),
      `import { test, expect } from '@playwright/test';
test('intentional failure for diagnostic isolation', async ({ page }) => {
  await page.setContent('<main><h1>Private collector</h1><p></p><textarea></textarea></main>');
  await page.locator('p').evaluate((node, value) => { node.textContent = value; }, process.env.DIAGNOSTIC_CANARY);
  await page.locator('textarea').fill(process.env.DIAGNOSTIC_CANARY!);
  await page.evaluate((value) => { document.title = value!; document.body.dataset.private = value; }, process.env.DIAGNOSTIC_CANARY);
  try { expect(true).toBe(false); }
  finally { await test.step('cleanup', async () => { await page.title(); }); }
});
`,
    );
    let exitCode = 0;
    let output = "";
    try {
      const result = await promisify(execFile)(
        process.execPath,
        [
          resolve("node_modules/@playwright/test/cli.js"),
          "test",
          "--config",
          join(directory, "playwright.config.ts"),
        ],
        {
          cwd: directory,
          env: {
            ...process.env,
            PLAYWRIGHT_NO_COPY_PROMPT: "",
            DIAGNOSTIC_CANARY: canary,
          },
          timeout: 20000,
          maxBuffer: 1024 * 1024,
        },
      );
      output = result.stdout + result.stderr;
    } catch (error) {
      const failure = error as {
        code?: number;
        stdout?: string;
        stderr?: string;
      };
      exitCode = failure.code ?? -1;
      output = (failure.stdout ?? "") + (failure.stderr ?? "");
    }
    expect(exitCode).toBe(1);
    expect(output.includes(canary)).toBe(false);
    const reportText = await readFile(join(directory, "report.json"), "utf8");
    expect(reportText.includes(canary)).toBe(false);
    const report = JSON.parse(reportText);
    expect(report.stats.unexpected).toBe(1);
    const result = report.suites[0].specs[0].tests[0].results[0];
    expect(result.status).toBe("failed");
    expect(result.error.message.includes("toBe")).toBe(true);
    const safeText = await readFile(
      join(directory, "artifacts/browser/results.json"),
      "utf8",
    );
    expect(safeText.includes(canary)).toBe(false);
    const safe = JSON.parse(safeText).cases[0];
    expect(safe.firstFailureLine).toBe(7);
    expect(safe.lastStepLine).toBe(8);
    // This version always attaches assertion/source context, but the opt-out
    // must prevent its automatic ARIA snapshot before it is collected.
    for (const attachment of result.attachments) {
      expect(attachment.name).toBe("error-context");
      const content = await readFile(attachment.path, "utf8");
      expect(content.includes(canary)).toBe(false);
      expect(/# Page snapshot|```yaml/.test(content)).toBe(false);
    }
    const files = await readdir(join(directory, "results"), {
      recursive: true,
    });
    expect(
      files.some((file) => /\.png$|\.webm$|\.zip$|\.har$/.test(file)),
    ).toBe(false);
    for (const file of files) {
      if (file.endsWith(".json") || file.endsWith(".md")) {
        expect(
          (await readFile(join(directory, "results", file), "utf8")).includes(
            canary,
          ),
        ).toBe(false);
      }
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
