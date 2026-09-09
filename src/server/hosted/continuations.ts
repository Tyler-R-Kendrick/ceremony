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
