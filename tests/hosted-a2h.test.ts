import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { test } from "node:test";
import { exportJWK, generateKeyPair } from "jose";
import { awaitStarted } from "./fixtures/await-started.js";
import {
  PersistenceConflict,
  SQLiteCeremonyStore,
} from "../src/server/persistence/index.js";
import {
  hostedJiraOwnerDelivery,
  postgresA2HRecords,
} from "../src/server/hosted/a2h.js";

test("hosted A2H rejects a superseded worker write before it changes the delivery record", async (t) => {
  const store = new SQLiteCeremonyStore(":memory:", {
    current: "test",
    keys: { test: randomBytes(32) },
  });
  t.after(() => store.close());
  const records = postgresA2HRecords(store, "tenant");
  await assert.rejects(
    records.put("unleased", { state: "waiting" }),
    PersistenceConflict,
  );
  const key = { tenant: "tenant", kind: "handoff" as const, id: "a2h:attempt" };
  const ready = Promise.withResolvers<void>();
  const resume = Promise.withResolvers<void>();
  let writeError: unknown;
  const stale = records
    .lock("attempt", async () => {
      await records.put("attempt", { state: "waiting" });
      ready.resolve();
      await resume.promise;
      try {
        await records.put("attempt", { state: "waiting" });
      } catch (error) {
        writeError = error;
      }
    })
    .catch((error: unknown) => error);
  try {
    await awaitStarted(ready.promise, stale);
  } catch (error) {
    resume.resolve();
    await stale;
    throw error;
  }
  // Supersede the old lease without timing-dependent sleeps.
  await store.transaction((tx) => tx.cancel(key));
  const replacementReady = Promise.withResolvers<void>();
  const finishReplacement = Promise.withResolvers<void>();
  const replacement = records.lock("attempt", async () => {
    await records.put("attempt", { state: "denied" });
    replacementReady.resolve();
    await finishReplacement.promise;
    await records.put("attempt", { state: "denied" });
  });
  try {
    await awaitStarted(replacementReady.promise, replacement);
    resume.resolve();
    const staleResult = await stale;
    const afterStaleWrite = await store.transaction((tx) => tx.get(key));
    finishReplacement.resolve();
    await replacement;
    assert.ok(
      staleResult instanceof PersistenceConflict,
      "final release rejects the old fence",
    );
    assert.ok(
      writeError instanceof PersistenceConflict,
      "the write itself must reject, not only final release",
    );
    assert.deepEqual(afterStaleWrite?.value, {
      state: "denied",
    });
  } finally {
    resume.resolve();
    finishReplacement.resolve();
    await Promise.allSettled([stale, replacement]);
  }
});

test("hosted A2H owner delivery is optional, complete, and persists through the async store", async (t) => {
  const store = new SQLiteCeremonyStore(":memory:", {
    current: "test",
    keys: { test: randomBytes(32) },
  });
  assert.equal(
    await hostedJiraOwnerDelivery({}, store, "https://app.example", "tenant", [
      "read:jira-user",
    ]),
    undefined,
  );
  await assert.rejects(
    hostedJiraOwnerDelivery(
      { CEREMONY_A2H_GATEWAY_ORIGIN: "https://gateway.example" },
      store,
      "https://app.example",
      "tenant",
      ["read:jira-user"],
    ),
    /Incomplete hosted A2H/,
  );
  const agentKey = await generateKeyPair("EdDSA", { extractable: true });
  const gateway = await generateKeyPair("EdDSA", { extractable: true });
  const intents: Record<string, unknown>[] = [];
  const env = {
    CEREMONY_A2H_GATEWAY_ORIGIN: "https://gateway.example",
    CEREMONY_A2H_AGENT_ID: "did:web:ceremony.example",
    CEREMONY_A2H_KEY_ID: "agent",
    CEREMONY_A2H_PRIVATE_JWK: JSON.stringify(
      await exportJWK(agentKey.privateKey),
    ),
    CEREMONY_A2H_GATEWAY_JWK: JSON.stringify(
      await exportJWK(gateway.publicKey),
    ),
    CEREMONY_A2H_API_KEY: "synthetic",
    CEREMONY_A2H_RECIPIENTS: JSON.stringify({
      owner: {
        principalId: "principal-owner",
        type: "email",
        address: "mailto:owner@example.test",
      },
    }),
  };
  const makeDelivery = (records: SQLiteCeremonyStore) =>
    hostedJiraOwnerDelivery(
      env,
      records,
      "https://app.example",
      "tenant",
      ["read:jira-user"],
      async (input, init) => {
        if (String(input).endsWith("/.well-known/a2h"))
          return Response.json({
            a2h_supported: ["1.0"],
            channels: ["email"],
            max_ttl_sec: 600,
            auth: { methods: ["api_key"] },
          });
        const body = JSON.parse(String(init?.body));
        intents.push(body);
        return Response.json({ interaction_id: body.interaction_id });
      },
    );
  const deliver = await makeDelivery(store);
  assert.equal(typeof deliver, "function");
  const run = {
    id: randomUUID(),
    provider: "jira",
    profile: "jira-3lo",
    target: "https://fixture.atlassian.net",
    origin: "https://app.example",
    environment: "production",
    configurationVersion: "v1",
    subjectId: "requester",
    sessionId: "session",
    status: "active" as const,
    nodes: [],
    inputs: {},
  };
  const assignmentId = randomUUID();
  await deliver!({
    owner: "owner",
    tenantId: "tenant",
    assignmentId,
    run,
  });
  assert.equal(intents.length, 1);
  await deliver!({ owner: "owner", tenantId: "tenant", assignmentId, run });
  assert.equal(
    intents.length,
    1,
    "retrying one assignment does not notify twice",
  );
  const renewedId = randomUUID();
  await deliver!({
    owner: "owner",
    tenantId: "tenant",
    assignmentId: renewedId,
    run,
  });
  assert.equal(
    intents.length,
    2,
    "a renewed assignment on the same run gets its own notification",
  );
  assert.notEqual(intents[0]!.message_id, intents[1]!.message_id);
  assert.notEqual(intents[0]!.interaction_id, intents[1]!.interaction_id);
  assert.ok(
    JSON.stringify(intents[0]).includes(`/owner-setup/${assignmentId}`),
  );
  assert.ok(JSON.stringify(intents[1]).includes(`/owner-setup/${renewedId}`));
  const deliveryRecords = await store.transaction((tx) =>
    tx.list<{ instanceId: string }>("tenant", "handoff"),
  );
  assert.equal(deliveryRecords.length, 2);
  assert.ok(
    deliveryRecords.every((record) => record.value.instanceId === run.id),
    "the signed effect and stored instance remain bound to the real run",
  );
  assert.equal(
    JSON.stringify(intents).includes(run.id),
    false,
    "public intents contain only the effect digest",
  );
  await deliver!({
    owner: "owner",
    tenantId: "tenant",
    assignmentId: renewedId,
    run,
  });
  assert.equal(intents.length, 2);
  const parallelAssignments = [randomUUID(), randomUUID()];
  await Promise.allSettled(
    parallelAssignments.map((assignmentId) =>
      deliver!({ owner: "owner", tenantId: "tenant", assignmentId, run }),
    ),
  );
  for (const assignmentId of parallelAssignments)
    await deliver!({ owner: "owner", tenantId: "tenant", assignmentId, run });
  assert.equal(
    intents.length,
    4,
    "concurrent assignment scopes remain independent and retryable",
  );
  await assert.rejects(
    deliver!({
      owner: "owner",
      tenantId: "other-tenant",
      assignmentId: randomUUID(),
      run,
    }),
    /tenant mismatch/,
  );
  const firstRecord = (
    await store.transaction((tx) =>
      tx.list<Record<string, unknown>>("tenant", "handoff"),
    )
  ).find(
    (record) =>
      (record.value.message as Record<string, unknown>).message_id ===
      intents[0]!.message_id,
  )!;
  for (const state of ["pending", "waiting", "denied"] as const) {
    const legacyStore = new SQLiteCeremonyStore(":memory:", {
      current: "test",
      keys: { test: randomBytes(32) },
    });
    t.after(() => legacyStore.close());
    const legacyKey = {
      tenant: "tenant",
      kind: "handoff" as const,
      id: `a2h:a2h-ceremony:${run.id}`,
    };
    await legacyStore.transaction((tx) =>
      tx.put(legacyKey, { ...firstRecord.value, state }, null),
    );
    const upgraded = (await makeDelivery(legacyStore))!;
    const priorDeliveries: number = intents.length;
    const retry = () =>
      upgraded({ owner: "owner", tenantId: "tenant", assignmentId, run });
    await postgresA2HRecords(legacyStore, "tenant").lock(
      `a2h-ceremony:${run.id}`,
      async () => {
        await assert.rejects(retry, PersistenceConflict);
      },
    );
    if (state === "denied") await assert.rejects(retry, /no longer pending/);
    else {
      await retry();
      if (state === "pending")
        assert.deepEqual(
          intents[priorDeliveries],
          intents[0],
          "uncertain legacy delivery must reuse the exact signed message",
        );
      await retry();
    }
    assert.equal(
      intents.length,
      priorDeliveries + (state === "pending" ? 1 : 0),
      "legacy waiting and declined requests must not create another notification",
    );
    await assert.rejects(
      upgraded({
        owner: "owner",
        tenantId: "tenant",
        assignmentId,
        run: { ...run, configurationVersion: "changed" },
      }),
      /context changed/,
    );
    const preserved = (await legacyStore.transaction((tx) =>
      tx.get<Record<string, unknown>>(legacyKey),
    ))!;
    assert.equal(
      (preserved.value.message as Record<string, unknown>).message_id,
      intents[0]!.message_id,
    );
    assert.equal(
      (await legacyStore.transaction((tx) => tx.list("tenant", "handoff")))
        .length,
      1,
      "same-assignment upgrade keeps the legacy record in place",
    );
  }
  await store.close();
});
