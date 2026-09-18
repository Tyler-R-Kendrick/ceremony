import { createHash } from "node:crypto";
import { z } from "zod";
import type { AsyncCeremonyStore } from "../../persistence/index.js";
import { ConnectorError } from "../errors.js";
import type { Clock, SourceArtifactPort } from "../ports.js";
import {
  SCHEMA_VERSION,
  checkTenant,
  readRecord,
  scanPrefix,
  timeSource,
  transact,
} from "./common.js";
import { artifactKey } from "./keys.js";
import { mediaTypeSchema, storedArtifactSchema } from "./schemas.js";

/*
 * Raw source bytes are protected artifacts: encrypted at rest, tenant scoped,
 * addressed by their verified digest, retained until an explicit deletion or
 * a retention deadline, and never part of any projection. An artifact past
 * its retention is not served even before the purge removes it.
 */

export type SourceArtifactOptions = { now?: Clock; maxBytes?: number };

export interface ConnectorSourceArtifacts extends SourceArtifactPort {
  /** Trusted retention worker only; removes artifacts past `retainUntil` in bounded pages. */
  purgeExpired(
    tenantId: string,
    limit?: number,
    afterId?: string,
  ): Promise<{ deleted: number; lastId: string | undefined }>;
  describe(
    tenantId: string,
    artifactRef: string,
  ): Promise<
    | {
        digest: string;
        mediaType: string;
        byteLength: number;
        retainUntil?: number;
      }
    | undefined
  >;
}

const refPattern = /^artifact:[a-f0-9]{64}$/;
const retainSchema = z.number().int().positive().optional();

export function createSourceArtifactPort(
  store: AsyncCeremonyStore,
  options: SourceArtifactOptions = {},
): ConnectorSourceArtifacts {
  const time = timeSource(options.now);
  const maxBytes = options.maxBytes ?? 8 * 1024 * 1024;
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1)
    throw new ConnectorError("invalid-request", {
      detail: "artifact.max-bytes",
    });

  return {
    async put(rawTenant, bytes, meta) {
      const tenantId = checkTenant(rawTenant);
      if (!(bytes instanceof Uint8Array) || bytes.byteLength > maxBytes)
        throw new ConnectorError("invalid-request", {
          detail: "artifact.bytes",
        });
      const mediaType = mediaTypeSchema.safeParse(meta?.mediaType);
      const retainUntil = retainSchema.safeParse(meta?.retainUntil);
      if (!mediaType.success || !retainUntil.success)
        throw new ConnectorError("invalid-request", {
          detail: "artifact.meta",
        });
      const digest = createHash("sha256").update(bytes).digest("hex");
      if (meta.digest !== digest)
        throw new ConnectorError("invalid-request", {
          detail: "artifact.digest-mismatch",
        });
      const artifactRef = `artifact:${digest}`;
      await transact(store, async (tx) => {
        const key = artifactKey(tenantId, digest);
        const at = await time(tx);
        const existing = await readRecord(tx, key, storedArtifactSchema);
        if (existing) {
          const { retainUntil: _previous, ...base } = existing.value;
          const merged =
            _previous === undefined || retainUntil.data === undefined
              ? undefined
              : Math.max(_previous, retainUntil.data);
          await tx.put(
            key,
            {
              ...base,
              ...(merged === undefined ? {} : { retainUntil: merged }),
            },
            existing.revision,
          );
          return;
        }
        await tx.put(
          key,
          {
            schemaVersion: SCHEMA_VERSION,
            artifactRef,
            digest,
            mediaType: mediaType.data,
            byteLength: bytes.byteLength,
            bytes: Buffer.from(bytes).toString("base64"),
            createdAt: at,
            ...(retainUntil.data === undefined
              ? {}
              : { retainUntil: retainUntil.data }),
          },
          null,
        );
      });
      return artifactRef;
    },

    async get(rawTenant, artifactRef) {
      const tenantId = checkTenant(rawTenant);
      if (!refPattern.test(artifactRef)) return undefined;
      return transact(store, async (tx) => {
        const record = await readRecord(
          tx,
          artifactKey(tenantId, artifactRef.slice("artifact:".length)),
          storedArtifactSchema,
        );
        if (!record) return undefined;
        if (
          record.value.retainUntil !== undefined &&
          record.value.retainUntil <= (await time(tx))
        )
          return undefined;
        return {
          bytes: new Uint8Array(Buffer.from(record.value.bytes, "base64")),
          mediaType: record.value.mediaType,
          digest: record.value.digest,
        };
      });
    },

    async describe(rawTenant, artifactRef) {
      const tenantId = checkTenant(rawTenant);
      if (!refPattern.test(artifactRef)) return undefined;
      return transact(store, async (tx) => {
        const record = await readRecord(
          tx,
          artifactKey(tenantId, artifactRef.slice("artifact:".length)),
          storedArtifactSchema,
        );
        if (!record) return undefined;
        return {
          digest: record.value.digest,
          mediaType: record.value.mediaType,
          byteLength: record.value.byteLength,
          ...(record.value.retainUntil === undefined
            ? {}
            : { retainUntil: record.value.retainUntil }),
        };
      });
    },

    async delete(rawTenant, artifactRef) {
      const tenantId = checkTenant(rawTenant);
      if (!refPattern.test(artifactRef)) return;
      await transact(store, async (tx) => {
        const key = artifactKey(
          tenantId,
          artifactRef.slice("artifact:".length),
        );
        const record = await tx.get(key);
        if (record) await tx.delete(key, record.revision);
      });
    },

    async purgeExpired(rawTenant, limit = 100, afterId = "") {
      const tenantId = checkTenant(rawTenant);
      return transact(store, async (tx) => {
        const at = await time(tx);
        let deleted = 0;
        let lastId: string | undefined;
        let seen = 0;
        await scanPrefix(
          tx,
          tenantId,
          "connector-artifact",
          afterId || "artifact:",
          storedArtifactSchema,
          async ({ id, revision, value }) => {
            lastId = id;
            seen++;
            if (value.retainUntil !== undefined && value.retainUntil <= at) {
              await tx.delete(
                { tenant: tenantId, kind: "connector-artifact", id },
                revision,
              );
              deleted++;
            }
            if (seen >= limit) return false;
          },
        );
        return { deleted, lastId };
      });
    },
  };
}
