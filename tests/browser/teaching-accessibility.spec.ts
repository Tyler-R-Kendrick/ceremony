import { test, expect, type Locator, type Page } from "@playwright/test";
import { AxeBuilder } from "@axe-core/playwright";
import { teachingGitHubFixture } from "../fixtures/teaching-github.js";

test.use({
  trace: "off",
  video: "off",
  screenshot: "off",
  actionTimeout: 15000,
});
async function tabTo(page: Page, control: Locator) {
  await expect(control).toBeVisible();
  for (let count = 0; count < 30; count++) {
    if (await control.evaluate((element) => element === document.activeElement))
      return;
    await page.keyboard.press("Tab");
  }
  await expect(control).toBeFocused();
}

test("AC-44 AC-45: keyboard teaching controls, reduced motion, and expanded mobile text stay accessible", async ({
  page,
  context,
  browserName,
}, info) => {
  test.setTimeout(60000);
  const fixture = await teachingGitHubFixture(4387);
  try {
    await fixture.login(context, "keyboard-author");
    await page.emulateMedia({ reducedMotion: "reduce" });
    await page.goto(`${fixture.origin}/?section=studio`);
    const start = page.getByRole("button", {
      name: "Create from demonstration",
      exact: true,
    });
    await expect(start).toBeVisible();
    for (const viewport of [
      { width: 1440, height: 1000 },
      { width: 390, height: 844 },
    ]) {
      await page.setViewportSize(viewport);
      expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
      expect(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= innerWidth,
        ),
      ).toBe(true);
      // This neutral pre-connection shell has no run, protocol handoff, collector, or private inputs.
      if (
        browserName === "chromium" &&
        process.env.CEREMONY_CAPTURE_REVIEW === "1"
      ) {
        expect(await page.locator('input[type="password"]').count()).toBe(0);
        await page.screenshot({
          path: info.outputPath(`teaching-neutral-${viewport.width}.png`),
          fullPage: true,
        });
      }
    }
    await tabTo(page, start);
    await page.keyboard.press("Enter");
    await expect(
      page.getByRole("heading", { name: "Teaching this connection" }),
    ).toBeVisible();
    const pause = page.getByRole("button", {
      name: "Pause teaching",
      exact: true,
    });
    await tabTo(page, pause);
    await page.keyboard.press("Enter");
    const resume = page.getByRole("button", {
      name: "Resume teaching",
      exact: true,
    });
    await expect(resume).toBeVisible();
    await tabTo(page, resume);
    await page.keyboard.press("Enter");
    const stop = page.getByRole("button", {
      name: "Stop teaching and review",
      exact: true,
    });
    await tabTo(page, stop);
    await page.keyboard.press("Enter");
    await expect(
      page.getByRole("heading", { name: "Review your demonstration" }),
    ).toBeVisible();
    await expect(
      page
        .getByRole("region", { name: "Connection and reusable steps" })
        .getByRole("status")
        .first(),
    ).toHaveAttribute("aria-live", "polite");
    expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
    await page.locator(".teaching-current h2").evaluate((element) => {
      element.textContent =
        "GitHub-Verbindung für gemeinsam verwaltete Organisationen und Repository-Zugriffsberechtigungen überprüfen";
    });
    await page.locator(".teaching-connection").evaluate((element) => {
      (element as HTMLElement).style.fontSize = "24px";
    });
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
    const sizes = await page
      .locator(
        ".teaching-connection button:visible, .teaching-connection a:visible",
      )
      .evaluateAll((elements) =>
        elements.map((element) => {
          const box = element.getBoundingClientRect();
          return { width: box.width, height: box.height };
        }),
      );
    expect(sizes.every((size) => size.width >= 44 && size.height >= 44)).toBe(
      true,
    );
    const discard = page.getByRole("button", {
      name: "Discard demonstration",
      exact: true,
    });
    await tabTo(page, discard);
    await page.keyboard.down("Space");
    expect(
      await discard.evaluate((element) => getComputedStyle(element).transform),
    ).toBe("none");
    await page.keyboard.up("Space");
    await expect(
      page.getByRole("region", { name: "Demonstration", exact: true }),
    ).toHaveCount(0);
  } finally {
    await fixture.close();
  }
});
