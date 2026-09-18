import { z } from "zod";
import {
  canonicalConnectorJson,
  normalizedDefinitionSchema,
  sourceRecordSchema,
  type CompatibilityIssue,
  type NativeCapability,
  type NormalizedDefinition,
  type SourceRecord,
} from "../../../../core/connectors/index.js";
import {
  capabilityStatus,
  type AdapterCallContext,
  type CapabilityStatus,
  type ConnectorAdapter,
  type DisconnectResult,
  type ExportOutcome,
  type ImportInput,
  type ImportOutcome,
  type InvokeResult,
  type VerificationClaim,
} from "../../adapter.js";
import { boundOperation, type RuntimeBinding } from "../../binding.js";
import { ConnectorError } from "../../errors.js";
import {
  SUPABASE_ECOSYSTEM,
  SUPABASE_SERVICE,
  isPermittedTarget,
  makeClaim,
  projectRefSchema,
  requireConnection,
  safeText,
  sha256Hex,
  sqlIdentifierSchema,
} from "./common.js";

/*
 * Supabase Wrappers (SB-04).
 *
 * Verified 2026-09-18 against https://supabase.com/docs/guides/database/extensions/wrappers/overview
 * and the Stripe wrapper page: a wrapper is `create foreign data wrapper <name>
 * handler <h> validator <v>`, a server is `create server <name> foreign data
 * wrapper <wrapper> options (api_key_id '<vault id>', api_url '...')`, tables
 * are `create foreign table <schema>.<name> (...) server <server> options
 * (object '...', rowid_column '...')` or `import foreign schema ... from
 * server ... into <schema>`. The overview states verbatim: "Foreign Data
 * Wrappers do not provide Row Level Security, thus it is not advised to
 * expose them via your API."
 *
 * This module never executes SQL. `readWrappersDescriptor` reads catalog-style
 * metadata (or migration DDL text, without evaluating it) into a bounded
 * descriptor: wrapper, server and foreign-table names, column names and types,
 * option *names* only. Option values are classified secret and dropped before
 * anything is retained. The adapter then exposes only host-approved narrow
 * reads through `ApprovedQueryPort`, and every capability row carries the RLS
 * limitation.
 */

export const SUPABASE_WRAPPERS_ADAPTER_ID = "supabase-wrappers";
export const SUPABASE_WRAPPERS_SETTINGS_KEY = "supabase-wrappers";
export const WRAPPERS_RLS_LIMITATION =
  "Foreign Data Wrappers do not provide Row Level Security; only host-approved narrow reads are exposed";
const ADAPTER_VERSION = "1.0.0";
const VERIFIER_VERSION = "supabase-wrappers/1.0.0";
const PROFILE = "supabase-wrappers-catalog-v1";
const LIMITS = Object.freeze({
  sqlBytes: 256 * 1024,
  statements: 512,
  wrappers: 64,
  servers: 256,
  tables: 1024,
  columns: 512,
  options: 64,
});

const pgName = z
  .string()
  .min(1)
  .max(63)
  .regex(/^[^\p{Cc}"]+$/u, "Identifier contains control characters or quotes");
const optionSchema = z.strictObject({
  name: pgName,
  /** Accepted so catalog dumps parse; dropped immediately, never retained. */
  value: z.string().max(65536).optional(),
});
export const wrappersCatalogSchema = z.strictObject({
  wrappers: z
    .array(
      z.strictObject({
        name: pgName,
        handler: z.string().max(200).optional(),
        validator: z.string().max(200).optional(),
      }),
    )
    .max(LIMITS.wrappers)
    .default([]),
  servers: z
    .array(
      z.strictObject({
        name: pgName,
        wrapper: pgName,
        options: z.array(optionSchema).max(LIMITS.options).default([]),
      }),
    )
    .max(LIMITS.servers)
    .default([]),
  foreignTables: z
    .array(
      z.strictObject({
        schema: pgName,
        name: pgName,
        server: pgName,
        columns: z
          .array(z.strictObject({ name: pgName, type: z.string().min(1).max(128) }))
          .max(LIMITS.columns)
          .default([]),
        options: z.array(optionSchema).max(LIMITS.options).default([]),
      }),
    )
    .max(LIMITS.tables)
    .default([]),
});
export type WrappersCatalogMetadata = z.input<typeof wrappersCatalogSchema>;

export type WrapperOptionClassification = "secret" | "configuration";
export type WrappersDescriptorOption = {
  name: string;
  classification: WrapperOptionClassification;
};
export type WrappersDescriptor = {
  schemaVersion: 1;
  source: "catalog" | "sql";
  wrappers: Array<{ name: string; handler?: string; validator?: string }>;
  servers: Array<{ name: string; wrapper: string; options: WrappersDescriptorOption[] }>;
  foreignTables: Array<{
    schema: string;
    name: string;
    server: string;
    columns: Array<{ name: string; type: string }>;
    options: WrappersDescriptorOption[];
    rowLevelSecurity: "not-available";
    limitations: string[];
  }>;
  capabilities: NativeCapability[];
  issues: CompatibilityIssue[];
};

/** Credential-like option names are secret, whether they hold a value or a Vault key id; values are never kept either way. */
export function classifyWrapperOption(name: string): WrapperOptionClassification {
  const lower = name.toLowerCase();
  return /(^|_)(api_?key|secret|token|password|passwd|pwd|access_key|private_key|credentials?|auth|conn_?string|connection_string|dsn|uri|url_with_auth)(_|$)/.test(
    lower,
  ) || /(^|_)key(_id)?$/.test(lower)
    ? "secret"
    : "configuration";
}

const issue = (
  code: string,
  pointer: string,
  input: Partial<Pick<CompatibilityIssue, "category" | "dimension" | "disposition" | "severity" | "executionImpact" | "remediation">> & {
    message: string;
  },
): CompatibilityIssue => ({
  code,
  category: input.category ?? "structure",
  sourcePointer: pointer,
  dimension: input.dimension ?? "import",
  disposition: input.disposition ?? "adapted",
  severity: input.severity ?? "warning",
  executionImpact: input.executionImpact ?? "none",
  message: safeText(input.message, 500),
  ...(input.remediation ? { remediation: safeText(input.remediation, 500) } : {}),
});

const stripIdentifier = (raw: string): string =>
  raw.trim().replace(/^"(.*)"$/s, "$1").replace(/""/g, '"');

/** Splits on top-level commas, honouring parentheses and single quotes. */
function splitTopLevel(text: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let quoted = false;
  let current = "";
  for (let index = 0; index < text.length; index++) {
    const character = text[index]!;
    if (quoted) {
      current += character;
      if (character === "'") {
        if (text[index + 1] === "'") {
          current += "'";
          index++;
        } else quoted = false;
      }
      continue;
    }
    if (character === "'") {
      quoted = true;
      current += character;
    } else if (character === "(") {
      depth++;
      current += character;
    } else if (character === ")") {
      depth--;
      current += character;
    } else if (character === "," && depth === 0) {
      parts.push(current.trim());
      current = "";
    } else current += character;
  }
  if (current.trim()) parts.push(current.trim());
  return parts;
}

/** Option names only; the quoted values are discarded here and never leave this function. */
function optionNames(list: string | undefined): string[] {
  if (!list) return [];
  return splitTopLevel(list)
    .map((entry) => stripIdentifier(entry.replace(/\s+'(?:[^']|'')*'\s*$/s, "")))
    .filter((name) => pgName.safeParse(name).success)
    .slice(0, LIMITS.options);
}

function stripComments(sql: string): string {
  let out = "";
  let quoted = false;
  for (let index = 0; index < sql.length; index++) {
    const character = sql[index]!;
    if (quoted) {
      out += character;
      if (character === "'") quoted = false;
      continue;
    }
    if (character === "'") {
      quoted = true;
      out += character;
    } else if (character === "-" && sql[index + 1] === "-") {
      while (index < sql.length && sql[index] !== "\n") index++;
      out += "\n";
    } else if (character === "/" && sql[index + 1] === "*") {
      const end = sql.indexOf("*/", index + 2);
      index = end === -1 ? sql.length : end + 1;
      out += " ";
    } else out += character;
  }
  return out;
}

function splitStatements(sql: string): string[] {
  const statements: string[] = [];
  let quoted = false;
  let current = "";
  for (const character of sql) {
    if (character === "'") quoted = !quoted;
    if (character === ";" && !quoted) {
      if (current.trim()) statements.push(current.trim());
      current = "";
    } else current += character;
  }
  if (current.trim()) statements.push(current.trim());
  return statements;
}

const qualified = (raw: string): { schema: string; name: string } => {
  const parts = raw.split(".");
  if (parts.length >= 2)
    return { schema: stripIdentifier(parts[0]!), name: stripIdentifier(parts.slice(1).join(".")) };
  return { schema: "public", name: stripIdentifier(raw) };
};

function readSql(sql: string): { catalog: WrappersCatalogMetadata; issues: CompatibilityIssue[] } {
  const issues: CompatibilityIssue[] = [];
  const catalog: Required<WrappersCatalogMetadata> = { wrappers: [], servers: [], foreignTables: [] };
  if (Buffer.byteLength(sql, "utf8") > LIMITS.sqlBytes) {
    issues.push(
      issue("supabase.wrappers.sql-too-large", "/sql", {
        severity: "blocking",
        disposition: "rejected",
        executionImpact: "blocks-definition",
        message: "Migration text exceeds the reader ceiling",
      }),
    );
    return { catalog, issues };
  }
  const statements = splitStatements(stripComments(sql));
  if (statements.length > LIMITS.statements)
    issues.push(
      issue("supabase.wrappers.sql-statement-ceiling", "/sql", {
        message: "Statement count exceeds the reader ceiling; later statements were not read",
      }),
    );
  statements.slice(0, LIMITS.statements).forEach((statement, index) => {
    const pointer = `/sql/statements/${index}`;
    const normalized = statement.replace(/\s+/g, " ");
    let match = /^create foreign data wrapper (\S+)(?: handler (\S+))?(?: validator (\S+))?$/i.exec(normalized);
    if (match) {
      if (catalog.wrappers.length < LIMITS.wrappers)
        catalog.wrappers.push({
          name: stripIdentifier(match[1]!),
          ...(match[2] ? { handler: stripIdentifier(match[2]) } : {}),
          ...(match[3] ? { validator: stripIdentifier(match[3]) } : {}),
        });
      return;
    }
    match = /^create server (?:if not exists )?(\S+) foreign data wrapper (\S+)(?: options \((.*)\))?$/is.exec(normalized);
    if (match) {
      if (catalog.servers.length < LIMITS.servers)
        catalog.servers.push({
          name: stripIdentifier(match[1]!),
          wrapper: stripIdentifier(match[2]!),
          options: optionNames(match[3]).map((name) => ({ name })),
        });
      return;
    }
    match = /^create foreign table (?:if not exists )?([\w."]+) \((.*)\) server (\S+)(?: options \((.*)\))?$/is.exec(normalized);
    if (match) {
      const { schema, name } = qualified(match[1]!);
      const columns = splitTopLevel(match[2]!)
        .map((column) => {
          const [columnName, ...rest] = column.split(/\s+/);
          return { name: stripIdentifier(columnName ?? ""), type: rest.join(" ").slice(0, 128) || "unknown" };
        })
        .filter((column) => pgName.safeParse(column.name).success)
        .slice(0, LIMITS.columns);
      if (catalog.foreignTables.length < LIMITS.tables)
        catalog.foreignTables.push({
          schema,
          name,
          server: stripIdentifier(match[3]!),
          columns,
          options: optionNames(match[4]).map((optionName) => ({ name: optionName })),
        });
      return;
    }
    match = /^import foreign schema (\S+)(?: limit to \(([^)]*)\)| except \(([^)]*)\))? from server (\S+) into (\S+)$/i.exec(normalized);
    if (match) {
      const server = stripIdentifier(match[4]!);
      const schema = stripIdentifier(match[5]!);
      const listed = match[2] ? splitTopLevel(match[2]).map(stripIdentifier) : [];
      for (const name of listed)
        if (pgName.safeParse(name).success && catalog.foreignTables.length < LIMITS.tables)
          catalog.foreignTables.push({ schema, name, server, columns: [], options: [] });
      issues.push(
        issue("supabase.wrappers.import-foreign-schema", pointer, {
          message: listed.length
            ? "import foreign schema lists tables but not columns; catalog metadata is needed for column review"
            : "import foreign schema creates tables not visible from the migration; catalog metadata is needed",
          remediation: "Read pg_foreign_table and pg_attribute for the imported schema",
        }),
      );
      return;
    }
    if (/^(create|alter|drop|grant|revoke|select|insert|update|delete|comment|set)\b/i.test(normalized))
      issues.push(
        issue("supabase.wrappers.statement-ignored", pointer, {
          severity: "info",
          message: "Statement is not a wrapper, server or foreign table definition and was not read",
        }),
      );
  });
  return { catalog, issues };
}

function nameOptions(options: Array<{ name: string; value?: string | undefined }>): WrappersDescriptorOption[] {
  return options.map((option) => ({ name: option.name, classification: classifyWrapperOption(option.name) }));
}

/**
 * Reads catalog-style metadata (`pg_foreign_data_wrapper`, `pg_foreign_server`,
 * `pg_foreign_table` with `pg_options_to_table`) or migration DDL text into a
 * descriptor. Never executes anything; never keeps an option value.
 */
export function readWrappersDescriptor(
  input: WrappersCatalogMetadata | { sql: string },
): WrappersDescriptor {
  const issues: CompatibilityIssue[] = [];
  let catalog: WrappersCatalogMetadata;
  let source: WrappersDescriptor["source"];
  if ("sql" in input && typeof input.sql === "string") {
    const read = readSql(input.sql);
    catalog = read.catalog;
    issues.push(...read.issues);
    source = "sql";
  } else {
    source = "catalog";
    const parsed = wrappersCatalogSchema.safeParse(input);
    if (!parsed.success)
      return {
        schemaVersion: 1,
        source,
        wrappers: [],
        servers: [],
        foreignTables: [],
        capabilities: [],
        issues: [
          issue("supabase.wrappers.metadata-invalid", "/", {
            severity: "blocking",
            disposition: "rejected",
            executionImpact: "blocks-definition",
            message: "Catalog metadata does not match the expected shape",
          }),
        ],
      };
    catalog = parsed.data;
  }
  const parsed = wrappersCatalogSchema.parse(catalog);
  const serverNames = new Set(parsed.servers.map((server) => server.name));
  const wrapperNames = new Set(parsed.wrappers.map((wrapper) => wrapper.name));
  parsed.servers.forEach((server, index) => {
    if (!wrapperNames.has(server.wrapper))
      issues.push(
        issue("supabase.wrappers.unknown-wrapper", `/servers/${index}`, {
          severity: "info",
          message: "Server names a wrapper that is not in the metadata",
        }),
      );
  });
  const seen = new Set<string>();
  const foreignTables: WrappersDescriptor["foreignTables"] = [];
  parsed.foreignTables.forEach((table, index) => {
    const key = `${table.schema}.${table.name}`;
    if (seen.has(key)) {
      issues.push(
        issue("supabase.wrappers.duplicate-table", `/foreignTables/${index}`, {
          message: "Foreign table listed twice; the first definition is kept",
        }),
      );
      return;
    }
    seen.add(key);
    if (!serverNames.has(table.server))
      issues.push(
        issue("supabase.wrappers.unknown-server", `/foreignTables/${index}`, {
          severity: "info",
          message: "Foreign table names a server that is not in the metadata",
        }),
      );
    if (table.schema === "public")
      issues.push(
        issue("supabase.wrappers.public-schema", `/foreignTables/${index}`, {
          category: "policy",
          message: "Foreign table lives in the public schema and may be reachable through the Data API without Row Level Security",
          remediation: "Move wrappers to a private schema and expose host-approved reads only",
        }),
      );
    issues.push(
      issue("supabase.wrappers.rls-unavailable", `/foreignTables/${index}`, {
        category: "policy",
        dimension: "invoke",
        message: WRAPPERS_RLS_LIMITATION,
        remediation: "Approve narrow reads per table and column; do not expose the table through the API",
      }),
    );
    foreignTables.push({
      schema: table.schema,
      name: table.name,
      server: table.server,
      columns: table.columns.map((column) => ({ name: column.name, type: safeText(column.type, 128) })),
      options: nameOptions(table.options),
      rowLevelSecurity: "not-available",
      limitations: [WRAPPERS_RLS_LIMITATION],
    });
  });
  const capabilities: NativeCapability[] = foreignTables.map((table) => ({
    kind: "query",
    nativeId: `${table.schema}.${table.name}`,
    label: `${table.schema}.${table.name}`,
    summary: `Foreign table on server ${table.server}; ${WRAPPERS_RLS_LIMITATION}`,
    effect: "read",
    dataClassification: "personal",
    cost: "unknown",
    authentication: ["approved-query-port"],
  }));
  return {
    schemaVersion: 1,
    source,
    wrappers: parsed.wrappers.map((wrapper) => ({
      name: wrapper.name,
      ...(wrapper.handler ? { handler: safeText(wrapper.handler, 200) } : {}),
      ...(wrapper.validator ? { validator: safeText(wrapper.validator, 200) } : {}),
    })),
    servers: parsed.servers.map((server) => ({
      name: server.name,
      wrapper: server.wrapper,
      options: nameOptions(server.options),
    })),
    foreignTables,
    capabilities,
    issues,
  };
}

export const approvedForeignReadOperators = [
  "eq",
  "neq",
  "gt",
  "gte",
  "lt",
  "lte",
  "in",
  "is-null",
  "is-not-null",
] as const;
const scalar = z.union([z.string().max(512).regex(/^[^\p{Cc}]*$/u), z.number().finite(), z.boolean()]);
const foreignFilterSchema = z.strictObject({
  column: sqlIdentifierSchema,
  operator: z.enum(approvedForeignReadOperators),
  value: z.union([scalar, z.array(scalar).min(1).max(100)]).optional(),
});
export const approvedForeignReadInputSchema = z.strictObject({
  select: z.array(sqlIdentifierSchema).min(1).max(64).optional(),
  filters: z.array(foreignFilterSchema).max(16).default([]),
  order: z
    .strictObject({ column: sqlIdentifierSchema, direction: z.enum(["asc", "desc"]).default("asc") })
    .optional(),
  limit: z.number().int().min(1).max(1000).optional(),
  offset: z.number().int().min(0).max(1_000_000).default(0),
});

/** A narrow read the port composes itself from validated identifiers; the adapter never hands it SQL. */
export type ApprovedForeignRead = {
  schema: string;
  table: string;
  columns: string[];
  filters: Array<z.output<typeof foreignFilterSchema>>;
  order?: { column: string; direction: "asc" | "desc" };
  limit: number;
  offset: number;
};

export interface ApprovedQueryPort {
  /** Catalog metadata read by the host from pg_catalog under its own role. */
  catalog(input: { signal: AbortSignal }): Promise<WrappersCatalogMetadata>;
  /** Executes exactly the approved read; must refuse anything it cannot parameterize. */
  select(
    input: ApprovedForeignRead & { signal: AbortSignal },
  ): Promise<{ rows: Array<Record<string, unknown>>; truncated?: boolean }>;
}

const tablePolicySchema = z.strictObject({
  columns: z.array(sqlIdentifierSchema).min(1).max(64),
  filters: z
    .record(sqlIdentifierSchema, z.array(z.enum(approvedForeignReadOperators)).min(1).max(9))
    .default({}),
  orderBy: z.array(sqlIdentifierSchema).max(16).optional(),
  maxRows: z.number().int().min(1).max(1000).default(100),
});
export const supabaseWrappersSettingsSchema = z.strictObject({
  projectRef: projectRefSchema.optional(),
  /** Approved reads keyed by `<schema>.<table>`. */
  tables: z
    .record(z.string().regex(/^[a-z_][a-z0-9_]{0,62}\.[a-z_][a-z0-9_]{0,62}$/), tablePolicySchema)
    .refine((value) => Object.keys(value).length <= 64),
});
export type SupabaseWrappersSettings = z.output<typeof supabaseWrappersSettingsSchema>;

export type SupabaseWrappersOptions = {
  query: ApprovedQueryPort;
  evidenceTtlMs?: number;
};

export function createSupabaseWrappersAdapter(options: SupabaseWrappersOptions): ConnectorAdapter {
  const evidenceTtlMs = options.evidenceTtlMs ?? 3_600_000;

  const settingsOf = (binding: RuntimeBinding): SupabaseWrappersSettings => {
    const parsed = supabaseWrappersSettingsSchema.safeParse(
      binding.settings[SUPABASE_WRAPPERS_SETTINGS_KEY],
    );
    if (!parsed.success)
      throw new ConnectorError("invalid-request", { detail: "supabase.wrappers.settings-invalid" });
    return parsed.data;
  };

  const definitionFor = (
    descriptor: WrappersDescriptor,
    digest: string,
    namespace: string,
  ): NormalizedDefinition =>
    normalizedDefinitionSchema.parse({
      schemaVersion: 1,
      definitionRef: `supabase-wrappers:def:${digest.slice(0, 32)}`,
      identity: {
        ecosystem: SUPABASE_ECOSYSTEM,
        authorityNamespace: namespace,
        nativeId: "wrappers",
        nativeVersion: descriptor.source,
      },
      sourceRef: `supabase-wrappers:src:${digest.slice(0, 32)}`,
      normalizedDigest: sha256Hex(canonicalConnectorJson(descriptor)),
      importer: { id: "supabase-wrappers-descriptor", version: ADAPTER_VERSION },
      display: {
        name: "Supabase Wrappers foreign tables",
        description:
          "Foreign servers and tables described from catalog metadata; option values are never stored and foreign tables have no Row Level Security.",
        ecosystem: SUPABASE_ECOSYSTEM,
        service: SUPABASE_SERVICE,
      },
      authentication: [
        {
          id: "approved-query-port",
          label: "Host-approved database reads",
          kind: "external-broker",
          broker: SUPABASE_ECOSYSTEM,
          custody: "external-execution-broker",
        },
      ],
      configuration: [],
      capabilities: descriptor.capabilities,
      events: [],
      declaredServers: [],
      compatibility: {
        issues: descriptor.issues,
        dimensions: {
          discover: "adapted",
          import: "exact",
          configure: "adapted",
          authorize: "unsupported",
          verify: "adapted",
          invoke: "adapted",
          events: "unsupported",
          reconnect: "unsupported",
          disconnect: "adapted",
          revoke: "unsupported",
          export: "adapted",
          delegate: "unsupported",
        },
      },
      nativeExtensions: {},
    });

  const adapter: ConnectorAdapter = {
    id: SUPABASE_WRAPPERS_ADAPTER_ID,
    ecosystem: SUPABASE_ECOSYSTEM,
    adapterVersion: ADAPTER_VERSION,
    runtime: "hosted-server",
    displayName: "Supabase Wrappers",
    description:
      "Descriptor of Wrappers foreign servers and tables from catalog metadata, and host-approved narrow reads on listed foreign tables. Foreign tables have no Row Level Security; nothing here executes arbitrary SQL.",
    service: SUPABASE_SERVICE,
    support: "provider-backed",
    custody: ["external-execution-broker"],
    configuration: [],
    profiles: [PROFILE, "external-broker"],
    capabilities(): CapabilityStatus[] {
      const row = (
        dimension: CapabilityStatus["dimension"],
        input: Partial<Pick<CapabilityStatus, "implementation" | "limitations">> = {},
      ) =>
        capabilityStatus(adapter, {
          dimension,
          profile: PROFILE,
          implementation: input.implementation ?? "implemented",
          configuration: "not-applicable",
          evidence: input.implementation === "unsupported" ? "not-tested" : "protocol-fixture",
          limitations: [WRAPPERS_RLS_LIMITATION, ...(input.limitations ?? [])],
        });
      return [
        row("discover", { limitations: ["Catalog metadata read by the host's approved query port"] }),
        row("import", { limitations: ["Catalog JSON or migration DDL text; option values are dropped, never stored"] }),
        row("configure", { limitations: ["Approved tables, columns and filters are binding settings"] }),
        row("authorize", { implementation: "unsupported", limitations: ["Reads run under the host's database role; there is no end-user grant"] }),
        row("verify", { limitations: ["Confirms approved tables and columns still exist in the catalog"] }),
        row("invoke", { limitations: ["Parameterized, allowlisted reads through the approved query port; no SQL is accepted"] }),
        row("events", { implementation: "unsupported" }),
        row("reconnect", { implementation: "unsupported" }),
        row("disconnect"),
        row("revoke", { implementation: "unsupported" }),
        row("export", { limitations: ["Exports the descriptor: names and types only"] }),
        row("delegate", { implementation: "unsupported" }),
      ];
    },
    async import(_ctx, input: ImportInput): Promise<ImportOutcome> {
      const text = Buffer.from(input.bytes).toString("utf8");
      const digest = sha256Hex(text);
      const mediaType = input.mediaType.split(";")[0]!.trim().toLowerCase();
      let descriptor: WrappersDescriptor;
      if (mediaType === "application/json") {
        let parsed: unknown;
        try {
          parsed = JSON.parse(text, (key, value) =>
            ["__proto__", "constructor", "prototype"].includes(key) ? undefined : value,
          );
        } catch {
          throw new ConnectorError("invalid-request", { detail: "supabase.wrappers.metadata-not-json" });
        }
        descriptor = readWrappersDescriptor(parsed as WrappersCatalogMetadata);
      } else if (mediaType === "application/sql" || mediaType === "text/plain" || mediaType === "text/x-sql") {
        descriptor = readWrappersDescriptor({ sql: text });
      } else
        throw new ConnectorError("unsupported", { detail: "supabase.wrappers.media-type" });
      const source: SourceRecord = sourceRecordSchema.parse({
        sourceRef: `supabase-wrappers:src:${digest.slice(0, 32)}`,
        identity: {
          ecosystem: SUPABASE_ECOSYSTEM,
          authorityNamespace: input.identityHint?.authorityNamespace ?? "",
          nativeId: input.identityHint?.nativeId ?? "wrappers",
          nativeVersion: input.identityHint?.nativeVersion ?? descriptor.source,
        },
        format: {
          name: "supabase-wrappers",
          version: "1",
          dialect: descriptor.source === "sql" ? "postgres-ddl" : "catalog-json",
        },
        origin: input.origin,
        digest: { algorithm: "sha256", value: digest },
        byteLength: input.bytes.byteLength,
        mediaType,
        capturedAt: new Date().toISOString(),
        adaptation: [],
        overlays: [],
      });
      const blocking = descriptor.issues.some((item) => item.severity === "blocking");
      return {
        source,
        definitions: blocking
          ? []
          : [definitionFor(descriptor, digest, input.identityHint?.authorityNamespace ?? "")],
        issues: descriptor.issues,
        executableCandidates: blocking ? [] : descriptor.capabilities.map((item) => item.nativeId),
      };
    },
    async export(_ctx, request): Promise<ExportOutcome> {
      if (request.format !== "supabase-wrappers-descriptor" && request.format !== "json")
        throw new ConnectorError("unsupported", { detail: "supabase.wrappers.export-format" });
      const bytes = new TextEncoder().encode(
        JSON.stringify(
          {
            format: "supabase-wrappers-descriptor",
            version: 1,
            capabilities: request.definition.capabilities.map((capability) => ({
              nativeId: capability.nativeId,
              effect: capability.effect,
              dataClassification: capability.dataClassification,
              rowLevelSecurity: "not-available",
            })),
            issues: request.definition.compatibility.issues.map((item) => item.code),
          },
          null,
          2,
        ),
      );
      return { mediaType: "application/json", bytes, losses: [] };
    },
    async discover(ctx) {
      const catalog = await options.query.catalog({ signal: ctx.signal });
      const descriptor = readWrappersDescriptor(catalog);
      return {
        items: descriptor.foreignTables.map((table) => ({
          identity: {
            ecosystem: SUPABASE_ECOSYSTEM,
            authorityNamespace: table.server,
            nativeId: `${table.schema}.${table.name}`,
            nativeVersion: "catalog",
          },
          displayName: `${table.schema}.${table.name}`,
          description: `Foreign table on server ${table.server}; ${WRAPPERS_RLS_LIMITATION}`,
          provenance: {
            server: table.server,
            rowLevelSecurity: "not-available",
            approved: String(isPermittedTarget(ctx.binding, { kind: "supabase-foreign-table", id: `${table.schema}.${table.name}` })),
          },
          status: "active" as const,
        })),
        freshness: { fetchedAt: ctx.environment.now(), stale: false, source: "live" },
        issues: descriptor.issues,
      };
    },
    async verify(ctx) {
      const settings = settingsOf(ctx.binding);
      requireConnection(ctx);
      const descriptor = readWrappersDescriptor(await options.query.catalog({ signal: ctx.signal }));
      const claims: VerificationClaim[] = [];
      for (const [key, policy] of Object.entries(settings.tables)) {
        const [schema, name] = key.split(".");
        const table = descriptor.foreignTables.find((item) => item.schema === schema && item.name === name);
        if (!table) return { state: "denied", claims: [], code: "supabase.wrappers.table-missing" };
        const columns = new Set(table.columns.map((column) => column.name));
        const missing = policy.columns.filter((column) => table.columns.length > 0 && !columns.has(column));
        if (missing.length) return { state: "denied", claims: [], code: "supabase.wrappers.column-missing" };
        claims.push(
          makeClaim(ctx, {
            kind: "resource-access",
            issuer: "host-policy",
            target: { kind: "supabase-foreign-table", id: key },
            verifierVersion: VERIFIER_VERSION,
            validForMs: evidenceTtlMs,
            permissions: { requested: policy.columns, reported: [...columns].slice(0, 64), observed: [], semantics: "operations" },
            limitations: [WRAPPERS_RLS_LIMITATION, `Server ${table.server}; reads run under the host's database role`],
          }),
        );
      }
      return { state: "complete", claims };
    },
    async invoke(ctx, request): Promise<InvokeResult> {
      const settings = settingsOf(ctx.binding);
      const operation = boundOperation(ctx.binding, request.operationRef);
      if (!operation)
        throw new ConnectorError("not-found", { detail: "supabase.operation.unknown" });
      if (operation.transport.kind !== "delegated" || operation.transport.route !== "wrappers-select")
        throw new ConnectorError("denied", { detail: "supabase.binding.transport-mismatch" });
      if (operation.effect !== "read")
        throw new ConnectorError("denied", { detail: "supabase.binding.effect-mismatch" });
      if (operation.outputClassification === "public")
        throw new ConnectorError("denied", { detail: "supabase.binding.classification-too-low" });
      const key = operation.nativeId;
      const policy = Object.hasOwn(settings.tables, key) ? settings.tables[key] : undefined;
      if (!policy || !isPermittedTarget(ctx.binding, { kind: "supabase-foreign-table", id: key }))
        throw new ConnectorError("denied", { detail: "supabase.wrappers.table-not-approved" });
      requireConnection(ctx);
      const input = approvedForeignReadInputSchema.parse(request.input ?? {});
      const columns = input.select ?? policy.columns;
      for (const column of columns)
        if (!policy.columns.includes(column))
          throw new ConnectorError("denied", { detail: "supabase.wrappers.column-not-approved" });
      for (const filter of input.filters) {
        const operators = Object.hasOwn(policy.filters, filter.column) ? policy.filters[filter.column] : undefined;
        if (!operators?.includes(filter.operator))
          throw new ConnectorError("denied", { detail: "supabase.wrappers.filter-not-approved" });
        const needsValue = filter.operator !== "is-null" && filter.operator !== "is-not-null";
        if (needsValue !== (filter.value !== undefined) || (filter.operator === "in") !== Array.isArray(filter.value ?? []) && needsValue)
          throw new ConnectorError("invalid-request", { detail: "supabase.wrappers.filter-value" });
      }
      if (input.order && !(policy.orderBy ?? policy.columns).includes(input.order.column))
        throw new ConnectorError("denied", { detail: "supabase.wrappers.order-not-approved" });
      const [schema, table] = key.split(".") as [string, string];
      const limit = Math.min(input.limit ?? policy.maxRows, policy.maxRows);
      const result = await options.query.select({
        schema,
        table,
        columns,
        filters: input.filters,
        ...(input.order ? { order: input.order } : {}),
        limit,
        offset: input.offset,
        signal: ctx.signal,
      });
      const rows = result.rows
        .slice(0, limit)
        .map((row) => Object.fromEntries(columns.filter((column) => Object.hasOwn(row, column)).map((column) => [column, row[column]])));
      return {
        state: "complete",
        output: {
          table: key,
          columns,
          rows,
          count: rows.length,
          truncated: result.truncated === true || result.rows.length > limit,
          rowLevelSecurity: "not-available",
        },
        outputClassification: operation.outputClassification,
        effect: "read",
        code: "supabase.wrappers.rls-unavailable",
      };
    },
    async disconnect(ctx, scope): Promise<DisconnectResult> {
      if (scope === "broker")
        return { local: "not-attempted", broker: "unsupported", upstream: "not-attempted" };
      const connection = requireConnection(ctx);
      await ctx.environment.handoffs.cancelAll(connection.connectionRef, "supabase.wrappers.disconnect");
      return {
        local: "applied",
        broker: "not-attempted",
        upstream: scope === "upstream" ? "unsupported" : "not-attempted",
      };
    },
  };
  return adapter;
}
