import { test } from "node:test";
import assert from "node:assert/strict";
import type { TestContext } from "node:test";
import {
  canonicalCeremonyPlan,
  digestCeremonyPlan,
  parseCeremonyPlan,
  preferredPath,
  requiredOf,
} from "../../src/core/ceremony-plan.js";
import {
  discoverCeremony,
  inferRole,
  type CeremonyClassifier,
} from "../../src/server/ceremony-discovery.js";
import type { PageSnapshot } from "../../src/core/browser-contracts.js";
import type { CeremonyPage } from "../../src/server/browser-driver.js";
import { startAuthProvider } from "../doubles/auth-provider/server.js";
import { createHttpCeremonyPage } from "../doubles/http-page.js";

/**
 * Discovery, read against the same provider doubles the ceremonies run on.
 *
 * The point of these is not that discovery produces a particular plan — page
 * shapes are randomized per instance, so a golden plan would be meaningless.
 * It is that the plan it produces says true things about the provider, and
 * that producing it changed nothing at the provider.
 */

async function provider(
  t: TestContext,
  behavior: Parameters<typeof startAuthProvider>[0] = {},
) {
  const double = await startAuthProvider({ seed: 7, ...behavior });
  t.after(() => double.close());
  return double;
}

const discover = (double: { origin: string }, path: string, goal = "sign-in") =>
  discoverCeremony({
    page: createHttpCeremonyPage(),
    entryUrl: `${double.origin}${path}`,
    goal: goal as "sign-in",
    allowedOrigins: [double.origin],
  });

test("discovery names the data a sign-in actually asks for", async (t) => {
  const double = await provider(t);
  const { plan } = await discover(double, "/signin");
  const roles = Object.values(plan.data).map((datum) => datum.role);
  assert.ok(roles.includes("username"), `saw roles: ${roles.join(", ")}`);
  assert.ok(roles.includes("password"), `saw roles: ${roles.join(", ")}`);
  // A password is a credential wherever it is found.
  const password = Object.values(plan.data).find(
    (datum) => datum.role === "password",
  );
  assert.equal(password?.secret, true);
  assert.deepEqual(password?.source, { from: "caller" });
});

test("discovery changes nothing at the provider", async (t) => {
  // The property that makes it safe to point at somebody else's service: it
  // reads pages and follows links, and never submits anything.
  const double = await provider(t, { verification: "code" });
  const before = double.accounts().length;
  await discover(double, `${double.signupPath}`, "registration");
  await discover(double, "/signin");
  assert.equal(double.accounts().length, before, "no account was created");
  assert.deepEqual(double.mailbox.messages(), [], "no mail was sent");
  assert.deepEqual(double.issuedTokens(), [], "no credential was issued");
  assert.deepEqual(double.installed(), []);
  assert.deepEqual(double.authenticatedBasic(), []);
});

test("a registration form is read as the data a caller must bring", async (t) => {
  const double = await provider(t, { verification: "code" });
  const { plan } = await discover(double, double.signupPath, "registration");
  const roles = Object.values(plan.data).map((datum) => datum.role);
  assert.ok(roles.includes("email"), `saw roles: ${roles.join(", ")}`);
  assert.ok(roles.includes("password"), `saw roles: ${roles.join(", ")}`);
  const path = preferredPath(plan);
  const required = requiredOf(plan, path).map((datum) => datum.role);
  // Everything the caller is told to bring is something they could hold. A
  // code the provider has not sent yet is never on this list.
  assert.ok(!required.includes("verification-code"));
});

/**
 * A page the double cannot serve to a reader who has not signed in. The port
 * exists to be substituted, and substituting it is the only honest way to test
 * how a shape like this is read — the alternative was a test that returned
 * early and asserted nothing.
 */
function scriptedPage(
  pages: Record<
    string,
    { snapshot: PageSnapshot; links?: Record<number, string> }
  >,
  start: string,
): CeremonyPage {
  let current = start;
  return {
    url: async () => current,
    goto: async (target) => {
      current = target;
    },
    settle: async () => {},
    snapshot: async () => pages[current]!.snapshot,
    click: async (element) => {
      current = pages[current]?.links?.[element.index] ?? current;
    },
    fill: async () => {
      throw new Error("Discovery must never fill a field");
    },
    check: async () => {
      throw new Error("Discovery must never check a box");
    },
  };
}

const page = (
  path: string,
  elements: PageSnapshot["elements"],
  extra: Partial<PageSnapshot> = {},
): PageSnapshot => ({
  path,
  title: "",
  headings: ["Confirm your address"],
  alerts: [],
  challenge: false,
  passkey: false,
  elements,
  ...extra,
});

test("a code field is attributed to the step that delivers it", async () => {
  // Discovery never triggered a send, so it cannot have observed delivery. It
  // names the step anyway, because the plan is unrunnable without it, and says
  // in `uncertain` that this part was inferred rather than seen.
  const origin = "https://provider.test";
  const { plan, uncertain } = await discoverCeremony({
    page: scriptedPage(
      {
        [`${origin}/confirm`]: {
          snapshot: page(`${origin}/confirm`, [
            {
              index: 0,
              kind: "input",
              type: "text",
              label: "Confirmation code",
            },
            { index: 1, kind: "button", text: "Confirm" },
          ]),
        },
      },
      `${origin}/confirm`,
    ),
    entryUrl: `${origin}/confirm`,
    goal: "registration",
    allowedOrigins: [origin],
  });

  const entries = Object.entries(plan.data);
  assert.equal(entries.length, 1);
  const [key, datum] = entries[0]!;
  assert.equal(datum.role, "verification-code");
  assert.equal(datum.secret, true);
  assert.equal(datum.source.from, "step");

  const producer = plan.steps.find(
    (step) => datum.source.from === "step" && step.id === datum.source.step,
  );
  assert.ok(producer, "the delivering step must be in the plan");
  assert.equal(producer.kind, "out-of-band");
  assert.deepEqual(producer.produces, [key]);

  // It must run before the page that asks for it, on every path.
  for (const path of plan.paths) {
    const delivery = path.steps.indexOf(producer.id);
    const asks = path.steps.findIndex((id) =>
      plan.steps.find((step) => step.id === id)?.uses.includes(key),
    );
    assert.ok(
      delivery >= 0 && delivery < asks,
      `${path.id} runs them in order`,
    );
  }

  // The caller is never told to bring a code that has not been sent.
  assert.deepEqual(requiredOf(plan, preferredPath(plan)), []);
  assert.ok(
    uncertain.some((line) => /arrives out of band/.test(line)),
    `an inferred delivery must be declared uncertain; got ${JSON.stringify(uncertain)}`,
  );
});

test("discovery refuses to act, even when a page invites it", async () => {
  // The scripted page throws if a field is filled or a box checked. Reaching
  // the end of discovery at all is the assertion.
  const origin = "https://provider.test";
  const { plan } = await discoverCeremony({
    page: scriptedPage(
      {
        [`${origin}/signin`]: {
          snapshot: page(`${origin}/signin`, [
            { index: 0, kind: "input", type: "text", label: "Login name" },
            { index: 1, kind: "input", type: "password", label: "Password" },
            { index: 2, kind: "checkbox", label: "Remember me" },
            { index: 3, kind: "button", text: "Sign in" },
          ]),
        },
      },
      `${origin}/signin`,
    ),
    entryUrl: `${origin}/signin`,
    goal: "sign-in",
    allowedOrigins: [origin],
  });
  assert.deepEqual(
    Object.values(plan.data)
      .map((datum) => datum.role)
      .sort(),
    ["password", "username"],
  );
});

test("a link that only appears once is reported, not silently dropped", async () => {
  // Replay is how a branch is reached, so a link that is not there the second
  // time means a branch went unexplored. Saying so is the difference between a
  // partial map and a wrong one.
  const origin = "https://provider.test";
  let seen = 0;
  const base = page(`${origin}/signin`, [
    { index: 0, kind: "input", type: "text", label: "Login name" },
    { index: 1, kind: "link", text: "Create an account" },
  ]);
  const { uncertain } = await discoverCeremony({
    page: {
      url: async () => `${origin}/signin`,
      goto: async () => {},
      settle: async () => {},
      // The link is gone by the time the branch is replayed.
      snapshot: async () =>
        seen++ === 0 ? base : { ...base, elements: [base.elements[0]!] },
      click: async () => {},
      fill: async () => {
        throw new Error("Discovery must never fill a field");
      },
      check: async () => {
        throw new Error("Discovery must never check a box");
      },
    },
    entryUrl: `${origin}/signin`,
    goal: "sign-in",
    allowedOrigins: [origin],
  });
  assert.ok(
    uncertain.some((line) => /was not on the page the second time/.test(line)),
    `an unexplored branch must be reported; got ${JSON.stringify(uncertain)}`,
  );
});

test("a consent screen is a decision an agent can take, not an interruption", async () => {
  // Approve-or-refuse is a choice the agent is authorised to make. Reading it
  // as a human step would interrupt somebody for nothing, which is the defect
  // this project exists to avoid.
  const origin = "https://provider.test";
  const { plan } = await discoverCeremony({
    page: scriptedPage(
      {
        [`${origin}/consent`]: {
          snapshot: page(
            `${origin}/consent`,
            [
              { index: 0, kind: "button", text: "Allow" },
              { index: 1, kind: "button", text: "Deny" },
            ],
            { headings: ["Authorize access"] },
          ),
        },
      },
      `${origin}/consent`,
    ),
    entryUrl: `${origin}/consent`,
    goal: "authorize",
    allowedOrigins: [origin],
  });
  assert.deepEqual(
    plan.steps.map((step) => step.kind),
    ["decision"],
  );
  assert.equal(plan.steps[0]?.humanReason, undefined);
  assert.equal(preferredPath(plan).handoffs, 0);
  assert.deepEqual(plan.data, {});
});

test("a page that demands a person is a human step with a stated reason", async (t) => {
  const double = await provider(t, {
    challengeAt: "sign-in",
    challengeClearable: true,
  });
  const { plan } = await discover(double, "/signin");
  const human = plan.steps.filter((step) => step.kind === "human");
  assert.equal(human.length, 1, "the challenge is the one human step");
  assert.equal(human[0]?.humanReason, "challenge");
  // And the path says what it costs, which is what a caller chooses on.
  assert.ok(preferredPath(plan).handoffs >= 1);
});

test("a passkey prompt with nothing to type is a human step, a hint is not", async (t) => {
  const only = await provider(t, { passkeyOnly: true });
  const prompt = await discover(only, "/signin");
  assert.deepEqual(
    prompt.plan.steps
      .filter((step) => step.kind === "human")
      .map((step) => step.humanReason),
    ["passkey"],
  );

  // Conditional UI still accepts a password, so nobody has to be interrupted.
  const hinted = await provider(t, { conditionalPasskey: true });
  const conditional = await discover(hinted, "/signin");
  assert.deepEqual(
    conditional.plan.steps.filter((step) => step.kind === "human"),
    [],
  );
  assert.equal(preferredPath(conditional.plan).handoffs, 0);
});

test("a sign-in offering registration is discovered as two ways through", async (t) => {
  const double = await provider(t, { verification: "none" });
  const { plan } = await discover(double, "/signin");
  // The fork is the point: the same goal, reached more than one way.
  assert.ok(
    plan.paths.length >= 2,
    `expected a fork, got paths: ${plan.paths.map((p) => p.id).join(", ")}`,
  );
  // Every path is runnable in the order it is written, and the entry page is
  // on all of them — both enforced by the schema, which the plan passed.
  for (const path of plan.paths) assert.ok(path.steps.length >= 1);
  const entry = plan.paths[0]!.steps[0];
  assert.ok(plan.paths.every((path) => path.steps[0] === entry));
});

test("a provider that redirects says so, and discovery records why", async (t) => {
  // `/authorize` sends an unauthenticated visitor to sign in first. That is a
  // prerequisite the provider states for free, and it is observable without
  // submitting anything.
  const double = await provider(t);
  const { plan, uncertain, visited } = await discover(
    double,
    "/authorize",
    "authorize",
  );
  assert.ok(
    visited.some((path) => path.endsWith("/signin")),
    `discovery should have landed on sign-in; visited ${visited.join(", ")}`,
  );
  assert.ok(
    uncertain.some((line) => /redirected to/.test(line)),
    `the redirect should be recorded; got ${JSON.stringify(uncertain)}`,
  );
  assert.equal(plan.goal, "authorize");
});

test("a discovered plan is shareable and comes back identical", async (t) => {
  const double = await provider(t);
  const { plan } = await discover(double, "/signin");
  const text = canonicalCeremonyPlan(plan);
  const reloaded = parseCeremonyPlan(text);
  assert.equal(canonicalCeremonyPlan(reloaded), text);
  assert.equal(
    await digestCeremonyPlan(reloaded),
    await digestCeremonyPlan(plan),
  );
  // A plan carries shape and order, never a value. The schema is strict, so
  // there is no field a value could live in; what is worth checking is that
  // nothing was smuggled into the free text that comes off the provider's own
  // pages.
  const freeText = [
    plan.title,
    ...plan.steps.map((step) => step.label),
    ...plan.paths.flatMap((path) => [path.label, ...path.when]),
  ].join(" ");
  for (const forbidden of ["@", "password=", "token", "cookie", "Bearer"])
    assert.ok(
      !freeText.includes(forbidden),
      `free text must not carry "${forbidden}": ${freeText}`,
    );
  // And every datum is exactly the four fields the schema allows, so a value
  // has nowhere to hide even if discovery tried.
  for (const datum of Object.values(plan.data))
    assert.deepEqual(Object.keys(datum).sort(), [
      "always",
      "role",
      "secret",
      "source",
    ]);
});

test("discovery stops at the origins it was allowed to read", async (t) => {
  const double = await provider(t);
  const result = await discoverCeremony({
    page: createHttpCeremonyPage(),
    entryUrl: `${double.origin}/signin`,
    goal: "sign-in",
    // Deliberately empty: nothing is permitted, including the entry page.
    allowedOrigins: ["https://elsewhere.invalid"],
  }).catch((error: Error) => error);
  assert.ok(result instanceof Error, "reading nothing must not yield a plan");
  assert.match(result.message, /no page it was permitted to read/);
});

test("a classifier may refine a page's kind but never invents its data", async (t) => {
  const double = await provider(t);
  const seen: string[] = [];
  const classifier: CeremonyClassifier = async ({ snapshot }) => {
    seen.push(snapshot.path);
    return { kind: "decision", label: "Named by inference" };
  };
  const { plan } = await discoverCeremony({
    page: createHttpCeremonyPage(),
    entryUrl: `${double.origin}/signin`,
    goal: "sign-in",
    allowedOrigins: [double.origin],
    classifier,
  });
  assert.ok(seen.length > 0, "the classifier was consulted");
  assert.ok(plan.steps.some((step) => step.label === "Named by inference"));
  // The roles still come from the page, not from the model.
  const roles = Object.values(plan.data).map((datum) => datum.role);
  assert.ok(roles.includes("password"));
});

test("a classifier that fails or refuses leaves discovery working", async (t) => {
  // Inference is optional. A plan that only exists when a model answers is not
  // a plan anyone can rely on.
  const double = await provider(t);
  const { plan } = await discoverCeremony({
    page: createHttpCeremonyPage(),
    entryUrl: `${double.origin}/signin`,
    goal: "sign-in",
    allowedOrigins: [double.origin],
    classifier: async () => {
      throw new Error("model unavailable");
    },
  });
  const roles = Object.values(plan.data).map((datum) => datum.role);
  assert.ok(roles.includes("password"));
  assert.ok(plan.steps.length >= 1);
});

test("role inference survives page shapes it has never seen", async (t) => {
  // The provider regenerates field names, labels, wording and control order per
  // instance. A reader that passes on one shape and fails on the next has
  // memorised a page rather than understood it — which is exactly how the
  // confirmation-box rule was found to be wrong.
  const wrong: string[] = [];
  for (let seed = 1; seed <= 25; seed++) {
    const double = await startAuthProvider({ seed, verification: "code" });
    t.after(() => double.close());
    const { plan } = await discoverCeremony({
      page: createHttpCeremonyPage(),
      entryUrl: `${double.origin}${double.signupPath}`,
      goal: "registration",
      allowedOrigins: [double.origin],
    });
    const roles = new Set(Object.values(plan.data).map((datum) => datum.role));
    const missing = (["password", "password-confirm", "email"] as const).filter(
      (role) => !roles.has(role),
    );
    if (missing.length > 0)
      wrong.push(`seed ${seed} missed ${missing.join(", ")}`);
  }
  assert.deepEqual(wrong, []);
});

test("field roles are read from the control, not from its position", async (t) => {
  const page = [
    { index: 0, kind: "input", type: "text", label: "Username" },
    { index: 1, kind: "input", type: "password", label: "Password" },
    { index: 2, kind: "input", type: "password", label: "Confirm password" },
    { index: 3, kind: "input", type: "email", label: "Work address" },
    { index: 4, kind: "input", type: "text", label: "Confirmation code" },
    { index: 5, kind: "input", type: "text", label: "Authenticator code" },
    { index: 6, kind: "input", type: "date", label: "Date of birth" },
    { index: 7, kind: "button", text: "Continue" },
    { index: 8, kind: "link", text: "Create an account" },
  ] as const;
  const roles = page.map((element) =>
    inferRole(element as never, page as never),
  );
  assert.deepEqual(roles, [
    "username",
    "password",
    "password-confirm",
    "email",
    "verification-code",
    "totp-code",
    "birth-date",
    undefined,
    undefined,
  ]);
  void t;
});
