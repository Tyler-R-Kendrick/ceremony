import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test, { type TestContext } from "node:test";
import {
  startVercelAccount,
  type VercelAccountOptions,
} from "../doubles/vercel-account.js";
import { alice, CLIENT_ID, START_TIME } from "./harness.js";

/*
 * The double refuses what Vercel's published pages say it must, and what the
 * recorded assumptions say it does. A double that accepted anything would let
 * every adapter test pass for the wrong reason, so each refusal the adapter
 * relies on is pinned here against the wire, with no adapter code in the way.
 */

const DEVICE_GRANT = "urn:ietf:params:oauth:grant-type:device_code";

async function start(t: TestContext, options: VercelAccountOptions = {}) {
  let clock = START_TIME;
  const fixture = await startVercelAccount({
    people: [structuredClone(alice)],
    clientIds: [CLIENT_ID, "second-client"],
    now: () => clock,
    ...options,
  });
  t.after(() => fixture.close());
  const advance = (ms: number) => {
    clock += ms;
  };
  const form = async (
    path: string,
    values: Record<string, string>,
    headers: Record<string, string> = {},
  ) => {
    const response = await fetch(`${fixture.apiOrigin}${path}`, {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        ...headers,
      },
      body: new URLSearchParams(values),
    });
    return {
      status: response.status,
      json: (await response.json().catch(() => undefined)) as
        Record<string, unknown> | undefined,
    };
  };
  const startDevice = async (
    clientId = CLIENT_ID,
    scope = "openid offline_access",
  ) => {
    const started = await form("/login/oauth/device-authorization", {
      client_id: clientId,
      scope,
    });
    assert.equal(started.status, 200);
    return started.json as {
      device_code: string;
      user_code: string;
      interval: number;
    };
  };
  const poll = (deviceCode: string, clientId = CLIENT_ID) =>
    form("/login/oauth/token", {
      grant_type: DEVICE_GRANT,
      client_id: clientId,
      device_code: deviceCode,
    });
  const refresh = (refreshToken: string, clientId = CLIENT_ID) =>
    form("/login/oauth/token", {
      grant_type: "refresh_token",
      client_id: clientId,
      refresh_token: refreshToken,
    });
  const api = async (path: string, token?: string) => {
    const response = await fetch(`${fixture.apiOrigin}${path}`, {
      headers: token ? { authorization: `Bearer ${token}` } : {},
    });
    return {
      status: response.status,
      json: (await response.json().catch(() => undefined)) as
        Record<string, unknown> | undefined,
    };
  };
  /** A device code approved and redeemed: the tokens a person's sign-in yields. */
  const signedIn = async (scope = "openid offline_access") => {
    const device = await startDevice(CLIENT_ID, scope);
    assert.ok(fixture.approve(device.user_code));
    advance(6_000);
    const done = await poll(device.device_code);
    assert.equal(done.status, 200);
    return done.json as {
      access_token: string;
      refresh_token?: string;
      id_token?: string;
      expires_in: number;
      scope: string;
    };
  };
  return { fixture, advance, form, startDevice, poll, refresh, api, signedIn };
}

test("discovery is the recorded document with only its two origins replaced", async (t) => {
  const { fixture } = await start(t);
  const served = (await (
    await fetch(`${fixture.issuerOrigin}/.well-known/openid-configuration`)
  ).json()) as Record<string, unknown>;
  const recorded = JSON.parse(
    readFileSync(
      new URL("../fixtures/vercel/openid-configuration.json", import.meta.url),
      "utf8",
    )
      .replaceAll("https://api.vercel.com", fixture.apiOrigin)
      .replaceAll("https://vercel.com", fixture.issuerOrigin),
  ) as Record<string, unknown>;
  assert.deepEqual(served, recorded);
  assert.equal(served["issuer"], fixture.issuerOrigin);
  assert.equal(
    served["device_authorization_endpoint"],
    `${fixture.apiOrigin}/login/oauth/device-authorization`,
  );
});

test("the device endpoint answers the RFC 8628 members, and refuses an unknown client and an unknown scope", async (t) => {
  const { fixture, form, startDevice } = await start(t);
  const device = await startDevice();
  assert.match(device.device_code, /^vcdev_dummy_/);
  assert.match(device.user_code, /^[0-9A-F]{4}-[0-9A-F]{4}$/);
  assert.equal(device.interval, 5);
  assert.deepEqual(
    (
      await form("/login/oauth/device-authorization", {
        client_id: "nobody",
        scope: "openid",
      })
    ).json?.["error"],
    "invalid_client",
  );
  assert.deepEqual(
    (
      await form("/login/oauth/device-authorization", {
        client_id: CLIENT_ID,
        scope: "openid admin",
      })
    ).json?.["error"],
    "invalid_scope",
  );
  assert.deepEqual(fixture.violations, []);
});

test("a none client that sends a secret is a violation the double records", async (t) => {
  const { fixture, form } = await start(t);
  await form("/login/oauth/device-authorization", {
    client_id: CLIENT_ID,
    client_secret: "dummy-secret",
  });
  await form(
    "/login/oauth/device-authorization",
    { client_id: CLIENT_ID },
    { authorization: "Basic ZHVtbXk6ZHVtbXk=" },
  );
  assert.equal(fixture.violations.length, 2);
});

test("a device code that was never issued, or was issued to another client, is invalid_grant", async (t) => {
  const { poll, startDevice } = await start(t);
  const device = await startDevice();
  assert.equal(
    (await poll("vcdev_dummy_not_issued")).json?.["error"],
    "invalid_grant",
  );
  assert.equal(
    (await poll(device.device_code, "second-client")).json?.["error"],
    "invalid_grant",
  );
});

test("polling faster than the interval is slow_down, and the interval grows by five seconds each time", async (t) => {
  const { fixture, advance, poll, startDevice } = await start(t);
  const device = await startDevice();
  assert.equal(
    (await poll(device.device_code)).json?.["error"],
    "authorization_pending",
  );
  advance(1_000);
  assert.equal((await poll(device.device_code)).json?.["error"], "slow_down");
  advance(6_000);
  assert.equal(
    (await poll(device.device_code)).json?.["error"],
    "slow_down",
    "ten seconds were not yet up",
  );
  advance(16_000);
  assert.equal(
    (await poll(device.device_code)).json?.["error"],
    "authorization_pending",
  );
  assert.equal(fixture.counts.tooFastPolls, 2);
});

test("a denied approval is access_denied and an expired code is expired_token", async (t) => {
  const { fixture, advance, poll, startDevice } = await start(t);
  const denied = await startDevice();
  assert.ok(fixture.deny(denied.user_code));
  advance(6_000);
  assert.equal(
    (await poll(denied.device_code)).json?.["error"],
    "access_denied",
  );
  const lapsed = await startDevice();
  fixture.expireDevice(lapsed.user_code);
  assert.equal(
    (await poll(lapsed.device_code)).json?.["error"],
    "expired_token",
  );
  // An expired code cannot be approved afterwards.
  assert.equal(fixture.approve(lapsed.user_code), false);
});

test("an approved device code is redeemed once; a replay is invalid_grant", async (t) => {
  const { fixture, advance, poll, startDevice } = await start(t);
  const device = await startDevice();
  fixture.approve(device.user_code);
  advance(6_000);
  assert.equal((await poll(device.device_code)).status, 200);
  advance(6_000);
  assert.equal(
    (await poll(device.device_code)).json?.["error"],
    "invalid_grant",
  );
  assert.equal(fixture.counts.replayedDeviceCodes, 1);
});

test("the token response is shaped as the tokens page says: vca_ for an hour, vcr_ with offline_access, an ID token with openid", async (t) => {
  const { signedIn } = await start(t);
  const tokens = await signedIn();
  assert.match(tokens.access_token, /^vca_/);
  assert.match(tokens.refresh_token!, /^vcr_/);
  assert.equal(tokens.expires_in, 3600);
  assert.equal(tokens.scope, "openid offline_access");
  assert.equal(tokens.id_token!.split(".").length, 3);
  const bare = await signedIn("email");
  assert.equal(
    bare.refresh_token,
    undefined,
    "no offline_access, no refresh token",
  );
  assert.equal(bare.id_token, undefined, "no openid, no ID token");
});

test("a refresh token rotates, is refused when replayed, and belongs to one client", async (t) => {
  const { fixture, refresh, signedIn } = await start(t);
  const first = await signedIn();
  const foreign = await refresh(first.refresh_token!, "second-client");
  assert.equal(foreign.json?.["error"], "invalid_grant");
  assert.equal(fixture.counts.foreignRefreshTokens, 1);
  const second = await refresh(first.refresh_token!);
  assert.equal(second.status, 200);
  const rotated = second.json as {
    refresh_token: string;
    access_token: string;
  };
  assert.notEqual(rotated.refresh_token, first.refresh_token);
  assert.equal(
    (await refresh(first.refresh_token!)).json?.["error"],
    "invalid_grant",
  );
  assert.equal(fixture.counts.replayedRefreshTokens, 1);
  assert.equal((await refresh(rotated.refresh_token)).status, 200);
});

test("the token endpoint refuses an unsupported grant and an unknown client", async (t) => {
  const { form } = await start(t);
  assert.equal(
    (
      await form("/login/oauth/token", {
        grant_type: "password",
        client_id: CLIENT_ID,
      })
    ).json?.["error"],
    "unsupported_grant_type",
  );
  assert.equal(
    (
      await form("/login/oauth/token", {
        grant_type: "refresh_token",
        client_id: "nobody",
      })
    ).status,
    401,
  );
});

test("revocation answers 200 for any token and ends only the client's own", async (t) => {
  const { fixture, form, signedIn } = await start(t);
  const tokens = await signedIn();
  assert.equal(
    (
      await form("/login/oauth/token/revoke", {
        client_id: CLIENT_ID,
        token: "vca_dummy_unknown",
      })
    ).status,
    200,
  );
  // Another client cannot revoke this one's token.
  await form("/login/oauth/token/revoke", {
    client_id: "second-client",
    token: tokens.access_token,
  });
  assert.equal(fixture.accessTokenValid(tokens.access_token), true);
  await form("/login/oauth/token/revoke", {
    client_id: CLIENT_ID,
    token: tokens.access_token,
    token_type_hint: "access_token",
  });
  assert.equal(fixture.accessTokenValid(tokens.access_token), false);
});

test("the REST API answers 401 without a token, with an unknown one, after it lapsed and after the app was removed", async (t) => {
  const { fixture, advance, api, signedIn } = await start(t);
  const tokens = await signedIn();
  assert.equal((await api("/v2/user")).status, 401);
  assert.equal((await api("/v2/user", "vca_dummy_unknown")).status, 401);
  assert.equal((await api("/v2/user", tokens.access_token)).status, 200);
  advance(3_600_000);
  assert.equal((await api("/v2/user", tokens.access_token)).status, 401);
  const again = await signedIn();
  fixture.revokeApp(alice.id);
  const removed = await api("/v2/user", again.access_token);
  assert.equal(removed.status, 401);
  assert.deepEqual(removed.json, {
    error: { code: "forbidden", message: "Not authorized" },
  });
});

test("GET /v2/teams pages with limit and until, newest first, and refuses what the reference rules out", async (t) => {
  const { api, signedIn } = await start(t);
  const { access_token } = await signedIn();
  const first = await api("/v2/teams?limit=2", access_token);
  const body = first.json as {
    teams: Array<{ slug: string }>;
    pagination: { count: number; next: number | null };
  };
  assert.deepEqual(
    body.teams.map((team) => team.slug),
    ["elsewhere", "labs"],
  );
  assert.equal(body.pagination.count, 2);
  const second = await api(
    `/v2/teams?limit=2&until=${body.pagination.next}`,
    access_token,
  );
  const rest = second.json as {
    teams: Array<{ slug: string }>;
    pagination: { next: number | null };
  };
  assert.deepEqual(
    rest.teams.map((team) => team.slug),
    ["acme"],
  );
  assert.equal(rest.pagination.next, null);
  assert.equal((await api("/v2/teams?limit=0", access_token)).status, 400);
  assert.equal((await api("/v2/teams?limit=101", access_token)).status, 400);
  assert.equal((await api("/v2/teams?until=soon", access_token)).status, 400);
});

test("GET /v2/user answers the user, and anything else is the generic not-found envelope", async (t) => {
  const { api, signedIn } = await start(t);
  const { access_token } = await signedIn();
  const user = (await api("/v2/user", access_token)).json as {
    user: Record<string, unknown>;
  };
  assert.equal(user.user["id"], alice.id);
  assert.equal(user.user["username"], "alice");
  assert.equal(user.user["defaultTeamId"], "team_dummy_acme");
  const missing = await api("/v2/projects", access_token);
  assert.equal(missing.status, 404);
  assert.deepEqual(missing.json, {
    error: { code: "not_found", message: "Could not find the endpoint" },
  });
});

test("the verification page approves and denies a code a person types", async (t) => {
  const { fixture, startDevice } = await start(t);
  const device = await startDevice();
  const page = await fetch(`${fixture.issuerOrigin}/oauth/device`);
  assert.equal(page.status, 200);
  const confirm = await fetch(`${fixture.issuerOrigin}/oauth/device`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ user_code: device.user_code.toLowerCase() }),
  });
  assert.match(await confirm.text(), /Authorize this device/);
  const allow = await fetch(`${fixture.issuerOrigin}/oauth/device/decision`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      user_code: device.user_code,
      decision: "allow",
    }),
  });
  assert.equal(allow.status, 200);
  const unknown = await fetch(`${fixture.issuerOrigin}/oauth/device`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ user_code: "NOPE-NOPE" }),
  });
  assert.equal(unknown.status, 400);
});
