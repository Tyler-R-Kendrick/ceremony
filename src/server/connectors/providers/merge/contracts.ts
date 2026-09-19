import { z } from "zod";
import type { ConfigurationRequirement } from "../../adapter.js";
import { ConnectorError } from "../../errors.js";

/*
 * The Merge Unified API, from https://docs.merge.dev (retrieved 2026-09-18).
 *
 * Verified there: the production base URL `https://api.merge.dev/api` (with
 * `https://api-eu.merge.dev/api` and `https://api-ap.merge.dev/api` as the
 * regional variants); `Authorization: Bearer <API key>` for every call and
 * `X-Account-Token: <account token>` additionally for calls that touch one end
 * user's data; `POST /api/integrations/create-link-token`; `GET
 * /api/integrations/account-token/{public_token}`; per-category
 * `GET /{category}/v1/linked-accounts`, `GET /{category}/v1/account-details`,
 * `POST /{category}/v1/passthrough`, `GET /{category}/v1/{model}/meta/post`
 * and the category model endpoints. Linked-account statuses are COMPLETE,
 * INCOMPLETE, RELINK_NEEDED and IDLE; account types PRODUCTION and TEST.
 *
 * Custody is `external-credential-broker`: Merge holds the upstream provider's
 * credentials and never returns them. What Ceremony holds is the account token,
 * itself a credential, kept in custody and used only inside a `use` callback.
 */

export const MERGE_PROFILE = "merge-unified-2026-09";
export const MERGE_API_ORIGIN = "https://api.merge.dev";
export const MERGE_API_BASE_PATH = "/api";

export const mergeConfigurationNames = {
  apiKey: "MERGE_API_KEY",
  /** Optional regional origin; must be one of Merge's documented regional API origins. */
  apiOrigin: "MERGE_API_ORIGIN",
} as const;

export const mergeDestinationIds = { api: "api" } as const;

/** Documented regional origins; a configured origin must be one of these. */
export const mergeApiOrigins = [
  "https://api.merge.dev",
  "https://api-eu.merge.dev",
  "https://api-ap.merge.dev",
] as const;

export const mergeCategories = [
  "hris",
  "ats",
  "accounting",
  "ticketing",
  "crm",
  "mktg",
  "filestorage",
  "knowledgebase",
] as const;
export type MergeCategory = (typeof mergeCategories)[number];

export const mergeLinkedAccountStatuses = [
  "COMPLETE",
  "INCOMPLETE",
  "RELINK_NEEDED",
  "IDLE",
] as const;
export const mergeAccountTypes = ["PRODUCTION", "TEST"] as const;

export const mergeTargetKinds = {
  linkedAccount: "merge-linked-account",
  endUser: "merge-end-user",
} as const;

export const mergeConfigurationRequirements: readonly ConfigurationRequirement[] =
  [
    {
      name: mergeConfigurationNames.apiKey,
      source: "host",
      classification: "secret",
      required: true,
      description:
        "Merge production access key, presented as Authorization: Bearer on every call.",
    },
    {
      name: mergeConfigurationNames.apiOrigin,
      source: "host",
      classification: "public",
      required: false,
      description:
        "Regional Merge API origin; defaults to https://api.merge.dev and must match the approved destination.",
    },
  ];

const text = (max: number) =>
  z
    .string()
    .max(max)
    .regex(/^[^\p{Cc}]*$/u);

export const mergeIntegrationSchema = z.looseObject({
  name: text(200),
  categories: z.array(text(64)).max(16).optional(),
  image: text(2048).nullable().optional(),
  square_image: text(2048).nullable().optional(),
  color: text(32).optional(),
  slug: text(200).optional(),
  passthrough_available: z.boolean().optional(),
  api_endpoints_to_documentation_urls: z
    .record(z.string(), z.unknown())
    .optional(),
  webhook_setup_guide_url: text(2048).nullable().optional(),
});
export type MergeIntegration = z.infer<typeof mergeIntegrationSchema>;

export const mergeLinkedAccountSchema = z.looseObject({
  id: text(200).min(1),
  integration: mergeIntegrationSchema.optional(),
  integration_name: text(200).optional(),
  category: text(64).nullable().optional(),
  status: text(64).optional(),
  status_detail: text(2048).nullable().optional(),
  end_user_origin_id: text(200).nullable().optional(),
  end_user_organization_name: text(200).optional(),
  end_user_email_address: text(320).optional(),
  subdomain: text(200).nullable().optional(),
  webhook_listener_url: text(2048).optional(),
  is_duplicate: z.boolean().nullable().optional(),
  account_type: text(32).optional(),
  completed_at: text(64).nullable().optional(),
});
export type MergeLinkedAccount = z.infer<typeof mergeLinkedAccountSchema>;

export const mergeLinkedAccountsPageSchema = z.looseObject({
  next: text(2048).nullable().optional(),
  previous: text(2048).nullable().optional(),
  results: z.array(mergeLinkedAccountSchema).max(500),
});

export const mergeAccountDetailsSchema = z.looseObject({
  id: text(200).min(1),
  integration: text(200).optional(),
  integration_slug: text(200).optional(),
  category: text(64).nullable().optional(),
  end_user_origin_id: text(200).nullable().optional(),
  end_user_organization_name: text(200).optional(),
  end_user_email_address: text(320).optional(),
  status: text(64).optional(),
  webhook_listener_url: text(2048).optional(),
  is_duplicate: z.boolean().nullable().optional(),
  account_type: text(32).optional(),
  completed_at: text(64).nullable().optional(),
});

export const mergeLinkTokenResponseSchema = z.looseObject({
  link_token: z.string().min(1).max(4096),
  integration_name: text(200).optional(),
  magic_link_url: text(2048).optional(),
});

export const mergeAccountTokenResponseSchema = z.looseObject({
  account_token: z.string().min(1).max(4096),
  integration: mergeIntegrationSchema.optional(),
  id: text(200).optional(),
});

/**
 * The documented `/meta/post` response. `request_schema` describes exactly the
 * fields this linked account accepts, `status.linked_account_status` and
 * `status.can_make_request` describe whether it can be used at all. This is the
 * account-specific field availability; it is never generalized across accounts.
 */
export const mergeMetaResponseSchema = z.looseObject({
  request_schema: z.record(z.string(), z.unknown()).optional(),
  remote_field_classes: z.record(z.string(), z.unknown()).optional(),
  status: z
    .looseObject({
      linked_account_status: text(64).optional(),
      can_make_request: z.boolean().optional(),
    })
    .optional(),
  has_conditional_params: z.boolean().optional(),
  has_required_linked_account_params: z.boolean().optional(),
});
export type MergeMetaResponse = z.infer<typeof mergeMetaResponseSchema>;

export const mergePassthroughResponseSchema = z.looseObject({
  method: text(16).optional(),
  path: text(2048).optional(),
  status: z.number().int().optional(),
  response: z.unknown().optional(),
  response_headers: z.record(z.string(), z.unknown()).optional(),
  response_type: text(32).optional(),
  headers: z.record(z.string(), z.unknown()).optional(),
});

export const mergeListResponseSchema = z.looseObject({
  next: text(2048).nullable().optional(),
  previous: text(2048).nullable().optional(),
  results: z.array(z.record(z.string(), z.unknown())).max(500),
});

/** Category and model names are path segments; they are validated, never interpolated raw. */
export const mergeCategorySchema = z.enum(mergeCategories);
export const mergeModelSchema = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[a-z][a-z0-9-]*$/);

export function resolveMergeOrigin(
  configured: string | undefined,
): (typeof mergeApiOrigins)[number] {
  if (!configured) return MERGE_API_ORIGIN;
  const match = mergeApiOrigins.find((origin) => origin === configured);
  if (!match)
    throw new ConnectorError("invalid-request", {
      detail: "merge.origin.unknown",
    });
  return match;
}
