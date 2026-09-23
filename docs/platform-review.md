# Platform review: record, chain, execute

Reviewed 2026-09-23 against `main` at `362d6c8`. This review asks one question: is the repository delivering an **open connector broker** in which an AI can **record** a new auth ceremony, **chain** ceremonies together, and **execute** authentication on behalf of a person, both server-side and through browser use? It also asks whether anything in the code or documentation limits that ambition relative to Nango.

It is a point-in-time review, not a support statement. [Service support](service-examples.md), the [support matrix](specifications/connector-support-matrix.md) and [live authentication](live-auth.md) remain the authoritative support boundaries.

## Summary

The foundations are stronger than Nango's in several places, including custody and evidence semantics, attended browser ceremonies, Arazzo and A2H, and importers for rival dialects. The weakness is **integration**. Many of the platform-grade parts are finished but not wired into any host, and the AI-facing surface exposes a small fraction of what exists.

| Capability                                   | Verdict at review time | Why                                                                                                                                                                                                                                                       |
| -------------------------------------------- | ---------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| AI records a new ceremony                    | **No**                 | Demonstrations only rearrange operations already registered in TypeScript. Recording, drafting and composition were HTTP/React-only. MCP exposed five run-control tools.                                                                                  |
| AI authors a connector for an unseen service | Partial                | `author_from_provider` crawls OAuth/OIDC metadata into one of the fixed `flowKinds`. It was offered only as in-page WebMCP. Authored API-key, Basic and form connectors could never complete.                                                             |
| Chain ceremonies within one provider         | **Yes**                | A typed DAG with bindings, pinned child recipes and contract-matched auto-composition (`recipe-contracts.ts`, `recipes/index.ts`, `commands.ts`).                                                                                                         |
| Chain across providers / reusable steps      | **No**                 | `createRun` rejected any node from another provider except one GitHub special case. Inbox and TOTP were buried inside single operations. The authoring `compose` emitted an operation that did not exist.                                                 |
| Execute remotely (managed OAuth → proxy)     | Partial                | A full RFC OAuth engine (`connectors/auth/*`) had no production caller. The generic OpenAPI adapter claimed `authorize` but threw `authorize-unsupported`. There was no refresh-on-expiry and no client-credentials grant.                                |
| Execute through browser use                  | Partial                | The executor for authored connectors works locally with Browserbase/Cloudflare, but remote browsers needed an egress proxy no host configured. The login service and its `browser_*` tools were never constructed by any host. No TOTP generator existed. |
| Nango-style provider catalog as data         | **No**                 | Providers are hand-written adapters. The manifest specification forbids declared endpoints, and there is no `providers.yaml` importer.                                                                                                                    |

## Findings by capability

### Recording

- `compileDemonstration` drops any event whose operation is not registered (`unsupported-operation`). A demonstration therefore cannot capture a service the code has never seen. This is deliberate ("no generated JavaScript, arbitrary HTTP endpoint…"), so recording is _composition of known steps_, not capture of new procedure.
- `discoverCeremony` and `CeremonyPlan` (`ceremony-discovery.ts`, `core/ceremony-plan.ts`) describe what a login requires, but nothing executes a plan. They are the natural home for a replayable, value-free recorded artifact.
- `recipeFromProject` ignored an authored project's workflows and always produced one of two fixed recipes.
- Installed authored connectors were keyed tenant-wide but read per-author, so a second author's install silently replaced the first author's.

### Chaining

- The per-run provider/profile rule is a real security property: it stops a recipe from smuggling one provider's operation into another's authorization context. The gap was the lack of an explicit, registration-controlled notion of a _provider-neutral_ step (inbox, TOTP, human confirmation) that may join any run.
- `registrationFirst` prepended `authored.register-account` to every connector's recipe when an account was requested. For non-GitHub, non-authored connectors, `createRun` then refused the run.
- Arazzo compilation (`formats/arazzo/compile.ts`) is used only by tests, and compiled `successCriteria`/`retry` have no runtime representation. Either wire it or narrow what [Arazzo profiles](specifications/arazzo-profiles.md) claims.

### Remote execution

- `ConnectorCommandService.invoke` is the right proxy primitive. It runs bound operations, injects the secret inside `credentials.use`, and refuses output that echoes the secret. It was unreachable for any imported OpenAPI connector because no credential could be obtained.
- Credentials past expiry threw rather than refreshed. Only individual adapters (Supabase management, Pipedream, Vercel) refreshed.
- The remote MCP adapter was constructed without its OAuth hook, so OAuth-protected MCP servers failed with `mcp.oauth.hook-missing`.
- `./server/connectors` did not export the OAuth grants, webhook receiver or format readers, and `createConnectorRuntime` dropped the `importers` option.

### Browser use

- There are two browser subsystems. The _login service_ (`browser-login-service.ts`, `browser-driver.ts`) handles popups, frames and attached browsers but was constructed only in tests. The _authorization executor_ (`browser-executor.ts`) runs authored connectors and handles the inbox, but blocks popups. Converging on one driver is recommended.
- The `totp-code` role existed with no RFC 6238 generator, so a stored seed could not complete MFA unattended.
- There was no generic CDP endpoint (Steel, self-hosted browserless). Only Browserbase and Cloudflare had hardcoded endpoints.
- Retained sessions are not reused. `saveState()` and the encrypted browser-state store have no callers.

### Agent surface

The MCP endpoint offered `ceremony_connect/_snapshot/_advance/_cancel/_connectors`. The following were unreachable over MCP: authoring, demonstrations, recipe composition and execution, browser login (never wired), connection use (`connector_invoke`, never wired on hosted), human handoff links, verification and revocation. `ceremony_connectors` listed only statically registered connectors, not authored installs. A registration bug hid `connector_status` and the binding-based `connector_connect` whenever only connector intents were configured.

## Self-imposed limits worth revisiting

These are documented decisions, not bugs. Each one narrows the platform goal and deserves an explicit product decision:

1. **The endpoint ban in the [connector manifest](specifications/connector-manifest.md).** "Endpoint URLs MUST NOT be embedded… an imported inventory cannot enable a live method" rules out a Nango-style data catalog. A safer alternative is _declared endpoints, approved at binding review_: the same review gate that already governs bindings.
2. **No new step types without a rebuild.** `OperationRegistry` is host-code-only by design. A signed, host-loaded operation pack (manifest plus sandboxed handler) would let third parties add steps without forking.
3. **Hardcoded `support: "fixture"` labels** on the generic OpenAPI adapter and on authored connectors are then mapped to non-live manifests. Support should derive from configuration and evidence, not from the adapter family.
4. **Single-tenant hosted runtime.** It pins `CEREMONY_TENANT_ID` and requires `CEREMONY_GITHUB_ACCOUNT`, and provider-name ternaries remain in `hosted/runtime.ts` and `github-runtime.ts`.
5. **Hosted does not mount the connector runtime.** The Nitro route and hosted MCP omit `connectors`, and the webhook receiver is never passed.
6. **Private package, TypeScript-only SDK.** Generating an OpenAPI document for `/api/v1/connectors` would allow other-language SDKs even before publication.
7. **Model access.** The server agent speaks only OpenAI-compatible chat completions or the Vercel AI Gateway, has one tool (`advance`), and stops at every human wait rather than producing a handoff.

## Changes made with this review

Every change below carries its own tests, and none is a live-provider certification. Evidence is local: protocol fixtures, the self-hosted [auth scenario doubles](auth-scenario-doubles.md), and real Chromium.

| Capability                               | Now                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| ---------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| AI records a new ceremony                | **Yes.** `browser_record_login` drives a login on a service the code has never seen and compiles a value-free [recorded ceremony](recorded-ceremonies.md): page matches, element fingerprints and roles, never values. A person reviews and publishes it, and `browser_login` then replays it with zero model calls. On drift it stops with a precise reason; a repair is saved only as a new draft.                                                                                                                                                                                                  |
| AI authors and composes over MCP         | **Yes.** Authoring, demonstrations, draft compile/import/edit, recipe preview/compose/execute and Arazzo import are MCP tools gated by role (`mcp-teaching.ts`). Review, publish and retire stay human-only. Authoring `compose` now produces a runnable recipe.                                                                                                                                                                                                                                                                                                                                      |
| Chain across providers / reusable steps  | **Yes.** A recipe invocation can name a `connector`, and each step is admitted and authorized in its own connector context. Values cross providers only through vocabulary declared `crossProvider`, such as `common.oauth-client`. Provider-neutral steps (`registerNeutral`), including inbox provisioning and verification, join any run. Arazzo success criteria and bounded retries are enforced at run time.                                                                                                                                                                                    |
| Execute remotely (managed OAuth → proxy) | **Yes, for imported and catalog connectors.** The generic OAuth engine backs the OpenAPI, catalog and remote-MCP adapters: authorization code with PKCE, OIDC, device, client credentials, and key/Basic/bearer through private input. Refresh on expiry or 401 is single-flight, RFC 7009 revocation is opt-in, and dynamic client registrations are durable. Agents call through `connector_invoke`, with secrets injected inside custody.                                                                                                                                                          |
| Execute through browser use              | **Yes.** An RFC 6238 TOTP code is generated from a held seed, and both seed and code are redacted. Any CDP endpoint can serve as a remote browser, behind the same egress-proxy rule. `browser_*` tools are wired in the reference host, and a verified session can be reused (opt-in). The model-free interpreter now finishes every registration scenario in the catalog, including recovering from a taken address.                                                                                                                                                                                |
| Nango-style provider catalog as data     | **Yes.** A [provider catalog](provider-catalog.md) schema plus a Nango `providers.yaml` importer feed one `catalog-http` adapter. The manifest's endpoint ban is replaced by _declared endpoints, approved at binding review_.                                                                                                                                                                                                                                                                                                                                                                        |
| Hosted platform                          | **Yes.** The tenant comes from an OIDC claim and roles from a claims mapping. The connector runtime, connector MCP tools and signed webhooks are mounted. A provider registry replaces the provider-name ternaries, and GitHub is optional.                                                                                                                                                                                                                                                                                                                                                           |
| Server agent                             | **Yes.** A native Anthropic provider is added. The agent gets `snapshot` and `request_human` tools, a structured handoff at human waits, and distinct `denied`, `invalid`, `conflict` and `transient` error codes. Agents can call `connector_verify` and `connector_revoke_request`; the latter only queues a request a person must approve.                                                                                                                                                                                                                                                         |
| MCP surface                              | **No dead ends found in the review's scope.** Remote MCP connectors renew their token on `verify` and on a resumed elicitation, not only on `invoke`; a refused refresh becomes `reconnect-required`. Run tools, connector intents and the inline agent start return the person-facing hand-off link. Authors can propose how an authored connector's credentials are verified, over HTTP or MCP; only a person's approval of that exact digest activates it. Every MCP tool is throttled per tenant, subject and tool (in-process token bucket, structured `rate-limited` with `retryAfterSeconds`). |
| OAuth engine coverage                    | **Wider, on fixture evidence.** Hosted tenancy reads nested or URL-named claims through JSON Pointer (`/realm_access/roles`). Authorization-code catalog entries send reviewed static `token_params`, reserved names refused before the code is spent, so Nango providers that use them import as executable. Catalog `openid` works when the entry names its issuer: discovery must agree with the entry, the ID token is verified (nonce, `iat`, signature), and only the subject leaves the engine. Per-profile issuer policies are set through the reviewed approval (`approvals.oauthProfiles`). |
| Support labels                           | **From evidence.** Labels (`unverified < fixture < local < live < certified`) are computed from dated evidence entries by one rule table (`supportLabelRules`), with staleness windows; the adapter family no longer decides them. The OpenAPI and catalog paths read `local`, citing their local suites; nothing reads `live` without a recorded live run. Labels appear in `connector_catalog` and `connector_status`, and an opt-in `support.minimumForProduction` gates production bindings at approve, connect and invoke.                                                                       |
| Connector API for other languages        | **Described; not published.** [`docs/openapi/connectors.openapi.json`](openapi/connectors.openapi.json) is an OpenAPI 3.1 description of `/api/v1/connectors`, generated from the handler's own schemas. `openapi:check` fails when it is stale, and a contract test drives every operation through the real handler against it. The package tarball ships only built output, stylesheets and reader docs, and `test:package` imports every export from an isolated consumer. See [SDKs and the package](sdk.md).                                                                                     |

Bugs found and fixed along the way, each with a regression test:

- One author's install could overwrite another's.
- Connector intents were hidden when only `connectorIntents` was configured.
- Requesting an account on a non-GitHub connector produced a run that was always denied.
- Composed projects failed with duplicate method IDs.
- OAuth handoffs were completed twice.
- The device-flow `slow_down` interval was lost between polls.
- The durable journal refused a repeated read whose result changed. The same bug affected device polling and two provider adapters.
- Webhook deliveries to `/events/<authority>/<subscription>` were rejected with 403.
- Strict authoring results refused discovery reports that carried extra fields.
- The browser client parsed the definition list as full definitions, so listing definitions always failed.
- The support-matrix script dropped two evidence ledgers, which showed three adapters as `not-recorded` and hid 13 unpinned source citations.
- A pre-joined scope string containing `openid` got no nonce, and an ID token issued in the future was accepted.
- Remote MCP connectors never renewed an expired token on `verify`, so `connector_verify`, reconnect and polling failed where `invoke` would have succeeded.

The decisions in _Self-imposed limits_ were resolved as follows:

- **Resolved:**
  - 1: declared endpoints are now approved at binding review.
  - 4 and 5: the hosted runtime is multi-tenant and mounts the connector runtime.
  - 7: model access (native Anthropic provider and the new agent tools).
  - 3: support labels are derived from dated evidence.
- **Still open:**
  - 2: operation packs.
  - 6: package publication and other-language SDKs. The OpenAPI description and a packable package are in place; publishing to a registry and generated clients are not.

Demonstration videos of these flows, led by account registration, are added in a follow-up change.

## Remaining roadmap

Items 1 and 3 to 7 of the original roadmap are delivered above; item 2 (the catalog) is delivered, and its decision is taken. What remains, by leverage:

1. **Operation packs.** Let third parties add new step types without a rebuild: a signed, host-loaded manifest plus a sandboxed handler.
2. **Backfill evidence** for the remaining adapters: 26 still read `fixture` because their old ledger level does not say what kind of target they ran against, and authored connectors have no ledger yet.
3. **Converge the two browser subsystems** on the login driver: popups in the authorization executor, a durable cross-process human handoff, and a generic live-view handoff.
4. **Automatic composition across providers.** `compose` and demonstration compilation still produce single-connector recipes; an author names connectors in the draft.
5. **Publish the package.** The OpenAPI description of `/api/v1/connectors` and a consumer-tested tarball exist; publishing (the package stays `private`) and generated clients in other languages, exercised in CI, remain.
6. **Live, attended certification** of the registration, stitched and catalog flows against real providers. Everything above is local evidence.
