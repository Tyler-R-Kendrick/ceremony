import type { ConnectionLifecycle } from "../../../../core/connectors/index.js";
import type { AdapterCallContext } from "../../adapter.js";
import type { ConnectorOAuthOptions } from "../../auth/connector-oauth.js";
import { ConnectorError } from "../../errors.js";
import type {
  ManagementLease,
  ManagementTokenSource,
} from "../vercel/credentials.js";
import { VERCEL_ACCOUNT_ADAPTER_ID } from "./contracts.js";
import { boundAccount } from "./evidence.js";
import { ensureFresh, sessionScope } from "./session.js";

/*
 * The Vercel Connect management leg, fed by a signed-in account instead of a
 * pasted token. The sign-in's token never leaves the connection's custody
 * record: this hands the Connect provider a lease, which says which record,
 * which member, which team and how to renew, and the provider reads the value
 * inside a custody callback exactly as it reads a configured management
 * token. Three things are refused rather than trusted to the host's lookup: a
 * connection that is not the calling person's own, a sign-in that cannot serve
 * (the configured team token never stands in for a person who has one), and
 * (by the provider, which compares the lease's team with its configured one
 * and its owner with the caller) a lease for another team or person. A host
 * that finds no connection at all gets no lease, and the provider then uses
 * the configured token, as it did before sign-ins existed. The workload leg
 * never takes a lease.
 */

/** The host's lookup: the calling person's Vercel account connection, as a call context. */
export type AccountContextSource = (
  ctx: AdapterCallContext,
) => Promise<AdapterCallContext | undefined>;

const refusal = (suffix: string) =>
  `${VERCEL_ACCOUNT_ADAPTER_ID}.management.${suffix}`;

/** What a person is told when their sign-in cannot serve: expired, unsettled, or theirs to redo. */
function signInNotUsable(lifecycle: ConnectionLifecycle): ConnectorError {
  if (lifecycle === "expired")
    return new ConnectorError("expired", {
      detail: refusal("session-expired"),
    });
  if (
    lifecycle === "verifying" ||
    lifecycle === "degraded" ||
    lifecycle === "indeterminate"
  )
    return new ConnectorError("conflict", {
      detail: refusal("sign-in-unsettled"),
    });
  return new ConnectorError("human-required", {
    detail: refusal("sign-in-required"),
  });
}

export function accountManagementSource(input: {
  account: AccountContextSource;
  oauth?: ConnectorOAuthOptions;
}): ManagementTokenSource {
  return async (ctx): Promise<ManagementLease | undefined> => {
    const accountCtx = await input.account(ctx);
    const connection = accountCtx?.connection;
    if (!accountCtx || !connection) return undefined;
    if (
      connection.ecosystem !== VERCEL_ACCOUNT_ADAPTER_ID ||
      connection.tenantId !== ctx.actor.tenantId ||
      connection.ownerKind !== "user" ||
      connection.ownerId !== ctx.actor.subjectId
    )
      throw new ConnectorError("denied", { detail: refusal("not-owner") });
    // The person has a sign-in, so the person is who acts. One that lapsed,
    // was disconnected or never finished is a refusal that says what to do,
    // never a reason to administer with the organisation's token instead.
    if (!connection.credentialRef || connection.lifecycle !== "active")
      throw signInNotUsable(connection.lifecycle);
    const ref = connection.credentialRef;
    return {
      teamId: boundAccount(accountCtx).teamId,
      scope: sessionScope(accountCtx),
      ref,
      member: "access_token",
      prepare: () => ensureFresh(accountCtx, ref, input.oauth ?? {}),
    };
  };
}
