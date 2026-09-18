# Connector dialect and version profile

Status: **Ceremony implementation profile, version 1** (`ceremony-dialects/1`). This page states which document dialects and protocol revisions this repository actually reads, which subset of each it can execute, how credentials are held, how a connection's life is modelled, what an import loses and says it lost, and what an existing deployment has to do when any of that moves.

It is not an industry protocol, not a conformance claim against any of the specifications below, and not a statement about any provider. Every claim here is derived from the code named beside it. Where the code does less than a specification requires, this page says so rather than rounding up.

Three companions carry the parts this page deliberately does not repeat:

| Document                                                        | Owns                                                                                        |
| --------------------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| [Connector interoperability](connector-interoperability.md)     | The core contracts in `src/core/connectors/`: identity, dispositions, evidence, projections |
| [Arazzo interoperability profiles](arazzo-profiles.md)          | Everything `src/server/connectors/formats/arazzo/` does with an Arazzo description          |
| [Connector support matrix](connector-support-matrix.md)         | Per-adapter, per-dimension support, generated from the adapters and the ledgers             |
| [Source lock](../implementation-evidence/connector-interoperability/source-lock.md) | Which document, at which revision, under which licence, each dialect claim rests on         |

Examples in this document are files under [`examples/connectors/`](examples/connectors/). Each one is parsed by the authoritative runtime schema in [`tests/connectors/docs/examples.test.ts`](../../tests/connectors/docs/examples.test.ts), which the standard test discovery runs. A published example that stops validating is a failing test.

## CDP-01: what a profile version pins

Seven version fields are kept apart, because they move independently and a single "connector version" would hide which one changed:

| Field                    | Example                    | Changes when                                            |
| ------------------------ | -------------------------- | ------------------------------------------------------- |
| Envelope version         | `ceremony-connector/2`     | The portable document shape changes                     |
| Native document version  | `3.1.0`, `2026-07-28`      | The upstream author publishes a different document      |
| Importer version         | `openapi-importer 1.0.0`   | The reader's interpretation changes                     |
| Normalized definition    | `schemaVersion: 1`         | The normalized shape changes                            |
| Adapter version          | per adapter                | The wire implementation changes                         |
| API operation version    | per operation              | A vendor versions one endpoint and not its neighbours   |
| Evidence format          | `reportVersion: 1`         | The evidence report's own shape changes                 |

A `RuntimeBinding.reviewedDigest` binds an approval to the exact transitive artifact set, so none of these can move underneath an approved binding without invalidating it. Vercel Connect is the concrete reason the sixth field exists: its endpoint versions differ by operation, and `v1` and `v2` paths coexist in one API.

## CDP-02: supported dialects

`implemented` below means a version-dispatched reader exists and is exercised by tests. A version not in this table is refused with one blocking version issue and no interpretation: no reader guesses at a document whose declared version it does not know.

### Description formats

| Dialect                          | Versions read                     | Module                                        | Notes                                                                                                              |
| -------------------------------- | --------------------------------- | --------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| OpenAPI / Swagger                | 2.0, 3.0.x, 3.1.x, 3.2.x          | `formats/openapi/read.ts`                     | Explicit per-version readers. A reader refuses a document of another version; a missing, doubled or unknown version is blocking. |
| OpenAPI Overlay                  | 1.0.x, 1.1.x                      | `formats/overlay/apply.ts`                    | Dispatch on the `overlay` field; the patch component is ignored per the specification.                             |
| Arazzo                           | 1.0.1, 1.1.0                      | `formats/arazzo/read.ts`                      | See [Arazzo profiles](arazzo-profiles.md). `1.0.0` and `1.2.0` are refused.                                        |
| AsyncAPI                         | 3.0.x, 3.1.x                      | `events/asyncapi.ts`                          | Descriptions only: an AsyncAPI operation never becomes an HTTP capability.                                         |
| MCP `server.json`                | 2025-09-16 … 2025-12-11           | `registries/mcp/import.ts`                    | Pre-2025-09-16 snake_case documents are refused, not translated. An unlisted declared version imports with a `version.schema-unpinned` issue. |
| Microsoft custom connector       | Swagger 2.0 plus `x-ms-*`         | `formats/microsoft/`                          | Static metadata only; policies and custom code are inert and execution-blocked.                                    |
| Zapier / n8n / Workato           | native metadata, per family       | `formats/zapier/`, `formats/n8n/`, `formats/workato/` | Separate profiles. No source is evaluated to discover a field.                                                     |
| Camel Kamelets                   | pinned catalog release            | `formats/camel-kamelet/`                      | Catalog and configuration import plus a host-runner binding description. No JVM is embedded.                       |
| Retrieval / ACL descriptors      | Cloud Search-informed model       | `formats/retrieval/`                          | Descriptor and evaluator. No indexer, no crawler.                                                                  |

### Protocol revisions

| Protocol                     | Revisions                                   | Module                        | Notes                                                                                                   |
| ---------------------------- | ------------------------------------------- | ----------------------------- | --------------------------------------------------------------------------------------------------------- |
| MCP (outbound client)        | 2026-07-28, 2025-11-25, 2025-06-18          | `mcp/profiles.ts`             | Two eras, never mixed in one message. The profile comes from the binding, never from the installed SDK. |
| MCP registry REST            | `/v0.1` (preview)                           | `registries/mcp/client.ts`    | Pinned independently of the `server.json` schema version.                                               |
| CloudEvents                  | 1.0, JSON event format                      | `events/envelope.ts`          | Binary mode (`data_base64`) is refused, not partially handled.                                          |
| Standard Webhooks            | 1.0.0, symmetric `v1` scheme                | `events/standard-webhooks.ts` | Asymmetric `v1a` (ed25519) is recognized and reported `unsupported-scheme`.                             |
| OAuth 2.0 family             | RFC 9700 baseline; 7636, 8414, 8628, 9126, 9207, 9728, 7591, 8707, 9396, 8693, 7662 | `auth/`                       | OAuth 2.1 (`-16`) and CIMD (`-03`) are **drafts**; the exact revision is recorded and no finalized-standard or certification status is claimed. |

### Ingestion dialects

JSON is read as RFC 8259 with a strict scanner that detects duplicate keys before `JSON.parse` collapses them. YAML is read as **YAML 1.2 core schema only**. An explicit `%YAML 1.1` directive is refused rather than reinterpreted, because 1.1 changes the meaning of unquoted `yes`/`no`/`on`/`off` and of sexagesimal scalars. Explicit `!!binary`, `!!timestamp`, `!!omap`, `!!set` and `!!pairs` tags are refused; merge keys (`<<`) are refused rather than applied; a multi-document stream is refused instead of silently using the first document. References resolve only as RFC 6901 JSON pointers: a plain-name fragment, `$anchor`, `$dynamicRef` and `$recursiveRef` are reported unsupported rather than approximated.

## CDP-03: executable subsets

Reading a document and being able to run an operation from it are separate results, and the second is always the smaller one.

### The HTTP executable subset

In: `application/json` (and `+json`) request and response bodies; path and header parameters in style `simple`; query parameters in style `form` with `explode` honoured and `allowReserved` respected; primitives and arrays of primitives. Schema keywords validated: `type` (including 3.1/3.2 type arrays and 3.0 `nullable`), `enum`, `const`, `required`, `properties`, `items`, `additionalProperties`, length and numeric bounds, `multipleOf`, `uniqueItems` and basic formats.

Out, each with its own `serialization.*` or `structure.*` issue that blocks exactly the operation using it: multipart, form-urlencoded, XML, streaming and every other media type; cookie parameters; 3.2 `querystring` parameters; parameters described by `content`; `deepObject`, `spaceDelimited`, `pipeDelimited`, `matrix` and `label` styles; `allOf`/`anyOf`/`oneOf`/`not`/`if-then-else`, `pattern`, `patternProperties`, `prefixItems`, `contains`, `unevaluated*`, `discriminator` and dynamic references; any method outside the seven the binding contract carries, which is why 3.2 `QUERY` and `additionalOperations` entries stay discoverable and unbindable.

**Locality is the invariant.** Every blocking diagnostic names one operation and leaves the rest of the document discoverable and bindable. A recursive schema compiles into a named definitions table and validates to an explicit depth; only a pure `$ref` alias cycle with no concrete schema is unresolvable.

Policy defaults are deliberately pessimistic: read effect and read-only replay for `GET` and `HEAD`, unknown effect with no replay and `confirm` consent for everything else, `personal` output classification and `confirm` consent even for `GET`. A `GET` is still policy-gated. A host review may override effect, classification, cost, consent, replay and target parameters; an inconsistent review — read-only replay on a write, or a target parameter the operation does not declare — blocks the operation.

### The Overlay JSONPath subset

Selectors: root (`$`), child by name (`.name`, `['name']`, `["name"]`), wildcard (`.*`, `[*]`), recursive descent (`..name`, `..*`) and non-negative array index (`[0]`). RFC 9535 filters, scripts, unions, slices, negative indexes and function extensions are refused with a blocking `structure.unsupported-selector` rather than approximated.

This is an explicit, documented subset and **not a conformance claim**. Overlay 1.1.0 requires full RFC 9535 for interoperable documents, so an overlay using a filter — including the specification's own filter examples — is refused rather than partially applied.

### The Arazzo executable profile

Summarised in [arazzo-profiles.md](arazzo-profiles.md). The boundary that matters here: `simple` criteria are evaluated; `regex`, `jsonpath` and `xpath` criteria are parsed for their embedded expressions, preserved and blocked, because this runtime implements none of those languages. Step resolution is exact — a plain `operationId` defined by two registered documents is a blocking `identity.ambiguous-operation`, and there is no first-match path in the code.

### The AsyncAPI event subset

Transport `http-webhook` is claimed only for an inbound operation whose every declared protocol is `http` or `https`. `ws`, `wss`, `kafka`, `amqp`, `mqtt`, `googlepubsub` and every other binding keep transport `unsupported` with the native transport preserved. No broker runtime exists. Message payload schemas are preserved by reference rather than expanded, so a recursive schema is bounded by construction.

### The MCP client subset

Sampling is refused rather than suspended, in either era. Roots answer an empty list. Extensions — including the tasks extension — are reported unsupported and are never assumed. stdio transports are unsupported by design: a hosted connector launches no local process. Only form-mode elicitation is answered with values; URL mode produces a browser handoff for the initiating human and the client never fetches the URL. Rounds are bounded; a server that keeps asking is failed, not looped.

## CDP-04: custody models

Custody is a property of the connection, not of the protocol, and this profile keeps five kinds apart. Remote credential access and remote execution are **different interfaces**: an implementation must not convert a non-exportable authority into an exported credential.

| Custody                       | The host holds                         | Concrete adapters                                                      | What the host cannot do                                                     |
| ----------------------------- | -------------------------------------- | ------------------------------------------------------------------------ | ----------------------------------------------------------------------------- |
| `host-owned`                  | The credential, encrypted              | `supabase-management`, `supabase-data-api`, `openapi-http`, `mcp-remote` | Nothing extra; it also owns rotation, single-flight refresh and revocation  |
| `external-credential-broker`  | An opaque broker reference             | `nango`, `auth0-token-vault`, `merge`, `workos-pipes`                    | Read the credential. Refresh stays the broker's unless its contract delegates it |
| `external-execution-broker`   | A reference the broker executes against | `composio`, `smithery`, `supabase-wrappers`, `nango` (proxy/action)      | Obtain a credential at all                                                  |
| `attended-browser`            | A reference to a human's live session  | (ceremony flows)                                                          | Replay the session without the human                                        |
| `no-credential`               | Nothing                                | `mcp-registry`, `docker-mcp-catalog`, `pulsemcp`, public APIs            | Claim an authenticated identity                                             |

Two custody rules have teeth in the code. First, every credential use happens inside `credentials.use`; an adapter never receives a credential value as an argument. Second, credential *kinds* are distinct and checked: a Supabase service-role secret or management token presented to the project Data API adapter is refused before a request is built, by kind metadata and by documented key format — never by parsing a secret into a log.

Protected transient material — OAuth state, PKCE verifiers, device codes, authorization URLs, Connect links, widget tokens, private collector references — lives only in `HandoffIssue.private` and reaches only the authenticated initiating human, through `humanConnectionProjection`. A vendor's claim that a link is chat-safe does not override this.

## CDP-05: lifecycle models

A connection has eleven states and a fixed transition table (`lifecycleTransitions`). `active` is reachable only from `verifying`, from `degraded` recovering, or from `indeterminate` after reconciliation. No callback, broker status or transport success reaches `active` directly.

Six endings are modelled separately because they are different authorized intents with different policy, and because collapsing them is how a product ends up telling someone their access was revoked when it was not:

| Intent                | What happens locally                | What happens upstream                    | Default |
| --------------------- | ----------------------------------- | ------------------------------------------ | ------- |
| Cancel                | A pending handoff is cancelled       | Nothing                                    | —       |
| Local disconnect      | The connection is unlinked           | **Nothing.** It does not establish revocation | yes     |
| Broker deletion       | The connection is unlinked           | The broker's record is deleted             | no      |
| Upstream revocation   | The connection becomes `upstream-revoked` | The provider's grant ends                  | no      |
| Shared connector deletion | Every local connection referencing it is affected | Shared configuration is removed      | no, administrator only |
| Resource deprovision  | —                                   | Out of scope everywhere in this repository | never   |

Four adapters report `revoke: unsupported` for a documented reason rather than approximating one: Nango and Merge document no upstream grant-revocation endpoint; MCP defines no such operation; an OpenAPI description declares none. Supabase's `POST /v1/oauth/revoke` needs the stored refresh token, so a grant issued without one reports upstream `unsupported` with the dashboard as the recorded alternative. "Cancel" on a Nango sync maps to `POST /sync/pause` and the result says so explicitly through `nango.sync.cancel-maps-to-pause`.

Reconnect is fenced. A delayed callback for an older generation cannot complete or overwrite a newer connection, and a reconnect that returns a different account requires explicit account-switch intent — there is no silent replacement.

## CDP-06: import loss semantics

An import result is a description plus a list of what the import could not carry. Losses are never silent and never inferred from absence.

Each loss is a `CompatibilityIssue` with a source pointer, a dotted code, a dimension, a disposition, a severity and an execution impact. Four rules bind them together, and the runtime refuses a combination that breaks them:

1. **Security cannot be talked down.** A `security` issue with disposition `unsupported` or `rejected` must be `blocking`; anything not mapped `exact` or `adapted` must not be `info`; a `requires-configuration` security issue must name what it blocks.
2. **Severity and impact agree.** A blocking issue blocks something; an informational issue blocks nothing; `blocks-definition` implies blocking; an `exact` or `adapted` mapping is never blocking; a `rejected` construct is never informational.
3. **Locality.** A blocking issue names the narrowest thing it can: one operation where the loss is one operation's, the authorization where it is the scheme's, the definition only where the whole document cannot be trusted.
4. **Nothing disappears.** An unmatched change in a refresh diff is reported as structural, never dropped. A construct the runtime does not understand is preserved inertly in `nativeExtensions` and counted against an explicit byte budget.

[`import-loss-issues.json`](examples/connectors/import-loss-issues.json) is the worked example, and the test asserts every one of those rules against it.

Three loss behaviours are worth stating in prose because they are easy to get backwards:

- **A public API gets an explicit `none` profile,** never a fabricated API key, identity, grant or login method. [`definition-public-api.json`](examples/connectors/definition-public-api.json) is the shape.
- **An unsupported security scheme is preserved by name and blocks authorization.** Dropping it would widen access; a requirement naming an undeclared scheme is kept and marked unknown for the same reason.
- **A refresh that changes anything security-sensitive invalidates the approval.** Servers and hosts, OAuth issuer, authorization, token and refresh endpoints, security schemes and requirements, scopes, parameter locations, operation and path add/remove, declared packages and data-classification hints are all classified `security` with blocking severity. Other changes make a candidate revision that still needs review. A pinned source is selected strictly by reference and byte digest, so a record marked `latest` is offered as a candidate and never substituted.

## CDP-07: backward compatibility

Nothing in this work changes what an existing deployment already has.

| Surface                          | Guarantee                                                                                                                 |
| -------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| `ceremony-connector` version 1   | Saved studio projects still validate through `connectorProjectSchema`, still export through `exportConnectorFiles`, and their exported documents still run through the existing bounded Arazzo executor. `src/core/connector-authoring.ts` is untouched. |
| Connector manifest version 1     | Unchanged and still non-executable. Imported URLs never enter it.                                                          |
| `@ceremony/auth` exports         | `.`, `./react`, `./server`, `./server/teaching`, `./mcp-app` and styles keep their shapes. New contracts are additive.     |
| Existing MCP server tools        | `ceremony_connect`, `ceremony_snapshot`, `ceremony_advance`, `ceremony_cancel` and `ceremony_connectors` are unchanged. The four `connector_*` tools are registered only when the host passes the optional `connectors` option. |
| Persisted records                | `recordKinds` only grew. The encrypted record table is generic, so no SQL migration is required, and a deployment that never stores a new kind never writes it. |
| Adapter interface                | One additive, optional field (`handoff?: HandoffRecord` on `AdapterCallContext`). Existing adapters compile and run unchanged. |
| Identifier contracts             | Narrowed only against inputs that were never valid upstream data: bidirectional controls, blank-only values, reserved object keys and traversal segments. No realistic identifier changed shape. |

Two narrowings are worth calling out for anyone upgrading, because a caller could depend on the old leniency:

- `nativeExtensionsSchema` now **refuses** a reserved object key instead of silently dropping it. A caller that fed attacker-controlled object keys through extensions gets a parse error where it previously got a quietly smaller object.
- `connectorReferenceSchema` refuses reserved keys and `.`/`..` path segments. A caller that built a reference from a path now gets a parse error instead of a path-shaped key.

## CDP-08: migration guide

### Version 1 project to version 2 envelope

`upgradeConnectorProject(project)` wraps a v1 project **without altering it**. Every method becomes a `ceremony-method` profile whose `methodId` and `flowKind` point back at the method. Where a v1 spelling cannot legally be a profile id or display text — a leading digit, a control character — the derived field is adjusted and the embedded project stays byte-identical.

The upgrade adds no authority: a v1 upgrade declares `invoke: "unsupported"` and `authorize: "requires-configuration"`. It adds no capabilities, events, extensions or trust-bearing fields.

`downgradeConnectorEnvelope(envelope)` returns a v1 project only when the envelope embeds one, and returns coded diagnostics either way. A description with no project produces one blocking diagnostic; when the description is public-only, the diagnostic says so rather than inventing a method. Every loss version 1 cannot carry — other authentication profiles, unreferenced configuration, capabilities, events, native extensions, extra declared servers, compatibility diagnostics, source identity, provenance — is its own coded diagnostic.

Round trip is exact and tested: v1 → upgrade → v2 JSON → parse → downgrade yields a deeply equal project with identical `exportConnectorFiles` output, and upgrading that result reproduces the same envelope.

**What to do:** nothing, unless you want a portable description. Keep storing v1. When you want to export or share a description, upgrade at the boundary and read the diagnostics before publishing.

### An Arazzo 1.0.1 document and a 1.1.0 runtime

Do not change the version string. The reader gates fields per declared version, so a `1.1.0`-only construct in a document that declares `1.0.1` is preserved and blocked rather than interpreted. `exportArazzo` can write a `1.0.1` document as `1.1.0` — the version string changes and an info-level note records it; it does not migrate constructs into 1.1.0 forms. The reverse is refused: a `1.1.0` document holding 1.1-only constructs cannot be written as `1.0.1`, each construct is a blocking `export.version-downgrade-loss`, and no document is produced.

### A legacy MCP server and the current revision

Pin the profile in the binding. `mcp-2026-07-28` and `mcp-2025-11-25`/`mcp-2025-06-18` are separate wire profiles, and auto-detection is **off** unless a binding sets compatibility to `auto-detect`; a pinned client refuses a server of the other era rather than accommodating it. The specification's own backward-compatibility rule is implemented: a `400` whose body is not a recognized modern JSON-RPC error identifies a legacy server, while a recognized modern error means retry, not fall back.

If a provider requires the legacy Dynamic Client Registration that the current revision deprecates, configure that profile. The capability rows report each revision's documented client-registration order, so serving such a provider never advertises universal current behaviour.

### `nango.yaml` to the functions API

There is no YAML parser for this. `nango.yaml` is deprecated upstream; syncs, actions and on-event functions are defined in TypeScript and their deployed metadata is served by the functions endpoints. Import reads the API and refuses a `nango.yaml` with a blocking diagnostic rather than parsing a format the vendor retired.

### A pre-2025-09-16 `server.json`

Refused, not translated. Field names became camelCase on 2025-09-16, and guessing at a snake_case document's intent is exactly the reinterpretation import must not do. Republish the document at a supported schema version. Declared versions 2025-09-16, 2025-09-29, 2025-10-11, 2025-10-17 and 2025-12-11 are accepted; anything else imports with a `version.schema-unpinned` or `version.schema-unspecified` issue.

### A source document that moved under an approved binding

The refresh decision is explicit. Any security change, or a comparison that had to be truncated, invalidates approvals, evidence and bindings for that source. Other changes create a candidate revision that still needs review. Nothing switches publisher or version silently, and an upstream deletion or deprecation propagates as itself. Read the diff before re-approving: the codes tell you whether an issuer, a scope, a parameter location or a declared server moved.

## CDP-09: what this profile does not claim

- **No live or vendor-certified evidence exists anywhere in this repository.** There are no authorized vendor credentials in this environment. Every adapter's evidence is `unit`, `protocol-fixture` or `local-integration` against loopback doubles written from published documentation. A double that enforces a documented contract proves wire correctness and proves nothing about a real account.
- **Forwarded-delivery verification for a forwarding provider is deliberately incomplete.** Vercel Connect's documentation states that it signs the request it forwards and publishes a per-connector signing key, but does not publish the outbound header name or algorithm. `verifyForwardedDelivery` therefore takes the forwarder's verifier as an injected dependency, and the verifier used in tests is explicitly a stand-in, not a claim about that wire format. A forged or missing forwarder signature is rejected even when the request asserts the upstream provider was verified.
- **Some list endpoints have no documented pagination.** Nango's `GET /integrations` and Supabase's `GET /v1/organizations` and `GET /v1/projects` are the recorded cases. Those adapters window one bounded response and report the absence as a discover issue rather than inventing page parameters.
- **The MCP registry adapter reports `provider-backed`, not `catalog-only`,** because it genuinely implements discovery, import and export. `catalogEntrySchema` refuses an implemented capability under `catalog-only`, so the catalog-only boundary is reported per dimension instead: every execution dimension is `unsupported` with the limitation "execution requires an MCP binding".
- **Overlay is a documented subset, not a conformance claim.** See CDP-03.
- **Draft specifications stay drafts.** OAuth 2.1 and CIMD are recorded at their exact draft revisions and no finalized-standard status, conformance or certification is asserted.
- **A digest, a signature and a registry badge are three different things,** and none of them is execution approval. Publisher provenance, artifact integrity, reviewed binding and runtime trust are independent, and this profile keeps them so.
