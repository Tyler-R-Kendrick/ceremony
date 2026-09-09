import { test, expect } from "@playwright/test";
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
    await page.goto(fixture.origin);
    await page.getByRole("button", { name: "Sign in", exact: true }).click();
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
      await other.goto(fixture.origin);
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
      await other
        .getByRole("button", { name: "Sign out", exact: true })
        .click();
      await expect(
        other.getByRole("button", { name: "Sign in", exact: true }),
      ).toBeVisible();
      expect(
        (
          await second.request.get(`${fixture.origin}/api/environment`)
        ).status(),
      ).toBe(401);
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
