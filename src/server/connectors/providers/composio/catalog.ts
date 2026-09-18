import {
  canonicalDigest,
  encodePathSegment,
  type CompatibilityIssue,
  type ConnectorSourceIdentity,
} from "../../../../core/connectors/index.js";
import type {
  DiscoverInput,
  DiscoverResult,
  DiscoveredItem,
} from "../../adapter.js";
import { ConnectorError } from "../../errors.js";
import { expectJson } from "./client.js";
import type { ComposioCall } from "./context.js";
import {
  composioToolSlugSchema,
  composioToolkitSlugSchema,
  composioAuthConfigIdSchema,
  composioConnectedAccountIdSchema,
} from "./identity.js";
import {
  authConfigListSchema,
  composioHostedAuthSchemes,
  connectedAccountListSchema,
  connectedAccountSchema,
  toolListSchema,
  toolSchema,
  toolkitListSchema,
  toolkitSchema,
  type ComposioAuthConfig,
  type ComposioConnectedAccount,
  type ComposioTool,
  type ComposioToolkit,
} from "./wire.js";

/*
 * Discovery across the four Composio concepts, each kept separate.
 *
 * A toolkit is a versioned family of tools for a service; an auth config is a
 * reusable blueprint for authenticating against one toolkit; a connected
 * account is one host user's credential under one auth config; a tool is a
 * versioned operation inside a toolkit. Discovery preserves every native
 * identifier and version exactly as Composio spells it — the `ac_` and `ca_`
 * nanoids, the upper-snake tool slugs and the `YYYYMMDD_NN` release stamps —
 * and never collapses any of them into the service slug that only groups rows
 * in a directory.
 */

const LIST_LIMIT = 50;

/** A version the source did not state. It is a sentinel, never a claim. */
export const UNVERSIONED = "unversioned";

function identity(
  call: ComposioCall,
  nativeId: string,
  nativeVersion: string,
): ConnectorSourceIdentity {
  return {
    ecosystem: "composio",
    authorityNamespace: call.authority,
    nativeId,
    nativeVersion,
  };
}

function versionAbsent(kind: string, pointer: string): CompatibilityIssue {
  return {
    code: "composio.version.absent",
    category: "version",
    sourcePointer: pointer,
    dimension: "discover",
    disposition: "native-extension",
    severity: "warning",
    executionImpact: "none",
    message: `Composio states no version for this ${kind}; it is recorded as unversioned rather than assumed current.`,
  };
}

function limit(input: DiscoverInput): number {
  return Math.min(Math.max(input.limit ?? LIST_LIMIT, 1), LIST_LIMIT);
}

function cursorQuery(input: DiscoverInput): Record<string, string> {
  return {
    limit: String(limit(input)),
    ...(input.cursor ? { cursor: input.cursor } : {}),
  };
}

function toolkitVersionOf(toolkit: ComposioToolkit): string | undefined {
  const value = toolkit.meta?.toolkit_version;
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

export async function listToolkits(
  call: ComposioCall,
  input: DiscoverInput,
): Promise<DiscoverResult> {
  const response = await call.client.send({
    method: "GET",
    path: call.client.path("/toolkits"),
    query: {
      ...cursorQuery(input),
      ...(input.query ? { search: input.query } : {}),
    },
    timeoutMs: call.options.timeouts.read,
    consequential: false,
  });
  const page = expectJson(response, toolkitListSchema);
  const issues: CompatibilityIssue[] = [];
  const items: DiscoveredItem[] = [];
  for (const toolkit of page.items) {
    if (!composioToolkitSlugSchema.safeParse(toolkit.slug).success) continue;
    const version = toolkitVersionOf(toolkit);
    if (!version) issues.push(versionAbsent("toolkit", `/items/${toolkit.slug}`));
    const schemes = toolkit.composio_managed_auth_schemes ?? [];
    items.push({
      identity: identity(call, toolkit.slug, version ?? UNVERSIONED),
      displayName: toolkit.name,
      description: String(toolkit.meta?.description ?? "").slice(0, 500),
      provenance: {
        kind: "toolkit",
        slug: toolkit.slug,
        ...(schemes.length ? { authSchemes: schemes.join(",") } : {}),
      },
      status: toolkit.enabled === false ? "deprecated" : "active",
    });
  }
  return {
    items,
    ...(page.next_cursor ? { nextCursor: page.next_cursor } : {}),
    freshness: {
      fetchedAt: call.ctx.environment.now(),
      stale: false,
      source: "live",
    },
    issues,
  };
}

export async function getToolkit(
  call: ComposioCall,
  slug: string,
): Promise<ComposioToolkit> {
  const response = await call.client.send({
    method: "GET",
    path: call.client.path(`/toolkits/${encodePathSegment(slug)}`),
    timeoutMs: call.options.timeouts.read,
    consequential: false,
  });
  return expectJson(response, toolkitSchema);
}

/**
 * Auth configs for this binding's toolkit. Only the ids the binding approved
 * are returned as usable; the rest are reported so a reviewer can see what
 * exists without any of it becoming executable.
 */
export async function listAuthConfigs(
  call: ComposioCall,
  input: DiscoverInput,
): Promise<DiscoverResult> {
  const response = await call.client.send({
    method: "GET",
    path: call.client.path("/auth_configs"),
    query: {
      ...cursorQuery(input),
      toolkit_slug: call.settings.toolkit.slug,
    },
    timeoutMs: call.options.timeouts.read,
    consequential: false,
  });
  const page = expectJson(response, authConfigListSchema);
  const issues: CompatibilityIssue[] = [];
  const items: DiscoveredItem[] = [];
  for (const config of page.items) {
    if (!composioAuthConfigIdSchema.safeParse(config.id).success) continue;
    const approved = call.settings.authConfigs.includes(config.id);
    const scheme = config.auth_scheme ?? "";
    if (approved && scheme && !composioHostedAuthSchemes.has(scheme))
      issues.push({
        code: "composio.auth-scheme.not-hosted",
        category: "security",
        sourcePointer: `/items/${config.id}/auth_scheme`,
        dimension: "authorize",
        disposition: "unsupported",
        severity: "blocking",
        executionImpact: "blocks-authorization",
        message:
          "This auth config uses a scheme whose connection requires submitting the user credential to Composio; this adapter only drives hosted authorization.",
        remediation:
          "Approve an OAuth auth config, or connect the account outside Ceremony and bind the existing connected account.",
      });
    items.push({
      identity: identity(call, `auth_config/${config.id}`, UNVERSIONED),
      displayName: config.name ?? config.id,
      description: `Auth config for ${config.toolkit?.slug ?? call.settings.toolkit.slug}.`,
      provenance: {
        kind: "auth-config",
        id: config.id,
        approved: approved ? "yes" : "no",
        ...(scheme ? { authScheme: scheme } : {}),
        ...(config.is_composio_managed === undefined
          ? {}
          : { composioManaged: String(config.is_composio_managed) }),
      },
      status:
        config.is_disabled === true || config.status === "DISABLED"
          ? "deprecated"
          : "active",
    });
  }
  issues.push(versionAbsent("auth config", "/items"));
  return {
    items,
    ...(page.next_cursor ? { nextCursor: page.next_cursor } : {}),
    freshness: {
      fetchedAt: call.ctx.environment.now(),
      stale: false,
      source: "live",
    },
    issues,
  };
}

/**
 * Connected accounts for the derived host user, this toolkit and the approved
 * auth configs. The Composio user id is never taken from a request, so this
 * listing can only ever be the caller's own accounts.
 */
export async function fetchConnectedAccounts(
  call: ComposioCall,
  options: { statuses?: string[]; cursor?: string; limit?: number } = {},
): Promise<{
  accounts: ComposioConnectedAccount[];
  nextCursor: string | undefined;
}> {
  const response = await call.client.send({
    method: "GET",
    path: call.client.path("/connected_accounts"),
    query: {
      limit: String(Math.min(Math.max(options.limit ?? LIST_LIMIT, 1), LIST_LIMIT)),
      ...(options.cursor ? { cursor: options.cursor } : {}),
      user_ids: [call.userId],
      toolkit_slugs: [call.settings.toolkit.slug],
      auth_config_ids: call.settings.authConfigs,
      ...(options.statuses?.length ? { statuses: options.statuses } : {}),
    },
    timeoutMs: call.options.timeouts.read,
    consequential: false,
  });
  const page = expectJson(response, connectedAccountListSchema);
  // The filters are sent, and the answers are checked: a broker that ignores a
  // filter must not hand this adapter another user's account by accident.
  const accounts = page.items.filter(
    (account) =>
      composioConnectedAccountIdSchema.safeParse(account.id).success &&
      account.user_id === call.userId &&
      account.toolkit.slug === call.settings.toolkit.slug &&
      call.settings.authConfigs.includes(account.auth_config.id),
  );
  return {
    accounts,
    nextCursor: page.next_cursor ?? undefined,
  };
}

export async function getConnectedAccount(
  call: ComposioCall,
  accountId: string,
): Promise<ComposioConnectedAccount> {
  if (!composioConnectedAccountIdSchema.safeParse(accountId).success)
    throw new ConnectorError("invalid-request", {
      detail: "composio.account.id-invalid",
    });
  const response = await call.client.send({
    method: "GET",
    path: call.client.path(
      `/connected_accounts/${encodePathSegment(accountId)}`,
    ),
    timeoutMs: call.options.timeouts.read,
    consequential: false,
  });
  const account = expectJson(response, connectedAccountSchema);
  if (
    account.user_id !== call.userId ||
    account.toolkit.slug !== call.settings.toolkit.slug ||
    !call.settings.authConfigs.includes(account.auth_config.id)
  )
    // The id resolved, but not to this owner's account under this binding.
    // Saying "denied" rather than returning it keeps one user's account id
    // from becoming a probe for another user's connection.
    throw new ConnectorError("denied", { detail: "composio.account.foreign" });
  return account;
}

export async function listConnectedAccounts(
  call: ComposioCall,
  input: DiscoverInput,
): Promise<DiscoverResult> {
  const { accounts, nextCursor } = await fetchConnectedAccounts(call, {
    ...(input.cursor ? { cursor: input.cursor } : {}),
    limit: limit(input),
  });
  const items: DiscoveredItem[] = accounts.map((account) => ({
    identity: identity(call, `connected_account/${account.id}`, UNVERSIONED),
    displayName: `${account.toolkit.slug} account ${account.id}`,
    description: `Connected account under auth config ${account.auth_config.id}.`,
    provenance: {
      kind: "connected-account",
      id: account.id,
      toolkit: account.toolkit.slug,
      authConfigId: account.auth_config.id,
      status: account.status,
    },
    status:
      account.status === "ACTIVE"
        ? "active"
        : account.status === "DELETED"
          ? "deleted"
          : "unknown",
  }));
  return {
    items,
    ...(nextCursor ? { nextCursor } : {}),
    freshness: {
      fetchedAt: call.ctx.environment.now(),
      stale: false,
      source: "live",
    },
    issues: [versionAbsent("connected account", "/items")],
  };
}

export async function fetchTools(
  call: ComposioCall,
  options: { cursor?: string; limit?: number; query?: string } = {},
): Promise<{ tools: ComposioTool[]; nextCursor: string | undefined }> {
  const response = await call.client.send({
    method: "GET",
    path: call.client.path("/tools"),
    query: {
      toolkit_slug: call.settings.toolkit.slug,
      limit: String(Math.min(Math.max(options.limit ?? LIST_LIMIT, 1), LIST_LIMIT)),
      ...(options.cursor ? { cursor: options.cursor } : {}),
      ...(options.query ? { query: options.query } : {}),
    },
    timeoutMs: call.options.timeouts.read,
    consequential: false,
  });
  const page = expectJson(response, toolListSchema);
  return {
    tools: page.items.filter(
      (tool) => composioToolSlugSchema.safeParse(tool.slug).success,
    ),
    nextCursor: page.next_cursor ?? undefined,
  };
}

/** One tool at one pinned version; the documented `version` query parameter. */
export async function fetchTool(
  call: ComposioCall,
  slug: string,
  version: string,
): Promise<ComposioTool> {
  const response = await call.client.send({
    method: "GET",
    path: call.client.path(`/tools/${encodePathSegment(slug)}`),
    query: { version },
    timeoutMs: call.options.timeouts.read,
    consequential: false,
  });
  return expectJson(response, toolSchema);
}

export async function listTools(
  call: ComposioCall,
  input: DiscoverInput,
): Promise<DiscoverResult> {
  const { tools, nextCursor } = await fetchTools(call, {
    ...(input.cursor ? { cursor: input.cursor } : {}),
    ...(input.query ? { query: input.query } : {}),
    limit: limit(input),
  });
  const issues: CompatibilityIssue[] = [];
  const items: DiscoveredItem[] = [];
  for (const tool of tools) {
    const version = tool.version ?? undefined;
    if (!version) issues.push(versionAbsent("tool", `/items/${tool.slug}`));
    items.push({
      identity: identity(
        call,
        `${call.settings.toolkit.slug}/${tool.slug}`,
        version ?? UNVERSIONED,
      ),
      displayName: tool.name ?? tool.slug,
      description: String(tool.description ?? "").slice(0, 500),
      provenance: {
        kind: "tool",
        slug: tool.slug,
        toolkit: call.settings.toolkit.slug,
        ...(tool.available_versions?.length
          ? { availableVersions: tool.available_versions.join(",") }
          : {}),
        ...(tool.no_auth === undefined ? {} : { noAuth: String(tool.no_auth) }),
      },
      status: tool.deprecated?.is_deprecated === true ? "deprecated" : "active",
    });
  }
  return {
    items,
    ...(nextCursor ? { nextCursor } : {}),
    freshness: {
      fetchedAt: call.ctx.environment.now(),
      stale: false,
      source: "live",
    },
    issues,
  };
}

/** Canonical digest of a tool's declared input schema; the review anchor. */
export async function toolSchemaDigest(tool: ComposioTool): Promise<string> {
  return canonicalDigest(tool.input_parameters ?? null);
}

export type NegativeCapabilityInput = {
  toolkit: ComposioToolkit;
  authConfig: ComposioAuthConfig | undefined;
  account: ComposioConnectedAccount | undefined;
  tools: ComposioTool[];
};

/**
 * What this toolkit advertises that the current account cannot do. It is the
 * honest half of a capability report: a grant is not proof of every advertised
 * capability, so every tool the binding approved is checked against the auth
 * config's scopes, the tool's deprecation and the account's status, and the
 * gaps are reported as blocking issues rather than discovered at call time.
 */
export function negativeCapabilities(
  call: ComposioCall,
  input: NegativeCapabilityInput,
): CompatibilityIssue[] {
  const issues: CompatibilityIssue[] = [];
  const granted = new Set(
    (input.authConfig?.restrict_to_following_tools ?? []).map((value) => value),
  );
  const scopes = new Set<string>();
  for (const detail of input.toolkit.auth_config_details ?? [])
    for (const scope of detail.required_scopes ?? []) scopes.add(scope);

  const scheme = input.authConfig?.auth_scheme ?? "";
  if (scheme && !composioHostedAuthSchemes.has(scheme))
    issues.push({
      code: "composio.auth-scheme.not-hosted",
      category: "security",
      sourcePointer: "/auth_config/auth_scheme",
      dimension: "authorize",
      disposition: "unsupported",
      severity: "blocking",
      executionImpact: "blocks-authorization",
      message:
        "The approved auth config is not an OAuth scheme; this adapter does not collect provider credentials on the user's behalf.",
    });

  if (input.account && input.account.status !== "ACTIVE")
    issues.push({
      code: "composio.account.not-active",
      category: "policy",
      sourcePointer: "/connected_account/status",
      dimension: "invoke",
      disposition: "requires-configuration",
      severity: "blocking",
      executionImpact: "blocks-operation",
      message:
        "The selected connected account is not ACTIVE; Composio executes tools only for an active account.",
      remediation: "Reconnect the account before invoking an approved tool.",
    });

  const catalog = new Map(input.tools.map((tool) => [tool.slug, tool]));
  for (const slug of call.settings.tools) {
    const tool = catalog.get(slug);
    if (!tool) {
      issues.push({
        code: "composio.tool.absent",
        category: "version",
        sourcePointer: `/tools/${slug}`,
        dimension: "invoke",
        disposition: "rejected",
        severity: "blocking",
        executionImpact: "blocks-operation",
        message:
          "An approved tool is not present in the toolkit's current catalogue; the approval names a tool this version no longer serves.",
      });
      continue;
    }
    if (tool.deprecated?.is_deprecated === true)
      issues.push({
        code: "composio.tool.deprecated",
        category: "version",
        sourcePointer: `/tools/${slug}/deprecated`,
        dimension: "invoke",
        disposition: "adapted",
        severity: "warning",
        executionImpact: "none",
        message:
          "Composio marks this approved tool deprecated; it still executes, and the binding should be reviewed.",
      });
    if (granted.size && !granted.has(slug))
      issues.push({
        code: "composio.tool.restricted",
        category: "policy",
        sourcePointer: `/auth_config/restrict_to_following_tools`,
        dimension: "invoke",
        disposition: "rejected",
        severity: "blocking",
        executionImpact: "blocks-operation",
        message:
          "The auth config restricts its connected accounts to a tool list that does not include this approved tool.",
      });
    const missing = (tool.scopes ?? []).filter(
      (scope) => scopes.size > 0 && !scopes.has(scope),
    );
    if (missing.length)
      issues.push({
        code: "composio.tool.scope-missing",
        category: "security",
        sourcePointer: `/tools/${slug}/scopes`,
        dimension: "invoke",
        disposition: "requires-configuration",
        severity: "blocking",
        executionImpact: "blocks-operation",
        message:
          "This tool declares scopes the approved auth config does not request; the account cannot be assumed to hold them.",
        remediation:
          "Add the scopes to the Composio auth config and reconnect, or remove the tool from the binding.",
      });
  }
  return issues;
}

/** Raw auth-config rows for this binding's toolkit; used by the capability report. */
export async function fetchAuthConfigs(
  call: ComposioCall,
): Promise<ComposioAuthConfig[]> {
  const response = await call.client.send({
    method: "GET",
    path: call.client.path("/auth_configs"),
    query: {
      limit: String(LIST_LIMIT),
      toolkit_slug: call.settings.toolkit.slug,
    },
    timeoutMs: call.options.timeouts.read,
    consequential: false,
  });
  return expectJson(response, authConfigListSchema).items.filter(
    (config) => composioAuthConfigIdSchema.safeParse(config.id).success,
  );
}
