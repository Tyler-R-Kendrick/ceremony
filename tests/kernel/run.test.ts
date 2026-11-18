import assert from "node:assert/strict";
import test from "node:test";
import fc from "fast-check";
import {
  advance,
  defineCeremony,
  memoryVault,
  JournalConflict,
  type Ceremony,
  type CeremonyDecl,
  type Journal,
  type JournalEntry,
} from "../../src/kernel/index.js";
import { githubAppAccess } from "../../src/kernel/flows/github-app.js";
import { options, wellFormedDecl, withStringValues } from "./support.js";
import { runAndCheck, tally, World } from "./world.js";

const script = fc.array(fc.nat({ max: 1_000 }), {
  minLength: 40,
  maxLength: 40,
});

test("the interpreter survives crashes, lost replies and removals on any well-formed ceremony", async () => {
  await fc.assert(
    fc.asyncProperty(wellFormedDecl, script, async (decl, choices) => {
      const ceremony = defineCeremony(decl as never) as unknown as Ceremony;
      await runAndCheck(ceremony, choices, []);
    }),
    options,
  );
});

test("the interpreter survives the same on the GitHub App ceremony from any start", async () => {
  // The scripted world makes up string values; only the shape is under test.
  const ceremony = withStringValues(githubAppAccess as unknown as Ceremony);
  const starts = [
    [],
    ["target"],
    ["target", "appConfig"],
    ["target", "app"],
    ["target", "app", "installation"],
    ["target", "app", "installation", "token"],
  ];
  await fc.assert(
    fc.asyncProperty(
      script,
      fc.constantFrom(...starts),
      async (choices, start) => {
        await runAndCheck(ceremony, choices, start);
      },
    ),
    { ...options, numRuns: options.numRuns * 3 },
  );
});

test("the scripted runs reached every kind of ending and disturbance", () => {
  for (const [kind, count] of Object.entries(tally)) {
    assert.ok(count > 0, `no run exercised "${kind}"`);
  }
});

test("a second writer on the same journal is refused", async () => {
  const world = new World(
    withStringValues(githubAppAccess as unknown as Ceremony),
    [5],
    ["target", "app", "installation"],
  );
  await assert.rejects(
    world.journal.append({
      seq: 3,
      kind: "begin",
      work: { kind: "probe", fact: "token" },
    }),
    JournalConflict,
  );
});

test("an answer to a request that is not open changes nothing", async () => {
  const ceremony = githubAppAccess as unknown as Ceremony;
  const entries: JournalEntry[] = [];
  const journal: Journal = {
    read: async () => entries.slice(),
    append: async (entry) => {
      entries.push(entry);
    },
  };
  const deps = {
    runId: "run",
    adapters: {
      probes: new Proxy({}, { get: () => async () => ({ held: false }) }),
      operators: {},
    } as never,
    journal,
    vault: memoryVault(),
  };
  const first = await advance(ceremony, deps);
  assert.equal(first.status, "awaiting");
  const length = entries.length;
  const again = await advance(ceremony, deps, {
    requestId: "run:chooseTarget:0",
    outcome: "chosen",
    values: { target: { login: "octo", kind: "User" } },
  });
  assert.deepEqual(again, first);
  assert.equal(entries.length, length);
});

test("declarations the interpreter cannot honour are refused before any run", () => {
  const broken: CeremonyDecl = {
    id: "broken",
    title: "broken",
    facts: {},
    operators: {},
    goal: [],
  };
  assert.throws(() => defineCeremony(broken as never), /at least one goal/);
});
