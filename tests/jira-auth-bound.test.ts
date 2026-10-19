import assert from "node:assert/strict";
import { test } from "node:test";
import {
  jiraAuth,
  JiraAuthFailure,
  type JiraOAuthConfiguration,
} from "../src/server/jira-auth.js";
import {
  assertReadUnder,
  endlessFetch,
  type Pulled,
} from "./connectors/doubles/endless-body.js";

/*
 * Jira's token answer is read under a 64 KiB ceiling of its own. An answer
 * that never ends is cut off there, and reads as the provider being
 * unavailable, as a lost answer does (the one-use code is not presented again).
 */

const configuration: JiraOAuthConfiguration = {
  clientId: "fixture-client",
  clientSecret: "fixture-client-secret",
  callbackUrl: "https://app.example/jira/callback",
  siteUrl: "https://fixture.atlassian.net",
  scopes: ["read:jira-user"],
};
const state = "synthetic-state-bound-to-private-run-12345";

test("a Jira token answer that never ends is cut off at its ceiling and reads as an unavailable provider", async () => {
  const seen: Pulled = { pulled: 0 };
  const client = jiraAuth(configuration, {
    signal: new AbortController().signal,
    fetch: endlessFetch(seen, ["src/server/jira-auth.ts#exchange"]),
  });
  await assert.rejects(
    client.exchange(
      `${configuration.callbackUrl}?state=${state}&code=one-use-code`,
      state,
    ),
    (error: unknown) =>
      error instanceof JiraAuthFailure && error.code === "provider-unavailable",
  );
  assertReadUnder(assert, seen, 65_536, "a Jira token answer");
});
