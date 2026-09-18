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
| Existing-profile Chromium | n/a             | —               | —                | —             | —             | —                 | —        | see `browser-login-extension.md` |
| Existing-profile Firefox  | n/a             | —               | —                | —             | —             | —                 | —        | see `browser-login-extension.md` |
| Installed Safari          | n/a             | not implemented |                  |               |               |                   |          |                                  |     |

Source: `tests/browser-login-conformance.test.ts` — 25 cases, 8 per engine plus
one engine-identity case. The engine version in each row is read from the
running executable, not from a package manifest.

## Declared capabilities per engine

From `src/server/browser-backends.ts`. These are what each engine can enforce
**in this driver**.

| Capability                | Chromium  | Firefox   | WebKit    | Note                                                                                                                                                                                    |
| ------------------------- | --------- | --------- | --------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `retainedSession`         | true      | true      | true      | Proven by LIFE-RETURN on each engine.                                                                                                                                                   |
| `backendHeldElements`     | true      | true      | true      | Identity is a driver-held reference; engine-independent.                                                                                                                                |
| `documentBinding`         | true      | true      | true      | Proven by TARGET-ASYNC on each engine.                                                                                                                                                  |
| `popupBinding`            | true      | true      | true      | Implemented; **not** separately exercised here.                                                                                                                                         |
| `frameBinding`            | true      | true      | true      | Implemented; **not** separately exercised here.                                                                                                                                         |
| `strongEgressContainment` | **false** | **false** | **false** | Nothing here enforces containment of every subresource. Chromium's `Fetch` interception covers document requests, which is navigation control. A plan requiring containment is refused. |
| `authenticatorHandoff`    | true      | true      | true      | Proven by AUTH-PASSKEY on each engine: the page produces a handoff, and no assertion is fabricated.                                                                                     |
| `statePersistence`        | true      | true      | true      | Declared. **Not exercised.** No storage-state round trip was tested.                                                                                                                    |
| `debugExposure`           | **false** | **false** | **false** | The managed backends hand out no debugging endpoint. A deployment that does is `trusted-agent` regardless of its interface.                                                             |

## Acceptance cases

| Case           | Covered by                                                   | Engines | Evidence |
| -------------- | ------------------------------------------------------------ | ------- | -------- |
| AUTH-COMBINED  | `browser-login-conformance` AUTH-COMBINED                    | all 3   | fixture  |
| AUTH-WRONG     | `browser-login-conformance` AUTH-WRONG                       | all 3   | fixture  |
| AUTH-FORGED    | `browser-login-conformance` AUTH-FORGED                      | all 3   | fixture  |
| AUTH-CAPTCHA   | `browser-login-conformance` AUTH-CAPTCHA                     | all 3   | fixture  |
| AUTH-PASSKEY   | `browser-login-conformance` AUTH-PASSKEY                     | all 3   | fixture  |
| LIFE-RETURN    | `browser-login-conformance` LIFE-RETURN                      | all 3   | fixture  |
| LIFE-MANAGED   | `browser-login-conformance` LIFE-MANAGED                     | all 3   | fixture  |
| LIFE-LEGACY    | `browser-login-conformance` LIFE-LEGACY                      | all 3   | fixture  |
| LIFE-ATTACHED  | `browser-session-lifetime` LIFE-ATTACHED                     | n/a     | unit     |
| LIFE-TRANSFER  | `browser-session-lifetime` LIFE-TRANSFER                     | n/a     | unit     |
| LIFE-RESTART   | `browser-session-lifetime` LIFE-RESTART                      | n/a     | unit     |
| CLIENT-OWNER   | `browser-session-lifetime` CLIENT-OWNER                      | n/a     | unit     |
| EFFECT-CANCEL  | `browser-session-lifetime` EFFECT-CANCEL                     | n/a     | unit     |
| TARGET-MARKER  | `browser-targets.e2e` TARGET-MARKER                          | all 3   | fixture  |
| TARGET-ASYNC   | `browser-targets.e2e` TARGET-ASYNC                           | all 3   | fixture  |
| TARGET-FORM    | `browser-targets.e2e` TARGET-FORM (×2: action, `formaction`) | all 3   | fixture  |
| ORIGIN-SSO     | `login-plan` ORIGIN-SSO                                      | n/a     | unit     |
| ORIGIN-SSRF    | `login-plan` ORIGIN-SSRF                                     | n/a     | unit     |
| POLICY-DRAFT   | `login-plan` POLICY-DRAFT (9 fields)                         | n/a     | unit     |
| POLICY-UNKNOWN | `login-plan` POLICY-UNKNOWN                                  | n/a     | unit     |
| POLICY-VERIFY  | `login-plan` POLICY-VERIFY                                   | n/a     | unit     |
| POLICY-REVISE  | `login-plan` + `browser-session-lifetime` POLICY-REVISE      | n/a     | unit     |
| VER-FRESH      | `browser-session-lifetime` VER-FRESH                         | n/a     | unit     |
| HOF-STALE      | `browser-login-handoff` HOF-STALE                            | n/a     | unit     |
| HOF-PORT       | `browser-login-handoff` HOF-PORT                             | n/a     | unit     |
| HOF-DUP        | `browser-login-handoff` HOF-DUP                              | n/a     | unit     |
| ENGINE-REAL    | `browser-login-conformance` ENGINE-REAL                      | all 3   | runtime  |

### Cases not covered

Listed so their absence is a statement rather than an oversight.

| Case                                                                                 | Status                                                                                                              |
| ------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------- |
| AUTH-IDENTIFIER (two-document)                                                       | The fixture serves the flow; no conformance case drives it yet.                                                     |
| AUTH-REUSE, AUTH-TOTP, AUTH-PUSH, AUTH-CONDITIONAL, AUTH-CALLBACK, AUTH-REGISTRATION | Not covered by a new case here.                                                                                     |
| EFFECT-DUP, EFFECT-LOST                                                              | Effect contracts are defined; no duplicate-delivery test was written.                                               |
| LIFE-SHARED, LIFE-STATE, LIFE-COPIED                                                 | Not covered.                                                                                                        |
| TARGET-FRAME, TARGET-POPUP, TARGET-AMBIG, TARGET-CLOSED                              | Not covered.                                                                                                        |
| ORIGIN-REDIRECT, ORIGIN-RESOURCE                                                     | Not covered. Note `strongEgressContainment` is declared false everywhere, so no containment claim is being made.    |
| PRIV-PROMPT, PRIV-ERROR, PRIV-ARTIFACT, PRIV-ALTERNATE                               | Existing repository privacy suites are unchanged and still pass; no new canary case was added for the new surfaces. |
| BRIDGE-ORIGIN, BRIDGE-REPLAY                                                         | No authenticated companion bridge was implemented.                                                                  |
| UX-RESUME, UX-ACCESS                                                                 | No UI change was made; PR #39 remains unintegrated.                                                                 |

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
