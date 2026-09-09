import { test, expect } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { teachingGitHubFixture } from "../fixtures/teaching-github.js";

test.use({ trace: "off", video: "off", screenshot: "off" });

test("manifest handoff retains a native manual fallback when JavaScript is disabled", async ({
  browser,
}) => {
  const fixture = await teachingGitHubFixture(4399);
  const context = await browser.newContext({ javaScriptEnabled: false });
  try {
    await fixture.login(context, "native-fallback-owner");
    await fixture.providerPages(context);
    const started = await context.request.post(
      `${fixture.origin}/api/v1/teaching/runs`,
      {
        headers: { origin: fixture.origin },
        data: { connectorId: "github" },
      },
    );
    expect(started.status()).toBe(200);
    const run = await started.json();
    const advanced = await context.request.post(
      `${fixture.origin}/api/v1/teaching/runs/${run.id}/advance`,
      {
        headers: { origin: fixture.origin },
        data: {
          nodeId: run.nodes[0].id,
          revision: run.revision,
          commandId: `command-${randomUUID()}`,
        },
      },
    );
    expect(advanced.ok()).toBe(true);
    const page = await context.newPage();
    await page.goto(`${fixture.origin}/api/v1/teaching/github/${run.id}/human`);
    await expect(
      page.getByRole("button", { name: "Continue with GitHub", exact: true }),
    ).toBeVisible();
    expect(fixture.effects.conversions).toBe(0);
    await page
      .getByRole("button", { name: "Continue with GitHub", exact: true })
      .click();
    await expect(
      page.getByRole("link", { name: "Approve fixture app", exact: true }),
    ).toBeVisible();
    expect(fixture.effects.conversions).toBe(0);
  } finally {
    await context.close();
    await fixture.close();
  }
});
