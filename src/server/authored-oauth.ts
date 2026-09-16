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
  fetch?: typeof fetch;
}) {
  const as = asMetadata(input.discovery);
  const client: oauth.Client = {
    client_id: input.clientId,
    token_endpoint_auth_method: "none",
  };
  const DPoP = input.dpopJwk
    ? oauth.DPoP(client, await importDpopPair(input.dpopJwk))
    : undefined;
  const parameters = new URLSearchParams({
    response_type: "code",
    client_id: input.clientId,
    redirect_uri: input.redirectUri,
    scope: input.scope,
    state: input.state,
    code_challenge: input.challenge,
    code_challenge_method: "S256",
  });
  const execute = () =>
    oauth.pushedAuthorizationRequest(as, client, oauth.None(), parameters, {
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
  fetch?: typeof fetch;
}) {
  const as = asMetadata(input.discovery);
  const client: oauth.Client = {
    client_id: input.clientId,
    token_endpoint_auth_method: "none",
  };
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
      oauth.None(),
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
