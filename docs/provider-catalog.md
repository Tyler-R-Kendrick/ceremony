# Provider catalog

**A provider can be described as data instead of as a hand-written adapter.**
A catalog entry says where a provider's authorization and token endpoints are,
which credential it takes and where that credential goes, which API base URL
its proxy may reach, and which values a person supplies per connection (a
subdomain, an account id). One generic adapter, `catalog-http`, executes any
entry once a reviewer has approved a binding for it. Nango's
`providers.yaml` can be imported into entries directly.

Declaring an endpoint is not approving it. The normative rules are in the
[connector manifest specification](specifications/connector-manifest.md#declared-endpoints):
_declared endpoints, approved at binding review_.

## What an entry looks like

```json
{
  "catalog": "ceremony.provider-catalog/v1",
  "providers": [
    {
      "id": "tenant-desk",
      "displayName": "Tenant Desk",
      "categories": ["support"],
      "auth": {
        "mode": "oauth2-authorization-code",
        "authorizationUrl": "https://${connectionConfig.subdomain}.tenant-desk.example/oauth/authorize",
        "tokenUrl": "https://${connectionConfig.subdomain}.tenant-desk.example/oauth/token",
        "scopes": ["tickets.read"],
        "authorizationParams": { "access_type": "offline" },
        "tokenRequestAuth": "client_secret_post"
      },
      "proxy": {
        "baseUrl": "https://${connectionConfig.subdomain}.tenant-desk.example/api",
        "headers": { "accept-version": "2026-01" },
        "verification": { "method": "GET", "path": "/me" }
      },
      "connectionConfig": [
        {
          "name": "subdomain",
          "label": "Desk subdomain",
          "configuration": "TENANT_DESK_SUBDOMAIN",
          "format": "dns-label"
        }
      ]
    }
  ]
}
```

The schema is `providerCatalogEntrySchema` in
`src/server/connectors/formats/provider-catalog/schema.ts`. Auth modes are
`oauth2-authorization-code` (S256 PKCE is always sent; `pkce` records whether
the provider verifies it), `oauth2-client-credentials`, `api-key` (header or
query, with a literal prefix such as `Bearer `), `basic`, `bearer`, `none`,
and `unsupported`, which keeps a provider the runtime cannot execute as a
description with its reason.

OAuth client ids and secrets and per-connection values are never in the entry.
They are host configuration read by name: `<ID>_CLIENT_ID` and
`<ID>_CLIENT_SECRET` by default, and each `connectionConfig[].configuration`.

### What the grammar refuses

- Any scheme but `https:`. Loopback `http:` is accepted only when the host
  constructs the reader with `allowLoopbackHttp`, and contacted only when host
  policy admitted the binding's destination as a loopback fixture.
- Any template other than `${connectionConfig.<declared field>}`. A credential
  such as `${apiKey}` is never spliced into a URL or header; the auth mode
  places it.
- A template that could choose the domain. A value may fill whole leftmost
  host labels under at least two fixed labels, and must be a DNS label; it can
  pick the tenant of `tenant-desk.example`, never another domain. Path and
  parameter values must be single URL tokens.
- Userinfo, fragments, `..`, `//` or encoded slashes in a path, parameters
  the OAuth engine owns (`redirect_uri`, `state`, `scope` ...), and default
  headers the transport or auth mode owns (`authorization`, `cookie`, `host`
  ...).

## Importing Nango's providers.yaml

`importNangoProviders(text)` reads the file (bounded YAML or JSON), and the
`catalog-http` adapter's `import` accepts it through the ordinary import
route. Every provider key yields exactly one entry.

| Nango                                                     | Catalog entry                                                                                                             |
| --------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| `auth_mode: OAUTH2`                                       | `oauth2-authorization-code`                                                                                               |
| `auth_mode: OAUTH2_CC`                                    | `oauth2-client-credentials`                                                                                               |
| `auth_mode: API_KEY` with `proxy.headers` / `proxy.query` | `api-key` header or query placement; `authorization: Bearer ${apiKey}` becomes `bearer`                                   |
| `auth_mode: BASIC`, `NONE`                                | `basic`, `none`                                                                                                           |
| `OAUTH1`, `APP`, `CUSTOM`, `TBA`, `JWT`, `SIGNATURE`, ... | `unsupported`, with the reason and a blocking issue                                                                       |
| `authorization_url`, `token_url`, `refresh_url`           | the same URLs; a query string on the authorization URL becomes explicit parameters                                        |
| `authorization_params`                                    | `authorizationParams`; a redundant `response_type: code` is dropped with an issue; a reserved override is `unsupported`   |
| `token_params`                                            | client credentials: `tokenParams`. Authorization code: `unsupported` (the engine does not send extra token parameters)    |
| `default_scopes`, `scope_separator`                       | `scopes`, `scopeSeparator` (space or comma)                                                                               |
| `token_request_auth_method: basic`                        | `client_secret_basic` (otherwise `client_secret_post`)                                                                    |
| `proxy.base_url`, `proxy.headers`, `proxy.verification`   | `proxy.baseUrl`, non-credential `proxy.headers`, `proxy.verification`                                                     |
| `connection_config`, `${connectionConfig.x}`              | `connectionConfig` fields; a field used in a host is a `dns-label`; the provider's own pattern is replaced, with an issue |
| `alias`                                                   | resolved against the named provider, with an issue                                                                        |
| `docs`, `categories`, `display_name`                      | `docsUrl`, `categories`, `displayName`                                                                                    |
| scripts, `proxy.retry`, `proxy.paginate`, other keys      | not imported; each reported as an info issue                                                                              |

A provider whose description cannot be represented exactly is never guessed
at and never dropped: it is imported as `unsupported`, carrying its reason. The
test fixture `tests/connectors/provider-catalog/fixtures/providers.yaml` is a
synthetic file in Nango's shape covering each case; nothing in it is copied
from Nango.

## From draft to live use

1. **Import or register.** Upload a catalog or `providers.yaml` to the import
   route with `adapterId: "catalog-http"`; each provider becomes a draft
   definition (up to 64 per import). Or register providers with the host:
   `createConnectorRegistry({ providerCatalog: { entries, nangoYaml } })`, also
   reachable through `createConnectorRuntime({ inventory })`. Each registered
   provider appears in the directory as its own `catalog-<id>` connector,
   labelled `fixture`, or `catalog-only` when it cannot execute.
2. **Review.** A reviewer approves a binding like any other: the proxy base URL
   as the destination (an exact origin; for a templated host, the concrete
   tenant origin, which is not a declared server, so host policy must admit
   it, for example through the default policy's `destinations` allowlist), the `proxy.get` / `proxy.post` / ... methods with
   their output classification and consent. Review copies the entry from the
   definition into the binding's settings, where the reviewed digest covers
   it; a reviewer's own settings cannot carry it (`settings.reserved`), so the
   endpoints and client-secret names a binding uses are the imported ones. An
   OAuth entry's issuer and authorization, token and refresh origins go
   through host policy's `allowIssuer`, for a person only, as a reviewed
   issuer policy does; a templated host is named `https://*.<suffix>`, which
   only a host that lists it admits. A host-registered provider's own entry
   is authoritative, so review refuses a definition carrying a different one.
   An adapter reads only the configuration names the binding approved.
3. **Connect.** OAuth authorization code goes through the shared engine in
   `auth/*` (state, S256 PKCE, one-use codes, RFC 9207 `iss` checks). Client
   credentials is acquired at connect. API keys, Basic and bearer credentials
   are collected through the private collector and, when the entry declares a
   verification read, checked before the connection becomes active.
4. **Use.** `invoke` sends a caller-named path under the approved base. The
   destination's origin must equal the entry's declared proxy origin. Expiring
   OAuth credentials are refreshed first, under the custody port's
   single-flight lock; a token the provider refuses with 401 or 403 is renewed
   once (refresh token, or a new client-credentials grant) and the request
   retried once, each request journaled as its own attempt. Error responses
   return only their status, and a response that quotes a credential back has
   it redacted.

## Limits

- Evidence is `protocol-fixture`: the adapter is exercised end to end against
  loopback fixtures (`tests/connectors/provider-catalog/`). That is not
  evidence that any provider in a catalog works, and no entry is labelled live.
- Client credentials uses the shared engine grant (`grantClientCredentials`,
  `renewClientCredentials`), with the entry's `tokenParams` as extra token
  parameters; parameters the grant owns (grant type, client authentication,
  scope, resource) cannot be set that way.
- Not described by the format: OAuth 1.0a, request signing, app installations,
  custom multi-step flows, webhooks, pagination and retries, extra token
  parameters on the authorization-code grant, and upstream revocation.
- The `openid` scope is refused for catalog providers: an ID token would name
  the account, and without discovery there are no published keys to verify
  it against.
- A connection asks for the entry's scopes (`default_scopes`), the only ones a
  reviewer saw. A caller may name them but not add others; a scope beyond them
  is refused (`catalog.scope.undeclared`) before anything is sent.
