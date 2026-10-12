import { z } from "zod";
import type {
  AdapterCallContext,
  DisconnectResult,
  InvokeRequest,
  InvokeResult,
  SessionRelease,
} from "../../adapter.js";
import { boundOperation } from "../../binding.js";
import { ConnectorError } from "../../errors.js";
import {
  accountIdSchema,
  AWS_IDENTITY_CENTER_ADAPTER_ID,
  awsDestinationIds,
  awsPortalOperations,
  awsTargetKinds,
  permitsTarget,
  permittedAccounts,
  permittedRoles,
  roleTargetId,
  type AwsPortalOperation,
} from "./contracts.js";
import { rotateSession, withSession } from "./material.js";
import { listAccountRoles, listAccounts, logout } from "./portal.js";
import { ensureCurrent } from "./refresh.js";

/*
 * What a caller may do with a connection besides use it: read the accounts and
 * roles it may reach, and end the sign-in. Role credentials are never an
 * output; they are used by trusted host code through `withRoleCredentials`.
 */

const code = (suffix: string) => `${AWS_IDENTITY_CENTER_ADAPTER_ID}.${suffix}`;

const accountsInput = z.strictObject({});
/**
 * The command layer admits a target only when the parameter that carries it is
 * named for the target's kind, so the account travels as `aws-account`.
 */
const rolesInput = z.strictObject({
  [awsTargetKinds.account]: accountIdSchema,
});

function operationOf(nativeId: string): AwsPortalOperation | undefined {
  return (Object.keys(awsPortalOperations) as AwsPortalOperation[]).find(
    (name) => awsPortalOperations[name].nativeId === nativeId,
  );
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

export async function invokeAws(
  ctx: AdapterCallContext,
  request: InvokeRequest,
): Promise<InvokeResult> {
  const bound = boundOperation(ctx.binding, request.operationRef);
  const operation = bound ? operationOf(bound.nativeId) : undefined;
  if (
    !bound ||
    !operation ||
    bound.transport.kind !== "http" ||
    bound.destinationId !== awsDestinationIds.portal
  )
    throw new ConnectorError("denied", { detail: code("operation.unbound") });
  const ref = ctx.connection?.credentialRef;
  if (!ref) return stopped(bound, "human-required", "not-connected");
  const input =
    operation === "listAccounts"
      ? accountsInput.safeParse(request.input)
      : rolesInput.safeParse(request.input);
  if (!input.success)
    throw new ConnectorError("invalid-request", {
      detail: code("input.invalid"),
    });
  try {
    await ensureCurrent(ctx, ref);
  } catch (error) {
    if (error instanceof ConnectorError && error.code === "expired")
      return stopped(bound, "human-required", "session.expired");
    if (error instanceof ConnectorError && error.code === "denied")
      return stopped(bound, "denied", "role.revoked");
    throw error;
  }
  const output =
    operation === "listAccounts"
      ? await readAccounts(ctx, ref)
      : await readRoles(
          ctx,
          ref,
          (input.data as Record<string, string>)[awsTargetKinds.account]!,
        );
  return {
    state: "complete",
    output,
    outputClassification: bound.outputClassification,
    effect: "read",
  };
}

async function readAccounts(ctx: AdapterCallContext, ref: string) {
  const permitted = new Set(permittedAccounts(ctx.binding));
  return withSession(ctx, ref, async (material) => {
    const listing = await listAccounts(ctx, material.accessToken!);
    return {
      accounts: listing.items
        .filter((account) => permitted.has(account.accountId))
        .map((account) => ({
          accountId: account.accountId,
          ...(account.accountName ? { accountName: account.accountName } : {}),
        })),
      truncated: listing.truncated,
    };
  });
}

async function readRoles(
  ctx: AdapterCallContext,
  ref: string,
  accountId: string,
) {
  if (!permitsTarget(ctx.binding, awsTargetKinds.account, accountId))
    throw new ConnectorError("denied", {
      detail: code("account.not-permitted"),
    });
  const restricted = permittedRoles(ctx.binding);
  return withSession(ctx, ref, async (material) => {
    const listing = await listAccountRoles(
      ctx,
      material.accessToken!,
      accountId,
    );
    return {
      accountId,
      roles: listing.items.filter(
        (role) =>
          !restricted || restricted.includes(roleTargetId(accountId, role)),
      ),
      truncated: listing.truncated,
    };
  });
}

/**
 * Ends the sign-in session at the portal (`Logout`). Role sessions already
 * issued keep running until their own expiry, which the reference says
 * outright, so this reports what it did and never "revoked the role".
 */
export async function endSignIn(
  ctx: AdapterCallContext,
): Promise<DisconnectResult> {
  const ref = ctx.connection?.credentialRef;
  const result: DisconnectResult = {
    local: "not-attempted",
    broker: "not-attempted",
    upstream: "not-attempted",
  };
  if (!ref) return result;
  let ended = false;
  try {
    await rotateSession(ctx, ref, async (current) => {
      if (current.accessToken) ended = await logout(ctx, current.accessToken);
      return current;
    });
  } catch {
    return { ...result, upstream: "failed" };
  }
  return { ...result, upstream: ended ? "applied" : "failed" };
}

/**
 * Ends the sign-in session at the portal (`Logout`) as part of a disconnect
 * that did not ask for it. Best effort: what happened is the answer, with a
 * stable code and no token, and nothing here stops the disconnect. The portal
 * reference says Logout invalidates the sign-in session and that role sessions
 * already issued continue until their own expiry, so `revoked: true` means the
 * session was ended and never that the role credentials were. The OIDC API
 * has no operation that revokes a refresh token; that token is dropped with
 * custody and is not known to be ended.
 */
export async function releaseSignIn(
  ctx: AdapterCallContext,
): Promise<SessionRelease> {
  const ref = ctx.connection?.credentialRef;
  if (!ref)
    return { revoked: "unavailable", reason: code("release.no-session") };
  let release: SessionRelease = {
    revoked: "unavailable",
    reason: code("release.no-token"),
  };
  try {
    await rotateSession(ctx, ref, async (current) => {
      if (!current.accessToken) return current;
      try {
        release = (await logout(ctx, current.accessToken))
          ? { revoked: true, reason: code("release.session-ended") }
          : { revoked: false, reason: code("release.refused") };
      } catch {
        release = { revoked: false, reason: code("release.unreachable") };
      }
      return current;
    });
  } catch {
    // Custody refused (the credential is gone); report a logout that was made.
    if (release.revoked === "unavailable")
      return { revoked: false, reason: code("release.credential-gone") };
  }
  return release;
}
