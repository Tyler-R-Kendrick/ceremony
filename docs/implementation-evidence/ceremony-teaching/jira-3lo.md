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
