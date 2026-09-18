# Connector directory and Add Connection

The reference application opens on a directory: a category rail, a search
field, a featured strip and a grid of connector cards. Choosing one opens the
**Add Connection** drawer, a four-step accordion that ends by running the
ceremony itself.

## Why a directory, and why a drawer

A person arriving at a connector surface is answering two questions in order —
_is the service I need here_, and _what will connecting it involve_. The
directory answers the first and nothing else: a card carries the service, one
sentence and the badges that decide whether somebody keeps reading. It never
asks which protocol to use, because that question is about a protocol and the
person is trying to connect a service.

The drawer answers the second, and splits it because the four answers arrive at
different times from different people. Picking a service is a browsing
decision. Configuring it is an operator decision that may need a provider
console open in another tab. Customising it is a policy decision about how much
of somebody's attention the connection may spend. Completing it is the only
step where a person's own account is involved. Collapsing the three you are not
on is what keeps the last one from reading as paperwork.

## What a card is allowed to claim

Every row separates what can run from what can be described:

| Badge           | Meaning                                                           |
| --------------- | ----------------------------------------------------------------- |
| Provider-backed | A live adapter exists and verifies real access.                   |
| Local fixture   | The deterministic local harness drives it. Never a vendor claim.  |
| Bring your own  | The protocol is described; no adapter here yet. Opens the studio. |

A row marked _Bring your own_ is reachable today through a generic family —
discovery for an OAuth server, private collection for a key, an attended
session for the rest — but reachable is not built, and the card says so before
anything is pressed. A directory that blurs the two is how somebody ends up
three steps into a ceremony that was never going to finish.

## Bring your own

The directory lists named services, and a service somebody needs is often not
one of them. So the row above the provider grid is not a service at all: it is
one card per protocol this workspace can actually run, and pointing one at an
origin is the supported answer to "mine is not listed" rather than a support
request.

| Card              | Family                             | What it is for                                             |
| ----------------- | ---------------------------------- | ---------------------------------------------------------- |
| OAuth             | authorization code + PKCE          | Any OAuth 2.0 or 2.1 provider, by discovery or by hand.    |
| OAuth Machine     | client credentials                 | Server-to-server access. Nobody is interrupted.            |
| API Key           | API key                            | A shared key, or one asked of each person at connect time. |
| HTTP Basic        | identifier + provider-issued token | Never an account password.                                 |
| Device Code       | device authorization               | A CLI, a TV, anything without a browser.                   |
| Browser Login     | attended browser login             | A service that publishes no API at all.                    |
| Record a Sign-in  | attended browser login, taught     | Demonstrate once, replay without a model.                  |
| Create an Account | account registration               | Brings the account into being, minting the password.       |
| Anonymous         | anonymous, then claimed            | Completes unnamed; ownership transfers at the provider.    |

**Record a Sign-in** is the one with no equivalent in a hosted connector
marketplace. It opens with teaching already enabled, because recording the way
in is the entire reason to choose it, and a capability somebody has to go and
find first is one that gets missed. What it captures is the permitted semantic
transitions — never provider DOM, never private input. See
[teaching](ceremony-teaching.md).

These cards are also listed in the grid below, so search reaches them: typing a
family name finds every row that offers it, whether or not the words appear in
the row's own name.

## The four steps

1. **Service** — collapsed once chosen; reopening it returns to the directory.
2. **Configure** — `Managed` discovers a provider from an issuer URL;
   `Custom` declares endpoints by hand for providers that publish no metadata.
   The form asks only what the chosen family needs: a device flow has no
   redirect URI and an API key has no scopes worth discovering. Secrets are
   named, never typed here — the value stays in session-scoped encrypted
   configuration and reaches the adapter by reference.
3. **Customize** — the capabilities below, plus an interruption budget and
   whose access this is. Both feed route resolution, so the cheapest route that
   still satisfies the declaration is the one a person gets.
4. **Complete** — a summary and the live ceremony, in the same connection
   workspace the application has always rendered.

## Auth families

Beyond the OAuth and API-key pair a hosted connector marketplace usually stops
at, the drawer configures every family this project actually carries:

| Family                              | Notes                                                                                   |
| ----------------------------------- | --------------------------------------------------------------------------------------- |
| OAuth 2.1 authorization code + PKCE | Managed discovery or declared endpoints.                                                |
| OAuth 2.0 client credentials        | No person involved; completes unattended.                                               |
| API key                             | Shared on the connector, or collected per person at connect time.                       |
| HTTP Basic                          | An identifier and a provider-issued token, never an account password.                   |
| Device authorization                | Approval on a second device.                                                            |
| GitHub App manifest registration    | Registration, installation and verification as one parent ceremony.                     |
| Attended browser login              | For services publishing no API at all; see [browser login](browser-login-extension.md). |
| Account registration                | Brings an account into being, including minting the password.                           |
| Anonymous, then claimed             | Completes with nobody's name on it; ownership transfers at the provider.                |

## Capabilities

Each toggle names the module that carries it, so a reviewer can check the claim
rather than trust the copy.

| Capability                           | Module                                           |
| ------------------------------------ | ------------------------------------------------ |
| Teach this connection                | [`src/server/teaching.ts`](ceremony-teaching.md) |
| Save as a reusable recipe            | `src/core/recipe-contracts.ts`                   |
| Agent-to-human handoff               | [`src/server/a2h.ts`](a2h-ceremony-binding.md)   |
| Prerequisite child ceremonies        | `src/core/connector-contracts.ts`                |
| Arazzo workflow binding              | `src/server/arazzo.ts`                           |
| Session environment bindings         | `src/server/environment.ts`                      |
| Verify real access before completing | `src/server/verification.ts`                     |
| Expose to WebMCP and MCP clients     | [`src/core/webmcp.ts`](mcp-endpoint.md)          |
| Mint the credential                  | `src/core/connector-contracts.ts`                |

Verification is on before anybody asks: a returned token is not a connection,
and a connection that has read nothing has not been shown to work.

## Navigation

`/` opens the directory. A link naming a connector — `/?connector=github`,
optionally with `&ceremony=<id>` — is a resume link and opens the drawer
straight onto the run, which is what the application writes back as a ceremony
progresses. Nothing else opens the drawer on arrival: landing inside a modal
would put its scrim over the rail.

Presentation is host-owned as before. These surfaces live in the reference
application (`examples/web/`), not in the published component exports; see
[embedding](integration.md).
