import { z } from "zod";
import {
  capabilityStatus,
  type AdapterCallContext,
  type AuthorizationIntent,
  type AuthorizationStart,
  type CapabilityStatus,
  type CompletionInput,
  type CompletionResult,
  type ConnectorAdapter,
  type DiscoverInput,
  type DiscoverResult,
  type DisconnectResult,
  type DisconnectScope,
  type InvokeRequest,
  type InvokeResult,
} from "../../adapter.js";
import {
  boundOperation,
  destinationFor,
  type ApprovedDestination,
  type RuntimeBinding,
} from "../../binding.js";
import { ConnectorError } from "../../errors.js";
import type { CredentialScope } from "../../ports.js";
import {
  SUPABASE_HOSTED_MCP_ORIGIN,
  SUPABASE_HOSTED_MCP_PATH,
  SUPABASE_SERVICE,
  assertCredentialKind,
  boundedSignal,
  credentialScope,
  isPermittedTarget,
  makeClaim,
  parseSupabaseTarget,
  pinnedDestination,
  projectRefSchema,
  requireConnection,
  safeText,
  sha256Hex,
} from "./common.js";

/*
 * Supabase hosted MCP server profile (SB-02).
 *
 * Verified 2026-09-18 against https://supabase.com/docs/guides/ai-tools/mcp and
 * https://supabase.com/mcp: the hosted server is https://mcp.supabase.com/mcp and
 * accepts three URL query parameters: `project_ref=<id>` ("Scope to a specific
 * project (disables account tools)"), `read_only=true` ("Execute all queries as
 * a read-only Postgres user") and `features=<groups>` ("Enable only specific
 * tool groups (comma-separated)"). Feature groups: account, database,
 * debugging, development, docs, functions, branching, storage; all groups
 * except storage are enabled by default. Authentication is OAuth 2.1 with
 * dynamic client registration by default, or a manually registered OAuth app,
 * or a personal access token for CI.
 *
 * Those restrictions are binding settings reviewed by the host and validated
 * here; the URL is built from them and never from a caller. Protocol
 * execution is delegated to the MCP client through `McpClientPort`.
 */

export const SUPABASE_MCP_ADAPTER_ID = "supabase-mcp";
export const SUPABASE_MCP_SETTINGS_KEY = "supabase-mcp";
const ADAPTER_VERSION = "1.0.0";
const VERIFIER_VERSION = "supabase-mcp/1.0.0";

export const supabaseMcpFeatureGroups = [
  "account",
  "database",
  "debugging",
  "development",
  "docs",
  "functions",
  "branching",
  "storage",
] as const;
export type SupabaseMcpFeatureGroup = (typeof supabaseMcpFeatureGroups)[number];
/** Documented default: every group except storage. */
export const supabaseMcpDefaultFeatureGroups: readonly SupabaseMcpFeatureGroup[] =
  [
    "account",
    "database",
    "debugging",
    "development",
    "docs",
    "functions",
    "branching",
  ];

/** Tool names per group as published at https://supabase.com/mcp (available tools). */
export const supabaseMcpTools: Record<
  SupabaseMcpFeatureGroup,
  readonly string[]
> = {
  account: [
    "list_projects",
    "get_project",
    "create_project",
    "pause_project",
    "restore_project",
    "list_organizations",
    "get_organization",
    "get_cost",
    "confirm_cost",
  ],
  database: [
    "list_tables",
    "list_extensions",
    "list_migrations",
    "apply_migration",
    "execute_sql",
  ],
  debugging: ["query_logs", "get_advisors"],
  development: [
    "get_project_url",
    "get_publishable_keys",
    "generate_typescript_types",
  ],
  docs: ["search_docs"],
  functions: [
    "list_edge_functions",
    "get_edge_function",
    "deploy_edge_function",
  ],
  branching: [
    "create_branch",
    "list_branches",
    "delete_branch",
    "merge_branch",
    "reset_branch",
    "rebase_branch",
  ],
  storage: [
    "list_storage_buckets",
    "get_storage_config",
    "update_storage_config",
  ],
};

/** Tools whose purpose is a mutation; a read-only binding never invokes them, whatever the server advertises. */
export const supabaseMcpMutatingTools: ReadonlySet<string> = new Set([
  "apply_migration",
  "deploy_edge_function",
  "create_project",
  "pause_project",
  "restore_project",
  "confirm_cost",
  "create_branch",
  "delete_branch",
  "merge_branch",
  "reset_branch",
  "rebase_branch",
  "update_storage_config",
]);

export const supabaseMcpProtocolProfiles = [
  "mcp-2026-07-28",
  "mcp-2025-11-25",
] as const;
export type SupabaseMcpProtocolProfile =
  (typeof supabaseMcpProtocolProfiles)[number];
export const supabaseMcpAuthorizationModes = [
  "dynamic-client-registration",
  "oauth-app",
  "personal-access-token",
] as const;
export type SupabaseMcpAuthorizationMode =
  (typeof supabaseMcpAuthorizationModes)[number];

const unique = (values: readonly string[]) =>
  new Set(values).size === values.length;

export const supabaseHostedMcpSettingsSchema = z.strictObject({
  project_ref: projectRefSchema.optional(),
  read_only: z.boolean().default(false),
  features: z
    .array(z.enum(supabaseMcpFeatureGroups))
    .min(1)
    .max(supabaseMcpFeatureGroups.length)
    .refine(unique, "Feature groups repeat")
    .optional(),
  /** How the MCP client obtains a token; the hosted server documents dynamic client registration as the default. */
  authorization: z
    .enum(supabaseMcpAuthorizationModes)
    .default("dynamic-client-registration"),
  protocol: z.enum(supabaseMcpProtocolProfiles).default("mcp-2026-07-28"),
});
export type SupabaseHostedMcpSettings = z.output<
  typeof supabaseHostedMcpSettingsSchema
>;

/** Host policy fixed at registration; a binding cannot widen it. */
export type SupabaseHostedMcpPolicy = {
  allowedFeatures?: readonly SupabaseMcpFeatureGroup[];
  requireReadOnly?: boolean;
  requireProjectScope?: boolean;
  destinationId?: string;
};

export type ResolvedSupabaseHostedMcpBinding = {
  destination: ApprovedDestination;
  /** The exact server URL, built only from validated settings. */
  url: URL;
  /** Origin and path of the server; the resource the authorization profile binds tokens to. */
  resource: string;
  settings: SupabaseHostedMcpSettings;
  effectiveFeatures: readonly SupabaseMcpFeatureGroup[];
  enabledTools: ReadonlySet<string>;
};

export function resolveSupabaseHostedMcpBinding(
  binding: RuntimeBinding,
  policy: SupabaseHostedMcpPolicy = {},
): ResolvedSupabaseHostedMcpBinding {
  const destination = pinnedDestination(
    binding,
    policy.destinationId ?? "mcp",
    SUPABASE_HOSTED_MCP_ORIGIN,
    "supabase.mcp",
  );
  if (
    destination.pathPrefix !== undefined &&
    destination.pathPrefix !== SUPABASE_HOSTED_MCP_PATH
  )
    throw new ConnectorError("network-policy", {
      detail: "supabase.mcp.path-not-pinned",
    });
  const parsed = supabaseHostedMcpSettingsSchema.safeParse(
    binding.settings[SUPABASE_MCP_SETTINGS_KEY] ?? {},
  );
  if (!parsed.success)
    throw new ConnectorError("invalid-request", {
      detail: "supabase.mcp.settings-invalid",
    });
  const settings = parsed.data;
  const allowed = new Set(
    policy.allowedFeatures ?? supabaseMcpDefaultFeatureGroups,
  );
  const effectiveFeatures =
    settings.features ?? supabaseMcpDefaultFeatureGroups;
  for (const group of effectiveFeatures)
    if (!allowed.has(group))
      throw new ConnectorError("denied", {
        detail: "supabase.mcp.features-overbroad",
      });
  if (settings.project_ref && settings.features?.includes("account"))
    throw new ConnectorError("invalid-request", {
      detail: "supabase.mcp.account-with-project-scope",
    });
  if (policy.requireReadOnly && !settings.read_only)
    throw new ConnectorError("denied", {
      detail: "supabase.mcp.read-only-required",
    });
  if (policy.requireProjectScope && !settings.project_ref)
    throw new ConnectorError("denied", {
      detail: "supabase.mcp.project-scope-required",
    });
  if (
    settings.project_ref &&
    !isPermittedTarget(binding, {
      kind: "supabase-project",
      id: settings.project_ref,
    })
  )
    throw new ConnectorError("denied", {
      detail: "supabase.target.not-permitted",
    });
  const url = new URL(SUPABASE_HOSTED_MCP_PATH, destination.origin);
  if (settings.project_ref)
    url.searchParams.set("project_ref", settings.project_ref);
  if (settings.read_only) url.searchParams.set("read_only", "true");
  if (settings.features)
    url.searchParams.set("features", settings.features.join(","));
  const enabledTools = new Set<string>();
  for (const group of effectiveFeatures) {
    if (settings.project_ref && group === "account") continue;
    for (const tool of supabaseMcpTools[group])
      if (!(settings.read_only && supabaseMcpMutatingTools.has(tool)))
        enabledTools.add(tool);
  }
  for (const operation of binding.operations) {
    if (operation.transport.kind !== "mcp-tool")
      throw new ConnectorError("denied", {
        detail: "supabase.mcp.transport-mismatch",
      });
    const tool = operation.transport.toolName;
    if (!enabledTools.has(tool))
      throw new ConnectorError("denied", {
        detail:
          settings.read_only && supabaseMcpMutatingTools.has(tool)
            ? "supabase.mcp.read-only-binding"
            : settings.project_ref && supabaseMcpTools.account.includes(tool)
              ? "supabase.mcp.account-tool-project-scoped"
              : "supabase.mcp.tool-not-enabled",
      });
    if (supabaseMcpMutatingTools.has(tool) && operation.effect !== "write")
      throw new ConnectorError("denied", {
        detail: "supabase.binding.effect-misdeclared",
      });
    if (
      tool === "execute_sql" &&
      !settings.read_only &&
      operation.effect === "read"
    )
      throw new ConnectorError("denied", {
        detail: "supabase.binding.effect-misdeclared",
      });
  }
  return {
    destination,
    url,
    resource: `${destination.origin}${SUPABASE_HOSTED_MCP_PATH}`,
    settings,
    effectiveFeatures,
    enabledTools,
  };
}

/** A bearer the MCP client may use inside a callback; the token never appears in a result. */
export type McpBearerHandle = {
  kind: "bearer";
  use<T>(work: (accessToken: string) => Promise<T>): Promise<T>;
};

export type McpServerSession = {
  url: URL;
  resource: string;
  protocol: SupabaseMcpProtocolProfile;
  authorization: McpBearerHandle | { kind: "none" };
  fetch: typeof fetch;
  signal: AbortSignal;
};

export type McpToolDescriptor = {
  name: string;
  description?: string;
  inputSchema?: unknown;
  annotations?: unknown;
};

export type McpToolResult = {
  content: unknown;
  structuredContent?: unknown;
  isError?: boolean;
};

/** The MCP client the runtime supplies; it owns the wire protocol, this profile owns what may be asked of it. */
export interface McpClientPort {
  listTools(session: McpServerSession): Promise<{ tools: McpToolDescriptor[] }>;
  callTool(
    session: McpServerSession,
    call: { name: string; arguments: Record<string, unknown> },
  ): Promise<McpToolResult>;
}

/** The MCP authorization profile (pre-registration, documented DCR or CIMD) that obtains and stores the server token. */
export interface McpAuthorizationPort {
  begin(
    ctx: AdapterCallContext,
    request: {
      serverUrl: URL;
      resource: string;
      registration: SupabaseMcpAuthorizationMode;
      protocol: SupabaseMcpProtocolProfile;
      /** Credential kind the stored token must carry so this profile accepts it. */
      credentialKind: "hosted-mcp-access-token";
      intent: AuthorizationIntent;
    },
  ): Promise<AuthorizationStart>;
  complete(
    ctx: AdapterCallContext,
    input: CompletionInput,
    request: { serverUrl: URL; resource: string },
  ): Promise<CompletionResult>;
}

export type SupabaseHostedMcpProfileOptions = {
  client: McpClientPort;
  authorization?: McpAuthorizationPort;
  policy?: SupabaseHostedMcpPolicy;
  requestTimeoutMs?: number;
  evidenceTtlMs?: number;
};

export function createSupabaseHostedMcpProfile(
  options: SupabaseHostedMcpProfileOptions,
): ConnectorAdapter {
  const policy = options.policy ?? {};
  const requestTimeoutMs = options.requestTimeoutMs ?? 30_000;
  const evidenceTtlMs = options.evidenceTtlMs ?? 3_600_000;

  const bearer = (
    ctx: AdapterCallContext,
    scope: CredentialScope,
    credentialRef: string,
  ): McpBearerHandle => ({
    kind: "bearer",
    use: (work) =>
      ctx.environment.credentials.use(scope, credentialRef, (material) => {
        // A management token or a project session is another audience; it is never forwarded to the MCP server.
        assertCredentialKind(material, "hosted-mcp-access-token");
        const token = material.access_token;
        if (!token)
          throw new ConnectorError("expired", {
            detail: "supabase.mcp.credential-empty",
          });
        return work(token);
      }),
  });

  const session = (
    ctx: AdapterCallContext,
    resolved: ResolvedSupabaseHostedMcpBinding,
  ): McpServerSession => {
    const connection = ctx.connection;
    return {
      url: new URL(resolved.url.href),
      resource: resolved.resource,
      protocol: resolved.settings.protocol,
      authorization: connection?.credentialRef
        ? bearer(
            ctx,
            credentialScope(ctx, connection.connectionRef),
            connection.credentialRef,
          )
        : { kind: "none" },
      fetch: ctx.environment.fetch,
      signal: boundedSignal(ctx, requestTimeoutMs),
    };
  };

  const toolNames = (tools: McpToolDescriptor[]): string[] =>
    tools
      .slice(0, 256)
      .map((tool) => safeText(tool.name, 128))
      .filter(Boolean);

  const groupOf = (tool: string): SupabaseMcpFeatureGroup | undefined =>
    supabaseMcpFeatureGroups.find((group) =>
      supabaseMcpTools[group].includes(tool),
    );

  const adapter: ConnectorAdapter = {
    id: SUPABASE_MCP_ADAPTER_ID,
    ecosystem: "mcp",
    adapterVersion: ADAPTER_VERSION,
    runtime: "hosted-server",
    displayName: "Supabase hosted MCP server",
    description:
      "The hosted MCP server at mcp.supabase.com with host-approved project scope, read-only mode and feature groups. Protocol execution is delegated to the MCP client.",
    service: SUPABASE_SERVICE,
    support: "provider-backed",
    custody: ["host-owned"],
    configuration: [],
    profiles: [...supabaseMcpProtocolProfiles, "oauth-authorization-code"],
    capabilities(): CapabilityStatus[] {
      const row = (
        dimension: CapabilityStatus["dimension"],
        input: Partial<
          Pick<CapabilityStatus, "implementation" | "limitations" | "profile">
        > = {},
      ) =>
        capabilityStatus(adapter, {
          dimension,
          profile: input.profile ?? "mcp-2026-07-28",
          implementation: input.implementation ?? "implemented",
          configuration: "not-applicable",
          evidence:
            input.implementation === "unsupported"
              ? "not-tested"
              : "protocol-fixture",
          limitations: input.limitations ?? [],
        });
      const authorization = options.authorization
        ? {
            profile: "oauth-authorization-code",
            limitations: [
              "Token acquisition is delegated to the MCP authorization profile; dynamic client registration is the documented default",
            ],
          }
        : {
            implementation: "unsupported" as const,
            limitations: ["No MCP authorization profile registered"],
          };
      return [
        row("discover", {
          limitations: [
            "tools/list of the hosted server; advertisement is not access",
          ],
        }),
        row("import", { implementation: "unsupported" }),
        row("configure", {
          limitations: [
            "Project scope, read-only mode and feature groups are binding settings reviewed by the host",
          ],
        }),
        row("authorize", authorization),
        row("verify", {
          limitations: [
            "Verifies that the advertised tool set honours the approved restrictions; project access is observed on first read",
          ],
        }),
        row("invoke", {
          limitations: [
            "Approved tools only; a read-only binding never invokes a mutating tool",
          ],
        }),
        row("events", { implementation: "unsupported" }),
        row("reconnect", authorization),
        row("disconnect"),
        row("revoke", {
          implementation: "unsupported",
          limitations: [
            "Dynamically registered clients hold no secret for POST /v1/oauth/revoke; the user revokes the app in the Supabase dashboard",
          ],
        }),
        row("export", { implementation: "unsupported" }),
        row("delegate", { implementation: "unsupported" }),
      ];
    },
    async authorize(ctx, intent) {
      const resolved = resolveSupabaseHostedMcpBinding(ctx.binding, policy);
      if (intent.ownerKind !== "user")
        return { kind: "unsupported", code: "supabase.owner-kind.unsupported" };
      if (
        intent.target &&
        (!resolved.settings.project_ref ||
          !(
            intent.target.kind === "supabase-project" &&
            intent.target.id === resolved.settings.project_ref
          ))
      )
        throw new ConnectorError("denied", {
          detail: "supabase.target.not-permitted",
        });
      if (!options.authorization)
        return {
          kind: "unsupported",
          code: "supabase.mcp.authorization-port-missing",
        };
      return options.authorization.begin(ctx, {
        serverUrl: new URL(resolved.url.href),
        resource: resolved.resource,
        registration: resolved.settings.authorization,
        protocol: resolved.settings.protocol,
        credentialKind: "hosted-mcp-access-token",
        intent,
      });
    },
    async reconnect(ctx, intent) {
      const connection = requireConnection(ctx);
      await ctx.environment.handoffs.cancelAll(
        connection.connectionRef,
        "supabase.mcp.reconnect",
      );
      return adapter.authorize!(ctx, intent);
    },
    async complete(ctx, input) {
      const resolved = resolveSupabaseHostedMcpBinding(ctx.binding, policy);
      if (!options.authorization)
        throw new ConnectorError("unsupported", {
          detail: "supabase.mcp.authorization-port-missing",
        });
      const result = await options.authorization.complete(ctx, input, {
        serverUrl: new URL(resolved.url.href),
        resource: resolved.resource,
      });
      if (result.state !== "complete") return result;
      return {
        ...result,
        ...(resolved.settings.project_ref
          ? {
              target: {
                kind: "supabase-project",
                id: resolved.settings.project_ref,
              },
            }
          : {}),
        adapterState: {
          ...(result.adapterState ?? {}),
          serverUrl: resolved.url.href,
          readOnly: resolved.settings.read_only,
          features: [...resolved.effectiveFeatures],
          authorization: resolved.settings.authorization,
          protocol: resolved.settings.protocol,
        },
      };
    },
    async verify(ctx) {
      const resolved = resolveSupabaseHostedMcpBinding(ctx.binding, policy);
      requireConnection(ctx);
      const listed = await options.client.listTools(session(ctx, resolved));
      const advertised = toolNames(listed.tools);
      const violations: string[] = [];
      if (resolved.settings.read_only)
        for (const tool of advertised)
          if (supabaseMcpMutatingTools.has(tool))
            violations.push(`read_only not honoured: ${tool} advertised`);
      if (resolved.settings.project_ref)
        for (const tool of advertised)
          if (supabaseMcpTools.account.includes(tool))
            violations.push(`project_ref not honoured: ${tool} advertised`);
      if (violations.length)
        return {
          state: "denied",
          claims: [],
          code: "supabase.mcp.configuration-not-honoured",
        };
      const approved = ctx.binding.operations
        .map((operation) =>
          operation.transport.kind === "mcp-tool"
            ? operation.transport.toolName
            : "",
        )
        .filter(Boolean);
      const missing = approved.filter((tool) => !advertised.includes(tool));
      // The server accepted the token and answered tools/list. That is what was
      // observed: the advertised tool set is *reported*, and using a tool is
      // the only thing that would observe a permission, so this is never a
      // permission-observed claim.
      const claim = makeClaim(ctx, {
        kind: "credential-accepted",
        target: { kind: "supabase-mcp-server", id: resolved.url.host },
        verifierVersion: VERIFIER_VERSION,
        validForMs: evidenceTtlMs,
        permissions: {
          requested: approved.slice(0, 64),
          reported: advertised.slice(0, 64),
          observed: [],
          semantics: "operations",
        },
        limitations: [
          "tools/list proves what the server advertises for this token, not access to project data",
          ...(resolved.settings.project_ref
            ? [`Scoped to project ${resolved.settings.project_ref}`]
            : ["Not project scoped: account tools may be advertised"]),
          ...(resolved.settings.read_only
            ? ["read_only=true: queries run as a read-only Postgres user"]
            : []),
          ...missing.map((tool) => `Approved tool not advertised: ${tool}`),
        ].slice(0, 16),
      });
      return {
        state: "complete",
        claims: [claim],
        ...(resolved.settings.project_ref
          ? {
              target: {
                kind: "supabase-project",
                id: resolved.settings.project_ref,
              },
            }
          : {}),
        ...(missing.length
          ? { code: "supabase.mcp.approved-tool-missing" }
          : {}),
      };
    },
    async discover(ctx, _input: DiscoverInput): Promise<DiscoverResult> {
      const resolved = resolveSupabaseHostedMcpBinding(ctx.binding, policy);
      const listed = await options.client.listTools(session(ctx, resolved));
      return {
        items: listed.tools.slice(0, 256).flatMap((tool) => {
          const name = safeText(tool.name, 128);
          if (!name) return [];
          return [
            {
              identity: {
                ecosystem: "mcp",
                authorityNamespace: resolved.url.host,
                nativeId: name,
                nativeVersion: resolved.settings.protocol,
              },
              displayName: name,
              description: safeText(tool.description, 500),
              provenance: {
                group: groupOf(name) ?? "unknown",
                enabled: String(resolved.enabledTools.has(name)),
                mutating: String(supabaseMcpMutatingTools.has(name)),
              },
              status: "active" as const,
            },
          ];
        }),
        freshness: {
          fetchedAt: ctx.environment.now(),
          stale: false,
          source: "live",
        },
        issues: [],
      };
    },
    async invoke(ctx, request: InvokeRequest): Promise<InvokeResult> {
      const resolved = resolveSupabaseHostedMcpBinding(ctx.binding, policy);
      const operation = boundOperation(ctx.binding, request.operationRef);
      if (!operation)
        throw new ConnectorError("not-found", {
          detail: "supabase.operation.unknown",
        });
      if (destinationFor(ctx.binding, operation).id !== resolved.destination.id)
        throw new ConnectorError("network-policy", {
          detail: "supabase.mcp.destination-not-pinned",
        });
      if (operation.transport.kind !== "mcp-tool")
        throw new ConnectorError("denied", {
          detail: "supabase.mcp.transport-mismatch",
        });
      const tool = operation.transport.toolName;
      if (!resolved.enabledTools.has(tool))
        throw new ConnectorError("denied", {
          detail: "supabase.mcp.tool-not-enabled",
        });
      if (resolved.settings.read_only && supabaseMcpMutatingTools.has(tool))
        throw new ConnectorError("denied", {
          detail: "supabase.mcp.read-only-binding",
        });
      const connection = requireConnection(ctx);
      const parsedArguments = z
        .record(z.string().max(120), z.unknown())
        .refine((value) => Object.keys(value).length <= 64)
        .parse(request.input ?? {});
      const args: Record<string, unknown> = {};
      for (const [key, value] of Object.entries(parsedArguments))
        if (!["__proto__", "constructor", "prototype"].includes(key))
          args[key] = value;
      const projectArgument = args.project_id;
      if (resolved.settings.project_ref) {
        // The server omits project_id from tool schemas when scoped; a different project is refused, the same one is redundant.
        if (
          projectArgument !== undefined &&
          projectArgument !== resolved.settings.project_ref
        )
          throw new ConnectorError("denied", {
            detail: "supabase.target.out-of-scope",
          });
        delete args.project_id;
      } else if (groupOf(tool) !== "account" && groupOf(tool) !== "docs") {
        const parsedRef = projectRefSchema.safeParse(projectArgument);
        if (!parsedRef.success)
          throw new ConnectorError("denied", {
            detail: "supabase.target.required",
          });
        const target = { kind: "supabase-project", id: parsedRef.data };
        const connectionTarget = parseSupabaseTarget(connection.target);
        if (
          !isPermittedTarget(ctx.binding, target) ||
          (connectionTarget && connectionTarget.id !== parsedRef.data)
        )
          throw new ConnectorError("denied", {
            detail: "supabase.target.out-of-scope",
          });
      }
      const mutating = operation.effect !== "read";
      const digest = sha256Hex(
        JSON.stringify([
          request.operationRef,
          tool,
          request.commandId,
          Object.entries(args).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
        ]),
      );
      const effect = mutating
        ? await ctx.environment.effects.begin({
            actor: ctx.actor,
            connectionRef: connection.connectionRef,
            bindingRef: ctx.binding.bindingRef,
            operation: request.operationRef,
            digest,
            commandId: request.commandId,
          })
        : undefined;
      if (effect?.prior)
        return {
          state:
            effect.prior.status === "applied"
              ? "indeterminate"
              : "indeterminate",
          outputClassification: operation.outputClassification,
          effect: operation.effect,
          code: "supabase.mcp.effect-already-attempted",
          effectRef: effect.effectRef,
        };
      let result: McpToolResult;
      try {
        result = await options.client.callTool(session(ctx, resolved), {
          name: tool,
          arguments: args,
        });
      } catch (cause) {
        if (effect)
          await ctx.environment.effects.complete(effect.effectRef, {
            status: "indeterminate",
            at: ctx.environment.now(),
          });
        if (cause instanceof ConnectorError) throw cause;
        throw new ConnectorError(
          mutating ? "indeterminate" : "upstream-unavailable",
          {
            detail: "supabase.mcp.call-failed",
            cause,
          },
        );
      }
      if (effect)
        await ctx.environment.effects.complete(effect.effectRef, {
          status: result.isError ? "failed" : "applied",
          at: ctx.environment.now(),
        });
      if (result.isError)
        return {
          state: "failed",
          outputClassification: operation.outputClassification,
          effect: operation.effect,
          code: "supabase.mcp.tool-error",
          ...(effect ? { effectRef: effect.effectRef } : {}),
        };
      return {
        state: "complete",
        output: {
          content: result.content,
          ...(result.structuredContent !== undefined
            ? { structuredContent: result.structuredContent }
            : {}),
        },
        outputClassification: operation.outputClassification,
        effect: operation.effect,
        ...(effect ? { effectRef: effect.effectRef } : {}),
      };
    },
    async disconnect(ctx, scope: DisconnectScope): Promise<DisconnectResult> {
      if (scope === "broker")
        return {
          local: "not-attempted",
          broker: "unsupported",
          upstream: "not-attempted",
        };
      const connection = requireConnection(ctx);
      await ctx.environment.handoffs.cancelAll(
        connection.connectionRef,
        "supabase.mcp.disconnect",
      );
      if (connection.credentialRef)
        await ctx.environment.credentials.revoke(
          credentialScope(ctx, connection.connectionRef),
          connection.credentialRef,
        );
      return {
        local: "applied",
        broker: "not-attempted",
        upstream: scope === "upstream" ? "unsupported" : "not-attempted",
      };
    },
    async revoke(ctx) {
      return adapter.disconnect!(ctx, "upstream");
    },
  };
  return adapter;
}
