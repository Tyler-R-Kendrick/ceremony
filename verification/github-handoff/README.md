# GitHub App hand-off: formal check

A TLA+ model of "Connect GitHub" (create the app, install it, get a token) in
the production path, checked with TLC 1.7.4. The model is
`GitHubHandoff.tla`. `github.ts` below always means
`src/server/recipes/github.ts`.

**Property.** During one "Connect GitHub" run, in whatever order returns from
GitHub, expiries, recovery, restart and cancel arrive: the one-time manifest
code of a hand-off is sent to GitHub at most once, nothing is recorded after
the hand-off is cancelled, only an installation that GitHub confirmed is
recorded and given a token, and the person is never left where Cancel is the
only thing that still works.

**Harm if it breaks.** A person ends up with a GitHub App that Ceremony lost
or created twice, a cancelled connection that still stores an app or a token,
a token for an installation nobody checked, or a connection that can neither
finish nor be repaired.

**Result at the sync commit.** The first three parts hold. The last part does
not: one kind of dead end is left, finding 4 under [Findings](#findings).
The three steps are registered replay `read-only` (`github.ts:348`), so the
engine runs a step recorded `uncertain` again under a new command id
(`commands.ts:930-937`). That removed the dead ends of findings 1, 2 and 3.
Each finding was replayed against the real code.

## Run it

```sh
verification/github-handoff/check.sh
```

From the repo root, about 20 seconds, Java 11 or later. It runs the
configurations below through `verification/tlc.sh` (TLC 1.7.4, checksum
pinned) and compares each result with the result recorded here. Exit 0 means
every result is as recorded, including the findings that still fail.
`BrokenReplay.cfg` is not in `check.sh`; run it alone as shown below.

One configuration alone: `verification/tlc.sh github-handoff GitHubHandoff
DeadEndGitHubSilent` (the last word is the `.cfg` name; leave it out for
`GitHubHandoff.cfg`).

| Configuration | What it checks | Recorded result |
| --- | --- | --- |
| `GitHubHandoff.cfg` | The code as written; two returns, GitHub may fail anywhere, processes may die, wrong account possible. Rules: `TypeOK`, `ConvertedAtMostOnce`, `CancelledStaysCancelled`, `InstallationCheckedBeforeToken`, `AppReadyNeverStranded`, `ExpiredHandoffNeverStranded`, `LaterStepsNeverStranded`, `OnlyKnownDeadEnds`, `TimersNeverRescue` | No error. 111,398 states, depth 39, 5 s |
| `NoDeadEndOneAtATime.cfg` | The code as written with none of the findings' triggers: one request at a time, GitHub fails only while a return is handled, right account, no process dies. Rule: `NoDeadEnd` | No error. 349 states |
| `DeadEndGitHubSilent.cfg` | The code as written; `AppReadyNeverStranded` | No error: `prepare-app` is replay `read-only`, so an `uncertain` app step runs again |
| `DeadEndReplayedReturn.cfg` | The code as written; `AppReadyNeverStranded` | Violated: finding 1 |
| `DeadEndExpiry.cfg` | The code as written; `ExpiredHandoffNeverStranded` | Violated: finding 2 |
| `DeadEndLaterStep.cfg` | The code as written; `LaterStepsNeverStranded` | No error: `authorize-installation` and `verify-access` are replay `read-only`, so an `uncertain` step runs again |
| `DeadEndWrongAccount.cfg` | The code as written; `WrongAccountNeverStranded` | Violated: finding 4 |
| `BrokenAdmit.cfg` | `github.ts:669` without the revision; `ConvertedAtMostOnce` | Violated, as it must be |
| `BrokenFence.cfg` | `github.ts:695` removed; `CancelledStaysCancelled` | Violated, as it must be |
| `BrokenSave.cfg` | `github.ts:289-290` removed; `CancelledStaysCancelled` | Violated, as it must be |
| `BrokenInstallCheck.cfg` | `github.ts:730` removed; `InstallationCheckedBeforeToken` | Violated, as it must be |
| `BrokenReplay.cfg` | `github.ts:348` removed; `LaterStepsNeverStranded` | Violated, as it must be |
| `Chart.cfg` | For the chart only: one return, one request at a time | No error |

## The rules

| Rule | In plain words |
| --- | --- |
| `ConvertedAtMostOnce` | For one nonce, `POST /app-manifests/{code}/conversions` is sent at most once. |
| `CancelledStaysCancelled` | After `cancel()` (`github.ts:849-893`) has committed, the run's record stays `cancelled`, a cancelled setup record keeps its phase and app, and no app, installation or connection artifact is written. |
| `InstallationCheckedBeforeToken` | The installation artifact, and so the installation a token is minted for, is one that `checkInstallation` (`github.ts:894-926`) accepted. |
| `NoDeadEnd` | While the run is active and not connected, some request, return or step other than Cancel can still change something. Running a step again from `uncertain` counts only when that run can end other than `uncertain` (`RerunMoves`). It is the conjunction of the four `...NeverStranded` rules and `OnlyKnownDeadEnds`. |
| `OnlyKnownDeadEnds` | There is no dead end other than the one kind left under Findings (finding 4). The normal configuration checks it, with the three `...NeverStranded` rules of the fixed findings, in place of `NoDeadEnd`; it fails as soon as a new kind appears. |
| `TimersNeverRescue` | Once in a dead end, no timer running out makes anything possible again. It justifies that `NoDeadEnd` counts only one timer as a way forward: the 60-second claim that must lapse before "Start a new registration" goes through (`github.ts:783-787`). It is read while no step is in flight, because from a dead end the engine may still start a rerun that can only fail again. |

`NoDeadEnd` asks that some step is possible, not that "connected" can still
be reached. A loop of steps that never ends would not be caught, except the
loop of running a step again that can only end `uncertain` again:
`RerunMoves` leaves that out of the ways forward.

## Findings

All four were dead ends at commit `2b14e0720188516fc3e3934f51cf2a4359fedab3`:
step state and hand-off phase no longer fit, the engine never ran an
`uncertain` step again, and the recovery page is the only way out of
`uncertain`, for step `prepare-app` only (`github-runtime.ts:1073-1086`).
Each list is TLC's shortest path for that code, in the code's words, with
the line numbers of the sync commit.

Now the three steps are registered replay `read-only` (`github.ts:348`), and
the engine runs a step recorded `uncertain` again under a new command id
(`commands.ts:930-937`). The model checks the effect at the sync commit:

| Finding | Configuration | Model now |
| --- | --- | --- |
| 1, one unanswered call | `DeadEndGitHubSilent.cfg` | Holds: the app step runs again, `prepare()` finds the stored app and completes |
| 1, a replayed return | `DeadEndReplayedReturn.cfg` | Holds: as above, once the first return has written `app-ready` |
| 2 | `DeadEndExpiry.cfg` | Holds: the app step runs again, `prepare()` reads the record afresh, writes phase `uncertain` (`github.ts:418-419`), and "Start a new registration" is offered |
| 3 | `DeadEndLaterStep.cfg` | Holds: the install or token step runs again |
| 4 | `DeadEndWrongAccount.cfg` | Violated: running the app step again only fails `verifyApp` again |

`check.sh` and the configuration table above still record findings 1 (a
replayed return) and 2 as violated, so for those two lines it reports
`CHANGED ... now: pass`. Both were replayed against the code at the sync
commit with a fake GitHub: after the replayed return the app step ran again
and completed with one conversion; after the expiry the app step ran again,
stayed `uncertain`, and `registrationRestartAvailable()` returned true.

### 1. The app exists and is stored, but the run is stranded

State: hand-off phase `app-ready`, step `prepare-app` in state `uncertain`.
`recover()` accepts only the phases `uncertain` and `converting`
(`github.ts:812-813`), `restartRegistration()` only `uncertain`
(`github.ts:778`), `advance` refuses the step, and the hand-off page and the
return URL refuse the phase (`github.ts:594`, `644`).

One unanswered GitHub call, nothing else (`DeadEndGitHubSilent.cfg`, 10
steps):

1. The engine runs `prepare-app`; `prepare()` creates the hand-off in phase
   `registration` (`github.ts:436-480`).
2. The person opens the hand-off page; `human()` sets `handoffIssued` and
   posts the manifest to GitHub (`github.ts:552-587`).
3. The person creates the app; GitHub sends them back with a code.
4. `callback()` claims the fence and writes `converting`, nonce `consumed`
   (`github.ts:660-672`), converts the code and stores the app (`674-691`),
   verifies it and writes `app-ready` (`692-702`).
5. The route advances the run (`github-runtime.ts:1338`). `prepare()` finds
   the stored app and calls `verifyApp` (`github.ts:400`). GitHub does not
   answer within 15 seconds; `prepare()` throws.
6. The engine records the exception as step state `uncertain`
   (`commands.ts:1055-1058`).

No failure at all, only a second request while the first is converting
(`DeadEndReplayedReturn.cfg`, 10 steps):

1. to 3. as above.
4. `callback()` writes `converting` (`github.ts:660-672`) and waits for
   GitHub.
5. The engine runs `prepare-app` meanwhile. One way: the same return arrives
   again, is refused (`github.ts:644`), and the route then advances the run
   (`github-runtime.ts:1323-1324`). `prepare()` sees `converting` and returns
   `uncertain` (`github.ts:429-435`).
6. The first `callback()` stores the app and writes `app-ready`
   (`github.ts:674-702`). Its own `advance` is refused.

The process dying between the two transactions of a recovery
(`github.ts:838-845`, then `github-runtime.ts:1192-1272`) ends in the same
state.

### 2. The hand-off expired and nothing may move it on

State: phase `registration`, expired, `handoffIssued`, step `prepare-app` in
state `uncertain`. Only `prepare()` moves an expired registration on
(`github.ts:409-428`), and the engine no longer runs it.

`DeadEndExpiry.cfg`, 7 steps:

1. `prepare()` creates the hand-off.
2. The engine runs `prepare-app` again; `prepare()` reads the record:
   `registration`, page not yet shown (`github.ts:388-393`).
3. The person opens the hand-off page; `human()` writes `handoffIssued`
   (`github.ts:552-571`). The record's revision moves on.
4. The hour passes.
5. `prepare()` finds the hand-off expired (`github.ts:409-411`) and writes
   with the revision it read in step 2 (`github.ts:425`):
   `PersistenceConflict`. Only the creation transaction retries
   (`github.ts:475-479`), so the exception leaves `prepare()` and the step
   becomes `uncertain`.

TLC's path keeps `prepare()` in flight across the end of the hour. The
likelier order of the same race, and the one replayed: `human()` passes its
own expiry check just before the hour ends (`github.ts:539`) and calls
GitHub; the hour ends; `prepare()` reads; `human()` writes `handoffIssued`;
`prepare()` writes and conflicts.

### 3. One unanswered GitHub call strands the install step or the token step

State: step `authorize-installation` or `verify-access` in state `uncertain`.
There is no recovery page for these steps.

`DeadEndLaterStep.cfg`, 12 steps: steps 1 to 4 of finding 1, then
`prepare-app` completes, the engine runs `authorize-installation`,
`install()` calls `verifyApp` (`github.ts:489`), GitHub does not answer, and
the step becomes `uncertain`. Any GitHub call in `verifyAccess()`
(`github.ts:939-973`) does the same to `verify-access`.

### 4. An app created under another GitHub account cannot be replaced

State: phase `uncertain` (or `converting`) with the wrong app stored, step
`prepare-app` in state `uncertain`. For a user account the hand-off goes to
`https://github.com/settings/apps/new` (`github.ts:574`), which creates the
app under whichever account the browser is signed in to.

`DeadEndWrongAccount.cfg`, 10 steps: steps 1 to 3 of finding 1 with the
other account, then `callback()` converts the code and stores the app
(`github.ts:674-691`); `verifyApp` rejects its owner (`github.ts:257-264`);
the catch block writes `uncertain` and keeps the app (`703-718`); the route
advances, `prepare()` verifies the stored app again (`398-400`) and throws.
Each later run of the app step throws the same way, so running it again is
no way forward. `restartRegistration()` refuses because an app is stored (`github.ts:779`),
the page does not offer it (`github.ts:760`), and `recover()` takes only an
app that passes `verifyApp`. The model assumes the person has no other app
to enter.

### What Cancel does afterwards

Replayed for findings 1 and 2: after Cancel, `cancel()` leaves the setup
record `cancelled` and not `restartable` (`github.ts:864-877`), the next
run's `prepare()` throws "GitHub setup requires reconciliation"
(`github.ts:443-447`), and that run is `uncertain` at once with a recovery
page that fails. Finding 4 takes the same path (not replayed). After finding
3 the next run completed the app step from the saved artifact. The refusal
itself is intended (`tests/github-children.test.ts:444-458`); together with
a dead end it blocks the account until the configuration changes.

### Replays

Each finding was replayed once through `createGitHubRuntime` with an
in-memory store and a fake GitHub: findings 1 (both routes), 2, 3 and 4 end
in the states above, and every exit named above is refused. The replays are
not in the repo. At the sync commit, `tests/github-children.test.ts:771-864`
drives the three steps through the engine with one GitHub path unanswered
and checks that each step runs again to completion with one conversion.

### Seen on the way, not a broken rule

- For up to 60 seconds after a failed return, "Start a new registration" is
  refused: the return never releases its claim (`github.ts:661-665`) and
  the restart claims the same key (`github.ts:783-787`).
- Between the run's cancel (`commands.ts:452-471`) and the hand-off's cancel
  (`github.ts:849-893`) a request that already passed `authorize` can still
  store an artifact. `CancelledStaysCancelled` speaks about the time after
  the second transaction.

## Broken variants

Each removes one check through a constant and must fail. Paths are TLC's
shortest.

| Configuration | Constant = FALSE | Code | What TLC finds |
| --- | --- | --- | --- |
| `BrokenAdmit.cfg` | `AdmitComparesRevision` | `github.ts:669` | Two deliveries of one return both pass `read()`. The first claims the fence, writes `converting` and converts the code. Its 60-second claim lapses. The second claims the fence, its put is no longer compared with the revision it read, and it converts the code again. 11 steps |
| `BrokenFence.cfg` | `AppReadyAssertsFence` | `github.ts:695` | A return has stored the app. The person cancels; `cancel()` marks both records `cancelled` and ends the fence. The return's last transaction writes `app-ready` over `cancelled`. 10 steps |
| `BrokenSave.cfg` | `SaveChecksCancelled` | `github.ts:289-290` | `prepare()` has read the stored app. The person cancels and `cancel()` commits. `saveArtifact` writes the app artifact afterwards. 11 steps |
| `BrokenInstallCheck.cfg` | `ReturnChecksInstallation` | `github.ts:730` | A return carries an installation id GitHub would reject; it is recorded as `installed` with an installation artifact. 13 steps |
| `BrokenReplay.cfg` | `RerunUncertain = {}` | `github.ts:348` | The app is created, confirmed and stored, and the app step completes. The engine runs `authorize-installation`; GitHub does not answer `verifyApp`, the step is `uncertain`, and the engine never runs it again. 12 steps |

In the `BrokenFence` and `BrokenSave` paths the cancel must land between an
`authorize` call (`github.ts:693`, `285`) and the transaction after it. The
model allows that; see Assumptions.

## Model and code

One action is one store transaction, or one GitHub call together with the
transaction that follows it. Whatever an awaited call separates in the code
is a separate action.

| Action | Code |
| --- | --- |
| `StepStarts` | `commands.ts:757-1015` (step state check `930-937`, one call per step `941-947`, run lease `964-968`); for `prepare-app` also the reads at `github.ts:387-398`. From `uncertain` only for a step in `RerunUncertain`, the steps registered replay `read-only` (`github.ts:348`; `registry.ts:97-101`) |
| `HandoffPrepared` | `github.ts:436-480` |
| `AppConfirmed` | `github.ts:399-407`, `284-295`, engine verify `350-378`; step state written at `commands.ts:1083-1135` |
| `AppCheckUnanswered` | `github.ts:400` or `358` throws (`230-238`, `257-264`); `commands.ts:1055-1058` |
| `HandoffLapsed` | `github.ts:409-428` |
| `StepStillWaiting`, `StepMarkedUnclear` | `github.ts:429-435` |
| `AppStepRefused` | `github.ts:396-397`, `439-440`, `289-290` |
| `InstallHandoffPrepared` | `github.ts:482-535` |
| `InstallConfirmed` | `github.ts:490-495`, engine verify `359-364` |
| `InstallStepRefused` | `github.ts:489`, `503-504` |
| `TokenStored` | `github.ts:927-983` |
| `AccessStepRefused` | `github.ts:939-973`, `289-290` |
| `PageOpens` | `github-runtime.ts:822-905`, `1348`; `github.ts:537-551` |
| `PageRenders` | `github.ts:552-587`; `github-runtime.ts:1374-1385` |
| `PageFails` | `github.ts:554-565`; `github-runtime.ts:1348-1364` |
| `ReturnArrives` | `github-runtime.ts:1320-1322`; `github.ts:637-648` |
| `ReturnAdmitted`, `ReturnRefused` | `github.ts:649-672` |
| `ConversionSaved` | `github.ts:674-691` |
| `ConversionDropped` | `github.ts:684`, `703-709` |
| `ConversionFails` | `github.ts:674-681`, `703-718` |
| `AppVerified` | `github.ts:692-702` |
| `AppVerifyFails` | `github.ts:692-693`, `703-718` |
| `InstallReturnArrives` | `github-runtime.ts:741-754`; `github.ts:70-99`, `637-648`, `722-729` |
| `InstallReturnRecorded` | `github.ts:730-754` |
| `InstallReturnRefused` | `github.ts:730` (`894-926`), `732-737` |
| `RecoveryStarts` | `github-runtime.ts:1073-1136`; `github.ts:804-813` |
| `RecoveryStoresApp` | `github-runtime.ts:1139-1188`; `github.ts:814-845` |
| `RecoveryFails` | `github.ts:833-836`, `840-844` |
| `RecoveryReleasesStep` | `github-runtime.ts:1190-1272` |
| `RegistrationRestarted` | `github-runtime.ts:1192-1272` with `github.ts:764-801` |
| `YouCancel` | `commands.ts:443-473` |
| `CancelReachesHandoff` | `github-runtime.ts:756-776`; `github.ts:849-893` |
| `HandoffExpires` | `expires` set at `github.ts:423`, `459`, `795`; read at `411`, `539`, `646` |
| `InstallHandoffExpires` | `expires` set at `github.ts:511`; read at `507`, `539`, `646` |
| `ClaimLapses` | `github.ts:661-665`; `persistence/index.ts:254-263`, `399-440` |
| `ReturnDies`, `RecoveryDies` | The process dies between two awaited calls |
| `Done` | Nothing; lets TLC end in a finished state |

| Variable | Code |
| --- | --- |
| `run` | Run record `status` (`commands.ts:461-465`, `1096-1100`) |
| `step` | Node records of `prepare-app`, `authorize-installation`, `verify-access` (`commands.ts:1119-1135`). `open` stands for every state the engine may run |
| `eng` | The command in flight (`commands.ts:964-1015`) and what `prepare()` read (`github.ts:387-398`) |
| `setup`, `issued`, `app` | `State.phase`, `handoffIssued`, `app` of the record `github-setup:{scope}` (`github.ts:27-46`, `175-181`) |
| `expired`, `instExpired` | `State.expires` compared with the clock |
| `claim` | Row of `ceremony_claims` for the setup key (`persistence/index.ts:204-207`) |
| `local` | The record `github:{runId}` (`github.ts:168-174`). `shared` means it carries `sharedSetup`, so `read()` returns the setup record (`github.ts:194-209`) |
| `appArt`, `instArt`, `token` | Artifact records (`github.ts:47-54`, `182-193`) |
| `ret`, `page`, `rec` | Where a `callback()`, a `human()` and a recovery request stand between their transactions. `...Stale` means the record moved since the request read it, so its compare-and-set fails (`persistence/index.ts:345-360`) |
| `converted`, `created`, `haveRight`, `frozen`, `deadSeen` | Bookkeeping for the rules; not in the code |

## Bounds

- One run, one account, one configuration.
- Two deliveries of a return (`Returns = {r1, r2}`), reused without limit;
  one hand-off page request, one recovery request and one engine step in
  flight at a time.
- Installation ids are `good` or `bad`; apps are `right` or `wrong` account.
- Time is three timers that may run out at any moment: the hand-off hour,
  the install hand-off hour, the 60-second claim.
- Revisions and nonces carry no numbers. A writer marks the requests that
  still hold the old revision; a return always carries the current nonce.

## Assumptions

- A store transaction is atomic and serial against the others
  (`persistence/index.ts:485-525`).
- GitHub converts a manifest code once.
- `authorize` (`github-runtime.ts:276-287`) is not a guard in the model: a
  request may have passed it just before a cancel lands. The model therefore
  allows more than is likely, never less.
- The engine behaves as `commands.ts` reads: a `complete` step is not run
  again, an `uncertain` step is run again only when its operation is
  registered replay `read-only`, one call per step is in flight, and a
  step's state is written by the step only while the run is active and the
  lease holds. Cancel records a step whose call is in flight `uncertain`
  (`commands.ts:466-470`); the model leaves the step as it was, since after
  Cancel no rule reads it.
- For recovery the person has only the apps this flow made them create.

## Left out

- Several runs that share one setup record: subscribers, the 32-run limit,
  `activeSetupSubscriber` (`github.ts:597-636`), the `restartable` flag.
- Artifacts and tokens expiring, and `revalidate` (`commands.ts:546-665`).
- An engine worker dying and the lease takeover (`commands.ts:811-899`).
- A configured app (`options.app`) and configuration rotation.
- Scope, origin, account and URL checks, the recovery ticket and collector
  (`github-runtime.ts:1097-1188`), and the routing record of the
  installation return beyond "the return reaches the run".
- Cancel after the connection is complete.
- GitHub-side changes after a return, such as uninstalling the app.
- The legacy adapter `src/server/github.ts`. It keeps phase and progress in
  one record in one process, with no fence, no revision compare and no
  separate step state. Nothing here describes it.
- `verification/connect-github/` models another implementation,
  `src/kernel/flows/github-app.ts`.

## Chart

`chart.mmd` is the flow as the person connecting meets it, drawn by the
`/statechart` skill from `GitHubHandoff.tla` with `Chart.cfg` and
`view.mjs`. It hides nothing; "you cancel" is one arrow from the parent
state. `Chart.cfg` takes one request at a time, GitHub may fail during the
return and the app step, and the person uses the right account, so the
chart has no dead end: after one unanswered call the app step runs again.

## Sync

The model describes these files at commit
`36710d246105a496a482e232ed99cb2934f67906`:

- `src/server/recipes/github.ts`: all of `AsyncGitHubChildren`
- `src/server/recipes/registry.ts`: `effectiveReplay`,
  `replayRerunsUncertain`
- `src/server/github-runtime.ts`: `childOptions.authorize`, `humanReturn`,
  `cancel`, `human`, `githubHumanResponse`, `advance`
- `src/server/commands.ts`: `cancel`, `advance`, `execute`
- `src/server/persistence/index.ts`: `put`, `claim`, `assertFence`,
  `cancel`

`.claude/skills/verify-github-handoff/SKILL.md` says how to keep it in step.
