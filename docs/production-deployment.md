# Production deployment and release gates

The hosted reference keeps the Vite/OpenUI frontend and uses Nitro as a thin server carrier for the Workflow SDK. `nitro.config.ts` installs `workflow/nitro`; `hosted/` mounts the same teaching HTTP handlers used by the deterministic fixture. The server-only teaching export owns PostgreSQL, identity, provider operations and agent coordination. Core consumers do not import these dependencies.

Build the existing frontend with `npm run build`, then `npm run build:hosted`. `npm run dev:hosted` is a developer command, not an end-user prerequisite. The Workflow integration follows the [official Nitro integration](https://workflow-sdk.dev/docs/getting-started/nitro). Deploy only to an explicitly authorized project; these commands do not authorize provisioning, billing, accounts or grants.

## Required hosted configuration

For Vercel, the checked-in `vercel.json` selects `npm run build:vercel`, which builds the frontend **and** the Nitro Vercel preset. It verifies the emitted static app, API function and Workflow functions, and executes the built API over HTTP without credentials to prove missing configuration fails closed. `npm run verify` includes this gate. A static Vite build alone is not a deployable authentication server. Build on the deployment platform's target architecture; do not upload an ARM-native dependency bundle to a different runtime architecture.

Supply configuration through the host's protected environment, not through the browser Environment editor, recipe definitions or model tools:

| Name                             | Purpose                                                                                                |
| -------------------------------- | ------------------------------------------------------------------------------------------------------ |
| `CEREMONY_PUBLIC_ORIGIN`         | One exact HTTPS origin, with no path, query, credentials or fragment.                                  |
| `CEREMONY_DATABASE_URL`          | Configured shared PostgreSQL connection with `sslmode=verify-full`; production rejects unverified TLS. |
| `CEREMONY_VAULT_KEY`             | 32-byte encryption key encoded as 64 hexadecimal characters, stored outside the database and backups.  |
| `CEREMONY_VAULT_KEY_ID`          | Non-secret key identifier used by encrypted records.                                                   |
| `CEREMONY_OIDC_ISSUER`           | Trusted end-user identity issuer. Deployment/workload OIDC is not a substitute.                        |
| `CEREMONY_OIDC_CLIENT_ID`        | Registered hosted application client.                                                                  |
| `CEREMONY_OIDC_CLIENT_SECRET`    | Server-only client secret when required by the identity provider.                                      |
| `CEREMONY_TENANT_ID`             | Trusted deployment tenant mapping.                                                                     |
| `CEREMONY_GITHUB_ACCOUNT`        | Authorized target account for this reference deployment.                                               |
| `CEREMONY_CONFIGURATION_VERSION` | Change when authority-relevant provider/origin/permission configuration changes.                       |

The identity adapter validates the OIDC protocol response and maps signed `ceremony_roles` to explicit author, reviewer, publisher, executor and administrator capabilities. When absent, roles default to executor only. Give publication rights through the identity provider, not a browser flag. Login, logout and protected sessions use the shared store; the browser's resume hint does not authenticate the user. Production has no anonymous-owner fallback.

The native Environment section uses authenticated `/api/environment`: GET returns variable names/revision only; POST accepts bounded JSON edits or an optional dotenv string and stores values encrypted. It is shared across connectors within the authenticated session, not across unrelated sessions. `GITHUB_APP_ID`, `GITHUB_APP_SLUG`, `GITHUB_APP_OWNER` and `GITHUB_APP_PRIVATE_KEY` are consumed together by the trusted GitHub configuration resolver. Partial configuration blocks with a setup message. Changes bind a new configuration version and cannot silently replace an app during an in-progress callback.

Cross-device identity restoration does not copy a session's private Environment. A session with no GitHub configuration edits uses the host configuration version so the same authenticated principal can reuse compatible verified host access after a new login. A protected GitHub-specific revision changes only when the four GitHub app variables change or are removed; editing an unrelated connector's variables does not invalidate GitHub. Once a session has edited GitHub configuration, even clearing it advances its session-bound version. Legacy records without this metadata conservatively retain their existing revision as a baseline. Returning from another authenticated session may therefore require explicit reconfiguration; no private values travel in a resume hint.

### GitHub registration and installation returns

No pre-existing GitHub App ID or private key is required for guided registration. The manifest handshake creates the app; the server converts its one-use code, verifies the app's signed identity, then requests installation and verifies scoped API access. Public account lookup selects GitHub's personal or organization registration endpoint. A GitHub **personal account** is different: use the signup handoff to create it on GitHub, finish email verification and required challenges, then return to the same connection page. Signup never proves repository access. See [GitHub account creation](https://docs.github.com/en/account-and-profile/how-tos/account-management/creating-an-account-on-github).

New app manifests register `${CEREMONY_PUBLIC_ORIGIN}/api/v1/teaching/github/installation-return` as their **setup URL**, not an OAuth callback URL. Installation state resolves an encrypted, expiring, subject-bound routing record, followed by current run authorization and signed installation verification. A reused app returns to the current parent, not its original app-registration run. Unknown, duplicate, expired, foreign-subject and consumed state cannot grant access. Installation evidence and callback consumption commit together.

Migration: previously registered apps lacking a setup URL (or using a run-specific setup URL) need that setup URL updated in GitHub App settings by an authorized app owner. Do not create another app to repair routing. Existing per-run callback handlers remain for compatibility. [GitHub distinguishes setup and OAuth callback URLs](https://docs.github.com/en/apps/creating-github-apps/registering-a-github-app/about-the-setup-url).

Expired registration that never issued a handoff can renew safely. Once the handoff was issued, an expired attempt enters uncertainty rather than automatically creating another app. Recover an existing app through the private collector, or explicitly authorize **Start a new registration** after checking GitHub. Restart requires a current authenticated recovery ticket/revision, refuses persisted app/installation evidence, fences the old attempt and invalidates its nonce. It never deletes an upstream app or fabricates successful access.

### Jira shared app configuration

The hosted reference accepts server-only `JIRA_CLIENT_ID` and `JIRA_CLIENT_SECRET` as one shared OAuth app pair. Register the exact `${CEREMONY_PUBLIC_ORIGIN}/api/v1/teaching/jira/authorization-return` callback in that app. The runtime requests `read:jira-user`; browser input cannot change callback or permissions. Optional `JIRA_SITE_URL` fixes the HTTPS `*.atlassian.net` site origin; without it, the authenticated user selects a site and provider verification must confirm access to that exact site.

Session Environment values override the host pair only as session candidates. A partial session pair does not borrow the missing value from the shared app. Change `CEREMONY_CONFIGURATION_VERSION` when rotating the host app or its permissions so waiting runs cannot silently adopt changed authority. Session Jira edits carry their own revision; unrelated connector edits do not invalidate Jira.

The server owner-contribution path can be enabled with `CEREMONY_JIRA_SETUP_OWNER_SUBJECT`, a designated OIDC subject that must independently authenticate with `admin`. Embedded hosts supply `jira.setupOwner(requester, target)` instead. This is explicit tenant sharing policy, not a role or owner selected by a browser/model. A missing app can then be assigned through authenticated `POST /api/v1/teaching/jira/:runId/owner-setup` with the current run revision. The designated owner reads `GET /api/v1/teaching/jira/owner-setup/:assignmentId` and submits its returned revision plus private `values.clientId`/`values.clientSecret` to the same path. These are private collector routes; exclude their bodies from capture and logs. The requester retains their run and completes normal registered preparation, consent and access verification; owner contribution never completes access.

Requester and owner private pages are mounted on those same routes: the requester can request or renew setup, poll status, and continue to their own consent after setup is ready; the designated owner submits credentials through the HTML collector. Hosted A2H owner notification is enabled only when every `CEREMONY_A2H_*` value is present, including a host-configured recipient map. Delivery uses PostgreSQL-backed A2H records, never process memory. Failed or absent notification cannot revoke the assignment or replace the owner collector. Do not advertise unattended owner setup. Requests and shared app eligibility expire after 24 hours. Repeating the requester POST renews an expired pending assignment only when its owner, scope and run revision still match; concurrent retries reuse one new assignment, and the expired link stays invalid. Completed assignments are not renewed. Rotation of an existing shared app requires a new host configuration version. Shared configuration is bound to tenant, site, callback origin, environment, configuration version, designated owner and host-selected scopes. It is not reused over partial session credentials. Raw app values remain encrypted, and user tokens/consent remain session-specific. Operator retention `purge-jira-setup` deletes expired pending assignments, expired shared apps, and indexes whose assignment is gone. It does not delete audit records or unexpired live assignments. User-facing assignment recovery remains a requester renew/continue path, not automatic undelete.

Missing app configuration offers an administrator-only native private form within the same parent. It configures that session, not the whole tenant. Non-administrators cannot use it to register or replace the integration. Hosted A2H notifies a configured recipient; it does not complete owner setup or skip provider consent. Do not advertise unattended owner setup. Provider consent and a fresh site-bound current-user check are required independently of app configuration. Lost one-use-code responses remain uncertain, with explicit human recovery rather than blind exchange retry. See the [current Jira evidence and limitations](implementation-evidence/ceremony-teaching/jira-3lo.md).

### Database maintenance and recovery

The hosted keyring accepts `CEREMONY_VAULT_KEY_ID` and `CEREMONY_VAULT_KEY` for new writes plus optional `CEREMONY_VAULT_PREVIOUS_KEYS`: a protected JSON object mapping at most four previous key IDs to 64-character hex keys. Duplicate current IDs, malformed keys, and oversized keyrings fail closed. Keep these values in the operator secret store, separate from the database and backups. Never paste them into a terminal command, issue, model prompt or evidence file.

Run the repository's maintenance tool only with an explicitly configured `CEREMONY_DATABASE_URL`, keyring and `CEREMONY_MAINTENANCE_AUTHORIZED=true`. Stop application traffic and workers for backup, restore and rotation. These commands are operator tooling, not end-user ceremony steps:

```sh
npx tsx scripts/persistence-maintenance.ts backup /secure/operator/location/ceremony-backup.json
npx tsx scripts/persistence-maintenance.ts restore /secure/operator/location/ceremony-backup.json
npx tsx scripts/persistence-maintenance.ts rotate TENANT_ID
npx tsx scripts/persistence-maintenance.ts purge-collections TENANT_ID
npx tsx scripts/persistence-maintenance.ts delete-demonstration TENANT_ID DEMONSTRATION_ID
npx tsx scripts/persistence-maintenance.ts purge-jira-setup TENANT_ID
```

Backup uses an exclusive PostgreSQL snapshot of the actual encrypted record tables, not a decrypted application export. It refuses active leases, more than 10,000 records/claims, or over 16 MB of ciphertext; larger deployments need separately tested native database backup tooling. Files are created exclusively with mode 0600 and are never overwritten. Metadata includes tenant/record identifiers; treat the backup as confidential even though values are encrypted. The tool prints no records, keys or connection URLs.

Restore requires migrated but completely empty destination tables, authenticates every encrypted record with configured keys before importing, and commits records/claims atomically. Historical worker generations are advanced and expired so pre-backup claims cannot commit. Invalid keys, tampering, duplicates, nonempty destinations and oversized snapshots fail without partial restoration. Isolate the former database and workers before bringing the restored application online: fencing a restored database cannot prevent an independently running old deployment from making upstream provider requests. Reconcile uncertain external effects before continuing work.

For rotation, configure the new current key and retain previous keys, run `rotate` for every tenant, verify reads and a restore into a fresh database, then retire old keys only after all retained backups no longer require them. Rotation reads and rewrites each bounded page in one transaction and never stores keys in data or backup files. The explicit demonstration retention command refuses recording/paused demonstrations, removes the chosen demonstration's events and current pointer, and preserves published recipes and mandatory audit records. Collection purge sweeps cursor-based 100-record transactions until exhaustion. Tenant/ID selection must come from the operator's retention policy, not an untrusted browser request. No scheduler or paid infrastructure is enabled automatically.

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

Rotate keys using a keyring containing both old and new keys until all record pages and retained backups have migrated. The hosted reference accepts previous keys through `CEREMONY_VAULT_PREVIOUS_KEYS`; switch the active key while retaining the old decryption keys during migration. Do not discard the old key merely because new writes decrypt successfully.

After a one-use GitHub manifest conversion with a lost response, the run is uncertain. Do not retry registration. Recover the existing app through the private collector and signed app verification. Cancelling locally does not revoke the upstream app or installation. A continuation consumer must deduplicate its stable delivery identity and reconcile acknowledgments lost after an external effect.

Store only bounded status/counter/correlation metrics. Do not attach request bodies, raw database errors, model prompts, credential pages, browser profiles, HARs or authentication screenshots to incident reports. PostgreSQL idle-client failures expose degraded health and safe errors; inspect database infrastructure separately without logging connection credentials.

## Reproducible evidence

`npm run verify` is the deterministic gate. Focused entry points include `test:integration`, `test:security`, `test:agent`, `test:workflow` and `test:e2e`. The release gate is additional, not a replacement for executing those tests.

`npm run verify:live` and `npm run verify:release` consume an explicit non-secret profile and sanitized executed results. `CEREMONY_RELEASE_PROFILE` selects the profile JSON; `CEREMONY_VERIFICATION_RESULTS` points to a JSON array validated by `verificationExecutionSchema`. If the active directory lacks Git metadata, `CEREMONY_EVIDENCE_CHECKOUT` must point to the exact delivery checkout. Release/live reject dirty tracked checkouts. Each referenced artifact must exist inside that checkout. Do not reuse a passing file from another commit/configuration or hide earlier failed attempts.

The checked-in profile is deliberately unconfigured and cannot certify a deployment. Copy it to an operator-controlled file and specify the actual public configuration. Missing local acceptance evidence is `FAIL`, not an external blocker. Missing attended/provider/device evidence is `BLOCKED_EXTERNAL`. Capabilities are excluded only by explicit disabled profile fields. There is no manual success override.

For an explicitly authorized read-only GitHub smoke, set `CEREMONY_LIVE_AUTHORIZED=true`, `CEREMONY_LIVE_GITHUB_APP_ID` and `CEREMONY_LIVE_GITHUB_PRIVATE_KEY`. The script performs only a signed app GET, creates no app or grant, and never prints provider bodies or credentials. That smoke alone does not satisfy full GitHub registration/installation certification. Missing credentials return nonzero. Real account, deployed Workflow and installed-PWA evidence must be collected in their actual authorized environments.

`npm run test:live:attended` additionally requires `CEREMONY_LIVE_ATTENDED=true`, a configured production `CEREMONY_RELEASE_PROFILE`, a clean checkout and a graphical Chromium environment. It opens a fresh browser for the operator to sign in and complete the normal connection; it never automates provider consent or supplies credentials. It inspects only the authenticated pure run snapshot and retains boolean verification plus version/configuration metadata. No browser profile, screenshots, trace, HAR, console or provider bodies are saved. Its supplementary connection result does not certify registration freshness, recovery, hosted durability or installed-PWA behavior, and cannot independently satisfy `LIVE-01`. Missing authorization/configuration or incomplete human interaction exits nonzero rather than skipping.

The release verdict comes from [the evidence directory](implementation-evidence/ceremony-teaching/README.md), not this document. No production deployment or real-provider certification is implied by an implementation or a successful local build.
