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

/*
 * Part A. Every tracked source (outside dependencies, build output and these
 * fixtures) is read through one TypeScript program. A call into oauth4webapi
 * or jose that can reach the network must be given the bounded transport, and
 * every ceiling handed to that transport must be a constant within its bound
 * (fetch-gate.ts says how). What the gate reports and accepts is in ACCEPTED
 * below, file by file, each with its reason: module loaders whose target it
 * cannot see (two in operator scripts, the rest in tests), and the
 * transport's own test. Nothing under src, examples, extensions or hosted.
 *
 * Part B. The response bodies production code reads by hand, in every shape a
 * read can take. An answer that carries, establishes or refreshes a
 * credential or a session is read through the bounded transport, so none of
 * those is in the ledger; what is in it is data, with the reason. A new read,
 * or one fewer, fails until the ledger says so, so the count only falls.
 */

const ROOT = join(import.meta.dirname, "..", "..", "..");
const files = trackedSources(ROOT);
const virtual: Record<string, string> = { ...modules };
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
const problemsOf = (file: string) => runGate(gate, [file], network).problems;

type Accepted = { count: number; why: string };
const LOADS_IN_PAGE =
  "an import run inside the browser page under test, of the bundle that page serves";
const ACCEPTED: Record<string, Accepted> = {
  "scripts/certify-attended.ts": {
    count: 1,
    why: "loads the certification plan of the flow file the operator names on the command line",
  },
  "scripts/connector-support-matrix.ts": {
    count: 1,
    why: "loads each adapter module the repository's own list names, to read its declarations",
  },
  "tests/browser/ceremony.spec.ts": { count: 1, why: LOADS_IN_PAGE },
  "tests/browser/webmcp.spec.ts": { count: 2, why: LOADS_IN_PAGE },
  "tests/connectors/auth/response-bound.test.ts": {
    count: 9,
    why: "the transport's own test: each OAuth request is made with the options under test, passed in",
  },
  "tests/extension-inference-output.test.ts": {
    count: 1,
    why: "a require for the extension bundle under test, which esbuild leaves external",
  },
  "tests/extension-ui-lifecycle.test.ts": {
    count: 1,
    why: "a require handed to the extension bundle under test inside a sandbox",
  },
  "tests/fixtures/workflow-restart-worker.mjs": {
    count: 1,
    why: "loads the workflow bundle the parent test built, by the directory it names",
  },
  "tests/openapi-client.test.ts": {
    count: 1,
    why: "loads the client the test generated, by a path built at run time so tsc does not follow it",
  },
};

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

const EXAMPLE_PAGE = "the example page reading the example server's own API";
const BODY_READS: Record<string, Accepted> = {
  "examples/agent-routes.ts": {
    count: 1,
    why: "the example server reading a request body from its caller",
  },
  "examples/http.ts": {
    count: 1,
    why: "the example server reading a request body from its caller",
  },
  "examples/issuer.ts": {
    count: 2,
    why: "the example issuer reading its callers' requests (a JSON and a form body)",
  },
  "examples/server.ts": {
    count: 4,
    why: "the example server relaying its own API's answers (two bodies, one stream) to the page it serves, and reading one of them",
  },
  "examples/showcase/main.tsx": { count: 1, why: EXAMPLE_PAGE },
  "examples/web/agent-card.tsx": { count: 2, why: EXAMPLE_PAGE },
  "examples/web/connection-plan.ts": { count: 3, why: EXAMPLE_PAGE },
  "examples/web/environment.tsx": { count: 3, why: EXAMPLE_PAGE },
  "examples/web/extension-setup.tsx": { count: 1, why: EXAMPLE_PAGE },
  "examples/web/main.tsx": { count: 2, why: EXAMPLE_PAGE },
  "examples/web/presentation-studio.tsx": { count: 2, why: EXAMPLE_PAGE },
  "examples/web/workflow-studio.tsx": {
    count: 4,
    why: "the example page reading the example server's own API, one of them its event stream",
  },
  "extensions/browser-login/worker.ts": {
    count: 1,
    why: "the extension reading the configuration its local bridge serves",
  },
  "scripts/demos/device.ts": {
    count: 1,
    why: "the demo reading the signed-in subject from the local server it started",
  },
  "scripts/prove-e2e.ts": {
    count: 8,
    why: "the end-to-end proof reading the pages and API of the local server it started",
  },
  "scripts/verify-attended.ts": {
    count: 1,
    why: "the attended check reading a run's status from the deployment under test",
  },
  "src/core/client.ts": {
    count: 2,
    why: "the app's own API answering its own client, in the browser",
  },
  "src/core/connectors/client.ts": {
    count: 2,
    why: "the app's own connector API answering its own client, in the browser",
  },
  "src/mcp-app/index.ts": {
    count: 1,
    why: "the app's own API answering the MCP app's client",
  },
  "src/react/connector-connection.tsx": {
    count: 1,
    why: "the app's own API answering the page that calls it",
  },
  "src/react/teaching.tsx": {
    count: 3,
    why: "the app's own API answering the page that calls it",
  },
  "src/server/a2h.ts": {
    count: 1,
    why: "the delivery acknowledgement from the operator's HTTPS A2H gateway, a notification service of the deployment's own, not a credential",
  },
  "src/server/adapters.ts": {
    count: 6,
    why: "each read is of a response that request() or the OAuth transport already read under the ceiling and rebuilt",
  },
  "src/server/authored-inbox.ts": {
    count: 5,
    why: "messages from the inbox the operator supplied: the address, the list and each message, which carry the verification codes and links the sign-in reads; the mailbox token's own answer is bounded",
  },
  "src/server/browser-verification.ts": {
    count: 1,
    why: "the provider's whoami page read through the browser's own Playwright request context, to compare an account name",
  },
  "src/server/connectors/auth/response-bound.ts": {
    count: 1,
    why: "the bounded reader itself: it reads the Response it rebuilt from bytes read under the ceiling",
  },
  "src/server/connectors/import/network.ts": {
    count: 2,
    why: "an import's own fetch, read after the import service's byte limit has been applied to the stream",
  },
  "src/server/connectors/import/service.ts": {
    count: 1,
    why: "an import's document, read after the import service's byte limit has been applied",
  },
  "src/server/connectors/mcp/http.ts": {
    count: 1,
    why: "an MCP server's event stream, read frame by frame and bounded by frame size and frame count rather than a running total",
  },
  "src/server/hosted/continuations.ts": {
    count: 1,
    why: "the acknowledgement of the host's own continuation endpoint, a one-field object",
  },
};

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
