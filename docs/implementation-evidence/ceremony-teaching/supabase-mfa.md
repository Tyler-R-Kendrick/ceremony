# Supabase MFA integration checkpoint

This is draft-branch implementation evidence, not live certification. The original checkpoint below predates browser mounting; the subsequent integration results are recorded separately. The existing Supabase password adapter remains separate.

## Implemented boundary

The installed Supabase SDK performs challenge and verification through registered Arazzo operation paths. The server verifies the current user and enrolled TOTP factor before either action, then verifies the returned identity and `aal2` token with the provider before recording connection evidence. Factor enrollment, SMS delivery and WebAuthn are not advertised by this path. See the official [challenge](https://supabase.com/docs/reference/javascript/auth-mfa-challenge) and [verification](https://supabase.com/docs/reference/javascript/auth-mfa-verify) contracts.

The native-collector service accepts a strictly validated factor selection and six-digit code only from the authenticated human for the waiting access node. Broker bindings include actor, operation, run, node and revision. The encrypted input expires after five minutes and is consumed before the external effect. Failed or uncertain attempts require fresh human input; repeated advancement does not replay a stored code. No factor, code, token or raw provider diagnostic enters the operation arguments, public snapshot or demonstration. Existing credentials/session recovery remains available; recovery also records the invalidated session producer's semantic transition.

The SDK's challenge record is server-private, not an authorization grant. A successful verification response alone does not complete the connection. Host authorization and the durable command service remain authoritative. No MFA enrollment or paid delivery is initiated.

## Executed checks

- `npm run check`: passed.
- Focused SDK/child suite before the lost-response correction: nine passed, one failed. The SDK returned a retryable transport error as a result rather than throwing; the wrapper incorrectly classified it as rejected verification. The negative test required `uncertain`, not `awaiting-human`.
- After fixing that classification, the same three-file suite passed ten tests, zero failures/skips. It uses actual local HTTP, signed JWTs, the installed SDK, encrypted SQLite, protected commands and the deterministic recipe runtime. It does not use a live Supabase account.
- `npm test`: 341 passed, zero failures/skips.
- Subsequent source review caught an incorrect Arazzo parameter spelling (`factor_id` rather than the official `factorId`). A new contract assertion reproduced the mismatch before correcting both the document and registered mapping. The earlier HTTP tests did not detect it because the SDK performs URL construction independently of the Arazzo pointer.
- Corrected focused suite: 11 passed, zero failures/skips. A subsequent full Node run reported 341 passed and one failure; its count-only wrapper did not retain the failed test identity. One diagnostic rerun with test-name-only failure output passed all 342 tests. The original failure remains unresolved, not a passing retry or a diagnosed resource-contention issue.
- Expanded security mutation attempt: 156 killed, two timed out, one survived. The survivor removed the enrolled factor-ID comparison: eventual provider rejection still satisfied the negative test. A stricter provider-request-count assertion now checks rejection before the factor endpoint. Timeout-only results and the initial survivor are not reported as killed guards.
- Focused rerun of the enrolled-factor predicate after the assertion correction: all 14 mutants killed, zero timeouts/survivors/errors. This is separate from the complete 159-mutant gate.
- Earlier full deterministic attempt `artifacts/verification/2026-09-10T07-11-37-576Z/commands.json`: 341 Node, two Workflow, 136 existing security mutants and 79 browser tests passed, along with formatting, types and all builds. Review corrections landed after that run started, so it is not final-tree evidence for the extra contract assertion or expanded mutation gate.
- Focused c8 measurement: SDK 99.74% lines and 95.79% branches; durable children 99.37% lines and 86.28% branches; both 100% functions. The child module remains below the requested 90% branch target. Aggregate coverage is not substituted for that gap.

Coverage command:

```sh
npx c8 --include=src/server/supabase-auth.ts --include=src/server/recipes/supabase.ts --reporter=text --reporter=json-summary --reports-dir=artifacts/supabase-mfa-coverage node --import tsx --test tests/supabase-auth.test.ts tests/supabase-mfa.test.ts tests/supabase-children.test.ts
```

At that checkpoint, browser mounting and acceptance were unfinished. Full deterministic verification is recorded separately by the sanitized verification runner; focused success here does not replace that result. No real GitHub, hosted Vercel/Workflow deployment or installed-PWA certification was performed for this checkpoint.

## Native browser integration

The same registered children now mount through the authenticated local and hosted runtime, shared session configuration, and existing Connect surface. Private project setup, explicit project-user signup/sign-in, email confirmation and enrolled TOTP collection return to the same parent. Dashboard account setup remains a provider-owned handoff, distinct from project-user authentication.

- Mounted HTTP/PostgreSQL and command tests: ten passed, no failures/skips. Both assurance profiles complete through actual SDK HTTP and signed fixture tokens. Negative assertions cover foreign subjects/origins/tickets, wrong stages, extra fields, ticket replay and no repeated MFA effect after a failed code.
- Focused SDK/children/mounted HTTP coverage: 13 passed, no failures/skips; 99.06% lines, 87.27% branches, 100% functions. SDK branches: 94.4%; native collector: 80%; children: 85.22%. Collector/children remain below the requested 90% branch target.
- Browser acceptance: six passed across Chromium, Firefox and WebKit, initially in 47.7 seconds and again in 38.5 seconds after review fixes. Wrong project key, wrong password and wrong MFA code recover in place. Only empty Connect screenshots were captured; private collectors have screenshots/video/traces disabled.
- Earlier browser attempts failed: two initial timeouts; a bounded rerun exposed an assertion racing the confirmation reload; a subsequent two-case run exposed encoded run-ID comparison and an early provider-counter assertion. Tests now await navigation and verified completion and compare decoded identities. These failed attempts are retained, not reported as passing retries.
- Impeccable finish review resolved three findings: missing rejected-input feedback, unnecessary invalid-project return/reopen detour, and missing negative/recovery browser assertions. The scoped verdict was `ship`; it does not certify provider accounts or private-page screenshots.
- Deterministic attempt `artifacts/verification/2026-09-10T07-24-23-237Z/commands.json`: 342 Node tests, two Workflow tests and all 159 security mutants passed (zero surviving/timeouts), then build failed while browser integration was being edited. The discriminated-union type error was fixed and type checking passed. This attempt is not a passing full gate.

No real Supabase account, deployed Vercel/Workflow runtime or installed-PWA platform was tested. Remaining coverage and complete final-tree verification are release gaps; local protocol evidence does not replace external certification.

## Full-gate integration review

- `2026-09-10T07-54-05-244Z`: formatting failed in `src/server/github-runtime.ts`; corrected with Prettier.
- `2026-09-10T07-55-26-820Z`: formatting, types, 344 Node tests and two Workflow tests passed. Mutation configuration failed before producing results because the new human view introduced a second matching human-only guard. The selector now requires exactly two matches and mutates both; foreign-actor view denial has its own regression.
- `2026-09-10T07-57-25-386Z`: formatting, types, 344 Node tests, two Workflow tests, all 164 security mutants and package/hosted/Vercel builds passed. Browser suite: 84 passed, one failed, zero skipped. The failed Chromium collection assertion still expected legacy inline Supabase fields, contrary to the new private setup handoff. It now asserts absent credential fields, the outcome-first Connect action, the setup blocker and the actual private route. Focused corrected test: one passed in 4.6 seconds. A complete post-correction rerun is still required.
- Incremental implementation and guard regression were pushed to draft PR #21 at `b156150c16e0020255bfd4358030c8ba47c462b4`. Source-checkout verification has no Git commit binding because its managed Git metadata is unavailable; it is not exact-commit release evidence. Remote exact-head CI must be checked separately.

These failures are part of the evidence history. No failing gate, focused passing rerun, or missing external certification is converted into a release pass.

## Persisted handoff attacks and Firefox investigation

Commit `0c49d06` adds actual stored-ticket expiration and subject/session/run/node/revision tampering checks, missing/non-waiting human-view denial, and revoked-session recovery assertions. The eight focused HTTP/child tests passed. Full Node coverage measured SDK branches at 94.4%, native collector at 82.35%, children at 88.15%, and the shared command service at 92.7%; collector and children remain below the requested 90% branch target.

Full attempt `artifacts/verification/2026-09-10T08-11-34-761Z/commands.json` passed formatting, types, 344 Node tests, two Workflow tests, 164 guard mutants and all three builds. Browser results were 84 passed and one timed out (Firefox Supabase `aal2`, 30,004 ms, retry zero). The corrected collection test passed on its first attempt. This is a failing full gate, not a green run.

A diagnostic-only Firefox `aal2` run passed in 16,617 ms without a retry. That does not diagnose or clear the original timeout. Raw errors, provider bodies and DOM content were not retained; the diagnostic output allowed only status, duration and source locations. The safe reporter now includes an optional validated source line for the last step, restricted to the current static test file; it still excludes titles, errors, attachments and captured output. Its allowlist unit test and type check passed. Both Firefox Supabase cases then passed with the actual reporter in 27.6 seconds, emitting numeric source lines only. This is focused instrumentation evidence, not a replacement full run or a root-cause fix. The full-suite timeout remains unresolved.

## Configured reuse and exact-expiry recovery

Commit `8c0d6bb` adds configured-project reuse with zero setup provider calls, denial of collection after verified setup, and recovery at the exact expiration of private signup input or an issued session. Both cases complete the same parent using fresh sign-in and enrolled TOTP, without another signup or an expired MFA attempt. Focused SDK/child/mounted-HTTP suite: 15 passed, zero failures/skips. Coverage: SDK 94.44% branches, children 89.62%, collector 82.35%; all three have 100% functions. Coverage gaps remain explicit.

A subsequent complete `npm run test:e2e` passed all 85 cases in 5.9 minutes, zero failures/skips/retries. This included both Firefox Supabase profiles in the full suite (7,232 ms and 5,999 ms). It does not reproduce or explain the earlier timeout, which remains in this history. This was the complete browser gate, not a new combined `npm run verify` result. No live accounts or installed-device checks were performed.
