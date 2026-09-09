import { z } from "zod";
import { type AsyncCeremonyStore, type Keyring, recordKinds } from "./index.js";

/** Configuration comes from the operator secret store, never backup material. At most four previous keys. */
export function configuredKeyring(env: NodeJS.ProcessEnv): Keyring {
  try {
    const id = z
      .string()
      .regex(/^[A-Za-z0-9_-]{1,64}$/)
      .parse(env.CEREMONY_VAULT_KEY_ID);
    const key = z
      .string()
      .regex(/^[a-fA-F0-9]{64}$/)
      .parse(env.CEREMONY_VAULT_KEY);
    const raw = env.CEREMONY_VAULT_PREVIOUS_KEYS ?? "{}";
    if (raw.length > 1024) throw new Error();
    const previous = z
      .record(
        z.string().regex(/^[A-Za-z0-9_-]{1,64}$/),
        z.string().regex(/^[a-fA-F0-9]{64}$/),
      )
      .parse(JSON.parse(raw));
    if (Object.keys(previous).length > 4 || Object.hasOwn(previous, id))
      throw new Error();
    return {
      current: id,
      keys: Object.fromEntries(
        Object.entries({ ...previous, [id]: key }).map(([name, value]) => [
          name,
          Buffer.from(value, "hex"),
        ]),
      ),
    };
  } catch {
    throw new Error("Invalid vault keyring configuration");
  }
}

export async function rotateTenant(
  store: AsyncCeremonyStore,
  tenant: string,
): Promise<number> {
  let count = 0;
  for (const kind of recordKinds) {
    let after = "";
    for (;;) {
      const page = await store.transaction(async (tx) => {
        const records = await tx.list(tenant, kind, 100, after);
        for (const record of records)
          await tx.put(
            { tenant, kind, id: record.id },
            record.value,
            record.revision,
          );
        return records;
      });
      if (!page.length) break;
      count += page.length;
      after = page.at(-1)!.id;
    }
  }
  return count;
}

/** Explicit operator retention selection; recording sessions cannot be deleted. Audit/recipe records are untouched. */
export async function retainWithoutDemonstration(
  store: AsyncCeremonyStore,
  tenant: string,
  id: string,
): Promise<void> {
  await store.transaction(async (tx) => {
    const key = { tenant, kind: "demonstration" as const, id };
    const demo = await tx.get<{ consent: string; runId: string }>(key);
    if (!demo || !["stopped", "discarded"].includes(demo.value.consent))
      throw new Error("Demonstration retention requires stopped material");
    let after = `${id}:`;
    for (;;) {
      const page = await tx.list<{ demonstrationId?: string }>(
        tenant,
        "event",
        100,
        after,
      );
      const own = page.filter((r) => r.id.startsWith(`${id}:`));
      for (const r of own) {
        if (r.value.demonstrationId !== id)
          throw new Error("Demonstration retention binding invalid");
        await tx.delete({ tenant, kind: "event", id: r.id }, r.revision);
      }
      if (own.length < 100) break;
      after = own.at(-1)!.id;
    }
    const pointer = {
      tenant,
      kind: "session" as const,
      id: `demonstration:${demo.value.runId}`,
    };
    const current = await tx.get<{ id: string }>(pointer);
    if (current?.value.id === id) await tx.delete(pointer, current.revision);
    await tx.delete(key, demo.revision);
  });
}
