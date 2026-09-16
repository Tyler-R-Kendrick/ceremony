import { test, expect } from "@playwright/test";
import { teachingGitHubFixture } from "../fixtures/teaching-github.js";

test.use({ trace: "off", screenshot: "off", video: "off" });

test("Jira owner contribution resumes the requester through real provider consent", async ({
  browser,
}) => {
  const fixture = await teachingGitHubFixture(4447, {
    jira: "owner-contribution",
  });
  const requester = await browser.newContext();
  const owner = await browser.newContext();
  try {
    await fixture.login(requester, "requester");
    await fixture.login(owner, "integration-owner");
    await fixture.jiraProviderPages(requester);
    const page = await requester.newPage();
    await page.goto(`${fixture.origin}/?connector=jira`);
    await page
      .getByRole("button", { name: "Connect Jira", exact: true })
      .click();
    await page
      .getByLabel("Jira site URL")
      .fill("https://synthetic.atlassian.net");
    await page
      .getByRole("button", { name: "Connect Jira", exact: true })
      .click();
    const handoff = page.getByRole("link", {
      name: "Continue with Jira",
      exact: true,
    });
    await expect(handoff).toBeVisible();
    const parent = new URL(page.url()).searchParams.get("teachingRun");
    expect(parent).toBeTruthy();
    await handoff.click();
    await page
      .getByRole("button", { name: "Request owner setup", exact: true })
      .click();
    const ownerLink = page.getByRole("link", {
      name: "Open owner setup (owner sign-in required)",
    });
    await expect(ownerLink).toBeVisible();
    const path = await ownerLink.getAttribute("href");
    expect(path).toBeTruthy();
    expect(
      (await requester.request.get(`${fixture.origin}${path}`)).status(),
    ).toBe(403);
    const ownerPage = await owner.newPage();
    await ownerPage.goto(`${fixture.origin}${path}`);
    await expect(
      ownerPage.getByRole("heading", { name: "Set up the shared Jira app" }),
    ).toBeVisible();
    for (const width of [1440, 390]) {
      await ownerPage.setViewportSize({ width, height: 1000 });
      expect(
        await ownerPage.evaluate(
          () => document.documentElement.scrollWidth <= innerWidth,
        ),
      ).toBe(true);
      const box = await ownerPage
        .getByLabel("Client secret", { exact: true })
        .boundingBox();
      expect(box!.height).toBeGreaterThanOrEqual(44);
    }
    await ownerPage
      .getByLabel("Client ID", { exact: true })
      .fill(fixture.jiraCredentials.clientId);
    await ownerPage
      .getByLabel("Client secret", { exact: true })
      .fill(fixture.jiraCredentials.clientSecret);
    await ownerPage
      .getByRole("button", { name: "Save shared app", exact: true })
      .click();
    await expect(
      ownerPage.getByRole("heading", { name: "Jira app setup saved" }),
    ).toBeVisible();
    await expect(
      page.getByRole("heading", { name: "Authorize the fixture Jira site" }),
    ).toBeVisible({ timeout: 10000 });
    expect(fixture.effects.jiraExchanges).toBe(0);
    await requester.unroute(`${fixture.origin}/api/v1/teaching/jira/*/human`);
    await page.getByRole("button", { name: "Allow fixture access" }).click();
    await expect(
      page.getByRole("heading", { name: "Jira connection verified" }),
    ).toBeVisible();
    expect(new URL(page.url()).searchParams.get("teachingRun")).toBe(parent);
    expect(fixture.effects.jiraConsents).toBe(1);
    expect(fixture.effects.jiraExchanges).toBe(1);
    expect(fixture.effects.jiraReads).toBe(1);
  } finally {
    await Promise.all([requester.close(), owner.close()]);
    await fixture.close();
  }
});
