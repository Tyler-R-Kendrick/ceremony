import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";
import { createHash, randomUUID } from "node:crypto";
import test from "node:test";
import { createConnectorPorts } from "../../../src/server/connectors/state/index.js";
import { effectKey } from "../../../src/server/connectors/state/keys.js";
import { ConnectorError } from "../../../src/server/connectors/errors.js";
import { SQLiteCeremonyStore } from "../../../src/server/persistence/index.js";
import {
  actorFor,
  claim,
  connectionRecord,
  stateKeyring,
} from "../fixtures/state/records.js";

/*
 * STATE-03: the lifecycle ports. Connections fence their generation, handoffs
 * are private, correlated and one-use, the effect journal persists intent
 * before any external call and reports an interrupted effect as
 * indeterminate, evidence carries invalidation reasons, and raw source bytes
 * are retained and deleted deliberately.
 */

const HANDOFF_SECRET = "pkce-verifier-8Hh2Qd41aZtRmXk";

const clockAt = (start: number) => {
  let value = start;
  return {
    now: () => value,
    advance: (ms: number) => {
      value += ms;
    },
  };
};

const withPorts = async (
  work: (
    ports: ReturnType<typeof createConnectorPorts>,
    store: SQLiteCeremonyStore,
    clock: ReturnType<typeof clockAt>,
  ) => Promise<void>,
  options: Parameters<typeof createConnectorPorts>[1] = {},
) => {
  const store = new SQLiteCeremonyStore(":memory:", stateKeyring());
  const clock = clockAt(1_700_000_000_000);
  try {
    await work(
      createConnectorPorts(store, { now: clock.now, ...options }),
      store,
      clock,
    );
  } finally {
    await store.close();
  }
};

const issueFor = async (
  ports: ReturnType<typeof createConnectorPorts>,
  actor = actorFor("tenant-a"),
  overrides: Record<string, unknown> = {},
) => {
  const record = connectionRecord({
    tenantId: actor.tenantId,
    ownerId: actor.subjectId,
  });
  await ports.connections.create(record);
  const issued = await ports.handoffs.issue({
    actor,
    connectionRef: record.connectionRef,
    bindingRef: record.bindingRef,
    generation: record.generation,
    kind: "provider-browser",
    presentation: "popup",
    expiresAt: ports.now() + 600_000,
    intent: "authorize.initial",
    correlationKey: `state-${randomUUID()}`,
    private: {
      url: "https://issuer.example/authorize?state=abc",
      verifier: HANDOFF_SECRET,
    },
    ...overrides,
  });
  return { record, issued };
};

test("STATE-03: a handoff is private to the initiating human in the same session", async () => {
  await withPorts(async (ports) => {
    const actor = actorFor("tenant-a");
    const { issued } = await issueFor(ports, actor);
    // The public summary carries no destination, verifier or correlation.
    const summary = JSON.stringify(issued.summary);
    assert.equal(summary.includes(HANDOFF_SECRET), false);
    assert.equal(summary.includes("issuer.example"), false);
    assert.deepEqual(Object.keys(issued.summary).sort(), [
      "expiresAt",
      "generation",
      "handoffRef",
      "kind",
      "presentation",
      "state",
    ]);

    const presented = await ports.handoffs.present(actor, issued.handoffRef);
    assert.equal(presented?.private.verifier, HANDOFF_SECRET);
    assert.equal(presented?.state, "issued");

    for (const other of [
      actorFor("tenant-a", "subject-2"),
      actorFor("tenant-b", "subject-1"),
      { ...actor, sessionId: "session-2" },
      { ...actor, actorKind: "agent" as const },
      { ...actor, actorKind: "system" as const },
    ])
      assert.equal(
        await ports.handoffs.present(other, issued.handoffRef),
        undefined,
      );
  });
});

test("STATE-03: completion is routed by correlation, one-use, and fenced by generation", async () => {
  await withPorts(async (ports) => {
    const actor = actorFor("tenant-a");
    const { record, issued } = await issueFor(ports, actor);
    const correlation = (await ports.handoffs.present(actor, issued.handoffRef))!
      .correlationKey!;

    const routed = await ports.handoffs.resolveCorrelation(
      "tenant-a",
      correlation,
    );
    assert.equal(routed?.handoffRef, issued.handoffRef);
    assert.equal(routed?.connectionRef, record.connectionRef);
    // Correlation is tenant-scoped: another tenant cannot route this callback.
    assert.equal(
      await ports.handoffs.resolveCorrelation("tenant-b", correlation),
      undefined,
    );
    assert.equal(
      await ports.handoffs.resolveCorrelation("tenant-a", "guessed-state"),
      undefined,
    );

    // A completion naming the wrong generation is refused.
    await assert.rejects(
      ports.handoffs.complete(issued.handoffRef, 7, "completed"),
      (error: unknown) =>
        error instanceof ConnectorError &&
        error.detail === "handoff.stale-generation",
    );
    const completed = await ports.handoffs.complete(
      issued.handoffRef,
      routed!.generation,
      "completed",
    );
    assert.equal(completed.state, "completed");

    // AC-AUTH-06: the same code delivered twice does not repeat the effect.
    await assert.rejects(
      ports.handoffs.complete(issued.handoffRef, routed!.generation, "completed"),
      (error: unknown) =>
        error instanceof ConnectorError &&
        error.detail === "handoff.already-completed",
    );
    // The correlation index is consumed with the handoff.
    assert.equal(
      await ports.handoffs.resolveCorrelation("tenant-a", correlation),
      undefined,
    );
  });
});

test("AC-AUTH-07: a delayed callback cannot complete across a generation change", async () => {
  await withPorts(async (ports) => {
    const actor = actorFor("tenant-a");
    const { record, issued } = await issueFor(ports, actor);
    const before = (await ports.handoffs.present(actor, issued.handoffRef))!;

    // Reconnect: the connection's generation moves while the provider tab is open.
    const current = await ports.connections.get(actor, record.connectionRef);
    const advanced = await ports.connections.advanceGeneration(
      actor,
      record.connectionRef,
      current!.revision,
    );
    assert.equal(advanced.generation, before.generation + 1);

    // The pending handoff was superseded in the same transaction.
    const after = await ports.handoffs.present(actor, issued.handoffRef);
    assert.equal(after?.state, "superseded");

    // The late callback can neither reactivate the old attempt nor overwrite
    // the newer connection.
    await assert.rejects(
      ports.handoffs.complete(issued.handoffRef, before.generation, "completed"),
      (error: unknown) =>
        error instanceof ConnectorError && error.code === "conflict",
    );
    await assert.rejects(
      ports.handoffs.complete(
        issued.handoffRef,
        advanced.generation,
        "completed",
      ),
      (error: unknown) =>
        error instanceof ConnectorError && error.code === "conflict",
    );
    assert.equal(
      (await ports.connections.get(actor, record.connectionRef))?.record
        .generation,
      advanced.generation,
    );
  });
});

test("STATE-03: handoffs expire, and unlink cancels every pending handoff of a connection", async () => {
  await withPorts(async (ports, _store, clock) => {
    const actor = actorFor("tenant-a");
    const { record, issued } = await issueFor(ports, actor);
    const second = await ports.handoffs.issue({
      actor,
      connectionRef: record.connectionRef,
      bindingRef: record.bindingRef,
      generation: record.generation,
      kind: "device-code",
      presentation: "second-device",
      expiresAt: ports.now() + 600_000,
      intent: "authorize.device",
      private: { userCode: "WXYZ-1234" },
    });
    assert.equal(
      await ports.handoffs.cancelAll(record.connectionRef, "unlink"),
      2,
    );
    assert.equal(
      (await ports.handoffs.present(actor, issued.handoffRef))?.state,
      "cancelled",
    );
    assert.equal(
      (await ports.handoffs.present(actor, second.handoffRef))?.state,
      "cancelled",
    );
    // Cancelling again finds nothing pending, and an unknown connection is a no-op.
    assert.equal(
      await ports.handoffs.cancelAll(record.connectionRef, "unlink"),
      0,
    );
    assert.equal(
      await ports.handoffs.cancelAll(`connection:${randomUUID()}`, "unlink"),
      0,
    );

    // A pending handoff past its expiry is expired the moment it is looked at.
    const third = await issueFor(ports, actorFor("tenant-a", "subject-9"));
    clock.advance(600_001);
    assert.equal(
      (
        await ports.handoffs.present(
          actorFor("tenant-a", "subject-9"),
          third.issued.handoffRef,
        )
      )?.state,
      "expired",
    );
    await assert.rejects(
      ports.handoffs.complete(third.issued.handoffRef, 0, "completed"),
      (error: unknown) =>
        error instanceof ConnectorError && error.code === "expired",
    );
  });
});

test("STATE-03: an unexpired correlation key cannot be taken over by a second handoff", async () => {
  await withPorts(async (ports) => {
    const actor = actorFor("tenant-a");
    const record = connectionRecord({ tenantId: "tenant-a" });
    await ports.connections.create(record);
    const issue = (correlationKey: string) =>
      ports.handoffs.issue({
        actor,
        connectionRef: record.connectionRef,
        bindingRef: record.bindingRef,
        generation: 0,
        kind: "connect-widget",
        presentation: "in-app",
        expiresAt: ports.now() + 60_000,
        intent: "authorize.initial",
        correlationKey,
        private: { token: "widget-token" },
      });
    await issue("state-shared");
    await assert.rejects(
      issue("state-shared"),
      (error: unknown) =>
        error instanceof ConnectorError &&
        error.detail === "handoff.correlation-in-use",
    );
  });
});

test("AC-STATE-02: intent is persisted before the effect and a repeated digest never calls twice", async () => {
  await withPorts(async (ports) => {
    const actor = actorFor("tenant-a");
    const intent = {
      actor,
      operation: "vercel.token.acquire",
      digest: createHash("sha256").update("request-1").digest("hex"),
      commandId: "command-1",
    };
    let calls = 0;
    const first = await ports.effects.execute(intent, async (effectRef) => {
      calls++;
      assert.match(effectRef, /^effect:/);
      // The intent is durable before the provider is contacted.
      const unresolved = await ports.effects.listUnresolved(actor);
      assert.equal(unresolved.length, 1);
      assert.equal(unresolved[0]!.status, "begun");
      assert.equal(unresolved[0]!.operation, "vercel.token.acquire");
      return {
        outcome: { status: "applied" as const, at: ports.now() },
        value: 42,
      };
    });
    assert.equal(first.value, 42);
    assert.equal(calls, 1);
    assert.deepEqual(await ports.effects.get(actor, first.effectRef), {
      status: "applied",
      at: ports.now(),
    });
    assert.deepEqual(await ports.effects.listUnresolved(actor), []);

    // The same request again returns the earlier outcome instead of a new effect.
    const repeat = await ports.effects.execute(intent, async () => {
      calls++;
      return {
        outcome: { status: "applied" as const, at: ports.now() },
        value: 0,
      };
    });
    assert.equal(calls, 1);
    assert.equal(repeat.effectRef, first.effectRef);
    assert.deepEqual(repeat.prior, { status: "applied", at: ports.now() });

    // A different digest is a different effect.
    const other = await ports.effects.begin({ ...intent, digest: "different" });
    assert.notEqual(other.effectRef, first.effectRef);
    assert.equal(other.prior, undefined);

    // Outcomes are tenant scoped.
    assert.equal(
      await ports.effects.get(actorFor("tenant-b"), first.effectRef),
      undefined,
    );
  });
});

test("AC-STATE-02: an effect interrupted by a dead worker is reported indeterminate", async () => {
  await withPorts(
    async (ports, store) => {
      const actor = actorFor("tenant-a");
      const intent = {
        actor,
        operation: "pipedream.action.run",
        digest: "digest-orphan",
      };
      const begun = await ports.effects.begin(intent);
      assert.equal(begun.prior, undefined);

      // While the worker holds its lease, a second caller must not repeat the call.
      const inFlight = await ports.effects.begin(intent);
      assert.equal(inFlight.effectRef, begun.effectRef);
      assert.equal(inFlight.prior?.status, "indeterminate");
      assert.equal(inFlight.prior?.code, "effect.in-flight");

      // The worker dies: its lease lapses (the store's own cancellation, as a
      // lease expiry does) and the effect becomes an orphan.
      await store.transaction((tx) =>
        tx.cancel(effectKey(actor.tenantId, begun.effectRef)),
      );
      const orphaned = await ports.effects.begin(intent);
      assert.equal(orphaned.effectRef, begun.effectRef);
      assert.equal(orphaned.prior?.status, "indeterminate");
      assert.equal(orphaned.prior?.code, "effect.orphaned");
      const unresolved = await ports.effects.listUnresolved(actor);
      assert.equal(unresolved.length, 1);
      assert.equal(unresolved[0]!.status, "orphaned");

      // Reconciliation — not a blind retry — records what actually happened.
      const reconciled = await ports.effects.reconcile(actor, begun.effectRef, {
        status: "reconciled",
        code: "provider.no-such-run",
        at: ports.now(),
      });
      assert.equal(reconciled.status, "reconciled");
      assert.deepEqual(await ports.effects.listUnresolved(actor), []);
      assert.equal((await ports.effects.begin(intent)).prior?.status, "reconciled");
    },
  );
});

test("STATE-03: a worker that lost its lease cannot record an outcome", async () => {
  await withPorts(
    async (ports, store) => {
      const actor = actorFor("tenant-a");
      const begun = await ports.effects.begin({
        actor,
        operation: "nango.proxy.post",
        digest: "digest-fence",
      });
      // Another worker takes over after the lease lapses.
      await delay(20);
      const takeover = await ports.effects.begin({
        actor,
        operation: "nango.proxy.post",
        digest: "digest-fence",
      });
      assert.equal(takeover.prior?.code, "effect.orphaned");
      await assert.rejects(
        ports.effects.complete(begun.effectRef, {
          status: "applied",
          at: ports.now(),
        }),
        (error: unknown) =>
          error instanceof ConnectorError &&
          error.code === "conflict" &&
          error.detail === "effect.lease-lost",
      );
      assert.equal(
        (await ports.effects.get(actor, begun.effectRef))?.status,
        "indeterminate",
      );
      // A caller that never began the effect cannot complete it either.
      const other = createConnectorPorts(store, { leaseMs: 1 });
      await assert.rejects(
        other.effects.complete(begun.effectRef, {
          status: "applied",
          at: Date.now(),
        }),
        ConnectorError,
      );
    },
    { leaseMs: 1 },
  );
});

test("STATE-03: a throwing provider call leaves the effect indeterminate, never applied", async () => {
  await withPorts(async (ports) => {
    const actor = actorFor("tenant-a");
    const intent = {
      actor,
      operation: "merge.passthrough",
      digest: "digest-throw",
    };
    await assert.rejects(
      ports.effects.execute(intent, async () => {
        throw new Error("socket hang up");
      }),
      /socket hang up/,
    );
    const replay = await ports.effects.begin(intent);
    assert.equal(replay.prior?.status, "indeterminate");
    assert.equal(
      (await ports.effects.get(actor, replay.effectRef))?.status,
      "indeterminate",
    );
  });
});

test("STATE-03: evidence is invalidated with a reason and stops being listed", async () => {
  await withPorts(async (ports, _store, clock) => {
    const actor = actorFor("tenant-a");
    const record = connectionRecord({ tenantId: "tenant-a" });
    await ports.connections.create(record);
    await ports.evidence.append(
      actor,
      record.connectionRef,
      claim({ evidenceRef: "evidence:a" }),
    );
    await ports.evidence.append(
      actor,
      record.connectionRef,
      claim({
        evidenceRef: "evidence:b",
        kind: "resource-access",
        observedAt: new Date(clock.now()).toISOString(),
        validUntil: new Date(clock.now() + 60_000).toISOString(),
      }),
    );
    assert.equal(
      (await ports.evidence.list(actor, record.connectionRef)).length,
      2,
    );

    // Only the claim whose validity ended is invalidated by expiry.
    clock.advance(60_001);
    assert.equal(
      await ports.evidence.invalidateExpired(actor, record.connectionRef),
      1,
    );
    assert.deepEqual(
      (await ports.evidence.list(actor, record.connectionRef)).map(
        (item) => item.evidenceRef,
      ),
      ["evidence:a"],
    );
    const all = await ports.evidence.listAll(actor, record.connectionRef);
    assert.equal(
      all.find((entry) => entry.claim.evidenceRef === "evidence:b")?.stale
        ?.reason,
      "verification.expired",
    );

    assert.equal(
      await ports.evidence.invalidate(
        actor,
        record.connectionRef,
        "policy.changed",
      ),
      1,
    );
    assert.deepEqual(await ports.evidence.list(actor, record.connectionRef), []);
    // A reason must be a sanitized code, never provider prose with control characters.
    await assert.rejects(
      ports.evidence.invalidate(
        actor,
        record.connectionRef,
        `bad${String.fromCharCode(0)}reason`,
      ),
      (error: unknown) =>
        error instanceof ConnectorError && error.detail === "evidence.reason",
    );
  });
});

test("STATE-03: raw source artifacts are digest-addressed, retained and deletable", async () => {
  await withPorts(async (ports, _store, clock) => {
    const bytes = new TextEncoder().encode('{"openapi":"3.1.0"}');
    const digest = createHash("sha256").update(bytes).digest("hex");
    const ref = await ports.artifacts.put("tenant-a", bytes, {
      mediaType: "application/json",
      digest,
      retainUntil: clock.now() + 60_000,
    });
    assert.equal(ref, `artifact:${digest}`);
    const read = await ports.artifacts.get("tenant-a", ref);
    assert.equal(new TextDecoder().decode(read!.bytes), '{"openapi":"3.1.0"}');
    assert.equal(read!.mediaType, "application/json");
    assert.deepEqual(await ports.artifacts.describe("tenant-a", ref), {
      digest,
      mediaType: "application/json",
      byteLength: bytes.byteLength,
      retainUntil: clock.now() + 60_000,
    });
    // Another tenant's artifact store is a different store.
    assert.equal(await ports.artifacts.get("tenant-b", ref), undefined);
    // A claimed digest that does not match the bytes is refused.
    await assert.rejects(
      ports.artifacts.put("tenant-a", bytes, {
        mediaType: "application/json",
        digest: "f".repeat(64),
      }),
      (error: unknown) =>
        error instanceof ConnectorError &&
        error.detail === "artifact.digest-mismatch",
    );

    // Past its retention it is no longer served, and the purge removes it.
    clock.advance(60_001);
    assert.equal(await ports.artifacts.get("tenant-a", ref), undefined);
    assert.equal((await ports.artifacts.purgeExpired("tenant-a")).deleted, 1);
    assert.equal(await ports.artifacts.describe("tenant-a", ref), undefined);

    // Explicit deletion works for a retained artifact too.
    const keep = await ports.artifacts.put("tenant-a", bytes, {
      mediaType: "application/json",
      digest,
    });
    assert.ok(await ports.artifacts.get("tenant-a", keep));
    await ports.artifacts.delete("tenant-a", keep);
    assert.equal(await ports.artifacts.get("tenant-a", keep), undefined);
  });
});
