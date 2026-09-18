import assert from "node:assert/strict";
import test from "node:test";
import {
  createConnectorPorts,
  explainDisconnect,
  isVerificationCurrent,
  type CacheInvalidationEvent,
} from "../../../src/server/connectors/state/index.js";
import { ConnectorError } from "../../../src/server/connectors/errors.js";
import { SQLiteCeremonyStore } from "../../../src/server/persistence/index.js";
import {
  actorFor,
  claim,
  connectionRecord,
  stateKeyring,
} from "../fixtures/state/records.js";

/*
 * STATE-05: revocation and drift invalidation. When the reviewed source, the
 * binding revision, the policy revision or the configuration revision moves,
 * the evidence gathered under the old tuple is marked stale and the
 * connection leaves `active`, so a stale "connected" badge never implies
 * authorization. Local unlink, broker deletion and upstream revocation stay
 * three separate outcomes with their own policy, and a partial external
 * result is explained rather than rounded to success or failure.
 */

const clockAt = (start: number) => {
  let value = start;
  return {
    now: () => value,
    advance: (ms: number) => {
      value += ms;
    },
  };
};

const setup = async (
  options: Parameters<typeof createConnectorPorts>[1] = {},
) => {
  const store = new SQLiteCeremonyStore(":memory:", stateKeyring());
  const clock = clockAt(1_700_000_000_000);
  const invalidations: CacheInvalidationEvent[] = [];
  const ports = createConnectorPorts(store, {
    now: clock.now,
    cacheInvalidation: (event) => {
      invalidations.push(event);
    },
    ...options,
  });
  return { store, clock, ports, invalidations };
};

const verified = (clock: { now: () => number }) => ({
  kinds: ["account-identity" as const],
  observedAt: new Date(clock.now()).toISOString(),
  validUntil: new Date(clock.now() + 3_600_000).toISOString(),
  limitations: [],
});

test("AC-STATE-05: a changed binding revision invalidates evidence and requires reconnecting", async () => {
  const { store, clock, ports, invalidations } = await setup();
  try {
    const actor = actorFor("tenant-a");
    const record = connectionRecord({
      tenantId: "tenant-a",
      verification: verified(clock),
    });
    await ports.connections.create(record);
    await ports.evidence.append(actor, record.connectionRef, claim());
    await ports.handoffs.issue({
      actor,
      connectionRef: record.connectionRef,
      bindingRef: record.bindingRef,
      generation: 0,
      kind: "provider-browser",
      presentation: "popup",
      expiresAt: clock.now() + 60_000,
      intent: "authorize.initial",
      private: { url: "https://issuer.example/authorize" },
    });
    assert.equal(
      isVerificationCurrent(
        (await ports.connections.get(actor, record.connectionRef))!.record,
        clock.now(),
      ),
      true,
    );

    const outcome = await ports.drift.invalidateForDrift(
      actor,
      record.connectionRef,
      { bindingRevisionChanged: true },
    );
    assert.equal(outcome.lifecycle, "reconnect-required");
    assert.equal(outcome.generation, 1);
    assert.equal(outcome.evidenceInvalidated, 1);
    assert.equal(outcome.handoffsSettled, 1);
    assert.deepEqual(outcome.reasons, ["drift.binding-revision"]);

    const after = await ports.connections.get(actor, record.connectionRef);
    assert.equal(after?.record.lifecycle, "reconnect-required");
    assert.equal(after?.record.verification, undefined);
    assert.equal(after?.record.lastOutcome, "drift.binding-revision");
    assert.equal(isVerificationCurrent(after!.record, clock.now()), false);
    assert.deepEqual(await ports.evidence.list(actor, record.connectionRef), []);
    assert.equal(
      (await ports.evidence.listAll(actor, record.connectionRef))[0]?.stale
        ?.reason,
      "drift.binding-revision",
    );
    // The cache hook was told which connection, authority and key to drop.
    assert.equal(invalidations.length, 1);
    assert.equal(invalidations[0]!.connectionRef, record.connectionRef);
    assert.equal(invalidations[0]!.reason, "drift.binding-revision");
    assert.equal(
      invalidations[0]!.authorityInstance,
      record.authorityInstance,
    );
    assert.match(invalidations[0]!.keyDigest!, /^[a-f0-9]{64}$/);
  } finally {
    await store.close();
  }
});

test("AC-STATE-05: policy and configuration drift revalidate without forcing a new grant", async () => {
  const { store, clock, ports } = await setup();
  try {
    const actor = actorFor("tenant-a");
    const record = connectionRecord({
      tenantId: "tenant-a",
      verification: verified(clock),
    });
    await ports.connections.create(record);
    await ports.evidence.append(actor, record.connectionRef, claim());

    const outcome = await ports.drift.invalidateForDrift(
      actor,
      record.connectionRef,
      { policyRevisionChanged: true, configurationRevisionChanged: true },
    );
    // Verification must be re-established, but the grant itself is untouched:
    // the generation does not move, so an in-flight callback is not discarded.
    assert.equal(outcome.lifecycle, "verifying");
    assert.equal(outcome.generation, 0);
    assert.equal(outcome.handoffsSettled, 0);
    assert.deepEqual(outcome.reasons, [
      "drift.policy-revision",
      "drift.configuration-revision",
    ]);
    assert.deepEqual(await ports.evidence.list(actor, record.connectionRef), []);

    // Drift with nothing changed is a programming error, not a silent no-op.
    await assert.rejects(
      ports.drift.invalidateForDrift(actor, record.connectionRef, {}),
      (error: unknown) =>
        error instanceof ConnectorError && error.detail === "drift.empty",
    );
    // A foreign connection is never invalidated.
    await assert.rejects(
      ports.drift.invalidateForDrift(
        actorFor("tenant-b"),
        record.connectionRef,
        { sourceDigestChanged: true },
      ),
      (error: unknown) =>
        error instanceof ConnectorError && error.code === "not-found",
    );
  } finally {
    await store.close();
  }
});

test("AC-STATE-05: expired verification moves the connection out of active", async () => {
  const { store, clock, ports } = await setup();
  try {
    const actor = actorFor("tenant-a");
    const record = connectionRecord({
      tenantId: "tenant-a",
      verification: verified(clock),
    });
    await ports.connections.create(record);
    await ports.evidence.append(
      actor,
      record.connectionRef,
      claim({
        observedAt: new Date(clock.now()).toISOString(),
        validUntil: new Date(clock.now() + 3_600_000).toISOString(),
      }),
    );

    // Before expiry nothing changes.
    assert.equal(
      (await ports.drift.expireVerification(actor, record.connectionRef)).expired,
      false,
    );
    assert.equal(
      (await ports.connections.get(actor, record.connectionRef))?.record
        .lifecycle,
      "active",
    );

    clock.advance(3_600_001);
    const expired = await ports.drift.expireVerification(
      actor,
      record.connectionRef,
    );
    assert.equal(expired.expired, true);
    assert.equal(expired.lifecycle, "verifying");
    assert.equal(expired.evidenceInvalidated, 1);
    const after = await ports.connections.get(actor, record.connectionRef);
    assert.equal(after?.record.verification, undefined);
    assert.equal(after?.record.lastOutcome, "verification.expired");
    assert.equal(isVerificationCurrent(after!.record, clock.now()), false);
  } finally {
    await store.close();
  }
});

test("AC-STATE-03: local unlink, broker delete and upstream revoke are distinct outcomes", async () => {
  const { store, ports } = await setup();
  try {
    const actor = actorFor("tenant-a");
    const local = connectionRecord({ tenantId: "tenant-a" });
    await ports.connections.create(local);

    // A default unlink touches nothing upstream and says so.
    const unlinked = await ports.connections.recordDisconnect(
      actor,
      local.connectionRef,
      1,
      {
        scope: "local",
        local: "applied",
        broker: "not-attempted",
        upstream: "not-attempted",
      },
    );
    assert.equal(unlinked.record.lifecycle, "locally-disconnected");
    assert.equal(unlinked.generation, 1);
    assert.deepEqual(explainDisconnect(unlinked.record), {
      codes: [
        "disconnect.local.applied",
        "disconnect.broker.not-attempted",
        "disconnect.upstream.not-attempted",
      ],
      sharedWith: [],
    });
    assert.equal(unlinked.record.disconnect?.upstream, "not-attempted");
    assert.equal(unlinked.record.lastOutcome, "disconnect.local.applied");

    // A broker deletion is a different intent with its own record.
    const broker = connectionRecord({ tenantId: "tenant-a" });
    await ports.connections.create(broker);
    const brokerResult = await ports.connections.recordDisconnect(
      actor,
      broker.connectionRef,
      1,
      {
        scope: "broker",
        local: "applied",
        broker: "applied",
        upstream: "not-attempted",
      },
    );
    assert.equal(brokerResult.record.lifecycle, "locally-disconnected");
    assert.equal(brokerResult.record.disconnect?.scope, "broker");

    // Only an upstream revocation reports the grant as revoked upstream.
    const upstream = connectionRecord({ tenantId: "tenant-a" });
    await ports.connections.create(upstream);
    const upstreamResult = await ports.connections.recordDisconnect(
      actor,
      upstream.connectionRef,
      1,
      {
        scope: "upstream",
        local: "applied",
        broker: "unsupported",
        upstream: "applied",
      },
    );
    assert.equal(upstreamResult.record.lifecycle, "upstream-revoked");
    assert.equal(
      upstreamResult.record.lastOutcome,
      "disconnect.upstream.upstream-revoked",
    );
    assert.ok(
      explainDisconnect(upstreamResult.record)!.codes.includes(
        "disconnect.broker.unsupported",
      ),
    );
  } finally {
    await store.close();
  }
});

test("AC-STATE-03: a partial external outcome is explained, not rounded", async () => {
  const { store, ports } = await setup();
  try {
    const actor = actorFor("tenant-a");
    const record = connectionRecord({ tenantId: "tenant-a" });
    await ports.connections.create(record);
    const result = await ports.connections.recordDisconnect(
      actor,
      record.connectionRef,
      1,
      {
        scope: "upstream",
        local: "applied",
        broker: "failed",
        upstream: "indeterminate",
      },
    );
    // Local state is gone, the broker call failed and the upstream outcome is
    // unknown: three facts, kept apart.
    assert.equal(result.record.disconnect?.local, "applied");
    assert.equal(result.record.disconnect?.broker, "failed");
    assert.equal(result.record.disconnect?.upstream, "indeterminate");
    assert.equal(result.record.lifecycle, "locally-disconnected");
    assert.deepEqual(explainDisconnect(result.record)!.codes, [
      "disconnect.local.applied",
      "disconnect.broker.failed",
      "disconnect.upstream.indeterminate",
    ]);

    // Nothing applied at all: the lifecycle does not change on a failed attempt.
    const second = connectionRecord({ tenantId: "tenant-a" });
    await ports.connections.create(second);
    const failed = await ports.connections.recordDisconnect(
      actor,
      second.connectionRef,
      1,
      {
        scope: "upstream",
        local: "not-attempted",
        broker: "not-attempted",
        upstream: "failed",
      },
    );
    assert.equal(failed.record.lifecycle, "active");
    assert.equal(failed.generation, 0);
    assert.equal(failed.record.lastOutcome, "disconnect.upstream.not-applied");
  } finally {
    await store.close();
  }
});

test("AC-STATE-04: a shared grant is not revoked by disconnecting one local connection", async () => {
  const { store, ports } = await setup({
    sharedExternalIdNames: ["installationId"],
  });
  try {
    const actor = actorFor("tenant-a");
    const shared = { installationId: "inst_7" };
    const first = connectionRecord({
      tenantId: "tenant-a",
      externalIds: { ...shared, connectionId: "conn_a" },
    });
    const second = connectionRecord({
      tenantId: "tenant-a",
      externalIds: { ...shared, connectionId: "conn_b" },
    });
    await ports.connections.create(first);
    await ports.connections.create(second);

    // A local unlink of one is allowed and leaves the other alone.
    const allowed = await ports.connections.assertDisconnectAllowed(
      actor,
      first.connectionRef,
      "local",
    );
    assert.deepEqual(allowed.sharedWith, [second.connectionRef]);
    const unlinked = await ports.connections.recordDisconnect(
      actor,
      first.connectionRef,
      1,
      {
        scope: "local",
        local: "applied",
        broker: "not-attempted",
        upstream: "not-attempted",
      },
    );
    assert.deepEqual(unlinked.record.disconnect?.sharedWith, [
      second.connectionRef,
    ]);
    const other = await ports.connections.get(actor, second.connectionRef);
    assert.equal(other?.record.lifecycle, "active");
    assert.equal(other?.record.generation, 0);

    // Revoking the shared grant upstream requires an explicit shared-impact action.
    await assert.rejects(
      ports.connections.assertDisconnectAllowed(
        actor,
        second.connectionRef,
        "upstream",
      ),
      (error: unknown) =>
        error instanceof ConnectorError &&
        error.code === "denied" &&
        error.detail === "disconnect.shared-impact",
    );
    const acknowledged = await ports.connections.assertDisconnectAllowed(
      actor,
      second.connectionRef,
      "upstream",
      { sharedImpactAcknowledged: true },
    );
    assert.deepEqual(acknowledged.sharedWith, [first.connectionRef]);

    // An unacknowledged external outcome that happened anyway is flagged.
    const flagged = await ports.connections.recordDisconnect(
      actor,
      second.connectionRef,
      1,
      {
        scope: "upstream",
        local: "applied",
        broker: "not-attempted",
        upstream: "applied",
      },
    );
    assert.ok(
      explainDisconnect(flagged.record)!.codes.includes(
        "disconnect.shared-impact-unacknowledged",
      ),
    );
    assert.equal(flagged.record.disconnect?.sharedImpactAcknowledged, false);
  } finally {
    await store.close();
  }
});

test("AC-STATE-03: a disconnect is revision-checked and owner-scoped", async () => {
  const { store, ports } = await setup();
  try {
    const actor = actorFor("tenant-a");
    const record = connectionRecord({ tenantId: "tenant-a" });
    await ports.connections.create(record);
    const input = {
      scope: "local" as const,
      local: "applied" as const,
      broker: "not-attempted" as const,
      upstream: "not-attempted" as const,
    };
    await assert.rejects(
      ports.connections.recordDisconnect(actor, record.connectionRef, 9, input),
      (error: unknown) =>
        error instanceof ConnectorError && error.code === "conflict",
    );
    await assert.rejects(
      ports.connections.recordDisconnect(
        actorFor("tenant-a", "subject-2"),
        record.connectionRef,
        1,
        input,
      ),
      (error: unknown) =>
        error instanceof ConnectorError && error.code === "not-found",
    );
    await assert.rejects(
      ports.connections.recordDisconnect(actor, record.connectionRef, 1, {
        ...input,
        upstream: "nonsense" as never,
      }),
      (error: unknown) =>
        error instanceof ConnectorError && error.detail === "disconnect.input",
    );
  } finally {
    await store.close();
  }
});
