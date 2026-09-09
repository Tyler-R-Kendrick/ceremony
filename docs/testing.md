# Test strategy and evidence

Tests must fail on regressions, not just exist under a category name. Consumer Pact success is not live third-party certification. Browser behavior is verified separately from Node V8 coverage.

## Commands

- `npm test`: atomic, characterization and behavior tests using Node's existing test runner.
- `npm run test:snapshots`: compare committed, human-reviewable baselines for all seven flow templates, state actions and WebMCP tool contracts.
- `npm run test:snapshots:update`: explicitly regenerate baselines; inspect the diff and commit only intentional changes. Never run this in CI or to hide a regression.
- `npm run test:coverage`: include every library `.ts`/`.tsx` file, including unexecuted files; emit text and `artifacts/coverage/coverage-summary.json`. This report does not count browser execution.
- `npm run test:pact`: real GitHub consumer against an isolated HTTP contract server; see [boundary limitations](contract-testing.md).
- `npm run test:e2e`: browser functional, accessibility, WebMCP and packed React/Vue consumer scenarios.

## Initial audit

Before this test expansion: 30 Node tests, four Pact tests and 20 browser tests. Node coverage across **all source files** was 73.39% lines, 79.81% branches and 86.23% functions. There were no saved characterization snapshots, property fuzzing or systematic source mutation tests. Existing race/error checks and one request-mutation check were useful but not a comprehensive chaos or mutation suite. React, the MCP App browser entry, remote browser orchestration and headless client branches were notable gaps.

## Sources

[Verify](https://github.com/VerifyTests/Verify) describes the approval-baseline workflow. [Node's native snapshot testing](https://nodejs.org/api/test.html#snapshot-testing) provides that workflow in this project's runner: commit serialized baselines, compare on normal runs, and update explicitly after review. No additional snapshot framework is required.
