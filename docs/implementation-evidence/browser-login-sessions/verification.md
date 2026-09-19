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
`test:coverage` at `--test-concurrency=4`, and has never once failed here. When
it does, the assertions carry the reason:

```
expected a verified login, got {"status":"blocked","reason":"no-observation"}
```

**That reason used to read `stale-document`, and the name was wrong.** One
branch of `resolve()` raised `stale-document` for "there is no approved
observation to act against" - a sequencing fault - while every other use of
that name means "the document you approved has been replaced", which is a
safety event detected by guards further down. Both refuse, so no guarantee ever
moved; but the name sent three separate investigations, this one included, to
read code that had not run. #53 split the two, and this section is corrected
against what the split revealed rather than against what the old name implied.

An earlier revision of this document said the failure was "the document binding
refusing to act because the document it observed is not the document in front
of it - the protection working, on a page nobody swapped". That was inference
from the name. It is not what happens: in the reproduction that finally caught
it, all fifteen refusals came from the missing-approval branch and not one from
either document comparison.

One contributing cause was found and fixed here: the adapter's `goto` returned
at `domcontentloaded`, which means a document has started rather than that it is
the one still there a moment later, so an observation taken across that gap was
of a page still becoming one. Navigation now settles before `goto` returns.
That was necessary and it was not sufficient - the case recurred on the commit
carrying it, which is how it was established as insufficient rather than
assumed to be enough.

What is established:

- Occurrences across LIFE-LEGACY, EFFECT-DUP, EFFECT-NEW, EFFECT-LEDGER and
  AUTH-COMBINED. One defect, surfacing through whichever case happens to run
  when the window opens, not five defects.
- It never fails in the `browser-login` job, which runs the same suite serially
  and without coverage instrumentation.
- It does not reproduce here: five configurations tried, including the coverage
  harness, six concurrent CPU burners, and c8 over the suite alone.
- It is reproducible under heavy enough CPU starvation, and there the refusals
  are unanimously the missing-approval branch.

What is **not** established: what clears the approval. `current` is set by
`observe()` and cleared in exactly two places - `release()`, which only `goto()`
calls, and the top of `observe()` itself, which clears before it spends several
awaited round trips on the browser and only then sets the new value. The
driver's path through those is sequential, so neither explains a missing
approval on its own, and the window has not been caught open with a lifecycle
trace attached.

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
