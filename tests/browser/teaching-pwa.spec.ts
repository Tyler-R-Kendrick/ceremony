import { test, expect } from "@playwright/test";
import { teachingGitHubFixture } from "../fixtures/teaching-github.js";

test.use({
  trace: "off",
  video: "off",
  screenshot: "off",
  actionTimeout: 15000,
});

test("AC-43: real static worker update and account switch preserve pending authorization boundaries", async ({
  page,
  context,
}) => {
  test.setTimeout(90000);
  const fixture = await teachingGitHubFixture(4395, { hostContinuation: true });
  try {
    await fixture.login(context, "pwa-owner");
    await fixture.providerPages(context);
    await page.goto(fixture.origin);
    await expect(
      page.getByRole("button", { name: "Connect GitHub", exact: true }),
    ).toBeVisible();
    await expect
      .poll(() =>
        page.evaluate(async () => {
          const registration = await navigator.serviceWorker.getRegistration();
          return (
            registration?.active?.state ??
            registration?.installing?.state ??
            "missing"
          );
        }),
      )
      .toBe("activated");
    await page.reload();
    await expect
      .poll(() => page.evaluate(() => !!navigator.serviceWorker.controller))
      .toBe(true);
    await page
      .getByRole("button", { name: "Connect GitHub", exact: true })
      .click();
    await expect(
      page.getByRole("link", { name: "Continue with GitHub", exact: true }),
    ).toBeVisible();
    const url = page.url();
    const runId = new URL(url).searchParams.get("teachingRun")!;
    const before = { ...fixture.effects };
    fixture.updateStaticRelease();
    await page.evaluate(async () => {
      await (await navigator.serviceWorker.ready).update();
    });
    await page.getByText("Install app", { exact: true }).click();
    await expect(page.getByRole("button", { name: /update/i })).toBeVisible();
    await page.getByRole("button", { name: /update/i }).click();
    await expect
      .poll(() =>
        page.evaluate(
          async () =>
            !(await navigator.serviceWorker.getRegistration())?.waiting,
        ),
      )
      .toBe(true);
    expect(page.url()).toBe(url);
    expect(fixture.effects).toEqual(before);
    await expect(
      page.getByRole("link", { name: "Continue with GitHub", exact: true }),
    ).toBeVisible();

    await fixture.login(context, "different-pwa-owner");
    expect(
      (
        await context.request.get(
          `${fixture.origin}/api/v1/teaching/runs/${runId}`,
        )
      ).status(),
    ).toBe(403);
    expect(
      (
        await context.request.post(
          `${fixture.origin}/api/v1/teaching/runs/${runId}/advance`,
          {
            headers: { origin: fixture.origin },
            data: {
              revision: 1,
              nodeId: "prepare",
              commandId: "foreign-command",
            },
          },
        )
      ).status(),
    ).toBe(403);
    await page.reload();
    await expect(
      page.getByRole("link", { name: "Continue with GitHub", exact: true }),
    ).toHaveCount(0);
    expect(fixture.effects).toEqual(before);
    await fixture.login(context, "pwa-owner");
    await page.goto(url);
    await page
      .getByRole("link", { name: "Continue with GitHub", exact: true })
      .click();
    await expect(
      page.getByRole("link", { name: "Approve fixture app" }),
    ).toBeVisible();
    await page.getByRole("link", { name: "Approve fixture app" }).click();
    await page
      .getByRole("link", { name: "Continue with GitHub", exact: true })
      .click();
    await page
      .getByRole("link", { name: "Approve fixture installation" })
      .click();
    await expect(
      page.getByRole("heading", { name: "GitHub connection verified" }),
    ).toBeVisible();
    expect(fixture.effects.conversions).toBe(1);
    expect(fixture.effects.tokens).toBe(1);
    const cached = await page.evaluate(async () => {
      const paths: string[] = [];
      for (const name of await caches.keys())
        for (const request of await (await caches.open(name)).keys())
          paths.push(new URL(request.url).pathname);
      return paths;
    });
    expect(
      cached.every((path) =>
        ["/offline.html", "/icon.svg", "/manifest.webmanifest"].includes(path),
      ),
    ).toBe(true);
  } finally {
    await fixture.close();
  }
});
