# Auth scenario doubles and ceremony contracts

An isolated-browser ceremony cannot be developed against live providers. A real sign-in page changes without notice, registration consumes an address that is then permanently in use, a wrong guess trips rate limiting, and a failure tells you nothing reproducible. Testing that way also produces its own failure mode: code that fits the handful of pages it was written against and stops working on the next one.

This suite replaces that with self-hosted doubles. Each auth situation an agent has to get through is served as an actual page over actual HTTP, and each is stated as a contract the driver must satisfy. Running against them is the deterministic evidence; it is not certification of any real provider.

## What is real and what is substituted

| Layer          | In these tests                                                                                                                                                                                                        |
| -------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Provider pages | Real HTML over real HTTP from `tests/doubles/auth-provider`, with sessions in cookies, redirects, form validation, confirmation mail, authorization-code + PKCE S256, a token endpoint, userinfo and OIDC discovery   |
| Page shape     | Regenerated per provider instance from a seed: field names, label wording, how a label is attached, control order, button captions, alert markup, signup path, and whether the address field is `type="email"` at all |
| Driver         | The real `runCeremony` from `src/server/browser-driver.ts`                                                                                                                                                            |
| Snapshot       | The real `snapshotDocument` from `src/core/browser-contracts.ts`, the same function in both runners                                                                                                                   |
| Browser        | A parsed document in the Node suite; a real Chromium in the browser suite                                                                                                                                             |
| Inference      | **Substituted.** A scripted interpreter stands in for the model                                                                                                                                                       |

The inference boundary is the only thing mocked, and it is mocked on purpose. In production the page is interpreted by a model, because no fixed rule set survives contact with real providers. A model in the loop would make every run non-deterministic and would need credentials in CI, so the contract suite supplies a deterministic interpreter instead and asserts what the driver does with whatever the interpreter proposes — including proposals that are wrong, unusable, or dishonest.

The scripted interpreter reads exactly what a model would: one sanitized snapshot, the roles on offer, and its own recent actions. It gets no markup, no selectors, no values, and no knowledge of which scenario is running. That is what makes it useful beyond determinism: if it can finish a ceremony from the snapshot alone, the snapshot carries enough signal to be interpreted at all. When it cannot, the snapshot is the thing at fault, and that is the finding.

## The scenario catalog

Each scenario states the provider situation, the preconditions that must hold before it starts, the roles the caller must be able to supply, and the one outcome the driver is required to reach. Families reference the [auth catalog](auth-catalog.md).

| Scenario                                                  | Flow kind          | Family                           | Preconditions                                                               | Roles required                                                                  | Required outcome                                                  |
| --------------------------------------------------------- | ------------------ | -------------------------------- | --------------------------------------------------------------------------- | ------------------------------------------------------------------------------- | ----------------------------------------------------------------- |
| `sign-in`                                                 | `form`             | Forms/session auth               | `account-exists`, `account-verified`                                        | `username`, `password`                                                          | completed                                                         |
| `sign-in-rejected`                                        | `form`             | Forms/session auth               | `account-exists`, `account-verified`                                        | `username`, `password`                                                          | blocked: `credentials-rejected`                                   |
| `sign-in-after-provider-fault`                            | `form`             | Forms/session auth               | `account-exists`, `account-verified`                                        | `username`, `password`                                                          | completed                                                         |
| `sign-in-unverified-account`                              | `form`             | OTP / magic link / MFA           | `account-exists`, `mailbox-readable`                                        | `username`, `password`, `verification-code`                                     | completed                                                         |
| `sign-in-human-challenge`                                 | `form`             | Forms/session auth               | `account-exists`                                                            | `username`, `password`                                                          | blocked: `human-challenge`                                        |
| `sign-in-form-targets-another-origin`                     | `form`             | Forms/session auth               | `account-exists`                                                            | `username`, `password`                                                          | blocked: `untrusted-origin`                                       |
| `registration-with-emailed-code`                          | `form`             | Forms/session auth               | `account-absent`, `address-unused`, `mailbox-readable`                      | `email`, `password`, `password-confirm`, `verification-code`                    | completed                                                         |
| `registration-with-confirmation-link`                     | `form`             | OTP / magic link / MFA           | `account-absent`, `address-unused`, `mailbox-readable`                      | `email`, `password`, `password-confirm`                                         | completed                                                         |
| `registration-requiring-terms`                            | `form`             | Forms/session auth               | `account-absent`, `address-unused`, `mailbox-readable`                      | `email`, `password`, `password-confirm`, `verification-code`                    | completed                                                         |
| `registration-address-already-in-use`                     | `form`             | Forms/session auth               | `account-exists`                                                            | `email`, `password`, `password-confirm`                                         | blocked: `account-exists`                                         |
| `registration-recovers-with-fresh-address`                | `form`             | Forms/session auth               | `account-exists`, `disposable-addresses`, `mailbox-readable`                | `email`, `alternate-email`, `password`, `password-confirm`, `verification-code` | completed                                                         |
| `registration-started-from-sign-in`                       | `form`             | Forms/session auth               | `account-absent`, `address-unused`, `mailbox-readable`                      | `email`, `password`, `password-confirm`, `verification-code`                    | completed                                                         |
| `registration-human-challenge`                            | `form`             | Forms/session auth               | `account-absent`                                                            | `email`, `password`, `password-confirm`                                         | blocked: `human-challenge`                                        |
| `sign-in-with-second-factor`                              | `form`             | OTP / magic link / MFA           | `account-exists`, `account-verified`                                        | `username`, `password`, `totp-code`                                             | completed                                                         |
| `authorization-code-with-consent`                         | `oauth-code`       | OAuth authorization code + PKCE  | `account-exists`, `account-verified`, `registered-client`                   | `username`, `password`                                                          | completed with a code                                             |
| `authorization-code-denied`                               | `oauth-code`       | OAuth authorization code + PKCE  | `account-exists`, `account-verified`, `registered-client`                   | `username`, `password`                                                          | blocked: `consent-denied`                                         |
| `authorization-requires-registration-first`               | `oauth-code`       | OAuth authorization code + PKCE  | `account-absent`, `address-unused`, `mailbox-readable`, `registered-client` | `email`, `password`, `password-confirm`, `verification-code`                    | completed with a code                                             |
| `device-approval`                                         | `device`           | OAuth device authorization       | `account-exists`, `account-verified`                                        | `username`, `password`, `user-code`                                             | completed                                                         |
| `page-without-any-ceremony`                               | `form`             | Forms/session auth               | `account-exists`                                                            | `username`, `password`                                                          | blocked: `unsupported-page`                                       |
| `inert-sign-in-control`                                   | `form`             | Forms/session auth               | `account-exists`                                                            | `username`, `password`                                                          | stalled                                                           |
| `sign-in-that-never-accepts`                              | `form`             | Forms/session auth               | `account-exists`                                                            | `username`, `password`                                                          | exhausted                                                         |
| `challenge-cleared-by-a-person`                           | `form`             | Forms/session auth               | `account-exists`, `account-verified`, `human-available`                     | `username`, `password`                                                          | completed (1 handoff)                                             |
| `challenge-declined-by-a-person`                          | `form`             | Forms/session auth               | `account-exists`, `account-verified`, `human-available`                     | `username`, `password`                                                          | blocked: `human-declined`                                         |
| `challenge-claimed-without-clearing-it`                   | `form`             | Forms/session auth               | `account-exists`, `account-verified`, `human-available`                     | `username`, `password`                                                          | blocked: `human-challenge` (2 handoffs)                           |
| `passkey-handed-to-a-person`                              | `form`             | Passkeys / WebAuthn              | `account-exists`, `account-verified`, `human-available`                     | `username`, `password`                                                          | completed (1 handoff)                                             |
| `passkey-required-with-nobody-to-ask`                     | `form`             | Passkeys / WebAuthn              | `account-exists`, `account-verified`                                        | `username`, `password`                                                          | blocked: `passkey-required` (0 handoffs)                          |
| `conditional-passkey-needs-no-person`                     | `form`             | Passkeys / WebAuthn              | `account-exists`, `account-verified`, `human-available`                     | `username`, `password`                                                          | completed (0 handoffs)                                            |
| `basic-dialog-answered-by-a-person`                       | `basic`            | HTTP Basic                       | `account-exists`, `account-verified`, `human-available`                     | none                                                                            | completed (1 handoff)                                             |
| `basic-dialog-with-nobody-to-ask`                         | `basic`            | HTTP Basic                       | `account-exists`, `account-verified`                                        | none                                                                            | blocked: `native-dialog` (0 handoffs)                             |
| `access-token-issued-for-private-collection`              | `api-key`          | API key / personal access token  | `account-exists`, `account-verified`                                        | `username`, `password`, `display-name`                                          | completed                                                         |
| `anonymous-access-then-claim`                             | `authmd-anonymous` | auth.md anonymous + claim        | `account-absent`, `mailbox-readable`                                        | `email`, `verification-code`                                                    | unverified                                                        |
| `application-registered-and-installed`                    | `github-app`       | github-app                       | `account-exists`, `account-verified`                                        | `username`, `password`, `display-name`                                          | completed                                                         |
| `openid-connect-identity`                                 | `oauth-code`       | OpenID Connect                   | `account-exists`, `account-verified`, `registered-client`                   | `username`, `password`                                                          | completed with a code                                             |
| `saml-post-binding`                                       | `form`             | SAML federation                  | `account-exists`, `account-verified`                                        | `username`, `password`                                                          | completed                                                         |
| `mcp-authorization-with-resource-binding`                 | `oauth-code`       | MCP HTTP authorization           | `account-exists`, `account-verified`, `registered-client`                   | `username`, `password`                                                          | completed with a code                                             |
| `public-resource-needs-no-ceremony`                       | `form`             | Public / no authentication       | none                                                                        | none                                                                            | unverified (0 handoffs)                                           |
| `delegated-authorization`                                 | `oauth-code`       | OAuth delegated actor (proposed) | `account-exists`, `account-verified`, `registered-client`                   | `username`, `password`                                                          | completed with a code; token carries `act`                        |
| `delegated-authorization-needs-the-agent-to-authenticate` | `oauth-code`       | OAuth delegated actor (proposed) | `account-exists`, `account-verified`, `registered-client`                   | `username`, `password`                                                          | completed with a code the agent must still authenticate to redeem |
| `delegated-authorization-unknown-agent`                   | `oauth-code`       | OAuth delegated actor (proposed) | `account-exists`, `account-verified`, `registered-client`                   | `username`, `password`                                                          | blocked: `provider-error`                                         |
| `signed-agent-passes-the-bot-gate`                        | `form`             | Signed agent identity (proposed) | `account-exists`, `account-verified`                                        | `username`, `password`                                                          | completed (0 handoffs)                                            |
| `unsigned-agent-meets-the-bot-gate`                       | `form`             | Signed agent identity (proposed) | `human-available`, `account-exists`, `account-verified`                     | `username`, `password`                                                          | completed after 1 handoff                                         |
| `expired-signature-is-not-a-signature`                    | `form`             | Signed agent identity (proposed) | `human-available`, `account-exists`, `account-verified`                     | `username`, `password`                                                          | completed after 1 handoff                                         |
| `unknown-signing-key-is-refused`                          | `form`             | Signed agent identity (proposed) | `account-exists`, `account-verified`                                        | `username`, `password`                                                          | blocked: `human-challenge` (0 handoffs)                           |

Every kind in `flowKinds` has at least one scenario, and a test fails when one does not: a catalog must not look complete while a documented flow has no page behind it. `client-credentials`, certificate and workload-federation profiles are deliberately absent — they have no browser step at all, and inventing a page for them would be a fixture pretending to be evidence.

Preconditions are not commentary. `startScenario` seeds the provider from them, so a scenario that claims `account-exists` gets an account and one that claims `account-absent` does not. Declared roles are checked against what the driver was actually offered, so a scenario cannot understate what a ceremony needs.

Three of these exist because a ceremony often has prerequisites rather than a single form. `authorization-requires-registration-first` has no account yet, so consent is only reachable after a full registration and email confirmation. `registration-address-already-in-use` and `registration-recovers-with-fresh-address` are the same wall with different capabilities: the first caller has one address and must report that it is taken, the second declares `alternate-email` and is expected to recover. The difference is in what the caller can do, not in what the interpreter guesses.

## Scenarios that track a draft, not a standard

Some of what an agent will have to authenticate against is still being written. Those scenarios are in the catalog, under a family whose name ends in `(proposed)`, and each one declares the Internet-Draft and revision it was written against. A test asserts both directions: a proposed family must name a draft, and a settled family must not claim one. Drafts move, so the revision is what makes a later divergence visible instead of silent.

**Delegated actor** — [`draft-oauth-ai-agents-on-behalf-of-user-02`](https://datatracker.ietf.org/doc/html/draft-oauth-ai-agents-on-behalf-of-user-02). An authorization-code flow carrying `requested_actor` on the authorization request and `actor_token` on the token request, issuing an access token whose `act.sub` names the agent that is acting. Three things are worth separating here, and the scenarios separate them:

- The **consent page names the agent**, not only the client asking. Delegation is a different question from access, so the person is asked it out loud.
- **Approval is not a grant.** A code obtained with a person's consent buys nothing until the agent authenticates for itself: the same code is refused unauthenticated, refused for a different agent, and refused with a self-signed actor token — and none of those refusals consumes the grant, so the real agent can still redeem it. This is the same rule as A2H-04, applied one layer down.
- **An agent the provider does not know is refused before anyone is asked.** That ends `blocked: provider-error`, never `consent-denied`; nobody declined, so reporting a refusal would misplace the blame.

These prove the shape of the draft against pages and a token endpoint that implement it. None of them says a real provider does.

**Signed agent identity** — [`draft-meunier-webbotauth-httpsig-protocol-02`](https://datatracker.ietf.org/doc/html/draft-meunier-webbotauth-httpsig-protocol-02), the Web Bot Auth work. An agent signs its own requests with an Ed25519 key (RFC 9421, `tag="web-bot-auth"`, `keyid` being the RFC 7638 JWK thumbprint) and publishes the public half at `/.well-known/http-message-signatures-directory`; the origin fetches that directory and verifies before deciding what it is talking to.

This is not an authentication method in the sense the rest of the catalog uses — it says nothing about which user is present — so it is modelled as a **gate in front of** an ordinary form sign-in rather than as a flow of its own. The signature belongs to the client the agent runs in, not to any step, so each runner configures it before the first navigation and the driver never sees it. One signature covers `@authority` only, which the draft permits and which is what lets a browser carry it as an ordinary header for a whole ceremony.

What the four scenarios are really about is the **fork**:

- A **recognised agent passes invisibly** and costs nobody anything — 0 handoffs.
- An **unsigned agent is put in front of a person**, not turned away: 403 carrying `Accept-Signature` and the same interstitial a person clears, after which the ceremony resumes and completes. Same goal, same provider, one path costing a person's time.
- A **lapsed signature is worth exactly nothing** — it costs the same handoff as arriving with no key at all.
- A signature from a **key the directory never published** is refused, and with nobody to ask and a wall that cannot be cleared the run ends `blocked: human-challenge` having signed in as nobody.

That last pair matters for a system meant to choose between paths: a signature is only an advantage while it verifies, and the cost of it not verifying is a person's attention.

## A step that needs a person is a step, not a failure

A CAPTCHA, a passkey prompt with nothing to type, and an HTTP Basic dialog have one thing in common: no agent can complete them, and every one of them is ordinary. Ending the attempt there would be the wrong answer for a framework whose purpose is guiding human participation, and it would contradict the handoff contract, which says `resume: "verify"`.

So the driver hands off instead. It carries the connector's declared `humanHandoffContractSchema` — `surface`, `recipient`, `delegation: "a2h-authorize"` — and asks for a person, giving them the live page so an own-browser fallback always exists, as A2H-05 requires. When they are done, the attempt resumes on the page as it now stands.

What a person says is a claim, never a grant, which is the same rule A2H-04 states for APPROVE. Four things follow, and each has a scenario:

- A person who clears the widget lets the ceremony finish, and the result records that a handoff happened.
- A person who **says** they finished without doing anything changes nothing: the agent resumes, finds the same widget, asks once more, and the attempt ends `blocked: human-challenge` with no access created.
- A person who refuses ends it as `human-declined`, not as a provider failure.
- With nobody to ask, the step is named — `human-challenge`, `passkey-required`, `native-dialog` — instead of hanging or guessing.

The distinction between a passkey prompt and a passkey _hint_ matters. A page carrying the `webauthn` autocomplete hint beside a password box is conditional UI: it still accepts a password, so it is driven normally and nobody is interrupted. Only a prompt with nothing else to fill actually requires the authenticator. Both are scenarios, because over-triggering a handoff is its own defect.

An HTTP Basic dialog is browser chrome, not page content, so it is invisible in the DOM and visible only as a 401 with `WWW-Authenticate`. The person answers the dialog, the credentials stay with the browser, and the agent resumes holding nothing — a contract test asserts the password never reaches its transcript.

## What the driver must do regardless of scenario

Every scenario additionally asserts the invariants, so they hold across the whole catalog rather than in one place:

- **An attempt always terminates with a named outcome.** `completed`, `blocked` with a reason, `unverified`, `stalled` or `exhausted`. There is no path that waits indefinitely for a page that will not appear — a form that never accepts ends `exhausted`, a control that changes nothing ends `stalled`, and a page with nothing to act on ends `blocked` in a few steps.
- **Completion needs evidence.** An interpreter that claims `done` does not finish the ceremony. The driver accepts completion only from a captured redirect or a provider-side check, so an interpreter that only ever claims success ends `unverified` with no access created.
- **A human challenge is the driver's refusal.** The interpreter is never consulted on a challenge page, which is asserted directly rather than left to an interpreter that happens to recognise one.
- **No value reaches the inference boundary.** Passwords, confirmation codes and second-factor codes never appear in a snapshot, a prompt, a note or a transcript; an authorization code never appears in any of them, and a snapshot path carries no query string. A value the driver substituted cannot be echoed back out through a note: the attempt fails with `CeremonySecretLeak`.
- **Secrets stay on permitted origins.** The driver refuses to enter one on an origin outside the allowlist, and refuses when the page's own form posts somewhere outside it — the case where an origin check alone is too late, because by then the value is already sent.
- **A displayed credential is out of reach.** A snapshot carries headings, alerts and control captions, never arbitrary page text, so an access token printed on a page cannot be read by the agent or its interpreter. The `obtain-credential` ceremony succeeds because the credential now _exists_ at the provider; its value is for a person to place in a private collector.
- **A step needing a person never reaches the interpreter.** Not the challenge, not the passkey prompt, not the dialog. Asserted directly, so an interpreter that happens to recognise one cannot be what saves the run.
- **Roles are a capability, not a suggestion.** An action naming a role the caller never supplied is discarded before any resolution is attempted.

## A third runner, for evidence

`npm run test:flows` drives the same catalog through a real browser using
[Vercel's `agent-browser` CLI](https://github.com/vercel-labs/agent-browser), and
records it. Each scenario leaves `artifacts/flows/<id>/` containing the ceremony
as video, a value-free transcript, and the page's console and error logs, so a
broken auth flow leaves something a person can watch instead of a status word.
Evidence is written before the assertion, so a failing flow keeps its recording.
CI runs it as its own job and uploads the directory whether or not it passed.

Capturing any of this is only safe because **these pages are ours**. Recording a
live provider would retain exactly what verification is forbidden to keep, so
this runner is never pointed at one. Two further consequences are worth stating:
the CLI takes values as process arguments, which are visible in the process list
while a command runs, and the doubles are seeded with synthetic values — another
reason real credentials stay out of it.

The snapshot still comes from the shared `snapshotDocument`, shipped into the
page with `eval`, so a contract proved here means what it means in the other two
runners. Driving a third engine immediately found two defects the first two had
not: a helper the compiler emits into the shipped snapshot source (which had
made the Playwright adapter depend on which tool compiled its caller), and a
date control that silently refuses a typed value, which the driver correctly
reported as a stall rather than a completed ceremony.

## Running them

```sh
npm run test:scenarios     # the Node suite: catalog, invariants and driver boundaries
npm run test:e2e           # includes the same catalog through a real Chromium
npm run test:flows         # the same catalog again, recorded, via agent-browser
```

Both run under `npm run verify`. The Node suite is discovered by `npm test` and by `npm run test:pact`.

The catalog pins a seed per scenario so a failure replays exactly. That alone would let a driver pass by fitting twenty pages, so the suite also runs core ceremonies against shapes no committed seed chose:

```sh
SCENARIO_SEEDS=50 npm run test:scenarios          # widen the sweep
SCENARIO_SEED=64455 SCENARIO_SEEDS=1 npm run test:scenarios   # replay one shape
```

A failure message names the seed to replay. Page shapes derive from the instance seed and the page's own name, not from the order requests arrive in, so the same seed serves the same pages every time — a fixture whose shape drifted between renders could not be replayed at all.

This sweep is how the suite earns its keep. It has already found real defects that the pinned seeds did not: an action pattern that matched the caption "Create account" but not the link "Create an account", and a driver counter that reset often enough that its own refusal cap could never trip.

## Two runners, two different things proved

The Node suite uses a parsed document and real HTTP. It is fast enough to run the whole catalog in about a second and to sweep hundreds of page shapes, and it covers the protocol end to end. It does not execute scripts, resolve styles or perform a real click.

`tests/browser/auth-scenarios.spec.ts` runs the identical catalog through Chromium and the Playwright adapter, which covers exactly what the other cannot. One test in it asserts that both runners produce the same snapshot for the same markup, so a contract proved in one means the same thing in the other. Neither result is reported as covering the other.

Two scenarios are excluded from the browser catalog rather than skipped inside it: a browser credential dialog is chrome, not page content, and Playwright answers it through context configuration instead of the page. Verification counts a skipped browser result as a failure, which is the right rule — a skip reads the same whether it was deliberate or a test that quietly stopped covering anything. Excluding them keeps that signal honest, each exclusion states its reason, a test holds the list to at most two, and both scenarios still run in full in the Node suite.

## What a green run does not mean

- It is not evidence about any live provider. These pages are ours. A provider can change its markup, add a challenge, rate-limit, or require a step no scenario models. Live behaviour is covered only by separately authorized attended checks.
- It says nothing about the model. The production interpreter is a model; this suite substitutes it. What the suite proves about inference is narrow and specific: that the snapshot is sufficient to act on, and that the driver holds regardless of what the interpreter proposes. Model quality is not measured here.
- It does not cover script-driven providers in the Node runner. A provider that builds its form in JavaScript is covered by the browser suite only.
- The scripted interpreter is a test double and must never be shipped. It lives in `tests/doubles/` for that reason. Deterministic page parsing was tried as a production approach and failed on the first provider it had not been written for.

## Adding a scenario

Add an entry to `authScenarios` in `tests/doubles/auth-provider/scenarios.ts` with its family, preconditions, required roles and required outcome, and add whatever provider behaviour it needs to `ProviderBehavior`. Prefer a new behaviour flag over a new endpoint, so the new situation composes with existing ones. A scenario whose outcome is `completed` should also carry a `confirm` that checks provider-side state: a returned status is not proof that a ceremony happened, and an authorization scenario should redeem its code and prove the code cannot be redeemed twice.

Keep the catalog honest about the families it claims. A coverage test fails if a family, an outcome or a blocked reason loses its last scenario, and another fails if a scenario is missing from the table above.
