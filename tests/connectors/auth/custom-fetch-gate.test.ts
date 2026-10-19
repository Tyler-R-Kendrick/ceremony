import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import {
  bodyReadCounts,
  checkRegistry,
  deriveNetworkExports,
  gateProgram,
  runGate,
  trackedSources,
} from "./fetch-gate.js";
import {
  battery,
  batteryAccepted,
  batteryReads,
} from "./fetch-gate-battery.js";
import {
  accepted,
  extraReads,
  fixturePath,
  modules,
  refused,
} from "./fetch-gate-fixtures.js";
import * as forwards from "./fetch-gate-forward-fixtures.js";
import { pairingProblems } from "./fetch-gate-pairing.js";
import * as pairing from "./fetch-gate-pairing-fixtures.js";
import { ACCEPTED, BODY_READS } from "./fetch-gate-ledgers.js";

/*
 * Part A. Every tracked source (outside dependencies, build output and these
 * fixtures) is read through one TypeScript program. A call into oauth4webapi
 * or jose that can reach the network must be given the bounded transport, and
 * every ceiling handed to that transport must be a constant within its bound
 * (fetch-gate.ts says how). What the gate reports and accepts is in ACCEPTED
 * (fetch-gate-ledgers.ts), file by file, each with its reason: module
 * loaders whose target it cannot see (two in operator scripts, the rest in
 * tests), and the transport's own test. Nothing under src, examples,
 * extensions or hosted.
 *
 * Part B. The response bodies production code reads by hand, in every shape a
 * read can take. An answer that carries, establishes or refreshes a
 * credential or a session is read through the bounded transport, so none of
 * those is in the ledger; what is in it is data, with the reason. A new read,
 * or one fewer, fails until the ledger says so, so the count only falls.
 */

const ROOT = join(import.meta.dirname, "..", "..", "..");
const files = trackedSources(ROOT);
const virtual: Record<string, string> = {
  ...modules,
  ...forwards.forwardModules,
  ...pairing.pairingModules,
};
const pairingAt = [...pairing.pairingRefused, ...pairing.pairingAccepted].map(
  (fixture, n) => {
    virtual[pairing.pairingPath(n)] = fixture.source;
    return pairing.pairingPath(n);
  },
);
// A forwarding helper's fixtures run with its file and the modules they import.
const forwardAt = [...forwards.forwardRefused, ...forwards.forwardAccepted].map(
  (fixture, n) => {
    virtual[forwards.forwardPath(n)] = fixture.source;
    return forwards.forwardPath(n);
  },
);
const refusedAt = refused.map((fixture, n) => {
  virtual[fixturePath(n)] = fixture.source;
  return fixturePath(n);
});
const acceptedAt = accepted.map((fixture, n) => {
  virtual[fixturePath(100 + n)] = fixture.source;
  return fixturePath(100 + n);
});
const batteryAt = battery.map(([, source], n) => {
  virtual[fixturePath(200 + n)] = source;
  return fixturePath(200 + n);
});
const allReads = [...batteryReads, ...extraReads];
const readsAt = allReads.map(([, source], n) => {
  const path = `src/server/gate-reads-${n}.ts`;
  virtual[path] = source;
  return path;
});
const gate = gateProgram(ROOT, files, virtual);
const network = deriveNetworkExports(ROOT);
const real = runGate(gate, files, network);
const problemsOf = (file: string, context: string[] = []) =>
  runGate(gate, [file, ...context], network).problems;

test("every call into OAuth reaches the network through the bounded transport, and every ceiling holds", () => {
  const byFile = new Map<string, string[]>();
  for (const problem of real.problems) {
    const file = problem.slice(0, problem.indexOf(":"));
    byFile.set(file, [...(byFile.get(file) ?? []), problem]);
  }
  const unaccepted = [...byFile].flatMap(([file, found]) =>
    file in ACCEPTED ? [] : found,
  );
  assert.deepEqual(unaccepted, []);
  for (const [file, entry] of Object.entries(ACCEPTED))
    assert.equal(
      byFile.get(file)?.length ?? 0,
      entry.count,
      `${file}: ${byFile.get(file)?.join(" | ") ?? "nothing"}; the ledger says ${entry.count}`,
    );
});

test("every bounded site is served an endless body by a test that names it", () => {
  assert.deepEqual(pairingProblems(gate, files, real.accepted), []);
});

/** The pairing of one test file against the fixtures' one bounded site. */
const pairingOf = (file: string) =>
  pairingProblems(
    gate,
    [file],
    runGate(gate, [pairing.pairingSite], network).accepted,
  );

pairing.pairingRefused.forEach((fixture, n) =>
  test(`refused: ${fixture.name}`, () => {
    const found = pairingOf(pairingAt[n]!);
    assert.ok(
      found.some((problem) => fixture.expect.test(problem)),
      `the gate says why (${fixture.expect}): ${found.join(" | ") || "nothing"}`,
    );
  }),
);

pairing.pairingAccepted.forEach((fixture, n) =>
  test(`accepted: ${fixture.name}`, () => {
    assert.deepEqual(
      pairingOf(pairingAt[pairing.pairingRefused.length + n]!),
      [],
    );
  }),
);

test("the transport the gate trusts still does what it is trusted for", () => {
  assert.deepEqual(checkRegistry(gate), []);
});

test("a transport that stops doing what it is trusted for is found", () => {
  const registryFiles = [
    "src/core/bounded-body.ts",
    "src/server/connectors/auth/response-bound.ts",
    "src/server/connectors/auth/wire.ts",
    "src/server/public-auth-fetch.ts",
  ];
  const read = (file: string) => readFileSync(join(ROOT, file), "utf8");
  const altered = (changes: Record<string, [string, string]>) =>
    checkRegistry(
      gateProgram(
        ROOT,
        registryFiles,
        Object.fromEntries(
          Object.entries(changes).map(([file, [from, to]]) => {
            const text = read(file);
            assert.ok(text.includes(from), `${file} still contains ${from}`);
            return [file, text.replaceAll(from, to)];
          }),
        ),
      ),
    ).join("\n");
  const first = altered({
    "src/core/bounded-body.ts": [
      "if (received > limitBytes)",
      "if (received < 0)",
    ],
    "src/server/connectors/auth/response-bound.ts": [
      "readBoundedBytes(",
      "readAll(",
    ],
    "src/server/public-auth-fetch.ts": [
      "boundResponse(",
      "((x: Response) => x)(",
    ],
    "src/server/connectors/auth/wire.ts": [
      "[oauth.customFetch]: wireFetch(options)",
      "[oauth.customFetch]: options.fetch",
    ],
  });
  for (const name of [
    "readBoundedBytes",
    "boundResponse",
    "boundedAuthFetch",
    "requestOptions",
  ])
    assert.match(
      first,
      new RegExp(`${name} no longer does what the registry trusts it for`),
    );
  assert.match(
    altered({
      "src/server/connectors/auth/wire.ts": [
        "boundResponse(",
        "((x: Response) => x)(",
      ],
    }),
    /wireFetch no longer does what the registry trusts it for/,
  );
});

test("the functions that take a fetch are derived from the libraries, including the ones with no Request in their name", () => {
  const oauth = Object.keys(network["oauth4webapi"]!);
  for (const name of [
    "authorizationCodeGrantRequest",
    "refreshTokenGrantRequest",
    "deviceAuthorizationRequest",
    "dynamicClientRegistrationRequest",
    "discoveryRequest",
    "validateApplicationLevelSignature",
    "validateJwtAccessToken",
  ])
    assert.ok(oauth.includes(name), `${name} is derived as network-capable`);
  assert.ok(!oauth.includes("processRefreshTokenResponse"));
  assert.deepEqual(Object.keys(network["jose"]!), ["createRemoteJWKSet"]);
});

test("the gate reads the calls and custom fetches it is meant to read", () => {
  const seen = real.inspected.map((entry) => entry.replace(/:\d+ /, " "));
  for (const expected of [
    "src/server/authored-oauth.ts customFetch",
    "src/server/authored-oauth.ts authorizationCodeGrantRequest",
    "src/server/adapters.ts authorizationCodeGrantRequest",
    "src/server/adapters.ts deviceCodeGrantRequest",
    "src/server/connectors/auth/authorization-code.ts refreshTokenGrantRequest",
    "src/server/connectors/auth/client-credentials.ts customFetch",
    "src/server/connectors/auth/token-exchange.ts customFetch",
    "src/server/connectors/auth/token-exchange.ts createRemoteJWKSet",
    "src/server/connectors/providers/supabase/management.ts customFetch",
    "src/server/jira-auth.ts customFetch",
    "src/server/mcp-identity.ts discoveryRequest",
    "src/server/oidc-identity.ts validateApplicationLevelSignature",
  ])
    assert.ok(seen.includes(expected), `${expected} was read`);
  assert.ok(
    files.some((file) => file.startsWith("hosted/routes/")) &&
      files.some((file) => file.endsWith(".mjs")),
    "the deployed routes and the JavaScript sources are read too",
  );
});

refused.forEach((fixture, n) =>
  test(`refused: ${fixture.name}`, () => {
    const found = problemsOf(refusedAt[n]!);
    assert.ok(
      found.some((problem) => fixture.expect.test(problem)),
      `the gate says why (${fixture.expect}): ${found.join(" | ") || "nothing"}`,
    );
  }),
);

accepted.forEach((fixture, n) =>
  test(`accepted: ${fixture.name}`, () => {
    assert.deepEqual(problemsOf(acceptedAt[n]!), []);
  }),
);

forwards.forwardRefused.forEach((fixture, n) =>
  test(`refused: ${fixture.name}`, () => {
    const found = problemsOf(forwardAt[n]!, forwards.forwardContext);
    assert.ok(
      found.some((problem) => fixture.expect.test(problem)),
      `the gate says why (${fixture.expect}): ${found.join(" | ") || "nothing"}`,
    );
  }),
);

forwards.forwardAccepted.forEach((fixture, n) =>
  test(`accepted: ${fixture.name}`, () => {
    const at = forwardAt[forwards.forwardRefused.length + n]!;
    assert.deepEqual(problemsOf(at, forwards.forwardContext), []);
  }),
);

test("the review's battery: eighteen sources refused (the nine the text gate passed among them), two accepted", () => {
  const outcome = battery.map(([name], n) => ({
    name,
    refused: problemsOf(batteryAt[n]!).length > 0,
  }));
  assert.deepEqual(
    outcome.filter((item) => item.refused === batteryAccepted.has(item.name)),
    [],
  );
});

test("every shape of hand read is counted", () => {
  const counts = bodyReadCounts(gate, readsAt);
  allReads.forEach(([name], n) =>
    assert.ok((counts[readsAt[n]!] ?? 0) > 0, `${name} is counted`),
  );
});

test("the response bodies production code reads by hand are the ones the ledger names", () => {
  const counts = bodyReadCounts(
    gate,
    files.filter((file) => !file.startsWith("tests/")),
  );
  assert.deepEqual(
    counts,
    Object.fromEntries(
      Object.entries(BODY_READS).map(([file, entry]) => [file, entry.count]),
    ),
  );
});
