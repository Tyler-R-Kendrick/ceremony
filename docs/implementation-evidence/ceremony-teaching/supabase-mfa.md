# Supabase MFA integration checkpoint

This is draft-branch implementation evidence, not live certification or a completed browser feature. The account-first Supabase children are not yet mounted in the hosted/browser connection surface. The existing Supabase password adapter remains separate.

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
- Focused c8 measurement: SDK 99.74% lines and 95.79% branches; durable children 99.37% lines and 86.28% branches; both 100% functions. The child module remains below the requested 90% branch target. Aggregate coverage is not substituted for that gap.

Coverage command:

```sh
npx c8 --include=src/server/supabase-auth.ts --include=src/server/recipes/supabase.ts --reporter=text --reporter=json-summary --reports-dir=artifacts/supabase-mfa-coverage node --import tsx --test tests/supabase-auth.test.ts tests/supabase-mfa.test.ts tests/supabase-children.test.ts
```

Browser mounting, native factor selection/code entry, browser acceptance, remaining branch and mutation coverage, and live provider certification are unfinished. Full deterministic verification is recorded separately by the sanitized verification runner; focused success here does not replace that result. No real GitHub, hosted Vercel/Workflow deployment or installed-PWA certification was performed for this checkpoint.
