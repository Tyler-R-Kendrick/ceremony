import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import {
  startAwsIdentityCenter,
  type AwsIdentityCenterOptions,
} from "../doubles/aws-identity-center.js";
import { alice, START_TIME, START_URL } from "./harness.js";

/*
 * The double refuses what the published references say it must, and what the
 * recorded assumptions say it does. A double that accepted anything would let
 * every adapter test pass for the wrong reason, so each refusal the adapter
 * relies on is pinned here against the wire, with no adapter code in the way.
 */

const DEVICE_GRANT = "urn:ietf:params:oauth:grant-type:device_code";

async function start(t: TestContext, options: AwsIdentityCenterOptions = {}) {
  let clock = START_TIME;
  const fixture = await startAwsIdentityCenter({
    startUrl: START_URL,
    people: [structuredClone(alice)],
    now: () => clock,
    ...options,
  });
  t.after(() => fixture.close());
  const advance = (ms: number) => {
    clock += ms;
  };
  const post = async (origin: string, path: string, body: unknown) => {
    const response = await fetch(`${origin}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    return {
      status: response.status,
      json: (await response.json().catch(() => undefined)) as
        Record<string, unknown> | undefined,
    };
  };
  const oidc = (path: string, body: unknown) =>
    post(fixture.oidcOrigin, path, body);
  const register = async (
    overrides: Record<string, unknown> = {},
  ): Promise<{ clientId: string; clientSecret: string }> => {
    const registered = await oidc("/client/register", {
      clientName: "Ceremony",
      clientType: "public",
      grantTypes: [DEVICE_GRANT, "refresh_token"],
      scopes: ["sso:account:access"],
      ...overrides,
    });
    assert.equal(registered.status, 200);
    return registered.json as { clientId: string; clientSecret: string };
  };
  const startDevice = async (client: {
    clientId: string;
    clientSecret: string;
  }) => {
    const started = await oidc("/device_authorization", {
      ...client,
      startUrl: START_URL,
    });
    assert.equal(started.status, 200);
    return started.json as {
      deviceCode: string;
      userCode: string;
      interval: number;
    };
  };
  const poll = (
    client: { clientId: string; clientSecret: string },
    deviceCode: string,
  ) => oidc("/token", { ...client, deviceCode, grantType: DEVICE_GRANT });
  return { fixture, advance, oidc, register, startDevice, poll, post };
}

test("RegisterClient answers the documented members and refuses what the reference rules out", async (t) => {
  const { fixture, oidc, register } = await start(t);
  const ok = await oidc("/client/register", {
    clientName: "Ceremony",
    clientType: "public",
    grantTypes: [DEVICE_GRANT, "refresh_token"],
    scopes: ["sso:account:access"],
  });
  assert.equal(ok.status, 200);
  assert.deepEqual(Object.keys(ok.json!).sort(), [
    "authorizationEndpoint",
    "clientId",
    "clientIdIssuedAt",
    "clientSecret",
    "clientSecretExpiresAt",
    "tokenEndpoint",
  ]);
  // The reference: "Anything other than public will be rejected".
  const confidential = await oidc("/client/register", {
    clientName: "Ceremony",
    clientType: "confidential",
  });
  assert.equal(confidential.status, 400);
  assert.equal(confidential.json!["error"], "invalid_client_metadata");
  const grant = await oidc("/client/register", {
    clientName: "Ceremony",
    clientType: "public",
    grantTypes: ["password"],
  });
  assert.equal(grant.json!["error"], "unsupported_grant_type");
  const nameless = await oidc("/client/register", { clientType: "public" });
  assert.equal(nameless.json!["error"], "invalid_request");
  assert.deepEqual(fixture.violations, []);
  await register();
  assert.equal(fixture.clientCount(), 2);
});

test("StartDeviceAuthorization refuses a wrong secret, a foreign start URL and a client without the grant", async (t) => {
  const { oidc, register } = await start(t);
  const client = await register();
  const wrongSecret = await oidc("/device_authorization", {
    clientId: client.clientId,
    clientSecret: "aws_dummy_not_the_secret",
    startUrl: START_URL,
  });
  assert.equal(wrongSecret.status, 401);
  assert.equal(wrongSecret.json!["error"], "invalid_client");
  const elsewhere = await oidc("/device_authorization", {
    ...client,
    startUrl: "https://elsewhere.awsapps.com/start",
  });
  assert.equal(elsewhere.status, 400);
  assert.equal(elsewhere.json!["error"], "invalid_request");
  const withoutGrant = await register({ grantTypes: ["refresh_token"] });
  const refused = await oidc("/device_authorization", {
    ...withoutGrant,
    startUrl: START_URL,
  });
  assert.equal(refused.json!["error"], "unauthorized_client");
  const missing = await oidc("/device_authorization", { ...client });
  assert.equal(missing.json!["error"], "invalid_request");
});

test("a device code that was never issued, or was issued to another client, is invalid_grant", async (t) => {
  const { fixture, register, startDevice, poll } = await start(t);
  const client = await register();
  const other = await register();
  const device = await startDevice(client);
  assert.equal(
    (await poll(client, "aws_dummy_device_code_wrong")).json!["error"],
    "invalid_grant",
  );
  const foreign = await poll(other, device.deviceCode);
  assert.equal(foreign.status, 400);
  assert.equal(foreign.json!["error"], "invalid_grant");
  // The refusal consumed nothing: its owner can still be approved and redeem it.
  fixture.approve(device.userCode);
  assert.equal((await poll(client, device.deviceCode)).status, 200);
});

test("polling faster than the interval is slow_down, and the interval grows by five seconds each time", async (t) => {
  const { fixture, advance, register, startDevice, poll } = await start(t);
  const client = await register();
  const device = await startDevice(client);
  assert.equal(device.interval, 5);
  assert.equal(
    (await poll(client, device.deviceCode)).json!["error"],
    "authorization_pending",
  );
  advance(1_000);
  const early = await poll(client, device.deviceCode);
  assert.equal(early.status, 400);
  assert.equal(early.json!["error"], "slow_down");
  assert.equal(fixture.counts.tooFastPolls, 1);
  // Ten seconds now: nine is still too soon, and that is slow_down again.
  advance(9_000);
  assert.equal(
    (await poll(client, device.deviceCode)).json!["error"],
    "slow_down",
  );
  advance(15_000);
  assert.equal(
    (await poll(client, device.deviceCode)).json!["error"],
    "authorization_pending",
  );
  assert.equal(fixture.counts.tooFastPolls, 2);
});

test("a denied approval is access_denied and an expired code is expired_token", async (t) => {
  const { fixture, advance, register, startDevice, poll } = await start(t);
  const client = await register();
  const denied = await startDevice(client);
  assert.ok(fixture.deny(denied.userCode));
  advance(6_000);
  assert.equal(
    (await poll(client, denied.deviceCode)).json!["error"],
    "access_denied",
  );
  const lapsed = await startDevice(client);
  advance(601_000);
  assert.equal(
    (await poll(client, lapsed.deviceCode)).json!["error"],
    "expired_token",
  );
  // A code that has expired cannot be approved afterwards.
  assert.equal(fixture.approve(lapsed.userCode), false);
});

test("an approved device code is redeemed once; a replay is invalid_grant", async (t) => {
  const { fixture, advance, register, startDevice, poll } = await start(t);
  const client = await register();
  const device = await startDevice(client);
  fixture.approve(device.userCode);
  advance(6_000);
  const first = await poll(client, device.deviceCode);
  assert.equal(first.status, 200);
  assert.deepEqual(Object.keys(first.json!).sort(), [
    "accessToken",
    "expiresIn",
    "refreshToken",
    "tokenType",
  ]);
  assert.equal(first.json!["tokenType"], "Bearer");
  advance(6_000);
  const replay = await poll(client, device.deviceCode);
  assert.equal(replay.status, 400);
  assert.equal(replay.json!["error"], "invalid_grant");
  assert.equal(fixture.counts.replayedDeviceCodes, 1);
});

test("CreateToken refuses a wrong client secret, an unsupported grant and a body outside its members", async (t) => {
  const { fixture, oidc, register, startDevice } = await start(t);
  const client = await register();
  const device = await startDevice(client);
  const wrong = await oidc("/token", {
    clientId: client.clientId,
    clientSecret: "aws_dummy_not_the_secret",
    deviceCode: device.deviceCode,
    grantType: DEVICE_GRANT,
  });
  assert.equal(wrong.status, 401);
  assert.equal(wrong.json!["error"], "invalid_client");
  const grant = await oidc("/token", { ...client, grantType: "password" });
  assert.equal(grant.json!["error"], "unsupported_grant_type");
  const form = await fetch(`${fixture.oidcOrigin}/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: `grant_type=${encodeURIComponent(DEVICE_GRANT)}`,
  });
  assert.equal(form.status, 400);
  assert.ok(
    fixture.violations.some((entry) => /content-type/.test(entry)),
    "a form-encoded body is recorded as a wire violation",
  );
});

test("a refresh token rotates, is refused when replayed, and belongs to one client", async (t) => {
  const { fixture, advance, oidc, register, startDevice, poll } =
    await start(t);
  const client = await register();
  const other = await register();
  const device = await startDevice(client);
  fixture.approve(device.userCode);
  advance(6_000);
  const first = (await poll(client, device.deviceCode)).json!;
  const refreshToken = first["refreshToken"] as string;
  const refresh = (who: typeof client, token: string) =>
    oidc("/token", { ...who, refreshToken: token, grantType: "refresh_token" });
  assert.equal(
    (await refresh(other, refreshToken)).json!["error"],
    "invalid_grant",
  );
  const second = await refresh(client, refreshToken);
  assert.equal(second.status, 200);
  assert.notEqual(second.json!["refreshToken"], refreshToken);
  const replay = await refresh(client, refreshToken);
  assert.equal(replay.json!["error"], "invalid_grant");
  assert.equal(fixture.counts.replayedRefreshTokens, 1);
});

test("a client registered without a scope is issued no refresh token", async (t) => {
  const { fixture, advance, register, startDevice, poll } = await start(t);
  const client = await register({ scopes: [] });
  const device = await startDevice(client);
  fixture.approve(device.userCode);
  advance(6_000);
  const tokens = (await poll(client, device.deviceCode)).json!;
  assert.equal(tokens["refreshToken"], undefined);
});

async function signedIn(t: TestContext) {
  const env = await start(t);
  const client = await env.register();
  const device = await env.startDevice(client);
  env.fixture.approve(device.userCode);
  env.advance(6_000);
  const tokens = (await env.poll(client, device.deviceCode)).json!;
  const accessToken = tokens["accessToken"] as string;
  const refreshToken = tokens["refreshToken"] as string | undefined;
  const portal = (
    path: string,
    token: string | null = accessToken,
    method = "GET",
  ) =>
    fetch(`${env.fixture.portalOrigin}${path}`, {
      method,
      headers: token === null ? {} : { "x-amz-sso_bearer_token": token },
    });
  return { ...env, client, accessToken, refreshToken, portal };
}

test("Logout answers 401 for a session that is already over, and ends the access token only", async (t) => {
  const { fixture, oidc, client, portal, accessToken, refreshToken } =
    await signedIn(t);
  assert.ok(refreshToken, "the sign-in issued a refresh token");
  assert.equal((await portal("/logout", accessToken, "POST")).status, 200);
  assert.equal((await portal("/logout", accessToken, "POST")).status, 401);
  assert.equal(
    (await portal("/logout", "aws_dummy_unknown", "POST")).status,
    401,
  );
  assert.equal(fixture.counts.logout, 3);
  // assumed: the Logout page speaks of the sign-in session and of role
  // sessions, not of refresh tokens, so the double does not end one.
  const refreshed = await oidc("/token", {
    ...client,
    grantType: "refresh_token",
    refreshToken,
  });
  assert.equal(refreshed.status, 200);
});

test("the portal answers 401 without the documented header, with an unknown token and after the token lapsed", async (t) => {
  const { fixture, portal, accessToken } = await signedIn(t);
  assert.equal((await portal("/assignment/accounts", null)).status, 401);
  assert.equal(
    (await portal("/assignment/accounts", "aws_dummy_unknown")).status,
    401,
  );
  // A bearer header is not the portal's header.
  const bearer = await fetch(`${fixture.portalOrigin}/assignment/accounts`, {
    headers: { authorization: `Bearer ${accessToken}` },
  });
  assert.equal(bearer.status, 401);
  assert.equal((await portal("/assignment/accounts")).status, 200);
  fixture.expireAccessToken(accessToken);
  assert.equal((await portal("/assignment/accounts")).status, 401);
});

test("the portal pages within the documented range and refuses one outside it", async (t) => {
  const { portal } = await signedIn(t);
  const page = await portal("/assignment/accounts?max_result=2");
  const body = (await page.json()) as {
    accountList: unknown[];
    nextToken?: string;
  };
  assert.equal(body.accountList.length, 2);
  assert.ok(body.nextToken);
  const rest = await portal(
    `/assignment/accounts?max_result=2&next_token=${body.nextToken}`,
  );
  assert.equal(
    ((await rest.json()) as { accountList: unknown[] }).accountList.length,
    1,
  );
  assert.equal((await portal("/assignment/accounts?max_result=0")).status, 400);
  assert.equal(
    (await portal("/assignment/accounts?max_result=101")).status,
    400,
  );
});

test("a role the account does not hold, or an account the person does not hold, is 404", async (t) => {
  const { fixture, portal } = await signedIn(t);
  assert.equal(
    (
      await portal(
        "/federation/credentials?account_id=111122223333&role_name=NotMine",
      )
    ).status,
    404,
  );
  assert.equal(
    (
      await portal(
        "/federation/credentials?account_id=999900001111&role_name=ReadOnlyAccess",
      )
    ).status,
    404,
  );
  assert.equal(
    (await portal("/assignment/roles?account_id=999900001111")).status,
    404,
  );
  assert.equal((await portal("/assignment/roles")).status, 400);
  assert.equal(
    (await portal("/federation/credentials?account_id=111122223333")).status,
    400,
  );
  assert.equal(fixture.issued.roleCredentials.length, 0);
});

test("Logout ends the sign-in session and leaves role credentials already issued running", async (t) => {
  const { fixture, portal, accessToken } = await signedIn(t);
  const issued = await portal(
    "/federation/credentials?account_id=111122223333&role_name=ReadOnlyAccess",
  );
  assert.equal(issued.status, 200);
  const credentials = (
    (await issued.json()) as {
      roleCredentials: { accessKeyId: string; expiration: number };
    }
  ).roleCredentials;
  assert.equal((await portal("/logout", accessToken, "POST")).status, 200);
  assert.equal((await portal("/assignment/accounts")).status, 401);
  assert.equal(
    (
      await portal(
        "/federation/credentials?account_id=111122223333&role_name=ReadOnlyAccess",
      )
    ).status,
    401,
  );
  // The Logout reference: IAM role sessions "continue based on the duration".
  assert.equal(fixture.roleSessionValid(credentials.accessKeyId), true);
});
