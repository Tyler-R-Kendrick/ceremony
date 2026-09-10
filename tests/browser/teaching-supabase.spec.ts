import { test, expect } from "@playwright/test";
import { teachingGitHubFixture } from "../fixtures/teaching-github.js";

test.use({ trace: "off", screenshot: "off", video: "off" });

for (const assurance of ["aal1", "aal2"] as const)
  test(`Supabase ${assurance} connects from project setup through confirmed signup and private verification`, async ({
    browser,
  }, testInfo) => {
    const fixture = await teachingGitHubFixture(4423, { supabase: assurance });
    const context = await browser.newContext();
    try {
      await fixture.login(context, "supabase-owner");
      const page = await context.newPage();
      page.setDefaultTimeout(5000);
      await page.goto(`${fixture.origin}/?connector=supabase`);
      const connect = page.getByRole("button", {
        name: "Connect Supabase",
        exact: true,
      });
      await expect(connect).toBeVisible();
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
        if (testInfo.project.name === "chromium" && assurance === "aal1")
          await page.screenshot({
            path: testInfo.outputPath(`supabase-connect-${viewport.width}.png`),
            fullPage: true,
          });
      }
      await connect.click();
      await page.getByRole("link", { name: "Continue with Supabase" }).click();
      const privateUrl = page.url();
      const parent = decodeURIComponent(
        new URL(privateUrl).pathname.split("/")[5]!,
      );
      await expect(
        page.getByRole("heading", { name: "Set up your Supabase project" }),
      ).toBeVisible();
      await expect(
        page.getByRole("link", { name: "Create a Supabase account (new tab)" }),
      ).toHaveAttribute("href", "https://supabase.com/dashboard/sign-up");
      expect(fixture.effects.supabaseSignups).toBe(0);
      expect(fixture.effects.supabaseReads).toBe(0);
      await page
        .getByLabel("Project URL")
        .fill("https://synthetic.supabase.co");
      await page
        .getByLabel("Publishable or legacy anon key")
        .fill("sb_secret_not_allowed");
      await page.getByRole("button", { name: "Use this project" }).click();
      await expect(page.getByRole("status")).toContainText(
        "not a secret or service-role key",
      );
      expect(page.url()).toBe(privateUrl);
      await page
        .getByLabel("Project URL")
        .fill("https://synthetic.supabase.co");
      await page
        .getByLabel("Publishable or legacy anon key")
        .fill("sb_publishable_synthetic");
      await page.getByRole("button", { name: "Use this project" }).click();
      await expect(
        page.getByRole("heading", { name: "Connect your project account" }),
      ).toBeVisible();
      await page.getByLabel("Email address").fill("project-user@example.com");
      await page
        .getByLabel("Password", { exact: true })
        .fill("synthetic-wrong-password");
      await page
        .getByRole("button", { name: "Continue with this account" })
        .click();
      await expect(page.getByRole("status")).toContainText(
        "Sign-in could not be verified",
      );
      expect(fixture.effects.supabaseSignups).toBe(0);
      await page.getByLabel("Account action").selectOption("sign-up");
      await page.getByLabel("Email address").fill("project-user@example.com");
      await page
        .getByLabel("Password", { exact: true })
        .fill("synthetic-project-password");
      const [signupResponse] = await Promise.all([
        page.waitForResponse(
          (response) =>
            response.url() === privateUrl &&
            response.request().method() === "POST",
        ),
        page.getByRole("button", { name: "Continue with this account" }).click(),
      ]);
      expect(signupResponse.status()).toBe(200);
      expect(fixture.effects.supabaseSignups).toBe(1);
      await expect(
        page.getByRole("heading", { name: "Confirm your email" }),
      ).toBeVisible();
      expect(fixture.effects.supabaseSignups).toBe(1);
      await Promise.all([
        page.waitForNavigation({ waitUntil: "load" }),
        page.getByRole("button", { name: "Check confirmed account" }).click(),
      ]);
      await expect(
        page.getByRole("heading", { name: "Confirm your email" }),
      ).toBeVisible();
      expect(fixture.effects.supabaseSignups).toBe(1);
      const confirmation = await context.newPage();
      await confirmation.goto(fixture.supabaseConfirmationUrl);
      await confirmation.close();
      await page
        .getByRole("button", { name: "Check confirmed account" })
        .click();
      if (assurance === "aal2") {
        await expect(
          page.getByRole("heading", { name: "Verify with your authenticator" }),
        ).toBeVisible();
        await page.getByLabel("Six-digit code").fill("654321");
        await page
          .getByRole("button", { name: "Verify authenticator", exact: true })
          .click();
        await expect(page.getByRole("status")).toContainText(
          "Enter a fresh code",
        );
        expect(fixture.effects.supabaseMfa).toBe(0);
        expect(await page.getByLabel("Six-digit code").inputValue()).toBe("");
        await page.getByLabel("Six-digit code").fill("123456");
        await page
          .getByRole("button", { name: "Verify authenticator", exact: true })
          .click();
      }
      await expect(
        page.getByRole("heading", { name: "Supabase connection verified" }),
      ).toBeVisible();
      expect(fixture.effects.supabaseMfa).toBe(assurance === "aal2" ? 1 : 0);
      expect(new URL(page.url()).searchParams.get("teachingRun")).toBe(parent);
      expect(fixture.effects.supabaseReads).toBeGreaterThan(0);
      expect(fixture.effects.supabaseSignups).toBe(1);
      await page.reload();
      await expect(
        page.getByRole("heading", { name: "Supabase connection verified" }),
      ).toBeVisible();
      const response = await context.request.get(privateUrl);
      expect(response.status()).toBe(403);
    } finally {
      await context.close();
      await fixture.close();
    }
  });
