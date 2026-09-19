import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { managedBackends } from "../src/server/browser-backends.js";
import { createEffectLedger } from "../src/server/browser-effects.js";
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
import type { PageSnapshot } from "../src/core/browser-contracts.js";
import type {
  CeremonyPage,
  HumanParticipationRequest,
} from "../src/server/browser-driver.js";

/**
 * The canary suite: one value, planted, then hunted for everywhere.
 *
 * Every other suite here asks whether a login worked. This one assumes it
 * worked and asks what the attempt left lying around. A privacy rule that is
 * only written in a comment is a rule until somebody adds a field, so each
 * case below plants a distinctive value where a credential really goes and
 * then searches a boundary for it — serialized whole, so a new field carrying
 * it fails the case whether or not anybody thought to assert on that field.
 *
 * The canary is a string nothing else in the repository produces. Searching
 * for it is exact, and a hit is never a coincidence.
 *
 * What these cases are *not*: proof that a real provider is safe. They cover
 * the surfaces this codebase owns — what an interpreter is handed, what a
 * rejection says, what reaches the database, what a host is told when a
 * person is needed. A provider that writes a password into its own page is
 * still a provider doing that; the case is about whether Ceremony then
 * carries it any further.
 */

const CANARY = "zqx-canary-8f21a7c4-value";
const origin = "https://provider.example";

const actor: ActorContext = {
  tenantId: "tenant-privacy",
  subjectId: "subject-privacy",
  sessionId: "client-privacy",
  actorKind: "human",
  capabilities: ["executor"],
};

let store: SQLiteCeremonyStore;
before(() => {
  store = new SQLiteCeremonyStore(":memory:", {
    current: "privacy",
    keys: { privacy: new Uint8Array(32) },
  });
});
after(async () => store.close());

/**
 * A provider that hands the credential straight back, in every part of a page
 * an observation reads.
 *
 * Providers really do this. An error page renders the submitted form, a
 * single-page app puts the value in a heading while validating, a badly
 * written label interpolates what was typed. It is the provider's defect;
 * what this fixture is for is establishing that it stops there.
 *
 * The password field arrives `filled`, which is the important half. A field
 * the driver types into arms the driver's own guard as a side effect of
 * typing. A field that is *already* filled — by a browser password manager,
 * by a resumed form, by the provider redisplaying a failed attempt — is one
 * the driver submits without ever typing, so nothing about the attempt arms
 * anything. That is the page that used to reach the interpreter unguarded.
 */
function echoingPage(): PageSnapshot {
  return {
    path: `${origin}/signin`,
    title: `Sign in (${CANARY})`,
    headings: [`Welcome back, ${CANARY}`],
    alerts: [`The password ${CANARY} was not accepted`],
    challenge: false,
    passkey: false,
    elements: [
      {
        index: 0,
        kind: "input",
        type: "password",
        name: "password",
        label: `Password ${CANARY}`,
        filled: true,
      },
      { index: 1, kind: "button", text: "Sign in" },
    ],
  };
}

/** The same page with nothing echoed, for the cases that must still pass. */
function cleanPage(): PageSnapshot {
  return {
    path: `${origin}/signin`,
    title: "Sign in",
    headings: [],
    alerts: [],
    challenge: false,
    passkey: false,
    elements: [
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
}

/**
 * A managed browser with a scripted page. The stub is here so the *unhappy*
 * pages are reachable on demand; the service path above it is production's.
 */
function stubBackend(page: Partial<CeremonyPage> = {}) {
  return (async () => ({
    descriptor: managedBackends()[0]!,
    browserGeneration: "bgen_privacy",
    alive: () => true,
    async openContext() {
      return {
        contextRef: "bctx_00000000000000000000000000000009",
        request: {
          get: async () => ({
            status: () => 200,
            text: async () => '{"account":"ada"}',
          }),
        },
        async openPage() {
          return {
            targetRef: "btgt_00000000000000000000000000000009",
            raw: {} as never,
            page: {
              url: async () => `${origin}/signin`,
              goto: async () => {},
              snapshot: async () => cleanPage(),
              fill: async () => {},
              click: async () => {},
              check: async () => {},
              settle: async () => {},
              ...page,
            },
          };
        },
        alive: async () => true,
        saveState: async () => ({ cookies: [], origins: [] }),
        async close() {},
      };
    },
    async dispose() {},
  })) as never;
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
      continuation: "dispose",
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
  launch: ReturnType<typeof stubBackend>,
  value: string = CANARY,
) {
  const sessions = createBrowserSessionRegistry({ store });
  const service = createBrowserLoginService({
    sessions,
    effects: createEffectLedger({ store }),
    verifiers: createVerifierRegistry([createFixtureVerifier({ origin })]),
    credentials: { resolve: async () => value },
    launch,
  });
  return { sessions, service };
}

describe("PRIV-PROMPT: a credential never reaches what reads the page", () => {
  test("a provider echoing the password stops the attempt by that name", async () => {
    // The whole point of the guard is that it fires *before* the snapshot is
    // handed on, so the interpreter — deterministic today, a model the moment
    // F-MODEL is closed — never receives the value at all. From out here the
    // observable is the outcome: the login does not proceed, and the reason
    // says a protected value was about to be exposed rather than blaming the
    // provider for an error it did not have.
    const { sessions, service } = serviceWith(
      stubBackend({ snapshot: async () => echoingPage() }),
    );
    try {
      const result = await service.login(actor, { plan: planFor() });
      assert.equal(result.status, "blocked");
      assert.equal(
        result.status === "blocked" && result.reason,
        "protected-value-exposed",
        `expected the canary reason, got ${JSON.stringify(result)}`,
      );
      // And the refusal itself says nothing about what tripped it.
      assert.equal(JSON.stringify(result).includes(CANARY), false);
    } finally {
      await sessions.disposeAll();
    }
  });

  test("the guard is armed before the first page is read, not after the first fill", async () => {
    // This is the case that fails on the old arrangement. The driver arms its
    // guarded set when it *types* a secret, and this page's field is already
    // filled, so the driver submits without typing and nothing would ever be
    // armed. Every snapshot of the attempt — including the first, before any
    // action at all — has to be checked.
    //
    // Asserted by counting: the page echoes from the very first read, so a
    // guard armed on fill would let at least one observation through and the
    // attempt would get as far as clicking. It must not click.
    let clicks = 0;
    const { sessions, service } = serviceWith(
      stubBackend({
        snapshot: async () => echoingPage(),
        click: async () => {
          clicks++;
        },
      }),
    );
    try {
      const result = await service.login(actor, { plan: planFor() });
      assert.equal(result.status, "blocked");
      // Deliberately not the reason: that is the case above. This one is
      // about *when* the guard is live, and the observable for that is the
      // click that never happened.
      assert.equal(clicks, 0, "the attempt acted on a page it should refuse");
    } finally {
      await sessions.disposeAll();
    }
  });

  test("a page that echoes nothing is unaffected", async () => {
    // The half that keeps the case above honest. A guard that refused
    // everything would satisfy both assertions and break every login, so an
    // ordinary page with the same credential behind it must still verify.
    const { sessions, service } = serviceWith(stubBackend());
    try {
      const result = await service.login(actor, { plan: planFor() });
      assert.equal(
        result.status,
        "verified",
        `expected an ordinary login to work, got ${JSON.stringify(result)}`,
      );
    } finally {
      await sessions.disposeAll();
    }
  });

  test("a value nobody declared secret is not guarded, and an address still shows", async () => {
    // Deliberate, and worth pinning so it is a decision rather than a gap.
    // `email`, `username` and `display-name` are not secret roles: providers
    // legitimately print "signing in as ada@example.test" on their own pages,
    // and a guard on those would report an ordinary login as a leak. Only the
    // roles that are genuinely values — password, confirmation, verification
    // and TOTP codes — arm the canary.
    const identifier = "ada@example.test";
    const { sessions, service } = serviceWith(
      stubBackend({
        snapshot: async () => ({
          ...cleanPage(),
          headings: [`Signing in as ${identifier}`],
        }),
      }),
      identifier,
    );
    try {
      const result = await service.login(actor, {
        plan: planFor({
          credentialRecipients: { email: [origin] },
          credentialRefs: { email: "ref-email" },
        }),
      });
      assert.equal(result.status, "verified");
    } finally {
      await sessions.disposeAll();
    }
  });
});

describe("PRIV-ERROR: a refusal names the field, never the value", () => {
  /**
   * Everything the error object carries, including properties an `Error` does
   * not enumerate. A `detail` added later is caught by this without anybody
   * remembering to assert on it.
   */
  function everything(error: unknown): string {
    if (!(error instanceof Error)) return JSON.stringify(error);
    return `${error.name}\n${error.message}\n${JSON.stringify(
      error,
      Object.getOwnPropertyNames(error),
    )}`;
  }

  /**
   * Every free-form field of a draft, each carrying the canary in turn.
   *
   * A caller putting a credential in the wrong field is exactly how a value
   * arrives somewhere it was never meant to be, and a compiler that echoes
   * what it rejected turns that mistake into a copy in every log the error
   * passes through. Compiling or rejecting are both fine answers; saying the
   * value back is not.
   */
  const fields: [string, Record<string, unknown>][] = [
    ["connectorId", { connectorId: CANARY }],
    ["entryUrl", { entryUrl: `${origin}/signin?token=${CANARY}` }],
    ["navigationOrigins", { navigationOrigins: [CANARY] }],
    ["credentialRefs", { credentialRefs: { password: CANARY } }],
    ["credentialRecipients", { credentialRecipients: { password: [CANARY] } }],
    ["account", { account: { kind: "expect", accountRef: CANARY } }],
    ["engine", { engine: CANARY }],
    ["trustMode", { trustMode: CANARY }],
    ["continuation", { continuation: CANARY }],
    ["an undeclared field", { password: CANARY }],
  ];

  for (const [name, change] of fields)
    test(`a canary in ${name} is not read back out of the rejection`, () => {
      try {
        compileLoginPlan(
          { ...rawDraft(), ...change } as Record<string, unknown>,
          {
            backends: managedBackends(),
            knownConnectors: new Set(["owned-fixture-login"]),
            revision: 1,
          },
        );
      } catch (error) {
        assert.equal(
          everything(error).includes(CANARY),
          false,
          `the rejection for ${name} carried the value: ${everything(error)}`,
        );
      }
    });

  test("a rejection still says which reason, so an interface can explain it", () => {
    // The other half. A refusal stripped of everything would satisfy every
    // case above and leave a person with "no".
    assert.throws(
      () =>
        compileLoginPlan(
          { ...rawDraft(), connectorId: "not-registered" },
          {
            backends: managedBackends(),
            knownConnectors: new Set(["owned-fixture-login"]),
            revision: 1,
          },
        ),
      (error: unknown) =>
        error instanceof PlanRejected && error.reason === "unknown-connector",
    );
  });

  test("a detail that is server-derived is still reported", () => {
    // `detail` is not banned, it is scoped. Which capabilities a backend
    // lacks is something the *server* worked out, is not a caller string at
    // all, and is the difference between "unsupported" and a person knowing
    // what to change.
    assert.throws(
      () =>
        compileLoginPlan(
          { ...rawDraft(), required: { popupBinding: true } },
          {
            backends: managedBackends(),
            knownConnectors: new Set(["owned-fixture-login"]),
            revision: 1,
          },
        ),
      (error: unknown) =>
        error instanceof PlanRejected &&
        error.reason === "unsupported-capability" &&
        error.detail === "popupBinding",
    );
  });

  test("a failure inside the attempt reports a reason, not a message", async () => {
    // A credential source that throws with the value in its message is the
    // realistic shape of this: a collector reporting "no entry for <value>".
    // The service turns every internal failure into a named outcome, and the
    // named outcomes are a closed set, so nothing a thrown error said can
    // reach a caller.
    const sessions = createBrowserSessionRegistry({ store });
    const service = createBrowserLoginService({
      sessions,
      verifiers: createVerifierRegistry([createFixtureVerifier({ origin })]),
      credentials: {
        resolve: async () => {
          throw new Error(`collector has no entry for ${CANARY}`);
        },
      },
      launch: stubBackend({
        snapshot: async () => ({
          ...cleanPage(),
          elements: [
            {
              index: 0,
              kind: "input",
              type: "password",
              name: "password",
              label: "Password",
            },
            { index: 1, kind: "button", text: "Sign in" },
          ],
        }),
      }),
    });
    try {
      const result = await service.login(actor, { plan: planFor() });
      assert.equal(JSON.stringify(result).includes(CANARY), false);
      assert.equal(result.status, "blocked");
    } finally {
      await sessions.disposeAll();
    }
  });
});

describe("PRIV-ARTIFACT: nothing durable holds the value", () => {
  test("no record of any kind, under any tenant key, contains it", async () => {
    // Swept by kind rather than by the kinds this path is known to write.
    // The failure being guarded against is a *new* record, written by a
    // future change, that nobody thought to check — so the sweep asks the
    // store for everything it has and reads it back decrypted, which is
    // strictly more than an attacker with the file would see.
    const { sessions, service } = serviceWith(stubBackend());
    try {
      const result = await service.login(actor, {
        plan: planFor({ continuation: "retain-for-authorized-agent" }),
        idempotencyKey: "privacy-key-1",
      });
      assert.equal(result.status, "verified");

      const hits: string[] = [];
      for (const kind of recordKinds) {
        const rows = await store.transaction((tx) =>
          tx.list<unknown>(actor.tenantId, kind, 500),
        );
        for (const row of rows)
          if (JSON.stringify(row.value).includes(CANARY))
            hits.push(`${kind}/${row.id}`);
      }
      assert.deepEqual(hits, [], `records carrying the credential: ${hits}`);
    } finally {
      await sessions.disposeAll();
    }
  });

  test("the transcript a caller is shown carries paths and actions only", async () => {
    // `onStep` is the progress display. It is the surface most likely to be
    // rendered verbatim into a UI or a log line, and the least likely to be
    // reviewed for what it carries.
    const steps: { path: string; action: string }[] = [];
    const { sessions, service } = serviceWith(stubBackend());
    try {
      await service.login(actor, {
        plan: planFor(),
        onStep: (step) => steps.push(step),
      });
      assert.ok(steps.length > 0, "the attempt reported no steps at all");
      assert.equal(JSON.stringify(steps).includes(CANARY), false);
      // Positively: a step is exactly two fields. A third appearing later is
      // a new thing to review, and this is what makes that visible.
      for (const step of steps)
        assert.deepEqual(Object.keys(step).sort(), ["action", "path"]);
    } finally {
      await sessions.disposeAll();
    }
  });
});

describe("PRIV-ALTERNATE: asking a person is not a way around any of it", () => {
  /** A page whose live URL carries what a real redirect carries. */
  const challengePage: PageSnapshot = {
    path: `${origin}/challenge`,
    title: "Confirm",
    headings: [],
    alerts: [],
    challenge: true,
    passkey: false,
    elements: [],
  };

  test("the handoff names the page by origin and path, never by its query", async () => {
    // The request is the one thing in an attempt that is *meant* to leave the
    // process: a host renders it for a person, sends it as a notification,
    // writes it to an activity log. So it is held to the snapshot's rule.
    //
    // The URL below is an ordinary authorization redirect. Its query carries
    // a code that is a credential for the length of its life and a hint that
    // is the person's address, and handing that to whatever displays the
    // request would put both wherever that display ends up.
    const asked: HumanParticipationRequest[] = [];
    const sessions = createBrowserSessionRegistry({ store });
    const service = createBrowserLoginService({
      sessions,
      verifiers: createVerifierRegistry([]),
      credentials: { resolve: async () => CANARY },
      launch: stubBackend({
        url: async () =>
          `${origin}/challenge?code=${CANARY}&login_hint=ada%40example.test`,
        snapshot: async () => challengePage,
      }),
    });
    try {
      await service.login(actor, {
        plan: planFor({ interactionRounds: 2 }),
        human: {
          contract: {
            surface: "provider-browser",
            recipient: "initiating-subject",
            delegation: "a2h-authorize",
            resume: "verify",
          },
          request: async (request) => {
            asked.push(request);
            return "declined";
          },
        },
      });
      assert.equal(asked.length, 1, "nobody was asked to take part");
      const request = asked[0]!;
      assert.equal(JSON.stringify(request).includes(CANARY), false);
      assert.equal(JSON.stringify(request).includes("login_hint"), false);
      // Still useful: the person is told which page, which is the thing they
      // need in order to act.
      assert.equal(request.path, `${origin}/challenge`);
      assert.equal(request.reason, "human-challenge");
    } finally {
      await sessions.disposeAll();
    }
  });

  test("a declined handoff reports a refusal, and no value with it", async () => {
    const sessions = createBrowserSessionRegistry({ store });
    const service = createBrowserLoginService({
      sessions,
      verifiers: createVerifierRegistry([]),
      credentials: { resolve: async () => CANARY },
      launch: stubBackend({
        url: async () => `${origin}/challenge?code=${CANARY}`,
        snapshot: async () => challengePage,
      }),
    });
    try {
      const result = await service.login(actor, {
        plan: planFor({ interactionRounds: 2 }),
        human: {
          contract: {
            surface: "provider-browser",
            recipient: "initiating-subject",
            delegation: "a2h-authorize",
            resume: "verify",
          },
          request: async () => "declined",
        },
      });
      assert.equal(result.status, "blocked");
      assert.equal(
        result.status === "blocked" && result.reason,
        "human-declined",
      );
      assert.equal(JSON.stringify(result).includes(CANARY), false);
    } finally {
      await sessions.disposeAll();
    }
  });
});

/** The draft the rejection cases start from, before a field is spoiled. */
function rawDraft(): Record<string, unknown> {
  return {
    connectorId: "owned-fixture-login",
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
    credentialRefs: { password: "ref-password" },
    sessionTtlMs: 600_000,
  };
}
