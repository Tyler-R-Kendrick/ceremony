# Test changes

Read [the testing guide](../docs/testing.md). Preserve existing behavior unless the task authorizes a change; add a failing regression before fixing a discovered fault.

- Keep atomic assertions, characterization baselines, properties, boundary contracts, fault injection and browser behavior distinct. A test name is not proof of coverage.
- Use synthetic credentials and isolated databases. No live service writes, model uploads or production secrets in fixtures, snapshots, logs or artifacts.
- Never weaken matchers, regenerate snapshots, exclude uncovered files or disable surviving mutants merely to obtain a green result. Explain genuine equivalent/unreachable mutants individually.
- Run focused checks, then `npm run verify` and the relevant mutation run. Report exact counts, coverage scope, surviving mutants and external limitations.
- Review snapshot diffs before accepting `npm run test:snapshots:update`; normal tests and CI must only compare saved baselines.
- Reproduce fast-check failures with the reported seed/path; keep minimized regressions. Socket/process sandbox denials require permitted execution, not skipped assertions.
- Browser tests must use a server from the same checkout. Generated screenshots belong in `testInfo.outputPath`, never tracked design files.
