import { z } from "zod";
import type {
  AdapterCallContext,
  CompletionResult,
  DisconnectResult,
  InvokeRequest,
  InvokeResult,
  SessionRelease,
} from "../../adapter.js";
import type { ConnectorOAuthOptions } from "../../auth/connector-oauth.js";
import {
  revokeUpstreamGrant,
  revokeUpstreamGrantWithReason,
  sessionReleaseOf,
} from "../../auth/revocation.js";
import { boundOperation } from "../../binding.js";
import { ConnectorError } from "../../errors.js";
import { listTeams, readUser } from "./client.js";
import {
  permittedTeams,
  VERCEL_ACCOUNT_ADAPTER_ID,
  vercelAccountDestinationIds,
  vercelAccountOperations,
  type VercelAccountOperation,
} from "./contracts.js";
import {
  ACCOUNT_STATE_KEY,
  boundAccount,
  claimsFor,
  teamTarget,
} from "./evidence.js";
import {
  ensureFresh,
  resolveSignIn,
  sessionScope,
  withBearer,
} from "./session.js";

/*
 * What a caller may do with a signed-in connection besides use it: read who
 * signed in and the teams it may reach, check that the sign-in still stands,
 * and end it. The token itself is never an output; trusted host code reaches
 * it only through the management lease (`management.ts`).
 */

const code = (suffix: string) => `${VERCEL_ACCOUNT_ADAPTER_ID}.${suffix}`;
const emptyInput = z.strictObject({});

function operationOf(nativeId: string): VercelAccountOperation | undefined {
  return (
    Object.keys(vercelAccountOperations) as VercelAccountOperation[]
  ).find((name) => vercelAccountOperations[name].nativeId === nativeId);
}

function stopped(
  bound: { outputClassification: InvokeResult["outputClassification"] },
  state: InvokeResult["state"],
  detail: string,
): InvokeResult {
  return {
    state,
    outputClassification: bound.outputClassification,
    effect: "read",
    code: code(detail),
  };
}

/** A sign-in the person ended at Vercel, or that cannot be renewed, as the lifecycle names it. */
export function endedSignIn(error: unknown): ConnectorError | undefined {
  if (!(error instanceof ConnectorError)) return undefined;
  if (error.code === "expired") return error;
  if (error.detail === code("api.unauthorized"))
    return new ConnectorError("expired", {
      detail: code("session.revoked"),
      cause: error,
    });
  return undefined;
}

export async function invokeAccount(
  ctx: AdapterCallContext,
  request: InvokeRequest,
  options: ConnectorOAuthOptions,
): Promise<InvokeResult> {
  const bound = boundOperation(ctx.binding, request.operationRef);
  const operation = bound ? operationOf(bound.nativeId) : undefined;
  if (
    !bound ||
    !operation ||
    bound.transport.kind !== "http" ||
    bound.destinationId !== vercelAccountDestinationIds.api
  )
    throw new ConnectorError("denied", { detail: code("operation.unbound") });
  const ref = ctx.connection?.credentialRef;
  if (!ref) return stopped(bound, "human-required", "not-connected");
  if (!emptyInput.safeParse(request.input ?? {}).success)
    throw new ConnectorError("invalid-request", {
      detail: code("input.invalid"),
    });
  const account = boundAccount(ctx);
  try {
    await ensureFresh(ctx, ref, options);
    const output = await withBearer(ctx, ref, async (bearer) => {
      if (operation === "getUser") {
        const user = await readUser(ctx, bearer);
        return {
          user: {
            id: user.id,
            ...(user.username ? { username: user.username } : {}),
            ...(user.name ? { name: user.name } : {}),
          },
        };
      }
      const permitted = new Set(permittedTeams(ctx.binding));
      const listing = await listTeams(ctx, bearer);
      return {
        teams: listing.teams
          .filter((team) => permitted.has(team.id))
          .map((team) => ({
            id: team.id,
            slug: team.slug,
            ...(team.name ? { name: team.name } : {}),
            bound: team.id === account.teamId,
          })),
        truncated: listing.truncated,
      };
    });
    return {
      state: "complete",
      output,
      outputClassification: bound.outputClassification,
      effect: "read",
    };
  } catch (error) {
    if (endedSignIn(error))
      return stopped(bound, "human-required", "session.expired");
    throw error;
  }
}

/**
 * Whether the sign-in still stands: the token is renewed when it must be, and
 * Vercel is asked who it belongs to and which teams it reaches. A user other
 * than the one who approved, or a team the person left, is not this
 * connection any more.
 */
export async function verifyAccount(
  ctx: AdapterCallContext,
  options: ConnectorOAuthOptions,
): Promise<CompletionResult> {
  const ref = ctx.connection?.credentialRef;
  if (!ref)
    return { state: "human-required", claims: [], code: code("not-connected") };
  try {
    const account = boundAccount(ctx);
    await ensureFresh(ctx, ref, options);
    const described = await ctx.environment.credentials.describe(
      sessionScope(ctx),
      ref,
    );
    const seen = await withBearer(ctx, ref, async (bearer) => ({
      user: await readUser(ctx, bearer),
      listing: await listTeams(ctx, bearer),
    }));
    if (seen.user.id !== account.userId)
      return { state: "denied", claims: [], code: code("user.changed") };
    const team = seen.listing.teams.find((item) => item.id === account.teamId);
    // Not found in a listing that was cut off is not "left": the team may be
    // on a page that was not read, and ending the connection on a guess is not
    // a verification.
    if (!team)
      return seen.listing.truncated
        ? { state: "indeterminate", claims: [], code: code("team.not-listed") }
        : { state: "denied", claims: [], code: code("team.left") };
    return {
      state: "complete",
      claims: claimsFor(ctx, {
        user: seen.user,
        team,
        reported: account.reported,
        validUntil: described?.expiresAt,
      }),
      credentialRef: ref,
      target: teamTarget(team),
      adapterState: {
        [ACCOUNT_STATE_KEY]: {
          ...account,
          slug: team.slug,
          ...(described?.expiresAt !== undefined
            ? { expiresAt: described.expiresAt }
            : {}),
        },
      },
    };
  } catch (error) {
    const ended = endedSignIn(error);
    if (ended)
      return {
        state: "expired",
        claims: [],
        code: ended.detail ?? code("session.expired"),
      };
    throw error;
  }
}

/**
 * Ends the grant at Vercel (RFC 7009) when the host's reviewed policy asked
 * for it and Vercel's metadata advertises an endpoint; otherwise it says why
 * it did not. Local custody is released by the command layer either way.
 */
export async function endSignIn(
  ctx: AdapterCallContext,
  options: ConnectorOAuthOptions,
): Promise<DisconnectResult["upstream"]> {
  const ref = ctx.connection?.credentialRef;
  if (!ref) return "not-attempted";
  let oauth;
  try {
    oauth = await resolveSignIn(ctx, options);
  } catch {
    return "failed";
  }
  if (oauth.policy.revocation !== "on-upstream-disconnect")
    return "not-attempted";
  return revokeUpstreamGrant(ctx, {
    server: oauth.server,
    client: oauth.client,
    policy: oauth.policy,
    scope: sessionScope(ctx),
    credentialRef: ref,
  });
}

/**
 * Presents the held refresh token, then the access token, to Vercel's
 * revocation endpoint (RFC 7009, with the `none` client's `client_id`) as part
 * of a disconnect that did not ask for it. Best effort: the answer is what
 * happened, never an error, and says so with a stable code and no token. Not
 * attempted, and said so, when the issuer policy turned revocation off, when
 * Vercel's metadata names no revocation endpoint, or when custody holds
 * nothing to present.
 */
export async function releaseSignIn(
  ctx: AdapterCallContext,
  options: ConnectorOAuthOptions,
): Promise<SessionRelease> {
  const ref = ctx.connection?.credentialRef;
  if (!ref)
    return { revoked: "unavailable", reason: "oauth.revoke.no-session" };
  let oauth;
  try {
    oauth = await resolveSignIn(ctx, options);
  } catch {
    return { revoked: false, reason: "oauth.revoke.unresolved" };
  }
  return sessionReleaseOf(
    await revokeUpstreamGrantWithReason(ctx, {
      server: oauth.server,
      client: oauth.client,
      policy: oauth.policy,
      scope: sessionScope(ctx),
      credentialRef: ref,
    }),
  );
}
