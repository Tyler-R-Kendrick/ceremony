# Protected command execution and recovery

A TLA+ model of the life of the commands sent for one step of one run, checked with TLC, and a test that ties the model to the real `ProtectedCommandService`.

**The property.** An external effect is never repeated blind: the handler of a step is called again only after the earlier call's outcome is on record and that record allows another attempt, and a command that was interrupted always ends on record as `uncertain`.

**The harm if it breaks.** A provider-side action that cannot be taken back (an app registered, an account created, a one-use code spent) happens twice, or happens once while the run's records say something else, and nobody is told to reconcile it.

**Result.** Three of the seven rules hold. Four are broken by the code as it is written today. Each of the four is replayed against the real code in `conformance.test.ts`. See [Findings](#findings).

## Run it

```sh
verification/commands/check.sh
```

It takes about 15 seconds. It needs Java 11 or later and the repo's `node_modules`. The first run downloads TLC 1.7.4 (pinned and checksummed in `verification/tlc.sh`).

The script runs every `.cfg` in this folder (twelve model checks) and the conformance test, and compares each result with what is expected today. It exits 0 only when every row matches. Today that means: the rules that hold still hold, the four findings are still present, and every broken variant is still caught.

To see the steps of one row, run that config alone:

```sh
verification/tlc.sh commands Commands FindingBlindRepeat
```

To read any result in plain words, or to redraw the charts, use the `/statechart` skill with `Commands.tla`, the config and `view.mjs`.

## Why TLA+ and TLC

The question is about order: which interleavings of a crash, a lease running out, a replay, a second command id, a cancel and a revalidation can end with the handler called twice or with a record that says the wrong thing. A model checker tries every order of those steps on a small model of the design. No verifier runs on this TypeScript, and the property is not about one function's inputs, so a tool that reads the code would not answer it.

TLC does not read `commands.ts`. `conformance.test.ts` is what ties the model to the code: Part 1 shows each fact the model takes from the code on the real service, and Part 2 replays each counterexample.

## The rules

| Rule                               | In plain words                                                                                                                                                                            | Code as written       |
| ---------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------- |
| `OneCallPerCommand`                | The handler is called at most once for one command id.                                                                                                                                    | holds                 |
| `EveryCallHasIntent`               | When the handler is called, the command and effect records are already stored.                                                                                                            | holds                 |
| `SupersededWorkerNeverCommits`     | A worker whose lease someone else has taken never records its result.                                                                                                                     | holds                 |
| `NeverBlindRepeat`                 | The handler is not called for a step that is recorded complete, or while another command's call for the step has an unknown outcome (that command is still `running`, or is `uncertain`). | **broken**, finding 1 |
| `CompleteStaysVerified`            | A command recorded `complete` has its step recorded complete and verified, unless a revalidation rejected the step later.                                                                 | **broken**, finding 2 |
| No dead end (TLC's deadlock check) | Every state has a step out unless every command record is in a state `execute` never changes again and no call is in flight.                                                              | **broken**, finding 3 |
| `UncertainStaysBlocked`            | While a command is recorded `uncertain`, its step is recorded `uncertain`, which is what keeps every new command out.                                                                     | **broken**, finding 4 |

## The configs

All configs use `Commands.tla`.

| Config                          | What it is                                                                                                                                                                                                        | Expected                              |
| ------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------- |
| `Holds.cfg`                     | The code as written, the three rules that hold.                                                                                                                                                                   | pass                                  |
| `FindingBlindRepeat.cfg`        | The code as written, `NeverBlindRepeat`.                                                                                                                                                                          | broken                                |
| `FindingOverwritten.cfg`        | The code as written, `CompleteStaysVerified`.                                                                                                                                                                     | broken                                |
| `FindingDeadEnd.cfg`            | The code as written, the deadlock check.                                                                                                                                                                          | deadlock                              |
| `FindingUnblocked.cfg`          | The code as written, `UncertainStaysBlocked`.                                                                                                                                                                     | broken                                |
| `FindingReopenedRepeat.cfg`     | Finding 4 carried on to the repeated handler call. Finding 1 gives a shorter path to the same rule and would hide this one, so this config turns on the sketched guard for finding 1.                             | broken                                |
| `BrokenTakeoverReruns.cfg`      | Broken variant: the takeover starts a new worker.                                                                                                                                                                 | `OneCallPerCommand` broken            |
| `BrokenHandlerBeforeIntent.cfg` | Broken variant: nothing is stored before the handler.                                                                                                                                                             | `EveryCallHasIntent` broken           |
| `BrokenNoAssertFence.cfg`       | Broken variant: the commit does not check its fence.                                                                                                                                                              | `SupersededWorkerNeverCommits` broken |
| `Sketch.cfg`                    | The code plus three sketched guards, all seven rules.                                                                                                                                                             | pass                                  |
| `Commands.cfg`                  | The code as written, all seven rules at once. TLC stops at the first broken rule it finds, which is the dead end. It is the config to give `/statechart`, which reports every broken rule with its shortest path. | deadlock (first break found)          |
| `Lifecycle.cfg`                 | One command id, with a view that keeps the state count under the chart budget. Used only to draw `chart.mmd`; findings 3 and 4 show in it.                                                                        | deadlock (first break found)          |

## The model and the code

Line numbers are `src/server/commands.ts` at the sync commit recorded in `.claude/skills/verify-commands/SKILL.md`.

One action of the model is one store transaction, or one stretch of work between two transactions in which the store is not touched.

### Actions

| Action                     | Code                                                                                             | What it stands for                                                                                                                                                                                                                                                                                                                                                                                                          |
| -------------------------- | ------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `Init`                     | `createRun`, 353-355                                                                             | The run is stored at revision 1 with status `active`. No command, node or claim exists.                                                                                                                                                                                                                                                                                                                                     |
| `Admit(c)`                 | `execute`, admission transaction 666-851, the branch with no record for the id: 688-691, 783-850 | Run active and revision as expected (783-787); the step is not `uncertain`, `complete`, verified or exhausted (796-805); `tx.claim` on the run (822-826); command stored as `running` and effect as `intent-persisted` (835-840). The node record and the run record are **not** written.                                                                                                                                   |
| `CallHandler(c, r)`        | `execute`, 877-916                                                                               | The handler call (877), its verification (879-890), the catch that turns a throw into `uncertain` (891-894) and the success criteria (897-916). Three awaits with no store access between them; a crash between them is `WorkerLost` after this action.                                                                                                                                                                     |
| `HandlerNotCalled(c)`      | `execute`, 874-876, 891-894                                                                      | Authorization is withdrawn or the call is aborted just before the handler. The result is `uncertain` and the handler was not called.                                                                                                                                                                                                                                                                                        |
| `WorkerLost(c)`            | process death; `execute`, 917-918 and 923-931                                                    | The call ends without a commit. Nothing is written and the lease is not released.                                                                                                                                                                                                                                                                                                                                           |
| `Commit(c)`                | `execute`, commit transaction 919-1077                                                           | `tx.assertFence` (922); run active and revision as expected (932-936); node (941-967), command (968-975), effect (976-981) and run (982-993) written together; lease released (1068).                                                                                                                                                                                                                                       |
| `CommitRefused(c)`         | `execute`, 922 and 932-936                                                                       | The commit transaction throws `PersistenceConflict`. Nothing is written.                                                                                                                                                                                                                                                                                                                                                    |
| `Takeover(c)`              | `execute`, admission transaction, 691-770                                                        | A call with an id whose record is `running`, in an active run (694), with a lease that can be claimed (696-705): command and effect become `uncertain` (712-721), the node becomes `uncertain` whatever it was (722-726), the run revision moves (727-731), an outbox entry `reconciliation:<commandId>` with task `reconciliation-required` is stored (749-758), the lease is released (759).                              |
| (no action)                | `execute`, 772-781                                                                               | Every other call with a known id returns the stored state and changes nothing.                                                                                                                                                                                                                                                                                                                                              |
| `LeaseExpires`             | 60 s claims at 465, 700 and 825                                                                  | The database clock passes the claim's expiry.                                                                                                                                                                                                                                                                                                                                                                               |
| `CancelRun`                | `cancel`, 428-442                                                                                | Lease released (436), status `cancelled`, revision moves (437-441). It does not look at the status first.                                                                                                                                                                                                                                                                                                                   |
| `RevalidateStart`          | `revalidate`, first transaction 448-468                                                          | Refused for a cancelled run (450-451); `tx.claim` on the run (462-466).                                                                                                                                                                                                                                                                                                                                                     |
| `RevalidateFinish(reject)` | `revalidate`, 469-546                                                                            | The provider checks (469-510) and the last transaction (511-546): `tx.assertFence` (513), same revision and not cancelled (514-518). Only a verified step is asked for its own evidence (476); a step is also rejected when a step it depends on is (472-475). A rejected step that has a record is rewritten as plain `failed` whatever it was (529-537), the run becomes `active` (539-544), the lease is released (545). |
| `RevalidationAbandoned`    | `revalidate`, 482-483, 513-518, 520-528                                                          | The call dies, is denied or is refused. Nothing is written and its lease is not released.                                                                                                                                                                                                                                                                                                                                   |
| `Done`                     | none                                                                                             | Stutters in the declared ends, so that the deadlock check reports only dead ends.                                                                                                                                                                                                                                                                                                                                           |

### Variables

| Variable                                                 | Code                                                                                                                                                                                                                                                                                                       |
| -------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `runStatus`                                              | `RunRecord.status`, 53                                                                                                                                                                                                                                                                                     |
| `runRev`                                                 | The revision of the run record, as `tx.put` returns it (`src/server/persistence/index.ts:223-243`).                                                                                                                                                                                                        |
| `node`                                                   | The step's `NodeRecord`, 64-75, as one word. `complete` is `{state: "complete", verified: true}`; `waiting` is `awaiting-human` or `verifying`; `exhausted` is `failed` with `exhausted: true`; `pending` is no record. The service stores `verified: true` only with state `complete` (879-890, 907-914). |
| `cmd[c]`                                                 | `CommandRecord.state`, 187-200, and the effect record's `status`, which is written in the same transactions: `running` goes with `intent-persisted`, every other state is the same word.                                                                                                                   |
| `outbox`                                                 | The outbox entries `reconciliation:<commandId>`, 749-758.                                                                                                                                                                                                                                                  |
| `lease`                                                  | The claim row of the run (`src/server/persistence/index.ts:276-302`): which party's claim is live. `free` is no row, a cancelled row or an expired one.                                                                                                                                                    |
| `worker[c]`, `result[c]`                                 | The local state of the one `execute` call that was admitted for the id: the fence it holds (822-826) and the `OperationResult` it has (870-916).                                                                                                                                                           |
| `expRev[c]`                                              | `command.expectedRevision`, checked at 785 and 934.                                                                                                                                                                                                                                                        |
| `reval`, `revalRev`                                      | One `revalidate` call between its transactions, and `initial.run.revision` (515).                                                                                                                                                                                                                          |
| `revalLeft`                                              | A bound, not in the code.                                                                                                                                                                                                                                                                                  |
| `calls`, `blind`, `rejected`, `superseded`, `lateCommit` | History, not in the code. They exist to state the rules and no action reads them to decide anything.                                                                                                                                                                                                       |

### Switches

A switch set to `FALSE` is the code as written. The `.cfg` files turn them on.

| Switch                     | What it changes                                                                                   | Code                             |
| -------------------------- | ------------------------------------------------------------------------------------------------- | -------------------------------- |
| `TakeoverRerunsHandler`    | Broken variant. The takeover admits a new worker for the command and does not record `uncertain`. | 706-770                          |
| `HandlerBeforeIntent`      | Broken variant. The command and effect records are not stored before the handler call.            | 835-840 moved after 877          |
| `SkipAssertFence`          | Broken variant. The commit does not call `tx.assertFence`.                                        | 922 removed                      |
| `RefuseOverUnresolved`     | Sketch. Admission refuses a new id while another command for the step is still `running`.         | would join the guards at 796-805 |
| `ReconcileInAnyRun`        | Sketch. The takeover does not require an active run.                                              | 694                              |
| `RevalidateKeepsUncertain` | Sketch. Revalidation leaves an `uncertain` step as it is.                                         | 529-537                          |

## Findings

Each path below is the shortest one TLC finds, told in the code's words. `conformance.test.ts` replays each one against the real service; the lease running out is done there by moving the claim's expiry, as `tests/command-crash-boundaries.test.ts` does.

### Finding 1: a second command id repeats the handler while the first call is unrecorded

Rule `NeverBlindRepeat`, config `FindingBlindRepeat.cfg`, 5 steps.

1. `execute` is called with command id `first`. The admission transaction (666-851) stores the command as `running` and the effect as `intent-persisted`, and claims the run for 60 s. It writes neither the node record nor the run record: the run is still at revision 1 and the step still reads `pending`.
2. The handler is called (877). The provider acts.
3. The worker does not come back (the process died, or the call hangs), and the lease runs out.
4. `execute` is called with command id `second` for the same step and the same `expectedRevision`. There is no record for `second` (688-691). The run is active at revision 1 (783-787). The step has no record, so the guard at 796-805 passes. The lease has expired, so `tx.claim` succeeds (822-826). `second` is admitted.
5. The handler is called again (877), while `first` is still `running` and nobody knows what its call did.

Why the code allows it: the only traces of a call in flight are the command record, which is keyed by its own id, and the lease, which runs out. Nothing on the step says a call is in flight. The guard at 796-805 keeps a new id out only once the step is `uncertain`, and only a replay of the same id writes that (694-770).

`tests/command-crash-boundaries.test.ts:365-383` asserts that a new command after a crash is denied, but it sends the crashed id first. In the other order the new command is admitted.

A caller cannot tell: the snapshot it reads between steps 3 and 4 shows the same revision and a `pending` step. The `ceremony_advance` tool tells a caller to reuse its id for a retry (`src/server/mcp.ts:313-317`); the finding is what happens when a caller does not.

### Finding 2: the takeover overwrites a step that another command completed

Rule `CompleteStaysVerified`, config `FindingOverwritten.cfg`, 6 steps. It needs finding 1.

1. `first` is admitted.
2. The lease runs out.
3. `second` is admitted, as in finding 1.
4. The handler is called for `second`.
5. `second` commits `complete` (919-1077): the step is complete and verified. Other steps remain, so the run stays active.
6. `first` is sent again. Its record is `running`, the run is active and the lease is free, so the takeover runs (694-770). It writes the node as `{state: "uncertain", verified: false, outputs: {}}` without looking at what is there (722-726).

After that `second` is on record as `complete` and a replay of it answers `complete, verified: true` (772-781), while the step is `uncertain` with its outputs gone. No new command is admitted for the step (800) and every step that depends on it is refused (588-589). Nothing in `commands.ts` moves the run on.

With the sketched guard for finding 1 alone, this rule holds in the model.

### Finding 3: a command in flight when its run is cancelled stays `running` for ever

The deadlock check, config `FindingDeadEnd.cfg`, 3 steps.

1. `first` is admitted.
2. The worker dies. (Or it returns later and its commit is refused at 922 or 932-936: the end is the same.)
3. The run is cancelled (428-442).

Now the command is `running` and its effect is `intent-persisted`, and no call can change either. The takeover requires `run.status === "active"` (694), so every replay returns `running` (772-781). No `reconciliation-required` entry is ever stored, although the handler may have run.

A command is stuck the same way without a cancel when a second command id completes the last step of the run (finding 1): the run is `complete`, the first command stays `running`, and only a revalidation that rejects a step would make the run active again.

`docs/ceremony-teaching-threat-model.md:31` says "A provider request may already have happened when cancellation or revocation wins; uncertain effects require reconciliation, not automatic replay." Nothing records that this effect is uncertain.

### Finding 4: revalidation reopens an uncertain step

Rule `UncertainStaysBlocked`, config `FindingUnblocked.cfg`, 5 steps; carried on to the repeated call by `FindingReopenedRepeat.cfg`, 7 steps.

1. `first` is admitted.
2. The handler is called and throws. The catch makes the result `uncertain` (891-894).
3. The commit records the command as `uncertain` and the step as `uncertain` (955-975). A new command id is now refused (800).
4. `revalidate` starts and claims the run (448-468).
5. The provider no longer vouches for a step that this step depends on. The dependent step is added to `invalid` whatever its own state is (472-475), and the last transaction rewrites every invalid step that has a record as `{state: "failed", verified: false, outputs: {}}` (529-537). The step is now plain `failed`.
6. Once the earlier step is complete again, `second` is admitted for the step: the guard at 796-805 lets a `failed` step through.
7. The handler is called again, while `first` is still `uncertain`.

The same happens when the step became `uncertain` through a takeover; its `reconciliation-required` entry is then still pending when the handler runs again. The same rewrite also drops `exhausted` from a step that had no attempt left; no rule here checks that.

## Broken variants

Each rule that holds was seen to fail on a variant of the model with one check removed or one step moved.

| Config                          | Rule                           | The path TLC finds                                                                                                                                                                                            |
| ------------------------------- | ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `BrokenTakeoverReruns.cfg`      | `OneCallPerCommand`            | 6 steps. `first` is admitted; the handler is called; the worker dies; the lease runs out; `first` is sent again and a new worker starts for it; the handler is called a second time for the same id.          |
| `BrokenHandlerBeforeIntent.cfg` | `EveryCallHasIntent`           | 2 steps. `first` is admitted with nothing stored; the handler is called. A crash now leaves no trace of the call.                                                                                             |
| `BrokenNoAssertFence.cfg`       | `SupersededWorkerNeverCommits` | 5 steps. `first` is admitted; the handler is called; the lease runs out; `second` is admitted and takes the lease; `first` commits its result under `second`'s lease, because the run revision has not moved. |

The rules that are broken today fail on the code as written, and pass in `Sketch.cfg`.

## The sketch

`Sketch.cfg` turns on three guards, one for each cause: admission refuses a new id while another command for the step is still `running`; the takeover does not require an active run; revalidation leaves an `uncertain` step alone. With all three, all seven rules hold and there is no dead end. With any one of them off, the matching finding comes back.

The sketch shows that the rules can be met and that, within the bounds, the four findings are the only ways the code breaks them. It is also what catches a new break of a rule that is already broken today. It is a model of three guards, not a reviewed design and not product code.

## Bounds and assumptions

Bounds: one run, one step, two command ids for that step, one cancel, one revalidation. `Holds.cfg` explores 50,668 states and `Sketch.cfg` 5,424. Run once by hand with three command ids (4,152,742 states) and with two revalidations (255,298 states), `Holds.cfg` and `Sketch.cfg` gave the same answers.

Assumptions:

- Each `store.transaction` callback is atomic against every other transaction on the same run. SQLite runs one transaction at a time; on PostgreSQL every transaction here locks the run row first (`owned`, 358-367). `verification/persistence` covers that layer.
- `tx.claim` succeeds only when no claim is live, `tx.assertFence` only for the live claim it was given, and `tx.cancel` ends any claim (`src/server/persistence/index.ts:184-193, 276-302`).
- The steps this step depends on are complete whenever a command is sent for it (`resolveInputs`, 576-639, is not modelled).
- The handler, the verifier and the provider may answer anything at any time, and any call may die between two transactions.

## What is left out

- Commands for the other steps of the run. They share the run's lease and revision; the model only lets a commit say whether it was the last unverified step.
- What authorization decides. A denial appears only as a call that ends early.
- A known id sent with a different payload (692-693), the bindings and inputs, the content of success criteria, and the timing of `retryAt` (808-812). Whether a failed step has an attempt left is a free choice in the model.
- The `agent-wake` and `continuation` outbox entries, `deliverContinuations`, and the transition ledger.
- What happens to a `reconciliation-required` entry. Nothing in `src/` reads that task, so the model treats `uncertain` as an end.
- Whether the provider's own idempotency makes a repeated call harmless. The model counts handler calls, not provider effects.

Noticed while reading, not checked by a rule: `CommandRecord.state` declares `admitted` (191) and `CommandStatus.state` declares `cancelled` (206), and `execute` never produces either; a handler that throws leaves the step `uncertain` without a `reconciliation-required` entry, which only the takeover writes.

## The charts

- `chart.mmd`: the life of one command, from `Lifecycle.cfg`. A red state breaks a rule in every case: "Uncertain, but the step is open again" is finding 4. An orange state breaks one in some cases: "Stuck: on record as running, run cancelled" is finding 3, and it is a dead end as soon as no revalidation call is still in flight. The chart does not draw the steps that leave the command where it is (a revalidation that rejects nothing, a cancel after the command is recorded), and the view hides only the `Done` stutter.
- `findings.mmd`: the shortest path to each broken rule with two command ids, from `Commands.cfg`.

Both are drawn by the `/statechart` skill with `view.mjs`, which holds the words for states and steps.
