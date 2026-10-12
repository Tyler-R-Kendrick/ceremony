import { z } from "zod";
import type { AdapterCallContext } from "../../adapter.js";
import { beginAttempt } from "../../attempts.js";
import { sha256Hex } from "../../auth/wire.js";
import { ConnectorError } from "../../errors.js";
import { callAws, oidcFailure, sentNothing } from "./client.js";
import {
  accountIdSchema,
  AWS_IDENTITY_CENTER_ADAPTER_ID,
  REFRESH_TOKEN_GRANT,
  roleNameSchema,
  ROLE_CREDENTIAL_RENEW_BUFFER_MS,
  tokenResponseSchema,
} from "./contracts.js";
import {
  KeptWithFailure,
  rotateSession,
  sessionScope,
  signedIn,
  type SessionMaterial,
} from "./material.js";
import { getRoleCredentials, roleExpiry } from "./portal.js";

/*
 * Renewal, in the two layers the sign-in has. Role credentials are short
 * (one to twelve hours); the IAM Identity Center access token behind them
 * lasts longer; the refresh token behind that longer still. Renewing the
 * role credentials is a new GetRoleCredentials call with the held access
 * token. Only when that token has lapsed too is the refresh grant presented,
 * once, journaled before it is sent: a refresh token that may have been spent
 * is never presented again.
 */

export const AWS_TOKEN_REFRESH_OPERATION = "aws-identity-center.token.refresh";
const TOKEN_SKEW_MS = 60_000;

export type BoundIdentity = { accountId: string; roleName: string };

const boundStateSchema = z.object({
  accountId: accountIdSchema,
  roleName: roleNameSchema,
});

/** The account and role this connection is bound to, from its own state (never from custody). */
export function boundIdentity(ctx: AdapterCallContext): BoundIdentity {
  const parsed = boundStateSchema.safeParse(ctx.connection?.state["aws"]);
  if (!parsed.success)
    throw new ConnectorError("conflict", { detail: code("role.not-bound") });
  return parsed.data;
}

const code = (suffix: string) => `${AWS_IDENTITY_CENTER_ADAPTER_ID}.${suffix}`;

/** A sign-in that cannot continue without a person: the session lapsed or was ended. */
function sessionEnded(detail: string, cause?: unknown): ConnectorError {
  return new ConnectorError("expired", {
    detail: code(detail),
    ...(cause === undefined ? {} : { cause }),
  });
}

/**
 * The material with an access token that is good for the next call, refreshing
 * it first when it is not. Runs inside custody's rotation, so the new tokens
 * are written with whatever else the caller changes.
 */
export async function currentAccessToken(
  ctx: AdapterCallContext,
  current: SessionMaterial,
): Promise<SessionMaterial> {
  const now = ctx.environment.now();
  if (
    current.accessToken !== undefined &&
    (current.accessTokenExpiresAt ?? 0) > now + TOKEN_SKEW_MS
  )
    return current;
  if (!current.refreshToken) throw sessionEnded("session.expired");
  if (current.clientSecretExpiresAt <= now)
    throw sessionEnded("registration.expired");
  const scope = sessionScope(ctx);
  const begun = await beginAttempt(
    ctx.environment.effects,
    {
      actor: ctx.actor,
      connectionRef: scope.connectionRef,
      bindingRef: scope.bindingRef,
      operation: AWS_TOKEN_REFRESH_OPERATION,
      digest: sha256Hex("aws-refresh", current.clientId, current.refreshToken),
    },
    { mode: "until-applied", random: ctx.environment.random },
  );
  // This refresh token was presented before, or may have been: it is never
  // presented again, so the session ends for a person to start again (the
  // same answer as the Vercel sign-in's).
  if (begun.prior) throw sessionEnded("session.refresh-unknown");
  const settle = (
    status: "applied" | "not-applied" | "failed" | "indeterminate",
    outcome: string,
  ) =>
    ctx.environment.effects.complete(begun.effectRef, {
      status,
      code: outcome,
      at: ctx.environment.now(),
    });
  let reply;
  try {
    reply = await callAws(ctx, {
      role: "oidc",
      method: "POST",
      path: "/token",
      body: {
        clientId: current.clientId,
        clientSecret: current.clientSecret,
        refreshToken: current.refreshToken,
        grantType: REFRESH_TOKEN_GRANT,
      },
      schema: tokenResponseSchema,
    });
  } catch (error) {
    await settle(
      sentNothing(error) ? "not-applied" : "indeterminate",
      code(
        sentNothing(error) ? "refresh.unreachable" : "refresh.indeterminate",
      ),
    );
    throw error;
  }
  if (!reply.ok) {
    if (reply.status >= 500) {
      await settle("indeterminate", code("refresh.indeterminate"));
      throw oidcFailure(reply);
    }
    await settle("failed", code("refresh.rejected"));
    throw sessionEnded("session.refresh-rejected", oidcFailure(reply));
  }
  await settle("applied", code("refresh.exchanged"));
  return signedIn(current, reply.body, ctx.environment.now());
}

/** Portal failures, as the connection lifecycle names them. */
function portalOutcome(error: unknown): unknown {
  if (!(error instanceof ConnectorError)) return error;
  if (error.detail === code("portal.unauthorized"))
    return sessionEnded("session.ended", error);
  if (error.detail === code("portal.not-found"))
    return new ConnectorError("denied", {
      detail: code("role.revoked"),
      cause: error,
    });
  return error;
}

/**
 * Runs the portal work that follows `currentAccessToken`. When that call spent
 * a refresh token (`refreshed` is not `current`), a failure here must not lose
 * the tokens it returned: they are the only ones that work, so the rotation
 * writes them and then reports `fail(error)`.
 */
export async function afterRefresh(
  current: SessionMaterial,
  refreshed: SessionMaterial,
  work: () => Promise<SessionMaterial>,
  fail: (error: unknown) => unknown = (error) => error,
): Promise<SessionMaterial> {
  try {
    return await work();
  } catch (error) {
    const failure = fail(error);
    throw refreshed === current
      ? failure
      : new KeptWithFailure(refreshed, failure);
  }
}

/** Fresh role credentials for the role this record is bound to. */
export async function renewRole(
  ctx: AdapterCallContext,
  current: SessionMaterial,
  bound: BoundIdentity,
): Promise<SessionMaterial> {
  if (current.phase !== "role-bound")
    throw new ConnectorError("conflict", { detail: code("role.not-bound") });
  const withToken = await currentAccessToken(ctx, current);
  return afterRefresh(
    current,
    withToken,
    async () => {
      const credentials = await getRoleCredentials(
        ctx,
        withToken.accessToken!,
        bound.accountId,
        bound.roleName,
      );
      return {
        ...withToken,
        role: {
          accessKeyId: credentials.accessKeyId,
          secretAccessKey: credentials.secretAccessKey,
          sessionToken: credentials.sessionToken,
          expiresAt: roleExpiry(ctx, credentials),
        },
      };
    },
    portalOutcome,
  );
}

/**
 * Makes the held role credentials current, renewing them with a new
 * GetRoleCredentials call when fewer than five minutes remain. Returns the
 * expiry custody now enforces.
 */
export async function ensureCurrent(
  ctx: AdapterCallContext,
  ref: string,
): Promise<{ expiresAt: number }> {
  const described = await ctx.environment.credentials.describe(
    sessionScope(ctx),
    ref,
  );
  if (!described)
    throw new ConnectorError("not-found", {
      detail: code("credential.unknown"),
    });
  const now = ctx.environment.now();
  if (
    described.expiresAt !== undefined &&
    described.expiresAt > now + ROLE_CREDENTIAL_RENEW_BUFFER_MS
  )
    return { expiresAt: described.expiresAt };
  const bound = boundIdentity(ctx);
  const result = await rotateSession(ctx, ref, (current) =>
    renewRole(ctx, current, bound),
  );
  // A caller that joined another's rotation never ran its own work. If the
  // rotation it joined kept refreshed tokens and left the role as it was (the
  // portal failed after the refresh), the role is still about to lapse, and
  // that is not "current".
  if (
    result.expiresAt <=
    ctx.environment.now() + ROLE_CREDENTIAL_RENEW_BUFFER_MS
  )
    throw new ConnectorError("upstream-unavailable", {
      detail: code("renewal.unavailable"),
    });
  return { expiresAt: result.expiresAt };
}
