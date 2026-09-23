import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { after, before, describe, test } from "node:test";
import { createGitHubRuntime } from "../src/server/github-runtime.js";
import { teachingHttp } from "../src/server/teaching-http.js";
import { createCeremonyMcpHandler } from "../src/server/mcp.js";
import { SQLiteCeremonyStore } from "../src/server/persistence/index.js";
import { managedBackends } from "../src/server/browser-backends.js";
import { createBrowserLoginTools } from "../src/server/browser-login-tools.js";
import { createFixtureVerifier } from "../src/server/browser-verification.js";
import {
  withEvidenceLedger,
  type HostBrowserLoginOptions,
} from "../src/server/browser-login-host.js";
import type { BrowserLoginService } from "../src/server/browser-login-service.js";
import type { BrowserSessionRegistry } from "../src/server/browser-sessions.js";
import type { HumanParticipation } from "../src/server/browser-driver.js";
import type { ActorContext } from "../src/core/operation-contracts.js";
import type { LoginEvidence } from "../src/core/browser-session-contracts.js";
import {
  createIdentityFixture,
  defaultFixtureAccounts,
  type IdentityFixture,
} from "./fixtures/identity-provider.js";

/**
 * The retained-browser login tools, reached through the reference host.
 *
 * Everything below existed before and was only ever assembled inside tests, so
 * no host offered `browser_login` at all. These cases go through
 * `createGitHubRuntime` — the same constructor the example server calls — and
 * then through the transports a client actually uses, with the identity
 * fixture's own records as the oracle for what reached the provider.
 */

const owner = defaultFixtureAccounts[0]!;
const origin = "https://app.example";
const endpoint = `${origin}/mcp`;
const actor: ActorContext = {
  tenantId: "host-tenant",
  subjectId: "host-subject",
  sessionId: "host-client",
  actorKind: "human",
  capabilities: ["executor"],
};
const emailRef = randomUUID();
const passwordRef = randomUUID();

let fixture: IdentityFixture;
before(async () => {
  fixture = await createIdentityFixture();
});
after(async () => {
  await fixture.close();
});

function host(
  browserLogin?: Omit<HostBrowserLoginOptions, "store">,
  store = new SQLiteCeremonyStore(":memory:", {
    current: "host",
    keys: { host: randomBytes(32) },
  }),
) {
  const runtime = createGitHubRuntime({
    store,
    identity: { authenticate: async () => actor },
    origin,
    environment: "test",
    configurationVersion: "v1",
    authorize: async () => true,
    ...(browserLogin ? { browserLogin } : {}),
  });
  const mcp = createCeremonyMcpHandler(runtime, {
    resourceUrl: endpoint,
    issuer: "https://issuer.example",
    authenticate: () => actor,
  });
  const http = async (path: string, body: unknown) => {
    const response = await teachingHttp(
      new Request(`${origin}/api/v1/teaching${path}`, {
        method: "POST",
        headers: { origin, "content-type": "application/json" },
        body: JSON.stringify(body),
      }),
      runtime,
    );
    return { status: response.status, body: await response.json() };
  };
  const listTools = async () =>
    (await mcp.fetch(
      new Request(endpoint, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
          authorization: "Bearer host-client",
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "tools/list",
          params: {},
        }),
      }),
    ))!.text();
  return { store, runtime, http, listTools };
}

const configured = (
  extra: Partial<Omit<HostBrowserLoginOptions, "store">> = {},
): Omit<HostBrowserLoginOptions, "store"> => ({
  credentials: {
    resolve: async (_actor, _plan, role) =>
      ({ email: owner.identifier, password: owner.password })[
        role as "email" | "password"
      ],
  },
  knownConnectors: () => new Set(["owned-fixture-login"]),
  verifiers: [createFixtureVerifier({ origin: fixture.origin })],
  ...extra,
});

const loginArguments = (entryPath = "/signin") => ({
  connectorId: "owned-fixture-login",
  draft: {
    engine: "chromium",
    ownership: "managed",
    entryUrl: fixture.url(entryPath),
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
  },
});

const browserTools = [
  "browser_login",
  "browser_session_status",
  "browser_release",
  "browser_backends",
];

describe("HOST-WIRED: the reference host offers browser login only when configured", () => {
  test("configured, all four tools are offered over MCP and the routes answer", async () => {
    const h = host(configured());
    try {
      const listed = await h.listTools();
      for (const name of browserTools)
        assert.ok(listed.includes(name), `${name} is not offered over MCP`);
      const backends = await h.http("/tools/browser-backends", {});
      assert.equal(backends.status, 200);
      assert.equal(backends.body.verificationRequired, true);
      assert.ok(backends.body.backends.length > 0);
    } finally {
      await h.store.close();
    }
  });

  test("unconfigured, no tool is offered and no route exists", async () => {
    const h = host();
    try {
      const listed = await h.listTools();
      for (const name of browserTools) assert.ok(!listed.includes(name), name);
      assert.equal((await h.http("/tools/browser-backends", {})).status, 404);
    } finally {
      await h.store.close();
    }
  });
});

describe("HOST-LOGIN: a login through the host's route verifies and stays verified", () => {
  test("verified by the provider, with a live verified status from the host's evidence", async () => {
    fixture.reset();
    const h = host(configured());
    let sessionRef: string | undefined;
    try {
      const login = await h.http("/tools/browser-login", loginArguments());
      assert.equal(login.status, 200, JSON.stringify(login.body));
      assert.equal(login.body.status, "verified", JSON.stringify(login.body));
      sessionRef = login.body.sessionRef;
      // The provider's own record: one submission, for the expected account.
      assert.deepEqual(
        fixture.submissions().map((s) => [s.account, s.passwordMatched]),
        [[owner.account, true]],
      );
      const status = await h.http("/tools/browser-session-status", {
        sessionRef,
      });
      assert.equal(status.status, 200);
      assert.equal(status.body.verified, true, JSON.stringify(status.body));
      assert.equal(status.body.controllable, true);
      // Nothing a client receives carries the password.
      assert.ok(
        !JSON.stringify([login.body, status.body]).includes(owner.password),
      );
    } finally {
      if (sessionRef)
        await h.http("/tools/browser-release", {
          sessionRef,
          kind: "dispose-managed",
        });
      await h.store.close();
    }
  });
});

describe("HOST-REUSE: a verified session is kept and the next login starts from it", () => {
  /** Log in twice through one host and report what the provider received. */
  async function twice(reuseVerifiedSessions: boolean) {
    fixture.reset();
    const h = host(configured({ reuseVerifiedSessions }));
    const refs: string[] = [];
    try {
      const results = [];
      for (let attempt = 0; attempt < 2; attempt++) {
        const login = await h.http(
          "/tools/browser-login",
          // `/account` offers a sign-in link when signed out and the account
          // when signed in, so a restored session has nothing left to submit.
          loginArguments("/account"),
        );
        results.push(login.body);
        if (login.body.sessionRef) refs.push(login.body.sessionRef);
        // The first browser is gone before the second login starts: whatever
        // the second one knows, it learned from the store, not from a process
        // that was still running.
        if (login.body.sessionRef)
          await h.http("/tools/browser-release", {
            sessionRef: login.body.sessionRef,
            kind: "dispose-managed",
          });
      }
      return { results, submissions: fixture.submissions().length };
    } finally {
      await h.store.close();
    }
  }

  test("with reuse on, the second login is verified without a second submission", async () => {
    const run = await twice(true);
    assert.deepEqual(
      run.results.map((result) => result.status),
      ["verified", "verified"],
      JSON.stringify(run.results),
    );
    assert.equal(run.submissions, 1);
  });

  test("with reuse off (the default), every login submits again", async () => {
    const run = await twice(false);
    assert.deepEqual(
      run.results.map((result) => result.status),
      ["verified", "verified"],
      JSON.stringify(run.results),
    );
    assert.equal(run.submissions, 2);
  });
});

describe("HOST-HUMAN: the host's participation reaches the login, bound to the compiled plan", () => {
  test("the human dependency is resolved per actor and plan and handed to the service", async () => {
    const participation: HumanParticipation = {
      contract: {
        surface: "provider-browser",
        recipient: "initiating-subject",
        delegation: "a2h-authorize",
        resume: "verify",
      },
      request: async () => "completed",
    };
    const seen: { digest?: string; human?: unknown } = {};
    const service = {
      login: async (_actor: ActorContext, input: { human?: unknown }) => {
        seen.human = input.human;
        return {
          status: "blocked",
          runRef: `brun_${"0".repeat(32)}`,
          reason: "provider-error",
        };
      },
    } as unknown as BrowserLoginService;
    const tools = createBrowserLoginTools({
      service,
      sessions: {} as BrowserSessionRegistry,
      backends: managedBackends,
      knownConnectors: () => new Set(["owned-fixture-login"]),
      human: (who, plan) => {
        assert.equal(who, actor);
        seen.digest = plan.digest;
        return participation;
      },
    });
    await tools.login(actor, loginArguments());
    assert.equal(seen.human, participation);
    assert.match(seen.digest ?? "", /^[0-9a-f]{64}$/);
  });
});

describe("HOST-LEDGER: the host's evidence ledger forgets a released session", () => {
  test("evidence goes with the session, and a cancelled run keeps it", async () => {
    const evidence = { kind: "fixture-verified" } as unknown as LoginEvidence;
    const registry = {
      recordEvidence: async () => ({}),
      release: async () => ({}),
    } as unknown as BrowserSessionRegistry;
    const { sessions, evidenceFor } = withEvidenceLedger(registry);
    for (const kind of ["dispose-managed", "release-control"] as const) {
      await sessions.recordEvidence(actor, "bses_one", evidence, "bevd_one");
      assert.equal(await evidenceFor(actor, "bses_one"), evidence);
      await sessions.release(actor, "bses_one", "cancel-run");
      assert.equal(await evidenceFor(actor, "bses_one"), evidence);
      await sessions.release(actor, "bses_one", kind);
      assert.equal(await evidenceFor(actor, "bses_one"), undefined, kind);
    }
  });
});
