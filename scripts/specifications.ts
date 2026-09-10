import { readFile, writeFile, mkdir } from "node:fs/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import { resolve } from "node:path";
import { format } from "prettier";
import { z } from "zod";
import {
  connectorManifestV1Schema,
  methodContractSchema,
  humanHandoffContractSchema,
  recipeDefinitionSchema,
  operationContractSchema,
  commandEnvelopeSchema,
  demonstrationEventSchema,
  methodSelectionSchema,
} from "../src/core/index.js";
import { arazzoSchema } from "../src/server/arazzo.js";

export const specificationSchemas = {
  "connector-manifest-v1": connectorManifestV1Schema,
  "method-contract-v1": methodContractSchema,
  "human-handoff-v1": humanHandoffContractSchema,
  "recipe-v1": recipeDefinitionSchema,
  "operation-v1": operationContractSchema,
  "command-v1": commandEnvelopeSchema,
  "demonstration-event-v1": demonstrationEventSchema,
  "method-selection-v1": methodSelectionSchema,
  "arazzo-profile-1.0.1": arazzoSchema,
};
export async function specificationDocument(
  name: keyof typeof specificationSchemas,
) {
  return format(
    JSON.stringify({
      ...z.toJSONSchema(specificationSchemas[name], {
        target: "draft-2020-12",
        io: "input",
      }),
      $id: `urn:ceremony:specification:${name}`,
      $comment:
        "Generated from runtime Zod contracts. Structural validation does not replace cross-field checks, registry validation, authentication or provider verification. This identifier is not a fetch endpoint.",
    }),
    { parser: "json" },
  );
}
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  const args = process.argv.slice(2);
  if (args.length > 1 || (args.length && args[0] !== "--write"))
    throw new Error(
      "Use specifications.ts [--write]; default checks for drift",
    );
  const directory = new URL("../docs/specifications/schemas/", import.meta.url);
  if (args[0] === "--write") await mkdir(directory, { recursive: true });
  for (const name of Object.keys(
    specificationSchemas,
  ) as (keyof typeof specificationSchemas)[]) {
    const path = new URL(`${name}.schema.json`, directory);
    const expected = await specificationDocument(name);
    if (args[0] === "--write") await writeFile(path, expected);
    else if ((await readFile(path, "utf8")) !== expected)
      throw new Error(`Specification drift: ${name}`);
  }
  process.stdout.write(
    `Validated ${Object.keys(specificationSchemas).length} specifications in ${fileURLToPath(directory)}\n`,
  );
}
