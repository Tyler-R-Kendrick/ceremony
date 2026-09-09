import { randomUUID } from "node:crypto";
import type { ActorContext } from "../../core/operation-contracts.js";
import {
  recipeDefinitionSchema,
  digestRecipeDefinition,
  type Binding,
  type RecipeDefinition,
  type RecipeInvocation,
  RECIPE_LIMITS,
} from "../../core/recipe-contracts.js";
import {
  demonstrationEventSchema,
  type DemonstrationEvent,
} from "../../core/teaching-contracts.js";
import type {
  AsyncCeremonyStore,
  AsyncTransaction,
} from "../persistence/index.js";
import { OperationRegistry } from "./registry.js";

export { OperationRegistry } from "./registry.js";
export type {
  RegisteredOperation,
  OperationContext,
  OperationResult,
  VocabularyEntry,
} from "./registry.js";
export type RecipeDiagnostic = { code: string; node?: string };
export type PublishedRecipe = {
  definition: RecipeDefinition;
  version: string;
  digest: string;
  closure: Record<string, RecipeDefinition>;
  retired: boolean;
  publisher: string;
};
export type RecipeDraft = {
  definition: RecipeDefinition;
  author: string;
  digest: string;
  diagnostics: RecipeDiagnostic[];
};
type ResolveChild = (
  id: string,
  version: string,
  digest: string,
) => Promise<RecipeDefinition>;

/** Expand only trusted, pinned definitions. No expression evaluation or inferred branch. */
export async function validateRecipe(
  definition: unknown,
  registry: OperationRegistry,
  resolve: ResolveChild,
): Promise<{
  definition: RecipeDefinition;
  leaves: RecipeInvocation[];
  diagnostics: RecipeDiagnostic[];
  closure: Record<string, RecipeDefinition>;
  outputs: Record<string, { node: string; name: string }>;
}> {
  const recipe = recipeDefinitionSchema.parse(definition);
  const diagnostics: RecipeDiagnostic[] = [];
  const leaves: RecipeInvocation[] = [];
  const closure: Record<string, RecipeDefinition> = {};
  const fail = (code: string, node?: string) =>
    diagnostics.push(node === undefined ? { code } : { code, node });
  const active = new Set<string>();
  let visited = 0;
  let exhausted = false;
  async function expand(
    current: RecipeDefinition,
    prefix: string,
    inputs: Record<string, Binding>,
    depth: number,
    inherited: string[] = [],
  ): Promise<Record<string, { node: string; name: string }>> {
    if (depth > RECIPE_LIMITS.depth) {
      fail("recipe-depth-limit");
      exhausted = true;
      return {};
    }
    const outputs = new Map<
      string,
      Record<string, { node: string; name: string }>
    >();
    const completionNodes = new Map<string, string[]>();
    const remaining = new Map(
      current.invocations.map((node) => [node.id, node]),
    );
    while (remaining.size) {
      if (exhausted) break;
      if (++visited > RECIPE_LIMITS.leaves * RECIPE_LIMITS.depth) {
        fail("recipe-expansion-limit");
        exhausted = true;
        break;
      }
      const node = Array.from(remaining.values()).find((candidate) =>
        candidate.dependsOn.every((id) => outputs.has(id)),
      );
      if (!node) {
        fail("unresolved-dependency");
        break;
      }
      remaining.delete(node.id);
      const id = `${prefix}${node.id}`;
      const predecessors = [
        ...new Set([
          ...inherited,
          ...node.dependsOn.flatMap(
            (dependency) => completionNodes.get(dependency) ?? [],
          ),
        ]),
      ];
      const bindings: Record<string, Binding> = {};
      for (const [name, binding] of Object.entries(node.bindings)) {
        if (binding.from === "input") {
          const input = inputs[binding.name];
          if (input) bindings[name] = input;
          else fail("unbound-input", id);
        } else if (binding.from === "output") {
          const producer = outputs.get(binding.node)?.[binding.name];
          if (producer) bindings[name] = { from: "output", ...producer };
          else fail("missing-output", id);
        } else bindings[name] = binding;
      }
      if (node.use.kind === "recipe") {
        const key = `${node.use.id}@${node.use.version}:${node.use.digest}`;
        if (active.has(key)) {
          fail("recipe-cycle", id);
          outputs.set(node.id, {});
          continue;
        }
        try {
          const child = recipeDefinitionSchema.parse(
            await resolve(node.use.id, node.use.version, node.use.digest),
          );
          if ((await digestRecipeDefinition(child)) !== node.use.digest) {
            fail("child-digest-mismatch", id);
            outputs.set(node.id, {});
            continue;
          }
          for (const [name, input] of Object.entries(child.inputs))
            if (input.required && !bindings[name])
              fail("missing-child-input", id);
          for (const name of Object.keys(bindings))
            if (!Object.hasOwn(child.inputs, name))
              fail("unknown-child-input", id);
          active.add(key);
          closure[key] = child;
          const firstLeaf = leaves.length;
          outputs.set(
            node.id,
            await expand(child, `${id}.`, bindings, depth + 1, predecessors),
          );
          completionNodes.set(
            node.id,
            leaves.slice(firstLeaf).map((leaf) => leaf.id),
          );
          active.delete(key);
        } catch {
          fail("unavailable-child", id);
          outputs.set(node.id, {});
        }
      } else {
        if (leaves.length >= RECIPE_LIMITS.leaves) {
          fail("recipe-leaf-limit", id);
          exhausted = true;
          outputs.set(node.id, {});
          continue;
        }
        const operation = registry.get(node.use.id, node.use.version);
        if (!operation) {
          fail("unsupported-operation", id);
          outputs.set(node.id, {});
          continue;
        }
        if (!operation.fixtures.length) fail("missing-operation-fixtures", id);
        if (!operation.verify) fail("missing-verifier", id);
        for (const [name, input] of Object.entries(operation.contract.inputs)) {
          const binding = bindings[name];
          const vocabulary = registry.vocabulary.get(input.contract);
          if (!binding) {
            if (input.required) fail("unbound-required-input", id);
            continue;
          }
          if (binding.from === "literal") {
            if (
              !vocabulary ||
              vocabulary.classification !== "public" ||
              !vocabulary.schema.safeParse(binding.value).success
            )
              fail("forbidden-literal", id);
          } else if (binding.from === "input") {
            if (recipe.inputs[binding.name]?.contract !== input.contract)
              fail("incompatible-input", id);
          } else {
            const producer = leaves.find((leaf) => leaf.id === binding.node);
            const producerOperation =
              producer?.use.kind === "operation"
                ? registry.get(producer.use.id, producer.use.version)
                : undefined;
            if (
              producerOperation?.contract.outputs[binding.name]?.contract !==
              input.contract
            )
              fail("incompatible-output", id);
          }
        }
        for (const name of Object.keys(bindings))
          if (!Object.hasOwn(operation.contract.inputs, name))
            fail("unknown-operation-input", id);
        const dependsOn = predecessors;
        leaves.push({ id, use: node.use, dependsOn, bindings });
        completionNodes.set(node.id, [id]);
        outputs.set(
          node.id,
          Object.fromEntries(
            Object.keys(operation.contract.outputs).map((name) => [
              name,
              { node: id, name },
            ]),
          ),
        );
      }
    }
    const result: Record<string, { node: string; name: string }> = {};
    for (const [name, output] of Object.entries(current.outputs)) {
      const producer = outputs.get(output.node)?.[output.name];
      if (producer) result[name] = producer;
      else fail("missing-declared-output");
    }
    return result;
  }
  for (const input of Object.values(recipe.inputs))
    if (!registry.vocabulary.has(input.contract))
      fail("unknown-input-contract");
  const resolvedOutputs = await expand(
    recipe,
    "",
    Object.fromEntries(
      Object.keys(recipe.inputs).map((name) => [name, { from: "input", name }]),
    ),
    1,
  );
  return {
    definition: recipe,
    leaves,
    diagnostics,
    closure,
    outputs: resolvedOutputs,
  };
}

function allowed(
  actor: ActorContext,
  capability: "author" | "reviewer" | "publisher" | "executor" | "admin",
) {
  if (
    !actor.capabilities.includes(capability) &&
    !actor.capabilities.includes("admin")
  )
    throw new Error("Recipe access denied");
}

export class RecipeService {
  constructor(
    private readonly store: AsyncCeremonyStore,
    readonly registry: OperationRegistry,
  ) {}
  async composePublished(
    actor: ActorContext,
    references: Array<{ id: string; version: string; digest: string }>,
  ) {
    allowed(actor, "author");
    if (references.length < 2 || references.length > 32)
      throw new Error("Composition requires two to thirty-two recipes");
    return this.createDraft(actor, await this.composition(actor, references));
  }
  private async composition(
    actor: ActorContext,
    references: Array<{ id: string; version: string; digest: string }>,
  ) {
    allowed(actor, "executor");
    if (!references.length || references.length > 32)
      throw new Error("Composition limit exceeded");
    const inputs: RecipeDefinition["inputs"] = {};
    const invocations: RecipeInvocation[] = [];
    const available: Array<{ node: string; name: string; contract: string }> =
      [];
    let finalOutputs: RecipeDefinition["outputs"] = {};
    const parts = await Promise.all(
      references.map(async (reference) => {
        const published = await this.getPublished(
          actor,
          reference.id,
          reference.version,
          reference.digest,
        );
        const validated = await this.preview(actor, published.definition);
        if (validated.diagnostics.length)
          throw new Error("Child recipe is not executable");
        const contracts = Object.values(validated.outputs).map((output) => {
          const producer = validated.leaves.find(
            (leaf) => leaf.id === output.node,
          )!;
          return this.registry.require(producer.use.id, producer.use.version)
            .contract.outputs[output.name]!.contract;
        });
        return { reference, published, validated, contracts };
      }),
    );
    // Selection order and random database IDs are not dependency evidence.
    const dependencies = new Map(
      parts.map((part) => [
        part,
        new Set(
          Object.values(part.published.definition.inputs).flatMap((input) => {
            const producers = parts.filter(
              (candidate) =>
                candidate !== part &&
                candidate.contracts.filter(
                  (contract) => contract === input.contract,
                ).length > 0,
            );
            return producers.length === 1 &&
              producers[0]!.contracts.filter(
                (contract) => contract === input.contract,
              ).length === 1
              ? [producers[0]!]
              : [];
          }),
        ),
      ]),
    );
    const ordered: typeof parts = [];
    const remaining = new Set(parts);
    while (remaining.size) {
      const ready = [...remaining]
        .filter((part) =>
          [...dependencies.get(part)!].every(
            (dependency) => !remaining.has(dependency),
          ),
        )
        .sort((a, b) => a.reference.id.localeCompare(b.reference.id));
      if (!ready.length)
        throw new Error("Composition dependencies require an explicit input");
      for (const part of ready) {
        ordered.push(part);
        remaining.delete(part);
      }
    }
    for (const [
      index,
      { reference, published, validated },
    ] of ordered.entries()) {
      const id = `part-${index + 1}`;
      const bindings: Record<string, Binding> = {};
      const dependsOn = new Set<string>();
      for (const [name, contract] of Object.entries(
        published.definition.inputs,
      )) {
        const producers = available.filter(
          (output) => output.contract === contract.contract,
        );
        const candidateCount = parts
          .filter((part) => part.reference !== reference)
          .reduce(
            (count, part) =>
              count +
              part.contracts.filter((output) => output === contract.contract)
                .length,
            0,
          );
        if (producers.length === 1 && candidateCount === 1) {
          const producer = producers[0]!;
          bindings[name] = {
            from: "output",
            node: producer.node,
            name: producer.name,
          };
          dependsOn.add(producer.node);
        } else {
          const input = `${id}.${name}`;
          inputs[input] = contract;
          bindings[name] = { from: "input", name: input };
        }
      }
      invocations.push({
        id,
        use: { kind: "recipe", ...reference },
        dependsOn: [...dependsOn],
        bindings,
      });
      finalOutputs = {};
      for (const [name, output] of Object.entries(validated.outputs)) {
        const producer = validated.leaves.find(
          (leaf) => leaf.id === output.node,
        )!;
        const operation = this.registry.require(
          producer.use.id,
          producer.use.version,
        );
        const contract = operation.contract.outputs[output.name]!;
        available.push({ node: id, name, contract: contract.contract });
        finalOutputs[name] = { node: id, name };
      }
    }
    return recipeDefinitionSchema.parse({
      schemaVersion: 1,
      id: `recipe-${randomUUID()}`,
      title: "Combined connection steps",
      description: "Compatible reviewed procedures with fresh runtime inputs.",
      inputs,
      invocations,
      outputs: finalOutputs,
    });
  }
  /** Non-effectful resolution of current tenant procedures. No author/publisher grant or model is involved. */
  async selectConnection(
    actor: ActorContext,
    profile: { provider: string; profile: string; outputContract: string },
  ) {
    allowed(actor, "executor");
    const rows = await this.store.transaction((tx) =>
      tx.list<PublishedRecipe>(actor.tenantId, "recipe", 257),
    );
    if (rows.length > 256)
      throw new Error("Recipe catalog exceeds automatic selection budget");
    const latest = new Map<string, PublishedRecipe>();
    for (const row of rows) {
      const value = row.value;
      if (!value.definition) continue;
      const prior = latest.get(value.definition.id);
      if (
        !prior ||
        value.version.localeCompare(prior.version, undefined, {
          numeric: true,
        }) > 0
      )
        latest.set(value.definition.id, value);
    }
    const candidates: Array<{
      reference: { id: string; version: string; digest: string };
      published: PublishedRecipe;
      outputs: string[];
    }> = [];
    for (const value of latest.values()) {
      try {
        const reference = {
          id: value.definition.id,
          version: value.version,
          digest: value.digest,
        };
        const published = await this.getPublished(
          actor,
          reference.id,
          reference.version,
          reference.digest,
        );
        const validated = await this.preview(actor, published.definition);
        if (
          validated.diagnostics.length ||
          validated.leaves.some((leaf) => {
            const operation = this.registry.require(
              leaf.use.id,
              leaf.use.version,
            ).contract;
            return (
              operation.provider !== profile.provider ||
              operation.profile !== profile.profile
            );
          })
        )
          continue;
        const outputs = Object.values(validated.outputs).map((output) => {
          const leaf = validated.leaves.find(
            (leaf) => leaf.id === output.node,
          )!;
          return this.registry.require(leaf.use.id, leaf.use.version).contract
            .outputs[output.name]!.contract;
        });
        candidates.push({ reference, published, outputs });
      } catch (error) {
        // Retirement is an expected race; storage failures must not trigger a new fallback setup.
        if (!(error instanceof Error) || error.message !== "Recipe unavailable")
          throw error;
      }
    }
    const choices = [];
    for (const target of candidates.filter((candidate) =>
      candidate.outputs.includes(profile.outputContract),
    )) {
      const selected = new Set<typeof target>();
      const visiting = new Set<typeof target>();
      const resolve = (candidate: typeof target): boolean => {
        if (selected.has(candidate)) return true;
        if (visiting.has(candidate) || selected.size + visiting.size >= 32)
          return false;
        visiting.add(candidate);
        for (const input of Object.values(
          candidate.published.definition.inputs,
        )) {
          const producers = candidates.filter(
            (other) =>
              other !== candidate &&
              other.outputs.filter((output) => output === input.contract)
                .length === 1,
          );
          if (producers.length !== 1 || !resolve(producers[0]!)) return false;
        }
        visiting.delete(candidate);
        selected.add(candidate);
        return true;
      };
      if (!resolve(target)) continue;
      try {
        const definition = await this.composition(
          actor,
          [...selected].map((candidate) => candidate.reference),
        );
        const validated = await this.preview(actor, definition);
        if (
          validated.diagnostics.length ||
          Object.keys(definition.inputs).length
        )
          continue;
        const outputContracts = Object.values(validated.outputs).map(
          (output) => {
            const leaf = validated.leaves.find(
              (leaf) => leaf.id === output.node,
            )!;
            return this.registry.require(leaf.use.id, leaf.use.version).contract
              .outputs[output.name]!.contract;
          },
        );
        if (outputContracts.includes(profile.outputContract))
          choices.push({
            definition,
            leaves: validated.leaves.length,
            key: target.reference.id,
          });
      } catch (error) {
        if (
          !(error instanceof Error) ||
          ![
            "Recipe unavailable",
            "Child recipe is not executable",
            "Composition dependencies require an explicit input",
            "Composition limit exceeded",
          ].includes(error.message)
        )
          throw error;
      }
    }
    choices.sort((a, b) => a.leaves - b.leaves || a.key.localeCompare(b.key));
    return choices[0]?.definition;
  }
  private async published(
    tx: AsyncTransaction,
    actor: ActorContext,
    id: string,
    version: string,
    digest: string,
  ): Promise<PublishedRecipe> {
    const record = await tx.get<PublishedRecipe>({
      tenant: actor.tenantId,
      kind: "recipe",
      id: `${id}@${version}`,
    });
    if (!record || record.value.retired || record.value.digest !== digest)
      throw new Error("Recipe unavailable");
    return record.value;
  }
  async preview(actor: ActorContext, definition: unknown) {
    allowed(actor, "executor");
    return validateRecipe(
      definition,
      this.registry,
      async (id, version, digest) =>
        this.store.transaction(
          async (tx) =>
            (await this.published(tx, actor, id, version, digest)).definition,
        ),
    );
  }
  async createDraft(actor: ActorContext, definition: unknown) {
    return this.saveDraft(actor, definition, []);
  }
  async compileDraft(
    actor: ActorContext,
    events: DemonstrationEvent[],
    selection: { first: number; last: number },
  ) {
    const compiled = compileDemonstration(events, selection, this.registry);
    return this.saveDraft(actor, compiled.definition, compiled.diagnostics);
  }
  private async saveDraft(
    actor: ActorContext,
    definition: unknown,
    sourceDiagnostics: RecipeDiagnostic[],
  ) {
    allowed(actor, "author");
    const parsed = recipeDefinitionSchema.parse(definition);
    const validation = await validateRecipe(
      parsed,
      this.registry,
      async (id, version, digest) =>
        this.store.transaction(
          async (tx) =>
            (await this.published(tx, actor, id, version, digest)).definition,
        ),
    );
    const value: RecipeDraft = {
      definition: parsed,
      author: actor.subjectId,
      digest: await digestRecipeDefinition(parsed),
      diagnostics: [...sourceDiagnostics, ...validation.diagnostics],
    };
    const id = `draft-${randomUUID()}`;
    await this.store.transaction((tx) =>
      tx.put({ tenant: actor.tenantId, kind: "draft", id }, value, null),
    );
    return { id, revision: 1, ...value };
  }
  async getDraft(actor: ActorContext, id: string) {
    return this.store.transaction(async (tx) => {
      const record = await tx.get<RecipeDraft>({
        tenant: actor.tenantId,
        kind: "draft",
        id,
      });
      if (
        !record ||
        (record.value.author !== actor.subjectId &&
          !actor.capabilities.some((cap) =>
            ["reviewer", "publisher", "admin"].includes(cap),
          ))
      )
        throw new Error("Recipe unavailable");
      return { id, revision: record.revision, ...record.value };
    });
  }
  async editDraft(
    actor: ActorContext,
    id: string,
    revision: number,
    definition: unknown,
  ) {
    allowed(actor, "author");
    const parsed = recipeDefinitionSchema.parse(definition);
    const digest = await digestRecipeDefinition(parsed);
    return this.store.transaction(async (tx) => {
      const record = await tx.get<RecipeDraft>({
        tenant: actor.tenantId,
        kind: "draft",
        id,
      });
      if (!record || record.value.author !== actor.subjectId)
        throw new Error("Recipe unavailable");
      const validation = await validateRecipe(
        parsed,
        this.registry,
        async (child, version, pin) =>
          (await this.published(tx, actor, child, version, pin)).definition,
      );
      const value: RecipeDraft = {
        definition: parsed,
        author: actor.subjectId,
        digest,
        diagnostics: validation.diagnostics,
      };
      const next = await tx.put(
        { tenant: actor.tenantId, kind: "draft", id },
        value,
        revision,
      );
      return { id, revision: next, ...value };
    });
  }
  async review(
    actor: ActorContext,
    id: string,
    revision: number,
    digest: string,
  ) {
    allowed(actor, "reviewer");
    return this.store.transaction(async (tx) => {
      const draft = await tx.get<RecipeDraft>({
        tenant: actor.tenantId,
        kind: "draft",
        id,
      });
      if (
        !draft ||
        draft.revision !== revision ||
        draft.value.digest !== digest ||
        draft.value.diagnostics.length
      )
        throw new Error("Review does not match a valid draft");
      const key = {
        tenant: actor.tenantId,
        kind: "review" as const,
        id: `${id}:${revision}`,
      };
      const previous = await tx.get(key);
      await tx.put(
        key,
        { digest, reviewer: actor.subjectId },
        previous?.revision ?? null,
      );
    });
  }
  async publish(
    actor: ActorContext,
    id: string,
    revision: number,
    digest: string,
  ) {
    allowed(actor, "publisher");
    return this.store.transaction(async (tx) => {
      const draft = await tx.get<RecipeDraft>({
        tenant: actor.tenantId,
        kind: "draft",
        id,
      });
      const review = await tx.get<{ digest: string }>({
        tenant: actor.tenantId,
        kind: "review",
        id: `${id}:${revision}`,
      });
      if (
        !draft ||
        draft.revision !== revision ||
        draft.value.digest !== digest ||
        review?.value.digest !== digest
      )
        throw new Error("Publication requires current review");
      const validation = await validateRecipe(
        draft.value.definition,
        this.registry,
        async (child, version, pin) =>
          (await this.published(tx, actor, child, version, pin)).definition,
      );
      if (validation.diagnostics.length)
        throw new Error("Recipe is not executable");
      const counterKey = {
        tenant: actor.tenantId,
        kind: "session" as const,
        id: `${draft.value.definition.id}@counter`,
      };
      const counter = await tx.get<{ next: number }>(counterKey);
      const next = counter?.value.next ?? 1;
      const version = `1.0.${next}`;
      await tx.put(counterKey, { next: next + 1 }, counter?.revision ?? null);
      const value: PublishedRecipe = {
        definition: draft.value.definition,
        version,
        digest,
        closure: validation.closure,
        retired: false,
        publisher: actor.subjectId,
      };
      await tx.put(
        {
          tenant: actor.tenantId,
          kind: "recipe",
          id: `${value.definition.id}@${version}`,
        },
        value,
        null,
      );
      return value;
    });
  }
  async getPublished(
    actor: ActorContext,
    id: string,
    version: string,
    digest: string,
  ) {
    allowed(actor, "executor");
    return this.store.transaction(async (tx) => {
      const value = await this.published(tx, actor, id, version, digest);
      for (const key of Object.keys(value.closure)) {
        const split = key.lastIndexOf(":");
        const reference = key.slice(0, split);
        const at = reference.lastIndexOf("@");
        await this.published(
          tx,
          actor,
          reference.slice(0, at),
          reference.slice(at + 1),
          key.slice(split + 1),
        );
      }
      return value;
    });
  }
  async retire(actor: ActorContext, id: string, version: string) {
    allowed(actor, "admin");
    await this.store.transaction(async (tx) => {
      const key = {
        tenant: actor.tenantId,
        kind: "recipe" as const,
        id: `${id}@${version}`,
      };
      const value = await tx.get<PublishedRecipe>(key);
      if (!value) throw new Error("Recipe unavailable");
      await tx.put(key, { ...value.value, retired: true }, value.revision);
    });
  }
}

/** Selected events must be a contiguous server sequence range; observed values never become defaults. */
export function compileDemonstration(
  events: DemonstrationEvent[],
  selection: { first: number; last: number },
  registry: OperationRegistry,
): { definition: RecipeDefinition; diagnostics: RecipeDiagnostic[] } {
  if (
    !Number.isSafeInteger(selection.first) ||
    !Number.isSafeInteger(selection.last) ||
    selection.last < selection.first ||
    events.length > 1000
  )
    throw new Error("Invalid demonstration selection");
  const selected = events
    .map((event) => demonstrationEventSchema.parse(event))
    .filter(
      (event) =>
        event.sequence >= selection.first && event.sequence <= selection.last,
    )
    .sort((a, b) => a.sequence - b.sequence);
  if (
    !selected.length ||
    selected[0]!.sequence !== selection.first ||
    selected.at(-1)!.sequence !== selection.last ||
    selected.some(
      (event, index) =>
        index > 0 && event.sequence !== selected[index - 1]!.sequence + 1,
    )
  )
    throw new Error("Selection must be contiguous");
  if (new Set(selected.map((event) => event.demonstrationId)).size !== 1)
    throw new Error("Mixed demonstrations");
  const diagnostics: RecipeDiagnostic[] = [];
  const inputs: RecipeDefinition["inputs"] = {};
  const invocations: RecipeInvocation[] = [];
  const recorded = new Set<string>();
  const produced: Array<{ node: string; name: string; contract: string }> = [];
  for (const event of selected) {
    if (event.kind === "failure") {
      diagnostics.push({ code: "observed-failure" });
      continue;
    }
    if (
      event.kind !== "verification" ||
      event.verification !== "accepted" ||
      recorded.has(event.nodeId)
    )
      continue;
    const operation = registry.get(event.operationId, event.operationVersion);
    if (!operation) {
      diagnostics.push({ code: "unsupported-operation" });
      continue;
    }
    recorded.add(event.nodeId);
    const id = `step-${invocations.length + 1}`;
    const bindings: Record<string, Binding> = {};
    for (const [name, contract] of Object.entries(operation.contract.inputs)) {
      const candidates = produced.filter(
        (output) => output.contract === contract.contract,
      );
      if (candidates.length === 1) {
        const producer = candidates[0]!;
        bindings[name] = {
          from: "output",
          node: producer.node,
          name: producer.name,
        };
        continue;
      }
      const parameter = `${id}.${name}`;
      inputs[parameter] = contract;
      bindings[name] = { from: "input", name: parameter };
    }
    invocations.push({
      id,
      use: {
        kind: "operation",
        id: operation.contract.id,
        version: operation.contract.version,
      },
      dependsOn: [
        ...new Set([
          ...(invocations.length ? [invocations.at(-1)!.id] : []),
          ...Object.values(bindings)
            .filter((binding) => binding.from === "output")
            .map((binding) => binding.node),
        ]),
      ],
      bindings,
    });
    for (const [name, contract] of Object.entries(operation.contract.outputs))
      produced.push({ node: id, name, contract: contract.contract });
  }
  if (!invocations.length) throw new Error("No verified executable boundary");
  if (selected.at(-1)!.verification !== "accepted")
    diagnostics.push({ code: "incomplete-ending" });
  const final = invocations.at(-1)!;
  const operation = registry.require(final.use.id, final.use.version);
  const definition = recipeDefinitionSchema.parse({
    schemaVersion: 1,
    id: `recipe-${randomUUID()}`,
    title: "Reusable connection step",
    description: "Reviewed semantic operations with fresh runtime inputs.",
    inputs,
    invocations,
    outputs: Object.fromEntries(
      Object.keys(operation.contract.outputs).map((name) => [
        name,
        { node: final.id, name },
      ]),
    ),
  });
  return { definition, diagnostics };
}
