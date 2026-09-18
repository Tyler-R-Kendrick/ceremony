import {
  principalKey,
  samePrincipal,
  type AclInheritanceType,
  type RetrievalAcl,
  type RetrievalDescriptor,
  type RetrievalPrincipal,
} from "./descriptor.js";

/*
 * Conservative access evaluation. Every uncertainty is a denial:
 *
 * - membership the port cannot answer, or answers as stale, denies;
 * - an inheritance parent that cannot be resolved denies;
 * - an end user whose identity is not established by the host denies;
 * - an ACL capture older than its own freshness policy denies;
 * - the ingestion service account never grants end-user visibility (AC-EXT-16).
 *
 * Denied readers beat readers at every level, matching the documented model in
 * which "a direct denied principal is a user identified in an ACL as not having
 * access to an item", and inheritance chains are evaluated leaf to root with
 * BOTH_PERMIT, CHILD_OVERRIDE and PARENT_OVERRIDE deciding conflicts.
 */

export type MembershipAnswer = {
  /** Group principals this user belongs to, in the identity sources asked about. */
  groups: RetrievalPrincipal[];
  /** Domains this user belongs to. */
  domains: string[];
  /** When this membership snapshot was taken; older than policy means stale. */
  resolvedAt: number;
  /** The port's own statement that it could not answer authoritatively. */
  complete: boolean;
};

export interface MembershipPort {
  /**
   * Current membership for one principal. Returning `undefined` means the port
   * does not know, which is a denial and never an empty membership.
   */
  membershipOf(
    principal: RetrievalPrincipal,
    identitySources: readonly string[],
  ): Promise<MembershipAnswer | undefined>;
  /** The ACL of an inherited-from document; `undefined` denies the whole chain. */
  aclOf?(documentId: string): Promise<RetrievalAcl | undefined>;
}

export type AccessDecision = {
  allowed: boolean;
  /** A stable, sanitized reason code; never repository prose. */
  reason:
    | "allowed"
    | "no-matching-reader"
    | "denied-reader"
    | "parent-denies"
    | "membership-unknown"
    | "membership-stale"
    | "inheritance-unresolved"
    | "inheritance-cycle"
    | "identity-unresolved"
    | "acl-stale"
    | "ingestion-principal"
    | "identity-source-unmapped";
  /** The ACL levels consulted, leaf first, for audit. */
  evaluated: string[];
  /** When the membership snapshot used was taken; absent when none was used. */
  membershipResolvedAt?: number;
  /** Everything the decision depends on, for a cache key that cannot cross principals. */
  cacheKey: string;
};

export type EvaluateAccessOptions = {
  /** Current time; evaluation is a function of it, never of an ambient clock. */
  now: number;
  /** Maximum inheritance depth; a deeper chain is unresolved, not truncated. */
  maxDepth?: number;
};

const deny = (
  reason: AccessDecision["reason"],
  evaluated: string[],
  cacheKey: string,
  membershipResolvedAt?: number,
): AccessDecision => ({
  allowed: false,
  reason,
  evaluated,
  ...(membershipResolvedAt === undefined ? {} : { membershipResolvedAt }),
  cacheKey,
});

/**
 * A cache key that binds a decision to the exact principal, document, ACL
 * capture and membership snapshot behind it. A cache keyed by this cannot serve
 * one user's answer to another, or a pre-revocation answer after a revocation.
 */
export function accessCacheKey(input: {
  descriptor: Pick<RetrievalDescriptor, "sourceDocumentId" | "freshness">;
  principal: RetrievalPrincipal;
  membershipResolvedAt?: number;
  indexedAt: number;
}): string {
  return [
    "retrieval",
    input.descriptor.sourceDocumentId,
    principalKey(input.principal),
    `indexed:${input.indexedAt}`,
    `version:${input.descriptor.freshness.sourceVersion ?? ""}`,
    `membership:${input.membershipResolvedAt ?? "none"}`,
  ].join("|");
}

function matches(
  principal: RetrievalPrincipal,
  membership: MembershipAnswer,
  entry: RetrievalPrincipal,
): boolean {
  if (entry.kind === "domain") return membership.domains.includes(entry.id);
  if (entry.kind === "user") return samePrincipal(entry, principal);
  return membership.groups.some((group) => samePrincipal(group, entry));
}

type LevelVerdict = "permit" | "deny" | "silent";

function verdictOf(
  acl: RetrievalAcl,
  principal: RetrievalPrincipal,
  membership: MembershipAnswer,
): LevelVerdict {
  // Denied readers are checked first and win at this level unconditionally.
  if (acl.deniedReaders.some((entry) => matches(principal, membership, entry)))
    return "deny";
  if (acl.readers.some((entry) => matches(principal, membership, entry)))
    return "permit";
  return "silent";
}

/** Resolves a child verdict against its parent's, by the declared inheritance type. */
function combine(
  child: LevelVerdict,
  parent: LevelVerdict,
  type: AclInheritanceType,
): LevelVerdict {
  switch (type) {
    case "BOTH_PERMIT":
      // Access only when both permit; either side's silence or denial refuses.
      return child === "permit" && parent === "permit" ? "permit" : "deny";
    case "CHILD_OVERRIDE":
      // The child decides when it has an opinion; otherwise the parent does.
      return child === "silent" ? parent : child;
    case "PARENT_OVERRIDE":
      return parent === "silent" ? child : parent;
    case "NOT_APPLICABLE":
    default:
      return child;
  }
}

/**
 * Decides whether one end-user principal may read one described document,
 * using current membership rather than anything captured at ingestion.
 */
export async function evaluateAccess(
  descriptor: RetrievalDescriptor,
  principal: RetrievalPrincipal,
  membershipPort: MembershipPort,
  options: EvaluateAccessOptions,
): Promise<AccessDecision> {
  const evaluated = [descriptor.sourceDocumentId];
  const baseKey = accessCacheKey({
    descriptor,
    principal,
    indexedAt: descriptor.freshness.indexedAt,
  });

  // An end user whose identity the host has not established is not a principal.
  if (descriptor.endUserBinding.resolution === "unresolved")
    return deny("identity-unresolved", evaluated, baseKey);

  // AC-EXT-16: the ingestion service account is never an end-user reader. Its
  // access is why the document exists in the index, not permission to see it.
  if (samePrincipal(principal, descriptor.source.ingestionPrincipal))
    return deny("ingestion-principal", evaluated, baseKey);

  // A principal from an identity source the descriptor never mapped cannot be
  // matched against its ACL entries with any confidence.
  if (
    principal.kind !== "domain" &&
    principal.identitySource !== descriptor.endUserBinding.identitySource
  )
    return deny("identity-source-unmapped", evaluated, baseKey);
  if (
    principal.kind !== "domain" &&
    principal.identitySource !== "" &&
    !descriptor.membership.externalIdentitiesMapped
  )
    return deny("identity-source-unmapped", evaluated, baseKey);

  // An ACL capture older than its own policy must be re-read before it is used.
  if (
    options.now - descriptor.freshness.indexedAt >
    descriptor.freshness.aclMaxAgeMs
  )
    return deny("acl-stale", evaluated, baseKey);

  const membership = await membershipPort.membershipOf(
    principal,
    descriptor.membership.identitySources,
  );
  if (!membership || !membership.complete)
    return deny("membership-unknown", evaluated, baseKey);
  const cacheKey = accessCacheKey({
    descriptor,
    principal,
    membershipResolvedAt: membership.resolvedAt,
    indexedAt: descriptor.freshness.indexedAt,
  });
  if (
    options.now - membership.resolvedAt >
    descriptor.membership.maxStalenessMs
  )
    return deny("membership-stale", evaluated, cacheKey, membership.resolvedAt);

  // Walk the inheritance chain leaf to root, collecting each level's verdict.
  const maxDepth = options.maxDepth ?? 16;
  const levels: Array<{ acl: RetrievalAcl; id: string }> = [
    { acl: descriptor.acl, id: descriptor.sourceDocumentId },
  ];
  const seen = new Set([descriptor.sourceDocumentId]);
  let current = descriptor.acl;
  while (current.inheritFrom) {
    if (levels.length >= maxDepth)
      return deny(
        "inheritance-unresolved",
        evaluated,
        cacheKey,
        membership.resolvedAt,
      );
    if (seen.has(current.inheritFrom))
      return deny(
        "inheritance-cycle",
        evaluated,
        cacheKey,
        membership.resolvedAt,
      );
    if (!membershipPort.aclOf)
      return deny(
        "inheritance-unresolved",
        evaluated,
        cacheKey,
        membership.resolvedAt,
      );
    const parent = await membershipPort.aclOf(current.inheritFrom);
    if (!parent)
      return deny(
        "inheritance-unresolved",
        evaluated,
        cacheKey,
        membership.resolvedAt,
      );
    seen.add(current.inheritFrom);
    evaluated.push(current.inheritFrom);
    levels.push({ acl: parent, id: current.inheritFrom });
    current = parent;
  }

  // Resolve from the root back down, so each child combines with a parent
  // verdict that already accounts for everything above it.
  let verdict: LevelVerdict = "silent";
  for (let index = levels.length - 1; index >= 0; index--) {
    const level = levels[index]!;
    const own = verdictOf(level.acl, principal, membership);
    verdict =
      index === levels.length - 1
        ? own
        : combine(own, verdict, level.acl.inheritanceType);
  }

  if (verdict === "permit")
    return {
      allowed: true,
      reason: "allowed",
      evaluated,
      membershipResolvedAt: membership.resolvedAt,
      cacheKey,
    };
  // Distinguish an explicit denial from the absence of a grant: both refuse,
  // but an operator reading an audit trail needs to tell them apart.
  const leafVerdict = verdictOf(descriptor.acl, principal, membership);
  if (leafVerdict === "deny")
    return deny("denied-reader", evaluated, cacheKey, membership.resolvedAt);
  if (levels.length > 1 && leafVerdict === "permit")
    return deny("parent-denies", evaluated, cacheKey, membership.resolvedAt);
  return deny("no-matching-reader", evaluated, cacheKey, membership.resolvedAt);
}
