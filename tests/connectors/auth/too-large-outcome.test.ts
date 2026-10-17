import assert from "node:assert/strict";
import test from "node:test";
import { ResponseTooLargeError } from "../../../src/server/connectors/auth/index.js";
import { ConnectorError } from "../../../src/server/connectors/errors.js";
import {
  describeFailure,
  DROPPED,
  exchangeWith,
  grantWith,
  OVERSIZED,
  refreshWith,
  registerWith,
  SERVICE_UNAVAILABLE,
} from "./outcome-rigs.js";

/*
 * An answer too large to read is not a refusal: the request was sent, a
 * single-use refresh token may have been spent and a token may have been
 * minted. Where the engine journals the attempt, it is journaled the way a
 * lost answer is (indeterminate), and the caller is told so with the same
 * code. Each case is held to a baseline that is already right: a 5xx on a
 * refresh, a connection dropped after the request on a client-credentials
 * grant.
 */

test("a refresh answer too large to read is journaled and reported exactly as a lost answer is", async (t) => {
  const baseline = await refreshWith(t, SERVICE_UNAVAILABLE);
  assert.deepEqual(baseline.first, {
    code: "indeterminate",
    detail: "oauth.refresh.indeterminate",
  });
  assert.deepEqual(baseline.journal, [
    ["indeterminate", "oauth.refresh.indeterminate"],
  ]);

  const oversized = await refreshWith(t, OVERSIZED);

  assert.deepEqual(oversized.first, baseline.first);
  assert.deepEqual(oversized.journal, baseline.journal);
  assert.deepEqual(oversized.second, baseline.second);
  assert.ok(
    oversized.failure instanceof ConnectorError &&
      oversized.failure.cause instanceof ResponseTooLargeError,
    "the cause says what was too large, and holds none of it",
  );
  assert.equal(
    oversized.tokenRequests,
    baseline.tokenRequests,
    "the refresh token was not presented a second time",
  );
});

test("a client-credentials answer too large to read is journaled and reported exactly as a lost answer is", async (t) => {
  const baseline = await grantWith(t, DROPPED);
  assert.deepEqual(baseline.described, {
    code: "indeterminate",
    detail: "oauth.client-credentials.indeterminate",
  });
  assert.deepEqual(baseline.journal, [
    ["indeterminate", "oauth.client-credentials.indeterminate"],
  ]);

  const oversized = await grantWith(t, OVERSIZED);

  assert.deepEqual(oversized.described, baseline.described);
  assert.deepEqual(oversized.journal, baseline.journal);
  assert.equal(
    oversized.stored,
    0,
    "a token that was never parsed is not kept",
  );
  assert.ok(
    oversized.failure instanceof ConnectorError &&
      oversized.failure.cause instanceof ResponseTooLargeError,
  );
});

test("a registration answer too large to read is journaled and reported as unknown, with the typed outcome", async (t) => {
  const { failure, effects } = await registerWith(t, OVERSIZED);

  assert.deepEqual(describeFailure(failure), {
    code: "indeterminate",
    detail: "oauth.registration.indeterminate",
  });
  assert.ok(
    failure instanceof ConnectorError &&
      failure.cause instanceof ResponseTooLargeError,
  );
  assert.deepEqual(effects, [
    ["indeterminate", "oauth.registration.indeterminate"],
  ]);
});

test("an RFC 8693 token answer too large to read is journaled and reported as unknown, with the typed outcome", async (t) => {
  const { failure, journal, stored } = await exchangeWith(t, OVERSIZED);

  assert.deepEqual(describeFailure(failure), {
    code: "indeterminate",
    detail: "oauth.exchange.indeterminate",
  });
  assert.ok(
    failure instanceof ConnectorError &&
      failure.cause instanceof ResponseTooLargeError,
  );
  assert.deepEqual(journal, ["indeterminate"]);
  assert.equal(stored, 0);
});
