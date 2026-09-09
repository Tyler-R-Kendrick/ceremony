# API and protocol reference

[Project overview](../README.md) · [Embedding guide](integration.md) · [Architecture](architecture.md)

## Library interfaces

The default entry point needs only a service manifest: `<Ceremony manifest={connectorManifest} />` or `createCeremonyClient({ manifest: connectorManifest })`. The default transport uses `/api/ceremonies`; hosts can supply another transport. Automatic entry asks the server to reuse a compatible session attempt, then prefers trusted configured methods, browser OAuth, or headless device flow. GitHub App registration remains a prerequisite only when no app is available. No supported method or required grant means an error, not an invented fallback.

Use `context={{ surface: "headless", requiredScopes: ["read:user"] }}` for caller constraints. A server registration can provide `availability(owner, method)` returning `configured`, `available`, or `unavailable` from trusted session configuration; clients never send credential-availability claims. `CeremonyController.connect(owner, connectorId, context)` is the session-aware server entry. WebMCP `start({})` uses the same resolution; `start({ methodId })` remains an explicit override. `selection="manual"` retains independent/manual attempts for galleries and advanced hosts.

Routine OAuth/device preparation runs automatically and emits execution hooks. Secret entry, anonymous resource provisioning, and provider consent are not automated. Hosts can opt into `delegation="agent"` to invoke a configured `request-human` adapter (remote browser/A2H); delegation failure preserves the provider link/private collector. This uses the existing fixed browser handoff, not unrestricted autonomous browser control. Live GitHub currently exposes App installation auth only; automatic selection never invents a live OAuth adapter from the simulation inventory.

`npm run build` emits ESM and declarations. See [embedding ceremonies](integration.md) for installation, host UI libraries, styling and framework-neutral lifecycles.

| Import                           | Responsibility                                                                                                      |
| -------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| `@ceremony/auth`                 | Framework-neutral client, HTTP transport, WebMCP, hooks, schemas and template contracts                             |
| `@ceremony/auth/react`           | `Ceremony`, `CeremonyView`, `useCeremony`, OpenUI validation and rendering                                          |
| `@ceremony/auth/styles.css`      | Optional scoped styles and host-overridable theme tokens                                                            |
| `@ceremony/auth/server`          | `CeremonyController`, `AuthAdapter`, protocol reference adapter, credential-store interface                         |
| `@ceremony/auth/server/teaching` | Authenticated teaching runtime, registered recipes, async stores, private broker and hosted-handler building blocks |
| `@ceremony/auth/mcp-app`         | Trusted MCP App private-collector mount function                                                                    |

```tsx
import { Ceremony, createHttpTransport } from "@ceremony/auth/react";
import "@ceremony/auth/styles.css";

const transport = createHttpTransport("/api/ceremonies");

<Ceremony
  manifest={connectorManifest}
  transport={transport}
  templates={reviewedTemplates}
  onComplete={(outcome) => useConnection(outcome.connectionRef)}
  onCancel={() => closeConnectionDialog()}
  onActionSuccess={(event) => scheduleNextStep(event)}
  onActionFailure={(event) => handleFailedStep(event)}
/>;
```

The host supplies the manifest and reviewed templates; styling is optional and host-controlled. Keep the transport stable across renders. `resumeId` and `onInstance(id)` support callback navigation and reload using an opaque instance ID. The server additionally checks session ownership; knowing an instance ID does not grant access.

Manifests declare ordered methods and fields; they contain no endpoints or credentials. Each method references a template ID. Uncustomized methods use the bundled template for their kind. Unknown or incompatible supplied templates block rendering.

Register connectors with `new CeremonyController([{ manifest, createAdapter }])`. Each factory receives the owner, instance ID, and method and creates an isolated adapter for one ceremony attempt. Use the owner to bind vault operations to your host's tenant/user policy. Adapter methods are `begin`, `submit`, `callback`, `poll`, and `cancel`; return an `AdapterUpdate` containing the next public interaction or a verified `AuthOutcome`. Provider failures must become sanitized `CeremonyError` messages; arbitrary exception bodies never reach the UI.

The included `createProtocolAdapter` takes explicit server-only endpoints and a `CredentialStore`. It is a reference for public OAuth clients, standard device authorization, the documented auth.md anonymous/claim profile, and the local forms endpoint. Different provider form contracts, client authentication, or endpoint-origin policies belong in connector adapters. No browser session scraping is provided.

`createNeonAdapter(store, config?, now?)` implements the distinct Claimable Neon profile. Set `claimFields: []` on its anonymous method to keep identity entry on the provider page. It re-exchanges an assertion after a claim-poll 401, observes `reconciled`, and overwrites stored pre-claim secrets with only the project ID after transfer. `CredentialStore.put(secret, existingRef)` must **replace** that record, not merge secrets. A `claimed` outcome confirms ownership, not continuing API access; reconnect through the destination organization for that. The default endpoints target Neon; the example explicitly overrides them with loopback test endpoints. Interoperability is exercised locally, not certified against a live Neon account.

### WebMCP and execution hooks

The teaching-enabled GitHub surface registers four protected tools: `ceremony_github_connect`, `snapshot`, `advance`, and `cancel`. `createConnectionTools` exposes the same definitions for embedded hosts without native WebMCP. Its authenticated `/tools` routes restore recorded agent authority; changing transport does not bypass Stop assistant. Snapshot is a pure read; advance accepts only node/revision/command identity and binds inputs on the server.

Legacy `Ceremony` surfaces retain eleven tools: `start`, `read`, `begin`, `submit`, `claim`, `finish`, `retry`, `cancel`, `navigate`, `request-human`, and `request-input`, with a connector prefix. `submit` now accepts only explicitly public fields of the current step. **Agent-contract migration:** raw private fields, opaque secret references and device codes are excluded from agent arguments/results. `request-input` opens the native private collector; necessary device instructions remain in the human view. Unclassified legacy text fields are not implicitly public.

Tools and UI controls share the same dispatcher, synchronous concurrency guard, field validation, server revisions and session authorization. `navigate` uses only the current trusted provider destination: OAuth leaves the page, while device/claim approval opens a separate tab. Provider sign-in/consent remains provider-owned, not a ceremony tool. `read` can poll and persist approval, so it is deliberately not marked read-only. No tools are exposed to additional origins. Consequential annotations are browser hints, not replacements for host authorization or user consent.

Use `webmcp={false}` to disable registration, or `webmcp={{prefix: "unique_instance"}}` for multiple mounted ceremonies. Tools are removed on unmount without removing another instance's tools. Remount the component when changing connectors (`key={manifest.id}`). The library prefers `document.modelContext` and falls back to the older native `navigator.modelContext` entry point; it also accepts callers that omit execution options. Unsupported browsers retain the normal controls and show an explicit availability message; registration failures remain visible. No fake registry or polyfill is installed. This uses the experimental [Chrome imperative API](https://developer.chrome.com/docs/ai/webmcp/imperative-api), not remote MCP server authentication.

To verify registration, open **Application → WebMCP → Available tools**. Teaching-enabled GitHub exposes four tools; legacy connector surfaces expose eleven. Changing surfaces removes their owned tools. Tests exercise actual `WebMCP.toolsAdded`, `WebMCP.toolsRemoved` and `WebMCP.invokeTool` through the [DevTools protocol](https://chromedevtools.github.io/devtools-protocol/tot/WebMCP/), separately from ordinary Chromium/Firefox/WebKit operation without experimental features. Native verification uses the supported experimental Chromium build; it does not certify every Chrome release.

`onActionSuccess` and `onActionFailure` receive an execution ID, action, source (`ui`, `webmcp`, `agent`, or `system`), connector/method/instance IDs, timestamps, and resulting revision/step when available. Each dispatched operation emits exactly one terminal notification. Invalid tool arguments rejected before dispatch are not executions. Hooks and agent results exclude credentials, raw errors, provider URLs, private references and transient device verification codes. Source is an observability label, never proof of human authority.

Success means the operation executed, **not** that authentication finished: beginning OAuth succeeds at `redirect`; poll/resume succeeds at the observed state. Keep using `onComplete` for verified completion. A successful navigation hook means handoff was initiated, not that the external page loaded or consent succeeded. Poll/resume operations emit `system` events, allowing hooks to observe later approval or rejection.

Hooks may return promises; their exceptions/rejections are isolated from auth results and they are not awaited. They are best-effort in-page notifications, not durable delivery: navigation, closed tabs and server-only callbacks can outlive the page. Persist orchestration on your backend if durability is needed, deduplicate by execution ID, and re-read current state before choosing another action. Do not use hooks as an authorization gate. Framework-independent consumers can use the exported `executeCeremonyAction(context, operation, hooks)` helper around their own operations.

Aborted tool calls are rejected before dispatch and before starting a replacement method. Aborting a browser invocation does not undo provider effects. Use explicit cancellation to fence local work. Legacy controllers expose `CeremonyDatabase.deliverEvents`; the teaching runtime uses transactional events, effect identities, worker generations and a deduplicating continuation outbox. The assistant proposes registered operations, not arbitrary executable workflows.

### HTTP transport

| Request                                                                      | Purpose                                                         |
| ---------------------------------------------------------------------------- | --------------------------------------------------------------- |
| `POST /api/ceremonies` `{connectorId, methodId}`                             | Create a non-effectful initial screen                           |
| `GET /api/ceremonies/:id`                                                    | Read state; check pending approval when due                     |
| `POST /api/ceremonies/:id/collect` `{revision, values}`                      | Native private input; returns a one-use reference               |
| `POST /api/ceremonies/:id/actions` `{action, revision, values?, secretRef?}` | Execute an allowed action; secrets use references               |
| `GET /api/callback/:id`                                                      | Process the provider callback and return to the connection page |

The example uses an HttpOnly, SameSite=Lax session cookie (Secure on HTTPS), exact Origin/content-type checks on JSON writes, exact callback routing, and no-store responses. Duplicate/stale actions return 409; unknown or other-session instances return 404. Credentials go directly to `/collect`; only their reference reaches `/actions`. Live GitHub uses the same routes under `/api/live/ceremonies`. Device polling respects the provider interval and `slow_down` response.

## Template contract

A template is `{version: 1, id, kind, screens}`. Screens cover `intro`, `input`, `redirect`, `waiting`, `anonymous`, `claim`, `complete`, `error`, `cancelled`, and `expired`.

```text
root = Stack([Title("Connect your account"), Details(), Access(), Actions(), Notice()])
```

`Title`, `Text`, `Panel`, and `Stack` compose presentation. `Details`, `Access`, `Fields`, `Redirect`, `Device`, `Notice`, `Outcome`, and `Actions` bind to runtime context. The validator requires the correct complete set of bindings for each screen and rejects extra controls, executable state, arbitrary queries/mutations, unknown components, incomplete syntax, and orphaned source. Binding values are never interpolated into OpenUI text.

Template code is an authored artifact: validation constrains execution, not the truth of arbitrary author-written copy. Review copy before distributing a template. Auth status, access, destinations, field definitions, and actions always come from runtime-bound components.

## Authoring with a model

Configure these environment variables in your process environment or secret manager:

- `CEREMONY_MODEL_URL`: full OpenAI-compatible **chat completions** endpoint, such as a local model's `http://127.0.0.1:8000/v1/chat/completions`.
- `CEREMONY_MODEL`: model identifier.
- `CEREMONY_MODEL_KEY`: optional authorization key; remains on the server.
- `CEREMONY_PORT` / `CEREMONY_PROVIDER_PORT`: optional local port overrides.

Then restart `npm run dev`. The app does not automatically load `.env` files. Never enter provider/model secrets in template source or presentation instructions.

Generation sends the component contract, selected auth kind, connector display name/description, and author-entered presentation instructions. It sends no live ceremony state, credentials, claim tokens, or connection references. Generated output must pass the same validator as imported templates. Nothing is automatically published.

Use **Export template** to save a reviewed artifact. **Use on Connect page** activates it in the current app session; exported artifacts are the durable handoff. With no model configured, editing, importing, previewing, exporting, and all runtime auth flows still work.
