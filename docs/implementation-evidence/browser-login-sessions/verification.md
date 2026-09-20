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

### The same command, twice, on one commit

Then CI answered the question itself, in the only way that settles it.

`verify` and `coverage` are separate jobs that both run `npm run test:coverage`

- one inside the deterministic wrapper, one directly, so a failure arrives with
  a name. They check out the same commit onto the same kind of runner. On two
  commits on the same afternoon they disagreed, in opposite directions:

| Commit            | `coverage` | `verify`   | Named failure                                 |
| ----------------- | ---------- | ---------- | --------------------------------------------- |
| `main` at 4cb1587 | **failed** | passed     | -                                             |
| PR #57 at 194d9c4 | passed     | **failed** | AUTH-COMBINED, LIFE-STATE-SUBJECT             |
| PR #62 at f8bb2c9 | **failed** | **failed** | `coverage`: EFFECT-NEW; `verify`: LIFE-SHARED |
| PR #63 at a4919b2 | passed     | **failed** | AUTH-IDENTIFIER, EFFECT-NEW, LIFE-STATE       |

Same code. Same command. Same CI. One passed and one failed, and which one
changed between commits.

The two rows added on 2026-09-19 sharpen it in two directions. On `f8bb2c9`
both jobs failed and they failed on _different cases_, which a property of the
input cannot produce either. On `a4919b2` the split is back, and it is the
cleanest instance yet: `coverage` passed outright while `verify` failed three
cases, on one checkout of one commit, running one command.

That is nondeterminism established from CI's own record rather than argued
from a local experiment, and it retires the question of whether some property
of the code or of a particular commit is responsible. Nothing that is a
function of the input can pass and fail the same input.

It also means the base branch is red on this. A failure that reproduces on
`main` is not the pull request's, which is what the runs since have been
merged on.

### The same thing again, in a different job

`mutation (resolution)` failed on `main` at the same commit, and it is worth
recording because it looks like a separate problem and is not.

Stryker's tap runner starts one process per test file and the dry run logs
each. Progress is ordinary up to `tests/browser-executor.test.ts` at 244
seconds - and then nothing at all for the remaining twenty-one minutes, until
the 25-minute dry-run budget expires. Not slow: stopped.

Which reads like a budget that needs raising, and is not. That same file run
alone, with Stryker's own node arguments, takes **1 minute 44 seconds** and
passes 139 of 139. And the same job passed on PR #45 and PR #57, on all but
identical code. So a browser-driving file that normally finishes in under two
minutes occasionally stops making progress for twenty-one - which is the same
statement as the one above, arriving through a different door.

Raising the budget would have bought nothing. A stall is not a duration.

### What is instrumented now

The `coverage` job prints `nproc`, `free -m` and `df -h /` before it runs.
Four lines, in the log, beside any failure that needs explaining - so the next
person reads the machine instead of inferring it, which is the mistake this
section has now made once.

It has now printed them beside a failure. `cpus: 4`, 15989 MB total, and
**14305-14411 MB available** while the cases were failing. The ballast
experiment above does reproduce this refusal under exhaustion; this is what
rules exhaustion out as CI's explanation, read off the machine rather than
argued from the local analogue of it.

### It is getting worse, and it costs more than a red square

Occurrences used to be "exactly one failure out of 1372, never two". On
2026-09-19 the suite is 3492 tests and a run produces three: PR #62 at
`31c194c` failed LIFE-STATE, LIFE-STATE-SUBJECT and EFFECT-LEDGER; PR #63 at
`7aa9f3d` failed AUTH-COMBINED, LIFE-SHARED and EFFECT-DUP; PR #63 at
`a4919b2` failed AUTH-IDENTIFIER, EFFECT-NEW and LIFE-STATE. Every one is
`stale-document` on a `login -> verified` precondition, none is a case its
branch added, and LIFE-STATE, LIFE-STATE-SUBJECT, LIFE-SHARED and
AUTH-IDENTIFIER join the names this has surfaced through. A rate that rises
with the number of cases sharing a machine fits contention; it does not fit a
fixed ceiling on memory.

What it costs is not one red square. `verify` runs its nine stages in order
and `break`s on the first failure, and `test:coverage` is the sixth of them.
So on every head where this fires, `test:workflow`, `test:security:mutation`
and the full `test:e2e` never run at all - on that branch, and on every branch
merged while this has been red.

### What stage nine showed the moment it could run

`test:coverage` has now passed on `main` at `d147426` - the first commit
carrying the re-read - and on two pull request heads, so `verify` reached
stage nine three times. That is not yet proof the re-read is what changed;
this defect has been nondeterministic all along and three runs is three runs.

What is not in doubt is what those runs exposed. `test:e2e` failed on both of
the first two, on **different files each time**:

| Head             | `test:e2e`           | Files                                      |
| ---------------- | -------------------- | ------------------------------------------ |
| `main` @ d147426 | 203 passed, 1 failed | `teaching-continuation.spec.ts`            |
| PR #66 @ 5503891 | 202 passed, 2 failed | `teaching-popup.spec.ts`, `webmcp.spec.ts` |

Three distinct specs across two runs, none of them touched by #62-#66, and
`teaching-continuation` passes here in 6.4 seconds. That is the same signature
as the conformance intermittent, in a different suite.

It was invisible rather than absent. `browser-ui` is not a second opinion on
`test:e2e`: it runs exactly two spec files, `connection-plan.spec.ts` and
`ceremony.spec.ts`. So the full 204-test Playwright suite only runs inside
`verify`, behind a stage that had been failing, and the first two times it ran
it was red in three different places. Recorded rather than chased: it is a
different subsystem on two runs of evidence, and acting before reproducing is
the mistake this document already records twice.

Still not reproduced here. Three rounds of `npm run test:coverage` - the exact
command both failing jobs run, and the one the never-failing `browser-login`
job does not - passed 3492 of 3492 on the same four-core, 16 GB shape.

### What a CI failure can now say

`stale-document` is raised by three guards at more than one moment, and
nothing in a failure distinguished them, which is why "which observation was
taken across which change" stayed open above. The conformance assertions now
carry two things they can have for free.

The first is the driver's own progress trail, one `action@path` per recorded
step. Those are exactly the two fields the privacy sweep pins `onStep` to, so
making a failure readable adds nothing to what leaves the trusted path. It
names the document an approval was held against when the refusal came. A trail
that ends without a `blocked` step says something further: `observe()` returns
its refusal without recording one, so the read itself failed rather than an
action on something read earlier.

The second is the provider's own record of what it received, which separates a
refusal before the credentials were sent from one after.

Read with care in one respect, established by forcing a passing case to fail
rather than assumed: a _successful_ login's trail also ends in a `blocked`
step, usually `blocked@/account`. The heuristic interpreter runs out of ideas
on the post-login page and the service deliberately treats that as "the drive
is over, ask the verifier". So the presence of `blocked` is not the signal -
its path is, and its absence is.

### The defect the trail was built to find, found without it

Writing the diagnostic meant reading the refusal path closely enough to model
it, and modelling it deterministically was enough. The case is
`tests/browser-driver.test.ts`, "a submit whose navigation lands late is read
again, not given up on": a page whose document is replaced after `settle()`
returns and after both reads that follow the submit — the loaded-runner shape
— on the recording page double rather than on a browser. It produces the CI
signature exactly:

```
{"status":"blocked","reason":"stale-document","steps":2,
 "transcript":[{fill@/signin},{click@/signin},{blocked@/signin,"stale-document"}]}
```

The refusal itself is correct and stays: nothing was typed into the new
document, nothing was sent to it. What was wrong is what followed. The submit
had already gone through, the page waiting to be read was the signed-in one,
and the attempt ended anyway — reporting a login that had in fact succeeded as
one that never happened, with the verifier never asked. `verified` is zero in
that case before the change.

Re-reading is already how this driver copes with a document changing;
AUTH-IDENTIFIER exists for it. The only reason a race was fatal is that the
change landed inside the window between the read and the action, and nothing
looked again. So a `stale-document` refusal now costs one re-read rather than
the attempt, and the new observation is read, approved and origin-checked from
scratch, with every recipient rule applied to it — a page swapped by someone
hostile is refused on its own merits rather than on a memory of the page
before it. Nothing is relaxed; the guard runs the same way on a page that is
actually there.

Bounded at one re-read, and the bound is pinned from both sides: narrowing it
to none fails the case above, widening it to two fails "a page that keeps
moving still ends the attempt". The second move in a row ends the attempt
under the name it would have carried immediately. Only `stale-document`:
`stale-element` means the control was replaced inside a document that stayed
and `unapproved-recipient` means the form was re-pointed, and a page
rearranging itself under an approval stays terminal.

One refusal is deliberately left terminal, and finding it was the point of
reading the change adversarially rather than shipping it. `act()` converts a
throw from the operation itself into the same `StaleTargetError` as a throw
from the guards, and for a _click_ those are not the same thing: Playwright
can lose the execution context between sending a submission and returning, so
the throw is not evidence that nothing was sent. Reading the page again would
still be safe; acting on what is read could submit twice, and nothing in the
attempt can tell which happened. The error now carries whether the action had
begun, set only for a dispatching operation - a fill that threw put nothing on
the wire whatever else went wrong - and a refusal that had begun ends the
attempt exactly as before. "A submit that threw while the page moved is not
tried again" pins it, and removing the flag fails it.

What this does **not** establish is that it is CI's trigger. It reproduces the
signature and it is a defect on its own terms, found by the method this
document keeps recording as the one that works — write the case, reproduce
before fixing, restore the defect and watch the case go red. Whether the
conformance intermittent stops is a question for CI, and the `reobserve` entry
in the transcript is how the answer will be read: a recovered attempt is
distinguishable from one that never raced.

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

## A capability that went true because something enforces it

`frameBinding` was declared true on all three engines with nothing behind it,
corrected to false in #51, and made to refuse a plan that declares
`frameOrigins` in #62 - each step honest, and each one leaving the same hole:
a provider that serves its credential form in a frame could not be signed into
at all.

It can now. `createPlaywrightCeremonyPage` resolves the declared frame on
every read and every action rather than choosing one once, which is the whole
design rather than an implementation detail. A frame is not a stable thing to
hold: it can be removed, replaced, or navigated somewhere else between an
observation and the action that observation authorized. Because every read
goes through the same resolution, the origin is rechecked at observation time
_and_ again at action time without a second rule saying so, and the document
guards then compare the held document against whatever it returns, exactly as
they do for a page.

Neither way selection can fail falls back to the page. `frame-missing` is no
frame at a declared origin - using the embedding document instead would type a
credential into a different origin's form, and naming the frame was the
statement that the page is not it. `frame-ambiguous` is more than one, so
"the frame" does not identify a document; choosing would approve a position
rather than a thing, one level up from the element guards, and a page that can
add a second frame at an origin could otherwise choose which document receives
a credential.

Evidence, on the table's own standard that a flag goes true only once
something enforces it:

- TARGET-FRAME drives `/framed` on all three engines: the embedding page has
  no fields of its own, the form belongs to the partner origin inside an
  iframe, and the oracle is the partner server's record of one submission for
  the right account with the password matched - plus the embedding origin
  having received nothing. Restoring the defect, so that a declared frame is
  resolved back to the page, fails it 3 for 3.
- Three unit cases pin selection itself: a declared frame that is absent
  refuses without reading the page, two frames at one origin refuse without
  reading either, and a single match is read while the page is not.

One fault was found by writing those cases rather than by reasoning about
them. `observe()` wrapped _every_ failure from the page in a fresh
`StaleTargetError`, so a selection refusal that already knew its own name
arrived at the caller as `target-unavailable`. A precise name replaced by a
guess is the same defect as a missing one, and it is the second time this
module has produced it - #53 split `no-observation` out of `stale-document`
for the same reason. Classification now returns an already-named refusal
unchanged, and restoring the re-labelling fails both selection cases.

Two cases had to change, and how they changed is the point. CAP-HONEST proved
"declaring a frame origin requires the capability" by watching every engine
_refuse_ such a plan - which was true only while nothing implemented frames.
The moment one did, a case about the compiler failed for a reason that had
nothing to do with the compiler. It now asserts the rule directly, that the
requirement is derived from the declaration, and a second case proves the
refusal against a backend table built to say no rather than against whatever
the real one happens to say this month. A case that asserts a consequence
instead of a rule passes for the wrong reason and then fails for the wrong
reason, and both halves cost a run to find out.

What is **not** built: `popupBinding`, which stays false. `browser-executor.ts`
deliberately aborts a popup and closes the context, so that flag is not
waiting on an implementation but on a decision about whether adopting popup
targets can be made safe. And nothing in the wizard produces a frame origin
yet - every projection still returns `frames: () => []` - so the capability is
reachable through a hand-built plan and the MCP surface, not through the
product's own configuration flow.

## A diagnostic that was tested into existence and never worked

Three of today's triages went to a mutation shard, and each time the log said
which file the dry run was on and nothing about what went wrong in it. That
looked like a deliberate limit - `scripts/verify-mutation.ts` streams
allowlisted filenames and phase metadata, never child diagnostics, which is
the right rule. It was not the limit. The runner already had a detector for
exactly this:

```ts
if (initial && /^not ok /.test(line) && running)
  record({ phase: "initial-failure", file: running });
```

It has never fired. Established by inducing an ordinary failing assertion in
a baseline file and running the real thing: the records were `initial`, then
`exit code 1`, and no `initial-failure` between them - the same shape as the
`mutation (services)` failure on PR #65. Reading Stryker's raw output then
said why. The test process's TAP stream is consumed by the tap runner and
never reaches Stryker's stdout, so `not ok` is a line Stryker does not emit.
What it does emit is its own summary:

```
ERROR DryRunExecutor One or more tests failed in the initial test run:
	tests/authoring-termination.test.ts
```

The case covering the detector passed throughout, because its double printed
the line the detector expected rather than the line the dependency produces.
That is the same fault as the CAP-HONEST cases above, one level further out: a
test that asserts against an invented world tells you the code matches your
belief about the dependency, and nothing about the dependency.

The detector now reads Stryker's list, and every name in it is still matched
against the inventory before being recorded, so what leaves is an allowlisted
filename and never a diagnostic - the same guarantee, on a line that exists.
Verified the way the old one was not: the induced failure now produces
`{"phase":"initial-failure","file":"tests/authoring-termination.test.ts"}`
against real Stryker, and the cases feed the line copied from that run.

## Three gaps closed, and the one that was a defect

**TARGET-CLOSED was not a missing case, it was a wrong answer.** `movedOn()`
classified `Target closed` and `Target page, context or browser has been
closed` alongside `Execution context was destroyed` and `navigat`, so a tab
that went away reported `stale-document`. The two call for opposite responses
and had been sharing one. A document that moved on leaves a document to read,
which is exactly why a refusal naming it is now worth re-reading once; a
target that closed leaves nothing, so that re-read is spent on a page that
cannot come back, and the attempt then tells its reader the _document_ moved -
sending them to the guards that compare documents, for a tab that is not
there. The re-read landing is what turned a merely imprecise name into a
wasted step. `target-closed` is its own refusal now, it is not re-readable,
and restoring the shared answer fails both cases.

**ORIGIN-REDIRECT nearly shipped as a case that passed for the wrong reason.**
`/sso?redirect=1` answers 302 to an origin the plan does not declare; the
attempt stops and the undeclared origin receives nothing, on all three
engines. The comment first said this pinned the navigation guard. Removing
that guard left the case green - the recipient check at the fill stops it too,
and end to end the two are indistinguishable. That is the same fault as the
CAP-HONEST cases and the mutation detector, caught this time before it landed,
by the habit of restoring the defect rather than trusting the green.

So the navigation guard is pinned separately, by the one difference that
shows: the undeclared page is never _read_. The nearest existing case does not
cover that - `inertPage` never records `snapshot`, so its "nothing is done on
an unpermitted origin" has never included "nothing is read". Reading is the
part worth pinning, because an observation is what the interpreter is shown,
and on a host model that means a page nobody declared leaving the deployment.

**ORIGIN-RESOURCE pins a limit rather than a protection.** `/resourced` is an
ordinary sign-in page on a declared origin that also pulls one image from an
undeclared one, as most real sign-in pages do. The login completes, the
credential reaches only the declared origin, and the undeclared origin records
the fetch. `strongEgressContainment` is false on every engine and this is what
that costs, measured rather than implied. It is written as a _passing_ case on
purpose: a gap nobody has measured is remembered as smaller than it is, and
the day something does enforce containment this case fails and has to be
rewritten - which is the notification that the claim changed.

## The companion bridge: a decision, not an omission

F-EXTERNAL's own heading is "the extension is not an agent execution service",
and every previous pass recorded the unbuilt bridge as a gap. It is better
described as a boundary, and this records the reasoning so the next person
inherits a decision rather than an unfinished row.

What the product requirement asks for - an authorized coding harness able to
request a login in a specifically selected browser session - **is met**, by the
managed-browser path this work order built. What the companion bridge would
add is driving a login in the person's _own_ browser from outside it. The
existing answer to that is native handoff: a person acts, and the extension's
external surface stays at `ceremony.ping` and `ceremony.open`.

Building the bridge means deliberately making an extension that runs in
somebody's personal browser accept privileged instructions from a remote
caller. The safer answer is already implemented, the requirement is named
after the property that would be given up, and "close the gap" is not a reason
to weaken the boundary the requirement exists to state. So it stays unbuilt,
and it stays unbuilt on purpose.

**What that leaves is not untested.** The bridge that exists has the two
properties the cases name, and both are now driven:

- BRIDGE-ORIGIN. The Gecko relay's admission was already covered. The Chromium
  `externally_connectable` path - the primary bridge - had no case at all;
  `extension-platform` covers the facade's registration plumbing, which is a
  different question, and the primary bridge's admission was resting on
  `answerApp` being shared with the relay. True today, and not a test.
- BRIDGE-REPLAY. Reserve-before-dispatch was covered. Its other half was not:
  an admitted origin still reaches only the two external verbs, because
  admission is not authority. That case is what keeps the heading true from
  the inside.

Writing the first found a defect. An unparseable sender URL threw out of the
external listener and was answered `unavailable` - a name that means "this
build has no external bridge" and sends its reader to check the wrong thing.
`http://127.0.0.1:4173.evil.example` is exactly such an address, because the
URL parser reads the rest as a port, so the refusal a probing origin got was
the one describing a misconfigured artifact. Sender origins parse through one
helper now, at all four sites, and unreadable is `unapproved-origin`.
Restoring the throw fails the case.

## Two timing defects, found by this branch's own CI runs

Neither is in code this branch touches, and both are recorded here because
they are the fault this file keeps finding in different clothes: a case that
asserted race semantics on a race it had not staged. This branch's CI ran
three times, which is how each got the chance to show.

**AC-STATE-01, fixed in #70.** `tests/connectors/state/concurrency.test.ts`
started a second PostgreSQL worker's refresh while the first held the lease,
slept 50ms and took it on faith that the second had asked by then. On a runner
where that worker's cold pool needed longer, it asked after the first had
committed, was admitted to a fresh credential, and rotated it - a late
arrival, by design, which the case reported as the double rotation it exists
to rule out. The case now waits for the refused lease claim, which is the
event. Reproduced deterministically by making every one of the second
worker's transactions wait 40ms: the old case fails with the CI assertion and
the new one passes.

**The host-answer race, fixed in #71.** Before `/api/config` lands every
directory row reads as declared, and the directory guessed "hosted" for all
of them so that a hosted row's WebMCP switch would not go missing from a
drawer opened early - on the premise that a declared row's draft is never
acted on. Browser Login is declared and its drawer compiles the draft into a
plan, and continuation, trust mode and lifetime all follow from whether WebMCP
is in it. A drawer opened in that window was seeded with the guess, kept it,
and asked to retain the session for a trusted agent, for an hour, when the
person had configured neither. That is the F-POLICY property failing in
miniature - what runs was not what was configured - and it was decided by a
race. A row the directory itself declares now takes no guess, since no
manifest would ever confirm one, and the case delays the answer so the race
loses every time; it fails on the old directory with the CI assertion.

Both fixes are ported onto this branch so its CI runs on them; each no-ops
once `main` carries it.

## What the numbers do not establish

- No live provider was contacted. Every "verified" result above is
  `fixture-verified` against an owned, self-hosted identity server.
- No physical or platform authenticator was used. Passkey cases prove a handoff
  is requested, not that an assertion can be produced.
- No browser extension was loaded into a real Firefox profile as part of these
  runs.
- Results were produced on Node 22, not the project's Node 24 convention.
