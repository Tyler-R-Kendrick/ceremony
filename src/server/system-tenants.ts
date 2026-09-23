/**
 * Tenants the server itself writes under, independent of any person.
 *
 * One list, so the writers and the check that keeps people out of them
 * cannot drift apart: a hosted identity whose claim named one of these would
 * put that person's records beside the server's own bookkeeping, and a tenant
 * missing here is one a claim could still name.
 */
export const SYSTEM_TENANT = Object.freeze({
  /** Hosted deployment records that belong to no tenant. */
  hosted: "hosted",
  /** The index of tenants a hosted deployment has seen. */
  hostedIndex: "hosted-tenants",
  /** Identity sessions and authorization bookkeeping. */
  identity: "identity",
  /** Records reached from a public route before anyone is signed in. */
  public: "public",
  /** Workload sessions and delegations. */
  workload: "workload",
  /** The connector event route index. */
  connectorEvents: "connector-events",
  /** The connector reference index. */
  connector: "connector",
  /** The air-gapped fixture import actor. */
  fixture: "fixture",
});

export const SYSTEM_TENANTS: readonly string[] = Object.freeze(
  Object.values(SYSTEM_TENANT),
);
