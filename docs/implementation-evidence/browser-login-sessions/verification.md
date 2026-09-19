# Verification record

Commands as run, with their verbatim counts. Nothing here is carried over from a
previous report or inferred from a partial run.

Environment: Node `v22.22.2`, linux/x64, `playwright-core` `1.63.0`,
Chromium `153.0.8010.12`, Firefox `155.0`, WebKit `26.6`. See `baseline.md` for
why the toolchain is Node 22 rather than the project's Node 24 convention, and
what that means for these results.

## Full deterministic suite

```
node scripts/test.mjs all
```

| Run                                     | Tests    | Pass     | Fail  | Skipped | Exit  |
| --------------------------------------- | -------- | -------- | ----- | ------- | ----- |
| Baseline `d741eed` (separate worktree)  | 1135     | 1106     | 29    | 0       | 1     |
| This work, before the PostgreSQL repair | 1205     | 1176     | 29    | 0       | 1     |
| **This work, complete**                 | **1302** | **1302** | **0** | **0**   | **0** |

The 29 failures in the first two runs are the same set, all PostgreSQL /
mounted-runtime tests, reproduced at the pristine baseline. `baseline.md`
records their root cause and the fixture repair. No test was skipped, disabled
or excluded in any run.

The final run includes the Firefox extension suites and the added verifier and
login-service cases: 167 more tests than the baseline, all passing, with the
baseline's 29 failures resolved at their root cause rather than excluded.

## Focused suites

```
npx tsx --test --test-concurrency=1 tests/browser-login-conformance.test.ts
```

```
1..4
# tests 25
# suites 4
# pass 25
# fail 0
# cancelled 0
# skipped 0
# todo 0
```

Eight cases on each of Chromium, Firefox and WebKit, plus one engine-identity
case. Every assertion is answered by the fixture server's own records.

```
npx tsx --test --test-concurrency=1 tests/browser-targets.e2e.test.ts
```

```
1..3
# tests 15
# suites 3
# pass 15
# fail 0
# cancelled 0
# skipped 0
# todo 0
```

Five cases on each engine. Each stages the race inside a paused resolver and
then asks a recording server whether the canary arrived. It never did.

```
npx tsx --test tests/browser-session-lifetime.test.ts
```

```
1..4
# tests 16
# suites 4
# pass 16
# fail 0
```

```
npx tsx --test tests/login-plan.test.ts
```

```
1..6
# tests 30
# suites 6
# pass 30
# fail 0
```

```
npx tsx --test tests/browser-driver.test.ts
```

```
# tests 32
# suites 0
# pass 32
# fail 0
```

```
npx tsx --test tests/persistence.test.ts
```

```
# tests 6
# suites 0
# pass 6
# fail 0
```

(2 of these 6 failed at the pristine baseline in this container.)

## Static gates

```
npx tsc --noEmit          # no output, exit 0
npm run format:check      # all files use Prettier code style
```

## Not run

These are separate evidence classes. They are listed as **not run**, which is
different from passing:

- `npm run verify` end to end (it also runs `test:coverage`,
  `test:security:mutation`, three builds and `test:e2e`).
- `npm run verify:live`, `npm run test:live:attended`, `npm run verify:release` —
  these need authorized live configuration, accounts or devices that this
  environment does not have. No result may be invented for them.

## A known intermittent, stated rather than smoothed over

`browser-login-conformance` intermittently fails on GitHub's runners, under
`test:coverage` at `--test-concurrency=4`, and has never once failed here. The
assertions carry the reason, and the reason is:

```
expected a verified login, got {"status":"blocked","reason":"stale-document"}
```

**Measured on a commit that already carries the `no-observation` split.** #53
separated two faults that had shared the name `stale-document`: a page that
moved under an approved element, found by guards comparing the held document
against the live one, and "there was no approved observation at all", raised
before any of those guards run. On `efa4a98` the failure reports
`stale-document` - so it comes from a document comparison, and the guards did
run.

This section has now been wrong in both directions, and both are worth keeping
written down because the cost each time was a day of reading the wrong code.

- It first said the cause was a document that moved. That was inference from a
  name that meant two things.
- It was then corrected to the missing-approval branch, on the strength of
  #53's reproduction, in which all fifteen refusals came from there and none
  from either comparison. That reproduction is real; it is not what CI hits.
  Under the split, CI says `stale-document`, which is the branch the earlier
  text guessed at and the later text ruled out.

What follows from that: the defect is a document genuinely being replaced
between the observation that approved an element and the action on it, under a
loaded runner - not a bookkeeping slot left empty. Anything aimed at
`no-observation` is aimed elsewhere.

One contributing cause was found and fixed here: the adapter's `goto` returned
at `domcontentloaded`, which means a document has started rather than that it is
the one still there a moment later, so an observation taken across that gap was
of a page still becoming one. Navigation now settles before `goto` returns.
That was necessary and it was not sufficient - the case recurred on the commit
carrying it, which is how it was established as insufficient rather than
assumed to be enough.

What is established:

- Occurrences across LIFE-LEGACY, EFFECT-DUP, EFFECT-NEW, EFFECT-LEDGER,
  AUTH-COMBINED and LIFE-MANAGED. One defect, surfacing through whichever case
  happens to run when the window opens, not six defects. Every occurrence is
  exactly one failure out of 1372, never two, and never outside this file.
- It is not any branch's. `#56` changed two lines - a Stryker timeout and a
  paragraph of Markdown, neither read by `test:coverage` - and its `coverage`
  job failed on LIFE-MANAGED. A pull request that touches no source code is
  the control this had been missing.
- It never fails in the `browser-login` job, which runs the same suite serially
  and without coverage instrumentation.
- It does not reproduce here: eight configurations tried, including the
  coverage harness, c8 over the suite alone, and three rounds at
  `--test-concurrency=4` under eight CPU burners on four cores with a
  lifecycle trace recording every clear of the held observation and the stack
  that asked for it. 102 cases, no failures, and the trace never fired.
- Under heavy enough CPU starvation it is reproducible _somewhere_: #53's
  attempt produced refusals unanimously from the missing-approval branch. That
  is a different path from the one CI reports, so it is recorded as a second
  finding rather than as this one.

What is **not** established: which observation is taken across which change.
`stale-document` is raised by three guards - the origin comparison against the
adapter's own view of the address, the held document node against the live one,
and any `movedOn` error while asking the page a question - and nothing yet
distinguishes them in a CI failure.

The leading candidate, unproven: `settle()` waits for `networkidle` with a
five-second timeout and **swallows the timeout**, so a driver on a loaded
runner proceeds as though a page had settled when it had not, observes a
document still being replaced, and finds it replaced at the next action. That
is the same shape as the `goto` defect already fixed here, in the other place
an observation is taken after a navigation. It is written down as a candidate
because it has not been reproduced, and a fix shipped on this reasoning alone
would be the third guess this section has recorded.

**It fails safe.** Every occurrence is a refusal. The driver declines to act on
an element it cannot confirm, so the outcome is a login that did not happen
rather than a credential delivered somewhere unintended - which is the direction
this protection exists to fail in. That is why it is recorded here and not
treated as a release blocker, and it is not a reason to relax the check: a
refusal that is sometimes wrong is a cost worth paying for one that is never
wrong in the other direction.

## What the numbers do not establish

- No live provider was contacted. Every "verified" result above is
  `fixture-verified` against an owned, self-hosted identity server.
- No physical or platform authenticator was used. Passkey cases prove a handoff
  is requested, not that an assertion can be produced.
- No browser extension was loaded into a real Firefox profile as part of these
  runs.
- Results were produced on Node 22, not the project's Node 24 convention.
