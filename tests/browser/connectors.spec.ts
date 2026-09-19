import { test, expect } from "../fixtures/browser-test.js";
import { randomBytes } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { startReferenceApp } from "../../examples/server.js";
import { teachingGitHubFixture } from "../fixtures/teaching-github.js";

test("GitHub connect collects the account before starting", async ({
  page,
}) => {
  const fixture = await teachingGitHubFixture(4590, {
    browser: {
      complete: async (input) =>
        input.credentials?.password
          ? { status: "credentials" }
          : { status: "blocked", reason: "no-form" },
    },
  });
  try {
    await fixture.login(page.context(), "browser-account-owner");
    await page.goto(`${fixture.origin}/?connector=github`);
    const account = page.getByLabel("GitHub account or organization");
    const connect = page.getByRole("button", {
      name: "Connect GitHub",
      exact: true,
    });
    await expect(account).toBeVisible();
    await expect(connect).toBeDisabled();
    let body: Record<string, unknown> | undefined;
    page.on("request", (request) => {
      if (
        request.method() === "POST" &&
        request.url().endsWith("/api/v1/teaching/runs")
      )
        body = request.postDataJSON();
    });
    await account.fill("fixture-owner");
    await connect.click();
    await expect
      .poll(() => body)
      .toMatchObject({
        connectorId: "github",
        target: "fixture-owner",
        account: "fixture-owner",
      });
    await expect(page.getByLabel("Password", { exact: true })).toBeVisible();
    await page
      .getByLabel("Password", { exact: true })
      .fill("fixture-private-password");
    const form = page
      .locator("form")
      .filter({ has: page.getByLabel("Password", { exact: true }) });
    const humanResponse = page.waitForResponse(
      (response) =>
        response.request().method() === "POST" &&
        response.url().endsWith("/human"),
    );
    await form.getByRole("button").click();
    const submitted = await humanResponse;
    expect(submitted.request().headers().origin).toBe(fixture.origin);
    expect(
      submitted.status(),
      submitted.status() === 303 ? undefined : await submitted.text(),
    ).toBe(303);
    await expect(
      page.getByRole("region", { name: "Connection and reusable steps" }),
    ).toContainText("Prepare GitHub App");
    await expect(
      page.getByText("Your account does not have permission for this action.", {
        exact: true,
      }),
    ).toHaveCount(0);
  } finally {
    await fixture.close();
  }
});

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
  await page.goto("/?connector=github");
  await expect(
    page.getByRole("link", { name: "Connect a real GitHub App" }),
  ).toHaveCount(0);
  let githubRequest: Record<string, unknown> | undefined;
  await page.route("**/api/v1/teaching/runs", async (route) => {
    githubRequest = route.request().postDataJSON();
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        id: "run:github-account",
        provider: "github",
        status: "active",
        revision: 1,
        nodes: [
          {
            id: "provider-account",
            operationId: "authored.register-account",
            state: "awaiting-human",
            verified: false,
          },
        ],
        human: {
          reason: "session",
          account: "fixture-owner",
          fields: ["account", "password"],
        },
      }),
    });
  });
  const connectGitHub = page.getByRole("button", {
    name: "Connect GitHub",
    exact: true,
  });
  await expect(connectGitHub).toBeDisabled();
  await expect(page.getByLabel("GitHub account or organization")).toBeVisible();
  await expect(
    page.getByText("available handles start isolated registration", {
      exact: false,
    }),
  ).toBeVisible();
  await expect(
    page.getByRole("heading", {
      name: "GitHub connection verified",
      exact: true,
    }),
  ).toHaveCount(0);
  await page.getByLabel("GitHub account or organization").fill("fixture-owner");
  await connectGitHub.click();
  await expect
    .poll(() => githubRequest)
    .toMatchObject({
      connectorId: "github",
      target: "fixture-owner",
      account: "fixture-owner",
    });
  await expect(
    page.getByRole("region", { name: "Connection and reusable steps" }),
  ).toContainText("The account exists. Supply its password");
  await expect(page.getByLabel("Password", { exact: true })).toBeVisible();
  await page.unroute("**/api/v1/teaching/runs");
  const services = page.getByRole("complementary", {
    name: "Available services",
  });
  await services.getByRole("button", { name: /Stripe/ }).click();
  await expect(
    page.getByLabel("Stripe secret key", { exact: true }),
  ).toHaveCount(0);
  await page
    .getByRole("button", { name: "Connect Stripe", exact: true })
    .click();
  await expect(
    page.getByRole("region", { name: "Connection and reusable steps" }),
  ).toContainText(
    "Open or create your Stripe account — your participation is needed",
  );
  await expect(
    page
      .locator(".teaching-actions")
      .getByRole("link", { name: "Continue with Stripe" }),
  ).toHaveAttribute("href", /\/api\/v1\/teaching\/stripe\/[^/]+\/human$/);
  await services.getByRole("button", { name: /Supabase/ }).click();
  await expect(
    page.getByLabel("Supabase project URL", { exact: true }),
  ).toHaveCount(0);
  await expect(
    page.getByLabel("Supabase publishable key", { exact: true }),
  ).toHaveCount(0);
  await expect(page.getByLabel("Email", { exact: true })).toHaveCount(0);
  await page
    .getByRole("button", { name: "Connect Supabase", exact: true })
    .click();
  await expect(
    page.getByRole("region", { name: "Connection and reusable steps" }),
  ).toContainText(
    "Set up your Supabase project — your participation is needed",
  );
  await expect(
    page
      .locator(".teaching-actions")
      .getByRole("link", { name: "Continue with Supabase" }),
  ).toHaveAttribute("href", /\/api\/v1\/teaching\/supabase\/[^/]+\/human$/);
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
          if (url === "https://synthetic.supabase.co/auth/v1/user") {
            expect(
              new Headers(init?.headers).get("authorization") ===
                "Bearer synthetic-access",
            ).toBe(true);
            return Response.json({
              id: "synthetic-user",
              email: "alice@example.com",
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
      "https://synthetic.supabase.co/auth/v1/user",
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
