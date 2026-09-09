import { test, expect } from "@playwright/test";
import { AxeBuilder } from "@axe-core/playwright";

test("Environment shares private session values across connectors and blocks unsafe writes", async ({
  page,
  context,
}) => {
  await page.goto("/?mode=live&connector=github&section=environment");
  await page.getByRole("button", { name: "Environment", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "Environment", exact: true }),
  ).toBeVisible();
  await page.getByLabel("Import .env file").setInputFiles({
    name: ".env",
    mimeType: "text/plain",
    buffer: Buffer.from("GITHUB_APP_ID=42\nPRIVATE_TEST=sentinel-env-browser"),
  });
  await expect(page.getByRole("status")).toContainText("Environment saved");
  const metadata = await (await page.request.get("/api/environment")).json();
  expect(metadata.names).toContain("PRIVATE_TEST");
  expect(JSON.stringify(metadata)).not.toContain("sentinel-env-browser");
  await page.getByLabel("Variable name", { exact: true }).fill("PRIVATE_TEST");
  await page
    .getByLabel("New value", { exact: true })
    .fill("replacement-private");
  await page.route("**/api/environment", (route) =>
    route.fulfill({ status: 503, contentType: "application/json", body: "{}" }),
  );
  await page
    .getByRole("button", { name: "Save variable", exact: true })
    .click();
  await expect(page.getByRole("alert")).toContainText("Could not save");
  await expect(page.getByLabel("Variable name", { exact: true })).toHaveValue(
    "PRIVATE_TEST",
  );
  await expect(page.getByLabel("New value", { exact: true })).toHaveValue(
    "replacement-private",
  );
  await expect(page.getByLabel("New value", { exact: true })).toHaveAttribute(
    "type",
    "password",
  );
  await page.unroute("**/api/environment");
  await page
    .getByRole("button", { name: "Save variable", exact: true })
    .click();
  await expect(page.getByLabel("New value", { exact: true })).toHaveValue("");
  await expect(page.getByRole("status")).toContainText("Environment saved");
  await expect(page.getByLabel("Available to connector")).toHaveCount(0);
  expect(
    (await (await page.request.get("/api/environment/stripe")).json()).names,
  ).toContain("PRIVATE_TEST");
  await expect(
    page.getByRole("button", { name: "Remove PRIVATE_TEST", exact: true }),
  ).toBeVisible();
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
    await page.screenshot({
      path: `.impeccable/review/environment-${viewport.width === 1440 ? "desktop" : "mobile"}.png`,
      fullPage: true,
    });
  }
  await page
    .getByRole("button", { name: "Remove PRIVATE_TEST", exact: true })
    .click();
  await expect(
    page.getByRole("button", { name: "Remove PRIVATE_TEST", exact: true }),
  ).toHaveCount(0);
  expect(
    (
      await page.request.post("/api/environment", {
        headers: { origin: "https://evil.example" },
        data: { revision: 0, values: { KEY: "bad" } },
      })
    ).status(),
  ).toBe(403);
  // Stored configuration is actually consulted by the live adapter: incomplete app setup blocks begin.
  await page.getByRole("button", { name: "Connect", exact: true }).click();
  await expect(
    page.getByText(/Complete all four GitHub App variables/),
  ).toBeVisible();
  await context.clearCookies();
  expect(
    (await (await page.request.get("/api/environment")).json()).names,
  ).toEqual([]);
});
