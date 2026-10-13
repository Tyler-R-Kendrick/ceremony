import assert from "node:assert/strict";
import { test } from "node:test";
import { registerDynamicClient } from "../src/server/authored-app.js";
import { startDeviceAuthorization } from "../src/server/authored-human.js";
import { createMailTmInbox } from "../src/server/authored-inbox.js";
import {
  beginAuthorization,
  dpopUserinfoRequest,
  exchangeAuthorizationCode,
  exportDpopJwk,
} from "../src/server/authored-oauth.js";
import {
  pollDeviceToken,
  tokenRequest,
} from "../src/server/authored-operations.js";
import { MAX_RESPONSE_BYTES } from "../src/server/connectors/auth/response-bound.js";

/*
 * The authored sign-in (an author's own provider) reads its OAuth answers
 * through oauth4webapi with a transport of its own, so the ceiling on an OAuth
 * answer is applied there as well: a pushed-authorization answer, a token
 * answer and a DPoP-protected userinfo answer that never end are refused when
 * they cross it.
 */

const provider = "https://provider.example";
const origin = "https://ceremony.example";
const CHUNK = 64 * 1024;
const ENDLESS = 64 * 1024 * 1024;
const SLACK = 2 * CHUNK;
const discovery = {
  origin: provider,
  authorizationEndpoint: `${provider}/authorize`,
  tokenEndpoint: `${provider}/token`,
  pushedAuthorizationRequestEndpoint: `${provider}/par`,
  requirePushedAuthorizationRequests: true,
};

/** A fetch whose every answer is `ENDLESS` bytes of whitespace; `pulled` is what was read of it. */
function endlessFetch(status = 200) {
  const seen = { pulled: 0 };
  const chunk = new Uint8Array(CHUNK).fill(0x20);
  const fetcher: typeof fetch = async () =>
    new Response(
      new ReadableStream<Uint8Array>({
        pull(controller) {
          if (seen.pulled >= ENDLESS) return controller.close();
          seen.pulled += CHUNK;
          controller.enqueue(chunk);
        },
      }),
      { status, headers: { "content-type": "application/json" } },
    );
  return { seen, fetcher };
}

const within = (pulled: number) => {
  assert.ok(pulled > 0, "the endless answer was in fact served");
  assert.ok(
    pulled <= MAX_RESPONSE_BYTES + SLACK,
    `read ${pulled} bytes of an OAuth answer; the ceiling is ${MAX_RESPONSE_BYTES}`,
  );
};

test("a pushed authorization answer that never ends is cut off at the ceiling", async () => {
  const { seen, fetcher } = endlessFetch(201);
  await assert.rejects(
    beginAuthorization({
      discovery,
      clientId: "client",
      redirectUri: `${origin}/return`,
      scope: "openid",
      fetch: fetcher,
    }),
  );
  within(seen.pulled);
});

test("a token answer that never ends is cut off at the ceiling", async () => {
  const { seen, fetcher } = endlessFetch();
  await assert.rejects(
    exchangeAuthorizationCode({
      discovery,
      clientId: "client",
      redirectUri: `${origin}/return`,
      callbackUrl: `${origin}/return?code=synthetic-code&state=state`,
      verifier: "synthetic-verifier-0123456789-0123456789-0123456789",
      state: "state",
      fetch: fetcher,
    }),
  );
  within(seen.pulled);
});

test("a DPoP-protected userinfo answer that never ends is cut off at the ceiling", async () => {
  const { seen, fetcher } = endlessFetch();
  const response = await dpopUserinfoRequest(
    `${provider}/userinfo`,
    "synthetic-access-token",
    await exportDpopJwk(),
    fetcher,
  ).then(
    (value) => ({ value }),
    (error: unknown) => ({ error }),
  );
  assert.ok("error" in response, "the oversized answer is refused");
  within(seen.pulled);
});

/*
 * The authored sign-in also speaks OAuth by hand to the author's provider (the
 * device grant, the authorization-code token request, dynamic client
 * registration), and the disposable inbox it can use issues a mailbox bearer.
 * Each of those answers is read under the same ceiling.
 */

test("an author's device authorization answer that never ends is cut off and starts nothing", async () => {
  const { seen, fetcher } = endlessFetch();
  const started = await startDeviceAuthorization(
    `${provider}/device`,
    "client",
    "openid",
    fetcher,
  );
  assert.equal(started, undefined);
  within(seen.pulled);
});

test("an author's device-grant token answer that never ends is cut off and is not a token", async () => {
  const { seen, fetcher } = endlessFetch();
  const answer = await pollDeviceToken(
    `${provider}/token`,
    { deviceCode: "dummy_device_code_0123456789", clientId: "client" },
    fetcher,
  );
  assert.deepEqual(answer, { status: "denied" });
  within(seen.pulled);
});

test("an author's authorization-code token answer that never ends is cut off and is not a token", async () => {
  const { seen, fetcher } = endlessFetch();
  const answer = await tokenRequest(
    `${provider}/token`,
    new URLSearchParams({ grant_type: "authorization_code", client_id: "c" }),
    fetcher,
  );
  assert.equal(answer, undefined);
  within(seen.pulled);
});

test("an author's dynamic client registration answer that never ends is cut off and registers nothing", async () => {
  const { seen, fetcher } = endlessFetch(201);
  const registered = await registerDynamicClient(
    `${provider}/register`,
    `${origin}/return`,
    "Ceremony",
    fetcher,
    ["authorization_code"],
  );
  assert.equal(registered, undefined);
  within(seen.pulled);
});

test("a disposable inbox's mailbox token that never ends is cut off and the inbox is unavailable", async () => {
  const { seen, fetcher } = endlessFetch(200);
  let calls = 0;
  // The domain list and the account are answered normally; the token is not.
  const mailbox: typeof fetch = async (input, init) => {
    calls += 1;
    const path = new URL(String(input)).pathname;
    if (path === "/domains")
      return Response.json([{ domain: "mail.example", isActive: true }]);
    if (path === "/accounts") return Response.json({}, { status: 201 });
    return fetcher(input, init);
  };
  await assert.rejects(
    createMailTmInbox({
      baseUrl: "https://api.mail.example",
      fetch: mailbox,
    }).provision(),
    /inbox unavailable/,
  );
  assert.ok(calls >= 3);
  within(seen.pulled);
});
