import { test, expect } from "@playwright/test";
import { randomBytes } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { startReferenceApp } from "../../examples/server.js";

test("the service collection starts real ceremonies with inline prerequisites", async ({
  page,
}) => {
  const starts: string[] = [];
  page.on("request", (request) => {
    if (
      request.method() === "POST" &&
      (request.url().includes("/ceremonies") || request.url().endsWith("/runs"))
    )
      starts.push(request.url());
  });
  await page.goto("/");
  await expect(
    page.getByRole("link", { name: "Connect a real GitHub App" }),
  ).toHaveCount(0);
  await page
    .getByRole("button", { name: "Connect GitHub", exact: true })
    .click();
  const signup = page.getByRole("link", {
    name: "Create your GitHub account (opens a new tab)",
  });
  await expect(signup).toHaveAttribute("href", "https://github.com/signup");
  await expect(signup).toHaveAttribute("target", "_blank");
  await expect(signup).toHaveAttribute("rel", "noopener noreferrer");
  await expect(
    page.getByText("signup alone does not", { exact: false }),
  ).toBeVisible();
  await expect(
    page.getByRole("heading", {
      name: "GitHub connection verified",
      exact: true,
    }),
  ).toHaveCount(0);
  await page.getByLabel("GitHub account or organization").fill("fixture-owner");
  await page
    .getByRole("button", { name: "Connect GitHub", exact: true })
    .click();
  await expect(
    page.getByRole("region", { name: "Connection and reusable steps" }),
  ).toContainText("Prepare GitHub App — your participation is needed");
  const services = page.getByRole("complementary", {
    name: "Available services",
  });
  await services.getByRole("button", { name: /Stripe/ }).click();
  await expect(
    page.getByLabel("Stripe secret key", { exact: true }),
  ).toBeVisible();
  await services.getByRole("button", { name: /Supabase/ }).click();
  await expect(
    page.getByLabel("Supabase project URL", { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByLabel("Supabase publishable key", { exact: true }),
  ).toBeVisible();
  await expect(page.getByLabel("Email", { exact: true })).toBeVisible();
  expect(starts.length).toBeGreaterThanOrEqual(3);
  expect(
    starts.every(
      (url) =>
        url.includes("/api/live/ceremonies") ||
        url.includes("/api/v1/teaching/runs"),
    ),
  ).toBe(true);
  await expect(page.getByText("Local simulation", { exact: true })).toHaveCount(
    0,
  );
});

test("collection completes real SDK ceremonies through private collection and resumes without repeated calls", async ({
  page,
}) => {
  const calls: string[] = [];
  const app = await startReferenceApp({
    port: 4323,
    providerPort: 4324,
    live: {
      databasePath: ":memory:",
      vaultKey: randomBytes(32),
      services: {
        fetch: async (input, init) => {
          const url = String(input);
          calls.push(url);
          if (url === "https://api.stripe.com/v1/balance") {
            expect(
              new Headers(init?.headers).get("authorization") ===
                "Bearer sk_test_browser_fixture",
            ).toBe(true);
            return Response.json({
              object: "balance",
              available: [],
              pending: [],
              livemode: false,
            });
          }
          expect(url).toBe(
            "https://synthetic.supabase.co/auth/v1/token?grant_type=password",
          );
          expect(
            isDeepStrictEqual(JSON.parse(String(init?.body)), {
              email: "alice@example.com",
              password: "synthetic-password",
              gotrue_meta_security: {},
            }),
          ).toBe(true);
          return Response.json({
            access_token: "synthetic-access",
            refresh_token: "synthetic-refresh",
            expires_in: 3600,
            token_type: "bearer",
            user: { id: "synthetic-user", email: "alice@example.com" },
          });
        },
      },
    },
  });
  try {
    const actionBodies: string[] = [];
    page.on("request", (request) => {
      if (request.url().endsWith("/actions"))
        actionBodies.push(request.postData() ?? "");
    });
    await page.goto(`${app.origin}/?connector=stripe`);
    await page
      .getByLabel("Stripe secret key", { exact: true })
      .fill("demo-api-key");
    await page.getByRole("button", { name: "Continue", exact: true }).click();
    await expect(
      page.getByRole("button", { name: "Try again", exact: true }),
    ).toBeVisible();
    expect(calls).toEqual([]);
    await page.getByRole("button", { name: "Try again", exact: true }).click();
    await page
      .getByLabel("Stripe secret key", { exact: true })
      .fill("sk_test_browser_fixture");
    await page.getByRole("button", { name: "Continue", exact: true }).click();
    await expect(
      page.getByRole("heading", { name: "You’re connected", exact: true }),
    ).toBeVisible();
    const stripeId = new URL(page.url()).searchParams.get("ceremony");
    const services = page.getByRole("complementary", {
      name: "Available services",
    });
    await services.getByRole("button", { name: /Supabase/ }).click();
    await page
      .getByLabel("Supabase project URL", { exact: true })
      .fill("https://synthetic.supabase.co");
    await page
      .getByLabel("Supabase publishable key", { exact: true })
      .fill("sb_publishable_synthetic");
    await page.getByLabel("Email", { exact: true }).fill("alice@example.com");
    await page
      .getByLabel("Password", { exact: true })
      .fill("synthetic-password");
    await page.getByRole("button", { name: "Continue", exact: true }).click();
    await expect(
      page.getByRole("heading", { name: "You’re connected", exact: true }),
    ).toBeVisible();
    await services.getByRole("button", { name: /Stripe/ }).click();
    await expect(
      page.getByRole("heading", { name: "You’re connected", exact: true }),
    ).toBeVisible();
    expect(new URL(page.url()).searchParams.get("ceremony")).toBe(stripeId);
    await page.reload();
    await expect(
      page.getByRole("heading", { name: "You’re connected", exact: true }),
    ).toBeVisible();
    expect(calls).toEqual([
      "https://api.stripe.com/v1/balance",
      "https://synthetic.supabase.co/auth/v1/token?grant_type=password",
    ]);
    expect(actionBodies.some((body) => body.includes("secretRef"))).toBe(true);
    expect(
      /sk_test_browser_fixture|synthetic-password|synthetic-access/.test(
        actionBodies.join(),
      ),
    ).toBe(false);
  } finally {
    await app.close();
  }
});
