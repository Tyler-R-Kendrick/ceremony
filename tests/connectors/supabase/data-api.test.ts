import assert from "node:assert/strict";
import { test } from "node:test";
import {
  classifyProjectKey,
  createSupabaseDataApiAdapter,
  createSupabaseManagementAdapter,
  postgrestFilterValue,
  supabaseLifecycleFor,
  type ProjectSessionHandle,
  type ProjectSessionPort,
} from "../../../src/server/connectors/providers/supabase/index.js";
import { ConnectorError } from "../../../src/server/connectors/errors.js";
import type { AuthorizationIntent } from "../../../src/server/connectors/adapter.js";
import {
  startSupabaseProjectDouble,
  type SupabaseProjectDouble,
} from "../doubles/supabase-project.js";
import {
  managementProject,
  startSupabaseManagementDouble,
} from "../doubles/supabase-management.js";
import {
  CALLBACK_PATH,
  HOST_ORIGIN,
  ORGANIZATION_SLUG,
  OTHER_PROJECT_REF,
  PROJECT_REF,
  dataApiBinding,
  managementBinding,
  supabaseHarness,
} from "../fixtures/supabase/harness.js";

/*
 * SB-03. Oracles: AC-SB-05 (a service-role key or a management token presented
 * through a project-user Data API flow is refused before any request) and
 * AC-SB-01 (a project-user session is never management access, tested with
 * both adapters present).
 */

const SETTINGS = {
  projectRef: PROJECT_REF,
  schema: "public",
  tables: {
    notes: {
      columns: ["id", "title", "owner"],
      filters: { id: ["eq", "in"], title: ["like", "ilike"] },
      orderBy: ["id"],
      maxRows: 10,
      rowLevelSecurity: "verified",
    },
  },
};

const intentFor = (
  overrides: Partial<AuthorizationIntent> = {},
): AuthorizationIntent => ({
  ownerKind: "user",
  requestedPermissions: [],
  accountSwitch: false,
  interruption: "allowed",
  ...overrides,
});

async function startProject(
  options: Parameters<typeof startSupabaseProjectDouble>[0] = {},
) {
  return startSupabaseProjectDouble({
    projectRef: PROJECT_REF,
    users: [{ id: "project-user-1", email: "user@example.test" }],
    tables: [
      {
        name: "notes",
        rows: [
          { id: 1, title: "mine", owner: "project-user-1" },
          { id: 2, title: "also mine", owner: "project-user-1" },
          { id: 3, title: "someone else", owner: "project-user-2" },
        ],
      },
      {
        name: "audit_log",
        rows: [{ id: 1, title: "not approved", owner: "project-user-1" }],
      },
      {
        name: "wide_open",
        rows: [{ id: 1, title: "everyone sees this", owner: "project-user-2" }],
        rlsDisabled: true,
      },
      { name: "internal", rows: [], notExposed: true },
    ],
    ...options,
  });
}

/** The host's session port: the existing project sign-in ceremony resolved a verified session. */
function sessionPort(
  double: SupabaseProjectDouble,
  session: { accessToken: string; userId: string; expiresAt: number },
  overrides: Partial<Omit<ProjectSessionHandle, "use">> = {},
): ProjectSessionPort & { uses: number } {
  const port = {
    uses: 0,
    async resolve(): Promise<ProjectSessionHandle> {
      return {
        kind: "project-user-session",
        projectRef: double.projectRef,
        userId: session.userId,
        expiresAt: session.expiresAt,
        assurance: "aal1",
        ...overrides,
        async use<T>(work: (accessToken: string) => Promise<T>): Promise<T> {
          port.uses++;
          return work(session.accessToken);
        },
      };
    },
  };
  return port;
}

test("AC-SB-05: a service-role secret is refused before any request reaches the project", async (t) => {
  const double = await startProject();
  t.after(() => double.close());
  const session = await double.issueSession("project-user-1");
  const adapter = createSupabaseDataApiAdapter({
    sessions: sessionPort(double, session),
  });
  const h = await supabaseHarness({
    binding: dataApiBinding({ origin: double.origin, settings: SETTINGS }),
    fetch,
    connection: {
      target: { kind: "supabase-project", id: PROJECT_REF },
      lifecycle: "active",
    },
    // A secret key configured where the publishable key belongs.
    configuration: { SUPABASE_PUBLISHABLE_KEY: double.secretKey },
  });
  t.after(() => h.close());

  await assert.rejects(
    () =>
      adapter.invoke!(h.ctx, {
        operationRef: "operation:select",
        input: { table: "notes" },
        commandId: "command-1",
      }),
    (error: unknown) =>
      error instanceof ConnectorError &&
      error.code === "denied" &&
      error.detail === "supabase.credential.kind-confusion",
  );
  assert.equal(
    double.requests.length,
    0,
    "credential-kind confusion is refused before the request exists",
  );
  assert.equal(
    double.observed.secretKeyPresented,
    false,
    "the secret key never left the host",
  );

  // Legacy service_role JWTs are classified the same way, by kind, not by
  // guessing from a value in a log.
  assert.equal(classifyProjectKey(double.secretKey), "service-role-secret");
  assert.equal(classifyProjectKey(double.publishableKey), "publishable-key");
  assert.equal(classifyProjectKey("sb_publishable_abc"), "publishable-key");
  assert.equal(classifyProjectKey("not-a-key"), "unknown");
});

test("AC-SB-05: a management token presented as the project session is refused by kind", async (t) => {
  const double = await startProject();
  t.after(() => double.close());
  const session = await double.issueSession("project-user-1");
  // The host resolves a session whose credential kind is a management token.
  const adapter = createSupabaseDataApiAdapter({
    sessions: sessionPort(double, session, {
      kind: "management-access-token",
    }),
  });
  const h = await supabaseHarness({
    binding: dataApiBinding({ origin: double.origin, settings: SETTINGS }),
    fetch,
    connection: {
      target: { kind: "supabase-project", id: PROJECT_REF },
      lifecycle: "active",
    },
    configuration: { SUPABASE_PUBLISHABLE_KEY: double.publishableKey },
  });
  t.after(() => h.close());

  await assert.rejects(
    () =>
      adapter.invoke!(h.ctx, {
        operationRef: "operation:select",
        input: { table: "notes" },
        commandId: "command-1",
      }),
    (error: unknown) =>
      error instanceof ConnectorError &&
      error.code === "denied" &&
      error.detail === "supabase.credential.kind-confusion",
  );
  assert.equal(double.requests.length, 0);
});

test("AC-SB-01: a project-user session is not management access, with both adapters present", async (t) => {
  const project = await startProject();
  t.after(() => project.close());
  const management = await startSupabaseManagementDouble({
    projects: [managementProject(PROJECT_REF, ORGANIZATION_SLUG)],
    redirectUris: [`${HOST_ORIGIN}${CALLBACK_PATH}`],
  });
  t.after(() => management.close());
  const session = await project.issueSession("project-user-1");

  const dataApi = createSupabaseDataApiAdapter({
    sessions: sessionPort(project, session),
  });
  const managementAdapter = createSupabaseManagementAdapter();
  assert.notEqual(dataApi.id, managementAdapter.id);

  // The project user signs in and reads project data: that works.
  const projectHarness = await supabaseHarness({
    binding: dataApiBinding({ origin: project.origin, settings: SETTINGS }),
    fetch,
    connection: {
      target: { kind: "supabase-project", id: PROJECT_REF },
      lifecycle: "active",
    },
    configuration: { SUPABASE_PUBLISHABLE_KEY: project.publishableKey },
  });
  t.after(() => projectHarness.close());
  const verified = await dataApi.verify!(projectHarness.ctx);
  assert.equal(verified.state, "complete");
  const identity = verified.claims.find(
    (claim) => claim.kind === "account-identity",
  )!;
  assert.equal(identity.target.kind, "supabase-project-user");
  assert.ok(
    identity.limitations.some((item) => item.includes("dashboard")),
    "the claim must say this is not a dashboard account",
  );

  // The same person now wants management access. The project session buys
  // nothing: the management profile still requires its own authorization.
  const managementHarness = await supabaseHarness({
    binding: managementBinding({ origin: management.origin }),
    fetch,
    connection: null,
    configuration: {
      SUPABASE_OAUTH_CLIENT_ID: management.clientId,
      SUPABASE_OAUTH_CLIENT_SECRET: management.clientSecret,
    },
  });
  t.after(() => managementHarness.close());
  const start = await managementAdapter.authorize(
    managementHarness.ctx,
    intentFor({ target: { kind: "supabase-project", id: PROJECT_REF } }),
  );
  assert.equal(start.kind, "handoff");
  assert.equal(
    (start as { handoff: { kind: string } }).handoff.kind,
    "provider-browser",
    "management access needs its own provider authorization, not the project session",
  );

  // Handing the project session to the Management API is refused by custody:
  // the credential kinds are different and the check happens before a request.
  const scope = {
    tenantId: managementHarness.ctx.actor.tenantId,
    ownerKind: "user" as const,
    ownerId: managementHarness.ctx.actor.subjectId,
    connectionRef: managementHarness.connection.connectionRef,
    bindingRef: managementHarness.ctx.binding.bindingRef,
    custody: "host-owned" as const,
  };
  const smuggled = await managementHarness.ports.credentials.store(scope, {
    kind: "project-user-session",
    access_token: session.accessToken,
    token_type: "Bearer",
    client_id: management.clientId,
    issued_at: String(Date.now()),
  });
  const before = management.requests.length;
  await assert.rejects(
    () =>
      managementAdapter.invoke(
        managementHarness.with({
          credentialRef: smuggled,
          target: { kind: "supabase-project", id: PROJECT_REF },
          lifecycle: "active",
        }),
        {
          operationRef: "operation:v1-get-project",
          input: { ref: PROJECT_REF },
          commandId: "command-1",
        },
      ),
    (error: unknown) =>
      error instanceof ConnectorError &&
      error.code === "denied" &&
      error.detail === "supabase.credential.kind-confusion",
  );
  assert.equal(
    management.requests.length,
    before,
    "a project session must never be sent to api.supabase.com",
  );
});

test("Approved selects run as the project user; unapproved tables, columns and filters are refused", async (t) => {
  const double = await startProject();
  t.after(() => double.close());
  const session = await double.issueSession("project-user-1");
  const port = sessionPort(double, session);
  const adapter = createSupabaseDataApiAdapter({ sessions: port });
  const h = await supabaseHarness({
    binding: dataApiBinding({ origin: double.origin, settings: SETTINGS }),
    fetch,
    connection: {
      target: { kind: "supabase-project", id: PROJECT_REF },
      lifecycle: "active",
    },
    configuration: { SUPABASE_PUBLISHABLE_KEY: double.publishableKey },
  });
  t.after(() => h.close());

  const result = await adapter.invoke!(h.ctx, {
    operationRef: "operation:select",
    input: {
      table: "notes",
      select: ["id", "title"],
      filters: [{ column: "id", operator: "in", value: [1, 2, 3] }],
      order: { column: "id", direction: "asc" },
      limit: 5,
    },
    commandId: "command-1",
  });
  assert.equal(result.state, "complete");
  assert.equal(result.effect, "read");
  assert.equal(result.outputClassification, "personal");
  const output = result.output as {
    rows: Array<Record<string, unknown>>;
    columns: string[];
    rowLevelSecurity: string;
  };
  // Row Level Security did the filtering: row 3 belongs to another user.
  assert.deepEqual(output.rows, [
    { id: 1, title: "mine" },
    { id: 2, title: "also mine" },
  ]);
  assert.equal(output.rowLevelSecurity, "verified");

  // The wire request is the documented PostgREST form.
  const query = double.observed.restQueries.at(-1)!;
  assert.equal(query.get("select"), "id,title");
  assert.equal(query.get("id"), "in.(1,2,3)");
  assert.equal(query.get("order"), "id.asc");
  assert.equal(query.get("limit"), "5");
  const request = double.received("GET", "/rest/v1/notes").at(-1)!;
  assert.equal(request.headers.apikey, double.publishableKey);
  assert.equal(
    request.headers.authorization,
    `Bearer ${session.accessToken}`,
    "the user's token authorizes, the publishable key identifies the project",
  );
  assert.notEqual(
    request.headers.apikey,
    request.headers.authorization?.slice(7),
    "the apikey is not the user's token",
  );

  const denials: Array<[string, unknown]> = [
    ["supabase.data-api.table-not-approved", { table: "audit_log" }],
    [
      "supabase.data-api.column-not-approved",
      { table: "notes", select: ["id", "secret_column"] },
    ],
    [
      "supabase.data-api.filter-not-approved",
      {
        table: "notes",
        filters: [{ column: "owner", operator: "eq", value: "project-user-2" }],
      },
    ],
    [
      "supabase.data-api.filter-not-approved",
      { table: "notes", filters: [{ column: "id", operator: "gt", value: 1 }] },
    ],
    [
      "supabase.data-api.order-not-approved",
      { table: "notes", order: { column: "title", direction: "asc" } },
    ],
  ];
  const requestsBefore = double.requests.length;
  for (const [detail, input] of denials)
    await assert.rejects(
      () =>
        adapter.invoke!(h.ctx, {
          operationRef: "operation:select",
          input,
          commandId: "command-x",
        }),
      (error: unknown) =>
        error instanceof ConnectorError &&
        error.code === "denied" &&
        error.detail === detail,
      `expected ${detail}`,
    );
  assert.equal(
    double.requests.length,
    requestsBefore,
    "every policy refusal happens before the request",
  );

  // The approved ceiling wins over a larger caller-supplied limit.
  const capped = await adapter.invoke!(h.ctx, {
    operationRef: "operation:select",
    input: { table: "notes", limit: 900 },
    commandId: "command-2",
  });
  assert.equal(capped.state, "complete");
  assert.equal(double.observed.restQueries.at(-1)!.get("limit"), "10");
});

test("A table whose Row Level Security review is unverified is flagged on every result", async (t) => {
  const double = await startProject();
  t.after(() => double.close());
  const session = await double.issueSession("project-user-1");
  const adapter = createSupabaseDataApiAdapter({
    sessions: sessionPort(double, session),
  });
  const h = await supabaseHarness({
    binding: dataApiBinding({
      origin: double.origin,
      settings: {
        projectRef: PROJECT_REF,
        schema: "public",
        tables: {
          wide_open: {
            columns: ["id", "title"],
            filters: {},
            maxRows: 10,
            rowLevelSecurity: "unverified",
          },
        },
      },
      permittedTargets: [
        { kind: "supabase-project", id: PROJECT_REF },
        { kind: "supabase-table", id: "wide_open" },
      ],
    }),
    fetch,
    connection: {
      target: { kind: "supabase-project", id: PROJECT_REF },
      lifecycle: "active",
    },
    configuration: { SUPABASE_PUBLISHABLE_KEY: double.publishableKey },
  });
  t.after(() => h.close());

  const result = await adapter.invoke!(h.ctx, {
    operationRef: "operation:select",
    input: { table: "wide_open" },
    commandId: "command-1",
  });
  assert.equal(result.state, "complete");
  assert.equal(result.code, "supabase.data-api.rls-unverified");
  assert.equal(
    (result.output as { rowLevelSecurity: string }).rowLevelSecurity,
    "unverified",
  );
  // The rows of another user came back, which is exactly why the missing
  // policy must be reported rather than assumed away.
  assert.equal((result.output as { rows: unknown[] }).rows.length, 1);

  const verified = await adapter.verify!(h.ctx);
  assert.equal(verified.state, "complete");
  const access = verified.claims.find(
    (claim) => claim.kind === "resource-access",
  )!;
  assert.ok(
    access.limitations.some((item) =>
      item.includes("Row Level Security review unverified for table wide_open"),
    ),
  );
});

test("Session expiry maps to reconnect-required and a wrong project is refused", async (t) => {
  const double = await startProject();
  t.after(() => double.close());
  const session = await double.issueSession("project-user-1");
  const adapter = createSupabaseDataApiAdapter({
    sessions: sessionPort(double, session, { expiresAt: Date.now() - 1000 }),
  });
  const h = await supabaseHarness({
    binding: dataApiBinding({ origin: double.origin, settings: SETTINGS }),
    fetch,
    connection: {
      target: { kind: "supabase-project", id: PROJECT_REF },
      lifecycle: "active",
    },
    configuration: { SUPABASE_PUBLISHABLE_KEY: double.publishableKey },
  });
  t.after(() => h.close());

  const expired = await adapter.invoke!(h.ctx, {
    operationRef: "operation:select",
    input: { table: "notes" },
    commandId: "command-1",
  }).then(
    () => undefined,
    (error: unknown) => error,
  );
  assert.ok(expired instanceof ConnectorError);
  assert.equal((expired as ConnectorError).code, "expired");
  assert.equal(supabaseLifecycleFor(expired), "reconnect-required");
  assert.equal(double.requests.length, 0);
  const verified = await adapter.verify!(h.ctx);
  assert.equal(verified.state, "expired");

  // A connection bound to another project cannot borrow this one's session.
  const fresh = await double.issueSession("project-user-1");
  const other = createSupabaseDataApiAdapter({
    sessions: sessionPort(double, fresh),
  });
  const mismatched = await supabaseHarness({
    binding: dataApiBinding({
      origin: double.origin,
      settings: SETTINGS,
      permittedTargets: [
        { kind: "supabase-project", id: PROJECT_REF },
        { kind: "supabase-project", id: OTHER_PROJECT_REF },
        { kind: "supabase-table", id: "notes" },
      ],
    }),
    fetch,
    connection: {
      target: { kind: "supabase-project", id: OTHER_PROJECT_REF },
      lifecycle: "active",
    },
    configuration: { SUPABASE_PUBLISHABLE_KEY: double.publishableKey },
  });
  t.after(() => mismatched.close());
  await assert.rejects(
    () =>
      other.invoke!(mismatched.ctx, {
        operationRef: "operation:select",
        input: { table: "notes" },
        commandId: "command-2",
      }),
    (error: unknown) =>
      error instanceof ConnectorError &&
      error.detail === "supabase.project.mismatch",
  );
});

test("A destination that is not the project's own origin is refused", async (t) => {
  const double = await startProject();
  t.after(() => double.close());
  const session = await double.issueSession("project-user-1");
  const adapter = createSupabaseDataApiAdapter({
    sessions: sessionPort(double, session),
  });
  const h = await supabaseHarness({
    binding: dataApiBinding({
      origin: double.origin,
      settings: SETTINGS,
      overrides: {
        destinations: [
          {
            id: "project",
            origin: `https://${OTHER_PROJECT_REF}.supabase.co`,
            network: "public",
          },
        ],
      },
    }),
    fetch,
    connection: {
      target: { kind: "supabase-project", id: PROJECT_REF },
      lifecycle: "active",
    },
    configuration: { SUPABASE_PUBLISHABLE_KEY: double.publishableKey },
  });
  t.after(() => h.close());
  await assert.rejects(
    () =>
      adapter.invoke!(h.ctx, {
        operationRef: "operation:select",
        input: { table: "notes" },
        commandId: "command-1",
      }),
    (error: unknown) =>
      error instanceof ConnectorError &&
      error.code === "network-policy" &&
      error.detail === "supabase.data-api.destination-not-pinned",
  );
});

test("PostgREST filter values follow the documented operator.value grammar", () => {
  assert.equal(
    postgrestFilterValue({ column: "id", operator: "eq", value: 4 }),
    "eq.4",
  );
  assert.equal(
    postgrestFilterValue({
      column: "title",
      operator: "ilike",
      value: "*draft*",
    }),
    "ilike.*draft*",
  );
  assert.equal(
    postgrestFilterValue({ column: "id", operator: "in", value: [1, 2] }),
    "in.(1,2)",
  );
  // Values containing a comma are double-quoted, as the URL grammar requires.
  assert.equal(
    postgrestFilterValue({
      column: "name",
      operator: "in",
      value: ["Hebdon,John", "Williams,Mary"],
    }),
    'in.("Hebdon,John","Williams,Mary")',
  );
  assert.equal(
    postgrestFilterValue({ column: "deleted", operator: "is", value: null }),
    "is.null",
  );
  assert.throws(
    () => postgrestFilterValue({ column: "id", operator: "eq", value: null }),
    ConnectorError,
  );
  assert.throws(
    () => postgrestFilterValue({ column: "id", operator: "in", value: 1 }),
    ConnectorError,
  );
});

test("Authorization reports what is missing instead of inventing a project sign-in", async (t) => {
  const double = await startProject();
  t.after(() => double.close());
  const session = await double.issueSession("project-user-1");

  const unconfigured = await supabaseHarness({
    binding: dataApiBinding({ origin: double.origin, settings: SETTINGS }),
    fetch,
    connection: {
      target: { kind: "supabase-project", id: PROJECT_REF },
      lifecycle: "authorization-required",
    },
    configuration: {},
  });
  t.after(() => unconfigured.close());
  const adapter = createSupabaseDataApiAdapter({
    sessions: sessionPort(double, session),
  });
  const missing = await adapter.authorize!(unconfigured.ctx, intentFor());
  assert.equal(missing.kind, "configuration-required");
  assert.deepEqual((missing as { missing: string[] }).missing, [
    "SUPABASE_PUBLISHABLE_KEY",
  ]);

  // Configured, but the host has no session yet: a person must sign in through
  // the existing ceremony; this profile never collects credentials itself.
  const noSession = await supabaseHarness({
    binding: dataApiBinding({ origin: double.origin, settings: SETTINGS }),
    fetch,
    connection: {
      target: { kind: "supabase-project", id: PROJECT_REF },
      lifecycle: "authorization-required",
    },
    configuration: { SUPABASE_PUBLISHABLE_KEY: double.publishableKey },
  });
  t.after(() => noSession.close());
  const without = createSupabaseDataApiAdapter({
    sessions: {
      async resolve() {
        return undefined;
      },
    },
  });
  const human = await without.authorize!(noSession.ctx, intentFor());
  assert.equal(human.kind, "human-required");
  assert.equal(
    (human as { code: string }).code,
    "supabase.project-session.required",
  );
  assert.equal(
    without
      .capabilities(new Set(["SUPABASE_PUBLISHABLE_KEY"]))
      .find((row) => row.dimension === "revoke")?.implementation,
    "unsupported",
    "signing out belongs to the project sign-in ceremony",
  );
});
