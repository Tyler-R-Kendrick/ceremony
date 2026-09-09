import { test, expect } from "@playwright/test";
import { teachingGitHubFixture } from "../fixtures/teaching-github.js";
test.use({
  trace: "off",
  video: "off",
  screenshot: "off",
  actionTimeout: 15000,
});

test("AC-35 AC-42: closed initiating tab still delivers the verified host task once despite a lost acknowledgment", async ({
  page,
  context,
}) => {
  test.setTimeout(60000);
  const fixture = await teachingGitHubFixture(4389, {
    hostContinuation: true,
    loseContinuationAcknowledgment: true,
  });
  try {
    await fixture.login(context, "continuation-author");
    await fixture.providerPages(context);
    const worker = `${fixture.origin}/api/internal/continuations`;
    expect((await context.request.get(worker)).status()).toBe(403);
    expect(
      (
        await context.request.get(worker, {
          headers: { authorization: "Bearer invalid" },
        })
      ).status(),
    ).toBe(403);
    await page.goto(fixture.origin);
    await page
      .getByRole("button", { name: "Connect GitHub", exact: true })
      .click();
    const link = page.getByRole("link", {
      name: "Continue with GitHub",
      exact: true,
    });
    await expect(link).toBeVisible();
    const runId = new URL(page.url()).searchParams.get("teachingRun")!;
    const approval = await context.newPage();
    await approval.goto(
      new URL((await link.getAttribute("href"))!, fixture.origin).href,
    );
    await page.close();
    expect(
      (
        await context.request.get(worker, {
          headers: { authorization: fixture.workerAuthorization },
        })
      ).status(),
    ).toBe(200);
    expect(fixture.effects.continuationRequests).toBe(0);
    await expect(
      approval.getByRole("link", { name: "Approve fixture app" }),
    ).toBeVisible();
    await approval.getByRole("link", { name: "Approve fixture app" }).click();
    await approval
      .getByRole("link", { name: "Continue with GitHub", exact: true })
      .click();
    await approval
      .getByRole("link", { name: "Approve fixture installation" })
      .click();
    await expect(
      approval.getByRole("heading", {
        name: "GitHub connection verified",
        exact: true,
      }),
    ).toBeVisible();
    await approval.close();
    const ledger = () =>
      fixture.store.transaction(async (tx) => ({
        run: (
          await tx.get<{ status: string }>({
            tenant: "teaching-fixture",
            kind: "run",
            id: runId,
          })
        )?.value.status,
        verified: (
          await tx.list<{ verified: boolean }>("teaching-fixture", "node")
        ).filter((row) => row.value.verified).length,
        statuses: (
          await tx.list<{ status: string }>("teaching-fixture", "outbox")
        ).map((row) => row.value.status),
      }));
    expect(await ledger()).toEqual({
      run: "complete",
      verified: 3,
      statuses: ["pending"],
    });
    // Actual hosted worker and continuation HTTP adapter; no browser callback is needed to deliver.
    const attempt = () =>
      context.request.get(worker, {
        headers: { authorization: fixture.workerAuthorization },
      });
    expect((await attempt()).status()).toBe(503);
    expect(fixture.effects.continuationRequests).toBe(1);
    expect(fixture.effects.continuationEffects).toBe(1);
    expect((await ledger()).statuses).toEqual(["pending"]);
    expect((await attempt()).status()).toBe(200);
    expect(fixture.effects.continuationRequests).toBe(2);
    expect(fixture.effects.continuationEffects).toBe(1);
    expect((await ledger()).statuses).toEqual(["delivered"]);
    expect((await attempt()).status()).toBe(200);
    expect(fixture.effects.continuationRequests).toBe(2);
    expect(fixture.effects.conversions).toBe(1);
    expect(fixture.effects.tokens).toBe(1);
  } finally {
    await fixture.close();
  }
});
