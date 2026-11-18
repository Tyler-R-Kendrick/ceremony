---
name: verify-github-handoff
description: "Check a change to the GitHub App hand-off (\"Connect GitHub\": create the app, install it, get a token) against its TLA+ model. Use before you finish any change to src/server/recipes/github.ts, to the GitHub callback, recovery, restart, cancel or installation-return code in src/server/github-runtime.ts, or to how src/server/commands.ts treats an uncertain step; when you add a hand-off phase, a callback path or a recovery option; when you fix one of the known dead ends; and for questions about replayed or concurrent callbacks, the one-time manifest code, phases converting and uncertain, or a run stuck with only Cancel left."
---

# Verify the GitHub App hand-off

`src/server/recipes/github.ts` (`AsyncGitHubChildren`) moves one "Connect GitHub" run through the phases `registration`, `converting`, `app-ready`, `installation`, `installed`, with `uncertain` and `cancelled` beside them. `src/server/github-runtime.ts` routes the pages, the returns from GitHub, recovery, restart and cancel into it, and `src/server/commands.ts` runs its three steps. A TLA+ model of all three for one run lives in `verification/github-handoff/`, and TLC checks one promise:

> In whatever order returns from GitHub, expiries, recovery, restart and cancel arrive, the one-time manifest code of a hand-off is sent to GitHub at most once, nothing is recorded after the hand-off is cancelled, only an installation that GitHub confirmed is recorded and given a token, and the person is never left where Cancel is the only thing that still works.

If it breaks, a person ends up with a GitHub App that Ceremony lost or created twice, a cancelled connection that still stores an app or a token, a token for an unchecked installation, or a connection that can neither finish nor be repaired.

All four parts hold, and `GitHubHandoff.cfg` checks `NoDeadEnd` itself. `verification/github-handoff/README.md` lists the four dead ends the code had as findings 1 to 4. The three steps are registered replay `read-only`, so the engine runs an `uncertain` step again; that removed findings 1 to 3. A return that `callback()` refuses throws `GitHubCallbackRefused`, and the return route then does not advance the run; the rule `RefusedReturnLeavesRun` checks this, and `BrokenRefusal.cfg` shows it failing without that check. When `prepare()` finds the registration hand-off expired and its write meets `PersistenceConflict`, it reads the record again and decides from what is stored now; the rule `ExpiryWrittenByTheStep` checks this, and `BrokenExpiryRetry.cfg` shows it failing without the retry. Finding 4 is fixed: "Start a new registration" replaces an app owned by another account, and a `converting` left by a return that died, recording the app left on GitHub (`RestartReplacesForeignApp`, `BrokenRestart.cfg`). Two rules close the README's two notes: a failed return ends its claim, so the restart need not wait (`RestartWithoutWaiting`, `BrokenRelease.cfg`), and once the run's cancel has committed nothing is stored (`NothingStoredAfterCancel`, `BrokenRunCheck.cfg`).

## Does your change touch it

The model describes these files and functions. A change to any of them touches it:

| File | Functions |
| --- | --- |
| `src/server/recipes/github.ts` | Everything in `AsyncGitHubChildren`: `read`, `api`, `verifyApp`, `artifact`, `saveArtifact`, `register` (its `verify`), `prepare`, `install`, `human`, `callback`, `registrationRestartAvailable`, `restartRegistration`, `recover`, `cancel`, `checkInstallation`, `verifyAccess`; the `State` and `Artifact` types; `resolveGitHubInstallationRun` |
| `src/server/recipes/registry.ts` | `effectiveReplay`, `replayRerunsUncertain`; the `replay` each GitHub step registers |
| `src/server/github-runtime.ts` | `childOptions.authorize`, `humanReturn`, `cancel`, `human`, `githubHumanResponse` (recovery page and POST, callback, hand-off page), `advance` |
| `src/server/commands.ts` | `cancel`, `advance`, `execute`: which step states may run, what a thrown handler becomes, when a step's state is written |
| `src/server/persistence/index.ts` | `put`, `claim`, `assertFence`, `cancel` |

To see what changed since the model was last confirmed:

```sh
git diff 2eed4a05901ef745f53e9fc9a615dcb892b033bb -- src/server/recipes/github.ts src/server/recipes/registry.ts src/server/github-runtime.ts src/server/commands.ts src/server/persistence/index.ts
```

No output means the model still describes the code; run the check anyway if your working tree changes these files. The store and the engine have their own checks, `verify-persistence` and `verify-commands`. This model takes their behaviour as given, so a change there needs those skills too.

Not covered, so this skill says nothing about it: several runs sharing one setup record, expiring artifacts and tokens, a configured app, the legacy adapter `src/server/github.ts`, and the rest of the list under "Left out" in the README.

## Run the check

From the repo root:

```sh
verification/github-handoff/check.sh
```

It takes about 20 seconds and needs Java 11 or later. The first run downloads TLC 1.7.4 through `verification/tlc.sh` and checks its checksum. Each line is one configuration:

- `ok` on `GitHubHandoff`: every rule holds, `NoDeadEnd` included.
- `ok` on `NoDeadEndOneAtATime`: without the triggers of the four findings (overlapping requests, GitHub silent during a step, the wrong GitHub account, a dying process) there is no dead end.
- `ok` on a `DeadEnd...` configuration: that dead end, one of the four findings, is fixed and stays fixed. All four are fixed; no line expects `FINDING` any more.
- `ok` on a `Broken...` configuration: the model with one check removed fails, as it must. This shows that the rule can fail. `BrokenReplay.cfg` takes away replay `read-only` from the three steps, so an `uncertain` step never runs again; `LaterStepsNeverStranded` must be violated.
- `CHANGED`: the result differs from the recorded one. TLC's output follows. Exit code 1.

Run one configuration with `verification/tlc.sh github-handoff GitHubHandoff DeadEndExpiry`; the last word is the `.cfg` name.

## Read the result with /statechart

Read every result with the `/statechart` skill. Give it `GitHubHandoff.tla`, the configuration, and `view.mjs` as the view, in a scratch copy of the folder as that skill says. For a rule that breaks it gives the shortest path in the person's words ("you create the app on GitHub and GitHub sends you back", "Ceremony starts the app step"). Translate each step into the code with the "Model and code" table in the README.

`Chart.cfg` is the configuration for the picture: one return, one request at a time. `chart.mmd` is the saved result. When a change alters the flow, draw it again with `/statechart` from `Chart.cfg` and `view.mjs`, replace `chart.mmd`, and give new actions a label in `view.mjs` in the person's words.

## When the model no longer matches your change

Do this first, before you trust any result. For each function you changed, find its actions in the README's "Model and code" table and compare them with the new code:

- One action is one store transaction, or one GitHub call with the transaction that follows it. If you moved an `await` or split or merged a transaction, split or merge the action.
- A check you add or remove inside a transaction is a guard of that action.
- A new phase, record field or request needs a variable or a value, a line in `TypeOK`, and a row in both README tables.
- Keep the line numbers in the `.tla` comments and in the README right.

Then run the check.

## Real bug or modelling error

When `GitHubHandoff` shows `CHANGED`, or a `DeadEnd...` line names a different rule:

1. Read the path with `/statechart`.
2. Walk it against the code, one action at a time, with the README table. For each step ask: can this transaction or GitHub call happen in this state, in this order?
3. If a step cannot happen in the code, the model is wrong. Fix the action and say in the README what you changed and why.
4. If every step can happen, it is a real bug. Replay it against the real code: build a runtime with `createGitHubRuntime`, an in-memory `SQLiteCeremonyStore` and a fake `github.fetch`, as `tests/github-runtime-http.test.ts` does, and drive `runtime.commands.advance` and `runtime.human` in the order of the path. Then fix the code or report the bug. Do not weaken the rule or narrow a configuration to get a pass.

`NoDeadEnd` failing means a dead end: a state where the run is active, not connected, and nothing but Cancel is possible. `TimersNeverRescue` failing means a timer now opens a way out of a state the model calls a dead end; decide whether waiting is a fair way forward there, as `WaitThenRestart` does for the 60-second claim.

When a `Broken...` line shows `CHANGED` with `now: pass`, the rule no longer catches the removed check. Either the constant lost its effect in your edit of the model, or another check now covers the same case. Find out which before you go on.

## When a change opens a dead end again

All four findings are fixed, and `GitHubHandoff.cfg` checks `NoDeadEnd` together with every `...NeverStranded` rule and `ExpiryWrittenByTheStep`. A change that brings a dead end back shows `CHANGED` on `GitHubHandoff` and on the finding's `DeadEnd...` line. Do not move the rule out of `GitHubHandoff.cfg` to make the line pass: fix the code, or, if the dead end is intended, record it as a finding in the README and say why.

## When a change is intended to alter a rule

Change the rule only when the promise itself changes, for example a second conversion that the person explicitly confirms. Write the new promise in plain words in the README first, then change the invariant, then add or adjust a `Broken...` configuration that shows the new rule failing. A rule nobody has seen fail proves nothing.

## Sync commit

The model was last confirmed against the code at:

```
2eed4a05901ef745f53e9fc9a615dcb892b033bb
```

Move this commit forward, here and in the README's "Sync" section, only after you have compared every changed function in the table above with its actions and the check gives its recorded results at the new commit. If covered code changed and nobody did that, use `/maintain-formal-verification-skill` to bring the model back in line.
