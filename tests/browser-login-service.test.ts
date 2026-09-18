import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import {
  managedBackends,
  UnsupportedBackend,
} from "../src/server/browser-backends.js";
import {
  createEffectLedger,
  effectIsIndeterminate,
} from "../src/server/browser-effects.js";
import { createBrowserLoginService } from "../src/server/browser-login-service.js";
import { createBrowserSessionRegistry } from "../src/server/browser-sessions.js";
import {
  createFixtureVerifier,
  createVerifierRegistry,
} from "../src/server/browser-verification.js";
import { compileLoginPlan } from "../src/server/login-plan.js";
import { SQLiteCeremonyStore } from "../src/server/persistence/index.js";
import type { ActorContext } from "../src/core/operation-contracts.js";
import type { PageSnapshot } from "../src/core/browser-contracts.js";
import type { CeremonyPage } from "../src/server/browser-driver.js";

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
  page: Partial<CeremonyPage> = {},
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
              ...page,
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
  options: { verifiers?: boolean; effects?: boolean } = {},
) {
  const sessions = createBrowserSessionRegistry({ store });
  const effects = createEffectLedger({ store });
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
      assert.match(result.effectRef, /^beff_[0-9a-f]{32}$/);
      assert.equal(
        effectIsIndeterminate(await effects.read(actor, result.effectRef)),
        true,
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
