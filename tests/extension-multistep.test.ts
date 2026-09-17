import assert from "node:assert/strict";
import test from "node:test";
import { createServer, type ServerResponse } from "node:http";
import { once } from "node:events";
import { cp, mkdir, mkdtemp, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import {
  chromium,
  type BrowserContext,
  type Page,
  type Worker,
} from "playwright-core";

// Real downloadable ZIP, Chromium and trusted UI; no live providers, model or
// mocked extension messages.
const username = "multistep-fixture-owner";
const password = "multistep-fixture-password-7!";
const account = "account-1";
const deadline = 15_000;
const quietWindow = 750;
type Mode = "combined" | "split" | "delayed" | "redirect" | "same-document";
type Post = { path: string; fields: Record<string, string> };

function form(kind: "identifier" | "password" | "combined", action: string) {
  return `<form method="post" action="${action}">${
    kind !== "password"
      ? '<label>Username <input name="username" autocomplete="username"></label>'
      : ""
  }${
    kind !== "identifier"
      ? '<label>Password <input name="password" type="password" autocomplete="current-password"></label>'
      : ""
  }<button type="submit">Sign in</button></form>`;
}

async function fixture(mode: Mode, redirectOrigin?: string) {
  const posts: Post[] = [];
  let releaseFirst: (() => void) | undefined;
  let receivedFirst!: () => void;
  const firstPost = new Promise<void>((resolve) => (receivedFirst = resolve));
  const html = (response: ServerResponse, body: string) => {
    response.writeHead(200, {
      "content-type": "text/html",
      "cache-control": "no-store",
    });
    response.end(`<!doctype html><html><body>${body}</body></html>`);
  };
  const redirect = (
    response: ServerResponse,
    location: string,
    cookie?: string,
  ) => {
    response.writeHead(303, {
      location,
      ...(cookie ? { "set-cookie": cookie } : {}),
    });
    response.end();
  };
  const server = createServer((request, response) => {
    const path = new URL(request.url ?? "/", "http://127.0.0.1").pathname;
    if (request.method === "POST") {
      let body = "";
      request.on("data", (chunk) => (body += chunk));
      request.on("end", () => {
        const fields = Object.fromEntries(new URLSearchParams(body));
        posts.push({ path, fields });
        if (path === "/identifier") {
          if (fields.username !== username || fields.password !== undefined) {
            response.writeHead(400).end();
            receivedFirst();
            return;
          }
          const next = () => {
            if (mode === "same-document") response.writeHead(204).end();
            else
              redirect(
                response,
                mode === "redirect"
                  ? `${redirectOrigin}/password`
                  : "/password",
                "identified=1; HttpOnly; SameSite=Strict; Path=/",
              );
          };
          if (mode === "delayed") releaseFirst = next;
          else next();
          receivedFirst();
          return;
        }
        const valid =
          fields.password === password &&
          (path === "/login"
            ? fields.username === username
            : path === "/password" &&
              /(?:^|;\s*)identified=1(?:;|$)/.test(
                request.headers.cookie ?? "",
              ));
        redirect(
          response,
          valid ? "/account" : "/denied",
          valid
            ? "session=fixture-session; HttpOnly; SameSite=Strict; Path=/"
            : undefined,
        );
        receivedFirst();
      });
      return;
    }
    if (path === "/login") {
      const initial = form(
        mode === "combined" ? "combined" : "identifier",
        mode === "combined" ? "/login" : "/identifier",
      );
      // Render the second step after a real POST, but deliberately retain the
      // document (and even change its URL). This must not authorize step two.
      const script =
        mode === "same-document"
          ? `<script>
        document.querySelector('form').addEventListener('submit', async event => {
          event.preventDefault();
          const form = event.currentTarget;
          await fetch(form.action, { method: 'POST', body: new URLSearchParams(new FormData(form)) });
          history.pushState({}, '', '/password');
          document.body.innerHTML = ${JSON.stringify(form("password", "/password"))};
          document.body.dataset.sameDocument = 'ready';
        });
      </script>`
          : "";
      html(response, initial + script);
    } else if (path === "/password")
      html(response, form("password", "/password"));
    else if (path === "/account")
      html(
        response,
        /(?:^|;\s*)session=fixture-session(?:;|$)/.test(
          request.headers.cookie ?? "",
        )
          ? `<data id="account" value="${account}">${account}</data>`
          : "Sign in required",
      );
    else if (path === "/frame")
      html(response, '<iframe title="Login" src="/login"></iframe>');
    else if (path === "/launcher" || path === "/other-launcher")
      html(
        response,
        "<button id=\"open\" onclick=\"window.open('/login', '_blank', 'popup,width=600,height=600')\">Open login</button>",
      );
    else response.writeHead(404).end();
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  return {
    origin,
    posts,
    firstPost,
    release() {
      releaseFirst?.();
      releaseFirst = undefined;
    },
    async close() {
      releaseFirst?.();
      const closed = new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
      server.closeAllConnections();
      await closed;
    },
  };
}

async function status(ui: Page, pattern: RegExp) {
  await ui.waitForFunction(
    ({ source, flags }) =>
      new RegExp(source, flags).test(
        document.querySelector("#status")?.textContent ?? "",
      ),
    { source: pattern.source, flags: pattern.flags },
    { timeout: deadline },
  );
  assert.match(await ui.locator("#status").innerText(), pattern);
  assert.equal(
    await ui.locator("#cancel").isVisible(),
    true,
    "Cancel remains visible",
  );
}

async function storageHasNoCredentials(worker: Worker) {
  const clean = await worker.evaluate(`(async () => {
    const values = await Promise.all(['session', 'local', 'sync'].map(area => chrome.storage[area].get(null)));
    const serialized = JSON.stringify(values);
    return !globalThis.__multistepCredentialWrite &&
      !${JSON.stringify([username, password])}.some(secret => serialized.includes(secret));
  })()`);
  assert.equal(
    clean,
    true,
    "No synthetic credential value in storage or observed storage writes",
  );
}

async function browser(extension: string) {
  const profile = await mkdtemp(join(tmpdir(), "ceremony-multistep-profile-"));
  let context: BrowserContext | undefined;
  try {
    context = await chromium.launchPersistentContext(profile, {
      channel: "chromium",
      headless: true,
      args: [
        `--disable-extensions-except=${extension}`,
        `--load-extension=${extension}`,
      ],
    });
    context.setDefaultTimeout(deadline);
    context.setDefaultNavigationTimeout(deadline);
    // Pages only contact owned listeners; the deterministic extension path
    // never clicks inference or needs a model download.
    await context.route(/^https?:/, (route) =>
      new URL(route.request().url()).hostname === "127.0.0.1"
        ? route.continue()
        : route.abort(),
    );
    const worker =
      context
        .serviceWorkers()
        .find((candidate) => candidate.url().endsWith("/worker.js")) ??
      (await context.waitForEvent("serviceworker"));
    // Observe transient writes as well as terminal snapshots. Do not drive
    // inspect/submit/cancel via RPC or replace extension implementations.
    await worker.evaluate(`(() => {
      globalThis.__multistepCredentialWrite = false;
      chrome.storage.onChanged.addListener(changes => {
        if (${JSON.stringify([username, password])}.some(secret => JSON.stringify(changes).includes(secret)))
          globalThis.__multistepCredentialWrite = true;
      });
    })()`);
    const opened = context.waitForEvent("page");
    await worker.evaluate(
      `chrome.tabs.create({ url: chrome.runtime.getURL('ui.html') })`,
    );
    const ui = await opened;
    await ui.waitForLoadState("domcontentloaded");
    assert.match(ui.url(), /^chrome-extension:\/\/[^/]+\/ui\.html$/);
    assert.equal(
      await ui.locator("#multistep").isChecked(),
      false,
      "Multistep must be opt-in",
    );
    assert.equal(await ui.locator("#frame-id").inputValue(), "0");
    assert.equal(await ui.locator("#popup-url").inputValue(), "");
    assert.equal(await ui.locator("#cancel").isVisible(), true);
    const tab = await context.newPage();
    return {
      context,
      tab,
      ui,
      worker,
      async close() {
        try {
          await context?.close();
        } finally {
          await rm(profile, { recursive: true, force: true });
        }
      },
    };
  } catch (error) {
    await context?.close();
    await rm(profile, { recursive: true, force: true });
    throw error;
  }
}
type Browser = Awaited<ReturnType<typeof browser>>;

async function configure(
  b: Browser,
  target: string,
  profile = "owned-fixture-login",
) {
  await b.ui.locator("#target").fill(target);
  await b.ui.locator("#multistep").check();
  await b.ui.locator("#profile").selectOption(profile);
  if (profile === "owned-fixture-login")
    await b.ui.locator("#expected-account").fill(account);
}

async function inspectAndApprove(b: Browser) {
  await b.ui.locator("#inspect").click();
  await b.ui.locator("#review").waitFor({ state: "visible" });
  assert.equal(await b.ui.locator("#cancel").isVisible(), true);
  await b.ui.locator("#username").fill(username);
  await b.ui.locator("#password").fill(password);
  await storageHasNoCredentials(b.worker);
  await b.ui.locator("#approve").click();
  await b.ui.waitForFunction(
    () =>
      (document.querySelector("#username") as HTMLInputElement).value === "" &&
      (document.querySelector("#password") as HTMLInputElement).value === "",
  );
  assert.equal(await b.ui.locator("#cancel").isVisible(), true);
}

function assertPosts(posts: Post[], split: boolean) {
  assert.deepEqual(
    posts,
    split
      ? [
          { path: "/identifier", fields: { username } },
          { path: "/password", fields: { password } },
        ]
      : [{ path: "/login", fields: { username, password } }],
  );
}
// Build once, then await subtests. Legacy E2Es build into shared directories;
// copying this checkout's sources to temporary build output prevents ZIP races
// even when the outer test runner runs other artifact tests concurrently.
test(
  "packaged multistep trusted UI contract (owned fixtures only)",
  { timeout: 240_000 },
  async (t) => {
    const root = fileURLToPath(new URL("../", import.meta.url));
    const staging = await mkdtemp(join(tmpdir(), "ceremony-multistep-build-"));
    try {
      await mkdir(join(staging, "scripts"));
      await Promise.all([
        cp(
          join(root, "scripts/build-extension.mjs"),
          join(staging, "scripts/build-extension.mjs"),
        ),
        cp(join(root, "extensions"), join(staging, "extensions"), {
          recursive: true,
        }),
        cp(join(root, "src"), join(staging, "src"), { recursive: true }),
        symlink(
          join(root, "node_modules"),
          join(staging, "node_modules"),
          "dir",
        ),
      ]);
      execFileSync(process.execPath, ["scripts/build-extension.mjs"], {
        cwd: staging,
        timeout: 60_000,
        stdio: "pipe",
      });
      const extension = join(staging, "extracted");
      execFileSync(
        "unzip",
        [
          "-q",
          join(
            staging,
            "examples/web/public/extension/ceremony-browser-login.zip",
          ),
          "-d",
          extension,
        ],
        { timeout: 15_000, stdio: "pipe" },
      );

      const scenario = async (
        mode: Mode,
        run: (
          b: Browser,
          site: Awaited<ReturnType<typeof fixture>>,
        ) => Promise<void>,
        redirectOrigin?: string,
      ) => {
        const site = await fixture(mode, redirectOrigin);
        let b: Browser | undefined;
        try {
          b = await browser(extension);
          await run(b, site);
          await storageHasNoCredentials(b.worker);
        } finally {
          site.release();
          try {
            await b?.close();
          } finally {
            await site.close();
          }
        }
      };

      for (const mode of ["combined", "split"] as const) {
        await t.test(
          `${mode}: one approval verifies the fixture with exactly ${mode === "split" ? 2 : 1} POSTs`,
          { timeout: 30_000 },
          () =>
            scenario(mode, async (b, site) => {
              const target = `${site.origin}/login`;
              await b.tab.goto(target);
              await configure(b, target);
              await inspectAndApprove(b);
              await status(b.ui, /Verified fixture account/);
              await b.tab.waitForURL(`${site.origin}/account`);
              assert.equal(
                await b.tab.locator("data#account").getAttribute("value"),
                account,
              );
              assert.equal(
                await b.ui.locator("#target").inputValue(),
                target,
                "Selection remains original URL",
              );
              await b.tab.waitForTimeout(quietWindow);
              assertPosts(site.posts, mode === "split");
              assert.equal(await b.ui.locator("#review").isVisible(), false);
            }),
        );
      }

      await t.test(
        "manual profile submits but does not claim fixture verification",
        { timeout: 30_000 },
        () =>
          scenario("combined", async (b, site) => {
            await b.tab.goto(`${site.origin}/login`);
            await configure(b, b.tab.url(), "manual");
            await inspectAndApprove(b);
            await status(b.ui, /Submitted/);
            await b.tab.waitForURL(`${site.origin}/account`);
            assert.equal(
              await b.tab.locator("data#account").getAttribute("value"),
              account,
            );
            await b.tab.waitForTimeout(quietWindow);
            assert.doesNotMatch(
              await b.ui.locator("#status").innerText(),
              /Verified fixture account/,
            );
            assertPosts(site.posts, false);
          }),
      );

      await t.test(
        "cancellation during the delayed first POST prevents password dispatch",
        { timeout: 30_000 },
        () =>
          scenario("delayed", async (b, site) => {
            await b.tab.goto(`${site.origin}/login`);
            await configure(b, b.tab.url());
            await inspectAndApprove(b);
            // A server-side latch, not a guessed delay: first POST is received but
            // its redirect has not been sent when the human cancels.
            await site.firstPost;
            await storageHasNoCredentials(b.worker);
            await b.ui.locator("#cancel").click();
            await status(b.ui, /Stopped/);
            site.release();
            await b.tab.waitForURL(`${site.origin}/password`);
            await b.tab.locator('input[name="password"]').waitFor();
            await b.tab.waitForTimeout(quietWindow);
            assert.deepEqual(site.posts, [
              { path: "/identifier", fields: { username } },
            ]);
            assert.equal(
              await b.tab.locator('input[name="password"]').inputValue(),
              "",
            );
            assert.match(await b.ui.locator("#status").innerText(), /Stopped/);
            assert.equal(await b.ui.locator("#review").isVisible(), false);
          }),
      );

      await t.test(
        "cross-origin redirect never receives the password",
        { timeout: 30_000 },
        async () => {
          const other = await fixture("combined");
          try {
            await scenario(
              "redirect",
              async (b, site) => {
                await b.tab.goto(`${site.origin}/login`);
                await configure(b, b.tab.url());
                await inspectAndApprove(b);
                await b.tab.waitForURL(`${other.origin}/password`);
                await status(b.ui, /refused|origin/i);
                await b.tab.waitForTimeout(quietWindow);
                assert.deepEqual(site.posts, [
                  { path: "/identifier", fields: { username } },
                ]);
                assert.deepEqual(other.posts, []);
                assert.equal(
                  await b.tab.locator('input[name="password"]').inputValue(),
                  "",
                );
              },
              other.origin,
            );
          } finally {
            await other.close();
          }
        },
      );

      await t.test(
        "same-document password replacement and pushState cannot replay approval",
        { timeout: 30_000 },
        () =>
          scenario("same-document", async (b, site) => {
            await b.tab.goto(`${site.origin}/login`);
            await configure(b, b.tab.url());
            await inspectAndApprove(b);
            await b.tab.locator('body[data-same-document="ready"]').waitFor();
            assert.equal(b.tab.url(), `${site.origin}/password`);
            // Observe longer than the ordinary continuation polling interval, then
            // stop the run explicitly: URL changes alone are not new documents.
            await b.tab.waitForTimeout(2_000);
            assert.deepEqual(site.posts, [
              { path: "/identifier", fields: { username } },
            ]);
            assert.equal(
              await b.tab.locator('input[name="password"]').inputValue(),
              "",
            );
            assert.doesNotMatch(
              await b.ui.locator("#status").innerText(),
              /Verified fixture account/,
            );
            await b.ui.locator("#cancel").click();
            await status(b.ui, /Stopped/);
            await b.tab.waitForTimeout(quietWindow);
            assert.deepEqual(site.posts, [
              { path: "/identifier", fields: { username } },
            ]);
          }),
      );

      await t.test(
        "nonzero frame requires an explicit matching origin, then targets that frame only",
        { timeout: 40_000 },
        () =>
          scenario("combined", async (b, site) => {
            const target = `${site.origin}/frame`;
            await b.tab.goto(target);
            const child = b.tab
              .frames()
              .find((frame) => frame.url() === `${site.origin}/login`);
            assert.ok(child, "Owned iframe loaded");
            // Read Chromium's real frame ID, never assume the first iframe is 1.
            // The injected read is metadata discovery, not extension execution.
            const frames = (await b.worker.evaluate(`(async () => {
          const tabs = await chrome.tabs.query({});
          const tab = tabs.find(tab => tab.url === ${JSON.stringify(target)});
          return await chrome.scripting.executeScript({
            target: { tabId: tab.id, allFrames: true }, func: () => location.href
          });
        })()`)) as { frameId: number; result: string }[];
            const frameId = frames.find(
              (frame) => frame.result === `${site.origin}/login`,
            )?.frameId;
            assert.ok(frameId !== undefined && frameId > 0);
            for (const origin of ["", "http://127.0.0.1:1"]) {
              await b.ui.reload();
              await configure(b, target);
              await b.ui.locator("#frame-id").fill(String(frameId));
              await b.ui.locator("#frame-origin").fill(origin);
              await b.ui.locator("#inspect").click();
              await status(b.ui, /Operation refused|origin/i);
              assert.equal(await b.ui.locator("#review").isVisible(), false);
              assert.deepEqual(site.posts, []);
              assert.equal(
                await child.locator('input[name="username"]').inputValue(),
                "",
              );
              assert.equal(
                await child.locator('input[name="password"]').inputValue(),
                "",
              );
            }
            await b.ui.reload();
            await configure(b, target);
            await b.ui.locator("#frame-id").fill(String(frameId));
            await b.ui.locator("#frame-origin").fill(site.origin);
            await inspectAndApprove(b);
            await status(b.ui, /Verified fixture account/);
            await child.waitForURL(`${site.origin}/account`);
            assert.equal(
              await child.locator("data#account").getAttribute("value"),
              account,
            );
            assert.equal(
              b.tab.url(),
              target,
              "Top-level tab did not submit or navigate",
            );
            assert.equal(await b.ui.locator("#target").inputValue(), target);
            await b.tab.waitForTimeout(quietWindow);
            assertPosts(site.posts, false);
          }),
      );

      await t.test(
        "explicit already-open popup requires the original target as opener",
        { timeout: 40_000 },
        () =>
          scenario("combined", async (b, site) => {
            const target = `${site.origin}/launcher`;
            const popupUrl = `${site.origin}/login`;
            await b.tab.goto(target);
            const unrelated = await b.context.newPage();
            await unrelated.goto(`${site.origin}/other-launcher`);
            const wrongOpened = unrelated.waitForEvent("popup");
            await unrelated.locator("#open").click();
            const wrong = await wrongOpened;
            await wrong.waitForLoadState("domcontentloaded");
            assert.equal(await wrong.opener(), unrelated);
            await configure(b, target);
            await b.ui.locator("#popup-url").fill(popupUrl);
            await b.ui.locator("#inspect").click();
            await status(b.ui, /Operation refused|origin/i);
            assert.equal(await b.ui.locator("#review").isVisible(), false);
            assert.deepEqual(site.posts, []);
            assert.equal(
              await wrong.locator('input[name="password"]').inputValue(),
              "",
            );
            await wrong.close();
            await unrelated.close();

            const opened = b.tab.waitForEvent("popup");
            await b.tab.locator("#open").click();
            const popup = await opened;
            await popup.waitForLoadState("domcontentloaded");
            assert.equal(await popup.opener(), b.tab);
            await b.ui.reload();
            await configure(b, target);
            await b.ui.locator("#popup-url").fill(popupUrl);
            await inspectAndApprove(b);
            await status(b.ui, /Verified fixture account/);
            await popup.waitForURL(`${site.origin}/account`);
            assert.equal(
              await popup.locator("data#account").getAttribute("value"),
              account,
            );
            assert.equal(b.tab.url(), target);
            assert.equal(await b.ui.locator("#target").inputValue(), target);
            await b.tab.waitForTimeout(quietWindow);
            assertPosts(site.posts, false);
          }),
      );
    } finally {
      await rm(staging, { recursive: true, force: true });
    }
  },
);
