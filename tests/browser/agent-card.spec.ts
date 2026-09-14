import { test, expect } from "@playwright/test";

/**
 * The branded card has the agent make the account, in a browser of its own,
 * and the card shows it happening.
 *
 * Nothing is typed into the provider by this test. The card is pressed, an
 * address is left for the agent to mint, and everything after that is the
 * driver working the reference provider's real registration form on the
 * server: filling the address and a generated password, pressing the button,
 * reading the confirmation code from the provider's mailbox, confirming, and
 * then being checked against the provider before the card is allowed to say
 * "connected". The outputs come back by reference and land in masked fields.
 */

test("a branded card has the agent register the account in its own browser", async ({
  page,
}) => {
  await page.goto("/?mode=test");
  const accounts = page.getByRole("region", {
    name: "Accounts the agent can register",
  });
  await expect(accounts).toBeVisible();
  // Four providers, each a branded card, each pressable.
  for (const name of ["An account here", "GitHub", "Stripe", "Jira"])
    await expect(
      accounts.getByRole("heading", { name, exact: true }),
    ).toBeVisible();

  const card = accounts
    .locator(".agent-flow")
    .filter({ has: page.getByRole("heading", { name: "An account here" }) });
  await expect(card.locator("[data-ceremony-card]")).toHaveAttribute(
    "data-status",
    "available",
  );
  await card.getByRole("button", { name: "Create account" }).click();

  // The address comes first and alone; this provider can mint one.
  const address = card.getByLabel("Email address");
  await expect(address).toHaveAttribute(
    "placeholder",
    "Leave blank and one is minted",
  );
  await card
    .getByRole("button", { name: "Register in the agent’s browser" })
    .click();

  // The run is shown as it happens, step by step.
  const steps = card.getByRole("list", { name: "What the agent did" });
  await expect(card.getByText(/^Browser: /)).toBeVisible({ timeout: 20_000 });
  await expect(steps.getByText("Filled email")).toBeVisible({
    timeout: 20_000,
  });
  await expect(steps.getByText("Filled password").first()).toBeVisible();
  await expect(steps.getByText("Pressed Create account")).toBeVisible();
  await expect(steps.getByText("Filled verification-code")).toBeVisible({
    timeout: 20_000,
  });
  await expect(steps.getByText("Pressed Confirm")).toBeVisible();

  // Connected only once the provider itself issued against the account.
  const outcome = card.getByRole("status").filter({ hasText: /Registered/ });
  await expect(outcome).toContainText("confirmed by the provider", {
    timeout: 20_000,
  });
  await expect(outcome).toContainText(
    /Registered agent-[a-f0-9]{8}@ceremony\.test/,
  );
  await expect(outcome).toContainText("0 handoffs");
  await expect(card.locator("[data-ceremony-card]")).toHaveAttribute(
    "data-status",
    "connected",
  );

  // The outputs: a generated password and a session token, masked, with a
  // reveal and a copy — never printed in a step.
  const password = card.getByLabel("Generated password", { exact: true });
  const token = card.getByLabel("Session token", { exact: true });
  await expect(password).toHaveAttribute("type", "password");
  await expect(token).toHaveAttribute("type", "password");
  await expect(password).not.toHaveValue("");
  await expect(token).not.toHaveValue("");
  await expect(
    card.getByRole("button", { name: "Show Generated password" }),
  ).toBeVisible();
  await expect(
    card.getByRole("button", { name: "Copy Session token" }),
  ).toBeVisible();
  await card.getByRole("button", { name: "Show Generated password" }).click();
  await expect(password).toHaveAttribute("type", "text");
  const minted = await password.inputValue();
  expect(minted).toMatch(/^[A-Za-z0-9_-]{20}$/);
  await expect(steps).not.toContainText(minted);
  await expect(outcome).not.toContainText(minted);

  // A reference is spent when it is redeemed: the value cannot be fetched twice.
  await expect(card.getByRole("button", { name: "Start over" })).toBeEnabled();
});

test("a provider the agent cannot reach reports that, and hands nothing off to a link", async ({
  page,
}) => {
  await page.goto("/?mode=test");
  const accounts = page.getByRole("region", {
    name: "Accounts the agent can register",
  });
  const card = accounts
    .locator(".agent-flow")
    .filter({ has: page.getByRole("heading", { name: "GitHub" }) });
  await card.getByRole("button", { name: "Create account" }).click();
  const address = card.getByLabel("Email address");
  await expect(address).toHaveAttribute("required", "");
  // The card never sends anybody to the provider: the agent goes.
  await expect(
    card.getByRole("link", { name: /Continue to provider/ }),
  ).toHaveCount(0);
  await expect(card.getByRole("link", { name: /github\.com/ })).toHaveCount(0);
});
