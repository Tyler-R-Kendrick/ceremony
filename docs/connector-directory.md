# Connector directory and Add Connection

**The reference application ships two connector surfaces, and they are not the
same design.** Knowing which one you are looking at is the first thing to
establish, because they disagree about where a connector's facts come from.

| Surface                | Section                | Lives in        | Where its rows come from                                  |
| ---------------------- | ---------------------- | --------------- | --------------------------------------------------------- |
| Catalogue directory    | `/` (Connect)          | `examples/web/` | A static catalogue compiled into the page (`catalog.ts`). |
| Server-bound workspace | `/?section=connectors` | `src/react/`    | `/api/v1/connectors/*`, parsed before rendering.          |

They arrived from opposite directions. The catalogue directory answers "is the
service I need here" for a person browsing, and can draw a row for a service
this deployment cannot actually run — deliberately, because being told a
protocol is unsupported is more useful than an empty grid. The server-bound
workspace answers "what can this deployment actually do right now", and by
construction cannot claim a connector the server does not publish.

Neither is redundant and neither is finished: consolidating them is a decision
nobody has taken yet, and until it is taken both are documented here rather
than one of them quietly describing the other. The bundle ceiling in
`scripts/check-bundle.mjs` carries both, and says so.

---

# Part one — the catalogue directory

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
   Either way the form asks only what the chosen family needs: a device flow
   has no redirect URI and an API key has no scopes worth discovering. Secrets
   are named, never typed here — the value stays in session-scoped encrypted
   configuration and reaches the adapter by reference.
3. **Customize** — the capabilities below, plus an interruption budget and
   whose access this is.
4. **Complete** — a summary and the live ceremony, in the same connection
   workspace the application has always rendered.

## What the drawer declares

Configure and Customize are not a form that gets filed somewhere. Every answer
either narrows which routes are eligible or changes which eligible route is
cheapest, through the `EntryContext` the application hands the resolver
([`src/core/resolution.ts`](../src/core/resolution.ts)):

| Answer                  | Field               | What it does                                                    |
| ----------------------- | ------------------- | --------------------------------------------------------------- |
| Scopes                  | `requiredScopes`    | A route that cannot carry all of them is not offered.           |
| Environment-entry names | `heldConfiguration` | A route that would stop and ask for one it holds ranks higher.  |
| Whose access this is    | `identity`          | Excludes routes that complete for the wrong owner.              |
| Interruption budget     | `interruptions`     | Excludes routes that stop for a person more often than allowed. |

The two are different in kind, and the difference matters when something goes
wrong: scopes and ownership **gate** a route, held configuration only **ranks**
one. Naming an entry no route wants changes nothing rather than looking like a
route that is ready.

An environment name is a name, never a value. It must be the shape a session
environment can hold — capitals, digits and underscores, starting with a letter
— and the field says so as you type, because a name silently dropped is a
connection that quietly asks for something it was told it already had.

A declaration can also narrow a connector down to nothing. Complete resolves it
before running anything and, when no route survives, names the answer
responsible rather than reporting that no authentication method was available:
the first is a step to go back to, the second is a dead end.

## Auth families

Beyond the OAuth and API-key pair a hosted connector marketplace usually stops
at, the drawer configures every family this project actually carries:

| Family                              | Notes                                                                                   |
| ----------------------------------- | --------------------------------------------------------------------------------------- |
| OAuth 2.1 authorization code + PKCE | Managed discovery or declared endpoints.                                                |
| API key                             | Shared on the connector, or collected per person at connect time.                       |
| HTTP Basic                          | An identifier and a provider-issued token, never an account password.                   |
| Device authorization                | Approval on a second device.                                                            |
| GitHub App manifest registration    | Registration, installation and verification as one parent ceremony.                     |
| Attended browser login              | For services publishing no API at all; see [browser login](browser-login-extension.md). |
| Account registration                | Brings an account into being, including minting the password.                           |
| Anonymous, then claimed             | Completes with nobody's name on it; ownership transfers at the provider.                |

## Capabilities

Each one names the module that carries it, so a reviewer can check the claim
rather than trust the copy. They divide by **who decides**, and Customize shows
the two groups differently, because a checkbox beside something this
application cannot change is the same false promise as a menu that never opens.

### Switches this application has

These take a prop the component actually reads, so the box does what a box
looks like it does. Each starts where the application already started.

| Capability                       | Module                                           | Default | Off means                                            |
| -------------------------------- | ------------------------------------------------ | ------- | ---------------------------------------------------- |
| Teach this connection            | [`src/server/teaching.ts`](ceremony-teaching.md) | On      | The plain ceremony runs; the way in is not recorded. |
| Agent-to-human handoff           | [`src/server/a2h.ts`](a2h-ceremony-binding.md)   | Off     | Every approval happens in this browser.              |
| Expose to WebMCP and MCP clients | [`src/core/webmcp.ts`](mcp-endpoint.md)          | On      | The connection is driveable only from this page.     |

Agent assistance is off by default because approving in your own browser is the
thing nobody asked for help with. The other two are on because that is what the
page did before either was a switch — teaching wherever the server offers it,
and WebMCP because the component exposes a connection unless a host says
otherwise.

### What the connector settles for itself

These follow from the manifest and its adapter. They are shown, with their
modules, and not offered:

| Capability                           | Module                            |
| ------------------------------------ | --------------------------------- |
| Save as a reusable recipe            | `src/core/recipe-contracts.ts`    |
| Prerequisite child ceremonies        | `src/core/connector-contracts.ts` |
| Session environment bindings         | `src/server/environment.ts`       |
| Verify real access before completing | `src/server/verification.ts`      |
| Mint the credential                  | `src/core/connector-contracts.ts` |

Verification is the clearest case: a returned token is not a connection, and a
connection that has read nothing has not been shown to work. Nothing on this
page can waive that, so it is stated rather than asked.

Which group a capability belongs to is a field in the catalogue's own table,
and the type of a host switch is derived from it — so moving one is a single
edit and anything still assuming the old answer stops compiling.

## Navigation

`/` opens the directory. A link naming a connector — `/?connector=github`,
optionally with `&ceremony=<id>` — is a resume link and opens the drawer
straight onto the run, which is what the application writes back as a ceremony
progresses. Nothing else opens the drawer on arrival: landing inside a modal
would put its scrim over the rail.

A link naming a connector this workspace does not publish opens nothing, because
the directory row is what mounts the drawer. The directory says so where that
link lands, names what was asked for, and offers the studio; picking a service
clears it.

Presentation is host-owned as before. These surfaces live in the reference
application (`examples/web/`), not in the published component exports; see
[embedding](integration.md).

---

# Part two — the server-bound workspace

Reached from the **Connectors** section. The surfaces are a directory bound to
the server's inventory, a drawer that runs one connection, and an import review
for operators. They live in `src/react/` and are composed for the reference
application by `examples/web/connectors.tsx`.

Everything on screen comes from `/api/v1/connectors/*`. There is no static
catalogue in this surface, so nothing in it can claim a connector the
deployment cannot run, and no control changes state that only the server can
change. That is the whole difference from part one, and it is why both exist.

## The components

| Module                               | What it is                                                                                         |
| ------------------------------------ | -------------------------------------------------------------------------------------------------- |
| `src/core/connectors/client.ts`      | The typed browser client. Parses every response with the core schemas before a component sees it.  |
| `src/react/connector-directory.tsx`  | The directory: search, facets, service grouping, support and evidence badges, capability reports.  |
| `src/react/connector-drawer.tsx`     | The modal shell: focus entry, focus trap, focus restoration, Escape.                               |
| `src/react/connector-connection.tsx` | One connection: intent, handoff, polling, verification, invocation, reconnect, disconnect.         |
| `src/react/connector-review.tsx`     | Import and review: provenance, diagnostics, mappings, proposed binding. Loaded on demand.          |
| `src/react/connectors.css`           | Zero-specificity styling scoped to `[data-connector]`, reading the existing `--ceremony-*` tokens. |
| `examples/web/connectors.tsx`        | The page composition: directory plus drawer, deep links, lazy import surface.                      |

## What a row is allowed to claim

The catalogue separates four things a marketplace usually blurs, and the card
shows which one it is:

| Support level     | Meaning                                                                          |
| ----------------- | -------------------------------------------------------------------------------- |
| `provider-backed` | A real adapter runs this and the deployment holds the configuration it needs.    |
| `fixture`         | A deterministic local harness drives it. Never a claim about a vendor.           |
| `unconfigured`    | The adapter exists; this deployment is missing configuration it requires.        |
| `catalog-only`    | Described here, implemented nowhere. Reviewable and exportable, not connectable. |

Beside it, an evidence chip carries the strongest measured evidence level
(`not-tested` … `deployed-authorized`), and the per-dimension table inside the
drawer keeps each dimension's own implementation, configuration readiness and
evidence. That is the distinction AC-UX-06 asks for: implemented, configured,
proven against a fixture and proven live are four different statements.

Every entry also carries a `supportLabel` computed from dated evidence rather
than from the adapter family: `unverified`, `fixture` (in-process fixtures),
`local` (local doubles such as loopback servers), `live` (a recorded run
against the provider, 90 days) or `certified` (an attended live run, 180 days).
The rules and windows are in `supportLabelRules`
(`src/core/connectors/support-labels.ts`) and in the
[support matrix](specifications/connector-support-matrix.md#support-labels).
The repository's recorded entries ship with the runtime and none is live; a
host adds its own through `createConnectorRuntime({ support: { evidence } })`,
and those are refused at startup if malformed or dated in the future. Only a
live or certified label, with its configuration present, turns a `fixture`
adapter into `provider-backed`. `connector_catalog` and `connector_status`
return the label to an assistant.

The generic OpenAPI and provider-catalog adapters run whatever description a
person imported, so their catalog row describes only the code path: it can
read `local`, never `live`. Wherever a label admits or promotes something
(the production gate, a registration, a connection's status) it is the label
of the binding's own definition, earned by entries that name that definition
(`definition`: its `definitionRef` or `sha256:<normalizedDigest>`). An
imported description nobody exercised is `unverified` there.

A label gates nothing by default. A host that wants it to sets
`support: { minimumForProduction: "local" }` (or any label): a binding that can
reach anything but a loopback fixture is then refused with
`support.below-minimum` at approval, connect, the completion of a pending
ceremony, poll, verify, reconnect and every invocation while its definition's
label is below the minimum, so expired evidence stops new work and an
in-flight ceremony does not finish. Disconnecting and revoking are never
gated.

Alternatives for one service are grouped under one heading and never merged.
A native GitHub adapter and a brokered one differ in custody, evidence and
grant, so they stay two cards; merging them would be the directory choosing an
authority on somebody's behalf.

Search and facets run over the whole inventory. Paging is a rendering budget —
"Show N more" — and never a filter, so a search cannot silently miss a row
further down the list.

## Deep links

- `/` opens on the directory. Nothing else opens the drawer on arrival;
  landing inside a modal puts a scrim over the navigation.
- `/?connector=<id>` opens the drawer on that connector: a link that names one
  is somebody returning to work they started.
- `/?connection=<ref>` — what the server's callback route appends — reopens
  that connection and reads its status from the server before showing it.
- `&mode=test` and `&section=` are preserved when the page rewrites the query.

## Where this surface deliberately differs

The drawer in part one and the drawer here were designed against different
contracts, and the differences are not accidents or omissions. Each row below
is a control the catalogue drawer offers that this one does not, with the
reason. **The catalogue drawer still offers all of them**; this table says what
this surface does instead, not what was taken away from the application.

| Catalogue drawer control                                                                                               | What the server-bound surface does instead                                                                                                                                        |
| ---------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Auth family radio list ("Flows this connector supports")                                                               | **Authentication method** → `intent.profileId`, populated from the definition's own authentication profiles. The server decides whether the profile is permitted for the binding. |
| `Managed` / `Custom` configuration source                                                                              | **Environment and authority**, chosen from approved bindings → `bindingRef`. Endpoints are never declared from the browser.                                                       |
| Per-family endpoint fields (issuer, authorization endpoint, token endpoint, device endpoint, entry origin, claim page) | Not offered. An imported or typed URL is not an approved destination; the binding's destinations are.                                                                             |
| Environment-name fields (client id, key name, app id, private key)                                                     | Shown as a readiness report (`present` / `missing`). Values are set on the server by an operator.                                                                                 |
| Service / name / UID                                                                                                   | Not offered. Identity comes from the catalogue entry and the definition.                                                                                                          |
| Target (account, organization, site)                                                                                   | **Account or workspace** → `intent.target`. Where the provider offers a list, the options arrive from the server as handoff fields.                                               |
| Identity preference (`personal` / `anonymous` / `either`)                                                              | **Whose access this is** → `ownerKind`. `organization` is offered only when the catalogue's viewer reports that owner kind; otherwise it reads "requires administrator policy".   |
| Interruption budget (`any` / `at-most-one` / `none`)                                                                   | `intent.interruption` (`allowed` / `none`), with copy saying it is a constraint: "none" may end in `human-required`, and never in another route.                                  |
| Shared vs per-user API keys                                                                                            | Not a control. Custody is reported from the catalogue entry and stated as server policy: "it cannot be changed from here". A radio button cannot change who owns a grant.         |
| Capability toggles (teaching, recipes, a2h, prerequisites, arazzo, session environment, webmcp, minted password)       | A read-only capability report of the server's `CapabilityStatus` rows: dimension, profile, implementation, configuration, evidence and limitations.                               |
| "Verify real access before completing" toggle                                                                          | No switch and no default. Verified status exists only as the server's verification claims.                                                                                        |
| Expiration select (`30d` / `90d` / `1y`)                                                                               | Reported from the verification claim's `validUntil`, including "the provider did not state an expiry".                                                                            |
| Step accordion (Service / Configure / Customize / Complete)                                                            | One drawer: intent, then the handoff, then the connection. The four-step shape exists to hold configuration this surface does not collect.                                        |
| Drawer scrim, Close, Escape                                                                                            | Kept, with focus entry, a focus trap and focus restoration added.                                                                                                                 |

## What the connection surface reports

- **Verification**: the claim kinds, when they were observed, how long they are
  valid, what they explicitly do not establish, and the exact verified target.
  With no claim it says so; a completed provider page is not verification.
- **Custody**: the entry's credential custody, as a badge and as a sentence
  about who decides it.
- **Freshness and expiry**: relative observation time and `validUntil`, marked
  when expired.
- **Handoffs**: the meter counts how many times this connection has asked a
  person, which is the cost the directory's meter estimates elsewhere.
- **Indeterminate outcomes**: named as unknown and being reconciled, never
  retried silently.
- **Disconnect**: three separate effects, each with its own sentence, and a
  result that reports every scope plus the other connections sharing the grant.

## How status is decided

Only a server response changes status. A `postMessage` from the handoff window
is accepted only when it comes from this origin, from the exact window this
page opened, and names this connection and handoff; anything else is counted
and dropped. A closed window and a "I finished in the provider" button do one
thing each: ask the server again. A callback that returns to the page reopens
the connection by reference and re-reads it.

The window is opened on the click and navigated once the server answers, so a
slow authorization does not lose the user activation a browser requires. If the
browser blocks it anyway, the same authorization continues in the current tab
and returns to the connection.

## Privacy of inputs

Public names and non-secret settings stay in component state. A field the
server classifies as `secret` is never mirrored into React state, a draft, the
URL, analytics or a log: it is read from the form once, sent to the private
collector, and replaced by the reference the collector returns before the
handoff is submitted. Dynamic option lists (the Microsoft `dependsOn` shape)
are fetched by invoking the server operation the field names, with the values
of the fields it depends on — never with a secret, and never from a cache.

## Accessibility

The drawer is a labelled dialog: focus moves inside on open, Tab and
Shift+Tab cycle within it, Escape closes it, and focus returns to the control
that opened it. Field labels carry the field's name only; hints, loading and
error states are separate elements referenced with `aria-describedby`.
Status changes are announced through `role="status"`, failures through
`role="alert"`. Layout is checked at 390px with no horizontal scrolling, and
controls keep a 40px minimum height at both widths. Axe reports no violations
on the directory or the drawer.

## Offline and session loss

`navigator.onLine === false` disables connecting and invoking, and says that
nothing is queued. The client refuses mutations while offline rather than
buffering them. Connector responses are requested with `cache: "no-store"`,
and the service worker is unchanged: it caches three static files and never
touches `/api/`, so no connection status can be served from a cache.

A `401` clears the connection from the screen and asks for sign-in. Nothing
read under the previous session stays visible.

## Tests

| Command                                                         | What it covers                                                            |
| --------------------------------------------------------------- | ------------------------------------------------------------------------- |
| `node --import tsx --test tests/connectors/ux/*.test.ts`        | Client contract, directory, connection, review and service-worker guards. |
| `npx playwright test tests/browser/connector-directory.spec.ts` | The whole browser journey and the message-correlation oracles.            |
| `npx playwright test tests/browser/connector-drawer.spec.ts`    | Focus, accessibility, dynamic fields and the popup fallback.              |

The browser specs serve themselves: `tests/connectors/ux/harness-server.ts`
bundles the shipped components with esbuild and serves them, the documented
route table and a fixture provider from an ephemeral loopback port, with a
second origin whose only job is to post a completion message that must be
ignored. They need no reference application and no fixed port.
