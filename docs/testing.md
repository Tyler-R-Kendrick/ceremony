# Test strategy and evidence

Tests must fail on regressions, not just exist under a category name. Consumer Pact success is not live third-party certification. Browser behavior is verified separately from Node V8 coverage.

## Commands

- `npm test`: atomic, characterization and behavior tests using Node's existing test runner.
- `npm run test:snapshots`: compare committed, human-reviewable baselines for all seven flow templates, state actions and WebMCP tool contracts.
- `npm run test:snapshots:update`: explicitly regenerate baselines; inspect the diff and commit only intentional changes. Never run this in CI or to hide a regression.
- `npm run test:coverage`: include every library `.ts`/`.tsx` file, including unexecuted files; emit text and `artifacts/coverage/coverage-summary.json`. This report does not count browser execution.
- `npm run test:pact`: real GitHub consumer against an isolated HTTP contract server; see [boundary limitations](contract-testing.md).
- `npm run test:e2e`: browser functional, accessibility, WebMCP and packed React/Vue consumer scenarios.
- `npm run test:fuzz`: seeded fast-check properties with shrinking. Replay using `FUZZ_SEED`; increase exploration using `FUZZ_RUNS`. Default: 1,000 examples per stateless/reference property and 200 environment-edit sequences.
- `npm run test:chaos`: deterministic transport disconnect/timeout/429/503, malformed payload, uncertain A2H delivery, event retry and remote browser outage scenarios. No production services are disrupted.
- `npm run test:mutation`: Stryker source mutations in method selection, schemas, execution hooks, session environment and encrypted credential storage. The TAP plugin runs affected test files; the mutation score gate is 80%. This is a declared critical-module scope, **not** whole-repository mutation coverage. Inspect `artifacts/mutation/index.html` and `mutation.json`; surviving mutants remain visible.

`npm run verify` enforces all-source minimums of 90% lines/statements/functions and 80% branches, then builds and runs browser tests. CI runs mutation testing as a separate job and retains coverage/mutation artifacts. Install Chromium first (`npx playwright install chromium`); the remote-browser orchestration check uses a real local browser with simulated vendor CDP responses. Browser tests must run against the same checkout as their dev server, because native WebMCP fixtures use checkout-local modules.

## Faults found and repaired

- Aborted/disposed client reads accepted late completion results; they now reject before publishing or notifying completion. Cancellation during private collection also prevents a subsequent submit.
- Memory credentials were still valid at their exact expiration instant; both lookup and pruning now use an inclusive expiry boundary.
- Remote-browser origins accepted embedded credentials/path/query/fragment; configuration now requires a clean HTTPS origin.
- Another principal could replace an existing remote-browser handoff; owner mismatch now fails before connecting.
- Browser tests wrote generated screenshots over tracked design references; captures now use per-test artifact paths.
- Mutation tooling introduced a vulnerable pinned transitive dependency; the narrow override was verified by a clean install with zero audit findings.

Latest completed local verification before final mutation review: 104 Node/Pact tests and 20 browser tests passed, with 92.51% all-source lines/statements, 83.44% branches and 90.90% functions. UI event behavior is additionally covered by browser tests but is not included in the Node V8 percentages. Live provider conformance and whole-repository mutation coverage are not established by these results.

## Initial audit

Before this test expansion: 30 Node tests, four Pact tests and 20 browser tests. Node coverage across **all source files** was 73.39% lines, 79.81% branches and 86.23% functions. There were no saved characterization snapshots, property fuzzing or systematic source mutation tests. Existing race/error checks and one request-mutation check were useful but not a comprehensive chaos or mutation suite. React, the MCP App browser entry, remote browser orchestration and headless client branches were notable gaps.

## Sources

[Verify](https://github.com/VerifyTests/Verify) describes the approval-baseline workflow. [Node's native snapshot testing](https://nodejs.org/api/test.html#snapshot-testing) provides that workflow in this project's runner: commit serialized baselines, compare on normal runs, and update explicitly after review. No additional snapshot framework is required.

[fast-check](https://fast-check.dev/docs/tutorials/quick-start/) generates and shrinks counterexamples; property assertions use an independent invariant or model, not a copy of the production algorithm. JSON round trips compare JSON semantics because JSON normalizes negative zero. The narrow `typed-rest-client` → `qs` override fixes a vulnerable pinned mutation-tool dependency; a clean install must pass `npm audit`.

[Stryker's TAP runner](https://stryker-mutator.io/docs/stryker-js/tap-runner/) supports the existing Node runner and per-file coverage selection. [Stryker configuration](https://stryker-mutator.io/docs/stryker-js/configuration/) documents score gates, timeouts and reports. Neither line coverage nor a timeout alone establishes correct authentication behavior; review actual killed/surviving mutants and behavioral assertions.
