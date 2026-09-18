import { decodeJwt } from "jose";
import { z } from "zod";
import type { ActorContext } from "../../../../core/operation-contracts.js";
import {
  capabilityStatus,
  type AdapterCallContext,
  type CapabilityStatus,
  type ConfigurationRequirement,
  type ConnectorAdapter,
  type DisconnectResult,
  type InvokeResult,
  type VerificationClaim,
} from "../../adapter.js";
import {
  boundOperation,
  destinationFor,
  destinationUrl,
  type ApprovedDestination,
  type RuntimeBinding,
} from "../../binding.js";
import { ConnectorError } from "../../errors.js";
import {
  SUPABASE_ECOSYSTEM,
  SUPABASE_PROJECT_HOST_SUFFIX,
  SUPABASE_SERVICE,
  boundedSignal,
  discardBody,
  isPermittedTarget,
  makeClaim,
  parseSupabaseTarget,
  projectRefSchema,
  readBoundedJson,
  requireConnection,
  safeText,
  sqlIdentifierSchema,
  supabaseCredentialKinds,
  type SupabaseCredentialKind,
} from "./common.js";

/*
 * Supabase project Data API (SB-03).
 *
 * The project user's authentication stays where it is: the existing
 * `supabaseAuth` seam and `AsyncSupabaseChildren` recipe obtain and verify the
 * session. This adapter only *uses* that session, through `ProjectSessionPort`,
 * for host-approved PostgREST reads: `GET /rest/v1/<table>?select=...` with
 * `apikey: <publishable key>` and `Authorization: Bearer <user access token>`
 * (verified against https://supabase.com/docs/guides/api/api-keys and the
 * PostgREST v13 reference for select, filters, order, limit and offset).
 *
 * Credential kinds never mix: a service-role secret, a management token or a
 * personal access token presented as the session or as the publishable key is
 * refused before any request is built, by kind metadata and key format, never
 * by echoing a value.
 */

export const SUPABASE_DATA_API_ADAPTER_ID = "supabase-data-api";
export const SUPABASE_DATA_API_SETTINGS_KEY = "supabase-data-api";
export const SUPABASE_URL = "SUPABASE_URL";
export const SUPABASE_PUBLISHABLE_KEY = "SUPABASE_PUBLISHABLE_KEY";
export const SUPABASE_ANON_KEY = "SUPABASE_ANON_KEY";
const ADAPTER_VERSION = "1.0.0";
const VERIFIER_VERSION = "supabase-data-api/1.0.0";
const PROFILE = "postgrest-select-v1";
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;

export const postgrestFilterOperators = [
  "eq",
  "neq",
  "gt",
  "gte",
  "lt",
  "lte",
  "like",
  "ilike",
  "is",
  "in",
] as const;
export type PostgrestFilterOperator = (typeof postgrestFilterOperators)[number];

const tablePolicySchema = z.strictObject({
  columns: z.array(sqlIdentifierSchema).min(1).max(64),
  filters: z
    .record(sqlIdentifierSchema, z.array(z.enum(postgrestFilterOperators)).min(1).max(12))
    .default({}),
  orderBy: z.array(sqlIdentifierSchema).max(16).optional(),
  maxRows: z.number().int().min(1).max(1000).default(100),
  /** Host review outcome for the table's Row Level Security policies; "unverified" is reported on every result. */
  rowLevelSecurity: z.enum(["verified", "unverified"]).default("unverified"),
});
export type SupabaseTablePolicy = z.output<typeof tablePolicySchema>;

export const supabaseDataApiSettingsSchema = z.strictObject({
  projectRef: projectRefSchema,
  /** Only the default exposed schema; other schemas would need Accept-Profile and separate review. */
  schema: z.literal("public").default("public"),
  tables: z
    .record(sqlIdentifierSchema, tablePolicySchema)
    .refine((value) => Object.keys(value).length <= 64),
});
export type SupabaseDataApiSettings = z.output<
  typeof supabaseDataApiSettingsSchema
>;

const noControl = /^[^\p{Cc}]*$/u;
const scalarSchema = z.union([
  z.string().max(512).regex(noControl),
  z.number().finite(),
  z.boolean(),
]);
const filterSchema = z.strictObject({
  column: sqlIdentifierSchema,
  operator: z.enum(postgrestFilterOperators),
  value: z.union([scalarSchema, z.null(), z.array(scalarSchema).min(1).max(100)]),
});
export const supabaseSelectInputSchema = z.strictObject({
  table: sqlIdentifierSchema,
  select: z.array(sqlIdentifierSchema).min(1).max(64).optional(),
  filters: z.array(filterSchema).max(16).default([]),
  order: z
    .strictObject({
      column: sqlIdentifierSchema,
      direction: z.enum(["asc", "desc"]).default("asc"),
    })
    .optional(),
  limit: z.number().int().min(1).max(1000).optional(),
  offset: z.number().int().min(0).max(1_000_000).default(0),
});
export type SupabaseSelectInput = z.input<typeof supabaseSelectInputSchema>;

/** A project user's verified session, resolved by the host from the existing project sign-in ceremony. */
export type ProjectSessionHandle = {
  kind: SupabaseCredentialKind | string;
  projectRef: string;
  userId: string;
  /** Milliseconds since epoch. */
  expiresAt: number;
  assurance?: "aal1" | "aal2";
  /** Runs work with the access token; the token never appears in a result. */
  use<T>(work: (accessToken: string) => Promise<T>): Promise<T>;
};

export interface ProjectSessionPort {
  resolve(input: {
    actor: ActorContext;
    connectionRef: string;
    projectRef: string;
    signal: AbortSignal;
  }): Promise<ProjectSessionHandle | undefined>;
}

/** Classifies a configured key by its documented format; the value itself is never logged or returned. */
export function classifyProjectKey(
  value: string,
): "publishable-key" | "service-role-secret" | "unknown" {
  if (/^sb_publishable_[A-Za-z0-9_-]+$/.test(value)) return "publishable-key";
  if (/^sb_secret_[A-Za-z0-9_-]+$/.test(value)) return "service-role-secret";
  try {
    const role = decodeJwt(value).role;
    if (role === "anon") return "publishable-key";
    if (role === "service_role") return "service-role-secret";
  } catch {
    // Not a JWT either.
  }
  return "unknown";
}

export type SupabaseDataApiOptions = {
  sessions: ProjectSessionPort;
  requestTimeoutMs?: number;
  evidenceTtlMs?: number;
};

const quote = (value: string) =>
  `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;

/** Builds the PostgREST filter value for one operator; the syntax is the documented `operator.value` form. */
export function postgrestFilterValue(
  filter: z.output<typeof filterSchema>,
): string {
  const { operator, value } = filter;
  if (operator === "is") {
    if (value === null) return "is.null";
    if (typeof value === "boolean") return `is.${value}`;
    throw new ConnectorError("invalid-request", {
      detail: "supabase.data-api.filter-value",
    });
  }
  if (operator === "in") {
    if (!Array.isArray(value))
      throw new ConnectorError("invalid-request", {
        detail: "supabase.data-api.filter-value",
      });
    return `in.(${value
      .map((item) => (typeof item === "string" ? quote(item) : String(item)))
      .join(",")})`;
  }
  if (value === null || Array.isArray(value))
    throw new ConnectorError("invalid-request", {
      detail: "supabase.data-api.filter-value",
    });
  if ((operator === "like" || operator === "ilike") && typeof value !== "string")
    throw new ConnectorError("invalid-request", {
      detail: "supabase.data-api.filter-value",
    });
  return `${operator}.${String(value)}`;
}

export function createSupabaseDataApiAdapter(
  options: SupabaseDataApiOptions,
): ConnectorAdapter {
  const requestTimeoutMs = options.requestTimeoutMs ?? 15_000;
  const evidenceTtlMs = options.evidenceTtlMs ?? 3_600_000;
  const configuration: ConfigurationRequirement[] = [
    {
      name: SUPABASE_URL,
      source: "session-environment",
      classification: "public",
      required: false,
      description:
        "Project URL of the existing project sign-in; the binding destination is authoritative",
    },
    {
      name: SUPABASE_PUBLISHABLE_KEY,
      source: "session-environment",
      classification: "public",
      required: false,
      description: "Publishable key sent as apikey; secret keys are refused",
    },
    {
      name: SUPABASE_ANON_KEY,
      source: "session-environment",
      classification: "public",
      required: false,
      description: "Legacy anon key accepted in place of the publishable key",
    },
  ];

  const settingsOf = (binding: RuntimeBinding): SupabaseDataApiSettings => {
    const parsed = supabaseDataApiSettingsSchema.safeParse(
      binding.settings[SUPABASE_DATA_API_SETTINGS_KEY],
    );
    if (!parsed.success)
      throw new ConnectorError("invalid-request", {
        detail: "supabase.data-api.settings-invalid",
      });
    return parsed.data;
  };

  /** The project origin is pinned to `https://<ref>.supabase.co` unless the binding names a loopback fixture. */
  const projectDestination = (
    binding: RuntimeBinding,
    settings: SupabaseDataApiSettings,
  ): ApprovedDestination => {
    const destination = binding.destinations.find(
      (item) => item.id === "project",
    );
    if (!destination)
      throw new ConnectorError("network-policy", {
        detail: "supabase.data-api.destination-missing",
      });
    const url = new URL(destination.origin);
    const loopback =
      destination.network === "loopback-fixture" &&
      url.protocol === "http:" &&
      ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname);
    if (
      !loopback &&
      destination.origin !==
        `https://${settings.projectRef}${SUPABASE_PROJECT_HOST_SUFFIX}`
    )
      throw new ConnectorError("network-policy", {
        detail: "supabase.data-api.destination-not-pinned",
      });
    return destination;
  };

  const publishableKey = async (ctx: AdapterCallContext): Promise<string> => {
    const value =
      (await ctx.environment.configuration.read(SUPABASE_PUBLISHABLE_KEY)) ??
      (await ctx.environment.configuration.read(SUPABASE_ANON_KEY));
    if (!value)
      throw new ConnectorError("configuration-required", {
        detail: "supabase.data-api.publishable-key-missing",
      });
    if (value.length > 4096 || classifyProjectKey(value) !== "publishable-key")
      // A secret or service-role key never reaches a browser-facing profile.
      throw new ConnectorError("denied", {
        detail: "supabase.credential.kind-confusion",
      });
    return value;
  };

  const resolveSession = async (
    ctx: AdapterCallContext,
    settings: SupabaseDataApiSettings,
  ): Promise<ProjectSessionHandle> => {
    const connection = requireConnection(ctx);
    const target = parseSupabaseTarget(connection.target);
    if (
      !target ||
      target.kind !== "supabase-project" ||
      target.id !== settings.projectRef
    )
      throw new ConnectorError("denied", {
        detail: "supabase.project.mismatch",
      });
    const session = await options.sessions.resolve({
      actor: ctx.actor,
      connectionRef: connection.connectionRef,
      projectRef: settings.projectRef,
      signal: ctx.signal,
    });
    if (!session)
      throw new ConnectorError("human-required", {
        detail: "supabase.project-session.required",
      });
    if (
      !(supabaseCredentialKinds as readonly string[]).includes(session.kind) ||
      session.kind !== "project-user-session"
    )
      throw new ConnectorError("denied", {
        detail: "supabase.credential.kind-confusion",
      });
    if (session.projectRef !== settings.projectRef)
      throw new ConnectorError("denied", {
        detail: "supabase.project.mismatch",
      });
    if (session.expiresAt <= ctx.environment.now())
      throw new ConnectorError("expired", {
        detail: "supabase.project-session.expired",
      });
    return session;
  };

  const pgrstCode = async (response: Response): Promise<string | undefined> => {
    try {
      const body = await readBoundedJson(response, 16 * 1024, "supabase.data-api");
      const code = z
        .object({ code: z.string().regex(/^[A-Za-z0-9]{3,10}$/) })
        .safeParse(body);
      return code.success ? code.data.code.toLowerCase() : undefined;
    } catch {
      return undefined;
    }
  };

  const failure = async (response: Response): Promise<ConnectorError> => {
    const code = await pgrstCode(response);
    const detail = code ? `supabase.data-api.${code}` : undefined;
    const withDetail = (fallback: string) => ({ detail: detail ?? fallback });
    if (response.status === 401)
      return new ConnectorError("expired", withDetail("supabase.data-api.token-rejected"));
    if (response.status === 403)
      return new ConnectorError("denied", withDetail("supabase.data-api.forbidden"));
    if (response.status === 404)
      return new ConnectorError("not-found", withDetail("supabase.data-api.not-exposed"));
    if (response.status === 429)
      return new ConnectorError("rate-limited", withDetail("supabase.data-api.rate-limited"));
    if (response.status >= 500)
      return new ConnectorError("upstream-unavailable", withDetail("supabase.data-api.unavailable"));
    return new ConnectorError("upstream-rejected", withDetail("supabase.data-api.rejected"));
  };

  const adapter: ConnectorAdapter = {
    id: SUPABASE_DATA_API_ADAPTER_ID,
    ecosystem: SUPABASE_ECOSYSTEM,
    adapterVersion: ADAPTER_VERSION,
    runtime: "hosted-server",
    displayName: "Supabase project Data API",
    description:
      "Host-approved PostgREST reads on a project, executed as the signed-in project user with the publishable key. Separate from Management OAuth and from service-role access.",
    service: SUPABASE_SERVICE,
    support: "provider-backed",
    custody: ["host-owned"],
    configuration,
    profiles: [PROFILE, "http-bearer"],
    capabilities(present): CapabilityStatus[] {
      const ready =
        present.has(SUPABASE_PUBLISHABLE_KEY) || present.has(SUPABASE_ANON_KEY)
          ? "ready"
          : "missing";
      const row = (
        dimension: CapabilityStatus["dimension"],
        input: Partial<
          Pick<CapabilityStatus, "implementation" | "configuration" | "limitations">
        > = {},
      ) =>
        capabilityStatus(adapter, {
          dimension,
          profile: PROFILE,
          implementation: input.implementation ?? "implemented",
          configuration:
            input.configuration ??
            (input.implementation === "unsupported" ? "not-applicable" : ready),
          evidence:
            input.implementation === "unsupported" ? "not-tested" : "protocol-fixture",
          limitations: input.limitations ?? [],
        });
      return [
        row("discover", { implementation: "unsupported" }),
        row("import", { implementation: "unsupported" }),
        row("configure", {
          limitations: ["Approved tables, columns and filters are binding settings reviewed by the host"],
        }),
        row("authorize", {
          limitations: [
            "Project user sign-in is the existing Supabase ceremony; this profile only consumes its verified session",
          ],
        }),
        row("verify", {
          limitations: ["Identity is the project user (GET /auth/v1/user), never a dashboard account"],
        }),
        row("invoke", {
          limitations: [
            "Bounded GET /rest/v1/<table> selects on approved tables in the public schema; tables whose Row Level Security review is unverified are flagged on every result",
          ],
        }),
        row("events", { implementation: "unsupported" }),
        row("reconnect", {
          limitations: ["An expired session requires a fresh project sign-in through the existing ceremony"],
        }),
        row("disconnect"),
        row("revoke", {
          implementation: "unsupported",
          limitations: [
            "The session belongs to the project sign-in ceremony; sign out there (POST /auth/v1/logout) rather than through this profile",
          ],
        }),
        row("export", { implementation: "unsupported" }),
        row("delegate", { implementation: "unsupported" }),
      ];
    },
    async authorize(ctx, intent) {
      const settings = settingsOf(ctx.binding);
      if (intent.ownerKind !== "user")
        return { kind: "unsupported", code: "supabase.owner-kind.unsupported" };
      const target = { kind: "supabase-project", id: settings.projectRef };
      if (
        (intent.target &&
          !(intent.target.kind === target.kind && intent.target.id === target.id)) ||
        !isPermittedTarget(ctx.binding, target)
      )
        throw new ConnectorError("denied", { detail: "supabase.target.not-permitted" });
      projectDestination(ctx.binding, settings);
      const present = await ctx.environment.configuration.present([
        SUPABASE_PUBLISHABLE_KEY,
        SUPABASE_ANON_KEY,
      ]);
      if (!present.size)
        return { kind: "configuration-required", missing: [SUPABASE_PUBLISHABLE_KEY] };
      if (!ctx.connection) return { kind: "verify" };
      const session = await options.sessions.resolve({
        actor: ctx.actor,
        connectionRef: ctx.connection.connectionRef,
        projectRef: settings.projectRef,
        signal: ctx.signal,
      });
      if (!session || session.expiresAt <= ctx.environment.now())
        return { kind: "human-required", code: "supabase.project-session.required" };
      return { kind: "verify" };
    },
    async reconnect(ctx, intent) {
      return adapter.authorize!(ctx, intent);
    },
    async verify(ctx) {
      const settings = settingsOf(ctx.binding);
      const destination = projectDestination(ctx.binding, settings);
      const key = await publishableKey(ctx);
      let session: ProjectSessionHandle;
      try {
        session = await resolveSession(ctx, settings);
      } catch (error) {
        if (error instanceof ConnectorError && error.code === "expired")
          return { state: "expired", claims: [], code: "supabase.project-session.expired" };
        if (error instanceof ConnectorError && error.code === "human-required")
          return { state: "human-required", claims: [], code: "supabase.project-session.required" };
        throw error;
      }
      const userId = await session.use(async (token) => {
        let response: Response;
        try {
          response = await ctx.environment.fetch(destinationUrl(destination, "/auth/v1/user"), {
            method: "GET",
            headers: { apikey: key, authorization: `Bearer ${token}`, accept: "application/json" },
            redirect: "error",
            signal: boundedSignal(ctx, requestTimeoutMs),
          });
        } catch (cause) {
          throw new ConnectorError("upstream-unavailable", {
            detail: "supabase.data-api.unreachable",
            cause,
          });
        }
        if (response.status !== 200) {
          await discardBody(response);
          throw response.status === 401
            ? new ConnectorError("expired", { detail: "supabase.project-session.rejected" })
            : await failure(response);
        }
        const user = z
          .object({ id: z.string().min(1).max(128) })
          .safeParse(await readBoundedJson(response, 64 * 1024, "supabase.data-api"));
        if (!user.success)
          throw new ConnectorError("upstream-rejected", { detail: "supabase.data-api.user-shape" });
        return user.data.id;
      }).catch((error: unknown) => {
        if (error instanceof ConnectorError && error.code === "expired") return undefined;
        throw error;
      });
      if (userId === undefined)
        return { state: "expired", claims: [], code: "supabase.project-session.rejected" };
      if (userId !== session.userId)
        return { state: "denied", claims: [], code: "supabase.project-session.user-mismatch" };
      const unverified = Object.entries(settings.tables)
        .filter(([, policy]) => policy.rowLevelSecurity === "unverified")
        .map(([table]) => table);
      const claims: VerificationClaim[] = [
        makeClaim(ctx, {
          kind: "account-identity",
          target: { kind: "supabase-project-user", id: userId },
          verifierVersion: VERIFIER_VERSION,
          validForMs: Math.max(1, Math.min(evidenceTtlMs, session.expiresAt - ctx.environment.now())),
          limitations: [
            "A project user of this project; not a Supabase dashboard account and not Management API access",
            ...(session.assurance ? [`Assurance ${session.assurance}`] : []),
          ],
        }),
        makeClaim(ctx, {
          kind: "resource-access",
          target: { kind: "supabase-project", id: settings.projectRef },
          verifierVersion: VERIFIER_VERSION,
          validForMs: Math.max(1, Math.min(evidenceTtlMs, session.expiresAt - ctx.environment.now())),
          permissions: {
            requested: Object.keys(settings.tables).slice(0, 64),
            reported: [],
            observed: [],
            semantics: "operations",
          },
          limitations: [
            "Reads are bounded by Row Level Security for the authenticated role; the adapter cannot widen them",
            ...unverified.map((table) => `Row Level Security review unverified for table ${table}`),
          ].slice(0, 16),
        }),
      ];
      return {
        state: "complete",
        claims,
        target: { kind: "supabase-project", id: settings.projectRef },
        externalIds: { projectUserId: userId, projectRef: settings.projectRef },
      };
    },
    async invoke(ctx, request): Promise<InvokeResult> {
      const settings = settingsOf(ctx.binding);
      const operation = boundOperation(ctx.binding, request.operationRef);
      if (!operation)
        throw new ConnectorError("not-found", { detail: "supabase.operation.unknown" });
      if (
        operation.transport.kind !== "http" ||
        operation.transport.method !== "GET" ||
        operation.transport.pathTemplate !== "/rest/v1/{table}"
      )
        throw new ConnectorError("denied", { detail: "supabase.binding.transport-mismatch" });
      if (operation.effect !== "read")
        throw new ConnectorError("denied", { detail: "supabase.binding.effect-mismatch" });
      if (operation.outputClassification === "public")
        throw new ConnectorError("denied", { detail: "supabase.binding.classification-too-low" });
      if (!operation.targetParameters.includes("table"))
        throw new ConnectorError("denied", { detail: "supabase.binding.target-parameter-undeclared" });
      const destination = projectDestination(ctx.binding, settings);
      if (destinationFor(ctx.binding, operation).id !== destination.id)
        throw new ConnectorError("network-policy", { detail: "supabase.data-api.destination-not-pinned" });
      const input = supabaseSelectInputSchema.parse(request.input ?? {});
      const policy = Object.hasOwn(settings.tables, input.table)
        ? settings.tables[input.table]
        : undefined;
      if (!policy || !isPermittedTarget(ctx.binding, { kind: "supabase-table", id: input.table }))
        throw new ConnectorError("denied", { detail: "supabase.data-api.table-not-approved" });
      const columns = input.select ?? policy.columns;
      for (const column of columns)
        if (!policy.columns.includes(column))
          throw new ConnectorError("denied", { detail: "supabase.data-api.column-not-approved" });
      for (const filter of input.filters) {
        const operators = Object.hasOwn(policy.filters, filter.column)
          ? policy.filters[filter.column]
          : undefined;
        if (!operators?.includes(filter.operator))
          throw new ConnectorError("denied", { detail: "supabase.data-api.filter-not-approved" });
      }
      if (input.order && !(policy.orderBy ?? policy.columns).includes(input.order.column))
        throw new ConnectorError("denied", { detail: "supabase.data-api.order-not-approved" });
      const limit = Math.min(input.limit ?? policy.maxRows, policy.maxRows);
      // Everything above is policy; only now do credentials enter.
      const key = await publishableKey(ctx);
      const session = await resolveSession(ctx, settings);
      const url = destinationUrl(destination, `/rest/v1/${input.table}`);
      const query = new URLSearchParams();
      query.set("select", columns.join(","));
      for (const filter of input.filters)
        query.append(filter.column, postgrestFilterValue(filter));
      if (input.order) query.set("order", `${input.order.column}.${input.order.direction}`);
      query.set("limit", String(limit));
      if (input.offset) query.set("offset", String(input.offset));
      url.search = query.toString();
      const rows = await session.use(async (token) => {
        let response: Response;
        try {
          response = await ctx.environment.fetch(url, {
            method: "GET",
            headers: {
              apikey: key,
              authorization: `Bearer ${token}`,
              accept: "application/json",
            },
            redirect: "error",
            signal: boundedSignal(ctx, requestTimeoutMs),
          });
        } catch (cause) {
          throw new ConnectorError("upstream-unavailable", {
            detail: "supabase.data-api.unreachable",
            cause,
          });
        }
        if (response.status === 416) {
          await discardBody(response);
          return [];
        }
        if (response.status !== 200 && response.status !== 206) throw await failure(response);
        const body = await readBoundedJson(response, MAX_RESPONSE_BYTES, "supabase.data-api");
        const parsed = z.array(z.record(z.string(), z.unknown())).max(limit).safeParse(body);
        if (!parsed.success)
          throw new ConnectorError("upstream-rejected", { detail: "supabase.data-api.response-shape" });
        return parsed.data.map((row) =>
          Object.fromEntries(columns.filter((column) => Object.hasOwn(row, column)).map((column) => [column, row[column]])),
        );
      });
      return {
        state: "complete",
        output: {
          table: input.table,
          columns,
          rows,
          count: rows.length,
          truncated: rows.length >= limit,
          rowLevelSecurity: policy.rowLevelSecurity,
        },
        outputClassification: operation.outputClassification,
        effect: "read",
        ...(policy.rowLevelSecurity === "unverified"
          ? { code: "supabase.data-api.rls-unverified" }
          : {}),
      };
    },
    async disconnect(ctx, scope): Promise<DisconnectResult> {
      if (scope === "broker")
        return { local: "not-attempted", broker: "unsupported", upstream: "not-attempted" };
      const connection = requireConnection(ctx);
      await ctx.environment.handoffs.cancelAll(connection.connectionRef, "supabase.data-api.disconnect");
      // The session is owned by the project sign-in ceremony; nothing of it is stored here.
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
