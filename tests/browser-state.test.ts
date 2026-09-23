import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import {
  BrowserStateUnavailable,
  createBrowserStateStore,
  storageStateSchema,
} from "../src/server/browser-state.js";
import { SQLiteCeremonyStore } from "../src/server/persistence/index.js";
import type { ActorContext } from "../src/core/operation-contracts.js";

/**
 * The saved-state store, tested as what it is: a credential store.
 *
 * Every case here is about who can get the value back and when, because the
 * value is a live session. The round trip through a real browser is
 * LIFE-STATE's job in the conformance suite; this is the half that can be
 * asked without one.
 */

const actor: ActorContext = {
  tenantId: "state-tenant",
  subjectId: "state-subject",
  sessionId: "state-session",
  actorKind: "human",
  capabilities: ["executor"],
};

/** A cookie shaped like the ones a provider sets, so nothing is degenerate. */
const sample = storageStateSchema.parse({
  cookies: [
    {
      name: "fixture_session",
      value: "a-live-session-value",
      domain: "127.0.0.1",
      path: "/",
    },
  ],
  origins: [
    {
      origin: "http://127.0.0.1:4000",
      localStorage: [{ name: "seen", value: "1" }],
    },
  ],
});

let store: SQLiteCeremonyStore;

before(() => {
  store = new SQLiteCeremonyStore(":memory:", {
    current: "state",
    keys: { state: new Uint8Array(32) },
  });
});
after(async () => {
  await store.close();
});

const saved = {
  browserGeneration: "bgen_x",
  effectivePlanDigest: "d".repeat(64),
};

describe("saved browser state", () => {
  test("a reference round-trips to the state that was saved", async () => {
    const states = createBrowserStateStore({ store });
    const stateRef = await states.save(actor, saved, sample);
    assert.match(stateRef, /^bstt_[0-9a-f]{32}$/);
    assert.deepEqual(await states.restore(actor, stateRef)(), sample);
  });

  test("what a reader is told never includes the state", async () => {
    // The summary exists so a session can be described - when it was saved,
    // which plan produced it, how many origins it covers - without anybody
    // having to handle the cookies to find out.
    const states = createBrowserStateStore({ store });
    const stateRef = await states.save(actor, saved, sample);
    const summary = await states.describe(actor, stateRef);
    assert.equal(summary.origins, 1);
    assert.equal(summary.browserGeneration, "bgen_x");
    assert.equal("state" in summary, false, "a summary must omit the state");
    // And the whole thing, serialized, carries no part of the cookie. This is
    // the assertion that would catch a field being added back later.
    assert.equal(
      JSON.stringify(summary).includes("a-live-session-value"),
      false,
    );
  });

  test("another subject is refused, holding the reference or not", async () => {
    // Tenancy alone is not enough. Colleagues share a tenant, and a reference
    // that leaked between them must not be a session that transferred.
    const states = createBrowserStateStore({ store });
    const stateRef = await states.save(actor, saved, sample);
    const intruder = { ...actor, subjectId: "another-person" };
    await assert.rejects(
      () => states.restore(intruder, stateRef)(),
      (error: unknown) =>
        error instanceof BrowserStateUnavailable &&
        error.reason === "not-authorized",
    );
    await assert.rejects(() => states.describe(intruder, stateRef));
    await assert.rejects(() => states.forget(intruder, stateRef));
    // Refusing them left it intact for the person it belongs to.
    assert.deepEqual(await states.restore(actor, stateRef)(), sample);
  });

  test("an unknown reference is refused rather than guessed at", async () => {
    const states = createBrowserStateStore({ store });
    await assert.rejects(
      () => states.restore(actor, `bstt_${"0".repeat(32)}`)(),
      (error: unknown) =>
        error instanceof BrowserStateUnavailable && error.reason === "unknown",
    );
  });

  test("an expired state is refused and dropped, not merely refused", async () => {
    // A cookie jar nobody can revoke is the problem. Refusing to restore it
    // while keeping it is only half an answer: the record is deleted, so a
    // later clock change or a code path that forgot to check cannot resurrect
    // somebody's session.
    let clock = 1_000_000;
    const states = createBrowserStateStore({
      store,
      now: () => clock,
      ttlMs: 60_000,
    });
    const stateRef = await states.save(actor, saved, sample);
    clock += 60_001;
    await assert.rejects(
      () => states.restore(actor, stateRef)(),
      (error: unknown) =>
        error instanceof BrowserStateUnavailable && error.reason === "expired",
    );
    // Gone, not merely denied: the second attempt cannot even find it.
    await assert.rejects(
      () => states.restore(actor, stateRef)(),
      (error: unknown) =>
        error instanceof BrowserStateUnavailable && error.reason === "unknown",
    );
  });

  test("forgetting a state ends it, and forgetting twice is not an error", async () => {
    const states = createBrowserStateStore({ store });
    const stateRef = await states.save(actor, saved, sample);
    await states.forget(actor, stateRef);
    await assert.rejects(
      () => states.restore(actor, stateRef)(),
      (error: unknown) =>
        error instanceof BrowserStateUnavailable && error.reason === "unknown",
    );
    // Idempotent, because a caller cleaning up should not have to know
    // whether somebody else already did.
    await states.forget(actor, stateRef);
  });

  test("a state that is not one is refused at the boundary", async () => {
    // The backend hands this over structurally, so a Playwright change or a
    // stubbed context returning something else should fail here rather than
    // write a record nothing can read back.
    const states = createBrowserStateStore({ store });
    await assert.rejects(() =>
      states.save(actor, saved, { cookies: "not-an-array" } as never),
    );
  });
});

describe("the state kept for a login slot", () => {
  test("a slot recalls the latest state and forgets the one it replaced", async () => {
    const states = createBrowserStateStore({ store });
    const first = await states.remember(actor, "slot-a", saved, sample);
    const newer = storageStateSchema.parse({ ...sample, origins: [] });
    const second = await states.remember(actor, "slot-a", saved, newer);
    assert.notEqual(first, second);
    assert.deepEqual(await (await states.recall(actor, "slot-a"))!(), newer);
    // Two live cookie jars for one login is one too many.
    await assert.rejects(
      states.describe(actor, first),
      (error: unknown) =>
        error instanceof BrowserStateUnavailable && error.reason === "unknown",
    );
    assert.equal(await states.recall(actor, "slot-b"), undefined);
  });

  test("another subject in the same tenant finds nothing in the same slot", async () => {
    const states = createBrowserStateStore({ store });
    await states.remember(actor, "shared-slot", saved, sample);
    const colleague: ActorContext = { ...actor, subjectId: "state-colleague" };
    assert.equal(await states.recall(colleague, "shared-slot"), undefined);
  });

  test("an expired state is an absent one, not a failure at restore time", async () => {
    let now = 1_000_000;
    const states = createBrowserStateStore({
      store,
      now: () => now,
      ttlMs: 60_000,
    });
    await states.remember(actor, "expiring-slot", saved, sample);
    now += 61_000;
    assert.equal(await states.recall(actor, "expiring-slot"), undefined);
  });
});
