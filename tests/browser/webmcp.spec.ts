import { test, expect, type Page } from "@playwright/test";
import { fileURLToPath } from "node:url";
import type { ActionEvent, ActionFailureEvent } from "../../src/core/index.js";

// Exercise the native experimental API, not a registration mock.
test.use({
  launchOptions: { args: ["--enable-experimental-web-platform-features"] },
});
interface RegisteredTool {
  name: string;
}
interface NativeModelContext {
  getTools(): Promise<RegisteredTool[]>;
  executeTool(tool: RegisteredTool, input: string): Promise<string | null>;
}
declare global {
  interface Document {
    modelContext: NativeModelContext;
  }
}
const errors = new WeakMap<Page, string[]>();
test.beforeEach(({ page }) => {
  const list: string[] = [];
  errors.set(page, list);
  page.on("pageerror", (error) => list.push(error.message));
});
test.afterEach(({ page }) => expect(errors.get(page)).toEqual([]));
async function names(page: Page) {
  return page.evaluate(async () =>
    (await document.modelContext.getTools()).map((tool) => tool.name),
  );
}
async function call(
  page: Page,
  action: string,
  input: object = {},
  prefix = "test_ceremony",
) {
  const result = await page.evaluate(
    async ({ name, input }) => {
      const tool = (await document.modelContext.getTools()).find(
        (tool) => tool.name === name,
      );
      if (!tool) throw new Error(`Missing native tool: ${name}`);
      return document.modelContext.executeTool(tool, JSON.stringify(input));
    },
    { name: `${prefix}_${action}`, input },
  );
  return result ? JSON.parse(result) : null;
}
async function mount(page: Page, connectorId = "github") {
  await page.goto("/");
  await expect.poll(() => names(page)).toContain("ceremony_github_read");
  await page.evaluate(
    async ({ entry, connectorId }) => {
      const module = await import(entry);
      await module.mountHarness(connectorId);
    },
    {
      entry: `/@fs${fileURLToPath(new URL("./webmcp-harness.tsx", import.meta.url))}`,
      connectorId,
    },
  );
  await expect.poll(() => names(page)).toContain("test_ceremony_navigate");
}
type RecordedEvent = (ActionEvent | ActionFailureEvent) & { status: string };
async function events(page: Page): Promise<RecordedEvent[]> {
  return JSON.parse(await page.locator("#hook-events").innerText());
}

test("native tools share UI execution, classify failures, serialize submits, redact hooks and unregister", async ({
  page,
}) => {
  await mount(page);
  expect(
    (await names(page)).filter((name) => name.startsWith("test_ceremony_")),
  ).toHaveLength(11);
  expect((await call(page, "read")).actions).toEqual(["start"]);
  const automatic = await call(page, "start");
  expect(automatic.methodId).toBe("oauth");
  expect(automatic.step).toBe("redirect");
  expect((await call(page, "start", { methodId: "api-key" })).step).toBe(
    "input",
  );
  expect(
    (await call(page, "submit", { values: { token: "wrong-secret" } })).ok,
  ).toBe(false);
  expect((await call(page, "read")).step).toBe("input");
  await page
    .locator("#hook-harness")
    .getByLabel("GitHub personal access token", { exact: true })
    .fill("wrong-secret");
  await page
    .locator("#hook-harness")
    .getByRole("button", { name: "Continue", exact: true })
    .click();
  await expect(
    page.locator("#hook-harness").getByRole("button", { name: "Try again" }),
  ).toBeVisible();
  expect((await events(page)).at(-1)).toMatchObject({
    action: "submit",
    source: "ui",
    status: "failure",
    reason: "ceremony_failed",
  });
  await page
    .locator("#hook-harness")
    .getByRole("button", { name: "Try again" })
    .click();
  await expect(
    page
      .locator("#hook-harness")
      .getByLabel("GitHub personal access token", { exact: true }),
  ).toBeVisible();
  expect((await events(page)).at(-1)).toMatchObject({
    action: "retry",
    source: "ui",
    status: "success",
  });
  const current = await call(page, "read");
  const secretRef = await page.evaluate(
    async ({ id, revision }) => {
      const response = await fetch(`/api/ceremonies/${id}/collect`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ revision, values: { token: "demo-api-key" } }),
      });
      return (await response.json()).secretRef;
    },
    { id: current.instanceId, revision: current.revision },
  );
  const submitted = await Promise.all([
    call(page, "submit", { secretRef }),
    call(page, "submit", { secretRef }),
  ]);
  expect(submitted.filter((result) => result.ok)).toHaveLength(1);
  expect((await call(page, "read")).step).toBe("complete");
  expect((await call(page, "cancel")).ok).toBe(false);
  const recorded = await events(page);
  expect(recorded.filter((event) => event.action === "submit")).toHaveLength(3);
  expect(new Set(recorded.map((event) => event.executionId)).size).toBe(
    recorded.length,
  );
  expect(JSON.stringify(recorded)).not.toMatch(
    /wrong-secret|demo-api-key|connectionRef|authorizationUrl|values/,
  );
  const before = recorded.length;
  expect((await call(page, "cancel", { action: "start" })).ok).toBe(false);
  expect(await events(page)).toHaveLength(before); // Schema rejection is not an execution.
  await page.getByRole("button", { name: "Unmount harness" }).click();
  await expect.poll(() => names(page)).not.toContain("test_ceremony_read");
  expect(await names(page)).toContain("ceremony_github_read");
});

test("native anonymous finish/claim/cancel and device navigation preserve provider approval", async ({
  page,
}) => {
  await mount(page, "neon");
  await call(page, "start", { methodId: "anonymous" });
  expect((await call(page, "begin")).step).toBe("anonymous");
  expect((await call(page, "finish")).ownership).toBe("anonymous");
  expect((await call(page, "claim")).step).toBe("claim");
  expect((await call(page, "cancel")).step).toBe("anonymous");
  await call(page, "claim");
  const waiting = await call(page, "submit", { values: {} });
  expect(waiting.step).toBe("waiting");
  const popupEvent = page.waitForEvent("popup");
  expect((await call(page, "navigate")).ok).toBe(true);
  const popup = await popupEvent;
  await popup.getByLabel("Email", { exact: true }).fill("demo@example.com");
  await popup.getByLabel("Password", { exact: true }).fill("ceremony-demo");
  await popup.getByLabel("Destination organization").selectOption("demo-org");
  await popup.getByRole("button", { name: "Approve", exact: true }).click();
  await expect(
    page
      .locator("#hook-harness")
      .getByText("Ownership claimed", { exact: true }),
  ).toBeVisible();
  expect(
    (await events(page)).some(
      (event) =>
        event.source === "system" &&
        event.action === "read" &&
        event.step === "complete" &&
        event.status === "success",
    ),
  ).toBe(true);
  await popup.close();
});

test("native OAuth navigation resumes its instance after provider callback", async ({
  page,
}) => {
  await page.goto("/");
  await expect.poll(() => names(page)).toContain("ceremony_github_navigate");
  await call(page, "start", { methodId: "oauth" }, "ceremony_github");
  expect((await call(page, "begin", {}, "ceremony_github")).step).toBe(
    "redirect",
  );
  await call(page, "navigate", {}, "ceremony_github").catch((error) => {
    // Same-document evaluation can disappear before WebMCP returns its navigation result.
    expect(String(error)).toContain("Execution context was destroyed");
  });
  await expect(page).toHaveURL(/4174\/authorize/);
  await page.getByLabel("Email", { exact: true }).fill("demo@example.com");
  await page.getByLabel("Password", { exact: true }).fill("ceremony-demo");
  await page.getByRole("button", { name: "Approve", exact: true }).click();
  await expect(
    page.getByRole("heading", { name: "You’re connected" }),
  ).toBeVisible();
  expect((await call(page, "read", {}, "ceremony_github")).ownership).toBe(
    "authenticated",
  );
});

test("WebMCP requests a private human collector without accepting a secret argument", async ({
  page,
}) => {
  await page.goto("/");
  await expect
    .poll(() => names(page))
    .toContain("ceremony_github_request-input");
  await call(page, "start", { methodId: "api-key" }, "ceremony_github");
  const popupPromise = page.waitForEvent("popup");
  expect((await call(page, "request-input", {}, "ceremony_github")).ok).toBe(
    true,
  );
  const popup = await popupPromise;
  await popup
    .getByLabel("GitHub personal access token", { exact: true })
    .fill("demo-api-key");
  await popup.getByRole("button", { name: "Submit privately" }).click();
  await expect(popup.getByRole("status")).toContainText(
    "Private input submitted",
  );
  await expect(
    page.getByRole("heading", { name: "You’re connected" }),
  ).toBeVisible();
  await popup.close();
});
