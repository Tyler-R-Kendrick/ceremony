# Final evidence aggregation

This procedure produces verdicts from evidence; it does not certify missing assertions. AC-05 and AC-06 have no complete supplied scenario and remain unmapped. Do not invent definitions or populate their execution case lists. The current strict local verdict therefore remains **FAIL** even if every deterministic stage passes. Required unavailable external cases are separately `BLOCKED_EXTERNAL` in a production report; they cannot override a local failure.

## Capture on the final clean checkout

Run `npm run verify` with `CEREMONY_RELEASE_PROFILE=docs/implementation-evidence/ceremony-teaching/local-profile.json`. Use the installed browser/runtime environment documented in `domain-acceptance.md` on this worker; those `/tmp` paths are not portable deployment requirements. The default runner uses that same local profile when no override is supplied.

The timestamped `artifacts/verification/*/commands.json` must contain a non-null final unchanged commit, configuration digest, runtime, each stage's real process/derived exit status, test counts and timestamps. The E2E stage additionally records versions read from the installed browser binaries; missing binaries fail rather than receive inferred versions. Keep every failed/interrupted attempt. The accompanying coverage aggregate is supporting coverage evidence, not case-level acceptance evidence.

## Strict input records

An authorized reviewer prepares `CEREMONY_VERIFICATION_RESULTS` as the strict JSON array defined by `verificationExecutionSchema`, using the following mapping **only after checking the complete invariant's assertions**:

| Required field                              | Source                                                                                                              |
| ------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| `schemaVersion`                             | `1`                                                                                                                 |
| `commit`, `configurationDigest`, `runtime`  | Exact immutable runner metadata; never rewrite another profile's digest                                             |
| `checkedAt`, `command`, `exitCode`, `tests` | Actual corresponding stage result; retain failed attempts                                                           |
| `attempt`                                   | Actual ordered attempt number for that command and commit/profile                                                   |
| `environment`                               | Actual proof boundary, such as `local-integration` or `local-e2e`                                                   |
| `browsers`                                  | Actual E2E browser versions for the asserted cases; `{}` for non-browser evidence                                   |
| `interfaces`                                | Only exercised interfaces: `postgresql`, `workflow-local`, `native-webmcp`; use actual fixture/runner evidence      |
| `cases`                                     | Reviewed full-invariant mapping from domain/browser assertion inventories; no blanket stage-to-all-cases conversion |
| `evidencePaths`                             | Existing nonempty sanitized artifacts inside this checkout, relative paths without traversal                        |

AC-27/28 require actual PostgreSQL evidence; AC-34 requires the supported local Workflow runtime; AC-40 requires the native interface, not a registration mock. AC-39 needs successful Chromium, Firefox and WebKit proof. Browser-only cases cannot be certified by Node unit results. Stage statistics alone do not prove a specific assertion ran: use safe source-location test results and the checked-in assertion inventory. A skipped or zero-test execution cannot certify any case.

With the reviewed array saved inside ignored `artifacts/`, derive the local report:

```sh
CEREMONY_RELEASE_PROFILE=docs/implementation-evidence/ceremony-teaching/local-profile.json CEREMONY_VERIFICATION_RESULTS=artifacts/verification/acceptance-executions.json node --import tsx scripts/verify-release.ts audit
```

The CLI writes `docs/implementation-evidence/ceremony-teaching/verification.json` and exits nonzero for missing required local proof. This generated file changes an otherwise clean checkout; preserve it as evidence, but do not mistake a later dirty-check failure for an external provider blocker. Perform release-mode checks on a clean checkout and retain their generated reports separately from immutable source.

## Release limits

The checked-in production profile is deliberately unconfigured and must fail configuration validation. A genuinely configured production profile has a different digest from the local profile and needs matching evidence. `npm run verify:release` requires production mode, a clean executing checkout and current sanitized execution records. `verify:live` and the attended/read-only smoke tools do not create missing full-provider certification. LIVE-01 needs attended real GitHub setup/access/recovery evidence; LIVE-02 needs the authorized real model; LIVE-03 needs deployed Vercel/Workflow durability; LIVE-04 needs the enabled installed-PWA real-device profile; LIVE-05 applies only when remote assistance is explicitly enabled. None was supplied by deterministic fixtures.

Manual screen-reader testing is also unexecuted; browser Axe/keyboard assertions are recorded separately and must not be called assistive-platform certification. Native WebMCP is enabled in the local test profile because its actual test project runs; remote browser and installed-PWA certification are disabled there, not silently skipped because credentials happen to be absent.
