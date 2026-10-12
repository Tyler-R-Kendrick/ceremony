import { createHash, randomBytes } from "node:crypto";
import { startHttpFixture, type RecordedRequest } from "./http-fixture.js";

/*
 * An independent AWS IAM Identity Center double: the OIDC service and the
 * access portal, served on two loopback origins that share one state.
 *
 * Written from the published references, retrieved 2026-10-12, and from
 * nothing in `src/server/connectors/providers/aws-identity-center`, so a test
 * that passes here is two implementations agreeing on the wire:
 *
 *   OIDC API Reference    RegisterClient, StartDeviceAuthorization, CreateToken
 *   Portal API Reference  ListAccounts, ListAccountRoles, GetRoleCredentials,
 *                         Logout, and the RoleCredentials/AccountInfo/RoleInfo
 *                         data types
 *
 * What is READ from those pages (and asserted on every request): the methods,
 * paths and query names; JSON bodies with camelCase members; the required
 * members of each request; the OIDC error body `{error, error_description}`
 * with the registered codes and the documented status of each (400, 401 for
 * invalid_client, 500); `x-amz-sso_bearer_token` on every portal call; the
 * page size range 1 to 100; and that `clientType` must be `public`.
 *
 * What is ASSUMED, because the pages do not say (each marked `assumed:`):
 *   - the polling interval is enforced the way RFC 8628 section 3.5 says: a
 *     poll sooner than the interval is answered slow_down and the interval
 *     grows by five seconds;
 *   - a deviceCode that was never issued, was issued to another client, or
 *     was already redeemed is answered invalid_grant;
 *   - a refresh token is issued only to a client that registered the
 *     refresh_token grant and a scope, and rotates on every use;
 *   - an account or role the person does not hold is answered 404;
 *   - a portal call with a token that is unknown, expired, issued to a person
 *     whose session was ended, or logged out is answered 401;
 *   - RoleCredentials.expiration is epoch milliseconds and
 *     clientSecretExpiresAt is epoch seconds;
 *   - role credentials already issued survive Logout until their expiration
 *     (the Logout page says the IAM role sessions continue).
 *
 * Everything it issues is a dummy value shaped like the real thing, and every
 * secret it issues is recorded in `issued` so a test can sweep for it.
 */

const DEVICE_GRANT = "urn:ietf:params:oauth:grant-type:device_code";
const SUPPORTED_GRANTS = new Set([
  DEVICE_GRANT,
  "refresh_token",
  "authorization_code",
]);

export type PersonSeed = {
  id: string;
  /** Accounts and roles this person holds. */
  accounts: Array<{
    accountId: string;
    accountName?: string;
    emailAddress?: string;
    roles: string[];
  }>;
};

export type AwsIdentityCenterOptions = {
  region?: string;
  /** The access portal URL StartDeviceAuthorization must be sent. */
  startUrl?: string;
  people?: PersonSeed[];
  now?: () => number;
  deviceExpiresInSeconds?: number;
  intervalSeconds?: number;
  accessTokenLifetimeSeconds?: number;
  roleLifetimeMs?: number;
  /** Seconds until a registered client secret stops working (default 90 days). */
  clientSecretLifetimeSeconds?: number;
  /**
   * The shortest gap between polls this server accepts, when it is longer than
   * the interval it advertised (a server clock or a stricter limit). Default:
   * the advertised interval.
   */
  enforcedIntervalSeconds?: number;
  /** Rotate refresh tokens on use (assumed; default true). */
  rotateRefreshTokens?: boolean;
  /** Page size when a request names none. */
  pageSize?: number;
  /** Put this text in every error description and portal message, to prove none of it travels. */
  errorWords?: string;
  /** Advertise this verification page instead of the double's own. */
  verificationBase?: string;
};

type Client = {
  clientId: string;
  secret: string;
  name: string;
  grants: string[];
  scopes: string[];
  expiresAtSeconds: number;
};

type Device = {
  clientId: string;
  userCode: string;
  startUrl: string;
  expiresAt: number;
  intervalSeconds: number;
  lastPollAt?: number;
  state: "pending" | "approved" | "denied";
  personId?: string;
  redeemed: boolean;
};

type AccessToken = {
  clientId: string;
  personId: string;
  expiresAt: number;
  ended: boolean;
};

type RefreshToken = { clientId: string; personId: string; used: boolean };

const hex = (bytes: number) => randomBytes(bytes).toString("hex");
const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

export async function startAwsIdentityCenter(
  options: AwsIdentityCenterOptions = {},
) {
  const region = options.region ?? "us-east-1";
  const startUrl = options.startUrl ?? "https://acme.awsapps.com/start";
  const now = options.now ?? Date.now;
  const deviceExpiresIn = options.deviceExpiresInSeconds ?? 600;
  const baseInterval = options.intervalSeconds ?? 5;
  const accessLifetime = options.accessTokenLifetimeSeconds ?? 28_800;
  const roleLifetimeMs = options.roleLifetimeMs ?? 3_600_000;
  const clientLifetime = options.clientSecretLifetimeSeconds ?? 90 * 86_400;
  const rotate = options.rotateRefreshTokens ?? true;
  const pageSize = options.pageSize ?? 100;
  const people = new Map<string, PersonSeed>();
  for (const person of options.people ?? []) people.set(person.id, person);

  const clients = new Map<string, Client>();
  const devices = new Map<string, Device>();
  const devicesByUserCode = new Map<string, string>();
  const accessTokens = new Map<string, AccessToken>();
  const refreshTokens = new Map<string, RefreshToken>();
  const roleSessions = new Map<
    string,
    {
      accountId: string;
      roleName: string;
      personId: string;
      expiration: number;
    }
  >();
  const violations: string[] = [];
  const counts = {
    register: 0,
    deviceAuthorization: 0,
    token: 0,
    refresh: 0,
    listAccounts: 0,
    listRoles: 0,
    roleCredentials: 0,
    logout: 0,
    tooFastPolls: 0,
    replayedDeviceCodes: 0,
    replayedRefreshTokens: 0,
  };
  const issued = {
    clientSecrets: [] as string[],
    deviceCodes: [] as string[],
    accessTokens: [] as string[],
    refreshTokens: [] as string[],
    roleCredentials: [] as Array<{
      accessKeyId: string;
      secretAccessKey: string;
      sessionToken: string;
    }>,
  };
  const note = (message: string) => violations.push(message);

  // `connection: close` keeps a client from pooling a socket to a server that
  // later stops, so a request to it is refused outright (and provably never
  // left) instead of dying on a stale connection.
  const reply = (status: number, body?: unknown) => ({
    status,
    headers: { connection: "close" },
    ...(body === undefined ? {} : { body: body as Record<string, unknown> }),
  });
  // The OIDC reference documents this body for every error.
  const oidcError = (status: number, error: string, description = error) =>
    reply(status, {
      error,
      error_description: options.errorWords ?? description,
    });
  const portalError = (status: number, message: string) =>
    reply(status, { message: options.errorWords ?? message });

  /** Parses a JSON object body and notes any wire deviation the reference rules out. */
  function jsonBody(request: RecordedRequest, allowed: readonly string[]) {
    if (!/^application\/json/i.test(request.headers["content-type"] ?? ""))
      note(`${request.url.pathname}: content-type is not application/json`);
    if (request.url.search) note(`${request.url.pathname}: unexpected query`);
    let parsed: unknown;
    try {
      parsed = JSON.parse(request.body.toString("utf8"));
    } catch {
      return undefined;
    }
    if (!isObject(parsed)) return undefined;
    for (const name of Object.keys(parsed))
      if (!allowed.includes(name))
        note(`${request.url.pathname}: unknown member ${name}`);
    return parsed;
  }

  const authenticate = (body: Record<string, unknown>) => {
    const client = clients.get(String(body["clientId"] ?? ""));
    if (!client || client.secret !== body["clientSecret"]) return undefined;
    if (client.expiresAtSeconds * 1000 <= now()) return undefined;
    return client;
  };

  const registerClient = (request: RecordedRequest) => {
    counts.register++;
    const body = jsonBody(request, [
      "clientName",
      "clientType",
      "entitledApplicationArn",
      "grantTypes",
      "issuerUrl",
      "redirectUris",
      "scopes",
    ]);
    if (!body || typeof body["clientName"] !== "string" || !body["clientName"])
      return oidcError(400, "invalid_request");
    if (body["clientType"] !== "public")
      return oidcError(400, "invalid_client_metadata");
    const grants = Array.isArray(body["grantTypes"]) ? body["grantTypes"] : [];
    if (
      !grants.every(
        (grant) => typeof grant === "string" && SUPPORTED_GRANTS.has(grant),
      )
    )
      return oidcError(400, "unsupported_grant_type");
    const scopes = Array.isArray(body["scopes"])
      ? (body["scopes"] as string[])
      : [];
    const clientId = `dummy-client-${hex(8)}`;
    const secret = `aws_dummy_client_secret_${hex(16)}`;
    const issuedAt = Math.floor(now() / 1000);
    clients.set(clientId, {
      clientId,
      secret,
      name: body["clientName"],
      grants: grants as string[],
      scopes,
      expiresAtSeconds: issuedAt + clientLifetime,
    });
    issued.clientSecrets.push(secret);
    return reply(200, {
      clientId,
      clientSecret: secret,
      clientIdIssuedAt: issuedAt,
      clientSecretExpiresAt: issuedAt + clientLifetime,
      authorizationEndpoint: `${oidc.origin}/authorize`,
      tokenEndpoint: `${oidc.origin}/token`,
    });
  };

  const startDevice = (request: RecordedRequest) => {
    counts.deviceAuthorization++;
    const body = jsonBody(request, ["clientId", "clientSecret", "startUrl"]);
    if (!body) return oidcError(400, "invalid_request");
    for (const member of ["clientId", "clientSecret", "startUrl"])
      if (typeof body[member] !== "string" || !body[member])
        return oidcError(400, "invalid_request");
    const client = authenticate(body);
    if (!client) return oidcError(401, "invalid_client");
    if (!client.grants.includes(DEVICE_GRANT))
      return oidcError(400, "unauthorized_client");
    if (body["startUrl"] !== startUrl) return oidcError(400, "invalid_request");
    const deviceCode = `aws_dummy_device_code_${hex(16)}`;
    const userCode = `${hex(2).toUpperCase()}-${hex(2).toUpperCase()}`;
    devices.set(deviceCode, {
      clientId: client.clientId,
      userCode,
      startUrl,
      expiresAt: now() + deviceExpiresIn * 1000,
      intervalSeconds: options.enforcedIntervalSeconds ?? baseInterval,
      state: "pending",
      redeemed: false,
    });
    devicesByUserCode.set(userCode, deviceCode);
    issued.deviceCodes.push(deviceCode);
    return reply(200, {
      deviceCode,
      userCode,
      verificationUri: `${options.verificationBase ?? oidc.origin}/device`,
      verificationUriComplete: `${options.verificationBase ?? oidc.origin}/device?user_code=${userCode}`,
      expiresIn: deviceExpiresIn,
      interval: baseInterval,
    });
  };

  const mintTokens = (client: Client, personId: string) => {
    const accessToken = `aws_dummy_sso_access_${hex(24)}`;
    accessTokens.set(accessToken, {
      clientId: client.clientId,
      personId,
      expiresAt: now() + accessLifetime * 1000,
      ended: false,
    });
    issued.accessTokens.push(accessToken);
    const body: Record<string, unknown> = {
      accessToken,
      tokenType: "Bearer",
      expiresIn: accessLifetime,
    };
    // assumed: refresh tokens only for a client that registered the grant and a scope
    if (client.grants.includes("refresh_token") && client.scopes.length) {
      const refreshToken = `aws_dummy_sso_refresh_${hex(24)}`;
      refreshTokens.set(refreshToken, {
        clientId: client.clientId,
        personId,
        used: false,
      });
      issued.refreshTokens.push(refreshToken);
      body["refreshToken"] = refreshToken;
    }
    return body;
  };

  const deviceGrant = (client: Client, body: Record<string, unknown>) => {
    const code = String(body["deviceCode"] ?? "");
    const device = devices.get(code);
    // assumed: never issued, or issued to another client, is invalid_grant
    if (!device || device.clientId !== client.clientId)
      return oidcError(400, "invalid_grant");
    if (device.redeemed) {
      counts.replayedDeviceCodes++;
      return oidcError(400, "invalid_grant");
    }
    if (device.expiresAt <= now()) return oidcError(400, "expired_token");
    const sooner =
      device.lastPollAt !== undefined &&
      now() - device.lastPollAt < device.intervalSeconds * 1000;
    device.lastPollAt = now();
    if (sooner) {
      counts.tooFastPolls++;
      device.intervalSeconds += 5;
      return oidcError(400, "slow_down");
    }
    if (device.state === "denied") return oidcError(400, "access_denied");
    if (device.state === "pending")
      return oidcError(400, "authorization_pending");
    device.redeemed = true;
    return reply(200, mintTokens(client, device.personId!));
  };

  const refreshGrant = (client: Client, body: Record<string, unknown>) => {
    counts.refresh++;
    const token = String(body["refreshToken"] ?? "");
    const held = refreshTokens.get(token);
    if (!held || held.clientId !== client.clientId)
      return oidcError(400, "invalid_grant");
    if (held.used) {
      counts.replayedRefreshTokens++;
      return oidcError(400, "invalid_grant");
    }
    if (rotate) held.used = true;
    return reply(200, mintTokens(client, held.personId));
  };

  /** Set by `dropNextTokenResponse`: the server acts on the request, then the connection dies. */
  let dropToken = false;
  /** Set by `failTokens`: CreateToken answers this status without acting on the request. */
  let tokenStatus: number | undefined;
  const createToken = (request: RecordedRequest) => {
    counts.token++;
    const body = jsonBody(request, [
      "clientId",
      "clientSecret",
      "code",
      "codeVerifier",
      "deviceCode",
      "grantType",
      "redirectUri",
      "refreshToken",
      "scope",
    ]);
    if (!body) return oidcError(400, "invalid_request");
    for (const member of ["clientId", "clientSecret", "grantType"])
      if (typeof body[member] !== "string" || !body[member])
        return oidcError(400, "invalid_request");
    const client = authenticate(body);
    if (!client) return oidcError(401, "invalid_client");
    const grant = body["grantType"];
    if (typeof grant !== "string" || !SUPPORTED_GRANTS.has(grant))
      return oidcError(400, "unsupported_grant_type");
    if (!client.grants.includes(grant))
      return oidcError(400, "unauthorized_client");
    if (grant === DEVICE_GRANT) return deviceGrant(client, body);
    if (grant === "refresh_token") return refreshGrant(client, body);
    return oidcError(400, "unsupported_grant_type");
  };

  // ------------------------------------------------------------- the portal

  const held = (request: RecordedRequest) => {
    const token = request.headers["x-amz-sso_bearer_token"];
    const entry = token ? accessTokens.get(token) : undefined;
    if (!entry || entry.ended || entry.expiresAt <= now()) return undefined;
    return { token: token!, ...entry };
  };

  const page = <T>(items: T[], request: RecordedRequest) => {
    const limitText = request.url.searchParams.get("max_result");
    const limit = limitText === null ? pageSize : Number(limitText);
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) return undefined;
    const cursor = request.url.searchParams.get("next_token");
    const start = cursor
      ? Number(Buffer.from(cursor, "base64url").toString("utf8"))
      : 0;
    if (!Number.isInteger(start) || start < 0) return undefined;
    const slice = items.slice(start, start + limit);
    const next = start + limit;
    return {
      slice,
      nextToken:
        next < items.length
          ? Buffer.from(String(next), "utf8").toString("base64url")
          : undefined,
    };
  };

  const holds = (personId: string, accountId: string) =>
    people.get(personId)?.accounts.find((a) => a.accountId === accountId);

  /** Set by `failPortal`: every portal call answers this status without acting on the request. */
  let portalStatus: number | undefined;
  const portal = (request: RecordedRequest) => {
    const path = request.url.pathname;
    if (portalStatus !== undefined)
      return portalError(portalStatus, "unavailable");
    const session = held(request);
    if (path === "/logout" && request.method === "POST") {
      counts.logout++;
      if (!session) return portalError(401, "unauthorized");
      const entry = accessTokens.get(session.token)!;
      entry.ended = true;
      return { status: 200 };
    }
    if (request.method !== "GET") return portalError(404, "not found");
    if (path === "/assignment/accounts") {
      counts.listAccounts++;
      if (!session) return portalError(401, "unauthorized");
      const accounts = (people.get(session.personId)?.accounts ?? []).map(
        (a) => ({
          accountId: a.accountId,
          accountName: a.accountName,
          emailAddress: a.emailAddress,
        }),
      );
      const result = page(accounts, request);
      if (!result) return portalError(400, "invalid request");
      return reply(200, {
        accountList: result.slice,
        ...(result.nextToken ? { nextToken: result.nextToken } : {}),
      });
    }
    if (path === "/assignment/roles") {
      counts.listRoles++;
      if (!session) return portalError(401, "unauthorized");
      const accountId = request.url.searchParams.get("account_id");
      if (!accountId) return portalError(400, "account_id is required");
      const account = holds(session.personId, accountId);
      if (!account) return portalError(404, "not found");
      const result = page(
        account.roles.map((roleName) => ({ accountId, roleName })),
        request,
      );
      if (!result) return portalError(400, "invalid request");
      return reply(200, {
        roleList: result.slice,
        ...(result.nextToken ? { nextToken: result.nextToken } : {}),
      });
    }
    if (path === "/federation/credentials") {
      counts.roleCredentials++;
      if (!session) return portalError(401, "unauthorized");
      const accountId = request.url.searchParams.get("account_id");
      const roleName = request.url.searchParams.get("role_name");
      if (!accountId || !roleName)
        return portalError(400, "account_id and role_name are required");
      // assumed: an account or role the person does not hold is a 404
      if (!holds(session.personId, accountId)?.roles.includes(roleName))
        return portalError(404, "not found");
      const credentials = {
        accessKeyId: `ASIADUMMY${hex(8).toUpperCase()}`,
        secretAccessKey: `dummy/secret+${hex(20)}`,
        sessionToken: `aws_dummy_session_token_${hex(40)}`,
        expiration: now() + roleLifetimeMs,
      };
      roleSessions.set(credentials.accessKeyId, {
        accountId,
        roleName,
        personId: session.personId,
        expiration: credentials.expiration,
      });
      issued.roleCredentials.push({
        accessKeyId: credentials.accessKeyId,
        secretAccessKey: credentials.secretAccessKey,
        sessionToken: credentials.sessionToken,
      });
      return reply(200, { roleCredentials: credentials });
    }
    return portalError(404, "not found");
  };

  // ------------------------------------------------- the person's own pages

  const page_ = (title: string, body: string) => ({
    status: 200,
    headers: { "content-type": "text/html; charset=utf-8" },
    body: `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${title}</title></head><body><main>${body}</main></body></html>`,
  });
  const form = (action: string, fields: string, submit: string) =>
    `<form method="post" action="${action}">${fields}<button type="submit">${submit}</button></form>`;
  const parseForm = (request: RecordedRequest) =>
    new URLSearchParams(request.body.toString("utf8"));

  const personPages = (request: RecordedRequest) => {
    const path = request.url.pathname;
    if (request.method === "GET" && path === "/device") {
      const prefilled = request.url.searchParams.get("user_code") ?? "";
      return page_(
        "Connect a device",
        `<h1>Connect a device</h1>${form(
          "/device",
          `<label for="user_code">Device code</label><input id="user_code" name="user_code" value="" autocomplete="off" placeholder="${prefilled ? "Check the code" : "ABCD-EFGH"}">`,
          "Continue",
        )}`,
      );
    }
    if (request.method === "POST" && path === "/device") {
      const userCode = (parseForm(request).get("user_code") ?? "")
        .trim()
        .toUpperCase();
      const code = devicesByUserCode.get(userCode);
      const device = code ? devices.get(code) : undefined;
      if (!device || device.expiresAt <= now() || device.state !== "pending")
        return {
          ...page_("Code not recognised", "<h1>Code not recognised</h1>"),
          status: 400,
        };
      const client = clients.get(device.clientId)!;
      return page_(
        "Allow access",
        `<h1>Allow ${client.name} to access your data?</h1><p>Code ${userCode}</p>${form(
          "/device/decision",
          `<input type="hidden" name="user_code" value="${userCode}"><input type="hidden" name="decision" value="allow">`,
          "Allow",
        )}${form(
          "/device/decision",
          `<input type="hidden" name="user_code" value="${userCode}"><input type="hidden" name="decision" value="deny">`,
          "Deny",
        )}`,
      );
    }
    if (request.method === "POST" && path === "/device/decision") {
      const values = parseForm(request);
      const userCode = (values.get("user_code") ?? "").toUpperCase();
      const done =
        values.get("decision") === "allow" ? approve(userCode) : deny(userCode);
      return done
        ? page_("Done", "<h1>You can close this window</h1>")
        : {
            ...page_("Code not recognised", "<h1>Code not recognised</h1>"),
            status: 400,
          };
    }
    return undefined;
  };

  const approve = (userCode: string, personId?: string) => {
    const code = devicesByUserCode.get(userCode.toUpperCase());
    const device = code ? devices.get(code) : undefined;
    if (!device || device.expiresAt <= now() || device.state !== "pending")
      return false;
    const chosen = personId ?? [...people.keys()][0];
    if (chosen === undefined) return false;
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

  const oidc = await startHttpFixture((request, raw) => {
    if (
      request.method === "POST" &&
      request.url.pathname === "/client/register"
    )
      return registerClient(request);
    if (
      request.method === "POST" &&
      request.url.pathname === "/device_authorization"
    )
      return startDevice(request);
    if (request.method === "POST" && request.url.pathname === "/token") {
      if (tokenStatus !== undefined) {
        counts.token++;
        return oidcError(tokenStatus, "server_error");
      }
      const answer = createToken(request);
      if (dropToken && answer.status === 200) {
        dropToken = false;
        raw.res.destroy();
        return undefined;
      }
      return answer;
    }
    return personPages(request);
  });
  const portalServer = await startHttpFixture((request) => portal(request));

  return {
    region,
    startUrl,
    oidcOrigin: oidc.origin,
    portalOrigin: portalServer.origin,
    counts,
    violations,
    issued,
    oidcRequests: oidc.requests,
    portalRequests: portalServer.requests,
    /** The approving person's side, as the verification page does it. */
    approve,
    deny,
    userCodes: () => [...devicesByUserCode.keys()],
    /** CreateToken answers this status (a 5xx) without acting on the request; null restores it. */
    failTokens(status: number | null) {
      tokenStatus = status ?? undefined;
    },
    /** Every portal call answers this status (a 5xx) without acting on it; null restores the portal. */
    failPortal(status: number | null) {
      portalStatus = status ?? undefined;
    },
    /** Stops listening on the OIDC origin, so a request fails before it is sent. */
    stopOidc: () => oidc.close(),
    /** The next successful CreateToken is acted on, and its answer never arrives. */
    dropNextTokenResponse() {
      dropToken = true;
    },
    /** Expires a device code on the server's own clock, whatever it advertised. */
    expireDevice(userCode: string) {
      const code = devicesByUserCode.get(userCode.toUpperCase());
      const device = code ? devices.get(code) : undefined;
      if (device) device.expiresAt = now() - 1;
    },
    /** Ends a person's access token the way a portal session timeout would. */
    expireAccessToken(token: string) {
      const entry = accessTokens.get(token);
      if (entry) entry.expiresAt = now() - 1;
    },
    /** Removes a role from a person, as an administrator revoking an assignment would. */
    unassign(personId: string, accountId: string, roleName: string) {
      const account = people
        .get(personId)
        ?.accounts.find((a) => a.accountId === accountId);
      if (account) account.roles = account.roles.filter((r) => r !== roleName);
    },
    clientCount: () => clients.size,
    /** Whether role credentials issued earlier still work, which Logout does not change. */
    roleSessionValid(accessKeyId: string) {
      const session = roleSessions.get(accessKeyId);
      return session !== undefined && session.expiration > now();
    },
    roleSession: (accessKeyId: string) => roleSessions.get(accessKeyId),
    /** The client registered at RegisterClient, for assertions about what it asked for. */
    clients: () =>
      [...clients.values()].map(({ secret: _secret, ...rest }) => {
        void _secret;
        return rest;
      }),
    digest: (value: string) => createHash("sha256").update(value).digest("hex"),
    async close() {
      await oidc.close().catch(() => {});
      await portalServer.close();
    },
  };
}
export type AwsIdentityCenterFixture = Awaited<
  ReturnType<typeof startAwsIdentityCenter>
>;
