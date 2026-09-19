# Capability and evidence matrix

Every row states what was **executed**, not what was intended. A capability with
no executed test is marked as such and is not reported as supported anywhere in
the code.

Evidence classes used below:

- **fixture** — an owned, self-hosted provider, verified through the browser's
  own cookie jar by the fixture's identity endpoint.
- **unit** — no browser; the rule itself under controlled conditions.
- **none** — implemented, not exercised. Treated as unproven.

## Browser backends

| Backend                   | Engine version  | Login           | Retained session | Wrong account | Forged marker | Challenge handoff | Disposal | Evidence                         |
| ------------------------- | --------------- | --------------- | ---------------- | ------------- | ------------- | ----------------- | -------- | -------------------------------- |
| Managed Chromium          | `153.0.8010.12` | pass            | pass             | pass          | pass          | pass              | pass     | fixture                          |
| Managed Firefox           | `155.0`         | pass            | pass             | pass          | pass          | pass              | pass     | fixture                          |
| Managed WebKit            | `26.6`          | pass            | pass             | pass          | pass          | pass              | pass     | fixture                          |
| Existing-profile Chromium | n/a             | partial         | —                | —             | —             | —                 | —        | see `browser-login-extension.md` |
| Existing-profile Firefox  | Firefox `155.0` | artifact only   | —                | —             | —             | —                 | —        | real-Firefox load, see below     |
| Installed Safari          | n/a             | not implemented |                  |               |               |                   |          |                                  |     |

Source: `tests/browser-login-conformance.test.ts` — 25 cases, 8 per engine plus
one engine-identity case. The engine version in each row is read from the
running executable, not from a package manifest.

## Declared capabilities per engine

From `src/server/browser-backends.ts`. These are what each engine can enforce
**in this driver**.

| Capability                | Chromium  | Firefox   | WebKit    | Note                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| ------------------------- | --------- | --------- | --------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `retainedSession`         | true      | true      | true      | Proven by LIFE-RETURN on each engine.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `backendHeldElements`     | true      | true      | true      | Identity is a driver-held reference; engine-independent.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| `documentBinding`         | true      | true      | true      | Proven by TARGET-ASYNC on each engine.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| `popupBinding`            | **false** | **false** | **false** | Nothing binds a popup to its opener; `browser-executor.ts` aborts one and closes the context, reporting `blocked` / `popup`. Declared true until 2026-09-18 against that behaviour; a plan requiring it is now refused before launch.                                                                                                                                                                                                                                                                                                                 |
| `frameBinding`            | **false** | **false** | **false** | `createBoundTargets` observes the main frame only. Declared true until 2026-09-18 with no implementation; a plan requiring it is refused before launch. A plan that declares `frameOrigins` now requires it too, so a configuration that acts inside a frame is refused by name rather than compiled, digested and then ignored.                                                                                                                                                                                                                      |
| `strongEgressContainment` | **false** | **false** | **false** | Nothing here enforces containment of every subresource. Chromium's `Fetch` interception covers document requests, which is navigation control. A plan requiring containment is refused.                                                                                                                                                                                                                                                                                                                                                               |
| `authenticatorHandoff`    | true      | true      | true      | Proven by AUTH-PASSKEY on each engine: the page produces a handoff, and no assertion is fabricated.                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `statePersistence`        | true      | true      | true      | Implemented by `ManagedContext.saveState()` and `openContext({ storageState })`. Proven by LIFE-STATE on each engine: a second context, opened only from a saved export, is recognised by the provider's own `/api/whoami`, and no second session is issued. LIFE-STATE-SUBJECT proves the half that makes it safe to have - a saved state is a bearer credential, so another subject presenting the reference is refused. Declared true until 2026-09-18 with no implementation, corrected to false, and true again only once something enforced it. |
| `debugExposure`           | **false** | **false** | **false** | The managed backends hand out no debugging endpoint. A deployment that does is `trusted-agent` regardless of its interface.                                                                                                                                                                                                                                                                                                                                                                                                                           |

## Acceptance cases

| Case             | Covered by                                                                                 | Engines | Evidence       |
| ---------------- | ------------------------------------------------------------------------------------------ | ------- | -------------- |
| AUTH-COMBINED    | `browser-login-conformance` AUTH-COMBINED                                                  | all 3   | fixture        |
| AUTH-WRONG       | `browser-login-conformance` AUTH-WRONG                                                     | all 3   | fixture        |
| AUTH-FORGED      | `browser-login-conformance` AUTH-FORGED                                                    | all 3   | fixture        |
| AUTH-CAPTCHA     | `browser-login-conformance` AUTH-CAPTCHA                                                   | all 3   | fixture        |
| AUTH-PASSKEY     | `browser-login-conformance` AUTH-PASSKEY                                                   | all 3   | fixture        |
| AUTH-CONDITIONAL | `browser-login-conformance` AUTH-CONDITIONAL                                               | all 3   | fixture        |
| LIFE-RETURN      | `browser-login-conformance` LIFE-RETURN                                                    | all 3   | fixture        |
| LIFE-MANAGED     | `browser-login-conformance` LIFE-MANAGED                                                   | all 3   | fixture        |
| LIFE-LEGACY      | `browser-login-conformance` LIFE-LEGACY                                                    | all 3   | fixture        |
| LIFE-ATTACHED    | `browser-session-lifetime` LIFE-ATTACHED                                                   | n/a     | unit           |
| LIFE-TRANSFER    | `browser-session-lifetime` LIFE-TRANSFER                                                   | n/a     | unit           |
| LIFE-RESTART     | `browser-session-lifetime` LIFE-RESTART                                                    | n/a     | unit           |
| CLIENT-OWNER     | `browser-session-lifetime` CLIENT-OWNER                                                    | n/a     | unit           |
| EFFECT-CANCEL    | `browser-session-lifetime` EFFECT-CANCEL                                                   | n/a     | unit           |
| TARGET-MARKER    | `browser-targets.e2e` TARGET-MARKER                                                        | all 3   | fixture        |
| TARGET-ASYNC     | `browser-targets.e2e` TARGET-ASYNC                                                         | all 3   | fixture        |
| TARGET-FORM      | `browser-targets.e2e` TARGET-FORM (×2: action, `formaction`)                               | all 3   | fixture        |
| ORIGIN-SSO       | `login-plan` ORIGIN-SSO                                                                    | n/a     | unit           |
| ORIGIN-SSRF      | `login-plan` ORIGIN-SSRF                                                                   | n/a     | unit           |
| POLICY-DRAFT     | `login-plan` POLICY-DRAFT (9 fields)                                                       | n/a     | unit           |
| POLICY-UNKNOWN   | `login-plan` POLICY-UNKNOWN                                                                | n/a     | unit           |
| POLICY-VERIFY    | `login-plan` POLICY-VERIFY                                                                 | n/a     | unit           |
| POLICY-REVISE    | `login-plan` + `browser-session-lifetime` POLICY-REVISE                                    | n/a     | unit           |
| VER-FRESH        | `browser-session-lifetime` VER-FRESH                                                       | n/a     | unit           |
| HOF-STALE        | `browser-login-handoff` HOF-STALE                                                          | n/a     | unit           |
| HOF-PORT         | `browser-login-handoff` HOF-PORT                                                           | n/a     | unit           |
| HOF-DUP          | `browser-login-handoff` HOF-DUP                                                            | n/a     | unit           |
| ENGINE-REAL      | `browser-login-conformance` ENGINE-REAL                                                    | all 3   | runtime        |
| PRIV-PROMPT      | `browser-login-privacy` PRIV-PROMPT (4 cases)                                              | n/a     | unit           |
| PRIV-ERROR       | `browser-login-privacy` PRIV-ERROR (12 cases)                                              | n/a     | unit           |
| PRIV-ARTIFACT    | `browser-login-privacy` PRIV-ARTIFACT (2 cases)                                            | n/a     | unit           |
| PRIV-ALTERNATE   | `browser-login-privacy` PRIV-ALTERNATE (2 cases)                                           | n/a     | unit           |
| MODEL-POLICY     | `browser-login-reasoning` MODEL-POLICY (5 cases)                                           | n/a     | unit           |
| MODEL-SEAM       | `browser-login-reasoning` MODEL-SEAM (4 cases)                                             | n/a     | unit           |
| MODEL-AUTHORITY  | `browser-login-reasoning` MODEL-AUTHORITY (5 cases)                                        | n/a     | unit           |
| MODEL-PROMPT     | `browser-login-reasoning` MODEL-PROMPT (3 cases)                                           | n/a     | unit           |
| LIFE-SHARED      | `browser-login-conformance` LIFE-SHARED + `browser-session-lifetime` LIFE-SHARED (4 cases) | all 3   | fixture + unit |
| LIFE-COPIED      | `browser-session-lifetime` LIFE-COPIED (2 cases)                                           | n/a     | unit           |

### Cases not covered

Listed so their absence is a statement rather than an oversight.

| Case                                                                                     | Status                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| ---------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| ~~AUTH-IDENTIFIER (two-document)~~                                                       | **Covered.** AUTH-IDENTIFIER and AUTH-IDENTIFIER-WRONG on all three engines, asserted against the provider's own record of which route received what. Writing the case found that no identifier-first provider could be signed in to at all: the interpreter remembered pressed buttons by label, and both steps say "Sign in".                                                                                                                                                        |
| AUTH-REUSE, AUTH-TOTP, AUTH-PUSH, ~~AUTH-CONDITIONAL~~, AUTH-CALLBACK, AUTH-REGISTRATION | **AUTH-CONDITIONAL covered**: a passkey hint beside a password field is driven as a password login on all three engines, asserted against the provider's record of the submission, and treating any passkey hint as a passkey prompt fails it 3 for 3. The rest are not covered, and each needs a fixture route that does not exist yet - there is no TOTP, push, callback or registration flow to drive.                                                                              |
| ~~EFFECT-DUP, EFFECT-LOST~~                                                              | **Covered** by #50. EFFECT-DUP replays an idempotency key over both MCP and HTTP and asks the provider what it received; EFFECT-LOST asserts a dispatch with no answer is reported as undetermined, not as a refusal.                                                                                                                                                                                                                                                                  |
| ~~LIFE-SHARED, LIFE-STATE, LIFE-COPIED~~                                                 | **Covered.** LIFE-STATE and LIFE-STATE-SUBJECT in #57. LIFE-SHARED asks the provider who each of two contexts in one real browser is, and gets two different answers on all three engines; writing it found that ending one session called `ManagedBrowser.dispose()`, which closes every context the backend created - so a release took down every other session sharing that browser. LIFE-COPIED covers a reference copied to another actor and a record copied to another tenant. |
| TARGET-FRAME, TARGET-POPUP, TARGET-AMBIG, TARGET-CLOSED                                  | Not covered.                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| ORIGIN-REDIRECT, ORIGIN-RESOURCE                                                         | Not covered. Note `strongEgressContainment` is declared false everywhere, so no containment claim is being made.                                                                                                                                                                                                                                                                                                                                                                       |
| ~~PRIV-PROMPT, PRIV-ERROR, PRIV-ARTIFACT, PRIV-ALTERNATE~~                               | **Covered.** `browser-login-privacy` plants one value where a credential goes and hunts it across four boundaries. Writing it found three surfaces carrying one: the driver's canary was never armed in the service path, a plan rejection echoed the caller's string back, and a human handoff carried the live URL with its query. What is still _not_ covered is a saved storage state, which lands with LIFE-STATE.                                                                |
| BRIDGE-ORIGIN, BRIDGE-REPLAY                                                             | No authenticated companion bridge was implemented.                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| UX-RESUME, UX-ACCESS                                                                     | The wizard is wired to the compiler and covered by `connection-plan.spec.ts`; resume and access-review paths are not separately driven.                                                                                                                                                                                                                                                                                                                                                |

## Existing-profile Firefox, precisely

The Gecko artifact is built from the same sources as the Chromium one and is
**installed into a real Firefox** by `tests/extension-firefox-load.test.ts`,
which drives Firefox's remote debugging `installTemporaryAddon` — the same call
`web-ext run` makes — against a Playwright-launched Firefox 155.

**Proven in a real Firefox:** the built directory installs as a temporary
add-on with zero manifest warnings; the MV3 event page reaches `RUNNING` and is
non-persistent; the app bridge round-trips end to end (a page on the exact
configured app origin reaches the event page and gets its version back); and an
identical page on the same host at a _different port_ gets nothing, so the
exact-origin check rather than the match pattern is doing the work.

**Implemented and unit-tested, not exercised in a browser:** the Gecko
document-binding fallback (Firefox has no `documentId` option on
`tabs.sendMessage`), reserve-before-dispatch on that path, and worker-side
relay admission.

**Implemented but UNPROVEN on Firefox:** the login flow itself — the trusted UI
page, the permission prompt, inspect → observe → mapping review → apply, the
multi-step sequence, fixture verification and the handoff port. Playwright's
Firefox cannot navigate to `moz-extension:` pages, so the UI cannot be driven.
These paths are proven on Chromium only.

**Not implemented and not claimed:** signing, AMO review, store distribution.
A permanent install on Firefox release requires a signed add-on; the tested
route is the temporary add-on, which needs no security setting changed.

## Not exercised at all

- **Live-provider verification.** Only the owned fixture verifier ran. No real
  provider, no real account.
- **Native authenticators.** A passkey page produces a handoff. No hardware key,
  platform authenticator or keychain interaction occurred. Playwright's virtual
  authenticator is not wired into production.
- **Installed Safari / mobile attachment.** Not implemented.
- **Store publication or extension signing.** Not performed.
- **Real-client MCP integration.** No attended end-to-end test with Claude Code,
  Codex, OpenCode or Copilot was performed.
- **`verify:live`, `test:live:attended`, `verify:release`.** Not run. These are
  separate evidence classes and require authorized configuration that this
  environment does not have.
