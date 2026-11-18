import assert from "node:assert/strict";
import test from "node:test";
import {
  advance,
  check,
  cooperate,
  derive,
  memoryJournal,
  memoryVault,
  validate,
  type Adapters,
  type Ceremony,
  type CeremonyDecl,
  type HumanAnswer,
  type JournalEntry,
  type OperatorDecl,
  type RunStatus,
} from "../../src/kernel/index.js";
import {
  githubAppAccess,
  type GitHubAppCredentials,
} from "../../src/kernel/flows/github-app.js";
import { unchecked } from "./support.js";

const ceremony = githubAppAccess as unknown as Ceremony;

test("the GitHub App ceremony passes every property with zero, one and two removals", () => {
  for (const invalidations of [0, 1, 2]) {
    const result = check(ceremony, { invalidations });
    assert.equal(result.complete, true);
    assert.deepEqual(result.violations, []);
    assert.deepEqual(result.operatorsUnused, []);
    if (invalidations > 0) assert.deepEqual(result.outcomesUnseen, []);
  }
});

test("every way the GitHub App ceremony can end is one of these", () => {
  const result = check(ceremony, { invalidations: 2 });
  assert.deepEqual(
    result.endings.map((ending) => ending.key),
    [
      "success",
      "terminal:awaiting-approval",
      "terminal:declined",
      "terminal:wrong-owner",
      "unobservable:app",
      "unobservable:appConfig",
      "unobservable:installation",
      "unobservable:target",
      "unobservable:token",
      "unreachable:token",
    ],
  );
  for (const ending of result.endings) assert.ok(ending.trace.length > 0);
});

test("from each starting point only the missing steps run, and nothing is looked at twice", () => {
  const paths: Record<string, { probes: string[]; acts: string[] }> = {
    "": {
      probes: ["token", "installation", "app", "target", "appConfig"],
      acts: [
        "chooseTarget",
        "registerApp",
        "convertManifest",
        "installApp",
        "mintToken",
      ],
    },
    target: {
      probes: ["token", "installation", "app", "target", "appConfig"],
      acts: ["registerApp", "convertManifest", "installApp", "mintToken"],
    },
    "target,manifestCode": {
      probes: ["token", "installation", "app", "target", "appConfig"],
      acts: ["convertManifest", "installApp", "mintToken"],
    },
    "target,appConfig": {
      probes: ["token", "installation", "app", "target", "appConfig"],
      acts: ["adoptConfiguredApp", "installApp", "mintToken"],
    },
    app: {
      probes: ["token", "installation", "app"],
      acts: ["installApp", "mintToken"],
    },
    installation: { probes: ["token", "installation"], acts: ["mintToken"] },
    token: { probes: ["token"], acts: [] },
  };
  for (const [start, expected] of Object.entries(paths)) {
    const run = cooperate(ceremony, start === "" ? [] : start.split(","));
    assert.equal(run.status, "success");
    assert.deepEqual({ probes: run.probes, acts: run.acts }, expected, start);
  }
});

test("the components the flow needs are derived from it", () => {
  const derived = derive(ceremony);
  assert.deepEqual(
    derived.components.map(({ operator, need }) => ({ operator, need })),
    [
      { operator: "chooseTarget", need: "necessary" },
      { operator: "registerApp", need: "necessary" },
      { operator: "installApp", need: "necessary" },
    ],
  );
  const cheapest = derived.paths[0];
  assert.deepEqual(cheapest?.interfaces, []);
  const costliest = derived.paths[derived.paths.length - 1];
  assert.deepEqual(costliest?.interfaces, [
    "chooseTarget",
    "registerApp",
    "installApp",
  ]);
});

/** Each rule, with the smallest change to the GitHub declaration that breaks it. */
const mutations: readonly {
  readonly rule: string;
  readonly mutate: (decl: {
    facts: Record<string, Record<string, unknown>>;
    operators: Record<string, Record<string, unknown>>;
    goal: string[];
  }) => void;
}[] = [
  {
    rule: "stale-precondition",
    mutate: (decl) => {
      delete (decl.operators.mintToken?.outcomes as Record<string, unknown>)
        .installationGone;
    },
  },
  {
    rule: "consumed-detectable",
    mutate: (decl) => {
      delete (
        decl.operators.convertManifest?.outcomes as Record<string, unknown>
      ).codeRejected;
    },
  },
  {
    rule: "single-use",
    mutate: (decl) => {
      (decl.operators.mintToken as { requires: string[] }).requires = [
        "installation",
        "manifestCode",
      ];
    },
  },
  {
    rule: "secret-exposure",
    mutate: (decl) => {
      (decl.operators.installApp?.interface as { shows: string[] }).shows = [
        "app",
      ];
    },
  },
  {
    rule: "interface-outcome",
    mutate: (decl) => {
      (
        decl.operators.installApp?.interface as {
          actions: { outcome: string }[];
        }
      ).actions[0]!.outcome = "teleported";
    },
  },
  {
    rule: "interface-required",
    mutate: (decl) => {
      delete decl.operators.installApp?.interface;
    },
  },
  {
    rule: "operator-success",
    mutate: (decl) => {
      delete (decl.operators.mintToken?.outcomes as Record<string, unknown>)
        .minted;
    },
  },
  {
    rule: "observable-support",
    mutate: (decl) => {
      decl.facts.app!.observable = false;
    },
  },
  {
    rule: "discoverable-observable",
    mutate: (decl) => {
      decl.facts.manifestCode!.discoverable = true;
    },
  },
  {
    rule: "support-cycle",
    mutate: (decl) => {
      decl.facts.target!.requires = ["token"];
    },
  },
  {
    rule: "goal",
    mutate: (decl) => {
      decl.goal = [];
    },
  },
  {
    rule: "invalidates-required",
    mutate: (decl) => {
      (
        decl.operators.chooseTarget?.outcomes as Record<string, unknown>
      ).confused = {
        effect: { kind: "invalidates", facts: ["token"] },
        description: "",
      };
    },
  },
  {
    rule: "ambiguous-invalidation",
    mutate: (decl) => {
      (
        decl.operators.convertManifest?.outcomes as Record<string, unknown>
      ).codeRejected = {
        effect: { kind: "invalidates", facts: ["manifestCode", "target"] },
        description: "",
      };
    },
  },
];

function mutated(mutate: (typeof mutations)[number]["mutate"]): CeremonyDecl {
  const { compiled: _compiled, warnings: _warnings, ...decl } = ceremony;
  // A validator is code, which structuredClone cannot copy: copy everything
  // else and give each copied fact the same value type.
  const facts = Object.fromEntries(
    Object.entries(decl.facts).map(([name, { value: _value, ...rest }]) => [
      name,
      rest,
    ]),
  );
  const copy = structuredClone({ ...decl, facts }) as unknown as Parameters<
    typeof mutate
  >[0];
  for (const [name, declared] of Object.entries(copy.facts)) {
    declared.value = (decl.facts as Record<string, { value: unknown }>)[name]
      ?.value;
  }
  mutate(copy);
  return copy as unknown as CeremonyDecl;
}

for (const { rule, mutate } of mutations) {
  test(`the declaration is refused when it breaks "${rule}"`, () => {
    const rules = validate(mutated(mutate))
      .issues.filter((issue) => issue.severity === "error")
      .map((issue) => issue.rule);
    assert.ok(rules.includes(rule), `got ${rules.join(", ") || "no error"}`);
  });
}

test("without the stale-precondition rule, a removed installation ends a run that could have recovered", () => {
  const result = check(
    unchecked(
      mutated((decl) => {
        delete (decl.operators.mintToken?.outcomes as Record<string, unknown>)
          .installationGone;
      }),
    ),
  );
  const found = result.violations.find(
    (violation) => violation.property === "recoverable",
  );
  assert.ok(found);
  assert.ok(found.trace.some((line) => line.includes("removes installation")));
});

/** A GitHub that exists only in memory, with the calls the ceremony makes. */
class FakeGitHub {
  readonly apps = new Map<
    number,
    { slug: string; owner: string; key: string }
  >();
  readonly installations = new Map<
    number,
    { appId: number; account: string }
  >();
  readonly codes = new Map<string, number>();
  readonly tokens = new Set<string>();
  private serial = 100;
  calls: string[] = [];

  personCreatesApp(owner: string): string {
    this.serial += 1;
    const appId = this.serial;
    this.apps.set(appId, {
      slug: `ceremony-${appId}`,
      owner,
      key: `PRIVATE-KEY-${appId}`,
    });
    const code = `code-${appId}`;
    this.codes.set(code, appId);
    return code;
  }

  personInstalls(appId: number, account: string): number {
    this.serial += 1;
    this.installations.set(this.serial, { appId, account });
    return this.serial;
  }
}

type GitHubAdapters = Adapters<
  typeof githubAppAccess.facts,
  typeof githubAppAccess.operators
>;

function adaptersFor(github: FakeGitHub): GitHubAdapters {
  const authenticates = (credentials: GitHubAppCredentials | undefined) => {
    const app =
      credentials === undefined
        ? undefined
        : github.apps.get(credentials.appId);
    return app !== undefined && app.key === credentials?.privateKey;
  };
  return {
    probes: {
      target: async ({ read }) => {
        const stored = (await read("target")) as
          { login: string; kind: "User" | "Organization" } | undefined;
        return stored === undefined
          ? { held: false }
          : { held: true, value: stored };
      },
      appConfig: async () => ({ held: false }),
      app: async ({ read }) => {
        const stored = (await read("app")) as GitHubAppCredentials | undefined;
        return stored !== undefined && authenticates(stored)
          ? { held: true, value: stored }
          : { held: false };
      },
      installation: async ({ read }) => {
        github.calls.push("GET /app/installations");
        const credentials = (await read("app")) as
          GitHubAppCredentials | undefined;
        const target = (await read("target")) as { login: string } | undefined;
        if (!authenticates(credentials) || target === undefined) {
          return { held: false };
        }
        for (const [installationId, installation] of github.installations) {
          if (
            installation.appId === credentials?.appId &&
            installation.account === target.login
          ) {
            return { held: true, value: { installationId } };
          }
        }
        return { held: false };
      },
      token: async ({ read }) => {
        const stored = (await read("token")) as
          { token: string; expiresAt: string } | undefined;
        return stored !== undefined && github.tokens.has(stored.token)
          ? { held: true, value: stored }
          : { held: false };
      },
    },
    operators: {
      adoptConfiguredApp: async ({ values }) =>
        authenticates(values.appConfig)
          ? { outcome: "adopted", values: { app: values.appConfig } }
          : { outcome: "mismatch" },
      convertManifest: async ({ values }) => {
        github.calls.push("POST /app-manifests/{code}/conversions");
        const appId = github.codes.get(values.manifestCode);
        if (appId === undefined) return { outcome: "codeRejected" };
        github.codes.delete(values.manifestCode);
        const app = github.apps.get(appId)!;
        if (app.owner !== values.target.login) return { outcome: "wrongOwner" };
        return {
          outcome: "converted",
          values: { app: { appId, slug: app.slug, privateKey: app.key } },
        };
      },
      mintToken: async ({ values }) => {
        github.calls.push("POST /app/installations/{id}/access_tokens");
        const installation = github.installations.get(
          values.installation.installationId,
        );
        if (installation === undefined) return { outcome: "installationGone" };
        const token = `ghs_SECRET_${github.tokens.size + 1}`;
        github.tokens.add(token);
        return {
          outcome: "minted",
          values: { token: { token, expiresAt: "2026-11-16T21:00:00Z" } },
        };
      },
    },
  };
}

// The adapter types are the contract: an outcome an operator does not declare
// cannot be returned, and an establishing outcome must carry its values.
const _undeclared: GitHubAdapters["operators"]["mintToken"] = async () =>
  // @ts-expect-error "teleported" is not an outcome mintToken declares
  ({ outcome: "teleported" });
const _valueless: GitHubAdapters["operators"]["mintToken"] = async () =>
  // @ts-expect-error an establishing outcome must carry the token
  ({ outcome: "minted" });
void _undeclared;
void _valueless;

interface Session {
  readonly github: FakeGitHub;
  readonly vaultValues: Map<string, unknown>;
  entries: JournalEntry[];
  step(answer?: HumanAnswer): Promise<RunStatus>;
}

function session(github = new FakeGitHub()): Session {
  const vaultValues = new Map<string, unknown>();
  const self: Session = {
    github,
    vaultValues,
    entries: [],
    step: (answer) =>
      advance(
        githubAppAccess,
        {
          runId: "run",
          adapters: adaptersFor(github),
          journal: memoryJournal(self.entries),
          vault: memoryVault(vaultValues),
        },
        answer,
      ),
  };
  return self;
}

function awaiting(status: RunStatus, operator: string): string {
  assert.equal(status.status, "awaiting");
  assert.ok(status.status === "awaiting");
  assert.equal(status.request.operator, operator);
  return status.request.requestId;
}

async function connectFromNothing(run: Session): Promise<RunStatus> {
  const choose = awaiting(await run.step(), "chooseTarget");
  const register = awaiting(
    await run.step({
      requestId: choose,
      outcome: "chosen",
      values: { target: { login: "octo", kind: "User" } },
    }),
    "registerApp",
  );
  const code = run.github.personCreatesApp("octo");
  const install = awaiting(
    await run.step({
      requestId: register,
      outcome: "created",
      values: { manifestCode: code },
    }),
    "installApp",
  );
  const appId = (run.vaultValues.get("app") as GitHubAppCredentials).appId;
  const installationId = run.github.personInstalls(appId, "octo");
  return run.step({
    requestId: install,
    outcome: "installed",
    values: { installation: { installationId } },
  });
}

test("a first connection asks for exactly three things and no secret reaches the journal or an interface", async () => {
  const run = session();
  const status = await connectFromNothing(run);
  assert.deepEqual(status, { status: "success", leftBehind: [] });
  const written = JSON.stringify(run.entries);
  assert.ok(!written.includes("PRIVATE-KEY"));
  assert.ok(!written.includes("ghs_SECRET"));
  assert.ok(!written.includes("code-"));
  for (const id of ["chooseTarget", "registerApp", "installApp"]) {
    const shows =
      (githubAppAccess.operators as Record<string, OperatorDecl>)[id]?.interface
        ?.shows ?? [];
    assert.ok(!shows.includes("app") && !shows.includes("token"));
  }
});

test("running again with everything in place only looks, and an expired token costs one call", async () => {
  const first = session();
  await connectFromNothing(first);

  first.entries = [];
  first.github.calls = [];
  assert.deepEqual(await first.step(), { status: "success", leftBehind: [] });
  assert.deepEqual(first.github.calls, []);
  assert.ok(
    first.entries.every(
      (entry) => entry.kind !== "begin" || entry.work.kind === "probe",
    ),
  );

  first.entries = [];
  first.github.tokens.clear();
  assert.deepEqual(await first.step(), { status: "success", leftBehind: [] });
  assert.deepEqual(first.github.calls, [
    "GET /app/installations",
    "POST /app/installations/{id}/access_tokens",
  ]);
});

test("an installation the person finished without coming back is found, not asked for again", async () => {
  const run = session();
  const choose = awaiting(await run.step(), "chooseTarget");
  const register = awaiting(
    await run.step({
      requestId: choose,
      outcome: "chosen",
      values: { target: { login: "octo", kind: "User" } },
    }),
    "registerApp",
  );
  const install = awaiting(
    await run.step({
      requestId: register,
      outcome: "created",
      values: { manifestCode: run.github.personCreatesApp("octo") },
    }),
    "installApp",
  );
  const appId = (run.vaultValues.get("app") as GitHubAppCredentials).appId;
  run.github.personInstalls(appId, "octo");
  const status = await run.step({ requestId: install, outcome: "abandoned" });
  assert.deepEqual(status, { status: "success", leftBehind: [] });
});

test("an approval that has to wait ends the run by name, and the next run finishes without asking", async () => {
  const run = session();
  const choose = awaiting(await run.step(), "chooseTarget");
  const register = awaiting(
    await run.step({
      requestId: choose,
      outcome: "chosen",
      values: { target: { login: "octo", kind: "User" } },
    }),
    "registerApp",
  );
  const install = awaiting(
    await run.step({
      requestId: register,
      outcome: "created",
      values: { manifestCode: run.github.personCreatesApp("octo") },
    }),
    "installApp",
  );
  const waiting = await run.step({
    requestId: install,
    outcome: "approvalRequested",
  });
  assert.equal(waiting.status, "failed");
  assert.ok(waiting.status === "failed");
  assert.deepEqual(waiting.failure, {
    kind: "terminal",
    reason: "awaiting-approval",
    operator: "installApp",
    outcome: "approvalRequested",
  });

  const appId = (run.vaultValues.get("app") as GitHubAppCredentials).appId;
  run.github.personInstalls(appId, "octo");
  run.entries = [];
  assert.deepEqual(await run.step(), { status: "success", leftBehind: [] });
});

test("a one-time code spent behind a lost reply sends the person back and says what may be left behind", async () => {
  const run = session();
  const choose = awaiting(await run.step(), "chooseTarget");
  const register = awaiting(
    await run.step({
      requestId: choose,
      outcome: "chosen",
      values: { target: { login: "octo", kind: "User" } },
    }),
    "registerApp",
  );
  const code = run.github.personCreatesApp("octo");
  // GitHub converts the code and the reply never arrives.
  const real = adaptersFor(run.github);
  let dropped = false;
  const lossy: GitHubAdapters = {
    ...real,
    operators: {
      ...real.operators,
      convertManifest: async (context) => {
        const result = await real.operators.convertManifest(context);
        if (!dropped) {
          dropped = true;
          throw new Error("connection reset");
        }
        return result;
      },
    },
  };
  const status = await advance(
    githubAppAccess,
    {
      runId: "run",
      adapters: lossy,
      journal: memoryJournal(run.entries),
      vault: memoryVault(run.vaultValues),
    },
    { requestId: register, outcome: "created", values: { manifestCode: code } },
  );
  awaiting(status, "registerApp");
  const outcomes = run.entries.flatMap((entry) =>
    entry.kind === "end" && entry.result.kind === "act"
      ? [`${entry.result.operator}:${entry.result.outcome}`]
      : [],
  );
  assert.deepEqual(outcomes.slice(-2), [
    "convertManifest:#defect",
    "convertManifest:codeRejected",
  ]);
  const finished = await connectFromNothingAfter(run, status);
  assert.deepEqual(finished, {
    status: "success",
    leftBehind: ["convertManifest"],
  });
});

async function connectFromNothingAfter(
  run: Session,
  status: RunStatus,
): Promise<RunStatus> {
  const register = awaiting(status, "registerApp");
  const install = awaiting(
    await run.step({
      requestId: register,
      outcome: "created",
      values: { manifestCode: run.github.personCreatesApp("octo") },
    }),
    "installApp",
  );
  const appId = (run.vaultValues.get("app") as GitHubAppCredentials).appId;
  return run.step({
    requestId: install,
    outcome: "installed",
    values: {
      installation: {
        installationId: run.github.personInstalls(appId, "octo"),
      },
    },
  });
}
