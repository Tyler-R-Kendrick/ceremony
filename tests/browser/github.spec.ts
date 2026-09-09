import { test, expect } from "@playwright/test";
import { AxeBuilder } from "@axe-core/playwright";
import { generateKeyPairSync, randomBytes } from "node:crypto";
import { startReferenceApp } from "../../examples/server.js";

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
  await expect(
    page.getByRole("button", { name: "Prepare integration", exact: true }),
  ).toHaveCount(0);
  await expect(
    page.getByRole("list", { name: "Connection prerequisites" }),
  ).toContainText("Needs your approval");
  // Exercise native form serialization, but intercept before creating an external app.
  await context.route("https://github.com/settings/apps/new?**", (route) =>
    route.fulfill({
      status: 200,
      contentType: "text/html",
      body: "<!doctype html><title>Manifest received</title>",
    }),
  );
  const posted = context.waitForEvent(
    "request",
    (request) =>
      request.url().startsWith("https://github.com/settings/apps/new?") &&
      request.method() === "POST",
  );
  const popupPromise = page.waitForEvent("popup");
  await page.getByRole("link", { name: /Continue to provider/ }).click();
  const popup = await popupPromise;
  const request = await posted;
  expect(request.headers()["content-type"]).toContain(
    "application/x-www-form-urlencoded",
  );
  const sent = JSON.parse(
    new URLSearchParams(request.postData()!).get("manifest")!,
  );
  expect(sent.url).toBe("http://127.0.0.1:4173");
  expect(sent.default_permissions).toEqual({ contents: "read" });
  expect(sent.redirect_url).toBe(
    `http://127.0.0.1:4173/api/live/github/${id}/callback`,
  );
  expect(sent.hook_attributes).toEqual({
    url: "http://127.0.0.1:4173",
    active: false,
  });
  expect(sent.default_events).toEqual([]);
  await expect(popup).toHaveTitle("Manifest received");
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

test("GitHub registration continues through installation and reuses the session app", async ({
  page,
  context,
}) => {
  const origin = "http://127.0.0.1:4293";
  const pem = generateKeyPairSync("rsa", { modulusLength: 2048 })
    .privateKey.export({ type: "pkcs1", format: "pem" })
    .toString();
  let conversions = 0;
  const app = await startReferenceApp({
    port: 4293,
    providerPort: 4294,
    live: {
      databasePath: ":memory:",
      vaultKey: randomBytes(32),
      github: {
        fetch: async (input) => {
          const url = String(input);
          if (url.endsWith("/conversions")) {
            conversions++;
            return Response.json({
              id: 42,
              slug: "flow-test",
              pem,
              owner: { login: "alice" },
            });
          }
          if (url.endsWith("/app"))
            return Response.json({
              id: 42,
              slug: "flow-test",
              owner: { login: "alice" },
              permissions: { contents: "read" },
            });
          if (url.endsWith("/app/installations/7"))
            return Response.json({
              id: 7,
              app_id: 42,
              account: { login: "alice" },
              suspended_at: null,
            });
          if (url.endsWith("/access_tokens"))
            return Response.json({
              token: "test-token",
              expires_at: new Date(Date.now() + 3600000).toISOString(),
              permissions: { contents: "read" },
            });
          if (url.endsWith("/installation/repositories?per_page=1"))
            return Response.json({ total_count: 0, repositories: [] });
          throw Error("Unexpected provider request");
        },
      },
    },
  });
  try {
    // Simulate only GitHub's approval pages; all local handoffs/callbacks run unmocked.
    let callback = "";
    await context.route(
      "https://github.com/settings/apps/new?**",
      async (route) => {
        const manifest = JSON.parse(
          new URLSearchParams(route.request().postData()!).get("manifest")!,
        );
        callback = manifest.redirect_url;
        const state = new URL(route.request().url()).searchParams.get("state")!;
        await route.fulfill({
          contentType: "text/html",
          body: `<a href="${callback}?state=${state}&code=created">Approve app creation</a>`,
        });
      },
    );
    // Playwright routes only the first request in a redirect chain. Follow the
    // real local redirects explicitly and substitute only the final provider page.
    await context.route(
      `${origin}/api/live/github/**/callback?*code=created`,
      async (route) => {
        const converted = await route.fetch({ maxRedirects: 0 });
        expect(converted.status()).toBe(303);
        const handoff = await context.request.get(
          new URL(converted.headers().location!, origin).href,
          { maxRedirects: 0 },
        );
        expect(handoff.status()).toBe(303);
        const installation = new URL(handoff.headers().location!);
        expect(installation.origin + installation.pathname).toBe(
          "https://github.com/apps/flow-test/installations/new",
        );
        const state = installation.searchParams.get("state")!;
        await route.fulfill({
          contentType: "text/html",
          body: `<a href="${callback}?state=${state}&installation_id=7">Approve repositories</a>`,
        });
      },
    );
    await page.goto(`${origin}/?mode=live&connector=github`);
    const popupPromise = page.waitForEvent("popup");
    await page.getByRole("link", { name: /Continue to provider/ }).click();
    const popup = await popupPromise;
    await popup.getByRole("link", { name: "Approve app creation" }).click();
    // No local intermediary click between the two provider-owned approvals.
    await popup.getByRole("link", { name: "Approve repositories" }).click();
    await expect(
      popup.getByText("Connection verified", { exact: true }),
    ).toBeVisible();
    const firstId = new URL(popup.url()).searchParams.get("ceremony")!;
    expect(
      (
        await (
          await page.request.get(`${origin}/api/live/ceremonies/${firstId}`)
        ).json()
      ).prerequisites.every(
        (item: { status: string }) => item.status === "succeeded",
      ),
    ).toBe(true);
    expect(conversions).toBe(1);
    await popup.close();
    // A new instance for the same owner uses the registered app without registration.
    const response = await page.request.post(`${origin}/api/live/ceremonies`, {
      headers: { origin },
      data: { connectorId: "github", methodId: "github-app" },
    });
    expect(response.ok()).toBe(true);
    const reused = await response.json();
    // Completed instances can resume; either way registration stays satisfied.
    expect(reused.prerequisites[0].status).toBe("succeeded");
    expect(conversions).toBe(1);
  } finally {
    await app.close();
  }
});
