import { test, expect } from "../fixtures/browser-test.js";
import { AxeBuilder } from "@axe-core/playwright";
import { startConnectorHarness } from "../connectors/ux/harness-server.js";

/*
 * The directory and one whole connection, in a real browser, against a
 * loopback double of the documented route table. The harness serves the
 * shipped components and the shipped page composition from its own ephemeral
 * origin, so nothing here depends on the reference application or its port.
 *
 * The journey these tests drive is the acceptance claim: a person with no CLI,
 * no extension, no raw JSON and no model connects a configured connector,
 * completes a provider handoff, sees verified status appear only from the
 * server, reads something with it, reconnects and unlinks.
 */

test("the application opens on the directory, and only a connector link opens the drawer", async ({
  page,
}) => {
  const harness = await startConnectorHarness();
  try {
    await page.goto(harness.url());
    await expect(
      page.getByRole("region", { name: "Connector directory" }),
    ).toBeVisible();
    await expect(page.getByRole("dialog")).toHaveCount(0);

    // A link that names a connector is somebody coming back to work.
    await page.goto(harness.url({ connector: "github-app" }));
    await expect(
      page.getByRole("dialog", { name: "Connect GitHub (native app)" }),
    ).toBeVisible();
  } finally {
    await harness.close();
  }
});

test("AC-UX-06: the directory separates implementation, configuration and evidence", async ({
  page,
}, info) => {
  const harness = await startConnectorHarness();
  try {
    await page.goto(harness.url());
    const github = page.locator('[data-connector-group="github"]');
    await expect(github.locator("[data-connector-entry]")).toHaveCount(2);
    await expect(github).toContainText("2 alternatives, kept separate");
    await expect(
      page.locator('[data-connector-entry="github-app"]'),
    ).toContainText("Provider-backed");
    await expect(
      page.locator('[data-connector-entry="github-via-broker"]'),
    ).toContainText("Local fixture");
    // The rows that say what this deployment cannot do are a facet away.
    await page.getByLabel("Support level").selectOption("unconfigured");
    const unconfigured = page.locator(
      '[data-connector-entry="vercel-connect"]',
    );
    await expect(unconfigured).toContainText("Needs configuration");
    await expect(unconfigured).toContainText("VERCEL_TEAM_ID");
    await page.getByLabel("Support level").selectOption("catalog-only");
    await page.getByLabel("Search connectors").fill("Smithery");
    await expect(
      page.locator('[data-connector-entry="smithery-registry"]'),
    ).toContainText("Described only");
    await page.getByLabel("Search connectors").fill("");
    await page.getByLabel("Support level").selectOption("");

    // Search reaches rows the current page has not rendered.
    await page.getByLabel("Search connectors").fill("Sample 26");
    await expect(page.locator("[data-connector-entry]")).toHaveCount(1);
    await page.getByLabel("Search connectors").fill("");
    await page
      .getByLabel("Credential custody")
      .selectOption("external-credential-broker");
    await expect(page.locator("[data-connector-entry]")).toHaveCount(1);
    await page.getByLabel("Credential custody").selectOption("");

    expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
    await page.setViewportSize({ width: 390, height: 844 });
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
    // Deterministic fixture rows only: no account, no token, no person.
    await page.screenshot({
      path: info.outputPath("connector-directory-390.png"),
      fullPage: true,
    });
  } finally {
    await harness.close();
  }
});

test("AC-UX-01: connect, hand off, poll, verify, read, reconnect and unlink from the browser alone", async ({
  page,
}, info) => {
  const harness = await startConnectorHarness();
  try {
    await page.goto(harness.url());
    await page
      .locator('[data-connector-entry="github-app"]')
      .getByRole("button")
      .click();
    const drawer = page.getByRole("dialog");
    await expect(drawer).toBeVisible();
    await drawer.getByLabel("Account or workspace (optional)").fill("octocat");

    const popupOpened = page.waitForEvent("popup");
    await drawer
      .getByRole("button", { name: "Connect GitHub (native app)" })
      .click();
    const provider = await popupOpened;
    await provider.waitForLoadState();

    // Nothing is connected yet, and closing the window would not change that.
    await expect(drawer).toContainText("Your participation is needed");
    await expect(drawer).not.toContainText("Verified target");

    await provider.getByRole("link", { name: "Approve fixture app" }).click();
    // The provider's return posts to its opener and closes itself; the page
    // then asks the server, and only the answer moves the status.
    await expect(drawer.getByText("Connected", { exact: true })).toBeVisible({
      timeout: 15000,
    });
    await expect(drawer).toContainText("octocat");
    await expect(drawer).toContainText("Read access was demonstrated");
    expect(page.url()).toContain("connection=connection%3A1");

    await drawer
      .getByRole("button", { name: "Read something with it" })
      .click();
    await expect(drawer).toContainText("Read succeeded");
    await expect(drawer).toContainText("octocat/hello-world");

    await page.screenshot({
      path: info.outputPath("connector-connected.png"),
      fullPage: true,
    });

    await drawer.getByRole("button", { name: "Reconnect" }).click();
    await expect(drawer).toContainText(
      "I intend to connect a different account",
    );
    const second = page.waitForEvent("popup");
    await drawer.getByRole("button", { name: "Start reconnect" }).click();
    const again = await second;
    await again.waitForLoadState();
    await again.getByRole("link", { name: "Approve fixture app" }).click();
    await expect(drawer.getByText("Connected", { exact: true })).toBeVisible({
      timeout: 15000,
    });

    await drawer.getByRole("button", { name: "Disconnect…" }).click();
    await expect(drawer).toContainText(
      "keeps existing until you revoke it there",
    );
    await drawer.getByRole("button", { name: "Unlink here only" }).click();
    await expect(drawer).toContainText("Unlinked here");
    await expect(drawer).toContainText("was not revoked");
    await expect(drawer).toContainText("connection:shared-team");
  } finally {
    await harness.close();
  }
});

test("AC-AUTH-14: a completion message from another origin or another window changes nothing", async ({
  page,
}) => {
  const harness = await startConnectorHarness();
  try {
    await page.goto(harness.url({ connector: "github-app" }));
    const drawer = page.getByRole("dialog");
    const popupOpened = page.waitForEvent("popup");
    await drawer
      .getByRole("button", { name: "Connect GitHub (native app)" })
      .click();
    const provider = await popupOpened;
    await provider.waitForLoadState();
    const connection = new URL(page.url()).searchParams.get("connection")!;
    expect(connection).toBeTruthy();

    // The page posts a perfectly well-formed message at itself.
    await page.evaluate((connectionRef) => {
      window.postMessage(
        { type: "ceremony:connector-handoff", connectionRef },
        location.origin,
      );
    }, connection);

    // And a window on another origin posts the same thing at its opener.
    const stranger = await page.evaluate(
      (url) => Boolean(window.open(url, "stranger")),
      harness.strangerUrl(connection),
    );
    expect(stranger).toBe(true);

    await expect
      .poll(() =>
        page
          .locator("[data-connector-connection]")
          .getAttribute("data-ignored-messages"),
      )
      .not.toBe("0");
    await expect(drawer).toContainText("Your participation is needed");
    await expect(drawer).not.toContainText("Verified target");
    expect(
      await page
        .locator("[data-connector-connection]")
        .getAttribute("data-lifecycle"),
    ).toBe("human-required");
  } finally {
    await harness.close();
  }
});

test("AC-AUTH-15: closing the provider window without approving leaves the flow pending", async ({
  page,
}) => {
  const harness = await startConnectorHarness();
  try {
    await page.goto(harness.url({ connector: "github-app" }));
    const drawer = page.getByRole("dialog");
    const popupOpened = page.waitForEvent("popup");
    await drawer
      .getByRole("button", { name: "Connect GitHub (native app)" })
      .click();
    const provider = await popupOpened;
    await provider.waitForLoadState();
    await provider.close();

    await expect(drawer).toContainText("That window closed");
    await expect(drawer).toContainText("Closing it does not complete anything");
    await drawer
      .getByRole("button", {
        name: "I finished in the provider — check status",
      })
      .click();
    await expect(drawer).toContainText("Your participation is needed");
    await expect(drawer).not.toContainText("Verified target");
  } finally {
    await harness.close();
  }
});

test("AC-UX-04: offline disables connecting, and no connection status is cached", async ({
  page,
  context,
}) => {
  const harness = await startConnectorHarness();
  try {
    await page.goto(harness.url({ connector: "github-app" }));
    const drawer = page.getByRole("dialog");
    await context.setOffline(true);
    await expect(drawer.locator("[data-connector-offline]")).toBeVisible();
    await expect(
      drawer.getByRole("button", { name: "Connect GitHub (native app)" }),
    ).toBeDisabled();
    // Nothing about a connection is kept in the browser's own storage.
    expect(
      await page.evaluate(() => localStorage.length + sessionStorage.length),
    ).toBe(0);
    expect(
      await page.evaluate(async () =>
        "caches" in window ? (await caches.keys()).length : 0,
      ),
    ).toBe(0);
    await context.setOffline(false);
    await expect(
      drawer.getByRole("button", { name: "Connect GitHub (native app)" }),
    ).toBeEnabled();
  } finally {
    await harness.close();
  }
});
