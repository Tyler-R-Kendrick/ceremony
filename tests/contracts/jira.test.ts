import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PactV3, SpecificationVersion } from "@pact-foundation/pact";
import { jiraAuth, JiraAuthFailure } from "../../src/server/jira-auth.js";

for (const status of [200, 401])
  test(`Pact: Jira 3LO JSON exchange and site-bound user verification ${status}`, async (t) => {
    const dir = mkdtempSync(join(tmpdir(), "ceremony-jira-pact-"));
    t.after(() => rmSync(dir, { recursive: true }));
    const pact = new PactV3({
      consumer: "ceremony-jira",
      provider: "atlassian-3lo",
      dir,
      logLevel: "error",
      spec: SpecificationVersion.SPECIFICATION_VERSION_V4,
    });
    const config = {
      clientId: "fixture-client",
      clientSecret: "fixture-secret",
      callbackUrl: "https://app.example/jira/callback",
      siteUrl: "https://fixture.atlassian.net",
      scopes: ["read:jira-user" as const],
    };
    const cloudId = "8594f221-9797-5f78-1fa4-485e198d7cd0";
    pact
      .given(
        "the authorization code belongs to the configured shared integration",
      )
      .uponReceiving("confidential 3LO authorization code exchange as JSON")
      .withRequest({
        method: "POST",
        path: "/oauth/token",
        headers: { "content-type": "application/json" },
        body: {
          grant_type: "authorization_code",
          code: "fixture-code",
          client_id: config.clientId,
          client_secret: config.clientSecret,
          redirect_uri: config.callbackUrl,
        },
      })
      .willRespondWith({
        status: 200,
        headers: { "content-type": "application/json" },
        body: {
          access_token: "fixture-access",
          token_type: "Bearer",
          expires_in: 3600,
          scope: "read:jira-user",
        },
      });
    pact
      .given(
        "the grant includes the intended Jira site and identity-read scope",
      )
      .uponReceiving("fresh accessible site verification")
      .withRequest({
        method: "GET",
        path: "/oauth/token/accessible-resources",
        headers: { authorization: "Bearer fixture-access" },
      })
      .willRespondWith({
        status: 200,
        headers: { "content-type": "application/json" },
        body: [
          { id: cloudId, url: config.siteUrl, scopes: ["read:jira-user"] },
        ],
      });
    pact
      .given(
        status === 200
          ? "the grant identifies an active Jira user"
          : "Jira access has been revoked",
      )
      .uponReceiving("read current user only through the verified cloud ID")
      .withRequest({
        method: "GET",
        path: `/ex/jira/${cloudId}/rest/api/3/myself`,
        headers: { authorization: "Bearer fixture-access" },
      })
      .willRespondWith({
        status,
        headers: { "content-type": "application/json" },
        body:
          status === 200
            ? {
                accountId: "fixture-user",
                active: true,
                accountType: "atlassian",
              }
            : { message: "synthetic-private-detail" },
      });
    const network = globalThis.fetch;
    t.mock.method(
      globalThis,
      "fetch",
      (input: string | URL | Request, init?: RequestInit) => {
        assert.equal(new URL(String(input)).hostname, "127.0.0.1");
        return network(input, init);
      },
    );
    await pact.executeTest(async ({ url }) => {
      const client = jiraAuth(config, {
        signal: AbortSignal.timeout(15000),
        fetch: (input, init) => {
          const source = new URL(String(input));
          assert.ok(
            [
              "https://auth.atlassian.com",
              "https://api.atlassian.com",
            ].includes(source.origin),
          );
          return fetch(`${url}${source.pathname}`, init);
        },
      });
      const state = "synthetic-state-bound-to-the-run-12345";
      const session = await client.exchange(
        `${config.callbackUrl}?state=${state}&code=fixture-code`,
        state,
      );
      if (status === 200) {
        const result = await client.verify(session, "fixture-user");
        assert.equal(result.cloudId, cloudId);
        assert.equal(result.accountId, "fixture-user");
      } else
        await assert.rejects(
          client.verify(session),
          (error: unknown) =>
            error instanceof JiraAuthFailure &&
            error.code === "verification-rejected",
        );
    });
  });

test("Pact: Jira rejects an incompatible client identifier in the real consumer request", async (t) => {
  const network = globalThis.fetch;
  t.mock.method(
    globalThis,
    "fetch",
    (input: string | URL | Request, init?: RequestInit) => {
      assert.equal(new URL(String(input)).hostname, "127.0.0.1");
      return network(input, init);
    },
  );
  const dir = mkdtempSync(join(tmpdir(), "ceremony-jira-mismatch-"));
  t.after(() => rmSync(dir, { recursive: true }));
  const pact = new PactV3({
    consumer: "ceremony-jira",
    provider: "atlassian-3lo",
    dir,
    logLevel: "error",
    spec: SpecificationVersion.SPECIFICATION_VERSION_V4,
  });
  pact
    .given(
      "the authorization code belongs to the configured shared integration",
    )
    .uponReceiving("exchange is bound to the expected integration")
    .withRequest({
      method: "POST",
      path: "/oauth/token",
      body: { client_id: "expected-client" },
    })
    .willRespondWith({
      status: 400,
      headers: { "content-type": "application/json" },
      body: { error: "invalid_client" },
    });
  await assert.rejects(
    pact.executeTest(async ({ url }) => {
      const client = jiraAuth(
        {
          clientId: "different-client",
          clientSecret: "fixture-secret",
          callbackUrl: "https://app.example/callback",
          siteUrl: "https://fixture.atlassian.net",
          scopes: ["read:jira-user"],
        },
        {
          signal: AbortSignal.timeout(15000),
          fetch: (input, init) => {
            assert.equal(
              new URL(String(input)).origin,
              "https://auth.atlassian.com",
            );
            return fetch(`${url}/oauth/token`, init);
          },
        },
      );
      const state = "synthetic-state-bound-to-the-run-12345";
      await assert.rejects(
        client.exchange(
          `https://app.example/callback?state=${state}&code=fixture-code`,
          state,
        ),
      );
    }),
  );
});
