import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { parseHTML } from "linkedom";
import {
  pageSnapshotSchema,
  type PageSnapshot,
  type SnapshotElement,
} from "../../src/core/browser-contracts.js";
import {
  runCeremony,
  type CeremonyResult,
} from "../../src/server/browser-driver.js";
import {
  createHeuristicInterpreter,
  type CeremonyInterpreter,
} from "../../src/server/browser-interpreter.js";
import { createHttpCeremonyPage } from "../doubles/http-page.js";
import { createScriptedInterpreter } from "../doubles/scripted-interpreter.js";
import {
  assertFillsMatchLabels,
  fillMismatches,
  recordDecisions,
  type Decision,
} from "../doubles/fill-labels.js";
import {
  realisticLayouts,
  type RealisticLayout,
} from "../doubles/auth-provider/layouts.js";
import {
  authScenarios,
  createIdentity,
  startScenario,
  withLayout,
  type AuthScenario,
} from "../doubles/auth-provider/scenarios.js";
import {
  startAuthProvider,
  startUntrustedOrigin,
} from "../doubles/auth-provider/server.js";

/**
 * The scenario catalog on pages that look like real ones.
 *
 * `auth-scenarios.test.ts` runs every scenario on randomized pages, which is
 * how the suite finds a driver that fits pages instead of reading them. Those
 * pages are nothing like what a person meets, though, and a demo recorded on
 * them looked broken. These tests run the same scenarios, unchanged, on the
 * realistic layouts - classic card, identifier-first, split panel - with both
 * the scripted double and the production heuristic, and hold every fill to the
 * field it went into. An outcome reached with a password in the username box
 * is not a pass.
 *
 * As everywhere in this suite, the pages are ours. Passing says nothing about
 * any real provider.
 */

/**
 * Scenarios the production heuristic is not held to, with the reason. The
 * scripted double runs every scenario on every layout; these are gaps in the
 * heuristic that no layout causes or cures, and each one fails the same way
 * on the randomized pages.
 */
const heuristicExclusions: Record<string, string> = {
  "inert-sign-in-control":
    "`stalled` is the driver's verdict on an interpreter that keeps pressing a dead button; the heuristic reports the page unsupported instead of pressing again, by design",
  "sign-in-that-never-accepts":
    "`exhausted` is the driver's verdict on an interpreter that keeps resubmitting; the heuristic stops after one refill rather than spending the step budget, by design",
  "device-approval":
    "the heuristic has no user-code role; device authorization is outside the sign-in, registration, two-factor and authorization-code pages these layouts model",
  "access-token-issued-for-private-collection":
    "the heuristic does not recognise a page displaying an issued credential as the end of the ceremony, on any layout; issuing a credential is outside what these layouts model",
};

type Run = {
  result: CeremonyResult;
  decisions: Decision[];
  close(): Promise<void>;
};

async function run(
  t: TestContext,
  scenario: AuthScenario,
  interpreter: CeremonyInterpreter,
): Promise<Run & { confirm(): Promise<void>; secrets: string[] }> {
  const identity = createIdentity();
  const untrusted = scenario.needsUntrustedOrigin
    ? await startUntrustedOrigin()
    : undefined;
  if (untrusted) t.after(() => untrusted.close());
  const context = await startScenario(scenario, identity, untrusted);
  t.after(() => context.close());
  const plan = await scenario.plan(context);
  const headers = scenario.clientHeaders?.(context);
  const page = createHttpCeremonyPage(headers ? { headers } : {});
  await page.goto(plan.entryUrl);
  const recorded = recordDecisions(interpreter);
  const { entryUrl: _entry, state, ...options } = plan;
  const human = scenario.human?.(page, identity);
  const result = await runCeremony({
    ...options,
    page,
    interpreter: recorded.interpreter,
    ...(human ? { human } : {}),
  });
  return {
    result,
    decisions: recorded.decisions,
    close: () => context.close(),
    confirm: async () => scenario.confirm?.(context, result, state ?? {}),
    secrets: [
      identity.password,
      ...context.provider.mailbox.messages().map((mail) => mail.code),
    ],
  };
}

function detail(result: CeremonyResult): string {
  const reason = result.status === "blocked" ? `:${result.reason}` : "";
  return `${result.status}${reason} in ${result.steps} steps via ${
    result.transcript
      .map((step) => `${step.action}${step.role ? `(${step.role})` : ""}`)
      .join(" > ") || "no steps"
  }`;
}

for (const layout of realisticLayouts)
  for (const kind of ["scripted", "heuristic"] as const)
    for (const base of authScenarios) {
      if (kind === "heuristic" && base.id in heuristicExclusions) continue;
      test(`${layout} / ${kind}: ${base.id}`, async (t) => {
        const scenario = withLayout(base, layout);
        const { result, decisions, confirm, secrets } = await run(
          t,
          scenario,
          kind === "scripted"
            ? createScriptedInterpreter()
            : createHeuristicInterpreter(),
        );
        const summary = `${layout} ${kind} ${base.id}: ${detail(result)}`;
        assert.equal(result.status, scenario.expect.status, summary);
        if (scenario.expect.status === "blocked")
          assert.equal(
            result.status === "blocked" ? result.reason : undefined,
            scenario.expect.reason,
            summary,
          );
        if (scenario.expect.status === "completed" && scenario.expect.callback)
          assert.ok(
            result.status === "completed" && result.callback?.code,
            `${summary} — an authorization ceremony must capture a code`,
          );
        if (scenario.expect.handoffs !== undefined)
          assert.equal(result.handoffs, scenario.expect.handoffs, summary);

        // The whole point of a realistic page: every value in its own field,
        // under a visible label, and nothing submitted half-empty.
        assertFillsMatchLabels(result.transcript, decisions);

        // Styling adds markup, never a way for a value to leak.
        const seen = JSON.stringify(decisions.map((entry) => entry.snapshot));
        const recorded = JSON.stringify(result.transcript);
        for (const value of secrets) {
          assert.ok(!seen.includes(value), `${summary} disclosed a secret`);
          assert.ok(!recorded.includes(value), `${summary} recorded a secret`);
        }
        for (const { snapshot } of decisions)
          assert.doesNotThrow(() => pageSnapshotSchema.parse(snapshot));

        await confirm();
      });
    }

test("heuristic exclusions stay few and each says why", () => {
  const ids = new Set(authScenarios.map((scenario) => scenario.id));
  for (const [id, reason] of Object.entries(heuristicExclusions)) {
    assert.ok(ids.has(id), `${id} is not a scenario`);
    assert.ok(reason.length > 60, `${id} needs a real reason`);
  }
  assert.ok(Object.keys(heuristicExclusions).length <= 4);
});

/** The inputs a person would type into, in page order. */
const typed = (snapshot: PageSnapshot): SnapshotElement[] =>
  snapshot.elements.filter(
    (element) => element.kind === "input" || element.kind === "checkbox",
  );

for (const layout of realisticLayouts)
  test(`${layout}: pages follow the conventions real sign-in pages share`, async (t) => {
    // Walk the pages a ceremony actually meets - sign-in, the password step,
    // registration, both kinds of email confirmation, the second factor and
    // consent - and hold each to the same rules a person relies on.
    const snapshots: PageSnapshot[] = [];
    for (const id of [
      "sign-in-with-second-factor",
      "sign-in-unverified-account",
      "registration-with-emailed-code",
      "registration-with-confirmation-link",
      "authorization-code-with-consent",
    ]) {
      const base = authScenarios.find((scenario) => scenario.id === id)!;
      const { decisions } = await run(
        t,
        withLayout(base, layout),
        createScriptedInterpreter(),
      );
      snapshots.push(...decisions.map((entry) => entry.snapshot));
    }
    const paths = new Set(
      snapshots.map((snapshot) => new URL(snapshot.path).pathname),
    );
    for (const expected of ["/signin", "/signup", "/authorize"])
      assert.ok(paths.has(expected), `${layout} never showed ${expected}`);

    for (const snapshot of snapshots) {
      const where = `${layout} ${new URL(snapshot.path).pathname} "${snapshot.title}"`;
      assert.match(snapshot.title, / · /, `${where} names its product`);
      for (const element of typed(snapshot)) {
        assert.ok(element.label, `${where}: ${element.name} has no label`);
        assert.ok(element.name, `${where}: an input has no name`);
        if (element.kind === "input")
          assert.ok(
            element.autocomplete,
            `${where}: ${element.label} has no autocomplete`,
          );
      }
      const fields = typed(snapshot);
      const password = fields.findIndex((field) => field.type === "password");
      const identifier = fields.findIndex(
        (field) => field.autocomplete?.split(" ")[0] === "username",
      );
      if (password >= 0 && identifier >= 0)
        assert.ok(identifier < password, `${where}: password above identifier`);
      if (fields.some((field) => field.autocomplete === "new-password"))
        assert.deepEqual(
          fields.map((field) =>
            field.kind === "checkbox" ? "terms" : field.autocomplete,
          ),
          ["name", "email", "new-password", "new-password", "terms"],
          `${where}: registration fields out of the usual order`,
        );
      if (fields.some((field) => field.autocomplete === "one-time-code"))
        assert.equal(fields.length, 1, `${where}: one code input, not six`);
      // Decoration adds nothing to act on: every link names where it goes.
      for (const element of snapshot.elements)
        if (element.kind === "link" || element.kind === "button")
          assert.ok(element.text, `${where}: a control with no caption`);
    }
  });

for (const layout of realisticLayouts)
  test(`${layout}: the page is styled and its wordmark is not a control`, async (t) => {
    const provider = await startAuthProvider({ layout, seed: 7 });
    t.after(() => provider.close());
    for (const path of ["/signin", provider.signupPath]) {
      const html = await (await fetch(`${provider.origin}${path}`)).text();
      const { document } = parseHTML(html);
      assert.ok(document.querySelector("style"), `${path} carries its CSS`);
      assert.ok(
        document.querySelector('meta[name="viewport"]'),
        `${path} is laid out for a phone too`,
      );
      assert.equal(
        document.querySelector(".wordmark")?.closest("a"),
        null,
        `${path}: the wordmark must not be a link`,
      );
      for (const button of Array.from(document.querySelectorAll("form button")))
        assert.equal(button.getAttribute("type"), "submit");
      for (const input of Array.from(
        document.querySelectorAll("input:not([type=hidden])"),
      )) {
        const id = input.getAttribute("id");
        assert.ok(
          id && document.querySelector(`label[for="${id}"]`),
          `${path}: ${input.getAttribute("name")} has no <label for>`,
        );
      }
    }
  });

test("a realistic layout is the same page whatever the seed", async (t) => {
  // Realistic pages are for showing people, so they do not drift; the
  // randomized default is what varies.
  const shapes = new Set<string>();
  for (const seed of [1, 2, 3]) {
    const provider = await startAuthProvider({ layout: "classic-card", seed });
    t.after(() => provider.close());
    const page = createHttpCeremonyPage();
    await page.goto(`${provider.origin}${provider.signupPath}`);
    const snapshot = await page.snapshot();
    shapes.add(JSON.stringify(snapshot.elements));
  }
  assert.equal(shapes.size, 1);
});

test("a layout is only a look: identifier-first is the one that adds a step", async (t) => {
  const paths = async (layout: RealisticLayout) => {
    const base = authScenarios.find((scenario) => scenario.id === "sign-in")!;
    const { result } = await run(
      t,
      withLayout(base, layout),
      createScriptedInterpreter(),
    );
    assert.equal(result.status, "completed", detail(result));
    return [
      ...new Set(result.transcript.map((step) => new URL(step.path).pathname)),
    ];
  };
  assert.deepEqual(await paths("classic-card"), ["/signin", "/"]);
  assert.deepEqual(await paths("split-panel"), ["/signin", "/"]);
  assert.deepEqual(await paths("identifier-first"), [
    "/signin",
    "/signin/password",
    "/",
  ]);
});

test("the fill check catches a value in the wrong field", () => {
  // The recording that prompted this check: the password typed into the
  // identifier field, the identifier left empty, the form submitted anyway.
  const path = "https://provider.example/signin";
  const signIn = (filled: boolean[]): PageSnapshot => ({
    path,
    title: "Sign in · Example",
    headings: ["Sign in"],
    alerts: [],
    challenge: false,
    passkey: false,
    elements: [
      {
        index: 0,
        kind: "input",
        type: "text",
        name: "username",
        autocomplete: "username",
        label: "Email or username",
        required: true,
        filled: filled[0] ?? false,
      },
      {
        index: 1,
        kind: "input",
        type: "password",
        name: "password",
        autocomplete: "current-password",
        label: "Password",
        required: true,
        filled: filled[1] ?? false,
      },
      { index: 2, kind: "button", text: "Sign in" },
    ],
  });
  const wrong: Decision[] = [
    {
      snapshot: signIn([false, false]),
      action: { action: "fill", element: 0, role: "password" },
    },
    {
      snapshot: signIn([true, false]),
      action: { action: "click", element: 2 },
    },
  ];
  const problems = fillMismatches(
    [{ path, action: "fill", role: "password" }],
    wrong,
  );
  assert.ok(
    problems.some((problem) => /not a password field/.test(problem)),
    problems.join("; "),
  );
  assert.ok(
    problems.some((problem) => /still empty/.test(problem)),
    problems.join("; "),
  );

  const right: Decision[] = [
    {
      snapshot: signIn([false, false]),
      action: { action: "fill", element: 0, role: "username" },
    },
    {
      snapshot: signIn([true, false]),
      action: { action: "fill", element: 1, role: "password" },
    },
    {
      snapshot: signIn([true, true]),
      action: { action: "click", element: 2 },
    },
  ];
  assert.doesNotThrow(() =>
    assertFillsMatchLabels(
      [
        { path, action: "fill", role: "username" },
        { path, action: "fill", role: "password" },
        { path, action: "click" },
      ],
      right,
    ),
  );

  // A field with nothing to read it by is refused on a realistic page.
  const unlabelled = signIn([false, false]);
  delete unlabelled.elements[0]!.label;
  assert.throws(
    () =>
      assertFillsMatchLabels(
        [{ path, action: "fill", role: "username" }],
        [
          {
            snapshot: unlabelled,
            action: { action: "fill", element: 0, role: "username" },
          },
        ],
      ),
    /no label/,
  );
});
