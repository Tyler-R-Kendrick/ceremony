# Workflow studio

Open [Workflow studio](http://127.0.0.1:4173/?section=studio) with the local app running.

Studio is an **agent chat**. Talk to the authoring agent on the page; it registers `ceremony_author_*` WebMCP tools. There is no Create connector form, file picker, or field for connector name/ID/OpenAPI. Connect runs existing connectors; Environment manages private session configuration.

## Create a connector

There is no studio form for this. The human names a provider to the assistant. The agent:

1. Disambiguates the name and auto-corrects high-confidence misspellings. Ambiguous names elicit a public confirmation.
2. Crawls well-known auth documents (OAuth/OIDC metadata, `auth.md`, OpenAPI) and may search only if those are unpublished.
3. Drafts generic family templates. Credentials are never tool arguments.
4. Elicits a person only for provider consent (A2H) or private credentials (collector).

The conversation drafts the connector from discovered OAuth/OIDC/password/token metadata for any named provider. Catalog names are crawl seeds, not hardcoded runtimes. File pickers are not part of kickoff.

## Runtime authentication handoff

Choose an account name or email before running account registration. Generic providers accept email identifiers; GitHub still requires its public handle. Sign-in preserves the full email address. Registration using a selected email keeps that address and delegates its verification code to the human rather than substituting an agent inbox. Without a selected email, automated registration requires the configured agent inbox. Stored credentials are reused only when they match the selected account.

Native authorization selected by email requires a matching provider `email` claim with `email_verified: true`; an unverified, missing, or different address cannot finish the ceremony. Later access verification rechecks that claim. The email proof remains private server state, not part of the public connection identity.

The server stages generated registration credentials in an encrypted, owner/session/run/node-bound journal before provider submission. A journal write failure stops signup. Losing the isolated browser does not publish the credentials as a verified account or automatically submit registration again: the human handoff offers **Try sign-in with saved credentials**. That explicit action reuses the private credentials for sign-in, including the selected email, and preserves the journal if the outcome remains uncertain. Confirmed browser login promotes the credentials and clears the journal; deleting the run's authored session also clears it. Existing verified credentials are not overwritten merely by staging an attempt. Low-level custom browser vaults must implement the optional `stage` hook for this durability guarantee.

Account-only completion is labeled **account setup complete**, not verified access. A separate authorization ceremony verifies resource access.

After account registration or sign-in is verified, **Get saved account credentials** opens a private page. **Show saved account credentials** explicitly reveals the matching saved account to its owner; ordinary connection responses, chat, and agent tools never include the password. Each request requires the original authenticated human session, executor capability, current host authorization for `<provider>.claim-account`, matching account selection, and verified account/authorization progress. A final transactional check rejects a run changed during authorization. Unverified registration journals cannot be claimed. The native HTML form requires a same-origin POST, works without JavaScript, and returns credentials with `no-store`, `no-referrer`, and a restrictive CSP. Claiming does not repeat registration or establish resource access.

Discovered OAuth capabilities stay bound to one issuer. Resource metadata can delegate to an issuer with a path; OAuth metadata and OIDC fallback use their respective well-known locations. A token or userinfo endpoint alone does not establish password-grant or API-key support. Isolated-browser credential entry requires an exact allowed origin (scheme, host and port), including the discovered authorization endpoint; matching domain suffixes do not grant access.

The isolated Chromium executor checks each top-level navigation at the network boundary, including redirect hops and credential-preserving POST redirects. A disallowed destination closes the isolated session before pending model or inbox input can reach it. Service workers are disabled so they cannot bypass interception; ordinary provider assets and CAPTCHA subframes remain available. The driver currently owns one page: popup creation is detected even before a network request, including script-opened blank windows. A popup closes the isolated session and selects runtime-discovered native handoff without resubmitting the original form; a separate network guard blocks its first request. Failure to establish this boundary stops execution. This server-side Chromium requirement does not restrict the human's browser for native OAuth/device handoff.

Browser execution never invents dates of birth or checks personal declarations. Provider-declared required fields that remain invalid after known credentials are filled pause the same session for private human input. The model can also explicitly request `required-input` for unavailable facts. The human page focuses missing fields, accepts native date/text input and keyboard confirmation, and resumes without restarting registration. This is a generic DOM constraint fallback, not a guarantee that every custom provider widget declares its requirements correctly.

Auth sessions do not request local video recording. Browserbase sessions explicitly disable recording, logging and automatic CAPTCHA solving. Private human input and known credential/code values stay in the browser session's redaction set; model snapshots redact reflected values before shortening labels and omit URL paths and queries. Progress events use public status messages instead of copying provider errors. These checks cover known values, not arbitrary secret material a provider might embed in unrelated page text.

Account and authorization steps share a runtime fallback. An explicit WebAuthn request or visible passkey/security-key prompt pauses the isolated browser. **Continue in your browser** refreshes the provider's published metadata and offers a supported OAuth authorization-code or device-authorization flow. It does not forward a passkey, copy cookies, or claim that local sign-in authenticated the remote browser.

Discovery retains issuer, token, userinfo, registration, PKCE, PAR and device endpoints. The native code flow requires S256 and a usable client/redirect registration; the native account handoff requires a provider identity endpoint. Metadata-document client IDs are used only when advertised. Missing capabilities or client registration remain explicit prerequisites rather than invented authorization URLs. A returned account must match the requested account before the original step can complete.

DPoP-bound grants keep their signing key in the encrypted server session. UserInfo and later identity checks send a proof bound to that key, request URL, HTTP method and access token, as required by [RFC 9449](https://www.rfc-editor.org/rfc/rfc9449.html#section-7). Resource-server nonce challenges receive bounded retries; they never replay the authorization code. A DPoP grant missing its key fails closed instead of being sent as Bearer. Public connection output contains only the verified identity.

Transient discovery GET failures receive at most one bounded retry; long `Retry-After` delays defer to a later retry. Device polling enforces its interval server-side, increases it on `slow_down` or temporary failures, and stops on denial/expiry. Client registration and single-use code exchange are not automatically replayed after uncertain outcomes. Required PAR never downgrades to a plain authorization request. Discovery documents supply capabilities, not executable retry policy.

Focused evidence: `tests/auth-runtime-discovery.test.ts`, `tests/browser-executor.test.ts`, `tests/browser/teaching-account.spec.ts`, and `tests/browser/teaching-native-auth.spec.ts`. The account UI fixture checks selected-email submission through the real ceremony HTTP boundary and human-verification card in all three engines. The native browser fixture follows real local discovery, client registration, PKCE, consent, token exchange and userinfo with JavaScript enabled and disabled. This is not live-provider or physical-authenticator certification.

## Presentation

The existing `PresentationStudio` example component supports editing, importing, exporting and optional model generation, but is not connected to the current chat-only Studio. Its OpenUI preview uses a supplied connector and synthetic state, not another service's session. **Save presentation to project** invokes the embedding host's template callback; persistence belongs to that host. Browser tests mount the component in an isolated harness and verify preview states, malformed imports, mobile layout, saved-template reuse, and isolation from Connect. They do not establish a Studio presentation-entry workflow.

Generation accepts a bounded authored connector name rather than requiring a built-in connector ID. Existing API callers using `connectorId` remain supported. Model credentials stay server-side. Free-form author instructions and names are user-provided text; never enter secrets there.

## Portable contract

The version-1 project envelope carries a formal manifest, optional reviewed templates, and named Arazzo documents. It is an authoring container, not another workflow language. Core exports `connectorProjectSchema`, `connectorProjectDraftSchema`, `parseConnectorProject`, `parseConnectorDraft`, and `exportConnectorFiles`. Completed projects require a formal manifest, 1–12 named Arazzo 1.0.1 documents, and optional templates. Manifest methods must point at a real document/workflow/version. Drafts may omit names, verifiers and operations so research can continue; they cannot be treated as completed exports. The envelope cannot carry publication, installation, grant, credential, cookie, control-URL or environment-secret fields. Workflow steps name trusted host operations; they cannot carry `x-` extensions, `operationPath`, `workflowId` chaining, success-criteria expressions, `dependsOn`, or output/step parameters. Human participation is always A2H authorization that resumes at verification. Importing a file does not register a connector, grant access, or copy credentials.

`npm pack` includes `dist/core/connector-authoring.d.ts`. See [Arazzo and A2H profiles](specifications/protocol-profiles.md) and [connector contracts](specifications/connector-manifest.md).

## Compatibility and verification

The old Studio-as-GitHub-session screen, **Create connector** form, and **Use on Connect page** behavior were intentionally removed. Existing embedded `TeachingConnection` APIs remain available; the example's teaching controls now live on Connect. Authoring tools are registered for the browser agent.

`tests/connector-authoring.test.ts` covers draft/completed boundaries, unsafe imports, references, limits, conservative auth-family defaults and execution through the existing Arazzo runner. `tests/authoring-tools.test.ts` covers agent draft/discover/compose without a studio form. `tests/browser/workflow-studio.spec.ts` covers the absence of kickoff forms, review/export of imported drafts, and desktop/mobile accessibility in Chromium, Firefox and WebKit.

These are local implementation checks, not live-provider certification. This change does not provision resources, publish connectors or execute a new real-provider flow.
