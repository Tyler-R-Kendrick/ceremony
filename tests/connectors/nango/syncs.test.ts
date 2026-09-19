import assert from "node:assert/strict";
import { test } from "node:test";
import { ConnectorError } from "../../../src/server/connectors/errors.js";
import {
  activeConnection,
  CONNECTION_ID,
  connectionRow,
  harness,
  INTEGRATION,
  readOperation,
  syncOperation,
} from "./harness.js";
import { fixtureActor } from "../doubles/ports.js";

/*
 * NG-05 sync delegation and the NG-06 disconnect boundary: Nango owns the
 * sync engine and its checkpoints, so this adapter only asks it to run,
 * schedule, pause and report; and local unlink, broker deletion and upstream
 * revocation stay three separate effects.
 */

const statusRows = [
  {
    id: "sync-1",
    connection_id: CONNECTION_ID,
    name: "github-issues",
    status: "SUCCESS" as const,
    type: "INCREMENTAL" as const,
    finishedAt: "2026-03-02T00:00:00.000Z",
    nextScheduledSyncAt: "2026-03-02T01:00:00.000Z",
    frequency: "every hour",
    latestResult: { GithubIssue: { added: 1, updated: 0, deleted: 0 } },
    recordCount: { GithubIssue: 42 },
    checkpoint: { page: 7 },
  },
];

async function syncHarness(extra: Parameters<typeof harness>[0] = {}) {
  return harness({
    double: {
      connections: [connectionRow()],
      syncStatus: statusRows,
      ...extra.double,
    },
    binding: { operations: [syncOperation, readOperation], ...extra.binding },
    ...extra,
  });
}

test("NG-05: a delegated sync triggers through the documented endpoint for one connection", async (t) => {
  const h = await syncHarness();
  t.after(() => h.close());
  const connection = await activeConnection(h.ports, h.binding);
  const result = await h.adapter.delegate!(h.context({ connection }), {
    skill: syncOperation.operationRef,
    input: {},
    commandId: "cmd-sync-1",
    action: "start",
  });

  assert.equal(result.state, "complete");
  const [command] = h.double.syncCommands;
  assert.equal(command?.command, "trigger");
  assert.equal(command?.body.provider_config_key, INTEGRATION);
  // A connection id is always sent: omitting it means "all connections" in
  // Nango's API, which would be a far wider effect than the caller asked for.
  assert.equal(command?.body.connection_id, CONNECTION_ID);
  assert.deepEqual(command?.body.syncs, [{ name: "github-issues" }]);
});

test("NG-05: scheduling uses /sync/start and cancel maps to the documented /sync/pause", async (t) => {
  const h = await syncHarness();
  t.after(() => h.close());
  const connection = await activeConnection(h.ports, h.binding);

  const scheduled = await h.adapter.delegate!(h.context({ connection }), {
    skill: syncOperation.operationRef,
    input: { mode: "schedule" },
    commandId: "cmd-start",
    action: "start",
  });
  assert.equal(scheduled.state, "complete");
  assert.equal(h.double.syncCommands[0]?.command, "start");

  const cancelled = await h.adapter.delegate!(h.context({ connection }), {
    skill: syncOperation.operationRef,
    input: {},
    commandId: "cmd-cancel",
    action: "cancel",
  });
  assert.equal(cancelled.state, "complete");
  assert.equal(h.double.syncCommands[1]?.command, "pause");
  // Pausing a schedule is not cancelling a running job, and the result says so.
  assert.equal(cancelled.code, "nango.sync.cancel-maps-to-pause");
});

test("NG-05: status is reported verbatim, including Nango's own checkpoint", async (t) => {
  const h = await syncHarness();
  t.after(() => h.close());
  const connection = await activeConnection(h.ports, h.binding);
  const result = await h.adapter.delegate!(h.context({ connection }), {
    skill: syncOperation.operationRef,
    input: {},
    commandId: "cmd-status",
    action: "status",
  });

  assert.equal(result.state, "complete");
  const output = result.output as {
    sync: string;
    syncs: Array<Record<string, unknown>>;
  };
  assert.equal(output.sync, "github-issues");
  assert.equal(output.syncs.length, 1);
  assert.deepEqual(output.syncs[0]!.checkpoint, { page: 7 });
  assert.equal(output.syncs[0]!.status, "SUCCESS");
  assert.equal(output.syncs[0]!.frequency, "every hour");
  assert.equal(output.syncs[0]!.recordCount !== undefined, true);

  const [request] = h.double.received("GET", "/sync/status");
  assert.equal(request!.url.searchParams.get("syncs"), "github-issues");
  assert.equal(request!.url.searchParams.get("connection_id"), CONNECTION_ID);
  assert.equal(
    request!.url.searchParams.get("provider_config_key"),
    INTEGRATION,
  );
});

test("AC-NG-07: checkpoint-destroying options are refused, never forwarded", async (t) => {
  const h = await syncHarness();
  t.after(() => h.close());
  const connection = await activeConnection(h.ports, h.binding);

  for (const input of [
    { reset: true },
    { emptyCache: true },
    { empty_cache: true },
    { full_resync: true },
    { sync_mode: "full" },
    { opts: { reset: true } },
  ])
    await assert.rejects(
      h.adapter.delegate!(h.context({ connection }), {
        skill: syncOperation.operationRef,
        input,
        commandId: `cmd-${JSON.stringify(input)}`,
        action: "start",
      }),
      (error: unknown) =>
        error instanceof ConnectorError &&
        error.code === "denied" &&
        error.detail === "nango.sync.option-rejected",
      `option ${JSON.stringify(input)} must be refused`,
    );
  assert.equal(h.double.syncCommands.length, 0);
});

test("AC-NG-07: a duplicate sync invocation is not sent twice for one command", async (t) => {
  const h = await syncHarness();
  t.after(() => h.close());
  const connection = await activeConnection(h.ports, h.binding);
  const request = {
    skill: syncOperation.operationRef,
    input: {},
    commandId: "cmd-dup-sync",
    action: "start" as const,
  };
  const first = await h.adapter.delegate!(h.context({ connection }), request);
  assert.equal(first.state, "complete");
  const second = await h.adapter.delegate!(h.context({ connection }), request);
  assert.equal(second.state, "complete");
  assert.equal(second.code, "nango.effect.already-applied");
  assert.equal(h.double.syncCommands.length, 1);
});

test("NG-05: an unapproved sync route is refused before any call", async (t) => {
  const h = await syncHarness();
  t.after(() => h.close());
  const connection = await activeConnection(h.ports, h.binding);

  await assert.rejects(
    h.adapter.delegate!(h.context({ connection }), {
      skill: "github.sync.not-approved",
      input: {},
      commandId: "cmd-x",
      action: "start",
    }),
    (error: unknown) =>
      error instanceof ConnectorError &&
      error.detail === "nango.delegate.unapproved",
  );

  // A proxy operation is not a sync route, even though it is approved.
  await assert.rejects(
    h.adapter.delegate!(h.context({ connection }), {
      skill: readOperation.operationRef,
      input: {},
      commandId: "cmd-y",
      action: "start",
    }),
    (error: unknown) =>
      error instanceof ConnectorError &&
      error.detail === "nango.delegate.unapproved",
  );
  assert.equal(h.double.syncCommands.length, 0);
});

test("NG-05: a sync belonging to another integration cannot be driven", async (t) => {
  const h = await syncHarness();
  t.after(() => h.close());
  const foreign = await activeConnection(h.ports, h.binding, {
    externalIds: {
      connectionId: CONNECTION_ID,
      providerConfigKey: "github-sandbox",
      provider: "github",
      environment: "dev",
    },
  });
  await assert.rejects(
    h.adapter.delegate!(h.context({ connection: foreign }), {
      skill: syncOperation.operationRef,
      input: {},
      commandId: "cmd-z",
      action: "start",
    }),
    (error: unknown) =>
      error instanceof ConnectorError &&
      error.detail === "nango.connection.integration",
  );
  assert.equal(h.double.syncCommands.length, 0);
});

test("NG-05: a sync command lost at Nango's gateway is indeterminate, not a definite failure", async (t) => {
  // 502 and 504 come from the gateway in front of Nango, so the request
  // reached Nango and its fate is unknown: the sync may already be running.
  // Reporting that as `failed` invites a retry against a sync in flight, which
  // is exactly what `invokeNango` refuses to do for a non-read.
  for (const status of [502, 504]) {
    const h = await syncHarness({
      double: {
        connections: [connectionRow()],
        syncStatus: statusRows,
        intercept: (request) =>
          request.url.pathname === "/sync/trigger"
            ? { status, body: { message: "gateway" } }
            : undefined,
      },
    });
    t.after(() => h.close());
    const connection = await activeConnection(h.ports, h.binding);
    const result = await h.adapter.delegate!(h.context({ connection }), {
      skill: syncOperation.operationRef,
      input: {},
      commandId: `cmd-gateway-${status}`,
      action: "start",
    });
    assert.equal(result.state, "indeterminate", `status ${status}`);
    assert.equal(result.code, "nango.upstream.uncertain");
    // The journal has to agree, or reconciliation would never be asked for.
    const [effect] = h.ports.inspect.effects();
    assert.equal(effect?.outcome?.status, "indeterminate");
    assert.equal(effect?.outcome?.code, "nango.upstream.uncertain");
    assert.equal(effect?.effectRef, result.effectRef);

    // And the journal keeps the same answer on a retry of the same command,
    // rather than quietly sending a second trigger.
    const again = await h.adapter.delegate!(h.context({ connection }), {
      skill: syncOperation.operationRef,
      input: {},
      commandId: `cmd-gateway-${status}`,
      action: "start",
    });
    assert.equal(again.state, "indeterminate");
    assert.equal(again.code, "nango.effect.indeterminate");
    assert.equal(h.double.received("POST", "/sync/trigger").length, 1);
  }
});

test("NG-05: a 4xx refusal of a sync command stays a definite failure", async (t) => {
  // Nango refused the command outright, so nothing was started and the caller
  // is entitled to be told the sync definitely did not run. The gateway rule
  // must not widen to cover this.
  const h = await syncHarness({
    double: {
      connections: [connectionRow()],
      syncStatus: statusRows,
      intercept: (request) =>
        request.url.pathname === "/sync/trigger"
          ? {
              status: 404,
              body: { error: { code: "not_found", message: "unknown sync" } },
            }
          : undefined,
    },
  });
  t.after(() => h.close());
  const connection = await activeConnection(h.ports, h.binding);
  const result = await h.adapter.delegate!(h.context({ connection }), {
    skill: syncOperation.operationRef,
    input: {},
    commandId: "cmd-refused-sync",
    action: "start",
  });
  assert.equal(result.state, "failed");
  assert.equal(result.code, "nango.api.not-found.not-found");
  const [effect] = h.ports.inspect.effects();
  assert.equal(effect?.outcome?.status, "failed");
});

test("NG-05: a sync response lost before it arrived is indeterminate, not a silent no-op", async (t) => {
  const h = await syncHarness({
    double: {
      connections: [connectionRow()],
      syncStatus: statusRows,
      intercept: (request) =>
        request.url.pathname === "/sync/trigger"
          ? { status: 503, body: { message: "unavailable" } }
          : undefined,
    },
  });
  t.after(() => h.close());
  const connection = await activeConnection(h.ports, h.binding);
  const result = await h.adapter.delegate!(h.context({ connection }), {
    skill: syncOperation.operationRef,
    input: {},
    commandId: "cmd-lost-sync",
    action: "start",
  });
  assert.equal(result.state, "indeterminate");
  assert.equal(result.code, "nango.upstream.uncertain");
});

test("NG-06: the default disconnect unlinks locally and touches nothing at Nango", async (t) => {
  const h = await syncHarness();
  t.after(() => h.close());
  const connection = await activeConnection(h.ports, h.binding);
  const result = await h.adapter.disconnect!(
    h.context({ connection }),
    "local",
  );

  assert.deepEqual(result, {
    local: "applied",
    broker: "not-attempted",
    upstream: "not-attempted",
  });
  assert.equal(h.double.deleted.length, 0);
  // The protected broker reference is gone from local custody.
  assert.equal(
    h.ports.inspect.credentialMaterial(connection.credentialRef!),
    undefined,
  );
});

test("NG-06: broker deletion happens only under the explicit broker scope", async (t) => {
  const h = await syncHarness();
  t.after(() => h.close());
  const connection = await activeConnection(h.ports, h.binding);
  const result = await h.adapter.disconnect!(
    h.context({ connection }),
    "broker",
  );

  assert.equal(result.broker, "applied");
  assert.equal(result.local, "applied");
  assert.equal(result.upstream, "not-attempted");
  assert.deepEqual(h.double.deleted, [
    { connectionId: CONNECTION_ID, providerConfigKey: INTEGRATION },
  ]);
});

test("AC-STATE-04: a shared Nango connection blocks broker deletion without approval", async (t) => {
  const h = await syncHarness({
    adapter: { sharedReferences: async () => ["conn:nango-local-2"] },
  });
  t.after(() => h.close());
  const connection = await activeConnection(h.ports, h.binding);

  const blocked = await h.adapter.disconnect!(
    h.context({ connection }),
    "broker",
  );
  assert.equal(blocked.broker, "not-attempted");
  assert.equal(blocked.local, "not-attempted");
  assert.deepEqual(blocked.sharedWith, ["conn:nango-local-2"]);
  assert.equal(h.double.deleted.length, 0);

  // With explicit shared-impact approval by an administrator it proceeds.
  const approved = await h.adapter.deleteBrokerConnection(
    h.context({ connection }),
    {
      approveSharedImpact: true,
    },
  );
  assert.equal(approved.broker, "applied");
  assert.deepEqual(approved.sharedWith, ["conn:nango-local-2"]);

  // A non-administrator cannot approve that impact.
  const h2 = await syncHarness({
    adapter: { sharedReferences: async () => ["conn:nango-local-2"] },
  });
  t.after(() => h2.close());
  const connection2 = await activeConnection(h2.ports, h2.binding);
  await assert.rejects(
    h2.adapter.deleteBrokerConnection(
      h2.context({
        connection: connection2,
        actor: { ...fixtureActor, capabilities: ["executor"] },
      }),
      { approveSharedImpact: true },
    ),
    (error: unknown) =>
      error instanceof ConnectorError &&
      error.detail === "nango.disconnect.shared-impact-admin",
  );
  assert.equal(h2.double.deleted.length, 0);
});

test("AC-STATE-03: upstream revocation is reported unsupported, not faked by deletion", async (t) => {
  const h = await syncHarness();
  t.after(() => h.close());
  const connection = await activeConnection(h.ports, h.binding);

  const revoked = await h.adapter.revoke!(h.context({ connection }));
  assert.deepEqual(revoked, {
    local: "not-attempted",
    broker: "not-attempted",
    upstream: "unsupported",
  });
  const scoped = await h.adapter.disconnect!(
    h.context({ connection }),
    "upstream",
  );
  assert.equal(scoped.upstream, "unsupported");
  assert.equal(h.double.deleted.length, 0);
});

test("NG-06: a repeated broker deletion is not a second effect", async (t) => {
  const h = await syncHarness();
  t.after(() => h.close());
  const connection = await activeConnection(h.ports, h.binding);
  await h.adapter.disconnect!(h.context({ connection }), "broker");
  const again = await h.adapter.disconnect!(
    h.context({ connection }),
    "broker",
  );
  assert.equal(again.broker, "applied");
  // The journal recognises the same effect; Nango is not called twice.
  assert.equal(h.double.deleted.length, 1);
});
