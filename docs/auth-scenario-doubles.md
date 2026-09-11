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

| Scenario                                    | Family                          | Preconditions                                                               | Roles required                                                                  | Required outcome                |
| ------------------------------------------- | ------------------------------- | --------------------------------------------------------------------------- | ------------------------------------------------------------------------------- | ------------------------------- |
| `sign-in`                                   | Forms/session auth              | `account-exists`, `account-verified`                                        | `username`, `password`                                                          | completed                       |
| `sign-in-rejected`                          | Forms/session auth              | `account-exists`, `account-verified`                                        | `username`, `password`                                                          | blocked: `credentials-rejected` |
| `sign-in-after-provider-fault`              | Forms/session auth              | `account-exists`, `account-verified`                                        | `username`, `password`                                                          | completed                       |
| `sign-in-unverified-account`                | OTP / magic link / MFA          | `account-exists`, `mailbox-readable`                                        | `username`, `password`, `verification-code`                                     | completed                       |
| `sign-in-human-challenge`                   | Forms/session auth              | `account-exists`                                                            | `username`, `password`                                                          | blocked: `human-challenge`      |
| `sign-in-form-targets-another-origin`       | Forms/session auth              | `account-exists`                                                            | `username`, `password`                                                          | blocked: `untrusted-origin`     |
| `registration-with-emailed-code`            | Forms/session auth              | `account-absent`, `address-unused`, `mailbox-readable`                      | `email`, `password`, `password-confirm`, `verification-code`                    | completed                       |
| `registration-with-confirmation-link`       | OTP / magic link / MFA          | `account-absent`, `address-unused`, `mailbox-readable`                      | `email`, `password`, `password-confirm`                                         | completed                       |
| `registration-requiring-terms`              | Forms/session auth              | `account-absent`, `address-unused`, `mailbox-readable`                      | `email`, `password`, `password-confirm`, `verification-code`                    | completed                       |
| `registration-address-already-in-use`       | Forms/session auth              | `account-exists`                                                            | `email`, `password`, `password-confirm`                                         | blocked: `account-exists`       |
| `registration-recovers-with-fresh-address`  | Forms/session auth              | `account-exists`, `disposable-addresses`, `mailbox-readable`                | `email`, `alternate-email`, `password`, `password-confirm`, `verification-code` | completed                       |
| `registration-started-from-sign-in`         | Forms/session auth              | `account-absent`, `address-unused`, `mailbox-readable`                      | `email`, `password`, `password-confirm`, `verification-code`                    | completed                       |
| `registration-human-challenge`              | Forms/session auth              | `account-absent`                                                            | `email`, `password`, `password-confirm`                                         | blocked: `human-challenge`      |
| `sign-in-with-second-factor`                | OTP / magic link / MFA          | `account-exists`, `account-verified`                                        | `username`, `password`, `totp-code`                                             | completed                       |
| `authorization-code-with-consent`           | OAuth authorization code + PKCE | `account-exists`, `account-verified`, `registered-client`                   | `username`, `password`                                                          | completed with a code           |
| `authorization-code-denied`                 | OAuth authorization code + PKCE | `account-exists`, `account-verified`, `registered-client`                   | `username`, `password`                                                          | blocked: `consent-denied`       |
| `authorization-requires-registration-first` | OAuth authorization code + PKCE | `account-absent`, `address-unused`, `mailbox-readable`, `registered-client` | `email`, `password`, `password-confirm`, `verification-code`                    | completed with a code           |
| `device-approval`                           | OAuth device authorization      | `account-exists`, `account-verified`                                        | `username`, `password`, `user-code`                                             | completed                       |
| `page-without-any-ceremony`                 | Forms/session auth              | `account-exists`                                                            | `username`, `password`                                                          | blocked: `unsupported-page`     |
| `inert-sign-in-control`                     | Forms/session auth              | `account-exists`                                                            | `username`, `password`                                                          | stalled                         |
| `sign-in-that-never-accepts`                | Forms/session auth              | `account-exists`                                                            | `username`, `password`                                                          | exhausted                       |

Preconditions are not commentary. `startScenario` seeds the provider from them, so a scenario that claims `account-exists` gets an account and one that claims `account-absent` does not. Declared roles are checked against what the driver was actually offered, so a scenario cannot understate what a ceremony needs.

Three of these exist because a ceremony often has prerequisites rather than a single form. `authorization-requires-registration-first` has no account yet, so consent is only reachable after a full registration and email confirmation. `registration-address-already-in-use` and `registration-recovers-with-fresh-address` are the same wall with different capabilities: the first caller has one address and must report that it is taken, the second declares `alternate-email` and is expected to recover. The difference is in what the caller can do, not in what the interpreter guesses.

## What the driver must do regardless of scenario

Every scenario additionally asserts the invariants, so they hold across the whole catalog rather than in one place:

- **An attempt always terminates with a named outcome.** `completed`, `blocked` with a reason, `unverified`, `stalled` or `exhausted`. There is no path that waits indefinitely for a page that will not appear — a form that never accepts ends `exhausted`, a control that changes nothing ends `stalled`, and a page with nothing to act on ends `blocked` in a few steps.
- **Completion needs evidence.** An interpreter that claims `done` does not finish the ceremony. The driver accepts completion only from a captured redirect or a provider-side check, so an interpreter that only ever claims success ends `unverified` with no access created.
- **A human challenge is the driver's refusal.** The interpreter is never consulted on a challenge page, which is asserted directly rather than left to an interpreter that happens to recognise one.
- **No value reaches the inference boundary.** Passwords, confirmation codes and second-factor codes never appear in a snapshot, a prompt, a note or a transcript; an authorization code never appears in any of them, and a snapshot path carries no query string. A value the driver substituted cannot be echoed back out through a note: the attempt fails with `CeremonySecretLeak`.
- **Secrets stay on permitted origins.** The driver refuses to enter one on an origin outside the allowlist, and refuses when the page's own form posts somewhere outside it — the case where an origin check alone is too late, because by then the value is already sent.
- **Roles are a capability, not a suggestion.** An action naming a role the caller never supplied is discarded before any resolution is attempted.

## Running them

```sh
npm run test:scenarios     # the Node suite: catalog, invariants and driver boundaries
npm run test:e2e           # includes the same catalog through a real Chromium
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

## What a green run does not mean

- It is not evidence about any live provider. These pages are ours. A provider can change its markup, add a challenge, rate-limit, or require a step no scenario models. Live behaviour is covered only by separately authorized attended checks.
- It says nothing about the model. The production interpreter is a model; this suite substitutes it. What the suite proves about inference is narrow and specific: that the snapshot is sufficient to act on, and that the driver holds regardless of what the interpreter proposes. Model quality is not measured here.
- It does not cover script-driven providers in the Node runner. A provider that builds its form in JavaScript is covered by the browser suite only.
- The scripted interpreter is a test double and must never be shipped. It lives in `tests/doubles/` for that reason. Deterministic page parsing was tried as a production approach and failed on the first provider it had not been written for.

## Adding a scenario

Add an entry to `authScenarios` in `tests/doubles/auth-provider/scenarios.ts` with its family, preconditions, required roles and required outcome, and add whatever provider behaviour it needs to `ProviderBehavior`. Prefer a new behaviour flag over a new endpoint, so the new situation composes with existing ones. A scenario whose outcome is `completed` should also carry a `confirm` that checks provider-side state: a returned status is not proof that a ceremony happened, and an authorization scenario should redeem its code and prove the code cannot be redeemed twice.

Keep the catalog honest about the families it claims. A coverage test fails if a family, an outcome or a blocked reason loses its last scenario, and another fails if a scenario is missing from the table above.
