import assert from "node:assert/strict";
import test from "node:test";
import { createProtocolAdapter } from "../src/server/adapters.js";
import { createMcpIdentity } from "../src/server/mcp-identity.js";
import { createOidcIdentity } from "../src/server/oidc-identity.js";
import { MAX_RESPONSE_BYTES } from "../src/server/connectors/auth/response-bound.js";

/*
 * The deployment's own protocol adapter signs a person in to a provider the
 * operator configured. Every answer it reads there carries a credential, a
 * registration or a challenge, through oauth4webapi or by hand, and is read
 * under the same ceiling as any other OAuth answer.
 */

const CHUNK = 64 * 1024;
const ENDLESS = 64 * 1024 * 1024;
const SLACK = 2 * CHUNK;

const config = {
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

/** `fetch` replaced for the length of `work`, answering every request without end. */
async function againstEndlessProvider(
  work: () => Promise<unknown>,
  status = 200,
) {
  const seen = { pulled: 0 };
  const chunk = new Uint8Array(CHUNK).fill(0x20);
  const original = globalThis.fetch;
  globalThis.fetch = (async () =>
    new Response(
      new ReadableStream<Uint8Array>({
        pull(controller) {
          if (seen.pulled >= ENDLESS) return controller.close();
          seen.pulled += CHUNK;
          controller.enqueue(chunk);
        },
      }),
      { status, headers: { "content-type": "application/json" } },
    )) as typeof fetch;
  try {
    await work().then(
      () => undefined,
      () => undefined,
    );
  } finally {
    globalThis.fetch = original;
  }
  assert.ok(seen.pulled > 0, "the endless answer was in fact served");
  assert.ok(
    seen.pulled <= MAX_RESPONSE_BYTES + SLACK,
    `read ${seen.pulled} bytes of a provider's answer; the ceiling is ${MAX_RESPONSE_BYTES}`,
  );
}

const formMethod = {
  kind: "form" as const,
  id: "form",
  label: "Form",
  fields: [],
  scopes: [],
  templateId: "form",
};

test("a device authorization answer that never ends is cut off at the ceiling", async () => {
  const adapter = createProtocolAdapter(
    {
      kind: "device",
      id: "device",
      label: "Device",
      scopes: ["openid"],
    } as never,
    config,
    store,
  );
  await againstEndlessProvider(() => adapter.begin());
});

test("a credential answer that never ends is cut off at the ceiling", async () => {
  const adapter = createProtocolAdapter(formMethod as never, config, store);
  await againstEndlessProvider(() => adapter.submit({}, false));
});

test("an anonymous registration answer that never ends is cut off at the ceiling", async () => {
  const adapter = createProtocolAdapter(
    {
      kind: "authmd-anonymous",
      id: "anon",
      label: "Anonymous",
      scopes: [],
    } as never,
    config,
    store,
  );
  await againstEndlessProvider(() => adapter.begin());
});

/*
 * The deployment's own sign-in to the operator's issuer (the browser identity
 * and the MCP identity) fetch the issuer's discovery document at startup.
 */

test("an issuer discovery answer that never ends is cut off for the browser identity", async () => {
  await againstEndlessProvider(() =>
    createOidcIdentity(
      {
        origin: "http://127.0.0.1:4173",
        issuer: "http://127.0.0.1:4174",
        clientId: "client",
        development: true,
        mapClaims: async () => ({
          tenantId: "t",
          subjectId: "s",
          capabilities: [],
        }),
      },
      {
        get: async () => undefined,
        put: async () => {},
        delete: async () => {},
      } as never,
    ),
  );
});

test("an issuer discovery answer that never ends is cut off for the MCP identity", async () => {
  await againstEndlessProvider(() =>
    createMcpIdentity({
      issuer: "http://127.0.0.1:4174",
      audience: "http://127.0.0.1:4173/mcp",
      development: true,
      mapClaims: async () => ({
        tenantId: "t",
        subjectId: "s",
        capabilities: [],
      }),
    }),
  );
});
