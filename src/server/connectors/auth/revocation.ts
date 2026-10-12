import * as oauth from "oauth4webapi";
import type {
  AdapterCallContext,
  DisconnectOutcome,
  SessionRelease,
} from "../adapter.js";
import { beginAttempt } from "../attempts.js";
import { ConnectorError } from "../errors.js";
import type { CredentialMaterial, CredentialScope } from "../ports.js";
import type { ResolvedClient } from "./client.js";
import type { ResolvedAuthorizationServer } from "./discovery.js";
import type { IssuerPolicy } from "./policy.js";
import { neverSent, requestOptions, sha256Hex } from "./wire.js";

/*
 * Upstream token revocation (RFC 7009), for an upstream disconnect or an
 * administrative revoke. It is attempted only when all of these hold, and the
 * outcome says which one did not:
 *
 * - the host's reviewed issuer policy turned it on (`revocation:
 *   "on-upstream-disconnect"`); otherwise `not-attempted`;
 * - the issuer's verified metadata (or the host's configured endpoints)
 *   advertises a revocation endpoint; otherwise `unsupported`;
 * - the held credential was issued by this issuer to this client; a token is
 *   never presented anywhere else.
 *
 * The refresh token is revoked first (an issuer that supports it SHOULD then
 * end the access tokens of the grant), then the access token. Both happen
 * under the custody port's single-flight refresh lock, so a concurrent refresh
 * cannot rotate the grant between reading the token and revoking it, and the
 * attempt is journaled before anything is sent. `applied` means the issuer
 * answered 200 for every token presented; an issuer answers 200 for a token
 * it no longer knows, so `applied` is the issuer's statement, not proof.
 */

export const OAUTH_REVOKE_OPERATION = "oauth.token.revoke";

/**
 * What a revocation attempt came to, with a stable code that says why. The code
 * names a step or a kind of failure, never what the issuer said, and holds no
 * token: it is safe to put on a result a person reads.
 */
export type Revocation = { outcome: DisconnectOutcome; reason: string };
const revocation = (
  outcome: DisconnectOutcome,
  reason: string,
): Revocation => ({
  outcome,
  reason,
});

/**
 * A revocation read as the release of a held session: acknowledged is `true`;
 * a request that was sent and not acknowledged (refused, unreachable, partial,
 * unknown) is `false`; nothing to send (switched off, no endpoint, no token) is
 * `"unavailable"`.
 */
export function sessionReleaseOf(attempt: Revocation): SessionRelease {
  switch (attempt.outcome) {
    case "applied":
      return { revoked: true, reason: attempt.reason };
    case "not-attempted":
    case "unsupported":
      return { revoked: "unavailable", reason: attempt.reason };
    default:
      return { revoked: false, reason: attempt.reason };
  }
}

export type RevokeUpstreamInput = {
  server: ResolvedAuthorizationServer;
  client: ResolvedClient;
  policy: Pick<IssuerPolicy, "revocation">;
  scope: CredentialScope;
  credentialRef: string;
};

export async function revokeUpstreamGrant(
  ctx: AdapterCallContext,
  input: RevokeUpstreamInput,
): Promise<DisconnectOutcome> {
  return (await revokeUpstreamGrantWithReason(ctx, input)).outcome;
}

/** `revokeUpstreamGrant`, with the reason the outcome is what it is. */
export async function revokeUpstreamGrantWithReason(
  ctx: AdapterCallContext,
  input: RevokeUpstreamInput,
): Promise<Revocation> {
  if (input.policy.revocation !== "on-upstream-disconnect")
    return revocation("not-attempted", "oauth.revoke.disabled");
  const as = input.server.metadata;
  if (typeof as.revocation_endpoint !== "string")
    return revocation("unsupported", "oauth.revoke.no-endpoint");
  let outcome: Revocation | undefined;
  const unchanged = (current: CredentialMaterial) => {
    const held = Number(current["expires_at"]);
    return {
      material: current,
      ...(Number.isSafeInteger(held) && held > 0 ? { expiresAt: held } : {}),
    };
  };
  // Twice at most: a caller that joined another worker's refresh saw that
  // rotation finish without running its own callback.
  for (let round = 0; round < 2 && outcome === undefined; round++)
    try {
      await ctx.environment.credentials.refresh(
        input.scope,
        input.credentialRef,
        async (current) => {
          outcome = await present(ctx, input, current);
          return unchanged(current);
        },
      );
    } catch (error) {
      // Custody refused: the credential is gone (or not this scope's), busy,
      // or failed. Nothing was presented unless `present` recorded an outcome.
      return outcome ?? revocation("failed", refusal(error));
    }
  // Joined a rotation twice and never had a turn: nothing was presented.
  return outcome ?? revocation("failed", "oauth.revoke.rotation-in-flight");
}

/** Why custody would not let the revocation read the credential. */
const refusal = (error: unknown) =>
  error instanceof ConnectorError && error.code === "not-found"
    ? "oauth.revoke.credential-gone"
    : error instanceof ConnectorError && error.code === "conflict"
      ? "oauth.revoke.busy"
      : "oauth.revoke.failed";

async function present(
  ctx: AdapterCallContext,
  input: RevokeUpstreamInput,
  current: CredentialMaterial,
): Promise<Revocation> {
  const clientId = input.client.client.client_id;
  if (
    (current["issuer"] !== undefined &&
      current["issuer"] !== input.server.issuer) ||
    (current["client_id"] !== undefined && current["client_id"] !== clientId)
  )
    return revocation("failed", "oauth.revoke.credential-mismatch");
  const tokens: Array<[string, "refresh_token" | "access_token"]> = [];
  if (current["refresh_token"])
    tokens.push([current["refresh_token"], "refresh_token"]);
  if (current["access_token"])
    tokens.push([current["access_token"], "access_token"]);
  if (!tokens.length)
    return revocation("not-attempted", "oauth.revoke.no-token");
  const begun = await beginAttempt(
    ctx.environment.effects,
    {
      actor: ctx.actor,
      connectionRef: input.scope.connectionRef,
      bindingRef: input.scope.bindingRef,
      operation: OAUTH_REVOKE_OPERATION,
      digest: sha256Hex(
        "revoke",
        input.server.issuer,
        clientId,
        ...tokens.map(([token]) => token),
      ),
    },
    { mode: "until-applied", random: ctx.environment.random },
  );
  if (begun.prior) {
    // The same grant was already presented: say what that attempt came to.
    const earlier = begun.prior.code?.startsWith("oauth.revoke.")
      ? begun.prior.code
      : undefined;
    return (begun.prior.status === "applied" ||
      begun.prior.status === "reconciled") &&
      begun.prior.code !== "oauth.revoke.partial"
      ? revocation("applied", "oauth.revoke.applied")
      : begun.prior.status === "indeterminate"
        ? revocation("indeterminate", "oauth.revoke.indeterminate")
        : revocation("failed", earlier ?? "oauth.revoke.refused");
  }
  const finish = (
    status: "applied" | "not-applied" | "failed" | "indeterminate",
    code?: string,
  ) =>
    ctx.environment.effects.complete(begun.effectRef, {
      status,
      ...(code ? { code } : {}),
      at: ctx.environment.now(),
    });
  let revoked = 0;
  try {
    for (const [token, hint] of tokens) {
      const response = await oauth.revocationRequest(
        input.server.metadata,
        input.client.client,
        input.client.authentication(),
        token,
        {
          ...requestOptions({
            fetch: ctx.environment.fetch,
            signal: ctx.signal,
            allowLoopbackHttp: input.server.allowLoopbackHttp,
          }),
          additionalParameters: { token_type_hint: hint },
        },
      );
      await oauth.processRevocationResponse(response);
      revoked += 1;
    }
  } catch (error) {
    if (
      error instanceof oauth.ResponseBodyError ||
      error instanceof oauth.OperationProcessingError
    ) {
      // The issuer answered and refused. A token it already revoked stays
      // revoked, so a partial revocation is journaled as applied, but the
      // caller is told the grant was not fully ended.
      const reason = revoked ? "oauth.revoke.partial" : "oauth.revoke.refused";
      await finish(revoked ? "applied" : "failed", reason);
      return revocation("failed", reason);
    }
    if (!revoked && neverSent(error)) {
      await finish("not-applied", "oauth.revoke.unreachable");
      return revocation("failed", "oauth.revoke.unreachable");
    }
    await finish("indeterminate", "oauth.revoke.indeterminate");
    return revocation("indeterminate", "oauth.revoke.indeterminate");
  }
  await finish("applied");
  return revocation("applied", "oauth.revoke.applied");
}
