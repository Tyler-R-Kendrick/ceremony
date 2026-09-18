import { z } from "zod";

/*
 * A retrieval descriptor: what an indexed document is, where it came from, and
 * exactly who may read it. The ACL model is informed by Google Cloud Search's
 * documented one (https://developers.google.com/workspace/cloud-search/docs/guides/acls
 * and the `ItemAcl` reference, retrieved 2026-09-18), whose vocabulary is:
 * `readers`, `deniedReaders`, `owners`, `inheritAclFrom` and
 * `aclInheritanceType` with values NOT_APPLICABLE, CHILD_OVERRIDE,
 * PARENT_OVERRIDE and BOTH_PERMIT; principals are a `gsuitePrincipal`
 * (user email, group email or domain) or an identity-source resource name
 * (`identitysources/{source}/users/{id}`, `.../groups/{id}`).
 *
 * The two rules that matter most, and that this module never relaxes:
 *
 *   1. The service account that ingests is not an end user. Its ability to read
 *      a repository is why the document could be indexed at all; it is never a
 *      reason to show that document to a person (AC-EXT-16).
 *   2. An answer is only as current as the membership behind it. Group
 *      membership, inheritance and identity mapping all change after ingestion,
 *      so an evaluation that cannot see current data denies rather than guesses.
 */

const boundedText = (max: number) =>
  z
    .string()
    .max(max)
    .regex(/^[^\p{Cc}]*$/u);

const identifier = boundedText(512).min(1);

/** A principal: a user, a group or a whole domain, in one identity namespace. */
export const retrievalPrincipalSchema = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("user"),
    /** The identity source this name belongs to; "" is the host's own directory. */
    identitySource: boundedText(256),
    id: identifier,
  }),
  z.strictObject({
    kind: z.literal("group"),
    identitySource: boundedText(256),
    id: identifier,
  }),
  z.strictObject({
    kind: z.literal("domain"),
    /** A domain grant names the domain only; it has no identity source of its own. */
    id: identifier,
  }),
]);
export type RetrievalPrincipal = z.infer<typeof retrievalPrincipalSchema>;

export const aclInheritanceTypes = [
  "NOT_APPLICABLE",
  "CHILD_OVERRIDE",
  "PARENT_OVERRIDE",
  "BOTH_PERMIT",
] as const;
export const aclInheritanceTypeSchema = z.enum(aclInheritanceTypes);
export type AclInheritanceType = z.infer<typeof aclInheritanceTypeSchema>;

export const retrievalAclSchema = z
  .strictObject({
    readers: z.array(retrievalPrincipalSchema).max(1024),
    deniedReaders: z.array(retrievalPrincipalSchema).max(1024),
    owners: z.array(retrievalPrincipalSchema).max(256).default([]),
    /** The document id this ACL inherits from, when it does. */
    inheritFrom: identifier.optional(),
    inheritanceType: aclInheritanceTypeSchema.default("NOT_APPLICABLE"),
  })
  .superRefine((acl, ctx) => {
    if (acl.inheritFrom && acl.inheritanceType === "NOT_APPLICABLE")
      ctx.addIssue({
        code: "custom",
        message: "An inheriting ACL must name how conflicts resolve",
      });
    if (!acl.inheritFrom && acl.inheritanceType !== "NOT_APPLICABLE")
      ctx.addIssue({
        code: "custom",
        message: "An inheritance type requires a parent to inherit from",
      });
  });
export type RetrievalAcl = z.infer<typeof retrievalAclSchema>;

/**
 * What the descriptor assumes about the membership data behind its principals.
 * `maxStalenessMs` is the host's policy; `groupsResolvedAt` is when the
 * membership snapshot the descriptor was written against was taken. Neither is
 * evidence on its own: evaluation re-reads membership through a port.
 */
export const membershipAssumptionsSchema = z.strictObject({
  /** Identity sources whose group rosters this descriptor's ACL depends on. */
  identitySources: z.array(boundedText(256)).max(32),
  groupsResolvedAt: z.number().int().nonnegative().optional(),
  maxStalenessMs: z.number().int().positive().max(90 * 24 * 3600_000),
  /** True when external ids were mapped to host identities at ingestion. */
  externalIdentitiesMapped: z.boolean(),
});

/**
 * How an end user asking a question is bound to a principal. A retrieval answer
 * is authorized for a person, so the descriptor records how that person's
 * identity is established, and never accepts a principal supplied alongside a
 * query as if it were authenticated.
 */
export const endUserBindingSchema = z.strictObject({
  /** Which identity source the asking user's principal comes from. */
  identitySource: boundedText(256),
  /** How the host establishes the asking user: only authenticated paths are valid. */
  resolution: z.enum([
    "host-authenticated-subject",
    "identity-source-mapping",
    "unresolved",
  ]),
});

export const retrievalFreshnessSchema = z.strictObject({
  /** When the content and ACL were captured from the repository. */
  indexedAt: z.number().int().nonnegative(),
  /** The repository's own version/etag for the item at capture time. */
  sourceVersion: boundedText(200).optional(),
  /** How long an ACL capture may be trusted before it must be re-read. */
  aclMaxAgeMs: z.number().int().positive().max(90 * 24 * 3600_000),
});

export const retrievalDescriptorSchema = z
  .strictObject({
    schemaVersion: z.literal(1),
    /** The repository's own id for the document; opaque and preserved exactly. */
    sourceDocumentId: identifier,
    source: z.strictObject({
      /** The connector/datasource identity that ingested this document. */
      datasourceId: identifier,
      /** The repository or system of record. */
      system: boundedText(200),
      /** The service account or workload identity that performed ingestion. */
      ingestionPrincipal: retrievalPrincipalSchema,
      /** The container item this document belongs to, when the repository has one. */
      containerId: identifier.optional(),
      itemType: z
        .enum(["CONTENT_ITEM", "CONTAINER_ITEM", "VIRTUAL_CONTAINER_ITEM"])
        .default("CONTENT_ITEM"),
    }),
    acl: retrievalAclSchema,
    membership: membershipAssumptionsSchema,
    endUserBinding: endUserBindingSchema,
    freshness: retrievalFreshnessSchema,
    /** Inert repository metadata; never evaluated, never a grant. */
    nativeExtensions: z
      .record(boundedText(120).min(1), z.unknown())
      .refine((value) => Object.keys(value).length <= 64)
      .refine(
        (value) =>
          !["__proto__", "prototype", "constructor"].some((key) =>
            Object.hasOwn(value, key),
          ),
      )
      .default({}),
  })
  .superRefine((descriptor, ctx) => {
    // The ingestion principal is not an end user, so it may not appear as a
    // reader: a descriptor that grants its own indexer visibility would make
    // every document readable by whoever can ask the index.
    const ingestion = descriptor.source.ingestionPrincipal;
    if (
      descriptor.acl.readers.some((reader) => samePrincipal(reader, ingestion))
    )
      ctx.addIssue({
        code: "custom",
        message:
          "The ingestion principal cannot be a reader; indexing access is not end-user visibility",
      });
  });
export type RetrievalDescriptor = z.infer<typeof retrievalDescriptorSchema>;

/** Principal identity is exact: namespace and id, with no case folding or suffix match. */
export function samePrincipal(
  a: RetrievalPrincipal,
  b: RetrievalPrincipal,
): boolean {
  if (a.kind !== b.kind) return false;
  if (a.kind === "domain" || b.kind === "domain") return a.id === b.id;
  return a.id === b.id && a.identitySource === b.identitySource;
}

export function principalKey(principal: RetrievalPrincipal): string {
  return principal.kind === "domain"
    ? `domain:${principal.id}`
    : `${principal.kind}:${principal.identitySource}:${principal.id}`;
}
