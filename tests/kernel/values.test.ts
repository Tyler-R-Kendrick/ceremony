/**
 * Values are checked. A fact declares a validator with `of(schema)`, where the
 * schema is any Standard Schema (a zod schema is one). A value an adapter, a
 * probe or a person's answer supplies that the validator rejects is a defect:
 * it never reaches the vault, staged or promoted. A fact a person supplies
 * with no validator is refused before any run (`value-unchecked`).
 */
import assert from "node:assert/strict";
import test from "node:test";
import { z } from "zod";
import {
  advance,
  defineCeremony,
  DEFECT_TAG,
  established,
  fact,
  memoryJournal,
  memoryVault,
  of,
  operator,
  validate,
  type Ceremony,
  type CeremonyDecl,
  type FactDecl,
  type JournalEntry,
  type ValueType,
  type Vault,
} from "../../src/kernel/index.js";
import { catalog } from "../../src/kernel/flows/catalog.js";
import {
  githubAppAccess,
  githubUserAccess,
} from "../../src/kernel/flows/github-app.js";

/** A value every schema below rejects, easy to find in anything written. */
const BAD = "bad-sentinel-value";
const name = z.string().regex(/^ok-/);

/** A vault that remembers everything ever written to it. */
function recording(): {
  vault: Vault;
  values: Map<string, unknown>;
  puts: string[];
} {
  const values = new Map<string, unknown>();
  const inner = memoryVault(values);
  const puts: string[] = [];
  return {
    values,
    puts,
    vault: {
      get: inner.get,
      delete: inner.delete,
      put: async (key, value) => {
        puts.push(`${key}=${JSON.stringify(value)}`);
        await inner.put(key, value);
      },
    },
  };
}

function deps(
  journal: JournalEntry[],
  vault: Vault,
  operators: Record<string, (context: never) => Promise<unknown>>,
  probes: Record<string, (context: never) => Promise<unknown>>,
) {
  return {
    runId: "run",
    adapters: { probes, operators } as never,
    journal: memoryJournal(journal),
    vault,
  };
}

const actOutcomes = (journal: readonly JournalEntry[]): string[] =>
  journal.flatMap((entry) =>
    entry.kind === "end" && entry.result.kind === "act"
      ? [entry.result.outcome]
      : [],
  );

const probeResults = (journal: readonly JournalEntry[]): string[] =>
  journal.flatMap((entry) =>
    entry.kind === "end" && entry.result.kind === "probe"
      ? [entry.result.result]
      : [],
  );

const machine = defineCeremony({
  id: "machine-values",
  title: "machine-values",
  facts: {
    name: fact({
      description: "",
      value: of<string>(name),
      observable: true,
      discoverable: true,
    }),
  },
  operators: {
    make: operator({
      description: "",
      establishes: ["name"],
      actor: "machine",
      idempotent: true,
      outcomes: { made: established("") },
    }),
  },
  goal: ["name"],
});

test("of keeps the schema it was given", () => {
  const schema = z.string();
  assert.equal(of<string>(schema).schema, schema);
});

test("an adapter value the validator rejects is a defect and never reaches the vault", async () => {
  const journal: JournalEntry[] = [];
  const r = recording();
  let calls = 0;
  const status = await advance(
    machine,
    deps(
      journal,
      r.vault,
      {
        make: async () => {
          calls += 1;
          return { outcome: "made", values: { name: BAD } };
        },
      },
      { name: async () => ({ held: false }) },
    ),
  );
  assert.ok(calls > 0);
  assert.ok(actOutcomes(journal).length > 0);
  assert.ok(
    actOutcomes(journal).every((outcome) => outcome === DEFECT_TAG),
    actOutcomes(journal).join(", "),
  );
  assert.equal(r.values.get("name"), undefined);
  assert.deepEqual(
    r.puts.filter((put) => put.includes(BAD)),
    [],
  );
  assert.equal(status.status, "failed");
});

test("an adapter value the validator accepts is kept", async () => {
  const journal: JournalEntry[] = [];
  const r = recording();
  const status = await advance(
    machine,
    deps(
      journal,
      r.vault,
      { make: async () => ({ outcome: "made", values: { name: "ok-1" } }) },
      { name: async () => ({ held: false }) },
    ),
  );
  assert.equal(status.status, "success");
  assert.deepEqual(actOutcomes(journal), ["made"]);
  assert.equal(r.values.get("name"), "ok-1");
});

test("a probe value the validator rejects is a failed probe and is not stored", async () => {
  const journal: JournalEntry[] = [];
  const r = recording();
  await advance(
    machine,
    deps(
      journal,
      r.vault,
      { make: async () => ({ outcome: "made", values: { name: "ok-2" } }) },
      { name: async () => ({ held: true, value: BAD }) },
    ),
  );
  const results = probeResults(journal);
  assert.ok(results.length > 0);
  assert.ok(
    results.every((result) => result === "error"),
    results.join(", "),
  );
  assert.deepEqual(
    r.puts.filter((put) => put.includes(BAD)),
    [],
  );
  assert.notEqual(r.values.get("name"), BAD);
});

test("a probe value the validator accepts is held and stored", async () => {
  const journal: JournalEntry[] = [];
  const r = recording();
  const status = await advance(
    machine,
    deps(
      journal,
      r.vault,
      {},
      { name: async () => ({ held: true, value: "ok-held" }) },
    ),
  );
  assert.equal(status.status, "success");
  assert.deepEqual(probeResults(journal), ["held"]);
  assert.equal(r.values.get("name"), "ok-held");
});

const human = defineCeremony({
  id: "human-values",
  title: "human-values",
  facts: {
    name: fact({
      description: "",
      value: of<string>(name),
      observable: true,
      discoverable: true,
    }),
  },
  operators: {
    ask: operator({
      description: "",
      establishes: ["name"],
      actor: "human",
      idempotent: true,
      outcomes: { given: established("") },
      interface: {
        title: "Name",
        body: "",
        actions: [
          { id: "give", label: "Give", outcome: "given", emphasis: "primary" },
        ],
      },
    }),
  },
  goal: ["name"],
});

test("an answer value the validator rejects is a defect and never reaches the vault", async () => {
  const journal: JournalEntry[] = [];
  const r = recording();
  const d = deps(
    journal,
    r.vault,
    {},
    {
      name: async () => ({ held: false }),
    },
  );
  const open = await advance(human, d);
  assert.ok(open.status === "awaiting");
  await advance(human, d, {
    requestId: open.request.requestId,
    outcome: "given",
    values: { name: BAD },
  });
  assert.deepEqual(actOutcomes(journal), [DEFECT_TAG]);
  assert.equal(r.values.get("name"), undefined);
  assert.deepEqual(
    r.puts.filter((put) => put.includes(BAD)),
    [],
  );
});

test("an answer value the validator accepts is kept", async () => {
  const journal: JournalEntry[] = [];
  const r = recording();
  let given: string | undefined;
  const d = deps(
    journal,
    r.vault,
    {},
    {
      name: async () =>
        given === undefined ? { held: false } : { held: true, value: given },
    },
  );
  const open = await advance(human, d);
  assert.ok(open.status === "awaiting");
  given = "ok-person";
  const status = await advance(human, d, {
    requestId: open.request.requestId,
    outcome: "given",
    values: { name: given },
  });
  assert.equal(status.status, "success");
  assert.deepEqual(actOutcomes(journal), ["given"]);
  assert.equal(r.values.get("name"), "ok-person");
});

/** The human ceremony with its fact's validator taken away. */
function unvalidated(): CeremonyDecl {
  return {
    id: "unvalidated",
    title: "unvalidated",
    facts: {
      name: {
        ...(human.facts.name as FactDecl),
        value: {} as ValueType<string>,
      },
    },
    operators: human.operators,
    goal: ["name"],
  };
}

test("a fact a person supplies with no validator is refused (value-unchecked)", () => {
  const issues = validate(unvalidated()).issues.filter(
    (issue) => issue.rule === "value-unchecked",
  );
  assert.deepEqual(
    issues.map((issue) => [issue.severity, issue.subject]),
    [["error", "fact name"]],
  );
  assert.throws(
    () => defineCeremony(unvalidated() as never),
    /value-unchecked/,
  );
});

test("the same fact with a validator passes the rule", () => {
  assert.deepEqual(
    validate(human as unknown as CeremonyDecl).issues.filter(
      (issue) => issue.rule === "value-unchecked",
    ),
    [],
  );
});

const flows: Record<string, Ceremony> = {
  ...(catalog as unknown as Record<string, Ceremony>),
  githubAppAccess: githubAppAccess as unknown as Ceremony,
  githubUserAccess: githubUserAccess as unknown as Ceremony,
};

for (const [flow, ceremony] of Object.entries(flows)) {
  test(`${flow}: every fact declares a validator that rejects a stray value`, async () => {
    for (const [factName, declared] of Object.entries(ceremony.facts)) {
      const schema = (declared.value as { schema?: unknown }).schema as
        | {
            readonly "~standard": {
              validate(value: unknown): unknown;
            };
          }
        | undefined;
      assert.ok(
        schema !== undefined && "~standard" in schema,
        `${flow}.${factName} has no validator`,
      );
      const result = (await schema["~standard"].validate(Symbol("stray"))) as {
        readonly issues?: readonly unknown[];
      };
      assert.ok(
        result.issues !== undefined && result.issues.length > 0,
        `${flow}.${factName} accepts any value`,
      );
    }
  });

  test(`${flow}: passes value-unchecked`, () => {
    assert.deepEqual(
      validate(ceremony)
        .issues.filter((issue) => issue.rule === "value-unchecked")
        .map((issue) => issue.subject),
      [],
    );
  });
}
