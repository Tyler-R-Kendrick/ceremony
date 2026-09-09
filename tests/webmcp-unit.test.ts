import assert from "node:assert/strict";
import { test } from "node:test";
import {
  registerCeremonyTools,
  toolState,
  browserModelContext,
  type CeremonyTool,
} from "../src/core/webmcp.js";
import { actionNames, type CeremonySnapshot } from "../src/core/schema.js";
import { manifests } from "../examples/manifests.js";

test("atomic: WebMCP registration rejects invalid prefixes and stops when unmounted", async () => {
  assert.equal(browserModelContext(), undefined);
  const abort = new AbortController();
  const tools: CeremonyTool[] = [];
  const context = {
    registerTool: async (tool: CeremonyTool) => {
      tools.push(tool);
      abort.abort();
    },
  };
  await assert.rejects(
    registerCeremonyTools(
      context,
      "bad prefix",
      manifests[0]!,
      async () => undefined,
      abort.signal,
    ),
  );
  await registerCeremonyTools(
    context,
    "valid",
    manifests[0]!,
    async () => undefined,
    abort.signal,
  );
  assert.equal(tools.length, 1);
  assert.deepEqual(
    await tools[0]!.execute({}, { signal: new AbortController().signal }),
    {
      ok: false,
      error:
        "Action could not execute. Read the ceremony state before retrying.",
    },
  );
});
test("behavior: registered tools execute declared actions and reject secret or unexpected arguments", async () => {
  const manifest = manifests[1]!;
  const tools = new Map<string, CeremonyTool>();
  const calls: string[] = [];
  const signal = new AbortController().signal;
  await registerCeremonyTools(
    {
      registerTool: async (tool) => {
        tools.set(tool.name, tool);
      },
    },
    "test",
    manifest,
    async (command) => {
      calls.push(command.action);
      return undefined;
    },
    signal,
  );
  for (const action of [
    "start",
    "read",
    ...actionNames,
    "navigate",
    "request-input",
  ]) {
    const tool = tools.get(`test_${action}`)!;
    assert.ok(tool);
    for (const input of [
      null,
      [],
      "bad",
      { action: "read" },
      { unknown: "value" },
      { values: { token: "synthetic-secret" } },
    ]) {
      const before = calls.length;
      const result = await tool.execute(input, { signal });
      assert.equal(calls.length, before);
      assert.doesNotMatch(JSON.stringify(result), /synthetic-secret/);
      assert.equal(Reflect.get(Object(result), "ok"), false);
    }
    await tool.execute({}, { signal });
    assert.equal(calls.at(-1), action);
  }
});
test("atomic: tool projection includes actionable navigation but never URLs or connection references", () => {
  const manifest = manifests[1]!;
  const base: CeremonySnapshot = {
    id: "run",
    revision: 1,
    connectorId: manifest.id,
    connectorName: manifest.name,
    description: "",
    method: manifest.methods[0]!,
    step: "input",
    fields: manifest.methods[0]!.fields,
    actions: ["submit"],
    expiresAt: 1,
    outcome: {
      connectionRef: "private-handle",
      ownership: "anonymous",
      scopes: ["read"],
    },
  };
  assert.ok(toolState(manifest, base).actions.includes("request-input"));
  for (const step of ["redirect", "waiting"] as const) {
    const result = toolState(manifest, {
      ...base,
      step,
      authorizationUrl: "https://provider.example/secret",
      verificationUri: "https://provider.example/secret",
      userCode: "ABCD",
      prerequisites: [{ id: "app", label: "App", status: "blocked" }],
    });
    assert.ok(result.actions.includes("navigate"));
    assert.doesNotMatch(JSON.stringify(result), /private-handle|https:/);
  }
});
