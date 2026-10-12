import assert from "node:assert/strict";
import test from "node:test";
import { inspect } from "node:util";
import * as oauth from "oauth4webapi";
import { wireError } from "../../../src/server/connectors/auth/wire.js";
import { ConnectorError } from "../../../src/server/connectors/errors.js";

/*
 * oauth4webapi attaches the parsed response body to some of its errors
 * (`cause.body`), and for a token response that is the whole answer, tokens
 * included. wireError keeps the failure as the connector error's cause for the
 * people who debug it, and a cause prints with its error wherever one is
 * inspected or logged. What is kept is therefore the failure's class and code,
 * never what the response carried.
 */

const TOKEN = "vca_dummy_marker_0123456789abcdef";
const REFRESH = "vcr_dummy_marker_fedcba9876543210";

const body = { access_token: TOKEN, refresh_token: REFRESH, token_type: "mac" };

test("an unsupported-operation error that carries a token response keeps no part of the response", () => {
  const failure = new oauth.UnsupportedOperationError(
    "unsupported `token_type` value",
    { cause: { body } },
  );
  const wrapped = wireError(failure, "oauth.token");
  assert.ok(wrapped instanceof ConnectorError);
  assert.equal(wrapped.detail, "oauth.token.invalid-response");
  const text = inspect(wrapped, { depth: null, showHidden: true });
  assert.equal(text.includes(TOKEN), false);
  assert.equal(text.includes(REFRESH), false);
  // The failure is still named for whoever debugs it.
  assert.ok(wrapped.cause instanceof Error);
  assert.equal(wrapped.cause.name, failure.name);
  assert.equal((wrapped.cause as { code?: string }).code, failure.code);
});

test("an operation-processing error that carries a token response keeps no part of the response", () => {
  const failure = new oauth.OperationProcessingError(
    '"response" body "access_token" property must be a non-empty string',
    { cause: { body } },
  );
  const wrapped = wireError(failure, "oauth.token");
  const text = inspect(wrapped, { depth: null, showHidden: true });
  assert.equal(text.includes(TOKEN), false);
  assert.equal(text.includes(REFRESH), false);
  assert.ok(wrapped.cause instanceof Error);
});

test("other failures keep their cause, which only trusted server code can reach", () => {
  const unreachable = new TypeError("fetch failed", {
    cause: Object.assign(new Error("connect ECONNREFUSED"), {
      code: "ECONNREFUSED",
    }),
  });
  const wrapped = wireError(unreachable, "oauth.token");
  assert.equal(wrapped.detail, "oauth.token.unreachable");
  assert.equal(wrapped.cause, unreachable);
});
