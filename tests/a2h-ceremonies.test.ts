import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { randomBytes } from "node:crypto";
import { z } from "zod";
import { CompactSign, compactVerify, generateKeyPair } from "jose";
import {
  Agent2Human,
  a2hCeremonySchema,
  canonicalJson,
  type A2HCeremony,
} from "../src/server/a2h.js";
import { effectAuthorizationDigest } from "../src/server/authorization.js";
import { CeremonyDatabase } from "../src/server/storage.js";

const ceremony: A2HCeremony = {
  connectorId: "jira",
  connectorName: "Jira",
  purpose: "app-registration",
  effect: {
    tenantId: "tenant",
    subjectId: "alice",
    runId: "run",
    operationId: "jira.prepare-app",
    operationVersion: "1.0.0",
    target: "https://workspace.atlassian.net",
    configurationVersion: "v1",
    scopes: ["read:jira-user"],
    argumentsDigest: "a".repeat(64),
  },
};
const humanUrl = "https://ceremony.example/human/run";

async function fixture(t: TestContext) {
  const db = new CeremonyDatabase(":memory:", randomBytes(32));
  t.after(() => db.close());
  const agentKey = await generateKeyPair("EdDSA");
  const gateway = await generateKeyPair("EdDSA");
  let recipient = {
    principalId: "principal-alice",
    type: "email" as const,
    address: "mailto:alice@example.test",
  };
  const intents: Record<string, z.infer<ReturnType<typeof z.json>>>[] = [];
  let loseReply = false;
  const agent = new Agent2Human(db, {
    gatewayOrigin: "https://gateway.example",
    agentId: "did:web:ceremony.example",
    keyId: "agent",
    privateKey: agentKey.privateKey,
    gatewayKey: gateway.publicKey,
    apiKey: "synthetic-key",
    recipient: () => recipient,
    fetch: async (input, init) => {
      if (String(input).endsWith("/.well-known/a2h"))
        return Response.json({
          a2h_supported: ["1.0"],
          channels: ["email"],
          max_ttl_sec: 600,
          auth: { methods: ["api_key"] },
        });
      const intent = z
        .record(z.string(), z.json())
        .parse(JSON.parse(String(init?.body)));
      intents.push(intent);
      if (loseReply) {
        loseReply = false;
        throw new Error("synthetic transport interruption");
      }
      return Response.json({ interaction_id: intent.interaction_id });
    },
  });
  return {
    agent,
    db,
    intents,
    agentKey,
    changeRecipient: (change: Partial<typeof recipient>) => {
      recipient = { ...recipient, ...change };
    },
    loseReply: () => {
      loseReply = true;
    },
    async response(decision = "APPROVE") {
      const intent = intents.at(-1)!;
      const payload = {
        type: "RESPONSE",
        message_id: "response",
        interaction_id: intent.interaction_id!,
        responds_to: intent.message_id!,
        principal_id: "principal-alice",
        decision,
        decided_at: new Date().toISOString(),
        evidence: { factor: "otp.email.v1" },
      };
      const [header, , signature] = (
        await new CompactSign(Buffer.from(canonicalJson(payload)))
          .setProtectedHeader({ alg: "EdDSA" })
          .sign(gateway.privateKey)
      ).split(".");
      return { ...payload, signature: `${header}..${signature}` };
    },
  };
}

test("A2H generic purposes sign only public labels and an effect digest; approval requires verification", async (t) => {
  for (const purpose of a2hCeremonySchema.shape.purpose.options) {
    const f = await fixture(t);
    const bound = { ...ceremony, purpose };
    const id = await f.agent.authorize("alice", "run", humanUrl, bound);
    assert.equal(await f.agent.authorize("alice", "run", humanUrl, bound), id);
    assert.equal(f.intents.length, 1);
    const { signature, ...intent } = f.intents[0]!;
    assert.deepEqual(intent.params, {
      purpose,
      connector_id: "jira",
      connector_name: "Jira",
      effect_digest: effectAuthorizationDigest(bound.effect),
    });
    assert.equal(JSON.stringify(intent).includes("GitHub"), false);
    assert.equal(JSON.stringify(intent).includes(bound.effect.target), false);
    assert.equal(typeof signature, "string");
    const [header, , signed] = z.string().parse(signature).split(".");
    await compactVerify(
      `${header}.${Buffer.from(canonicalJson(intent)).toString("base64url")}.${signed}`,
      f.agentKey.publicKey,
    );
    const response = await f.response();
    await assert.rejects(f.agent.receive("run", response));
    assert.equal(await f.agent.receive("run", response, bound), "verify");
    await assert.rejects(f.agent.receive("run", response, bound));
  }
});

test("A2H changed effect semantics cannot reuse delivery or consume approval", async (t) => {
  const f = await fixture(t);
  await f.agent.authorize("alice", "run", humanUrl, ceremony);
  const response = await f.response();
  const changes = {
    tenantId: "other",
    subjectId: "bob",
    runId: "other",
    operationId: "jira.verify-access",
    operationVersion: "2.0.0",
    target: "https://other.atlassian.net",
    configurationVersion: "v2",
    scopes: ["write:jira-work"],
    argumentsDigest: "b".repeat(64),
  };
  for (const [key, value] of Object.entries(changes)) {
    const changed = {
      ...ceremony,
      effect: { ...ceremony.effect, [key]: value },
    };
    await assert.rejects(
      f.agent.authorize("alice", "run", humanUrl, changed),
      /context changed/,
    );
    await assert.rejects(
      f.agent.receive("run", response, changed),
      /context changed/,
    );
  }
  assert.equal(f.intents.length, 1);
  assert.equal(await f.agent.receive("run", response, ceremony), "verify");
});

test("A2H recipient remapping during a human wait invalidates the response", async (t) => {
  for (const change of [
    { principalId: "principal-other" },
    { address: "mailto:other@example.test" },
  ]) {
    const f = await fixture(t);
    await f.agent.authorize("alice", "run", humanUrl, ceremony);
    const response = await f.response();
    f.changeRecipient(change);
    await assert.rejects(
      f.agent.authorize("alice", "run", humanUrl, ceremony),
      /context changed/,
    );
    await assert.rejects(
      f.agent.receive("run", response, ceremony),
      /context changed/,
    );
  }
});

test("A2H uncertain generic delivery retries the same signed intent and rejects changed context", async (t) => {
  const f = await fixture(t);
  f.loseReply();
  await assert.rejects(f.agent.authorize("alice", "run", humanUrl, ceremony));
  await assert.rejects(
    f.agent.authorize("alice", "run", `${humanUrl}/changed`, ceremony),
    /context changed/,
  );
  await f.agent.authorize("alice", "run", humanUrl, ceremony);
  assert.equal(f.intents.length, 2);
  assert.deepEqual(f.intents[0], f.intents[1]);
  assert.equal(
    await f.agent.receive("run", await f.response("DECLINE"), ceremony),
    "deny",
  );
});

test("A2H descriptors reject unknown fields and untrusted structural values", () => {
  for (const value of [
    { ...ceremony, source: "ui" },
    { ...ceremony, purpose: "execute-code" },
    { ...ceremony, connectorName: "<script>" },
    { ...ceremony, connectorName: "Jira\nApprove" },
    { ...ceremony, connectorName: "a".repeat(81) },
    { ...ceremony, connectorId: "https://evil.test" },
    { ...ceremony, effect: { ...ceremony.effect, secret: "private" } },
  ])
    assert.equal(a2hCeremonySchema.safeParse(value).success, false);
});
