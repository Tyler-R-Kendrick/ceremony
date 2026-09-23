# Browser login and retained sessions

Log a person into a site in a **specifically selected browser session**, verify
which account ended up there, and leave that session usable by whoever was meant
to have it.

This document is about what is implemented and what is not. Where something is
unproven, it says so rather than describing an intention.

## Five outcomes that are not the same thing

Conflating any two of these is how a harness ends up believing it is logged in
when it is not, so they are separate values in the API and stay separate in
every consumer.

| Outcome                           | What it means                                                                                     |
| --------------------------------- | ------------------------------------------------------------------------------------------------- |
| Provider access established       | An API credential or grant was verified for its declared provider, subject and permissions.       |
| Browser session authenticated     | The expected account was verified **in the exact selected context**, with evidence and freshness. |
| Browser control delegated         | An identified client may perform a bounded set of operations against that session.                |
| Human-attested login              | A person reports the session is logged in. Recorded, but it is a claim, not evidence.             |
| Submission dispatched, unverified | A bounded login action was sent; completion and identity were never established.                  |

An OAuth callback is not a verified account. An API grant is not a logged-in
dashboard. A completed tool call is not a completed login. A logged-in browser
is not permission for an agent to operate it.

## What runs where

`src/core/browser-session-contracts.ts` holds the vocabulary: login intent,
target binding, evidence, results, session records, leases and effects. Nothing
in it is authority — every reference is opaque and is re-resolved against the
authenticated actor, tenant and current policy on each operation.

```
UI / MCP client / CLI adapter
        │
authenticated Ceremony command service        actor, effective plan, budgets
        │
browser operation coordinator                 src/server/browser-login-service.ts
        │
admitted backend                              src/server/browser-backends.ts
        │
exact browser, context, target, document      src/server/browser-targets.ts
        │
session-bound verification                    src/server/browser-verification.ts
```

## Backend support, honestly

| Target                      | State                                                                                                                      |
| --------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| Managed Chromium            | **Implemented and tested.** Runs the common login contract; session retained and usable after the call returns.            |
| Managed Firefox             | **Implemented and tested.** Same contract, real Firefox engine, no protection skipped and no Chromium substituted.         |
| Managed WebKit              | **Implemented and tested.** Playwright's WebKit build. **Not** installed Safari, not iCloud Keychain, not mobile Safari.   |
| Existing-profile Chromium   | The existing extension logs in inside the person's own profile. It is not yet driven by an authenticated Ceremony request. |
| Existing-profile Firefox    | See `browser-login-extension.md` for the current artifact state and its limits.                                            |
| Installed Safari attachment | **Not implemented.** No supported adapter exists; nothing reports it as available.                                         |

Capabilities are declared per engine in `browser-backends.ts` and are what each
engine can actually enforce _in this driver_, not an upstream feature list. In
particular `strongEgressContainment` is **false on every backend**: Chromium's
`Fetch` interception covers document requests, which is navigation control, not
containment of every subresource. A plan that requires containment is refused
before anything launches rather than run under a name it does not deserve.

`debugExposure` is false for the managed backends because they hand out no
debugging endpoint. A deployment that does expose one is `trusted-agent`,
whatever its interface says.

## Actions are bound to a document, not to a selector

The adapter previously stamped `data-ceremony-index` on each observed control
and resolved `[data-ceremony-index="3"]` when it came time to act. Between those
two moments the driver awaits an interpreter and a credential lookup, and the
page runs the whole time: it can move the attribute, insert a duplicate earlier
in the document, or replace the document outright, and the selector resolves to
whatever is there now.

Element identity now lives in the driver as a held reference the page cannot
forge, cannot redirect, and cannot keep valid across a navigation. Immediately
before every action — after every await — the adapter rechecks that:

- the live document is the document that was observed (this catches a
  same-origin navigation, which an origin comparison cannot see),
- the element is still connected, visible, enabled and not read-only,
- it still belongs to the **exact form node** it was approved in (form
  re-association is invisible to a destination comparison when the new form
  posts to the same place), and
- the submission destination is unchanged, including `formaction`,
  `formmethod` and `formtarget` overrides on the submitter.

Any of these failing ends the step with a named refusal —`stale-document`,
`stale-element`, `unapproved-recipient` — and nothing is typed.

### Acting inside a frame

A plan may say the credential form belongs to another origin, embedded. That
is what `frameOrigins` declares, and declaring it requires the `frameBinding`
capability — a plan that names a frame on a backend that cannot observe inside
one is refused before launch rather than run in the wrong document.

Where a capable backend is used, the frame is resolved **on every read and
every action**, never chosen once and held. A frame is not a stable thing:
it can be removed, replaced, or navigated somewhere else between an
observation and the action that observation authorized. Resolving it each
time is what makes the origin check happen at both moments without a second
rule saying so, and the document guards above then compare the held document
against whatever that resolution returns, exactly as they do for a page.

Two ways selection can fail, and neither falls back to the page:

- **`frame-missing`** — no frame on the page answers to a declared origin.
  Using the embedding document instead would type a credential into a
  different origin's form; naming the frame was the statement that the page
  is not it.
- **`frame-ambiguous`** — more than one does, so "the frame" does not
  identify a document. Choosing would approve a position rather than a thing,
  one level up from the element guards: a page that can add a second frame at
  an origin could otherwise choose which document receives a credential.

`stale-document` is the one of the three the attempt does not give up on
first time. A page replaced under an approval leaves a page that can be read;
a submit whose navigation commits after the read that followed it leaves the
_signed-in_ page there, and ending the attempt would report a login that
succeeded as one that never happened. So the page is read again and decided
on from scratch — approvals, origins and recipients all re-derived from the
document actually in front of the driver — and only a second move in a row
ends the attempt. The other two mean the page rearranged itself under an
approval rather than replacing itself, and stay terminal.

**What this does not do.** It does not protect a password from the site it was
typed into. Entering a credential means trusting that site as its recipient;
DOM isolation does not hide a filled value from the page's own scripts. What is
excluded is the value reaching a _different_ element or a _different_
destination than the one approved.

## Sessions, leases and what release actually does

A retained session records ownership, backend, browser generation, context,
controller, lease generation, scope, evidence and expiry. Live browser handles
and control URLs stay inside the executor and are never returned.

Reconnection proves the same executor **and** the same browser generation. A
database row does not make a browser process durable, so a record whose live
entry is gone is reported `session-lost` rather than re-adopted — and a tab that
merely shows the same URL is never adopted.

Three release operations, deliberately not interchangeable:

| Operation         | Effect                                                                                        |
| ----------------- | --------------------------------------------------------------------------------------------- |
| `cancel-run`      | Stops future dispatch. Destroys nothing. Cannot retract a request already on the wire.        |
| `release-control` | Revokes automation. The person's browser, tabs and cookies are untouched.                     |
| `dispose-managed` | Destroys only the context and browser this executor created. Refused for an attached browser. |

**No release path logs anyone out of anything.** `upstreamLogout` is `false` on
every result and there is no code path that sets it otherwise. Release also
cannot revoke authority already copied out through an uncontrolled debugging
channel — if such a channel exists, the deployment was never constrained.

Expiry reclaims managed processes on its own, so a caller who never returns does
not leave a browser running and a grant alive indefinitely.

### Reusing a verified session

A host may pass `reuseVerifiedSessions: true` (see _Enabling it in a host_).
After a login is **verified** under a plan that retains its session, the
context's storage state is written to the encrypted `browser-state` store under
a slot for that subject, connector, entry origin and expected account; the
previous state for the slot is forgotten. The next login for the same slot
starts its context from that state. The drive still runs and the verifier still
decides, so a stale or foreign cookie jar costs a login form, never a wrong
answer. Off by default: a saved state is a bearer credential. Unverified and
`dispose` logins are never saved; an expired state is simply absent.
`HOST-REUSE` in `tests/browser-login-host.test.ts` shows a second login verified
with no second submission reaching the fixture provider.

## Verification

A verifier runs **through the selected context's own cookie jar**, so its answer
describes that browser and no other. A request from the server process would
only prove the server can reach the provider, which is a different question.

Evidence kinds never promote into one another:

- `fixture-verified` — an owned test provider confirmed the account.
- `provider-verified` — a reviewed live-provider verifier confirmed it.
- `human-attested` — a person said so. Recorded, never sufficient for `verified`.

Evidence names its verifier, that verifier's version, the browser generation and
the effective plan digest. A change to any of them invalidates it, which is what
stops a stale success from authorizing a new session or a switched account.

A verifier can never be supplied as JavaScript, a regular expression, a URL or
"I succeeded" text by a model or a caller. A provider with no registered
verifier stops at `submitted-unverified`; there is no page-reading fallback,
because reading the page does not answer the question.

## Configuration is compiled, not displayed

`compileLoginPlan` turns a draft into one canonical plan with a digest.
Execution reads only that plan, and approvals, evidence and retention bind to
its digest, so a configuration change under a pending human wait cannot
authorize work approved under the old one.

Every operative field either changes the plan or is rejected by name. Nothing is
silently ignored and nothing is silently defaulted. In particular:

- Navigation origins and per-role credential recipients are **separate sets**.
  Admitting an identity provider for navigation is not permission to type this
  site's password into it. A role with no declared recipient can be typed
  nowhere.
- Verification cannot be turned off by a client. Where a host explicitly permits
  an unverified attempt, it is a different plan with a different digest and a
  different, lesser outcome.
- An unknown connector, engine or account reference is rejected. Nothing falls
  back to the first of anything.
- Origins are exact and canonical: no userinfo, no path, no wildcard, no suffix
  matching. Loopback stays available for owned fixtures.

`interactionRounds` counts **rounds Ceremony requests**, cumulatively across
retries, resumes and interpreter fallback. It is not a promise about prompts a
browser or operating system decides to show; those cannot be bypassed or
fabricated, and a strict unattended plan that needs one reports an unmet
requirement instead.

### Replaying a recorded ceremony

A draft may name a published [recorded ceremony](recorded-ceremonies.md) in `recording: { id, version, digest }`. The reference is compiled into the plan and its digest. The login then replays the recording instead of reading the page. No model is consulted, whatever `reasoning` says. Where the provider no longer matches, the login stops as `blocked` with `recording-drift`. A recording that is not published at that digest is refused as `plan-rejected` / `recording-unavailable`, and so is one naming an origin the plan does not admit (`recording-origin-not-declared`). Either refusal happens before any browser starts.

### Authenticator codes from a held seed

A plan may reference a held `totp-seed` in `credentialRefs` instead of a
`totp-code`. The seed is not a role: no interpreter can select it and no page
is ever given it. The service offers the derived `totp-code` role and computes
the code with `src/server/totp.ts` (RFC 6238: SHA-1/256/512, 6 or 8 digits, any
period; a bare base32 secret or an `otpauth://totp/` URI) **at fill time**, so a
code does not age while an interpreter decides. The seed is guarded before the
first page is read, in each spelling a page could show (raw, base32, grouped,
lower-case); the typed code is guarded by the driver as a secret role. A page
that shows either stops the attempt as `protected-value-exposed` (or
`indeterminate` once something was dispatched). A plan naming both a seed and a
static code is rejected. `tests/totp.test.ts` checks the RFC 4226 and RFC 6238
Appendix B vectors; `tests/browser-login-totp.test.ts` logs in against an owned
provider that checks the code, and covers both leak cases. The isolated
authorization executor used by authored connectors does not read seeds yet; its
code-entry path is still the agent inbox or a person.

### Keeping a value the provider issues

Some logins exist to take something away: an OAuth client's ID and secret from
the provider's developer settings, shown once after "Generate a new client
secret". A draft declares that in `issued`:

```json
{
  "sink": "oauth-client",
  "fields": [
    { "kind": "client-id", "label": "Client ID" },
    { "kind": "client-secret", "label": "Client secret" }
  ]
}
```

Each field is named by the **exact label** of the read-only input that shows
it, and each kind (`client-id`, `client-secret`) appears once, under one label;
an unknown kind, a repeated label or kind, more fields than kinds, a label
shaped like a value, or an `oauth-client` sink without a `client-id` is refused
by the schema. The declaration is compiled into the plan and its digest.

`sink` is a **kind the host registered**, never a callback: `oauth-client`
(the host mints a run-bound `common.oauth-client` handle with
`mintOAuthClient`, keyed by the login's `runRef`) or `credential-custody` (the
host writes into its private collector). The host passes the functions as
`issuedSinks` to `createHostBrowserLogin`; a plan naming a kind it did not
register is `plan-rejected` / `issued-sink-unavailable`, and the service
refuses one it was not given before a browser starts.

The driver, not the interpreter, reads the fields - all of them from one page
or none - and hands them to the sink once. A secret is guarded from that moment
like a typed password. The interpreter is told the labels (so it leaves them,
and any "Generate" button beside them, alone) and never whether anything was
read. A plan that keeps issued values drives with the goal `obtain-credential`
and ends `blocked` / `issued-value-missing` if the values were not all kept,
however signed in the browser is. The values are never in the result, a step,
a stored record or a recording; the recording carries the declaration, so a
reviewer sees what a replay keeps. `ISSUED-SERVICE` in
`tests/browser-login-service.test.ts` runs this through the host against the
auth double's developer settings and sweeps every surface for both values.

### Choices

A draft may name options for required `<select>` controls in `choices`, by the
field's exact label: `{ "Country or region": "Canada" }`. Both sides are page
text held to the page-label rule (no addresses, long digit runs or tokens), at
most eight entries, and part of the digest. The driver's `select` action
chooses an option by its **visible label**, only one the observation listed,
and only the plan's option where the plan named one; the adapter revalidates
the control exactly as it does for `fill`. A secret role is never filled into a
select. A required choice the plan did not make is not guessed: it is handed to
a person (`choice`), or ends `choice-required`.

## Handoffs

A handoff identifies the **attempt**, not the run. Keying a wait by run alone let
an abandoned first attempt's late reply — or its expiry timer — settle its
successor, and let any connected allowlisted port decide an attempt it was never
assigned. Both are now impossible: only a resolver assigned to that exact
attempt may answer it, once.

A completed handoff is a claim to check. The attempt re-observes the same target
and completion still requires the same provider evidence it always did.

A host brings a person in through the tools' `human(actor, plan)` dependency,
which returns the `HumanParticipation` for that actor and compiled plan (or
nothing, to decline). With one, a challenge, passkey or native dialog within the
plan's `interactionRounds` pauses the same attempt in the same browser and
resumes it after the person answers. Without one, the login ends
`requires-human`.

Two more reasons come from what the plan was _not_ given. On an RFC 8628
**device verification page** (recognised by `deviceVerificationField`: the
page's own wording, such as "Connect a device" or "Enter the code displayed on
your device", or a field named `user_code`) the agent types the user code only
when the plan supplied a `user-code` role; the device code never reaches a
page. Without it the request's reason is `device-code` and its `path` is the
verification URI - origin and pathname, so the code a
`verification_uri_complete` query carries is not in it - and a person holding
the device enters the code there. An unmade required choice is `choice`. The
interpreter only reports these walls; the driver checks the page really is one
before asking anybody. With nobody to ask they end as `requires-human` with
`device-code` or `choice`. The reference host configures none: its managed browsers are
headless on the server, with no surface a person could act in.

## Enabling it in a host

`createGitHubRuntime({ browserLogin })` assembles the session registry, effect
ledger, verifier registry, login service and shared tools
(`src/server/browser-login-host.ts`) and hands them to the teaching runtime, so
both `/api/v1/teaching/tools/browser-*` and the `browser_*` MCP tools appear.
Without `browserLogin` neither transport offers them. The host supplies what
only it can decide: `credentials` (how a collector reference resolves),
`knownConnectors`, reviewed `verifiers`, and optionally `credentialRefs`,
`human`, `allowUnverified`, `modelInterpreter` and `reuseVerifiedSessions`.
Nothing heavy loads until the first call.

The example server turns this on with `CEREMONY_BROWSER_LOGIN=true` (off by
default). It launches managed browsers on the local machine, allows the Add
Connection catalog's connector ids, and has **no** private collector for
browser-login references and **no** provider verifier. So a plan that needs a
credential stops without typing anything, and the best outcome it can reach is
`submitted-unverified`. `HOST-WIRED` and `HOST-LOGIN` in
`tests/browser-login-host.test.ts` cover the wiring with a fixture verifier.

## Running the suites

```sh
npm run setup:browsers                      # all three engines
npx tsx --test tests/browser-login-conformance.test.ts   # login contract, 3 engines
npx tsx --test tests/browser-targets.e2e.test.ts         # stale-target oracles, 3 engines
npx tsx --test tests/browser-session-lifetime.test.ts    # retention, leases, release
npx tsx --test tests/login-plan.test.ts                  # effective configuration
npx tsx --test tests/browser-login-handoff.test.ts       # attempt-bound handoffs
npx tsx --test tests/totp.test.ts tests/browser-login-totp.test.ts  # held TOTP seeds
npx tsx --test tests/browser-login-host.test.ts          # host wiring, session reuse
```

All of these are discovered by `npm test` and `npm run verify` automatically.

The conformance and target suites assert against the **fixture server's own
records** — which cookie it issued, which account it believes that cookie is,
and exactly what was posted to it — not against what the code under test
reported. `tests/fixtures/identity-provider.ts` also serves a `/forged` page
that renders a convincing signed-in banner and the account marker element while
setting no cookie, so "a DOM marker cannot establish verified status" is a test
rather than a claim.

## Not exercised

These are implemented paths with no evidence behind them here, or not
implemented at all. None of them is reported as supported anywhere in the code:

- **Live-provider verification.** Only the owned fixture verifier has been run.
  No real provider account was used.
- **Native authenticators.** Passkey pages produce a handoff; no hardware key,
  Windows Hello, or iCloud Keychain interaction was performed. Playwright's
  virtual authenticator is a test instrument and is not wired into production.
- **Installed Safari or mobile attachment.** Not implemented.
- **Store publication or extension signing.** Not performed, and not claimed.
- **Real-client MCP integration.** Protocol conformance is a separate claim from
  an attended end-to-end test with a specific product.
