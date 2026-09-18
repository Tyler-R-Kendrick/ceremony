import type { AsyncCeremonyStore } from "../../persistence/index.js";
import { ConnectorError } from "../errors.js";
import {
  SCHEMA_VERSION,
  checkTenant,
  readRecord,
  scanPrefix,
  transact,
} from "./common.js";
import { supportKey } from "./keys.js";
import {
  storedSupportSchema,
  supportSnapshotSchema,
  type SupportSnapshot,
} from "./schemas.js";

/*
 * Support snapshots: the measured per-dimension capability report of one
 * adapter version at a point in time, kept so a directory can show evidence
 * that was actually recorded rather than a static claim. A snapshot is
 * replaced only by a newer capture for the same adapter and version.
 */

export interface SupportSnapshotStore {
  put(tenantId: string, snapshot: SupportSnapshot): Promise<void>;
  get(
    tenantId: string,
    adapterId: string,
    adapterVersion: string,
  ): Promise<SupportSnapshot | undefined>;
  list(tenantId: string): Promise<SupportSnapshot[]>;
}

export function createSupportSnapshotStore(
  store: AsyncCeremonyStore,
): SupportSnapshotStore {
  return {
    async put(rawTenant, rawSnapshot) {
      const tenantId = checkTenant(rawTenant);
      const parsed = supportSnapshotSchema.safeParse(rawSnapshot);
      if (!parsed.success)
        throw new ConnectorError("invalid-request", {
          detail: "support.snapshot",
        });
      const snapshot = parsed.data;
      await transact(store, async (tx) => {
        const key = supportKey(
          tenantId,
          snapshot.adapterId,
          snapshot.adapterVersion,
        );
        const existing = await readRecord(tx, key, storedSupportSchema);
        if (
          existing &&
          existing.value.snapshot.capturedAt > snapshot.capturedAt
        )
          throw new ConnectorError("conflict", {
            detail: "support.older-capture",
          });
        await tx.put(
          key,
          { schemaVersion: SCHEMA_VERSION, snapshot },
          existing?.revision ?? null,
        );
      });
    },
    async get(rawTenant, adapterId, adapterVersion) {
      const tenantId = checkTenant(rawTenant);
      if (typeof adapterId !== "string" || typeof adapterVersion !== "string")
        return undefined;
      return transact(
        store,
        async (tx) =>
          (
            await readRecord(
              tx,
              supportKey(tenantId, adapterId, adapterVersion),
              storedSupportSchema,
            )
          )?.value.snapshot,
      );
    },
    async list(rawTenant) {
      const tenantId = checkTenant(rawTenant);
      return transact(store, async (tx) => {
        const snapshots: SupportSnapshot[] = [];
        await scanPrefix(
          tx,
          tenantId,
          "connector-support",
          "adapter:",
          storedSupportSchema,
          ({ value }) => {
            snapshots.push(value.snapshot);
          },
        );
        return snapshots.sort((a, b) =>
          a.adapterId === b.adapterId
            ? a.adapterVersion.localeCompare(b.adapterVersion)
            : a.adapterId.localeCompare(b.adapterId),
        );
      });
    },
  };
}
