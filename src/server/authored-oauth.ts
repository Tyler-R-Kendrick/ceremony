import * as oauth from "oauth4webapi";
import { importJWK, type CryptoKey } from "jose";
import { z } from "zod";
import { publicAuthFetch } from "./public-auth-fetch.js";

export const dpopJwkSchema = z.object({
  kty: z.literal("EC"),
  crv: z.literal("P-256"),
  x: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
  y: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
  d: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
});

/** RFC 9449 metadata advertises support, not a requirement; this host signs ES256 only. */
export function useDpop(
  discovery: {
    dpopRequired?: boolean | undefined;
    dpopSigningAlgorithms?: string[] | undefined;
  },
  required = false,
) {
  const supported = discovery.dpopSigningAlgorithms?.includes("ES256") ?? false;
  if ((required || discovery.dpopRequired) && !supported)
    throw new Error("Required DPoP algorithm is not supported");
  return supported;
}

/**
 * Extra authorization-request parameters an author may declare for a
 * provider (an `audience` for Auth0, `access_type=offline` for Google,
 * `prompt=consent`). Positive allowlist: every name here only shapes what the
 * provider shows or issues. The protocol parameters that bind the request to
 * this run (client, redirect, state, PKCE, scope, request object) are not on
 * it and are refused by name, so a declaration can never replace them.
 */
export const authorizationParamNames = [
  "audience",
  "resource",
  "prompt",
  "access_type",
  "include_granted_scopes",
  "approval_prompt",
  "display",
  "ui_locales",
  "max_age",
  "acr_values",
  "duration",
] as const;
export const reservedAuthorizationParams = [
  "response_type",
  "client_id",
  "redirect_uri",
  "scope",
  "state",
  "code_challenge",
  "code_challenge_method",
  "request",
  "request_uri",
  "response_mode",
  "nonce",
  "dpop_jkt",
  "client_secret",
] as const;
export const authorizationParamsSchema = z
  .record(
    z.string().max(40),
    z
      .string()
      .min(1)
      .max(256)
      .regex(/^[\x21-\x7e ]+$/, "Printable ASCII only"),
  )
  .superRefine((params, ctx) => {
    const names = Object.keys(params);
    if (names.length > 8)
      ctx.addIssue({ code: "custom", message: "At most 8 parameters" });
    for (const name of names)
      if (
        (reservedAuthorizationParams as readonly string[]).includes(name) ||
        !(authorizationParamNames as readonly string[]).includes(name)
      )
        ctx.addIssue({
          code: "custom",
          message: `Authorization parameter ${name} is not allowed`,
          path: [name],
        });
  });

/** Applied before the protocol parameters, which are then set last and win. */
function applyAuthorizationParams(
  target: URLSearchParams,
  params: Record<string, string> | undefined,
) {
  for (const [name, value] of Object.entries(params ?? {}))
    if (
      (authorizationParamNames as readonly string[]).includes(name) &&
      !(reservedAuthorizationParams as readonly string[]).includes(name)
    )
      target.set(name, value);
}

export const tokenEndpointAuthMethods = [
  "none",
  "client_secret_basic",
  "client_secret_post",
] as const;
export type TokenEndpointAuthMethod = (typeof tokenEndpointAuthMethods)[number];
/**
 * How this host authenticates to a token endpoint. A confidential method
 * carries the secret from server custody for the duration of one request; it
 * is never stored on a ticket, an app record or anything a page renders.
 */
export type ClientAuthentication =
  | { method: "none" }
  | { method: "client_secret_basic" | "client_secret_post"; secret: string };

function oauthClient(
  clientId: string,
  auth: ClientAuthentication | undefined,
): [oauth.Client, oauth.ClientAuth] {
  const method = auth?.method ?? "none";
  const client: oauth.Client = {
    client_id: clientId,
    token_endpoint_auth_method: method,
  };
  if (auth?.method === "client_secret_basic")
    return [client, oauth.ClientSecretBasic(auth.secret)];
  if (auth?.method === "client_secret_post")
    return [client, oauth.ClientSecretPost(auth.secret)];
  return [client, oauth.None()];
}

/** RFC 6749 section 2.3.1 client authentication on a hand-built form request. */
export function applyClientAuthentication(
  clientId: string,
  headers: Record<string, string>,
  body: URLSearchParams,
  auth: ClientAuthentication | undefined,
) {
  if (auth?.method === "client_secret_basic") {
    const encode = (value: string) =>
      encodeURIComponent(value).replace(/%20/g, "+");
    headers.authorization = `Basic ${Buffer.from(
      `${encode(clientId)}:${encode(auth.secret)}`,
    ).toString("base64")}`;
    body.delete("client_secret");
  } else if (auth?.method === "client_secret_post")
    body.set("client_secret", auth.secret);
}

export function requestedScopes(supported?: string[]) {
  if (!supported?.length) return ["openid", "profile", "email"];
  if (supported.includes("atproto"))
    return [
      "atproto",
      ...["transition:generic", "transition:email"].filter((scope) =>
        supported.includes(scope),
      ),
    ];
  const preferred = ["openid", "profile", "email", "offline_access"].filter(
    (scope) => supported.includes(scope),
  );
  return preferred.length ? preferred : supported.slice(0, 4);
}

export function metadataDocumentClientId(
  origin: string,
  redirectUri: string,
  scope: string,
  connectorId: string,
  runId: string,
) {
  const host = new URL(origin).hostname;
  if (host === "127.0.0.1" || host === "localhost" || host === "[::1]") {
    const params = new URLSearchParams({
      redirect_uri: redirectUri,
      scope,
    });
    return `http://localhost?${params.toString()}`;
  }
  return `${origin.replace(/\/$/, "")}/api/v1/teaching/oauth-clients/${encodeURIComponent(connectorId)}/${encodeURIComponent(runId)}`;
}

export function clientMetadataDocument(input: {
  clientId: string;
  redirectUri: string;
  scope: string;
  name: string;
  dpopRequired?: boolean;
}) {
  return {
    client_id: input.clientId,
    client_name: input.name.slice(0, 80),
    application_type: "web",
    grant_types: ["authorization_code", "refresh_token"],
    response_types: ["code"],
    redirect_uris: [input.redirectUri],
    scope: input.scope,
    token_endpoint_auth_method: "none",
    dpop_bound_access_tokens: input.dpopRequired ?? false,
  };
}

export async function exportDpopJwk() {
  const pair = await oauth.generateKeyPair("ES256", { extractable: true });
  return crypto.subtle.exportKey("jwk", pair.privateKey);
}

async function importDpopPair(jwk: JsonWebKey) {
  const privateKey = (await importJWK(
    { ...jwk, key_ops: ["sign"] },
    "ES256",
  )) as CryptoKey;
  const publicJwk = { ...jwk };
  delete publicJwk.d;
  const publicKey = (await importJWK(
    { ...publicJwk, key_ops: ["verify"] },
    "ES256",
  )) as CryptoKey;
  return { privateKey, publicKey };
}

export async function dpopUserinfoRequest(
  endpoint: string,
  accessToken: string,
  jwk: JsonWebKey,
  fetcher: typeof fetch,
) {
  const DPoP = oauth.DPoP({}, await importDpopPair(jwk));
  const execute = () =>
    oauth.protectedResourceRequest(
      accessToken,
      "GET",
      new URL(endpoint),
      new Headers({ accept: "application/json" }),
      undefined,
      {
        DPoP,
        [oauth.customFetch]: (url, { body: _body, ...init }) =>
          fetcher(url, init),
        signal: AbortSignal.timeout(15_000),
      },
    );
  try {
    return await execute();
  } catch (error) {
    if (!oauth.isDPoPNonceError(error)) throw error;
    return execute();
  }
}

function asMetadata(discovery: {
  issuer?: string | undefined;
  origin: string;
  authorizationEndpoint: string;
  tokenEndpoint: string;
  pushedAuthorizationRequestEndpoint?: string | undefined;
}): oauth.AuthorizationServer {
  return {
    issuer: discovery.issuer || discovery.origin,
    authorization_endpoint: discovery.authorizationEndpoint,
    token_endpoint: discovery.tokenEndpoint,
    ...(discovery.pushedAuthorizationRequestEndpoint
      ? {
          pushed_authorization_request_endpoint:
            discovery.pushedAuthorizationRequestEndpoint,
        }
      : {}),
  };
}

export async function pushedAuthorizationLocation(input: {
  discovery: {
    issuer?: string | undefined;
    origin: string;
    authorizationEndpoint: string;
    tokenEndpoint: string;
    pushedAuthorizationRequestEndpoint?: string | undefined;
  };
  clientId: string;
  redirectUri: string;
  scope: string;
  state: string;
  challenge: string;
  dpopJwk?: JsonWebKey;
  authorizationParams?: Record<string, string>;
  clientAuth?: ClientAuthentication;
  fetch?: typeof fetch;
}) {
  const as = asMetadata(input.discovery);
  const [client, clientAuth] = oauthClient(input.clientId, input.clientAuth);
  const DPoP = input.dpopJwk
    ? oauth.DPoP(client, await importDpopPair(input.dpopJwk))
    : undefined;
  const parameters = new URLSearchParams();
  applyAuthorizationParams(parameters, input.authorizationParams);
  for (const [name, value] of Object.entries({
    response_type: "code",
    client_id: input.clientId,
    redirect_uri: input.redirectUri,
    scope: input.scope,
    state: input.state,
    code_challenge: input.challenge,
    code_challenge_method: "S256",
  }))
    parameters.set(name, value);
  const execute = () =>
    oauth.pushedAuthorizationRequest(as, client, clientAuth, parameters, {
      ...(DPoP ? { DPoP } : {}),
      [oauth.customFetch]: input.fetch ?? publicAuthFetch,
    });
  let response = await execute();
  try {
    const pushed = await oauth.processPushedAuthorizationResponse(
      as,
      client,
      response,
    );
    const authorize = new URL(input.discovery.authorizationEndpoint);
    authorize.searchParams.set("client_id", input.clientId);
    authorize.searchParams.set("request_uri", pushed.request_uri);
    return authorize.href;
  } catch (error) {
    if (!oauth.isDPoPNonceError(error)) throw error;
    response = await execute();
    const pushed = await oauth.processPushedAuthorizationResponse(
      as,
      client,
      response,
    );
    const authorize = new URL(input.discovery.authorizationEndpoint);
    authorize.searchParams.set("client_id", input.clientId);
    authorize.searchParams.set("request_uri", pushed.request_uri);
    return authorize.href;
  }
}

export async function beginAuthorization(input: {
  discovery: {
    issuer?: string | undefined;
    origin: string;
    authorizationEndpoint: string;
    tokenEndpoint: string;
    pushedAuthorizationRequestEndpoint?: string | undefined;
    requirePushedAuthorizationRequests?: boolean | undefined;
    dpopRequired?: boolean | undefined;
    dpopSigningAlgorithms?: string[] | undefined;
  };
  clientId: string;
  redirectUri: string;
  scope: string;
  dpop?: boolean;
  /** Declared, allowlisted extras; the protocol parameters below always win. */
  authorizationParams?: Record<string, string>;
  /** Needed only when a pushed authorization request authenticates the client. */
  clientAuth?: ClientAuthentication;
  fetch?: typeof fetch;
}): Promise<{
  location: string;
  state: string;
  verifier: string;
  dpopJwk?: JsonWebKey;
}> {
  if (
    input.discovery.requirePushedAuthorizationRequests &&
    !input.discovery.pushedAuthorizationRequestEndpoint
  )
    throw new Error("Required pushed authorization endpoint is unavailable");
  const state = oauth.generateRandomState();
  const verifier = oauth.generateRandomCodeVerifier();
  const challenge = await oauth.calculatePKCECodeChallenge(verifier);
  const dpopJwk = useDpop(input.discovery, input.dpop)
    ? await exportDpopJwk()
    : undefined;
  if (input.discovery.pushedAuthorizationRequestEndpoint) {
    try {
      return {
        location: await pushedAuthorizationLocation({
          discovery: input.discovery,
          clientId: input.clientId,
          redirectUri: input.redirectUri,
          scope: input.scope,
          state,
          challenge,
          ...(dpopJwk ? { dpopJwk } : {}),
          ...(input.authorizationParams
            ? { authorizationParams: input.authorizationParams }
            : {}),
          ...(input.clientAuth ? { clientAuth: input.clientAuth } : {}),
          ...(input.fetch ? { fetch: input.fetch } : {}),
        }),
        state,
        verifier,
        ...(dpopJwk ? { dpopJwk } : {}),
      };
    } catch (error) {
      if (input.discovery.requirePushedAuthorizationRequests) throw error;
      /* Fall through to a query authorization request. */
    }
  }
  const authorize = new URL(input.discovery.authorizationEndpoint);
  applyAuthorizationParams(authorize.searchParams, input.authorizationParams);
  authorize.searchParams.set("response_type", "code");
  authorize.searchParams.set("client_id", input.clientId);
  authorize.searchParams.set("redirect_uri", input.redirectUri);
  authorize.searchParams.set("state", state);
  authorize.searchParams.set("code_challenge", challenge);
  authorize.searchParams.set("code_challenge_method", "S256");
  authorize.searchParams.set("scope", input.scope);
  return {
    location: authorize.href,
    state,
    verifier,
    ...(dpopJwk ? { dpopJwk } : {}),
  };
}

export async function exchangeAuthorizationCode(input: {
  discovery: {
    issuer?: string | undefined;
    origin: string;
    authorizationEndpoint: string;
    tokenEndpoint: string;
    pushedAuthorizationRequestEndpoint?: string | undefined;
  };
  clientId: string;
  redirectUri: string;
  callbackUrl: string;
  verifier: string;
  state: string;
  dpopJwk?: JsonWebKey;
  clientAuth?: ClientAuthentication;
  fetch?: typeof fetch;
}) {
  const as = asMetadata(input.discovery);
  const [client, clientAuth] = oauthClient(input.clientId, input.clientAuth);
  const callback = oauth.validateAuthResponse(
    as,
    client,
    new URL(input.callbackUrl),
    input.state,
  );
  const DPoP = input.dpopJwk
    ? oauth.DPoP(client, await importDpopPair(input.dpopJwk))
    : undefined;
  const execute = () =>
    oauth.authorizationCodeGrantRequest(
      as,
      client,
      clientAuth,
      callback,
      input.redirectUri,
      input.verifier,
      {
        ...(DPoP ? { DPoP } : {}),
        [oauth.customFetch]: input.fetch ?? publicAuthFetch,
      },
    );
  let response = await execute();
  try {
    return await oauth.processAuthorizationCodeResponse(as, client, response);
  } catch (error) {
    if (!oauth.isDPoPNonceError(error)) throw error;
    response = await execute();
    return await oauth.processAuthorizationCodeResponse(as, client, response);
  }
}
