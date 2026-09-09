import { randomUUID } from "node:crypto";
import { z } from "zod";
import {
  actorContextSchema,
  identifierSchema,
  semanticVersionSchema,
  type ActorContext,
} from "../../core/operation-contracts.js";
import type { AsyncCeremonyStore, AsyncTransaction } from "./index.js";

export const privateCollectionBindingSchema = z
  .object({
    purpose: identifierSchema,
    provider: identifierSchema,
    operationId: identifierSchema,
    operationVersion: semanticVersionSchema,
    runId: identifierSchema,
    nodeId: identifierSchema,
    revision: z.number().int().nonnegative(),
    fields: z
      .array(identifierSchema)
      .min(1)
      .max(32)
      .refine((fields) => new Set(fields).size === fields.length),
  })
  .strict();
export type PrivateCollectionBinding = z.infer<
  typeof privateCollectionBindingSchema
>;
const valuesSchema = z
  .record(identifierSchema, z.string().max(30000))
  .refine(
    (values) =>
      Object.keys(values).length <= 32 &&
      Object.values(values).reduce(
        (size, value) => size + Buffer.byteLength(value),
        0,
      ) <= 65536,
  );
type Collection = {
  tag: "private-collection";
  subject: string;
  binding: PrivateCollectionBinding;
  values: Record<string, string>;
  expires: number;
  commandId?: string;
  recoveryExpires?: number;
};
type Association = {
  subject: string;
  binding: PrivateCollectionBinding;
  reference: string;
  state: "bound" | "purged";
};
const unavailable = () => new Error("Private collection unavailable");
function binding(value: PrivateCollectionBinding): PrivateCollectionBinding {
  const parsed = privateCollectionBindingSchema.safeParse(value);
  if (!parsed.success) throw unavailable();
  return { ...parsed.data, fields: [...parsed.data.fields].sort() };
}
function equivalent(a: PrivateCollectionBinding, b: PrivateCollectionBinding) {
  return (
    a.purpose === b.purpose &&
    a.provider === b.provider &&
    a.operationId === b.operationId &&
    a.operationVersion === b.operationVersion &&
    a.runId === b.runId &&
    a.nodeId === b.nodeId &&
    a.revision === b.revision &&
    a.fields.length === b.fields.length &&
    a.fields.every((field, index) => field === b.fields[index])
  );
}
function identity(actor: ActorContext) {
  if (!actorContextSchema.safeParse(actor).success) throw unavailable();
  return actor;
}
function commandKey(actor: ActorContext, commandId: string) {
  if (!identifierSchema.safeParse(commandId).success) throw unavailable();
  return {
    tenant: actor.tenantId,
    kind: "command" as const,
    id: `private:${commandId}`,
  };
}
function collectionKey(actor: ActorContext, ref: string) {
  if (!z.uuid().safeParse(ref).success) throw unavailable();
  return { tenant: actor.tenantId, kind: "collection" as const, id: ref };
}

/** Server-only private transport. An authenticated host supplies actor and trusted operation binding, never browser owner/source labels. */
export class AsyncPrivateCollectionBroker {
  constructor(
    private readonly store: AsyncCeremonyStore,
    private readonly recoveryTtlMs = 3600000,
  ) {
    if (
      !Number.isSafeInteger(recoveryTtlMs) ||
      recoveryTtlMs < 1 ||
      recoveryTtlMs > 86400000
    )
      throw new Error("Invalid private recovery lifetime");
  }
  async collect(
    actor: ActorContext,
    contract: PrivateCollectionBinding,
    input: unknown,
    ttlMs = 300000,
  ): Promise<string> {
    identity(actor);
    if (
      actor.actorKind !== "human" ||
      !Number.isSafeInteger(ttlMs) ||
      ttlMs < 1 ||
      ttlMs > 300000
    )
      throw unavailable();
    const checked = binding(contract);
    const values = valuesSchema.safeParse(input);
    if (
      !values.success ||
      Object.keys(values.data).sort().join("\0") !== checked.fields.join("\0")
    )
      throw unavailable();
    const ref = randomUUID();
    await this.store.transaction(async (tx) => {
      const record: Collection = {
        tag: "private-collection",
        subject: actor.subjectId,
        binding: checked,
        values: values.data,
        expires: (await tx.now()) + ttlMs,
      };
      await tx.put(collectionKey(actor, ref), record, null);
    });
    return ref;
  }
  async consume(
    actor: ActorContext,
    contract: PrivateCollectionBinding,
    reference: string,
    commandId: string,
  ): Promise<Record<string, string>> {
    return this.store.transaction((tx) =>
      this.consumeIn(tx, actor, contract, reference, commandId),
    );
  }
  /** Call inside the SAME transaction as command admission. A rollback restores the unconsumed collection. */
  async consumeIn(
    tx: AsyncTransaction,
    actor: ActorContext,
    contract: PrivateCollectionBinding,
    reference: string,
    commandId: string,
  ): Promise<Record<string, string>> {
    identity(actor);
    const checked = binding(contract);
    const key = collectionKey(actor, reference);
    const associationKey = commandKey(actor, commandId);
    const record = await tx.get<Collection>(key);
    const association = await tx.get<Association>(associationKey);
    const now = await tx.now();
    if (
      !record ||
      record.value.tag !== "private-collection" ||
      record.value.subject !== actor.subjectId ||
      !equivalent(record.value.binding, checked)
    )
      throw unavailable();
    if (
      association &&
      (association.value.subject !== actor.subjectId ||
        association.value.reference !== reference ||
        association.value.state !== "bound" ||
        !equivalent(association.value.binding, checked))
    )
      throw unavailable();
    if (record.value.commandId) {
      if (
        record.value.commandId !== commandId ||
        !association ||
        !record.value.recoveryExpires ||
        record.value.recoveryExpires <= now
      )
        throw unavailable();
      return record.value.values;
    }
    if (record.value.expires <= now || association) throw unavailable();
    await tx.put(
      key,
      { ...record.value, commandId, recoveryExpires: now + this.recoveryTtlMs },
      record.revision,
    );
    await tx.put(
      associationKey,
      {
        subject: actor.subjectId,
        binding: checked,
        reference,
        state: "bound",
      } satisfies Association,
      null,
    );
    return record.value.values;
  }
  async complete(
    actor: ActorContext,
    contract: PrivateCollectionBinding,
    reference: string,
    commandId: string,
  ): Promise<void> {
    identity(actor);
    const checked = binding(contract);
    await this.store.transaction(async (tx) => {
      const key = collectionKey(actor, reference);
      const record = await tx.get<Collection>(key);
      const associationKey = commandKey(actor, commandId);
      const association = await tx.get<Association>(associationKey);
      if (
        !association ||
        association.value.subject !== actor.subjectId ||
        association.value.reference !== reference ||
        !equivalent(association.value.binding, checked)
      )
        throw unavailable();
      if (record) {
        if (
          record.value.subject !== actor.subjectId ||
          record.value.commandId !== commandId
        )
          throw unavailable();
        await tx.delete(key, record.revision);
      }
      if (association.value.state !== "purged")
        await tx.put(
          associationKey,
          { ...association.value, state: "purged" },
          association.revision,
        );
    });
  }
  /** Trusted retention worker only. Audit and command tombstones have independent policies and are not deleted here. */
  async purgeExpired(
    tenant: string,
    limit = 100,
    afterId = "",
  ): Promise<{ deleted: number; lastId: string | undefined }> {
    return this.store.transaction(async (tx) => {
      const records = await tx.list<Collection>(
        tenant,
        "collection",
        limit,
        afterId,
      );
      const now = await tx.now();
      let deleted = 0;
      for (const record of records) {
        if (record.value.tag !== "private-collection") continue;
        const expires = record.value.commandId
          ? record.value.recoveryExpires
          : record.value.expires;
        if (expires !== undefined && expires <= now) {
          await tx.delete(
            { tenant, kind: "collection", id: record.id },
            record.revision,
          );
          deleted++;
        }
      }
      return { deleted, lastId: records.at(-1)?.id };
    });
  }
}
