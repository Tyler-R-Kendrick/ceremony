# Setting up a connector provider

This page is for the person who has to make a connector work in a real deployment: what to register with the provider, where the redirect goes, which permissions to ask for, how a webhook is verified, where each secret lives, how to keep environments apart, and what to do when something breaks or someone disconnects.

Two things it will never tell you. It will never show you a real secret, not even a fake one shaped like one — the only values here are the _names_ of configuration entries and the key _prefixes_ providers document. And it will never suggest working around a provider's approval, review, plan or verification requirement. If a provider requires a reviewed app, a paid plan or a manual approval before an endpoint works, the answer is to complete that process, and the adapter will report the refusal honestly until you do.

Which configuration each adapter requires is generated from the adapters themselves in the [connector support matrix](specifications/connector-support-matrix.md). Read that first: it is the only list that cannot disagree with the code.

## Before anything: what a connection actually binds

A connection key is not "a user and a service". It accounts for the host tenant, the owner kind, the owner identity, the authority instance and environment, the upstream account, the client registration and issuer, the authentication profile, the target resource or project, the runtime binding revision and the policy and configuration revisions. Change any of those and you have a different connection.

That is why several setup mistakes that look cosmetic are not: pointing staging and production at the same provider app, reusing one API key across environments, or treating an organization tag as an organization grant all collapse things the runtime keeps apart.

## Redirect origins

Every provider redirect comes back to one path on your deployment:

```text
https://<your deployment origin>/api/v1/connectors/callback
```

`CONNECTOR_CALLBACK_PATH` is a constant and the return URL is built from the deployment's configured origin. It is **never** built from a request, a parameter, a callback prop or a tool argument. A provider app that is registered with a different redirect URI will fail at the token exchange, not silently succeed: the exact redirect used in the authorization request is sent again at the token endpoint, and a mismatch is rejected.

What to register with the provider:

- **One exact absolute HTTPS URL per environment.** Not a wildcard, not a path prefix. If the provider allows several redirect URIs on one app, that is still one URI per environment, listed explicitly.
- **The same origin the deployment serves.** The server refuses a request whose `Host` header is not its own origin, which is what stops a tunnel from being pointed at a server that was not expecting one.
- **`http://127.0.0.1:<port>` only for local development,** and only where the provider permits loopback. Loopback HTTP is accepted by the profile contracts for fixtures and local work; a deployed origin must be HTTPS.

Popup and in-page returns have an extra rule that is easy to miss: accepting a popup completion message authorizes exactly one thing — a server verification call. It is never itself completion. The listener validates the message origin, the source window and the correlation; a window closing, a "Done" button and a `postMessage` are not success, and the flow stays pending or failed until the server verifies.

## Permissions and scopes

Ask for the smallest set that the operations you bound actually need, and record what you asked for.

Three permission sets are kept apart and none of them substitutes for another:

| Set         | Where it comes from                                                                       | What it means                                       |
| ----------- | ----------------------------------------------------------------------------------------- | --------------------------------------------------- |
| `requested` | What the authorization request asked for                                                  | Intent. Nothing more                                |
| `reported`  | What the provider said it granted (token `scope`, introspection, `authorization_details`) | The provider's statement, unverified by observation |
| `observed`  | What a verifier saw by actually calling an operation                                      | The only set that is evidence of access             |

An **empty** set means unknown or unscoped. It never means unlimited. A provider that returns no `scope` yields semantics `unknown`, never an echo of what was requested.

Provider-specific notes that change what you configure:

- **Supabase Management OAuth**: scopes are configured when the OAuth app is created, not in the authorization request. The request `scope` parameter is documented as deprecated and the adapter never sends it. Set the scopes on the app; `organizations:read` and `projects:read` are what the bound read operations need.
- **Nango**: the connect session is restricted to exactly the one integration the binding names (`allowed_integrations`). Widening that list is a binding change, not a runtime option.
- **Composio**: pin the toolkit version rather than tracking `latest` when the output is consumed programmatically, and never expose a broad connection-management meta-tool to a model.
- **Supabase hosted MCP**: the restrictions (`project_ref`, `read_only`, `features`) are binding settings, validated before the URL is built. A caller cannot supply an arbitrary URL carrying `read_only=true`, and a read-only binding cannot bind or invoke a mutating tool.

If a review raises the requested permissions, or a dynamic operation changes, policy and review are re-evaluated _before_ credentials or effects are used. A provider grant wider than the review never silently becomes the new baseline.

## Webhook verification

**Every inbound delivery is verified on the original request bytes, before any parse.** A re-serialized equivalent JSON value no longer verifies, and that is deliberate — verifying a re-encoded body verifies nothing.

Configure the right secret, and know that it is usually not the API key:

- **Standard Webhooks (`v1`, symmetric)**: the signed content is `${msg_id}.${timestamp}.${payload}` and the signature is base64 HMAC-SHA256. Secrets are base64 with a `whsec_` prefix. Several signatures may be space-delimited so a key can be rotated without downtime; any configured key verifies and the accepted key id is reported. Timestamp tolerance defaults to 300 seconds and is bounded to 1–86400 in both directions: a host cannot configure the window away. The asymmetric `v1a` (ed25519) scheme is recognized and reported `unsupported-scheme` rather than ignored.
- **Nango**: the header is `X-Nango-Hmac-Sha256`, an HMAC-SHA256 over the raw body keyed with the **environment webhook signing key**, which is a _different secret_ from the Environment API key. Configure `NANGO_WEBHOOK_SIGNING_KEY`; the API key is never used as a fallback. The legacy plain-digest `X-Nango-Signature` header is documented by the vendor as not to be used, and the receiver **ignores it even when it is correct**.
- **Pipedream trigger deliveries**: `x-pd-signature: t=<unix seconds>,v1=<hex digest>` over `${timestamp}.${raw body}`, compared in constant time with a maximum age. Note that Pipedream's _connection_ webhooks (the `webhook_uri` on a connect token) are documented as **not signed**; treat them as a hint to go and read authoritative state, never as an authenticated status change.
- **A forwarding provider (Vercel Connect triggers)**: Vercel Connect verifies the provider's webhook against the connector's signing key, then forwards the verified event and signs the outbound request itself, publishing a per-connector signing key for that purpose. **The outbound header name and algorithm are not published in the documentation**, so `verifyForwardedDelivery` takes the forwarder's verifier as an injected dependency, and the verifier used in tests is explicitly a stand-in rather than a claim about Vercel's wire format. Supply the concrete verifier from the provider's own current documentation before you enable this in production.
- **Anything else**: implement `VendorVerifierPort`. There is no fallback scheme, and nothing guesses a header name or algorithm. An unregistered verifier fails closed with `401` and the audit reason `verifier-unavailable`.

Three properties hold regardless of provider. A forwarded delivery records the forwarder's hop as the thing that authenticates it; the original provider's hop is verified only when this deployment actually holds that provider's secret, and a forwarder's _assertion_ that it verified the provider is recorded with `verified: false`. A forged or missing forwarder signature is rejected even when the request asserts upstream verification. And every refusal is a fixed short JSON body that never echoes the request body or headers — reasons go to the audit hook only.

## Credential custody

Decide, per provider, which of these you are doing, because they are different interfaces with different failure modes:

| Custody                      | You configure                         | The deployment can                                       |
| ---------------------------- | ------------------------------------- | -------------------------------------------------------- |
| `host-owned`                 | A client id and secret, or an API key | Read and refresh the credential; it owns rotation        |
| `external-credential-broker` | A broker API key                      | Ask the broker for a credential when its contract allows |
| `external-execution-broker`  | A broker API key                      | Ask the broker to execute; it never sees a credential    |
| `no-credential`              | Nothing                               | Read public data without claiming an identity            |

Rules that are enforced in code, not just recommended:

1. **Secrets are supplied through the private collection path, never inline.** The configure command refuses an inline secret and answers with names only. A configuration _value_ appears in no projection — not the public catalog, not agent output, not export, not audit, not an error.
2. **Credential kinds are checked.** A Supabase secret key (`sb_secret_…`) or legacy `service_role` JWT bypasses Row Level Security entirely and must never reach a browser. Presenting one to the project Data API adapter is refused before a request is built, by kind metadata and by documented key format. Publishable keys (`sb_publishable_…`) and legacy `anon` JWTs are the browser-safe pair.
3. **Management credentials and workload credentials are separate legs.** A Vercel management token is not a workload authorization and vice versa; misuse is rejected rather than accommodated.
4. **A broker reference is not a credential.** For an external-credential-broker connection the database holds a protected reference, not a token. Reading a Nango connection can _refresh_ the upstream token as a documented side effect, so that read is treated as privileged and serialized through the custody port's single-flight refresh — it is not a pure read and is not exposed on a generic agent route.
5. **Refresh is single-flight and journaled.** Two workers refreshing the same rotating credential cannot commit a stale result over a newer one, and a lost refresh outcome becomes reconnect rather than a replayed refresh token. The OpenAPI, remote MCP (default OAuth profile) and catalog adapters renew a token once when custody finds it expired or the provider refuses it (401; for a catalog entry, 401 or 403; a remote MCP server's 403 is reported as `mcp.scope.insufficient` or `mcp.permission-denied` instead, since a renewed token carries the same grant), then retry the request once; each request sent is its own effect-journal entry, so a refused attempt is never overwritten by the retry.
6. **Dynamic client registrations are secrets too.** A client registered at an issuer through RFC 7591 (the policy lists `dynamic`) is stored insert-only in the deployment's encrypted store under its own record kind, per tenant, issuer, redirect URI and origin, and reused. A composed runtime does this by default; a host may supply its own registrations store instead. See [persistence migration](persistence-migration.md).

## Environment separation

Keep a separate provider app, a separate broker environment and separate configuration per deployment environment. Do not share one app between staging and production "because the redirect is the same" — it is not, and the blast radius of a leaked staging secret becomes production.

Concretely:

- **One provider OAuth app per environment,** each with its own exact redirect URI and its own client secret.
- **One broker environment per deployment.** Nango has explicit environments and the Environment and Account API keys are not interchangeable; configure `NANGO_ENVIRONMENT` to match. Pipedream requires an `x-pd-environment` header of `development` or `production`, accounts and credentials are isolated per environment, and `development` is limited and expects a browser session — it is not a second production.
- **Never reuse a webhook signing key across environments.** A cross-tenant secret is in the negative test matrix precisely because sharing one is tempting.
- **Private enterprise endpoints require explicit administrator-approved policy.** An approved-private origin is an exact HTTPS origin with a plain host in host configuration; a wildcard is refused, and no document or caller argument can extend the list. A document cannot grant its own exception.
- **`webhook_url_override` is default-deny.** Only an administrator-approved destination recorded in binding settings can set it, and a caller-supplied attempt is rejected by the strict intent schema.

## Incidents and reconnects

When a provider is rate-limited, unavailable or returning errors, retry and circuit policy is per connection and per authority, and status never leaks across tenants. Errors are sanitized: a provider's message is not projected, and a connection reports a coded `lastOutcome` instead.

What to do, by symptom:

| Symptom                                                            | What it means                                                     | What to do                                                                                                                 |
| ------------------------------------------------------------------ | ----------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| Connection is `degraded`                                           | Transient upstream failure; the grant is probably intact          | Wait for the circuit to close. Do not reconnect first                                                                      |
| Connection is `reconnect-required`                                 | Refresh was rejected, the token expired, or configuration changed | Run reconnect. It is a fenced, authorized intent, not a retry                                                              |
| Connection is `indeterminate`                                      | A consequential call's outcome was lost                           | Reconcile. Do **not** replay: the effect journal will answer a repeated digest from the journal rather than re-applying it |
| Reconnect returns a different account                              | The human signed in as someone else                               | It is refused without explicit account-switch intent. Confirm deliberately                                                 |
| A delayed callback arrives after a cancel or reconnect             | Stale generation                                                  | Nothing. It is fenced and cannot reactivate or overwrite the newer connection                                              |
| Consent, MFA or a provider approval is required                    | The provider wants a human                                        | The flow reports `human-required`. There is no bypass, no scraping and no fallback to a more privileged route              |
| A verification expired, or source, policy or configuration changed | The old evidence no longer covers current use                     | Affected use is revalidated or blocked. A stale "connected" badge is not authorization                                     |

Two things that are _not_ incidents: a `202` from an MCP endpoint in answer to a request is treated as "no response will arrive" by host policy, and a lost SSE stream in the current MCP revision loses the in-flight request, which must be re-issued as a new request. Neither is a provider fault.

## Disconnect is not revocation

This is the distinction most likely to be got wrong in a support conversation, so state it plainly to users.

**A local disconnect unlinks the connection in this deployment. It does not contact the provider and it does not end the upstream grant.** The connection becomes `locally-disconnected`, which the runtime will not let anything read as `upstream-revoked`.

**An upstream revocation ends the provider's grant.** It is a separate, separately authorized intent (a person choosing scope `upstream`, or an administrator's revoke), and it is only available where the provider actually publishes an operation for it. Where they do not, the adapter reports `revoke: unsupported` and names the documented alternative rather than doing something adjacent and calling it revocation:

- **Nango** documents no upstream grant-revocation endpoint. Deleting the broker connection (scope `broker`) removes Nango's record; it does not revoke the provider's grant. If another local connection references the same Nango connection, deletion is blocked until an administrator approves the shared impact.
- **Merge** documents no operation that revokes the end user's upstream grant. `delete-account` is wired as the separate `broker` scope only.
- **MCP** defines no revocation operation at all. A local disconnect is local. For a connection authorized through the remote MCP adapter's default OAuth profile, an upstream disconnect or revoke is sent to the _authorization server_ (below), not to the MCP server.
- **Supabase** has `POST /v1/oauth/revoke`, but it needs the stored refresh token. A grant issued without one reports upstream `unsupported`, and the recorded alternative is that the user revokes the app in the Supabase dashboard. For the hosted MCP profile, a dynamically registered client holds no secret for that endpoint, so the dashboard is the route.
- **An OpenAPI description** declares no revocation operation. API key, Basic and bearer values are released locally only and report upstream `unsupported`; revoke them at the provider. An OAuth grant can be revoked at its issuer (below).

**When an upstream disconnect does revoke.** For an OAuth grant held by the OpenAPI adapter or the remote MCP adapter's default profile, scope `upstream` (and an administrative revoke) presents the refresh token, then the access token, to the issuer's RFC 7009 revocation endpoint when all of these hold:

1. the issuer policy approved into the binding sets `revocation: "on-upstream-disconnect"` (the default is `disabled`, reported as upstream `not-attempted`);
2. the issuer's verified metadata, or an endpoint the policy configures, advertises a revocation endpoint (otherwise upstream `unsupported`);
3. the held tokens were issued by that issuer to that client (otherwise upstream `failed`, and nothing is sent).

It runs under the custody lock that serializes refreshes, and it is journaled before anything is sent. Upstream `applied` means the issuer answered 200 for every token presented; an issuer also answers 200 for a token it no longer knows, so it is the issuer's statement, not proof. The connection is then `upstream-revoked`; in every other case it is `locally-disconnected`, and the local credential is released either way. A local disconnect never contacts the provider, whatever the policy says.

Tell the user which one happened. "Disconnected" and "access revoked" are different sentences, and only one of them is true after a local unlink.

Two related distinctions worth the same care. Deleting a **shared** connector is an administrative action with impact on every deployment using it — an end-user flow cannot do it, and a local unlink never deletes shared configuration. And **resource deprovisioning** is out of scope everywhere in this repository: nothing here provisions or deprovisions a provider resource.

## A setup checklist

1. Read the [support matrix](specifications/connector-support-matrix.md) row for the adapter. Note its required configuration, its custody mode, and every dimension it reports `unsupported` — those are the things you will otherwise discover in production.
2. Register the provider app for **this** environment, with the exact callback URL, and complete whatever review or approval the provider requires. Do not look for a way around it.
3. Configure the named entries through the private collection path. Never paste a secret into a command body, a manifest, an issue, a log or a model conversation.
4. Configure the webhook signing secret separately from the API key if the provider uses one, and confirm which header and algorithm the provider currently documents.
5. Approve a runtime binding: exact destinations, registered operations, effect and output classification, permitted targets. A description is not a binding, and a binding is not a grant. For an imported OpenAPI description the approval compiles the operation plans from the imported bytes; name a read operation as `verifier` if credentials should be checked. For an OAuth profile, the approval carries the issuer policy (`approvals.oauth`: issuer, registration, trusted origins, `revocation`). Only a person may set it — an agent is refused, and free-form `settings` cannot carry it — and host policy must admit every origin it lets the grants contact: by default an HTTPS origin the description itself declares for that profile, or one listed in the runtime's `issuers`. The authorization and token URLs a description declares are never called on their own.
6. Connect once as a real human and read the verification claim. Check what it says it does **not** establish — the limitations list is the useful part.
7. Test a local disconnect and confirm your own UI says "disconnected here", not "revoked".
8. Before believing any of it in production, remember that every claim in this repository rests on protocol fixtures. No adapter here has live or vendor-certified evidence, because no authorized vendor credentials exist in the environment it was built in.
