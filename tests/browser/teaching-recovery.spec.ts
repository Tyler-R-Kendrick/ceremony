import { test, expect } from "@playwright/test";
import { teachingGitHubFixture } from "../fixtures/teaching-github.js";

test.use({
  trace: "off",
  video: "off",
  screenshot: "off",
  actionTimeout: 15000,
});
test("AC-20 AC-30: private recovery verifies an existing app after a lost one-shot response", async ({
  page,
  context,
}) => {
  test.setTimeout(120000);
  const fixture = await teachingGitHubFixture(4398, {
    loseConversionResponse: true,
  });
  try {
    await fixture.login(context, "recovery-author");
    await fixture.providerPages(context);
    await page.goto(`${fixture.origin}/`);
    await page
      .getByRole("button", { name: "Teach this connection", exact: true })
      .click();
    await page
      .getByRole("link", { name: "Continue with GitHub", exact: true })
      .click();
    await expect(
      page.getByRole("link", { name: "Approve fixture app" }),
    ).toBeVisible();
    await page.getByRole("link", { name: "Approve fixture app" }).click();
    await expect(
      page.getByRole("heading", {
        name: "GitHub could not confirm this return",
      }),
    ).toBeVisible();
    await page.getByRole("link", { name: "Return to connection" }).click();
    await page
      .getByRole("link", { name: "Recover existing GitHub App" })
      .click();
    // This native private page has no assistant, model tools, recorder or app bundle.
    expect(await page.locator("script[src]").count()).toBe(0);
    await page
      .getByLabel("App ID", { exact: true })
      .fill(String(fixture.privateRecovery.appId));
    await page
      .getByLabel("Private key", { exact: true })
      .fill(fixture.privateRecovery.pem);
    await page.getByRole("button", { name: "Verify existing app" }).click();
    await page
      .getByRole("link", { name: "Continue with GitHub", exact: true })
      .click();
    await page
      .getByRole("link", { name: "Approve fixture installation" })
      .click();
    await expect(
      page.getByRole("heading", {
        name: "GitHub connection verified",
        exact: true,
      }),
    ).toBeVisible();
    expect(fixture.effects.conversions).toBe(1);
    expect(fixture.effects.tokens).toBe(1);
    const safe = await fixture.store.transaction(async (tx) => ({
      events: await tx.list("teaching-fixture", "event"),
      audit: await tx.list("teaching-fixture", "audit"),
      collections: await tx.list("teaching-fixture", "collection"),
    }));
    // Boolean assertions avoid printing protected values in a failing matcher diff.
    expect(JSON.stringify(safe).includes(fixture.privateRecovery.pem)).toBe(
      false,
    );
    expect(safe.collections.length).toBe(0);
    const runId = new URL(page.url()).searchParams.get("teachingRun")!;
    const snapshot = await context.request.get(
      `${fixture.origin}/api/v1/teaching/runs/${runId}`,
    );
    expect((await snapshot.text()).includes(fixture.privateRecovery.pem)).toBe(
      false,
    );
  } finally {
    await fixture.close();
  }
});
