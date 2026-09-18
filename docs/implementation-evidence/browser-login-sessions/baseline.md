# Baseline and environment

Recorded while implementing browser login and retained sessions. Everything here
was observed in this checkout, not carried over from a prior report.

## Repository identity

| Item                              | Value                                      |
| --------------------------------- | ------------------------------------------ |
| Remote                            | `https://github.com/Tyler-R-Kendrick/ceremony` |
| `origin/main` at start            | `d741eed0de296950def366d0a92fa63b77070abc` |
| Working branch                    | `claude/eloquent-hamilton-2bi18f`          |
| Branch tip at start               | `d741eed` (identical to `main`)            |
| PR #39 head (fetched, not merged) | `96b43e983797415201e76f69cb8abedb77f7a0ab` |

### Correction to the brief's baseline

The brief states PR #38 is merged into `main`. The GitHub API reports PR #38 and
PR #37 as **closed and not merged** (`merged: false`), while their commits
(`2ab1bdf`, `d741eed`) are present on `main`. The commits were landed outside
those pull requests. This does not change the inspected tree — `main` is
`d741eed` as the brief says — but the merge status in the brief is not what the
API reports.

A locally cached `origin/main` was stale at `fbc6776` when this session started;
`git fetch` corrected it to `d741eed` before any work began.

PR #39 was fetched to a read-only remote-tracking ref for inspection. It was
**not** merged, and the working tree was never switched to it.

## Runtime

| Item              | Value                                       |
| ----------------- | ------------------------------------------- |
| Node              | `v22.22.2`                                  |
| Platform          | `linux` / `x64`                             |
| npm               | `10.9.7`                                    |
| `playwright-core` | `1.63.0` (as locked)                        |
| Chromium          | `153.0.8010.12`                             |
| Firefox           | `155.0`                                     |
| WebKit            | `26.6`                                      |

### Deviations from the project convention, and why

- **Node 22, not 24.** `.nvmrc` specifies 24 and no Node 24 is installed in this
  container. `package.json` declares `"node": ">=22.12"`, so the toolchain is
  within the package's own range, but it is **not** the repository's stated
  verification toolchain. Results here should be reproduced on Node 24 before
  being treated as release evidence. `agent-browser` (a dev dependency) declares
  `node >= 24` and emits an `EBADENGINE` warning; it is not exercised by any
  suite run here.

- **`npm ci --ignore-scripts`.** A plain `npm ci` fails: `onnxruntime-node`'s
  postinstall downloads a binary and the transfer is reset by the environment's
  egress proxy (`ECONNRESET`), twice. Install therefore ran with
  `--ignore-scripts`. `onnxruntime-node` backs the optional local-inference
  runtime and is not used by any suite run here.

  That install choice broke the embedded PostgreSQL fixture, exactly as
  `docs/testing.md` predicts: the platform package's library symlinks are not
  hydrated without install scripts. The documented remedy was applied and only
  to that package: `npm rebuild @embedded-postgres/linux-x64 --ignore-scripts=false`.

## PostgreSQL fixture repair

Hydrating the symlinks was necessary but not sufficient. `initdb` still failed
with `could not access directory ... Permission denied`, which the fixture
reported as an opaque "could not start" that looks like a missing native
library.

Root cause: PostgreSQL refuses to run as root and drops to the `postgres`
account. Tests in this container run as root, so the fixture's own `mkdtemp`
directory — mode 0700, owned by root — was one the server could not read.

`tests/fixtures/postgres.ts` now hands its data directory to the account the
server will actually run as, and only when running as root. This is the ordinary
requirement for a PostgreSQL data directory, not a relaxation: the directory
stays private, it simply belongs to its owner. **No assertion was weakened and
no test was skipped.**

## Full-suite comparison

`node scripts/test.mjs all`, same container, same dependency tree.

| Run                                                | Tests | Pass | Fail |
| -------------------------------------------------- | ----- | ---- | ---- |
| Baseline `origin/main` `d741eed` (separate worktree) | 1135  | 1106 | 29   |
| This work, before the fixture repair                | 1205  | 1176 | 29   |
| This work, after the fixture repair                 | see `verification.md` | | |

The 29 failures are identical in both of the first two runs and are all
PostgreSQL/mounted-runtime tests. They were reproduced at the pristine baseline
in a separate `git worktree` at `d741eed`, so they are **environmental and
pre-existing**, not caused by this work. They are resolved by the fixture repair
above.

Between the first two runs this work adds **70 tests, all passing, and no new
failure**.
