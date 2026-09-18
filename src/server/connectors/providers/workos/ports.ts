import type { ActorContext } from "../../../../core/operation-contracts.js";
import type { OwnerKind } from "../../../../core/connectors/index.js";

/*
 * WorkOS identifies the person and the organization a Pipes connection
 * belongs to by WorkOS ids. Those ids are the host's business: the host
 * authenticated the person, the host knows which WorkOS user record is
 * theirs and which organization they act for. The adapter therefore asks the
 * host through this port and never reads a user id, an organization id or an
 * ownership choice from tool arguments, tags or request headers. A tag that
 * says "organization" does not turn a person's grant into the organization's.
 */

export type WorkOsPrincipal = {
  /** The host owner identity this principal was resolved for (user or organization id in host terms). */
  ownerId: string;
  /** The WorkOS user acting; WorkOS requires one even for an organization's shared connection. */
  userId: string;
  /** The WorkOS organization the connection is scoped to, when the host established one. */
  organizationId?: string;
  /**
   * Host policy for the organization's shared connection. Only "permitted"
   * lets this actor authorize or use an organization-owned connection; the
   * default is that they may not, whatever a request claims.
   */
  organizationConnection?: "permitted" | "denied";
};

export interface WorkOsPrincipalPort {
  /**
   * Resolves the WorkOS principal for an owner. `ownerId` is absent when the
   * connection has not been created yet; the host then resolves the actor's
   * current owner of that kind (themselves, or the organization their
   * session is bound to) and reports which one it chose in `ownerId`.
   * Undefined means the host has no WorkOS identity for this owner.
   */
  resolve(input: {
    actor: ActorContext;
    tenantId: string;
    ownerKind: OwnerKind;
    ownerId?: string;
  }): Promise<WorkOsPrincipal | undefined>;
}
