import { createHash, randomBytes } from "node:crypto";
import { decodeJwt } from "jose";
import { z } from "zod";
import { VERCEL_CONNECT_PROVIDER_REDIRECT_URI } from "./contracts.js";

/*
 * The provider-facing side: what a service must support so that Vercel
 * Connect can discover, register and authorize against it (docs/connect/
 * providers, retrieved 2026-09-18). The harness plays the Connect client
 * against an authorization server the host controls and reports each
 * documented requirement as met, not met or unknown. It never follows a
 * redirect on its own, never invents an endpoint, and needs a driver for the
 * one step Connect also leaves to a person: consent.
 */

export type ConformanceTier = "required" | "recommended" | "optional";
export type ConformanceStatus = "met" | "not-met" | "unknown";
export type ConformanceFinding = {
  id: string;
  tier: ConformanceTier;
  status: ConformanceStatus;
  detail: string;
};

const metadataSchema = z
  .object({
    issuer: z.string(),
    authorization_endpoint: z.string().optional(),
    token_endpoint: z.string(),
    registration_endpoint: z.string().optional(),
    revocation_endpoint: z.string().optional(),
    jwks_uri: z.string().optional(),
    userinfo_endpoint: z.string().optional(),
    grant_types_supported: z.array(z.string()).optional(),
    token_endpoint_auth_methods_supported: z.array(z.string()).optional(),
    token_endpoint_auth_signing_alg_values_supported: z
      .array(z.string())
      .optional(),
    code_challenge_methods_supported: z.array(z.string()).optional(),
    scopes_supported: z.array(z.string()).optional(),
    authorization_details_types_supported: z.array(z.string()).optional(),
    client_id_metadata_document_supported: z.boolean().optional(),
  })
  .loose();
export type AuthorizationServerMetadata = z.infer<typeof metadataSchema>;

const registrationSchema = z
  .object({
    client_id: z.string(),
    client_secret: z.string().optional(),
    token_endpoint_auth_method: z.string().optional(),
    registration_access_token: z.string().optional(),
    registration_client_uri: z.string().optional(),
    redirect_uris: z.array(z.string()).optional(),
  })
  .loose();

const tokenSchema = z
  .object({
    access_token: z.string(),
    token_type: z.string(),
    expires_in: z.number().optional(),
    refresh_token: z.string().optional(),
    scope: z.string().optional(),
  })
  .loose();

export type ConformanceExercise = {
  /** Drives the human step: opens the authorization URL and returns the callback URL it produced. */
  authorize(url: URL): Promise<URL>;
  resource?: string;
  scope?: string;
};

export type ProviderConformanceReport = {
  serverUrl: string;
  issuer?: string;
  discovery: {
    oauth?: string;
    oidc?: string;
    issuerConsistent: boolean;
    tokenEndpointConsistent: boolean;
  };
  subjectTypes: string[];
  findings: ConformanceFinding[];
  exercise?: {
    clientId?: string;
    codeExchanged: boolean;
    expiresIn?: number;
    refreshTokenIssued: boolean;
    refreshGrantAccepted?: boolean;
    refreshTokenRotated?: boolean;
    resourceHonored?: boolean;
    failure?: string;
  };
};

const subjectTypeByGrant: Record<string, string> = {
  authorization_code: "user",
  client_credentials: "app",
  "urn:ietf:params:oauth:grant-type:jwt-bearer": "jwt-bearer",
};
const usableAuthMethods = [
  "client_secret_basic",
  "client_secret_post",
  "none",
  "private_key_jwt",
];

/** RFC 8414 §3.1 and OpenID Connect discovery locations for an issuer that may carry a path. */
export function discoveryLocations(serverUrl: string): {
  oauth: string[];
  oidc: string[];
} {
  const url = new URL(serverUrl);
  const path = url.pathname.replace(/\/+$/, "");
  const origin = url.origin;
  if (!path)
    return {
      oauth: [`${origin}/.well-known/oauth-authorization-server`],
      oidc: [`${origin}/.well-known/openid-configuration`],
    };
  return {
    oauth: [`${origin}/.well-known/oauth-authorization-server${path}`],
    oidc: [
      `${origin}${path}/.well-known/openid-configuration`,
      `${origin}/.well-known/openid-configuration${path}`,
    ],
  };
}

async function fetchMetadata(
  fetchImpl: typeof fetch,
  url: string,
  signal: AbortSignal | undefined,
): Promise<AuthorizationServerMetadata | undefined> {
  try {
    const response = await fetchImpl(url, {
      headers: { accept: "application/json" },
      redirect: "error",
      ...(signal ? { signal } : {}),
    });
    if (!response.ok) return undefined;
    if (!/json/i.test(response.headers.get("content-type") ?? ""))
      return undefined;
    const parsed = metadataSchema.safeParse(await response.json());
    return parsed.success ? parsed.data : undefined;
  } catch {
    return undefined;
  }
}

export async function assessConnectProviderConformance(input: {
  serverUrl: string;
  fetch: typeof fetch;
  signal?: AbortSignal;
  redirectUri?: string;
  exercise?: ConformanceExercise;
}): Promise<ProviderConformanceReport> {
  const redirectUri = input.redirectUri ?? VERCEL_CONNECT_PROVIDER_REDIRECT_URI;
  const findings: ConformanceFinding[] = [];
  const finding = (
    id: string,
    tier: ConformanceTier,
    status: ConformanceStatus,
    detail: string,
  ) => findings.push({ id, tier, status, detail });
  const locations = discoveryLocations(input.serverUrl);
  let oauth: AuthorizationServerMetadata | undefined;
  let oauthAt: string | undefined;
  for (const url of locations.oauth) {
    oauth = await fetchMetadata(input.fetch, url, input.signal);
    if (oauth) {
      oauthAt = url;
      break;
    }
  }
  let oidc: AuthorizationServerMetadata | undefined;
  let oidcAt: string | undefined;
  for (const url of locations.oidc) {
    oidc = await fetchMetadata(input.fetch, url, input.signal);
    if (oidc) {
      oidcAt = url;
      break;
    }
  }
  const issuerConsistent = !oauth || !oidc || oauth.issuer === oidc.issuer;
  const tokenEndpointConsistent =
    !oauth || !oidc || oauth.token_endpoint === oidc.token_endpoint;
  // The OAuth document leads; the OpenID Connect document fills its gaps.
  const merged: AuthorizationServerMetadata | undefined =
    oauth && oidc ? { ...oidc, ...oauth } : (oauth ?? oidc);
  const report: ProviderConformanceReport = {
    serverUrl: input.serverUrl,
    ...(merged ? { issuer: merged.issuer } : {}),
    discovery: {
      ...(oauthAt ? { oauth: oauthAt } : {}),
      ...(oidcAt ? { oidc: oidcAt } : {}),
      issuerConsistent,
      tokenEndpointConsistent,
    },
    subjectTypes: [],
    findings,
  };
  finding(
    "required.discovery-documents",
    "required",
    merged ? "met" : "not-met",
    merged
      ? `metadata served as application/json at ${[oauthAt, oidcAt].filter(Boolean).join(" and ")}`
      : "no RFC 8414 or OpenID Connect discovery document was found",
  );
  if (!merged) return report;
  finding(
    "required.issuer-consistency",
    "required",
    issuerConsistent && tokenEndpointConsistent ? "met" : "not-met",
    oauth && oidc
      ? "both documents declare the same issuer and token_endpoint"
      : "only one document is published; consistency is trivially satisfied",
  );
  finding("required.token-endpoint", "required", "met", merged.token_endpoint);
  const grants = merged.grant_types_supported ?? [];
  report.subjectTypes = grants
    .map((grant) => subjectTypeByGrant[grant])
    .filter((value): value is string => value !== undefined);
  finding(
    "required.grant-types-declared",
    "required",
    merged.grant_types_supported ? "met" : "not-met",
    merged.grant_types_supported
      ? `grant_types_supported=${grants.join(",")} -> subject types ${report.subjectTypes.join(",") || "none"}`
      : "grant_types_supported is absent, so no subject type would appear on the connector",
  );
  const authMethods = merged.token_endpoint_auth_methods_supported ?? [];
  const dcr =
    merged.registration_endpoint !== undefined &&
    authMethods.some((method) => usableAuthMethods.includes(method));
  const pkceS256 = (merged.code_challenge_methods_supported ?? []).includes(
    "S256",
  );
  const cimd =
    merged.client_id_metadata_document_supported === true &&
    (authMethods.includes("private_key_jwt") ||
      (authMethods.includes("none") && pkceS256));
  finding(
    "recommended.client-registration",
    "recommended",
    dcr || cimd ? "met" : "not-met",
    dcr
      ? `dynamic client registration at ${merged.registration_endpoint} with ${authMethods.join(",")}`
      : cimd
        ? "client ID metadata documents are supported"
        : "neither DCR with a usable token_endpoint_auth_method nor CIMD is declared; users must register a client by hand",
  );
  finding(
    "recommended.pkce-s256",
    "recommended",
    pkceS256 ? "met" : "not-met",
    `code_challenge_methods_supported=${(merged.code_challenge_methods_supported ?? []).join(",") || "absent"}`,
  );
  const refreshDeclared = grants.includes("refresh_token");
  finding(
    "optional.revocation",
    "optional",
    merged.revocation_endpoint ? "met" : "not-met",
    merged.revocation_endpoint ??
      "no revocation_endpoint; revocation only removes Vercel's stored copy",
  );
  finding(
    "optional.scopes-published",
    "optional",
    merged.scopes_supported?.length ? "met" : "not-met",
    `scopes_supported=${(merged.scopes_supported ?? []).join(",") || "absent"}`,
  );
  finding(
    "optional.rich-authorization-requests",
    "optional",
    merged.authorization_details_types_supported?.length ? "met" : "not-met",
    `authorization_details_types_supported=${(merged.authorization_details_types_supported ?? []).join(",") || "absent"}`,
  );
  const prm = await (async () => {
    try {
      const url = new URL(input.serverUrl);
      const response = await input.fetch(
        `${url.origin}/.well-known/oauth-protected-resource${url.pathname.replace(/\/+$/, "")}`,
        {
          headers: { accept: "application/json" },
          redirect: "error",
          ...(input.signal ? { signal: input.signal } : {}),
        },
      );
      if (!response.ok) return false;
      const body = z
        .object({ authorization_servers: z.array(z.string()).min(1) })
        .loose()
        .safeParse(await response.json());
      return body.success;
    } catch {
      return false;
    }
  })();
  finding(
    "optional.protected-resource-metadata",
    "optional",
    prm ? "met" : "not-met",
    prm
      ? "RFC 9728 metadata names at least one authorization server"
      : "no RFC 9728 protected resource metadata at the well-known location",
  );

  if (!input.exercise || !merged.authorization_endpoint) {
    finding(
      "required.redirect-url-accepted",
      "required",
      "unknown",
      "not exercised",
    );
    finding("required.expires-in", "required", "unknown", "not exercised");
    finding(
      "recommended.refresh-tokens",
      "recommended",
      refreshDeclared ? "unknown" : "not-met",
      refreshDeclared
        ? "declared; refresh not exercised"
        : "refresh_token is not in grant_types_supported",
    );
    finding(
      "recommended.rfc7592-client-update",
      "recommended",
      "unknown",
      "not exercised",
    );
    finding(
      "optional.resource-indicators",
      "optional",
      "unknown",
      "not exercised",
    );
    return report;
  }

  const exercise: NonNullable<ProviderConformanceReport["exercise"]> = {
    codeExchanged: false,
    refreshTokenIssued: false,
  };
  report.exercise = exercise;
  const fail = (message: string) => {
    exercise.failure = message;
    return report;
  };
  const post = async (
    url: string,
    body: URLSearchParams | string,
    json: boolean,
  ) =>
    input.fetch(url, {
      method: "POST",
      headers: {
        accept: "application/json",
        "content-type": json
          ? "application/json"
          : "application/x-www-form-urlencoded",
      },
      body: typeof body === "string" ? body : body.toString(),
      redirect: "error",
      ...(input.signal ? { signal: input.signal } : {}),
    });

  // Client registration with the exact Connect callback URL.
  let clientId: string | undefined;
  let clientSecret: string | undefined;
  let authMethod = authMethods.includes("none")
    ? "none"
    : authMethods.includes("client_secret_post")
      ? "client_secret_post"
      : "client_secret_basic";
  if (merged.registration_endpoint) {
    const response = await post(
      merged.registration_endpoint,
      JSON.stringify({
        client_name: "Vercel Connect conformance harness",
        redirect_uris: [redirectUri],
        grant_types: refreshDeclared
          ? ["authorization_code", "refresh_token"]
          : ["authorization_code"],
        response_types: ["code"],
        token_endpoint_auth_method: authMethod,
      }),
      true,
    );
    const body = response.ok
      ? registrationSchema.safeParse(await response.json())
      : undefined;
    if (!body?.success) {
      finding(
        "required.redirect-url-accepted",
        "required",
        "not-met",
        `registration with ${redirectUri} failed (${response.status})`,
      );
      return fail("client registration failed");
    }
    clientId = body.data.client_id;
    clientSecret = body.data.client_secret;
    authMethod = body.data.token_endpoint_auth_method ?? authMethod;
    exercise.clientId = clientId;
    finding(
      "required.redirect-url-accepted",
      "required",
      body.data.redirect_uris === undefined
        ? "unknown"
        : body.data.redirect_uris.includes(redirectUri)
          ? "met"
          : "not-met",
      body.data.redirect_uris === undefined
        ? `registration accepted ${redirectUri} but echoed no redirect_uris, so acceptance is unconfirmed`
        : `registered redirect_uris=${body.data.redirect_uris.join(",")}`,
    );
    finding(
      "recommended.rfc7592-client-update",
      "recommended",
      body.data.registration_access_token && body.data.registration_client_uri
        ? "met"
        : "not-met",
      body.data.registration_client_uri
        ? `registration_client_uri=${body.data.registration_client_uri}`
        : "registration returned no registration_access_token/registration_client_uri",
    );
  } else {
    finding(
      "required.redirect-url-accepted",
      "required",
      "unknown",
      "no registration endpoint; a pre-registered client would be needed",
    );
    finding(
      "recommended.rfc7592-client-update",
      "recommended",
      "not-met",
      "no registration endpoint",
    );
    return fail("no client available for the authorization exercise");
  }

  // Authorization code with PKCE (S256), state, and a resource indicator.
  const verifier = randomBytes(32).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  const state = randomBytes(16).toString("base64url");
  const authorizationUrl = new URL(merged.authorization_endpoint);
  authorizationUrl.searchParams.set("response_type", "code");
  authorizationUrl.searchParams.set("client_id", clientId);
  authorizationUrl.searchParams.set("redirect_uri", redirectUri);
  authorizationUrl.searchParams.set("state", state);
  if (pkceS256) {
    authorizationUrl.searchParams.set("code_challenge", challenge);
    authorizationUrl.searchParams.set("code_challenge_method", "S256");
  }
  const scope =
    input.exercise.scope ?? merged.scopes_supported?.slice(0, 3).join(" ");
  if (scope) authorizationUrl.searchParams.set("scope", scope);
  if (input.exercise.resource)
    authorizationUrl.searchParams.set("resource", input.exercise.resource);
  let callback: URL;
  try {
    callback = await input.exercise.authorize(authorizationUrl);
  } catch (error) {
    if (input.exercise.resource)
      finding(
        "optional.resource-indicators",
        "optional",
        "not-met",
        "the authorization request carrying a resource parameter was refused",
      );
    return fail(
      `authorization step failed: ${error instanceof Error ? error.message : "unknown"}`,
    );
  }
  const expected = new URL(redirectUri);
  if (
    callback.origin !== expected.origin ||
    callback.pathname !== expected.pathname
  )
    return fail("callback did not arrive at the registered redirect URL");
  if (callback.searchParams.get("state") !== state)
    return fail("state mismatch on callback");
  const code = callback.searchParams.get("code");
  if (!code)
    return fail(
      `callback carried no code (${callback.searchParams.get("error") ?? "no error"})`,
    );
  const issParam = callback.searchParams.get("iss");
  if (issParam !== null && issParam !== merged.issuer)
    return fail("callback iss does not match the issuer");

  const tokenRequest = new URLSearchParams({
    grant_type: "authorization_code",
    code,
    redirect_uri: redirectUri,
    client_id: clientId,
  });
  if (pkceS256) tokenRequest.set("code_verifier", verifier);
  if (input.exercise.resource)
    tokenRequest.set("resource", input.exercise.resource);
  if (clientSecret && authMethod === "client_secret_post")
    tokenRequest.set("client_secret", clientSecret);
  const tokenResponse = await input.fetch(merged.token_endpoint, {
    method: "POST",
    headers: {
      accept: "application/json",
      "content-type": "application/x-www-form-urlencoded",
      ...(clientSecret && authMethod === "client_secret_basic"
        ? {
            authorization: `Basic ${Buffer.from(`${encodeURIComponent(clientId)}:${encodeURIComponent(clientSecret)}`).toString("base64")}`,
          }
        : {}),
    },
    body: tokenRequest.toString(),
    redirect: "error",
    ...(input.signal ? { signal: input.signal } : {}),
  });
  const tokens = tokenResponse.ok
    ? tokenSchema.safeParse(await tokenResponse.json())
    : undefined;
  if (!tokens?.success)
    return fail(`code exchange failed (${tokenResponse.status})`);
  exercise.codeExchanged = true;
  if (tokens.data.expires_in !== undefined)
    exercise.expiresIn = tokens.data.expires_in;
  finding(
    "required.expires-in",
    "required",
    tokens.data.expires_in !== undefined ? "met" : "not-met",
    tokens.data.expires_in !== undefined
      ? `expires_in=${tokens.data.expires_in}`
      : "token response omits expires_in; Connect would infer a lifetime",
  );
  exercise.refreshTokenIssued = tokens.data.refresh_token !== undefined;
  if (tokens.data.refresh_token) {
    const refresh = new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: tokens.data.refresh_token,
      client_id: clientId,
    });
    if (clientSecret && authMethod === "client_secret_post")
      refresh.set("client_secret", clientSecret);
    const refreshed = await post(merged.token_endpoint, refresh, false);
    const body = refreshed.ok
      ? tokenSchema.safeParse(await refreshed.json())
      : undefined;
    exercise.refreshGrantAccepted = body?.success === true;
    if (body?.success)
      exercise.refreshTokenRotated =
        body.data.refresh_token !== undefined &&
        body.data.refresh_token !== tokens.data.refresh_token;
    finding(
      "recommended.refresh-tokens",
      "recommended",
      body?.success ? "met" : "not-met",
      body?.success
        ? `refresh grant accepted; rotation ${exercise.refreshTokenRotated ? "returned a new refresh token" : "kept the refresh token"}`
        : `a refresh token was issued but the refresh_token grant was rejected (${refreshed.status})${refreshDeclared ? " although grant_types_supported advertises it" : ""}`,
    );
  } else
    finding(
      "recommended.refresh-tokens",
      "recommended",
      "not-met",
      refreshDeclared
        ? "refresh_token is advertised but no refresh token was issued on the authorization code flow"
        : "no refresh token issued and refresh_token is not in grant_types_supported; every expiry needs a new authorization",
    );
  if (input.exercise.resource) {
    let honored: boolean | undefined;
    try {
      const aud = decodeJwt(tokens.data.access_token).aud;
      honored = (Array.isArray(aud) ? aud : aud ? [aud] : []).includes(
        input.exercise.resource,
      );
    } catch {
      honored = undefined;
    }
    if (honored !== undefined) exercise.resourceHonored = honored;
    finding(
      "optional.resource-indicators",
      "optional",
      honored === undefined ? "unknown" : honored ? "met" : "not-met",
      honored === undefined
        ? "the access token is opaque, so the resource audience cannot be confirmed from the client side"
        : honored
          ? "the access token audience equals the requested resource"
          : "the access token audience does not include the requested resource",
    );
  } else
    finding(
      "optional.resource-indicators",
      "optional",
      "unknown",
      "no resource requested",
    );
  return report;
}
