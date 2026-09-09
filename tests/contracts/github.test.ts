import assert from "node:assert/strict";
import { generateKeyPairSync, randomBytes } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { Pact, Matchers } from "@pact-foundation/pact";
import {
  CeremonyDatabase,
  GitHubAppCeremonies,
  githubAppManifest,
} from "../../src/server/index.js";

// Entirely synthetic: never read environment credentials or the user's vault.
const app = {
  id: 42,
  slug: "ceremony-contract-test",
  owner: { login: "alice" },
  pem: generateKeyPairSync("rsa", { modulusLength: 2048 })
    .privateKey.export({ type: "pkcs1", format: "pem" })
    .toString(),
};
const identity = {
  id: app.id,
  slug: app.slug,
  owner: app.owner,
  permissions: { contents: "read" },
};
const headers = {
  accept: "application/vnd.github+json",
  "x-github-api-version": "2022-11-28",
  "user-agent": "ceremony-auth",
};
const signedHeaders = {
  ...headers,
  authorization: Matchers.regex(
    "^Bearer [A-Za-z0-9_-]+\\.[A-Za-z0-9_-]+\\.[A-Za-z0-9_-]+$",
    "Bearer e30.e30.c2ln",
  ),
};

function fixture(t: TestContext) {
  const dir = mkdtempSync(join(tmpdir(), "ceremony-pact-"));
  const db = new CeremonyDatabase(":memory:", randomBytes(32));
  t.after(() => {
    db.close();
    rmSync(dir, { recursive: true });
  });
  const pact = new Pact({
    consumer: "ceremony-github-app",
    provider: "github-rest",
    dir,
    logLevel: "error",
  });
  return { pact, db };
}

function consumer(
  db: CeremonyDatabase,
  baseUrl: string,
  configured = true,
  mutatePermission = false,
) {
  const github = new GitHubAppCeremonies(db, {
    origin: "http://127.0.0.1:4173",
    ...(configured ? { app, expectedAccount: "alice" } : {}),
    fetch: (input, init) => {
      const url = new URL(String(input));
      assert.equal(url.origin, "https://api.github.com");
      // Only reroute transport. Production code constructs and parses all messages.
      return fetch(`${baseUrl}${url.pathname}${url.search}`, {
        ...init,
        ...(mutatePermission && url.pathname.endsWith("/access_tokens")
          ? { body: JSON.stringify({ permissions: { contents: "write" } }) }
          : {}),
      });
    },
  });
  const adapter = github.createAdapter({
    owner: "alice",
    instanceId: "contract-run",
    method: githubAppManifest.methods[0]!,
  });
  const callback = (query: string) => {
    const state = new URL(
      github.destination("alice", "contract-run").url,
    ).searchParams.get("state")!;
    return adapter.callback(
      new URL(
        `http://127.0.0.1:4173/api/live/github/contract-run/callback?state=${state}&${query}`,
      ),
    );
  };
  return { adapter, callback, github };
}

function appIdentity(pact: Pact) {
  return pact
    .addInteraction()
    .given("app 42 belongs to alice and has contents access")
    .uponReceiving("verify the signed app identity")
    .withRequest("GET", "/app", (request) => request.headers(signedHeaders))
    .willRespondWith(200, (response) => response.jsonBody(identity));
}

test("Pact: manifest conversion prepares the app before installation", async (t) => {
  const { pact, db } = fixture(t);
  pact
    .addInteraction()
    .given("an unused manifest conversion code exists")
    .uponReceiving("exchange the one-shot manifest code")
    .withRequest(
      "POST",
      "/app-manifests/synthetic-code/conversions",
      (request) => request.headers(headers).jsonBody({}),
    )
    .willRespondWith(201, (response) =>
      response.jsonBody({ ...app, pem: Matchers.like(app.pem) }),
    );
  await appIdentity(pact).executeTest(async ({ url }) => {
    const { callback, github } = consumer(db, url, false);
    const result = await callback("code=synthetic-code");
    assert.equal(result.step, "redirect");
    assert.equal(result.prerequisites?.[0]?.status, "succeeded");
    assert.equal(result.outcome, undefined);
    assert.equal(
      github.destination("alice", "contract-run").kind,
      "installation",
    );
    assert.ok(!JSON.stringify(result).includes("PRIVATE KEY"));
  });
});

for (const mutate of [false, true]) {
  test(`Pact: installation ${mutate ? "rejects a write-permission mutation" : "issues a private read-only connection"}`, async (t) => {
    const { pact, db } = fixture(t);
    appIdentity(pact);
    pact
      .addInteraction()
      .given("installation 7 belongs to app 42 and alice")
      .uponReceiving("verify the approved installation")
      .withRequest("GET", "/app/installations/7", (request) =>
        request.headers(signedHeaders),
      )
      .willRespondWith(200, (response) =>
        response.jsonBody({
          id: 7,
          app_id: 42,
          account: { login: "alice" },
          suspended_at: null,
        }),
      );
    const issuance = pact
      .addInteraction()
      .given("installation 7 permits read-only contents tokens")
      .uponReceiving("issue a least-privilege installation token")
      .withRequest("POST", "/app/installations/7/access_tokens", (request) =>
        request
          .headers(signedHeaders)
          .jsonBody({ permissions: { contents: "read" } }),
      )
      .willRespondWith(201, (response) =>
        response.jsonBody({
          token: "synthetic-installation-token",
          expires_at: Matchers.regex(
            "^\\d{4}-\\d{2}-\\d{2}T.*Z$",
            new Date(Date.now() + 3_600_000).toISOString(),
          ),
          permissions: { contents: "read" },
        }),
      );
    const interaction = mutate
      ? issuance
      : pact
          .addInteraction()
          .given("the installation token can list repositories")
          .uponReceiving("verify repository access with the installation token")
          .withRequest("GET", "/installation/repositories", (request) =>
            request
              .headers({
                ...headers,
                authorization: "Bearer synthetic-installation-token",
              })
              .query({ per_page: "1" }),
          )
          .willRespondWith(200, (response) =>
            response.jsonBody({
              total_count: Matchers.integer(1),
              repositories: Matchers.eachLike({ id: Matchers.integer(8) }),
            }),
          );
    const run = () =>
      interaction.executeTest(async ({ url }) => {
        const result = await consumer(db, url, true, mutate).callback(
          "installation_id=7",
        );
        if (mutate) {
          assert.equal(result.outcome, undefined);
          assert.equal(db.keys("connection:").length, 0);
        } else {
          assert.equal(result.step, "complete");
          assert.ok(result.outcome?.connectionRef);
          assert.deepEqual(result.outcome.scopes, ["contents:read"]);
          assert.equal(db.keys("connection:").length, 1);
          assert.ok(
            !JSON.stringify(result).includes("synthetic-installation-token"),
          );
        }
      });
    if (mutate)
      await assert.rejects(run, (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.match(error.message, /Test failed for the following reasons/);
        assert.match(error.message, /contents/);
        assert.match(error.message, /read/);
        assert.match(error.message, /write/);
        return true;
      });
    else await run();
  });
}

test("Pact: rejected app credentials never produce a connection", async (t) => {
  const { pact, db } = fixture(t);
  await pact
    .addInteraction()
    .given("the app signing credential is rejected")
    .uponReceiving("verify an app with a rejected credential")
    .withRequest("GET", "/app", (request) => request.headers(signedHeaders))
    .willRespondWith(401, (response) =>
      response.jsonBody({ message: "Bad credentials" }),
    )
    .executeTest(async ({ url }) => {
      await assert.rejects(
        consumer(db, url).adapter.begin(),
        /could not verify/,
      );
      assert.equal(db.keys("connection:").length, 0);
    });
});
