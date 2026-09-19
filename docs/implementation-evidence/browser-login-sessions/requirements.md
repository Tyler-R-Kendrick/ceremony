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
excluded is the value reaching a _different_ element or destination.

## F-LIFETIME — a successful run always closed the browser

**Confirmed at source.** `browser-executor.ts`'s `finish()` preserved a session
only for selected _blocked_ outcomes; success always called `close()`.

**Repaired in:** `src/server/browser-sessions.ts` (new) and
`src/server/browser-login-service.ts` (new). Retention is explicit and carries
ownership, browser generation, context, controller, lease generation, scope,
evidence and expiry. The existing ephemeral behaviour is preserved as an
explicit `dispose` continuation rather than being changed underneath callers.

`browser-executor.ts` itself is **unchanged**; the new service is a separate
path, so existing isolated-account and OAuth flows keep their exact behaviour.

**Evidence:**

- `tests/browser-login-conformance.test.ts` LIFE-RETURN on all three engines — a
  real authenticated request through the retained context _after_ the login call
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
renders a signed-in banner, a logout link _and_ the account marker element while
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

**Not complete.** The PR #39 wizard is **not wired** to this compiler on this
branch. Integration was attempted and reached a substantially working state —
the draft compiles against the real `browser-login` tool endpoint — but it
stopped with directory-UX regressions from PR #39 itself still outstanding, so
shipping it would have put known-broken UI on a branch whose other work is
verified. The attempt is preserved rather than discarded or
half-merged: `claude/pr39-wizard-wip` carries the changes to tracked files and
`claude/pr39-wizard-wip-newfiles` carries the new ones (the wizard, the catalog,
the connect surface and its plan client).

What this means today: the compiler is reachable through the authenticated
server surface and is fully tested there, and the wizard still renders its own
draft. The half of F-POLICY that made configuration _effective_ is done; the
half that makes the wizard _use_ it is not.

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

**Half addressed: the seam exists; the two paths are still two paths.**

What was actually wrong is narrower than the heading suggested and worse than
"no change was made". `createModelInterpreter` has existed in
`browser-interpreter.ts` since the driver did — bounded, schema-checked,
telemetry off, a refusal or timeout returning `undefined` — and there was no
way to reach it from an authorized login. `browser-login-service.ts` named
`createHeuristicInterpreter()` in its own body. So "use an interchangeable
model or external harness for permitted reasoning" was true of the driver and
false of the product: a host that had configured a model could not use it, and
a host that had not could not be told so.

The plan now carries `reasoning`, compiled and digested like every other
operative field.

- `deterministic` is what an absent field compiles to. A model reading
  somebody's sign-in page is a disclosure, and the one field that decides
  whether anything about that page leaves the deployment must not be switched
  on by an omission.
- `host-model` permits the model this host configured. It is refused at
  compile time when the host declares none — a refusal rather than a quiet
  downgrade, because both answers run a login and only one runs the login the
  plan describes. It is refused again at run time, before anything launches,
  when the host can no longer supply one: a plan compiles against the host
  that compiled it and can be run later, or elsewhere, after a model endpoint
  was removed.

Nothing about authority changed, and the cases say so rather than assuming it.
An interpreter proposes; the driver disposes. A model asking for a role the
plan never authorized types nothing, an element the page does not have is
refused rather than invented, a fill on a page outside the declared origins
stops the attempt, and a model claiming `done` on a browser the provider does
not recognise gets `submitted-unverified` and no session. What the two
interpreters differ in is which page-reading rules run, not how much is
trusted.

The canary from the privacy sweep is what makes the seam safe to open: a
provider echoing a credential into its own page now stops the attempt with
`protected-value-exposed` **before** any observation reaches the interpreter,
which is asserted end to end with a model plugged in.

### What is still open

**A caller-driven external harness.** The product requirement says "an
interchangeable model _or external harness_", and only the first half is
here. A harness doing the reasoning needs a protocol this does not have — a
proposal, a validation, and the next snapshot, round-tripped through a client
— so there is deliberately no enum value for it. A name that reads as
effective and is not is the defect this repository keeps finding.

**The extension path is still separate.** `src/browser-login/inference.ts`
infers a _form mapping_ from an observation using a local in-browser model,
and `src/server/isolated-account-interpreter.ts` is a third
`createModelInterpreter` for a different flow. Neither was touched. They read
different inputs and answer different questions, so reconciling them is a
real piece of design rather than a rename, and it is not started.
