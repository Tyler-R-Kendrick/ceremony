// Replays the paths of the model (Fence.tla) against the store's real code,
// to show that the model and the code say the same thing.
//
//   node --no-warnings --import tsx verification/persistence/replay.mts
//
// Product code is only read. Each broken variant is a copy of
// src/server/persistence/index.ts in a temporary folder with one piece of
// text taken out: the same piece that the matching switch in Fence.tla takes
// out of the model. If that text is no longer in index.ts exactly once, the
// replay stops and says so: the code moved, and the model needs another look.
//
// Every line of the output starts with "same" when the code did what the
// model says, and with "DIFFERENT" when it did not. Exit 0 only when every
// line says "same".
import { randomBytes } from "node:crypto";
import {
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { postgresFixture } from "../../tests/fixtures/postgres.ts";
import * as written from "../../src/server/persistence/index.ts";

type Store = typeof written;
const repo = resolve(import.meta.dirname, "../..");
const source = join(repo, "src/server/persistence");
const ring = { current: "replay", keys: { replay: randomBytes(32) } };
const key = (id: string) => ({ tenant: "tenant", kind: "outbox" as const, id });
const longest = 300_000;

let different = 0;
const say = (name: string, same: boolean, detail: string) => {
  if (!same) different++;
  console.log(`${same ? "same     " : "DIFFERENT"} | ${name} | ${detail}`);
};
const outcome = async (work: Promise<unknown>) => {
  try {
    await work;
    return "accepted";
  } catch (error) {
    return error instanceof Error &&
      error.constructor.name === "PersistenceConflict"
      ? "refused"
      : `error: ${String(error)}`;
  }
};

const scratch = await mkdtemp(join(tmpdir(), "ceremony-fence-replay-"));
await symlink(join(repo, "node_modules"), join(scratch, "node_modules"));

/** A copy of index.ts with `from` replaced by `to`, loaded as a module. */
async function variant(name: string, from: string, to: string): Promise<Store> {
  const folder = join(scratch, name);
  await mkdir(folder);
  const text = await readFile(join(source, "index.ts"), "utf8");
  if (text.split(from).length !== 2)
    throw new Error(
      `${name}: index.ts no longer holds this text exactly once: ${JSON.stringify(from)}`,
    );
  await writeFile(join(folder, "index.ts"), text.replace(from, to));
  await copyFile(join(source, "sealing.ts"), join(folder, "sealing.ts"));
  return import(join(folder, "index.ts"));
}
const sqlite = (store: Store) =>
  new store.SQLiteCeremonyStore(":memory:", ring);

try {
  // Fence.cfg: the code as written refuses each bad step.
  {
    const store = sqlite(written);
    const old = await store.transaction((tx) =>
      tx.claim(key("a"), "same-workload", longest),
    );
    const live = await outcome(
      store.transaction((tx) => tx.claim(key("a"), "same-workload", longest)),
    );
    await store.transaction((tx) => tx.cancel(key("a")));
    await store.transaction((tx) => tx.claim(key("a"), "same-workload", longest));
    const stale = await outcome(
      store.transaction((tx) => tx.heartbeat(old, longest)),
    );
    const short = await store.transaction((tx) =>
      tx.claim(key("b"), "worker", 5),
    );
    await delay(20);
    const ranOut = await outcome(
      store.transaction((tx) => tx.assertFence(short)),
    );
    say(
      "Fence, SQLite, code as written",
      live === "refused" && stale === "refused" && ranOut === "refused",
      `claim of a live lease ${live}; old fence ${stale}; fence of a lease that ran out ${ranOut}`,
    );
    await store.close();
  }

  // FindingRevisionReused.cfg (F1), told across transactions.
  {
    const store = sqlite(written);
    await store.transaction((tx) =>
      tx.put(key("f1"), { version: "first" }, null),
    );
    const fence = await store.transaction((tx) =>
      tx.claim(key("f1"), "worker", longest),
    );
    const read = (await store.transaction((tx) => tx.get(key("f1"))))!;
    await store.transaction((tx) => tx.delete(key("f1"), read.revision));
    await store.transaction((tx) =>
      tx.put(key("f1"), { version: "second" }, null),
    );
    const stale = await outcome(
      store.transaction(async (tx) => {
        await tx.assertFence(fence);
        await tx.put(key("f1"), { version: "based on first" }, read.revision);
      }),
    );
    say(
      "FindingRevisionReused, SQLite, code as written",
      stale === "accepted",
      `put with the revision read before the delete ${stale}`,
    );
    await store.close();
  }

  // BrokenNoGenerationCheck.cfg, index.ts:188
  {
    const store = sqlite(
      await variant(
        "no-generation-check",
        "      Number(row.generation) !== fence.generation ||\n",
        "",
      ),
    );
    const old = await store.transaction((tx) =>
      tx.claim(key("a"), "same-workload", longest),
    );
    await store.transaction((tx) => tx.cancel(key("a")));
    await store.transaction((tx) => tx.claim(key("a"), "same-workload", longest));
    const stale = await outcome(
      store.transaction((tx) => tx.heartbeat(old, longest)),
    );
    say(
      "BrokenNoGenerationCheck, SQLite",
      stale === "accepted",
      `old fence's heartbeat ${stale}`,
    );
    await store.close();
  }

  // BrokenNoGenerationBump.cfg, index.ts:282
  {
    const store = sqlite(
      await variant(
        "no-generation-bump",
        "DO UPDATE SET generation=ceremony_claims.generation+1,worker=excluded.worker",
        "DO UPDATE SET generation=ceremony_claims.generation,worker=excluded.worker",
      ),
    );
    const old = await store.transaction((tx) =>
      tx.claim(key("a"), "same-workload", 5),
    );
    await delay(20);
    await store.transaction((tx) => tx.claim(key("a"), "same-workload", longest));
    const stale = await outcome(
      store.transaction((tx) => tx.heartbeat(old, longest)),
    );
    say(
      "BrokenNoGenerationBump, SQLite",
      stale === "accepted",
      `old fence's heartbeat ${stale}`,
    );
    await store.close();
  }

  // BrokenClaimLiveLease.cfg, index.ts:282
  {
    const store = sqlite(
      await variant(
        "claim-live-lease",
        " WHERE ceremony_claims.expires<=$6 RETURNING generation",
        " RETURNING generation",
      ),
    );
    await store.transaction((tx) => tx.claim(key("a"), "first", longest));
    const taken = await outcome(
      store.transaction((tx) => tx.claim(key("a"), "second", longest)),
    );
    say(
      "BrokenClaimLiveLease, SQLite",
      taken === "accepted",
      `claim of a live lease ${taken}`,
    );
    await store.close();
  }

  // BrokenNoExpiryCheck.cfg, index.ts:190
  {
    const store = sqlite(
      await variant(
        "no-expiry-check",
        "      row.worker !== fence.worker ||\n      Number(row.expires) <= (await now())\n",
        "      row.worker !== fence.worker\n",
      ),
    );
    const fence = await store.transaction((tx) =>
      tx.claim(key("a"), "worker", 5),
    );
    await delay(20);
    const ranOut = await outcome(
      store.transaction((tx) => tx.assertFence(fence)),
    );
    say(
      "BrokenNoExpiryCheck, SQLite",
      ranOut === "accepted",
      `fence of a lease that ran out ${ranOut}`,
    );
    await store.close();
  }

  // BrokenNoRevisionCheck.cfg, index.ts:238
  {
    const store = sqlite(
      await variant(
        "no-revision-check",
        "WHERE tenant=$1 AND kind=$2 AND id=$3 AND revision=$6 RETURNING revision",
        "WHERE tenant=$1 AND kind=$2 AND id=$3 RETURNING revision",
      ),
    );
    await store.transaction((tx) => tx.put(key("a"), { version: 1 }, null));
    await store.transaction((tx) => tx.put(key("a"), { version: 2 }, 1));
    const stale = await outcome(
      store.transaction((tx) => tx.put(key("a"), { version: "stale" }, 1)),
    );
    say(
      "BrokenNoRevisionCheck, SQLite",
      stale === "accepted",
      `put with revision 1 over revision 2 ${stale}`,
    );
    await store.close();
  }

  // PostgreSQL: the steps that only interleave there.
  const fixture = await postgresFixture();
  try {
    const a = new written.PostgresCeremonyStore(fixture.config, ring);
    const b = new written.PostgresCeremonyStore(fixture.config, ring);
    await a.migrate();

    // The model's `lock`: after assertFence, cancel() waits for the COMMIT.
    {
      const fence = await a.transaction((tx) =>
        tx.claim(key("lock"), "holder", longest),
      );
      let cancelled = false;
      let commit!: () => void;
      const untilCommit = new Promise<void>((done) => (commit = done));
      let asserted!: () => void;
      const untilAsserted = new Promise<void>((done) => (asserted = done));
      const fenced = a.transaction(async (tx) => {
        await tx.assertFence(fence);
        asserted();
        await untilCommit;
      });
      await untilAsserted;
      const cancel = b
        .transaction((tx) => tx.cancel(key("lock")))
        .then(() => (cancelled = true));
      await delay(300);
      const waited = !cancelled;
      commit();
      await fenced;
      await cancel;
      const after = await outcome(a.transaction((tx) => tx.assertFence(fence)));
      say(
        "Fence, PostgreSQL, code as written",
        waited && cancelled && after === "refused",
        `cancel waited for the open fenced transaction: ${waited}; old fence afterwards ${after}`,
      );
    }

    // FindingRevisionReused.cfg (F1), step for step as TLC reports it: the
    // delete and the create land while the holder's fenced transaction is open.
    {
      const fence = await a.transaction((tx) =>
        tx.claim(key("f1"), "holder", longest),
      );
      const first = await a.transaction(async (tx) => {
        await tx.assertFence(fence);
        return tx.put(key("f1"), { version: "first" }, null);
      });
      const stale = await outcome(
        a.transaction(async (tx) => {
          await tx.assertFence(fence);
          await b.transaction((other) => other.delete(key("f1"), first));
          await b.transaction((other) =>
            other.put(key("f1"), { version: "second" }, null),
          );
          await tx.put(key("f1"), { version: "based on first" }, first);
        }),
      );
      say(
        "FindingRevisionReused, PostgreSQL, code as written",
        stale === "accepted",
        `put with the revision read before the delete ${stale}`,
      );
    }

    // BrokenNoRowLock.cfg, index.ts:166: a cancel lands inside the open
    // fenced transaction, and the transaction still commits.
    {
      const unlocked = await variant(
        "no-row-lock",
        'const lock = postgres ? " FOR UPDATE" : "";',
        'const lock = "";',
      );
      const c = new unlocked.PostgresCeremonyStore(fixture.config, ring);
      const d = new unlocked.PostgresCeremonyStore(fixture.config, ring);
      const fence = await c.transaction((tx) =>
        tx.claim(key("nolock"), "holder", longest),
      );
      const stale = await outcome(
        c.transaction(async (tx) => {
          await tx.assertFence(fence);
          await d.transaction((other) => other.cancel(key("nolock")));
          await tx.put(
            key("nolock"),
            { version: "committed on a cancelled lease" },
            null,
          );
        }),
      );
      say(
        "BrokenNoRowLock, PostgreSQL",
        stale === "accepted",
        `fenced commit with a cancel inside it ${stale}`,
      );
      await c.close();
      await d.close();
    }
    await a.close();
    await b.close();
  } finally {
    await fixture.close();
  }
} finally {
  await rm(scratch, { recursive: true, force: true });
}
process.exitCode = different === 0 ? 0 : 1;
