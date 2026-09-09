import { test } from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import {
  createReferenceProvider,
  type ProviderOptions,
} from "../examples/provider.js";
import {
  CeremonyController,
  MemoryCredentialStore,
  createProtocolAdapter,
  createNeonAdapter,
} from "../src/server/index.js";
import { manifests } from "../examples/manifests.js";
import {
  manifestSchema,
  type ActionName,
  type CeremonySnapshot,
} from "../src/core/index.js";

const authmdReference = manifestSchema.parse({
  id: "authmd-reference",
  name: "auth.md protocol reference",
  description: "Email/code claim profile",
  methods: [
    {
      id: "anonymous",
      label: "Anonymous",
      kind: "authmd-anonymous",
      fields: [],
      scopes: ["api.read"],
      templateId: "authmd-anonymous",
    },
  ],
});

async function harness(slowDownFirstPoll = false) {
  let clock = Date.now();
  const options: ProviderOptions = {
    issuer: "http://127.0.0.1:0",
    appOrigin: "http://127.0.0.1:4173",
    now: () => clock,
    slowDownFirstPoll,
  };
  const provider = await createReferenceProvider(options);
  provider.listen(0, "127.0.0.1");
  await once(provider, "listening");
  const address = provider.address();
  assert.ok(address && typeof address !== "string");
  options.issuer = `http://127.0.0.1:${address.port}`;
  const store = new MemoryCredentialStore();
  const controller = new CeremonyController(
    [...manifests, authmdReference].map((manifest) => ({
      manifest,
      createAdapter: ({ instanceId, method }) =>
        manifest.id === "neon"
          ? createNeonAdapter(
              store,
              {
                issuer: options.issuer,
                claimOrigins: [options.issuer],
                allowLoopbackHttp: true,
              },
              () => clock,
            )
          : createProtocolAdapter(
              method,
              {
                issuer: options.issuer,
                authorizationEndpoint: `${options.issuer}/authorize`,
                tokenEndpoint: `${options.issuer}/oauth2/token`,
                deviceEndpoint: `${options.issuer}/device`,
                resource: `${options.issuer}/resource`,
                clientId: "ceremony-local",
                callbackUrl: `${options.appOrigin}/api/callback/${instanceId}`,
                credentialEndpoint: `${options.issuer}/credentials`,
                identityEndpoint: `${options.issuer}/agent/identity`,
                claimEndpoint: `${options.issuer}/agent/identity/claim`,
                allowLoopbackHttp: true,
              },
              store,
              () => clock,
            ),
    })),
    new Map(),
    () => clock,
  );
  return {
    controller,
    store,
    issuer: options.issuer,
    advance: (ms: number) => {
      clock += ms;
    },
    async close() {
      provider.closeAllConnections();
      await new Promise<void>((done, reject) =>
        provider.close((error) => (error ? reject(error) : done())),
      );
    },
  };
}
const act = (
  controller: CeremonyController,
  snapshot: CeremonySnapshot,
  action: ActionName,
  values: Record<string, string> = {},
) =>
  controller.act("alice", snapshot.id, {
    action,
    revision: snapshot.revision,
    values,
  });
async function approve(uri: string, userCode?: string, decision = "approve") {
  const page = await fetch(uri);
  const html = await page.text();
  const csrf = /name="csrf" value="([^"]+)"/.exec(html)?.[1];
  assert.ok(csrf, html);
  return fetch(new URL("/approve", uri), {
    method: "POST",
    redirect: "manual",
    headers: { origin: new URL(uri).origin },
    body: new URLSearchParams({
      csrf,
      email: "demo@example.com",
      password: "ceremony-demo",
      decision,
      ...(userCode ? { user_code: userCode } : {}),
      ...(html.includes('name="organization"')
        ? {
            organization: "demo-org",
            user_code: /name="user_code" value="([^"]+)"/.exec(html)![1]!,
          }
        : {}),
    }),
  });
}
test("credentials validate at provider, secrets stay out of snapshots, two connectors reuse the template", async () => {
  const h = await harness();
  try {
    for (const [connector, method, values] of [
      ["github", "api-key", { token: "demo-api-key" }],
      [
        "jira",
        "basic",
        { username: "demo@example.com", password: "ceremony-demo" },
      ],
      [
        "supabase",
        "form",
        { email: "demo@example.com", password: "ceremony-demo" },
      ],
    ] satisfies [string, string, Record<string, string>][]) {
      const start = h.controller.start("alice", connector, method);
      const done = await act(h.controller, start, "submit", values);
      assert.equal(done.step, "complete", JSON.stringify(done));
      assert.ok(done.outcome && h.store.get(done.outcome.connectionRef));
      assert.ok(!JSON.stringify(done).includes("ceremony-demo"));
      assert.ok(!JSON.stringify(done).includes("demo-api-key"));
      await assert.rejects(act(h.controller, start, "submit", values), /stale/);
      await assert.rejects(h.controller.read("bob", done.id), /not found/);
    }
    let start = h.controller.start("alice", "stripe", "api-key");
    assert.equal(start.method.templateId, "api-key");
    assert.equal(start.fields[0]?.label, "Stripe secret key");
    start = await act(h.controller, start, "submit", { token: "wrong-secret" });
    assert.equal(start.step, "error");
    assert.ok(!JSON.stringify(start).includes("wrong-secret"));
    start = await act(h.controller, start, "retry");
    assert.equal(
      (await act(h.controller, start, "submit", { token: "demo-api-key" }))
        .step,
      "complete",
    );
  } finally {
    await h.close();
  }
});
test("Neon anonymous project claim uses provider-owned approval, refreshes revoked tokens and discards pre-claim secrets", async () => {
  const h = await harness();
  try {
    let snapshot = await act(
      h.controller,
      h.controller.start("alice", "neon", "anonymous"),
      "begin",
    );
    assert.equal(snapshot.step, "anonymous", snapshot.message);
    const ref = snapshot.outcome!.connectionRef;
    const original = h.store.get(ref)!;
    assert.ok(
      original.identity_assertion &&
        original.access_token &&
        original.project_id,
    );
    assert.ok(!JSON.stringify(snapshot).includes(original.access_token!));
    snapshot = await act(h.controller, snapshot, "claim");
    assert.deepEqual(snapshot.fields, []);
    await assert.rejects(
      act(h.controller, snapshot, "submit", { email: "demo@example.com" }),
      /Unexpected field/,
    );
    snapshot = await act(h.controller, snapshot, "submit");
    assert.equal(snapshot.step, "waiting", snapshot.message);
    h.advance(1200);
    assert.equal(
      (await h.controller.read("alice", snapshot.id)).step,
      "waiting",
    );
    await approve(snapshot.verificationUri!);
    // The provider invalidates the old token on transfer; polling must re-exchange it.
    assert.equal(
      (
        await fetch(`${h.issuer}/resource`, {
          headers: { authorization: `Bearer ${original.access_token}` },
        })
      ).status,
      401,
    );
    h.advance(1200);
    snapshot = await h.controller.read("alice", snapshot.id);
    assert.equal(snapshot.step, "complete", snapshot.message);
    assert.equal(snapshot.outcome?.ownership, "claimed");
    assert.deepEqual(snapshot.actions, []);
    assert.deepEqual(h.store.get(ref), { project_id: original.project_id });
    assert.ok(!JSON.stringify(snapshot).includes(original.identity_assertion!));
  } finally {
    await h.close();
  }
});

test("Neon claim cancellation, denial and expiry preserve anonymous outcome without reporting a transfer", async () => {
  const h = await harness();
  try {
    let snapshot = await act(
      h.controller,
      h.controller.start("alice", "neon", "anonymous"),
      "begin",
    );
    const ref = snapshot.outcome!.connectionRef;
    snapshot = await act(h.controller, snapshot, "claim");
    snapshot = await act(h.controller, snapshot, "cancel");
    assert.equal(snapshot.step, "anonymous");
    snapshot = await act(h.controller, snapshot, "claim");
    snapshot = await act(h.controller, snapshot, "submit");
    await approve(snapshot.verificationUri!, undefined, "deny");
    h.advance(1200);
    snapshot = await h.controller.read("alice", snapshot.id);
    assert.equal(snapshot.step, "error");
    assert.equal(snapshot.outcome?.ownership, "anonymous");
    assert.ok(h.store.get(ref)?.identity_assertion);
    snapshot = await act(h.controller, snapshot, "claim");
    snapshot = await act(h.controller, snapshot, "submit");
    h.advance(301000);
    snapshot = await h.controller.read("alice", snapshot.id);
    assert.equal(snapshot.step, "expired");
    assert.equal(snapshot.outcome?.ownership, "anonymous");
  } finally {
    await h.close();
  }
});
test("OAuth round trip uses PKCE and validates state; callbacks are owner-bound and single-use", async () => {
  const h = await harness();
  try {
    let snapshot = h.controller.start("alice", "github", "oauth");
    snapshot = await act(h.controller, snapshot, "begin");
    assert.ok(snapshot.authorizationUrl);
    const url = new URL(snapshot.authorizationUrl);
    assert.equal(url.searchParams.get("code_challenge_method"), "S256");
    const approved = await approve(url.href);
    assert.equal(approved.status, 303);
    const callback = new URL(approved.headers.get("location")!);
    await assert.rejects(
      h.controller.callback("bob", snapshot.id, callback),
      /not found/,
    );
    const done = await h.controller.callback("alice", snapshot.id, callback);
    assert.equal(done.step, "complete", JSON.stringify(done));
    await assert.rejects(
      h.controller.callback("alice", snapshot.id, callback),
      /consumed/,
    );
    let invalid = h.controller.start("alice", "github", "oauth");
    invalid = await act(h.controller, invalid, "begin");
    const invalidResponse = await approve(invalid.authorizationUrl!);
    const invalidCallback = new URL(invalidResponse.headers.get("location")!);
    invalidCallback.searchParams.set("state", "attacker");
    assert.equal(
      (await h.controller.callback("alice", invalid.id, invalidCallback)).step,
      "error",
    );
    let denied = h.controller.start("alice", "github", "oauth");
    denied = await act(h.controller, denied, "begin");
    const denial = await approve(denied.authorizationUrl!, undefined, "deny");
    assert.equal(
      (
        await h.controller.callback(
          "alice",
          denied.id,
          new URL(denial.headers.get("location")!),
        )
      ).step,
      "error",
    );
  } finally {
    await h.close();
  }
});
test("provider rejects an incorrect PKCE verifier and replay of the authorization code", async () => {
  const h = await harness();
  try {
    let snapshot = h.controller.start("alice", "github", "oauth");
    snapshot = await act(h.controller, snapshot, "begin");
    const approved = await approve(snapshot.authorizationUrl!);
    const callback = new URL(approved.headers.get("location")!);
    const body = new URLSearchParams({
      grant_type: "authorization_code",
      code: callback.searchParams.get("code")!,
      code_verifier: "wrong",
      client_id: "ceremony-local",
      redirect_uri: `http://127.0.0.1:4173/api/callback/${snapshot.id}`,
    });
    const response = await fetch(`${h.issuer}/oauth2/token`, {
      method: "POST",
      body,
    });
    assert.equal(response.status, 400);
    assert.equal(
      (await h.controller.callback("alice", snapshot.id, callback)).step,
      "error",
    );
  } finally {
    await h.close();
  }
});
test("device approval handles pending, denial, cancellation and expiry", async () => {
  const h = await harness();
  try {
    let snapshot = h.controller.start("alice", "github", "device");
    snapshot = await act(h.controller, snapshot, "begin");
    assert.equal(snapshot.step, "waiting");
    assert.ok(snapshot.verificationUri && snapshot.userCode);
    h.advance(1200);
    assert.equal(
      (await h.controller.read("alice", snapshot.id)).step,
      "waiting",
    );
    await approve(snapshot.verificationUri, snapshot.userCode);
    h.advance(1200);
    assert.equal(
      (await h.controller.read("alice", snapshot.id)).step,
      "complete",
    );
    let denied = h.controller.start("alice", "github", "device");
    denied = await act(h.controller, denied, "begin");
    await approve(denied.verificationUri!, denied.userCode, "deny");
    h.advance(1200);
    assert.equal((await h.controller.read("alice", denied.id)).step, "error");
    let cancelled = h.controller.start("alice", "github", "device");
    cancelled = await act(h.controller, cancelled, "begin");
    cancelled = await act(h.controller, cancelled, "cancel");
    h.advance(1200);
    assert.equal(
      (await h.controller.read("alice", cancelled.id)).step,
      "cancelled",
    );
    let expired = h.controller.start("alice", "github", "device");
    expired = await act(h.controller, expired, "begin");
    h.advance(301000);
    assert.equal(
      (await h.controller.read("alice", expired.id)).step,
      "expired",
    );
  } finally {
    await h.close();
  }
});
test("anonymous access can be claimed, rotates credentials, and rejects forged assertions", async () => {
  const h = await harness();
  try {
    let snapshot = h.controller.start("alice", "authmd-reference", "anonymous");
    snapshot = await act(h.controller, snapshot, "begin");
    assert.equal(snapshot.step, "anonymous", JSON.stringify(snapshot));
    assert.equal(snapshot.outcome?.ownership, "anonymous");
    snapshot = await act(h.controller, snapshot, "finish");
    assert.equal(snapshot.step, "complete");
    snapshot = await h.controller.read("alice", snapshot.id);
    assert.deepEqual(snapshot.actions, ["claim"]);
    const ref = snapshot.outcome!.connectionRef;
    const original = h.store.get(ref)!.access_token!;
    snapshot = await act(h.controller, snapshot, "claim");
    snapshot = await act(h.controller, snapshot, "submit", {
      email: "demo@example.com",
    });
    await approve(snapshot.verificationUri!, snapshot.userCode);
    h.advance(1200);
    snapshot = await h.controller.read("alice", snapshot.id);
    assert.equal(snapshot.step, "complete", JSON.stringify(snapshot));
    assert.equal(snapshot.outcome?.ownership, "claimed");
    assert.equal(snapshot.outcome?.connectionRef, ref);
    assert.deepEqual(snapshot.outcome?.scopes, ["api.read", "api.write"]);
    assert.notEqual(h.store.get(ref)!.access_token, original);
    assert.equal(
      (
        await fetch(`${h.issuer}/resource`, {
          headers: { authorization: `Bearer ${original}` },
        })
      ).status,
      401,
    );
    assert.equal(
      (
        await fetch(`${h.issuer}/resource`, {
          headers: {
            authorization: `Bearer ${h.store.get(ref)!.access_token}`,
          },
        })
      ).status,
      200,
    );
    const forged = await fetch(`${h.issuer}/oauth2/token`, {
      method: "POST",
      body: new URLSearchParams({
        grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
        assertion: "unsigned.fake.jwt",
        resource: `${h.issuer}/resource`,
      }),
    });
    assert.equal(forged.status, 400);
  } finally {
    await h.close();
  }
});
test("claim cancellation and failed approval preserve anonymous access; secret-bearing input never enters errors", async () => {
  const h = await harness();
  try {
    let snapshot = await act(
      h.controller,
      h.controller.start("alice", "authmd-reference", "anonymous"),
      "begin",
    );
    const ref = snapshot.outcome!.connectionRef;
    snapshot = await act(h.controller, snapshot, "claim");
    snapshot = await act(h.controller, snapshot, "cancel");
    assert.equal(snapshot.step, "anonymous");
    assert.equal(snapshot.outcome?.connectionRef, ref);
    snapshot = await act(h.controller, snapshot, "claim");
    await assert.rejects(
      act(h.controller, snapshot, "submit", { email: "secret-not-email" }),
      (error) =>
        error instanceof Error && !error.message.includes("secret-not-email"),
    );
    snapshot = await act(h.controller, snapshot, "submit", {
      email: "demo@example.com",
    });
    await approve(snapshot.verificationUri!, snapshot.userCode, "deny");
    h.advance(1200);
    snapshot = await h.controller.read("alice", snapshot.id);
    assert.equal(snapshot.step, "error");
    assert.equal(snapshot.outcome?.connectionRef, ref);
    snapshot = await act(h.controller, snapshot, "finish");
    assert.equal(snapshot.step, "complete");
    assert.equal(snapshot.outcome?.ownership, "anonymous");
  } finally {
    await h.close();
  }
});
test("adapter backs off after slow_down before attempting the next token exchange", async () => {
  const h = await harness(true);
  try {
    let snapshot = await act(
      h.controller,
      h.controller.start("alice", "github", "device"),
      "begin",
    );
    h.advance(1200);
    snapshot = await h.controller.read("alice", snapshot.id);
    assert.equal(snapshot.step, "waiting");
    await approve(snapshot.verificationUri!, snapshot.userCode);
    h.advance(1200);
    assert.equal(
      (await h.controller.read("alice", snapshot.id)).step,
      "waiting",
    );
    h.advance(5000);
    assert.equal(
      (await h.controller.read("alice", snapshot.id)).step,
      "complete",
    );
  } finally {
    await h.close();
  }
});

test("device endpoint returns slow_down when polled faster than its advertised interval", async () => {
  const h = await harness();
  try {
    const response = await fetch(`${h.issuer}/device`, {
      method: "POST",
      body: new URLSearchParams({ client_id: "ceremony-local" }),
    });
    const data = await response.json();
    const body = new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:device_code",
      client_id: "ceremony-local",
      device_code: data.device_code,
    });
    assert.equal(
      (
        await (
          await fetch(`${h.issuer}/oauth2/token`, { method: "POST", body })
        ).json()
      ).error,
      "authorization_pending",
    );
    assert.equal(
      (
        await (
          await fetch(`${h.issuer}/oauth2/token`, { method: "POST", body })
        ).json()
      ).error,
      "slow_down",
    );
  } finally {
    await h.close();
  }
});
