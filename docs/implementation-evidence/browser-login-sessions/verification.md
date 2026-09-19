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

**One candidate has been eliminated by experiment rather than left plausible.**
`settle()` waits for `networkidle` with a five-second timeout and swallows the
timeout, so a driver on a loaded runner proceeds as though a page had settled
when it had not - the same shape as the `goto` defect already fixed, in the
other place an observation follows a navigation. If that were the mechanism,
removing the wait should reproduce the symptom. It does not: with the timeout
cut to 1ms, the conformance suite passes 34 of 34 serially, and 210 of 210
alongside `browser-targets.e2e`, `browser-session-lifetime` and
`browser-executor` at `--test-concurrency=4` under eight CPU burners on four
cores. Not settling at all, under the harshest conditions reproducible here,
produces no failure. The candidate is recorded as ruled out.

**Memory pressure reproduces it — but not CI's.** The paragraph below was
written believing a hosted runner has two cores and 7 GB. It does not. This
repository is public, so a standard `ubuntu-24.04` runner is four vCPUs and
16 GB, which is the same shape as the machine every local experiment ran on.
The section that follows is kept as written, and then corrected by
measurement, because the wrong turn is the useful part: the belief was
plausible, was recorded as a hypothesis rather than a finding, and was still
wrong on both numbers.

Holding memory in a ballast process, to match what was believed to be the
runner's ceiling:

| Held  | Available | Result                                      |
| ----- | --------- | ------------------------------------------- |
| 9 GB  | ~6 GB     | 210 of 210 pass                             |
| 12 GB | ~2 GB     | 14 fail, **two reporting `stale-document`** |

The two are `LIFE-MANAGED` and `EFFECT-NEW` - both among the six names CI has
produced. After ten configurations that reproduced nothing, this is the first
that reproduces the symptom, on the same cases, with the same reason.

It is **past** the CI condition rather than matched to it, and that is stated
rather than glossed: at 2 GB the same run also produced
`page.goto: Timeout 30000ms exceeded` and took over ten minutes instead of
four. CI shows no navigation timeouts. So the finding is that resource
exhaustion produces this refusal on these cases, not that CI's exhaustion has
been measured.

What it means for the driver: nothing to fix. A browser that discards and
reloads a page under memory pressure really has replaced the document, and
refusing to act on an element approved against the old one is the protection
working exactly as intended. The conformance case asserts that a login
succeeds, and under memory exhaustion it legitimately cannot.

What it pointed at was the harness. `scripts/test.mjs` runs four test files at
once, and its own comment already names the tension - "Files also launch
browsers, databases and covered children. Bound the outer pool rather than
exhausting each nested fixture's unchanged deadline." Lowering that pool was
recorded here as the next thing to establish rather than done, because it
changes every job in the repository on the strength of a hypothesis about a
machine nobody had instrumented.

### It was established, and it is not supported

Measured rather than argued, because that was the whole complaint about it.
The four browser-driving files (`browser-login-conformance`,
`browser-executor`, `browser-targets.e2e`, `browser-egress`) run under a
sampler that sums every process's `VmRSS` every 200ms and keeps the worst
moment - the peak of the _tree_, which is the number that matters here, and
not the number `/usr/bin/time -v` reports.

| Concurrency | Peak resident | Processes at peak | Result          |
| ----------- | ------------- | ----------------- | --------------- |
| 4           | 4863 MB       | 55                | 219 of 219 pass |
| 2           | 6056 MB       | 54                | 219 of 219 pass |
| 1           | 3204 MB       | 43                | 219 of 219 pass |

Two things fall out, and both are against the hypothesis.

**The peak is not close to the limit.** 4863 MB is under a third of a 16 GB
runner, at the exact setting CI uses, with the four heaviest browser files
deliberately scheduled together - which the real run only does by chance.

**Lowering the pool would not have helped.** Concurrency 2 peaked _higher_
than concurrency 4, by 1.2 GB. Browsers are launched per file and held for
its duration, so a longer, less parallel run holds them longer and overlaps
differently; the relationship is not the monotonic one the remedy assumed.
Halving the pool to reduce memory would have doubled the job and raised the
peak.

So the remedy is not taken, and not because it was hard to justify - because
it was measured and it is wrong.

**`c8` was the one variable never varied**, and it is not the answer either.

It is a real difference between the job that fails intermittently
(`coverage` and `verify`: concurrency 4, every suite, instrumented) and the
job that never does (`browser-login`: concurrency 1, four suites,
uninstrumented) - and every local experiment, including the ballast ones, had
run uninstrumented. Three runs under the same sampler, with c8 instrumenting
all of `src/`:

| Run | Peak resident   | Result          |
| --- | --------------- | --------------- |
| 1   | 4934 MB         | 219 of 219 pass |
| 2   | 5805 MB (noisy) | 219 of 219 pass |
| 3   | 4745 MB         | 219 of 219 pass |

Run 2 overlapped the tail of another job, so its baseline started 900 MB high
and its peak is not comparable; it is left in rather than dropped, because
dropping the inconvenient sample is how a measurement becomes an argument.
Runs 1 and 3 bracket the uninstrumented 4863 MB on either side. Instrumenting
every source file costs CPU, not memory, and it did not reproduce the failure
in three attempts.

What remains true is what the ballast experiment actually established:
resource exhaustion produces this refusal, on these cases, for this reason. 2
GB free is a condition CI has now been shown not to be in. So the mechanism is
understood and the trigger is not, and saying so is better than the third
wrong cause in one document.

The `coverage` job now prints `nproc`, `free -m` and `df -h /` before it runs.
Four lines, in the log, beside any failure that needs explaining - so the next
person reads the machine instead of inferring it, which is the mistake this
section has now made once.

**It fails safe.** Every occurrence is a refusal. The driver declines to act on
an element it cannot confirm, so the outcome is a login that did not happen
rather than a credential delivered somewhere unintended - which is the direction
this protection exists to fail in. That is why it is recorded here and not
treated as a release blocker, and it is not a reason to relax the check: a
refusal that is sometimes wrong is a cost worth paying for one that is never
wrong in the other direction.

## The canary sweep, and the three surfaces it found

`tests/browser-login-privacy.test.ts` plants one value where a credential
actually goes and then hunts it across four boundaries. It was written as an
audit rather than a regression test, so the useful result is what it found
rather than that it passes.

Each of the three was verified the same way: restore the defect, watch the
case that exists for it go red, restore the fix, watch it go green.

**The driver's canary was never armed in the service path.** The driver adds a
secret to its guarded set when it _fills_ one, which covers every snapshot
from that point on. `browser-login-service.ts` passed no `protectedValues`, so
nothing was armed before the first fill — and on a page whose password field
arrives already filled, no fill ever happens and nothing is armed at all. That
page is not exotic: a browser password manager produces it, so does a resumed
form, so does a provider redisplaying a failed attempt, and the repository's
own service test fixture already models it (`filled: true`, so the
interpreter's next move is the submit button). A provider echoing the password
into an alert on such a page would have had it handed to the interpreter on
every observation. The service now asks the credential source for its
secret-role values before the drive and declares them; resolution is
best-effort, so a role the flow never reaches and cannot resolve is not turned
into a failed login. Restoring the defect fails two cases.

**A plan rejection echoed the caller's own string back.** `PlanRejected`
carries a `detail`, and for `unknown-connector` that detail was
`draft.connectorId` — 128 characters of anything the caller sent. A rejection
is the one object here that routinely leaves by a route nobody planned: it is
thrown, logged, attached to a report, and on a model-facing surface rendered
into a transcript. The echo bought nothing, because a caller already knows
what it asked for; it was only ever a second, unredacted copy travelling
somewhere the first was not going to go. `detail` is now scoped in writing to
server-derived findings and closed-set tokens, and the unbounded echo is gone.
Twelve cases plant the value in every free-form draft field in turn, so a
future field that echoes fails without anybody remembering to assert on it.

**A human handoff carried the live URL, query string and all.** The driver
already refuses to put a submission's URL in the effect ledger, under a
comment reading "an origin rather than a URL because a form action can carry
an identifier or a token in its query string". The handoff request is the one
thing in an attempt that is _meant_ to leave the process — a host renders it
for a person, sends it as a notification, writes it to a log — and it carried
`https://provider.example/challenge?code=…&login_hint=…` verbatim. It now
carries `path`, origin and pathname, taken from the observation rather than
re-derived from the URL, so there is no point in that function where the query
string exists to be reintroduced. A host that genuinely needs to navigate
holds the live page already and can ask it.

One thing was checked and found already correct, and is pinned so it stays
that way: nothing durable holds a credential. The sweep reads back _every_
record kind the store has, decrypted — strictly more than anyone holding the
file could see — and finds none. `onStep`, the progress surface most likely to
be rendered verbatim into a log line, is asserted to be exactly two fields.

Two limits, stated rather than implied. A saved storage state is deliberately
outside this sweep; it is a cookie jar by design, and the case that covers it
is LIFE-STATE. And a canary that trips _after_ something was dispatched is
still reported as `indeterminate` rather than by the new name: uncertainty
outranks the tripwire, because relabelling a dispatch nobody observed as a
refusal would invite exactly the retry the effect record exists to prevent.

## What the numbers do not establish

- No live provider was contacted. Every "verified" result above is
  `fixture-verified` against an owned, self-hosted identity server.
- No physical or platform authenticator was used. Passkey cases prove a handoff
  is requested, not that an assertion can be produced.
- No browser extension was loaded into a real Firefox profile as part of these
  runs.
- Results were produced on Node 22, not the project's Node 24 convention.
