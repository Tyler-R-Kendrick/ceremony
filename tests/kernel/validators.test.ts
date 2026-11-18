/**
 * How the interpreter treats what a validator says: a validator that throws
 * or makes nothing of a value rejects it, an asynchronous one is awaited, and
 * the value kept is the one the validator returns.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { z } from "zod";
import {
  advance,
  checked,
  checkValue,
  defineCeremony,
  DEFECT_TAG,
  established,
  fact,
  memoryJournal,
  memoryVault,
  of,
  operator,
  type JournalEntry,
  type StandardSchema,
  type ValueType,
} from "../../src/kernel/index.js";

function schema(
  validate: StandardSchema<string>["~standard"]["validate"],
): StandardSchema<string> {
  return { "~standard": { version: 1, vendor: "test", validate } };
}

async function run(value: ValueType<string>, given: unknown) {
  const ceremony = defineCeremony({
    id: "validators",
    title: "validators",
    facts: {
      name: fact({
        description: "",
        value,
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
        attempts: 1,
        outcomes: { made: established("") },
      }),
    },
    goal: ["name"],
  });
  const journal: JournalEntry[] = [];
  const values = new Map<string, unknown>();
  await advance(ceremony, {
    runId: "run",
    adapters: {
      probes: { name: async () => ({ held: false }) },
      operators: {
        make: async () => ({ outcome: "made", values: { name: given } }),
      },
    } as never,
    journal: memoryJournal(journal),
    vault: memoryVault(values),
  });
  const outcomes = journal.flatMap((entry) =>
    entry.kind === "end" && entry.result.kind === "act"
      ? [entry.result.outcome]
      : [],
  );
  return { outcomes, stored: values.get("name") };
}

test("a validator that throws rejects the value", async () => {
  const { outcomes, stored } = await run(
    of<string>(
      schema(() => {
        throw new Error("broken validator");
      }),
    ),
    "x",
  );
  assert.deepEqual(outcomes, [DEFECT_TAG]);
  assert.equal(stored, undefined);
});

test("a validator that makes nothing of a value rejects it", async () => {
  const { outcomes, stored } = await run(
    of<string>(schema(() => ({ value: undefined as unknown as string }))),
    "x",
  );
  assert.deepEqual(outcomes, [DEFECT_TAG]);
  assert.equal(stored, undefined);
});

test("an asynchronous validator is awaited", async () => {
  const rejecting = await run(
    of<string>(schema(async () => ({ issues: [{ message: "no" }] }))),
    "x",
  );
  assert.deepEqual(rejecting.outcomes, [DEFECT_TAG]);
  const accepting = await run(
    of<string>(schema(async (value) => ({ value: value as string }))),
    "x",
  );
  assert.deepEqual(accepting.outcomes, ["made"]);
  assert.equal(accepting.stored, "x");
});

test("the value kept is the one the validator returns", async () => {
  const { outcomes, stored } = await run(
    of<string>(z.string().trim()),
    "  padded  ",
  );
  assert.deepEqual(outcomes, ["made"]);
  assert.equal(stored, "padded");
});

test("a value missing from an establishing reply is a defect", async () => {
  const { outcomes } = await run(
    of<string | undefined>(z.string().optional()) as ValueType<string>,
    undefined,
  );
  assert.deepEqual(outcomes, [DEFECT_TAG]);
});

test("only a schema with a validate function counts as a validator", async () => {
  assert.equal(checked(of<string>(z.string())), true);
  assert.equal(checked(of<string>()), false);
  assert.equal(checked(undefined), false);
  assert.equal(checked({ schema: null } as never), false);
  assert.equal(checked({ schema: {} } as never), false);
  assert.equal(checked({ schema: { "~standard": {} } } as never), false);
  assert.equal(
    checked({ schema: { "~standard": { validate: true } } } as never),
    false,
  );
  assert.deepEqual(await checkValue(of<string>(), 7), { ok: true, value: 7 });
  assert.deepEqual(await checkValue(of<string>(z.string()), 7), { ok: false });
});
