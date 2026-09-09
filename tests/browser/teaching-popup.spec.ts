import { test, expect } from "@playwright/test";
import { teachingGitHubFixture } from "../fixtures/teaching-github.js";

test.use({
  trace: "off",
  video: "off",
  screenshot: "off",
  actionTimeout: 15000,
});

for (const policy of ["null", "throw"] as const) {
  test(`AC-41 same-tab provider handoff succeeds when popup policy is ${policy}`, async ({
    page,
    context,
  }) => {
    test.setTimeout(60000);
    const fixture = await teachingGitHubFixture(4397);
    try {
      let popupAttempts = 0;
      await context.exposeBinding("recordBlockedPopup", () => {
        popupAttempts++;
      });
      await context.addInitScript((policy) => {
        Reflect.set(window, "popupAttempts", 0);
        window.open = () => {
          void Reflect.get(window, "recordBlockedPopup")();
          Reflect.set(
            window,
            "popupAttempts",
            Number(Reflect.get(window, "popupAttempts")) + 1,
          );
          if (policy === "throw")
            throw new DOMException("Popup blocked", "NotAllowedError");
          return null;
        };
      }, policy);
      await fixture.login(context, "popup-owner");
      await fixture.providerPages(context);
      await page.goto(fixture.origin);
      await page
        .getByRole("button", { name: "Connect GitHub", exact: true })
        .click();
      await expect(
        page.getByRole("link", { name: "Continue with GitHub", exact: true }),
      ).toBeVisible();
      const original = new URL(page.url()).searchParams.get("teachingRun");
      await page
        .getByRole("link", { name: "Continue with GitHub", exact: true })
        .click();
      await expect(
        page.getByRole("link", { name: "Approve fixture app" }),
      ).toBeVisible();
      await page.getByRole("link", { name: "Approve fixture app" }).click();
      expect(new URL(page.url()).searchParams.get("teachingRun")).toBe(
        original,
      );
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
      expect(new URL(page.url()).searchParams.get("teachingRun")).toBe(
        original,
      );
      expect(
        await page.evaluate(() => Reflect.get(window, "popupAttempts")),
      ).toBe(0);
      expect(context.pages()).toHaveLength(1);
      expect(popupAttempts).toBe(0);
      expect(fixture.effects.conversions).toBe(1);
      expect(fixture.effects.tokens).toBe(1);
    } finally {
      await fixture.close();
    }
  });
}
