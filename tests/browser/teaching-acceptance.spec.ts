import { test, expect, type Page } from "@playwright/test";
import { teachingGitHubFixture } from "../fixtures/teaching-github.js";
test.use({
  trace: "off",
  video: "off",
  screenshot: "off",
  actionTimeout: 15000,
});

test.describe("browser-native teaching with PostgreSQL and signed provider HTTP", () => {
  test.setTimeout(120_000);
  let fixture: Awaited<ReturnType<typeof teachingGitHubFixture>>;
  test.beforeEach(async () => {
    fixture = await teachingGitHubFixture(4393);
  });
  test.afterEach(async () => {
    await fixture?.close();
  });

  async function completeProvider(page: Page) {
    await page
      .getByRole("link", { name: "Continue with GitHub", exact: true })
      .click();
    await page
      .getByRole("button", { name: "Continue with GitHub", exact: true })
      .click();
    await page.getByRole("link", { name: "Approve fixture app" }).click();
    await page
      .getByRole("link", { name: "Continue with GitHub", exact: true })
      .click();
    await page
      .getByRole("link", { name: "Approve fixture installation" })
      .click();
    await expect(
      page.getByRole("heading", {
        name: "GitHub connection verified",
        exact: true,
      }),
    ).toBeVisible();
  }

  test("AC-02 AC-14 AC-39: whole demonstration survives provider navigation, publishes and reuses without a model", async ({
    page,
    context,
  }) => {
    await fixture.login(context, "whole-author");
    await fixture.providerPages(context);
    await page.goto(`${fixture.origin}/?section=studio`);
    await page
      .getByRole("button", { name: "Create from demonstration", exact: true })
      .click();
    await expect(
      page.getByRole("heading", { name: "Teaching this connection" }),
    ).toBeVisible();
    await completeProvider(page);
    await page
      .getByRole("button", { name: "Stop teaching and review" })
      .click();
    await page
      .getByRole("button", { name: "Review reusable step", exact: true })
      .click();
    await expect(
      page.getByRole("region", { name: "Reusable step review" }),
    ).toContainText("Verify GitHub access");
    const reviewed = page.waitForResponse(
      (response) =>
        response.url().endsWith("/review") &&
        response.request().method() === "POST",
    );
    const published = page.waitForResponse(
      (response) =>
        response.url().endsWith("/publish") &&
        response.request().method() === "POST",
    );
    await page
      .getByRole("button", { name: "Save reusable step", exact: true })
      .click();
    expect((await reviewed).status()).toBe(200);
    expect((await published).status()).toBe(200);
    await expect(
      page.getByRole("region", { name: "Saved reusable steps" }),
    ).toBeVisible();
    const before = { ...fixture.effects };
    const previousRun = new URL(page.url()).searchParams.get("teachingRun");
    await page.getByRole("button", { name: "Use step", exact: true }).click();
    await expect
      .poll(() => new URL(page.url()).searchParams.get("teachingRun"))
      .not.toBe(previousRun);
    await expect(
      page.getByRole("heading", {
        name: "GitHub connection verified",
        exact: true,
      }),
    ).toBeVisible();
    expect(fixture.effects.conversions).toBe(before.conversions);
    expect(fixture.effects.tokens).toBe(before.tokens);
    expect(fixture.effects.verifiedSignatures).toBeGreaterThan(0);
    expect(fixture.effects.repositoryReads).toBeGreaterThan(0);
    await expect
      .poll(async () =>
        fixture.store.transaction(
          async (tx) =>
            (
              await tx.list<{ status: string }>("teaching-fixture", "run")
            ).filter((row) => row.value.status === "complete").length,
        ),
      )
      .toBe(2);
    const records = await fixture.store.transaction(async (tx) => ({
      recipes: await tx.list("teaching-fixture", "recipe"),
      budgets: await tx.list("teaching-fixture", "budget"),
      runs: await tx.list<{ status: string }>("teaching-fixture", "run"),
    }));
    expect(
      records.recipes.filter((row) =>
        Reflect.has(row.value as object, "definition"),
      ),
    ).toHaveLength(1);
    expect(
      records.budgets.filter((row) => row.id.startsWith("agent:")),
    ).toHaveLength(0);
    expect(
      records.runs.filter((row) => row.value.status === "complete").length,
    ).toBe(2);
    const teachingMaterial = await fixture.store.transaction(async (tx) =>
      JSON.stringify({
        events: await tx.list("teaching-fixture", "event"),
        recipes: await tx.list("teaching-fixture", "recipe"),
      }),
    );
    for (const forbidden of [
      "PRIVATE KEY",
      "fixture-installation-token",
      "access_token",
      "installation_id",
      "?state=",
    ])
      expect(teachingMaterial.includes(forbidden)).toBe(false);
  });

  test("AC-03 AC-04: independent authors publish selected fragments and a new principal composes fresh access", async ({
    browser,
  }) => {
    for (const [subject, name, start, end] of [
      [
        "setup-author",
        "Prepare an app",
        "Prepare GitHub App · verification",
        "Prepare GitHub App · verification",
      ],
      [
        "access-author",
        "Install and verify",
        "Authorize installation · handoff",
        "Verify GitHub access · verification",
      ],
    ]) {
      const context = await browser.newContext();
      try {
        await fixture.login(context, subject!);
        await fixture.providerPages(context);
        const page = await context.newPage();
        await page.goto(`${fixture.origin}/?section=studio`);
        await page
          .getByRole("button", {
            name: "Create from demonstration",
            exact: true,
          })
          .click();
        await completeProvider(page);
        await page
          .getByRole("button", { name: "Stop teaching and review" })
          .click();
        await page
          .getByRole("combobox", { name: "Start with", exact: true })
          .selectOption({ label: start! });
        await page
          .getByRole("combobox", { name: "End with", exact: true })
          .selectOption({ label: end! });
        await page
          .getByRole("button", { name: "Review reusable step", exact: true })
          .click();
        await page.getByRole("button", { name: "Adjust", exact: true }).click();
        await page.getByLabel("Step name", { exact: true }).fill(name!);
        await page
          .getByRole("button", { name: "Save adjustment", exact: true })
          .click();
        await page
          .getByRole("button", { name: "Save reusable step", exact: true })
          .click();
        await expect(
          page.getByRole("checkbox", { name: name!, exact: true }),
        ).toBeVisible();
      } finally {
        await context.close();
      }
    }
    const automaticContext = await browser.newContext();
    try {
      await fixture.login(automaticContext, "automatic-executor");
      await fixture.providerPages(automaticContext);
      const automaticPage = await automaticContext.newPage();
      await automaticPage.goto(fixture.origin);
      const connected = automaticPage.waitForResponse(
        (response) =>
          response.url().endsWith("/runs") &&
          response.request().method() === "POST",
      );
      await automaticPage
        .getByRole("button", { name: "Connect GitHub", exact: true })
        .click();
      const planned = await (await connected).json();
      expect(planned.nodes.length).toBe(3);
      expect(
        planned.nodes.every((node: { id: string }) =>
          node.id.startsWith("part-"),
        ),
      ).toBe(true);
      const before = { ...fixture.effects };
      await completeProvider(automaticPage);
      expect(fixture.effects.conversions).toBe(before.conversions + 1);
      expect(fixture.effects.tokens).toBe(before.tokens + 1);
    } finally {
      await automaticContext.close();
    }
    const context = await browser.newContext();
    try {
      await fixture.login(context, "fresh-executor");
      await fixture.providerPages(context);
      const page = await context.newPage();
      await page.goto(fixture.origin);
      await page
        .getByRole("checkbox", { name: "Prepare an app", exact: true })
        .check();
      await page
        .getByRole("checkbox", { name: "Install and verify", exact: true })
        .check();
      await page
        .getByRole("button", { name: "Combine steps", exact: true })
        .click();
      await page.getByRole("button", { name: "Adjust", exact: true }).click();
      await page
        .getByLabel("Step name", { exact: true })
        .fill("Composed GitHub connection");
      await page
        .getByRole("button", { name: "Save adjustment", exact: true })
        .click();
      await page
        .getByRole("button", { name: "Save reusable step", exact: true })
        .click();
      const before = { ...fixture.effects };
      await page
        .getByRole("listitem")
        .filter({
          has: page.getByRole("checkbox", {
            name: "Composed GitHub connection",
            exact: true,
          }),
        })
        .getByRole("button", { name: "Use step" })
        .click();
      await completeProvider(page);
      expect(fixture.effects.conversions).toBe(before.conversions + 1);
      expect(fixture.effects.tokens).toBe(before.tokens + 1);
      const recipes = await fixture.store.transaction((tx) =>
        tx.list<{ publisher?: string }>("teaching-fixture", "recipe"),
      );
      expect(
        recipes.some((row) => row.value.publisher === "setup-author"),
      ).toBe(true);
      expect(
        recipes.some((row) => row.value.publisher === "access-author"),
      ).toBe(true);
      expect(
        recipes.some((row) => row.value.publisher === "fresh-executor"),
      ).toBe(true);
    } finally {
      await context.close();
    }
  });

  test("AC-10 AC-19 AC-37: stopped teaching stays stopped across callbacks; discard preserves connection and audit", async ({
    page,
    context,
    browser,
  }) => {
    await fixture.login(context, "consent-author");
    await fixture.providerPages(context);
    await page.goto(`${fixture.origin}/?section=studio`);
    const started = page.waitForResponse(
      (response) =>
        response.url().endsWith("/runs") &&
        response.request().method() === "POST",
    );
    await page
      .getByRole("button", { name: "Create from demonstration", exact: true })
      .click();
    const initial = await (await started).json();
    const demoId = initial.demonstration.id as string;
    await page
      .getByRole("button", { name: "Stop teaching and review" })
      .click();
    const before = await (
      await page.request.get(
        `${fixture.origin}/api/v1/teaching/demonstrations/${encodeURIComponent(demoId)}`,
      )
    ).json();
    await completeProvider(page);
    const after = await (
      await page.request.get(
        `${fixture.origin}/api/v1/teaching/demonstrations/${encodeURIComponent(demoId)}`,
      )
    ).json();
    expect(after.consent).toBe("stopped");
    expect(after.events.length).toBe(before.events.length);
    const foreign = await browser.newContext();
    try {
      await fixture.login(foreign, "other-author");
      expect(
        (
          await foreign.request.get(
            `${fixture.origin}/api/v1/teaching/runs/${encodeURIComponent(initial.id)}`,
          )
        ).status(),
      ).toBe(403);
      expect(
        (
          await foreign.request.post(
            `${fixture.origin}/api/v1/teaching/demonstrations/${encodeURIComponent(demoId)}`,
            {
              headers: { origin: fixture.origin },
              data: { revision: after.revision, consent: "discarded" },
            },
          )
        ).status(),
      ).toBe(403);
    } finally {
      await foreign.close();
    }
    await page
      .getByRole("button", { name: "Discard demonstration", exact: true })
      .click();
    await expect(
      page.getByRole("region", { name: "Demonstration", exact: true }),
    ).toHaveCount(0);
    expect(
      (
        await page.request.get(
          `${fixture.origin}/api/v1/teaching/demonstrations/${encodeURIComponent(demoId)}`,
        )
      ).status(),
    ).toBe(403);
    const retained = await fixture.store.transaction(async (tx) => ({
      events: (
        await tx.list<{ demonstrationId?: string }>("teaching-fixture", "event")
      ).filter((row) => row.value.demonstrationId === demoId).length,
      audit: (await tx.list("teaching-fixture", "audit")).length,
      run: (
        await tx.get<{ status: string }>({
          tenant: "teaching-fixture",
          kind: "run",
          id: initial.id,
        })
      )?.value.status,
    }));
    expect(retained.events).toBe(0);
    expect(retained.audit).toBeGreaterThan(0);
    expect(retained.run).toBe("complete");
  });

  test("AC-42 AC-43 AC-48: offline wait refuses actions and authenticated second tab resumes without a model", async ({
    page,
    context,
  }) => {
    await fixture.login(context, "offline-author");
    await fixture.providerPages(context);
    await page.goto(fixture.origin);
    await page
      .getByRole("button", { name: "Connect GitHub", exact: true })
      .click();
    await expect(
      page.getByRole("link", { name: "Continue with GitHub", exact: true }),
    ).toBeVisible();
    const hint = page.url();
    const before = { ...fixture.effects };
    await context.setOffline(true);
    await expect(
      page.getByRole("region", { name: "Connection and reusable steps" }),
    ).toContainText("Offline. Reconnect");
    await expect(
      page.getByRole("button", { name: "Refresh status", exact: true }),
    ).toBeDisabled();
    await expect(
      page.getByRole("button", { name: "Teach this step", exact: true }),
    ).toBeDisabled();
    expect(fixture.effects).toEqual(before);
    await context.setOffline(false);
    const restored = await context.newPage();
    await restored.goto(hint);
    await expect(
      restored.getByRole("link", { name: "Continue with GitHub", exact: true }),
    ).toBeVisible();
    await page.close();
    await completeProvider(restored);
    expect(fixture.effects.conversions).toBe(before.conversions + 1);
    expect(fixture.effects.tokens).toBe(before.tokens + 1);
    const caches = await restored.evaluate(async () => {
      const urls: string[] = [];
      for (const name of await window.caches.keys())
        for (const request of await (await window.caches.open(name)).keys())
          urls.push(new URL(request.url).pathname);
      return urls;
    });
    expect(
      caches.some(
        (path) => path.startsWith("/api/") || path.startsWith("/auth/"),
      ),
    ).toBe(false);
    expect(
      await restored.evaluate(
        () => localStorage.length + sessionStorage.length,
      ),
    ).toBe(0);
  });
});
