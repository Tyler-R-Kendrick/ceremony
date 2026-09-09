import { test } from "node:test";
import assert from "node:assert/strict";
import {
  createCeremonyClient,
  type CeremonyTransport,
  type CeremonySnapshot,
} from "../src/core/index.js";
import { manifests } from "../examples/manifests.js";

const manifest = manifests[1]!;
const snapshot: CeremonySnapshot = {
  id: "external",
  revision: 0,
  connectorId: manifest.id,
  connectorName: manifest.name,
  description: manifest.description,
  method: manifest.methods[0]!,
  step: "input",
  fields: manifest.methods[0]!.fields,
  actions: ["submit", "cancel"],
  expiresAt: Date.now() + 60000,
};
test("headless clients are SSR safe, initialize once and isolate observers and instances", async () => {
  let starts = 0;
  const transport: CeremonyTransport = {
    async start() {
      starts++;
      return snapshot;
    },
    async read() {
      return snapshot;
    },
    async act(_id, action) {
      assert.deepEqual(action.values, { token: "private-test-token" });
      return {
        ...snapshot,
        revision: 1,
        step: "complete",
        fields: [],
        actions: [],
        outcome: {
          connectionRef: "opaque",
          ownership: "authenticated",
          scopes: [],
        },
      };
    },
  };
  const events: string[] = [];
  const client = createCeremonyClient({
    manifest,
    transport,
    onComplete() {
      throw new Error("host error");
    },
    onActionSuccess: (event) => {
      events.push(event.action);
    },
  });
  const other = createCeremonyClient({ manifest, transport });
  assert.equal(starts, 0);
  assert.equal(client.getServerState(), client.getState());
  const unsubscribe = client.subscribe(() => {
    throw new Error("observer error");
  });
  await Promise.all([client.initialize(), client.initialize()]);
  assert.equal(starts, 1);
  assert.equal(other.getState().snapshot, undefined);
  await client.execute({
    action: "submit",
    values: { token: "private-test-token" },
  });
  assert.equal(client.getState().snapshot?.step, "complete");
  assert.deepEqual(events, ["start", "submit"]);
  assert.ok(!JSON.stringify(client.getState()).includes("private-test-token"));
  unsubscribe();
  client.dispose();
  other.dispose();
  await assert.rejects(client.execute({ action: "read" }), /disposed/);
});
test("headless validation, pending read ordering and disposal preserve safety", async () => {
  const pending = Promise.withResolvers<CeremonySnapshot>();
  let submissions = 0;
  const transport: CeremonyTransport = {
    async start() {
      return snapshot;
    },
    read: () => pending.promise,
    async act() {
      submissions++;
      return {
        ...snapshot,
        revision: 1,
        step: "cancelled",
        actions: [],
        fields: [],
      };
    },
  };
  const client = createCeremonyClient({ manifest, transport });
  await client.initialize();
  const read = client.execute({ action: "read" });
  const cancel = client.execute({ action: "cancel" });
  assert.equal(submissions, 0);
  pending.resolve(snapshot);
  await read;
  await cancel;
  assert.equal(submissions, 1);
  client.dispose();
  const bad = createCeremonyClient({
    manifest,
    transport: {
      ...transport,
      async start() {
        return { ...snapshot, authorizationUrl: "javascript:alert(1)" };
      },
    },
  });
  await assert.rejects(bad.initialize());
  assert.equal(bad.getState().snapshot, undefined);
  bad.dispose();
});
