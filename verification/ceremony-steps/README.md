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
| `FindingTryAgain.cfg` | `TryAgainStartsClean` breaks | open finding F2 |
| `Broken*.cfg` listed in `check.sh` | one rule breaks each | a check removed on purpose, to show the rule can fail |

Exit 0 means every result is the expected one. To run one config alone: `verification/tlc.sh ceremony-steps CeremonySteps FindingTryAgain`.

## Why TLA+ and TLC

The question is whether events can happen in a bad order: a button press, an adapter answer that is still on its way, a callback, the deadline, a second tab. A model checker answers that by trying every order of a small model, and TLA+ with TLC is the usual tool for it; no verifier asks this of the TypeScript itself. The model has about 4,000 states, so the search is complete inside the bounds below. A model can drift from the code, so `conformance.test.ts` runs the real controller for everything the model takes as given.

## The rules

| Rule | In plain words |
|---|---|
| `YouActOnTheScreenYouSee` | An action is accepted only when it carries the revision of the snapshot the server holds now. An action from an older screen, or the same action sent twice, changes nothing. |
| `ConnectedMeansConfirmed` | `complete` is shown only with an outcome behind it. |
| `EndScreensStayPut` | `complete`, `cancelled` and `expired` change only when the person presses a button that screen offers. No adapter answer, no callback and no expiry moves them. |
| `EveryScreenOffersAWayOn` | Every step except `complete` offers at least one action. TLC's deadlock check also runs: no reachable state is stuck. |
| `TryAgainStartsClean` | An outcome in the snapshot was obtained by the adapter that serves this attempt. Checked only in `FindingTryAgain.cfg`, because the code breaks it today (F2). |

## Findings

F2 is open and reproduced on the real controller by `conformance.test.ts`. F1 is fixed; the same test shows the fix.

### F1, fixed. An answer to `request-human` that landed after expiry revived the ceremony

Rule: `EndScreensStayPut`. Config: `FindingRequestHuman.cfg`, which now holds.

1. A ceremony is on `input` (or `redirect`) at revision 0. Its adapter implements `requestHuman`, so the snapshot offers `request-human`.
2. `act({action: "request-human", revision: 0})` is accepted. The controller sets `busy` and awaits `adapter.requestHuman()` (`controller.ts:528-530`).
3. `now()` passes `snapshot.expiresAt`.
4. Any `read()` runs `instance()`, which calls `adapter.cancel()` and sets `step: "expired"`, revision 1 (`controller.ts:303-312`).
5. `requestHuman()` resolves. The `request-human` case applies its answer only while `instance.snapshot.step !== "expired"` (`controller.ts:532-533`), the same check `run()` makes (`controller.ts:630`). The step stays `expired` at revision 1.

Before the fix the case passed the answer straight to `update()`, and the step went back to `input` at revision 2. `BrokenNoHumanExpiredGuard.cfg` removes the check (`human-expired-guard`) and TLC finds that path again.

### F2. Retry keeps the cancelled attempt's outcome, and cancel then shows it again

Rule: `TryAgainStartsClean`. Config: `FindingTryAgain.cfg`. Flow: `authmd-anonymous`.

1. `start` gives `intro`, revision 0. `act(begin)`: the adapter returns `{step: "anonymous", outcome}` with `ownership: "anonymous"`. Revision 1.
2. `act(cancel)` on `anonymous`: `cancelled`, revision 2. The outcome stays in the snapshot.
3. `act(retry)`: the controller cancels the adapter, makes a new one and calls `update({step: "intro", expiresAt})` (`controller.ts:564-580`). `update()` keeps `previous.outcome` (`controller.ts:324-326`). The snapshot is `intro` at revision 3, still holding the first attempt's outcome. **The rule breaks here.**

`conformance.test.ts` continues on the real code:

4. `act(cancel)` on `intro`: because the snapshot holds an anonymous outcome, `controller.ts:586-590` sends it to `anonymous`, not `cancelled`. The screen says anonymous access is ready, with the `connectionRef` the person cancelled.
5. `act(claim)`, `act(submit)`: the new adapter has no claim token, so it throws "The account claim window has expired. Anonymous access is unchanged." (`adapters.ts:301-304`). Step `error`.
6. `act(finish)`: `complete`, with the cancelled attempt's `connectionRef`.

The person pressed cancel twice and is shown the access they cancelled; claiming it can never work from this ceremony. Whether a cancelled anonymous outcome should survive retry is a product decision; the code does not look as if it decided it.

## Each rule can fail

Every `Broken*.cfg` puts one name in `Removed`, which takes one check out of the model. TLC finds these shortest counterexamples (kind `api-key` unless noted):

| Config | Check removed | Rule that breaks | Counterexample |
|---|---|---|---|
| `BrokenNoRevisionCheck` | `revision !== snapshot.revision`, `controller.ts:511` | `YouActOnTheScreenYouSee` | A tab holds revision 0. `act(cancel, 0)`: `cancelled`, revision 1. The same tab sends `act(retry, 0)` and it is accepted at revision 1. |
| `BrokenNoRevisionBump` | `revision: previous.revision + 1`, `controller.ts:329` | `YouActOnTheScreenYouSee` | `act(cancel, 0)`: `cancelled`, and the revision is still 0. The tab that never saw the cancelled screen sends `act(retry, 0)` and it is accepted. |
| `BrokenRetryRestartsRevision` | retry goes through `update()`, `controller.ts:579`; removed, it starts again at 0 as `startLocked` does (`:248`) | `YouActOnTheScreenYouSee` | `act(cancel, 0)`: revision 1. The tab reads it. `act(retry, 1)`: `input` at revision 0. The deadline passes and a read expires it: `expired` at revision 1. The tab, still on the cancelled screen of revision 1, sends `act(retry, 1)` and it is accepted. |
| `BrokenNoOfferedCheck` | `!snapshot.actions.includes(action)`, `controller.ts:516` | `ConnectedMeansConfirmed` | `act(finish, 0)` on `input`: `update({step: "complete"})`. Connected with no outcome. |
| `BrokenNoBusyCheck` | `\|\| instance.busy`, `controller.ts:511` | `EndScreensStayPut` | `act(submit, 0)`: `adapter.submit` is in flight. `act(cancel, 0)` is accepted: `cancelled`. `adapter.submit`, already past its own `stopped` check (`adapters.ts:353`), returns `{step: "complete"}`; `run()` applies it. Cancelled, then connected. |
| `BrokenNoExpiredGuard` | `instance.snapshot.step !== "expired"`, `controller.ts:630` | `EndScreensStayPut` | `act(submit, 0)`: in flight. The deadline passes; a read sets `expired`. `adapter.submit`, already past its own `stopped` check (`adapters.ts:353`), returns `{step: "complete"}` and `run()` applies it. Expired, then connected. |
| `BrokenNoExpiredGuardOnError` | `instance.snapshot.step !== "expired"` in the catch, `controller.ts:647` | `EndScreensStayPut` | `act(submit, 0)`: in flight. The deadline passes; a read sets `expired` and calls `adapter.cancel()`. `adapter.submit` throws, as the built-in adapter does once stopped ("Attempt cancelled", `adapters.ts:353`); the catch sets `error`. Expired, then error. |
| `BrokenNoEndExemption` | the steps that never expire, `controller.ts:304` | `EndScreensStayPut` | `act(cancel, 0)`: `cancelled`. The deadline passes; a read sets `expired`. Cancelled, then expired, with no one pressing anything. |
| `BrokenNoCallbackGuard` | `instance.snapshot.step !== "redirect"`, `controller.ts:617` | `EndScreensStayPut` | `act(cancel, 0)`: `cancelled`. A callback arrives; `adapter.callback` throws "Callback is no longer valid" (`adapters.ts:394-395`) and the catch in `run()` sets `error`. Cancelled, then error. |
| `BrokenNoRetryAfterCancel` | `actionsFor("cancelled")` returns `["retry"]`, `schema.ts:322-323` | `EveryScreenOffersAWayOn` | `act(cancel, 0)`: `cancelled`, which offers nothing. |
| `BrokenNoHumanExpiredGuard` | `instance.snapshot.step !== "expired"` in `case "request-human"`, `controller.ts:532`; with `RequestHuman = TRUE` | `EndScreensStayPut` | the F1 path above: `request-human` in flight, the deadline passes, a read sets `expired`, the answer sets `input` or `redirect` again. Not yet listed in `check.sh`; run it with `verification/tlc.sh ceremony-steps CeremonySteps BrokenNoHumanExpiredGuard`. |

`conformance.test.ts` shows each of these eleven checks on the real controller (`human-expired-guard` in its F1 test), so the claim "the code has them" is tested, not assumed. It also tests two more things the model takes as given: that `actionsFor` is the table in the model's `ActionsFor`, and that a callback or a second poll does not start while an adapter call is in flight (`controller.ts:418`, `:617`).

## The model and the code

One step of the model is one stretch of JavaScript with no `await` that waits on the network. A provider call is two steps: the request is accepted (`busy` is set and the adapter runs to its first `await`), and later the adapter's answer is applied by the rest of `run()`. Between the two, anything else in the model can happen.

Paths are under `src/`. `controller.ts` and `adapters.ts` are in `server/`; `schema.ts` is in `core/`.

| Variable | Code |
|---|---|
| `kind` | `snapshot.method.kind`, `schema.ts:5-14` |
| `step` | `snapshot.step`, `schema.ts:189-200` |
| `revision` | `snapshot.revision`, `schema.ts:243`; set at `controller.ts:248`, `:329` |
| `own` | `snapshot.outcome?.ownership`, `schema.ts:212-226`; kept across updates at `controller.ts:324-326` |
| `late` | `snapshot.expiresAt <= now()`, `controller.ts:305`; renewed at `:335` by an update that carries `expiresAt` |
| `codeAsked` | `snapshot.fields` is the verification code field, `adapters.ts:363-372` |
| `flight` | the adapter call in flight; `instance.busy` (`controller.ts:69`) is `flight # "none"` |
| `stopped` | the adapter's `stopped`, `adapters.ts:163` |
| `armed` | the adapter's `state` and `verifier` are set, `adapters.ts:155-156` |
| `holds` | the adapter's `outcome` is set, `adapters.ts:171`, `:209-213`, `:386-390` |
| `seen` | the revision in the person's tab, sent as `CeremonyAction.revision`, `schema.ts:277-284` |
| `shown`, `staleAccepted`, `endMoved` | not in the code: they record what happened, so the rules can be stated |
| `Offered` (derived) | `snapshot.actions`; recomputed from the step and the outcome on every update, `controller.ts:259-261`, `:337`, `:351-355`, with `actionsFor`, `schema.ts:317-344` |

| Action | Code |
|---|---|
| `Init` | `startLocked`, `controller.ts:237-258` |
| `Accepts`, `Press` | `actLocked`'s checks, `controller.ts:509-517` |
| `ActBegin` | `case "begin"`, `controller.ts:538-540`; `run()` to `await operation()`, `:626-628`; `adapter.begin` to its first await, `adapters.ts:229-232` |
| `ActSubmit` | `case "submit"`, `controller.ts:541-552`; `adapter.submit` to its first await, `adapters.ts:300-305` |
| `ActClaim` | `case "claim"`, `controller.ts:553-558` |
| `ActFinish` | `case "finish"`, `controller.ts:559-561` |
| `ActRetry` | `case "retry"`, `controller.ts:562-585` (the branch without `adapter.retry`) |
| `ActCancel` | `case "cancel"`, `controller.ts:586-595`; `adapter.cancel`, `adapters.ts:491-497` |
| `ActRequestHuman` | `case "request-human"`, `controller.ts:525-529` |
| `RequestHumanReturns`, `RequestHumanThrows` | `controller.ts:530-536`, with the expired check at `:532`; the answer's shape from `github.ts:520-524` |
| `BeginReturns` | `adapters.ts:243`, `:261-266`, `:288-295`, `:297`; applied at `controller.ts:628-631` |
| `BeginThrows` | a failed request in `adapters.ts:246-287`; caught at `controller.ts:647-654` |
| `SubmitReturnsComplete` | `adapters.ts:380-383`, `:386-391` |
| `SubmitReturnsCodeInput` | `adapters.ts:356-378`; a repeat is dropped at `controller.ts:317-323` |
| `SubmitReturnsWaiting` | `adapters.ts:318-329` |
| `SubmitThrows` | `adapters.ts:301-304`, `:331-332`, `:352-353`; caught at `controller.ts:647-654` |
| `Callback` | `callbackLocked`, `controller.ts:611-621`; `adapter.callback` to its first await, `adapters.ts:393-399` |
| `CallbackReturns`, `CallbackThrows` | `adapters.ts:400-420`; `controller.ts:628-631`, `:647-654` |
| `ReadPolls` | `readLocked`, `controller.ts:410-423`; `adapters.ts:423` |
| `PollReturnsNothing`, `PollReturnsComplete`, `PollThrowsCeremonyError` | `adapters.ts:437-447`, `:449-456`, `:470-473`, `:476-486` |
| `PollThrowsOther` | `controller.ts:633-646` |
| `DeadlinePasses` | the clock, `controller.ts:85` (`now`) against `snapshot.expiresAt` |
| `ExpireOnAccess` | `instance()`, `controller.ts:303-312` |
| `TabRefreshes` | `read`, `controller.ts:402-425` |
| `Done` | `complete` with no action left, `schema.ts:324-325` |
| `Update`, `Change` | `update()`, `controller.ts:315-357` |
| `Applies`, `ErrorUpdate` | the two guards in `run()`, `controller.ts:630`, `:647`; `RequestHumanReturns` has its own, `:532` |
| `ExpiryDue` | the test in `instance()`, `controller.ts:303-306` |

`ExpireOnAccess` is its own step, although the code runs it at the start of every request. A request that finds the deadline passed behaves as a `read` that expires the snapshot followed by the request, and the model takes those two steps one after the other.

## Bounds and assumptions

- One ceremony, one person, one tab that can be out of date. One adapter call in flight at a time, which `busy` enforces at `controller.ts:418`, `:511` and `:617`.
- The six built-in kinds. `RequestHuman = FALSE` in `CeremonySteps.cfg`, because `createProtocolAdapter` has no `requestHuman`.
- The snapshot changes at most 12 times (`MaxRevision`). Everything in a state except the counters stops growing at 6 changes: 270 combinations at every bound from 6 to 24.
- The in-memory controller: no `database` option, so no lease and no reload.
- JavaScript runs one synchronous stretch at a time. An `await` that resolves at once is treated as a point where other requests may run, which allows more orders than Node does.
- Every adapter call returns or throws in the end. The built-in adapter's requests time out after 10 seconds (`adapters.ts:153`, `:189`).
- An adapter call in flight may still return success after `adapter.cancel()`. `createProtocolAdapter` checks `stopped` before it stores a credential (`adapters.ts:201`, `:353`), so for it this needs `cancel()` to land while `store.put` is pending: impossible with `MemoryCredentialStore`, possible with a store that does real I/O. The `AuthAdapter` interface does not require the check at all; the stub adapter in `tests/controller.test.ts` ignores `cancel()`.
- Which answer the provider gives is free: every answer the adapter code can return is tried.

## What is left out

- The durable controller: the `database` option, leases, the reload in `instance()` (`controller.ts:274-299`), `persist`, events, and polling on `redirect` (`controller.ts:417`).
- `connect`, resume, the 100-attempt limit, and `sweep` (`controller.ts:110-189`, `:225-235`, `:659-669`).
- `collect`, the credential broker and field validation (`controller.ts:380-401`, `:470-500`). A rejected submission changes nothing.
- The kinds `github-app` and `account-registration`, the adapters in `services.ts`, `github.ts`, `neon.ts` and `connectors/commands/registration.ts`, and the `adapter.retry()` and `adapter.initial()` hooks. F1 models only the shape of `requestHuman`.
- What the snapshot shows apart from the step: fields, messages, URLs, user codes, scopes.
- The credential store. When an answer is dropped after expiry, the adapter may already have stored the credential (`adapters.ts:202-208`); nothing here checks for that orphan.
- The poll throttles (`controller.ts:419`, `adapters.ts:423`): the model lets a poll start at any time.
- The OAuth `state` and PKCE check. A callback with the wrong `state`, such as one from an earlier attempt's provider tab, is `CallbackThrows`: it ends the new attempt in `error`.
- Whether a ceremony finishes in the end. The rules are about what must never happen, plus no dead end.
- More than one ceremony, the HTTP layer, and the owner check.

## The chart

`chart.mmd` is drawn by the `/statechart` skill from `Chart.cfg` and `view.mjs`. `Chart.cfg` is the code as written with a person who always has the current screen, so that the graph is small enough to draw; it also checks `TryAgainStartsClean`, so the chart marks where F2 breaks.

The chart hides three kinds of step, all from the stopped screens: cancel on `expired`, cancel on `error`, and the `error` screen expiring. Each only swaps one "Not connected" screen for another. The second round of the `form` flow, where the provider asks for a code it sent, stays inside "Enter your key, password or code".

## Files

| File | What it is |
|---|---|
| `CeremonySteps.tla` | the model and the rules |
| `CeremonySteps.cfg` | the code as written; must hold |
| `Finding*.cfg` | the code as written with one setting or rule of a finding; an open finding breaks it, a fixed one holds |
| `Broken*.cfg` | one check removed each; must fail |
| `check.sh` | runs all of the above and `conformance.test.ts`, and compares with what is expected |
| `conformance.test.ts` | what the model takes as given, the fix for F1 and the open F2, on the real controller |
| `Chart.cfg`, `view.mjs`, `chart.mmd` | the chart, and how it is drawn |

## Kept in step with the code

The coverage record and the sync commit are in `.claude/skills/verify-ceremony-steps/SKILL.md`.
