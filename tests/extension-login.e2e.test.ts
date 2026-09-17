import assert from "node:assert/strict";
import test from "node:test";
import { createServer } from "node:http";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import { chromium } from "playwright-core";

// One owned site stands in for the provider: a real POST login over real HTTP,
// driving the built artifact's trusted UI end to end. No live providers.
const users = new Map([
  ["owner", { password: "fixture-pass", id: "account-1" }],
]);

test(
  "downloadable extension approves one owned-site login in the selected tab",
  { timeout: 30_000 },
  async () => {
    const root = fileURLToPath(new URL("../", import.meta.url));
    execFileSync(process.execPath, ["scripts/build-extension.mjs"], {
      cwd: root,
      timeout: 30_000,
      stdio: "pipe",
    });
    const extraction = await mkdtemp(join(tmpdir(), "ceremony-extension-zip-"));
    execFileSync("unzip", [
      "-q",
      join(root, "examples/web/public/extension/ceremony-browser-login.zip"),
      "-d",
      extraction,
    ]);
    const extension = extraction;
    const server = createServer((request, response) => {
      const url = new URL(request.url ?? "/", "http://127.0.0.1");
      if (url.pathname === "/login" && request.method === "GET") {
        response.writeHead(200, { "content-type": "text/html" });
        response.end(
          `<!doctype html><html><body><form method="post" action="/login"><label>Username <input name="username" autocomplete="username"></label><label>Password <input name="password" type="password" autocomplete="current-password"></label><button>Sign in</button></form></body></html>`,
        );
        return;
      }
      if (url.pathname === "/login" && request.method === "POST") {
        let body = "";
        request.on("data", (chunk) => (body += chunk));
        request.on("end", () => {
          const params = new URLSearchParams(body);
          const account = users.get(params.get("username") ?? "");
          if (account?.password === params.get("password")) {
            response.writeHead(302, {
              "set-cookie":
                "session=fixture-session; HttpOnly; SameSite=Strict",
              location: "/account",
            });
          } else response.writeHead(302, { location: "/login?error=1" });
          response.end();
        });
        return;
      }
      if (url.pathname === "/account") {
        const match = /(?:^|;\s*)session=([\w-]+)/.exec(
          request.headers.cookie ?? "",
        );
        response.writeHead(200, { "content-type": "text/html" });
        response.end(
          `<!doctype html><html><body>${match ? `<h1>Account</h1><data id="account" value="account-1">account-1</data>` : `<a href="/login">Sign in</a>`}</body></html>`,
        );
        return;
      }
      response.writeHead(404);
      response.end();
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const port = (server.address() as { port: number }).port;
    const profile = await mkdtemp(join(tmpdir(), "ceremony-login-e2e-"));
    const loginUrl = `http://127.0.0.1:${port}/login`;
    let context;
    try {
      context = await chromium.launchPersistentContext(profile, {
        channel: "chromium",
        headless: true,
        args: [
          `--disable-extensions-except=${extension}`,
          `--load-extension=${extension}`,
        ],
      });
      const tab = await context.newPage();
      await tab.goto(loginUrl);
      const worker =
        context
          .serviceWorkers()
          .find((worker) => worker.url().endsWith("worker.js")) ??
        (await context.waitForEvent("serviceworker"));
      const uiPromise = context.waitForEvent("page");
      await worker.evaluate(
        `chrome.tabs.create({ url: chrome.runtime.getURL("ui.html") })`,
      );
      const ui = await uiPromise;
      await ui.waitForLoadState("domcontentloaded");
      assert.ok(ui.url().includes("/ui.html"), `UI opened at ${ui.url()}`);
      await ui.locator("#target").fill(loginUrl);
      // A submitter's method overrides its POST form. Refuse before filling.
      await tab.locator("button").evaluate((button) => {
        button.setAttribute("formmethod", "get");
      });
      await ui.locator("#inspect").click();
      await ui.locator("#review").waitFor({ state: "visible", timeout: 10000 });
      await ui.locator("#username").fill("owner");
      await ui.locator("#password").fill("fixture-pass");
      await ui.locator("#approve").click();
      await ui.waitForFunction(
        () =>
          document
            .querySelector("#status")
            ?.textContent?.startsWith("Submission refused"),
        undefined,
        { timeout: 3000 },
      );
      assert.equal(tab.url(), loginUrl);
      assert.equal(
        await tab.locator('input[name="password"]').inputValue(),
        "",
      );
      await tab.locator("button").evaluate((button) => {
        button.removeAttribute("formmethod");
      });
      await ui.locator("#inspect").click();
      await ui.locator("#review").waitFor({ state: "visible", timeout: 10000 });
      await ui.locator("#username").fill("owner");
      await ui.locator("#password").fill("fixture-pass");
      await ui.locator("#approve").click();
      await ui.waitForFunction(
        () =>
          document
            .querySelector("#status")
            ?.textContent?.startsWith("Submitted"),
        undefined,
        { timeout: 10000 },
      );
      await tab.waitForURL("**/account", { timeout: 10000 });
      assert.equal(
        await tab.locator("#account").getAttribute("value"),
        "account-1",
      );
    } finally {
      await context?.close();
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
      await rm(profile, { recursive: true, force: true });
      await rm(extraction, { recursive: true, force: true });
    }
  },
);
