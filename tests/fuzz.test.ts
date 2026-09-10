import assert from "node:assert/strict";
import { test } from "node:test";
import { randomBytes } from "node:crypto";
import fc from "fast-check";
import { z } from "zod";
import { canonicalJson } from "../src/server/a2h.js";
import {
  CeremonyDatabase,
  PrivateCredentialBroker,
} from "../src/server/storage.js";
import { CeremonyEnvironment } from "../src/server/environment.js";
import { resolveCeremonyMethod } from "../src/core/resolution.js";
import { defaultTemplate, validateInput } from "../src/core/schema.js";
import { validateTemplate } from "../src/react/templates.js";
import { manifests } from "../examples/manifests.js";
import { jiraOwnerPage } from "../src/server/jira-human.js";

const options = {
  seed: Number(process.env.FUZZ_SEED ?? 20260909),
  numRuns: Number(process.env.FUZZ_RUNS ?? 1000),
};
assert.ok(Number.isSafeInteger(options.seed), "FUZZ_SEED must be an integer");
assert.ok(
  Number.isSafeInteger(options.numRuns) && options.numRuns > 0,
  "FUZZ_RUNS must be a positive integer",
);
test("fuzz: quoted template text cannot introduce executable OpenUI components", () => {
  fc.assert(
    fc.property(fc.string({ maxLength: 2000 }), (text) => {
      const template = defaultTemplate("basic");
      template.screens.intro = `root = Stack([Title(${JSON.stringify(text)}), Details(), Access(), Actions(), Notice()])`;
      assert.deepEqual(validateTemplate(template).errors, []);
    }),
    { ...options, numRuns: Math.min(options.numRuns, 500) },
  );
});
test("fuzz: canonical JSON round trips and ignores object insertion order", () => {
  fc.assert(
    fc.property(fc.jsonValue(), (input) => {
      const value = z.json().parse(input);
      // JSON normalizes negative zero; compare JSON semantics, not JS identity.
      assert.deepEqual(
        JSON.parse(canonicalJson(value)),
        JSON.parse(JSON.stringify(value)),
      );
      if (value && typeof value === "object" && !Array.isArray(value))
        assert.equal(
          canonicalJson(value),
          canonicalJson(Object.fromEntries(Object.entries(value).reverse())),
        );
    }),
    options,
  );
});
test("fuzz: input validation preserves accepted strings and rejects unknown fields", () => {
  fc.assert(
    fc.property(
      fc.string({ maxLength: 5000 }),
      fc.boolean(),
      (value, required) => {
        const fields = [
          { name: "value", label: "Value", type: "text" as const, required },
        ];
        if (value.length > 4096 || (required && !value.trim()))
          assert.throws(() => validateInput(fields, { value }));
        else assert.deepEqual(validateInput(fields, { value }), { value });
        assert.throws(() => validateInput(fields, { value, unknown: "x" }));
      },
    ),
    options,
  );
});
test("fuzz: method resolution never selects unavailable or under-scoped methods", () => {
  const manifest = manifests[0]!;
  fc.assert(
    fc.property(
      fc.array(fc.constantFrom("available", "configured", "unavailable"), {
        minLength: manifest.methods.length,
        maxLength: manifest.methods.length,
      }),
      fc.constantFrom("browser", "headless"),
      fc.subarray(["read:user", "repo", "admin"]),
      (states, surface, requiredScopes) => {
        const eligible = manifest.methods.filter(
          (method, index) =>
            states[index] !== "unavailable" &&
            requiredScopes.every((scope) => method.scopes.includes(scope)),
        );
        const choose = () =>
          resolveCeremonyMethod(
            manifest,
            { surface, requiredScopes },
            (method) => states[manifest.methods.indexOf(method)]!,
          );
        if (!eligible.length) assert.throws(choose, /No available/);
        else assert.ok(eligible.includes(choose()));
      },
    ),
    options,
  );
});
test("fuzz: credential references isolate arbitrary principals and are single-use", (t) => {
  const db = new CeremonyDatabase(":memory:", randomBytes(32));
  t.after(() => db.close());
  const broker = new PrivateCredentialBroker(db);
  fc.assert(
    fc.property(
      fc.string(),
      fc.string(),
      fc.nat({ max: 10000 }),
      (owner, secret, revision) => {
        const ref = broker.collect(owner, "run", revision, { token: secret });
        assert.throws(() => broker.consume(`${owner}!`, "run", revision, ref));
        assert.throws(() => broker.consume(owner, "other", revision, ref));
        assert.throws(() => broker.consume(owner, "run", revision + 1, ref));
        assert.deepEqual(broker.consume(owner, "run", revision, ref), {
          token: secret,
        });
        assert.throws(() => broker.consume(owner, "run", revision, ref));
      },
    ),
    options,
  );
});
test("fuzz: session environment edit sequences match a plain model", (t) => {
  const db = new CeremonyDatabase(":memory:", randomBytes(32));
  t.after(() => db.close());
  const env = new CeremonyEnvironment(db);
  let run = 0;
  fc.assert(
    fc.property(
      fc.array(
        fc.record({
          name: fc.constantFrom("TOKEN", "API_KEY", "OTHER"),
          value: fc.string({ maxLength: 50 }),
          remove: fc.boolean(),
        }),
        { maxLength: 30 },
      ),
      (edits) => {
        const owner = `owner-${run++}`;
        const model: Record<string, string> = {};
        let revision = 0;
        for (const edit of edits) {
          if (edit.remove) delete model[edit.name];
          else model[edit.name] = edit.value;
          const result = env.update(owner, {
            revision,
            ...(edit.remove
              ? { remove: [edit.name] }
              : { values: { [edit.name]: edit.value } }),
          });
          assert.equal(result.revision, ++revision);
          assert.deepEqual(env.read(owner), model);
          assert.deepEqual(env.read("unrelated"), {});
          assert.throws(() =>
            env.update(owner, {
              revision: revision - 1,
              values: { OTHER: "stale" },
            }),
          );
          assert.deepEqual(env.read(owner), model);
        }
      },
    ),
    { ...options, numRuns: Math.min(options.numRuns, 200) },
  );
});

test("fuzz: jira owner HTML keeps one collector script after hostile site fields", async () => {
  await fc.assert(
    fc.asyncProperty(
      fc.string({ maxLength: 200 }),
      fc.array(fc.string({ maxLength: 32 }), { minLength: 1, maxLength: 3 }),
      async (injected, scopes) => {
        const html = await jiraOwnerPage(
          {
            id: "11111111-1111-4111-8111-111111111111",
            revision: 1,
            state: "pending",
            siteUrl: injected,
            callbackUrl: `https://app.example/${encodeURIComponent(injected)}`,
            scopes,
          },
          "https://app.example/?connector=jira",
        ).text();
        assert.equal([...html.matchAll(/<script/gi)].length, 1);
      },
    ),
    { ...options, numRuns: Math.min(options.numRuns, 200) },
  );
});
