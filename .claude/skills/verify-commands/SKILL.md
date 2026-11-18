---
name: verify-commands
description: "Check a change to protected command execution and recovery (src/server/commands.ts: execute, advance, cancel, revalidate) against its TLA+ model and conformance test. Use when a change touches admission, the handler call, the commit, the takeover of a `running` command, the run lease or fence, cancellation or revalidation, or adds a state to a run, node or command record."
---

# Verify protected command execution

`verification/commands/` holds a TLA+ model of the commands sent for one step of one run, and a test that ties the model to the real `ProtectedCommandService`. You are probably here in the middle of a change. This skill tells you whether the change matters to the model, how to run the check, how to read a mismatch, and how to bring the model along when the change is meant.

**The property.** An external effect is never repeated blind: the handler of a step is called again only after the earlier call's outcome is on record and that record allows another attempt, and a command that was interrupted always ends on record as `uncertain`.

**The harm if it breaks.** A provider-side action that cannot be taken back happens twice, or happens once while the run's records say something else, and nobody is told to reconcile it.

**Where it stands.** Six of the eight rules hold, the deadlock check among them. Two are broken by the code as written at the sync commit, through one open finding (4) described in `verification/commands/README.md`. Findings 1, 2 and 3 are fixed: admission refuses a new command id while the command named on the step is `running`; the takeover leaves a step recorded complete and verified as it is; and a cancel records the command in flight `uncertain`, with its effect, the step (unless verified) and a `reconciliation-required` entry. A passing check therefore means "nothing moved": the six rules hold, findings 1, 2 and 3 stay fixed, finding 4 is still there, and every broken variant is still caught. Do not fix a finding, and do not change product code to make the check pass, unless the user asked for that.

## Does your change touch it

Yes, if it changes any of these in `src/server/commands.ts`:

- `ProtectedCommandService.execute`: the admission transaction, the handler call and what surrounds it, the commit transaction, or the branch for a command id that already has a record (the replay and the takeover).
- `ProtectedCommandService.advance`, `cancel` or `revalidate`.
- The types `RunRecord`, `NodeRecord`, `CommandRecord` or `CommandStatus`: a new state, a new field that admission reads, or a new writer of one of these records anywhere in `src/`.
- Which records a transaction writes, or where a transaction begins and ends. The model's steps are the code's transactions. Moving a write from one transaction to another changes the model even when no line of logic changes.

Also yes, if it changes what `tx.claim`, `tx.assertFence` or `tx.cancel` promise in `src/server/persistence/index.ts`, or `OperationResult["state"]` in `src/server/recipes/registry.ts`.

No, if it only touches `admits`, `createRun`'s plan validation, `resolveInputs`, `snapshot`, `deliverContinuations`, the content of success criteria in `src/server/recipes/outcome.ts`, or the wording of errors. The model leaves those out.

To see whether the covered code moved since the model was last confirmed against it:

```sh
git diff --stat 1538faf3c9bb151140ba57f8bd8f64c4e2b7f0c6 -- src/server/commands.ts src/server/recipes/registry.ts src/server/persistence/index.ts
```

If that prints a change that nobody carried into the model, the model may no longer describe the code. Read the diff against the table in the README before you trust a pass.

## Run it

From the repo root:

```sh
verification/commands/check.sh
```

About 15 seconds. It needs Java 11 or later and `node_modules`; the first run downloads the pinned TLC 1.7.4. It prints one row for each model check and one for `conformance.test.ts`, with what was expected and what came out, and exits 0 only when every row matches.

The model does not read the TypeScript. Two things connect them:

- `verification/commands/conformance.test.ts`, Part 1, shows each fact the model takes from the code on the real service (one test for each guard and write). It fails when the code stops doing what the model says.
- You. When the code changes on purpose, you change the model to match, and then the model tells you which rule the change costs.

## Read a mismatch

| What you see                                                                                                                                  | What it means                                                                                                       | What to do                                                                                                                                                      |
| --------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `conformance.test.ts` fails in a test named after a model action (`Admit:`, `Replay:`, `CallHandler:`, `Commit:`, `Takeover:`, `Revalidate:`) | The code no longer does something the model relies on.                                                              | If you did not mean to change that behaviour, it is a bug in your change. If you did, carry the change into the model (next section) and see which rule breaks. |
| `conformance.test.ts` fails in a test named `finding N`                                                                                       | The code no longer follows the path of that finding. Most likely the finding is fixed, or its path moved.           | Carry the change into the model. See "When a finding is fixed".                                                                                                 |
| `Holds` or `Sketch` reports a rule name or `Deadlock`                                                                                         | After your edit to the model, a rule that held is broken. This is the model telling you what the code change costs. | Treat it as a real bug until you have shown it is a modelling error (below).                                                                                    |
| A `Finding…` row reports `pass`                                                                                                               | The model no longer contains that finding.                                                                          | See "When a finding is fixed".                                                                                                                                  |
| A `Finding…` row reports a different rule                                                                                                     | Your model edit broke another rule on a shorter path.                                                               | Run that config alone and read the path.                                                                                                                        |
| A `Broken…` row reports `pass`                                                                                                                | The model can no longer see that kind of break: the rule or the switch stopped biting.                              | A modelling error. Fix the model, never the expectation.                                                                                                        |
| `TOOL-ERROR`                                                                                                                                  | TLC could not parse or run the spec. The script prints the end of TLC's output.                                     | Fix the TLA+.                                                                                                                                                   |

To see the steps behind a model row, run that config alone, for example `verification/tlc.sh commands Commands Sketch`. Then read the result with the `/statechart` skill: give it `Commands.tla`, the config and `view.mjs` from `verification/commands/`. It tells each broken rule as its shortest path in plain words, and when the check passes it draws the chart. Read every result that way before you decide what it means.

### A real bug or a modelling error

A path from TLC is a claim about the code. Check the claim:

1. Take the path one step at a time. For each step, open the lines the README's action table gives for that action and confirm that the code can do that step from that state, in one transaction, with those writes and no others.
2. If every step stands, replay it: add a test to `conformance.test.ts` that makes one call for each step (the tests named `finding N` show how, including how the lease is made to run out). If the real service follows the path, the bug is real. Report it with the path in the code's words. Do not weaken the rule or the model to make it go away.
3. If a step does not stand, the model is wrong at that action. Fix the action so that it says what the code does, run the check again, and say in your report what you corrected. A step the code cannot take is the only reason to call a path a modelling error.

## When the change is meant

1. Find the action in `verification/commands/Commands.tla` that stands for the code you changed. The action table in the README maps each action to its lines.
2. Change the action to say what the code now does. Keep one action for one transaction: if you split a transaction, split the action; if you move a write into another transaction, move it in the model. If you add a state to a record, add it to `NodeStates`, `Results` or `CmdStates` and decide, from the code, what admission and the takeover do with it.
3. Change or add the Part 1 test in `conformance.test.ts` that shows the new behaviour on the real service.
4. If you added a guard that a rule depends on, add a broken variant for it: a `CONSTANT` switch that removes the guard, a `Broken….cfg` that turns it on, and a row in `check.sh` naming the rule it must break. Run it and see it fail. A guard nobody has seen fail proves nothing.
5. Add the new switch to every `.cfg` (TLC refuses a config that leaves a constant out).
6. Run `verification/commands/check.sh` until every row matches for a reason you can state.
7. Redraw the charts with `/statechart`: `chart.mmd` comes from `Lifecycle.cfg` and `findings.mmd` from `Commands.cfg`, both with `view.mjs`. If you changed a state or an action, give it words in `view.mjs` first.
8. Update the README (the action table's line numbers, the rules, the findings) and the two records at the end of this file.

### When a finding is fixed

Only when the user asked for the fix. The two sketch switches in the model (`ReconcileInAnyRun`, `RevalidateKeepsUncertain`) stood for the guards findings 3 and 4 point at. A third, `RefuseOverUnresolved`, became the code for finding 1 and was deleted. Finding 3 was fixed in `cancel` instead of by `ReconcileInAnyRun`, which now changes nothing for the code as written. They are a starting point, not the fix: model what the code really does now.

1. Make the model say what the code does. If the fix is the sketched guard, make that guard unconditional and delete its switch from the spec and every `.cfg`.
2. The finding's rule now holds for the code as written: move it into `Holds.cfg`, delete the finding's `.cfg` and its row in `check.sh`.
3. Turn the finding's test in `conformance.test.ts` into a Part 1 test that asserts the new behaviour.
4. Add a broken variant that removes the new guard and breaks the rule (step 4 above).
5. Take the finding out of the README and out of "Where it stands" above.

## Coverage record

| Check                                                                                                                                          | What it covers                                                                                                                                                                                                       |
| ---------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `Holds.cfg`: `OneCallPerCommand`, `EveryCallHasIntent`, `SupersededWorkerNeverCommits`, `OneCallPerStep`, `CompleteStaysVerified`, no dead end | `src/server/commands.ts`: `execute` (admission, handler call, commit, replay and takeover), `cancel`, `revalidate`                                                                                                   |
| `FindingBlindRepeat.cfg`: `OneCallPerStep`                                                                                                     | `execute`: admission and its guards, including the command named on the step, the handler call. Finding 1, fixed                                                                                                     |
| `FindingOverwritten.cfg`: `CompleteStaysVerified`                                                                                              | `execute`: commit and takeover, including the takeover's read of the step. Finding 2, fixed                                                                                                                          |
| `FindingDeadEnd.cfg`: no dead end                                                                                                              | `execute`: replay and takeover; `cancel`, including its settling of the command in flight. Finding 3, fixed                                                                                                          |
| `FindingUnblocked.cfg`, `FindingReopenedRepeat.cfg`: `UncertainStaysBlocked`, `NeverBlindRepeat`                                               | `revalidate`; `execute`: admission                                                                                                                                                                                   |
| `BrokenTakeoverReruns.cfg`, `BrokenHandlerBeforeIntent.cfg`, `BrokenNoAssertFence.cfg`                                                         | That the three rules that held before finding 1 was fixed can fail: the takeover branch, the order of intent and handler, the fence check in the commit                                                              |
| `BrokenAdmitIgnoresHolder.cfg`, `BrokenTakeoverIgnoresStep.cfg`, `BrokenCancelLeavesRunning.cfg`                                               | That the guards for findings 1, 2 and 3 bite: admission's read of the command named on the step, the takeover's read of the step, and the cancel's settling of the command in flight                                 |
| `Sketch.cfg`: all eight rules                                                                                                                  | The same code with the two remaining sketched guards. It is what catches a new break of a rule that is already broken today.                                                                                         |
| `Commands.cfg`, `Lifecycle.cfg`                                                                                                                | The configs `/statechart` reads: every rule at once with two command ids, and one command id for `chart.mmd`. `check.sh` runs them so that they keep parsing; TLC stops at the first break, `UncertainStaysBlocked`. |
| `conformance.test.ts`                                                                                                                          | `ProtectedCommandService.execute`, `advance`, `cancel`, `revalidate` and `snapshot` on `SQLiteCeremonyStore`; types `NodeRecord`, `CommandRecord` as stored                                                          |

Relied on, not checked here: `tx.claim`, `tx.assertFence`, `tx.cancel` and transaction isolation in `src/server/persistence/index.ts` (see `verification/persistence`); `OperationResult` in `src/server/recipes/registry.ts`.

Bounds: one run, one step, two command ids, one cancel, one revalidation. A pass covers the model within those bounds, not the whole system. The README lists what is left out.

## Sync commit

`1538faf3c9bb151140ba57f8bd8f64c4e2b7f0c6`

At that commit the model, the README's line numbers and `conformance.test.ts` were confirmed against `src/server/commands.ts`. Move this forward, here and in the `git diff` command above, only after you have confirmed that the model describes the code at the new commit: the diff since the old one is either outside what the model covers or carried into the model, and `check.sh` matches on every row. If covered code changed in commits that did not go through this skill, use `/maintain-formal-verification-skill` to bring the verification back in line.
