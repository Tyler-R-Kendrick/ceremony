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
 * token. Two things are refused here rather than trusted to the host's
 * lookup: a connection that is not the calling person's own, and (by the
 * provider, which compares the lease's team with its configured one) a
 * sign-in for another team. The workload leg never takes a lease.
 */

/** The host's lookup: the calling person's Vercel account connection, as a call context. */
export type AccountContextSource = (
  ctx: AdapterCallContext,
) => Promise<AdapterCallContext | undefined>;

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
      throw new ConnectorError("denied", {
        detail: `${VERCEL_ACCOUNT_ADAPTER_ID}.management.not-owner`,
      });
    // A sign-in that lapsed, was disconnected or never finished is not a
    // credential; the configured token, if the host has one, serves instead.
    if (!connection.credentialRef || connection.lifecycle !== "active")
      return undefined;
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
