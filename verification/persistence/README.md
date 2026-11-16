# Persistence: the lease on a key and the revision check

A TLA+ model of `src/server/persistence/index.ts`, checked with TLC. It covers one `RecordKey`: the lease that workers claim, keep alive, lose and take over, and the record that they write with an expected revision.

**The property.** A worker whose lease on a key was taken over or cancelled can never commit a fenced transaction on its old fence, and a put or delete that names a revision changes the record only if it is still the version the caller read.

**The harm if it breaks.** Two workers both finish the same run, outbox entry or effect, or one silently overwrites or deletes what the other stored: a provider call is repeated, an outcome is lost, a single-use value is spent twice.

`docs/architecture.md:38` makes the promise in the repo's words: "Revisions and worker generations fence stale commits".

## Result

Checked at commit `2b14e0720188516fc3e3934f51cf2a4359fedab3`. `.claude/skills/verify-persistence/SKILL.md` keeps the sync commit.

| Rule | Plain sentence | Result |
| --- | --- | --- |
| 1 `StaleFenceNeverCommits` | A transaction that passed `assertFence` commits only while its fence is still the lease on the key. | Holds |
| 2 `LiveLeaseNeverTakenOver` | `claim` never takes a lease away before it ran out. | Holds |
| 3 `ExpiredFenceNeverPasses` | `assertFence` refuses a lease that ran out, also when nobody took it over. | Holds |
| 4 `StaleRevisionNeverWrites` | A put or delete with an expected revision replaces only the record version the caller read. | Holds for a key whose record is never deleted. **Breaks** when the record is deleted and created again: finding F1. |

## Finding F1: a deleted and re-created record takes its old revision number again

Open. This is the code as written, with every switch of the model on.

`put` with `expectedRevision = null` always stores revision 1 (`index.ts:229`, `:234`). `delete` removes the row and with it the count (`index.ts:244-254`). So a record that is deleted and created again is back at a revision that an earlier reader may still hold, and the check `AND revision=$6` (`index.ts:238`, and `:248` for delete) cannot tell the two records apart.

The path, in the code's words:

1. A record exists at revision 1. Worker A reads it and keeps `revision: 1` (`tx.get`, `index.ts:204-222`).
2. Another caller deletes it: `tx.delete(key, 1)` (`index.ts:244-254`). The row is gone.
3. A caller creates it again: `tx.put(key, value, null)` (`index.ts:232-236`). The new record is at revision 1.
4. Worker A writes with what it read: `tx.put(key, value, 1)`. `UPDATE ... AND revision=$6` matches (`index.ts:238`), the put is accepted, and the record that A never read is replaced. `tx.delete(key, 1)` by A is accepted the same way.

A lease does not help: A can hold a live fence through all four steps, unless every caller that deletes and creates this key takes the same lease first.

TLC finds it in `FindingRevisionReused.cfg` (8 steps). `replay.mts` replays it against the real stores: on SQLite across transactions as above, on PostgreSQL with steps 2 and 3 landing while A's fenced transaction is open. Both accept the stale put.

Scope of the finding. Rule 4 holds for a key whose record is never deleted (`RevisionNoDelete.cfg`). It breaks only where a record is deleted, created again under the same id, and brought back to a revision that someone read before the delete. The model does not say which callers do that. One candidate, read by hand and not model-checked: the OAuth ticket of a run in `src/server/authored-human.ts`. Its key is fixed for the run (`:328-332`), it is created with `existing?.revision ?? null` (`:990-1008`, `:1045-1061`), it is deleted (`:367`, `:1076`, `:1120`, `:1130`, `:1162`), and the revision is carried from one transaction to a later one (`:343` to `:367`; `:1095` to `:1120`, `:1130`, `:1147`, `:1162`).

## What the model also shows (not rule breaks)

- **A slow claim can be born run out.** `claim` reads the clock (`index.ts:280`) and then runs the upsert (`:282`). If the lease duration passes between the two, the returned fence is already refused by `assertFence`, and another worker can claim at once.
- **A fenced transaction can commit after the lease's time ran out.** `assertFence` checks the clock once (`index.ts:190`). If the transaction stays open past the expiry, it still commits. Nobody can take the lease over meanwhile, because the claim row is locked until the transaction ends, so rule 1 holds.
- **`heartbeat`'s UPDATE names the key only, not the generation** (`index.ts:291-294`). It is safe only because `assertFence` locked the row just before (`BrokenNoRowLock.cfg` shows what happens without the lock).
- **Two checks are not needed for these rules.** With the generation check in place, the comparison `row.worker !== fence.worker` (`index.ts:189`) and the `generation+1` in `cancel` (`index.ts:299`) each refuse nothing more. They are in the model, but there is no broken variant for them, because removing either breaks no rule.

## How to run

```sh
verification/persistence/check.sh
```

About 20 seconds on 4 cores. It runs every config below with the pinned TLC (`verification/tlc.sh`, TLC 1.7.4, needs Java 11 or later) and compares each result with the one recorded here. Exit 0 means nothing changed, with F1 still open.

One config alone, with TLC's own trace: `verification/tlc.sh persistence Fence BrokenNoRowLock` (any config name).

The model and the code side by side: `node --no-warnings --import tsx verification/persistence/replay.mts` (a few seconds; it starts the test PostgreSQL fixture). It replays each path below against the real stores, and each broken variant against a temporary copy of `index.ts` with the same text taken out. Product code is only read.

## Configs, bounds and results

All configs use `SharedIdentity = TRUE`: every process passes the same `worker` string to `claim`, so only the generation tells two fences apart. That is the hardest case for `assertFence` (`src/server/hosted/a2h.ts:39` passes `"a2h"` from every process). With distinct identities `assertFence` accepts no more than it does here.

| Config | Rules | Processes | `Duration` | `MaxNow` | `MaxEpoch` | `MaxWrites` | Deletes | Result |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `Fence.cfg` | 1, 2, 3 | 3 | 2 | 5 | 4 | 1 | yes | No error. 145,970 states. |
| `RevisionNoDelete.cfg` | 4 | 2 | 2 | 2 | 2 | 4 | no | No error. 10,260 states. |
| `FindingRevisionReused.cfg` | 4 | 2 | 2 | 1 | 2 | 3 | yes | Rule 4 breaks: F1. |
| `Chart.cfg` | 1, 2, 3, 4 | 2 | 1 | 1 | 4 | 0 | no | No error. 346 states. No restarts, no writers without a lease. |

What the bounds mean:

- `Duration`: the `durationMs` of `claim` and `heartbeat`, in clock ticks. The code allows 1 to 300,000 ms (`index.ts:194-197`).
- `MaxNow`: the database clock runs from 0 to `MaxNow`. With `Duration = 2` and `MaxNow = 5`, two leases can run out one after the other and a third can start.
- `MaxEpoch`: how many times the lease changes hands, counting each successful `claim` and each `cancel`.
- `MaxWrites`: how many record versions are ever written.
- `Fence.cfg` and `RevisionNoDelete.cfg` treat the processes as interchangeable (TLC symmetry).

A pass covers these bounds and this model, not the whole system.

## Broken variants: each rule can fail

Product code was not changed. Each variant is a switch of the model that takes out one check, and `replay.mts` takes the same text out of a temporary copy of `index.ts` and gets the same bad outcome from the real store.

| Config | Switch set to `FALSE` | Code it takes out | Rule that breaks | Path TLC finds |
| --- | --- | --- | --- | --- |
| `BrokenNoGenerationCheck.cfg` | `CheckGeneration` | `index.ts:188` `Number(row.generation) !== fence.generation` | 1 | A claims (generation 1). Someone cancels the key (generation 2). B claims with the same worker name (generation 3). A's `assertFence` passes on its generation-1 fence, and A's heartbeat commits on B's lease. |
| `BrokenNoRowLock.cfg` | `LockFenceRow` | `index.ts:166` `" FOR UPDATE"` (PostgreSQL) | 1 | A claims. A's `assertFence` passes. Before A's transaction ends, someone's `cancel` commits. A's heartbeat UPDATE then commits and gives the cancelled row a new expiry. |
| `BrokenNoGenerationBump.cfg` | `ClaimBumpsGeneration` | `index.ts:282` `generation=ceremony_claims.generation+1` | 1 | A claims (generation 1) and its lease runs out. B claims with the same worker name and also gets generation 1. A's `assertFence` passes, and A's heartbeat commits on B's lease. |
| `BrokenClaimLiveLease.cfg` | `ClaimOnlyExpired` | `index.ts:282` `WHERE ceremony_claims.expires<=$6` | 2 | A claims. B claims at once and gets the lease while A's has not run out. |
| `BrokenNoExpiryCheck.cfg` | `CheckExpiry` | `index.ts:190` `Number(row.expires) <= (await now())` | 3 | A's `claim` reads the clock, and two ticks pass before its upsert runs, so the lease it gets has already run out. A's `assertFence` passes all the same. |
| `BrokenNoRevisionCheck.cfg` | `CheckRevision` | `index.ts:238` `AND revision=$6` | 4 | A writes the record (revision 1) and keeps the revision. A writer with no lease rewrites it (revision 2). A's `put(key, value, 1)` is accepted and replaces a version A never read. |

In the first three, the committed transaction is a heartbeat because that is the shortest path. A fenced put or cancel commits the same way.

## What one step of the model is

One step is one SQL statement, or a run of statements that no other transaction can come between.

- **SQLite.** `transaction()` runs the whole callback between `BEGIN IMMEDIATE` and `COMMIT` (`index.ts:322-366`), one transaction at a time per store object (`tail`, `:309`, `:364`) and one writer at a time per file. Its runs are the runs of the model in which the steps of one transaction come one right after the other.
- **PostgreSQL.** `transaction()` runs the callback between plain `BEGIN` and `COMMIT` (`index.ts:504-529`), so at the default level, READ COMMITTED, transactions interleave statement by statement. The model interleaves them the same way, with two things joined into one step:
  - `assertFence` reads the claim row with `FOR UPDATE` (`index.ts:166`, `:177-183`). From there to the end of the transaction no other transaction can change that row: `claim`, `cancel` and another `assertFence` on the key wait. The model's `lock` is this row lock. `replay.mts` checks on PostgreSQL that a `cancel` waits.
  - A write that is not yet committed is not visible to anyone, and holds its row. So the model puts each write and its `COMMIT` in one step. A statement that had to wait decides on the row as it is after the other transaction committed.

## Map from the model to the code

Paths are under `src/server/`. `index.ts` is `persistence/index.ts`.

| Model | Code |
| --- | --- |
| `now` | The database clock that `now()` reads: `index.ts:167-176` (PostgreSQL `clock_timestamp()` `:172`, SQLite `julianday('now')` `:173`). |
| `claim` | The key's row in `ceremony_claims`: `generation`, `worker`, `expires` (`index.ts:142-145`). Generation 0 stands for "no row". |
| `lock` | The row lock on that row, from `fenceRow`'s `FOR UPDATE` (`index.ts:166`, `:177-183`) to `COMMIT` or `ROLLBACK` (`:519`, `:523`). On SQLite, the write lock of `BEGIN IMMEDIATE` (`:327`). |
| `rec` | The key's row in `ceremony_records`: `revision` (`index.ts:139-141`). Revision 0 stands for "no row". `write` is a ghost that names the version; it stands for `value`. |
| `pc` | Where a worker process is: `idle`; `claiming`, between `index.ts:280` and `:281`; `working`, holding a fence between transactions (for example `agent/workflow-api.ts:55-67`); `asserted`, inside a fenced transaction after `assertFence` returned. |
| `fence` | The `Fence` (`index.ts:67`) that `claim` returned (`:286`) and the caller keeps in memory (for example `agent/workflow-api.ts:44`, `connectors/state/effects.ts:109`). |
| `clockRead` | `time` in `claim` (`index.ts:280`). |
| `seen` | The `StoredRecord` a caller read and whose `revision` it passes on later (`agent/workflow-api.ts:32-39` to `:71`), or the revision `put` returned (`index.ts:242`). |
| `epoch`, `fenceEpoch`, `nextWrite` and the four flags | Ghosts. No code stores them; the rules are stated on them. |
| `ClockTicks` | Time passes on the database clock. |
| `ReadRecord(p)` | `tx.get` (`index.ts:204-222`) or `tx.list` (`:255-275`). |
| `ClaimReadsClock(p)` | `claim`, up to `const time = await now()` (`index.ts:276-280`). |
| `ClaimUpsert(p)` | `claim`'s upsert, its `PersistenceConflict`, the returned fence (`index.ts:281-286`), and the `COMMIT` (`:355`, `:519`). Callers: `agent/workflow-api.ts:45-48`, `hosted/a2h.ts:36-39`, `connectors/state/effects.ts:193`. |
| `AssertFence(p)` | `assertFence` (`index.ts:184-193`). Callers: `agent/workflow-api.ts:69`, `connectors/state/effects.ts:252`, `hosted/a2h.ts:66`, `:81`, and `heartbeat` itself (`index.ts:290`). |
| `HeartbeatExtends(p)` | `heartbeat`'s UPDATE (`index.ts:291-294`) and the `COMMIT`. Caller: `connectors/state/effects.ts:296`. |
| `FencedCommit(p, write, release)` | The rest of a fenced transaction: `put` (`index.ts:223-243`) or `delete` (`:244-254`) with the revision the caller read, or neither; then `cancel` (`:297-302`) or not; then `COMMIT`. On `PersistenceConflict` (`:241`, `:253`), `ROLLBACK` (`:358`, `:523`). Shapes: put-or-nothing with release `agent/workflow-api.ts:68-73`; put alone `hosted/a2h.ts:80-84`; release alone `hosted/a2h.ts:65-68`. |
| `CancelKey` | `cancel` (`index.ts:297-302`) by a caller that holds no fence, for example `commands.ts:436`. |
| `ProcessRestarts(p)` | The process stops: its open transaction rolls back (`index.ts:358`, `:523`) and its in-memory fence is gone. |
| `OtherWriterCreates` | `put(key, value, null)` by a caller with no lease, for example `persistence/collections.ts:134`. |
| `OtherWriterRewrites` | Read and rewrite in one transaction: `rotateRecords` (`index.ts:536-553`), `rotateTenant` (`persistence/maintenance.ts:47-56`). |
| `OtherWriterDeletes` | Read and delete in one transaction: `persistence/maintenance.ts:71-100`, `persistence/collections.ts:214-232`, `:248-268`. |
| `ClockBoundReached` | Model only. It keeps the end of the bounded clock from being reported as a deadlock. |
| `Processes`, `SharedIdentity` | The worker processes, and whether they pass one `worker` string to `claim` (`hosted/a2h.ts:39`; `tests/security/fencing-generation.test.ts` is the same case as a test). |

## Assumptions

- PostgreSQL runs at READ COMMITTED, its default; the code opens transactions with plain `BEGIN` (`index.ts:517`). A stricter level only refuses more.
- Each store has one clock that does not go backwards. Both backends read the database's own clock, never the worker's.
- A caller keeps `assertFence` and its writes in one transaction, and does not catch `PersistenceConflict` and commit anyway. The model's fenced commit exists only after `assertFence` passed in that same transaction. Whether each caller does this is not checked here.
- An error other than `PersistenceConflict` ends the transaction with a rollback, which the model treats as the transaction not having happened.
- Keys do not affect each other. Every statement of `claim`, `heartbeat`, `assertFence`, `cancel`, `put` and `delete` names one `(tenant, kind, id)`.

## Left out

- What a worker does between transactions: provider calls, browser work. The store cannot fence those. Rule 1 is about what commits in the store.
- `encryptedBackup` and `restoreEncryptedBackup` (`index.ts:410-479`), including whether a restored database can hand out a generation that a fence from before the restore still names.
- Deadlocks between row locks, lock and connection timeouts, the 5 second SQLite busy retry (`index.ts:324-337`), pool failures.
- Sealing and key rotation as cryptography (`persistence/sealing.ts`), key validation, list paging, transactions that touch several keys.
- Whether a lease is ever free again, and any other "eventually". The rules say only what never happens.
- A clock that steps backwards.
- More processes, ticks, changes of hands or writes than the bounds above.
- The callers. `verification/commands` is a separate model of the command path, which uses this lease.

## The chart

`chart.mmd` is the lease as a statechart, drawn by the `/statechart` skill from `Chart.cfg` with `view.mjs`. It is the small model: two processes, one clock tick, no record writes, no restarts, no writers without a lease. It does not draw steps that stay inside one state: starting a claim, a refused claim, reading the record, time passing without a lease running out, and whatever a newer lease does while an old holder is still at work.

## Files

| File | What it is |
| --- | --- |
| `Fence.tla` | The model and the four rules. |
| `Fence.cfg`, `RevisionNoDelete.cfg` | The code as written; expected to pass. |
| `FindingRevisionReused.cfg` | The code as written; expected to break rule 4 (F1). |
| `Broken*.cfg` | One check taken out each; expected to break the rule named above. |
| `Chart.cfg`, `view.mjs`, `chart.mmd` | The small model for the chart, the words on the chart, and the chart. |
| `check.sh` | Runs every config and compares with the recorded results. |
| `replay.mts` | Replays the paths against the real stores. |
