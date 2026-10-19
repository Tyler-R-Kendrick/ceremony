import { createHash } from "node:crypto";
import * as oauth from "oauth4webapi";
import { requestOptions } from "./connectors/auth/wire.js";
import { actorContextSchema, AuthorizationError } from "./identity.js";
import type { ActorContext } from "./identity.js";

/**
 * Bearer identity for the MCP endpoint.
 *
 * The browser is authenticated by a cookie over an OIDC code flow; a chat
 * client is authenticated by an access token audienced to this MCP endpoint.
 * Both end at the same `ActorContext`, so everything downstream — capabilities,
 * ownership, delegation — is enforced once rather than twice.
 *
 * The token is validated against the issuer's published keys, and its audience
 * must be this endpoint. The audience check is the difference between a token
 * meant for this resource and a token the same person holds for another one;
 * without it, any token the issuer minted would drive this deployment's
 * ceremonies.
 */

export interface McpIdentityConfig {
  issuer: string;
  /** RFC 8707 resource indicator — this MCP endpoint. Tokens must name it. */
  audience: string;
  /** Local HTTP issuers only, for development against a local provider. */
  development?: boolean;
  /**
   * Already-resolved authorization server metadata, used instead of fetching
   * discovery. A deployment that hosts its own issuer would otherwise have to
   * make a network round trip to itself before it can answer the request that
   * started it, which fails while the listener is still coming up.
   */
  metadata?: oauth.AuthorizationServer;
  /**
   * Host-controlled mapping of validated token claims, never request headers.
   * Absent roles default to executor alone, matching the browser adapter.
   */
  mapClaims(
    claims: oauth.JWTAccessTokenClaims,
  ): Promise<Pick<ActorContext, "tenantId" | "subjectId" | "capabilities">>;
}

/**
 * One chat connection is one session for as long as its grant lasts.
 *
 * A run is drivable only from the session that created it, so this cannot be
 * the token's own id: refreshing an access token mid-ceremony would orphan the
 * run the previous token started. Subject plus client is stable across refresh
 * and still separates two different chat clients held by the same person.
 */
function sessionFor(subject: string, clientId: string): string {
  const material = `${subject}\u0000${clientId}`;
  return `mcp:${createHash("sha256").update(material).digest("hex").slice(0, 32)}`;
}

export async function createMcpIdentity(config: McpIdentityConfig) {
  const issuer = new URL(config.issuer);
  if (
    issuer.username ||
    issuer.password ||
    issuer.search ||
    issuer.hash ||
    (issuer.protocol !== "https:" &&
      !(
        config.development === true &&
        issuer.protocol === "http:" &&
        issuer.hostname === "127.0.0.1"
      ))
  )
    throw new AuthorizationError("invalid_request");
  // The connectors' OAuth transport: no redirects, a time bound and every
  // answer read under the OAuth ceiling.
  const options = requestOptions({
    fetch: (input, init) => fetch(input, init),
    allowLoopbackHttp: config.development === true,
  });
  const as =
    config.metadata ??
    (await oauth.processDiscoveryResponse(
      issuer,
      await oauth.discoveryRequest(issuer, options),
    ));
  if (as.issuer !== issuer.href.replace(/\/$/, "") && as.issuer !== issuer.href)
    throw new AuthorizationError("invalid_request");
  if (!as.jwks_uri) throw new AuthorizationError("invalid_request");

  return async function authenticate(
    _token: string,
    request: Request,
  ): Promise<ActorContext | null> {
    try {
      // The validator reads the Authorization header itself, so the token is
      // never re-parsed here — one parser, one result.
      const claims = await oauth.validateJwtAccessToken(
        as,
        request,
        config.audience,
        options,
      );
      if (!claims.sub || !claims.client_id) return null;
      const mapped = await config.mapClaims(claims);
      return actorContextSchema.parse({
        ...mapped,
        sessionId: sessionFor(claims.sub, String(claims.client_id)),
        actorKind: "agent",
      });
    } catch {
      return null;
    }
  };
}
