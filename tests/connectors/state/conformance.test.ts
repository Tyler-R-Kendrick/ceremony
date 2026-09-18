import assert from "node:assert/strict";
import test from "node:test";
import {
  createConnectorPorts,
  createHostConfigurationPort,
  createSessionConfigurationPort,
} from "../../../src/server/connectors/state/index.js";
import { SQLiteCeremonyStore } from "../../../src/server/persistence/index.js";
import { AsyncCeremonyEnvironment } from "../../../src/server/async-environment.js";
import type {
  ConfigurationPort,
  ConnectionStorePort,
  CredentialCustodyPort,
  EffectJournalPort,
  EvidenceStorePort,
  HandoffPort,
} from "../../../src/server/connectors/ports.js";
import { memoryPorts } from "../doubles/ports.js";
import {
  actorFor,
  claim,
  connectionRecord,
  credentialScope,
  stateKeyring,
} from "../fixtures/state/records.js";

/*
 * The persistent ports must behave at least as strictly as the in-memory
 * doubles adapters are tested against, so an adapter cannot pass in a test
 * and fail in a deployment for a reason the double hid. This scenario runs
 * unchanged against both implementations.
 */

type Ports = {
  credentials: CredentialCustodyPort;
  handoffs: HandoffPort;
  effects: EffectJournalPort;
  connections: ConnectionStorePort;
  evidence: EvidenceStorePort;
  now: () => number;
};

async function scenario(ports: Ports) {
  const actor = actorFor("tenant-a");
  const stranger = actorFor("tenant-a", "subject-2");
  const record = connectionRecord({
    tenantId: "tenant-a",
    externalIds: { connectionId: "conn_1" },
  });
  assert.deepEqual(await ports.connections.create(record), { revision: 1 });
  assert.equal(
    (await ports.connections.get(actor, record.connectionRef))?.revision,
    1,
  );
  assert.equal(
    await ports.connections.get(stranger, record.connectionRef),
    undefined,
  );
  assert.equal(
    (
      await ports.connections.findByExternalId(
        "tenant-a",
        record.authorityInstance,
        "connectionId",
        "conn_1",
      )
    )?.record.connectionRef,
    record.connectionRef,
  );
  assert.equal(
    await ports.connections.findByExternalId(
      "tenant-b",
      record.authorityInstance,
      "connectionId",
      "conn_1",
    ),
    undefined,
  );

  // Evidence follows ownership.
  const appended = await ports.evidence.append(
    actor,
    record.connectionRef,
    claim({ evidenceRef: "evidence:conformance" }),
  );
  assert.equal(appended, "evidence:conformance");
  assert.equal((await ports.evidence.list(actor, record.connectionRef)).length, 1);
  assert.deepEqual(await ports.evidence.list(stranger, record.connectionRef), []);
  assert.equal(
    await ports.evidence.invalidate(actor, record.connectionRef, "drift.policy"),
    1,
  );
  assert.deepEqual(await ports.evidence.list(actor, record.connectionRef), []);

  // Credentials: scoped, callback-only, single-flight rotation.
  const scope = credentialScope("tenant-a", {
    connectionRef: record.connectionRef,
  });
  const ref = await ports.credentials.store(scope, { accessToken: "token-1" });
  assert.equal(
    await ports.credentials.use(scope, ref, async (m) => m.accessToken.length),
    7,
  );
  await assert.rejects(
    ports.credentials.use(credentialScope("tenant-b"), ref, async () => 1),
  );
  assert.equal((await ports.credentials.describe(scope, ref))?.custody, "host-owned");
  let upstream = 0;
  const rotate = async () => {
    upstream++;
    await new Promise((resolve) => setTimeout(resolve, 5));
    return { material: { accessToken: "token-2" } };
  };
  await Promise.all([
    ports.credentials.refresh(scope, ref, rotate),
    ports.credentials.refresh(scope, ref, rotate),
  ]);
  assert.equal(upstream, 1);
  assert.equal(
    await ports.credentials.use(scope, ref, async (m) => m.accessToken === "token-2"),
    true,
  );

  // Handoffs: private, one-use, generation-fenced.
  const issued = await ports.handoffs.issue({
    actor,
    connectionRef: record.connectionRef,
    bindingRef: record.bindingRef,
    generation: 0,
    kind: "provider-browser",
    presentation: "popup",
    expiresAt: ports.now() + 60_000,
    intent: "authorize.initial",
    correlationKey: "state-conformance",
    private: { url: "https://issuer.example/authorize" },
  });
  assert.equal(issued.summary.state, "issued");
  assert.equal(
    (await ports.handoffs.present(actor, issued.handoffRef))?.private.url,
    "https://issuer.example/authorize",
  );
  assert.equal(await ports.handoffs.present(stranger, issued.handoffRef), undefined);
  assert.equal(
    (await ports.handoffs.resolveCorrelation("tenant-a", "state-conformance"))
      ?.handoffRef,
    issued.handoffRef,
  );
  await assert.rejects(ports.handoffs.complete(issued.handoffRef, 5, "completed"));
  assert.equal(
    (await ports.handoffs.complete(issued.handoffRef, 0, "completed")).state,
    "completed",
  );
  await assert.rejects(ports.handoffs.complete(issued.handoffRef, 0, "completed"));

  // A second handoff is cancelled wholesale on unlink.
  await ports.handoffs.issue({
    actor,
    connectionRef: record.connectionRef,
    bindingRef: record.bindingRef,
    generation: 0,
    kind: "device-code",
    presentation: "second-device",
    expiresAt: ports.now() + 60_000,
    intent: "authorize.device",
    private: { userCode: "ABCD" },
  });
  assert.equal(await ports.handoffs.cancelAll(record.connectionRef, "unlink"), 1);

  // Effects: intent before the call, prior outcome instead of a second effect.
  const intent = {
    actor,
    connectionRef: record.connectionRef,
    operation: "provider.action",
    digest: "digest-conformance",
  };
  const begun = await ports.effects.begin(intent);
  assert.equal(begun.prior, undefined);
  assert.equal((await ports.effects.begin(intent)).prior?.status, "indeterminate");
  await ports.effects.complete(begun.effectRef, {
    status: "applied",
    at: ports.now(),
  });
  assert.equal((await ports.effects.get(actor, begun.effectRef))?.status, "applied");
  assert.equal(
    await ports.effects.get(actorFor("tenant-b"), begun.effectRef),
    undefined,
  );
  assert.equal((await ports.effects.begin(intent)).prior?.status, "applied");

  // Generations fence what comes after them.
  const current = await ports.connections.get(actor, record.connectionRef);
  const advanced = await ports.connections.advanceGeneration(
    actor,
    record.connectionRef,
    current!.revision,
  );
  assert.equal(advanced.generation, 1);
  await assert.rejects(
    ports.connections.advanceGeneration(actor, record.connectionRef, current!.revision),
  );
}

test("STATE-01/02/03: the persistent ports satisfy the shared double's scenario", async () => {
  const store = new SQLiteCeremonyStore(":memory:", stateKeyring());
  try {
    const ports = createConnectorPorts(store);
    await scenario(ports);
  } finally {
    await store.close();
  }
});

test("STATE-01/02/03: the in-memory double satisfies the same scenario", async () => {
  const double = memoryPorts();
  await scenario({
    credentials: double.credentials,
    handoffs: double.handoffs,
    effects: double.effects,
    connections: double.connections,
    evidence: double.evidence,
    now: double.now,
  });
});

test("STATE-01: configuration ports report names and revisions, never values", async () => {
  const store = new SQLiteCeremonyStore(":memory:", stateKeyring());
  try {
    const actor = actorFor("tenant-a");
    const environment = new AsyncCeremonyEnvironment(store);
    const session: ConfigurationPort = createSessionConfigurationPort({
      environment,
      actor,
      names: ["NANGO_SECRET_KEY", "NANGO_ENVIRONMENT"],
    });
    const before = await session.revision();
    assert.equal(await session.read("NANGO_SECRET_KEY"), undefined);
    assert.deepEqual([...(await session.present(["NANGO_SECRET_KEY"]))], []);

    await environment.update(actor, {
      revision: 0,
      values: { NANGO_SECRET_KEY: "nango-secret-1", UNRELATED: "x" },
      remove: [],
    });
    assert.equal(await session.read("NANGO_SECRET_KEY"), "nango-secret-1");
    // A name outside the declared set is never resolved, even when present.
    assert.equal(await session.read("UNRELATED"), undefined);
    assert.deepEqual(
      [...(await session.present(["NANGO_SECRET_KEY", "NANGO_ENVIRONMENT", "UNRELATED"]))],
      ["NANGO_SECRET_KEY"],
    );
    const after = await session.revision();
    assert.notEqual(before, after);
    assert.match(after, /^[a-f0-9]{64}$/);
    assert.equal(after.includes("nango-secret-1"), false);

    // Host configuration derives its revision from the deployment, not the values.
    const host = createHostConfigurationPort({
      values: { VERCEL_TOKEN: "vercel-token-1", OTHER: "y" },
      names: ["VERCEL_TOKEN"],
      revision: "deployment-7",
    });
    assert.equal(await host.read("VERCEL_TOKEN"), "vercel-token-1");
    assert.equal(await host.read("OTHER"), undefined);
    assert.deepEqual([...(await host.present(["VERCEL_TOKEN", "OTHER"]))], [
      "VERCEL_TOKEN",
    ]);
    const hostRevision = await host.revision();
    assert.equal(hostRevision.includes("vercel-token-1"), false);
    assert.equal(
      hostRevision,
      await createHostConfigurationPort({
        values: { VERCEL_TOKEN: "rotated-token" },
        names: ["VERCEL_TOKEN"],
        revision: "deployment-7",
      }).revision(),
    );
    assert.notEqual(
      hostRevision,
      await createHostConfigurationPort({
        values: { VERCEL_TOKEN: "vercel-token-1" },
        names: ["VERCEL_TOKEN"],
        revision: "deployment-8",
      }).revision(),
    );
  } finally {
    await store.close();
  }
});

test("STATE-01: a host ownership policy can own connections for an organization", async () => {
  const store = new SQLiteCeremonyStore(":memory:", stateKeyring());
  try {
    // The host decides that members of an organization own its connections;
    // the state layer never invents that policy from a tag in the record.
    const members = new Set(["subject-1", "subject-2"]);
    const ports = createConnectorPorts(store, {
      owns: (actor, record) =>
        record.tenantId === actor.tenantId &&
        (record.ownerKind === "organization"
          ? record.ownerId === "org-1" && members.has(actor.subjectId)
          : record.ownerId === actor.subjectId),
    });
    const record = connectionRecord({
      tenantId: "tenant-a",
      ownerKind: "organization",
      ownerId: "org-1",
    });
    await ports.connections.create(record);
    for (const subject of ["subject-1", "subject-2"])
      assert.ok(
        await ports.connections.get(actorFor("tenant-a", subject), record.connectionRef),
      );
    assert.equal(
      await ports.connections.get(
        actorFor("tenant-a", "subject-9"),
        record.connectionRef,
      ),
      undefined,
    );
    assert.equal(
      await ports.connections.get(actorFor("tenant-b", "subject-1"), record.connectionRef),
      undefined,
    );
  } finally {
    await store.close();
  }
});
