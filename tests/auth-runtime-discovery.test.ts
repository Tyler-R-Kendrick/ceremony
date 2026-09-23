import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { calculateJwkThumbprint, importJWK, jwtVerify } from "jose";
import { test } from "node:test";
import { SQLiteCeremonyStore } from "../src/server/persistence/index.js";
import {
  ProtectedCommandService,
  type RunRecord,
} from "../src/server/commands.js";
import {
  OperationRegistry,
  type OperationContext,
} from "../src/server/recipes/registry.js";
import { authoredHuman } from "../src/server/authored-human.js";
import {
  authoredVocabulary,
  registerAuthoredOperations,
  saveAuthoredAccountIntent,
  saveAuthoredBlocker,
  publicAuthoredIdentity,
  readAuthoredAccountIntent,
  authoredLoginStatus,
  saveAuthoredGrantSession,
  saveAuthoredAuthorizationSession,
  saveAuthoredDeviceSession,
  accountBrowserKey,
  stageAuthoredRegistration,
  readPendingRegistration,
  readAuthoredAccount,
  deleteAuthoredSession,
  recoverAuthoredRegistration,
  consumeAuthoredLogin,
  saveAuthoredAccount,
  issueAuthoredHandle,
} from "../src/server/authored-operations.js";
import { discoverProviderAuth } from "../src/server/provider-discovery.js";
import { AuthorizationError } from "../src/server/identity.js";
import type { ActorContext } from "../src/core/operation-contracts.js";
import type {
  AuthorizationBrowser,
  AuthorizationBrowserInput,
} from "../src/server/browser-executor.js";

const actor: ActorContext = {
  tenantId: "tenant",
  subjectId: "owner",
  sessionId: "browser-session",
  actorKind: "human",
  capabilities: ["executor"],
};

async function fixture(
  options: {
    device?: boolean;
    account?: string;
    emailClaim?: { email: string; verified?: boolean };
    mismatch?: boolean;
    par?: boolean | "available" | "optional" | "without-dpop";
    dpopAlgorithms?: unknown;
    dcrDpopRequired?: boolean;
    noClient?: boolean;
    registrationFailure?: boolean;
    tokenFailure?: boolean;
    deviceFailure?: "disconnect" | 429 | 503;
    userinfoNonce?: boolean | "always";
    humanBrowser?: AuthorizationBrowser;
    operationBrowser?: AuthorizationBrowser;
  } = {},
) {
  const store = new SQLiteCeremonyStore(":memory:", {
    current: "test",
    keys: { test: randomBytes(32) },
  });
  const provider = "https://novel-provider.example";
  const origin = "https://ceremony.example";
  const counts = {
    browser: 0,
    token: 0,
    registration: 0,
    metadata: 0,
    userinfo: 0,
    device: 0,
  };
  let challenge = "";
  let pollError = "slow_down";
  let deviceFailure = options.deviceFailure;
  let browserCredentials: AuthorizationBrowserInput["credentials"];
  let browserInput: AuthorizationBrowserInput | undefined;
  let pushed: URLSearchParams | undefined;
  let proofKey: string | undefined;
  const proofIds = new Set<string>();
  const dpopProvider =
    options.par === "available" || options.par === "optional";
  const verifyProof = async (headers: Headers, url: URL, method: string) => {
    const { payload, protectedHeader } = await jwtVerify(
      headers.get("dpop")!,
      (header) => importJWK(header.jwk!, "ES256"),
      { algorithms: ["ES256"], typ: "dpop+jwt" },
    );
    assert.equal(payload.htm, method);
    assert.equal(payload.htu, url.href);
    assert.equal(Reflect.has(protectedHeader.jwk!, "d"), false);
    assert.ok(typeof payload.jti === "string");
    assert.equal(proofIds.has(payload.jti), false);
    proofIds.add(payload.jti);
    const thumbprint = await calculateJwkThumbprint(protectedHeader.jwk!);
    if (proofKey) assert.equal(thumbprint, proofKey);
    else proofKey = thumbprint;
    return payload;
  };
  const fetcher: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    assert.equal(url.origin, provider);
    if (url.pathname === "/.well-known/oauth-authorization-server") {
      counts.metadata++;
      return Response.json({
        issuer: provider,
        authorization_endpoint: `${provider}/authorize`,
        token_endpoint: `${provider}/token`,
        userinfo_endpoint: `${provider}/userinfo`,
        code_challenge_methods_supported: ["S256"],
        ...(options.dpopAlgorithms !== undefined
          ? { dpop_signing_alg_values_supported: options.dpopAlgorithms }
          : dpopProvider
            ? { dpop_signing_alg_values_supported: ["ES256"] }
            : {}),
        ...(options.noClient
          ? {}
          : { registration_endpoint: `${provider}/register-client` }),
        ...(options.device
          ? { device_authorization_endpoint: `${provider}/device` }
          : {}),
        ...(options.par
          ? {
              require_pushed_authorization_requests: options.par !== "optional",
              pushed_authorization_request_endpoint: `${provider}/par`,
            }
          : {}),
      });
    }
    if (url.pathname === "/register-client") {
      counts.registration++;
      if (options.registrationFailure)
        throw new Error("Fixture lost registration response");
      return Response.json(
        {
          client_id: "registered-fixture-client",
          ...(options.dcrDpopRequired
            ? { dpop_bound_access_tokens: true }
            : {}),
        },
        { status: 201 },
      );
    }
    if (url.pathname === "/device") {
      counts.device++;
      return Response.json({
        device_code: "private-device-code",
        user_code: "USER-CODE",
        verification_uri: `${provider}/approve`,
        expires_in: 600,
        interval: 5,
      });
    }
    if (
      url.pathname === "/par" &&
      (dpopProvider || options.par === "without-dpop")
    ) {
      if (dpopProvider)
        await verifyProof(new Headers(init?.headers), url, "POST");
      else assert.equal(new Headers(init?.headers).has("dpop"), false);
      pushed = new URLSearchParams(String(init?.body));
      return Response.json(
        {
          request_uri: "urn:ietf:params:oauth:request_uri:fixture",
          expires_in: 60,
        },
        { status: 201 },
      );
    }
    if (url.pathname === "/par")
      return new Response("Unavailable", { status: 503 });
    if (url.pathname === "/token") {
      counts.token++;
      if (options.tokenFailure)
        return new Response("Unavailable", { status: 503 });
      const form = new URLSearchParams(String(init?.body));
      if (dpopProvider)
        await verifyProof(new Headers(init?.headers), url, "POST");
      else assert.equal(new Headers(init?.headers).has("dpop"), false);
      if (form.get("grant_type") === "authorization_code") {
        assert.equal(form.get("code"), "fixture-code");
        assert.equal(
          createHash("sha256")
            .update(form.get("code_verifier")!)
            .digest("base64url"),
          challenge,
        );
      } else {
        if (deviceFailure === "disconnect")
          throw new Error("Synthetic device transport disconnect");
        if (deviceFailure)
          return new Response("Unavailable", {
            status: deviceFailure,
            headers: {
              "retry-after":
                deviceFailure === 429
                  ? "30"
                  : new Date(Date.now() + 30_000).toUTCString(),
            },
          });
        if (pollError)
          return Response.json({ error: pollError }, { status: 400 });
      }
      return Response.json({
        access_token: "private-fixture-token",
        token_type: dpopProvider ? "DPoP" : "Bearer",
      });
    }
    if (url.pathname === "/userinfo") {
      counts.userinfo++;
      assert.equal(
        new Headers(init?.headers).get("authorization"),
        `${dpopProvider ? "DPoP" : "Bearer"} private-fixture-token`,
      );
      if (dpopProvider) {
        const proof = await verifyProof(new Headers(init?.headers), url, "GET");
        assert.equal(
          proof.ath,
          createHash("sha256")
            .update("private-fixture-token")
            .digest("base64url"),
        );
        if (
          options.userinfoNonce &&
          (!proof.nonce || options.userinfoNonce === "always")
        )
          return Response.json(
            { error: "use_dpop_nonce" },
            {
              status: 401,
              headers: {
                "dpop-nonce": "resource-fixture-nonce",
                "www-authenticate": 'DPoP error="use_dpop_nonce"',
              },
            },
          );
        if (options.userinfoNonce)
          assert.equal(proof.nonce, "resource-fixture-nonce");
      }
      return Response.json({
        sub: "provider-subject",
        preferred_username: options.mismatch
          ? "other-account"
          : "chosen-account",
        ...(options.emailClaim
          ? {
              email: options.emailClaim.email,
              email_verified: options.emailClaim.verified,
            }
          : {}),
      });
    }
    return new Response("", { status: 404 });
  };
  const registry = new OperationRegistry(authoredVocabulary);
  registerAuthoredOperations(registry, {
    store,
    fetch: fetcher,
    browser: {
      complete: async (input) => {
        counts.browser++;
        browserInput = input;
        browserCredentials = input.credentials;
        if (options.operationBrowser)
          return options.operationBrowser.complete(input);
        return { status: "blocked", reason: "passkey" };
      },
    },
  });
  const commands = new ProtectedCommandService(
    store,
    registry,
    async () => true,
  );
  const runContext = {
    provider: "novel",
    profile: "authored",
    target: "novel",
    origin,
    environment: "test",
    configurationVersion: "v1",
  };
  const run = await commands.createRun(
    actor,
    runContext,
    [
      {
        id: "account",
        operationId: "authored.register-account",
        operationVersion: "1.0.0",
        dependsOn: [],
        bindings: {},
      },
    ],
    {},
  );
  await store.transaction((tx) =>
    tx.put(
      {
        tenant: actor.tenantId,
        kind: "artifact",
        id: "installed-connector:novel",
      },
      {
        author: actor.subjectId,
        session: actor.sessionId,
        manifest: { name: "Novel provider", methods: [] },
        definition: {},
        discovery: {
          origin: provider,
          documents: [],
          methods: [],
          grantTypes: [],
          searchUsed: false,
        },
      },
      null,
    ),
  );
  await saveAuthoredAccountIntent(store, actor, run.id, {
    identifier: options.account ?? "chosen-account",
    status: "existing",
  });
  const advance = async () => {
    const snapshot = await commands.snapshot(actor, run.id);
    await commands.advance(
      actor,
      run.id,
      "account",
      snapshot.revision,
      `advance:${snapshot.revision}`,
    );
  };
  await advance();
  await saveAuthoredBlocker(store, actor, run.id, "passkey");
  const context: OperationContext = {
    ...runContext,
    actor,
    runId: run.id,
    nodeId: "account",
    commandId: "human",
    effectId: "human",
    signal: new AbortController().signal,
  };
  const humanUrl = `${origin}/api/v1/teaching/novel/${encodeURIComponent(run.id)}/human`;
  const human = async (
    url = humanUrl,
    currentActor = actor,
    init?: RequestInit,
  ) => {
    const record = await store.transaction((tx) =>
      tx.get<RunRecord>({ tenant: actor.tenantId, kind: "run", id: run.id }),
    );
    assert.ok(record);
    return authoredHuman(
      store,
      { ...context, actor: currentActor },
      record,
      new Request(url, init),
      `${origin}/?teachingRun=${run.id}`,
      advance,
      {
        connectorId: "novel",
        name: "Novel provider",
        fetch: fetcher,
        ...(options.humanBrowser ? { browser: options.humanBrowser } : {}),
      },
    );
  };
  return {
    store,
    run,
    counts,
    context,
    commands,
    registry,
    advance,
    human,
    humanUrl,
    browserCredentials: () => browserCredentials,
    browserInput: () => browserInput,
    acceptRedirect(response: Response) {
      assert.equal(response.status, 303);
      const authorization = new URL(response.headers.get("location")!);
      assert.equal(authorization.origin, provider);
      const parameters = authorization.searchParams.has("request_uri")
        ? pushed!
        : authorization.searchParams;
      if (pushed)
        assert.equal(
          authorization.searchParams.get("request_uri"),
          "urn:ietf:params:oauth:request_uri:fixture",
        );
      assert.equal(parameters.get("code_challenge_method"), "S256");
      challenge = parameters.get("code_challenge")!;
      const callback = new URL(humanUrl);
      callback.searchParams.set("state", parameters.get("state")!);
      callback.searchParams.set("code", "fixture-code");
      return callback.href;
    },
    async ticket(change: Record<string, unknown>) {
      await store.transaction(async (tx) => {
        const records = await tx.list<Record<string, unknown>>(
          actor.tenantId,
          "handoff",
          1000,
          "",
        );
        const ticket = records.find(
          (record) => record.value.deviceCode || record.value.verifier,
        );
        assert.ok(ticket);
        await tx.put(
          { tenant: actor.tenantId, kind: "handoff", id: ticket.id },
          { ...ticket.value, ...change },
          ticket.revision,
        );
      });
    },
    allowDevice: () => {
      pollError = "";
      deviceFailure = undefined;
    },
  };
}

test("registration journal survives encrypted-store reopen without overwriting verified credentials", async (t) => {
  const f = await fixture({ account: "chosen@example.test" });
  t.after(() => f.store.close());
  const directory = await mkdtemp(join(tmpdir(), "ceremony-registration-"));
  const filename = join(directory, "store.sqlite");
  const keys = { current: "test", keys: { test: randomBytes(32) } };
  let durable = new SQLiteCeremonyStore(filename, keys);
  t.after(async () => {
    await durable.close();
    await rm(directory, { recursive: true, force: true });
  });
  const runKey = { tenant: actor.tenantId, kind: "run" as const, id: f.run.id };
  const run = await f.store.transaction((tx) => tx.get<RunRecord>(runKey));
  assert.ok(run);
  await durable.transaction((tx) => tx.put(runKey, run.value, null));
  const nodeKey = {
    tenant: actor.tenantId,
    kind: "node" as const,
    id: `${f.run.id}:${f.context.nodeId}`,
  };
  const node = await f.store.transaction((tx) =>
    tx.get<{ state: string; verified: boolean }>(nodeKey),
  );
  assert.ok(node);
  await durable.transaction((tx) => tx.put(nodeKey, node.value, null));
  const prior = {
    username: "previous-user",
    password: "previous-private-password",
  };
  const account = {
    username: "generated-user",
    email: "chosen@example.test",
    password: "journal-private-password",
  };
  await saveAuthoredAccount(durable, actor, "novel", prior);
  await saveAuthoredAccountIntent(durable, actor, f.run.id, {
    identifier: account.email,
    status: "unchecked",
  });
  await stageAuthoredRegistration(durable, f.context, "novel", account);
  assert.deepEqual(await readAuthoredAccount(durable, actor, "novel"), prior);
  await durable.close();
  const bytes = await readFile(filename);
  assert.equal(bytes.includes(Buffer.from(account.password)), false);
  assert.equal(bytes.includes(Buffer.from(account.email)), false);
  durable = new SQLiteCeremonyStore(filename, keys);
  assert.deepEqual(
    (await readPendingRegistration(durable, f.context, "novel"))?.account,
    account,
  );
  for (const context of [
    { ...f.context, actor: { ...actor, subjectId: "other" } },
    { ...f.context, actor: { ...actor, sessionId: "other" } },
    { ...f.context, nodeId: "other" },
    { ...f.context, runId: "other" },
  ])
    assert.equal(
      await readPendingRegistration(durable, context, "novel"),
      undefined,
    );
  assert.equal(
    await readPendingRegistration(durable, f.context, "other"),
    undefined,
  );
  await saveAuthoredAccountIntent(durable, actor, f.run.id, {
    identifier: "other@example.test",
    status: "unchecked",
  });
  await assert.rejects(
    recoverAuthoredRegistration(durable, f.context, "novel"),
  );
  await saveAuthoredAccountIntent(durable, actor, f.run.id, {
    identifier: account.email,
    status: "unchecked",
  });
  await durable.transaction(async (tx) => {
    const current = await tx.get(nodeKey);
    await tx.put(
      nodeKey,
      { ...node.value, state: "complete", verified: true },
      current!.revision,
    );
  });
  await assert.rejects(
    recoverAuthoredRegistration(durable, f.context, "novel"),
  );
  await durable.transaction(async (tx) => {
    const current = await tx.get(nodeKey);
    await tx.put(nodeKey, node.value, current!.revision);
  });
  await recoverAuthoredRegistration(durable, f.context, "novel");
  assert.deepEqual(
    await consumeAuthoredLogin(durable, actor, f.run.id),
    account,
  );
  assert.deepEqual(await readAuthoredAccount(durable, actor, "novel"), prior);
  assert.equal(
    await publicAuthoredIdentity(durable, actor, f.run.id),
    undefined,
  );
  await saveAuthoredAccount(durable, actor, "novel", account, f.run.id);
  assert.deepEqual(await readAuthoredAccount(durable, actor, "novel"), account);
  assert.equal(
    await readPendingRegistration(durable, f.context, "novel"),
    undefined,
  );
});

test("interrupted registration offers private sign-in recovery without replaying signup or claiming an account", async (t) => {
  let closed = 0;
  const f = await fixture({
    account: "chosen@example.test",
    humanBrowser: {
      complete: async () => {
        throw new Error("The handoff must use the operation runner");
      },
      screenshot: async () => undefined,
      close: async () => {
        closed++;
      },
    },
  });
  t.after(() => f.store.close());
  const account = {
    username: "generated-user",
    email: "chosen@example.test",
    password: "private-generated-password",
  };
  await saveAuthoredAccountIntent(f.store, actor, f.run.id, {
    identifier: account.email,
    status: "unchecked",
  });
  await stageAuthoredRegistration(f.store, f.context, "novel", account);
  assert.deepEqual(
    (await readPendingRegistration(f.store, f.context, "novel"))?.account,
    account,
  );
  assert.equal(await readAuthoredAccount(f.store, actor, "novel"), undefined);
  assert.equal(
    await publicAuthoredIdentity(f.store, actor, f.run.id),
    undefined,
  );
  await f.advance();
  assert.equal(f.counts.browser, 1);
  const response = await f.human();
  assert.equal(response.status, 200);
  const html = await response.text();
  assert.match(html, /Try sign-in with saved credentials/);
  assert.equal(html.includes(account.password), false);
  assert.equal(html.includes(account.username), false);
  const submit = () =>
    f.human(f.humanUrl, actor, {
      method: "POST",
      body: new URLSearchParams({ action: "recover-registration" }),
    });
  await assert.rejects(
    f.human(
      f.humanUrl,
      { ...actor, subjectId: "other" },
      {
        method: "POST",
        body: new URLSearchParams({ action: "recover-registration" }),
      },
    ),
  );
  await assert.rejects(
    f.human(
      f.humanUrl,
      { ...actor, sessionId: "other" },
      {
        method: "POST",
        body: new URLSearchParams({ action: "recover-registration" }),
      },
    ),
  );
  assert.equal(f.counts.browser, 1);
  assert.equal((await submit()).status, 303);
  assert.equal(closed, 1);
  assert.equal(f.counts.browser, 2);
  assert.deepEqual(f.browserCredentials(), account);
  assert.notEqual(f.browserInput()?.generateAccount, true);
  assert.equal(
    f.browserInput()?.startUrl,
    "https://novel-provider.example/login",
  );
  assert.equal(f.browserInput()?.resumeSession, undefined);
  assert.equal(await readAuthoredAccount(f.store, actor, "novel"), undefined);
  assert.equal(
    await publicAuthoredIdentity(f.store, actor, f.run.id),
    undefined,
  );
  assert.equal((await f.commands.snapshot(actor, f.run.id)).status, "active");
  await assert.rejects(
    deleteAuthoredSession(f.store, { ...actor, subjectId: "other" }, f.run.id),
  );
  assert.ok(await readPendingRegistration(f.store, f.context, "novel"));
  assert.equal(await deleteAuthoredSession(f.store, actor, f.run.id), true);
  assert.equal(
    await readPendingRegistration(f.store, f.context, "novel"),
    undefined,
  );
});

for (const flow of ["code", "par", "device"] as const)
  for (const proof of ["verified", "unverified", "missing", "other"] as const)
    test(`native ${flow} binds an email selection only to a matching verified provider claim (${proof})`, async (t) => {
      const f = await fixture({
        account: "chosen@example.test",
        ...(flow === "par" ? { par: "available" } : {}),
        ...(flow === "device" ? { device: true } : {}),
        ...(proof === "missing"
          ? {}
          : {
              emailClaim: {
                email:
                  proof === "other"
                    ? "other@example.test"
                    : "chosen@example.test",
                verified: proof !== "unverified",
              },
            }),
      });
      t.after(() => f.store.close());
      let callback: string;
      if (flow === "device") {
        await f.human(`${f.humanUrl}?flow=device`);
        await f.ticket({ nextPoll: 0 });
        f.allowDevice();
        callback = f.humanUrl;
      } else callback = f.acceptRedirect(await f.human());
      if (proof === "verified") {
        assert.equal((await f.human(callback)).status, 303);
        assert.deepEqual(
          await publicAuthoredIdentity(f.store, actor, f.run.id),
          { handle: "chosen-account", did: "provider-subject" },
        );
        assert.equal(
          (await f.commands.snapshot(actor, f.run.id)).status,
          "complete",
        );
      } else {
        await assert.rejects(f.human(callback));
        assert.equal(
          await publicAuthoredIdentity(f.store, actor, f.run.id),
          undefined,
        );
        assert.equal(
          (await f.commands.snapshot(actor, f.run.id)).status,
          "active",
        );
      }
      assert.equal(f.counts.token, 1);
      assert.equal(f.counts.browser, 1);
    });

for (const change of ["unchanged", "unverified", "other"] as const)
  test(`email-bound access rechecks the provider claim before producing a connection (${change})`, async (t) => {
    const emailClaim = { email: "chosen@example.test", verified: true };
    const f = await fixture({ account: emailClaim.email, emailClaim });
    t.after(() => f.store.close());
    const callback = f.acceptRedirect(await f.human());
    assert.equal((await f.human(callback)).status, 303);
    if (change === "unverified") emailClaim.verified = false;
    if (change === "other") emailClaim.email = "other@example.test";
    // The same node asked again returns its existing per-run handle.
    const session = await issueAuthoredHandle(f.store, f.context, "session");
    const verified = await f.registry
      .require("authored.verify-access", "1.0.0")
      .handler(f.context, { session });
    assert.equal(
      verified.state,
      change === "unchanged" ? "complete" : "awaiting-human",
    );
    if (change !== "unchanged") assert.deepEqual(verified.outputs, {});
    assert.equal(f.counts.userinfo, 2);
    assert.equal(f.counts.token, 1);
    assert.equal(f.counts.browser, 1);
  });

test("runtime discovers native OAuth after a passkey blocker and verifies the selected account without replaying the browser", async (t) => {
  const f = await fixture();
  t.after(() => f.store.close());
  const callback = f.acceptRedirect(await f.human());
  await f.advance();
  assert.equal(f.counts.browser, 1);
  assert.equal((await f.commands.snapshot(actor, f.run.id)).status, "active");
  const done = await f.human(callback);
  assert.equal(done.status, 303);
  assert.equal((await f.commands.snapshot(actor, f.run.id)).status, "complete");
  assert.equal(
    (await publicAuthoredIdentity(f.store, actor, f.run.id))?.handle,
    "chosen-account",
  );
  await f.human(callback);
  assert.equal(f.counts.token, 1);
  assert.equal(f.counts.registration, 1);
});

for (const par of ["available", "optional"] as const)
  for (const userinfoNonce of [false, true])
    test(`native ${par} PAR handoff keeps DPoP proof bound through token exchange and provider identity verification (nonce: ${userinfoNonce})`, async (t) => {
      const f = await fixture({
        par,
        userinfoNonce,
        dcrDpopRequired: userinfoNonce,
      });
      t.after(() => f.store.close());
      const callback = f.acceptRedirect(await f.human());
      assert.equal((await f.human(callback)).status, 303);
      assert.equal(
        (await f.commands.snapshot(actor, f.run.id)).status,
        "complete",
      );
      assert.equal(
        (await publicAuthoredIdentity(f.store, actor, f.run.id))?.handle,
        "chosen-account",
      );
      assert.equal(f.counts.token, 1);
      const session = await issueAuthoredHandle(f.store, f.context, "session");
      const verified = await f.registry
        .require("authored.verify-access", "1.0.0")
        .handler(f.context, { session });
      assert.equal(verified.state, "complete");
      assert.equal(f.counts.userinfo, userinfoNonce ? 4 : 2);
      const stored = await f.store.transaction((tx) =>
        tx.list<Record<string, unknown>>(actor.tenantId, "artifact", 1000, ""),
      );
      assert.ok(
        stored.find((record) => record.id.startsWith("authored-session:"))
          ?.value.dpopJwk,
      );
      assert.deepEqual(await publicAuthoredIdentity(f.store, actor, f.run.id), {
        handle: "chosen-account",
        did: "provider-subject",
      });
    });

for (const algorithms of [undefined, [], ["RS256"], ["none"], ["HS256"]])
  test(`native required PAR completes without unadvertised DPoP (${JSON.stringify(algorithms)})`, async (t) => {
    const f = await fixture({
      par: "without-dpop",
      dpopAlgorithms: algorithms,
    });
    t.after(() => f.store.close());
    const callback = f.acceptRedirect(await f.human());
    assert.equal((await f.human(callback)).status, 303);
    assert.equal(
      (await f.commands.snapshot(actor, f.run.id)).status,
      "complete",
    );
    assert.equal(f.counts.token, 1);
    assert.equal(f.counts.userinfo, 1);
  });

test("repeated DPoP nonce challenges are bounded without replaying the authorization code", async (t) => {
  const f = await fixture({ par: "available", userinfoNonce: "always" });
  t.after(() => f.store.close());
  const callback = f.acceptRedirect(await f.human());
  await assert.rejects(f.human(callback));
  assert.equal(f.counts.token, 1);
  assert.equal(f.counts.userinfo, 4);
  assert.equal(
    await publicAuthoredIdentity(f.store, actor, f.run.id),
    undefined,
  );
  await assert.rejects(f.human(callback));
  assert.equal(f.counts.token, 1);
  assert.equal(f.counts.userinfo, 4);
});

for (const tokenType of ["Bearer", undefined])
  test(`stored non-DPoP grants use Bearer without requiring a proof key (${tokenType ?? "legacy omitted type"})`, async (t) => {
    const f = await fixture();
    t.after(() => f.store.close());
    let reads = 0;
    await saveAuthoredGrantSession(
      f.store,
      actor,
      f.run.id,
      {
        origin: "https://novel-provider.example",
        documents: [],
        methods: [],
        grantTypes: [],
        searchUsed: false,
        userinfoEndpoint: "https://novel-provider.example/userinfo",
      },
      {
        access_token: "private-fixture-token",
        ...(tokenType ? { token_type: tokenType } : {}),
      },
      async (input, init) => {
        reads++;
        assert.equal(String(input), "https://novel-provider.example/userinfo");
        const headers = new Headers(init?.headers);
        assert.equal(
          headers.get("authorization"),
          "Bearer private-fixture-token",
        );
        assert.equal(headers.has("dpop"), false);
        return Response.json({
          sub: "provider-subject",
          preferred_username: "chosen-account",
        });
      },
    );
    assert.equal(reads, 1);
    assert.deepEqual(await publicAuthoredIdentity(f.store, actor, f.run.id), {
      handle: "chosen-account",
      did: "provider-subject",
    });
  });

for (const flow of ["authorization-code", "device"] as const)
  for (const tokenType of ["Bearer", "DPoP"])
    test(`${flow} applies the shared grant proof check before UserInfo (${tokenType})`, async (t) => {
      const f = await fixture();
      t.after(() => f.store.close());
      const provider = "https://novel-provider.example";
      const discovery = {
        origin: provider,
        documents: [],
        methods: [],
        grantTypes: [],
        searchUsed: false,
        tokenEndpoint: `${provider}/token`,
        userinfoEndpoint: `${provider}/userinfo`,
      };
      let tokens = 0;
      let reads = 0;
      const fetcher: typeof fetch = async (input, init) => {
        if (String(input) === discovery.tokenEndpoint) {
          tokens++;
          assert.equal(init?.method, "POST");
          const body = new URLSearchParams(String(init?.body));
          assert.equal(
            body.get("grant_type"),
            flow === "device"
              ? "urn:ietf:params:oauth:grant-type:device_code"
              : "authorization_code",
          );
          return Response.json({
            access_token: "private-fixture-token",
            token_type: tokenType,
            // Keep the legacy normalization: malformed optional refresh values
            // must not be copied from raw claims into the persisted session.
            refresh_token: 123,
          });
        }
        assert.equal(String(input), discovery.userinfoEndpoint);
        reads++;
        assert.equal(
          new Headers(init?.headers).get("authorization"),
          "Bearer private-fixture-token",
        );
        return Response.json({
          sub: "provider-subject",
          preferred_username: "chosen-account",
        });
      };
      const execute = () =>
        flow === "device"
          ? saveAuthoredDeviceSession(
              f.store,
              actor,
              f.run.id,
              discovery,
              { deviceCode: "fixture-device", clientId: "fixture-client" },
              fetcher,
            )
          : saveAuthoredAuthorizationSession(
              f.store,
              actor,
              f.run.id,
              discovery,
              {
                code: "fixture-code",
                redirectUri: "https://ceremony.example/callback",
                verifier: "fixture-verifier",
                clientId: "fixture-client",
              },
              fetcher,
            );
      if (tokenType === "DPoP") {
        await assert.rejects(execute);
        assert.equal(reads, 0);
        assert.equal(
          await publicAuthoredIdentity(f.store, actor, f.run.id),
          undefined,
        );
      } else {
        await execute();
        assert.equal(reads, 1);
        assert.deepEqual(
          await publicAuthoredIdentity(f.store, actor, f.run.id),
          {
            handle: "chosen-account",
            did: "provider-subject",
          },
        );
      }
      assert.equal(tokens, 1);
    });

for (const tokenType of ["Bearer", undefined])
  test(`required DPoP policy rejects an unbound token before UserInfo (${tokenType ?? "missing type"})`, async (t) => {
    const f = await fixture();
    t.after(() => f.store.close());
    let calls = 0;
    await assert.rejects(
      saveAuthoredGrantSession(
        f.store,
        actor,
        f.run.id,
        {
          origin: "https://novel-provider.example",
          documents: [],
          methods: [],
          grantTypes: [],
          searchUsed: false,
          userinfoEndpoint: "https://novel-provider.example/userinfo",
          dpopRequired: true,
          dpopSigningAlgorithms: ["ES256"],
        },
        {
          access_token: "synthetic-token",
          ...(tokenType ? { token_type: tokenType } : {}),
        },
        async () => {
          calls++;
          return Response.json({
            sub: "provider-subject",
            preferred_username: "chosen-account",
          });
        },
      ),
      (error: unknown) =>
        error instanceof AuthorizationError && error.code === "denied",
    );
    assert.equal(calls, 0);
    assert.equal(
      await publicAuthoredIdentity(f.store, actor, f.run.id),
      undefined,
    );
  });

test("a DPoP grant without its private key never downgrades to Bearer", async (t) => {
  const f = await fixture();
  t.after(() => f.store.close());
  let reads = 0;
  await assert.rejects(
    saveAuthoredGrantSession(
      f.store,
      actor,
      f.run.id,
      {
        origin: "https://novel-provider.example",
        documents: [],
        methods: [],
        grantTypes: [],
        searchUsed: false,
        userinfoEndpoint: "https://novel-provider.example/userinfo",
      },
      { access_token: "private-fixture-token", token_type: "DPoP" },
      async () => {
        reads++;
        return Response.json({
          sub: "provider-subject",
          preferred_username: "chosen-account",
        });
      },
    ),
  );
  assert.equal(reads, 0);
  assert.equal(
    await publicAuthoredIdentity(f.store, actor, f.run.id),
    undefined,
  );
});

for (const action of [
  { code: "246810" },
  { text: "Human supplied value" },
  { key: "Tab" },
  { x: "12", y: "34" },
  {},
])
  test(`private browser input preserves ownership and only resumes automation for code or continue (${Object.keys(action)[0] ?? "continue"})`, async (t) => {
    const calls: Array<{ key: string; action: unknown }> = [];
    let available = true;
    const f = await fixture({
      humanBrowser: {
        complete: async () => {
          throw new Error("Unexpected browser restart");
        },
        interact: async (key, input) => {
          calls.push({ key, action: input });
          return available;
        },
      },
    });
    t.after(() => f.store.close());
    await saveAuthoredBlocker(f.store, actor, f.run.id, "challenge");
    const key = accountBrowserKey(actor, f.run.id);
    await f.store.transaction(async (tx) => {
      const state = await tx.get(key);
      await tx.put(
        key,
        { pending: true, verified: false },
        state?.revision ?? null,
      );
    });
    const post = {
      method: "POST",
      body: new URLSearchParams({ text: "", action: "browser", ...action }),
    };
    await assert.rejects(
      f.human(f.humanUrl, { ...actor, sessionId: "foreign" }, post),
    );
    await assert.rejects(
      f.human(f.humanUrl, actor, {
        method: "POST",
        body: "action=browser&x=1280&y=0",
      }),
    );
    assert.equal(calls.length, 0);
    assert.equal(f.counts.browser, 1);
    const response = await f.human(f.humanUrl, actor, post);
    assert.equal(response.status, 303);
    assert.deepEqual(calls, [
      { key: key.id, action: "x" in action ? { x: 12, y: 34 } : action },
    ]);
    const resumes = "code" in action || Object.keys(action).length === 0;
    assert.equal(f.counts.browser, resumes ? 2 : 1);
    if (!resumes) assert.equal(response.headers.get("location"), f.humanUrl);
    available = false;
    const expired = await f.human(f.humanUrl, actor, post);
    assert.equal(expired.status, 410);
    assert.equal(
      await expired.text(),
      "Browser session expired. Return to the connection to restart.",
    );
    await f.store.transaction(async (tx) => {
      const state = await tx.get(key);
      assert.ok(state);
      await tx.delete(key, state.revision);
    });
    const callsBeforeMissingSession = calls.length;
    assert.equal((await f.human(f.humanUrl, actor, post)).status, 410);
    assert.equal(calls.length, callsBeforeMissingSession);
    assert.equal(f.counts.browser, resumes ? 2 : 1);
    assert.equal(
      await publicAuthoredIdentity(f.store, actor, f.run.id),
      undefined,
    );
  });

for (const configured of [false, true])
  test(`private browser input returns recovery when ${configured ? "interaction support" : "the browser adapter"} is unavailable`, async (t) => {
    const f = await fixture(
      configured
        ? {
            humanBrowser: {
              complete: async () => {
                throw new Error("Unexpected browser restart");
              },
            },
          }
        : {},
    );
    t.after(() => f.store.close());
    await saveAuthoredBlocker(f.store, actor, f.run.id, "challenge");
    const key = accountBrowserKey(actor, f.run.id);
    await f.store.transaction(async (tx) => {
      const state = await tx.get(key);
      await tx.put(
        key,
        { pending: true, verified: false },
        state?.revision ?? null,
      );
    });
    const response = await f.human(f.humanUrl, actor, {
      method: "POST",
      body: new URLSearchParams({ action: "browser" }),
    });
    assert.equal(response.status, 410);
    assert.equal(response.headers.get("cache-control"), "no-store");
    assert.equal(
      await response.text(),
      "Browser session expired. Return to the connection to restart.",
    );
    assert.equal(f.counts.browser, 1);
    assert.equal((await f.commands.snapshot(actor, f.run.id)).status, "active");
    assert.equal(
      await publicAuthoredIdentity(f.store, actor, f.run.id),
      undefined,
    );
  });

test("private login submission stays bound to the selected account and rejects invalid input before advancing", async (t) => {
  const f = await fixture();
  t.after(() => f.store.close());
  await saveAuthoredBlocker(f.store, actor, f.run.id, "session");
  for (const body of [
    { username: "other-account", password: "synthetic-password" },
    { username: "chosen-account", password: "" },
    { username: "chosen-account", password: "x".repeat(1025) },
  ])
    await assert.rejects(
      f.human(f.humanUrl, actor, {
        method: "POST",
        body: new URLSearchParams(body),
      }),
    );
  assert.equal(f.counts.browser, 1);
  const response = await f.human(f.humanUrl, actor, {
    method: "POST",
    body: new URLSearchParams({
      username: "chosen-account",
      password: "synthetic-password",
    }),
  });
  assert.equal(response.status, 303);
  assert.equal(await authoredLoginStatus(f.store, actor, f.run.id), "none");
  assert.deepEqual(f.browserCredentials(), {
    username: "chosen-account",
    password: "synthetic-password",
  });
  assert.equal(f.counts.browser, 2);
  assert.equal(
    await publicAuthoredIdentity(f.store, actor, f.run.id),
    undefined,
  );
});

test("a popup blocker discovers native handoff and completes the selected account without replaying browser submission", async (t) => {
  const f = await fixture();
  t.after(() => f.store.close());
  await saveAuthoredBlocker(f.store, actor, f.run.id, "popup");
  const callback = f.acceptRedirect(await f.human());
  await f.advance();
  assert.equal(f.counts.browser, 1);
  assert.equal((await f.human(callback)).status, 303);
  assert.equal((await f.commands.snapshot(actor, f.run.id)).status, "complete");
  assert.equal(
    (await publicAuthoredIdentity(f.store, actor, f.run.id))?.handle,
    "chosen-account",
  );
});

test("account-name collision accepts an explicit existing-account choice without claiming registration succeeded", async (t) => {
  const f = await fixture();
  t.after(() => f.store.close());
  await saveAuthoredBlocker(f.store, actor, f.run.id, "username-in-use");
  const response = await f.human(f.humanUrl, actor, {
    method: "POST",
    body: new URLSearchParams({
      username: "my-other-account",
      mode: "existing",
    }),
  });
  assert.equal(response.status, 303);
  assert.deepEqual(await readAuthoredAccountIntent(f.store, actor, f.run.id), {
    identifier: "my-other-account",
    status: "existing",
  });
  assert.equal(
    await publicAuthoredIdentity(f.store, actor, f.run.id),
    undefined,
  );
  assert.equal(f.counts.browser, 2);
});

test("definite collision before credentials are staged still permits account choice", async (t) => {
  const f = await fixture({
    account: "chosen@example.test",
    operationBrowser: {
      complete: async () => ({ status: "blocked", reason: "username-in-use" }),
    },
  });
  t.after(() => f.store.close());
  await saveAuthoredAccountIntent(f.store, actor, f.run.id, {
    identifier: "chosen@example.test",
    status: "available",
  });
  await f.advance();
  assert.equal(
    (await (await f.human()).text()).includes("Choose another"),
    true,
  );
  assert.equal(
    await readPendingRegistration(f.store, f.context, "novel"),
    undefined,
  );
});

for (const reason of ["username-in-use", "email-in-use"] as const)
  test(`definite ${reason} discards only rejected registration credentials and permits an explicit retry`, async (t) => {
    const f = await fixture({
      account: "chosen@example.test",
      operationBrowser: {
        complete: async (input) => {
          if (input.generateAccount) {
            await input.vault!.stage!({
              username: "generated-user",
              email: "chosen@example.test",
              password: "synthetic-rejected-password",
            });
            return { status: "blocked", reason };
          }
          return { status: "blocked", reason: "session" };
        },
      },
    });
    t.after(() => f.store.close());
    await saveAuthoredAccountIntent(f.store, actor, f.run.id, {
      identifier: "chosen@example.test",
      status: "available",
    });
    await f.advance();
    const html = await (await f.human()).text();
    assert.match(html, /Choose another/);
    assert.equal(html.includes("Recover interrupted registration"), false);
    assert.equal(
      await readPendingRegistration(f.store, f.context, "novel"),
      undefined,
    );
    assert.equal(await readAuthoredAccount(f.store, actor, "novel"), undefined);
    assert.equal((await f.commands.snapshot(actor, f.run.id)).status, "active");
    const before = f.counts.browser;
    assert.equal(
      (
        await f.human(f.humanUrl, actor, {
          method: "POST",
          body: new URLSearchParams({
            username: "chosen@example.test",
            mode: "register",
          }),
        })
      ).status,
      303,
    );
    assert.equal(f.counts.browser, before + 1);
    assert.equal(f.browserInput()?.generateAccount, true);
    assert.equal(
      await publicAuthoredIdentity(f.store, actor, f.run.id),
      undefined,
    );
  });

test("native return rejects another browser session, wrong state, and a different provider account", async (t) => {
  const f = await fixture({ mismatch: true });
  t.after(() => f.store.close());
  const callback = f.acceptRedirect(await f.human());
  await assert.rejects(
    f.human(callback, { ...actor, sessionId: "foreign-session" }),
  );
  const wrong = new URL(callback);
  wrong.searchParams.set("state", "wrong");
  await assert.rejects(f.human(wrong.href));
  assert.equal(f.counts.token, 0);
  await assert.rejects(f.human(callback));
  assert.equal(
    await publicAuthoredIdentity(f.store, actor, f.run.id),
    undefined,
  );
  assert.equal((await f.commands.snapshot(actor, f.run.id)).status, "active");
  await assert.rejects(f.human(callback));
  assert.equal(f.counts.token, 1);
});

test("device handoff honors polling intervals, slow_down, and expiry without issuing another device code", async (t) => {
  const f = await fixture({ device: true });
  t.after(() => f.store.close());
  assert.match(await (await f.human()).text(), /Continue with a device code/);
  assert.match(
    await (await f.human(`${f.humanUrl}?flow=device`)).text(),
    /USER-CODE/,
  );
  await f.human();
  assert.equal(f.counts.token, 0);
  await f.ticket({ nextPoll: 0 });
  const slowed = await f.human();
  assert.match(await slowed.text(), /content="10"/);
  await f.human();
  assert.equal(f.counts.token, 1);
  await f.ticket({ expires: 0, nextPoll: 0 });
  assert.match(await (await f.human()).text(), /Approval expired/);
  assert.equal(f.counts.token, 1);
});

for (const fault of ["disconnect", 429, 503] as const)
  test(`device ${fault} backoff survives refresh and recovers without a new authorization`, async (t) => {
    let now = Math.floor(Date.now() / 1000) * 1000;
    t.mock.method(Date, "now", () => now);
    const f = await fixture({ device: true, deviceFailure: fault });
    t.after(() => f.store.close());
    await f.human(`${f.humanUrl}?flow=device`);
    now += 5000;
    const firstWait = fault === "disconnect" ? 10 : 30;
    assert.match(
      await (await f.human()).text(),
      new RegExp(`content="${firstWait}"`),
    );
    assert.equal(f.counts.token, 1);
    now += 5000;
    await f.human();
    assert.equal(f.counts.token, 1, "refresh must honor persisted backoff");
    now += (firstWait - 5) * 1000;
    assert.match(
      await (await f.human()).text(),
      new RegExp(`content="${firstWait * 2}"`),
    );
    assert.equal(f.counts.token, 2);
    f.allowDevice();
    now += firstWait * 2 * 1000 - 1;
    await f.human();
    assert.equal(
      f.counts.token,
      2,
      "retry remains deferred until its deadline",
    );
    now++;
    assert.equal((await f.human()).status, 303);
    assert.equal(f.counts.token, 3);
    assert.equal(f.counts.device, 1);
    assert.equal(f.counts.browser, 1);
    assert.equal(
      (await f.commands.snapshot(actor, f.run.id)).status,
      "complete",
    );
    assert.equal(
      (await publicAuthoredIdentity(f.store, actor, f.run.id))?.handle,
      "chosen-account",
    );
  });

test("device approval completes the same account step using provider identity", async (t) => {
  const f = await fixture({ device: true });
  t.after(() => f.store.close());
  await f.human(`${f.humanUrl}?flow=device`);
  await f.ticket({ nextPoll: 0 });
  f.allowDevice();
  assert.equal((await f.human()).status, 303);
  assert.equal((await f.commands.snapshot(actor, f.run.id)).status, "complete");
  assert.equal(f.counts.browser, 1);
});

for (const device of [false, true])
  for (const field of ["subject", "actorSession", "runId", "nodeId"])
    test(`native ${device ? "device" : "code"} ticket rejects stale ${field} even for the current owner`, async (t) => {
      const f = await fixture({ device });
      t.after(() => f.store.close());
      const callback = device
        ? (await f.human(`${f.humanUrl}?flow=device`), f.humanUrl)
        : f.acceptRedirect(await f.human());
      await f.ticket({ [field]: "stale-binding", nextPoll: 0 });
      await assert.rejects(f.human(callback));
      assert.equal(f.counts.token, 0);
      assert.equal(
        await publicAuthoredIdentity(f.store, actor, f.run.id),
        undefined,
      );
    });

test("native discovery never invents a public client or bypasses required PAR", async (t) => {
  const noClient = await fixture({ noClient: true });
  t.after(() => noClient.store.close());
  const unsupported = await noClient.human();
  assert.equal(unsupported.status, 200);
  assert.match(
    await unsupported.text(),
    /No usable client registration was discovered/,
  );
  const par = await fixture({ par: true });
  t.after(() => par.store.close());
  const unavailable = await par.human();
  assert.equal(unavailable.status, 200);
  assert.equal(unavailable.headers.get("location"), null);
  assert.equal(par.counts.token, 0);
});

test("provider denial stops without exchanging a code or automatically restarting consent", async (t) => {
  const f = await fixture();
  t.after(() => f.store.close());
  const denied = new URL(f.acceptRedirect(await f.human()));
  denied.searchParams.delete("code");
  denied.searchParams.set("error", "access_denied");
  const response = await f.human(denied.href);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("location"), null);
  assert.match(await response.text(), /Authorization was not completed/);
  assert.equal(f.counts.token, 0);
  await assert.rejects(f.human(denied.href));
});

test("uncertain registration and code exchanges are not replayed on refresh", async (t) => {
  const registration = await fixture({ registrationFailure: true });
  t.after(() => registration.store.close());
  await registration.human();
  await registration.human();
  assert.equal(registration.counts.registration, 1);
  const token = await fixture({ tokenFailure: true });
  t.after(() => token.store.close());
  const callback = token.acceptRedirect(await token.human());
  await assert.rejects(token.human(callback));
  await assert.rejects(token.human(callback));
  assert.equal(token.counts.token, 1);
  assert.equal(
    await publicAuthoredIdentity(token.store, actor, token.run.id),
    undefined,
  );
});

for (const algorithms of [["ES256"], ["RS256"], [], "ES256", [null]])
  test(`DPoP discovery preserves capabilities without inventing a requirement (${JSON.stringify(algorithms)})`, async () => {
    const provider = "https://capability.example";
    const discovered = await discoverProviderAuth([provider], {
      fetch: async (input) =>
        new URL(String(input)).pathname ===
        "/.well-known/oauth-authorization-server"
          ? Response.json({
              issuer: provider,
              authorization_endpoint: `${provider}/authorize`,
              token_endpoint: `${provider}/token`,
              dpop_signing_alg_values_supported: algorithms,
            })
          : new Response("", { status: 404 }),
    });
    const valid =
      Array.isArray(algorithms) &&
      algorithms.every((value) => typeof value === "string");
    assert.equal(discovered.dpopRequired, undefined);
    assert.deepEqual(
      discovered.dpopSigningAlgorithms,
      valid ? algorithms : undefined,
    );
    assert.equal(
      discovered.authorizationEndpoint,
      valid ? `${provider}/authorize` : undefined,
    );
  });

test("well-known discovery retries transient reads only, and rejects issuer mismatch", async () => {
  const counts = new Map<string, number>();
  const discovered = await discoverProviderAuth(["https://novel.example"], {
    fetch: async (input) => {
      const url = String(input);
      const count = (counts.get(url) ?? 0) + 1;
      counts.set(url, count);
      if (!url.endsWith("oauth-authorization-server"))
        return new Response("", { status: 404 });
      if (count === 1)
        return new Response("", {
          status: 503,
          headers: { "retry-after": "0" },
        });
      return Response.json({
        issuer: "https://novel.example",
        authorization_endpoint: "https://novel.example/authorize",
        code_challenge_methods_supported: ["S256"],
      });
    },
  });
  assert.deepEqual(discovered.codeChallengeMethods, ["S256"]);
  assert.equal(
    counts.get("https://novel.example/.well-known/oauth-authorization-server"),
    2,
  );
  assert.equal(
    counts.get("https://novel.example/.well-known/openid-configuration"),
    1,
  );
  const invalid = await discoverProviderAuth(["https://novel.example"], {
    fetch: async () =>
      Response.json({
        issuer: "https://other.example",
        authorization_endpoint: "https://other.example/authorize",
      }),
  });
  // Non-AS documents are not allowed to introduce unrelated authorization metadata either.
  assert.equal(invalid.authorizationEndpoint, undefined);
});

test("discovery preserves same-issuer metadata without importing another issuer's capabilities", async () => {
  const origin = "https://resource.example";
  const delegated = "https://identity.example";
  const result = await discoverProviderAuth([origin], {
    fetch: async (input) => {
      const url = String(input);
      if (url === `${origin}/.well-known/oauth-authorization-server`)
        return Response.json({
          issuer: origin,
          authorization_endpoint: `${origin}/authorize`,
          token_endpoint: `${origin}/token`,
          code_challenge_methods_supported: ["S256"],
          grant_types_supported: ["authorization_code"],
          scopes_supported: ["openid"],
        });
      if (url === `${origin}/.well-known/openid-configuration`)
        return Response.json({
          issuer: origin,
          token_endpoint: `${origin}/ignored-token`,
          userinfo_endpoint: `${origin}/userinfo`,
          grant_types_supported: ["authorization_code", "refresh_token"],
        });
      if (url === `${origin}/.well-known/oauth-protected-resource`)
        return Response.json({ authorization_servers: [delegated] });
      if (url === `${delegated}/.well-known/openid-configuration`)
        return Response.json({
          issuer: delegated,
          authorization_endpoint: `${delegated}/ignored-authorize`,
          registration_endpoint: `${delegated}/register`,
          device_authorization_endpoint: `${delegated}/device`,
          pushed_authorization_request_endpoint: `${delegated}/par`,
          require_pushed_authorization_requests: true,
          client_id_metadata_document_supported: true,
          dpop_signing_alg_values_supported: ["ES256"],
          scopes_supported: ["ignored-scope"],
        });
      return new Response("", { status: 404 });
    },
  });
  assert.deepEqual(result, {
    origin,
    issuer: `${origin}/`,
    documents: [
      "/.well-known/oauth-authorization-server",
      "/.well-known/openid-configuration",
      "/.well-known/oauth-protected-resource",
    ],
    methods: ["oauth-code"],
    grantTypes: ["authorization_code", "refresh_token"],
    searchUsed: false,
    authorizationEndpoint: `${origin}/authorize`,
    tokenEndpoint: `${origin}/token`,
    userinfoEndpoint: `${origin}/userinfo`,
    codeChallengeMethods: ["S256"],
    scopes: ["openid"],
  });
});

test("protected resources select one delegated issuer, including issuer paths, without inheriting resource credentials", async () => {
  const origin = "https://resource.example";
  const issuer = "https://identity.example/tenant";
  const requested: string[] = [];
  const result = await discoverProviderAuth([origin], {
    fetch: async (input) => {
      const url = String(input);
      requested.push(url);
      if (url === `${origin}/.well-known/oauth-authorization-server`)
        return Response.json({
          issuer: origin,
          token_endpoint: `${origin}/not-the-delegated-token`,
          public_client_id: "resource-client",
        });
      if (url === `${origin}/.well-known/oauth-protected-resource`)
        return Response.json({
          authorization_servers: [issuer, "https://unused.example"],
        });
      if (url === `${issuer}/.well-known/openid-configuration`)
        return Response.json({
          issuer,
          authorization_endpoint: `${issuer}/authorize`,
          token_endpoint: `${issuer}/token`,
          userinfo_endpoint: `${issuer}/userinfo`,
          code_challenge_methods_supported: ["S256"],
          grant_types_supported: ["authorization_code"],
        });
      return new Response("", { status: 404 });
    },
  });
  assert.equal(result.issuer, issuer);
  assert.equal(result.tokenEndpoint, `${issuer}/token`);
  assert.equal(result.clientId, undefined);
  assert.deepEqual(result.methods, ["oauth-code"]);
  assert.ok(
    requested.includes(
      "https://identity.example/.well-known/oauth-authorization-server/tenant",
    ),
  );
  assert.equal(
    requested.some((url) => url.startsWith("https://unused.example")),
    false,
  );
});

test("temporarily unavailable delegated metadata remains retryable", async () => {
  const result = await discoverProviderAuth(["https://resource.example"], {
    fetch: async (input) => {
      const url = String(input);
      if (url.endsWith("oauth-protected-resource"))
        return Response.json({
          authorization_servers: ["https://identity.example"],
        });
      if (url.startsWith("https://identity.example"))
        return new Response("Unavailable", {
          status: 503,
          headers: { "retry-after": "30" },
        });
      return new Response("", { status: 404 });
    },
  });
  assert.equal(result.retryable, true);
  assert.equal(result.authorizationEndpoint, undefined);
});

test("multiple delegated providers are ranked using discovered capabilities and the requested provider", async () => {
  const result = await discoverProviderAuth(
    ["https://alpha.example", "https://chosen.example"],
    {
      query: "chosen",
      fetch: async (input) => {
        const url = String(input);
        if (
          url.endsWith("oauth-protected-resource") &&
          !url.startsWith("https://identity.example")
        )
          return Response.json({
            authorization_servers: ["https://identity.example"],
          });
        if (
          url ===
          "https://identity.example/.well-known/oauth-authorization-server"
        )
          return Response.json({
            issuer: "https://identity.example",
            authorization_endpoint: "https://identity.example/authorize",
            token_endpoint: "https://identity.example/token",
            device_authorization_endpoint: "https://identity.example/device",
            registration_endpoint: "https://identity.example/register",
            client_id_metadata_document_supported: true,
            public_client_id: "discovered-client",
          });
        return new Response("", { status: 404 });
      },
    },
  );
  assert.equal(result.origin, "https://chosen.example");
  assert.deepEqual(result.methods, ["oauth-code", "device"]);
  assert.equal(result.clientId, "discovered-client");
  assert.equal(result.clientIdMetadataDocumentSupported, true);
});
