import { test } from "node:test";
import assert from "node:assert/strict";
import {
  canonicalCeremonyPlan,
  ceremonyPlanSchema,
  digestCeremonyPlan,
  parseCeremonyPlan,
  planStepSchema,
  PLAN_LIMITS,
  preferredPath,
  requiredOf,
  type CeremonyPlan,
} from "../src/core/ceremony-plan.js";

/**
 * The plan format exists so a ceremony can be written down, shared and run
 * again. Most of what is worth testing is what it refuses: a plan that passes
 * validation is one a caller can act on without discovering halfway through
 * that it names a step nothing reaches or a value nothing produces.
 */

/**
 * Registration with the two confirmations a real provider offers, and the
 * challenge variant. Three ways to the same goal, and they do not cost the
 * same — which is the whole reason paths exist.
 */
function registrationPlan(): CeremonyPlan {
  return {
    schemaVersion: 1,
    id: "registration",
    title: "Create an account",
    goal: "registration",
    origin: "https://provider.example",
    data: {
      email: {
        role: "email",
        secret: false,
        source: { from: "caller" },
        always: true,
      },
      password: {
        role: "password",
        secret: true,
        source: { from: "caller" },
        always: true,
      },
      code: {
        role: "verification-code",
        secret: true,
        source: { from: "step", step: "read-code" },
        always: false,
      },
    },
    steps: [
      {
        id: "challenge",
        kind: "human",
        label: "Clear the security check",
        humanReason: "challenge",
        needs: [],
        uses: [],
        produces: [],
      },
      {
        id: "register",
        kind: "form",
        label: "Submit the registration form",
        needs: [],
        uses: ["email", "password"],
        produces: [],
      },
      {
        id: "read-code",
        kind: "out-of-band",
        label: "Read the confirmation code from the mailbox",
        needs: ["register"],
        uses: [],
        produces: ["code"],
      },
      {
        id: "confirm",
        kind: "form",
        label: "Enter the confirmation code",
        needs: ["read-code"],
        uses: ["code"],
        produces: [],
      },
      {
        id: "follow-link",
        kind: "navigate",
        label: "Follow the confirmation link",
        needs: ["register"],
        uses: [],
        produces: [],
      },
    ],
    paths: [
      {
        id: "by-code",
        label: "Confirm with an emailed code",
        steps: ["register", "read-code", "confirm"],
        handoffs: 0,
        when: ["the provider sends a code"],
      },
      {
        id: "by-link",
        label: "Confirm by following the emailed link",
        steps: ["register", "follow-link"],
        handoffs: 0,
        when: ["the provider sends a link"],
      },
      {
        id: "by-code-after-challenge",
        label: "Clear a security check first, then confirm with a code",
        steps: ["challenge", "register", "read-code", "confirm"],
        handoffs: 1,
        when: ["the provider shows a challenge"],
      },
    ],
  };
}

/** A sign-in behind a browser dialog: the one datum only a person can supply. */
function dialogPlan(): CeremonyPlan {
  return {
    schemaVersion: 1,
    id: "basic-dialog",
    title: "Answer the browser's credential dialog",
    goal: "sign-in",
    origin: "https://resource.example",
    data: {
      dialogPassword: {
        role: "password",
        secret: true,
        source: { from: "human" },
        always: true,
      },
    },
    steps: [
      {
        id: "dialog",
        kind: "human",
        label: "A person answers the dialog in their own browser",
        humanReason: "native-dialog",
        needs: [],
        uses: ["dialogPassword"],
        produces: [],
      },
    ],
    paths: [
      {
        id: "only",
        label: "There is no other way in",
        steps: ["dialog"],
        handoffs: 1,
        when: [],
      },
    ],
  };
}

/** Apply one change and assert the plan stops validating because of it. */
function rejects(
  name: string,
  change: (plan: CeremonyPlan) => void,
  expected: RegExp,
): void {
  const plan = registrationPlan();
  change(plan);
  const result = ceremonyPlanSchema.safeParse(plan);
  assert.equal(result.success, false, `${name} should not validate`);
  const messages = (result.error?.issues ?? [])
    .map((issue) => issue.message)
    .join("; ");
  assert.match(messages, expected, `${name}: ${messages}`);
}

test("a plan describing a real fork validates", () => {
  assert.equal(ceremonyPlanSchema.safeParse(registrationPlan()).success, true);
  assert.equal(ceremonyPlanSchema.safeParse(dialogPlan()).success, true);
});

test("a plan may not name a step, datum or producer it does not have", () => {
  rejects(
    "an unknown prerequisite",
    (plan) => {
      plan.steps[3]!.needs = ["never-declared"];
    },
    /Unknown prerequisite never-declared/,
  );
  rejects(
    "an unknown datum",
    (plan) => {
      plan.steps[1]!.uses = ["nickname"];
    },
    /Unknown datum nickname/,
  );
  rejects(
    "a path naming a step that is not in the plan",
    (plan) => {
      plan.paths[0]!.steps = ["register", "imagined"];
    },
    /names unknown step imagined/,
  );
  rejects(
    "an output whose producer does not claim it",
    (plan) => {
      plan.steps[2]!.produces = [];
    },
    /claims a producer that does not produce it/,
  );
  rejects(
    "a datum produced by a step the plan does not have",
    (plan) => {
      plan.data["code"]!.source = { from: "step", step: "imagined" };
    },
    /names a step that is not in the plan/,
  );
  rejects(
    "a duplicate step",
    (plan) => {
      plan.steps.push({ ...plan.steps[1]! });
    },
    /Duplicate step/,
  );
});

test("a step may not consume what it is itself producing", () => {
  // Otherwise a caller cannot tell whether to bring the value or wait for it.
  rejects(
    "a step both using and producing a datum",
    (plan) => {
      plan.steps[2]!.uses = ["code"];
    },
    /code is both used and produced/,
  );
});

test("a path has to be runnable in the order it is written", () => {
  rejects(
    "a step running before its prerequisite",
    (plan) => {
      plan.paths[0]!.steps = ["read-code", "register", "confirm"];
    },
    /runs read-code before register/,
  );
});

test("a path's handoff count has to match the people it actually interrupts", () => {
  // This number is what a caller chooses between paths on, so a plan that
  // understates it is worse than one that omits it.
  rejects(
    "an understated handoff count",
    (plan) => {
      plan.paths[2]!.handoffs = 0;
    },
    /claims 0 handoffs but has 1/,
  );
  rejects(
    "an overstated handoff count",
    (plan) => {
      plan.paths[0]!.handoffs = 2;
    },
    /claims 2 handoffs but has 0/,
  );
});

test("a plan may not carry steps or data no path reaches", () => {
  // A plan that lists more than it does reads as capable of more than it is.
  rejects(
    "a step no path uses",
    (plan) => {
      plan.steps.push({
        id: "orphan",
        kind: "navigate",
        label: "Nothing reaches this",
        needs: [],
        uses: [],
        produces: [],
      });
    },
    /No path uses orphan/,
  );
  rejects(
    "a datum no step uses",
    (plan) => {
      plan.data["spare"] = {
        role: "display-name",
        secret: false,
        source: { from: "caller" },
        always: true,
      };
    },
    /No path uses spare/,
  );
});

test("`always` has to mean used by every path", () => {
  rejects(
    "a datum claiming to be always needed when only some paths ask",
    (plan) => {
      plan.data["code"]!.always = true;
    },
    /marked always=true but is used by 2 of 3/,
  );
  rejects(
    "a datum understating that every path needs it",
    (plan) => {
      plan.data["email"]!.always = false;
    },
    /marked always=false but is used by 3 of 3/,
  );
});

test("a human step states its reason, and only a human step has one", () => {
  const base = {
    id: "step",
    label: "A step",
    needs: [],
    uses: [],
    produces: [],
  };
  assert.equal(
    planStepSchema.safeParse({ ...base, kind: "human" }).success,
    false,
    "a human step without a reason leaves the interruption unexplained",
  );
  assert.equal(
    planStepSchema.safeParse({
      ...base,
      kind: "form",
      humanReason: "challenge",
    }).success,
    false,
    "a reason on a step nobody is asked about is a contradiction",
  );
  assert.equal(
    planStepSchema.safeParse({
      ...base,
      kind: "human",
      humanReason: "passkey",
    }).success,
    true,
  );
});

test("a plan carries no values, and the schema will not accept extras", () => {
  const plan = registrationPlan() as unknown as Record<string, unknown>;
  plan["capturedPassword"] = "hunter2";
  assert.equal(ceremonyPlanSchema.safeParse(plan).success, false);
});

test("the preferred path is the one that interrupts a person least", () => {
  const plan = registrationPlan();
  // Two paths cost nobody anything; between those the shorter one wins, and
  // the path needing a person is never preferred while an alternative exists.
  assert.equal(preferredPath(plan).id, "by-link");
  const onlyHuman = {
    ...plan,
    paths: plan.paths.filter((path) => path.handoffs > 0),
  };
  assert.equal(preferredPath(onlyHuman).id, "by-code-after-challenge");
  // A tie on both handoffs and length still resolves the same way every time.
  const tied = {
    ...plan,
    paths: [
      { ...plan.paths[1]!, id: "zulu" },
      { ...plan.paths[1]!, id: "alpha" },
    ],
  };
  assert.equal(preferredPath(tied).id, "alpha");
});

test("what the caller must bring excludes what the ceremony produces", () => {
  const plan = registrationPlan();
  const byCode = plan.paths.find((path) => path.id === "by-code")!;
  assert.deepEqual(
    requiredOf(plan, byCode).map((datum) => datum.key),
    ["email", "password"],
    "the confirmation code is read during the run, not supplied before it",
  );
  assert.deepEqual(
    requiredOf(plan, byCode).map((datum) => datum.secret),
    [false, true],
  );
  // A person answering a browser dialog is not the caller holding a value.
  const dialog = dialogPlan();
  assert.deepEqual(requiredOf(dialog, dialog.paths[0]!), []);
  // A step a path does not run is not asked for.
  const byLink = plan.paths.find((path) => path.id === "by-link")!;
  assert.deepEqual(
    requiredOf(plan, byLink).map((datum) => datum.key),
    ["email", "password"],
  );
});

test("a datum a path asks for twice is only asked for once", () => {
  const plan = registrationPlan();
  plan.steps[4]!.uses = ["email"];
  const byLink = plan.paths.find((path) => path.id === "by-link")!;
  assert.deepEqual(
    requiredOf(plan, byLink).map((datum) => datum.key),
    ["email", "password"],
  );
});

test("two plans that differ only in key order are the same plan", async () => {
  const plan = registrationPlan();
  const reordered = JSON.parse(JSON.stringify(plan)) as Record<string, unknown>;
  const shuffled = Object.fromEntries(
    Object.entries(reordered).sort(([a], [b]) => (a < b ? 1 : -1)),
  );
  assert.equal(canonicalCeremonyPlan(plan), canonicalCeremonyPlan(shuffled));
  assert.equal(
    await digestCeremonyPlan(plan),
    await digestCeremonyPlan(shuffled),
  );
  // And a plan that differs in substance is a different plan.
  const changed = registrationPlan();
  changed.title = "Create an account, eventually";
  assert.notEqual(
    await digestCeremonyPlan(plan),
    await digestCeremonyPlan(changed),
  );
});

test("a canonical plan sorts nested keys too", () => {
  // Arrays keep their order, because a path's order is its meaning.
  const canonical = canonicalCeremonyPlan(registrationPlan());
  assert.match(canonical, /"always":true,"role":"email"/);
  assert.match(canonical, /"by-code".+"by-link".+"by-code-after-challenge"/s);
});

test("a plan is imported from text, within a stated limit", () => {
  const plan = registrationPlan();
  assert.deepEqual(parseCeremonyPlan(JSON.stringify(plan)), plan);
  assert.throws(
    () =>
      parseCeremonyPlan(JSON.stringify(plan) + " ".repeat(PLAN_LIMITS.bytes)),
    /exceeds import limit/,
  );
  assert.throws(() => parseCeremonyPlan("{}"));
});

test("a plan has to offer at least one step and one way through", () => {
  const plan = registrationPlan();
  assert.equal(
    ceremonyPlanSchema.safeParse({ ...plan, paths: [] }).success,
    false,
  );
  assert.equal(
    ceremonyPlanSchema.safeParse({ ...plan, steps: [] }).success,
    false,
  );
});
