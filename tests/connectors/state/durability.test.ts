import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { after, before, test } from "node:test";
import { Pool } from "pg";
import {
  PostgresCeremonyStore,
  SQLiteCeremonyStore,
  recordKinds,
} from "../../../src/server/persistence/index.js";
import { createConnectorPorts } from "../../../src/server/connectors/state/index.js";
import { effectKey } from "../../../src/server/connectors/state/keys.js";
import { ConnectorError } from "../../../src/server/connectors/errors.js";
import { postgresFixture } from "../../fixtures/postgres.js";
import {
  actorFor,
  claim,
  connectionRecord,
  definitionRecord,
  runtimeBinding,
  sourceRecord,
  sqliteFixture,
  stateKeyring,
} from "../fixtures/state/records.js";

/*
 * STATE-06: durability on the real databases. A separate process crashes
 * between persisting intent and confirming an effect; the database is closed
 * and reopened; records written by the existing persistence code under
 * unrelated kinds keep working beside the new connector kinds; local SQLite
 * development stays encrypted and reopenable; retention deletes what it
 * promised; and no transaction is open while a provider call is in flight.
 */

const CANARY = "durability-secret-Jd83nQpZ2vLxT";
const keyBytes = randomBytes(32);
const keyring = { current: "state", keys: { state: keyBytes } };
let database: Awaited<ReturnType<typeof postgresFixture>>;
let store: PostgresCeremonyStore;

before(async () => {
  database = await postgresFixture();
  store = new PostgresCeremonyStore(database.config, keyring);
  await store.migrate();
});

after(async () => {
  await store.close();
  await database.close();
});

test("STATE-06: the connector kinds are additive and every stored value is versioned", async () => {
  // "Migration" for connector state means new record kinds plus a
  // forward-compatible value schema; the encrypted record table is generic
  // and needs no schema change, so an existing database keeps its rows.
  for (const kind of [
    "connector-source",
    "connector-definition",
    "connector-binding",
    "connector-connection",
    "connector-connection-index",
    "connector-evidence",
    "connector-handoff",
    "connector-effect",
    "connector-credential",
    "connector-artifact",
  ] as const)
    assert.ok(recordKinds.includes(kind), `${kind} is registered`);
  // The kinds that existed before this work are untouched.
  for (const kind of ["run", "node", "command", "effect", "handoff", "outbox"])
    assert.ok(recordKinds.includes(kind as (typeof recordKinds)[number]));
});

test("AC-STATE-08: an existing database keeps its records while connector state is added", async () => {
  const tenant = "tenant-migrate";
  // Rows written by the existing persistence code, before any connector state.
  await store.transaction(async (tx) => {
    await tx.put(
      { tenant, kind: "run", id: "run:legacy" },
      { status: "active" },
      null,
    );
    await tx.put(
      { tenant, kind: "handoff", id: "oauth-code:legacy" },
      { phase: "waiting", expires: 1 },
      null,
    );
    await tx.put(
      { tenant, kind: "outbox", id: "delivery:legacy" },
      { status: "pending" },
      null,
    );
  });

  // Re-running the migration on a populated database is safe and additive.
  await store.migrate();
  const ports = createConnectorPorts(store);
  const actor = actorFor(tenant);
  const record = connectionRecord({ tenantId: tenant });
  await ports.connections.create(record);
  await ports.definitions.putSource(tenant, sourceRecord());
  await ports.definitions.putBinding(runtimeBinding({ tenantId: tenant }));

  // Old and new coexist, each under its own kind.
  const legacy = await store.transaction(async (tx) => ({
    run: await tx.get<{ status: string }>({
      tenant,
      kind: "run",
      id: "run:legacy",
    }),
    handoff: await tx.get<{ phase: string }>({
      tenant,
      kind: "handoff",
      id: "oauth-code:legacy",
    }),
    outbox: await tx.list(tenant, "outbox"),
    connections: await tx.list(tenant, "connector-connection"),
  }));
  assert.equal(legacy.run?.value.status, "active");
  assert.equal(legacy.handoff?.value.phase, "waiting");
  assert.equal(legacy.outbox.length, 1);
  assert.equal(legacy.connections.length, 1);
  assert.ok(await ports.connections.get(actor, record.connectionRef));

  // A new record's value carries its schema version, so a later layout can be
  // recognised rather than guessed.
  const stored = legacy.connections[0]!.value as { schemaVersion: number };
  assert.equal(stored.schemaVersion, 1);
});

test("AC-STATE-02: a crashed worker's intent survives and reconciles after restart", async () => {
  const tenant = "tenant-crash";
  const ports = createConnectorPorts(store, { worker: "parent" });
  const actor = actorFor(tenant);
  const intent = {
    actor,
    operation: "vercel.connect.token",
    digest: "digest-crash",
    commandId: "command-crash",
  };
  const worker = spawn(
    process.execPath,
    [
      "--no-experimental-webstorage",
      "--import",
      "tsx",
      "tests/connectors/fixtures/state/effect-crash-worker.ts",
    ],
    {
      cwd: process.cwd(),
      env: {
        PATH: process.env.PATH,
        CEREMONY_CONNECTOR_STATE_WORKER: JSON.stringify({
          database: database.config,
          key: keyBytes.toString("hex"),
          tenantId: tenant,
          operation: intent.operation,
          digest: intent.digest,
          commandId: intent.commandId,
          worker: "crash-worker",
          mode: "die-after-begin",
        }),
      },
      stdio: "ignore",
    },
  );
  const [code] = await once(worker, "exit");
  assert.equal(code, 81);

  // The intent is durable even though the process that wrote it is gone.
  const persisted = await store.transaction((tx) =>
    tx.list<{ status: string; operation: string }>(tenant, "connector-effect"),
  );
  assert.equal(
    persisted.filter((row) => row.value.operation === intent.operation).length,
    1,
  );

  // While the dead worker's lease is still counted alive, nothing replays it.
  assert.equal(
    (await ports.effects.begin(intent)).prior?.code,
    "effect.in-flight",
  );

  // The database clock expires the lease; no client-side clock decides this.
  const admin = new Pool(database.config);
  admin.on("error", () => {});
  try {
    await admin.query(
      "UPDATE ceremony_claims SET expires=0 WHERE kind='connector-effect'",
    );
  } finally {
    await admin.end();
  }

  // A restarted process — a fresh store over the same database — sees the
  // uncertain effect and reports it for reconciliation instead of repeating it.
  const restarted = new PostgresCeremonyStore(database.config, keyring);
  try {
    const revived = createConnectorPorts(restarted, { worker: "restarted" });
    const seen = await revived.effects.begin(intent);
    assert.equal(seen.prior?.status, "indeterminate");
    assert.equal(seen.prior?.code, "effect.orphaned");
    const unresolved = await revived.effects.listUnresolved(actor);
    assert.deepEqual(
      unresolved.map((item) => item.status),
      ["orphaned"],
    );
    assert.equal(unresolved[0]!.commandId, "command-crash");

    const reconciled = await revived.effects.reconcile(actor, seen.effectRef, {
      status: "applied",
      code: "provider.reconciled",
      at: Date.now(),
    });
    assert.equal(reconciled.status, "applied");
    assert.deepEqual(await revived.effects.listUnresolved(actor), []);
    assert.equal(
      (await revived.effects.begin(intent)).prior?.status,
      "applied",
    );
  } finally {
    await restarted.close();
  }
});

test("AC-STATE-08: a worker that completes its effect leaves a committed outcome for the next process", async () => {
  const tenant = "tenant-complete";
  const worker = spawn(
    process.execPath,
    [
      "--no-experimental-webstorage",
      "--import",
      "tsx",
      "tests/connectors/fixtures/state/effect-crash-worker.ts",
    ],
    {
      cwd: process.cwd(),
      env: {
        PATH: process.env.PATH,
        CEREMONY_CONNECTOR_STATE_WORKER: JSON.stringify({
          database: database.config,
          key: keyBytes.toString("hex"),
          tenantId: tenant,
          operation: "nango.connection.create",
          digest: "digest-complete",
          worker: "complete-worker",
          mode: "die-after-complete",
        }),
      },
      stdio: "ignore",
    },
  );
  const [code] = await once(worker, "exit");
  assert.equal(code, 82);

  const ports = createConnectorPorts(store, { worker: "observer" });
  const actor = actorFor(tenant);
  const replay = await ports.effects.begin({
    actor,
    operation: "nango.connection.create",
    digest: "digest-complete",
  });
  assert.deepEqual(replay.prior?.status, "applied");
  assert.equal(replay.prior?.code, "provider.accepted");
  assert.deepEqual(await ports.effects.listUnresolved(actor), []);
});

test("AC-STATE-08: closing and reopening the database preserves connector state", async () => {
  const tenant = "tenant-restart";
  const actor = actorFor(tenant);
  const first = new PostgresCeremonyStore(database.config, keyring);
  const record = connectionRecord({
    tenantId: tenant,
    externalIds: { connectionId: "conn_restart" },
  });
  let credentialRef = "";
  try {
    const ports = createConnectorPorts(first);
    await ports.connections.create(record);
    await ports.evidence.append(actor, record.connectionRef, claim());
    await ports.definitions.putDefinition(tenant, definitionRecord());
    credentialRef = await ports.credentials.store(
      {
        tenantId: tenant,
        ownerKind: "user",
        ownerId: actor.subjectId,
        connectionRef: record.connectionRef,
        bindingRef: record.bindingRef,
        custody: "host-owned",
      },
      { accessToken: CANARY },
    );
  } finally {
    await first.close();
  }

  const second = new PostgresCeremonyStore(database.config, keyring);
  try {
    const ports = createConnectorPorts(second);
    const read = await ports.connections.get(actor, record.connectionRef);
    assert.equal(read?.record.externalIds.connectionId, "conn_restart");
    assert.equal(
      (await ports.evidence.list(actor, record.connectionRef)).length,
      1,
    );
    assert.equal((await ports.definitions.listDefinitions(tenant)).length, 1);
    assert.equal(
      await ports.credentials.use(
        {
          tenantId: tenant,
          ownerKind: "user",
          ownerId: actor.subjectId,
          connectionRef: record.connectionRef,
          bindingRef: record.bindingRef,
          custody: "host-owned",
        },
        credentialRef,
        async (material) => material.accessToken === CANARY,
      ),
      true,
    );
  } finally {
    await second.close();
  }

  // A store configured with the wrong keys fails closed rather than guessing.
  const wrong = new PostgresCeremonyStore(database.config, {
    current: "other",
    keys: { other: randomBytes(32) },
  });
  try {
    await assert.rejects(
      createConnectorPorts(wrong).connections.get(actor, record.connectionRef),
      /cannot be decrypted/,
    );
  } finally {
    await wrong.close();
  }
});

test("STATE-06: no transaction is open while the provider call is in flight", async () => {
  // Structural proof: the callback itself opens a transaction that takes the
  // effect row's own lock on a second connection. If `begin` had not committed
  // before the callback ran, this would block until the test's deadline.
  const tenant = "tenant-open";
  const ports = createConnectorPorts(store, { worker: "caller" });
  const second = new PostgresCeremonyStore(database.config, keyring);
  try {
    const actor = actorFor(tenant);
    const result = await ports.effects.execute(
      { actor, operation: "mcp.tool.call", digest: "digest-open" },
      async (effectRef) => {
        const observed = await Promise.race([
          second.transaction((tx) =>
            tx.get(effectKey(tenant, effectRef)).then(() => "read" as const),
          ),
          new Promise<"blocked">((resolve) =>
            setTimeout(() => resolve("blocked"), 3_000).unref(),
          ),
        ]);
        assert.equal(
          observed,
          "read",
          "the journal must commit its intent before the provider call",
        );
        return {
          outcome: { status: "applied" as const, at: Date.now() },
          value: "done",
        };
      },
    );
    assert.equal(result.value, "done");
    assert.equal(
      (await ports.effects.get(actor, result.effectRef))?.status,
      "applied",
    );
  } finally {
    await second.close();
  }
});

test("STATE-06: retention deletes artifacts on the shared database", async () => {
  const tenant = "tenant-retention";
  let now = Date.now();
  const ports = createConnectorPorts(store, { now: () => now });
  const bytes = new TextEncoder().encode(`{"secret":"${CANARY}"}`);
  const digest = createHash("sha256").update(bytes).digest("hex");
  const ref = await ports.artifacts.put(tenant, bytes, {
    mediaType: "application/json",
    digest,
    retainUntil: now + 1_000,
  });
  assert.ok(await ports.artifacts.get(tenant, ref));
  now += 1_001;
  assert.equal(await ports.artifacts.get(tenant, ref), undefined);
  assert.equal((await ports.artifacts.purgeExpired(tenant)).deleted, 1);
  const rows = await store.transaction((tx) =>
    tx.list(tenant, "connector-artifact"),
  );
  assert.deepEqual(rows, []);
});

test("STATE-06: diagnostics carry codes, never provider text or material", async () => {
  const tenant = "tenant-diagnostics";
  const ports = createConnectorPorts(store);
  const actor = actorFor(tenant);
  const record = connectionRecord({ tenantId: tenant });
  await ports.connections.create(record);
  const scope = {
    tenantId: tenant,
    ownerKind: "user" as const,
    ownerId: actor.subjectId,
    connectionRef: record.connectionRef,
    bindingRef: record.bindingRef,
    custody: "host-owned" as const,
  };
  const ref = await ports.credentials.store(scope, { accessToken: CANARY });

  const failures: unknown[] = [];
  const capture = async (work: Promise<unknown>) => {
    await work.catch((error: unknown) => failures.push(error));
  };
  await capture(
    ports.credentials.use(scope, ref, async (material) => material.accessToken),
  );
  await capture(ports.credentials.use(scope, "cred:unknown", async () => 1));
  await capture(
    ports.connections.update(
      actorFor(tenant, "other"),
      record.connectionRef,
      1,
      {
        lifecycle: "degraded",
      },
    ),
  );
  await capture(
    ports.connections.recordDisconnect(actor, record.connectionRef, 99, {
      scope: "local",
      local: "applied",
      broker: "not-attempted",
      upstream: "not-attempted",
    }),
  );
  await capture(
    ports.drift.invalidateForDrift(actor, record.connectionRef, {}),
  );

  assert.equal(failures.length, 5);
  for (const failure of failures) {
    assert.ok(failure instanceof ConnectorError);
    const text = `${failure.message} ${failure.detail ?? ""} ${failure.stack ?? ""}`;
    assert.equal(text.includes(CANARY), false);
    assert.equal(text.includes(record.connectionRef), false);
    // The public message is one of the fixed connector explanations.
    assert.match(failure.message, /^[A-Z][^\n]{4,120}$/);
  }
});

test("STATE-06: encrypted local development state reopens and stays unreadable without its keys", async () => {
  const fixture = await sqliteFixture();
  try {
    const tenant = "tenant-local";
    const actor = actorFor(tenant);
    const record = connectionRecord({
      tenantId: tenant,
      externalIds: { connectionId: "conn_local" },
    });
    const ports = createConnectorPorts(fixture.store);
    await ports.connections.create(record);
    await ports.definitions.putBinding(runtimeBinding({ tenantId: tenant }));
    await ports.evidence.append(actor, record.connectionRef, claim());

    await fixture.reopen();
    const reopened = createConnectorPorts(fixture.store);
    assert.equal(
      (await reopened.connections.get(actor, record.connectionRef))?.record
        .externalIds.connectionId,
      "conn_local",
    );
    assert.equal(
      (
        await reopened.connections.findByExternalId(
          tenant,
          record.authorityInstance,
          "connectionId",
          "conn_local",
        )
      )?.record.connectionRef,
      record.connectionRef,
    );
    assert.equal(
      (await reopened.definitions.getBinding(tenant, "binding:fixture"))
        ?.revision,
      1,
    );
    assert.equal(
      (await reopened.evidence.list(actor, record.connectionRef)).length,
      1,
    );

    await fixture.reopen({
      current: "other",
      keys: { other: randomBytes(32) },
    });
    await assert.rejects(
      createConnectorPorts(fixture.store).connections.get(
        actor,
        record.connectionRef,
      ),
      /cannot be decrypted/,
    );
  } finally {
    await fixture.close();
  }
});

test("STATE-06: a SQLite store keeps its transaction closed during a provider call too", async () => {
  // The local adapter serialises transactions on one connection, so a nested
  // transaction inside an open one would never be reached.
  const store = new SQLiteCeremonyStore(":memory:", stateKeyring());
  try {
    const ports = createConnectorPorts(store);
    const actor = actorFor("tenant-local-open");
    const result = await ports.effects.execute(
      { actor, operation: "a2a.task.start", digest: "digest-local-open" },
      async (effectRef) => {
        const observed = await Promise.race([
          store
            .transaction((tx) =>
              tx.get(effectKey("tenant-local-open", effectRef)),
            )
            .then(() => "read" as const),
          new Promise<"blocked">((resolve) =>
            setTimeout(() => resolve("blocked"), 3_000).unref(),
          ),
        ]);
        assert.equal(observed, "read");
        return {
          outcome: { status: "applied" as const, at: Date.now() },
          value: true,
        };
      },
    );
    assert.equal(result.value, true);
  } finally {
    await store.close();
  }
});
