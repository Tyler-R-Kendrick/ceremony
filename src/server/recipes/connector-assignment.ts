import type {
  Binding,
  RecipeDefinition,
  RecipeInvocation,
} from "../../core/recipe-contracts.js";
import type { ActorContext } from "../../core/operation-contracts.js";
import type { OperationRegistry } from "./registry.js";

/*
 * Which connector each step of a draft runs under, decided when the draft is
 * saved rather than typed by its author.
 *
 * A recipe that stays inside one provider needs no connector names: every
 * step runs in the context of the connector the run is started with, as it
 * always has. Once a draft's steps belong to more than one provider (or its
 * author has named any connector), each top-level node needs one, and it is
 * derived here from two facts the host already holds:
 *
 * - the provider and profile of the node's registered operations, and
 * - the connectors this actor may run steps under, each with the provider
 *   and profile the host resolves it to.
 *
 * A node whose operations exactly one approved connector admits (by the
 * command service's own admission rule) is placed under it. Several is never
 * resolved by picking one: which connector a step runs under decides whose
 * account and credentials it acts with, so that choice stays with a person
 * and is reported as a draft issue that blocks review. A node of
 * provider-neutral steps takes the connector of the steps whose artifacts it
 * consumes or produces, and only when they all agree. And an artifact that
 * crosses from one connector's context into another's must be declared
 * `crossProvider`; anything else is an issue here, before the run-time check
 * would refuse the run.
 *
 * Only connector identifiers, provider and profile names and contract names
 * appear in the report. No binding value, handle or secret is ever read.
 */

/** A connector this actor may run steps under, as the host resolves it. */
export type ConnectorBinding = {
  connectorId: string;
  provider: string;
  profile: string;
};

/** What the host's catalog holds for one actor. */
export type ConnectorListing = {
  /** Connectors the host resolves a context for, for this actor. */
  connectors: ConnectorBinding[];
  /**
   * Connectors the host offers but could not resolve for this actor now (no
   * target selected, configuration missing). They are not candidates, and
   * the report names them so a reviewer can see what was not considered.
   */
  unavailable: string[];
};

/** The host's connector catalog and admission rule, supplied by the runtime. */
export type ConnectorCatalog = {
  list(actor: ActorContext): Promise<ConnectorListing>;
  /** The command service's rule: may a context of this provider/profile include the operation? */
  admits(
    context: { provider: string; profile: string },
    operationId: string,
    operationVersion: string,
  ): boolean;
};

export type ConnectorIssue = {
  code:
    | "connector-ambiguous"
    | "connector-unavailable"
    | "connector-inadmissible"
    | "connector-mixed"
    | "connector-inherit-ambiguous"
    | "cross-connector-artifact";
  node: string;
  message: string;
  /** The connectors a person must choose between, when there is a choice. */
  choices?: string[];
};

export type NodeConnector = {
  node: string;
  /** Absent when the node runs in the run's own context, or is unresolved. */
  connector?: string;
  /**
   * `declared`: named in the draft. `provider`: the one approved connector
   * for the node's provider. `inherited`: a provider-neutral node, from the
   * steps it serves. `nested`: named inside a pinned child recipe. `run`: the
   * draft stays within one provider and runs under the run's connector.
   * `unresolved`: see the issues.
   */
  source:
    "declared" | "provider" | "inherited" | "nested" | "run" | "unresolved";
};

export type ConnectorReport = {
  /** True when the draft's steps need more than one connector context. */
  spansConnectors: boolean;
  nodes: NodeConnector[];
  issues: ConnectorIssue[];
  /** Offered connectors that could not be resolved for this actor, when placing. */
  unavailable?: string[];
};

type Edge = {
  producer: RecipeInvocation;
  consumer: RecipeInvocation;
  name: string;
};

/**
 * Whether a draft needs connector placement: its author (or a pinned child's)
 * named a connector, or no single context admits all of its provider steps.
 * The contexts tried are each step's own provider and profile, plus any
 * connectors the host resolved; admission is the command service's rule, so
 * a draft that one context runs whole today (a GitHub App run that includes
 * authored account registration, say) still runs under the run's connector.
 * Provider-neutral steps run anywhere and do not count.
 */
export function spansConnectors(
  leaves: readonly RecipeInvocation[],
  registry: OperationRegistry,
  admits: ConnectorCatalog["admits"],
  connectors: readonly ConnectorBinding[] = [],
): boolean {
  if (leaves.some((leaf) => leaf.connector !== undefined)) return true;
  const steps = leaves.filter(
    (leaf) => !registry.isNeutral(leaf.use.id, leaf.use.version),
  );
  if (!steps.length) return false;
  const contexts = [
    ...steps.flatMap((leaf) => {
      const contract = registry.get(leaf.use.id, leaf.use.version)?.contract;
      return contract
        ? [{ provider: contract.provider, profile: contract.profile }]
        : [];
    }),
    ...connectors,
  ];
  return !contexts.some((context) =>
    steps.every((leaf) => admits(context, leaf.use.id, leaf.use.version)),
  );
}

/**
 * Fill in the connector of every top-level node the draft left unnamed, when
 * the draft needs more than one, and report every node's connector and every
 * choice left to a person. A connector the author named is never changed.
 * `leaves` is the expansion `validateRecipe` produced for `definition`.
 */
export function assignConnectors(input: {
  definition: RecipeDefinition;
  leaves: readonly RecipeInvocation[];
  registry: OperationRegistry;
  connectors: readonly ConnectorBinding[];
  unavailable?: readonly string[];
  admits: ConnectorCatalog["admits"];
}): { definition: RecipeDefinition; report: ConnectorReport } {
  const { definition, leaves, registry, connectors, admits } = input;
  const issues: ConnectorIssue[] = [];
  const tops = definition.invocations;
  // A leaf belongs to the top-level node whose id is its longest prefix;
  // identifiers may themselves contain dots.
  const owner = new Map<string, string>();
  for (const leaf of leaves) {
    const match = tops
      .filter((top) => leaf.id === top.id || leaf.id.startsWith(`${top.id}.`))
      .sort((a, b) => b.id.length - a.id.length)[0];
    if (match) owner.set(leaf.id, match.id);
  }
  const leavesOf = (top: string) =>
    leaves.filter((leaf) => owner.get(leaf.id) === top);
  const neutral = (leaf: RecipeInvocation) =>
    registry.isNeutral(leaf.use.id, leaf.use.version);
  const contract = (leaf: RecipeInvocation) =>
    registry.get(leaf.use.id, leaf.use.version)?.contract;
  const pair = (leaf: RecipeInvocation) => {
    const found = contract(leaf);
    return found ? `${found.provider}/${found.profile}` : "";
  };

  const spans = spansConnectors(leaves, registry, admits, connectors);

  const resolved = new Map<string, string>();
  const nodes = new Map<string, NodeConnector>();
  const neutralOnly = new Set<string>();
  for (const top of tops) {
    const own = leavesOf(top.id);
    const pending = own.filter((leaf) => !leaf.connector && !neutral(leaf));
    if (top.connector) {
      resolved.set(top.id, top.connector);
      nodes.set(top.id, {
        node: top.id,
        connector: top.connector,
        source: "declared",
      });
      // A named connector is kept, but checked: one the host does not offer,
      // or one whose context would refuse the node's own steps, fails only
      // at createRun otherwise, after a person has reviewed the draft.
      if (!spans) continue;
      // Validation already gave every step beneath the node this connector,
      // except those a pinned child placed elsewhere itself.
      const governed = own.filter(
        (leaf) => leaf.connector === top.connector && !neutral(leaf),
      );
      const binding = connectors.find(
        (connector) => connector.connectorId === top.connector,
      );
      if (!binding && !input.unavailable?.includes(top.connector))
        issues.push({
          code: "connector-unavailable",
          node: top.id,
          message: `Connector ${top.connector} is not one this host offers you. Name an approved connector.`,
        });
      else if (
        binding &&
        !governed.every((leaf) =>
          admits(binding, leaf.use.id, leaf.use.version),
        )
      )
        issues.push({
          code: "connector-inadmissible",
          node: top.id,
          message: `Connector ${top.connector} runs ${binding.provider}/${binding.profile} steps, and this step's operations (${[...new Set(governed.map(pair))].sort().join(", ")}) cannot run in its context. Name a connector for their provider.`,
        });
      continue;
    }
    if (!spans) {
      nodes.set(top.id, { node: top.id, source: "run" });
      continue;
    }
    if (!pending.length) {
      if (own.some((leaf) => leaf.connector))
        nodes.set(top.id, { node: top.id, source: "nested" });
      else if (own.length) neutralOnly.add(top.id);
      else nodes.set(top.id, { node: top.id, source: "unresolved" });
      continue;
    }
    const providers = [...new Set(pending.map(pair))].sort();
    const candidates = [
      ...new Set(
        connectors
          .filter((connector) =>
            pending.every((leaf) =>
              admits(connector, leaf.use.id, leaf.use.version),
            ),
          )
          .map((connector) => connector.connectorId),
      ),
    ].sort();
    if (candidates.length === 1) {
      resolved.set(top.id, candidates[0]!);
      nodes.set(top.id, {
        node: top.id,
        connector: candidates[0]!,
        source: "provider",
      });
      continue;
    }
    nodes.set(top.id, { node: top.id, source: "unresolved" });
    if (candidates.length > 1)
      issues.push({
        code: "connector-ambiguous",
        node: top.id,
        message: `More than one approved connector can run ${providers.join(" and ")} steps: ${candidates.join(", ")}. Name the one this step runs under; it decides whose account the step acts with.`,
        choices: candidates,
      });
    else if (providers.length > 1)
      issues.push({
        code: "connector-mixed",
        node: top.id,
        message: `This step's operations belong to more than one provider (${providers.join(", ")}), so no single connector can run them. Name a connector for each provider inside the child recipe.`,
      });
    else
      issues.push({
        code: "connector-unavailable",
        node: top.id,
        message: `No approved connector runs ${providers[0]} steps. Install or configure one, then name it here.`,
      });
  }

  // Leaf-level data edges: a binding (or an outcome value) that reads another
  // leaf's output.
  const byId = new Map(leaves.map((leaf) => [leaf.id, leaf]));
  const edges: Edge[] = [];
  for (const consumer of leaves)
    for (const binding of [
      ...Object.values(consumer.bindings),
      ...Object.values(consumer.outcome?.values ?? {}),
    ] as Binding[]) {
      if (binding.from !== "output" || binding.node === consumer.id) continue;
      const producer = byId.get(binding.node);
      if (producer) edges.push({ producer, consumer, name: binding.name });
    }
  const effective = (leaf: RecipeInvocation) =>
    leaf.connector ?? resolved.get(owner.get(leaf.id) ?? "");

  // Provider-neutral nodes: a group of them joined by artifacts inherits the
  // connector of every provider step it exchanges artifacts with, when that is
  // one connector. A neighbour still unresolved counts as a disagreement, so
  // nothing is inherited from half the picture.
  const groups: string[][] = [];
  const seen = new Set<string>();
  for (const start of neutralOnly) {
    if (seen.has(start)) continue;
    const group: string[] = [];
    const queue = [start];
    seen.add(start);
    while (queue.length) {
      const current = queue.pop()!;
      group.push(current);
      for (const edge of edges) {
        const ends = [owner.get(edge.producer.id), owner.get(edge.consumer.id)];
        if (!ends.includes(current)) continue;
        for (const end of ends)
          if (end && neutralOnly.has(end) && !seen.has(end)) {
            seen.add(end);
            queue.push(end);
          }
      }
    }
    groups.push(group);
  }
  for (const group of groups) {
    const around = new Set<string | undefined>();
    for (const edge of edges)
      for (const [inside, outside] of [
        [edge.producer, edge.consumer],
        [edge.consumer, edge.producer],
      ] as const)
        if (
          group.includes(owner.get(inside.id) ?? "") &&
          !neutralOnly.has(owner.get(outside.id) ?? "")
        )
          around.add(effective(outside));
    const choices = [...around].filter((id): id is string => Boolean(id));
    if (around.size === 1 && choices.length === 1) {
      for (const top of group) {
        resolved.set(top, choices[0]!);
        nodes.set(top, {
          node: top,
          connector: choices[0]!,
          source: "inherited",
        });
      }
      continue;
    }
    for (const top of group) {
      nodes.set(top, { node: top, source: "unresolved" });
      issues.push({
        code: "connector-inherit-ambiguous",
        node: top,
        message: around.size
          ? `This provider-neutral step exchanges artifacts with steps under ${around.has(undefined) ? "an unresolved connector" : `different connectors (${choices.sort().join(", ")})`}. Name the connector it runs under.`
          : "This provider-neutral step exchanges no artifact with a provider step, so it has no connector to take. Name the connector it runs under.",
        ...(choices.length ? { choices: [...new Set(choices)].sort() } : {}),
      });
    }
  }

  // An artifact leaves the connector context that produced it only when its
  // vocabulary is declared shareable. Operations of different providers are
  // already reported by validation (`cross-provider-binding`); this covers two
  // connectors of the same provider, which only the placement can see.
  for (const edge of edges) {
    const from = effective(edge.producer);
    const to = effective(edge.consumer);
    if (!from || !to || from === to) continue;
    if (contract(edge.producer)?.provider !== contract(edge.consumer)?.provider)
      continue;
    const name = contract(edge.producer)?.outputs[edge.name]?.contract;
    if (name && registry.vocabulary.get(name)?.crossProvider) continue;
    issues.push({
      code: "cross-connector-artifact",
      node: edge.consumer.id,
      message: `"${name ?? edge.name}" is produced under connector ${from} and consumed under ${to}. Only an artifact whose vocabulary is declared crossProvider may cross between connectors; run both steps under one connector.`,
    });
  }

  return {
    definition: {
      ...definition,
      invocations: tops.map((top) => {
        const assigned = resolved.get(top.id);
        return top.connector || !assigned || !spans
          ? top
          : { ...top, connector: assigned };
      }),
    },
    report: {
      spansConnectors: spans,
      nodes: tops.map((top) => nodes.get(top.id)!),
      issues,
      ...(spans && input.unavailable?.length
        ? { unavailable: [...input.unavailable].sort() }
        : {}),
    },
  };
}
