import assert from "node:assert/strict";
import test from "node:test";
import { inspect } from "node:util";
import * as oauth from "oauth4webapi";
import {
  boundResponse,
  MAX_RESPONSE_BYTES,
  requestOptions,
  ResponseTooLargeError,
} from "../../../src/server/connectors/auth/index.js";
import {
  ConnectorError,
  explainConnectorError,
} from "../../../src/server/connectors/errors.js";

/*
 * Every OAuth answer the host reads is read under a ceiling. The ceiling sits
 * where every request leaves the host (`wireFetch`, through `requestOptions`),
 * so each call oauth4webapi makes is bounded without the call having to ask:
 * token grants, device authorization, revocation, introspection, userinfo,
 * registration, pushed authorization and discovery. A body that is too large
 * is refused with a typed error that names the ceiling and holds none of the
 * body; a streamed body with no declared length is refused where it crosses
 * the ceiling, not after the stream has been read to its end.
 */

const MARKER = "tok_dummy_marker_0123456789abcdef";
const CHUNK = 64 * 1024;

const as: oauth.AuthorizationServer = {
  issuer: "https://issuer.example",
  token_endpoint: "https://issuer.example/token",
  device_authorization_endpoint: "https://issuer.example/device",
  revocation_endpoint: "https://issuer.example/revoke",
  introspection_endpoint: "https://issuer.example/introspect",
  userinfo_endpoint: "https://issuer.example/userinfo",
  registration_endpoint: "https://issuer.example/register",
  pushed_authorization_request_endpoint: "https://issuer.example/par",
};
const client: oauth.Client = { client_id: "client-1" };
const none = oauth.None();
const json = { "content-type": "application/json" };

/** A fetch that answers whatever is asked with one prepared response. */
const answering =
  (respond: () => Response): typeof fetch =>
  async () =>
    respond();

/** A well-formed JSON object of more than `bytes`, carrying the marker. */
function oversizedJson(bytes: number): Uint8Array<ArrayBuffer> {
  return new TextEncoder().encode(
    JSON.stringify({ access_token: MARKER, padding: "x".repeat(bytes) }),
  );
}

/** A body that never ends and reports how often it was read. */
function endless() {
  const state = { pulled: 0, cancelled: false };
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      state.pulled += 1;
      controller.enqueue(new Uint8Array(CHUNK).fill(0x20));
    },
    cancel() {
      state.cancelled = true;
    },
  });
  return { state, body };
}

const refused = (error: unknown) => {
  assert.ok(error instanceof ResponseTooLargeError, String(error));
  assert.equal(error.code, "upstream-rejected");
  assert.equal(error.detail, "oauth.response.too-large");
  assert.equal(error.limitBytes, MAX_RESPONSE_BYTES);
  return true;
};

/** Each OAuth request oauth4webapi can make, made with the options this module hands it. */
const calls: Array<[string, (options: object) => Promise<Response>]> = [
  [
    "token (authorization code, refresh and client credentials grants)",
    (options) =>
      oauth.clientCredentialsGrantRequest(
        as,
        client,
        none,
        new URLSearchParams(),
        options,
      ),
  ],
  [
    "refresh token grant",
    (options) =>
      oauth.refreshTokenGrantRequest(as, client, none, "refresh", options),
  ],
  [
    "device authorization",
    (options) =>
      oauth.deviceAuthorizationRequest(
        as,
        client,
        none,
        new URLSearchParams({ scope: "openid" }),
        options,
      ),
  ],
  [
    "revocation",
    (options) => oauth.revocationRequest(as, client, none, "refresh", options),
  ],
  [
    "introspection",
    (options) =>
      oauth.introspectionRequest(as, client, none, "access", options),
  ],
  [
    "userinfo",
    (options) => oauth.userInfoRequest(as, client, "access", options),
  ],
  [
    "dynamic client registration",
    (options) =>
      oauth.dynamicClientRegistrationRequest(
        as,
        { redirect_uris: ["https://app.example/callback"] },
        options,
      ),
  ],
  [
    "pushed authorization",
    (options) =>
      oauth.pushedAuthorizationRequest(
        as,
        client,
        none,
        new URLSearchParams(),
        options,
      ),
  ],
  [
    "discovery",
    (options) =>
      oauth.discoveryRequest(new URL("https://issuer.example"), options),
  ],
];

for (const [name, call] of calls) {
  const options = (fetch: typeof globalThis.fetch) =>
    requestOptions({ fetch, allowLoopbackHttp: false });

  test(`an oversized ${name} answer is refused without being read`, async () => {
    const { state, body } = endless();
    const sent = answering(
      () =>
        new Response(body, {
          status: 200,
          headers: {
            ...json,
            "content-length": String(MAX_RESPONSE_BYTES + 1),
          },
        }),
    );
    await assert.rejects(call(options(sent)), refused);
    assert.ok(
      state.pulled <= 2,
      `read ${state.pulled} chunks of a body that was declared too large`,
    );
    assert.equal(state.cancelled, true, "the body was cancelled");
  });

  test(`a streamed ${name} answer with no length is refused where it crosses the ceiling`, async () => {
    const { state, body } = endless();
    const sent = answering(
      () => new Response(body, { status: 200, headers: json }),
    );
    await assert.rejects(call(options(sent)), refused);
    const allowed = MAX_RESPONSE_BYTES / CHUNK;
    assert.ok(
      state.pulled > allowed && state.pulled <= allowed + 3,
      `stopped after ${state.pulled} chunks (the ceiling is ${allowed})`,
    );
    assert.equal(state.cancelled, true, "the stream was cancelled");
  });

  test(`an oversized ${name} answer that declares less than it sends is refused`, async () => {
    const sent = answering(
      () =>
        new Response(oversizedJson(MAX_RESPONSE_BYTES), {
          status: 200,
          headers: { ...json, "content-length": "120" },
        }),
    );
    await assert.rejects(call(options(sent)), refused);
  });
}

test("an oversized answer's error names the ceiling and holds nothing of the body", async () => {
  const sent = answering(
    () =>
      new Response(oversizedJson(MAX_RESPONSE_BYTES), {
        status: 200,
        headers: json,
      }),
  );
  const error = await oauth
    .clientCredentialsGrantRequest(
      as,
      client,
      none,
      new URLSearchParams(),
      requestOptions({ fetch: sent, allowLoopbackHttp: false }),
    )
    .then(
      () => undefined,
      (failure: unknown) => failure,
    );
  assert.ok(error instanceof ResponseTooLargeError);
  assert.ok(error instanceof ConnectorError);
  assert.equal(error.limitBytes, 1_048_576);
  for (const text of [
    inspect(error, { depth: null, showHidden: true }),
    JSON.stringify(explainConnectorError(error)),
    String(error.stack),
  ])
    assert.equal(text.includes(MARKER), false);
  assert.equal(error.cause, undefined);
});

test("a body at the ceiling is read, and one byte more is not", async () => {
  const at = new Uint8Array(MAX_RESPONSE_BYTES).fill(0x61);
  const read = await boundResponse(new Response(at, { status: 200 }));
  assert.equal((await read.arrayBuffer()).byteLength, MAX_RESPONSE_BYTES);
  await assert.rejects(
    boundResponse(
      new Response(new Uint8Array(MAX_RESPONSE_BYTES + 1), { status: 200 }),
    ),
    refused,
  );
});

test("the ceiling can be set per transport", async () => {
  const big = new Response(new Uint8Array(1025), { status: 200 });
  await assert.rejects(
    boundResponse(big, 1024),
    (error: unknown) =>
      error instanceof ResponseTooLargeError && error.limitBytes === 1024,
  );
});

test("an answer within the ceiling is the same answer", async () => {
  const document = JSON.stringify({
    access_token: MARKER,
    token_type: "Bearer",
    expires_in: 3600,
  });
  const original = new Response(document, {
    status: 200,
    statusText: "OK",
    headers: { ...json, "dpop-nonce": "nonce-1", "x-request-id": "r-1" },
  });
  const bounded = await boundResponse(original);
  assert.equal(bounded.status, 200);
  assert.equal(bounded.statusText, "OK");
  assert.equal(bounded.headers.get("dpop-nonce"), "nonce-1");
  assert.equal(bounded.headers.get("x-request-id"), "r-1");
  assert.equal(bounded.headers.get("content-type"), "application/json");
  assert.equal(await bounded.text(), document);
  // And it is a response that can be cloned and read twice, as the library does.
  const again = await boundResponse(new Response(document, { headers: json }));
  assert.deepEqual(await again.clone().json(), await again.json());
});

test("answers without a body stay without one", async () => {
  for (const status of [204, 205, 304]) {
    const bounded = await boundResponse(new Response(null, { status }));
    assert.equal(bounded.status, status);
    assert.equal(bounded.body, null);
  }
  const empty = await boundResponse(new Response("", { status: 200 }));
  assert.equal(await empty.text(), "");
  const refusal = await boundResponse(
    new Response(JSON.stringify({ error: "invalid_grant" }), {
      status: 400,
      headers: json,
    }),
  );
  assert.equal(refusal.status, 400);
  assert.deepEqual(await refusal.json(), { error: "invalid_grant" });
});

test("a revocation answer, a token answer and an error answer pass the library unchanged", async () => {
  const options = (fetch: typeof globalThis.fetch) =>
    requestOptions({ fetch, allowLoopbackHttp: false });
  const revoked = await oauth.revocationRequest(
    as,
    client,
    none,
    "refresh",
    options(answering(() => new Response(null, { status: 200 }))),
  );
  await oauth.processRevocationResponse(revoked);

  const token = await oauth.clientCredentialsGrantRequest(
    as,
    client,
    none,
    new URLSearchParams(),
    options(
      answering(
        () =>
          new Response(
            JSON.stringify({ access_token: "a", token_type: "bearer" }),
            { status: 200, headers: json },
          ),
      ),
    ),
  );
  const processed = await oauth.processClientCredentialsResponse(
    as,
    client,
    token,
  );
  assert.equal(processed.access_token, "a");

  const rejected = await oauth.clientCredentialsGrantRequest(
    as,
    client,
    none,
    new URLSearchParams(),
    options(
      answering(
        () =>
          new Response(JSON.stringify({ error: "invalid_client" }), {
            status: 401,
            headers: json,
          }),
      ),
    ),
  );
  await assert.rejects(
    oauth.processClientCredentialsResponse(as, client, rejected),
    (error: unknown) =>
      error instanceof oauth.ResponseBodyError &&
      error.error === "invalid_client",
  );
});
