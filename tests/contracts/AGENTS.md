# Boundary contract tests

Read [the contract-testing guide](../../docs/contract-testing.md) before changing these tests.

The rules below govern the Pact consumer contracts. `auth-scenarios.test.ts` is a ceremony scenario contract driven against self-hosted provider doubles rather than Pact; read [auth scenario doubles](../../docs/auth-scenario-doubles.md) before changing it, and keep its substituted boundary limited to inference.

- Run the real production consumer against Pact's HTTP server. Never replace its API calls with test-written requests or canned fetch responses.
- Read the provider's official API documentation and existing interactions first. Reuse provider-state names; keep tests independent and fixtures synthetic.
- Match request methods, paths, query parameters and semantic permissions exactly. Use matchers only for genuinely variable values. Assert the fields and outcomes the consumer actually uses.
- Exercise a supported failure response and prove a relevant incompatible request is rejected. Do not weaken matchers to make a failure green.
- Run `npm run test:pact`, then `npm run verify`. Report consumer validation separately from provider verification and live/browser checks.
- Never use real session secrets, publish contracts, connect a broker, or upload code to AI review services without authorization. Generated contracts can contain response credentials.
- Do not call a mock implementation of GitHub a verified provider. Provider verification must exercise the provider's real implementation with controlled states.
