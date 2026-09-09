import { test, expect } from "@playwright/test";

test("studio executes a live prerequisite ceremony and exports the server workflow", async ({
  page,
}) => {
  await page.goto("/?section=studio");
  await expect(
    page.getByRole("heading", { name: "Workflow studio", exact: true }),
  ).toBeVisible();
  await expect(page.getByLabel("Service", { exact: true })).toHaveValue(
    "live:github",
  );
  await expect(
    page.getByRole("list", { name: "Connection prerequisites" }),
  ).toContainText("Prepare GitHub App");
  await expect(
    page.getByRole("list", { name: "Connection prerequisites" }),
  ).toContainText("Needs your approval");
  await expect(page.locator(".code-editor")).not.toBeVisible();
  const response = await page.request.get("/api/workflows/github");
  expect(response.ok()).toBe(true);
  const document = await response.json();
  expect(document.arazzo).toBe("1.0.1");
  expect(
    document.workflows[0].steps.map(
      (step: { operationId: string }) => step.operationId,
    ),
  ).toEqual(["apps/create-from-manifest", "apps/get-authenticated"]);
  await page.getByLabel("Service", { exact: true }).selectOption("test:stripe");
  await expect(page.getByLabel("Active workflow")).toContainText(
    "Local simulation",
  );
  await page
    .getByLabel("Stripe secret key", { exact: true })
    .fill("demo-api-key");
  await page
    .getByLabel("Active workflow")
    .getByRole("button", { name: "Continue", exact: true })
    .click();
  await expect(
    page
      .getByLabel("Active workflow")
      .getByRole("heading", { name: "You’re connected", exact: true }),
  ).toBeVisible();
});
