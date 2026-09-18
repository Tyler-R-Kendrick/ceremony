import type { DiscoveredItem } from "./../adapter.js";

/*
 * CAT-05: suggestions that two listings from different sources may describe
 * the same thing.
 *
 * This module produces suggestions and nothing else. It does not merge
 * connections, it does not transfer verification, it does not combine package
 * trust, and accepting a suggestion is a separate, authenticated host action
 * that lives outside this file. The evidence it will use is deliberately
 * narrow: a repository URL, the origin of a declared remote endpoint, and an
 * identical qualified name. A shared display name is not evidence — "Notes" is
 * a name a hundred publishers can choose, and two different publishers with
 * the same product name is exactly the case a reviewer must see, not the case
 * a heuristic should quietly resolve.
 */

export type EquivalenceReasonKind =
  | "same-repository"
  | "same-remote-origin"
  | "same-qualified-name";

export type EquivalenceReason = {
  kind: EquivalenceReasonKind;
  /** The exact value the members share, in its normalized comparison form. */
  value: string;
  /** Indices into the input array, so a caller can point at the rows. */
  members: number[];
};

export type EquivalenceMember = {
  index: number;
  ecosystem: string;
  authorityNamespace: string;
  nativeId: string;
  nativeVersion: string;
  displayName: string;
};

export type EquivalenceSuggestion = {
  members: EquivalenceMember[];
  /** Ordered strength of the shared evidence, never a probability of truth. */
  confidence: "high" | "medium" | "low";
  reasons: EquivalenceReason[];
  /** What a reviewer must decide; this module decides none of it. */
  limitations: string[];
};

export type SuggestEquivalencesOptions = {
  /** Cap on returned suggestions; the rest are dropped rather than truncated mid-group. */
  maxSuggestions?: number;
  /** Compare listings from the same ecosystem too (off by default: they are the source's own duplicates). */
  includeSameEcosystem?: boolean;
};

const LIMITATIONS = Object.freeze([
  "A suggestion is data for human review: it merges nothing, and it transfers no verification, custody or package trust between listings.",
  "Listings that look alike may still be different publishers, different forks or different deployments of the same code.",
]);

const PROVENANCE_REPOSITORY_KEYS = [
  "repositoryUrl",
  "sourceRepository",
  "upstreamRepository",
  "repository",
  "sourceCodeUrl",
];
const PROVENANCE_REMOTE_KEYS = ["remoteUrl", "deploymentUrl", "endpoint", "url"];

function normalizeRepository(value: string): string | undefined {
  if (!URL.canParse(value)) return undefined;
  const url = new URL(value);
  if (url.protocol !== "https:" && url.protocol !== "http:") return undefined;
  const host = url.hostname.toLowerCase().replace(/^www\./, "");
  // Only the owner/repository pair identifies a repository; a tree path, a
  // commit or a monorepo subdirectory is a location inside one.
  const parts = url.pathname
    .split("/")
    .filter(Boolean)
    .map((part) => part.replace(/\.git$/i, ""));
  if (parts.length < 2) return undefined;
  const [owner, repository] = parts;
  if (!owner || !repository) return undefined;
  return `${host}/${owner.toLowerCase()}/${repository.toLowerCase()}`;
}

function normalizeRemoteOrigin(value: string): string | undefined {
  if (!URL.canParse(value)) return undefined;
  const url = new URL(value);
  if (url.protocol !== "https:" && url.protocol !== "http:") return undefined;
  if (!url.hostname || url.hostname === "localhost") return undefined;
  return url.origin.toLowerCase();
}

function repositoryOf(item: DiscoveredItem): string | undefined {
  for (const key of PROVENANCE_REPOSITORY_KEYS) {
    const value = item.provenance?.[key];
    if (typeof value === "string") {
      const normalized = normalizeRepository(value);
      if (normalized) return normalized;
    }
  }
  return undefined;
}

function remoteOriginOf(item: DiscoveredItem): string | undefined {
  for (const key of PROVENANCE_REMOTE_KEYS) {
    const value = item.provenance?.[key];
    if (typeof value === "string") {
      const normalized = normalizeRemoteOrigin(value);
      if (normalized) return normalized;
    }
  }
  return undefined;
}

/** A qualified name is only comparable when it carries a namespace. */
function qualifiedNameOf(item: DiscoveredItem): string | undefined {
  const declared = item.provenance?.qualifiedName;
  const candidate =
    typeof declared === "string" && declared ? declared : item.identity.nativeId;
  if (!candidate.includes("/")) return undefined;
  return candidate.toLowerCase();
}

class Grouping {
  private readonly parent: number[];
  constructor(size: number) {
    this.parent = Array.from({ length: size }, (_, index) => index);
  }
  find(index: number): number {
    let current = index;
    while (this.parent[current] !== current) {
      const next = this.parent[current]!;
      this.parent[current] = this.parent[next]!;
      current = this.parent[current]!;
    }
    return current;
  }
  union(a: number, b: number): void {
    const rootA = this.find(a);
    const rootB = this.find(b);
    if (rootA !== rootB) this.parent[rootB] = rootA;
  }
}

function memberOf(item: DiscoveredItem, index: number): EquivalenceMember {
  return {
    index,
    ecosystem: item.identity.ecosystem,
    authorityNamespace: item.identity.authorityNamespace,
    nativeId: item.identity.nativeId,
    nativeVersion: item.identity.nativeVersion,
    displayName: item.displayName,
  };
}

/**
 * Groups discovered items that share a stable source identity and returns one
 * suggestion per group, for explicit human review.
 *
 * Confidence reflects how many independent stable identities the group shares,
 * and is never raised by a matching display name: a group whose only shared
 * evidence is a name is not produced at all.
 */
export function suggestEquivalences(
  items: DiscoveredItem[],
  options: SuggestEquivalencesOptions = {},
): EquivalenceSuggestion[] {
  const maxSuggestions = Math.max(options.maxSuggestions ?? 100, 1);
  const grouping = new Grouping(items.length);
  const byRepository = new Map<string, number[]>();
  const byRemote = new Map<string, number[]>();
  const byQualifiedName = new Map<string, number[]>();

  items.forEach((item, index) => {
    const repository = repositoryOf(item);
    if (repository)
      byRepository.set(repository, [
        ...(byRepository.get(repository) ?? []),
        index,
      ]);
    const remote = remoteOriginOf(item);
    if (remote) byRemote.set(remote, [...(byRemote.get(remote) ?? []), index]);
    const qualified = qualifiedNameOf(item);
    if (qualified)
      byQualifiedName.set(qualified, [
        ...(byQualifiedName.get(qualified) ?? []),
        index,
      ]);
  });

  const reasons: EquivalenceReason[] = [];
  const consider = (
    kind: EquivalenceReasonKind,
    table: Map<string, number[]>,
  ) => {
    for (const [value, members] of table) {
      const distinct = options.includeSameEcosystem
        ? members
        : members.filter(
            (index, position) =>
              members.findIndex(
                (other) =>
                  items[other]!.identity.ecosystem ===
                  items[index]!.identity.ecosystem,
              ) === position ||
              // Keep every member whose ecosystem differs from the first one.
              items[index]!.identity.ecosystem !==
                items[members[0]!]!.identity.ecosystem,
          );
      if (distinct.length < 2) continue;
      const ecosystems = new Set(
        distinct.map((index) => items[index]!.identity.ecosystem),
      );
      if (!options.includeSameEcosystem && ecosystems.size < 2) continue;
      reasons.push({ kind, value, members: [...distinct].sort((a, b) => a - b) });
      for (let position = 1; position < distinct.length; position++)
        grouping.union(distinct[0]!, distinct[position]!);
    }
  };
  consider("same-repository", byRepository);
  consider("same-remote-origin", byRemote);
  consider("same-qualified-name", byQualifiedName);

  const groups = new Map<number, Set<number>>();
  for (const reason of reasons)
    for (const index of reason.members) {
      const root = grouping.find(index);
      const members = groups.get(root) ?? new Set<number>();
      members.add(index);
      groups.set(root, members);
    }

  const suggestions: EquivalenceSuggestion[] = [];
  for (const members of groups.values()) {
    if (members.size < 2) continue;
    const memberIndexes = [...members].sort((a, b) => a - b);
    const groupReasons = reasons.filter((reason) =>
      reason.members.every((index) => members.has(index)),
    );
    if (!groupReasons.length) continue;
    const kinds = new Set(groupReasons.map((reason) => reason.kind));
    const confidence: EquivalenceSuggestion["confidence"] =
      kinds.size >= 2
        ? "high"
        : kinds.has("same-repository") || kinds.has("same-qualified-name")
          ? "medium"
          : "low";
    suggestions.push({
      members: memberIndexes.map((index) => memberOf(items[index]!, index)),
      confidence,
      reasons: groupReasons,
      limitations: [...LIMITATIONS],
    });
  }
  return suggestions
    .sort((a, b) => a.members[0]!.index - b.members[0]!.index)
    .slice(0, maxSuggestions);
}
