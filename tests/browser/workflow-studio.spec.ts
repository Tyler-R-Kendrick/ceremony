import { test, expect } from "@playwright/test";
import { AxeBuilder } from "@axe-core/playwright";

test("Studio chat installs a Bluesky connector you can test", async ({
  page,
}, info) => {
  await page.goto("/?section=studio");
  await expect(page.locator("input[type=file]")).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "Create connector", exact: true }),
  ).toHaveCount(0);
  await page
    .getByLabel("Message the authoring agent")
    .fill("create a ceremony for blusky");
  await page.getByRole("button", { name: "Send", exact: true }).click();
  await expect(page).toHaveURL(/connector=bluesky/, { timeout: 20_000 });
  await expect(page.getByRole("heading", { name: /Bluesky/ })).toBeVisible();
  await expect(page.getByRole("button", { name: /Connect/ })).toBeVisible();
  for (const width of [1440, 390]) {
    await page.setViewportSize({ width, height: 900 });
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
    expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
    if (process.env.CEREMONY_CAPTURE_REVIEW === "1")
      await page.screenshot({
        path: info.outputPath(`studio-${width}.png`),
        fullPage: true,
      });
  }
});
