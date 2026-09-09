import { test, expect } from "@playwright/test";
import { AxeBuilder } from "@axe-core/playwright";

test("live GitHub exposes blocking prerequisites and a real manifest scenario, without granting access", async ({
  page,
  context,
}) => {
  await page.goto("/?mode=live&connector=github");
  const vaultDownload = await page.request.get(
    `/@fs${process.cwd()}/.ceremony/vault.key`,
  );
  expect(vaultDownload.status()).toBe(403);
  await expect(page.getByText("Live GitHub", { exact: true })).toBeVisible();
  await expect(
    page.getByRole("link", { name: "Auth documentation" }),
  ).toHaveAttribute(
    "href",
    "https://docs.github.com/en/apps/sharing-github-apps/registering-a-github-app-from-a-manifest",
  );
  await expect(
    page.getByRole("list", { name: "Connection prerequisites" }),
  ).toContainText("Blocked");
  const id = new URL(page.url()).searchParams.get("ceremony")!;
  const snapshot = await (
    await page.request.get(`/api/live/ceremonies/${id}`)
  ).json();
  const bypass = await page.request.post(`/api/live/ceremonies/${id}/actions`, {
    headers: { origin: "http://127.0.0.1:4173" },
    data: { action: "finish", revision: snapshot.revision },
  });
  expect(bypass.status()).toBe(409);
  await page
    .getByRole("button", { name: "Prepare integration", exact: true })
    .click();
  await expect(
    page.getByRole("list", { name: "Connection prerequisites" }),
  ).toContainText("Needs your approval");
  const popupPromise = page.waitForEvent("popup");
  await page.getByRole("link", { name: /Continue to provider/ }).click();
  const popup = await popupPromise;
  await expect(
    popup.getByRole("heading", { name: "Prepare your GitHub App" }),
  ).toBeVisible();
  const manifest = JSON.parse(
    await popup.locator('input[name="manifest"]').inputValue(),
  );
  expect(manifest.default_permissions).toEqual({ contents: "read" });
  expect(manifest.redirect_url).toBe(
    `http://127.0.0.1:4173/api/live/github/${id}/callback`,
  );
  expect(await popup.locator("form").getAttribute("action")).toMatch(
    /^https:\/\/github.com\/settings\/apps\/new\?state=/,
  );
  // Exercise native form serialization, but intercept before creating an external app.
  await popup.route("https://github.com/settings/apps/new?**", (route) =>
    route.fulfill({
      status: 200,
      contentType: "text/html",
      body: "<!doctype html><title>Manifest received</title>",
    }),
  );
  const posted = popup.waitForRequest(
    (request) =>
      request.url().startsWith("https://github.com/settings/apps/new?") &&
      request.method() === "POST",
  );
  await popup.getByRole("button", { name: "Review app on GitHub" }).click();
  const request = await posted;
  expect(request.headers()["content-type"]).toContain(
    "application/x-www-form-urlencoded",
  );
  const sent = JSON.parse(
    new URLSearchParams(request.postData()!).get("manifest")!,
  );
  expect(sent.url).toBe("http://127.0.0.1:4173");
  expect(sent.hook_attributes).toEqual({
    url: "http://127.0.0.1:4173",
    active: false,
  });
  expect(sent.default_events).toEqual([]);
  await popup.close();
  expect(
    (await (await page.request.get(`/api/live/ceremonies/${id}`)).json())
      .outcome,
  ).toBeUndefined();
  expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
  await page.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "Connection cancelled" }),
  ).toBeVisible();
  await context.clearCookies();
  expect((await page.request.get(`/api/live/ceremonies/${id}`)).status()).toBe(
    404,
  );
});
