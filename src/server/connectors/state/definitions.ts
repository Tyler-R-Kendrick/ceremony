import {
  normalizedDefinitionSchema,
  sourceRecordSchema,
  type NormalizedDefinition,
  type SourceRecord,
} from "../../../core/connectors/index.js";
import {
  PersistenceConflict,
  type AsyncCeremonyStore,
} from "../../persistence/index.js";
import { runtimeBindingSchema, type RuntimeBinding } from "../binding.js";
import { ConnectorError } from "../errors.js";
import type { DefinitionStorePort } from "../ports.js";
import {
  SCHEMA_VERSION,
  checkTenant,
  isReference,
  readRecord,
  sameJson,
  scanPrefix,
  transact,
} from "./common.js";
import {
  bindingHeadKey,
  bindingKey,
  definitionKey,
  sourceKey,
} from "./keys.js";
import {
  bindingHeadSchema,
  storedBindingSchema,
  storedDefinitionSchema,
  storedSourceSchema,
} from "./schemas.js";

/*
 * Sources, definitions and bindings are descriptions with immutable identity.
 * A definition is written once per reference; a source may gain provenance
 * (an artifact handle, a license note) but never a different digest under
 * the same reference; a binding is immutable per revision and a new revision
 * is a new record, so an approval always names exactly what was reviewed.
 */

export interface ConnectorDefinitionStore extends DefinitionStorePort {
  listBindingRevisions(
    tenantId: string,
    bindingRef: string,
  ): Promise<RuntimeBinding[]>;
}

export function createDefinitionStore(
  store: AsyncCeremonyStore,
): ConnectorDefinitionStore {
  const bindingAt = async (
    tx: Parameters<Parameters<AsyncCeremonyStore["transaction"]>[0]>[0],
    tenantId: string,
    bindingRef: string,
    revision: number,
  ) =>
    (
      await readRecord(
        tx,
        bindingKey(tenantId, bindingRef, revision),
        storedBindingSchema,
      )
    )?.value.binding;

  return {
    async putSource(rawTenant, rawSource) {
      const tenantId = checkTenant(rawTenant);
      const parsed = sourceRecordSchema.safeParse(rawSource);
      if (!parsed.success)
        throw new ConnectorError("invalid-request", { detail: "source.record" });
      const source: SourceRecord = parsed.data;
      await transact(store, async (tx) => {
        const key = sourceKey(tenantId, source.sourceRef);
        const existing = await readRecord(tx, key, storedSourceSchema);
        if (existing) {
          if (sameJson(existing.value.source, source)) return;
          if (
            existing.value.source.digest.value !== source.digest.value ||
            !sameJson(existing.value.source.identity, source.identity)
          )
            throw new ConnectorError("conflict", { detail: "source.immutable" });
          await tx.put(
            key,
            { schemaVersion: SCHEMA_VERSION, source },
            existing.revision,
          );
          return;
        }
        await tx.put(key, { schemaVersion: SCHEMA_VERSION, source }, null);
      });
    },

    async getSource(rawTenant, sourceRef) {
      const tenantId = checkTenant(rawTenant);
      if (!isReference(sourceRef)) return undefined;
      return transact(
        store,
        async (tx) =>
          (await readRecord(tx, sourceKey(tenantId, sourceRef), storedSourceSchema))
            ?.value.source,
      );
    },

    async putDefinition(rawTenant, rawDefinition) {
      const tenantId = checkTenant(rawTenant);
      const parsed = normalizedDefinitionSchema.safeParse(rawDefinition);
      if (!parsed.success)
        throw new ConnectorError("invalid-request", {
          detail: "definition.record",
        });
      const definition: NormalizedDefinition = parsed.data;
      await transact(store, async (tx) => {
        const key = definitionKey(tenantId, definition.definitionRef);
        const existing = await readRecord(tx, key, storedDefinitionSchema);
        if (existing) {
          if (sameJson(existing.value.definition, definition)) return;
          throw new ConnectorError("conflict", { detail: "definition.immutable" });
        }
        try {
          await tx.put(key, { schemaVersion: SCHEMA_VERSION, definition }, null);
        } catch (error) {
          if (error instanceof PersistenceConflict)
            throw new ConnectorError("conflict", { detail: "definition.immutable" });
          throw error;
        }
      });
    },

    async getDefinition(rawTenant, definitionRef) {
      const tenantId = checkTenant(rawTenant);
      if (!isReference(definitionRef)) return undefined;
      return transact(
        store,
        async (tx) =>
          (
            await readRecord(
              tx,
              definitionKey(tenantId, definitionRef),
              storedDefinitionSchema,
            )
          )?.value.definition,
      );
    },

    async listDefinitions(rawTenant, filter = {}) {
      const tenantId = checkTenant(rawTenant);
      return transact(store, async (tx) => {
        const definitions: NormalizedDefinition[] = [];
        await scanPrefix(
          tx,
          tenantId,
          "connector-definition",
          "definition:",
          storedDefinitionSchema,
          ({ value }) => {
            if (
              !filter.ecosystem ||
              value.definition.identity.ecosystem === filter.ecosystem
            )
              definitions.push(value.definition);
          },
        );
        return definitions.sort((a, b) =>
          a.definitionRef.localeCompare(b.definitionRef),
        );
      });
    },

    async putBinding(rawBinding) {
      const parsed = runtimeBindingSchema.safeParse(rawBinding);
      if (!parsed.success)
        throw new ConnectorError("invalid-request", { detail: "binding.record" });
      const binding: RuntimeBinding = parsed.data;
      const tenantId = checkTenant(binding.tenantId);
      await transact(store, async (tx) => {
        const key = bindingKey(tenantId, binding.bindingRef, binding.revision);
        if (await tx.get(key))
          throw new ConnectorError("conflict", {
            detail: "binding.revision-exists",
          });
        try {
          await tx.put(key, { schemaVersion: SCHEMA_VERSION, binding }, null);
        } catch (error) {
          if (error instanceof PersistenceConflict)
            throw new ConnectorError("conflict", {
              detail: "binding.revision-exists",
            });
          throw error;
        }
        const headKey = bindingHeadKey(tenantId, binding.bindingRef);
        const head = await readRecord(tx, headKey, bindingHeadSchema);
        if (!head || head.value.revision < binding.revision)
          await tx.put(
            headKey,
            {
              schemaVersion: SCHEMA_VERSION,
              bindingRef: binding.bindingRef,
              revision: binding.revision,
            },
            head?.revision ?? null,
          );
      });
    },

    async getBinding(rawTenant, bindingRef, revision) {
      const tenantId = checkTenant(rawTenant);
      if (!isReference(bindingRef)) return undefined;
      if (
        revision !== undefined &&
        (!Number.isSafeInteger(revision) || revision < 0)
      )
        return undefined;
      return transact(store, async (tx) => {
        if (revision !== undefined)
          return bindingAt(tx, tenantId, bindingRef, revision);
        const head = await readRecord(
          tx,
          bindingHeadKey(tenantId, bindingRef),
          bindingHeadSchema,
        );
        if (!head) return undefined;
        return bindingAt(tx, tenantId, bindingRef, head.value.revision);
      });
    },

    async listBindings(rawTenant, filter = {}) {
      const tenantId = checkTenant(rawTenant);
      return transact(store, async (tx) => {
        const heads: Array<{ bindingRef: string; revision: number }> = [];
        await scanPrefix(
          tx,
          tenantId,
          "connector-binding",
          "head:",
          bindingHeadSchema,
          ({ value }) => {
            heads.push({ bindingRef: value.bindingRef, revision: value.revision });
          },
        );
        const bindings: RuntimeBinding[] = [];
        for (const head of heads) {
          const binding = await bindingAt(
            tx,
            tenantId,
            head.bindingRef,
            head.revision,
          );
          if (
            binding &&
            (!filter.definitionRef ||
              binding.definitionRef === filter.definitionRef) &&
            (!filter.adapterId || binding.adapterId === filter.adapterId)
          )
            bindings.push(binding);
        }
        return bindings.sort((a, b) => a.bindingRef.localeCompare(b.bindingRef));
      });
    },

    async listBindingRevisions(rawTenant, bindingRef) {
      const tenantId = checkTenant(rawTenant);
      if (!isReference(bindingRef)) return [];
      return transact(store, async (tx) => {
        const revisions: RuntimeBinding[] = [];
        await scanPrefix(
          tx,
          tenantId,
          "connector-binding",
          bindingKey(tenantId, bindingRef, 0).id.slice(0, -12),
          storedBindingSchema,
          ({ value }) => {
            revisions.push(value.binding);
          },
        );
        return revisions;
      });
    },
  };
}
