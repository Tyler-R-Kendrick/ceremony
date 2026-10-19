import type { ConnectionRecord } from "../../../src/server/connectors/ports.js";

/*
 * Holding one call open while something else runs to its end: the way these
 * tests put two commands in a chosen order without a sleep. `hold` replaces
 * `owner[method]` so that its first call waits until `release()`; `reached`
 * resolves when that call arrives. Later calls go straight through.
 */

export function hold(owner: object, method: string) {
  const target = owner as Record<string, (...args: unknown[]) => unknown>;
  const real = target[method]!.bind(owner);
  const reached = Promise.withResolvers<void>();
  const gate = Promise.withResolvers<void>();
  let first = true;
  target[method] = async (...args: unknown[]) => {
    if (first) {
      first = false;
      reached.resolve();
      await gate.promise;
    }
    return real(...args);
  };
  return { reached: reached.promise, release: () => gate.resolve() };
}

/** A promise's outcome as a value, so a test can look at a refusal without a try. */
export const settle = <T>(promise: Promise<T>) =>
  promise.then(
    (value) => ({ value }) as { value: T; error?: undefined },
    (error: unknown) => ({ error }) as { value?: undefined; error: unknown },
  );

export const scopeOf = (record: ConnectionRecord) => ({
  tenantId: record.tenantId,
  ownerKind: record.ownerKind,
  ownerId: record.ownerId,
  connectionRef: record.connectionRef,
  bindingRef: record.bindingRef,
  custody: record.custody,
});

type Custody = {
  describe: (
    scope: ReturnType<typeof scopeOf>,
    ref: string,
  ) => Promise<unknown>;
};

/**
 * What custody holds against what the record points at: `leaked` is held and
 * named by nothing, `dangling` is named and no longer held.
 */
export async function custodyAudit(
  credentials: Custody,
  stored: readonly string[],
  record: ConnectionRecord,
) {
  const scope = scopeOf(record);
  const held: string[] = [];
  for (const ref of new Set(stored))
    if (await credentials.describe(scope, ref)) held.push(ref);
  const named = [record.credentialRef, record.state["pendingSession"]].filter(
    (ref): ref is string => typeof ref === "string",
  );
  return {
    held,
    leaked: held.filter((ref) => !named.includes(ref)),
    dangling: named.filter((ref) => !held.includes(ref)),
  };
}
