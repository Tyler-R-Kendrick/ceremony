import { test, expect } from "../fixtures/browser-test.js";
import { ConnectorDrafts } from "../../src/server/connector-drafts.js";
import { teachingGitHubFixture } from "../fixtures/teaching-github.js";
import type { AuthorizationBrowserInput } from "../../src/server/browser-executor.js";

for (const obstacle of ["verification", "submission-uncertain"] as const)
  test(`selected registration email reaches the isolated browser and recovers privately (${obstacle})`, async ({
    page,
    context,
    browser,
  }) => {
    const calls: AuthorizationBrowserInput[] = [];
    const generated = {
      username: "generated-user",
      email: "chosen@example.test",
      password: "private-generated-password",
    };
    let expired = false;
    const host = await teachingGitHubFixture(4488, {
      browser: {
        complete: async (input) => {
          calls.push(input);
          if (input.credentials) {
            expect(input.credentials).toEqual(generated);
            await input.vault!.put(generated);
            return { status: "credentials", accountStored: true };
          }
          await input.vault!.stage!(generated);
          return {
            status: "blocked",
            reason: obstacle,
            ...(obstacle === "verification" ? { sessionPending: true } : {}),
          };
        },
        screenshot: async () => {
          expect(expired).toBe(true);
          return undefined;
        },
      },
    });
    try {
      const cookie = host.sessionCookie("email-owner");
      const actor = await host.runtime.identity.authenticate(
        new Request(host.origin, { headers: { cookie } }),
      );
      if (!actor) throw new Error("Fixture identity unavailable");
      await context.addCookies([
        {
          name: "teaching-fixture",
          value: cookie.slice("teaching-fixture=".length),
          url: host.origin,
          httpOnly: true,
          sameSite: "Lax",
        },
      ]);
      const drafts = new ConnectorDrafts(host.store, {
        fetch: async (input) =>
          String(input).endsWith("/.well-known/oauth-authorization-server")
            ? Response.json({
                issuer: "https://email-fixture.example",
                authorization_endpoint:
                  "https://email-fixture.example/authorize",
                token_endpoint: "https://email-fixture.example/token",
                userinfo_endpoint: "https://email-fixture.example/userinfo",
              })
            : new Response("", { status: 404 }),
      });
      const result = await drafts.fromProvider(
        actor,
        "email-fixture",
        undefined,
        "draft",
        "https://email-fixture.example",
      );
      // Only the model's proposal is supplied; account selection and run execution
      // use the real HTTP boundary and installed connector in the fixture store.
      await page.route("**/api/v1/teaching/authoring/chat", (route) =>
        route.fulfill({ json: { result } }),
      );
      await page.setViewportSize({ width: 390, height: 844 });
      await page.goto(`${host.origin}/?section=studio`);
      await page
        .getByLabel("Message the authoring agent")
        .fill("email-fixture");
      await page.getByRole("button", { name: "Send", exact: true }).click();
      const board = page.getByRole("region", { name: "Discovered ceremonies" });
      await board.getByRole("button", { name: "Account registration" }).click();
      const account = board.getByLabel("Account name or email");
      const submit = board.getByRole("button", {
        name: "Check account and continue",
      });
      await expect(submit).toBeDisabled();
      await account.fill("chosen@example.test");
      expect(
        await account.evaluate((input: HTMLInputElement) =>
          input.checkValidity(),
        ),
      ).toBe(true);
      const started = page.waitForResponse(
        (response) =>
          response.url() === `${host.origin}/api/v1/teaching/runs` &&
          response.request().method() === "POST",
      );
      await submit.click();
      expect((await started).status()).toBe(200);
      const handoff = page.getByRole("region", {
        name: "Human assistance required",
      });
      await expect(handoff).toContainText(
        obstacle === "verification"
          ? "provider verification code"
          : "Automatic resubmission stopped",
      );
      await expect(
        handoff.getByRole("link", { name: "Continue with human assistance" }),
      ).toHaveCount(1);
      expect(calls).toHaveLength(1);
      expect(calls[0]?.preferredUsername).toBe("chosen@example.test");
      expect(calls[0]?.generateAccount).toBe(true);
      await expect(page.getByLabel("Password", { exact: true })).toHaveCount(0);
      expired = true;
      await handoff
        .getByRole("link", { name: "Continue with human assistance" })
        .click();
      await expect(
        page.getByRole("heading", { name: "Recover interrupted registration" }),
      ).toBeVisible();
      await expect(page.locator("body")).not.toContainText(generated.password);
      await page
        .getByRole("button", { name: "Try sign-in with saved credentials" })
        .click();
      await expect.poll(() => calls.length).toBe(2);
      expect(calls[1]?.generateAccount).not.toBe(true);
      expect(calls[1]?.resumeSession).toBeUndefined();
      expect(calls[1]?.startUrl).toBe("https://email-fixture.example/login");
      await expect(
        page.getByRole("heading", {
          name: "email fixture account setup complete",
          exact: true,
        }),
      ).toBeVisible();
      await expect(
        page.getByText("Verified access is ready for the original task."),
      ).toHaveCount(0);
      await expect(page.locator("body")).not.toContainText(generated.password);
      for (const width of [390, 1440]) {
        await page.setViewportSize({ width, height: 844 });
        expect(
          await page.evaluate(
            () => document.documentElement.scrollWidth <= innerWidth,
          ),
        ).toBe(true);
      }
      await page
        .getByRole("link", { name: "Get saved account credentials" })
        .click();
      await expect(
        page.getByRole("heading", { name: "Saved account credentials" }),
      ).toBeVisible();
      await expect(page.getByLabel("Password", { exact: true })).toHaveCount(0);
      const claimUrl = page.url();
      const [claimed] = await Promise.all([
        page.waitForResponse(
          (response) =>
            response.url() === claimUrl &&
            response.request().method() === "POST",
        ),
        page
          .getByRole("button", { name: "Show saved account credentials" })
          .click(),
      ]);
      expect(claimed.request().headers().origin).toBe(host.origin);
      expect(claimed.status()).toBe(200);
      expect(claimed.headers()["cache-control"]).toBe("no-store");
      await expect(page.getByLabel("Password", { exact: true })).toHaveValue(
        generated.password,
      );
      await expect(page.getByLabel("Account", { exact: true })).toHaveValue(
        generated.username,
      );
      await expect(page.getByLabel("Email", { exact: true })).toHaveValue(
        generated.email,
      );
      for (const width of [390, 1440]) {
        await page.setViewportSize({ width, height: 844 });
        expect(
          await page.evaluate(
            () => document.documentElement.scrollWidth <= innerWidth,
          ),
        ).toBe(true);
      }
      expect(calls).toHaveLength(2);
      await page.goto(claimUrl);
      await expect(page.getByLabel("Password", { exact: true })).toHaveCount(0);
      await page.getByRole("link", { name: "Return to connection" }).click();
      await expect(
        page.getByRole("heading", {
          name: "email fixture account setup complete",
          exact: true,
        }),
      ).toBeVisible();
      await expect(page.locator("body")).not.toContainText(generated.password);
      const nativeContext = await browser.newContext({
        javaScriptEnabled: false,
      });
      try {
        await nativeContext.addCookies(await context.cookies(host.origin));
        const nativePage = await nativeContext.newPage();
        await nativePage.goto(claimUrl);
        await expect(
          nativePage.getByLabel("Password", { exact: true }),
        ).toHaveCount(0);
        await nativePage
          .getByRole("button", { name: "Show saved account credentials" })
          .click();
        await expect(
          nativePage.getByLabel("Password", { exact: true }),
        ).toHaveValue(generated.password);
        expect(calls).toHaveLength(2);
      } finally {
        await nativeContext.close();
      }
    } finally {
      await host.close();
    }
  });
