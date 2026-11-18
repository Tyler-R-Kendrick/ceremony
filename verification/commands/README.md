# Protected command execution and recovery

A TLA+ model of the life of the commands sent for one step of one run, checked with TLC, and a test that ties the model to the real `ProtectedCommandService`.

**The property.** An external effect is never repeated blind: the handler of a step is called again only after the earlier call's outcome is on record and that record allows another attempt, and a command that was interrupted always ends on record as `uncertain`.

**The harm if it breaks.** A provider-side action that cannot be taken back (an app registered, an account created, a one-use code spent) happens twice, or happens once while the run's records say something else, and nobody is told to reconcile it.

**Result.** All ten rules hold, the deadlock check among them. Findings 1, 2, 3, 4 and 5 are fixed, and each is replayed against the real code in `conformance.test.ts`. See [Findings](#findings).

## Run it

```sh
verification/commands/check.sh
```

It takes about 15 seconds. It needs Java 11 or later and the repo's `node_modules`. The first run downloads TLC 1.7.4 (pinned and checksummed in `verification/tlc.sh`).

The script runs every `.cfg` file in this folder and the conformance test, and compares each result with what is expected today. It exits 0 only when every row matches. Today that means: the rules that hold still hold, findings 1, 2, 3, 4 and 5 stay fixed, and every broken variant is still caught.

To see the steps of one row, run that config alone:

```sh
verification/tlc.sh commands Commands FindingBlindRepeat
```

To read any result in plain words, or to redraw the charts, use the `/statechart` skill with `Commands.tla`, the config and `view.mjs`.

## Why TLA+ and TLC

The question is about order: which interleavings of a crash, a lease running out, a replay, a second command id, a cancel and a revalidation can end with the handler called twice or with a record that says the wrong thing. A model checker tries every order of those steps on a small model of the design. No verifier runs on this TypeScript, and the property is not about one function's inputs, so a tool that reads the code would not answer it.

TLC does not read `commands.ts`. `conformance.test.ts` is what ties the model to the code: Part 1 shows each fact the model takes from the code on the real service, and Part 2 replays each counterexample.

## The rules

| Rule                               | In plain words                                                                                                                                                                                              | Code as written                |
| ---------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------ |
| `OneCallPerCommand`                | The handler is called at most once for one command id.                                                                                                                                                      | holds                          |
| `EveryCallHasIntent`               | When the handler is called, the command and effect records are already stored.                                                                                                                              | holds                          |
| `SupersededWorkerNeverCommits`     | A worker whose lease someone else has taken never records its result.                                                                                                                                       | holds                          |
| `NeverBlindRepeat`                 | The handler is not called for a step that is recorded complete, or while another command's call for the step has an unknown outcome (that command is still `running`, or is `uncertain`).                   | holds (findings 1 and 4 fixed) |
| `OneCallPerStep`                   | One call per step: `NeverBlindRepeat` on every path on which no revalidation has rewritten an `uncertain` step as `failed`. Since finding 4 was fixed no path does, so it is `NeverBlindRepeat`.            | holds (finding 1 fixed)        |
| `CompleteStaysVerified`            | A command recorded `complete` has its step recorded complete and verified, unless a revalidation rejected the step later.                                                                                   | holds (finding 2 fixed)        |
| No dead end (TLC's deadlock check) | Every state has a step out unless every command record is in a state `execute` never changes again and no call is in flight.                                                                                | holds (finding 3 fixed)        |
| `UncertainStaysBlocked`            | While a command is recorded `uncertain`, its step is recorded `uncertain`, which is what keeps every new command out. Not asked of an operation registered with replay `read-only`.                         | holds (finding 4 fixed)        |
| `UncertainIsReconciled`            | Every command recorded `uncertain` has a `reconciliation:<commandId>` outbox entry, including one whose handler threw or returned `uncertain`. It stays pending, except that with replay `read-only` it is resolved once another command for the step is recorded complete. | holds (finding 5 fixed)        |
| `UncertainHasWayOut`               | Every step recorded `uncertain` has a declared way out: in an active run, with replay `read-only`, a new command id may run it again; otherwise the command named on it has a pending (not resolved) reconciliation entry. | holds (finding 5 fixed)        |

## The configs

All configs use `Commands.tla`.

| Config                                | What it is                                                                                                                                                 | Expected                              |
| ------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------- |
| `Holds.cfg`                           | The code as written, the nine rules and the deadlock check.                                                                                                | pass                                  |
| `FindingBlindRepeat.cfg`              | Finding 1, fixed: the code as written, `OneCallPerStep`, which is `NeverBlindRepeat` on the paths where finding 4 has not happened.                        | pass                                  |
| `FindingOverwritten.cfg`              | Finding 2, fixed: the code as written, `CompleteStaysVerified`.                                                                                            | pass                                  |
| `FindingDeadEnd.cfg`                  | Finding 3, fixed: the code as written, the deadlock check.                                                                                                 | pass                                  |
| `FindingUnblocked.cfg`                | Finding 4, fixed: the code as written, `UncertainStaysBlocked`.                                                                                            | pass                                  |
| `FindingReopenedRepeat.cfg`           | Finding 4 carried on to the repeated handler call, fixed: the code as written.                                                                             | pass                                  |
| `FindingNoWayOut.cfg`                 | Finding 5, fixed: the code as written for an operation registered with replay `reconciliation`, every rule.                                                | pass                                  |
| `FindingNoWayOutReadOnly.cfg`         | Finding 5, fixed: the code as written for an operation registered with replay `read-only`, every rule.                                                     | pass                                  |
| `NoWayOutIdempotencyKey.cfg`          | The code as written for an operation registered with replay `upstream-idempotency-key`, every rule.                                                        | pass                                  |
| `BrokenTakeoverReruns.cfg`            | Broken variant: the takeover starts a new worker.                                                                                                          | `OneCallPerCommand` broken            |
| `BrokenHandlerBeforeIntent.cfg`       | Broken variant: nothing is stored before the handler.                                                                                                      | `EveryCallHasIntent` broken           |
| `BrokenNoAssertFence.cfg`             | Broken variant: the commit does not check its fence.                                                                                                       | `SupersededWorkerNeverCommits` broken |
| `BrokenAdmitIgnoresHolder.cfg`        | Broken variant: admission does not read the command named on the step.                                                                                     | `OneCallPerStep` broken               |
| `BrokenTakeoverIgnoresStep.cfg`       | Broken variant: admission does not read the command named on the step, and the takeover writes the step without reading it.                                | `CompleteStaysVerified` broken        |
| `BrokenCancelLeavesRunning.cfg`       | Broken variant: cancel does not settle the command in flight.                                                                                              | deadlock                              |
| `BrokenRevalidateReopens.cfg`         | Broken variant: revalidation rewrites an `uncertain` or exhausted step as plain `failed`.                                                                  | `UncertainStaysBlocked` broken        |
| `BrokenCommitSkipsReconciliation.cfg` | Broken variant: the commit stores no reconciliation entry for an `uncertain` result.                                                                       | `UncertainIsReconciled` broken        |
| `BrokenReadOnlyStaysBlocked.cfg`      | Broken variant, replay `read-only`: admission refuses an `uncertain` step whatever the operation's `replay`.                                               | `UncertainHasWayOut` broken           |
| `BrokenResolveWithoutVerified.cfg`    | Broken variant, replay `read-only`: the commit resolves the step's earlier reconciliation entries whatever its result.                                     | `UncertainIsReconciled` broken        |
| `Sketch.cfg`                          | The code plus the one sketched guard that remains, all ten rules.                                                                                          | pass                                  |
| `Commands.cfg`                        | The code as written, all ten rules at once. It is the config to give `/statechart`, which reports every broken rule with its shortest path.                | pass                                  |
| `Lifecycle.cfg`                       | One command id, with a view that keeps the state count under the chart budget. Used only to draw `chart.mmd`; the cancel that fixes finding 3 shows in it. | pass                                  |

## The model and the code

Line numbers are `src/server/commands.ts` at the sync commit recorded in `.claude/skills/verify-commands/SKILL.md`.

One action of the model is one store transaction, or one stretch of work between two transactions in which the store is not touched.

### Actions

| Action                     | Code                                                                                             | What it stands for                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| -------------------------- | ------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `Init`                     | `createRun`, 376-378                                                                             | The run is stored at revision 1 with status `active`. No command, node or claim exists.                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `Admit(c)`                 | `execute`, admission transaction 783-1015, the branch with no record for the id: 805-808, 911-1014 | Run active and revision as expected (911-915); the step is not `complete`, verified or exhausted, and not `uncertain` unless its operation is registered with replay `read-only` (924-937, 930-932); the command named on the step is not `running` (938-947); `tx.claim` on the run (964-968); command stored as `running`, the step's node record names the command (its `state` is kept, or left out when there was no record), and effect stored as `intent-persisted` (977-1004). When the step was `uncertain` (a read-only step run again), the command named on it is added to the node record's `reconciling` (980-994). The run record is **not** written.                                        |
| `CallHandler(c, r)`        | `execute`, 1041-1080                                                                             | The handler call (1041), its verification (1043-1054), the catch that turns a throw into `uncertain` (1055-1058) and the success criteria (1061-1080). Three awaits with no store access between them; a crash between them is `WorkerLost` after this action.                                                                                                                                                                                                                                                                                                  |
| `HandlerNotCalled(c)`      | `execute`, 1038-1040, 1055-1058                                                                  | Authorization is withdrawn or the call is aborted just before the handler. The result is `uncertain` and the handler was not called.                                                                                                                                                                                                                                                                                                                                                                                                                            |
| `WorkerLost(c)`            | process death; `execute`, 1081-1082 and 1087-1095                                                | The call ends without a commit. Nothing is written and the lease is not released.                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `Commit(c)`                | `execute`, commit transaction 1083-1254                                                          | `tx.assertFence` (1086); run active and revision as expected (1096-1100); node, naming the command (1105-1135), command (1141-1148), effect (1149-1154), for an `uncertain` result an outbox entry `reconciliation:<commandId>` with task `reconciliation-required` (1155-1158, `queueReconciliation` 1262-1280), and run (1159-1170) written together; a verified result (only `complete` is verified) marks the entries of the commands in the node record's `reconciling` resolved and drops the field, any other result keeps it (1130-1132, 1136-1140, `resolveReconciliation` 1282-1293); lease released (1245).                                                                                                                                                                                  |
| `CommitRefused(c)`         | `execute`, 1086 and 1096-1100                                                                    | The commit transaction throws `PersistenceConflict`. Nothing is written.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `Takeover(c)`              | `execute`, admission transaction, 808-898                                                        | A call with an id whose record is `running`, in an active run (811), with a lease that can be claimed (813-822): command and effect become `uncertain` (832-841); the node is read first (828-831), and unless it is recorded complete and verified it becomes `uncertain` naming the command (842-853), whatever it was; the run revision moves (854-858), an outbox entry `reconciliation:<commandId>` with task `reconciliation-required` is stored (877-886), the lease is released (887).                                                                  |
| (no action)                | `execute`, 900-909                                                                               | Every other call with a known id returns the stored state and changes nothing.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `LeaseExpires`             | 60 s claims at 565, 817 and 967                                                                  | The database clock passes the claim's expiry.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `CancelRun`                | `cancel`, 452-473; `settleInFlight`, 474-544                                                     | Lease released (460), status `cancelled`, revision moves (461-465). It does not look at the status first. In the same transaction (469-470) it reads the command named on the step (484-490); if that command is `running`, the command and its effect become `uncertain` (494-503), the step becomes `uncertain` naming the command unless it is recorded verified (504-515), and an outbox entry `reconciliation:<commandId>` with task `reconciliation-required` is stored (534-543).                                                                        |
| `RevalidateStart`          | `revalidate`, first transaction 548-568                                                          | Refused for a cancelled run (550-551); `tx.claim` on the run (562-566).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `RevalidateFinish(reject)` | `revalidate`, 569-663                                                                            | The provider checks (569-610) and the last transaction (611-663): `tx.assertFence` (613), same revision and not cancelled (614-618). Only a verified step is asked for its own evidence (576); a step is also rejected when a step it depends on is (572-575). A rejected step recorded `uncertain`, or with no recorded state, is left as it is (635-638); any other rejected step is rewritten `failed`, keeping its `attempts`, its `exhausted` flag and the command named on it (639-654). The run becomes `active` (656-661), the lease is released (662). |
| `RevalidationAbandoned`    | `revalidate`, 582-583, 613-618, 620-628                                                          | The call dies, is denied or is refused. Nothing is written and its lease is not released.                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `Done`                     | none                                                                                             | Stutters in the declared ends, so that the deadlock check reports only dead ends.                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |

### Variables

| Variable                                                             | Code                                                                                                                                                                                                                                                                                                                                                                                         |
| -------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `runStatus`                                                          | `RunRecord.status`, 55                                                                                                                                                                                                                                                                                                                                                                       |
| `runRev`                                                             | The revision of the run record, as `tx.put` returns it (`src/server/persistence/index.ts:223-243`).                                                                                                                                                                                                                                                                                          |
| `node`                                                               | The step's `NodeRecord`, 66-89, as one word. `complete` is `{state: "complete", verified: true}`; `waiting` is `awaiting-human` or `verifying`; `exhausted` is `failed` with `exhausted: true`; `pending` is no record, or a record with no `state` (written by admission for a step with no record). The service stores `verified: true` only with state `complete` (1043-1054, 1071-1078). |
| `holder`                                                             | `NodeRecord.command`, 78-82: the command admitted last for the step. `none` is no record or no such field.                                                                                                                                                                                                                                                                                   |
| `cmd[c]`                                                             | `CommandRecord.state`, 209-222, and the effect record's `status`, which is written in the same transactions: `running` goes with `intent-persisted`, every other state is the same word.                                                                                                                                                                                                     |
| `outbox`                                                             | The outbox entries `reconciliation:<commandId>`: the takeover's (877-886), the cancel's (534-543) and the commit's (1155-1158).                                                                                                                                                                                                                                                              |
| `resolved`                                                           | The entries in `outbox` whose `status` is `resolved` (`resolveReconciliation`, 1282-1293). Every other entry is `pending`.                                                                                                                                                                                                                                                                   |
| `reconciling`                                                        | `NodeRecord.reconciling` (83-88): the commands recorded `uncertain` on a read-only step before the command named on it. The takeover, the cancel and the revalidation keep it when they rewrite the step (`keepReconciling`, 90-92).                                                                                                                                                         |
| `lease`                                                              | The claim row of the run (`src/server/persistence/index.ts:276-302`): which party's claim is live. `free` is no row, a cancelled row or an expired one.                                                                                                                                                                                                                                      |
| `worker[c]`, `result[c]`                                             | The local state of the one `execute` call that was admitted for the id: the fence it holds (964-968) and the `OperationResult` it has (1034-1080).                                                                                                                                                                                                                                           |
| `expRev[c]`                                                          | `command.expectedRevision`, checked at 913 and 1069.                                                                                                                                                                                                                                                                                                                                         |
| `reval`, `revalRev`                                                  | One `revalidate` call between its transactions, and `initial.run.revision` (615).                                                                                                                                                                                                                                                                                                            |
| `revalLeft`                                                          | A bound, not in the code.                                                                                                                                                                                                                                                                                                                                                                    |
| `calls`, `blind`, `rejected`, `reopened`, `superseded`, `lateCommit` | History, not in the code. They exist to state the rules and no action reads them to decide anything.                                                                                                                                                                                                                                                                                         |

### Switches

A switch set to `FALSE` is the code as written. The `.cfg` files turn them on.

| Switch                      | What it changes                                                                                   | Code                     |
| --------------------------- | ------------------------------------------------------------------------------------------------- | ------------------------ |
| `TakeoverRerunsHandler`     | Broken variant. The takeover admits a new worker for the command and does not record `uncertain`. | 823-898                  |
| `HandlerBeforeIntent`       | Broken variant. The command and effect records are not stored before the handler call.            | 977-1004 moved after 1041 |
| `SkipAssertFence`           | Broken variant. The commit does not call `tx.assertFence`.                                        | 1086 removed             |
| `AdmitIgnoresHolder`        | Broken variant. Admission does not read the command named on the step.                            | 938-947 removed          |
| `TakeoverIgnoresStep`       | Broken variant. The takeover writes the step `uncertain` without reading it.                      | 828-831 removed          |
| `CancelLeavesRunning`       | Broken variant. Cancel does not settle the command in flight.                                     | 469-470 removed          |
| `ReconcileInAnyRun`         | Sketch. The takeover does not require an active run.                                              | 811                      |
| `RevalidateReopens`         | Broken variant. Revalidation rewrites an `uncertain` or exhausted step as plain `failed`.         | 637 and 650 removed      |
| `CommitSkipsReconciliation` | Broken variant. The commit stores no reconciliation entry for an `uncertain` result.              | 1155-1158 removed        |
| `ReadOnlyStaysBlocked`      | Broken variant. Admission refuses an `uncertain` step whatever the operation's `replay`.          | 932: replay test removed  |
| `ResolveWithoutVerified`    | Broken variant. The commit resolves the step's earlier reconciliation entries whatever its result. | 1138: `if (verified)` removed |

The constant `Replay` is not a switch: it is `effectiveReplay` of the step's operation (`src/server/recipes/registry.ts`): `RegisteredOperation.replay`, `"read-only"`, `"upstream-idempotency-key"` or `"reconciliation"`, and `"reconciliation"` for an operation registered with none. Every config sets it to `"reconciliation"` except `FindingNoWayOutReadOnly.cfg`, `BrokenReadOnlyStaysBlocked.cfg` and `BrokenResolveWithoutVerified.cfg`, which set `"read-only"`, and `NoWayOutIdempotencyKey.cfg`, which sets `"upstream-idempotency-key"`. Only `"read-only"` lets a new command id run an `uncertain` step again (`replayRerunsUncertain`); `"upstream-idempotency-key"` takes the reconciliation way out, as `"reconciliation"` does, which is the conservative choice: the key deduplicates a repeat at the provider only while the provider keeps it, and nothing here knows for how long. Whether a recipe may declare a retry (`replayAllowsRetry`: `"read-only"` or `"upstream-idempotency-key"`) is checked in `createRun` and recipe validation, which the model leaves out.

## Findings

Each path below is the shortest one TLC finds, told in the code's words. `conformance.test.ts` replays each one against the real service; the lease running out is done there by moving the claim's expiry, as `tests/command-crash-boundaries.test.ts` does.

### Finding 1, fixed: a second command id repeated the handler while the first call was unrecorded

Rule `OneCallPerStep`, config `FindingBlindRepeat.cfg`. The path was 5 steps: `first` is admitted; its handler is called; the worker does not come back and the lease runs out; `second` is admitted for the same step at the same revision; its handler is called while `first` is still `running`.

The admission transaction (783-1015) wrote neither the node record nor the run record, so nothing on the step said a call was in flight, and the lease runs out. Now the same transaction names the command on the step's node record (977-1004), and admission refuses a new id while the command named there is `running` (938-947), whether or not its lease is live. A revalidation keeps that name when it rewrites the step (629-654).

`tests/command-crash-boundaries.test.ts` AC-29 sends a new command id after the crash, before the crashed id is replayed, and asserts it is refused with no provider call.

The fix leaves the run revision and the step's `state` as they were, so the snapshot a caller reads while the first call is in flight still shows the same revision; a new id is refused rather than admitted.

### Finding 2, fixed: the takeover overwrote a step that another command completed

Rule `CompleteStaysVerified`, config `FindingOverwritten.cfg`. The path was 6 steps and needed finding 1: `first` is admitted; the lease runs out; `second` is admitted, called and commits `complete`; `first` is sent again and the takeover wrote the node as `uncertain` without looking at it.

With finding 1 fixed, `second` is not admitted while `first` is `running`, so the model no longer reaches that state. The takeover also reads the node first (828-831): a step recorded complete and verified is left as it is, while the command and its effect still become `uncertain` with a `reconciliation-required` entry. `BrokenTakeoverIgnoresStep.cfg` shows that this read is what keeps the rule when admission is broken.

### Finding 3, fixed: a command in flight when its run was cancelled stayed `running` for ever

The deadlock check, config `FindingDeadEnd.cfg`. The path was 3 steps: `first` is admitted; the worker dies (or returns later and its commit is refused at 1086 or 1096-1100); the run is cancelled. The command stayed `running` and its effect `intent-persisted`, and no call could change either: the takeover requires `run.status === "active"` (811), so every replay returned `running` (900-909), and no `reconciliation-required` entry was stored, although the handler may have run.

Now the cancel transaction settles the command named on each step (469-470, `settleInFlight` 474-544): a `running` command and its effect become `uncertain`, the step becomes `uncertain` unless it is recorded verified, and an outbox entry `reconciliation:<commandId>` with task `reconciliation-required` is stored. Every replay of the id then returns `uncertain`, and a late worker's commit is refused by its fence (1086) and by the run's status (1096-1100). This is what `docs/ceremony-teaching-threat-model.md:31` asks for: "A provider request may already have happened when cancellation or revocation wins; uncertain effects require reconciliation, not automatic replay." `BrokenCancelLeavesRunning.cfg` removes the settling and the dead end comes back on the same 3-step path.

### Finding 4, fixed: revalidation reopened an uncertain step

Rule `UncertainStaysBlocked`, config `FindingUnblocked.cfg`; carried on to the repeated call by `FindingReopenedRepeat.cfg`. The path was 5 steps, 7 to the repeated call:

1. `first` is admitted.
2. The handler is called and throws. The catch makes the result `uncertain` (1055-1058).
3. The commit records the command as `uncertain` and the step as `uncertain`. A new command id is now refused (930-932).
4. `revalidate` starts and claims the run (548-568).
5. The provider no longer vouches for a step that this step depends on. The dependent step is added to `invalid` whatever its own state is (572-575), and the last transaction rewrote every invalid step that had a record as `{state: "failed", verified: false, outputs: {}}`. The step was then plain `failed`.
6. Once the earlier step was complete again, `second` was admitted for the step: the guard at 924-937 lets a `failed` step through.
7. The handler was called again, while `first` was still `uncertain`.

The same happened when the step became `uncertain` through a takeover, with its `reconciliation-required` entry still pending, and the same rewrite dropped `exhausted` from a step that had no attempt left.

Now the last transaction leaves a step recorded `uncertain` as it is (635-638), and a step it rewrites `failed` keeps its `attempts` and its `exhausted` flag (639-654). A new id for the step is refused after the revalidation as before it. `BrokenRevalidateReopens.cfg` shows that this is what keeps the rule. No rule here checks the exhausted case; `conformance.test.ts` replays it on the real service.

### Finding 5, fixed: an `uncertain` step had no way out

Rules `UncertainIsReconciled` and `UncertainHasWayOut`, configs `FindingNoWayOut.cfg` (replay `reconciliation`) and `FindingNoWayOutReadOnly.cfg` (replay `read-only`). The path was 4 steps:

1. `first` is admitted.
2. The handler is called and throws, or returns `uncertain`. The catch makes the result `uncertain` (1055-1058).
3. The commit recorded the command and the step `uncertain` (1119-1154) and wrote no outbox entry.
4. A new command id was refused (930-932) whatever the operation's `replay` said, and no `reconciliation-required` entry named the command.

Only the takeover (877-886) and the cancel (534-543) stored a `reconciliation:<commandId>` entry, so a step made `uncertain` by its own handler could not be run again and nothing asked for it to be reconciled.

Now the commit transaction stores `reconciliation:<commandId>` with task `reconciliation-required` for an `uncertain` result (1155-1158, `queueReconciliation` 1262-1280), and admission reads `RegisteredOperation.replay` (`src/server/recipes/registry.ts:65`): a step recorded `uncertain` accepts a new command id only when its operation is registered `read-only` (930-932). Every other `uncertain` step stays refused, with its pending entry. The run's snapshot shows the entry of the command named on a step as `reconciliation: { commandId, status }` (430, `reconciliationOf` 1299-1311). `BrokenCommitSkipsReconciliation.cfg` and `BrokenReadOnlyStaysBlocked.cfg` show that these two changes are what keep the rules.

A read-only step run again under a new id keeps the commands recorded `uncertain` on it in `NodeRecord.reconciling` (980-994); when the step is recorded verified, their entries are marked `resolved` (1136-1140). A result that is not verified leaves them pending. `BrokenResolveWithoutVerified.cfg` shows that this condition is what keeps `UncertainIsReconciled`.

`conformance.test.ts` replays the path for both declarations on the real service.

## Broken variants

Each rule that holds was seen to fail on a variant of the model with one check removed or one step moved.

| Config                                | Rule                           | The path TLC finds                                                                                                                                                                                                           |
| ------------------------------------- | ------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `BrokenTakeoverReruns.cfg`            | `OneCallPerCommand`            | 6 steps. `first` is admitted; the handler is called; the worker dies; the lease runs out; `first` is sent again and a new worker starts for it; the handler is called a second time for the same id.                         |
| `BrokenHandlerBeforeIntent.cfg`       | `EveryCallHasIntent`           | 2 steps. `first` is admitted with nothing stored; the handler is called. A crash now leaves no trace of the call.                                                                                                            |
| `BrokenNoAssertFence.cfg`             | `SupersededWorkerNeverCommits` | 5 steps. `first` is admitted; the handler is called; the lease runs out; a revalidation starts and takes the lease; `first` commits its result under the revalidation's lease, because the run revision has not moved.       |
| `BrokenAdmitIgnoresHolder.cfg`        | `OneCallPerStep`               | 5 steps. Finding 1's path: `first` is admitted; the handler is called; the lease runs out; `second` is admitted; the handler is called again.                                                                                |
| `BrokenTakeoverIgnoresStep.cfg`       | `CompleteStaysVerified`        | 6 steps. Finding 2's path. With admission broken but the takeover's read in place, the rule holds (61,976 states).                                                                                                           |
| `BrokenCancelLeavesRunning.cfg`       | No dead end                    | 3 steps. Finding 3's path: `first` is admitted; the worker dies; the run is cancelled and the command stays `running`, with no step out.                                                                                     |
| `BrokenRevalidateReopens.cfg`         | `UncertainStaysBlocked`        | 5 steps. Finding 4's path: `first` is admitted; the handler is called and throws; the commit records the command and the step `uncertain`; a revalidation starts; it rejects an earlier step and rewrites this one `failed`. |
| `BrokenCommitSkipsReconciliation.cfg` | `UncertainIsReconciled`        | 3 steps. Finding 5's path: `first` is admitted; the handler is called and throws; the commit records the command `uncertain` with no reconciliation entry.                                                                   |
| `BrokenReadOnlyStaysBlocked.cfg`      | `UncertainHasWayOut`           | 3 steps. Finding 5's path with replay `read-only`: `first` is admitted; the handler is called and throws; the commit records the step `uncertain` in an active run, and admission refuses every new id.                      |
| `BrokenResolveWithoutVerified.cfg`    | `UncertainIsReconciled`        | 6 steps, replay `read-only`: `first` is recorded `uncertain` with a pending entry; `second` is admitted for the step and its result is not verified; the commit marks `first`'s entry resolved although no command completed the step. |

With `RevalidateReopens` on, `NeverBlindRepeat` is also broken, on finding 4's 7-step path and on an 8-step path in which a revalidation reopens the `uncertain` step and the first id's superseded worker then calls the handler while `second` is `running`. Both start with a revalidation rewriting an `uncertain` step as `failed`, which is why `OneCallPerStep` leaves them out.

With admission's read of the step in place and only the takeover's read removed, `CompleteStaysVerified` still holds: no other command completes the step while the first is `running`. The takeover's read is checked in the model only with admission broken as well, and on the real code by the finding 2 test in `conformance.test.ts`, which writes the step complete directly.

## The sketch

`Sketch.cfg` turns on the one guard that remains a sketch: the takeover does not require an active run. Two other sketched guards are now the code: admission refusing a new id while another command for the step is `running` (938-947), and revalidation leaving an `uncertain` step alone (635-638). Finding 3 was fixed in `cancel`, not by the remaining sketch: since a cancel settles the command in flight, no command is `running` in a cancelled run, so the takeover's condition no longer matters, and `Sketch.cfg` explores the same 5,080 states as `Holds.cfg`.

It is a model of one guard, not a reviewed design and not product code.

## Bounds and assumptions

Bounds: one run, one step, two command ids for that step, one cancel, one revalidation. `Holds.cfg` and `Sketch.cfg` each explore 5,080 states, and `FindingNoWayOutReadOnly.cfg` 40,720. Run once by hand with three command ids (43,318 states each) and with two revalidations (19,550 states each), `Holds.cfg` and `Sketch.cfg` gave the same answers.

Assumptions:

- Each `store.transaction` callback is atomic against every other transaction on the same run. SQLite runs one transaction at a time; on PostgreSQL every transaction here locks the run row first (`owned`, 381-390). `verification/persistence` covers that layer.
- `tx.claim` succeeds only when no claim is live, `tx.assertFence` only for the live claim it was given, and `tx.cancel` ends any claim (`src/server/persistence/index.ts:184-193, 276-302`).
- The steps this step depends on are complete whenever a command is sent for it (`resolveInputs`, 693-756, is not modelled).
- The handler, the verifier and the provider may answer anything at any time, and any call may die between two transactions.

## What is left out

- Commands for the other steps of the run. They share the run's lease and revision; the model only lets a commit say whether it was the last unverified step.
- What authorization decides. A denial appears only as a call that ends early.
- A known id sent with a different payload (809-810), the bindings and inputs, the content of success criteria, and the timing of `retryAt` (950-954). Whether a failed step has an attempt left is a free choice in the model.
- The `agent-wake` and `continuation` outbox entries, `deliverContinuations`, and the transition ledger.
- What happens to a `reconciliation-required` entry after it is stored. The run's snapshot shows it on the step, and nothing in `src/` resolves it, so the model treats `uncertain` as an end for an operation not registered `read-only`.
- Whether the provider's own idempotency makes a repeated call harmless. The model counts handler calls, not provider effects.
- A command id that is lost. Since finding 1 was fixed, a step whose command is `running` refuses every other id until that id is sent again (AC-29, `tests/command-crash-boundaries.test.ts`). If the caller loses the id (an agent derives it from `toolCallId`, `agent/coordinator.ts:362`), only cancel is left, which records the command `uncertain` with a `reconciliation-required` entry: nothing else sweeps a `running` command, and the run's snapshot does not show `node.command`. The model hides this because its `Takeover(c)` is always enabled for the holder. That is the trade-off of refusing a second id.

Noticed while reading, not checked by a rule: `CommandRecord.state` declares `admitted` (213) and `CommandStatus.state` declares `cancelled` (228), and `execute` never produces either.

## The charts

- `chart.mmd`: the life of one command, from `Lifecycle.cfg`. No state in it breaks a rule. Before finding 4 was fixed, a revalidation led from an `uncertain` step to "Uncertain, but the step is open again". A cancel while the command is `running` leads to "Marked uncertain, reconciliation queued", the same state as the takeover; before finding 3 was fixed it led to "Stuck: on record as running, run cancelled", a dead end. A result recorded `uncertain` leads there too; before finding 5 was fixed it led to "Recorded uncertain by its worker", with no reconciliation entry. The chart does not draw the steps that leave the command where it is (a revalidation that rejects nothing, a cancel after the command is recorded), and the view hides only the `Done` stutter.

With every rule holding, `Commands.cfg` has no broken rule to draw and more states than the chart budget, so there is no chart of it. The chart is drawn by the `/statechart` skill with `view.mjs`, which holds the words for states and steps.
