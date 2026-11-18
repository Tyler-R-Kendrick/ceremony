# Protected command execution and recovery

A TLA+ model of the life of the commands sent for one step of one run, checked with TLC, and a test that ties the model to the real `ProtectedCommandService`.

**The property.** An external effect is never repeated blind: the handler of a step is called again only after the earlier call's outcome is on record and that record allows another attempt, and a command that was interrupted always ends on record as `uncertain`.

**The harm if it breaks.** A provider-side action that cannot be taken back (an app registered, an account created, a one-use code spent) happens twice, or happens once while the run's records say something else, and nobody is told to reconcile it.

**Result.** Six of the eight rules hold, `OneCallPerStep` and the deadlock check among them. Two are broken by one finding that is open in the code as it is written today: `UncertainStaysBlocked` and `NeverBlindRepeat` (finding 4). Findings 1, 2 and 3 are fixed. Each finding, open or fixed, is replayed against the real code in `conformance.test.ts`. See [Findings](#findings).

## Run it

```sh
verification/commands/check.sh
```

It takes about 15 seconds. It needs Java 11 or later and the repo's `node_modules`. The first run downloads TLC 1.7.4 (pinned and checksummed in `verification/tlc.sh`).

The script runs every `.cfg` file in this folder and the conformance test, and compares each result with what is expected today. It exits 0 only when every row matches. Today that means: the rules that hold still hold, findings 1, 2 and 3 stay fixed, finding 4 is still present, and every broken variant is still caught.

To see the steps of one row, run that config alone:

```sh
verification/tlc.sh commands Commands FindingBlindRepeat
```

To read any result in plain words, or to redraw the charts, use the `/statechart` skill with `Commands.tla`, the config and `view.mjs`.

## Why TLA+ and TLC

The question is about order: which interleavings of a crash, a lease running out, a replay, a second command id, a cancel and a revalidation can end with the handler called twice or with a record that says the wrong thing. A model checker tries every order of those steps on a small model of the design. No verifier runs on this TypeScript, and the property is not about one function's inputs, so a tool that reads the code would not answer it.

TLC does not read `commands.ts`. `conformance.test.ts` is what ties the model to the code: Part 1 shows each fact the model takes from the code on the real service, and Part 2 replays each counterexample.

## The rules

| Rule                               | In plain words                                                                                                                                                                            | Code as written                         |
| ---------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------- |
| `OneCallPerCommand`                | The handler is called at most once for one command id.                                                                                                                                    | holds                                   |
| `EveryCallHasIntent`               | When the handler is called, the command and effect records are already stored.                                                                                                            | holds                                   |
| `SupersededWorkerNeverCommits`     | A worker whose lease someone else has taken never records its result.                                                                                                                     | holds                                   |
| `NeverBlindRepeat`                 | The handler is not called for a step that is recorded complete, or while another command's call for the step has an unknown outcome (that command is still `running`, or is `uncertain`). | **broken**, finding 4 (finding 1 fixed) |
| `OneCallPerStep`                   | One call per step: `NeverBlindRepeat` on every path on which no revalidation has rewritten an `uncertain` step as `failed` (finding 4).                                                   | holds (finding 1 fixed)                 |
| `CompleteStaysVerified`            | A command recorded `complete` has its step recorded complete and verified, unless a revalidation rejected the step later.                                                                 | holds (finding 2 fixed)                 |
| No dead end (TLC's deadlock check) | Every state has a step out unless every command record is in a state `execute` never changes again and no call is in flight.                                                              | holds (finding 3 fixed)                 |
| `UncertainStaysBlocked`            | While a command is recorded `uncertain`, its step is recorded `uncertain`, which is what keeps every new command out.                                                                     | **broken**, finding 4                   |

## The configs

All configs use `Commands.tla`.

| Config                          | What it is                                                                                                                                                                                                                               | Expected                              |
| ------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------- |
| `Holds.cfg`                     | The code as written, the five rules that hold, and the deadlock check.                                                                                                                                                                   | pass                                  |
| `FindingBlindRepeat.cfg`        | Finding 1, fixed: the code as written, `OneCallPerStep`, which is `NeverBlindRepeat` on the paths where finding 4 has not happened.                                                                                                      | pass                                  |
| `FindingOverwritten.cfg`        | Finding 2, fixed: the code as written, `CompleteStaysVerified`.                                                                                                                                                                          | pass                                  |
| `FindingDeadEnd.cfg`            | Finding 3, fixed: the code as written, the deadlock check.                                                                                                                                                                               | pass                                  |
| `FindingUnblocked.cfg`          | The code as written, `UncertainStaysBlocked`.                                                                                                                                                                                            | broken                                |
| `FindingReopenedRepeat.cfg`     | Finding 4 carried on to the repeated handler call, with the code as written.                                                                                                                                                             | broken                                |
| `BrokenTakeoverReruns.cfg`      | Broken variant: the takeover starts a new worker.                                                                                                                                                                                        | `OneCallPerCommand` broken            |
| `BrokenHandlerBeforeIntent.cfg` | Broken variant: nothing is stored before the handler.                                                                                                                                                                                    | `EveryCallHasIntent` broken           |
| `BrokenNoAssertFence.cfg`       | Broken variant: the commit does not check its fence.                                                                                                                                                                                     | `SupersededWorkerNeverCommits` broken |
| `BrokenAdmitIgnoresHolder.cfg`  | Broken variant: admission does not read the command named on the step.                                                                                                                                                                   | `OneCallPerStep` broken               |
| `BrokenTakeoverIgnoresStep.cfg` | Broken variant: admission does not read the command named on the step, and the takeover writes the step without reading it.                                                                                                              | `CompleteStaysVerified` broken        |
| `BrokenCancelLeavesRunning.cfg` | Broken variant: cancel does not settle the command in flight.                                                                                                                                                                            | deadlock                              |
| `Sketch.cfg`                    | The code plus the two sketched guards that remain, all eight rules.                                                                                                                                                                      | pass                                  |
| `Commands.cfg`                  | The code as written, all eight rules at once. TLC stops at the first broken rule it finds, which is `UncertainStaysBlocked` (finding 4). It is the config to give `/statechart`, which reports every broken rule with its shortest path. | `UncertainStaysBlocked` (first break) |
| `Lifecycle.cfg`                 | One command id, with a view that keeps the state count under the chart budget. Used only to draw `chart.mmd`; finding 4 shows in it, and so does the cancel that fixes finding 3.                                                        | `UncertainStaysBlocked` (first break) |

## The model and the code

Line numbers are `src/server/commands.ts` at the sync commit recorded in `.claude/skills/verify-commands/SKILL.md`.

One action of the model is one store transaction, or one stretch of work between two transactions in which the store is not touched.

### Actions

| Action                     | Code                                                                                             | What it stands for                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| -------------------------- | ------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `Init`                     | `createRun`, 364-366                                                                             | The run is stored at revision 1 with status `active`. No command, node or claim exists.                                                                                                                                                                                                                                                                                                                                                                                                        |
| `Admit(c)`                 | `execute`, admission transaction 758-972, the branch with no record for the id: 780-783, 885-971 | Run active and revision as expected (885-889); the step is not `uncertain`, `complete`, verified or exhausted (898-907); the command named on the step is not `running` (908-917); `tx.claim` on the run (934-938); command stored as `running`, the step's node record names the command (its `state` is kept, or left out when there was no record), and effect stored as `intent-persisted` (947-961). The run record is **not** written.                                                   |
| `CallHandler(c, r)`        | `execute`, 998-1037                                                                              | The handler call (998), its verification (1000-1011), the catch that turns a throw into `uncertain` (1012-1015) and the success criteria (1018-1037). Three awaits with no store access between them; a crash between them is `WorkerLost` after this action.                                                                                                                                                                                                                                  |
| `HandlerNotCalled(c)`      | `execute`, 995-997, 1012-1015                                                                    | Authorization is withdrawn or the call is aborted just before the handler. The result is `uncertain` and the handler was not called.                                                                                                                                                                                                                                                                                                                                                           |
| `WorkerLost(c)`            | process death; `execute`, 1038-1039 and 1044-1052                                                | The call ends without a commit. Nothing is written and the lease is not released.                                                                                                                                                                                                                                                                                                                                                                                                              |
| `Commit(c)`                | `execute`, commit transaction 1040-1199                                                          | `tx.assertFence` (1043); run active and revision as expected (1053-1057); node, naming the command (1062-1089), command (1090-1097), effect (1098-1103) and run (1104-1115) written together; lease released (1190).                                                                                                                                                                                                                                                                           |
| `CommitRefused(c)`         | `execute`, 1043 and 1053-1057                                                                    | The commit transaction throws `PersistenceConflict`. Nothing is written.                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `Takeover(c)`              | `execute`, admission transaction, 783-872                                                        | A call with an id whose record is `running`, in an active run (786), with a lease that can be claimed (788-797): command and effect become `uncertain` (807-816); the node is read first (803-806), and unless it is recorded complete and verified it becomes `uncertain` naming the command (817-827), whatever it was; the run revision moves (828-832), an outbox entry `reconciliation:<commandId>` with task `reconciliation-required` is stored (851-860), the lease is released (861). |
| (no action)                | `execute`, 874-883                                                                               | Every other call with a known id returns the stored state and changes nothing.                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `LeaseExpires`             | 60 s claims at 551, 792 and 937                                                                  | The database clock passes the claim's expiry.                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `CancelRun`                | `cancel`, 439-460; `settleInFlight`, 461-530                                                     | Lease released (447), status `cancelled`, revision moves (448-452). It does not look at the status first. In the same transaction (456-457) it reads the command named on the step (471-477); if that command is `running`, the command and its effect become `uncertain` (481-490), the step becomes `uncertain` naming the command unless it is recorded verified (491-501), and an outbox entry `reconciliation:<commandId>` with task `reconciliation-required` is stored (520-529).       |
| `RevalidateStart`          | `revalidate`, first transaction 534-554                                                          | Refused for a cancelled run (536-537); `tx.claim` on the run (548-552).                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `RevalidateFinish(reject)` | `revalidate`, 555-638                                                                            | The provider checks (555-596) and the last transaction (597-638): `tx.assertFence` (599), same revision and not cancelled (600-604). Only a verified step is asked for its own evidence (562); a step is also rejected when a step it depends on is (558-561). A rejected step that has a recorded state is rewritten as plain `failed` whatever it was, keeping the command named on it (615-629), the run becomes `active` (631-636), the lease is released (637).                           |
| `RevalidationAbandoned`    | `revalidate`, 568-569, 599-604, 606-614                                                          | The call dies, is denied or is refused. Nothing is written and its lease is not released.                                                                                                                                                                                                                                                                                                                                                                                                      |
| `Done`                     | none                                                                                             | Stutters in the declared ends, so that the deadlock check reports only dead ends.                                                                                                                                                                                                                                                                                                                                                                                                              |

### Variables

| Variable                                                             | Code                                                                                                                                                                                                                                                                                                                                                                                         |
| -------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `runStatus`                                                          | `RunRecord.status`, 53                                                                                                                                                                                                                                                                                                                                                                       |
| `runRev`                                                             | The revision of the run record, as `tx.put` returns it (`src/server/persistence/index.ts:223-243`).                                                                                                                                                                                                                                                                                          |
| `node`                                                               | The step's `NodeRecord`, 64-81, as one word. `complete` is `{state: "complete", verified: true}`; `waiting` is `awaiting-human` or `verifying`; `exhausted` is `failed` with `exhausted: true`; `pending` is no record, or a record with no `state` (written by admission for a step with no record). The service stores `verified: true` only with state `complete` (1000-1011, 1028-1035). |
| `holder`                                                             | `NodeRecord.command`, 76-80: the command admitted last for the step. `none` is no record or no such field.                                                                                                                                                                                                                                                                                   |
| `cmd[c]`                                                             | `CommandRecord.state`, 198-211, and the effect record's `status`, which is written in the same transactions: `running` goes with `intent-persisted`, every other state is the same word.                                                                                                                                                                                                     |
| `outbox`                                                             | The outbox entries `reconciliation:<commandId>`, 851-860.                                                                                                                                                                                                                                                                                                                                    |
| `lease`                                                              | The claim row of the run (`src/server/persistence/index.ts:276-302`): which party's claim is live. `free` is no row, a cancelled row or an expired one.                                                                                                                                                                                                                                      |
| `worker[c]`, `result[c]`                                             | The local state of the one `execute` call that was admitted for the id: the fence it holds (934-938) and the `OperationResult` it has (991-1037).                                                                                                                                                                                                                                            |
| `expRev[c]`                                                          | `command.expectedRevision`, checked at 887 and 1055.                                                                                                                                                                                                                                                                                                                                         |
| `reval`, `revalRev`                                                  | One `revalidate` call between its transactions, and `initial.run.revision` (601).                                                                                                                                                                                                                                                                                                            |
| `revalLeft`                                                          | A bound, not in the code.                                                                                                                                                                                                                                                                                                                                                                    |
| `calls`, `blind`, `rejected`, `reopened`, `superseded`, `lateCommit` | History, not in the code. They exist to state the rules and no action reads them to decide anything.                                                                                                                                                                                                                                                                                         |

### Switches

A switch set to `FALSE` is the code as written. The `.cfg` files turn them on.

| Switch                     | What it changes                                                                                   | Code                    |
| -------------------------- | ------------------------------------------------------------------------------------------------- | ----------------------- |
| `TakeoverRerunsHandler`    | Broken variant. The takeover admits a new worker for the command and does not record `uncertain`. | 798-872                 |
| `HandlerBeforeIntent`      | Broken variant. The command and effect records are not stored before the handler call.            | 947-961 moved after 998 |
| `SkipAssertFence`          | Broken variant. The commit does not call `tx.assertFence`.                                        | 1043 removed            |
| `AdmitIgnoresHolder`       | Broken variant. Admission does not read the command named on the step.                            | 908-917 removed         |
| `TakeoverIgnoresStep`      | Broken variant. The takeover writes the step `uncertain` without reading it.                      | 803-806 removed         |
| `CancelLeavesRunning`      | Broken variant. Cancel does not settle the command in flight.                                     | 456-457 removed         |
| `ReconcileInAnyRun`        | Sketch. The takeover does not require an active run.                                              | 786                     |
| `RevalidateKeepsUncertain` | Sketch. Revalidation leaves an `uncertain` step as it is.                                         | 615-629                 |

## Findings

Each path below is the shortest one TLC finds, told in the code's words. `conformance.test.ts` replays each one against the real service; the lease running out is done there by moving the claim's expiry, as `tests/command-crash-boundaries.test.ts` does.

### Finding 1, fixed: a second command id repeated the handler while the first call was unrecorded

Rule `OneCallPerStep`, config `FindingBlindRepeat.cfg`. The path was 5 steps: `first` is admitted; its handler is called; the worker does not come back and the lease runs out; `second` is admitted for the same step at the same revision; its handler is called while `first` is still `running`.

The admission transaction (758-972) wrote neither the node record nor the run record, so nothing on the step said a call was in flight, and the lease runs out. Now the same transaction names the command on the step's node record (947-961), and admission refuses a new id while the command named there is `running` (908-917), whether or not its lease is live. A revalidation keeps that name when it rewrites the step (615-629).

`tests/command-crash-boundaries.test.ts` AC-29 sends a new command id after the crash, before the crashed id is replayed, and asserts it is refused with no provider call.

The fix leaves the run revision and the step's `state` as they were, so the snapshot a caller reads while the first call is in flight still shows the same revision; a new id is refused rather than admitted.

### Finding 2, fixed: the takeover overwrote a step that another command completed

Rule `CompleteStaysVerified`, config `FindingOverwritten.cfg`. The path was 6 steps and needed finding 1: `first` is admitted; the lease runs out; `second` is admitted, called and commits `complete`; `first` is sent again and the takeover wrote the node as `uncertain` without looking at it.

With finding 1 fixed, `second` is not admitted while `first` is `running`, so the model no longer reaches that state. The takeover also reads the node first (803-806): a step recorded complete and verified is left as it is, while the command and its effect still become `uncertain` with a `reconciliation-required` entry. `BrokenTakeoverIgnoresStep.cfg` shows that this read is what keeps the rule when admission is broken.

### Finding 3, fixed: a command in flight when its run was cancelled stayed `running` for ever

The deadlock check, config `FindingDeadEnd.cfg`. The path was 3 steps: `first` is admitted; the worker dies (or returns later and its commit is refused at 1043 or 1053-1057); the run is cancelled. The command stayed `running` and its effect `intent-persisted`, and no call could change either: the takeover requires `run.status === "active"` (786), so every replay returned `running` (874-883), and no `reconciliation-required` entry was stored, although the handler may have run.

Now the cancel transaction settles the command named on each step (456-457, `settleInFlight` 461-530): a `running` command and its effect become `uncertain`, the step becomes `uncertain` unless it is recorded verified, and an outbox entry `reconciliation:<commandId>` with task `reconciliation-required` is stored. Every replay of the id then returns `uncertain`, and a late worker's commit is refused by its fence (1043) and by the run's status (1053-1057). This is what `docs/ceremony-teaching-threat-model.md:31` asks for: "A provider request may already have happened when cancellation or revocation wins; uncertain effects require reconciliation, not automatic replay." `BrokenCancelLeavesRunning.cfg` removes the settling and the dead end comes back on the same 3-step path.

### Finding 4: revalidation reopens an uncertain step

Rule `UncertainStaysBlocked`, config `FindingUnblocked.cfg`, 5 steps; carried on to the repeated call by `FindingReopenedRepeat.cfg`, 7 steps.

1. `first` is admitted.
2. The handler is called and throws. The catch makes the result `uncertain` (1012-1015).
3. The commit records the command as `uncertain` and the step as `uncertain` (1076-1097). A new command id is now refused (902).
4. `revalidate` starts and claims the run (534-554).
5. The provider no longer vouches for a step that this step depends on. The dependent step is added to `invalid` whatever its own state is (558-561), and the last transaction rewrites every invalid step that has a record as `{state: "failed", verified: false, outputs: {}}` (615-629). The step is now plain `failed`.
6. Once the earlier step is complete again, `second` is admitted for the step: the guard at 898-907 lets a `failed` step through.
7. The handler is called again, while `first` is still `uncertain`.

The same happens when the step became `uncertain` through a takeover; its `reconciliation-required` entry is then still pending when the handler runs again. The same rewrite also drops `exhausted` from a step that had no attempt left; no rule here checks that.

## Broken variants

Each rule that holds was seen to fail on a variant of the model with one check removed or one step moved.

| Config                          | Rule                           | The path TLC finds                                                                                                                                                                                                     |
| ------------------------------- | ------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `BrokenTakeoverReruns.cfg`      | `OneCallPerCommand`            | 6 steps. `first` is admitted; the handler is called; the worker dies; the lease runs out; `first` is sent again and a new worker starts for it; the handler is called a second time for the same id.                   |
| `BrokenHandlerBeforeIntent.cfg` | `EveryCallHasIntent`           | 2 steps. `first` is admitted with nothing stored; the handler is called. A crash now leaves no trace of the call.                                                                                                      |
| `BrokenNoAssertFence.cfg`       | `SupersededWorkerNeverCommits` | 5 steps. `first` is admitted; the handler is called; the lease runs out; a revalidation starts and takes the lease; `first` commits its result under the revalidation's lease, because the run revision has not moved. |
| `BrokenAdmitIgnoresHolder.cfg`  | `OneCallPerStep`               | 5 steps. Finding 1's path: `first` is admitted; the handler is called; the lease runs out; `second` is admitted; the handler is called again.                                                                          |
| `BrokenTakeoverIgnoresStep.cfg` | `CompleteStaysVerified`        | 6 steps. Finding 2's path. With admission broken but the takeover's read in place, the rule holds (61,976 states).                                                                                                     |
| `BrokenCancelLeavesRunning.cfg` | No dead end                    | 3 steps. Finding 3's path: `first` is admitted; the worker dies; the run is cancelled and the command stays `running`, with no step out.                                                                               |

The rules that are broken today fail on the code as written, and pass in `Sketch.cfg`. `NeverBlindRepeat` on the code as written is broken on finding 4's 7-step path (`FindingReopenedRepeat.cfg`), and on an 8-step path in which a revalidation reopens the `uncertain` step and the first id's superseded worker then calls the handler while `second` is `running`. Both start with a revalidation rewriting an `uncertain` step as `failed`, so `OneCallPerStep` leaves them out, and with the code as written it holds (9,052 states).

With admission's read of the step in place and only the takeover's read removed, `CompleteStaysVerified` still holds: no other command completes the step while the first is `running`. The takeover's read is checked in the model only with admission broken as well, and on the real code by the finding 2 test in `conformance.test.ts`, which writes the step complete directly.

## The sketch

`Sketch.cfg` turns on the two guards that remain sketches: the takeover does not require an active run; revalidation leaves an `uncertain` step alone. A third sketched guard, admission refusing a new id while another command for the step is `running`, is now the code (908-917). Finding 3 was fixed in `cancel`, not by the first sketch: since a cancel settles the command in flight, no command is `running` in a cancelled run, so the takeover's condition no longer matters, and `Sketch.cfg` explores the same 5,316 states with the first sketch off. With the second sketch, all eight rules hold and there is no dead end. With it off, finding 4 comes back.

The sketch shows that the rules can be met and that, within the bounds, the open finding is the only way the code breaks them. It is also what catches a new break of a rule that is already broken today. It is a model of two guards, not a reviewed design and not product code.

## Bounds and assumptions

Bounds: one run, one step, two command ids for that step, one cancel, one revalidation. `Holds.cfg` explores 9,052 states and `Sketch.cfg` 5,316. Run once by hand with three command ids (`Holds.cfg` 104,056 states, `Sketch.cfg` 45,328) and with two revalidations (56,398 and 20,414 states), `Holds.cfg` and `Sketch.cfg` gave the same answers.

Assumptions:

- Each `store.transaction` callback is atomic against every other transaction on the same run. SQLite runs one transaction at a time; on PostgreSQL every transaction here locks the run row first (`owned`, 369-378). `verification/persistence` covers that layer.
- `tx.claim` succeeds only when no claim is live, `tx.assertFence` only for the live claim it was given, and `tx.cancel` ends any claim (`src/server/persistence/index.ts:184-193, 276-302`).
- The steps this step depends on are complete whenever a command is sent for it (`resolveInputs`, 668-731, is not modelled).
- The handler, the verifier and the provider may answer anything at any time, and any call may die between two transactions.

## What is left out

- Commands for the other steps of the run. They share the run's lease and revision; the model only lets a commit say whether it was the last unverified step.
- What authorization decides. A denial appears only as a call that ends early.
- A known id sent with a different payload (784-785), the bindings and inputs, the content of success criteria, and the timing of `retryAt` (920-924). Whether a failed step has an attempt left is a free choice in the model.
- The `agent-wake` and `continuation` outbox entries, `deliverContinuations`, and the transition ledger.
- What happens to a `reconciliation-required` entry. Nothing in `src/` reads that task, so the model treats `uncertain` as an end.
- Whether the provider's own idempotency makes a repeated call harmless. The model counts handler calls, not provider effects.
- A command id that is lost. Since finding 1 was fixed, a step whose command is `running` refuses every other id until that id is sent again (AC-29, `tests/command-crash-boundaries.test.ts`). If the caller loses the id (an agent derives it from `toolCallId`, `agent/coordinator.ts:362`), only cancel is left, which records the command `uncertain` with a `reconciliation-required` entry: nothing else sweeps a `running` command, and the run's snapshot does not show `node.command`. The model hides this because its `Takeover(c)` is always enabled for the holder. That is the trade-off of refusing a second id; the way out of `uncertain` is W1.C4's.

Noticed while reading, not checked by a rule: `CommandRecord.state` declares `admitted` (202) and `CommandStatus.state` declares `cancelled` (217), and `execute` never produces either; a handler that throws leaves the step `uncertain` without a `reconciliation-required` entry, which only the takeover and a cancel write.

## The charts

- `chart.mmd`: the life of one command, from `Lifecycle.cfg`. A red state breaks a rule in every case: "Uncertain, but the step is open again" is finding 4. A cancel while the command is `running` leads to "Marked uncertain, reconciliation queued", the same state as the takeover; before finding 3 was fixed it led to "Stuck: on record as running, run cancelled", a dead end. The chart does not draw the steps that leave the command where it is (a revalidation that rejects nothing, a cancel after the command is recorded), and the view hides only the `Done` stutter.
- `findings.mmd`: the shortest path to each broken rule with two command ids, from `Commands.cfg`.

Both are drawn by the `/statechart` skill with `view.mjs`, which holds the words for states and steps.
