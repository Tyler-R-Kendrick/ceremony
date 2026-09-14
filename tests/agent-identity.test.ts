import assert from "node:assert/strict";
import test from "node:test";
import { createProtocolAdapter } from "../src/server/adapters.js";
import {
  createSignatureAgent,
  createSignatureKey,
  directoryMediaType,
  directoryPath,
  verifyRequestSignature,
} from "../src/core/web-bot-auth.js";

/**
 * An agent that can say which bot it is without asking anybody for anything.
 *
 * This is the point of the module: no account, no API token, no enrolment. The
 * agent generates a key, publishes the public half at its own well-known path,
 * and signs what it sends. An origin fronted by a bot gate can then let it
 * through without stopping a person — and an origin that has never heard of it
 * is no worse off than if it had never signed.
 */

const directoryOf = (document: string) => ({
  fetchDirectory: (async () =>
    new Response(document, {
      headers: { "content-type": directoryMediaType },
    })) as unknown as typeof fetch,
});

test("an agent mints its own identity and needs nothing from anyone", async () => {
  const agent = createSignatureAgent("https://agent.example");
  assert.equal(agent.directory, "https://agent.example");
  assert.equal(directoryPath, "/.well-known/http-message-signatures-directory");

  // The published document is a public key and nothing else.
  const published = JSON.parse(agent.document()) as {
    keys: { kty: string; crv: string; x: string }[];
  };
  assert.equal(published.keys.length, 1);
  assert.deepEqual(Object.keys(published.keys[0]!).sort(), ["crv", "kty", "x"]);
  assert.equal(published.keys[0]!.kty, "OKP");
  assert.ok(!agent.document().includes("d".repeat(8)), "no private material");

  const headers = agent.headers("https://provider.example/signin");
  assert.match(headers["signature-input"]!, /tag="web-bot-auth"/);
  assert.match(headers["signature-agent"]!, /type=directory/);

  const verdict = await verifyRequestSignature(
    headers,
    "provider.example",
    directoryOf(agent.document()),
  );
  assert.deepEqual(verdict, { ok: true, keyId: agent.key.keyId });
});

test("a gate refuses a signature that is lapsed, mistagged, or from a key it cannot find", async () => {
  const agent = createSignatureAgent("https://agent.example");
  const stranger = createSignatureAgent(
    "https://agent.example",
    createSignatureKey(),
  );
  const authority = "provider.example";
  const url = `https://${authority}/signin`;

  for (const [why, headers] of [
    ["absent", {}],
    ["malformed", { "signature-input": "nonsense", signature: "sig=::" }],
    ["untagged", agent.headers(url, { tag: "something-else" })],
    ["expired", agent.headers(url, { ageSeconds: 7200, lifetimeSeconds: 60 })],
    // Signed by a key this directory does not publish.
    ["unknown-key", stranger.headers(url)],
  ] as const) {
    const verdict = await verifyRequestSignature(
      headers as Record<string, string>,
      authority,
      directoryOf(agent.document()),
    );
    assert.equal(verdict.ok, false, why);
    if (!verdict.ok) assert.equal(verdict.why, why);
  }
});

test("a signature is bound to the authority it was made for", async () => {
  // One signature covering @authority stays good for a whole ceremony against
  // that host, and is worth nothing against another one.
  const agent = createSignatureAgent("https://agent.example");
  const headers = agent.headers("https://provider.example/signin");
  const elsewhere = await verifyRequestSignature(
    headers,
    "another.example",
    directoryOf(agent.document()),
  );
  assert.deepEqual(elsewhere, { ok: false, why: "bad-signature" });
});

test("the adapter signs what it sends, and sends nothing extra when it has no identity", async () => {
  const method = {
    id: "form",
    label: "Email & password",
    kind: "form" as const,
    fields: [
      {
        name: "email",
        label: "Email",
        type: "email" as const,
        required: true,
        classification: "personal" as const,
      },
      {
        name: "password",
        label: "Password",
        type: "password" as const,
        required: true,
        classification: "secret" as const,
      },
    ],
    scopes: [],
    templateId: "form",
  };
  const base = {
    issuer: "http://127.0.0.1:4174",
    authorizationEndpoint: "http://127.0.0.1:4174/authorize",
    tokenEndpoint: "http://127.0.0.1:4174/oauth2/token",
    deviceEndpoint: "http://127.0.0.1:4174/device",
    resource: "http://127.0.0.1:4174/resource",
    clientId: "test",
    callbackUrl: "http://127.0.0.1:4173/api/callback/x",
    credentialEndpoint: "http://127.0.0.1:4174/credentials",
    identityEndpoint: "http://127.0.0.1:4174/agent/identity",
    claimEndpoint: "http://127.0.0.1:4174/agent/identity/claim",
    allowLoopbackHttp: true,
  };
  const store = {
    put: async () => "ref",
    get: async () => undefined,
    delete: async () => {},
  };
  const agent = createSignatureAgent("http://127.0.0.1:4173");

  const drive = async (config: typeof base & { agent?: typeof agent }) => {
    const seen: Record<string, string>[] = [];
    const original = globalThis.fetch;
    globalThis.fetch = (async (input: string | URL, init?: RequestInit) => {
      // Read through Headers, because that is what the adapter sends. The
      // first version of this spread the value instead and captured {} — the
      // same mistake that cost the adapter its content-type.
      seen.push(Object.fromEntries(new Headers(init?.headers).entries()));
      return new Response(
        JSON.stringify({ access_token: "t", token_type: "bearer" }),
        {
          headers: { "content-type": "application/json" },
        },
      );
    }) as typeof fetch;
    try {
      const adapter = createProtocolAdapter(method, config, store);
      await adapter.submit(
        { email: "a@b.test", password: "x".repeat(12) },
        false,
      );
    } finally {
      globalThis.fetch = original;
    }
    return seen;
  };

  const signed = await drive({ ...base, agent });
  assert.ok(signed.length, "the adapter should have called the provider");
  for (const headers of signed) {
    const verdict = await verifyRequestSignature(
      headers,
      "127.0.0.1:4174",
      directoryOf(agent.document()),
    );
    assert.deepEqual(verdict, { ok: true, keyId: agent.key.keyId });
  }

  // Without an identity the request is exactly what it always was.
  const unsigned = await drive(base);
  for (const headers of unsigned)
    assert.ok(
      !Object.keys(headers).some((name) => name.startsWith("signature")),
      "an agent with no identity must not invent one",
    );
});
