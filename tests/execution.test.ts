import { test } from "node:test";
import assert from "node:assert/strict";
import {
  executeCeremonyAction,
  type ActionEvent,
  type ActionFailureEvent,
} from "../src/core/index.js";
import { manifests } from "../examples/manifests.js";

test("execution hooks classify results once, exclude secrets, and cannot alter execution", async () => {
  const snapshot = {
    id: "instance",
    revision: 1,
    connectorId: "github",
    connectorName: "GitHub",
    description: "",
    method: manifests[0]!.methods.find((method) => method.kind === "api-key")!,
    step: "input" as const,
    fields: [],
    actions: [],
    expiresAt: Date.now() + 10000,
    authorizationUrl: "https://example.test/?state=private",
    message: "private-provider-message",
  };
  const successes: ActionEvent[] = [];
  const failures: ActionFailureEvent[] = [];
  const hooks = {
    onActionSuccess(event: ActionEvent) {
      successes.push(event);
      throw new Error("observer failed");
    },
    async onActionFailure(event: ActionFailureEvent) {
      failures.push(event);
      throw new Error("observer rejected");
    },
  };
  const context = {
    action: "submit" as const,
    source: "webmcp" as const,
    connectorId: "github",
    values: { token: "private-input" },
  };
  assert.equal(
    await executeCeremonyAction(context, async () => snapshot, hooks),
    snapshot,
  );
  await executeCeremonyAction(
    context,
    async () => ({ ...snapshot, step: "error" }),
    hooks,
  );
  await executeCeremonyAction(
    context,
    async () => ({ ...snapshot, step: "expired" }),
    hooks,
  );
  await assert.rejects(
    executeCeremonyAction(
      context,
      async () => {
        throw new Error("private-secret");
      },
      hooks,
    ),
    /private-secret/,
  );
  assert.equal(successes.length, 1);
  assert.deepEqual(
    failures.map((event) => event.reason),
    ["ceremony_failed", "expired", "execution_failed"],
  );
  const events = [...successes, ...failures];
  assert.equal(new Set(events.map((event) => event.executionId)).size, 4);
  assert.ok(events.every((event) => event.finishedAt >= event.startedAt));
  assert.ok(!JSON.stringify(events).includes("private"));
  assert.ok(!JSON.stringify(events).includes("values"));
});
