import { test, expect } from "../fixtures/browser-test.js";
import { AxeBuilder } from "@axe-core/playwright";
import { startConnectorHarness } from "../connectors/ux/harness-server.js";

/*
 * The drawer, in every engine this project supports.
 *
 * Focus is the whole subject here. A modal that does not take focus, keep it,
 * and give it back is not usable without a mouse, and a connection surface
 * that cannot be used without a mouse is not a connection surface. The popup
 * fallback belongs in the same file because it is the same question from the
 * other side: what happens to a person whose browser will not open the window
 * this flow wanted.
 */

test("focus enters the drawer, stays inside it, and returns to the card", async ({
  page,
}) => {
  const harness = await startConnectorHarness();
  try {
    await page.goto(harness.url());
    const card = page
      .locator('[data-connector-entry="github-app"]')
      .getByRole("button");
    await card.click();
    const drawer = page.getByRole("dialog");
    await expect(drawer).toBeVisible();

    const inside = () =>
      page.evaluate(() => {
        const dialog = document.querySelector('[role="dialog"]');
        return Boolean(
          dialog &&
          document.activeElement &&
          dialog.contains(document.activeElement),
        );
      });
    expect(await inside()).toBe(true);

    // Twenty tabs is more controls than the drawer has, so a trap that leaks
    // would have leaked by now.
    for (let index = 0; index < 20; index++) {
      await page.keyboard.press("Tab");
      expect(await inside()).toBe(true);
    }
    for (let index = 0; index < 5; index++) {
      await page.keyboard.press("Shift+Tab");
      expect(await inside()).toBe(true);
    }

    await page.keyboard.press("Escape");
    await expect(page.getByRole("dialog")).toHaveCount(0);
    // Back where the person was, not at the top of a long directory.
    await expect(card).toBeFocused();
  } finally {
    await harness.close();
  }
});

test("the drawer is usable and accessible at desktop and phone widths", async ({
  page,
  browserName,
}, info) => {
  const harness = await startConnectorHarness();
  try {
    await page.goto(harness.url({ connector: "github-app" }));
    const drawer = page.getByRole("dialog");
    await expect(drawer).toBeVisible();
    for (const viewport of [
      { width: 1280, height: 900 },
      { width: 390, height: 844 },
    ]) {
      await page.setViewportSize(viewport);
      expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
      expect(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= innerWidth,
        ),
      ).toBe(true);
      // Every control a person has to hit stays big enough to hit.
      const sizes = await drawer
        .locator("button:visible, a:visible, select:visible, input:visible")
        .evaluateAll((elements) =>
          elements
            .filter((element) => {
              const type = element.getAttribute("type");
              return type !== "radio" && type !== "checkbox";
            })
            .map((element) => {
              const box = element.getBoundingClientRect();
              return { width: box.width, height: box.height };
            }),
        );
      expect(sizes.length).toBeGreaterThan(3);
      expect(sizes.every((size) => size.height >= 40)).toBe(true);
    }
    if (browserName === "chromium")
      await page.screenshot({
        path: info.outputPath("connector-drawer-390.png"),
        fullPage: true,
      });
  } finally {
    await harness.close();
  }
});

test("inline validation and the intent controls are announced, not only coloured", async ({
  page,
}) => {
  const harness = await startConnectorHarness();
  try {
    await page.goto(harness.url({ connector: "petstore-api-key" }));
    const drawer = page.getByRole("dialog");
    const connect = drawer.getByRole("button", { name: "Connect Petstore" });
    await expect(connect).toBeEnabled();
    await connect.click();
    // A field whose options depend on another says so before it is reached.
    await expect(drawer.getByText("Choose region first")).toBeVisible();
    await drawer.getByLabel("Region (required)").selectOption("eu");
    await expect(drawer.getByLabel("Project (required)")).toBeEnabled();
    await expect(drawer.getByLabel("Project (required)")).toContainText(
      "EU main",
    );
    const secret = drawer.getByLabel("Petstore API key (required)");
    await expect(secret).toHaveAttribute("type", "password");
    await expect(drawer).toContainText("replaced by a reference");
    expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
  } finally {
    await harness.close();
  }
});

test("AC-UX-04: a blocked popup completes in the same window and comes back", async ({
  page,
}) => {
  const harness = await startConnectorHarness();
  try {
    await page.goto(harness.url({ connector: "github-app", popup: "blocked" }));
    const drawer = page.getByRole("dialog");
    const connect = drawer.getByRole("button", {
      name: "Connect GitHub (native app)",
    });
    await expect(connect).toBeEnabled();
    await connect.click();
    await expect(
      drawer.locator("[data-connector-popup-blocked]"),
    ).toBeVisible();
    const link = drawer.getByRole("link", { name: "Continue in this window" });
    await expect(link).toBeVisible();
    await link.click();

    // The provider page owns the whole tab now; approving returns here.
    await page.getByRole("link", { name: "Approve fixture app" }).click();
    await page.waitForURL(/connection=/);
    await expect(page.getByRole("dialog")).toBeVisible();
    await expect(
      page.getByRole("dialog").getByText("Connected", { exact: true }),
    ).toBeVisible({
      timeout: 15000,
    });
    // Returning is not what made it connected: the reopened connection was
    // read from the server before anything was shown.
    await expect(page.getByRole("dialog")).toContainText("octocat");
  } finally {
    await harness.close();
  }
});
