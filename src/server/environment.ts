import { parseEnv } from "node:util";
import { z } from "zod";
import { CeremonyDatabase } from "./storage.js";
import { CeremonyError } from "./controller.js";

const valuesSchema = z.record(
  z.string().regex(/^[A-Za-z_][A-Za-z0-9_]{0,127}$/),
  z.string().max(16_384),
);
const recordSchema = z.object({
  revision: z.number().int().nonnegative(),
  values: valuesSchema,
});
const editSchema = z
  .object({
    revision: z.number().int().nonnegative(),
    values: valuesSchema.default({}),
    remove: z.array(z.string()).max(100).default([]),
    dotenv: z.string().max(64_000).optional(),
  })
  .strict();

/** Server-only session configuration, shared by connectors. Never exposed to tools. */
export class CeremonyEnvironment {
  constructor(private readonly db: CeremonyDatabase) {}
  private key(owner: string) {
    return `session-environment:${JSON.stringify(owner)}`;
  }
  private record(owner: string) {
    const existing = this.db.get(this.key(owner), recordSchema);
    if (existing) return existing;
    let values: Record<string, string> = {};
    for (const key of this.db.keys("environment:")) {
      const [legacyOwner] = JSON.parse(key.slice("environment:".length));
      if (legacyOwner !== owner) continue;
      const legacy = this.db.get(key, recordSchema)!;
      for (const [name, value] of Object.entries(legacy.values)) {
        if (Object.hasOwn(values, name) && values[name] !== value)
          throw new CeremonyError(
            "Legacy environment values conflict. Reconcile duplicate variable names before migration.",
            409,
          );
      }
      values = { ...values, ...legacy.values };
    }
    if (
      Object.keys(values).length > 100 ||
      Buffer.byteLength(JSON.stringify(values)) > 64_000
    )
      throw new CeremonyError(
        "Legacy environment exceeds session limits. Reconcile before migration.",
        409,
      );
    const record = { revision: 0, values };
    this.db.put(this.key(owner), record);
    return record;
  }
  read(owner: string): Record<string, string> {
    return this.record(owner).values;
  }
  describe(owner: string) {
    const record = this.record(owner);
    return {
      revision: record.revision,
      names: Object.keys(record.values).sort(),
    };
  }
  update(owner: string, input: unknown) {
    const checked = editSchema.safeParse(input);
    if (!checked.success)
      throw new CeremonyError(
        "Invalid environment edit. Check variable names and size limits.",
        400,
      );
    const edit = checked.data;
    let imported: Record<string, string> = {};
    if (edit.dotenv !== undefined) {
      const parsed = valuesSchema.safeParse(parseEnv(edit.dotenv));
      if (!parsed.success || !Object.keys(parsed.data).length)
        throw new CeremonyError(
          "No valid environment assignments found in the file.",
          400,
        );
      imported = parsed.data;
    }
    return this.db.transaction(() => {
      const record = this.record(owner);
      if (record.revision !== edit.revision)
        throw new CeremonyError(
          "Environment changed. Reload before saving.",
          409,
        );
      const values = { ...record.values, ...imported, ...edit.values };
      for (const name of edit.remove) delete values[name];
      if (
        Object.keys(values).length > 100 ||
        Buffer.byteLength(JSON.stringify(values)) > 64_000
      )
        throw new CeremonyError(
          "Environment exceeds 100 variables or 64 KB.",
          400,
        );
      this.db.put(this.key(owner), {
        revision: record.revision + 1,
        values,
      });
      return this.describe(owner);
    });
  }
}
