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

_Filled in below once each change is verified._

## Remaining roadmap

Ordered by leverage toward the stated goal:

1. **A replayable recorded-ceremony artifact.** Extend `CeremonyPlan` with value-free step actions (URL pattern, element role/fingerprint, success check). Emit them from the login driver while it runs, then replay without a model and fall back to the interpreter only on drift. This is what "the AI records a new ceremony" should mean for providers without an API.
2. **A data-driven provider catalog** with a Nango `providers.yaml` importer feeding a generic `catalog-http` adapter. This depends on decision 1 above.
3. **Per-node run context** so a single run can span providers, with each leaf authorized against its own connector context (for example, create an OAuth app at provider A, then use its client at provider B).
4. **Mount connectors, webhooks and the connector MCP tools in the hosted runtime**, and map tenant from an OIDC claim.
5. **Converge the two browser subsystems** on the login driver. Add session reuse, a durable cross-process human handoff, and a generic live-view handoff that is not GitHub-specific.
6. **Human handoff as an agent tool.** Return a person-bound URL or use MCP URL elicitation instead of ending at `awaiting-human`. Add `connector_verify` and a revocation _request_ that queues human approval.
7. **Wire Arazzo end to end**, or narrow its specification claims.
