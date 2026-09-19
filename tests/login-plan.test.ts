import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { managedBackends } from "../src/server/browser-backends.js";
import {
  compileLoginPlan,
  PlanRejected,
  planUnchanged,
  recipientsFor,
} from "../src/server/login-plan.js";

/**
 * What a configuration wizard collects is a request, not a decision.
 *
 * The defect these tests exist to prevent is the quiet one: an interface that
 * renders a setting, sends nothing, and describes behaviour the runtime never
 * had. So every operative field below is asserted to either change the compiled
 * plan's digest or be rejected by name. A field that can do neither is
 * decoration, and decoration that looks like policy is worse than no setting at
 * all.
 */

const provider = "https://provider.example";
const identity = "https://identity.example";
const options = {
  backends: managedBackends(),
  knownConnectors: new Set(["owned-fixture-login"]),
  revision: 1,
};

function draft(overrides: Record<string, unknown> = {}) {
  return {
    connectorId: "owned-fixture-login",
    engine: "chromium",
    ownership: "managed",
    entryUrl: `${provider}/signin`,
    navigationOrigins: [provider],
    credentialRecipients: { password: [provider] },
    account: { kind: "expect", accountRef: "ada" },
    continuation: "retain-for-authorized-agent",
    trustMode: "constrained-auth",
    interactionRounds: 1,
    requireVerification: true,
    verifierOrigin: provider,
    credentialRefs: { password: "ref-password" },
    sessionTtlMs: 600_000,
    ...overrides,
  };
}

describe("POLICY-DRAFT: every operative field reaches the plan", () => {
  const base = compileLoginPlan(draft(), options);

  const variations: [string, Record<string, unknown>][] = [
    ["engine", { engine: "firefox" }],
    ["trust mode", { trustMode: "trusted-agent" }],
    ["continuation", { continuation: "dispose" }],
    ["interaction rounds", { interactionRounds: 0 }],
    ["session lifetime", { sessionTtlMs: 120_000 }],
    ["account policy", { account: { kind: "accept-existing" } }],
    ["navigation origins", { navigationOrigins: [provider, identity] }],
    [
      "credential recipients",
      {
        navigationOrigins: [provider, identity],
        credentialRecipients: { password: [provider, identity] },
      },
    ],
    ["credential references", { credentialRefs: { password: "ref-other" } }],
  ];

  test("changing who reasons changes the canonical plan", () => {
    // Separate from the loop because it needs the host to declare a model:
    // a draft asking for one where there is none is a rejection, which is
    // POLICY-UNKNOWN's business rather than this one's.
    const changed = compileLoginPlan(draft({ reasoning: "host-model" }), {
      ...options,
      modelAvailable: true,
    });
    assert.notEqual(
      changed.digest,
      base.digest,
      "reasoning must be part of what execution reads",
    );
  });

  for (const [name, change] of variations)
    test(`changing the ${name} changes the canonical plan`, () => {
      const changed = compileLoginPlan(draft(change), options);
      assert.notEqual(
        changed.digest,
        base.digest,
        `${name} must be part of what execution reads`,
      );
    });

  test("the same draft compiles to the same digest", () => {
    assert.equal(compileLoginPlan(draft(), options).digest, base.digest);
    // Key order in the draft must not change the identity of the plan.
    assert.equal(
      compileLoginPlan(
        { ...draft(), sessionTtlMs: 600_000, engine: "chromium" },
        options,
      ).digest,
      base.digest,
    );
  });
});

describe("POLICY-UNKNOWN: nothing falls back to the first of anything", () => {
  test("an unknown connector is rejected, not substituted", () => {
    assert.throws(
      () => compileLoginPlan(draft({ connectorId: "not-registered" }), options),
      (error: unknown) =>
        error instanceof PlanRejected && error.reason === "unknown-connector",
    );
  });

  test("a model this host does not have is rejected, not downgraded", () => {
    // The same rule as the engine below, for the field that decides whether
    // anything about somebody's sign-in page leaves the deployment. Running
    // the deterministic rules instead would produce an attempt whose digest
    // says a model read the page when nothing did.
    assert.throws(
      () => compileLoginPlan(draft({ reasoning: "host-model" }), options),
      (error: unknown) =>
        error instanceof PlanRejected &&
        error.reason === "reasoning-unavailable",
    );
  });

  test("an unavailable ownership or engine is rejected, not downgraded", () => {
    assert.throws(
      () => compileLoginPlan(draft({ ownership: "attached-user" }), options),
      (error: unknown) =>
        error instanceof PlanRejected && error.reason === "unsupported-engine",
    );
  });

  test("an expected account with no identifier is ambiguous, not accepted", () => {
    assert.throws(
      () =>
        compileLoginPlan(
          draft({ account: { kind: "expect", accountRef: "   " } }),
          options,
        ),
      (error: unknown) =>
        error instanceof PlanRejected && error.reason === "ambiguous-account",
    );
  });
});

describe("POLICY-VERIFY: verification cannot be switched off by a client", () => {
  test("a client asking to skip verification is rejected", () => {
    assert.throws(
      () => compileLoginPlan(draft({ requireVerification: false }), options),
      (error: unknown) =>
        error instanceof PlanRejected &&
        error.reason === "verification-required",
    );
  });

  test("a host that explicitly permits it gets a plan that says so", () => {
    const plan = compileLoginPlan(draft({ requireVerification: false }), {
      ...options,
      allowUnverified: true,
    });
    // Permitted, and visibly different: an unverified attempt is a different
    // plan with a different digest, not the same plan run more loosely.
    assert.equal(plan.requireVerification, false);
    assert.notEqual(plan.digest, compileLoginPlan(draft(), options).digest);
  });
});

describe("ORIGIN-SSO: navigation scope and credential scope stay separate", () => {
  test("an origin admitted for navigation receives no secret by default", () => {
    const plan = compileLoginPlan(
      draft({
        navigationOrigins: [provider, identity],
        credentialRecipients: { password: [provider] },
      }),
      options,
    );
    assert.deepEqual(plan.navigationOrigins, [provider, identity]);
    // The identity provider may be visited. That is not permission to type
    // this site's password into it.
    assert.deepEqual(recipientsFor(plan, "password"), [provider]);
  });

  test("a role with no declared recipient may be typed nowhere", () => {
    const plan = compileLoginPlan(draft({ credentialRecipients: {} }), options);
    assert.deepEqual(recipientsFor(plan, "password"), []);
  });

  test("a recipient that is not a declared navigation origin is rejected", () => {
    assert.throws(
      () =>
        compileLoginPlan(
          draft({ credentialRecipients: { password: [identity] } }),
          options,
        ),
      (error: unknown) =>
        error instanceof PlanRejected &&
        error.reason === "recipient-origin-not-declared",
    );
  });

  test("an entry URL outside the declared origins is rejected", () => {
    assert.throws(
      () =>
        compileLoginPlan(draft({ entryUrl: `${identity}/signin` }), options),
      (error: unknown) =>
        error instanceof PlanRejected &&
        error.reason === "entry-origin-not-declared",
    );
  });
});

describe("ORIGIN-SSRF: origins are exact, canonical and checked", () => {
  const rejected = [
    "https://provider.example/path",
    "https://user:pass@provider.example",
    "https://*.provider.example",
    "http://provider.example",
    "https://provider.example:0",
    "not-a-url",
  ];
  for (const origin of rejected)
    test(`${origin} is not an admissible origin`, () => {
      assert.throws(() =>
        compileLoginPlan(draft({ navigationOrigins: [origin] }), options),
      );
    });

  test("loopback stays available for an owned fixture", () => {
    const loopback = "http://127.0.0.1:4174";
    const plan = compileLoginPlan(
      draft({
        entryUrl: `${loopback}/signin`,
        navigationOrigins: [loopback],
        credentialRecipients: { password: [loopback] },
        verifierOrigin: loopback,
      }),
      options,
    );
    assert.deepEqual(plan.navigationOrigins, [loopback]);
  });
});

describe("plan identity", () => {
  test("POLICY-REVISE: a revised plan is not the plan an approval was given for", () => {
    const first = compileLoginPlan(draft(), options);
    const second = compileLoginPlan(draft(), { ...options, revision: 2 });
    assert.notEqual(first.digest, second.digest);
    assert.equal(
      planUnchanged(second, { digest: first.digest, revision: first.revision }),
      false,
    );
    assert.equal(
      planUnchanged(first, { digest: first.digest, revision: first.revision }),
      true,
    );
  });

  test("a retained continuation requires a backend that can retain", () => {
    // Asking to keep the session is not a preference the compiler may drop; a
    // backend that cannot honour it must be refused here, before any launch.
    const plan = compileLoginPlan(draft(), options);
    assert.equal(plan.required.retainedSession, true);
  });

  for (const capability of ["popupBinding"] as const)
    test(`CAP-HONEST: a plan requiring ${capability} is refused, on every engine`, () => {
      // These were declared true on all three backends with nothing
      // implementing either, so `unmetCapabilities` admitted a plan that
      // asked for one and the login then ran without it. Being told yes is
      // worse than being refused: a caller that hears "no" can choose something
      // else, and a caller that hears "yes" proceeds on a promise.
      //
      // `statePersistence` was the third and `frameBinding` the fourth, and
      // both have left this list the only way anything should: something
      // implements them now, and a case on a real browser of each engine
      // drives it - LIFE-STATE for one, TARGET-FRAME for the other. The
      // cases below are what keep that honest from this side.
      //
      // `popupBinding` is not waiting on an implementation. `browser-executor`
      // deliberately aborts a popup and closes the context, so it waits on a
      // decision about whether adopting popup targets can be made safe.
      for (const engine of ["chromium", "firefox", "webkit"] as const)
        assert.throws(
          () =>
            compileLoginPlan(
              draft({ engine, required: { [capability]: true } }),
              options,
            ),
          (error: unknown) =>
            error instanceof PlanRejected &&
            error.reason === "unsupported-capability",
          `${engine} admitted a plan requiring ${capability}`,
        );
    });

  for (const capability of [
    "retainedSession",
    "statePersistence",
    "frameBinding",
  ] as const)
    test(`CAP-HONEST: ${capability} is real, and still granted on every engine`, () => {
      // The other half of the claim. A correction that quietly turned
      // everything false would satisfy the cases above and break every real
      // login, so each capability that *is* implemented must still compile.
      //
      // Five capabilities can be required of a backend at all. These three
      // are the ones every engine offers: `strongEgressContainment` is false
      // everywhere and truthfully so, and `popupBinding` is false because
      // the executor deliberately does not adopt popups.
      for (const engine of ["chromium", "firefox", "webkit"] as const) {
        const plan = compileLoginPlan(
          draft({ engine, required: { [capability]: true } }),
          options,
        );
        assert.equal(plan.engine, engine);
        assert.equal(plan.required[capability], true);
      }
    });

  test("CAP-HONEST: declaring a frame origin requires the capability to act in one", () => {
    // The field was accepted, canonicalized, digested and read by nothing
    // until the adapter learned to resolve a declared frame on every read and
    // every action. Declaring a frame origin *is* declaring that this login
    // happens in a frame, so the capability is required whether or not the
    // caller named it.
    //
    // Asserted as the rule rather than as its consequence today. This case
    // used to prove the requirement by watching every engine refuse, which
    // was true only while nothing implemented frames: the moment one did, a
    // case about the compiler started failing for a reason that had nothing
    // to do with the compiler. What has to hold either way is that the
    // requirement is derived from the declaration.
    for (const engine of ["chromium", "firefox", "webkit"] as const) {
      const plan = compileLoginPlan(
        draft({
          engine,
          navigationOrigins: [provider, identity],
          frameOrigins: [identity],
        }),
        options,
      );
      assert.equal(
        plan.required.frameBinding,
        true,
        `${engine} compiled a framed plan without requiring the capability`,
      );
    }
  });

  test("CAP-HONEST: a backend that cannot act in a frame refuses a framed plan", () => {
    // The half that makes the rule above worth having, and it is measured
    // against a backend table that says no rather than against whatever the
    // real one happens to say this month. A future engine without frame
    // support must still be refused, and this case fails if the requirement
    // stops being derived or stops being checked.
    const incapable = managedBackends().map((backend) => ({
      ...backend,
      capabilities: { ...backend.capabilities, frameBinding: false },
    }));
    for (const engine of ["chromium", "firefox", "webkit"] as const)
      assert.throws(
        () =>
          compileLoginPlan(
            draft({
              engine,
              navigationOrigins: [provider, identity],
              frameOrigins: [identity],
            }),
            { ...options, backends: incapable },
          ),
        (error: unknown) =>
          error instanceof PlanRejected &&
          error.reason === "unsupported-capability" &&
          error.detail === "frameBinding",
        `${engine} admitted a framed plan on a backend that cannot act in one`,
      );
  });

  test("a plan that declares no frame origin is unaffected", () => {
    // The half that keeps the rule from becoming "nothing compiles". An
    // ordinary login does not touch frames and must not start requiring
    // anything new.
    const plan = compileLoginPlan(draft(), options);
    assert.deepEqual(plan.frameOrigins, []);
    assert.equal(plan.required.frameBinding, undefined);
  });

  test("an unknown credential reference is rejected before anything runs", () => {
    assert.throws(
      () =>
        compileLoginPlan(draft(), {
          ...options,
          availableCredentialRefs: new Set(["ref-something-else"]),
        }),
      (error: unknown) =>
        error instanceof PlanRejected &&
        error.reason === "unknown-credential-reference",
    );
  });

  test("a credential value in place of a reference is rejected by shape", () => {
    assert.throws(() =>
      compileLoginPlan(
        { ...draft(), password: "hunter2" } as Record<string, unknown>,
        options,
      ),
    );
  });
});
