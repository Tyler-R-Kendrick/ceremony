import { z } from "zod";
import type { AsyncCeremonyStore } from "../../persistence/index.js";
import {
  storedClientRegistrationSchema,
  type ClientRegistrationStorePort,
  type StoredClientRegistration,
} from "../auth/client.js";
import { ConnectorError } from "../errors.js";
import { SCHEMA_VERSION, checkTenant, readRecord, transact } from "./common.js";
import { registrationKey } from "./keys.js";

/*
 * RFC 7591 dynamic client registrations over the encrypted store. A
 * registration holds the client secret and the registration access token the
 * issuer returned, so it lives under its own record kind, encrypted like a
 * credential (every record value is AES-256-GCM, bound to tenant, kind, id and
 * revision), and is never listed or projected. `create` is insert-only: when
 * two workers register at once, or a replayed command registers again, the
 * first record wins and the loser is told so, because the issuer's other state
 * refers to the first client.
 */

const storedRegistrationSchema = z.strictObject({
  schemaVersion: z.literal(SCHEMA_VERSION),
  registration: storedClientRegistrationSchema,
});

export function createClientRegistrationStore(
  store: AsyncCeremonyStore,
): ClientRegistrationStorePort {
  const keyOf = (tenantId: string, key: string) => {
    if (typeof key !== "string" || !key || key.length > 512)
      throw new ConnectorError("invalid-request", {
        detail: "oauth.registration.key",
      });
    // Digested into the id, so the stored id stays inside the persistence
    // key alphabet whatever the caller passes.
    return registrationKey(checkTenant(tenantId), key);
  };
  return {
    async get(tenantId, key) {
      const recordKey = keyOf(tenantId, key);
      return transact(store, async (tx) => {
        const record = await readRecord(
          tx,
          recordKey,
          storedRegistrationSchema,
        );
        return record?.value.registration as
          StoredClientRegistration | undefined;
      });
    },
    async create(tenantId, key, raw) {
      const recordKey = keyOf(tenantId, key);
      const parsed = storedClientRegistrationSchema.safeParse(raw);
      if (!parsed.success)
        throw new ConnectorError("invalid-request", {
          detail: "oauth.registration.record",
        });
      try {
        return await transact(store, async (tx) => {
          if (await tx.get(recordKey)) return false;
          await tx.put(
            recordKey,
            { schemaVersion: SCHEMA_VERSION, registration: parsed.data },
            null,
          );
          return true;
        });
      } catch (error) {
        // A concurrent insert committed first; its record is the one to use.
        if (error instanceof ConnectorError && error.code === "conflict")
          return false;
        throw error;
      }
    },
  };
}
