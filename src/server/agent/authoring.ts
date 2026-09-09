import { generateText, Output, type LanguageModel } from "ai";
import { z } from "zod";
import {
  identifierSchema,
  semanticVersionSchema,
  type ActorContext,
} from "../../core/operation-contracts.js";
import type { AsyncCeremonyStore } from "../persistence/index.js";
import { requireCapability } from "../identity.js";
import { validateAgentText } from "./model.js";

const labels = z.strictObject({
  title: z.string().min(1).max(100),
  description: z.string().max(500),
});
const operationsSchema = z
  .array(
    z.strictObject({ id: identifierSchema, version: semanticVersionSchema }),
  )
  .min(1)
  .max(32);
/** Labels are suggestions only. This does not grant publication or change executable semantics. */
export async function suggestRecipeLabels(
  store: AsyncCeremonyStore,
  actor: ActorContext,
  draftId: string,
  operations: unknown,
  model?: LanguageModel,
): Promise<z.infer<typeof labels> | null> {
  requireCapability(actor, "author");
  identifierSchema.parse(draftId);
  const catalog = operationsSchema.parse(operations);
  for (const operation of catalog) {
    validateAgentText(operation.id);
    validateAgentText(operation.version);
  }
  if (!model) return null;
  for (let attempt = 0; attempt < 2; attempt++) {
    const reserved = await store.transaction(async (tx) => {
      const key = {
        tenant: actor.tenantId,
        kind: "budget" as const,
        id: `authoring:${draftId}`,
      };
      const prior = await tx.get<{ subjectId: string; calls: number }>(key);
      if (prior && prior.value.subjectId !== actor.subjectId)
        throw new Error("denied");
      if ((prior?.value.calls ?? 0) >= 2) return false;
      await tx.put(
        key,
        { subjectId: actor.subjectId, calls: (prior?.value.calls ?? 0) + 1 },
        prior?.revision ?? null,
      );
      return true;
    });
    if (!reserved) return null;
    try {
      const result = await generateText({
        model,
        output: Output.object({ schema: labels }),
        maxOutputTokens: 300,
        maxRetries: 0,
        abortSignal: AbortSignal.timeout(15000),
        telemetry: { isEnabled: false },
        prompt: `Suggest concise plain-language labels for these registered authentication operations. Do not claim verified authorization. Return only the required object. ${JSON.stringify(catalog)}`,
      });
      return labels.parse(result.output);
    } catch {
      // One bounded repair attempt with the same safe catalog, never a raw provider error or output.
    }
  }
  return null;
}
