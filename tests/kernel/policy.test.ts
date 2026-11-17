/**
 * The controller's two functions, one decision at a time: what it does next
 * for a given knowledge, and what it knows after a given observation.
 */
import assert from "node:assert/strict";
import test from "node:test";
import {
  absorb,
  blocked,
  decide,
  DEFECT,
  established,
  fact,
  freshMind,
  invalidates,
  mindKey,
  operator,
  retry,
  terminal,
  unsure,
  type Ceremony,
  type CeremonyDecl,
  type Compiled,
  type Mind,
  type Observation,
} from "../../src/kernel/index.js";
import { plan } from "../../src/kernel/plan.js";
import { unchecked } from "./support.js";

const decl = (
  facts: CeremonyDecl["facts"],
  operators: CeremonyDecl["operators"],
  goal: readonly string[],
  extra: Partial<CeremonyDecl> = {},
): Compiled =>
  unchecked({
    id: "case",
    title: "case",
    facts,
    operators,
    goal,
    ...extra,
  } as CeremonyDecl).compiled;

const fold = (
  compiled: Compiled,
  observations: readonly Observation[],
  from: Mind = freshMind(compiled),
): Mind =>
  observations.reduce((mind, seen) => absorb(compiled, mind, seen), from);

const bit = (compiled: Compiled, name: string): number =>
  1 << (compiled.factIndex.get(name) as number);
const op = (compiled: Compiled, id: string): number =>
  compiled.operatorIndex.get(id) as number;
const outcome = (compiled: Compiled, id: string, tag: string): number =>
  compiled.operators[op(compiled, id)]?.outcomeIndex.get(tag) as number;

/** Two ways to the goal: a cheap one that can be refused and a dear one that can be busy. */
const twoWays = decl(
  { done: fact({ description: "", observable: true }) },
  {
    cheap: operator({
      description: "",
      establishes: ["done"],
      actor: "machine",
      idempotent: true,
      cost: 1,
      outcomes: {
        ok: established(""),
        busy: retry(""),
        closed: blocked(""),
      },
    }),
    dear: operator({
      description: "",
      establishes: ["done"],
      actor: "machine",
      idempotent: true,
      cost: 5,
      attempts: 2,
      outcomes: {
        ok: established(""),
        busy: retry(""),
        refused: blocked(""),
      },
    }),
  },
  ["done"],
);

test("an unreachable goal names what is missing and why each operator was dropped", () => {
  const c = twoWays;
  const absent: Observation = {
    kind: "probe",
    fact: c.factIndex.get("done") as number,
    result: "absent",
  };
  const mind = fold(c, [
    absent,
    { kind: "act", op: op(c, "cheap"), outcome: outcome(c, "cheap", "closed") },
    { kind: "act", op: op(c, "dear"), outcome: outcome(c, "dear", "busy") },
    { kind: "act", op: op(c, "dear"), outcome: outcome(c, "dear", "busy") },
  ]);
  assert.deepEqual(decide(c, mind), {
    kind: "fail",
    failure: {
      kind: "unreachable",
      missing: ["done"],
      blocked: [
        // Blocked by an outcome at index 2: named by its tag, not as a give-up.
        { operator: "cheap", because: "closed" },
        { operator: "dear", because: "gave up after 2 attempts" },
      ],
    },
  });
});

test("only blocked operators are listed, and a first reason to block is kept", () => {
  const c = twoWays;
  const refused = fold(c, [
    { kind: "act", op: op(c, "dear"), outcome: outcome(c, "dear", "refused") },
  ]);
  assert.equal(decide(c, refused).kind, "probe");
  // Spending attempts on an operator already blocked does not rewrite why.
  const spent = fold(
    c,
    [
      { kind: "probe", fact: 0, result: "absent" },
      { kind: "act", op: op(c, "dear"), outcome: outcome(c, "dear", "busy") },
      { kind: "act", op: op(c, "dear"), outcome: outcome(c, "dear", "busy") },
      {
        kind: "act",
        op: op(c, "cheap"),
        outcome: outcome(c, "cheap", "closed"),
      },
    ],
    refused,
  );
  const command = decide(c, spent);
  assert.ok(command.kind === "fail" && command.failure.kind === "unreachable");
  assert.deepEqual(command.failure.blocked, [
    { operator: "cheap", because: "closed" },
    { operator: "dear", because: "refused" },
  ]);
});

test("absorbing an observation never changes the knowledge it started from", () => {
  const c = twoWays;
  const start = fold(c, [
    { kind: "act", op: op(c, "dear"), outcome: outcome(c, "dear", "busy") },
  ]);
  const copy = structuredClone(start);
  fold(
    c,
    [
      { kind: "act", op: op(c, "dear"), outcome: outcome(c, "dear", "busy") },
      {
        kind: "act",
        op: op(c, "cheap"),
        outcome: outcome(c, "cheap", "closed"),
      },
    ],
    start,
  );
  assert.deepEqual(start, copy);
});

test("an operator tried again is asked for its next attempt", () => {
  const c = twoWays;
  const known: Observation = {
    kind: "probe",
    fact: c.factIndex.get("done") as number,
    result: "absent",
  };
  assert.deepEqual(decide(c, fold(c, [known])), {
    kind: "act",
    op: op(c, "cheap"),
    attempt: 1,
  });
  assert.deepEqual(
    decide(
      c,
      fold(c, [
        known,
        {
          kind: "act",
          op: op(c, "cheap"),
          outcome: outcome(c, "cheap", "busy"),
        },
      ]),
    ),
    { kind: "act", op: op(c, "cheap"), attempt: 2 },
  );
});

test("of the facts that would settle the plan, the one that settles most is probed first", () => {
  // Both goals are unknown. Looking at `upper` also tells whether `base`
  // holds, so it is the better first look.
  const c = decl(
    {
      lone: fact({ description: "", observable: true }),
      base: fact({ description: "", observable: true }),
      upper: fact({ description: "", observable: true, requires: ["base"] }),
    },
    {
      makeLone: operator({
        description: "",
        establishes: ["lone"],
        actor: "machine",
        idempotent: true,
        outcomes: { ok: established("") },
      }),
      makeBase: operator({
        description: "",
        establishes: ["base"],
        actor: "machine",
        idempotent: true,
        outcomes: { ok: established("") },
      }),
      makeUpper: operator({
        description: "",
        establishes: ["upper"],
        requires: ["base"],
        actor: "machine",
        idempotent: true,
        outcomes: { ok: established("") },
      }),
    },
    ["lone", "upper"],
  );
  assert.deepEqual(decide(c, freshMind(c)), {
    kind: "probe",
    fact: c.factIndex.get("upper"),
  });
});

test("a stale belief in something no probe can see becomes absent; one a probe can see becomes unknown", () => {
  const c = decl(
    {
      seen: fact({ description: "", observable: true }),
      hidden: fact({ description: "" }),
      done: fact({ description: "", observable: true }),
    },
    {
      makeSeen: operator({
        description: "",
        establishes: ["seen"],
        actor: "machine",
        idempotent: true,
        outcomes: { ok: established("") },
      }),
      makeHidden: operator({
        description: "",
        establishes: ["hidden"],
        actor: "machine",
        idempotent: true,
        outcomes: { ok: established("") },
      }),
      finish: operator({
        description: "",
        establishes: ["done"],
        requires: ["seen", "hidden"],
        actor: "machine",
        idempotent: true,
        outcomes: {
          ok: established(""),
          stale: invalidates(["seen", "hidden"], ""),
        },
      }),
    },
    ["done"],
  );
  const seen = bit(c, "seen");
  const hidden = bit(c, "hidden");
  const done = bit(c, "done");
  const before: Mind = {
    ...freshMind(c),
    held: seen | hidden,
    absent: done,
  };
  const after = absorb(c, before, {
    kind: "act",
    op: op(c, "finish"),
    outcome: outcome(c, "finish", "stale"),
  });
  assert.equal(after.held & (seen | hidden), 0);
  // `hidden` cannot be looked at, so it is known gone; `seen` is to be looked at.
  assert.equal(after.absent & hidden, hidden);
  assert.equal(after.absent & seen, 0);
  // What was known absent and is not doubted stays absent.
  assert.equal(after.absent & done, done);
  assert.equal(after.staleReports, 1);
  assert.equal(after.terminal, null);
});

test("the stale budget ends the run naming the facts that kept going stale", () => {
  const c = decl(
    {
      key: fact({ description: "", observable: true }),
      file: fact({ description: "", observable: true, requires: ["key"] }),
    },
    {
      makeKey: operator({
        description: "",
        establishes: ["key"],
        actor: "machine",
        idempotent: true,
        outcomes: { ok: established("") },
      }),
      upload: operator({
        description: "",
        establishes: ["file"],
        requires: ["key"],
        actor: "machine",
        idempotent: true,
        outcomes: { ok: established(""), gone: invalidates(["key"], "") },
      }),
    },
    ["file"],
    { staleReports: 2 },
  );
  const gone: Observation = {
    kind: "act",
    op: op(c, "upload"),
    outcome: outcome(c, "upload", "gone"),
  };
  const once = absorb(c, freshMind(c), gone);
  assert.equal(once.terminal, null);
  const twice = absorb(c, once, gone);
  assert.deepEqual(twice.terminal, { kind: "unstable", facts: ["key"] });
  assert.deepEqual(decide(c, twice), {
    kind: "fail",
    failure: { kind: "unstable", facts: ["key"] },
  });
});

test("finding a believed fact gone is counted as stale; finding an unknown one gone is not", () => {
  const c = twoWays;
  const done = c.factIndex.get("done") as number;
  const absent: Observation = { kind: "probe", fact: done, result: "absent" };
  const fresh = absorb(c, freshMind(c), absent);
  assert.equal(fresh.staleReports, 0);
  assert.equal(fresh.absent, 1 << done);
  const believed = absorb(c, { ...freshMind(c), held: 1 << done }, absent);
  assert.equal(believed.staleReports, 1);
  assert.equal(believed.held, 0);
  assert.equal(believed.absent, 1 << done);
});

test("a fact that cannot be looked at ends the run only once the probe budget is spent", () => {
  const c = decl(
    { done: fact({ description: "", observable: true }) },
    {
      make: operator({
        description: "",
        establishes: ["done"],
        actor: "machine",
        idempotent: true,
        outcomes: { ok: established("") },
      }),
    },
    ["done"],
    { probeAttempts: 2 },
  );
  const failed: Observation = { kind: "probe", fact: 0, result: "error" };
  const once = absorb(c, freshMind(c), failed);
  assert.equal(once.probeFailures, 1);
  assert.equal(once.terminal, null);
  const twice = absorb(c, once, failed);
  assert.deepEqual(twice.terminal, { kind: "unobservable", fact: "done" });
});

test("what the vault holds at the start is believed only for facts no probe can check", () => {
  const c = decl(
    {
      secret: fact({ description: "" }),
      seen: fact({ description: "", observable: true }),
    },
    {
      make: operator({
        description: "",
        establishes: ["seen"],
        requires: ["secret"],
        actor: "machine",
        idempotent: true,
        outcomes: { ok: established("") },
      }),
      makeSecret: operator({
        description: "",
        establishes: ["secret"],
        actor: "machine",
        idempotent: true,
        outcomes: { ok: established("") },
      }),
    },
    ["seen"],
  );
  const secret = bit(c, "secret");
  const seen = bit(c, "seen");
  const mind = absorb(
    c,
    { ...freshMind(c), absent: secret },
    { kind: "custody", facts: secret | seen },
  );
  assert.equal(mind.held, secret);
  assert.equal(mind.absent, 0);
});

test("a busy reply spends an attempt and leaves beliefs alone; a lost one doubts what it may have made", () => {
  const c = decl(
    {
      seen: fact({ description: "", observable: true }),
      order: fact({ description: "", observable: true }),
    },
    {
      place: operator({
        description: "",
        establishes: ["order"],
        requires: ["seen"],
        actor: "machine",
        idempotent: false,
        outcomes: { ok: established(""), busy: retry(""), lost: unsure("") },
      }),
      look: operator({
        description: "",
        establishes: ["seen"],
        actor: "machine",
        idempotent: true,
        outcomes: { ok: established("") },
      }),
    },
    ["order"],
  );
  const order = bit(c, "order");
  const seen = bit(c, "seen");
  const start: Mind = { ...freshMind(c), held: seen, absent: order };
  const place = op(c, "place");
  const busy = absorb(c, start, {
    kind: "act",
    op: place,
    outcome: outcome(c, "place", "busy"),
  });
  assert.equal(busy.held, seen);
  assert.equal(busy.absent, order);
  assert.equal(busy.residue, 0);
  assert.equal(busy.attempts[place], 1);
  const lost = absorb(c, start, {
    kind: "act",
    op: place,
    outcome: outcome(c, "place", "lost"),
  });
  assert.equal(lost.held, seen);
  // Whether the order exists is now unknown, and it may be left behind.
  assert.equal(lost.absent, 0);
  assert.equal(lost.residue, 1 << place);
  assert.equal(lost.attempts[place], 1);
  // An undeclared ending reads the same as a lost reply.
  assert.deepEqual(
    absorb(c, start, { kind: "act", op: place, outcome: DEFECT }),
    lost,
  );
});

test("a terminal outcome ends the run with its operator, tag and reason", () => {
  const c = decl(
    { done: fact({ description: "", observable: true }) },
    {
      make: operator({
        description: "",
        establishes: ["done"],
        actor: "machine",
        idempotent: true,
        outcomes: {
          ok: established(""),
          banned: terminal("account-suspended", ""),
        },
      }),
    },
    ["done"],
  );
  const mind = absorb(c, freshMind(c), {
    kind: "act",
    op: 0,
    outcome: outcome(c, "make", "banned"),
  });
  const failure = {
    kind: "terminal",
    reason: "account-suspended",
    operator: "make",
    outcome: "banned",
  };
  assert.deepEqual(mind.terminal, failure);
  assert.deepEqual(decide(c, mind), { kind: "fail", failure });
});

test("minds that differ in anything the checker tells apart have different keys", () => {
  const base = freshMind(twoWays);
  const minds: Mind[] = [
    base,
    { ...base, held: 1, absent: 12 },
    { ...base, held: 11, absent: 2 },
    { ...base, attempts: [1, 11] },
    { ...base, attempts: [11, 1] },
    {
      ...base,
      terminal: {
        kind: "terminal",
        reason: "r",
        operator: "cheap",
        outcome: "a",
      },
    },
    {
      ...base,
      terminal: {
        kind: "terminal",
        reason: "r",
        operator: "cheap",
        outcome: "b",
      },
    },
    { ...base, terminal: { kind: "unobservable", fact: "a" } },
    { ...base, terminal: { kind: "unobservable", fact: "b" } },
    { ...base, terminal: { kind: "unstable", facts: ["a"] } },
    { ...base, terminal: { kind: "unstable", facts: ["a", "b"] } },
    { ...base, terminal: { kind: "unstable", facts: ["b"] } },
  ];
  const keys = minds.map(mindKey);
  assert.equal(new Set(keys).size, keys.length, keys.join("\n"));
  // The block reasons only explain, so they do not tell minds apart.
  assert.equal(mindKey({ ...base, why: [0, 1] }), mindKey(base));
});

test("of equally cheap plans, the one using the operator declared first is chosen", () => {
  // Five ways to the goal at the same cost: each lays its own route, then
  // finishes along it.
  const facts: Record<string, ReturnType<typeof fact>> = {
    done: fact({ description: "", observable: true }),
  };
  const operators: Record<string, ReturnType<typeof operator>> = {};
  for (let k = 0; k < 5; k += 1) {
    facts[`route${k}`] = fact({ description: "", observable: true });
    operators[`lay${k}`] = operator({
      description: "",
      establishes: [`route${k}`],
      actor: "machine",
      idempotent: true,
      outcomes: { ok: established("") },
    });
    operators[`finish${k}`] = operator({
      description: "",
      establishes: ["done"],
      requires: [`route${k}`],
      actor: "machine",
      idempotent: true,
      outcomes: { ok: established("") },
    });
  }
  const c = decl(facts, operators, ["done"]);
  assert.deepEqual(plan(c, 0, c.allOperators), {
    cost: 2,
    steps: [op(c, "lay0"), op(c, "finish0")],
  });
  // Without the first route, the next declared.
  const withoutFirst =
    c.allOperators & ~(1 << op(c, "lay0")) & ~(1 << op(c, "finish0"));
  assert.deepEqual(plan(c, 0, withoutFirst), {
    cost: 2,
    steps: [op(c, "lay1"), op(c, "finish1")],
  });
  // Starting on a route, the one already laid is used.
  const onThird = 1 << (c.factIndex.get("route3") as number);
  assert.deepEqual(plan(c, onThird, c.allOperators), {
    cost: 1,
    steps: [op(c, "finish3")],
  });
});
