import assert from "node:assert/strict";
import test from "node:test";
import { signRequest } from "../../../src/server/connectors/providers/aws-agentcore/sigv4.js";
import { withRoleCredentials } from "../../../src/server/connectors/providers/aws-identity-center/index.js";
import {
  awsSetup,
  connectAndApprove,
  connectAndChoose,
  connectionRefOf,
  handoffRefOf,
  userCodeOf,
  type AwsSetup,
} from "./harness.js";

/*
 * Role credentials are short: one to twelve hours, an hour by default. What
 * keeps a connection useful is the layer behind them, so these tests move the
 * clock and watch which request each layer makes. Renewing the role is a new
 * GetRoleCredentials with the access token held; only a lapsed access token
 * costs a refresh grant, and a refresh token is never presented twice.
 */

type View = {
  lifecycle: string;
  lastOutcome?: string;
  revision: number;
  verification?: { validUntil?: string };
};
const asView = (value: unknown) => value as View;
const MINUTE = 60_000;

const verify = async (setup: AwsSetup, connectionRef: string) =>
  asView(await setup.service.verify(setup.person, connectionRef));

test("role credentials are left alone while enough of their time remains", async (t) => {
  const setup = await awsSetup(t);
  const { connectionRef } = await connectAndChoose(setup);
  setup.advance(10 * MINUTE);
  const view = await verify(setup, connectionRef);
  assert.equal(view.lifecycle, "active");
  assert.equal(
    setup.fixture.counts.roleCredentials,
    1,
    "no new GetRoleCredentials",
  );
  assert.equal(setup.fixture.counts.refresh, 0);
});

test("role credentials about to lapse are renewed with a new GetRoleCredentials and nothing else", async (t) => {
  const setup = await awsSetup(t);
  const { connectionRef } = await connectAndChoose(setup);
  const first = setup.fixture.issued.roleCredentials[0]!;
  const issuedAt = setup.clock();
  setup.advance(56 * MINUTE);
  const view = await verify(setup, connectionRef);
  assert.equal(view.lifecycle, "active");
  assert.equal(setup.fixture.counts.roleCredentials, 2);
  assert.equal(
    setup.fixture.counts.refresh,
    0,
    "the access token was still good",
  );
  assert.equal(setup.fixture.counts.token, 1, "no CreateToken either");
  // The caller is told the new expiry: an hour after the renewal.
  assert.equal(
    view.verification?.validUntil,
    new Date(issuedAt + 56 * MINUTE + 60 * MINUTE).toISOString(),
  );
  // The record now holds the new credentials; the earlier ones are the provider's to expire.
  const held = await setup.heldMaterial(connectionRef);
  assert.equal(
    held["access_key_id"],
    setup.fixture.issued.roleCredentials[1]!.accessKeyId,
  );
  assert.notEqual(held["access_key_id"], first.accessKeyId);
  assert.equal(setup.fixture.roleSessionValid(first.accessKeyId), true);
  assert.deepEqual(setup.fixture.violations, []);
});

test("a lapsed access token costs one refresh grant, and each refresh token is used once", async (t) => {
  const setup = await awsSetup(t, {
    double: { accessTokenLifetimeSeconds: 1200, roleLifetimeMs: 30 * MINUTE },
  });
  const { connectionRef } = await connectAndChoose(setup);
  // 26 minutes: the role has four left, the access token lapsed six ago.
  setup.advance(26 * MINUTE);
  assert.equal((await verify(setup, connectionRef)).lifecycle, "active");
  assert.equal(setup.fixture.counts.refresh, 1);
  assert.equal(setup.fixture.counts.roleCredentials, 2);
  setup.advance(26 * MINUTE);
  assert.equal((await verify(setup, connectionRef)).lifecycle, "active");
  assert.equal(
    setup.fixture.counts.refresh,
    2,
    "the rotated token, not the first",
  );
  assert.equal(setup.fixture.counts.replayedRefreshTokens, 0);
  const refreshes = setup.journal.filter(
    (entry) =>
      "operation" in entry &&
      entry.operation === "aws-identity-center.token.refresh",
  );
  assert.equal(refreshes.length, 2);
});

test("with no refresh token a lapsed access token ends the session for a person to start again", async (t) => {
  const setup = await awsSetup(t, {
    settings: { scopes: [] },
    double: { accessTokenLifetimeSeconds: 1200, roleLifetimeMs: 30 * MINUTE },
  });
  const { connectionRef } = await connectAndChoose(setup);
  assert.equal(setup.fixture.issued.refreshTokens.length, 0);
  setup.advance(26 * MINUTE);
  const view = await verify(setup, connectionRef);
  assert.equal(view.lifecycle, "expired");
  assert.equal(view.lastOutcome, "aws-identity-center.session.expired");
  assert.equal(
    setup.fixture.counts.roleCredentials,
    1,
    "nothing was asked of the portal",
  );
});

test("a refresh answered without a refresh token leaves none to present, and the next lapse ends the session cleanly", async (t) => {
  const setup = await awsSetup(t, {
    double: {
      accessTokenLifetimeSeconds: 1200,
      roleLifetimeMs: 30 * MINUTE,
      refreshAnswersWithoutRefreshToken: true,
    },
  });
  const { connectionRef } = await connectAndChoose(setup);
  setup.advance(26 * MINUTE);
  assert.equal((await verify(setup, connectionRef)).lifecycle, "active");
  assert.equal(setup.fixture.counts.refresh, 1);
  const held = await setup.heldMaterial(connectionRef);
  assert.equal(
    held["sso_refresh_token"],
    undefined,
    "the token just presented is spent, so it is not kept",
  );
  setup.advance(26 * MINUTE);
  const view = await verify(setup, connectionRef);
  assert.equal(view.lifecycle, "expired");
  assert.equal(view.lastOutcome, "aws-identity-center.session.expired");
  assert.equal(setup.fixture.counts.refresh, 1, "nothing was presented again");
  assert.equal(setup.fixture.counts.replayedRefreshTokens, 0);
});

test("a refresh the issuer refuses ends the session and is not tried again", async (t) => {
  const setup = await awsSetup(t, {
    double: { accessTokenLifetimeSeconds: 1200, roleLifetimeMs: 30 * MINUTE },
  });
  const { connectionRef } = await connectAndChoose(setup);
  // Someone spends the refresh token elsewhere: the double rotates it, so the held one is dead.
  const spent = setup.fixture.issued.refreshTokens[0]!;
  const client = setup.fixture.clients()[0]!;
  assert.ok(spent && client);
  setup.advance(26 * MINUTE);
  const held = await setup.heldMaterial(connectionRef);
  const elsewhere = await fetch(`${setup.fixture.oidcOrigin}/token`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      clientId: held["client_id"],
      clientSecret: held["client_secret"],
      refreshToken: spent,
      grantType: "refresh_token",
    }),
  });
  assert.equal(elsewhere.status, 200);
  const view = await verify(setup, connectionRef);
  assert.equal(view.lifecycle, "expired");
  assert.equal(
    view.lastOutcome,
    "aws-identity-center.session.refresh-rejected",
  );
  assert.equal(setup.fixture.counts.replayedRefreshTokens, 1);
});

test("a role removed from the person is a reconnect, not a retry", async (t) => {
  const setup = await awsSetup(t);
  const { connectionRef } = await connectAndChoose(setup);
  setup.fixture.unassign("alice", "111122223333", "ReadOnlyAccess");
  setup.advance(56 * MINUTE);
  const view = await verify(setup, connectionRef);
  assert.equal(view.lifecycle, "reconnect-required");
  assert.equal(view.lastOutcome, "aws-identity-center.role.revoked");
});

test("a sign-in session ended elsewhere is expired", async (t) => {
  const setup = await awsSetup(t);
  const { connectionRef } = await connectAndChoose(setup);
  setup.fixture.expireAccessToken(setup.fixture.issued.accessTokens[0]!);
  setup.advance(56 * MINUTE);
  const view = await verify(setup, connectionRef);
  assert.equal(view.lifecycle, "expired");
  assert.equal(view.lastOutcome, "aws-identity-center.session.ended");
});

test("trusted code signs with the role credentials, and custody refuses to let them out", async (t) => {
  const setup = await awsSetup(t);
  const { connectionRef } = await connectAndChoose(setup);
  const ctx = await setup.adapterContext(connectionRef);
  const signed = await withRoleCredentials(ctx, async (credentials) => {
    const request = signRequest(
      {
        method: "GET",
        url: new URL(
          "https://sts.us-east-1.amazonaws.com/?Action=GetCallerIdentity",
        ),
      },
      {
        region: "us-east-1",
        service: "sts",
        credentials,
        now: setup.clock(),
      },
    );
    return {
      signed: request.headers["authorization"]!.startsWith("AWS4-HMAC-SHA256"),
    };
  });
  assert.deepEqual(signed, { signed: true });
  for (const leak of [
    (credentials: { secretAccessKey: string }) => credentials.secretAccessKey,
    (credentials: { sessionToken?: string }) => ({
      nested: credentials.sessionToken,
    }),
  ])
    await assert.rejects(
      withRoleCredentials(ctx, async (credentials) => leak(credentials)),
      (error: unknown) =>
        (error as { detail?: string }).detail ===
        "credential.material-in-result",
    );
});

test("concurrent users of expiring credentials share one renewal", async (t) => {
  const setup = await awsSetup(t);
  const { connectionRef } = await connectAndChoose(setup);
  setup.advance(56 * MINUTE);
  const ctx = await setup.adapterContext(connectionRef);
  const keyIds = await Promise.all(
    [1, 2, 3].map(() =>
      withRoleCredentials(
        ctx,
        async (credentials) => credentials.accessKeyId.length,
      ),
    ),
  );
  assert.deepEqual(keyIds, [keyIds[0], keyIds[0], keyIds[0]]);
  assert.equal(
    setup.fixture.counts.roleCredentials,
    2,
    "one renewal, not three",
  );
});

test("a local disconnect releases everything the sign-in held, after ending the portal session", async (t) => {
  const setup = await awsSetup(t);
  const { connectionRef, done } = await connectAndChoose(setup);
  const before = await setup.record(connectionRef);
  const view = asView(
    await setup.service
      .disconnect(setup.person, connectionRef, {
        expectedRevision: asView(done).revision,
        scope: "local",
      })
      .then((result) => result.connection),
  );
  assert.equal(view.lifecycle, "locally-disconnected");
  assert.equal(setup.fixture.counts.logout, 1, "see release.test.ts");
  const scope = {
    tenantId: before.tenantId,
    ownerKind: before.ownerKind,
    ownerId: before.ownerId,
    connectionRef: before.connectionRef,
    bindingRef: before.bindingRef,
    custody: before.custody,
  };
  assert.equal(
    await setup.ports.credentials.describe(scope, before.credentialRef!),
    undefined,
    "the refresh token, the client secret and the role credentials are gone",
  );
});

test("an upstream disconnect ends the sign-in session and does not claim to end role sessions", async (t) => {
  const setup = await awsSetup(t);
  const { connectionRef, done } = await connectAndChoose(setup);
  const role = setup.fixture.issued.roleCredentials[0]!;
  const result = await setup.service.disconnect(setup.person, connectionRef, {
    expectedRevision: asView(done).revision,
    scope: "upstream",
  });
  assert.equal(result.result.upstream, "applied");
  assert.equal(setup.fixture.counts.logout, 1);
  const afterwards = await fetch(
    `${setup.fixture.portalOrigin}/assignment/accounts`,
    {
      headers: {
        "x-amz-sso_bearer_token": setup.fixture.issued.accessTokens[0]!,
      },
    },
  );
  assert.equal(afterwards.status, 401, "the sign-in session is over");
  assert.equal(
    setup.fixture.roleSessionValid(role.accessKeyId),
    true,
    "the Logout reference says role sessions already issued continue",
  );
});

test("reconnecting is a new sign-in, and the old credentials are released once it completes", async (t) => {
  const setup = await awsSetup(t, { accounts: ["444455556666"] });
  const { connectionRef, polled } = await connectAndApprove(setup);
  const first = await setup.record(connectionRef);
  const scope = {
    tenantId: first.tenantId,
    ownerKind: first.ownerKind,
    ownerId: first.ownerId,
    connectionRef: first.connectionRef,
    bindingRef: first.bindingRef,
    custody: first.custody,
  };
  const reconnecting = await setup.service.reconnect(
    setup.person,
    connectionRef,
    {
      expectedRevision: asView(polled).revision,
    },
  );
  const code = userCodeOf(reconnecting);
  assert.ok(setup.fixture.approve(code));
  setup.advance(6 * 1000);
  const again = asView(await setup.service.poll(setup.person, connectionRef));
  assert.equal(again.lifecycle, "active");
  assert.equal(setup.fixture.clientCount(), 2, "one client per sign-in");
  assert.equal(
    await setup.ports.credentials.describe(scope, first.credentialRef!),
    undefined,
    "the superseded record was released",
  );
  assert.notEqual(
    (await setup.record(connectionRef)).credentialRef,
    first.credentialRef,
  );
});

test("reconnecting into a different role is refused without an explicit account switch", async (t) => {
  const setup = await awsSetup(t);
  const { connectionRef, done } = await connectAndChoose(setup);
  const reconnecting = await setup.service.reconnect(
    setup.person,
    connectionRef,
    {
      expectedRevision: asView(done).revision,
    },
  );
  setup.fixture.approve(userCodeOf(reconnecting));
  setup.advance(6_000);
  const choose = await setup.service.poll(setup.person, connectionRef);
  const view = asView(
    await setup.service.provideInput(
      setup.person,
      connectionRef,
      handoffRefOf(choose),
      { accountId: "111122223333", roleName: "AdministratorAccess" },
    ),
  );
  assert.equal(view.lifecycle, "reconnect-required");
  assert.equal(view.lastOutcome, "verification.account-changed");
});

test("the connection reference alone identifies a connection", () => {
  assert.equal(
    connectionRefOf({ connectionRef: "connection:x" }),
    "connection:x",
  );
});
