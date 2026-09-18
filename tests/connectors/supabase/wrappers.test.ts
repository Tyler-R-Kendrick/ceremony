import assert from "node:assert/strict";
import { test } from "node:test";
import {
  WRAPPERS_RLS_LIMITATION,
  classifyWrapperOption,
  createSupabaseWrappersAdapter,
  readWrappersDescriptor,
  type ApprovedForeignRead,
  type ApprovedQueryPort,
  type WrappersCatalogMetadata,
} from "../../../src/server/connectors/providers/supabase/index.js";
import { ConnectorError } from "../../../src/server/connectors/errors.js";
import { supabaseHarness, wrappersBinding } from "../fixtures/supabase/harness.js";

/*
 * SB-04 / AC-SB-06. Nothing here executes SQL: the descriptor is read from
 * catalog metadata (or from migration text, without evaluating it) and reads
 * go through an approved, parameterized port. The absence of foreign-table
 * Row Level Security is stated on every capability row and every result.
 */

/** A Stripe wrapper migration written the way the Supabase documentation shows it. */
const MIGRATION = `
-- Enable the extension and the wrapper
create extension if not exists wrappers with schema extensions;

create foreign data wrapper stripe_wrapper
  handler stripe_fdw_handler
  validator stripe_fdw_validator;

select vault.create_secret(
  'sk_test_CANARY_STRIPE_KEY_0123456789',
  'stripe',
  'Stripe API key for Wrappers'
);

create server stripe_server
  foreign data wrapper stripe_wrapper
  options (
    api_key_id '11111111-2222-4333-8444-555555555555',
    api_url 'https://api.stripe.com/v1/',
    api_version '2024-06-20'
  );

create schema if not exists private_stripe;

create foreign table private_stripe.products (
  id text,
  name text,
  active bool,
  created timestamp,
  attrs jsonb
)
  server stripe_server
  options (
    object 'products',
    rowid_column 'id'
  );

create foreign table public.customers (
  id text,
  email text
)
  server stripe_server
  options (object 'customers');

grant select on private_stripe.products to authenticated;
`;

const CATALOG: WrappersCatalogMetadata = {
  wrappers: [
    {
      name: "stripe_wrapper",
      handler: "stripe_fdw_handler",
      validator: "stripe_fdw_validator",
    },
  ],
  servers: [
    {
      name: "stripe_server",
      wrapper: "stripe_wrapper",
      options: [
        { name: "api_key_id", value: "11111111-2222-4333-8444-555555555555" },
        { name: "api_url", value: "https://api.stripe.com/v1/" },
      ],
    },
  ],
  foreignTables: [
    {
      schema: "private_stripe",
      name: "products",
      server: "stripe_server",
      columns: [
        { name: "id", type: "text" },
        { name: "name", type: "text" },
        { name: "active", type: "bool" },
      ],
      options: [
        { name: "object", value: "products" },
        { name: "rowid_column", value: "id" },
      ],
    },
  ],
};

const SETTINGS = {
  tables: {
    "private_stripe.products": {
      columns: ["id", "name", "active"],
      filters: { active: ["eq"], id: ["eq", "in"] },
      orderBy: ["id"],
      maxRows: 50,
    },
  },
};

function queryPort(
  rows: Array<Record<string, unknown>> = [],
  catalog: WrappersCatalogMetadata = CATALOG,
): ApprovedQueryPort & { reads: ApprovedForeignRead[] } {
  const reads: ApprovedForeignRead[] = [];
  return {
    reads,
    async catalog() {
      return catalog;
    },
    async select(input) {
      const { signal: _signal, ...read } = input;
      void _signal;
      reads.push(read);
      return { rows };
    },
  };
}

test("AC-SB-06: the descriptor names foreign tables and option names, and never keeps an option value", () => {
  const fromSql = readWrappersDescriptor({ sql: MIGRATION });
  assert.equal(fromSql.source, "sql");
  assert.deepEqual(fromSql.wrappers, [
    {
      name: "stripe_wrapper",
      handler: "stripe_fdw_handler",
      validator: "stripe_fdw_validator",
    },
  ]);
  assert.deepEqual(fromSql.servers, [
    {
      name: "stripe_server",
      wrapper: "stripe_wrapper",
      options: [
        { name: "api_key_id", classification: "secret" },
        { name: "api_url", classification: "configuration" },
        { name: "api_version", classification: "configuration" },
      ],
    },
  ]);
  const products = fromSql.foreignTables.find(
    (table) => table.name === "products",
  )!;
  assert.equal(products.schema, "private_stripe");
  assert.equal(products.server, "stripe_server");
  assert.deepEqual(
    products.columns.map((column) => column.name),
    ["id", "name", "active", "created", "attrs"],
  );
  assert.deepEqual(products.options, [
    { name: "object", classification: "configuration" },
    { name: "rowid_column", classification: "configuration" },
  ]);

  // No option value, no vault secret and no API key survives anywhere in the
  // descriptor, however it is serialized.
  const serialized = JSON.stringify(fromSql);
  for (const secret of [
    "sk_test_CANARY_STRIPE_KEY_0123456789",
    "11111111-2222-4333-8444-555555555555",
    "https://api.stripe.com/v1/",
    "2024-06-20",
  ])
    assert.equal(
      serialized.includes(secret),
      false,
      `option values must not be stored in plain: ${secret}`,
    );

  // Every foreign table states the limitation, verbatim from the documentation.
  for (const table of fromSql.foreignTables) {
    assert.equal(table.rowLevelSecurity, "not-available");
    assert.deepEqual(table.limitations, [WRAPPERS_RLS_LIMITATION]);
  }
  assert.ok(
    fromSql.issues.some((issue) => issue.code === "supabase.wrappers.rls-unavailable"),
  );
  // A foreign table in the public schema is reachable through the Data API and
  // is called out separately.
  assert.ok(
    fromSql.issues.some((issue) => issue.code === "supabase.wrappers.public-schema"),
  );

  // Catalog metadata produces the same shape without any SQL at all.
  const fromCatalog = readWrappersDescriptor(CATALOG);
  assert.equal(fromCatalog.source, "catalog");
  assert.equal(fromCatalog.foreignTables.length, 1);
  assert.equal(fromCatalog.capabilities[0]?.nativeId, "private_stripe.products");
  assert.equal(fromCatalog.capabilities[0]?.effect, "read");
  assert.equal(fromCatalog.capabilities[0]?.dataClassification, "personal");
  assert.ok(
    fromCatalog.capabilities[0]?.summary?.includes("Row Level Security"),
  );
});

test("Option names that carry credentials are classified secret", () => {
  for (const name of [
    "api_key",
    "api_key_id",
    "password",
    "access_key",
    "sa_key_id",
    "connection_string",
    "auth_token",
  ])
    assert.equal(classifyWrapperOption(name), "secret", name);
  for (const name of ["api_url", "object", "rowid_column", "api_version", "region"])
    assert.equal(classifyWrapperOption(name), "configuration", name);
});

test("The reader bounds its input and never evaluates what it cannot parse", () => {
  const oversize = readWrappersDescriptor({ sql: "-- x\n".repeat(200_000) });
  assert.deepEqual(oversize.foreignTables, []);
  assert.ok(
    oversize.issues.some(
      (issue) =>
        issue.code === "supabase.wrappers.sql-too-large" &&
        issue.severity === "blocking" &&
        issue.executionImpact === "blocks-definition",
    ),
  );

  // Statements that are not wrapper definitions are reported, not executed.
  const other = readWrappersDescriptor({
    sql: "drop table users; select pg_sleep(10); create index on notes (id);",
  });
  assert.deepEqual(other.foreignTables, []);
  assert.ok(
    other.issues.every((issue) => issue.code === "supabase.wrappers.statement-ignored"),
  );

  // import foreign schema creates tables the migration does not describe; that
  // gap is reported rather than guessed.
  const imported = readWrappersDescriptor({
    sql: "import foreign schema stripe limit to (products, customers) from server stripe_server into private_stripe;",
  });
  assert.deepEqual(
    imported.foreignTables.map((table) => `${table.schema}.${table.name}`),
    ["private_stripe.products", "private_stripe.customers"],
  );
  assert.deepEqual(imported.foreignTables[0]?.columns, []);
  assert.ok(
    imported.issues.some(
      (issue) => issue.code === "supabase.wrappers.import-foreign-schema",
    ),
  );

  // Malformed metadata fails as a blocking issue, with nothing half-read.
  const invalid = readWrappersDescriptor({
    foreignTables: [{ schema: "x" }],
  } as unknown as WrappersCatalogMetadata);
  assert.deepEqual(invalid.foreignTables, []);
  assert.equal(invalid.issues[0]?.severity, "blocking");
});

test("AC-SB-06: a foreign table without an approved narrow path cannot be read", async (t) => {
  const port = queryPort([{ id: "prod_1", name: "Widget", active: true }]);
  const adapter = createSupabaseWrappersAdapter({ query: port });
  const h = await supabaseHarness({
    binding: wrappersBinding({
      settings: SETTINGS,
      tables: ["private_stripe.products"],
    }),
    fetch,
    connection: { lifecycle: "active" },
  });
  t.after(() => h.close());

  // The approved read works and states the limitation in its own result.
  const allowed = await adapter.invoke!(h.ctx, {
    operationRef: "operation:private_stripe.products",
    input: { select: ["id", "name"], filters: [{ column: "active", operator: "eq", value: true }] },
    commandId: "command-1",
  });
  assert.equal(allowed.state, "complete");
  assert.equal(allowed.code, "supabase.wrappers.rls-unavailable");
  assert.equal(
    (allowed.output as { rowLevelSecurity: string }).rowLevelSecurity,
    "not-available",
  );
  assert.deepEqual((allowed.output as { rows: unknown[] }).rows, [
    { id: "prod_1", name: "Widget" },
  ]);
  // The port received identifiers, never SQL.
  assert.deepEqual(port.reads.at(-1), {
    schema: "private_stripe",
    table: "products",
    columns: ["id", "name"],
    filters: [{ column: "active", operator: "eq", value: true }],
    limit: 50,
    offset: 0,
  });

  // A foreign table that exists in the catalog but has no approved read is
  // refused, and the port is never asked.
  const reads = port.reads.length;
  const unapproved = await supabaseHarness({
    binding: wrappersBinding({
      settings: SETTINGS,
      tables: ["private_stripe.products", "public.customers"],
      permittedTargets: [
        { kind: "supabase-foreign-table", id: "private_stripe.products" },
        { kind: "supabase-foreign-table", id: "public.customers" },
      ],
    }),
    fetch,
    connection: { lifecycle: "active" },
  });
  t.after(() => unapproved.close());
  await assert.rejects(
    () =>
      adapter.invoke!(unapproved.ctx, {
        operationRef: "operation:public.customers",
        input: {},
        commandId: "command-2",
      }),
    (error: unknown) =>
      error instanceof ConnectorError &&
      error.code === "denied" &&
      error.detail === "supabase.wrappers.table-not-approved",
  );
  assert.equal(port.reads.length, reads, "an unapproved table never reaches the port");

  // Columns, filters and ordering outside the approved profile are refused too.
  for (const [detail, input] of [
    ["supabase.wrappers.column-not-approved", { select: ["id", "attrs"] }],
    [
      "supabase.wrappers.filter-not-approved",
      { filters: [{ column: "name", operator: "eq", value: "Widget" }] },
    ],
    [
      "supabase.wrappers.order-not-approved",
      { order: { column: "name", direction: "asc" } },
    ],
  ] as Array<[string, unknown]>)
    await assert.rejects(
      () =>
        adapter.invoke!(h.ctx, {
          operationRef: "operation:private_stripe.products",
          input,
          commandId: "command-3",
        }),
      (error: unknown) =>
        error instanceof ConnectorError && error.detail === detail,
      `expected ${detail}`,
    );
  assert.equal(port.reads.length, reads);

  // A caller cannot smuggle SQL through the input at all: the schema rejects
  // anything that is not an approved identifier.
  await assert.rejects(
    () =>
      adapter.invoke!(h.ctx, {
        operationRef: "operation:private_stripe.products",
        input: { select: ["id; drop table users --"] },
        commandId: "command-4",
      }),
    (error: unknown) => error instanceof Error,
  );
  assert.equal(port.reads.length, reads);
});

test("Every capability row carries the Row Level Security limitation", async () => {
  const adapter = createSupabaseWrappersAdapter({ query: queryPort() });
  const rows = adapter.capabilities(new Set());
  assert.ok(rows.length > 0);
  for (const row of rows)
    assert.ok(
      row.limitations.includes(WRAPPERS_RLS_LIMITATION),
      `${row.dimension} must state the Row Level Security limitation`,
    );
  assert.equal(
    rows.find((row) => row.dimension === "authorize")?.implementation,
    "unsupported",
    "there is no end-user grant for a foreign table",
  );
});

test("Verification refuses when an approved table or column has left the catalog", async (t) => {
  const adapter = createSupabaseWrappersAdapter({ query: queryPort() });
  const h = await supabaseHarness({
    binding: wrappersBinding({ settings: SETTINGS }),
    fetch,
    connection: { lifecycle: "active" },
  });
  t.after(() => h.close());
  const verified = await adapter.verify!(h.ctx);
  assert.equal(verified.state, "complete");
  const claim = verified.claims[0]!;
  assert.equal(claim.kind, "resource-access");
  assert.equal(claim.issuer, "host-policy");
  assert.deepEqual(claim.target, {
    kind: "supabase-foreign-table",
    id: "private_stripe.products",
  });
  assert.ok(claim.limitations.includes(WRAPPERS_RLS_LIMITATION));

  const dropped = createSupabaseWrappersAdapter({
    query: queryPort([], { wrappers: [], servers: [], foreignTables: [] }),
  });
  const missing = await dropped.verify!(h.ctx);
  assert.equal(missing.state, "denied");
  assert.equal(missing.code, "supabase.wrappers.table-missing");

  const columnDropped = createSupabaseWrappersAdapter({
    query: queryPort([], {
      ...CATALOG,
      foreignTables: [
        {
          schema: "private_stripe",
          name: "products",
          server: "stripe_server",
          columns: [{ name: "id", type: "text" }],
          options: [],
        },
      ],
    }),
  });
  const columnMissing = await columnDropped.verify!(h.ctx);
  assert.equal(columnMissing.state, "denied");
  assert.equal(columnMissing.code, "supabase.wrappers.column-missing");
});

test("Import produces a definition whose capabilities are foreign tables, and export carries names only", async (t) => {
  const adapter = createSupabaseWrappersAdapter({ query: queryPort() });
  const h = await supabaseHarness({
    binding: wrappersBinding({ settings: SETTINGS }),
    fetch,
    connection: { lifecycle: "active" },
  });
  t.after(() => h.close());

  const imported = await adapter.import!(h.ctx, {
    bytes: new TextEncoder().encode(MIGRATION),
    mediaType: "application/sql",
    origin: { kind: "upload" },
  });
  assert.equal(imported.definitions.length, 1);
  const definition = imported.definitions[0]!;
  assert.equal(definition.display.ecosystem, "supabase");
  assert.deepEqual(
    definition.capabilities.map((capability) => capability.nativeId).sort(),
    ["private_stripe.products", "public.customers"],
  );
  assert.equal(definition.authentication[0]?.kind, "external-broker");
  assert.deepEqual(imported.executableCandidates.sort(), [
    "private_stripe.products",
    "public.customers",
  ]);
  assert.equal(imported.source.format.name, "supabase-wrappers");
  assert.equal(imported.source.byteLength, MIGRATION.length);
  // The raw migration text, with its vault secret, is not part of the import result.
  assert.equal(
    JSON.stringify(imported.definitions).includes("sk_test_CANARY"),
    false,
  );

  const exported = await adapter.export!(h.ctx, {
    definition,
    format: "supabase-wrappers-descriptor",
    includeNativeExtensions: false,
  });
  const payload = JSON.parse(Buffer.from(exported.bytes).toString("utf8")) as {
    capabilities: Array<{ nativeId: string; rowLevelSecurity: string }>;
  };
  assert.equal(exported.mediaType, "application/json");
  for (const capability of payload.capabilities)
    assert.equal(capability.rowLevelSecurity, "not-available");

  // An unknown media type and an unknown export format are refused.
  await assert.rejects(
    () =>
      adapter.import!(h.ctx, {
        bytes: new TextEncoder().encode("{}"),
        mediaType: "application/x-tar",
        origin: { kind: "upload" },
      }),
    (error: unknown) =>
      error instanceof ConnectorError && error.code === "unsupported",
  );
  await assert.rejects(
    () =>
      adapter.export!(h.ctx, {
        definition,
        format: "openapi-3.1",
        includeNativeExtensions: false,
      }),
    (error: unknown) =>
      error instanceof ConnectorError && error.code === "unsupported",
  );
});

test("Discovery marks which foreign tables the binding approved", async (t) => {
  const adapter = createSupabaseWrappersAdapter({
    query: queryPort([], {
      ...CATALOG,
      foreignTables: [
        ...CATALOG.foreignTables!,
        {
          schema: "public",
          name: "customers",
          server: "stripe_server",
          columns: [{ name: "id", type: "text" }],
          options: [],
        },
      ],
    }),
  });
  const h = await supabaseHarness({
    binding: wrappersBinding({ settings: SETTINGS }),
    fetch,
    connection: { lifecycle: "active" },
  });
  t.after(() => h.close());
  const discovered = await adapter.discover!(h.ctx, {});
  const approved = discovered.items.find(
    (item) => item.identity.nativeId === "private_stripe.products",
  );
  assert.equal(approved?.provenance?.approved, "true");
  assert.equal(approved?.provenance?.rowLevelSecurity, "not-available");
  const unapproved = discovered.items.find(
    (item) => item.identity.nativeId === "public.customers",
  );
  assert.equal(unapproved?.provenance?.approved, "false");
  assert.ok(
    discovered.issues.some(
      (issue) => issue.code === "supabase.wrappers.rls-unavailable",
    ),
  );
});
