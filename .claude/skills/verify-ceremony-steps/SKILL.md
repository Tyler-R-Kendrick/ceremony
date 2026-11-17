---
name: verify-ceremony-steps
description: "Check a change to the ceremony step machine against its TLA+ model: the snapshot's step and revision in CeremonyController, actionsFor, and the built-in protocol adapter. Use before you finish any change to src/server/controller.ts, to steps, actionNames or actionsFor in src/core/schema.ts, or to createProtocolAdapter in src/server/adapters.ts; when a change adds a step, an action or an AuthAdapter method; and for questions about stale or repeated actions, late callbacks, expiry, cancel, retry or revision."
---

# Verify the ceremony steps

Every embedded auth method shows a person the same step machine: `intro`, `input`, `redirect`, `waiting`, `anonymous`, `claim`, `complete`, `error`, `cancelled`, `expired`. A TLA+ model of it lives in `verification/ceremony-steps/`, and TLC checks one promise:

**The screen changes only when the person presses a button that the screen in front of them offers, when the provider answers a request that is still waiting, or when the deadline passes; and a screen that says connected, cancelled or expired never changes on its own.**

If it breaks, a person is shown as connected after they cancelled or the attempt expired, or loses a finished connection, or an old tab or a repeated request changes a ceremony they are no longer looking at.

A second model, `DurableSteps.tla` in the same folder, covers the database path: two workers sharing one `CeremonyDatabase`, the lease, the reload in `instance()` and the poll on `redirect`. Its promise: **two workers never both apply an answer to one ceremony, and a reload never moves a final step.**

`verification/ceremony-steps/README.md` has the rules, the bounds, what is left out, the fixed findings F1 and F2, and the table that maps every model action and variable to `file:line`. Read it before you change the model.

## Does your change touch the verified code?

It does if it changes any of the code in the coverage record below, or if it adds code that does one of these things anywhere:

- writes `snapshot.step`, `snapshot.revision`, `snapshot.actions`, `snapshot.outcome` or `snapshot.expiresAt`, or calls `update()` in the controller;
- sets or reads `instance.busy`;
- adds an entry point to `CeremonyController` beside `start`, `read`, `collect`, `act`, `callback`;
- adds a method to `AuthAdapter`, or an `await` inside a path that had none;
- adds a step to `steps`, an action to `actionNames`, or a case to `actionsFor`;
- changes the `database` path: `acquire` or `release` around a request, the reload in `instance()`, `persist()`, or the poll on `redirect` in `readLocked`; or changes `CeremonyDatabase.acquire`, `holds`, `renew`, `release`, `put` or `transaction` in `src/server/storage.ts`; or changes the lease renewal in `renewWhileWaiting`.

To see what changed since the verification was last confirmed:

```sh
git diff 280de3083a90266a103c7478bc2093c567453c4a -- src/core/schema.ts src/server/controller.ts src/server/adapters.ts src/server/storage.ts
```

Formatting, comments, messages, field definitions, and the code listed under "Not covered" do not touch it.

## Run the check

```sh
verification/ceremony-steps/check.sh
```

About 10 seconds. It needs Java 11 or later and `node_modules`. It runs TLC 1.7.4 on every config, then `conformance.test.ts` on the real controller, and prints one line for each. This is what it prints when nothing has changed:

```
ok       CeremonySteps                holds                            the code as written
ok       FindingRequestHuman          holds                            finding F1, fixed
ok       BrokenNoRevisionCheck        breaks:YouActOnTheScreenYouSee   broken on purpose
ok       BrokenNoRevisionBump         breaks:YouActOnTheScreenYouSee   broken on purpose
ok       BrokenRetryRestartsRevision  breaks:YouActOnTheScreenYouSee   broken on purpose
ok       BrokenNoOfferedCheck         breaks:ConnectedMeansConfirmed   broken on purpose
ok       BrokenNoBusyCheck            breaks:EndScreensStayPut         broken on purpose
ok       BrokenNoExpiredGuard         breaks:EndScreensStayPut         broken on purpose
ok       BrokenNoExpiredGuardOnError  breaks:EndScreensStayPut         broken on purpose
ok       BrokenNoHumanExpiredGuard    breaks:EndScreensStayPut         broken on purpose
ok       BrokenNoEndExemption         breaks:EndScreensStayPut         broken on purpose
ok       BrokenNoCallbackGuard        breaks:EndScreensStayPut         broken on purpose
ok       BrokenNoRetryAfterCancel     breaks:EveryScreenOffersAWayOn   broken on purpose
ok       BrokenRetryKeepsOutcome      breaks:TryAgainStartsClean       broken on purpose
ok       Durable                      holds                            the durable controller as written
ok       DurableReload                holds                            the durable controller as written, a reload never moves a final step
ok       DurableLeaseHeld             holds                            the durable controller while every lease lasts
ok       BrokenDurableNoLease         breaks:OneWorkerAppliesAnswers   broken on purpose
ok       BrokenDurableCachedCopy      breaks:OneWorkerAppliesAnswers   broken on purpose
ok       BrokenDurableNoFence         breaks:OneWorkerAppliesAnswers   broken on purpose
ok       BrokenDurableNoBusyRefusal   breaks:OneWorkerAppliesAnswers   broken on purpose
ok       conformance.test.ts          the real controller has the checks the model assumes; F1 and F2 are fixed
ok       durable-conformance.test.ts  the durable controller has the lease, reload, fence and renewal the model assumes; one worker applies answers
As expected: the rules hold for the code as written. Open findings: 0 (see README.md).
```

Finding F3 (README.md, "The database path") is fixed by the checks `busy-refuses` and `lease-fence` in `DurableSteps.tla` and by the lease renewal while an adapter call is in flight; `BrokenDurableNoBusyRefusal` and `BrokenDurableNoFence` remove one check each and must break `OneWorkerAppliesAnswers`. The `durable-conformance.test.ts` line also runs `lease-renewal.test.ts`.

Exit 0 means every line is the expected one. A `FINDING` line, when there is one, is a known bug in the code, reported and not fixed; it is not yours unless you changed that code. To run one config alone: `verification/tlc.sh ceremony-steps CeremonySteps <config name>`, or `DurableSteps` for a `Durable*` config. A `MISMATCH` line prints the TLC or test output under it and the script exits 1.

**TLC does not read the TypeScript.** `conformance.test.ts`, `durable-conformance.test.ts` and `lease-renewal.test.ts` are the only parts that run the real code. The first tests what the model takes as given (twelve checks, the `actionsFor` table, one adapter call in flight at a time), the fixes for F1 and F2, and nothing else. So "as expected" after a change to covered code means something only when the model describes the changed code. If your change alters what a model action does, update the model first (see below), then run.

## Read a result

Read every TLC result with the `/statechart` skill: give it `CeremonySteps.tla`, the config, and `view.mjs`. For a rule that breaks it gives the shortest path in the person's words; for a config that holds and is small enough it draws the chart.

| What you see | What it means | What to do |
|---|---|---|
| `MISMATCH conformance.test.ts`, a test named after a check (`revision-check`, `busy-check`, `offered-check`, `end-exemption`, `expired-guard`, `expired-guard-on-error`, `callback-guard`, `revision-bump and retry-keeps-revision`, `retry-after-cancel`) | The real controller lost a check the model takes as given. | The `Broken*.cfg` that has that name in `Removed` already shows what follows: which rule breaks and by which path. Unless the change is meant to replace the check with another one, this is a bug in the change. Restore the check, or model the replacement and rerun. |
| `MISMATCH conformance.test.ts`, test `actionsFor is the table…` or `one call in flight…` | The offered actions changed, or two adapter calls can now run at once. The model no longer describes the code. | Change `ActionsFor`, or model the second call in flight, from the new code, then update the test and rerun. |
| `MISMATCH conformance.test.ts`, test `request-human expired-guard` | The `request-human` case lost its expired check (`controller.ts:580`): F1 is back. | `BrokenNoHumanExpiredGuard.cfg` shows the path. Restore the check. |
| `MISMATCH conformance.test.ts`, a test `retry-clears-outcome` | Retry no longer drops an outcome that is not claimed (`controller.ts:639`), or drops a claimed one: F2 is back, or decision D1 changed. | `BrokenRetryKeepsOutcome.cfg` shows the path. Restore the check, or, if D1 changed on purpose, change `RetryOwn` from the new code and rerun. |
| `MISMATCH Durable` or `DurableReload` with a `breaks:` result, or `MISMATCH durable-conformance.test.ts` | Two workers can both apply an answer, or a reload moves a final step: the change brought finding F3 back, or a call longer than the lease lost it. | Replay the path with `durable-conformance.test.ts`. Do not weaken the rule or set `LeaseRunsOut = FALSE` in these configs. |
| `MISMATCH CeremonySteps` with a `breaks:` result | The model, as you now have it, breaks the rule named after `breaks:`. Other configs can show `MISMATCH` with the same rule, because TLC stops at the first rule that breaks. | Deal with `CeremonySteps` first. Decide whether it is a bug or a modelling error, as below. |
| `MISMATCH` on a `Broken*` config that now `holds` | The rule no longer depends on that check in the model, so the rule has stopped guarding it. | Find the model edit that made the check redundant. Either the code really has a second defence, which you must point to and then retire the config with its reason, or the model edit was wrong. |
| `MISMATCH` with `deadlock` | A state with no step out that is not `complete`. | Treat it as a broken `EveryScreenOffersAWayOn`. |
| `MISMATCH` with `tool-error` | TLC could not parse or run. | Read the output under the line; fix the syntax. |

### A real bug or a modelling error?

Replay the path on the real controller. Write a test like the ones in `conformance.test.ts`: a stub `AuthAdapter` whose calls resolve when the test says (`Promise.withResolvers`), the controller's clock passed in as `now`, and one controller call for each step of the path. The README table says which call each model action is: `ActCancel` is `controller.act(owner, id, {action: "cancel", revision})`, `ExpireOnAccess` is a `controller.read` after the clock passes `expiresAt`, an answer such as `SubmitReturnsComplete` is the stub's promise resolving.

- The real controller follows the path to the end: **the code breaks the rule.** Report the path in the code's words with `file:line`. Do not weaken the rule, do not narrow the model, and do not change product code beyond your task unless the user asks. If it will stay open, give it a `Finding*.cfg`, a line in `check.sh`, a test, and a README entry, as F1 and F2 had.
- The real controller refuses a step or does something else: **the model is wrong at that action.** Correct that action from the code and rerun. Never correct it by trying edits until TLC passes.

## Update the verification for an intended change

1. Find the changed lines in the coverage record and in the README table. That names the model actions to look at.
2. Edit `CeremonySteps.tla` from the code, before you run anything:
   - A new step or action: add it to `Steps` or `ActionNames`, to `ActionsFor`, and an `Act…` action; add its label to `view.mjs`.
   - A new `await` on the network inside a path that was one stretch: split that model action in two, with a `flight` value between them. One step of the model must stay one stretch of code that nothing can interrupt.
   - A new adapter call: a `flight` value, an action that starts it and one action for each answer it can give.
   - A check added, moved or removed in `actLocked`, `instance`, `run`, `callbackLocked` or `update`: change `Accepts`, `ExpiryDue`, `Applies`, `ErrorUpdate`, `Callback` or `Update` to match.
   - A new kind: add it to `BuiltInKinds`, to `Kinds` in every config, and to each `CASE kind` in the answers.
3. If the change adds a check that a rule depends on, add its name to `Checks`, a `Broken*.cfg` that removes it, a line in `check.sh`, and a test in `conformance.test.ts`. Run and see the broken config fail. A rule you have not seen fail proves nothing.
4. Change a rule only when the promise itself changed on purpose, and write the evidence (the test, the doc comment, the commit) next to the new wording in the README.
5. Run `verification/ceremony-steps/check.sh` until it prints "As expected".
6. Redraw the chart with `/statechart` from `Chart.cfg` and `view.mjs` and save its Mermaid text as `verification/ceremony-steps/chart.mmd`. Keep it to about 20 arrows, in the person's words.
7. Update the line numbers in the README table and in the comments of `CeremonySteps.tla`, then the coverage record and the sync commit below.

## Coverage record

Line numbers are at the sync commit.

| Check | Code it covers |
|---|---|
| `YouActOnTheScreenYouSee` | `src/server/controller.ts`: `actLocked` checks (555-563), `update` (336-391; revision at 358, early return at 343-350), `startLocked` (revision 0, 262-274), `case "retry"` (613-642). `src/core/schema.ts`: `actionSchema` (277-284). |
| `ConnectedMeansConfirmed` | `src/server/controller.ts`: the offered check (562), `case "finish"` (610-612), the outcome kept by `update` (351-355). `src/core/schema.ts`: `actionsFor` (317-344). `src/server/adapters.ts`: every return of `step: "complete"` (380-383, 386-391, 420, 449-456, 470-473). |
| `EndScreensStayPut` | `src/server/controller.ts`: `instance` expiry (324-333), `run` (681-732), `callbackLocked` (668-679), `readLocked` (454-470), the busy check (557), `case "cancel"` (643-652), `case "request-human"` (571-586, the expired check at 580). `src/server/adapters.ts`: `cancel` (491-497), `callback` (393-421), `poll` (422-490), `save` (193-215). |
| `EveryScreenOffersAWayOn` and TLC's deadlock check | `src/core/schema.ts`: `steps` (189-200), `actionNames` (202-210), `actionsFor` (317-344). `src/server/controller.ts`: where `snapshot.actions` is set (275-277, 366, 380-384). |
| `TryAgainStartsClean` (finding F2, fixed) and `BrokenRetryKeepsOutcome.cfg` | `src/server/controller.ts`: `case "retry"` (613-642, the outcome dropped unless claimed at 639), `case "cancel"` (643-652), `update` (336-355). `src/server/adapters.ts`: `outcome` (171), `save` (193-215), the claim token check in `submit` (300-304). |
| `FindingRequestHuman.cfg` (finding F1, fixed) and `BrokenNoHumanExpiredGuard.cfg` | `src/server/controller.ts`: `case "request-human"` (571-586, the expired check at 580), `AuthAdapter.requestHuman` (41). `src/server/github.ts`: `requestHuman` (501-525), for the shape of its answer only. |
| `conformance.test.ts` | On the real `CeremonyController`: the twelve checks (`controller.ts` 325, 358, 557 twice, 562, 580, 632, 639, 675, 692, 715; `schema.ts` 322-323), the whole `actionsFor` table (`schema.ts` 317-344), and one adapter call in flight (`controller.ts` 463, 675). The fix for F1, and the fix for F2 with the real `createProtocolAdapter`. |
| `OneWorkerAppliesAnswers`, `ReloadNeverMovesAnEndStep` (finding F3, fixed) and `BrokenDurable*.cfg` | `src/server/controller.ts`: `instance` (289-334; `busy-refuses` at 293-294, the reload at 295-320), `update` putting the copy back when the write is refused (384-390), `persist` (397-422; `lease-fence` at 400-405), the acquire and release in `read` (446-452), `act` (471-494) and `callback` (656-666), `run` (681-732; the rethrow at 695), `renewWhileWaiting` (733-758). `src/server/storage.ts`: `acquire` (98-112), `holds` (113-120), `renew` (121-135), `release` (136-138). `durable-conformance.test.ts` and `lease-renewal.test.ts` run them on SQLite. |
| The adapter answers in the model | `src/server/adapters.ts`: `createProtocolAdapter`: `begin` (228-298), `submit` (299-392), `callback` (393-421), `poll` (422-490), `cancel` (491-497), and the closure variables `verifier`, `state`, `claimToken`, `stopped`, `outcome` (155-171). |

## Sync commit

`280de3083a90266a103c7478bc2093c567453c4a`

At this commit the models were read against the covered files: the changes since the previous sync commit (`9414fb2245119572c7db164fb1f74e144d094f85`) are in `controller.ts` and `storage.ts`, the database path only. `instance()` refuses a request that finds the worker's copy busy (`busy-refuses`, `NotBusy` in `Enter`); `persist()` stores a snapshot after an adapter call only while the request's lease is held (`lease-fence`, `Fenced` in `Answer`), and `update()` puts the copy back when it is refused; `run()` and the `request-human` case renew the lease every 20 seconds while the call is in flight, which `LeaseExpires` covers as a renewal that does not land in time; `CeremonyDatabase` gains `holds` and `renew`. `CeremonySteps.tla` is unchanged apart from line numbers: with no database none of these run. `check.sh` printed "As expected" with `Durable.cfg` and `DurableReload.cfg` holding, `BrokenDurableNoFence.cfg` and `BrokenDurableNoBusyRefusal.cfg` breaking `OneWorkerAppliesAnswers`, `BrokenRetryKeepsOutcome.cfg` breaking `TryAgainStartsClean`, and `Chart.cfg` holds.

Move this forward only after you have read the diff of the covered files from the old sync commit to the new one, confirmed that each model action still describes its code, updated the line numbers, and seen `check.sh` print "As expected" at the new commit. A passing run on its own is not that confirmation. If covered code changed in commits that never ran this skill, use `/maintain-formal-verification-skill`.

## Not covered

A pass says nothing about these:

- in `DurableSteps.tla`: `start` and its lease, events and their delivery, the intro-to-redirect update on reload, the poll throttle, more than two workers, any flow but `oauth-code`;
- `connect`, resume, the 100-attempt limit, `sweep`, `collect`, the credential broker, field validation;
- the kinds `github-app` and `account-registration`, and every adapter except `createProtocolAdapter`; other adapters appear only as "may answer anything";
- what the snapshot shows apart from its step: fields, messages, URLs, codes, scopes;
- the credential store, the OAuth `state` and PKCE check, the poll throttles;
- more than 12 snapshot changes, more than one ceremony, more than one out-of-date tab;
- whether a ceremony finishes in the end.
