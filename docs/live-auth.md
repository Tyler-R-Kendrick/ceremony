# Live authentication and private handoff

Open [Connections](http://127.0.0.1:4173/) after `npm run dev`. GitHub, Stripe and Supabase share this entry point and private session environment. There is no separate live connection screen. Tests exercise the actual SDKs with synthetic provider responses; this is not certification against credentialed live accounts, Cloudflare, an A2H gateway or an end-user MCP host.

## Stripe and Supabase execution

`serviceRegistrations(db, environment, options?)` is exported from `@ceremony/auth/server`. Spread its registrations into the same durable `CeremonyController` as GitHub. `serviceManifests` and `serviceWorkflows` are exported for host composition. The optional trusted-host `fetch` and `onStep` bindings support contract testing and secret-free workflow observations, never model-provided endpoints or code. The same React component, framework-neutral client, WebMCP actions and private collectors drive all registrations.

- **Stripe:** the official `stripe` SDK calls `balance.retrieve()` with a secret/restricted key. Restricted keys require Balance read permission. No payments, charges or accounts are created. `STRIPE_SECRET_KEY` in the shared session skips key entry; otherwise collect it inline. Invalid credentials remain an error, and Retry allows replacement of a bad configured key. The verified credential is encrypted under an owner-bound connection reference.
- **Supabase:** the official `@supabase/supabase-js` SDK calls `auth.signInWithPassword`. Missing `SUPABASE_URL` and `SUPABASE_PUBLISHABLE_KEY` (or legacy `SUPABASE_ANON_KEY`) are collected in the same form as email/password, and project settings are reused after successful verification. The current adapter accepts hosted `https://<project>.supabase.co` origins only; custom domains/self-hosting need an explicit trusted-host policy. It signs in an existing project user, not a dashboard account. Session tokens stay encrypted; the password is not retained. Automatic SDK persistence and background refresh are disabled; expired sessions require sign-in again. CAPTCHA/MFA challenge continuations are not implemented and must not be represented as successful authentication.

Both use trusted SDK operation bindings executed by the bounded Arazzo runner, with no implicit workflow retries. Supabase's OpenAPI document does not define an operation ID for `/token`, so its workflow uses Arazzo's `operationPath`. Completed connections resume for the same owner until their recorded expiry. Account/project creation and API-key issuance are not silently performed; an authorized owner obtains those on the provider's site when necessary.

Official boundaries: [Stripe balance read](https://docs.stripe.com/api/balance), [Supabase password sign-in](https://supabase.com/docs/reference/javascript/auth-signinwithpassword), [Supabase client options](https://supabase.com/docs/reference/javascript/initializing).

## GitHub execution

One fixed recipe composes three blocking prerequisites: prepare a GitHub App, authorize its installation, then verify access. Existing owner-scoped app configuration is reused. Otherwise the trusted broker posts a [GitHub App manifest](https://docs.github.com/en/apps/sharing-github-apps/registering-a-github-app-from-a-manifest) for the owner to approve. The callback converts its one-use code on the server and verifies the app with a signed JWT. Installation approval is followed by server-side app/account checks, a read-only installation token, and a repository API request. Only verified provider evidence produces a connection reference.

OAuth Apps, device clients and GitHub Apps are different configurations. This recipe does not register an OAuth App. Account login, MFA, CAPTCHA and consent remain human-owned. A crash during a one-shot conversion enters recovery; it never blindly creates another app. The owner can privately provide the existing app ID and PEM key for signed verification. Cancel/expiry fences stale callbacks but does not delete an app or revoke previously issued provider credentials.

The GitHub adapter projects ordinary `AdapterUpdate` fields and prerequisite status into the existing headless client. React renders a scoped, accessible ordered summary. External hosts can replace that renderer, use their UI library and style tokens, or use the same client directly in Vue. There is no second workflow engine or framework transpiler.

```ts
import {
  CeremonyDatabase,
  PrivateCredentialBroker,
  CeremonyController,
  GitHubAppCeremonies,
  githubAppManifest,
} from "@ceremony/auth/server";

// All arguments below come from host configuration, never tool arguments.
const db = new CeremonyDatabase(databasePath, vaultKey); // 32-byte key
const github = new GitHubAppCeremonies(db, {
  origin: publicOrigin,
  // Optional shared app: { id, slug, pem, owner: { login } }.
  // A shared app also requires expectedAccount: the authorized installation account.
});
const controller = new CeremonyController(
  [
    {
      manifest: githubAppManifest,
      recoverable: true,
      createAdapter: (context) => github.createAdapter(context),
      resume: (owner) => github.resume(owner),
    },
  ],
  new Map(),
  Date.now,
  { database: db, broker: new PrivateCredentialBroker(db) },
);
```

Derive every `owner` from authenticated host identity. Mount start/read/action/collection and fixed callback routes; `examples/server.ts` is the reference. For trusted cross-device callbacks, `github.callbackOwner` validates the one-use provider state before choosing the owner. Never let a caller choose their owner, app identity or arbitrary redirect URL.

## Storage and configuration

### Environment section

Open [Environment](http://127.0.0.1:4173/?mode=live&section=environment). Optionally import a `.env` file or save a named value. All connectors share this session environment by default. Import merges assignments and replaces matching names; Remove deletes the selected session variable. Values are masked during manual entry and are never returned by the metadata endpoint. To edit a saved value, enter its name and replacement. An empty value is allowed; removal is explicit.

The server uses Node's `.env` parser, including quoted multiline values, with no shell execution or variable expansion. Limits are 100 variables, 64 KB total, and 16 KB per value. Names must match `[A-Za-z_][A-Za-z0-9_]*`. Invalid edits and stale revisions are rejected. The file is not written to disk; parsed variables go into encrypted storage scoped by session owner. Losing the owner session loses UI access to that environment. The demo does not expose or modify `process.env`, vault keys, service origins or server credentials. Legacy connector records are merged once without deleting originals; conflicting duplicate values block migration instead of silently overwriting a secret.

GitHub consumes `GITHUB_APP_ID`, `GITHUB_APP_SLUG`, `GITHUB_APP_OWNER`, and `GITHUB_APP_PRIVATE_KEY` together when setup begins. An incomplete set blocks setup with an actionable message; no set uses guided registration. Provider signature/identity/permission checks still apply. Already configured attempts retain their pinned app; changing Environment does not silently switch an in-progress authorization. Stripe and Supabase consume the shared variables described above. Developer simulations do not consume real credentials.

External adapters use `CeremonyEnvironment.read(owner)` on the server. `describe(owner)` returns names/revision only; `update(owner, edit)` performs session-scoped encrypted edits with optimistic revisions. `/api/environment` is the canonical endpoint; legacy connector URLs alias the same session environment. `GitHubOptions.resolveApp(owner)` supplies configuration when the ceremony starts. Environment editing is private configuration, not a model tool accepting raw secrets; WebMCP ceremony actions and hooks never receive the uploaded values. Hosts must exclude this native input page from DOM capture, session recording and analytics, just like private credential collectors.

GitHub starts directly at its first unmet prerequisite. Without a session app, the provider handoff automatically posts the registration manifest. With an available app, registration is skipped. The registration callback continues directly to GitHub installation approval, followed by server-side signature, identity and repository-access verification. No intermediate local setup/review button is required; GitHub's own approval remains human-controlled.

Local CLI startup creates `.ceremony/vault.key` (0600) and encrypted `.ceremony/state.sqlite` in a protected directory. Keep this directory private. The development file server denies vault/key/database downloads. For deployment, put the key outside the database and backups, preferably in a secret manager; encryption at rest is not protection from a compromised server.

- `CEREMONY_DATABASE` and `CEREMONY_VAULT_KEY` must be supplied together; the latter is a 64-character hexadecimal encoding of a 32-byte key.
- `CEREMONY_ORIGIN` selects the exact callback origin. Remote browsers require publicly reachable HTTPS.
- The loopback reference app uses anonymous owner cookies, not a production account system. Host authentication and a recipient-to-owner mapping are required for cross-device human links.
- Only adapters marked recoverable may use durable controller storage. Existing simulation adapters are intentionally not marked recoverable.
- Run one active controller process. SQLite leases reject overlapping actions, but lease expiry is not a distributed fencing protocol. Add operational retention and connection lifecycle management before production; expired encrypted records are not automatically purged.

## Private input and MCP Apps

WebMCP `request-input` opens an isolated native collector. Credentials travel directly to the broker; `/actions` accepts the resulting one-use reference. References expire after five minutes and are bound to owner, instance and revision. There is no model-facing secret resolution tool. Encoding alone is not used as a privacy mechanism.

`registerPrivateCollector` from `@ceremony/auth/server` registers official MCP Apps resources/tools on a host-authenticated MCP server. Supply `{ brokerOrigin, appOrigin, appHtml, owner(context), requestOwner(request) }`. Both identity adapters must derive the same tenant-aware opaque owner from authenticated host sessions; never return an unsigned request owner/header. `requestOwner` returns `null` when HTTP authentication is absent. Bundle `mountPrivateCollector(root, brokerOrigin)` from `@ceremony/auth/mcp-app` into trusted `appHtml`; do not use generated HTML. Mount the returned `handleRequest` at `https://<broker>/ceremony/private-collection`.

The tool sends only a collection grant in app-only metadata. The iframe posts native values directly over HTTPS with credentials restricted to the exact trusted broker endpoint, clears the form, and calls the binding tool with the reference. The broker accepts only the configured app origin, requires the independently authenticated recipient to match the grant owner, rejects opaque/null origins, and consumes each grant once. It enables credentialed CORS only for that exact app origin. A handle alone does not authorize collection. If browser cookie policy prevents the broker session from being sent, continue in the authenticated ceremony webpage; never copy session tokens into model-visible tool arguments. Unsupported MCP hosts fail closed and direct the human back to that webpage. The library does not install or configure a third-party MCP host.

Migration: the `requestOwner` option remains optional in the TypeScript shape for source compatibility, but omitting it now disables collection. Existing integrations must add authenticated HTTP recipient resolution and permit their secure broker session in the intended app context. Missing, invalid, expired, wrong-recipient or replayed grants fail closed. This hardening does not migrate the legacy synchronous controller/broker to the async teaching runtime: legacy consume-once references still lack durable command recovery. Production teaching MCP remains disabled/uncertified until a separately tested async bridge is provided.

The SDK transport test checks a sentinel against every JSON-RPC message. This does not certify host telemetry: before enabling a host, verify that its screenshots, accessibility/DOM capture, logs, recordings and analytics cannot observe private fields. Never enable model browser capture on a private collector or provider login screen.

## Remote browser and Agent2Human

`CloudflareHumanBrowser` implements the fixed GitHub registration/installation scenario using [Browser Run human takeover](https://developers.cloudflare.com/browser-run/features/human-in-the-loop/). It automates only the trusted broker navigation, then yields provider login and approval to a human. No generic browser tools, screenshots, DOM extraction or recording are exposed to the model. Control URLs remain encrypted and resolve only through an authenticated human route. Takeover completion is not authentication proof; GitHub callbacks still verify access.

The reference CLI enables this only when `CLOUDFLARE_ACCOUNT_ID` and `CLOUDFLARE_API_TOKEN` are configured. No paid resource is activated automatically. Remote failure preserves the same ceremony's own-browser option. Active local browser sessions close on cancellation/expiry; process restart cannot reattach their CDP event listeners. Human windows expire after five minutes.

`Agent2Human` implements the signed AUTHORIZE/RESPONSE slice of [Twilio Agent2Human](https://github.com/twilio-labs/Agent2Human): gateway discovery, canonical JSON, detached Ed25519 signatures, stable pending delivery IDs, pinned response verification, principal/correlation/expiry/replay checks. Configure `ReferenceOptions.live.a2h` programmatically with gateway origin, agent/key IDs, private and pinned gateway keys, API credential and an authenticated `recipient(owner)` resolver. Contacts are never model-provided. Configure gateway response delivery to `POST /api/live/a2h/:instanceId`; this reference does not negotiate a callback subscription for you.

Approval requests verification; it never grants a connection. Denial cancels the parent. The implementation does not claim complete A2H conformance: RESULT delivery, gateway cancellation and production transport/reconciliation remain outstanding. Cross-device delivery requires a host login that restores the same principal; the anonymous-cookie example alone cannot provide that. Without a configured transport, users continue directly in their browser. Private app recovery uses the collector, not remote browser capture.

## Hooks and evidence

Browser success/failure hooks stay best-effort and secret-free. With durable storage, state transitions and action outcomes also produce encrypted outbox records. Deliver them from a trusted worker:

```ts
await db.deliverEvents(async (event) => {
  await hostEvents.publish(event); // Consumer deduplicates event.eventId.
});
```

Delivery is at least once; failure retains the record. Action events carry `action`; transition events describe state. Neither carries submitted values, provider URLs or credentials. Always re-read authorized state before acting on an event; operation success is not connection success.

Local verification covers real cryptography with fixture HTTP responses, restart, ownership, callback replay, reference misuse, durable event redelivery, MCP message secrecy, prerequisite bypass rejection and the actual browser UI. Packed React/Vue consumer tests cover external composition. Still required: an authorized real GitHub registration/install flow, Cloudflare takeover, a configured A2H gateway, and telemetry isolation in each actual MCP host. The approved design's broader multi-connector prerequisite engine is not complete.
