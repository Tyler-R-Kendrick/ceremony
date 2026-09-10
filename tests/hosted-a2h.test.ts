import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { test } from "node:test";
import { exportJWK, generateKeyPair } from "jose";
import { SQLiteCeremonyStore } from "../src/server/persistence/index.js";
import { hostedJiraOwnerDelivery } from "../src/server/hosted/a2h.js";

test("hosted A2H owner delivery is optional, complete, and persists through the async store", async () => {
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
  const intents: unknown[] = [];
  const deliver = await hostedJiraOwnerDelivery(
    {
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
    },
    store,
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
  await deliver!({
    owner: "owner",
    tenantId: "tenant",
    assignmentId: randomUUID(),
    run,
  });
  assert.equal(intents.length, 1);
  await assert.rejects(
    deliver!({
      owner: "owner",
      tenantId: "other-tenant",
      assignmentId: randomUUID(),
      run,
    }),
    /tenant mismatch/,
  );
  await store.close();
});
