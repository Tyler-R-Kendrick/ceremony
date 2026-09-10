# Jira 3LO protocol boundary checkpoint

This is an internal server boundary under construction, not an available end-to-end connector or a live certification. Durable callback admission/reconciliation, integration-owner setup, actor-bound handoff, Arazzo/recipe composition, environment configuration and browser mounting remain required. No Jira method is added to the normal service collection by this checkpoint.

## Verified provider contract

Rechecked 2026-09-10 against Atlassian's [3LO integration documentation](https://developer.atlassian.com/cloud/jira/platform/oauth-2-3lo-apps/) and [current-user API](https://developer.atlassian.com/cloud/jira/platform/rest/v3/api-group-myself/). Distributed integrations must use a shared app, not collect customers' API tokens or require each customer to create an app. Setup belongs to the authorized integration owner; provider-owned account creation/sign-in/consent remains necessary for end users as applicable.

The installed `oauth4webapi` consumer validates state and callback origin/path, authenticates the confidential client, adapts its form serialization to Atlassian's documented JSON exchange, and validates the token response. It uses the documented confidential profile, without claiming unsupported PKCE. Only the configured read scopes are accepted. The token and state remain server/private-handoff material. No refresh or automatic one-use-code retry is implemented.

Verification first checks accessible resources against the host-bound site and required Jira scopes, rejects ambiguous cloud IDs, then calls the current-user endpoint through the verified cloud ID. Active Atlassian user identity and optional expected account binding are checked before returning only cloud ID, account ID and expiry to the trusted caller. These identifiers are not automatically public/model-safe. Redirects are prohibited and response bodies use the existing stream-limited JSON reader (64 KiB). That helper now accepts the shared request/response body shape without changing its behavior.

## Executed evidence

- Initial protocol test: one passed, one failed because strict UUID validation rejected Atlassian's documented GUID-shaped cloud ID. The schema now validates its hexadecimal GUID shape without imposing unsupported UUID variant semantics.
- Corrected local HTTP suite: two tests passed, exercising SDK serialization, state/callback rejection before effects, provider one-use-code rejection, site/scope/account checks, malformed tokens, response limits, provider failures and exact expiry.
- Focused c8: 100% lines/functions and 95.89% branches in `src/server/jira-auth.ts` before the final additional test transport guard. No coverage exclusions were added.
- Jira Pact plus shared identity/request-boundary suite: eight passed, zero failures/skips. Pact exercises the production consumer, including successful exchange/verification, revoked user access and deliberately incompatible client identity. Temporary synthetic contracts are removed; none are published.
- Type checking initially exposed an inferred test-counter type cycle; explicit numeric counter snapshots corrected it. Type checking then passed.

Full verification, new-guard mutation evidence, mounted browser execution and live-provider certification are not established by this checkpoint. The Supabase timeout and coverage findings remain tracked separately; this new boundary does not clear them. No accounts, apps, cloud resources or paid services were provisioned.

## Mutation review

Full attempt `artifacts/verification/2026-09-10T08-50-44-118Z/commands.json` passed formatting, types, 351 Node tests and two Workflow tests, then failed the security mutation gate: 191 killed and two surviving mutants, zero skips. Both survivors were in the Jira tests' coverage, not provider failures: replacing the required-scope `every` check with `some` was indistinguishable with one requested scope; forcing the optional expected-account comparison always on was not detected by a successful first-time identity-discovery case.

The tests now request two scopes, reject a partially granted set before calling the user endpoint, accept the complete set, and verify successful identity discovery without a prior account ID. No production guard or mutation threshold changed. The corrected protocol tests and type check passed. A focused run of all 29 Jira security mutants killed all 29, with zero timeouts, survivors, uncovered mutants or errors in nine seconds. This focused result does not replace a complete 193-mutant or full deterministic rerun. All 24 Pact tests passed before these additional assertions; mounted Jira execution remains unfinished.

## Private durable handoff checkpoint

`src/server/oauth-handoff.ts` now carries authorization-code handoffs beneath the existing protected command service. It is not mounted in Jira's UI yet. Callback admission is separate from code exchange and provider verification. The callback, nonce and candidate session stay in encrypted records; semantic events contain no protocol material. Strict driver-output validation occurs before persistence. A candidate token remains unverified access, never a completed connection.

The carrier checks the run, principal/session, target, configuration, environment, operation, verified prerequisites and active command/effect. Commands now persist their run ID internally. Existing command outcomes remain readable; historical records without that binding cannot authorize a new carrier exchange. Lost responses become uncertain rather than reusing a possibly consumed code. Only an authenticated human with the current revision can explicitly restart expired/uncertain consent; this neither retries the old code nor revokes an upstream grant.

Initial lifecycle tests found an invalid worker identifier (effect IDs contain a colon, while storage worker IDs do not) and then reproduced acceptance of malformed driver output. The worker identity is now a digest of the stable effect identity, and the session is schema-validated before storage. Type checking also caught an exact-optional type mismatch; the private record type now derives from its strict schema instead of duplicating it.

Eight lifecycle tests exercise real protected command admission and the encrypted SQLite adapter with a synthetic driver: single callback admission, private-output reuse after carrier reconstruction, invalid output, lost response, cancellation/revocation during exchange, cross-run command rejection, exact expiry and prerequisite enforcement. The independent two-test Jira suite still exercises actual local HTTP through the installed OAuth SDK, and now also proves pure callback validation performs no exchange. These ten tests passed with zero skips; focused coverage is 99.59% lines, 95.32% branches and 100% functions for the carrier, and 100% lines/functions with 96.15% branches for Jira. The earlier six lifecycle tests plus shared command/identity/Jira regressions passed 21 tests. Synthetic lifecycle tests are not mounted-browser or real-provider evidence.

The first expanded mutation run killed 201/204 mutants, with three survivors in the carrier tests: command-node substitution and two nonce-index expiry mutations. The tests now attack run/node/effect substitutions independently and pin the trusted expiry clock while retaining real encrypted transactions. All 11 selected carrier mutants then died, with no timeout, survivor or error. No production guard or threshold was weakened.

## Integrated verification result: FAIL

The retained [full local attempt](oauth-handoff-local-verification.json), originally `artifacts/verification/2026-09-10T09-21-40-647Z/commands.json`, passed formatting, type checking, 359 Node tests, two Workflow tests, all 204 security mutants, and library/hosted/Vercel builds. Browser verification failed: 84 passed, one failed, zero skips/retries. The failing case was `tests/browser/teaching-stripe.spec.ts:6` in Chromium (15,272 ms). Its recorded last step, line 114, was cleanup, not evidence identifying the failing assertion. The browser stage took 780,743 ms. The managed source checkout has unusable Git metadata, so this runner correctly records `commit: null`; it is not commit-bound release certification.

Full Node coverage: 94.62% lines, 91.47% branches, 92.52% functions overall. Changed-module branch coverage was 92.76% for commands, 96.34% for Jira and 95.37% for the carrier. Supabase's existing focused-module gaps remain: 82.35% branches in its human collector and 89.62% in its children.

Investigation reproduced a diagnostic defect: cleanup overwrote the last source location. The safe reporter now separately retains the first failed step's static source line, never the exception text. Its intentional-failure browser regression initially failed with the old reporter. A subsequent harness assertion expected `page.title()` to emit a cleanup step; it did not, so the fixture now uses an explicit `test.step` for cleanup. The real browser regression then passed, as did four reporter/verification unit checks and type checking.

Stripe passed one focused diagnostic and then [five recorded repetitions](oauth-handoff-stripe-diagnostics.json). Those passes do **not** diagnose or clear the original failure. Full verification remains **FAIL**, not a passing rerun or a production claim. The earlier Supabase Firefox timeout also remains unresolved. The reporter fix is isolated on the base Supabase PR; the OAuth carrier and its guard tests remain on the stacked Jira PR.

Jira's registered children, fixed callback routing, owner setup, mounted browser flow, private-handoff retention and issued-session reconciliation still need integration. No real Jira account, deployed Workflow or installed-PWA checks were executed for this checkpoint. No resources were provisioned.
