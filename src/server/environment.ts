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

/** Server-only connector configuration. Never merges into process.env or exposes values to tools. */
export class CeremonyEnvironment {
  constructor(private readonly db: CeremonyDatabase) {}
  private key(owner: string, connector: string) {
    return `environment:${JSON.stringify([owner, connector])}`;
  }
  private record(owner: string, connector: string) {
    return (
      this.db.get(this.key(owner, connector), recordSchema) ?? {
        revision: 0,
        values: {},
      }
    );
  }
  read(owner: string, connector: string): Record<string, string> {
    return this.record(owner, connector).values;
  }
  describe(owner: string, connector: string) {
    const record = this.record(owner, connector);
    return {
      revision: record.revision,
      names: Object.keys(record.values).sort(),
    };
  }
  update(owner: string, connector: string, input: unknown) {
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
      const record = this.record(owner, connector);
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
      this.db.put(this.key(owner, connector), {
        revision: record.revision + 1,
        values,
      });
      return this.describe(owner, connector);
    });
  }
}
