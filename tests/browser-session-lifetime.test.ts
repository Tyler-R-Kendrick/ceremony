import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import {
  evidenceIsFresh,
  projectSessionStatus,
  type BrowserSessionRecord,
  type LoginEvidence,
} from "../src/core/browser-session-contracts.js";
import {
  createBrowserSessionRegistry,
  LeaseConflict,
  SessionLost,
} from "../src/server/browser-sessions.js";
import { SQLiteCeremonyStore } from "../src/server/persistence/index.js";
import type { ActorContext } from "../src/core/operation-contracts.js";

/**
 * Retention, leases and release, without a browser.
 *
 * These are the rules that decide whether a caller may still drive a session,
 * whether a restarted worker may adopt one, and what a release actually did.
 * They are worth testing apart from a real browser because the interesting
 * cases — a superseded lease, a replaced executor, an expired record — are
 * exactly the ones a live browser makes hard to stage on purpose.
 */

const actor: ActorContext = {
  tenantId: "tenant-a",
  subjectId: "subject-a",
  sessionId: "client-a",
  actorKind: "human",
  capabilities: ["executor"],
};
const otherTenant: ActorContext = { ...actor, tenantId: "tenant-b" };
const otherSubject: ActorContext = { ...actor, subjectId: "subject-b" };

let store: SQLiteCeremonyStore;

before(() => {
  store = new SQLiteCeremonyStore(":memory:", {
    current: "lifetime",
    keys: { lifetime: new Uint8Array(32) },
  });
});
after(async () => store.close());

/** A retained session whose "browser" is a stub that records disposal. */
function retainable(registry: ReturnType<typeof createBrowserSessionRegistry>) {
  const disposed = { browser: 0, context: 0 };
  const browser = {
    descriptor: {
      backendId: "managed-chromium",
      engine: "chromium" as const,
      ownership: "managed" as const,
      engineVersion: "test",
      capabilities: {
        retainedSession: true,
        backendHeldElements: true,
        documentBinding: true,
        popupBinding: true,
        frameBinding: true,
        strongEgressContainment: false,
        authenticatorHandoff: true,
        statePersistence: true,
        debugExposure: false,
      },
    },
    browserGeneration: "bgen_one",
    openContext: async () => {
      throw new Error("unused");
    },
    alive: () => true,
    dispose: async () => {
      disposed.browser++;
    },
  };
  const context = {
    contextRef: "bctx_00000000000000000000000000000001",
    request: {
      get: async () => ({ status: () => 200, text: async () => "{}" }),
    },
    openPage: async () => {
      throw new Error("unused");
    },
    alive: async () => true,
    close: async () => {
      disposed.context++;
    },
  };
  const retain = (
    overrides: Partial<Parameters<typeof registry.retain>[1]> = {},
  ) =>
    registry.retain(actor, {
      ownership: "managed",
      engine: "chromium",
      backendId: "managed-chromium",
      executorRef: registry.executorRef,
      browserGeneration: "bgen_one",
      contextRef: context.contextRef,
      trustMode: "constrained-auth",
      scope: ["observe"],
      effectivePlanDigest: "a".repeat(64),
      ttlMs: 600_000,
      browser: browser as never,
      context: context as never,
      ...overrides,
    });
  return { retain, disposed };
}

describe("session ownership", () => {
  test("a reference is not a permission: another tenant or subject is denied", async () => {
    const registry = createBrowserSessionRegistry({ store });
    const { retain } = retainable(registry);
    const record = await retain();
    await assert.rejects(() =>
      registry.resolve(otherTenant, record.sessionRef),
    );
    await assert.rejects(() =>
      registry.resolve(otherSubject, record.sessionRef),
    );
    await assert.doesNotReject(() =>
      registry.resolve(actor, record.sessionRef),
    );
    await registry.disposeAll();
  });

  test("LIFE-RESTART: a replaced executor reports the session lost, not adopted", async () => {
    const first = createBrowserSessionRegistry({ store });
    const { retain } = retainable(first);
    const record = await retain();

    // A new worker inherits the database rows but not the browser. Adopting
    // the session because the row exists would be adopting someone else's
    // process — or nothing at all.
    const second = createBrowserSessionRegistry({ store });
    await assert.rejects(
      () => second.resolve(actor, record.sessionRef),
      SessionLost,
    );
    await first.disposeAll();
  });

  test("a browser generation that no longer matches is a lost session", async () => {
    const registry = createBrowserSessionRegistry({ store });
    const { retain } = retainable(registry);
    const record = await retain();

    // Stage the disagreement the way it really happens: the durable record
    // outlives the browser it describes and a different one now holds the
    // slot. A row is not a process, so the row losing the argument is the
    // whole point of recording a generation at all.
    await store.transaction(async (tx) => {
      const key = {
        tenant: actor.tenantId,
        kind: "session" as const,
        id: `browser:${record.sessionRef}`,
      };
      const stored = await tx.get<BrowserSessionRecord>(key);
      await tx.put(
        key,
        { ...stored!.value, browserGeneration: "bgen_replaced" },
        stored!.revision,
      );
    });

    await assert.rejects(
      () => registry.resolve(actor, record.sessionRef),
      SessionLost,
    );
    await registry.disposeAll();
  });

  test("an expired record is lost even while the browser is still running", async () => {
    let clock = 1_000_000;
    const registry = createBrowserSessionRegistry({
      store,
      now: () => clock,
    });
    const { retain, disposed } = retainable(registry);
    const record = await retain({ ttlMs: 60_000 });
    clock += 120_000;
    await assert.rejects(
      () => registry.resolve(actor, record.sessionRef),
      SessionLost,
    );
    // Expiry must actually reclaim the process: a caller who never comes back
    // cannot leave a browser running and a grant alive indefinitely.
    assert.equal(await registry.expire(actor), 1);
    assert.equal(disposed.browser, 1);
    assert.equal(disposed.context, 1);
  });
});

describe("leases", () => {
  test("LIFE-TRANSFER: an old controller is fenced out after a transfer", async () => {
    const registry = createBrowserSessionRegistry({ store });
    const { retain } = retainable(registry);
    const record = await retain({ controllerRef: "client-one" });
    await assert.doesNotReject(() =>
      registry.resolve(actor, record.sessionRef, {
        controllerRef: "client-one",
      }),
    );

    await registry.transfer(actor, record.sessionRef, {
      controllerRef: "client-two",
      scope: ["observe"],
    });
    // Work the previous controller queued before the transfer is refused when
    // it arrives, rather than allowed through because it was once authorized.
    await assert.rejects(
      () =>
        registry.resolve(actor, record.sessionRef, {
          controllerRef: "client-one",
        }),
      LeaseConflict,
    );
    await assert.doesNotReject(() =>
      registry.resolve(actor, record.sessionRef, {
        controllerRef: "client-two",
      }),
    );
    await registry.disposeAll();
  });

  test("CLIENT-OWNER: the same person on another client cannot drive by default", async () => {
    const registry = createBrowserSessionRegistry({ store });
    const { retain } = retainable(registry);
    const record = await retain({ controllerRef: "client-one" });
    await assert.rejects(
      () =>
        registry.resolve(actor, record.sessionRef, {
          controllerRef: "some-other-client",
        }),
      LeaseConflict,
    );
    await registry.disposeAll();
  });
});

describe("release", () => {
  test("LIFE-ATTACHED: releasing an attached browser revokes automation only", async () => {
    const registry = createBrowserSessionRegistry({ store });
    const { retain, disposed } = retainable(registry);
    const record = await retain({ ownership: "attached-user" });

    const released = await registry.release(
      actor,
      record.sessionRef,
      "release-control",
    );
    assert.deepEqual(released, {
      kind: "release-control",
      automationRevoked: true,
      managedResourcesDisposed: false,
      userBrowserPreserved: true,
      upstreamLogout: false,
    });
    // The person's browser, tabs and cookies are untouched: nothing of theirs
    // was ever Ceremony's to close.
    assert.equal(disposed.browser, 0);
    assert.equal(disposed.context, 0);
    // Automation really is revoked: no later operation resolves.
    await assert.rejects(() => registry.resolve(actor, record.sessionRef));
  });

  test("disposing an attached browser is refused outright", async () => {
    const registry = createBrowserSessionRegistry({ store });
    const { retain, disposed } = retainable(registry);
    const record = await retain({ ownership: "attached-user" });
    await assert.rejects(() =>
      registry.release(actor, record.sessionRef, "dispose-managed"),
    );
    assert.equal(disposed.browser, 0);
    await registry.disposeAll();
  });

  test("EFFECT-CANCEL: cancelling a run disposes nothing and claims nothing", async () => {
    const registry = createBrowserSessionRegistry({ store });
    const { retain, disposed } = retainable(registry);
    const record = await retain();
    const released = await registry.release(
      actor,
      record.sessionRef,
      "cancel-run",
    );
    // Cancellation stops future dispatch. It cannot retract a request already
    // on the wire, so it destroys nothing and revokes nothing.
    assert.equal(released.managedResourcesDisposed, false);
    assert.equal(released.automationRevoked, false);
    assert.equal(released.upstreamLogout, false);
    assert.equal(disposed.browser, 0);
    await assert.doesNotReject(() =>
      registry.resolve(actor, record.sessionRef),
    );
    await registry.disposeAll();
  });

  test("no release path ever claims an upstream logout", async () => {
    const registry = createBrowserSessionRegistry({ store });
    const { retain } = retainable(registry);
    for (const kind of ["cancel-run", "release-control"] as const) {
      const record = await retain();
      const released = await registry.release(actor, record.sessionRef, kind);
      assert.equal(released.upstreamLogout, false);
      assert.equal(released.userBrowserPreserved, true);
    }
    await registry.disposeAll();
  });
});

describe("status projection", () => {
  const record: BrowserSessionRecord = {
    sessionRef: "bsess_00000000000000000000000000000001",
    ownership: "managed",
    engine: "chromium",
    backendId: "managed-chromium",
    executorRef: "bexec_00000000000000000000000000000001",
    browserGeneration: "bgen_one",
    contextRef: "bctx_00000000000000000000000000000001",
    tenant: "tenant-a",
    subject: "subject-a",
    controllerRef: "client-one",
    leaseGeneration: 0,
    trustMode: "constrained-auth",
    scope: ["observe"],
    effectivePlanDigest: "a".repeat(64),
    expiresAt: new Date(2_000_000_000_000).toISOString(),
  };
  const evidence: LoginEvidence = {
    kind: "fixture-verified",
    verifierRef: "fixture:https://provider.example",
    verifierVersion: "1.0.0",
    browserSessionRef: record.sessionRef,
    browserGeneration: "bgen_one",
    accountRef: "ada",
    verifiedAt: new Date(1_000_000_000_000).toISOString(),
    expiresAt: new Date(1_000_000_600_000).toISOString(),
    effectivePlanDigest: "a".repeat(64),
  };
  const now = new Date(1_000_000_060_000);

  test("verified is recomputed, never read from a stored flag", () => {
    const status = projectSessionStatus(record, {
      now,
      evidence,
      callerRef: "client-one",
      planDigest: "a".repeat(64),
    });
    assert.equal(status.verified, true);
    assert.equal(status.controllable, true);
  });

  test("POLICY-REVISE: evidence does not survive a changed plan", () => {
    assert.equal(
      evidenceIsFresh(evidence, now, {
        planDigest: "b".repeat(64),
        browserGeneration: "bgen_one",
      }),
      false,
    );
    const status = projectSessionStatus(record, {
      now,
      evidence,
      planDigest: "b".repeat(64),
    });
    assert.equal(status.verified, false);
  });

  test("evidence does not survive a replaced browser", () => {
    assert.equal(
      evidenceIsFresh(evidence, now, {
        planDigest: "a".repeat(64),
        browserGeneration: "bgen_two",
      }),
      false,
    );
  });

  test("VER-FRESH: expired evidence stops reporting verified", () => {
    const status = projectSessionStatus(record, {
      now: new Date(1_000_001_000_000),
      evidence,
      planDigest: "a".repeat(64),
    });
    assert.equal(status.verified, false);
  });

  test("a person's word is recorded but never counts as verification", () => {
    const status = projectSessionStatus(record, {
      now,
      evidence: { ...evidence, kind: "human-attested" },
      planDigest: "a".repeat(64),
    });
    assert.equal(status.verified, false);
  });

  test("the projection carries no executor, context, tenant or subject", () => {
    const status = projectSessionStatus(record, {
      now,
      evidence,
      planDigest: "a".repeat(64),
    });
    const keys = Object.keys(status);
    for (const leaked of [
      "executorRef",
      "contextRef",
      "tenant",
      "subject",
      "backendId",
      "effectivePlanDigest",
      "controllerRef",
    ])
      assert.ok(!keys.includes(leaked), `${leaked} must not be projected`);
  });
});
