import { dispatchHostedTenants, type DispatchReport } from "./continuations.js";
import type { HostedRuntime } from "./runtime.js";

/*
 * What the mounted dispatcher (`GET /api/internal/continuations`) does when
 * the operator's scheduler calls it with the cron secret: drain every
 * tenant's pending continuations and, when connectors are on, make the
 * custody drops each tenant's connections noted (including the sign-in of a
 * choice that expired unanswered). This is the hosted deployment's one
 * periodic mechanism, so the sweep needs no schedule of its own; the operator
 * command (`persistence-maintenance sweep-credentials`) stays for a tenant an
 * operator wants swept now. The sweep runs after every tenant's continuations,
 * under a time budget (`SWEEP_BUDGET_MS`), and what it did and could not do is
 * in the answer and, when anything failed, in one line on stderr of counts.
 */
export function hostedWorker(
  runtime: HostedRuntime,
  secret: string | undefined,
): { secret: string | undefined; dispatch(): Promise<DispatchReport> } {
  return {
    secret,
    dispatch: () =>
      dispatchHostedTenants(
        runtime,
        runtime.hosted.tenancy,
        runtime.hosted.connectors?.sweep,
        { log: (line) => process.stderr.write(`${line}\n`) },
      ),
  };
}
