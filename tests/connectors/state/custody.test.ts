import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { createConnectorPorts } from "../../../src/server/connectors/state/index.js";
import { ConnectorError } from "../../../src/server/connectors/errors.js";
import { SQLiteCeremonyStore } from "../../../src/server/persistence/index.js";
import {
  actorFor,
  connectionRecord,
  credentialScope,
  sqliteFixture,
  stateKeyring,
} from "../fixtures/state/records.js";

/*
 * STATE-02: custody ports. Host-owned material is written once, used inside a
 * trusted callback, rotated under a single-flight lock and revoked by
 * reference; external brokers keep their own tokens and only their protected
 * reference is held here. The canary in every test is a distinctive string:
 * it must never appear in a result, an error, a listing, an index record or
 * the database file.
 */

const CANARY = "canary-secret-vGq7Kx2PmR4tZs9Lw";

const clockAt = (start: number) => {
  let value = start;
  return {
    now: () => value,
    advance: (ms: number) => {
      value += ms;
    },
  };
};

test("STATE-02: material is stored once, used in a callback and never returned to the caller", async () => {
  const store = new SQLiteCeremonyStore(":memory:", stateKeyring());
  const clock = clockAt(1_700_000_000_000);
  const ports = createConnectorPorts(store, { now: clock.now });
  try {
    const scope = credentialScope("tenant-a");
    const ref = await ports.credentials.store(scope, {
      accessToken: CANARY,
      refreshToken: `${CANARY}-refresh`,
    });
    assert.match(ref, /^cred:[0-9a-f-]{36}$/);

    // A callback may compute with the material and return a derived fact.
    assert.deepEqual(
      await ports.credentials.use(scope, ref, async (material) => {
        assert.equal(material.accessToken, CANARY);
        assert.equal(material.refreshToken, `${CANARY}-refresh`);
        return { length: material.accessToken.length };
      }),
      { length: CANARY.length },
    );

    // Returning the material — directly, nested, or inside a URL — is refused.
    for (const leak of [
      async (material: Readonly<Record<string, string>>) => material.accessToken,
      async (material: Readonly<Record<string, string>>) => ({
        deep: [{ token: material.accessToken }],
      }),
      async (material: Readonly<Record<string, string>>) =>
        `https://api.example/?access_token=${material.accessToken}`,
      async (material: Readonly<Record<string, string>>) =>
        new Map([["t", material.refreshToken]]),
      async (material: Readonly<Record<string, string>>) =>
        new Set([material.accessToken]),
      async (material: Readonly<Record<string, string>>) =>
        new TextEncoder().encode(material.accessToken),
    ])
      await assert.rejects(
        ports.credentials.use(scope, ref, leak),
        (error: unknown) => {
          assert.ok(error instanceof ConnectorError);
          assert.equal(error.code, "denied");
          assert.equal(error.detail, "credential.material-in-result");
          // The refusal itself must not quote what it refused.
          assert.equal(`${error.message}${error.stack}`.includes(CANARY), false);
          return true;
        },
      );

    // describe reports custody and expiry only.
    assert.deepEqual(await ports.credentials.describe(scope, ref), {
      custody: "host-owned",
    });
    const described = JSON.stringify(
      await ports.credentials.describe(scope, ref),
    );
    assert.equal(described.includes(CANARY), false);

    await ports.credentials.revoke(scope, ref);
    assert.equal(await ports.credentials.describe(scope, ref), undefined);
    await assert.rejects(
      ports.credentials.use(scope, ref, async () => "ok"),
      (error: unknown) =>
        error instanceof ConnectorError && error.code === "not-found",
    );
  } finally {
    await store.close();
  }
});

test("STATE-02: the credential scope is checked on every access", async () => {
  const store = new SQLiteCeremonyStore(":memory:", stateKeyring());
  const ports = createConnectorPorts(store);
  try {
    const scope = credentialScope("tenant-a");
    const ref = await ports.credentials.store(scope, { accessToken: CANARY });
    for (const wrong of [
      credentialScope("tenant-b"),
      credentialScope("tenant-a", { ownerId: "subject-2" }),
      credentialScope("tenant-a", { ownerKind: "organization" }),
      credentialScope("tenant-a", { connectionRef: "connection:other" }),
      credentialScope("tenant-a", { bindingRef: "binding:other" }),
      credentialScope("tenant-a", { custody: "external-credential-broker" }),
    ]) {
      assert.equal(await ports.credentials.describe(wrong, ref), undefined);
      await assert.rejects(
        ports.credentials.use(wrong, ref, async () => "ok"),
        (error: unknown) =>
          error instanceof ConnectorError && error.code === "not-found",
      );
      await assert.rejects(
        ports.credentials.refresh(wrong, ref, async () => ({
          material: { accessToken: "new" },
        })),
        ConnectorError,
      );
      // A revoke under the wrong scope is a no-op, never a deletion.
      await ports.credentials.revoke(wrong, ref);
    }
    assert.ok(await ports.credentials.describe(scope, ref));
    // A malformed reference is refused before any lookup.
    await assert.rejects(
      ports.credentials.use(scope, "not-a-ref", async () => "ok"),
      (error: unknown) =>
        error instanceof ConnectorError && error.code === "not-found",
    );
  } finally {
    await store.close();
  }
});

test("STATE-02: expiry has a safety margin and refresh rotates under single flight", async () => {
  const store = new SQLiteCeremonyStore(":memory:", stateKeyring());
  const clock = clockAt(1_700_000_000_000);
  const ports = createConnectorPorts(store, {
    now: clock.now,
    expirySafetyMarginMs: 30_000,
  });
  try {
    const scope = credentialScope("tenant-a");
    const ref = await ports.credentials.store(
      scope,
      { accessToken: `${CANARY}-1` },
      { expiresAt: clock.now() + 120_000 },
    );
    assert.equal(await ports.credentials.needsRefresh(scope, ref), false);
    assert.equal(
      await ports.credentials.use(scope, ref, async (m) => m.accessToken.length),
      `${CANARY}-1`.length,
    );

    // Inside the safety margin the credential is refused before it is expired.
    clock.advance(100_000);
    assert.equal(await ports.credentials.needsRefresh(scope, ref), true);
    await assert.rejects(
      ports.credentials.use(scope, ref, async () => "ok"),
      (error: unknown) =>
        error instanceof ConnectorError &&
        error.code === "expired" &&
        error.detail === "credential.expiring",
    );
    clock.advance(30_000);
    await assert.rejects(
      ports.credentials.use(scope, ref, async () => "ok"),
      (error: unknown) =>
        error instanceof ConnectorError && error.detail === "credential.expired",
    );

    // Two concurrent refreshes share one upstream call.
    let upstream = 0;
    const rotate = async (current: Readonly<Record<string, string>>) => {
      upstream++;
      assert.match(current.accessToken!, /^canary-secret/);
      await new Promise((resolve) => setTimeout(resolve, 10));
      return {
        material: { accessToken: `${CANARY}-2` },
        expiresAt: clock.now() + 600_000,
      };
    };
    const [a, b] = await Promise.all([
      ports.credentials.refresh(scope, ref, rotate),
      ports.credentials.refresh(scope, ref, rotate),
    ]);
    assert.equal(upstream, 1);
    assert.equal(a.ref, ref);
    assert.deepEqual(a, b);
    // The rotated material is what a later use sees, and it is usable again
    // because the new expiry is outside the safety margin.
    assert.equal(
      await ports.credentials.use(
        scope,
        ref,
        async (m) => m.accessToken === `${CANARY}-2`,
      ),
      true,
    );
    assert.equal(await ports.credentials.needsRefresh(scope, ref), false);
    assert.deepEqual(await ports.credentials.describe(scope, ref), {
      custody: "host-owned",
      expiresAt: clock.now() + 600_000,
    });
  } finally {
    await store.close();
  }
});

test("AC-STATE-01: a refresh computed against an older generation cannot overwrite a newer credential", async () => {
  const store = new SQLiteCeremonyStore(":memory:", stateKeyring());
  const ports = createConnectorPorts(store);
  try {
    const scope = credentialScope("tenant-a");
    const ref = await ports.credentials.store(scope, { accessToken: "token-1" });
    await assert.rejects(
      ports.credentials.refresh(scope, ref, async () => {
        // While this rotation was in flight the credential was replaced.
        await ports.credentials.store(
          scope,
          { accessToken: "token-current" },
          { replaces: ref },
        );
        return { material: { accessToken: "token-stale" } };
      }),
      (error: unknown) =>
        error instanceof ConnectorError &&
        error.code === "conflict" &&
        error.detail === "credential.stale-refresh",
    );
    assert.equal(
      await ports.credentials.use(scope, ref, async (m) =>
        m.accessToken === "token-current" ? "current" : "stale",
      ),
      "current",
    );
  } finally {
    await store.close();
  }
});

test("STATE-02: a failing refresh releases its lease and keeps the previous material", async () => {
  const store = new SQLiteCeremonyStore(":memory:", stateKeyring());
  const ports = createConnectorPorts(store);
  try {
    const scope = credentialScope("tenant-a");
    const ref = await ports.credentials.store(scope, { accessToken: "token-1" });
    await assert.rejects(
      ports.credentials.refresh(scope, ref, async () => {
        throw new Error(`upstream said ${CANARY}`);
      }),
      /upstream said/,
    );
    // The lease is free, so a later refresh proceeds rather than waiting it out.
    const rotated = await ports.credentials.refresh(scope, ref, async (current) => {
      assert.equal(current.accessToken, "token-1");
      return { material: { accessToken: "token-2" } };
    });
    assert.equal(rotated.ref, ref);
    assert.equal(
      await ports.credentials.use(scope, ref, async (m) =>
        m.accessToken === "token-2",
      ),
      true,
    );
    // A refresh that returns nothing usable is refused, and the old material stands.
    await assert.rejects(
      ports.credentials.refresh(scope, ref, async () => ({ material: {} })),
      (error: unknown) =>
        error instanceof ConnectorError &&
        error.detail === "credential.material-empty",
    );
    assert.equal(
      await ports.credentials.use(scope, ref, async (m) =>
        m.accessToken === "token-2",
      ),
      true,
    );
  } finally {
    await store.close();
  }
});

test("STATE-02: broker, attended-browser and no-credential custody keep their own kind", async () => {
  const store = new SQLiteCeremonyStore(":memory:", stateKeyring());
  const ports = createConnectorPorts(store);
  try {
    // An external credential broker: only its protected reference is held here.
    const brokerScope = credentialScope("tenant-a", {
      custody: "external-credential-broker",
    });
    const brokerRef = await ports.credentials.store(brokerScope, {
      brokerConnectionId: "nango:conn_1",
      brokerEnvironment: "prod",
    });
    assert.deepEqual(await ports.credentials.describe(brokerScope, brokerRef), {
      custody: "external-credential-broker",
    });
    await ports.credentials.use(brokerScope, brokerRef, async (material) => {
      assert.deepEqual(Object.keys(material).sort(), [
        "brokerConnectionId",
        "brokerEnvironment",
      ]);
      // No upstream token was copied into host custody.
      assert.equal(Object.values(material).some((v) => v.includes("token")), false);
      return "ok";
    });

    // An execution broker holds no token the host could ever present.
    const executionScope = credentialScope("tenant-a", {
      custody: "external-execution-broker",
    });
    const executionRef = await ports.credentials.store(executionScope, {
      brokerAccountId: "composio:acct_1",
    });
    assert.equal(
      (await ports.credentials.describe(executionScope, executionRef))?.custody,
      "external-execution-broker",
    );

    // An attended-browser reference points at a session, not at material.
    const attendedScope = credentialScope("tenant-a", {
      custody: "attended-browser",
    });
    const attendedRef = await ports.credentials.store(attendedScope, {
      browserProfile: "profile-1",
    });
    assert.equal(
      (await ports.credentials.describe(attendedScope, attendedRef))?.custody,
      "attended-browser",
    );

    // A no-credential connection stores a record with nothing in it.
    const publicScope = credentialScope("tenant-a", { custody: "no-credential" });
    const publicRef = await ports.credentials.store(publicScope, {});
    assert.equal(
      (await ports.credentials.describe(publicScope, publicRef))?.custody,
      "no-credential",
    );
    await assert.rejects(
      ports.credentials.store(publicScope, { accessToken: "should-not-exist" }),
      (error: unknown) =>
        error instanceof ConnectorError &&
        error.detail === "credential.material-forbidden",
    );
  } finally {
    await store.close();
  }
});

test("STATE-02: no canary reaches listings, index records, diagnostics or the database file", async () => {
  const fixture = await sqliteFixture();
  const ports = createConnectorPorts(fixture.store);
  try {
    const actor = actorFor("tenant-a");
    const record = connectionRecord({
      tenantId: "tenant-a",
      externalIds: { connectionId: "conn_public_1" },
    });
    await ports.connections.create(record);
    const scope = credentialScope("tenant-a", {
      connectionRef: record.connectionRef,
    });
    const ref = await ports.credentials.store(scope, { accessToken: CANARY });
    const current = await ports.connections.get(actor, record.connectionRef);
    await ports.connections.update(actor, record.connectionRef, current!.revision, {
      credentialRef: ref,
    });

    const surfaces = JSON.stringify([
      await ports.connections.list(actor),
      await ports.connections.get(actor, record.connectionRef),
      await ports.connections.findByExternalId(
        "tenant-a",
        record.authorityInstance,
        "connectionId",
        "conn_public_1",
      ),
      await ports.credentials.describe(scope, ref),
      await ports.evidence.list(actor, record.connectionRef),
      await ports.effects.listUnresolved(actor),
      await ports.throttle.state("tenant-a", record.authorityInstance),
    ]);
    assert.equal(surfaces.includes(CANARY), false);
    // The connection carries the reference, not the material.
    assert.ok(surfaces.includes(ref));

    // Index rows are plaintext keys only; their decrypted values hold no material.
    const indexRows = await fixture.store.transaction((tx) =>
      tx.list("tenant-a", "connector-connection-index"),
    );
    assert.equal(indexRows.length, 1);
    assert.equal(JSON.stringify(indexRows).includes(CANARY), false);

    await fixture.reopen();
    const bytes = await readFile(fixture.path);
    assert.equal(bytes.includes(Buffer.from(CANARY)), false);
    // ... and the material is still usable after the reopen, so it was stored, not dropped.
    const reopened = createConnectorPorts(fixture.store);
    assert.equal(
      await reopened.credentials.use(scope, ref, async (m) => m.accessToken === CANARY),
      true,
    );
  } finally {
    await fixture.close();
  }
});
