import assert from "node:assert/strict";
import { test } from "node:test";
import { randomBytes } from "node:crypto";
import { z } from "zod";
import {
  fieldSchema,
  methodSchema,
  validateInput,
  type Field,
} from "../src/core/schema.js";
import { resolveCeremonyMethod } from "../src/core/resolution.js";
import { CeremonyDatabase } from "../src/server/storage.js";
import { manifests } from "../examples/manifests.js";

const text: Field = {
  name: "value",
  label: "Value",
  type: "text",
  required: true,
};
for (const [name, value, valid] of [
  ["empty", "", false],
  ["whitespace", " \t", false],
  ["one character", "a", true],
  ["maximum", "a".repeat(4096), true],
  ["over maximum", "a".repeat(4097), false],
] as const)
  test(`atomic: required input ${name}`, () => {
    if (valid) assert.deepEqual(validateInput([text], { value }), { value });
    else assert.throws(() => validateInput([text], { value }));
  });
test("atomic: optional absent input becomes empty, inherited values are not accepted", () => {
  assert.deepEqual(validateInput([{ ...text, required: false }], {}), {
    value: "",
  });
  assert.throws(() =>
    validateInput([text], Object.create({ value: "inherited" })),
  );
});
test("atomic: email validation is independent of requiredness", () => {
  assert.throws(() =>
    validateInput([{ ...text, type: "email", required: false }], {
      value: "invalid",
    }),
  );
  assert.deepEqual(
    validateInput([{ ...text, type: "email" }], {
      value: "alice@example.test",
    }),
    { value: "alice@example.test" },
  );
});
for (const name of ["A", "1a", "a-b", "a".repeat(65)])
  test(`atomic: invalid field identifier ${name.slice(0, 12)}`, () => {
    assert.equal(fieldSchema.safeParse({ ...text, name }).success, false);
  });
test("atomic: form fields are nonempty and unique", () => {
  const method = {
    id: "form",
    label: "Form",
    kind: "form",
    fields: [text],
    scopes: [],
    templateId: "form",
  };
  assert.equal(methodSchema.safeParse(method).success, true);
  assert.equal(
    methodSchema.safeParse({ ...method, fields: [] }).success,
    false,
  );
  assert.equal(
    methodSchema.safeParse({ ...method, fields: [text, text] }).success,
    false,
  );
});
test("atomic: equal-ranked methods preserve manifest order", () => {
  const original = manifests[0]!;
  const method = original.methods[0]!;
  const manifest = {
    ...original,
    methods: [
      { ...method, id: "first" },
      { ...method, id: "second" },
    ],
  };
  assert.equal(resolveCeremonyMethod(manifest).id, "first");
  assert.equal(
    resolveCeremonyMethod({
      ...manifest,
      methods: [...manifest.methods].reverse(),
    }).id,
    "second",
  );
});
test("atomic: nested transaction rollback preserves the outer transaction", (t) => {
  const db = new CeremonyDatabase(":memory:", randomBytes(32));
  t.after(() => db.close());
  db.transaction(() => {
    db.put("outer", 1);
    assert.throws(() =>
      db.transaction(() => {
        db.put("inner", 2);
        throw Error("rollback");
      }),
    );
    assert.equal(db.get("inner", z.number()), undefined);
  });
  assert.equal(db.get("outer", z.number()), 1);
  assert.throws(() =>
    db.transaction(() => {
      db.put("outer", 3);
      throw Error("rollback");
    }),
  );
  assert.equal(db.get("outer", z.number()), 1);
});
