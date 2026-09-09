import { test, expect, type Page } from "@playwright/test";
import { AxeBuilder } from "@axe-core/playwright";
import { createServer } from "node:http";
import { once } from "node:events";
import { readFile } from "node:fs/promises";
import { defaultTemplate } from "../../src/core/index.js";
import { startReferenceApp } from "../../examples/server.js";
import { manifests, connectorDetails } from "../../examples/manifests.js";

const browserErrors = new WeakMap<Page, string[]>();
test.beforeEach(async ({ page }) => {
  // Audit product UI, not the separately installed development editor.
  await page.route(/^http:\/\/localhost:\d+\/live\.js(?:\?|$)/, (route) =>
    route.abort(),
  );
  const errors: string[] = [];
  browserErrors.set(page, errors);
  page.on("pageerror", (error) => errors.push(error.message));
});
test.afterEach(({ page }) => {
  expect(browserErrors.get(page)).toEqual([]);
});

test("every named service renders only its documented methods and clearly identifies local execution", async ({
  page,
}) => {
  await page.goto("/");
  const services = page.getByRole("complementary", {
    name: "Available services",
    exact: true,
  });
  await expect(services.getByRole("button")).toHaveCount(manifests.length);
  for (const manifest of manifests) {
    await services
      .getByRole("button", { name: new RegExp(manifest.name) })
      .click();
    await expect(page.locator(".service-heading h2")).toHaveText(manifest.name);
    await expect(
      page.getByText("Local simulation", { exact: true }),
    ).toBeVisible();
    await expect(
      page.getByRole("link", { name: "Auth documentation" }),
    ).toHaveAttribute("href", connectorDetails[manifest.id]!.documentationUrl);
    for (const method of manifest.methods) {
      if (manifest.methods.length > 1) {
        await page.getByLabel("Authentication method").selectOption(method.id);
        if (
          await page
            .getByRole("button", { name: "Select method", exact: true })
            .count()
        )
          await page
            .getByRole("button", { name: "Select method", exact: true })
            .click();
      }
      await expect(page.locator(".runtime-context dd").nth(1)).toHaveText(
        method.label,
      );
      for (const field of method.fields)
        await expect(
          page.getByLabel(field.label, { exact: true }),
        ).toHaveAttribute("type", field.type);
    }
    await page.setViewportSize({ width: 390, height: 844 });
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
    expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
    await page.setViewportSize({ width: 1280, height: 844 });
  }
});

async function selectMethod(page: Page, id: string) {
  const connector =
    { basic: "jira", form: "supabase", anonymous: "neon" }[id] ?? "github";
  await page.goto(`/?connector=${connector}`);
  await expect(page.locator("#impeccable-live-global-bar-brand")).toHaveCount(
    0,
  );
  if (connector !== "github") return;
  if (id === "oauth")
    await page
      .getByRole("button", { name: "Select method", exact: true })
      .click();
  else await page.getByLabel("Authentication method").selectOption(id);
}
async function signIn(page: Page, code?: string, decision = "Approve") {
  await page.getByLabel("Email", { exact: true }).fill("demo@example.com");
  await page.getByLabel("Password", { exact: true }).fill("ceremony-demo");
  if (code)
    await page.getByLabel("Verification code", { exact: true }).fill(code);
  await page.getByRole("button", { name: decision, exact: true }).click();
}
test("Connect and studio remain accessible at desktop and mobile sizes", async ({
  page,
}) => {
  await page.goto("/");
  for (const width of [1280, 390]) {
    await page.setViewportSize({ width, height: 844 });
    await page
      .getByRole("navigation")
      .getByRole("button", { name: "Connect", exact: true })
      .click();
    expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
    await page.getByRole("button", { name: "Template studio" }).click();
    expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
    for (const control of await page
      .locator("nav button, .toolbar button, .toolbar .button")
      .all()) {
      const box = await control.boundingBox();
      expect(box?.height).toBeGreaterThanOrEqual(44);
      expect(box?.width).toBeGreaterThanOrEqual(44);
    }
  }
  await page.emulateMedia({ reducedMotion: "reduce" });
  const button = page.getByRole("button", { name: "Template studio" });
  await button.hover();
  await page.mouse.down();
  expect(
    await button.evaluate((element) => getComputedStyle(element).transform),
  ).toBe("none");
  await page.mouse.up();
});
test("credentials, rejection/retry, template reuse, secret exclusion and reload", async ({
  page,
}) => {
  const requests: { url: string; data: string }[] = [];
  page.on("request", (request) =>
    requests.push({ url: request.url(), data: request.postData() ?? "" }),
  );
  await selectMethod(page, "api-key");
  await page
    .getByLabel("GitHub personal access token", { exact: true })
    .fill("wrong-secret");
  await page.getByRole("button", { name: "Continue", exact: true }).click();
  await expect(
    page.getByText("The credentials were rejected.", { exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Try again", exact: true }).click();
  await page
    .getByLabel("GitHub personal access token", { exact: true })
    .fill("demo-api-key");
  await page.getByRole("button", { name: "Continue", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "You’re connected" }),
  ).toBeVisible();
  await page.reload();
  await expect(
    page.getByRole("heading", { name: "You’re connected" }),
  ).toBeVisible();
  const browserState = await page.evaluate(() =>
    JSON.stringify({
      local: { ...localStorage },
      session: { ...sessionStorage },
      cookie: document.cookie,
    }),
  );
  expect(browserState).not.toContain("demo-api-key");
  expect(browserState).not.toContain("wrong-secret");
  expect(
    requests.filter((request) => request.url.includes("/api/generate")),
  ).toHaveLength(0);
  expect(
    requests
      .filter((request) => request.data.includes("demo-api-key"))
      .every((request) => request.url.endsWith("/collect")),
  ).toBe(true);
  await page.getByRole("button", { name: /Stripe/ }).click();
  await expect(page.getByLabel("Stripe secret key")).toBeVisible();
  await page.getByLabel("Stripe secret key").fill("demo-api-key");
  await page.getByRole("button", { name: "Continue", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "You’re connected" }),
  ).toBeVisible();
});
test("Basic and forms authentication complete with native forms", async ({
  page,
}) => {
  await selectMethod(page, "basic");
  await page
    .getByLabel("Atlassian email", { exact: true })
    .fill("demo@example.com");
  await page
    .getByLabel("Atlassian API token", { exact: true })
    .fill("ceremony-demo");
  await page.getByLabel("Atlassian API token", { exact: true }).press("Enter");
  await expect(
    page.getByRole("heading", { name: "You’re connected" }),
  ).toBeVisible();
  await selectMethod(page, "form");
  await page.getByLabel("Email", { exact: true }).fill("demo@example.com");
  await page.getByLabel("Password", { exact: true }).fill("ceremony-demo");
  await page.getByRole("button", { name: "Continue", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "You’re connected" }),
  ).toBeVisible();
});
test("OAuth leaves for the provider and resumes the same ceremony after callback", async ({
  page,
}) => {
  await selectMethod(page, "oauth");
  await page
    .locator(".ceremony")
    .getByRole("button", { name: "Connect", exact: true })
    .click();
  await page.getByRole("link", { name: /Continue to provider/ }).click();
  await expect(page).toHaveURL(/4174\/authorize/);
  await signIn(page);
  await expect(page).toHaveURL(/4173\/\?connector=github&ceremony=/);
  await expect(
    page.getByRole("heading", { name: "You’re connected" }),
  ).toBeVisible();
});
test("device authorization survives reload and completes after approval in another tab", async ({
  page,
}) => {
  await selectMethod(page, "device");
  await page
    .locator(".ceremony")
    .getByRole("button", { name: "Connect", exact: true })
    .click();
  const code = await page
    .getByLabel("Verification code", { exact: true })
    .textContent();
  expect(code).toBeTruthy();
  await page.reload();
  await expect(
    page.getByRole("heading", { name: "Waiting for approval" }),
  ).toBeVisible();
  const popupEvent = page.waitForEvent("popup");
  await page.getByRole("link", { name: /Open approval page/ }).click();
  const approval = await popupEvent;
  await signIn(approval, code!);
  await expect(
    approval.getByRole("heading", { name: "Connection approved" }),
  ).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "You’re connected" }),
  ).toBeVisible();
  await approval.close();
});
test("auth.md starts anonymously and later claims ownership", async ({
  page,
}) => {
  await selectMethod(page, "anonymous");
  await page
    .locator(".ceremony")
    .getByRole("button", { name: "Connect", exact: true })
    .click();
  await expect(
    page.getByRole("heading", { name: "Anonymous access is ready" }),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "Continue anonymously", exact: true })
    .click();
  await page.reload();
  await page
    .getByRole("button", { name: "Claim ownership", exact: true })
    .click();
  await expect(page.getByLabel("Account email")).toHaveCount(0);
  await page.getByRole("button", { name: "Continue", exact: true }).click();
  const popupEvent = page.waitForEvent("popup");
  await page.getByRole("link", { name: /Open approval page/ }).click();
  const approval = await popupEvent;
  await approval
    .getByLabel("Destination organization")
    .selectOption("demo-org");
  await signIn(approval);
  await expect(
    page.getByText("Ownership claimed", { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByText(/Anonymous credentials were discarded/),
  ).toBeVisible();
  await approval.close();
});
test("switching methods cancels prior attempt; API rejects other sessions and cross-origin writes", async ({
  page,
  browser,
}) => {
  await selectMethod(page, "device");
  await page
    .locator(".ceremony")
    .getByRole("button", { name: "Connect", exact: true })
    .click();
  const prior = new URL(page.url()).searchParams.get("ceremony")!;
  const polling = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  await page.route(`**/api/ceremonies/${prior}`, async (route) => {
    polling.resolve();
    await release.promise;
    await route.continue();
  });
  try {
    await polling.promise;
    // Hold a real background read open while the user changes method.
    await expect(page.getByLabel("Authentication method")).toBeEnabled();
    await page.getByLabel("Authentication method").selectOption("api-key");
  } finally {
    release.resolve();
  }
  await expect(
    page.getByLabel("GitHub personal access token", { exact: true }),
  ).toBeVisible();
  const old = await page.request.get(`/api/ceremonies/${prior}`);
  expect((await old.json()).step).toBe("cancelled");
  const stranger = await browser.newContext();
  expect(
    (
      await stranger.request.get(
        `http://127.0.0.1:4173/api/ceremonies/${prior}`,
      )
    ).status(),
  ).toBe(404);
  const badOrigin = await page.request.post("/api/ceremonies", {
    headers: { origin: "https://attacker.example" },
    data: { connectorId: "github", methodId: "oauth" },
  });
  expect(badOrigin.status()).toBe(403);
  await stranger.close();
});
test("studio previews every state, rejects malformed imports, and fits a mobile viewport", async ({
  page,
}) => {
  await page.goto("/");
  await page.getByRole("button", { name: "Template studio" }).click();
  await expect(page.getByText("✓ Validated", { exact: true })).toBeVisible();
  for (const step of [
    "intro",
    "input",
    "redirect",
    "waiting",
    "anonymous",
    "claim",
    "complete",
    "error",
    "cancelled",
    "expired",
  ]) {
    await page.getByLabel("Ceremony state").selectOption(step);
    await expect(page.locator(".preview-card h2")).toBeVisible();
  }
  await page.getByLabel("Template source · JSON / OpenUI").fill("{broken");
  await expect(
    page.getByRole("button", { name: "Export template", exact: true }),
  ).toBeDisabled();
  await page.getByLabel("Auth family").selectOption("basic");
  await page.setViewportSize({ width: 390, height: 844 });
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  await page
    .getByRole("navigation")
    .getByRole("button", { name: "Connect", exact: true })
    .click();
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
});
test("generate, export, import and run an authored template after the model is offline", async ({
  page,
}) => {
  let captured = "";
  let modelCalls = 0;
  const candidate = defaultTemplate("api-key");
  candidate.screens.input = candidate.screens.input.replace(
    "Enter your credentials",
    "A calmer connection",
  );
  const model = createServer(async (request, response) => {
    for await (const chunk of request) captured += chunk.toString();
    modelCalls++;
    response.writeHead(200, { "content-type": "application/json" });
    response.end(
      JSON.stringify({
        choices: [{ message: { content: JSON.stringify(candidate) } }],
      }),
    );
  });
  model.listen(0, "127.0.0.1");
  await once(model, "listening");
  const address = model.address();
  if (!address || typeof address === "string") throw new Error("No model port");
  const app = await startReferenceApp({
    port: 4273,
    providerPort: 4274,
    modelUrl: `http://127.0.0.1:${address.port}/v1/chat/completions`,
    modelName: "test-model",
  });
  try {
    await page.goto(`${app.origin}/`);
    await page.getByRole("button", { name: "Template studio" }).click();
    await page.getByLabel("Auth family").selectOption("api-key");
    await page
      .getByRole("button", { name: "Generate template", exact: true })
      .click();
    await expect(page.locator(".preview-card")).toContainText("GitHub");
    await expect(page.locator(".editor-card [role=status]")).toContainText(
      "Generated and validated",
    );
    const downloadEvent = page.waitForEvent("download");
    await page
      .getByRole("button", { name: "Export template", exact: true })
      .click();
    const exported = await downloadEvent;
    const path = await exported.path();
    expect(path).toBeTruthy();
    const bytes = await readFile(path!);
    await page.getByLabel("Template source · JSON / OpenUI").fill("{}");
    await page.locator("input[type=file]").setInputFiles({
      name: "exported.json",
      mimeType: "application/json",
      buffer: bytes,
    });
    await expect(page.getByText("✓ Validated", { exact: true })).toBeVisible();
    await page.getByRole("button", { name: "Use on Connect page" }).click();
    model.closeAllConnections();
    await new Promise<void>((done) => model.close(() => done()));
    await page
      .getByRole("navigation")
      .getByRole("button", { name: "Connect", exact: true })
      .click();
    await page.getByRole("button", { name: /Stripe/ }).click();
    await expect(
      page.getByRole("heading", { name: "A calmer connection" }),
    ).toBeVisible();
    await page.getByLabel("Stripe secret key").fill("demo-api-key");
    await page.getByRole("button", { name: "Continue", exact: true }).click();
    await expect(
      page.getByRole("heading", { name: "You’re connected" }),
    ).toBeVisible();
    expect(modelCalls).toBe(1);
    expect(captured).not.toContain("demo-api-key");
    expect(bytes.toString()).not.toContain("demo-api-key");
  } finally {
    model.closeAllConnections();
    model.close();
    await app.close();
  }
});
