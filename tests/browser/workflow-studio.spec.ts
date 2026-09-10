import { test, expect } from "@playwright/test";
import { AxeBuilder } from "@axe-core/playwright";

test("Studio chat stays put and links a working Bluesky connector", async ({
  page,
}, info) => {
  await page.goto("/?section=studio");
  await page
    .getByLabel("Message the authoring agent")
    .fill("create a ceremony for blusky");
  await page.getByRole("button", { name: "Send", exact: true }).click();
  const link = page.getByRole("link", { name: /connector=bluesky/ });
  await expect(link).toBeVisible({ timeout: 20_000 });
  await expect(page).toHaveURL(/section=studio/);
  await link.click();
  await expect(
    page.getByRole("heading", { name: /Connect Bluesky/ }),
  ).toBeVisible();
  await expect(
    page.getByText("This host has not registered a working ceremony"),
  ).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "Connect Bluesky", exact: true }),
  ).toBeVisible();
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
