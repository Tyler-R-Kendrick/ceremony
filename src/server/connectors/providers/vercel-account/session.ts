import type { AdapterCallContext } from "../../adapter.js";
import { refreshAccessToken } from "../../auth/authorization-code.js";
import {
  connectionCredentialScope,
  missingClientConfiguration,
  resolveConnectorOAuth,
  type ConnectorOAuth,
  type ConnectorOAuthOptions,
} from "../../auth/connector-oauth.js";
import { issuerPolicyFromBinding } from "../../auth/policy.js";
import { ConnectorError } from "../../errors.js";
import type { CredentialScope } from "../../ports.js";
import {
  TOKEN_RENEW_BUFFER_MS,
  VERCEL_ACCOUNT_ADAPTER_ID,
} from "./contracts.js";

/*
 * The held sign-in: the access token Vercel issued, kept in custody under the
 * connection's own scope, handed out only to a callback that makes one request
 * with it, and renewed with the refresh token before it lapses. Vercel's
 * access token lasts an hour and its refresh token rotates on every use, so a
 * lapsed token costs one refresh grant, journaled and single-flight like every
 * other OAuth refresh here.
 */

const code = (suffix: string) => `${VERCEL_ACCOUNT_ADAPTER_ID}.${suffix}`;

export function sessionScope(ctx: AdapterCallContext): CredentialScope {
  return connectionCredentialScope(ctx);
}

/** The issuer policy the host pinned under the binding, resolved to a live client. */
export async function resolveSignIn(
  ctx: AdapterCallContext,
  options: ConnectorOAuthOptions,
  extra: Parameters<typeof resolveConnectorOAuth>[3] = {},
): Promise<ConnectorOAuth> {
  return resolveConnectorOAuth(
    ctx,
    issuerPolicyFromBinding(ctx.binding),
    options,
    extra,
  );
}

const CLIENT_CONFIGURATION_DETAILS = new Set([
  "oauth.client.missing",
  "oauth.client.secret-missing",
  "oauth.client.private-key-missing",
]);

/** Resolves the sign-in, or names the configuration the client needs instead of failing on it. */
export async function resolveOrMissing(
  ctx: AdapterCallContext,
  options: ConnectorOAuthOptions,
  extra: Parameters<typeof resolveConnectorOAuth>[3] = {},
): Promise<ConnectorOAuth | { missing: string[] }> {
  try {
    return await resolveSignIn(ctx, options, extra);
  } catch (error) {
    if (
      error instanceof ConnectorError &&
      error.code === "configuration-required" &&
      CLIENT_CONFIGURATION_DETAILS.has(error.detail ?? "")
    ) {
      const missing = await missingClientConfiguration(
        ctx,
        issuerPolicyFromBinding(ctx.binding),
      );
      if (missing.length) return { missing };
    }
    throw error;
  }
}

/** Runs one request with the held access token; custody refuses a callback that returns it. */
export function withBearer<T>(
  ctx: AdapterCallContext,
  ref: string,
  work: (bearer: string) => Promise<T>,
): Promise<T> {
  return ctx.environment.credentials.use(sessionScope(ctx), ref, (material) => {
    const bearer = material["access_token"];
    if (!bearer)
      throw new ConnectorError("conflict", {
        detail: code("credential.malformed"),
      });
    return work(bearer);
  });
}

/** A sign-in that cannot continue without a person: the session lapsed or was ended. */
export function sessionEnded(detail: string, cause?: unknown): ConnectorError {
  return new ConnectorError("expired", {
    detail: code(detail),
    ...(cause === undefined ? {} : { cause }),
  });
}

/**
 * Makes the held access token good for the next request, refreshing it when
 * fewer than two minutes remain. A refresh token that was spent, or never
 * issued, ends the session.
 */
export async function ensureFresh(
  ctx: AdapterCallContext,
  ref: string,
  options: ConnectorOAuthOptions,
): Promise<void> {
  const scope = sessionScope(ctx);
  const described = await ctx.environment.credentials.describe(scope, ref);
  if (!described) throw sessionEnded("session.unknown");
  const now = ctx.environment.now();
  if (
    described.expiresAt === undefined ||
    described.expiresAt > now + TOKEN_RENEW_BUFFER_MS
  )
    return;
  const oauth = await resolveSignIn(ctx, options);
  try {
    await refreshAccessToken(ctx, {
      server: oauth.server,
      client: oauth.client,
      policy: oauth.policy,
      credentialRef: ref,
      scope,
      stillStale: (current) => {
        const held = Number(current["expires_at"]);
        return !Number.isFinite(held) || held <= now + TOKEN_RENEW_BUFFER_MS;
      },
    });
  } catch (error) {
    if (error instanceof ConnectorError) {
      if (error.detail === "oauth.refresh.no-refresh-token")
        throw sessionEnded("session.expired", error);
      // invalid_grant is a refresh token Vercel no longer honours; access_denied
      // is what the dashboard page documents for an application restricted to a
      // team the person is no longer in, at authorization, device approval and
      // refresh alike. Neither can be retried.
      if (
        error.detail === "oauth.token.invalid-grant" ||
        error.detail === "oauth.token.access-denied"
      )
        throw sessionEnded("session.refresh-rejected", error);
      // A refresh token that may have been spent is never presented again,
      // so no later attempt can succeed: the person signs in again.
      if (
        error.detail === "oauth.refresh.indeterminate" ||
        error.detail === "oauth.refresh.already-used"
      )
        throw sessionEnded("session.refresh-unknown", error);
    }
    throw error;
  }
}
