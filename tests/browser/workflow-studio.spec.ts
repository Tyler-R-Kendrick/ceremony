import { test as base, expect } from "../fixtures/browser-test.js";
import { AxeBuilder } from "@axe-core/playwright";
import { teachingGitHubFixture } from "../fixtures/teaching-github.js";

const test = base.extend<{ studioOrigin: string }>({
  studioOrigin: async ({ context }, use) => {
    const host = await teachingGitHubFixture(4596);
    try {
      await host.login(context, "studio-author");
      await use(host.origin);
    } finally {
      await host.close();
    }
  },
});

test("Studio chat stays put and links a working generic connector", async ({
  page,
  studioOrigin,
}, info) => {
  await page.goto(`${studioOrigin}/?section=studio`);
  await expect(
    page.getByRole("button", { name: "Create connector", exact: true }),
  ).toHaveCount(0);
  await page
    .getByLabel("Message the authoring agent")
    .fill("create a ceremony for acme");
  await page.getByRole("button", { name: "Send", exact: true }).click();
  const link = page.getByRole("link", { name: /connector=acme/ });
  await expect(link).toBeVisible({ timeout: 20_000 });
  await expect(
    page.getByRole("heading", { name: "Discovered ceremonies" }),
  ).toBeVisible();
  await expect(
    page
      .getByRole("region", { name: "Discovered ceremonies" })
      .getByText(/assumed from the provider name/),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "OAuth authorization code" }),
  ).toBeVisible();
  await expect(page).toHaveURL(/section=studio/);
  await link.click();
  await expect(
    page.getByRole("heading", { name: /Connect acme/i }),
  ).toBeVisible();
  await expect(
    page.getByText("This host has not registered a working ceremony"),
  ).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "Connect acme", exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Connect acme", exact: true }).click();
  await expect(
    page.getByText("This saved connection belongs to another service"),
  ).toHaveCount(0);
  await expect(page.getByText("Verified access is ready")).toHaveCount(0);
  await expect(
    page.getByRole("link", { name: "Continue with acme" }).first(),
  ).toBeVisible();
  await expect(
    page.getByText("Your input is needed for step 1 of 3: App registration.", {
      exact: true,
    }),
  ).toBeVisible();
  await page.getByRole("link", { name: "Continue with acme" }).first().click();
  await expect(
    page.getByRole("heading", {
      name: "Register the acme integration",
      exact: true,
    }),
  ).toBeVisible();
  await expect(page.getByLabel("Public provider origin")).toHaveCount(0);
  await expect(page.getByLabel("Access token")).toHaveCount(0);
  await expect(
    page.getByText(/will not ask you for tokens, passwords/),
  ).toBeVisible();
  await page.getByRole("link", { name: "Return to connection" }).click();
  await page.getByRole("button", { name: "Delete connection" }).click();
  await expect(page.getByRole("heading", { name: /acme/i })).toHaveCount(0);
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

test("studio streams ceremony progress for a misspelled Bluesky name", async ({
  page,
  studioOrigin,
}) => {
  await page.goto(`${studioOrigin}/?section=studio`);
  await page.getByLabel("Message the authoring agent").fill("blusky");
  await page.getByRole("button", { name: "Send", exact: true }).click();
  const activity = page.getByRole("region", { name: "Ceremony progress" });
  await expect(activity).toBeVisible({ timeout: 5_000 });
  await expect(activity.locator(".authoring-elapsed")).toBeVisible();
  await expect(activity.locator(".authoring-counters")).toBeVisible();
  await expect(
    activity.locator(".authoring-live-log li").first(),
  ).toBeVisible();
  await expect(activity.locator(".authoring-tasks li").first()).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "Discovered ceremonies" }),
  ).toBeVisible({ timeout: 60_000 });
  const board = page.getByRole("region", { name: "Discovered ceremonies" });
  await expect(
    board.getByRole("button", { name: "OAuth authorization code" }),
  ).toBeVisible();
  await expect(
    board.getByRole("button", { name: "Account registration" }),
  ).toBeVisible();
  await board.getByRole("button", { name: "Account registration" }).click();
  await expect(board.getByLabel("Account name or email")).toBeVisible();
  await expect(
    board.getByRole("button", { name: "Check account and continue" }),
  ).toBeDisabled();
  await expect(page.getByLabel("Password")).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "Continue isolated authorization" }),
  ).toHaveCount(0);
  await expect(
    board.getByText("https://bsky.social", { exact: true }),
  ).toBeVisible({ timeout: 60_000 });
});

test("GitHub account registration asks for a handle before it runs", async ({
  page,
  studioOrigin,
}) => {
  await page.goto(`${studioOrigin}/?section=studio`);
  await page.getByLabel("Message the authoring agent").fill("github");
  await page.getByRole("button", { name: "Send", exact: true }).click();
  const board = page.getByRole("region", { name: "Discovered ceremonies" });
  await expect(board).toBeVisible({ timeout: 60_000 });
  await board.getByRole("button", { name: "Account registration" }).click();
  await expect(board.getByLabel("GitHub handle")).toBeVisible();
  await board.getByLabel("GitHub handle").fill("fixture-owner");
  await expect(
    board.getByRole("button", { name: "Check account and continue" }),
  ).toBeEnabled();
});

test("changing the Studio provider clears the previous account and handoff", async ({
  page,
  studioOrigin,
}) => {
  await page.route("**/api/v1/teaching/authoring/chat", async (route) => {
    const { message } = route.request().postDataJSON();
    await route.fulfill({
      json: {
        result: {
          draft: { connectorId: message, methods: ["account-registration"] },
          discovery: { origin: `https://${message}.example` },
        },
      },
    });
  });
  await page.route("**/api/v1/teaching/runs", (route) =>
    route.fulfill({
      json: {
        id: "run-alpha",
        provider: "alpha",
        human: { reason: "passkey", fields: ["provider-authorization"] },
        nodes: [
          { operationId: "authored.register-account", state: "awaiting-human" },
        ],
      },
    }),
  );
  await page.goto(`${studioOrigin}/?section=studio`);
  const message = page.getByLabel("Message the authoring agent");
  const send = page.getByRole("button", { name: "Send", exact: true });
  const board = page.getByRole("region", { name: "Discovered ceremonies" });
  await message.fill("alpha");
  await send.click();
  await board
    .getByRole("button", { name: "Account registration", exact: true })
    .click();
  await board.getByLabel("Account name or email").fill("alpha-owner");
  await board
    .getByRole("button", { name: "Check account and continue" })
    .click();
  const handoff = page.getByRole("region", {
    name: "Human assistance required",
  });
  await expect(
    handoff.getByRole("link", { name: "Continue with human assistance" }),
  ).toHaveAttribute("href", "/api/v1/teaching/alpha/run-alpha/human");
  // A revised proposal for the same provider must not lose its pending handoff.
  await message.fill("alpha");
  await send.click();
  await expect(handoff).toBeVisible();
  await expect(board.getByLabel("Account name or email")).toHaveValue(
    "alpha-owner",
  );
  await message.fill("beta");
  await send.click();
  await expect(board).toContainText("https://beta.example");
  await expect(handoff).toHaveCount(0);
  await expect(page.locator('a[href*="run-alpha"]')).toHaveCount(0);
  await board
    .getByRole("button", { name: "Account registration", exact: true })
    .click();
  await expect(board.getByLabel("Account name or email")).toHaveValue("");
  await expect(
    board.getByRole("button", { name: "Check account and continue" }),
  ).toBeDisabled();
});
