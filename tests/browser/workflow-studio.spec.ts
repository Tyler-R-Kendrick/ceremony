import { test, expect } from "@playwright/test";

test("studio exports the server workflow without introducing a second connection experience", async ({
  page,
}) => {
  await page.goto("/?section=studio");
  await expect(
    page.getByRole("heading", { name: "Workflow studio", exact: true }),
  ).toBeVisible();
  await expect(page.getByLabel("Service", { exact: true })).toHaveCount(0);
  await expect(page.getByLabel("Active workflow")).toHaveCount(0);
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
  await page.getByRole("button", { name: "Connect", exact: true }).click();
  await expect(
    page.getByRole("list", { name: "Connection prerequisites" }),
  ).toContainText("Prepare GitHub App");
});
