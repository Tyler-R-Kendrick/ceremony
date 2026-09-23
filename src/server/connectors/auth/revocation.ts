import * as oauth from "oauth4webapi";
import type { AdapterCallContext, DisconnectOutcome } from "../adapter.js";
import { beginAttempt } from "../attempts.js";
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
  if (input.policy.revocation !== "on-upstream-disconnect")
    return "not-attempted";
  const as = input.server.metadata;
  if (typeof as.revocation_endpoint !== "string") return "unsupported";
  let outcome: DisconnectOutcome | undefined;
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
    } catch {
      // Custody refused (the credential is gone, or not this scope's).
      // Nothing was presented unless `present` already recorded an outcome.
      return outcome ?? "failed";
    }
  return outcome ?? "failed";
}

async function present(
  ctx: AdapterCallContext,
  input: RevokeUpstreamInput,
  current: CredentialMaterial,
): Promise<DisconnectOutcome> {
  const clientId = input.client.client.client_id;
  if (
    (current["issuer"] !== undefined &&
      current["issuer"] !== input.server.issuer) ||
    (current["client_id"] !== undefined && current["client_id"] !== clientId)
  )
    return "failed";
  const tokens: Array<[string, "refresh_token" | "access_token"]> = [];
  if (current["refresh_token"])
    tokens.push([current["refresh_token"], "refresh_token"]);
  if (current["access_token"])
    tokens.push([current["access_token"], "access_token"]);
  if (!tokens.length) return "not-attempted";
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
  if (begun.prior)
    return (begun.prior.status === "applied" ||
      begun.prior.status === "reconciled") &&
      begun.prior.code !== "oauth.revoke.partial"
      ? "applied"
      : begun.prior.status === "indeterminate"
        ? "indeterminate"
        : "failed";
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
      await finish(
        revoked ? "applied" : "failed",
        revoked ? "oauth.revoke.partial" : "oauth.revoke.refused",
      );
      return "failed";
    }
    if (!revoked && neverSent(error)) {
      await finish("not-applied", "oauth.revoke.unreachable");
      return "failed";
    }
    await finish("indeterminate", "oauth.revoke.indeterminate");
    return "indeterminate";
  }
  await finish("applied");
  return "applied";
}
