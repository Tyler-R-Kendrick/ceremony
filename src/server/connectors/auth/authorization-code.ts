import * as oauth from "oauth4webapi";
import type {
  AdapterCallContext,
  AuthorizationStart,
  CompletionResult,
  HandoffProposal,
} from "../adapter.js";
import { ConnectorError } from "../errors.js";
import type { CredentialScope, HandoffRecord } from "../ports.js";
import type { ResolvedClient } from "./client.js";
import type { ResolvedAuthorizationServer } from "./discovery.js";
import { assertHandoffCurrent } from "./handoff.js";
import type { IssuerPolicy } from "./policy.js";
import {
  accountIdentityClaim,
  authorizationDetailsParameter,
  credentialAcceptedClaim,
  permissionRecord,
  reportedAuthorizationDetails,
  resourceParameters,
  scopeEnforcement,
  type PermissionRecord,
  type ScopeEnforcement,
} from "./permissions.js";
import {
  joinScope,
  neverSent,
  requestOptions,
  sameSecret,
  sha256Hex,
  splitScope,
  tokenErrorDetail,
  wireError,
  type WireOptions,
} from "./wire.js";

/*
 * Authorization code with S256 PKCE, built on oauth4webapi (RFC 7636, RFC 9700,
 * OAuth 2.1 draft -16, RFC 9207 for the response `iss`, RFC 8707 for the
 * resource indicator, RFC 9126 when the issuer requires pushed requests).
 *
 * The private handoff record is the whole memory of an attempt: state,
 * verifier, redirect URI, issuer and client are read back from it, never from
 * the callback. A callback is accepted only for the exact registered redirect
 * URI, with exactly one `state` equal to the record's, with an `iss` equal to
 * the issuer when the issuer advertises one, for the current connection
 * generation, and only once per code: the effect journal is written before
 * the token request so a second delivery of the same code never reaches the
 * token endpoint again.
 */

export const AUTHORIZATION_CODE_INTENT = "oauth.authorization-code";
export const DEFAULT_HANDOFF_TTL_MS = 600_000;
export const OAUTH_CODE_EXCHANGE_OPERATION = "oauth.code.exchange";
export const OAUTH_REFRESH_OPERATION = "oauth.token.refresh";

const reservedAuthorizationParameters = new Set([
  "response_type",
  "client_id",
  "redirect_uri",
  "state",
  "code_challenge",
  "code_challenge_method",
  "scope",
  "nonce",
  "resource",
  "authorization_details",
  "request_uri",
  "request",
]);

/** The return route for provider callbacks, built from the deployment's exact origin only. */
export function callbackUri(
  ctx: Pick<AdapterCallContext, "environment">,
  path = "/api/v1/connectors/callback",
): string {
  if (
    !path.startsWith("/") ||
    path.startsWith("//") ||
    /[?#\s]/.test(path) ||
    path.split("/").includes("..")
  )
    throw new ConnectorError("invalid-request", {
      detail: "oauth.redirect-uri.path",
    });
  const origin = new URL(ctx.environment.origin).origin;
  if (origin !== ctx.environment.origin)
    throw new ConnectorError("configuration-required", {
      detail: "oauth.host-origin.invalid",
    });
  return `${origin}${path}`;
}

function assertHostRedirect(ctx: AdapterCallContext, redirectUri: string) {
  if (
    !URL.canParse(redirectUri) ||
    new URL(redirectUri).origin !== new URL(ctx.environment.origin).origin ||
    new URL(redirectUri).hash
  )
    throw new ConnectorError("invalid-request", {
      detail: "oauth.redirect-uri.origin",
    });
}

function wire(
  ctx: AdapterCallContext,
  allowLoopbackHttp: boolean,
): WireOptions {
  return {
    fetch: ctx.environment.fetch,
    signal: ctx.signal,
    allowLoopbackHttp,
  };
}

/** The custody scope credentials of this connection are stored under. */
export function credentialScopeFor(
  ctx: AdapterCallContext,
  handoff: Pick<HandoffRecord, "connectionRef" | "bindingRef">,
): CredentialScope {
  const connection = ctx.connection;
  if (connection)
    return {
      tenantId: connection.tenantId,
      ownerKind: connection.ownerKind,
      ownerId: connection.ownerId,
      connectionRef: connection.connectionRef,
      bindingRef: connection.bindingRef,
      custody: "host-owned",
    };
  return {
    tenantId: ctx.actor.tenantId,
    ownerKind: "user",
    ownerId: ctx.actor.subjectId,
    connectionRef: handoff.connectionRef,
    bindingRef: handoff.bindingRef,
    custody: "host-owned",
  };
}

export type BeginAuthorizationCodeInput = {
  server: ResolvedAuthorizationServer;
  client: ResolvedClient;
  policy: Pick<IssuerPolicy, "resource" | "pushedAuthorization">;
  scopes: readonly string[];
  profileId?: string | undefined;
  presentation?: HandoffProposal["presentation"] | undefined;
  expiresInMs?: number | undefined;
  authorizationDetails?: readonly Record<string, unknown>[] | undefined;
  /** Documented provider-profile parameters (prompt, access_type); host-authored, never caller-supplied. */
  extraParameters?: Record<string, string> | undefined;
};

/**
 * Starts the flow: state, verifier and the authorization URL are generated
 * here and returned only inside the handoff proposal's private material. A
 * PAR round trip happens when the issuer requires it or policy prefers it.
 */
export async function beginAuthorizationCode(
  ctx: AdapterCallContext,
  input: BeginAuthorizationCodeInput,
): Promise<AuthorizationStart> {
  const as = input.server.metadata;
  if (typeof as.authorization_endpoint !== "string")
    return {
      kind: "unsupported",
      code: "oauth.authorization-endpoint.missing",
    };
  if (typeof as.token_endpoint !== "string")
    return { kind: "unsupported", code: "oauth.token-endpoint.missing" };
  const methods = as.code_challenge_methods_supported;
  if (methods && !methods.includes("S256"))
    return { kind: "unsupported", code: "oauth.pkce.s256-unsupported" };
  if (
    as.require_pushed_authorization_requests === true &&
    typeof as.pushed_authorization_request_endpoint !== "string"
  )
    return { kind: "unsupported", code: "oauth.par.endpoint-missing" };
  assertHostRedirect(ctx, input.client.redirectUri);
  const client = input.client.client;
  const state = oauth.generateRandomState();
  const verifier = oauth.generateRandomCodeVerifier();
  const challenge = await oauth.calculatePKCECodeChallenge(verifier);
  const scopes = [...new Set(input.scopes)];
  const scope = joinScope(scopes);
  const nonce = scopes.includes("openid")
    ? oauth.generateRandomNonce()
    : undefined;
  const parameters = new URLSearchParams();
  for (const [name, value] of Object.entries(input.extraParameters ?? {}))
    if (!reservedAuthorizationParameters.has(name)) parameters.set(name, value);
  parameters.set("response_type", "code");
  parameters.set("client_id", client.client_id);
  parameters.set("redirect_uri", input.client.redirectUri);
  parameters.set("state", state);
  parameters.set("code_challenge", challenge);
  parameters.set("code_challenge_method", "S256");
  if (scope) parameters.set("scope", scope);
  if (nonce) parameters.set("nonce", nonce);
  for (const [name, value] of Object.entries({
    ...resourceParameters(input.policy.resource),
    ...authorizationDetailsParameter(input.authorizationDetails),
  }))
    parameters.set(name, value);
  const authorizationUrl = new URL(as.authorization_endpoint);
  const usePar =
    typeof as.pushed_authorization_request_endpoint === "string" &&
    (as.require_pushed_authorization_requests === true ||
      input.policy.pushedAuthorization === "prefer");
  if (usePar) {
    try {
      const response = await oauth.pushedAuthorizationRequest(
        as,
        client,
        input.client.authentication(),
        parameters,
        requestOptions(wire(ctx, input.server.allowLoopbackHttp)),
      );
      const pushed = await oauth.processPushedAuthorizationResponse(
        as,
        client,
        response,
      );
      authorizationUrl.searchParams.set("client_id", client.client_id);
      authorizationUrl.searchParams.set("request_uri", pushed.request_uri);
    } catch (error) {
      throw wireError(error, "oauth.par");
    }
  } else
    for (const [name, value] of parameters)
      authorizationUrl.searchParams.set(name, value);
  const expiresAt =
    ctx.environment.now() + (input.expiresInMs ?? DEFAULT_HANDOFF_TTL_MS);
  return {
    kind: "handoff",
    handoff: {
      kind: "provider-browser",
      presentation: input.presentation ?? "popup",
      expiresAt,
      intent: AUTHORIZATION_CODE_INTENT,
      correlationKey: state,
      private: {
        authorizationUrl: authorizationUrl.href,
        state,
        verifier,
        redirectUri: input.client.redirectUri,
        issuer: input.server.issuer,
        clientId: client.client_id,
        scope,
        ...(nonce !== undefined ? { nonce } : {}),
        ...(input.policy.resource !== undefined
          ? { resource: input.policy.resource }
          : {}),
        ...(input.profileId !== undefined
          ? { profileId: input.profileId }
          : {}),
      },
    },
  };
}

export type CompleteAuthorizationCodeInput = {
  /** The callback exactly as received by the host's redirect route. */
  url: URL;
  handoff: HandoffRecord;
  server: ResolvedAuthorizationServer;
  client: ResolvedClient;
  policy: Pick<IssuerPolicy, "resource" | "responseIssuerParameter">;
  scope?: CredentialScope | undefined;
};

type OpenHandoff = {
  state: string;
  verifier: string;
  redirectUri: string;
  issuer: string;
  clientId: string;
  scope: string;
  nonce: string | undefined;
  resource: string | undefined;
};

function openHandoff(handoff: HandoffRecord): OpenHandoff {
  const p = handoff.private;
  const state = p["state"];
  const verifier = p["verifier"];
  const redirectUri = p["redirectUri"];
  const issuer = p["issuer"];
  const clientId = p["clientId"];
  if (!state || !verifier || !redirectUri || !issuer || !clientId)
    throw new ConnectorError("invalid-request", {
      detail: "oauth.handoff.private-missing",
    });
  return {
    state,
    verifier,
    redirectUri,
    issuer,
    clientId,
    scope: p["scope"] ?? "",
    nonce: p["nonce"],
    resource: p["resource"],
  };
}

async function finishHandoff(
  ctx: AdapterCallContext,
  handoff: HandoffRecord,
  state: "completed" | "denied" | "expired",
): Promise<void> {
  try {
    await ctx.environment.handoffs.complete(
      handoff.handoffRef,
      ctx.generation,
      state,
    );
  } catch (error) {
    throw new ConnectorError("conflict", {
      detail: "oauth.handoff.stale-generation",
      cause: error,
    });
  }
}

async function revokeQuietly(
  ctx: AdapterCallContext,
  input: Pick<CompleteAuthorizationCodeInput, "server" | "client">,
  tokens: oauth.TokenEndpointResponse,
): Promise<void> {
  const endpoint = input.server.metadata.revocation_endpoint;
  if (typeof endpoint !== "string") return;
  for (const token of [tokens.refresh_token, tokens.access_token])
    if (token)
      try {
        await oauth.revocationRequest(
          input.server.metadata,
          input.client.client,
          input.client.authentication(),
          token,
          requestOptions(wire(ctx, input.server.allowLoopbackHttp)),
        );
      } catch {
        /* Best effort: the grant is already unreachable from this connection. */
      }
}

/**
 * Validates a provider callback against the private handoff record and, once
 * and only once per code, exchanges it. Failure modes are distinct results or
 * codes: denial (`denied`), expiry (`expired`), an unverifiable exchange
 * (`indeterminate`), and refusals thrown as ConnectorError (`denied` for a
 * callback that belongs elsewhere, `conflict` for a stale generation or a
 * duplicate code, `cancelled` after unlink).
 */
export async function completeAuthorizationCode(
  ctx: AdapterCallContext,
  input: CompleteAuthorizationCodeInput,
): Promise<CompletionResult> {
  const { handoff, url } = input;
  if (
    handoff.kind !== "provider-browser" ||
    handoff.intent !== AUTHORIZATION_CODE_INTENT
  )
    throw new ConnectorError("invalid-request", {
      detail: "oauth.handoff.kind",
    });
  if (assertHandoffCurrent(ctx, handoff) === "expired") {
    await finishHandoff(ctx, handoff, "expired");
    return { state: "expired", claims: [], code: "oauth.handoff.expired" };
  }
  const open = openHandoff(handoff);
  const as = input.server.metadata;
  // The callback must belong to this issuer, this client and this redirect
  // URI: a record for another association is refused before anything else.
  if (
    open.issuer !== input.server.issuer ||
    open.clientId !== input.client.client.client_id ||
    open.redirectUri !== input.client.redirectUri
  )
    throw new ConnectorError("denied", {
      detail: "oauth.callback.binding-mismatch",
    });
  const registered = new URL(open.redirectUri);
  if (url.origin !== registered.origin || url.pathname !== registered.pathname)
    throw new ConnectorError("denied", {
      detail: "oauth.callback.redirect-uri",
    });
  const states = url.searchParams.getAll("state");
  if (states.length !== 1 || !sameSecret(states[0]!, open.state))
    throw new ConnectorError("denied", { detail: "oauth.callback.state" });
  // RFC 9207: exact comparison; the issuer's spelling is the only spelling.
  const issuers = url.searchParams.getAll("iss");
  if (issuers.length > 1)
    throw new ConnectorError("denied", { detail: "oauth.callback.issuer" });
  if (
    issuers.length === 0 &&
    (as.authorization_response_iss_parameter_supported === true ||
      input.policy.responseIssuerParameter === "required")
  )
    throw new ConnectorError("denied", {
      detail: "oauth.callback.issuer-missing",
    });
  if (issuers.length === 1 && issuers[0] !== input.server.issuer)
    throw new ConnectorError("denied", {
      detail: "oauth.callback.issuer-mismatch",
    });
  const error = url.searchParams.get("error");
  if (error !== null) {
    await finishHandoff(ctx, handoff, "denied");
    return {
      state: "denied",
      claims: [],
      code:
        error === "access_denied"
          ? "oauth.callback.access-denied"
          : tokenErrorDetail(error).replace("oauth.token.", "oauth.callback."),
    };
  }
  const codes = url.searchParams.getAll("code");
  if (codes.length !== 1 || !codes[0])
    throw new ConnectorError("denied", { detail: "oauth.callback.code" });
  const scope = input.scope ?? credentialScopeFor(ctx, handoff);
  const begun = await ctx.environment.effects.begin({
    actor: ctx.actor,
    connectionRef: scope.connectionRef,
    bindingRef: scope.bindingRef,
    operation: OAUTH_CODE_EXCHANGE_OPERATION,
    digest: sha256Hex(open.issuer, open.clientId, open.redirectUri, codes[0]),
  });
  if (begun.prior)
    throw new ConnectorError("conflict", {
      detail: `oauth.code.duplicate-${begun.prior.status}`,
    });
  const now = () => ctx.environment.now();
  let parameters: URLSearchParams;
  try {
    parameters = oauth.validateAuthResponse(
      as,
      input.client.client,
      url,
      open.state,
    );
  } catch (failure) {
    await ctx.environment.effects.complete(begun.effectRef, {
      status: "not-applied",
      code: "oauth.callback.invalid",
      at: now(),
    });
    throw wireError(failure, "oauth.callback");
  }
  let tokens: oauth.TokenEndpointResponse;
  try {
    const transport = requestOptions(wire(ctx, input.server.allowLoopbackHttp));
    const response = await oauth.authorizationCodeGrantRequest(
      as,
      input.client.client,
      input.client.authentication(),
      parameters,
      open.redirectUri,
      open.verifier,
      {
        ...transport,
        additionalParameters: resourceParameters(open.resource),
      },
    );
    tokens = await oauth.processAuthorizationCodeResponse(
      as,
      input.client.client,
      response,
      { expectedNonce: open.nonce ?? oauth.expectNoNonce },
    );
    /*
     * `processAuthorizationCodeResponse` validates an ID token's claims but not
     * its signature: oauth4webapi makes that a separate, explicit step, on the
     * reasoning that TLS to the issuer's own token endpoint already establishes
     * who answered. That reasoning does not hold here. `trustedEndpoint` admits
     * a `token_endpoint` on an origin the issuer merely declared, so TLS to it
     * proves only that that origin answered -- and this subject becomes the
     * connection's identity, its `target` and its external id. Unverified, any
     * origin that can serve the token endpoint mints whichever account it likes.
     *
     * This deployment's own sign-in path already validates the signature. A
     * connector identity is held to the same standard.
     */
    if (oauth.getValidatedIdTokenClaims(tokens) !== undefined)
      try {
        await oauth.validateApplicationLevelSignature(as, response, transport);
      } catch (failure) {
        // Every reason this can fail is the same answer: the identity in the
        // token is not proven to be the issuer's. A bad signature, an algorithm
        // outside the allowlist, and no published keys to check it against all
        // refuse the grant. Raised as a protocol failure because the response
        // did arrive and the code is spent -- not as an uncertain effect.
        throw new oauth.OperationProcessingError(
          "ID Token signature was not validated",
          { cause: failure },
        );
      }
  } catch (failure) {
    if (neverSent(failure)) {
      await ctx.environment.effects.complete(begun.effectRef, {
        status: "not-applied",
        code: "oauth.token.unreachable",
        at: now(),
      });
      throw wireError(failure, "oauth.token");
    }
    if (failure instanceof oauth.ResponseBodyError) {
      await ctx.environment.effects.complete(begun.effectRef, {
        status: "failed",
        code: tokenErrorDetail(failure.error),
        at: now(),
      });
      await finishHandoff(ctx, handoff, "denied");
      throw wireError(failure, "oauth.token");
    }
    if (
      failure instanceof oauth.OperationProcessingError ||
      failure instanceof oauth.UnsupportedOperationError
    ) {
      // A response arrived and was read: the code is spent, and the failure is
      // the issuer's protocol violation rather than an uncertain effect.
      await ctx.environment.effects.complete(begun.effectRef, {
        status: "failed",
        code: "oauth.token.invalid-response",
        at: now(),
      });
      await finishHandoff(ctx, handoff, "denied");
      throw wireError(failure, "oauth.token");
    }
    // The request may have reached the issuer and consumed the code.
    await ctx.environment.effects.complete(begun.effectRef, {
      status: "indeterminate",
      code: "oauth.token.indeterminate",
      at: now(),
    });
    return {
      state: "indeterminate",
      claims: [],
      code: "oauth.token.indeterminate",
    };
  }
  // Tokens exist now. The handoff is completed first, fenced by generation:
  // if the connection moved on meanwhile, the tokens are discarded (and
  // revoked when the issuer allows) rather than bound to a newer generation.
  try {
    await finishHandoff(ctx, handoff, "completed");
  } catch (failure) {
    await ctx.environment.effects.complete(begun.effectRef, {
      status: "applied",
      code: "oauth.code.discarded-stale",
      at: now(),
    });
    await revokeQuietly(ctx, input, tokens);
    throw failure;
  }
  const expiresAt =
    typeof tokens.expires_in === "number" && tokens.expires_in > 0
      ? now() + tokens.expires_in * 1000
      : undefined;
  const credentialRef = await ctx.environment.credentials.store(
    scope,
    {
      access_token: tokens.access_token,
      token_type: tokens.token_type,
      ...(tokens.refresh_token ? { refresh_token: tokens.refresh_token } : {}),
      ...(tokens.scope !== undefined ? { scope: tokens.scope } : {}),
      issuer: open.issuer,
      client_id: open.clientId,
      ...(open.resource !== undefined ? { resource: open.resource } : {}),
      ...(expiresAt !== undefined ? { expires_at: String(expiresAt) } : {}),
    },
    expiresAt !== undefined ? { expiresAt } : {},
  );
  await ctx.environment.effects.complete(begun.effectRef, {
    status: "applied",
    at: now(),
  });
  const reported = [
    ...splitScope(tokens.scope),
    ...reportedAuthorizationDetails(tokens.authorization_details),
  ];
  const permissions = permissionRecord({
    requested: splitScope(open.scope),
    reported,
    source: reported.length ? "token-response" : "none",
  });
  const claims = [
    credentialAcceptedClaim(ctx, {
      issuer: open.issuer,
      permissions,
      validUntil: expiresAt,
    }),
  ];
  const idToken = oauth.getValidatedIdTokenClaims(tokens);
  if (idToken)
    claims.push(
      accountIdentityClaim(ctx, {
        issuer: open.issuer,
        subject: idToken.sub,
        subjectKind: "oidc-subject",
        validUntil: idToken.exp * 1000,
      }),
    );
  return {
    state: "complete",
    claims,
    credentialRef,
    ...(idToken
      ? {
          target: { kind: "oidc-subject", id: idToken.sub },
          externalIds: { subject: idToken.sub },
        }
      : {}),
    adapterState: {
      tokenType: tokens.token_type,
      ...(expiresAt !== undefined ? { expiresAt } : {}),
      enforcement: scopeEnforcement(permissions).enforcement,
    },
  };
}

export type RefreshAccessTokenInput = {
  server: ResolvedAuthorizationServer;
  client: ResolvedClient;
  policy: Pick<IssuerPolicy, "resource">;
  credentialRef: string;
  scope: CredentialScope;
  /** A narrower scope to request on refresh (RFC 6749 §6); never wider than the grant. */
  scopes?: readonly string[] | undefined;
};

export type RefreshOutcome = {
  credentialRef: string;
  expiresAt?: number;
  /** True when this call joined another worker's in-flight refresh and did not see the response itself. */
  shared: boolean;
  rotated?: boolean;
  permissions?: PermissionRecord;
  enforcement?: ScopeEnforcement;
};

/**
 * Refreshes under the custody port's single-flight lock, so concurrent workers
 * make one upstream request and a result computed against an older generation
 * cannot overwrite a newer credential. With rotating refresh tokens the new
 * token replaces the old one in the same write. A refresh token that was
 * already presented, or whose outcome is unknown, is never presented again:
 * issuers treat reuse as theft and revoke the whole grant.
 */
export async function refreshAccessToken(
  ctx: AdapterCallContext,
  input: RefreshAccessTokenInput,
): Promise<RefreshOutcome> {
  const as = input.server.metadata;
  if (typeof as.token_endpoint !== "string")
    throw new ConnectorError("unsupported", {
      detail: "oauth.token-endpoint.missing",
    });
  let observed: { rotated: boolean; permissions: PermissionRecord } | undefined;
  let result: { ref: string; expiresAt?: number };
  try {
    result = await ctx.environment.credentials.refresh(
      input.scope,
      input.credentialRef,
      async (current) => {
        const refreshToken = current["refresh_token"];
        if (!refreshToken)
          throw new ConnectorError("unsupported", {
            detail: "oauth.refresh.no-refresh-token",
          });
        if (
          current["issuer"] !== undefined &&
          current["issuer"] !== input.server.issuer
        )
          throw new ConnectorError("denied", {
            detail: "oauth.refresh.issuer-mismatch",
          });
        if (
          current["client_id"] !== undefined &&
          current["client_id"] !== input.client.client.client_id
        )
          throw new ConnectorError("denied", {
            detail: "oauth.refresh.client-mismatch",
          });
        const begun = await ctx.environment.effects.begin({
          actor: ctx.actor,
          connectionRef: input.scope.connectionRef,
          bindingRef: input.scope.bindingRef,
          operation: OAUTH_REFRESH_OPERATION,
          digest: sha256Hex(
            "refresh",
            input.server.issuer,
            input.client.client.client_id,
            refreshToken,
          ),
        });
        if (begun.prior && begun.prior.status !== "not-applied")
          throw new ConnectorError(
            begun.prior.status === "applied" ? "conflict" : "indeterminate",
            { detail: "oauth.refresh.already-used" },
          );
        const now = () => ctx.environment.now();
        try {
          const response = await oauth.refreshTokenGrantRequest(
            as,
            input.client.client,
            input.client.authentication(),
            refreshToken,
            {
              ...requestOptions(wire(ctx, input.server.allowLoopbackHttp)),
              additionalParameters: {
                ...resourceParameters(
                  current["resource"] ?? input.policy.resource,
                ),
                ...(input.scopes ? { scope: joinScope(input.scopes) } : {}),
              },
            },
          );
          const tokens = await oauth.processRefreshTokenResponse(
            as,
            input.client.client,
            response,
          );
          await ctx.environment.effects.complete(begun.effectRef, {
            status: "applied",
            at: now(),
          });
          const requested =
            input.scopes !== undefined
              ? [...input.scopes]
              : splitScope(current["scope"]);
          observed = {
            rotated:
              tokens.refresh_token !== undefined &&
              tokens.refresh_token !== refreshToken,
            permissions: permissionRecord({
              requested,
              reported: splitScope(tokens.scope),
              source: tokens.scope !== undefined ? "token-response" : "none",
            }),
          };
          const expiresAt =
            typeof tokens.expires_in === "number" && tokens.expires_in > 0
              ? now() + tokens.expires_in * 1000
              : undefined;
          const material: Record<string, string> = {
            ...current,
            access_token: tokens.access_token,
            token_type: tokens.token_type,
            refresh_token: tokens.refresh_token ?? refreshToken,
          };
          if (tokens.scope !== undefined) material["scope"] = tokens.scope;
          if (expiresAt !== undefined)
            material["expires_at"] = String(expiresAt);
          else delete material["expires_at"];
          return {
            material,
            ...(expiresAt !== undefined ? { expiresAt } : {}),
          };
        } catch (failure) {
          if (failure instanceof ConnectorError) throw failure;
          if (neverSent(failure)) {
            await ctx.environment.effects.complete(begun.effectRef, {
              status: "not-applied",
              code: "oauth.refresh.unreachable",
              at: now(),
            });
            throw wireError(failure, "oauth.refresh");
          }
          if (failure instanceof oauth.ResponseBodyError) {
            await ctx.environment.effects.complete(begun.effectRef, {
              status: "failed",
              code: tokenErrorDetail(failure.error),
              at: now(),
            });
            throw wireError(failure, "oauth.refresh");
          }
          await ctx.environment.effects.complete(begun.effectRef, {
            status: "indeterminate",
            code: "oauth.refresh.indeterminate",
            at: now(),
          });
          throw new ConnectorError("indeterminate", {
            detail: "oauth.refresh.indeterminate",
            cause: failure,
          });
        }
      },
    );
  } catch (failure) {
    if (failure instanceof ConnectorError) throw failure;
    throw new ConnectorError("conflict", {
      detail: "oauth.refresh.custody",
      cause: failure,
    });
  }
  const seen = observed as
    { rotated: boolean; permissions: PermissionRecord } | undefined;
  return {
    credentialRef: result.ref,
    ...(result.expiresAt !== undefined ? { expiresAt: result.expiresAt } : {}),
    shared: seen === undefined,
    ...(seen
      ? {
          rotated: seen.rotated,
          permissions: seen.permissions,
          enforcement: scopeEnforcement(seen.permissions),
        }
      : {}),
  };
}
