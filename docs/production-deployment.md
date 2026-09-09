# Production deployment and release gates

The hosted reference keeps the Vite/OpenUI frontend and uses Nitro as a thin server carrier for the Workflow SDK. `nitro.config.ts` installs `workflow/nitro`; `hosted/` mounts the same teaching HTTP handlers used by the deterministic fixture. The server-only teaching export owns PostgreSQL, identity, provider operations and agent coordination. Core consumers do not import these dependencies.

Build the existing frontend with `npm run build`, then `npm run build:hosted`. `npm run dev:hosted` is a developer command, not an end-user prerequisite. The Workflow integration follows the [official Nitro integration](https://workflow-sdk.dev/docs/getting-started/nitro). Deploy only to an explicitly authorized project; these commands do not authorize provisioning, billing, accounts or grants.

## Required hosted configuration

Supply configuration through the host's protected environment, not through the browser Environment editor, recipe definitions or model tools:

| Name                             | Purpose                                                                                               |
| -------------------------------- | ----------------------------------------------------------------------------------------------------- |
| `CEREMONY_PUBLIC_ORIGIN`         | One exact HTTPS origin, with no path, query, credentials or fragment.                                 |
| `CEREMONY_DATABASE_URL`          | Configured shared PostgreSQL connection; use the provider's verified TLS settings.                    |
| `CEREMONY_VAULT_KEY`             | 32-byte encryption key encoded as 64 hexadecimal characters, stored outside the database and backups. |
| `CEREMONY_VAULT_KEY_ID`          | Non-secret key identifier used by encrypted records.                                                  |
| `CEREMONY_OIDC_ISSUER`           | Trusted end-user identity issuer. Deployment/workload OIDC is not a substitute.                       |
| `CEREMONY_OIDC_CLIENT_ID`        | Registered hosted application client.                                                                 |
| `CEREMONY_OIDC_CLIENT_SECRET`    | Server-only client secret when required by the identity provider.                                     |
| `CEREMONY_TENANT_ID`             | Trusted deployment tenant mapping.                                                                    |
| `CEREMONY_GITHUB_ACCOUNT`        | Authorized target account for this reference deployment.                                              |
| `CEREMONY_CONFIGURATION_VERSION` | Change when authority-relevant provider/origin/permission configuration changes.                      |

The identity adapter validates the OIDC protocol response and maps signed `ceremony_roles` to explicit author, reviewer, publisher, executor and administrator capabilities. When absent, roles default to executor only. Give publication rights through the identity provider, not a browser flag. Login, logout and protected sessions use the shared store; the browser's resume hint does not authenticate the user. Production has no anonymous-owner fallback.

The native Environment section uses authenticated `/api/environment`: GET returns variable names/revision only; POST accepts bounded JSON edits or an optional dotenv string and stores values encrypted. It is shared across connectors within the authenticated session, not across unrelated sessions. `GITHUB_APP_ID`, `GITHUB_APP_SLUG`, `GITHUB_APP_OWNER` and `GITHUB_APP_PRIVATE_KEY` are consumed together by the trusted GitHub configuration resolver. Partial configuration blocks with a setup message. Changes bind a new configuration version and cannot silently replace an app during an in-progress callback.

Cross-device identity restoration does not copy a session's private Environment. A session with no GitHub configuration edits uses the host configuration version so the same authenticated principal can reuse compatible verified host access after a new login. A protected GitHub-specific revision changes only when the four GitHub app variables change or are removed; editing an unrelated connector's variables does not invalidate GitHub. Once a session has edited GitHub configuration, even clearing it advances its session-bound version. Legacy records without this metadata conservatively retain their existing revision as a baseline. Returning from another authenticated session may therefore require explicit reconfiguration; no private values travel in a resume hint.

Local identity fixtures require both `NODE_ENV=test` and `CEREMONY_TEST_PROFILE=true`; this is not a deployment mode for preview URLs. Keep production callbacks fixed. Register the exact callback routes actually emitted by the trusted identity/GitHub adapters. Do not register every preview deployment as a production OAuth origin.

Use configured Marketplace PostgreSQL (for example Neon or Supabase) rather than the discontinued Vercel Postgres product. [Vercel's PostgreSQL guidance](https://vercel.com/docs/postgres) describes the supported Marketplace path. Nothing in Ceremony provisions a database automatically. The local test dependency starts an isolated real PostgreSQL server solely for deterministic developer tests.

## Optional model and workflow configuration

`CEREMONY_MODEL_URL` remains a full OpenAI-compatible `/chat/completions` endpoint. Set `CEREMONY_MODEL` and, where required, server-only `CEREMONY_MODEL_KEY`. Endpoint adaptation removes the suffix exactly once and checks the resulting request destination. It never silently switches local users to a paid Gateway. Set `CEREMONY_MODEL_GATEWAY=true` only when choosing configured Gateway routing; do not combine it with an explicit compatible endpoint.

Without a model, deterministic connection and reviewed recipe execution remain available. A model outage is not permission to fabricate completion. AI SDK handles the bounded tool loop; Workflow carries durable waits/wakes. PostgreSQL commands and policy remain authoritative. Workflow histories contain correlation IDs and bounded status—not collector values, provider codes, tokens, PEMs or private control links. A wake requests rechecking state, never approves an effect. See [agent integration](agent-integration.md).

The existing optional Cloudflare executor is not a general recorder and is not enabled by the hosted configuration above. Native WebMCP is an additional browser transport, not a requirement to connect. Installed-PWA and hosted-platform certification are distinct from browser emulation and local Workflow tests.

## Browser sign-in and durable work dispatch

The hosted UI reads the public, non-sensitive `/api/config`. Native sign-in sends same-origin JSON `{}` to `POST /api/auth/login`; the response contains the trusted human `authorizationUrl` and sets an HttpOnly login-binding cookie. Navigate in the user's browser. `/api/auth/callback` validates the signed OIDC result and returns with secure session cookies. `POST /api/auth/logout` clears the session and instructs the browser to clear caches/storage. None of these authorization URLs is an agent tool result.

To resume an original host task, configure `CEREMONY_CONTINUATION_URL` as a fixed HTTPS endpoint and `CEREMONY_CONTINUATION_TOKEN` as a server-only token of at least 32 characters. The endpoint receives only `{runId, deliveryId}`, plus the stable `Idempotency-Key`. It must deduplicate its own effect and acknowledge `{deliveryId, completed: true}` only after completion. A lost acknowledgment causes redelivery of the same ID, not a new logical task. Embedded hosts can supply a trusted runtime continuation handler instead of HTTP.

`GET /api/internal/continuations` is the mounted durable-work dispatcher. It requires a dedicated `CRON_SECRET` bearer token of at least 32 characters, not an end-user session. It drains pending agent wake events and registered host continuations from PostgreSQL. Agent wake acknowledgment occurs only when the actual Workflow hook accepts the safe wake; unavailable hooks remain pending. Rehydrated authority is checked again, and revoked/wrong-principal work cannot resume.

Configure an authorized scheduler on a supported deployment plan to invoke this endpoint. For Vercel, an operator-approved cron configuration can use `{"crons":[{"path":"/api/internal/continuations","schedule":"* * * * *"}]}` with the matching protected `CRON_SECRET`. No cron plan, paid service or deployment is enabled by this repository change. The schedule must be enabled and tested in the authorized deployment before claiming closed-tab/crash recovery is certified there. Local tests exercise the real dispatcher, PostgreSQL and a deduplicating HTTP consumer independently of a browser tab.

## Storage and recovery

See [persistence migration](persistence-migration.md) for the exact async transaction API, encryption/key rotation, backup rules, private collection lifetime and worker generations. Commit admission before issuing an external effect. Never put network requests or human/model waits inside database transactions. The legacy synchronous SQLite API is retained for compatibility; it is not the production hosted authority store.

Rotate keys using a keyring containing both old and new keys until all record pages and retained backups have migrated. The hosted reference currently accepts one configured key; hosts performing online rotation must construct `PostgresCeremonyStore` with the multi-key keyring during migration and then switch the active deployment. Do not discard the old key merely because new writes decrypt successfully.

After a one-use GitHub manifest conversion with a lost response, the run is uncertain. Do not retry registration. Recover the existing app through the private collector and signed app verification. Cancelling locally does not revoke the upstream app or installation. A continuation consumer must deduplicate its stable delivery identity and reconcile acknowledgments lost after an external effect.

Store only bounded status/counter/correlation metrics. Do not attach request bodies, raw database errors, model prompts, credential pages, browser profiles, HARs or authentication screenshots to incident reports. PostgreSQL idle-client failures expose degraded health and safe errors; inspect database infrastructure separately without logging connection credentials.

## Reproducible evidence

`npm run verify` is the deterministic gate. Focused entry points include `test:integration`, `test:security`, `test:agent`, `test:workflow` and `test:e2e`. The release gate is additional, not a replacement for executing those tests.

`npm run verify:live` and `npm run verify:release` consume an explicit non-secret profile and sanitized executed results. `CEREMONY_RELEASE_PROFILE` selects the profile JSON; `CEREMONY_VERIFICATION_RESULTS` points to a JSON array validated by `verificationExecutionSchema`. If the active directory lacks Git metadata, `CEREMONY_EVIDENCE_CHECKOUT` must point to the exact delivery checkout. Release/live reject dirty tracked checkouts. Each referenced artifact must exist inside that checkout. Do not reuse a passing file from another commit/configuration or hide earlier failed attempts.

The checked-in profile is deliberately unconfigured and cannot certify a deployment. Copy it to an operator-controlled file and specify the actual public configuration. Missing local acceptance evidence is `FAIL`, not an external blocker. Missing attended/provider/device evidence is `BLOCKED_EXTERNAL`. Capabilities are excluded only by explicit disabled profile fields. There is no manual success override.

For an explicitly authorized read-only GitHub smoke, set `CEREMONY_LIVE_AUTHORIZED=true`, `CEREMONY_LIVE_GITHUB_APP_ID` and `CEREMONY_LIVE_GITHUB_PRIVATE_KEY`. The script performs only a signed app GET, creates no app or grant, and never prints provider bodies or credentials. That smoke alone does not satisfy full GitHub registration/installation certification. Missing credentials return nonzero. Real account, deployed Workflow and installed-PWA evidence must be collected in their actual authorized environments.

The release verdict comes from [the evidence directory](implementation-evidence/ceremony-teaching/README.md), not this document. No production deployment or real-provider certification is implied by an implementation or a successful local build.
