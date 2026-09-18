import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import {
  PostgresCeremonyStore,
  SQLiteCeremonyStore,
} from "../../../src/server/persistence/index.js";
import { createConnectorPorts } from "../../../src/server/connectors/state/index.js";
import { credentialKey } from "../../../src/server/connectors/state/keys.js";
import { ConnectorError } from "../../../src/server/connectors/errors.js";
import { postgresFixture } from "../../fixtures/postgres.js";
import {
  actorFor,
  connectionRecord,
  credentialScope,
  stateKeyring,
} from "../fixtures/state/records.js";

/*
 * STATE-04: concurrency on a real shared database. Two independent workers —
 * separate PostgresCeremonyStore instances with their own pools and worker
 * identities, exactly as two server processes would be — rotate the same
 * credential, race for the same external identifier, and consume the same
 * per-authority budget. Only current state is ever committed.
 */

let database: Awaited<ReturnType<typeof postgresFixture>>;
const keyring = stateKeyring();
let workerA: PostgresCeremonyStore;
let workerB: PostgresCeremonyStore;

before(async () => {
  database = await postgresFixture();
  workerA = new PostgresCeremonyStore(database.config, keyring);
  workerB = new PostgresCeremonyStore(database.config, keyring);
  await workerA.migrate();
});

after(async () => {
  await workerA.close();
  await workerB.close();
  await database.close();
});

test("AC-STATE-01: two PostgreSQL workers rotating one credential make exactly one upstream call", async () => {
  const a = createConnectorPorts(workerA, { worker: "worker-a" });
  const b = createConnectorPorts(workerB, { worker: "worker-b" });
  const scope = credentialScope("tenant-rotate");
  const ref = await a.credentials.store(
    scope,
    { accessToken: "token-1", refreshToken: "rotating-1" },
    { expiresAt: Date.now() + 60_000 },
  );

  let upstream = 0;
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const rotate = async (current: Readonly<Record<string, string>>) => {
    upstream++;
    assert.equal(current.refreshToken, "rotating-1");
    entered.resolve();
    await release.promise;
    return {
      material: { accessToken: "token-2", refreshToken: "rotating-2" },
      expiresAt: Date.now() + 600_000,
    };
  };

  const first = a.credentials.refresh(scope, ref, rotate);
  await entered.promise;
  const second = b.credentials.refresh(scope, ref, rotate);
  // The second worker must not present the same rotating refresh token.
  await delay(50);
  assert.equal(upstream, 1);
  release.resolve();
  const [one, two] = await Promise.all([first, second]);
  assert.equal(upstream, 1);
  assert.equal(one.ref, ref);
  assert.equal(two.ref, ref);
  assert.equal(one.expiresAt, two.expiresAt);
  assert.equal(
    await b.credentials.use(
      scope,
      ref,
      async (m) => m.refreshToken === "rotating-2",
    ),
    true,
  );
});

test("AC-STATE-01: a stalled worker's refresh cannot overwrite the newer credential", async () => {
  const a = createConnectorPorts(workerA, { worker: "worker-a" });
  const b = createConnectorPorts(workerB, { worker: "worker-b" });
  const scope = credentialScope("tenant-stale");
  const ref = await a.credentials.store(scope, {
    accessToken: "token-1",
    refreshToken: "rotating-1",
  });

  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const stalled = a.credentials.refresh(scope, ref, async () => {
    entered.resolve();
    await release.promise;
    return { material: { accessToken: "token-stale" } };
  });
  await entered.promise;

  // The stalled worker is presumed dead: its lease lapses, exactly as the
  // database clock would expire it.
  await workerB.transaction((tx) =>
    tx.cancel(credentialKey(scope.tenantId, ref)),
  );
  const rotated = await b.credentials.refresh(scope, ref, async () => ({
    material: { accessToken: "token-current" },
  }));
  assert.equal(rotated.ref, ref);

  // The revived worker's result is refused rather than written over the newer one.
  release.resolve();
  await assert.rejects(
    stalled,
    (error: unknown) =>
      error instanceof ConnectorError &&
      error.code === "conflict" &&
      error.detail === "credential.stale-refresh",
  );
  assert.equal(
    await a.credentials.use(scope, ref, async (m) =>
      m.accessToken === "token-current" ? "current" : m.accessToken,
    ),
    "current",
  );
});

test("AC-STATE-08: two workers binding the same external response leave exactly one owner", async () => {
  const a = createConnectorPorts(workerA);
  const b = createConnectorPorts(workerB);
  const authority = "https://api.nango.dev/prod";
  const external = { connectionId: "conn_race_1" };
  const first = connectionRecord({
    tenantId: "tenant-race",
    ownerId: "subject-a",
    authorityInstance: authority,
    externalIds: external,
  });
  const second = connectionRecord({
    tenantId: "tenant-race",
    ownerId: "subject-b",
    authorityInstance: authority,
    externalIds: external,
  });

  const results = await Promise.allSettled([
    a.connections.create(first),
    b.connections.create(second),
  ]);
  assert.equal(results.filter((r) => r.status === "fulfilled").length, 1);
  const rejected = results.find((r) => r.status === "rejected");
  assert.ok(rejected?.status === "rejected");
  assert.ok(rejected.reason instanceof ConnectorError);
  assert.equal(rejected.reason.code, "conflict");

  // Both workers agree on the single owner.
  const winner = await a.connections.findByExternalId(
    "tenant-race",
    authority,
    "connectionId",
    "conn_race_1",
  );
  const alsoWinner = await b.connections.findByExternalId(
    "tenant-race",
    authority,
    "connectionId",
    "conn_race_1",
  );
  assert.ok(winner);
  assert.equal(winner.record.connectionRef, alsoWinner?.record.connectionRef);
  assert.equal(
    (
      await b.connections.listByExternalId(
        "tenant-race",
        authority,
        "connectionId",
        "conn_race_1",
      )
    ).length,
    1,
  );
  // The loser's record did not survive its rolled-back transaction.
  const loser = [first, second].find(
    (record) => record.connectionRef !== winner.record.connectionRef,
  )!;
  assert.equal(
    await a.connections.get(
      actorFor("tenant-race", loser.ownerId),
      loser.connectionRef,
    ),
    undefined,
  );
});

test("AC-STATE-06: the per-authority budget is shared between workers and isolated per tenant", async () => {
  const a = createConnectorPorts(workerA, {
    throttle: { limit: 3, windowMs: 60_000 },
  });
  const b = createConnectorPorts(workerB, {
    throttle: { limit: 3, windowMs: 60_000 },
  });
  const authority = "https://api.vercel.com";

  assert.equal((await a.throttle.reserve("tenant-x", authority)).remaining, 2);
  assert.equal((await b.throttle.reserve("tenant-x", authority)).remaining, 1);
  assert.equal((await a.throttle.reserve("tenant-x", authority)).remaining, 0);
  await assert.rejects(
    b.throttle.reserve("tenant-x", authority),
    (error: unknown) =>
      error instanceof ConnectorError &&
      error.code === "rate-limited" &&
      error.detail === "authority.budget",
  );

  // Another tenant is unaffected: status never leaks across tenants.
  assert.equal((await b.throttle.reserve("tenant-y", authority)).remaining, 2);
  // Another authority in the same tenant has its own budget.
  assert.equal(
    (await a.throttle.reserve("tenant-x", "https://api.nango.dev")).remaining,
    2,
  );

  // A tripped circuit refuses with its own reason and is visible to both workers.
  await a.throttle.trip("tenant-y", authority, 30_000, "provider.unavailable");
  await assert.rejects(
    b.throttle.reserve("tenant-y", authority),
    (error: unknown) =>
      error instanceof ConnectorError &&
      error.detail === "authority.circuit-open",
  );
  assert.equal(
    (await b.throttle.state("tenant-y", authority)).openCode,
    "provider.unavailable",
  );
  assert.equal(
    (await b.throttle.state("tenant-x", "https://api.nango.dev")).openUntil,
    undefined,
  );
});

test("STATE-04: a fixed window reopens on its own schedule", async () => {
  const store = new SQLiteCeremonyStore(":memory:", stateKeyring());
  let now = 1_700_000_000_000;
  const ports = createConnectorPorts(store, {
    now: () => now,
    throttle: { limit: 1, windowMs: 1_000 },
  });
  try {
    assert.equal(
      (await ports.throttle.reserve("tenant-w", "https://api.example"))
        .remaining,
      0,
    );
    await assert.rejects(
      ports.throttle.reserve("tenant-w", "https://api.example"),
      ConnectorError,
    );
    now += 1_001;
    assert.equal(
      (await ports.throttle.reserve("tenant-w", "https://api.example"))
        .remaining,
      0,
    );
    // An open circuit outlives the window until its cooldown ends.
    await ports.throttle.trip(
      "tenant-w",
      "https://api.example",
      5_000,
      "provider.rate-limited",
    );
    now += 2_000;
    await assert.rejects(
      ports.throttle.reserve("tenant-w", "https://api.example"),
      (error: unknown) =>
        error instanceof ConnectorError &&
        error.detail === "authority.circuit-open",
    );
    now += 4_000;
    assert.ok(await ports.throttle.reserve("tenant-w", "https://api.example"));
  } finally {
    await store.close();
  }
});

test("AC-STATE-08: two workers racing one effect digest run the provider call once", async () => {
  const a = createConnectorPorts(workerA, { worker: "worker-a" });
  const b = createConnectorPorts(workerB, { worker: "worker-b" });
  const actor = actorFor("tenant-effect");
  const intent = {
    actor,
    operation: "supabase.project.create-token",
    digest: "digest-shared",
  };
  let calls = 0;
  const call = async () => {
    calls++;
    await delay(20);
    return {
      outcome: { status: "applied" as const, at: Date.now() },
      value: 1,
    };
  };
  const [first, second] = await Promise.all([
    a.effects.execute(intent, call),
    b.effects.execute(intent, call).catch((error: unknown) => ({
      effectRef: "",
      error,
    })),
  ]);
  assert.equal(calls, 1, "only one worker may contact the provider");
  assert.ok("effectRef" in first);
  // The follower either sees the in-flight intent or the committed outcome;
  // in neither case does it call the provider again.
  const outcome = await b.effects.begin(intent);
  assert.equal(outcome.effectRef, first.effectRef);
  assert.ok(outcome.prior);
  assert.ok(["applied", "indeterminate"].includes(outcome.prior.status));
  void second;
});
