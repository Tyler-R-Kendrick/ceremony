import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { ConnectorError } from "../../../src/server/connectors/errors.js";
import { createConnectorPorts } from "../../../src/server/connectors/state/index.js";
import { names } from "../../../src/server/connectors/state/handoff-claims.js";
import { handoffKey } from "../../../src/server/connectors/state/keys.js";
import { rotateTenant } from "../../../src/server/persistence/maintenance.js";
import { SYSTEM_TENANT } from "../../../src/server/system-tenants.js";
import type { StoredHandoff } from "../../../src/server/connectors/state/schemas.js";
import {
  SQLiteCeremonyStore,
  type Keyring,
} from "../../../src/server/persistence/index.js";
import { actorFor, connectionRecord } from "../fixtures/state/records.js";

/*
 * STATE-01: what a claim keeps of a submission. The caller names a submission
 * by a plain SHA-256 of the values; the handoff record keeps an HMAC of it
 * under a key derived from the vault key, so a short submitted code cannot be
 * guessed back from the record by someone without that key. Two workers with
 * the same vault keys agree on it, a key rotation leaves a held claim
 * recognised, and a claim written before claims were keyed (the plain digest
 * itself) is honoured until its lease runs out. A claim written under a key
 * that has since left the ring is not recognised (fail closed), and the
 * comparison names no candidate by how long it took.
 */

const LEASE_MS = 60_000;
const TENANT = "tenant-a";
const sha256 = (text: string) =>
  createHash("sha256").update(text).digest("hex");
// A six-digit code is what a plain digest would give away to a guesser.
const ONE = sha256('["handoff.submission","h",0,{"code":"123456"}]');
const TWO = sha256('["handoff.submission","h",0,{"code":"654321"}]');
const A1 = "attempt-one-0001";
const A2 = "attempt-two-0002";
const A3 = "attempt-three-003";

const ring = (current: string, keys: Record<string, Buffer>): Keyring => ({
  current,
  keys,
});

async function database(t: test.TestContext) {
  const directory = await mkdtemp(join(tmpdir(), "ceremony-claim-digest-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return join(directory, "state.sqlite");
}

function open(path: string, keyring: Keyring, now: () => number) {
  const store = new SQLiteCeremonyStore(path, keyring);
  return { store, ports: createConnectorPorts(store, { now }) };
}

async function issue(ports: ReturnType<typeof open>["ports"], at: number) {
  const record = connectionRecord({ tenantId: TENANT });
  await ports.connections.create(record);
  const issued = await ports.handoffs.issue({
    actor: actorFor(TENANT),
    connectionRef: record.connectionRef,
    bindingRef: record.bindingRef,
    generation: 0,
    kind: "input-required",
    presentation: "in-app",
    expiresAt: at + 3_600_000,
    intent: "conformance.select",
    private: { fields: '["code"]' },
  });
  return issued.handoffRef;
}

async function storedClaim(store: SQLiteCeremonyStore, handoffRef: string) {
  const record = await store.transaction((tx) =>
    tx.get<StoredHandoff>(handoffKey(TENANT, handoffRef)),
  );
  return record?.value.claim;
}

const alreadyClaimed = (error: unknown) =>
  error instanceof ConnectorError && error.detail === "handoff.already-claimed";

test("STATE-01: the claim keeps a keyed digest of the submission, never the plain one", async (t) => {
  const path = await database(t);
  const now = () => 1_700_000_000_000;
  const key = randomBytes(32);
  const worker = open(path, ring("k1", { k1: key }), now);
  const other = open(path, ring("k1", { k1: key }), now);
  t.after(() => Promise.all([worker.store.close(), other.store.close()]));
  const handoffRef = await issue(worker.ports, now());
  assert.equal(
    await worker.ports.handoffs.claim(handoffRef, 0, ONE, A1, LEASE_MS),
    "claimed",
  );
  const kept = (await storedClaim(worker.store, handoffRef))!.submission;
  assert.match(kept, /^[0-9a-f]{64}$/);
  assert.notEqual(kept, ONE, "the record keeps the plain SHA-256");
  // Keyed: the same submission under another vault key is another digest.
  const elsewhere = open(
    await database(t),
    ring("k9", { k9: randomBytes(32) }),
    now,
  );
  t.after(() => elsewhere.store.close());
  const second = await issue(elsewhere.ports, now());
  await elsewhere.ports.handoffs.claim(second, 0, ONE, A1, LEASE_MS);
  assert.notEqual(
    (await storedClaim(elsewhere.store, second))!.submission,
    kept,
  );
  // A second worker with the same vault key recognises it; another value is refused.
  assert.deepEqual(
    await other.ports.handoffs.claim(handoffRef, 0, ONE, A2, LEASE_MS),
    { shared: A1 },
  );
  await assert.rejects(
    other.ports.handoffs.claim(handoffRef, 0, TWO, A3, LEASE_MS),
    alreadyClaimed,
  );
});

test("STATE-01: a claim held across a vault key rotation is still recognised", async (t) => {
  const path = await database(t);
  const now = () => 1_700_000_000_000;
  const k1 = randomBytes(32);
  const before = open(path, ring("k1", { k1 }), now);
  const handoffRef = await issue(before.ports, now());
  await before.ports.handoffs.claim(handoffRef, 0, ONE, A1, LEASE_MS);
  await before.store.close();
  const after = open(path, ring("k2", { k1, k2: randomBytes(32) }), now);
  t.after(() => after.store.close());
  assert.deepEqual(
    await after.ports.handoffs.claim(handoffRef, 0, ONE, A2, LEASE_MS),
    { shared: A1 },
  );
  await assert.rejects(
    after.ports.handoffs.claim(handoffRef, 0, TWO, A3, LEASE_MS),
    alreadyClaimed,
  );
});

test("STATE-01: a claim written with the plain digest is honoured until its lease runs out", async (t) => {
  const path = await database(t);
  let at = 1_700_000_000_000;
  const now = () => at;
  const { store, ports } = open(path, ring("k1", { k1: randomBytes(32) }), now);
  t.after(() => store.close());
  const handoffRef = await issue(ports, at);
  // Exactly what the claim wrote before it was keyed: the caller's digest as it came.
  await store.transaction(async (tx) => {
    const key = handoffKey(TENANT, handoffRef);
    const record = (await tx.get<StoredHandoff>(key))!;
    await tx.put(
      key,
      {
        ...record.value,
        claim: { submission: ONE, attempt: A1, expiresAt: at + LEASE_MS },
      },
      record.revision,
    );
  });
  assert.deepEqual(
    await ports.handoffs.claim(handoffRef, 0, ONE, A2, LEASE_MS),
    {
      shared: A1,
    },
  );
  await assert.rejects(
    ports.handoffs.claim(handoffRef, 0, TWO, A3, LEASE_MS),
    alreadyClaimed,
  );
  // Once its lease has run out the old claim is no one's, and what is written now is keyed.
  at += LEASE_MS;
  assert.equal(
    await ports.handoffs.claim(handoffRef, 0, TWO, A3, LEASE_MS),
    "claimed",
  );
  const kept = (await storedClaim(store, handoffRef))!;
  assert.equal(kept.attempt, A3);
  assert.notEqual(kept.submission, TWO);
});

test("STATE-01: a claim written under a key since removed from the ring refuses an identical retry until its lease ends", async (t) => {
  const path = await database(t);
  let at = 1_700_000_000_000;
  const now = () => at;
  const k1 = randomBytes(32);
  const k2 = randomBytes(32);
  const before = open(path, ring("k1", { k1 }), now);
  const handoffRef = await issue(before.ports, at);
  await before.ports.handoffs.claim(handoffRef, 0, ONE, A1, LEASE_MS);
  await before.store.close();
  // The operator's rotation seals every record again under the new key; the
  // digest inside the claim stays the one the old key derived.
  const rotating = open(path, ring("k2", { k1, k2 }), now);
  for (const tenant of [TENANT, SYSTEM_TENANT.connector])
    assert.ok((await rotateTenant(rotating.store, tenant)) > 0);
  await rotating.store.close();
  // The operator then retires the old key.
  const after = open(path, ring("k2", { k2 }), now);
  t.after(() => after.store.close());
  await assert.rejects(
    after.ports.handoffs.claim(handoffRef, 0, ONE, A2, LEASE_MS),
    alreadyClaimed,
    "the identical submission is not recognised: it is refused, never run twice",
  );
  await assert.rejects(
    after.ports.handoffs.claim(handoffRef, 0, TWO, A3, LEASE_MS),
    alreadyClaimed,
  );
  // The lease is what ends it: afterwards the handoff can be claimed again.
  at += LEASE_MS;
  assert.equal(
    await after.ports.handoffs.claim(handoffRef, 0, ONE, A2, LEASE_MS),
    "claimed",
  );
});

test("STATE-01: the held digest is compared with every candidate, so no early exit tells which one matched", () => {
  const held = "a".repeat(64);
  const others = ["b".repeat(64), "c".repeat(64)];
  for (const [candidates, plain] of [
    [[held, ...others], others[0]!],
    [[others[0]!, held, others[1]!], others[1]!],
    [[...others, held], others[0]!],
    [others, held],
    [others, others[1]!],
  ] as const) {
    const read: number[] = [];
    const counted = new Proxy([...candidates], {
      get(target, property, receiver) {
        if (typeof property === "string" && /^\d+$/.test(property))
          read.push(Number(property));
        return Reflect.get(target, property, receiver);
      },
    });
    const expected = candidates.includes(held) || plain === held;
    assert.equal(names(held, plain, counted), expected);
    assert.deepEqual(
      [...new Set(read)].sort(),
      candidates.map((_, index) => index),
      `every keyed candidate is read (${candidates.indexOf(held)} matches)`,
    );
  }
  // Digests of another length are never equal and never throw.
  assert.equal(names(held, "short", ["also short"]), false);
});
