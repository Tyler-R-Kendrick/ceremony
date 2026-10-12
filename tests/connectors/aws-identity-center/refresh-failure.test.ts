import assert from "node:assert/strict";
import test from "node:test";
import { ConnectorError } from "../../../src/server/connectors/errors.js";
import {
  awsSetup,
  connectAndApprove,
  connectAndChoose,
  handoffRefOf,
  type AwsSetup,
} from "./harness.js";

/*
 * A refresh token is single use: the moment CreateToken answers a refresh, the
 * token that was presented is spent and the answer holds the only one that
 * works. Renewing role credentials presents it first and asks the portal
 * second, so a portal that fails after the refresh must not cost the person
 * the session. What the refresh returned is kept, the portal's failure is
 * still reported, and the next attempt carries on from the new tokens.
 */

type View = { lifecycle: string; lastOutcome?: string };
const asView = (value: unknown) => value as View;
const MINUTE = 60_000;
const unavailable = (error: unknown) =>
  error instanceof ConnectorError && error.code === "upstream-unavailable";

const refreshesPresented = (setup: AwsSetup) =>
  setup.journal.filter(
    (entry) =>
      "operation" in entry &&
      entry.operation === "aws-identity-center.token.refresh",
  ).length;

test("a portal that fails after a refresh keeps the refreshed tokens, and the next renewal succeeds", async (t) => {
  const setup = await awsSetup(t, {
    double: { accessTokenLifetimeSeconds: 1200, roleLifetimeMs: 30 * MINUTE },
  });
  const { connectionRef } = await connectAndChoose(setup);
  // 26 minutes: the role has four left, the access token lapsed six ago.
  setup.advance(26 * MINUTE);
  setup.fixture.failPortal(503);
  await assert.rejects(
    setup.service.verify(setup.person, connectionRef),
    unavailable,
  );
  assert.equal(setup.fixture.counts.refresh, 1, "the refresh did go through");

  setup.fixture.failPortal(null);
  const view = asView(await setup.service.verify(setup.person, connectionRef));
  assert.equal(view.lifecycle, "active");
  assert.equal(
    setup.fixture.counts.refresh,
    1,
    "the rotated token was kept, so no second grant was needed",
  );
  assert.equal(setup.fixture.counts.replayedRefreshTokens, 0);
  assert.equal(refreshesPresented(setup), 1);
  assert.equal(setup.fixture.counts.roleCredentials, 2);
  const held = await setup.heldMaterial(connectionRef);
  assert.equal(
    held["sso_refresh_token"],
    setup.fixture.issued.refreshTokens.at(-1),
    "custody holds the newest refresh token, not the spent one",
  );
  assert.deepEqual(setup.fixture.violations, []);
});

test("a portal that keeps failing after a refresh never makes the session unrecoverable", async (t) => {
  const setup = await awsSetup(t, {
    double: { accessTokenLifetimeSeconds: 1200, roleLifetimeMs: 30 * MINUTE },
  });
  const { connectionRef } = await connectAndChoose(setup);
  setup.advance(26 * MINUTE);
  setup.fixture.failPortal(429);
  for (let attempt = 0; attempt < 3; attempt += 1)
    await assert.rejects(
      setup.service.verify(setup.person, connectionRef),
      (error: unknown) => error instanceof ConnectorError,
      `attempt ${attempt + 1} fails on the portal, not on a spent token`,
    );
  assert.equal(
    setup.fixture.counts.refresh,
    1,
    "one grant, then reuse of its result",
  );
  setup.fixture.failPortal(null);
  assert.equal(
    asView(await setup.service.verify(setup.person, connectionRef)).lifecycle,
    "active",
  );
});

test("a portal that rejects the new token after a refresh still keeps it", async (t) => {
  const setup = await awsSetup(t, {
    double: { accessTokenLifetimeSeconds: 1200, roleLifetimeMs: 30 * MINUTE },
  });
  const { connectionRef } = await connectAndChoose(setup);
  setup.advance(26 * MINUTE);
  setup.fixture.failPortal(401);
  const ended = asView(await setup.service.verify(setup.person, connectionRef));
  assert.equal(ended.lifecycle, "expired");
  assert.equal(ended.lastOutcome, "aws-identity-center.session.ended");
  const held = await setup.heldMaterial(connectionRef);
  assert.equal(
    held["sso_refresh_token"],
    setup.fixture.issued.refreshTokens.at(-1),
    "the answer to the refresh is what custody holds, whatever the portal then said",
  );
});

test("a role choice that needs a refresh and meets a failing portal can be made again", async (t) => {
  const setup = await awsSetup(t, {
    double: { accessTokenLifetimeSeconds: 300, roleLifetimeMs: 30 * MINUTE },
  });
  const first = await connectAndApprove(setup);
  const handoffRef = handoffRefOf(first.polled);
  // Six minutes on: the access token lapsed one ago, the choice is still open.
  setup.advance(6 * MINUTE);
  setup.fixture.failPortal(503);
  await assert.rejects(
    setup.service.provideInput(setup.person, first.connectionRef, handoffRef, {
      accountId: "111122223333",
      roleName: "ReadOnlyAccess",
    }),
    unavailable,
  );
  assert.equal(setup.fixture.counts.refresh, 1);

  setup.fixture.failPortal(null);
  const done = asView(
    await setup.service.provideInput(
      setup.person,
      first.connectionRef,
      handoffRef,
      { accountId: "111122223333", roleName: "ReadOnlyAccess" },
    ),
  );
  assert.equal(done.lifecycle, "active");
  assert.equal(setup.fixture.counts.refresh, 1);
  assert.equal(setup.fixture.counts.replayedRefreshTokens, 0);
});

test("callers that share a renewal whose portal call failed are not told the credentials are current", async (t) => {
  const setup = await awsSetup(t, {
    double: { accessTokenLifetimeSeconds: 1200, roleLifetimeMs: 30 * MINUTE },
  });
  const { connectionRef } = await connectAndChoose(setup);
  setup.advance(26 * MINUTE);
  setup.fixture.failPortal(503);
  // One caller leads the renewal and meets the portal's failure; the others
  // join its rotation, which wrote the refreshed tokens and left the role as it was.
  const results = await Promise.allSettled([
    setup.service.verify(setup.person, connectionRef),
    setup.service.verify(setup.person, connectionRef),
    setup.service.verify(setup.person, connectionRef),
  ]);
  for (const result of results)
    assert.ok(
      result.status === "rejected" ||
        (result.value as View).lifecycle !== "active",
      "no caller is told the role credentials are current",
    );
  assert.equal(setup.fixture.counts.refresh, 1);
  // The refreshed tokens were kept, so once the portal is back the next call renews.
  setup.fixture.failPortal(null);
  const view = asView(await setup.service.verify(setup.person, connectionRef));
  assert.equal(view.lifecycle, "active");
  assert.equal(setup.fixture.counts.refresh, 1);
  assert.equal(setup.fixture.counts.roleCredentials, 2);
});

test("a choice made twice at once while the portal fails stays open for a retry", async (t) => {
  const setup = await awsSetup(t, {
    double: { accessTokenLifetimeSeconds: 300, roleLifetimeMs: 30 * MINUTE },
  });
  const first = await connectAndApprove(setup);
  const handoffRef = handoffRefOf(first.polled);
  setup.advance(6 * MINUTE);
  setup.fixture.failPortal(503);
  const choice = { accountId: "111122223333", roleName: "ReadOnlyAccess" };
  const results = await Promise.allSettled([
    setup.service.provideInput(
      setup.person,
      first.connectionRef,
      handoffRef,
      choice,
    ),
    setup.service.provideInput(
      setup.person,
      first.connectionRef,
      handoffRef,
      choice,
    ),
  ]);
  for (const result of results) assert.equal(result.status, "rejected");
  assert.equal(setup.fixture.counts.roleCredentials, 0);
  setup.fixture.failPortal(null);
  const done = asView(
    await setup.service.provideInput(
      setup.person,
      first.connectionRef,
      handoffRef,
      choice,
    ),
  );
  assert.equal(done.lifecycle, "active");
});
