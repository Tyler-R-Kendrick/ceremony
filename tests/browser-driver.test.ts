import assert from "node:assert/strict";
import { test } from "node:test";
import { MockLanguageModelV3 } from "ai/test";
import { parseHTML } from "linkedom";
import {
  ceremonyRoles,
  deviceVerificationField,
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
  runRecordedCeremony,
  CeremonySecretLeak,
  type CeremonyPage,
  type HumanParticipationRequest,
} from "../src/server/browser-driver.js";
import { compileRecording } from "../src/core/recorded-ceremony.js";
import type { RecordedTraceEntry } from "../src/core/recorded-ceremony.js";
import {
  createHeuristicInterpreter,
  createModelInterpreter,
  interpreterPrompt,
  interpreterRoles,
  type CeremonyInterpreter,
  type InterpreterInput,
} from "../src/server/browser-interpreter.js";
import {
  createPlaywrightCeremonyPage,
  DispatchUncertain,
  StaleTargetError,
  type PlaywrightPageLike,
} from "../src/server/browser-page.js";
import type { BoundPageLike } from "../src/server/browser-targets.js";

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

test("a path that merely starts like the callback is not the callback", async () => {
  // `/callbackx` shares a prefix with `/callback` and is a different endpoint.
  // Accepting it would let a code the ceremony never nominated finish the run.
  const result = await runCeremony({
    page: inertPage("https://host.example/callbackx?code=not-ours"),
    interpreter: async () => ({
      action: "blocked",
      reason: "unsupported-page",
    }),
    goal: "authorize",
    secrets: createSecrets({}),
    allowedOrigins: ["https://host.example"],
    redirectUri: "https://host.example/callback",
  });
  assert.equal(result.status, "blocked");
  assert.equal(
    result.status === "blocked" && result.reason,
    "unsupported-page",
  );

  // A different origin with the same path is equally not the callback.
  const elsewhere = await runCeremony({
    page: inertPage("https://evil.example/callback?code=not-ours"),
    interpreter: async () => ({ action: "wait" }),
    goal: "authorize",
    secrets: createSecrets({}),
    allowedOrigins: ["https://host.example"],
    redirectUri: "https://host.example/callback",
  });
  assert.equal(elsewhere.status, "blocked");
  assert.equal(
    elsewhere.status === "blocked" && elsewhere.reason,
    "untrusted-origin",
  );
});

test("waiting that moves the page is progress, not a stall", async () => {
  // The action path resets the stall counter when the page changes; waiting
  // must too. Otherwise a ceremony that alternates — a wait that changes
  // nothing, then one that does — accumulates its way to a false `stalled`
  // while it is in fact moving.
  let turn = 0;
  const page: CeremonyPage = {
    url: async () => "https://provider.example/pending",
    goto: async () => {},
    // Every other settle genuinely advances the page. The change has to be in
    // something `fingerprint` reads — it ignores headings by design, so a page
    // whose heading alone moves is correctly considered unchanged.
    snapshot: async () =>
      snapshot({
        path: "https://provider.example/pending",
        alerts: [`Working, step ${Math.floor(turn / 2)}`],
        elements: [],
      }),
    fill: async () => {},
    click: async () => {},
    check: async () => {},
    settle: async () => {
      turn++;
    },
  };
  const result = await runCeremony({
    page,
    interpreter: async () => ({ action: "wait" }),
    goal: "sign-in",
    secrets: createSecrets({}),
    allowedOrigins: ["https://provider.example"],
    maxSteps: 12,
  });
  // It runs out of steps rather than being called stalled: progress was real.
  assert.equal(result.status, "exhausted");
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

test("the heuristic fills offered registration and verification roles without seeing their values", async () => {
  const interpret = createHeuristicInterpreter();
  const elements: SnapshotElement[] = [
    { index: 0, kind: "input", type: "email", label: "Email" },
    { index: 1, kind: "input", name: "username" },
    { index: 2, kind: "input", placeholder: "Your name" },
    { index: 3, kind: "select", label: "Date of birth" },
    { index: 4, kind: "input", type: "password" },
    { index: 5, kind: "input", type: "password" },
    { index: 6, kind: "input", label: "Verification code" },
    { index: 7, kind: "input", label: "Authenticator code" },
  ];
  const roles = [
    "email",
    "username",
    "display-name",
    "birth-date",
    "password",
    "password-confirm",
    "verification-code",
    "totp-code",
  ] as const;
  for (const [index, role] of roles.entries()) {
    assert.deepEqual(
      await interpret({
        goal: "registration",
        snapshot: snapshot({ elements }),
        available: roles,
        history: [],
      }),
      { action: "fill", element: index, role },
    );
    elements[index]!.filled = true;
  }
  assert.deepEqual(
    await interpret({
      goal: "registration",
      snapshot: snapshot({
        elements: [{ index: 9, kind: "input", label: "Repeat password" }],
      }),
      available: ["password-confirm"],
      history: [],
    }),
    { action: "fill", element: 9, role: "password-confirm" },
  );
});

test("the heuristic stops at provider walls and does not fill unavailable or cross-origin inputs", async () => {
  const interpret = createHeuristicInterpreter();
  const base: InterpreterInput = {
    goal: "sign-in",
    snapshot: snapshot(),
    available: ["password"],
    history: [],
  };
  for (const [page, available, reason] of [
    [{ challenge: true }, ["password"], "human-challenge"],
    [{ passkey: true }, [], "passkey-required"],
    [
      { alerts: ["Account already registered"] },
      ["password"],
      "account-exists",
    ],
    [{ alerts: ["Incorrect password"] }, ["password"], "credentials-rejected"],
  ] satisfies Array<
    [Partial<PageSnapshot>, InterpreterInput["available"], string]
  >) {
    assert.deepEqual(
      await interpret({
        ...base,
        snapshot: snapshot(page),
        available,
      }),
      { action: "blocked", reason },
    );
  }
  assert.deepEqual(
    await interpret({ ...base, snapshot: snapshot({ passkey: true }) }),
    { action: "fill", element: 1, role: "password" },
  );
  assert.deepEqual(
    await interpret({
      ...base,
      snapshot: snapshot({
        elements: [
          { index: 0, kind: "input", label: "Unknown field" },
          { index: 1, kind: "input", type: "email" },
          { index: 2, kind: "input", type: "password", filled: true },
          {
            index: 3,
            kind: "input",
            type: "password",
            submitsTo: "https://outside.example",
          },
          { index: 4, kind: "checkbox", required: false },
          { index: 5, kind: "checkbox", required: true, filled: true },
          { index: 6, kind: "checkbox", required: true, filled: false },
        ],
      }),
      available: ["password", "password-confirm"],
    }),
    { action: "check", element: 6 },
  );
});

test("the heuristic follows the goal's alternative link without repeating a clicked action", async () => {
  const interpret = createHeuristicInterpreter();
  const here = "https://provider.example/signin";
  // Registration leaves a sign-in page for its sign-up link before pressing
  // anything; that order is covered by its own test below.
  for (const [goal, label] of [
    ["sign-in", "Already have an account? Log in"],
    ["authorize", "Allow access"],
    ["obtain-credential", "New personal access token"],
  ] as const) {
    const input: InterpreterInput = {
      goal,
      snapshot: snapshot({
        elements: [
          { index: 0, kind: "button", text: "Continue" },
          { index: 1, kind: "button", text: "Help" },
          { index: 2, kind: "link", text: "Privacy policy" },
          { index: 3, kind: "link", text: label },
        ],
      }),
      available: [],
      history: [],
    };
    assert.deepEqual(await interpret(input), {
      action: "click",
      element: 0,
      note: "Continue",
    });
    // The history the driver actually records: each entry says which document
    // it happened on, because that is what makes "already pressed" mean
    // anything.
    input.history = [
      { action: "fill", path: here },
      { action: "click", note: "Continue", path: here },
    ];
    assert.deepEqual(await interpret(input), {
      action: "click",
      element: 3,
      note: label,
    });
    input.history = [
      ...input.history,
      { action: "click", note: label, path: here },
    ];
    assert.deepEqual(await interpret(input), { action: "wait" });
    input.history = [...input.history, { action: "wait", path: here }];
    assert.deepEqual(await interpret(input), {
      action: "blocked",
      reason: "unsupported-page",
    });
  }
});

test("the heuristic swaps in another address only when registration declared it can obtain one", async () => {
  const interpret = createHeuristicInterpreter();
  const here = "https://provider.example/join";
  const page = snapshot({
    path: here,
    alerts: ["That email address is already in use."],
    elements: [
      { index: 0, kind: "input", type: "email", label: "Email", filled: true },
      { index: 1, kind: "input", type: "password", label: "Password" },
      { index: 2, kind: "button", text: "Join" },
    ],
  });
  const refused = [
    { action: "fill", path: here },
    { action: "click", note: "Join", path: here },
  ];
  const swap = {
    action: "fill",
    element: 0,
    role: "alternate-email",
    note: "retry-address",
  };
  // Without the declared role, or outside registration, a taken address is a wall.
  for (const [goal, available] of [
    ["registration", ["email", "password"]],
    ["sign-in", ["email", "password", "alternate-email"]],
  ] as const)
    assert.deepEqual(
      await interpret({ goal, snapshot: page, available, history: refused }),
      { action: "blocked", reason: "account-exists" },
    );
  const available = ["email", "password", "alternate-email"] as const;
  // Refused, even with the old address still in the field: swap it.
  assert.deepEqual(
    await interpret({
      goal: "registration",
      snapshot: page,
      available,
      history: refused,
    }),
    swap,
  );
  // Swapped and not yet submitted: refill the rest, then press the same
  // button again, because the form it would submit has changed.
  const swapped = [
    ...refused,
    { action: "fill", note: "retry-address", path: here },
  ];
  assert.deepEqual(
    await interpret({
      goal: "registration",
      snapshot: page,
      available,
      history: swapped,
    }),
    { action: "fill", element: 1, role: "password" },
  );
  assert.deepEqual(
    await interpret({
      goal: "registration",
      snapshot: snapshot({
        ...page,
        elements: page.elements.map((element) => ({
          ...element,
          ...(element.kind === "input" ? { filled: true } : {}),
        })),
      }),
      available,
      history: [...swapped, { action: "fill", path: here }],
    }),
    { action: "click", element: 2, note: "Join" },
  );
  // Refused again after a second swap: two replacements is the limit.
  const twice = [
    ...swapped,
    { action: "click", note: "Join", path: here },
    { action: "fill", note: "retry-address", path: here },
    { action: "click", note: "Join", path: here },
  ];
  assert.deepEqual(
    await interpret({
      goal: "registration",
      snapshot: page,
      available,
      history: twice,
    }),
    { action: "blocked", reason: "account-exists" },
  );
});

test("the heuristic never presses a way back, and presses a lone unnamed submit only for input it just gave", async () => {
  const interpret = createHeuristicInterpreter();
  const here = "https://provider.example/join";
  const page = snapshot({
    path: here,
    elements: [
      { index: 0, kind: "input", type: "email", label: "Email", filled: true },
      { index: 1, kind: "button", text: "Resend confirmation" },
      { index: 2, kind: "button", text: "Cancel" },
      { index: 3, kind: "button", text: "Let's go" },
    ],
  });
  assert.deepEqual(
    await interpret({
      goal: "registration",
      snapshot: page,
      available: ["email"],
      history: [{ action: "fill", path: here }],
    }),
    { action: "click", element: 3, note: "Let's go" },
  );
  // Nothing filled here since the last press: no guessing at a lone button.
  assert.deepEqual(
    await interpret({
      goal: "registration",
      snapshot: page,
      available: ["email"],
      history: [
        { action: "fill", path: here },
        { action: "click", note: "Let's go", path: here },
      ],
    }),
    { action: "wait" },
  );
});

test("the heuristic ticks terms only to register, and waits longer only for mail", async () => {
  const interpret = createHeuristicInterpreter();
  const terms = snapshot({
    elements: [
      { index: 0, kind: "checkbox", label: "I agree to the Terms of Service" },
      { index: 1, kind: "checkbox", label: "Send me offers" },
    ],
  });
  assert.deepEqual(
    await interpret({
      goal: "registration",
      snapshot: terms,
      available: [],
      history: [],
    }),
    { action: "check", element: 0 },
  );
  assert.deepEqual(
    await interpret({
      goal: "sign-in",
      snapshot: terms,
      available: [],
      history: [],
    }),
    { action: "wait" },
  );
  const inbox = snapshot({
    title: "Almost there",
    headings: ["Check your inbox to confirm the account."],
    elements: [],
  });
  const waited = (count: number) =>
    Array.from({ length: count }, () => ({ action: "wait" }));
  assert.deepEqual(
    await interpret({
      goal: "registration",
      snapshot: inbox,
      available: [],
      history: waited(3),
    }),
    { action: "wait" },
  );
  assert.deepEqual(
    await interpret({
      goal: "registration",
      snapshot: inbox,
      available: [],
      history: waited(4),
    }),
    { action: "blocked", reason: "unsupported-page" },
  );
});

test("registering from a sign-in page follows the sign-up link before typing anything", async () => {
  const interpret = createHeuristicInterpreter();
  const available = [
    "email",
    "username",
    "password",
    "password-confirm",
  ] as const;
  // A sign-in form: filling it would post the brand-new password to the
  // provider's sign-in endpoint, a wasted and possibly lockout-counting try.
  const signIn = snapshot({
    title: "Account access",
    headings: ["Account access"],
    elements: [
      { index: 0, kind: "input", type: "password", label: "Your password" },
      { index: 1, kind: "input", type: "text", label: "Username" },
      { index: 2, kind: "button", text: "Next" },
      { index: 3, kind: "link", text: "Sign up" },
    ],
  });
  assert.deepEqual(
    await interpret({
      goal: "registration",
      snapshot: signIn,
      available,
      history: [],
    }),
    { action: "click", element: 3, note: "Sign up" },
  );
  // Once followed, the link is not pressed again from the same page.
  assert.deepEqual(
    await interpret({
      goal: "registration",
      snapshot: signIn,
      available,
      history: [{ action: "click", note: "Sign up", path: signIn.path }],
    }),
    { action: "fill", element: 0, role: "password" },
  );
  // Signing in is still what a sign-in page is for.
  assert.deepEqual(
    await interpret({
      goal: "sign-in",
      snapshot: signIn,
      available,
      history: [],
    }),
    { action: "fill", element: 0, role: "password" },
  );
  // A registration form that also links elsewhere is filled, not left.
  for (const form of [
    { headings: ["Create your account"] },
    {
      headings: ["Welcome"],
      elements: [
        { index: 0, kind: "input", type: "password", label: "Password" },
        { index: 1, kind: "input", type: "password", label: "Password" },
        { index: 2, kind: "link", text: "Create an account" },
      ],
    },
  ] satisfies Partial<PageSnapshot>[])
    assert.equal(
      (
        await interpret({
          goal: "registration",
          snapshot: snapshot({
            elements: [
              { index: 0, kind: "input", type: "password", label: "Password" },
              { index: 1, kind: "link", text: "Sign up" },
            ],
            ...form,
          }),
          available,
          history: [],
        })
      )?.action,
      "fill",
    );
});

test("a button with the same label on the next document is not already pressed", async () => {
  // The defect this pins cost every identifier-first provider. Step one and
  // step two of such a flow both carry a button reading "Sign in" - so did
  // "Continue" and "Next" everywhere else - and the interpreter suppressed the
  // second because it remembered the label rather than the button. The driver
  // filled the password and then declined to submit it.
  const interpret = createHeuristicInterpreter();
  const first = "https://provider.example/signin-identifier";
  const second = "https://provider.example/signin-password";
  const elements: PageSnapshot["elements"] = [
    {
      index: 0,
      kind: "input",
      type: "password",
      label: "Password",
      filled: true,
    },
    { index: 1, kind: "button", text: "Sign in" },
  ];
  const history = [
    { action: "fill", path: first },
    { action: "click", note: "Sign in", path: first },
    { action: "fill", path: second },
  ];

  assert.deepEqual(
    await interpret({
      goal: "sign-in",
      available: ["password"],
      history,
      snapshot: snapshot({ path: second, elements }),
    }),
    { action: "click", element: 1, note: "Sign in" },
    "the second document's submit button must be offered",
  );

  // And the guard it replaces still holds: pressed on *this* document, it is
  // not offered again, so a dead button is still not pressed twice.
  assert.notDeepEqual(
    await interpret({
      goal: "sign-in",
      available: ["password"],
      history: [...history, { action: "click", note: "Sign in", path: second }],
      snapshot: snapshot({ path: second, elements }),
    }),
    { action: "click", element: 1, note: "Sign in" },
  );
});

test("an 'Email or username' field gets whichever identifier the caller holds", async () => {
  // The defect behind a recorded demo that signed nobody in: a field reading
  // "Email or username" matched the address pattern, the caller held only a
  // username, and the field was skipped - the form went in with its
  // identifier empty.
  const interpret = createHeuristicInterpreter();
  const elements: SnapshotElement[] = [
    {
      index: 0,
      kind: "input",
      type: "text",
      name: "username",
      autocomplete: "username",
      label: "Email or username",
    },
    {
      index: 1,
      kind: "input",
      type: "password",
      name: "password",
      autocomplete: "current-password",
      label: "Password",
    },
    { index: 2, kind: "button", text: "Sign in" },
  ];
  for (const [available, role] of [
    [["username", "password"], "username"],
    [["email", "password"], "email"],
    [["email", "username", "password"], "email"],
  ] as const)
    assert.deepEqual(
      await interpret({
        goal: "sign-in",
        snapshot: snapshot({ elements }),
        available,
        history: [],
      }),
      { action: "fill", element: 0, role },
      `offered ${available.join(", ")}`,
    );
  // Without an autocomplete hint the wording alone still says "either".
  assert.deepEqual(
    await interpret({
      goal: "sign-in",
      snapshot: snapshot({
        elements: [
          { index: 0, kind: "input", type: "text", label: "Username or email" },
        ],
      }),
      available: ["username"],
      history: [],
    }),
    { action: "fill", element: 0, role: "username" },
  );
});

test("the heuristic reads a field's autocomplete token before its wording", async () => {
  // Real pages publish what a field is for in `autocomplete`. It separates a
  // new password from the current one and an authenticator's code from a
  // mailed one where the visible label ("Password", "Authentication code")
  // does not.
  const interpret = createHeuristicInterpreter();
  // Labels that say nothing a pattern could use: only the token decides.
  const registration: SnapshotElement[] = [
    { index: 0, kind: "input", label: "Name", autocomplete: "name" },
    {
      index: 1,
      kind: "input",
      type: "text",
      label: "Work address",
      autocomplete: "email",
    },
    {
      index: 2,
      kind: "input",
      type: "password",
      label: "Password",
      autocomplete: "new-password",
    },
    {
      index: 3,
      kind: "input",
      type: "password",
      label: "Re-enter it",
      autocomplete: "new-password",
    },
  ];
  const roles = [
    "display-name",
    "email",
    "password",
    "password-confirm",
  ] as const;
  for (const [index, role] of roles.entries()) {
    assert.deepEqual(
      await interpret({
        goal: "registration",
        snapshot: snapshot({ elements: registration }),
        available: roles,
        history: [],
      }),
      { action: "fill", element: index, role },
    );
    registration[index]!.filled = true;
  }
  for (const [label, role] of [
    ["Authentication code", "totp-code"],
    ["Verification code", "verification-code"],
    ["Enter the digits", "verification-code"],
  ] as const)
    assert.deepEqual(
      await interpret({
        goal: "sign-in",
        snapshot: snapshot({
          elements: [
            {
              index: 0,
              kind: "input",
              type: "text",
              label,
              autocomplete: "one-time-code",
            },
          ],
        }),
        available: ["totp-code", "verification-code"],
        history: [],
      }),
      { action: "fill", element: 0, role },
      label,
    );
});

test("the heuristic tells an authenticator's code from a mailed one by the page around it", async () => {
  // "One-time code" and "Enter code" say nothing about where the code comes
  // from. Guessing the mailed one stopped every two-factor sign-in whose
  // caller held only an authenticator: the field was skipped and the empty
  // form submitted.
  const interpret = createHeuristicInterpreter();
  const codeField = (label: string): SnapshotElement[] => [
    { index: 0, kind: "input", type: "text", label, required: true },
    { index: 1, kind: "button", text: "Continue" },
  ];
  for (const [page, label, available, role] of [
    // The page says two-factor.
    [
      { headings: ["Enter your Two-factor code"] },
      "One-time code",
      ["totp-code", "verification-code"],
      "totp-code",
    ],
    [
      { title: "Two-factor authentication", headings: [] },
      "Enter code",
      ["totp-code", "verification-code"],
      "totp-code",
    ],
    // The page says a message was sent, whatever the field is called.
    [
      { headings: ["Check your inbox to confirm the account."] },
      "One-time code",
      ["totp-code", "verification-code"],
      "verification-code",
    ],
    [
      { headings: ["We sent you a confirmation message."] },
      "6-digit code",
      ["totp-code", "verification-code"],
      "verification-code",
    ],
    // The field itself says.
    [{ headings: [] }, "Two-factor code", ["verification-code"], "totp-code"],
    // Nothing says: the one code the caller can supply.
    [{ headings: [] }, "6-digit code", ["totp-code"], "totp-code"],
    [
      { headings: [] },
      "6-digit code",
      ["verification-code"],
      "verification-code",
    ],
  ] satisfies Array<
    [Partial<PageSnapshot>, string, InterpreterInput["available"], string]
  >)
    assert.deepEqual(
      await interpret({
        goal: "sign-in",
        snapshot: snapshot({ ...page, elements: codeField(label) }),
        available,
        history: [],
      }),
      available.includes(role as never)
        ? { action: "fill", element: 0, role }
        : { action: "click", element: 1, note: "Continue" },
      `${label} under ${JSON.stringify(page)}`,
    );
});

test("the heuristic recognises the usual ways of naming a sign-in identifier", async () => {
  const interpret = createHeuristicInterpreter();
  for (const label of [
    "Account name",
    "Sign-in name",
    "Login ID",
    "Login name",
    "Handle",
  ])
    assert.deepEqual(
      await interpret({
        goal: "sign-in",
        snapshot: snapshot({
          elements: [{ index: 0, kind: "input", type: "text", label }],
        }),
        available: ["username", "password"],
        history: [],
      }),
      { action: "fill", element: 0, role: "username" },
      label,
    );
  // The name of the thing a ceremony creates is the caller's display name,
  // never left empty under a "Create" button.
  for (const label of ["Application name", "Token name"])
    assert.deepEqual(
      await interpret({
        goal: "obtain-credential",
        snapshot: snapshot({
          elements: [
            { index: 0, kind: "input", type: "text", label, required: true },
            { index: 1, kind: "button", text: "Create application" },
          ],
        }),
        available: ["display-name"],
        history: [],
      }),
      { action: "fill", element: 0, role: "display-name" },
      label,
    );
});

test("after a provider fault the heuristic retries through the provider's own link", async () => {
  // A provider that failed a sign-in shows an error and a way back. Taking it
  // loads the same sign-in path again, and the button pressed before the
  // fault must be pressable again: the earlier submission never reached a
  // working provider.
  const interpret = createHeuristicInterpreter();
  const path = "https://provider.example/signin";
  assert.deepEqual(
    await interpret({
      goal: "sign-in",
      available: ["username", "password"],
      history: [{ action: "click", note: "Sign in", path }],
      snapshot: snapshot({
        alerts: ["Sign-in is temporarily unavailable. Try again."],
        elements: [{ index: 0, kind: "link", text: "Try again" }],
      }),
    }),
    { action: "click", element: 0, note: "Try again" },
  );
  assert.deepEqual(
    await interpret({
      goal: "sign-in",
      available: ["username", "password"],
      history: [
        { action: "fill", path },
        { action: "fill", path },
        { action: "click", note: "Sign in", path },
        { action: "click", note: "Try again", path },
        { action: "fill", path },
        { action: "fill", path },
      ],
      snapshot: snapshot({
        elements: [
          {
            index: 0,
            kind: "input",
            type: "text",
            label: "Username",
            filled: true,
          },
          {
            index: 1,
            kind: "input",
            type: "password",
            label: "Password",
            filled: true,
          },
          { index: 2, kind: "button", text: "Sign in" },
        ],
      }),
    }),
    { action: "click", element: 2, note: "Sign in" },
  );
  // Without a failure on the page, a retry-looking link is not followed.
  assert.notDeepEqual(
    await interpret({
      goal: "sign-in",
      available: [],
      history: [],
      snapshot: snapshot({
        elements: [{ index: 0, kind: "link", text: "Try again" }],
      }),
    }),
    { action: "click", element: 0, note: "Try again" },
  );
});

test("a passkey hint on an identifier field alone is conditional UI, not a prompt", async () => {
  // Step one of an identifier-first page asks for the address only, and a
  // provider offering conditional passkey UI puts `webauthn` on that field.
  // There is no password box yet, and nothing about the page needs a person:
  // handing off here stopped every such provider at its first page.
  const identifierStep = snapshot({
    passkey: true,
    elements: [
      {
        index: 0,
        kind: "input",
        type: "text",
        label: "Email or username",
        autocomplete: "username webauthn",
      },
      { index: 1, kind: "button", text: "Next" },
    ],
  });
  const page = inertPage();
  page.snapshot = async () => identifierStep;
  let consulted = 0;
  const result = await runCeremony({
    page,
    goal: "sign-in",
    allowedOrigins: ["https://provider.example"],
    interpreter: async () => {
      consulted++;
      return { action: "blocked", reason: "unsupported-page" };
    },
    secrets: createSecrets({ username: "casey" }),
  });
  assert.equal(consulted, 1, "the interpreter must be asked, not a person");
  assert.equal(
    result.status === "blocked" && result.reason,
    "unsupported-page",
  );
  assert.equal(result.handoffs, 0);

  // A field carrying a bare `webauthn` token is the authenticator's own
  // prompt, not an identifier: conditional UI is spelled `username webauthn`.
  // Taking any webauthn field for conditional UI pressed "Continue" on an
  // authenticator-only page instead of handing it to a person.
  const authenticatorOnly = inertPage();
  authenticatorOnly.snapshot = async () =>
    snapshot({
      passkey: true,
      elements: [
        {
          index: 0,
          kind: "input",
          type: "text",
          label: "Passkey",
          name: "credential",
          autocomplete: "webauthn",
        },
        { index: 1, kind: "button", text: "Continue" },
      ],
    });
  const walled = await runCeremony({
    page: authenticatorOnly,
    goal: "sign-in",
    allowedOrigins: ["https://provider.example"],
    interpreter: async () => {
      throw new Error("An authenticator-only page must not be interpreted");
    },
    secrets: createSecrets({ username: "casey", password: "hunter2xyz" }),
  });
  assert.equal(
    walled.status === "blocked" && walled.reason,
    "passkey-required",
  );
  assert.deepEqual(authenticatorOnly.calls, [], "nothing is pressed or typed");

  // A prompt with nothing to type is still a person's step.
  const prompt = inertPage();
  prompt.snapshot = async () =>
    snapshot({
      passkey: true,
      elements: [{ index: 0, kind: "button", text: "Continue with passkey" }],
    });
  const handedOff = await runCeremony({
    page: prompt,
    goal: "sign-in",
    allowedOrigins: ["https://provider.example"],
    interpreter: async () => {
      throw new Error("A passkey prompt must never reach the interpreter");
    },
    secrets: createSecrets({ username: "casey" }),
  });
  assert.equal(
    handedOff.status === "blocked" && handedOff.reason,
    "passkey-required",
  );
});

test("the heuristic fills a conditional-UI identifier but never presses a passkey", async () => {
  const interpret = createHeuristicInterpreter();
  const identifier: SnapshotElement = {
    index: 0,
    kind: "input",
    type: "text",
    label: "Email or username",
    autocomplete: "username webauthn",
  };
  // Identifier-first with conditional UI: the identifier is typed as usual.
  assert.deepEqual(
    await interpret({
      goal: "sign-in",
      available: ["username", "password"],
      history: [],
      snapshot: snapshot({
        passkey: true,
        elements: [identifier, { index: 1, kind: "button", text: "Next" }],
      }),
    }),
    { action: "fill", element: 0, role: "username" },
  );
  // Filled, the way on is Next - not the passkey offered beside it.
  assert.deepEqual(
    await interpret({
      goal: "sign-in",
      available: ["username", "password"],
      history: [{ action: "fill", path: "https://provider.example/signin" }],
      snapshot: snapshot({
        passkey: true,
        elements: [
          { ...identifier, filled: true },
          { index: 1, kind: "button", text: "Sign in with a passkey" },
          { index: 2, kind: "button", text: "Next" },
        ],
      }),
    }),
    { action: "click", element: 2, note: "Next" },
  );
  // An authenticator-only page is a wall even with a password on offer, and
  // its lone "Continue" is never pressed.
  assert.deepEqual(
    await interpret({
      goal: "sign-in",
      available: ["username", "password"],
      history: [],
      snapshot: snapshot({
        passkey: true,
        elements: [
          {
            index: 0,
            kind: "input",
            type: "text",
            label: "Passkey",
            autocomplete: "webauthn",
          },
          { index: 1, kind: "button", text: "Continue" },
        ],
      }),
    }),
    { action: "blocked", reason: "passkey-required" },
  );
  // Nor is a passkey button pressed on a page that offers nothing else.
  assert.notDeepEqual(
    (
      await interpret({
        goal: "sign-in",
        available: ["username", "password"],
        history: [{ action: "fill", path: "https://provider.example/signin" }],
        snapshot: snapshot({
          elements: [
            {
              index: 0,
              kind: "input",
              type: "text",
              label: "Username",
              filled: true,
            },
            { index: 1, kind: "button", text: "Use a passkey" },
          ],
        }),
      })
    )?.action,
    "click",
  );
});

test("the heuristic presses 'Generate' as a way forward, once per document", async () => {
  const interpret = createHeuristicInterpreter();
  const page = snapshot({
    path: "https://provider.example/settings/developers/oauth-apps/1",
    title: "Example app",
    headings: ["Example app", "Client secrets"],
    elements: [
      {
        index: 0,
        kind: "input",
        type: "text",
        label: "Client ID",
        filled: true,
      },
      { index: 1, kind: "button", text: "Copy" },
      { index: 2, kind: "button", text: "Generate a new client secret" },
    ],
  });
  assert.deepEqual(
    await interpret({
      goal: "obtain-credential",
      available: [],
      history: [],
      snapshot: page,
    }),
    { action: "click", element: 2, note: "Generate a new client secret" },
  );
  // Pressed here already: a second secret is not generated on a loop.
  assert.notEqual(
    (
      await interpret({
        goal: "obtain-credential",
        available: [],
        history: [
          {
            action: "click",
            note: "Generate a new client secret",
            path: page.path,
          },
        ],
        snapshot: page,
      })
    )?.action,
    "click",
  );
});

test("the heuristic claims completion only on a success page and the driver still verifies it", async () => {
  const interpret = createHeuristicInterpreter();
  assert.deepEqual(
    await interpret({
      goal: "registration",
      available: [],
      history: [],
      snapshot: snapshot({ title: "Account created", elements: [] }),
    }),
    { action: "done" },
  );
  const page = inertPage();
  page.snapshot = async () =>
    snapshot({ title: "Account created", elements: [] });
  const result = await runCeremony({
    page,
    goal: "registration",
    allowedOrigins: ["https://provider.example"],
    interpreter: interpret,
    secrets: createSecrets({}),
    verify: async () => false,
  });
  assert.equal(result.status, "unverified");
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

/**
 * A double for the handle graph a real browser hands back.
 *
 * It answers exactly the questions the adapter asks — is this element still
 * usable, does it still belong to this form, where would it deliver now — from
 * mutable state a test can change *between* the observation and the action.
 * That is the race the old attribute-selector adapter could not see, so being
 * able to stage it here is the point of the double.
 */
function handleGraph(
  options: {
    origin?: string;
    controls?: number;
    /** Runs inside the click, modelling a page that acts during it. */
    onClick?: (index: number) => void;
    /** What each read-only control displays, by index. */
    displays?: Record<number, string>;
    /** What the page shows, when it is not the default sign-in form. */
    view?: PageSnapshot;
  } = {},
) {
  const origin = options.origin ?? "https://provider.example";
  const count = options.controls ?? 7;
  const forms = Array.from({ length: count }, (_, index) => ({ form: index }));
  const state = Array.from({ length: count }, (_, index) => ({
    connected: true,
    form: forms[index] as object,
    destination: {
      form: true,
      action: `${origin}/session`,
      method: "post",
      target: "",
    } as Record<string, unknown>,
  }));
  const calls: string[] = [];
  let pageUrl = `${origin}/signin`;
  // A real browser replaces the document object on every navigation, which is
  // what makes a held reference to the old one detectably stale. The double
  // models that explicitly so the same-origin case is actually exercised.
  let liveDocument = { document: 0 };

  const elementHandle = (index: number) => ({
    evaluate: async (source: string, arg?: unknown) => {
      if (source.includes("isConnected")) return state[index]!.connected;
      if (source.includes("owner === form"))
        return state[index]!.form === (arg as { node?: object })?.node;
      return state[index]!.destination;
    },
    getProperty: async () => {
      throw new Error("not used");
    },
    asElement: () => elementHandle(index),
    dispose: async () => {},
    jsonValue: async () => undefined,
    fill: async (value: string) => {
      calls.push(`fill ${index} ${value}`);
    },
    click: async () => {
      calls.push(`click ${index}`);
      options.onClick?.(index);
    },
    check: async () => {
      calls.push(`check ${index}`);
    },
    selectOption: async (value: string | { label: string }) => {
      calls.push(
        `select ${index} ${typeof value === "string" ? value : `label:${value.label}`}`,
      );
      return [];
    },
  });

  const listHandle = (kind: "elements" | "forms") => ({
    evaluate: async () => undefined,
    getProperty: async (name: string) => {
      const index = Number(name);
      return kind === "elements"
        ? elementHandle(index)
        : {
            node: forms[index],
            evaluate: async () => undefined,
            getProperty: async () => listHandle(kind),
            asElement: () => null,
            dispose: async () => {},
            jsonValue: async () => undefined,
          };
    },
    asElement: () => null,
    dispose: async () => {},
    jsonValue: async () => undefined,
  });

  const page: PlaywrightPageLike = {
    url: () => pageUrl,
    goto: async (target) => {
      calls.push(`goto ${target}`);
      pageUrl = target;
      liveDocument = { document: liveDocument.document + 1 };
      return undefined;
    },
    evaluateHandle: async (source: string) => {
      calls.push(source.includes("destinations") ? "observe" : "other");
      const documentToken = liveDocument;
      return {
        documentToken,
        evaluate: async () => undefined,
        getProperty: async (name: string) => {
          if (name === "elements") return listHandle("elements");
          if (name === "forms") return listHandle("forms");
          const value =
            name === "snapshot"
              ? (options.view ?? snapshot())
              : name === "destinations"
                ? state.map((entry) => entry.destination)
                : origin;
          return {
            evaluate: async () => undefined,
            getProperty: async () => listHandle("elements"),
            asElement: () => null,
            dispose: async () => {},
            jsonValue: async () => value,
          };
        },
        asElement: () => null,
        dispose: async () => {},
        jsonValue: async () => undefined,
      };
    },
    // Mirrors what a real browser does: the checks are closures living on the
    // observation object, invoked with the held references as arguments.
    evaluate: (async (
      fn: (arg: { root: unknown; index: number }) => unknown,
      arg: { root: unknown; index: number },
    ) => {
      const held = arg.root as { documentToken: object };
      const bound = {
        sameDocument: () => held.documentToken === liveDocument,
        elements: state.map((_, index) => index),
        forms: state.map((_, index) => index),
        usable: (index: unknown) => state[index as number]!.connected,
        sameForm: (index: unknown, formIndex: unknown) =>
          state[index as number]!.form === forms[formIndex as number],
        destination: (index: unknown) => state[index as number]!.destination,
        readOnlyValue: (index: unknown) =>
          state[index as number]!.connected
            ? (options.displays?.[index as number] ?? null)
            : null,
      };
      return fn({ root: bound, index: arg.index });
    }) as PlaywrightPageLike["evaluate"],
    waitForLoadState: async (state) => {
      calls.push(`settle ${state}`);
    },
    // One document, so one frame, and it is the main one. A double that
    // claimed otherwise would let a frame-bound plan pass here and fail on a
    // browser, which is the direction this repository refuses to fail in.
    frames: () => [page],
    mainFrame: () => page,
  };
  return {
    page,
    calls,
    state,
    forms,
    navigate: (url: string) => {
      pageUrl = url;
      liveDocument = { document: liveDocument.document + 1 };
    },
  };
}

test("the Playwright adapter acts on the element it observed, not on a selector", async () => {
  const graph = handleGraph();
  const page = createPlaywrightCeremonyPage(graph.page);
  assert.equal(await page.url(), "https://provider.example/signin");
  await page.goto("https://provider.example/signin");
  assert.deepEqual(await page.snapshot(), snapshot());
  await page.fill(
    { index: 0, kind: "input", type: "text", label: "Username" },
    "value-1",
  );
  await page.click({ index: 2, kind: "button", text: "Sign in" });
  await page.settle();
  assert.deepEqual(graph.calls, [
    "goto https://provider.example/signin",
    // Navigation settles before anything observes. `domcontentloaded` means the
    // document has started, not that it is the one still there a moment later,
    // and an observation taken across that gap refuses the first action with
    // `stale-document` on a page nobody swapped.
    "settle networkidle",
    "observe",
    "fill 0 value-1",
    "click 2",
    "settle networkidle",
  ]);
});

test("an element removed after the snapshot is refused, not replaced", async () => {
  const graph = handleGraph();
  const page = createPlaywrightCeremonyPage(graph.page);
  await page.snapshot();
  // The page re-renders and swaps the input for a fresh one. A selector would
  // find the replacement; a held reference reports that its element is gone.
  graph.state[0]!.connected = false;
  await assert.rejects(
    page.fill(
      { index: 0, kind: "input", type: "text", label: "Username" },
      "secret",
    ),
    (error: unknown) =>
      error instanceof StaleTargetError && error.reason === "stale-element",
  );
  assert.ok(
    !graph.calls.some((call) => call.startsWith("fill")),
    "no value may be typed into a replacement element",
  );
});

test("navigation between snapshot and action refuses before anything is typed", async () => {
  const graph = handleGraph();
  const page = createPlaywrightCeremonyPage(graph.page);
  await page.snapshot();
  graph.navigate("https://attacker.example/collect");
  await assert.rejects(
    page.fill(
      { index: 0, kind: "input", type: "text", label: "Username" },
      "secret",
    ),
    (error: unknown) =>
      error instanceof StaleTargetError && error.reason === "stale-document",
  );
  assert.ok(!graph.calls.some((call) => call.startsWith("fill")));
});

test("a form whose destination changed after approval cannot receive the value", async () => {
  const graph = handleGraph();
  const page = createPlaywrightCeremonyPage(graph.page);
  await page.snapshot();
  // `formaction` on the submitter, a rewritten `action`, or a changed method
  // all surface here as a destination that is not the approved one.
  graph.state[0]!.destination = {
    form: true,
    action: "https://collector.example/post",
    method: "post",
    target: "",
  };
  await assert.rejects(
    page.fill(
      { index: 0, kind: "input", type: "text", label: "Username" },
      "secret",
    ),
    (error: unknown) =>
      error instanceof StaleTargetError &&
      error.reason === "unapproved-recipient",
  );
  assert.ok(!graph.calls.some((call) => call.startsWith("fill")));
});

test("a control moved into a different form loses its approval", async () => {
  const graph = handleGraph();
  const page = createPlaywrightCeremonyPage(graph.page);
  await page.snapshot();
  // The destination is unchanged, so only form identity catches this.
  graph.state[0]!.form = { form: 99 };
  await assert.rejects(
    page.fill(
      { index: 0, kind: "input", type: "text", label: "Username" },
      "secret",
    ),
    (error: unknown) =>
      error instanceof StaleTargetError && error.reason === "stale-element",
  );
  assert.ok(!graph.calls.some((call) => call.startsWith("fill")));
});

test("an element whose described shape changed is not the element approved", async () => {
  const graph = handleGraph();
  const page = createPlaywrightCeremonyPage(graph.page);
  await page.snapshot();
  await assert.rejects(
    // The caller asks to fill index 0 but describes a password box; the
    // snapshot recorded a text field there.
    page.fill({ index: 0, kind: "input", type: "password" }, "secret"),
    (error: unknown) =>
      error instanceof StaleTargetError && error.reason === "stale-element",
  );
});

test("acting before any observation is refused rather than guessed", async () => {
  const graph = handleGraph();
  const page = createPlaywrightCeremonyPage(graph.page);
  await assert.rejects(
    page.click({ index: 2, kind: "button", text: "Sign in" }),
    (error: unknown) =>
      // Not `stale-document`: nothing was ever approved, so no document was
      // compared and none moved on. The case below is the one where a page
      // really does change under an attempt, and it still says so — which is
      // the whole point of the two names being different.
      error instanceof StaleTargetError && error.reason === "no-observation",
  );
});

test("a released observation is not a page that moved on", async () => {
  const graph = handleGraph();
  const page = createPlaywrightCeremonyPage(graph.page);
  const snapshot = await page.snapshot();
  assert.ok(snapshot.elements.length > 0);
  // Navigating releases the approval. What follows has nothing behind it, and
  // blaming the document for that is what sent three runs' worth of failures
  // looking at guards that had not run.
  await page.goto("https://provider.example/second");
  await assert.rejects(
    page.click({ index: 2, kind: "button", text: "Sign in" }),
    (error: unknown) =>
      error instanceof StaleTargetError && error.reason === "no-observation",
  );
  assert.ok(!graph.calls.some((call) => call.startsWith("click")));
});

test("the driver reports a stale document instead of failing the run", async () => {
  const graph = handleGraph();
  const adapter = createPlaywrightCeremonyPage(graph.page);
  const result = await runCeremony({
    page: {
      ...adapter,
      // The credential lookup is where real attempts lose the race: the
      // resolver awaits a broker, and the page moves on while it does.
      snapshot: adapter.snapshot,
    },
    interpreter: async () => ({ action: "fill", element: 0, role: "username" }),
    goal: "sign-in",
    secrets: createSecrets({
      username: async () => {
        graph.navigate("https://provider.example/expired");
        return "person@example.com";
      },
    }),
    allowedOrigins: ["https://provider.example"],
  });
  assert.equal(result.status, "blocked");
  assert.equal(
    result.status === "blocked" ? result.reason : undefined,
    "stale-document",
  );
  assert.ok(!graph.calls.some((call) => call.startsWith("fill")));
});

/**
 * A page whose navigation lands late, which is the shape a loaded runner
 * produces and the shape CI has been reporting as `stale-document`.
 *
 * The submit goes through. `settle()` returns, the read that follows it and
 * the next main-loop read both still describe the page that is about to be
 * replaced, and the replacement commits while the interpreter is deciding
 * what to do with what it was shown. The approval the next action would use
 * is then against a document that no longer exists.
 */
function lateNavigation(destination: string) {
  let submitted = false;
  let reads = 0;
  const graph = handleGraph({
    onClick: () => {
      submitted = true;
      reads = 0;
    },
  });
  const page: PlaywrightPageLike = {
    ...graph.page,
    evaluateHandle: async (source: string) => {
      const handle = await graph.page.evaluateHandle(source);
      // The two reads are the post-action one and the main loop's, so the
      // document survives exactly long enough to be read and approved and
      // no longer.
      if (submitted && source.includes("destinations") && ++reads === 2) {
        submitted = false;
        graph.navigate(destination);
      }
      return handle;
    },
  };
  return { graph, page: createPlaywrightCeremonyPage(page) };
}

test("a submit whose navigation lands late is read again, not given up on", async () => {
  const { graph, page } = lateNavigation("https://provider.example/account");
  let verified = 0;
  let step = 0;
  const result = await runCeremony({
    page,
    // What a real interpreter does with a page it has just submitted and is
    // still being shown: try it again. That is the proposal that meets the
    // dead approval.
    interpreter: async () => {
      step += 1;
      if (step === 1) return { action: "fill", element: 0, role: "username" };
      if (step === 2) return { action: "click", element: 2 };
      if (step === 3) return { action: "fill", element: 0, role: "username" };
      return { action: "done" };
    },
    goal: "sign-in",
    secrets: createSecrets({ username: async () => "person@example.com" }),
    allowedOrigins: ["https://provider.example"],
    verify: async () => {
      verified += 1;
      return true;
    },
  });

  // The point of the case. Before the attempt learned to look again this
  // ended `blocked` / `stale-document` with `verified` still zero: a login
  // that had in fact succeeded, reported as one that never happened, and
  // the provider never asked.
  assert.equal(result.status, "completed");
  assert.equal(verified, 1);

  // The refusal is not swallowed. It is in the transcript under its own
  // name, against the document that went stale, so a recovered attempt is
  // distinguishable from one that never raced.
  const reread = result.transcript.filter(
    (entry) => entry.action === "reobserve",
  );
  assert.equal(reread.length, 1);
  assert.equal(reread[0]?.reason, "stale-document");
  assert.equal(reread[0]?.path, "https://provider.example/signin");

  // And nothing was typed at the page that replaced it. Looking again is not
  // acting anyway: the value went in once, before the submit.
  assert.deepEqual(
    graph.calls.filter((call) => call.startsWith("fill")),
    ["fill 0 person@example.com"],
  );
});

test("a submit that threw while the page moved is not tried again", async () => {
  // The one refusal that must stay terminal. Playwright can lose the
  // execution context between sending a submission and returning, so a click
  // that threw is not evidence that nothing was sent. Reading the page again
  // would be safe; acting on what is read could submit twice, and nothing in
  // the attempt can tell which happened.
  const graph = handleGraph({
    onClick: () => {
      graph.navigate("https://provider.example/account");
      throw new Error(
        "Execution context was destroyed, most likely because of a navigation",
      );
    },
  });
  const page = createPlaywrightCeremonyPage(graph.page);
  let clicks = 0;
  const result = await runCeremony({
    page,
    interpreter: async () => {
      clicks += 1;
      return { action: "click", element: 2 };
    },
    goal: "sign-in",
    secrets: createSecrets({}),
    allowedOrigins: ["https://provider.example"],
    verify: async () => true,
  });
  assert.equal(result.status, "blocked");
  assert.equal(
    result.status === "blocked" ? result.reason : undefined,
    "stale-document",
  );
  // Proposed once, refused once, and never proposed again: no second submit.
  assert.equal(clicks, 1);
  assert.equal(
    result.transcript.filter((entry) => entry.action === "reobserve").length,
    0,
  );
});

test("a page that keeps moving still ends the attempt", async () => {
  const graph = handleGraph();
  let moves = 0;
  const page = createPlaywrightCeremonyPage({
    ...graph.page,
    // Replaced under every single read. Re-reading cannot help, and the
    // budget is what stops the attempt spinning on it.
    evaluateHandle: async (source: string) => {
      const handle = await graph.page.evaluateHandle(source);
      if (source.includes("destinations")) {
        moves += 1;
        graph.navigate(`https://provider.example/moved-${moves}`);
      }
      return handle;
    },
  });
  const result = await runCeremony({
    page,
    interpreter: async () => ({
      action: "fill",
      element: 0,
      role: "username",
    }),
    goal: "sign-in",
    secrets: createSecrets({ username: async () => "person@example.com" }),
    allowedOrigins: ["https://provider.example"],
    verify: async () => true,
  });
  assert.equal(result.status, "blocked");
  assert.equal(
    result.status === "blocked" ? result.reason : undefined,
    "stale-document",
  );
  // One re-read, then the name it would have carried immediately. A wider
  // budget would show up here as a second entry.
  assert.equal(
    result.transcript.filter((entry) => entry.action === "reobserve").length,
    1,
  );
  assert.ok(!graph.calls.some((call) => call.startsWith("fill")));
});

/**
 * A frame that only has to be findable. Both cases below refuse during
 * selection, before anything is read, so a frame that threw on being read
 * would be proving the wrong thing.
 */
function frameAt(url: string): BoundPageLike {
  return {
    url: () => url,
    evaluateHandle: async () => {
      throw new Error("a refused frame must never be read");
    },
    evaluate: async () => {
      throw new Error("a refused frame must never be read");
    },
  };
}

test("a declared frame that is not on the page is refused, not fallen back from", async () => {
  const graph = handleGraph();
  const page = createPlaywrightCeremonyPage(graph.page, {
    frameOrigins: ["https://frame.example"],
  });
  await assert.rejects(
    page.snapshot(),
    (error: unknown) =>
      error instanceof StaleTargetError && error.reason === "frame-missing",
  );
  // The page itself is right there and has a form on it. Reading that is the
  // failure being refused: a different origin, a different document, and a
  // credential typed into neither of the things the plan described. Naming
  // the frame was the statement that the page is not it.
  assert.ok(!graph.calls.includes("observe"));
});

test("two frames at the declared origin do not identify a document", async () => {
  const graph = handleGraph();
  const page = createPlaywrightCeremonyPage(
    {
      ...graph.page,
      frames: () => [
        graph.page,
        frameAt("https://frame.example/one"),
        frameAt("https://frame.example/two"),
      ],
      mainFrame: () => graph.page,
    },
    { frameOrigins: ["https://frame.example"] },
  );
  await assert.rejects(
    page.snapshot(),
    (error: unknown) =>
      error instanceof StaleTargetError && error.reason === "frame-ambiguous",
  );
  // Choosing between them would approve a position rather than a thing, one
  // level up from the element guards: a page that can add a second frame at
  // an origin could choose which document a credential is typed into.
  assert.ok(!graph.calls.includes("observe"));
});

test("a frame is chosen by origin, and the page is not read instead", async () => {
  const graph = handleGraph();
  let framesRead = 0;
  const frame: BoundPageLike = {
    url: () => "https://frame.example/signin",
    evaluateHandle: async (source: string) => {
      framesRead += 1;
      return graph.page.evaluateHandle(source);
    },
    evaluate: ((fn: never, arg: never) =>
      graph.page.evaluate(fn, arg)) as BoundPageLike["evaluate"],
  };
  const page = createPlaywrightCeremonyPage(
    {
      ...graph.page,
      frames: () => [graph.page, frame],
      mainFrame: () => graph.page,
    },
    { frameOrigins: ["https://frame.example"] },
  );
  const snapshot = await page.snapshot();
  assert.ok(snapshot.elements.length > 0);
  assert.equal(framesRead, 1);
});

test("ORIGIN-REDIRECT: an undeclared origin is refused before it is read", async () => {
  // Two separate protections refuse a credential on an undeclared origin: the
  // navigation check at the top of the loop, and the recipient check at the
  // fill. End to end they are indistinguishable - remove either and
  // ORIGIN-REDIRECT in the conformance suite stays green - so the refusal
  // needs pinning somewhere that can tell them apart.
  //
  // "The driver leaves an origin it was never permitted to act on" above is
  // the nearest existing case, and it does not cover this: `inertPage` never
  // records `snapshot`, so its "nothing is done" has never included "nothing
  // is read". `handleGraph` records every observation, which is what makes
  // the distinction visible here.
  //
  // And reading is the part worth pinning. An observation is what the
  // interpreter is shown, so a page nobody declared would reach whatever is
  // doing the reasoning - on a host model, that means leaving the deployment
  // entirely. The navigation guard is what makes "not admitted" mean "not
  // looked at" rather than merely "not typed into".
  const graph = handleGraph({ origin: "https://provider.example" });
  graph.navigate("https://elsewhere.example/signin");
  const page = createPlaywrightCeremonyPage(graph.page);
  const result = await runCeremony({
    page,
    interpreter: async () => ({ action: "fill", element: 0, role: "username" }),
    goal: "sign-in",
    secrets: createSecrets({ username: async () => "person@example.com" }),
    allowedOrigins: ["https://provider.example"],
  });
  assert.equal(result.status, "blocked");
  assert.equal(
    result.status === "blocked" ? result.reason : undefined,
    "untrusted-origin",
  );
  assert.ok(
    !graph.calls.includes("observe"),
    "an origin nobody declared must not be read, let alone acted on",
  );
  assert.ok(!graph.calls.some((call) => call.startsWith("fill")));
});

test("TARGET-CLOSED: a tab that went away is not a document that moved on", async () => {
  // These shared an answer until now, and they call for opposite responses.
  // A document that moved leaves a document to read, which is why one re-read
  // is worth spending. A closed target leaves nothing: the re-read is spent on
  // a page that cannot come back, and `stale-document` then sends whoever
  // reads it to the guards that compare documents, for a tab that is not
  // there.
  const graph = handleGraph();
  const page = createPlaywrightCeremonyPage({
    ...graph.page,
    evaluateHandle: async () => {
      throw new Error("Target page, context or browser has been closed");
    },
  });
  await assert.rejects(
    page.snapshot(),
    (error: unknown) =>
      error instanceof StaleTargetError && error.reason === "target-closed",
  );
});

test("a closed target ends the attempt instead of being read again", async () => {
  // The bound on re-reading is what makes it safe, and a target that cannot
  // come back must not consume it. One attempt, one refusal, no second look.
  const graph = handleGraph();
  let reads = 0;
  const page = createPlaywrightCeremonyPage({
    ...graph.page,
    evaluateHandle: async () => {
      reads += 1;
      throw new Error("Target closed");
    },
  });
  const result = await runCeremony({
    page,
    interpreter: async () => ({ action: "done" }),
    goal: "sign-in",
    secrets: createSecrets({}),
    allowedOrigins: ["https://provider.example"],
    verify: async () => true,
  });
  assert.equal(result.status, "blocked");
  assert.equal(
    result.status === "blocked" ? result.reason : undefined,
    "target-closed",
  );
  assert.equal(reads, 1);
});

/**
 * A window the page opened, standing on its own recording graph. The page
 * double reports it through `on("popup")` exactly as Playwright does, and it
 * closes the way a real window does: a flag the adapter can read at once, and
 * a `close` event for whoever asked to be told.
 */
function windowAt(url: string, graph: ReturnType<typeof handleGraph>) {
  let closed = false;
  let current = url;
  const closers: (() => void)[] = [];
  return {
    url: () => current,
    evaluateHandle: (source: string) => graph.page.evaluateHandle(source),
    evaluate: ((fn: never, arg: never) =>
      graph.page.evaluate(fn, arg)) as BoundPageLike["evaluate"],
    isClosed: () => closed,
    waitForLoadState: async () => {},
    on: (event: "close" | "popup", listener: (...args: never[]) => void) => {
      if (event === "close") closers.push(listener as () => void);
    },
    close: () => {
      closed = true;
      for (const listener of closers) listener();
    },
    navigate: (next: string) => {
      current = next;
    },
  };
}
type WindowDouble = ReturnType<typeof windowAt>;

/** A page double that reports the windows it opens, as Playwright's does. */
function openerOf(graph: ReturnType<typeof handleGraph>) {
  const listeners: ((popup: WindowDouble) => void)[] = [];
  return {
    page: {
      ...graph.page,
      on: (event: "popup", listener: (popup: WindowDouble) => void) => {
        if (event === "popup") listeners.push(listener);
      },
    },
    open: (popup: WindowDouble) => {
      for (const listener of listeners) listener(popup);
    },
  };
}

const observations = (calls: readonly string[]) =>
  calls.filter((call) => call === "observe").length;

test("TARGET-POPUP: a window at an admitted origin is where the next read happens", async () => {
  // The rule frames did not need. A frame is there to be found; a window is
  // not there until the page opens it, so the attempt acts in the page until
  // a window at an admitted origin exists, and then in that. Both halves are
  // pinned: the page is read before the window opens, the window after, and
  // the page not again.
  const graph = handleGraph();
  const opener = openerOf(graph);
  const page = createPlaywrightCeremonyPage(opener.page, {
    popupOrigins: ["https://provider.example"],
  });
  await page.snapshot();
  assert.equal(observations(graph.calls), 1);

  const inside = handleGraph();
  opener.open(windowAt("https://provider.example/window", inside));
  await page.snapshot();
  assert.equal(await page.url(), "https://provider.example/window");
  assert.equal(observations(inside.calls), 1);
  assert.equal(observations(graph.calls), 1);
});

test("TARGET-POPUP: a window somewhere undeclared is refused before it is read", async () => {
  // A window is the page choosing where the next document lives. An origin
  // the plan never named does not become admitted by being opened rather
  // than navigated to, and nothing in it is shown to an interpreter.
  const graph = handleGraph();
  const opener = openerOf(graph);
  const page = createPlaywrightCeremonyPage(opener.page, {
    popupOrigins: ["https://provider.example"],
  });
  const inside = handleGraph({ origin: "https://elsewhere.example" });
  opener.open(windowAt("https://elsewhere.example/signin", inside));
  await assert.rejects(
    page.snapshot(),
    (error: unknown) =>
      error instanceof StaleTargetError && error.reason === "popup-undeclared",
  );
  assert.ok(!inside.calls.includes("observe"));
  // Nor is the page read instead. The attempt has been carried somewhere its
  // plan does not admit, whichever document a read would have landed on.
  assert.ok(!graph.calls.includes("observe"));
});

test("TARGET-POPUP: two windows at admitted origins do not identify a document", async () => {
  // The same refusal frames make, one level up from the element guards: a
  // page that can open two windows could choose which one a credential is
  // typed into.
  const graph = handleGraph();
  const opener = openerOf(graph);
  const page = createPlaywrightCeremonyPage(opener.page, {
    popupOrigins: ["https://provider.example"],
  });
  opener.open(windowAt("https://provider.example/one", handleGraph()));
  opener.open(windowAt("https://provider.example/two", handleGraph()));
  await assert.rejects(
    page.snapshot(),
    (error: unknown) =>
      error instanceof StaleTargetError && error.reason === "popup-ambiguous",
  );
  assert.ok(!graph.calls.includes("observe"));
});

test("TARGET-POPUP: a window that closes hands the attempt back to its opener", async () => {
  // How every window flow ends: the window reports back and leaves, and the
  // page that opened it is where the attempt continues and is verified.
  const graph = handleGraph();
  const opener = openerOf(graph);
  const page = createPlaywrightCeremonyPage(opener.page, {
    popupOrigins: ["https://provider.example"],
  });
  const inside = handleGraph();
  const popup = windowAt("https://provider.example/window", inside);
  opener.open(popup);
  await page.snapshot();
  assert.equal(observations(inside.calls), 1);
  popup.close();
  await page.snapshot();
  assert.equal(await page.url(), "https://provider.example/signin");
  assert.equal(observations(inside.calls), 1);
  assert.equal(observations(graph.calls), 1);
});

test("TARGET-POPUP: a window that has not arrived is neither adopted nor refused", async () => {
  // Between `window.open` and the first document there is a window at
  // `about:blank`, which is not anything yet. Refusing it would end attempts
  // on slow networks; adopting it would read an empty document. The read
  // goes to the page, and `settle` is what waits for the window to become
  // something.
  const graph = handleGraph();
  const opener = openerOf(graph);
  const page = createPlaywrightCeremonyPage(opener.page, {
    popupOrigins: ["https://provider.example"],
  });
  const inside = handleGraph();
  const popup = windowAt("about:blank", inside);
  opener.open(popup);
  await page.snapshot();
  assert.equal(observations(graph.calls), 1);
  assert.ok(!inside.calls.includes("observe"));
  popup.navigate("https://provider.example/window");
  await page.snapshot();
  assert.equal(observations(inside.calls), 1);
});

test("TARGET-POPUP: without popup origins a window is not adopted", async () => {
  // The default, pinned. A plan that did not require `popupBinding` gets
  // what it always got: the page, whatever the page opens.
  const graph = handleGraph();
  const opener = openerOf(graph);
  const page = createPlaywrightCeremonyPage(opener.page);
  const inside = handleGraph();
  opener.open(windowAt("https://provider.example/window", inside));
  await page.snapshot();
  assert.equal(await page.url(), "https://provider.example/signin");
  assert.ok(!inside.calls.includes("observe"));
});

test("TARGET-POPUP: popup origins need a page that reports its windows", () => {
  // A page that cannot say what it opened cannot be bound to it. Refusing at
  // construction is the honest answer; adopting nothing while the table
  // claims the capability is the dishonest one it was corrected for.
  const graph = handleGraph();
  assert.throws(() =>
    createPlaywrightCeremonyPage(graph.page, {
      popupOrigins: ["https://provider.example"],
    }),
  );
});

test("TARGET-POPUP: a click that closes the window it was given is a step, not a closed target", async () => {
  // The ordinary end of a window's job: the click submits, the window
  // reports back and closes under the click. `target-closed` is the right
  // answer for a tab that vanished under an attempt and the wrong one here -
  // the opener is still there, and the next read is of it.
  let open: (popup: WindowDouble) => void = () => {};
  let popup: WindowDouble | undefined;
  const graph = handleGraph({ onClick: () => open(popup!) });
  const opener = openerOf(graph);
  open = opener.open;
  const inside = handleGraph({
    onClick: () => {
      popup?.close();
      throw new Error("Target page, context or browser has been closed");
    },
  });
  popup = windowAt("https://provider.example/window", inside);
  const page = createPlaywrightCeremonyPage(opener.page, {
    popupOrigins: ["https://provider.example"],
  });
  let turn = 0;
  const result = await runCeremony({
    page,
    interpreter: async () => {
      turn += 1;
      return turn <= 2 ? { action: "click", element: 2 } : { action: "done" };
    },
    goal: "sign-in",
    secrets: createSecrets({}),
    allowedOrigins: ["https://provider.example"],
    verify: async () => true,
  });
  assert.equal(result.status, "completed");
  // Turn one clicked in the page and opened the window; turn two clicked in
  // the window and closed it. Both are on record as steps that landed.
  assert.ok(graph.calls.includes("click 2"));
  assert.ok(inside.calls.includes("click 2"));
});

test("TARGET-POPUP: a window reported after the opener settles is still where the next read happens", async () => {
  // The race TARGET-POPUP lost on a loaded CI runner. Playwright reports a
  // window once it has set it up, after the click that opened it returned -
  // and the opener, which had nothing to load, is idle already. Read then,
  // and the read is of the opener, whose only button has been pressed; an
  // interpreter shown that has nothing to do but wait and give up. Here the
  // report is held until the opener has said it is idle, so a `settle` that
  // stops at the opener loses every time rather than sometimes.
  let report: (() => void) | undefined;
  const inside = handleGraph();
  const popup = windowAt("https://provider.example/window", inside);
  const graph = handleGraph({
    onClick: () => {
      report = () => opener.open(popup);
    },
  });
  const opener = openerOf(graph);
  const page = createPlaywrightCeremonyPage(
    {
      ...opener.page,
      waitForLoadState: async (state) => {
        await graph.page.waitForLoadState(state);
        const late = report;
        report = undefined;
        if (late) setTimeout(late, 0);
      },
    },
    { popupOrigins: ["https://provider.example"] },
  );
  await page.snapshot();
  await page.click({ index: 2, kind: "button", text: "Sign in" });
  await page.settle();
  await page.snapshot();
  assert.equal(await page.url(), "https://provider.example/window");
  assert.equal(observations(inside.calls), 1);
  assert.equal(observations(graph.calls), 1);
});

test("TARGET-POPUP: a click that opens no window costs a bounded wait, then the page is read", async () => {
  // The other side of waiting for a window: a click on a plan that admits
  // windows need not open one, and the wait for it ends at the settle
  // timeout (capped) with the read going to the page, as it always did.
  const graph = handleGraph();
  const opener = openerOf(graph);
  const page = createPlaywrightCeremonyPage(opener.page, {
    popupOrigins: ["https://provider.example"],
    settleTimeoutMs: 1,
  });
  await page.snapshot();
  await page.click({ index: 2, kind: "button", text: "Sign in" });
  await page.settle();
  await page.snapshot();
  assert.equal(await page.url(), "https://provider.example/signin");
  assert.equal(observations(graph.calls), 2);
});

test("a page that never settles is the driver's problem, not the adapter's", async () => {
  const graph = handleGraph();
  const page = createPlaywrightCeremonyPage({
    ...graph.page,
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

test("the adapter names the origin a control would submit to, and nothing more", async () => {
  const graph = handleGraph();
  const page = createPlaywrightCeremonyPage(graph.page);
  await page.snapshot();
  // An origin, never the action URL: a login form's action routinely carries a
  // continuation or an identifier in its query string, and whoever reads an
  // effect record is not entitled to either.
  assert.equal(
    await page.submissionTarget?.({
      index: 2,
      kind: "button",
      text: "Sign in",
    }),
    "https://provider.example",
  );
});

test("a control that belongs to no form submits nothing", async () => {
  const graph = handleGraph();
  graph.state[3]!.destination = { form: false };
  const page = createPlaywrightCeremonyPage(graph.page);
  await page.snapshot();
  // Clicking a link or an in-page toggle changes nothing at the provider, so
  // announcing it as an effect would make the uncertainty signal meaningless.
  assert.equal(
    await page.submissionTarget?.({ index: 3, kind: "link", text: "Help" }),
    undefined,
  );
});

test("the adapter answers nothing about a control it never observed", async () => {
  const graph = handleGraph();
  const page = createPlaywrightCeremonyPage(graph.page);
  assert.equal(
    await page.submissionTarget?.({
      index: 2,
      kind: "button",
      text: "Sign in",
    }),
    undefined,
  );
});

test("a form re-pointed during the click is uncertainty, not a refusal", async () => {
  // The window this closes: every check happens before the click, and
  // Playwright's own actionability wait can run for seconds afterwards. A page
  // that re-points the form in that window passes every check and still sends
  // the submission somewhere else.
  const graph = handleGraph({
    onClick: (index) => {
      graph.state[index]!.destination = {
        form: true,
        action: "https://collector.example/take",
        method: "post",
        target: "",
      };
    },
  });
  const page = createPlaywrightCeremonyPage(graph.page);
  await page.snapshot();
  await assert.rejects(
    () => page.click({ index: 2, kind: "button", text: "Sign in" }),
    DispatchUncertain,
  );
});

test("a click that navigates is success, not uncertainty", async () => {
  // The destination cannot be read after a submission that navigated, and that
  // is the ordinary shape of a working login. Reporting it as uncertain would
  // make every successful sign-in undetermined.
  const graph = handleGraph({
    onClick: () => graph.navigate("https://provider.example/account"),
  });
  const page = createPlaywrightCeremonyPage(graph.page);
  await page.snapshot();
  await page.click({ index: 2, kind: "button", text: "Sign in" });
});

test("filling is not a dispatch, so a later re-point is still a plain refusal", async () => {
  const graph = handleGraph();
  const page = createPlaywrightCeremonyPage(graph.page);
  await page.snapshot();
  await page.fill(
    { index: 0, kind: "input", type: "text", label: "Username" },
    "value-1",
  );
  // Nothing left the browser, so the next action's own revalidation is what
  // catches the change — as a refusal a caller may safely retry.
  graph.state[0]!.destination = {
    form: true,
    action: "https://collector.example/take",
    method: "post",
    target: "",
  };
  await assert.rejects(
    () =>
      page.fill(
        { index: 0, kind: "input", type: "text", label: "Username" },
        "value-2",
      ),
    StaleTargetError,
  );
});

/* -------------------------------------------------------------------------- */
/* Issued values a plan keeps                                                 */
/* -------------------------------------------------------------------------- */

const issuedCanary = "ocs_canary-7f3a9c41d2e8b605";
const issuedClientId = "oac_canary-client-5512";

/** A developer settings page: an app's client ID, then a revealed secret. */
function issuingPage(
  options: {
    /** Print the secret into an alert as well, which no page may do. */
    leakInAlert?: boolean;
    /** Show the secret field twice, which identifies no field. */
    duplicateSecret?: boolean;
    /** Refuse every read, as an adapter does when the page moved on. */
    stale?: boolean;
    /** Reveal the secret on a page that no longer shows the client ID. */
    secretAlone?: boolean;
  } = {},
): CeremonyPage & { reads: string[] } {
  const reads: string[] = [];
  let revealed = false;
  const secretField = (index: number): SnapshotElement => ({
    index,
    kind: "input",
    type: "text",
    label: "Client secret",
    filled: true,
  });
  const shown = () =>
    snapshot({
      path: "https://provider.example/settings/developers/oauth-apps/1",
      title: "Example app",
      headings: revealed
        ? ["Example app", "Client secrets", "New client secret created"]
        : ["Example app", "Client secrets"],
      alerts:
        revealed && options.leakInAlert ? [`Your secret: ${issuedCanary}`] : [],
      elements: [
        {
          index: 0,
          kind: "input",
          type: "text",
          label:
            revealed && options.secretAlone ? "Application name" : "Client ID",
          filled: true,
        },
        ...(revealed
          ? [
              secretField(1),
              ...(options.duplicateSecret ? [secretField(2)] : []),
            ]
          : [
              {
                index: 1,
                kind: "button" as const,
                text: "Generate a new client secret",
              },
            ]),
      ],
    });
  return {
    ...inertPage("https://provider.example/settings/developers/oauth-apps/1"),
    reads,
    snapshot: async () => shown(),
    click: async (element) => {
      if (element.text === "Generate a new client secret") revealed = true;
    },
    readIssued: async (element) => {
      reads.push(element.label ?? "");
      if (options.stale) throw new StaleTargetError("stale-document");
      if (element.label === "Client ID") return issuedClientId;
      if (element.label === "Client secret") return issuedCanary;
      return undefined;
    },
  };
}

/** Generate a secret, then claim the page finished. */
const generateThenDone: CeremonyInterpreter = async ({ snapshot: page }) => {
  const generate = page.elements.find(
    (element) => element.text === "Generate a new client secret",
  );
  return generate
    ? { action: "click", element: generate.index }
    : { action: "done" };
};

const issuedFields = {
  "client-id": "Client ID",
  "client-secret": "Client secret",
} as const;

test("ISSUED-KEEP: a declared issued value goes to the plan's sink and nowhere the interpreter can see", async () => {
  const inputs: InterpreterInput[] = [];
  const kept: unknown[] = [];
  const result = await runCeremony({
    page: issuingPage(),
    interpreter: async (input) => {
      inputs.push(structuredClone(input));
      return generateThenDone(input);
    },
    goal: "obtain-credential",
    secrets: createSecrets({}),
    allowedOrigins: ["https://provider.example"],
    issued: {
      fields: issuedFields,
      keep: async (values) => {
        kept.push(values);
      },
    },
    verify: async () => true,
  });
  assert.equal(result.status, "completed");
  // Once, with both values, and only after both were on the page.
  assert.deepEqual(kept, [
    { "client-id": issuedClientId, "client-secret": issuedCanary },
  ]);
  assert.deepEqual(
    result.transcript.filter((step) => step.action === "kept"),
    [
      {
        path: "https://provider.example/settings/developers/oauth-apps/1",
        action: "kept",
        note: "client-id, client-secret",
      },
    ],
  );
  const visible = JSON.stringify([inputs, result]);
  for (const value of [issuedCanary, issuedClientId])
    assert.equal(visible.includes(value), false, value);
  // The interpreter is never told a value was read.
  assert.ok(inputs.every((input) => !JSON.stringify(input).includes("kept")));
});

test("ISSUED-UNREAD: a completion claim is refused while a declared value is still unread", async () => {
  let kept = 0;
  const result = await runCeremony({
    page: issuingPage(),
    // Claims success on the page before the secret was ever generated.
    interpreter: async () => ({ action: "done" }),
    goal: "obtain-credential",
    secrets: createSecrets({}),
    allowedOrigins: ["https://provider.example"],
    issued: {
      fields: issuedFields,
      keep: async () => {
        kept++;
      },
    },
    verify: async () => true,
  });
  assert.equal(result.status, "unverified");
  assert.equal(kept, 0);
});

test("ISSUED-AMBIGUOUS: a label that matches two fields identifies neither, and nothing is kept", async () => {
  const page = issuingPage({ duplicateSecret: true });
  let kept = 0;
  const result = await runCeremony({
    page,
    interpreter: generateThenDone,
    goal: "obtain-credential",
    secrets: createSecrets({}),
    allowedOrigins: ["https://provider.example"],
    issued: {
      fields: issuedFields,
      keep: async () => {
        kept++;
      },
    },
    verify: async () => true,
  });
  assert.equal(result.status, "unverified");
  assert.equal(kept, 0);
  assert.ok(!page.reads.includes("Client secret"));
});

test("ISSUED-ONE-PAGE: values seen on different pages are not kept together", async () => {
  const page = issuingPage({ secretAlone: true });
  const result = await runCeremony({
    page,
    interpreter: generateThenDone,
    goal: "obtain-credential",
    secrets: createSecrets({}),
    allowedOrigins: ["https://provider.example"],
    issued: {
      fields: issuedFields,
      keep: async () => assert.fail("nothing may be kept"),
    },
    verify: async () => true,
  });
  assert.equal(result.status, "unverified");
  // A page missing a declared field is not read at all.
  assert.deepEqual(page.reads, []);
});

test("ISSUED-LEAK: a page that also prints the issued secret fails the attempt before the interpreter sees it", async () => {
  const inputs: InterpreterInput[] = [];
  await assert.rejects(
    runCeremony({
      page: issuingPage({ leakInAlert: true }),
      interpreter: async (input) => {
        inputs.push(structuredClone(input));
        return generateThenDone(input);
      },
      goal: "obtain-credential",
      secrets: createSecrets({}),
      allowedOrigins: ["https://provider.example"],
      issued: { fields: issuedFields, keep: async () => {} },
      verify: async () => true,
    }),
    (error: Error) => error instanceof CeremonySecretLeak,
  );
  assert.equal(JSON.stringify(inputs).includes(issuedCanary), false);
});

test("ISSUED-STALE: a read the adapter refuses takes nothing, and undeclared fields are never read", async () => {
  const refused = await runCeremony({
    page: issuingPage({ stale: true }),
    interpreter: generateThenDone,
    goal: "obtain-credential",
    secrets: createSecrets({}),
    allowedOrigins: ["https://provider.example"],
    issued: {
      fields: issuedFields,
      keep: async () => assert.fail("nothing may be kept"),
    },
    verify: async () => true,
  });
  assert.equal(refused.status, "unverified");

  // Without a declaration the same page is driven and nothing is read at all.
  const undeclared = issuingPage();
  const plain = await runCeremony({
    page: undeclared,
    interpreter: generateThenDone,
    goal: "obtain-credential",
    secrets: createSecrets({}),
    allowedOrigins: ["https://provider.example"],
    verify: async () => true,
  });
  assert.equal(plain.status, "completed");
  assert.deepEqual(undeclared.reads, []);
});

test("ISSUED-ADAPTER: the Playwright adapter reads only the observed field, on the observed document", async () => {
  const graph = handleGraph({ displays: { 0: "displayed-value-1" } });
  const page = createPlaywrightCeremonyPage(graph.page);
  const field: SnapshotElement = {
    index: 0,
    kind: "input",
    type: "text",
    label: "Username",
  };
  const refusedAs = (reason: string) => (error: Error) =>
    error instanceof StaleTargetError && error.reason === reason;
  // Nothing observed yet: nothing to read.
  await assert.rejects(page.readIssued!(field), refusedAs("no-observation"));
  await page.snapshot();
  assert.equal(await page.readIssued!(field), "displayed-value-1");
  // A control that displays nothing read-only reads as nothing.
  assert.equal(
    await page.readIssued!({
      index: 1,
      kind: "input",
      type: "password",
      label: "Password",
    }),
    undefined,
  );
  // A differently described field at the same index was never observed.
  await assert.rejects(
    page.readIssued!({ ...field, label: "Client secret" }),
    refusedAs("stale-element"),
  );
  // Nor is a button, whatever it says.
  await assert.rejects(
    page.readIssued!({ index: 2, kind: "button", text: "Sign in" }),
    refusedAs("stale-element"),
  );
  graph.navigate("https://provider.example/elsewhere");
  await assert.rejects(page.readIssued!(field), refusedAs("stale-document"));
});

/* -------------------------------------------------------------------------- */
/* Choosing an option                                                         */
/* -------------------------------------------------------------------------- */

/** A registration page with a required country picker, and what it chose. */
function choicePage(): CeremonyPage & {
  calls: string[];
  chosen: () => string | undefined;
} {
  let chosen: string | undefined;
  const page = inertPage("https://provider.example/signup");
  return {
    ...page,
    chosen: () => chosen,
    snapshot: async () =>
      snapshot({
        path: "https://provider.example/signup",
        title: "Create your account",
        headings: ["Create your account"],
        elements: [
          {
            index: 0,
            kind: "select",
            label: "Country or region",
            options: ["Select a country", "Canada", "Japan"],
            required: true,
            filled: chosen !== undefined,
          },
          { index: 1, kind: "button", text: "Create account" },
        ],
      }),
    select: async (element, option) => {
      page.calls.push(`select:${element.index}:${option}`);
      chosen = option;
    },
  };
}

test("SELECT: on a live drive only the plan's choice is made, however the interpreter proposes another", async () => {
  // The interpreter picks a listed country the plan never chose. A model
  // does not decide where somebody's account lives.
  for (const optional of [false, true]) {
    const page = choicePage();
    const snapshotOf = page.snapshot;
    if (optional)
      page.snapshot = async () => {
        const seen = await snapshotOf();
        delete seen.elements[0]!.required;
        return seen;
      };
    const result = await runCeremony({
      page,
      goal: "registration",
      allowedOrigins: ["https://provider.example"],
      secrets: createSecrets({}),
      interpreter: async () => ({
        action: "select",
        element: 0,
        option: "Japan",
      }),
    });
    assert.equal(page.chosen(), undefined, `optional: ${optional}`);
    assert.equal(
      result.status === "blocked" && result.reason,
      "unsupported-page",
    );
  }
  // A fallback interpreter repairing a replay is no different: only the
  // recording's own steps carry a reviewed choice.
  const page = choicePage();
  // Recorded on another page, so the sign-up page drifts to the fallback.
  const elsewhere = {
    ...(await page.snapshot()),
    path: "https://provider.example/other",
  };
  const repaired = await runRecordedCeremony({
    page,
    recording: compileRecording(
      [{ snapshot: elsewhere, action: "click", element: 1 }],
      {
        id: "region-click",
        title: "Register",
        goal: "registration",
        entryUrl: "https://provider.example/other",
        origins: ["https://provider.example"],
        recordedWith: "deterministic",
        excluded: [],
      },
    ),
    fallback: async () => ({ action: "select", element: 0, option: "Japan" }),
    goal: "registration",
    allowedOrigins: ["https://provider.example"],
    secrets: createSecrets({}),
  });
  assert.equal(page.chosen(), undefined);
  assert.ok(repaired.interpreterCalls > 0);
});

test("SELECT: the driver chooses the plan's option by its label, and records the choice", async () => {
  const page = choicePage();
  const applied: RecordedTraceEntry[] = [];
  let asked = false;
  const result = await runCeremony({
    page,
    goal: "registration",
    allowedOrigins: ["https://provider.example"],
    secrets: createSecrets({}),
    choices: { "Country or region": "Canada" },
    interpreter: async ({ snapshot: current }) => {
      if (current.elements[0]?.filled) return { action: "done" };
      asked = true;
      return { action: "select", element: 0, option: "Canada" };
    },
    onApplied: (entry) => applied.push(entry),
    verify: async () => page.chosen() === "Canada",
  });
  assert.ok(asked);
  assert.equal(result.status, "completed");
  assert.ok(page.calls.includes("select:0:Canada"));
  assert.deepEqual(
    result.transcript.map((step) => step.action),
    ["select", "done"],
  );
  assert.equal(applied[0]?.action, "select");
  assert.equal(applied[0]?.option, "Canada");
});

test("SELECT: an option the page did not list, or not the plan's, or on a field that is not a select, is never chosen", async () => {
  const proposals = [
    { action: "select", element: 0, option: "Atlantis" },
    { action: "select", element: 0, option: "Japan" },
    { action: "select", element: 1, option: "Canada" },
    { action: "select", element: 0 },
  ] as const;
  for (const proposal of proposals) {
    const page = choicePage();
    const result = await runCeremony({
      page,
      goal: "registration",
      allowedOrigins: ["https://provider.example"],
      secrets: createSecrets({}),
      // The plan chose Canada; Japan is listed but not the plan's choice.
      choices: { "Country or region": "Canada" },
      interpreter: async () => ({ ...proposal }),
    });
    assert.equal(result.status, "blocked", JSON.stringify(proposal));
    assert.equal(
      result.status === "blocked" && result.reason,
      "unsupported-page",
    );
    assert.equal(page.chosen(), undefined, JSON.stringify(proposal));
  }
  // An adapter that cannot choose makes every choice unusable.
  const { select: _select, ...unable } = choicePage();
  const result = await runCeremony({
    page: unable,
    goal: "registration",
    allowedOrigins: ["https://provider.example"],
    secrets: createSecrets({}),
    interpreter: async () => ({
      action: "select",
      element: 0,
      option: "Canada",
    }),
  });
  assert.equal(
    result.status === "blocked" && result.reason,
    "unsupported-page",
  );
});

test("SELECT: a secret role is never filled into a select, and the value is never resolved for it", async () => {
  const page = choicePage();
  let resolved = 0;
  const result = await runCeremony({
    page,
    goal: "registration",
    allowedOrigins: ["https://provider.example"],
    secrets: {
      roles: ["password"],
      resolve: async () => {
        resolved++;
        return "pw-never-typed-1";
      },
    },
    interpreter: async () => ({ action: "fill", element: 0, role: "password" }),
  });
  assert.equal(
    result.status === "blocked" && result.reason,
    "unsupported-page",
  );
  assert.equal(resolved, 0);
  assert.ok(!page.calls.some((call) => call.startsWith("fill")));
});

test("SELECT: the heuristic chooses the plan's option by field label and leaves an unmade required choice to a person", async () => {
  const interpret = createHeuristicInterpreter();
  const page = await choicePage().snapshot();
  assert.deepEqual(
    await interpret({
      goal: "registration",
      available: [],
      history: [],
      snapshot: page,
      choices: { "Country or region": "Japan" },
    }),
    {
      action: "select",
      element: 0,
      option: "Japan",
      note: "Country or region",
    },
  );
  // A choice for another field, or an option this one does not list, is no
  // choice here; the first option is not guessed.
  for (const choices of [
    { Organisation: "Acme" },
    { "Country or region": "Mars" },
  ])
    assert.deepEqual(
      await interpret({
        goal: "registration",
        available: [],
        history: [],
        snapshot: page,
        choices,
      }),
      { action: "blocked", reason: "choice-required" },
    );
  // An optional choice nobody made is simply left alone.
  const optional = structuredClone(page);
  delete optional.elements[0]!.required;
  assert.deepEqual(
    await interpret({
      goal: "registration",
      available: [],
      history: [],
      snapshot: optional,
    }),
    { action: "click", element: 1, note: "Create account" },
  );
});

test("SELECT: an unmade required choice is handed to a person, who makes it in the same browser", async () => {
  const page = choicePage();
  const requests: HumanParticipationRequest[] = [];
  const result = await runCeremony({
    page,
    goal: "registration",
    allowedOrigins: ["https://provider.example"],
    secrets: createSecrets({}),
    interpreter: createHeuristicInterpreter(),
    human: {
      contract: {
        surface: "provider-browser",
        recipient: "initiating-subject",
        delegation: "a2h-authorize",
        resume: "verify",
      },
      request: async (request) => {
        requests.push(request);
        await page.select!(
          { index: 0, kind: "select", label: "Country or region" },
          "Japan",
        );
        return "completed";
      },
    },
    maxSteps: 4,
  });
  assert.deepEqual(
    requests.map(({ reason, path }) => ({ reason, path })),
    [{ reason: "choice", path: "https://provider.example/signup" }],
  );
  assert.equal(page.chosen(), "Japan");
  assert.equal(result.handoffs, 1);
  assert.ok(page.calls.includes("click:1"), "the form is then submitted");
  // Nobody to ask: the choice is not made, and the attempt says why.
  const alone = choicePage();
  const refused = await runCeremony({
    page: alone,
    goal: "registration",
    allowedOrigins: ["https://provider.example"],
    secrets: createSecrets({}),
    interpreter: createHeuristicInterpreter(),
  });
  assert.equal(
    refused.status === "blocked" && refused.reason,
    "choice-required",
  );
  assert.equal(alone.chosen(), undefined);
  assert.ok(!alone.calls.some((call) => call.startsWith("click")));
});

test("SELECT: a report that a choice is needed is not a handoff where no select is waiting", async () => {
  const page = inertPage();
  let asked = 0;
  const result = await runCeremony({
    page,
    goal: "sign-in",
    allowedOrigins: ["https://provider.example"],
    secrets: createSecrets({}),
    interpreter: async () => ({ action: "blocked", reason: "choice-required" }),
    human: {
      contract: {
        surface: "provider-browser",
        recipient: "initiating-subject",
        delegation: "a2h-authorize",
        resume: "verify",
      },
      request: async () => {
        asked++;
        return "completed";
      },
    },
  });
  assert.equal(asked, 0);
  // Nor is the claim passed on: the caller is not told a person could help.
  assert.equal(
    result.status === "blocked" && result.reason,
    "unsupported-page",
  );
});

test("SELECT: a plan's choice reaches past the snapshot's first twenty options; nothing else does", async () => {
  // A country list longer than a snapshot carries.
  const countries = Array.from(
    { length: 20 },
    (_, index) => `Country ${index}`,
  );
  const long: CeremonyPage & { chosen: string[] } = {
    ...inertPage("https://provider.example/signup"),
    chosen: [],
    snapshot: async () =>
      snapshot({
        path: "https://provider.example/signup",
        elements: [
          {
            index: 0,
            kind: "select",
            label: "Country or region",
            options: countries,
            required: true,
            filled: long.chosen.length > 0,
          },
        ],
      }),
    select: async (_element, option) => {
      long.chosen.push(option);
    },
  };
  const interpret = createHeuristicInterpreter();
  const input = {
    goal: "registration" as const,
    available: [],
    history: [],
    snapshot: await long.snapshot(),
    choices: { "Country or region": "Uruguay" },
  };
  assert.deepEqual(await interpret(input), {
    action: "select",
    element: 0,
    option: "Uruguay",
    note: "Country or region",
  });
  await runCeremony({
    page: long,
    goal: "registration",
    allowedOrigins: ["https://provider.example"],
    secrets: createSecrets({}),
    choices: input.choices,
    interpreter: async (seen) =>
      seen.snapshot.elements[0]?.filled
        ? { action: "done" }
        : { action: "select", element: 0, option: "Uruguay" },
  });
  assert.deepEqual(long.chosen, ["Uruguay"]);
  // Without a plan choice, a live drive chooses nothing.
  long.chosen = [];
  const free = await runCeremony({
    page: long,
    goal: "registration",
    allowedOrigins: ["https://provider.example"],
    secrets: createSecrets({}),
    interpreter: async () => ({
      action: "select",
      element: 0,
      option: "Uruguay",
    }),
  });
  assert.equal(free.status === "blocked" && free.reason, "unsupported-page");
  assert.deepEqual(long.chosen, []);
});

test("SELECT: the Playwright adapter chooses by visible label on the observed control", async () => {
  const view = snapshot({
    elements: [
      {
        index: 0,
        kind: "select",
        label: "Country or region",
        options: ["Select a country", "Canada"],
      },
    ],
  });
  const graph = handleGraph({ view, controls: 1 });
  const page = createPlaywrightCeremonyPage(graph.page);
  await page.snapshot();
  await page.select!(view.elements[0]!, "Canada");
  assert.ok(graph.calls.includes("select 0 label:Canada"));
  // An input is not chosen in, whatever it is called.
  await assert.rejects(
    page.select!({ index: 0, kind: "input", label: "Country or region" }, "x"),
    StaleTargetError,
  );
  graph.state[0]!.connected = false;
  await assert.rejects(
    page.select!(view.elements[0]!, "Canada"),
    (error: unknown) =>
      error instanceof StaleTargetError && error.reason === "stale-element",
  );
});

test("SELECT: a recorded choice replays with no interpreter, and only by label", async () => {
  const page = choicePage();
  const observed = await page.snapshot();
  const recording = compileRecording(
    [
      { snapshot: observed, action: "select", element: 0, option: "Canada" },
      { snapshot: observed, action: "click", element: 1 },
    ],
    {
      id: "region",
      title: "Register with a region",
      goal: "registration",
      entryUrl: "https://provider.example/signup",
      origins: ["https://provider.example"],
      recordedWith: "deterministic",
      excluded: [],
    },
  );
  assert.deepEqual(recording.steps[0]?.action, {
    kind: "select",
    target: {
      kind: "select",
      label: "Country or region",
      ordinal: 0,
      of: 1,
    },
    option: "Canada",
  });
  const replayed = await runRecordedCeremony({
    page,
    recording,
    goal: "registration",
    allowedOrigins: ["https://provider.example"],
    secrets: createSecrets({}),
  });
  assert.equal(page.chosen(), "Canada");
  assert.equal(replayed.interpreterCalls, 0);
  assert.ok(page.calls.includes("click:1"));
});

/* -------------------------------------------------------------------------- */
/* Device authorization pages                                                 */
/* -------------------------------------------------------------------------- */

const devicePath = "https://provider.example/device";

function devicePage(
  overrides: Partial<PageSnapshot> = {},
  code: Partial<SnapshotElement> = {},
): PageSnapshot {
  return snapshot({
    path: devicePath,
    title: "Connect a device · Example",
    headings: ["Connect a device"],
    elements: [
      {
        index: 0,
        kind: "input",
        type: "text",
        name: "user_code",
        label: "Device code",
        required: true,
        ...code,
      },
      { index: 1, kind: "button", text: "Continue" },
    ],
    ...overrides,
  });
}

test("DEVICE: a verification page is recognised by what it says and what its field is called", () => {
  // RFC 8628's own wording, and the usual providers' variants of it.
  for (const [headings, label] of [
    [["Connect a device"], "Device code"],
    [["Enter the code displayed on your device"], "Code"],
    [["Activate your TV"], "Activation code"],
    [["Device login"], "User code"],
    [["Link your device"], "Pairing code"],
  ] as const) {
    const page = devicePage(
      { title: "Example", headings: [...headings] },
      { name: "code", label },
    );
    assert.equal(
      deviceVerificationField(page)?.index,
      0,
      `${headings[0]} / ${label}`,
    );
  }
  // The RFC's parameter name identifies the field whatever the page says.
  assert.equal(
    deviceVerificationField(
      devicePage({ title: "Example", headings: ["Welcome"] }),
    )?.index,
    0,
  );
  // A "device code" on a settings page is not a verification page.
  assert.equal(
    deviceVerificationField(
      devicePage(
        { title: "Security settings", headings: ["Trusted devices"] },
        { name: "nickname", label: "Device code" },
      ),
    ),
    undefined,
  );
  // A page with a password box is a sign-in page whatever its heading says,
  // and a read-only field shows a value rather than asking for one.
  assert.equal(
    deviceVerificationField(
      devicePage({
        elements: [
          ...devicePage().elements,
          { index: 2, kind: "input", type: "password", label: "Password" },
        ],
      }),
    ),
    undefined,
  );
  assert.equal(
    deviceVerificationField(devicePage({}, { readOnly: true, filled: true })),
    undefined,
  );
  // The page that follows says it is done and asks for nothing.
  assert.equal(
    deviceVerificationField(
      devicePage({ headings: ["Device connected"], elements: [] }),
    ),
    undefined,
  );
});

test("DEVICE: the heuristic types a user code only when the plan gave it one, and never another code", async () => {
  const interpret = createHeuristicInterpreter();
  const page = devicePage();
  assert.deepEqual(
    await interpret({
      goal: "sign-in",
      available: ["user-code", "totp-code"],
      history: [],
      snapshot: page,
    }),
    { action: "fill", element: 0, role: "user-code" },
  );
  // Without it, neither a mailed code nor an authenticator's goes in.
  for (const available of [
    ["verification-code"],
    ["totp-code"],
    ["username", "password"],
  ] as const)
    assert.deepEqual(
      await interpret({
        goal: "sign-in",
        available,
        history: [],
        snapshot: devicePage({}, { name: "code", label: "Code" }),
      }),
      { action: "blocked", reason: "device-code-required" },
    );
  // Entered, it is submitted.
  assert.deepEqual(
    await interpret({
      goal: "sign-in",
      available: ["user-code"],
      history: [{ action: "fill", path: devicePath }],
      snapshot: devicePage({}, { filled: true }),
    }),
    { action: "click", element: 1, note: "Continue" },
  );
});

test("DEVICE: without the user code, a person holding the device is asked at the verification URI", async () => {
  let entered = false;
  const page: CeremonyPage & { calls: string[] } = {
    ...inertPage(`${devicePath}?user_code=WDJB-MJHT`),
    snapshot: async () =>
      entered
        ? devicePage({ headings: ["Device connected"], elements: [] })
        : devicePage(),
  };
  const requests: HumanParticipationRequest[] = [];
  const result = await runCeremony({
    page,
    goal: "sign-in",
    allowedOrigins: ["https://provider.example"],
    secrets: createSecrets({ username: "casey" }),
    interpreter: createHeuristicInterpreter(),
    human: {
      contract: {
        surface: "provider-browser",
        recipient: "initiating-subject",
        delegation: "a2h-authorize",
        resume: "verify",
      },
      request: async (request) => {
        requests.push(request);
        entered = true;
        return "completed";
      },
    },
    verify: async () => entered,
  });
  assert.equal(result.status, "completed");
  assert.equal(result.handoffs, 1);
  // Origin and pathname: the `verification_uri_complete` query, which carries
  // the code, is not part of what a host is asked to show.
  assert.deepEqual(
    requests.map(({ reason, path }) => ({ reason, path })),
    [{ reason: "device-code", path: devicePath }],
  );
  assert.ok(!JSON.stringify([requests, result]).includes("WDJB"));
  assert.ok(!page.calls.some((call) => call.startsWith("fill")));
});

test("DEVICE: a plan holding the user code is not handed off, and nobody to ask stops by name", async () => {
  let asked = 0;
  const human = {
    contract: {
      surface: "provider-browser",
      recipient: "initiating-subject",
      delegation: "a2h-authorize",
      resume: "verify",
    },
    request: async () => {
      asked++;
      return "completed" as const;
    },
  } as const;
  // An interpreter that reports the wall although the plan has the code: the
  // page is an ordinary form for this plan, so nobody is interrupted.
  const held = await runCeremony({
    page: { ...inertPage(devicePath), snapshot: async () => devicePage() },
    goal: "sign-in",
    allowedOrigins: ["https://provider.example"],
    secrets: createSecrets({ "user-code": "WDJBMJHT" }),
    interpreter: async () => ({
      action: "blocked",
      reason: "device-code-required",
    }),
    human,
  });
  assert.equal(asked, 0);
  // The claim is not passed on: nobody is needed, the page went unread.
  assert.equal(held.status === "blocked" && held.reason, "unsupported-page");
  // The same report on a page that is not a device page asks nobody either,
  // and says nothing about a person.
  const elsewhere = await runCeremony({
    page: inertPage(),
    goal: "sign-in",
    allowedOrigins: ["https://provider.example"],
    secrets: createSecrets({}),
    interpreter: async () => ({
      action: "blocked",
      reason: "device-code-required",
    }),
    human,
  });
  assert.equal(asked, 0);
  assert.equal(
    elsewhere.status === "blocked" && elsewhere.reason,
    "unsupported-page",
  );
  const alone = await runCeremony({
    page: { ...inertPage(devicePath), snapshot: async () => devicePage() },
    goal: "sign-in",
    allowedOrigins: ["https://provider.example"],
    secrets: createSecrets({}),
    interpreter: createHeuristicInterpreter(),
  });
  assert.equal(
    alone.status === "blocked" && alone.reason,
    "device-code-required",
  );
  assert.equal(alone.handoffs, 0);
});

/* -------------------------------------------------------------------------- */
/* The heuristic on an issued-value page                                      */
/* -------------------------------------------------------------------------- */

test("ISSUED-HEURISTIC: a page showing every declared value is the end, and nothing around it is pressed", async () => {
  const interpret = createHeuristicInterpreter();
  const shown = (secretFilled: boolean | undefined) =>
    snapshot({
      path: "https://provider.example/settings/developers/oauth-apps/1",
      title: "Example app",
      // No success wording at all: the declared fields are the signal.
      headings: ["Example app", "Client secrets"],
      elements: [
        {
          index: 0,
          kind: "input",
          type: "text",
          label: "Client ID",
          readOnly: true,
          filled: true,
        },
        { index: 1, kind: "button", text: "Copy" },
        {
          index: 2,
          kind: "input",
          type: "text",
          label: "Client secret",
          readOnly: true,
          ...(secretFilled === undefined ? {} : { filled: secretFilled }),
        },
        { index: 3, kind: "button", text: "Copy" },
        { index: 4, kind: "button", text: "Generate a new client secret" },
        { index: 5, kind: "button", text: "Update application" },
      ],
    });
  const input = {
    goal: "obtain-credential" as const,
    available: [],
    history: [],
    issuedLabels: ["Client ID", "Client secret"],
  };
  assert.deepEqual(await interpret({ ...input, snapshot: shown(true) }), {
    action: "done",
    note: "issued values shown",
  });
  // Shown and still empty: the page is filling it in, so wait - once.
  assert.deepEqual(await interpret({ ...input, snapshot: shown(undefined) }), {
    action: "wait",
  });
  assert.deepEqual(
    await interpret({
      ...input,
      history: [{ action: "wait", path: shown(false).path }],
      snapshot: shown(false),
    }),
    { action: "blocked", reason: "unsupported-page" },
  );
  // Without a declaration the page is read as before, and "Generate" is a
  // way forward like any other: the declaration is what makes it a hazard.
  assert.deepEqual(
    await interpret({
      goal: "obtain-credential",
      available: [],
      history: [],
      snapshot: shown(true),
    }),
    { action: "click", element: 4, note: "Generate a new client secret" },
  );
});

test("ISSUED-HEURISTIC: a generate button is pressed once per page, and never while a kept secret is showing", async () => {
  const interpret = createHeuristicInterpreter();
  const path = "https://provider.example/settings/tokens";
  const page = (elements: SnapshotElement[]) =>
    snapshot({ path, title: "Tokens", headings: ["Tokens"], elements });
  const generate: SnapshotElement = {
    index: 2,
    kind: "button",
    text: "Generate new token",
  };
  const agree: SnapshotElement = {
    index: 1,
    kind: "checkbox",
    label: "I understand this token can act as me",
    required: true,
    filled: true,
  };
  // Ticking a box on the page is a changed form, which lets an ordinary
  // button be pressed again - but not one that issues a secret.
  assert.notDeepEqual(
    await interpret({
      goal: "obtain-credential",
      available: [],
      history: [
        { action: "click", note: "Generate new token", path },
        { action: "check", path },
      ],
      snapshot: page([
        { index: 0, kind: "input", type: "text", label: "Note", filled: true },
        agree,
        generate,
      ]),
    }),
    { action: "click", element: 2, note: "Generate new token" },
  );
  // The declared token is showing, though the other declared field is not
  // here: another press would replace the token just shown.
  assert.notDeepEqual(
    await interpret({
      goal: "obtain-credential",
      available: [],
      history: [],
      issuedLabels: ["Token", "Token name"],
      snapshot: page([
        {
          index: 0,
          kind: "input",
          type: "text",
          label: "Token",
          readOnly: true,
          filled: true,
        },
        agree,
        generate,
      ]),
    }),
    { action: "click", element: 2, note: "Generate new token" },
  );
});

test("ISSUED-HEURISTIC: the production heuristic keeps a client's values end to end and presses Generate exactly once", async () => {
  const page = issuingPage();
  let presses = 0;
  const click = page.click;
  page.click = async (element) => {
    if (element.text === "Generate a new client secret") presses++;
    return click(element);
  };
  const kept: unknown[] = [];
  const result = await runCeremony({
    page,
    interpreter: createHeuristicInterpreter(),
    goal: "obtain-credential",
    secrets: createSecrets({}),
    allowedOrigins: ["https://provider.example"],
    issued: {
      fields: issuedFields,
      keep: async (values) => {
        kept.push(values);
      },
    },
    verify: async () => true,
  });
  assert.equal(result.status, "completed");
  assert.equal(presses, 1);
  assert.equal(kept.length, 1);
});

test("a snapshot says a field is read-only, never what it holds", () => {
  const { document } = parseHTML(
    `<!doctype html><html><body>
       <label for="id">Client ID</label><input id="id" readonly value="oac_shown-value-1">
       <label for="n">Name</label><input id="n" value="typed">
     </body></html>`,
  );
  document.documentElement.setAttribute(
    "data-ceremony-href",
    "https://provider.example/apps/1",
  );
  const result = snapshotDocument(
    document as unknown as Document,
    snapshotSelectors,
  );
  assert.equal(result.elements[0]?.readOnly, true);
  assert.equal(result.elements[1]?.readOnly, undefined);
  assert.ok(!JSON.stringify(result).includes("oac_shown-value-1"));
});

test("the interpreter prompt offers choosing, names the plan's choices and kept fields, and nothing else", () => {
  const prompt = interpreterPrompt({
    goal: "obtain-credential",
    snapshot: snapshot(),
    available: [],
    history: [],
    issuedLabels: ["Client secret"],
    choices: { "Country or region": "Canada" },
  });
  assert.match(prompt, /"select"/);
  assert.match(prompt, /Country or region/);
  assert.match(prompt, /device-code-required/);
  assert.match(prompt, /\["Client secret"\]/);
  assert.doesNotMatch(
    interpreterPrompt({
      goal: "sign-in",
      snapshot: snapshot(),
      available: [],
      history: [],
    }),
    /keeps what these read-only fields show/,
  );
});

test("ISSUED-HELD: a value the attempt typed or holds is never kept as an issued one", async () => {
  // The password went into a field labelled "Client secret", which the page
  // then made read-only. Reading it back must not send the password to the
  // plan's sink as though the provider had issued it.
  const password = "pw-typed-then-shown-5c1c";
  for (const held of [{ protectedValues: [password] }, {}]) {
    let typed = false;
    const page: CeremonyPage & { calls: string[] } = {
      ...inertPage("https://provider.example/settings/apps/1"),
      snapshot: async () =>
        snapshot({
          path: "https://provider.example/settings/apps/1",
          title: "Example app",
          headings: ["Example app"],
          elements: [
            {
              index: 0,
              kind: "input",
              type: "text",
              label: "Client ID",
              readOnly: true,
              filled: true,
            },
            {
              index: 1,
              kind: "input",
              type: "password",
              label: "Client secret",
              ...(typed ? { readOnly: true, filled: true } : {}),
            },
          ],
        }),
      fill: async () => {
        typed = true;
      },
      readIssued: async (element) =>
        element.label === "Client ID"
          ? "oac_client-held-1"
          : typed
            ? password
            : undefined,
    };
    const kept: unknown[] = [];
    const result = await runCeremony({
      page,
      goal: "obtain-credential",
      allowedOrigins: ["https://provider.example"],
      secrets: createSecrets({ password }),
      ...held,
      interpreter: async ({ snapshot: current }) =>
        current.elements[1]?.filled
          ? { action: "done" }
          : { action: "fill", element: 1, role: "password" },
      issued: {
        fields: issuedFields,
        keep: async (values) => {
          kept.push(values);
        },
      },
      verify: async () => true,
    });
    assert.deepEqual(kept, [], JSON.stringify(held));
    assert.equal(result.status, "unverified");
  }
});
