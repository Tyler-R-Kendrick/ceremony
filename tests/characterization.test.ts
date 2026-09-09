import { test } from "node:test";
import {
  actionsFor,
  defaultTemplate,
  flowKinds,
  steps,
} from "../src/core/schema.js";
import { registerCeremonyTools, toolState } from "../src/core/webmcp.js";
import { manifests } from "../examples/manifests.js";

test("characterization: every flow template and state action", (t) => {
  t.assert.snapshot(flowKinds.map(defaultTemplate));
  t.assert.snapshot(
    steps.map((step) => ({
      step,
      authenticated: actionsFor(step),
      anonymous: actionsFor(step, true),
    })),
  );
});

test("characterization: agent tool contracts exclude execution functions and secrets", async (t) => {
  const tools: unknown[] = [];
  const manifest = manifests[0]!;
  await registerCeremonyTools(
    {
      registerTool: async ({ execute: _execute, ...tool }) => {
        tools.push(tool);
      },
    },
    "github",
    manifest,
    async () => undefined,
    new AbortController().signal,
  );
  t.assert.snapshot(tools);
  t.assert.snapshot(toolState(manifest));
});
