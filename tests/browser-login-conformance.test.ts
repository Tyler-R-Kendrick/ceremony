import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { browserEngines } from "../src/core/browser-session-contracts.js";
import {
  launchManagedBrowser,
  managedBackends,
  type ManagedBrowser,
} from "../src/server/browser-backends.js";
import { createEffectLedger } from "../src/server/browser-effects.js";
import {
  BrowserStateUnavailable,
  createBrowserStateStore,
  storageStateSchema,
} from "../src/server/browser-state.js";
import { createBrowserLoginService } from "../src/server/browser-login-service.js";
import { createBrowserSessionRegistry } from "../src/server/browser-sessions.js";
import {
  createFixtureVerifier,
  createVerifierRegistry,
} from "../src/server/browser-verification.js";
import { compileLoginPlan } from "../src/server/login-plan.js";
import { SQLiteCeremonyStore } from "../src/server/persistence/index.js";
import {
  createIdentityFixture,
  defaultFixtureAccounts,
  type IdentityFixture,
} from "./fixtures/identity-provider.js";
import type { ActorContext } from "../src/core/operation-contracts.js";

/**
 * The common login contract, executed on every browser engine this build
 * claims to support.
 *
 * Every assertion here is answered by the fixture *server*, not by the thing
 * under test. Whether a login worked is decided by whether the provider's own
 * identity endpoint recognises the browser's cookie; whether exactly one
 * credential submission happened is decided by what the provider recorded
 * receiving. An agent reporting success is not evidence of success, and a page
 * rendering "signed in" is not either — there are cases below for both.
 *
 * These are real browsers. A suite that silently reduced to zero executed cases
 * because an engine would not launch would be worse than useless, so an engine
 * that cannot start fails its cases rather than skipping them.
 */

const owner = defaultFixtureAccounts[0]!;
const deputy = defaultFixtureAccounts[1]!;

const actor: ActorContext = {
  tenantId: "conformance-tenant",
  subjectId: "conformance-subject",
  sessionId: "conformance-session",
  actorKind: "human",
  capabilities: ["executor"],
};

let fixture: IdentityFixture;
let store: SQLiteCeremonyStore;

/**
 * One real browser process per engine, shared by that engine's cases.
 *
 * Isolation between cases is a *context* boundary, not a process boundary —
 * cookies and storage belong to the context — so opening a fresh context per
 * login gives each case exactly the separation it needs. Launching a fresh
 * process per case instead bought nothing and cost twenty-four spawns in one
 * file, which is heavy enough to matter when the coverage harness runs four
 * browser-driving files at once on a small CI machine.
 */
const engines = new Map<string, ManagedBrowser>();

before(async () => {
  fixture = await createIdentityFixture();
  for (const engine of browserEngines)
    engines.set(engine, await launchManagedBrowser(engine));
  store = new SQLiteCeremonyStore(":memory:", {
    current: "conformance",
    keys: { conformance: new Uint8Array(32) },
  });
});

after(async () => {
  for (const browser of engines.values()) await browser.dispose();
  await fixture.close();
  await store.close();
});

type PlanOverrides = Partial<Parameters<typeof compileLoginPlan>[0] & object>;

function planFor(
  engine: (typeof browserEngines)[number],
  overrides: PlanOverrides = {},
) {
  return compileLoginPlan(
    {
      connectorId: "owned-fixture-login",
      engine,
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
      credentialRefs: { email: "ref-email", password: "ref-password" },
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

/** A service wired to one fresh registry, with the credentials it is allowed. */
function serviceFor(engine: string, values: Record<string, string>) {
  const sessions = createBrowserSessionRegistry({ store });
  const effects = createEffectLedger({ store });
  const service = createBrowserLoginService({
    sessions,
    effects,
    // Both origins. A login completed inside a cross-origin frame establishes
    // a session on the *frame's* server, so the verifier that can answer
    // "whose session is this?" is the partner's, not the embedding page's.
    verifiers: createVerifierRegistry([
      createFixtureVerifier({ origin: fixture.origin }),
      createFixtureVerifier({ origin: fixture.partner.origin }),
    ]),
    credentials: {
      // Roles resolve inside the trusted path. The value never appears in a
      // plan, a snapshot, a transcript or a result.
      resolve: async (_actor, _plan, role) => values[role],
    },
    // The real launcher still ran, once, in `before`. What it produced is
    // handed back here with process teardown withheld, because the suite owns
    // that and a single case ending must not take the engine away from the
    // cases after it. Everything the service does with the browser — contexts,
    // pages, retention, release — is the production path unchanged.
    launch: (async () => {
      const shared = engines.get(engine)!;
      return { ...shared, dispose: async () => {} };
    }) as typeof launchManagedBrowser,
  });
  /**
   * What the driver did, in the service's own progress vocabulary: one
   * `action@path` per recorded step and nothing else. Those are already the
   * two fields the privacy sweep pins `onStep` to, so making a failure
   * readable adds nothing to what leaves the trusted path.
   *
   * It is attached to every failure message below because the intermittent
   * this suite keeps hitting on CI reports `stale-document` and nothing
   * else, and that name is raised by more than one guard at more than one
   * moment. What the trail adds is the document an approval was held
   * against when the refusal came.
   *
   * Read the last step by its path, not by its name. A *successful* login's
   * trail also ends in `blocked`, usually `blocked@/account`: the heuristic
   * interpreter runs out of ideas on the post-login page, and the service
   * deliberately treats that as "the drive is over, ask the verifier". What
   * is diagnostic is the absence of a `blocked` step on a failing attempt,
   * because `observe()` returns its refusal without recording one - so a
   * trail with none says the read itself failed rather than an action on
   * something read earlier.
   */
  let trail: string[] = [];
  const traced: typeof service = {
    ...service,
    login: (who, input) => {
      trail = [];
      return service.login(who, {
        ...input,
        onStep: (step) => {
          input.onStep?.(step);
          trail.push(`${step.action}@${step.path}`);
        },
      });
    },
  };

  /**
   * A failure message that says how far the attempt got rather than only
   * where it stopped. The provider's own record of what it received is the
   * other half: it distinguishes a refusal before the credentials were sent
   * from one after.
   */
  const shown = (outcome: unknown) =>
    [
      JSON.stringify(outcome),
      `steps [${trail.join(" ")}]`,
      `provider recorded [${fixture
        .submissions()
        .map((submission) => submission.path)
        .join(" ")}]`,
    ].join("; ");

  return { sessions, service: traced, effects, shown };
}

for (const engine of browserEngines) {
  describe(`managed ${engine}`, () => {
    test("AUTH-COMBINED: a combined form logs the expected account in", async () => {
      fixture.reset();
      const { sessions, service, shown } = serviceFor(engine, {
        email: owner.identifier,
        password: owner.password,
      });
      try {
        const result = await service.login(actor, { plan: planFor(engine) });
        assert.equal(
          result.status,
          "verified",
          `expected a verified login, got ${shown(result)}`,
        );
        if (result.status !== "verified") return;
        assert.equal(result.evidenceKind, "fixture-verified");

        // The oracle: the provider itself recorded one submission, for this
        // account, with a password it accepted.
        const submissions = fixture.submissions();
        assert.equal(submissions.length, 1);
        assert.equal(submissions[0]?.account, owner.account);
        assert.equal(submissions[0]?.passwordMatched, true);
        assert.equal(fixture.sessionsFor(owner.account).length, 1);
      } finally {
        await sessions.disposeAll();
      }
    });

    test("AUTH-IDENTIFIER: the secret is typed on the second document, not the first", async () => {
      // The flow every protection in `browser-targets.ts` was written for.
      //
      // An identifier-first provider asks for the email on one document and
      // the password on a *different* one, reached through a redirect. So the
      // observation that approved the email field is guaranteed dead by the
      // time the password is typed, and the driver has to notice, re-observe,
      // and act on the second document rather than on a remembered position
      // in the first. On a combined form none of that is exercised, because
      // the document never changes.
      fixture.reset();
      const { sessions, service, shown } = serviceFor(engine, {
        email: owner.identifier,
        password: owner.password,
      });
      try {
        const result = await service.login(actor, {
          plan: planFor(engine, {
            entryUrl: fixture.url("/signin-identifier"),
          }),
        });
        assert.equal(
          result.status,
          "verified",
          `expected a verified login, got ${shown(result)}`,
        );
        if (result.status !== "verified") return;

        // The oracle is the provider's own record of what arrived where. Two
        // submissions, in order, to two different routes - which is what makes
        // this the two-document flow rather than a combined form that happens
        // to redirect.
        const submissions = fixture.submissions();
        assert.deepEqual(
          submissions.map((submission) => submission.path),
          ["/signin-identifier", "/signin-password"],
          `expected the two-document sequence, got ${JSON.stringify(submissions.map((s) => s.path))}`,
        );

        // Step one identifies and cannot authenticate: the provider records no
        // password match for it, because there was no password on that page to
        // send. If this ever reported true, the secret would have reached the
        // identifier document.
        assert.equal(submissions[0]?.account, owner.account);
        assert.equal(
          submissions[0]?.passwordMatched,
          false,
          "the identifier document must not have received a password",
        );

        // Step two authenticates, against the account step one established -
        // not against one the second document was told about.
        assert.equal(submissions[1]?.account, owner.account);
        assert.equal(submissions[1]?.passwordMatched, true);

        // And one session, for the right account. Two would mean the flow ran
        // twice; none would mean the provider never accepted it.
        assert.equal(fixture.sessionsFor(owner.account).length, 1);
      } finally {
        await sessions.disposeAll();
      }
    });

    test("AUTH-IDENTIFIER-WRONG: an unknown identifier stops at step one", async () => {
      // The direction that keeps the case above honest. A provider that never
      // recognises the identifier never issues the second document, so a
      // driver that "completed" here would have done so against the page that
      // rejected it - and the secret must not have gone anywhere at all.
      fixture.reset();
      const { sessions, service, shown } = serviceFor(engine, {
        email: "nobody@fixture.test",
        password: owner.password,
      });
      try {
        const result = await service.login(actor, {
          plan: planFor(engine, {
            entryUrl: fixture.url("/signin-identifier"),
          }),
        });
        assert.notEqual(
          result.status,
          "verified",
          `an unknown identifier must not verify, got ${shown(result)}`,
        );

        // The provider saw the identifier attempt and nothing else. In
        // particular it never saw `/signin-password`, so the password was
        // never typed anywhere.
        const submissions = fixture.submissions();
        assert.equal(
          submissions.every(
            (submission) => submission.path === "/signin-identifier",
          ),
          true,
          `the password document must never have been reached, got ${JSON.stringify(submissions.map((s) => s.path))}`,
        );
        assert.equal(
          submissions.some((submission) => submission.passwordMatched),
          false,
        );
        assert.equal(fixture.sessionsFor(owner.account).length, 0);
      } finally {
        await sessions.disposeAll();
      }
    });

    test("LIFE-RETURN: the session still works after the call returns", async () => {
      fixture.reset();
      const { sessions, service, shown } = serviceFor(engine, {
        email: owner.identifier,
        password: owner.password,
      });
      try {
        const result = await service.login(actor, { plan: planFor(engine) });
        assert.equal(
          result.status,
          "verified",
          `expected a verified login, got ${shown(result)}`,
        );
        if (result.status !== "verified") return;

        // A real authenticated request, through the exact retained context,
        // after the login call has already returned. This is the deliverable:
        // not a report that a login happened, but a browser that is logged in.
        const { session } = await sessions.resolve(actor, result.sessionRef);
        const context = (
          session as unknown as {
            context: {
              request: {
                get(
                  url: string,
                  options?: { failOnStatusCode?: boolean },
                ): Promise<{ status(): number; text(): Promise<string> }>;
              };
            };
          }
        ).context;
        const response = await context.request.get(fixture.url("/api/whoami"), {
          failOnStatusCode: false,
        });
        assert.equal(response.status(), 200);
        assert.deepEqual(JSON.parse(await response.text()), {
          account: owner.account,
        });
      } finally {
        await sessions.disposeAll();
      }
    });

    test("LIFE-STATE: a saved session is restored into a context that never logged in", async () => {
      // What `statePersistence` has to mean if the flag is to be worth
      // declaring: a second context, opened from a saved state, is recognised
      // by the *provider* - not by a marker this process drew.
      fixture.reset();
      const { sessions, service, shown } = serviceFor(engine, {
        email: owner.identifier,
        password: owner.password,
      });
      const states = createBrowserStateStore({ store });
      const browser = engines.get(engine)!;
      try {
        const result = await service.login(actor, { plan: planFor(engine) });
        assert.equal(
          result.status,
          "verified",
          `expected a verified login, got ${shown(result)}`,
        );
        if (result.status !== "verified") return;
        const before = fixture.sessionsFor(owner.account).length;

        const { session } = await sessions.resolve(actor, result.sessionRef);
        assert.ok(session.context, "a retained session must hold its context");
        const stateRef = await states.save(
          actor,
          {
            browserGeneration: browser.browserGeneration,
            effectivePlanDigest: planFor(engine).digest,
          },
          storageStateSchema.parse(await session.context.saveState()),
        );

        // A context that has never seen a credential. The only thing it is
        // given is the saved state.
        const restored = await browser.openContext({
          storageState: states.restore(actor, stateRef),
        });
        try {
          const answer = await restored.request.get(fixture.url("/api/whoami"));
          assert.equal(
            answer.status(),
            200,
            "the provider must recognise the restored context",
          );
          assert.deepEqual(JSON.parse(await answer.text()), {
            account: owner.account,
          });
        } finally {
          await restored.close();
        }

        // Restoring is not logging in again. The provider issued no second
        // session: the same one is being presented from somewhere else, which
        // is exactly what makes a saved state a credential.
        assert.equal(fixture.sessionsFor(owner.account).length, before);
      } finally {
        await sessions.disposeAll();
      }
    });

    test("LIFE-STATE-SUBJECT: a saved session is not another subject's to restore", async () => {
      // The reference is opaque, but opacity is not authorization. A
      // colleague who comes by one must not be able to put themselves inside
      // somebody else's session with it.
      fixture.reset();
      const { sessions, service, shown } = serviceFor(engine, {
        email: owner.identifier,
        password: owner.password,
      });
      const states = createBrowserStateStore({ store });
      const browser = engines.get(engine)!;
      try {
        const result = await service.login(actor, { plan: planFor(engine) });
        assert.equal(
          result.status,
          "verified",
          `expected a verified login, got ${shown(result)}`,
        );
        if (result.status !== "verified") return;
        const { session } = await sessions.resolve(actor, result.sessionRef);
        assert.ok(session.context, "a retained session must hold its context");
        const stateRef = await states.save(
          actor,
          {
            browserGeneration: browser.browserGeneration,
            effectivePlanDigest: planFor(engine).digest,
          },
          storageStateSchema.parse(await session.context.saveState()),
        );

        const intruder = { ...actor, subjectId: "someone-else" };
        await assert.rejects(
          () => states.restore(intruder, stateRef)(),
          (error: unknown) =>
            error instanceof BrowserStateUnavailable &&
            error.reason === "not-authorized",
          "another subject must not restore this state",
        );
        // And the same tenant asking about it learns nothing either.
        await assert.rejects(() => states.describe(intruder, stateRef));
      } finally {
        await sessions.disposeAll();
      }
    });

    test("LIFE-SHARED: two sessions in one browser are two sessions", async () => {
      // A managed browser is built to hold several contexts, and contexts -
      // not processes - are where cookies stop. So the question a host that
      // pools browsers has to be able to answer is whether two people signed
      // in through the same process are actually separate, and the only
      // answer worth anything comes from the provider rather than from this
      // side of the connection.
      //
      // Both logins run against the same real browser: `serviceFor` hands
      // back the engine this suite launched once, so nothing here arranges
      // the isolation - it is whatever the backend actually does.
      fixture.reset();
      const one = serviceFor(engine, {
        email: owner.identifier,
        password: owner.password,
      });
      const two = serviceFor(engine, {
        email: deputy.identifier,
        password: deputy.password,
      });
      try {
        const first = await one.service.login(actor, {
          plan: planFor(engine),
        });
        const second = await two.service.login(actor, {
          plan: planFor(engine, {
            account: { kind: "expect", accountRef: deputy.account },
          }),
        });
        assert.equal(
          first.status,
          "verified",
          `expected the first login to verify, got ${one.shown(first)}`,
        );
        assert.equal(
          second.status,
          "verified",
          `expected the second login to verify, got ${two.shown(second)}`,
        );
        if (first.status !== "verified" || second.status !== "verified") return;

        // Each context asks the provider who *it* is. Two different answers
        // is the whole claim: the second login did not overwrite the first,
        // and neither is reading the other's cookie.
        const asked = async (sessionRef: string) => {
          const { session } = await (
            sessionRef === first.sessionRef ? one.sessions : two.sessions
          ).resolve(actor, sessionRef);
          assert.ok(session.context, "a retained session must hold a context");
          const answer = await session.context.request.get(
            fixture.url("/api/whoami"),
          );
          assert.equal(answer.status(), 200);
          return (JSON.parse(await answer.text()) as { account: string })
            .account;
        };
        assert.equal(await asked(first.sessionRef), owner.account);
        assert.equal(await asked(second.sessionRef), deputy.account);

        // And the provider agrees there are two, rather than one that moved.
        assert.equal(fixture.sessionsFor(owner.account).length, 1);
        assert.equal(fixture.sessionsFor(deputy.account).length, 1);

        // Releasing one must leave the other usable.
        //
        // Stated precisely, because this assertion is weaker than it looks:
        // `serviceFor` hands back the shared engine with `dispose` stubbed to
        // a no-op, so that one case ending cannot take the browser away from
        // the cases after it. That stub also hides the defect this rule is
        // about - a release calling `ManagedBrowser.dispose()` and closing
        // every context the backend created. What is proven here is the
        // context-level half: closing one session's context leaves the
        // other's alive and still holding its cookie. The browser-level half
        // is `browser-session-lifetime` LIFE-SHARED, where the stub does not
        // lie and restoring the defect fails the case.
        await one.sessions.release(actor, first.sessionRef, "dispose-managed");
        assert.equal(
          await asked(second.sessionRef),
          deputy.account,
          "releasing one session took the other's context with it",
        );
      } finally {
        await one.sessions.disposeAll();
        await two.sessions.disposeAll();
      }
    });

    test("AUTH-WRONG: a different account is a mismatch, not a success", async () => {
      fixture.reset();
      // The credentials are the deputy's; the plan expects the owner.
      const { sessions, service, shown } = serviceFor(engine, {
        email: deputy.identifier,
        password: deputy.password,
      });
      try {
        const result = await service.login(actor, { plan: planFor(engine) });
        assert.equal(result.status, "blocked");
        assert.equal(
          result.status === "blocked" ? result.reason : undefined,
          "account-mismatch",
        );
        // The deputy is still signed in at the provider. Nothing logged them
        // out, switched accounts, or started a recovery flow on their behalf.
        assert.equal(fixture.sessionsFor(deputy.account).length, 1);
        assert.equal(fixture.sessionsFor(owner.account).length, 0);
      } finally {
        await sessions.disposeAll();
      }
    });

    test("AUTH-FORGED: a page that only looks signed in is not verified", async () => {
      fixture.reset();
      const { sessions, service, shown } = serviceFor(engine, {
        email: owner.identifier,
        password: owner.password,
      });
      try {
        // `/forged` renders a signed-in banner, a logout link and even the
        // account marker element — and sets no cookie at all.
        const result = await service.login(actor, {
          plan: planFor(engine, { entryUrl: fixture.url("/forged") }),
        });
        assert.notEqual(
          result.status,
          "verified",
          "a rendered marker must not establish a verified account",
        );
        assert.equal(fixture.sessionsFor(owner.account).length, 0);
      } finally {
        await sessions.disposeAll();
      }
    });

    test("AUTH-CAPTCHA: a human challenge asks for a person, it is not solved", async () => {
      fixture.reset();
      const { sessions, service, shown } = serviceFor(engine, {
        email: owner.identifier,
        password: owner.password,
      });
      try {
        const result = await service.login(actor, {
          plan: planFor(engine, { entryUrl: fixture.url("/challenge") }),
        });
        assert.equal(
          result.status,
          "requires-human",
          `expected a handoff, got ${shown(result)}`,
        );
        assert.equal(
          result.status === "requires-human" ? result.reason : undefined,
          "human-challenge",
        );
        assert.equal(fixture.submissions().length, 0);
      } finally {
        await sessions.disposeAll();
      }
    });

    test("AUTH-CONDITIONAL: a passkey offered beside a password is still a password login", async () => {
      // The distinction the driver makes before an interpreter is consulted:
      //
      //   const passkeyOnly =
      //     snapshot.passkey &&
      //     !snapshot.elements.some((element) => element.type === "password");
      //
      // `[autocomplete~="webauthn"]` is a real published signal, and its own
      // comment calls it conditional passkey UI - a browser *may* offer a
      // passkey in the identifier field, and the form still takes a password
      // from everyone who has not got one. That is what most large providers
      // serve now.
      //
      // Get it wrong in the obvious direction - treat any passkey hint as a
      // passkey prompt - and every one of those providers stops being
      // signable-in: the attempt hands off to a person who has nothing to do,
      // on a page the driver could have completed itself. AUTH-PASSKEY covers
      // the page that genuinely needs an authenticator; this covers the far
      // more common one that does not, and until now nothing drove it on a
      // real browser.
      fixture.reset();
      const { sessions, service, shown } = serviceFor(engine, {
        email: owner.identifier,
        password: owner.password,
      });
      try {
        const result = await service.login(actor, {
          plan: planFor(engine, {
            entryUrl: fixture.url("/signin-conditional"),
          }),
          // Deliberately no `human`. A handoff here would not merely be
          // wasteful - with nobody to ask, the attempt ends by name instead
          // of signing in, which is exactly the failure being guarded
          // against, and it shows up as a refusal rather than as a hang.
        });
        assert.equal(
          result.status,
          "verified",
          `a passkey hint beside a password must not require a person, got ${shown(result)}`,
        );
        if (result.status !== "verified") return;

        // The provider's own record: the password was sent, to the
        // conditional route, and it matched. Not "the driver did not hand
        // off" - what it actually did instead.
        const submissions = fixture.submissions();
        assert.deepEqual(
          submissions.map((submission) => submission.path),
          ["/signin-conditional"],
        );
        assert.equal(submissions[0]?.account, owner.account);
        assert.equal(submissions[0]?.passwordMatched, true);
        assert.equal(fixture.sessionsFor(owner.account).length, 1);
      } finally {
        await sessions.disposeAll();
      }
    });

    test("AUTH-PASSKEY: an authenticator-only page hands off rather than inventing an assertion", async () => {
      fixture.reset();
      const { sessions, service, shown } = serviceFor(engine, {
        email: owner.identifier,
        password: owner.password,
      });
      try {
        const result = await service.login(actor, {
          plan: planFor(engine, { entryUrl: fixture.url("/passkey") }),
        });
        assert.equal(
          result.status,
          "requires-human",
          `expected a handoff, got ${shown(result)}`,
        );
        assert.equal(
          result.status === "requires-human" ? result.reason : undefined,
          "passkey",
        );
        assert.equal(fixture.sessionsFor(owner.account).length, 0);
      } finally {
        await sessions.disposeAll();
      }
    });

    test("TARGET-FRAME: the credential form belongs to another origin's frame", async () => {
      // The shape `frameOrigins` exists for, and the one nothing could drive.
      // `/framed` has no fields of its own: the form is the partner origin's,
      // inside an iframe. A driver bound to the main frame observes a
      // document with nothing to fill, so this login is unreachable rather
      // than merely awkward - and until #62 the plan describing it compiled
      // clean and was then ignored.
      //
      // The partner is a separate server with its own cookies, which is what
      // makes the assertions below about *which* origin signed the account in
      // rather than merely that something did. It is also the first browser
      // case to use that second origin at all: it has existed since the
      // fixture did and only its own self-test ever reached it.
      fixture.reset();
      fixture.partner.reset();
      const { sessions, service, shown } = serviceFor(engine, {
        email: owner.identifier,
        password: owner.password,
      });
      try {
        const result = await service.login(actor, {
          plan: planFor(engine, {
            entryUrl: fixture.url("/framed"),
            navigationOrigins: [fixture.origin, fixture.partner.origin],
            frameOrigins: [fixture.partner.origin],
            // The secret may reach the frame's origin and nowhere else. The
            // embedding page is not a recipient just because it is the page.
            credentialRecipients: {
              email: [fixture.partner.origin],
              password: [fixture.partner.origin],
            },
            verifierOrigin: fixture.partner.origin,
          }),
        });
        assert.equal(
          result.status,
          "verified",
          `expected a verified login inside the frame, got ${shown(result)}`,
        );
        if (result.status !== "verified") return;

        // The oracle is the partner's own record, and the embedding origin's
        // silence is half of it: a credential typed into the frame must reach
        // the frame's server and no other.
        const submissions = fixture.partner.submissions();
        assert.deepEqual(
          submissions.map((submission) => submission.path),
          ["/signin"],
        );
        assert.equal(submissions[0]?.account, owner.account);
        assert.equal(submissions[0]?.passwordMatched, true);
        assert.equal(fixture.partner.sessionsFor(owner.account).length, 1);
        assert.deepEqual(fixture.submissions(), []);
      } finally {
        await sessions.disposeAll();
      }
    });

    test("TARGET-POPUP: the sign-in happens in a window the page opens, and comes back", async () => {
      // The shape `popupBinding` exists for. `/popup` has no fields of its
      // own: a button opens the provider's form in a window, the credential
      // is typed there, and the window reports back and closes. A driver
      // bound to the page would press the button and then watch a page that
      // never changes; one that adopted any window the page opened would
      // type wherever the page pointed it. This adopts a window only at an
      // origin the plan admits, only while it is the one such window, and
      // hands the attempt back to the page when the window closes.
      fixture.reset();
      const { sessions, service, shown } = serviceFor(engine, {
        email: owner.identifier,
        password: owner.password,
      });
      try {
        const result = await service.login(actor, {
          plan: planFor(engine, {
            entryUrl: fixture.url("/popup"),
            required: { popupBinding: true },
          }),
        });
        assert.equal(
          result.status,
          "verified",
          `expected a verified login through the window, got ${shown(result)}`,
        );
        if (result.status !== "verified") return;
        // The provider's own record says the credential went through the
        // window's form and nowhere else, and the session is the one the
        // window opened - shared with the page that verification reads
        // through, which is what "comes back" means.
        const submissions = fixture.submissions();
        assert.deepEqual(
          submissions.map((submission) => submission.path),
          ["/signin-window"],
        );
        assert.equal(submissions[0]?.account, owner.account);
        assert.equal(submissions[0]?.passwordMatched, true);
        assert.equal(fixture.sessionsFor(owner.account).length, 1);
      } finally {
        await sessions.disposeAll();
      }
    });

    test("TARGET-POPUP: a window somewhere undeclared stops the attempt", async () => {
      // Same page, same button, and the window opens at the partner origin,
      // which this plan does not admit. It is refused before it is read - an
      // observation is what an interpreter is shown - and the partner's
      // silence says no credential followed it there.
      fixture.reset();
      fixture.partner.reset();
      const { sessions, service, shown } = serviceFor(engine, {
        email: owner.identifier,
        password: owner.password,
      });
      try {
        const result = await service.login(actor, {
          plan: planFor(engine, {
            entryUrl: fixture.url("/popup-elsewhere"),
            required: { popupBinding: true },
          }),
        });
        assert.equal(
          result.status,
          "blocked",
          `a window outside the declared origins must stop, got ${shown(result)}`,
        );
        assert.equal(
          result.status === "blocked" ? result.reason : undefined,
          "popup-undeclared",
        );
        assert.deepEqual(fixture.partner.submissions(), []);
        assert.equal(fixture.partner.canary.sawValue(owner.password), false);
      } finally {
        await sessions.disposeAll();
      }
    });

    test("ORIGIN-REDIRECT: a redirect somewhere undeclared stops the attempt", async () => {
      // Navigation scope is not a hint. `/sso?redirect=1` answers 302 to the
      // partner origin, which this plan does not declare, so the attempt has
      // been carried somewhere its configuration never admitted - and the
      // interesting half is that it happened without anybody choosing it. A
      // provider can redirect wherever it likes; what must not follow is a
      // credential.
      //
      // End to end, on a real browser, and deliberately not claiming *which*
      // guard stops it: two do, and removing either one leaves this case
      // green. The navigation guard is pinned on its own by "an undeclared
      // origin is refused before it is read" in `browser-driver`, which is
      // the one that can tell them apart.
      fixture.reset();
      fixture.partner.reset();
      const { sessions, service, shown } = serviceFor(engine, {
        email: owner.identifier,
        password: owner.password,
      });
      try {
        const result = await service.login(actor, {
          plan: planFor(engine, {
            entryUrl: fixture.url("/sso?redirect=1"),
          }),
        });
        assert.equal(
          result.status,
          "blocked",
          `a redirect outside the declared origins must stop, got ${shown(result)}`,
        );
        assert.equal(
          result.status === "blocked" ? result.reason : undefined,
          "unapproved-recipient",
        );
        // The oracle is the partner's silence. "Blocked" would be worth little
        // if the password had already gone there.
        assert.deepEqual(fixture.partner.submissions(), []);
        assert.equal(fixture.partner.canary.sawValue(owner.password), false);
      } finally {
        await sessions.disposeAll();
      }
    });

    test("ORIGIN-RESOURCE: a subresource is not contained, and nothing claims it is", async () => {
      // The limit, pinned rather than implied. `strongEgressContainment` is
      // false on every engine, and this is what that costs: `/resourced` is an
      // ordinary sign-in page on a declared origin that also pulls one image
      // from an undeclared one, exactly as most real sign-in pages do. The
      // login completes and the image is fetched.
      //
      // Written as a passing case on purpose. A gap nobody has measured tends
      // to be remembered as smaller than it is, and the day something does
      // enforce containment this case fails and has to be rewritten - which is
      // the notification that the claim changed.
      fixture.reset();
      fixture.partner.reset();
      const { sessions, service, shown } = serviceFor(engine, {
        email: owner.identifier,
        password: owner.password,
      });
      try {
        const result = await service.login(actor, {
          plan: planFor(engine, { entryUrl: fixture.url("/resourced") }),
        });
        assert.equal(
          result.status,
          "verified",
          `expected a verified login, got ${shown(result)}`,
        );

        // Document control held: the credential went to the declared origin
        // and the undeclared one received none.
        assert.deepEqual(
          fixture.submissions().map((submission) => submission.path),
          ["/signin"],
        );
        assert.deepEqual(fixture.partner.submissions(), []);

        // And resource control does not exist: the browser fetched the image
        // from an origin this plan never declared.
        assert.deepEqual(fixture.partner.resourceHits(), ["/pixel"]);
      } finally {
        await sessions.disposeAll();
      }
    });

    test("LIFE-MANAGED: disposal ends this session and leaves the provider's alone", async () => {
      fixture.reset();
      const { sessions, service, shown } = serviceFor(engine, {
        email: owner.identifier,
        password: owner.password,
      });
      try {
        const result = await service.login(actor, { plan: planFor(engine) });
        assert.equal(
          result.status,
          "verified",
          `expected a verified login, got ${shown(result)}`,
        );
        if (result.status !== "verified") return;

        const released = await sessions.release(
          actor,
          result.sessionRef,
          "dispose-managed",
        );
        assert.deepEqual(released, {
          kind: "dispose-managed",
          automationRevoked: true,
          managedResourcesDisposed: true,
          userBrowserPreserved: true,
          // Ceremony closed a browser it started. The provider never heard
          // about it, and the result refuses to imply otherwise.
          upstreamLogout: false,
        });
        assert.equal(fixture.sessionsFor(owner.account).length, 1);
        await assert.rejects(() => sessions.resolve(actor, result.sessionRef));
      } finally {
        await sessions.disposeAll();
      }
    });

    test("LIFE-LEGACY: a dispose continuation still verifies and still cleans up", async () => {
      fixture.reset();
      const { sessions, service, shown } = serviceFor(engine, {
        email: owner.identifier,
        password: owner.password,
      });
      try {
        const result = await service.login(actor, {
          plan: planFor(engine, { continuation: "dispose" }),
        });
        assert.equal(
          result.status,
          "verified",
          `expected a verified login, got ${shown(result)}`,
        );
        if (result.status !== "verified") return;
        // The account really was verified; the session simply does not outlive
        // the call, which is the behaviour existing ephemeral flows rely on.
        await assert.rejects(() => sessions.resolve(actor, result.sessionRef));
      } finally {
        await sessions.disposeAll();
      }
    });

    test("EFFECT-DUP: the same request twice reaches the provider once", async () => {
      fixture.reset();
      const { sessions, service, shown } = serviceFor(engine, {
        email: owner.identifier,
        password: owner.password,
      });
      try {
        const first = await service.login(actor, {
          plan: planFor(engine),
          idempotencyKey: "retry-me",
        });
        assert.equal(
          first.status,
          "verified",
          `expected a verified login, got ${shown(first)}`,
        );

        // A client whose connection dropped while the first call was running
        // does the obvious thing and asks again. The provider must not see a
        // second login for it.
        const second = await service.login(actor, {
          plan: planFor(engine),
          idempotencyKey: "retry-me",
        });
        // Answered, not re-run: the retry repeats the first call's result.
        // What proves it did not re-run is the provider's records below, not
        // the shape of this reply.
        assert.deepEqual(second, first);

        // The oracle, again the provider's own records: one credential
        // submission, one session. Not "the service said it deduplicated".
        assert.equal(fixture.submissions().length, 1);
        assert.equal(fixture.sessionsFor(owner.account).length, 1);
      } finally {
        await sessions.disposeAll();
      }
    });

    test("EFFECT-NEW: a different request is not suppressed by an earlier one", async () => {
      fixture.reset();
      const { sessions, service, shown } = serviceFor(engine, {
        email: owner.identifier,
        password: owner.password,
      });
      try {
        const first = await service.login(actor, {
          plan: planFor(engine),
          idempotencyKey: "first-request",
        });
        assert.equal(
          first.status,
          "verified",
          `expected a verified login, got ${shown(first)}`,
        );
        const second = await service.login(actor, {
          plan: planFor(engine),
          idempotencyKey: "second-request",
        });
        // Deduplication that swallowed a genuinely new request would be a
        // worse defect than the duplicate it was built to prevent.
        assert.equal(
          second.status,
          "verified",
          `expected the second request to run, got ${shown(second)}`,
        );
        assert.equal(fixture.submissions().length, 2);
      } finally {
        await sessions.disposeAll();
      }
    });

    test("EFFECT-LEDGER: a completed login is recorded as settled, not undetermined", async () => {
      fixture.reset();
      const { sessions, service, shown } = serviceFor(engine, {
        email: owner.identifier,
        password: owner.password,
      });
      try {
        const result = await service.login(actor, {
          plan: planFor(engine),
          idempotencyKey: "settled-request",
        });
        assert.equal(
          result.status,
          "verified",
          `expected a verified login, got ${shown(result)}`,
        );

        // The replay path is the only way to read back the effect a caller
        // never sees a reference to, and it is exactly what a retrying client
        // would hit.
        const replay = await service.login(actor, {
          plan: planFor(engine),
          idempotencyKey: "settled-request",
        });
        // An idempotent request answers the same thing twice. Anything else —
        // including a refusal that borrows a reason meaning something it did
        // not mean — tells a caller whose login worked that it did not, and
        // sends them back with a fresh key to log in a second time.
        assert.deepEqual(
          replay,
          result,
          `expected the replay to repeat the first answer, got ${JSON.stringify(replay)}`,
        );
        assert.equal(fixture.submissions().length, 1);
      } finally {
        await sessions.disposeAll();
      }
    });
  });
}

describe("engine identity", () => {
  test("ENGINE-REAL: each backend reports the executable that actually ran", async () => {
    // Asked of the browsers that ran the cases above, not of three fresh ones.
    // A throwaway launch could only report the version of a browser that
    // proved nothing; these are the processes the conformance results came
    // from, which is the version worth recording as evidence. It also keeps
    // the file from holding six engines open at once.
    for (const engine of browserEngines) {
      const browser = engines.get(engine);
      assert.ok(browser, `${engine} must have been launched for its cases`);
      assert.equal(browser.descriptor.engine, engine);
      assert.match(
        browser.descriptor.engineVersion,
        /\d+/,
        `${engine} must report a real version, not a placeholder`,
      );
      assert.equal(browser.descriptor.ownership, "managed");
      assert.equal(browser.alive(), true);
    }
  });
});
