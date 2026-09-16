import assert from "node:assert/strict";
import { createServer } from "node:http";
import { test } from "node:test";
import { chromium } from "playwright-core";
import {
  allowedAuthorizationOrigin,
  createAuthorizationBrowser,
  type IsolatedAccount,
} from "../src/server/browser-executor.js";
import type {
  InterpreterAction,
  InterpreterInput,
} from "../src/server/isolated-account-interpreter.js";

for (const fault of ["vault", "context", "init", "page", "cdp"] as const)
  test(`browser setup releases its resources and returns a safe retryable result after ${fault} failure`, async (t) => {
    const browser = await chromium.launch({ headless: true });
    t.after(() => browser.close());
    let released = 0;
    let contexts = 0;
    let closedContexts = 0;
    const fail = async () => {
      throw new Error("synthetic private setup diagnostic");
    };
    const newContext = browser.newContext.bind(browser);
    t.mock.method(browser, "newContext", async () => {
      if (fault === "context") return fail();
      const context = await newContext();
      contexts++;
      context.on("close", () => closedContexts++);
      if (fault === "init") t.mock.method(context, "addInitScript", fail);
      if (fault === "page") t.mock.method(context, "newPage", fail);
      if (fault === "cdp") t.mock.method(context, "newCDPSession", fail);
      return context;
    });
    const executor = createAuthorizationBrowser({
      open: async () => ({
        browser,
        close: async () => {
          released++;
          await browser.close();
        },
      }),
    });
    const result = await executor.complete({
      sessionKey: "failed-setup",
      startUrl: "http://127.0.0.1:1/login",
      redirectUri: "http://127.0.0.1:1/callback",
      allowedOrigins: ["http://127.0.0.1:1"],
      ...(fault === "vault"
        ? { vault: { get: fail, put: async () => {} } }
        : {}),
    });
    assert.deepEqual(result, {
      status: "blocked",
      reason: "browser-unavailable",
    });
    assert.equal(released, 1);
    assert.equal(closedContexts, contexts);
    assert.equal(browser.isConnected(), false);
    assert.equal(await executor.interact?.("failed-setup", {}), false);
  });

for (const fails of [false, true])
  test(`generated credentials are staged before registration and never published before verification (storage failure: ${fails})`, async (t) => {
    let staged:
      { username: string; password: string; email?: string } | undefined;
    let posts = 0;
    let stagedBeforePost = false;
    const provider = await listen({
      onSignup: () => {
        posts++;
        stagedBeforePost = Boolean(staged?.password);
        return "challenge";
      },
    });
    t.after(() => provider.close());
    const browser = await chromium.launch();
    t.after(() => browser.close());
    const executor = createAuthorizationBrowser({
      open: async () => ({ browser, close: async () => {} }),
    });
    t.after(() => executor.close?.("staged-registration"));
    let published = false;
    const input = {
      sessionKey: "staged-registration",
      startUrl: `${provider.origin}/signup`,
      redirectUri: `${provider.origin}/callback`,
      allowedOrigins: [provider.origin],
      preferredUsername: "chosen@example.test",
      generateAccount: true,
      timeoutMs: 3000,
      vault: {
        get: async () => undefined,
        stage: async (account: {
          username: string;
          password: string;
          email?: string;
        }) => {
          if (fails) throw new Error("synthetic private storage failure");
          staged = account;
        },
        put: async () => {
          published = true;
        },
      },
    };
    const result = await executor.complete(input);
    assert.equal(result.status, "blocked");
    assert.equal(posts, fails ? 0 : 1);
    assert.equal(stagedBeforePost, !fails);
    assert.equal(published, false);
    assert.equal(result.accountStored, undefined);
    if (!fails) {
      assert.equal(staged?.email, "chosen@example.test");
      await executor.close?.("staged-registration");
      const restarted = createAuthorizationBrowser({
        open: async () => {
          throw new Error("Expired sessions must not open another browser");
        },
      });
      assert.deepEqual(
        await restarted.complete({ ...input, resumeSession: true }),
        { status: "blocked", reason: "session-expired" },
      );
      assert.equal(posts, 1);
    }
  });

for (const inferred of [false, true]) {
  test(`email sign-in preserves the full identifier (${inferred ? "inferred" : "deterministic"})`, async (t) => {
    let received: string | null = null;
    const provider = await listen({
      onLogin: (form) => {
        received = form.get("username");
      },
    });
    t.after(() => provider.close());
    const browser = await chromium.launch();
    t.after(() => browser.close());
    const executor = createAuthorizationBrowser({
      open: async () => ({ browser, close: async () => {} }),
      ...(inferred ? { interpreter: scriptedInterpreter() } : {}),
    });
    const result = await executor.complete({
      startUrl: `${provider.origin}/login`,
      redirectUri: `${provider.origin}/callback`,
      allowedOrigins: [provider.origin],
      credentials: {
        username: "chosen@example.test",
        password: "synthetic-password",
      },
    });
    assert.notEqual(result.status, "blocked");
    assert.equal(received, "chosen@example.test");
  });
  test(`selected registration email uses human verification instead of another inbox (${inferred ? "inferred" : "deterministic"})`, async (t) => {
    const emails: string[] = [];
    const provider = await listen({
      onSignup: () => "verify",
      onVerify: () => true,
      seenEmails: emails,
    });
    t.after(() => provider.close());
    const browser = await chromium.launch();
    t.after(() => browser.close());
    let provisioned = 0;
    let storedEmail: string | undefined;
    const executor = createAuthorizationBrowser({
      open: async () => ({ browser, close: async () => {} }),
      ...(inferred ? { interpreter: scriptedInterpreter() } : {}),
    });
    t.after(() => executor.close?.("chosen-email"));
    const input = {
      sessionKey: "chosen-email",
      startUrl: `${provider.origin}/signup`,
      redirectUri: `${provider.origin}/callback`,
      allowedOrigins: [provider.origin],
      preferredUsername: "chosen@example.test",
      generateAccount: true,
      inbox: {
        provision: async () => {
          provisioned++;
          return "different@agent.test";
        },
        latest: async () => undefined,
      },
      vault: {
        get: async () => undefined,
        put: async (account: { email?: string }) => {
          storedEmail = account.email;
        },
      },
    };
    const pending = await executor.complete(input);
    assert.deepEqual(emails, ["chosen@example.test"]);
    assert.equal(provisioned, 0);
    assert.equal(pending.status, "blocked");
    if (pending.status === "blocked")
      assert.equal(pending.reason, "verification");
    assert.equal(pending.sessionPending, true);
    assert.equal(storedEmail, undefined);
    assert.equal(
      await executor.interact?.("chosen-email", { code: "123456" }),
      true,
    );
    const result = await executor.complete({ ...input, resumeSession: true });
    assert.notEqual(
      result.status,
      "blocked",
      result.status === "blocked" ? result.reason : undefined,
    );
    assert.equal(storedEmail, "chosen@example.test");
    assert.equal(emails.length, 1);
  });
}

for (const [kind, markup, label] of [
  [
    "quoted ID",
    `<label for='account"owner'>Account choice</label><input id='account"owner' name="account_choice">`,
    "Account choice",
  ],
  [
    "wrapping label",
    '<label>Account choice<input name="account_choice"></label>',
    "Account choice",
  ],
  [
    "ARIA precedence",
    '<label>Wrapping label<input name="account_choice" aria-label="ARIA account"></label>',
    "ARIA account",
  ],
] as const)
  test(`inference receives native field labels without selector interpolation (${kind})`, async (t) => {
    let submissions = 0;
    const provider = await listen({
      signupFields: markup,
      onSignup: () => {
        submissions++;
        return "plain";
      },
    });
    t.after(() => provider.close());
    const browser = await chromium.launch();
    t.after(() => browser.close());
    const snapshots: InterpreterInput[] = [];
    const executor = createAuthorizationBrowser({
      open: async () => ({ browser, close: async () => {} }),
      interpreter: async (input) => {
        snapshots.push(input);
        return {
          action: "blocked",
          reason: "required-input",
          note: "The account choice needs a human",
        };
      },
    });
    const result = await executor.complete({
      startUrl: `${provider.origin}/signup`,
      redirectUri: `${provider.origin}/callback`,
      allowedOrigins: [provider.origin],
      timeoutMs: 3000,
    });
    assert.equal(snapshots.length, 1);
    assert.equal(
      snapshots[0]?.snapshot.elements.find(
        (element) => element.name === "account_choice",
      )?.label,
      label,
    );
    assert.deepEqual(result, { status: "blocked", reason: "required-input" });
    assert.equal(submissions, 0);
  });

/** Scripted stand-in for a model: acts only on the sanitized snapshot. */
function scriptedInterpreter(captured?: InterpreterInput[]) {
  return async (
    input: InterpreterInput,
  ): Promise<InterpreterAction | undefined> => {
    captured?.push(input);
    const { snapshot, history } = input;
    const did = (note: string) => history.some((h) => h.note === note);
    const find = (
      pred: (element: (typeof snapshot.elements)[number]) => boolean,
    ) => snapshot.elements.find(pred);
    const code = find(
      (e) =>
        e.kind === "input" &&
        /code|otp|verif/i.test(
          `${e.name ?? ""}${e.label ?? ""}${e.placeholder ?? ""}`,
        ),
    );
    if (code && !did("fill-code"))
      return {
        action: "fill",
        element: code.index,
        role: "verification-code",
        note: "fill-code",
      };
    const email = find((e) => e.kind === "input" && e.type === "email");
    if (email && !did("fill-email"))
      return {
        action: "fill",
        element: email.index,
        role: "email",
        note: "fill-email",
      };
    const user = find(
      (e) => e.kind === "input" && /user|handle/i.test(e.name ?? ""),
    );
    if (user && !did("fill-username"))
      return {
        action: "fill",
        element: user.index,
        role: "username",
        note: "fill-username",
      };
    const password = find((e) => e.kind === "input" && e.type === "password");
    if (password && !did("fill-password"))
      return {
        action: "fill",
        element: password.index,
        role: "password",
        note: "fill-password",
      };
    const checkbox = find((e) => e.kind === "checkbox");
    if (checkbox && !did("check-box"))
      return { action: "check", element: checkbox.index, note: "check-box" };
    const consent = find(
      (e) =>
        e.kind === "button" && /authorize|allow|approve/i.test(e.text ?? ""),
    );
    if (consent && !did("approve"))
      return { action: "click", element: consent.index, note: "approve" };
    const submit = find((e) => e.kind === "button");
    if (submit && !did(`submit-${submit.text ?? ""}`))
      return {
        action: "click",
        element: submit.index,
        note: `submit-${submit.text ?? ""}`,
      };
    return { action: "blocked", note: "nothing actionable" };
  };
}

async function listen(
  hooks: {
    onSignup?: (
      email: string,
    ) =>
      | "in-use"
      | "username-in-use"
      | "challenge"
      | "verify"
      | "mail"
      | "plain"
      | "uncertain"
      | "authenticated";
    onVerify?: (code: string) => boolean;
    verifyAtSignup?: boolean;
    seenEmails?: string[];
    signupFields?: string;
    seenSignups?: URLSearchParams[];
    onLogin?: (form: URLSearchParams) => void;
    loginTarget?: string;
    loginBlankPopup?: boolean;
    loginPreopenTarget?: boolean;
    loginRedirect?: { status: 307 | 308; location: string };
    onRequest?: (url: URL, method: string) => void;
    reflectCredentials?: boolean;
    initialTitle?: string;
    observePasswordInput?: boolean;
    unavailable?: () => boolean;
  } = {},
) {
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    hooks.onRequest?.(url, req.method ?? "GET");
    if (req.method === "POST") {
      let body = "";
      req.on("data", (chunk) => {
        body += chunk;
      });
      req.on("end", () => route(url, body));
    } else route(url, "");
    function route(parsed: URL, body: string) {
      const url = parsed;
      if (url.pathname === "/passkey") {
        res
          .writeHead(200, { "content-type": "text/html" })
          .end("<h1>Use your passkey</h1><button>Try another method</button>");
        return;
      }
      if (url.pathname === "/authenticator-request") {
        res
          .writeHead(200, { "content-type": "text/html" })
          .end(
            "<h1>Verify your identity</h1><script>navigator.credentials.get({publicKey:{challenge:new Uint8Array(32),timeout:1000}}).catch(()=>{});</script>",
          );
        return;
      }
      if (
        req.method === "GET" &&
        url.pathname === "/login" &&
        hooks.unavailable?.()
      ) {
        res.writeHead(503).end("Temporarily unavailable");
        return;
      }
      if (url.pathname === "/authorize") {
        res.writeHead(302, {
          location: url.searchParams.get("next") ?? "/login",
        });
        res.end();
        return;
      }
      if (url.pathname === "/identify") {
        res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
        res.end(`<!doctype html><form method="post" action="/login">
        <input type="email" name="email" autocomplete="username">
        <button type="submit">Continue</button>
      </form>`);
        return;
      }
      if (url.pathname === "/login" && req.method === "GET") {
        res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
        res.end(`<!doctype html><title>${hooks.initialTitle ?? ""}</title><form method="post" action="/login" ${hooks.loginTarget ? `target="${hooks.loginTarget}"` : ""} ${hooks.loginBlankPopup ? `onsubmit="window.open('about:blank'); return false"` : ""}>
        <input name="username" autocomplete="username">
        <input name="password" type="password" ${hooks.observePasswordInput ? 'data-cmy-idx="1" autocomplete="one-time-code" oninput="window.__fixtureCapture(this.value)"' : ""}>
        <button type="submit">Sign in</button>
      </form>${hooks.loginPreopenTarget ? `<script>window.open('about:blank', ${JSON.stringify(hooks.loginTarget)});</script>` : ""}`);
        return;
      }
      if (url.pathname === "/login" && req.method === "POST") {
        hooks.onLogin?.(new URLSearchParams(body));
        if (hooks.loginRedirect) {
          res
            .writeHead(hooks.loginRedirect.status, {
              location: hooks.loginRedirect.location,
            })
            .end();
          return;
        }
        if (hooks.reflectCredentials) {
          const password = new URLSearchParams(body).get("password")!;
          res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
          res.end(`<!doctype html><title>${password}</title>
            <div role="alert">Rejected ${password}</div>
            <label for="retry">Password ${password}</label>
            <input id="retry" name="password" type="password" placeholder="${password}">
            <button>${password}</button>`);
          return;
        }
        res.writeHead(302, { location: "/consent" });
        res.end();
        return;
      }
      if (url.pathname === "/consent") {
        res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
        res.end(`<!doctype html><form action="/approve" method="post">
        <button type="submit">Authorize</button>
      </form>`);
        return;
      }
      if (url.pathname === "/approve") {
        res.writeHead(302, {
          location: `http://${req.headers.host}/callback?code=fixture-code&state=fixture`,
        });
        res.end();
        return;
      }
      if (url.pathname === "/signup" && req.method === "GET") {
        res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
        res.end(`<!doctype html><title>${hooks.initialTitle ?? ""}</title><form method="post" action="/signup">
        <input type="email" name="email" autocomplete="email">
        <input name="password" type="password">
        ${hooks.signupFields ?? ""}
        <button type="submit">Create account</button>
      </form>`);
        return;
      }
      if (url.pathname === "/signup" && req.method === "POST") {
        hooks.seenSignups?.push(new URLSearchParams(body));
        const email = new URLSearchParams(body).get("email") ?? "";
        hooks.seenEmails?.push(email);
        const outcome = hooks.onSignup?.(email) ?? "plain";
        if (outcome === "uncertain") {
          res.writeHead(204).end();
          return;
        }
        if (outcome === "authenticated") {
          res
            .writeHead(200, { "content-type": "text/html" })
            .end('<main data-authenticated="true">Account verified</main>');
          return;
        }
        if (outcome === "mail") {
          res
            .writeHead(200, { "content-type": "text/html" })
            .end("<p>Check your email to confirm this account.</p>");
          return;
        }
        if (outcome === "in-use" || outcome === "username-in-use") {
          res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
          res.end(
            `<!doctype html><main>That ${outcome === "in-use" ? "email" : "username"} is already in use.</main>`,
          );
          return;
        }
        if (outcome === "challenge") {
          res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
          res.end(
            '<!doctype html><div class="h-captcha"><button style="position:fixed;top:0;left:0;width:200px;height:80px" onclick="location.href=\'/login\'">Fixture human challenge</button></div>',
          );
          return;
        }
        if (outcome === "verify") {
          res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
          const password = new URLSearchParams(body)
            .get("password")!
            .replace(/[&<>"']/g, (value) => `&#${value.charCodeAt(0)};`);
          res.end(`<!doctype html><form method="post" action="${hooks.verifyAtSignup ? "/signup" : "/verify"}">
        ${hooks.verifyAtSignup ? `<input type="hidden" name="email" value="${email.replace(/[<>&"]/g, "")}"><input type="hidden" name="password" value="${password}">` : ""}
        <p>We sent a verification code to ${email.replace(/[<>&"]/g, "")}.</p>
        <input name="code" autocomplete="one-time-code" inputmode="numeric">
        <button type="submit">Verify</button>
      </form>`);
          return;
        }
        res.writeHead(302, { location: "/login" });
        res.end();
        return;
      }
      if (url.pathname === "/verify" && req.method === "POST") {
        const code = new URLSearchParams(body).get("code") ?? "";
        if (hooks.onVerify?.(code) ?? code === "246810") {
          res.writeHead(302, { location: "/login" });
          res.end();
          return;
        }
        res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
        res.end(`<!doctype html><form method="post" action="/verify">
        <p>Wrong code, try again.</p>
        <input name="code" autocomplete="one-time-code" inputmode="numeric">
        <button type="submit">Verify</button>
      </form>`);
        return;
      }
      if (url.pathname === "/picky") {
        res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
        res.end(`<!doctype html><div class="alert-danger">These credentials do not match our records.</div><form method="post" action="/picky">
        <input name="username" autocomplete="username">
        <input name="password" type="password">
        <button type="submit">Sign in</button>
      </form>`);
        return;
      }
      if (url.pathname === "/plain") {
        res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
        res.end("<!doctype html><main>Nothing to fill in here.</main>");
        return;
      }
      if (url.pathname === "/callback") {
        res.writeHead(200, { "content-type": "text/plain" }).end("ok");
        return;
      }
      res.writeHead(404).end();
    }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("no port");
  return {
    origin: `http://127.0.0.1:${address.port}`,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

function inboxStub() {
  const messages: Array<{ to: string; text: string; at: number }> = [];
  let counter = 0;
  return {
    messages,
    inbox: {
      provision: async () => {
        counter += 1;
        return `agent-${counter}@inbox.test`;
      },
      latest: async (to: string, since: number) =>
        messages
          .filter((message) => message.to === to && message.at >= since)
          .sort((left, right) => right.at - left.at)[0],
    },
    send(to: string, text: string) {
      messages.push({ to, text, at: Date.now() });
    },
  };
}

test("inference-driven sign-in captures the callback from snapshot actions only", async (t) => {
  const provider = await listen();
  t.after(() => provider.close());
  const browser = await chromium.launch({ headless: true });
  t.after(() => browser.close());
  const captured: InterpreterInput[] = [];
  const executor = createAuthorizationBrowser({
    open: async () => ({ browser, close: async () => {} }),
    interpreter: scriptedInterpreter(captured),
  });
  const result = await executor.complete({
    startUrl: `${provider.origin}/authorize`,
    redirectUri: `${provider.origin}/callback`,
    allowedOrigins: [provider.origin],
    credentials: { username: "agent", password: "secret" },
    timeoutMs: 15_000,
  });
  assert.equal(result.status, "callback");
  if (result.status === "callback")
    assert.match(result.url, /code=fixture-code/);
  const prompts = JSON.stringify(captured);
  assert.ok(
    captured.length > 0,
    "The interpreter must actually receive snapshots",
  );
  assert.equal(prompts.includes("secret"), false);
  assert.equal(prompts.includes("fixture-code"), false);
});

test("authentication sessions never request video recording", async (t) => {
  const provider = await listen();
  t.after(() => provider.close());
  const browser = await chromium.launch({ headless: true });
  t.after(() => browser.close());
  const newContext = browser.newContext.bind(browser);
  let recordingRequested = false;
  browser.newContext = async (options) => {
    assert.equal(options?.serviceWorkers, "block");
    recordingRequested ||= Boolean(options?.recordVideo);
    return newContext(options);
  };
  const executor = createAuthorizationBrowser({
    open: async () => ({ browser, close: async () => {} }),
  });
  const result = await executor.complete({
    startUrl: `${provider.origin}/login`,
    redirectUri: `${provider.origin}/callback`,
    allowedOrigins: [provider.origin],
    credentials: { username: "agent", password: "synthetic-secret" },
    timeoutMs: 15_000,
  });
  assert.equal(result.status, "callback");
  assert.equal(recordingRequested, false);
  assert.equal(result.capturePath, undefined);
});

for (const server of [
  undefined,
  "socks5://vetted-proxy.example:8080",
  "http://synthetic-user@vetted-proxy.example:8080",
  "http://:synthetic-password@vetted-proxy.example:8080",
])
  test(`remote proxy rejects unsafe configuration before contacting a vendor (${server ?? "missing"})`, async (t) => {
    let vendorRequests = 0;
    let browserConnections = 0;
    let localLaunches = 0;
    t.mock.method(globalThis, "fetch", async () => {
      vendorRequests++;
      return new Response(null, { status: 503 });
    });
    t.mock.method(chromium, "connectOverCDP", async () => {
      browserConnections++;
      throw new Error("Unexpected browser connection");
    });
    t.mock.method(chromium, "launch", async () => {
      localLaunches++;
      throw new Error("Unexpected local fallback");
    });
    const executor = createAuthorizationBrowser({
      browserbase: { apiKey: "synthetic-key", projectId: "synthetic-project" },
      ...(server ? { remoteProxy: { server } } : {}),
    });
    assert.deepEqual(
      await executor.complete({
        startUrl: "https://provider.example/login",
        redirectUri: "https://host.example/callback",
        allowedOrigins: ["https://provider.example"],
      }),
      { status: "blocked", reason: "browser-unavailable" },
    );
    assert.equal(vendorRequests, 0);
    assert.equal(browserConnections, 0);
    assert.equal(localLaunches, 0);
  });

test("remote proxy does not fall back locally when the vendor is unavailable", async (t) => {
  let vendorRequests = 0;
  let localLaunches = 0;
  t.mock.method(globalThis, "fetch", async () => {
    vendorRequests++;
    return new Response(null, { status: 503 });
  });
  t.mock.method(chromium, "launch", async () => {
    localLaunches++;
    throw new Error("Unexpected local fallback");
  });
  const executor = createAuthorizationBrowser({
    browserbase: { apiKey: "synthetic-key", projectId: "synthetic-project" },
    remoteProxy: { server: "https://vetted-proxy.example:8443" },
  });
  assert.deepEqual(
    await executor.complete({
      startUrl: "https://provider.example/login",
      redirectUri: "https://host.example/callback",
      allowedOrigins: ["https://provider.example"],
    }),
    { status: "blocked", reason: "browser-unavailable" },
  );
  assert.equal(vendorRequests, 1);
  assert.equal(localLaunches, 0);
});

for (const proxyServer of [
  "http://vetted-proxy.example:8080",
  "https://vetted-proxy.example:8443",
])
  test(`remote auth sessions disable vendor recording, logging and CAPTCHA outsourcing (${proxyServer})`, async (t) => {
    const provider = await listen();
    t.after(() => provider.close());
    const browser = await chromium.launch({ headless: true });
    t.after(() => browser.close());
    const newContext = browser.newContext.bind(browser);
    let proxied = false;
    browser.newContext = async (options) => {
      assert.deepEqual(options?.proxy, {
        server: proxyServer,
        bypass: "<-loopback>",
      });
      proxied = true;
      // This synthetic remote transport uses the local provider fixture directly.
      const { proxy: _proxy, ...localOptions } = options ?? {};
      return newContext(localOptions);
    };
    let request: unknown;
    t.mock.method(
      globalThis,
      "fetch",
      async (url: string, init: RequestInit) => {
        assert.equal(url, "https://api.browserbase.com/v1/sessions");
        assert.equal(init.method, "POST");
        request = JSON.parse(String(init.body));
        return Response.json({
          connectUrl: "wss://synthetic-browser.example/session",
        });
      },
    );
    t.mock.method(chromium, "connectOverCDP", async (url: string) => {
      assert.equal(url, "wss://synthetic-browser.example/session");
      return browser;
    });
    const executor = createAuthorizationBrowser({
      browserbase: { apiKey: "synthetic-key", projectId: "synthetic-project" },
      remoteProxy: { server: proxyServer },
    });
    const result = await executor.complete({
      startUrl: `${provider.origin}/login`,
      redirectUri: `${provider.origin}/callback`,
      allowedOrigins: [provider.origin],
      credentials: { username: "agent", password: "synthetic-secret" },
      timeoutMs: 15_000,
    });
    assert.equal(result.status, "callback");
    assert.equal(proxied, true);
    assert.deepEqual(request, {
      projectId: "synthetic-project",
      browserSettings: {
        recordSession: false,
        logSession: false,
        solveCaptchas: false,
      },
    });
  });

for (const source of ["supplied", "vault", "inbox"] as const)
  test(`known credentials are redacted before the first agent action (${source})`, async (t) => {
    const credentials = {
      username: "synthetic-owner",
      password: "synthetic/password+private",
      email: "synthetic-owner@fixture.test",
    };
    const secrets =
      source === "inbox" ? ["agent-1@inbox.test"] : Object.values(credentials);
    const provider = await listen({
      initialTitle: secrets.join(" | "),
      onSignup: () => "challenge",
    });
    t.after(() => provider.close());
    const browser = await chromium.launch({ headless: true });
    t.after(() => browser.close());
    const captured: InterpreterInput[] = [];
    const executor = createAuthorizationBrowser({
      open: async () => ({ browser, close: async () => {} }),
      interpreter: scriptedInterpreter(captured),
    });
    const result = await executor.complete({
      startUrl: `${provider.origin}/${source === "inbox" ? "signup" : "login"}`,
      redirectUri: `${provider.origin}/callback`,
      allowedOrigins: [provider.origin],
      ...(source === "supplied" ? { credentials } : {}),
      ...(source === "vault"
        ? { vault: { get: async () => credentials, put: async () => {} } }
        : {}),
      ...(source === "inbox"
        ? { generateAccount: true, inbox: inboxStub().inbox }
        : {}),
      timeoutMs: 15_000,
    });
    assert.equal(result.status, source === "inbox" ? "blocked" : "callback");
    if (result.status === "blocked") assert.equal(result.reason, "challenge");
    assert.ok(
      captured.length > 0,
      "The interpreter must receive the initial page",
    );
    assert.equal(
      captured[0]?.snapshot.title,
      secrets.map(() => "[private]").join(" | "),
    );
    for (const secret of secrets)
      assert.equal(JSON.stringify(captured).includes(secret), false);
  });

for (const inferred of [false, true])
  test(`provider-reflected credentials stay out of model snapshots and events (${inferred ? "inferred" : "deterministic"})`, async (t) => {
    const provider = await listen({ reflectCredentials: true });
    t.after(() => provider.close());
    const browser = await chromium.launch({ headless: true });
    t.after(() => browser.close());
    const captured: InterpreterInput[] = [];
    const events: string[] = [];
    const executor = createAuthorizationBrowser({
      open: async () => ({ browser, close: async () => {} }),
      ...(inferred ? { interpreter: scriptedInterpreter(captured) } : {}),
    });
    const password = "agent-synthetic/password+not-for-model-".repeat(8);
    const result = await executor.complete({
      startUrl: `${provider.origin}/login`,
      redirectUri: `${provider.origin}/callback`,
      allowedOrigins: [provider.origin],
      credentials: { username: "agent", password },
      onEvent: (event) => events.push(event),
      timeoutMs: 15_000,
    });
    assert.equal(result.status, "blocked");
    if (inferred) {
      const reflected = captured.find((input) => input.snapshot.alerts.length);
      assert.ok(reflected);
      assert.equal(reflected.snapshot.title, "[private]");
      assert.deepEqual(reflected.snapshot.alerts, ["Rejected [private]"]);
      assert.equal(reflected.snapshot.elements[0]?.placeholder, "[private]");
    }
    assert.equal(JSON.stringify(captured).includes(password), false);
    assert.equal(JSON.stringify(events).includes(password), false);
  });

test("inference-driven registration stores the account without secrets leaving the code boundary", async (t) => {
  const mailbox = inboxStub();
  const seenEmails: string[] = [];
  const provider = await listen({
    seenEmails,
    onSignup: (email) => {
      mailbox.send(
        email,
        "Your verification code is 246810. Enter it to continue.",
      );
      return "verify";
    },
  });
  t.after(() => provider.close());
  const browser = await chromium.launch({ headless: true });
  t.after(() => browser.close());
  const captured: InterpreterInput[] = [];
  const executor = createAuthorizationBrowser({
    open: async () => ({ browser, close: async () => {} }),
    interpreter: scriptedInterpreter(captured),
  });
  let stored:
    { username: string; password: string; email?: string } | undefined;
  const result = await executor.complete({
    startUrl: `${provider.origin}/signup`,
    startUrls: [`${provider.origin}/signup`, `${provider.origin}/authorize`],
    redirectUri: `${provider.origin}/callback`,
    allowedOrigins: [provider.origin],
    generateAccount: true,
    inbox: mailbox.inbox,
    vault: {
      get: async () => undefined,
      put: async (account) => {
        stored = account;
      },
    },
    timeoutMs: 20_000,
  });
  assert.equal(result.status, "callback");
  assert.equal(result.accountStored, true);
  assert.ok(stored?.password);
  const prompts = JSON.stringify(captured);
  assert.ok(
    captured.length > 0,
    "The interpreter must actually receive snapshots",
  );
  assert.equal(prompts.includes(stored!.password), false);
  assert.equal(prompts.includes("agent-1@inbox.test"), false);
  assert.equal(prompts.includes("246810"), false);
});

for (const permanent of [false, true])
  test(`snapshot transport faults preserve inference state and stay bounded (permanent: ${permanent})`, async (t) => {
    let posts = 0;
    const provider = await listen({
      onLogin: () => {
        posts++;
      },
    });
    t.after(() => provider.close());
    const browser = await chromium.launch();
    t.after(() => browser.close());
    let snapshots = 0;
    const newContext = browser.newContext.bind(browser);
    t.mock.method(
      browser,
      "newContext",
      async (...args: Parameters<typeof newContext>) => {
        const context = await newContext(...args);
        const newPage = context.newPage.bind(context);
        t.mock.method(context, "newPage", async () => {
          const page = await newPage();
          const evaluate = page.evaluate.bind(page);
          t.mock.method(
            page,
            "evaluate",
            async (...args: Parameters<typeof evaluate>) => {
              if (
                typeof args[0] === "function" &&
                String(args[0]).includes("data-cmy-idx")
              ) {
                snapshots++;
                // A forbidden 25th inspection must fail the budget assertions,
                // not leave a mutated loop spinning in injected faults.
                if (permanent && snapshots > 24)
                  return {
                    title: "",
                    alerts: [],
                    challenge: true,
                    elements: [],
                  };
                if (permanent || snapshots <= 2)
                  throw new Error("synthetic-private-navigation-fault");
              }
              return Reflect.apply(evaluate, page, args);
            },
          );
          return page;
        });
        return context;
      },
    );
    const captured: InterpreterInput[] = [];
    const events: string[] = [];
    const executor = createAuthorizationBrowser({
      open: async () => ({ browser, close: async () => {} }),
      interpreter: scriptedInterpreter(captured),
    });
    const result = await executor.complete({
      startUrl: `${provider.origin}/login`,
      redirectUri: `${provider.origin}/callback`,
      allowedOrigins: [provider.origin],
      credentials: { username: "fixture-user", password: "fixture-password" },
      timeoutMs: 10_000,
      onEvent: (event) => events.push(event),
    });
    assert.equal(posts, permanent ? 0 : 1);
    if (permanent) {
      assert.deepEqual(result, {
        status: "blocked",
        reason: "timeout",
        accountStored: true,
      });
      assert.equal(snapshots, 24);
      assert.equal(captured.length, 0);
    } else {
      assert.equal(result.status, "callback");
      assert.ok(captured.length > 1);
      assert.ok(snapshots > 2);
    }
    assert.equal(
      JSON.stringify({ captured, events }).includes(
        "synthetic-private-navigation-fault",
      ),
      false,
    );
  });

for (const inspectionFault of [false, true])
  test(`inferred automatic form submission requires native account-completion evidence (inspection fault: ${inspectionFault})`, async (t) => {
    const submissions: URLSearchParams[] = [];
    const provider = await listen({
      signupFields: `<script>document.querySelector('input[type=password]').addEventListener('input', event => event.target.form.requestSubmit());</script>`,
      seenSignups: submissions,
      onSignup: () => "authenticated",
    });
    t.after(() => provider.close());
    const browser = await chromium.launch();
    t.after(() => browser.close());
    let injected = false;
    const newContext = browser.newContext.bind(browser);
    t.mock.method(browser, "newContext", async () => {
      const context = await newContext();
      const newPage = context.newPage.bind(context);
      t.mock.method(context, "newPage", async () => {
        const page = await newPage();
        const evaluate = page.evaluate.bind(page);
        t.mock.method(
          page,
          "evaluate",
          async (...args: Parameters<typeof evaluate>) => {
            if (
              inspectionFault &&
              !injected &&
              submissions.length &&
              String(args[0]).includes("__ceremonyAuthenticatorRequested")
            ) {
              injected = true;
              throw new Error(
                "Synthetic navigation interrupted authenticator inspection",
              );
            }
            return Reflect.apply(evaluate, page, args);
          },
        );
        return page;
      });
      return context;
    });
    const interpret = scriptedInterpreter();
    let waited = false;
    let stored = 0;
    const executor = createAuthorizationBrowser({
      open: async () => ({ browser, close: async () => {} }),
      interpreter: async (input) => {
        if (
          !waited &&
          input.history.some((item) => item.action === "fill password")
        ) {
          waited = true;
          await browser
            .contexts()[0]!
            .pages()[0]!
            .waitForSelector("[data-authenticated=true]");
          return { action: "wait" };
        }
        return interpret(input);
      },
    });
    const result = await executor.complete({
      startUrl: `${provider.origin}/signup`,
      redirectUri: `${provider.origin}/callback`,
      allowedOrigins: [provider.origin],
      preferredUsername: "chosen@fixture.test",
      generateAccount: true,
      accountOnly: true,
      timeoutMs: 10_000,
      vault: {
        get: async () => undefined,
        put: async () => {
          stored++;
        },
      },
    });
    assert.deepEqual(result, { status: "credentials", accountStored: true });
    assert.equal(stored, 1);
    assert.equal(submissions.length, 1);
    assert.equal(submissions[0]?.get("email"), "chosen@fixture.test");
    assert.ok(submissions[0]?.get("password"));
    assert.equal(injected, inspectionFault);
  });

for (const [kind, reason] of [
  ["sparse", "no-form"],
  ["password", "session"],
  ["password-confirm", "no-form"],
  ["verification-code", "verification"],
  ["required-input", "required-input"],
  ["challenge", "challenge"],
] as const)
  test(`inferred action dispatch delegates safely (${kind})`, async (t) => {
    let posts = 0;
    const provider = await listen({
      signupFields: '<input name="private-answer" required>',
      onSignup: () => {
        posts++;
        return "plain";
      },
    });
    t.after(() => provider.close());
    const browser = await chromium.launch();
    t.after(() => browser.close());
    const actions: InterpreterAction[] =
      kind === "sparse"
        ? [
            { action: "wait" },
            { action: "click" },
            { action: "click", element: 999 },
            { action: "done" },
          ]
        : kind === "required-input"
          ? [{ action: "blocked", reason: "required-input" }]
          : kind === "challenge"
            ? [{ action: "blocked", note: "CAPTCHA needs the account owner" }]
            : [{ action: "fill", role: kind, element: 1 }, { action: "done" }];
    let calls = 0;
    const executor = createAuthorizationBrowser({
      open: async () => ({ browser, close: async () => {} }),
      interpreter: async ({ snapshot }) => {
        assert.equal(snapshot.elements[1]?.type, "password");
        return actions[calls++];
      },
    });
    t.after(() => executor.close?.("action-dispatch"));
    const result = await executor.complete({
      sessionKey: "action-dispatch",
      startUrl: `${provider.origin}/signup`,
      redirectUri: `${provider.origin}/callback`,
      allowedOrigins: [provider.origin],
      timeoutMs: 10_000,
    });
    assert.equal(result.status, "blocked");
    if (result.status === "blocked") assert.equal(result.reason, reason);
    assert.equal(
      calls,
      kind === "sparse" ? 4 : kind === "password-confirm" ? 2 : 1,
    );
    assert.equal(posts, 0);
    assert.equal(result.accountStored, undefined);
    if (kind === "required-input")
      assert.equal(
        await browser
          .contexts()[0]!
          .pages()[0]!
          .evaluate(() => document.activeElement?.getAttribute("name")),
        "private-answer",
      );
  });

for (const delivery of ["code", "link", "link-fallback", "late"] as const)
  test(`inferred inbox recovery preserves one registration (${delivery})`, async (t) => {
    const linked = delivery.startsWith("link");
    let registrations = 0;
    let polls = 0;
    let verificationPosts = 0;
    let ready = delivery !== "late";
    const provider = await listen({
      onSignup: () => {
        registrations++;
        return "verify";
      },
      onVerify: (code) => {
        verificationPosts++;
        return code === "246810";
      },
    });
    t.after(() => provider.close());
    const browser = await chromium.launch();
    t.after(() => browser.close());
    const secureOrigin = provider.origin.replace("http:", "https:");
    const fragment =
      delivery === "link"
        ? "synthetic-private-mail-fragment"
        : "claim=synthetic-private-mail-fragment";
    const privateLink = `${secureOrigin}/verify/synthetic-private-mail-%70ath?token=synthetic-private-mail-link#${fragment}`;
    let linkVisits = 0;
    if (linked) {
      const newContext = browser.newContext.bind(browser);
      t.mock.method(
        browser,
        "newContext",
        async (...args: Parameters<typeof newContext>) => {
          const context = await newContext(...args);
          const newPage = context.newPage.bind(context);
          t.mock.method(context, "newPage", async () => {
            const page = await newPage();
            await page.route(privateLink.split("#")[0]!, async (route) => {
              linkVisits++;
              await route.fulfill({
                contentType: "text/html",
                body: `<title>synthetic-private-mail-path synthetic-private-mail-%70ath</title>${delivery === "link-fallback" ? '<div class="h-captcha"><button style="position:fixed;top:0;left:0;width:200px;height:80px" onclick="this.parentElement.remove()">Fixture human challenge</button></div>' : ""}<button onclick="location.href='${provider.origin}/callback?code=fixture-code&amp;state=fixture'">Authorize synthetic-private-mail-link synthetic-private-mail-fragment</button>`,
              });
            });
            return page;
          });
          return context;
        },
      );
    }
    const snapshots: InterpreterInput[] = [];
    const events: string[] = [];
    let stored = 0;
    const interpret = scriptedInterpreter(snapshots);
    const executor = createAuthorizationBrowser({
      open: async () => ({ browser, close: async () => {} }),
      interpreter: async (input) =>
        delivery === "link-fallback" && !linkVisits
          ? undefined
          : interpret(input),
    });
    t.after(() => executor.close?.("inbox-recovery"));
    const input = {
      sessionKey: "inbox-recovery",
      startUrl: `${provider.origin}/signup`,
      redirectUri: `${provider.origin}/callback`,
      allowedOrigins: [provider.origin, secureOrigin],
      accountOnly: linked,
      generateAccount: true,
      timeoutMs: delivery === "late" ? 4000 : 10_000,
      onEvent: (event: string) => events.push(event),
      inbox: {
        provision: async () => "private-inbox@fixture.test",
        latest: async (to: string) => {
          polls++;
          if (polls === 1)
            throw new Error("Synthetic inbox transport interruption");
          if (!ready) return undefined;
          return {
            to,
            at: Date.now(),
            text: linked
              ? `Confirm your account: ${privateLink}`
              : "Your verification code is 246810.",
          };
        },
      },
      vault: {
        get: async () => undefined,
        put: async () => {
          stored++;
        },
      },
    };
    let result = await executor.complete(input);
    if (delivery === "link-fallback") {
      assert.equal(result.status, "blocked");
      if (result.status === "blocked") assert.equal(result.reason, "challenge");
      assert.equal(result.sessionPending, true);
      assert.equal(stored, 0);
      assert.equal(
        await executor.interact?.("inbox-recovery", { x: 50, y: 30 }),
        true,
      );
      result = await executor.complete({ ...input, resumeSession: true });
    }
    if (delivery === "late") {
      assert.equal(result.status, "blocked");
      if (result.status === "blocked")
        assert.equal(result.reason, "verification");
      assert.equal(result.sessionPending, true);
      assert.equal(stored, 0);
      assert.equal(registrations, 1);
      ready = true;
      result = await executor.complete({ ...input, resumeSession: true });
    }
    assert.notEqual(result.status, "blocked");
    assert.equal(result.accountStored, true);
    assert.equal(stored, 1);
    assert.equal(registrations, 1);
    assert.ok(polls >= 2);
    assert.equal(linkVisits, linked ? 1 : 0);
    assert.equal(verificationPosts, linked ? 0 : 1);
    assert.ok(snapshots.length > 0);
    if (linked) {
      const snapshot = snapshots.find(
        ({ snapshot }) => snapshot.path === secureOrigin,
      )?.snapshot;
      assert.ok(snapshot);
      assert.equal(snapshot.title === "[private] [private]", true);
      assert.equal(
        snapshot.elements.some(
          (element) => element.text === "Authorize [private] [private]",
        ),
        true,
      );
    }
    for (const secret of [
      "private-inbox@fixture.test",
      "246810",
      "synthetic-private-mail-link",
      "synthetic-private-mail-path",
      "synthetic-private-mail-%70ath",
      "synthetic-private-mail-fragment",
    ])
      assert.equal(
        JSON.stringify({ snapshots, events }).includes(secret),
        false,
      );
  });

test("an unavailable interpreter falls back to deterministic driving", async (t) => {
  const provider = await listen();
  t.after(() => provider.close());
  const browser = await chromium.launch({ headless: true });
  t.after(() => browser.close());
  const executor = createAuthorizationBrowser({
    open: async () => ({ browser, close: async () => {} }),
    interpreter: async () => undefined,
  });
  const result = await executor.complete({
    startUrl: `${provider.origin}/authorize`,
    redirectUri: `${provider.origin}/callback`,
    allowedOrigins: [provider.origin],
    credentials: { username: "agent", password: "secret" },
    timeoutMs: 15_000,
  });
  assert.equal(result.status, "callback");
});

test("isolated browser fills login, clicks authorize, and captures the callback", async (t) => {
  const provider = await listen();
  t.after(() => provider.close());
  const browser = await chromium.launch({ headless: true });
  t.after(() => browser.close());
  const executor = createAuthorizationBrowser({
    open: async () => ({
      browser,
      close: async () => {},
    }),
  });
  const result = await executor.complete({
    startUrl: `${provider.origin}/authorize`,
    redirectUri: `${provider.origin}/callback`,
    allowedOrigins: [provider.origin],
    credentials: { username: "agent", password: "secret" },
    timeoutMs: 10_000,
  });
  assert.equal(result.status, "callback");
  if (result.status === "callback")
    assert.match(result.url, /code=fixture-code/);
});

test("isolated browser stops for credentials instead of sending a person to the provider", async (t) => {
  const provider = await listen();
  t.after(() => provider.close());
  const browser = await chromium.launch({ headless: true });
  t.after(() => browser.close());
  const executor = createAuthorizationBrowser({
    open: async () => ({ browser, close: async () => {} }),
  });
  const result = await executor.complete({
    startUrl: `${provider.origin}/login`,
    redirectUri: `${provider.origin}/callback`,
    allowedOrigins: [provider.origin],
    timeoutMs: 5_000,
  });
  assert.equal(result.status, "blocked");
  if (result.status === "blocked") assert.equal(result.reason, "session");
});

test("isolated browser treats identifier-first login as credentials, not a timeout", async (t) => {
  const provider = await listen();
  t.after(() => provider.close());
  const browser = await chromium.launch({ headless: true });
  t.after(() => browser.close());
  const executor = createAuthorizationBrowser({
    open: async () => ({ browser, close: async () => {} }),
  });
  const result = await executor.complete({
    startUrl: `${provider.origin}/authorize?next=/identify`,
    redirectUri: `${provider.origin}/callback`,
    allowedOrigins: [provider.origin],
    timeoutMs: 5_000,
  });
  assert.equal(result.status, "blocked");
  if (result.status === "blocked") assert.equal(result.reason, "session");
});

test("registration fills a generated account, stores it, and finishes authorization", async (t) => {
  const provider = await listen();
  t.after(() => provider.close());
  const browser = await chromium.launch({ headless: true });
  t.after(() => browser.close());
  const executor = createAuthorizationBrowser({
    open: async () => ({ browser, close: async () => {} }),
  });
  let stored:
    { username: string; password: string; email?: string } | undefined;
  const events: string[] = [];
  const result = await executor.complete({
    startUrl: `${provider.origin}/signup`,
    startUrls: [`${provider.origin}/signup`, `${provider.origin}/authorize`],
    redirectUri: `${provider.origin}/callback`,
    allowedOrigins: [provider.origin],
    generateAccount: true,
    vault: {
      get: async () => undefined,
      put: async (account) => {
        stored = account;
      },
    },
    timeoutMs: 15_000,
    onEvent: (text) => events.push(text),
  });
  assert.equal(result.status, "callback");
  assert.equal(result.accountStored, true);
  assert.ok(stored?.password);
  assert.ok(events.includes("Trying the provider sign-in page"));
  assert.equal(
    events.some((text) => text.includes(provider.origin)),
    false,
  );
});

test("registration completes email verification through the agent inbox", async (t) => {
  const mailbox = inboxStub();
  const seenEmails: string[] = [];
  const provider = await listen({
    seenEmails,
    onSignup: (email) => {
      mailbox.send(
        email,
        "Your verification code is 246810. Enter it to continue.",
      );
      return "verify";
    },
  });
  t.after(() => provider.close());
  const browser = await chromium.launch({ headless: true });
  t.after(() => browser.close());
  const executor = createAuthorizationBrowser({
    open: async () => ({ browser, close: async () => {} }),
  });
  let stored:
    { username: string; password: string; email?: string } | undefined;
  const events: string[] = [];
  const result = await executor.complete({
    startUrl: `${provider.origin}/signup`,
    startUrls: [`${provider.origin}/signup`, `${provider.origin}/authorize`],
    redirectUri: `${provider.origin}/callback`,
    allowedOrigins: [provider.origin],
    generateAccount: true,
    inbox: mailbox.inbox,
    vault: {
      get: async () => undefined,
      put: async (account) => {
        stored = account;
      },
    },
    timeoutMs: 20_000,
    onEvent: (text) => events.push(text),
  });
  assert.equal(result.status, "callback");
  assert.equal(result.accountStored, true);
  assert.deepEqual(seenEmails, ["agent-1@inbox.test"]);
  assert.ok(stored?.password);
  assert.equal(stored?.email, "agent-1@inbox.test");
  assert.ok(
    events.some((text) => text.includes("Provisioned a fresh email address")),
  );
  assert.ok(
    events.some((text) =>
      text.includes("verification code from the agent inbox"),
    ),
  );
});

test("an already-used address stops registration and stores nothing", async (t) => {
  const mailbox = inboxStub();
  const provider = await listen({
    onSignup: () => "in-use",
  });
  t.after(() => provider.close());
  const browser = await chromium.launch({ headless: true });
  t.after(() => browser.close());
  const executor = createAuthorizationBrowser({
    open: async () => ({ browser, close: async () => {} }),
  });
  let stored:
    { username: string; password: string; email?: string } | undefined;
  const began = Date.now();
  const result = await executor.complete({
    startUrl: `${provider.origin}/signup`,
    startUrls: [`${provider.origin}/signup`, `${provider.origin}/authorize`],
    redirectUri: `${provider.origin}/callback`,
    allowedOrigins: [provider.origin],
    generateAccount: true,
    inbox: mailbox.inbox,
    vault: {
      get: async () => undefined,
      put: async (account) => {
        stored = account;
      },
    },
    timeoutMs: 30_000,
  });
  assert.ok(Date.now() - began < 20_000);
  assert.equal(result.status, "blocked");
  if (result.status === "blocked") assert.equal(result.reason, "email-in-use");
  assert.equal(result.accountStored, undefined);
  assert.equal(stored, undefined);
});

for (const preferredUsername of [undefined, "chosen@example.test"])
  test(`a generated username collision retries once with a new generated username (selected email: ${Boolean(preferredUsername)})`, async (t) => {
    const mailbox = inboxStub();
    let attempts = 0;
    const submissions: URLSearchParams[] = [];
    const provider = await listen({
      onSignup: () => (attempts++ === 0 ? "username-in-use" : "plain"),
      signupFields: '<input name="username" autocomplete="username">',
      seenSignups: submissions,
    });
    t.after(() => provider.close());
    const browser = await chromium.launch({ headless: true });
    t.after(() => browser.close());
    const executor = createAuthorizationBrowser({
      open: async () => ({ browser, close: async () => {} }),
    });
    const events: string[] = [];
    let stored:
      { username: string; password: string; email?: string } | undefined;
    const result = await executor.complete({
      startUrl: `${provider.origin}/signup`,
      redirectUri: `${provider.origin}/callback`,
      allowedOrigins: [provider.origin],
      generateAccount: true,
      ...(preferredUsername ? { preferredUsername } : {}),
      inbox: mailbox.inbox,
      vault: {
        get: async () => undefined,
        put: async (account) => {
          stored = account;
        },
      },
      onEvent: (event) => events.push(event),
      timeoutMs: 30_000,
    });
    assert.notEqual(result.status, "blocked");
    assert.ok(stored?.username);
    assert.equal(attempts, 2);
    assert.notEqual(
      submissions[0]?.get("username"),
      submissions[1]?.get("username"),
    );
    assert.notEqual(
      submissions[0]?.get("password"),
      submissions[1]?.get("password"),
    );
    assert.equal(submissions[0]?.get("email"), submissions[1]?.get("email"));
    if (preferredUsername) assert.equal(stored?.email, preferredUsername);
    assert.ok(events.some((event) => event.includes("generated username")));
  });

test("deterministic registration follows an inbox link from a page without a form", async (t) => {
  let posts = 0;
  const provider = await listen({
    onSignup: () => {
      posts++;
      return "mail";
    },
  });
  t.after(() => provider.close());
  const browser = await chromium.launch();
  t.after(() => browser.close());
  const secureOrigin = provider.origin.replace("http:", "https:");
  const link = `${secureOrigin}/confirm?token=private-fixture-link`;
  let visits = 0;
  const newContext = browser.newContext.bind(browser);
  t.mock.method(browser, "newContext", async () => {
    const context = await newContext();
    const newPage = context.newPage.bind(context);
    t.mock.method(context, "newPage", async () => {
      const page = await newPage();
      await page.route(link, async (route) => {
        visits++;
        await route.fulfill({
          contentType: "text/html",
          body: '<main data-authenticated="true">Account verified</main>',
        });
      });
      return page;
    });
    return context;
  });
  let stored = 0;
  const executor = createAuthorizationBrowser({
    open: async () => ({ browser, close: async () => {} }),
  });
  const result = await executor.complete({
    startUrl: `${provider.origin}/signup`,
    redirectUri: `${provider.origin}/callback`,
    allowedOrigins: [provider.origin, secureOrigin],
    generateAccount: true,
    accountOnly: true,
    inbox: {
      provision: async () => "agent@fixture.test",
      latest: async (to) => ({
        to,
        at: Date.now(),
        text: `Confirm your account: ${link}`,
      }),
    },
    vault: {
      get: async () => undefined,
      put: async () => {
        stored++;
      },
    },
  });
  assert.deepEqual(result, { status: "credentials", accountStored: true });
  assert.equal(posts, 1);
  assert.equal(visits, 1);
  assert.equal(stored, 1);
});

for (const source of ["selected", "supplied", "vault"] as const)
  test(`a user-selected username collision requires a human choice (${source})`, async (t) => {
    let attempts = 0;
    const provider = await listen({
      onSignup: () => {
        attempts++;
        return "username-in-use";
      },
    });
    t.after(() => provider.close());
    const browser = await chromium.launch({ headless: true });
    t.after(() => browser.close());
    const executor = createAuthorizationBrowser({
      open: async () => ({ browser, close: async () => {} }),
    });
    const result = await executor.complete({
      startUrl: `${provider.origin}/signup`,
      redirectUri: `${provider.origin}/callback`,
      allowedOrigins: [provider.origin],
      ...(source === "selected"
        ? { preferredUsername: "my-chosen-handle" }
        : source === "supplied"
          ? {
              credentials: {
                username: "my-chosen-handle",
                password: "fixture-password",
              },
            }
          : {
              vault: {
                get: async () => ({
                  username: "my-chosen-handle",
                  password: "fixture-password",
                }),
                put: async () =>
                  assert.fail("rejected account cannot be published"),
              },
            }),
      generateAccount: true,
    });
    assert.equal(result.status, "blocked");
    if (result.status === "blocked")
      assert.equal(result.reason, "username-in-use");
    assert.equal(attempts, 1);
  });

for (const inferred of [false, true])
  for (const field of [
    { name: "birthday", type: "date", answer: "2001-02-03", required: true },
    {
      name: "membership_id",
      type: "text",
      answer: "member-fixture-47",
      required: true,
    },
    {
      name: "country",
      type: "select",
      answer: "Canada",
      expected: "CA",
      required: true,
    },
    {
      name: "reason",
      type: "textarea",
      answer: "Private fixture explanation",
      required: true,
    },
    {
      name: "age_confirmation",
      type: "checkbox",
      answer: "on",
      required: true,
    },
    { name: "birthday", type: "date", answer: "2001-02-03", required: false },
    {
      name: "age_confirmation",
      type: "checkbox",
      answer: "on",
      required: false,
    },
  ].filter((field) => inferred || field.required))
    test(`${field.required ? "required" : "model-requested"} personal information delegates without fabrication (${inferred ? "inferred" : "deterministic"}, ${field.name})`, async (t) => {
      const submissions: URLSearchParams[] = [];
      const provider = await listen({
        signupFields: `<label>${field.name}${
          field.type === "select"
            ? '<select name="country" required><option value="">Choose a country</option><option value="CA">Canada</option></select>'
            : field.type === "textarea"
              ? '<textarea name="reason" required></textarea>'
              : `<input type="${field.type}" name="${field.name}" ${field.required ? "required" : ""}>`
        }</label>`,
        seenSignups: submissions,
      });
      t.after(() => provider.close());
      const browser = await chromium.launch({ headless: true });
      t.after(() => browser.close());
      const snapshots: InterpreterInput[] = [];
      const interpreter = scriptedInterpreter(snapshots);
      const executor = createAuthorizationBrowser({
        open: async () => ({ browser, close: async () => {} }),
        ...(inferred
          ? {
              interpreter: async (input: InterpreterInput) => {
                const birthday = input.snapshot.elements.find(
                  (e) => e.name === "birthday",
                );
                if (
                  birthday &&
                  !input.history.some((h) => h.action === "fill birth-date")
                )
                  return {
                    action: "fill" as const,
                    role: "birth-date" as const,
                    element: birthday.index,
                  };
                return interpreter(input);
              },
            }
          : {}),
      });
      t.after(() => executor.close?.("personal-info"));
      const input = {
        sessionKey: "personal-info",
        startUrl: `${provider.origin}/signup`,
        redirectUri: `${provider.origin}/callback`,
        allowedOrigins: [provider.origin],
        generateAccount: true,
        timeoutMs: 10_000,
      };
      const first = await executor.complete(input);
      assert.equal(first.status, "blocked");
      if (first.status === "blocked")
        assert.equal(first.reason, "required-input");
      assert.equal(first.sessionPending, true);
      assert.equal(submissions.length, 0);
      if (inferred && field.type === "textarea")
        assert.ok(
          snapshots.some(({ snapshot }) =>
            snapshot.elements.some((element) => element.name === field.name),
          ),
        );
      const beforeHumanInput = snapshots.length;
      assert.equal(
        await executor.interact?.(
          "personal-info",
          field.type === "checkbox" ? { key: "Space" } : { text: field.answer },
        ),
        true,
      );
      const resumed = await executor.complete({
        ...input,
        resumeSession: true,
      });
      assert.equal(
        resumed.status,
        "callback",
        resumed.status === "blocked" ? resumed.reason : undefined,
      );
      assert.equal(submissions.length, 1);
      assert.equal(
        submissions[0]?.get(field.name),
        field.expected ?? field.answer,
      );
      if (inferred && field.type !== "checkbox")
        assert.equal(
          JSON.stringify(snapshots.slice(beforeHumanInput)).includes(
            field.answer,
          ),
          false,
        );
    });

for (const mode of [
  "other-context",
  "own-worker",
  "target-read-failure",
  "target-read-timeout",
  "missing-context-id",
] as const)
  test(
    `final browser target inspection is context-bound and fail-closed (${mode})`,
    { timeout: 15_000 },
    async (t) => {
      let posts = 0;
      const provider = await listen({
        onLogin: () => {
          posts++;
        },
      });
      t.after(() => provider.close());
      const browser = await chromium.launch();
      t.after(() => browser.close());
      const other = await browser.newContext();
      const otherPage = await other.newPage();
      let checks = 0;
      const newContext = browser.newContext.bind(browser);
      t.mock.method(
        browser,
        "newContext",
        async (...args: Parameters<typeof newContext>) => {
          const context = await newContext(...args);
          if (mode === "own-worker")
            await context.addInitScript(() => {
              Reflect.set(
                window,
                "__fixtureWorkerReady",
                new Promise<void>((resolve) => {
                  const worker = new Worker(
                    URL.createObjectURL(
                      new Blob(
                        ["onmessage = () => {}; postMessage('ready');"],
                        { type: "text/javascript" },
                      ),
                    ),
                  );
                  worker.onmessage = () => resolve();
                }),
              );
            });
          const newSession = context.newCDPSession.bind(context);
          t.mock.method(
            context,
            "newCDPSession",
            async (...args: Parameters<typeof newSession>) => {
              const page = args[0];
              const session = await newSession(...args);
              const send = session.send.bind(session);
              t.mock.method(
                session,
                "send",
                async (...args: Parameters<typeof send>) => {
                  if (args[0] === "Target.getTargets") {
                    checks++;
                    if (mode === "own-worker")
                      await page.evaluate(() =>
                        Reflect.get(window, "__fixtureWorkerReady"),
                      );
                    if (mode === "target-read-failure")
                      throw new Error("Synthetic target transport failure");
                    if (mode === "target-read-timeout")
                      return new Promise(() => {});
                  }
                  const result = await Reflect.apply(send, session, args);
                  if (
                    mode === "own-worker" &&
                    args[0] === "Target.getTargets"
                  ) {
                    assert.ok("targetInfos" in result);
                    assert.ok(
                      result.targetInfos.some(
                        (target) => target.type === "worker",
                      ),
                    );
                  }
                  if (
                    mode === "missing-context-id" &&
                    args[0] === "Target.getTargetInfo"
                  ) {
                    assert.ok("targetInfo" in result);
                    delete result.targetInfo.browserContextId;
                  }
                  return result;
                },
              );
              return session;
            },
          );
          return context;
        },
      );
      let stored = false;
      const executor = createAuthorizationBrowser({
        open: async () => ({ browser, close: async () => {} }),
      });
      t.after(() => executor.close?.("target-boundary"));
      const result = await executor.complete({
        sessionKey: "target-boundary",
        startUrl: `${provider.origin}/login`,
        redirectUri: `${provider.origin}/callback`,
        allowedOrigins: [provider.origin],
        credentials: { username: "fixture-user", password: "fixture-password" },
        vault: {
          get: async () => undefined,
          put: async () => {
            stored = true;
          },
        },
        timeoutMs: 3000,
      });
      const succeeds = mode === "other-context" || mode === "own-worker";
      assert.equal(stored, succeeds);
      if (succeeds) assert.equal(result.status, "callback");
      else
        assert.deepEqual(result, {
          status: "blocked",
          reason:
            mode === "missing-context-id"
              ? "browser-unavailable"
              : "session-expired",
        });
      assert.equal(posts, mode === "missing-context-id" ? 0 : 1);
      assert.equal(checks, mode === "missing-context-id" ? 0 : 1);
      assert.equal(otherPage.isClosed(), false);
      assert.equal(await executor.screenshot?.("target-boundary"), undefined);
    },
  );

for (const guard of ["creation", "network", "settlement"] as const)
  for (const mode of ["deterministic", "inferred"] as const)
    for (const target of guard === "creation"
      ? ["_blank", "provider-window", "script-blank"]
      : ["_blank", "provider-window", "preopened-window"]) {
      test(
        `popup form delegates before its first credential POST (${guard}, ${mode}, ${target})`,
        { timeout: 15_000 },
        async (t) => {
          const releaseNetwork = Promise.withResolvers<void>();
          const popupNavigation = Promise.withResolvers<void>();
          t.after(() => releaseNetwork.resolve());
          let otherRequests = 0;
          let providerPosts = 0;
          const other = await listen({
            onRequest: () => {
              otherRequests++;
            },
          });
          t.after(() => other.close());
          const provider = await listen({
            ...(target === "script-blank"
              ? { loginBlankPopup: true }
              : {
                  loginTarget:
                    target === "preopened-window" ? "provider-window" : target,
                  loginPreopenTarget: target === "preopened-window",
                }),
            loginRedirect: { status: 307, location: `${other.origin}/login` },
            onLogin: () => {
              providerPosts++;
            },
          });
          t.after(() => provider.close());
          const browser = await chromium.launch({ headless: true });
          t.after(() => browser.close());
          let ignoredCreationEvents = 0;
          let knownPopupFrames = 0;
          if (guard !== "creation") {
            const newContext = browser.newContext.bind(browser);
            t.mock.method(
              browser,
              "newContext",
              async (...args: Parameters<typeof newContext>) => {
                const context = await newContext(...args);
                if (guard === "settlement") {
                  const route = context.route.bind(context);
                  t.mock.method(
                    context,
                    "route",
                    async (...args: Parameters<typeof route>) => {
                      const handler = args[1];
                      args[1] = async (route, request) => {
                        if (
                          request.isNavigationRequest() &&
                          request.method() === "POST"
                        )
                          await releaseNetwork.promise;
                        return handler(route, request);
                      };
                      return route(...args);
                    },
                  );
                }
                context.on("request", (request) => {
                  if (!request.isNavigationRequest()) return;
                  try {
                    const frame = request.frame();
                    if (
                      !frame.parentFrame() &&
                      frame.page() !== context.pages()[0]
                    ) {
                      knownPopupFrames++;
                      popupNavigation.resolve();
                    }
                  } catch {
                    // Chromium can dispatch a new popup request before its frame exists.
                  }
                });
                const newCDPSession = context.newCDPSession.bind(context);
                t.mock.method(
                  context,
                  "newCDPSession",
                  async (...args: Parameters<typeof newCDPSession>) => {
                    const session = await newCDPSession(...args);
                    if (target === "preopened-window") {
                      const send = session.send.bind(session);
                      t.mock.method(
                        session,
                        "send",
                        async (...args: Parameters<typeof send>) => {
                          // Exercise the known-frame network branch before the
                          // independent finalization guard can close the popup.
                          if (args[0] === "Target.getTargets")
                            await popupNavigation.promise;
                          return Reflect.apply(send, session, args);
                        },
                      );
                    }
                    const on = session.on.bind(session);
                    t.mock.method(
                      session,
                      "on",
                      (event: string, listener: (...args: unknown[]) => void) =>
                        Reflect.apply(on, session, [
                          event,
                          event === "Page.windowOpen"
                            ? () => {
                                ignoredCreationEvents++;
                              }
                            : listener,
                        ]),
                    );
                    return session;
                  },
                );
                return context;
              },
            );
          }
          const executor = createAuthorizationBrowser({
            open: async () => ({ browser, close: async () => {} }),
            ...(mode === "inferred"
              ? { interpreter: scriptedInterpreter() }
              : {}),
          });
          t.after(() => executor.close?.("popup-fixture"));
          let stored = false;
          const result = await executor.complete({
            sessionKey: "popup-fixture",
            startUrl: `${provider.origin}/login`,
            redirectUri: `${provider.origin}/callback`,
            allowedOrigins: [provider.origin],
            credentials: {
              username: "fixture-user",
              password: "fixture-password",
            },
            vault: {
              get: async () => undefined,
              put: async () => {
                stored = true;
              },
            },
            timeoutMs: 2500,
          });
          assert.equal(result.status, "blocked");
          if (result.status === "blocked") assert.equal(result.reason, "popup");
          assert.notEqual(result.sessionPending, true);
          assert.equal(await executor.screenshot?.("popup-fixture"), undefined);
          assert.equal(providerPosts, 0);
          assert.equal(otherRequests, 0);
          assert.equal(stored, false);
          if (guard !== "creation") assert.ok(ignoredCreationEvents > 0);
          if (target === "preopened-window") assert.ok(knownPopupFrames > 0);
        },
      );
    }

test("browser replay guard preserves reads, background traffic and distinct requests", async (t) => {
  const requests: string[] = [];
  const provider = await listen({
    signupFields: `<script>document.addEventListener('DOMContentLoaded', async () => {
      const button = document.querySelector('button'); button.disabled = true;
      for (const [method, path, body] of [
        ['GET', '/background', undefined], ['GET', '/background', undefined],
        ['HEAD', '/background', undefined], ['HEAD', '/background', undefined],
        ['POST', '/background', undefined], ['POST', '/background', undefined],
        ['POST', '/background', 'telemetry'], ['POST', '/background', 'telemetry'],
        ['POST', '/background', 'fixture-password'],
        ['PUT', '/background', 'fixture-password'],
        ['POST', '/background', 'fixture-password&step=two'],
        ['POST', '/background/next', 'fixture-password'],
      ]) await fetch(path, { method, body });
      const frame = document.createElement('iframe');
      const loaded = new Promise(resolve => { frame.onload = resolve; });
      frame.src = '/plain'; document.body.append(frame); await loaded;
      await frame.contentWindow.fetch('/background/frame', { method: 'POST', body: 'fixture-password' });
      await frame.contentWindow.fetch('/background/frame', { method: 'POST', body: 'fixture-password' });
      button.disabled = false;
    });</script>`,
    onRequest: (url, method) => {
      if (url.pathname.startsWith("/background"))
        requests.push(`${method} ${url.pathname}`);
    },
  });
  t.after(() => provider.close());
  const browser = await chromium.launch();
  t.after(() => browser.close());
  const executor = createAuthorizationBrowser({
    open: async () => ({ browser, close: async () => {} }),
  });
  const result = await executor.complete({
    startUrl: `${provider.origin}/signup`,
    redirectUri: `${provider.origin}/callback`,
    allowedOrigins: [provider.origin],
    credentials: {
      email: "fixture@fixture.test",
      password: "fixture-password",
    },
    timeoutMs: 5000,
  });
  assert.equal(result.status, "callback");
  assert.deepEqual(requests, [
    "GET /background",
    "GET /background",
    "HEAD /background",
    "HEAD /background",
    "POST /background",
    "POST /background",
    "POST /background",
    "POST /background",
    "POST /background",
    "PUT /background",
    "POST /background",
    "POST /background/next",
    "POST /background/frame",
    "POST /background/frame",
  ]);
});

for (const encoding of ["raw", "uri", "form", "json", "json-fragment"] as const)
  test(`browser replay guard recognizes credential wire encoding (${encoding})`, async (t) => {
    const secret = 'synthetic password!"\\&é';
    const body =
      encoding === "raw"
        ? secret
        : encoding === "uri"
          ? encodeURIComponent(secret)
          : encoding === "form"
            ? new URLSearchParams({ password: secret }).toString()
            : encoding === "json"
              ? JSON.stringify({ password: secret })
              : JSON.stringify(secret).slice(1, -1);
    let received = 0;
    const provider = await listen({
      signupFields: `<script>(async () => {
        await fetch('/background', { method: 'POST', body: ${JSON.stringify(body)} });
        await fetch('/background', { method: 'POST', body: ${JSON.stringify(body)} });
      })().catch(() => {});</script>`,
      onRequest: (url) => {
        if (url.pathname === "/background") received++;
      },
    });
    t.after(() => provider.close());
    const browser = await chromium.launch();
    t.after(() => browser.close());
    const executor = createAuthorizationBrowser({
      open: async () => ({ browser, close: async () => {} }),
    });
    const result = await executor.complete({
      startUrl: `${provider.origin}/signup`,
      redirectUri: `${provider.origin}/callback`,
      allowedOrigins: [provider.origin],
      credentials: { password: secret },
      timeoutMs: 3000,
    });
    assert.equal(received, 1);
    assert.equal(result.status, "blocked");
    if (result.status === "blocked")
      assert.equal(result.reason, "submission-uncertain");
  });

test("an expired inference budget stops before another model step or submission", async (t) => {
  let now = Date.now();
  t.mock.method(Date, "now", () => now);
  let submissions = 0;
  const provider = await listen({
    onSignup: () => {
      submissions++;
      return "plain";
    },
  });
  t.after(() => provider.close());
  const browser = await chromium.launch();
  t.after(() => browser.close());
  let calls = 0;
  const executor = createAuthorizationBrowser({
    open: async () => ({ browser, close: async () => {} }),
    interpreter: async () => {
      calls++;
      assert.equal(calls, 1);
      now += 3000;
      return { action: "wait" };
    },
  });
  let published = 0;
  const result = await executor.complete({
    startUrl: `${provider.origin}/signup`,
    redirectUri: `${provider.origin}/callback`,
    allowedOrigins: [provider.origin],
    generateAccount: true,
    timeoutMs: 3000,
    vault: {
      get: async () => undefined,
      put: async () => {
        published++;
      },
    },
  });
  assert.deepEqual(result, { status: "blocked", reason: "timeout" });
  assert.equal(calls, 1);
  assert.equal(submissions, 0);
  assert.equal(published, 0);
});

for (const transport of [
  "form",
  "fetch",
  "rotating-form",
  "rotating-fetch",
  "multipart-fetch",
] as const)
  for (const mode of ["deterministic", "inferred", "fallback"] as const)
    test(`an uncertain registration response does not repeat submission (${mode}, ${transport})`, async (t) => {
      let submissions = 0;
      let staged: IsolatedAccount | undefined;
      let login: URLSearchParams | undefined;
      const provider = await listen({
        ...(transport !== "form"
          ? {
              signupFields: `<input type="hidden" name="nonce" value="initial">
                <script>let attempt = 0; document.querySelector('form').addEventListener('submit', event => {
                  const form = event.target;
                  if (${transport.startsWith("rotating-")}) {
                    form.elements.nonce.value = String(++attempt);
                    form.action = '/signup?attempt=' + attempt;
                  }
                  if (${transport !== "rotating-form"}) {
                    event.preventDefault();
                    const data = new FormData(form);
                    fetch(form.action, { method: 'POST', body: ${transport === "multipart-fetch" ? "data" : "new URLSearchParams(data)"} }).then(async response => {
                      if (response.status !== 204) {
                        const html = await response.text();
                        document.open(); document.write(html); document.close();
                      }
                    }).catch(() => {});
                  }
                });</script>`,
            }
          : {}),
        onSignup: () => {
          assert.ok(staged?.password);
          return ++submissions === 1 ? "uncertain" : "challenge";
        },
        onLogin: (form) => {
          login = form;
        },
      });
      t.after(() => provider.close());
      const browser = await chromium.launch();
      t.after(() => browser.close());
      const interpret = scriptedInterpreter();
      const executor = createAuthorizationBrowser({
        open: async () => ({ browser, close: async () => {} }),
        ...(mode === "deterministic"
          ? {}
          : {
              interpreter: async (input: InterpreterInput) => {
                if (
                  input.history.some((item) => item.note?.startsWith("submit-"))
                )
                  return mode === "fallback"
                    ? undefined
                    : {
                        action: "click" as const,
                        element: input.snapshot.elements.find(
                          (element) => element.kind === "button",
                        )!.index,
                      };
                return interpret(input);
              },
            }),
      });
      t.after(() => executor.close?.("uncertain-registration"));
      let published = 0;
      const input = {
        sessionKey: "uncertain-registration",
        startUrl: `${provider.origin}/signup`,
        redirectUri: `${provider.origin}/callback`,
        allowedOrigins: [provider.origin],
        preferredUsername: "chosen@fixture.test",
        generateAccount: true,
        vault: {
          get: async () => undefined,
          stage: async (account: IsolatedAccount) => {
            staged = account;
          },
          put: async () => {
            published++;
          },
        },
      };
      const result = await executor.complete(input);
      assert.equal(submissions, 1);
      assert.equal(result.status, "blocked");
      if (result.status === "blocked")
        assert.equal(result.reason, "submission-uncertain");
      assert.notEqual(result.sessionPending, true);
      assert.equal(published, 0);
      assert.equal(
        await executor.screenshot?.("uncertain-registration"),
        undefined,
      );
      assert.deepEqual(
        await executor.complete({ ...input, resumeSession: true }),
        {
          status: "blocked",
          reason: "session-expired",
        },
      );
      assert.equal(submissions, 1);
      assert.ok(staged);
      const recovered = await executor.complete({
        ...input,
        startUrl: `${provider.origin}/login`,
        generateAccount: false,
        credentials: staged,
      });
      assert.equal(recovered.status, "callback");
      assert.equal(published, 1);
      assert.equal(login?.get("password") === staged.password, true);
      assert.equal(submissions, 1);
    });

for (const inferred of [false, true])
  test(`registration accepts new verification input at the same endpoint (inferred: ${inferred})`, async (t) => {
    const inbox = inboxStub();
    const submissions: URLSearchParams[] = [];
    let registrations = 0;
    let verifications = 0;
    let availabilityChecks = 0;
    const provider = await listen({
      verifyAtSignup: true,
      seenSignups: submissions,
      signupFields: `<script>document.addEventListener('DOMContentLoaded', async () => {
        const button = document.querySelector('button'); button.disabled = true;
        for (const nonce of [1, 2]) await fetch('/availability?nonce=' + nonce, {
          method: 'POST', body: 'email=agent-1%40inbox.test&nonce=' + nonce,
        });
        button.disabled = false;
      });</script>`,
      onRequest: (url, method) => {
        if (url.pathname === "/availability" && method === "POST")
          availabilityChecks++;
      },
      onSignup: (email) => {
        if (submissions.at(-1)?.get("code") === "246810") {
          verifications++;
          return "plain";
        }
        registrations++;
        inbox.send(email, "Your verification code is 246810");
        return "verify";
      },
    });
    t.after(() => provider.close());
    const browser = await chromium.launch();
    t.after(() => browser.close());
    const executor = createAuthorizationBrowser({
      open: async () => ({ browser, close: async () => {} }),
      ...(inferred ? { interpreter: scriptedInterpreter() } : {}),
    });
    let published = 0;
    let staged = 0;
    const result = await executor.complete({
      startUrl: `${provider.origin}/signup`,
      redirectUri: `${provider.origin}/callback`,
      allowedOrigins: [provider.origin],
      generateAccount: true,
      inbox: inbox.inbox,
      vault: {
        get: async () => undefined,
        stage: async () => {
          staged++;
        },
        put: async () => {
          published++;
        },
      },
      timeoutMs: 10_000,
    });
    assert.equal(result.status, "callback");
    assert.equal(registrations, 1);
    assert.equal(verifications, 1);
    assert.equal(availabilityChecks, 2);
    assert.equal(published, 1);
    assert.equal(staged, 1);
    assert.equal(submissions.length, 2);
    assert.equal(
      submissions[0]!.get("password") === submissions[1]!.get("password"),
      true,
    );
  });

test("a resumed browser cannot replay an earlier registration submission", async (t) => {
  let submissions = 0;
  const provider = await listen({
    onSignup: () => {
      submissions++;
      return "challenge";
    },
  });
  t.after(() => provider.close());
  const browser = await chromium.launch();
  t.after(() => browser.close());
  const executor = createAuthorizationBrowser({
    open: async () => ({ browser, close: async () => {} }),
  });
  t.after(() => executor.close?.("resumed-replay"));
  let published = 0;
  const input = {
    sessionKey: "resumed-replay",
    startUrl: `${provider.origin}/signup`,
    redirectUri: `${provider.origin}/callback`,
    allowedOrigins: [provider.origin],
    generateAccount: true,
    preferredUsername: "chosen@fixture.test",
    vault: {
      get: async () => undefined,
      put: async () => {
        published++;
      },
    },
    timeoutMs: 3000,
  };
  assert.deepEqual(await executor.complete(input), {
    status: "blocked",
    reason: "challenge",
    sessionPending: true,
  });
  // Returning to the original form must not erase the prior submission.
  await browser.contexts()[0]!.pages()[0]!.goto(input.startUrl);
  assert.deepEqual(await executor.complete({ ...input, resumeSession: true }), {
    status: "blocked",
    reason: "submission-uncertain",
  });
  assert.equal(submissions, 1);
  assert.equal(published, 0);
  assert.equal(await executor.screenshot?.("resumed-replay"), undefined);
});

for (const obstacle of ["verify", "challenge"] as const) {
  test(`human ${obstacle} resumes the same browser without repeating registration`, async (t) => {
    let submissions = 0;
    const provider = await listen({
      onSignup: () => {
        submissions++;
        return obstacle;
      },
    });
    t.after(() => provider.close());
    const browser = await chromium.launch({ headless: true });
    t.after(() => browser.close());
    const executor = createAuthorizationBrowser({
      open: async () => ({ browser, close: async () => {} }),
    });
    t.after(() => executor.close?.("fixture-session"));
    let stored = false;
    const input = {
      sessionKey: "fixture-session",
      startUrl: `${provider.origin}/signup`,
      redirectUri: `${provider.origin}/callback`,
      allowedOrigins: [provider.origin],
      generateAccount: true,
      vault: {
        get: async () => undefined,
        put: async () => {
          stored = true;
        },
      },
    };
    const first = await executor.complete(input);
    assert.equal(first.status, "blocked");
    assert.equal(first.sessionPending, true);
    assert.equal(stored, false);
    assert.ok((await executor.screenshot?.("fixture-session"))?.byteLength);
    assert.equal(
      await executor.interact?.("wrong-session", { code: "246810" }),
      false,
    );
    assert.equal(
      await executor.interact?.(
        "fixture-session",
        obstacle === "verify" ? { code: "246810" } : { x: 50, y: 30 },
      ),
      true,
    );
    // A pixel interaction refreshes the human handoff; it does not advance the
    // agent. Wait for the provider's human step before requesting Continue.
    await browser
      .contexts()[0]!
      .pages()[0]!
      .waitForURL(`${provider.origin}/login`);
    const resumed = await executor.complete({ ...input, resumeSession: true });
    assert.equal(resumed.status, "callback");
    assert.equal(stored, true);
    assert.equal(submissions, 1);
    assert.equal(await executor.screenshot?.("fixture-session"), undefined);
    const expired = await executor.complete({ ...input, resumeSession: true });
    assert.equal(expired.status, "blocked");
    if (expired.status === "blocked")
      assert.equal(expired.reason, "session-expired");
    assert.equal(submissions, 1);
  });
}

test("rejected credentials stop without retrying the same password", async (t) => {
  const provider = await listen();
  t.after(() => provider.close());
  const browser = await chromium.launch({ headless: true });
  t.after(() => browser.close());
  const executor = createAuthorizationBrowser({
    open: async () => ({ browser, close: async () => {} }),
  });
  const events: string[] = [];
  const began = Date.now();
  const result = await executor.complete({
    startUrl: `${provider.origin}/picky`,
    redirectUri: `${provider.origin}/callback`,
    allowedOrigins: [provider.origin],
    credentials: { username: "agent", password: "secret" },
    timeoutMs: 60_000,
    onEvent: (text) => events.push(text),
  });
  assert.ok(Date.now() - began < 30_000);
  assert.equal(result.status, "blocked");
  if (result.status === "blocked") assert.equal(result.reason, "rejected");
  assert.ok(
    events.includes(
      "Provider rejected the submission; review it in the private browser",
    ),
  );
  assert.equal(
    events.some((text) =>
      text.includes("These credentials do not match our records"),
    ),
    false,
  );
});

for (const inferred of [false, true])
  for (const obstacle of ["unreachable", "required-input"] as const)
    test(`registration is not journaled before any credential submission (${inferred}, ${obstacle})`, async (t) => {
      let posts = 0;
      let staged = 0;
      const provider = await listen({
        unavailable: () => true,
        signupFields: '<input name="birthday" type="date" required>',
        onSignup: () => {
          posts++;
          return "plain";
        },
      });
      t.after(() => provider.close());
      const browser = await chromium.launch();
      t.after(() => browser.close());
      const executor = createAuthorizationBrowser({
        open: async () => ({ browser, close: async () => {} }),
        ...(inferred ? { interpreter: scriptedInterpreter() } : {}),
      });
      const result = await executor.complete({
        startUrl: `${provider.origin}/${obstacle === "unreachable" ? "login" : "signup"}`,
        redirectUri: `${provider.origin}/callback`,
        allowedOrigins: [provider.origin],
        generateAccount: true,
        preferredUsername: "chosen@example.test",
        vault: {
          get: async () => undefined,
          stage: async () => {
            staged++;
          },
          put: async () =>
            assert.fail("unsubmitted account must not be published"),
        },
      });
      assert.deepEqual(result, { status: "blocked", reason: obstacle });
      assert.equal(posts, 0);
      assert.equal(staged, 0);
    });

for (const inferred of [false, true])
  test(`transient provider failures retry once before requesting human help (inferred: ${inferred})`, async (t) => {
    let attempts = 0;
    let permanent = false;
    const provider = await listen({
      unavailable: () => ++attempts === 1 || permanent,
    });
    t.after(() => provider.close());
    const browser = await chromium.launch({ headless: true });
    t.after(() => browser.close());
    const executor = createAuthorizationBrowser({
      open: async () => ({ browser, close: async () => {} }),
      ...(inferred ? { interpreter: scriptedInterpreter() } : {}),
    });
    const input = {
      startUrl: `${provider.origin}/login`,
      redirectUri: `${provider.origin}/callback`,
      allowedOrigins: [provider.origin],
      timeoutMs: 10_000,
    };
    const recovered = await executor.complete(input);
    assert.equal(attempts, 2);
    assert.equal(recovered.status, "blocked");
    if (recovered.status === "blocked")
      assert.equal(recovered.reason, "session");
    attempts = 0;
    permanent = true;
    const failed = await executor.complete(input);
    assert.equal(attempts, 2);
    assert.equal(failed.status, "blocked");
    if (failed.status === "blocked") assert.equal(failed.reason, "unreachable");
  });

for (const inferred of [false, true])
  test(`a passkey request pauses for provider-hosted authentication (${inferred ? "inferred" : "deterministic"})`, async (t) => {
    const provider = await listen();
    t.after(() => provider.close());
    const browser = await chromium.launch({ headless: true });
    t.after(() => browser.close());
    const executor = createAuthorizationBrowser({
      open: async () => ({ browser, close: async () => {} }),
      ...(inferred ? { interpreter: scriptedInterpreter() } : {}),
    });
    const result = await executor.complete({
      startUrl: `${provider.origin}/passkey`,
      redirectUri: `${provider.origin}/callback`,
      allowedOrigins: [provider.origin],
      sessionKey: "passkey-fixture",
      timeoutMs: 5000,
    });
    assert.equal(result.status, "blocked");
    if (result.status === "blocked") assert.equal(result.reason, "passkey");
    assert.equal(result.sessionPending, true);
    await executor.close?.("passkey-fixture");
    const native = await executor.complete({
      startUrl: `${provider.origin}/authenticator-request`,
      redirectUri: `${provider.origin}/callback`,
      allowedOrigins: [provider.origin],
      sessionKey: "native-fixture",
      timeoutMs: 5000,
    });
    assert.equal(native.status, "blocked");
    if (native.status === "blocked") assert.equal(native.reason, "passkey");
    await executor.close?.("native-fixture");
  });

for (const inferred of [false, true])
  test(`a missing provider page fails fast instead of burning the whole timeout (inferred: ${inferred})`, async (t) => {
    const provider = await listen();
    t.after(() => provider.close());
    const browser = await chromium.launch({ headless: true });
    t.after(() => browser.close());
    const executor = createAuthorizationBrowser({
      open: async () => ({ browser, close: async () => {} }),
      ...(inferred ? { interpreter: scriptedInterpreter() } : {}),
    });
    const events: string[] = [];
    const began = Date.now();
    const result = await executor.complete({
      startUrl: `${provider.origin}/absent`,
      redirectUri: `${provider.origin}/callback`,
      allowedOrigins: [provider.origin],
      timeoutMs: 30_000,
      onEvent: (text) => events.push(text),
    });
    assert.ok(Date.now() - began < 15_000);
    assert.equal(result.status, "blocked");
    if (result.status === "blocked") assert.equal(result.reason, "missing");
    assert.ok(events.some((text) => text.includes("(404)")));
  });

test("a page with no form stops as no-form instead of waiting out the timeout", async (t) => {
  const provider = await listen();
  t.after(() => provider.close());
  const browser = await chromium.launch({ headless: true });
  t.after(() => browser.close());
  const executor = createAuthorizationBrowser({
    open: async () => ({ browser, close: async () => {} }),
  });
  const began = performance.now();
  const now = Date.now;
  let noFormReported = false;
  // A discarded terminal result must fail an assertion, not spin until a hit limit.
  t.mock.method(Date, "now", () => now() + (noFormReported ? 30_000 : 0));
  const result = await executor.complete({
    startUrl: `${provider.origin}/plain`,
    redirectUri: `${provider.origin}/callback`,
    allowedOrigins: [provider.origin],
    timeoutMs: 30_000,
    onEvent: (event) => {
      if (event === "No sign-in or registration form on the provider page")
        noFormReported = true;
    },
  });
  assert.ok(performance.now() - began < 20_000);
  assert.equal(noFormReported, true);
  assert.equal(result.status, "blocked");
  if (result.status === "blocked") assert.equal(result.reason, "no-form");
});

test("only explicitly discovered login origins receive credentials", () => {
  assert.equal(
    allowedAuthorizationOrigin(
      "https://accounts.x.ai/sign-in",
      ["https://auth.x.ai", "https://accounts.x.ai"],
      "http://127.0.0.1:4173/callback",
    ),
    true,
  );
  assert.equal(
    allowedAuthorizationOrigin(
      "https://x.ai/login",
      ["https://auth.x.ai", "https://x.ai"],
      "http://127.0.0.1:4173/callback",
    ),
    true,
  );
  assert.equal(
    allowedAuthorizationOrigin(
      "https://shopify.com/login",
      ["https://bluesky.com"],
      "http://127.0.0.1:4173/callback",
    ),
    false,
  );
  for (const [target, allowed] of [
    ["https://attacker.co.uk/login", "https://provider.co.uk"],
    ["https://other.github.io/login", "https://provider.github.io"],
    ["https://accounts.x.ai/login", "https://auth.x.ai"],
    ["http://provider.example/login", "https://provider.example"],
    ["http://127.0.0.1:9000/login", "http://127.0.0.1:8000"],
  ])
    assert.equal(
      allowedAuthorizationOrigin(
        target!,
        [allowed!],
        "https://ceremony.example/callback",
      ),
      false,
    );
});

test("an undiscovered redirect cannot receive browser credentials", async (t) => {
  let submissions = 0;
  const provider = await listen();
  const other = await listen({
    onLogin: () => {
      submissions++;
    },
  });
  t.after(() => provider.close());
  t.after(() => other.close());
  const browser = await chromium.launch({ headless: true });
  t.after(() => browser.close());
  const executor = createAuthorizationBrowser({
    open: async () => ({ browser, close: async () => {} }),
  });
  const result = await executor.complete({
    startUrl: `${provider.origin}/authorize?next=${encodeURIComponent(`${other.origin}/login`)}`,
    redirectUri: `${provider.origin}/callback`,
    allowedOrigins: [provider.origin],
    credentials: { username: "fixture-user", password: "fixture-password" },
    timeoutMs: 2000,
  });
  assert.equal(submissions, 0);
  assert.equal(result.status, "blocked");
  if (result.status === "blocked") assert.equal(result.reason, "origin");
});

for (const status of [307, 308] as const)
  test(`a ${status} redirect cannot forward a credential POST to an undiscovered origin`, async (t) => {
    let submissions = 0;
    let forwarded = 0;
    const other = await listen({
      onLogin: () => {
        forwarded++;
      },
    });
    const provider = await listen({
      onLogin: () => {
        submissions++;
      },
      loginRedirect: { status, location: `${other.origin}/login` },
    });
    t.after(() => provider.close());
    t.after(() => other.close());
    const browser = await chromium.launch({ headless: true });
    t.after(() => browser.close());
    const executor = createAuthorizationBrowser({
      open: async () => ({ browser, close: async () => {} }),
    });
    const result = await executor.complete({
      startUrl: `${provider.origin}/login`,
      redirectUri: `${provider.origin}/callback`,
      allowedOrigins: [provider.origin],
      credentials: { username: "fixture-user", password: "fixture-password" },
      timeoutMs: 2000,
    });
    assert.equal(submissions, 1);
    assert.equal(forwarded, 0);
    assert.deepEqual(result, { status: "blocked", reason: "origin" });
  });

test("origin confinement preserves provider assets and CAPTCHA subframes", async (t) => {
  const requests: string[] = [];
  const other = await listen({
    onRequest: (url) => {
      requests.push(url.search);
    },
  });
  const provider = await listen({
    signupFields: `<iframe src="${other.origin}/plain?frame"></iframe><link rel="stylesheet" href="${other.origin}/plain?asset">`,
    onSignup: () => "challenge",
  });
  t.after(() => provider.close());
  t.after(() => other.close());
  const browser = await chromium.launch({ headless: true });
  t.after(() => browser.close());
  const executor = createAuthorizationBrowser({
    open: async () => ({ browser, close: async () => {} }),
  });
  const result = await executor.complete({
    startUrl: `${provider.origin}/signup`,
    redirectUri: `${provider.origin}/callback`,
    allowedOrigins: [provider.origin],
    generateAccount: true,
    inbox: inboxStub().inbox,
    timeoutMs: 2000,
  });
  assert.ok(requests.includes("?frame"));
  assert.ok(requests.includes("?asset"));
  assert.deepEqual(result, { status: "blocked", reason: "challenge" });
});

for (const waitingOn of ["inference", "inbox"] as const)
  for (const throughRedirect of [false, true])
    test(`navigation during ${waitingOn} cannot move private input to an undiscovered origin (${throughRedirect ? "redirect" : "direct"})`, async (t) => {
      const provider = await listen({ onSignup: () => "verify" });
      const other = await listen({ observePasswordInput: true });
      t.after(() => provider.close());
      t.after(() => other.close());
      const browser = await chromium.launch({ headless: true });
      t.after(() => browser.close());
      const captured: string[] = [];
      const newContext = browser.newContext.bind(browser);
      browser.newContext = async () => {
        const context = await newContext();
        await context.exposeFunction("__fixtureCapture", (value: string) => {
          captured.push(value);
        });
        return context;
      };
      let redirects = 0;
      const redirect = async () => {
        redirects++;
        const destination = `${other.origin}/login`;
        await browser
          .contexts()[0]!
          .pages()[0]!
          .goto(
            throughRedirect
              ? `${provider.origin}/authorize?next=${encodeURIComponent(destination)}`
              : destination,
          )
          .catch(() => {});
      };
      const executor = createAuthorizationBrowser({
        open: async () => ({ browser, close: async () => {} }),
        ...(waitingOn === "inference"
          ? {
              interpreter: async (
                input: InterpreterInput,
              ): Promise<InterpreterAction> => {
                const password = input.snapshot.elements.find(
                  (element) => element.type === "password",
                );
                assert.ok(password);
                await redirect();
                return {
                  action: "fill",
                  element: password.index,
                  role: "password",
                };
              },
            }
          : {}),
      });
      const result = await executor.complete({
        startUrl: `${provider.origin}/${waitingOn === "inbox" ? "signup" : "login"}`,
        redirectUri: `${provider.origin}/callback`,
        allowedOrigins: [provider.origin],
        ...(waitingOn === "inbox"
          ? {
              generateAccount: true,
              inbox: {
                provision: async () => "agent@fixture.test",
                latest: async (to: string) => {
                  await redirect();
                  return {
                    to,
                    text: "Your verification code is 246810.",
                    at: Date.now(),
                  };
                },
              },
            }
          : {
              credentials: {
                username: "fixture-user",
                password: "fixture-password",
              },
            }),
        timeoutMs: 2000,
      });
      assert.equal(
        redirects,
        1,
        "The fixture must navigate while private input is pending",
      );
      assert.deepEqual(
        captured,
        [],
        "The other origin must not receive a password or code",
      );
      assert.equal(result.status, "blocked");
      if (result.status === "blocked") assert.equal(result.reason, "origin");
    });
