# Protected command execution and recovery

A TLA+ model of the life of the commands sent for one step of one run, checked with TLC, and a test that ties the model to the real `ProtectedCommandService`.

**The property.** An external effect is never repeated blind: the handler of a step is called again only after the earlier call's outcome is on record and that record allows another attempt, and a command that was interrupted always ends on record as `uncertain`.

**The harm if it breaks.** A provider-side action that cannot be taken back (an app registered, an account created, a one-use code spent) happens twice, or happens once while the run's records say something else, and nobody is told to reconcile it.

**Result.** Four of the seven rules hold. Three are broken by two findings that are open in the code as it is written today: a dead end (finding 3), and `UncertainStaysBlocked` and `NeverBlindRepeat` (finding 4). Findings 1 and 2 are fixed. Each finding, open or fixed, is replayed against the real code in `conformance.test.ts`. See [Findings](#findings).

## Run it

```sh
verification/commands/check.sh
```

It takes about 15 seconds. It needs Java 11 or later and the repo's `node_modules`. The first run downloads TLC 1.7.4 (pinned and checksummed in `verification/tlc.sh`).

The script runs twelve of the `.cfg` files in this folder and the conformance test, and compares each result with what is expected today. It exits 0 only when every row matches. Today that means: the rules that hold still hold, findings 1 and 2 stay fixed, findings 3 and 4 are still present, and every broken variant it lists is still caught. `BrokenAdmitIgnoresHolder.cfg` and `BrokenTakeoverIgnoresStep.cfg` have no row in `check.sh` yet; run them alone (below).

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
| `CompleteStaysVerified`            | A command recorded `complete` has its step recorded complete and verified, unless a revalidation rejected the step later.                                                                 | holds (finding 2 fixed)                 |
| No dead end (TLC's deadlock check) | Every state has a step out unless every command record is in a state `execute` never changes again and no call is in flight.                                                              | **broken**, finding 3                   |
| `UncertainStaysBlocked`            | While a command is recorded `uncertain`, its step is recorded `uncertain`, which is what keeps every new command out.                                                                     | **broken**, finding 4                   |

## The configs

All configs use `Commands.tla`.

| Config                          | What it is                                                                                                                                                                                                        | Expected                              |
| ------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------- |
| `Holds.cfg`                     | The code as written, the four rules that hold.                                                                                                                                                                    | pass                                  |
| `FindingBlindRepeat.cfg`        | Finding 1, fixed: the code as written, `NeverBlindRepeat`. Finding 4 reaches the same rule on a longer path and would hide this check, so this config turns on the sketched guard for finding 4.                  | pass                                  |
| `FindingOverwritten.cfg`        | Finding 2, fixed: the code as written, `CompleteStaysVerified`.                                                                                                                                                   | pass                                  |
| `FindingDeadEnd.cfg`            | The code as written, the deadlock check.                                                                                                                                                                          | deadlock                              |
| `FindingUnblocked.cfg`          | The code as written, `UncertainStaysBlocked`.                                                                                                                                                                     | broken                                |
| `FindingReopenedRepeat.cfg`     | Finding 4 carried on to the repeated handler call, with the code as written.                                                                                                                                      | broken                                |
| `BrokenTakeoverReruns.cfg`      | Broken variant: the takeover starts a new worker.                                                                                                                                                                 | `OneCallPerCommand` broken            |
| `BrokenHandlerBeforeIntent.cfg` | Broken variant: nothing is stored before the handler.                                                                                                                                                             | `EveryCallHasIntent` broken           |
| `BrokenNoAssertFence.cfg`       | Broken variant: the commit does not check its fence.                                                                                                                                                              | `SupersededWorkerNeverCommits` broken |
| `BrokenAdmitIgnoresHolder.cfg`  | Broken variant: admission does not read the command named on the step. Not in `check.sh`.                                                                                                                         | `NeverBlindRepeat` broken             |
| `BrokenTakeoverIgnoresStep.cfg` | Broken variant: admission does not read the command named on the step, and the takeover writes the step without reading it. Not in `check.sh`.                                                                    | `CompleteStaysVerified` broken        |
| `Sketch.cfg`                    | The code plus the two sketched guards that remain, all seven rules.                                                                                                                                               | pass                                  |
| `Commands.cfg`                  | The code as written, all seven rules at once. TLC stops at the first broken rule it finds, which is the dead end. It is the config to give `/statechart`, which reports every broken rule with its shortest path. | deadlock (first break found)          |
| `Lifecycle.cfg`                 | One command id, with a view that keeps the state count under the chart budget. Used only to draw `chart.mmd`; findings 3 and 4 show in it.                                                                        | deadlock (first break found)          |

## The model and the code

Line numbers are `src/server/commands.ts` at the sync commit recorded in `.claude/skills/verify-commands/SKILL.md`.

One action of the model is one store transaction, or one stretch of work between two transactions in which the store is not touched.

### Actions

| Action                     | Code                                                                                             | What it stands for                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| -------------------------- | ------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `Init`                     | `createRun`, 364-366                                                                             | The run is stored at revision 1 with status `active`. No command, node or claim exists.                                                                                                                                                                                                                                                                                                                                                                                                        |
| `Admit(c)`                 | `execute`, admission transaction 683-897, the branch with no record for the id: 705-708, 810-896 | Run active and revision as expected (810-814); the step is not `uncertain`, `complete`, verified or exhausted (823-832); the command named on the step is not `running` (833-842); `tx.claim` on the run (859-863); command stored as `running`, the step's node record names the command (its `state` is kept, or left out when there was no record), and effect stored as `intent-persisted` (872-886). The run record is **not** written.                                                   |
| `CallHandler(c, r)`        | `execute`, 923-962                                                                               | The handler call (923), its verification (925-936), the catch that turns a throw into `uncertain` (937-940) and the success criteria (943-962). Three awaits with no store access between them; a crash between them is `WorkerLost` after this action.                                                                                                                                                                                                                                        |
| `HandlerNotCalled(c)`      | `execute`, 920-922, 937-940                                                                      | Authorization is withdrawn or the call is aborted just before the handler. The result is `uncertain` and the handler was not called.                                                                                                                                                                                                                                                                                                                                                           |
| `WorkerLost(c)`            | process death; `execute`, 963-964 and 969-977                                                    | The call ends without a commit. Nothing is written and the lease is not released.                                                                                                                                                                                                                                                                                                                                                                                                              |
| `Commit(c)`                | `execute`, commit transaction 965-1124                                                           | `tx.assertFence` (968); run active and revision as expected (978-982); node, naming the command (987-1014), command (1015-1022), effect (1023-1028) and run (1029-1040) written together; lease released (1115).                                                                                                                                                                                                                                                                               |
| `CommitRefused(c)`         | `execute`, 968 and 978-982                                                                       | The commit transaction throws `PersistenceConflict`. Nothing is written.                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `Takeover(c)`              | `execute`, admission transaction, 708-797                                                        | A call with an id whose record is `running`, in an active run (711), with a lease that can be claimed (713-722): command and effect become `uncertain` (732-741); the node is read first (728-731), and unless it is recorded complete and verified it becomes `uncertain` naming the command (742-752), whatever it was; the run revision moves (753-757), an outbox entry `reconciliation:<commandId>` with task `reconciliation-required` is stored (776-785), the lease is released (786). |
| (no action)                | `execute`, 799-808                                                                               | Every other call with a known id returns the stored state and changes nothing.                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `LeaseExpires`             | 60 s claims at 476, 717 and 862                                                                  | The database clock passes the claim's expiry.                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `CancelRun`                | `cancel`, 439-453                                                                                | Lease released (447), status `cancelled`, revision moves (448-452). It does not look at the status first.                                                                                                                                                                                                                                                                                                                                                                                      |
| `RevalidateStart`          | `revalidate`, first transaction 459-479                                                          | Refused for a cancelled run (461-462); `tx.claim` on the run (473-477).                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `RevalidateFinish(reject)` | `revalidate`, 480-563                                                                            | The provider checks (480-521) and the last transaction (522-563): `tx.assertFence` (524), same revision and not cancelled (525-529). Only a verified step is asked for its own evidence (487); a step is also rejected when a step it depends on is (483-486). A rejected step that has a recorded state is rewritten as plain `failed` whatever it was, keeping the command named on it (540-554), the run becomes `active` (556-561), the lease is released (562).                           |
| `RevalidationAbandoned`    | `revalidate`, 493-494, 524-529, 531-539                                                          | The call dies, is denied or is refused. Nothing is written and its lease is not released.                                                                                                                                                                                                                                                                                                                                                                                                      |
| `Done`                     | none                                                                                             | Stutters in the declared ends, so that the deadlock check reports only dead ends.                                                                                                                                                                                                                                                                                                                                                                                                              |

### Variables

| Variable                                                 | Code                                                                                                                                                                                                                                                                                                                                                                                     |
| -------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `runStatus`                                              | `RunRecord.status`, 53                                                                                                                                                                                                                                                                                                                                                                   |
| `runRev`                                                 | The revision of the run record, as `tx.put` returns it (`src/server/persistence/index.ts:223-243`).                                                                                                                                                                                                                                                                                      |
| `node`                                                   | The step's `NodeRecord`, 64-81, as one word. `complete` is `{state: "complete", verified: true}`; `waiting` is `awaiting-human` or `verifying`; `exhausted` is `failed` with `exhausted: true`; `pending` is no record, or a record with no `state` (written by admission for a step with no record). The service stores `verified: true` only with state `complete` (925-936, 953-960). |
| `holder`                                                 | `NodeRecord.command`, 76-80: the command admitted last for the step. `none` is no record or no such field.                                                                                                                                                                                                                                                                               |
| `cmd[c]`                                                 | `CommandRecord.state`, 198-211, and the effect record's `status`, which is written in the same transactions: `running` goes with `intent-persisted`, every other state is the same word.                                                                                                                                                                                                 |
| `outbox`                                                 | The outbox entries `reconciliation:<commandId>`, 776-785.                                                                                                                                                                                                                                                                                                                                |
| `lease`                                                  | The claim row of the run (`src/server/persistence/index.ts:276-302`): which party's claim is live. `free` is no row, a cancelled row or an expired one.                                                                                                                                                                                                                                  |
| `worker[c]`, `result[c]`                                 | The local state of the one `execute` call that was admitted for the id: the fence it holds (859-863) and the `OperationResult` it has (916-962).                                                                                                                                                                                                                                         |
| `expRev[c]`                                              | `command.expectedRevision`, checked at 812 and 980.                                                                                                                                                                                                                                                                                                                                      |
| `reval`, `revalRev`                                      | One `revalidate` call between its transactions, and `initial.run.revision` (526).                                                                                                                                                                                                                                                                                                        |
| `revalLeft`                                              | A bound, not in the code.                                                                                                                                                                                                                                                                                                                                                                |
| `calls`, `blind`, `rejected`, `superseded`, `lateCommit` | History, not in the code. They exist to state the rules and no action reads them to decide anything.                                                                                                                                                                                                                                                                                     |

### Switches

A switch set to `FALSE` is the code as written. The `.cfg` files turn them on.

| Switch                     | What it changes                                                                                   | Code                    |
| -------------------------- | ------------------------------------------------------------------------------------------------- | ----------------------- |
| `TakeoverRerunsHandler`    | Broken variant. The takeover admits a new worker for the command and does not record `uncertain`. | 723-797                 |
| `HandlerBeforeIntent`      | Broken variant. The command and effect records are not stored before the handler call.            | 872-886 moved after 923 |
| `SkipAssertFence`          | Broken variant. The commit does not call `tx.assertFence`.                                        | 968 removed             |
| `AdmitIgnoresHolder`       | Broken variant. Admission does not read the command named on the step.                            | 833-842 removed         |
| `TakeoverIgnoresStep`      | Broken variant. The takeover writes the step `uncertain` without reading it.                      | 728-731 removed         |
| `ReconcileInAnyRun`        | Sketch. The takeover does not require an active run.                                              | 711                     |
| `RevalidateKeepsUncertain` | Sketch. Revalidation leaves an `uncertain` step as it is.                                         | 540-554                 |

## Findings

Each path below is the shortest one TLC finds, told in the code's words. `conformance.test.ts` replays each one against the real service; the lease running out is done there by moving the claim's expiry, as `tests/command-crash-boundaries.test.ts` does.

### Finding 1, fixed: a second command id repeated the handler while the first call was unrecorded

Rule `NeverBlindRepeat`, config `FindingBlindRepeat.cfg`. The path was 5 steps: `first` is admitted; its handler is called; the worker does not come back and the lease runs out; `second` is admitted for the same step at the same revision; its handler is called while `first` is still `running`.

The admission transaction (683-897) wrote neither the node record nor the run record, so nothing on the step said a call was in flight, and the lease runs out. Now the same transaction names the command on the step's node record (872-886), and admission refuses a new id while the command named there is `running` (833-842), whether or not its lease is live. A revalidation keeps that name when it rewrites the step (540-554).

`tests/command-crash-boundaries.test.ts` AC-29 sends a new command id after the crash, before the crashed id is replayed, and asserts it is refused with no provider call.

The fix leaves the run revision and the step's `state` as they were, so the snapshot a caller reads while the first call is in flight still shows the same revision; a new id is refused rather than admitted.

### Finding 2, fixed: the takeover overwrote a step that another command completed

Rule `CompleteStaysVerified`, config `FindingOverwritten.cfg`. The path was 6 steps and needed finding 1: `first` is admitted; the lease runs out; `second` is admitted, called and commits `complete`; `first` is sent again and the takeover wrote the node as `uncertain` without looking at it.

With finding 1 fixed, `second` is not admitted while `first` is `running`, so the model no longer reaches that state. The takeover also reads the node first (728-731): a step recorded complete and verified is left as it is, while the command and its effect still become `uncertain` with a `reconciliation-required` entry. `BrokenTakeoverIgnoresStep.cfg` shows that this read is what keeps the rule when admission is broken.

### Finding 3: a command in flight when its run is cancelled stays `running` for ever

The deadlock check, config `FindingDeadEnd.cfg`, 3 steps.

1. `first` is admitted.
2. The worker dies. (Or it returns later and its commit is refused at 968 or 978-982: the end is the same.)
3. The run is cancelled (439-453).

Now the command is `running` and its effect is `intent-persisted`, and no call can change either. The takeover requires `run.status === "active"` (711), so every replay returns `running` (799-808). No `reconciliation-required` entry is ever stored, although the handler may have run.

`docs/ceremony-teaching-threat-model.md:31` says "A provider request may already have happened when cancellation or revocation wins; uncertain effects require reconciliation, not automatic replay." Nothing records that this effect is uncertain.

### Finding 4: revalidation reopens an uncertain step

Rule `UncertainStaysBlocked`, config `FindingUnblocked.cfg`, 5 steps; carried on to the repeated call by `FindingReopenedRepeat.cfg`, 7 steps.

1. `first` is admitted.
2. The handler is called and throws. The catch makes the result `uncertain` (937-940).
3. The commit records the command as `uncertain` and the step as `uncertain` (1001-1022). A new command id is now refused (827).
4. `revalidate` starts and claims the run (459-479).
5. The provider no longer vouches for a step that this step depends on. The dependent step is added to `invalid` whatever its own state is (483-486), and the last transaction rewrites every invalid step that has a record as `{state: "failed", verified: false, outputs: {}}` (540-554). The step is now plain `failed`.
6. Once the earlier step is complete again, `second` is admitted for the step: the guard at 823-832 lets a `failed` step through.
7. The handler is called again, while `first` is still `uncertain`.

The same happens when the step became `uncertain` through a takeover; its `reconciliation-required` entry is then still pending when the handler runs again. The same rewrite also drops `exhausted` from a step that had no attempt left; no rule here checks that.

## Broken variants

Each rule that holds was seen to fail on a variant of the model with one check removed or one step moved.

| Config                          | Rule                           | The path TLC finds                                                                                                                                                                                                     |
| ------------------------------- | ------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `BrokenTakeoverReruns.cfg`      | `OneCallPerCommand`            | 6 steps. `first` is admitted; the handler is called; the worker dies; the lease runs out; `first` is sent again and a new worker starts for it; the handler is called a second time for the same id.                   |
| `BrokenHandlerBeforeIntent.cfg` | `EveryCallHasIntent`           | 2 steps. `first` is admitted with nothing stored; the handler is called. A crash now leaves no trace of the call.                                                                                                      |
| `BrokenNoAssertFence.cfg`       | `SupersededWorkerNeverCommits` | 5 steps. `first` is admitted; the handler is called; the lease runs out; a revalidation starts and takes the lease; `first` commits its result under the revalidation's lease, because the run revision has not moved. |
| `BrokenAdmitIgnoresHolder.cfg`  | `NeverBlindRepeat`             | 5 steps. Finding 1's path: `first` is admitted; the handler is called; the lease runs out; `second` is admitted; the handler is called again.                                                                          |
| `BrokenTakeoverIgnoresStep.cfg` | `CompleteStaysVerified`        | 6 steps. Finding 2's path. With admission broken but the takeover's read in place, the rule holds (62,732 states).                                                                                                     |

The rules that are broken today fail on the code as written, and pass in `Sketch.cfg`. With the code as written and the sketched guard for finding 4 off, `FindingBlindRepeat.cfg` reports `NeverBlindRepeat` on finding 4's 7-step path.

## The sketch

`Sketch.cfg` turns on the two guards that remain sketches, one for each open finding: the takeover does not require an active run; revalidation leaves an `uncertain` step alone. A third sketched guard, admission refusing a new id while another command for the step is `running`, is now the code (833-842), and `Sketch.cfg` explores the same 5,424 states as it did with that guard sketched. With both sketches, all seven rules hold and there is no dead end. With either one off, the matching finding comes back.

The sketch shows that the rules can be met and that, within the bounds, the two open findings are the only ways the code breaks them. It is also what catches a new break of a rule that is already broken today. It is a model of two guards, not a reviewed design and not product code.

## Bounds and assumptions

Bounds: one run, one step, two command ids for that step, one cancel, one revalidation. `Holds.cfg` explores 9,160 states and `Sketch.cfg` 5,424. Run once by hand with three command ids (`Holds.cfg` 104,758 states, `Sketch.cfg` 46,030) and with two revalidations (57,874 and 21,170 states), `Holds.cfg` and `Sketch.cfg` gave the same answers.

Assumptions:

- Each `store.transaction` callback is atomic against every other transaction on the same run. SQLite runs one transaction at a time; on PostgreSQL every transaction here locks the run row first (`owned`, 369-378). `verification/persistence` covers that layer.
- `tx.claim` succeeds only when no claim is live, `tx.assertFence` only for the live claim it was given, and `tx.cancel` ends any claim (`src/server/persistence/index.ts:184-193, 276-302`).
- The steps this step depends on are complete whenever a command is sent for it (`resolveInputs`, 593-656, is not modelled).
- The handler, the verifier and the provider may answer anything at any time, and any call may die between two transactions.

## What is left out

- Commands for the other steps of the run. They share the run's lease and revision; the model only lets a commit say whether it was the last unverified step.
- What authorization decides. A denial appears only as a call that ends early.
- A known id sent with a different payload (709-710), the bindings and inputs, the content of success criteria, and the timing of `retryAt` (845-849). Whether a failed step has an attempt left is a free choice in the model.
- The `agent-wake` and `continuation` outbox entries, `deliverContinuations`, and the transition ledger.
- What happens to a `reconciliation-required` entry. Nothing in `src/` reads that task, so the model treats `uncertain` as an end.
- Whether the provider's own idempotency makes a repeated call harmless. The model counts handler calls, not provider effects.

Noticed while reading, not checked by a rule: `CommandRecord.state` declares `admitted` (202) and `CommandStatus.state` declares `cancelled` (217), and `execute` never produces either; a handler that throws leaves the step `uncertain` without a `reconciliation-required` entry, which only the takeover writes.

## The charts

- `chart.mmd`: the life of one command, from `Lifecycle.cfg`. A red state breaks a rule in every case: "Uncertain, but the step is open again" is finding 4. An orange state breaks one in some cases: "Stuck: on record as running, run cancelled" is finding 3, and it is a dead end as soon as no revalidation call is still in flight. The chart does not draw the steps that leave the command where it is (a revalidation that rejects nothing, a cancel after the command is recorded), and the view hides only the `Done` stutter.
- `findings.mmd`: the shortest path to each broken rule with two command ids, from `Commands.cfg`.

Both are drawn by the `/statechart` skill with `view.mjs`, which holds the words for states and steps.
