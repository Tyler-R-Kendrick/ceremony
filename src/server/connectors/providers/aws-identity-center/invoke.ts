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
import { rotateSession, sessionScope, withSession } from "./material.js";
import { listAccountRoles, listAccounts, logout } from "./portal.js";
import { ensureCurrent } from "./refresh.js";
import { SELECT_ROLE_INTENT } from "./selection.js";

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
 * The custody record this connection's sign-in is held in. Once a role is
 * bound it is the connection's own `credentialRef`; until then (the person has
 * approved and has not yet chosen) it is the one the open choice points at, and
 * the connection has none, so the command layer would never release it.
 * `orphan` says the record is not the connection's, which makes releasing it
 * this adapter's job. The open choice is read as its owner, so an actor that is
 * not the person who signed in finds nothing here.
 */
async function heldSession(
  ctx: AdapterCallContext,
): Promise<{ ref: string; orphan: boolean } | undefined> {
  const own = ctx.connection?.credentialRef;
  if (own) return { ref: own, orphan: false };
  const choice = ctx.connection?.handoff?.handoffRef;
  if (!choice) return undefined;
  const handoff = await ctx.environment.handoffs
    .present(ctx.actor, choice)
    .catch(() => undefined);
  const ref =
    handoff?.intent === SELECT_ROLE_INTENT
      ? handoff.private["sessionRef"]
      : undefined;
  return ref ? { ref, orphan: true } : undefined;
}

/** Drops a sign-in held under an open choice; best effort, as everything about a disconnect is. */
async function discardOrphan(
  ctx: AdapterCallContext,
  held: { ref: string; orphan: boolean },
): Promise<void> {
  if (held.orphan)
    await ctx.environment.credentials
      .revoke(sessionScope(ctx), held.ref)
      .catch(() => {});
}

/**
 * Ends the sign-in session at the portal (`Logout`). Role sessions already
 * issued keep running until their own expiry, which the reference says
 * outright, so this reports what it did and never "revoked the role".
 */
export async function endSignIn(
  ctx: AdapterCallContext,
): Promise<DisconnectResult> {
  const held = await heldSession(ctx);
  const result: DisconnectResult = {
    local: "not-attempted",
    broker: "not-attempted",
    upstream: "not-attempted",
  };
  if (!held) return result;
  let ended = false;
  try {
    await rotateSession(ctx, held.ref, async (current) => {
      if (current.accessToken) ended = await logout(ctx, current.accessToken);
      return current;
    });
  } catch {
    await discardOrphan(ctx, held);
    return { ...result, upstream: "failed" };
  }
  await discardOrphan(ctx, held);
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
  const held = await heldSession(ctx);
  if (!held)
    return { revoked: "unavailable", reason: code("release.no-session") };
  let release: SessionRelease = {
    revoked: "unavailable",
    reason: code("release.no-token"),
  };
  // A caller that joins a rotation already in flight is answered when it ends
  // without its own callback running (custody shares one run per credential),
  // so the session has not been looked at yet: look again, once, at what the
  // rotation left. That one is the new token's turn.
  let looked = false;
  try {
    for (let round = 0; round < 2 && !looked; round++)
      await rotateSession(ctx, held.ref, async (current) => {
        looked = true;
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
    if (!looked)
      release = { revoked: false, reason: code("release.rotation-in-flight") };
  } catch (error) {
    // Custody would not rotate the session: say why, unless a Logout was made.
    if (release.revoked === "unavailable") release = rotationFailure(error);
  } finally {
    // The sign-in held for an open choice is the connection's to drop only
    // if this adapter does it, whatever became of the Logout.
    await discardOrphan(ctx, held);
  }
  return release;
}

/** Why custody would not hand over the session: it is gone, it is busy, or something else failed. */
function rotationFailure(error: unknown): SessionRelease {
  const detail =
    error instanceof ConnectorError && error.code === "not-found"
      ? "credential-gone"
      : error instanceof ConnectorError && error.code === "conflict"
        ? "busy"
        : "failed";
  return { revoked: false, reason: code(`release.${detail}`) };
}
