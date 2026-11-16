/**
 * Regressions from an independent review of the kernel. Each test is one of
 * its confirmed findings, stated as the behaviour that now holds.
 */
import assert from "node:assert/strict";
import test from "node:test";
import fc from "fast-check";
import {
  absorb,
  advance,
  check,
  decide,
  defineCeremony,
  established,
  fact,
  invalidates,
  JournalMismatch,
  memoryJournal,
  memoryVault,
  of,
  operator,
  replay,
  retry,
  unsure,
  validate,
  type Ceremony,
  type CeremonyDecl,
  type Controller,
  type JournalEntry,
  type Vault,
} from "../../src/kernel/index.js";
import {
  githubAppAccess,
  githubUserAccess,
} from "../../src/kernel/flows/github-app.js";
import { catalog } from "../../src/kernel/flows/catalog.js";
import {
  exact,
  interval,
  type Interval,
} from "../../src/kernel/interface/algebras.js";
import { prove } from "../../src/kernel/interface/prove.js";
import {
  measure,
  proveSheet,
  sheetLayout,
  wrappedLines,
} from "../../src/kernel/interface/sheet.js";
import { run, Tape } from "../../src/kernel/interface/tape.js";
import { options } from "./support.js";

const errors = (decl: CeremonyDecl): string[] =>
  validate(decl)
    .issues.filter((issue) => issue.severity === "error")
    .map((issue) => issue.rule);

test("an invalidation that names several facts is refused when something resting on them cannot be probed", () => {
  const decl = {
    id: "files",
    title: "files",
    facts: {
      session: fact({ description: "", observable: true, volatile: true }),
      account: fact({ description: "", observable: true, volatile: true }),
      key: fact({ description: "", requires: ["account"] }),
      file: fact({ description: "", observable: true }),
    },
    operators: {
      signIn: operator({
        description: "",
        establishes: ["session"],
        actor: "machine",
        idempotent: true,
        outcomes: { ok: established("") },
      }),
      open: operator({
        description: "",
        establishes: ["account"],
        actor: "machine",
        idempotent: true,
        outcomes: { ok: established("") },
      }),
      issueKey: operator({
        description: "",
        establishes: ["key"],
        requires: ["account"],
        actor: "machine",
        idempotent: false,
        outcomes: {
          ok: established(""),
          gone: invalidates(["account"], ""),
        },
      }),
      upload: operator({
        description: "",
        establishes: ["file"],
        requires: ["session", "account", "key"],
        actor: "machine",
        idempotent: true,
        outcomes: {
          ok: established(""),
          unauthorized: invalidates(["session", "account"], ""),
          keyGone: invalidates(["key"], ""),
        },
      }),
    },
    goal: ["file"],
  } as unknown as CeremonyDecl;
  assert.ok(errors(decl).includes("ambiguous-invalidation"));
});

test("the stale budget must exceed the number of facts, and a long chain recovers from losing its root", () => {
  const {
    compiled: _c,
    warnings: _w,
    ...github
  } = githubAppAccess as unknown as Ceremony;
  assert.ok(errors({ ...github, staleReports: 1 }).includes("bounds"));

  const chain = (observable: boolean): CeremonyDecl => {
    const facts: Record<string, unknown> = {};
    const operators: Record<string, unknown> = {};
    for (let i = 0; i < 9; i += 1) {
      facts[`f${i}`] = fact({
        description: "",
        requires: i === 0 ? [] : [`f${i - 1}`],
        volatile: i === 0,
        observable,
      });
      operators[`make${i}`] = operator({
        description: "",
        establishes: [`f${i}`],
        requires: i === 0 ? [] : [`f${i - 1}`],
        actor: "machine",
        idempotent: true,
        outcomes:
          i === 0
            ? { ok: established("") }
            : { ok: established(""), lost: invalidates([`f${i - 1}`], "") },
      });
    }
    return {
      id: "chain",
      title: "chain",
      facts,
      operators,
      goal: ["f8"],
    } as unknown as CeremonyDecl;
  };
  // The chain the review used, with nothing observable, is no longer accepted.
  assert.ok(errors(chain(false)).includes("goal-observable"));
  // With probes it is, and losing the root costs no more than the budget.
  assert.deepEqual(errors(chain(true)), []);
  const result = check(
    defineCeremony(chain(true) as never) as unknown as Ceremony,
    { invalidations: 1, faultDepth: 2 },
  );
  assert.equal(result.complete, true);
  assert.deepEqual(
    result.violations.map((violation) => violation.property),
    [],
  );
});

const orders = defineCeremony({
  id: "orders",
  title: "orders",
  facts: {
    order: fact({
      description: "An order is placed.",
      value: of<string>(),
      observable: true,
      discoverable: true,
    }),
  },
  operators: {
    place: operator({
      description: "Place the order.",
      establishes: ["order"],
      actor: "machine",
      idempotent: false,
      outcomes: {
        placed: established("Placed."),
        timedOut: unsure("No reply."),
        busy: retry("Try again."),
      },
    }),
  },
  goal: ["order"],
});

test("a controller that takes a lost reply for a failure lands a non-idempotent effect twice, and the checker says so", () => {
  const forgetful: Controller = {
    decide,
    absorb: (compiled, mind, observation) => {
      const next = absorb(compiled, mind, observation);
      if (observation.kind !== "act") return next;
      const outcome =
        compiled.operators[observation.op]?.outcomes[observation.outcome];
      const established = compiled.operators[observation.op]?.establishes ?? 0;
      return outcome === undefined || outcome.kind === "unsure"
        ? { ...next, absent: next.absent | established }
        : next;
    },
  };
  const result = check(orders as unknown as Ceremony, {
    controller: forgetful,
    attempts: 3,
  });
  assert.ok(
    result.violations.some(
      (violation) => violation.property === "no-duplicate-effect",
    ),
  );
  assert.deepEqual(
    check(orders as unknown as Ceremony, { attempts: 3 }).violations,
    [],
  );
});

test("a controller that keeps believing what rested on a fact it saw gone breaks belief-sound", () => {
  const stubborn: Controller = {
    decide,
    absorb: (compiled, mind, observation) => {
      const next = absorb(compiled, mind, observation);
      return observation.kind === "probe" && observation.result === "absent"
        ? {
            ...next,
            held: next.held | (mind.held & ~(1 << observation.fact)),
            absent: next.absent & ~(mind.held & ~(1 << observation.fact)),
          }
        : next;
    },
  };
  // A consent code held from an earlier run rests on the app. When the app
  // is found gone, believing in the code has no excuse left.
  const result = check(githubUserAccess as unknown as Ceremony, {
    controller: stubborn,
    invalidations: 1,
    faultDepth: 2,
  });
  assert.ok(
    result.violations.some(
      (violation) => violation.property === "belief-sound",
    ),
    result.violations.map((violation) => violation.property).join(", "),
  );
});

function deps(
  journal: JournalEntry[],
  vault: Vault,
  operators: Record<string, (context: never) => Promise<unknown>>,
  probes: Record<string, (context: never) => Promise<unknown>>,
  runId = "run",
) {
  return {
    runId,
    adapters: { probes, operators } as never,
    journal: memoryJournal(journal),
    vault,
  };
}

test("values staged by one run are not taken by another, nor promoted for a different outcome", async () => {
  const values = new Map<string, unknown>();
  const vault = memoryVault(values);
  const probes = new Proxy({}, { get: () => async () => ({ held: false }) });

  // Another run died after staging an answer at the same journal position.
  values.set("#staged:run-1:chooseTarget:11", {
    outcome: "chosen",
    values: { target: { login: "from-run-1", kind: "User" } },
  });
  const journal: JournalEntry[] = [];
  const second = deps(journal, vault, {}, probes, "run-2");
  const first = await advance(githubAppAccess, second);
  assert.equal(first.status, "awaiting");
  assert.deepEqual(await advance(githubAppAccess, second), first);
  assert.equal(values.get("target"), undefined);

  // Two answers raced: one staged "chosen", the other committed "declined"
  // and died before tidying up. The stage is for another outcome: dropped.
  assert.ok(first.status === "awaiting");
  const opened = Number(first.request.requestId.split(":").pop());
  values.set(`#staged:run-2:chooseTarget:${opened}`, {
    outcome: "chosen",
    values: { target: { login: "other-tab", kind: "User" } },
  });
  journal.push({
    seq: journal.length,
    kind: "end",
    result: { kind: "act", operator: "chooseTarget", outcome: "declined" },
  });
  const ended = await advance(githubAppAccess, second);
  assert.equal(ended.status, "failed");
  assert.equal(values.get("target"), undefined);
  assert.equal(values.get(`#staged:run-2:chooseTarget:${opened}`), undefined);
});

test("a person can only choose what the interface offers", async () => {
  const journal: JournalEntry[] = [];
  const probes = new Proxy({}, { get: () => async () => ({ held: false }) });
  const d = deps(journal, memoryVault(), {}, probes);
  const open = await advance(githubAppAccess, d);
  assert.ok(open.status === "awaiting");
  const length = journal.length;
  const ignored = await advance(githubAppAccess, d, {
    requestId: open.request.requestId,
    action: "abandoned",
  });
  assert.deepEqual(ignored, open);
  assert.equal(journal.length, length);

  const stopped = await advance(githubAppAccess, d, {
    requestId: open.request.requestId,
    action: "cancel",
  });
  assert.equal(stopped.status, "failed");
});

test("a probe that says held and gives no value is a failed probe, and the run ends", async () => {
  const journal: JournalEntry[] = [];
  const status = await advance(
    orders,
    deps(
      journal,
      memoryVault(),
      { place: async () => ({ outcome: "placed", values: { order: "o-1" } }) },
      { order: async () => ({ held: true, value: undefined }) },
    ),
  );
  assert.equal(status.status, "failed");
  assert.ok(status.status === "failed");
  assert.equal(status.failure.kind, "unobservable");
  assert.ok(journal.length < 40);
});

test("a vault that drops a value ends the run instead of placing the order for ever", async () => {
  const kept = new Map<string, unknown>();
  const leaky: Vault = {
    get: async (name) => kept.get(name),
    put: async (name, value) => {
      if (name !== "order") kept.set(name, value);
    },
    delete: async (name) => {
      kept.delete(name);
    },
  };
  let placed = 0;
  const status = await advance(
    orders,
    deps(
      [],
      leaky,
      {
        place: async () => {
          placed += 1;
          return { outcome: "placed", values: { order: `o-${placed}` } };
        },
      },
      {
        order: async () =>
          placed > 0 ? { held: true, value: `o-${placed}` } : { held: false },
      },
    ),
  );
  assert.equal(status.status, "failed");
  assert.ok(status.status === "failed");
  assert.equal(status.failure.kind, "unstable");
  assert.ok(placed <= orders.compiled.staleReports, `placed ${placed} times`);
});

test("the idempotency key is kept across a lost reply and changes once a probe settles it", async () => {
  const keys: string[] = [];
  let calls = 0;
  const status = await advance(
    orders,
    deps(
      [],
      memoryVault(),
      {
        place: async (context: never) => {
          keys.push((context as { idempotencyKey: string }).idempotencyKey);
          calls += 1;
          if (calls === 1) throw new Error("connection reset");
          return { outcome: "placed", values: { order: "o-2" } };
        },
      },
      { order: async () => ({ held: false }) },
    ),
  );
  assert.equal(status.status, "success");
  assert.equal(keys.length, 2);
  assert.notEqual(keys[0], keys[1]);
});

test("a journal written for another declaration is refused", () => {
  assert.throws(
    () =>
      replay(orders.compiled, [
        {
          seq: 0,
          kind: "end",
          result: { kind: "probe", fact: "token", result: "held" },
        },
      ]),
    JournalMismatch,
  );
});

test("a range that is not finite is refused, and a quantity that overflows is not proved", () => {
  const tape = new Tape();
  const x = tape.input("x");
  const y = tape.input("y");
  const quantity = tape.affine(tape.mul(tape.mul(x, x), y), -1, -1);
  assert.throws(() => prove(tape, quantity, { x: [0, Infinity], y: [0, 1] }));
  assert.throws(() => prove(tape, quantity, { x: [NaN, NaN], y: [0, 1] }));
  assert.throws(() => prove(tape, quantity, { x: [2, 1], y: [0, 1] }));
  assert.notEqual(
    prove(tape, quantity, { x: [0, 1e200], y: [0, 1] }).status,
    "proved",
  );
});

const real = fc.double({ min: -100, max: 100, noNaN: true });

test("a maximum, a minimum and a blend are bounded for the numbers the renderer really computes", () => {
  fc.assert(
    fc.property(real, real, real, real, real, (a, b, c, scale, bias) => {
      const tape = new Tape();
      const x = tape.input("x");
      const y = tape.input("y");
      const z = tape.input("z");
      const outs = [
        tape.affine(tape.max(x, y), scale, bias),
        tape.affine(tape.min(x, y), scale, bias),
        tape.mul(tape.blend(tape.step(z), x, y), tape.max(y, z)),
      ];
      const at = { x: a, y: b, z: c };
      const values = run(tape, exact, at);
      const bounds = run(tape, interval, {
        x: { lo: a, hi: a },
        y: { lo: b, hi: b },
        z: { lo: c, hi: c },
      });
      for (const out of outs) {
        const bound = bounds[out] as Interval;
        const value = values[out] as number;
        assert.ok(bound.lo <= value && value <= bound.hi);
      }
    }),
    { ...options, numRuns: options.numRuns * 10 },
  );
  const tape = new Tape();
  const x = tape.input("x");
  const y = tape.input("y");
  const larger = tape.max(x, y);
  assert.equal(run(tape, exact, { x: 0.1, y: -100 })[larger], 0.1);
});

test("a field's label wraps like any other text, so a long label on a narrow phone is given its lines", () => {
  const spec = catalog.passwordSignIn.operators.enterPassword.interface;
  assert.ok(spec);
  const layout = sheetLayout(spec);
  assert.equal(proveSheet(layout).status, "proved");
  const narrow = measure(layout, { width: 320, scale: 2 });
  const wide = measure(layout, { width: 1280, scale: 1 });
  const lineHeight = 1.5 * 16 * 2;
  assert.ok(
    (narrow.boxes["field:identifier"]?.height ?? 0) >= 2 * lineHeight + 88,
  );
  assert.ok((wide.boxes["field:identifier"]?.height ?? 0) < 24 * 2 + 44 + 8);
});

test("text breaks after a hyphen or a slash before it breaks mid-word", () => {
  assert.equal(wrappedLines("aaaa-bbbbbbbbbbbb", 10), 3);
  assert.equal(wrappedLines("aaaa-bbbb", 10), 1);
  assert.equal(wrappedLines("github.com/login/device", 12), 2);
  assert.equal(wrappedLines("one two", 3), 2);
});
