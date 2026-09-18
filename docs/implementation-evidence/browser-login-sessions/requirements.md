# Findings, source and evidence

Each finding named in the work order, what was actually done about it, and which
executed test demonstrates it. A finding with no executed test says so.

## F-TARGET — the page adapter could act on an element it never approved

**Confirmed at source.** `createPlaywrightCeremonyPage` stamped
`data-ceremony-index` on each observed control and later resolved
`[data-ceremony-index="3"]`. The driver awaits an interpreter and a credential
resolver between those points, and the page runs throughout.

**Repaired in:** `src/core/browser-contracts.ts` (`boundSnapshotSource`, and the
revalidation closures that travel with the observation),
`src/server/browser-targets.ts` (new), `src/server/browser-page.ts` (rewritten),
`src/server/browser-driver.ts` (refusals become named outcomes).

Element identity is now a driver-held reference. Before every action the adapter
rechecks the live document against the held document node, the element's
connectivity and usability, its owning **form node**, and its full submission
destination including `formaction`/`formmethod`/`formtarget`.

**Evidence:**
- `tests/browser-targets.e2e.test.ts` — 15 cases, **real Chromium, Firefox and
  WebKit**. Each stages the race inside a paused resolver and then asks a
  recording HTTP server whether the canary arrived. It never did. This is the
  oracle the work order requires; an assertion that the adapter merely returned
  false would not have been sufficient.
- `tests/browser-driver.test.ts` — 8 unit cases covering the same rules plus the
  driver turning a refusal into a named blocked outcome rather than a crash.

**Residual, stated plainly:** this does not protect a password from the site it
was typed into. Entering a credential trusts that site as its recipient. What is
excluded is the value reaching a *different* element or destination.

## F-LIFETIME — a successful run always closed the browser

**Confirmed at source.** `browser-executor.ts`'s `finish()` preserved a session
only for selected *blocked* outcomes; success always called `close()`.

**Repaired in:** `src/server/browser-sessions.ts` (new) and
`src/server/browser-login-service.ts` (new). Retention is explicit and carries
ownership, browser generation, context, controller, lease generation, scope,
evidence and expiry. The existing ephemeral behaviour is preserved as an
explicit `dispose` continuation rather than being changed underneath callers.

`browser-executor.ts` itself is **unchanged**; the new service is a separate
path, so existing isolated-account and OAuth flows keep their exact behaviour.

**Evidence:**
- `tests/browser-login-conformance.test.ts` LIFE-RETURN on all three engines — a
  real authenticated request through the retained context *after* the login call
  returned, answered `200 {"account": …}`.
- LIFE-MANAGED, LIFE-LEGACY on all three engines.
- `tests/browser-session-lifetime.test.ts` — 16 cases: ownership, LIFE-RESTART,
  generation divergence, expiry reclaiming processes, LIFE-TRANSFER fencing,
  CLIENT-OWNER, LIFE-ATTACHED, and that no release path claims a logout.

## F-PORTABILITY — security behaviour was Chromium-dependent

**Repaired in:** `src/server/playwright.ts` (exports all three engines),
`src/server/browser-backends.ts` (new).

Firefox and WebKit are real managed backends running the same contract. No
Chromium-only mechanism is claimed for them: `strongEgressContainment` is
declared **false on every backend**, because nothing here enforces containment
of every subresource, and a plan requiring it is refused before launch rather
than run under a name it does not deserve.

**Evidence:** `tests/browser-login-conformance.test.ts` — the common contract on
Chromium `153.0.8010.12`, Firefox `155.0`, WebKit `26.6`, with the executable
version read from the running browser (ENGINE-REAL).

## F-HANDOFF — a reply could settle an attempt it did not belong to

**Confirmed and reproduced** before repair: a stale first attempt's reply settled
its successor, and an unassigned but allowlisted port could decide an attempt.

**Repaired in:** `src/browser-login/handoffs.ts` (attempt-keyed wait registry),
`extensions/browser-login/worker.ts` (uses it; timers scoped per attempt).

**Evidence:** `tests/browser-login-handoff.test.ts` — HOF-STALE, HOF-PORT,
HOF-DUP, expired-timer, re-entrancy and cancellation cases.

## F-EVIDENCE — UI indicators are not account proof

**Repaired in:** `src/server/browser-verification.ts` (new). A verifier issues
its request **through the selected context's own cookie jar**, so the answer
describes that browser and no other. Evidence kinds never promote:
`fixture-verified`, `provider-verified` and `human-attested` stay distinct, and
only the first two can produce a `verified` status.

**Evidence:** AUTH-FORGED on all three engines — the fixture's `/forged` page
renders a signed-in banner, a logout link *and* the account marker element while
setting no cookie, and no engine produces a verified result from it.
AUTH-WRONG on all three engines — a different account is reported as
`account-mismatch`, and the fixture confirms nobody was logged out and no second
account was created.

## F-POLICY — draft values were not effective configuration

**Server half repaired in:** `src/server/login-plan.ts` (new).
`compileLoginPlan` produces one canonical plan with a digest; execution reads
only that. Navigation origins and per-role credential recipients are separate
sets. Verification cannot be disabled by a client. Unknown connectors, engines
and accounts are rejected rather than defaulted.

**Evidence:** `tests/login-plan.test.ts` — 30 cases, including nine that each
change one operative field and assert the canonical digest changes.

**Not complete:** the PR #39 wizard itself is **not yet wired** to this
compiler. PR #39 remains open and unmerged, and the UI integration is separate
work. Until it lands, the compiler is reachable through the server surface but
the wizard still renders its local draft. This is stated rather than implied.

## F-EXTERNAL — the extension is not an agent execution service

**Unchanged and deliberately so.** External messaging still accepts only
`ceremony.ping` and `ceremony.open`; internal privileged commands still require
the extension's own UI as sender. No authenticated companion bridge was built,
so nothing new was exposed. This is a gap, not a fix.

## F-COVERAGE — Firefox/WebKit projects only ran UI specs

**Repaired** by adding backend conformance that runs on all three engines as
Node test suites (`tests/browser-login-conformance.test.ts`,
`tests/browser-targets.e2e.test.ts`), discovered automatically by
`scripts/test.mjs` and therefore by `npm test` and `npm run verify`.
`playwright.config.ts` is unchanged.

## F-MODEL — extension and server inference paths differ

**Not addressed.** No change was made to either inference path. The new login
service runs the deterministic interpreter and makes **zero model calls**.
