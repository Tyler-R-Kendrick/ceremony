import { timingSafeEqual } from "node:crypto";
import { z } from "zod";
import type {
  TeachingRuntime,
  TeachingRuntimeOptions,
} from "../teaching-runtime.js";
import { dispatchAgentWakes } from "../agent/workflow-api.js";

/** Explicit host configuration only. Endpoint and authorization never come from a recipe or browser request. */
export function hostedContinuation(
  env: NodeJS.ProcessEnv,
  fetcher: typeof fetch = fetch,
): TeachingRuntimeOptions["continuation"] {
  if (!env.CEREMONY_CONTINUATION_URL && !env.CEREMONY_CONTINUATION_TOKEN)
    return undefined;
  const endpoint = new URL(env.CEREMONY_CONTINUATION_URL ?? "");
  const token = env.CEREMONY_CONTINUATION_TOKEN;
  if (
    endpoint.protocol !== "https:" ||
    endpoint.username ||
    endpoint.password ||
    endpoint.search ||
    endpoint.hash ||
    !token ||
    token.length < 32
  )
    throw new Error("Invalid host continuation configuration");
  return {
    id: "host-task",
    async handler(input) {
      try {
        const response = await fetcher(endpoint, {
          method: "POST",
          redirect: "error",
          signal: AbortSignal.timeout(15000),
          headers: {
            authorization: `Bearer ${token}`,
            "content-type": "application/json",
            "idempotency-key": input.deliveryId,
          },
          body: JSON.stringify(input),
        });
        if (!response.ok) throw new Error();
        const ack = z
          .object({ deliveryId: z.string(), completed: z.literal(true) })
          .strict()
          .parse(await response.json());
        if (ack.deliveryId !== input.deliveryId) throw new Error();
      } catch {
        throw new Error("Host continuation unavailable");
      }
    },
  };
}
export async function dispatchHostedContinuations(
  runtime: TeachingRuntime,
  tenant: string,
): Promise<void> {
  await dispatchAgentWakes(runtime, tenant);
  let after = "";
  const subjects = new Set<string>();
  for (;;) {
    const page = await runtime.store.transaction((tx) =>
      tx.list<{ subjectId?: string; status?: string }>(
        tenant,
        "outbox",
        100,
        after,
      ),
    );
    for (const row of page)
      if (row.value.status === "pending" && row.value.subjectId)
        subjects.add(row.value.subjectId);
    if (page.length < 100) break;
    after = page.at(-1)!.id;
  }
  for (const subjectId of subjects)
    await runtime.flushContinuations({
      tenantId: tenant,
      subjectId,
      sessionId: "continuation-workload",
      actorKind: "system",
      capabilities: ["executor"],
    });
}
/**
 * The longest the custody sweep runs in one scheduled call, across all
 * tenants. The sweep is housekeeping: it must never use up the call that
 * resumes work, and a tenant it does not reach is swept by the next call.
 */
export const SWEEP_BUDGET_MS = 10_000;

/** What a scheduled call did beyond dispatching: counts only, never a name or a value. */
export type DispatchReport = {
  swept: number;
  /** Connections whose sweep step failed; each is retried by the next call. */
  failed: number;
  /** Tenants the budget cut short or never reached. */
  incomplete: number;
};

export type DispatchOptions = {
  budgetMs?: number;
  /** A monotonic clock in milliseconds; a test injects its own. */
  monotonic?: () => number;
  /** One line, made of counts, when anything failed or was left for the next call. */
  log?: (line: string) => void;
};

/**
 * Drains every tenant this deployment has seen, not only a pinned one: first
 * every tenant's continuations, then, when connectors are on, `maintain` (the
 * custody sweep) for each tenant under one time budget, so housekeeping can
 * delay nobody's wake. One tenant's failure does not starve the others; it is
 * reported after all of them had their turn, so the scheduler still sees the
 * run as failed.
 */
export async function dispatchHostedTenants(
  runtime: TeachingRuntime,
  tenancy: { tenants(store: TeachingRuntime["store"]): Promise<string[]> },
  maintain?: (
    tenant: string,
    stop: () => boolean,
  ) => Promise<{ swept: number; failed: number; stopped?: true }>,
  options: DispatchOptions = {},
): Promise<DispatchReport> {
  const tenants = await tenancy.tenants(runtime.store);
  let tenantsFailed = 0;
  const fail = () => {
    tenantsFailed++;
  };
  for (const tenant of tenants)
    await dispatchHostedContinuations(runtime, tenant).catch(fail);
  const report: DispatchReport = { swept: 0, failed: 0, incomplete: 0 };
  if (maintain) {
    const monotonic = options.monotonic ?? (() => performance.now());
    const until = monotonic() + (options.budgetMs ?? SWEEP_BUDGET_MS);
    const stop = () => monotonic() >= until;
    for (const tenant of tenants) {
      if (stop()) {
        report.incomplete++;
        continue;
      }
      try {
        const done = await maintain(tenant, stop);
        report.swept += done.swept;
        report.failed += done.failed;
        if (done.stopped) report.incomplete++;
      } catch {
        fail();
      }
    }
  }
  if (report.failed || report.incomplete || tenantsFailed)
    options.log?.(
      JSON.stringify({ event: "custody-sweep", ...report, tenantsFailed }),
    );
  if (tenantsFailed) throw new Error("Hosted continuation dispatch incomplete");
  return report;
}
/** Dedicated cron/workload authentication; not end-user authentication or a grant for a different task. */
export function validContinuationWorker(
  request: Request,
  secret: string | undefined,
): boolean {
  if (!secret || secret.length < 32) return false;
  const value = request.headers.get("authorization") ?? "";
  const expected = `Bearer ${secret}`;
  return (
    Buffer.byteLength(value) === Buffer.byteLength(expected) &&
    timingSafeEqual(Buffer.from(value), Buffer.from(expected))
  );
}
