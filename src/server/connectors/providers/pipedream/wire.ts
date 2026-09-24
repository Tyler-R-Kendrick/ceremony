import { z } from "zod";

/*
 * Wire shapes of the Pipedream Connect REST API as documented at
 * https://pipedream.com/docs/connect/api-reference (pages retrieved
 * 2026-09-18). Every schema is loose on purpose: Pipedream adds fields, and a
 * new field must not break a deployment. Nothing parsed here is returned as
 * is; each module projects the fields it needs, so a credentials object or an
 * attacker-written description in a response never reaches a public result.
 */

export const PIPEDREAM_SOURCE_PROFILE = "pipedream-connect-rest-2026-09";
export const PIPEDREAM_API_ORIGIN = "https://api.pipedream.com";
export const PIPEDREAM_CONNECT_LINK_ORIGIN = "https://pipedream.com";
/** Connect tokens live at most four hours (documented). */
export const CONNECT_TOKEN_MAX_LIFETIME_MS = 4 * 60 * 60 * 1000;
/** The proxy terminates requests after 30 seconds with a 504 (documented). */
export const PROXY_MAX_TIMEOUT_MS = 30_000;

/** Operations this adapter uses, with the documented method and path. */
export const pipedreamEndpoints = Object.freeze({
  oauthToken: "POST /v1/oauth/token",
  listApps: "GET /v1/connect/apps",
  retrieveApp: "GET /v1/connect/apps/{app_id}",
  listAccounts: "GET /v1/connect/{project_id}/accounts",
  listUserAccounts:
    "GET /v1/connect/{project_id}/users/{external_user_id}/accounts",
  retrieveAccount: "GET /v1/connect/{project_id}/accounts/{account_id}",
  deleteAccount: "DELETE /v1/connect/{project_id}/accounts/{account_id}",
  createConnectToken: "POST /v1/connect/{project_id}/tokens",
  proxy: "{METHOD} /v1/connect/{project_id}/proxy/{url_64}",
  runAction: "POST /v1/connect/{project_id}/actions/run",
  listComponents: "GET /v1/connect/{project_id}/components",
  retrieveComponent: "GET /v1/connect/{project_id}/components/{component_id}",
  deployTrigger: "POST /v1/connect/{project_id}/triggers/deploy",
  listDeployedTriggers: "GET /v1/connect/{project_id}/deployed-triggers",
  getDeployedTrigger:
    "GET /v1/connect/{project_id}/deployed-triggers/{trigger_id}",
  deleteDeployedTrigger:
    "DELETE /v1/connect/{project_id}/deployed-triggers/{trigger_id}",
  listTriggerWebhooks:
    "GET /v1/connect/{project_id}/deployed-triggers/{trigger_id}/webhooks",
});

/**
 * Request headers the documented proxy rejects with 400. A binding's fixed
 * upstream headers are checked against this list before a request is built,
 * and credential-bearing names are refused on top because settings are inert
 * configuration, never a credential channel.
 */
export const proxyBlockedHeaders = new Set([
  "accept-encoding",
  "access-control-request-headers",
  "access-control-request-method",
  "connection",
  "content-length",
  "cookie",
  "date",
  "dnt",
  "expect",
  "host",
  "keep-alive",
  "origin",
  "permissions-policy",
  "referer",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
  "via",
  "authorization",
  "proxy-authorization",
  "set-cookie",
]);
export const proxyBlockedHeaderPrefixes = ["proxy-", "sec-", "x-pd-"];

const optionalText = z.string().nullish();

export const pageInfoSchema = z.looseObject({
  count: z.number().int().nonnegative().nullish(),
  total_count: z.number().int().nonnegative().nullish(),
  start_cursor: optionalText,
  end_cursor: optionalText,
});

export const appConnectSchema = z.looseObject({
  proxy_enabled: z.boolean().nullish(),
  allowed_domains: z.array(z.string()).nullish(),
  base_proxy_target_url: optionalText,
});

export const appSchema = z.looseObject({
  id: optionalText,
  name_slug: z.string().min(1),
  name: z.string().min(1),
  auth_type: z.enum(["keys", "oauth", "none"]).nullish(),
  description: optionalText,
  img_src: optionalText,
  custom_fields_json: optionalText,
  categories: z.array(z.string()).nullish(),
  featured_weight: z.number().nullish(),
  connect: appConnectSchema.nullish(),
});
export type PipedreamApp = z.infer<typeof appSchema>;

export const appListSchema = z.looseObject({
  data: z.array(appSchema),
  page_info: pageInfoSchema.nullish(),
});
export const appEnvelopeSchema = z.union([
  z.looseObject({ data: appSchema }),
  appSchema,
]);

export const accountSchema = z.looseObject({
  id: z.string().regex(/^apn_[a-zA-Z0-9]+$/),
  name: optionalText,
  external_id: z.string().min(1),
  healthy: z.boolean().nullish(),
  dead: z.boolean().nullish(),
  app: appSchema,
  created_at: z.string(),
  updated_at: optionalText,
  authorized_scopes: z.array(z.string()).nullish(),
  expires_at: optionalText,
  error: optionalText,
});
export type PipedreamAccount = z.infer<typeof accountSchema>;

export const accountListSchema = z.looseObject({
  data: z.array(accountSchema),
  page_info: pageInfoSchema.nullish(),
});
/** The user-scoped listing is documented as a bare array; a data wrapper is tolerated. */
export const userAccountsSchema = z.union([
  z.array(accountSchema),
  z.looseObject({ data: z.array(accountSchema) }),
]);
/** The retrieve endpoint is documented bare; older examples wrapped it in data. */
export const accountEnvelopeSchema = z.union([
  z.looseObject({ data: accountSchema }),
  accountSchema,
]);

export const connectTokenSchema = z.looseObject({
  token: z.string().regex(/^ctok_[0-9a-f]{32}$/),
  expires_at: z.string(),
  connect_link_url: z.string(),
});

export const configurablePropSchema = z.looseObject({
  name: z.string(),
  type: z.string(),
  app: optionalText,
  label: optionalText,
  description: optionalText,
  optional: z.boolean().nullish(),
  remoteOptions: z.boolean().nullish(),
  reloadProps: z.boolean().nullish(),
  secret: z.boolean().nullish(),
  hidden: z.boolean().nullish(),
});

export const componentAnnotationsSchema = z.looseObject({
  destructiveHint: z.boolean().nullish(),
  idempotentHint: z.boolean().nullish(),
  openWorldHint: z.boolean().nullish(),
  readOnlyHint: z.boolean().nullish(),
  title: optionalText,
});

export const componentSchema = z.looseObject({
  key: z.string().min(1),
  name: z.string().min(1),
  version: z.string().min(1),
  description: optionalText,
  component_type: z.enum(["action", "trigger"]).nullish(),
  configurable_props: z.array(configurablePropSchema).nullish(),
  stash: optionalText,
  annotations: componentAnnotationsSchema.nullish(),
});
export type PipedreamComponent = z.infer<typeof componentSchema>;

export const componentEnvelopeSchema = z.looseObject({ data: componentSchema });
export const componentListSchema = z.looseObject({
  data: z.array(componentSchema),
  page_info: pageInfoSchema.nullish(),
});
/** Either documented response shape, or a bare component, as an import document. */
export const componentDocumentSchema = z.union([
  componentListSchema,
  componentEnvelopeSchema,
  componentSchema,
]);

export const actionRunSchema = z.looseObject({
  exports: z.unknown().optional(),
  os: z
    .array(
      z.looseObject({
        k: z.string().nullish(),
        err: z.unknown().optional(),
      }),
    )
    .nullish(),
  ret: z.unknown().optional(),
  stash_id: z.unknown().optional(),
  error: z.unknown().optional(),
});

export const deployedTriggerSchema = z.looseObject({
  id: z.string().regex(/^dc_[a-zA-Z0-9]+$/),
  owner_id: optionalText,
  component_id: optionalText,
  component_key: optionalText,
  configured_props: z.record(z.string(), z.unknown()).nullish(),
  active: z.boolean().nullish(),
  created_at: z.number().nullish(),
  updated_at: z.number().nullish(),
  name: optionalText,
  name_slug: optionalText,
  emit_on_deploy: z.boolean().nullish(),
  webhook_signing_key: optionalText,
});
export type PipedreamDeployedTrigger = z.infer<typeof deployedTriggerSchema>;
export const deployedTriggerEnvelopeSchema = z.looseObject({
  data: deployedTriggerSchema,
});
export const deployedTriggerListSchema = z.looseObject({
  data: z.array(deployedTriggerSchema),
  page_info: pageInfoSchema.nullish(),
});

export const triggerWebhooksSchema = z.looseObject({
  webhook_urls: z.array(z.string()).nullish(),
  webhooks: z
    .array(
      z.looseObject({
        id: optionalText,
        url: z.string(),
        signing_key: optionalText,
        signing_key_set: z.boolean().nullish(),
      }),
    )
    .nullish(),
});

/** Documented error body: `{ "error": "..." }`, sometimes with code/details. Never surfaced. */
export const errorBodySchema = z.looseObject({
  error: z.unknown().optional(),
  code: z.unknown().optional(),
});
