import { createHash, randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { generateKeyPair, SignJWT } from "jose";
import { startHttpFixture, type RecordedRequest } from "./http-fixture.js";

/*
 * An independent Vercel account sign-in double: the OAuth authorization
 * server and the REST API behind a person's Vercel login, on two loopback
 * origins that share one state, laid out as Vercel's are (the issuer's own
 * origin serves discovery and the page a person approves on; the API origin
 * serves the endpoints the discovery document points at).
 *
 * Written from Vercel's published pages and discovery document, retrieved
 * 2026-10-12, and from nothing in `src/server/connectors/providers`, so a test
 * that passes here is two implementations agreeing on the wire.
 *
 * READ from those sources (and asserted on every request):
 *   - the discovery document, served as retrieved with only its two origins
 *     replaced (tests/connectors/fixtures/vercel/openid-configuration.json):
 *     the issuer, the device, token, revocation and registration endpoints on
 *     the API origin, the grants and the scopes openid, email, profile and
 *     offline_access;
 *   - "New Vercel CLI login flow": `vercel login` runs the OAuth 2.0 device
 *     flow (RFC 8628);
 *   - Sign in with Vercel, tokens: an access token (`vca_`) lasts one hour, a
 *     refresh token (`vcr_`) 30 days, single use and rotated on exchange, and
 *     a refresh token is issued when offline_access was granted;
 *   - Sign in with Vercel, manage page: client authentication `none` exists
 *     for CLIs and carries no secret;
 *   - the REST reference: GET /v2/user answers {user}; GET /v2/teams takes
 *     limit, since and until and answers {teams, pagination}; the generic
 *     error envelope {error: {code, message}}.
 *
 * ASSUMED, because the pages do not say (each marked `assumed:` below):
 *   - the device endpoint's request is form-encoded client_id and scope, and
 *     its answer carries the RFC 8628 members with the verification page at
 *     the issuer's /oauth/device;
 *   - the token endpoint enforces the interval as RFC 8628 section 3.5 says:
 *     a poll sooner than the interval is slow_down and the interval grows by
 *     five seconds; a device code that was never issued, was issued to
 *     another client or was already redeemed is invalid_grant;
 *   - a refresh token presented by a client other than the one it was issued
 *     to, or one already used, is invalid_grant;
 *   - a client of authentication `none` is any registered client id;
 *   - the revocation endpoint answers 200 for any token (RFC 7009), takes a
 *     `none` client's client_id with the token and its hint and nothing that
 *     authenticates the client, and ends only the token it is given;
 *   - a team list pages by `until`: `pagination.next` is the createdAt of the
 *     last team returned minus one, and `until` is inclusive;
 *   - an access token whose person revoked the app, or that lapsed, is 401.
 *
 * Everything it issues is a dummy value shaped like the real thing, and every
 * secret it issues is recorded in `issued` so a test can sweep for it.
 */

const DEVICE_GRANT = "urn:ietf:params:oauth:grant-type:device_code";

export type PersonSeed = {
  id: string;
  username: string;
  name?: string;
  email?: string;
  teams: Array<{ id: string; slug: string; name?: string; createdAt: number }>;
};

export type VercelAccountOptions = {
  now?: () => number;
  people?: PersonSeed[];
  /** Registered client ids; every one authenticates with `none`. */
  clientIds?: string[];
  deviceExpiresInSeconds?: number;
  intervalSeconds?: number;
  /** The shortest gap between polls accepted when it is longer than advertised. */
  enforcedIntervalSeconds?: number;
  /** Leave `expires_in` out of token responses, as an authorization server may. */
  omitExpiresIn?: boolean;
  /** Leave `revocation_endpoint` out of the discovery document, as an issuer that has none would. */
  omitRevocationEndpoint?: boolean;
  /** Answer slow_down to the first n polls whatever their spacing (assumed: a server under load asks a client to back off). */
  slowDownFirst?: number;
  accessTokenLifetimeSeconds?: number;
  rotateRefreshTokens?: boolean;
  /** Teams per page when a request names no limit. */
  pageSize?: number;
  /** The most teams a page holds whatever `limit` asks (assumed: a server may return fewer). */
  pageCap?: number;
  /** Put this text in every error description and message, to prove none of it travels. */
  errorWords?: string;
  /** Advertise this verification page instead of the double's own. */
  verificationBase?: string;
};

type Device = {
  clientId: string;
  userCode: string;
  scope: string;
  expiresAt: number;
  intervalSeconds: number;
  lastPollAt?: number;
  state: "pending" | "approved" | "denied";
  personId?: string;
  redeemed: boolean;
};

type Access = {
  clientId: string;
  personId: string;
  expiresAt: number;
  revoked: boolean;
};
type Refresh = {
  clientId: string;
  personId: string;
  scope: string;
  used: boolean;
  revoked: boolean;
};

const hex = (bytes: number) => randomBytes(bytes).toString("hex");
const discoveryTemplate = readFileSync(
  new URL("../fixtures/vercel/openid-configuration.json", import.meta.url),
  "utf8",
);

export async function startVercelAccount(options: VercelAccountOptions = {}) {
  const now = options.now ?? Date.now;
  const deviceExpiresIn = options.deviceExpiresInSeconds ?? 600;
  const baseInterval = options.intervalSeconds ?? 5;
  const accessLifetime = options.accessTokenLifetimeSeconds ?? 3600;
  const rotate = options.rotateRefreshTokens ?? true;
  let slowDownLeft = options.slowDownFirst ?? 0;
  const pageSize = options.pageSize ?? 100;
  const clientIds = new Set(options.clientIds ?? ["dummy-vercel-client"]);
  const people = new Map<string, PersonSeed>();
  for (const person of options.people ?? [])
    people.set(person.id, structuredClone(person));

  const devices = new Map<string, Device>();
  const devicesByUserCode = new Map<string, string>();
  const accessTokens = new Map<string, Access>();
  const refreshTokens = new Map<string, Refresh>();
  const violations: string[] = [];
  const counts = {
    device: 0,
    token: 0,
    refresh: 0,
    revoke: 0,
    user: 0,
    teams: 0,
    tooFastPolls: 0,
    replayedDeviceCodes: 0,
    replayedRefreshTokens: 0,
    foreignRefreshTokens: 0,
  };
  const issued = {
    deviceCodes: [] as string[],
    accessTokens: [] as string[],
    refreshTokens: [] as string[],
    idTokens: [] as string[],
  };
  const revocations: Array<{ token: string; hint: string | null }> = [];
  const note = (message: string) => violations.push(message);
  const withoutRevocation = (document: Record<string, unknown>) => {
    if (options.omitRevocationEndpoint) delete document["revocation_endpoint"];
    return document;
  };
  const signing = await generateKeyPair("RS256");

  const reply = (status: number, body?: unknown) => ({
    status,
    headers: { connection: "close", "cache-control": "no-store" },
    ...(body === undefined ? {} : { body: body as Record<string, unknown> }),
  });
  const oauthError = (status: number, error: string, description = error) =>
    reply(status, {
      error,
      error_description: options.errorWords ?? description,
    });
  // The generic REST error envelope.
  const restError = (status: number, code: string, message: string) =>
    reply(status, { error: { code, message: options.errorWords ?? message } });

  /** The form body of an OAuth request, noting any deviation the references rule out. */
  function form(request: RecordedRequest) {
    if (
      !/^application\/x-www-form-urlencoded/i.test(
        request.headers["content-type"] ?? "",
      )
    )
      note(`${request.url.pathname}: content-type is not form-encoded`);
    if (request.url.search) note(`${request.url.pathname}: unexpected query`);
    const values = new URLSearchParams(request.body.toString("utf8"));
    // A client of authentication `none` sends its id and nothing that
    // authenticates it.
    if (values.has("client_secret") || values.has("client_assertion"))
      note(`${request.url.pathname}: a none client sent a secret`);
    if (/^basic /i.test(request.headers["authorization"] ?? ""))
      note(`${request.url.pathname}: a none client sent Basic credentials`);
    return values;
  }

  // ----------------------------------------------------- the authorization server

  const startDevice = (request: RecordedRequest) => {
    counts.device++;
    const values = form(request);
    const clientId = values.get("client_id") ?? "";
    if (!clientIds.has(clientId)) return oauthError(401, "invalid_client");
    const scope = values.get("scope") ?? "";
    // assumed: scopes outside the discovery document's list are invalid_scope
    const known = ["openid", "email", "profile", "offline_access"];
    if (scope.split(" ").some((item) => item && !known.includes(item)))
      return oauthError(400, "invalid_scope");
    const deviceCode = `vcdev_dummy_${hex(16)}`;
    const userCode = `${hex(2).toUpperCase()}-${hex(2).toUpperCase()}`;
    devices.set(deviceCode, {
      clientId,
      userCode,
      scope,
      expiresAt: now() + deviceExpiresIn * 1000,
      intervalSeconds: options.enforcedIntervalSeconds ?? baseInterval,
      state: "pending",
      redeemed: false,
    });
    devicesByUserCode.set(userCode, deviceCode);
    issued.deviceCodes.push(deviceCode);
    const base = options.verificationBase ?? issuer.origin;
    return reply(200, {
      device_code: deviceCode,
      user_code: userCode,
      verification_uri: `${base}/oauth/device`,
      verification_uri_complete: `${base}/oauth/device?user_code=${userCode}`,
      expires_in: deviceExpiresIn,
      interval: baseInterval,
    });
  };

  /** What token_type the endpoint reports; see `answerTokensAs`. */
  let tokenType = "Bearer";
  const mintTokens = async (
    clientId: string,
    personId: string,
    scope: string,
  ) => {
    const accessToken = `vca_dummy_${hex(24)}`;
    accessTokens.set(accessToken, {
      clientId,
      personId,
      expiresAt: now() + accessLifetime * 1000,
      revoked: false,
    });
    issued.accessTokens.push(accessToken);
    const body: Record<string, unknown> = {
      access_token: accessToken,
      token_type: tokenType,
      ...(options.omitExpiresIn ? {} : { expires_in: accessLifetime }),
      scope,
    };
    // read: a refresh token is issued when offline_access was granted
    if (scope.split(" ").includes("offline_access")) {
      const refreshToken = `vcr_dummy_${hex(24)}`;
      refreshTokens.set(refreshToken, {
        clientId,
        personId,
        scope,
        used: false,
        revoked: false,
      });
      issued.refreshTokens.push(refreshToken);
      body["refresh_token"] = refreshToken;
    }
    if (scope.split(" ").includes("openid")) {
      const idToken = await new SignJWT({})
        .setProtectedHeader({ alg: "RS256", kid: "dummy-key" })
        .setIssuer(issuer.origin)
        .setAudience(clientId)
        .setSubject(personId)
        // The ID token is checked by the client library against the wall clock,
        // which the tests' own clock does not move: dating it by that clock
        // makes every test that signs in fail an hour after the clock's origin.
        .setIssuedAt(Math.floor(Date.now() / 1000))
        .setExpirationTime(Math.floor(Date.now() / 1000) + accessLifetime)
        .sign(signing.privateKey);
      issued.idTokens.push(idToken);
      body["id_token"] = idToken;
    }
    return body;
  };

  const deviceGrant = async (clientId: string, values: URLSearchParams) => {
    const device = devices.get(values.get("device_code") ?? "");
    // assumed: never issued, or issued to another client, is invalid_grant
    if (!device || device.clientId !== clientId)
      return oauthError(400, "invalid_grant");
    if (device.redeemed) {
      counts.replayedDeviceCodes++;
      return oauthError(400, "invalid_grant");
    }
    if (device.expiresAt <= now()) return oauthError(400, "expired_token");
    const sooner =
      device.lastPollAt !== undefined &&
      now() - device.lastPollAt < device.intervalSeconds * 1000;
    device.lastPollAt = now();
    if (sooner || slowDownLeft > 0) {
      if (sooner) counts.tooFastPolls++;
      else slowDownLeft--;
      device.intervalSeconds += 5;
      return oauthError(400, "slow_down");
    }
    if (device.state === "denied") return oauthError(400, "access_denied");
    if (device.state === "pending")
      return oauthError(400, "authorization_pending");
    device.redeemed = true;
    return reply(
      200,
      await mintTokens(clientId, device.personId!, device.scope),
    );
  };

  /** Set by `refuseRefreshesWith`: every refresh grant is answered with this OAuth error. */
  let refreshRefusal: string | undefined;
  const refreshGrant = async (clientId: string, values: URLSearchParams) => {
    counts.refresh++;
    if (refreshRefusal !== undefined) return oauthError(400, refreshRefusal);
    const held = refreshTokens.get(values.get("refresh_token") ?? "");
    if (!held) return oauthError(400, "invalid_grant");
    // assumed: a refresh token presented by another client is invalid_grant
    if (held.clientId !== clientId) {
      counts.foreignRefreshTokens++;
      return oauthError(400, "invalid_grant");
    }
    if (held.used || held.revoked) {
      counts.replayedRefreshTokens++;
      return oauthError(400, "invalid_grant");
    }
    if (rotate) held.used = true;
    return reply(200, await mintTokens(clientId, held.personId, held.scope));
  };

  let dropToken = false;
  let tokenStatus: number | undefined;
  /** Set by `failRevocation`: the revocation endpoint answers a status, never answers, or drops the connection. */
  let revokeFault: number | "hang" | "drop" | undefined;
  const token = async (request: RecordedRequest) => {
    counts.token++;
    const values = form(request);
    const clientId = values.get("client_id") ?? "";
    if (!clientIds.has(clientId)) return oauthError(401, "invalid_client");
    const grant = values.get("grant_type");
    if (grant === DEVICE_GRANT) return deviceGrant(clientId, values);
    if (grant === "refresh_token") return refreshGrant(clientId, values);
    return oauthError(400, "unsupported_grant_type");
  };

  const revoke = (request: RecordedRequest) => {
    counts.revoke++;
    const values = form(request);
    const clientId = values.get("client_id") ?? "";
    if (!clientIds.has(clientId)) return oauthError(401, "invalid_client");
    const presented = values.get("token") ?? "";
    revocations.push({ token: presented, hint: values.get("token_type_hint") });
    const refresh = refreshTokens.get(presented);
    if (refresh?.clientId === clientId) refresh.revoked = true;
    const access = accessTokens.get(presented);
    if (access?.clientId === clientId) access.revoked = true;
    // read (RFC 7009): 200 whether or not the token was known
    return reply(200, {});
  };

  // ------------------------------------------------------------- the REST API

  const bearer = (request: RecordedRequest) => {
    const match = /^Bearer (\S+)$/.exec(request.headers["authorization"] ?? "");
    const entry = match ? accessTokens.get(match[1]!) : undefined;
    if (!entry || entry.revoked || entry.expiresAt <= now()) return undefined;
    return entry;
  };

  /** Set by `failRest`: every REST call answers this status without acting on the request. */
  let restStatus: number | undefined;
  const rest = (request: RecordedRequest) => {
    if (restStatus !== undefined)
      return restError(restStatus, "unavailable", "Unavailable");
    const session = bearer(request);
    if (request.method !== "GET")
      return restError(405, "method_not_allowed", "Method not allowed");
    if (request.url.pathname === "/v2/user") {
      counts.user++;
      if (!session) return restError(401, "forbidden", "Not authorized");
      const person = people.get(session.personId)!;
      return reply(200, {
        user: {
          id: person.id,
          username: person.username,
          ...(person.name ? { name: person.name } : {}),
          ...(person.email ? { email: person.email } : {}),
          defaultTeamId: person.teams[0]?.id ?? null,
        },
      });
    }
    if (request.url.pathname === "/v2/teams") {
      counts.teams++;
      if (!session) return restError(401, "forbidden", "Not authorized");
      const limitText = request.url.searchParams.get("limit");
      const limit = limitText === null ? pageSize : Number(limitText);
      if (!Number.isInteger(limit) || limit < 1 || limit > 100)
        return restError(400, "bad_request", "Invalid limit");
      const untilText = request.url.searchParams.get("until");
      const until = untilText === null ? Infinity : Number(untilText);
      if (Number.isNaN(until))
        return restError(400, "bad_request", "Invalid until");
      const all = [...(people.get(session.personId)?.teams ?? [])]
        .sort((a, b) => b.createdAt - a.createdAt)
        .filter((team) => team.createdAt <= until);
      const slice = all.slice(0, Math.min(limit, options.pageCap ?? limit));
      const last = slice.at(-1);
      return reply(200, {
        teams: slice.map((team) => ({
          id: team.id,
          slug: team.slug,
          ...(team.name ? { name: team.name } : {}),
          createdAt: team.createdAt,
        })),
        pagination: {
          count: slice.length,
          next:
            all.length > slice.length && last !== undefined
              ? last.createdAt - 1
              : null,
          prev: null,
        },
      });
    }
    return restError(404, "not_found", "Could not find the endpoint");
  };

  // ------------------------------------------------- the person's own pages

  const page = (title: string, body: string, status = 200) => ({
    status,
    headers: { "content-type": "text/html; charset=utf-8" },
    body: `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${title}</title></head><body><main>${body}</main></body></html>`,
  });
  const decision = (userCode: string, verb: string, label: string) =>
    `<form method="post" action="/oauth/device/decision"><input type="hidden" name="user_code" value="${userCode}"><input type="hidden" name="decision" value="${verb}"><button type="submit">${label}</button></form>`;

  const approve = (userCode: string, personId?: string) => {
    const code = devicesByUserCode.get(userCode.toUpperCase());
    const device = code ? devices.get(code) : undefined;
    if (!device || device.expiresAt <= now() || device.state !== "pending")
      return false;
    const chosen = personId ?? [...people.keys()][0];
    if (chosen === undefined || !people.has(chosen)) return false;
    device.state = "approved";
    device.personId = chosen;
    return true;
  };
  const deny = (userCode: string) => {
    const code = devicesByUserCode.get(userCode.toUpperCase());
    const device = code ? devices.get(code) : undefined;
    if (!device || device.expiresAt <= now() || device.state !== "pending")
      return false;
    device.state = "denied";
    return true;
  };

  const personPages = (request: RecordedRequest) => {
    const path = request.url.pathname;
    if (request.method === "GET" && path === "/oauth/device")
      return page(
        "Log in to Vercel",
        `<h1>Log in to Vercel</h1><form method="post" action="/oauth/device"><label for="user_code">Device code</label><input id="user_code" name="user_code" autocomplete="off" placeholder="ABCD-EFGH"><button type="submit">Continue</button></form>`,
      );
    if (request.method === "POST" && path === "/oauth/device") {
      const userCode = (
        new URLSearchParams(request.body.toString("utf8")).get("user_code") ??
        ""
      )
        .trim()
        .toUpperCase();
      const code = devicesByUserCode.get(userCode);
      const device = code ? devices.get(code) : undefined;
      if (!device || device.expiresAt <= now() || device.state !== "pending")
        return page("Code not recognised", "<h1>Code not recognised</h1>", 400);
      return page(
        "Authorize",
        `<h1>Authorize this device to use your Vercel account?</h1><p>Code ${userCode}</p>${decision(userCode, "allow", "Authorize")}${decision(userCode, "deny", "Deny")}`,
      );
    }
    if (request.method === "POST" && path === "/oauth/device/decision") {
      const values = new URLSearchParams(request.body.toString("utf8"));
      const userCode = (values.get("user_code") ?? "").toUpperCase();
      const done =
        values.get("decision") === "allow" ? approve(userCode) : deny(userCode);
      return done
        ? page("Done", "<h1>You can close this window</h1>")
        : page("Code not recognised", "<h1>Code not recognised</h1>", 400);
    }
    return undefined;
  };

  // ----------------------------------------------------------- the servers

  const issuer = await startHttpFixture((request) => {
    if (
      request.method === "GET" &&
      request.url.pathname === "/.well-known/openid-configuration"
    )
      return reply(
        200,
        withoutRevocation(
          JSON.parse(
            discoveryTemplate
              .replaceAll("https://api.vercel.com", api.origin)
              .replaceAll("https://vercel.com", issuer.origin),
          ),
        ),
      );
    return personPages(request);
  });
  const api = await startHttpFixture(async (raw, rawIo) => {
    const path = raw.url.pathname;
    if (raw.method === "POST" && path === "/login/oauth/device-authorization")
      return startDevice(raw);
    if (raw.method === "POST" && path === "/login/oauth/token") {
      if (tokenStatus !== undefined) {
        counts.token++;
        return oauthError(tokenStatus, "server_error");
      }
      const answer = await token(raw);
      if (dropToken && answer.status === 200) {
        dropToken = false;
        rawIo.res.destroy();
        return undefined;
      }
      return answer;
    }
    if (raw.method === "POST" && path === "/login/oauth/token/revoke") {
      if (revokeFault === "hang") {
        counts.revoke++;
        return new Promise<undefined>(() => {});
      }
      if (revokeFault === "drop") {
        counts.revoke++;
        rawIo.res.destroy();
        return undefined;
      }
      if (revokeFault !== undefined) {
        counts.revoke++;
        return oauthError(revokeFault, "server_error");
      }
      return revoke(raw);
    }
    return rest(raw);
  });

  return {
    issuerOrigin: issuer.origin,
    apiOrigin: api.origin,
    counts,
    violations,
    issued,
    revocations,
    apiRequests: api.requests,
    issuerRequests: issuer.requests,
    /** The approving person's side, as the verification page does it. */
    approve,
    deny,
    userCodes: () => [...devicesByUserCode.keys()],
    /** The token endpoint answers this status (a 5xx) without acting on the request; null restores it. */
    /** Every refresh grant is answered with this OAuth error from now on (documented for a team-restricted application); null restores it. */
    refuseRefreshesWith(error: string | null) {
      refreshRefusal = error ?? undefined;
    },
    /** The token endpoint reports this token_type from now on (a type the client does not support, to prove its answer is not echoed). */
    answerTokensAs(type: string) {
      tokenType = type;
    },
    failTokens(status: number | null) {
      tokenStatus = status ?? undefined;
    },
    /**
     * The revocation endpoint answers this status without acting on the
     * request, never answers (`"hang"`), or drops the connection (`"drop"`);
     * null restores it.
     */
    failRevocation(fault: number | "hang" | "drop" | null) {
      revokeFault = fault ?? undefined;
    },
    /** The next successful token response is acted on, and its answer never arrives. */
    dropNextTokenResponse() {
      dropToken = true;
    },
    /** Every REST call answers this status (a 5xx, or a 401) without acting on it; null restores it. */
    failRest(status: number | null) {
      restStatus = status ?? undefined;
    },
    /** Stops listening on the issuer's origin, so discovery fails. */
    stopIssuer: () => issuer.close(),
    /** Stops listening on the API origin, so a request fails before it is sent. */
    stopApi: () => api.close(),
    expireDevice(userCode: string) {
      const code = devicesByUserCode.get(userCode.toUpperCase());
      const device = code ? devices.get(code) : undefined;
      if (device) device.expiresAt = now() - 1;
    },
    expireAccessToken(accessToken: string) {
      const entry = accessTokens.get(accessToken);
      if (entry) entry.expiresAt = now() - 1;
    },
    /** The person removes the app in their dashboard: every token of theirs stops working. */
    revokeApp(personId: string) {
      for (const entry of accessTokens.values())
        if (entry.personId === personId) entry.revoked = true;
      for (const entry of refreshTokens.values())
        if (entry.personId === personId) entry.revoked = true;
    },
    leaveTeam(personId: string, teamId: string) {
      const person = people.get(personId);
      if (person) person.teams = person.teams.filter((t) => t.id !== teamId);
    },
    addTeam(personId: string, team: PersonSeed["teams"][number]) {
      people.get(personId)?.teams.push(team);
    },
    accessTokenValid(accessToken: string) {
      const entry = accessTokens.get(accessToken);
      return entry !== undefined && !entry.revoked && entry.expiresAt > now();
    },
    refreshTokenUsable(refreshToken: string) {
      const entry = refreshTokens.get(refreshToken);
      return entry !== undefined && !entry.used && !entry.revoked;
    },
    digest: (value: string) => createHash("sha256").update(value).digest("hex"),
    async close() {
      await api.close().catch(() => {});
      await issuer.close().catch(() => {});
    },
  };
}
export type VercelAccountFixture = Awaited<
  ReturnType<typeof startVercelAccount>
>;
