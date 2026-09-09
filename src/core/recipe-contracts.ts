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
