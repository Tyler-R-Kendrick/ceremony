# Connector interoperability profile

Status: **Ceremony implementation profile**. This page describes the contracts in `src/core/connectors/` exactly as the code enforces them. It is not a new industry protocol, a claim about any provider, or an authorization. MUST, MUST NOT and SHOULD express requirements of this profile; each is checked by a runtime Zod schema and by [tests/connectors/contracts](../../tests/connectors/contracts). Structural JSON Schemas are generated from the same runtime contracts and cannot express their cross-field rules.

Runtime: `@ceremony/auth` (browser-safe, Zod only). Structural schemas: [connector-source-v1](schemas/connector-source-v1.schema.json), [connector-definition-v1](schemas/connector-definition-v1.schema.json), [connector-envelope-v2](schemas/connector-envelope-v2.schema.json), [capability-status-v1](schemas/capability-status-v1.schema.json), [verification-claim-v1](schemas/verification-claim-v1.schema.json), [compatibility-issue-v1](schemas/compatibility-issue-v1.schema.json), [catalog-entry-v1](schemas/catalog-entry-v1.schema.json), [connection-summary-v1](schemas/connection-summary-v1.schema.json), [binding-reference-v1](schemas/binding-reference-v1.schema.json).

## The separation this profile exists to keep

An imported description is not an approved runtime binding. An approved binding is not a grant. A grant is not proof of every advertised capability. A successful transport response is not proof of the intended identity or of the absence of an earlier effect. Each of those is a different record here, and no schema lets one become another.

## Identifiers and versions

CIP-01: Upstream identifiers are opaque. `nativeIdentifierSchema` preserves case, slashes, dots, colons, `@` and non-ASCII spelling exactly. An implementation MUST NOT lowercase, slug, or SemVer-coerce a native identifier or version. `nativeVersionSchema` accepts dates, digests, `latest` and SemVer alike.

CIP-02: The only local constraints are length (512 for identifiers, 128 for versions, 500 for display text), absence of Unicode control characters and explicit bidirectional controls, non-blankness, and refusal of the reserved object keys `__proto__`, `constructor` and `prototype` and of `.`/`..` path segments. A native identifier MUST NOT be used as a filesystem path or as an object key.

CIP-03: A native identifier that must enter a URL is percent-encoded exactly once with `encodePathSegment`; that function also escapes `!'()*`, which `encodeURIComponent` leaves alone. Encoding is not idempotent, so a value MUST be encoded once at the boundary and never re-encoded.

CIP-04: Internal keys use `sourceIdentityDigest`, a SHA-256 over key-sorted canonical JSON of `{ecosystem, authorityNamespace, nativeId, nativeVersion}`. Identities differing in any field, including ecosystem and letter case, digest apart. The native fields are stored beside the digest so lookup and round trips keep the original spelling. A digest proves identity of bytes, never trust.

## Support dimensions and dispositions

CIP-05: Support is reported per dimension, never as one boolean: `discover`, `import`, `configure`, `authorize`, `verify`, `invoke`, `events`, `reconnect`, `disconnect`, `revoke`, `export`, `delegate`. A definition's `compatibility.dimensions` MUST state every one of the twelve; `completeDimensions` fills anything unstated with `unsupported`. Nothing is implicitly supported.

CIP-06: Each dimension carries a `MappingDisposition`: `exact`, `adapted`, `native-extension`, `requires-configuration`, `unsupported` or `rejected`. `requires-configuration` means implemented but not usable in this deployment; it MUST NOT be reported as `unsupported`, and an adapter that always answers `unsupported` is not an implementation.

## Evidence levels

CIP-07: `evidenceLevels` is ordered weakest to strongest: `not-tested`, `unit`, `protocol-fixture`, `local-integration`, `browser-integration`, `live-authorized`, `deployed-authorized`. A fixture result MUST NOT be relabelled live.

CIP-08: A `CapabilityStatus` reports implementation, configuration readiness and evidence as three independent facts. A dimension with `implementation: "unsupported"` MUST have `evidence: "not-tested"`. An `evidenceRef` MUST NOT accompany `not-tested`. A status with `configuration: "missing"` MUST NOT claim `live-authorized` or `deployed-authorized`, because that evidence was measured with configuration the deployment does not hold.

CIP-09: A catalog entry's `evidence` MUST NOT exceed the strongest evidence among its own capability rows. `fixture` and `catalog-only` entries MUST NOT carry live evidence; `catalog-only` entries MUST NOT report an implemented dimension. A `provider-backed` entry missing required configuration is `unconfigured`, and an `unconfigured` entry MUST actually lack some required configuration.

## Support labels

CIP-09a: A catalog entry's `supportLabel` (`unverified`, `fixture`, `local`, `live`, `certified`, weakest to strongest) MUST be computed from dated evidence entries by `computeSupportLabel`, never from the adapter family, a registration or a model's suggestion. An entry names one adapter, one check (a repository path or a `scheme:identifier`, never a URL), the target it ran against (`in-process-fixture`, `local-double`, `recorded-live`, `attended-live`) and the UTC day it was recorded; an `attended-live` entry MUST name who attended it. The label is the strongest one any fresh, admissible entry earns, with the minimum evidence and freshness windows in `supportLabelRules` (365 days for fixture and local evidence, 90 for a recorded live run, 180 for an attended certification). An expired entry earns nothing. `live` and `certified` evidence is admissible only where the configuration it was measured with is present. An entry dated after the evaluation day MUST be refused where entries are accepted (the ledger generator, a host's own entries) and MUST NOT count where labels are computed.

CIP-09b: Only a `provider-backed` entry may carry a `live` or `certified` label. A `fixture`-family adapter whose evidence earns `live` or `certified` with its configuration present is shown `provider-backed`; without that evidence it stays `fixture`, however well it is exercised locally, and the label says how well. A registration derived from such an adapter is `live-adapter` only on the same condition.

CIP-09c: A label gates nothing unless the host opts in. With `support.minimumForProduction`, a binding that can reach any destination other than a `loopback-fixture` (or names none) MUST be refused with `support.below-minimum` at approval, connect and invoke while its adapter's label is below the minimum.

## Compatibility issues

CIP-10: A `CompatibilityIssue` names where (`sourcePointer`, optional `normalizedPointer`), what (a dotted `code`), which dimension, its disposition, a severity (`info`, `warning`, `blocking`) and its execution impact (`none`, `blocks-operation`, `blocks-authorization`, `blocks-definition`). `message` and `remediation` are bounded display text and MUST NOT echo a credential or an arbitrary source fragment.

CIP-11: Security requirements cannot be talked down. When `category` is `security`:

- `unsupported` or `rejected` MUST be `blocking`;
- anything not mapped `exact` or `adapted` MUST NOT be `info`;
- `requires-configuration` MUST name what it blocks (`executionImpact` other than `none`).

CIP-12: Severity and impact agree generally: a `blocking` issue MUST name what it blocks, an `info` issue MUST block nothing, `blocks-definition` MUST be `blocking`, an `exact` or `adapted` mapping MUST NOT be `blocking`, and a `rejected` construct MUST NOT be `info`.

## Authentication profiles and custody

CIP-13: `authenticationProfileSchema` is a discriminated union over thirteen kinds, including an explicit `none` (`reason: "public" | "anonymous"`) and an explicit `unsupported` that preserves the native scheme name verbatim. An importer MUST represent a public or no-credential API with `none`, and MUST NOT fabricate an API key, identity, grant or login method to satisfy a schema minimum.

CIP-14: Endpoints in a profile are _declared_ by the source, never approved. They MUST be HTTPS (or loopback HTTP for fixtures) and MUST NOT carry userinfo, a query string or a fragment, so a signed or keyed URL cannot enter a description. A declared server URL may contain `{variables}` and is therefore not parsed, but userinfo, query and fragment are refused there too. A profile is not permission to contact anything; only a server-side `RuntimeBinding` approves a destination.

CIP-15: Custody is reported as one of `host-owned`, `external-credential-broker`, `external-execution-broker`, `attended-browser` or `no-credential`. Remote credential access and remote execution are different interfaces; an implementation MUST NOT convert a non-exportable authority into an exported credential.

## Capability evidence

CIP-16: A `VerificationClaim` is one narrow observation. It MUST name an `issuer` (`provider`, `external-broker`, `host-policy` or `ceremony-verifier`), a `target` (`{kind, id}`) that was actually observed, an `observedAt`, a `verifierVersion`, a `bindingRevision` and a `policyRevision`, and it MUST list what it does not establish in `limitations`. There is no `verified`, `trusted` or `inferred` field, and an unknown property is refused: a source document therefore cannot create evidence about itself.

CIP-17: Permissions are recorded as `requested`, `reported` and `observed` separately, with explicit `semantics` (`provider-scopes`, `operations` or `unknown`). Empty lists mean unknown or unscoped, never unlimited. A `permission-observed` claim MUST list at least one observed permission.

CIP-18: `host-policy` may assert ownership but MUST NOT issue `credential-accepted` or `permission-observed` claims: the host does not observe the provider. Validity windows compare instants, not strings, so `validUntil` MUST be strictly after `observedAt` regardless of UTC offset spelling.

## Connection lifecycle

CIP-19: `connectionLifecycles` models eleven states, and `lifecycleTransitions` fixes which moves the command layer may apply. `active` MUST be entered only from `verifying`, from `degraded` recovering, or from `indeterminate` after reconciliation. No callback, broker status or transport success reaches `active` directly.

CIP-20: Local disconnect, upstream revocation and expiry are distinct states. `locally-disconnected` MUST NOT imply `upstream-revoked`; each is a separately observed effect. A handoff summary belongs to the current connection generation, so a handoff issued before a generation change cannot complete against the new one.

## Projections

CIP-21: Every projection in `projections.ts` is a positive allowlist that constructs a new object from named fields. A projection MUST NOT spread its input. A field added to a record later is therefore nonpublic until a projection is deliberately taught about it, and an unknown field in the input is refused rather than forwarded.

| Projection                   | Audience                           | Carries                                                                                                                                                |
| ---------------------------- | ---------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `publicCatalogProjection`    | Public directory                   | Identity, support level, custody, runtimes, authentication kinds, configuration names/classification/presence, capability status rows, evidence, group |
| `humanConnectionProjection`  | The authenticated initiating human | Connection summary plus, optionally, one validated destination URL, device code and instructions                                                       |
| `agentConnectorProjection`   | Models and tools                   | Correlation references, lifecycle, generation, revision, custody, a `verified` boolean, target _kind_                                                  |
| `agentDefinitionProjection`  | Models and tools                   | Identity, display name, authentication ids/kinds, capability ids and declared classifications, dimensions, blocking issue codes                        |
| `authorReviewProjection`     | Authorized author or operator      | Full definition and source provenance without `artifactRef`                                                                                            |
| `exportDefinitionProjection` | Documents leaving the deployment   | Portable definition without persistence references; native extensions only when the operator opts in                                                   |
| `auditConnectorProjection`   | Audit log                          | Time, actor kind, action code, references, outcome, sanitized code, generation                                                                         |

CIP-22: `humanConnectionProjection` is the only projection that may carry a destination URL or a device code, and only for the authenticated initiating human. A shown URL MUST be HTTPS (or loopback HTTP) with no userinfo and no fragment. Authorization URLs, Connect links, widget tokens, device codes, PKCE verifiers and private collector references MUST NOT enter public catalog, agent, export, audit or error output.

CIP-23: Configuration is reported by name, source, classification and presence only. A configuration _value_ MUST NOT appear in any projection. Provider messages MUST NOT be projected; a connection reports a sanitized `lastOutcome` code instead.

CIP-24: `exportDefinitionProjection` drops `definitionRef` and `sourceRef` always, and drops native extensions from the definition and from every capability unless the exporting operator passes `includeNativeExtensions`, because a source's extensions can carry examples and vendor fields that were never reviewed for publication.

## Inert native data

CIP-25: `nativeExtensions` preserves source data the runtime does not understand. It is inert: it MUST NOT be evaluated, and it is bounded before any copy is made. `measureJsonValue` walks the raw input iteratively and refuses depth over 16, more than 4096 nodes, more than 128 KiB, any string over 8192 characters, any non-JSON value, and any reserved object key at any depth. A definition's extension blocks together MUST NOT exceed `DEFINITION_LIMITS.extensionBytes` (1 MiB).

CIP-26: Graph limits are explicit rather than implicit: `DEFINITION_LIMITS` caps capabilities (4096), events (512), authentication profiles (32), configuration requirements (48), issues (4096), declared servers (32) and the whole document (4 MiB, checked as UTF-8 bytes before JSON parsing by `parseNormalizedDefinition`).

CIP-27: A capability is identified by `kind` plus `nativeId`, and both capabilities and events MUST be unique under that identity, so a binding never resolves an operation by first match.

## The versioned envelope

CIP-28: Version 1 of `ceremony-connector` is the studio authoring project (`connectorProjectSchema`) and is unchanged by this profile. Version 2 wraps a _description_: `profile` (`ceremony-connector/2` plus a producer id and version), a portable `definition`, up to sixteen portable `sources`, and optionally an unchanged v1 `project`. `parseConnectorEnvelope` reads both versions and enforces a 4 MiB ceiling before parsing.

CIP-29: A portable definition omits `definitionRef` and `sourceRef`; a portable source omits `sourceRef` and `artifactRef`. `normalizedDigestOf` digests the portable content excluding the digest field itself, so a stored definition and its export agree; `verifyNormalizedDigest` checks it.

CIP-30: `upgradeConnectorProject` wraps a v1 project without altering it. Every method becomes a `ceremony-method` profile whose `methodId` and `flowKind` point back at the method. Where a v1 spelling cannot be a profile id or display text (a leading digit, a control character), the derived field is adjusted and the project itself MUST stay byte-identical. The envelope MUST NOT add capabilities, events, extensions or any executable or trust-bearing field: a v1 upgrade declares `invoke: "unsupported"` and `authorize: "requires-configuration"`.

CIP-31: An embedded project MUST be described by `ceremony-method` profiles, and every `ceremony-method` profile MUST name a method the project actually has, with a matching flow kind.

CIP-32: `downgradeConnectorEnvelope` returns a v1 project only when the envelope embeds one, and returns explicit diagnostics either way. A description with no project produces a single blocking diagnostic; when the description is public-only, the diagnostic says so rather than inventing a method. Every loss version 1 cannot carry — other authentication profiles, unreferenced configuration, capabilities, events, native extensions, extra declared servers, compatibility diagnostics, source identity and provenance — is reported as its own coded diagnostic.

CIP-33: Round trip is exact: v1 project → upgrade → v2 JSON → parse → downgrade yields a project deeply equal to the original, with identical `exportConnectorFiles` output, and upgrading the result reproduces the same envelope.

## Conformance

The runtime validators are authoritative. The generated JSON Schemas check structure only: unknown properties are refused at every object level, literals and enums are checked, and `compatibility.dimensions` requires all twelve keys — but cross-field refinements (severity agreement, evidence consistency, digest chains, duplicate identities, reserved keys inside extensions, instant comparison) are runtime-only and are listed as such in [CON-06-04](../../tests/connectors/contracts/schemas.test.ts). Passing a structural schema MUST NOT publish a definition, approve a binding, accept a grant or certify a provider.

Generate and check with `npm run specs:generate` and `npm run specs:check`; the drift check also runs from the conformance suite.
