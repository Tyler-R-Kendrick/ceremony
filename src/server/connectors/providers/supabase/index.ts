/*
 * Supabase connector profiles. Four adapters, four authorities:
 *
 *   createSupabaseManagementAdapter  "supabase-management"  Management OAuth for a dashboard user
 *   createSupabaseHostedMcpProfile   "supabase-mcp"         hosted MCP server with approved restrictions
 *   createSupabaseDataApiAdapter     "supabase-data-api"    PostgREST reads as the signed-in project user
 *   createSupabaseWrappersAdapter    "supabase-wrappers"    Wrappers descriptor and approved foreign reads
 *
 * They share a vocabulary (common.ts) and lifecycle mapping (lifecycle.ts) and
 * nothing else: no adapter can use another adapter's credential.
 */
export * from "./common.js";
export * from "./lifecycle.js";
export * from "./management.js";
export * from "./hosted-mcp.js";
export * from "./data-api.js";
export * from "./wrappers.js";
