import { z } from "zod";
import {
  identifierSchema,
  publicValueSchema,
  registeredInputContractSchema,
  semanticVersionSchema,
} from "./operation-contracts.js";

export const RECIPE_LIMITS = Object.freeze({
  bytes: 256 * 1024,
  leaves: 32,
  depth: 8,
});
export const bindingSchema = z.discriminatedUnion("from", [
  z.object({ from: z.literal("input"), name: identifierSchema }).strict(),
  z
    .object({
      from: z.literal("output"),
      node: identifierSchema,
      name: identifierSchema,
    })
    .strict(),
  z.object({ from: z.literal("literal"), value: publicValueSchema }).strict(),
]);
export type Binding = z.infer<typeof bindingSchema>;

export const RECIPE_OUTCOME_LIMITS = Object.freeze({
  criteria: 32,
  condition: 2048,
  values: 32,
  retryLimit: 5,
  retryAfterMs: 300_000,
});
const conditionSchema = z.string().min(1).max(RECIPE_OUTCOME_LIMITS.condition);
/**
 * The name a condition uses for a value: `$inputs.<name>` or
 * `$steps.<step>.outputs.<name>`, spelled as an Arazzo runtime expression.
 * The name is only a key; `values` binds it to a recipe value.
 */
export const outcomeReferenceSchema = z
  .string()
  .regex(
    /^\$(?:inputs\.[A-Za-z0-9_.-]{1,96}|steps\.[A-Za-z0-9_-]{1,96}\.outputs\.[A-Za-z0-9_.-]{1,96})$/,
  );
/**
 * Declarative success criteria and a bounded retry for one operation
 * invocation: the part of an Arazzo step's `successCriteria` and
 * `onFailure: retry` the command service can enforce without an expression
 * language of its own. Conditions are Arazzo `simple` conditions, evaluated
 * by the bounded evaluator over public values only: the recipe values bound
 * in `values` (which may name the invocation's own outputs) and the public
 * transport facts (`$statusCode`, `$url`, `$method`,
 * `$response.header.<name>`) its trusted handler chose to report. A retry
 * repeats the handler, so it is valid only for an operation the host
 * registered as replay-safe.
 */
export const recipeOutcomeSchema = z
  .object({
    successCriteria: z
      .array(conditionSchema)
      .max(RECIPE_OUTCOME_LIMITS.criteria),
    retry: z
      .object({
        limit: z.number().int().min(1).max(RECIPE_OUTCOME_LIMITS.retryLimit),
        afterMs: z
          .number()
          .int()
          .min(0)
          .max(RECIPE_OUTCOME_LIMITS.retryAfterMs),
        criteria: z.array(conditionSchema).max(RECIPE_OUTCOME_LIMITS.criteria),
      })
      .strict()
      .optional(),
    values: z
      .record(outcomeReferenceSchema, bindingSchema)
      .refine((v) => Object.keys(v).length <= RECIPE_OUTCOME_LIMITS.values),
  })
  .strict()
  .refine(
    (outcome) => outcome.successCriteria.length > 0 || outcome.retry,
    "An outcome needs success criteria or a retry",
  );
export type RecipeOutcome = z.infer<typeof recipeOutcomeSchema>;
export const recipeInvocationSchema = z
  .object({
    id: identifierSchema,
    use: z.discriminatedUnion("kind", [
      z
        .object({
          kind: z.literal("operation"),
          id: identifierSchema,
          version: semanticVersionSchema,
        })
        .strict(),
      z
        .object({
          kind: z.literal("recipe"),
          id: identifierSchema,
          version: semanticVersionSchema,
          digest: z.string().regex(/^[a-f0-9]{64}$/),
        })
        .strict(),
    ]),
    dependsOn: z.array(identifierSchema).max(32),
    bindings: z
      .record(identifierSchema, bindingSchema)
      .refine((v) => Object.keys(v).length <= 32),
    /**
     * The host connector whose authorization context this invocation, and
     * every step beneath it, runs in. Absent means the run's own connector.
     * Naming one grants nothing: the host resolves its context for the actor
     * and authorizes every step against it, or the run is never created.
     */
    connector: identifierSchema.optional(),
    outcome: recipeOutcomeSchema.optional(),
  })
  .strict();
export type RecipeInvocation = z.infer<typeof recipeInvocationSchema>;
export const recipeDefinitionSchema = z
  .object({
    schemaVersion: z.literal(1),
    id: identifierSchema,
    title: z.string().min(1).max(100),
    description: z.string().max(1000),
    inputs: z
      .record(identifierSchema, registeredInputContractSchema)
      .refine((v) => Object.keys(v).length <= 32),
    invocations: z
      .array(recipeInvocationSchema)
      .min(1)
      .max(RECIPE_LIMITS.leaves),
    outputs: z
      .record(
        identifierSchema,
        z.object({ node: identifierSchema, name: identifierSchema }).strict(),
      )
      .refine((v) => Object.keys(v).length <= 32),
  })
  .strict()
  .superRefine((recipe, context) => {
    const nodes = new Map(recipe.invocations.map((node) => [node.id, node]));
    const issue = (message: string) =>
      context.addIssue({ code: "custom", message });
    if (nodes.size !== recipe.invocations.length) issue("Duplicate invocation");
    for (const node of recipe.invocations) {
      if (new Set(node.dependsOn).size !== node.dependsOn.length)
        issue("Duplicate dependency");
      for (const dependency of node.dependsOn)
        if (!nodes.has(dependency)) issue("Unknown dependency");
      for (const binding of Object.values(node.bindings)) {
        if (
          binding.from === "input" &&
          !Object.hasOwn(recipe.inputs, binding.name)
        )
          issue("Unbound input");
        if (binding.from === "output" && !node.dependsOn.includes(binding.node))
          issue("Output producer must be an explicit dependency");
      }
      if (node.outcome && node.use.kind !== "operation")
        issue("Outcomes apply to operation invocations");
      for (const binding of Object.values(node.outcome?.values ?? {})) {
        if (
          binding.from === "input" &&
          !Object.hasOwn(recipe.inputs, binding.name)
        )
          issue("Unbound input");
        // A criterion may read the invocation's own outputs, or a dependency's.
        if (
          binding.from === "output" &&
          binding.node !== node.id &&
          !node.dependsOn.includes(binding.node)
        )
          issue("Output producer must be an explicit dependency");
      }
    }
    for (const output of Object.values(recipe.outputs))
      if (!nodes.has(output.node)) issue("Unknown output producer");
    const visited = new Set<string>();
    const active = new Set<string>();
    function visit(id: string): void {
      if (active.has(id)) {
        issue("Dependency cycle");
        return;
      }
      if (visited.has(id)) return;
      active.add(id);
      for (const dependency of nodes.get(id)?.dependsOn ?? [])
        visit(dependency);
      active.delete(id);
      visited.add(id);
    }
    for (const id of nodes.keys()) visit(id);
  });
export type RecipeDefinition = z.infer<typeof recipeDefinitionSchema>;

export function parseRecipeImport(text: string): RecipeDefinition {
  if (new TextEncoder().encode(text).byteLength > RECIPE_LIMITS.bytes)
    throw new Error("Recipe exceeds import limit");
  return recipeDefinitionSchema.parse(JSON.parse(text));
}
export function canonicalRecipeDefinition(definition: unknown): string {
  const recipe = recipeDefinitionSchema.parse(definition);
  function canonical(value: unknown): unknown {
    if (Array.isArray(value)) return value.map(canonical);
    if (value !== null && typeof value === "object")
      return Object.fromEntries(
        Object.entries(value)
          .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
          .map(([key, item]) => [key, canonical(item)]),
      );
    return value;
  }
  return JSON.stringify(canonical(recipe));
}
/** Integrity only: a digest conveys neither publication rights nor provider evidence. */
export async function digestRecipeDefinition(
  definition: unknown,
): Promise<string> {
  const digest = await globalThis.crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(canonicalRecipeDefinition(definition)),
  );
  return Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
}
