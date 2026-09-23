import assert from "node:assert/strict";
import { describe, test, type TestContext } from "node:test";
import type {
  CeremonyRole,
  PageSnapshot,
} from "../src/core/browser-contracts.js";
import { ceremonyPlanSchema, requiredOf } from "../src/core/ceremony-plan.js";
import {
  ceremonyPlanFromRecording,
  compileRecording,
  digestRecordedCeremony,
  looksLikeValue,
  parseRecordedCeremony,
  recordedCeremonySchema,
  RecordingRejected,
  type RecordedCeremony,
  type RecordedTraceEntry,
} from "../src/core/recorded-ceremony.js";
import {
  createSecrets,
  runCeremony,
  runRecordedCeremony,
} from "../src/server/browser-driver.js";
import {
  createHeuristicInterpreter,
  type CeremonyInterpreter,
} from "../src/server/browser-interpreter.js";
import { totpCode, totpSeedSpellings } from "../src/server/totp.js";
import { startAuthProvider } from "./doubles/auth-provider/server.js";
import { createHttpCeremonyPage } from "./doubles/http-page.js";
import { createScriptedInterpreter } from "./doubles/scripted-interpreter.js";

/**
 * Recording a login the code has never seen, and replaying it with no model.
 *
 * The provider is the self-hosted double in its identifier-first shape: the
 * identifier on one page, the password on the next, then an authenticator
 * code computed from a seed. Its page shape is regenerated from a seed, so
 * nothing here knows its field names, labels or captions in advance - the
 * scripted interpreter stands in for the model that reads them once, and the
 * recording is what lets every later login skip that reading.
 *
 * Every credential is a canary. Nothing in this file may find one in a
 * recording, a transcript or a drift report.
 */

const USERNAME = "canary-user-5b8e";
const EMAIL = "canary.5b8e@example.test";
const PASSWORD = "Canary-Pw-7f3a9c1e!";
/** Synthetic enrolment secret. Nothing else in the repository produces it. */
const SEED = "KRSXG5CTMVRXEZLUKRSXG5CTMVRXEZLU";

async function provider(t: TestContext, seed = 41) {
  const double = await startAuthProvider({
    seed,
    identifierFirst: true,
    requireMfa: true,
    totpSeed: SEED,
    accounts: [{ email: EMAIL, username: USERNAME, password: PASSWORD }],
  });
  t.after(() => double.close());
  return double;
}

/** The codes that could have been typed while a test ran. */
function recentCodes(): string[] {
  const now = Date.now();
  return [-60_000, -30_000, 0, 30_000].map((skew) =>
    totpCode(SEED, now + skew),
  );
}

const canaries = () => [
  USERNAME,
  EMAIL,
  PASSWORD,
  ...totpSeedSpellings(SEED),
  ...recentCodes(),
];

function assertNoCanary(surface: unknown, where: string) {
  const text = JSON.stringify(surface).toLowerCase();
  for (const canary of canaries())
    assert.ok(
      !text.includes(canary.toLowerCase()),
      `${where} carries a protected value`,
    );
}

/** Values a caller holds, resolved by role; the code derived at fill time. */
function secrets() {
  const resolved: string[] = [];
  const give = (value: string) => async () => {
    resolved.push(value);
    return value;
  };
  return {
    resolved,
    secrets: createSecrets({
      username: give(USERNAME),
      password: give(PASSWORD),
      "totp-code": async () => {
        const code = totpCode(SEED, Date.now());
        resolved.push(code);
        return code;
      },
    }),
  };
}

/** Count every call, so "no model was consulted" is a number, not a hope. */
function counting(interpreter: CeremonyInterpreter) {
  const counter = { calls: 0 };
  const wrapped: CeremonyInterpreter = async (input) => {
    counter.calls++;
    return interpreter(input);
  };
  return { counter, interpreter: wrapped };
}

/** Log in once with the interpreter reading the pages, and compile it. */
async function recordAt(double: { origin: string }) {
  const page = createHttpCeremonyPage();
  await page.goto(`${double.origin}/signin`);
  const trace: RecordedTraceEntry[] = [];
  const { secrets: held, resolved } = secrets();
  const result = await runCeremony({
    page,
    interpreter: createScriptedInterpreter(),
    goal: "sign-in",
    secrets: held,
    allowedOrigins: [double.origin],
    protectedValues: [PASSWORD, ...totpSeedSpellings(SEED)],
    onApplied: (entry) => trace.push(entry),
  });
  const recording = compileRecording(trace, {
    id: "fixture-idp-sign-in",
    title: "Fixture provider sign-in",
    goal: "sign-in",
    entryUrl: `${double.origin}/signin`,
    origins: [double.origin],
    recordedWith: "host-model",
    excluded: [...resolved, PASSWORD, ...totpSeedSpellings(SEED)],
  });
  return { result, trace, recording };
}

async function replay(
  double: { origin: string },
  recording: RecordedCeremony,
  fallback?: CeremonyInterpreter,
) {
  const page = createHttpCeremonyPage();
  await page.goto(`${double.origin}/signin`);
  const { secrets: held } = secrets();
  const transcript: unknown[] = [];
  const result = await runRecordedCeremony({
    page,
    recording,
    goal: "sign-in",
    secrets: held,
    allowedOrigins: [double.origin],
    protectedValues: [PASSWORD, ...totpSeedSpellings(SEED)],
    onStep: (step) => transcript.push(step),
    ...(fallback ? { fallback } : {}),
  });
  return { result, transcript, history: page.history() };
}

describe("RECORD: a login on a provider the code has never seen becomes a recording", () => {
  test("identifier-first, password and a seed-derived code compile to value-free steps", async (t) => {
    const double = await provider(t);
    const { result, recording } = await recordAt(double);
    assert.equal(result.status, "unverified", JSON.stringify(result));
    assert.ok(await double.verifyAccess(EMAIL), "the provider signed us in");

    // What the procedure is: fill, press, fill, press, fill, press - and
    // which role each field takes. Nothing about what was typed.
    const actions = recording.steps.map((step) =>
      step.action.kind === "fill"
        ? `fill:${step.action.role}`
        : step.action.kind,
    );
    assert.deepEqual(actions, [
      "fill:username",
      "click",
      "fill:password",
      "click",
      "fill:totp-code",
      "click",
    ]);
    assert.deepEqual([...recording.roles].sort(), [
      "password",
      "totp-code",
      "username",
    ]);
    assert.deepEqual(recording.origins, [double.origin]);
    assert.ok(recording.success.length >= 1, "the signed-in page is recorded");
    // The identifier submit moves to another page; that is recorded too.
    const firstClick = recording.steps[1]!.action;
    assert.equal(
      firstClick.kind === "click" && firstClick.expect,
      "navigation",
    );
    assertNoCanary(recording, "the recording");
    // It round-trips through the published format unchanged.
    assert.deepEqual(
      parseRecordedCeremony(JSON.stringify(recording)),
      recording,
    );
    assert.match(
      await digestRecordedCeremony(recording),
      /^[A-Za-z0-9_-]{43}$/,
    );
  });

  test("the plan a recording implies asks for exactly the roles it fills", async (t) => {
    const double = await provider(t);
    const { recording } = await recordAt(double);
    const plan = ceremonyPlanSchema.parse(ceremonyPlanFromRecording(recording));
    const required = requiredOf(plan, plan.paths[0]!)
      .map((datum) => datum.role)
      .sort();
    assert.deepEqual(required, ["password", "totp-code", "username"]);
    assert.ok(
      Object.values(plan.data)
        .filter((datum) => datum.role !== "username")
        .every((datum) => datum.secret),
    );
  });
});

describe("REPLAY: a recording runs again with no model in the loop", () => {
  test("a fresh browser signs in from the recording alone", async (t) => {
    const double = await provider(t);
    const { recording } = await recordAt(double);
    const model = counting(createScriptedInterpreter());
    // A second provider session starts from nothing: no cookie carried over.
    const { result, transcript } = await replay(double, recording);
    assert.equal(result.status, "unverified", JSON.stringify(result));
    assert.equal(result.drift, undefined);
    assert.equal(result.interpreterCalls, 0);
    assert.equal(model.counter.calls, 0);
    assert.equal(result.repaired, false);
    assert.equal(
      [...new Set(result.trace.map((entry) => entry.action))].join(","),
      "fill,click,done",
    );
    assertNoCanary(result.transcript, "the replay transcript");
    assertNoCanary(transcript, "the replay's progress events");
  });

  test("a redeployed page stops the replay by name, before anything is typed", async (t) => {
    const double = await provider(t);
    const { recording } = await recordAt(double);
    // Same origin, same accounts, every label, name and caption regenerated.
    double.restyle(9001);
    const { result, history } = await replay(double, recording);
    assert.equal(result.status, "blocked");
    assert.equal(result.drift?.kind, "element-missing", JSON.stringify(result));
    assert.equal(result.drift?.step, "step-1");
    assert.equal(result.drift?.observed, `${double.origin}/signin`);
    assert.match(result.drift?.target ?? "", /^input type=text/);
    // Nothing was filled or pressed: the only document loaded is the entry.
    assert.equal(result.trace.length, 0);
    assert.deepEqual(
      history.map((address) => new URL(address).pathname),
      ["/signin"],
    );
    assertNoCanary(result, "a drift report");
  });

  test("only with a fallback, the drifted steps are repaired and the rest replayed", async (t) => {
    const double = await provider(t);
    const { recording } = await recordAt(double);
    double.restyle(9001);
    const model = counting(createScriptedInterpreter());
    const { result } = await replay(double, recording, model.interpreter);
    assert.equal(result.status, "unverified", JSON.stringify(result));
    assert.equal(result.repaired, true);
    assert.equal(result.drift?.kind, "element-missing");
    assert.ok(result.interpreterCalls > 0);
    assert.equal(result.interpreterCalls, model.counter.calls);
    // It ended on the signed-in page, which the double serves only to a
    // browser whose session has both factors.
    assert.equal(result.trace.at(-1)?.action, "done");
    assert.equal(new URL(result.trace.at(-1)!.snapshot.path).pathname, "/");
    // What worked compiles into a new recording, marked as a repair of the
    // one it came from. It is a draft-in-waiting, never a published version.
    const repaired = compileRecording(result.trace, {
      id: recording.id,
      title: recording.title,
      goal: "sign-in",
      entryUrl: `${double.origin}/signin`,
      origins: [double.origin],
      recordedWith: "repair",
      basedOn: {
        id: recording.id,
        version: "1.0.1",
        digest: await digestRecordedCeremony(recording),
      },
      excluded: [USERNAME, PASSWORD, ...recentCodes()],
    });
    assert.equal(repaired.recordedWith, "repair");
    assert.notDeepEqual(repaired.steps, recording.steps);
    assertNoCanary(repaired, "a repaired recording");
    // And the repair replays cleanly against the page as it is now.
    const again = await replay(double, repaired);
    assert.equal(again.result.status, "unverified");
    assert.equal(again.result.interpreterCalls, 0);
  });

  test("a recording naming an origin the login does not admit never opens a page", async (t) => {
    const double = await provider(t);
    const { recording } = await recordAt(double);
    const page = createHttpCeremonyPage();
    const result = await runRecordedCeremony({
      page,
      recording,
      goal: "sign-in",
      secrets: secrets().secrets,
      allowedOrigins: ["https://elsewhere.example"],
    });
    assert.equal(result.status, "blocked");
    assert.equal(result.drift?.kind, "undeclared-origin");
    assert.deepEqual(page.history(), []);
  });

  test("a recording filling a role the login cannot supply is refused up front", async (t) => {
    const double = await provider(t);
    const { recording } = await recordAt(double);
    const page = createHttpCeremonyPage();
    const result = await runRecordedCeremony({
      page,
      recording,
      goal: "sign-in",
      secrets: createSecrets({ username: USERNAME, password: PASSWORD }),
      allowedOrigins: [double.origin],
    });
    assert.equal(result.drift?.kind, "missing-role");
    assert.equal(result.drift?.role, "totp-code");
    assert.deepEqual(page.history(), []);

    // A login that keeps the seed an enrolment page shows answers the code
    // from that seed, so the same recording is not refused for it.
    const enrolling = createHttpCeremonyPage();
    const kept = await runRecordedCeremony({
      page: enrolling,
      recording,
      goal: "sign-in",
      secrets: createSecrets({ username: USERNAME, password: PASSWORD }),
      allowedOrigins: [double.origin],
      issued: { fields: { "totp-seed": "Setup key" }, keep: async () => {} },
    });
    assert.notEqual(kept.drift?.kind, "missing-role");
  });

  test("a branch stops the replay under its own reason, as recorded", async (t) => {
    const double = await provider(t);
    const { recording } = await recordAt(double);
    const guarded: RecordedCeremony = recordedCeremonySchema.parse({
      ...recording,
      branches: [
        {
          id: "account-chooser",
          when: { origin: double.origin, path: "/signin" },
          then: { do: "stop", reason: "account-missing" },
        },
      ],
    });
    const { result } = await replay(double, guarded);
    assert.equal(result.status, "blocked");
    assert.equal(
      result.status === "blocked" ? result.reason : undefined,
      "account-missing",
    );
    assert.equal(result.drift, undefined);
  });
});

describe("SCHEMA: a recording cannot hold a value", () => {
  const base = (): RecordedCeremony => ({
    schemaVersion: 1,
    id: "schema-case",
    title: "Schema case",
    goal: "sign-in",
    entry: { origin: "https://idp.example", path: "/signin" },
    origins: ["https://idp.example"],
    roles: ["password"],
    steps: [
      {
        id: "step-1",
        page: { origin: "https://idp.example", path: "/signin" },
        action: {
          kind: "fill",
          role: "password",
          target: {
            kind: "input",
            type: "password",
            label: "Password",
            ordinal: 0,
            of: 1,
          },
        },
        optional: false,
      },
    ],
    branches: [],
    success: [],
    recordedWith: "deterministic",
  });

  test("the base case is valid", () => {
    assert.ok(recordedCeremonySchema.safeParse(base()).success);
  });

  test("a value field is not a field", () => {
    const withValue = base() as unknown as {
      steps: { action: Record<string, unknown> }[];
    };
    withValue.steps[0]!.action["value"] = PASSWORD;
    assert.equal(recordedCeremonySchema.safeParse(withValue).success, false);
    const onTarget = base() as unknown as {
      steps: { action: { target: Record<string, unknown> } }[];
    };
    onTarget.steps[0]!.action.target["value"] = PASSWORD;
    assert.equal(recordedCeremonySchema.safeParse(onTarget).success, false);
    const onStep = base() as unknown as { steps: Record<string, unknown>[] };
    onStep.steps[0]!["value"] = PASSWORD;
    assert.equal(recordedCeremonySchema.safeParse(onStep).success, false);
  });

  test("descriptor text that looks like a value is refused", () => {
    for (const label of [
      EMAIL,
      "Code 481516",
      "jbsw y3dp ehpk 3pxp jbsw y3dp ehpk 3pxp",
      "otpauth://totp/Example?secret=X",
      "ghp_0123456789abcdefghijABCDEFGHIJ0123",
    ]) {
      const recording = base();
      const action = recording.steps[0]!.action;
      if (action.kind === "fill") action.target.label = label;
      assert.equal(
        recordedCeremonySchema.safeParse(recording).success,
        false,
        label,
      );
    }
    // An ordinary upper-case caption is not a seed.
    assert.equal(looksLikeValue("SIGN INTO YOUR ACCOUNT"), false);
  });

  test("every origin must be declared, and a path is never a query", () => {
    const undeclared = base();
    undeclared.steps[0]!.page.origin = "https://other.example";
    assert.equal(recordedCeremonySchema.safeParse(undeclared).success, false);
    const insecure = base();
    insecure.origins = ["http://idp.example"];
    assert.equal(recordedCeremonySchema.safeParse(insecure).success, false);
    for (const path of [
      "/signin?login_hint=x",
      "/signin#code",
      "/**",
      "signin",
    ]) {
      const recording = base();
      recording.steps[0]!.page.path = path;
      assert.equal(
        recordedCeremonySchema.safeParse(recording).success,
        false,
        path,
      );
    }
  });

  test("roles and fills agree, and a secret goes only into a field", () => {
    const undeclared = base();
    undeclared.roles = [];
    assert.equal(recordedCeremonySchema.safeParse(undeclared).success, false);
    const extra = base();
    extra.roles = ["password", "username"];
    assert.equal(recordedCeremonySchema.safeParse(extra).success, false);
    const intoButton = base();
    const action = intoButton.steps[0]!.action;
    if (action.kind === "fill") action.target.kind = "button";
    assert.equal(recordedCeremonySchema.safeParse(intoButton).success, false);
    const intoCheckbox = base();
    const other = intoCheckbox.steps[0]!.action;
    if (other.kind === "fill") other.target.type = "checkbox";
    assert.equal(recordedCeremonySchema.safeParse(intoCheckbox).success, false);
  });

  test("a control with nothing stable to be found by is refused", () => {
    const anonymous = base();
    const action = anonymous.steps[0]!.action;
    if (action.kind === "fill") delete action.target.label;
    assert.equal(recordedCeremonySchema.safeParse(anonymous).success, false);
  });

  test("an import is bounded", () => {
    assert.throws(
      () => parseRecordedCeremony(" ".repeat(64 * 1024 + 1)),
      /import limit/,
    );
  });
});

describe("COMPILE: the trace is scrubbed, and then checked as if it were not", () => {
  const snapshot = (
    path: string,
    elements: PageSnapshot["elements"],
  ): PageSnapshot => ({
    path,
    title: "t",
    headings: [],
    alerts: [],
    challenge: false,
    passkey: false,
    elements,
  });
  const options = {
    id: "compile-case",
    title: "Compile case",
    goal: "sign-in" as const,
    entryUrl: "https://idp.example/signin",
    origins: ["https://idp.example"],
    recordedWith: "deterministic" as const,
    excluded: [USERNAME, PASSWORD],
  };

  test("a caption that names the signed-in person costs the descriptor, not the recording", () => {
    const recording = compileRecording(
      [
        {
          snapshot: snapshot("https://idp.example/signin", [
            {
              index: 0,
              kind: "button",
              name: "continue",
              text: `Continue as ${USERNAME}`,
            },
          ]),
          action: "click",
          element: 0,
        },
      ],
      options,
    );
    const action = recording.steps[0]!.action;
    assert.equal(action.kind, "click");
    assert.equal(action.kind === "click" && action.target.text, undefined);
    assert.equal(action.kind === "click" && action.target.name, "continue");
    assertNoCanary(recording, "a scrubbed recording");
  });

  test("a control identified only by a value leaves nothing to record, and says so", () => {
    assert.throws(
      () =>
        compileRecording(
          [
            {
              snapshot: snapshot("https://idp.example/signin", [
                { index: 0, kind: "button", text: `Continue as ${EMAIL}` },
              ]),
              action: "click",
              element: 0,
            },
          ],
          options,
        ),
      (error: unknown) =>
        error instanceof RecordingRejected &&
        error.reason === "unidentifiable-element",
    );
  });

  test("a value that survives the scrub anywhere refuses the whole recording", () => {
    // A path segment is not a descriptor, so it is not scrubbed one by one;
    // the check over the finished bytes is what catches it.
    assert.throws(
      () =>
        compileRecording(
          [
            {
              snapshot: snapshot(`https://idp.example/u/${USERNAME}`, [
                { index: 0, kind: "button", name: "go", text: "Go" },
              ]),
              action: "click",
              element: 0,
            },
          ],
          options,
        ),
      (error: unknown) =>
        error instanceof RecordingRejected &&
        error.reason === "protected-value",
    );
  });

  test("an action on an origin the login did not admit is refused", () => {
    assert.throws(
      () =>
        compileRecording(
          [
            {
              snapshot: snapshot("https://other.example/signin", [
                { index: 0, kind: "button", name: "go", text: "Go" },
              ]),
              action: "click",
              element: 0,
            },
          ],
          options,
        ),
      (error: unknown) =>
        error instanceof RecordingRejected &&
        error.reason === "undeclared-origin",
    );
  });

  test("attempt-specific path segments become wildcards, and retries are not replayed", () => {
    const page = snapshot(
      "https://idp.example/flows/0f8fad5b-d9cb-469f-a165-70867728950e/password",
      [{ index: 0, kind: "input", type: "password", label: "Password" }],
    );
    const role: CeremonyRole = "password";
    const recording = compileRecording(
      [
        { snapshot: page, action: "fill", element: 0, role },
        { snapshot: page, action: "fill", element: 0, role },
      ],
      options,
    );
    assert.equal(recording.steps.length, 1);
    assert.equal(recording.steps[0]!.page.path, "/flows/*/password");
  });

  test("an empty trace is not a recording", () => {
    assert.throws(
      () => compileRecording([], options),
      (error: unknown) =>
        error instanceof RecordingRejected && error.reason === "empty",
    );
  });
});

describe("choices and issued values in a recording", () => {
  const origin = "https://idp.example";
  const signupPage = (option = "Canada"): PageSnapshot => ({
    path: `${origin}/signup`,
    title: "Create your account",
    headings: ["Create your account"],
    alerts: [],
    challenge: false,
    passkey: false,
    elements: [
      {
        index: 0,
        kind: "select",
        name: "country",
        label: "Country or region",
        options: ["Select a country", option],
        required: true,
      },
      { index: 1, kind: "button", text: "Create account" },
    ],
  });
  const options = {
    id: "region-sign-up",
    title: "Sign up with a region",
    goal: "registration" as const,
    entryUrl: `${origin}/signup`,
    origins: [origin],
    recordedWith: "deterministic" as const,
    excluded: [],
  };

  test("a choice is recorded by the option's label, and one that reads like a value is not recorded at all", () => {
    const recording = compileRecording(
      [
        {
          snapshot: signupPage(),
          action: "select",
          element: 0,
          option: "Canada",
        },
        { snapshot: signupPage(), action: "click", element: 1 },
      ],
      options,
    );
    assert.equal(recording.steps[0]?.action.kind, "select");
    assert.deepEqual(recording.roles, []);
    for (const option of ["casey@example.test", "Account 12345678"])
      assert.throws(
        () =>
          compileRecording(
            [
              {
                snapshot: signupPage(option),
                action: "select",
                element: 0,
                option,
              },
            ],
            options,
          ),
        (error: unknown) =>
          error instanceof RecordingRejected &&
          error.reason === "unrecordable-choice",
      );
  });

  test("a choice is only ever made in a select", () => {
    const recording = compileRecording(
      [
        {
          snapshot: signupPage(),
          action: "select",
          element: 0,
          option: "Canada",
        },
      ],
      options,
    );
    const edited = structuredClone(recording) as {
      steps: { action: { target: { kind: string } } }[];
    };
    edited.steps[0]!.action.target.kind = "input";
    assert.equal(recordedCeremonySchema.safeParse(edited).success, false);
  });

  test("what a recording keeps is part of what is reviewed, and is held to the declaration's rules", async () => {
    const plain = compileRecording(
      [{ snapshot: signupPage(), action: "click", element: 1 }],
      options,
    );
    const issued = {
      sink: "oauth-client" as const,
      fields: [
        { kind: "client-id" as const, label: "Client ID" },
        { kind: "client-secret" as const, label: "Client secret" },
      ],
    };
    const keeping = compileRecording(
      [{ snapshot: signupPage(), action: "click", element: 1 }],
      { ...options, issued },
    );
    assert.deepEqual(keeping.issued, issued);
    // A different digest: a review of the recording without it covers
    // nothing about keeping.
    assert.notEqual(
      await digestRecordedCeremony(plain),
      await digestRecordedCeremony(keeping),
    );
    const refused = [
      { ...issued, fields: [{ kind: "api-key", label: "Key" }] },
      {
        ...issued,
        fields: [
          { kind: "client-id", label: "Client ID" },
          { kind: "client-secret", label: "Client ID" },
        ],
      },
      {
        ...issued,
        fields: [
          { kind: "client-id", label: "Client ID" },
          { kind: "client-secret", label: "Client secret" },
          { kind: "client-secret", label: "Secret" },
        ],
      },
      { sink: "oauth-client", fields: [{ kind: "client-secret", label: "S" }] },
      { sink: "anywhere", fields: issued.fields },
      { ...issued, fields: [{ kind: "client-id", label: "oac_1234567890" }] },
    ];
    for (const declaration of refused)
      assert.equal(
        recordedCeremonySchema.safeParse({ ...plain, issued: declaration })
          .success,
        false,
        JSON.stringify(declaration),
      );
  });

  test("a registration with a required choice is recorded on the double and replays with no interpreter", async (t) => {
    const record = await startAuthProvider({
      seed: 91,
      requireRegion: true,
      verification: "none",
    });
    t.after(() => record.close());
    const secrets = () =>
      createSecrets({
        email: EMAIL,
        password: PASSWORD,
        "password-confirm": PASSWORD,
        "display-name": "Casey Rivers",
      });
    const page = createHttpCeremonyPage();
    await page.goto(`${record.origin}${record.signupPath}`);
    const trace: RecordedTraceEntry[] = [];
    const recorded = await runCeremony({
      page,
      interpreter: createHeuristicInterpreter(),
      goal: "registration",
      secrets: secrets(),
      allowedOrigins: [record.origin],
      choices: { "Country or region": "Germany" },
      onApplied: (entry) => trace.push(entry),
      verify: () => record.verifyAccess(EMAIL),
    });
    assert.equal(recorded.status, "completed");
    assert.equal(record.regionOf(EMAIL), "DE");
    const recording = compileRecording(trace, {
      ...options,
      entryUrl: `${record.origin}${record.signupPath}`,
      origins: [record.origin],
      excluded: [EMAIL, PASSWORD],
    });
    assert.ok(
      recording.steps.some(
        (step) =>
          step.action.kind === "select" && step.action.option === "Germany",
      ),
    );
    assertNoCanary(recording, "the recording");

    // The same pages at a fresh provider, replayed with nothing to ask.
    const replayAt = await startAuthProvider({
      seed: 91,
      requireRegion: true,
      verification: "none",
    });
    t.after(() => replayAt.close());
    const fresh = createHttpCeremonyPage();
    await fresh.goto(`${replayAt.origin}${replayAt.signupPath}`);
    const at = (text: string) =>
      text.split(record.origin).join(replayAt.origin);
    const moved = JSON.parse(at(JSON.stringify(recording))) as RecordedCeremony;
    const replayed = await runRecordedCeremony({
      page: fresh,
      recording: moved,
      goal: "registration",
      secrets: secrets(),
      allowedOrigins: [replayAt.origin],
      verify: () => replayAt.verifyAccess(EMAIL),
    });
    assert.equal(replayed.status, "completed");
    assert.equal(replayed.interpreterCalls, 0);
    assert.equal(replayAt.regionOf(EMAIL), "DE");
  });
});
