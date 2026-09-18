import {
  createRemoteJWKSet,
  customFetch as joseFetch,
  decodeProtectedHeader,
  jwtVerify,
  type JWTPayload,
} from "jose";
import * as oauth from "oauth4webapi";
import type { AdapterCallContext } from "../adapter.js";
import type { VerificationClaim } from "../adapter-types.js";
import { ConnectorError } from "../errors.js";
import type { CredentialScope } from "../ports.js";
import type { ResolvedClient } from "./client.js";
import type { ResolvedAuthorizationServer } from "./discovery.js";
import { tokenTypeIdentifiers, type IssuerPolicy } from "./policy.js";
import {
  accountIdentityClaim,
  credentialAcceptedClaim,
  permissionRecord,
  type PermissionRecord,
} from "./permissions.js";
import {
  boundedSignal,
  DEFAULT_TIMEOUT_MS,
  neverSent,
  requestOptions,
  sha256Hex,
  splitScope,
  wireError,
} from "./wire.js";

/*
 * RFC 8693 token exchange behind an explicit, host-authorized port. No policy
 * means no exchange: the port cannot be constructed for an issuer whose policy
 * does not enable it (AC-AUTH-05). The token that comes back is verified, not
 * decoded and believed: exact issuer, an audience that names the intended
 * target, the expected subject when the profile requires one, the expected
 * actor when an actor token was presented, and a signature from the issuer's
 * JWKS; an opaque token is checked through introspection when the issuer has
 * an endpoint and refused otherwise. ID-JAG (MCP enterprise-managed
 * authorization) is a separately negotiated profile and is unsupported until
 * the host turns it on for the issuer.
 */

export const TOKEN_EXCHANGE_GRANT =
  "urn:ietf:params:oauth:grant-type:token-exchange";
export const OAUTH_EXCHANGE_OPERATION = "oauth.token.exchange";

const asymmetricAlgorithms = new Set([
  "RS256",
  "RS384",
  "RS512",
  "PS256",
  "PS384",
  "PS512",
  "ES256",
  "ES384",
  "ES512",
  "EdDSA",
  "Ed25519",
]);

export type TokenExchangePort = {
  readonly authorized: "host-policy";
  readonly server: ResolvedAuthorizationServer;
  readonly client: ResolvedClient;
  readonly policy: IssuerPolicy["tokenExchange"];
};

/** The only way to obtain a port; it exists solely when the host enabled exchange for this issuer. */
export function hostAuthorizedTokenExchange(
  policy: IssuerPolicy,
  server: ResolvedAuthorizationServer,
  client: ResolvedClient,
): TokenExchangePort {
  if (!policy.tokenExchange.enabled)
    throw new ConnectorError("denied", {
      detail: "oauth.exchange.not-enabled",
    });
  if (server.issuer !== policy.issuer)
    throw new ConnectorError("conflict", {
      detail: "oauth.exchange.issuer-conflict",
    });
  return {
    authorized: "host-policy",
    server,
    client,
    policy: policy.tokenExchange,
  };
}

export type TokenExchangeRequest = {
  /** Obtained inside a custody `use` callback; never persisted by this function. */
  subjectToken: string;
  subjectTokenType: string;
  audience?: string | undefined;
  resource?: string | undefined;
  requestedTokenType?: string | undefined;
  actorToken?: string | undefined;
  actorTokenType?: string | undefined;
  scopes?: readonly string[] | undefined;
  /** Required when the subject token cannot be verified against this issuer (opaque, or another issuer's). */
  expectedSubject?: string | undefined;
  expectedActor?: string | undefined;
  scope: CredentialScope;
};

export type VerifiedExchange = {
  issuer: string;
  audience: string[];
  subject: string;
  actor?: string;
  expiresAt?: number;
  scope?: string;
  via: "jwt" | "introspection";
};

export type TokenExchangeOutcome = {
  credentialRef: string;
  expiresAt?: number;
  issuedTokenType: string;
  verified: VerifiedExchange;
  permissions: PermissionRecord;
  claims: VerificationClaim[];
};

function looksLikeJwt(token: string): boolean {
  return /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(token);
}

function jwks(ctx: AdapterCallContext, port: TokenExchangePort) {
  const uri = port.server.metadata.jwks_uri;
  if (typeof uri !== "string")
    throw new ConnectorError("unsupported", {
      detail: "oauth.exchange.jwks-unavailable",
    });
  return createRemoteJWKSet(new URL(uri), {
    timeoutDuration: DEFAULT_TIMEOUT_MS,
    [joseFetch]: (url, options) =>
      ctx.environment.fetch(url, {
        method: options.method,
        headers: options.headers,
        redirect: "error",
        signal: boundedSignal(ctx.signal, DEFAULT_TIMEOUT_MS, options.signal),
      }),
  });
}

async function verifyJwt(
  ctx: AdapterCallContext,
  port: TokenExchangePort,
  token: string,
  options: { audience?: string[] | undefined },
): Promise<JWTPayload | undefined> {
  let header;
  try {
    header = decodeProtectedHeader(token);
  } catch {
    return undefined;
  }
  if (!header.alg || !asymmetricAlgorithms.has(header.alg))
    throw new ConnectorError("upstream-rejected", {
      detail: "oauth.exchange.token-algorithm",
    });
  try {
    const { payload } = await jwtVerify(token, jwks(ctx, port), {
      issuer: port.server.issuer,
      ...(options.audience ? { audience: options.audience } : {}),
      requiredClaims: ["iss", "sub", "aud", "exp"],
      algorithms: [header.alg],
    });
    return payload;
  } catch (error) {
    if (error instanceof ConnectorError) throw error;
    return undefined;
  }
}

/** The subject of a token this issuer minted, or undefined when it cannot be verified here. */
async function subjectOf(
  ctx: AdapterCallContext,
  port: TokenExchangePort,
  token: string,
): Promise<string | undefined> {
  if (!looksLikeJwt(token)) return undefined;
  const payload = await verifyJwt(ctx, port, token, {});
  return typeof payload?.sub === "string" ? payload.sub : undefined;
}

function audiences(value: unknown): string[] {
  if (typeof value === "string") return [value];
  if (Array.isArray(value))
    return value.filter((item): item is string => typeof item === "string");
  return [];
}

async function introspect(
  ctx: AdapterCallContext,
  port: TokenExchangePort,
  token: string,
): Promise<oauth.IntrospectionResponse> {
  const as = port.server.metadata;
  if (typeof as.introspection_endpoint !== "string")
    throw new ConnectorError("unsupported", {
      detail: "oauth.exchange.token-unverifiable",
    });
  try {
    const response = await oauth.introspectionRequest(
      as,
      port.client.client,
      port.client.authentication(),
      token,
      requestOptions({
        fetch: ctx.environment.fetch,
        signal: ctx.signal,
        allowLoopbackHttp: port.server.allowLoopbackHttp,
      }),
    );
    return await oauth.processIntrospectionResponse(
      as,
      port.client.client,
      response,
    );
  } catch (error) {
    throw wireError(error, "oauth.introspection");
  }
}

/**
 * Exchanges a subject token for a token aimed at one intended audience or
 * resource, and verifies what came back before storing it in custody. The
 * returned material never leaves this function except as a custody reference.
 */
export async function exchangeToken(
  ctx: AdapterCallContext,
  port: TokenExchangePort,
  request: TokenExchangeRequest,
): Promise<TokenExchangeOutcome> {
  if (port.authorized !== "host-policy" || !port.policy.enabled)
    throw new ConnectorError("denied", {
      detail: "oauth.exchange.not-enabled",
    });
  const requestedTokenType =
    request.requestedTokenType ?? tokenTypeIdentifiers.accessToken;
  if (requestedTokenType === tokenTypeIdentifiers.idJag && !port.policy.idJag)
    throw new ConnectorError("unsupported", {
      detail: "oauth.exchange.id-jag-not-negotiated",
    });
  if (!port.policy.requestedTokenTypes.includes(requestedTokenType))
    throw new ConnectorError("denied", {
      detail: "oauth.exchange.token-type-not-allowed",
    });
  if (!port.policy.subjectTokenTypes.includes(request.subjectTokenType))
    throw new ConnectorError("denied", {
      detail: "oauth.exchange.subject-type-not-allowed",
    });
  const intended: string[] = [];
  if (request.audience !== undefined) {
    if (!port.policy.audiences.includes(request.audience))
      throw new ConnectorError("denied", {
        detail: "oauth.exchange.audience-not-allowed",
      });
    intended.push(request.audience);
  }
  if (request.resource !== undefined) {
    if (!port.policy.resources.includes(request.resource))
      throw new ConnectorError("denied", {
        detail: "oauth.exchange.resource-not-allowed",
      });
    intended.push(request.resource);
  }
  if (!intended.length)
    throw new ConnectorError("invalid-request", {
      detail: "oauth.exchange.target-missing",
    });
  if (request.actorToken !== undefined && !port.policy.actorTokens)
    throw new ConnectorError("denied", {
      detail: "oauth.exchange.actor-not-allowed",
    });
  const as = port.server.metadata;
  if (typeof as.token_endpoint !== "string")
    throw new ConnectorError("unsupported", {
      detail: "oauth.token-endpoint.missing",
    });
  // Expected identities are settled before the network is touched, so a
  // response can only be compared with them, never define them.
  let expectedSubject = request.expectedSubject;
  if (expectedSubject === undefined && port.policy.subjectCheck === "required")
    expectedSubject = await subjectOf(ctx, port, request.subjectToken);
  if (expectedSubject === undefined && port.policy.subjectCheck === "required")
    throw new ConnectorError("denied", {
      detail: "oauth.exchange.subject-unverifiable",
    });
  let expectedActor = request.expectedActor;
  if (request.actorToken !== undefined && expectedActor === undefined)
    expectedActor = await subjectOf(ctx, port, request.actorToken);
  if (request.actorToken !== undefined && expectedActor === undefined)
    throw new ConnectorError("denied", {
      detail: "oauth.exchange.actor-unverifiable",
    });
  const parameters: Record<string, string> = {
    subject_token: request.subjectToken,
    subject_token_type: request.subjectTokenType,
    requested_token_type: requestedTokenType,
    ...(request.audience !== undefined ? { audience: request.audience } : {}),
    ...(request.resource !== undefined ? { resource: request.resource } : {}),
    ...(request.actorToken !== undefined
      ? {
          actor_token: request.actorToken,
          actor_token_type:
            request.actorTokenType ?? tokenTypeIdentifiers.accessToken,
        }
      : {}),
    ...(request.scopes?.length
      ? { scope: [...new Set(request.scopes)].join(" ") }
      : {}),
  };
  const now = () => ctx.environment.now();
  const begun = await ctx.environment.effects.begin({
    actor: ctx.actor,
    connectionRef: request.scope.connectionRef,
    bindingRef: request.scope.bindingRef,
    operation: OAUTH_EXCHANGE_OPERATION,
    digest: sha256Hex(
      "exchange",
      port.server.issuer,
      port.client.client.client_id,
      intended.join(" "),
      requestedTokenType,
      sha256Hex(request.subjectToken),
      ctx.environment.random.uuid(),
    ),
  });
  const settle = (
    status: "applied" | "not-applied" | "failed" | "indeterminate",
    code: string,
  ) => ctx.environment.effects.complete(begun.effectRef, { status, code, at: now() });
  let tokens: oauth.TokenEndpointResponse;
  try {
    const response = await oauth.genericTokenEndpointRequest(
      as,
      port.client.client,
      port.client.authentication(),
      TOKEN_EXCHANGE_GRANT,
      parameters,
      requestOptions({
        fetch: ctx.environment.fetch,
        signal: ctx.signal,
        allowLoopbackHttp: port.server.allowLoopbackHttp,
      }),
    );
    tokens = await oauth.processGenericTokenEndpointResponse(
      as,
      port.client.client,
      response,
      { recognizedTokenTypes: { n_a: () => {} } },
    );
  } catch (error) {
    if (neverSent(error)) await settle("not-applied", "oauth.exchange.unreachable");
    else if (error instanceof oauth.ResponseBodyError)
      await settle("failed", "oauth.exchange.rejected");
    else await settle("indeterminate", "oauth.exchange.indeterminate");
    throw wireError(error, "oauth.exchange");
  }
  const issuedTokenType = tokens["issued_token_type"];
  if (typeof issuedTokenType !== "string") {
    await settle("failed", "oauth.exchange.issued-token-type-missing");
    throw new ConnectorError("upstream-rejected", {
      detail: "oauth.exchange.issued-token-type-missing",
    });
  }
  if (issuedTokenType !== requestedTokenType) {
    await settle("failed", "oauth.exchange.token-type-mismatch");
    throw new ConnectorError("upstream-rejected", {
      detail: "oauth.exchange.token-type-mismatch",
    });
  }
  let verified: VerifiedExchange;
  try {
    verified = await verifyIssued(ctx, port, tokens.access_token, {
      intended,
      expectedSubject,
      expectedActor,
    });
  } catch (error) {
    await settle("failed", "oauth.exchange.verification");
    throw error;
  }
  const expiresAt =
    verified.expiresAt ??
    (typeof tokens.expires_in === "number" && tokens.expires_in > 0
      ? now() + tokens.expires_in * 1000
      : undefined);
  const scopeValue = tokens.scope ?? verified.scope;
  const credentialRef = await ctx.environment.credentials.store(
    request.scope,
    {
      access_token: tokens.access_token,
      token_type: tokens.token_type,
      issued_token_type: issuedTokenType,
      issuer: verified.issuer,
      client_id: port.client.client.client_id,
      audience: verified.audience.join(" "),
      subject: verified.subject,
      ...(scopeValue !== undefined ? { scope: scopeValue } : {}),
      ...(expiresAt !== undefined ? { expires_at: String(expiresAt) } : {}),
    },
    expiresAt !== undefined ? { expiresAt } : {},
  );
  await settle("applied", "oauth.exchange.applied");
  const permissions = permissionRecord({
    requested: request.scopes ?? [],
    reported: splitScope(scopeValue),
    source:
      scopeValue === undefined
        ? "none"
        : verified.via === "introspection"
          ? "introspection"
          : "token-response",
  });
  const target = { kind: "oauth-audience", id: intended[0]! };
  const extra = verified.audience.filter((aud) => !intended.includes(aud));
  return {
    credentialRef,
    ...(expiresAt !== undefined ? { expiresAt } : {}),
    issuedTokenType,
    verified,
    permissions,
    claims: [
      credentialAcceptedClaim(ctx, {
        issuer: verified.issuer,
        permissions,
        validUntil: expiresAt,
        target,
        limitations: [
          "The exchanged token is accepted only for the intended audience named here.",
          ...(extra.length
            ? ["The issued token also names audiences outside this connection."]
            : []),
        ],
      }),
      accountIdentityClaim(ctx, {
        issuer: verified.issuer,
        subject: verified.subject,
        subjectKind: "oauth-subject",
        validUntil: expiresAt,
      }),
    ],
  };
}

async function verifyIssued(
  ctx: AdapterCallContext,
  port: TokenExchangePort,
  token: string,
  expected: {
    intended: string[];
    expectedSubject: string | undefined;
    expectedActor: string | undefined;
  },
): Promise<VerifiedExchange> {
  let payload: JWTPayload | oauth.IntrospectionResponse | undefined;
  let via: VerifiedExchange["via"];
  if (looksLikeJwt(token)) {
    payload = await verifyJwt(ctx, port, token, {
      audience: expected.intended,
    });
    if (!payload)
      throw new ConnectorError("denied", {
        detail: "oauth.exchange.token-invalid",
      });
    via = "jwt";
  } else {
    const introspection = await introspect(ctx, port, token);
    if (introspection.active !== true)
      throw new ConnectorError("denied", {
        detail: "oauth.exchange.token-inactive",
      });
    payload = introspection;
    via = "introspection";
  }
  const issuer = payload["iss"];
  if (issuer !== undefined && issuer !== port.server.issuer)
    throw new ConnectorError("denied", {
      detail: "oauth.exchange.issuer-mismatch",
    });
  if (issuer === undefined && via === "jwt")
    throw new ConnectorError("denied", {
      detail: "oauth.exchange.issuer-mismatch",
    });
  const aud = audiences(payload["aud"]);
  if (!aud.some((value) => expected.intended.includes(value)))
    throw new ConnectorError("denied", {
      detail: "oauth.exchange.audience-mismatch",
    });
  const subject = payload["sub"];
  if (typeof subject !== "string" || !subject)
    throw new ConnectorError("denied", {
      detail: "oauth.exchange.subject-missing",
    });
  if (
    expected.expectedSubject !== undefined &&
    subject !== expected.expectedSubject
  )
    throw new ConnectorError("denied", {
      detail: "oauth.exchange.subject-mismatch",
    });
  let actor: string | undefined;
  if (expected.expectedActor !== undefined) {
    const act = payload["act"];
    const actSub =
      act && typeof act === "object" && !Array.isArray(act)
        ? (act as { sub?: unknown }).sub
        : undefined;
    if (actSub !== expected.expectedActor)
      throw new ConnectorError("denied", {
        detail: "oauth.exchange.actor-mismatch",
      });
    actor = expected.expectedActor;
  }
  const exp = payload["exp"];
  const scope = payload["scope"];
  return {
    issuer: port.server.issuer,
    audience: aud,
    subject,
    ...(actor !== undefined ? { actor } : {}),
    ...(typeof exp === "number" ? { expiresAt: exp * 1000 } : {}),
    ...(typeof scope === "string" ? { scope } : {}),
    via,
  };
}
