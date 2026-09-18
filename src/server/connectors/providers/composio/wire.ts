import { z } from "zod";

/*
 * Wire shapes of the Composio platform API.
 *
 * Source lock (retrieved 2026-09-18, https://docs.composio.dev):
 *   - docs/authentication .................... toolkit / auth config / connected
 *                                              account / session concepts, Connect
 *                                              Link, user id guidance
 *   - docs/authenticating-tools .............. initiate -> redirect_url, callback
 *                                              query parameters, status values,
 *                                              several accounts per user+toolkit
 *   - docs/auth-configuration/connected-accounts  ca_ / ac_ id prefixes, enable /
 *                                              disable semantics, redaction of
 *                                              state.val
 *   - docs/toolkit-versioning ................ YYYYMMDD_NN version strings,
 *                                              "latest", toolkit_versions map
 *   - toolkits/meta-tools .................... the six meta tools
 *   - reference/v3/api-reference/{toolkits,tools,auth-configs,connected-accounts,
 *     tool-router} ........................... paths, query parameters, request and
 *                                              response field names quoted below
 *
 * The v3 surface is frozen at https://backend.composio.dev/api/v3 and the
 * documentation names v3.1 as current at .../api/v3.1; the two differ in their
 * default toolkit version, not in the paths this adapter uses. The base path is
 * therefore configuration, and this adapter always sends an explicit version so
 * the default never decides which code runs.
 *
 * Every schema is deliberately loose: Composio adds fields, and a new field must
 * not break a deployment. Nothing parsed here is returned as-is; each module
 * projects the fields it needs, so a credential in `state.val` or an
 * attacker-written tool description never reaches a public result.
 */

export const COMPOSIO_SOURCE_PROFILE = "composio-platform-v3-2026-09";
export const COMPOSIO_API_ORIGIN = "https://backend.composio.dev";
/** Documented frozen base path. `v3.1` is the documented current alias. */
export const COMPOSIO_API_BASE = "/api/v3";
export const COMPOSIO_API_BASES = Object.freeze(["/api/v3", "/api/v3.1"]);

/**
 * Documented operations, with the method and path exactly as the reference
 * spells them. An operation absent from this table is not a Composio operation.
 */
export const composioEndpoints = Object.freeze({
  listToolkits: "GET /api/v3/toolkits",
  getToolkit: "GET /api/v3/toolkits/{slug}",
  listAuthConfigs: "GET /api/v3/auth_configs",
  getAuthConfig: "GET /api/v3/auth_configs/{nanoid}",
  listConnectedAccounts: "GET /api/v3/connected_accounts",
  createConnectedAccount: "POST /api/v3/connected_accounts",
  getConnectedAccount: "GET /api/v3/connected_accounts/{nanoid}",
  deleteConnectedAccount: "DELETE /api/v3/connected_accounts/{nanoid}",
  setConnectedAccountStatus: "PATCH /api/v3/connected_accounts/{nanoId}/status",
  listTools: "GET /api/v3/tools",
  getTool: "GET /api/v3/tools/{tool_slug}",
  executeTool: "POST /api/v3/tools/execute/{tool_slug}",
  createSession: "POST /api/v3/tool_router/session",
  getSession: "GET /api/v3/tool_router/session/{session_id}",
  executeInSession: "POST /api/v3/tool_router/session/{session_id}/execute",
  executeMetaInSession:
    "POST /api/v3/tool_router/session/{session_id}/execute_meta",
});

/**
 * Documented operations this adapter deliberately does not implement, with the
 * reason. Recording them keeps the negative-capability report honest: the
 * endpoint exists, Ceremony does not drive it.
 */
export const composioUnimplementedEndpoints = Object.freeze({
  "POST /api/v3/connected_accounts/link":
    "Auth link sessions: the request and response schemas were not retrievable at the recorded time, so no request is constructed for it.",
  "POST /api/v3/connected_accounts/{nanoid}/refresh":
    "Documented as deprecated; reconnect issues a fresh authorization instead.",
  "POST /api/v3/tool_router/session/{session_id}/proxy_execute":
    "A credentialed generic proxy is not bound by this adapter.",
  "POST /api/v3/custom/toolkits/upsert":
    "Writing custom toolkits into the Composio project is a provisioning action.",
});

/** The meta tools a session may expose (toolkits/meta-tools, retrieved 2026-09-18). */
export const composioMetaTools = [
  "COMPOSIO_SEARCH_TOOLS",
  "COMPOSIO_GET_TOOL_SCHEMAS",
  "COMPOSIO_MANAGE_CONNECTIONS",
  "COMPOSIO_MULTI_EXECUTE_TOOL",
  "COMPOSIO_REMOTE_BASH_TOOL",
  "COMPOSIO_REMOTE_WORKBENCH",
] as const;
export type ComposioMetaTool = (typeof composioMetaTools)[number];
export const composioMetaToolSchema = z.enum(composioMetaTools);

/**
 * Meta tools that can change connection state, run code or read beyond one
 * approved tool. They are never enabled by a default and never inferred; only
 * an explicit binding entry turns one on, and even then it is one bound
 * operation with its own effect and consent policy.
 */
export const unrestrictedMetaTools: ReadonlySet<string> = new Set([
  "COMPOSIO_MANAGE_CONNECTIONS",
  "COMPOSIO_MULTI_EXECUTE_TOOL",
  "COMPOSIO_REMOTE_BASH_TOOL",
  "COMPOSIO_REMOTE_WORKBENCH",
]);

/**
 * Connected-account statuses. ACTIVE, INITIATED, EXPIRED, FAILED and INACTIVE
 * are documented in docs/authenticating-tools; INITIALIZING appears in the v3
 * reference enum. REVOKED and DELETED are reported by the SDK and are accepted
 * here but marked unverified in the ledger. An unrecognised status is never
 * treated as usable.
 */
export const composioAccountStatuses = [
  "INITIALIZING",
  "INITIATED",
  "ACTIVE",
  "INACTIVE",
  "EXPIRED",
  "FAILED",
  "REVOKED",
  "DELETED",
] as const;
export type ComposioAccountStatus = (typeof composioAccountStatuses)[number];

/** Auth schemes a connected account may use; the list is open on purpose. */
export const composioHostedAuthSchemes: ReadonlySet<string> = new Set([
  "OAUTH2",
  "OAUTH1",
  "OAUTH1A",
]);

const text = z.string().nullish();
const looseRecord = z.record(z.string(), z.unknown());

export const paginationSchema = z.looseObject({
  next_cursor: text,
  total_pages: z.number().int().nonnegative().nullish(),
  current_page: z.number().int().nonnegative().nullish(),
  total_items: z.number().int().nonnegative().nullish(),
});

/** Every list endpoint documented here answers with `items` plus pagination. */
const listOf = <T extends z.ZodType>(item: T) =>
  z.looseObject({ items: z.array(item) }).and(paginationSchema.partial());

export const toolkitRefSchema = z.looseObject({
  slug: z.string().min(1),
  name: text,
  logo: text,
});

export const toolkitMetaSchema = z.looseObject({
  description: text,
  logo: text,
  categories: z.array(z.unknown()).nullish(),
  tools_count: z.number().nullish(),
  triggers_count: z.number().nullish(),
  /** Documented as part of `meta`; the toolkit version currently served. */
  toolkit_version: text,
  app_url: text,
});

export const authConfigDetailSchema = z.looseObject({
  mode: text,
  name: text,
  fields: z.unknown().optional(),
  required_scopes: z.array(z.string()).nullish(),
  auth_hint_url: text,
  proxy: z.unknown().optional(),
});

export const toolkitSchema = z.looseObject({
  slug: z.string().min(1),
  name: z.string().min(1),
  type: text,
  enabled: z.boolean().nullish(),
  composio_managed_auth_schemes: z.array(z.string()).nullish(),
  auth_config_details: z.array(authConfigDetailSchema).nullish(),
  auth_guide_url: text,
  base_url: text,
  meta: toolkitMetaSchema.nullish(),
  get_current_user_endpoint: text,
  get_current_user_endpoint_method: text,
  deprecated: z.unknown().optional(),
});
export type ComposioToolkit = z.infer<typeof toolkitSchema>;
export const toolkitListSchema = listOf(toolkitSchema);

export const authConfigSchema = z.looseObject({
  id: z.string().min(1),
  uuid: text,
  name: text,
  no_of_connections: z.number().int().nonnegative().nullish(),
  status: text,
  toolkit: toolkitRefSchema.nullish(),
  auth_scheme: text,
  is_composio_managed: z.boolean().nullish(),
  is_disabled: z.boolean().nullish(),
  created_by: text,
  restrict_to_following_tools: z.array(z.string()).nullish(),
  expected_input_fields: z.array(z.unknown()).nullish(),
  /** Documented field; never read, never projected, never logged. */
  credentials: z.unknown().optional(),
});
export type ComposioAuthConfig = z.infer<typeof authConfigSchema>;
export const authConfigListSchema = listOf(authConfigSchema);

export const accountAuthConfigSchema = z.looseObject({
  id: z.string().min(1),
  auth_scheme: text,
  is_composio_managed: z.boolean().nullish(),
  is_disabled: z.boolean().nullish(),
});

/**
 * A connected account. `state.val` carries the provider credential (redacted by
 * default, per the documentation) and is never read by this adapter: the fields
 * below that are read are the identity and lifecycle fields only.
 */
export const connectedAccountSchema = z.looseObject({
  id: z.string().min(1),
  toolkit: toolkitRefSchema,
  auth_config: accountAuthConfigSchema,
  status: z.string().min(1),
  user_id: z.string().min(1),
  state: z.looseObject({ authScheme: text, val: z.unknown().optional() }).nullish(),
  data: looseRecord.nullish(),
  created_at: text,
  updated_at: text,
  status_reason: text,
  is_disabled: z.boolean().nullish(),
  test_request_endpoint: text,
});
export type ComposioConnectedAccount = z.infer<typeof connectedAccountSchema>;
export const connectedAccountListSchema = listOf(connectedAccountSchema);

/**
 * The documented 201 body of `POST /api/v3/connected_accounts`. `status`,
 * `redirect_url` and `redirect_uri` are each marked deprecated in the reference
 * while remaining the only documented carriers of the hosted authorization URL,
 * so both spellings are accepted and the fact is recorded as a limitation.
 */
export const createdConnectedAccountSchema = z.looseObject({
  id: z.string().min(1),
  connectionData: z
    .looseObject({ authScheme: text, val: z.unknown().optional() })
    .nullish(),
  status: text,
  redirect_url: text,
  redirect_uri: text,
});

export const toolDeprecationSchema = z.looseObject({
  is_deprecated: z.boolean().nullish(),
  available_versions: z.array(z.string()).nullish(),
  toolkit_version: text,
  replacement_tool: text,
});

export const toolSchema = z.looseObject({
  slug: z.string().min(1),
  name: text,
  description: text,
  toolkit: toolkitRefSchema.nullish(),
  version: text,
  available_versions: z.array(z.string()).nullish(),
  input_parameters: z.unknown().optional(),
  output_parameters: z.unknown().optional(),
  scopes: z.array(z.string()).nullish(),
  no_auth: z.boolean().nullish(),
  deprecated: toolDeprecationSchema.nullish(),
  tags: z.array(z.string()).nullish(),
});
export type ComposioTool = z.infer<typeof toolSchema>;
export const toolListSchema = listOf(toolSchema);

/** `POST /api/v3/tools/execute/{tool_slug}` 200 body. */
export const toolExecuteResponseSchema = z.looseObject({
  data: z.unknown().optional(),
  error: text,
  successful: z.boolean().nullish(),
  session_info: z.unknown().optional(),
  log_id: text,
});

/** `POST /api/v3/tool_router/session/{session_id}/execute` 200 body. */
export const sessionExecuteResponseSchema = z.looseObject({
  data: z.unknown().optional(),
  error: text,
  log_id: text,
});

/** `POST /api/v3/tool_router/session` 201 body. */
export const sessionSchema = z.looseObject({
  session_id: z.string().min(1),
  mcp: z.looseObject({ type: text, url: text }).nullish(),
  tool_router_tools: z.array(z.string()).nullish(),
  config: looseRecord.nullish(),
  config_version: z.number().int().nullish(),
  warnings: z.array(z.unknown()).nullish(),
});
export type ComposioSession = z.infer<typeof sessionSchema>;

/** Documented error body; never surfaced, only counted. */
export const errorBodySchema = z.looseObject({
  error: z.unknown().optional(),
  message: z.unknown().optional(),
  code: z.unknown().optional(),
});
