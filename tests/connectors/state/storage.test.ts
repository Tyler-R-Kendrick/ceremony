import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import {
  createConnectorPorts,
  connectionKeyDigest,
} from "../../../src/server/connectors/state/index.js";
import { ConnectorError } from "../../../src/server/connectors/errors.js";
import { SQLiteCeremonyStore } from "../../../src/server/persistence/index.js";
import {
  actorFor,
  claim,
  connectionRecord,
  definitionRecord,
  runtimeBinding,
  sourceRecord,
  stateKeyring,
} from "../fixtures/state/records.js";

/*
 * STATE-01: typed connector storage over the shared encrypted store. Records
 * are keyed by digests, values carry `schemaVersion` and are validated on
 * every read, definitions and binding revisions are immutable, and external
 * identifiers are indexed so that no two owners — and no two tenants or
 * authorities — can alias the same upstream account.
 */

const withPorts = async (
  work: (
    ports: ReturnType<typeof createConnectorPorts>,
    store: SQLiteCeremonyStore,
  ) => Promise<void>,
  options: Parameters<typeof createConnectorPorts>[1] = {},
) => {
  const store = new SQLiteCeremonyStore(":memory:", stateKeyring());
  try {
    await work(createConnectorPorts(store, options), store);
  } finally {
    await store.close();
  }
};

test("STATE-01: sources and definitions round-trip, definitions are immutable per reference", async () => {
  await withPorts(async (ports) => {
    const source = sourceRecord();
    await ports.definitions.putSource("tenant-a", source);
    assert.deepEqual(
      await ports.definitions.getSource("tenant-a", source.sourceRef),
      source,
    );
    // Another tenant sees nothing, and an unreadable reference is not an error.
    assert.equal(
      await ports.definitions.getSource("tenant-b", source.sourceRef),
      undefined,
    );
    assert.equal(await ports.definitions.getSource("tenant-a", "!"), undefined);

    // Provenance may be added to a source; its identity and digest may not change.
    await ports.definitions.putSource("tenant-a", {
      ...source,
      artifactRef: `artifact:${"d".repeat(64)}`,
    });
    assert.equal(
      (await ports.definitions.getSource("tenant-a", source.sourceRef))
        ?.artifactRef,
      `artifact:${"d".repeat(64)}`,
    );
    await assert.rejects(
      ports.definitions.putSource("tenant-a", {
        ...source,
        digest: { algorithm: "sha256", value: "e".repeat(64) },
      }),
      (error: unknown) =>
        error instanceof ConnectorError &&
        error.code === "conflict" &&
        error.detail === "source.immutable",
    );

    const definition = definitionRecord({ sourceRef: source.sourceRef });
    await ports.definitions.putDefinition("tenant-a", definition);
    // Writing the identical definition again is a no-op, not a conflict.
    await ports.definitions.putDefinition("tenant-a", definition);
    assert.deepEqual(
      await ports.definitions.getDefinition(
        "tenant-a",
        definition.definitionRef,
      ),
      definition,
    );
    await assert.rejects(
      ports.definitions.putDefinition("tenant-a", {
        ...definition,
        display: { ...definition.display, name: "Renamed" },
      }),
      (error: unknown) =>
        error instanceof ConnectorError &&
        error.detail === "definition.immutable",
    );
    assert.deepEqual(
      (await ports.definitions.listDefinitions("tenant-a")).map(
        (item) => item.definitionRef,
      ),
      [definition.definitionRef],
    );
    assert.deepEqual(
      await ports.definitions.listDefinitions("tenant-a", { ecosystem: "mcp" }),
      [],
    );
    assert.deepEqual(await ports.definitions.listDefinitions("tenant-b"), []);
  });
});

test("STATE-01: binding revisions are immutable and each revision stays readable", async () => {
  await withPorts(async (ports) => {
    const first = runtimeBinding({ tenantId: "tenant-a", revision: 1 });
    await ports.definitions.putBinding(first);
    await assert.rejects(
      ports.definitions.putBinding({
        ...first,
        reviewedDigest: "f".repeat(64),
      }),
      (error: unknown) =>
        error instanceof ConnectorError &&
        error.code === "conflict" &&
        error.detail === "binding.revision-exists",
    );
    // Re-approving the identical bytes is still refused: a revision is written once.
    await assert.rejects(ports.definitions.putBinding(first), ConnectorError);

    const second = runtimeBinding({
      tenantId: "tenant-a",
      revision: 2,
      reviewedDigest: "0".repeat(64),
    });
    await ports.definitions.putBinding(second);
    assert.equal(
      (await ports.definitions.getBinding("tenant-a", first.bindingRef))
        ?.revision,
      2,
    );
    assert.equal(
      (await ports.definitions.getBinding("tenant-a", first.bindingRef, 1))
        ?.reviewedDigest,
      "c".repeat(64),
    );
    assert.equal(
      await ports.definitions.getBinding("tenant-a", first.bindingRef, 3),
      undefined,
    );
    assert.deepEqual(
      (
        await ports.definitions.listBindingRevisions(
          "tenant-a",
          first.bindingRef,
        )
      ).map((item) => item.revision),
      [1, 2],
    );
    assert.deepEqual(
      (await ports.definitions.listBindings("tenant-a")).map(
        (item) => item.revision,
      ),
      [2],
    );
    assert.deepEqual(
      await ports.definitions.listBindings("tenant-a", {
        adapterId: "other-adapter",
      }),
      [],
    );
    // A binding belongs to the tenant inside it, so another tenant cannot read it.
    assert.equal(
      await ports.definitions.getBinding("tenant-b", first.bindingRef),
      undefined,
    );
  });
});

test("STATE-01: connections are owner scoped and foreign reads are indistinguishable from missing ones", async () => {
  await withPorts(async (ports) => {
    const owner = actorFor("tenant-a", "subject-1");
    const other = actorFor("tenant-a", "subject-2");
    const foreignTenant = actorFor("tenant-b", "subject-1");
    const record = connectionRecord({ tenantId: "tenant-a" });
    assert.deepEqual(await ports.connections.create(record), { revision: 1 });

    const read = await ports.connections.get(owner, record.connectionRef);
    assert.equal(read?.revision, 1);
    assert.equal(read?.record.displayName, "Fixture connection");
    assert.equal(
      await ports.connections.get(other, record.connectionRef),
      undefined,
    );
    assert.equal(
      await ports.connections.get(foreignTenant, record.connectionRef),
      undefined,
    );
    assert.equal(
      await ports.connections.get(owner, `connection:${randomUUID()}`),
      undefined,
    );
    assert.deepEqual(await ports.connections.list(other), []);
    assert.deepEqual(
      (await ports.connections.list(owner)).map(
        (item) => item.record.connectionRef,
      ),
      [record.connectionRef],
    );
    assert.deepEqual(
      await ports.connections.list(owner, { lifecycle: "expired" }),
      [],
    );

    // A foreign update fails as "not found": ownership never leaks existence.
    await assert.rejects(
      ports.connections.update(other, record.connectionRef, 1, {
        lifecycle: "degraded",
      }),
      (error: unknown) =>
        error instanceof ConnectorError && error.code === "not-found",
    );
    await assert.rejects(
      ports.connections.update(owner, record.connectionRef, 7, {
        lifecycle: "degraded",
      }),
      (error: unknown) =>
        error instanceof ConnectorError && error.code === "conflict",
    );
    // Immutable identity fields are refused rather than silently ignored.
    await assert.rejects(
      ports.connections.update(owner, record.connectionRef, 1, {
        tenantId: "tenant-b",
      } as never),
      (error: unknown) =>
        error instanceof ConnectorError &&
        error.detail === "connection.immutable-field",
    );
    const updated = await ports.connections.update(
      owner,
      record.connectionRef,
      1,
      { lifecycle: "degraded", lastOutcome: "provider.unavailable" },
    );
    assert.equal(updated.revision, 2);
    const after = await ports.connections.get(owner, record.connectionRef);
    assert.equal(after?.record.lifecycle, "degraded");
    assert.equal(after?.record.revision, 2);
    assert.equal(after?.record.ownerId, "subject-1");
  });
});

test("STATE-01: an external identifier binds to one owner per tenant and authority", async () => {
  await withPorts(async (ports) => {
    const actorA = actorFor("tenant-a");
    const first = connectionRecord({
      tenantId: "tenant-a",
      externalIds: { connectionId: "conn_shared_value" },
    });
    await ports.connections.create(first);

    const found = await ports.connections.findByExternalId(
      "tenant-a",
      first.authorityInstance,
      "connectionId",
      "conn_shared_value",
    );
    assert.equal(found?.record.connectionRef, first.connectionRef);

    // A second owner in the same tenant and authority cannot claim the same id.
    const second = connectionRecord({
      tenantId: "tenant-a",
      ownerId: "subject-2",
      externalIds: { connectionId: "conn_shared_value" },
    });
    await assert.rejects(
      ports.connections.create(second),
      (error: unknown) =>
        error instanceof ConnectorError &&
        error.code === "conflict" &&
        error.detail === "connection.external-id-bound",
    );
    // The failed create left nothing behind.
    assert.equal(
      await ports.connections.get(
        actorFor("tenant-a", "subject-2"),
        second.connectionRef,
      ),
      undefined,
    );

    // AC-AUTH-02: another tenant with the same authority and the same upstream
    // spelling is a different connection; nothing is shared or aliased.
    const otherTenant = connectionRecord({
      tenantId: "tenant-b",
      externalIds: { connectionId: "conn_shared_value" },
    });
    await ports.connections.create(otherTenant);
    assert.equal(
      (
        await ports.connections.findByExternalId(
          "tenant-b",
          otherTenant.authorityInstance,
          "connectionId",
          "conn_shared_value",
        )
      )?.record.connectionRef,
      otherTenant.connectionRef,
    );
    assert.equal(
      await ports.connections.get(actorA, otherTenant.connectionRef),
      undefined,
    );

    // A different authority instance is a different key even in one tenant.
    const otherAuthority = connectionRecord({
      tenantId: "tenant-a",
      authorityInstance: "https://eu.api.fixture.example",
      externalIds: { connectionId: "conn_shared_value" },
    });
    await ports.connections.create(otherAuthority);
    assert.equal(
      (
        await ports.connections.findByExternalId(
          "tenant-a",
          "https://eu.api.fixture.example",
          "connectionId",
          "conn_shared_value",
        )
      )?.record.connectionRef,
      otherAuthority.connectionRef,
    );

    // Lookups are exact: no display-name or prefix matching.
    assert.equal(
      await ports.connections.findByExternalId(
        "tenant-a",
        first.authorityInstance,
        "connectionId",
        "conn_shared",
      ),
      undefined,
    );
    assert.equal(
      await ports.connections.findByExternalId(
        "tenant-a",
        first.authorityInstance,
        "installationId",
        "conn_shared_value",
      ),
      undefined,
    );

    // Releasing the identifier frees it for a later owner.
    const current = await ports.connections.get(actorA, first.connectionRef);
    await ports.connections.update(
      actorA,
      first.connectionRef,
      current!.revision,
      {
        externalIds: {},
      },
    );
    assert.equal(
      await ports.connections.findByExternalId(
        "tenant-a",
        first.authorityInstance,
        "connectionId",
        "conn_shared_value",
      ),
      undefined,
    );
    await ports.connections.create(second);
    assert.equal(
      (
        await ports.connections.findByExternalId(
          "tenant-a",
          second.authorityInstance,
          "connectionId",
          "conn_shared_value",
        )
      )?.record.connectionRef,
      second.connectionRef,
    );
  });
});

test("STATE-01: a shared grant identifier may be carried by several connections", async () => {
  await withPorts(
    async (ports) => {
      const shared = { installationId: "inst_42" };
      const a = connectionRecord({ tenantId: "tenant-a", externalIds: shared });
      const b = connectionRecord({
        tenantId: "tenant-a",
        externalIds: { ...shared, connectionId: "conn_b" },
      });
      await ports.connections.create(a);
      await ports.connections.create(b);
      const all = await ports.connections.listByExternalId(
        "tenant-a",
        a.authorityInstance,
        "installationId",
        "inst_42",
      );
      assert.deepEqual(
        all.map((item) => item.record.connectionRef).sort(),
        [a.connectionRef, b.connectionRef].sort(),
      );
      assert.deepEqual(
        await ports.connections.sharedWith(
          actorFor("tenant-a"),
          a.connectionRef,
        ),
        [b.connectionRef],
      );
      // An exclusive name is still exclusive alongside a shared one.
      await assert.rejects(
        ports.connections.create(
          connectionRecord({
            tenantId: "tenant-a",
            externalIds: { connectionId: "conn_b" },
          }),
        ),
        ConnectorError,
      );
    },
    { sharedExternalIdNames: ["installationId"] },
  );
});

test("STATE-01: keys are digests, native spelling lives inside the encrypted value", async () => {
  await withPorts(async (ports, store) => {
    const native = "acme/Orders API#v2 (beta)";
    const record = connectionRecord({
      tenantId: "tenant-a",
      externalIds: { connectionId: native },
    });
    await ports.connections.create(record);
    const ids = await store.transaction(async (tx) => [
      ...(await tx.list("tenant-a", "connector-connection")).map(
        (row) => row.id,
      ),
      ...(await tx.list("tenant-a", "connector-connection-index")).map(
        (row) => row.id,
      ),
    ]);
    assert.ok(ids.length >= 2);
    for (const id of ids) {
      assert.equal(id.includes(native), false);
      assert.equal(id.includes("Orders"), false);
      assert.match(id, /^[a-zA-Z0-9_.:@/-]{1,200}$/);
    }
    // The exact upstream spelling survives for lookup and round trips.
    assert.equal(
      (
        await ports.connections.findByExternalId(
          "tenant-a",
          record.authorityInstance,
          "connectionId",
          native,
        )
      )?.record.externalIds.connectionId,
      native,
    );
  });
});

test("STATE-01: stored values are schema-validated on read", async () => {
  await withPorts(async (ports, store) => {
    const record = connectionRecord({ tenantId: "tenant-a" });
    await ports.connections.create(record);
    const key = await store.transaction(async (tx) => {
      const rows = await tx.list("tenant-a", "connector-connection");
      assert.equal(rows.length, 1);
      const value = rows[0]!.value as { schemaVersion: number };
      assert.equal(value.schemaVersion, 1);
      return { id: rows[0]!.id, revision: rows[0]!.revision };
    });
    // A value that no longer matches its schema is refused, not half-read.
    await store.transaction((tx) =>
      tx.put(
        { tenant: "tenant-a", kind: "connector-connection", id: key.id },
        { schemaVersion: 1, record: { connectionRef: "connection:x" } },
        key.revision,
      ),
    );
    await assert.rejects(
      ports.connections.get(actorFor("tenant-a"), record.connectionRef),
      /not readable/,
    );
  });
});

test("STATE-01: the connection key digest covers the whole charter tuple", async () => {
  const base = {
    tenantId: "tenant-a",
    ownerKind: "user",
    ownerId: "subject-1",
    authorityInstance: "https://api.fixture.example",
    upstreamAccount: { connectionId: "conn_1" },
    clientRegistration: "client-1",
    authenticationProfile: "oauth-authorization-code",
    target: { kind: "project", id: "prj_1" },
    bindingRef: "binding:fixture",
    bindingRevision: 1,
    policyRevision: "policy-1",
    configurationRevision: "cfg-1",
  } as const;
  const digest = connectionKeyDigest(base);
  assert.match(digest, /^[a-f0-9]{64}$/);
  // Key order is irrelevant; every component is load-bearing.
  assert.equal(
    connectionKeyDigest({
      ...Object.fromEntries(Object.entries(base).reverse()),
    } as typeof base),
    digest,
  );
  for (const change of [
    { tenantId: "tenant-b" },
    { ownerKind: "organization" },
    { ownerId: "subject-2" },
    { authorityInstance: "https://eu.api.fixture.example" },
    { upstreamAccount: { connectionId: "conn_2" } },
    { clientRegistration: "client-2" },
    { authenticationProfile: "api-key" },
    { target: { kind: "project", id: "prj_2" } },
    { bindingRef: "binding:other" },
    { bindingRevision: 2 },
    { policyRevision: "policy-2" },
    { configurationRevision: "cfg-2" },
    { sessionId: "session-1" },
  ])
    assert.notEqual(
      connectionKeyDigest({ ...base, ...change } as typeof base),
      digest,
      `key ignored ${JSON.stringify(change)}`,
    );
});

test("STATE-01: support snapshots record measured capability evidence per adapter version", async () => {
  await withPorts(async (ports) => {
    const snapshot = {
      adapterId: "fixture-adapter",
      adapterVersion: "1",
      runtime: "hosted-server" as const,
      capabilities: [
        {
          dimension: "invoke" as const,
          profile: "openapi-3.1",
          adapterVersion: "1",
          runtime: "hosted-server" as const,
          implementation: "implemented" as const,
          configuration: "ready" as const,
          evidence: "protocol-fixture" as const,
          limitations: [],
        },
      ],
      capturedAt: new Date(1_700_000_000_000).toISOString(),
    };
    await ports.support.put("tenant-a", snapshot);
    assert.deepEqual(
      await ports.support.get("tenant-a", "fixture-adapter", "1"),
      snapshot,
    );
    const newer = {
      ...snapshot,
      capturedAt: new Date(1_700_000_100_000).toISOString(),
    };
    await ports.support.put("tenant-a", newer);
    assert.equal(
      (await ports.support.get("tenant-a", "fixture-adapter", "1"))?.capturedAt,
      newer.capturedAt,
    );
    await assert.rejects(
      ports.support.put("tenant-a", snapshot),
      (error: unknown) =>
        error instanceof ConnectorError &&
        error.detail === "support.older-capture",
    );
    assert.equal((await ports.support.list("tenant-a")).length, 1);
    assert.deepEqual(await ports.support.list("tenant-b"), []);
  });
});

test("STATE-01: evidence is appended per connection and never returned to another owner", async () => {
  await withPorts(async (ports) => {
    const owner = actorFor("tenant-a");
    const record = connectionRecord({ tenantId: "tenant-a" });
    await ports.connections.create(record);
    const first = claim({ evidenceRef: "evidence:1" });
    assert.equal(
      await ports.evidence.append(owner, record.connectionRef, first),
      "evidence:1",
    );
    // The same claim again is idempotent; a different claim under the same reference is not.
    await ports.evidence.append(owner, record.connectionRef, first);
    await assert.rejects(
      ports.evidence.append(owner, record.connectionRef, {
        ...first,
        target: { kind: "account", id: "acct_other" },
      }),
      (error: unknown) =>
        error instanceof ConnectorError &&
        error.detail === "evidence.ref-in-use",
    );
    assert.equal(
      (await ports.evidence.list(owner, record.connectionRef)).length,
      1,
    );
    assert.deepEqual(
      await ports.evidence.list(
        actorFor("tenant-a", "subject-2"),
        record.connectionRef,
      ),
      [],
    );
    await assert.rejects(
      ports.evidence.append(
        actorFor("tenant-a", "subject-2"),
        record.connectionRef,
        claim(),
      ),
      (error: unknown) =>
        error instanceof ConnectorError && error.code === "not-found",
    );
  });
});
