import assert from "node:assert/strict";
import { test } from "node:test";
import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import {
  defaultTemplate,
  fieldsFor,
  flowKinds,
  manifestSchema,
  methodSchema,
  snapshotSchema,
  steps,
  templateSchema,
  type AuthMethod,
} from "../src/core/schema.js";
import {
  executeCeremonyAction,
  type ActionEvent,
} from "../src/core/execution.js";
import { resolveCeremonyMethod } from "../src/core/resolution.js";
import {
  CeremonyDatabase,
  PrivateCredentialBroker,
} from "../src/server/storage.js";
import { CeremonyEnvironment } from "../src/server/environment.js";
import { manifests } from "../examples/manifests.js";
import { githubAppManifest } from "../src/server/github.js";

const field = {
  name: "value",
  label: "Value",
  type: "text",
  required: true,
} as const;
const method = (kind: AuthMethod["kind"]) =>
  [...manifests, githubAppManifest]
    .flatMap((m) => m.methods)
    .find((m) => m.kind === kind)!;

test("atomic: every method pair follows browser/headless policy independent of manifest ordering", () => {
  for (const surface of ["browser", "headless"] as const) {
    const order =
      surface === "browser"
        ? ([
            "oauth-code",
            "github-app",
            "device",
            "authmd-anonymous",
            "api-key",
            "form",
            "basic",
          ] as const)
        : ([
            "device",
            "oauth-code",
            "github-app",
            "authmd-anonymous",
            "api-key",
            "form",
            "basic",
          ] as const);
    for (let i = 0; i < order.length; i++)
      for (let j = i + 1; j < order.length; j++) {
        const first = method(order[i]!);
        const second = method(order[j]!);
        for (const methods of [
          [first, second],
          [second, first],
        ])
          assert.equal(
            resolveCeremonyMethod({ ...manifests[0]!, methods }, { surface })
              .id,
            first.id,
          );
      }
  }
});

test("atomic: method validation returns actionable errors for invalid credential layouts", () => {
  const cases = [
    [{ ...method("basic"), fields: [] }, "basic requires username, password"],
    [
      { ...method("basic"), fields: [field, method("basic").fields[1]!] },
      "basic requires username, password",
    ],
    [
      { ...method("basic"), fields: [...method("basic").fields, field] },
      "basic requires username, password",
    ],
    [{ ...method("api-key"), fields: [] }, "api-key requires token"],
    [{ ...method("api-key"), fields: [field] }, "api-key requires token"],
    [{ ...method("form"), fields: [] }, "Form requires fields"],
    [{ ...method("form"), fields: [field, field] }, "Duplicate field names"],
    [
      { ...method("oauth-code"), fields: [field] },
      "This method does not collect credentials",
    ],
    [
      { ...method("authmd-anonymous"), claimFields: [field, field] },
      "Claim fields require anonymous auth and unique names",
    ],
    [
      { ...method("form"), claimFields: [] },
      "Claim fields require anonymous auth and unique names",
    ],
    [
      {
        ...method("api-key"),
        fields: [{ ...method("api-key").fields[0]!, type: "text" }],
      },
      "Credentials require masked inputs",
    ],
  ] as const;
  for (const [input, message] of cases) {
    const result = methodSchema.safeParse(input);
    assert.equal(result.success, false);
    if (!result.success)
      assert.deepEqual(result.error.issues, [
        { code: "custom", message, path: [] },
      ]);
  }
  assert.ok(
    methodSchema.safeParse({
      ...method("authmd-anonymous"),
      claimFields: [field, { ...field, name: "other" }],
    }).success,
  );
  const duplicate = manifestSchema.safeParse({
    ...manifests[0]!,
    methods: [method("basic"), method("basic")],
  });
  assert.equal(duplicate.success, false);
  if (!duplicate.success)
    assert.deepEqual(duplicate.error.issues, [
      { code: "custom", message: "Duplicate method IDs", path: [] },
    ]);
});

test("atomic: public identifiers reject invalid prefixes/suffixes and accept their exact length boundary", () => {
  for (const id of ["Avalid", "validA", "a".repeat(65), ""]) {
    assert.equal(
      methodSchema.safeParse({ ...method("basic"), id }).success,
      false,
    );
    assert.equal(
      methodSchema.safeParse({ ...method("basic"), templateId: id }).success,
      false,
    );
    assert.equal(
      manifestSchema.safeParse({ ...manifests[0]!, id }).success,
      false,
    );
    assert.equal(
      templateSchema.safeParse({ ...defaultTemplate("basic"), id }).success,
      false,
    );
  }
  assert.ok(
    methodSchema.safeParse({
      ...method("basic"),
      id: "a".repeat(64),
      templateId: "a".repeat(64),
    }).success,
  );
});

test("atomic: displayed navigation rejects credentials, fragments and non-HTTP loopback protocols", () => {
  const snapshot = {
    id: "run",
    revision: 1,
    connectorId: "test",
    connectorName: "Test",
    description: "",
    method: method("oauth-code"),
    step: "redirect",
    fields: [],
    actions: ["cancel"],
    expiresAt: 10000,
  };
  for (const authorizationUrl of [
    "https://user@example.test",
    "https://:password@example.test",
    "https://example.test/#fragment",
    "http://example.test",
    "ftp://localhost",
    "ftp://127.0.0.1",
    "ftp://[::1]",
  ]) {
    const result = snapshotSchema.safeParse({ ...snapshot, authorizationUrl });
    assert.equal(result.success, false, authorizationUrl);
    if (!result.success)
      assert.equal(result.error.issues[0]?.message, "Unsafe navigation URL");
  }
  for (const authorizationUrl of [
    "https://example.test/auth",
    "http://localhost/auth",
    "http://127.0.0.1/auth",
    "http://[::1]/auth",
  ])
    assert.ok(
      snapshotSchema.safeParse({ ...snapshot, authorizationUrl }).success,
    );
  for (const status of ["ready", "verifying"])
    assert.ok(
      snapshotSchema.safeParse({
        ...snapshot,
        prerequisites: [{ id: "app", label: "App", status }],
      }).success,
    );
});

test("atomic: fields appear only at input and claim, with a required default claim email", () => {
  for (const kind of flowKinds)
    for (const step of steps) {
      const current = { ...method(kind) };
      delete current.claimFields;
      assert.deepEqual(
        fieldsFor(step, current),
        step === "input"
          ? current.fields
          : step === "claim"
            ? [
                {
                  name: "email",
                  label: "Account email",
                  type: "email",
                  required: true,
                },
              ]
            : [],
      );
    }
});

test("atomic: action hooks retain context without a snapshot and prefer snapshot identity when present", async () => {
  const context = {
    action: "read",
    source: "system",
    connectorId: "test",
    methodId: "context-method",
    instanceId: "context-run",
  } as const;
  const events: ActionEvent[] = [];
  assert.equal(
    await executeCeremonyAction(context, async () => undefined, {
      onActionSuccess: (e) => {
        events.push(e);
      },
    }),
    undefined,
  );
  assert.equal(events[0]?.methodId, "context-method");
  assert.equal(events[0]?.instanceId, "context-run");
  const snapshot = snapshotSchema.parse({
    id: "snapshot-run",
    revision: 7,
    connectorId: "test",
    connectorName: "Test",
    description: "",
    method: method("basic"),
    step: "input",
    fields: [],
    actions: ["submit"],
    expiresAt: 10000,
  });
  await executeCeremonyAction(context, async () => snapshot, {
    onActionSuccess: (e) => {
      events.push(e);
    },
  });
  assert.equal(events[1]?.methodId, snapshot.method.id);
  assert.equal(events[1]?.instanceId, snapshot.id);
  assert.equal(events[1]?.revision, 7);
  assert.equal(events[1]?.step, "input");
});

test("atomic: environment count/byte limits are inclusive and failed edits leave the previous revision intact", (t) => {
  const db = new CeremonyDatabase(":memory:", randomBytes(32));
  t.after(() => db.close());
  const env = new CeremonyEnvironment(db);
  const hundred = Object.fromEntries(
    Array.from({ length: 100 }, (_, i) => [`K${i}`, "v"]),
  );
  assert.equal(
    env.update("count", { revision: 0, values: hundred }).names.length,
    100,
  );
  assert.throws(
    () => env.update("count", { revision: 1, values: { EXTRA: "v" } }),
    /100 variables or 64 KB/,
  );
  assert.equal(env.describe("count").revision, 1);
  const bytes = {
    A: "x".repeat(16000),
    B: "x".repeat(16000),
    C: "x".repeat(16000),
    D: "",
  };
  bytes.D = "x".repeat(64000 - Buffer.byteLength(JSON.stringify(bytes)));
  assert.equal(Buffer.byteLength(JSON.stringify(bytes)), 64000);
  env.update("bytes", { revision: 0, values: bytes });
  assert.throws(
    () => env.update("bytes", { revision: 1, values: { D: `${bytes.D}x` } }),
    /100 variables or 64 KB/,
  );
  assert.throws(
    () => env.update("invalid", { revision: 0, surprise: true }),
    /Invalid environment edit/,
  );
  assert.throws(
    () => env.update("invalid", { revision: 0, dotenv: "# no assignments" }),
    /No valid environment assignments/,
  );
  assert.deepEqual(
    env.update("sorted", { revision: 0, values: { Z: "v", A: "v" } }).names,
    ["A", "Z"],
  );
  for (const [owner, values] of [
    ["legacy-count", { ...hundred, EXTRA: "v" }],
    ["legacy-bytes", { ...bytes, D: `${bytes.D}x` }],
  ] as const) {
    db.put(`environment:${JSON.stringify([owner, "service"])}`, {
      revision: 0,
      values,
    });
    assert.throws(
      () => env.read(owner),
      /Legacy environment exceeds session limits/,
    );
  }
  db.put('environment:["migrate","first"]', { revision: 0, values: bytes });
  db.put('environment:["migrate","second"]', {
    revision: 0,
    values: { A: bytes.A },
  });
  assert.deepEqual(env.read("migrate"), bytes);
  db.put('environment:["migrate","third"]', {
    revision: 0,
    values: { LATE: "ignored" },
  });
  assert.deepEqual(env.read("migrate"), bytes);
});

test("atomic: vault permissions, delivery limits and private-reference expiry are enforced", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "ceremony-vault-boundary-"));
  const file = join(dir, "vault.sqlite");
  const db = new CeremonyDatabase(file, randomBytes(32));
  t.after(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });
  assert.equal(statSync(file).mode & 0o777, 0o600);
  assert.throws(
    () => new CeremonyDatabase(":memory:", randomBytes(31)),
    /32-byte vault key/,
  );
  const event = {
    eventId: "00000000-0000-4000-8000-000000000001",
    instanceId: "run",
    revision: 0,
    step: "complete",
    occurredAt: 1000,
    status: "success",
  };
  db.put("event:first", event);
  db.put("event:second", {
    ...event,
    eventId: "00000000-0000-4000-8000-000000000002",
  });
  assert.equal(await db.deliverEvents(async () => {}, 1), 1);
  assert.equal(db.keys("event:").length, 1);
  let now = 1000;
  t.mock.method(Date, "now", () => now);
  const broker = new PrivateCredentialBroker(db);
  const ref = broker.collect("owner", "run", 0, { token: "synthetic" });
  now += 300000;
  assert.throws(
    () => broker.consume("owner", "run", 0, ref),
    /Credential reference is unavailable or expired/,
  );
  db.transaction(() => db.put("first", 1));
  assert.throws(() =>
    db.transaction(() => {
      db.put("first", 2);
      throw Error("rollback");
    }),
  );
  assert.equal(db.get("first", z.number()), 1);
});
