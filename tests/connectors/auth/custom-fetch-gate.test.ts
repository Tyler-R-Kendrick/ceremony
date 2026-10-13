import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { test } from "node:test";
import {
  bodyReadCounts,
  checkRegistry,
  deriveNetworkExports,
  gateInspected,
  gateProblems,
  type Source,
} from "./fetch-gate.js";
import { accepted, FILE, refused } from "./fetch-gate-fixtures.js";

/*
 * Part A. A call into oauth4webapi or jose that can reach the network is read
 * as a call, by what it is bound to, and the fetch it is given must resolve to
 * the bounded transport (fetch-gate.ts says how). There is no ledger of
 * exceptions: a call that cannot be shown bounded fails.
 *
 * Part B. The response bodies the host reads by hand. An answer that carries,
 * establishes or refreshes a credential or a session (a token, a device or
 * client registration, a key set, a revocation, a handshake that opens a
 * remote session) is read through the bounded transport, so none of those is
 * in the ledger. What is in it is data the host asked a provider or one of its
 * own services for, or a body that arrived from a caller, each with the reason
 * it is not a credential. A new read, or one fewer, fails until the ledger
 * says so, so the count only falls.
 */

const ROOT = join(import.meta.dirname, "..", "..", "..");

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) =>
    entry.isDirectory()
      ? sourceFiles(join(dir, entry.name))
      : /\.tsx?$/.test(entry.name)
        ? [join(dir, entry.name)]
        : [],
  );
}

const sources: Source[] = sourceFiles(join(ROOT, "src")).map((path) => ({
  file: relative(ROOT, path),
  text: readFileSync(path, "utf8"),
}));
const read = (file: string) => sources.find((s) => s.file === file)?.text;
const network = deriveNetworkExports(ROOT);

test("every call into OAuth that can reach the network is given the bounded transport", () => {
  assert.deepEqual(gateProblems(sources, network), []);
});

test("the builders the gate trusts still apply the ceiling", () => {
  assert.deepEqual(checkRegistry(read, network), []);
});

test("the functions that take a fetch are derived from the libraries, and include the ones with no Request in their name", () => {
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
  assert.ok(
    !oauth.includes("processRefreshTokenResponse"),
    "a function that only parses an answer is not",
  );
  assert.deepEqual(Object.keys(network["jose"]!), ["createRemoteJWKSet"]);
});

test("the gate reads the calls and custom fetches it is meant to read", () => {
  const seen = gateInspected(sources, network).map((entry) =>
    entry.replace(/:\d+ /, " "),
  );
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
    "src/server/jira-auth.ts authorizationCodeGrantRequest",
    "src/server/mcp-identity.ts discoveryRequest",
    "src/server/oidc-identity.ts validateApplicationLevelSignature",
  ])
    assert.ok(seen.includes(expected), `${expected} was read`);
});

for (const fixture of refused)
  test(`positive control, refused: ${fixture.name}`, () => {
    const found = gateProblems([{ file: FILE, text: fixture.source }], network);
    assert.ok(found.length > 0, "the gate flags it");
    assert.ok(
      found.some((problem) => fixture.expect.test(problem)),
      `the gate says why (${fixture.expect}): ${found.join(" | ")}`,
    );
  });

for (const fixture of accepted)
  test(`control, accepted: ${fixture.name}`, () => {
    assert.deepEqual(
      gateProblems([{ file: FILE, text: fixture.source }], network),
      [],
    );
  });

test("a builder that stops applying the ceiling is found, and so is one that stops being built on the bounded reader", () => {
  const altered = (file: string, from: string, to: string) => (name: string) =>
    name === file ? read(name)?.replaceAll(from, to) : read(name);
  const responseBound = "src/server/connectors/auth/response-bound.ts";
  const wire = "src/server/connectors/auth/wire.ts";
  const authFetch = "src/server/public-auth-fetch.ts";
  assert.match(
    checkRegistry(
      altered(responseBound, "readBoundedBytes(", "readAll("),
      network,
    ).join("\n"),
    /boundResponse no longer reads through readBoundedBytes/,
  );
  assert.match(
    checkRegistry(altered(wire, "boundResponse(", "((x) => x)("), network).join(
      "\n",
    ),
    /wireFetch no longer returns a fetch that reads under the ceiling/,
  );
  assert.match(
    checkRegistry(
      altered(wire, "wireFetch(options)", "options.fetch"),
      network,
    ).join("\n"),
    /requestOptions no longer returns options with a bounded custom fetch/,
  );
  assert.match(
    checkRegistry(
      altered(authFetch, "boundResponse(", "((x) => x)("),
      network,
    ).join("\n"),
    /boundedAuthFetch no longer returns a fetch that reads under the ceiling/,
  );
});

/*
 * Part B.
 */

type Read = { count: number; why: string };

const BODY_READS: Record<string, Read> = {
  "src/server/connectors/auth/response-bound.ts": {
    count: 1,
    why: "the bounded reader itself: it reads the Response it rebuilt from bytes read under the ceiling",
  },
  "src/server/adapters.ts": {
    count: 6,
    why: "each read is of a response that request() or the OAuth transport already read under the ceiling and rebuilt",
  },
  "src/server/authored-inbox.ts": {
    count: 5,
    why: "mailbox data (the address, the message list and a message) from the inbox provider the author named; the mailbox token's own answer is bounded",
  },
  "src/server/a2h.ts": {
    count: 1,
    why: "the delivery acknowledgement from the operator's HTTPS A2H gateway, a notification service of the deployment's own, not a credential",
  },
  "src/server/hosted/continuations.ts": {
    count: 1,
    why: "the acknowledgement of the host's own continuation endpoint, a one-field object",
  },
  "src/server/browser-verification.ts": {
    count: 1,
    why: "the provider's whoami page read through the browser's own Playwright request context, to compare an account name",
  },
  "src/server/connectors/formats/automation/external-runtime.ts": {
    count: 1,
    why: "an automation runtime's result, data the operator's runtime returned for a run",
  },
  "src/server/connectors/formats/camel-kamelet/runner.ts": {
    count: 1,
    why: "the operator's Camel runner's result, data for a run",
  },
  "src/server/connectors/import/network.ts": {
    count: 2,
    why: "an import's own fetch, read after the import service's byte limit has been applied to the stream",
  },
  "src/server/connectors/import/service.ts": {
    count: 1,
    why: "an import's document, read after the import service's byte limit has been applied",
  },
  "src/server/connectors/providers/dapr/invoke.ts": {
    count: 1,
    why: "a Dapr sidecar's answer to an invocation, data; the sidecar is the operator's own and local",
  },
  "src/server/connectors/providers/open-service-broker/client.ts": {
    count: 1,
    why: "an Open Service Broker answer, data the operator's broker returned",
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
};

test("positive control: a new hand-made body read is found, and so is a ledger entry that is stale", () => {
  const added = bodyReadCounts([
    ...sources,
    {
      file: "src/server/new.ts",
      text: "export const x = async (r) => (await r.json());",
    },
  ]);
  assert.equal(added["src/server/new.ts"], 1);
  assert.equal(
    bodyReadCounts([{ file: "src/server/z.ts", text: "const s = z.json();" }])[
      "src/server/z.ts"
    ],
    undefined,
    "a zod schema is not a body",
  );
});

test("the response bodies read by hand are the ones the ledger names, no more and no fewer", () => {
  const counts = bodyReadCounts(sources);
  const unlisted = Object.keys(counts).filter((file) => !(file in BODY_READS));
  assert.deepEqual(
    unlisted,
    [],
    "read a credential or session answer through boundResponse or boundedResponseJson; add a ledger entry only for data, with the reason",
  );
  for (const [file, entry] of Object.entries(BODY_READS))
    assert.equal(
      counts[file] ?? 0,
      entry.count,
      `${file} reads ${counts[file] ?? 0} bodies by hand and the ledger says ${entry.count}; the ledger only falls`,
    );
});
