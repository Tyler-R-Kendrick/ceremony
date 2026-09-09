import assert from "node:assert/strict";
import { test } from "node:test";
import fc from "fast-check";
import {
  createConnectionTools,
  type ConnectionState,
} from "../src/core/connection-tools.js";

const state: ConnectionState = {
  id: "run:fixture",
  revision: 1,
  provider: "github",
  profile: "github-app",
  status: "active",
  nodes: [
    {
      id: "app",
      operationId: "github.prepare-app",
      operationVersion: "1.0.0",
      state: "awaiting-human",
      verified: false,
    },
  ],
};
test("AC-15 protected connection definitions execute identically without a native browser", async () => {
  const calls: string[] = [];
  const tools = createConnectionTools("fixture", {
    connect: async () => {
      calls.push("connect");
      return state;
    },
    snapshot: async () => {
      calls.push("snapshot");
      return state;
    },
    advance: async (node, revision, command) => {
      assert.deepEqual([node, revision, command], ["app", 1, "command:first"]);
      calls.push("advance");
      return state;
    },
    cancel: async (revision) => {
      assert.equal(revision, 1);
      calls.push("cancel");
      return { ...state, status: "cancelled" };
    },
  });
  for (const [index, input] of [
    {},
    {},
    { nodeId: "app", revision: 1, commandId: "command:first" },
    { revision: 1 },
  ].entries()) {
    const result = await tools[index]!.execute(input);
    assert.equal(
      typeof result === "object" &&
        result !== null &&
        Reflect.get(result, "ok"),
      true,
    );
  }
  assert.deepEqual(calls, ["connect", "snapshot", "advance", "cancel"]);
  assert.equal(tools[1]!.annotations!.readOnlyHint, true);
  assert.equal(tools[2]!.annotations!.readOnlyHint, false);
});
test("AC-16 AC-21 alternate tool inputs and provider extras fail closed without reflecting values", async () => {
  let effects = 0;
  const transport = {
    snapshot: async () => {
      effects++;
      return state;
    },
    advance: async () => {
      effects++;
      return state;
    },
    cancel: async () => {
      effects++;
      return state;
    },
  };
  const tools = createConnectionTools("fixture", transport);
  await fc.assert(
    fc.asyncProperty(fc.string(), async (value) => {
      for (const input of [
        { secretRef: value },
        { values: { password: value } },
        { source: "ui", token: value },
        { _meta: { value } },
      ]) {
        assert.deepEqual(await tools[2]!.execute(input), {
          ok: false,
          error: "denied-or-unavailable",
        });
      }
    }),
    { numRuns: 40 },
  );
  assert.equal(effects, 0);
  assert.deepEqual(await tools[0]!.execute({}), {
    ok: false,
    error: "denied-or-unavailable",
  });
  const unsafe = createConnectionTools("fixture", {
    ...transport,
    snapshot: async () => ({ ...state, userCode: "synthetic-private-code" }),
  });
  assert.deepEqual(await unsafe[1]!.execute({}), {
    ok: false,
    error: "denied-or-unavailable",
  });
  const failed = createConnectionTools("fixture", {
    ...transport,
    snapshot: async () => {
      throw new Error("provider-private-body");
    },
  });
  assert.deepEqual(await failed[1]!.execute({}), {
    ok: false,
    error: "denied-or-unavailable",
  });
  for (const prefix of ["", "bad prefix", "x".repeat(101)])
    assert.throws(() => createConnectionTools(prefix, transport));
});
test("AC-07 abort fences tool invocation and late delivery", async () => {
  const abort = new AbortController();
  let effects = 0;
  const tools = createConnectionTools("fixture", {
    snapshot: async () => {
      effects++;
      abort.abort();
      return state;
    },
    advance: async () => state,
    cancel: async () => state,
  });
  assert.deepEqual(await tools[1]!.execute({}, { signal: abort.signal }), {
    ok: false,
    error: "denied-or-unavailable",
  });
  assert.equal(effects, 1);
  assert.deepEqual(await tools[1]!.execute({}, { signal: abort.signal }), {
    ok: false,
    error: "denied-or-unavailable",
  });
  assert.equal(effects, 1);
});
