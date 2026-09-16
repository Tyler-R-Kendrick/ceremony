import { test, expect } from "../fixtures/browser-test.js";
import { teachingGitHubFixture } from "../fixtures/teaching-github.js";
import { oidcIdpFixture } from "../fixtures/oidc-idp.js";
import {
  authoredAccountRegistrationRecipe,
  saveAuthoredAccountIntent,
} from "../../src/server/authored-operations.js";

for (const javaScriptEnabled of [true, false])
  test(`discovered provider authentication resumes the ceremony with JavaScript ${javaScriptEnabled ? "enabled" : "disabled"}`, async ({
    browser,
  }) => {
    const provider = await oidcIdpFixture({ seed: 82 });
    provider.accounts.set("fixture@example.test", {
      email: "fixture@example.test",
      handle: "chosen-account",
      password: "fixture-password",
      verified: true,
    });
    let isolatedCalls = 0;
    const host = await teachingGitHubFixture(4594, {
      browser: {
        complete: async () => {
          isolatedCalls++;
          return { status: "blocked", reason: "passkey" };
        },
      },
    });
    const context = await browser.newContext({ javaScriptEnabled });
    try {
      const cookie = host.sessionCookie("native-owner");
      await context.addCookies([
        {
          name: "teaching-fixture",
          value: cookie.slice("teaching-fixture=".length),
          url: host.origin,
          httpOnly: true,
          sameSite: "Lax",
        },
      ]);
      const actor = await host.runtime.identity.authenticate(
        new Request(host.origin, { headers: { cookie } }),
      );
      expect(actor).toBeTruthy();
      if (!actor) throw new Error("Fixture identity unavailable");
      const generated = await host.runtime.authoring.fromProvider(
        actor,
        "novel",
        undefined,
        "draft",
        provider.origin,
      );
      const connectorId = generated.draft?.connectorId;
      expect(connectorId).toBeTruthy();
      if (!connectorId) throw new Error("Fixture connector unavailable");
      const run = await host.runtime.executeRecipe(
        actor,
        authoredAccountRegistrationRecipe,
        {},
        connectorId,
      );
      await saveAuthoredAccountIntent(host.store, actor, run.id, {
        identifier: "chosen-account",
        status: "existing",
      });
      await host.runtime.commands.advance(
        actor,
        run.id,
        run.nodes[0]!.id,
        run.revision,
        "native-start",
      );
      const page = await context.newPage();
      const brokerPosts: string[] = [];
      page.on("request", (request) => {
        if (
          request.method() === "POST" &&
          request.url().startsWith(host.origin)
        )
          brokerPosts.push(request.url());
      });
      await page.goto(
        `${host.origin}/api/v1/teaching/${connectorId}/${encodeURIComponent(run.id)}/human`,
      );
      await expect(page).toHaveURL(new RegExp(`${provider.origin}/authorize`));
      await page
        .locator(`input[name="${provider.markup.identifierName}"]`)
        .fill("chosen-account");
      await page
        .locator(`input[name="${provider.markup.passwordName}"]`)
        .fill("fixture-password");
      await page
        .getByRole("button", {
          name: provider.markup.signinButton,
          exact: true,
        })
        .click();
      await page
        .getByRole("button", {
          name: provider.markup.consentButton,
          exact: true,
        })
        .click();
      await expect(page).toHaveURL(
        new RegExp(`${host.origin}/\\?teachingRun=`),
      );
      const response = await context.request.get(
        `${host.origin}/api/v1/teaching/runs/${encodeURIComponent(run.id)}`,
      );
      expect(response.ok()).toBe(true);
      const completed = await response.json();
      expect(completed.status).toBe("complete");
      expect(completed.identity.handle).toBe("chosen-account");
      expect(isolatedCalls).toBe(1);
      expect(brokerPosts).toEqual([]);
    } finally {
      await context.close();
      await host.close();
      await provider.close();
    }
  });

for (const delayedRead of [false, true])
  test(`cancelling a passkey handoff removes stale continuation controls without contacting the provider again (delayed read: ${delayedRead})`, async ({
    page,
    context,
  }) => {
    const provider = await oidcIdpFixture({ seed: 82 });
    let isolatedCalls = 0;
    const host = await teachingGitHubFixture(4594, {
      browser: {
        complete: async () => {
          isolatedCalls++;
          return { status: "blocked", reason: "passkey" };
        },
      },
    });
    let release = () => {};
    let delivered = false;
    try {
      const cookie = host.sessionCookie("cancel-native-owner");
      await context.addCookies([
        {
          name: "teaching-fixture",
          value: cookie.slice("teaching-fixture=".length),
          url: host.origin,
          httpOnly: true,
          sameSite: "Lax",
        },
      ]);
      const actor = await host.runtime.identity.authenticate(
        new Request(host.origin, { headers: { cookie } }),
      );
      if (!actor) throw new Error("Fixture identity unavailable");
      const generated = await host.runtime.authoring.fromProvider(
        actor,
        "novel",
        undefined,
        "draft",
        provider.origin,
      );
      const connectorId = generated.draft?.connectorId;
      if (!connectorId) throw new Error("Fixture connector unavailable");
      const run = await host.runtime.executeRecipe(
        actor,
        authoredAccountRegistrationRecipe,
        {},
        connectorId,
      );
      await saveAuthoredAccountIntent(host.store, actor, run.id, {
        identifier: "chosen-account",
        status: "existing",
      });
      await host.runtime.commands.advance(
        actor,
        run.id,
        run.nodes[0]!.id,
        run.revision,
        "cancel-native-start",
      );
      await page.goto(
        `${host.origin}/?connector=${encodeURIComponent(connectorId)}&teachingRun=${encodeURIComponent(run.id)}`,
      );
      const native = page.getByRole("link", {
        name: "Continue in your browser",
        exact: true,
      });
      await expect(native).toBeVisible();
      await expect(
        page.getByText(/A passkey or security key is required/),
      ).toBeVisible();
      if (delayedRead) {
        const pending = new Promise<void>((resolve) => {
          release = resolve;
        });
        const snapshotUrl = `${host.origin}/api/v1/teaching/runs/${encodeURIComponent(run.id)}`;
        let held = false;
        let captured = false;
        await page.route(snapshotUrl, async (route) => {
          if (held) return route.continue();
          held = true;
          const response = await route.fetch();
          captured = true;
          await pending;
          await route.fulfill({ response });
          delivered = true;
        });
        await page.evaluate(() => window.dispatchEvent(new Event("focus")));
        await expect.poll(() => captured).toBe(true);
        const current = await host.runtime.commands.snapshot(actor, run.id);
        const cancelled = await context.request.post(`${snapshotUrl}/cancel`, {
          headers: { origin: host.origin },
          data: { revision: current.revision },
        });
        expect(cancelled.status()).toBe(200);
        await page.evaluate(() => window.dispatchEvent(new Event("focus")));
      } else {
        await page
          .getByText("Assistance and connection controls", { exact: true })
          .click();
        await page
          .getByRole("button", { name: "Cancel connection", exact: true })
          .click();
      }
      await expect(
        page.getByText(
          "Connection cancelled. Completed provider changes have not been revoked.",
          { exact: true },
        ),
      ).toBeVisible();
      if (delayedRead) {
        release();
        await expect.poll(() => delivered).toBe(true);
        await page.waitForLoadState("networkidle");
        await expect(
          page.getByText(
            "Connection cancelled. Completed provider changes have not been revoked.",
            { exact: true },
          ),
        ).toBeVisible();
      }
      await expect(native).toHaveCount(0);
      await expect(
        page.getByText(/A passkey or security key is required/),
      ).toHaveCount(0);
      await expect(
        page.getByRole("button", {
          name: "Start another connection",
          exact: true,
        }),
      ).toBeVisible();
      expect((await host.runtime.commands.snapshot(actor, run.id)).status).toBe(
        "cancelled",
      );
      expect(isolatedCalls).toBe(1);
    } finally {
      release();
      await page.unrouteAll({ behavior: "wait" });
      await host.close();
      await provider.close();
    }
  });
