import { test, expect } from "../fixtures/browser-test.js";
import { teachingGitHubFixture } from "../fixtures/teaching-github.js";
import { monitorEventLoopDelay } from "node:perf_hooks";

test.use({
  trace: "off",
  video: "off",
  screenshot: "off",
  actionTimeout: 15000,
});

for (const policy of ["null", "throw"] as const) {
  test(`AC-41 same-tab provider handoff succeeds when popup policy is ${policy}`, async ({
    page,
    context,
  }) => {
    test.setTimeout(60000);
    const fixture = await teachingGitHubFixture(4397);
    const startedAt = Date.now();
    const eventLoop = monitorEventLoopDelay({ resolution: 20 });
    eventLoop.enable();
    const documents: Array<{
      phase: string;
      status: number;
      elapsedMs: number;
    }> = [];
    const scripts = { responses: 0, failed: 0, lastResponseMs: 0 };
    const pageErrors: string[] = [];
    const serverWork: Array<{ phase: string; elapsedMs: number }> = [];
    const mark = (phase: string) =>
      serverWork.push({ phase, elapsedMs: Date.now() - startedAt });
    const connect = fixture.runtime.connect.bind(fixture.runtime);
    fixture.runtime.connect = async (...args) => {
      mark("connect-start");
      try {
        return await connect(...args);
      } finally {
        mark("connect-end");
      }
    };
    const advance = fixture.runtime.commands.advance.bind(
      fixture.runtime.commands,
    );
    fixture.runtime.commands.advance = async (...args) => {
      mark("advance-start");
      try {
        return await advance(...args);
      } finally {
        mark("advance-end");
      }
    };
    page.on("request", (request) => {
      if (new URL(request.url()).pathname === "/api/v1/teaching/runs")
        documents.push({
          phase: "connect-request",
          status: 0,
          elapsedMs: Date.now() - startedAt,
        });
    });
    page.on("pageerror", (error) => pageErrors.push(error.name));
    page.on("response", (response) => {
      const resource = response.request().resourceType();
      if (resource === "script") {
        scripts.responses++;
        if (!response.ok()) scripts.failed++;
        scripts.lastResponseMs = Date.now() - startedAt;
      }
      const path = new URL(response.url()).pathname;
      const api =
        path === "/api/config"
          ? "configuration"
          : path.endsWith("/capabilities")
            ? "capabilities"
            : /^\/api\/v1\/teaching\/runs(?:\/|$)/.test(path)
              ? "run"
              : undefined;
      if (resource !== "document" && !api) return;
      documents.push({
        phase:
          api ??
          (path.endsWith("/callback")
            ? "callback"
            : path.endsWith("/human")
              ? "handoff"
              : path === "/"
                ? "connection"
                : "provider"),
        status: response.status(),
        elapsedMs: Date.now() - startedAt,
      });
    });
    try {
      let popupAttempts = 0;
      await context.exposeBinding("recordBlockedPopup", () => {
        popupAttempts++;
      });
      await context.addInitScript((policy) => {
        Reflect.set(window, "popupAttempts", 0);
        window.open = () => {
          void Reflect.get(window, "recordBlockedPopup")();
          Reflect.set(
            window,
            "popupAttempts",
            Number(Reflect.get(window, "popupAttempts")) + 1,
          );
          if (policy === "throw")
            throw new DOMException("Popup blocked", "NotAllowedError");
          return null;
        };
      }, policy);
      await fixture.login(context, "popup-owner");
      await fixture.providerPages(context);
      await page.goto(`${fixture.origin}/?connector=github`);
      await page
        .getByLabel("GitHub account or organization")
        .fill("fixture-owner");
      await page
        .getByRole("button", { name: "Connect GitHub", exact: true })
        .click();
      await expect(
        page.getByRole("link", { name: "Continue with GitHub", exact: true }),
      ).toBeVisible();
      const original = new URL(page.url()).searchParams.get("teachingRun");
      await page
        .getByRole("link", { name: "Continue with GitHub", exact: true })
        .click();
      await expect(
        page.getByRole("link", { name: "Approve fixture app" }),
      ).toBeVisible();
      await page.getByRole("link", { name: "Approve fixture app" }).click();
      expect(new URL(page.url()).searchParams.get("teachingRun")).toBe(
        original,
      );
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
      expect(new URL(page.url()).searchParams.get("teachingRun")).toBe(
        original,
      );
      expect(
        await page.evaluate(() => Reflect.get(window, "popupAttempts")),
      ).toBe(0);
      expect(context.pages()).toHaveLength(1);
      expect(popupAttempts).toBe(0);
      expect(fixture.effects.conversions).toBe(1);
      expect(fixture.effects.tokens).toBe(1);
    } catch (error) {
      console.info({
        documents,
        scripts,
        pageErrors,
        serverWork,
        eventLoopMaxMs: eventLoop.max / 1e6,
        elapsedMs: Date.now() - startedAt,
        conversions: fixture.effects.conversions,
        tokens: fixture.effects.tokens,
      });
      throw error;
    } finally {
      eventLoop.disable();
      await fixture.close();
    }
  });
}
