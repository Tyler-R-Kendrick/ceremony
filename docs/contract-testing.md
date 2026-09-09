# External service contracts

Run `npm run test:pact` (Node >=22.12). It is also part of `npm run verify` and CI. Pact needs permission to bind a random loopback port; a sandbox socket denial is an environment failure, not a passing or failing API contract.

The GitHub App tests exercise the production `GitHubAppCeremonies` adapter against Pact V4 over real HTTP. The injected transport changes only the GitHub API origin. Coverage includes manifest-code conversion, signed app identity, installation identity, least-privilege token issuance, repository access, and rejected credentials. A deliberate `contents: read` → `write` request mutation must fail Pact matching. Its mismatch log is expected; the test passes only when that rejection occurs.

Fixtures use a fresh encrypted in-memory database and synthetic RSA credentials, never session environment values. Pact files are generated in unique temporary directories and removed after each test, including failures. They are consumer-generated evidence, not hand-written API schemas. Native GitHub registration form serialization remains covered by `tests/browser/github.spec.ts`; Pact does not test that browser UI.

## What a green result means

These are **consumer contract tests**, not proof that live providers currently satisfy the contract. Provider implementations and state setup are outside this repository's control. Additional contracts exercise configured Basic/API-key/form backends, OAuth authorization-code/PKCE and device authorization, Neon's anonymous identity exchange, and A2H discovery authentication rejection. The configured-backend contracts describe our adapter interface, not direct certification of Jira, Stripe or Supabase. A2H signed delivery is covered by behavioral/retry tests, not a Pact provider verification. Vendor-specific remote CDP is tested with a real local browser and simulated vendor commands, not HTTP Pact or live Cloudflare certification.

For a provider we own, run Pact's `Verifier` against the real provider service with isolated state handlers and the generated pact files. Stub its downstream dependencies, not its own routes. Only after both sides verify should CI publish exact commit/branch versions and use a broker's `can-i-deploy` decision. Do not deploy a fake GitHub provider and report it as external verification. Live third-party checks require separately authorized accounts, credentials and side effects.

## Agent workflow

Start at the production adapter and official endpoint documentation; identify what it sends, consumes and rejects. Reuse existing state names and keep states independent. Preserve exact permission semantics while allowing unrelated response additions. Add the smallest happy/failure interaction and a targeted incompatibility check, run focused tests, review the diff, then run full verification. Never regenerate expectations merely to accept a regression.

PactFlow provides an official AI assistant skill with offline guidance and optional broker/MCP-backed state discovery and test review. Reuse known provider states before generating tests. Cloud review and contract publication can transmit code or credentials: neither is configured here. Local scoped `tests/contracts/AGENTS.md` supplies the rules without requiring a broker or uploading repository contents.

## Primary references

- [Pact consumer test guidance](https://docs.pact.io/consumer)
- [JavaScript consumer API](https://docs.pact.io/implementation_guides/javascript/docs/consumer) and [matching rules](https://docs.pact.io/implementation_guides/javascript/docs/matching)
- [Provider verification](https://docs.pact.io/implementation_guides/javascript/docs/provider) and [when Pact fits public APIs](https://docs.pact.io/getting_started/what_is_pact_good_for)
- [Official PactFlow AI assistant skill](https://docs.pact.io/ai_tools/pactflow-skill)
- [GitHub App REST endpoints](https://docs.github.com/en/rest/apps/apps?apiVersion=2022-11-28) and [installation endpoints](https://docs.github.com/en/rest/apps/installations?apiVersion=2022-11-28), matching the adapter's pinned API version
