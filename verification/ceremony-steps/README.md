# Ceremony step machine

A TLA+ model of one ceremony snapshot's `step` and `revision` as the person, the provider and the clock move it, checked with TLC. It covers `CeremonyController` (`src/server/controller.ts`), `actionsFor` (`src/core/schema.ts`) and the built-in adapter `createProtocolAdapter` (`src/server/adapters.ts`) for the six flows `api-key`, `basic`, `form`, `oauth-code`, `device` and `authmd-anonymous`.

**The property.** The screen changes only when the person presses a button that the screen in front of them offers, when the provider answers a request that is still waiting, or when the deadline passes; and a screen that says connected, cancelled or expired never changes on its own.

**The harm if it breaks.** A person is shown as connected after they cancelled or the attempt expired, or loses a finished connection, or an old tab or a repeated request changes a ceremony they are no longer looking at.

## Run it

```sh
verification/ceremony-steps/check.sh
```

It takes about 10 seconds. It needs Java 11 or later and the repo's `node_modules`. `verification/tlc.sh` fetches TLC 1.7.4 once and checks its checksum.

The script runs TLC on every config, then `conformance.test.ts` on the real controller, and compares each result with the result expected today:

| Config | Expected today | Why |
|---|---|---|
| `CeremonySteps.cfg` | holds | the code as written |
| `FindingRequestHuman.cfg` | holds | finding F1, fixed |
| `Broken*.cfg` listed in `check.sh` | one rule breaks each | a check removed on purpose, to show the rule can fail |
| `Durable.cfg`, `DurableReload.cfg` | holds | the durable controller as written (finding F3, fixed) |
| `DurableLeaseHeld.cfg` | holds | the durable controller while every lease lasts |
| `BrokenDurable*.cfg` | `OneWorkerAppliesAnswers` breaks | a check of the database path removed on purpose |

Exit 0 means every result is the expected one. To run one config alone: `verification/tlc.sh ceremony-steps CeremonySteps FindingRequestHuman`.

The last three configs are of `DurableSteps.tla`, the database path; see "The database path" below. `check.sh` also runs `durable-conformance.test.ts` and `lease-renewal.test.ts` on the durable controller over SQLite.

## Why TLA+ and TLC

The question is whether events can happen in a bad order: a button press, an adapter answer that is still on its way, a callback, the deadline, a second tab. A model checker answers that by trying every order of a small model, and TLA+ with TLC is the usual tool for it; no verifier asks this of the TypeScript itself. The model has about 4,000 states, so the search is complete inside the bounds below. A model can drift from the code, so `conformance.test.ts` runs the real controller for everything the model takes as given.

## The rules

| Rule | In plain words |
|---|---|
| `YouActOnTheScreenYouSee` | An action is accepted only when it carries the revision of the snapshot the server holds now. An action from an older screen, or the same action sent twice, changes nothing. |
| `ConnectedMeansConfirmed` | `complete` is shown only with an outcome behind it. |
| `EndScreensStayPut` | `complete`, `cancelled` and `expired` change only when the person presses a button that screen offers. No adapter answer, no callback and no expiry moves them. |
| `EveryScreenOffersAWayOn` | Every step except `complete` offers at least one action. TLC's deadlock check also runs: no reachable state is stuck. |
| `TryAgainStartsClean` | An outcome in the snapshot was obtained by the adapter that serves this attempt. A claimed outcome is the one exception the code makes, and the model never reaches it on a screen that offers retry. |

## Findings

F1, F2 and F3 are fixed. `conformance.test.ts` shows the first two fixes on the real controller; F3, on the database path, is under "The database path" below, and `durable-conformance.test.ts` shows its fix.

### F1, fixed. An answer to `request-human` that landed after expiry revived the ceremony

Rule: `EndScreensStayPut`. Config: `FindingRequestHuman.cfg`, which now holds.

1. A ceremony is on `input` (or `redirect`) at revision 0. Its adapter implements `requestHuman`, so the snapshot offers `request-human`.
2. `act({action: "request-human", revision: 0})` is accepted. The controller sets `busy` and awaits `adapter.requestHuman()` (`controller.ts:574-577`).
3. `now()` passes `snapshot.expiresAt`.
4. Any `read()` runs `instance()`, which calls `adapter.cancel()` and sets `step: "expired"`, revision 1 (`controller.ts:324-333`).
5. `requestHuman()` resolves. The `request-human` case applies its answer only while `instance.snapshot.step !== "expired"` (`controller.ts:580-581`), the same check `run()` makes (`controller.ts:692`). The step stays `expired` at revision 1.

Before the fix the case passed the answer straight to `update()`, and the step went back to `input` at revision 2. `BrokenNoHumanExpiredGuard.cfg` removes the check (`human-expired-guard`) and TLC finds that path again.

### F2, fixed. Retry kept the cancelled attempt's outcome, and cancel then showed it again

Rule: `TryAgainStartsClean`, now in `CeremonySteps.cfg`. Flow: `authmd-anonymous`.

1. `start` gives `intro`, revision 0. `act(begin)`: the adapter returns `{step: "anonymous", outcome}` with `ownership: "anonymous"`. Revision 1.
2. `act(cancel)` on `anonymous`: `cancelled`, revision 2. The outcome stays in the snapshot.
3. `act(retry)`: the controller cancels the adapter, makes a new one and calls `update({step: "intro", expiresAt}, dropOutcome)` (`controller.ts:615-640`). `dropOutcome` is true unless the outcome's ownership is `claimed` (`controller.ts:639`), and `update()` then leaves the outcome out (`controller.ts:351-355`). The snapshot is `intro` at revision 3 with no outcome.
4. `act(cancel)` on `intro`: with no outcome, `controller.ts:643-647` sends it to `cancelled`. A new `retry` and `begin` register again and get a new `connectionRef`.

Before the fix `update()` kept `previous.outcome`, so step 4 went to `anonymous` with the `connectionRef` the person had cancelled, and a claim from there could never work. A claimed outcome is kept on retry (decision D1). `BrokenRetryKeepsOutcome.cfg` removes the check (`retry-drops-outcome`) and TLC finds the old path again.

## Each rule can fail

Every `Broken*.cfg` puts one name in `Removed`, which takes one check out of the model. TLC finds these shortest counterexamples (kind `api-key` unless noted):

| Config | Check removed | Rule that breaks | Counterexample |
|---|---|---|---|
| `BrokenNoRevisionCheck` | `revision !== snapshot.revision`, `controller.ts:557` | `YouActOnTheScreenYouSee` | A tab holds revision 0. `act(cancel, 0)`: `cancelled`, revision 1. The same tab sends `act(retry, 0)` and it is accepted at revision 1. |
| `BrokenNoRevisionBump` | `revision: previous.revision + 1`, `controller.ts:358` | `YouActOnTheScreenYouSee` | `act(cancel, 0)`: `cancelled`, and the revision is still 0. The tab that never saw the cancelled screen sends `act(retry, 0)` and it is accepted. |
| `BrokenRetryRestartsRevision` | retry goes through `update()`, `controller.ts:632`; removed, it starts again at 0 as `startLocked` does (`:264`) | `YouActOnTheScreenYouSee` | `act(cancel, 0)`: revision 1. The tab reads it. `act(retry, 1)`: `input` at revision 0. The deadline passes and a read expires it: `expired` at revision 1. The tab, still on the cancelled screen of revision 1, sends `act(retry, 1)` and it is accepted. |
| `BrokenNoOfferedCheck` | `!snapshot.actions.includes(action)`, `controller.ts:562` | `ConnectedMeansConfirmed` | `act(finish, 0)` on `input`: `update({step: "complete"})`. Connected with no outcome. |
| `BrokenNoBusyCheck` | `\|\| instance.busy`, `controller.ts:557` | `EndScreensStayPut` | `act(submit, 0)`: `adapter.submit` is in flight. `act(cancel, 0)` is accepted: `cancelled`. `adapter.submit`, already past its own `stopped` check (`adapters.ts:353`), returns `{step: "complete"}`; `run()` applies it. Cancelled, then connected. |
| `BrokenNoExpiredGuard` | `instance.snapshot.step !== "expired"`, `controller.ts:692` | `EndScreensStayPut` | `act(submit, 0)`: in flight. The deadline passes; a read sets `expired`. `adapter.submit`, already past its own `stopped` check (`adapters.ts:353`), returns `{step: "complete"}` and `run()` applies it. Expired, then connected. |
| `BrokenNoExpiredGuardOnError` | `instance.snapshot.step !== "expired"` in the catch, `controller.ts:715` | `EndScreensStayPut` | `act(submit, 0)`: in flight. The deadline passes; a read sets `expired` and calls `adapter.cancel()`. `adapter.submit` throws, as the built-in adapter does once stopped ("Attempt cancelled", `adapters.ts:353`); the catch sets `error`. Expired, then error. |
| `BrokenNoEndExemption` | the steps that never expire, `controller.ts:325` | `EndScreensStayPut` | `act(cancel, 0)`: `cancelled`. The deadline passes; a read sets `expired`. Cancelled, then expired, with no one pressing anything. |
| `BrokenNoCallbackGuard` | `instance.snapshot.step !== "redirect"`, `controller.ts:675` | `EndScreensStayPut` | `act(cancel, 0)`: `cancelled`. A callback arrives; `adapter.callback` throws "Callback is no longer valid" (`adapters.ts:394-395`) and the catch in `run()` sets `error`. Cancelled, then error. |
| `BrokenNoRetryAfterCancel` | `actionsFor("cancelled")` returns `["retry"]`, `schema.ts:322-323` | `EveryScreenOffersAWayOn` | `act(cancel, 0)`: `cancelled`, which offers nothing. |
| `BrokenNoHumanExpiredGuard` | `instance.snapshot.step !== "expired"` in `case "request-human"`, `controller.ts:580`; with `RequestHuman = TRUE` | `EndScreensStayPut` | the F1 path above: `request-human` in flight, the deadline passes, a read sets `expired`, the answer sets `input` or `redirect` again. |
| `BrokenRetryKeepsOutcome` | retry drops an outcome that is not claimed, `controller.ts:639` | `TryAgainStartsClean` | kind `authmd-anonymous`: the F2 path above. `act(begin)`: `anonymous`. `act(cancel)`: `cancelled`. `act(retry)`: `intro`, still holding the first adapter's outcome. |

`conformance.test.ts` shows each of these twelve checks on the real controller (`human-expired-guard` in its F1 test, `retry-drops-outcome` in its F2 tests), so the claim "the code has them" is tested, not assumed. It also tests two more things the model takes as given: that `actionsFor` is the table in the model's `ActionsFor`, and that a callback or a second poll does not start while an adapter call is in flight (`controller.ts:463`, `:675`).

## The database path

`DurableSteps.tla` models `CeremonyController` built with the `database` option: several workers, each a process with its own controller, in-memory store and adapter, share one `CeremonyDatabase` (`src/server/storage.ts`). It is a module of its own beside `CeremonySteps.tla` because every variable of the in-memory model becomes one per worker plus one stored copy; the in-memory configs keep their state space.

**The property.** Two workers never both apply an answer to one ceremony: a lease that runs out while its request waits on the adapter does not let the late answer be stored over what another worker stored since. And a worker that reloads the stored ceremony never finds a final step moved.

**The harm if it breaks.** A person who cancelled, or whose attempt expired, is shown as connected, or a connected ceremony goes back to the provider page; a stale tab's action is accepted against an older stored revision.

### The rules

| Rule | In plain words |
|---|---|
| `OneWorkerAppliesAnswers` | Every write of the stored snapshot starts from the stored snapshot. A worker never writes over a change it has not read, so a lease that runs out during an adapter call cannot let two workers apply answers. |
| `ReloadNeverMovesAnEndStep` | A worker whose copy is on `complete`, `cancelled` or `expired` reloads that step or a newer revision; never another step at the same or an older revision. |
| `ConnectedMeansConfirmed` | The stored `complete` has an outcome behind it. |
| `EveryScreenOffersAWayOn` | Every stored step except `complete` offers an action. TLC's deadlock check also runs. |

### F3, fixed. An answer that landed after its lease ran out was stored over another worker's change

Rules: `OneWorkerAppliesAnswers` (`Durable.cfg`) and `ReloadNeverMovesAnEndStep` (`DurableReload.cfg`). Both hold. `durable-conformance.test.ts` replays the paths on the real controller over SQLite; its three tests named after the rules pass. This was the path before the fix:

1. Worker 1: `act(begin, 0)` acquires the lease `instance:<id>` (`controller.ts:476`, `storage.ts:98-112`), reloads the stored snapshot (`controller.ts:295-320`), sets `busy` and awaits `adapter.begin()` (`controller.ts:686-689`).
2. The lease's 60 seconds pass (`storage.ts:98`). Nothing renewed it and nothing told worker 1.
3. Worker 2: `act(cancel, 0)`. `acquire` deletes the lease that ran out and takes a new one (`storage.ts:100-107`). Worker 2's store has no busy copy, so `instance()` reloads revision 0 and the cancel is accepted: `cancelled`, revision 1, stored by `persist()` (`controller.ts:397-422`).
4. Worker 1's `adapter.begin()` returns `redirect`. `run()` checks only its own in-memory copy, which is still `intro` at revision 0 (`controller.ts:692`), and `update()` stores `redirect` at revision 1 over the cancelled snapshot (`controller.ts:358`, `:385`, `:406`). `OneWorkerAppliesAnswers` broke here.
5. Worker 2: `read`. The reload replaced its `cancelled` copy at revision 1 with `redirect` at revision 1 (`ReloadNeverMovesAnEndStep` broke), and the person was back on the provider page of an attempt they cancelled.

The same path ended a connected ceremony (worker 2 runs begin and the callback to `complete`, then worker 1's answer stores `redirect`) and revived an expired one (worker 1's callback answer `complete` lands after worker 2 stored `expired`). The second is the S-F1 harm across processes: the expired check in `run()` reads a copy no other worker updates.

The fix is three parts of the code:

- `lease-fence`: `persist()` stores a snapshot after an adapter call only while the request's lease row still carries its token and has not run out, checked in the write's transaction (`controller.ts:400-405`, `storage.ts:113-120`). Otherwise `update()` puts the worker's copy back (`controller.ts:384-390`), `run()` rethrows (`controller.ts:695`) and the request fails with 409. At step 4 worker 1's answer is not stored.
- `busy-refuses`: `instance()` refuses a request that finds the worker's copy busy (`controller.ts:293-294`). With a database a request gets there only after the busy request's lease ran out, and that copy is not reloaded. Without the refusal, a read sent past the deadline to the worker whose lease ran out would expire its old copy and store `expired` over what another worker stored.
- The `request-human` case passes its lease to `update()` as `run()` does (`controller.ts:580-581`), so `lease-fence` covers its answer too. The model's `ActRequestHuman` and the `human` flight are that case.
- The lease is renewed every 20 seconds while an adapter call is in flight (`controller.ts:740-758`, `storage.ts:121-135`), so a call longer than 60 seconds keeps its lease and its answer is stored (`lease-renewal.test.ts`). A renewal that finds the lease gone stops and never revives it. The model's `LeaseExpires` is a renewal that did not land in time; the first two checks keep the rules then.

`lease-renewal.test.ts` also runs the fence where `durable-conformance.test.ts` does not reach: a second request to the worker whose lease ran out, past the deadline (`busy-refuses`); a `request-human` answer after its lease ran out; a late answer while another worker holds a fresh lease, which needs the fence to check the token; and `CeremonyDatabase.holds` and `renew` on a lease that ran out.

`DurableLeaseHeld.cfg` holds: while every lease lasts, the lease and the reload are enough.

### Each rule of the database path can fail

| Config | Check removed | Rule that breaks | Counterexample |
|---|---|---|---|
| `BrokenDurableNoLease` | `acquire` refuses while an unexpired lease row exists, `storage.ts:104-109` | `OneWorkerAppliesAnswers` | Worker 1: `act(begin, 0)`, in flight. Worker 2: `act(cancel, 0)` is accepted: `cancelled`, revision 1. Worker 1's answer stores `redirect` at revision 1. |
| `BrokenDurableCachedCopy` | `instance()` reloads on every request that finds the worker idle, `controller.ts:295-320`; removed, it reloads only when the worker has no copy | `OneWorkerAppliesAnswers` | Worker 2 loads revision 0 and cancels: `cancelled`, revision 1. Worker 1 still holds its copy of revision 0, and a tab on revision 0 sends `act(cancel, 0)` to it: accepted, and stored over revision 1. |
| `BrokenDurableNoFence` | `persist()` stores an answer only while the request's lease is held and has not run out, `controller.ts:400-405`, `storage.ts:113-120` | `OneWorkerAppliesAnswers` | Worker 1: `act(begin, 0)`, in flight. Its lease runs out. Worker 2: `act(cancel, 0)` takes a new lease and stores `cancelled`, revision 1. Worker 1's answer stores `redirect` at revision 1 over it. |
| `BrokenDurableNoBusyRefusal` | `instance()` refuses a request that finds the worker's copy busy, `controller.ts:293-294` | `OneWorkerAppliesAnswers` | Worker 1: `act(begin, 0)`, in flight; its lease runs out. A second request to worker 1 is served from its busy copy, which is not reloaded, and writes over what worker 2 stored since. |

The fix for F3 is two checks in `Checks`: `busy-refuses` (`instance()` refuses a request that finds the worker's copy busy) and `lease-fence` (`persist()` stores an answer only while the request's lease is held and has not run out). `BrokenDurableNoFence.cfg` and `BrokenDurableNoBusyRefusal.cfg` remove one each, with `LeaseRunsOut = TRUE`, and must break `OneWorkerAppliesAnswers`.

### The database path in the code

| Variable | Code |
|---|---|
| `db` | the record `instance:<id>`, written by `persist()`, `controller.ts:397-422`, read in `instance()`, `:296-299` |
| `mem` | each worker's `store.get(id).snapshot`, `controller.ts:65-71`, `:304-313` |
| `flight` | each worker's adapter call in flight; `instance.busy` is `flight # "none"` |
| `lease` | the `leases` row `instance:<id>`, `storage.ts:98-115`; acquired at `controller.ts:447`, `:476`, `:661`, released at `:451`, `:492`, `:665` |
| `seen` | the revision in the person's tab |
| `writes`, `staleWrite`, `reloadMoved` | not in the code: they record what happened, so the rules can be stated |

| Action | Code |
|---|---|
| `Init` | `startLocked` on one worker, `controller.ts:224-288` |
| `Enter`, `Free`, `Reloads`, `Loaded` | `acquire`, `storage.ts:98-112`; `instance()`, `controller.ts:289-323` |
| `Expire` | `instance()`, `controller.ts:324-333`, then `persist()` |
| `Read` | `readLocked` without a poll, `controller.ts:454-469` |
| `ReadPolls` | `readLocked` polling on `redirect`, the database path only, `controller.ts:460-468` |
| `ActBegin`, `ActCancel`, `ActRetry`, `ActRequestHuman` | `actLocked`, `controller.ts:546-655`: its checks at `:555-563`, `case "begin"` `:587-589`, `case "cancel"` `:643-652`, `case "retry"` `:613-642`, `case "request-human"` `:571-586` |
| `Callback` | `callbackLocked`, `controller.ts:668-679` |
| `Answer`, `Fenced` | the rest of `run()`, `controller.ts:689-731`, or of `case "request-human"`, `:577-585`; `update()` and `persist()`, `:336-422`, then the release in the request's `finally`; the fence at `:400-405`, `storage.ts:113-120` |
| `NotBusy` | `instance()`, `controller.ts:293-294` |
| `Write` | `update()` and `persist()`, `controller.ts:336-422`: `INSERT OR REPLACE`, `storage.ts:69-71`; the fence checks the lease, not what is stored |
| `LeaseExpires` | the lease row's `expires`, `storage.ts:101`, `:107`; renewed every 20 seconds while an adapter call is in flight, `controller.ts:740-758`, `storage.ts:121-135`; it runs out when a renewal does not land in time |
| `DeadlinePasses` | `now()` against `snapshot.expiresAt` |

### Bounds and what is left out

- Two workers, one ceremony, one person with a tab that can be out of date. The stored snapshot is written at most 8 times.
- One flow: `intro`, `begin` to `redirect`, a callback or a poll to `complete` or `error`, `request-human` on `redirect` (its answer is `redirect` with a new deadline, or a throw), cancel, retry, expiry. The adapter is a recoverable one (`controller.ts:115-119`): any worker's adapter may answer anything an `oauth-code` adapter can. `createProtocolAdapter` is not recoverable and a durable controller refuses it.
- A request that makes no adapter call is one step, from `acquire` to `release`; JavaScript does not interleave it with another request in the same process.
- `DeadlinePasses` marks the stored snapshot and every copy late at once: a copy older than a retry, which has the earlier deadline, is late no later than the stored one.
- Left out: `start` and its lease `start:<owner>:<connector>:<method>`, `connect` and `resume`, events and `deliverEvents`, `collect` and the broker, `sweep`, the intro-to-redirect update on reload (`controller.ts:314-318`), and the poll throttle, which the model lets pass at any time.

## The model and the code

One step of the model is one stretch of JavaScript with no `await` that waits on the network. A provider call is two steps: the request is accepted (`busy` is set and the adapter runs to its first `await`), and later the adapter's answer is applied by the rest of `run()`. Between the two, anything else in the model can happen.

Paths are under `src/`. `controller.ts` and `adapters.ts` are in `server/`; `schema.ts` is in `core/`.

| Variable | Code |
|---|---|
| `kind` | `snapshot.method.kind`, `schema.ts:5-14` |
| `step` | `snapshot.step`, `schema.ts:189-200` |
| `revision` | `snapshot.revision`, `schema.ts:243`; set at `controller.ts:264`, `:358` |
| `own` | `snapshot.outcome?.ownership`, `schema.ts:212-226`; kept across updates at `controller.ts:351-355`, dropped on retry unless claimed (`:639`) |
| `late` | `snapshot.expiresAt <= now()`, `controller.ts:326`; renewed at `:364` by an update that carries `expiresAt` |
| `codeAsked` | `snapshot.fields` is the verification code field, `adapters.ts:363-372` |
| `flight` | the adapter call in flight; `instance.busy` (`controller.ts:69`) is `flight # "none"` |
| `stopped` | the adapter's `stopped`, `adapters.ts:163` |
| `armed` | the adapter's `state` and `verifier` are set, `adapters.ts:155-156` |
| `holds` | the adapter's `outcome` is set, `adapters.ts:171`, `:209-213`, `:386-390` |
| `seen` | the revision in the person's tab, sent as `CeremonyAction.revision`, `schema.ts:277-284` |
| `shown`, `staleAccepted`, `endMoved` | not in the code: they record what happened, so the rules can be stated |
| `Offered` (derived) | `snapshot.actions`; recomputed from the step and the outcome on every update, `controller.ts:275-277`, `:366`, `:380-384`, with `actionsFor`, `schema.ts:317-344` |

| Action | Code |
|---|---|
| `Init` | `startLocked`, `controller.ts:253-274` |
| `Accepts`, `Press` | `actLocked`'s checks, `controller.ts:555-563` |
| `ActBegin` | `case "begin"`, `controller.ts:587-589`; `run()` to `await operation()`, `:686-689`; `adapter.begin` to its first await, `adapters.ts:229-232` |
| `ActSubmit` | `case "submit"`, `controller.ts:590-603`; `adapter.submit` to its first await, `adapters.ts:300-305` |
| `ActClaim` | `case "claim"`, `controller.ts:604-609` |
| `ActFinish` | `case "finish"`, `controller.ts:610-612` |
| `ActRetry`, `RetryOwn` | `case "retry"`, `controller.ts:613-642` (the branch without `adapter.retry`); the outcome kept only when claimed, `:639` |
| `ActCancel` | `case "cancel"`, `controller.ts:643-652`; `adapter.cancel`, `adapters.ts:491-497` |
| `ActRequestHuman` | `case "request-human"`, `controller.ts:571-576` |
| `RequestHumanReturns`, `RequestHumanThrows` | `controller.ts:577-585`, with the expired check at `:580`; the answer's shape from `github.ts:520-524` |
| `BeginReturns` | `adapters.ts:243`, `:261-266`, `:288-295`, `:297`; applied at `controller.ts:689-693` |
| `BeginThrows` | a failed request in `adapters.ts:246-287`; caught at `controller.ts:715-727` |
| `SubmitReturnsComplete` | `adapters.ts:380-383`, `:386-391` |
| `SubmitReturnsCodeInput` | `adapters.ts:356-378`; a repeat is dropped at `controller.ts:343-350` |
| `SubmitReturnsWaiting` | `adapters.ts:318-329` |
| `SubmitThrows` | `adapters.ts:301-304`, `:331-332`, `:352-353`; caught at `controller.ts:715-727` |
| `Callback` | `callbackLocked`, `controller.ts:668-679`; `adapter.callback` to its first await, `adapters.ts:393-399` |
| `CallbackReturns`, `CallbackThrows` | `adapters.ts:400-420`; `controller.ts:689-693`, `:715-727` |
| `ReadPolls` | `readLocked`, `controller.ts:454-468`; `adapters.ts:423` |
| `PollReturnsNothing`, `PollReturnsComplete`, `PollThrowsCeremonyError` | `adapters.ts:437-447`, `:449-456`, `:470-473`, `:476-486` |
| `PollThrowsOther` | `controller.ts:696-714` |
| `DeadlinePasses` | the clock, `controller.ts:101` (`now`) against `snapshot.expiresAt` |
| `ExpireOnAccess` | `instance()`, `controller.ts:324-333` |
| `TabRefreshes` | `read`, `controller.ts:446-470` |
| `Done` | `complete` with no action left, `schema.ts:324-325` |
| `Update`, `Change` | `update()`, `controller.ts:336-391` |
| `Applies`, `ErrorUpdate` | the two guards in `run()`, `controller.ts:692`, `:715`; `RequestHumanReturns` has its own, `:580` |
| `ExpiryDue` | the test in `instance()`, `controller.ts:324-327` |

`ExpireOnAccess` is its own step, although the code runs it at the start of every request. A request that finds the deadline passed behaves as a `read` that expires the snapshot followed by the request, and the model takes those two steps one after the other.

## Bounds and assumptions

- One ceremony, one person, one tab that can be out of date. One adapter call in flight at a time, which `busy` enforces at `controller.ts:463`, `:557` and `:675`.
- The six built-in kinds. `RequestHuman = FALSE` in `CeremonySteps.cfg`, because `createProtocolAdapter` has no `requestHuman`.
- The snapshot changes at most 12 times (`MaxRevision`). Everything in a state except the counters stops growing at 6 changes: 270 combinations at every bound from 6 to 24.
- The in-memory controller: no `database` option, so no lease and no reload.
- JavaScript runs one synchronous stretch at a time. An `await` that resolves at once is treated as a point where other requests may run, which allows more orders than Node does.
- Every adapter call returns or throws in the end. The built-in adapter's requests time out after 10 seconds (`adapters.ts:153`, `:189`).
- An adapter call in flight may still return success after `adapter.cancel()`. `createProtocolAdapter` checks `stopped` before it stores a credential (`adapters.ts:201`, `:353`), so for it this needs `cancel()` to land while `store.put` is pending: impossible with `MemoryCredentialStore`, possible with a store that does real I/O. The `AuthAdapter` interface does not require the check at all; the stub adapter in `tests/controller.test.ts` ignores `cancel()`.
- Which answer the provider gives is free: every answer the adapter code can return is tried.

## What is left out

- The durable controller, in `CeremonySteps.tla`: `DurableSteps.tla` models it ("The database path" above).
- `connect`, resume, the 100-attempt limit, and `sweep` (`controller.ts:126-205`, `:241-251`, `:759-769`).
- `collect`, the credential broker and field validation (`controller.ts:424-445`, `:515-545`). A rejected submission changes nothing.
- The kinds `github-app` and `account-registration`, the adapters in `services.ts`, `github.ts`, `neon.ts` and `connectors/commands/registration.ts`, and the `adapter.retry()` and `adapter.initial()` hooks. F1 models only the shape of `requestHuman`.
- What the snapshot shows apart from the step: fields, messages, URLs, user codes, scopes.
- The credential store. When an answer is dropped after expiry, the adapter may already have stored the credential (`adapters.ts:202-208`); nothing here checks for that orphan.
- The poll throttles (`controller.ts:464`, `adapters.ts:423`): the model lets a poll start at any time.
- The OAuth `state` and PKCE check. A callback with the wrong `state`, such as one from an earlier attempt's provider tab, is `CallbackThrows`: it ends the new attempt in `error`.
- Whether a ceremony finishes in the end. The rules are about what must never happen, plus no dead end.
- More than one ceremony, the HTTP layer, and the owner check.

## The chart

`chart.mmd` is drawn by the `/statechart` skill from `Chart.cfg` and `view.mjs`. `Chart.cfg` is the code as written with a person who always has the current screen, so that the graph is small enough to draw; it also checks `TryAgainStartsClean`, and every rule holds, so the chart marks no broken state.

The chart hides three kinds of step, all from the stopped screens: cancel on `expired`, cancel on `error`, and the `error` screen expiring. Each only swaps one "Not connected" screen for another. The second round of the `form` flow, where the provider asks for a code it sent, stays inside "Enter your key, password or code".

## Files

| File | What it is |
|---|---|
| `CeremonySteps.tla` | the model and the rules |
| `CeremonySteps.cfg` | the code as written; must hold |
| `Finding*.cfg` | the code as written with one setting or rule of a finding; an open finding breaks it, a fixed one holds |
| `Broken*.cfg` | one check removed each; must fail |
| `DurableSteps.tla` | the database path and its rules |
| `Durable*.cfg`, `BrokenDurable*.cfg` | its configs: the code as written, and one check removed each |
| `check.sh` | runs all of the above, `conformance.test.ts`, `durable-conformance.test.ts` and `lease-renewal.test.ts`, and compares with what is expected |
| `conformance.test.ts` | what the model takes as given, the fixes for F1 and F2, on the real controller |
| `durable-conformance.test.ts` | the lease, the reload and the poll on redirect, and the F3 paths, on the durable controller over SQLite |
| `lease-renewal.test.ts` | an adapter call longer than the lease keeps it, on a fake clock; the fence on a busy worker, on `request-human` and under another worker's fresh lease; `holds` and `renew` |
| `Chart.cfg`, `view.mjs`, `chart.mmd` | the chart, and how it is drawn |

## Kept in step with the code

The coverage record and the sync commit are in `.claude/skills/verify-ceremony-steps/SKILL.md`.
