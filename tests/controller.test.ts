import { test } from "node:test";
import assert from "node:assert/strict";
import {
  CeremonyController,
  type AdapterUpdate,
  type AuthAdapter,
} from "../src/server/controller.js";
import { manifests } from "../examples/manifests.js";

test("controller serializes an instance and discards provider results after expiry", async () => {
  let now = Date.now();
  const pending = Promise.withResolvers<AdapterUpdate>();
  let cancelled = false;
  const adapter: AuthAdapter = {
    async begin() {
      return {
        step: "waiting",
        verificationUri: "https://provider.example/verify",
        userCode: "123456",
        expiresAt: now + 2000,
      };
    },
    async submit() {
      throw new Error("Unexpected submission");
    },
    async callback() {
      throw new Error("Unexpected callback");
    },
    poll: () => pending.promise,
    cancel() {
      cancelled = true;
    },
  };
  const controller = new CeremonyController(
    [{ manifest: manifests[0]!, createAdapter: () => adapter }],
    new Map(),
    () => now,
  );
  let snapshot = controller.start("alice", "github", "device");
  snapshot = await controller.act("alice", snapshot.id, {
    action: "begin",
    revision: snapshot.revision,
  });
  now += 1200;
  const polling = controller.read("alice", snapshot.id);
  await assert.rejects(
    controller.act("alice", snapshot.id, {
      action: "cancel",
      revision: snapshot.revision,
    }),
    /stale/,
  );
  now += 1200;
  assert.equal((await controller.read("alice", snapshot.id)).step, "expired");
  assert.equal(cancelled, true);
  pending.resolve({
    step: "complete",
    outcome: {
      connectionRef: "late-result",
      ownership: "authenticated",
      scopes: [],
    },
  });
  const result = await polling;
  assert.equal(result.step, "expired");
  assert.equal(result.outcome, undefined);
});

test("transient polling errors retain approval bindings and recover without disclosing provider errors", async () => {
  let now = Date.now();
  let polls = 0;
  const adapter: AuthAdapter = {
    async begin() {
      return {
        step: "waiting",
        verificationUri: "https://provider.example/verify",
        userCode: "123456",
      };
    },
    async submit() {
      throw new Error("Unexpected submission");
    },
    async callback() {
      throw new Error("Unexpected callback");
    },
    async poll() {
      if (++polls === 1) throw new Error("secret-provider-diagnostic");
      return {
        step: "complete",
        outcome: {
          connectionRef: "verified",
          ownership: "authenticated",
          scopes: ["read"],
        },
      };
    },
    cancel() {},
  };
  const controller = new CeremonyController(
    [
      {
        manifest: manifests[0]!,
        createAdapter: (context) => {
          assert.equal(context.owner, "alice");
          return adapter;
        },
      },
    ],
    new Map(),
    () => now,
  );
  let snapshot = controller.start("alice", "github", "device");
  snapshot = await controller.act("alice", snapshot.id, {
    action: "begin",
    revision: snapshot.revision,
  });
  now += 1200;
  snapshot = await controller.read("alice", snapshot.id);
  assert.equal(snapshot.step, "waiting");
  assert.equal(snapshot.userCode, "123456");
  assert.ok(!JSON.stringify(snapshot).includes("secret-provider-diagnostic"));
  now += 1200;
  assert.equal((await controller.read("alice", snapshot.id)).step, "complete");
});
