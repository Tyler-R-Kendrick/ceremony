# Persistence: the lease on a key and the revision check

A TLA+ model of `src/server/persistence/index.ts`, checked with TLC. It covers one `RecordKey`: the lease that workers claim, keep alive, lose and take over, and the record that they write with an expected revision.

**The property.** A worker whose lease on a key was taken over or cancelled can never commit a fenced transaction on its old fence, and a put or delete that names a revision changes the record only if it is still the version the caller read.

**The harm if it breaks.** Two workers both finish the same run, outbox entry or effect, or one silently overwrites or deletes what the other stored: a provider call is repeated, an outcome is lost, a single-use value is spent twice.

`docs/architecture.md:38` makes the promise in the repo's words: "Revisions and worker generations fence stale commits".

## Result

Checked at commit `35fb0d1e9c66ec64b14bd1a54a1c16d28bdbff4a`. `.claude/skills/verify-persistence/SKILL.md` keeps the sync commit.

| Rule | Plain sentence | Result |
| --- | --- | --- |
| 1 `StaleFenceNeverCommits` | A transaction that passed `assertFence` commits only while its fence is still the lease on the key. | Holds |
| 2 `LiveLeaseNeverTakenOver` | `claim` never takes a lease away before it ran out. | Holds |
| 3 `ExpiredFenceNeverPasses` | `assertFence` refuses a lease that ran out, also when nobody took it over. | Holds |
| 4 `StaleRevisionNeverWrites` | A put or delete with an expected revision replaces only the record version the caller read. | Holds, also when the record is deleted and created again (finding F1, closed). |

## Finding F1: a deleted and re-created record took its old revision number again

Closed in `35fb0d1e9c66ec64b14bd1a54a1c16d28bdbff4a`.

Before that commit, `put` with `expectedRevision = null` always stored revision 1, and `delete` removed the row and with it the count. So a record that was deleted and created again was back at a revision that an earlier reader could still hold, and the check `AND revision=$6` could not tell the two records apart: worker A read revision 1, another caller deleted the record and created it again at revision 1, and A's `put(key, value, 1)` or `delete(key, 1)` was accepted on a record A never read. A lease did not help.

What the code does now:

- `delete` (`index.ts:320-336`) removes the row and keeps its revision in `ceremony_retired` (`:330-335`, table `:171-173`).
- `put(key, value, null)` (`create`, `index.ts:223-274`) stores the record one above the key's retired revision, or at 1 if it has none, and removes the retired row (`:269-272`). The INSERT (`:245`) waits for a transaction that is deleting the key; once it holds the new row no other transaction can delete the key, so `retired` is read again after it (`:255`) and the record moves above a delete that committed in between (`:256-268`). The model takes `create` as one step for that reason.
- Revisions are counted per key: `ceremony_retired` has one row per key whose record is deleted and not created again, and the delete of one key never changes the revision another key's record is created at. A key that never had a record starts at revision 1. The migration adds `ceremony_retired` to an older store; revisions of records deleted before then are not known. `encryptedBackup` exports the retired revisions (`retired`, backup version 2) and `restoreEncryptedBackup` restores them, refusing a key that has both a record and a retired revision; a version 1 backup restores with none (`index.ts:492-588`). The model has one key and leaves backup and restore out.

`FindingRevisionReused.cfg` now holds. `BrokenNoRetiredRevision.cfg` sets `KeepRetired = FALSE`, the code before the fix, and TLC finds the old path again. `replay.mts` replays the path against the real stores: on SQLite across transactions, on PostgreSQL with the delete and the create landing while A's fenced transaction is open. Both refuse the stale put and the stale delete. `tests/persistence-revision.test.ts` and `tests/persistence-revision-restore.test.ts` test the same on both stores, through migration, backup and restore, and with a create that waits for a delete of the key on PostgreSQL.

Callers that carry a revision from one transaction to a later one, such as the OAuth ticket of a run in `src/server/authored-human.ts` (`:343` to `:367`; `:1095` to `:1120`, `:1130`, `:1147`, `:1162`), now get `PersistenceConflict` where they were accepted before; none of them relied on a revision being handed out again. The ticket's own `revision` field (`:351`, `:1072`) is the run record's revision, and run records are never deleted. A caller that takes the revision of a created record uses the one `put` returns: `createDraft` (`src/server/recipes/index.ts`) and the connection store's `create` and `saveConnection` (`src/server/connectors/state/connections.ts`).

## What the model also shows (not rule breaks)

- **A slow claim can be born run out.** `claim` reads the clock (`index.ts:362`) and then runs the upsert (`:364`). If the lease duration passes between the two, the returned fence is already refused by `assertFence`, and another worker can claim at once.
- **A fenced transaction can commit after the lease's time ran out.** `assertFence` checks the clock once (`index.ts:219`). If the transaction stays open past the expiry, it still commits. Nobody can take the lease over meanwhile, because the claim row is locked until the transaction ends, so rule 1 holds.
- **`heartbeat`'s UPDATE names the key only, not the generation** (`index.ts:373-376`). It is safe only because `assertFence` locked the row just before (`BrokenNoRowLock.cfg` shows what happens without the lock).
- **Two checks are not needed for these rules.** With the generation check in place, the comparison `row.worker !== fence.worker` (`index.ts:218`) and the `generation+1` in `cancel` (`index.ts:381`) each refuse nothing more. They are in the model, but there is no broken variant for them, because removing either breaks no rule.

## How to run

```sh
verification/persistence/check.sh
```

About 20 seconds on 4 cores. It runs every config below with the pinned TLC (`verification/tlc.sh`, TLC 1.7.4, needs Java 11 or later) and compares each result with the one recorded here. Exit 0 means nothing changed.

One config alone, with TLC's own trace: `verification/tlc.sh persistence Fence BrokenNoRowLock` (any config name).

The model and the code side by side: `node --no-warnings --import tsx verification/persistence/replay.mts` (a few seconds; it starts the test PostgreSQL fixture). It replays each path below against the real stores, and each broken variant against a temporary copy of `index.ts` with the same text taken out. Product code is only read.

## Configs, bounds and results

All configs use `SharedIdentity = TRUE`: every process passes the same `worker` string to `claim`, so only the generation tells two fences apart. That is the hardest case for `assertFence` (`src/server/hosted/a2h.ts:39` passes `"a2h"` from every process). With distinct identities `assertFence` accepts no more than it does here.

| Config | Rules | Processes | `Duration` | `MaxNow` | `MaxEpoch` | `MaxWrites` | Deletes | Result |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `Fence.cfg` | 1, 2, 3 | 3 | 2 | 5 | 4 | 1 | yes | No error. 145,970 states. |
| `RevisionNoDelete.cfg` | 4 | 2 | 2 | 2 | 2 | 4 | no | No error. 10,260 states. |
| `FindingRevisionReused.cfg` | 4 | 2 | 2 | 1 | 2 | 3 | yes | No error. 8,561 states. The path of F1 is in these bounds. |
| `Chart.cfg` | 1, 2, 3, 4 | 2 | 1 | 1 | 4 | 0 | no | No error. 346 states. No restarts, no writers without a lease. |

What the bounds mean:

- `Duration`: the `durationMs` of `claim` and `heartbeat`, in clock ticks. The code allows 1 to 300,000 ms (`index.ts:275-278`).
- `MaxNow`: the database clock runs from 0 to `MaxNow`. With `Duration = 2` and `MaxNow = 5`, two leases can run out one after the other and a third can start.
- `MaxEpoch`: how many times the lease changes hands, counting each successful `claim` and each `cancel`.
- `MaxWrites`: how many record versions are ever written.
- `Fence.cfg` and `RevisionNoDelete.cfg` treat the processes as interchangeable (TLC symmetry).

A pass covers these bounds and this model, not the whole system.

## Broken variants: each rule can fail

Product code was not changed. Each variant is a switch of the model that takes out one check, and `replay.mts` takes the same text out of a temporary copy of `index.ts` and gets the same bad outcome from the real store.

| Config | Switch set to `FALSE` | Code it takes out | Rule that breaks | Path TLC finds |
| --- | --- | --- | --- | --- |
| `BrokenNoGenerationCheck.cfg` | `CheckGeneration` | `index.ts:217` `Number(row.generation) !== fence.generation` | 1 | A claims (generation 1). Someone cancels the key (generation 2). B claims with the same worker name (generation 3). A's `assertFence` passes on its generation-1 fence, and A's heartbeat commits on B's lease. |
| `BrokenNoRowLock.cfg` | `LockFenceRow` | `index.ts:195` `" FOR UPDATE"` (PostgreSQL) | 1 | A claims. A's `assertFence` passes. Before A's transaction ends, someone's `cancel` commits. A's heartbeat UPDATE then commits and gives the cancelled row a new expiry. |
| `BrokenNoGenerationBump.cfg` | `ClaimBumpsGeneration` | `index.ts:364` `generation=ceremony_claims.generation+1` | 1 | A claims (generation 1) and its lease runs out. B claims with the same worker name and also gets generation 1. A's `assertFence` passes, and A's heartbeat commits on B's lease. |
| `BrokenClaimLiveLease.cfg` | `ClaimOnlyExpired` | `index.ts:364` `WHERE ceremony_claims.expires<=$6` | 2 | A claims. B claims at once and gets the lease while A's has not run out. |
| `BrokenNoExpiryCheck.cfg` | `CheckExpiry` | `index.ts:219` `Number(row.expires) <= (await now())` | 3 | A's `claim` reads the clock, and two ticks pass before its upsert runs, so the lease it gets has already run out. A's `assertFence` passes all the same. |
| `BrokenNoRevisionCheck.cfg` | `CheckRevision` | `index.ts:314` `AND revision=$6` | 4 | A writes the record (revision 1) and keeps the revision. A writer with no lease rewrites it (revision 2). A's `put(key, value, 1)` is accepted and replaces a version A never read. |
| `BrokenNoRetiredRevision.cfg` | `KeepRetired` | `index.ts:330-335` (the retired revision) and `:223-274` (create above it) | 4 | F1: A reads the record at revision 1. It is deleted and created again at revision 1. A's `put(key, value, 1)` is accepted. A row of `check.sh`; not yet a block of `replay.mts`, whose `FindingRevisionReused` blocks replay the same path on the code as written. |

In the first three, the committed transaction is a heartbeat because that is the shortest path. A fenced put or cancel commits the same way.

## What one step of the model is

One step is one SQL statement, or a run of statements that no other transaction can come between.

- **SQLite.** `transaction()` runs the whole callback between `BEGIN IMMEDIATE` and `COMMIT` (`index.ts:404-448`), one transaction at a time per store object (`tail`, `:391`, `:446`) and one writer at a time per file. Its runs are the runs of the model in which the steps of one transaction come one right after the other.
- **PostgreSQL.** `transaction()` runs the callback between plain `BEGIN` and `COMMIT` (`index.ts:613-638`), so at the default level, READ COMMITTED, transactions interleave statement by statement. The model interleaves them the same way, with two things joined into one step:
  - `assertFence` reads the claim row with `FOR UPDATE` (`index.ts:195`, `:206-212`). From there to the end of the transaction no other transaction can change that row: `claim`, `cancel` and another `assertFence` on the key wait. The model's `lock` is this row lock. `replay.mts` checks on PostgreSQL that a `cancel` waits.
  - A write that is not yet committed is not visible to anyone, and holds its row. So the model puts each write and its `COMMIT` in one step. A statement that had to wait decides on the row as it is after the other transaction committed.

## Map from the model to the code

Paths are under `src/server/`. `index.ts` is `persistence/index.ts`.

| Model | Code |
| --- | --- |
| `now` | The database clock that `now()` reads: `index.ts:196-205` (PostgreSQL `clock_timestamp()` `:201`, SQLite `julianday('now')` `:202`). |
| `claim` | The key's row in `ceremony_claims`: `generation`, `worker`, `expires` (`index.ts:167-170`). Generation 0 stands for "no row". |
| `lock` | The row lock on that row, from `fenceRow`'s `FOR UPDATE` (`index.ts:195`, `:206-212`) to `COMMIT` or `ROLLBACK` (`:628`, `:632`). On SQLite, the write lock of `BEGIN IMMEDIATE` (`:409`). |
| `rec` | The key's row in `ceremony_records`: `revision` (`index.ts:164-166`). Revision 0 stands for "no row". `write` is a ghost that names the version; it stands for `value`. |
| `retired` | The key's row in `ceremony_retired`: the revision its record had when it was deleted (`index.ts:171-173`, written at `:330-335`, removed at `:269-272`). 0 stands for "no row". |
| `CreatedRevision`, `RetiredAfterCreate`, `RetiredAfterDelete` | `create` (`index.ts:223-274`) and the end of `delete` (`:330-335`). |
| `pc` | Where a worker process is: `idle`; `claiming`, between `index.ts:362` and `:363`; `working`, holding a fence between transactions (for example `agent/workflow-api.ts:55-67`); `asserted`, inside a fenced transaction after `assertFence` returned. |
| `fence` | The `Fence` (`index.ts:67`) that `claim` returned (`:368`) and the caller keeps in memory (for example `agent/workflow-api.ts:44`, `connectors/state/effects.ts:109`). |
| `clockRead` | `time` in `claim` (`index.ts:362`). |
| `seen` | The `StoredRecord` a caller read and whose `revision` it passes on later (`agent/workflow-api.ts:32-39` to `:71`), or the revision `put` returned (`index.ts:318`). |
| `epoch`, `fenceEpoch`, `nextWrite` and the four flags | Ghosts. No code stores them; the rules are stated on them. |
| `ClockTicks` | Time passes on the database clock. |
| `ReadRecord(p)` | `tx.get` (`index.ts:285-303`) or `tx.list` (`:337-357`). |
| `ClaimReadsClock(p)` | `claim`, up to `const time = await now()` (`index.ts:358-362`). |
| `ClaimUpsert(p)` | `claim`'s upsert, its `PersistenceConflict`, the returned fence (`index.ts:363-368`), and the `COMMIT` (`:437`, `:628`). Callers: `agent/workflow-api.ts:45-48`, `hosted/a2h.ts:36-39`, `connectors/state/effects.ts:193`. |
| `AssertFence(p)` | `assertFence` (`index.ts:213-222`). Callers: `agent/workflow-api.ts:69`, `connectors/state/effects.ts:252`, `hosted/a2h.ts:66`, `:81`, and `heartbeat` itself (`index.ts:372`). |
| `HeartbeatExtends(p)` | `heartbeat`'s UPDATE (`index.ts:373-376`) and the `COMMIT`. Caller: `connectors/state/effects.ts:296`. |
| `FencedCommit(p, write, release)` | The rest of a fenced transaction: `put` (`index.ts:304-319`) or `delete` (`:320-336`) with the revision the caller read, or neither; then `cancel` (`:379-384`) or not; then `COMMIT`. On `PersistenceConflict` (`:317`, `:329`), `ROLLBACK` (`:440`, `:632`). Shapes: put-or-nothing with release `agent/workflow-api.ts:68-73`; put alone `hosted/a2h.ts:80-84`; release alone `hosted/a2h.ts:65-68`. |
| `CancelKey` | `cancel` (`index.ts:379-384`) by a caller that holds no fence, for example `commands.ts:436`. |
| `ProcessRestarts(p)` | The process stops: its open transaction rolls back (`index.ts:440`, `:632`) and its in-memory fence is gone. |
| `OtherWriterCreates` | `put(key, value, null)` (`create`, `index.ts:223-274`) by a caller with no lease, for example `persistence/collections.ts:134`. |
| `OtherWriterRewrites` | Read and rewrite in one transaction: `rotateRecords` (`index.ts:645-662`), `rotateTenant` (`persistence/maintenance.ts:47-56`). |
| `OtherWriterDeletes` | Read and delete in one transaction: `persistence/maintenance.ts:71-100`, `persistence/collections.ts:214-232`, `:248-268`. |
| `ClockBoundReached` | Model only. It keeps the end of the bounded clock from being reported as a deadlock. |
| `Processes`, `SharedIdentity` | The worker processes, and whether they pass one `worker` string to `claim` (`hosted/a2h.ts:39`; `tests/security/fencing-generation.test.ts` is the same case as a test). |

## Assumptions

- PostgreSQL runs at READ COMMITTED, its default; the code opens transactions with plain `BEGIN` (`index.ts:626`). A stricter level only refuses more.
- Each store has one clock that does not go backwards. Both backends read the database's own clock, never the worker's.
- A caller keeps `assertFence` and its writes in one transaction, and does not catch `PersistenceConflict` and commit anyway. The model's fenced commit exists only after `assertFence` passed in that same transaction. Whether each caller does this is not checked here.
- An error other than `PersistenceConflict` ends the transaction with a rollback, which the model treats as the transaction not having happened.
- Keys do not affect each other. Every statement of `claim`, `heartbeat`, `assertFence`, `cancel`, `put` and `delete` names one `(tenant, kind, id)`.

## Left out

- What a worker does between transactions: provider calls, browser work. The store cannot fence those. Rule 1 is about what commits in the store.
- `encryptedBackup` and `restoreEncryptedBackup` (`index.ts:492-588`), including whether a restored database can hand out a generation that a fence from before the restore still names, and the retired revisions they carry (tested in `tests/persistence-revision-restore.test.ts`, not modelled).
- Deadlocks between row locks, lock and connection timeouts, the 5 second SQLite busy retry (`index.ts:406-419`), pool failures.
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
| `FindingRevisionReused.cfg` | The code as written, with records deleted and created again; expected to pass (F1, closed). |
| `Broken*.cfg` | One check taken out each; expected to break the rule named above. |
| `Chart.cfg`, `view.mjs`, `chart.mmd` | The small model for the chart, the words on the chart, and the chart. |
| `check.sh` | Runs every config and compares with the recorded results. |
| `replay.mts` | Replays the paths against the real stores. |
