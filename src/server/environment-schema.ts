import { z } from "zod";
export const environmentValuesSchema = z.record(
  z.string().regex(/^[A-Za-z_][A-Za-z0-9_]{0,127}$/),
  z.string().max(16384),
);
export const environmentEditSchema = z
  .object({
    revision: z.number().int().nonnegative(),
    values: environmentValuesSchema.default({}),
    remove: z.array(z.string()).max(100).default([]),
    dotenv: z.string().max(64000).optional(),
  })
  .strict();
