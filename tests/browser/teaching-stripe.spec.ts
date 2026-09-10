import { test, expect } from "@playwright/test";
import { teachingGitHubFixture } from "../fixtures/teaching-github.js";

test.use({ trace: "off", screenshot: "off", video: "off" });

test("Stripe connects through account setup and private collection, then reloads the same verified parent", async ({
  browser,
}, testInfo) => {
  const fixture = await teachingGitHubFixture(4419, { stripe: true });
  const context = await browser.newContext();
  try {
    await fixture.login(context, "stripe-owner");
    const page = await context.newPage();
    page.setDefaultTimeout(5000);
    await page.goto(`${fixture.origin}/?connector=stripe`);
    await expect(
      page.getByRole("button", { name: "Connect Stripe", exact: true }),
    ).toBeVisible();
    for (const viewport of [
      { width: 1440, height: 1000 },
      { width: 390, height: 844 },
    ]) {
      await page.setViewportSize(viewport);
      expect(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= innerWidth,
        ),
      ).toBe(true);
      const action = await page
        .getByRole("button", { name: "Connect Stripe", exact: true })
        .boundingBox();
      expect(action).not.toBeNull();
      expect(action!.y + action!.height).toBeLessThanOrEqual(viewport.height);
      // Only the empty, non-sensitive Connect surface is captured; never the private collector or provider page.
      if (testInfo.project.name === "chromium")
        await page.screenshot({
          path: testInfo.outputPath(`stripe-connect-${viewport.width}.png`),
          fullPage: true,
        });
    }
    await page
      .getByRole("button", { name: "Connect Stripe", exact: true })
      .click();
    await expect(
      page
        .getByText("Open or create your Stripe account", { exact: false })
        .first(),
    ).toBeVisible();
    const parent = new URL(page.url()).searchParams.get("teachingRun");
    expect(parent).toBeTruthy();
    await page
      .getByRole("link", { name: "Continue with Stripe", exact: true })
      .click();
    await expect(
      page.getByRole("heading", { name: "Set up your Stripe account" }),
    ).toBeVisible();
    await expect(
      page.getByRole("link", { name: "Create a Stripe account (new tab)" }),
    ).toHaveAttribute("href", "https://dashboard.stripe.com/register");
    await expect(page.getByLabel("Restricted API key")).toHaveCount(0);
    expect(fixture.effects.stripeReads).toBe(0);
    await fixture.store.transaction(async (tx) => {
      for (const record of await tx.list<Record<string, unknown>>(
        "teaching-fixture",
        "handoff",
      )) {
        if (record.id.startsWith("stripe-collector:"))
          await tx.put(
            { tenant: "teaching-fixture", kind: "handoff", id: record.id },
            { ...record.value, expires: 0 },
            record.revision,
          );
      }
    });
    // Account signup/MFA may outlast the displayed form; submission obtains a fresh recipient-bound ticket.
    await page.getByRole("button", { name: "My account is ready" }).click();
    await expect(
      page.getByRole("heading", { name: "Connect your Stripe key" }),
    ).toBeVisible();
    await page
      .getByLabel("Restricted API key")
      .fill("pk_test_not_a_server_key");
    expect(
      await page
        .getByLabel("Restricted API key")
        .evaluate((element) => (element as HTMLInputElement).checkValidity()),
    ).toBe(false);
    await page.getByRole("button", { name: "Verify Stripe access" }).click();
    expect(fixture.effects.stripeReads).toBe(0);
    await page.getByLabel("Restricted API key").fill(fixture.stripeKey);
    await page.getByRole("button", { name: "Verify Stripe access" }).click();
    await expect(
      page.getByRole("heading", { name: "Stripe connection verified" }),
    ).toBeVisible();
    expect(new URL(page.url()).searchParams.get("teachingRun")).toBe(parent);
    expect(fixture.effects.stripeReads).toBe(1);
    await page.reload();
    await expect(
      page.getByRole("heading", { name: "Stripe connection verified" }),
    ).toBeVisible();
    expect(
      fixture.effects.stripeReads,
      "Snapshot reload must not poll Stripe",
    ).toBe(1);
    expect(
      await page.evaluate(
        (token) => document.body.textContent?.includes(token),
        fixture.stripeKey,
      ),
      "Credential must not remain in the connection page",
    ).toBe(false);
  } finally {
    try {
      await context.close();
    } finally {
      await fixture.close();
    }
  }
});
