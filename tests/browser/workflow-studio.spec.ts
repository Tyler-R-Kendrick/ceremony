import { test, expect } from "@playwright/test";
import { AxeBuilder } from "@axe-core/playwright";

test("Studio is agent chat with WebMCP tools and no kickoff forms", async ({
  page,
}, info) => {
  const effects: string[] = [];
  page.on("request", (request) => {
    if (
      /\/api\/(live\/)?ceremonies|\/api\/environment|\/api\/workflows/.test(
        request.url(),
      )
    )
      effects.push(request.url());
  });
  await page.goto("/?section=studio&connector=github");
  await expect(
    page.getByRole("heading", { name: "Workflow studio", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Create connector", exact: true }),
  ).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "Open project", exact: true }),
  ).toHaveCount(0);
  await expect(page.getByLabel("Open connector project")).toHaveCount(0);
  await expect(page.getByLabel("Connector name", { exact: true })).toHaveCount(
    0,
  );
  await expect(page.locator("input[type=file]")).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "Connect GitHub", exact: true }),
  ).toHaveCount(0);
  expect(effects).toEqual([]);
  await page.getByLabel("Message the authoring agent").fill("githb");
  await page.getByRole("button", { name: "Send", exact: true }).click();
  await expect(page.getByRole("log")).toContainText(/GitHub|github/i, { timeout: 20_000 });
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
