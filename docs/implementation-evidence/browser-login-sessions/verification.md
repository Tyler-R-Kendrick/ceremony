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

| Run                                        | Tests    | Pass     | Fail  | Skipped | Exit  |
| ------------------------------------------ | -------- | -------- | ----- | ------- | ----- |
| Baseline `d741eed` (separate worktree)     | 1135     | 1106     | 29    | 0       | 1     |
| This work, before the PostgreSQL repair    | 1205     | 1176     | 29    | 0       | 1     |
| **This work, after the PostgreSQL repair** | **1251** | **1251** | **0** | **0**   | **0** |

The 29 failures in the first two runs are the same set, all PostgreSQL /
mounted-runtime tests, reproduced at the pristine baseline. `baseline.md`
records their root cause and the fixture repair. No test was skipped, disabled
or excluded in any run.

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

## What the numbers do not establish

- No live provider was contacted. Every "verified" result above is
  `fixture-verified` against an owned, self-hosted identity server.
- No physical or platform authenticator was used. Passkey cases prove a handoff
  is requested, not that an assertion can be produced.
- No browser extension was loaded into a real Firefox profile as part of these
  runs.
- Results were produced on Node 22, not the project's Node 24 convention.
