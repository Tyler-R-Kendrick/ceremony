/*
 * SEC-06. The mutation operators this swarm proposes for the security
 * mutation suite, as data: each names the guard, the exact source line, the
 * mutation that removes it, and the test that must fail when it is removed.
 *
 * `stryker.security.config.mjs` selects mutants by marker text, so each entry
 * carries the marker the integrator would pass to `guard(...)`. The ledger
 * carries the exact patch; this file is what the repository can check, so a
 * marker that drifts out of the source fails a test rather than silently
 * dropping a guard from the matrix.
 */

export type MutationOperator = {
  id: string;
  /** What the guard is for, in the vocabulary of the charter. */
  guard:
    | "owner-check"
    | "issuer-binding"
    | "resource-binding"
    | "destination-approval"
    | "effect-fencing"
    | "signature-verification"
    | "permission-recheck"
    | "positive-allowlist-projection";
  file: string;
  /** Exact substring the guard config matches on; must appear this many times. */
  marker: string;
  occurrences: number;
  /** The mutation an attacker (or Stryker) would apply. */
  mutation: string;
  /** Test that fails when the mutation is applied. */
  killedBy: string;
};

export const mutationOperators: readonly MutationOperator[] = Object.freeze([
  {
    id: "SEC-MUT-01",
    guard: "owner-check",
    file: "src/server/connectors/auth/handoff.ts",
    marker: "handoff.tenantId !== ctx.actor.tenantId ||",
    occurrences: 1,
    mutation:
      "Remove the tenant/binding/connection comparison from assertHandoffCurrent.",
    killedBy: "SEC-MUT-01 removing the handoff owner check is caught",
  },
  {
    id: "SEC-MUT-02",
    guard: "issuer-binding",
    file: "src/server/connectors/auth/authorization-code.ts",
    marker: "open.issuer !== input.server.issuer ||",
    occurrences: 1,
    mutation:
      "Remove the issuer/client/redirect-URI comparison before the code is exchanged.",
    killedBy: "SEC-MUT-02 removing the callback issuer binding is caught",
  },
  {
    id: "SEC-MUT-03",
    guard: "resource-binding",
    file: "src/server/connectors/auth/discovery.ts",
    marker: 'if (fetched.json["issuer"] !== issuer)',
    occurrences: 1,
    mutation:
      "Accept metadata whose `issuer` differs from the configured identifier.",
    killedBy: "SEC-MUT-03 removing the metadata issuer comparison is caught",
  },
  {
    id: "SEC-MUT-04",
    guard: "destination-approval",
    file: "src/server/connectors/import/network.ts",
    marker: 'if (!(policy.mode === "approved-private" && approved))',
    occurrences: 1,
    mutation:
      "Allow a private-range literal without an administrator-approved origin.",
    killedBy: "SEC-MUT-04 removing the private-destination approval is caught",
  },
  {
    id: "SEC-MUT-05",
    guard: "effect-fencing",
    file: "src/server/connectors/auth/authorization-code.ts",
    marker: "if (begun.prior)",
    occurrences: 1,
    mutation:
      "Exchange an authorization code again when the journal already has it.",
    killedBy: "SEC-MUT-05 removing the code-exchange fence is caught",
  },
  {
    id: "SEC-MUT-06",
    guard: "signature-verification",
    file: "src/server/connectors/providers/nango/webhooks.ts",
    marker: "timingSafeEqual(provided, expected)",
    occurrences: 1,
    mutation: "Return true from the webhook signature comparison.",
    killedBy: "SEC-MUT-06 removing webhook signature verification is caught",
  },
  {
    id: "SEC-MUT-07",
    guard: "permission-recheck",
    file: "src/server/connectors/commands/service.ts",
    marker: 'if (!allowed) throw new ConnectorError("denied", { detail });',
    occurrences: 1,
    mutation: "Treat a policy denial as an allow at every boundary.",
    killedBy:
      "denying one action blocks exactly that boundary, after the others succeeded",
  },
  {
    id: "SEC-MUT-08",
    guard: "positive-allowlist-projection",
    file: "src/core/connectors/projections.ts",
    marker: "export function agentConnectorProjection(",
    occurrences: 1,
    mutation:
      "Return the whole summary instead of the named fields (spread instead of allowlist).",
    killedBy: "SEC-MUT-08 turning a projection into a spread is caught",
  },
  {
    id: "SEC-MUT-09",
    guard: "positive-allowlist-projection",
    file: "src/server/connectors/registries/mcp/projections.ts",
    marker: "if (projected.privateRemoteUrls.length)",
    occurrences: 1,
    mutation:
      "Publish an entry whose projection named a private network anyway.",
    killedBy:
      "SEC-MUT-09 removing the private-network exclusion from publication is caught",
  },
]);
