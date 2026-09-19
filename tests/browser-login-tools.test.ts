import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { randomBytes, randomUUID } from "node:crypto";
import { createTeachingRuntime } from "../src/server/teaching-runtime.js";
import { teachingHttp } from "../src/server/teaching-http.js";
import { createCeremonyMcpHandler } from "../src/server/mcp.js";
import { OperationRegistry } from "../src/server/recipes/registry.js";
import { SQLiteCeremonyStore } from "../src/server/persistence/index.js";
import { managedBackends } from "../src/server/browser-backends.js";
import { createBrowserLoginService } from "../src/server/browser-login-service.js";
import { createBrowserSessionRegistry } from "../src/server/browser-sessions.js";
import { createEffectLedger } from "../src/server/browser-effects.js";
import { createBrowserLoginTools } from "../src/server/browser-login-tools.js";
import {
  createFixtureVerifier,
  createVerifierRegistry,
} from "../src/server/browser-verification.js";
import {
  createIdentityFixture,
  defaultFixtureAccounts,
  type IdentityFixture,
} from "./fixtures/identity-provider.js";
import type { LoginEvidence } from "../src/core/browser-session-contracts.js";
import type { ActorContext } from "../src/core/operation-contracts.js";

/**
 * The retained-browser operations, reached the way a real client reaches them:
 * through the authenticated HTTP routes and through the authenticated MCP
 * tools, never through a second door.
 *
 * Two things are being tested at once, and they are not the same thing. One is
 * that the operations work — a real managed Chromium, a real provider fixture,
 * and the provider's own record of who logged in as the oracle. The other is
 * that the *authority* around them is the repository's existing authority: the
 * actor comes from the transport, the plan is compiled from the server's own
 * registrations, and the two transports share one implementation so a rule
 * cannot exist in one and be missing from the other.
 *
 * Every negative case here checks the wall *and* the absence of the effect. A
 * rejection that still submitted a password is not a rejection, so the fixture
 * is asked what it received as well.
 */

const owner = defaultFixtureAccounts[0]!;
const origin = "https://app.example";
const endpoint = `${origin}/mcp`;
const issuer = "https://issuer.example";

/** Same tenant, same person, different client. The distinction under test. */
const clientA = "client-a";
const clientB = "client-b";
const actorFor = (sessionId: string): ActorContext => ({
  tenantId: "browser-tools-tenant",
  subjectId: "browser-tools-subject",
  sessionId,
  actorKind: "human",
  capabilities: ["executor"],
});

/** References, not values. These are what the collector would have minted. */
const emailRef = randomUUID();
const passwordRef = randomUUID();

let fixture: IdentityFixture;

before(async () => {
  fixture = await createIdentityFixture();
});

after(async () => {
  await fixture.close();
});

function draftFor(overrides: Record<string, unknown> = {}) {
  return {
    engine: "chromium",
    ownership: "managed",
    entryUrl: fixture.url("/signin"),
    navigationOrigins: [fixture.origin],
    credentialRecipients: {
      email: [fixture.origin],
      password: [fixture.origin],
    },
    account: { kind: "expect", accountRef: owner.account },
    continuation: "retain-for-authorized-agent",
    trustMode: "constrained-auth",
    interactionRounds: 0,
    requireVerification: true,
    verifierOrigin: fixture.origin,
    credentialRefs: { email: emailRef, password: passwordRef },
    sessionTtlMs: 600_000,
    ...overrides,
  };
}

const loginArguments = (overrides: Record<string, unknown> = {}) => ({
  connectorId: "owned-fixture-login",
  draft: draftFor(overrides),
});

/**
 * One deployment: a store, a session registry, a fixture-verified login
 * service, the shared tools, and both transports mounted on them.
 *
 * The registry handed to the login service is wrapped so the test can keep the
 * evidence ledger the tools' `evidenceFor` seam expects. The wrapper observes;
 * it does not decide anything, which is the point — a host that wants a live
 * `verified` keeps this ledger, and one that does not gets the conservative
 * answer instead of a promoted label.
 */
async function harness(options: { allowUnverified?: boolean } = {}) {
  const store = new SQLiteCeremonyStore(":memory:", {
    current: "tools",
    keys: { tools: randomBytes(32) },
  });
  const registry = createBrowserSessionRegistry({ store });
  const ledger = new Map<string, LoginEvidence>();
  const sessions: typeof registry = {
    ...registry,
    async recordEvidence(actor, sessionRef, evidence, evidenceRef) {
      ledger.set(sessionRef, evidence);
      return await registry.recordEvidence(
        actor,
        sessionRef,
        evidence,
        evidenceRef,
      );
    },
  };
  const service = createBrowserLoginService({
    sessions,
    effects: createEffectLedger({ store }),
    verifiers: createVerifierRegistry([
      createFixtureVerifier({ origin: fixture.origin }),
    ]),
    credentials: {
      // Roles resolve inside the trusted path. No value ever appears in a tool
      // argument, a plan, a result or a transcript.
      resolve: async (_actor, _plan, role) =>
        ({ email: owner.identifier, password: owner.password })[
          role as "email" | "password"
        ],
    },
  });
  const browserLogin = createBrowserLoginTools({
    service,
    sessions,
    backends: managedBackends,
    // Exactly one connector, so "it fell back to the first one it knew" would
    // look like success. POLICY-UNKNOWN relies on that.
    knownConnectors: () => new Set(["owned-fixture-login"]),
    credentialRefs: () => new Set([emailRef, passwordRef]),
    ...(options.allowUnverified === true ? { allowUnverified: true } : {}),
    evidenceFor: async (_actor, sessionRef) => ledger.get(sessionRef),
  });
  const runtime = createTeachingRuntime({
    store,
    registry: new OperationRegistry(),
    // The actor is taken from the transport. Here that is a header the test
    // controls, standing in for a session cookie; nothing reads the body.
    identity: {
      authenticate: async (request) =>
        actorFor(request.headers.get("x-client") ?? clientA),
    },
    origin,
    connections: new Map(),
    context: async () => ({
      provider: "fixture",
      profile: "fixture",
      target: "account",
      origin,
      environment: "test",
      configurationVersion: "v1",
    }),
    authorize: async () => true,
    browserLogin,
  });
  const mcp = createCeremonyMcpHandler(runtime, {
    resourceUrl: endpoint,
    issuer,
    // The bearer token names the client; the actor is derived here and never
    // from the tool arguments.
    authenticate: (token) =>
      token === clientB ? actorFor(clientB) : actorFor(clientA),
  });

  const http = async (path: string, body: unknown, client = clientA) => {
    const response = await teachingHttp(
      new Request(`${origin}/api/v1/teaching${path}`, {
        method: "POST",
        headers: {
          origin,
          "content-type": "application/json",
          "x-client": client,
        },
        body: JSON.stringify(body),
      }),
      runtime,
    );
    return { status: response.status, body: await response.json() };
  };

  const rpc = async (client: string, body: unknown) =>
    await mcp.fetch(
      new Request(endpoint, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
          authorization: `Bearer ${client}`,
        },
        body: JSON.stringify(body),
      }),
    );

  const readRpc = async (response: Response | undefined) => {
    const text = await response!.text();
    const line = text
      .split("\n")
      .find((candidate) => candidate.startsWith("data:"));
    return JSON.parse(line ? line.slice(5) : text) as {
      result?: {
        isError?: boolean;
        content?: { type: string; text: string }[];
      };
      error?: unknown;
    };
  };

  const tool = async (name: string, args: unknown, client = clientA) => {
    await rpc(client, {
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: { name: "test", version: "1" },
      },
    });
    const payload = await readRpc(
      await rpc(client, {
        jsonrpc: "2.0",
        id: 2,
        method: "tools/call",
        params: { name, arguments: args },
      }),
    );
    const text = payload.result?.content?.[0]?.text ?? "";
    return {
      isError: payload.result?.isError === true,
      text,
      value: payload.result?.isError === true ? undefined : JSON.parse(text),
    };
  };

  const listTools = async () =>
    JSON.stringify(
      await readRpc(
        await rpc(clientA, {
          jsonrpc: "2.0",
          id: 3,
          method: "tools/list",
          params: {},
        }),
      ),
    );

  return {
    store,
    sessions: registry,
    runtime,
    http,
    tool,
    listTools,
    async close() {
      await registry.disposeAll();
      await store.close();
    },
  };
}

describe("browser login tools", () => {
  test("TOOL-SURFACE: both transports offer exactly the four operations, and only where the host has a browser executor", async () => {
    const withBrowser = await harness();
    try {
      const listed = await withBrowser.listTools();
      for (const name of [
        "browser_login",
        "browser_session_status",
        "browser_release",
        "browser_backends",
      ])
        assert.ok(listed.includes(name), `${name} is not offered over MCP`);
    } finally {
      await withBrowser.close();
    }

    // A deployment with no browser executor offers no route and no tool at
    // all, rather than one that is advertised and always refuses.
    const store = new SQLiteCeremonyStore(":memory:", {
      current: "bare",
      keys: { bare: randomBytes(32) },
    });
    try {
      const runtime = createTeachingRuntime({
        store,
        registry: new OperationRegistry(),
        identity: { authenticate: async () => actorFor(clientA) },
        origin,
        connections: new Map(),
        context: async () => ({
          provider: "fixture",
          profile: "fixture",
          target: "account",
          origin,
          environment: "test",
          configurationVersion: "v1",
        }),
        authorize: async () => true,
      });
      const response = await teachingHttp(
        new Request(`${origin}/api/v1/teaching/tools/browser-backends`, {
          method: "POST",
          headers: { origin, "content-type": "application/json" },
          body: "{}",
        }),
        runtime,
      );
      assert.equal(response.status, 404);
      const mcp = createCeremonyMcpHandler(runtime, {
        resourceUrl: endpoint,
        issuer,
        authenticate: () => actorFor(clientA),
      });
      const listed = await mcp.fetch(
        new Request(endpoint, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            accept: "application/json, text/event-stream",
            authorization: `Bearer ${clientA}`,
          },
          body: JSON.stringify({
            jsonrpc: "2.0",
            id: 1,
            method: "tools/list",
            params: {},
          }),
        }),
      );
      assert.ok(!(await listed!.text()).includes("browser_login"));
    } finally {
      await store.close();
    }
  });

  test("TOOL-PARITY: the same arguments over HTTP and over MCP produce the same authorized effect", async () => {
    const h = await harness();
    try {
      // Capability negotiation first, because a client that cannot see what a
      // host offers can only guess. Both transports answer identically.
      const httpBackends = await h.http("/tools/browser-backends", {});
      const mcpBackends = await h.tool("browser_backends", {});
      assert.equal(httpBackends.status, 200);
      assert.deepEqual(httpBackends.body, mcpBackends.value);
      assert.deepEqual(httpBackends.body, {
        backends: managedBackends(),
        verificationRequired: true,
      });

      fixture.reset();
      const overHttp = await h.http("/tools/browser-login", loginArguments());
      assert.equal(overHttp.status, 200, JSON.stringify(overHttp.body));
      assert.equal(overHttp.body.status, "verified");
      assert.equal(overHttp.body.evidenceKind, "fixture-verified");
      // The oracle: the provider itself recorded one submission, for this
      // account, with a password it accepted, and holds one session for it.
      assert.equal(fixture.submissions().length, 1);
      assert.equal(fixture.submissions()[0]?.account, owner.account);
      assert.equal(fixture.submissions()[0]?.passwordMatched, true);
      assert.equal(fixture.sessionsFor(owner.account).length, 1);

      const statusOverHttp = await h.http("/tools/browser-session-status", {
        sessionRef: overHttp.body.sessionRef,
      });
      assert.equal(statusOverHttp.status, 200);
      assert.equal(statusOverHttp.body.verified, true);
      assert.equal(statusOverHttp.body.controllable, true);
      // The projection, never the record: no tenant, no subject, no executor
      // or context reference, and nothing that could be a control URL.
      assert.deepEqual(Object.keys(statusOverHttp.body).sort(), [
        "controllable",
        "engine",
        "evidenceKind",
        "expiresAt",
        "ownership",
        "scope",
        "sessionRef",
        "trustMode",
        "verified",
        "verifiedAt",
      ]);

      const releasedOverHttp = await h.http("/tools/browser-release", {
        sessionRef: overHttp.body.sessionRef,
        kind: "dispose-managed",
      });
      assert.deepEqual(releasedOverHttp.body, {
        kind: "dispose-managed",
        automationRevoked: true,
        managedResourcesDisposed: true,
        userBrowserPreserved: true,
        upstreamLogout: false,
      });

      fixture.reset();
      const overMcp = await h.tool("browser_login", loginArguments());
      assert.equal(overMcp.isError, false, overMcp.text);
      assert.equal(overMcp.value.status, "verified");
      assert.equal(overMcp.value.evidenceKind, "fixture-verified");
      assert.equal(fixture.submissions().length, 1);
      assert.equal(fixture.submissions()[0]?.account, owner.account);
      assert.equal(fixture.sessionsFor(owner.account).length, 1);

      const statusOverMcp = await h.tool("browser_session_status", {
        sessionRef: overMcp.value.sessionRef,
      });
      // Same shape, same claims. Only the minted references differ, because
      // they identify two different sessions.
      assert.deepEqual(
        Object.keys(statusOverMcp.value).sort(),
        Object.keys(statusOverHttp.body).sort(),
      );
      assert.equal(statusOverMcp.value.verified, true);
      assert.equal(statusOverMcp.value.controllable, true);
      assert.deepEqual(statusOverMcp.value.scope, statusOverHttp.body.scope);

      const releasedOverMcp = await h.tool("browser_release", {
        sessionRef: overMcp.value.sessionRef,
        kind: "dispose-managed",
      });
      assert.deepEqual(releasedOverMcp.value, releasedOverHttp.body);
      // Ceremony closed a browser it started. The provider never heard about
      // it, and neither transport implies otherwise.
      assert.equal(fixture.sessionsFor(owner.account).length, 1);
    } finally {
      await h.close();
    }
  });

  test("CLIENT-OWNER: a second client of the same person may read a session but not drive it", async () => {
    const h = await harness();
    try {
      fixture.reset();
      const login = await h.http("/tools/browser-login", loginArguments());
      assert.equal(login.body.status, "verified");
      const sessionRef = login.body.sessionRef;

      // Reading is allowed — the session belongs to this subject — and the
      // honest answer to "may I drive it?" is the `controllable` flag itself.
      const seen = await h.http(
        "/tools/browser-session-status",
        { sessionRef },
        clientB,
      );
      assert.equal(seen.status, 200);
      assert.equal(seen.body.sessionRef, sessionRef);
      assert.equal(seen.body.controllable, false);

      // Driving is refused, by the registry's lease check, with the exact
      // structured denial and nothing else in it.
      const denied = await h.http(
        "/tools/browser-release",
        { sessionRef, kind: "dispose-managed" },
        clientB,
      );
      assert.equal(denied.status, 409);
      assert.deepEqual(denied.body, {
        error: "lease-conflict",
        reason: "lease-conflict",
      });

      const deniedOverMcp = await h.tool(
        "browser_release",
        { sessionRef, kind: "dispose-managed" },
        clientB,
      );
      assert.equal(deniedOverMcp.isError, true);
      assert.equal(
        deniedOverMcp.text,
        "Another client controls that browser session.",
      );

      // Nothing was disposed by the refusal, and the holder can still act.
      assert.equal(fixture.sessionsFor(owner.account).length, 1);
      const released = await h.http("/tools/browser-release", {
        sessionRef,
        kind: "dispose-managed",
      });
      assert.equal(released.body.managedResourcesDisposed, true);
    } finally {
      await h.close();
    }
  });

  test("POLICY-UNKNOWN: an unknown connector is rejected by name and never falls back to a known one", async () => {
    const h = await harness();
    try {
      fixture.reset();
      const refused = await h.http("/tools/browser-login", {
        ...loginArguments(),
        connectorId: "not-registered",
      });
      assert.equal(refused.status, 400);
      assert.deepEqual(refused.body, {
        error: "plan-rejected",
        reason: "unknown-connector",
      });

      const refusedOverMcp = await h.tool("browser_login", {
        ...loginArguments(),
        connectorId: "not-registered",
      });
      assert.equal(refusedOverMcp.isError, true);
      assert.equal(
        refusedOverMcp.text,
        "That connection configuration was rejected: unknown-connector.",
      );

      // The deployment knows exactly one connector, one backend and one
      // account, so a fallback to "the first one" would have logged in. The
      // provider says nothing was attempted at all.
      assert.equal(fixture.submissions().length, 0);
      assert.equal(fixture.sessionsFor(owner.account).length, 0);
    } finally {
      await h.close();
    }
  });

  test("POLICY-VERIFY: a client asking for an unverified attempt cannot have one", async () => {
    const strict = await harness();
    try {
      fixture.reset();
      const refused = await strict.http(
        "/tools/browser-login",
        loginArguments({ requireVerification: false }),
      );
      assert.equal(refused.status, 400);
      assert.deepEqual(refused.body, {
        error: "plan-rejected",
        reason: "verification-required",
      });

      const refusedOverMcp = await strict.tool(
        "browser_login",
        loginArguments({ requireVerification: false }),
      );
      assert.equal(refusedOverMcp.isError, true);
      assert.equal(
        refusedOverMcp.text,
        "That connection configuration was rejected: verification-required.",
      );
      assert.equal(fixture.submissions().length, 0);

      // Backend negotiation says so in advance rather than only as a refusal.
      const negotiated = await strict.http("/tools/browser-backends", {});
      assert.equal(negotiated.body.verificationRequired, true);
    } finally {
      await strict.close();
    }
  });

  test("POLICY-VERIFY: only the host can permit an unverified attempt, and it is still not a verified result", async () => {
    const permissive = await harness({ allowUnverified: true });
    try {
      fixture.reset();
      const negotiated = await permissive.http("/tools/browser-backends", {});
      assert.equal(negotiated.body.verificationRequired, false);

      // The host allowed it, so the plan compiles — and the outcome is the
      // lesser one. There is no configuration a client can send that turns a
      // login with no verifier evidence into `verified`.
      const attempted = await permissive.http(
        "/tools/browser-login",
        loginArguments({
          requireVerification: false,
          verifierOrigin: undefined,
        }),
      );
      assert.equal(attempted.status, 200, JSON.stringify(attempted.body));
      assert.equal(attempted.body.status, "submitted-unverified");
      assert.equal(attempted.body.evidenceKind, undefined);

      const status = await permissive.http("/tools/browser-session-status", {
        sessionRef: attempted.body.sessionRef,
      });
      assert.equal(status.body.verified, false);
      assert.equal(status.body.evidenceKind, undefined);
      await permissive.http("/tools/browser-release", {
        sessionRef: attempted.body.sessionRef,
        kind: "dispose-managed",
      });
    } finally {
      await permissive.close();
    }
  });

  test("POLICY-CREDENTIAL: a credential value in the arguments is refused by shape", async () => {
    const h = await harness();
    try {
      fixture.reset();
      for (const args of [
        // A password typed where a reference belongs.
        loginArguments({ credentialRefs: { password: "hunter2" } }),
        // A value smuggled beside the references.
        loginArguments({ password: owner.password }),
        loginArguments({ credentials: { password: owner.password } }),
      ]) {
        const refused = await h.http("/tools/browser-login", args);
        assert.equal(refused.status, 400, JSON.stringify(refused.body));
        assert.deepEqual(refused.body, { error: "invalid_request" });
        const overMcp = await h.tool("browser_login", args);
        assert.equal(overMcp.isError, true);
      }
      assert.equal(fixture.submissions().length, 0);
      assert.equal(fixture.sessionsFor(owner.account).length, 0);
    } finally {
      await h.close();
    }
  });

  test("POLICY-CLAIM: a client-supplied verification, actor or plan digest is refused, not ignored", async () => {
    const h = await harness();
    try {
      fixture.reset();
      for (const args of [
        loginArguments({ verified: true }),
        loginArguments({ effectivePlanDigest: "0".repeat(64) }),
        loginArguments({ backendId: "managed-chromium" }),
        { ...loginArguments(), actor: actorFor(clientB) },
        { ...loginArguments(), verified: true },
      ]) {
        const refused = await h.http("/tools/browser-login", args);
        assert.equal(refused.status, 400, JSON.stringify(refused.body));
        assert.deepEqual(refused.body, { error: "invalid_request" });
      }
      assert.equal(fixture.submissions().length, 0);
    } finally {
      await h.close();
    }
  });

  test("POLICY-BOUNDS: malformed and oversized arguments are refused before anything launches", async () => {
    const h = await harness();
    try {
      fixture.reset();
      const tooManyOrigins = Array.from(
        { length: 17 },
        (_unused, index) => `https://origin-${index}.example`,
      );
      for (const args of [
        loginArguments({ navigationOrigins: tooManyOrigins }),
        loginArguments({ entryUrl: `${fixture.origin}/${"a".repeat(2100)}` }),
        loginArguments({ interactionRounds: 9 }),
        loginArguments({ sessionTtlMs: 1 }),
        loginArguments({ engine: "internet-explorer" }),
        // An origin with userinfo is not a canonical origin, and a wildcard
        // host is not an origin at all.
        loginArguments({
          navigationOrigins: ["https://user:pw@provider.example"],
        }),
        loginArguments({ navigationOrigins: ["https://*.provider.example"] }),
        { connectorId: "owned-fixture-login" },
        { connectorId: "owned-fixture-login", draft: "not-an-object" },
      ]) {
        const refused = await h.http("/tools/browser-login", args);
        assert.equal(refused.status, 400, JSON.stringify(refused.body));
      }

      // A reference has a shape. A run reference, a bare string or a session
      // reference from another family is a validation error, not a lookup.
      for (const sessionRef of [
        "bsess_not-hex",
        "brun_00000000000000000000000000000000",
        "../../etc/passwd",
        "a".repeat(200),
      ]) {
        const status = await h.http("/tools/browser-session-status", {
          sessionRef,
        });
        assert.equal(status.status, 400);
        assert.deepEqual(status.body, { error: "invalid_request" });
        const release = await h.http("/tools/browser-release", {
          sessionRef,
          kind: "dispose-managed",
        });
        assert.equal(release.status, 400);
      }

      // A release kind outside the three that exist, and an unknown extra key.
      assert.equal(
        (
          await h.http("/tools/browser-release", {
            sessionRef: `bsess_${"0".repeat(32)}`,
            kind: "log-out-upstream",
          })
        ).status,
        400,
      );
      assert.equal(
        (await h.http("/tools/browser-backends", { engine: "chromium" }))
          .status,
        400,
      );
      assert.equal(fixture.submissions().length, 0);
      assert.equal(fixture.sessionsFor(owner.account).length, 0);
    } finally {
      await h.close();
    }
  });

  test("POLICY-SESSION: a reference this server never minted is denied, not probed", async () => {
    const h = await harness();
    try {
      const unknown = `bsess_${"a".repeat(32)}`;
      const status = await h.http("/tools/browser-session-status", {
        sessionRef: unknown,
      });
      assert.equal(status.status, 403);
      assert.deepEqual(status.body, { error: "denied" });
      const release = await h.http("/tools/browser-release", {
        sessionRef: unknown,
        kind: "dispose-managed",
      });
      assert.equal(release.status, 403);
      assert.deepEqual(release.body, { error: "denied" });
    } finally {
      await h.close();
    }
  });

  test("EFFECT-DUP: a client's retry with the same key does not log in twice", async () => {
    const h = await harness();
    try {
      fixture.reset();
      const first = await h.tool("browser_login", {
        ...loginArguments(),
        idempotencyKey: "client-retry-1",
      });
      assert.equal(first.isError, false, first.text);
      assert.equal(first.value.status, "verified");

      // A client whose connection dropped asks again with the same key. Without
      // this, the deduplication built into the service would exist only for
      // in-process callers and every real client would still double-submit.
      const again = await h.tool("browser_login", {
        ...loginArguments(),
        idempotencyKey: "client-retry-1",
      });
      assert.equal(again.isError, false, again.text);
      // The retry is answered with the first call's own result, so a client
      // that lost the response learns it succeeded rather than being told
      // something that reads like a failure.
      assert.deepEqual(again.value, first.value);

      // The provider's own records, not the tool's report of itself.
      assert.equal(fixture.submissions().length, 1);
      assert.equal(fixture.sessionsFor(owner.account).length, 1);

      // Over HTTP too: the two transports share one implementation and must not
      // drift on something a caller relies on for safety.
      fixture.reset();
      const overHttp = await h.http("/tools/browser-login", {
        ...loginArguments(),
        idempotencyKey: "client-retry-2",
      });
      assert.equal(overHttp.status, 200, JSON.stringify(overHttp.body));
      const repeated = await h.http("/tools/browser-login", {
        ...loginArguments(),
        idempotencyKey: "client-retry-2",
      });
      assert.equal(repeated.status, 200);
      assert.equal(fixture.submissions().length, 1);
    } finally {
      await h.close();
    }
  });
});
