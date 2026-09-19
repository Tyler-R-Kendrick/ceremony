import { test, expect } from "../fixtures/browser-test.js";
import { teachingHostedFixture } from "../fixtures/teaching-hosted.js";
test.use({
  trace: "off",
  video: "off",
  screenshot: "off",
  actionTimeout: 15000,
});
test("AC-19 AC-42: hosted sign-in uses signed OIDC and restores the subject across browser contexts", async ({
  page,
  browser,
}) => {
  test.setTimeout(60000);
  const fixture = await teachingHostedFixture();
  try {
    await page.goto(`${fixture.origin}/?connector=github`);
    await page.getByRole("button", { name: "Sign in", exact: true }).click();
    // Signing in is a full provider round trip, and the identity callback
    // returns a 303 to the host's configured path with no query of its own
    // (`src/server/oidc-identity.ts`). So it lands on the directory, and the
    // resume link is how anyone — a person or this test — gets back to the
    // connection afterwards.
    await expect(
      page.getByRole("heading", { name: "Connections" }),
    ).toBeVisible();
    await page.waitForLoadState("networkidle");
    await page.goto(`${fixture.origin}/?connector=github`);
    await expect(
      page.getByRole("button", { name: "Connect GitHub", exact: true }),
    ).toBeVisible();
    expect(fixture.provider.tokenCalls).toBe(1);
    await page.reload();
    await expect(
      page.getByRole("button", { name: "Connect GitHub", exact: true }),
    ).toBeVisible();
    expect(fixture.provider.tokenCalls).toBe(1);
    const second = await browser.newContext();
    try {
      const other = await second.newPage();
      await other.goto(`${fixture.origin}/?connector=github`);
      await expect(
        other.getByRole("button", { name: "Sign in", exact: true }),
      ).toBeVisible();
      expect(
        (
          await second.request.get(
            `${fixture.origin}/api/v1/teaching/runs/foreign`,
          )
        ).status(),
      ).toBe(401);
      await other.getByRole("button", { name: "Sign in", exact: true }).click();
      await expect(
        other.getByRole("heading", { name: "Connections" }),
      ).toBeVisible();
      await other.waitForLoadState("networkidle");
      await other.goto(`${fixture.origin}/?connector=github`);
      await expect(
        other.getByRole("button", { name: "Connect GitHub", exact: true }),
      ).toBeVisible();
      expect(fixture.provider.tokenCalls).toBe(2);
      const actorSummary = await fixture.store.transaction(async (tx) => {
        const rows = await tx.list<{
          value: { actor?: { subjectId: string; sessionId: string } };
        }>("identity", "session");
        const actors = rows.flatMap((row) =>
          row.value.value.actor ? [row.value.value.actor] : [],
        );
        return {
          subjects: new Set(actors.map((actor) => actor.subjectId)).size,
          sessions: new Set(actors.map((actor) => actor.sessionId)).size,
        };
      });
      expect(actorSummary).toEqual({ subjects: 1, sessions: 2 });
      const sibling = await second.newPage();
      await sibling.goto(`${fixture.origin}/?connector=github`);
      await expect(
        sibling.getByRole("button", { name: "Connect GitHub", exact: true }),
      ).toBeVisible();
      await other
        .getByRole("button", { name: "Sign out", exact: true })
        .click();
      // Signing out closes the drawer rather than reloading the workspace:
      // the application supplies `onSignedOut`, so the directory it lands on
      // is the one that was already behind the drawer.
      await expect(
        other.getByRole("heading", { name: "Connections" }),
      ).toBeVisible();
      await other.goto(`${fixture.origin}/?connector=github`);
      await expect(
        other.getByRole("button", { name: "Sign in", exact: true }),
      ).toBeVisible();
      expect(
        (
          await second.request.get(`${fixture.origin}/api/environment`)
        ).status(),
      ).toBe(401);
      // The other tab hears the sign-out over the session broadcast channel
      // and closes its drawer for the same reason.
      await expect(
        sibling.getByRole("heading", { name: "Connections" }),
      ).toBeVisible();
      await sibling.goto(`${fixture.origin}/?connector=github`);
      await expect(
        sibling.getByRole("button", { name: "Sign in", exact: true }),
      ).toBeVisible();
      const privateRemnants = await sibling.evaluate(async () => {
        const paths: string[] = [];
        for (const name of await caches.keys()) {
          for (const request of await (await caches.open(name)).keys())
            paths.push(new URL(request.url).pathname);
        }
        return {
          privateCache: paths.some(
            (path) => path.startsWith("/api/") || path.startsWith("/auth/"),
          ),
          storedValues: localStorage.length + sessionStorage.length,
        };
      });
      expect(privateRemnants).toEqual({ privateCache: false, storedValues: 0 });
      await page.reload();
      await expect(
        page.getByRole("button", { name: "Connect GitHub", exact: true }),
      ).toBeVisible();
    } finally {
      await second.close();
    }
  } finally {
    await fixture.close();
  }
});

test("a host that needs an account says so on the directory, before any setup", async ({
  page,
}) => {
  const fixture = await teachingHostedFixture();
  try {
    // The directory itself, with no connector named and no drawer open.
    await page.goto(fixture.origin);
    await expect(
      page.getByRole("heading", { name: "Connections" }),
    ).toBeVisible();
    const notice = page
      .getByRole("status")
      .filter({ hasText: "needs an account" });
    await expect(notice).toBeVisible();
    await notice
      .getByRole("button", { name: "Sign in to this workspace", exact: true })
      .click();

    // Signing in returns to the same page it was asked from, which is the
    // whole point of asking here: the round trip costs nothing drafted.
    await expect(
      page.getByRole("heading", { name: "Connections" }),
    ).toBeVisible();
    await expect(notice).toHaveCount(0);

    // And the connection no longer has a sign-in gate waiting at its last step.
    await page.goto(`${fixture.origin}/?connector=github`);
    await expect(
      page.getByRole("button", { name: "Connect GitHub", exact: true }),
    ).toBeVisible();
    await expect(
      page.getByRole("button", { name: "Sign in", exact: true }),
    ).toHaveCount(0);
  } finally {
    await fixture.close();
  }
});
