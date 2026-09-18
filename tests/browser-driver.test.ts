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
  createHeuristicInterpreter,
  createModelInterpreter,
  interpreterPrompt,
  interpreterRoles,
  type InterpreterInput,
} from "../src/server/browser-interpreter.js";
import {
  createPlaywrightCeremonyPage,
  DispatchUncertain,
  StaleTargetError,
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
  for (const [goal, label] of [
    ["sign-in", "Already have an account? Log in"],
    ["registration", "Create an account"],
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
    input.history = [{ action: "fill" }, { action: "click", note: "Continue" }];
    assert.deepEqual(await interpret(input), {
      action: "click",
      element: 3,
      note: label,
    });
    input.history = [...input.history, { action: "click", note: label }];
    assert.deepEqual(await interpret(input), { action: "wait" });
    input.history = [...input.history, { action: "wait" }];
    assert.deepEqual(await interpret(input), {
      action: "blocked",
      reason: "unsupported-page",
    });
  }
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
    selectOption: async (value: string) => {
      calls.push(`select ${index} ${value}`);
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
              ? snapshot()
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
      };
      return fn({ root: bound, index: arg.index });
    }) as PlaywrightPageLike["evaluate"],
    waitForLoadState: async (state) => {
      calls.push(`settle ${state}`);
    },
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
