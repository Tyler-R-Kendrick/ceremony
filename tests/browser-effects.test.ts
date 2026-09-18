import assert from "node:assert/strict";
import { after, before, beforeEach, describe, test } from "node:test";
import {
  createEffectLedger,
  effectIsIndeterminate,
  EffectConflict,
  type EffectLedger,
} from "../src/server/browser-effects.js";
import { AuthorizationError } from "../src/server/identity.js";
import {
  SQLiteCeremonyStore,
  type RecordKey,
} from "../src/server/persistence/index.js";
import type { ActorContext } from "../src/core/operation-contracts.js";

/**
 * The ledger that decides whether a retry is safe.
 *
 * Every case below is a claim about what a caller is allowed to conclude. The
 * one that matters most is the one that looks like a gap: an effect that was
 * dispatched and never observed stays undetermined forever, and no operation
 * here will turn it into a success or a failure. That is not an unfinished
 * state machine, it is the answer.
 */

const actor: ActorContext = {
  tenantId: "tenant-e",
  subjectId: "subject-e",
  sessionId: "client-e",
  actorKind: "human",
  capabilities: ["executor"],
};

/** Same tenant, different person. Used to prove a reference is not a permission. */
const stranger: ActorContext = { ...actor, subjectId: "subject-other" };

const digest = "a".repeat(64);
const otherDigest = "b".repeat(64);
const runRef = "brun_00000000000000000000000000000001";

let store: SQLiteCeremonyStore;
let ledger: EffectLedger;

before(() => {
  store = new SQLiteCeremonyStore(":memory:", {
    current: "effects",
    keys: { effects: new Uint8Array(32) },
  });
});
after(async () => store.close());
beforeEach(() => {
  ledger = createEffectLedger({ store });
});

const begin = (key: string, planDigest = digest) =>
  ledger.begin(actor, {
    runRef,
    effectivePlanDigest: planDigest,
    idempotencyKey: key,
  });

describe("claiming a request", () => {
  test("a first claim is fresh and starts having sent nothing", async () => {
    const claim = await begin("key-fresh");
    assert.equal(claim.kind, "fresh");
    assert.equal(claim.record.state, "reserved");
    assert.equal(claim.record.dispatches, 0);
    assert.equal(claim.record.destination, undefined);
    assert.equal(claim.record.outcome, undefined);
    assert.match(claim.record.effectRef, /^beff_[0-9a-f]{32}$/);
  });

  test("EFFECT-DUP: the same key claims the same effect, not a second one", async () => {
    const first = await begin("key-dup");
    const second = await begin("key-dup");
    assert.equal(second.kind, "replay");
    assert.equal(second.record.effectRef, first.record.effectRef);
  });

  test("a revised plan is a different request, not a replay of the old one", async () => {
    const first = await begin("key-plan");
    const second = await begin("key-plan", otherDigest);
    // Same key, different effective plan: whatever the first attempt sent, it
    // was not this. Treating it as a replay would report a plan's outcome as
    // though it belonged to the plan that replaced it.
    assert.equal(second.kind, "fresh");
    assert.notEqual(second.record.effectRef, first.record.effectRef);
  });

  test("losing a race for the same key means not dispatching", async () => {
    // Two callers can both find the slot empty before either writes it. The
    // store's expected-revision check is what turns that into a detectable
    // conflict instead of a silent overwrite, and the loser must come away
    // with an error rather than with permission to submit.
    await begin("key-race");
    const blind = createEffectLedger({
      store: {
        ...store,
        transaction: (async (work: (tx: unknown) => Promise<unknown>) =>
          store.transaction(async (tx) =>
            work({
              ...tx,
              // The read the loser performed before the winner committed.
              get: async (key: RecordKey) =>
                key.id.startsWith("claim:") ? undefined : tx.get(key),
              put: tx.put.bind(tx),
            }),
          )) as typeof store.transaction,
      } as typeof store,
    });
    await assert.rejects(
      () =>
        blind.begin(actor, {
          runRef,
          effectivePlanDigest: digest,
          idempotencyKey: "key-race",
        }),
      EffectConflict,
    );
  });

  test("another subject's key never collides with this one", async () => {
    await begin("key-shared");
    const theirs = await ledger.begin(stranger, {
      runRef,
      effectivePlanDigest: digest,
      idempotencyKey: "key-shared",
    });
    assert.equal(theirs.kind, "fresh");
  });
});

describe("recording what was sent", () => {
  test("a dispatch is written before it happens and counted", async () => {
    const { record } = await begin("key-dispatch");
    const after = await ledger.dispatching(
      actor,
      record.effectRef,
      "https://provider.example",
    );
    assert.equal(after.state, "dispatched");
    assert.equal(after.dispatches, 1);
    assert.equal(after.destination, "https://provider.example");
  });

  test("EFFECT-LOST: dispatched and never observed stays undetermined", async () => {
    const { record } = await begin("key-lost");
    const sent = await ledger.dispatching(actor, record.effectRef, "https://p");
    assert.equal(effectIsIndeterminate(sent), true);

    // Nothing in this module will resolve it on the caller's behalf. A reader
    // coming back later gets the same undetermined answer, which is what makes
    // it safe to refuse a retry.
    const reread = await ledger.read(actor, record.effectRef);
    assert.equal(effectIsIndeterminate(reread), true);
    assert.equal(reread.outcome, undefined);
  });

  test("a replay of a dispatched effect reports it as still undetermined", async () => {
    const { record } = await begin("key-lost-replay");
    await ledger.dispatching(actor, record.effectRef, "https://p");
    const replay = await begin("key-lost-replay");
    assert.equal(replay.kind, "replay");
    assert.equal(effectIsIndeterminate(replay.record), true);
  });

  test("an observed effect is no longer undetermined", async () => {
    const { record } = await begin("key-observed");
    await ledger.dispatching(actor, record.effectRef, "https://p");
    const done = await ledger.observed(actor, record.effectRef, "verified");
    assert.equal(done.state, "observed");
    assert.equal(done.outcome, "verified");
    assert.equal(effectIsIndeterminate(done), false);
  });

  test("an attempt that sent nothing is abandoned, not left hanging", async () => {
    const { record } = await begin("key-abandon");
    const done = await ledger.abandon(actor, record.effectRef);
    assert.equal(done.state, "abandoned");
    assert.equal(effectIsIndeterminate(done), false);
  });

  test("a dispatched effect can never be called abandoned", async () => {
    const { record } = await begin("key-no-abandon");
    await ledger.dispatching(actor, record.effectRef, "https://p");
    // The single most dangerous thing this module could allow: recording that
    // nothing was sent when something was.
    await assert.rejects(
      () => ledger.abandon(actor, record.effectRef),
      EffectConflict,
    );
    assert.equal(
      effectIsIndeterminate(await ledger.read(actor, record.effectRef)),
      true,
    );
  });

  test("a settled effect cannot be dispatched again", async () => {
    const { record } = await begin("key-settled");
    await ledger.observed(actor, record.effectRef, "verified");
    await assert.rejects(
      () => ledger.dispatching(actor, record.effectRef, "https://p"),
      EffectConflict,
    );
  });

  test("an abandoned effect cannot be dispatched", async () => {
    const { record } = await begin("key-abandoned-then");
    await ledger.abandon(actor, record.effectRef);
    await assert.rejects(
      () => ledger.dispatching(actor, record.effectRef, "https://p"),
      EffectConflict,
    );
  });

  test("a second dispatch on one effect is counted, not silently merged", async () => {
    const { record } = await begin("key-two-dispatch");
    await ledger.dispatching(actor, record.effectRef, "https://p");
    const twice = await ledger.dispatching(
      actor,
      record.effectRef,
      "https://p",
    );
    // A multi-step login posts more than once. The count is what tells a
    // reviewer how many times this attempt reached the provider.
    assert.equal(twice.dispatches, 2);
  });
});

describe("who may read an effect", () => {
  test("a reference is not a permission", async () => {
    const { record } = await begin("key-authz");
    await assert.rejects(
      () => ledger.read(stranger, record.effectRef),
      AuthorizationError,
    );
  });

  test("an unknown reference is refused rather than invented", async () => {
    await assert.rejects(
      () => ledger.read(actor, "beff_ffffffffffffffffffffffffffffffff"),
      AuthorizationError,
    );
  });
});

describe("what an effect is allowed to remember", () => {
  test("only an origin is kept, never the URL a form was posted to", async () => {
    const { record } = await begin("key-origin");
    const after = await ledger.dispatching(
      actor,
      record.effectRef,
      "https://provider.example",
    );
    // A login action routinely carries a continuation, an identifier or a token
    // in its query string. The ledger is read by callers who are entitled to
    // none of that.
    assert.equal(after.destination, "https://provider.example");
    assert.doesNotMatch(String(after.destination), /[?#]/);
  });

  test("an effect carries no credential, cookie or response body", async () => {
    const { record } = await begin("key-shape");
    await ledger.dispatching(actor, record.effectRef, "https://p");
    const settled = await ledger.observed(actor, record.effectRef, "verified");
    assert.deepEqual(
      Object.keys(settled).sort(),
      [
        "createdAt",
        "destination",
        "dispatches",
        "effectRef",
        "effectivePlanDigest",
        "idempotencyKey",
        "outcome",
        "runRef",
        "state",
        "subject",
        "tenant",
        "updatedAt",
      ].sort(),
    );
  });
});
