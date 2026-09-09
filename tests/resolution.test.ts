import { test } from "node:test";
import assert from "node:assert/strict";
import { awaitStarted } from "./fixtures/await-started.js";
import {
  createCeremonyClient,
  resolveCeremonyMethod,
  type CeremonySnapshot,
  type CeremonyTransport,
} from "../src/core/index.js";
import {
  CeremonyController,
  type AuthAdapter,
} from "../src/server/controller.js";
import { manifests } from "../examples/manifests.js";
import { entryContextSchema } from "../src/core/resolution.js";

const manifest = manifests[0]!;
test("entry context accepts both supported surfaces and rejects undeclared surfaces", () => {
  assert.deepEqual(entryContextSchema.parse({}), {
    surface: "browser",
    requiredScopes: [],
  });
  for (const surface of ["browser", "headless"])
    assert.deepEqual(entryContextSchema.parse({ surface }), {
      surface,
      requiredScopes: [],
    });
  for (const surface of ["", "unknown", null, 0])
    assert.equal(entryContextSchema.safeParse({ surface }).success, false);
});
test("entry selection prefers browser OAuth, headless device, trusted configuration and required grants", () => {
  assert.equal(resolveCeremonyMethod(manifest).id, "oauth");
  assert.equal(
    resolveCeremonyMethod(manifest, { surface: "headless" }).id,
    "device",
  );
  assert.equal(
    resolveCeremonyMethod(manifest, {}, (method) =>
      method.id === "api-key" ? "configured" : "available",
    ).id,
    "api-key",
  );
  assert.equal(
    resolveCeremonyMethod(
      manifest,
      { requiredScopes: ["read:user"] },
      (method) => (method.id === "api-key" ? "configured" : "available"),
    ).id,
    "oauth",
  );
  assert.equal(
    resolveCeremonyMethod(manifest, {}, (method) =>
      method.id === "oauth" ? "unavailable" : "available",
    ).id,
    "device",
  );
  assert.throws(
    () => resolveCeremonyMethod(manifest, { requiredScopes: ["admin"] }),
    /No available/,
  );
  assert.throws(
    () => resolveCeremonyMethod(manifest, {}, () => "unavailable"),
    /No available/,
  );
});

test("server resolves by owner and reuses compatible attempts before choosing another method", async () => {
  const adapter: AuthAdapter = {
    begin: async () => ({
      step: "complete",
      outcome: {
        connectionRef: "verified-fixture",
        ownership: "authenticated",
        scopes: ["read:user"],
      },
    }),
    submit: async () => {
      throw Error("Unexpected");
    },
    callback: async () => {
      throw Error("Unexpected");
    },
    poll: async () => undefined,
    cancel() {},
  };
  const controller = new CeremonyController([
    {
      manifest,
      createAdapter: () => adapter,
      availability: (owner, method) =>
        owner === "blocked"
          ? "unavailable"
          : owner === "configured" && method.id === "api-key"
            ? "configured"
            : "available",
    },
  ]);
  const first = controller.connect("alice", manifest.id, {
    surface: "headless",
  });
  assert.equal(first.method.id, "device");
  assert.equal(
    controller.connect("alice", manifest.id, { surface: "browser" }).id,
    first.id,
  );
  assert.equal(controller.connect("bob", manifest.id).method.id, "oauth");
  assert.equal(
    controller.connect("configured", manifest.id).method.id,
    "api-key",
  );
  await controller.act("alice", first.id, {
    action: "cancel",
    revision: first.revision,
  });
  assert.equal(controller.connect("alice", manifest.id).method.id, "oauth");
  controller.start("ready", manifest.id, "oauth");
  const ready = controller.start("ready", manifest.id, "device");
  await controller.act("ready", ready.id, {
    action: "begin",
    revision: ready.revision,
  });
  assert.equal(controller.connect("ready", manifest.id).id, ready.id);
  assert.equal(controller.connect("ready", manifest.id).step, "complete");
  assert.throws(
    () => controller.connect("blocked", manifest.id),
    /No available/,
  );
  assert.throws(
    () => controller.start("blocked", manifest.id, "oauth"),
    /unavailable/,
  );
});

test("manifest-only client entry advances preparation with hooks and delegates only when opted in", async () => {
  let snapshot: CeremonySnapshot = {
    id: "entry",
    connectorId: manifest.id,
    connectorName: manifest.name,
    description: manifest.description,
    method: manifest.methods[0]!,
    revision: 0,
    step: "intro",
    fields: [],
    actions: ["begin", "cancel"],
    expiresAt: Date.now() + 60000,
  };
  const calls: string[] = [];
  const transport: CeremonyTransport = {
    connect: async (id, context) => {
      assert.equal(id, "github");
      assert.equal(context.surface, "browser");
      calls.push("resolve");
      return snapshot;
    },
    start: async () => {
      throw Error("Manual selection was not requested");
    },
    read: async () => snapshot,
    act: async (_id, action) => {
      calls.push(action.action);
      if (action.action === "request-human") throw Error("Agent unavailable");
      snapshot = {
        ...snapshot,
        revision: 1,
        step: "redirect",
        authorizationUrl: "https://provider.example/auth",
        actions: ["request-human", "cancel"],
      };
      return snapshot;
    },
  };
  const hooks: string[] = [];
  const client = createCeremonyClient({
    manifest,
    transport,
    context: { surface: "browser" },
    delegation: "agent",
    onActionSuccess: (event) => {
      hooks.push(event.action);
    },
    onActionFailure: (event) => {
      hooks.push(`failed:${event.action}`);
    },
  });
  await client.initialize();
  assert.deepEqual(calls, ["resolve", "begin", "request-human"]);
  assert.deepEqual(hooks, ["begin", "failed:request-human", "start"]);
  assert.equal(client.getState().snapshot?.step, "redirect");
  assert.match(client.getState().error, /Continue using the provider link/);
  client.dispose();
  calls.length = 0;
  const human = createCeremonyClient({
    manifest,
    transport,
    context: { surface: "browser" },
  });
  await human.initialize();
  assert.deepEqual(calls, ["resolve"]);
  human.dispose();
  calls.length = 0;
  const pending = Promise.withResolvers<CeremonySnapshot>();
  const started = Promise.withResolvers<void>();
  const abort = new AbortController();
  const cancelled = createCeremonyClient({
    manifest,
    delegation: "agent",
    transport: {
      ...transport,
      connect: async () => {
        started.resolve();
        return pending.promise;
      },
    },
  });
  const execution = cancelled.execute(
    { action: "start" },
    "webmcp",
    abort.signal,
  );
  try {
    await awaitStarted(started.promise, execution);
  } catch (error) {
    pending.resolve(snapshot);
    cancelled.dispose();
    await execution.catch(() => undefined);
    throw error;
  }
  abort.abort();
  pending.resolve(snapshot);
  await assert.rejects(execution, /abort/i);
  assert.deepEqual(calls, []);
  assert.equal(cancelled.getState().snapshot, undefined);
  cancelled.dispose();
});
