import { z } from "zod";
import { PostgresCeremonyStore } from "../../src/server/persistence/index.js";
import { ProtectedCommandService } from "../../src/server/commands.js";
import { OperationRegistry } from "../../src/server/recipes/registry.js";
import type { ActorContext } from "../../src/core/operation-contracts.js";

export const crashActor: ActorContext = {
  tenantId: "crash-tenant",
  subjectId: "subject",
  sessionId: "session",
  actorKind: "human",
  capabilities: ["executor", "author"],
};
export function crashRegistry(provider: string, mode = "normal") {
  const registry = new OperationRegistry();
  registry.register({
    contract: {
      id: "provider-effect",
      version: "1.0.0",
      provider: "fixture",
      profile: "one-shot",
      inputs: {},
      outputs: {},
      effects: ["registration"],
      verifier: "fixture-proof",
      humanFallback: "reconcile",
    },
    inputSchema: z.strictObject({}),
    outputSchema: z.strictObject({}),
    classifications: {},
    fixtures: ["http-ledger"],
    handler: async (context) => {
      if (mode === "before-request") process.exit(71);
      const response = await fetch(`${provider}/effect`, {
        method: "POST",
        headers: {
          "idempotency-key": context.effectId,
          "x-fixture-mode": mode,
        },
      }).catch((error) => {
        if (mode === "after-request") process.exit(72);
        throw error;
      });
      if (!response.ok) throw new Error("Fixture unavailable");
      if (mode === "after-response") process.exit(73);
      return { state: "complete", outputs: {} };
    },
    verify: async (context) => {
      const response = await fetch(
        `${provider}/evidence/${encodeURIComponent(context.effectId)}`,
      );
      return response.ok;
    },
  });
  return registry;
}
if (process.env.CEREMONY_CRASH_WORKER) {
  const config = JSON.parse(process.env.CEREMONY_CRASH_WORKER);
  const store = new PostgresCeremonyStore(config.database, {
    current: "test",
    keys: { test: Buffer.from(config.key, "hex") },
  });
  const commands = new ProtectedCommandService(
    store,
    crashRegistry(config.provider, config.mode),
    async () => true,
  );
  await commands.advance(crashActor, config.runId, "node", 1, "crash-command");
  if (config.mode === "after-commit") process.exit(74);
  await store.close();
}
