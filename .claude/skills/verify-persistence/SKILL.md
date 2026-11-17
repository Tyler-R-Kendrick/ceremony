---
name: verify-persistence
description: "Check a change to the persistence store's lease and revision check against its TLA+ model: claim, heartbeat, assertFence, cancel, put and delete in src/server/persistence/index.ts, on SQLite and PostgreSQL. Use before you finish any change to src/server/persistence/index.ts, to the SQL or the transaction boundaries of either store, or to how a caller holds a Fence across transactions; when a change adds a store method or a backend; and for questions about stale fences, lease takeover, expiry, worker generations, expectedRevision or PersistenceConflict."
---

# Verify the persistence lease and revision check

`src/server/persistence/index.ts` gives every worker two guards: a lease on a key (`claim`, `heartbeat`, `assertFence`, `cancel`, with a `Fence {generation, worker}`) and a revision on a record (`put` and `delete` with `expectedRevision`). A TLA+ model of both, for one key, lives in `verification/persistence/`, and TLC checks one promise:

> A worker whose lease on a key was taken over or cancelled can never commit a fenced transaction on its old fence, and a put or delete that names a revision changes the record only if it is still the version the caller read.

If it breaks, two workers both finish the same run, outbox entry or effect, or one silently overwrites what the other stored.

The promise is four rules in `Fence.tla`:

| Rule | Says | Today |
| --- | --- | --- |
| `StaleFenceNeverCommits` | A transaction that passed `assertFence` commits only while its fence is still the lease on the key. | Holds |
| `LiveLeaseNeverTakenOver` | `claim` never takes a lease away before it ran out. | Holds |
| `ExpiredFenceNeverPasses` | `assertFence` refuses a lease that ran out, also when nobody took it over. | Holds |
| `StaleRevisionNeverWrites` | A put or delete with an expected revision replaces only the record version the caller read. | Holds, also when the record is deleted and created again (finding F1, closed). |

`verification/persistence/README.md` has the map from every action and variable of the model to file:line, the bounds, the assumptions, what is left out, and finding F1 and how it was closed. Read it before you change the model.

## The model does not read the code

TLC checks `Fence.tla`. It never opens a TypeScript file. If you change the store and run the check without changing the model, the check tells you about the old code. So the order is always:

1. Decide whether your change touches the verified code (next section).
2. If it does, change the model to say what the code now does.
3. Run the check.
4. Read the result.

## Does your change touch the verified code?

Yes, if it changes any of these:

- In `src/server/persistence/index.ts`: `now`, `fenceRow`, `assertFence`, `get`, `put`, `retired`, `create`, `delete`, `list`, `claim`, `heartbeat`, `cancel`; the `lock` suffix (`FOR UPDATE`); the `migration` SQL of `ceremony_records`, `ceremony_claims` or `ceremony_retired`; `SQLiteCeremonyStore.transaction`; `PostgresCeremonyStore.transaction`; `PersistenceConflict`; `Fence`; `rotateRecords`.
- Any SQL text in those functions, any `WHERE` or `ON CONFLICT` clause, the order of statements inside them, or where a transaction begins, commits or rolls back.
- The isolation level or locking of either store, or a new store backend.
- A new method on `AsyncTransaction` that reads or writes `ceremony_claims`, or writes `ceremony_records` in a new way (for example a write with no revision).
- A new shape of caller. The model knows these: claim in one transaction, work outside any transaction, then a transaction that calls `assertFence` and after it `put`, `delete`, `cancel` or `heartbeat`; and writers with no lease that read and write in one transaction. A caller that writes for a lease without `assertFence` in the same transaction, or keeps a fence somewhere other than memory, is a shape the model does not have.

To see what changed since the model was last confirmed, compare the covered files with the sync commit at the end of this skill:

```sh
git diff 35fb0d1e9c66ec64b14bd1a54a1c16d28bdbff4a -- src/server/persistence
```

Changes only to sealing, key validation, list paging, record kinds or error text do not touch the model. Backup and restore are outside the model too, so the check says nothing about a change there (see Not covered). Decide this from the map in the README, not from a commit message.

## Run the check

```sh
verification/persistence/check.sh
```

It takes about 20 seconds, needs Java 11 or later, and uses the pinned TLC through `verification/tlc.sh`. It runs every config and compares each with the recorded result:

- `Fence`, `RevisionNoDelete`, `Chart` must hold.
- `FindingRevisionReused` must hold. It is rule 4 with records deleted and created again, where finding F1 was.
- Each `Broken*` config takes one check out of the model and must break the rule recorded for it. This is the evidence that the rules can fail.

Exit 0 and `All configs did what README.md records` means nothing changed. A `FAIL` line names the config, what was expected and what happened.

To see one config with TLC's own output: `verification/tlc.sh persistence Fence BrokenNoRowLock` (any config name).

## Read every result with /statechart

Read each result with the `/statechart` skill: the failing ones, and a passing one when you want to see the lease as a chart. Give it `verification/persistence/Fence.tla`, the config in question, and `verification/persistence/view.mjs`, and follow that skill for how to run it and where to work. It reports the shortest path to each broken rule in the words of `view.mjs` ("a worker claims the key", "an old holder's fence is accepted"), and for `Chart.cfg` it draws the whole lease as a statechart. The other configs are too large for a whole chart; for them it reports the rules and the paths. After a rule breaks in a large config such as `Fence.cfg`, it can list the other rules as not checked; `Chart.cfg` is small enough to check every rule after a break.

## A rule broke: real bug or modelling error?

Decide with the code, not with the model.

1. Get the shortest path from `/statechart`, and the same path from TLC's trace, which shows `claim`, `rec`, `now`, `lock` and each process's `pc`, `fence` and `seen` after every step.
2. Turn each step into the store call it stands for, with the map in the README: `ClaimReadsClock` and `ClaimUpsert` are one `tx.claim`; `AssertFence` is `tx.assertFence`; `HeartbeatExtends` is the rest of `tx.heartbeat`; `FencedCommit` is `tx.put`, `tx.delete` or `tx.cancel` after `assertFence` in one transaction; `CancelKey` is `tx.cancel` with no fence; `OtherWriter...` is a transaction of a caller with no lease; `ClockTicks` is waiting.
3. Replay the path against the real store, one call per step. `verification/persistence/replay.mts` already does this for every recorded path; copy one of its blocks. Use `SQLiteCeremonyStore(":memory:", ...)` when the steps of each transaction stay together. Use the PostgreSQL fixture, as `replay.mts` does, when the path puts another transaction's step between `AssertFence` and the commit: only PostgreSQL interleaves like that.
4. Judge:
   - The store does what the path says, for example it accepts the stale commit. **Real bug.** Stop. Do not weaken the rule, do not narrow the model, do not turn the failing config off. Report the path in the code's words with file:line. Fix the code only if the user asked for that.
   - The store refuses a step that the model allowed, or cannot run the steps in that order. **Modelling error.** Find the line that refuses, change the action in `Fence.tla` to say so, add the line to the README map, and run again.
   - You cannot replay the step, for example a wait on a row lock. Say so, and treat the result as a bug candidate until someone shows otherwise.

Other changes in the output:

- **A `Broken*` config now holds.** The check it takes out no longer carries the rule. Either the code got a second defence, or the model lost the path. Find out which before you touch the config. Do not delete a broken variant to get a clean run.
- **`FindingRevisionReused` breaks.** A record created again can take a revision its key had before: finding F1 is back. Check `create` and the end of `delete` in `index.ts` against `KeepRetired` in `Fence.tla`. `BrokenNoRetiredRevision.cfg` shows the path TLC finds without the retired revision.
- **`error`** in a `FAIL` line means TLC could not run the config: a syntax error in `Fence.tla`, a constant missing from a `.cfg`, or Java missing. The lines under it are TLC's message.

## Update the verification for an intended change

Write the update from the code, before you run the check, and do not shape it by what passes.

- **A check, a clause or the order of statements changed.** Change the action that stands for it in `Fence.tla` (the README map tells you which). Keep each model step equal to one statement, or to statements that no other transaction can come between. If a row lock no longer covers a stretch of a transaction, split the action there.
- **A check was removed or replaced.** Keep its switch only if a broken variant still means something. Each switch (`CheckGeneration`, `CheckExpiry`, `LockFenceRow`, `ClaimOnlyExpired`, `ClaimBumpsGeneration`, `CheckRevision`, `KeepRetired`) names its line in a comment at the top of `Fence.tla`. Update the line, or remove the switch together with its `Broken*.cfg`, its row in `check.sh`, its block in `replay.mts` and its row in the README.
- **A new check carries a rule.** Add a switch for it, a `Broken*.cfg` that turns it off, the row in `check.sh` with the rule it must break, a block in `replay.mts` that takes the same text out of a copy of `index.ts`, and the row in the README. A rule that no broken variant can break proves nothing.
- **A new store method or caller shape.** Add an action, name it in `Next` as its own disjunct so that traces show it, give it a label in `view.mjs`, and add it to the README map with file:line.
- **The promise itself changed on purpose.** Change a rule only then, and write in the README the old wording, the new wording, and the evidence in the change (tests, doc comment, `docs/architecture.md`).
- **Line numbers moved.** Update them in the comments of `Fence.tla`, in the README map and in `check.sh`. `replay.mts` finds code by its text, and stops if the text is gone.
- **Bounds.** Keep them unless the change makes them wrong. If the check gets slow, lower a bound in one config and say so in the README. The constants are explained at the top of `Fence.tla`.
- **The chart.** If `Fence.tla`, `Chart.cfg` or `view.mjs` changed, draw the chart again with `/statechart` from `Chart.cfg` and `view.mjs`, and replace `verification/persistence/chart.mmd` with the new one.

Then run `verification/persistence/check.sh` and `node --no-warnings --import tsx verification/persistence/replay.mts`. Every line of the replay must start with `same`.

## Coverage record

| Check | Rules | Covers |
| --- | --- | --- |
| `Fence.cfg` | `StaleFenceNeverCommits`, `LiveLeaseNeverTakenOver`, `ExpiredFenceNeverPasses` | `src/server/persistence/index.ts`: `now`, `fenceRow`, `assertFence`, `claim`, `heartbeat`, `cancel`, the `lock` suffix, `SQLiteCeremonyStore.transaction`, `PostgresCeremonyStore.transaction`, `PersistenceConflict`, `Fence`, the `ceremony_claims` table |
| `RevisionNoDelete.cfg`, `FindingRevisionReused.cfg` | `StaleRevisionNeverWrites` | `src/server/persistence/index.ts`: `get`, `list`, `put`, `retired`, `create`, `delete`, `rotateRecords`, the `ceremony_records` and `ceremony_retired` tables. As writers with no lease: `rotateTenant` and `retainWithoutDemonstration` in `src/server/persistence/maintenance.ts`; `collect`, `complete` and `purgeExpired` in `src/server/persistence/collections.ts` |
| `Broken*.cfg` | One rule each, expected to break | The line each switch names: `index.ts:195`, `:217`, `:219`, `:314`, `:364`; `:223-274` and `:330-335` (`BrokenNoRetiredRevision.cfg`) |
| `Chart.cfg` | All four | The same code, as a small model for `chart.mmd` |
| `replay.mts` | Not a model check. Replays the recorded paths against the real stores. | `SQLiteCeremonyStore`, `PostgresCeremonyStore`, and the text of the five lines above |

The caller shapes in the model were read from `src/server/agent/workflow-api.ts` (`dispatchAgentWakes`: claim, work, fenced put with release), `src/server/hosted/a2h.ts` (`postgresA2HRecords`, its `lock` and `put`: fenced put without release, release alone, one `worker` string for every process) and `src/server/connectors/state/effects.ts` (`createEffectJournalPort`, its `begin`, `complete` and `heartbeat`). The model does not check that these or any other callers keep to the shape.

Not covered: what a worker does between transactions; `encryptedBackup` and `restoreEncryptedBackup`, and the retired revisions they carry; deadlocks and timeouts; sealing; transactions over several keys; a clock that steps backwards; anything beyond the bounds in the README; any "eventually".

## Sync commit

`35fb0d1e9c66ec64b14bd1a54a1c16d28bdbff4a`

At this commit the model was confirmed, line by line, to describe the covered code, `check.sh` gave the recorded results, and `replay.mts` printed `same` on every line. The covered files last changed in that commit.

Move this commit forward only after you have confirmed that the model describes the covered code at the new commit: you read the diff of the covered files since this commit, updated the model and the README map where the code changed, and both commands above gave their expected results. A clean run alone is not that confirmation. When you move it, change the hash here and in the `git diff` command above.

If covered code changed in commits that did not go through this skill, use `/maintain-formal-verification-skill` to bring the verification back in line.
