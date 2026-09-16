import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { test } from "node:test";
import {
  ensureAuthoredApp,
  readAuthoredApp,
} from "../src/server/authored-app.js";
import {
  SQLiteCeremonyStore,
  type AsyncCeremonyStore,
} from "../src/server/persistence/index.js";
import type { OperationContext } from "../src/server/recipes/registry.js";

const context: OperationContext = {
  actor: {
    tenantId: "tenant",
    subjectId: "owner",
    sessionId: "browser-session",
    actorKind: "human",
    capabilities: ["executor"],
  },
  runId: "run",
  nodeId: "node",
  commandId: "command",
  effectId: "effect",
  target: "provider",
  configurationVersion: "v1",
  origin: "https://ceremony.example",
  environment: "test",
  signal: new AbortController().signal,
};
const deviceGrant = "urn:ietf:params:oauth:grant-type:device_code";

for (const algorithms of [undefined, [], ["RS256"], ["ES256"]])
  test(`metadata clients declare only a usable DPoP policy (${JSON.stringify(algorithms)})`, async (t) => {
    const store = new SQLiteCeremonyStore(":memory:", {
      current: "test",
      keys: { test: randomBytes(32) },
    });
    t.after(() => store.close());
    const app = await ensureAuthoredApp(
      store,
      context,
      {
        methods: ["oauth-code"],
        authorizationEndpoint: "https://provider.example/authorize",
        clientIdMetadataDocumentSupported: true,
        ...(algorithms ? { dpopSigningAlgorithms: algorithms } : {}),
      },
      async () => {
        throw new Error("No registration request expected");
      },
    );
    assert.ok(app);
    const required = algorithms?.includes("ES256") ?? false;
    assert.equal(Boolean(app.dpopRequired), required);
    const metadata = await store.transaction((tx) =>
      tx.get<{ dpop_bound_access_tokens: boolean }>({
        tenant: "public",
        kind: "artifact",
        id: "oauth-client:provider:run",
      }),
    );
    assert.equal(metadata?.value.dpop_bound_access_tokens, required);
    assert.equal(
      Boolean(
        (await readAuthoredApp(store, context.actor, context.runId))
          ?.dpopRequired,
      ),
      required,
    );
  });

for (const algorithms of [undefined, ["RS256"], ["ES256"]])
  test(`DCR imposed DPoP policy is preserved or rejected, never downgraded (${JSON.stringify(algorithms)})`, async (t) => {
    const store = new SQLiteCeremonyStore(":memory:", {
      current: "test",
      keys: { test: randomBytes(32) },
    });
    t.after(() => store.close());
    const discovery = {
      methods: ["oauth-code"],
      authorizationEndpoint: "https://provider.example/authorize",
      registrationEndpoint: "https://provider.example/register",
      ...(algorithms ? { dpopSigningAlgorithms: algorithms } : {}),
    };
    let calls = 0;
    const fetcher: typeof fetch = async () => {
      calls++;
      return Response.json({
        client_id: "registered-client",
        dpop_bound_access_tokens: true,
      });
    };
    const app = await ensureAuthoredApp(store, context, discovery, fetcher);
    assert.equal(Boolean(app), algorithms?.includes("ES256") ?? false);
    if (app) assert.equal(app.dpopRequired, true);
    assert.deepEqual(
      await ensureAuthoredApp(store, context, discovery, fetcher),
      app,
    );
    assert.equal(calls, 1);
  });

for (const grantTypes of [
  ["authorization_code"],
  [deviceGrant],
  ["authorization_code", deviceGrant, "refresh_token"],
  undefined,
]) {
  test(`dynamic registration requests only discovered grants: ${grantTypes?.join(",") ?? "endpoints only"}`, async (t) => {
    const expectedGrants = grantTypes ?? ["authorization_code"];
    const store = new SQLiteCeremonyStore(":memory:", {
      current: "test",
      keys: { test: randomBytes(32) },
    });
    t.after(() => store.close());
    const discovery = {
      methods: [],
      registrationEndpoint: "https://provider.example/register",
      ...(grantTypes ? { grantTypes } : {}),
      ...(expectedGrants.includes("authorization_code")
        ? { authorizationEndpoint: "https://provider.example/authorize" }
        : {}),
      ...(expectedGrants.includes(deviceGrant)
        ? { deviceAuthorizationEndpoint: "https://provider.example/device" }
        : {}),
    };
    let calls = 0;
    const fetcher: typeof fetch = async (_input, init) => {
      calls++;
      const body = JSON.parse(String(init?.body));
      assert.deepEqual(
        [...body.grant_types].sort(),
        [...expectedGrants].sort(),
      );
      assert.deepEqual(
        body.response_types,
        expectedGrants.includes("authorization_code") ? ["code"] : undefined,
      );
      return Response.json({ client_id: "registered-client" });
    };
    const app = await ensureAuthoredApp(store, context, discovery, fetcher);
    assert.equal(app?.clientId, "registered-client");
    assert.equal(app.redirectRegistered, true);
    assert.equal(
      (await ensureAuthoredApp(store, context, discovery, fetcher))?.clientId,
      "registered-client",
    );
    assert.equal(calls, 1);
    assert.deepEqual(
      await store.transaction((tx) => tx.list("public", "artifact")),
      [],
    );
  });
}

test("client metadata persistence failure leaves no unusable app and recovers on retry", async (t) => {
  const backing = new SQLiteCeremonyStore(":memory:", {
    current: "test",
    keys: { test: randomBytes(32) },
  });
  t.after(() => backing.close());
  let fail = true;
  const store: AsyncCeremonyStore = {
    close: () => backing.close(),
    transaction: (work) =>
      backing.transaction((tx) =>
        work({
          ...tx,
          put: async (key, value, revision) => {
            if (key.tenant === "public" && fail) {
              fail = false;
              throw new Error("injected metadata persistence failure");
            }
            return tx.put(key, value, revision);
          },
        }),
      ),
  };
  const discovery = {
    methods: ["oauth-code"],
    authorizationEndpoint: "https://provider.example/authorize",
    clientIdMetadataDocumentSupported: true,
  };
  const noFetch: typeof fetch = async () => {
    throw new Error("metadata clients need no registration request");
  };
  await assert.rejects(
    ensureAuthoredApp(store, context, discovery, noFetch),
    /injected metadata persistence failure/,
  );
  assert.equal(
    await readAuthoredApp(backing, context.actor, context.runId),
    undefined,
  );
  const app = await ensureAuthoredApp(store, context, discovery, noFetch);
  assert.ok(app);
  const publicKey = {
    tenant: "public",
    kind: "artifact" as const,
    id: "oauth-client:provider:run",
  };
  const metadata = await backing.transaction((tx) =>
    tx.get<{ client_id: string; redirect_uris: string[] }>(publicKey),
  );
  assert.equal(metadata?.value.client_id, app.clientId);
  assert.deepEqual(metadata.value.redirect_uris, [app.redirectUri]);
  assert.deepEqual(
    await ensureAuthoredApp(store, context, discovery, noFetch),
    app,
  );
  assert.equal(
    (await backing.transaction((tx) => tx.get(publicKey)))?.revision,
    metadata.revision,
  );
});
