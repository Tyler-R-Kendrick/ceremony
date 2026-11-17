/**
 * The interpreter against scripted adapters: what it writes to the journal
 * and the vault for each kind of answer, and how it picks up after a crash.
 */
import assert from "node:assert/strict";
import test from "node:test";
import {
  advance,
  defineCeremony,
  established,
  fact,
  invalidates,
  JournalConflict,
  JournalMismatch,
  memoryJournal,
  memoryVault,
  of,
  operator,
  replay,
  retry,
  unsure,
  type Ceremony,
  type Journal,
  type JournalEntry,
  type RunStatus,
  type Vault,
} from "../../src/kernel/index.js";

type Probe = () => Promise<{ held: true; value: unknown } | { held: false }>;
type Act = (context: {
  values: Record<string, unknown>;
  attempt: number;
  idempotencyKey: string;
}) => Promise<{ outcome: string; values?: Record<string, unknown> }>;

interface Rig {
  readonly journal: JournalEntry[];
  readonly values: Map<string, unknown>;
  readonly vault: Vault;
  readonly deleted: string[];
  run(): Promise<RunStatus>;
}

function rig(
  ceremony: Ceremony,
  probes: Record<string, Probe>,
  operators: Record<string, Act>,
  options: {
    values?: Map<string, unknown>;
    vault?: (inner: Vault) => Vault;
    journal?: JournalEntry[];
  } = {},
): Rig {
  const journal = options.journal ?? [];
  const values = options.values ?? new Map<string, unknown>();
  const deleted: string[] = [];
  const inner = memoryVault(values);
  const recording: Vault = {
    get: (name) => inner.get(name),
    put: (name, value) => inner.put(name, value),
    delete: async (name) => {
      deleted.push(name);
      await inner.delete(name);
    },
  };
  const vault = options.vault ? options.vault(recording) : recording;
  return {
    journal,
    values,
    vault,
    deleted,
    run: () =>
      advance(ceremony, {
        runId: "run",
        adapters: { probes, operators } as never,
        journal: memoryJournal(journal),
        vault,
      }),
  };
}

const results = (journal: readonly JournalEntry[]): unknown[] =>
  journal.flatMap((entry) => (entry.kind === "end" ? [entry.result] : []));

/** A key no probe can see, and a file that needs it. */
const upload = defineCeremony({
  id: "upload",
  title: "upload",
  facts: {
    key: fact({ description: "", value: of<string>() }),
    file: fact({
      description: "",
      value: of<string>(),
      observable: true,
      discoverable: true,
    }),
  },
  operators: {
    makeKey: operator({
      description: "",
      establishes: ["key"],
      actor: "machine",
      idempotent: true,
      outcomes: { made: established("") },
    }),
    send: operator({
      description: "",
      establishes: ["file"],
      requires: ["key"],
      actor: "machine",
      idempotent: true,
      outcomes: {
        sent: established(""),
        badKey: invalidates(["key"], ""),
        lost: unsure(""),
      },
    }),
  },
  goal: ["file"],
}) as unknown as Ceremony;

/** A world for `upload`: the file exists once sent. */
function uploadWorld(script: string[] = []) {
  const state = new Map<string, unknown>();
  const keys: string[] = [];
  const sent: unknown[] = [];
  let made = 0;
  return {
    state,
    keys,
    sent,
    probes: {
      file: async () =>
        state.has("file")
          ? { held: true as const, value: state.get("file") }
          : { held: false as const },
    },
    operators: {
      makeKey: async () => {
        made += 1;
        keys.push(`k${made}`);
        return { outcome: "made", values: { key: `k${made}` } };
      },
      send: async ({ values }: { values: Record<string, unknown> }) => {
        sent.push(values.key);
        const next = script.shift() ?? "sent";
        if (next !== "sent") return { outcome: next };
        state.set("file", `file-${String(values.key)}`);
        return {
          outcome: "sent",
          values: { file: `file-${String(values.key)}` },
        };
      },
    },
  };
}

test("a key the vault already holds is used, not made again, and the run says so first", async () => {
  const world = uploadWorld();
  const r = rig(upload, world.probes, world.operators, {
    values: new Map([["key", "kept"]]),
  });
  const status = await r.run();
  assert.deepEqual(status, { status: "success", leftBehind: [] });
  assert.deepEqual(world.keys, []);
  assert.deepEqual(world.sent, ["kept"]);
  assert.deepEqual(r.journal[0], {
    seq: 0,
    kind: "end",
    result: { kind: "custody", facts: ["key"] },
  });
  assert.equal(r.values.get("file"), "file-kept");
});

test("with nothing in the vault, the run says it holds nothing and makes the key", async () => {
  const world = uploadWorld();
  const r = rig(upload, world.probes, world.operators);
  assert.equal((await r.run()).status, "success");
  assert.deepEqual(r.journal[0], {
    seq: 0,
    kind: "end",
    result: { kind: "custody", facts: [] },
  });
  assert.deepEqual(world.keys, ["k1"]);
  assert.deepEqual(world.sent, ["k1"]);
  assert.equal(r.values.get("key"), "k1");
});

test("a key reported bad is dropped from the vault before a new one is made", async () => {
  const world = uploadWorld(["badKey"]);
  const r = rig(upload, world.probes, world.operators);
  assert.equal((await r.run()).status, "success");
  assert.deepEqual(world.sent, ["k1", "k2"]);
  const dropped = r.deleted.indexOf("key");
  assert.ok(dropped >= 0, "the bad key was never deleted");
  assert.equal(r.values.get("key"), "k2");
  assert.ok(
    results(r.journal).some(
      (result) => (result as { outcome?: string }).outcome === "badKey",
    ),
  );
});

test("a value the vault lost is recorded as lost and made again before anything reads it", async () => {
  const world = uploadWorld();
  let forgot = false;
  const r = rig(upload, world.probes, world.operators, {
    vault: (inner) => ({
      ...inner,
      get: async (name) => {
        // The first time the key is read back after being made, it is gone.
        if (name === "key" && !forgot && (await inner.get("key")) === "k1") {
          forgot = true;
          await inner.delete("key");
          return undefined;
        }
        return inner.get(name);
      },
    }),
  });
  assert.equal((await r.run()).status, "success");
  assert.ok(forgot);
  assert.deepEqual(world.keys, ["k1", "k2"]);
  // Nothing was ever sent without its key.
  assert.deepEqual(world.sent, ["k2"]);
  assert.ok(
    results(r.journal).some(
      (result) =>
        JSON.stringify(result) ===
        JSON.stringify({ kind: "lost", fact: "key" }),
    ),
  );
});

test("a goal whose value the vault lost is looked at again rather than made again", async () => {
  const world = uploadWorld();
  let forgot = false;
  const r = rig(upload, world.probes, world.operators, {
    vault: (inner) => ({
      ...inner,
      get: async (name) => {
        if (
          name === "file" &&
          !forgot &&
          (await inner.get("file")) !== undefined
        ) {
          forgot = true;
          await inner.delete("file");
          return undefined;
        }
        return inner.get(name);
      },
    }),
  });
  assert.equal((await r.run()).status, "success");
  assert.ok(forgot);
  assert.deepEqual(world.sent, ["k1"]);
  assert.equal(r.values.get("file"), "file-k1");
  const last = results(r.journal).at(-1);
  assert.deepEqual(last, { kind: "probe", fact: "file", result: "held" });
});

test("a goal whose value is gone from both the vault and the world is made again", async () => {
  const world = uploadWorld();
  let forgot = false;
  const r = rig(upload, world.probes, world.operators, {
    vault: (inner) => ({
      ...inner,
      get: async (name) => {
        if (
          name === "file" &&
          !forgot &&
          (await inner.get("file")) !== undefined
        ) {
          forgot = true;
          world.state.delete("file");
          await inner.delete("file");
          return undefined;
        }
        return inner.get(name);
      },
    }),
  });
  assert.equal((await r.run()).status, "success");
  assert.deepEqual(world.sent, ["k1", "k1"]);
  assert.ok(
    !results(r.journal).some(
      (result) => (result as { kind: string }).kind === "lost",
    ),
  );
});

/** One machine step whose replies can be anything. */
const single = defineCeremony({
  id: "single",
  title: "single",
  facts: {
    done: fact({
      description: "",
      value: of<string>(),
      observable: true,
      discoverable: true,
    }),
  },
  operators: {
    make: operator({
      description: "",
      establishes: ["done"],
      actor: "machine",
      idempotent: true,
      attempts: 5,
      outcomes: { made: established(""), busy: retry(""), lost: unsure("") },
    }),
  },
  goal: ["done"],
}) as unknown as Ceremony;

test("a reply the operator does not declare, one missing its value, a throw and a missing adapter are all journaled as defects", async () => {
  const replies: (() => Promise<{
    outcome: string;
    values?: Record<string, unknown>;
  }>)[] = [
    async () => ({ outcome: "exploded" }),
    async () => ({ outcome: "made" }),
    async () => ({ outcome: "made", values: { other: 1 } }),
    async () => {
      throw new Error("down");
    },
    async () => ({ outcome: "made", values: { done: "d" } }),
  ];
  let held = false;
  const r = rig(
    single,
    {
      done: async () => (held ? { held: true, value: "d" } : { held: false }),
    },
    {
      make: async () => {
        const reply = await (
          replies.shift() as () => Promise<{
            outcome: string;
            values?: Record<string, unknown>;
          }>
        )();
        if (reply.outcome === "made" && reply.values?.done) held = true;
        return reply;
      },
    },
  );
  assert.equal((await r.run()).status, "success");
  const acts = results(r.journal)
    .filter((result) => (result as { kind: string }).kind === "act")
    .map((result) => (result as { outcome: string }).outcome);
  assert.deepEqual(acts, ["#defect", "#defect", "#defect", "#defect", "made"]);
  // Only the reply with its value put anything in the vault.
  assert.equal(r.values.get("done"), "d");

  const bare = rig(single, { done: async () => ({ held: false }) }, {});
  const status = await bare.run();
  assert.equal(status.status, "failed");
  assert.ok(
    results(bare.journal).some(
      (result) => (result as { outcome?: string }).outcome === "#defect",
    ),
  );
});

test("a probe that is missing, throws, or says held without a value is journaled as an error", async () => {
  for (const probe of [
    undefined,
    async () => {
      throw new Error("down");
    },
    async () => ({ held: true as const, value: undefined }),
  ]) {
    const r = rig(single, probe === undefined ? {} : { done: probe as Probe }, {
      make: async () => ({ outcome: "made", values: { done: "d" } }),
    });
    const status = await r.run();
    assert.equal(status.status, "failed");
    assert.ok(status.status === "failed");
    assert.deepEqual(status.failure, { kind: "unobservable", fact: "done" });
    const probes = results(r.journal).filter(
      (result) => (result as { kind: string }).kind === "probe",
    );
    assert.ok(probes.length > 0);
    for (const result of probes) {
      assert.deepEqual(result, {
        kind: "probe",
        fact: "done",
        result: "error",
      });
    }
    assert.equal(r.journal[1]?.kind, "begin");
    assert.deepEqual((r.journal[1] as { work: unknown }).work, {
      kind: "probe",
      fact: "done",
    });
  }
});

test("a probe that finds a fact gone drops the values that rested on it", async () => {
  const chain = defineCeremony({
    id: "chain",
    title: "chain",
    facts: {
      app: fact({
        description: "",
        value: of<string>(),
        observable: true,
        discoverable: true,
      }),
      install: fact({
        description: "",
        value: of<string>(),
        observable: true,
        discoverable: true,
        requires: ["app"],
      }),
    },
    operators: {
      makeApp: operator({
        description: "",
        establishes: ["app"],
        actor: "machine",
        idempotent: true,
        outcomes: { made: established("") },
      }),
      installApp: operator({
        description: "",
        establishes: ["install"],
        requires: ["app"],
        actor: "machine",
        idempotent: true,
        outcomes: { made: established("") },
      }),
    },
    goal: ["install"],
  }) as unknown as Ceremony;
  const state = new Map<string, unknown>();
  const r = rig(
    chain,
    {
      app: async () =>
        state.has("app")
          ? { held: true, value: state.get("app") }
          : { held: false },
      install: async () =>
        state.has("install")
          ? { held: true, value: state.get("install") }
          : { held: false },
    },
    {
      makeApp: async () => {
        state.set("app", "a2");
        return { outcome: "made", values: { app: "a2" } };
      },
      installApp: async () => {
        state.set("install", "i2");
        return { outcome: "made", values: { install: "i2" } };
      },
    },
    { values: new Map([["install", "i1"]]) },
  );
  assert.equal((await r.run()).status, "success");
  // `install` was probed first and found gone, then `app`: the stale value
  // of `install` went with them before anything was made.
  assert.ok(r.deleted.includes("install"));
  assert.ok(r.deleted.includes("app"));
  assert.equal(r.values.get("install"), "i2");
});

test("an interface shows the values of the facts it names", async () => {
  const review = defineCeremony({
    id: "review",
    title: "review",
    facts: {
      draft: fact({
        description: "",
        value: of<string>(),
        observable: true,
        discoverable: true,
      }),
      approval: fact({
        description: "",
        value: of<string>(),
        observable: true,
        discoverable: true,
        requires: ["draft"],
      }),
    },
    operators: {
      write: operator({
        description: "",
        establishes: ["draft"],
        actor: "machine",
        idempotent: true,
        outcomes: { written: established("") },
      }),
      approve: operator({
        description: "",
        establishes: ["approval"],
        requires: ["draft"],
        actor: "human",
        idempotent: true,
        outcomes: { approved: established("") },
        interface: {
          title: "Approve",
          body: "",
          shows: ["draft"],
          actions: [
            {
              id: "approve",
              label: "Approve",
              outcome: "approved",
              emphasis: "primary",
            },
          ],
        },
      }),
    },
    goal: ["approval"],
  }) as unknown as Ceremony;
  const r = rig(
    review,
    {
      draft: async () => ({ held: false }),
      approval: async () => ({ held: false }),
    },
    { write: async () => ({ outcome: "written", values: { draft: "text" } }) },
  );
  const status = await r.run();
  assert.ok(status.status === "awaiting");
  assert.equal(status.request.operator, "approve");
  assert.deepEqual(status.request.shows, { draft: "text" });
});

test("a crash between the commit and the promotion is finished on the next call, without running again", async () => {
  const world = uploadWorld();
  let crash = true;
  const values = new Map<string, unknown>();
  const journal: JournalEntry[] = [];
  const crashing = rig(upload, world.probes, world.operators, {
    values,
    journal,
    vault: (inner) => ({
      ...inner,
      put: async (name, value) => {
        if (crash && name === "key") {
          crash = false;
          throw new Error("died");
        }
        await inner.put(name, value);
      },
    }),
  });
  await assert.rejects(crashing.run(), /died/);
  assert.deepEqual(results(journal).at(-1), {
    kind: "act",
    operator: "makeKey",
    outcome: "made",
  });
  assert.equal(values.get("key"), undefined);
  const again = rig(upload, world.probes, world.operators, {
    values,
    journal,
  });
  assert.equal((await again.run()).status, "success");
  assert.deepEqual(world.keys, ["k1"]);
  assert.deepEqual(world.sent, ["k1"]);
  assert.equal(values.get("key"), "k1");
  assert.deepEqual(
    [...values.keys()].filter((name) => name.startsWith("#staged")),
    [],
  );
});

test("a probe cut off by a crash is journaled as failed when the run resumes", async () => {
  const world = uploadWorld();
  const entries: JournalEntry[] = [];
  const inner = memoryJournal(entries);
  let refuse = true;
  const journal: Journal = {
    read: inner.read,
    append: async (entry) => {
      if (refuse && entry.kind === "end" && entry.result.kind === "probe") {
        refuse = false;
        throw new Error("died");
      }
      await inner.append(entry);
    },
  };
  const deps = {
    runId: "run",
    adapters: { probes: world.probes, operators: world.operators } as never,
    journal,
    vault: memoryVault(),
  };
  await assert.rejects(advance(upload, deps), /died/);
  assert.equal(entries.at(-1)?.kind, "begin");
  assert.equal((await advance(upload, deps)).status, "success");
  assert.deepEqual(entries[2], {
    seq: 2,
    kind: "end",
    result: { kind: "probe", fact: "file", result: "error" },
  });
});

test("a lost reply is retried under the same key; a settled attempt moves to the next", async () => {
  // Both operators answer "ok" on success, so only the operator's name tells
  // whose success it was.
  const two = defineCeremony({
    id: "two",
    title: "two",
    facts: {
      a: fact({
        description: "",
        value: of<string>(),
        observable: true,
        discoverable: true,
      }),
      order: fact({
        description: "",
        value: of<string>(),
        observable: true,
        discoverable: true,
      }),
    },
    operators: {
      makeA: operator({
        description: "",
        establishes: ["a"],
        actor: "machine",
        idempotent: true,
        outcomes: { ok: established("") },
      }),
      place: operator({
        description: "",
        establishes: ["order"],
        actor: "machine",
        idempotent: false,
        attempts: 6,
        outcomes: {
          ok: established(""),
          busy: retry(""),
          lost: unsure(""),
        },
      }),
    },
    goal: ["a", "order"],
  }) as unknown as Ceremony;
  const state = new Map<string, unknown>();
  const keys: string[] = [];
  const script = ["throw", "busy", "ok"];
  const r = rig(
    two,
    {
      a: async () =>
        state.has("a")
          ? { held: true, value: state.get("a") }
          : { held: false },
      order: async () =>
        state.has("order")
          ? { held: true, value: state.get("order") }
          : { held: false },
    },
    {
      makeA: async () => {
        state.set("a", "a");
        return { outcome: "ok", values: { a: "a" } };
      },
      place: async ({ idempotencyKey }) => {
        keys.push(idempotencyKey);
        const next = script.shift();
        if (next === "throw") throw new Error("reply lost");
        if (next === "busy") return { outcome: "busy" };
        state.set("order", "o");
        return { outcome: "ok", values: { order: "o" } };
      },
    },
  );
  assert.equal((await r.run()).status, "success");
  const madeA = r.journal.findIndex(
    (entry) =>
      entry.kind === "end" &&
      JSON.stringify(entry.result) ===
        JSON.stringify({ kind: "act", operator: "makeA", outcome: "ok" }),
  );
  const firstPlace = r.journal.findIndex(
    (entry) =>
      entry.kind === "begin" &&
      entry.work.kind === "act" &&
      entry.work.operator === "place",
  );
  // makeA succeeded before place was first called.
  assert.ok(madeA >= 0 && madeA < firstPlace);
  // Settled before each call: the first absent probe of `order`, then a
  // second one after the lost reply. The busy reply settles nothing. Probes
  // of `a` and the success of `makeA` are not this operator's.
  assert.deepEqual(keys, ["run:place:1", "run:place:2", "run:place:2"]);

  // The order disappears, with its value. Finding it gone and the earlier
  // success both settle an attempt: one success and three absent probes.
  state.delete("order");
  r.values.delete("order");
  script.push("ok");
  assert.equal((await r.run()).status, "success");
  assert.equal(keys.at(-1), "run:place:4");
});

test("a journal refuses a write out of turn and hands out copies of what it holds", async () => {
  const entries: JournalEntry[] = [];
  const journal = memoryJournal(entries);
  const error = await journal
    .append({ seq: 3, kind: "begin", work: { kind: "probe", fact: "x" } })
    .then(
      () => null,
      (rejected: unknown) => rejected,
    );
  assert.ok(error instanceof JournalConflict);
  assert.equal(error.name, "JournalConflict");
  assert.equal(error.message, "journal is at 0, writer expected 3");
  await journal.append({
    seq: 0,
    kind: "begin",
    work: { kind: "probe", fact: "x" },
  });
  const read = (await journal.read()) as JournalEntry[];
  read.pop();
  assert.equal((await journal.read()).length, 1);
  assert.equal(entries.length, 1);
  // Starting from entries that are already there continues after them.
  const continued = memoryJournal([...entries]);
  await assert.rejects(
    continued.append({
      seq: 0,
      kind: "begin",
      work: { kind: "probe", fact: "x" },
    }),
    JournalConflict,
  );
  // A new journal starts empty.
  const fresh = memoryJournal();
  assert.deepEqual(await fresh.read(), []);
  await fresh.append({
    seq: 0,
    kind: "begin",
    work: { kind: "probe", fact: "x" },
  });
  assert.equal((await fresh.read()).length, 1);
});

test("a journal naming a fact or operator the ceremony does not declare is refused by name", () => {
  const compiled = upload.compiled;
  const fact = (): unknown =>
    replay(compiled, [
      { seq: 0, kind: "end", result: { kind: "custody", facts: ["nope"] } },
    ]);
  assert.throws(fact, (error: unknown) => {
    assert.ok(error instanceof JournalMismatch);
    assert.equal(error.name, "JournalMismatch");
    assert.equal(
      error.message,
      'the journal names fact "nope", which this ceremony does not declare',
    );
    return true;
  });
  assert.throws(
    () =>
      replay(compiled, [
        {
          seq: 0,
          kind: "begin",
          work: { kind: "act", operator: "nope", attempt: 1 },
        },
      ]),
    /names operator "nope"/,
  );
  assert.throws(
    () =>
      replay(compiled, [
        {
          seq: 0,
          kind: "end",
          result: { kind: "act", operator: "nope", outcome: "made" },
        },
      ]),
    /names operator "nope"/,
  );
});

test("replaying the journal rebuilds custody, work in flight and its results", () => {
  const compiled = upload.compiled;
  const key = 1 << (compiled.factIndex.get("key") as number);
  const custody = replay(compiled, [
    { seq: 0, kind: "end", result: { kind: "custody", facts: ["key"] } },
  ]);
  assert.equal(custody.held, key);
  const sending = replay(compiled, [
    { seq: 0, kind: "end", result: { kind: "custody", facts: ["key"] } },
    {
      seq: 1,
      kind: "begin",
      work: { kind: "act", operator: "send", attempt: 1 },
    },
  ]);
  assert.deepEqual(sending.pending, {
    kind: "act",
    op: compiled.operatorIndex.get("send"),
    attempt: 1,
  });
  const lost = replay(compiled, [
    { seq: 0, kind: "end", result: { kind: "custody", facts: ["key"] } },
    { seq: 1, kind: "end", result: { kind: "lost", fact: "key" } },
  ]);
  assert.equal(lost.held, 0);
  assert.equal(lost.absent, key);
  assert.equal(lost.staleReports, 1);
  const undeclared = replay(compiled, [
    {
      seq: 0,
      kind: "begin",
      work: { kind: "act", operator: "send", attempt: 1 },
    },
    {
      seq: 1,
      kind: "end",
      result: { kind: "act", operator: "send", outcome: "#defect" },
    },
  ]);
  // An undeclared ending reads as unsure: an attempt is spent.
  assert.equal(
    undeclared.attempts[compiled.operatorIndex.get("send") as number],
    1,
  );
  assert.equal(undeclared.pending, null);
});

/*
 * Mutants of run.ts no test can kill, because the mutated program behaves
 * the same:
 *
 * - `kind: "act"` in `toObservation` emptied: `absorb` reads every
 *   observation that is not custody, lost or a probe as an act.
 * - `full.kind === "end"` in `write` replaced by false or compared with "":
 *   replaying the journal gives the same knowledge as absorbing its last
 *   entry.
 * - The promotion check after a crash with `last?.` or `before?.` without
 *   the `?.`, with one of its later conditions replaced by true, or with its
 *   first two conditions joined to the third by "or": the custody entry
 *   means the journal is never empty there, and an `act` end always
 *   directly follows its own `act` begin.
 * - `pass -= 1`, `pass >= 10_000` and the check replaced by false: the
 *   guard is never reached by a well-formed ceremony.
 * - `declared.interface?.shows` without the `?.`: a ceremony whose human
 *   step has no interface is refused before it runs.
 */
