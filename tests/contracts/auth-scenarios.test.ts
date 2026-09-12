import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test, type TestContext } from "node:test";
import {
  pageSnapshotSchema,
  secretRoles,
  type CeremonyRole,
  type PageSnapshot,
} from "../../src/core/browser-contracts.js";
import { flowKinds } from "../../src/core/schema.js";
import {
  runCeremony,
  type CeremonyResult,
} from "../../src/server/browser-driver.js";
import type {
  CeremonyInterpreter,
  InterpreterInput,
} from "../../src/server/browser-interpreter.js";
import { createHttpCeremonyPage } from "../doubles/http-page.js";
import { createScriptedInterpreter } from "../doubles/scripted-interpreter.js";
import {
  authScenarios,
  createIdentity,
  startScenario,
  type AuthScenario,
  type ScenarioContext,
  type ScenarioState,
} from "../doubles/auth-provider/scenarios.js";
import {
  startAuthProvider,
  startUntrustedOrigin,
} from "../doubles/auth-provider/server.js";

/**
 * Contract tests for isolated-browser auth ceremonies.
 *
 * Every scenario in the catalog runs against a self-hosted provider double that
 * serves real HTML over real HTTP with pages randomized per instance. Only the
 * inference boundary is substituted, which is what makes the suite
 * reproducible; the provider protocol, the driver, the snapshot and the rules
 * about secrets and origins are the real ones.
 *
 * A pass means the driver completed the ceremony these pages describe. It is
 * not evidence about a live provider: real sign-in pages change without notice,
 * and only the attended live checks speak to those.
 */

type Attempt = {
  result: CeremonyResult;
  /** Every input the interpreter received, for disclosure assertions. */
  inputs: InterpreterInput[];
  context: ScenarioContext;
  state: ScenarioState;
  budget: number;
};

async function attempt(
  t: TestContext,
  scenario: AuthScenario,
  overrides: { interpreter?: CeremonyInterpreter; seed?: number } = {},
): Promise<Attempt> {
  const identity = createIdentity();
  const untrusted = scenario.needsUntrustedOrigin
    ? await startUntrustedOrigin()
    : undefined;
  if (untrusted) t.after(() => untrusted.close());
  const context = await startScenario(
    scenario,
    identity,
    untrusted,
    overrides.seed,
  );
  t.after(() => context.provider.close());

  const plan = await scenario.plan(context);
  const page = createHttpCeremonyPage();
  await page.goto(plan.entryUrl);

  const inputs: InterpreterInput[] = [];
  const base = overrides.interpreter ?? createScriptedInterpreter();
  const interpreter: CeremonyInterpreter = async (input) => {
    inputs.push(structuredClone(input) as InterpreterInput);
    return base(input);
  };
  const { entryUrl: _entry, state, ...options } = plan;
  const human = scenario.human?.(page, identity);
  const result = await runCeremony({
    ...options,
    page,
    interpreter,
    ...(human ? { human } : {}),
  });
  return {
    result,
    inputs,
    context,
    state: state ?? {},
    budget: options.maxSteps ?? 24,
  };
}

function detail(result: CeremonyResult): string {
  const reason = result.status === "blocked" ? `:${result.reason}` : "";
  return `${result.status}${reason} in ${result.steps} steps via ${
    result.transcript.map((step) => step.action).join(" > ") || "no steps"
  }`;
}

for (const scenario of authScenarios) {
  test(`scenario: ${scenario.id} — ${scenario.title}`, async (t) => {
    const { result, inputs, context, state, budget } = await attempt(
      t,
      scenario,
    );
    const summary = `${scenario.id}: ${detail(result)}`;

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

    // The attempt terminates on its own terms, never by running out of patience.
    assert.ok(result.steps <= budget, `${summary} exceeded ${budget} steps`);
    if (scenario.expect.handoffs !== undefined)
      assert.equal(
        result.handoffs,
        scenario.expect.handoffs,
        `${scenario.id} asked a person ${result.handoffs} times`,
      );
    if (!scenario.human)
      assert.equal(
        result.handoffs,
        0,
        `${scenario.id} has no person to ask but recorded a handoff`,
      );

    // Every page the driver described must be a valid snapshot. A page it could
    // not express is a contract failure, not an interpreter miss.
    for (const input of inputs)
      assert.doesNotThrow(
        () => pageSnapshotSchema.parse(input.snapshot),
        `${scenario.id} produced an invalid snapshot`,
      );

    // A human challenge is the driver's to refuse. An interpreter that happens
    // to recognise one must not be what stops the attempt, so it is never
    // consulted on a challenge page in the first place.
    assert.ok(
      inputs.every((input) => !input.snapshot.challenge),
      `${scenario.id} asked the interpreter to act on a human challenge`,
    );

    // Declared roles are the roles the driver was actually offered.
    if (inputs.length > 0) {
      const offered = new Set<string>(inputs[0]!.available);
      for (const role of scenario.provides)
        assert.ok(
          offered.has(role),
          `${scenario.id} declares ${role} but never offered it`,
        );
    }

    // Nothing secret reaches the interpreter, the notes or the transcript.
    const secrets = [context.identity.password].filter((value) =>
      scenario.provides.some((role) =>
        secretRoles.includes(role as CeremonyRole),
      ),
    );
    const codes = context.provider.mailbox.messages().map((mail) => mail.code);
    const totp = context.provider.account(context.identity.email)?.totp;
    const disclosed = JSON.stringify(inputs);
    const recorded = JSON.stringify(result.transcript);
    for (const value of [...secrets, ...codes, ...(totp ? [totp] : [])]) {
      assert.ok(
        !disclosed.includes(value),
        `${scenario.id} disclosed a protected value to the interpreter`,
      );
      assert.ok(
        !recorded.includes(value),
        `${scenario.id} recorded a protected value in its transcript`,
      );
    }
    const code =
      result.status === "completed" ? result.callback?.code : undefined;
    for (const input of inputs) {
      assert.ok(
        !input.snapshot.path.includes("?"),
        `${scenario.id} put a query string in a snapshot path`,
      );
      if (code)
        assert.ok(
          !JSON.stringify(input).includes(code),
          `${scenario.id} disclosed an authorization code`,
        );
    }

    await scenario.confirm?.(context, result, state);
  });
}

test("an interpreter that never produces a usable action is reported, not waited on", async (t) => {
  const scenario = authScenarios.find((entry) => entry.id === "sign-in")!;
  const { result } = await attempt(t, scenario, {
    interpreter: async () => undefined,
  });
  assert.equal(result.status, "blocked", detail(result));
  assert.equal(
    result.status === "blocked" && result.reason,
    "unsupported-page",
  );
  assert.ok(result.steps <= 3, `Refusals must end quickly: ${result.steps}`);
});

test("an interpreter that only claims success never completes a ceremony", async (t) => {
  const scenario = authScenarios.find((entry) => entry.id === "sign-in")!;
  const { result, context } = await attempt(t, scenario, {
    interpreter: async () => ({ action: "done", note: "trust me" }),
  });
  assert.equal(result.status, "unverified", detail(result));
  assert.equal(
    await context.provider.verifyAccess(context.identity.email),
    false,
    "A claimed completion must not create provider access",
  );
});

test("an interpreter cannot use a role the caller never supplied", async (t) => {
  const scenario = authScenarios.find((entry) => entry.id === "sign-in")!;
  const offered: string[] = [];
  const { result, budget } = await attempt(t, scenario, {
    interpreter: async ({ snapshot, available }) => {
      offered.push(...available);
      const field = snapshot.elements.find(
        (element) => element.kind === "input",
      );
      return field
        ? { action: "fill", element: field.index, role: "totp-code" }
        : { action: "blocked", reason: "unsupported-page" };
    },
  });
  assert.ok(!offered.includes("totp-code"), "The role was not on offer");
  // The action is discarded before any value is resolved, and two of them end
  // the attempt by name. Any other ending means the driver tried to use it.
  assert.equal(result.status, "blocked", detail(result));
  assert.equal(
    result.status === "blocked" && result.reason,
    "unsupported-page",
  );
  assert.ok(
    result.steps < budget,
    `${result.steps} must be short of ${budget}`,
  );
  assert.deepEqual(
    result.transcript.filter((step) => step.action !== "blocked"),
    [],
    "A discarded action leaves no step of its own",
  );
});

test("a value the driver substituted cannot be echoed back out through a note", async (t) => {
  // The confirmation code is resolved from the mailbox during the attempt and
  // is never disclosed to the interpreter. This stands in for an interpreter
  // that learned it another way and tries to return it in a public status line.
  const scenario = authScenarios.find(
    (entry) => entry.id === "sign-in-unverified-account",
  )!;
  const identity = createIdentity();
  const context = await startScenario(scenario, identity);
  t.after(() => context.provider.close());
  const plan = await scenario.plan(context);
  const page = createHttpCeremonyPage();
  await page.goto(plan.entryUrl);

  const honest = createScriptedInterpreter();
  const { entryUrl: _entry, state: _state, ...options } = plan;
  let exfiltrated: string | undefined;
  await assert.rejects(
    runCeremony({
      ...options,
      page,
      interpreter: async (input) => {
        const action = await honest(input);
        const code = context.provider.mailbox.messages().at(-1)?.code;
        if (!code || action?.action !== "click") return action;
        exfiltrated = code;
        return { ...action, note: `submitting ${code}` };
      },
    }),
    (error: Error) => {
      assert.equal(error.name, "CeremonySecretLeak");
      return true;
    },
  );
  assert.ok(exfiltrated, "The attempt must have reached the confirmation step");
});

test("every normative flow kind has at least one scenario", () => {
  // The catalog is not allowed to look complete while a documented flow has no
  // page behind it. Adding a kind to `flowKinds` fails here until it does.
  const covered = new Set(authScenarios.map((scenario) => scenario.flowKind));
  for (const kind of flowKinds)
    assert.ok(covered.has(kind), `No scenario exercises the ${kind} flow`);
});

test("a step that needs a person is never handed to the interpreter", async (t) => {
  // Whether or not a person is available, the inference boundary is not asked
  // to clear a challenge, satisfy an authenticator or answer a dialog.
  for (const scenario of authScenarios.filter(
    (entry) =>
      entry.family === "Passkeys / WebAuthn" ||
      entry.family === "HTTP Basic" ||
      entry.id.startsWith("challenge-"),
  )) {
    const { inputs } = await attempt(t, scenario);
    // Conditional passkey UI still accepts a password, so it is not a human
    // step and the interpreter is expected to see it. A prompt with nothing
    // else to fill is, and must never reach the interpreter.
    const requiredAPerson = (input: InterpreterInput) =>
      input.snapshot.challenge ||
      (input.snapshot.passkey &&
        !input.snapshot.elements.some(
          (element) => element.type === "password",
        ));
    assert.ok(
      inputs.every((input) => !requiredAPerson(input)),
      `${scenario.id} asked the interpreter to act on a human step`,
    );
  }
});

test("the catalog covers the interaction families and outcomes this driver claims", () => {
  const families = new Set(authScenarios.map((scenario) => scenario.family));
  for (const required of [
    "Forms/session auth",
    "OAuth authorization code + PKCE",
    "OAuth device authorization",
    "OTP / magic link / MFA",
  ])
    assert.ok(families.has(required), `No scenario covers ${required}`);
  const outcomes = new Set<string>(
    authScenarios.map((scenario) => scenario.expect.status),
  );
  for (const required of ["completed", "blocked", "stalled", "exhausted"])
    assert.ok(outcomes.has(required), `No scenario ends ${required}`);
  const blocked = new Set<string>(
    authScenarios.flatMap((scenario) =>
      scenario.expect.status === "blocked" ? [scenario.expect.reason] : [],
    ),
  );
  for (const required of [
    "human-challenge",
    "credentials-rejected",
    "account-exists",
    "consent-denied",
    "untrusted-origin",
    "unsupported-page",
  ])
    assert.ok(blocked.has(required), `No scenario blocks on ${required}`);
  assert.equal(
    new Set(authScenarios.map((scenario) => scenario.id)).size,
    authScenarios.length,
    "Scenario identifiers must be unique",
  );
});

test("a randomized provider is genuinely different from instance to instance", async (t) => {
  const shapes = new Set<string>();
  for (const seed of [1, 2, 3, 4, 5]) {
    const provider = await startAuthProvider({ seed });
    t.after(() => provider.close());
    const page = createHttpCeremonyPage();
    await page.goto(`${provider.origin}${provider.signupPath}`);
    const snapshot: PageSnapshot = await page.snapshot();
    shapes.add(
      JSON.stringify([
        provider.signupPath,
        snapshot.elements.map((element) => [
          element.kind,
          element.type ?? "",
          element.label ?? element.placeholder ?? "",
        ]),
      ]),
    );
  }
  assert.ok(
    shapes.size >= 4,
    `Randomization must vary the page shape; saw ${shapes.size} distinct of 5`,
  );
});

test("a seed replays the same pages exactly", async (t) => {
  // Randomization is only useful if a failure can be reproduced. Two instances
  // of the same seed must serve identical pages, and a page must not change
  // shape between requests to the same instance.
  const shapes: string[] = [];
  for (const pass of [0, 1]) {
    const provider = await startAuthProvider({
      seed: 90210,
      requireTerms: true,
    });
    t.after(() => provider.close());
    for (const path of [provider.signupPath, "/signin", provider.signupPath]) {
      const page = createHttpCeremonyPage();
      await page.goto(`${provider.origin}${path}`);
      const snapshot = await page.snapshot();
      shapes.push(
        `${pass === 0 ? "" : ""}${path}:${JSON.stringify(
          snapshot.elements.map((element) => [
            element.kind,
            element.type ?? "",
            element.name ?? "",
            element.label ?? element.placeholder ?? element.text ?? "",
          ]),
        )}`,
      );
    }
  }
  assert.equal(shapes[0], shapes[2], "Repeated requests must render the same");
  assert.deepEqual(
    shapes.slice(0, 3),
    shapes.slice(3),
    "The same seed must replay the same pages",
  );
});

test("ceremonies survive page shapes the catalog never fixed", async (t) => {
  // The catalog pins a seed per scenario so failures replay exactly. That alone
  // would let a driver pass by fitting twenty pages, so the same ceremonies are
  // also run against shapes no committed seed chose. Replay a failure with
  // SCENARIO_SEED; widen the sweep with SCENARIO_SEEDS.
  const base = Number(process.env["SCENARIO_SEED"] ?? Date.now() % 100_000);
  const sweep = Number(process.env["SCENARIO_SEEDS"] ?? 12);
  const covered = [
    "sign-in",
    "registration-with-emailed-code",
    "registration-requiring-terms",
    "registration-started-from-sign-in",
    "sign-in-with-second-factor",
    "authorization-code-with-consent",
  ];
  for (const id of covered) {
    const scenario = authScenarios.find((entry) => entry.id === id)!;
    for (let offset = 0; offset < sweep; offset++) {
      const seed = base + offset * 7919;
      const { result } = await attempt(t, scenario, { seed });
      assert.equal(
        result.status,
        scenario.expect.status,
        `${id} failed at seed ${seed} (replay with SCENARIO_SEED=${seed} SCENARIO_SEEDS=1): ${detail(result)}`,
      );
    }
  }
});

test("the documented catalog matches the one that runs", () => {
  // A table nobody checks drifts. This keeps the published list of scenarios,
  // preconditions and required roles tied to the entries actually executed.
  const doc = readFileSync(
    new URL("../../docs/auth-scenario-doubles.md", import.meta.url),
    "utf8",
  );
  // The table is Prettier-aligned, so rows are compared with padding collapsed.
  const rows = doc
    .split("\n")
    .filter((line) => line.startsWith("|"))
    .map((line) => line.replace(/\s+/g, " ").trim());
  for (const scenario of authScenarios) {
    const row = rows.find((line) => line.startsWith(`| \`${scenario.id}\` |`));
    assert.ok(row, `${scenario.id} is missing from the documented catalog`);
    assert.ok(
      row.includes(scenario.family),
      `${scenario.id} is documented under the wrong family`,
    );
    for (const requirement of [...scenario.preconditions, ...scenario.provides])
      assert.ok(
        row.includes(`\`${requirement}\``),
        `${scenario.id} does not document ${requirement}`,
      );
  }
});
