import { createHash, randomBytes, randomUUID } from "node:crypto";
import { exportJWK, generateKeyPair, SignJWT, type CryptoKey } from "jose";
import { startHttpFixture, type FixtureReply } from "./http-fixture.js";

/*
 * A real OAuth 2.1 / OpenID Connect authorization server over loopback HTTP.
 *
 * It is a fixture, not a mock: it parses the actual request the adapter sent,
 * enforces PKCE, redirect URIs, client authentication, one-use codes, refresh
 * rotation, resource indicators and RFC 8693 checks itself, and signs real
 * JWTs with a real key through jose. Nothing under test writes its responses,
 * so a passing test means two independent implementations agreed on the wire.
 *
 * Misbehaviours are opt-in so security tests have a hostile server to face:
 * a metadata document naming another issuer, a registration or token endpoint
 * on someone else's origin, a `slow_down` device endpoint, a consent screen
 * that denies, an expired code. Configure them per instance.
 *
 * Implements: RFC 8414, RFC 9728, RFC 7636 (S256), RFC 7591, RFC 8628,
 * RFC 8693, RFC 8707, RFC 9207, RFC 9126, OpenID Connect Core/Discovery.
 */

export type AuthorizationServerMisbehaviour = {
  /** `issuer` in metadata differs from the identifier the client configured. */
  issuerMismatch?: string;
  /** `iss` on the authorization response differs from the real issuer. */
  callbackIssuer?: string;
  /** Omit `iss` from the authorization response even though metadata advertises it. */
  omitCallbackIssuer?: boolean;
  /** Advertise a registration endpoint on this foreign origin (AC-AUTH-17). */
  registrationEndpointOrigin?: string;
  /** Advertise a token endpoint on this foreign origin. */
  tokenEndpointOrigin?: string;
  /** Advertise an authorization endpoint on this foreign origin. */
  authorizationEndpointOrigin?: string;
  /** Accept an authorization code more than once instead of consuming it. */
  reusableCode?: boolean;
  /** Answer `slow_down` for the first n device polls. */
  slowDown?: number;
  /** Answer `authorization_pending` for the first n device polls. */
  pending?: number;
  /** The consent step denies with `error=access_denied`. */
  denyConsent?: boolean;
  /** Authorization codes are already expired when issued. */
  expiredCode?: boolean;
  /** Device codes are already expired when issued. */
  expiredDeviceCode?: boolean;
  /** Grant these scopes regardless of what was requested (broker ignores downscoping). */
  grantScopes?: string[];
  /** Omit `scope` from token responses entirely. */
  omitScope?: boolean;
  /** Mint access tokens for this audience instead of the requested resource. */
  mintAudience?: string;
  /** Do not rotate refresh tokens; return the same one. */
  noRefreshRotation?: boolean;
  /** Serve metadata that omits `authorization_response_iss_parameter_supported`. */
  omitIssParameterSupport?: boolean;
  /** Fail the token endpoint with this OAuth error code. */
  tokenError?: string;
  /** Delay every token response by this many milliseconds. */
  tokenDelayMs?: number;
  /**
   * Issue an ID token for this subject, signed by a key this server never
   * publishes, under the genuine `alg` and `kid`. Everything a client that
   * reads the claims without checking the signature would accept.
   */
  forgedIdTokenSubject?: string;
  /** Serve metadata with no `jwks_uri`, so no published key can check a signature. */
  omitJwksUri?: boolean;
};

export type AuthorizationServerOptions = {
  /** Registered client id; omit for dynamic registration or CIMD only. */
  clientId?: string;
  clientSecret?: string;
  /** Exact redirect URIs the server accepts. */
  redirectUris?: string[];
  scopes?: string[];
  /** Enable RFC 7591 dynamic client registration. */
  dynamicRegistration?: boolean;
  /** Advertise and accept `client_id_metadata_document_supported`. */
  clientIdMetadataDocument?: boolean;
  /** Enable RFC 9126 pushed authorization requests. */
  pushedAuthorization?: boolean;
  /** Require PAR for every authorization request. */
  requirePushedAuthorization?: boolean;
  /** Enable the RFC 8693 token exchange grant. */
  tokenExchange?: boolean;
  /** Audiences the exchange endpoint will mint tokens for. */
  exchangeAudiences?: string[];
  /** Enable RFC 8628 device authorization. */
  deviceFlow?: boolean;
  /** Enable the RFC 6749 §4.4 client credentials grant, for confidential clients only. */
  clientCredentials?: boolean;
  /** Device polling interval in seconds (default 1, to keep tests quick). */
  deviceInterval?: number;
  /** Serve RFC 9728 protected-resource metadata for these resource URLs. */
  protectedResources?: string[];
  /** Client authentication methods this server accepts. */
  tokenEndpointAuthMethods?: string[];
  /** Subject the server issues tokens for. */
  subject?: string;
  /** Access tokens are signed JWTs (needed for token-exchange verification). */
  jwtAccessTokens?: boolean;
  /** Issue an ID token on the code grant. */
  openidConnect?: boolean;
  /** An issuer path, so discovery must use path insertion. */
  issuerPath?: string;
  misbehave?: AuthorizationServerMisbehaviour;
  now?: () => number;
};

export type AuthorizationServerDouble = {
  /** The issuer identifier clients configure; includes `issuerPath` when set. */
  issuer: string;
  origin: string;
  clientId: string;
  clientSecret: string | undefined;
  jwksUri: string;
  /** Public JWK set, for tests that verify signatures themselves. */
  jwks(): Promise<{ keys: Record<string, unknown>[] }>;
  /** Registers a client id the server will accept (for CIMD tests). */
  acceptClientId(clientId: string): void;
  /** Adds an accepted redirect URI after construction. */
  acceptRedirectUri(uri: string): void;
  /** Drives a whole authorization: returns the callback URL the provider would redirect to. */
  authorize(
    authorizationUrl: string,
    options?: { deny?: boolean; subject?: string },
  ): Promise<string>;
  /** Approves a pending device code, as a person would on the second device. */
  approveDevice(userCode: string, subject?: string): boolean;
  /** Denies a pending device code. */
  denyDevice(userCode: string): boolean;
  /**
   * Whether an opaque access token this server issued is still active, as a
   * protected resource would ask its authorization server. JWT access tokens
   * are not tracked here.
   */
  accessTokenActive(token: string): boolean;
  /** Revokes one issued access token, as an administrator or an expiry would. */
  revokeAccessToken(token: string): void;
  /** Mints a signed JWT for token-exchange subject tokens. */
  mintToken(input: {
    subject: string;
    audience: string | string[];
    scope?: string;
    expiresInSeconds?: number;
    issuer?: string;
    actor?: string;
  }): Promise<string>;
  /** Counts of requests actually received, by endpoint. */
  counts: {
    metadata: number;
    authorize: number;
    token: number;
    device: number;
    deviceToken: number;
    registration: number;
    /** RFC 7009 revocation requests received, one per token presented. */
    revocation: number;
    introspection: number;
    par: number;
    jwks: number;
    protectedResource: number;
  };
  /** Every token-endpoint body the server parsed, for wire assertions. */
  tokenRequests: Array<{
    grantType: string;
    parameters: Record<string, string>;
    authorization: string | undefined;
  }>;
  /** Raw recorded requests from the underlying fixture. */
  requests: ReturnType<typeof startHttpFixture> extends Promise<infer T>
    ? T extends { requests: infer R }
      ? R
      : never
    : never;
  close(): Promise<void>;
};

type CodeGrant = {
  clientId: string;
  redirectUri: string;
  challenge: string;
  scope: string;
  subject: string;
  nonce: string | undefined;
  resource: string | undefined;
  expiresAt: number;
  used: boolean;
};

type RefreshGrant = {
  clientId: string;
  scope: string;
  subject: string;
  resource: string | undefined;
  active: boolean;
};

type DeviceGrant = {
  clientId: string;
  scope: string;
  userCode: string;
  subject: string | undefined;
  state: "pending" | "approved" | "denied";
  expiresAt: number;
  polls: number;
  resource: string | undefined;
};

const json = (status: number, body: unknown): FixtureReply => ({
  status,
  headers: { "content-type": "application/json", "cache-control": "no-store" },
  body: body as Record<string, unknown>,
});
const oauthError = (status: number, error: string, description?: string) =>
  json(status, {
    error,
    ...(description ? { error_description: description } : {}),
  });

function basicCredentials(
  header: string | undefined,
): { id: string; secret: string } | undefined {
  if (!header?.startsWith("Basic ")) return undefined;
  const decoded = Buffer.from(header.slice(6), "base64").toString("utf8");
  const index = decoded.indexOf(":");
  if (index < 0) return undefined;
  return {
    id: decodeURIComponent(decoded.slice(0, index)),
    secret: decodeURIComponent(decoded.slice(index + 1)),
  };
}

export async function startAuthorizationServer(
  options: AuthorizationServerOptions = {},
): Promise<AuthorizationServerDouble> {
  const now = options.now ?? Date.now;
  const bad = options.misbehave ?? {};
  const { privateKey, publicKey } = await generateKeyPair("ES256", {
    extractable: true,
  });
  const keyId = `key-${randomBytes(4).toString("hex")}`;
  // The forger's key: a real ES256 key that never appears at `jwks_uri`, so a
  // token signed with it verifies against nothing the issuer published.
  const strangerKey =
    bad.forgedIdTokenSubject === undefined
      ? undefined
      : (await generateKeyPair("ES256", { extractable: true })).privateKey;
  const subject = options.subject ?? "user-1";
  const deviceInterval = options.deviceInterval ?? 1;
  const clientSecret = options.clientSecret;
  const clients = new Map<
    string,
    { secret?: string; redirectUris: string[] }
  >();
  const redirectUris = new Set(options.redirectUris ?? []);
  const codes = new Map<string, CodeGrant>();
  const refreshTokens = new Map<string, RefreshGrant>();
  const devices = new Map<string, DeviceGrant>();
  const devicesByUserCode = new Map<string, string>();
  const pushed = new Map<string, Record<string, string>>();
  const accessTokens = new Map<
    string,
    { subject: string; scope: string; audience: string[]; expiresAt: number }
  >();
  const counts = {
    metadata: 0,
    authorize: 0,
    token: 0,
    device: 0,
    deviceToken: 0,
    registration: 0,
    revocation: 0,
    introspection: 0,
    par: 0,
    jwks: 0,
    protectedResource: 0,
  };
  const tokenRequests: AuthorizationServerDouble["tokenRequests"] = [];
  const registeredClientId = options.clientId ?? "fixture-client";
  clients.set(registeredClientId, {
    ...(clientSecret !== undefined ? { secret: clientSecret } : {}),
    redirectUris: [...redirectUris],
  });

  let issuer = "";
  let origin = "";
  const path = options.issuerPath ?? "";

  const endpoint = (name: string, override?: string) =>
    `${override ?? origin}${path}/${name}`;

  const metadataDocument = () => ({
    issuer: bad.issuerMismatch ?? issuer,
    authorization_endpoint: endpoint(
      "authorize",
      bad.authorizationEndpointOrigin,
    ),
    token_endpoint: endpoint("token", bad.tokenEndpointOrigin),
    ...(bad.omitJwksUri ? {} : { jwks_uri: endpoint("jwks") }),
    scopes_supported: options.scopes ?? ["openid", "profile", "email"],
    response_types_supported: ["code"],
    grant_types_supported: [
      "authorization_code",
      "refresh_token",
      ...(options.deviceFlow
        ? ["urn:ietf:params:oauth:grant-type:device_code"]
        : []),
      ...(options.tokenExchange
        ? ["urn:ietf:params:oauth:grant-type:token-exchange"]
        : []),
      ...(options.clientCredentials ? ["client_credentials"] : []),
    ],
    code_challenge_methods_supported: ["S256"],
    token_endpoint_auth_methods_supported: options.tokenEndpointAuthMethods ?? [
      "client_secret_basic",
      "client_secret_post",
      "private_key_jwt",
      "none",
    ],
    introspection_endpoint: endpoint("introspect"),
    revocation_endpoint: endpoint("revoke"),
    ...(bad.omitIssParameterSupport
      ? {}
      : { authorization_response_iss_parameter_supported: true }),
    ...(options.deviceFlow
      ? { device_authorization_endpoint: endpoint("device") }
      : {}),
    ...(options.dynamicRegistration || bad.registrationEndpointOrigin
      ? {
          registration_endpoint: endpoint(
            "register",
            bad.registrationEndpointOrigin,
          ),
        }
      : {}),
    ...(options.clientIdMetadataDocument
      ? { client_id_metadata_document_supported: true }
      : {}),
    ...(options.pushedAuthorization
      ? {
          pushed_authorization_request_endpoint: endpoint("par"),
          ...(options.requirePushedAuthorization
            ? { require_pushed_authorization_requests: true }
            : {}),
        }
      : {}),
    ...(options.openidConnect
      ? {
          userinfo_endpoint: endpoint("userinfo"),
          id_token_signing_alg_values_supported: ["ES256"],
          subject_types_supported: ["public"],
        }
      : {}),
  });

  const signJwt = async (input: {
    subject: string;
    audience: string | string[];
    scope?: string | undefined;
    expiresInSeconds?: number | undefined;
    issuer?: string | undefined;
    actor?: string | undefined;
    nonce?: string | undefined;
    type?: string;
    /** Signs with this key instead of the published one; the header is unchanged. */
    signWith?: CryptoKey | undefined;
  }) => {
    const seconds = input.expiresInSeconds ?? 3600;
    let builder = new SignJWT({
      ...(input.scope !== undefined ? { scope: input.scope } : {}),
      ...(input.actor !== undefined ? { act: { sub: input.actor } } : {}),
      ...(input.nonce !== undefined ? { nonce: input.nonce } : {}),
      client_id: registeredClientId,
    })
      .setProtectedHeader({
        alg: "ES256",
        kid: keyId,
        ...(input.type ? { typ: input.type } : {}),
      })
      .setIssuer(input.issuer ?? issuer)
      .setSubject(input.subject)
      .setJti(randomUUID())
      .setIssuedAt();
    builder = Array.isArray(input.audience)
      ? builder.setAudience(input.audience)
      : builder.setAudience(input.audience);
    return builder
      .setExpirationTime(Math.floor(now() / 1000) + seconds)
      .sign(input.signWith ?? (privateKey as CryptoKey));
  };

  const issueAccessToken = async (input: {
    subject: string;
    scope: string;
    resource: string | undefined;
  }) => {
    const audience = bad.mintAudience ?? input.resource ?? registeredClientId;
    const expiresAt = now() + 3600_000;
    if (options.jwtAccessTokens)
      return {
        token: await signJwt({
          subject: input.subject,
          audience,
          scope: input.scope,
          type: "at+jwt",
        }),
        audience,
        expiresAt,
      };
    const token = `at_${randomBytes(16).toString("hex")}`;
    accessTokens.set(token, {
      subject: input.subject,
      scope: input.scope,
      audience: [audience],
      expiresAt,
    });
    return { token, audience, expiresAt };
  };

  const authenticateClient = (
    parameters: Record<string, string>,
    authorization: string | undefined,
  ): { ok: true; clientId: string } | { ok: false } => {
    const basic = basicCredentials(authorization);
    if (basic) {
      const record = clients.get(basic.id);
      if (!record?.secret || record.secret !== basic.secret)
        return { ok: false };
      return { ok: true, clientId: basic.id };
    }
    const id = parameters["client_id"];
    if (!id) return { ok: false };
    // private_key_jwt: the assertion is a real signed JWT; the fixture checks
    // its shape and subject binding rather than re-deriving the client's key.
    if (
      parameters["client_assertion_type"] ===
      "urn:ietf:params:oauth:client-assertion-type:jwt-bearer"
    ) {
      const assertion = parameters["client_assertion"];
      if (!assertion || assertion.split(".").length !== 3) return { ok: false };
      const payload = JSON.parse(
        Buffer.from(assertion.split(".")[1]!, "base64url").toString("utf8"),
      ) as { iss?: string; sub?: string; aud?: string | string[] };
      if (payload.iss !== id || payload.sub !== id) return { ok: false };
      const audience = Array.isArray(payload.aud) ? payload.aud : [payload.aud];
      if (
        !audience.some((value) => value === issuer || value?.includes(origin))
      )
        return { ok: false };
      return { ok: true, clientId: id };
    }
    const record = clients.get(id);
    if (!record) return { ok: false };
    if (record.secret !== undefined) {
      if (parameters["client_secret"] !== record.secret) return { ok: false };
      return { ok: true, clientId: id };
    }
    return { ok: true, clientId: id };
  };

  const fixture = await startHttpFixture(async (request) => {
    const url = request.url;
    const route =
      path && url.pathname.startsWith(path)
        ? url.pathname.slice(path.length)
        : url.pathname;
    const form = new URLSearchParams(request.body.toString("utf8"));
    const parameters = Object.fromEntries(form.entries());
    const authorization = request.headers["authorization"];

    if (
      route === "/.well-known/oauth-authorization-server" ||
      url.pathname === "/.well-known/oauth-authorization-server" ||
      url.pathname === `/.well-known/oauth-authorization-server${path}` ||
      url.pathname === `/.well-known/openid-configuration${path}` ||
      (path === "" && url.pathname === "/.well-known/openid-configuration")
    ) {
      counts.metadata++;
      return json(200, metadataDocument());
    }

    if (url.pathname.startsWith("/.well-known/oauth-protected-resource")) {
      counts.protectedResource++;
      const suffix = url.pathname.slice(
        "/.well-known/oauth-protected-resource".length,
      );
      const resource = `${origin}${suffix === "" ? "/" : suffix}`;
      if (
        options.protectedResources &&
        !options.protectedResources.includes(resource)
      )
        return json(404, { error: "not_found" });
      return json(200, {
        resource,
        authorization_servers: [issuer],
        scopes_supported: options.scopes ?? ["openid"],
        bearer_methods_supported: ["header"],
      });
    }

    if (route === "/jwks") {
      counts.jwks++;
      const jwk = await exportJWK(publicKey as CryptoKey);
      return json(200, {
        keys: [{ ...jwk, kid: keyId, use: "sig", alg: "ES256" }],
      });
    }

    if (route === "/register" && request.method === "POST") {
      counts.registration++;
      if (!options.dynamicRegistration) return oauthError(404, "not_found");
      const body = JSON.parse(request.body.toString("utf8") || "{}") as {
        redirect_uris?: string[];
        token_endpoint_auth_method?: string;
        grant_types?: string[];
      };
      const id = `dcr-${randomBytes(6).toString("hex")}`;
      const method = body.token_endpoint_auth_method ?? "client_secret_basic";
      const secret =
        method === "none"
          ? undefined
          : `sec_${randomBytes(16).toString("hex")}`;
      for (const uri of body.redirect_uris ?? []) redirectUris.add(uri);
      clients.set(id, {
        ...(secret !== undefined ? { secret } : {}),
        redirectUris: body.redirect_uris ?? [],
      });
      return json(201, {
        client_id: id,
        ...(secret !== undefined ? { client_secret: secret } : {}),
        client_id_issued_at: Math.floor(now() / 1000),
        client_secret_expires_at: 0,
        redirect_uris: body.redirect_uris ?? [],
        grant_types: body.grant_types ?? ["authorization_code"],
        token_endpoint_auth_method: method,
      });
    }

    if (route === "/par" && request.method === "POST") {
      counts.par++;
      if (!options.pushedAuthorization) return oauthError(404, "not_found");
      const authenticated = authenticateClient(parameters, authorization);
      if (!authenticated.ok) return oauthError(401, "invalid_client");
      const requestUri = `urn:ietf:params:oauth:request_uri:${randomBytes(12).toString("hex")}`;
      pushed.set(requestUri, parameters);
      return json(201, { request_uri: requestUri, expires_in: 90 });
    }

    if (route === "/authorize") {
      counts.authorize++;
      let query: Record<string, string> = Object.fromEntries(
        url.searchParams.entries(),
      );
      const requestUri = query["request_uri"];
      if (requestUri !== undefined) {
        const stored = pushed.get(requestUri);
        if (!stored) return oauthError(400, "invalid_request_uri");
        pushed.delete(requestUri);
        query = stored;
      } else if (options.requirePushedAuthorization)
        return oauthError(400, "invalid_request", "PAR required");
      const clientId = query["client_id"] ?? "";
      const redirectUri = query["redirect_uri"] ?? "";
      const known =
        clients.has(clientId) ||
        (options.clientIdMetadataDocument && clientId.startsWith("https://")) ||
        (options.clientIdMetadataDocument && clientId.startsWith("http://"));
      if (!known) return oauthError(400, "unauthorized_client");
      if (!redirectUris.has(redirectUri))
        return oauthError(400, "invalid_request", "redirect_uri");
      if (
        query["response_type"] !== "code" ||
        query["code_challenge_method"] !== "S256" ||
        !query["code_challenge"]
      )
        return oauthError(400, "invalid_request");
      const state = query["state"];
      const location = new URL(redirectUri);
      const issParameter = bad.omitCallbackIssuer
        ? undefined
        : (bad.callbackIssuer ?? issuer);
      if (bad.denyConsent) {
        location.searchParams.set("error", "access_denied");
        if (state) location.searchParams.set("state", state);
        if (issParameter) location.searchParams.set("iss", issParameter);
        return { status: 302, headers: { location: location.href } };
      }
      const code = `code_${randomBytes(16).toString("hex")}`;
      codes.set(code, {
        clientId,
        redirectUri,
        challenge: query["code_challenge"]!,
        scope: query["scope"] ?? "",
        subject,
        nonce: query["nonce"],
        resource: query["resource"],
        expiresAt: bad.expiredCode ? now() - 1000 : now() + 600_000,
        used: false,
      });
      location.searchParams.set("code", code);
      if (state) location.searchParams.set("state", state);
      if (issParameter) location.searchParams.set("iss", issParameter);
      return { status: 302, headers: { location: location.href } };
    }

    if (route === "/device" && request.method === "POST") {
      counts.device++;
      if (!options.deviceFlow) return oauthError(404, "not_found");
      const authenticated = authenticateClient(parameters, authorization);
      if (!authenticated.ok) return oauthError(401, "invalid_client");
      const deviceCode = `dev_${randomBytes(16).toString("hex")}`;
      const userCode = randomBytes(4).toString("hex").toUpperCase();
      devices.set(deviceCode, {
        clientId: authenticated.clientId,
        scope: parameters["scope"] ?? "",
        userCode,
        subject: undefined,
        state: "pending",
        expiresAt: bad.expiredDeviceCode ? now() - 1000 : now() + 600_000,
        polls: 0,
        resource: parameters["resource"],
      });
      devicesByUserCode.set(userCode, deviceCode);
      return json(200, {
        device_code: deviceCode,
        user_code: userCode,
        verification_uri: `${origin}${path}/activate`,
        verification_uri_complete: `${origin}${path}/activate?user_code=${userCode}`,
        expires_in: 600,
        interval: deviceInterval,
      });
    }

    if (route === "/token" && request.method === "POST") {
      counts.token++;
      tokenRequests.push({
        grantType: parameters["grant_type"] ?? "",
        parameters,
        authorization,
      });
      if (bad.tokenDelayMs)
        await new Promise((resolve) => setTimeout(resolve, bad.tokenDelayMs));
      if (bad.tokenError) return oauthError(400, bad.tokenError);
      const authenticated = authenticateClient(parameters, authorization);
      if (!authenticated.ok) return oauthError(401, "invalid_client");
      const grantType = parameters["grant_type"];

      if (grantType === "authorization_code") {
        const grant = codes.get(parameters["code"] ?? "");
        if (!grant) return oauthError(400, "invalid_grant", "unknown code");
        if (grant.used && !bad.reusableCode)
          return oauthError(400, "invalid_grant", "code already used");
        if (grant.expiresAt <= now())
          return oauthError(400, "invalid_grant", "code expired");
        if (grant.clientId !== authenticated.clientId)
          return oauthError(400, "invalid_grant", "client mismatch");
        if (grant.redirectUri !== parameters["redirect_uri"])
          return oauthError(400, "invalid_grant", "redirect_uri mismatch");
        const verifier = parameters["code_verifier"] ?? "";
        const derived = createHash("sha256")
          .update(verifier)
          .digest("base64url");
        if (derived !== grant.challenge)
          return oauthError(400, "invalid_grant", "PKCE verification failed");
        grant.used = true;
        if (!bad.reusableCode) codes.delete(parameters["code"]!);
        const granted = bad.grantScopes?.join(" ") ?? grant.scope;
        const resource = parameters["resource"] ?? grant.resource;
        const issued = await issueAccessToken({
          subject: grant.subject,
          scope: granted,
          resource,
        });
        const refresh = `rt_${randomBytes(16).toString("hex")}`;
        refreshTokens.set(refresh, {
          clientId: authenticated.clientId,
          scope: granted,
          subject: grant.subject,
          resource,
          active: true,
        });
        return json(200, {
          access_token: issued.token,
          token_type: "Bearer",
          expires_in: 3600,
          refresh_token: refresh,
          ...(bad.omitScope ? {} : { scope: granted }),
          ...(options.openidConnect
            ? {
                id_token: await signJwt({
                  subject: bad.forgedIdTokenSubject ?? grant.subject,
                  audience: authenticated.clientId,
                  ...(grant.nonce !== undefined ? { nonce: grant.nonce } : {}),
                  ...(strangerKey ? { signWith: strangerKey } : {}),
                }),
              }
            : {}),
        });
      }

      if (grantType === "refresh_token") {
        const presented = parameters["refresh_token"] ?? "";
        const grant = refreshTokens.get(presented);
        if (!grant || !grant.active)
          return oauthError(400, "invalid_grant", "refresh token not active");
        if (grant.clientId !== authenticated.clientId)
          return oauthError(400, "invalid_grant", "client mismatch");
        const granted = parameters["scope"] ?? grant.scope;
        const issued = await issueAccessToken({
          subject: grant.subject,
          scope: granted,
          resource: parameters["resource"] ?? grant.resource,
        });
        let next = presented;
        if (!bad.noRefreshRotation) {
          grant.active = false;
          next = `rt_${randomBytes(16).toString("hex")}`;
          refreshTokens.set(next, { ...grant, scope: granted, active: true });
        }
        return json(200, {
          access_token: issued.token,
          token_type: "Bearer",
          expires_in: 3600,
          refresh_token: next,
          ...(bad.omitScope ? {} : { scope: granted }),
        });
      }

      if (grantType === "urn:ietf:params:oauth:grant-type:device_code") {
        counts.deviceToken++;
        const grant = devices.get(parameters["device_code"] ?? "");
        if (!grant) return oauthError(400, "invalid_grant");
        grant.polls++;
        if (grant.expiresAt <= now()) return oauthError(400, "expired_token");
        if (bad.slowDown && grant.polls <= bad.slowDown)
          return oauthError(400, "slow_down");
        if (bad.pending && grant.polls <= bad.pending)
          return oauthError(400, "authorization_pending");
        if (grant.state === "denied") return oauthError(400, "access_denied");
        if (grant.state === "pending")
          return oauthError(400, "authorization_pending");
        devices.delete(parameters["device_code"]!);
        const issued = await issueAccessToken({
          subject: grant.subject ?? subject,
          scope: grant.scope,
          resource: grant.resource,
        });
        return json(200, {
          access_token: issued.token,
          token_type: "Bearer",
          expires_in: 3600,
          ...(bad.omitScope ? {} : { scope: grant.scope }),
        });
      }

      if (grantType === "client_credentials") {
        if (!options.clientCredentials)
          return oauthError(400, "unsupported_grant_type");
        // RFC 6749 §4.4: confidential clients only. A client this server holds
        // no secret for authenticated with nothing, so it gets nothing.
        if (clients.get(authenticated.clientId)?.secret === undefined)
          return oauthError(401, "invalid_client");
        const granted = bad.grantScopes?.join(" ") ?? parameters["scope"] ?? "";
        const issued = await issueAccessToken({
          subject: authenticated.clientId,
          scope: granted,
          resource: parameters["resource"],
        });
        return json(200, {
          access_token: issued.token,
          token_type: "Bearer",
          expires_in: 3600,
          ...(bad.omitScope ? {} : { scope: granted }),
        });
      }

      if (grantType === "urn:ietf:params:oauth:grant-type:token-exchange") {
        if (!options.tokenExchange)
          return oauthError(400, "unsupported_grant_type");
        const subjectToken = parameters["subject_token"];
        if (!subjectToken) return oauthError(400, "invalid_request");
        const audience = parameters["audience"] ?? parameters["resource"];
        if (!audience) return oauthError(400, "invalid_target");
        if (
          options.exchangeAudiences &&
          !options.exchangeAudiences.includes(audience)
        )
          return oauthError(400, "invalid_target");
        let exchangeSubject = subject;
        try {
          const payload = JSON.parse(
            Buffer.from(subjectToken.split(".")[1]!, "base64url").toString(
              "utf8",
            ),
          ) as { sub?: string };
          if (payload.sub) exchangeSubject = payload.sub;
        } catch {
          /* Opaque subject tokens keep the fixture's default subject. */
        }
        const actorToken = parameters["actor_token"];
        let actor: string | undefined;
        if (actorToken)
          try {
            const payload = JSON.parse(
              Buffer.from(actorToken.split(".")[1]!, "base64url").toString(
                "utf8",
              ),
            ) as { sub?: string };
            actor = payload.sub;
          } catch {
            return oauthError(400, "invalid_request");
          }
        const requested =
          parameters["requested_token_type"] ??
          "urn:ietf:params:oauth:token-type:access_token";
        const scope = parameters["scope"] ?? "";
        const token = await signJwt({
          subject: exchangeSubject,
          audience: bad.mintAudience ?? audience,
          ...(scope ? { scope } : {}),
          ...(actor !== undefined ? { actor } : {}),
        });
        return json(200, {
          access_token: token,
          issued_token_type: requested,
          token_type: "Bearer",
          expires_in: 3600,
          ...(scope && !bad.omitScope ? { scope } : {}),
        });
      }

      return oauthError(400, "unsupported_grant_type");
    }

    if (route === "/introspect" && request.method === "POST") {
      counts.introspection++;
      const authenticated = authenticateClient(parameters, authorization);
      if (!authenticated.ok) return oauthError(401, "invalid_client");
      const record = accessTokens.get(parameters["token"] ?? "");
      if (!record || record.expiresAt <= now())
        return json(200, { active: false });
      return json(200, {
        active: true,
        iss: issuer,
        sub: record.subject,
        aud: record.audience,
        scope: record.scope,
        client_id: registeredClientId,
        exp: Math.floor(record.expiresAt / 1000),
      });
    }

    if (route === "/revoke" && request.method === "POST") {
      counts.revocation++;
      // RFC 7009 §2.1: the client authenticates as it does at the token endpoint.
      if (!authenticateClient(parameters, authorization).ok)
        return oauthError(401, "invalid_client");
      const token = parameters["token"];
      if (token) {
        refreshTokens.delete(token);
        accessTokens.delete(token);
      }
      return { status: 200, body: "" };
    }

    if (route === "/userinfo")
      return json(200, { sub: subject, email: `${subject}@example.test` });

    return json(404, { error: "not_found" });
  });

  origin = fixture.origin;
  issuer = `${origin}${path}`;

  return {
    get issuer() {
      return issuer;
    },
    origin,
    clientId: registeredClientId,
    clientSecret,
    get jwksUri() {
      return endpoint("jwks");
    },
    async jwks() {
      const jwk = await exportJWK(publicKey as CryptoKey);
      return { keys: [{ ...jwk, kid: keyId, use: "sig", alg: "ES256" }] };
    },
    acceptClientId(clientId) {
      clients.set(clientId, { redirectUris: [...redirectUris] });
    },
    acceptRedirectUri(uri) {
      redirectUris.add(uri);
    },
    async authorize(authorizationUrl, authorizeOptions = {}) {
      const response = await fetch(authorizationUrl, { redirect: "manual" });
      const location = response.headers.get("location");
      await response.body?.cancel();
      if (!location)
        throw new Error(
          `Authorization did not redirect (status ${response.status})`,
        );
      if (authorizeOptions.deny) {
        const denied = new URL(location);
        denied.searchParams.delete("code");
        denied.searchParams.set("error", "access_denied");
        return denied.href;
      }
      if (authorizeOptions.subject) {
        const code = new URL(location).searchParams.get("code");
        const grant = code ? codes.get(code) : undefined;
        if (grant) grant.subject = authorizeOptions.subject;
      }
      return location;
    },
    approveDevice(userCode, approveSubject) {
      const deviceCode = devicesByUserCode.get(userCode.toUpperCase());
      const grant = deviceCode ? devices.get(deviceCode) : undefined;
      if (!grant) return false;
      grant.state = "approved";
      grant.subject = approveSubject ?? subject;
      return true;
    },
    denyDevice(userCode) {
      const deviceCode = devicesByUserCode.get(userCode.toUpperCase());
      const grant = deviceCode ? devices.get(deviceCode) : undefined;
      if (!grant) return false;
      grant.state = "denied";
      return true;
    },
    accessTokenActive(token) {
      const record = accessTokens.get(token);
      return record !== undefined && record.expiresAt > now();
    },
    revokeAccessToken(token) {
      accessTokens.delete(token);
    },
    mintToken: (input) => signJwt(input),
    counts,
    tokenRequests,
    requests: fixture.requests as AuthorizationServerDouble["requests"],
    close: fixture.close,
  };
}
