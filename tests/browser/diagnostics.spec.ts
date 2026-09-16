import { test, expect } from "../fixtures/browser-test.js";
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
  for (const file of await readdir(resolve("tests/browser"))) {
    if (file.endsWith(".spec.ts"))
      expect(
        /from ["']@playwright\/test["']/.test(
          await readFile(resolve("tests/browser", file), "utf8"),
        ),
        `${file} must use the shared private-diagnostics fixture`,
      ).toBe(false);
  }
  const directory = await mkdtemp(resolve(".diagnostics-"));
  const canary = `synthetic-private-${randomUUID()}`;
  try {
    await writeFile(
      join(directory, "playwright.config.ts"),
      `import config from '../playwright.config.ts';
export default { ...config, testDir: '.', testMatch: '**/intentional.spec.ts',
webServer: undefined, retries: 0, outputDir: './results',
reporter: [['json', { outputFile: './report.json' }], [${JSON.stringify(resolve("scripts/safe-browser-reporter.ts"))}]],
projects: config.projects.filter(p => p.name !== 'native-webmcp').map(({ name, use }) => ({ name, use })) };
`,
    );
    await mkdir(join(directory, "tests/browser"), { recursive: true });
    await writeFile(
      join(directory, "tests/browser/intentional.spec.ts"),
      `import { test, expect } from ${JSON.stringify(resolve("tests/fixtures/browser-test.ts"))};
for (const kind of ['assertion', 'missing-locator']) test('intentional failure for diagnostic isolation: ' + kind, async ({ page }) => {
  await page.setContent('<main><h1>Private collector</h1><p></p><textarea></textarea></main>');
  await page.locator('p').evaluate((node, value) => { node.textContent = value; }, process.env.DIAGNOSTIC_CANARY);
  await page.locator('textarea').fill(process.env.DIAGNOSTIC_CANARY!);
  await page.evaluate((value) => { document.title = value!; document.body.dataset.private = value; }, process.env.DIAGNOSTIC_CANARY);
  try { if (kind === 'missing-locator') await expect(page.getByRole('button', { name: 'Absent action' })).toBeVisible({ timeout: 100 }); else expect(true).toBe(false); }
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
    expect(report.stats.unexpected).toBe(6);
    const safeText = await readFile(
      join(directory, "artifacts/browser/results.json"),
      "utf8",
    );
    expect(safeText.includes(canary)).toBe(false);
    const safeCases = JSON.parse(safeText).cases;
    expect(safeCases).toHaveLength(6);
    for (const safe of safeCases) {
      expect(safe.firstFailureLine).toBe(7);
      expect(safe.lastStepLine).toBe(8);
    }
    for (const spec of report.suites[0].specs) {
      for (const run of spec.tests) {
        const result = run.results[0];
        expect(result.status).toBe("failed");
        expect(result.error.message.includes("toBe")).toBe(true);
        // Ordinary failure snapshots are disabled; matcher-supplied snapshots
        // must also be removed before Playwright writes its source attachments.
        for (const attachment of result.attachments) {
          expect(attachment.name).toBe("error-context");
          const content = await readFile(attachment.path, "utf8");
          expect(content.includes(canary)).toBe(false);
          expect(/# Page snapshot|```yaml/.test(content)).toBe(false);
        }
      }
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
