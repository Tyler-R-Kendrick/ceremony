import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, describe, test, type TestContext } from "node:test";
import {
  managedBackends,
  UnsupportedBackend,
} from "../src/server/browser-backends.js";
import {
  createEffectLedger,
  effectIsIndeterminate,
  type EffectLedger,
} from "../src/server/browser-effects.js";
import { createBrowserLoginService } from "../src/server/browser-login-service.js";
import { createBrowserSessionRegistry } from "../src/server/browser-sessions.js";
import {
  createFixtureVerifier,
  createVerifierRegistry,
} from "../src/server/browser-verification.js";
import { compileLoginPlan, PlanRejected } from "../src/server/login-plan.js";
import {
  recordKinds,
  SQLiteCeremonyStore,
} from "../src/server/persistence/index.js";
import type { ActorContext } from "../src/core/operation-contracts.js";
import type {
  IssuedSinkKind,
  PageSnapshot,
} from "../src/core/browser-contracts.js";
import type { CeremonyPage } from "../src/server/browser-driver.js";
import { createHostBrowserLogin } from "../src/server/browser-login-host.js";
import {
  browserLoginAgentToolInputs,
  browserLoginToolInputs,
} from "../src/server/browser-login-tools.js";
import {
  mintOAuthClient,
  readOAuthClient,
} from "../src/server/recipes/common.js";
import { createHttpCeremonyPage } from "./doubles/http-page.js";
import { startAuthProvider } from "./doubles/auth-provider/server.js";
import { oauthAppsPath } from "./doubles/auth-provider/developer-settings.js";

/**
 * The login service's decisions, with the browser replaced by a stub.
 *
 * The conformance suite runs this path through three real engines and is the
 * evidence that it works. What a real browser makes awkward is staging the
 * *unhappy* branches on demand — a backend that cannot do what the plan
 * requires, a provider with no registered verifier, a page that never presents
 * a form. Those are here, and the stub exists only to make them reachable.
 */

const origin = "https://provider.example";
const actor: ActorContext = {
  tenantId: "tenant-s",
  subjectId: "subject-s",
  sessionId: "client-s",
  actorKind: "human",
  capabilities: ["executor"],
};

let store: SQLiteCeremonyStore;
before(() => {
  store = new SQLiteCeremonyStore(":memory:", {
    current: "service",
    keys: { service: new Uint8Array(32) },
  });
});
after(async () => store.close());

const emptyPage: PageSnapshot = {
  path: `${origin}/signin`,
  title: "Sign in",
  headings: [],
  alerts: [],
  challenge: false,
  passkey: false,
  elements: [],
};

/**
 * A login page with something to submit, for the cases about what happens when
 * a submission goes out and its outcome never comes back.
 */
const loginPage: PageSnapshot = {
  path: `${origin}/signin`,
  title: "Sign in",
  headings: [],
  alerts: [],
  challenge: false,
  passkey: false,
  elements: [
    // Already filled, so the deterministic interpreter's next move is the
    // submit button rather than the field. The fill itself is not what these
    // cases are about — what happens after the click is.
    {
      index: 0,
      kind: "input",
      type: "password",
      name: "password",
      label: "Password",
      filled: true,
    },
    { index: 1, kind: "button", text: "Sign in" },
  ],
};

/** A managed browser that opens nothing and records whether it was disposed. */
function stubBackend(
  answer: { status: number; body: string },
  /** A page, or a factory for a fresh one per launch, as a real browser gives. */
  page: Partial<CeremonyPage> | (() => Partial<CeremonyPage>) = {},
) {
  const state = { disposed: 0, contextsClosed: 0 };
  const launch = (async () => ({
    descriptor: managedBackends()[0]!,
    browserGeneration: "bgen_stub",
    alive: () => true,
    async openContext() {
      return {
        contextRef: "bctx_00000000000000000000000000000002",
        request: {
          get: async () => ({
            status: () => answer.status,
            text: async () => answer.body,
          }),
        },
        async openPage() {
          return {
            targetRef: "btgt_00000000000000000000000000000002",
            raw: {} as never,
            page: {
              url: async () => `${origin}/signin`,
              goto: async () => {},
              // A page with no controls: the interpreter runs out of moves and
              // the drive ends without having submitted anything.
              snapshot: async () => emptyPage,
              fill: async () => {},
              click: async () => {},
              check: async () => {},
              settle: async () => {},
              ...(typeof page === "function" ? page() : page),
            },
          };
        },
        alive: async () => true,
        async close() {
          state.contextsClosed++;
        },
      };
    },
    async dispose() {
      state.disposed++;
    },
  })) as never;
  return { launch, state };
}

function planFor(overrides: Record<string, unknown> = {}) {
  return compileLoginPlan(
    {
      connectorId: "owned-fixture-login",
      engine: "chromium",
      ownership: "managed",
      entryUrl: `${origin}/signin`,
      navigationOrigins: [origin],
      credentialRecipients: { password: [origin] },
      account: { kind: "accept-existing" },
      continuation: "retain-for-authorized-agent",
      trustMode: "constrained-auth",
      interactionRounds: 0,
      requireVerification: true,
      verifierOrigin: origin,
      credentialRefs: { password: "ref-password" },
      sessionTtlMs: 600_000,
      ...overrides,
    },
    {
      backends: managedBackends(),
      knownConnectors: new Set(["owned-fixture-login"]),
      revision: 1,
    },
  );
}

function serviceWith(
  backend: ReturnType<typeof stubBackend>,
  options: {
    verifiers?: boolean;
    effects?: boolean;
    /** Stand in a ledger that fails where a real store can fail. */
    ledger?: EffectLedger;
  } = {},
) {
  const sessions = createBrowserSessionRegistry({ store });
  const effects = options.ledger ?? createEffectLedger({ store });
  const service = createBrowserLoginService({
    sessions,
    ...(options.effects === false ? {} : { effects }),
    verifiers:
      options.verifiers === false
        ? createVerifierRegistry([])
        : createVerifierRegistry([createFixtureVerifier({ origin })]),
    credentials: { resolve: async () => "correct-horse" },
    launch: backend.launch,
  });
  return { sessions, service, effects };
}

describe("login service outcomes", () => {
  test("a verified account retains a session and records its evidence", async () => {
    const backend = stubBackend({ status: 200, body: '{"account":"ada"}' });
    const { sessions, service } = serviceWith(backend);
    const result = await service.login(actor, { plan: planFor() });
    assert.equal(result.status, "verified");
    if (result.status !== "verified") return;
    assert.equal(result.evidenceKind, "fixture-verified");
    // The browser is still there: retention is the deliverable.
    assert.equal(backend.state.disposed, 0);
    await assert.doesNotReject(() =>
      sessions.resolve(actor, result.sessionRef),
    );
    await sessions.disposeAll();
  });

  test("no registered verifier stops at submitted-unverified, not at verified", async () => {
    const backend = stubBackend({ status: 200, body: '{"account":"ada"}' });
    const { sessions, service } = serviceWith(backend, { verifiers: false });
    const result = await service.login(actor, { plan: planFor() });
    // Retaining the session is still useful and still true. Calling it
    // verified would not be, so it is not called that.
    assert.equal(result.status, "submitted-unverified");
    assert.ok(
      result.status === "submitted-unverified" && result.sessionRef,
      "an unverified session is still worth handing back",
    );
    await sessions.disposeAll();
  });

  test("a provider that reports no session yields submitted-unverified", async () => {
    const backend = stubBackend({ status: 401, body: "{}" });
    const { sessions, service } = serviceWith(backend);
    const result = await service.login(actor, { plan: planFor() });
    assert.equal(result.status, "submitted-unverified");
    // Nothing was retained to hand to anyone, so the browser is released.
    assert.equal(backend.state.disposed, 1);
    await sessions.disposeAll();
  });

  test("AUTH-WRONG: the wrong account blocks rather than succeeding", async () => {
    const backend = stubBackend({ status: 200, body: '{"account":"grace"}' });
    const { sessions, service } = serviceWith(backend);
    const result = await service.login(actor, {
      plan: planFor({ account: { kind: "expect", accountRef: "ada" } }),
    });
    assert.equal(result.status, "blocked");
    assert.equal(
      result.status === "blocked" ? result.reason : undefined,
      "account-mismatch",
    );
    assert.equal(backend.state.disposed, 1);
    await sessions.disposeAll();
  });

  test("LIFE-LEGACY: a dispose continuation verifies and then lets go", async () => {
    const backend = stubBackend({ status: 200, body: '{"account":"ada"}' });
    const { sessions, service } = serviceWith(backend);
    const result = await service.login(actor, {
      plan: planFor({ continuation: "dispose" }),
    });
    assert.equal(result.status, "verified");
    if (result.status !== "verified") return;
    await assert.rejects(() => sessions.resolve(actor, result.sessionRef));
    await sessions.disposeAll();
  });

  test("a backend that cannot meet the plan is named, not attempted", async () => {
    const { sessions, service } = serviceWith({
      launch: (async () => {
        throw new UnsupportedBackend("managed-chromium", [
          "strongEgressContainment",
        ]);
      }) as never,
      state: { disposed: 0, contextsClosed: 0 },
    });
    const result = await service.login(actor, { plan: planFor() });
    assert.deepEqual(
      result.status === "blocked" ? result.reason : result.status,
      "unsupported-capability",
    );
    await sessions.disposeAll();
  });

  test("a browser that will not start is a different answer again", async () => {
    const { sessions, service } = serviceWith({
      launch: (async () => {
        throw new Error("browserType.launch: Executable doesn't exist");
      }) as never,
      state: { disposed: 0, contextsClosed: 0 },
    });
    const result = await service.login(actor, { plan: planFor() });
    // A caller's next move differs: one is a configuration problem, the other
    // an environment problem.
    assert.deepEqual(
      result.status === "blocked" ? result.reason : result.status,
      "target-unavailable",
    );
    await sessions.disposeAll();
  });
});

describe("attestation", () => {
  test("a person's report is recorded against the session without verifying it", async () => {
    const backend = stubBackend({ status: 200, body: '{"account":"ada"}' });
    const { sessions, service } = serviceWith(backend, { verifiers: false });
    const result = await service.login(actor, { plan: planFor() });
    assert.equal(result.status, "submitted-unverified");
    if (result.status !== "submitted-unverified" || !result.sessionRef) return;

    const plan = planFor();
    const evidence = await service.attest(actor, {
      sessionRef: result.sessionRef,
      accountRef: "ada",
      plan,
      browserGeneration: "bgen_stub",
    });
    assert.equal(evidence.kind, "human-attested");

    // Recorded, and still not verified: the status projection recomputes from
    // the evidence kind rather than trusting that something was written down.
    const status = await sessions.status(actor, result.sessionRef, {
      evidence,
      planDigest: plan.digest,
    });
    assert.equal(status.evidenceKind, "human-attested");
    assert.equal(status.verified, false);
    await sessions.disposeAll();
  });

  test("an attestation naming another browser is refused", async () => {
    const backend = stubBackend({ status: 200, body: '{"account":"ada"}' });
    const { sessions, service } = serviceWith(backend, { verifiers: false });
    const result = await service.login(actor, { plan: planFor() });
    if (result.status !== "submitted-unverified" || !result.sessionRef) {
      assert.fail("expected a retained unverified session");
      return;
    }
    await assert.rejects(() =>
      service.attest(actor, {
        sessionRef: result.sessionRef!,
        accountRef: "ada",
        plan: planFor(),
        browserGeneration: "bgen_somewhere-else",
      }),
    );
    await sessions.disposeAll();
  });
});

describe("a submission whose outcome never came back", () => {
  /** A page that submits and then loses the browser out from under itself. */
  const vanishingPage = (): Partial<CeremonyPage> => ({
    snapshot: async () => loginPage,
    submissionTarget: async () => origin,
    click: async () => {
      throw new Error("Target page, context or browser has been closed");
    },
  });

  /** A page that submits once, successfully, and then has nothing left to do. */
  const submittingPage = (): Partial<CeremonyPage> => {
    let clicked = false;
    return {
      snapshot: async () => (clicked ? emptyPage : loginPage),
      submissionTarget: async () => origin,
      click: async () => {
        clicked = true;
      },
    };
  };

  test("EFFECT-LOST: a dispatch with no answer is undetermined, not blocked", async () => {
    const backend = stubBackend(
      { status: 200, body: '{"account":"ada"}' },
      vanishingPage(),
    );
    const { sessions, service, effects } = serviceWith(backend);
    const result = await service.login(actor, {
      plan: planFor(),
      idempotencyKey: "lost-1",
    });
    try {
      // The old answer here was `blocked` / `provider-error`, which a caller
      // reads as "nothing happened, try again". The credential had already gone
      // to the provider.
      assert.equal(
        result.status,
        "indeterminate",
        `expected an undetermined outcome, got ${JSON.stringify(result)}`,
      );
      if (result.status !== "indeterminate") return;
      // A ledger is configured here, so the reference must be present and must
      // resolve. The case below covers the deployment that has no ledger.
      assert.ok(
        result.effectRef,
        "an attempt recorded in a ledger must say where it was recorded",
      );
      assert.match(result.effectRef, /^beff_[0-9a-f]{32}$/);
      assert.equal(
        effectIsIndeterminate(await effects.read(actor, result.effectRef)),
        true,
      );
    } finally {
      await sessions.disposeAll();
    }
  });

  test("EFFECT-NOLEDGER: uncertainty is reported without inventing a record", async () => {
    // A deployment with no ledger still has to say that something was
    // dispatched and nobody learned the answer: that is the part a caller acts
    // on. What it must not do is hand back an `effectRef` nobody can look up,
    // which reads as a durable record and is a freshly minted string.
    const backend = stubBackend(
      { status: 200, body: '{"account":"ada"}' },
      vanishingPage(),
    );
    const { sessions, service } = serviceWith(backend, { effects: false });
    try {
      const result = await service.login(actor, { plan: planFor() });
      assert.equal(
        result.status,
        "indeterminate",
        `expected an undetermined outcome, got ${JSON.stringify(result)}`,
      );
      if (result.status !== "indeterminate") return;
      assert.equal(
        result.effectRef,
        undefined,
        "there is no ledger, so there is no reference to give",
      );
    } finally {
      await sessions.disposeAll();
    }
  });

  test("EFFECT-UNWRITABLE: a ledger that cannot close the record keeps the answer", async () => {
    // Closing the record is bookkeeping about an attempt that is already over.
    // A store failure there must not discard a verified login's `sessionRef`,
    // because this call has already retained the browser that holds it and
    // nothing else will ever hand it back.
    const backend = stubBackend(
      { status: 200, body: '{"account":"ada"}' },
      submittingPage(),
    );
    const broken: EffectLedger = {
      ...createEffectLedger({ store }),
      observed: async () => {
        throw new Error("store unavailable");
      },
    };
    const { sessions, service: fragile } = serviceWith(backend, {
      ledger: broken,
    });
    try {
      const result = await fragile.login(actor, {
        plan: planFor(),
        idempotencyKey: "unwritable-1",
      });
      assert.equal(
        result.status,
        "verified",
        `expected the login's own answer, got ${JSON.stringify(result)}`,
      );
      if (result.status !== "verified") return;
      assert.ok(result.sessionRef, "the retained session must still be named");
      // And the record it failed to close stays dispatched, so a replay of the
      // same key reports uncertainty rather than logging in a second time.
      const replay = await fragile.login(actor, {
        plan: planFor(),
        idempotencyKey: "unwritable-1",
      });
      assert.equal(
        replay.status,
        "indeterminate",
        `expected the unclosed record to refuse a replay, got ${JSON.stringify(replay)}`,
      );
    } finally {
      await sessions.disposeAll();
    }
  });

  test("a retry of an undetermined request is refused, not re-run", async () => {
    const backend = stubBackend(
      { status: 200, body: '{"account":"ada"}' },
      vanishingPage(),
    );
    const { sessions, service } = serviceWith(backend);
    try {
      const first = await service.login(actor, {
        plan: planFor(),
        idempotencyKey: "lost-2",
      });
      assert.equal(first.status, "indeterminate");
      const second = await service.login(actor, {
        plan: planFor(),
        idempotencyKey: "lost-2",
      });
      // The whole point: the second call does not open a browser and does not
      // submit anything. It reports the uncertainty the first one left behind.
      assert.equal(second.status, "indeterminate");
      assert.equal(backend.state.disposed, 1);
    } finally {
      await sessions.disposeAll();
    }
  });

  test("a failure before anything was sent stays a plain refusal", async () => {
    const backend = stubBackend(
      { status: 200, body: '{"account":"ada"}' },
      {
        snapshot: async () => {
          throw new Error("Target page, context or browser has been closed");
        },
      },
    );
    const { sessions, service } = serviceWith(backend);
    try {
      const result = await service.login(actor, {
        plan: planFor(),
        idempotencyKey: "never-sent",
      });
      // Nothing left the browser, so a caller may safely try again. Reporting
      // this as undetermined would be the mirror-image defect: it would make
      // every transient fault look like a possible double-submission.
      assert.equal(result.status, "blocked");
      if (result.status !== "blocked") return;
      assert.equal(result.reason, "provider-error");
      const replay = await service.login(actor, {
        plan: planFor(),
        idempotencyKey: "never-sent",
      });
      assert.equal(replay.status, "blocked");
    } finally {
      await sessions.disposeAll();
    }
  });

  test("a settled request with no recorded answer is spent, not cancelled", async () => {
    const backend = stubBackend({ status: 200, body: '{"account":"ada"}' });
    const { sessions, service, effects } = serviceWith(backend);
    try {
      // An effect settled by something that kept no answer — an older record,
      // or an attempt that ended before answers were stored.
      const claim = await effects.begin(actor, {
        runRef: "brun_00000000000000000000000000000009",
        effectivePlanDigest: planFor().digest,
        idempotencyKey: "no-answer",
      });
      assert.equal(claim.kind, "fresh");
      await effects.dispatching(actor, claim.record.effectRef, origin);
      await effects.observed(actor, claim.record.effectRef, "verified");

      const replay = await service.login(actor, {
        plan: planFor(),
        idempotencyKey: "no-answer",
      });
      assert.equal(replay.status, "blocked");
      if (replay.status !== "blocked") return;
      // `expired` says this request is spent. `cancelled` would say it stopped
      // before dispatch, which is the one thing known to be false here.
      assert.equal(replay.reason, "expired");
      assert.equal(backend.state.disposed, 0);
    } finally {
      await sessions.disposeAll();
    }
  });

  test("without a ledger the uncertainty is still reported, just not persisted", async () => {
    const backend = stubBackend(
      { status: 200, body: '{"account":"ada"}' },
      vanishingPage(),
    );
    const { sessions, service } = serviceWith(backend, { effects: false });
    try {
      const result = await service.login(actor, { plan: planFor() });
      // A deployment with nowhere to write a ledger still must not tell a
      // caller that a dispatched submission did not happen.
      assert.equal(result.status, "indeterminate");
    } finally {
      await sessions.disposeAll();
    }
  });
});

/* -------------------------------------------------------------------------- */
/* Issued values in production plans                                          */
/* -------------------------------------------------------------------------- */

const issuedDeclaration = {
  sink: "oauth-client",
  fields: [
    { kind: "client-id", label: "Client ID" },
    { kind: "client-secret", label: "Client secret" },
  ],
} as const;

describe("a plan that keeps what a provider page issues", () => {
  const compileWith = (
    overrides: Record<string, unknown>,
    sinks: readonly IssuedSinkKind[] = ["oauth-client"],
  ) =>
    compileLoginPlan(
      {
        connectorId: "owned-fixture-login",
        engine: "chromium",
        ownership: "managed",
        entryUrl: `${origin}/signin`,
        navigationOrigins: [origin],
        account: { kind: "accept-existing" },
        continuation: "dispose",
        trustMode: "constrained-auth",
        interactionRounds: 0,
        requireVerification: true,
        sessionTtlMs: 600_000,
        ...overrides,
      },
      {
        backends: managedBackends(),
        knownConnectors: new Set(["owned-fixture-login"]),
        issuedSinks: new Set(sinks),
        revision: 1,
      },
    );

  test("the declaration is part of the plan and of its digest", () => {
    const plain = compileWith({});
    const keeping = compileWith({ issued: issuedDeclaration });
    assert.deepEqual(keeping.issued, issuedDeclaration);
    assert.notEqual(plain.digest, keeping.digest);
    const chosen = compileWith({ choices: { "Country or region": "Canada" } });
    assert.deepEqual(chosen.choices, { "Country or region": "Canada" });
    assert.notEqual(plain.digest, chosen.digest);
  });

  test("a declaration is refused for an unknown kind, a repeated label, too many labels or a sink nobody registered", () => {
    const refusedAsInput = [
      // Not a kind a plan may keep.
      { sink: "oauth-client", fields: [{ kind: "api-key", label: "Key" }] },
      // Two kinds named by one label identify neither.
      {
        sink: "oauth-client",
        fields: [
          { kind: "client-id", label: "Client ID" },
          { kind: "client-secret", label: "Client ID" },
        ],
      },
      // More labels than there are kinds.
      {
        sink: "oauth-client",
        fields: [
          { kind: "client-id", label: "Client ID" },
          { kind: "client-secret", label: "Client secret" },
          { kind: "client-secret", label: "Secret" },
        ],
      },
      // A kind read from two fields.
      {
        sink: "credential-custody",
        fields: [
          { kind: "client-secret", label: "Client secret" },
          { kind: "client-secret", label: "Secret" },
        ],
      },
      // A client handle with no client in it.
      {
        sink: "oauth-client",
        fields: [{ kind: "client-secret", label: "Client secret" }],
      },
      // Not a sink at all: a sink is a kind, never a callback or an address.
      { sink: "https://collector.example/keep", fields: [] },
      { sink: "oauth-client", fields: [] },
      // A label that is itself shaped like a value.
      {
        sink: "oauth-client",
        fields: [{ kind: "client-id", label: "oac_1234567890abcdef" }],
      },
    ];
    for (const issued of refusedAsInput)
      assert.throws(
        () => compileWith({ issued }),
        (error: unknown) => !(error instanceof PlanRejected),
        JSON.stringify(issued),
      );
    // Well-formed, and nowhere trusted to put it on this host.
    assert.throws(
      () => compileWith({ issued: issuedDeclaration }, []),
      (error: unknown) =>
        error instanceof PlanRejected &&
        error.reason === "issued-sink-unavailable",
    );
    assert.throws(
      () =>
        compileWith(
          {
            issued: {
              sink: "credential-custody",
              fields: [{ kind: "client-secret", label: "Client secret" }],
            },
          },
          ["oauth-client"],
        ),
      (error: unknown) =>
        error instanceof PlanRejected &&
        error.reason === "issued-sink-unavailable",
    );
    // A choice is page text, and a secret is not one.
    for (const choices of [
      { "Country or region": "pw-Canary-1234567890" },
      { "Country or region": "casey@example.test" },
      Object.fromEntries(
        Array.from({ length: 9 }, (_, index) => [`Field ${index}`, "Yes"]),
      ),
    ])
      assert.throws(() => compileWith({ choices }), JSON.stringify(choices));
  });

  test("the service refuses a plan whose sink it was not given, before a browser starts", async () => {
    const backend = stubBackend({ status: 200, body: '{"account":"ada"}' });
    const { service } = serviceWith(backend);
    const result = await service.login(actor, {
      plan: compileWith({ issued: issuedDeclaration }),
    });
    assert.equal(
      result.status === "blocked" && result.reason,
      "unsupported-capability",
    );
    assert.equal(backend.state.disposed, 0);
  });

  test("a login that never reads the declared values does not report what it was for", async () => {
    const backend = stubBackend({ status: 200, body: '{"account":"ada"}' });
    const sessions = createBrowserSessionRegistry({ store });
    let kept = 0;
    const service = createBrowserLoginService({
      sessions,
      verifiers: createVerifierRegistry([createFixtureVerifier({ origin })]),
      credentials: { resolve: async () => undefined },
      launch: backend.launch,
      issuedSinks: {
        "oauth-client": async () => {
          kept++;
        },
      },
    });
    const result = await service.login(actor, {
      plan: compileWith({
        issued: issuedDeclaration,
        verifierOrigin: origin,
      }),
    });
    // Signed in, verifiably - and still not what the plan was for.
    assert.equal(
      result.status === "blocked" && result.reason,
      "issued-value-missing",
    );
    assert.equal(kept, 0);
    await sessions.disposeAll();
  });
});

describe("ISSUED-SERVICE: keeping a client's values through browser_login", () => {
  const credentialIds = { username: randomUUID(), password: randomUUID() };
  const subject: ActorContext = {
    tenantId: "tenant-issued",
    subjectId: "subject-issued",
    sessionId: "client-issued",
    actorKind: "human",
    capabilities: ["executor", "author", "reviewer", "publisher"],
  };

  async function fixture(t: TestContext) {
    const account = {
      email: "owner-issued@ceremony.invalid",
      username: "owner-issued",
      password: `pw-${randomUUID()}`,
    };
    const provider = await startAuthProvider({
      layout: "classic-card",
      strictClients: true,
      accounts: [account],
    });
    t.after(() => provider.close());
    const keys = new SQLiteCeremonyStore(":memory:", {
      current: "issued",
      keys: { issued: new Uint8Array(32).fill(7) },
    });
    t.after(() => keys.close());
    /** Every snapshot the drive took, whoever it was for. */
    const snapshots: PageSnapshot[] = [];
    // A fresh browser per login, as a managed backend opens one: no cookie
    // from an earlier login carries over.
    const backend = stubBackend(
      { status: 200, body: `{"account":"${account.email}"}` },
      () => {
        const page = createHttpCeremonyPage();
        const snapshot = page.snapshot;
        page.snapshot = async () => {
          const taken = await snapshot();
          snapshots.push(structuredClone(taken));
          return taken;
        };
        return page;
      },
    );
    /** Handles the host's sink minted, by the run that minted them. */
    const handles = new Map<string, string>();
    const host = createHostBrowserLogin({
      store: keys,
      knownConnectors: () => new Set(["alpha-developer"]),
      verifiers: [createFixtureVerifier({ origin: provider.origin })],
      credentials: {
        resolve: async (_actor, _plan, role) =>
          role === "username"
            ? account.username
            : role === "password"
              ? account.password
              : undefined,
      },
      launch: backend.launch,
      issuedSinks: {
        // The host's own sink: a run-bound `common.oauth-client` record.
        "oauth-client": async (who, { runRef }, values) => {
          handles.set(
            runRef,
            await mintOAuthClient(
              keys,
              { actor: who, runId: runRef },
              {
                clientId: values["client-id"]!,
                ...(values["client-secret"]
                  ? { clientSecret: values["client-secret"] }
                  : {}),
              },
            ),
          );
        },
      },
    });
    const entry = new URL(`${provider.origin}${oauthAppsPath}/new`);
    entry.searchParams.set("name", "Relying Workspace");
    entry.searchParams.set("homepage_url", "https://relying.example");
    entry.searchParams.set("callback_url", "https://relying.example/callback");
    const draft = (extra: Record<string, unknown> = {}) => ({
      engine: "chromium",
      ownership: "managed",
      entryUrl: entry.href,
      navigationOrigins: [provider.origin],
      credentialRecipients: { password: [provider.origin] },
      account: { kind: "accept-existing" },
      continuation: "dispose",
      trustMode: "constrained-auth",
      interactionRounds: 0,
      requireVerification: true,
      verifierOrigin: provider.origin,
      credentialRefs: credentialIds,
      sessionTtlMs: 600_000,
      ...extra,
    });
    /** Every stored record but the handle records themselves. */
    const stored = async () => {
      const all: unknown[] = [];
      for (const kind of recordKinds)
        for (const record of await keys.transaction((tx) =>
          tx.list<unknown>(subject.tenantId, kind, 500),
        ))
          if (!(kind === "artifact" && record.id.startsWith("common-step:")))
            all.push(record);
      return all;
    };
    return { provider, account, host, draft, snapshots, handles, keys, stored };
  }

  test("the values reach the host's sink and nothing else: no snapshot, step, stored record, recording or tool result", async (t) => {
    const f = await fixture(t);
    const recorded = await f.host.recordLogin(subject, {
      connectorId: "alpha-developer",
      draft: f.draft({ issued: issuedDeclaration }),
      recording: { id: "alpha-register-app", title: "Register an OAuth app" },
    });
    assert.equal(recorded.login.status, "verified", JSON.stringify(recorded));
    const runRef = recorded.login.runRef!;
    const handle = f.handles.get(runRef);
    assert.ok(handle, "the sink minted a handle for this run");
    const client = await readOAuthClient(
      f.keys,
      { actor: subject, runId: runRef },
      handle,
    );
    const [app] = f.provider.oauthApps();
    assert.equal(client?.clientId, app?.clientId);
    assert.equal(app?.secrets, 1, "Generate was pressed exactly once");
    const secret = client?.clientSecret;
    assert.ok(secret && secret.length >= 8);
    // The handle is bound to the run that minted it.
    assert.equal(
      await readOAuthClient(
        f.keys,
        { actor: subject, runId: "brun_another" },
        handle,
      ),
      undefined,
    );

    for (const [surface, value] of [
      ["a snapshot", f.snapshots],
      ["the tool result", recorded],
      ["a stored record", await f.stored()],
    ] as const) {
      const text = JSON.stringify(value);
      assert.equal(
        text.includes(secret),
        false,
        `the secret reached ${surface}`,
      );
      assert.equal(
        text.includes(client!.clientId),
        false,
        `the client ID reached ${surface}`,
      );
      assert.equal(text.includes(f.account.password), false, surface);
    }
    // The recording a reviewer reads says what is kept, and where, by label.
    assert.deepEqual(recorded.draft?.recording.issued, issuedDeclaration);
    assert.equal(recorded.draft?.recording.goal, "obtain-credential");
  });

  test("a published recording keeps exactly what it was reviewed keeping", async (t) => {
    const f = await fixture(t);
    const recorded = await f.host.recordLogin(subject, {
      connectorId: "alpha-developer",
      draft: f.draft({ issued: issuedDeclaration }),
      recording: { id: "alpha-register-app", title: "Register an OAuth app" },
    });
    // The app's settings page is numbered per provider, so its author widens
    // that one segment before review - an edit is a new revision, and the
    // review below is of the edited bytes.
    const draft = await f.host.recordings!.editDraft(
      subject,
      recorded.draft!.draftId,
      {
        revision: recorded.draft!.revision,
        recording: JSON.parse(
          JSON.stringify(recorded.draft!.recording).replaceAll(
            `${oauthAppsPath}/1"`,
            `${oauthAppsPath}/*"`,
          ),
        ),
      },
    );
    assert.deepEqual(draft.recording.issued, issuedDeclaration);
    await f.host.recordings!.review(subject, draft.draftId, {
      revision: draft.revision,
      digest: draft.digest,
    });
    const reference = await f.host.recordings!.publish(subject, draft.draftId, {
      revision: draft.revision,
      digest: draft.digest,
    });
    // Replaying it without the declaration, or with a different one, is a
    // different plan from the one that was reviewed.
    for (const issued of [
      undefined,
      {
        sink: "oauth-client",
        fields: [{ kind: "client-id", label: "Client ID" }],
      },
    ])
      await assert.rejects(
        f.host.login(subject, {
          connectorId: "alpha-developer",
          draft: f.draft({
            recording: reference,
            ...(issued ? { issued } : {}),
          }),
        }),
        (error: unknown) =>
          error instanceof PlanRejected &&
          error.reason === "recording-issued-mismatch",
      );
    // The same declaration, in another order, replays it with no model.
    const replayed = await f.host.login(subject, {
      connectorId: "alpha-developer",
      draft: f.draft({
        recording: reference,
        issued: {
          ...issuedDeclaration,
          fields: [...issuedDeclaration.fields].reverse(),
        },
      }),
    });
    assert.equal(replayed.status, "verified", JSON.stringify(replayed));
    assert.ok(f.handles.get(replayed.runRef!));
    assert.equal(f.provider.oauthApps().length, 2);
  });
});

/* -------------------------------------------------------------------------- */
/* Advance consent                                                            */
/* -------------------------------------------------------------------------- */

describe("CONSENT-SERVICE: only the person's advance consent ticks their terms", () => {
  const draftFields = {
    engine: "chromium",
    ownership: "managed",
    entryUrl: `${origin}/signin`,
    navigationOrigins: [origin],
    credentialRecipients: { password: [origin] },
    account: { kind: "accept-existing" },
    continuation: "dispose",
    trustMode: "constrained-auth",
    interactionRounds: 0,
    requireVerification: true,
    verifierOrigin: origin,
    sessionTtlMs: 600_000,
  } as const;
  const compileWith = (
    extra: Record<string, unknown>,
    who: { fromPerson?: boolean } = { fromPerson: true },
  ) =>
    compileLoginPlan(
      {
        connectorId: "owned-fixture-login",
        ...draftFields,
        credentialRefs: { password: "ref-password" },
        ...extra,
      },
      {
        backends: managedBackends(),
        knownConnectors: new Set(["owned-fixture-login"]),
        ...who,
        revision: 1,
      },
    );

  /**
   * A sign-in page that makes the person accept updated terms before it
   * lets them in, and whether anybody ticked the box.
   */
  function termsPage() {
    let ticked = false;
    return {
      ticked: () => ticked,
      page: (): Partial<CeremonyPage> => ({
        snapshot: async () => ({
          ...emptyPage,
          elements: [
            {
              index: 0,
              kind: "input",
              type: "password",
              name: "password",
              label: "Password",
              filled: true,
            },
            {
              index: 1,
              kind: "checkbox",
              name: "accept",
              label: "I accept the updated Terms of Service",
              required: true,
              filled: ticked,
            },
            { index: 2, kind: "button", text: "Sign in" },
          ],
        }),
        check: async () => {
          ticked = true;
        },
      }),
    };
  }

  test("consent is part of the plan and its digest, canonical, and only the person's", () => {
    const plain = compileWith({});
    const consenting = compileWith({ consents: ["privacy", "terms"] });
    assert.deepEqual(consenting.consents, ["terms", "privacy"]);
    assert.equal(plain.consents, undefined);
    assert.notEqual(plain.digest, consenting.digest);
    // Two orders of one consent are one plan.
    assert.equal(
      compileWith({ consents: ["terms", "privacy"] }).digest,
      consenting.digest,
    );
    // An empty list is no consent, and says the same as none.
    assert.equal(compileWith({ consents: [] }).digest, plain.digest);
    // Not the person - an agent, or a caller the host never identified.
    for (const who of [{ fromPerson: false }, {}])
      assert.throws(
        () => compileWith({ consents: ["terms"] }, who),
        (error: unknown) =>
          error instanceof PlanRejected &&
          error.reason === "consent-not-delegable",
      );
    // A newsletter is not a kind anybody consents to in advance.
    for (const consents of [["marketing"], ["terms", "terms"]])
      assert.throws(
        () => compileWith({ consents }),
        (error: unknown) => !(error instanceof PlanRejected),
        JSON.stringify(consents),
      );
  });

  test("the terms box is ticked under the plan's consent, and is the person's without it", async () => {
    const consented = termsPage();
    const { sessions, service } = serviceWith(
      stubBackend({ status: 200, body: '{"account":"ada"}' }, consented.page),
    );
    const result = await service.login(actor, {
      plan: compileWith({ consents: ["terms"] }),
    });
    assert.equal(result.status, "verified", JSON.stringify(result));
    assert.equal(consented.ticked(), true);

    const unconsented = termsPage();
    const second = serviceWith(
      stubBackend({ status: 200, body: '{"account":"ada"}' }, unconsented.page),
    );
    const refused = await second.service.login(actor, {
      plan: compileWith({}),
    });
    assert.equal(
      refused.status === "requires-human" && refused.reason,
      "consent",
      JSON.stringify(refused),
    );
    assert.equal(unconsented.ticked(), false);
    await sessions.disposeAll();
    await second.sessions.disposeAll();
  });

  test("an agent cannot give it: refused by the compiler, and not offered over MCP", async () => {
    const keys = new SQLiteCeremonyStore(":memory:", {
      current: "consent",
      keys: { consent: new Uint8Array(32).fill(3) },
    });
    after(() => keys.close());
    const host = createHostBrowserLogin({
      store: keys,
      knownConnectors: () => new Set(["owned-fixture-login"]),
      verifiers: [createFixtureVerifier({ origin })],
      credentials: { resolve: async () => "correct-horse" },
      launch: stubBackend(
        { status: 200, body: '{"account":"ada"}' },
        termsPage().page,
      ).launch,
    });
    const agent: ActorContext = { ...actor, actorKind: "agent" };
    const request = {
      connectorId: "owned-fixture-login",
      draft: {
        ...draftFields,
        credentialRefs: { password: randomUUID() },
        consents: ["terms"],
      },
    };
    await assert.rejects(
      host.login(agent, request),
      (error: unknown) =>
        error instanceof PlanRejected &&
        error.reason === "consent-not-delegable",
    );
    // The person sending the same draft compiles it.
    const person = await host.login(actor, request);
    assert.equal(person.status, "verified", JSON.stringify(person));
    // The MCP tools never show a model the field at all.
    for (const tool of ["login", "recordLogin"] as const) {
      const shape = browserLoginAgentToolInputs[tool].shape.draft.shape;
      assert.equal("consents" in shape, false, tool);
      assert.ok("consents" in browserLoginToolInputs[tool].shape.draft.shape);
    }
    assert.equal(
      browserLoginAgentToolInputs.login.safeParse(request).success,
      false,
    );
    const { consents: _dropped, ...withoutConsent } = request.draft;
    assert.equal(
      browserLoginAgentToolInputs.login.safeParse({
        ...request,
        draft: withoutConsent,
      }).success,
      true,
    );
  });
});
