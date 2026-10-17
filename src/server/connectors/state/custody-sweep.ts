import type { AsyncCeremonyStore } from "../../persistence/index.js";
import { sweepDropped } from "../dropped-credentials.js";
import type { Clock, ConnectionRecord } from "../ports.js";
import { checkTenant, timeSource, transact } from "./common.js";
import { createCredentialCustodyPort } from "./credentials.js";
import { abandonExpiredChoice } from "./expired-choices.js";
import { storedConnectionSchema } from "./schemas.js";

/*
 * The retry of every drop that did not happen (dropped-credentials.ts): for
 * each connection of a tenant, the custody records it noted as dropped and no
 * longer names are dropped now. Idempotent, safe beside live traffic (a
 * record is dropped only through the custody port, under its own scope), and
 * meant to run on a schedule or from persistence maintenance. A sign-in
 * held for a choice that expired with nobody answering it is let go of first,
 * through the same note (expired-choices.ts), and dropped with the rest.
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
  const time = timeSource(options.now);
  let swept = 0;
  for (let after = ""; ;) {
    const page = await transact(store, (tx) =>
      tx.list(tenant, "connector-connection", PAGE, after),
    );
    for (const row of page) {
      const parsed = storedConnectionSchema.safeParse(row.value);
      if (!parsed.success) continue;
      const record = parsed.data.record as ConnectionRecord;
      const abandoned = await abandonExpiredChoice(
        store,
        custody,
        tenant,
        record.connectionRef,
        time,
      ).catch(() => undefined);
      swept += await sweepDropped(custody, abandoned ?? record);
    }
    if (page.length < PAGE) break;
    after = page.at(-1)!.id;
  }
  return { swept };
}
