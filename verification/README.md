# Verification of the state machines in the server

The server holds several state machines that nobody wrote down as one. Each
folder here is a TLA+ model of one of them that points at the code line by
line, checked by TLC, with a conformance test where the model takes facts from
the code. Each has a project skill under `.claude/skills/verify-<area>/` that
tells the next agent how to rerun it against a change, how to tell a bug from
a modelling error, and which files it covers.

They were made with the `create-formal-verification-skill` skill from pstack
(ported to Claude Code in `.claude/`, see `.claude/pstack/PORTING.md`), and the
charts with its `statechart` skill.

| Area                                       | What is promised                                                                                           | Run                                      | Result today                                  |
| ------------------------------------------ | ---------------------------------------------------------------------------------------------------------- | ---------------------------------------- | --------------------------------------------- |
| [persistence](persistence/README.md)       | A worker whose lease was taken over never commits on its old fence; a stale revision never writes          | `verification/persistence/check.sh`      | Lease rules hold. 1 finding open              |
| [commands](commands/README.md)             | An external effect is never repeated blind, and an interrupted command always ends on record as uncertain  | `verification/commands/check.sh`         | 3 rules hold. 4 findings open                 |
| [ceremony-steps](ceremony-steps/README.md) | The screen changes only by an offered button, a pending provider answer or the deadline; end screens stay  | `verification/ceremony-steps/check.sh`   | Rules hold for six flows. 2 findings open     |
| [github-handoff](github-handoff/README.md) | One conversion per one-time code, nothing recorded after cancel, a token only after a checked installation, no dead end | `verification/github-handoff/check.sh`   | 3 parts hold. 4 dead ends open                |
| [connect-github](connect-github/chart.mmd) | The new kernel's GitHub flow as the person meets it (a chart; the flow itself is checked in `src/kernel`)  | `verification/tlc.sh connect-github ConnectGitHub` | 6 rules hold                        |

Every check compares what TLC finds with what its README records, so it exits
0 while the recorded findings are still present and fails when anything
changes: a rule that held and breaks, or a finding that is gone.

`verification/tlc.sh <area> <Spec> [Config]` runs one config with TLC 1.7.4,
downloaded once and checked against its hash. It needs Java 11 or later.

## Findings open in the server code

None of these is fixed here. Each is reproduced against the real code by the
area's conformance test or replay script, and each README gives the shortest
path in the code's own words.

**Commands** (`src/server/commands.ts`)

1. A second command id for the same step is admitted while the first call is
   unrecorded, so the handler runs twice. Admission writes neither the node nor
   the run, so the step still reads `pending` at the same revision.
2. Replaying the first id then overwrites a step the second completed with
   `uncertain`, and the run cannot move on.
3. A command in flight when its run is cancelled stays `running` for ever: the
   takeover needs an active run. No reconciliation entry is written.
4. Revalidation rewrites an `uncertain` step as `failed`, which lets a new
   command run the handler again while the first is still unresolved.

**Ceremony steps** (`src/server/controller.ts`)

1. A `request-human` answer that lands after expiry revives the ceremony;
   `run()` has the guard and this path does not.
2. Retry keeps the cancelled attempt's outcome, and cancel then shows it again.
   Whether a cancelled anonymous outcome should survive retry is a product
   decision.

**GitHub hand-off** (`src/server/recipes/github.ts`)

A dead end is a run that is active, not connected, and where only Cancel still
does anything. All four rest on one mismatch: the engine never reruns a step
in state `uncertain`, a thrown handler becomes `uncertain`, and the recovery
page serves only the app step in two phases.

1. The app is created and stored and the run is stranded: one unanswered
   GitHub call when the app step re-checks it, or the same return arriving
   twice with no failure at all.
2. A hand-off that expires as its page is being served is stranded.
3. One unanswered GitHub call strands the install or the token step; there is
   no recovery page for those.
4. An app created under a different GitHub account can be neither replaced nor
   recovered.

After Cancel, the next run for the same account is refused in cases 1, 2 and 4.

**Persistence** (`src/server/persistence/index.ts`)

1. A record deleted and created again takes its old revision number, so a
   write that names the revision a caller read before the delete is accepted.
   The per-run OAuth ticket in `src/server/authored-human.ts` deletes and
   re-creates under one key and carries a revision across transactions.

## Scope

A model covers what its README says and nothing else. Each lists its bounds
and what it leaves out. A pass means the rules hold for the model at those
bounds, and the conformance test is what ties the model to the code.
