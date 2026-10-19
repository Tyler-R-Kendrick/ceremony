import type { AsyncCeremonyStore } from "../../persistence/index.js";
import { sweepDropped } from "../dropped-credentials.js";
import type { Clock, ConnectionRecord } from "../ports.js";
import { checkTenant, timeSource, transact } from "./common.js";
import { createCredentialCustodyPort } from "./credentials.js";
import { abandonExpiredChoice } from "./expired-choices.js";
import { mayWaitOnSignIn } from "./legacy-pending.js";
import { storedConnectionSchema } from "./schemas.js";

/*
 * The retry of every drop that did not happen (dropped-credentials.ts): for
 * each connection of a tenant, the custody records it noted as dropped and no
 * longer names are dropped now. Idempotent, safe beside live traffic (a
 * record is dropped only through the custody port, under its own scope), and
 * meant to run on a schedule or from persistence maintenance. A sign-in
 * held for a choice that expired with nobody answering it is let go of first,
 * through the same note (expired-choices.ts), and dropped with the rest.
 *
 * The listing is the only read every connection costs: a connection is opened
 * only when its listed record can hold such a sign-in (it names one, or waits
 * on an input a person owes), so a tenant's idle connections cost pages of a
 * hundred rows and nothing more. A step that fails on one connection is
 * counted and the sweep goes on; `options.stop` is asked between connections
 * (the dispatcher's time budget) and ends the sweep early, reported.
 */

const PAGE = 100;

/**
 * What a sweep did. `failed` counts the connections whose step failed (an
 * unreadable record, a custody outage): each is left for the next sweep and
 * does not stop the others. `stopped` is present when `options.stop` ended
 * the sweep before it had seen every connection.
 */
export type SweepReport = { swept: number; failed: number; stopped?: true };

export async function sweepDroppedCredentials(
  store: AsyncCeremonyStore,
  rawTenant: string,
  options: { now?: Clock; stop?: () => boolean } = {},
): Promise<SweepReport> {
  const tenant = checkTenant(rawTenant);
  const custody = createCredentialCustodyPort(
    store,
    options.now ? { now: options.now } : {},
  );
  const time = timeSource(options.now);
  let swept = 0;
  let failed = 0;
  for (let after = ""; ;) {
    const page = await transact(store, (tx) =>
      tx.list(tenant, "connector-connection", PAGE, after),
    );
    for (const row of page) {
      if (options.stop?.()) return { swept, failed, stopped: true };
      const parsed = storedConnectionSchema.safeParse(row.value);
      if (!parsed.success) continue;
      const record = parsed.data.record as ConnectionRecord;
      try {
        // Only a connection that can hold a sign-in for a choice is opened;
        // the listing already says which (legacy-pending.ts).
        const abandoned = mayWaitOnSignIn(record)
          ? await abandonExpiredChoice(
              store,
              custody,
              tenant,
              { record, revision: row.revision },
              time,
            )
          : undefined;
        swept += await sweepDropped(custody, abandoned ?? record);
      } catch {
        failed++;
      }
    }
    if (page.length < PAGE) break;
    after = page.at(-1)!.id;
  }
  return { swept, failed };
}
