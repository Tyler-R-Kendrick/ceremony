# Connector directory, drawer and connection

The connector surfaces are a directory bound to the server's inventory, a
drawer that runs one connection, and an import review for operators. They live
in `src/react/` and are composed for the reference application by
`examples/web/connectors.tsx`.

Everything on screen comes from `/api/v1/connectors/*`. There is no static
catalogue in the browser, so nothing here can claim a connector the deployment
cannot run, and no control changes state that only the server can change.

## The components

| Module                             | What it is                                                                                            |
| ---------------------------------- | ----------------------------------------------------------------------------------------------------- |
| `src/core/connectors/client.ts`    | The typed browser client. Parses every response with the core schemas before a component sees it.     |
| `src/react/connector-directory.tsx`| The directory: search, facets, service grouping, support and evidence badges, capability reports.     |
| `src/react/connector-drawer.tsx`   | The modal shell: focus entry, focus trap, focus restoration, Escape.                                  |
| `src/react/connector-connection.tsx`| One connection: intent, handoff, polling, verification, invocation, reconnect, disconnect.            |
| `src/react/connector-review.tsx`   | Import and review: provenance, diagnostics, mappings, proposed binding. Loaded on demand.             |
| `src/react/connectors.css`         | Zero-specificity styling scoped to `[data-connector]`, reading the existing `--ceremony-*` tokens.    |
| `examples/web/connectors.tsx`      | The page composition: directory plus drawer, deep links, lazy import surface.                         |

## What a row is allowed to claim

The catalogue separates four things a marketplace usually blurs, and the card
shows which one it is:

| Support level     | Meaning                                                                       |
| ----------------- | ----------------------------------------------------------------------------- |
| `provider-backed` | A real adapter runs this and the deployment holds the configuration it needs. |
| `fixture`         | A deterministic local harness drives it. Never a claim about a vendor.        |
| `unconfigured`    | The adapter exists; this deployment is missing configuration it requires.     |
| `catalog-only`    | Described here, implemented nowhere. Reviewable and exportable, not connectable. |

Beside it, an evidence chip carries the strongest measured evidence level
(`not-tested` … `deployed-authorized`), and the per-dimension table inside the
drawer keeps each dimension's own implementation, configuration readiness and
evidence. That is the distinction AC-UX-06 asks for: implemented, configured,
proven against a fixture and proven live are four different statements.

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

## The PR #39 drawer controls, audited

Every control in the earlier Add Connection drawer was checked against the
server contract. A control either names a field of a server command or it is
gone.

| PR #39 control                        | Outcome                                                                                                                                                              |
| ------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Auth family radio list ("Flows this connector supports") | Kept as **authentication method** → `intent.profileId`, populated from the definition's authentication profiles. The server decides whether the profile is permitted for the binding. |
| `Managed` / `Custom` configuration source | **Removed.** Endpoints are never declared from the browser. The equivalent choice is **environment and authority**, chosen from approved bindings → `bindingRef`.   |
| Per-family endpoint fields (issuer, authorization endpoint, token endpoint, device endpoint, entry origin, claim page) | **Removed.** An imported or typed URL is not an approved destination; the binding's destinations are.                                                                |
| Environment-name fields (client id, key name, app id, private key) | **Removed** from the connection drawer. Configuration names are shown as a readiness report (`present` / `missing`); values are set on the server by an operator.     |
| Service / name / UID                  | **Removed.** Identity comes from the catalogue entry and the definition.                                                                                             |
| Target (account, organization, site)  | Kept as **account or workspace** → `intent.target`. Where the provider offers a list, the options arrive from the server as handoff fields.                          |
| Identity preference (`personal` / `anonymous` / `either`) | Replaced by **whose access this is** → `ownerKind`. `organization` is offered only when the catalogue's viewer reports that owner kind; otherwise it is disabled and reads "requires administrator policy". |
| Interruption budget (`any` / `at-most-one` / `none`) | Kept as `intent.interruption` (`allowed` / `none`). The copy says it is a constraint: "none" may end in `human-required`, and never in another route.                 |
| Shared vs per-user API keys           | **Removed as a control.** Custody is reported from the catalogue entry and stated as server policy: "it cannot be changed from here". A radio button cannot change who owns a grant. |
| Capability toggles (teaching, recipes, a2h, prerequisites, arazzo, session environment, webmcp, minted password) | **Removed.** Replaced by a read-only capability report of the server's `CapabilityStatus` rows: dimension, profile, implementation, configuration, evidence and limitations. |
| "Verify real access before completing" toggle | **Removed entirely.** Verified status exists only as the server's verification claims; there is no switch, and no default, to turn off.                               |
| Expiration select (`30d` / `90d` / `1y`) | **Removed.** Validity is reported from the verification claim's `validUntil`, including "the provider did not state an expiry".                                      |
| Step accordion (Service / Configure / Customize / Complete) | Simplified to one drawer: intent, then the handoff, then the connection. The four-step shape existed to hold configuration the browser no longer collects.            |
| Drawer scrim, Close, Escape           | Kept, with focus entry, a focus trap and focus restoration added.                                                                                                    |

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

| Command                                                          | What it covers                                                         |
| ---------------------------------------------------------------- | ------------------------------------------------------------------------ |
| `node --import tsx --test tests/connectors/ux/*.test.ts`         | Client contract, directory, connection, review and service-worker guards. |
| `npx playwright test tests/browser/connector-directory.spec.ts`  | The whole browser journey and the message-correlation oracles.           |
| `npx playwright test tests/browser/connector-drawer.spec.ts`     | Focus, accessibility, dynamic fields and the popup fallback.             |

The browser specs serve themselves: `tests/connectors/ux/harness-server.ts`
bundles the shipped components with esbuild and serves them, the documented
route table and a fixture provider from an ephemeral loopback port, with a
second origin whose only job is to post a completion message that must be
ignored. They need no reference application and no fixed port.
