import { z } from "zod";
import { ConnectorError } from "../../errors.js";
import {
  aclInheritanceTypeSchema,
  retrievalDescriptorSchema,
  type RetrievalDescriptor,
  type RetrievalPrincipal,
} from "./descriptor.js";

/*
 * Reads a Cloud Search-informed ACL shape into a retrieval descriptor. The
 * input vocabulary is the documented one (`ItemAcl` with `readers`,
 * `deniedReaders`, `owners`, `inheritAclFrom`, `aclInheritanceType`; `Principal`
 * with `gsuitePrincipal` / `userResourceName` / `groupResourceName`), read from
 * https://developers.google.com/workspace/cloud-search/docs/reference/rest/v1/indexing.datasources.items
 * on 2026-09-18.
 *
 * This is a reader, not an adopter: Ceremony indexes nothing, and reading a
 * descriptor grants nothing. A principal whose shape cannot be understood is
 * rejected rather than dropped, because a silently dropped denied reader is a
 * disclosure.
 */

const boundedText = (max: number) =>
  z
    .string()
    .max(max)
    .regex(/^[^\p{Cc}]*$/u);

const resourceName = /^identitysources\/([^/]{1,256})\/(users|groups)\/(.{1,400})$/;

export const cloudSearchPrincipalSchema = z
  .looseObject({
    gsuitePrincipal: z
      .looseObject({
        gsuiteUserEmail: boundedText(320).optional(),
        gsuiteGroupEmail: boundedText(320).optional(),
        gsuiteDomain: z.union([z.boolean(), boundedText(256)]).optional(),
      })
      .optional(),
    userResourceName: boundedText(700).optional(),
    groupResourceName: boundedText(700).optional(),
  })
  .refine(
    (value) =>
      [
        value.gsuitePrincipal?.gsuiteUserEmail,
        value.gsuitePrincipal?.gsuiteGroupEmail,
        value.gsuitePrincipal?.gsuiteDomain,
        value.userResourceName,
        value.groupResourceName,
      ].filter((item) => item !== undefined && item !== false).length === 1,
    "A principal names exactly one identity",
  );

export const cloudSearchAclSchema = z.looseObject({
  readers: z.array(cloudSearchPrincipalSchema).max(1024).optional(),
  deniedReaders: z.array(cloudSearchPrincipalSchema).max(1024).optional(),
  owners: z.array(cloudSearchPrincipalSchema).max(256).optional(),
  inheritAclFrom: boundedText(512).optional(),
  aclInheritanceType: aclInheritanceTypeSchema.optional(),
});

export const cloudSearchItemSchema = z.looseObject({
  /** `datasources/{sourceId}/items/{itemId}`, or the bare repository id. */
  name: boundedText(700).min(1),
  itemType: z
    .enum(["CONTENT_ITEM", "CONTAINER_ITEM", "VIRTUAL_CONTAINER_ITEM"])
    .optional(),
  version: boundedText(200).optional(),
  acl: cloudSearchAclSchema,
  metadata: z
    .looseObject({ containerName: boundedText(700).optional() })
    .optional(),
});

export const readCloudSearchAclInputSchema = z.strictObject({
  item: cloudSearchItemSchema,
  /** The datasource that ingested the item. */
  datasourceId: boundedText(512).min(1),
  system: boundedText(200),
  /** The service account or workload that performed ingestion. */
  ingestionPrincipal: z.strictObject({
    identitySource: boundedText(256),
    id: boundedText(512).min(1),
  }),
  /** The identity source the asking end user's principal comes from. */
  endUserIdentitySource: boundedText(256),
  endUserResolution: z
    .enum(["host-authenticated-subject", "identity-source-mapping", "unresolved"])
    .default("host-authenticated-subject"),
  membership: z.strictObject({
    identitySources: z.array(boundedText(256)).max(32),
    groupsResolvedAt: z.number().int().nonnegative().optional(),
    maxStalenessMs: z.number().int().positive(),
    externalIdentitiesMapped: z.boolean(),
  }),
  freshness: z.strictObject({
    indexedAt: z.number().int().nonnegative(),
    aclMaxAgeMs: z.number().int().positive(),
  }),
});
export type ReadCloudSearchAclInput = z.infer<
  typeof readCloudSearchAclInputSchema
>;

function toPrincipal(
  input: z.infer<typeof cloudSearchPrincipalSchema>,
  defaultDomain: string | undefined,
): RetrievalPrincipal {
  const gsuite = input.gsuitePrincipal;
  if (gsuite?.gsuiteUserEmail)
    return { kind: "user", identitySource: "", id: gsuite.gsuiteUserEmail };
  if (gsuite?.gsuiteGroupEmail)
    return { kind: "group", identitySource: "", id: gsuite.gsuiteGroupEmail };
  if (gsuite?.gsuiteDomain !== undefined && gsuite.gsuiteDomain !== false) {
    // The documented flag form means "the whole customer domain"; a host must
    // say which domain that is, because an unnamed domain grant is unbounded.
    const domain =
      typeof gsuite.gsuiteDomain === "string" ? gsuite.gsuiteDomain : defaultDomain;
    if (!domain)
      throw new ConnectorError("invalid-request", {
        detail: "retrieval.principal.domain-unnamed",
      });
    return { kind: "domain", id: domain };
  }
  const resource = input.userResourceName ?? input.groupResourceName;
  const match = resource ? resourceName.exec(resource) : null;
  if (!match)
    throw new ConnectorError("invalid-request", {
      detail: "retrieval.principal.unrecognized",
    });
  return {
    kind: input.userResourceName ? "user" : "group",
    identitySource: match[1]!,
    id: match[3]!,
  };
}

/**
 * Normalizes a Cloud Search-informed item ACL into a retrieval descriptor. The
 * host supplies what the document cannot: which identity source the asking end
 * user comes from, what the membership assumptions are and how fresh an ACL
 * capture may be. A `gsuiteDomain: true` grant needs an explicit domain name.
 */
export function readCloudSearchStyleAcl(
  input: unknown,
  options: { defaultDomain?: string } = {},
): RetrievalDescriptor {
  const parsed = readCloudSearchAclInputSchema.safeParse(input);
  if (!parsed.success)
    throw new ConnectorError("invalid-request", {
      detail: "retrieval.acl.invalid",
    });
  const { item } = parsed.data;
  const acl = item.acl;
  const convert = (list: z.infer<typeof cloudSearchPrincipalSchema>[] | undefined) =>
    (list ?? []).map((principal) => toPrincipal(principal, options.defaultDomain));

  const inheritanceType = acl.aclInheritanceType ?? "NOT_APPLICABLE";
  if (acl.inheritAclFrom && inheritanceType === "NOT_APPLICABLE")
    throw new ConnectorError("invalid-request", {
      detail: "retrieval.acl.inheritance-unspecified",
    });

  const descriptor = retrievalDescriptorSchema.safeParse({
    schemaVersion: 1,
    sourceDocumentId: item.name,
    source: {
      datasourceId: parsed.data.datasourceId,
      system: parsed.data.system,
      ingestionPrincipal: {
        kind: "user",
        identitySource: parsed.data.ingestionPrincipal.identitySource,
        id: parsed.data.ingestionPrincipal.id,
      },
      ...(item.metadata?.containerName
        ? { containerId: item.metadata.containerName }
        : {}),
      itemType: item.itemType ?? "CONTENT_ITEM",
    },
    acl: {
      readers: convert(acl.readers),
      deniedReaders: convert(acl.deniedReaders),
      owners: convert(acl.owners),
      ...(acl.inheritAclFrom ? { inheritFrom: acl.inheritAclFrom } : {}),
      inheritanceType,
    },
    membership: parsed.data.membership,
    endUserBinding: {
      identitySource: parsed.data.endUserIdentitySource,
      resolution: parsed.data.endUserResolution,
    },
    freshness: {
      indexedAt: parsed.data.freshness.indexedAt,
      ...(item.version ? { sourceVersion: item.version } : {}),
      aclMaxAgeMs: parsed.data.freshness.aclMaxAgeMs,
    },
    nativeExtensions: {
      "cloud-search.itemType": item.itemType ?? "CONTENT_ITEM",
      ...(item.metadata?.containerName
        ? { "cloud-search.containerName": item.metadata.containerName }
        : {}),
    },
  });
  if (!descriptor.success)
    throw new ConnectorError("invalid-request", {
      detail: "retrieval.descriptor.invalid",
    });
  return descriptor.data;
}
