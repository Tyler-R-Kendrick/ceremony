import type { AsyncCeremonyStore } from "../../persistence/index.js";
import { sweepDropped } from "../dropped-credentials.js";
import type { Clock, ConnectionRecord } from "../ports.js";
import { checkTenant, transact } from "./common.js";
import { createCredentialCustodyPort } from "./credentials.js";
import { storedConnectionSchema } from "./schemas.js";

/*
 * The retry of every drop that did not happen (dropped-credentials.ts): for
 * each connection of a tenant, the custody records it noted as dropped and no
 * longer names are dropped now. Idempotent, safe beside live traffic (a
 * record is dropped only through the custody port, under its own scope), and
 * meant to run on a schedule or from persistence maintenance.
 */

const PAGE = 100;

export async function sweepDroppedCredentials(
  store: AsyncCeremonyStore,
  rawTenant: string,
  options: { now?: Clock } = {},
): Promise<{ swept: number }> {
  const tenant = checkTenant(rawTenant);
  const custody = createCredentialCustodyPort(
    store,
    options.now ? { now: options.now } : {},
  );
  let swept = 0;
  for (let after = ""; ;) {
    const page = await transact(store, (tx) =>
      tx.list(tenant, "connector-connection", PAGE, after),
    );
    for (const row of page) {
      const parsed = storedConnectionSchema.safeParse(row.value);
      if (parsed.success)
        swept += await sweepDropped(
          custody,
          parsed.data.record as ConnectionRecord,
        );
    }
    if (page.length < PAGE) break;
    after = page.at(-1)!.id;
  }
  return { swept };
}
