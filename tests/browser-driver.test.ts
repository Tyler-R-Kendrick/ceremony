import assert from "node:assert/strict";
import { test } from "node:test";
import { MockLanguageModelV3 } from "ai/test";
import { parseHTML } from "linkedom";
import {
  ceremonyRoles,
  driverActionSchema,
  secretRoles,
  snapshotDocument,
  snapshotSelectors,
  type PageSnapshot,
  type SnapshotElement,
} from "../src/core/browser-contracts.js";
import {
  createSecrets,
  runCeremony,
  CeremonySecretLeak,
  type CeremonyPage,
} from "../src/server/browser-driver.js";
import {
  createModelInterpreter,
  interpreterPrompt,
  interpreterRoles,
} from "../src/server/browser-interpreter.js";
import {
  createPlaywrightCeremonyPage,
  type PlaywrightPageLike,
} from "../src/server/browser-page.js";

/**
 * Boundary checks for the ceremony driver that the scenario catalog cannot
 * reach: the model-backed interpreter, the Playwright adapter's mapping, and
 * the driver's refusals on malformed input. Ceremony behaviour itself is
 * covered in `tests/contracts/auth-scenarios.test.ts`.
 */

function snapshot(overrides: Partial<PageSnapshot> = {}): PageSnapshot {
  return {
    path: "https://provider.example/signin",
    title: "Sign in",
    headings: ["Sign in"],
    alerts: [],
    challenge: false,
    passkey: false,
    elements: [
      { index: 0, kind: "input", type: "text", label: "Username" },
      { index: 1, kind: "input", type: "password", label: "Password" },
      { index: 2, kind: "button", text: "Sign in" },
    ],
    ...overrides,
  };
}

/** A page that records what the driver did and never changes. */
function inertPage(url = "https://provider.example/signin"): CeremonyPage & {
  calls: string[];
} {
  const calls: string[] = [];
  return {
    calls,
    url: async () => url,
    goto: async (target) => {
      calls.push(`goto:${target}`);
    },
    snapshot: async () => snapshot(),
    fill: async (element, value) => {
      calls.push(`fill:${element.index}:${value}`);
    },
    click: async (element) => {
      calls.push(`click:${element.index}`);
    },
    check: async (element) => {
      calls.push(`check:${element.index}`);
    },
    settle: async () => {
      calls.push("settle");
    },
  };
}

test("a ceremony cannot run without a usable allowed origin", async () => {
  for (const origins of [[], ["not a url"]])
    await assert.rejects(
      runCeremony({
        page: inertPage(),
        interpreter: async () => ({ action: "wait" }),
        goal: "sign-in",
        secrets: createSecrets({}),
        allowedOrigins: origins,
      }),
      /allowed origin/,
    );
});

test("the driver leaves an origin it was never permitted to act on", async () => {
  const page = inertPage("https://elsewhere.example/signin");
  const result = await runCeremony({
    page,
    interpreter: async () => ({ action: "click", element: 2 }),
    goal: "sign-in",
    secrets: createSecrets({ password: "hunter2xyz" }),
    allowedOrigins: ["https://provider.example"],
  });
  assert.equal(result.status, "blocked");
  assert.equal(
    result.status === "blocked" && result.reason,
    "untrusted-origin",
  );
  assert.deepEqual(page.calls, [], "Nothing is done on an unpermitted origin");
});

test("a redirect carrying an error is reported by its cause", async () => {
  for (const [query, reason] of [
    ["error=access_denied", "consent-denied"],
    ["error=server_error", "provider-error"],
  ] as const) {
    const result = await runCeremony({
      page: inertPage(`https://host.example/callback?${query}`),
      interpreter: async () => ({ action: "wait" }),
      goal: "authorize",
      secrets: createSecrets({}),
      allowedOrigins: ["https://provider.example"],
      redirectUri: "https://host.example/callback",
    });
    assert.equal(result.status, "blocked");
    assert.equal(result.status === "blocked" && result.reason, reason);
  }
});

test("a captured callback keeps its state and is never re-read from the page", async () => {
  const result = await runCeremony({
    page: inertPage("https://host.example/callback?code=abc123&state=s-1"),
    interpreter: async () => {
      throw new Error("The interpreter must not be consulted at the callback");
    },
    goal: "authorize",
    secrets: createSecrets({}),
    allowedOrigins: ["https://provider.example"],
    redirectUri: "https://host.example/callback",
  });
  assert.deepEqual(result, {
    status: "completed",
    steps: 0,
    callback: { code: "abc123", state: "s-1" },
    transcript: [],
    handoffs: 0,
  });
});

test("an action naming an element that is not on the page is discarded", async () => {
  const page = inertPage();
  const result = await runCeremony({
    page,
    interpreter: async () => ({ action: "click", element: 99 }),
    goal: "sign-in",
    secrets: createSecrets({}),
    allowedOrigins: ["https://provider.example"],
    maxSteps: 4,
  });
  assert.equal(result.status, "blocked");
  assert.equal(
    result.status === "blocked" && result.reason,
    "unsupported-page",
  );
  assert.deepEqual(page.calls, []);
});

test("a role the caller declared but cannot resolve stops the attempt", async () => {
  const result = await runCeremony({
    page: inertPage(),
    interpreter: async () => ({ action: "fill", element: 1, role: "password" }),
    goal: "sign-in",
    // The role is declared, so the action is valid; the value never arrives,
    // which is what a mailbox that does not deliver looks like.
    secrets: { roles: ["password"], resolve: async () => undefined },
    allowedOrigins: ["https://provider.example"],
  });
  assert.equal(result.status, "blocked");
  assert.equal(result.status === "blocked" && result.reason, "provider-error");
});

test("a secret is refused when the form posts to an origin outside the ceremony", async () => {
  const page: CeremonyPage = {
    ...inertPage(),
    snapshot: async () =>
      snapshot({
        elements: [
          {
            index: 0,
            kind: "input",
            type: "password",
            label: "Password",
            submitsTo: "https://collector.example",
          },
        ],
      }),
  };
  const result = await runCeremony({
    page,
    interpreter: async () => ({ action: "fill", element: 0, role: "password" }),
    goal: "sign-in",
    secrets: createSecrets({ password: "hunter2xyz" }),
    allowedOrigins: ["https://provider.example"],
  });
  assert.equal(result.status, "blocked");
  assert.equal(
    result.status === "blocked" && result.reason,
    "untrusted-origin",
  );
});

test("a snapshot that reproduces a protected value fails the attempt", async () => {
  await assert.rejects(
    runCeremony({
      page: {
        ...inertPage(),
        snapshot: async () =>
          snapshot({ alerts: ["Your password hunter2xyz was rejected"] }),
      },
      interpreter: async () => ({ action: "wait" }),
      goal: "sign-in",
      secrets: createSecrets({ password: "hunter2xyz" }),
      allowedOrigins: ["https://provider.example"],
      protectedValues: ["hunter2xyz"],
    }),
    (error: Error) => {
      assert.ok(error instanceof CeremonySecretLeak);
      assert.match(error.message, /page snapshot/);
      return true;
    },
  );
});

test("waiting follows a confirmation link only on a permitted origin", async () => {
  for (const [link, expected] of [
    [
      "https://provider.example/confirm/t1",
      ["goto:https://provider.example/confirm/t1"],
    ],
    ["https://elsewhere.example/confirm/t1", ["settle"]],
  ] as const) {
    const page = inertPage();
    await runCeremony({
      page,
      interpreter: async () => ({ action: "wait" }),
      goal: "registration",
      secrets: createSecrets({}),
      allowedOrigins: ["https://provider.example"],
      confirmationLink: async () => link,
      maxSteps: 1,
    });
    assert.deepEqual(page.calls, [...expected]);
  }
});

test("createSecrets resolves fixed values and per-call sources", async () => {
  let issued = 0;
  const secrets = createSecrets({
    password: "fixed-value",
    "verification-code": async () => `code-${++issued}`,
  });
  assert.deepEqual([...secrets.roles].sort(), [
    "password",
    "verification-code",
  ]);
  assert.equal(await secrets.resolve("password"), "fixed-value");
  assert.equal(await secrets.resolve("verification-code"), "code-1");
  assert.equal(await secrets.resolve("verification-code"), "code-2");
  assert.equal(await secrets.resolve("email"), undefined);
});

test("the interpreter prompt describes the page without disclosing a value", () => {
  const prompt = interpreterPrompt({
    goal: "registration",
    snapshot: snapshot(),
    available: ["email", "password"],
    history: [{ action: "click", note: "to-signup" }],
  });
  assert.match(prompt, /create an account/);
  assert.match(prompt, /Available roles: email, password/);
  assert.ok(prompt.includes(JSON.stringify(snapshot())));
  // The page is described; no value a caller supplied is ever written into it.
  for (const forbidden of ["hunter2xyz", "owner@", "123456"])
    assert.ok(
      !prompt.includes(forbidden),
      `The prompt must not contain ${forbidden}`,
    );
  assert.deepEqual([...interpreterRoles], [...ceremonyRoles]);
  for (const goal of ["sign-in", "authorize"] as const)
    assert.ok(
      interpreterPrompt({
        goal,
        snapshot: snapshot(),
        available: [],
        history: [],
      }).includes("Available roles: none"),
    );
});

type MockSettings = ConstructorParameters<typeof MockLanguageModelV3>[0];
type Generate = Extract<
  NonNullable<NonNullable<MockSettings>["doGenerate"]>,
  (...args: never[]) => unknown
>;
const inputTokens = { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 };
const outputTokens = { total: 1, text: 1, reasoning: 0 };

function modelReturning(text: string): MockLanguageModelV3 {
  const doGenerate: Generate = async () => ({
    content: [{ type: "text", text }],
    finishReason: { unified: "stop", raw: "stop" },
    usage: { inputTokens, outputTokens, totalTokens: 2 },
    warnings: [],
  });
  return new MockLanguageModelV3({ doGenerate });
}

test("the model interpreter returns only actions that parse and use offered roles", async () => {
  const input = {
    goal: "sign-in" as const,
    snapshot: snapshot(),
    available: ["password"] as const,
    history: [],
  };
  const accepted = await createModelInterpreter(
    modelReturning(
      JSON.stringify({ action: "fill", element: 1, role: "password" }),
    ),
  )(input);
  assert.deepEqual(accepted, { action: "fill", element: 1, role: "password" });

  // A role the caller never offered, an unknown shape, and a provider failure
  // are all the same thing to the driver: no usable proposal.
  const refused = [
    JSON.stringify({ action: "fill", element: 1, role: "totp-code" }),
    JSON.stringify({ action: "sudo", element: 1 }),
    "not json at all",
  ];
  for (const text of refused)
    assert.equal(
      await createModelInterpreter(modelReturning(text))(input),
      undefined,
      `${text} must not become an action`,
    );
  assert.equal(
    await createModelInterpreter(
      new MockLanguageModelV3({
        doGenerate: (async () => {
          throw new Error("provider unavailable");
        }) satisfies Generate,
      }),
    )(input),
    undefined,
  );
});

test("every role the action schema accepts is one the driver can substitute", () => {
  for (const role of ceremonyRoles)
    assert.ok(
      driverActionSchema.safeParse({ action: "fill", element: 0, role })
        .success,
      `${role} must be expressible`,
    );
  for (const role of secretRoles)
    assert.ok(ceremonyRoles.includes(role), `${role} must be a known role`);
  assert.equal(
    driverActionSchema.safeParse({ action: "fill", role: "nickname" }).success,
    false,
  );
});

test("the Playwright adapter addresses exactly the element the snapshot named", async () => {
  const calls: string[] = [];
  const fake: PlaywrightPageLike = {
    url: () => "https://provider.example/signin",
    goto: async (target) => {
      calls.push(`goto ${target}`);
      return undefined;
    },
    evaluate: async (source) => {
      calls.push(source.includes("data-ceremony-index") ? "snapshot" : "other");
      return snapshot();
    },
    fill: async (selector, value) => {
      calls.push(`fill ${selector} ${value}`);
    },
    selectOption: async (selector, value) => {
      calls.push(`select ${selector} ${value}`);
      return [];
    },
    check: async (selector) => {
      calls.push(`check ${selector}`);
    },
    click: async (selector) => {
      calls.push(`click ${selector}`);
    },
    waitForLoadState: async (state) => {
      calls.push(`settle ${state}`);
    },
  };
  const page = createPlaywrightCeremonyPage(fake);
  const input: SnapshotElement = { index: 3, kind: "input" };
  const choice: SnapshotElement = { index: 4, kind: "select" };
  assert.equal(await page.url(), "https://provider.example/signin");
  await page.goto("https://provider.example/confirm");
  assert.deepEqual(await page.snapshot(), snapshot());
  await page.fill(input, "value-1");
  await page.fill(choice, "1990");
  await page.check({ index: 5, kind: "checkbox" });
  await page.click({ index: 6, kind: "button" });
  await page.settle();
  assert.deepEqual(calls, [
    "goto https://provider.example/confirm",
    "snapshot",
    'fill [data-ceremony-index="3"] value-1',
    'select [data-ceremony-index="4"] 1990',
    'check [data-ceremony-index="5"]',
    'click [data-ceremony-index="6"]',
    "settle networkidle",
  ]);
});

test("a page that never settles is the driver's problem, not the adapter's", async () => {
  const page = createPlaywrightCeremonyPage({
    url: () => "https://provider.example/",
    goto: async () => undefined,
    evaluate: async () => snapshot(),
    fill: async () => undefined,
    selectOption: async () => [],
    check: async () => undefined,
    click: async () => undefined,
    waitForLoadState: async () => {
      throw new Error("Timeout 5000ms exceeded");
    },
  });
  await assert.doesNotReject(page.settle());
});

test("a snapshot excludes hidden fields and reports a cross-origin form target", () => {
  const { document } = parseHTML(
    `<!doctype html><html><body>
       <form action="https://collector.example/post" method="post">
         <input type="hidden" name="csrf" value="t">
         <label for="p">Password</label><input id="p" name="p" type="password" required>
         <button type="submit">Sign in</button>
       </form>
       <div data-captcha="1">Prove you are human</div>
     </body></html>`,
  );
  document.documentElement.setAttribute(
    "data-ceremony-href",
    "https://provider.example/signin",
  );
  const seen: number[] = [];
  const result = snapshotDocument(
    document as unknown as Document,
    snapshotSelectors,
    (_element, index) => seen.push(index),
  );
  assert.equal(result.path, "https://provider.example/signin");
  assert.equal(result.challenge, true);
  assert.deepEqual(
    result.elements.map((element) => element.kind),
    ["input", "button"],
  );
  assert.equal(result.elements[0]?.submitsTo, "https://collector.example");
  assert.equal(result.elements[0]?.label, "Password");
  assert.deepEqual(seen, [0, 1]);
});

test("a snapshot names controls a form can carry beyond plain text inputs", () => {
  const { document } = parseHTML(
    `<!doctype html><html><body>
       <span id="dob">Date of birth</span>
       <form action="/account">
         <select name="year" aria-labelledby="dob">
           <option>1989</option><option>1990</option>
         </select>
         <input type="submit" name="go" value="Create account">
         <a href="/help" title="Get help"></a>
       </form>
     </body></html>`,
  );
  document.documentElement.setAttribute(
    "data-ceremony-href",
    "https://provider.example/signup",
  );
  const result = snapshotDocument(
    document as unknown as Document,
    snapshotSelectors,
  );
  const [choice, submit, help] = result.elements;
  assert.equal(choice?.kind, "select");
  assert.equal(choice?.label, "Date of birth");
  assert.deepEqual(choice?.options, ["1989", "1990"]);
  assert.equal(choice?.filled, false);
  // A submit control with no text still needs a caption an interpreter can read.
  assert.equal(submit?.kind, "button");
  assert.equal(submit?.text, "Create account");
  assert.equal(help?.kind, "link");
  assert.equal(help?.text, "Get help");
  // A same-origin form target is implied, never repeated into every element.
  assert.ok(
    result.elements.every((element) => element.submitsTo === undefined),
  );
});

test("a document with no address reports an unknown form target rather than guessing", () => {
  const { document } = parseHTML(
    `<!doctype html><html><body><form action="/post">
       <input name="p" type="password"></form></body></html>`,
  );
  const result = snapshotDocument(
    document as unknown as Document,
    snapshotSelectors,
  );
  assert.equal(result.path, "");
  assert.equal(result.elements[0]?.submitsTo, "unknown");
});

test("a snapshot stops at the element cap instead of growing without bound", () => {
  const { document } = parseHTML(
    `<!doctype html><html><body>${'<input type="text" name="a">'.repeat(80)}</body></html>`,
  );
  const result = snapshotDocument(
    document as unknown as Document,
    snapshotSelectors,
  );
  assert.equal(result.elements.length, 60);
});
