import { readFileSync } from "node:fs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { ConnectorError } from "../../../src/server/connectors/index.js";
import {
  createVercelConnectAdapter,
  vercelConnectOperationTable,
  vercelManagementBoundOperations,
  vercelOperationIds,
  vercelOperationRef,
  type VercelSettings,
} from "../../../src/server/connectors/providers/vercel/index.js";
import { startVercelConnect } from "../doubles/vercel-connect.js";
import {
  APP_ORIGIN,
  buildBinding,
  buildConnection,
  fixtureActor,
  harness,
  operatorActor,
} from "./harness.js";

/*
 * AC-VC-01: enumerate connectors and projects and invoke management
 * operations; the independent server observes the exact per-operation
 * version, path and schema, and the host's team/project/environment policy.
 * AC-VC-06 lives here too, for the administrative half: deleting a shared
 * connector needs authorization and an acknowledged impact list.
 */

const TEAM = "team_fixture";
const PROJECT = "prj_main";
const OTHER_PROJECT = "prj_other";
const CONNECTOR = "slack/acme-slack";

const settings = (overrides: Partial<VercelSettings> = {}): VercelSettings => ({
  project: { id: PROJECT, environment: "production" },
  profiles: {
    app: {
      connector: CONNECTOR,
      subject: { type: "app" },
      installation: { mode: "installation-free" },
      scopes: ["chat:write"],
    },
  },
  defaultProfile: "app",
  returnPath: "/connectors/vercel/return",
  ...overrides,
});

async function fixture(
  options: {
    connectors?: Parameters<typeof startVercelConnect>[0] extends infer T
      ? T extends { connectors?: infer C }
        ? C
        : never
      : never;
    canAdminister?: boolean;
  } = {},
) {
  const double = await startVercelConnect({
    teamId: TEAM,
    pageSize: 2,
    connectors: options.connectors ?? [
      {
        uid: CONNECTOR,
        type: "slack",
        typeName: "Slack",
        service: "slack",
        supportsTriggers: true,
        triggersEnabled: true,
        projects: {
          [PROJECT]: ["production", "preview"],
          [OTHER_PROJECT]: ["production"],
        },
      },
    ],
    credentials: [
      {
        token: "vma_management_token",
        kind: "management",
        teamId: TEAM,
        ...(options.canAdminister === false ? { canAdminister: false } : {}),
      },
      {
        token: "oidc_workload_token",
        kind: "workload",
        teamId: TEAM,
        projectId: PROJECT,
        environment: "production",
      },
    ],
  });
  return double;
}

function setup(
  double: Awaited<ReturnType<typeof startVercelConnect>>,
  input: {
    settings?: VercelSettings;
    projects?: string[];
    environments?: string[];
    connectors?: string[];
    actor?: typeof fixtureActor;
  } = {},
) {
  const test = harness(input.actor ? { actor: input.actor } : {});
  test.ports.configuration.set("VERCEL_TEAM_ID", TEAM);
  test.ports.configuration.set(
    "VERCEL_MANAGEMENT_TOKEN",
    "vma_management_token",
  );
  test.ports.configuration.set(
    "VERCEL_CONNECT_WORKLOAD_TOKEN",
    "oidc_workload_token",
  );
  const binding = buildBinding({
    apiOrigin: double.origin,
    teamId: TEAM,
    settings: input.settings ?? settings(),
    connectors: input.connectors ?? [CONNECTOR, "oauth/new-connector"],
    projects: input.projects ?? [PROJECT],
    environments: input.environments ?? ["production", "preview"],
  });
  const connection = buildConnection({ binding });
  return {
    test,
    binding,
    connection,
    ctx: test.context({ binding, connection }),
  };
}

const invoke = (
  adapter: ReturnType<typeof createVercelConnectAdapter>,
  ctx: Parameters<NonNullable<typeof adapter.invoke>>[0],
  id: (typeof vercelOperationIds)[number],
  input: unknown,
  commandId = `cmd-${id}-${Math.random().toString(36).slice(2)}`,
) =>
  adapter.invoke!(ctx, {
    operationRef: vercelOperationRef(id),
    input,
    commandId,
  });

test("the adapter's operation table transcribes the documented inventory exactly", () => {
  const inventory = JSON.parse(
    readFileSync(
      new URL("../fixtures/vercel/operation-inventory.json", import.meta.url),
      "utf8",
    ),
  ) as {
    operations: Array<{
      id: string;
      method: string;
      path: string;
      teamScoped: boolean;
      credential: string;
    }>;
    sdkObserved: Array<{ id: string; method: string; path: string }>;
  };
  for (const documented of inventory.operations) {
    const operation =
      vercelConnectOperationTable[
        documented.id as keyof typeof vercelConnectOperationTable
      ];
    assert.ok(operation, `${documented.id} is missing from the adapter table`);
    assert.equal(operation.method, documented.method, documented.id);
    assert.equal(operation.pathTemplate, documented.path, documented.id);
    assert.equal(
      operation.version,
      documented.path.split("/")[1],
      `${documented.id} version prefix`,
    );
    assert.equal(operation.teamQuery, documented.teamScoped, documented.id);
    assert.equal(operation.credential, documented.credential, documented.id);
    assert.equal(operation.provenance, "rest-openapi", documented.id);
  }
  for (const observed of inventory.sdkObserved) {
    const operation =
      vercelConnectOperationTable[
        observed.id as keyof typeof vercelConnectOperationTable
      ];
    assert.equal(operation.method, observed.method);
    assert.equal(operation.pathTemplate, observed.path);
    assert.equal(
      operation.provenance,
      "sdk-observed",
      "an endpoint the REST reference does not publish must say so",
    );
  }
  assert.equal(
    vercelOperationIds.length,
    inventory.operations.length + inventory.sdkObserved.length,
    "the adapter must not carry an operation the inventory does not list",
  );
});

test("bound management operations pin each documented method, path and version", () => {
  for (const bound of vercelManagementBoundOperations()) {
    const operation =
      vercelConnectOperationTable[
        bound.nativeId as keyof typeof vercelConnectOperationTable
      ];
    assert.equal(bound.transport.kind, "http");
    assert.equal(
      bound.transport.kind === "http" ? bound.transport.method : "",
      operation.method,
    );
    assert.equal(
      bound.transport.kind === "http" ? bound.transport.pathTemplate : "",
      operation.pathTemplate,
    );
    assert.equal(bound.destinationId, "api");
  }
});

test("every management operation reaches its own documented version and path", async (t) => {
  const double = await fixture();
  t.after(double.close);
  const { ctx } = setup(double);
  const adapter = createVercelConnectAdapter();

  const list = await invoke(adapter, ctx, "connect.connectors.list", {});
  assert.equal(list.state, "complete");
  const get = await invoke(adapter, ctx, "connect.connectors.get", {
    connector: CONNECTOR,
  });
  assert.equal(get.state, "complete");
  assert.equal(
    (get.output as { uid: string }).uid,
    CONNECTOR,
    "the connector uid round-trips through one layer of percent encoding",
  );
  const created = await invoke(adapter, ctx, "connect.connectors.create", {
    body: {
      uid: "oauth/new-connector",
      type: "oauth",
      name: "New connector",
      data: { clientId: "client-1", serverUrl: "https://auth.example.com" },
    },
  });
  assert.equal(created.state, "complete");
  const updated = await invoke(adapter, ctx, "connect.connectors.update", {
    connector: CONNECTOR,
    body: { name: "Acme Slack" },
  });
  assert.equal(updated.state, "complete");
  const linked = await invoke(adapter, ctx, "connect.projects.link", {
    connector: CONNECTOR,
    projectId: PROJECT,
    environments: ["production", "preview"],
  });
  assert.equal(linked.state, "complete");
  const link = await invoke(adapter, ctx, "connect.projects.get", {
    connector: CONNECTOR,
    projectId: PROJECT,
  });
  assert.equal(link.state, "complete");
  assert.deepEqual(
    (link.output as { enabledEnvironments: string[] }).enabledEnvironments,
    ["production", "preview"],
  );
  const projects = await invoke(adapter, ctx, "connect.connectors.projects", {
    connector: CONNECTOR,
  });
  assert.equal(projects.state, "complete");
  const projectConnectors = await invoke(
    adapter,
    ctx,
    "connect.projects.connectors",
    { projectId: PROJECT },
  );
  assert.equal(projectConnectors.state, "complete");
  const destinations = await invoke(
    adapter,
    ctx,
    "connect.triggers.destinations.replace",
    { connector: CONNECTOR, destinations: [] },
  );
  assert.equal(destinations.state, "complete");
  const unlinked = await invoke(adapter, ctx, "connect.projects.unlink", {
    connector: CONNECTOR,
    projectId: PROJECT,
  });
  assert.equal(unlinked.state, "complete");

  // The double refuses a request whose version prefix does not match the
  // documented one, so a single mismatch would have failed above.
  assert.deepEqual(double.violations, []);
  assert.equal(
    double.calls.filter((call) => call.route === "version-mismatch").length,
    0,
  );
  assert.equal(
    double.calls.filter((call) => call.route === "unmatched").length,
    0,
  );
  const expected = new Map<string, { method: string; version: string }>([
    ["connect.connectors.list", { method: "GET", version: "v2" }],
    ["connect.connectors.get", { method: "GET", version: "v1" }],
    ["connect.connectors.create", { method: "POST", version: "v1" }],
    ["connect.connectors.update", { method: "PATCH", version: "v2" }],
    ["connect.projects.link", { method: "POST", version: "v1" }],
    ["connect.projects.get", { method: "GET", version: "v1" }],
    ["connect.projects.unlink", { method: "DELETE", version: "v1" }],
    ["connect.connectors.projects", { method: "GET", version: "v2" }],
    ["connect.projects.connectors", { method: "GET", version: "v2" }],
    [
      "connect.triggers.destinations.replace",
      { method: "PATCH", version: "v1" },
    ],
  ]);
  for (const [route, shape] of expected) {
    const calls = double.routed(route);
    assert.equal(calls.length, 1, `${route} was called once`);
    assert.equal(calls[0]!.method, shape.method, route);
    assert.equal(calls[0]!.version, shape.version, route);
    assert.deepEqual(calls[0]!.query["teamId"], [TEAM], `${route} team scope`);
    assert.match(
      calls[0]!.headers["authorization"] ?? "",
      /^Bearer vma_management_token$/,
      `${route} uses the management credential`,
    );
  }
  assert.equal(
    double.routed("connect.connectors.get")[0]!.path,
    "/v1/connect/connectors/slack%2Facme-slack",
    "the connector uid is percent-encoded once, never twice and never split",
  );
});

test("pagination follows the documented pagination.next cursor", async (t) => {
  const double = await fixture({
    connectors: [
      { uid: "oauth/a", projects: { [PROJECT]: ["production"] } },
      { uid: "oauth/b", projects: { [PROJECT]: ["production"] } },
      { uid: "oauth/c", projects: { [PROJECT]: ["production"] } },
    ],
  });
  t.after(double.close);
  const { ctx } = setup(double, {
    connectors: ["oauth/a", "oauth/b", "oauth/c"],
  });
  const adapter = createVercelConnectAdapter();
  const first = (
    await invoke(adapter, ctx, "connect.connectors.list", { limit: 2 })
  ).output as {
    connectors: Array<{ uid: string }>;
    pagination: { next: string | null };
  };
  assert.equal(first.connectors.length, 2);
  assert.ok(first.pagination.next, "a full page carries a cursor");
  const second = (
    await invoke(adapter, ctx, "connect.connectors.list", {
      limit: 2,
      cursor: first.pagination.next,
    })
  ).output as {
    connectors: Array<{ uid: string }>;
    pagination: { next: string | null };
  };
  assert.equal(second.connectors.length, 1);
  assert.equal(second.pagination.next, null);
  assert.deepEqual(
    [...first.connectors, ...second.connectors].map((item) => item.uid),
    ["oauth/a", "oauth/b", "oauth/c"],
  );
});

test("an unpermitted project or environment is refused before any provider call", async (t) => {
  const double = await fixture();
  t.after(double.close);
  const { ctx } = setup(double);
  const adapter = createVercelConnectAdapter();
  const before = double.calls.length;
  await assert.rejects(
    invoke(adapter, ctx, "connect.projects.link", {
      connector: CONNECTOR,
      projectId: OTHER_PROJECT,
      environments: ["production"],
    }),
    (error: unknown) =>
      error instanceof ConnectorError &&
      error.code === "denied" &&
      error.detail === "vercel.project.not-permitted",
  );
  await assert.rejects(
    invoke(adapter, ctx, "connect.projects.link", {
      connector: CONNECTOR,
      projectId: PROJECT,
      environments: ["production", "development"],
    }),
    (error: unknown) =>
      error instanceof ConnectorError &&
      error.detail === "vercel.environment.not-permitted",
  );
  await assert.rejects(
    invoke(adapter, ctx, "connect.connectors.get", {
      connector: "oauth/not-reviewed",
    }),
    (error: unknown) =>
      error instanceof ConnectorError &&
      error.detail === "vercel.connector.not-permitted",
  );
  assert.equal(
    double.calls.length,
    before,
    "policy failures never reach the provider",
  );
});

test("a caller cannot substitute the team; scope comes from configuration", async (t) => {
  const double = await fixture();
  t.after(double.close);
  const { ctx } = setup(double);
  const adapter = createVercelConnectAdapter();
  await assert.rejects(
    adapter.invoke!(ctx, {
      operationRef: vercelOperationRef("connect.connectors.list"),
      input: { teamId: "team_someone_else" },
      commandId: "cmd-forged-team",
    }),
    (error: unknown) =>
      error instanceof ConnectorError && error.code === "invalid-request",
    "teamId is not an input the caller may name",
  );
  await invoke(adapter, ctx, "connect.connectors.list", {});
  const call = double.routed("connect.connectors.list").at(-1)!;
  assert.deepEqual(call.query["teamId"], [TEAM]);
  assert.equal(call.query["slug"], undefined);
});

test("administrative operations require the admin capability; reads do not", async (t) => {
  const double = await fixture();
  t.after(double.close);
  const { ctx } = setup(double, { actor: operatorActor });
  const adapter = createVercelConnectAdapter();
  for (const id of [
    "connect.connectors.create",
    "connect.connectors.update",
    "connect.connectors.delete",
    "connect.projects.link",
    "connect.projects.unlink",
    "connect.triggers.destinations.replace",
  ] as const) {
    const input =
      id === "connect.connectors.create"
        ? { body: { uid: "oauth/new-connector", type: "oauth", data: {} } }
        : id === "connect.connectors.update"
          ? { connector: CONNECTOR, body: { name: "x" } }
          : id === "connect.projects.link"
            ? {
                connector: CONNECTOR,
                projectId: PROJECT,
                environments: ["production"],
              }
            : id === "connect.projects.unlink"
              ? { connector: CONNECTOR, projectId: PROJECT }
              : id === "connect.triggers.destinations.replace"
                ? { connector: CONNECTOR, destinations: [] }
                : { connector: CONNECTOR };
    await assert.rejects(
      invoke(adapter, ctx, id, input),
      (error: unknown) =>
        error instanceof ConnectorError &&
        error.code === "denied" &&
        error.detail === "vercel.admin-required",
      `${id} needs administrative authorization`,
    );
  }
  const read = await invoke(adapter, ctx, "connect.connectors.get", {
    connector: CONNECTOR,
  });
  assert.equal(read.state, "complete", "an ordinary read stays available");
});

test("deleting a shared connector requires an acknowledged impact list", async (t) => {
  const double = await fixture();
  t.after(double.close);
  const { ctx } = setup(double);
  const adapter = createVercelConnectAdapter();

  const blocked = await invoke(adapter, ctx, "connect.connectors.delete", {
    connector: CONNECTOR,
  });
  assert.equal(blocked.state, "human-required");
  assert.equal(blocked.code, "vercel.connector.shared");
  assert.deepEqual(blocked.output, { sharedWith: [OTHER_PROJECT] });
  assert.equal(
    double.routed("connect.connectors.delete").length,
    0,
    "nothing was deleted while the impact was unacknowledged",
  );

  const wrongList = await invoke(adapter, ctx, "connect.connectors.delete", {
    connector: CONNECTOR,
    acknowledgeSharedWith: ["prj_guessed"],
  });
  assert.equal(
    wrongList.state,
    "human-required",
    "acknowledging a different set is not acknowledgement",
  );

  const applied = await invoke(adapter, ctx, "connect.connectors.delete", {
    connector: CONNECTOR,
    acknowledgeSharedWith: [OTHER_PROJECT],
  });
  assert.equal(applied.state, "complete");
  assert.equal(double.routed("connect.connectors.delete").length, 1);
  assert.equal(double.connector(CONNECTOR), undefined);
});

test("a repeated delete command reconciles instead of deleting twice", async (t) => {
  const double = await fixture({
    connectors: [{ uid: CONNECTOR, projects: { [PROJECT]: ["production"] } }],
  });
  t.after(double.close);
  const { ctx } = setup(double);
  const adapter = createVercelConnectAdapter();
  const first = await invoke(
    adapter,
    ctx,
    "connect.connectors.delete",
    { connector: CONNECTOR },
    "cmd-delete-once",
  );
  assert.equal(first.state, "complete");
  const repeat = await invoke(
    adapter,
    ctx,
    "connect.connectors.delete",
    { connector: CONNECTOR },
    "cmd-delete-once",
  );
  assert.equal(repeat.state, "complete");
  assert.equal(repeat.code, "vercel.effect.already-applied");
  assert.equal(
    double.routed("connect.connectors.delete").length,
    1,
    "the journal stopped the second delete from reaching the provider",
  );
});

test("reconciliation compares the enabled environments as sets, not by length", async (t) => {
  const double = await fixture();
  t.after(double.close);
  const { test: h, binding, connection, ctx } = setup(double);
  const adapter = createVercelConnectAdapter();
  assert.deepEqual(
    double.connector(CONNECTOR)?.projects[PROJECT],
    ["production", "preview"],
    "the upstream link the interrupted attempt races against",
  );

  // Cut the first attempt off on the way out: the journal then holds an intent
  // whose outcome nobody knows, which is the state a retry reconciles.
  const cutOff: typeof fetch = async (input, init) => {
    const url = new URL(
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.href
          : input.url,
    );
    if (init?.method === "POST" && url.pathname.includes("/projects/"))
      throw new Error("connection reset while linking");
    return fetch(input, init);
  };
  const request = {
    operationRef: vercelOperationRef("connect.projects.link"),
    input: {
      connector: CONNECTOR,
      projectId: PROJECT,
      // One environment, named twice. Nothing refines duplicates away on the
      // way in, so reconciliation must not read this as two environments.
      environments: ["production", "production"],
    },
    commandId: "cmd-link-duplicate-environment",
  };
  const interrupted = await adapter.invoke!(
    {
      ...h.context({ binding, connection }),
      environment: h.ports.environment({ fetch: cutOff, origin: APP_ORIGIN }),
    },
    request,
  );
  assert.equal(interrupted.state, "indeterminate");
  assert.equal(interrupted.code, "vercel.effect.indeterminate");
  assert.equal(double.routed("connect.projects.link").length, 0);

  const retried = await adapter.invoke!(ctx, request);
  assert.equal(retried.state, "complete");
  assert.notEqual(
    retried.code,
    "vercel.effect.reconciled",
    "a link that also enables preview does not match an intent that does not",
  );
  assert.deepEqual(
    double.connector(CONNECTOR)?.projects[PROJECT],
    ["production"],
    "the retry applied the intent instead of reporting it already met",
  );
  assert.equal(double.routed("connect.projects.link").length, 1);
});

test("upstream failures are sanitized into codes, never provider prose", async (t) => {
  const double = await fixture({ canAdminister: false });
  t.after(double.close);
  const { ctx } = setup(double);
  const adapter = createVercelConnectAdapter();
  await assert.rejects(
    invoke(adapter, ctx, "connect.projects.link", {
      connector: CONNECTOR,
      projectId: PROJECT,
      environments: ["production"],
    }),
    (error: unknown) => {
      assert.ok(error instanceof ConnectorError);
      assert.equal(error.code, "denied");
      assert.equal(error.detail, "vercel.forbidden");
      assert.doesNotMatch(error.message, /Not authorized/);
      return true;
    },
  );
});

test("discovery lists the configured team's connectors and marks what the binding approved", async (t) => {
  const double = await fixture();
  t.after(double.close);
  const { ctx } = setup(double);
  const adapter = createVercelConnectAdapter();
  const result = await adapter.discover!(ctx, { limit: 10 });
  assert.equal(result.items.length, 1);
  const [item] = result.items;
  assert.equal(item!.identity.ecosystem, "vercel-connect");
  assert.equal(item!.identity.authorityNamespace, TEAM);
  assert.equal(item!.identity.nativeId, CONNECTOR);
  assert.equal(item!.provenance?.["permitted"], "true");
  assert.equal(result.freshness.source, "live");
  await assert.rejects(
    adapter.discover!(ctx, { scope: { teamId: "team_elsewhere" } }),
    (error: unknown) =>
      error instanceof ConnectorError &&
      error.detail === "vercel.scope.caller-supplied",
  );
  await assert.rejects(
    adapter.discover!(ctx, { scope: { projectId: OTHER_PROJECT } }),
    (error: unknown) =>
      error instanceof ConnectorError &&
      error.detail === "vercel.project.not-permitted",
  );
});
