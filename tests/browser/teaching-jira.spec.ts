import { test, expect, type BrowserContext } from "@playwright/test";
import { teachingGitHubFixture } from "../fixtures/teaching-github.js";

test.use({ trace: "off", screenshot: "off", video: "off" });

for (const setup of ["configured", "owner-setup"] as const)
  test(`Jira ${setup} connects through provider consent and returns to its verified parent`, async ({
    browser,
  }, testInfo) => {
    const fixture = await test.step("Start isolated Jira fixture", () =>
      teachingGitHubFixture(4427, { jira: setup }));
    let context: BrowserContext | undefined;
    try {
      context = await test.step("Create ceremony browser context", () =>
        browser.newContext());
      await fixture.login(context, "jira-owner");
      await fixture.jiraProviderPages(context);
      const page = await context.newPage();
      await page.goto(`${fixture.origin}/?connector=jira`);
      const connect = page.getByRole("button", {
        name: "Connect Jira",
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
        const button = await connect.boundingBox();
        expect(button).not.toBeNull();
        expect(button!.y + button!.height).toBeLessThanOrEqual(viewport.height);
        // Capture only the empty Connect surface; never collector or provider pages.
        if (testInfo.project.name === "chromium" && setup === "configured")
          await page.screenshot({
            path: testInfo.outputPath(`jira-connect-${viewport.width}.png`),
            fullPage: true,
          });
      }
      await connect.click();
      if (setup === "owner-setup") {
        await page
          .getByLabel("Jira site URL")
          .fill("https://synthetic.atlassian.net");
        await connect.click();
      }
      await expect(
        page.getByRole("link", { name: "Continue with Jira", exact: true }),
      ).toBeVisible();
      const parent = new URL(page.url()).searchParams.get("teachingRun");
      expect(parent).toBeTruthy();
      await page
        .getByRole("link", { name: "Continue with Jira", exact: true })
        .click();
      if (setup === "owner-setup") {
        await expect(
          page.getByRole("heading", {
            name: "Configure Jira for this session",
          }),
        ).toBeVisible();
        await expect(
          page.getByRole("link", {
            name: "Open the Atlassian developer console (new tab)",
          }),
        ).toHaveAttribute(
          "href",
          "https://developer.atlassian.com/console/myapps/",
        );
        expect(fixture.effects.jiraExchanges).toBe(0);
        await page
          .getByLabel("Client ID", { exact: true })
          .fill(fixture.jiraCredentials.clientId);
        await page
          .getByLabel("Client secret", { exact: true })
          .fill(fixture.jiraCredentials.clientSecret);
        const collectorPath = new URL(page.url()).pathname;
        const [saved] = await Promise.all([
          page.waitForResponse(
            (response) =>
              new URL(response.url()).pathname === collectorPath &&
              response.request().method() === "POST",
          ),
          page.getByRole("button", { name: "Save app and continue" }).click(),
        ]);
        expect(saved.status()).toBe(200);
      }
      await expect(
        page.getByRole("heading", { name: "Authorize the fixture Jira site" }),
      ).toBeVisible();
      expect(fixture.effects.jiraConsents).toBe(0);
      expect(fixture.effects.jiraExchanges).toBe(0);
      expect(fixture.effects.jiraReads).toBe(0);
      // The synthetic provider document is loaded. Its return must use native HTTP,
      // with no handoff interception left active across the redirect chain.
      await context.unroute(`${fixture.origin}/api/v1/teaching/jira/*/human`);
      const [callback] = await Promise.all([
        page.waitForResponse(
          (response) =>
            new URL(response.url()).pathname ===
            "/api/v1/teaching/jira/authorization-return",
        ),
        page.getByRole("button", { name: "Allow fixture access" }).click(),
      ]);
      expect(callback.status()).toBe(303);
      expect(fixture.effects.jiraCallbackStatus).toBe(303);
      expect(fixture.effects.jiraConsents).toBe(1);
      expect(fixture.effects.jiraExchanges).toBe(1);
      expect(fixture.effects.jiraReads).toBe(1);
      await expect(
        page.getByRole("heading", { name: "Jira connection verified" }),
      ).toBeVisible();
      expect(new URL(page.url()).searchParams.get("teachingRun")).toBe(parent);
      expect(fixture.effects.jiraConsents).toBe(1);
      expect(fixture.effects.jiraExchanges).toBe(1);
      expect(fixture.effects.jiraReads).toBe(1);
      await page.reload();
      await expect(
        page.getByRole("heading", { name: "Jira connection verified" }),
      ).toBeVisible();
      expect(fixture.effects.jiraReads).toBe(1);
      const again = await context.request.post(
        `${fixture.origin}/api/v1/teaching/runs`,
        {
          headers: { origin: fixture.origin },
          data: { connectorId: "jira" },
        },
      );
      expect(again.status()).toBe(200);
      expect((await again.json()).status).toBe("complete");
      expect(fixture.effects.jiraConsents).toBe(1);
      expect(fixture.effects.jiraExchanges).toBe(1);
      expect(fixture.effects.jiraReads).toBeGreaterThan(1);
      // Authenticate the same subject in a different browser session. Shared app
      // configuration may be reused, but its previous private consent must not be.
      const freshContext = await browser.newContext();
      try {
        await fixture.login(freshContext, "jira-owner");
        await fixture.jiraProviderPages(freshContext);
        const freshPage = await freshContext.newPage();
        await freshPage.goto(`${fixture.origin}/?connector=jira`);
        const freshConnect = freshPage.getByRole("button", {
          name: "Connect Jira",
          exact: true,
        });
        await freshConnect.click();
        if (setup === "owner-setup") {
          await freshPage
            .getByLabel("Jira site URL")
            .fill("https://synthetic.atlassian.net");
          await freshConnect.click();
        }
        const handoff = freshPage.getByRole("link", {
          name: "Continue with Jira",
          exact: true,
        });
        await expect(handoff).toBeVisible();
        const freshParent = new URL(freshPage.url()).searchParams.get(
          "teachingRun",
        );
        expect(freshParent).toBeTruthy();
        expect(freshParent).not.toBe(parent);
        await handoff.click();
        await expect(
          freshPage.getByRole("heading", {
            name:
              setup === "configured"
                ? "Authorize the fixture Jira site"
                : "Configure Jira for this session",
          }),
        ).toBeVisible();
        expect(fixture.effects.jiraConsents).toBe(1);
        expect(fixture.effects.jiraExchanges).toBe(1);
      } finally {
        await freshContext.close();
      }
    } finally {
      await context?.close();
      await fixture.close();
    }
  });
