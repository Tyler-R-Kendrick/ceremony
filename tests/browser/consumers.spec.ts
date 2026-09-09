import { test, expect } from "@playwright/test";
import { AxeBuilder } from "@axe-core/playwright";
import { mkdtemp, cp, access } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { preview, type PreviewServer } from "vite";

const run = promisify(execFile);
const servers: PreviewServer[] = [];
test.use({
  launchOptions: { args: ["--enable-experimental-web-platform-features"] },
});
test.beforeAll(async () => {
  test.setTimeout(180000);
  const workspace = fileURLToPath(new URL("../../", import.meta.url));
  const temp = await mkdtemp(join(tmpdir(), "ceremony-consumers-"));
  const packed = await run(
    "npm",
    ["pack", "--json", "--pack-destination", temp],
    { cwd: workspace },
  );
  const tarball = join(temp, JSON.parse(packed.stdout)[0].filename);
  for (const [index, framework] of ["react", "vue"].entries()) {
    const root = join(temp, framework);
    await cp(
      fileURLToPath(new URL(`../consumers/${framework}/`, import.meta.url)),
      root,
      { recursive: true },
    );
    await run(
      "npm",
      ["install", "--cache", "/tmp/ceremony-npm-cache", tarball],
      { cwd: root, maxBuffer: 4_000_000 },
    );
    if (framework === "vue")
      await expect(access(join(root, "node_modules/react"))).rejects.toThrow();
    await run("npm", ["run", "build"], {
      cwd: root,
      maxBuffer: 4_000_000,
    });
    servers.push(
      await preview({
        root,
        configFile: false,
        preview: {
          host: "127.0.0.1",
          port: 4373 + index,
          strictPort: true,
          proxy: {
            "/api": {
              target: "http://127.0.0.1:4173",
              changeOrigin: true,
              headers: { origin: "http://127.0.0.1:4173" },
            },
          },
        },
      }),
    );
  }
  console.log(`Packed external consumer evidence: ${temp}`);
});
test.afterAll(async () => {
  for (const server of servers)
    await new Promise<void>((resolve) =>
      server.httpServer.close(() => resolve()),
    );
});

test("packed React components compose, isolate IDs, theme, and retain native WebMCP", async ({
  page,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto("http://127.0.0.1:4373");
  await expect(
    page.locator("#light").getByLabel("Stripe secret key"),
  ).toBeVisible();
  await expect(
    page.locator("#dark").getByLabel("Stripe secret key"),
  ).toBeVisible();
  const ids = await page
    .locator("[id]")
    .evaluateAll((elements) => elements.map((element) => element.id));
  expect(new Set(ids).size).toBe(ids.length);
  expect(
    await page
      .locator("#host-control")
      .evaluate((element) => getComputedStyle(element).minHeight),
  ).toBe("0px");
  expect(
    await page
      .locator("#dark input")
      .evaluate((element) => getComputedStyle(element).backgroundColor),
  ).toBe("rgb(24, 43, 36)");
  for (const viewport of [
    { width: 1280, height: 800 },
    { width: 390, height: 844 },
  ]) {
    await page.setViewportSize(viewport);
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
    const results = await new AxeBuilder({ page })
      .include("#light")
      .include("#dark")
      .analyze();
    expect(results.violations).toEqual([]);
  }
  await page.evaluate(() => {
    document.documentElement.style.fontSize = "200%";
  });
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  await page.evaluate(() => {
    document.documentElement.style.fontSize = "";
  });
  await page
    .locator("#light")
    .getByLabel("Stripe secret key")
    .fill("demo-api-key");
  await page
    .locator("#light")
    .getByRole("button", { name: "Continue", exact: true })
    .click();
  await expect(
    page.locator("#light").getByRole("heading", { name: "You’re connected" }),
  ).toBeVisible();
  await expect(
    page.locator("#dark").getByLabel("Stripe secret key"),
  ).toBeVisible();
  await page.getByLabel("Host token").fill("demo-api-key");
  await page.getByRole("button", { name: "Connect from host" }).click();
  await expect(page.getByText("Custom connected")).toBeVisible();
  const tools = await page.evaluate(async () =>
    (await document.modelContext.getTools()).map((tool) => tool.name),
  );
  expect(tools).toContain("external_custom_submit");
  expect(tools).toContain("external_dark_submit");
  expect(errors).toEqual([]);
});
test("packed Vue app runs the same client and WebMCP without React installed", async ({
  page,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto("http://127.0.0.1:4374");
  await expect(page.getByLabel("Vue token")).toBeVisible();
  await page.getByLabel("Vue token").fill("demo-api-key");
  await page.getByRole("button", { name: "Connect from Vue" }).click();
  await expect(page.getByText("Vue connected")).toBeVisible();
  const result = await page.evaluate(async () => {
    const tool = (await document.modelContext.getTools()).find(
      (tool) => tool.name === "external_vue_read",
    );
    if (!tool) throw new Error("Missing WebMCP tool");
    return document.modelContext.executeTool(tool, "{}");
  });
  expect(JSON.parse(result!)).toMatchObject({
    ok: true,
    ownership: "authenticated",
  });
  expect(errors).toEqual([]);
});
