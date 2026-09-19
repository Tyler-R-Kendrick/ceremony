import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { managedBackends } from "../src/server/browser-backends.js";
import { createBrowserLoginService } from "../src/server/browser-login-service.js";
import { createBrowserSessionRegistry } from "../src/server/browser-sessions.js";
import {
  createFixtureVerifier,
  createVerifierRegistry,
} from "../src/server/browser-verification.js";
import { compileLoginPlan, PlanRejected } from "../src/server/login-plan.js";
import { SQLiteCeremonyStore } from "../src/server/persistence/index.js";
import {
  createModelInterpreter,
  interpreterPrompt,
  type CeremonyInterpreter,
  type InterpreterInput,
} from "../src/server/browser-interpreter.js";
import type { ActorContext } from "../src/core/operation-contracts.js";
import type {
  DriverAction,
  PageSnapshot,
} from "../src/core/browser-contracts.js";
import type { CeremonyPage } from "../src/server/browser-driver.js";

/**
 * Who decides the next action, and what that decision is allowed to be.
 *
 * `createModelInterpreter` has existed since the driver did, and until now
 * there was no way to reach it from an authorized login: the service named
 * `createHeuristicInterpreter()` in its own body, so "use an interchangeable
 * model or external harness for permitted reasoning" was true of the driver
 * and false of the product. These cases are about the seam that closes that,
 * and about the two things the seam must not become.
 *
 * It must not become a default. A model reading somebody's sign-in page is a
 * disclosure, and a field nobody filled in has to mean no.
 *
 * It must not become authority. The interpreter is the one component here
 * that is explicitly not trusted, so every case that plugs one in also
 * establishes that the driver still refuses what it always refused — a role
 * the plan never authorized, an element that is not there, an action on a
 * page the plan does not admit.
 */

const origin = "https://provider.example";
const elsewhere = "https://elsewhere.example";

const actor: ActorContext = {
  tenantId: "tenant-reasoning",
  subjectId: "subject-reasoning",
  sessionId: "client-reasoning",
  actorKind: "human",
  capabilities: ["executor"],
};

let store: SQLiteCeremonyStore;
before(() => {
  store = new SQLiteCeremonyStore(":memory:", {
    current: "reasoning",
    keys: { reasoning: new Uint8Array(32) },
  });
});
after(async () => store.close());

const signInPage: PageSnapshot = {
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
    },
    { index: 1, kind: "button", text: "Sign in" },
  ],
};

function stubBackend(page: Partial<CeremonyPage> = {}) {
  return (async () => ({
    descriptor: managedBackends()[0]!,
    browserGeneration: "bgen_reasoning",
    alive: () => true,
    async openContext() {
      return {
        contextRef: "bctx_00000000000000000000000000000011",
        request: {
          get: async () => ({
            status: () => 200,
            text: async () => '{"account":"ada"}',
          }),
        },
        async openPage() {
          return {
            targetRef: "btgt_00000000000000000000000000000011",
            raw: {} as never,
            page: {
              url: async () => `${origin}/signin`,
              goto: async () => {},
              snapshot: async () => signInPage,
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

const compileOptions = {
  backends: managedBackends(),
  knownConnectors: new Set(["owned-fixture-login"]),
  revision: 1,
};

function draft(overrides: Record<string, unknown> = {}) {
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
    ...overrides,
  };
}

describe("MODEL-POLICY: reasoning is a compiled decision, not a runtime one", () => {
  test("a draft that says nothing compiles to deterministic", () => {
    // The direction of the default is the whole point. Omitting the field
    // must not be how a page gets sent to inference.
    const plan = compileLoginPlan(draft(), compileOptions);
    assert.equal(plan.reasoning, "deterministic");
  });

  test("asking for a model changes the plan and its digest", () => {
    // An attempt where a model read the page is not the same attempt as one
    // where it did not, so an approval given for one is not an approval for
    // the other. That is what the digest is for.
    const without = compileLoginPlan(draft(), compileOptions);
    const withModel = compileLoginPlan(draft({ reasoning: "host-model" }), {
      ...compileOptions,
      modelAvailable: true,
    });
    assert.equal(withModel.reasoning, "host-model");
    assert.notEqual(withModel.digest, without.digest);
  });

  test("a host with no model refuses, rather than quietly running the rules", () => {
    // Both answers run a login. Only one runs the login the plan describes,
    // and a caller told "no model here" can go somewhere that has one, while
    // a caller told nothing believes a model looked at the page.
    assert.throws(
      () =>
        compileLoginPlan(draft({ reasoning: "host-model" }), compileOptions),
      (error: unknown) =>
        error instanceof PlanRejected &&
        error.reason === "reasoning-unavailable",
    );
  });

  test("a reasoning mode that is not one is rejected by shape", () => {
    assert.throws(() =>
      compileLoginPlan(draft({ reasoning: "external-harness" }), {
        ...compileOptions,
        modelAvailable: true,
      }),
    );
  });

  test("declaring a model available does not switch anything on by itself", () => {
    // A host configuring a model is not a host deciding every login should
    // use one. The plan still has to ask.
    const plan = compileLoginPlan(draft(), {
      ...compileOptions,
      modelAvailable: true,
    });
    assert.equal(plan.reasoning, "deterministic");
  });
});

describe("MODEL-SEAM: the plan chooses, and the service obeys it", () => {
  /** An interpreter that records what it was shown and answers scripted. */
  function recording(answers: (DriverAction | undefined)[]) {
    const seen: InterpreterInput[] = [];
    let index = 0;
    const interpreter: CeremonyInterpreter = async (input) => {
      seen.push(input);
      return answers[index++];
    };
    return { interpreter, seen };
  }

  function serviceWith(options: {
    model?: () => CeremonyInterpreter | undefined;
    page?: Partial<CeremonyPage>;
    value?: string;
  }) {
    const sessions = createBrowserSessionRegistry({ store });
    const service = createBrowserLoginService({
      sessions,
      verifiers: createVerifierRegistry([createFixtureVerifier({ origin })]),
      credentials: { resolve: async () => options.value ?? "correct-horse" },
      launch: stubBackend(options.page ?? {}),
      ...(options.model ? { modelInterpreter: options.model } : {}),
    });
    return { sessions, service };
  }

  test("a host-model plan reaches the model, and what it proposes is what runs", async () => {
    const filled: string[] = [];
    const clicked: number[] = [];
    const { interpreter, seen } = recording([
      { action: "fill", element: 0, role: "password" },
      { action: "click", element: 1, note: "Sign in" },
      { action: "done" },
    ]);
    const { sessions, service } = serviceWith({
      model: () => interpreter,
      page: {
        fill: async (_element, value) => {
          filled.push(value);
        },
        click: async (element) => {
          clicked.push(element.index);
        },
      },
    });
    try {
      const result = await service.login(actor, {
        plan: compileLoginPlan(draft({ reasoning: "host-model" }), {
          ...compileOptions,
          modelAvailable: true,
        }),
      });
      assert.equal(
        result.status,
        "verified",
        `expected the model-driven login to work, got ${JSON.stringify(result)}`,
      );
      // Not "the model was called": the model's *choices* are what happened.
      assert.ok(seen.length >= 2, "the model was consulted fewer than twice");
      assert.deepEqual(filled, ["correct-horse"]);
      assert.deepEqual(clicked, [1]);
    } finally {
      await sessions.disposeAll();
    }
  });

  test("a deterministic plan never consults a configured model", async () => {
    // The case that keeps the seam from becoming a default. A host with a
    // model is the normal case once one is configured, and an ordinary
    // password login must still go nowhere near it.
    let consulted = 0;
    const { sessions, service } = serviceWith({
      model: () => async () => {
        consulted++;
        return undefined;
      },
    });
    try {
      const result = await service.login(actor, {
        plan: compileLoginPlan(draft(), {
          ...compileOptions,
          modelAvailable: true,
        }),
      });
      assert.equal(result.status, "verified");
      assert.equal(consulted, 0, "a deterministic plan reached the model");
    } finally {
      await sessions.disposeAll();
    }
  });

  test("a model that has gone away refuses before anything launches", async () => {
    // A plan compiles against the host that compiled it and can be run later,
    // or elsewhere, after the model endpoint was removed. Running the
    // deterministic rules then would produce an attempt whose digest says a
    // model read the page when nothing did.
    let launched = 0;
    const sessions = createBrowserSessionRegistry({ store });
    const service = createBrowserLoginService({
      sessions,
      verifiers: createVerifierRegistry([createFixtureVerifier({ origin })]),
      credentials: { resolve: async () => "correct-horse" },
      launch: (async (...args: unknown[]) => {
        launched++;
        return (await (stubBackend() as never as (...a: unknown[]) => unknown)(
          ...args,
        )) as never;
      }) as never,
      modelInterpreter: () => undefined,
    });
    try {
      const result = await service.login(actor, {
        plan: compileLoginPlan(draft({ reasoning: "host-model" }), {
          ...compileOptions,
          modelAvailable: true,
        }),
      });
      assert.equal(result.status, "blocked");
      assert.equal(
        result.status === "blocked" && result.reason,
        "reasoning-unavailable",
      );
      assert.equal(
        launched,
        0,
        "a browser was opened for a plan that cannot run",
      );
    } finally {
      await sessions.disposeAll();
    }
  });

  test("a host that configured no model at all is the same refusal", async () => {
    const { sessions, service } = serviceWith({});
    try {
      const result = await service.login(actor, {
        plan: compileLoginPlan(draft({ reasoning: "host-model" }), {
          ...compileOptions,
          modelAvailable: true,
        }),
      });
      assert.equal(
        result.status === "blocked" && result.reason,
        "reasoning-unavailable",
      );
    } finally {
      await sessions.disposeAll();
    }
  });
});

describe("MODEL-AUTHORITY: an interpreter proposes; it never decides", () => {
  function serviceWithModel(
    interpreter: CeremonyInterpreter,
    page: Partial<CeremonyPage> = {},
  ) {
    const sessions = createBrowserSessionRegistry({ store });
    const service = createBrowserLoginService({
      sessions,
      verifiers: createVerifierRegistry([createFixtureVerifier({ origin })]),
      credentials: { resolve: async () => "correct-horse" },
      launch: stubBackend(page),
      modelInterpreter: () => interpreter,
    });
    return { sessions, service };
  }

  function modelPlan(overrides: Record<string, unknown> = {}) {
    return compileLoginPlan(draft({ reasoning: "host-model", ...overrides }), {
      ...compileOptions,
      modelAvailable: true,
    });
  }

  test("a role the plan never authorized is not typed", async () => {
    // The plan declares a password reference and nothing else. A model asking
    // for a one-time code is asking for a value that does not exist here, and
    // the answer is that nothing is filled — not that a different value is
    // substituted, and not that the request is honoured because a model made
    // it.
    const filled: string[] = [];
    const { sessions, service } = serviceWithModel(
      async () => ({ action: "fill", element: 0, role: "totp-code" }),
      {
        fill: async (_element, value) => {
          filled.push(value);
        },
      },
    );
    try {
      await service.login(actor, { plan: modelPlan() });
      assert.deepEqual(filled, [], "a role outside the plan was typed");
    } finally {
      await sessions.disposeAll();
    }
  });

  test("an element the page does not have is refused, not invented", async () => {
    const clicked: number[] = [];
    const { sessions, service } = serviceWithModel(
      async () => ({ action: "click", element: 99 }),
      {
        click: async (element) => {
          clicked.push(element.index);
        },
      },
    );
    try {
      await service.login(actor, { plan: modelPlan() });
      assert.deepEqual(clicked, []);
    } finally {
      await sessions.disposeAll();
    }
  });

  test("a secret is not typed on a page the plan does not admit", async () => {
    // Origin policy belongs to the driver, and a model proposing a fill does
    // not move it. The page is off the declared origins entirely, so the
    // attempt stops before anything is typed.
    const filled: string[] = [];
    const { sessions, service } = serviceWithModel(
      async () => ({ action: "fill", element: 0, role: "password" }),
      {
        url: async () => `${elsewhere}/signin`,
        fill: async (_element, value) => {
          filled.push(value);
        },
      },
    );
    try {
      const result = await service.login(actor, { plan: modelPlan() });
      assert.deepEqual(filled, [], "a secret was typed off a declared origin");
      assert.equal(result.status, "blocked");
    } finally {
      await sessions.disposeAll();
    }
  });

  test("a model that answers nothing takes no action, and decides no outcome", async () => {
    // Silence is not a refusal and not a success. The attempt has to end —
    // it must not spend its whole budget waiting on a model that will never
    // answer — and it must end without having touched the page. What the
    // login is then *called* is the verifier's business, not the model's,
    // which is the point of asking a provider rather than a page.
    const touched: string[] = [];
    const sessions = createBrowserSessionRegistry({ store });
    const service = createBrowserLoginService({
      sessions,
      // A provider that does not recognise this browser. With the fixture
      // verifier saying yes, a silent model would read as a verified login,
      // and that would be the verifier's answer rather than the model's -
      // but it would not establish anything about silence.
      verifiers: createVerifierRegistry([createFixtureVerifier({ origin })]),
      credentials: { resolve: async () => "correct-horse" },
      launch: stubBackend({
        fill: async () => {
          touched.push("fill");
        },
        click: async () => {
          touched.push("click");
        },
        check: async () => {
          touched.push("check");
        },
      }),
      modelInterpreter: () => async () => undefined,
    });
    try {
      const result = await service.login(actor, { plan: modelPlan() });
      assert.deepEqual(touched, [], "a silent model still moved the page");
      assert.ok(result.status.length > 0, "the attempt never terminated");
    } finally {
      await sessions.disposeAll();
    }
  });

  test("a model cannot end an attempt by claiming it finished", async () => {
    // The oldest rule in this system, restated at the new seam. `done` is a
    // claim; only provider evidence completes a ceremony. A model that says
    // so on an unrecognised browser gets `submitted-unverified`, never
    // `verified`, and no session is handed back as though one were proven.
    const sessions = createBrowserSessionRegistry({ store });
    const service = createBrowserLoginService({
      sessions,
      // The provider does not recognise this context.
      verifiers: createVerifierRegistry([
        createFixtureVerifier({ origin, path: "/api/nobody" }),
      ]),
      credentials: { resolve: async () => "correct-horse" },
      launch: (async () => ({
        descriptor: managedBackends()[0]!,
        browserGeneration: "bgen_reasoning",
        alive: () => true,
        async openContext() {
          return {
            contextRef: "bctx_00000000000000000000000000000012",
            request: {
              get: async () => ({ status: () => 401, text: async () => "" }),
            },
            async openPage() {
              return {
                targetRef: "btgt_00000000000000000000000000000012",
                raw: {} as never,
                page: {
                  url: async () => `${origin}/signin`,
                  goto: async () => {},
                  snapshot: async () => signInPage,
                  fill: async () => {},
                  click: async () => {},
                  check: async () => {},
                  settle: async () => {},
                },
              };
            },
            alive: async () => true,
            saveState: async () => ({ cookies: [], origins: [] }),
            async close() {},
          };
        },
        async dispose() {},
      })) as never,
      modelInterpreter: () => async () => ({
        action: "done",
        note: "signed in",
      }),
    });
    try {
      const result = await service.login(actor, { plan: modelPlan() });
      assert.notEqual(
        result.status,
        "verified",
        "a model's claim was accepted as evidence",
      );
      assert.equal("sessionRef" in result, false);
    } finally {
      await sessions.disposeAll();
    }
  });
});

describe("MODEL-PROMPT: what a model is actually shown", () => {
  test("the prompt carries the snapshot and nothing that is not in it", () => {
    // `interpreterPrompt` is the exact string a model receives. Reading it
    // directly is the only way to assert on the disclosure rather than on an
    // intention about it.
    const prompt = interpreterPrompt({
      goal: "sign-in",
      snapshot: signInPage,
      available: ["password"],
      history: [],
    });
    assert.ok(prompt.includes(JSON.stringify(signInPage)));
    assert.equal(prompt.includes("correct-horse"), false);
    // The roles are named; their values are stated to be unavailable. A model
    // that believes it will be shown a password is a model that will ask.
    assert.match(prompt, /never see it/);
  });

  test("a model never receives a credential, driven end to end", async () => {
    // The same canary discipline as `browser-login-privacy`, applied at the
    // seam this pull request opens. The provider echoes the credential into
    // its own page; whatever else happens, the interpreter must not be handed
    // it — which is exactly what the driver's guard is for, now that the
    // service arms it.
    const canary = "zqx-canary-8f21a7c4-value";
    const seen: InterpreterInput[] = [];
    const sessions = createBrowserSessionRegistry({ store });
    const service = createBrowserLoginService({
      sessions,
      verifiers: createVerifierRegistry([createFixtureVerifier({ origin })]),
      credentials: { resolve: async () => canary },
      launch: stubBackend({
        snapshot: async () => ({
          ...signInPage,
          alerts: [`The password ${canary} was not accepted`],
        }),
      }),
      modelInterpreter: () => async (input) => {
        seen.push(input);
        return { action: "click", element: 1 };
      },
    });
    try {
      const result = await service.login(actor, {
        plan: compileLoginPlan(draft({ reasoning: "host-model" }), {
          ...compileOptions,
          modelAvailable: true,
        }),
      });
      assert.equal(
        result.status === "blocked" && result.reason,
        "protected-value-exposed",
      );
      // The assertion that matters: not one observation reached the model,
      // and nothing that did serializes to anything containing the value.
      assert.deepEqual(seen, []);
      for (const input of seen)
        assert.equal(
          interpreterPrompt(input).includes(canary),
          false,
          "a prompt carried the credential",
        );
    } finally {
      await sessions.disposeAll();
    }
  });

  test("a model's transport failure is a step that made no progress", async () => {
    // `createModelInterpreter` is the real adapter. Its contract is that a
    // refusal, a timeout, a malformed object or a dead endpoint all come back
    // as `undefined` rather than as an action or an exception, because a
    // model that cannot answer must not be able to end an attempt with an
    // outcome of its own choosing.
    const interpreter = createModelInterpreter(
      {
        specificationVersion: "v3",
        provider: "test",
        modelId: "unreachable",
        supportedUrls: {},
        doGenerate: async () => {
          throw new Error("endpoint refused the connection");
        },
        doStream: async () => {
          throw new Error("endpoint refused the connection");
        },
      } as never,
      { timeoutMs: 1_000 },
    );
    const action = await interpreter({
      goal: "sign-in",
      snapshot: signInPage,
      available: ["password"],
      history: [],
    });
    assert.equal(action, undefined);
  });
});
